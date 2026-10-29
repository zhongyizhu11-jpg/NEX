import { eq, gt, inArray } from "drizzle-orm";
import {
  forwardGroupMembers,
  forwardGroups,
  forwardRules,
  forwardRuleTunnelExits,
  hosts,
  proxyInbounds,
  proxyNodes,
  tunnelExitNodes,
  tunnelHops,
  tunnels,
  users,
} from "../drizzle/schema";
import {
  buildNetworkTopology,
  type TopologyGraph,
  type TopologyGroupRow,
  type TopologyRouteStats,
  type TopologyRuleRow,
  type TopologyScope,
  type TopologyTunnelRow,
} from "../shared/networkTopology";
import { getDb, queryRaw } from "./dbRuntime";
import { quoteIdentifier } from "./dbCompat";
import { getLinkAccessScope } from "./linkAccessView";
import { createQueryCache } from "./queryCache";
import { getUserEffectiveAllowedHostIds } from "./repositories/permissionRepository";
import { getUserUsableTrafficBillingResourceIds } from "./repositories/trafficBillingRepository";
import { getRouteStatus } from "./routeGroupStats";
import { getRuleLiveRates } from "./ruleLiveRates";

/*
  「网络拓扑」页的数据：把规则、隧道、转发组、落地入站、主机状态一次取齐，交给
  shared/networkTopology.ts 拼成图。

  一次取全表而不是按页取：图要的就是全貌，分页了就画不出「谁经过谁」。代价是一次七八条
  查询，所以按查看范围缓存 10 秒（页面 30 秒刷一次，几个管理员同时开着也只算一遍）。
*/

const topologyCache = createQueryCache(200);
/** 延迟取近 15 分钟最新的一次；更早的已经不能说明「现在」。 */
const RULE_LATENCY_WINDOW_SECONDS = 15 * 60;

export type TopologyViewer = { id: number; role: string };

export type TopologyGraphResponse = TopologyGraph & {
  generatedAt: number;
  /** 管理员按用户筛选用：图里出现过的资源主人。普通用户为空。 */
  owners: Array<{ id: number; label: string }>;
  scopeUserId: number | null;
};

async function latestRuleLatencies(): Promise<Map<number, number | null>> {
  const q = quoteIdentifier;
  const since = Math.floor(Date.now() / 1000) - RULE_LATENCY_WINDOW_SECONDS;
  const rows = await queryRaw<{ ruleId: unknown; latencyMs: unknown; isTimeout: unknown }>(
    `SELECT s.${q("ruleId")} AS ${q("ruleId")}, s.${q("latencyMs")} AS ${q("latencyMs")}, s.${q("isTimeout")} AS ${q("isTimeout")}
       FROM ${q("tcping_stats")} s
       INNER JOIN (
         SELECT ${q("ruleId")}, MAX(${q("id")}) AS ${q("id")}
           FROM ${q("tcping_stats")}
          WHERE ${q("recordedAt")} >= ?
          GROUP BY ${q("ruleId")}
       ) latest ON latest.${q("id")} = s.${q("id")}`,
    [since],
  ).catch(() => []);
  const result = new Map<number, number | null>();
  for (const row of rows) {
    const timeout = row.isTimeout === true || row.isTimeout === 1 || row.isTimeout === "1";
    const latency = row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs);
    result.set(Number(row.ruleId), timeout || latency === null || !Number.isFinite(latency) ? null : latency);
  }
  return result;
}

function routeStatsFor(ruleId: number): TopologyRouteStats | null {
  const status = getRouteStatus(ruleId);
  const agent = status.agent;
  if (!agent && status.hops.length === 0) return null;
  return {
    activeIndex: agent && agent.activeIndex >= 0 ? agent.activeIndex : undefined,
    targets: (agent?.targets || []).map((target) => ({
      index: target.index,
      latencyMs: target.latencyMs,
      healthy: target.healthy && !target.down,
    })),
    hops: status.hops.map((hop) => ({
      pathKey: hop.pathKey,
      hopIndex: hop.hopIndex,
      ok: hop.ok,
      latencyMs: hop.latencyMs,
      consecutiveFailures: hop.consecutiveFailures,
    })),
  };
}

/** 普通用户看得见名字的主机：自己的、被授权的、按量计费可用的、共享给他的链路里展开的。 */
async function visibleHostIdsForUser(userId: number, hostRows: Array<{ id: number; userId: unknown }>) {
  const [allowed, billing, linkScope] = await Promise.all([
    getUserEffectiveAllowedHostIds(userId).catch(() => [] as number[]),
    getUserUsableTrafficBillingResourceIds(userId).catch(() => ({ hostIds: [] as number[] } as any)),
    getLinkAccessScope({ id: userId, role: "user" }).catch(() => null),
  ]);
  const visible = new Set<number>([...allowed.map(Number), ...((billing?.hostIds || []) as number[]).map(Number)]);
  for (const host of hostRows) if (Number(host.userId) === userId) visible.add(Number(host.id));
  if (linkScope) {
    for (const id of linkScope.hostIds) visible.add(Number(id));
    for (const ids of linkScope.groupHostIds?.values() || []) for (const id of ids) visible.add(Number(id));
  }
  return visible;
}

async function loadTopology(viewer: TopologyViewer, filterUserId: number | null): Promise<TopologyGraphResponse> {
  const db = await getDb();
  const isAdmin = viewer.role === "admin";
  const scopeUserId = isAdmin ? filterUserId : Number(viewer.id);
  if (!db) return { nodes: [], edges: [], rules: [], tunnels: [], groups: [], generatedAt: Date.now(), owners: [], scopeUserId };

  const [hostRows, ruleRows, tunnelRows, hopRows, exitNodeRows, ruleExitRows, groupRows, memberRows, inboundRows, nodeRows, latencies] = await Promise.all([
    db.select({
      id: hosts.id, name: hosts.name, userId: hosts.userId, ip: hosts.ip, ipv4: hosts.ipv4, ipv6: hosts.ipv6,
      entryIp: hosts.entryIp, tunnelEntryIp: hosts.tunnelEntryIp, ddnsDomain: hosts.ddnsDomain, ddnsEnabled: hosts.ddnsEnabled,
      isOnline: hosts.isOnline, geoCountryCode: hosts.geoCountryCode,
    }).from(hosts),
    db.select({
      id: forwardRules.id, name: forwardRules.name, userId: forwardRules.userId, hostId: forwardRules.hostId,
      protocol: forwardRules.protocol, sourcePort: forwardRules.sourcePort, targetIp: forwardRules.targetIp, targetPort: forwardRules.targetPort,
      tunnelId: forwardRules.tunnelId, isEnabled: forwardRules.isEnabled, isRunning: forwardRules.isRunning,
      isForwardGroupTemplate: forwardRules.isForwardGroupTemplate, forwardGroupId: forwardRules.forwardGroupId,
      forwardGroupRuleId: forwardRules.forwardGroupRuleId, forwardGroupMemberId: forwardRules.forwardGroupMemberId,
      routeParentRuleId: forwardRules.routeParentRuleId, routePathKey: forwardRules.routePathKey, routeHopIndex: forwardRules.routeHopIndex,
      proxyNodeId: forwardRules.proxyNodeId, egressType: forwardRules.egressType, egressInboundId: forwardRules.egressInboundId,
      failoverEnabled: forwardRules.failoverEnabled, failoverTargets: forwardRules.failoverTargets, failoverProbeTarget: forwardRules.failoverProbeTarget,
      routeMode: forwardRules.routeMode, routePaths: forwardRules.routePaths, failoverStrategy: forwardRules.failoverStrategy,
    }).from(forwardRules).where(eq(forwardRules.pendingDelete, false)),
    db.select({
      id: tunnels.id, name: tunnels.name, userId: tunnels.userId, entryHostId: tunnels.entryHostId, exitHostId: tunnels.exitHostId,
      entryGroupId: tunnels.entryGroupId, mode: tunnels.mode, listenPort: tunnels.listenPort, isEnabled: tunnels.isEnabled,
      isRunning: tunnels.isRunning, lastLatencyMs: tunnels.lastLatencyMs, lastTestStatus: tunnels.lastTestStatus,
    }).from(tunnels),
    db.select({ tunnelId: tunnelHops.tunnelId, seq: tunnelHops.seq, hostId: tunnelHops.hostId }).from(tunnelHops),
    db.select({ tunnelId: tunnelExitNodes.tunnelId, seq: tunnelExitNodes.seq, hostId: tunnelExitNodes.hostId, isEnabled: tunnelExitNodes.isEnabled }).from(tunnelExitNodes),
    db.select({ ruleId: forwardRuleTunnelExits.ruleId, exitHostId: forwardRuleTunnelExits.exitHostId }).from(forwardRuleTunnelExits),
    db.select({
      id: forwardGroups.id, name: forwardGroups.name, userId: forwardGroups.userId, groupMode: forwardGroups.groupMode,
      entryGroupId: forwardGroups.entryGroupId, domain: forwardGroups.domain, isEnabled: forwardGroups.isEnabled,
      lastStatus: forwardGroups.lastStatus, activeMemberId: forwardGroups.activeMemberId,
    }).from(forwardGroups),
    db.select({
      id: forwardGroupMembers.id, groupId: forwardGroupMembers.groupId, hostId: forwardGroupMembers.hostId, tunnelId: forwardGroupMembers.tunnelId,
      priority: forwardGroupMembers.priority, isEnabled: forwardGroupMembers.isEnabled, healthStatus: forwardGroupMembers.healthStatus,
    }).from(forwardGroupMembers),
    db.select({
      id: proxyInbounds.id, name: proxyInbounds.name, userId: proxyInbounds.userId, hostId: proxyInbounds.hostId,
      protocol: proxyInbounds.protocol, port: proxyInbounds.port, isEnabled: proxyInbounds.isEnabled,
    }).from(proxyInbounds),
    db.select({ nodeId: proxyNodes.id, inboundId: proxyNodes.inboundId }).from(proxyNodes).where(gt(proxyNodes.inboundId, 0)),
    latestRuleLatencies(),
  ]);

  const hopsByTunnel = new Map<number, Array<{ seq: number; hostId: number }>>();
  for (const hop of hopRows as any[]) {
    const list = hopsByTunnel.get(Number(hop.tunnelId)) || [];
    list.push({ seq: Number(hop.seq), hostId: Number(hop.hostId) });
    hopsByTunnel.set(Number(hop.tunnelId), list);
  }
  const exitsByTunnel = new Map<number, Array<{ seq: number; hostId: number; isEnabled: unknown }>>();
  for (const node of exitNodeRows as any[]) {
    const list = exitsByTunnel.get(Number(node.tunnelId)) || [];
    list.push({ seq: Number(node.seq), hostId: Number(node.hostId), isEnabled: node.isEnabled });
    exitsByTunnel.set(Number(node.tunnelId), list);
  }
  const membersByGroup = new Map<number, any[]>();
  for (const member of memberRows as any[]) {
    const list = membersByGroup.get(Number(member.groupId)) || [];
    list.push(member);
    membersByGroup.set(Number(member.groupId), list);
  }
  const tunnelInput: TopologyTunnelRow[] = (tunnelRows as any[]).map((tunnel) => ({
    ...tunnel,
    hops: hopsByTunnel.get(Number(tunnel.id)) || [],
    exitNodes: exitsByTunnel.get(Number(tunnel.id)) || [],
  }));
  const groupInput: TopologyGroupRow[] = (groupRows as any[]).map((group) => ({
    ...group,
    members: membersByGroup.get(Number(group.id)) || [],
  }));

  let scope: TopologyScope | null = null;
  if (scopeUserId) {
    scope = {
      userId: scopeUserId,
      mask: !isAdmin,
      visibleHostIds: isAdmin ? new Set<number>() : await visibleHostIdsForUser(scopeUserId, hostRows as any[]),
    };
  }

  const graph = buildNetworkTopology({
    hosts: hostRows as any[],
    rules: ruleRows as unknown as TopologyRuleRow[],
    tunnels: tunnelInput,
    groups: groupInput,
    inbounds: inboundRows as any[],
    ruleTunnelExits: (ruleExitRows as any[]).map((row) => ({ ruleId: Number(row.ruleId), exitHostId: Number(row.exitHostId) })),
    proxyNodeInbounds: (nodeRows as any[]).map((row) => ({ nodeId: Number(row.nodeId), inboundId: Number(row.inboundId) })),
    ruleLatencyMs: latencies,
    routeStats: routeStatsFor,
    scope,
  });

  let owners: Array<{ id: number; label: string }> = [];
  if (isAdmin) {
    const ownerIds = new Set<number>();
    for (const rule of ruleRows as any[]) if (!rule.routeParentRuleId) ownerIds.add(Number(rule.userId));
    for (const tunnel of tunnelRows as any[]) ownerIds.add(Number(tunnel.userId));
    for (const group of groupRows as any[]) ownerIds.add(Number(group.userId));
    for (const inbound of inboundRows as any[]) ownerIds.add(Number(inbound.userId));
    const ids = Array.from(ownerIds).filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length > 0) {
      const userRows = await db.select({ id: users.id, username: users.username, name: users.name }).from(users).where(inArray(users.id, ids));
      owners = (userRows as any[])
        .map((row) => ({ id: Number(row.id), label: String(row.name || row.username || `用户 ${row.id}`) }))
        .sort((left, right) => left.id - right.id);
    }
  }

  return { ...graph, edges: withEdgeRates(graph.edges), generatedAt: Date.now(), owners, scopeUserId };
}

/** 每条边此刻的速率：经过它的规则的实时速率相加（server/ruleLiveRates，内存里的）。 */
function withEdgeRates(edges: TopologyGraph["edges"]) {
  const ruleIds = Array.from(new Set(edges.flatMap((edge) => edge.ruleIds)));
  if (ruleIds.length === 0) return edges;
  const rates = getRuleLiveRates(ruleIds);
  if (rates.size === 0) return edges;
  return edges.map((edge) => {
    let total = 0;
    let known = false;
    for (const ruleId of edge.ruleIds) {
      const rate = rates.get(ruleId);
      if (!rate) continue;
      known = true;
      total += rate.inBps + rate.outBps;
    }
    // 备用路径上没有流量：规则的速率是整条规则的，别把它也算到备用那几段上。
    if (edge.activePath === false) return edge;
    return known ? { ...edge, rateBps: Math.round(total) } : edge;
  });
}

export function getNetworkTopology(viewer: TopologyViewer, options: { userId?: number | null } = {}) {
  const isAdmin = viewer.role === "admin";
  const filterUserId = isAdmin && options.userId ? Number(options.userId) : null;
  const key = isAdmin ? `admin:${filterUserId ?? "all"}` : `user:${Number(viewer.id)}`;
  return topologyCache.get(key, { ttlMs: 10_000, staleMs: 20_000 }, () => loadTopology(viewer, filterUserId));
}
