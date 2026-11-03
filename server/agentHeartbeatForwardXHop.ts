import { appendPanelLog } from "./_core/panelLogger";
import { isForwardXWireGuardV2 } from "./forwardXWireGuard";
import { tunnelRelayUsesParallelRelays } from "@shared/tunnelRelay";
import { forwardXExitStrategy } from "./tunnelExitStrategy";
import type { MimicLifecycleResource } from "./configAudit";
import { mimicFilterEndpoint, runtimeBool } from "./agentHeartbeatRuntime";
import type { HeartbeatRow } from "./agentHeartbeatContext";
import { fxpHopKey } from "./agentHeartbeatTunnel";

/*
  FXP（NEX 隧道）中转机这一跳的下发规格：上一跳 / 下一跳的地址和密钥、多出口时的权重 / 容量、mimic 过滤、
  传输参数（applyForwardXTransport）。
  从 server/agentHeartbeatRoute.ts 的心跳处理函数里搬出来：函数体原样不动，原来从闭包里读的值改由
  deps（处理函数里的辅助闭包和 hostInterface）在开头解构出来；这一段不读请求上下文里的别的值。
  exitWeightsForHostIds / exitCapacitiesForHostIds 在处理函数里声明得比这里晚，调用处传的是转调它们的箭头函数，
  所以仍是真正调用时才去读，和原来闭包的时机一样。addMimicFilter 原样传入，它改的 mimicRequestedWithoutInterface
  还是处理函数里那一个。
*/

export type ForwardXHopSpecDeps = {
  addMimicFilter: (filter: string, iface?: string, lifecycleResources?: MimicLifecycleResource[]) => void;
  applyForwardXTransport: (fxpSpec: HeartbeatRow, tunnel: HeartbeatRow) => Promise<HeartbeatRow>;
  exitCapacitiesForHostIds: (strategy: unknown, hostIds: number[]) => Promise<number[] | null>;
  exitWeightsForHostIds: (strategy: unknown, hostIds: number[]) => Promise<number[] | null>;
  forwardXExtraExitRoutes: (tunnel: HeartbeatRow) => Promise<{ hostId: number; host: string; port: number; udpPort: number; key: string; }[]>;
  getHopDialAddress: (hop: HeartbeatRow, tunnel?: HeartbeatRow) => Promise<string>;
  hostInterface: string;
  tunnelDnsGeneration: (tunnel: HeartbeatRow) => number;
  tunnelNeedsMimic: (tunnel: HeartbeatRow) => boolean;
};

export function createForwardXHopSpecBuilder(deps: ForwardXHopSpecDeps) {
  const {
    addMimicFilter,
    applyForwardXTransport,
    exitCapacitiesForHostIds,
    exitWeightsForHostIds,
    forwardXExtraExitRoutes,
    getHopDialAddress,
    hostInterface,
    tunnelDnsGeneration,
    tunnelNeedsMimic,
  } = deps;
  const buildForwardXHopSpec = async (
    tunnel: any,
    hops: any[],
    hopIdx: number,
    op: "apply" | "remove",
  ) => {
    const hop = hops[hopIdx] as any;
    const listenPort = Number(hop?.listenPort) || 0;
    const wireGuardV2 = isForwardXWireGuardV2(tunnel);
    const udpListenPort = !wireGuardV2 && tunnelNeedsMimic(tunnel) ? Number(hop?.mimicPort || 0) : 0;
    const isLast = hopIdx === hops.length - 1;
    const fxpSpec: any = {
      role: isLast ? "exit" : "relay",
      tunnelId: tunnel.id,
      ruleId: 0,
      listenPort,
      protocol: "both",
      key: fxpHopKey(tunnel, hop, hopIdx),
      dnsGeneration: tunnelDnsGeneration(tunnel),
    };
    if (udpListenPort > 0) fxpSpec.udpListenPort = udpListenPort;
    if (!isLast) {
      const nextHop = tunnelRelayUsesParallelRelays(tunnel, hops)
        ? hops[hops.length - 1] as any
        : hops[hopIdx + 1] as any;
      const nextIp = await getHopDialAddress(nextHop, tunnel);
      const nextUdpPort = !wireGuardV2 && tunnelNeedsMimic(tunnel) ? Number(nextHop?.mimicPort || 0) : 0;
      const nextMimicPort = tunnelNeedsMimic(tunnel) ? Number(nextHop?.mimicPort || 0) : 0;
      fxpSpec.relayExitHost = String(nextIp).trim();
      fxpSpec.relayExitPort = Number(nextHop?.listenPort) || 0;
      if (wireGuardV2) fxpSpec.relayPeerId = String(Number(nextHop?.hostId || 0));
      if (nextUdpPort > 0) fxpSpec.udpRelayExitPort = nextUdpPort;
      fxpSpec.relayKey = fxpHopKey(tunnel, nextHop, hopIdx + 1);
      if (nextMimicPort > 0) {
        const endpoint = mimicFilterEndpoint(fxpSpec.relayExitHost, nextMimicPort);
        if (endpoint) addMimicFilter(`remote=${endpoint}`, hostInterface, [{ resourceType: "tunnel", resourceId: tunnel.id }]);
      }
      const nextIsFinalExit = Number(nextHop?.hostId || 0) === Number((hops[hops.length - 1] as any)?.hostId || 0);
      if (nextIsFinalExit && runtimeBool((tunnel as any).loadBalanceEnabled)) {
        const extraRoutes = await forwardXExtraExitRoutes(tunnel);
        if (extraRoutes.length > 0) {
          if (tunnelNeedsMimic(tunnel) && extraRoutes.some((route) => Number(route.udpPort || 0) <= 0)) {
            appendPanelLog("error", `[TunnelRoute] missing NEX mimic UDP port tunnel=${tunnel.id} hop=${hopIdx} extraExit=1`);
            return null;
          }
          for (const route of extraRoutes) {
            if (route.udpPort <= 0) continue;
            const endpoint = mimicFilterEndpoint(route.host, route.udpPort);
            if (endpoint) addMimicFilter(`remote=${endpoint}`, hostInterface, [{ resourceType: "tunnel", resourceId: tunnel.id }]);
          }
          const relayExitHostIds = [Number(nextHop?.hostId || 0), ...extraRoutes.map((route) => Number(route.hostId || 0))];
          const relayExitWeights = await exitWeightsForHostIds((tunnel as any).loadBalanceStrategy, relayExitHostIds);
          const relayExitCapacities = await exitCapacitiesForHostIds((tunnel as any).loadBalanceStrategy, relayExitHostIds);
          fxpSpec.exits = [
            { host: fxpSpec.relayExitHost, port: fxpSpec.relayExitPort, udpPort: fxpSpec.udpRelayExitPort || fxpSpec.relayExitPort, key: fxpSpec.relayKey, peerId: wireGuardV2 ? String(Number(nextHop?.hostId || 0)) : undefined },
            ...extraRoutes.map((route) => ({ host: route.host, port: route.port, udpPort: wireGuardV2 ? route.port : route.udpPort || 0, key: route.key, peerId: wireGuardV2 ? String(route.hostId) : undefined })),
          ].map((exit, index) => ({
            ...exit,
            ...(relayExitWeights ? { weight: relayExitWeights[index] } : {}),
            ...(relayExitCapacities ? { capacityMbps: relayExitCapacities[index] } : {}),
          }));
          fxpSpec.exitStrategy = forwardXExitStrategy((tunnel as any).loadBalanceStrategy);
        }
      }
      if (op === "apply" && (!fxpSpec.relayExitHost || fxpSpec.relayExitPort <= 0 || !fxpSpec.relayKey)) {
        appendPanelLog("error", `[TunnelRoute] invalid NEX relay next hop tunnel=${tunnel.id} hop=${hopIdx} nextHost=${fxpSpec.relayExitHost || "-"} nextPort=${fxpSpec.relayExitPort || "-"}`);
        return null;
      }
      if (op === "apply" && tunnelNeedsMimic(tunnel) && nextMimicPort <= 0) {
        appendPanelLog("error", `[TunnelRoute] missing NEX mimic UDP next port tunnel=${tunnel.id} hop=${hopIdx} nextHost=${fxpSpec.relayExitHost || "-"} nextPort=${fxpSpec.relayExitPort || "-"}`);
        return null;
      }
    }
    if (op === "apply" && listenPort <= 0) {
      appendPanelLog("error", `[TunnelRoute] invalid NEX hop listen port tunnel=${tunnel.id} hop=${hopIdx} listen=${listenPort || "-"}`);
      return null;
    }
    if (op === "apply" && !wireGuardV2 && tunnelNeedsMimic(tunnel) && udpListenPort <= 0) {
      appendPanelLog("error", `[TunnelRoute] missing NEX mimic UDP listen port tunnel=${tunnel.id} hop=${hopIdx} listen=${listenPort || "-"}`);
      return null;
    }
    return applyForwardXTransport(fxpSpec, tunnel);
  };
  return { buildForwardXHopSpec };
}
