import { and, asc, desc, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { normalizeLatencySeriesKey } from "../../shared/latencyProbe";
import {
  hostMetrics, InsertHostMetric,
  trafficStats, InsertTrafficStat,
  forwardRules,
  forwardGroups,
  forwardGroupMembers,
  hosts,
  tunnels,
  forwardTests, InsertForwardTest,
  tcpingStats, InsertTcpingStat,
  tunnelLatencyStats, InsertTunnelLatencyStat,
  forwardGroupLatencyStats, InsertForwardGroupLatencyStat,
} from "../../drizzle/schema";
import { executeRaw, getDb, getDatabaseKind, nowDate, queryRaw, rawAffectedRows, withDatabaseTransaction } from "../dbRuntime";
import { boolLiteral, bucketExpression, limitOffset, quoteIdentifier } from "../dbCompat";
import { isRuleProbeUnreachable } from "../../shared/linkProbePolicy";
import { clampPositiveInt, epochSeconds, sqlBool } from "./repositoryUtils";
import { deleteExpiredHistoryRows } from "./historyRetention";
import { getSetting, setSetting } from "./settingsRepository";
import { appendPanelLog } from "../_core/panelLogger";
import { notifyTunnelLatencyRefresh } from "../tunnelLatencyRefresh";
import { normalizeAgentProbeCounts } from "../../shared/agentDtos";
import { normalizeTrafficCounterBytes } from "../../shared/trafficCounterBytes";
import { getProbeCounterStatistics } from "./probeCounterRepository";
import { SELF_TEST_MAX_LIFETIME_SECONDS } from "../selfTestTiming";
import { reconcileHostTrafficPolicy } from "../hostTrafficPolicy";

const TRAFFIC_BUCKET_MINUTES = 30;
const TRAFFIC_BUCKET_SECONDS = TRAFFIC_BUCKET_MINUTES * 60;
/**
 * 明细与分桶的保留期。导出是因为界面上「近 N 小时」的字样必须跟它一致 ——
 * 这里改了而界面没跟上，那句标签就变成了一句假话（数字按更短的窗口算，
 * 标签却写着更长的时间范围）。
 */
export const TRAFFIC_BUCKET_RETENTION_HOURS = 72;
const LEGACY_TRAFFIC_REPORT_RETENTION_HOURS = 7 * 24;
const LATEST_METRIC_HOST_BATCH_SIZE = 100;
// v3 repairs bucket gaps left by older best-effort writes. Current traffic
// writes update raw rows, counters and buckets in one transaction.
const TRAFFIC_BUCKET_BACKFILL_MARKER = "v3";
const TRAFFIC_BUCKET_BACKFILL_SETTING = "trafficStatBucketsBackfilled";
const TRAFFIC_BILLING_RULE_USAGE_BACKFILL_SETTING = "traffic-billing-rule-usage-v1";
const USER_TRAFFIC_COUNTER_BACKFILL_SETTING = "user-traffic-counters-v2";
const USER_TRAFFIC_COUNTER_BACKFILL_MARKER = "v2";
let trafficBucketUpsertWarned = false;
let userTrafficCounterUpsertWarned = false;

function managedParentRuleJoin(childAlias: string, parentAlias = "parent") {
  const q = quoteIdentifier;
  return `LEFT JOIN ${q("forward_rules")} ${parentAlias}
          ON ${parentAlias}.${q("id")} = ${childAlias}.${q("forwardGroupRuleId")}
         AND ${parentAlias}.${q("forwardGroupId")} = ${childAlias}.${q("forwardGroupId")}
         AND ${parentAlias}.${q("isForwardGroupTemplate")} = ${boolLiteral(true)}`;
}

function rowDate(value: unknown) {
  if (value instanceof Date) return value;
  const n = Number(value || 0);
  return new Date(n * 1000);
}

function rowBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function numeric(value: unknown) {
  return Number(value) || 0;
}

function trafficBucketFor(seconds: number, bucketSeconds: number) {
  return Math.floor(seconds / bucketSeconds) * bucketSeconds;
}

function bucketStartFor(seconds: number) {
  return trafficBucketFor(seconds, TRAFFIC_BUCKET_SECONDS);
}

function bucketExprSql(alias: string, bucketSec: number) {
  return bucketExpression(alias, "recordedAt", bucketSec);
}

function rawBoolSql(value: boolean) {
  return boolLiteral(value);
}

function warnTrafficBucketOnce(error: unknown, context?: { ruleId?: number; hostId?: number; userId?: number }) {
  if (trafficBucketUpsertWarned) return;
  trafficBucketUpsertWarned = true;
  const details = [
    context?.ruleId ? `rule=${context.ruleId}` : "",
    context?.hostId ? `host=${context.hostId}` : "",
    context?.userId ? `user=${context.userId}` : "",
  ].filter(Boolean).join(" ");
  console.warn(`[TrafficSummary] Bucket update failed${details ? ` ${details}` : ""}; report will retry:`, error instanceof Error ? error.message : String(error));
}

function warnUserTrafficCounterOnce(error: unknown, context?: { ruleId?: number; userId?: number }) {
  if (userTrafficCounterUpsertWarned) return;
  userTrafficCounterUpsertWarned = true;
  const details = [
    context?.ruleId ? `rule=${context.ruleId}` : "",
    context?.userId ? `user=${context.userId}` : "",
  ].filter(Boolean).join(" ");
  console.warn(`[TrafficCounter] User counter update failed${details ? ` ${details}` : ""}; report will retry:`, error instanceof Error ? error.message : String(error));
}

function retentionCutoffSeconds(retainHours: number) {
  const hours = Math.max(1, Math.floor(Number(retainHours) || 0));
  return Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);
}

function withProbeCounts<T extends { isTimeout?: unknown; probeCount?: unknown; probeSuccesses?: unknown }>(stat: T) {
  // This is a write boundary.  An explicitly supplied zero-success sample
  // must remain a failure even when its legacy timeout flag is inconsistent;
  // the compatibility fallback belongs only on read paths for old rows.
  const probeCounts = normalizeAgentProbeCounts(stat, { legacyZeroAsSuccess: false });
  return {
    ...stat,
    ...probeCounts,
    // Counters are authoritative for the sample-level timeout flag. This
    // also makes partially successful rows written by older Agents readable
    // without hiding their latency behind `isTimeout=true`.
    isTimeout: probeCounts.probeSuccesses <= 0,
  };
}

function mappedProbeCounts(row: { isTimeout?: unknown; probeCount?: unknown; probeSuccesses?: unknown }) {
  return normalizeAgentProbeCounts({ ...row, isTimeout: rowBool(row.isTimeout) });
}

async function queryLatestHostMetricRows(
  hostIds: number[],
  columns: readonly string[],
) {
  const q = quoteIdentifier;

  // 三种方言统一走「每台主机 ORDER BY ... LIMIT 2，再 UNION ALL」：
  // 原来 MySQL/PostgreSQL 用 ROW_NUMBER() OVER (PARTITION BY hostId)，窗口函数
  // 要先把这些主机在 host_metrics 里保留期内的**全部**明细读出来再排名，
  // 主机多、上报频繁时一次就是几十万行；而每台主机取最新两条正好能被
  // (hostId, recordedAt) 索引倒序扫两行就停。派生表都带别名（recent / combined），
  // MySQL 8 和 PostgreSQL 都要求这一点。rn 在下面按同样的排序键
  // (hostId ASC, recordedAt DESC, id DESC) 在内存里重新编号，和窗口函数给的一致。
  const sortedHostIds = [...hostIds].sort((a, b) => a - b);
  const rows: any[] = [];
  for (let offset = 0; offset < sortedHostIds.length; offset += LATEST_METRIC_HOST_BATCH_SIZE) {
    const batch = sortedHostIds.slice(offset, offset + LATEST_METRIC_HOST_BATCH_SIZE);
    const innerColumns = columns.map((column) => q(column)).join(", ");
    const outerColumns = columns.map((column) => `recent.${q(column)}`).join(", ");
    const perHostQueries = batch.map(() => (
      `SELECT ${outerColumns}
         FROM (
           SELECT ${innerColumns}
             FROM ${q("host_metrics")}
            WHERE ${q("hostId")} = ?
            ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
            LIMIT 2
         ) recent`
    ));
    const batchRows = await queryRaw<any>(
      `SELECT combined.*
         FROM (${perHostQueries.join("\nUNION ALL\n")}) combined
        ORDER BY combined.${q("hostId")} ASC,
                 combined.${q("recordedAt")} DESC,
                 combined.${q("id")} DESC`,
      batch,
    );
    rows.push(...batchRows);
  }

  let previousHostId = 0;
  let rank = 0;
  return rows.map((row) => {
    const hostId = Number(row?.hostId || 0);
    if (hostId !== previousHostId) {
      previousHostId = hostId;
      rank = 0;
    }
    rank += 1;
    return { ...row, rn: rank };
  });
}

function canUseTrafficBuckets(since?: Date) {
  if (!since) return false;
  return epochSeconds(since) >= retentionCutoffSeconds(TRAFFIC_BUCKET_RETENTION_HOURS);
}

/**
 * 一段时间按 30 分钟桶切成三截：[since, 第一个整桶起点) 和 [当前桶起点, ∞) 读原始样本，
 * 中间已经结束的整桶读桶表。
 *
 * 能这么切是因为：样本的 recordedAt 由面板取当前时间，原始样本、累计量和桶在同一个事务里写
 * （见 insertTrafficStatsBatch 的调用方），v3 回填又从原始样本重建过一遍桶 —— 已经结束的桶
 * 不会再变，它和那 30 分钟的原始样本逐字节相等。唯一的差别是全零样本不进桶，只影响「有没有
 * 一行 0」，不影响任何数。当前这一桶还在写，所以照旧读原始样本。
 */
function trafficWindowSplit(sinceSec: number) {
  const currentStart = bucketStartFor(epochSeconds(nowDate()));
  const fullStart = Math.min(Math.ceil(sinceSec / TRAFFIC_BUCKET_SECONDS) * TRAFFIC_BUCKET_SECONDS, currentStart);
  return {
    // 整桶区间 [fullStart, fullEnd)；fullStart >= fullEnd 时没有整桶
    fullStart,
    fullEnd: currentStart,
    // 原始样本的尾段从这里起（since 落在当前桶里时就是 since 本身）
    tailStart: Math.max(sinceSec, currentStart),
  };
}

// 超过这个数的 id 列表在 SQLite 上改走 json_each 子查询：只占一个参数、SQL 文本固定，
// 预编译语句能复用（几千个 ? 的语句又长又每次都要重新编译）。
const LONG_ID_LIST = 64;

function idListSql(column: string, ids: number[]) {
  if (ids.length > LONG_ID_LIST && getDatabaseKind() === "sqlite") {
    return { sql: `${column} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(ids)] as any[] };
  }
  return { sql: `${column} IN (${ids.map(() => "?").join(",")})`, params: ids as any[] };
}

function idListDrizzle(column: any, ids: number[]) {
  if (ids.length > LONG_ID_LIST && getDatabaseKind() === "sqlite") {
    return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  }
  return sql`${column} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

// ==================== Host Metrics Queries ====================

export async function insertHostMetric(metric: InsertHostMetric) {
  const db = await getDb();
  if (!db) return;
  await db.insert(hostMetrics).values(metric);
}

export async function cleanOldHostMetrics(retainHours: number = 72) {
  const db = await getDb();
  if (!db) return;
  const cutoff = retentionCutoffSeconds(retainHours);
  await deleteExpiredHistoryRows("host_metrics", "recordedAt", cutoff);
}

export async function getLatestHostMetrics(hostId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(hostMetrics).where(eq(hostMetrics.hostId, hostId))
    .orderBy(desc(hostMetrics.recordedAt), desc(hostMetrics.id)).limit(limit);
}

export async function getLatestHostMetricRows(hostIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const ids = Array.from(new Set((hostIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return [];
  const rows = await queryLatestHostMetricRows(ids, [
    "id", "hostId", "cpuUsage", "memoryUsage", "memoryUsed", "swapUsage",
    "swapUsed", "swapTotal", "networkIn", "networkOut", "diskUsage",
    "diskUsed", "diskTotal", "uptime", "tcpConnections", "udpConnections", "recordedAt",
  ]).catch(() => []);
  const mapped = (rows as any[])
    .map((row) => ({
      id: Number(row?.id || 0),
      hostId: Number(row?.hostId || 0),
      cpuUsage: row?.cpuUsage == null ? null : numeric(row.cpuUsage),
      memoryUsage: row?.memoryUsage == null ? null : numeric(row.memoryUsage),
      memoryUsed: row?.memoryUsed == null ? null : numeric(row.memoryUsed),
      swapUsage: row?.swapUsage == null ? null : numeric(row.swapUsage),
      swapUsed: row?.swapUsed == null ? null : numeric(row.swapUsed),
      swapTotal: row?.swapTotal == null ? null : numeric(row.swapTotal),
      networkIn: row?.networkIn == null ? null : numeric(row.networkIn),
      networkOut: row?.networkOut == null ? null : numeric(row.networkOut),
      diskUsage: row?.diskUsage == null ? null : numeric(row.diskUsage),
      diskUsed: row?.diskUsed == null ? null : numeric(row.diskUsed),
      diskTotal: row?.diskTotal == null ? null : numeric(row.diskTotal),
      uptime: row?.uptime == null ? null : numeric(row.uptime),
      tcpConnections: row?.tcpConnections == null ? null : numeric(row.tcpConnections),
      udpConnections: row?.udpConnections == null ? null : numeric(row.udpConnections),
      recordedAt: rowDate(row?.recordedAt),
      rn: Math.max(1, Math.floor(Number(row?.rn || 0))),
    }))
    .filter((row) => row.hostId > 0);
  const byHost = new Map<number, typeof mapped>();
  for (const row of mapped) {
    const bucket = byHost.get(row.hostId);
    if (bucket) bucket.push(row);
    else byHost.set(row.hostId, [row]);
  }
  return Array.from(byHost.values()).map((bucket) => {
    const sorted = bucket.sort((a, b) => a.rn - b.rn);
    const latest = sorted[0];
    const previous = sorted[1];
    if (!latest) return null;
    let networkSpeedIn: number | null = null;
    let networkSpeedOut: number | null = null;
    if (latest && previous) {
      const elapsedSeconds = Math.max(1, (latest.recordedAt.getTime() - previous.recordedAt.getTime()) / 1000);
      networkSpeedIn = Math.max(0, numeric(latest.networkIn) - numeric(previous.networkIn)) / elapsedSeconds;
      networkSpeedOut = Math.max(0, numeric(latest.networkOut) - numeric(previous.networkOut)) / elapsedSeconds;
    }
    return {
      ...latest,
      networkSpeedIn,
      networkSpeedOut,
    };
  }).filter(Boolean);
}

/**
 * 这几台主机此刻的连接数加起来：每台只取最新一条上报，TCP / UDP 分开加。
 *
 * 给首页「连接」那一格用。调用方负责只传在线的主机 —— 掉线机器最后一次报的数
 * 不是「此刻」，加进去总数就虚了（和 useHostVitals 里 CPU 离线回 null 是同一条理由）。
 * 旧 Agent 没报（null）的按 0 算，reported 记录有几台真的报了：一台都没报就不画这一格。
 */
export async function sumLatestHostConnections(hostIds: number[]) {
  const empty = { tcp: 0, udp: 0, reported: 0 };
  const db = await getDb();
  if (!db) return empty;
  const ids = Array.from(new Set((hostIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return empty;
  const rows = await queryLatestHostMetricRows(
    ids,
    ["id", "hostId", "tcpConnections", "udpConnections", "recordedAt"],
  ).catch(() => []);
  const total = { ...empty };
  for (const row of rows as any[]) {
    if (Number(row?.rn || 0) !== 1) continue;
    const tcp = row?.tcpConnections == null ? null : numeric(row.tcpConnections);
    const udp = row?.udpConnections == null ? null : numeric(row.udpConnections);
    if (tcp === null && udp === null) continue;
    total.reported += 1;
    total.tcp += Math.max(0, tcp ?? 0);
    total.udp += Math.max(0, udp ?? 0);
  }
  return total;
}

type LatestHostMetricSnapshot = {
  id: number;
  hostId: number;
  networkIn: number;
  networkOut: number;
  recordedAt: Date;
  rn: number;
};

function mapLatestHostMetricSnapshot(row: any): LatestHostMetricSnapshot {
  return {
    id: Number(row?.id || 0),
    hostId: Number(row?.hostId || 0),
    networkIn: numeric(row?.networkIn),
    networkOut: numeric(row?.networkOut),
    recordedAt: rowDate(row?.recordedAt),
    rn: Math.max(1, Math.floor(Number(row?.rn || 0))),
  };
}

export async function getLatestHostMetricSnapshots(hostIds?: number[]) {
  const db = await getDb();
  if (!db) return [] as LatestHostMetricSnapshot[];
  const ids = Array.from(new Set((hostIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return [];
  const rows = await queryLatestHostMetricRows(
    ids,
    ["id", "hostId", "networkIn", "networkOut", "recordedAt"],
  ).catch(() => []);
  return (rows as any[]).map(mapLatestHostMetricSnapshot).filter((row) => row.hostId > 0);
}

export function summarizeHostInstantTraffic(rows: LatestHostMetricSnapshot[]) {
  const byHost = new Map<number, LatestHostMetricSnapshot[]>();
  for (const row of rows) {
    const bucket = byHost.get(row.hostId);
    if (bucket) {
      bucket.push(row);
    } else {
      byHost.set(row.hostId, [row]);
    }
  }

  let currentTrafficIn = 0;
  let currentTrafficOut = 0;
  let measuredHosts = 0;

  for (const bucket of byHost.values()) {
    if (bucket.length < 2) continue;
    const [latest, previous] = bucket;
    const elapsedSeconds = Math.max(1, (new Date(latest.recordedAt).getTime() - new Date(previous.recordedAt).getTime()) / 1000);
    const inDelta = Math.max(0, Number(latest.networkIn || 0) - Number(previous.networkIn || 0));
    const outDelta = Math.max(0, Number(latest.networkOut || 0) - Number(previous.networkOut || 0));
    currentTrafficIn += inDelta / elapsedSeconds;
    currentTrafficOut += outDelta / elapsedSeconds;
    if (inDelta > 0 || outDelta > 0) measuredHosts += 1;
  }

  return {
    currentTrafficIn,
    currentTrafficOut,
    currentTrafficTotal: currentTrafficIn + currentTrafficOut,
    measuredHosts,
  };
}


type HostTrafficSample = {
  bytesIn?: number;
  bytesOut?: number;
  reportedAt?: Date;
};

export type HostTrafficMeasureMode = "outbound" | "both" | "max";

const hostTrafficBaselineCache = new Map<number, { bytesIn: number; bytesOut: number }>();

/** 洗上报值的规矩只有一份，见 shared/trafficCounterBytes：计费那一路也得用同一份。 */
const nonNegativeCounter = normalizeTrafficCounterBytes;

export function allocateHostTrafficCorrection(
  current: { bytesIn?: unknown; bytesOut?: unknown },
  usedBytes: unknown,
  measureMode: HostTrafficMeasureMode,
) {
  const bytesIn = nonNegativeCounter(current?.bytesIn);
  const bytesOut = nonNegativeCounter(current?.bytesOut);
  const target = nonNegativeCounter(usedBytes);

  if (measureMode === "outbound") {
    return { bytesIn, bytesOut: target };
  }

  if (measureMode === "max") {
    const currentMax = Math.max(bytesIn, bytesOut);
    if (currentMax === 0) return { bytesIn: 0, bytesOut: target };
    if (bytesIn >= bytesOut) {
      return { bytesIn: target, bytesOut: Math.min(target, Math.floor(target * (bytesOut / bytesIn))) };
    }
    return { bytesIn: Math.min(target, Math.floor(target * (bytesIn / bytesOut))), bytesOut: target };
  }

  const currentTotal = bytesIn + bytesOut;
  if (currentTotal === 0) return { bytesIn: 0, bytesOut: target };
  const correctedIn = Math.min(target, Math.floor(target * (bytesIn / currentTotal)));
  return { bytesIn: correctedIn, bytesOut: target - correctedIn };
}

function nullableRowDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (value instanceof Date) return value;
  return new Date(n * 1000);
}

function zeroHostTraffic(hostId: number) {
  return {
    id: 0,
    hostId,
    bytesIn: 0,
    bytesOut: 0,
    lastSystemIn: null as number | null,
    lastSystemOut: null as number | null,
    lastDeltaIn: 0,
    lastDeltaOut: 0,
    lastReportedAt: null as Date | null,
    resetAt: null as Date | null,
    createdAt: null as Date | null,
    updatedAt: null as Date | null,
  };
}

function mapHostTrafficRow(row: any, fallbackHostId = 0) {
  const hostId = Number(row?.hostId || fallbackHostId || 0);
  return {
    id: Number(row?.id || 0),
    hostId,
    bytesIn: nonNegativeCounter(row?.bytesIn),
    bytesOut: nonNegativeCounter(row?.bytesOut),
    lastSystemIn: row?.lastSystemIn === null || row?.lastSystemIn === undefined ? null : nonNegativeCounter(row.lastSystemIn),
    lastSystemOut: row?.lastSystemOut === null || row?.lastSystemOut === undefined ? null : nonNegativeCounter(row.lastSystemOut),
    lastDeltaIn: nonNegativeCounter(row?.lastDeltaIn),
    lastDeltaOut: nonNegativeCounter(row?.lastDeltaOut),
    lastReportedAt: nullableRowDate(row?.lastReportedAt),
    resetAt: nullableRowDate(row?.resetAt),
    createdAt: nullableRowDate(row?.createdAt),
    updatedAt: nullableRowDate(row?.updatedAt),
  };
}

async function getHostTrafficRow(hostId: number) {
  const q = quoteIdentifier;
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("hostId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("lastSystemIn")}, ${q("lastSystemOut")}, ${q("lastDeltaIn")}, ${q("lastDeltaOut")}, ${q("lastReportedAt")}, ${q("resetAt")}, ${q("createdAt")}, ${q("updatedAt")}
       FROM ${q("host_traffic_counters")}
      WHERE ${q("hostId")} = ?
      LIMIT 1`,
    [hostId],
  ).catch(() => []);
  return rows[0] || null;
}

export async function recordHostTrafficSample(hostId: number, sample: HostTrafficSample) {
  const db = await getDb();
  if (!db) return null;
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return null;

  const systemIn = nonNegativeCounter(sample.bytesIn);
  const systemOut = nonNegativeCounter(sample.bytesOut);
  const now = sample.reportedAt || nowDate();
  const nowSec = epochSeconds(now);
  const q = quoteIdentifier;
  const table = q("host_traffic_counters");
  const previous = hostTrafficBaselineCache.get(id);
  const counterReset = !!previous && (systemIn < previous.bytesIn || systemOut < previous.bytesOut);
  if (counterReset) {
    appendPanelLog(
      "warn",
      `[HostTraffic] counter baseline reset host=${id} prevIn=${previous?.bytesIn ?? "-"} nextIn=${systemIn} prevOut=${previous?.bytesOut ?? "-"} nextOut=${systemOut}`,
    );
  }
  hostTrafficBaselineCache.set(id, { bytesIn: systemIn, bytesOut: systemOut });

  const cols = ["hostId", "bytesIn", "bytesOut", "lastSystemIn", "lastSystemOut", "lastDeltaIn", "lastDeltaOut", "lastReportedAt", "createdAt", "updatedAt"];
  const values = [id, 0, 0, systemIn, systemOut, 0, 0, nowSec, nowSec, nowSec];
  const kind = getDatabaseKind();
  if (kind === "mysql") {
    const incomingIn = `VALUES(${q("lastSystemIn")})`;
    const incomingOut = `VALUES(${q("lastSystemOut")})`;
    const deltaIn = `CASE WHEN ${q("lastSystemIn")} IS NOT NULL AND ${incomingIn} >= ${q("lastSystemIn")} THEN ${incomingIn} - ${q("lastSystemIn")} ELSE 0 END`;
    const deltaOut = `CASE WHEN ${q("lastSystemOut")} IS NOT NULL AND ${incomingOut} >= ${q("lastSystemOut")} THEN ${incomingOut} - ${q("lastSystemOut")} ELSE 0 END`;
    await executeRaw(
      `INSERT INTO ${table} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
       ON DUPLICATE KEY UPDATE
         ${q("bytesIn")} = ${q("bytesIn")} + ${deltaIn},
         ${q("bytesOut")} = ${q("bytesOut")} + ${deltaOut},
         ${q("lastDeltaIn")} = ${deltaIn},
         ${q("lastDeltaOut")} = ${deltaOut},
         ${q("lastSystemIn")} = ${incomingIn},
         ${q("lastSystemOut")} = ${incomingOut},
         ${q("lastReportedAt")} = VALUES(${q("lastReportedAt")}),
         ${q("updatedAt")} = VALUES(${q("updatedAt")})`,
      values,
    );
    await reconcileHostTrafficPolicy(id);
    return null;
  }

  const excluded = kind === "postgresql" ? "EXCLUDED" : "excluded";
  const current = (column: string) => kind === "postgresql" ? `${q("host_traffic_counters")}.${q(column)}` : q(column);
  const incoming = (column: string) => `${excluded}.${q(column)}`;
  const delta = (column: "In" | "Out") => (
    `CASE WHEN ${current(`lastSystem${column}`)} IS NOT NULL AND ${incoming(`lastSystem${column}`)} >= ${current(`lastSystem${column}`)}`
      + ` THEN ${incoming(`lastSystem${column}`)} - ${current(`lastSystem${column}`)} ELSE 0 END`
  );
  await executeRaw(
    `INSERT INTO ${table} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
     ON CONFLICT (${q("hostId")}) DO UPDATE SET
       ${q("bytesIn")} = ${current("bytesIn")} + ${delta("In")},
       ${q("bytesOut")} = ${current("bytesOut")} + ${delta("Out")},
       ${q("lastDeltaIn")} = ${delta("In")},
       ${q("lastDeltaOut")} = ${delta("Out")},
       ${q("lastSystemIn")} = ${incoming("lastSystemIn")},
       ${q("lastSystemOut")} = ${incoming("lastSystemOut")},
       ${q("lastReportedAt")} = ${incoming("lastReportedAt")},
       ${q("updatedAt")} = ${incoming("updatedAt")}`,
    values,
  );
  // 只有开了流量故障转移（或者还暂停着）的主机才会真的跑这一步，见 server/hostTrafficPolicy.ts。
  await reconcileHostTrafficPolicy(id);
  return null;
}

export async function getHostTraffic(hostId: number) {
  const db = await getDb();
  if (!db) return zeroHostTraffic(Number(hostId) || 0);
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return zeroHostTraffic(0);
  const row = await getHostTrafficRow(id);
  return row ? mapHostTrafficRow(row, id) : zeroHostTraffic(id);
}

export async function getHostTrafficSummary(hostIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const hasHostFilter = Array.isArray(hostIds);
  const ids = Array.from(new Set((hostIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (hasHostFilter && ids.length === 0) return [];
  const q = quoteIdentifier;
  const where = hasHostFilter ? `WHERE ${q("hostId")} IN (${ids.map(() => "?").join(",")})` : "";
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("hostId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("lastSystemIn")}, ${q("lastSystemOut")}, ${q("lastDeltaIn")}, ${q("lastDeltaOut")}, ${q("lastReportedAt")}, ${q("resetAt")}, ${q("createdAt")}, ${q("updatedAt")}
       FROM ${q("host_traffic_counters")}
      ${where}
      ORDER BY ${q("hostId")} ASC`,
    ids,
  ).catch(() => []);
  const mapped = (rows as any[]).map((row) => mapHostTrafficRow(row));
  if (!hasHostFilter) return mapped;
  const byHost = new Map(mapped.map((row) => [row.hostId, row]));
  return ids.map((id) => byHost.get(id) || zeroHostTraffic(id));
}

export async function resetHostTraffic(hostId: number) {
  const db = await getDb();
  if (!db) return zeroHostTraffic(Number(hostId) || 0);
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return zeroHostTraffic(0);
  const nowSec = epochSeconds(nowDate());
  const q = quoteIdentifier;
  const table = q("host_traffic_counters");
  const existing = await getHostTrafficRow(id);
  if (existing) {
    await executeRaw(
      `UPDATE ${table}
          SET ${q("bytesIn")} = 0,
              ${q("bytesOut")} = 0,
              ${q("lastDeltaIn")} = 0,
              ${q("lastDeltaOut")} = 0,
              ${q("resetAt")} = ?,
              ${q("updatedAt")} = ?
        WHERE ${q("hostId")} = ?`,
      [nowSec, nowSec, id],
    );
    await reconcileHostTrafficPolicy(id);
    return getHostTraffic(id);
  }
  const cols = ["hostId", "bytesIn", "bytesOut", "lastDeltaIn", "lastDeltaOut", "resetAt", "createdAt", "updatedAt"];
  await executeRaw(
    `INSERT INTO ${table} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    [id, 0, 0, 0, 0, nowSec, nowSec, nowSec],
  ).catch(() => undefined);
  await reconcileHostTrafficPolicy(id);
  return getHostTraffic(id);
}

export async function correctHostTraffic(
  hostId: number,
  usedBytes: number,
  measureMode: HostTrafficMeasureMode,
) {
  const db = await getDb();
  if (!db) return zeroHostTraffic(Number(hostId) || 0);
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return zeroHostTraffic(0);

  const existing = await getHostTrafficRow(id);
  const corrected = allocateHostTrafficCorrection(existing || {}, usedBytes, measureMode);
  const nowSec = epochSeconds(nowDate());
  const q = quoteIdentifier;
  const table = q("host_traffic_counters");
  const columns = ["hostId", "bytesIn", "bytesOut", "lastDeltaIn", "lastDeltaOut", "createdAt", "updatedAt"];
  const values = [id, corrected.bytesIn, corrected.bytesOut, 0, 0, nowSec, nowSec];
  const kind = getDatabaseKind();

  if (kind === "mysql") {
    await executeRaw(
      `INSERT INTO ${table} (${columns.map(q).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
       ON DUPLICATE KEY UPDATE
         ${q("bytesIn")} = VALUES(${q("bytesIn")}),
         ${q("bytesOut")} = VALUES(${q("bytesOut")}),
         ${q("lastDeltaIn")} = 0,
         ${q("lastDeltaOut")} = 0,
         ${q("updatedAt")} = VALUES(${q("updatedAt")})`,
      values,
    );
  } else {
    const excluded = kind === "postgresql" ? "EXCLUDED" : "excluded";
    await executeRaw(
      `INSERT INTO ${table} (${columns.map(q).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT (${q("hostId")}) DO UPDATE SET
         ${q("bytesIn")} = ${excluded}.${q("bytesIn")},
         ${q("bytesOut")} = ${excluded}.${q("bytesOut")},
         ${q("lastDeltaIn")} = 0,
         ${q("lastDeltaOut")} = 0,
         ${q("updatedAt")} = ${excluded}.${q("updatedAt")}`,
      values,
    );
  }

  await reconcileHostTrafficPolicy(id);
  return getHostTraffic(id);
}
// ==================== Traffic Stats Queries ====================

export type TrafficStatBatchItem = {
  stat: InsertTrafficStat;
  userId: number;
};

const TRAFFIC_WRITE_BATCH_ROWS = 64;

function rowBatches<T>(rows: T[]) {
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += TRAFFIC_WRITE_BATCH_ROWS) {
    batches.push(rows.slice(index, index + TRAFFIC_WRITE_BATCH_ROWS));
  }
  return batches;
}

async function executeBulkRows(tableName: string, columns: string[], rows: any[][], suffix = "") {
  if (rows.length === 0) return;
  const q = quoteIdentifier;
  for (const batch of rowBatches(rows)) {
    const placeholders = batch
      .map(() => `(${columns.map(() => "?").join(", ")})`)
      .join(", ");
    await executeRaw(
      `INSERT INTO ${q(tableName)} (${columns.map(q).join(", ")}) VALUES ${placeholders}${suffix}`,
      batch.flat(),
    );
  }
}

type AggregatedTrafficRow = {
  ruleId: number;
  hostId: number;
  userId: number;
  bytesIn: number;
  bytesOut: number;
  connections: number;
  recordedAt: Date;
};

function aggregateTrafficBatch(items: TrafficStatBatchItem[]) {
  const rawRows: AggregatedTrafficRow[] = [];
  const countersByRuleHost = new Map<string, AggregatedTrafficRow>();
  const now = nowDate();
  for (const item of items) {
    const ruleId = Math.floor(Number(item.stat.ruleId || 0));
    const hostId = Math.floor(Number(item.stat.hostId || 0));
    if (ruleId <= 0 || hostId <= 0) continue;
    const row: AggregatedTrafficRow = {
      ruleId,
      hostId,
      userId: Math.max(0, Math.floor(Number(item.userId || 0))),
      bytesIn: nonNegativeCounter(item.stat.bytesIn),
      bytesOut: nonNegativeCounter(item.stat.bytesOut),
      connections: Math.max(0, Math.floor(numeric(item.stat.connections))),
      recordedAt: item.stat.recordedAt instanceof Date ? item.stat.recordedAt : now,
    };
    rawRows.push(row);
    if (row.userId <= 0 || (row.bytesIn <= 0 && row.bytesOut <= 0 && row.connections <= 0)) continue;
    const key = `${row.ruleId}:${row.hostId}`;
    const aggregate = countersByRuleHost.get(key);
    if (aggregate) {
      aggregate.userId = row.userId;
      aggregate.bytesIn += row.bytesIn;
      aggregate.bytesOut += row.bytesOut;
      aggregate.connections += row.connections;
      if (row.recordedAt > aggregate.recordedAt) aggregate.recordedAt = row.recordedAt;
    } else {
      countersByRuleHost.set(key, { ...row });
    }
  }
  return { rawRows, counterRows: Array.from(countersByRuleHost.values()) };
}

async function upsertUserTrafficCountersBatch(rows: AggregatedTrafficRow[]) {
  const byUser = new Map<number, { userId: number; bytesIn: number; bytesOut: number; connections: number }>();
  for (const row of rows) {
    const aggregate = byUser.get(row.userId) || { userId: row.userId, bytesIn: 0, bytesOut: 0, connections: 0 };
    aggregate.bytesIn += row.bytesIn;
    aggregate.bytesOut += row.bytesOut;
    aggregate.connections += row.connections;
    byUser.set(row.userId, aggregate);
  }
  const values = Array.from(byUser.values());
  if (values.length === 0) return;
  const q = quoteIdentifier;
  const nowSec = epochSeconds(nowDate());
  const columns = ["userId", "bytesIn", "bytesOut", "connections", "createdAt", "updatedAt"];
  const kind = getDatabaseKind();
  const suffix = kind === "mysql"
    ? ` ON DUPLICATE KEY UPDATE
         ${q("bytesIn")} = ${q("bytesIn")} + VALUES(${q("bytesIn")}),
         ${q("bytesOut")} = ${q("bytesOut")} + VALUES(${q("bytesOut")}),
         ${q("connections")} = ${q("connections")} + VALUES(${q("connections")}),
         ${q("updatedAt")} = VALUES(${q("updatedAt")})`
    : ` ON CONFLICT (${q("userId")}) DO UPDATE SET
         ${q("bytesIn")} = ${kind === "postgresql" ? `${q("user_traffic_counters")}.${q("bytesIn")}` : q("bytesIn")} + ${kind === "postgresql" ? "EXCLUDED" : "excluded"}.${q("bytesIn")},
         ${q("bytesOut")} = ${kind === "postgresql" ? `${q("user_traffic_counters")}.${q("bytesOut")}` : q("bytesOut")} + ${kind === "postgresql" ? "EXCLUDED" : "excluded"}.${q("bytesOut")},
         ${q("connections")} = ${kind === "postgresql" ? `${q("user_traffic_counters")}.${q("connections")}` : q("connections")} + ${kind === "postgresql" ? "EXCLUDED" : "excluded"}.${q("connections")},
         ${q("updatedAt")} = ${kind === "postgresql" ? "EXCLUDED" : "excluded"}.${q("updatedAt")}`;
  await executeBulkRows("user_traffic_counters", columns, values.map((row) => [
    row.userId,
    row.bytesIn,
    row.bytesOut,
    row.connections,
    nowSec,
    nowSec,
  ]), suffix);
}

async function upsertForwardRuleTrafficCountersBatch(rows: AggregatedTrafficRow[]) {
  if (rows.length === 0) return;
  const q = quoteIdentifier;
  const nowSec = epochSeconds(nowDate());
  const columns = ["ruleId", "hostId", "userId", "bytesIn", "bytesOut", "connections", "createdAt", "updatedAt"];
  const kind = getDatabaseKind();
  const excluded = kind === "postgresql" ? "EXCLUDED" : "excluded";
  const current = (column: string) => kind === "postgresql" ? `${q("forward_rule_traffic_counters")}.${q(column)}` : q(column);
  const suffix = kind === "mysql"
    ? ` ON DUPLICATE KEY UPDATE
         ${q("userId")} = VALUES(${q("userId")}),
         ${q("bytesIn")} = ${q("bytesIn")} + VALUES(${q("bytesIn")}),
         ${q("bytesOut")} = ${q("bytesOut")} + VALUES(${q("bytesOut")}),
         ${q("connections")} = ${q("connections")} + VALUES(${q("connections")}),
         ${q("updatedAt")} = VALUES(${q("updatedAt")})`
    : ` ON CONFLICT (${q("ruleId")}, ${q("hostId")}) DO UPDATE SET
         ${q("userId")} = ${excluded}.${q("userId")},
         ${q("bytesIn")} = ${current("bytesIn")} + ${excluded}.${q("bytesIn")},
         ${q("bytesOut")} = ${current("bytesOut")} + ${excluded}.${q("bytesOut")},
         ${q("connections")} = ${current("connections")} + ${excluded}.${q("connections")},
         ${q("updatedAt")} = ${excluded}.${q("updatedAt")}`;
  await executeBulkRows("forward_rule_traffic_counters", columns, rows.map((row) => [
    row.ruleId,
    row.hostId,
    row.userId,
    row.bytesIn,
    row.bytesOut,
    row.connections,
    nowSec,
    nowSec,
  ]), suffix);
}

async function upsertTrafficStatBucketsBatch(rows: AggregatedTrafficRow[]) {
  if (rows.length === 0) return;
  const byBucket = new Map<string, AggregatedTrafficRow & { bucketStart: number }>();
  for (const row of rows) {
    const bucketStart = bucketStartFor(epochSeconds(row.recordedAt));
    const key = `${bucketStart}:${row.ruleId}:${row.hostId}`;
    const aggregate = byBucket.get(key);
    if (aggregate) {
      aggregate.userId = row.userId;
      aggregate.bytesIn += row.bytesIn;
      aggregate.bytesOut += row.bytesOut;
      aggregate.connections += row.connections;
    } else {
      byBucket.set(key, { ...row, bucketStart });
    }
  }
  const q = quoteIdentifier;
  const nowSec = epochSeconds(nowDate());
  const columns = ["bucketStart", "bucketMinutes", "userId", "ruleId", "hostId", "bytesIn", "bytesOut", "connections", "updatedAt"];
  const kind = getDatabaseKind();
  const excluded = kind === "postgresql" ? "EXCLUDED" : "excluded";
  const current = (column: string) => kind === "postgresql" ? `${q("traffic_stat_buckets")}.${q(column)}` : q(column);
  const suffix = kind === "mysql"
    ? ` ON DUPLICATE KEY UPDATE
         ${q("userId")} = VALUES(${q("userId")}),
         ${q("bytesIn")} = ${q("bytesIn")} + VALUES(${q("bytesIn")}),
         ${q("bytesOut")} = ${q("bytesOut")} + VALUES(${q("bytesOut")}),
         ${q("connections")} = ${q("connections")} + VALUES(${q("connections")}),
         ${q("updatedAt")} = VALUES(${q("updatedAt")})`
    : ` ON CONFLICT (${q("bucketStart")}, ${q("bucketMinutes")}, ${q("ruleId")}, ${q("hostId")}) DO UPDATE SET
         ${q("userId")} = ${excluded}.${q("userId")},
         ${q("bytesIn")} = ${current("bytesIn")} + ${excluded}.${q("bytesIn")},
         ${q("bytesOut")} = ${current("bytesOut")} + ${excluded}.${q("bytesOut")},
         ${q("connections")} = ${current("connections")} + ${excluded}.${q("connections")},
         ${q("updatedAt")} = ${excluded}.${q("updatedAt")}`;
  await executeBulkRows("traffic_stat_buckets", columns, Array.from(byBucket.values()).map((row) => [
    row.bucketStart,
    TRAFFIC_BUCKET_MINUTES,
    row.userId,
    row.ruleId,
    row.hostId,
    row.bytesIn,
    row.bytesOut,
    row.connections,
    nowSec,
  ]), suffix);
}

export async function insertTrafficStatsBatch(items: TrafficStatBatchItem[]) {
  const db = await getDb();
  if (!db || items.length === 0) return { samples: 0, counters: 0, users: 0 };
  const { rawRows, counterRows } = aggregateTrafficBatch(items);
  if (rawRows.length === 0) return { samples: 0, counters: 0, users: 0 };
  await executeBulkRows("traffic_stats", ["ruleId", "hostId", "bytesIn", "bytesOut", "connections", "recordedAt"], rawRows.map((row) => [
    row.ruleId,
    row.hostId,
    row.bytesIn,
    row.bytesOut,
    row.connections,
    row.recordedAt,
  ]));
  try {
    await upsertUserTrafficCountersBatch(counterRows);
    await upsertForwardRuleTrafficCountersBatch(counterRows);
  } catch (error) {
    const first = counterRows[0];
    warnUserTrafficCounterOnce(error, { ruleId: first?.ruleId, userId: first?.userId });
    throw error;
  }
  try {
    await upsertTrafficStatBucketsBatch(counterRows);
  } catch (error) {
    const first = counterRows[0];
    warnTrafficBucketOnce(error, { ruleId: first?.ruleId, hostId: first?.hostId, userId: first?.userId });
    throw error;
  }
  return {
    samples: rawRows.length,
    counters: counterRows.length,
    users: new Set(counterRows.map((row) => row.userId)).size,
  };
}

/** Claim a traffic report once per producer so network retries cannot bill it twice. */
export async function claimAgentTrafficReport(hostId: number, reportId: string, producerId = "") {
  const id = Math.floor(Number(hostId) || 0);
  const key = String(reportId || "").trim().slice(0, 128);
  const producer = String(producerId || "").trim().slice(0, 128);
  if (id <= 0 || !key) return true;
  const q = quoteIdentifier;
  const nowSec = epochSeconds(nowDate());
  const kind = getDatabaseKind();
  if (!producer) {
    // Compatibility for the short-lived reportId-only protocol. Released
    // Agents before idempotent reporting do not send a reportId at all.
    const legacySql = kind === "mysql"
      ? `INSERT IGNORE INTO ${q("agent_traffic_reports")} (${q("hostId")}, ${q("reportId")}, ${q("receivedAt")}) VALUES (?, ?, ?)`
      : `INSERT INTO ${q("agent_traffic_reports")} (${q("hostId")}, ${q("reportId")}, ${q("receivedAt")}) VALUES (?, ?, ?)
         ON CONFLICT (${q("hostId")}, ${q("reportId")}) DO NOTHING`;
    const inserted = rawAffectedRows(await executeRaw(legacySql, [id, key, nowSec])) > 0;
    if (!inserted) {
      await executeRaw(
        `UPDATE ${q("agent_traffic_reports")} SET ${q("receivedAt")} = ? WHERE ${q("hostId")} = ? AND ${q("reportId")} = ?`,
        [nowSec, id, key],
      );
    }
    return inserted;
  }

  const insertSql = kind === "mysql"
    ? `INSERT IGNORE INTO ${q("agent_traffic_reports")} (${q("hostId")}, ${q("producerId")}, ${q("reportId")}, ${q("receivedAt")}) VALUES (?, ?, ?, ?)`
    : `INSERT INTO ${q("agent_traffic_reports")} (${q("hostId")}, ${q("producerId")}, ${q("reportId")}, ${q("receivedAt")}) VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`;
  const inserted = await executeRaw(insertSql, [id, producer, key, nowSec]);
  if (rawAffectedRows(inserted) > 0) return true;

  // Producers send one frozen batch at a time. Replacing the producer head is
  // therefore a new batch; the same ID (including a concurrent retry) is a
  // duplicate. The conditional update keeps that decision atomic on every DB.
  const updated = await executeRaw(
    `UPDATE ${q("agent_traffic_reports")}
        SET ${q("reportId")} = ?, ${q("receivedAt")} = ?
      WHERE ${q("hostId")} = ? AND ${q("producerId")} = ? AND ${q("reportId")} <> ?`,
    [key, nowSec, id, producer, key],
  );
  if (rawAffectedRows(updated) > 0) return true;
  await executeRaw(
    `UPDATE ${q("agent_traffic_reports")} SET ${q("receivedAt")} = ? WHERE ${q("hostId")} = ? AND ${q("producerId")} = ? AND ${q("reportId")} = ?`,
    [nowSec, id, producer, key],
  );
  return false;
}

export async function cleanOldTrafficStats(retainHours: number = 72) {
  const db = await getDb();
  if (!db) return;
  const cutoff = retentionCutoffSeconds(retainHours);
  const reportCutoff = retentionCutoffSeconds(Math.max(retainHours, LEGACY_TRAFFIC_REPORT_RETENTION_HOURS));
  await deleteExpiredHistoryRows("agent_traffic_reports", "receivedAt", reportCutoff, {
    whereSql: `${quoteIdentifier("producerId")} IS NULL`,
  }).catch(() => undefined);
  const billingBackfilled = await getSetting(TRAFFIC_BILLING_RULE_USAGE_BACKFILL_SETTING).catch(() => null);
  if (!billingBackfilled) return;
  await deleteExpiredHistoryRows("traffic_stats", "recordedAt", cutoff);
}

async function tableRowCount(tableName: string) {
  const q = quoteIdentifier;
  const rows = await queryRaw<any>(
    `SELECT COUNT(*) AS ${q("count")} FROM ${q(tableName)}`,
  ).catch(() => []);
  return Number(rows[0]?.count || 0);
}

async function getCounterUserIdsForRuleIds(ruleIds: number[]) {
  const ids = Array.from(new Set(ruleIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const result = new Set<number>();
  if (ids.length === 0) return [];
  const q = quoteIdentifier;
  for (let index = 0; index < ids.length; index += 500) {
    const batch = ids.slice(index, index + 500);
    const rows = await queryRaw<any>(
      `SELECT DISTINCT ${q("userId")} FROM ${q("forward_rule_traffic_counters")}
        WHERE ${q("ruleId")} IN (${batch.map(() => "?").join(",")})`,
      batch,
    ).catch(() => []);
    for (const row of rows as any[]) {
      const userId = Number(row.userId || 0);
      if (Number.isInteger(userId) && userId > 0) result.add(userId);
    }
  }
  return Array.from(result);
}

async function rebuildUserTrafficCountersFromRuleCounters(userIds?: number[]) {
  const ids = Array.from(new Set((userIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const q = quoteIdentifier;
  const nowSec = epochSeconds(nowDate());
  if (ids.length > 0) {
    await executeRaw(
      `DELETE FROM ${q("user_traffic_counters")}
        WHERE ${q("userId")} IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
  } else {
    await executeRaw(`DELETE FROM ${q("user_traffic_counters")}`);
  }
  const where = ids.length > 0
    ? `WHERE ${q("userId")} IN (${ids.map(() => "?").join(",")})`
    : "";
  const result = await executeRaw(
    `INSERT INTO ${q("user_traffic_counters")}
       (${q("userId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("createdAt")}, ${q("updatedAt")})
     SELECT ${q("userId")} AS ${q("userId")},
            COALESCE(SUM(${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(${q("bytesOut")}), 0) AS ${q("bytesOut")},
            COALESCE(SUM(${q("connections")}), 0) AS ${q("connections")},
            ? AS ${q("createdAt")},
            ? AS ${q("updatedAt")}
       FROM ${q("forward_rule_traffic_counters")}
      ${where}
      GROUP BY ${q("userId")}`,
    [nowSec, nowSec, ...ids],
  );
  return rawAffectedRows(result);
}

async function repairTrafficCounterOwnership() {
  const db = await getDb();
  if (!db) return { counterRows: 0, bucketRows: 0 };
  const ruleRows = await db.select({
    id: forwardRules.id,
    userId: forwardRules.userId,
    groupId: forwardRules.forwardGroupId,
    parentRuleId: forwardRules.forwardGroupRuleId,
    isTemplate: forwardRules.isForwardGroupTemplate,
  }).from(forwardRules);
  const ruleById = new Map<number, { userId: number; groupId: number; isTemplate: boolean }>();
  for (const row of ruleRows as any[]) {
    const id = Number(row.id || 0);
    const userId = Number(row.userId || 0);
    if (id > 0 && userId > 0) {
      ruleById.set(id, {
        userId,
        groupId: Number(row.groupId || 0),
        isTemplate: row.isTemplate === true || row.isTemplate === 1 || row.isTemplate === "1",
      });
    }
  }

  const ruleIdsByOwner = new Map<number, number[]>();
  for (const row of ruleRows as any[]) {
    const ruleId = Number(row.id || 0);
    const parentRuleId = Number(row.parentRuleId || 0);
    const groupId = Number(row.groupId || 0);
    const parent = ruleById.get(parentRuleId);
    const ownerId = parent?.isTemplate && parent.groupId > 0 && parent.groupId === groupId
      ? parent.userId
      : Number(row.userId || 0);
    if (ruleId <= 0 || ownerId <= 0) continue;
    const ids = ruleIdsByOwner.get(ownerId) || [];
    ids.push(ruleId);
    ruleIdsByOwner.set(ownerId, ids);
  }

  const q = quoteIdentifier;
  let counterRows = 0;
  let bucketRows = 0;
  for (const [ownerId, ruleIds] of ruleIdsByOwner) {
    for (let index = 0; index < ruleIds.length; index += 500) {
      const batch = ruleIds.slice(index, index + 500);
      const placeholders = batch.map(() => "?").join(",");
      const params = [ownerId, ...batch, ownerId];
      counterRows += rawAffectedRows(await executeRaw(
        `UPDATE ${q("forward_rule_traffic_counters")}
            SET ${q("userId")} = ?
          WHERE ${q("ruleId")} IN (${placeholders}) AND ${q("userId")} <> ?`,
        params,
      ));
      bucketRows += rawAffectedRows(await executeRaw(
        `UPDATE ${q("traffic_stat_buckets")}
            SET ${q("userId")} = ?
          WHERE ${q("ruleId")} IN (${placeholders}) AND ${q("userId")} <> ?`,
        params,
      ));
    }
  }
  return { counterRows, bucketRows };
}

export async function getTrafficStats(ruleId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  const rule = await getRuleWithCreatedAt(ruleId);
  const { queryRuleIds, parentByChildRuleId } = await expandTrafficQueryRuleIds([ruleId]);
  const effectiveRuleIds = queryRuleIds.length > 0 ? queryRuleIds : [ruleId];
  const q = quoteIdentifier;
  const conditions = [`${q("ruleId")} IN (${effectiveRuleIds.map(() => "?").join(",")})`];
  const params: any[] = [...effectiveRuleIds];
  if (rule?.createdAt) {
    conditions.push(`${q("recordedAt")} >= ?`);
    params.push(epochSeconds(rule.createdAt));
  }
  const limitSql = limitOffset(clampPositiveInt(limit, 60, 500));
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("ruleId")}, ${q("hostId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("recordedAt")}
       FROM ${q("traffic_stats")}
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${q("recordedAt")} DESC
      ${limitSql.sql}`,
    [...params, ...limitSql.params],
  );
  return rows.map((row) => ({
    ...row,
    ruleId: parentByChildRuleId.get(Number(row.ruleId)) || Number(row.ruleId),
    recordedAt: rowDate(row.recordedAt),
  }));
}

export async function resetRuleTrafficStats(ruleIds: number[]) {
  const db = await getDb();
  if (!db) return { requestedRuleIds: [], clearedRuleIds: [], deletedStats: 0, deletedBuckets: 0, deletedCounters: 0, deletedTcping: 0, deletedForwardTests: 0, deletedGroupLatency: 0 };
  const requestedRuleIds = Array.from(new Set(ruleIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (requestedRuleIds.length === 0) {
    return { requestedRuleIds: [], clearedRuleIds: [], deletedStats: 0, deletedBuckets: 0, deletedCounters: 0, deletedTcping: 0, deletedForwardTests: 0, deletedGroupLatency: 0 };
  }
  const { queryRuleIds } = await expandTrafficQueryRuleIds(requestedRuleIds);
  const clearedRuleIds = queryRuleIds.length > 0 ? queryRuleIds : requestedRuleIds;
  const q = quoteIdentifier;
  const affectedCounterUserIds = await getCounterUserIdsForRuleIds(clearedRuleIds);
  let deletedStats = 0;
  let deletedBuckets = 0;
  let deletedCounters = 0;
  let deletedTcping = 0;
  let deletedForwardTests = 0;
  let deletedGroupLatency = 0;
  for (let index = 0; index < clearedRuleIds.length; index += 500) {
    const batch = clearedRuleIds.slice(index, index + 500);
    const placeholders = batch.map(() => "?").join(",");
    const statsResult = await executeRaw(
      `DELETE FROM ${q("traffic_stats")} WHERE ${q("ruleId")} IN (${placeholders})`,
      batch,
    );
    const bucketsResult = await executeRaw(
      `DELETE FROM ${q("traffic_stat_buckets")} WHERE ${q("ruleId")} IN (${placeholders})`,
      batch,
    );
    const countersResult = await executeRaw(
      `DELETE FROM ${q("forward_rule_traffic_counters")} WHERE ${q("ruleId")} IN (${placeholders})`,
      batch,
    );
    const tcpingResult = await executeRaw(
      `DELETE FROM ${q("tcping_stats")} WHERE ${q("ruleId")} IN (${placeholders})`,
      batch,
    );
    const forwardTestsResult = await executeRaw(
      `DELETE FROM ${q("forward_tests")} WHERE ${q("ruleId")} IN (${placeholders})`,
      batch,
    );
    deletedStats += rawAffectedRows(statsResult);
    deletedBuckets += rawAffectedRows(bucketsResult);
    deletedCounters += rawAffectedRows(countersResult);
    deletedTcping += rawAffectedRows(tcpingResult);
    deletedForwardTests += rawAffectedRows(forwardTestsResult);
  }
  if (affectedCounterUserIds.length > 0) {
    await rebuildUserTrafficCountersFromRuleCounters(affectedCounterUserIds).catch((error) => {
      console.warn("[TrafficCounter] User counter rebuild after rule reset skipped:", error instanceof Error ? error.message : String(error));
    });
  }
  if (clearedRuleIds.length > 0) {
    const forwardGroupIds = Array.from(new Set((await queryRaw<any>(
      `SELECT DISTINCT ${q("forwardGroupId")} AS ${q("forwardGroupId")}
         FROM ${q("forward_rules")}
        WHERE ${q("id")} IN (${clearedRuleIds.map(() => "?").join(",")})
          AND ${q("forwardGroupId")} IS NOT NULL`,
      clearedRuleIds,
    )).map((row: any) => Number(row.forwardGroupId)).filter((id: number) => Number.isInteger(id) && id > 0)));
    for (let index = 0; index < forwardGroupIds.length; index += 500) {
      const batch = forwardGroupIds.slice(index, index + 500);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(",");
      const groupLatencyResult = await executeRaw(
        `DELETE FROM ${q("forward_group_latency_stats")} WHERE ${q("groupId")} IN (${placeholders})`,
        batch,
      );
      deletedGroupLatency += rawAffectedRows(groupLatencyResult);
    }
  }
  return {
    requestedRuleIds,
    clearedRuleIds,
    deletedStats,
    deletedBuckets,
    deletedCounters,
    deletedTcping,
    deletedForwardTests,
    deletedGroupLatency,
  };
}

async function getRuleIdsByUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: forwardRules.id }).from(forwardRules).where(eq(forwardRules.userId, userId));
  return rows.map((r: { id: unknown }) => Number(r.id));
}

async function getRuleWithCreatedAt(ruleId: number): Promise<{ id: number; createdAt: Date } | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ id: forwardRules.id, createdAt: forwardRules.createdAt })
    .from(forwardRules)
    .where(eq(forwardRules.id, ruleId))
    .limit(1);
  const row = rows[0] as any;
  return row ? { id: Number(row.id), createdAt: row.createdAt } : null;
}

async function getRuleUserId(ruleId: number) {
  const q = quoteIdentifier;
  const rows = await queryRaw<{ userId: number }>(
    `SELECT COALESCE(parent.${q("userId")}, fr.${q("userId")}) AS ${q("userId")}
       FROM ${q("forward_rules")} fr
       ${managedParentRuleJoin("fr")}
      WHERE fr.${q("id")} = ?`,
    [ruleId],
  );
  return Number((rows[0] as any)?.userId || 0);
}

let trafficBucketsReadyState: boolean | null = null;

async function trafficBucketsReady() {
  if (trafficBucketsReadyState !== null) return trafficBucketsReadyState;
  trafficBucketsReadyState = (await getSetting(TRAFFIC_BUCKET_BACKFILL_SETTING).catch(() => null)) === TRAFFIC_BUCKET_BACKFILL_MARKER;
  return trafficBucketsReadyState;
}

export async function cleanOldTrafficStatBuckets(retainHours: number = 72) {
  const db = await getDb();
  if (!db) return;
  const cutoff = retentionCutoffSeconds(retainHours);
  const safeCutoff = Math.max(0, cutoff - TRAFFIC_BUCKET_SECONDS);
  await deleteExpiredHistoryRows("traffic_stat_buckets", "bucketStart", safeCutoff, {
    whereSql: `${quoteIdentifier("bucketMinutes")} = ?`,
    whereParams: [TRAFFIC_BUCKET_MINUTES],
  });
}

export async function ensureTrafficStatBucketsBackfilled(options: {
  force?: boolean;
  preserveExisting?: boolean;
  logger?: Pick<typeof console, "info" | "warn">;
} = {}) {
  const db = await getDb();
  const logger = options.logger ?? console;
  if (!db) return { skipped: true, rows: 0 };
  if (options.preserveExisting) {
    const existingRows = await tableRowCount("traffic_stat_buckets");
    if (existingRows > 0) {
      await setSetting(TRAFFIC_BUCKET_BACKFILL_SETTING, TRAFFIC_BUCKET_BACKFILL_MARKER);
      await setSetting("trafficStatBucketsBackfilledAt", String(epochSeconds(nowDate())));
      trafficBucketsReadyState = true;
      logger.info?.(`[TrafficSummary] Imported buckets preserved rows=${existingRows}`);
      return { skipped: true, rows: existingRows };
    }
  }
  const marker = await getSetting(TRAFFIC_BUCKET_BACKFILL_SETTING).catch(() => null);
  if (!options.force && marker === TRAFFIC_BUCKET_BACKFILL_MARKER) {
    trafficBucketsReadyState = true;
    logger.info?.(`[TrafficSummary] Bucket backfill already completed marker=${TRAFFIC_BUCKET_BACKFILL_MARKER}; skipping`);
    return { skipped: true, rows: 0 };
  }
  const startedAt = Date.now();
  const q = quoteIdentifier;
  const bucketSql = bucketExprSql("ts", TRAFFIC_BUCKET_SECONDS);
  await executeRaw(`DELETE FROM ${q("traffic_stat_buckets")}`);
  const result = await executeRaw(
    `INSERT INTO ${q("traffic_stat_buckets")}
       (${q("bucketStart")}, ${q("bucketMinutes")}, ${q("userId")}, ${q("ruleId")}, ${q("hostId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("updatedAt")})
     SELECT ${bucketSql} AS ${q("bucketStart")},
            ? AS ${q("bucketMinutes")},
             COALESCE(parent.${q("userId")}, fr.${q("userId")}) AS ${q("userId")},
            ts.${q("ruleId")} AS ${q("ruleId")},
            ts.${q("hostId")} AS ${q("hostId")},
            COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")},
            COALESCE(SUM(ts.${q("connections")}), 0) AS ${q("connections")},
            ? AS ${q("updatedAt")}
       FROM ${q("traffic_stats")} ts
       INNER JOIN ${q("forward_rules")} fr ON fr.${q("id")} = ts.${q("ruleId")}
       ${managedParentRuleJoin("fr")}
      GROUP BY ${bucketSql}, COALESCE(parent.${q("userId")}, fr.${q("userId")}), ts.${q("ruleId")}, ts.${q("hostId")}`,
    [TRAFFIC_BUCKET_MINUTES, epochSeconds(nowDate())],
  );
  const rows = rawAffectedRows(result);
  await setSetting(TRAFFIC_BUCKET_BACKFILL_SETTING, TRAFFIC_BUCKET_BACKFILL_MARKER);
  await setSetting("trafficStatBucketsBackfilledAt", String(epochSeconds(nowDate())));
  trafficBucketsReadyState = true;
  logger.info?.(`[TrafficSummary] Bucket backfill complete marker=${TRAFFIC_BUCKET_BACKFILL_MARKER} rows=${rows} elapsedMs=${Date.now() - startedAt}`);
  return { skipped: false, rows };
}

export async function ensureUserTrafficCountersBackfilled(options: {
  force?: boolean;
  preserveExisting?: boolean;
  logger?: Pick<typeof console, "info" | "warn">;
} = {}) {
  const db = await getDb();
  const logger = options.logger ?? console;
  if (!db) return { skipped: true, rows: 0 };
  if (options.preserveExisting) {
    const [ruleRows, userRows] = await Promise.all([
      tableRowCount("forward_rule_traffic_counters"),
      tableRowCount("user_traffic_counters"),
    ]);
    if (ruleRows > 0 || userRows > 0) {
      const repaired = await withDatabaseTransaction(async () => {
        const ownership = await repairTrafficCounterOwnership();
        const rebuiltUserRows = ruleRows > 0 ? await rebuildUserTrafficCountersFromRuleCounters() : userRows;
        return { ...ownership, rebuiltUserRows };
      });
      await setSetting(USER_TRAFFIC_COUNTER_BACKFILL_SETTING, USER_TRAFFIC_COUNTER_BACKFILL_MARKER);
      logger.info?.(`[TrafficCounter] Imported cumulative counters preserved ruleRows=${ruleRows} userRows=${userRows} repairedRules=${repaired.counterRows} repairedBuckets=${repaired.bucketRows}`);
      return { skipped: true, rows: ruleRows + repaired.rebuiltUserRows };
    }
  }
  const marker = await getSetting(USER_TRAFFIC_COUNTER_BACKFILL_SETTING).catch(() => null);
  if (!options.force && marker === USER_TRAFFIC_COUNTER_BACKFILL_MARKER) {
    logger.info?.("[TrafficCounter] User/rule counter backfill already completed; skipping");
    return { skipped: true, rows: 0 };
  }
  const existingCounterRows = await tableRowCount("forward_rule_traffic_counters");
  if (!options.force && existingCounterRows > 0) {
    const repaired = await withDatabaseTransaction(async () => {
      const ownership = await repairTrafficCounterOwnership();
      const rebuiltUserRows = await rebuildUserTrafficCountersFromRuleCounters();
      return { ...ownership, rebuiltUserRows };
    });
    await setSetting(USER_TRAFFIC_COUNTER_BACKFILL_SETTING, USER_TRAFFIC_COUNTER_BACKFILL_MARKER);
    logger.info?.(`[TrafficCounter] Existing cumulative counters detected rows=${existingCounterRows}; preserving repairedRules=${repaired.counterRows} repairedBuckets=${repaired.bucketRows}`);
    return { skipped: true, rows: existingCounterRows + repaired.rebuiltUserRows };
  }

  const startedAt = Date.now();
  const q = quoteIdentifier;
  const rebuilt = await withDatabaseTransaction(async () => {
    const nowSec = epochSeconds(nowDate());
    await executeRaw(`DELETE FROM ${q("forward_rule_traffic_counters")}`);
    await executeRaw(`DELETE FROM ${q("user_traffic_counters")}`);

    let ruleRows = 0;
    const statRows = await tableRowCount("traffic_stats");
    if (statRows > 0) {
      const result = await executeRaw(
        `INSERT INTO ${q("forward_rule_traffic_counters")}
           (${q("ruleId")}, ${q("hostId")}, ${q("userId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("createdAt")}, ${q("updatedAt")})
         SELECT ts.${q("ruleId")} AS ${q("ruleId")},
                ts.${q("hostId")} AS ${q("hostId")},
                COALESCE(parent.${q("userId")}, fr.${q("userId")}) AS ${q("userId")},
                COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
                COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")},
                COALESCE(SUM(ts.${q("connections")}), 0) AS ${q("connections")},
                ? AS ${q("createdAt")},
                ? AS ${q("updatedAt")}
           FROM ${q("traffic_stats")} ts
           INNER JOIN ${q("forward_rules")} fr ON fr.${q("id")} = ts.${q("ruleId")}
           ${managedParentRuleJoin("fr")}
          GROUP BY ts.${q("ruleId")}, ts.${q("hostId")}, COALESCE(parent.${q("userId")}, fr.${q("userId")})`,
        [nowSec, nowSec],
      );
      ruleRows = rawAffectedRows(result);
    } else {
      const bucketRows = await tableRowCount("traffic_stat_buckets");
      if (bucketRows > 0) {
        const result = await executeRaw(
          `INSERT INTO ${q("forward_rule_traffic_counters")}
             (${q("ruleId")}, ${q("hostId")}, ${q("userId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("createdAt")}, ${q("updatedAt")})
           SELECT b.${q("ruleId")} AS ${q("ruleId")},
                  b.${q("hostId")} AS ${q("hostId")},
                  COALESCE(parent.${q("userId")}, fr.${q("userId")}, b.${q("userId")}) AS ${q("userId")},
                  COALESCE(SUM(b.${q("bytesIn")}), 0) AS ${q("bytesIn")},
                  COALESCE(SUM(b.${q("bytesOut")}), 0) AS ${q("bytesOut")},
                  COALESCE(SUM(b.${q("connections")}), 0) AS ${q("connections")},
                  ? AS ${q("createdAt")},
                  ? AS ${q("updatedAt")}
             FROM ${q("traffic_stat_buckets")} b
             LEFT JOIN ${q("forward_rules")} fr ON fr.${q("id")} = b.${q("ruleId")}
             ${managedParentRuleJoin("fr")}
            WHERE b.${q("bucketMinutes")} = ?
            GROUP BY b.${q("ruleId")}, b.${q("hostId")}, COALESCE(parent.${q("userId")}, fr.${q("userId")}, b.${q("userId")})`,
          [nowSec, nowSec, TRAFFIC_BUCKET_MINUTES],
        );
        ruleRows = rawAffectedRows(result);
      }
    }
    const repaired = await repairTrafficCounterOwnership();
    const userRows = await rebuildUserTrafficCountersFromRuleCounters();
    return { ...repaired, ruleRows, userRows };
  });
  await setSetting(USER_TRAFFIC_COUNTER_BACKFILL_SETTING, USER_TRAFFIC_COUNTER_BACKFILL_MARKER);
  await setSetting("userTrafficCountersBackfilledAt", String(epochSeconds(nowDate())));
  logger.info?.(`[TrafficCounter] User/rule counter backfill complete ruleRows=${rebuilt.ruleRows} userRows=${rebuilt.userRows} repairedRules=${rebuilt.counterRows} repairedBuckets=${rebuilt.bucketRows} elapsedMs=${Date.now() - startedAt}`);
  return { skipped: false, rows: rebuilt.ruleRows + rebuilt.userRows };
}

type RuleTrafficIdentity = {
  id: number;
  hostId: number;
  sourcePort: number;
  userId: number;
};

type TrafficSummaryRow = {
  ruleId: number;
  hostId: number;
  bytesIn: number;
  bytesOut: number;
  connections: number;
};

function mapTrafficSummaryRows(rows: any[]): TrafficSummaryRow[] {
  return rows.map((r: any) => ({
    ruleId: Number(r.ruleId),
    hostId: Number(r.hostId),
    bytesIn: numeric(r.bytesIn),
    bytesOut: numeric(r.bytesOut),
    connections: numeric(r.connections),
  })).filter((row) => row.ruleId > 0 && row.hostId > 0);
}

type TrafficBucketSegmentRow = TrafficSummaryRow & {
  /** 这一行是不是只由整桶区间 [fullStart, fullEnd) 里的桶加起来的 */
  fullBucket: boolean;
  /** 规则还在不在 forward_rules 里（原始样本那边是 INNER JOIN，删掉的规则不算） */
  ruleExists: boolean;
};

/**
 * 从 floor(since) 那一桶起的桶，按「是否整桶区间 / 规则是否还在」分开汇总。
 * 三段合起来就是原来 getTrafficSummaryRowsFromBuckets 的结果（原始样本缺的规则拿它补）；
 * fullBucket && ruleExists 的那部分则和这段时间原始样本的 INNER JOIN 汇总相等。
 * 返回 null：桶不可用或查询失败，调用方整段读原始样本（和原来一样）。
 */
async function getTrafficBucketSegmentRows(opts: {
  userId?: number;
  hostId?: number;
  sinceSec: number;
  fullStart: number;
  fullEnd: number;
  ruleIds?: number[];
}): Promise<TrafficBucketSegmentRow[] | null> {
  const q = quoteIdentifier;
  const conditions = [`b.${q("bucketMinutes")} = ?`, `b.${q("bucketStart")} >= ?`];
  const params: any[] = [opts.fullStart, opts.fullEnd, TRAFFIC_BUCKET_MINUTES, bucketStartFor(opts.sinceSec)];
  if (opts.hostId) {
    conditions.push(`b.${q("hostId")} = ?`);
    params.push(opts.hostId);
  }
  if (opts.userId) {
    // 规则还在时等价于原始样本那边的 COALESCE(parent, fr)；规则删了按桶上记的 userId 算（原口径）
    conditions.push(`COALESCE(parent.${q("userId")}, fr.${q("userId")}, b.${q("userId")}) = ?`);
    params.push(opts.userId);
  }
  if (opts.ruleIds?.length) {
    const ids = idListSql(`b.${q("ruleId")}`, opts.ruleIds);
    conditions.push(ids.sql);
    params.push(...ids.params);
  }
  const rows = await queryRaw<any>(
    `SELECT s.${q("ruleId")} AS ${q("ruleId")},
            s.${q("hostId")} AS ${q("hostId")},
            s.${q("fullBucket")} AS ${q("fullBucket")},
            s.${q("ruleExists")} AS ${q("ruleExists")},
            COALESCE(SUM(s.${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(s.${q("bytesOut")}), 0) AS ${q("bytesOut")},
            COALESCE(SUM(s.${q("connections")}), 0) AS ${q("connections")}
       FROM (
         SELECT b.${q("ruleId")} AS ${q("ruleId")},
                b.${q("hostId")} AS ${q("hostId")},
                CASE WHEN b.${q("bucketStart")} >= ? AND b.${q("bucketStart")} < ? THEN 1 ELSE 0 END AS ${q("fullBucket")},
                CASE WHEN fr.${q("id")} IS NULL THEN 0 ELSE 1 END AS ${q("ruleExists")},
                b.${q("bytesIn")} AS ${q("bytesIn")},
                b.${q("bytesOut")} AS ${q("bytesOut")},
                b.${q("connections")} AS ${q("connections")}
           FROM ${q("traffic_stat_buckets")} b
           LEFT JOIN ${q("forward_rules")} fr ON fr.${q("id")} = b.${q("ruleId")}
           ${opts.userId ? managedParentRuleJoin("fr") : ""}
          WHERE ${conditions.join(" AND ")}
       ) s
      GROUP BY s.${q("ruleId")}, s.${q("hostId")}, s.${q("fullBucket")}, s.${q("ruleExists")}`,
    params,
  ).catch(() => null);
  if (!rows) return null;
  return rows.map((row: any) => ({
    ruleId: Number(row.ruleId),
    hostId: Number(row.hostId),
    bytesIn: numeric(row.bytesIn),
    bytesOut: numeric(row.bytesOut),
    connections: numeric(row.connections),
    fullBucket: Number(row.fullBucket) === 1,
    ruleExists: Number(row.ruleExists) === 1,
  })).filter((row) => row.ruleId > 0 && row.hostId > 0);
}

async function getTrafficSummaryRowsFromStats(opts: {
  userId?: number;
  hostId?: number;
  since?: Date;
  /** 不含 */
  until?: Date;
  ruleIds?: number[];
}) {
  const q = quoteIdentifier;
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.hostId) {
    conditions.push(`ts.${q("hostId")} = ?`);
    params.push(opts.hostId);
  }
  if (opts.since) {
    conditions.push(`ts.${q("recordedAt")} >= ?`);
    params.push(epochSeconds(opts.since));
  }
  if (opts.until) {
    conditions.push(`ts.${q("recordedAt")} < ?`);
    params.push(epochSeconds(opts.until));
  }
  if (opts.userId) {
    conditions.push(`COALESCE(parent.${q("userId")}, fr.${q("userId")}) = ?`);
    params.push(opts.userId);
  }
  if (opts.ruleIds?.length) {
    const ids = idListSql(`ts.${q("ruleId")}`, opts.ruleIds);
    conditions.push(ids.sql);
    params.push(...ids.params);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await queryRaw<TrafficSummaryRow>(
    `SELECT ts.${q("ruleId")} AS ${q("ruleId")},
            ts.${q("hostId")} AS ${q("hostId")},
            COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")},
            COALESCE(SUM(ts.${q("connections")}), 0) AS ${q("connections")}
       FROM ${q("traffic_stats")} ts
       INNER JOIN ${q("forward_rules")} fr ON fr.${q("id")} = ts.${q("ruleId")}
       ${managedParentRuleJoin("fr")}
      ${where}
      GROUP BY ts.${q("ruleId")}, ts.${q("hostId")}`,
    params,
  );
  return mapTrafficSummaryRows(rows as any[]);
}

/**
 * 窗口 [since, now] 按规则汇总，结果和「整段扫 traffic_stats，原始样本缺的规则再拿桶补」
 * 的老算法一致（见 trafficWindowSplit），但只有两头不满一桶的部分扫原始样本。
 * 返回 null：桶不可用，调用方整段读原始样本。
 */
async function getTrafficSummaryRowsWithBuckets(opts: {
  userId?: number;
  hostId?: number;
  since: Date;
  ruleIds?: number[];
}): Promise<TrafficSummaryRow[] | null> {
  if (!await trafficBucketsReady() || !canUseTrafficBuckets(opts.since)) return null;
  const sinceSec = epochSeconds(opts.since);
  const { fullStart, fullEnd, tailStart } = trafficWindowSplit(sinceSec);
  const bucketRows = await getTrafficBucketSegmentRows({ ...opts, sinceSec, fullStart, fullEnd });
  if (!bucketRows) return null;
  const strip = (row: TrafficBucketSegmentRow): TrafficSummaryRow => ({
    ruleId: row.ruleId,
    hostId: row.hostId,
    bytesIn: row.bytesIn,
    bytesOut: row.bytesOut,
    connections: row.connections,
  });
  // 原来那条「整桶补缺」的结果：原始样本里没有的 (规则, 主机) 用它
  const bucketTotals = mergeTrafficSummaryRows(bucketRows.map(strip));
  let rawRows: TrafficSummaryRow[];
  try {
    const head = sinceSec < fullStart
      ? await getTrafficSummaryRowsFromStats({ ...opts, until: new Date(fullStart * 1000) })
      : [];
    const tail = await getTrafficSummaryRowsFromStats({ ...opts, since: new Date(tailStart * 1000) });
    rawRows = mergeTrafficSummaryRows([
      ...head,
      ...bucketRows.filter((row) => row.fullBucket && row.ruleExists).map(strip),
      ...tail,
    ]);
  } catch {
    // 和原来一样：原始样本读不了就只用桶
    return bucketTotals.length > 0 ? bucketTotals : null;
  }
  const present = new Set(rawRows.map((row) => `${row.ruleId}:${row.hostId}`));
  const missing = bucketTotals.filter((row) => !present.has(`${row.ruleId}:${row.hostId}`));
  if (missing.length === 0) return rawRows;
  /*
    老算法里「原始样本有这一对」也包括只有全零样本的情况 —— 那时结果是 0，不拿桶补。
    全零样本不进桶，所以对还存在的规则，补之前要确认整桶区间里真的一条原始样本都没有。
    这类候选只有「窗口开头那一桶之前有流量、窗口里一直空闲」的规则，通常很少。
  */
  const existingRuleIds = new Set(bucketRows.filter((row) => row.ruleExists).map((row) => row.ruleId));
  const candidateRuleIds = Array.from(new Set(missing
    .filter((row) => existingRuleIds.has(row.ruleId))
    .map((row) => row.ruleId)));
  const idlePairs = new Set<string>();
  if (candidateRuleIds.length > 0 && fullStart < fullEnd) {
    const q = quoteIdentifier;
    const ids = idListSql(`ts.${q("ruleId")}`, candidateRuleIds);
    const rows = await queryRaw<any>(
      `SELECT DISTINCT ts.${q("ruleId")} AS ${q("ruleId")}, ts.${q("hostId")} AS ${q("hostId")}
         FROM ${q("traffic_stats")} ts
        WHERE ${ids.sql} AND ts.${q("recordedAt")} >= ? AND ts.${q("recordedAt")} < ?`,
      [...ids.params, fullStart, fullEnd],
    ).catch(() => [] as any[]);
    for (const row of rows) idlePairs.add(`${Number(row.ruleId)}:${Number(row.hostId)}`);
  }
  return [
    ...rawRows,
    ...missing.map((row) => idlePairs.has(`${row.ruleId}:${row.hostId}`)
      ? { ...row, bytesIn: 0, bytesOut: 0, connections: 0 }
      : row),
  ];
}

function ruleTrafficIdentityKey(rule: RuleTrafficIdentity | undefined | null) {
  if (!rule) return "";
  return `${Number(rule.userId) || 0}:${Number(rule.hostId) || 0}:${Number(rule.sourcePort) || 0}`;
}

function mergeTrafficSummaryRows(rows: TrafficSummaryRow[]) {
  const merged = new Map<string, TrafficSummaryRow>();
  for (const item of rows) {
    const key = `${item.ruleId}:${item.hostId}`;
    const prev = merged.get(key);
    if (prev) {
      prev.bytesIn += item.bytesIn;
      prev.bytesOut += item.bytesOut;
      prev.connections += item.connections;
    } else {
      merged.set(key, { ...item });
    }
  }
  return Array.from(merged.values());
}

async function getForwardGroupModeMap(groupIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(groupIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const map = new Map<number, string>();
  if (!db || ids.length === 0) return map;
  const rows = await db
    .select({
      id: forwardGroups.id,
      groupMode: forwardGroups.groupMode,
    })
    .from(forwardGroups)
    .where(sql`${forwardGroups.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  for (const row of rows as any[]) {
    map.set(Number(row.id), String(row.groupMode || "failover"));
  }
  return map;
}

async function getChainGroupIdForTemplateRule(ruleId: number) {
  const db = await getDb();
  const id = Number(ruleId || 0);
  if (!db || !Number.isInteger(id) || id <= 0) return null;
  const rows = await db
    .select({
      forwardGroupId: forwardRules.forwardGroupId,
      groupMode: forwardGroups.groupMode,
    })
    .from(forwardRules)
    .innerJoin(forwardGroups, eq(forwardGroups.id, forwardRules.forwardGroupId))
    .where(and(
      eq(forwardRules.id, id),
      eq(forwardRules.pendingDelete, false),
      eq(forwardGroups.groupMode, "chain"),
    ))
    .limit(1);
  const groupId = Number((rows as any[])[0]?.forwardGroupId || 0);
  return groupId > 0 ? groupId : null;
}

type ForwardGroupTrafficChildRow = {
  id: number;
  parentId: number;
  groupId: number;
  memberId: number;
  hostId: number;
};

type ForwardGroupLatencyChildRow = {
  id: number;
  groupId: number;
  memberId: number;
};

function selectPreferredForwardGroupLatencyChild(
  childRows: ForwardGroupLatencyChildRow[],
  preferredMemberIds: number[],
  fallbackHasData?: (row: ForwardGroupLatencyChildRow) => boolean,
) {
  for (const memberId of preferredMemberIds) {
    const normalizedMemberId = Number(memberId || 0);
    if (normalizedMemberId <= 0) continue;
    const matched = childRows.find((row) => Number(row.memberId) === normalizedMemberId);
    if (matched) return matched;
  }
  if (fallbackHasData) {
    const matched = childRows.find(fallbackHasData);
    if (matched) return matched;
  }
  return childRows[0];
}

async function getFirstEnabledMemberByGroup(groupIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(groupIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const map = new Map<number, { id: number; hostId: number; priority: number }>();
  if (!db || ids.length === 0) return map;
  const rows = await db
    .select({
      id: forwardGroupMembers.id,
      groupId: forwardGroupMembers.groupId,
      hostId: forwardGroupMembers.hostId,
      priority: forwardGroupMembers.priority,
    })
    .from(forwardGroupMembers)
    .where(sql`${forwardGroupMembers.groupId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND ${forwardGroupMembers.isEnabled} = ${sqlBool(true)}`);
  for (const row of rows as any[]) {
    const groupId = Number(row.groupId || 0);
    const id = Number(row.id || 0);
    if (groupId <= 0 || id <= 0) continue;
    const priority = Number(row.priority || 0);
    const prev = map.get(groupId);
    if (!prev || priority < prev.priority || (priority === prev.priority && id < prev.id)) {
      map.set(groupId, { id, hostId: Number(row.hostId || 0), priority });
    }
  }
  return map;
}

async function getActiveMemberByGroup(groupIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(groupIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const map = new Map<number, number>();
  if (!db || ids.length === 0) return map;
  const rows = await db
    .select({
      id: forwardGroups.id,
      activeMemberId: forwardGroups.activeMemberId,
    })
    .from(forwardGroups)
    .where(sql`${forwardGroups.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  for (const row of rows as any[]) {
    const groupId = Number(row.id || 0);
    const activeMemberId = Number(row.activeMemberId || 0);
    if (groupId > 0 && activeMemberId > 0) map.set(groupId, activeMemberId);
  }
  return map;
}

async function getForwardGroupTrafficChildRows(parentRuleIds: number[]) {
  const db = await getDb();
  const parentIds = Array.from(new Set(parentRuleIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (!db || parentIds.length === 0) return [] as ForwardGroupTrafficChildRow[];
  const rows = await db
    .select({
      id: forwardRules.id,
      parentId: forwardRules.forwardGroupRuleId,
      groupId: forwardRules.forwardGroupId,
      memberId: forwardRules.forwardGroupMemberId,
      hostId: forwardRules.hostId,
    })
    .from(forwardRules)
    .where(sql`${idListDrizzle(forwardRules.forwardGroupRuleId, parentIds)} AND ${forwardRules.pendingDelete} = ${sqlBool(false)}`);
  const childRows = (rows as any[]).map((row) => ({
    id: Number(row.id || 0),
    parentId: Number(row.parentId || 0),
    groupId: Number(row.groupId || 0),
    memberId: Number(row.memberId || 0),
    hostId: Number(row.hostId || 0),
  })).filter((row) => row.id > 0 && row.parentId > 0);
  const groupModeById = await getForwardGroupModeMap(childRows.map((row) => row.groupId));
  const chainGroupIds = childRows
    .filter((row) => groupModeById.get(row.groupId) === "chain")
    .map((row) => row.groupId);
  const firstMemberByGroup = await getFirstEnabledMemberByGroup(chainGroupIds);
  return childRows.filter((row) => {
    if (groupModeById.get(row.groupId) !== "chain") return true;
    const firstMember = firstMemberByGroup.get(row.groupId);
    return Number(firstMember?.id || 0) === row.memberId
      && (!Number(firstMember?.hostId || 0) || Number(firstMember?.hostId || 0) === row.hostId);
  });
}

async function expandTrafficQueryRuleIds(ruleIds: number[]) {
  const requestedRuleIds = Array.from(new Set(ruleIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (requestedRuleIds.length === 0) {
    return { queryRuleIds: [] as number[], parentByChildRuleId: new Map<number, number>() };
  }
  const childRows = await getForwardGroupTrafficChildRows(requestedRuleIds);
  const parentByChildRuleId = new Map<number, number>();
  for (const row of childRows) {
    parentByChildRuleId.set(row.id, row.parentId);
  }
  return {
    queryRuleIds: Array.from(new Set([...requestedRuleIds, ...childRows.map((row) => row.id)])),
    parentByChildRuleId,
  };
}

async function getTrafficSummaryRowsFromCounters(opts: {
  userId?: number;
  hostId?: number;
  ruleIds?: number[];
}) {
  const q = quoteIdentifier;
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.hostId) {
    conditions.push(`c.${q("hostId")} = ?`);
    params.push(opts.hostId);
  }
  if (opts.userId) {
    conditions.push(`COALESCE(parent.${q("userId")}, fr.${q("userId")}, c.${q("userId")}) = ?`);
    params.push(opts.userId);
  }
  if (opts.ruleIds?.length) {
    const ids = idListSql(`c.${q("ruleId")}`, opts.ruleIds);
    conditions.push(ids.sql);
    params.push(...ids.params);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await queryRaw<TrafficSummaryRow>(
    `SELECT c.${q("ruleId")} AS ${q("ruleId")},
            c.${q("hostId")} AS ${q("hostId")},
            COALESCE(SUM(c.${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(c.${q("bytesOut")}), 0) AS ${q("bytesOut")},
            COALESCE(SUM(c.${q("connections")}), 0) AS ${q("connections")}
       FROM ${q("forward_rule_traffic_counters")} c
       ${opts.userId ? `LEFT JOIN ${q("forward_rules")} fr ON fr.${q("id")} = c.${q("ruleId")}
       ${managedParentRuleJoin("fr")}` : ""}
      ${where}
      GROUP BY c.${q("ruleId")}, c.${q("hostId")}`,
    params,
  ).catch(() => [] as TrafficSummaryRow[]);
  return mapTrafficSummaryRows(rows as any[]);
}

async function normalizeTrafficSummaryRowsForRules(
  rows: TrafficSummaryRow[],
  opts: { userId?: number; hostId?: number },
  requestedRuleIds: number[],
) {
  const db = await getDb();
  if (!db) return rows;
  let result = rows;
  const groupChildIds = Array.from(new Set(result.map((r) => r.ruleId)));
  if (groupChildIds.length > 0) {
    const childRows = await db
      .select({
        id: forwardRules.id,
        parentId: forwardRules.forwardGroupRuleId,
        groupId: forwardRules.forwardGroupId,
        memberId: forwardRules.forwardGroupMemberId,
        hostId: forwardRules.hostId,
      })
      .from(forwardRules)
      .where(sql`${idListDrizzle(forwardRules.id, groupChildIds)} AND ${forwardRules.forwardGroupRuleId} IS NOT NULL`);
    const groupModeById = await getForwardGroupModeMap((childRows as any[]).map((row: any) => Number(row.groupId || 0)));
    const chainMemberRows = (childRows as any[]).filter((row: any) => groupModeById.get(Number(row.groupId || 0)) === "chain");
    const firstChainMemberByGroup = new Map<number, { id: number; hostId: number; priority: number }>();
    if (chainMemberRows.length > 0) {
      const groupIds = Array.from(new Set(chainMemberRows.map((row: any) => Number(row.groupId || 0)).filter((id: number) => id > 0)));
      if (groupIds.length > 0) {
        const memberRows = await db
          .select({
            id: forwardGroupMembers.id,
            groupId: forwardGroupMembers.groupId,
            hostId: forwardGroupMembers.hostId,
            priority: forwardGroupMembers.priority,
            isEnabled: forwardGroupMembers.isEnabled,
          })
          .from(forwardGroupMembers)
          .where(sql`${forwardGroupMembers.groupId} IN (${sql.join(groupIds.map((id) => sql`${id}`), sql`, `)})`);
        for (const row of memberRows as any[]) {
          if (!rowBool((row as any).isEnabled)) continue;
          const groupId = Number((row as any).groupId || 0);
          const previous = firstChainMemberByGroup.get(groupId);
          const candidate = {
            id: Number(row.id),
            hostId: Number(row.hostId || 0),
            priority: Number(row.priority || 0),
          };
          if (!previous) {
            firstChainMemberByGroup.set(groupId, candidate);
            continue;
          }
          if (candidate.priority < previous.priority || (candidate.priority === previous.priority && candidate.id < previous.id)) {
            firstChainMemberByGroup.set(groupId, candidate);
          }
        }
      }
    }
    const parentByChild = new Map<number, { parentId: number; hostId: number }>();
    for (const row of childRows as any[]) {
      const groupMode = groupModeById.get(Number(row.groupId || 0));
      if (groupMode === "chain") {
        const firstMember = firstChainMemberByGroup.get(Number(row.groupId || 0));
        if (Number(firstMember?.id || 0) !== Number(row.memberId || 0)
          || (Number(firstMember?.hostId || 0) > 0 && Number(firstMember?.hostId || 0) !== Number(row.hostId || 0))) {
          continue;
        }
      }
      parentByChild.set(Number(row.id), { parentId: Number(row.parentId), hostId: Number(row.hostId) });
    }
    if (parentByChild.size > 0) {
      const merged = new Map<string, TrafficSummaryRow>();
      for (const item of result) {
        const parent = parentByChild.get(item.ruleId);
        const ruleId = parent?.parentId || item.ruleId;
        const hostId = parent?.hostId || item.hostId;
        const key = `${ruleId}:${hostId}`;
        const prev = merged.get(key);
        if (prev) {
          prev.bytesIn += item.bytesIn;
          prev.bytesOut += item.bytesOut;
          prev.connections += item.connections;
        } else {
          merged.set(key, { ...item, ruleId, hostId });
        }
      }
      result = Array.from(merged.values());
    }
  }

  if (opts.userId) {
    const ruleIds = await getRuleIdsByUser(opts.userId);
    const ok = new Set(ruleIds);
    result = result.filter((r) => ok.has(r.ruleId));
  }

  let visibleRequestedRows: RuleTrafficIdentity[] = [];
  if (requestedRuleIds.length > 0) {
    const requestedConds: any[] = [
      idListDrizzle(forwardRules.id, requestedRuleIds),
      eq(forwardRules.pendingDelete, false),
    ];
    if (opts.userId) requestedConds.push(eq(forwardRules.userId, opts.userId));
    if (opts.hostId) requestedConds.push(eq(forwardRules.hostId, opts.hostId));
    const requestedRows = await db
      .select({
        id: forwardRules.id,
        hostId: forwardRules.hostId,
        sourcePort: forwardRules.sourcePort,
        userId: forwardRules.userId,
      })
      .from(forwardRules)
      .where(and(...requestedConds));
    visibleRequestedRows = (requestedRows as any[]).map((row) => ({
      id: Number(row.id),
      hostId: Number(row.hostId),
      sourcePort: Number(row.sourcePort),
      userId: Number(row.userId),
    }));
    const visibleRequestedIds = new Set(visibleRequestedRows.map((row) => row.id));
    // Deleted/recreated rules get new IDs; fold preserved same-entry traffic into the visible rule.
    const requestedByIdentity = new Map<string, RuleTrafficIdentity>();
    for (const row of visibleRequestedRows) {
      const key = ruleTrafficIdentityKey(row);
      if (key) requestedByIdentity.set(key, row);
    }
    const resultRuleIds = Array.from(new Set(result.map((item) => item.ruleId).filter((id) => id > 0)));
    const resultRuleRows = resultRuleIds.length > 0
      ? await db
        .select({
          id: forwardRules.id,
          hostId: forwardRules.hostId,
          sourcePort: forwardRules.sourcePort,
          userId: forwardRules.userId,
        })
        .from(forwardRules)
        .where(idListDrizzle(forwardRules.id, resultRuleIds))
      : [];
    const identityByRuleId = new Map<number, RuleTrafficIdentity>();
    for (const row of resultRuleRows as any[]) {
      identityByRuleId.set(Number(row.id), {
        id: Number(row.id),
        hostId: Number(row.hostId),
        sourcePort: Number(row.sourcePort),
        userId: Number(row.userId),
      });
    }
    result = result.map((item) => {
      if (visibleRequestedIds.has(item.ruleId)) return item;
      const currentRule = requestedByIdentity.get(ruleTrafficIdentityKey(identityByRuleId.get(item.ruleId)));
      if (!currentRule) return item;
      return {
        ...item,
        ruleId: currentRule.id,
        hostId: currentRule.hostId,
      };
    });
    result = mergeTrafficSummaryRows(result);
    result = result.filter((item) => visibleRequestedIds.has(item.ruleId));
    const existingKeys = new Set(result.map((item) => `${item.ruleId}:${item.hostId}`));
    for (const row of visibleRequestedRows) {
      const key = `${row.id}:${row.hostId}`;
      if (!existingKeys.has(key)) {
        result.push({
          ruleId: row.id,
          hostId: row.hostId,
          bytesIn: 0,
          bytesOut: 0,
          connections: 0,
        });
        existingKeys.add(key);
      }
    }
  }

  return result;
}

function withEmptyTrafficLatency(rows: TrafficSummaryRow[]) {
  return rows.map((item) => ({
    ...item,
    latestLatencyMs: null as number | null,
    latestLatencyIsTimeout: false,
    latestLatencyAt: null as Date | null,
  }));
}

export function shouldUseLatencyCandidate(
  current: { recordedAt?: Date | string | null } | null | undefined,
  candidate: { recordedAt?: Date | string | null },
) {
  const currentAt = current?.recordedAt ? new Date(current.recordedAt).getTime() : 0;
  const candidateAt = candidate.recordedAt ? new Date(candidate.recordedAt).getTime() : 0;
  if (!Number.isFinite(candidateAt) || candidateAt <= 0) return currentAt <= 0;
  return !Number.isFinite(currentAt) || candidateAt >= currentAt;
}

export async function getTotalTraffic(userId?: number) {
  const db = await getDb();
  if (!db) return { totalIn: 0, totalOut: 0 };
  const q = quoteIdentifier;
  if (userId) {
    const rows = await queryRaw<any>(
      `SELECT COALESCE(SUM(${q("bytesIn")}), 0) AS ${q("totalIn")},
              COALESCE(SUM(${q("bytesOut")}), 0) AS ${q("totalOut")}
         FROM ${q("user_traffic_counters")}
        WHERE ${q("userId")} = ?`,
      [userId],
    ).catch(() => []);
    const row = rows[0];
    return {
      totalIn: Number(row?.totalIn) || 0,
      totalOut: Number(row?.totalOut) || 0,
    };
  }

  const rows = await queryRaw<any>(
    `SELECT COALESCE(SUM(${q("bytesIn")}), 0) AS ${q("totalIn")},
            COALESCE(SUM(${q("bytesOut")}), 0) AS ${q("totalOut")}
       FROM ${q("user_traffic_counters")}`,
  ).catch(() => []);
  const row = rows[0];
  return {
    totalIn: Number(row?.totalIn) || 0,
    totalOut: Number(row?.totalOut) || 0,
  };
}

/** Summarize cumulative traffic by rule from bounded counter rows. */
export async function getTrafficCounterSummaryByRule(opts: {
  userId?: number;
  hostId?: number;
  ruleIds?: number[];
  includeLatency?: boolean;
} = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ ruleId: number; hostId: number; bytesIn: number; bytesOut: number; connections: number; latestLatencyMs: number | null; latestLatencyIsTimeout: boolean; latestLatencyAt: Date | null }>;
  const requestedRuleIds = Array.from(new Set((opts.ruleIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const expandedRuleIds = requestedRuleIds.length > 0
    ? (await expandTrafficQueryRuleIds(requestedRuleIds)).queryRuleIds
    : requestedRuleIds;
  const rows = await getTrafficSummaryRowsFromCounters({ ...opts, ruleIds: expandedRuleIds });
  const result = await normalizeTrafficSummaryRowsForRules(rows, opts, requestedRuleIds);
  const output = withEmptyTrafficLatency(result);
  if (!opts.includeLatency || output.length === 0) return output;
  const latencyRuleIds = requestedRuleIds.length > 0
    ? requestedRuleIds
    : Array.from(new Set(output.map((row) => row.ruleId).filter((id) => id > 0)));
  if (latencyRuleIds.length === 0) return output;
  const latencyRows = await getTrafficSummaryByRule({
    userId: opts.userId,
    hostId: opts.hostId,
    ruleIds: latencyRuleIds,
    includeLatency: true,
  }).catch(() => [] as any[]);
  const latestByRuleId = new Map<number, { latestLatencyMs: number | null; latestLatencyIsTimeout: boolean; latestLatencyAt: Date | string | null }>();
  for (const row of latencyRows as any[]) {
    const ruleId = Number(row.ruleId || 0);
    if (ruleId <= 0) continue;
    const prev = latestByRuleId.get(ruleId);
    const prevAt = prev?.latestLatencyAt ? new Date(prev.latestLatencyAt).getTime() : 0;
    const nextAt = row.latestLatencyAt ? new Date(row.latestLatencyAt).getTime() : 0;
    if (!prev || nextAt >= prevAt) {
      latestByRuleId.set(ruleId, {
        latestLatencyMs: row.latestLatencyMs === null || row.latestLatencyMs === undefined ? null : Number(row.latestLatencyMs),
        latestLatencyIsTimeout: !!row.latestLatencyIsTimeout,
        latestLatencyAt: row.latestLatencyAt || null,
      });
    }
  }
  return output.map((row) => {
    const latency = latestByRuleId.get(row.ruleId);
    return latency ? { ...row, ...latency } : row;
  });
}

/** Summarize traffic by rule. */
export async function getTrafficSummaryByRule(opts: {
  userId?: number;
  hostId?: number;
  since?: Date;
  ruleIds?: number[];
  includeLatency?: boolean;
} = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ ruleId: number; hostId: number; bytesIn: number; bytesOut: number; connections: number; latestLatencyMs: number | null; latestLatencyIsTimeout: boolean; latestLatencyAt: Date | null }>;
  const requestedRuleIds = Array.from(new Set((opts.ruleIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const expandedRuleIds = requestedRuleIds.length > 0
    ? (await expandTrafficQueryRuleIds(requestedRuleIds)).queryRuleIds
    : requestedRuleIds;
  const since = opts.since ?? new Date(Date.now() - TRAFFIC_BUCKET_RETENTION_HOURS * 60 * 60 * 1000);
  const queryOpts = { ...opts, since, ruleIds: expandedRuleIds };
  // 原始样本为准、原始样本缺的 (规则, 主机) 用桶补；已经结束的整桶直接读桶表
  // （和原始样本逐字节相等，见 trafficWindowSplit），只有两头不满一桶的部分扫原始样本。
  let result = await getTrafficSummaryRowsWithBuckets(queryOpts)
    ?? await getTrafficSummaryRowsFromStats(queryOpts);
  result = await normalizeTrafficSummaryRowsForRules(result, opts, requestedRuleIds);

  if (result.length === 0) return withEmptyTrafficLatency(result);
  if (opts.includeLatency === false) {
    return withEmptyTrafficLatency(result);
  }

  const ruleIds = Array.from(new Set(result.map((r) => r.ruleId)));
  const ruleLatencyRows = ruleIds.length > 0
    ? await db
      .select({
        id: forwardRules.id,
        tunnelId: forwardRules.tunnelId,
      })
      .from(forwardRules)
      .where(sql`${forwardRules.id} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)}) AND ${forwardRules.pendingDelete} = ${sqlBool(false)}`)
    : [];
  const tunnelRuleIds = new Set((ruleLatencyRows as any[])
    .filter((row: any) => Number(row.tunnelId || 0) > 0)
    .map((row: any) => Number(row.id)));
  const childLatencyRows = ruleIds.length > 0
    ? await db
      .select({
        id: forwardRules.id,
        groupId: forwardRules.forwardGroupId,
        parentId: forwardRules.forwardGroupRuleId,
        memberId: forwardRules.forwardGroupMemberId,
      })
      .from(forwardRules)
      .where(sql`${forwardRules.forwardGroupRuleId} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)}) AND ${forwardRules.pendingDelete} = ${sqlBool(false)}`)
    : [];
  const latencyGroupModeById = await getForwardGroupModeMap((childLatencyRows as any[]).map((row: any) => Number(row.groupId || 0)));
  const parentChainChildren = new Map<number, number[]>();
  const parentFailoverChildren = new Map<number, number[]>();
  const parentFailoverChildRows = new Map<number, ForwardGroupLatencyChildRow[]>();
  const parentByChildRule = new Map<number, number>();
  const chainParentRuleIds = new Set<number>();
  for (const row of childLatencyRows as any[]) {
    const childId = Number(row.id);
    const parentId = Number(row.parentId);
    const groupId = Number(row.groupId || 0);
    const memberId = Number(row.memberId || 0);
    if (childId <= 0 || parentId <= 0) continue;
    if (latencyGroupModeById.get(groupId) === "chain") {
      chainParentRuleIds.add(parentId);
      const children = parentChainChildren.get(parentId) || [];
      children.push(childId);
      parentChainChildren.set(parentId, children);
      continue;
    }
    parentByChildRule.set(childId, parentId);
    const children = parentFailoverChildren.get(parentId) || [];
    children.push(childId);
    parentFailoverChildren.set(parentId, children);
    const childRows = parentFailoverChildRows.get(parentId) || [];
    childRows.push({ id: childId, groupId, memberId });
    parentFailoverChildRows.set(parentId, childRows);
  }
  const latencyRuleIds = Array.from(new Set([
    ...ruleIds,
    ...Array.from(parentByChildRule.keys()),
    ...Array.from(parentChainChildren.values()).flat(),
  ]));
  const q = quoteIdentifier;
  const latestRows = latencyRuleIds.length > 0
    ? await queryRaw<any>(
      `SELECT s.${q("ruleId")} AS ${q("ruleId")},
              s.${q("latencyMs")} AS ${q("latencyMs")},
              s.${q("isTimeout")} AS ${q("isTimeout")},
              s.${q("recordedAt")} AS ${q("recordedAt")}
         FROM ${q("tcping_stats")} s
         INNER JOIN (
           SELECT ${q("ruleId")}, MAX(${q("recordedAt")}) AS ${q("recordedAt")}
             FROM ${q("tcping_stats")}
            WHERE ${q("ruleId")} IN (${latencyRuleIds.map(() => "?").join(",")})
            GROUP BY ${q("ruleId")}
         ) latest ON latest.${q("ruleId")} = s.${q("ruleId")} AND latest.${q("recordedAt")} = s.${q("recordedAt")}
        ORDER BY s.${q("recordedAt")} DESC`,
      latencyRuleIds,
    )
    : [];
  const latestByRule = new Map<number, any>();
  for (const row of latestRows as any[]) {
    row.isTimeout = rowBool(row.isTimeout);
    row.recordedAt = rowDate(row.recordedAt);
    const rowRuleId = Number(row.ruleId);
    const parentId = parentByChildRule.get(rowRuleId) || 0;
    if (!parentId && parentFailoverChildren.has(rowRuleId)) continue;
    if (parentId && parentFailoverChildren.has(parentId)) continue;
    const ruleId = parentId || rowRuleId;
    if (!latestByRule.has(ruleId)) latestByRule.set(ruleId, row);
  }
  const latestByRawRule = new Map<number, any>();
  for (const row of latestRows as any[]) {
    const rowRuleId = Number(row.ruleId);
    if (!latestByRawRule.has(rowRuleId)) latestByRawRule.set(rowRuleId, row);
  }
  const failoverGroupIds = Array.from(new Set(Array.from(parentFailoverChildRows.values())
    .flat()
    .map((row) => row.groupId)
    .filter((id) => Number.isInteger(id) && id > 0)));
  const [activeMemberByGroup, firstMemberByGroup] = await Promise.all([
    getActiveMemberByGroup(failoverGroupIds),
    getFirstEnabledMemberByGroup(failoverGroupIds),
  ]);
  for (const [parentId, childRows] of parentFailoverChildRows.entries()) {
    const groupId = Number(childRows.find((row) => row.groupId > 0)?.groupId || 0);
    const preferredMemberIds = Array.from(new Set([
      Number(activeMemberByGroup.get(groupId) || 0),
      Number(firstMemberByGroup.get(groupId)?.id || 0),
    ].filter((id) => Number.isInteger(id) && id > 0)));
    const selectedChild = selectPreferredForwardGroupLatencyChild(
      childRows,
      preferredMemberIds,
      (row) => latestByRawRule.has(row.id),
    );
    const latest = selectedChild ? latestByRawRule.get(selectedChild.id) : null;
    if (latest) {
      latestByRule.set(parentId, {
        ruleId: parentId,
        latencyMs: latest.isTimeout || latest.latencyMs === null || latest.latencyMs === undefined ? null : Number(latest.latencyMs),
        isTimeout: !!latest.isTimeout,
        recordedAt: latest.recordedAt,
      });
    } else {
      latestByRule.delete(parentId);
    }
  }
  for (const [parentId, childIds] of parentChainChildren.entries()) {
    let latencySum = 0;
    let recordedAt: Date | null = null;
    let isTimeout = childIds.length === 0;
    let hasLatency = false;
    for (const childId of childIds) {
      const latest = latestByRawRule.get(childId);
      if (!latest) {
        isTimeout = true;
        continue;
      }
      if (!recordedAt || new Date(latest.recordedAt).getTime() > new Date(recordedAt).getTime()) {
        recordedAt = latest.recordedAt;
      }
      if (latest.isTimeout || latest.latencyMs === null || latest.latencyMs === undefined) {
        isTimeout = true;
        continue;
      }
      latencySum += Number(latest.latencyMs) || 0;
      hasLatency = true;
    }
    latestByRule.set(parentId, {
      ruleId: parentId,
      latencyMs: !isTimeout && hasLatency ? latencySum : null,
      isTimeout,
      recordedAt,
    });
  }
  const chainParentIds = Array.from(chainParentRuleIds);
  const latestChainTestRows = chainParentIds.length > 0
    ? await queryRaw<any>(
      `SELECT ft.${q("ruleId")} AS ${q("ruleId")},
              ft.${q("latencyMs")} AS ${q("latencyMs")},
              ft.${q("status")} AS ${q("status")},
              ft.${q("updatedAt")} AS ${q("updatedAt")},
              ft.${q("createdAt")} AS ${q("createdAt")}
         FROM ${q("forward_tests")} ft
         INNER JOIN (
           SELECT ${q("ruleId")}, MAX(${q("updatedAt")}) AS ${q("updatedAt")}
             FROM ${q("forward_tests")}
            WHERE ${q("ruleId")} IN (${chainParentIds.map(() => "?").join(",")})
              AND ${q("status")} IN ('success', 'failed', 'timeout')
            GROUP BY ${q("ruleId")}
         ) latest ON latest.${q("ruleId")} = ft.${q("ruleId")} AND latest.${q("updatedAt")} = ft.${q("updatedAt")}
        ORDER BY ft.${q("updatedAt")} DESC, CASE WHEN ft.${q("message")} LIKE '%forward-chain-hop-summary%' THEN 0 ELSE 1 END, ft.${q("createdAt")} DESC`,
      chainParentIds,
    )
    : [];
  for (const row of latestChainTestRows as any[]) {
    const ruleId = Number(row.ruleId);
    if (!chainParentRuleIds.has(ruleId) || latestByRule.get(ruleId)?.source === "forward_test") continue;
    const status = String(row.status || "").toLowerCase();
    const candidate = {
      ruleId,
      latencyMs: status === "success" && row.latencyMs !== null && row.latencyMs !== undefined ? Number(row.latencyMs) : null,
      isTimeout: status !== "success",
      recordedAt: rowDate(row.updatedAt || row.createdAt),
      source: "forward_test",
    };
    if (shouldUseLatencyCandidate(latestByRule.get(ruleId), candidate)) {
      latestByRule.set(ruleId, candidate);
    }
  }
  const tunnelRuleIdsForTests = Array.from(tunnelRuleIds);
  const latestTunnelTestRows = tunnelRuleIdsForTests.length > 0
    ? await queryRaw<any>(
      `SELECT ft.${q("ruleId")} AS ${q("ruleId")},
              ft.${q("latencyMs")} AS ${q("latencyMs")},
              ft.${q("status")} AS ${q("status")},
              ft.${q("updatedAt")} AS ${q("updatedAt")},
              ft.${q("createdAt")} AS ${q("createdAt")}
         FROM ${q("forward_tests")} ft
         INNER JOIN (
           SELECT ${q("ruleId")}, MAX(${q("updatedAt")}) AS ${q("updatedAt")}
             FROM ${q("forward_tests")}
            WHERE ${q("ruleId")} IN (${tunnelRuleIdsForTests.map(() => "?").join(",")})
              AND ${q("status")} IN ('success', 'failed', 'timeout')
              AND ${q("message")} LIKE '%"kind":"forward-via-tunnel"%'
            GROUP BY ${q("ruleId")}
         ) latest ON latest.${q("ruleId")} = ft.${q("ruleId")} AND latest.${q("updatedAt")} = ft.${q("updatedAt")}
        WHERE ft.${q("status")} IN ('success', 'failed', 'timeout')
          AND ft.${q("message")} LIKE '%"kind":"forward-via-tunnel"%'
        ORDER BY ft.${q("updatedAt")} DESC, ft.${q("createdAt")} DESC`,
      tunnelRuleIdsForTests,
    )
    : [];
  for (const row of latestTunnelTestRows as any[]) {
    const ruleId = Number(row.ruleId);
    if (!tunnelRuleIds.has(ruleId) || latestByRule.get(ruleId)?.source === "forward_test") continue;
    const status = String(row.status || "").toLowerCase();
    const candidate = {
      ruleId,
      latencyMs: status === "success" && row.latencyMs !== null && row.latencyMs !== undefined ? Number(row.latencyMs) : null,
      isTimeout: status !== "success",
      recordedAt: rowDate(row.updatedAt || row.createdAt),
      source: "forward_test",
    };
    if (shouldUseLatencyCandidate(latestByRule.get(ruleId), candidate)) {
      latestByRule.set(ruleId, candidate);
    }
  }
  return result.map((item) => {
    const latest = latestByRule.get(item.ruleId);
    return {
      ...item,
      latestLatencyMs: latest && latest.isTimeout ? null : latest?.latencyMs ?? null,
      latestLatencyIsTimeout: !!latest?.isTimeout,
      latestLatencyAt: latest?.recordedAt ?? null,
    };
  });
}

/** Aggregate traffic series for one rule by time bucket. */
export async function getTrafficSeriesByRule(
  ruleId: number,
  opts: { bucketMinutes?: number; since?: Date } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; bytesIn: number; bytesOut: number; connections: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 1, 60);
  const since = opts.since ?? new Date(Date.now() - 60 * 60 * 1000);
  const rule = await getRuleWithCreatedAt(ruleId);
  const effectiveSince = rule?.createdAt && rule.createdAt > since ? rule.createdAt : since;
  const sinceSec = Math.floor(effectiveSince.getTime() / 1000);
  const bucketSec = bucket * 60;
  const { queryRuleIds } = await expandTrafficQueryRuleIds([ruleId]);
  const effectiveRuleIds = queryRuleIds.length > 0 ? queryRuleIds : [ruleId];

  const q = quoteIdentifier;
  const useBuckets = bucket === TRAFFIC_BUCKET_MINUTES && await trafficBucketsReady() && canUseTrafficBuckets(since);
  const bucketRows = useBuckets
    ? await queryRaw<{ bucket: number; bytesIn: number; bytesOut: number; connections: number }>(
      `SELECT b.${q("bucketStart")} AS ${q("bucket")},
              COALESCE(SUM(b.${q("bytesIn")}), 0) AS ${q("bytesIn")},
              COALESCE(SUM(b.${q("bytesOut")}), 0) AS ${q("bytesOut")},
              COALESCE(SUM(b.${q("connections")}), 0) AS ${q("connections")}
         FROM ${q("traffic_stat_buckets")} b
        WHERE b.${q("bucketMinutes")} = ?
          AND b.${q("ruleId")} IN (${effectiveRuleIds.map(() => "?").join(",")})
          AND b.${q("bucketStart")} >= ?
        GROUP BY b.${q("bucketStart")}
        ORDER BY b.${q("bucketStart")} ASC`,
      [TRAFFIC_BUCKET_MINUTES, ...effectiveRuleIds, bucketStartFor(sinceSec)],
    ).catch(() => null)
    : null;
  const rows = bucketRows && bucketRows.length > 0 ? bucketRows : await queryRaw<{ bucket: number; bytesIn: number; bytesOut: number; connections: number }>(
      `SELECT ${bucketExprSql("ts", bucketSec)} AS ${q("bucket")},
              COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
              COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")},
              COALESCE(SUM(ts.${q("connections")}), 0) AS ${q("connections")}
         FROM ${q("traffic_stats")} ts
        WHERE ts.${q("ruleId")} IN (${effectiveRuleIds.map(() => "?").join(",")})
          AND ts.${q("recordedAt")} >= ?
        GROUP BY ${bucketExprSql("ts", bucketSec)}
        ORDER BY ${q("bucket")} ASC`,
      [...effectiveRuleIds, sinceSec],
    );

  return rows.map((r: any) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    bytesIn: Number(r.bytesIn) || 0,
    bytesOut: Number(r.bytesOut) || 0,
    connections: Number(r.connections) || 0,
  })).filter((r: { bucket: Date }) => r.bucket.getTime() / 1000 >= sinceSec);
}

/**
 * 一批规则各自的流量走势（规则卡上那条小走势线）。
 *
 * 一页几十张卡各发一次 getTrafficSeriesByRule 就是几十条 SQL，这里一条 GROUP BY ruleId, bucket
 * 出全部；转发组子规则的字节记到父规则头上（和 getTrafficSeriesByRule 的口径一致）。
 * 有 30 分钟桶表且时间窗在桶的保留期内时读桶（再按请求的桶宽合并），否则读原始样本。
 */
export async function getTrafficSeriesByRules(
  ruleIds: number[],
  opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}
) {
  const db = await getDb();
  const empty = [] as Array<{ ruleId: number; bucket: Date; bytesIn: number; bytesOut: number }>;
  if (!db) return empty;
  const requestedRuleIds = Array.from(new Set(ruleIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (requestedRuleIds.length === 0) return empty;
  const bucket = clampPositiveInt(opts.bucketMinutes, 1, 24 * 60);
  const bucketSec = bucket * 60;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sinceSec = Math.floor(since.getTime() / 1000);
  const { queryRuleIds, parentByChildRuleId } = await expandTrafficQueryRuleIds(requestedRuleIds);
  const effectiveRuleIds = queryRuleIds.length > 0 ? queryRuleIds : requestedRuleIds;
  const q = quoteIdentifier;
  const placeholders = effectiveRuleIds.map(() => "?").join(",");
  const userJoin = opts.userId
    ? `INNER JOIN ${q("forward_rules")} fr ON fr.${q("id")} = src.${q("ruleId")}
       ${managedParentRuleJoin("fr")}`
    : "";
  const userWhere = opts.userId ? `AND COALESCE(parent.${q("userId")}, fr.${q("userId")}) = ?` : "";
  const userParams = opts.userId ? [opts.userId] : [];

  const useBuckets = bucket % TRAFFIC_BUCKET_MINUTES === 0 && await trafficBucketsReady() && canUseTrafficBuckets(since);
  const bucketRows = useBuckets
    ? await queryRaw<{ ruleId: number; bucket: number; bytesIn: number; bytesOut: number }>(
      `SELECT src.${q("ruleId")} AS ${q("ruleId")},
              ${bucketExpression("src", "bucketStart", bucketSec)} AS ${q("bucket")},
              COALESCE(SUM(src.${q("bytesIn")}), 0) AS ${q("bytesIn")},
              COALESCE(SUM(src.${q("bytesOut")}), 0) AS ${q("bytesOut")}
         FROM ${q("traffic_stat_buckets")} src
         ${userJoin}
        WHERE src.${q("bucketMinutes")} = ?
          AND src.${q("ruleId")} IN (${placeholders})
          AND src.${q("bucketStart")} >= ?
          ${userWhere}
        GROUP BY src.${q("ruleId")}, ${bucketExpression("src", "bucketStart", bucketSec)}
        ORDER BY ${q("bucket")} ASC`,
      [TRAFFIC_BUCKET_MINUTES, ...effectiveRuleIds, bucketStartFor(sinceSec), ...userParams],
    ).catch(() => null)
    : null;
  const rows = bucketRows && bucketRows.length > 0 ? bucketRows : await queryRaw<{ ruleId: number; bucket: number; bytesIn: number; bytesOut: number }>(
    `SELECT src.${q("ruleId")} AS ${q("ruleId")},
            ${bucketExprSql("src", bucketSec)} AS ${q("bucket")},
            COALESCE(SUM(src.${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(src.${q("bytesOut")}), 0) AS ${q("bytesOut")}
       FROM ${q("traffic_stats")} src
       ${userJoin}
      WHERE src.${q("ruleId")} IN (${placeholders})
        AND src.${q("recordedAt")} >= ?
        ${userWhere}
      GROUP BY src.${q("ruleId")}, ${bucketExprSql("src", bucketSec)}
      ORDER BY ${q("bucket")} ASC`,
    [...effectiveRuleIds, sinceSec, ...userParams],
  ).catch(() => [] as Array<{ ruleId: number; bucket: number; bytesIn: number; bytesOut: number }>);

  // 子规则并回父规则同一个桶
  const merged = new Map<string, { ruleId: number; bucket: number; bytesIn: number; bytesOut: number }>();
  for (const raw of rows as any[]) {
    const childId = Number(raw.ruleId);
    const ruleId = parentByChildRuleId.get(childId) ?? childId;
    const bucketAt = Number(raw.bucket);
    if (!Number.isFinite(bucketAt) || bucketAt < sinceSec) continue;
    const key = `${ruleId}:${bucketAt}`;
    const prev = merged.get(key);
    if (prev) {
      prev.bytesIn += Number(raw.bytesIn) || 0;
      prev.bytesOut += Number(raw.bytesOut) || 0;
    } else {
      merged.set(key, { ruleId, bucket: bucketAt, bytesIn: Number(raw.bytesIn) || 0, bytesOut: Number(raw.bytesOut) || 0 });
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => a.ruleId - b.ruleId || a.bucket - b.bucket)
    .map((r) => ({ ruleId: r.ruleId, bucket: new Date(r.bucket * 1000), bytesIn: r.bytesIn, bytesOut: r.bytesOut }));
}

/** Aggregate global traffic trend by time bucket for the dashboard. */
export async function getGlobalTrafficSeries(opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; bytesIn: number; bytesOut: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 5, 60);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = bucket * 60;
  const sinceSec = epochSeconds(since);
  const nowSec = epochSeconds(nowDate());
  const startBucketSec = Math.floor(sinceSec / bucketSec) * bucketSec;
  const endBucketSec = Math.floor(nowSec / bucketSec) * bucketSec;
  const q = quoteIdentifier;
  const trafficTable = q("traffic_stats");
  const rulesTable = q("forward_rules");
  const rawRows = (fromSec: number, toSec?: number) => {
    const timeWhere = `ts.${q("recordedAt")} >= ?${toSec === undefined ? "" : ` AND ts.${q("recordedAt")} < ?`}`;
    const timeParams = toSec === undefined ? [fromSec] : [fromSec, toSec];
    return opts.userId
      ? queryRaw<{ bucket: number; bytesIn: number; bytesOut: number }>(
          `SELECT ${bucketExprSql("ts", bucketSec)} AS ${q("bucket")},
                  COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
                  COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")}
             FROM ${trafficTable} ts
             INNER JOIN ${rulesTable} fr ON fr.${q("id")} = ts.${q("ruleId")}
             ${managedParentRuleJoin("fr")}
            WHERE ${timeWhere} AND COALESCE(parent.${q("userId")}, fr.${q("userId")}) = ?
            GROUP BY ${bucketExprSql("ts", bucketSec)}
            ORDER BY ${q("bucket")} ASC`,
          [...timeParams, opts.userId],
        )
      : queryRaw<{ bucket: number; bytesIn: number; bytesOut: number }>(
          `SELECT ${bucketExprSql("ts", bucketSec)} AS ${q("bucket")},
                  COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
                  COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")}
             FROM ${trafficTable} ts
            WHERE ${timeWhere}
            GROUP BY ${bucketExprSql("ts", bucketSec)}
            ORDER BY ${q("bucket")} ASC`,
          timeParams,
        );
  };
  /*
    桶宽是 30 分钟整数倍时，已经结束的整桶读 30 分钟桶表再并成请求的桶宽（每个 30 分钟桶
    整个落在一个输出桶里），窗口开头不满一桶的部分和当前这一桶读原始样本 —— 结果和整段扫
    原始样本相同（见 trafficWindowSplit）。按用户看时和原始样本一样 INNER JOIN 规则表。
  */
  const canUseBuckets = bucket % TRAFFIC_BUCKET_MINUTES === 0 && await trafficBucketsReady() && canUseTrafficBuckets(since);
  let rows: Array<{ bucket: number; bytesIn: number; bytesOut: number }> | null = null;
  if (canUseBuckets) {
    const { fullStart, fullEnd, tailStart } = trafficWindowSplit(sinceSec);
    const fullRows = fullStart < fullEnd
      ? await queryRaw<{ bucket: number; bytesIn: number; bytesOut: number }>(
        `SELECT ${bucketExpression("b", "bucketStart", bucketSec)} AS ${q("bucket")},
                COALESCE(SUM(b.${q("bytesIn")}), 0) AS ${q("bytesIn")},
                COALESCE(SUM(b.${q("bytesOut")}), 0) AS ${q("bytesOut")}
           FROM ${q("traffic_stat_buckets")} b
           ${opts.userId ? `INNER JOIN ${rulesTable} fr ON fr.${q("id")} = b.${q("ruleId")}
           ${managedParentRuleJoin("fr")}` : ""}
          WHERE b.${q("bucketMinutes")} = ?
            AND b.${q("bucketStart")} >= ?
            AND b.${q("bucketStart")} < ?
            ${opts.userId ? `AND COALESCE(parent.${q("userId")}, fr.${q("userId")}) = ?` : ""}
          GROUP BY ${bucketExpression("b", "bucketStart", bucketSec)}`,
        opts.userId ? [TRAFFIC_BUCKET_MINUTES, fullStart, fullEnd, opts.userId] : [TRAFFIC_BUCKET_MINUTES, fullStart, fullEnd],
      ).catch(() => null)
      : [];
    if (fullRows) {
      const headRows = sinceSec < fullStart ? await rawRows(sinceSec, fullStart) : [];
      rows = [...headRows, ...fullRows, ...await rawRows(tailStart)];
    }
  }
  if (!rows) rows = await rawRows(sinceSec);

  if (rows.length === 0) return [];

  const byBucket = new Map<number, { bytesIn: number; bytesOut: number }>();
  for (const row of rows as any[]) {
    const bucketValue = Number(row.bucket);
    if (!Number.isFinite(bucketValue)) continue;
    const prev = byBucket.get(bucketValue);
    byBucket.set(bucketValue, {
      bytesIn: (prev?.bytesIn ?? 0) + (Number(row.bytesIn) || 0),
      bytesOut: (prev?.bytesOut ?? 0) + (Number(row.bytesOut) || 0),
    });
  }

  const result: Array<{ bucket: Date; bytesIn: number; bytesOut: number }> = [];
  for (let bucketValue = startBucketSec; bucketValue <= endBucketSec; bucketValue += bucketSec) {
    const point = byBucket.get(bucketValue);
    result.push({
      bucket: new Date(bucketValue * 1000),
      bytesIn: point?.bytesIn ?? 0,
      bytesOut: point?.bytesOut ?? 0,
    });
  }
  return result;
}

// ==================== TCPing Stats ====================

export async function insertTcpingStat(stat: InsertTcpingStat) {
  const db = await getDb();
  if (!db) return;
  await db.insert(tcpingStats).values(withProbeCounts(stat) as InsertTcpingStat);
}

export async function insertTcpingStats(stats: InsertTcpingStat[]) {
  const db = await getDb();
  if (!db) return;
  if (stats.length === 0) return;
  await db.insert(tcpingStats).values(stats.map((stat) => withProbeCounts(stat)) as InsertTcpingStat[]);
}

/** Insert a tunnel latency sample and update latest tunnel test state. */
export async function insertTunnelLatencyStat(
  stat: InsertTunnelLatencyStat,
  options: { message?: string | null; preserveMessage?: boolean; updateTunnel?: boolean } = {},
) {
  const db = await getDb();
  if (!db) return;
  const normalizedStat = withProbeCounts(stat) as InsertTunnelLatencyStat;
  await db.insert(tunnelLatencyStats).values(normalizedStat);
  const seriesKey = String((stat as any).seriesKey || "").trim().toLowerCase();
  if (!seriesKey || seriesKey === "total") notifyTunnelLatencyRefresh(stat.tunnelId);
  if (options.updateTunnel === false) return;
  // Use the normalized counters for the live tunnel status as well as for the
  // stored row. Otherwise an explicit 0/N sample could be persisted as a
  // timeout while the tunnel summary was still updated to "success".
  const status = normalizedStat.isTimeout ? "failed" : "success";
  const now = nowDate();
  const updates: any = {
    lastLatencyMs: normalizedStat.isTimeout ? null : (normalizedStat.latencyMs ?? null),
    lastTestStatus: status,
    lastTestAt: now,
    updatedAt: now,
  };
  if (options.message !== undefined) {
    updates.lastTestMessage = options.message;
  } else if (!options.preserveMessage) {
    updates.lastTestMessage = null;
  }
  // Periodic health samples stay in history, but cannot complete a manual
  // test that is still pending/running, nor leave its pending details under a
  // periodic "success".
  await db.update(tunnels).set(updates).where(and(
    eq(tunnels.id, stat.tunnelId),
    ...(options.preserveMessage ? [or(isNull(tunnels.lastTestStatus), notInArray(tunnels.lastTestStatus, ["pending", "running"]))] : []),
  ));
}

export async function getLatestTunnelLatencies(tunnelIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(tunnelIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)));
  if (!db || ids.length === 0) {
    return new Map<number, { latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>();
  }
  const q = quoteIdentifier;
  const rows = await queryRaw<{ tunnelId: number; latencyMs: number | null; isTimeout: unknown; probeCount: unknown; probeSuccesses: unknown; recordedAt: unknown; seriesKey: string | null }>(
    `SELECT s.${q("tunnelId")} AS ${q("tunnelId")},
            s.${q("latencyMs")} AS ${q("latencyMs")},
            s.${q("isTimeout")} AS ${q("isTimeout")},
            s.${q("probeCount")} AS ${q("probeCount")},
            s.${q("probeSuccesses")} AS ${q("probeSuccesses")},
            s.${q("recordedAt")} AS ${q("recordedAt")},
            s.${q("seriesKey")} AS ${q("seriesKey")}
       FROM ${q("tunnel_latency_stats")} s
       INNER JOIN (
         SELECT ${q("tunnelId")},
                MAX(CASE WHEN ${q("seriesKey")} IS NULL OR ${q("seriesKey")} = '' OR ${q("seriesKey")} = 'total' THEN ${q("id")} ELSE NULL END) AS ${q("id")}
           FROM ${q("tunnel_latency_stats")}
          WHERE ${q("tunnelId")} IN (${ids.map(() => "?").join(",")})
          GROUP BY ${q("tunnelId")}
       ) latest ON latest.${q("tunnelId")} = s.${q("tunnelId")} AND latest.${q("id")} = s.${q("id")}`,
    ids,
  );
  const latest = new Map<number, { latencyMs: number | null; isTimeout: boolean; probeCount: number; probeSuccesses: number; recordedAt: Date }>();
  for (const row of rows) {
    latest.set(Number(row.tunnelId), {
      latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
      isTimeout: rowBool(row.isTimeout),
      ...mappedProbeCounts(row),
      recordedAt: rowDate(row.recordedAt),
    });
  }
  return latest;
}

function tunnelLatencySeriesSortRank(key: string) {
  if (key === "total") return [0, 0];
  if (key === "primary") return [1, 0];
  const match = key.match(/^exit-(\d+)$/);
  if (match) return [2, Number(match[1]) || 0];
  return [3, 0];
}

export async function getLatestTunnelLatencySeries(tunnelIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(tunnelIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)));
  if (!db || ids.length === 0) {
    return new Map<number, Array<{ seriesKey: string; seriesLabel: string | null; latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>>();
  }
  const q = quoteIdentifier;
  const seriesExpr = `COALESCE(NULLIF(s.${q("seriesKey")}, ''), 'total')`;
  const rows = await queryRaw<{ tunnelId: number; seriesKey: string | null; seriesLabel: string | null; latencyMs: number | null; isTimeout: unknown; probeCount: unknown; probeSuccesses: unknown; recordedAt: unknown }>(
    `SELECT s.${q("tunnelId")} AS ${q("tunnelId")},
            ${seriesExpr} AS ${q("seriesKey")},
            s.${q("seriesLabel")} AS ${q("seriesLabel")},
            s.${q("latencyMs")} AS ${q("latencyMs")},
            s.${q("isTimeout")} AS ${q("isTimeout")},
            s.${q("probeCount")} AS ${q("probeCount")},
            s.${q("probeSuccesses")} AS ${q("probeSuccesses")},
            s.${q("recordedAt")} AS ${q("recordedAt")}
       FROM ${q("tunnel_latency_stats")} s
       INNER JOIN (
         SELECT ${q("tunnelId")},
                COALESCE(NULLIF(${q("seriesKey")}, ''), 'total') AS ${q("seriesKey")},
                MAX(${q("id")}) AS ${q("id")}
           FROM ${q("tunnel_latency_stats")}
          WHERE ${q("tunnelId")} IN (${ids.map(() => "?").join(",")})
          GROUP BY ${q("tunnelId")}, COALESCE(NULLIF(${q("seriesKey")}, ''), 'total')
       ) latest ON latest.${q("tunnelId")} = s.${q("tunnelId")} AND latest.${q("id")} = s.${q("id")}` ,
    ids,
  );
  const grouped = new Map<number, Array<{ seriesKey: string; seriesLabel: string | null; latencyMs: number | null; isTimeout: boolean; probeCount: number; probeSuccesses: number; recordedAt: Date }>>();
  for (const row of rows) {
    const tunnelId = Number(row.tunnelId);
    if (!Number.isFinite(tunnelId) || tunnelId <= 0) continue;
    const seriesKey = normalizeLatencySeriesKey(row.seriesKey);
    const series = grouped.get(tunnelId) || [];
    series.push({
      seriesKey,
      seriesLabel: row.seriesLabel ? String(row.seriesLabel) : null,
      latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
      isTimeout: rowBool(row.isTimeout),
      ...mappedProbeCounts(row),
      recordedAt: rowDate(row.recordedAt),
    });
    grouped.set(tunnelId, series);
  }
  for (const series of grouped.values()) {
    series.sort((a, b) => {
      const [rankA, tieA] = tunnelLatencySeriesSortRank(a.seriesKey);
      const [rankB, tieB] = tunnelLatencySeriesSortRank(b.seriesKey);
      if (rankA !== rankB) return rankA - rankB;
      if (tieA !== tieB) return tieA - tieB;
      return a.seriesKey.localeCompare(b.seriesKey, "en");
    });
  }
  return grouped;
}

export async function getTunnelLatencyBranchSeriesForTotal(tunnelId: number, totalId: number) {
  const db = await getDb();
  const normalizedTunnelId = Number(tunnelId);
  const normalizedTotalId = Number(totalId);
  if (
    !db
    || !Number.isInteger(normalizedTunnelId)
    || normalizedTunnelId <= 0
    || !Number.isInteger(normalizedTotalId)
    || normalizedTotalId <= 0
  ) {
    return [] as Array<{ seriesKey: string; seriesLabel: string | null; latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>;
  }
  const q = quoteIdentifier;
  const totalSeries = `(s.${q("seriesKey")} IS NULL OR s.${q("seriesKey")} = '' OR s.${q("seriesKey")} = 'total')`;
  const previousTotalSeries = `(previous.${q("seriesKey")} IS NULL OR previous.${q("seriesKey")} = '' OR previous.${q("seriesKey")} = 'total')`;
  const rows = await queryRaw<{ seriesKey: string | null; seriesLabel: string | null; latencyMs: number | null; isTimeout: unknown; probeCount: unknown; probeSuccesses: unknown; recordedAt: unknown }>(
    `SELECT s.${q("seriesKey")} AS ${q("seriesKey")},
            s.${q("seriesLabel")} AS ${q("seriesLabel")},
            s.${q("latencyMs")} AS ${q("latencyMs")},
            s.${q("isTimeout")} AS ${q("isTimeout")},
            s.${q("probeCount")} AS ${q("probeCount")},
            s.${q("probeSuccesses")} AS ${q("probeSuccesses")},
            s.${q("recordedAt")} AS ${q("recordedAt")}
       FROM ${q("tunnel_latency_stats")} s
      WHERE s.${q("tunnelId")} = ?
        AND s.${q("id")} > COALESCE((
          SELECT MAX(previous.${q("id")})
            FROM ${q("tunnel_latency_stats")} previous
           WHERE previous.${q("tunnelId")} = ?
             AND previous.${q("id")} < ?
             AND ${previousTotalSeries}
        ), 0)
        AND s.${q("id")} < ?
        AND NOT ${totalSeries}
        AND EXISTS (
          SELECT 1
            FROM ${q("tunnel_latency_stats")} current_total
           WHERE current_total.${q("id")} = ?
             AND current_total.${q("tunnelId")} = ?
             AND (current_total.${q("seriesKey")} IS NULL OR current_total.${q("seriesKey")} = '' OR current_total.${q("seriesKey")} = 'total')
        )
      ORDER BY s.${q("id")} ASC`,
    [normalizedTunnelId, normalizedTunnelId, normalizedTotalId, normalizedTotalId, normalizedTotalId, normalizedTunnelId],
  );
  return rows.map((row) => ({
    ...mappedProbeCounts(row),
    seriesKey: normalizeLatencySeriesKey(row.seriesKey),
    seriesLabel: row.seriesLabel ? String(row.seriesLabel) : null,
    latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
    isTimeout: rowBool(row.isTimeout),
    recordedAt: rowDate(row.recordedAt),
  }));
}

export async function getTunnelLatencySeries(
  tunnelId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; probeCount: number; probeSuccesses: number; recordedAt: Date; seriesKey: string; seriesLabel: string | null }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = clampPositiveInt(opts.limit, 20_000, 50_000);
  const q = quoteIdentifier;
  const startedAt = Date.now();
  const page = limitOffset(limit);
  const rows = await queryRaw<{ latencyMs: number | null; isTimeout: unknown; probeCount: unknown; probeSuccesses: unknown; recordedAt: unknown; seriesKey: string | null; seriesLabel: string | null }>(
    `SELECT ${q("latencyMs")}, ${q("isTimeout")}, ${q("probeCount")}, ${q("probeSuccesses")}, ${q("recordedAt")}, ${q("seriesKey")}, ${q("seriesLabel")}
       FROM ${q("tunnel_latency_stats")}
      WHERE ${q("tunnelId")} = ? AND ${q("recordedAt")} >= ?
      ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
      ${page.sql}`,
    [tunnelId, epochSeconds(since), ...page.params],
  );
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 800) {
    console.warn(`[TunnelLatency] slow tunnel=${tunnelId} rows=${rows.length} elapsedMs=${elapsedMs}`);
  }
  return rows.reverse().map((row) => {
    const key = String(row.seriesKey || "").trim();
    return {
      latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
      isTimeout: rowBool(row.isTimeout),
      ...mappedProbeCounts(row),
      recordedAt: rowDate(row.recordedAt),
      seriesKey: key || "total",
      seriesLabel: row.seriesLabel ? String(row.seriesLabel) : null,
    };
  });
}

/**
 * 一批隧道近 N 小时的逐时延迟（链路卡上那条小走势）：每条隧道每个整点一行，平均 / 最高 / 样本数。
 *
 * 只取「总延迟」那一条序列（seriesKey = total，老数据是空的），超时的样本没有毫秒数，
 * 自然不进平均（AVG / MAX / COUNT(列) 都跳过 NULL）。attempts 是这一桶里全部探测记录（含超时），
 * samples / attempts 就是这一段的可用率 —— 链路卡上和延迟写在一起。
 * 普通用户传 userId 只看自己的隧道；管理员不传。
 */
export async function getTunnelLatencySparkBatch(
  tunnelIds: number[],
  opts: { since?: Date; bucketMinutes?: number; userId?: number } = {},
) {
  const db = await getDb();
  const ids = [...new Set(tunnelIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!db || ids.length === 0) return [] as Array<{ tunnelId: number; bucket: Date; avgMs: number; maxMs: number; samples: number; attempts: number }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = Math.max(60, Math.floor((opts.bucketMinutes ?? 60) * 60));
  const q = quoteIdentifier;
  const placeholders = ids.map(() => "?").join(", ");
  const userJoin = opts.userId
    ? `INNER JOIN ${q("tunnels")} t ON t.${q("id")} = s.${q("tunnelId")} AND t.${q("userId")} = ?`
    : "";
  const params: unknown[] = opts.userId ? [opts.userId] : [];
  params.push(...ids, epochSeconds(since));
  const startedAt = Date.now();
  const rows = await queryRaw<{ tunnelId: unknown; bucket: unknown; avgMs: unknown; maxMs: unknown; samples: unknown; attempts: unknown }>(
    `SELECT s.${q("tunnelId")} AS ${q("tunnelId")}, ${bucketExprSql("s", bucketSec)} AS ${q("bucket")},
            AVG(s.${q("latencyMs")}) AS ${q("avgMs")}, MAX(s.${q("latencyMs")}) AS ${q("maxMs")},
            COUNT(s.${q("latencyMs")}) AS ${q("samples")}, COUNT(*) AS ${q("attempts")}
       FROM ${q("tunnel_latency_stats")} s
       ${userJoin}
      WHERE s.${q("tunnelId")} IN (${placeholders})
        AND s.${q("recordedAt")} >= ?
        AND (s.${q("seriesKey")} = 'total' OR s.${q("seriesKey")} IS NULL OR s.${q("seriesKey")} = '')
      GROUP BY s.${q("tunnelId")}, ${bucketExprSql("s", bucketSec)}
      ORDER BY s.${q("tunnelId")}, ${q("bucket")}`,
    params,
  );
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 800) {
    console.warn(`[TunnelLatency] slow spark batch tunnels=${ids.length} rows=${rows.length} elapsedMs=${elapsedMs}`);
  }
  return rows.map((row) => ({
    tunnelId: Number(row.tunnelId),
    bucket: rowDate(row.bucket),
    avgMs: Math.round(numeric(row.avgMs)),
    maxMs: Math.round(numeric(row.maxMs)),
    samples: numeric(row.samples),
    attempts: numeric(row.attempts),
  }));
}

export async function insertForwardGroupLatencyStat(stat: InsertForwardGroupLatencyStat) {
  const db = await getDb();
  if (!db) return;
  await db.insert(forwardGroupLatencyStats).values(withProbeCounts(stat) as InsertForwardGroupLatencyStat);
}

export async function getForwardGroupLatencySeries(
  groupId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; probeCount: number; probeSuccesses: number; recordedAt: Date }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = clampPositiveInt(opts.limit, 2880, 10_000);
  const q = quoteIdentifier;
  const startedAt = Date.now();
  const page = limitOffset(limit);
  const rows = await queryRaw<{ latencyMs: number | null; isTimeout: unknown; probeCount: unknown; probeSuccesses: unknown; recordedAt: unknown }>(
    `SELECT ${q("latencyMs")}, ${q("isTimeout")}, ${q("probeCount")}, ${q("probeSuccesses")}, ${q("recordedAt")}
       FROM ${q("forward_group_latency_stats")}
      WHERE ${q("groupId")} = ? AND ${q("recordedAt")} >= ?
      ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
      ${page.sql}`,
    [groupId, epochSeconds(since), ...page.params],
  );
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 800) {
    console.warn(`[ForwardGroupLatency] slow group=${groupId} rows=${rows.length} elapsedMs=${elapsedMs}`);
  }
  return rows.reverse().map((row) => ({
    latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
    isTimeout: rowBool(row.isTimeout),
    ...mappedProbeCounts(row),
    recordedAt: rowDate(row.recordedAt),
  }));
}

export async function getTcpingSeriesByRule(
  ruleId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; probeCount: number; probeSuccesses: number; recordedAt: Date }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = clampPositiveInt(opts.limit, 2880, 10_000); // 24h * 120 per hour max
  const q = quoteIdentifier;
  let seriesRuleId = ruleId;
  const chainGroupId = await getChainGroupIdForTemplateRule(ruleId);
  if (chainGroupId) {
    const groupSeries = await getForwardGroupLatencySeries(chainGroupId, { since, limit });
    if (groupSeries.length > 0) return groupSeries;
  }
  const childRows = await db
    .select({
      id: forwardRules.id,
      groupId: forwardRules.forwardGroupId,
      parentId: forwardRules.forwardGroupRuleId,
      memberId: forwardRules.forwardGroupMemberId,
    })
    .from(forwardRules)
    .where(and(eq(forwardRules.forwardGroupRuleId, ruleId), eq(forwardRules.pendingDelete, false)))
    .orderBy(asc(forwardRules.id));
  if (childRows.length > 0) {
    const groupModeById = await getForwardGroupModeMap((childRows as any[]).map((row: any) => Number(row.groupId || 0)));
    const chainChildren = (childRows as any[]).filter((row: any) => groupModeById.get(Number(row.groupId || 0)) === "chain");
    if (chainChildren.length > 0) {
      const childIds = chainChildren.map((row: any) => Number(row.id)).filter((id: number) => id > 0);
      const page = limitOffset(Math.max(limit * childIds.length, limit));
      const rawRows = await queryRaw<any>(
        `SELECT ${q("ruleId")}, ${q("latencyMs")}, ${q("isTimeout")}, ${q("probeCount")}, ${q("probeSuccesses")}, ${q("recordedAt")}
           FROM ${q("tcping_stats")}
         WHERE ${q("ruleId")} IN (${childIds.map(() => "?").join(",")})
           AND ${q("recordedAt")} >= ?
          ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
          ${page.sql}`,
        [...childIds, epochSeconds(since), ...page.params],
      );
      const bucketMs = 30_000;
      const byBucket = new Map<number, {
        latencyMs: number;
        timeoutCount: number;
        count: number;
        probeCount: number;
        probeSuccesses: number;
        recordedAt: Date;
      }>();
      for (const row of (rawRows as any[]).reverse()) {
        const at = rowDate(row.recordedAt);
        const key = Math.floor(at.getTime() / bucketMs) * bucketMs;
        const prev = byBucket.get(key) || {
          latencyMs: 0,
          timeoutCount: 0,
          count: 0,
          probeCount: 0,
          probeSuccesses: 0,
          recordedAt: at,
        };
        // Child rows may represent a multi-packet ping. Preserve those
        // counters while retaining the historical chain latency aggregation.
        const rawProbeCount = Number(row.probeCount);
        const probeCount = Number.isInteger(rawProbeCount) && rawProbeCount >= 1 && rawProbeCount <= 1024
          ? rawProbeCount
          : 1;
        const rawProbeSuccesses = Number(row.probeSuccesses);
        let probeSuccesses = Number.isInteger(rawProbeSuccesses)
          ? Math.max(0, Math.min(probeCount, rawProbeSuccesses))
          : (rowBool(row.isTimeout) ? 0 : probeCount);
        // Rows written before the counters existed (or by an older panel
        // after the columns were added) have a zero success default while
        // still carrying isTimeout=false. Treat those as one successful
        // sample for backwards compatibility.
        if (!rowBool(row.isTimeout) && probeSuccesses === 0) probeSuccesses = probeCount;
        prev.probeCount += probeCount;
        prev.probeSuccesses += probeSuccesses;
        if (probeSuccesses <= 0 || row.latencyMs === null || row.latencyMs === undefined) {
          prev.timeoutCount += probeCount;
        } else {
          prev.latencyMs += Number(row.latencyMs) || 0;
        }
        prev.count += 1;
        if (at.getTime() > new Date(prev.recordedAt).getTime()) prev.recordedAt = at;
        byBucket.set(key, prev);
      }
      return Array.from(byBucket.entries())
        .sort((a, b) => a[0] - b[0])
        .slice(-limit)
        .map(([, bucket]) => {
          // A bucket is a timeout only when every represented packet failed.
          // Partial packet loss must remain a valid latency sample so the
          // chart can calculate a non-zero loss rate from the counters.
          // A child that did not report in this bucket is retained as one
          // failed attempt, matching the pre-counter chain semantics.
          const missingChildAttempts = Math.max(0, childIds.length - bucket.count);
          const totalProbeCount = Math.max(1, bucket.probeCount + missingChildAttempts);
          const probeSuccesses = Math.max(0, Math.min(totalProbeCount, bucket.probeSuccesses));
          const isTimeout = probeSuccesses <= 0;
          return {
            latencyMs: isTimeout ? null : bucket.latencyMs,
            isTimeout,
            probeCount: totalProbeCount,
            probeSuccesses,
            recordedAt: bucket.recordedAt,
          };
        });
    }
    const nonChainChildren = (childRows as any[])
      .map((row: any) => ({
        id: Number(row.id || 0),
        groupId: Number(row.groupId || 0),
        memberId: Number(row.memberId || 0),
      }))
      .filter((row: ForwardGroupLatencyChildRow) => row.id > 0 && groupModeById.get(row.groupId) !== "chain");
    if (nonChainChildren.length > 0) {
      const groupId = Number(nonChainChildren[0].groupId || 0);
      const groupChildren = nonChainChildren.filter((row: ForwardGroupLatencyChildRow) => row.groupId === groupId);
      const [activeMemberByGroup, firstMemberByGroup] = await Promise.all([
        getActiveMemberByGroup([groupId]),
        getFirstEnabledMemberByGroup([groupId]),
      ]);
      const selectedChild = selectPreferredForwardGroupLatencyChild(groupChildren, [
        Number(activeMemberByGroup.get(groupId) || 0),
        Number(firstMemberByGroup.get(groupId)?.id || 0),
      ]);
      if (selectedChild) seriesRuleId = selectedChild.id;
    }
  }
  const page = limitOffset(limit);
  const rows = await queryRaw<any>(
    `SELECT ${q("latencyMs")}, ${q("isTimeout")}, ${q("probeCount")}, ${q("probeSuccesses")}, ${q("recordedAt")}
       FROM ${q("tcping_stats")}
      WHERE ${q("ruleId")} = ? AND ${q("recordedAt")} >= ?
      ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
      ${page.sql}`,
    [seriesRuleId, epochSeconds(since), ...page.params],
  );
  return rows.reverse().map((row) => ({
    latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
    isTimeout: rowBool(row.isTimeout),
    ...mappedProbeCounts(row),
    recordedAt: rowDate(row.recordedAt),
  }));
}

/**
 * 端到端探测一直不通的转发（订阅「自动隐藏不通的节点」用）。
 *
 * 只看最近一小段时间的探测：判定本身只要最近几次，窗口给宽一点是为了探测间隔
 * 长的转发也凑得够次数。多台入口的转发（入口组）各台的探测混在一起按时间排，
 * 只要有一次通就不算不通。
 */
export async function getUnreachableRuleIds(ruleIds: number[], now = Date.now()): Promise<Set<number>> {
  const ids = Array.from(new Set(ruleIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const result = new Set<number>();
  if (ids.length === 0) return result;
  const q = quoteIdentifier;
  const since = new Date(now - 15 * 60 * 1000);
  const rows = await queryRaw<any>(
    `SELECT ${q("ruleId")}, ${q("isTimeout")}, ${q("recordedAt")}
       FROM ${q("tcping_stats")}
      WHERE ${q("ruleId")} IN (${ids.map(() => "?").join(", ")}) AND ${q("recordedAt")} >= ?
      ORDER BY ${q("ruleId")}, ${q("recordedAt")} DESC, ${q("id")} DESC`,
    [...ids, epochSeconds(since)],
  ).catch(() => [] as any[]);
  const byRule = new Map<number, Array<{ isTimeout: boolean; recordedAt: Date }>>();
  for (const row of rows) {
    const ruleId = Number(row.ruleId);
    const list = byRule.get(ruleId) || [];
    list.push({ isTimeout: rowBool(row.isTimeout), recordedAt: rowDate(row.recordedAt) });
    byRule.set(ruleId, list);
  }
  for (const [ruleId, samples] of byRule) {
    if (isRuleProbeUnreachable(samples, now)) result.add(ruleId);
  }
  return result;
}

/** Aggregate global TCPing latency trend by time bucket. */
export async function getGlobalTcpingSeries(opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; avgLatency: number; maxLatency: number; minLatency: number; timeoutCount: number; totalCount: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 1, 60);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = bucket * 60;
  const q = quoteIdentifier;
  const conditions = [`s.${q("recordedAt")} >= ?`];
  const params: any[] = [epochSeconds(since)];
  if (opts.userId) {
    const ruleIds = await getRuleIdsByUser(opts.userId);
    if (ruleIds.length === 0) return [];
    conditions.push(`s.${q("ruleId")} IN (${ruleIds.map(() => "?").join(",")})`);
    params.push(...ruleIds);
  }
  const bucketExpr = bucketExprSql("s", bucketSec);
  const effectiveProbeCount = `CASE WHEN s.${q("probeCount")} BETWEEN 1 AND 1024 THEN s.${q("probeCount")} ELSE 1 END`;
  const effectiveProbeSuccesses = `CASE
      WHEN s.${q("isTimeout")} = ${rawBoolSql(true)}
           AND (s.${q("probeSuccesses")} IS NULL OR s.${q("probeSuccesses")} <= 0) THEN 0
      WHEN s.${q("probeSuccesses")} > 0 THEN
        CASE WHEN s.${q("probeSuccesses")} > (${effectiveProbeCount})
             THEN (${effectiveProbeCount}) ELSE s.${q("probeSuccesses")} END
      WHEN s.${q("isTimeout")} = ${rawBoolSql(true)} THEN 0
      ELSE (${effectiveProbeCount})
    END`;
  const rows = await queryRaw<any>(
    `SELECT ${bucketExpr} AS ${q("bucket")},
            COALESCE(AVG(CASE WHEN (${effectiveProbeSuccesses}) > 0 AND s.${q("latencyMs")} IS NOT NULL THEN s.${q("latencyMs")} END), 0) AS ${q("avgLatency")},
            COALESCE(MAX(CASE WHEN (${effectiveProbeSuccesses}) > 0 AND s.${q("latencyMs")} IS NOT NULL THEN s.${q("latencyMs")} END), 0) AS ${q("maxLatency")},
            COALESCE(MIN(CASE WHEN (${effectiveProbeSuccesses}) > 0 AND s.${q("latencyMs")} IS NOT NULL THEN s.${q("latencyMs")} END), 0) AS ${q("minLatency")},
            SUM((${effectiveProbeCount}) - (${effectiveProbeSuccesses})) AS ${q("timeoutCount")},
            SUM(${effectiveProbeCount}) AS ${q("totalCount")}
       FROM ${q("tcping_stats")} s
      WHERE ${conditions.join(" AND ")}
      GROUP BY ${bucketExpr}
      ORDER BY ${q("bucket")} ASC`,
    params,
  );

  return rows.map((r: any) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    avgLatency: Math.round(Number(r.avgLatency) || 0),
    maxLatency: Number(r.maxLatency) || 0,
    minLatency: Number(r.minLatency) || 0,
    timeoutCount: Number(r.timeoutCount) || 0,
    totalCount: Number(r.totalCount) || 0,
  }));
}

/**
 * Cumulative real-probe statistics for the rule's latency dialog. Resolves the
 * same active series as getTcpingSeriesByRule (chain template -> group, failover
 * template -> active member child), but never manufactures failed probes for
 * unreported children or reuses cached tunnel samples. `available: false`
 * means no Agent counters (old Agent): callers fall back to the sample rows.
 */
export async function getTcpingProbeStatisticsByRule(ruleId: number, since: Date) {
  const db = await getDb();
  if (!db) return getProbeCounterStatistics("rule", [], since);
  const chainGroupId = await getChainGroupIdForTemplateRule(ruleId);
  if (chainGroupId) return getProbeCounterStatistics("forwardGroup", chainGroupId, since);
  const children = await db.select({
    id: forwardRules.id, groupId: forwardRules.forwardGroupId,
    parentId: forwardRules.forwardGroupRuleId, memberId: forwardRules.forwardGroupMemberId,
  }).from(forwardRules).where(and(eq(forwardRules.forwardGroupRuleId, ruleId), eq(forwardRules.pendingDelete, false)))
    .orderBy(asc(forwardRules.id));
  if (!children.length) return getProbeCounterStatistics("rule", ruleId, since);
  const modes = await getForwardGroupModeMap(children.map((row: any) => Number(row.groupId || 0)));
  const chain = children.filter((row: any) => modes.get(Number(row.groupId)) === "chain");
  if (chain.length) return getProbeCounterStatistics("forwardGroup", Number(chain[0].groupId), since);
  const groupId = Number(children[0].groupId);
  const [active, first] = await Promise.all([getActiveMemberByGroup([groupId]), getFirstEnabledMemberByGroup([groupId])]);
  const selected = selectPreferredForwardGroupLatencyChild(children
    .filter((row: any) => Number(row.groupId) === groupId)
    .map((row: any) => ({ id: Number(row.id), groupId: Number(row.groupId), memberId: Number(row.memberId) })),
  [Number(active.get(groupId) || 0), Number(first.get(groupId)?.id || 0)]);
  return getProbeCounterStatistics("rule", selected?.id || ruleId, since);
}

/** Clean expired TCPing data, keeping the most recent N hours. */
/**
 * 名字只提了 tcping，实际上连转发组的延迟历史和累计探测计数快照一起清 —— 这几张表是同一轮探测写下的。
 *
 * 写在这里说一句，是因为按名字找不到它：`forward_group_latency_stats` 看上去
 * 像一张没人清的表（它的兄弟 tunnel_latency_stats 有自己的清理函数），照着名字
 * 搜一遍会得出「漏了」的结论，然后再加一个重复的清理。
 */
export async function cleanOldTcpingStats(retainHours: number = 72) {
  const db = await getDb();
  if (!db) return;
  const cutoff = retentionCutoffSeconds(retainHours);
  await deleteExpiredHistoryRows("tcping_stats", "recordedAt", cutoff);
  await deleteExpiredHistoryRows("forward_group_latency_stats", "recordedAt", cutoff);
  await deleteExpiredHistoryRows("probe_counter_snapshots", "recordedAt", cutoff);
}

export async function cleanOldTunnelLatencyStats(retainHours: number = 72) {
  const db = await getDb();
  if (!db) return;
  const cutoff = retentionCutoffSeconds(retainHours);
  await deleteExpiredHistoryRows("tunnel_latency_stats", "recordedAt", cutoff);
}

export type TimedOutForwardTest = {
  id: number;
  ruleId: number;
  hostId: number;
  message: string | null;
  requestMessage?: string | null;
  batchId?: string | null;
  timeoutSeconds?: number;
};

type ActiveForwardTestCandidate = TimedOutForwardTest & {
  status: string;
  createdAt: number;
  updatedAt: number;
  firstDispatchedAt?: number | null;
};

export async function timeoutStaleForwardTests(
  ttlSeconds: number = 60,
  timeoutForTest?: (test: TimedOutForwardTest) => number,
): Promise<TimedOutForwardTest[]> {
  const db = await getDb();
  if (!db) return [];
  const baseTimeoutSeconds = Math.max(1, Math.floor(Number(ttlSeconds) || 60));
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const baseCutoffSec = Math.floor((nowMs - baseTimeoutSeconds * 1000) / 1000);
  const candidates = await queryRaw<ActiveForwardTestCandidate>(
    `SELECT ${quoteIdentifier("id")}, ${quoteIdentifier("ruleId")}, ${quoteIdentifier("hostId")}, ${quoteIdentifier("message")},
            ${quoteIdentifier("requestMessage")}, ${quoteIdentifier("batchId")}, ${quoteIdentifier("firstDispatchedAt")},
            ${quoteIdentifier("status")}, ${quoteIdentifier("createdAt")}, ${quoteIdentifier("updatedAt")}
     FROM ${quoteIdentifier("forward_tests")}
     WHERE (${quoteIdentifier("status")} = 'pending' AND ${quoteIdentifier("createdAt")} < ?)
        OR (${quoteIdentifier("status")} = 'running' AND COALESCE(${quoteIdentifier("firstDispatchedAt")}, ${quoteIdentifier("updatedAt")}) < ?)
        OR (${quoteIdentifier("status")} IN ('pending', 'running') AND ${quoteIdentifier("createdAt")} < ?)`,
    [baseCutoffSec, baseCutoffSec, nowSec - SELF_TEST_MAX_LIFETIME_SECONDS],
  );
  if (candidates.length === 0) return [];

  const timeoutById = new Map<number, number>();
  for (const candidate of candidates) {
    const id = Number(candidate.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const requestedTimeout = Number(timeoutForTest?.(candidate));
    const effectiveTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.max(baseTimeoutSeconds, Math.floor(requestedTimeout))
      : baseTimeoutSeconds;
    // A running test's deadline counts from its first dispatch: lease renewals
    // (redelivery to a polling Agent) must not postpone the timeout forever.
    const referenceSec = String(candidate.status) === "running"
      ? Number(candidate.firstDispatchedAt ?? candidate.updatedAt)
      : Number(candidate.createdAt);
    const cutoffSec = Math.floor((nowMs - effectiveTimeout * 1000) / 1000);
    const lifetimeExceeded = Number(candidate.createdAt) < nowSec - SELF_TEST_MAX_LIFETIME_SECONDS;
    if (!lifetimeExceeded && (!Number.isFinite(referenceSec) || referenceSec >= cutoffSec)) continue;
    timeoutById.set(id, effectiveTimeout);
  }
  if (timeoutById.size === 0) return [];

  const kind = getDatabaseKind();
  const messageExpr = kind === "mysql"
    ? "CONCAT('自测超时：Agent 未在', ?, '秒内上报结果，请检查 Agent 是否在线或已升级到最新版本')"
    : "('自测超时：Agent 未在' || ? || '秒内上报结果，请检查 Agent 是否在线或已升级到最新版本')";
  const changedIds: number[] = [];
  for (const [id, effectiveTimeout] of timeoutById.entries()) {
    const cutoffSec = Math.floor((nowMs - effectiveTimeout * 1000) / 1000);
    const info: any = await executeRaw(
      `UPDATE ${quoteIdentifier("forward_tests")}
       SET ${quoteIdentifier("status")} = 'timeout',
           ${quoteIdentifier("message")} = COALESCE(NULLIF(${quoteIdentifier("message")}, ''), ${messageExpr}),
           ${quoteIdentifier("updatedAt")} = ?
       WHERE ${quoteIdentifier("id")} = ?
         AND ((${quoteIdentifier("status")} = 'pending' AND ${quoteIdentifier("createdAt")} < ?)
           OR (${quoteIdentifier("status")} = 'running' AND COALESCE(${quoteIdentifier("firstDispatchedAt")}, ${quoteIdentifier("updatedAt")}) < ?)
           OR (${quoteIdentifier("status")} IN ('pending', 'running') AND ${quoteIdentifier("createdAt")} < ?))`,
      [effectiveTimeout, nowSec, id, cutoffSec, cutoffSec, nowSec - SELF_TEST_MAX_LIFETIME_SECONDS],
    );
    if (rawAffectedRows(info) > 0) changedIds.push(id);
  }
  if (changedIds.length === 0) return [];
  const placeholders = changedIds.map(() => "?").join(", ");
  const timedOut = await queryRaw<TimedOutForwardTest>(
    `SELECT ${quoteIdentifier("id")}, ${quoteIdentifier("ruleId")}, ${quoteIdentifier("hostId")}, ${quoteIdentifier("message")},
            ${quoteIdentifier("requestMessage")}, ${quoteIdentifier("batchId")}
     FROM ${quoteIdentifier("forward_tests")}
     WHERE ${quoteIdentifier("id")} IN (${placeholders})
       AND ${quoteIdentifier("status")} = 'timeout'
       AND ${quoteIdentifier("updatedAt")} = ?`,
    [...changedIds, nowSec],
  );
  return timedOut.map((test) => ({
    ...test,
    timeoutSeconds: timeoutById.get(Number(test.id)) || baseTimeoutSeconds,
  }));
}
