import { appendPanelLog } from "./_core/panelLogger";
import { setSlowStatementListener, statementFingerprint, type DatabaseStatementSample } from "./dbStatementStats";

/*
  慢查询记录（三种数据库都管）。

  每条 SQL 在 dbRuntime 里都计了时（server/dbStatementStats.ts）；超过阈值的按「语句指纹」
  （参数、数字、IN 列表长度都抹平）归成一条，记次数、总耗时、最长、最近一次和是从哪段代码发出的，
  管理员在 设置 › 进阶 › 慢查询 里看（trpc.ops.slowQueries）。只存指纹，不存参数值。

  - 阈值存在系统设置 slowQueryThresholdMs 里，默认 200 毫秒，0 = 不记；环境变量
    FORWARDX_SLOW_QUERY_MS 优先（排查时临时调低用）。
  - SQLite 量的是语句本身的执行时间（同步执行，不含排队等连接锁）；MySQL / PostgreSQL 量的是
    从发出到拿到结果，含网络往返和等连接池 —— 网络慢、连接池不够也会体现在这里。
  - 只在内存里，最多 200 种语句；面板重启就清空。同一种语句 5 分钟内最多往面板日志写一条。
*/

export const SLOW_QUERY_THRESHOLD_SETTING = "slowQueryThresholdMs";
export const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 200;
export const SLOW_QUERY_THRESHOLD_MAX_MS = 60_000;
const MAX_ENTRIES = 200;
const MAX_RECENT = 50;
const LOG_INTERVAL_MS = 5 * 60 * 1000;

export type SlowQueryEntry = {
  fingerprint: string;
  dbKind: string;
  kind: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  firstAt: number;
  lastAt: number;
  errors: number;
  caller: string;
};

export type SlowQueryEvent = {
  at: number;
  durationMs: number;
  fingerprint: string;
  dbKind: string;
  caller: string;
  error?: string;
};

const entries = new Map<string, SlowQueryEntry & { loggedAt: number }>();
const recent: SlowQueryEvent[] = [];
let savedThresholdMs = DEFAULT_SLOW_QUERY_THRESHOLD_MS;
let since = Date.now();

function envThresholdMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = String(env.FORWARDX_SLOW_QUERY_MS ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.min(SLOW_QUERY_THRESHOLD_MAX_MS, Math.floor(value)) : null;
}

export function normalizeSlowQueryThresholdMs(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return DEFAULT_SLOW_QUERY_THRESHOLD_MS;
  return Math.min(SLOW_QUERY_THRESHOLD_MAX_MS, Math.floor(number));
}

/** 生效的阈值：环境变量 > 设置 > 默认。 */
export function effectiveSlowQueryThresholdMs() {
  return envThresholdMs() ?? savedThresholdMs;
}

/** 设置里的阈值变了（启动时读一次、保存时再调一次）。 */
export function applySlowQueryThresholdMs(value: unknown) {
  savedThresholdMs = normalizeSlowQueryThresholdMs(value);
  setSlowStatementListener(recordSlowStatement, effectiveSlowQueryThresholdMs());
  return effectiveSlowQueryThresholdMs();
}

// 数据库层自己的函数：打包后（dist/index.js）文件名看不出来，只能按函数名跳过。
const DATABASE_LAYER_FRAMES = new Set([
  "callerOf", "recordSlowStatement", "recordDatabaseStatement", "timedSqliteStatement", "timedRemoteStatement",
  "withSqliteConnectionLock", "reportDatabaseErrors", "executeRaw", "executeRawImpl", "queryRaw", "queryRawImpl",
  "insertAndGetId", "runDatabaseTransaction", "withDatabaseTransaction", "Object.get", "Proxy.<anonymous>",
]);

/** 发出这条 SQL 的代码：调用栈（含 async 帧）里头几段不在数据库层、不在依赖包里的函数。尽力而为，可能为空。 */
function callerOf(stack: string | undefined) {
  if (!stack) return "";
  const frames = stack.split("\n").slice(1).map((line) => line.trim());
  const picked: string[] = [];
  for (const frame of frames) {
    if (/node_modules|node:internal|\(native\)/.test(frame)) continue;
    const match = /^at (?:async )?([^\s(]+)/.exec(frame);
    const name = match?.[1] || "";
    if (!name || DATABASE_LAYER_FRAMES.has(name) || name.startsWith("process.") || name.startsWith("file:") || name.startsWith("/")) continue;
    if (picked[picked.length - 1] === name) continue;
    picked.push(name);
    if (picked.length >= 3) break;
  }
  return picked.join(" ← ");
}

function recordSlowStatement(sample: DatabaseStatementSample) {
  const fingerprint = statementFingerprint(sample.sqlText) || "(empty)";
  const now = Date.now();
  const caller = callerOf(new Error().stack);
  const durationMs = Math.round(sample.durationMs * 10) / 10;
  let entry = entries.get(fingerprint);
  if (!entry) {
    if (entries.size >= MAX_ENTRIES) {
      // 满了就挤掉最久没再出现的那条
      let oldestKey = "";
      let oldestAt = Infinity;
      for (const [key, value] of entries) {
        if (value.lastAt < oldestAt) {
          oldestAt = value.lastAt;
          oldestKey = key;
        }
      }
      if (oldestKey) entries.delete(oldestKey);
    }
    entry = {
      fingerprint,
      dbKind: sample.dbKind,
      kind: sample.kind,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: 0,
      firstAt: now,
      lastAt: now,
      errors: 0,
      caller,
      loggedAt: 0,
    };
    entries.set(fingerprint, entry);
  }
  entry.count += 1;
  entry.totalMs += durationMs;
  entry.maxMs = Math.max(entry.maxMs, durationMs);
  entry.lastMs = durationMs;
  entry.lastAt = now;
  if (sample.error) entry.errors += 1;
  if (caller) entry.caller = caller;
  recent.unshift({
    at: now,
    durationMs,
    fingerprint,
    dbKind: sample.dbKind,
    caller,
    ...(sample.error ? { error: (sample.error instanceof Error ? sample.error.message : String(sample.error)).slice(0, 200) } : {}),
  });
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  if (now - entry.loggedAt >= LOG_INTERVAL_MS) {
    entry.loggedAt = now;
    appendPanelLog(
      "warn",
      `[SlowQuery] ${sample.dbKind} ${durationMs}ms${caller ? ` from ${caller}` : ""}: ${fingerprint.slice(0, 300)}`,
    );
  }
}

export function listSlowQueries() {
  return {
    thresholdMs: effectiveSlowQueryThresholdMs(),
    savedThresholdMs,
    envOverride: envThresholdMs() !== null,
    since,
    entries: [...entries.values()]
      .map(({ loggedAt: _loggedAt, ...entry }) => ({ ...entry, totalMs: Math.round(entry.totalMs), avgMs: Math.round((entry.totalMs / Math.max(1, entry.count)) * 10) / 10 }))
      .sort((a, b) => b.totalMs - a.totalMs),
    recent: recent.slice(),
  };
}

export function clearSlowQueries() {
  entries.clear();
  recent.length = 0;
  since = Date.now();
}

// 模块一加载就按默认阈值开着；启动时再按设置覆盖一次（loadSlowQueryThreshold）。
applySlowQueryThresholdMs(DEFAULT_SLOW_QUERY_THRESHOLD_MS);
