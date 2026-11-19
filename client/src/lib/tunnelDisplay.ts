export function tunnelEndpointName(tunnel: any | null | undefined, role: "entry" | "exit", hosts: any[] | undefined) {
  const hostId = Number(role === "entry" ? tunnel?.entryHostId : tunnel?.exitHostId);
  const fromList = hosts?.find((host: any) => Number(host.id) === hostId);
  const fromTunnel = role === "entry" ? tunnel?.entryHost : tunnel?.exitHost;
  return fromList?.name || fromTunnel?.name || `主机 #${hostId}`;
}

export function tunnelHopHostName(tunnel: any | null | undefined, hostId: number, hosts: any[] | undefined) {
  const id = Number(hostId);
  const fromList = hosts?.find((host: any) => Number(host.id) === id);
  const fromTunnel = Array.isArray(tunnel?.hopHosts)
    ? tunnel.hopHosts.find((host: any) => Number(host?.id) === id)
    : null;
  if (fromList?.name || fromTunnel?.name) return fromList?.name || fromTunnel?.name;
  if (Number(tunnel?.entryHostId) === id) return tunnelEndpointName(tunnel, "entry", hosts);
  if (Number(tunnel?.exitHostId) === id) return tunnelEndpointName(tunnel, "exit", hosts);
  return `主机 #${id}`;
}

export function getTunnelLoadBalanceExitNames(tunnel: any | null | undefined, hosts: any[] | undefined) {
  if (!Array.isArray(tunnel?.loadBalanceExits)) return [];
  const names = tunnel.loadBalanceExits
    .map((exit: any) => Number(exit?.hostId || 0))
    .filter((hostId: number) => hostId > 0)
    .map((hostId: number) => tunnelHopHostName(tunnel, hostId, hosts))
    .map((name: string) => String(name || "").trim())
    .filter(Boolean);
  return Array.from(new Set(names));
}

export function getTunnelExitNames(tunnel: any | null | undefined, hosts: any[] | undefined) {
  const primaryExitId = Number(tunnel?.exitHostId || 0);
  const primaryName = primaryExitId > 0 ? tunnelHopHostName(tunnel, primaryExitId, hosts) : "";
  const names = [
    String(primaryName || "").trim(),
    ...getTunnelLoadBalanceExitNames(tunnel, hosts),
  ].filter(Boolean);
  return Array.from(new Set(names));
}

export function getTunnelHopIds(tunnel: any | null | undefined) {
  const hopIds = Array.isArray(tunnel?.hopHostIds)
    ? tunnel.hopHostIds.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
    : [];
  if (hopIds.length >= 2) return hopIds;
  return [Number(tunnel?.entryHostId || 0), Number(tunnel?.exitHostId || 0)].filter((id) => id > 0);
}

export function getTunnelRouteText(
  tunnel: any | null | undefined,
  hosts: any[] | undefined,
  exitGroupName?: string | null,
) {
  const hopNames = getTunnelHopIds(tunnel)
    .map((hostId: number) => tunnelHopHostName(tunnel, hostId, hosts))
    .map((name: string) => String(name || "").trim())
    .filter(Boolean);
  if (hopNames.length === 0) return "-";
  const normalizedExitGroupName = String(exitGroupName || "").trim();
  if (normalizedExitGroupName) {
    hopNames[hopNames.length - 1] = normalizedExitGroupName;
    const exitNames = getTunnelExitNames(tunnel, hosts);
    const routeText = ["failover", "hot_standby"].includes(String(tunnel?.relayMode || "").toLowerCase()) && hopNames.length >= 4
      ? `${hopNames[0]} -> 中转：${hopNames.slice(1, -1).join(" / ")} -> ${hopNames[hopNames.length - 1]}`
      : hopNames.join(" -> ");
    return `${routeText}${exitNames.length > 0 ? `\uFF1B\u51FA\u53E3\uFF1A${exitNames.join(" / ")}` : ""}`;
  }
  const routeText = ["failover", "hot_standby"].includes(String(tunnel?.relayMode || "").toLowerCase()) && hopNames.length >= 4
    ? `${hopNames[0]} -> 中转：${hopNames.slice(1, -1).join(" / ")} -> ${hopNames[hopNames.length - 1]}`
    : hopNames.join(" -> ");
  const extraExitNames = getTunnelLoadBalanceExitNames(tunnel, hosts)
    .filter((name) => !hopNames.includes(name));
  if (extraExitNames.length > 0) {
    return `${routeText}；出口：${getTunnelExitNames(tunnel, hosts).join(" / ")}`;
  }
  return routeText;
}

export function tunnelTestIndicatesTimeout(input: {
  status?: unknown;
  details?: Array<{ success?: unknown; pending?: unknown; message?: unknown; latencyMs?: unknown }>;
  latestLatencyIsTimeout?: unknown;
}) {
  const status = String(input.status || "").toLowerCase();
  if (status === "success") return false;
  if (status === "failed") return true;
  if (status === "pending" || status === "running") return false;

  const details = (input.details || []).filter((detail) => (
    detail.pending
    || detail.success
    || detail.message
    || (typeof detail.latencyMs === "number" && Number.isFinite(detail.latencyMs))
  ));
  if (details.some((detail) => detail.pending)) return false;
  if (details.length > 0) return !details.some((detail) => detail.success === true);
  return input.latestLatencyIsTimeout === true;
}

export type ExitGroupMemberLite = {
  id: number;
  hostId?: number | null;
  memberType?: string | null;
  priority?: number | null;
  aggregationWeight?: number | null;
  isEnabled?: unknown;
};

/**
 * 负载均衡弹窗列哪几台、按什么顺序：出口组按组里的顺序（停用的不算，刚点过 ↑↓ 还没回来的先按点的顺序）；
 * 没用出口组的按主出口 + 额外出口的 seq。
 */
export function tunnelBalanceExits(
  tunnel: { exitHostId?: unknown; loadBalanceExits?: unknown } | null | undefined,
  groupMembers: readonly ExitGroupMemberLite[],
  override: readonly number[] | null = null,
): Array<{ hostId: number; weight: number | null }> {
  const exits: Array<{ hostId: number; weight: number | null }> = [];
  const push = (hostId: number, weight: unknown) => {
    if (hostId > 0 && !exits.some((exit) => exit.hostId === hostId)) exits.push({ hostId, weight: Number(weight) > 0 ? Number(weight) : null });
  };
  if (groupMembers.length > 0) {
    const serverOrder = groupMembers.map((member) => Number(member.hostId));
    const useOverride = !!override && override.length === serverOrder.length && override.every((id) => serverOrder.includes(id));
    const ordered = useOverride ? override!.map((hostId) => groupMembers.find((member) => Number(member.hostId) === hostId)!) : groupMembers;
    for (const member of ordered) push(Number(member.hostId), member.aggregationWeight);
    return exits;
  }
  push(Number(tunnel?.exitHostId || 0), null);
  const extra = (Array.isArray(tunnel?.loadBalanceExits) ? tunnel!.loadBalanceExits as unknown[] : [])
    .map((raw) => (raw && typeof raw === "object" ? raw : {}) as { hostId?: unknown; weight?: unknown; isEnabled?: unknown; seq?: unknown })
    .filter((exit) => exit.isEnabled !== false)
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  for (const exit of extra) push(Number(exit.hostId || 0), exit.weight);
  return exits;
}

/**
 * 弹窗里点 ↑↓：把这台和相邻的那台对调，算出整组成员的新顺序（停用的、非主机的成员留在原位）。
 * 返回新的出口顺序（给界面先显示）和整组成员 id（给 forwardGroups.reorder）；挪不了返回 null。
 */
export function moveExitInGroup(
  allMembers: readonly ExitGroupMemberLite[],
  shownHostIds: readonly number[],
  hostId: number,
  delta: -1 | 1,
): { hostIds: number[]; memberIds: number[] } | null {
  const index = shownHostIds.indexOf(hostId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= shownHostIds.length) return null;
  const hostIds = [...shownHostIds];
  [hostIds[index], hostIds[target]] = [hostIds[target], hostIds[index]];
  const all = [...allMembers].sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
  const isShownHost = (member: ExitGroupMemberLite) => member.memberType === "host" && hostIds.includes(Number(member.hostId));
  const byHost = new Map(all.filter(isShownHost).map((member) => [Number(member.hostId), member] as const));
  const next = [...all];
  all.map((member, slot) => (isShownHost(member) ? slot : -1)).filter((slot) => slot >= 0)
    .forEach((slot, order) => { next[slot] = byHost.get(hostIds[order])!; });
  if (next.some((member) => !member || !(Number(member.id) > 0))) return null;
  return { hostIds, memberIds: next.map((member) => Number(member.id)) };
}
