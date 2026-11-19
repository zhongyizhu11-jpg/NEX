/*
  转发组仓库：组和成员的增删改查（建组、改组、换成员、调顺序、删组、列表 / 分页 / 详情、组事件和测试记录的读取、
  自检和默认主机）。别的都在 server/forwardGroups/ 下，各管一块：
    · evaluateDriver.ts / evaluateScope.ts / liveness.ts / evaluate.ts —— 评估（谁触发、怎么判、纯判断函数）
    · ddnsPublish.ts / ddnsEntryGroup.ts / publish.ts —— DDNS 记录怎么写、入口组的记录集合、按服务商账号的发布队列
    · health.ts / probeTopology.ts / peerObservations.ts / topology.ts —— 健康上报的接收、给 Agent 下发的探测拓扑
    · ruleSync.ts / runtime.ts / portPolicy.ts —— 子规则同步、组变化后让 Agent 跟上、入口端口
    · common.ts —— 上面这些共用的行类型和小工具
  面板里别的地方通过 server/db.ts 用这些函数（db.ts 按名字从各模块再导出一遍）。
*/
import { groupModeSupportsMemberSchedule, resolveMemberScheduleState, serializeMemberSchedule } from "../../shared/memberSchedule";
import { forwardGroupModeOf } from "../../shared/forwardTypes";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import {
  forwardGroupEvents,
  forwardGroupMembers,
  forwardGroups,
  forwardRules,
  hosts,
  tunnels,
  subscriptionPlanForwardGroups,
  userForwardGroupPermissions,
  type InsertForwardGroup,
  type InsertForwardGroupMember,
} from "../../drizzle/schema";
import { appendPanelLog } from "../_core/panelLogger";
import { invalidateProxySubCacheAll } from "../proxySubCache";
import { serializeDdnsLines } from "../../shared/ddnsLines";
import {
  executeRaw,
  getDb,
  insertAndGetId,
  nowDate,
  queryRaw,
  withDatabaseTransaction,
} from "../dbRuntime";
import { flushPendingWrites } from "../dbWriteBatcher";
import { withForwardTestDates } from "./forwardTestRepository";
import { inList, quoteIdentifier } from "../dbCompat";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import {
  getForwardGroupChildRules,
  getForwardGroupChildRulesForMember,
  getForwardGroupChildRulesForTemplate,
  getForwardGroupTemplateRules,
  finalizeForwardRuleDelete,
} from "./forwardRuleRepository";
import { getHostById, isFreshHostHeartbeat } from "./hostRepository";
import { buildEntryGroupAggregationPlan, summarizeAggregationPlan, type AggregationMemberRow } from "../bandwidthAggregation";
import { normalizeMemberBandwidthMbps, normalizeMemberWeight } from "../../shared/bandwidthAggregation";
import { assertTunnelRulePortsFreeOnEntryHosts, getTunnelById } from "./tunnelRepository";
import { findTrafficBillingResourceForRule, trafficBillingResourceCandidatesForRule } from "./trafficBillingRepository";
import { forwardGroupAgentHealthStateAt, forwardGroupChinaHealthStateAt } from "../forwardGroupHealthRecheck";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { assertNoDirectSelfForwardLoop } from "../selfForwardLoop";
import { summarizeForwardGroupRuntime } from "../forwardGroupRuntimeStatus";
import { dbBool, sqlBool } from "./repositoryUtils";
import { reorderWithinSortOrderScope } from "./sortOrderSlots";
import { MAX_FORWARD_GROUP_MEMBERS, forwardGroupRouteMembers } from "../../shared/forwardGroup";
import { ForwardGroupMode, ForwardGroupRecordType, chainEntryMembers, ddnsValueForHostByRecordType, entryAddressForHost, entryGroupMembersFor, forwardChainTargetLabel, insertForwardGroupEvent, ipv6AddressForConnectHost, isCollectionGroupMode, isSafeHostAddress, memberEntryHostId, memberListenHostIds, normalizeForwardGroupRecordType, privateAddressForHost, recordTypeRequirementLabel, sortedMembers, targetHostIdForMember } from "../forwardGroups/common";
import { memberThroughputMbps } from "../forwardGroups/ddnsEntryGroup";
import { clearForwardGroupPublishedDdns, exactDdnsReconciledGroups, memberDdnsValue } from "../forwardGroups/ddnsPublish";
import { forwardGroupHealthRechecks, runForwardGroupFailover, scheduleForwardGroupFailover } from "../forwardGroups/evaluateDriver";
import { resolveMemberAgentLiveness } from "../forwardGroups/liveness";
import { isPortUsedOnHostForGroupChild } from "../forwardGroups/portPolicy";
import { invalidateForwardGroupProbeTopologyAfterChange } from "../forwardGroups/probeTopology";
import { existingChildRule, removeManagedRule, settleAndMarkForwardGroupRulePendingDelete, syncForwardGroupRules } from "../forwardGroups/ruleSync";
import { handleTrafficBillingShortfallLazily, refreshForwardGroupReferences } from "../forwardGroups/runtime";

export type ForwardGroupMemberInput = {
  memberType: "host" | "tunnel";
  hostId?: number | null;
  tunnelId?: number | null;
  connectHost?: string | null;
  priority?: number;
  isEnabled?: boolean;
  /** Declared uplink of this front VPS, in Mbps. `0` means unknown. */
  bandwidthMbps?: number | null;
  /** Manual aggregation weight. `0` derives it from the group strategy. */
  aggregationWeight?: number | null;
  /** 可用时段（shared/memberSchedule.ts）。undefined = 不改原来的；null = 不限时段。 */
  activeSchedule?: unknown;
  /** 分到的运营商线路（shared/ddnsLines.ts）。undefined = 不改原来的；null / [] = 只在默认线路。 */
  ddnsLines?: unknown;
};

/**
 * 成员写库时的启用状态：isEnabled 传进来的是用户的意思，按可用时段算出此刻实际该不该开，
 * 并记下是不是时段让它停的（scheduleSuspended）。不支持时段的组模式一律清掉时段。
 */
function memberSchedulePayload(groupMode: ForwardGroupMode, member: ForwardGroupMemberInput, existing: any, at = new Date()) {
  const supported = groupModeSupportsMemberSchedule(groupMode);
  const schedule = !supported ? null : member.activeSchedule === undefined
    ? serializeMemberSchedule(existing?.activeSchedule)
    : serializeMemberSchedule(member.activeSchedule);
  const state = resolveMemberScheduleState(dbBool(member.isEnabled, true), schedule, at);
  return { activeSchedule: schedule, isEnabled: state.isEnabled, scheduleSuspended: state.scheduleSuspended };
}

function validateForwardGroupModeMembers(groupMode: ForwardGroupMode, groupType: string, members: ForwardGroupMemberInput[], options: { externalEntry?: boolean } = {}) {
  if (groupMode === "port") {
    // 挂了入口组就用组里的主机当入口，自己可以不放成员
    const minMembers = options.externalEntry ? 0 : 1;
    if (members.length < minMembers || members.length > MAX_FORWARD_GROUP_MEMBERS) throw new Error(`端口转发需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台入口主机，或者挂一个入口组`);
    if (String(groupType || "host") !== "host") throw new Error("端口转发仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error("端口转发仅支持主机成员");
  }
  if (groupMode === "chain") {
    const minMembers = options.externalEntry ? 1 : 2;
    if (members.length < minMembers || members.length > MAX_FORWARD_GROUP_MEMBERS) {
      throw new Error(options.externalEntry
        ? `Port forwarding chain requires 1-${MAX_FORWARD_GROUP_MEMBERS} hosts`
        : `Port forwarding chain requires 2-${MAX_FORWARD_GROUP_MEMBERS} hosts`);
    }
    if (groupType !== "host") throw new Error("Port forwarding chain only supports host members");
    if (members.some((member) => member.memberType !== "host")) throw new Error("Port forwarding chain only supports host members");
    return;
  }
  if (isCollectionGroupMode(groupMode)) {
    if (members.length < 1 || members.length > MAX_FORWARD_GROUP_MEMBERS) {
      throw new Error(groupMode === "entry"
        ? `入口组需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台主机`
        : `出口组需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台主机`);
    }
    if (groupType !== "host") throw new Error(groupMode === "entry" ? "入口组仅支持主机成员" : "出口组仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error(groupMode === "entry" ? "入口组仅支持主机成员" : "出口组仅支持主机成员");
  }
}

function normalizeStoredChainConnectHost(rawConnectHost: string | null | undefined, host: any) {
  const raw = String(rawConnectHost || "").trim();
  const publicAddr = entryAddressForHost(host);
  const privateAddr = privateAddressForHost(host);
  const ipv6Addr = ipv6AddressForConnectHost(host);
  if (!raw) return null;
  if (!isSafeHostAddress(raw)) throw new Error("Chain host connect address is invalid");
  if (privateAddr && raw === privateAddr) return privateAddr;
  if (ipv6Addr && raw === ipv6Addr) return ipv6Addr;
  if (publicAddr && raw === publicAddr) return null;
  if (!privateAddr && !ipv6Addr) return null;
  throw new Error("Chain host connect address must use entry address, configured private IP or IPv6");
}

export function resolveChainConnectHost(member: any, host: any) {
  const stored = String(member?.connectHost || "").trim();
  const publicAddr = entryAddressForHost(host);
  const privateAddr = privateAddressForHost(host);
  const ipv6Addr = ipv6AddressForConnectHost(host);
  if (stored && privateAddr && stored === privateAddr) return privateAddr;
  if (stored && ipv6Addr && stored === ipv6Addr) return ipv6Addr;
  return publicAddr || stored;
}

async function normalizeForwardGroupMemberInput(
  groupMode: ForwardGroupMode,
  member: ForwardGroupMemberInput,
  index: number,
  options: { externalEntry?: boolean } = {},
): Promise<ForwardGroupMemberInput> {
  if (groupMode === "port") return { ...member, memberType: "host", tunnelId: null, connectHost: null, isEnabled: true };
  if (groupMode === "exit" && member.memberType === "host" && member.hostId) {
    const host = await getHostById(Number(member.hostId));
    if (!host) throw new Error("Host does not exist");
    const requested = String(member.connectHost || "").trim();
    const privateAddr = privateAddressForHost(host);
    const ipv6Addr = ipv6AddressForConnectHost(host);
    return {
      ...member,
      connectHost: requested && privateAddr && requested === privateAddr
        ? privateAddr
        : requested && ipv6Addr && requested === ipv6Addr
          ? ipv6Addr
          : null,
    };
  }
  if (groupMode !== "chain") return { ...member, connectHost: null };
  if (member.memberType !== "host" || !member.hostId) return { ...member, connectHost: null };
  const host = await getHostById(Number(member.hostId));
  if (!host) throw new Error("Host does not exist");
  const hasExternalEntry = !!options.externalEntry;
  return {
    ...member,
    connectHost: index === 0 && !hasExternalEntry ? null : normalizeStoredChainConnectHost(member.connectHost ?? null, host),
  };
}

export async function getForwardGroups(userId?: number, options: { includeRuntime?: boolean; ids?: number[] } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (userId) conditions.push(eq(forwardGroups.userId, userId));
  if (options.ids !== undefined) {
    const ids = Array.from(new Set(options.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
    if (ids.length === 0) return [];
    conditions.push(inArray(forwardGroups.id, ids));
  }
  const query = db.select().from(forwardGroups);
  const groupRows = conditions.length > 0
    ? await query.where(and(...conditions)).orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id))
    : await query.orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id));
  if (groupRows.length === 0) return [];
  const ids = groupRows.map((g: any) => Number(g.id));
  const relatedGroupIds = Array.from(new Set([
    ...ids,
    ...(options.includeRuntime
      ? groupRows.map((group: any) => Number(group.entryGroupId || 0)).filter((id: number) => id > 0)
      : []),
  ]));
  const members = await db
    .select()
    .from(forwardGroupMembers)
    .where(inArray(forwardGroupMembers.groupId, relatedGroupIds))
    .orderBy(asc(forwardGroupMembers.priority));
  const templateRules = await db
    .select({
      id: forwardRules.id,
      forwardGroupId: forwardRules.forwardGroupId,
      isEnabled: forwardRules.isEnabled,
      pendingDelete: forwardRules.pendingDelete,
    })
    .from(forwardRules)
    .where(and(
      inArray(forwardRules.forwardGroupId, ids),
      eq(forwardRules.isForwardGroupTemplate, true),
      eq(forwardRules.pendingDelete, false),
    ));
  const childRules = options.includeRuntime ? await db
    .select({
      id: forwardRules.id,
      hostId: forwardRules.hostId,
      forwardGroupId: forwardRules.forwardGroupId,
      forwardGroupRuleId: forwardRules.forwardGroupRuleId,
      forwardGroupMemberId: forwardRules.forwardGroupMemberId,
      isEnabled: forwardRules.isEnabled,
      isRunning: forwardRules.isRunning,
      pendingDelete: forwardRules.pendingDelete,
    })
    .from(forwardRules)
    .where(and(
      inArray(forwardRules.forwardGroupId, ids),
      eq(forwardRules.isForwardGroupTemplate, false),
      isNotNull(forwardRules.forwardGroupRuleId),
      eq(forwardRules.pendingDelete, false),
    )) : [];
  const templateCountByGroup = new Map<number, number>();
  for (const rule of templateRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    templateCountByGroup.set(groupId, (templateCountByGroup.get(groupId) || 0) + 1);
  }
  await flushPendingWrites("forward_group_latency_stats");
  const latencyRows = await queryRaw<any>(
    `SELECT s.${quoteIdentifier("groupId")}, s.${quoteIdentifier("latencyMs")}, s.${quoteIdentifier("isTimeout")}, s.${quoteIdentifier("recordedAt")}
     FROM ${quoteIdentifier("forward_group_latency_stats")} s
     INNER JOIN (
       SELECT ${quoteIdentifier("groupId")}, MAX(${quoteIdentifier("recordedAt")}) AS ${quoteIdentifier("recordedAt")}
       FROM ${quoteIdentifier("forward_group_latency_stats")}
       WHERE ${quoteIdentifier("groupId")} IN ${inList(ids).sql}
       GROUP BY ${quoteIdentifier("groupId")}
     ) latest ON latest.${quoteIdentifier("groupId")} = s.${quoteIdentifier("groupId")} AND latest.${quoteIdentifier("recordedAt")} = s.${quoteIdentifier("recordedAt")}`,
    ids,
  ).catch(() => []);
  const latestLatencyByGroup = new Map<number, any>();
  for (const row of latencyRows as any[]) {
    latestLatencyByGroup.set(Number(row.groupId), row);
  }
  const groupById = new Map((groupRows as any[]).map((group: any) => [Number(group.id), group]));
  const membersWithHosts = await hydrateForwardGroupMemberEntryAddresses(members as any[]);
  const hydratedMembers = membersWithHosts.map((member: any) => ({
    ...member,
    ddnsValue: ddnsValueForHostByRecordType(
      member.host,
      normalizeForwardGroupRecordType(groupById.get(Number(member.groupId))?.recordType),
    ),
  }));
  const membersByGroupId = new Map<number, any[]>();
  const templatesByGroupId = new Map<number, any[]>();
  const childrenByGroupId = new Map<number, any[]>();
  for (const member of hydratedMembers) {
    const groupId = Number(member.groupId || 0);
    if (!membersByGroupId.has(groupId)) membersByGroupId.set(groupId, []);
    membersByGroupId.get(groupId)!.push(member);
  }
  for (const rule of templateRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    if (!templatesByGroupId.has(groupId)) templatesByGroupId.set(groupId, []);
    templatesByGroupId.get(groupId)!.push(rule);
  }
  for (const rule of childRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    if (!childrenByGroupId.has(groupId)) childrenByGroupId.set(groupId, []);
    childrenByGroupId.get(groupId)!.push(rule);
  }
  return groupRows.map((group: any) => {
    const groupId = Number(group.id);
    const latestLatency = latestLatencyByGroup.get(groupId);
    const groupMembers = membersByGroupId.get(groupId) || [];
    const entryMembers = Number(group.entryGroupId || 0) > 0
      ? membersByGroupId.get(Number(group.entryGroupId)) || []
      : [];
    const runtime = options.includeRuntime
      ? summarizeForwardGroupRuntime({
        group,
        members: groupMembers,
        entryMembers,
        templateRules: templatesByGroupId.get(groupId) || [],
        childRules: childrenByGroupId.get(groupId) || [],
      })
      : null;
    return {
      ...group,
      groupMode: forwardGroupModeOf(group),
      templateRuleCount: templateCountByGroup.get(groupId) || 0,
      ...(runtime ? {
        runtimeStatus: runtime.status,
        runtimeExpectedRuleCount: runtime.expectedRuleCount,
        runtimeConfiguredRuleCount: runtime.configuredRuleCount,
        runtimeRunningRuleCount: runtime.runningRuleCount,
        runtimeFailedRuleCount: runtime.failedRuleCount,
        ruleRuntimeStatuses: runtime.ruleStatuses,
      } : {}),
      latestLatencyMs: latestLatency?.latencyMs !== null && latestLatency?.latencyMs !== undefined
        ? Number(latestLatency.latencyMs)
        : null,
      latestLatencyIsTimeout: Number(latestLatency?.isTimeout || 0) === 1 || latestLatency?.isTimeout === true,
      latestLatencyAt: latestLatency?.recordedAt ?? null,
      members: groupMembers,
    };
  });
}

export type ForwardGroupListQuery = PageRequest & {
  allowedGroupIds?: number[];
  groupMode: "port" | "failover" | "chain" | "entry" | "exit";
  search?: string;
};

function normalizeForwardGroupIds(values: unknown[] | undefined) {
  return Array.from(new Set((values || [])
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function escapeForwardGroupSearchToken(value: string) {
  return value.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

function forwardGroupListCondition(input: {
  allowedGroupIds?: number[];
  groupMode?: ForwardGroupListQuery["groupMode"];
  search?: string;
}) {
  const conditions: any[] = [];
  if (input.allowedGroupIds !== undefined) {
    const allowedIds = normalizeForwardGroupIds(input.allowedGroupIds);
    conditions.push(allowedIds.length > 0 ? inArray(forwardGroups.id, allowedIds) : eq(forwardGroups.id, -1));
  }
  if (input.groupMode) conditions.push(eq(forwardGroups.groupMode, input.groupMode));
  const tokens = String(input.search || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const q = quoteIdentifier;
  for (const token of tokens) {
    const pattern = `%${escapeForwardGroupSearchToken(token)}%`;
    const numeric = /^\d+$/.test(token) ? Number(token) : 0;
    const entryAlias = "entry_group_search";
    conditions.push(or(
      ...[
        forwardGroups.name,
        forwardGroups.remark,
        forwardGroups.groupType,
        forwardGroups.groupMode,
        forwardGroups.forwardType,
        forwardGroups.domain,
        forwardGroups.recordType,
        forwardGroups.targetIp,
        forwardGroups.lastDdnsValue,
        forwardGroups.lastStatus,
        forwardGroups.lastMessage,
      ].map((column) => sql`LOWER(COALESCE(${column}, '')) LIKE ${pattern} ESCAPE '!'`),
      // PG 按列类型推断参数：端口是 INTEGER，超出 int 范围的数字直接报 out of range，整个列表 500。
      ...(Number.isSafeInteger(numeric) && numeric > 0 ? [eq(forwardGroups.id, numeric)] : []),
      ...(numeric > 0 && numeric <= 2147483647 ? [
        eq(forwardGroups.sourcePort, numeric),
        eq(forwardGroups.targetPort, numeric),
      ] : []),
      sql`EXISTS (
        SELECT 1
        FROM ${forwardGroupMembers}
        INNER JOIN ${hosts} ON ${hosts.id} = ${forwardGroupMembers.hostId}
        WHERE ${forwardGroupMembers.groupId} = ${forwardGroups.id}
          AND (
            LOWER(COALESCE(${hosts.name}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ip}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ipv4}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ipv6}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${forwardGroupMembers.connectHost}, '')) LIKE ${pattern} ESCAPE '!'
          )
      )`,
      sql`EXISTS (
        SELECT 1
        FROM ${forwardGroupMembers}
        INNER JOIN ${tunnels} ON ${tunnels.id} = ${forwardGroupMembers.tunnelId}
        WHERE ${forwardGroupMembers.groupId} = ${forwardGroups.id}
          AND (
            LOWER(COALESCE(${tunnels.name}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${tunnels.mode}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${tunnels.connectHost}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${forwardGroupMembers.connectHost}, '')) LIKE ${pattern} ESCAPE '!'
          )
      )`,
      sql`EXISTS (
        SELECT 1
        FROM ${sql.raw(q("forward_groups"))} ${sql.raw(entryAlias)}
        WHERE ${sql.raw(`${entryAlias}.${q("id")}`)} = ${forwardGroups.entryGroupId}
          AND (
            LOWER(COALESCE(${sql.raw(`${entryAlias}.${q("name")}`)}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${sql.raw(`${entryAlias}.${q("remark")}`)}, '')) LIKE ${pattern} ESCAPE '!'
          )
      )`,
    ));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function getForwardGroupsPage(input: ForwardGroupListQuery) {
  const db = await getDb();
  if (!db) return { ...pageResult([], 0, input), scopeTotalItems: 0, enabledItems: 0 };
  const condition = forwardGroupListCondition(input);
  const aggregate = db
    .select({
      totalItems: sql<number>`COUNT(*)`,
      enabledItems: sql<number>`COALESCE(SUM(CASE WHEN ${forwardGroups.isEnabled} = ${sqlBool(true)} THEN 1 ELSE 0 END), 0)`,
    })
    .from(forwardGroups);
  const [totals] = condition ? await aggregate.where(condition) : await aggregate;
  const totalItems = Number(totals?.totalItems || 0);
  const enabledItems = Number(totals?.enabledItems || 0);
  const scopeCondition = forwardGroupListCondition({
    allowedGroupIds: input.allowedGroupIds,
    groupMode: input.groupMode,
  });
  let scopeTotalItems = totalItems;
  if (String(input.search || "").trim()) {
    const scopeQuery = db.select({ count: sql<number>`COUNT(*)` }).from(forwardGroups);
    const [scopeTotals] = scopeCondition ? await scopeQuery.where(scopeCondition) : await scopeQuery;
    scopeTotalItems = Number(scopeTotals?.count || 0);
  }
  const window = pageWindowForTotal(input, totalItems);
  const idQuery = db.select({ id: forwardGroups.id }).from(forwardGroups);
  const idRows = condition
    ? await idQuery.where(condition).orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id)).limit(window.pageSize).offset(window.offset)
    : await idQuery.orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id)).limit(window.pageSize).offset(window.offset);
  const ids = idRows.map((row: any) => Number(row.id));
  const hydrated = ids.length > 0
    ? await getForwardGroups(undefined, { includeRuntime: true, ids })
    : [];
  const byId = new Map((hydrated as any[]).map((group: any) => [Number(group.id), group]));
  const items = ids.map((id: number) => byId.get(id)).filter(Boolean);
  return {
    ...pageResult(items, totalItems, window),
    scopeTotalItems,
    enabledItems,
  };
}

export async function getForwardGroupOptions(allowedGroupIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const condition = forwardGroupListCondition({ allowedGroupIds });
  const query = db.select().from(forwardGroups);
  const rows = condition
    ? await query.where(condition).orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id))
    : await query.orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id));
  if (rows.length === 0) return [];
  const ids = rows.map((group: any) => Number(group.id));
  // 转发链的入口组成员也要拿到：算「应有几个托管监听」时入口组每台主机算一个。
  const relatedGroupIds = Array.from(new Set([
    ...ids,
    ...rows.map((group: any) => Number(group.entryGroupId || 0)).filter((id: number) => id > 0),
  ]));
  const members = await db
    .select()
    .from(forwardGroupMembers)
    .where(inArray(forwardGroupMembers.groupId, relatedGroupIds))
    .orderBy(asc(forwardGroupMembers.priority), asc(forwardGroupMembers.id));
  const hydratedMembers = await hydrateForwardGroupMemberEntryAddresses(members as any[]);
  const membersByGroupId = new Map<number, any[]>();
  for (const member of hydratedMembers) {
    const groupId = Number(member.groupId);
    const list = membersByGroupId.get(groupId) || [];
    list.push(member);
    membersByGroupId.set(groupId, list);
  }
  /*
    每条模板规则「应有几个托管监听、几个已确认在跑」（ruleRuntimeStatuses）。规则页就靠这份
    给组规则画状态点和「3 / 3 个入口在运行」—— 它读的是这个接口，不是带完整运行态的 list。
    端口转发能挂多台入口主机起（2.3.437）尤其需要：一条规则在三台机器上各跑一份，少一份得看得出来。
    多两次按组查规则的开销，和 getForwardGroups({ includeRuntime: true }) 一样。
  */
  const { templatesByGroupId, childrenByGroupId } = await loadForwardGroupRuleRows(ids);
  return rows.map((group: any) => {
    const groupId = Number(group.id);
    const runtime = summarizeForwardGroupRuntime({
      group,
      members: membersByGroupId.get(groupId) || [],
      entryMembers: Number(group.entryGroupId || 0) > 0 ? membersByGroupId.get(Number(group.entryGroupId)) || [] : [],
      templateRules: templatesByGroupId.get(groupId) || [],
      childRules: childrenByGroupId.get(groupId) || [],
    });
    return {
      ...group,
      groupMode: forwardGroupModeOf(group),
      runtimeStatus: runtime.status,
      runtimeExpectedRuleCount: runtime.expectedRuleCount,
      runtimeRunningRuleCount: runtime.runningRuleCount,
      ruleRuntimeStatuses: runtime.ruleStatuses,
      members: membersByGroupId.get(groupId) || [],
    };
  });
}

/** 这些组的模板规则和托管子规则，只取算运行态要的几列，按组分好。 */
async function loadForwardGroupRuleRows(ids: number[]) {
  const db = await getDb();
  const templatesByGroupId = new Map<number, any[]>();
  const childrenByGroupId = new Map<number, any[]>();
  if (!db || ids.length === 0) return { templatesByGroupId, childrenByGroupId };
  const columns = {
    id: forwardRules.id,
    hostId: forwardRules.hostId,
    forwardGroupId: forwardRules.forwardGroupId,
    forwardGroupRuleId: forwardRules.forwardGroupRuleId,
    forwardGroupMemberId: forwardRules.forwardGroupMemberId,
    isEnabled: forwardRules.isEnabled,
    isRunning: forwardRules.isRunning,
    pendingDelete: forwardRules.pendingDelete,
  };
  const templateRules = await db.select(columns).from(forwardRules).where(and(
    inArray(forwardRules.forwardGroupId, ids),
    eq(forwardRules.isForwardGroupTemplate, true),
    eq(forwardRules.pendingDelete, false),
  ));
  const childRules = await db.select(columns).from(forwardRules).where(and(
    inArray(forwardRules.forwardGroupId, ids),
    eq(forwardRules.isForwardGroupTemplate, false),
    isNotNull(forwardRules.forwardGroupRuleId),
    eq(forwardRules.pendingDelete, false),
  ));
  for (const rule of templateRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    if (!templatesByGroupId.has(groupId)) templatesByGroupId.set(groupId, []);
    templatesByGroupId.get(groupId)!.push(rule);
  }
  for (const rule of childRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    if (!childrenByGroupId.has(groupId)) childrenByGroupId.set(groupId, []);
    childrenByGroupId.get(groupId)!.push(rule);
  }
  return { templatesByGroupId, childrenByGroupId };
}

export async function getForwardGroupById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const group = (await db.select().from(forwardGroups).where(eq(forwardGroups.id, id)).limit(1))[0];
  if (!group) return undefined;
  const members = await db
    .select()
    .from(forwardGroupMembers)
    .where(eq(forwardGroupMembers.groupId, id))
    .orderBy(asc(forwardGroupMembers.priority));
  // 批量补齐，别一个成员打两次库。这个函数被路由、校验、故障转移巡检反复调用，
  // 巡检那条尤其吃亏：每 5 分钟按组数线性打库，实测 25 个组要打 276 次，其中
  // 200 次是在这里一条条查主机。
  const hydratedMembers = await hydrateForwardGroupMemberEntryAddresses(members as any[], {
    recordType: normalizeForwardGroupRecordType(group.recordType),
    includeHost: false,
  });
  return { ...group, groupMode: forwardGroupModeOf(group), members: hydratedMembers };
}

export async function getForwardGroupModesByIds(groupIds: number[]) {
  const ids = Array.from(new Set(groupIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)));
  if (ids.length === 0) return [] as Array<{ id: number; groupMode: ForwardGroupMode }>;
  const db = await getDb();
  if (!db) return [] as Array<{ id: number; groupMode: ForwardGroupMode }>;
  const rows = await db
    .select({ id: forwardGroups.id, groupMode: forwardGroups.groupMode })
    .from(forwardGroups)
    .where(inArray(forwardGroups.id, ids));
  return (rows as any[]).map((group) => ({
    id: Number(group.id),
    groupMode: forwardGroupModeOf(group),
  }));
}

export async function getForwardGroupEvents(groupId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardGroupEvents)
    .where(eq(forwardGroupEvents.groupId, groupId))
    .orderBy(desc(forwardGroupEvents.createdAt))
    .limit(limit);
}

export async function cleanOldForwardGroupEvents(retainHours = 72) {
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("forward_group_events")} WHERE ${quoteIdentifier("createdAt")} < ?`,
    [cutoff],
  );
}

async function withForwardChainTargetLabel(test: any, template: any) {
  if (!test?.message || !template) return test;
  const targetIp = String(template?.targetIp || "").trim();
  const targetPort = Number(template?.targetPort || 0);
  if (!targetIp || targetPort <= 0) return test;
  const targetLabel = await forwardChainTargetLabel(template);
  const oldTarget = `目标 ${targetIp}:${targetPort}`;
  if (!targetLabel || targetLabel === oldTarget || !String(test.message).includes(oldTarget)) return test;
  try {
    const parsed = JSON.parse(String(test.message));
    if (Array.isArray(parsed?.details)) {
      parsed.details = parsed.details.map((detail: any) => ({
        ...detail,
        routeLabel: typeof detail?.routeLabel === "string" ? detail.routeLabel.replace(oldTarget, targetLabel) : detail?.routeLabel,
        hopLabel: typeof detail?.hopLabel === "string" ? detail.hopLabel.replace(oldTarget, targetLabel) : detail?.hopLabel,
      }));
      if (typeof parsed.message === "string") parsed.message = parsed.message.replaceAll(oldTarget, targetLabel);
      return { ...test, message: JSON.stringify(parsed) };
    }
  } catch {
    // Older records may be plain text; fall back to a direct replacement.
  }
  return { ...test, message: String(test.message).replaceAll(oldTarget, targetLabel) };
}

export async function getLatestForwardGroupTest(groupId: number, options: { includeActive?: boolean } = {}) {
  const templates = await getForwardGroupTemplateRules(groupId);
  const templateIds = (templates as any[]).map((rule: any) => Number(rule.id)).filter((id: number) => id > 0);
  const table = quoteIdentifier("forward_tests");
  const idCol = quoteIdentifier("id");
  const ruleCol = quoteIdentifier("ruleId");
  const updatedCol = quoteIdentifier("updatedAt");
  const createdCol = quoteIdentifier("createdAt");
  const messageCol = quoteIdentifier("message");
  const normalizedGroupId = Number(groupId);
  const groupNeedleWithTrailingField = `%"groupId":${normalizedGroupId},%`;
  const groupNeedleAtObjectEnd = `%"groupId":${normalizedGroupId}}%`;
  const ruleFilter = templateIds.length > 0
    ? `${ruleCol} IN ${inList(templateIds).sql} OR `
    : "";
  const filterSql = `(${ruleFilter}${messageCol} LIKE ? OR ${messageCol} LIKE ?)`;
  const filterArgs: any[] = [...templateIds, groupNeedleWithTrailingField, groupNeedleAtObjectEnd];
  const template = (templates as any[])[0] || null;
  if (options.includeActive !== false) {
    const pendingRows = await queryRaw<any>(
      `SELECT * FROM ${table} WHERE ${filterSql} AND ${quoteIdentifier("status")} IN ('pending', 'running') ORDER BY ${updatedCol} DESC, ${createdCol} DESC, ${idCol} DESC LIMIT 1`,
      filterArgs,
    );
    if (pendingRows[0]) return withForwardTestDates(await withForwardChainTargetLabel(pendingRows[0], template));
  }
  const rows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${filterSql} AND ${quoteIdentifier("status")} IN ('success', 'failed', 'timeout') ORDER BY ${updatedCol} DESC, CASE WHEN ${messageCol} LIKE '%forward-chain-hop-summary%' THEN 0 ELSE 1 END, ${createdCol} DESC, ${idCol} DESC LIMIT 1`,
    filterArgs,
  );
  return withForwardTestDates(await withForwardChainTargetLabel(rows[0], template));
}

export async function getForwardGroupPrimaryTemplateRule(groupId: number) {
  const templates = await getForwardGroupTemplateRules(groupId);
  return (templates as any[])[0] || null;
}

/**
 * 一次把一批成员的入口地址补齐，而不是一个成员打一次库。
 *
 * 成员要么挂主机、要么挂隧道（隧道再落到它的入口主机），所以只要两条 inArray：
 * 先把隧道的入口主机 id 查出来，再把所有涉及的主机一次查回来。
 *
 * recordType 给了就顺带算 ddnsValue —— 它和 entryAddress 读的是同一批主机字段，
 * 分两次算就等于把同一批主机再查一遍。实测：转发组详情页原来每个主机成员要打
 * **两次**主机查询（entryAddress 一次、ddnsValue 一次），隧道成员四次。
 */
async function hydrateForwardGroupMemberEntryAddresses(
  members: any[],
  options: { recordType?: ForwardGroupRecordType; includeHost?: boolean } = {},
) {
  if (members.length === 0) return [];
  const db = await getDb();
  if (!db) return members;

  const tunnelIds = Array.from(new Set(members
    .filter((member) => member?.memberType === "tunnel")
    .map((member) => Number(member?.tunnelId || 0))
    .filter((id) => id > 0)));
  const tunnelRows = tunnelIds.length > 0
    ? await db.select({ id: tunnels.id, entryHostId: tunnels.entryHostId })
      .from(tunnels)
      .where(inArray(tunnels.id, tunnelIds))
    : [];
  const tunnelEntryHostById = new Map((tunnelRows as any[])
    .map((tunnel) => [Number(tunnel.id), Number(tunnel.entryHostId || 0)]));
  const hostIds = Array.from(new Set(members
    .map((member) => member?.memberType === "host"
      ? Number(member?.hostId || 0)
      : tunnelEntryHostById.get(Number(member?.tunnelId || 0)) || 0)
    .filter((id) => id > 0)));
  const hostRows = hostIds.length > 0
    ? await db.select({
      id: hosts.id,
      name: hosts.name,
      entryIp: hosts.entryIp,
      ipv4: hosts.ipv4,
      ipv6: hosts.ipv6,
      ip: hosts.ip,
      tunnelEntryIp: hosts.tunnelEntryIp,
      ddnsEnabled: hosts.ddnsEnabled,
      ddnsDomain: hosts.ddnsDomain,
      isOnline: hosts.isOnline,
      trafficFailoverEnabled: hosts.trafficFailoverEnabled,
      trafficFailoverExcluded: hosts.trafficFailoverExcluded,
      trafficLimit: hosts.trafficLimit,
      lastHeartbeat: hosts.lastHeartbeat,
    }).from(hosts).where(inArray(hosts.id, hostIds))
    : [];
  const hostById = new Map((hostRows as any[]).map((host) => [Number(host.id), host]));

  return members.map((member) => {
    const hostId = member?.memberType === "host"
      ? Number(member?.hostId || 0)
      : tunnelEntryHostById.get(Number(member?.tunnelId || 0)) || 0;
    const host = hostById.get(hostId);
    return {
      ...member,
      entryAddress: entryAddressForHost(host),
      ...(options.recordType ? { ddnsValue: ddnsValueForHostByRecordType(host, options.recordType) } : {}),
      // host 这一层是给列表页用的。详情页不要 —— 它的返回结构是一大票调用方
      // （路由、校验、故障转移）在吃的，凭空多挂一个主机对象不值当冒这个险。
      ...(options.includeHost === false ? {} : {
        host: hostById.has(hostId) ? {
          ...host,
          isOnline: !!host?.isOnline && isFreshHostHeartbeat(host?.lastHeartbeat),
        } : null,
      }),
    };
  });
}

export async function validateForwardGroupRecordMembers(group: any, members: ForwardGroupMemberInput[] | any[]) {
  const mode = forwardGroupModeOf(group);
  if (mode !== "failover" && mode !== "entry") return;
  const recordType = normalizeForwardGroupRecordType((group as any)?.recordType);
  const requirement = recordTypeRequirementLabel(recordType);
  const label = mode === "entry" ? "入口组" : "转发组";
  const missing: string[] = [];
  for (const member of members || []) {
    if (!dbBool(member?.isEnabled, true)) continue;
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (value) continue;
    let name = "";
    if (member.memberType === "host") {
      const host = await getHostById(Number(member.hostId)).catch(() => null);
      name = String((host as any)?.name || `主机 #${member.hostId}`);
    } else {
      const tunnel = await getTunnelById(Number(member.tunnelId)).catch(() => null);
      name = String((tunnel as any)?.name || `隧道 #${member.tunnelId}`);
    }
    missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`${label}使用 ${recordType} 记录时，所有启用成员都需要配置${requirement}：${missing.slice(0, 5).join("、")}`);
  }
}

/**
 * Which listener a failover-group rule's self-test must probe: the child rule
 * of the member that currently carries the traffic (activeMemberId), never the
 * template's historical host metadata. Without an active member and without a
 * DDNS domain any live member's listener is equivalent. Throws instead of
 * testing a standby while the actual active route is offline.
 */
export async function getForwardGroupRuleForSelfTest(template: any, group: any) {
  if (!group || !dbBool(group.isEnabled)) throw new Error("转发组不存在或已停用");
  if (forwardGroupModeOf(group) !== "failover") throw new Error("此转发组不支持单入口链路测试");
  const members = forwardGroupRouteMembers(group);
  const activeMemberId = Number(group.activeMemberId || 0);
  const candidates = activeMemberId > 0
    ? members.filter((member) => Number(member.id) === activeMemberId)
    : group.domain ? [] : members;
  const children = await getForwardGroupChildRulesForTemplate(Number(template.id)) as any[];
  for (const member of candidates) {
    const liveness = await resolveMemberAgentLiveness(member);
    if (!liveness.available) continue;
    const tunnelId = member.memberType === "tunnel" ? Number(member.tunnelId || 0) : 0;
    const child = children.find((rule) => !dbBool(rule.pendingDelete)
      && dbBool(rule.isEnabled)
      && Number(rule.forwardGroupId) === Number(group.id)
      && Number(rule.forwardGroupMemberId) === Number(member.id)
      && Number(rule.hostId) === liveness.hostId
      && Number(rule.tunnelId || 0) === tunnelId);
    if (child) return { rule: child, memberId: Number(member.id), groupId: Number(group.id) };
  }
  throw new Error("转发组当前没有可测试的活动入口，请等待故障切换完成后重试");
}

export async function getForwardGroupDefaultHostId(groupId: number) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  for (const member of await entryGroupMembersFor(group)) {
    const hostId = await memberEntryHostId(member);
    if (hostId) return hostId;
  }
  const members = sortedMembers(group);
  for (const member of members) {
    if (!dbBool(member?.isEnabled)) continue;
    const hostId = await memberEntryHostId(member);
    if (hostId) return hostId;
  }
  for (const member of members) {
    const hostId = await memberEntryHostId(member);
    if (hostId) return hostId;
  }
  throw new Error("Forward group has no valid entry agent");
}

/**
 * 删主机前修转发组模板上过期的主机引用（照上游 poouo/Forwardx 的
 * repairForwardGroupTemplateHostReferencesForHost 移植）。
 *
 * 故障转移 / 转发链的模板从不下发到 Agent，hostId 只是元数据；组里的成员换掉以后它还指着老机器，
 * 删那台老机器时 getHostRuleDeleteBlockers 会把这条模板算成「转发组规则引用」挡住删除，而用户
 * 在界面上根本找不到这条引用。这里只把「这台机器已经不是组里成员」的模板改指向组里现在的
 * 默认入口机：不动子规则、不重铺运行时。端口转发的模板由 repairPortForwardRuleHostReferences 修，
 * 入口组 / 出口组没有模板。组里一台可用的机器都没有时保持原样（照上游）。
 */
export async function repairForwardGroupTemplateHostReferencesForHost(hostIdValue: number) {
  const hostId = Number(hostIdValue || 0);
  const db = await getDb();
  if (!db || !Number.isInteger(hostId) || hostId <= 0) return 0;
  const rows = await db.selectDistinct({ groupId: forwardRules.forwardGroupId })
    .from(forwardRules)
    .where(and(
      eq(forwardRules.hostId, hostId),
      eq(forwardRules.isForwardGroupTemplate, true),
      eq(forwardRules.pendingDelete, false),
      isNotNull(forwardRules.forwardGroupId),
    ));
  let repaired = 0;
  for (const row of rows as any[]) {
    const groupId = Number(row.groupId || 0);
    if (groupId <= 0) continue;
    repaired += await withKeyedTaskLock(`forward-group-sync:${groupId}`, async () => {
      const group = await getForwardGroupById(groupId);
      if (!group) return 0;
      const groupMode = forwardGroupModeOf(group);
      if (isCollectionGroupMode(groupMode) || groupMode === "port") return 0;
      const memberHostIds = new Set<number>();
      for (const member of [...sortedMembers(group), ...await entryGroupMembersFor(group)]) {
        const memberHostId = await memberEntryHostId(member).catch(() => 0);
        if (memberHostId > 0) memberHostIds.add(memberHostId);
      }
      if (memberHostIds.has(hostId)) return 0;
      const nextHostId = await getForwardGroupDefaultHostId(groupId).catch(() => 0);
      if (!nextHostId || nextHostId === hostId) return 0;
      const stale = (await getForwardGroupTemplateRules(groupId) as any[])
        .filter((rule) => Number(rule.hostId) === hostId)
        .map((rule) => Number(rule.id));
      if (stale.length === 0) return 0;
      await db.update(forwardRules).set({ hostId: nextHostId, updatedAt: nowDate() } as any).where(and(
        inArray(forwardRules.id, stale),
        eq(forwardRules.forwardGroupId, groupId),
        eq(forwardRules.isForwardGroupTemplate, true),
        eq(forwardRules.pendingDelete, false),
      ));
      appendPanelLog("info", `[ForwardGroup] template host references repaired group=${groupId} from=${hostId} to=${nextHostId} count=${stale.length}`);
      return stale.length;
    });
  }
  return repaired;
}

export async function getForwardGroupRuleEntryHostIds(groupId: number) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const members = sortedMembers(group);
  const enabledMembers = members.filter((member: any) => dbBool(member?.isEnabled));
  const groupMode = forwardGroupModeOf(group);
  const chainEntries = await entryGroupMembersFor(group);
  // Only the public edge uses the user-selected source port. Downstream chain
  // listeners are allocated independently inside each member's port policy.
  const portMembers = groupMode === "chain"
    ? (chainEntries.length > 0 ? chainEntries : enabledMembers.slice(0, 1))
    : (chainEntries.length > 0 ? chainEntries : members);
  const hostIds = (await Promise.all(portMembers
    .filter((member: any) => dbBool(member?.isEnabled, true))
    .map((member: any) => memberListenHostIds(member)))).flat();
  return Array.from(new Set(hostIds.filter((hostId) => Number.isInteger(hostId) && hostId > 0)))
    .sort((left, right) => left - right);
}

export async function createForwardGroup(data: InsertForwardGroup, members: ForwardGroupMemberInput[]) {
  try {
    return await createForwardGroupUnwatched(data, members);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function createForwardGroupUnwatched(data: InsertForwardGroup, members: ForwardGroupMemberInput[]) {
  const groupMode = forwardGroupModeOf(data);
  const externalEntry = (groupMode === "chain" || groupMode === "port") && Number((data as any).entryGroupId || 0) > 0;
  if (members.length === 0 && !(groupMode === "port" && externalEntry)) throw new Error("转发组至少需要一个成员");
  validateForwardGroupModeMembers(groupMode, String((data as any).groupType || "host"), members, { externalEntry });
  if (groupMode === "entry" && !String((data as any).domain || "").trim()) throw new Error("入口组需要指定入口域名");
  for (const member of members) await targetHostIdForMember(member);
  const normalizedMembers = await Promise.all(members.map((member, index) => normalizeForwardGroupMemberInput(groupMode, member, index, { externalEntry })));
  await validateForwardGroupRecordMembers({ ...data, groupMode }, normalizedMembers as any);
  /*
    组、成员、「已创建」事件三样一起写：以前中途失败（比如某个成员行写不进去）会留下一个缺成员的组，
    界面上看着建成了，同步时又报「至少需要一个成员」。校验都在上面做完了，这里只剩写库，没有键锁、
    没有对外通知，放进一个事务里没有死锁的余地。
    排序号在事务外先算好：它的查询失败时按 0 兜底（.catch），PostgreSQL 下事务里的语句一旦报错，
    整个事务就只能回滚了，兜底兜不住。
  */
  const sortOrder = (data as any).sortOrder === undefined
    ? await nextForwardGroupSortOrder(Number((data as any).userId || 0), groupMode)
    : Math.max(0, Math.floor(Number((data as any).sortOrder) || 0));
  return withDatabaseTransaction(async () => {
  const id = await insertAndGetId("forward_groups", {
    ...data,
    failoverRuntimeInheritanceEnabled: (data as any).failoverRuntimeInheritanceEnabled ?? true,
    groupMode,
    sortOrder,
    forwardType: (data as any).forwardType || "iptables",
    sourcePort: Number((data as any).sourcePort || 1),
    protocol: (data as any).protocol || "both",
    targetIp: (data as any).targetIp || "0.0.0.0",
    targetPort: Number((data as any).targetPort || 1),
    createdAt: nowDate(),
    updatedAt: nowDate(),
  } as any);
  for (const [index, member] of normalizedMembers.entries()) {
    await insertAndGetId("forward_group_members", {
      groupId: id,
      memberType: member.memberType,
      hostId: member.memberType === "host" ? member.hostId : null,
      tunnelId: member.memberType === "tunnel" ? member.tunnelId : null,
      connectHost: member.connectHost ?? null,
      priority: member.priority ?? index,
      ...memberSchedulePayload(groupMode, member, null),
      ddnsLines: serializeDdnsLines(member.ddnsLines),
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });
  }
  await insertForwardGroupEvent(id, null, "created", groupMode === "chain"
    ? "Port forwarding chain created; rules will generate hop routes when this chain is selected."
    : groupMode === "entry"
      ? "入口组已创建；开启自动解析后会把入口主机同步到同一个入口域名。"
      : groupMode === "exit"
        ? "出口组已创建；可在隧道中作为出口组选择。"
        : "Forward group created; use it from forwarding rules to generate member routes.");
  return id;
  });
}

type RuleProtocol = "tcp" | "udp" | "both";

export function normalizeRuleProtocol(protocol: unknown): RuleProtocol {
  const text = String(protocol || "both").toLowerCase();
  return text === "tcp" || text === "udp" ? text : "both";
}

async function nextForwardGroupSortOrder(userId: number, groupMode: ForwardGroupMode) {
  const q = quoteIdentifier;
  const params: any[] = [groupMode];
  let where = ` WHERE ${q("groupMode")} = ?`;
  if (userId > 0) {
    where += ` AND ${q("userId")} = ?`;
    params.push(userId);
  }
  const rows = await queryRaw<{ nextSortOrder: number }>(
    `SELECT COALESCE(MAX(${q("sortOrder")}), -1) + 1 AS ${q("nextSortOrder")} FROM ${q("forward_groups")}${where}`,
    params,
  ).catch(() => []);
  const value = Number(rows[0]?.nextSortOrder || 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export async function reorderForwardGroups(groupMode: ForwardGroupMode, ids: number[], _startIndex = 0) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const mode = forwardGroupModeOf({ groupMode });
  const orderedIds = ids.map((id) => Math.floor(Number(id))).filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const rows = await db.select({
    id: forwardGroups.id,
    groupMode: forwardGroups.groupMode,
  }).from(forwardGroups).where(inArray(forwardGroups.id, orderedIds));
  if (rows.length !== orderedIds.length) throw new Error("排序中包含不存在的转发项目");
  if ((rows as any[]).some((row) => forwardGroupModeOf(row) !== mode)) throw new Error("排序项目类型不一致");
  // 按被拖行原有的 sortOrder 位置重排（见 sortOrderSlots）；范围是管理员看到的同类型全部项目，startIndex 不再需要。
  await reorderWithinSortOrderScope({
    table: "forward_groups",
    orderedIds,
    loadScope: async () => ((await (await getDb()).select({ id: forwardGroups.id, groupMode: forwardGroups.groupMode, sortOrder: forwardGroups.sortOrder })
      .from(forwardGroups).orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id))) as any[])
      .filter((row) => forwardGroupModeOf(row) === mode),
  });
}

export async function updateForwardGroup(id: number, data: Partial<InsertForwardGroup>, options: { skipSync?: boolean } = {}) {
  try {
    return await updateForwardGroupUnwatched(id, data, options);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function updateForwardGroupUnwatched(id: number, data: Partial<InsertForwardGroup>, options: { skipSync?: boolean } = {}) {
  const db = await getDb();
  await db.update(forwardGroups).set({ ...data, updatedAt: nowDate() }).where(eq(forwardGroups.id, id));
  if (!options.skipSync) {
    await syncForwardGroupRules(id);
    const group = await getForwardGroupById(id);
    if (forwardGroupModeOf(group) === "entry" || forwardGroupModeOf(group) === "exit") {
      await refreshForwardGroupReferences(id);
    }
  }
}

/**
 * 换成员前查死循环（和 rules.crud.ts 新建 / 编辑规则时同一个检查，见 server/selfForwardLoop.ts）：
 * 新加入（或重新启用）的主机会按模板端口铺子规则 —— 主机地址正好是规则目标、端口又相同，就是转回自己。
 * - 端口转发 / 故障转移（主机型）组自己加成员：查这个组的模板；
 * - 入口组加主机：查挂这个入口组的端口转发的模板（转发链的入口只转给下一跳，不查，和 rules.crud 一致）。
 * 停用状态加进来的成员不铺子规则，等它被启用时再查。
 */
async function assertMemberChangeHasNoSelfForwardLoop(group: any, groupMode: ForwardGroupMode, existing: any[], nextMembers: any[]) {
  const previousEnabledHostIds = new Set(existing
    .filter((member) => member.memberType === "host" && dbBool(member.isEnabled, true))
    .map((member) => Number(member.hostId || 0)));
  const addedHostIds = Array.from(new Set(nextMembers
    .filter((member) => member.memberType === "host" && dbBool(member.isEnabled, true))
    .map((member) => Number(member.hostId || 0))
    .filter((hostId) => hostId > 0 && !previousEnabledHostIds.has(hostId))));
  if (addedHostIds.length === 0) return;
  const groupIds: number[] = [];
  if (groupMode === "entry") {
    const db = await getDb();
    const dependents = await db.select({ id: forwardGroups.id, groupMode: forwardGroups.groupMode, groupType: forwardGroups.groupType })
      .from(forwardGroups)
      .where(eq(forwardGroups.entryGroupId, Number(group.id)));
    for (const dependent of dependents as any[]) {
      if (forwardGroupModeOf(dependent) === "port" && String(dependent.groupType || "host") !== "tunnel") groupIds.push(Number(dependent.id));
    }
  } else if (groupMode !== "chain" && !isCollectionGroupMode(groupMode) && String(group?.groupType || "host") !== "tunnel") {
    groupIds.push(Number(group.id));
  }
  for (const groupId of groupIds) {
    const templates = await getForwardGroupTemplateRules(groupId) as any[];
    if (templates.length === 0) continue;
    for (const hostId of addedHostIds) {
      const host = await getHostById(hostId);
      for (const template of templates) {
        try {
          assertNoDirectSelfForwardLoop({
            host,
            sourcePort: Number(template.sourcePort),
            targetIp: template.targetIp,
            targetPort: Number(template.targetPort),
            tunnelId: null,
          });
        } catch {
          throw new Error(`成员主机「${(host as any)?.name || hostId}」加入后，规则「${template.name || template.id}」会在它上面把 ${template.sourcePort} 端口转发回自己的同一端口，造成转发死循环。请先修改规则目标或端口`);
        }
      }
    }
  }
}

export async function replaceForwardGroupMembers(
  groupId: number,
  members: ForwardGroupMemberInput[],
  options: { skipSync?: boolean; deferRefresh?: boolean; scheduleAt?: Date } = {},
) {
  try {
    return await replaceForwardGroupMembersUnwatched(groupId, members, options);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function replaceForwardGroupMembersUnwatched(
  groupId: number,
  members: ForwardGroupMemberInput[],
  options: { skipSync?: boolean; deferRefresh?: boolean; scheduleAt?: Date } = {},
) {
  const group = await getForwardGroupById(groupId);
  const groupMode = forwardGroupModeOf(group);
  const externalEntry = (groupMode === "chain" || groupMode === "port") && Number((group as any)?.entryGroupId || 0) > 0;
  if (members.length === 0 && !(groupMode === "port" && externalEntry)) throw new Error("转发组至少需要一个成员");
  validateForwardGroupModeMembers(groupMode, String((group as any)?.groupType || "host"), members, { externalEntry });
  const normalizedMembers = await Promise.all(members.map((member, index) => normalizeForwardGroupMemberInput(groupMode, member, index, { externalEntry })));
  await validateForwardGroupRecordMembers(group, normalizedMembers as any);
  const db = await getDb();
  const existing = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
  const previousHostIds = (existing as any[])
    .filter((member) => member.memberType === "host")
    .map((member) => Number(member.hostId || 0))
    .filter((hostId) => Number.isFinite(hostId) && hostId > 0);
  const keepKeys = new Set(normalizedMembers.map((m) => `${m.memberType}:${m.memberType === "host" ? m.hostId : m.tunnelId}`));
  await assertMemberChangeHasNoSelfForwardLoop(group, groupMode, existing as any[], normalizedMembers as any[]);
  if (groupMode === "entry" && dbBool((group as any)?.isEnabled)) {
    // 新加入（或重新启用）的入口组主机会替组里所有隧道的规则监听 sourcePort，
    // 写成员之前先查端口，冲突就整体拒绝，别写一半。
    const previousEnabledHostIds = new Set((existing as any[])
      .filter((member) => member.memberType === "host" && dbBool(member.isEnabled, true))
      .map((member) => Number(member.hostId || 0)));
    const addedHostIds = normalizedMembers
      .filter((member) => member.memberType === "host" && dbBool(member.isEnabled, true))
      .map((member) => Number(member.hostId || 0))
      .filter((hostId) => hostId > 0 && !previousEnabledHostIds.has(hostId));
    if (addedHostIds.length > 0) {
      const tunnelRows = await db.select({ id: tunnels.id }).from(tunnels).where(eq(tunnels.entryGroupId, groupId));
      await assertTunnelRulePortsFreeOnEntryHosts((tunnelRows as any[]).map((row) => Number(row.id)), addedHostIds);
    }
  }

  if (groupMode !== "chain" && !isCollectionGroupMode(groupMode) && dbBool((group as any)?.isEnabled)) {
    // 成员写进库之后，同步会给每个启用的成员按模板端口建子规则；端口被占就会在同步里
    // 抛错 —— 那时成员已经写了一半，之后每次同步（含自愈）都会卡在同一个冲突上。
    // 所以写之前先按新的成员集合把每个模板的端口查一遍，冲突就整体拒绝。
    const templates = (await getForwardGroupTemplateRules(groupId) as any[]).filter((template) => dbBool(template?.isEnabled));
    if (templates.length > 0) {
      const memberKey = (member: any) => `${member.memberType}:${member.memberType === "host" ? member.hostId : member.tunnelId}`;
      const removedChildIds: number[] = [];
      for (const old of existing as any[]) {
        if (keepKeys.has(memberKey(old))) continue;
        for (const child of await getForwardGroupChildRulesForMember(Number(old.id)) as any[]) removedChildIds.push(Number(child.id));
      }
      for (const member of normalizedMembers) {
        if (!dbBool(member.isEnabled, true)) continue;
        if (member.memberType === "tunnel") {
          const tunnel = await getTunnelById(Number(member.tunnelId));
          if (!tunnel || !dbBool((tunnel as any).isEnabled)) continue;
        }
        const hostId = await targetHostIdForMember(member);
        const found = (existing as any[]).find((row) => memberKey(row) === memberKey(member));
        for (const template of templates) {
          const child = found ? await existingChildRule(Number(template.id), Number(found.id)) : undefined;
          const ignoreRuleIds = [Number(template.id), Number(child?.id || 0), ...removedChildIds].filter((id) => id > 0);
          if (await isPortUsedOnHostForGroupChild(hostId, Number(template.sourcePort), ignoreRuleIds, template.protocol, template.sourcePortEnd)) {
            const host = await getHostById(hostId) as any;
            throw new Error(`成员主机「${host?.name || hostId}」上端口 ${template.sourcePort} 已被占用，无法为规则「${template.name || template.id}」建立转发，请先更换端口或移除占用`);
          }
        }
      }
    }
  }

  /*
    删掉去掉的成员、写入留下 / 新加的成员放在一个事务里（P5）：以前是一条条直接写，中途哪一步失败
    （写库报错、主机刚好被删）就留下「旧成员删了一半、新成员没写上」的组 —— 主备组可能一个成员都不剩。
    现在要么整份换成新的，要么原样不动。已经在别人的事务里（转发链保存）时直接并进去。
    事务里收子规则只标待删，结算、通知 Agent、收中继都在提交之后（removeManagedRule、afterForwardGroupSyncCommit）；
    事务里要用事务自己的连接（getDb 在事务里返回它），所以这里重新取一次。
  */
  await withDatabaseTransaction(async () => {
  const db = await getDb();
  for (const old of existing as any[]) {
    const key = `${old.memberType}:${old.memberType === "host" ? old.hostId : old.tunnelId}`;
    if (!keepKeys.has(key)) {
      const childRules = await getForwardGroupChildRulesForMember(Number(old.id));
      for (const rule of childRules as any[]) await removeManagedRule(Number(rule.id), options);
      if (old.ruleId) await removeManagedRule(Number(old.ruleId), options);
      await db.delete(forwardGroupMembers).where(eq(forwardGroupMembers.id, old.id));
    }
  }

  const current = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
  for (const [index, member] of normalizedMembers.entries()) {
    await targetHostIdForMember(member);
    const found = (current as any[]).find((row) => row.memberType === member.memberType
      && Number(row.memberType === "host" ? row.hostId : row.tunnelId) === Number(member.memberType === "host" ? member.hostId : member.tunnelId));
    const payload: Partial<InsertForwardGroupMember> = {
      priority: member.priority ?? index,
      ...memberSchedulePayload(groupMode, member, found, options.scheduleAt),
      connectHost: member.connectHost ?? null,
      bandwidthMbps: normalizeMemberBandwidthMbps(member.bandwidthMbps),
      aggregationWeight: normalizeMemberWeight(member.aggregationWeight),
      // 线路没传（节点池同步、时段切换这些只改别的字段的写入方）= 不动原来的分线路配置。
      ...(member.ddnsLines !== undefined ? { ddnsLines: serializeDdnsLines(member.ddnsLines) } : {}),
      updatedAt: nowDate(),
    } as any;
    if (found) {
      await db.update(forwardGroupMembers).set(payload).where(eq(forwardGroupMembers.id, found.id));
    } else {
      await insertAndGetId("forward_group_members", {
        groupId,
        memberType: member.memberType,
        hostId: member.memberType === "host" ? member.hostId : null,
        tunnelId: member.memberType === "tunnel" ? member.tunnelId : null,
        connectHost: member.connectHost ?? null,
        priority: member.priority ?? index,
        // dbBool 来自上游：MySQL 会把布尔返回成字符串 "0"，用 ?? 的话会当成真值。
        ...memberSchedulePayload(groupMode, member, null, options.scheduleAt),
        bandwidthMbps: normalizeMemberBandwidthMbps(member.bandwidthMbps),
        aggregationWeight: normalizeMemberWeight(member.aggregationWeight),
        ddnsLines: serializeDdnsLines(member.ddnsLines),
        createdAt: nowDate(),
        updatedAt: nowDate(),
      });
    }
  }
  });
  // 组的第一个成员就是订阅里的入口机器，成员一变订阅缓存就得作废。
  invalidateProxySubCacheAll();
  if (options.skipSync) return;
  if (isCollectionGroupMode(groupMode)) {
    await runForwardGroupFailover(groupId, { forceSync: true, manual: true });
    await refreshForwardGroupReferences(groupId, {
      reason: `${groupMode}-group-members-updated`,
      previousHostIds,
    });
  } else {
    await syncForwardGroupRules(groupId);
    /*
      主备组改了成员马上评估一次（P4）：定时启停、节点池同步改成员走的也是这里，以前只同步子规则、
      不重选活动成员 —— 活动成员被停用 / 去掉之后，解析还指着它，要等下一次健康上报或巡检才换。
      走健康上报用的那条防抖队列（不在这里内联跑：调用方可能拿着编辑锁，DNS 写入不该卡在里面）。
    */
    if (groupMode === "failover") scheduleForwardGroupFailover([groupId]);
  }
}

/** 把这个组当入口组 / 出口组用的隧道，以及把它当入口组的转发链、端口转发（chains 里按 groupMode 分）。 */
export async function getForwardGroupEndpointReferences(groupId: number) {
  const db = await getDb();
  if (!db) return { tunnels: [] as any[], chains: [] as any[] };
  const [tunnelRows, chainRows] = await Promise.all([
    db.select({ id: tunnels.id, name: tunnels.name }).from(tunnels)
      .where(or(eq(tunnels.entryGroupId, groupId), eq(tunnels.exitGroupId, groupId))),
    db.select({ id: forwardGroups.id, name: forwardGroups.name, groupMode: forwardGroups.groupMode }).from(forwardGroups)
      .where(and(eq(forwardGroups.entryGroupId, groupId), sql`${forwardGroups.id} <> ${groupId}`)),
  ]);
  return { tunnels: tunnelRows as any[], chains: chainRows as any[] };
}

export async function deleteForwardGroup(id: number) {
  try {
    return await deleteForwardGroupUnwatched(id);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function deleteForwardGroupUnwatched(id: number) {
  const db = await getDb();
  // 删之前留一份（带成员）：删完要按它发布过的值把解析记录清掉（clearForwardGroupPublishedDdns）。
  const groupBeforeDelete = await getForwardGroupById(id).catch(() => null);
  const childRules = await getForwardGroupChildRules(id);
  for (const rule of childRules as any[]) await removeManagedRule(Number(rule.id));
  const templates = await getForwardGroupTemplateRules(id);
  for (const template of templates as any[]) {
    const billingResource = await findTrafficBillingResourceForRule(template);
    const fallback = trafficBillingResourceCandidatesForRule(template)[0];
    const resource = billingResource || fallback;
    const billed = await settleAndMarkForwardGroupRulePendingDelete(template, resource);
    if (billed && Number(billed.balanceAfterCents) < 0) {
      await handleTrafficBillingShortfallLazily(Number((template as any).userId), "group-delete-settlement-negative");
    }
    // 模板从不在 Agent 上运行，等不到停止确认；结算完直接收掉（同 deleteForwardRuleForActor）。
    await finalizeForwardRuleDelete(Number(template.id));
  }
  const members = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, id));
  for (const member of members as any[]) {
    if (member.ruleId) await removeManagedRule(Number(member.ruleId));
  }
  await db.delete(forwardGroupEvents).where(eq(forwardGroupEvents.groupId, id));
  await db.delete(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, id));
  await db.delete(userForwardGroupPermissions).where(eq(userForwardGroupPermissions.forwardGroupId, id));
  /**
   * 套餐里绑着它的那一行也要删。
   *
   * 留着的话套餐会继续宣称带着一个已经不存在的转发组：商店上的数量多一个，
   * 管理端的套餐编辑里显示成一个只有编号的空壳，而买了这个套餐的人拿到的是
   * 一条指向不存在资源的授权。主机那一路一直是这么删的，这几路当初漏了。
   */
  await db.delete(subscriptionPlanForwardGroups).where(eq(subscriptionPlanForwardGroups.forwardGroupId, id));
  await db.delete(forwardGroups).where(eq(forwardGroups.id, id));
  forwardGroupHealthRechecks.replace(id, null);
  exactDdnsReconciledGroups.delete(id);
  /*
    组行删掉之后再清解析，并且拿评估用的那把锁：正在跑的一轮评估（可能还要写一次服务商）先跑完，
    之后的评估读不到组就直接返回，不会在清完之后又把记录写回去。清理失败不影响删除（里面自己记日志）。
  */
  if (groupBeforeDelete) {
    await withKeyedTaskLock(`forward-group-failover:${id}`, () => clearForwardGroupPublishedDdns(groupBeforeDelete))
      .catch((error) => appendPanelLog("warn", `[DDNS] 转发组 ${id} 已删除，清理解析记录时出错：${error instanceof Error ? error.message : String(error)}`));
  }
}

/**
 * Read the bandwidth aggregation status of one entry group.
 *
 * Unlike the DDNS sync path this never mutates member health; it reports the
 * health already stored on each member so the panel can show which front VPS
 * hosts are carrying the aggregate and how much headroom is left.
 */
export async function getForwardGroupBandwidthAggregation(groupId: number) {
  const group = await getForwardGroupById(Number(groupId)) as any;
  if (!group) throw new Error("入口组不存在");
  if (forwardGroupModeOf(group) !== "entry") throw new Error("仅入口组支持带宽聚合");

  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const chinaHealthEnabled = dbBool(group.chinaHealthCheckEnabled);
  const now = Date.now();
  const members: AggregationMemberRow[] = [];
  for (const member of sortedMembers(group) as any[]) {
    if (member.memberType !== "host") continue;
    const value = String(member.ddnsValue || "").trim()
      || await memberDdnsValue(member, recordType).catch(() => "");
    if (!value) continue;
    const liveness = await resolveMemberAgentLiveness(member, now).catch(() => ({ available: false } as any));
    const healthy = !!dbBool(member.isEnabled)
      && !!liveness.available
      && (chinaHealthEnabled
        ? forwardGroupChinaHealthStateAt(member, now) === "healthy"
        : forwardGroupAgentHealthStateAt(member, now) === "healthy");
    const host = await getHostById(Number(member.hostId)).catch(() => null) as any;
    members.push({
      memberId: Number(member.id || 0),
      hostId: Number(member.hostId || 0),
      value,
      healthy,
      // 成员上没填就用主机的「线路带宽」。
      bandwidthMbps: Number(member.bandwidthMbps || 0) || Math.max(0, Number(host?.lineBandwidthMbps) || 0),
      aggregationWeight: Number(member.aggregationWeight || 0),
      label: String(host?.name || "").trim() || value,
    });
  }

  const plan = buildEntryGroupAggregationPlan({
    group,
    members,
    throughputByHostId: await memberThroughputMbps(members),
    singleValuePerMember: recordType === "CNAME",
  });
  return {
    groupId: Number(group.id),
    groupName: String(group.name || ""),
    domain: String(group.domain || ""),
    recordType,
    rateLimitMbps: Number(group.rateLimitMbps || 0),
    ...summarizeAggregationPlan(group, plan),
  };
}

/**
 * 成员优先级按给的次序写成 0..n-1，所以必须拿到**这个组的完整成员集合**：
 * 少带了的成员保留旧 priority，会和新写的撞号（主备挑成员就看 priority，撞号等于次序随机）；
 * 夹带别的组的 id 以前会被 where 静悄悄吞掉，前端却以为排好了。整体校验通过后在一个事务里写，
 * 不会留下一半新一半旧的顺序。
 */
export async function reorderForwardGroupMembers(groupId: number, memberIds: number[]) {
  try {
    return await reorderForwardGroupMembersUnwatched(groupId, memberIds);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function reorderForwardGroupMembersUnwatched(groupId: number, memberIds: number[]) {
  const orderedIds = memberIds.map((id) => Math.floor(Number(id)));
  if (orderedIds.length === 0 || orderedIds.some((id) => !Number.isInteger(id) || id <= 0) || new Set(orderedIds).size !== orderedIds.length) {
    throw new Error("成员排序数据无效：成员不能为空或重复");
  }
  await withDatabaseTransaction(async () => {
    const db = await getDb();
    const rows = await db.select({ id: forwardGroupMembers.id }).from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
    const current = new Set((rows as any[]).map((row) => Number(row.id)));
    if (current.size !== orderedIds.length || orderedIds.some((id) => !current.has(id))) {
      throw new Error("成员列表和当前转发组不一致（可能刚被改过），请刷新后按完整的成员顺序重新提交");
    }
    for (const [index, memberId] of orderedIds.entries()) {
      await db.update(forwardGroupMembers).set({ priority: index, updatedAt: nowDate() }).where(and(
        eq(forwardGroupMembers.groupId, groupId),
        eq(forwardGroupMembers.id, memberId),
      ));
    }
    await insertForwardGroupEvent(groupId, null, "reorder", "Member priority updated.");
  });
  invalidateProxySubCacheAll();
}

export async function syncForwardChainsForHost(hostId: number, previousHost?: any) {
  const db = await getDb();
  if (!db) return;
  const currentHost = await getHostById(hostId);
  const rows = await db
    .select({
      groupId: forwardGroupMembers.groupId,
    })
    .from(forwardGroupMembers)
    .where(and(
      eq(forwardGroupMembers.memberType, "host"),
      eq(forwardGroupMembers.hostId, hostId),
    ));
  const groupIds = Array.from(new Set((rows as any[]).map((row) => Number(row.groupId)).filter((id) => id > 0)));
  for (const groupId of groupIds) {
    const group = await getForwardGroupById(groupId);
    const mode = forwardGroupModeOf(group);
    if (mode === "entry") await runForwardGroupFailover(groupId);
    if (mode === "chain") {
      const members = sortedMembers(group) as any[];
      const entryMembers = await chainEntryMembers(group);
      const hasExternalEntry = entryMembers.length > 0;
      const currentPrivate = privateAddressForHost(currentHost);
      const currentIpv6 = ipv6AddressForConnectHost(currentHost);
      const previousPublic = entryAddressForHost(previousHost);
      const previousPrivate = privateAddressForHost(previousHost);
      const previousIpv6 = ipv6AddressForConnectHost(previousHost);
      for (const [index, member] of members.entries()) {
        if (Number(member.hostId || 0) !== Number(hostId)) continue;
        const stored = String(member.connectHost || "").trim();
        let nextConnectHost: string | null | undefined;
        if (index === 0 && !hasExternalEntry) {
          nextConnectHost = null;
        } else if (previousPrivate && stored === previousPrivate) {
          nextConnectHost = currentPrivate || null;
        } else if (previousIpv6 && stored === previousIpv6) {
          nextConnectHost = currentIpv6 || null;
        } else if (previousPublic && stored === previousPublic) {
          nextConnectHost = null;
        }
        if (nextConnectHost !== undefined && (stored || null) !== nextConnectHost) {
          await db.update(forwardGroupMembers).set({
            connectHost: nextConnectHost,
            updatedAt: nowDate(),
          } as any).where(eq(forwardGroupMembers.id, member.id));
        }
      }
      await syncForwardGroupRules(groupId, { validatePorts: false, createMissing: false });
    }
  }
}
