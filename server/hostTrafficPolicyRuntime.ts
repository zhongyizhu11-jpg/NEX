import { getForwardGroups, scheduleForwardGroupFailover } from "./repositories/forwardGroupRepository";
import { getTunnelExitNodesByTunnelIds, getTunnelHopsByTunnelIds, getTunnels } from "./repositories/tunnelRepository";
import { getForwardGroupChildRules } from "./repositories/forwardRuleRepository";
import { pushAgentRefresh } from "./agentEvents";

type TopologyEntry = { tunnel: any; hops: any[]; exits: any[] };

function tunnelHostIds({ tunnel, hops, exits }: TopologyEntry) {
  return [tunnel.entryHostId, tunnel.exitHostId, ...hops.map((hop) => hop.hostId), ...exits.map((exit) => exit.hostId)]
    .map(Number)
    .filter((id) => id > 0);
}

/**
 * 算出一台主机的暂停 / 恢复会影响到哪些组和 Agent（纯函数，单独导出给测试）：
 * 直接用到这台主机的隧道、以它（或这些隧道）为成员的组、挂在这些组上的入口组 / 出口组隧道，
 * 以及这些隧道和组的全部主机。
 */
export function planHostTrafficPolicyRefresh(hostId: number, groups: any[], topology: TopologyEntry[]) {
  const affectedHosts = new Set<number>([hostId]);
  const affectedTunnels = new Set<number>();
  for (const entry of topology) {
    if (tunnelHostIds(entry).includes(hostId)) affectedTunnels.add(Number(entry.tunnel.id));
  }
  const affectedGroups = new Set<number>();
  for (const group of groups) {
    if ((group.members || []).some((member: any) => Number(member.hostId) === hostId || affectedTunnels.has(Number(member.tunnelId)))) {
      affectedGroups.add(Number(group.id));
    }
  }
  for (const group of groups) {
    if (affectedGroups.has(Number(group.entryGroupId))) affectedGroups.add(Number(group.id));
  }
  for (const entry of topology) {
    const { tunnel } = entry;
    if (affectedTunnels.has(Number(tunnel.id)) || affectedGroups.has(Number(tunnel.entryGroupId)) || affectedGroups.has(Number(tunnel.exitGroupId))) {
      affectedTunnels.add(Number(tunnel.id));
      for (const id of tunnelHostIds(entry)) affectedHosts.add(id);
    }
  }
  for (const group of groups) {
    if (!affectedGroups.has(Number(group.id))) continue;
    for (const member of group.members || []) if (Number(member.hostId) > 0) affectedHosts.add(Number(member.hostId));
  }
  return { affectedHosts, affectedTunnels, affectedGroups };
}

/**
 * 暂停 / 恢复之后：重新评估受影响的组（DDNS、入口 / 出口成员），并让受影响的 Agent 立刻
 * 拉一次配置（心跳里按暂停名单生成运行时副本，见 agentHeartbeatRoute 的 trafficExcludedHosts）。
 * 不改任何保存着的配置、端口分配和开关。
 */
export async function refreshHostTrafficPolicyRuntime(hostId: number) {
  const [groups, tunnels] = await Promise.all([getForwardGroups(), getTunnels()]);
  const tunnelIds = (tunnels as any[]).map((tunnel) => Number(tunnel.id));
  const [hops, exits] = await Promise.all([getTunnelHopsByTunnelIds(tunnelIds), getTunnelExitNodesByTunnelIds(tunnelIds)]);
  const hopsByTunnel = new Map<number, any[]>();
  const exitsByTunnel = new Map<number, any[]>();
  for (const [rows, map] of [[hops, hopsByTunnel], [exits, exitsByTunnel]] as const) {
    for (const row of rows as any[]) {
      const id = Number(row.tunnelId);
      const items = map.get(id) || [];
      items.push(row);
      map.set(id, items);
    }
  }
  const topology = (tunnels as any[]).map((tunnel) => ({ tunnel, hops: hopsByTunnel.get(Number(tunnel.id)) || [], exits: exitsByTunnel.get(Number(tunnel.id)) || [] }));
  const plan = planHostTrafficPolicyRefresh(hostId, groups as any[], topology);
  // 组的子规则可能装在组成员以外的主机上（规则主人的那台），一起通知。
  for (const groupId of plan.affectedGroups) {
    for (const rule of await getForwardGroupChildRules(groupId)) {
      if (Number((rule as any).hostId) > 0) plan.affectedHosts.add(Number((rule as any).hostId));
    }
  }
  scheduleForwardGroupFailover([...plan.affectedGroups]);
  for (const id of plan.affectedHosts) pushAgentRefresh(id, "host-traffic-policy-changed", { urgent: true });
  return plan;
}
