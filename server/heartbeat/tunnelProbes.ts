/*
  从 server/agentHeartbeatRoute.ts 第 1948-2026 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { runtimeBool } from "../agentHeartbeatRuntime";
import { isTunnelProtocolEnabled } from "../forwardProtocolSettings";
import { isForwardXWireGuardV2 } from "../forwardXWireGuard";
import { tunnelProbeTopologyKey } from "../probeTopology";
import { tunnelRelayCandidates, tunnelRelayUsesParallelRelays } from "@shared/tunnelRelay";

export type BuildTunnelProbesContext = {
  hostTunnels: any;
  forwardProtocolSettings: any;
  tunnelHopsByTunnelId: Map<number, Array<any>>;
  tunnelExitNodesByTunnelId: Map<number, Array<any>>;
  host: any;
  isCurrentHostTunnelEntry: (tunnel: any) => boolean;
  getHopDialAddress: (hop: any, tunnel?: any) => Promise<string>;
  tunnelExitEndpointById: Map<number, { host: string; port: number; udpPort?: number; }>;
  forwardXExtraExitRoutes: (tunnel: any) => Promise<Array<{ hostId: number; host: string; port: number; udpPort: number; key: string; }>>;
};

export type BuildTunnelProbesResult = {
  tunnelProbes: Array<any>;
};

export async function buildTunnelProbes(ctx: BuildTunnelProbesContext): Promise<BuildTunnelProbesResult> {
  const { hostTunnels, forwardProtocolSettings, tunnelHopsByTunnelId, tunnelExitNodesByTunnelId, host, isCurrentHostTunnelEntry, getHopDialAddress, tunnelExitEndpointById, forwardXExtraExitRoutes } = ctx;
  const tunnelProbes = (await Promise.all((hostTunnels as any[])
    .filter((tunnel: any) => runtimeBool(tunnel.isEnabled) && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel))
    .map(async (tunnel: any) => {
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      const topologyKey = tunnelProbeTopologyKey(
        tunnel,
        Array.isArray(hops) ? hops : [],
        tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [],
      );
      if (Array.isArray(hops) && hops.length >= 3) {
        const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
        const currentHostIsEntry = isCurrentHostTunnelEntry(tunnel);
        if (!currentHostIsEntry && (hostIdx < 0 || hostIdx >= hops.length - 1)) return null;
        const routeHostIdx = currentHostIsEntry ? 0 : hostIdx;
        const relayFailover = tunnelRelayUsesParallelRelays(tunnel, hops);
        const probeTargets = relayFailover && currentHostIsEntry
          ? tunnelRelayCandidates(hops).map((hop: any, index: number) => ({ hop, index: index + 1 }))
          : [{ hop: relayFailover ? hops[hops.length - 1] : hops[routeHostIdx + 1], index: routeHostIdx + 1 }];
        const probes = await Promise.all(probeTargets.map(async ({ hop: nextHop, index: targetIndex }: any) => {
          const targetIp = await getHopDialAddress(nextHop, tunnel);
          const targetPort = Number(nextHop?.listenPort) || 0;
          if (!targetIp || targetPort <= 0) return null;
          const relayCandidateIndex = relayFailover ? (currentHostIsEntry ? targetIndex : hostIdx) : 0;
          return {
            tunnelId: tunnel.id,
            targetIp,
            targetPort,
            protocol: "tcp",
            hopIndex: relayFailover ? (currentHostIsEntry ? 0 : 1) : routeHostIdx,
            hopCount: relayFailover ? 2 : hops.length - 1,
            ...(relayFailover ? {
              seriesKey: `relay-${relayCandidateIndex}`,
              seriesLabel: `中转 ${relayCandidateIndex}`,
            } : {}),
            probeKey: `tunnel:${Number(tunnel.id)}:host:${Number(host.id)}:hop:${routeHostIdx}/${hops.length - 1}:target:${targetIndex}:${String(targetIp).toLowerCase()}:${targetPort}`,
            topologyKey,
            wireGuardPeerId: isForwardXWireGuardV2(tunnel) ? String(Number(nextHop?.hostId || 0)) : undefined,
          };
        }));
        return probes.filter(Boolean);
      }
      if (!isCurrentHostTunnelEntry(tunnel)) return null;
      const primaryEndpoint = tunnelExitEndpointById.get(tunnel.id);
      const baseProbe = {
        tunnelId: tunnel.id,
        targetIp: primaryEndpoint?.host || "",
        targetPort: Number(primaryEndpoint?.port) || 0,
        protocol: "tcp",
        probeKey: `tunnel:${Number(tunnel.id)}:host:${Number(host.id)}:direct:${String(primaryEndpoint?.host || "").toLowerCase()}:${Number(primaryEndpoint?.port) || 0}`,
        topologyKey,
        wireGuardPeerId: isForwardXWireGuardV2(tunnel) ? String(Number(tunnel.exitHostId || 0)) : undefined,
      };
      if (!runtimeBool((tunnel as any).loadBalanceEnabled)) return baseProbe;
      const probes: any[] = [];
      if (baseProbe.targetIp && baseProbe.targetPort > 0) {
        probes.push({
          ...baseProbe,
          seriesKey: "primary",
          seriesLabel: "主出口",
          probeKey: `${baseProbe.probeKey}:primary`,
        });
      }
      const extraRoutes = await forwardXExtraExitRoutes(tunnel);
      extraRoutes.forEach((route, index) => {
        if (!route.host || Number(route.port) <= 0) return;
        probes.push({
          tunnelId: tunnel.id,
          targetIp: route.host,
          targetPort: Number(route.port) || 0,
          protocol: "tcp",
          seriesKey: `exit-${index + 2}`,
          seriesLabel: `出口 ${index + 2}`,
          probeKey: `tunnel:${Number(tunnel.id)}:host:${Number(host.id)}:direct:${String(route.host).toLowerCase()}:${Number(route.port) || 0}:exit-${index + 2}`,
          topologyKey,
          wireGuardPeerId: isForwardXWireGuardV2(tunnel) ? String(Number((route as any).hostId || 0)) : undefined,
        });
      });
      return probes;
    }))).flat().filter((probe: any) => probe && probe.targetIp && probe.targetPort > 0);
  return { tunnelProbes };
}
