import { executeRaw, queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { appendPanelLog } from "../_core/panelLogger";

/*
  FXP 数据面运行时指标（forwardx-fxp/runtime_metrics.go）：队列挤掉 / 过期丢包、会话被拒 / 回收、连接池命中与否、
  会话收尾的原因，以及此刻活着的 TCP / UDP 会话数。FXP 每分钟报一次 /api/agent/fxp-runtime-metrics，这里按分钟落一行，
  留 7 天；/metrics 把最近 5 分钟的 counter 加起来、gauge 取每个键最新的一行（见 collectFxpRuntimeMetrics）。

  名字和角色是闭合的名单：认不出的行丢掉 —— 这是 Agent 令牌就能写的表，不能让它变成任意标签的注入口。
*/

const FXP_RUNTIME_METRIC_ROLES = new Set(["entry", "relay", "exit", "process"]);
const FXP_RUNTIME_COUNTERS = new Set([
  "udp_queue_drop",
  "udp_expired_drop",
  "udp_session_rejected",
  "udp_session_reclaimed",
  "pool_hit",
  "pool_miss",
  "peer_gone",
  "half_close_reaped",
  "linger_expired",
]);
const FXP_RUNTIME_GAUGES = new Set(["udp_sessions", "tcp_sessions"]);

const RETENTION_HOURS = 24 * 7;
const MAX_ROWS_PER_REPORT = 2000;
const WINDOW_SECONDS = 5 * 60;
const INT32_MAX = 2_147_483_647;

export type FxpRuntimeMetricRow = {
  tunnelId: number;
  ruleId: number;
  role: string;
  name: string;
  kind: "counter" | "gauge";
  value: number;
};

function int(value: unknown, max = INT32_MAX): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? Math.min(max, n) : 0;
}

/** 规整 FXP 报上来的一行；认不出来的返回 null。 */
export function normalizeFxpRuntimeMetricRow(raw: unknown): FxpRuntimeMetricRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const role = String(row.role || "").trim().toLowerCase();
  const name = String(row.name || "").trim().toLowerCase();
  const kind = String(row.kind || "").trim().toLowerCase();
  if (!FXP_RUNTIME_METRIC_ROLES.has(role)) return null;
  if (kind === "counter" ? !FXP_RUNTIME_COUNTERS.has(name) : kind === "gauge" ? !FXP_RUNTIME_GAUGES.has(name) : true) return null;
  const tunnelId = int(row.tunnelId);
  // 进程级事件没有隧道；别的都要有。
  if (role === "process" ? tunnelId !== 0 : tunnelId <= 0) return null;
  const value = int(row.value, Number.MAX_SAFE_INTEGER);
  // counter 这一分钟一次都没有就不用报；gauge 为 0 是有意义的（会话都收完了）。
  if (kind === "counter" && value <= 0) return null;
  return { tunnelId, ruleId: int(row.ruleId), role, name, kind: kind as "counter" | "gauge", value };
}

let lastPruneAt = 0;

async function prune(nowMs: number) {
  if (nowMs - lastPruneAt < 3_600_000) return;
  lastPruneAt = nowMs;
  const q = quoteDbIdentifier;
  const cutoff = Math.floor((nowMs - RETENTION_HOURS * 3_600_000) / 1000);
  await executeRaw(`DELETE FROM ${q("fxp_runtime_metrics")} WHERE ${q("minuteAt")} < ?`, [cutoff]).catch((error) => {
    appendPanelLog("warn", `[FxpMetrics] prune failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** 落一份上报，返回实际落库的行数。tunnelExists 由调用方给（路由里查库），进程级（tunnelId 0）的行不查。 */
export async function recordFxpRuntimeMetricsReport(
  hostId: number,
  rawRows: unknown[],
  options: { nowMs?: number; tunnelExists: (tunnelId: number) => Promise<boolean> },
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const rows = rawRows.slice(0, MAX_ROWS_PER_REPORT).map(normalizeFxpRuntimeMetricRow).filter((row): row is FxpRuntimeMetricRow => !!row);
  if (rows.length === 0) return 0;
  const known = new Map<number, boolean>([[0, true]]);
  for (const row of rows) {
    if (!known.has(row.tunnelId)) known.set(row.tunnelId, await options.tunnelExists(row.tunnelId));
  }
  const accepted = rows.filter((row) => known.get(row.tunnelId));
  if (accepted.length === 0) return 0;
  const minuteAt = Math.floor(nowMs / 60_000) * 60;
  const q = quoteDbIdentifier;
  const columns = ["hostId", "tunnelId", "ruleId", "role", "name", "kind", "minuteAt", "value"];
  const placeholders = `(${columns.map(() => "?").join(", ")})`;
  for (let start = 0; start < accepted.length; start += 100) {
    const chunk = accepted.slice(start, start + 100);
    const params: unknown[] = [];
    for (const row of chunk) params.push(hostId, row.tunnelId, row.ruleId, row.role, row.name, row.kind, minuteAt, row.value);
    await executeRaw(
      `INSERT INTO ${q("fxp_runtime_metrics")} (${columns.map(q).join(", ")}) VALUES ${chunk.map(() => placeholders).join(", ")}`,
      params,
    );
  }
  void prune(nowMs);
  return accepted.length;
}

export type FxpRuntimeMetricSample = {
  hostId: number;
  tunnelId: number;
  ruleId: number;
  role: string;
  name: string;
  kind: "counter" | "gauge";
  /** counter：最近 5 分钟的和；gauge：最新那一分钟报的值。 */
  value: number;
};

/** /metrics 用：最近 5 分钟的 counter 之和、每个键最新的 gauge。一条 SQL，行数有上限。 */
export async function collectFxpRuntimeMetrics(nowMs = Date.now()): Promise<FxpRuntimeMetricSample[]> {
  const q = quoteDbIdentifier;
  const since = Math.floor(nowMs / 1000) - WINDOW_SECONDS;
  const rows = await queryRaw<Record<string, unknown>>(
    `SELECT ${q("hostId")}, ${q("tunnelId")}, ${q("ruleId")}, ${q("role")}, ${q("name")}, ${q("kind")}, ${q("minuteAt")}, ${q("value")}
       FROM ${q("fxp_runtime_metrics")}
      WHERE ${q("minuteAt")} >= ?
      ORDER BY ${q("minuteAt")} DESC
      LIMIT 20000`,
    [since],
  );
  const samples = new Map<string, FxpRuntimeMetricSample>();
  for (const row of rows) {
    const kind = String(row.kind) as "counter" | "gauge";
    const key = [row.hostId, row.tunnelId, row.ruleId, row.role, row.name, kind].map(String).join("|");
    const value = Number(row.value) || 0;
    const existing = samples.get(key);
    if (!existing) {
      samples.set(key, { hostId: Number(row.hostId), tunnelId: Number(row.tunnelId), ruleId: Number(row.ruleId), role: String(row.role), name: String(row.name), kind, value });
    } else if (kind === "counter") {
      existing.value += value;
    }
    // gauge：行按 minuteAt 倒序，第一行就是最新的，后面的不要。
  }
  return [...samples.values()].sort((a, b) => a.hostId - b.hostId || a.tunnelId - b.tunnelId || a.ruleId - b.ruleId || a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
}
