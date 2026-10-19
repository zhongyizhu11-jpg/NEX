import { executeRaw, getDatabaseKind, queryRaw, withDatabaseTransaction } from "../dbRuntime";
import { boolLiteral, castInteger, quoteIdentifier as q } from "../dbCompat";
import { getSetting, setSetting } from "./settingsRepository";
import { deleteExpiredHistoryRows } from "./historyRetention";

/*
  主机探测（设置里的「服务探测」）的按小时汇总，让服务延迟图表能看 7 天、30 天。

  原始样本 host_probe_service_stats 照旧只留 72 小时（一个服务每台主机几十秒一条，留 30 天库要涨
  10 倍）；这里另建 host_probe_service_hourly，每个（服务, 主机, 小时）一行，30 天就是 720 行。
  做法和按天汇总（latencyDailyRepository.ts）一样：记水位，每次把 [水位, 现在 - 5 分钟) 的原始样本
  按小时聚合后**加**进小时表、推进水位，两步在同一个事务里，崩在中间不会重复计数。

  72 小时以内图表还是读原始样本（更细）；更长的才读这张表。
*/

export const HOST_PROBE_HOURLY_TABLE = "host_probe_service_hourly";
export const HOST_PROBE_HOURLY_WATERMARK_KEY = "hostProbeHourlyRollupThrough";
export const HOST_PROBE_HISTORY_DAYS = 30;
/** 超过这么多小时的图表读小时表（原始样本的保留期）。 */
export const HOST_PROBE_RAW_MAX_HOURS = 72;
const HOUR_SECONDS = 3600;
const ROLLUP_LAG_SECONDS = 5 * 60;
const ROLLUP_MAX_WINDOW_SECONDS = 6 * 3600;
const RAW_RETENTION_SECONDS = HOST_PROBE_RAW_MAX_HOURS * 3600;

function hourStartSql(columnSql: string) {
  const kind = getDatabaseKind();
  if (kind === "sqlite") return `(CAST((${columnSql}) / ${HOUR_SECONDS} AS INTEGER) * ${HOUR_SECONDS})`;
  if (kind === "mysql") return `(CAST(FLOOR((${columnSql}) / ${HOUR_SECONDS}) AS SIGNED) * ${HOUR_SECONDS})`;
  return `(CAST(FLOOR((${columnSql}) / ${HOUR_SECONDS}) AS BIGINT) * ${HOUR_SECONDS})`;
}

/** 一个时间窗按（服务, 主机, 小时）的聚合。口径和 getHostProbeServiceSeries 一致。 */
function aggregateSelectSql() {
  const count = `CASE WHEN s.${q("probeCount")} BETWEEN 1 AND 1024 THEN s.${q("probeCount")} ELSE 1 END`;
  const successes = `CASE
      WHEN s.${q("isTimeout")} = ${boolLiteral(true)} AND (s.${q("probeSuccesses")} IS NULL OR s.${q("probeSuccesses")} <= 0) THEN 0
      WHEN s.${q("probeSuccesses")} > 0 THEN CASE WHEN s.${q("probeSuccesses")} > (${count}) THEN (${count}) ELSE s.${q("probeSuccesses")} END
      WHEN s.${q("isTimeout")} = ${boolLiteral(true)} THEN 0
      ELSE (${count}) END`;
  const weight = `CASE WHEN s.${q("latencyMs")} IS NOT NULL THEN (${successes}) ELSE 0 END`;
  const hour = hourStartSql(`s.${q("recordedAt")}`);
  return `SELECT s.${q("serviceId")} AS ${q("serviceId")}, s.${q("hostId")} AS ${q("hostId")}, ${hour} AS ${q("hourStart")},
      SUM(${count}) AS ${q("probeCount")},
      SUM(${successes}) AS ${q("probeSuccesses")},
      SUM(CASE WHEN (${weight}) > 0 THEN s.${q("latencyMs")} * (${weight}) ELSE 0 END) AS ${q("latencySum")},
      SUM(${weight}) AS ${q("latencyWeight")},
      MIN(CASE WHEN (${weight}) > 0 THEN s.${q("latencyMs")} END) AS ${q("minLatencyMs")},
      MAX(CASE WHEN (${weight}) > 0 THEN s.${q("latencyMs")} END) AS ${q("maxLatencyMs")},
      ${castInteger("?")} AS ${q("updatedAt")}
    FROM ${q("host_probe_service_stats")} s
    WHERE s.${q("recordedAt")} >= ? AND s.${q("recordedAt")} < ?
    GROUP BY s.${q("serviceId")}, s.${q("hostId")}, ${hour}`;
}

const COLUMNS = ["serviceId", "hostId", "hourStart", "probeCount", "probeSuccesses", "latencySum", "latencyWeight", "minLatencyMs", "maxLatencyMs", "updatedAt"];

/** 把一段原始样本加进小时表（INSERT … SELECT + 冲突时累加）。 */
function upsertSql() {
  const table = q(HOST_PROBE_HOURLY_TABLE);
  const select = aggregateSelectSql();
  if (getDatabaseKind() === "mysql") {
    const incoming = (column: string) => `VALUES(${q(column)})`;
    const nullSafe = (fn: "MIN" | "MAX", column: string) => `CASE WHEN ${q(column)} IS NULL THEN ${incoming(column)} WHEN ${incoming(column)} IS NULL THEN ${q(column)} ELSE ${fn === "MIN" ? "LEAST" : "GREATEST"}(${q(column)}, ${incoming(column)}) END`;
    return `INSERT INTO ${table} (${COLUMNS.map(q).join(", ")}) ${select}
      ON DUPLICATE KEY UPDATE
        ${q("minLatencyMs")} = ${nullSafe("MIN", "minLatencyMs")},
        ${q("maxLatencyMs")} = ${nullSafe("MAX", "maxLatencyMs")},
        ${q("probeCount")} = ${q("probeCount")} + ${incoming("probeCount")},
        ${q("probeSuccesses")} = ${q("probeSuccesses")} + ${incoming("probeSuccesses")},
        ${q("latencySum")} = ${q("latencySum")} + ${incoming("latencySum")},
        ${q("latencyWeight")} = ${q("latencyWeight")} + ${incoming("latencyWeight")},
        ${q("updatedAt")} = ${incoming("updatedAt")}`;
  }
  const current = (column: string) => `${table}.${q(column)}`;
  const incoming = (column: string) => `excluded.${q(column)}`;
  const nullSafe = (op: "<" | ">", column: string) => `CASE WHEN ${current(column)} IS NULL THEN ${incoming(column)} WHEN ${incoming(column)} IS NULL THEN ${current(column)} WHEN ${incoming(column)} ${op} ${current(column)} THEN ${incoming(column)} ELSE ${current(column)} END`;
  return `INSERT INTO ${table} (${COLUMNS.map(q).join(", ")}) ${select}
    ON CONFLICT (${q("serviceId")}, ${q("hostId")}, ${q("hourStart")}) DO UPDATE SET
      ${q("probeCount")} = ${current("probeCount")} + ${incoming("probeCount")},
      ${q("probeSuccesses")} = ${current("probeSuccesses")} + ${incoming("probeSuccesses")},
      ${q("latencySum")} = ${current("latencySum")} + ${incoming("latencySum")},
      ${q("latencyWeight")} = ${current("latencyWeight")} + ${incoming("latencyWeight")},
      ${q("minLatencyMs")} = ${nullSafe("<", "minLatencyMs")},
      ${q("maxLatencyMs")} = ${nullSafe(">", "maxLatencyMs")},
      ${q("updatedAt")} = ${incoming("updatedAt")}`;
}

/**
 * 把水位之后、5 分钟以前的原始样本汇总进小时表。返回这次推进到的水位（epoch 秒）。
 * 可以随时重复调用：没有新样本就什么也不做。第一次跑从 72 小时前开始，升级后马上就有三天。
 */
export async function rollupHostProbeHourlyStats(nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const end = now - ROLLUP_LAG_SECONDS;
  const stored = Number(await getSetting(HOST_PROBE_HOURLY_WATERMARK_KEY));
  let from = Number.isFinite(stored) && stored > 0 ? stored : now - RAW_RETENTION_SECONDS;
  // 面板停了好几天再起来：原始样本早就清掉了，水位直接跳到还在的那一段。
  from = Math.max(from, now - RAW_RETENTION_SECONDS);
  let windows = 0;
  while (from < end) {
    const until = Math.min(end, from + ROLLUP_MAX_WINDOW_SECONDS);
    await withDatabaseTransaction(async () => {
      await executeRaw(upsertSql(), [now, from, until]);
      await setSetting(HOST_PROBE_HOURLY_WATERMARK_KEY, String(until));
    });
    from = until;
    windows += 1;
    if (windows > 24) break; // 单轮最多追 6 天的量，剩下的下一轮接着追
  }
  return from;
}

export async function cleanOldHostProbeHourlyStats(nowMs = Date.now()) {
  // 多留一小时，最早那一小时要完整。
  const cutoff = Math.floor(nowMs / 1000 / HOUR_SECONDS) * HOUR_SECONDS - HOST_PROBE_HISTORY_DAYS * 86_400 - HOUR_SECONDS;
  return deleteExpiredHistoryRows(HOST_PROBE_HOURLY_TABLE, "hourStart", cutoff);
}

/**
 * 小时表里的曲线：返回的每一行和 getHostProbeServiceSeries 同一个样子（一个点一行），
 * 点的间隔是 bucketHours 小时（30 天按 3 小时一个点，7 天按 1 小时）。
 */
export async function getHostProbeServiceHourlySeries(opts: { serviceIds: number[]; hostId?: number; hours: number; nowMs?: number }) {
  const ids = Array.from(new Set(opts.serviceIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return [];
  const hours = Math.max(1, Math.min(Number(opts.hours) || 24, HOST_PROBE_HISTORY_DAYS * 24));
  const bucketHours = hours > 7 * 24 ? 3 : 1;
  const bucketSeconds = bucketHours * HOUR_SECONDS;
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const since = Math.floor((now - hours * HOUR_SECONDS) / HOUR_SECONDS) * HOUR_SECONDS;
  const hostId = Number(opts.hostId || 0);
  const kind = getDatabaseKind();
  const bucket = kind === "sqlite"
    ? `(CAST(h.${q("hourStart")} / ${bucketSeconds} AS INTEGER) * ${bucketSeconds})`
    : `(FLOOR(h.${q("hourStart")} / ${bucketSeconds}) * ${bucketSeconds})`;
  const conditions = [`h.${q("hourStart")} >= ?`, `h.${q("serviceId")} IN (${ids.map(() => "?").join(",")})`];
  const params: unknown[] = [since, ...ids];
  if (Number.isInteger(hostId) && hostId > 0) {
    conditions.push(`h.${q("hostId")} = ?`);
    params.push(hostId);
  }
  const rows = await queryRaw<any>(
    `SELECT h.${q("serviceId")} AS ${q("serviceId")}, h.${q("hostId")} AS ${q("hostId")}, ${bucket} AS ${q("bucketStart")},
            SUM(h.${q("probeCount")}) AS ${q("probeCount")},
            SUM(h.${q("probeSuccesses")}) AS ${q("probeSuccesses")},
            SUM(h.${q("latencySum")}) AS ${q("latencySum")},
            SUM(h.${q("latencyWeight")}) AS ${q("latencyWeight")}
       FROM ${q(HOST_PROBE_HOURLY_TABLE)} h
      WHERE ${conditions.join(" AND ")}
      GROUP BY h.${q("serviceId")}, h.${q("hostId")}, ${bucket}
      ORDER BY ${q("bucketStart")} ASC`,
    params,
  );
  return rows.map((row) => {
    const weight = Number(row.latencyWeight) || 0;
    const probeCount = Math.max(0, Number(row.probeCount) || 0);
    const probeSuccesses = Math.min(probeCount, Math.max(0, Number(row.probeSuccesses) || 0));
    const latencyMs = weight > 0 ? Math.round(Number(row.latencySum) / weight) : null;
    return {
      serviceId: Number(row.serviceId),
      hostId: Number(row.hostId),
      latencyMs,
      isTimeout: latencyMs == null && probeCount > 0,
      probeCount,
      probeSuccesses,
      recordedAt: new Date(Number(row.bucketStart) * 1000),
    };
  });
}

/** 服务或主机删掉时顺手清掉它的小时汇总（不清也会在 30 天后自然过期）。 */
export async function deleteHostProbeHourlyStats(where: { serviceId?: number; hostId?: number }) {
  if (where.serviceId) await executeRaw(`DELETE FROM ${q(HOST_PROBE_HOURLY_TABLE)} WHERE ${q("serviceId")} = ?`, [Number(where.serviceId)]);
  if (where.hostId) await executeRaw(`DELETE FROM ${q(HOST_PROBE_HOURLY_TABLE)} WHERE ${q("hostId")} = ?`, [Number(where.hostId)]);
}
