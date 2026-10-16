/*
  流媒体 / AI 解锁检测（Agent 2.2.226 起）的面板侧：排检测、收结果、存储、计划检测。
  扩展模块 "unlock" 的注册在 unlockAgent.ts（只由 agentExtModules.ts 引入 —— 路由和定时任务
  引这个文件，不能顺带注册，否则 agentExt.ts 还没初始化完就被调用）。Go 端是 agent/ext_unlock.go。

  默认不定期跑 —— 每一轮都要从主机去请求十来个第三方站点。两种触发：
    · 管理员在主机详情里点「检测解锁」（startUnlockCheck → wakeAgentExt，几秒内出结果）；
    · 管理员在同一处打开「计划检测」（每天 / 每周），startUnlockScheduleJob 每 30 分钟看一次
      哪些在线主机到期了，每次最多排 UNLOCK_SCHEDULE_BATCH 台，把第三方请求摊开。

  请求只放内存（5 分钟过期）：指令 runs: [{runId, family}] 每轮重发，直到收到这个 runId 的 done。
  结果校验过才落库（host_unlock_checks），每台主机留最近 10 次。
*/
import { randomBytes } from "node:crypto";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { getSetting, setSetting } from "../repositories/settingsRepository";
import { isAgentVersionAtLeast } from "../../shared/version";
import {
  normalizeUnlockFamily,
  normalizeUnlockResults,
  normalizeUnlockSchedule,
  UNLOCK_MIN_AGENT_VERSION,
  unlockChipItems,
  unlockScheduleIntervalSeconds,
  type UnlockChipItem,
  type UnlockFamily,
  type UnlockSchedule,
  type UnlockServiceResult,
} from "../../shared/unlockCheck";
import { wakeAgentExt, type AgentExtHost } from "./agentExt";

const q = quoteDbIdentifier;
const TABLE = "host_unlock_checks";

export const UNLOCK_HISTORY_KEEP = 10;
// Agent 一轮最多 2 分钟，几次检测在 Agent 上排队一个一个跑，所以多留一点。
export const UNLOCK_RUN_TIMEOUT_MS = 5 * 60_000;
export const UNLOCK_SCHEDULE_SETTING = "ops.unlock.schedule";
const UNLOCK_SCHEDULE_TICK_MS = 30 * 60_000;
const UNLOCK_SCHEDULE_BATCH = 20;

export type UnlockTrigger = "manual" | "schedule";

export function hostSupportsUnlock(host: { agentVersion?: string | null } | null | undefined) {
  return !!host && isAgentVersionAtLeast(String(host.agentVersion || "").replace(/^v/i, ""), UNLOCK_MIN_AGENT_VERSION);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- 等结果的请求（内存）

type PendingRun = {
  runId: string;
  hostId: number;
  family: UnlockFamily;
  trigger: UnlockTrigger;
  requestedBy: number | null;
  createdAt: number;
  /** Agent 报过 running 的时间（毫秒），界面显示「检测中」用。 */
  startedAt: number | null;
};

const pendingRuns = new Map<string, PendingRun>();

function sweepPending(now = Date.now()) {
  for (const [runId, run] of pendingRuns) {
    if (now - run.createdAt > UNLOCK_RUN_TIMEOUT_MS) pendingRuns.delete(runId);
  }
}

export function pendingUnlockRunsForHost(hostId: number) {
  sweepPending();
  return Array.from(pendingRuns.values()).filter((run) => run.hostId === hostId);
}

function newRunId() {
  return `ul-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

export class UnlockCheckError extends Error {}

/**
 * 排一次检测。同一台主机同一个 family 已经在等就返回那一次的 runId，不重复排。
 * 旧 Agent / 离线主机直接报错（界面上会提示「需要升级 Agent」）。
 */
export function startUnlockCheck(
  host: { id: number; agentVersion?: string | null; isOnline?: unknown },
  input: { family?: unknown; trigger?: UnlockTrigger; requestedBy?: number | null },
) {
  const hostId = Number(host.id);
  if (!(hostId > 0)) throw new UnlockCheckError("主机不存在");
  if (!hostSupportsUnlock(host)) throw new UnlockCheckError(`需要升级 Agent 到 ${UNLOCK_MIN_AGENT_VERSION} 或更新版本`);
  if (host.isOnline === false || host.isOnline === 0) throw new UnlockCheckError("主机离线，等它上线再检测");
  const family = normalizeUnlockFamily(input.family);
  sweepPending();
  for (const run of pendingRuns.values()) {
    if (run.hostId === hostId && run.family === family) return { runId: run.runId, reused: true };
  }
  const runId = newRunId();
  pendingRuns.set(runId, {
    runId,
    hostId,
    family,
    trigger: input.trigger || "manual",
    requestedBy: input.requestedBy ?? null,
    createdAt: Date.now(),
    startedAt: null,
  });
  wakeAgentExt(hostId, "unlock-check");
  return { runId, reused: false };
}

export function unlockDirectiveFor(hostId: number) {
  const runs = pendingUnlockRunsForHost(hostId).map((run) => ({ runId: run.runId, family: run.family }));
  return runs.length > 0 ? { runs } : undefined;
}

// ---------------------------------------------------------------- 上报

const RUN_ID_RE = /^ul-[a-z0-9-]{1,60}$/;

export type UnlockRunRecord = {
  hostId: number;
  family: UnlockFamily;
  runId: string;
  trigger: UnlockTrigger;
  requestedBy: number | null;
  checkedAt: number;
  results: UnlockServiceResult[];
};

let recordRun: (record: UnlockRunRecord) => Promise<void> = (record) => recordUnlockRun(record);

/** 只给测试用：换掉落库那一步。 */
export function setUnlockRecorderForTest(fn: ((record: UnlockRunRecord) => Promise<void>) | null) {
  recordRun = fn || ((record) => recordUnlockRun(record));
}

export async function ingestUnlockReport(host: AgentExtHost, raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const hostId = Number(host.id);
  const runs = (raw as Record<string, unknown>).runs;
  if (!(hostId > 0) || !Array.isArray(runs)) return;
  for (const item of runs.slice(0, 16)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const runId = String(entry.runId || "");
    if (!RUN_ID_RE.test(runId)) continue;
    const pending = pendingRuns.get(runId);
    // 只认面板自己排过、而且是排给这台主机的那几次；别的（过期的、别台的、编的）一律不收。
    if (!pending || pending.hostId !== hostId) continue;
    if (entry.status === "running") {
      pending.startedAt = pending.startedAt || Date.now();
      continue;
    }
    if (entry.status !== "done") continue;
    pendingRuns.delete(runId);
    const results = normalizeUnlockResults(entry.results);
    if (!results || results.length === 0) {
      console.warn(`[Unlock] host=${hostId} run=${runId} reported no valid results`);
      continue;
    }
    const finishedAt = Number(entry.finishedAt);
    const now = nowSec();
    // Agent 的时钟不一定准：只在差不多的范围内用它的完成时间。
    const checkedAt = Number.isFinite(finishedAt) && Math.abs(finishedAt - now) < 15 * 60 ? Math.floor(finishedAt) : now;
    await recordRun({ hostId, family: pending.family, runId, trigger: pending.trigger, requestedBy: pending.requestedBy, checkedAt, results });
  }
}

// ---------------------------------------------------------------- 存储

function parseResults(value: unknown): UnlockServiceResult[] {
  try {
    return normalizeUnlockResults(JSON.parse(String(value || "[]"))) || [];
  } catch {
    return [];
  }
}

function rowView(row: any) {
  return {
    id: Number(row.id),
    runId: String(row.runId),
    family: normalizeUnlockFamily(row.family),
    trigger: (String(row.triggerKind) === "schedule" ? "schedule" : "manual") as UnlockTrigger,
    checkedAt: Number(row.checkedAt) || 0,
    results: parseResults(row.resultsJson),
  };
}

export type UnlockRunRow = ReturnType<typeof rowView>;

export async function recordUnlockRun(record: UnlockRunRecord) {
  const existing = await queryRaw<any>(`SELECT ${q("id")} FROM ${q(TABLE)} WHERE ${q("runId")} = ? LIMIT 1`, [record.runId]);
  if (existing.length > 0) return;
  await executeRaw(
    `UPDATE ${q(TABLE)} SET ${q("latest")} = ? WHERE ${q("hostId")} = ? AND ${q("family")} = ? AND ${q("latest")} = ?`,
    [false, record.hostId, record.family, true],
  );
  await insertAndGetId(TABLE, {
    hostId: record.hostId,
    family: record.family,
    runId: record.runId,
    triggerKind: record.trigger,
    latest: true,
    resultsJson: JSON.stringify(record.results),
    requestedBy: record.requestedBy,
    checkedAt: record.checkedAt,
    createdAt: nowSec(),
  });
  await trimUnlockHistory(record.hostId);
}

/** 每台主机只留最近 UNLOCK_HISTORY_KEEP 次；各 family 最新的那一行不删（不然 IPv6 的结果会被几次 IPv4 挤掉）。 */
export async function trimUnlockHistory(hostId: number, keep = UNLOCK_HISTORY_KEEP) {
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("latest")} FROM ${q(TABLE)} WHERE ${q("hostId")} = ? ORDER BY ${q("checkedAt")} DESC, ${q("id")} DESC`,
    [hostId],
  );
  const drop = rows.slice(keep).filter((row) => !(row.latest === true || Number(row.latest) === 1)).map((row) => Number(row.id));
  if (drop.length === 0) return 0;
  await executeRaw(`DELETE FROM ${q(TABLE)} WHERE ${q("id")} IN (${drop.map(() => "?").join(", ")})`, drop);
  return drop.length;
}

export async function listUnlockHistory(hostId: number, limit = UNLOCK_HISTORY_KEEP) {
  const rows = await queryRaw<any>(
    `SELECT * FROM ${q(TABLE)} WHERE ${q("hostId")} = ? ORDER BY ${q("checkedAt")} DESC, ${q("id")} DESC LIMIT ${Math.max(1, Math.min(50, Math.floor(limit)))}`,
    [hostId],
  );
  return rows.map(rowView);
}

export async function latestUnlockRuns(hostId: number) {
  const rows = await queryRaw<any>(
    `SELECT * FROM ${q(TABLE)} WHERE ${q("hostId")} = ? AND ${q("latest")} = ? ORDER BY ${q("checkedAt")} DESC, ${q("id")} DESC`,
    [hostId, true],
  );
  return rows.map(rowView);
}

export type UnlockHostSummary = { family: UnlockFamily; checkedAt: number; items: UnlockChipItem[] };

/** 主机列表一页的摘要：每台取最新一次（任一 family），只带卡片摘要要的那几项。 */
export async function latestUnlockSummariesByHostIds(hostIds: number[]) {
  const ids = Array.from(new Set(hostIds.map(Number).filter((id) => id > 0))).slice(0, 1000);
  const map = new Map<number, UnlockHostSummary>();
  if (ids.length === 0) return map;
  const rows = await queryRaw<any>(
    `SELECT ${q("hostId")}, ${q("family")}, ${q("checkedAt")}, ${q("resultsJson")} FROM ${q(TABLE)}
     WHERE ${q("latest")} = ? AND ${q("hostId")} IN (${ids.map(() => "?").join(", ")})
     ORDER BY ${q("checkedAt")} DESC, ${q("id")} DESC`,
    [true, ...ids],
  );
  for (const row of rows) {
    const hostId = Number(row.hostId);
    if (map.has(hostId)) continue;
    const items = unlockChipItems(parseResults(row.resultsJson));
    if (items.length === 0) continue;
    map.set(hostId, { family: normalizeUnlockFamily(row.family), checkedAt: Number(row.checkedAt) || 0, items });
  }
  return map;
}

// ---------------------------------------------------------------- 计划检测

export async function getUnlockSchedule(): Promise<UnlockSchedule> {
  return normalizeUnlockSchedule(await getSetting(UNLOCK_SCHEDULE_SETTING).catch(() => null));
}

export async function setUnlockSchedule(schedule: UnlockSchedule) {
  await setSetting(UNLOCK_SCHEDULE_SETTING, normalizeUnlockSchedule(schedule));
}

/**
 * 挑出这一轮该排计划检测的主机：在线、Agent 够新、最近一次检测（任何触发方式、任何 family）
 * 早于一个周期，而且现在没有在等的检测。最久没测的排前面，最多 batch 台。
 */
export function pickScheduledUnlockHosts<T extends { id: number; agentVersion?: string | null; isOnline?: unknown }>(
  hosts: T[],
  lastCheckedAt: Map<number, number>,
  schedule: UnlockSchedule,
  now = nowSec(),
  batch = UNLOCK_SCHEDULE_BATCH,
) {
  const interval = unlockScheduleIntervalSeconds(schedule);
  if (!interval) return [];
  sweepPending();
  const busy = new Set(Array.from(pendingRuns.values()).map((run) => run.hostId));
  return hosts
    .filter((host) => (host.isOnline === true || host.isOnline === 1) && hostSupportsUnlock(host) && !busy.has(Number(host.id)))
    .map((host) => ({ host, last: lastCheckedAt.get(Number(host.id)) || 0 }))
    .filter((item) => now - item.last >= interval)
    .sort((a, b) => a.last - b.last)
    .slice(0, batch)
    .map((item) => item.host);
}

async function runUnlockScheduleTick() {
  const schedule = await getUnlockSchedule();
  if (schedule === "off") return;
  const { getHosts } = await import("../repositories/hostRepository");
  const hosts = (await getHosts()) as any[];
  const rows = await queryRaw<any>(`SELECT ${q("hostId")}, MAX(${q("checkedAt")}) AS ${q("last")} FROM ${q(TABLE)} GROUP BY ${q("hostId")}`);
  const last = new Map<number, number>(rows.map((row) => [Number(row.hostId), Number(row.last) || 0]));
  for (const host of pickScheduledUnlockHosts(hosts, last, schedule)) {
    try {
      startUnlockCheck(host, { family: "auto", trigger: "schedule" });
    } catch (error) {
      console.warn(`[Unlock] scheduled check host=${host.id} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

let scheduleStarted = false;

/** 由 server/scheduler.ts 的 startScheduler() 调一次。开关关着时每一轮只读一个设置。 */
export function startUnlockScheduleJob() {
  if (scheduleStarted) return;
  scheduleStarted = true;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runUnlockScheduleTick()
      .catch((error) => console.warn(`[Unlock] schedule tick failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = false; });
  };
  // 启动后先等 5 分钟，让 Agent 都重连上来。
  const startTimer = setTimeout(() => {
    tick();
    const timer = setInterval(tick, UNLOCK_SCHEDULE_TICK_MS);
    timer.unref?.();
  }, 5 * 60_000);
  startTimer.unref?.();
}

/** 只给测试用。 */
export function resetUnlockStateForTest() {
  pendingRuns.clear();
  recordRun = (record) => recordUnlockRun(record);
}
