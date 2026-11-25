/*
  从 server/agentHeartbeatRoute.ts 第 1441-1533 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { mimicFilterEndpoint, runtimeBool, udpOverTcpEnabled } from "../agentHeartbeatRuntime";
import { fxpHopKey } from "../agentHeartbeatTunnel";
import { type MimicLifecycleResource } from "../configAudit";
import { isRuleProtocolEnabled } from "../forwardProtocolSettings";
import { isTunnelRelayFailover, tunnelRelayCandidates, tunnelRelayUsesParallelRelays } from "@shared/tunnelRelay";

export type BuildMimicFilterHelpersContext = {
  tunnelHopsByTunnelId: Map<number, Array<any>>;
  getHopDialAddress: (hop: any, tunnel?: any) => Promise<string>;
  forwardXEntryRoute: (tunnel: any) => Promise<{ hostId: number; host: string; port: number; udpPort: number; key: string; }>;
  forwardXExtraExitRoutes: (tunnel: any) => Promise<Array<{ hostId: number; host: string; port: number; udpPort: number; key: string; }>>;
  addMimicFilter: any;
  hostInterface: string;
  forwardProtocolSettings: any;
  host: any;
  tunnelExitNodesByTunnelId: Map<number, Array<any>>;
  isCurrentHostTunnelEntry: (tunnel: any) => boolean;
};

export type BuildMimicFilterHelpersResult = {
  addMimicLocalFilterForPort: (port: unknown, lifecycleResources: MimicLifecycleResource[]) => void;
  collectMimicFiltersForRule: (rule: any, tunnel: any) => Promise<void>;
  forwardXEntryRoutes: (_rule: any, tunnel: any) => Promise<Array<{ hostId: number; host: string; port: number; udpPort: number; key: string; }>>;
  addMimicRemoteFilterForRoutes: (routes: Array<{ host: string; port: number; udpPort?: number; }>, lifecycleResources: MimicLifecycleResource[]) => void;
};

export function buildMimicFilterHelpers(ctx: BuildMimicFilterHelpersContext): BuildMimicFilterHelpersResult {
  const { tunnelHopsByTunnelId, getHopDialAddress, forwardXEntryRoute, forwardXExtraExitRoutes, addMimicFilter, hostInterface, forwardProtocolSettings, host, tunnelExitNodesByTunnelId, isCurrentHostTunnelEntry } = ctx;
  const forwardXEntryRoutes = async (_rule: any, tunnel: any) => {
    const routes: Array<{ hostId: number; host: string; port: number; udpPort: number; key: string }> = [];
    const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
    if (Array.isArray(hops) && tunnelRelayUsesParallelRelays(tunnel, hops)) {
      for (const relayHop of tunnelRelayCandidates(hops) as any[]) {
        const relayHost = String(await getHopDialAddress(relayHop, tunnel)).trim();
        const relayPort = Number(relayHop?.listenPort) || 0;
        const relayKey = fxpHopKey(tunnel, relayHop, Number(relayHop?.seq || 0));
        if (!relayHost || relayPort <= 0 || !relayKey) continue;
        routes.push({
          hostId: Number(relayHop?.hostId || 0),
          host: relayHost,
          port: relayPort,
          udpPort: Number(relayHop?.mimicPort || 0),
          key: relayKey,
        });
      }
      return routes;
    }
    const primary = await forwardXEntryRoute(tunnel);
    if (primary.host && primary.port > 0 && primary.key) routes.push(primary);
    if (!Array.isArray(hops) || hops.length < 3) {
      routes.push(...await forwardXExtraExitRoutes(tunnel));
    }
    return routes;
  };
  const addMimicRemoteFilterForRoutes = (
    routes: Array<{ host: string; port: number; udpPort?: number }>,
    lifecycleResources: MimicLifecycleResource[],
  ) => {
    for (const route of routes) {
      const udpPort = Number(route.udpPort || 0);
      if (udpPort <= 0) continue;
      const endpoint = mimicFilterEndpoint(route.host, udpPort);
      if (endpoint) addMimicFilter(`remote=${endpoint}`, hostInterface, lifecycleResources);
    }
  };
  const addMimicLocalFilterForPort = (port: unknown, lifecycleResources: MimicLifecycleResource[]) => {
    const p = Number(port) || 0;
    if (p <= 0 || p > 65535) return;
    // Mimic natively supports wildcard local filters and tracks interface
    // address changes itself. Avoid resolving only the first global address
    // in a shell command, which can miss the actual WireGuard destination.
    addMimicFilter(`local=0.0.0.0:${p}`, hostInterface, lifecycleResources);
    addMimicFilter(`local=[::]:${p}`, hostInterface, lifecycleResources);
  };
  const collectMimicFiltersForRule = async (rule: any, tunnel: any) => {
    if (!udpOverTcpEnabled(rule, tunnel) || !isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) return;
    const lifecycleResources: MimicLifecycleResource[] = [
      { resourceType: "forward_rule", resourceId: Number(rule.id) },
      { resourceType: "tunnel", resourceId: Number(tunnel.id) },
    ];
    const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
    const hostId = Number(host.id);
    const addCurrentHostExtraExitFilters = () => {
      const extraExitNodes = (tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [])
        .filter((node: any) => runtimeBool(node?.isEnabled, true) && Number(node.hostId) === hostId);
      for (const extraExitNode of extraExitNodes) {
        addMimicLocalFilterForPort(Number((extraExitNode as any).mimicPort || 0), lifecycleResources);
      }
    };
    if (isCurrentHostTunnelEntry(tunnel)) {
      addMimicRemoteFilterForRoutes(await forwardXEntryRoutes(rule, tunnel), lifecycleResources);
    }
    if (Array.isArray(hops) && hops.length >= 2) {
      const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === hostId);
      if (hostIdx >= 0) {
        const currentHop = hops[hostIdx] as any;
        if (hostIdx > 0) {
          addMimicLocalFilterForPort(Number(currentHop?.mimicPort || 0), lifecycleResources);
        }
        if (hostIdx < hops.length - 1) {
          const nextHop = isTunnelRelayFailover(tunnel, hops)
            ? hops[hops.length - 1] as any
            : hops[hostIdx + 1] as any;
          const nextHost = String(await getHopDialAddress(nextHop, tunnel)).trim();
          const nextRoutes = [{ host: nextHost, port: Number(nextHop?.listenPort || 0), udpPort: Number(nextHop?.mimicPort || 0) }];
          const nextIsFinalExit = Number(nextHop?.hostId || 0) === Number((hops[hops.length - 1] as any)?.hostId || 0);
          if (nextIsFinalExit && runtimeBool((tunnel as any).loadBalanceEnabled)) {
            nextRoutes.push(...await forwardXExtraExitRoutes(tunnel));
          }
          addMimicRemoteFilterForRoutes(nextRoutes, lifecycleResources);
        }
      }
      addCurrentHostExtraExitFilters();
      return;
    }
    const primaryExitHostId = Number(tunnel.exitHostId || 0);
    if (primaryExitHostId === hostId) {
      addMimicLocalFilterForPort(Number((tunnel as any).mimicPort) || 0, lifecycleResources);
    }
    addCurrentHostExtraExitFilters();
  };
  return { addMimicLocalFilterForPort, collectMimicFiltersForRule, forwardXEntryRoutes, addMimicRemoteFilterForRoutes };
}
