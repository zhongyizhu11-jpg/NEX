/*
  从 server/agentHeartbeatRoute.ts 第 4150-4189 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { pushAgentRefresh } from "../agentEvents";
import type { TunnelEgressHelper } from "../agentHeartbeatContext";
import { isGostTunnelMode } from "../agentHeartbeatRuntime";
import * as db from "../db";
import { planAgentSniInbounds } from "../tlsInboundRuntime";
import { recordTunnelExitPorts, type TunnelExitPortEntry } from "../tunnelExitPorts";

export type PlanTunnelExitPortsAndSniContext = {
  runningRules: Array<{ ruleId: number; tunnelId?: number; sourcePort: number; sourcePortEnd?: number; targetIp: string; targetPort: number; protocol: string; forwardType: string; failover?: any; forwardGroupHealth?: any; schedulerOnly?: boolean; }>;
  tunnelById: Map<any, any>;
  isForwardXTunnel: any /* 原类型 (tunnel: any) => boolean… 引用了拿不到的 tunnel，手动收拾 */;
  tunnelEntryHostIds: any /* 原类型 (tunnel: any) => Array<number>… 引用了拿不到的 tunnel，手动收拾 */;
  guardRules: Array<any>;
  tunnelEgressHelpers: Map<number, TunnelEgressHelper>;
  host: any;
  effectiveAgentVersion: string;
  hostTlsInbounds: Array<db.TlsInboundRow>;
  rules: Array<any>;
  gostBalancePlans: any /* 原类型 Map<number, GostBalanceRulePlan<{ name: string; addr: string; connector: Record<… 引用了拿不到的 GostComponent，手动收拾 */;
};

export type PlanTunnelExitPortsAndSniResult = {
  sniInbounds: any /* 原类型 Array<AgentSniInbound>… 引用了拿不到的 AgentSniInbound，手动收拾 */;
};

export function planTunnelExitPortsAndSni(ctx: PlanTunnelExitPortsAndSniContext): PlanTunnelExitPortsAndSniResult {
  const { runningRules, tunnelById, isForwardXTunnel, tunnelEntryHostIds, guardRules, tunnelEgressHelpers, host, effectiveAgentVersion, hostTlsInbounds, rules, gostBalancePlans } = ctx;
  const tunnelExitPortEntries: TunnelExitPortEntry[] = [];
  for (const runningRule of runningRules) {
    const tunnel = tunnelById.get(Number(runningRule.tunnelId || 0)) as any;
    if (!tunnel || !runningRule.failover?.enabled || (!isGostTunnelMode(tunnel) && !isForwardXTunnel(tunnel))) continue;
    tunnelExitPortEntries.push({
      ruleId: Number(runningRule.ruleId),
      kind: "scheduler",
      port: Number(runningRule.failover.listenPort),
      entryHostIds: tunnelEntryHostIds(tunnel),
    });
  }
  for (const guardRule of guardRules) {
    const tunnel = tunnelById.get(Number(guardRule?.tunnelId || 0)) as any;
    if (!tunnel || !isGostTunnelMode(tunnel)) continue;
    tunnelExitPortEntries.push({
      ruleId: Number(guardRule.ruleId),
      kind: "guard",
      port: Number(guardRule.listenPort),
      entryHostIds: tunnelEntryHostIds(tunnel),
    });
  }
  for (const helper of tunnelEgressHelpers.values()) {
    if (!helper.port) continue;
    tunnelExitPortEntries.push({
      ruleId: helper.ruleId,
      kind: "egress",
      port: helper.port,
      entryHostIds: tunnelEntryHostIds(helper.tunnel),
    });
  }
  for (const entryHostId of recordTunnelExitPorts(Number(host.id), tunnelExitPortEntries)) {
    pushAgentRefresh(entryHostId, "tunnel-exit-ports-changed");
  }
  const sniInbounds = planAgentSniInbounds({
    hostId: Number(host.id),
    agentVersion: effectiveAgentVersion,
    inbounds: hostTlsInbounds,
    rules,
    visitorHeaderRuleIds: new Set(gostBalancePlans.keys()),
  });
  return { sniInbounds };
}
