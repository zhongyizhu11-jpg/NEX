import { executeRaw, getDatabaseKind, queryRaw, withDatabaseTransaction } from "../dbRuntime";
import { boolLiteral, castInteger, quoteIdentifier as q } from "../dbCompat";
import { getSetting, setSetting } from "./settingsRepository";
import { deleteExpiredHistoryRows } from "./historyRetention";
import {
  LATENCY_DAY_OFFSET_SECONDS,
  LATENCY_DAY_SECONDS,
  LATENCY_HISTORY_DAYS,
  latencyDayStart,
  type LatencyDaySummary,
  type LatencyHistoryTargetType,
} from "../../shared/latencyHistory";

/*
  按天的延迟汇总（见 shared/latencyHistory.ts 开头为什么不直接把原始样本留 30 天）。

  汇总是增量的：记一个水位（system_settings.latencyDailyRollupThrough），每次把
  [水位, 现在 - 5 分钟) 的原始样本按（对象, 天）聚合后**加**进日表，再推进水位 —— 加和
  推进水位在同一个事务里，崩在中间不会重复计数。原始样本的 recordedAt 是面板收到时写的
  服务器时间，5 分钟的延后足够盖住还没提交的写入。

  一次最多处理 6 小时，追得上：调度器 10 分钟跑一次。第一次跑从 72 小时前（原始样本的
  保留期）开始，升级后马上就有三天的历史。
*/

export const LATENCY_DAILY_TABLE = "latency_daily_stats";
export const LATENCY_DAILY_WATERMARK_KEY = "latencyDailyRollupThrough";
const ROLLUP_LAG_SECONDS = 5 * 60;
const ROLLUP_MAX_WINDOW_SECONDS = 6 * 3600;
const RAW_RETENTION_SECONDS = 72 * 3600;

type SourceTable = {
  targetType: LatencyHistoryTargetType;
  table: string;
  idColumn: string;
  /** 隧道有分入口的子序列，日汇总只取总序列（和链路卡、详情的「总延迟」一致）。 */
  extraWhere?: string;
};

export const LATENCY_DAILY_SOURCES: SourceTable[] = [
  { targetType: "rule", table: "tcping_stats", idColumn: "ruleId" },
  { targetType: "tunnel", table: "tunnel_latency_stats", idColumn: "tunnelId", extraWhere: `(s.${q("seriesKey")} IS NULL OR s.${q("seriesKey")} = '' OR s.${q("seriesKey")} = 'total')` },
  { targetType: "group", table: "forward_group_latency_stats", idColumn: "groupId" },
];

function integerDivision(expr: string, divisor: number) {
  const kind = getDatabaseKind();
  if (kind === "sqlite") return `CAST((${expr}) / ${divisor} AS INTEGER)`;
  if (kind === "mysql") return `CAST(FLOOR((${expr}) / ${divisor}) AS SIGNED)`;
  return `CAST(FLOOR((${expr}) / ${divisor}) AS BIGINT)`;
}

/** 面板时区的「那一天 0 点」（epoch 秒），和 shared/latencyHistory.ts 的 latencyDayStart 同一个算式。 */
export function latencyDayStartSql(columnSql: string) {
  return `(${integerDivision(`${columnSql} + ${LATENCY_DAY_OFFSET_SECONDS}`, LATENCY_DAY_SECONDS)} * ${LATENCY_DAY_SECONDS} - ${LATENCY_DAY_OFFSET_SECONDS})`;
}

/** 一个原始样本表、一个时间窗按（对象, 天）的聚合。口径和小时曲线（getGlobalTcpingSeries）一致。 */
function aggregateSelectSql(source: SourceTable) {
  const count = `CASE WHEN s.${q("probeCount")} BETWEEN 1 AND 1024 THEN s.${q("probeCount")} ELSE 1 END`;
  const successes = `CASE
      WHEN s.${q("isTimeout")} = ${boolLiteral(true)} AND (s.${q("probeSuccesses")} IS NULL OR s.${q("probeSuccesses")} <= 0) THEN 0
      WHEN s.${q("probeSuccesses")} > 0 THEN CASE WHEN s.${q("probeSuccesses")} > (${count}) THEN (${count}) ELSE s.${q("probeSuccesses")} END
      WHEN s.${q("isTimeout")} = ${boolLiteral(true)} THEN 0
      ELSE (${count}) END`;
  const weight = `CASE WHEN s.${q("latencyMs")} IS NOT NULL THEN (${successes}) ELSE 0 END`;
  const day = latencyDayStartSql(`s.${q("recordedAt")}`);
  return `SELECT '${source.targetType}' AS ${q("targetType")}, s.${q(source.idColumn)} AS ${q("targetId")}, ${day} AS ${q("dayStart")},
      SUM(${count}) AS ${q("probeCount")},
      SUM(${successes}) AS ${q("probeSuccesses")},
      SUM(CASE WHEN (${weight}) > 0 THEN s.${q("latencyMs")} * (${weight}) ELSE 0 END) AS ${q("latencySum")},
      SUM(${weight}) AS ${q("latencyWeight")},
      MIN(CASE WHEN (${weight}) > 0 THEN s.${q("latencyMs")} END) AS ${q("minLatencyMs")},
      MAX(CASE WHEN (${weight}) > 0 THEN s.${q("latencyMs")} END) AS ${q("maxLatencyMs")},
      ${castInteger("?")} AS ${q("updatedAt")}
    FROM ${q(source.table)} s
    WHERE s.${q("recordedAt")} >= ? AND s.${q("recordedAt")} < ?${source.extraWhere ? ` AND ${source.extraWhere}` : ""}
    GROUP BY s.${q(source.idColumn)}, ${day}`;
}

const COLUMNS = ["targetType", "targetId", "dayStart", "probeCount", "probeSuccesses", "latencySum", "latencyWeight", "minLatencyMs", "maxLatencyMs", "updatedAt"];

/** 把一段原始样本加进日表（INSERT … SELECT + 冲突时累加）。 */
function upsertSql(source: SourceTable) {
  const table = q(LATENCY_DAILY_TABLE);
  const select = aggregateSelectSql(source);
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
    ON CONFLICT (${q("targetType")}, ${q("targetId")}, ${q("dayStart")}) DO UPDATE SET
      ${q("probeCount")} = ${current("probeCount")} + ${incoming("probeCount")},
      ${q("probeSuccesses")} = ${current("probeSuccesses")} + ${incoming("probeSuccesses")},
      ${q("latencySum")} = ${current("latencySum")} + ${incoming("latencySum")},
      ${q("latencyWeight")} = ${current("latencyWeight")} + ${incoming("latencyWeight")},
      ${q("minLatencyMs")} = ${nullSafe("<", "minLatencyMs")},
      ${q("maxLatencyMs")} = ${nullSafe(">", "maxLatencyMs")},
      ${q("updatedAt")} = ${incoming("updatedAt")}`;
}

/**
 * 把水位之后、5 分钟以前的原始样本汇总进日表。返回这次推进到的水位（epoch 秒）。
 * 可以随时重复调用：没有新样本就什么也不做。
 */
export async function rollupLatencyDailyStats(nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const end = now - ROLLUP_LAG_SECONDS;
  const stored = Number(await getSetting(LATENCY_DAILY_WATERMARK_KEY));
  let from = Number.isFinite(stored) && stored > 0 ? stored : now - RAW_RETENTION_SECONDS;
  // 面板停了好几天再起来：原始样本早就清掉了，水位直接跳到还在的那一段。
  from = Math.max(from, now - RAW_RETENTION_SECONDS);
  let windows = 0;
  while (from < end) {
    const until = Math.min(end, from + ROLLUP_MAX_WINDOW_SECONDS);
    await withDatabaseTransaction(async () => {
      for (const source of LATENCY_DAILY_SOURCES) {
        await executeRaw(upsertSql(source), [now, from, until]);
      }
      await setSetting(LATENCY_DAILY_WATERMARK_KEY, String(until));
    });
    from = until;
    windows += 1;
    if (windows > 24) break; // 单轮最多追 6 天的量，剩下的下一轮接着追
  }
  return from;
}

export async function cleanOldLatencyDailyStats(nowMs = Date.now()) {
  // 多留一天：今天算在 30 天里，最早那一天要完整。
  const cutoff = latencyDayStart(Math.floor(nowMs / 1000)) - LATENCY_HISTORY_DAYS * LATENCY_DAY_SECONDS;
  return deleteExpiredHistoryRows(LATENCY_DAILY_TABLE, "dayStart", cutoff);
}

/** 取一批对象最近 30 天的按天汇总。没数据的天不返回（界面上画成灰）。 */
export async function getLatencyDailyHistory(targetType: LatencyHistoryTargetType, targetIds: number[], nowMs = Date.now()) {
  const ids = Array.from(new Set(targetIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const result = new Map<number, LatencyDaySummary[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return result;
  const since = latencyDayStart(Math.floor(nowMs / 1000)) - (LATENCY_HISTORY_DAYS - 1) * LATENCY_DAY_SECONDS;
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    const rows = await queryRaw<any>(`SELECT ${q("targetId")}, ${q("dayStart")}, ${q("probeCount")}, ${q("probeSuccesses")}, ${q("latencySum")}, ${q("latencyWeight")}, ${q("minLatencyMs")}, ${q("maxLatencyMs")}
      FROM ${q(LATENCY_DAILY_TABLE)}
      WHERE ${q("targetType")} = ? AND ${q("targetId")} IN (${batch.map(() => "?").join(",")}) AND ${q("dayStart")} >= ?
      ORDER BY ${q("targetId")} ASC, ${q("dayStart")} ASC`, [targetType, ...batch, since]);
    for (const row of rows) {
      const weight = Number(row.latencyWeight) || 0;
      result.get(Number(row.targetId))?.push({
        dayStart: Number(row.dayStart),
        probeCount: Number(row.probeCount) || 0,
        probeSuccesses: Number(row.probeSuccesses) || 0,
        avgLatencyMs: weight > 0 ? Math.round(Number(row.latencySum) / weight) : null,
        minLatencyMs: row.minLatencyMs == null ? null : Number(row.minLatencyMs),
        maxLatencyMs: row.maxLatencyMs == null ? null : Number(row.maxLatencyMs),
      });
    }
  }
  return result;
}
