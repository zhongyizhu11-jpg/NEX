import { performance } from "node:perf_hooks";

/*
  每条 SQL 的计时（三种数据库都经过这里，见 server/dbRuntime.ts）。

  - 读 / 写 / 其它的条数和总耗时一直在数（只是几个加法），压测采样（server/perfSampler.ts）
    每隔几秒取一次差值；
  - 超过阈值的语句交给慢查询记录（setSlowStatementListener，server/slowQueryLog.ts 挂上来）；
  - 压测时还可以按「语句指纹」数每种语句跑了多少次（enableStatementFingerprints），平时不开：
    每条语句都要做一遍正则。

  计时只是驱动调用前后各取一次 performance.now()。SQLite 是同步执行，量到的就是语句本身；
  MySQL / PostgreSQL 量到的是从发出到拿到结果，含网络往返和等连接池。
*/

export type DatabaseStatementKind = "read" | "write" | "other";

export type DatabaseStatementSample = {
  dbKind: string;
  sqlText: string;
  durationMs: number;
  kind: DatabaseStatementKind;
  error?: unknown;
};

type FingerprintCounter = { count: number; totalMs: number; kind: DatabaseStatementKind };

const totals = { read: 0, write: 0, other: 0, readMs: 0, writeMs: 0, otherMs: 0, errors: 0 };
let fingerprints: Map<string, FingerprintCounter> | null = null;
const FINGERPRINT_LIMIT = 2000;
let slowListener: ((sample: DatabaseStatementSample) => void) | null = null;
let slowThresholdMs = Number.POSITIVE_INFINITY;

export function classifyStatement(sqlText: string): DatabaseStatementKind {
  let index = 0;
  const text = String(sqlText || "");
  while (index < text.length && text.charCodeAt(index) <= 32) index += 1;
  const head = text.slice(index, index + 8).toUpperCase();
  if (head.startsWith("SELECT") || head.startsWith("WITH") || head.startsWith("SHOW") || head.startsWith("EXPLAIN")) return "read";
  if (head.startsWith("INSERT") || head.startsWith("UPDATE") || head.startsWith("DELETE") || head.startsWith("REPLACE")) return "write";
  return "other";
}

/** 同一种语句（只是参数、IN 列表长度、数字字面量不同）归成一条。 */
export function statementFingerprint(sqlText: string) {
  return String(sqlText || "")
    .replace(/\s+/g, " ")
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    // (?) / (?, ?, …) → (?…)；多行 VALUES (?…), (?…), … 也并成一个
    .replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, "(?…)")
    .replace(/\(\?…\)(?:\s*,\s*\(\?…\))+/g, "(?…)")
    .trim()
    .slice(0, 1000);
}

/** 慢查询记录挂在这里：超过阈值的语句交给它。阈值 <= 0 表示不记。 */
export function setSlowStatementListener(listener: ((sample: DatabaseStatementSample) => void) | null, thresholdMs: number) {
  slowListener = listener;
  slowThresholdMs = Number.isFinite(thresholdMs) && thresholdMs > 0 ? thresholdMs : Number.POSITIVE_INFINITY;
}

export function enableStatementFingerprints(enabled = true) {
  fingerprints = enabled ? (fingerprints || new Map()) : null;
}

export function statementTimerStart() {
  return performance.now();
}

/** dbRuntime 在每条语句执行完（含出错）后调用一次。 */
export function recordDatabaseStatement(dbKind: string, sqlText: string, startedAt: number, error?: unknown) {
  const durationMs = performance.now() - startedAt;
  const kind = classifyStatement(sqlText);
  totals[kind] += 1;
  totals[`${kind}Ms`] += durationMs;
  if (error) totals.errors += 1;
  if (fingerprints) {
    const key = statementFingerprint(sqlText);
    const counter = fingerprints.get(key);
    if (counter) {
      counter.count += 1;
      counter.totalMs += durationMs;
    } else if (fingerprints.size < FINGERPRINT_LIMIT) {
      fingerprints.set(key, { count: 1, totalMs: durationMs, kind });
    }
  }
  if (durationMs >= slowThresholdMs && slowListener) {
    try {
      slowListener({ dbKind, sqlText, durationMs, kind, error });
    } catch {
      // 记录慢查询本身出错不能影响查询结果
    }
  }
}

/** 从上次调用到现在的增量（压测采样用），顺便把计数清零。 */
export function takeDatabaseStatementStats(topLimit = 20) {
  const snapshot = { ...totals };
  for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] = 0;
  let top: Array<{ sql: string; count: number; totalMs: number; kind: DatabaseStatementKind }> = [];
  if (fingerprints) {
    top = [...fingerprints.entries()]
      .map(([sql, counter]) => ({ sql, ...counter }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topLimit);
    fingerprints.clear();
  }
  return { ...snapshot, top };
}
