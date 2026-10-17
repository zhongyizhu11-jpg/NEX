import * as db from "../db";
import { getDdnsSettings } from "../ddns";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { newForwardChainBatchId } from "../forwardChainManualProbe";
import { ENV } from "../env";
import { normalizeTrafficMultiplier } from "../../shared/trafficMultiplier";
import { normalizeForwardRuleProtocol, type ForwardRuleProtocol } from "../../shared/forwardTypes";
import { normalizeExitGroupStrategy, type ExitGroupStrategy } from "../../shared/exitStrategy";
import { MAX_FORWARD_GROUP_MEMBERS } from "../../shared/forwardGroup";
import {
  normalizeForwardGroupHealthCheckMethod,
  type ForwardGroupHealthCheckMethod,
} from "../../shared/forwardGroupHealthCheck";
import {
  normalizeAggregationMinMembers,
  normalizeAggregationRecordSlots,
  normalizeBandwidthAggregationStrategy,
  normalizeMemberBandwidthMbps,
  normalizeMemberWeight,
  type BandwidthAggregationStrategy,
} from "../../shared/bandwidthAggregation";

export type ForwardGroupMode = "port" | "failover" | "chain" | "entry" | "exit";
export type ForwardGroupType = "host" | "tunnel";

export type ForwardGroupMemberRequest = {
  memberType: ForwardGroupType;
  hostId?: number | null;
  tunnelId?: number | null;
  connectHost?: string | null;
  priority?: number;
  isEnabled?: boolean;
  /** Declared uplink of this front VPS, in Mbps. Entry groups only. */
  bandwidthMbps?: number | null;
  /** Manual bandwidth aggregation weight. Entry groups only. */
  aggregationWeight?: number | null;
};

export type ForwardGroupInput = {
  name: string;
  remark?: string | null;
  groupMode?: ForwardGroupMode;
  exitStrategy?: ExitGroupStrategy;
  entryGroupId?: number | null;
  groupType: ForwardGroupType;
  protocol?: ForwardRuleProtocol;
  forwardType?: "iptables" | "nftables" | "realm" | "socat" | "gost" | "nginx";
  proxyProtocolReceive?: boolean;
  proxyProtocolSend?: boolean;
  proxyProtocolExitReceive?: boolean;
  proxyProtocolExitSend?: boolean;
  proxyProtocolVersion?: number;
  tcpFastOpen?: boolean;
  zeroCopy?: boolean;
  udpOverTcp?: boolean;
  udpOverTcpPort?: number | null;
  failoverEnabled?: boolean;
  failoverStrategy?: "fallback" | "round_robin" | "random" | "ip_hash";
  failoverTargets?: Array<{ targetIp?: string; targetPort?: number }>;
  domain?: string | null;
  recordType?: "A" | "AAAA" | "CNAME";
  failoverSeconds: number;
  recoverSeconds: number;
  rateLimitMbps?: number;
  trafficMultiplier?: number;
  chinaHealthCheckEnabled?: boolean;
  chinaHealthCheckTarget?: string | null;
  /** "tcp" connects to a port on the target; "ping" measures ICMP latency. */
  chinaHealthCheckMethod?: ForwardGroupHealthCheckMethod;
  telegramSwitchNotifyEnabled?: boolean;
  ddnsAutoResolveEnabled?: boolean;
  /** Multi-front-VPS bandwidth aggregation. Entry groups only. */
  bandwidthAggregationEnabled?: boolean;
  bandwidthAggregationStrategy?: BandwidthAggregationStrategy;
  bandwidthAggregationSlots?: number;
  bandwidthAggregationMinMembers?: number;
  autoFailback: boolean;
  isEnabled: boolean;
  members: ForwardGroupMemberRequest[];
};

export function normalizeForwardGroupMembers(
  groupMode: ForwardGroupMode,
  groupType: ForwardGroupType,
  members: ForwardGroupMemberRequest[],
  options: { externalEntry?: boolean } = {},
) {
  const isCollectionGroup = groupMode === "entry" || groupMode === "exit";
  const effectiveGroupType = groupMode === "port" || groupMode === "chain" || isCollectionGroup ? "host" : groupType;
  const minChainMembers = options.externalEntry ? 1 : 2;
  // 端口转发：一台或多台入口主机，每台都同时监听规则的入口端口、转到同一目标（poouo/Forwardx#15）；
  // 挂了入口组（externalEntry）就不用自己的成员。
  if (groupMode === "port" && (members.length < (options.externalEntry ? 0 : 1) || members.length > MAX_FORWARD_GROUP_MEMBERS)) {
    throw new Error(`端口转发需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台入口主机，或者挂一个入口组`);
  }
  if (groupMode === "chain" && (members.length < minChainMembers || members.length > MAX_FORWARD_GROUP_MEMBERS)) {
    if (options.externalEntry) throw new Error(`转发链需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台主机`);
    throw new Error(`转发链需要配置 2-${MAX_FORWARD_GROUP_MEMBERS} 台主机`);
  }
  if (isCollectionGroup && (members.length < 1 || members.length > MAX_FORWARD_GROUP_MEMBERS)) {
    throw new Error(groupMode === "entry"
      ? `入口组需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台主机`
      : `出口组需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台主机`);
  }
  const seen = new Set<string>();
  return members.map((member, index) => {
    if (member.memberType !== effectiveGroupType) {
      throw new Error(groupMode === "chain" ? "转发链仅支持主机成员" : isCollectionGroup ? "入口组/出口组仅支持主机成员" : "成员类型必须与转发组类型一致");
    }
    const id = effectiveGroupType === "host" ? Number(member.hostId || 0) : Number(member.tunnelId || 0);
    if (!id) throw new Error(effectiveGroupType === "host" ? "请选择成员主机" : "请选择成员隧道");
    const key = `${effectiveGroupType}:${id}`;
    if (seen.has(key)) throw new Error("成员不能重复");
    seen.add(key);
    return {
      memberType: effectiveGroupType,
      hostId: effectiveGroupType === "host" ? id : null,
      tunnelId: effectiveGroupType === "tunnel" ? id : null,
      connectHost: groupMode === "chain" || groupMode === "exit" ? String(member.connectHost || "").trim() || null : null,
      priority: member.priority ?? index,
      isEnabled: groupMode === "port" || groupMode === "chain" ? true : member.isEnabled ?? true,
      // Bandwidth aggregation only applies to the front VPS hosts of an entry
      // group, so other group modes store zeroes.
      bandwidthMbps: groupMode === "entry" ? normalizeMemberBandwidthMbps(member.bandwidthMbps) : 0,
      aggregationWeight: groupMode === "entry" ? normalizeMemberWeight(member.aggregationWeight) : 0,
    };
  });
}

function memberPrioritySignature(members: ForwardGroupMemberRequest[]) {
  return members
    .map((member, index) => ({
      key: `${member.memberType}:${member.memberType === "host" ? Number(member.hostId || 0) : Number(member.tunnelId || 0)}`,
      enabled: member.isEnabled !== false,
      priority: Number(member.priority ?? index),
    }))
    .sort((a, b) => a.priority - b.priority)
    .map((member) => `${member.key}:${member.enabled ? 1 : 0}`)
    .join("|");
}

function memberRuntimeSignature(members: ForwardGroupMemberRequest[]) {
  return members
    .map((member, index) => ({
      key: `${member.memberType}:${member.memberType === "host" ? Number(member.hostId || 0) : Number(member.tunnelId || 0)}`,
      enabled: member.isEnabled !== false && Number(member.isEnabled as any) !== 0,
      priority: Number(member.priority ?? index),
      connectHost: String(member.connectHost || "").trim(),
      // Bandwidth and weight edits must reach the member rows, so they belong
      // in the signature that decides whether members are rewritten.
      bandwidthMbps: normalizeMemberBandwidthMbps(member.bandwidthMbps),
      aggregationWeight: normalizeMemberWeight(member.aggregationWeight),
    }))
    .sort((a, b) => a.priority - b.priority)
    .map((member) => `${member.key}:${member.enabled ? 1 : 0}:${member.connectHost}:${member.bandwidthMbps}:${member.aggregationWeight}`)
    .join("|");
}

async function assertEntryGroupReference(entryGroupId: number | null, userId?: number, requireEnabled = true) {
  if (!entryGroupId) return null;
  const entryGroup = await db.getForwardGroupById(entryGroupId) as any;
  if (!entryGroup || String(entryGroup.groupMode || "") !== "entry") throw new Error("入口组不存在或类型不正确");
  if (userId && Number(entryGroup.userId) !== Number(userId)) throw new Error("无权使用该入口组");
  if (requireEnabled && !entryGroup.isEnabled) throw new Error("入口组未启用");
  if (!String(entryGroup.domain || "").trim()) throw new Error("入口组未配置入口域名");
  return entryGroup;
}

async function assertDdnsServiceConfiguredForEntryGroup(ddnsAutoResolveEnabled: boolean) {
  if (!ddnsAutoResolveEnabled) return;
  const settings = await getDdnsSettings();
  if (!settings.enabled || settings.provider === "disabled") {
    throw new Error("入口组已开启自动解析，请先在系统设置中配置并启用 DDNS 服务商");
  }
}

async function assertTelegramSwitchNotifyReady(enabled: boolean) {
  if (!enabled) return;
  const settings = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
  if (!botEnabled || !botConfigured) {
    throw new Error("请先在系统设置中配置并启用 Telegram 机器人，再开启切换告警");
  }
}

async function normalizeForwardGroupInput(input: ForwardGroupInput, userId?: number) {
  const rawMode = input.groupMode;
  const groupMode: ForwardGroupMode = rawMode === "port" || rawMode === "chain" || rawMode === "entry" || rawMode === "exit" ? rawMode : "failover";
  const isCollectionGroup = groupMode === "entry" || groupMode === "exit";
  const groupType: ForwardGroupType = groupMode === "port" || groupMode === "chain" || isCollectionGroup ? "host" : input.groupType;
  // 转发链和端口转发（2.3.438 起）都能挂入口组
  const entryGroupId = groupMode === "chain" || groupMode === "port" ? Number(input.entryGroupId || 0) || null : null;
  await assertEntryGroupReference(entryGroupId, userId, input.isEnabled !== false);
  const domain = groupMode === "entry" || groupMode === "failover" ? input.domain?.trim() || null : null;
  if (groupMode === "entry" && !domain) throw new Error("入口组需要指定入口域名");
  const ddnsAutoResolveEnabled = groupMode === "entry" ? input.ddnsAutoResolveEnabled !== false : true;
  const bandwidthAggregationEnabled = groupMode === "entry" && !!input.bandwidthAggregationEnabled;
  if (groupMode === "entry") await assertDdnsServiceConfiguredForEntryGroup(ddnsAutoResolveEnabled);
  // 端口转发挂了入口组：入口全由入口组定，自己不留成员（界面上也不显示成员列表）
  const members = normalizeForwardGroupMembers(groupMode, groupType, groupMode === "port" && entryGroupId ? [] : input.members, {
    externalEntry: (groupMode === "chain" || groupMode === "port") && !!entryGroupId,
  });
  if (groupMode === "exit" && input.isEnabled !== false && !members.some((member) => member.isEnabled !== false)) {
    throw new Error("Enabled exit group must contain at least one enabled host");
  }
  const chinaHealthCheckEnabled = (groupMode === "failover" || groupMode === "entry") && !!input.chinaHealthCheckEnabled;
  const chinaHealthCheckMethod = normalizeForwardGroupHealthCheckMethod(input.chinaHealthCheckMethod);
  const rawChinaHealthTarget = chinaHealthCheckEnabled ? String(input.chinaHealthCheckTarget || "").trim() : "";
  const chinaHealthCheckTarget = chinaHealthCheckEnabled && rawChinaHealthTarget
    ? db.normalizeChinaHealthTarget(rawChinaHealthTarget, chinaHealthCheckMethod).text
    : null;
  const telegramSwitchNotifyEnabled = (groupMode === "failover" || groupMode === "entry") && !!input.telegramSwitchNotifyEnabled;
  await assertTelegramSwitchNotifyReady(telegramSwitchNotifyEnabled);
  const recordType = groupMode === "chain" || groupMode === "exit" ? "A" : input.recordType || "A";
  await db.validateForwardGroupRecordMembers({ groupMode, groupType, recordType }, members as any);
  const runtimeConfigSupported = groupMode === "port" || groupMode === "chain" || groupMode === "failover";
  const protocol = runtimeConfigSupported ? normalizeForwardRuleProtocol(input.protocol, "both") : "both";
  const runtimeTcpOptionsSupported = runtimeConfigSupported && protocol !== "udp";
  const forwardType = runtimeConfigSupported ? (input.forwardType || "iptables") : groupType === "tunnel" ? "gost" : "iptables";
  const runtimeProxyProtocolSupported = runtimeTcpOptionsSupported && (forwardType === "gost" || forwardType === "realm");
  const commonData = {
    name: input.name,
    remark: isCollectionGroup ? null : input.remark?.trim() || null,
    groupMode,
    exitStrategy: groupMode === "exit" ? normalizeExitGroupStrategy(input.exitStrategy) : "round_robin",
    entryGroupId,
    groupType,
    protocol,
    forwardType,
    // New groups opt into group-level runtime inheritance. Existing rows are
    // backfilled with false by the schema migration and become opted in only
    // after an explicit administrator save.
    failoverRuntimeInheritanceEnabled: true,
    proxyProtocolReceive: runtimeProxyProtocolSupported && !!input.proxyProtocolReceive,
    proxyProtocolSend: runtimeProxyProtocolSupported && !!input.proxyProtocolSend,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: runtimeProxyProtocolSupported && Number(input.proxyProtocolVersion) === 2 ? 2 : 1,
    // Realm 2.9.x no longer implements network.fast_open/zero_copy. Keep the
    // columns in the schema for old data, but normalize new group data off.
    tcpFastOpen: false,
    zeroCopy: false,
    udpOverTcp: false,
    udpOverTcpPort: null,
    failoverEnabled: false,
    failoverStrategy: "fallback",
    failoverTargets: null,
    domain,
    recordType,
    rateLimitMbps: runtimeConfigSupported ? Math.max(0, Math.floor(Number(input.rateLimitMbps) || 0)) : 0,
    trafficMultiplier: runtimeConfigSupported ? normalizeTrafficMultiplier(input.trafficMultiplier) : 100,
    failoverSeconds: input.failoverSeconds,
    recoverSeconds: input.recoverSeconds,
    chinaHealthCheckEnabled,
    chinaHealthCheckTarget,
    chinaHealthCheckMethod,
    telegramSwitchNotifyEnabled,
    ddnsAutoResolveEnabled,
    bandwidthAggregationEnabled,
    bandwidthAggregationStrategy: normalizeBandwidthAggregationStrategy(input.bandwidthAggregationStrategy),
    bandwidthAggregationSlots: normalizeAggregationRecordSlots(input.bandwidthAggregationSlots),
    bandwidthAggregationMinMembers: normalizeAggregationMinMembers(input.bandwidthAggregationMinMembers),
    autoFailback: input.autoFailback,
    isEnabled: input.isEnabled,
  };
  return {
    data: {
      ...commonData,
      ...(userId ? { userId } : {}),
    },
    createData: {
      ...commonData,
      sourcePort: 1,
      protocol,
      targetIp: "0.0.0.0",
      targetPort: 1,
      userId,
    },
    members,
  };
}
export async function createForwardGroupFromInput(input: ForwardGroupInput, userId: number) {
  const normalized = await normalizeForwardGroupInput(input, userId);
  const id = await db.createForwardGroup(normalized.createData as any, normalized.members as any);
  if (normalized.data.groupMode === "chain" || normalized.data.groupMode === "port") await db.syncForwardGroupRules(id);
  else await db.runForwardGroupFailover(id, { manual: true });
  return id;
}

export async function updateForwardGroupFromInput(id: number, input: ForwardGroupInput) {
  const existing = await db.getForwardGroupById(id) as any;
  if (!existing) throw new Error("转发资源不存在");
  const normalized = await normalizeForwardGroupInput(input);
  const desiredEnabled = !!normalized.data.isEnabled;
  const enabledChanged = !!existing.isEnabled !== desiredEnabled;
  const memberPriorityChanged = memberPrioritySignature((existing?.members || []) as ForwardGroupMemberRequest[])
    !== memberPrioritySignature(normalized.members as ForwardGroupMemberRequest[]);
  const membersChanged = memberRuntimeSignature((existing?.members || []) as ForwardGroupMemberRequest[])
    !== memberRuntimeSignature(normalized.members as ForwardGroupMemberRequest[]);
  const rateLimitChanged = Number(existing?.rateLimitMbps || 0) !== Number(normalized.data.rateLimitMbps || 0);
  const previousHostIds = ((existing?.members || []) as ForwardGroupMemberRequest[])
    .filter((member) => member.memberType === "host")
    .map((member) => Number(member.hostId || 0))
    .filter((hostId) => Number.isFinite(hostId) && hostId > 0);
  const entryDomainChanged = normalized.data.groupMode === "entry"
    && String(existing?.domain || "").trim() !== String(normalized.data.domain || "").trim();
  const aggregationSignature = (group: any) => [
    !!group?.bandwidthAggregationEnabled,
    normalizeBandwidthAggregationStrategy(group?.bandwidthAggregationStrategy),
    normalizeAggregationRecordSlots(group?.bandwidthAggregationSlots),
    normalizeAggregationMinMembers(group?.bandwidthAggregationMinMembers),
  ].join("|");
  const aggregationChanged = normalized.data.groupMode === "entry"
    && aggregationSignature(existing) !== aggregationSignature(normalized.data);
  const exitStrategyChanged = normalized.data.groupMode === "exit"
    && normalizeExitGroupStrategy(existing?.exitStrategy) !== normalizeExitGroupStrategy(normalized.data.exitStrategy);
  const shouldResetChinaHealth = !normalized.data.chinaHealthCheckEnabled
    || !!existing?.chinaHealthCheckEnabled !== !!normalized.data.chinaHealthCheckEnabled
    || String(existing?.chinaHealthCheckTarget || "") !== String(normalized.data.chinaHealthCheckTarget || "")
    || normalizeForwardGroupHealthCheckMethod(existing?.chinaHealthCheckMethod)
      !== normalizeForwardGroupHealthCheckMethod(normalized.data.chinaHealthCheckMethod);
  const persistConfiguration = async (options: { deferRefresh?: boolean; skipMemberSync?: boolean } = {}) => {
    await db.updateForwardGroup(id, {
      ...normalized.data,
      isEnabled: enabledChanged ? !!existing.isEnabled : desiredEnabled,
    } as any, { skipSync: true });
    if (membersChanged) {
      await db.replaceForwardGroupMembers(id, normalized.members as any, {
        skipSync: enabledChanged || options.skipMemberSync,
        deferRefresh: options.deferRefresh,
      });
    }
    if (shouldResetChinaHealth) await db.resetForwardGroupChinaHealth(id);
  };
  if (normalized.data.groupMode === "chain" && !enabledChanged) {
    await db.withForwardGroupSyncTransaction(
      id,
      () => persistConfiguration({ deferRefresh: true, skipMemberSync: true }),
      membersChanged ? {} : { preserveRuntime: true },
    );
    return db.getForwardGroupById(id);
  }
  await persistConfiguration();
  if (enabledChanged) {
    await db.setForwardGroupEnabled(id, desiredEnabled);
    if (membersChanged && (normalized.data.groupMode === "entry" || normalized.data.groupMode === "exit")) {
      await db.refreshForwardGroupReferences(id, {
        reason: `${normalized.data.groupMode}-group-members-and-state-updated`,
        previousHostIds,
      });
    } else if (exitStrategyChanged) {
      await db.refreshForwardGroupReferences(id, { reason: "exit-group-strategy-updated" });
    }
    return db.getForwardGroupById(id);
  }
  if (normalized.data.groupMode === "chain" || normalized.data.groupMode === "port") {
    if (!membersChanged) await db.syncForwardGroupRules(id, { preserveRuntime: true });
  } else if (normalized.data.groupMode === "entry" || normalized.data.groupMode === "exit") {
    if (!membersChanged) await db.runForwardGroupFailover(id, { manual: true, forceSync: aggregationChanged });
    if (!membersChanged && entryDomainChanged) {
      await db.refreshForwardGroupReferences(id, { reason: "entry-group-domain-updated" });
    } else if (!membersChanged && exitStrategyChanged) {
      await db.refreshForwardGroupReferences(id, { reason: "exit-group-strategy-updated" });
    }
  } else {
    await db.runForwardGroupFailover(id, {
      forcePriority: memberPriorityChanged,
      forceSync: memberPriorityChanged,
      manual: true,
    });
  }
  if (rateLimitChanged && (normalized.data.groupMode === "port" || normalized.data.groupMode === "failover")) {
    await db.refreshForwardGroupRuntime(id, "forward-group-rate-limit-updated");
  }
  return db.getForwardGroupById(id);
}

export async function getForwardGroupDeleteImpact(groupId: number) {
  const templateRules = ((await db.getForwardGroupTemplateRules(groupId)) as any[])
    .filter((rule) => !rule.pendingDelete);
  const childRules = ((await db.getForwardGroupChildRules(groupId)) as any[])
    .filter((rule) => !rule.pendingDelete);
  return {
    templateRuleCount: templateRules.length,
    childRuleCount: childRules.length,
    forwardRuleCount: templateRules.length + childRules.length,
    forwardRules: [...templateRules, ...childRules].slice(0, 8).map((rule) => ({
      id: Number(rule.id),
      name: String(rule.name || `规则 #${rule.id}`),
      sourcePort: Number(rule.sourcePort || 0),
      targetIp: String(rule.targetIp || ""),
      targetPort: Number(rule.targetPort || 0),
      managed: !rule.isForwardGroupTemplate,
    })),
  };
}

export async function deleteForwardGroupWithImpact(id: number, confirmRules?: boolean) {
  const group = await db.getForwardGroupById(id);
  if (!group) throw new Error("转发组不存在");
  const impact = await getForwardGroupDeleteImpact(id);
  if (impact.forwardRuleCount > 0 && !confirmRules) {
    throw new Error(`此转发组仍有关联转发规则 ${impact.forwardRuleCount} 条，请确认后再删除`);
  }
  /*
    入口组 / 出口组还被隧道、转发链或端口转发引用时不许删。删了之后那些隧道、转发链的 entryGroupId /
    exitGroupId 还指着一个不存在的组：下发时回落到隧道自己的入口机照常跑，而恢复规则时
    又把「组不存在」当成「组已停用」—— 规则被打上隧道停用、自愈永远清不掉。先让人把
    引用改掉，比留一堆两边说法不一的隧道好。
  */
  const references = await db.getForwardGroupEndpointReferences(id);
  if (references.tunnels.length > 0 || references.chains.length > 0) {
    const names = [
      ...references.tunnels.map((tunnel: any) => `隧道「${tunnel.name || `#${tunnel.id}`}」`),
      ...references.chains.map((chain: any) => `${String(chain.groupMode || "") === "port" ? "端口转发" : "转发链"}「${chain.name || `#${chain.id}`}」`),
    ];
    throw new Error(`还有 ${names.length} 处在用这个组：${names.slice(0, 5).join("、")}${names.length > 5 ? " 等" : ""}。请先把它们改用别的组或删除，再删这个组`);
  }
  await db.deleteForwardGroup(id);
  return { success: true };
}

export async function runForwardGroupChainSelfTest(groupId: number) {
  const group = await db.getForwardGroupById(groupId) as any;
  if (!group) throw new Error("转发链不存在");
  if (String(group.groupMode || "failover") !== "chain") throw new Error("仅转发链支持链路自测");

  const probes = await db.getForwardGroupChainProbes(groupId, { includeFinalTarget: false, method: "ping" });
  if (probes.length === 0) throw new Error("转发链没有可测试的有效链路");

  const batchId = newForwardChainBatchId();
  const testHostIds = new Set<number>();
  const rows = probes.map((probe) => {
    const message = JSON.stringify({
      kind: "forward-chain",
      groupId,
      entryIp: probe.targetIp,
      entrySourcePort: probe.targetPort,
      targetIp: probe.targetIp,
      targetPort: probe.targetPort,
      method: probe.method,
      hopLabel: probe.hopLabel,
      routeLabel: probe.routeLabel,
      batchId,
      runtimeDependent: probe.runtimeDependent,
    });
    testHostIds.add(probe.fromHostId);
    return {
      ruleId: 0,
      hostId: probe.fromHostId,
      userId: Number(group.userId),
      status: "pending",
      listenOk: false,
      targetReachable: false,
      forwardOk: false,
      message,
    } as any;
  });
  const queued = (await db.createForwardTestBatch(batchId, rows)).length;
  appendPanelLog("info", `[SelfTest] forward-chain=${groupId} batch=${batchId} queued segments=${queued} sourceHosts=${testHostIds.size}`);
  for (const hostId of testHostIds) {
    pushAgentRefresh(hostId, "forward-chain-selftest", { urgent: true });
  }
  return { success: false, pending: true, queued };
}
