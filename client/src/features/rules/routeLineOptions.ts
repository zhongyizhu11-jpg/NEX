import type { RouteHostOption } from "./RouteGroupFields";
import type { RouteLinePool, RouteLineTunnel } from "./RouteLinesEditor";

/*
  线路编辑要的几样候选（主机、节点池、能当一段的隧道），规则表单和「编辑线路组」弹窗各自查，
  查回来的行在这里统一翻成编辑器吃的形状 —— 以前两边各抄一份，改一处忘一处。
*/

export function routeHostOptionsOf(hosts: readonly any[] | null | undefined): RouteHostOption[] {
  return (hosts || []).map((host) => ({ id: Number(host.id), name: String(host.name || ""), isOnline: !!host.isOnline, agentVersion: host.agentVersion ?? null }));
}

export function routeLinePoolsOf(pools: readonly any[] | null | undefined): RouteLinePool[] {
  return (pools || []).map((pool) => ({
    id: Number(pool.id),
    name: String(pool.name),
    role: String(pool.role),
    members: (pool.members || []).map((member: any) => ({ hostId: Number(member.hostId), name: String(member.name), online: !!member.online, maintenance: !!member.maintenance })),
  }));
}

/** 能当线路一段的隧道：入口、出口都是单台机器（入口组隧道不行）。 */
export function routeLineTunnelsOf(tunnels: readonly any[] | null | undefined): RouteLineTunnel[] {
  return (tunnels || [])
    .filter((tunnel) => Number(tunnel.entryHostId) > 0 && Number(tunnel.exitHostId) > 0 && !(Number(tunnel.entryGroupId || 0) > 0))
    .map((tunnel) => ({
      id: Number(tunnel.id),
      name: String(tunnel.name || `隧道 ${tunnel.id}`),
      entryHostId: Number(tunnel.entryHostId),
      exitHostId: Number(tunnel.exitHostId),
      mode: tunnel.mode ? String(tunnel.mode) : null,
      relayMode: tunnel.relayMode ? String(tunnel.relayMode) : null,
    }));
}
