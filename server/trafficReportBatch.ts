import { isDatabaseTransactionActive, withDatabaseTransaction } from "./dbRuntime";
import { addShutdownTask } from "./dbWriteBatcher";
import { withTrafficBillingUserLock } from "./keyedTaskLock";
import { lockTrafficBillingUserRows } from "./repositories/trafficBillingRepository";

/*
  流量上报跨主机攒批提交。

  每份流量上报原来各自一个事务：改十来张表（traffic_stats、traffic_stat_buckets、各类
  counters、users 的已用流量、agent_traffic_reports……），SQLite 下每次提交都把碰过的页整页
  写进 WAL。几十台主机的上报里大半的页是同一批（admin 的 users 行、user_traffic_counters、
  traffic_stats 的尾页和索引尾页、host_traffic_counters），一台一个事务就是同一页反复写。
  压测（docs/dev/control-plane-load-review.md）里 100 台主机进程磁盘写入 1.9～2.4 GB/小时，
  这是大头。

  这里把一个短窗口（FORWARDX_TRAFFIC_BATCH_MS，默认 500 毫秒）内到达的上报攒成一批，
  一个事务里逐份应用，同一页一批只写一次。规矩：

  - 回执仍然在落库之后才给：调用方 await commitTrafficReport() 回来时这份上报已经提交
    （afterDatabaseCommit 回调也已跑完），和原来一样。Agent 看到的只是回包慢了至多一个窗口。
  - 用户锁顺序不变：一批里所有上报涉及的用户并成一个集合，按 id 升序逐个拿进程内的
    计费锁（withTrafficBillingUserLock），事务里再按同一顺序 lockTrafficBillingUserRows 锁行。
    每份上报原来就是这么拿的（见 withTrafficAccountingUserLocks），并集仍是升序，和别处
    单把锁的路径之间没有新的顺序，不会死锁。锁是重入的（AsyncLocalStorage 记着持有），
    上报里触发的结算 / 停规则再为同一个用户拿锁时照旧按重入处理。
  - 一份失败不连累别的：整批事务失败就回滚，然后每份各自单独再应用一次（自己的锁、自己的
    事务），各自成功 / 失败各自回执。事务助手没有保存点，只能整批回滚后分开重试；所以
    apply 必须可以重跑（路由那边每次进来都重置自己的计数器）。只有一份的批不重试：失败就
    直接报错，和原来一样。
  - 一批最多 TRAFFIC_REPORT_BATCH_MAX_REPORTS 份，攒满立刻提交，不让一个事务拖太长；
    批与批之间串行（SQLite 只有一条写连接，PostgreSQL / MySQL 上也省得两批互相等行锁）。
  - 调用方已经在事务里（测试、被别的事务包着调）或者关掉了攒批（FORWARDX_TRAFFIC_BATCH_MS=0）
    时不排队，当场按原来的方式应用。
  - 退出前把攒着的那批提交掉（挂在 dbWriteBatcher 的退出任务上）。
*/

export const DEFAULT_TRAFFIC_REPORT_BATCH_MS = 500;
const MAX_TRAFFIC_REPORT_BATCH_MS = 5_000;
/** 一批最多攒这么多份上报，攒满不等窗口到期立刻提交。 */
export const TRAFFIC_REPORT_BATCH_MAX_REPORTS = 64;
const VERBOSE_TRAFFIC_BATCH = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_VERBOSE_AGENT_REPORTS || ""));
const VERBOSE_LOG_INTERVAL_MS = 60_000;

export type TrafficReportCommit = {
  /** 报上来的那台主机，只用于日志。 */
  hostId: number;
  /** 这份上报要替谁记账：进程内锁和行锁都按这个集合拿。 */
  userIds: number[];
  /**
   * 在事务里应用这份上报。被攒批时和同一批里别的上报共用一个事务；整批失败后会被
   * 单独再调一次，所以要能重跑（自己重置计数器，不要依赖上一次留下的状态）。
   */
  apply: () => Promise<void>;
};

type PendingReport = TrafficReportCommit & {
  resolve: () => void;
  reject: (error: unknown) => void;
};

export function readTrafficReportBatchMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = String(env.FORWARDX_TRAFFIC_BATCH_MS ?? "").trim();
  if (!raw) return DEFAULT_TRAFFIC_REPORT_BATCH_MS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return DEFAULT_TRAFFIC_REPORT_BATCH_MS;
  return Math.max(0, Math.min(MAX_TRAFFIC_REPORT_BATCH_MS, value));
}

let batchMs = readTrafficReportBatchMs();
let maxReports = TRAFFIC_REPORT_BATCH_MAX_REPORTS;
let pending: PendingReport[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** 批与批串行：下一批等上一批提交（或分开重试）完。 */
let flushChain: Promise<void> = Promise.resolve();
const stats = { queued: 0, immediate: 0, batches: 0, batched: 0, batchFailures: 0, retriedAlone: 0 };
let lastVerboseLogAt = Date.now();
let verboseWindow = { reports: 0, batches: 0 };

/** 测试 / 启动时改参数。batchMs 为 0 关掉攒批（已攒的先提交掉）。 */
export function configureTrafficReportBatcher(options: { batchMs?: number; maxReports?: number } = {}) {
  if (options.batchMs !== undefined) batchMs = Math.max(0, Math.min(MAX_TRAFFIC_REPORT_BATCH_MS, Math.floor(options.batchMs)));
  if (options.maxReports !== undefined) maxReports = Math.max(1, Math.floor(options.maxReports));
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.length > 0) {
    if (batchMs <= 0 || pending.length >= maxReports) void scheduleFlush();
    else armTimer();
  }
}

export function isTrafficReportBatchingEnabled() {
  return batchMs > 0;
}

export function pendingTrafficReportCount() {
  return pending.length;
}

export function getTrafficReportBatcherStats() {
  return { ...stats, batchMs, maxReports, pending: pending.length };
}

/** 去重、去掉无效 id、升序：进程内锁和行锁都按这个顺序拿。 */
export function normalizeTrafficAccountingUserIds(userIds: Iterable<unknown>) {
  return Array.from(new Set(Array.from(userIds)
    .map((id) => Math.floor(Number(id) || 0))
    .filter((id) => id > 0)))
    .sort((left, right) => left - right);
}

/**
 * 按 id 升序逐个拿这些用户的计费锁，拿齐了再跑 task。
 * 用 withTrafficBillingUserLock 而不是裸的键锁：它同时把「持有这把锁」记进调用链，
 * 里面记账触发的结算 / 停规则再为同一个用户拿这把锁时按重入处理，不会自己等自己。
 */
export async function withTrafficAccountingUserLocks<T>(userIds: number[], task: () => Promise<T>): Promise<T> {
  const ids = normalizeTrafficAccountingUserIds(userIds);
  const run = (index: number): Promise<T> => index >= ids.length
    ? task()
    : withTrafficBillingUserLock(ids[index], () => run(index + 1));
  return run(0);
}

/** 一份（或一批）上报的事务：先按升序锁行，再逐份应用。 */
function applyReportsInTransaction(userIds: number[], reports: Array<Pick<TrafficReportCommit, "apply">>) {
  return withTrafficAccountingUserLocks(userIds, () => withDatabaseTransaction(async () => {
    // 行锁顺序和进程内的键锁一致（升序）：别的面板实例并发处理上报时按同一个全局顺序锁，
    // 配额 / 计费计数器不会被交叉改写。
    await lockTrafficBillingUserRows(userIds);
    for (const report of reports) await report.apply();
  }));
}

async function applyAlone(report: PendingReport) {
  try {
    await applyReportsInTransaction(report.userIds, [report]);
    report.resolve();
  } catch (error) {
    report.reject(error);
  }
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function noteVerbose(reports: number, batches: number) {
  if (!VERBOSE_TRAFFIC_BATCH) return;
  verboseWindow.reports += reports;
  verboseWindow.batches += batches;
  const now = Date.now();
  if (now - lastVerboseLogAt < VERBOSE_LOG_INTERVAL_MS) return;
  const seconds = Math.max(1, Math.round((now - lastVerboseLogAt) / 1000));
  console.info(`[TrafficBatch] ${seconds}s: ${verboseWindow.reports} reports in ${verboseWindow.batches} transactions (avg ${(verboseWindow.reports / Math.max(1, verboseWindow.batches)).toFixed(1)} per batch)`);
  lastVerboseLogAt = now;
  verboseWindow = { reports: 0, batches: 0 };
}

async function runBatch(reports: PendingReport[]) {
  if (reports.length === 0) return;
  if (reports.length === 1) {
    // 只有一份：没有别人可连累，失败直接报错（不重试，和没攒批时一样）。
    stats.batches += 1;
    stats.batched += 1;
    await applyAlone(reports[0]);
    noteVerbose(1, 1);
    return;
  }
  const userIds = normalizeTrafficAccountingUserIds(reports.flatMap((report) => report.userIds));
  try {
    await applyReportsInTransaction(userIds, reports);
    stats.batches += 1;
    stats.batched += reports.length;
    for (const report of reports) report.resolve();
    noteVerbose(reports.length, 1);
    return;
  } catch (error) {
    stats.batchFailures += 1;
    console.warn(`[TrafficBatch] batch of ${reports.length} reports (hosts ${reports.map((report) => report.hostId).join(",")}) rolled back: ${describeError(error)}; applying each report alone`);
  }
  // 整批回滚了：分开各自再来一次，谁坏谁自己报错，好的照常提交。
  for (const report of reports) {
    stats.retriedAlone += 1;
    await applyAlone(report);
  }
  noteVerbose(reports.length, reports.length);
}

function takePending() {
  const taken = pending;
  pending = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  return taken;
}

function scheduleFlush(): Promise<void> {
  const taken = takePending();
  if (taken.length === 0) return flushChain;
  const run = () => runBatch(taken);
  flushChain = flushChain.then(run, run);
  return flushChain;
}

function armTimer() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void scheduleFlush();
  }, batchMs);
  timer.unref?.();
}

/**
 * 提交一份流量上报：排进当前窗口的批，落库之后才返回；失败按这份自己的错误 reject。
 * 关掉攒批、或调用方已经在事务里时，当场按原来的方式（自己的锁 + 自己的事务）应用。
 */
export function commitTrafficReport(report: TrafficReportCommit): Promise<void> {
  const userIds = normalizeTrafficAccountingUserIds(report.userIds);
  if (batchMs <= 0 || isDatabaseTransactionActive()) {
    stats.immediate += 1;
    return applyReportsInTransaction(userIds, [report]);
  }
  return new Promise<void>((resolve, reject) => {
    stats.queued += 1;
    pending.push({ hostId: report.hostId, userIds, apply: report.apply, resolve, reject });
    if (pending.length >= maxReports) {
      void scheduleFlush();
      return;
    }
    armTimer();
  });
}

/**
 * 把攒着的上报立刻提交，并等正在跑的那批结束。不会 reject：每份上报的成败走各自的 Promise。
 * 退出前、测试里要立刻看到结果时用。
 */
export function flushTrafficReportBatch(): Promise<void> {
  return scheduleFlush().then(() => undefined, () => undefined);
}

addShutdownTask(() => flushTrafficReportBatch());
