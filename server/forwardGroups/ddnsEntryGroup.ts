/*
  入口组的解析集合：哪些成员进记录（健康、外部观察、恢复后稳够久、频繁进出暂缓、全挂保留，判定在 evaluate.ts 的
  entryMemberInclusion / planEntryGroupRecordSet）、带宽聚合与按权重解析、共享 TLS 入站还没就绪的成员先不进，
  然后交给 ddnsPublish.ts 写。
*/

import { and, eq, sql } from "drizzle-orm";
import { forwardGroupMembers, forwardGroups, type ForwardRule } from "../../drizzle/schema";
import type { SniReadinessTemplate } from "../tlsInboundReadiness";
import { DEFAULT_DDNS_TTL, type DdnsSettings } from "../ddns";
import { prepareForwardGroupDdnsLines } from "../forwardGroupDdnsLines";
import { getDb, nowDate, queryRaw } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";
import { getForwardGroupTemplateRules } from "../repositories/forwardRuleRepository";
import { getHostsByIds } from "../repositories/hostRepository";
import { getLatestHostMetricSnapshots } from "../repositories/metricsRepository";
import {
  applyAggregationToDdnsValues,
  buildEntryGroupAggregationPlan,
  hostThroughputMbpsFromSnapshots,
  isBandwidthAggregationGroup,
  resolveAggregationSettings,
  type AggregationMemberRow,
} from "../bandwidthAggregation";
import {
  FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS,
  forwardGroupAgentHealthStateAt,
  forwardGroupChinaHealthStateAt,
  nextForwardGroupChinaHealthExpiryAt,
  nextForwardGroupHealthRecheckAt,
} from "../forwardGroupHealthRecheck";
import { notifyForwardGroupSwitch } from "../forwardGroupSwitchNotifier";
import { FORWARD_GROUP_AUTO_SWITCH_EVENT, FORWARD_GROUP_FLAP_WINDOW_MS, forwardGroupFlapHoldAt } from "../forwardGroupFlapHold";
import { recordForwardGroupSwitchEvent } from "../ops/eventHooks";
import { dbBool } from "../repositories/repositoryUtils";
import { entryMemberInclusion, planEntryGroupRecordSet } from "./evaluate";
import { FORWARD_GROUP_READINESS_SAMPLE_GRACE_MS, forwardGroupPanelReadyAt, staleSampleWithinReadinessGrace } from "./readiness";
import { ddnsWeightSupport } from "../ddnsWeightedRecords";
import {
  DDNS_WEIGHT_ADAPTIVE_TOLERANCE,
  ddnsWeightRecordTypeSupported,
  ddnsWeightsEqual,
  ddnsWeightsFromAggregationPlan,
  describeDdnsWeights,
  parseDdnsWeightState,
} from "../../shared/ddnsWeights";
import type { BandwidthAggregationPlan } from "../../shared/bandwidthAggregation";
import { ForwardGroupFailoverOptions, ForwardGroupRecordType, LineGroupRow, LooseRow, forwardGroupFailoverDelayMs, forwardGroupRecoverDelayMs, groupSwitchNotifyEnabled, insertForwardGroupEvent, memberEntryHostId, normalizeForwardGroupRecordType, recordTypeRequirementLabel, sortedMembers, switchNotifySuppressed, toDate, updateForwardGroupRuntimeIfChanged } from "./common";
import { ForwardGroupLineHook, createForwardGroupLineHook, ddnsValueSetSignature, exactDdnsReconciliationDue, memberDdnsValue, publishForwardGroupDdnsValues, rememberExactDdnsReconciliation, syncForwardGroupLinesAfterDefault } from "./ddnsPublish";
import { forwardGroupHealthRechecks, scheduleForwardGroupFailover } from "./evaluateDriver";
import { deferProviderWrite } from "./evaluateScope";
import { evaluateMemberPeerHealth } from "./health";
import { MemberAgentLiveness, agentHealthSampleIsCurrent, resolveMemberAgentLiveness } from "./liveness";

/** 这个组这一轮的记录权重：发不发、发什么、要不要因为权重变了重写一次记录。 */
function resolveEntryGroupDdnsWeighting(
  group: LineGroupRow,
  ddnsSettings: DdnsSettings,
  plan: BandwidthAggregationPlan | null,
  values: string[],
  recordType: ForwardGroupRecordType,
) {
  const previous = parseDdnsWeightState(group.ddnsWeightState);
  const domain = String(group.domain || "").trim().toLowerCase();
  // 上一次的权重是不是写在现在这家服务商、这个名字、这个类型上：不是的话那边的设置面板收不了，只丢掉记的状态。
  const previousHere = previous && previous.provider === ddnsSettings.provider && previous.domain === domain && previous.recordType === recordType ? previous : null;
  const wanted = dbBool(group.ddnsWeightEnabled)
    && isBandwidthAggregationGroup(group)
    && ddnsWeightRecordTypeSupported(recordType)
    && ddnsWeightSupport(ddnsSettings).supported;
  let weights = wanted ? ddnsWeightsFromAggregationPlan(plan, values) : null;
  if (weights && previousHere) {
    // 「按剩余带宽」的份额跟着实时流量动：变化在死区里就沿用上一次发出去的权重，不为这点变化改记录。
    const tolerance = resolveAggregationSettings(group).strategy === "adaptive" ? DDNS_WEIGHT_ADAPTIVE_TOLERANCE : 0;
    if (ddnsWeightsEqual(previousHere.weights, weights, tolerance)) weights = previousHere.weights;
  }
  const clearWeights = !weights && !!previousHere;
  return {
    weights,
    clearWeights,
    /** 值的集合没变也要写一次服务商（权重变了、或者要把权重收掉）。 */
    writeNeeded: weights ? !previousHere || !ddnsWeightsEqual(previousHere.weights, weights) : clearWeights,
    nextState: weights ? JSON.stringify({ provider: ddnsSettings.provider, domain, recordType, weights }) : null,
    note: weights ? `；按权重解析 ${describeDdnsWeights(weights, values)}` : "",
  };
}

/** Live uplink throughput, in Mbps, for the hosts behind a set of members. */
export async function memberThroughputMbps(members: AggregationMemberRow[]) {
  const hostIds = Array.from(new Set(members
    .map((member) => Number(member.hostId || 0))
    .filter((hostId) => Number.isInteger(hostId) && hostId > 0)));
  if (hostIds.length === 0) return new Map<number, number>();
  const snapshots = await getLatestHostMetricSnapshots(hostIds).catch(() => []);
  return hostThroughputMbpsFromSnapshots(snapshots as any[]);
}

/**
 * Build the bandwidth aggregation plan for an entry group and apply it to the
 * DDNS values about to be published.
 *
 * Returns `null` for groups that did not opt into aggregation so the caller
 * keeps its existing behaviour untouched.
 */
/** 成员上没填「上行 Mbps」时，用主机上的「线路带宽」（一台机器只填一处）。 */
export async function withHostLineBandwidth<T extends { hostId: number; bandwidthMbps?: number | null }>(members: T[]): Promise<T[]> {
  const missing = Array.from(new Set(members.filter((member) => !(Number(member.bandwidthMbps) > 0) && member.hostId > 0).map((member) => member.hostId)));
  if (missing.length === 0) return members;
  const rows = await getHostsByIds(missing).catch(() => []) as any[];
  const lineById = new Map(rows.map((row) => [Number(row.id), Math.max(0, Number(row.lineBandwidthMbps) || 0)]));
  return members.map((member) => (Number(member.bandwidthMbps) > 0 || !lineById.get(member.hostId)
    ? member
    : { ...member, bandwidthMbps: lineById.get(member.hostId)! }));
}

async function resolveEntryGroupAggregation(
  group: any,
  members: AggregationMemberRow[],
  values: string[],
  recordType: ForwardGroupRecordType,
) {
  if (!isBandwidthAggregationGroup(group) || members.length === 0 || values.length === 0) return null;
  members = await withHostLineBandwidth(members);
  // The adaptive strategy is the only one that needs live throughput, so the
  // extra metric read is skipped for the static strategies.
  const strategy = resolveAggregationSettings(group).strategy;
  const throughputByHostId = strategy === "adaptive"
    ? await memberThroughputMbps(members)
    : new Map<number, number>();
  const plan = buildEntryGroupAggregationPlan({
    group,
    members,
    throughputByHostId,
    singleValuePerMember: recordType === "CNAME",
  });
  const applied = applyAggregationToDdnsValues(plan, values);
  return { ...applied, plan };
}

/*
  共享 TLS 入站（SNI 分流）：组里有 SNI 规则时，DDNS 只切到 SNI 配置已确认的成员（判断见
  server/tlsInboundReadiness.ts）。当前在用的成员不在这里被撤掉：面板刚重启时谁都还没确认，
  不能因此把正在用的入口切走。没确认的成员记一条事件（同样的原因不重复记）。
*/
const sniBlockedEventByMember = new Map<number, string>();

export async function sniReadyGroupCandidates<M extends { id: unknown }>(
  group: { id: unknown; activeMemberId?: unknown },
  templates: readonly SniReadinessTemplate[],
  candidates: M[],
): Promise<M[]> {
  const { activeSniTemplates, filterSniReadyCandidates } = await import("../tlsInboundReadiness");
  if (activeSniTemplates(templates).length === 0) return candidates;
  const { ready, blocked } = await filterSniReadyCandidates({
    candidates,
    keepMemberId: group?.activeMemberId,
    templates,
    hostIdOf: (member) => memberEntryHostId(member),
  });
  for (const { member, reason } of blocked) {
    const memberId = Number(member.id);
    if (sniBlockedEventByMember.get(memberId) === reason) continue;
    if (sniBlockedEventByMember.size >= 4096) sniBlockedEventByMember.clear();
    sniBlockedEventByMember.set(memberId, reason);
    await insertForwardGroupEvent(Number(group.id), memberId, "sni-not-ready", `共享 TLS 入站未就绪，暂不切到这个成员：${reason}`).catch(() => undefined);
  }
  for (const member of ready) sniBlockedEventByMember.delete(Number(member.id));
  return ready;
}

/** 入口组本身没有模板：看挂着它的端口转发 / 转发链里的 SNI 模板。 */
async function sniTemplatesUsingEntryGroup(entryGroupId: number) {
  const db = await getDb();
  if (!db) return [] as ForwardRule[];
  const dependents = await db.select({ id: forwardGroups.id }).from(forwardGroups)
    .where(and(eq(forwardGroups.entryGroupId, Number(entryGroupId)), sql`${forwardGroups.id} <> ${Number(entryGroupId)}`));
  const templates: ForwardRule[] = [];
  for (const dependent of dependents) {
    for (const template of await getForwardGroupTemplateRules(Number(dependent.id))) {
      if (Number(template?.tlsInboundId || 0) > 0) templates.push(template);
    }
  }
  return templates;
}

export async function syncEntryGroupDdns(group: any, ddnsSettings: any, options: ForwardGroupFailoverOptions = {}) {
  const lineCtx = prepareForwardGroupDdnsLines(group, ddnsSettings);
  if (!lineCtx) return syncEntryGroupDefaultDdns(group, ddnsSettings, options, null);
  const hook = createForwardGroupLineHook(group, lineCtx);
  await syncEntryGroupDefaultDdns(group, ddnsSettings, options, hook);
  if (hook.settled) await syncForwardGroupLinesAfterDefault(group, ddnsSettings, hook, "multi", options);
}

/** 这个组最近一小时每个成员的自动进出（auto-switch 事件，按成员分）：入口组的抖动抑制按成员算。 */
async function forwardGroupAutoSwitchTimesByMember(groupId: number, nowMs: number) {
  const sinceSeconds = Math.floor((nowMs - FORWARD_GROUP_FLAP_WINDOW_MS) / 1000);
  const rows = await queryRaw<{ memberId: unknown; createdAt: unknown }>(
    `SELECT ${quoteIdentifier("memberId")}, ${quoteIdentifier("createdAt")} FROM ${quoteIdentifier("forward_group_events")}
      WHERE ${quoteIdentifier("groupId")} = ? AND ${quoteIdentifier("type")} = ? AND ${quoteIdentifier("createdAt")} >= ?`,
    [groupId, FORWARD_GROUP_AUTO_SWITCH_EVENT, sinceSeconds],
  ).catch(() => []);
  const byMember = new Map<number, number[]>();
  for (const row of rows) {
    const memberId = Number(row.memberId || 0);
    const at = toDate(row.createdAt)?.getTime() || 0;
    if (!(memberId > 0) || !(at > 0)) continue;
    const list = byMember.get(memberId);
    if (list) list.push(at);
    else byMember.set(memberId, [at]);
  }
  return byMember;
}

/*
  入口组一个健康成员都没有时怎么办（plan 来自 evaluate.ts 的 planEntryGroupRecordSet）：

    · hold-all：保留上一轮发布的整组，不动服务商（只有保留下来的集合和上一轮不一样、或者这个进程还没和
      服务商对过账时才写一次）。以前缩成 lastDdnsValue 的第一条。
    · empty：成员全部被管理动作排除（流量到阈值）—— 清掉记录，记一条事件。
    · none：没有上一轮可保留，什么都不改。
*/
async function holdEntryGroupDdns(
  group: LineGroupRow,
  ddnsSettings: DdnsSettings,
  options: ForwardGroupFailoverOptions,
  plan: ReturnType<typeof planEntryGroupRecordSet>,
  reason: string,
) {
  const db = await getDb();
  const groupId = Number(group.id);
  const domain = String(group.domain || "").trim();
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const previousValue = String(group.lastDdnsValue || "").trim();
  const ddnsReady = ddnsSettings.enabled && ddnsSettings.provider !== "disabled";
  const ttl = Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL);
  const previousWeights = parseDdnsWeightState(group.ddnsWeightState);
  const weightsHere = previousWeights && previousWeights.provider === ddnsSettings.provider
    && previousWeights.domain === domain.toLowerCase() && previousWeights.recordType === recordType ? previousWeights.weights : null;

  if (plan.mode === "empty") {
    if ((previousValue || options.forceSync) && ddnsReady && domain) {
      if (deferProviderWrite()) return "deferred" as const;
      await publishForwardGroupDdnsValues(group, { groupId, domain, recordType, values: [], ttl }, { clearWeights: !!weightsHere }).catch((error) => {
        console.warn(`[ForwardGroup] removing traffic-excluded DDNS values failed group=${groupId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await updateForwardGroupRuntimeIfChanged(db, group, {
      activeMemberId: null,
      lastDdnsValue: null,
      ddnsWeightState: null,
      lastStatus: "down",
      lastMessage: "没有可用成员：流量到阈值的主机已暂停参与，等流量重置或关闭流量故障转移后恢复",
    });
    if (previousValue) {
      await insertForwardGroupEvent(groupId, null, "ddns-empty", `入口组的成员全部因流量到阈值被暂停，解析记录已清空；domain=${domain || "-"} type=${recordType} 原记录=${previousValue}`);
    }
    return;
  }
  if (plan.mode === "none") {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "down",
      lastMessage: ddnsReady ? `${reason}；无法确定保底地址，未修改服务商解析` : `${reason}；无法确定保底地址，未修改解析`,
    });
    return;
  }

  const retained = plan.values;
  const joined = retained.join(",");
  const partial = ddnsValueSetSignature(joined) !== ddnsValueSetSignature(previousValue);
  const holdMessage = `${reason}；${partial ? "保留未超量的入口" : "全部入口都不健康，保留上一轮发布的"} ${retained.length} 条解析，等待成员恢复`;
  if (!ddnsReady) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastDdnsValue: joined,
      lastStatus: "down",
      lastMessage: `${holdMessage}（系统 DDNS 未启用）`,
    });
    return;
  }
  if (!partial && !options.forceSync && !exactDdnsReconciliationDue(group, joined)) {
    await updateForwardGroupRuntimeIfChanged(db, group, { lastStatus: "down", lastMessage: holdMessage });
    return;
  }
  // 保留下来的值之前带着权重就原样带着（集合里每个值都有、而且不止一条）；凑不齐就把权重收掉。
  const heldWeights = weightsHere && retained.length >= 2 && retained.every((value) => value in weightsHere)
    ? Object.fromEntries(retained.map((value) => [value, weightsHere[value]]))
    : null;
  if (deferProviderWrite()) return "deferred" as const;
  try {
    await publishForwardGroupDdnsValues(group, { groupId, domain, recordType, values: retained, ttl }, { weights: heldWeights, clearWeights: !heldWeights && !!weightsHere });
    rememberExactDdnsReconciliation(group, joined);
    await db.update(forwardGroups).set({
      lastDdnsValue: joined,
      ddnsWeightState: heldWeights ? JSON.stringify({ provider: ddnsSettings.provider, domain: domain.toLowerCase(), recordType, weights: heldWeights }) : null,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "down",
      lastMessage: holdMessage,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, groupId));
    await insertForwardGroupEvent(groupId, null, "ddns-hold", `没有健康入口，保留 ${retained.length} 条 DDNS 解析；domain=${domain} type=${recordType} values=${joined}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(forwardGroups).set({
      lastStatus: "error",
      lastMessage: `${reason}；保留服务商解析失败：${message}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, groupId));
    await insertForwardGroupEvent(groupId, null, "ddns-error", `保留 DDNS 解析失败：${message}；domain=${domain} type=${recordType} values=${joined}`);
    throw error;
  }
}

/*
  国内检测「原始结果连得上」是从什么时候开始的（面板看到的，进程内存）。成员 Agent 自己要连续正常满
  recoverSeconds 才报 healthy，但它重启后状态是空的，第一个正常样本就报 healthy —— 入口组把成员加回来
  之前要「连续健康满 recoverSeconds」，这段时间只认面板自己看到的：Agent 稳了一阵才报的 healthy，
  面板这边早就在数了，不用再等一遍；Agent 刚重启就报的，从现在数起。
*/
export const chinaReachableSinceByMember = new Map<number, number>();

async function syncEntryGroupDefaultDdns(group: LineGroupRow, ddnsSettings: DdnsSettings, options: ForwardGroupFailoverOptions = {}, lines: ForwardGroupLineHook | null = null) {
  const db = await getDb();
  const members = sortedMembers(group, true) as any[];
  const sniTemplates = await sniTemplatesUsingEntryGroup(Number(group.id));
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const forceSync = !!options.forceSync;
  const previousValue = String(group.lastDdnsValue || "").trim();
  const previousValues = new Set(previousValue.split(",").map((value) => value.trim()).filter(Boolean));
  const values: string[] = [];
  const excluded: string[] = [];
  const quotaExcludedValues: string[] = [];
  const healthWindows: any[] = [];
  const initialHealthSnapshot = new Map<number, string>();
  const initialAgentLivenessSnapshot = new Map<number, string>();
  const agentLivenessByMemberId = new Map<number, MemberAgentLiveness>();
  const pendingHealthExpiryCandidates: number[] = [];
  let activeMemberId: number | null = null;
  const chinaHealthEnabled = dbBool(group.chinaHealthCheckEnabled);
  const chinaHealthNow = Date.now();
  const healthNow = new Date(chinaHealthNow);
  const failoverMs = forwardGroupFailoverDelayMs(group);
  const recoverMs = forwardGroupRecoverDelayMs(group);
  let pendingAgentHealth = false;
  let trafficExcludedMemberCount = 0;
  let valuedMemberCount = 0;
  // 状态消息里要说清楚的几种「健康却没在解析里 / 不健康却还在」：
  let recoveringCount = 0;
  let flapHeldCount = 0;
  let externalKeptCount = 0;
  let externalDownCount = 0;
  let peerObservedCount = 0;
  // 这一轮因为健康变化自动拿掉 / 加回的成员：发布成功后各记一条 auto-switch（抖动抑制按它计数）。
  const autoChanges: Array<{ memberId: number; kind: "removed" | "added" }> = [];
  // 健康、但还在等恢复观察 / 被抖动抑制压着的成员：解析里一个健康的都没有时不等了，直接加回（逃生，见循环后面）。
  const heldHealthy: Array<{ member: LooseRow; value: string }> = [];
  let autoSwitchTimesByMember: Map<number, number[]> | null = null;
  const flapHoldUntilFor = async (memberId: number) => {
    // 人工操作不受抖动抑制限制（和主备组一样）。
    if (options.manual || options.forcePriority) return 0;
    if (!autoSwitchTimesByMember) autoSwitchTimesByMember = await forwardGroupAutoSwitchTimesByMember(Number(group.id), chinaHealthNow);
    return forwardGroupFlapHoldAt(autoSwitchTimesByMember.get(memberId) || [], chinaHealthNow).untilMs;
  };
  // Bandwidth aggregation needs the member behind every published value so it
  // can weight the records by each front VPS's declared uplink.
  const aggregationMembers: AggregationMemberRow[] = [];
  const includeMember = (member: any, value: string) => {
    if (!values.includes(value)) {
      values.push(value);
      if (!activeMemberId) activeMemberId = Number(member.id || 0) || null;
    }
    if (!aggregationMembers.some((entry) => entry.memberId === Number(member.id || 0))) {
      aggregationMembers.push({
        memberId: Number(member.id || 0),
        hostId: Number(member.hostId || 0),
        value,
        healthy: true,
        bandwidthMbps: Number(member.bandwidthMbps || 0),
        aggregationWeight: Number(member.aggregationWeight || 0),
      });
    }
  };
  for (const member of members) {
    if (member.memberType !== "host") continue;
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (!value) {
      lines?.note(member, "", "down");
      continue;
    }
    valuedMemberCount += 1;
    const previouslyIncluded = previousValues.has(value) || !!lines?.previouslyPublished.has(value);
    // SNI：还没解析到它的成员，SNI 配置没确认就先不加进来（已经在解析里的照旧按健康度判断）。
    if (!previouslyIncluded && sniTemplates.length > 0
      && (await sniReadyGroupCandidates({ id: group.id, activeMemberId: null }, sniTemplates, [member])).length === 0) {
      if (!excluded.includes(value)) excluded.push(value);
      // 分线路那边也只当「还在等」：不在任何线路的解析里，就不会被加进去
      lines?.note(member, value, "pending");
      continue;
    }
    const liveness = await resolveMemberAgentLiveness(member, chinaHealthNow);
    const memberId = Number(member.id);
    initialAgentLivenessSnapshot.set(memberId, liveness.signature);
    agentLivenessByMemberId.set(memberId, liveness);
    if (liveness.trafficExcluded) {
      // 流量到阈值：立刻移出解析，不走离线宽限期。
      trafficExcludedMemberCount += 1;
      if (!excluded.includes(value)) excluded.push(value);
      if (!quotaExcludedValues.includes(value)) quotaExcludedValues.push(value);
      lines?.note(member, value, "quota");
      continue;
    }
    const checkedAt = chinaHealthEnabled ? member.chinaHealthCheckedAt : member.lastCheckedAt;
    const storedStatus = chinaHealthEnabled ? member.chinaHealthStatus : member.healthStatus;
    initialHealthSnapshot.set(
      memberId,
      `${String(storedStatus || "unknown")}:${toDate(checkedAt)?.getTime() || 0}`,
    );
    // 外部观察：别的机器看这台入口的端口通不通（没安排观察点是 null，只看成员自己的报告）。
    const peerHealth = await evaluateMemberPeerHealth(group, member, liveness.agentOnline, chinaHealthNow);
    const external = peerHealth?.decision || null;
    if (peerHealth) peerObservedCount += 1;
    if (!liveness.available && external?.reachableWhileAgentOffline) {
      // 面板连不上这台的 Agent，但观察点连得上它的入口：已经在解析里的继续留着（它的健康记录不动）；不在的不加。
      if (previouslyIncluded) {
        includeMember(member, value);
        externalKeptCount += 1;
      } else if (!excluded.includes(value)) {
        excluded.push(value);
      }
      lines?.note(member, value, "pending");
      if (recordType === "CNAME" && previouslyIncluded && !lines) break;
      continue;
    }
    let observedFailureSince: Date | null = null;
    let healthStatus = !liveness.available
      ? "offline"
      : !agentHealthSampleIsCurrent(liveness, checkedAt)
        ? "pending"
        : chinaHealthEnabled
          ? forwardGroupChinaHealthStateAt(member, chinaHealthNow)
          : forwardGroupAgentHealthStateAt(member, chinaHealthNow);
    if (!liveness.available) observedFailureSince = liveness.failureSince || healthNow;
    if (healthStatus === "stale" && staleSampleWithinReadinessGrace(toDate(checkedAt)?.getTime(), chinaHealthNow)) {
      // 面板刚启动 / 数据库刚恢复：停机期间没人收样本，样本过期不算故障，等新样本。
      healthStatus = "pending";
      pendingHealthExpiryCandidates.push(forwardGroupPanelReadyAt() + FORWARD_GROUP_READINESS_SAMPLE_GRACE_MS);
    }
    if (healthStatus === "pending" && (!toDate(checkedAt) || !agentHealthSampleIsCurrent(liveness, checkedAt))) {
      const waitingSince = liveness.lastOfflineAt
        ? new Date(liveness.lastOfflineAt)
        : toDate(member.updatedAt) || toDate(member.createdAt) || toDate(group.updatedAt) || toDate(group.createdAt) || new Date(chinaHealthNow);
      const expiresAt = waitingSince.getTime() + FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS;
      if (chinaHealthNow >= expiresAt) {
        healthStatus = "stale";
        observedFailureSince = new Date(expiresAt);
      }
      else pendingHealthExpiryCandidates.push(expiresAt);
    }
    if (healthStatus === "pending") {
      // 分线路时只有默认线路上的成员在等结果才让默认线路等；线路成员的等待由线路规划自己处理。
      if (!lines || lines.defaultMemberIds.has(memberId)) pendingAgentHealth = true;
      if (previouslyIncluded) includeMember(member, value);
      lines?.note(member, value, "pending");
      if (recordType === "CNAME" && previouslyIncluded && !lines) break;
      continue;
    }

    let healthy = healthStatus === "healthy";
    let failureFinal = false;
    let externallyUnhealthy = false;
    if (healthy && external && (external.state === "failing" || external.state === "down")) {
      // 成员自己报告正常，但别的机器连不上它的入口端口：访客也连不上。持续满观察时间（failingSince 起算）就拿掉。
      healthy = false;
      externallyUnhealthy = true;
      observedFailureSince = external.failingSince ? new Date(external.failingSince) : healthNow;
      failureFinal = external.down;
      if (external.down) externalDownCount += 1;
    }
    if (!healthy && !observedFailureSince) {
      const observedAt = toDate(checkedAt);
      if (observedAt) {
        const failureAt = healthStatus === "stale"
          ? observedAt.getTime() + FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS
          : observedAt.getTime();
        observedFailureSince = new Date(Math.min(chinaHealthNow, failureAt));
      }
    }
    const previousFailureSince = toDate(member.failureSince);
    const previousHealthySince = toDate(member.healthySince);
    // 从没出过问题的新成员（新建的组、刚加进来的机器）不用等恢复观察时间。
    const neverFailed = !previousFailureSince && !previousHealthySince && String(member.healthStatus || "unknown") !== "unhealthy";
    const inclusionInput = {
      health: healthy ? "healthy" as const : "unhealthy" as const,
      previouslyIncluded,
      neverFailed,
      previousFailureSince: previousFailureSince?.getTime() ?? null,
      previousHealthySince: previousHealthySince?.getTime()
        ?? (!neverFailed && chinaHealthEnabled ? chinaReachableSinceByMember.get(memberId) ?? null : null),
      observedFailureSince: observedFailureSince?.getTime() ?? null,
      restoredAt: liveness.lastRestoredAt,
      failureFinal,
      failoverMs,
      recoverMs,
      now: chinaHealthNow,
    };
    let decision = entryMemberInclusion(inclusionInput);
    // 恢复够久、正要加回来的成员才去查抖动抑制（一小时内自动进出三次以上要多等）。
    if (decision.include && healthy && !previouslyIncluded && !neverFailed) {
      const flapHoldUntil = await flapHoldUntilFor(memberId);
      if (flapHoldUntil > chinaHealthNow) decision = entryMemberInclusion({ ...inclusionInput, flapHoldUntil });
    }
    const failureSince = decision.failureSince !== null ? new Date(decision.failureSince) : null;
    const healthySince = decision.healthySince !== null ? new Date(decision.healthySince) : null;
    const include = decision.include;

    const sameTime = (left: unknown, right: Date | null) => (toDate(left)?.getTime() ?? null) === (right?.getTime() ?? null);
    /*
      不开国内检测时 healthStatus 这一列同时是「成员 Agent 自己报的」：只因为外部观察才判不健康的，不把它改掉
      （改了下一轮就读不到 Agent 报的是健康了，外部观察恢复后也回不来，要等 Agent 下一次上报才改回去）。
      故障 / 恢复的计时照常写。
    */
    const nextHealthStatus = healthy
      ? "healthy"
      : externallyUnhealthy && !chinaHealthEnabled ? String(member.healthStatus || "healthy") : "unhealthy";
    if (
      String(member.healthStatus || "unknown") !== nextHealthStatus
      || !sameTime(member.failureSince, failureSince)
      || !sameTime(member.healthySince, healthySince)
    ) {
      await db.update(forwardGroupMembers).set({
        healthStatus: nextHealthStatus,
        failureSince,
        healthySince,
        updatedAt: healthNow,
      } as any).where(eq(forwardGroupMembers.id, member.id));
      // 这一列是评估自己刚改的，不算「评估期间来了新的上报」：发布前核对时按改后的比。
      if (!chinaHealthEnabled) initialHealthSnapshot.set(memberId, `${nextHealthStatus}:${toDate(checkedAt)?.getTime() || 0}`);
    }

    if (decision.holdReason === "recovering") recoveringCount += 1;
    if (decision.holdReason === "flap") flapHeldCount += 1;
    if (decision.holdReason) heldHealthy.push({ member, value });
    if (decision.recheckAt) pendingHealthExpiryCandidates.push(decision.recheckAt);
    if (include) includeMember(member, value);
    else if (!excluded.includes(value)) excluded.push(value);
    if (previouslyIncluded && !include) autoChanges.push({ memberId, kind: "removed" });
    if (!previouslyIncluded && include && !neverFailed) autoChanges.push({ memberId, kind: "added" });
    // 健康但还在观察 / 被抖动抑制压着的成员，分线路那边只当「还在等」（不新加进线路）。
    lines?.note(member, value, include ? "up" : healthy ? "pending" : "down");
    healthWindows.push({
      healthy,
      failureSince,
      healthySince,
      failedLongEnough: decision.failedLongEnough,
      // 等恢复观察 / 抖动抑制的到点时间已经单独排了（decision.recheckAt），这里不再按 healthySince 重复排。
      recoveredLongEnough: true,
    });
    // 分线路时每条线路各取一个 CNAME，得把所有成员都评估完。
    if (recordType === "CNAME" && include && !lines) break;
  }
  /*
    逃生：这一轮解析里一个成员都留不下（全挂），而有成员已经恢复健康、只是还在等观察时间或被抖动抑制压着 ——
    不等了，直接把它们加回来。恢复观察和抖动抑制是防「好了又坏」来回改解析的，前提是解析里还有别的入口能用；
    宁可多改一次，也不能让域名只指着一批坏的入口（主备组同理：当前成员不可用时换人不受这两样限制）。
  */
  if (values.length === 0 && heldHealthy.length > 0) {
    for (const held of heldHealthy) {
      includeMember(held.member, held.value);
      const index = excluded.indexOf(held.value);
      if (index >= 0) excluded.splice(index, 1);
      autoChanges.push({ memberId: Number(held.member.id), kind: "added" });
      if (recordType === "CNAME" && !lines) break;
    }
    recoveringCount = 0;
    flapHeldCount = 0;
  }
  const healthWindowRecheckAt = nextForwardGroupHealthRecheckAt({
    members: healthWindows,
    failoverMs,
    recoverMs,
    now: chinaHealthNow,
  });
  const expiryEligibleMembers = members.filter((member: any) => {
    const liveness = agentLivenessByMemberId.get(Number(member.id));
    const checkedAt = chinaHealthEnabled ? member.chinaHealthCheckedAt : member.lastCheckedAt;
    return !!liveness?.available && agentHealthSampleIsCurrent(liveness, checkedAt);
  });
  const healthExpiryAt = chinaHealthEnabled
    ? nextForwardGroupChinaHealthExpiryAt({ enabled: true, members: expiryEligibleMembers, now: chinaHealthNow })
    : expiryEligibleMembers
      .filter((member: any) => forwardGroupAgentHealthStateAt(member, chinaHealthNow) === "healthy")
      .map((member: any) => (toDate(member.lastCheckedAt)?.getTime() || 0) + FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS)
      .filter((value: number) => value > chinaHealthNow)
      .sort((left: number, right: number) => left - right)[0] ?? null;
  const pendingHealthExpiryAt = pendingHealthExpiryCandidates
    .filter((value) => value > chinaHealthNow)
    .sort((left, right) => left - right)[0] ?? null;
  const nextHealthRecheckAt = [healthWindowRecheckAt, healthExpiryAt, pendingHealthExpiryAt]
    .filter((value): value is number => typeof value === "number" && value > chinaHealthNow)
    .sort((left, right) => left - right)[0] ?? null;
  forwardGroupHealthRechecks.replace(Number(group.id), nextHealthRecheckAt);
  const agentSelectionStillCurrent = async () => {
    for (const member of members) {
      const initial = initialAgentLivenessSnapshot.get(Number(member.id));
      if (initial === undefined) continue;
      const current = await resolveMemberAgentLiveness(member);
      if (current.signature !== initial) return false;
    }
    if (initialHealthSnapshot.size > 0) {
      const currentRows = await db.select({
        id: forwardGroupMembers.id,
        healthStatus: forwardGroupMembers.healthStatus,
        lastCheckedAt: forwardGroupMembers.lastCheckedAt,
        chinaHealthStatus: forwardGroupMembers.chinaHealthStatus,
        chinaHealthCheckedAt: forwardGroupMembers.chinaHealthCheckedAt,
      }).from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, Number(group.id)));
      const seen = new Set<number>();
      for (const member of currentRows as any[]) {
        const memberId = Number(member.id);
        const initial = initialHealthSnapshot.get(memberId);
        if (initial === undefined) continue;
        seen.add(memberId);
        const currentStatus = chinaHealthEnabled ? member.chinaHealthStatus : member.healthStatus;
        const currentCheckedAt = chinaHealthEnabled ? member.chinaHealthCheckedAt : member.lastCheckedAt;
        const current = `${String(currentStatus || "unknown")}:${toDate(currentCheckedAt)?.getTime() || 0}`;
        if (current !== initial) return false;
      }
      if (seen.size !== initialHealthSnapshot.size) return false;
    }
    return true;
  };
  const retryChangedAgentSelection = () => {
    scheduleForwardGroupFailover([Number(group.id)]);
  };
  if (lines) {
    // 分线路：默认线路只发布默认线路上的成员（server/ddnsLinePlanner.ts 规则 1），其余交给线路发布。
    const kept = aggregationMembers.filter((entry) => lines.defaultMemberIds.has(entry.memberId));
    aggregationMembers.splice(0, aggregationMembers.length, ...kept);
    const keptValues = Array.from(new Set(kept.map((entry) => entry.value)));
    values.splice(0, values.length, ...(recordType === "CNAME" ? keptValues.slice(0, 1) : keptValues));
    activeMemberId = kept[0]?.memberId || null;
  }
  // Bandwidth aggregation reorders the healthy entries so the front VPS hosts
  // with the most spare uplink are offered to clients first. It never adds or
  // removes an entry, so the health decisions above still stand.
  const aggregation = await resolveEntryGroupAggregation(group, aggregationMembers, values, recordType)
    .catch(() => null);
  const publishedValues = aggregation?.values ?? values;
  const aggregationSuffix = aggregation?.applied ? `；${aggregation.note}` : "";

  const joined = publishedValues.join(",");
  const excludedSuffix = excluded.length > 0 ? `；已临时剔除 ${excluded.length} 个不健康入口` : "";
  // 健康却没在解析里、面板连不上却还在的，各说一句原因。没有这些情况时是空串，状态消息和以前一样。
  const holdSuffix = [
    recoveringCount > 0 ? `；${recoveringCount} 个入口已恢复，持续正常 ${Math.round(recoverMs / 1000)} 秒后加回` : "",
    flapHeldCount > 0 ? `；${flapHeldCount} 个入口一小时内频繁进出，暂缓加回（抖动抑制）` : "",
    externalKeptCount > 0 ? `；${externalKeptCount} 个入口面板连不上但访客可达，继续发布` : "",
    externalDownCount > 0 ? `；${externalDownCount} 个入口外部观察连不上，已按不可用处理` : "",
  ].join("");
  const addedValues = publishedValues.filter((value) => !previousValues.has(value));
  const nextValues = new Set(publishedValues);
  const removedValues = Array.from(previousValues).filter((value) => !nextValues.has(value));

  // A newly enabled health check starts with unknown member states.  Keep the
  // current provider record intact until at least one probe result arrives;
  // once results exist, only healthy members are emitted above.
  if (trafficExcludedMemberCount === 0 && pendingAgentHealth && (publishedValues.length === 0 || joined === previousValue)) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "unknown",
      lastMessage: "等待 Agent 健康度检测结果；暂不变更现有 DDNS 解析",
    });
    if (lines) lines.settled = true;
    return;
  }

  if (!String(group.domain || "").trim()) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "error",
      lastMessage: "入口组需要指定入口域名。",
    });
    return;
  }
  if (!(await agentSelectionStillCurrent())) {
    retryChangedAgentSelection();
    return;
  }
  if (publishedValues.length === 0) {
    const requirement = recordTypeRequirementLabel(recordType);
    const reason = excluded.length > 0 ? `入口组没有健康的${requirement}` : `入口组没有可用${requirement}`;
    if (group.ddnsAutoResolveEnabled === false) {
      await updateForwardGroupRuntimeIfChanged(db, group, {
        activeMemberId: null,
        lastStatus: "down",
        lastMessage: `${reason}；自动解析已关闭，请手动清理解析`,
      });
    } else {
      const held = await holdEntryGroupDdns(group, ddnsSettings, options, planEntryGroupRecordSet({
        healthyValues: [],
        previousValues: Array.from(previousValues),
        administrativelyExcludedValues: quotaExcludedValues,
        allAdministrativelyExcluded: valuedMemberCount > 0 && trafficExcludedMemberCount >= valuedMemberCount,
      }), reason);
      if (held !== "deferred" && lines) lines.settled = true;
    }
    return;
  }

  if (group.ddnsAutoResolveEnabled === false) {
    const changed = await updateForwardGroupRuntimeIfChanged(db, group, {
      activeMemberId,
      lastDdnsValue: joined,
      lastStatus: "healthy",
      lastMessage: `自动解析已关闭；请手动将 ${String(group.domain || "-")} 解析到 ${publishedValues.join(", ")}${excludedSuffix}${aggregationSuffix}${holdSuffix}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, null, "ddns-skip", `入口组自动解析已关闭；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}`);
    return;
  }
  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    const changed = await updateForwardGroupRuntimeIfChanged(db, group, {
      activeMemberId,
      lastDdnsValue: joined,
      lastStatus: "healthy",
      lastMessage: `系统 DDNS 未启用；建议入口 ${publishedValues.join(", ")}${excludedSuffix}${aggregationSuffix}${holdSuffix}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, null, "ddns-skip", `入口组 DDNS 未启用；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}`);
    return;
  }

  // 按权重解析（开了、服务商支持、聚合生效时才有权重；否则 weights 是 null，下面和以前一样）。
  const weighting = resolveEntryGroupDdnsWeighting(group, ddnsSettings, aggregation?.plan || null, publishedValues, recordType);
  const peerSuffix = peerObservedCount > 0 && externalDownCount === 0 && externalKeptCount === 0 ? `；外部观察 ${peerObservedCount} 个入口` : "";

  // A DNS record set is unordered at the provider, so only a change in the set
  // itself is worth a write. Comparing the sorted values keeps an aggregation
  // reorder from re-pushing the same records on every sync.
  if (!forceSync && ddnsValueSetSignature(previousValue) === ddnsValueSetSignature(joined) && !exactDdnsReconciliationDue(group, joined) && !weighting.writeNeeded) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "healthy",
      lastMessage: `入口组 DDNS 已是最新；${publishedValues.length} 个入口${excludedSuffix}${aggregationSuffix}${weighting.note}${holdSuffix}${peerSuffix}`,
      // 记着的权重状态对不上现在的服务商 / 域名了（没法去那边收）：只把状态丢掉。
      ...(String(group.ddnsWeightState ?? "") !== String(weighting.nextState ?? "") ? { ddnsWeightState: weighting.nextState } : {}),
    });
    if (lines) lines.settled = true;
    return;
  }

  if (!(await agentSelectionStillCurrent())) {
    retryChangedAgentSelection();
    return;
  }
  if (deferProviderWrite()) return;
  try {
    await publishForwardGroupDdnsValues(group, {
      groupId: Number(group.id),
      domain: String(group.domain || ""),
      recordType,
      values: publishedValues,
      ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL),
    }, { weights: weighting.weights, clearWeights: weighting.clearWeights });
    if (!(await agentSelectionStillCurrent())) {
      retryChangedAgentSelection();
      return;
    }
    rememberExactDdnsReconciliation(group, joined);
    await db.update(forwardGroups).set({
      activeMemberId,
      lastDdnsValue: joined,
      ddnsWeightState: weighting.nextState,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "healthy",
      lastMessage: `入口组 DDNS 已同步 ${publishedValues.length} 个入口${excludedSuffix}${aggregationSuffix}${weighting.note}${holdSuffix}${peerSuffix}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, null, "ddns-update", `入口组 DDNS 已同步；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}${weighting.note}${forceSync ? " force=true" : ""}`);
    if (lines) lines.settled = true;
    if (!forceSync && !options.manual && !options.forcePriority) {
      // 自动进出各记一笔（抖动抑制按成员计数）。写事件失败不影响已经发布的解析。
      for (const change of autoChanges) {
        await insertForwardGroupEvent(Number(group.id), change.memberId, FORWARD_GROUP_AUTO_SWITCH_EVENT, change.kind === "removed" ? "自动剔除：入口异常达到故障观察时间" : "自动加回：入口恢复达到稳定观察时间")
          .catch((error) => console.warn(`[ForwardGroup] auto-switch event failed group=${group.id}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    if (previousValue && previousValue !== joined) recordForwardGroupSwitchEvent({ group, mode: "entry", toLabel: `${values.length} 个健康入口`, reason: `新增 ${addedValues.length} 个、剔除 ${removedValues.length} 个` }); // 事件时间线
    if (groupSwitchNotifyEnabled(group) && !switchNotifySuppressed(options) && previousValue && previousValue !== joined) {
      void notifyForwardGroupSwitch({
        groupId: Number(group.id),
        groupName: String(group.name || "入口组"),
        groupMode: "entry",
        domain: String(group.domain || ""),
        recordType,
        fromLabel: "原入口集合",
        fromValue: previousValue,
        toLabel: `${values.length} 个健康入口`,
        toValue: joined,
        reason: removedValues.length > 0 && addedValues.length === 0
          ? "入口异常达到故障观察时间，已自动剔除"
          : addedValues.length > 0 && removedValues.length === 0
            ? "入口恢复达到稳定观察时间，已自动恢复"
            : "入口可用列表变化，已自动同步解析",
        detail: `新增 ${addedValues.length} 个；剔除 ${removedValues.length} 个；当前健康入口 ${values.length} 个`,
      }).catch((error) => {
        console.warn(`[ForwardGroup] switch notify failed group=${group.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(forwardGroups).set({
      lastStatus: "error",
      lastMessage: message,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, null, "ddns-error", `入口组 DDNS 更新失败；${message}；domain=${String(group.domain || "-")} values=${joined}`);
    throw error;
  }
}
