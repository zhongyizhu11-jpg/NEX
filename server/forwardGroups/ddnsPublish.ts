/*
  转发组 DDNS 记录的写入：按值写记录（带权重的走 ddnsWeightedRecords.ts）、双栈镜像记录、分线路记录的钩子
  （forwardGroupDdnsLines.ts）、清掉面板写过的记录、写失败时保留原解析、主备组 / 单成员组的那一条记录。
  写什么由评估决定（evaluateDriver.ts / ddnsEntryGroup.ts），这里只管怎么写、写完记事件。
*/

import { forwardGroupModeOf } from "../../shared/forwardTypes";
import { eq } from "drizzle-orm";
import { forwardGroups } from "../../drizzle/schema";
import { appendPanelLog } from "../_core/panelLogger";
import { DEFAULT_DDNS_TTL, getDdnsSettings, updateDdnsRecordValues, type DdnsRecordValuesInput, type DdnsSettings } from "../ddns";
import { forwardGroupMirrorRecordType, mirrorForwardGroupDdnsValues } from "../forwardGroupDualStackDdns";
import { syncForwardGroupDdnsLines, type ForwardGroupLineContext } from "../forwardGroupDdnsLines";
import type { LineMemberStatus, LinePlannerMember } from "../ddnsLinePlanner";
import { parseDdnsLineState } from "../../shared/ddnsLines";
import { ddnsLineProviderLabel, ddnsLineSupport, deleteDdnsLineRecords } from "../ddnsLineRecords";
import { getDb, nowDate } from "../dbRuntime";
import {
  applyAggregationToDdnsValues,
  buildEntryGroupAggregationPlan,
  isBandwidthAggregationGroup,
  resolveAggregationSettings,
  type AggregationMemberRow,
} from "../bandwidthAggregation";
import { notifyForwardGroupSwitch } from "../forwardGroupSwitchNotifier";
import { recordForwardGroupSwitchEvent } from "../ops/eventHooks";
import { getTrafficExcludedHostIds } from "../hostTrafficPolicy";
import { clearDdnsRecordWeights, ddnsWeightSupport, deleteWeightedDdnsRecords, publishWeightedDdnsRecords } from "../ddnsWeightedRecords";
import { parseDdnsWeightState, type DdnsWeights } from "../../shared/ddnsWeights";
import { ForwardGroupFailoverOptions, ForwardGroupRecordType, LineGroupRow, LineMemberRow, ddnsValueForHostByRecordType, describeDdnsTarget, forwardGroupMemberLabel, groupSwitchNotifyEnabled, insertForwardGroupEvent, normalizeForwardGroupRecordType, sortedMembers, toDate, updateForwardGroupRuntimeIfChanged } from "./common";
import { memberThroughputMbps, withHostLineBandwidth } from "./ddnsEntryGroup";
import { deferProviderWrite, evaluationHost, evaluationTunnel } from "./evaluateScope";
import { resolveMemberAgentLiveness } from "./liveness";

export const exactDdnsReconciledGroups = new Map<number, string>();

export async function memberDdnsValue(member: any, recordType: ForwardGroupRecordType) {
  if (member.memberType === "host") {
    const host = await evaluationHost(member.hostId);
    return ddnsValueForHostByRecordType(host, recordType);
  }
  if (member.memberType === "tunnel") {
    const tunnel = await evaluationTunnel(member.tunnelId);
    if (!tunnel) return "";
    const entry = await evaluationHost(tunnel.entryHostId);
    return ddnsValueForHostByRecordType(entry, recordType);
  }
  return "";
}

/**
 * 组 DDNS 写服务商都走这里：先写主记录，开了双栈（forwardGroupDualStackDdns）再按同一批成员写另一族。
 * 副记录失败也算这次同步失败 —— 两族不一致比都没更新更糟（双栈客户端会连到已经切走的那台）。
 */
type ForwardGroupDdnsTarget = { id?: unknown; domain?: unknown; recordType?: unknown; ddnsDualStack?: unknown; ddnsAutoResolveEnabled?: unknown };

/** 主记录发了 primaryValues 时，双栈副记录上该是哪些值（按成员一一对应）。 */
async function forwardGroupMirrorPairs(group: ForwardGroupDdnsTarget, primaryType: ForwardGroupRecordType, mirrorType: "A" | "AAAA") {
  const pairs: Array<{ primary: string; mirror: string }> = [];
  const members: unknown[] = sortedMembers(group);
  for (const member of members) {
    const primary = await memberDdnsValue(member, primaryType).catch(() => "");
    const mirror = primary ? await memberDdnsValue(member, mirrorType).catch(() => "") : "";
    if (primary && mirror) pairs.push({ primary, mirror });
  }
  return pairs;
}

async function forwardGroupMirrorValues(group: ForwardGroupDdnsTarget, primaryType: ForwardGroupRecordType, mirrorType: "A" | "AAAA", primaryValues: string[]) {
  return mirrorForwardGroupDdnsValues(primaryValues, await forwardGroupMirrorPairs(group, primaryType, mirrorType));
}

/*
  入口组「按权重解析」（shared/ddnsWeights.ts）：weights 给了就按服务商的记录权重发布；clearWeights 是
  「之前按权重发过、这次不按了」，先把服务商那边的权重设置收掉再照常发布。两样都没给 —— 绝大多数组 ——
  走的还是原来那两行，一个请求都不多。
  收权重只在记着的状态说「上一次是按权重发的」时才做（主记录看 clearWeights，双栈副记录看
  previousMirrorWeighted）：发不了权重的记录（只剩一个值、副记录凑不齐）每次发布都去收一遍，
  阿里云那边就是每次一个无条件的写请求。
*/
type ForwardGroupDdnsWeighting = { weights?: DdnsWeights | null; clearWeights?: boolean; previousMirrorWeighted?: boolean };

/** 返回双栈副记录这次是不是按权重发的（记进 ddnsWeightState，下一次决定要不要收）。 */
export async function publishForwardGroupDdnsValues(group: ForwardGroupDdnsTarget, input: DdnsRecordValuesInput, weighting: ForwardGroupDdnsWeighting = {}): Promise<{ mirrorWeighted: boolean }> {
  const mirrorType = forwardGroupMirrorRecordType(group);
  if (!weighting.weights && !weighting.clearWeights && !weighting.previousMirrorWeighted) {
    await updateDdnsRecordValues(input);
    if (!mirrorType) return { mirrorWeighted: false };
    const primaryType = normalizeForwardGroupRecordType(input.recordType);
    await updateDdnsRecordValues({ ...input, recordType: mirrorType, values: await forwardGroupMirrorValues(group, primaryType, mirrorType, input.values) });
    return { mirrorWeighted: false };
  }
  const settings = await getDdnsSettings();
  /** 按权重发了返回 true；没按权重时，clearFirst 才先收服务商那边的权重。 */
  const write = async (recordInput: DdnsRecordValuesInput, weights: DdnsWeights | null, clearFirst: boolean) => {
    if (weights && recordInput.values.length >= 2) {
      await publishWeightedDdnsRecords(settings, {
        domain: recordInput.domain,
        recordType: recordInput.recordType,
        values: recordInput.values,
        weights,
        ttl: recordInput.ttl,
      });
      return true;
    }
    if (clearFirst) await clearDdnsRecordWeights(settings, { domain: recordInput.domain, recordType: recordInput.recordType, values: recordInput.values, ttl: recordInput.ttl });
    await updateDdnsRecordValues(recordInput);
    return false;
  };
  await write(input, weighting.weights || null, !!weighting.clearWeights);
  if (!mirrorType) return { mirrorWeighted: false };
  // 双栈副记录跟着同一批成员走：权重也按成员带过去（副记录上凑不齐的就不带权重）。
  const primaryType = normalizeForwardGroupRecordType(input.recordType);
  const pairs = await forwardGroupMirrorPairs(group, primaryType, mirrorType);
  const mirrorValues = mirrorForwardGroupDdnsValues(input.values, pairs);
  let mirrorWeights: DdnsWeights | null = null;
  if (weighting.weights) {
    mirrorWeights = {};
    for (const pair of pairs) {
      const weight = weighting.weights[pair.primary];
      if (weight && mirrorValues.includes(pair.mirror)) mirrorWeights[pair.mirror] = Math.max(mirrorWeights[pair.mirror] || 0, weight);
    }
    if (mirrorValues.some((value) => !(value in mirrorWeights!))) mirrorWeights = null;
  }
  const mirrorWeighted = await write({ ...input, recordType: mirrorType, values: mirrorValues }, mirrorWeights, !!weighting.previousMirrorWeighted);
  return { mirrorWeighted };
}

/*
  删主备组 / 入口组时把面板发过的解析记录清掉（P6）。以前组删了记录还留在服务商那边：域名继续解析到
  那几台机器，而面板里已经没有任何东西管它，机器换了 IP、下线了也不会再跟着改。

  只删面板自己写的，用的就是发布时记的那几样：
    · 主记录：组的 lastDdnsValue（真的写过服务商才算，看 lastDdnsAt）里的那几个值，按值删；
    · 双栈副记录：同一批成员对应的另一族地址；
    · 分线路记录：ddnsLineState 里记的记录 ID（deleteDdnsLineRecords 只删这些 ID）。
  这个名字上别人手动加的记录、别的服务商上的记录一律不动；自动解析关着的组面板从没替它写过，也不动。
  清不掉不拦删除：记面板日志，让人去服务商那边手动清。停用组不清（恢复时还要用）。
*/
export async function clearForwardGroupPublishedDdns(group: ForwardGroupDdnsTarget & {
  groupMode?: unknown;
  lastDdnsAt?: unknown;
  lastDdnsValue?: unknown;
  ddnsLineState?: unknown;
} | null | undefined) {
  if (!group) return;
  const groupId = Number(group?.id || 0);
  const mode = forwardGroupModeOf(group);
  const domain = String(group?.domain || "").trim();
  if ((mode !== "failover" && mode !== "entry") || !domain || group?.ddnsAutoResolveEnabled === false) return;
  const publishedValues = toDate(group?.lastDdnsAt)
    ? String(group?.lastDdnsValue || "").split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const lineState = parseDdnsLineState(group?.ddnsLineState);
  const lineEntries = lineState ? Object.values(lineState.lines).filter((entry) => entry.recordIds.length > 0) : [];
  if (publishedValues.length === 0 && lineEntries.length === 0) return;
  const label = `group=${groupId} domain=${domain}`;
  const failed = (what: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ForwardGroup] delete: clearing ${what} failed ${label}: ${message}`);
    appendPanelLog("warn", `[DDNS] 转发组已删除，但${what}没清掉，请到 DNS 服务商手动删除；${label} ${message}`);
  };
  const ddnsSettings = await getDdnsSettings();
  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    appendPanelLog("warn", `[DDNS] 转发组已删除，系统 DDNS 未启用，之前发布的解析记录没有清理，请到 DNS 服务商手动删除；${label} values=${publishedValues.join(",")}`);
    return;
  }
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const ttl = Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL);
  const weightState = parseDdnsWeightState((group as { ddnsWeightState?: unknown }).ddnsWeightState);
  const publishedWeighted = !!weightState && weightState.provider === ddnsSettings.provider
    && weightState.domain === domain.toLowerCase() && ddnsWeightSupport(ddnsSettings).supported;
  const removePublished = (type: string, values: string[]) => (publishedWeighted
    ? deleteWeightedDdnsRecords(ddnsSettings, { domain, recordType: type, values, ttl })
    : updateDdnsRecordValues({ groupId, domain, recordType: type, values: [], removeOnlyValues: values, ttl }));
  if (publishedValues.length > 0) {
    try {
      /*
        按权重发布过的组：记录是一个值一条（华为云一个值一个记录集），按值删就行 —— 不先「收权重」：
        收权重会把这个名字上的记录集合并 / 改动，连别人加的也算进去。
      */
      await removePublished(recordType, publishedValues);
      appendPanelLog("info", `[DDNS] 转发组已删除，面板发布的解析记录已清理；${label} type=${recordType} values=${publishedValues.join(",")}`);
    } catch (error) {
      failed(`${recordType} 记录（${publishedValues.join(",")}）`, error);
    }
    const mirrorType = forwardGroupMirrorRecordType(group);
    if (mirrorType) {
      try {
        const mirrorValues = await forwardGroupMirrorValues(group, recordType, mirrorType, publishedValues);
        if (mirrorValues.length > 0) await removePublished(mirrorType, mirrorValues);
      } catch (error) {
        failed(`双栈 ${mirrorType} 记录`, error);
      }
    }
  }
  if (lineState && lineEntries.length > 0) {
    const support = ddnsLineSupport(ddnsSettings);
    if (!support.supported || support.provider !== lineState.provider) {
      // 记录 ID 是原来那家服务商的，绝不拿去现在这家删。
      appendPanelLog("warn", `[DDNS] 转发组已删除，分线路记录写在另一家服务商（${ddnsLineProviderLabel(lineState.provider)}），面板没有清理，请手动删除；${label}`);
      return;
    }
    for (const entry of lineEntries) {
      try {
        await deleteDdnsLineRecords(ddnsSettings, { domain: lineState.domain || domain, recordType: lineState.recordType || recordType, line: entry, recordIds: entry.recordIds });
      } catch (error) {
        failed(`线路 ${entry.name} 的记录`, error);
      }
    }
  }
}

/** 关掉双栈时把面板发过的副记录清掉：留着它，双栈客户端会一直连那条不再跟着切换的记录。 */
export async function clearForwardGroupMirrorDdns(group: ForwardGroupDdnsTarget) {
  const mirrorType = forwardGroupMirrorRecordType(group);
  const domain = String(group?.domain || "").trim();
  if (!mirrorType || !domain || group?.ddnsAutoResolveEnabled === false) return;
  const ddnsSettings = await getDdnsSettings();
  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") return;
  await updateDdnsRecordValues({ groupId: Number(group.id), domain, recordType: mirrorType, values: [], ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL) });
}

function exactDdnsSignature(group: any, value: string) {
  return [
    String(group?.domain || "").trim().toLowerCase(),
    normalizeForwardGroupRecordType(group?.recordType),
    forwardGroupMirrorRecordType(group) || "",
    value,
  ].join("|");
}

export function exactDdnsReconciliationDue(group: any, value: string) {
  const groupId = Number(group?.id || 0);
  return exactDdnsReconciledGroups.get(groupId) !== exactDdnsSignature(group, value);
}

export function rememberExactDdnsReconciliation(group: any, value: string) {
  exactDdnsReconciledGroups.set(Number(group?.id || 0), exactDdnsSignature(group, value));
}

async function forwardGroupDdnsFallbackValue(group: any, recordType: ForwardGroupRecordType) {
  const previous = String(group?.lastDdnsValue || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);
  if (previous) return previous;
  for (const member of sortedMembers(group, true) as any[]) {
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (value) return value;
  }
  return "";
}

export async function preserveForwardGroupDdns(
  group: any,
  ddnsSettings: any,
  options: ForwardGroupFailoverOptions,
  reason: string,
) {
  const db = await getDb();
  const groupId = Number(group.id);
  const domain = String(group.domain || "").trim();
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  /*
    普通的健康故障可以保留最后一条解析等成员恢复；但流量到阈值、被暂停的主机不行 ——
    保留它就等于继续往一台快被机房停掉的机器上导流。有成员被暂停时只保留没被暂停的那些地址。
  */
  if ((await getTrafficExcludedHostIds()).size > 0) {
    const enabledMembers = sortedMembers(group, true) as any[];
    const quotaBlocked: boolean[] = [];
    for (const member of enabledMembers) quotaBlocked.push((await resolveMemberAgentLiveness(member)).trafficExcluded);
    if (quotaBlocked.some(Boolean)) {
      const allowedValues = new Set<string>();
      for (const [index, member] of enabledMembers.entries()) {
        if (!quotaBlocked[index]) allowedValues.add(await memberDdnsValue(member, recordType).catch(() => ""));
      }
      const retainedValues = String(group.lastDdnsValue || "").split(",").map((value) => value.trim()).filter((value) => value && allowedValues.has(value));
      const changed = retainedValues.join(",") !== String(group.lastDdnsValue || "").trim();
      if ((changed || options.forceSync) && ddnsSettings.enabled && ddnsSettings.provider !== "disabled" && group.ddnsAutoResolveEnabled !== false && domain) {
        if (deferProviderWrite()) return "deferred" as const;
        await publishForwardGroupDdnsValues(group, { groupId, domain, recordType, values: retainedValues, ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL) }).catch((error) => {
          console.warn(`[ForwardGroup] removing traffic-excluded DDNS values failed group=${groupId}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      await updateForwardGroupRuntimeIfChanged(db, group, {
        activeMemberId: null,
        lastDdnsValue: retainedValues.join(",") || null,
        lastStatus: "down",
        lastMessage: retainedValues.length
          ? `${reason}；保留未超量的入口，等待恢复`
          : "没有可用成员：流量到阈值的主机已暂停参与，等流量重置或关闭流量故障转移后恢复",
      });
      return;
    }
  }
  const retainedValue = await forwardGroupDdnsFallbackValue(group, recordType);
  const shouldReconcile = !!options.forceSync
    || (!!retainedValue && exactDdnsReconciliationDue(group, retainedValue));

  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastDdnsValue: retainedValue || group.lastDdnsValue || null,
      lastStatus: "down",
      lastMessage: retainedValue
        ? `${reason}；保留最后一条解析 ${retainedValue}，系统 DDNS 未启用`
        : `${reason}；无法确定保底地址，未修改解析`,
    });
    return;
  }

  if (!retainedValue) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "down",
      lastMessage: `${reason}；无法确定保底地址，未修改服务商解析`,
    });
    return;
  }

  if (!shouldReconcile) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastDdnsValue: retainedValue,
      lastStatus: "down",
      lastMessage: `${reason}；继续保留解析 ${retainedValue}，等待成员恢复`,
    });
    return;
  }

  if (deferProviderWrite()) return "deferred" as const;
  try {
    await publishForwardGroupDdnsValues(group, {
      groupId,
      domain,
      recordType,
      values: [retainedValue],
      ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL),
    });
    rememberExactDdnsReconciliation(group, retainedValue);
    await db.update(forwardGroups).set({
      lastDdnsValue: retainedValue,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "down",
      lastMessage: `${reason}；已保留一条解析 ${retainedValue}，等待成员恢复`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, groupId));
    await insertForwardGroupEvent(groupId, Number(group.activeMemberId || 0) || null, "ddns-hold", `没有健康成员，保留一条 DDNS 解析；domain=${domain} type=${recordType} value=${retainedValue}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(forwardGroups).set({
      activeMemberId: null,
      lastStatus: "error",
      lastMessage: `${reason}；保留服务商解析失败：${message}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, groupId));
    await insertForwardGroupEvent(groupId, null, "ddns-error", `保留 DDNS 解析失败：${message}；domain=${domain} type=${recordType} value=${retainedValue}`);
    throw error;
  }
}

/**
 * Order-insensitive signature of a DDNS value list, used to decide whether the
 * provider record set actually changed.
 */
export function ddnsValueSetSignature(value: string) {
  return Array.from(new Set(String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean)))
    .sort()
    .join(",");
}

export type ForwardGroupLineHook = {
  ctx: ForwardGroupLineContext;
  defaultMemberIds: Set<number>;
  /** 上一轮各条线路发布过的值：成员在别的线路里也算「已经在解析里」，故障观察时间照样给。 */
  previouslyPublished: Set<string>;
  members: LinePlannerMember[];
  settled: boolean;
  note(member: LineMemberRow, value: string, status: LineMemberStatus, recovered?: boolean): void;
};

export function createForwardGroupLineHook(group: LineGroupRow, ctx: ForwardGroupLineContext): ForwardGroupLineHook {
  const domain = String(group.domain || "").trim().toLowerCase();
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const previouslyPublished = new Set<string>();
  if (ctx.state && ctx.state.provider === ctx.provider && ctx.state.domain === domain && ctx.state.recordType === recordType) {
    for (const entry of Object.values(ctx.state.lines)) for (const value of entry.values) previouslyPublished.add(value);
  }
  const members: LinePlannerMember[] = [];
  return {
    ctx,
    defaultMemberIds: new Set(ctx.defaultOnly(sortedMembers(group, true)).map((member) => Number(member.id))),
    previouslyPublished,
    members,
    settled: false,
    note(member, value, status, recovered) {
      const memberId = Number(member?.id || 0);
      if (!memberId || members.some((entry) => entry.memberId === memberId)) return;
      members.push({
        memberId,
        hostId: Number(member.hostId || 0),
        priority: Number(member.priority || 0),
        value,
        lines: ctx.linesOf(member),
        status,
        recovered,
        bandwidthMbps: Number(member.bandwidthMbps || 0),
        aggregationWeight: Number(member.aggregationWeight || 0),
      });
    },
  };
}

/** 入口组按线路排序时用的带宽排序：和默认线路同一套（server/bandwidthAggregation.ts），只是成员换成这条线路的。 */
async function entryGroupLineRanker(group: LineGroupRow, members: LinePlannerMember[], recordType: ForwardGroupRecordType) {
  if (!isBandwidthAggregationGroup(group) || members.length === 0) return undefined;
  const rows = await withHostLineBandwidth(members.map((member): AggregationMemberRow => ({
    memberId: member.memberId,
    hostId: member.hostId,
    value: member.value,
    healthy: true,
    bandwidthMbps: member.bandwidthMbps,
    aggregationWeight: member.aggregationWeight,
  })));
  const throughputByHostId = resolveAggregationSettings(group).strategy === "adaptive"
    ? await memberThroughputMbps(rows)
    : new Map<number, number>();
  const rowById = new Map<number, AggregationMemberRow>(rows.map((row) => [row.memberId, row]));
  return (lineMembers: LinePlannerMember[], values: string[]) => {
    const plan = buildEntryGroupAggregationPlan({
      group,
      members: lineMembers.map((member) => rowById.get(member.memberId)).filter((row): row is AggregationMemberRow => !!row),
      throughputByHostId,
      singleValuePerMember: recordType === "CNAME",
    });
    return applyAggregationToDdnsValues(plan, values).values;
  };
}

export async function syncForwardGroupLinesAfterDefault(group: LineGroupRow, ddnsSettings: DdnsSettings, hook: ForwardGroupLineHook, mode: "multi" | "single", options: ForwardGroupFailoverOptions) {
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  await syncForwardGroupDdnsLines({
    group,
    ctx: hook.ctx,
    settings: ddnsSettings,
    mode,
    members: hook.members,
    forceSync: !!options.forceSync,
    rank: mode === "multi" ? await entryGroupLineRanker(group, hook.members, recordType).catch(() => undefined) : undefined,
    deferNetwork: deferProviderWrite,
    recordEvent: (type, message, memberId) => insertForwardGroupEvent(Number(group.id), memberId ?? null, type, message),
  });
}

export async function syncSingleForwardGroupDdns(
  group: any,
  member: any,
  value: string,
  ddnsSettings: any,
  options: {
    forceSync?: boolean;
    eventType?: string;
    successMessage?: string;
    currentMessage?: string;
    suppressSwitchNotify?: boolean;
    switchReason?: string;
    switchDetail?: string;
    previousMember?: any | null;
    /** 活动成员没变时附在「当前入口 x」后面的说明（为什么这会儿不切回）。 */
    currentNote?: string;
    beforeCommit?: () => boolean | Promise<boolean>;
  } = {},
) {
  const db = await getDb();
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
  const memberId = Number(member?.id || 0) || null;
  const forceSync = !!options.forceSync;
  const eventType = options.eventType || "failover";
  const successMessage = options.successMessage || "DDNS 已切换";
  const currentMessage = options.currentMessage || "DDNS 已是最新，解析记录已指向选中入口";
  const previousMemberId = Number(group.activeMemberId || 0);
  const previousValue = String(group.lastDdnsValue || "").trim();

  if (options.beforeCommit && !(await options.beforeCommit())) return false;

  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    const changed = await updateForwardGroupRuntimeIfChanged(db, group, {
      activeMemberId: memberId,
      lastDdnsValue: value,
      lastStatus: "healthy",
      lastMessage: `系统 DDNS 未启用；建议入口 ${value}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, memberId, "ddns-skip", `系统 DDNS 未启用，解析记录未更新；${detail}`);
    return;
  }

  if (
    !forceSync
    && Number(group.activeMemberId) === Number(memberId)
    && String(group.lastDdnsValue || "") === value
    && !exactDdnsReconciliationDue(group, value)
  ) {
    const changed = await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "healthy",
      lastMessage: options.currentNote ? `当前入口 ${value}；${options.currentNote}` : `当前入口 ${value}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, memberId, "ddns-current", `${currentMessage}；${detail}`);
    return;
  }

  if (deferProviderWrite()) return "deferred" as const;
  try {
    await insertForwardGroupEvent(group.id, memberId, "ddns-update", `Starting DDNS update; ${detail}${forceSync ? " force=true" : ""}`);
    await publishForwardGroupDdnsValues(group, {
      groupId: Number(group.id),
      domain: String(group.domain || ""),
      recordType,
      values: [value],
      ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL),
    });
    if (options.beforeCommit && !(await options.beforeCommit())) return false;
    rememberExactDdnsReconciliation(group, value);
    await db.update(forwardGroups).set({
      activeMemberId: memberId,
      lastDdnsValue: value,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "healthy",
      lastMessage: `${successMessage}到 ${value}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, memberId, eventType, `${successMessage}；${detail}`);
    if (previousMemberId > 0 && Number(previousMemberId) !== Number(memberId)) recordForwardGroupSwitchEvent({ group, mode: "failover", fromLabel: previousValue, toLabel: value, reason: options.switchReason || "入口不可用，自动切到健康成员" }); // 事件时间线
    if (groupSwitchNotifyEnabled(group) && !options.suppressSwitchNotify && previousMemberId > 0 && Number(previousMemberId) !== Number(memberId)) {
      const [fromLabel, toLabel] = await Promise.all([
        forwardGroupMemberLabel(options.previousMember, previousMemberId),
        forwardGroupMemberLabel(member, memberId),
      ]);
      void notifyForwardGroupSwitch({
        groupId: Number(group.id),
        groupName: String(group.name || "转发组"),
        groupMode: "failover",
        domain: String(group.domain || ""),
        recordType,
        fromLabel,
        fromValue: previousValue,
        toLabel,
        toValue: value,
        reason: options.switchReason || "入口不可用，已自动切换到健康成员",
        detail: options.switchDetail || "",
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
    await insertForwardGroupEvent(group.id, memberId, "ddns-error", `DDNS 更新失败；${message}；${detail}`);
    throw error;
  }
}
