/*
  从 server/agentHeartbeatRoute.ts 第 616-668 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { ruleEgressStateBlocksDelivery } from "../../shared/ssEgress";
import { pushAgentRefresh } from "../agentEvents";
import type { TunnelEgressHelper } from "../agentHeartbeatContext";
import { runtimeBool } from "../agentHeartbeatRuntime";
import { holdTunnelEgressRule, pointTunnelEgressRule } from "../agentHeartbeatTunnel";
import { evaluateRuleEgress, tunnelEgressDialHostIdsOf } from "../ssEgress";
import { claimTunnelExitReportRequest, hasTunnelExitPort, tunnelExitPortFor } from "../tunnelExitPorts";

export type ValidateTunnelEgressRulesContext = {
  tunnelEgressRuleObjects: Map<number, Array<any>>;
  tunnelById: Map<any, any>;
  tunnelHopsByTunnelId: Map<number, Array<any>>;
  tunnelExitNodesByTunnelId: Map<number, Array<any>>;
  host: any;
  effectiveAgentVersion: string;
  egressRuntimeContext: any;
  tunnelEgressHelpers: Map<number, TunnelEgressHelper>;
};

export function validateTunnelEgressRules(ctx: ValidateTunnelEgressRulesContext) {
  const { tunnelEgressRuleObjects, tunnelById, tunnelHopsByTunnelId, tunnelExitNodesByTunnelId, host, effectiveAgentVersion, egressRuntimeContext, tunnelEgressHelpers } = ctx;
  for (const [ruleId, objects] of tunnelEgressRuleObjects) {
    const rule = objects[0];
    if (objects.every((item) => runtimeBool(item.pendingDelete) || !runtimeBool(item.isEnabled))) continue;
    const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
    if (!tunnel) {
      holdTunnelEgressRule(objects, "shape_invalid");
      continue;
    }
    const dialHostIds = tunnelEgressDialHostIdsOf(
      tunnel,
      tunnelHopsByTunnelId.get(Number(tunnel.id)) || [],
      tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [],
    );
    const selfDial = dialHostIds.includes(Number(host.id));
    if (selfDial) {
      const evaluation = evaluateRuleEgress(rule, {
        entryHostId: Number(host.id),
        entryAgentVersion: effectiveAgentVersion,
        entryHostName: String((host as any).name || ""),
        entryAgentCapabilities: (host as any).agentCapabilities,
        entryRuntimeVersion: (host as any).runtimeVersion,
        tunnelMode: tunnel.mode,
        context: egressRuntimeContext,
      });
      if (!evaluation || !evaluation.runtime || ruleEgressStateBlocksDelivery(evaluation.state)) {
        holdTunnelEgressRule(objects, evaluation?.state || "config_invalid");
        continue;
      }
      tunnelEgressHelpers.set(ruleId, {
        ruleId,
        tunnel,
        runtime: evaluation.runtime,
        targetHost: String(rule._originalTargetIp || rule.targetIp || ""),
        targetPort: Number(rule.targetPort || 0),
        protocol: String(rule.protocol || "both"),
        port: 0,
      });
      // 本机跑着这条规则的 SS 客户端：目标等分完端口再换（分守卫端口之后那一段），不用等别的出口。
      continue;
    }
    const pending = dialHostIds.filter((exitHostId) => !hasTunnelExitPort(exitHostId, "egress", ruleId));
    for (const exitHostId of pending) {
      if (claimTunnelExitReportRequest(exitHostId)) pushAgentRefresh(exitHostId, "tunnel-exit-ports-needed");
    }
    const port = dialHostIds.length > 0 && pending.length === 0
      ? tunnelExitPortFor("egress", ruleId, dialHostIds, 0, { whenRuleMissing: "none" })
      : null;
    if (!port) {
      holdTunnelEgressRule(objects, "pending");
      continue;
    }
    pointTunnelEgressRule(objects, port);
  }
}
