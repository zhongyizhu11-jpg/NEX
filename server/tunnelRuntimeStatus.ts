const tunnelRuntimeStatus = new Map<number, Map<number, boolean>>();
const tunnelRuntimeGeneration = new Map<number, number>();
// NEX V2 隧道每台主机实际用的 WireGuard 数据面（Agent 2.2.217 起上报）：
// kernel = 内核 WireGuard，netstack = wireguard-go 用户态。
export type TunnelWireGuardPlane = "kernel" | "netstack";
const tunnelWireGuardPlanes = new Map<number, Map<number, TunnelWireGuardPlane>>();

function normalizeTunnelId(tunnelId: unknown) {
  const id = Number(tunnelId);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

export function bumpTunnelRuntimeGeneration(tunnelId: number) {
  const tid = normalizeTunnelId(tunnelId);
  if (!tid) return 0;
  const current = tunnelRuntimeGeneration.get(tid) || 0;
  const next = current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
  tunnelRuntimeGeneration.set(tid, next);
  return next;
}

export function getTunnelRuntimeGeneration(tunnelId: number) {
  const tid = normalizeTunnelId(tunnelId);
  return tid ? tunnelRuntimeGeneration.get(tid) || 0 : 0;
}

export function recordTunnelRuntimeHostStatus(tunnelId: number, hostId: number, running: boolean) {
  const tid = normalizeTunnelId(tunnelId);
  const hid = Number(hostId);
  if (!tid || !Number.isFinite(hid) || hid <= 0) return;
  let hosts = tunnelRuntimeStatus.get(tid);
  if (!hosts) {
    hosts = new Map<number, boolean>();
    tunnelRuntimeStatus.set(tid, hosts);
  }
  hosts.set(hid, !!running);
}

export function isTunnelRuntimeHostReady(tunnelId: number, hostId: number) {
  return tunnelRuntimeStatus.get(Number(tunnelId))?.get(Number(hostId)) === true;
}

export function getTunnelRuntimeHostStatus(tunnelId: number, hostId: number) {
  return tunnelRuntimeStatus.get(Number(tunnelId))?.get(Number(hostId));
}

export type TunnelRuntimeTopology = {
  entryHostIds?: number[];
  hopHostIds?: number[];
  primaryExitHostId?: number;
  extraExitHostIds?: number[];
  relayMode?: string;
  loadBalanceEnabled?: boolean;
  loadBalanceStrategy?: string;
};

export function getTunnelRuntimeTopologyStatus(tunnelId: number, topology: TunnelRuntimeTopology) {
  const unique = (values: Array<number | undefined>) => Array.from(new Set(values
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0)));
  const hops = unique(topology.hopHostIds || []);
  const entryCandidates = unique(topology.entryHostIds?.length ? topology.entryHostIds : [hops[0]]);
  const useExtraExits = topology.loadBalanceEnabled === true && String(topology.loadBalanceStrategy || "").toLowerCase() !== "none";
  const exitCandidates = unique([
    Number(topology.primaryExitHostId || hops[hops.length - 1] || 0),
    ...(useExtraExits ? topology.extraExitHostIds || [] : []),
  ]);
  const ready = (hostId: number) => isTunnelRuntimeHostReady(tunnelId, hostId);
  const relayCandidates = hops.length >= 3 ? hops.slice(1, -1) : [];
  const entryReady = hops.length < 3 || entryCandidates.some(ready);
  const exitReady = exitCandidates.some(ready);
  const relayReady = relayCandidates.length === 0
    || (["failover", "hot_standby"].includes(String(topology.relayMode || "chain").toLowerCase())
      ? relayCandidates.some(ready)
      : relayCandidates.every(ready));
  const observedHostIds = unique([...entryCandidates, ...relayCandidates, ...exitCandidates]);
  return {
    running: entryReady && relayReady && exitReady,
    readyCount: observedHostIds.filter(ready).length,
    hostCount: observedHostIds.length,
    missingHostIds: observedHostIds.filter((hostId) => !ready(hostId)),
  };
}

/** 用一台主机这次上报的完整列表替换它的数据面记录。 */
export function replaceHostWireGuardPlanes(hostId: number, planes: Array<{ tunnelId: number; plane: TunnelWireGuardPlane }>) {
  const hid = Number(hostId);
  if (!Number.isFinite(hid) || hid <= 0) return;
  for (const [tunnelId, hosts] of tunnelWireGuardPlanes.entries()) {
    hosts.delete(hid);
    if (hosts.size === 0) tunnelWireGuardPlanes.delete(tunnelId);
  }
  for (const { tunnelId, plane } of planes) {
    const tid = normalizeTunnelId(tunnelId);
    if (!tid) continue;
    let hosts = tunnelWireGuardPlanes.get(tid);
    if (!hosts) {
      hosts = new Map<number, TunnelWireGuardPlane>();
      tunnelWireGuardPlanes.set(tid, hosts);
    }
    hosts.set(hid, plane);
  }
}

/** 某台主机在这条隧道上报的数据面；没上报返回 undefined。 */
export function getHostWireGuardPlane(tunnelId: number, hostId: number): TunnelWireGuardPlane | undefined {
  return tunnelWireGuardPlanes.get(Number(tunnelId))?.get(Number(hostId));
}

/** 隧道整体的数据面：所有上报的主机一致时返回那一种，不一致返回 mixed，没有上报返回 undefined。 */
export function getTunnelWireGuardPlane(tunnelId: number): TunnelWireGuardPlane | "mixed" | undefined {
  const hosts = tunnelWireGuardPlanes.get(Number(tunnelId));
  if (!hosts || hosts.size === 0) return undefined;
  const kinds = new Set(hosts.values());
  if (kinds.size === 1) return kinds.values().next().value as TunnelWireGuardPlane;
  return "mixed";
}

export function clearTunnelRuntimeStatusForHost(hostId: number) {
  const hid = Number(hostId);
  if (!Number.isFinite(hid) || hid <= 0) return [];
  replaceHostWireGuardPlanes(hid, []);
  const affectedTunnelIds: number[] = [];
  for (const [tunnelId, hosts] of tunnelRuntimeStatus.entries()) {
    const deleted = hosts.delete(hid);
    if (deleted) {
      affectedTunnelIds.push(tunnelId);
      bumpTunnelRuntimeGeneration(tunnelId);
    }
    if (hosts.size === 0) tunnelRuntimeStatus.delete(tunnelId);
  }
  return affectedTunnelIds;
}

export function clearTunnelRuntimeStatus(tunnelId: number) {
  const tid = normalizeTunnelId(tunnelId);
  if (!tid) return;
  tunnelRuntimeStatus.delete(tid);
  bumpTunnelRuntimeGeneration(tid);
}
