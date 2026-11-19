/*
  转发组的入口端口：成员主机的端口策略合起来是什么、组里还有哪些端口能用、给组建规则时端口 / 目标 / 字段是否合法
  （validateForwardGroupRuleConfig、filterForwardGroupFieldsForUse）。
*/

import { normalizeSourcePortEnd } from "../../shared/portRange";
import { forwardGroupModeOf } from "../../shared/forwardTypes";
import { getForwardGroupChildRulesForTemplate } from "../repositories/forwardRuleRepository";
import { getHostById } from "../repositories/hostRepository";
import { getUsedPortsOnHost, getTunnelById, isPortUsedOnHost, findUsedPortInRangeOnHost } from "../repositories/tunnelRepository";
import { combineHostPortPolicyWithRange, combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom, type PortPolicy } from "@shared/portPolicy";
import { dbBool } from "../repositories/repositoryUtils";
import { normalizeExitGroupStrategy } from "@shared/loadBalance";
import { MAX_FORWARD_GROUP_MEMBERS } from "../../shared/forwardGroup";
import { ForwardGroupRuleConfig, chainEntryMembers, entryAddressForHost, entryGroupMembersFor, isCollectionGroupMode, memberEntryHostId, memberListenHostIds, sortedMembers } from "./common";
import { getForwardGroupById, normalizeRuleProtocol, resolveChainConnectHost } from "../repositories/forwardGroupRepository";
import { existingChildRule } from "./ruleSync";
import { forwardGroupRuntimeDependenciesEnabled } from "./runtime";

export async function isPortUsedOnHostForGroupChild(hostId: number, sourcePort: number, ignoreRuleIds: number[], protocol?: unknown, sourcePortEnd?: unknown) {
  // 端口段模板：段里任何一个端口被占都算（一次取齐这台机器的占用，不逐个端口查）。
  const end = normalizeSourcePortEnd(sourcePort, sourcePortEnd);
  if (end) return (await findUsedPortInRangeOnHost(hostId, sourcePort, end, ignoreRuleIds, protocol)) !== null;
  return isPortUsedOnHost(hostId, sourcePort, ignoreRuleIds, protocol, undefined, false);
}

export async function entryPortPolicyForMember(member: any): Promise<{ hostId: number; policy: PortPolicy }> {
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(member.tunnelId));
    if (!tunnel) throw new Error("Tunnel does not exist");
    const entryHost = await getHostById(Number((tunnel as any).entryHostId || 0));
    if (!entryHost) throw new Error("Tunnel entry host does not exist");
    return {
      hostId: Number((tunnel as any).entryHostId || 0),
      policy: combineHostPortPolicyWithRange(
        entryHost as any,
        (tunnel as any).portRangeStart,
        (tunnel as any).portRangeEnd,
      ),
    };
  }
  const host = await getHostById(Number(member.hostId));
  if (!host) throw new Error("Host does not exist");
  return {
    hostId: Number(host.id || 0),
    policy: portPolicyFrom(host as any),
  };
}

export async function assertEntryPortAllowed(member: any, sourcePort: number, sourcePortEnd?: unknown) {
  const entry = await entryPortPolicyForMember(member);
  const end = normalizeSourcePortEnd(sourcePort, sourcePortEnd) ?? sourcePort;
  for (let port = sourcePort; port <= end; port += 1) {
    if (!isPortAllowedByPolicy(port, entry.policy)) {
      throw new Error(portPolicyErrorMessage(entry.policy, "入口端口"));
    }
  }
}

function policyHasRestrictionForGroup(policy: PortPolicy) {
  return !!policy.denyAll
    || (policy.rangeStart !== null && policy.rangeEnd !== null)
    || (policy.ranges?.length || 0) > 0
    || policy.allowlist.length > 0;
}

function longestContiguousRange(ports: number[]) {
  const sorted = Array.from(new Set(ports)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  let bestStart = sorted[0];
  let bestEnd = sorted[0];
  let runStart = sorted[0];
  let previous = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    if (previous - runStart > bestEnd - bestStart) {
      bestStart = runStart;
      bestEnd = previous;
    }
    runStart = current;
    previous = current;
  }
  return { start: bestStart, end: bestEnd };
}

function policyRangeForGroup(policy: PortPolicy) {
  if (policy.denyAll) return null;
  if (!policyHasRestrictionForGroup(policy)) return { start: 10000, end: 65535 };
  const candidates = [
    ...(policy.rangeStart !== null && policy.rangeEnd !== null
      ? Array.from({ length: policy.rangeEnd - policy.rangeStart + 1 }, (_, index) => policy.rangeStart! + index)
      : []),
    ...policy.allowlist,
    ...(policy.ranges || []).flatMap((range) => {
      const ports: number[] = [];
      for (let port = range.start; port <= range.end; port += 1) ports.push(port);
      return ports;
    }),
  ];
  return longestContiguousRange(candidates);
}

function candidatePortsForGroup(policy: PortPolicy) {
  if (policy.denyAll) return [];
  const ports: number[] = [];
  const portSet = new Set<number>();
  const addPort = (port: number) => {
    if (portSet.has(port)) return;
    portSet.add(port);
    ports.push(port);
  };
  if (!policyHasRestrictionForGroup(policy)) {
    for (let port = 10000; port <= 65535; port++) addPort(port);
    return ports;
  }
  if (policy.rangeStart !== null && policy.rangeEnd !== null) {
    for (let port = policy.rangeStart; port <= policy.rangeEnd; port++) addPort(port);
  }
  for (const range of policy.ranges || []) {
    for (let port = range.start; port <= range.end; port++) {
      addPort(port);
    }
  }
  for (const port of policy.allowlist) {
    addPort(port);
  }
  return ports.filter((port) => isPortAllowedByPolicy(port, policy));
}

/**
 * 一个转发组的入口端口到底允许哪些 —— 组里每个「要占端口」的成员各有一份
 * 策略（主机自己的范围与白名单；隧道成员还要叠上隧道范围），取交集。
 *
 * 之所以抽出来：这段循环原本在仓库里存在**三份**（取范围、找可用端口、
 * 校验规则各一份），而界面上又完全没有，转发组模式的「允许端口范围」
 * 一直显示「不限制」。
 *
 * 成员的选法照抄 validateForwardGroupRuleConfig —— 判定接不接受一个端口的
 * 就是它，显示和校验必须用同一批成员，否则又是一份会漂开的答案。
 *
 * 逐个成员放行 ≡ 合并后放行：这一点不是想当然，随机造了 4000 组成员策略
 * 比了 40 万次，两边结论完全一致（见 forwardGroupPortPolicy.test.ts）。
 */
export async function forwardGroupEntryPortPolicy(group: any): Promise<PortPolicy> {
  const members = sortedMembers(group);
  const groupMode = forwardGroupModeOf(group);
  const chainEntries = await entryGroupMembersFor(group);
  const portCheckMembers = groupMode === "chain"
    ? (chainEntries.length > 0 ? chainEntries : members.filter((member: any) => dbBool(member?.isEnabled)).slice(0, 1))
    : (chainEntries.length > 0 ? chainEntries : members);
  let policy = portPolicyFrom(null);
  for (const member of portCheckMembers) {
    if (!dbBool(member?.isEnabled)) continue;
    const entry = await entryPortPolicyForMember(member);
    policy = combinePortPolicies(policy, entry.policy);
  }
  return policy;
}

export async function getForwardGroupEntryPortPolicy(groupId: number): Promise<PortPolicy> {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  return forwardGroupEntryPortPolicy(group);
}

export async function getForwardGroupEntryPortRange(groupId: number): Promise<{ start: number; end: number } | null> {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const members = sortedMembers(group, true);
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const entryMembers = await entryGroupMembersFor(group);
  if (members.length === 0 && !(groupMode === "port" && entryMembers.length > 0)) throw new Error("Forward group has no enabled members");
  if (groupMode === "chain" && (members.length < (entryMembers.length > 0 ? 1 : 2) || members.length > MAX_FORWARD_GROUP_MEMBERS)) {
    throw new Error(entryMembers.length > 0
      ? `Port forwarding chain requires 1-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`
      : "Port forwarding chain requires at least two enabled hosts");
  }

  let policy = portPolicyFrom(null);
  const policyMembers = groupMode === "chain"
    ? (entryMembers.length > 0 ? entryMembers : members.slice(0, 1))
    : (entryMembers.length > 0 ? entryMembers : members);
  for (const member of policyMembers) {
    const entry = await entryPortPolicyForMember(member);
    if (!entry.hostId) throw new Error("Forward group member has no valid entry agent");
    policy = combinePortPolicies(policy, entry.policy);
  }
  return policyRangeForGroup(policy);
}

export async function findAvailableForwardGroupPort(
  groupId: number,
  excludeTemplateRuleId?: number | null,
  allowedRange?: { start: number; end: number; ranges?: Array<{ start: number; end: number }> } | null,
  protocol?: unknown,
  unavailablePorts: Iterable<number> = [],
) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const members = sortedMembers(group, true);
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const entryMembers = await entryGroupMembersFor(group);
  if (members.length === 0 && !(groupMode === "port" && entryMembers.length > 0)) throw new Error("Forward group has no enabled members");
  if (groupMode === "chain" && (members.length < (entryMembers.length > 0 ? 1 : 2) || members.length > MAX_FORWARD_GROUP_MEMBERS)) {
    throw new Error(entryMembers.length > 0
      ? `Port forwarding chain requires 1-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`
      : "Port forwarding chain requires at least two enabled hosts");
  }

  const entries: Array<{ hostId: number; ignoreRuleIds: number[] }> = [];
  const excludedChildRuleIds = excludeTemplateRuleId
    ? (await getForwardGroupChildRulesForTemplate(Number(excludeTemplateRuleId)))
      .map((rule: any) => Number(rule.id))
      .filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  let policy = portPolicyFrom(null);

  const candidateMembers = groupMode === "chain"
    ? (entryMembers.length > 0 ? entryMembers : members.slice(0, 1))
    : (entryMembers.length > 0 ? entryMembers : members);
  for (const member of candidateMembers) {
    const entry = await entryPortPolicyForMember(member);
    if (!entry.hostId) throw new Error("Forward group member has no valid entry agent");
    const childMemberId = groupMode === "chain" && entryMembers.length > 0
      ? Number(members[0]?.id || 0)
      : Number(member.id);
    const existing = excludeTemplateRuleId
      ? await existingChildRule(Number(excludeTemplateRuleId), childMemberId, entry.hostId)
      : null;
    const ignoreRuleIds = [
      Number(excludeTemplateRuleId || 0),
      ...excludedChildRuleIds,
      Number(existing?.id || 0),
    ].filter(Boolean);
    // 隧道成员挂了入口组时，组里的主机也要在这个端口上监听，挑的端口在这些主机上也得空着。
    for (const hostId of new Set([entry.hostId, ...await memberListenHostIds(member)])) {
      entries.push({ hostId, ignoreRuleIds });
    }
    policy = combinePortPolicies(policy, entry.policy);
  }
  if (allowedRange) {
    policy = combinePortPolicies(policy, portPolicyFrom({
      ...(allowedRange.ranges?.length
        ? { portRanges: allowedRange.ranges }
        : { portRangeStart: allowedRange.start, portRangeEnd: allowedRange.end }),
    }));
  }
  const candidates = candidatePortsForGroup(policy);
  if (candidates.length === 0) return null;

  const usedPortSets = await Promise.all(
    entries.map((entry) => getUsedPortsOnHost(entry.hostId, entry.ignoreRuleIds, protocol, undefined, false)),
  );
  const unavailable = new Set(Array.from(unavailablePorts, Number).filter((port) => Number.isInteger(port) && port > 0));
  const isAvailable = (port: number) => !unavailable.has(port) && usedPortSets.every((usedPorts) => !usedPorts.has(port));

  const randomAttempts = Math.min(120, candidates.length);
  for (let i = 0; i < randomAttempts; i++) {
    const port = candidates[Math.floor(Math.random() * candidates.length)];
    if (isAvailable(port)) return port;
  }

  for (const port of candidates) {
    if (isAvailable(port)) return port;
  }
  return null;
}

export async function validateForwardGroupRuleConfig(groupId: number, config: ForwardGroupRuleConfig) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  if (!(await forwardGroupRuntimeDependenciesEnabled(group))) throw new Error("转发资源未启用或关联入口组已停用");
  const sourcePort = Number(config.sourcePort || 0);
  const protocol = normalizeRuleProtocol(config.protocol);
  if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) {
    throw new Error("Forward group entry port must be 1-65535");
  }
  const members = sortedMembers(group);
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const chainEntries = await entryGroupMembersFor(group);
  if (members.length === 0 && !(groupMode === "port" && chainEntries.length > 0)) throw new Error("Forward group has no members");
  if (groupMode === "port") {
    if (chainEntries.length === 0 && (members.length < 1 || members.length > MAX_FORWARD_GROUP_MEMBERS)) throw new Error(`端口转发需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台入口主机，或者挂一个入口组`);
    if (String(group.groupType || "host") !== "host") throw new Error("端口转发仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error("端口转发仅支持主机成员");
  }
  if (groupMode === "chain") {
    const enabledMembers = members.filter((member: any) => dbBool(member?.isEnabled));
    const entryMembers = await chainEntryMembers(group);
    const minEnabledMembers = entryMembers.length > 0 ? 1 : 2;
    if (String((group as any).groupType || "host") !== "host") {
      throw new Error("Port forwarding chain only supports host members");
    }
    if (enabledMembers.length < minEnabledMembers || enabledMembers.length > MAX_FORWARD_GROUP_MEMBERS) {
      throw new Error(entryMembers.length > 0
        ? `Port forwarding chain requires 1-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`
        : `Port forwarding chain requires 2-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`);
    }
    const hasExternalEntry = entryMembers.length > 0;
    for (const [index, member] of enabledMembers.entries()) {
      if (member.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
      const host = await getHostById(Number(member.hostId));
      if (!host) throw new Error("Host does not exist");
      if (index === 0 && !hasExternalEntry) {
        if (!entryAddressForHost(host)) throw new Error("Port forwarding chain entry host has no entry address");
      } else if (!resolveChainConnectHost(member, host)) {
        throw new Error("Port forwarding chain host has no usable connect address");
      }
    }
    for (const entryMember of entryMembers) {
      const host = await getHostById(Number(entryMember.hostId));
      if (!host || !entryAddressForHost(host)) throw new Error("Entry group host has no entry address");
    }
    const chainHostIds = new Set(enabledMembers.map((member: any) => Number(member.hostId || 0)));
    if (entryMembers.some((member: any) => chainHostIds.has(Number(member.hostId || 0)))) {
      throw new Error("Entry group host cannot also be used inside the port forwarding chain");
    }
  }

  const portCheckMembers = groupMode === "chain"
    ? (chainEntries.length > 0 ? chainEntries : members.filter((member: any) => dbBool(member?.isEnabled)).slice(0, 1))
    : (chainEntries.length > 0 ? chainEntries : members);
  const firstChainMember = groupMode === "chain"
    ? members.filter((member: any) => dbBool(member?.isEnabled))[0] || null
    : null;
  const excludedChildRuleIds = config.excludeTemplateRuleId
    ? (await getForwardGroupChildRulesForTemplate(Number(config.excludeTemplateRuleId)))
      .map((rule: any) => Number(rule.id))
      .filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  // 一次判完，而不是逐个成员判：报错时说出来的才是**真正**的允许范围，
  // 也正是界面显示的那一份；逐个判只会报到第一个不满足的成员为止。
  const entryPolicy = await forwardGroupEntryPortPolicy(group);
  if (!config.sniBackendPort && !isPortAllowedByPolicy(sourcePort, entryPolicy)) {
    throw new Error(portPolicyErrorMessage(entryPolicy, "入口端口"));
  }
  for (const member of portCheckMembers) {
    if (!dbBool(member?.isEnabled)) continue;
    const hostId = await memberEntryHostId(member);
    if (!hostId) throw new Error("Forward group member has no valid entry agent");
    const childMemberId = groupMode === "chain" && chainEntries.length > 0 && firstChainMember
      ? Number(firstChainMember.id)
      : Number(member.id);
    const existing = config.excludeTemplateRuleId
      ? await existingChildRule(Number(config.excludeTemplateRuleId), childMemberId, hostId)
      : null;
    const ignoreRuleIds = [
      Number(config.excludeTemplateRuleId || 0),
      ...excludedChildRuleIds,
      Number(existing?.id || 0),
    ].filter(Boolean);
    // 隧道成员挂了入口组：组里每台主机也替子规则监听，一起查。
    for (const listenHostId of new Set([hostId, ...await memberListenHostIds(member)])) {
      const used = await isPortUsedOnHostForGroupChild(listenHostId, sourcePort, ignoreRuleIds, protocol);
      if (used) throw new Error(`Entry agent port ${sourcePort} is already used`);
    }
  }
  return group;
}

export function filterForwardGroupFieldsForUse(
  groups: any[],
  accessScope?: {
    hostIds: ReadonlySet<number>;
    tunnelIds: ReadonlySet<number>;
    groupHostIds?: ReadonlyMap<number, ReadonlySet<number>>;
    groupTunnelIds?: ReadonlyMap<number, ReadonlySet<number>>;
  },
) {
  const memberVisible = (group: any, member: any) => {
    if (!accessScope) return true;
    const groupId = Number(group?.id || 0);
    const groupHostIds = accessScope.groupHostIds?.get(groupId);
    const groupTunnelIds = accessScope.groupTunnelIds?.get(groupId);
    if (groupHostIds || groupTunnelIds) {
      return member?.memberType === "tunnel"
        ? !!groupTunnelIds?.has(Number(member.tunnelId || 0))
        : !!groupHostIds?.has(Number(member.hostId || 0));
    }
    return member?.memberType === "tunnel"
      ? accessScope.tunnelIds.has(Number(member.tunnelId || 0))
      : accessScope.hostIds.has(Number(member.hostId || 0));
  };
  const memberHostVisible = (group: any, member: any) => {
    if (!accessScope) return true;
    const hostId = Number(member?.host?.id || member?.hostId || 0);
    if (accessScope.hostIds.has(hostId)) return true;
    const groupHostIds = accessScope.groupHostIds?.get(Number(group?.id || 0));
    return !!groupHostIds?.has(hostId);
  };
  return groups.map((group: any) => ({
    id: group.id,
    name: group.name,
    remark: group.remark || null,
    groupType: group.groupType,
    groupMode: forwardGroupModeOf(group),
    exitStrategy: normalizeExitGroupStrategy(group.exitStrategy),
    entryGroupId: group.entryGroupId ?? null,
    forwardType: group.forwardType,
    domain: group.domain,
    recordType: group.recordType,
    ddnsDualStack: dbBool(group.ddnsDualStack),
    trafficMultiplier: group.trafficMultiplier,
    failoverSeconds: group.failoverSeconds,
    recoverSeconds: group.recoverSeconds,
    chinaHealthCheckEnabled: dbBool(group.chinaHealthCheckEnabled),
    chinaHealthCheckTarget: group.chinaHealthCheckTarget || null,
    telegramSwitchNotifyEnabled: !!group.telegramSwitchNotifyEnabled,
    ddnsAutoResolveEnabled: group.ddnsAutoResolveEnabled !== false,
    autoFailback: group.autoFailback,
    isEnabled: dbBool(group.isEnabled, true),
    lastStatus: group.lastStatus,
    lastDdnsValue: group.lastDdnsValue,
    lastFailoverAt: group.lastFailoverAt,
    lastRecoverAt: group.lastRecoverAt,
    templateRuleCount: group.templateRuleCount,
    runtimeStatus: group.runtimeStatus,
    runtimeExpectedRuleCount: group.runtimeExpectedRuleCount,
    runtimeConfiguredRuleCount: group.runtimeConfiguredRuleCount,
    runtimeRunningRuleCount: group.runtimeRunningRuleCount,
    runtimeFailedRuleCount: group.runtimeFailedRuleCount,
    ruleRuntimeStatuses: group.ruleRuntimeStatuses,
    availability: group.availability ?? null,
    members: (group.members || [])
      .filter((member: any) => memberVisible(group, member))
      .map((member: any) => {
        const hostVisible = memberHostVisible(group, member);
        return {
          id: member.id,
          groupId: member.groupId,
          memberType: member.memberType,
          hostId: member.hostId ?? null,
          tunnelId: member.tunnelId ?? null,
          connectHost: hostVisible ? member.connectHost ?? null : null,
          entryAddress: hostVisible ? member.entryAddress ?? null : null,
          healthStatus: member.healthStatus,
          lastLatencyMs: member.lastLatencyMs,
          chinaHealthStatus: member.chinaHealthStatus,
          chinaHealthLatencyMs: member.chinaHealthLatencyMs,
          chinaHealthCheckedAt: member.chinaHealthCheckedAt,
          priority: member.priority,
          isEnabled: dbBool(member.isEnabled, true),
          host: member.host && hostVisible ? {
            id: member.host.id,
            name: member.host.name,
            ip: member.host.ip,
            ipv4: member.host.ipv4,
            ipv6: member.host.ipv6,
            entryIp: member.host.entryIp,
            tunnelEntryIp: member.host.tunnelEntryIp,
            ddnsEnabled: member.host.ddnsEnabled,
            ddnsDomain: member.host.ddnsDomain,
            isOnline: !!member.host.isOnline,
            lastHeartbeat: member.host.lastHeartbeat ?? null,
          } : null,
        };
      }),
  }));
}
