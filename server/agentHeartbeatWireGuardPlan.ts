import { tunnelSecretSeed } from "./agentRouteUtils";
import { appendPanelLog } from "./_core/panelLogger";
import { setBoundedMapValue } from "./boundedCache";
import {
  buildForwardXWireGuardPlans,
  forwardXWireGuardMTU,
  type ForwardXWireGuardNodePlan,
  isForwardXWireGuardV2,
} from "./forwardXWireGuard";
import { tunnelRelayCandidates, tunnelRelayUsesParallelRelays } from "@shared/tunnelRelay";
import { normalizeExitGroupStrategy } from "@shared/exitStrategy";
import { AGENT_DYNAMIC_CACHE_MAX, tunnelRouteLogCache } from "./agentHeartbeatState";
import { runtimeBool } from "./agentHeartbeatRuntime";
import type { HeartbeatRequestContext, HeartbeatRow } from "./agentHeartbeatContext";

/*
  V2（WireGuard 数据面）隧道的每台机器的 WireGuard 配置：入口 / 中转 / 出口各自的地址、对端、端点，
  按隧道算一次、本次请求内复用（wireGuardPlanPromises）；以及本机在这条隧道里那一份。
  从 server/agentHeartbeatRoute.ts 的心跳处理函数里搬出来：语句原样不动，原来从闭包里读的值改由
  ctx（本次请求只读的值，见 agentHeartbeatContext.ts）和 deps（处理函数里的辅助闭包）在开头解构出来。
  每次心跳请求在原来的位置建一次，缓存仍是这一次请求自己的。
*/

export type ForwardXWireGuardPlanDeps = {
  getExtraExitDialAddress: (exitNode: HeartbeatRow, tunnel?: HeartbeatRow) => Promise<string>;
  getHopDialAddress: (hop: HeartbeatRow, tunnel?: HeartbeatRow) => Promise<string>;
  tunnelDnsGeneration: (tunnel: HeartbeatRow) => number;
  tunnelEntryHostIds: (tunnel: HeartbeatRow) => number[];
  tunnelExitHostAddress: (tunnel: HeartbeatRow) => Promise<string>;
  tunnelNeedsMimic: (tunnel: HeartbeatRow) => boolean;
};

export function createForwardXWireGuardPlanner(ctx: HeartbeatRequestContext, deps: ForwardXWireGuardPlanDeps) {
  const { host, tunnelExitNodesByTunnelId, tunnelHopsByTunnelId } = ctx;
  const {
    getExtraExitDialAddress,
    getHopDialAddress,
    tunnelDnsGeneration,
    tunnelEntryHostIds,
    tunnelExitHostAddress,
    tunnelNeedsMimic,
  } = deps;
  const wireGuardPlanPromises = new Map<number, Promise<Map<number, ForwardXWireGuardNodePlan>>>();
  const getForwardXWireGuardPlans = (tunnel: any) => {
    const tunnelId = Number(tunnel?.id || 0);
    const existing = wireGuardPlanPromises.get(tunnelId);
    if (existing) return existing;
    const work = (async () => {
      if (!isForwardXWireGuardV2(tunnel)) return new Map<number, ForwardXWireGuardNodePlan>();
      const nodes = new Map<number, { hostId: number; listenPort: number }>();
      const links = new Map<string, { fromHostId: number; toHostId: number; endpointHost: string; endpointPort: number }>();
      const addNode = (hostIdValue: unknown, listenPortValue: unknown = 0) => {
        const hostId = Number(hostIdValue || 0);
        const listenPort = Number(listenPortValue || 0);
        if (!Number.isInteger(hostId) || hostId <= 0) return;
        const current = nodes.get(hostId);
        nodes.set(hostId, {
          hostId,
          listenPort: listenPort > 0 ? listenPort : Number(current?.listenPort || 0),
        });
      };
      const addLink = (fromHostIdValue: unknown, toHostIdValue: unknown, endpointHostValue: unknown, endpointPortValue: unknown) => {
        const fromHostId = Number(fromHostIdValue || 0);
        const toHostId = Number(toHostIdValue || 0);
        const endpointHost = String(endpointHostValue || "").trim();
        const endpointPort = Number(endpointPortValue || 0);
        if (fromHostId <= 0 || toHostId <= 0 || fromHostId === toHostId || !endpointHost || endpointPort <= 0) return;
        addNode(fromHostId);
        addNode(toHostId, endpointPort);
        links.set(`${fromHostId}:${toHostId}`, { fromHostId, toHostId, endpointHost, endpointPort });
      };
      const entryHostIds = tunnelEntryHostIds(tunnel);
      entryHostIds.forEach((hostId) => addNode(hostId));
      const hops = tunnelHopsByTunnelId.get(tunnelId) || [];
      const extraExitNodes = normalizeExitGroupStrategy((tunnel as any).loadBalanceStrategy) === "none"
        ? []
        : (tunnelExitNodesByTunnelId.get(tunnelId) || [])
          .filter((node: any) => runtimeBool(node?.isEnabled, true) && Number(node?.hostId || 0) > 0);
      if (Array.isArray(hops) && hops.length >= 2) {
        hops.forEach((hop: any, index: number) => addNode(hop?.hostId, index > 0 ? hop?.mimicPort : 0));
        const relayFailover = tunnelRelayUsesParallelRelays(tunnel, hops);
        const finalExit = hops[hops.length - 1] as any;
        const relayHops = relayFailover ? tunnelRelayCandidates(hops) : [hops[1]];
        for (const relayHop of relayHops as any[]) {
          const relayEndpointHost = await getHopDialAddress(relayHop, tunnel);
          for (const entryHostId of entryHostIds) {
            addLink(entryHostId, relayHop?.hostId, relayEndpointHost, relayHop?.mimicPort);
          }
        }
        if (relayFailover) {
          const finalEndpointHost = await getHopDialAddress(finalExit, tunnel);
          for (const relayHop of relayHops as any[]) {
            addLink(relayHop?.hostId, finalExit?.hostId, finalEndpointHost, finalExit?.mimicPort);
          }
        } else {
          for (let index = 1; index < hops.length - 1; index += 1) {
            const current = hops[index] as any;
            const next = hops[index + 1] as any;
            addLink(current?.hostId, next?.hostId, await getHopDialAddress(next, tunnel), next?.mimicPort);
          }
        }
        if (runtimeBool((tunnel as any).loadBalanceEnabled) && extraExitNodes.length > 0) {
          const branchSources = relayFailover
            ? relayHops.map((hop: any) => Number(hop?.hostId || 0))
            : hops.length >= 3
            ? [Number((hops[hops.length - 2] as any)?.hostId || 0)]
            : entryHostIds;
          for (const exitNode of extraExitNodes) {
            const endpointHost = await getExtraExitDialAddress(exitNode, tunnel);
            addNode(exitNode?.hostId, exitNode?.mimicPort);
            for (const sourceHostId of branchSources) {
              addLink(sourceHostId, exitNode?.hostId, endpointHost, exitNode?.mimicPort);
            }
          }
        }
      } else {
        const primaryEndpointHost = await tunnelExitHostAddress(tunnel);
        addNode(tunnel?.exitHostId, tunnel?.mimicPort);
        for (const entryHostId of entryHostIds) {
          addLink(entryHostId, tunnel?.exitHostId, primaryEndpointHost, tunnel?.mimicPort);
        }
        if (runtimeBool((tunnel as any).loadBalanceEnabled)) {
          for (const exitNode of extraExitNodes) {
            const endpointHost = await getExtraExitDialAddress(exitNode, tunnel);
            addNode(exitNode?.hostId, exitNode?.mimicPort);
            for (const entryHostId of entryHostIds) {
              addLink(entryHostId, exitNode?.hostId, endpointHost, exitNode?.mimicPort);
            }
          }
        }
      }
      return buildForwardXWireGuardPlans({
        tunnelId,
        seed: tunnelSecretSeed(tunnel),
        generation: tunnelDnsGeneration(tunnel),
        mtu: forwardXWireGuardMTU(tunnelNeedsMimic(tunnel)),
        nodes: Array.from(nodes.values()),
        links: Array.from(links.values()),
      });
    })();
    wireGuardPlanPromises.set(tunnelId, work);
    return work;
  };
  const getCurrentHostForwardXWireGuardPlan = async (tunnel: any) => {
    if (!isForwardXWireGuardV2(tunnel)) return null;
    try {
      return (await getForwardXWireGuardPlans(tunnel)).get(Number(host.id)) || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logKey = `wireguard-plan:${Number(host.id)}:${Number(tunnel?.id || 0)}`;
      if (tunnelRouteLogCache.get(logKey) !== message) {
        setBoundedMapValue(tunnelRouteLogCache, logKey, message, AGENT_DYNAMIC_CACHE_MAX);
        appendPanelLog("error", `[Tunnel] V2 plan failed tunnel=${tunnel?.id || 0} host=${host.id}: ${message}`);
      }
      return null;
    }
  };
  return { getCurrentHostForwardXWireGuardPlan, getForwardXWireGuardPlans };
}
