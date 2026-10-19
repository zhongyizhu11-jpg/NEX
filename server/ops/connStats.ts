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
  bytesToMbps,
  emptyConnStatsAggregate,
  normalizeConnEndpoint,
  normalizeConnLegVia,
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
  /** 只有 stage=leg 有：哪一路、这一分钟送出 / 收到的字节。 */
  via: string;
  bytesUp: number;
  bytesDown: number;
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
  const isLeg = stage === "leg";
  const bytesUp = isLeg ? count(row.bytesUp, Number.MAX_SAFE_INTEGER) : 0;
  const bytesDown = isLeg ? count(row.bytesDown, Number.MAX_SAFE_INTEGER) : 0;
  // 每一路那一分钟可能没有新拨号、只有流量：有字节也算一行。
  if (tunnelId <= 0 || !ROLES.has(role) || !STAGES.has(stage as any) || !endpoint || (attempts <= 0 && bytesUp + bytesDown <= 0)) return null;
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
    via: isLeg ? normalizeConnLegVia(row.via) : "",
    bytesUp,
    bytesDown,
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
  const columns = ["hostId", "tunnelId", "ruleId", "role", "stage", "endpoint", "minuteAt", "attempts", "failures", "sumMs", "maxMs", "b50", "b100", "b200", "b500", "b1000", "bOver", "lastError", "via", "bytesUp", "bytesDown"];
  const placeholders = `(${columns.map(() => "?").join(", ")})`;
  for (let start = 0; start < accepted.length; start += 100) {
    const chunk = accepted.slice(start, start + 100);
    const params: unknown[] = [];
    for (const row of chunk) {
      params.push(hostId, row.tunnelId, row.ruleId, row.role, row.stage, row.endpoint, minuteAt, row.attempts, row.failures, row.sumMs, row.maxMs, ...row.buckets, row.lastError, row.via, row.bytesUp, row.bytesDown);
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

/** 单连接叠加的一路：拨号成功率 / 耗时，外加这段时间和最近几分钟实际跑了多少。 */
export type ConnStatsLeg = {
  hostId: number;
  endpoint: string;
  /** relay#主机 ID / stream#N；老数据是空。 */
  via: string;
  summary: ConnStatsSummary;
  lastError: string | null;
  bytesUp: number;
  bytesDown: number;
  /** 最近 CONN_LEG_RECENT_SECONDS 秒的平均速率（Mbps，两个方向分开）。 */
  recentUpMbps: number;
  recentDownMbps: number;
  /** 这段时间里这一路占全部路字节数的百分比（0–100，整数）。 */
  sharePercent: number;
};

/** 「每一路实时跑多少」按最近 5 分钟平均：FXP 一分钟报一次，再短就只剩一两个点，跳得厉害。 */
export const CONN_LEG_RECENT_SECONDS = 300;

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

const SUM_COLUMNS = ["attempts", "failures", "sumMs", "b50", "b100", "b200", "b500", "b1000", "bOver", "bytesUp", "bytesDown"];

/** 一条隧道最近 hours 小时：按（主机, 角色, 阶段, 端点）汇总，单连接叠加的每一路另列，外加每小时每阶段的走势。 */
export async function getTunnelConnStats(tunnelId: number, hours: number, nowMs = Date.now()) {
  const q = quoteDbIdentifier;
  const since = Math.floor(nowMs / 1000) - Math.max(1, Math.min(CONN_STATS_RETENTION_HOURS, Math.floor(hours))) * 3600;
  const sums = SUM_COLUMNS.map((column) => `SUM(${q(column)}) AS ${q(column)}`).join(", ");
  const groupRows = await queryRaw<any>(
    `SELECT ${q("hostId")}, ${q("role")}, ${q("stage")}, ${q("endpoint")}, ${q("via")}, ${sums}, MAX(${q("maxMs")}) AS ${q("maxMs")}, MAX(${q("minuteAt")}) AS ${q("lastAt")}
       FROM ${q("connection_stage_stats")}
      WHERE ${q("tunnelId")} = ? AND ${q("minuteAt")} >= ?
      GROUP BY ${q("hostId")}, ${q("role")}, ${q("stage")}, ${q("endpoint")}, ${q("via")}
      ORDER BY ${q("role")}, ${q("stage")}, ${q("endpoint")}
      LIMIT 500`,
    [tunnelId, since],
  );
  const recentSince = Math.max(since, Math.floor(nowMs / 1000) - CONN_LEG_RECENT_SECONDS);
  const recentRows = await queryRaw<any>(
    `SELECT ${q("hostId")}, ${q("endpoint")}, ${q("via")}, SUM(${q("bytesUp")}) AS ${q("bytesUp")}, SUM(${q("bytesDown")}) AS ${q("bytesDown")}
       FROM ${q("connection_stage_stats")}
      WHERE ${q("tunnelId")} = ? AND ${q("stage")} = 'leg' AND ${q("minuteAt")} >= ?
      GROUP BY ${q("hostId")}, ${q("endpoint")}, ${q("via")}
      LIMIT 200`,
    [tunnelId, recentSince],
  );
  const recent = new Map<string, { up: number; down: number }>();
  for (const row of recentRows) recent.set(`${row.hostId}|${row.endpoint}|${row.via ?? ""}`, { up: Number(row.bytesUp) || 0, down: Number(row.bytesDown) || 0 });
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
  const recentSeconds = Math.max(1, Math.floor(nowMs / 1000) - recentSince);
  const legRows = groupRows.filter((row) => String(row.stage) === "leg");
  const legBytesTotal = legRows.reduce((sum, row) => sum + (Number(row.bytesUp) || 0) + (Number(row.bytesDown) || 0), 0);
  const legs: ConnStatsLeg[] = legRows.map((row) => {
    const bytesUp = Number(row.bytesUp) || 0;
    const bytesDown = Number(row.bytesDown) || 0;
    const via = String(row.via ?? "");
    const last = recent.get(`${row.hostId}|${row.endpoint}|${via}`) ?? { up: 0, down: 0 };
    return {
      hostId: Number(row.hostId),
      endpoint: String(row.endpoint),
      via,
      summary: summarizeConnStats(rowAggregate(row)),
      lastError: lastErrors.get(`${row.hostId}|${row.role}|${row.stage}|${row.endpoint}`) ?? null,
      bytesUp,
      bytesDown,
      recentUpMbps: bytesToMbps(last.up, recentSeconds),
      recentDownMbps: bytesToMbps(last.down, recentSeconds),
      sharePercent: legBytesTotal > 0 ? Math.round(((bytesUp + bytesDown) / legBytesTotal) * 100) : 0,
    };
  });
  legs.sort((a, b) => a.hostId - b.hostId || a.via.localeCompare(b.via, "en", { numeric: true }) || a.endpoint.localeCompare(b.endpoint));
  const groups: ConnStatsGroup[] = groupRows.filter((row) => String(row.stage) !== "leg").map((row) => ({
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
  return { tunnelId, hours, since, groups, legs, legRecentSeconds: recentSeconds, hourly };
}

/** 测试用。 */
export function resetConnStatsPruneClock() {
  lastPruneAt = 0;
}
