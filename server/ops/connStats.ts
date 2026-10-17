/*
  逐跳连接监控（面板 2.3.451、FXP 2.2.133 起）。

  FXP 每分钟把这一分钟里每个（隧道, 规则, 角色, 阶段, 端点）的次数、失败、耗时分档报上来
  （forwardx-fxp/conn_stats.go → POST /api/agent/fxp-conn-stats），这里落成 connection_stage_stats
  一行一行，按隧道查询时再在 SQL 里按（主机, 角色, 阶段, 端点）和按小时加总。

  - 报上来的东西一律当不可信输入：数值截成非负整数、角色 / 阶段只认白名单、端点只认 host:port、
    隧道必须存在，一次最多 500 行。
  - 留 7 天；每小时最多清一次（在落库时顺手做，不另起定时器）。
*/
import { executeRaw, queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { appendPanelLog } from "../_core/panelLogger";
import {
  CONN_STAGES,
  addConnStats,
  emptyConnStatsAggregate,
  normalizeConnEndpoint,
  summarizeConnStats,
  type ConnStatsAggregate,
  type ConnStatsSummary,
} from "../../shared/connStats";

export const CONN_STATS_RETENTION_HOURS = 7 * 24;
const MAX_ROWS_PER_REPORT = 500;
const INT32_MAX = 2_147_483_647;
const ROLES = new Set(["entry", "exit", "relay"]);
const STAGES = new Set(CONN_STAGES.map((stage) => stage.key));

function count(value: unknown, max = INT32_MAX) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
}

export type ConnStatsIngestRow = {
  tunnelId: number;
  ruleId: number;
  role: string;
  stage: string;
  endpoint: string;
  attempts: number;
  failures: number;
  sumMs: number;
  maxMs: number;
  buckets: number[];
  lastError: string | null;
};

/** 规整 FXP 报上来的一行；认不出来的返回 null。 */
export function normalizeConnStatsRow(raw: unknown): ConnStatsIngestRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const tunnelId = count(row.tunnelId);
  const role = String(row.role || "").trim().toLowerCase();
  const stage = String(row.stage || "").trim().toLowerCase();
  const endpoint = normalizeConnEndpoint(row.endpoint);
  const attempts = count(row.attempts);
  if (tunnelId <= 0 || !ROLES.has(role) || !STAGES.has(stage as any) || !endpoint || attempts <= 0) return null;
  const buckets = Array.isArray(row.buckets) ? row.buckets.slice(0, 6).map((value) => count(value)) : [];
  while (buckets.length < 6) buckets.push(0);
  const lastError = row.lastError ? String(row.lastError).replace(/\s+/g, " ").trim().slice(0, 200) : null;
  return {
    tunnelId,
    ruleId: count(row.ruleId),
    role,
    stage,
    endpoint,
    attempts,
    failures: Math.min(attempts, count(row.failures)),
    sumMs: count(row.sumMs, Number.MAX_SAFE_INTEGER),
    maxMs: count(row.maxMs),
    buckets,
    lastError,
  };
}

let lastPruneAt = 0;

async function pruneConnStats(nowMs: number) {
  if (nowMs - lastPruneAt < 3_600_000) return;
  lastPruneAt = nowMs;
  const q = quoteDbIdentifier;
  const cutoff = Math.floor((nowMs - CONN_STATS_RETENTION_HOURS * 3_600_000) / 1000);
  await executeRaw(`DELETE FROM ${q("connection_stage_stats")} WHERE ${q("minuteAt")} < ?`, [cutoff]).catch((error) => {
    appendPanelLog("warn", `[ConnStats] prune failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * 落一份上报。tunnelExists 由调用方给（路由里查库），测试里可以换掉。
 * 返回实际落库的行数。
 */
export async function recordConnStatsReport(
  hostId: number,
  rawRows: unknown[],
  options: { nowMs?: number; tunnelExists: (tunnelId: number) => Promise<boolean> },
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const rows = rawRows.slice(0, MAX_ROWS_PER_REPORT).map(normalizeConnStatsRow).filter((row): row is ConnStatsIngestRow => !!row);
  if (rows.length === 0) return 0;
  const knownTunnels = new Map<number, boolean>();
  for (const row of rows) {
    if (!knownTunnels.has(row.tunnelId)) knownTunnels.set(row.tunnelId, await options.tunnelExists(row.tunnelId));
  }
  const accepted = rows.filter((row) => knownTunnels.get(row.tunnelId));
  if (accepted.length === 0) return 0;
  const minuteAt = Math.floor(nowMs / 60_000) * 60;
  const q = quoteDbIdentifier;
  const columns = ["hostId", "tunnelId", "ruleId", "role", "stage", "endpoint", "minuteAt", "attempts", "failures", "sumMs", "maxMs", "b50", "b100", "b200", "b500", "b1000", "bOver", "lastError"];
  const placeholders = `(${columns.map(() => "?").join(", ")})`;
  for (let start = 0; start < accepted.length; start += 100) {
    const chunk = accepted.slice(start, start + 100);
    const params: unknown[] = [];
    for (const row of chunk) {
      params.push(hostId, row.tunnelId, row.ruleId, row.role, row.stage, row.endpoint, minuteAt, row.attempts, row.failures, row.sumMs, row.maxMs, ...row.buckets, row.lastError);
    }
    await executeRaw(
      `INSERT INTO ${q("connection_stage_stats")} (${columns.map(q).join(", ")}) VALUES ${chunk.map(() => placeholders).join(", ")}`,
      params,
    );
  }
  void pruneConnStats(nowMs);
  return accepted.length;
}

export type ConnStatsGroup = {
  hostId: number;
  role: string;
  stage: string;
  endpoint: string;
  summary: ConnStatsSummary;
  lastError: string | null;
};

export type ConnStatsHourly = {
  /** 这一小时的开始（Unix 秒）。 */
  hourAt: number;
  stage: string;
  summary: ConnStatsSummary;
};

function rowAggregate(row: any): ConnStatsAggregate {
  return addConnStats(emptyConnStatsAggregate(), {
    attempts: Number(row.attempts),
    failures: Number(row.failures),
    sumMs: Number(row.sumMs),
    maxMs: Number(row.maxMs),
    buckets: [row.b50, row.b100, row.b200, row.b500, row.b1000, row.bOver].map(Number),
  });
}

const SUM_COLUMNS = ["attempts", "failures", "sumMs", "b50", "b100", "b200", "b500", "b1000", "bOver"];

/** 一条隧道最近 hours 小时：按（主机, 角色, 阶段, 端点）汇总，外加每小时每阶段的走势。 */
export async function getTunnelConnStats(tunnelId: number, hours: number, nowMs = Date.now()) {
  const q = quoteDbIdentifier;
  const since = Math.floor(nowMs / 1000) - Math.max(1, Math.min(CONN_STATS_RETENTION_HOURS, Math.floor(hours))) * 3600;
  const sums = SUM_COLUMNS.map((column) => `SUM(${q(column)}) AS ${q(column)}`).join(", ");
  const groupRows = await queryRaw<any>(
    `SELECT ${q("hostId")}, ${q("role")}, ${q("stage")}, ${q("endpoint")}, ${sums}, MAX(${q("maxMs")}) AS ${q("maxMs")}, MAX(${q("minuteAt")}) AS ${q("lastAt")}
       FROM ${q("connection_stage_stats")}
      WHERE ${q("tunnelId")} = ? AND ${q("minuteAt")} >= ?
      GROUP BY ${q("hostId")}, ${q("role")}, ${q("stage")}, ${q("endpoint")}
      ORDER BY ${q("role")}, ${q("stage")}, ${q("endpoint")}
      LIMIT 500`,
    [tunnelId, since],
  );
  // 每组最近一次失败原因：只查有失败的组，取最新的那行。
  const errorRows = await queryRaw<any>(
    `SELECT ${q("hostId")}, ${q("role")}, ${q("stage")}, ${q("endpoint")}, ${q("lastError")}, ${q("minuteAt")}
       FROM ${q("connection_stage_stats")}
      WHERE ${q("tunnelId")} = ? AND ${q("minuteAt")} >= ? AND ${q("failures")} > 0 AND ${q("lastError")} IS NOT NULL
      ORDER BY ${q("minuteAt")} DESC
      LIMIT 2000`,
    [tunnelId, since],
  );
  const lastErrors = new Map<string, string>();
  for (const row of errorRows) {
    const key = `${row.hostId}|${row.role}|${row.stage}|${row.endpoint}`;
    if (!lastErrors.has(key)) lastErrors.set(key, String(row.lastError));
  }
  const hourExpr = `(${q("minuteAt")} - (${q("minuteAt")} % 3600))`;
  const hourlyRows = await queryRaw<any>(
    `SELECT ${hourExpr} AS ${q("hourAt")}, ${q("stage")}, ${sums}, MAX(${q("maxMs")}) AS ${q("maxMs")}
       FROM ${q("connection_stage_stats")}
      WHERE ${q("tunnelId")} = ? AND ${q("minuteAt")} >= ?
      GROUP BY ${hourExpr}, ${q("stage")}
      ORDER BY ${q("hourAt")} ASC
      LIMIT 2000`,
    [tunnelId, since],
  );
  const groups: ConnStatsGroup[] = groupRows.map((row) => ({
    hostId: Number(row.hostId),
    role: String(row.role),
    stage: String(row.stage),
    endpoint: String(row.endpoint),
    summary: summarizeConnStats(rowAggregate(row)),
    lastError: lastErrors.get(`${row.hostId}|${row.role}|${row.stage}|${row.endpoint}`) ?? null,
  }));
  // 按连接走的顺序排：入口 → 中转 → 出口，每一跳里连接池 → TCP → 握手 → 连目标。
  const roleOrder = ["entry", "relay", "exit"];
  const stageOrder: string[] = CONN_STAGES.map((stage) => stage.key);
  groups.sort((a, b) => (
    roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role)
    || stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage)
    || a.hostId - b.hostId
    || a.endpoint.localeCompare(b.endpoint)
  ));
  const hourly: ConnStatsHourly[] = hourlyRows.map((row) => ({
    hourAt: Number(row.hourAt),
    stage: String(row.stage),
    summary: summarizeConnStats(rowAggregate(row)),
  }));
  return { tunnelId, hours, since, groups, hourly };
}

/** 测试用。 */
export function resetConnStatsPruneClock() {
  lastPruneAt = 0;
}
