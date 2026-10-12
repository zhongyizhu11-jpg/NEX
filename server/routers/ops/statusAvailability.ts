import { z } from "zod";
import { publicProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { queryRaw, quoteDbIdentifier } from "../../dbRuntime";
import { createQueryCache } from "../../queryCache";
import { assertPublicHostMonitorRequest, filterPublicMonitorHosts } from "../hosts";
import { pendingAvailabilityDeltas } from "../../ops/statusAvailabilityJob";
import {
  availabilityLast24h,
  availabilityOfCells,
  buildDayCells,
  lastShanghaiDays,
  type AvailabilityDayRow,
  type AvailabilityIncidentRow,
} from "../../ops/statusAvailabilityLogic";

const q = quoteDbIdentifier;
const cache = createQueryCache(20);

function epochSeconds(value: unknown): number | null {
  if (value == null || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : Number(value) > 10_000_000_000 ? Number(value) : Number(value) * 1000;
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

function inList(ids: number[]) {
  return { sql: `(${ids.map(() => "?").join(", ")})`, params: ids };
}

/**
 * 公开状态页上方那一块的数据。
 *
 * 主机范围与公开监控页完全一致（filterPublicMonitorHosts：管理员名下或无主的主机），
 * 另外去掉从没连上过的主机 —— 它们还没装好，算不上「断线」。
 */
async function loadStatusAvailability(configuredPath: string) {
  const now = Math.floor(Date.now() / 1000);
  const hosts = (await filterPublicMonitorHosts(await db.getHosts() as any[]))
    .filter((host) => Number(host?.id) > 0 && epochSeconds(host?.lastHeartbeat) !== null);
  const hostIds = hosts.map((host) => Number(host.id));
  const visible = new Set(hostIds);
  const nameById = new Map(hosts.map((host) => [Number(host.id), String(host.name || `主机 ${host.id}`)]));
  const offline = hosts.filter((host) => !host.isOnline);
  const days = lastShanghaiDays(now, 30);

  let rows: AvailabilityDayRow[] = [];
  let incidents24h: AvailabilityIncidentRow[] = [];
  let recent: Array<{ hostId: number; startedAt: number; endedAt: number | null; durationSeconds: number }> = [];
  if (hostIds.length > 0) {
    const list = inList(hostIds);
    const [dayRows, windowRows, recentRows] = await Promise.all([
      queryRaw<any>(
        `SELECT ${q("hostId")}, ${q("day")}, ${q("downSeconds")}, ${q("observedSeconds")} FROM ${q("host_availability_days")}
          WHERE ${q("day")} >= ? AND ${q("hostId")} IN ${list.sql}`,
        [days[0], ...list.params],
      ),
      queryRaw<any>(
        `SELECT ${q("hostId")}, ${q("startedAt")}, ${q("endedAt")} FROM ${q("host_availability_incidents")}
          WHERE (${q("endedAt")} IS NULL OR ${q("endedAt")} >= ?) AND ${q("hostId")} IN ${list.sql}`,
        [now - 86400, ...list.params],
      ),
      queryRaw<any>(
        `SELECT ${q("hostId")}, ${q("startedAt")}, ${q("endedAt")}, ${q("durationSeconds")} FROM ${q("host_availability_incidents")}
          WHERE ${q("hostId")} IN ${list.sql} ORDER BY ${q("startedAt")} DESC LIMIT 5`,
        list.params,
      ),
    ]);
    rows = dayRows.map((row) => ({
      hostId: Number(row.hostId),
      day: String(row.day),
      downSeconds: Number(row.downSeconds || 0),
      observedSeconds: Number(row.observedSeconds || 0),
    }));
    // 叠上还没落库的那几分钟，页面上的数不用等落库。
    for (const delta of pendingAvailabilityDeltas()) {
      if (!visible.has(delta.hostId) || delta.day < days[0]) continue;
      rows.push({ hostId: delta.hostId, day: delta.day, downSeconds: delta.down, observedSeconds: delta.observed });
    }
    incidents24h = windowRows.map((row) => ({
      hostId: Number(row.hostId),
      startedAt: epochSeconds(row.startedAt) ?? now,
      endedAt: epochSeconds(row.endedAt),
    }));
    recent = recentRows.map((row) => {
      const startedAt = epochSeconds(row.startedAt) ?? now;
      const endedAt = epochSeconds(row.endedAt);
      return {
        hostId: Number(row.hostId),
        startedAt,
        endedAt,
        durationSeconds: endedAt === null ? Math.max(0, now - startedAt) : Number(row.durationSeconds || endedAt - startedAt),
      };
    });
  }

  const cells = buildDayCells(rows, days, visible);
  return {
    path: configuredPath,
    refreshedAt: new Date(now * 1000).toISOString(),
    totalHosts: hosts.length,
    offlineHosts: offline.length,
    // 离线的只给名字，不给别的 —— 公开页本来就显示这些名字。
    offlineHostNames: offline.slice(0, 3).map((host) => String(host.name || `主机 ${host.id}`)),
    availability24h: availabilityLast24h(rows, incidents24h, visible, now),
    availability30d: availabilityOfCells(cells),
    days: cells,
    incidents: recent.map((incident) => ({
      hostName: nameById.get(incident.hostId) || "",
      startedAt: new Date(incident.startedAt * 1000).toISOString(),
      endedAt: incident.endedAt === null ? null : new Date(incident.endedAt * 1000).toISOString(),
      durationSeconds: incident.durationSeconds,
    })),
  };
}

/** trpc.ops.statusAvailability.* —— 公开状态页的可用率（#1），不登录就能看。 */
export const statusAvailabilityRouter = router({
  public: publicProcedure
    .input(z.object({ path: z.string().max(128).optional() }).optional())
    .query(async ({ input }) => {
      // 与 hosts.publicMonitor 同一套：开关 / 路径校验在缓存外，结果按路径缓存 2 秒（匿名观看者在轮询）。
      const { configuredPath } = await assertPublicHostMonitorRequest(input?.path);
      return cache.get(
        `statusAvailability:${configuredPath}`,
        { ttlMs: 2_000, staleMs: 5_000 },
        () => loadStatusAvailability(configuredPath),
      );
    }),
});
