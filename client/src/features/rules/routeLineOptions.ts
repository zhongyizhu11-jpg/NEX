import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";
import type { RoutePolicyRule } from "@shared/routePolicy";
import type { RouteHostOption } from "./RouteGroupFields";
import type { RouteLinePool, RouteLineTunnel } from "./RouteLinesEditor";

/*
  线路编辑要的几样候选（主机、节点池、能当一段的隧道），规则表单和「编辑线路组」弹窗各自查，
  查回来的行在这里统一翻成编辑器吃的形状 —— 以前两边各抄一份，改一处忘一处。

  hosts.options、tunnels.options、forwardGroups.options、proxySubscriptions.listNodes、rules.list
  在服务端是拼出来的行、没有类型：下面写明线路这几页读它们的哪些字段。节点池服务端有类型，直接用。
*/

export type HostOptionRow = { id: number | string; name?: string | null; isOnline?: unknown; agentVersion?: string | null };
export type TunnelOptionRow = {
  id: number | string;
  name?: string | null;
  entryHostId?: number | string | null;
  exitHostId?: number | string | null;
  entryGroupId?: number | string | null;
  mode?: string | null;
  relayMode?: string | null;
};
export type ForwardGroupOptionRow = { id: number | string; groupMode?: string | null; domain?: string | null; members?: ReadonlyArray<{ isEnabled?: unknown }> | null };
export type ProxyNodeRow = { id: number | string; name?: string | null; isEnabled?: unknown; address?: string | null; port?: number | string | null; protocol?: string | null };
export type NodePoolRow = inferRouterOutputs<AppRouter>["lineDiagnostics"]["nodePools"][number];

/** 一条规则（rules.list 的一行）里线路编辑、线路详情读的字段。 */
export type LineRuleRow = RoutePolicyRule & {
  id: number | string;
  name?: string | null;
  /** 管理员看全部时：这条规则是谁的。 */
  userName?: string | null;
  hostId?: number | string | null;
  tunnelId?: number | string | null;
  forwardGroupId?: number | string | null;
  forwardGroupRuleId?: number | string | null;
  sourcePort?: number | string | null;
  targetIp?: string | null;
  targetPort?: number | string | null;
};

export function routeHostOptionsOf(hosts: readonly HostOptionRow[] | null | undefined): RouteHostOption[] {
  return (hosts || []).map((host) => ({ id: Number(host.id), name: String(host.name || ""), isOnline: !!host.isOnline, agentVersion: host.agentVersion ?? null }));
}

export function routeLinePoolsOf(pools: readonly NodePoolRow[] | null | undefined): RouteLinePool[] {
  return (pools || []).map((pool) => ({
    id: Number(pool.id),
    name: String(pool.name),
    role: String(pool.role),
    members: (pool.members || []).map((member) => ({ hostId: Number(member.hostId), name: String(member.name), online: !!member.online, maintenance: !!member.maintenance })),
  }));
}

/** 能当线路一段的隧道：入口、出口都是单台机器（入口组隧道不行）。 */
export function routeLineTunnelsOf(tunnels: readonly TunnelOptionRow[] | null | undefined): RouteLineTunnel[] {
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
