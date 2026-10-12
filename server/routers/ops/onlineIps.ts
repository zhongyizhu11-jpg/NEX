import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { queryRaw, quoteDbIdentifier } from "../../dbRuntime";
import { hostSupportsAgentExt, AGENT_EXT_MIN_VERSION } from "../../ops/agentExt";
import {
  cachedOwnerLabel,
  ipRegionLabel,
  loadUsers,
  markOnlineIpsWatching,
  onlineIntervalSeconds,
  onlineSnapshots,
  queueIpGeo,
} from "../../ops/onlineIps";
import { distinctIpsByUser, HISTORY_DAYS, type OnlineIpRow } from "../../ops/onlineIpsCore";

/*
  trpc.ops.onlineIps.* —— 监控 › 在线 IP（#6），只给管理员。

  live    当前在线（内存快照），按用户分组，带「在线几个 IP / 上限几个」。
  history IP 历史（ip_sightings），按 IP 汇总、分页。
  forUser 用户管理里某个人的在线 IP（当前 + 24 小时内用过几个）。
  watch   界面开着时每 20 秒调一次：这段时间 Agent 改成 10 秒报一次。
*/
const q = quoteDbIdentifier;

type HostLite = { id: number; name: string; agentVersion: string | null };

async function loadHosts(): Promise<Map<number, HostLite>> {
  const rows = await queryRaw<any>(`SELECT ${q("id")}, ${q("name")}, ${q("agentVersion")} FROM ${q("hosts")}`);
  return new Map(rows.map((row) => [Number(row.id), { id: Number(row.id), name: String(row.name || `主机 #${row.id}`), agentVersion: row.agentVersion ? String(row.agentVersion) : null }]));
}

function liveRowView(row: OnlineIpRow, hosts: Map<number, HostLite>) {
  return {
    ip: row.ip,
    region: ipRegionLabel(row.ip),
    hostId: row.hostId,
    hostName: hosts.get(row.hostId)?.name || `主机 #${row.hostId}`,
    port: row.port,
    ruleId: row.ruleId || null,
    inboundId: row.inboundId || null,
    target: cachedOwnerLabel(row.hostId, row.port) || `端口 ${row.port}`,
    conns: row.conns,
    since: row.since,
  };
}

/** 这些主机的 Agent 太老，看不到在线 IP（只列装过 Agent 的）。 */
function outdatedHosts(hosts: Map<number, HostLite>) {
  return Array.from(hosts.values())
    .filter((host) => host.agentVersion && !hostSupportsAgentExt(host))
    .map((host) => ({ id: host.id, name: host.name, agentVersion: host.agentVersion }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

const historyInput = z.object({
  days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(7),
  hostId: z.number().int().positive().optional(),
  userId: z.number().int().positive().optional(),
  search: z.string().trim().max(64).optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(5).max(100).default(30),
});

export const onlineIpsRouter = router({
  live: adminProcedure
    .input(z.object({
      userId: z.number().int().positive().optional(),
      hostId: z.number().int().positive().optional(),
    }).optional())
    .query(async ({ input }) => {
      const now = Date.now();
      const all = onlineSnapshots.live(now);
      const hosts = await loadHosts();
      const ipsByUser = distinctIpsByUser(all);
      const users = await loadUsers(Array.from(ipsByUser.keys()));
      const filtered = all.filter((row) => (!input?.userId || row.userId === input.userId) && (!input?.hostId || row.hostId === input.hostId));
      queueIpGeo(filtered.map((row) => row.ip));
      const groups = new Map<number, ReturnType<typeof liveRowView>[]>();
      for (const row of filtered) {
        const list = groups.get(row.userId) || [];
        list.push(liveRowView(row, hosts));
        groups.set(row.userId, list);
      }
      const userGroups = Array.from(groups.entries()).map(([userId, rows]) => {
        const info = users.get(userId);
        const limit = info?.maxIPs || 0;
        const ipCount = ipsByUser.get(userId)?.size || 0;
        rows.sort((a, b) => a.ip.localeCompare(b.ip) || a.hostName.localeCompare(b.hostName, "zh-CN"));
        return {
          userId,
          name: userId ? info?.name || `用户 #${userId}` : "未归属",
          ipCount,
          limit,
          atLimit: limit > 0 && ipCount >= limit,
          rows,
        };
      }).sort((a, b) => (a.userId === 0 ? 1 : 0) - (b.userId === 0 ? 1 : 0) || a.name.localeCompare(b.name, "zh-CN"));
      return {
        generatedAt: Math.floor(now / 1000),
        intervalSeconds: onlineIntervalSeconds(),
        reportingHosts: onlineSnapshots.reportingHostIds(now).length,
        totalIps: new Set(filtered.map((row) => row.ip)).size,
        users: userGroups,
        outdatedHosts: outdatedHosts(hosts),
        minAgentVersion: AGENT_EXT_MIN_VERSION,
        hosts: Array.from(hosts.values()).map((host) => ({ id: host.id, name: host.name })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
      };
    }),

  history: adminProcedure
    .input(historyInput)
    .query(async ({ input }) => {
      const days = HISTORY_DAYS.includes(input.days as any) ? input.days : 7;
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const where: string[] = [`${q("lastSeenAt")} >= ?`];
      const params: any[] = [since];
      if (input.hostId) { where.push(`${q("hostId")} = ?`); params.push(input.hostId); }
      if (input.userId) { where.push(`${q("userId")} = ?`); params.push(input.userId); }
      const search = (input.search || "").toLowerCase();
      if (search) {
        const like = `%${search.replace(/[%_\\]/g, "")}%`;
        const matchedUsers = await queryRaw<any>(
          `SELECT ${q("id")} FROM ${q("users")} WHERE LOWER(${q("username")}) LIKE ? OR LOWER(${q("name")}) LIKE ? LIMIT 50`,
          [like, like],
        );
        const ids = matchedUsers.map((row) => Number(row.id)).filter((id) => id > 0);
        where.push(ids.length
          ? `(${q("ip")} LIKE ? OR ${q("userId")} IN (${ids.map(() => "?").join(", ")}))`
          : `${q("ip")} LIKE ?`);
        params.push(like, ...ids);
      }
      const whereSql = where.join(" AND ");
      const totalRows = await queryRaw<any>(`SELECT COUNT(DISTINCT ${q("ip")}) AS ${q("total")} FROM ${q("ip_sightings")} WHERE ${whereSql}`, params);
      const total = Number(totalRows[0]?.total || 0);
      const offset = (input.page - 1) * input.pageSize;
      const pageRows = await queryRaw<any>(
        `SELECT ${q("ip")}, MIN(${q("firstSeenAt")}) AS ${q("firstSeen")}, MAX(${q("lastSeenAt")}) AS ${q("lastSeen")}, MAX(${q("connCount")}) AS ${q("maxConn")}
         FROM ${q("ip_sightings")} WHERE ${whereSql}
         GROUP BY ${q("ip")} ORDER BY ${q("lastSeen")} DESC, ${q("ip")} ASC LIMIT ${input.pageSize} OFFSET ${offset}`,
        params,
      );
      const ips = pageRows.map((row) => String(row.ip));
      const detail = ips.length
        ? await queryRaw<any>(
          `SELECT ${q("ip")}, ${q("userId")}, ${q("hostId")}, MAX(${q("lastSeenAt")}) AS ${q("lastSeen")} FROM ${q("ip_sightings")}
           WHERE ${whereSql} AND ${q("ip")} IN (${ips.map(() => "?").join(", ")})
           GROUP BY ${q("ip")}, ${q("userId")}, ${q("hostId")}`,
          [...params, ...ips],
        )
        : [];
      const hosts = await loadHosts();
      const users = await loadUsers(detail.map((row) => Number(row.userId)));
      const perIp = new Map<string, { users: Map<number, string>; hosts: Map<number, string> }>();
      for (const row of detail) {
        const ip = String(row.ip);
        const entry = perIp.get(ip) || { users: new Map(), hosts: new Map() };
        const userId = Number(row.userId) || 0;
        const hostId = Number(row.hostId) || 0;
        entry.users.set(userId, userId ? users.get(userId)?.name || `用户 #${userId}` : "未归属");
        entry.hosts.set(hostId, hosts.get(hostId)?.name || `主机 #${hostId}`);
        perIp.set(ip, entry);
      }
      queueIpGeo(ips);
      return {
        hosts: Array.from(hosts.values()).map((host) => ({ id: host.id, name: host.name })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
        total,
        page: input.page,
        pageSize: input.pageSize,
        items: pageRows.map((row) => {
          const ip = String(row.ip);
          const entry = perIp.get(ip);
          return {
            ip,
            region: ipRegionLabel(ip),
            firstSeenAt: Number(row.firstSeen) || 0,
            lastSeenAt: Number(row.lastSeen) || 0,
            maxConn: Number(row.maxConn) || 0,
            users: entry ? Array.from(entry.users, ([id, name]) => ({ id, name })) : [],
            hosts: entry ? Array.from(entry.hosts, ([id, name]) => ({ id, name })) : [],
          };
        }),
      };
    }),

  forUser: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const now = Date.now();
      const all = onlineSnapshots.live(now);
      const hosts = await loadHosts();
      const users = await loadUsers([input.userId]);
      const info = users.get(input.userId);
      const mine = all.filter((row) => row.userId === input.userId);
      const onlineCount = new Set(mine.map((row) => row.ip)).size;
      const since = Math.floor(now / 1000) - 86400;
      const recent = await queryRaw<any>(
        `SELECT ${q("ip")}, MAX(${q("lastSeenAt")}) AS ${q("lastSeen")}, MIN(${q("firstSeenAt")}) AS ${q("firstSeen")} FROM ${q("ip_sightings")}
         WHERE ${q("userId")} = ? AND ${q("lastSeenAt")} >= ? GROUP BY ${q("ip")} ORDER BY ${q("lastSeen")} DESC LIMIT 100`,
        [input.userId, since],
      );
      queueIpGeo([...mine.map((row) => row.ip), ...recent.map((row) => String(row.ip))]);
      const limit = info?.maxIPs || 0;
      const onlineSet = new Set(mine.map((row) => row.ip));
      return {
        user: { id: input.userId, name: info?.name || `用户 #${input.userId}` },
        limit,
        onlineCount,
        atLimit: limit > 0 && onlineCount >= limit,
        distinct24h: recent.length,
        intervalSeconds: onlineIntervalSeconds(),
        rows: mine.map((row) => liveRowView(row, hosts)).sort((a, b) => a.ip.localeCompare(b.ip)),
        recent: recent.map((row) => ({
          ip: String(row.ip),
          region: ipRegionLabel(String(row.ip)),
          lastSeenAt: Number(row.lastSeen) || 0,
          firstSeenAt: Number(row.firstSeen) || 0,
          online: onlineSet.has(String(row.ip)),
        })),
        outdatedHosts: outdatedHosts(hosts),
      };
    }),

  watch: adminProcedure.mutation(async () => {
    const { woke } = await markOnlineIpsWatching();
    return { intervalSeconds: onlineIntervalSeconds(), woke };
  }),
});
