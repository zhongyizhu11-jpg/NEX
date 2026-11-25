/*
  从 server/agentHeartbeatRoute.ts 第 1096-1198 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import { addDnsWatch, buildDnsChangeCleanup, buildForwardTargetCleanup, expireSharedResolvedIp, failoverProxyHandlesTargetDns, resolveTargetIpCached, type AgentDnsWatch } from "../agentHeartbeatDns";
import { runtimeBool } from "../agentHeartbeatRuntime";
import { AGENT_DYNAMIC_CACHE_MAX, resolvedIpCache } from "../agentHeartbeatState";
import { mapWithConcurrency } from "../asyncPool";
import { setBoundedMapValue } from "../boundedCache";
import * as db from "../db";
import { resolveForwardChainTargets } from "./forwardChainTargets";

export type ResolveHostRuleTargetsContext = {
  agentHostRules: Array<any>;
  dnsWatches: Map<string, AgentDnsWatch>;
  dnsChangedIpByHost: Map<string, string>;
  dnsChangedFor: any /* 原类型 (scope: string, refId: unknown) => boolean… 引用了拿不到的 scope，手动收拾 */;
  dnsChangedRuleIds: Set<number>;
  dnsPreviousIpByRuleId: Map<number, string>;
  resolvedTargetGate: any /* 原类型 (rule: any, rawTarget: unknown, resolved: unknown) => Promise<boolean>… 引用了拿不到的 rule，手动收拾 */;
  actions: Array<any>;
  hostInterface: string;
  rules: Array<any>;
};

export type ResolveHostRuleTargetsResult = {
  getForwardChainGroup: any;
};

export async function resolveHostRuleTargets(ctx: ResolveHostRuleTargetsContext): Promise<ResolveHostRuleTargetsResult> {
  const { agentHostRules, dnsWatches, dnsChangedIpByHost, dnsChangedFor, dnsChangedRuleIds, dnsPreviousIpByRuleId, resolvedTargetGate, actions, hostInterface, rules } = ctx;
  const resolvedHostRuleTargets = await mapWithConcurrency(agentHostRules as any[], 32, async (rule: any) => {
    if (!rule.targetIp) return null;
    addDnsWatch(dnsWatches, rule.targetIp, "forward-rule-target", Number(rule.id));
    const rawTargetIp = String(rule.targetIp || "").trim();
    const previous = resolvedIpCache.get(Number(rule.id));
    const forcedResolved = dnsChangedIpByHost.get(rawTargetIp.toLowerCase());
    const resolved = forcedResolved || await resolveTargetIpCached(Number(rule.id), rawTargetIp);
    return { rule, rawTargetIp, previous, forcedResolved, resolved };
  });
  for (const target of resolvedHostRuleTargets) {
    if (!target) continue;
    const { rule, rawTargetIp, previous, forcedResolved, resolved } = target;
    if (forcedResolved) expireSharedResolvedIp(Number(rule.id));
    if (dnsChangedFor("forward-rule-target", Number(rule.id)) && previous && previous.raw === rawTargetIp && previous.ip !== resolved) {
      // IP 变更：标记为需要重新下发
      dnsChangedRuleIds.add(rule.id);
      dnsPreviousIpByRuleId.set(rule.id, previous.ip);
    }
    if (!forcedResolved) setBoundedMapValue(resolvedIpCache, rule.id, { raw: rawTargetIp, ip: resolved }, AGENT_DYNAMIC_CACHE_MAX);
    // 保存原始值（域名），将 rule.targetIp 替换为解析后的 IP
    (rule as any)._originalTargetIp = rule.targetIp;
    rule.targetIp = resolved;
    // 域名解析到了内网 / 环回，而这台机器不是规则主人的：不下发（见 ruleTargetPolicy）。
    if (await resolvedTargetGate(rule, rawTargetIp, resolved)) {
      rule.isEnabled = false;
      (rule as any).resourceAccessDenied = true;
    }
  }

  const resolveForwardChainTargetsResult = resolveForwardChainTargets({ dnsWatches, dnsChangedIpByHost });
  const { resolveForwardChainTarget, getForwardChainGroup } = resolveForwardChainTargetsResult;

  // 对 DNS 变更且正在运行的规则，先生成清理动作，再通过 isRunning=false 触发重新下发
  for (const rule of agentHostRules as any[]) {
    if (!dnsChangedRuleIds.has(rule.id)) continue;
    if (!runtimeBool(rule.isEnabled) || !runtimeBool(rule.isRunning)) continue;
    if (failoverProxyHandlesTargetDns(rule)) {
      console.log(`[DNS] rule=${rule.id} target changed; failover proxy will resolve ${rule._originalTargetIp || rule.targetIp} without service reload`);
      continue;
    }
    const oldIp = dnsPreviousIpByRuleId.get(rule.id) || rule._originalTargetIp || rule.targetIp;
    const ruleResolvedIp = rule.targetIp; // 已经是新解析的 IP
    const cleanupCmds = buildDnsChangeCleanup(rule, oldIp);
    if (cleanupCmds.length > 0) {
      actions.push({
        ruleId: rule.id,
        op: "remove",
        forwardType: rule.forwardType,
        sourcePort: rule.sourcePort,
        targetIp: ruleResolvedIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        networkInterface: hostInterface,
        commands: cleanupCmds,
      } as any);
    }
    // 重置 isRunning 让主循环生成 apply 动作
    rule.isRunning = false;
    console.log(`[DNS] rule=${rule.id} target changed: ${oldIp} → ${ruleResolvedIp}, re-applying`);
  }

  const chainTargetsByRuleId = new Map<number, { targetIp: string; targetPort: number; originalTargetIp?: string }>();
  await mapWithConcurrency(agentHostRules as any[], 16, async (rule: any) => {
    const chainTarget = await resolveForwardChainTarget(rule);
    if (!chainTarget) return;
    const oldTargetIp = String(rule.targetIp || "").trim();
    const oldTargetPort = Number(rule.targetPort) || 0;
    chainTargetsByRuleId.set(Number(rule.id), chainTarget);
    if (oldTargetIp === chainTarget.targetIp && oldTargetPort === chainTarget.targetPort) return;
    if (runtimeBool(rule.isEnabled) && runtimeBool(rule.isRunning)) {
      actions.push({
        ruleId: rule.id,
        op: "remove",
        forwardType: rule.forwardType,
        sourcePort: rule.sourcePort,
        targetIp: oldTargetIp,
        targetPort: oldTargetPort,
        protocol: rule.protocol,
        networkInterface: hostInterface,
        commands: buildForwardTargetCleanup(rule, oldTargetIp, oldTargetPort),
      } as any);
      rule.isRunning = false;
    }
    rule.targetIp = chainTarget.targetIp;
    rule.targetPort = chainTarget.targetPort;
    (rule as any)._originalTargetIp = chainTarget.originalTargetIp || chainTarget.targetIp;
    await db.updateForwardRule(Number(rule.id), {
      targetIp: chainTarget.originalTargetIp || chainTarget.targetIp,
      targetPort: chainTarget.targetPort,
      isRunning: false,
    } as any);
    appendPanelLog("info", `[ForwardChain] rule=${rule.id} target=${chainTarget.targetIp}:${chainTarget.targetPort}${chainTarget.originalTargetIp && chainTarget.originalTargetIp !== chainTarget.targetIp ? ` resolvedFrom=${chainTarget.originalTargetIp}` : ""} source=chain-config`);
  });
  for (const rule of rules as any[]) {
    const chainTarget = chainTargetsByRuleId.get(Number(rule.id));
    if (!chainTarget) continue;
    rule.targetIp = chainTarget.targetIp;
    rule.targetPort = chainTarget.targetPort;
    (rule as any)._originalTargetIp = chainTarget.originalTargetIp || chainTarget.targetIp;
    if ((agentHostRules as any[]).some((item: any) => Number(item.id) === Number(rule.id) && !runtimeBool(item.isRunning))) {
      rule.isRunning = false;
    }
  }
  return { getForwardChainGroup };
}
