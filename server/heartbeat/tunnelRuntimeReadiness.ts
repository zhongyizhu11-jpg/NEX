/*
  从 server/agentHeartbeatRoute.ts 第 3269-3480 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { runtimeBool } from "../agentHeartbeatRuntime";
import { tunnelSecretSeed } from "../agentRouteUtils";
import { isTunnelProtocolEnabled } from "../forwardProtocolSettings";
import { isForwardXWireGuardV2 } from "../forwardXWireGuard";
import { tunnelExitRuntimeForwardType, tunnelHopRuntimeForwardType, tunnelRuntimeFamily } from "../tunnelRuntimePlan";
import { isTunnelRuntimeHostReady } from "../tunnelRuntimeStatus";

export type ReconcileTunnelRuntimeReadinessContext = {
  hostTunnels: any;
  host: any;
  tunnelExitNodesByTunnelId: Map<number, Array<any>>;
  tunnelHopsByTunnelId: Map<number, Array<any>>;
  tunnelNeedsMimic: (tunnel: any) => boolean;
  forwardProtocolSettings: any /* 原类型 ForwardProtocolSettings… 引用了拿不到的 ForwardProtocolSettings，手动收拾 */;
  forwardXUDPTargets: (tunnel: any) => Array<{ ruleId: number; targetIp: string; targetPort: number; }>;
  forwardXStreamTargets: any /* 原类型 (tunnel: any) => Array<StreamTarget>… 引用了拿不到的 StreamTarget，手动收拾 */;
  forwardXUDPTargetsChanged: any /* 原类型 (tunnel: any, targets: unknown) => boolean… 引用了拿不到的 targets，手动收拾 */;
  pendingTunnelExitRuleIds: Set<number>;
  addMimicLocalFilterForPort: any /* 原类型 (port: unknown, lifecycleResources: MimicLifecycleResource[]) => void… 引用了拿不到的 port，手动收拾 */;
  expectedTunnelPorts: Set<number>;
  localTunnelMatches: any /* 原类型 (tunnelId: number, expectedForwardType: string, port: number, options?: { allowP… 引用了拿不到的 port，手动收拾 */;
  tunnelDnsGeneration: (tunnel: any) => number;
  applyForwardXTransport: any /* 原类型 (fxpSpec: any, tunnel: any) => Promise<any>… 引用了拿不到的 fxpSpec，手动收拾 */;
  actions: Array<any>;
  buildForwardXHopSpec: any /* 原类型 (tunnel: any, hops: any[], hopIdx: number, op: "apply" | "remove") => Promise<an… 引用了拿不到的 hops，手动收拾 */;
};

export async function reconcileTunnelRuntimeReadiness(ctx: ReconcileTunnelRuntimeReadinessContext) {
  const { hostTunnels, host, tunnelExitNodesByTunnelId, tunnelHopsByTunnelId, tunnelNeedsMimic, forwardProtocolSettings, forwardXUDPTargets, forwardXStreamTargets, forwardXUDPTargetsChanged, pendingTunnelExitRuleIds, addMimicLocalFilterForPort, expectedTunnelPorts, localTunnelMatches, tunnelDnsGeneration, applyForwardXTransport, actions, buildForwardXHopSpec } = ctx;
  for (const tunnel of hostTunnels as any[]) {
    const isCurrentHostPrimaryExit = Number(tunnel.exitHostId) === Number(host.id);
    const currentHostExtraExitNode = (tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [])
      .find((node: any) => runtimeBool(node?.isEnabled, true) && Number(node.hostId) === Number(host.id));
    const isCurrentHostExtraExit = !!currentHostExtraExitNode;
    const isCurrentHostActiveExit = isCurrentHostPrimaryExit
      || isCurrentHostExtraExit;
    const existingHops = tunnelHopsByTunnelId.get(Number(tunnel.id));
    const runtimeFamily = tunnelRuntimeFamily(tunnel);
    if (!runtimeFamily) continue;
    const fxpTunnel = runtimeFamily === "forwardx";
    const wireGuardV2 = fxpTunnel && isForwardXWireGuardV2(tunnel);
    const isCurrentHostSharedRuntimeExtraExit = !fxpTunnel && isCurrentHostExtraExit;
    if (!isCurrentHostPrimaryExit && !(fxpTunnel && isCurrentHostExtraExit) && !isCurrentHostSharedRuntimeExtraExit) continue;
    if (runtimeFamily !== "nginx" && Array.isArray(existingHops) && existingHops.length >= (fxpTunnel ? 2 : 3) && !isCurrentHostExtraExit) continue;
    const fxpListenPort = isCurrentHostPrimaryExit
      ? Number(tunnel.listenPort)
      : Number((currentHostExtraExitNode as any)?.listenPort || 0);
    const fxpUdpListenPort = !wireGuardV2 && tunnelNeedsMimic(tunnel)
      ? (isCurrentHostPrimaryExit
        ? Number((tunnel as any).mimicPort || 0)
        : Number((currentHostExtraExitNode as any)?.mimicPort || 0))
      : 0;
    const runtimeReady = (fxpTunnel || isCurrentHostSharedRuntimeExtraExit)
      ? isTunnelRuntimeHostReady(Number(tunnel.id), Number(host.id))
      : false;
    const tunnelProtocolEnabled = isTunnelProtocolEnabled(forwardProtocolSettings, tunnel);
    const endpointEnabled = runtimeBool(tunnel.isEnabled) && tunnelProtocolEnabled && isCurrentHostActiveExit;
    const udpTargets = fxpTunnel ? forwardXUDPTargets(tunnel) : [];
    const streamTargets = fxpTunnel ? forwardXStreamTargets(tunnel) : [];
    const shouldSyncUDPTargets = fxpTunnel
      && runtimeBool(tunnel.isEnabled)
      && tunnelProtocolEnabled
      && forwardXUDPTargetsChanged(tunnel, { udpTargets, streamTargets });
    const shouldRefreshExit = fxpTunnel
      ? (!runtimeReady || shouldSyncUDPTargets)
      : (!runtimeBool(tunnel.isRunning) || pendingTunnelExitRuleIds.has(Number(tunnel.id)) || (isCurrentHostSharedRuntimeExtraExit && !runtimeReady));
    if (fxpTunnel && endpointEnabled && tunnelNeedsMimic(tunnel)) {
      addMimicLocalFilterForPort(isCurrentHostPrimaryExit
        ? Number((tunnel as any).mimicPort || 0)
        : Number((currentHostExtraExitNode as any)?.mimicPort || 0), [{
        resourceType: "tunnel",
        resourceId: Number(tunnel.id),
      }]);
    }
    const tunnelSourcePort = fxpTunnel ? fxpListenPort : (isCurrentHostPrimaryExit ? Number(tunnel.listenPort) : Number((currentHostExtraExitNode as any)?.listenPort || 0));
    const tunnelForwardType = tunnelExitRuntimeForwardType(tunnel);
    if (!tunnelForwardType) continue;
    if (endpointEnabled && tunnelSourcePort > 0) {
      expectedTunnelPorts.add(tunnelSourcePort);
    }
    const shouldRepairLocalExit = endpointEnabled
      && tunnelSourcePort > 0
      && !localTunnelMatches(Number(tunnel.id), tunnelForwardType, tunnelSourcePort);
    const baseExitFXPSpec = fxpTunnel && fxpListenPort > 0 ? {
      role: "exit",
      tunnelId: tunnel.id,
      ruleId: 0,
      listenPort: fxpListenPort,
      ...(fxpUdpListenPort > 0 ? { udpListenPort: fxpUdpListenPort } : {}),
      protocol: "both",
      key: tunnelSecretSeed(tunnel),
      udpTargets,
      streamTargets,
      dnsGeneration: tunnelDnsGeneration(tunnel),
    } : null;
    const exitFXPSpec = baseExitFXPSpec ? await applyForwardXTransport(baseExitFXPSpec, tunnel) : undefined;
    if (endpointEnabled && (shouldRefreshExit || shouldRepairLocalExit)) {
      if (fxpTunnel && !exitFXPSpec) continue;
      actions.push({
        tunnelId: tunnel.id,
        statusType: "tunnel",
        ruleId: 0,
        op: "apply",
        forwardType: tunnelForwardType,
        sourcePort: tunnelSourcePort,
        targetIp: host.ip,
        targetPort: tunnelSourcePort,
        protocol: "tcp",
        commands: [],
        fxp: exitFXPSpec,
      });
    } else if (!endpointEnabled && (fxpTunnel ? runtimeReady : (runtimeBool(tunnel.isRunning) || runtimeReady))) {
      actions.push({
        tunnelId: tunnel.id,
        statusType: "tunnel",
        ruleId: 0,
        op: "remove",
        forwardType: tunnelForwardType,
        sourcePort: tunnelSourcePort,
        targetIp: host.ip,
        targetPort: tunnelSourcePort,
        protocol: "tcp",
        commands: [],
        fxp: exitFXPSpec || baseExitFXPSpec || undefined,
      });
    }
  }

  // Find multi-hop tunnels involving this host
  if (hostTunnels && hostTunnels.length > 0) {
    for (const tunnel of hostTunnels as any[]) {
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id)) || [];
      if (!hops || hops.length < 2) continue; // Not a multi-hop tunnel

      const hostIdx = hops.findIndex((h: any) => Number(h.hostId) === host.id);
      if (hostIdx < 0) continue; // This host is not a hop in this tunnel

      const tunnelForwardType = tunnelHopRuntimeForwardType(tunnel);
      if (!tunnelForwardType) continue;
      const isFXP = tunnelRuntimeFamily(tunnel) === "forwardx";
      const multiHopRuntimeReady = isTunnelRuntimeHostReady(Number(tunnel.id), Number(host.id));
      const listenPortValue = Number((hops[hostIdx] as any)?.listenPort || 0);
      const isLastHop = hostIdx === hops.length - 1;
      const isFirst = hostIdx === 0;
      const udpTargets = isFXP && isLastHop ? forwardXUDPTargets(tunnel) : [];
      const streamTargets = isFXP && isLastHop ? forwardXStreamTargets(tunnel) : [];
      const shouldSyncUDPTargets = isFXP
        && isLastHop
        && runtimeBool(tunnel.isEnabled)
        && forwardXUDPTargetsChanged(tunnel, { udpTargets, streamTargets });
      if (runtimeBool(tunnel.isEnabled) && listenPortValue > 0) {
        expectedTunnelPorts.add(listenPortValue);
      }
      const shouldRepairLocalHop = runtimeBool(tunnel.isEnabled)
        && listenPortValue > 0
        && !localTunnelMatches(Number(tunnel.id), tunnelForwardType, listenPortValue, {
          allowPassiveForwardXFirstHop: isFXP && isFirst,
        });
      const shouldApply = runtimeBool(tunnel.isEnabled) && (!multiHopRuntimeReady || shouldRepairLocalHop || shouldSyncUDPTargets);
      const shouldRemove = isFXP ? !runtimeBool(tunnel.isEnabled) : !runtimeBool(tunnel.isEnabled) && (runtimeBool(tunnel.isRunning) || multiHopRuntimeReady);

      if (!shouldApply && !shouldRemove) continue;

      const op = shouldApply ? "apply" : "remove";
      const { listenPort } = hops[hostIdx] as any;

      if (isFXP) {
        if (!isFirst && tunnelNeedsMimic(tunnel)) {
          addMimicLocalFilterForPort(Number((hops[hostIdx] as any)?.mimicPort || 0), [{
            resourceType: "tunnel",
            resourceId: Number(tunnel.id),
          }]);
        }
        // NEX multi-hop
        if (isFirst) {
          actions.push({
            tunnelId: tunnel.id,
            statusType: "tunnel",
            ruleId: 0,
            op,
            forwardType: "forwardx-tunnel",
            sourcePort: Number(listenPort),
            targetIp: host.ip,
            targetPort: Number(listenPort),
            protocol: "tcp",
            commands: [],
          } as any);
          continue;
        }
        const fxpSpec = await buildForwardXHopSpec(tunnel, hops, hostIdx, op);
        if (!fxpSpec) continue;
        if (isLastHop) {
          fxpSpec.udpTargets = udpTargets;
          fxpSpec.streamTargets = streamTargets;
        }

        actions.push({
          tunnelId: tunnel.id,
          statusType: "tunnel",
          ruleId: 0,
          op,
          forwardType: "forwardx-tunnel",
          sourcePort: Number(listenPort),
          targetIp: host.ip,
          targetPort: Number(listenPort),
          protocol: "tcp",
          commands: [],
          fxp: fxpSpec,
        } as any);
      } else {
        // GOST multi-hop config is refreshed by the shared runtime sync action.
        if (shouldApply) {
          actions.push({
            tunnelId: tunnel.id,
            statusType: "tunnel",
            ruleId: 0,
            op: "apply",
            forwardType: "gost-tunnel",
            sourcePort: Number(listenPort),
            targetIp: host.ip,
            targetPort: Number(listenPort),
            protocol: "tcp",
            commands: [],
          } as any);
        } else {
          actions.push({
            tunnelId: tunnel.id,
            statusType: "tunnel",
            ruleId: 0,
            op: "remove",
            forwardType: "gost-tunnel",
            sourcePort: Number(listenPort),
            targetIp: host.ip,
            targetPort: Number(listenPort),
            protocol: "tcp",
            commands: [],
          } as any);
        }
      }
    }
  }
}
