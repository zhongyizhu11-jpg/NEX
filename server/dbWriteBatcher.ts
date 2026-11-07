import { databaseHealth, describeDatabaseError } from "./databaseHealthState";
import { getDatabaseKind, isDatabaseTransactionActive, withDatabaseTransaction } from "./dbRuntime";

/*
  探测样本的攒批写库。

  Agent 上报的延迟 / 探测样本原来一条一行地写：每条 INSERT 自己一个事务，SQLite 下每次提交
  都要把改动的页（数据页 + 几个索引页）整页写进 WAL。这里把这类「只进历史表、没人等着立刻读」
  的行按表攒起来，每 FORWARDX_WRITE_BATCH_MS（默认 2 秒）或某张表攒到 200 行时，一个事务里
  用多行 INSERT 一次写完。

  规矩：
  - 只攒历史行。隧道 / 转发组的「最近一次状态」列、notifyTunnelLatencyRefresh 这类驱动界面
    的副作用照旧立刻做，调用方自己负责（见 metricsRepository.insertTunnelLatencyStat）。
  - 读「最新一条」/ 走势的查询先 flushPendingWrites(表名) 再查，删这几张表的行之前也先刷，
    「写完马上读得到、删得掉」不变；测试里要立刻看到行的也走这个，不要去关攒批。
  - 调用方在事务里时（push 或 flushPendingWrites）：不排队、也不等别的刷新，把这张表排着的
    旧行连同这一批一起写进调用方的事务 —— 跟着它提交 / 回滚，id 也跟时间同序（有的查询按
    MAX(id) 取最新一条、按 id 区间找同一批的分支行）。不能等别的刷新：SQLite 只有一条写连接，
    那次刷新正排队等调用方事务手里的锁，互相等就是死锁。
  - 后台刷新拿到事务（SQLite 是拿到连接锁）之后才从队列里取行：它排队等锁的这段时间，行还在
    队列里，上面那种事务里的调用方照样拿得到、写得进自己的事务。
  - 只往已经连上的库里写：库没连上（重连的间隙、测试关了库）时行留在队列里过一会儿再试，
    不会由刷新去连一个默认的库。
  - 主库不可用时直接丢（记一行 warn），不无限攒；每张表最多攒 WRITE_BATCH_QUEUE_CAP 行，
    再多丢最旧的。写入失败：连接 / 存储类故障整批丢，其它错误按表各自再试一次，还失败丢那张表。
  - 导出备份 / 迁移导入 / 切库 / 退出前都先刷一遍（migration.ts、databaseSwitch.ts、index.ts）。
  - FORWARDX_WRITE_BATCH_MS=0 关掉攒批，所有写入回到立刻写。
*/

export const DEFAULT_WRITE_BATCH_MS = 2_000;
const MAX_WRITE_BATCH_MS = 60_000;
/** 某张表攒到这么多行就不等定时器，立刻刷。 */
export const WRITE_BATCH_MAX_ROWS = 200;
/** 每张表最多攒这么多行（主库卡住、刷不出去时），再来丢最旧的。 */
export const WRITE_BATCH_QUEUE_CAP = 5_000;
/** 一条多行 INSERT 最多带多少行：SQLite 的绑定参数上限、MySQL 的预处理语句长度都留足余量。 */
const DEFAULT_CHUNK_ROWS = 100;
const DROP_LOG_INTERVAL_MS = 60_000;

export type BatchedWriter<T> = (rows: T[]) => Promise<void>;

type Queue = {
  name: string;
  rows: unknown[];
  writer: BatchedWriter<unknown>;
  chunkRows: number;
  lastDropLogAt: number;
};

type TakenRows = { queue: Queue; rows: unknown[] };

export function readWriteBatchMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = String(env.FORWARDX_WRITE_BATCH_MS ?? "").trim();
  if (!raw) return DEFAULT_WRITE_BATCH_MS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return DEFAULT_WRITE_BATCH_MS;
  return Math.max(0, Math.min(MAX_WRITE_BATCH_MS, value));
}

const queues = new Map<string, Queue>();
let batchMs = readWriteBatchMs();
let maxRows = WRITE_BATCH_MAX_ROWS;
let queueCap = WRITE_BATCH_QUEUE_CAP;
let timer: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<void> | null = null;
/** 正在跑的那次后台刷新已经从队列里取走、还没写完的表。后台刷新是串行的，同一时间只有一次。 */
let flushingTables = new Set<string>();
const stats = { queued: 0, written: 0, dropped: 0, flushes: 0, immediate: 0 };

/** 测试 / 启动时改参数。batchMs 为 0 关掉攒批（之后的写入立刻落库，已攒的先刷掉）。 */
export function configureWriteBatcher(options: { batchMs?: number; maxRows?: number; queueCap?: number } = {}) {
  if (options.batchMs !== undefined) batchMs = Math.max(0, Math.min(MAX_WRITE_BATCH_MS, Math.floor(options.batchMs)));
  if (options.maxRows !== undefined) maxRows = Math.max(1, Math.floor(options.maxRows));
  if (options.queueCap !== undefined) queueCap = Math.max(1, Math.floor(options.queueCap));
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pendingWriteCount() > 0) armTimer();
}

export function isWriteBatchingEnabled() {
  return batchMs > 0;
}

export function pendingWriteCount(name?: string) {
  if (name) return queues.get(name)?.rows.length ?? 0;
  let total = 0;
  for (const queue of queues.values()) total += queue.rows.length;
  return total;
}

export function getWriteBatcherStats() {
  return { ...stats, batchMs, pending: pendingWriteCount() };
}

function armTimer() {
  if (timer) return;
  // 关掉攒批之后还留着的行（运行中改了配置）也要有人刷，最多等 2 秒
  timer = setTimeout(() => {
    timer = null;
    void flushPendingWrites();
  }, batchMs > 0 ? batchMs : DEFAULT_WRITE_BATCH_MS);
  timer.unref?.();
}

function cancelTimerIfIdle() {
  if (timer && pendingWriteCount() === 0) {
    clearTimeout(timer);
    timer = null;
  }
}

function logDrop(queue: Queue, count: number, reason: string) {
  if (count <= 0) return;
  stats.dropped += count;
  const now = Date.now();
  if (now - queue.lastDropLogAt < DROP_LOG_INTERVAL_MS) return;
  queue.lastDropLogAt = now;
  console.warn(`[WriteBatcher] dropped ${count} queued ${queue.name} rows: ${reason}`);
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rowCount(taken: TakenRows[]) {
  return taken.reduce((sum, entry) => sum + entry.rows.length, 0);
}

function takeRows(name?: string) {
  const taken: TakenRows[] = [];
  for (const queue of queues.values()) {
    if (name && queue.name !== name) continue;
    if (queue.rows.length === 0) continue;
    taken.push({ queue, rows: queue.rows });
    queue.rows = [];
  }
  return taken;
}

async function writeRows(entry: TakenRows) {
  for (let offset = 0; offset < entry.rows.length; offset += entry.queue.chunkRows) {
    await entry.queue.writer(entry.rows.slice(offset, offset + entry.queue.chunkRows));
  }
}

/**
 * 调用方在事务里：把排着的行直接写进它的事务，不等后台刷新（见文件头）。
 * push 带着调用方自己的行，出错照常往上抛（跟没攒批时一样）；flushPendingWrites 搬进去的
 * 只是别人排着的样本，写不进去就丢掉记 warn，不让调用方要做的事跟着失败。
 * （PostgreSQL 里一条语句出错整个事务就作废，调用方接下来的语句照样会报错；这几张表的
 * INSERT 实际上不会失败。）
 */
async function writeIntoCallerTransaction(taken: TakenRows[], options: { dropOnError?: boolean } = {}) {
  cancelTimerIfIdle();
  for (const entry of taken) {
    try {
      await writeRows(entry);
      stats.written += entry.rows.length;
    } catch (error) {
      if (!options.dropOnError) throw error;
      logDrop(entry.queue, entry.rows.length, describeError(error));
    }
  }
}

async function flushOnce(name?: string) {
  if (pendingWriteCount(name) === 0) return;
  if (!getDatabaseKind()) {
    // 库没连上：留着，过一会儿再试（见文件头）
    armTimer();
    return;
  }
  stats.flushes += 1;
  if (databaseHealth.isUnavailable()) {
    for (const entry of takeRows(name)) logDrop(entry.queue, entry.rows.length, "database unavailable");
    cancelTimerIfIdle();
    return;
  }
  let taken: TakenRows[] = [];
  let failure: unknown = null;
  try {
    await withDatabaseTransaction(async () => {
      // 拿到事务之后才取行，见文件头
      taken = takeRows(name);
      for (const entry of taken) flushingTables.add(entry.queue.name);
      for (const entry of taken) await writeRows(entry);
    });
  } catch (error) {
    failure = error;
  }
  try {
    if (!failure) {
      stats.written += rowCount(taken);
      return;
    }
    // 事务还没开起来就失败了（连不上库之类）：这一轮该写的也一起丢掉，不留着反复失败
    if (taken.length === 0) taken = takeRows(name);
    // 连接断了 / 文件坏了这类故障重试也写不进去，整批丢掉；别的错误（比如某张表的结构问题）
    // 按表各自再试一次，坏的那张表丢掉，好的照常写进去。
    if (describeDatabaseError(failure) || databaseHealth.isUnavailable()) {
      for (const entry of taken) logDrop(entry.queue, entry.rows.length, describeError(failure));
      return;
    }
    for (const entry of taken) {
      try {
        await withDatabaseTransaction(() => writeRows(entry));
        stats.written += entry.rows.length;
      } catch (error) {
        logDrop(entry.queue, entry.rows.length, describeError(error));
      }
    }
  } finally {
    flushingTables = new Set();
    cancelTimerIfIdle();
  }
}

/**
 * 把攒着的行写进库。不带表名刷全部；带表名只刷那张表（读「最新一条」、删行之前用）。
 * 事务外：刷是串行的，正在刷这张表时会等它写完再刷一遍（把这期间新攒的也写掉）；
 * 这张表既没攒着也没在刷时立刻返回，不跟着别的表的刷新排队。
 * 事务里：把这张表攒着的行写进当前事务，不等后台刷新（见文件头）。
 * 不会 reject：写不进去的行丢掉记 warn。
 */
export function flushPendingWrites(name?: string): Promise<void> {
  if (isDatabaseTransactionActive()) {
    const taken = takeRows(name);
    return taken.length > 0 ? writeIntoCallerTransaction(taken, { dropOnError: true }) : Promise.resolve();
  }
  const flushing = name ? flushingTables.has(name) : flushingTables.size > 0;
  if (pendingWriteCount(name) === 0 && !flushing) return Promise.resolve();
  const run = () => flushOnce(name);
  const next: Promise<void> = (flushChain ?? Promise.resolve()).then(run, run);
  flushChain = next;
  const settled = () => {
    if (flushChain === next) flushChain = null;
  };
  next.then(settled, settled);
  return next;
}

export type BatchedWrite<T> = {
  readonly name: string;
  /** 排进队列（关掉攒批时立刻写，调用方在事务里时写进那个事务）。返回时行不一定已经落库。 */
  push(rows: T | T[]): Promise<void>;
  /** 只刷这张表。 */
  flush(): Promise<void>;
};

/**
 * 登记一张表的攒批写入。writer 收到的是一个块（最多 chunkRows 行），要用多行 INSERT 一次写完；
 * 它在事务里被调用，getDb() / executeRaw 自然会走当前事务。
 */
export function defineBatchedWrite<T>(name: string, writer: BatchedWriter<T>, options: { chunkRows?: number } = {}): BatchedWrite<T> {
  const chunkRows = Math.max(1, Math.floor(options.chunkRows ?? DEFAULT_CHUNK_ROWS));
  let queue = queues.get(name);
  if (queue) {
    queue.writer = writer as BatchedWriter<unknown>;
    queue.chunkRows = chunkRows;
  } else {
    queue = { name, rows: [], writer: writer as BatchedWriter<unknown>, chunkRows, lastDropLogAt: 0 };
    queues.set(name, queue);
  }
  const target = queue;
  return {
    name,
    async push(input) {
      const rows = Array.isArray(input) ? input : [input];
      if (rows.length === 0) return;
      if (isDatabaseTransactionActive()) {
        // 先写这张表排着的旧行，再写这一批：id 跟时间同序；一起跟着调用方的事务提交 / 回滚
        stats.immediate += rows.length;
        await writeIntoCallerTransaction([...takeRows(name), { queue: target, rows }]);
        return;
      }
      if (batchMs <= 0) {
        stats.immediate += rows.length;
        await flushPendingWrites(name);
        await writeRows({ queue: target, rows });
        stats.written += rows.length;
        return;
      }
      if (databaseHealth.isUnavailable()) {
        logDrop(target, rows.length, "database unavailable");
        return;
      }
      stats.queued += rows.length;
      target.rows.push(...rows);
      const overflow = target.rows.length - queueCap;
      if (overflow > 0) {
        target.rows.splice(0, overflow);
        logDrop(target, overflow, `queue over ${queueCap} rows`);
      }
      if (target.rows.length >= maxRows) {
        void flushPendingWrites(name);
        return;
      }
      armTimer();
    },
    flush: () => flushPendingWrites(name),
  };
}

/**
 * 退出前把攒着的写掉：SIGTERM / SIGINT（docker stop、systemctl stop、Ctrl+C）先刷再退出，
 * 最多等 flushTimeoutMs；事件循环自然跑空（beforeExit）时也刷一次。面板启动时由 server/index.ts 装上。
 * 面板自己 process.exit 的那几处（改设置后重启、安装向导换库）各自先调 flushPendingWrites。
 * 第二次 Ctrl+C 走 Node 默认处理，立刻退出。
 */
export function installWriteBatcherShutdownHooks(
  target: Pick<NodeJS.Process, "on" | "once" | "exit"> = process,
  options: { flushTimeoutMs?: number; log?: (message: string) => void } = {},
) {
  const flushTimeoutMs = Math.max(0, options.flushTimeoutMs ?? 5_000);
  const log = options.log ?? ((message: string) => console.info(message));
  let exiting = false;
  const shutdown = (signal: string) => {
    if (exiting) return;
    exiting = true;
    const pending = pendingWriteCount();
    const exit = () => target.exit(0);
    if (pending === 0) {
      exit();
      return;
    }
    log(`[WriteBatcher] ${signal}: flushing ${pending} queued rows before exit`);
    const timeout = setTimeout(exit, flushTimeoutMs);
    flushPendingWrites().then(exit, exit).finally(() => clearTimeout(timeout));
  };
  target.once("SIGTERM", () => shutdown("SIGTERM"));
  target.once("SIGINT", () => shutdown("SIGINT"));
  target.on("beforeExit", () => {
    if (pendingWriteCount() > 0) void flushPendingWrites();
  });
  return shutdown;
}
