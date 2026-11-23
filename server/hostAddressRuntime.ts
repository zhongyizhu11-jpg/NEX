import * as db from "./db";
import { syncRouteRelayRulesForHost } from "./routeGroups";
import { pushAgentRefresh } from "./agentEvents";
import * as hopRepo from "./repositories/tunnelRepository";
import { clearTunnelRuntimeStatusForHost } from "./tunnelRuntimeStatus";
import { scheduleHostDdnsUpdate } from "./hostDdns";
import { scheduleRuleEntryDomainSyncForHost } from "./ruleEntryDomain";

export function hostIngressAddress(hostLike: any) {
  return String(hostLike?.entryIp || hostLike?.ipv4 || hostLike?.ipv6 || hostLike?.ip || "").trim();
}

function hostUsesAutomaticIngress(hostLike: any) {
  return !String(hostLike?.entryIp || "").trim();
}

export async function refreshAgentsAffectedByHostAddress(hostId: number, reason: string) {
  const affected = new Set<number>();
  const id = Number(hostId);
  if (Number.isFinite(id) && id > 0) affected.add(id);

  const tunnels = await db.getTunnelsByHost(id);
  await Promise.all((tunnels as any[]).map(async (tunnel: any) => {
    const entryHostId = Number(tunnel?.entryHostId || 0);
    const exitHostId = Number(tunnel?.exitHostId || 0);
    if (entryHostId > 0) affected.add(entryHostId);
    if (exitHostId > 0) affected.add(exitHostId);

    const hops = await hopRepo.getTunnelHops(Number(tunnel?.id || 0)).catch(() => []);
    for (const hop of hops || []) {
      const hopHostId = Number((hop as any)?.hostId || 0);
      if (hopHostId > 0) affected.add(hopHostId);
    }

    const exits = await hopRepo.getTunnelExitNodes(Number(tunnel?.id || 0)).catch(() => []);
    for (const exit of exits || []) {
      const exitHostId = Number((exit as any)?.hostId || 0);
      if (exitHostId > 0) affected.add(exitHostId);
    }
  }));

  // 换隧道后留在旧入口的桥接拨的是这台机器的入口地址：地址变了，那些旧入口要跟着重下。
  for (const bridgeHostId of await db.getEntryBridgeHostIdsForRulesOnHost(id).catch(() => [] as number[])) {
    affected.add(bridgeHostId);
  }

  for (const affectedHostId of affected) {
    pushAgentRefresh(affectedHostId, reason);
  }
}

export async function refreshHostAddressRuntime(hostId: number, previousHost: any, reason: string) {
  await db.syncForwardChainsForHost(hostId, previousHost);
  await db.syncTunnelsForHostAddress(hostId, previousHost);
  /**
   * 订阅这一层也要跟着走。
   *
   * 上面两行把转发链和隧道改到了新地址，Agent 也会收到新配置 —— 唯独这台机器上
   * 派生出来的订阅节点还写着旧地址。它拿的是**同一个入口**，却是唯一一处没人
   * 更新的：客户端拉到订阅连不上，而面板上转发和隧道都显示正常。
   */
  await db.syncProxyNodesForHostAddress(hostId);
  /*
   * 线路组的中转也一样：这台机器要是某条路径的中转，上一跳（或入口）拨的是它的入口
   * 地址加端口 —— 地址变了，上一跳的目标要跟着改，入口的 dial 也要重写。
   */
  await syncRouteRelayRulesForHost(hostId, { reason }).catch((error) => {
    console.warn(`[HostAddress] Route relay sync failed host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
  });
  await db.resetAgentRuntimeStateForHost(hostId);
  clearTunnelRuntimeStatusForHost(hostId);
  await refreshAgentsAffectedByHostAddress(hostId, reason);
}

export async function handleHostAddressChanged(hostId: number, currentHost: any, previousHost: any, reason: string) {
  scheduleHostDdnsUpdate(currentHost, reason);
  // 以这台机器为入口的规则，专属域名的记录值要跟着新地址走。
  void scheduleRuleEntryDomainSyncForHost(hostId, reason);
  await db.runForwardGroupsForHostAddressChange(hostId, reason).catch((error) => {
    console.warn(`[HostAddress] Forward group DDNS refresh failed host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (hostUsesAutomaticIngress(previousHost)) {
    await refreshHostAddressRuntime(hostId, previousHost, reason);
  }
}
