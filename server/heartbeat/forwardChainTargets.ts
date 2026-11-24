/*
  从 server/agentHeartbeatRoute.ts 第 1184-1284 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { addDnsWatch, expireSharedResolvedIp, resolveTargetIpCached, type AgentDnsWatch } from "../agentHeartbeatDns";
import { runtimeBool, selectForwardChainListenerPort } from "../agentHeartbeatRuntime";
import { AGENT_DYNAMIC_CACHE_MAX, resolvedIpCache } from "../agentHeartbeatState";
import { setBoundedMapValue } from "../boundedCache";
import * as db from "../db";
import { hostIngressAddress } from "../hostAddressRuntime";

export type ResolveForwardChainTargetsContext = {
  dnsWatches: Map<string, AgentDnsWatch>;
  dnsChangedIpByHost: Map<string, string>;
};

export type ResolveForwardChainTargetsResult = {
  resolveForwardChainTarget: any /* 原类型 (rule: any) => Promise<{ targetIp: string; targetPort: number; originalTargetIp:… 引用了拿不到的 rule，手动收拾 */;
  getForwardChainGroup: any /* 原类型 (groupId: number) => Promise<any>… 引用了拿不到的 groupId，手动收拾 */;
};

export function resolveForwardChainTargets(ctx: ResolveForwardChainTargetsContext): ResolveForwardChainTargetsResult {
  const { dnsWatches, dnsChangedIpByHost } = ctx;
  const chainMemberAddress = (member: any, hostLike: any) => {
    const configured = String(member?.connectHost || "").trim();
    if (configured) {
      addDnsWatch(dnsWatches, configured, "forward-chain-member", Number(member?.id || 0));
      return configured;
    }
    const value = hostIngressAddress(hostLike);
    addDnsWatch(dnsWatches, value, "host-entry", Number(hostLike?.id || member?.hostId || 0));
    return value;
  };
  const forwardChainHostById = new Map<number, any>();
  const forwardChainGroupById = new Map<number, any>();
  const forwardChainChildrenByTemplateId = new Map<number, Promise<any[]>>();
  const getForwardChainHost = async (hostId: number) => {
    const id = Number(hostId);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (forwardChainHostById.has(id)) return forwardChainHostById.get(id);
    const nextHost = await db.getHostById(id);
    forwardChainHostById.set(id, nextHost || null);
    return nextHost || null;
  };
  const getForwardChainGroup = async (groupId: number) => {
    const id = Number(groupId);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (forwardChainGroupById.has(id)) return forwardChainGroupById.get(id);
    const group = await db.getForwardGroupById(id);
    forwardChainGroupById.set(id, group || null);
    return group || null;
  };
  const getForwardChainChildren = async (templateRuleId: number) => {
    const id = Number(templateRuleId);
    if (!Number.isFinite(id) || id <= 0) return [] as any[];
    let pending = forwardChainChildrenByTemplateId.get(id);
    if (!pending) {
      pending = db.getForwardGroupChildRulesForTemplate(id).then((rows: any) => rows as any[]);
      forwardChainChildrenByTemplateId.set(id, pending);
    }
    return pending;
  };
  const resolveForwardChainTarget = async (rule: any) => {
    const groupId = Number(rule?.forwardGroupId || 0);
    const memberId = Number(rule?.forwardGroupMemberId || 0);
    if (!groupId || !memberId) return null;
    const group = await getForwardChainGroup(groupId);
    if (String((group as any)?.groupMode || "") !== "chain") return null;
    const members = [...(((group as any).members || []) as any[])]
      .filter((member: any) => runtimeBool(member?.isEnabled))
      .sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
    const memberIdx = members.findIndex((member: any) => Number(member.id) === memberId);
    if (memberIdx < 0) return null;
    const currentMember = members[memberIdx] as any;
    if (memberIdx === 0 && Number(rule.hostId || 0) !== Number(currentMember.hostId || 0)) {
      const entryGroupId = Number((group as any)?.entryGroupId || 0);
      if (!entryGroupId) return null;
      const entryGroup = await getForwardChainGroup(entryGroupId);
      const isEntryGroupHost = !!entryGroup
        && runtimeBool((entryGroup as any).isEnabled)
        && String((entryGroup as any).groupMode || "") === "entry"
        && (((entryGroup as any).members || []) as any[]).some((member: any) => (
          member
          && runtimeBool(member.isEnabled, true)
          && member.memberType === "host"
          && Number(member.hostId || 0) === Number(rule.hostId || 0)
        ));
      if (!isEntryGroupHost) return null;
      const firstHost = await getForwardChainHost(Number(currentMember.hostId));
      const targetIp = chainMemberAddress(currentMember, firstHost);
      const childRules = await getForwardChainChildren(Number(rule.forwardGroupRuleId || 0));
      const targetPort = selectForwardChainListenerPort(
        childRules,
        currentMember.id,
        currentMember.hostId,
        rule.targetPort,
      );
      if (!targetIp || targetPort <= 0) return null;
      const forcedResolved = dnsChangedIpByHost.get(String(targetIp).toLowerCase());
      const resolvedTargetIp = forcedResolved || await resolveTargetIpCached(Number(rule.id), targetIp);
      if (forcedResolved) expireSharedResolvedIp(Number(rule.id));
      if (!forcedResolved) setBoundedMapValue(resolvedIpCache, Number(rule.id), { raw: targetIp, ip: resolvedTargetIp }, AGENT_DYNAMIC_CACHE_MAX);
      return { targetIp: resolvedTargetIp, targetPort, originalTargetIp: targetIp };
    }
    if (memberIdx >= members.length - 1) return null;
    if (Number(rule.hostId || 0) !== Number(currentMember.hostId || 0)) return null;
    const nextMember = members[memberIdx + 1] as any;
    if (nextMember.memberType !== "host") return null;
    const nextHost = await getForwardChainHost(Number(nextMember.hostId));
    const targetIp = chainMemberAddress(nextMember, nextHost);
    const childRules = await getForwardChainChildren(Number(rule.forwardGroupRuleId || 0));
    const targetPort = selectForwardChainListenerPort(
      childRules,
      nextMember.id,
      nextMember.hostId,
      rule.targetPort,
    );
    if (!targetIp || targetPort <= 0) return null;
    const forcedResolved = dnsChangedIpByHost.get(String(targetIp).toLowerCase());
    const resolvedTargetIp = forcedResolved || await resolveTargetIpCached(Number(rule.id), targetIp);
    if (forcedResolved) expireSharedResolvedIp(Number(rule.id));
    if (!forcedResolved) setBoundedMapValue(resolvedIpCache, Number(rule.id), { raw: targetIp, ip: resolvedTargetIp }, AGENT_DYNAMIC_CACHE_MAX);
    return { targetIp: resolvedTargetIp, targetPort, originalTargetIp: targetIp };
  };
  return { resolveForwardChainTarget, getForwardChainGroup };
}
