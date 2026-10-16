import { eq } from "drizzle-orm";
import { routePathQualityStats, type InsertRoutePathQualityStat } from "../../drizzle/schema";
import { getDb, queryRaw } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";
import { timestampMillis } from "../../shared/timestamp";
import { deleteExpiredHistoryRows } from "./historyRetention";

/** 线路组路径质量历史留多久：一周。比延迟明细（72 小时）长，够看「上周三晚上那条线怎么样」。 */
export const ROUTE_PATH_QUALITY_RETENTION_HOURS = 7 * 24;
/** 一次最多读多少行：7 天 × 每分钟一行 × 11 条路径还要再留点余量。 */
const MAX_HISTORY_ROWS = 120_000;

export type RoutePathQualityRow = {
  ruleId: number;
  pathKey: string;
  /** Unix 毫秒 */
  sampledAt: number;
  latencyMs: number | null;
  lossPct: number;
  jitterMs: number | null;
  availabilityPct: number | null;
  score: number | null;
};

function clampInt(value: number | null | undefined, min: number, max: number) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function routePathQualityToInsert(row: RoutePathQualityRow): InsertRoutePathQualityStat {
  return {
    ruleId: row.ruleId,
    pathKey: String(row.pathKey).slice(0, 32),
    sampledAt: new Date(Math.floor(row.sampledAt / 1000) * 1000),
    latencyMs: clampInt(row.latencyMs, 0, 600_000),
    lossPermille: clampInt(row.lossPct * 10, 0, 1000) ?? 0,
    jitterMs: clampInt(row.jitterMs, 0, 600_000),
    availabilityPermille: row.availabilityPct === null ? null : clampInt(row.availabilityPct * 10, 0, 1000),
    score: clampInt(row.score, 0, 100),
  } as InsertRoutePathQualityStat;
}

export async function insertRoutePathQualityStats(rows: RoutePathQualityRow[]) {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  await db.insert(routePathQualityStats).values(rows.map(routePathQualityToInsert));
  return rows.length;
}

export async function getRoutePathQualityHistory(ruleId: number, options: { sinceMs: number; pathKey?: string | null }): Promise<RoutePathQualityRow[]> {
  const q = quoteIdentifier;
  const params: unknown[] = [Number(ruleId), Math.floor(options.sinceMs / 1000)];
  const pathFilter = options.pathKey ? ` AND ${q("pathKey")} = ?` : "";
  if (options.pathKey) params.push(String(options.pathKey));
  const rows = await queryRaw<any>(
    `SELECT ${q("ruleId")}, ${q("pathKey")}, ${q("sampledAt")}, ${q("latencyMs")}, ${q("lossPermille")},
            ${q("jitterMs")}, ${q("availabilityPermille")}, ${q("score")}
       FROM ${q("route_path_quality_stats")}
      WHERE ${q("ruleId")} = ? AND ${q("sampledAt")} >= ?${pathFilter}
      ORDER BY ${q("sampledAt")} ASC, ${q("id")} ASC
      LIMIT ${MAX_HISTORY_ROWS}`,
    params,
  );
  const nullable = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return rows.map((row) => ({
    ruleId: Number(row.ruleId),
    pathKey: String(row.pathKey || ""),
    sampledAt: timestampMillis(typeof row.sampledAt === "string" && /^\d+$/.test(row.sampledAt) ? Number(row.sampledAt) : row.sampledAt),
    latencyMs: nullable(row.latencyMs),
    lossPct: (Number(row.lossPermille) || 0) / 10,
    jitterMs: nullable(row.jitterMs),
    availabilityPct: row.availabilityPermille === null || row.availabilityPermille === undefined ? null : Number(row.availabilityPermille) / 10,
    score: nullable(row.score),
  }));
}

export async function deleteRoutePathQualityStats(ruleId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(routePathQualityStats).where(eq(routePathQualityStats.ruleId, Number(ruleId)));
}

export async function cleanOldRoutePathQualityStats(retainHours = ROUTE_PATH_QUALITY_RETENTION_HOURS) {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  return deleteExpiredHistoryRows("route_path_quality_stats", "sampledAt", cutoff);
}
