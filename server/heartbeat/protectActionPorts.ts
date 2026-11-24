/*
  从 server/agentHeartbeatRoute.ts 第 3048-3128 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import { ruleRuntimeIdentityKey, ruleRuntimePortIdentityKey, runtimePortProtocolKey } from "../agentHeartbeatDispatch";
import { getOrphanPortStreaks } from "../agentHeartbeatLocalState";
import { type AgentLocalRuntimeTunnelState } from "../agentHeartbeatReport";
import { runtimeBool } from "../agentHeartbeatRuntime";
import { AGENT_ORPHAN_REMOVE_MIN_STREAK, agentOrphanPortStreakCache } from "../agentHeartbeatState";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";

export type ProtectActionPortsFromLocalStateContext = {
  hasReportedRuntimeState: boolean;
  actions: Array<any>;
  agentAllRules: Array<unknown>;
  host: any;
  reportedLocalRules: any;
  expectedRuleIdentityKeys: Set<string>;
  expectedRulePortIdentityKeys: Set<string>;
  expectedRulePorts: Set<string>;
  buildGenericLocalRuleRemovalAction: any /* 类型太长或引用了别的模块，手动收拾 */;
  localTunnelsByPort: Map<number, AgentLocalRuntimeTunnelState>;
  expectedTunnelPorts: Set<number>;
  buildGenericLocalTunnelRemovalAction: (local: AgentLocalRuntimeTunnelState) => { tunnelId: number; statusType: string; ruleId: number; op: string; forwardType: string; sourcePort: number; targetIp: string; targetPort: number; protocol: string; commands: Array<string>; };
};

export function protectActionPortsFromLocalState(ctx: ProtectActionPortsFromLocalStateContext) {
  const { hasReportedRuntimeState, actions, agentAllRules, host, reportedLocalRules, expectedRuleIdentityKeys, expectedRulePortIdentityKeys, expectedRulePorts, buildGenericLocalRuleRemovalAction, localTunnelsByPort, expectedTunnelPorts, buildGenericLocalTunnelRemovalAction } = ctx;
  if (hasReportedRuntimeState) {
    const ruleActionPorts = new Set<string>();
    const ruleActionPortIdentityKeys = new Set<string>();
    const applyPortsByRuleId = new Map<number, Set<number>>();
    const tunnelActionPorts = new Set<number>();
    for (const action of actions) {
      const port = Number(action?.sourcePort || 0);
      if (port <= 0) continue;
      const statusType = String(action?.statusType || "");
      const ruleId = Number(action?.ruleId || 0);
      const tunnelId = Number(action?.tunnelId || 0);
      if (ruleId > 0 || statusType === "rule") {
        ruleActionPorts.add(runtimePortProtocolKey(port, action?.protocol));
        ruleActionPortIdentityKeys.add(ruleRuntimePortIdentityKey(ruleId, port));
        if (action?.op === "apply" && ruleId > 0) {
          const applyPorts = applyPortsByRuleId.get(ruleId) || new Set<number>();
          applyPorts.add(port);
          applyPortsByRuleId.set(ruleId, applyPorts);
        }
      } else if (tunnelId > 0 || statusType === "tunnel") {
        tunnelActionPorts.add(port);
      }
    }
    // 稳定身份护栏：一个上报端口的 ruleId 若属于面板已知、启用、未删除的规则
    // （无论本机自有还是跨主机隧道 entry/exit/hop 规则），说明该端口很可能是合法的，
    // 只是本轮运行态推导（如出口端口计算）出现了瞬时缺口。对这类端口施加迟滞：
    // 必须连续多轮心跳都判为孤儿才真正拆除，杜绝与 apply 形成抖动死循环。
    const knownEnabledRuleIds = new Set<number>();
    for (const rule of agentAllRules as any[]) {
      if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled)) continue;
      const ruleId = Number(rule.id || 0);
      if (ruleId > 0) knownEnabledRuleIds.add(ruleId);
    }
    const orphanStreaks = getOrphanPortStreaks(Number(host.id));
    const seenOrphanKeys = new Set<string>();
    for (const localRule of reportedLocalRules) {
      const port = Number(localRule.port || 0);
      if (port <= 0) continue;
      const localRuntimeKey = runtimePortProtocolKey(port, localRule.protocol || "both");
      const reportedRuleId = Number(localRule.ruleId || 0);
      const localIdentityKey = ruleRuntimeIdentityKey(reportedRuleId, port, localRule.protocol || "both");
      const localPortIdentityKey = ruleRuntimePortIdentityKey(reportedRuleId, port);
      const expectedIdentity = !!localIdentityKey && expectedRuleIdentityKeys.has(localIdentityKey);
      const expectedPortIdentity = !!localPortIdentityKey && expectedRulePortIdentityKeys.has(localPortIdentityKey);
      if (expectedIdentity || expectedPortIdentity || (!reportedRuleId && expectedRulePorts.has(localRuntimeKey)) || ruleActionPorts.has(localRuntimeKey) || (!!localPortIdentityKey && ruleActionPortIdentityKeys.has(localPortIdentityKey))) continue;
      // A replacement apply for this same rule proves that an old listener was
      // superseded by an edit. Remove it in this batch; without that concrete
      // replacement, retain orphan hysteresis for transient runtime gaps.
      const replacementPorts = applyPortsByRuleId.get(reportedRuleId);
      const supersededByRuleEdit = !!replacementPorts
        && (replacementPorts.size > 1 || !replacementPorts.has(port));
      const guarded = !supersededByRuleEdit
        && reportedRuleId > 0
        && knownEnabledRuleIds.has(reportedRuleId);
      const orphanKey = localIdentityKey || `unknown:${localRuntimeKey}`;
      if (guarded) {
        seenOrphanKeys.add(orphanKey);
        const streak = (orphanStreaks.get(orphanKey) || 0) + 1;
        orphanStreaks.set(orphanKey, streak);
        if (streak < AGENT_ORPHAN_REMOVE_MIN_STREAK) {
          appendPanelLog("info", `[AgentReconcile] host=${host.id} port=${port} protocol=${normalizeForwardRuleProtocol(localRule.protocol, "both")} rule=${reportedRuleId} suspected-orphan streak=${streak}/${AGENT_ORPHAN_REMOVE_MIN_STREAK}; defer removal (identity known, likely transient runtime gap)`);
          continue;
        }
        appendPanelLog("warn", `[AgentReconcile] host=${host.id} port=${port} protocol=${normalizeForwardRuleProtocol(localRule.protocol, "both")} rule=${reportedRuleId} orphan confirmed after ${streak} heartbeats; removing`);
      }
      actions.push(buildGenericLocalRuleRemovalAction(localRule));
      ruleActionPorts.add(localRuntimeKey);
      orphanStreaks.delete(orphanKey);
    }
    // 端口一旦重新匹配上规则（不再进入上面的孤儿分支），清零其迟滞计数。
    for (const orphanKey of Array.from(orphanStreaks.keys())) {
      if (!seenOrphanKeys.has(orphanKey)) orphanStreaks.delete(orphanKey);
    }
    if (orphanStreaks.size === 0) agentOrphanPortStreakCache.delete(Number(host.id));
    for (const localTunnel of localTunnelsByPort.values()) {
      const port = Number(localTunnel.port || 0);
      if (port <= 0 || expectedTunnelPorts.has(port) || tunnelActionPorts.has(port)) continue;
      actions.push(buildGenericLocalTunnelRemovalAction(localTunnel));
      tunnelActionPorts.add(port);
    }
  }
}
