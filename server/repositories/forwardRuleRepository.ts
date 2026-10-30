import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { invalidateProxySubCacheForUser } from "../proxySubCache";
import { forwardGroupMembers, forwardGroups, forwardRuleRouteEvents, forwardRuleTunnelExits, forwardRules, InsertForwardRule, tunnels } from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { queryRaw } from "../dbRuntime";
import { boolLiteral, boolValue, inList, quoteIdentifier } from "../dbCompat";
import { describePortPolicy, isPortAllowedByPolicy, portPolicyFrom, portPolicyHasRestriction, type PortPolicySource } from "@shared/portPolicy";
import { sqlBool } from "./repositoryUtils";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import { recordConfigAuditEvent, shouldAuditConfigPatch } from "../configAudit";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { reorderWithinSortOrderScope } from "./sortOrderSlots";
import { recordRuleEntryDomainCleanupsBeforeDelete } from "./ruleEntryDomainRepository";
import { signalRuleEntryDomainChanged, signalRuleEntryDomainCleanup } from "../ruleEntryDomainSignals";
import { releaseRuleSniNames } from "./tlsInboundRepository";

/*
  规则专属域名（server/ruleEntryDomain.ts）跟着这几列走：入口主机、开关、删除、订阅绑定、
  规则上的「专属域名」开关。在仓库这一层挂钩，面板、Telegram 机器人、转发组各条改规则的路
  都不用各自记得通知；只是尽力通知，漏了有定时对账兜底。
*/
const RULE_ENTRY_DOMAIN_FIELDS = [
  "hostId", "isEnabled", "pendingDelete", "isForwardGroupTemplate", "routeParentRuleId", "proxyNodeId", "proxyNodeVisible",
  "entryDomainEnabled",
] as const;

// ==================== Forward Rule Queries ====================

export type ForwardRuleSortCategory = "local" | "tunnel" | "chain" | "group";

function forwardRuleCategoryFromRow(row: any): ForwardRuleSortCategory {
  const groupMode = String(row?.groupMode || "").toLowerCase();
  if (groupMode === "port") return "local";
  if (groupMode === "chain") return "chain";
  if (Number(row?.forwardGroupId || 0) > 0) return "group";
  if (Number(row?.tunnelId || 0) > 0) return "tunnel";
  return "local";
}

function forwardRuleCategorySql(ruleAlias = "r", groupAlias = "g") {
  const q = quoteIdentifier;
  return `CASE
    WHEN ${groupAlias}.${q("groupMode")} = 'port' THEN 'local'
    WHEN ${groupAlias}.${q("groupMode")} = 'chain' THEN 'chain'
    WHEN ${ruleAlias}.${q("forwardGroupId")} IS NOT NULL AND ${ruleAlias}.${q("forwardGroupId")} <> 0 THEN 'group'
    WHEN ${ruleAlias}.${q("tunnelId")} IS NOT NULL AND ${ruleAlias}.${q("tunnelId")} <> 0 THEN 'tunnel'
    ELSE 'local'
  END`;
}

async function forwardRuleCategoryForPayload(rule: Partial<InsertForwardRule>): Promise<ForwardRuleSortCategory> {
  const groupId = Number((rule as any).forwardGroupId || 0);
  if (groupId > 0) {
    const q = quoteIdentifier;
    const rows = await queryRaw<{ groupMode: string }>(
      `SELECT ${q("groupMode")} AS ${q("groupMode")} FROM ${q("forward_groups")} WHERE ${q("id")} = ? LIMIT 1`,
      [groupId],
    ).catch(() => []);
    const mode = String(rows[0]?.groupMode || "").toLowerCase();
    if (mode === "port") return "local";
    if (mode === "chain") return "chain";
    return "group";
  }
  return Number((rule as any).tunnelId || 0) > 0 ? "tunnel" : "local";
}

async function nextForwardRuleSortOrder(userId: number, category: ForwardRuleSortCategory) {
  const q = quoteIdentifier;
  const rows = await queryRaw<{ nextSortOrder: number }>(
    `SELECT COALESCE(MAX(r.${q("sortOrder")}), -1) + 1 AS ${q("nextSortOrder")}
       FROM ${q("forward_rules")} r
       LEFT JOIN ${q("forward_groups")} g ON g.${q("id")} = r.${q("forwardGroupId")}
      WHERE r.${q("userId")} = ?
        AND r.${q("pendingDelete")} = ?
        AND r.${q("forwardGroupRuleId")} IS NULL
        AND r.${q("id")} NOT IN (
          SELECT ${q("ruleId")} FROM ${q("forward_group_members")} WHERE ${q("ruleId")} IS NOT NULL
        )
        AND ${forwardRuleCategorySql("r", "g")} = ?`,
    [userId, boolValue(false), category],
  ).catch(() => []);
  const value = Number(rows[0]?.nextSortOrder || 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export async function getForwardRules(userId?: number, hostId?: number, options: { failoverOnly?: boolean } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [
    sql`COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    sql`COALESCE(${forwardRules.forwardGroupRuleId}, 0) = 0`,
    // 线路组在中转机上生成的中继规则由面板维护，不进用户的列表（见 server/routeGroups.ts）。
    sql`COALESCE(${forwardRules.routeParentRuleId}, 0) = 0`,
    sql`${forwardRules.id} NOT IN (SELECT ${forwardGroupMembers.ruleId} FROM ${forwardGroupMembers} WHERE ${forwardGroupMembers.ruleId} IS NOT NULL)`,
  ];
  if (userId) conds.push(eq(forwardRules.userId, userId));
  if (hostId) conds.push(eq(forwardRules.hostId, hostId));
  // 线路组面板只要开了主备 / 线路组的规则：在库里筛，别把全站规则整表读出来、序列化完再让前端丢掉九成。
  if (options.failoverOnly) conds.push(sql`${forwardRules.failoverEnabled} = ${sqlBool(true)}`);
  return db.select().from(forwardRules).where(and(...conds)).orderBy(sql`${forwardRules.sortOrder} ASC`, desc(forwardRules.createdAt), desc(forwardRules.id));
}


/** 名下有带这条停用原因的规则的用户（自愈扫描用）。 */
export async function getUserIdsWithRuleBlockReason(reason: string) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ userId: forwardRules.userId }).from(forwardRules).where(and(
    eq(forwardRules.protocolBlockReason, reason),
    eq(forwardRules.pendingDelete, false),
  )).groupBy(forwardRules.userId);
  return (rows as any[]).map((row) => Number(row.userId || 0)).filter((id) => Number.isInteger(id) && id > 0);
}

/** 名下有「因账户暂停而停」规则的用户（自愈扫描用）。 */
export async function getUserIdsWithAccessPausedRules() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ userId: forwardRules.userId }).from(forwardRules).where(and(
    eq(forwardRules.disabledByUser, true),
    eq(forwardRules.pendingDelete, false),
  )).groupBy(forwardRules.userId);
  return (rows as any[]).map((row) => Number(row.userId || 0)).filter((id) => Number.isInteger(id) && id > 0);
}

export type ForwardRuleListCategory = "all" | "local" | "tunnel" | "chain" | "group";
/**
 * A concrete link resource selected by the Rules page's two-level filter.
 * `local` refers to a saved port-forward group (groupMode=port), while
 * `tunnel`, `chain`, and `group` refer to their corresponding root resource.
 */
export type ForwardRuleResourceType = "local" | "tunnel" | "chain" | "group";

export type ForwardRuleListQuery = PageRequest & {
  ownerUserId?: number;
  /** Root resources whose related metadata may participate in user search. */
  searchVisibleHostIds?: number[];
  searchVisibleTunnelIds?: number[];
  searchVisibleForwardGroupIds?: number[];
  entryHostId?: number | null;
  resourceType?: ForwardRuleResourceType | null;
  resourceId?: number | null;
  category: ForwardRuleListCategory;
  search?: string;
};

type ForwardRuleFilterControls = {
  includeEntryHost?: boolean;
  includeResource?: boolean;
  includeSearch?: boolean;
  includeCategory?: boolean;
};

type ForwardRuleSqlFilter = {
  fromSql: string;
  whereSql: string;
  params: any[];
  categorySql: string;
};

function escapeForwardRuleSearchToken(value: string) {
  return value.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

function ruleColumn(alias: string, column: string) {
  return alias + "." + quoteIdentifier(column);
}

function forwardRuleListCategorySql() {
  const groupMode = ruleColumn("g", "groupMode");
  return [
    "CASE",
    "  WHEN " + groupMode + " = 'port' THEN 'local'",
    "  WHEN " + groupMode + " = 'chain' THEN 'chain'",
    "  WHEN " + ruleColumn("g", "id") + " IS NOT NULL THEN 'group'",
    "  WHEN " + ruleColumn("r", "forwardType") + " = 'gost'",
    "    AND COALESCE(" + ruleColumn("r", "tunnelId") + ", 0) <> 0 THEN 'tunnel'",
    "  ELSE 'local'",
    "END",
  ].join("\n");
}

function forwardRuleEntryHostSql() {
  return [
    "COALESCE(",
    "  CASE WHEN " + ruleColumn("g", "id") + " IS NOT NULL THEN (",
    "    SELECT COALESCE(" + ruleColumn("gm_entry", "hostId") + ", " + ruleColumn("mt_entry", "entryHostId") + ")",
    "      FROM " + quoteIdentifier("forward_group_members") + " gm_entry",
    "      LEFT JOIN " + quoteIdentifier("tunnels") + " mt_entry",
    "        ON " + ruleColumn("mt_entry", "id") + " = " + ruleColumn("gm_entry", "tunnelId"),
    "     WHERE " + ruleColumn("gm_entry", "groupId") + " = " + ruleColumn("g", "id"),
    "       AND " + ruleColumn("gm_entry", "isEnabled") + " = " + boolLiteral(true),
    "       AND (COALESCE(" + ruleColumn("gm_entry", "hostId") + ", 0) <> 0",
    "         OR COALESCE(" + ruleColumn("gm_entry", "tunnelId") + ", 0) <> 0)",
    "     ORDER BY " + ruleColumn("gm_entry", "priority") + " ASC, " + ruleColumn("gm_entry", "id") + " ASC",
    "     LIMIT 1",
    "  ) END,",
    "  " + ruleColumn("t", "entryHostId") + ",",
    "  " + ruleColumn("r", "hostId"),
    ")",
  ].join("\n");
}

function forwardRuleEntryHostFilter(input: ForwardRuleListQuery, entryHostId: number) {
  const hasScopedResources = input.searchVisibleHostIds !== undefined
    || input.searchVisibleTunnelIds !== undefined
    || input.searchVisibleForwardGroupIds !== undefined;
  if (!hasScopedResources) {
    return { sql: forwardRuleEntryHostSql() + " = ?", params: [entryHostId] };
  }

  const clauses: string[] = [];
  const params: any[] = [];
  const addVisibleRoot = (
    rootExpression: string,
    visibleIds: number[] | undefined,
    entryExpression: string,
    rootConditions: string[],
  ) => {
    const conditions = [...rootConditions];
    if (visibleIds !== undefined) {
      const ids = normalizeForwardRuleIds(visibleIds);
      if (ids.length === 0) return;
      const visible = inList(ids);
      conditions.push(rootExpression + " IN " + visible.sql);
      params.push(...visible.params);
    }
    conditions.push(entryExpression + " = ?");
    params.push(entryHostId);
    clauses.push("(" + conditions.join(" AND ") + ")");
  };

  addVisibleRoot(
    ruleColumn("r", "forwardGroupId"),
    input.searchVisibleForwardGroupIds,
    forwardRuleEntryHostSql(),
    ["COALESCE(" + ruleColumn("r", "forwardGroupId") + ", 0) <> 0", ruleColumn("g", "id") + " IS NOT NULL"],
  );
  addVisibleRoot(
    ruleColumn("r", "tunnelId"),
    input.searchVisibleTunnelIds,
    ruleColumn("t", "entryHostId"),
    [
      "COALESCE(" + ruleColumn("r", "forwardGroupId") + ", 0) = 0",
      "COALESCE(" + ruleColumn("r", "tunnelId") + ", 0) <> 0",
      ruleColumn("t", "id") + " IS NOT NULL",
    ],
  );
  addVisibleRoot(
    ruleColumn("r", "hostId"),
    input.searchVisibleHostIds,
    ruleColumn("r", "hostId"),
    [
      "COALESCE(" + ruleColumn("r", "forwardGroupId") + ", 0) = 0",
      "COALESCE(" + ruleColumn("r", "tunnelId") + ", 0) = 0",
    ],
  );

  return {
    sql: clauses.length > 0 ? "(" + clauses.join(" OR ") + ")" : "1 = 0",
    params,
  };
}

function forwardRuleListFromSql() {
  return [
    "FROM " + quoteIdentifier("forward_rules") + " r",
    "LEFT JOIN " + quoteIdentifier("forward_groups") + " g",
    "  ON " + ruleColumn("g", "id") + " = " + ruleColumn("r", "forwardGroupId"),
    "LEFT JOIN " + quoteIdentifier("tunnels") + " t",
    "  ON " + ruleColumn("t", "id") + " = " + ruleColumn("r", "tunnelId"),
    "LEFT JOIN " + quoteIdentifier("users") + " u",
    "  ON " + ruleColumn("u", "id") + " = " + ruleColumn("r", "userId"),
  ].join("\n");
}

function pushForwardRuleLike(clauses: string[], params: any[], expression: string, pattern: string) {
  clauses.push("LOWER(COALESCE(" + expression + ", '')) LIKE ? ESCAPE '!'");
  params.push(pattern);
}

function normalizeForwardRuleIds(values: unknown[] | undefined) {
  return Array.from(new Set((values || [])
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function pushScopedForwardRuleSearch(
  clauses: string[],
  params: any[],
  idExpression: string,
  visibleIds: number[] | undefined,
  scopedClauses: string[],
  scopedParams: any[],
) {
  if (scopedClauses.length === 0) return;
  if (visibleIds === undefined) {
    clauses.push("(" + scopedClauses.join(" OR ") + ")");
    params.push(...scopedParams);
    return;
  }
  const ids = normalizeForwardRuleIds(visibleIds);
  if (ids.length === 0) return;
  const visible = inList(ids);
  clauses.push("(" + idExpression + " IN " + visible.sql + " AND (" + scopedClauses.join(" OR ") + "))");
  params.push(...visible.params, ...scopedParams);
}

function buildForwardRuleSqlFilter(
  input: ForwardRuleListQuery,
  controls: ForwardRuleFilterControls = {},
): ForwardRuleSqlFilter {
  const includeEntryHost = controls.includeEntryHost !== false;
  const includeResource = controls.includeResource !== false;
  const includeSearch = controls.includeSearch !== false;
  const includeCategory = controls.includeCategory !== false;
  const categorySql = forwardRuleListCategorySql();
  const conditions = [
    "COALESCE(" + ruleColumn("r", "pendingDelete") + ", " + boolLiteral(false) + ") = " + boolLiteral(false),
    "COALESCE(" + ruleColumn("r", "forwardGroupRuleId") + ", 0) = 0",
    "COALESCE(" + ruleColumn("r", "routeParentRuleId") + ", 0) = 0",
    "NOT EXISTS (SELECT 1 FROM " + quoteIdentifier("forward_group_members") + " linked_member"
      + " WHERE " + ruleColumn("linked_member", "ruleId") + " = " + ruleColumn("r", "id") + ")",
  ];
  const params: any[] = [];

  const ownerUserId = Math.floor(Number(input.ownerUserId || 0));
  if (ownerUserId > 0) {
    conditions.push(ruleColumn("r", "userId") + " = ?");
    params.push(ownerUserId);
  }

  if (includeEntryHost && Number(input.entryHostId || 0) > 0) {
    const entryHostFilter = forwardRuleEntryHostFilter(input, Number(input.entryHostId));
    conditions.push(entryHostFilter.sql);
    params.push(...entryHostFilter.params);
  }

  const resourceId = Math.floor(Number(input.resourceId || 0));
  const resourceType = input.resourceType || null;
  if (includeResource && resourceType) {
    if (!["local", "tunnel", "chain", "group"].includes(resourceType)) {
      conditions.push("1 = 0");
    } else if (resourceId <= 0) {
      // A type-only selection is the first level of the two-level picker.
      conditions.push(categorySql + " = ?");
      params.push(resourceType);
    } else {
      // Keep the resource predicate explicit instead of relying only on the
      // category CASE expression.  This prevents an id collision between a
      // host, tunnel, and forward group from selecting an unrelated rule.
      const resourceColumn = ruleColumn("r", "forwardGroupId");
      if (resourceType === "tunnel") {
        conditions.push(
          "(" + ruleColumn("r", "tunnelId") + " = ? AND "
          + "COALESCE(" + ruleColumn("r", "forwardGroupId") + ", 0) = 0)",
        );
        params.push(resourceId);
      } else {
        const expectedGroupMode = resourceType === "local" ? "port" : resourceType === "chain" ? "chain" : "failover";
        const groupModeColumn = ruleColumn("g", "groupMode");
        const groupModePredicate = expectedGroupMode === "failover"
          // Older rows may have a NULL/legacy groupMode; the application
          // normalizer treats those values as failover groups.
          ? "(" + groupModeColumn + " = 'failover' OR " + groupModeColumn + " IS NULL"
            + " OR " + groupModeColumn + " NOT IN ('port', 'chain', 'entry', 'exit'))"
          : groupModeColumn + " = ?";
        conditions.push(
          "(" + resourceColumn + " = ? AND " + groupModePredicate + ")",
        );
        params.push(resourceId);
        if (expectedGroupMode !== "failover") params.push(expectedGroupMode);
      }
    }
  }
  const tokens = includeSearch
    ? String(input.search || "").trim().toLowerCase().split(/\s+/).filter(Boolean)
    : [];
  for (const token of tokens) {
    const pattern = "%" + escapeForwardRuleSearchToken(token) + "%";
    const tokenClauses: string[] = [];
    const tokenParams: any[] = [];

    for (const expression of [
      ruleColumn("r", "name"),
      ruleColumn("r", "forwardType"),
      ruleColumn("r", "protocol"),
      ruleColumn("r", "gostMode"),
      ruleColumn("r", "gostRelayHost"),
      ruleColumn("r", "targetIp"),
      ruleColumn("r", "protocolBlockReason"),
      ruleColumn("r", "failoverStrategy"),
      ruleColumn("r", "failoverTargets"),
      ruleColumn("u", "username"),
      ruleColumn("u", "name"),
      ruleColumn("u", "email"),
      ruleColumn("u", "displayRemark"),
    ]) {
      pushForwardRuleLike(tokenClauses, tokenParams, expression, pattern);
    }

    const groupClauses: string[] = [];
    const groupParams: any[] = [];
    for (const expression of [
      ruleColumn("g", "name"),
      ruleColumn("g", "remark"),
      ruleColumn("g", "groupType"),
      ruleColumn("g", "groupMode"),
      ruleColumn("g", "forwardType"),
      ruleColumn("g", "domain"),
      ruleColumn("g", "recordType"),
      ruleColumn("g", "targetIp"),
      ruleColumn("g", "lastDdnsValue"),
      ruleColumn("g", "lastStatus"),
      ruleColumn("g", "lastMessage"),
    ]) {
      pushForwardRuleLike(groupClauses, groupParams, expression, pattern);
    }
    pushScopedForwardRuleSearch(
      tokenClauses,
      tokenParams,
      ruleColumn("g", "id"),
      input.searchVisibleForwardGroupIds,
      groupClauses,
      groupParams,
    );

    const tunnelClauses: string[] = [];
    const tunnelParams: any[] = [];
    for (const expression of [
      ruleColumn("t", "name"),
      ruleColumn("t", "mode"),
      ruleColumn("t", "forwardxVersion"),
      ruleColumn("t", "networkType"),
      ruleColumn("t", "connectHost"),
      ruleColumn("t", "certDomain"),
    ]) {
      pushForwardRuleLike(tunnelClauses, tunnelParams, expression, pattern);
    }
    pushScopedForwardRuleSearch(
      tokenClauses,
      tokenParams,
      ruleColumn("t", "id"),
      input.searchVisibleTunnelIds,
      tunnelClauses,
      tunnelParams,
    );

    const entryGroupClauses: string[] = [];
    const entryGroupParams: any[] = [];
    for (const expression of [
      ruleColumn("entry_group", "name"),
      ruleColumn("entry_group", "remark"),
      ruleColumn("entry_group", "domain"),
    ]) {
      pushForwardRuleLike(entryGroupClauses, entryGroupParams, expression, pattern);
    }
    pushScopedForwardRuleSearch(
      tokenClauses,
      tokenParams,
      ruleColumn("g", "id"),
      input.searchVisibleForwardGroupIds,
      ["EXISTS (SELECT 1 FROM " + quoteIdentifier("forward_groups") + " entry_group"
        + " WHERE " + ruleColumn("entry_group", "id") + " = " + ruleColumn("g", "entryGroupId")
        + " AND (" + entryGroupClauses.join(" OR ") + "))"],
      entryGroupParams,
    );

    const directHostClauses: string[] = [];
    const directHostParams: any[] = [];
    for (const expression of [
      ruleColumn("direct_host", "name"),
      ruleColumn("direct_host", "ip"),
      ruleColumn("direct_host", "ipv4"),
      ruleColumn("direct_host", "ipv6"),
      ruleColumn("direct_host", "entryIp"),
      ruleColumn("direct_host", "tunnelEntryIp"),
    ]) {
      pushForwardRuleLike(directHostClauses, directHostParams, expression, pattern);
    }
    const directHostRouteClauses: string[] = [];
    const directHostRouteParams: any[] = [];
    if (input.searchVisibleHostIds === undefined && input.searchVisibleTunnelIds === undefined) {
      directHostRouteClauses.push(
        ruleColumn("direct_host", "id") + " IN ("
        + ruleColumn("r", "hostId") + ", " + ruleColumn("t", "entryHostId") + ", " + ruleColumn("t", "exitHostId") + ")",
      );
    } else {
      const hostIds = normalizeForwardRuleIds(input.searchVisibleHostIds);
      if (hostIds.length > 0) {
        const visibleHosts = inList(hostIds);
        directHostRouteClauses.push(
          "(" + ruleColumn("g", "id") + " IS NULL AND " + ruleColumn("t", "id") + " IS NULL"
          + " AND " + ruleColumn("r", "hostId") + " IN " + visibleHosts.sql
          + " AND " + ruleColumn("direct_host", "id") + " = " + ruleColumn("r", "hostId") + ")",
        );
        directHostRouteParams.push(...visibleHosts.params);
      }
      const tunnelIds = normalizeForwardRuleIds(input.searchVisibleTunnelIds);
      if (tunnelIds.length > 0) {
        const visibleTunnels = inList(tunnelIds);
        directHostRouteClauses.push(
          "(" + ruleColumn("t", "id") + " IN " + visibleTunnels.sql
          + " AND " + ruleColumn("direct_host", "id") + " IN ("
          + ruleColumn("t", "entryHostId") + ", " + ruleColumn("t", "exitHostId") + "))",
        );
        directHostRouteParams.push(...visibleTunnels.params);
      }
    }
    if (directHostRouteClauses.length > 0) {
      tokenClauses.push(
        "EXISTS (SELECT 1 FROM " + quoteIdentifier("hosts") + " direct_host"
        + " WHERE (" + directHostRouteClauses.join(" OR ") + ")"
        + " AND (" + directHostClauses.join(" OR ") + "))",
      );
      tokenParams.push(...directHostRouteParams, ...directHostParams);
    }

    const memberClauses: string[] = [];
    const memberParams: any[] = [];
    for (const expression of [
      ruleColumn("group_member", "connectHost"),
      ruleColumn("member_host", "name"),
      ruleColumn("member_host", "ip"),
      ruleColumn("member_host", "ipv4"),
      ruleColumn("member_host", "ipv6"),
      ruleColumn("member_tunnel", "name"),
      ruleColumn("member_tunnel", "mode"),
      ruleColumn("member_tunnel", "connectHost"),
      ruleColumn("member_entry_host", "name"),
      ruleColumn("member_entry_host", "ip"),
      ruleColumn("member_exit_host", "name"),
      ruleColumn("member_exit_host", "ip"),
    ]) {
      pushForwardRuleLike(memberClauses, memberParams, expression, pattern);
    }
    pushScopedForwardRuleSearch(
      tokenClauses,
      tokenParams,
      ruleColumn("g", "id"),
      input.searchVisibleForwardGroupIds,
      ["EXISTS (SELECT 1 FROM " + quoteIdentifier("forward_group_members") + " group_member"
        + " LEFT JOIN " + quoteIdentifier("hosts") + " member_host"
        + " ON " + ruleColumn("member_host", "id") + " = " + ruleColumn("group_member", "hostId")
        + " LEFT JOIN " + quoteIdentifier("tunnels") + " member_tunnel"
        + " ON " + ruleColumn("member_tunnel", "id") + " = " + ruleColumn("group_member", "tunnelId")
        + " LEFT JOIN " + quoteIdentifier("hosts") + " member_entry_host"
        + " ON " + ruleColumn("member_entry_host", "id") + " = " + ruleColumn("member_tunnel", "entryHostId")
        + " LEFT JOIN " + quoteIdentifier("hosts") + " member_exit_host"
        + " ON " + ruleColumn("member_exit_host", "id") + " = " + ruleColumn("member_tunnel", "exitHostId")
        + " WHERE " + ruleColumn("group_member", "groupId") + " = " + ruleColumn("g", "id")
        + " AND (" + memberClauses.join(" OR ") + "))"],
      memberParams,
    );

    const numeric = /^\d+$/.test(token) ? Number(token) : 0;
    // 除了 r.id 是 BIGINT，其余都是 INTEGER 列：PG 按列类型推断参数，超出 int 范围的数字
    // 直接报 out of range，整个规则列表 500。这种数字本来也不可能匹配到 INT 列。
    if (Number.isSafeInteger(numeric) && numeric > 2147483647) {
      tokenClauses.push(ruleColumn("r", "id") + " = ?");
      tokenParams.push(numeric);
    } else if (numeric > 0 && numeric <= 2147483647) {
      for (const expression of [
        ruleColumn("r", "id"),
        ruleColumn("r", "hostId"),
        ruleColumn("r", "userId"),
        ruleColumn("r", "sourcePort"),
        ruleColumn("r", "targetPort"),
        ruleColumn("r", "gostRelayPort"),
        ruleColumn("r", "tunnelId"),
        ruleColumn("r", "forwardGroupId"),
      ]) {
        tokenClauses.push(expression + " = ?");
        tokenParams.push(numeric);
      }
      pushScopedForwardRuleSearch(
        tokenClauses,
        tokenParams,
        ruleColumn("g", "id"),
        input.searchVisibleForwardGroupIds,
        [
          ruleColumn("g", "id") + " = ?",
          ruleColumn("g", "sourcePort") + " = ?",
          ruleColumn("g", "targetPort") + " = ?",
        ],
        [numeric, numeric, numeric],
      );
      pushScopedForwardRuleSearch(
        tokenClauses,
        tokenParams,
        ruleColumn("t", "id"),
        input.searchVisibleTunnelIds,
        [
          ruleColumn("t", "id") + " = ?",
          ruleColumn("t", "listenPort") + " = ?",
          ruleColumn("t", "mimicPort") + " = ?",
        ],
        [numeric, numeric, numeric],
      );
    }

    const categoryLabels: Array<[Exclude<ForwardRuleListCategory, "all">, string]> = [
      ["local", "端口转发 本地转发 local port"],
      ["tunnel", "隧道转发 tunnel"],
      ["chain", "转发链 端口转发链 chain"],
      ["group", "转发组 group"],
    ];
    for (const [category, labels] of categoryLabels) {
      if (!labels.toLowerCase().includes(token)) continue;
      tokenClauses.push(categorySql + " = ?");
      tokenParams.push(category);
    }

    conditions.push("(" + tokenClauses.join(" OR ") + ")");
    params.push(...tokenParams);
  }

  if (includeCategory && input.category !== "all") {
    conditions.push(categorySql + " = ?");
    params.push(input.category);
  }

  return {
    fromSql: forwardRuleListFromSql(),
    whereSql: conditions.join("\n  AND "),
    params,
    categorySql,
  };
}

export async function getForwardRulesByIds(ruleIds: number[]) {
  const db = await getDb();
  if (!db) return [];
  const ids = Array.from(new Set(ruleIds
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)));
  const rows: any[] = [];
  for (let index = 0; index < ids.length; index += 400) {
    rows.push(...await db.select().from(forwardRules).where(inArray(forwardRules.id, ids.slice(index, index + 400))));
  }
  return rows;
}

export async function getForwardRuleTrafficContextsByIds(ruleIds: number[]) {
  const db = await getDb();
  if (!db) return [];
  const ids = Array.from(new Set(ruleIds
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return [];

  const rows: any[] = [];
  for (let index = 0; index < ids.length; index += 400) {
    rows.push(...await db
      .select({
        id: forwardRules.id,
        hostId: forwardRules.hostId,
        tunnelId: forwardRules.tunnelId,
        forwardGroupId: forwardRules.forwardGroupId,
        forwardGroupRuleId: forwardRules.forwardGroupRuleId,
        forwardGroupMemberId: forwardRules.forwardGroupMemberId,
        userId: forwardRules.userId,
        isEnabled: forwardRules.isEnabled,
        isRunning: forwardRules.isRunning,
        pendingDelete: forwardRules.pendingDelete,
        // 这条转发走的是哪个落地节点。落地机的已用流量按它累加 ——
        // 顺手多取一列，不必为此再查一遍。
        proxyNodeId: forwardRules.proxyNodeId,
        routeParentRuleId: forwardRules.routeParentRuleId,
        // 单条规则限额（server/ruleLimits.ts）：记账时判断这条要不要累加规则用量。
        trafficLimit: forwardRules.trafficLimit,
        quotaUsedIn: forwardRules.quotaUsedIn,
        adminManaged: forwardRules.adminManaged,
        rateLimitMbps: forwardRules.rateLimitMbps,
        expiresAt: forwardRules.expiresAt,
        ruleLimitReason: forwardRules.ruleLimitReason,
        trafficTunnelId: tunnels.id,
        trafficTunnelEntryHostId: tunnels.entryHostId,
        trafficTunnelEntryGroupId: tunnels.entryGroupId,
        trafficTunnelExitHostId: tunnels.exitHostId,
        trafficTunnelMode: tunnels.mode,
        trafficTunnelMultiplier: tunnels.trafficMultiplier,
        trafficTunnelLoadBalanceEnabled: tunnels.loadBalanceEnabled,
        trafficTunnelLoadBalanceStrategy: tunnels.loadBalanceStrategy,
        trafficGroupId: forwardGroups.id,
        trafficGroupMode: forwardGroups.groupMode,
        trafficGroupMultiplier: forwardGroups.trafficMultiplier,
      })
      .from(forwardRules)
      .leftJoin(tunnels, eq(tunnels.id, forwardRules.tunnelId))
      .leftJoin(forwardGroups, eq(forwardGroups.id, forwardRules.forwardGroupId))
      .where(inArray(forwardRules.id, ids.slice(index, index + 400))));
  }

  const groupIds = Array.from(new Set(rows
    .map((row) => Number(row.trafficGroupId || 0))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const parentRuleIds = Array.from(new Set(rows
    .map((row) => Number(row.forwardGroupRuleId || 0))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const parentByRuleId = new Map<number, { userId: number; groupId: number; isTemplate: boolean }>();
  for (let index = 0; index < parentRuleIds.length; index += 400) {
    const parents = await db
      .select({
        id: forwardRules.id,
        userId: forwardRules.userId,
        groupId: forwardRules.forwardGroupId,
        isTemplate: forwardRules.isForwardGroupTemplate,
      })
      .from(forwardRules)
      .where(inArray(forwardRules.id, parentRuleIds.slice(index, index + 400)));
    for (const parent of parents as any[]) {
      parentByRuleId.set(Number(parent.id), {
        userId: Number(parent.userId),
        groupId: Number(parent.groupId || 0),
        isTemplate: parent.isTemplate === true || parent.isTemplate === 1 || parent.isTemplate === "1",
      });
    }
  }
  const membersByGroupId = new Map<number, any[]>();
  for (let index = 0; index < groupIds.length; index += 400) {
    const members = await db
      .select({
        id: forwardGroupMembers.id,
        groupId: forwardGroupMembers.groupId,
        hostId: forwardGroupMembers.hostId,
        isEnabled: forwardGroupMembers.isEnabled,
        priority: forwardGroupMembers.priority,
      })
      .from(forwardGroupMembers)
      .where(and(
        inArray(forwardGroupMembers.groupId, groupIds.slice(index, index + 400)),
        eq(forwardGroupMembers.isEnabled, true),
      ));
    for (const member of members as any[]) {
      const groupId = Number(member.groupId || 0);
      const groupMembers = membersByGroupId.get(groupId) || [];
      groupMembers.push(member);
      membersByGroupId.set(groupId, groupMembers);
    }
  }
  for (const members of membersByGroupId.values()) {
    members.sort((a, b) => Number(a.priority) - Number(b.priority));
  }

  return rows.map((row) => {
    const parent = parentByRuleId.get(Number(row.forwardGroupRuleId || 0));
    const inheritedUserId = parent?.isTemplate
      && parent.groupId > 0
      && parent.groupId === Number(row.forwardGroupId || 0)
      ? parent.userId
      : Number(row.userId);
    return {
      rule: {
        id: row.id,
        hostId: row.hostId,
        tunnelId: row.tunnelId,
        forwardGroupId: row.forwardGroupId,
        forwardGroupRuleId: row.forwardGroupRuleId,
        forwardGroupMemberId: row.forwardGroupMemberId,
        // Managed group children inherit ownership from the visible template.
        // Older restores and preserved runtimes can retain a stale child userId.
        userId: inheritedUserId,
        isEnabled: row.isEnabled,
        isRunning: row.isRunning,
        pendingDelete: row.pendingDelete,
        proxyNodeId: row.proxyNodeId,
        routeParentRuleId: row.routeParentRuleId,
        trafficLimit: row.trafficLimit,
        quotaUsedIn: row.quotaUsedIn,
        adminManaged: row.adminManaged,
        rateLimitMbps: row.rateLimitMbps,
        expiresAt: row.expiresAt,
        ruleLimitReason: row.ruleLimitReason,
      },
      tunnel: Number(row.trafficTunnelId || 0) > 0 ? {
        id: row.trafficTunnelId,
        entryHostId: row.trafficTunnelEntryHostId,
        entryGroupId: row.trafficTunnelEntryGroupId,
        exitHostId: row.trafficTunnelExitHostId,
        mode: row.trafficTunnelMode,
        trafficMultiplier: row.trafficTunnelMultiplier,
        loadBalanceEnabled: row.trafficTunnelLoadBalanceEnabled,
        loadBalanceStrategy: row.trafficTunnelLoadBalanceStrategy,
      } : null,
      group: Number(row.trafficGroupId || 0) > 0 ? {
        id: row.trafficGroupId,
        groupMode: row.trafficGroupMode,
        trafficMultiplier: row.trafficGroupMultiplier,
        members: membersByGroupId.get(Number(row.trafficGroupId)) || [],
      } : null,
    };
  });
}

async function hydrateForwardRuleListIds(ids: number[]) {
  if (ids.length === 0) return [];
  const rows = await getForwardRulesByIds(ids);
  const byId = new Map((rows as any[]).map((row: any) => [Number(row.id), row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function emptyForwardRuleCategoryCounts() {
  return { all: 0, local: 0, tunnel: 0, chain: 0, group: 0 };
}

export async function getForwardRulesPage(input: ForwardRuleListQuery) {
  const db = await getDb();
  if (!db) {
    return {
      ...pageResult([], 0, input),
      scopeTotalItems: 0,
      activeItems: 0,
      categoryCounts: emptyForwardRuleCategoryCounts(),
    };
  }
  const scopeFilter = buildForwardRuleSqlFilter(input, {
    includeEntryHost: false,
    includeSearch: false,
    includeCategory: false,
  });
  const categoryFilter = buildForwardRuleSqlFilter(input, { includeCategory: false });
  const filtered = buildForwardRuleSqlFilter(input);
  const [scopeRows, totalRows, categoryRows] = await Promise.all([
    queryRaw<{ totalItems: number }>(
      "SELECT COUNT(*) AS " + quoteIdentifier("totalItems") + "\n"
        + scopeFilter.fromSql + "\nWHERE " + scopeFilter.whereSql,
      scopeFilter.params,
    ),
    queryRaw<{ totalItems: number; activeItems: number }>(
      "SELECT COUNT(*) AS " + quoteIdentifier("totalItems")
        + ", COALESCE(SUM(CASE WHEN " + ruleColumn("r", "isEnabled") + " = " + boolLiteral(true)
        + " THEN 1 ELSE 0 END), 0) AS " + quoteIdentifier("activeItems") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql,
      filtered.params,
    ),
    queryRaw<{ category: string; count: number }>(
      "SELECT " + categoryFilter.categorySql + " AS " + quoteIdentifier("category")
        + ", COUNT(*) AS " + quoteIdentifier("count") + "\n"
        + categoryFilter.fromSql + "\nWHERE " + categoryFilter.whereSql
        + "\nGROUP BY " + categoryFilter.categorySql,
      categoryFilter.params,
    ),
  ]);
  const totalItems = Number(totalRows[0]?.totalItems || 0);
  const activeItems = Number(totalRows[0]?.activeItems || 0);
  const window = pageWindowForTotal(input, totalItems);
  const categoryOrder = input.category === "all" ? filtered.categorySql + " ASC, " : "";
  const idRows = totalItems > 0
    ? await queryRaw<{ id: number }>(
      "SELECT " + ruleColumn("r", "id") + " AS " + quoteIdentifier("id") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql
        + "\nORDER BY " + categoryOrder + ruleColumn("r", "sortOrder") + " ASC, "
        + ruleColumn("r", "createdAt") + " DESC, " + ruleColumn("r", "id") + " DESC"
        + "\nLIMIT ? OFFSET ?",
      [...filtered.params, window.pageSize, window.offset],
    )
    : [];
  const ids = idRows.map((row) => Number(row.id)).filter((id) => id > 0);
  const items = await hydrateForwardRuleListIds(ids);
  const categoryCounts = emptyForwardRuleCategoryCounts();
  for (const row of categoryRows) {
    const category = String(row.category || "") as Exclude<ForwardRuleListCategory, "all">;
    if (!(category in categoryCounts)) continue;
    categoryCounts[category] = Number(row.count || 0);
  }
  categoryCounts.all = categoryCounts.local + categoryCounts.tunnel + categoryCounts.chain + categoryCounts.group;
  return {
    ...pageResult(items, totalItems, window),
    scopeTotalItems: Number(scopeRows[0]?.totalItems || 0),
    activeItems,
    categoryCounts,
  };
}

export async function getForwardRuleMapBatch(
  input: ForwardRuleListQuery,
  cursor: number,
  limit: number,
) {
  const filtered = buildForwardRuleSqlFilter(input);
  const normalizedCursor = Math.max(0, Math.floor(Number(cursor) || 0));
  const normalizedLimit = Math.min(250, Math.max(1, Math.floor(Number(limit) || 100)));
  const [totalRows, idRows] = await Promise.all([
    queryRaw<{ totalItems: number }>(
      "SELECT COUNT(*) AS " + quoteIdentifier("totalItems") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql,
      filtered.params,
    ),
    queryRaw<{ id: number }>(
      "SELECT " + ruleColumn("r", "id") + " AS " + quoteIdentifier("id") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql
        + "\nORDER BY " + (input.category === "all" ? filtered.categorySql + " ASC, " : "")
        + ruleColumn("r", "sortOrder") + " ASC, " + ruleColumn("r", "createdAt") + " DESC, "
        + ruleColumn("r", "id") + " DESC\nLIMIT ? OFFSET ?",
      [...filtered.params, normalizedLimit, normalizedCursor],
    ),
  ]);
  const totalItems = Number(totalRows[0]?.totalItems || 0);
  const ids = normalizedCursor < totalItems
    ? idRows.map((row) => Number(row.id)).filter((id) => id > 0)
    : [];
  const items = await hydrateForwardRuleListIds(ids);
  return {
    items,
    totalItems,
    nextCursor: normalizedCursor + items.length < totalItems
      ? normalizedCursor + items.length
      : undefined,
  };
}

export async function getForwardRuleSummarySelection(input: ForwardRuleListQuery) {
  const filtered = buildForwardRuleSqlFilter(input);
  const [summaryRows, idRows] = await Promise.all([
    queryRaw<{ totalItems: number; activeItems: number }>(
      "SELECT COUNT(*) AS " + quoteIdentifier("totalItems")
        + ", COALESCE(SUM(CASE WHEN " + ruleColumn("r", "isEnabled") + " = " + boolLiteral(true)
        + " THEN 1 ELSE 0 END), 0) AS " + quoteIdentifier("activeItems") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql,
      filtered.params,
    ),
    queryRaw<{ id: number }>(
      "SELECT " + ruleColumn("r", "id") + " AS " + quoteIdentifier("id") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql,
      filtered.params,
    ),
  ]);
  return {
    totalItems: Number(summaryRows[0]?.totalItems || 0),
    activeItems: Number(summaryRows[0]?.activeItems || 0),
    ruleIds: idRows.map((row) => Number(row.id)).filter((id) => id > 0),
  };
}

export async function getForwardRulesForUserSync(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    sql`COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    sql`COALESCE(${forwardRules.isForwardGroupTemplate}, ${sqlBool(false)}) = ${sqlBool(false)}`,
  )).orderBy(sql`${forwardRules.sortOrder} ASC`, desc(forwardRules.createdAt), desc(forwardRules.id));
}

/** 一台机器的 Agent 管得着哪些规则。下发和收它报上来的东西都按这一份算。 */
function forwardRulesForAgentConditions(hostId?: number, options: { failoverReports?: boolean } = {}) {
  const conds: any[] = [
    sql`COALESCE(${forwardRules.isForwardGroupTemplate}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    sql`(COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)} OR ${forwardRules.isRunning} = ${sqlBool(true)})`,
  ];
  if (hostId) {
    const entryScope = sql`(
      ${forwardRules.hostId} = ${hostId}
      OR ${forwardRules.tunnelId} IN (
        SELECT ${tunnels.id}
        FROM ${tunnels}
        WHERE ${tunnels.entryGroupId} IN (
          SELECT ${forwardGroups.id}
          FROM ${forwardGroups}
          INNER JOIN ${forwardGroupMembers} ON ${forwardGroupMembers.groupId} = ${forwardGroups.id}
          WHERE ${forwardGroups.groupMode} = 'entry'
            AND ${forwardGroups.isEnabled} = ${sqlBool(true)}
            AND ${forwardGroupMembers.memberType} = 'host'
            AND ${forwardGroupMembers.hostId} = ${hostId}
            AND ${forwardGroupMembers.isEnabled} = ${sqlBool(true)}
        )
      )
    )`;
    /*
      收线路组上报时（getForwardRuleFailoverLinesForAgent）按调度器在哪台算：不在隧道上的规则是规则
      所在的机器；隧道规则只认主出口，入口和入口组成员不跑它的调度器（见心跳的 failoverForCurrentHost），
      不能报。隧道已经不在了的规则按不在隧道上算，和心跳一样。
    */
    conds.push(options.failoverReports
      ? sql`(
        (
          ${forwardRules.hostId} = ${hostId}
          AND NOT EXISTS (SELECT 1 FROM ${tunnels} WHERE ${tunnels.id} = ${forwardRules.tunnelId})
        )
        OR ${forwardRules.tunnelId} IN (SELECT ${tunnels.id} FROM ${tunnels} WHERE ${tunnels.exitHostId} = ${hostId})
      )`
      : entryScope);
  }
  return conds;
}

export async function getForwardRulesForAgent(hostId?: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(forwardRules).where(and(...forwardRulesForAgentConditions(hostId))).orderBy(desc(forwardRules.createdAt));
}

/**
 * 收主备线路上报时用：只要归属和库里现在记的那条。
 *
 * 这一步在心跳的所有早退之前跑（见 failoverLineReports），所以只取三列 —— 整行取出来
 * 是给下发拼命令用的，这里用不着。
 */
/**
 * 这台机器有权报告的主备规则：id 和库里记的当前线路之外，还带上路径清单和目标 —— 切换
 * 事件入库要把 Agent 报的「拨了哪个地址」翻成「哪条路径」，Telegram 提醒要规则名和开关。
 * 不按 failoverEnabled 过滤：归属才是这里要验的东西，Agent 报了什么就按规则收什么。
 *
 * 隧道规则的调度器跑在隧道的出口机上（见 routers/rules.crud.ts 的 routeSchedulerHostIds），报上来的
 * 是出口机 —— 所以只有主出口（多跳时就是最后一跳）有权报这条隧道上的规则。上一版只认规则所在的
 * 入口机，隧道规则的切换、当前线路、评分全被当成越权丢掉了。入口（规则所在的机器、入口组的成员）
 * 不跑隧道规则的调度器，也不再有权报：留着的话，一个报旧状态的入口会和主出口抢着写。
 *
 * 负载均衡的出口节点也各跑一个调度器，但一条规则在面板上只有一份状态：几个出口一起报会互相覆盖，
 * 当前线路和评分来回跳。所以只收主出口报的，出口节点（停用的、负载均衡关掉后留下的更不用说）不收。
 * 不在隧道上的规则（包括中转机上的中继规则）照旧只收规则所在机器报的。
 */
export async function getForwardRuleFailoverLinesForAgent(hostId: number) {
  const db = await getDb();
  if (!db || !hostId) return [];
  return db.select({
    id: forwardRules.id,
    hostId: forwardRules.hostId,
    tunnelId: forwardRules.tunnelId,
    userId: forwardRules.userId,
    name: forwardRules.name,
    sourcePort: forwardRules.sourcePort,
    targetIp: forwardRules.targetIp,
    targetPort: forwardRules.targetPort,
    failoverEnabled: forwardRules.failoverEnabled,
    failoverTargets: forwardRules.failoverTargets,
    failoverProbeTarget: forwardRules.failoverProbeTarget,
    routeMode: forwardRules.routeMode,
    routePaths: forwardRules.routePaths,
    telegramErrorNotifyEnabled: forwardRules.telegramErrorNotifyEnabled,
    failoverActiveTarget: forwardRules.failoverActiveTarget,
    failoverActiveAt: forwardRules.failoverActiveAt,
  }).from(forwardRules).where(and(...forwardRulesForAgentConditions(hostId, { failoverReports: true })));
}

export async function getForwardRulesForAgentScope(hostId: number, tunnelIds: number[]) {
  const db = await getDb();
  if (!db) return [];
  const ids = Array.from(new Set(tunnelIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)));
  const scope = ids.length > 0
    ? sql`(${forwardRules.hostId} = ${hostId} OR ${forwardRules.tunnelId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))`
    : eq(forwardRules.hostId, hostId);
  return db.select().from(forwardRules).where(and(
    sql`COALESCE(${forwardRules.isForwardGroupTemplate}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    sql`(COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)} OR ${forwardRules.isRunning} = ${sqlBool(true)})`,
    scope,
  )).orderBy(desc(forwardRules.createdAt));
}

export async function repairConflictingProtocolPortRules() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(forwardRules).where(and(
    sql`COALESCE(${forwardRules.isForwardGroupTemplate}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    eq(forwardRules.isEnabled, true),
    sql`COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)}`,
  )).orderBy(forwardRules.hostId, forwardRules.sourcePort, forwardRules.id);
  const byPort = new Map<string, any[]>();
  for (const row of rows as any[]) {
    const key = `${Number(row.hostId)}:${Number(row.sourcePort)}`;
    const items = byPort.get(key) || [];
    items.push(row);
    byPort.set(key, items);
  }
  const repaired: Array<{ keptRuleId: number; disabledRuleId: number; hostId: number; sourcePort: number }> = [];
  for (const items of byPort.values()) {
    if (items.length <= 1) continue;
    const [kept, ...duplicates] = items.sort((left, right) => Number(left.id) - Number(right.id));
    for (const duplicate of duplicates) {
      await db.update(forwardRules).set({
        isEnabled: false,
        isRunning: false,
        protocolBlockReason: `同一主机端口只能由一条规则管理；与规则 #${kept.id} 冲突，请合并为 TCP + UDP 后重新启用`,
        updatedAt: nowDate(),
      } as any).where(eq(forwardRules.id, Number(duplicate.id)));
      repaired.push({
        keptRuleId: Number(kept.id),
        disabledRuleId: Number(duplicate.id),
        hostId: Number(duplicate.hostId),
        sourcePort: Number(duplicate.sourcePort),
      });
    }
  }
  return repaired;
}

export async function getForwardRuleById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(forwardRules).where(eq(forwardRules.id, id)).limit(1);
  return r[0];
}

export async function getForwardRulesByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(forwardRules).where(eq(forwardRules.tunnelId, tunnelId)).orderBy(desc(forwardRules.createdAt));
}

export async function getForwardGroupTemplateRules(groupId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardRules)
    .where(and(
      eq(forwardRules.forwardGroupId, groupId),
      sql`COALESCE(${forwardRules.isForwardGroupTemplate}, ${sqlBool(false)}) = ${sqlBool(true)}`,
      sql`COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    ))
    .orderBy(desc(forwardRules.createdAt));
}

export async function getForwardGroupChildRules(groupId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardRules)
    .where(and(
      eq(forwardRules.forwardGroupId, groupId),
      sql`${forwardRules.forwardGroupRuleId} IS NOT NULL`,
    ))
    .orderBy(desc(forwardRules.createdAt));
}

export async function getForwardGroupChildRulesForTemplate(templateRuleId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardRules)
    .where(eq(forwardRules.forwardGroupRuleId, templateRuleId))
    .orderBy(desc(forwardRules.createdAt));
}

export async function getForwardGroupChildRulesForMember(memberId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardRules)
    .where(and(
      eq(forwardRules.forwardGroupMemberId, memberId),
      sql`COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    ))
    .orderBy(desc(forwardRules.createdAt));
}

export async function createForwardRule(rule: InsertForwardRule) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const payload = { ...(rule as any) };
  if (payload.sortOrder === undefined && !payload.forwardGroupRuleId && !payload.forwardGroupMemberId) {
    payload.sortOrder = await nextForwardRuleSortOrder(Number(payload.userId || 0), await forwardRuleCategoryForPayload(payload));
  }
  const id = await insertAndGetId("forward_rules", payload);
  const created = await getForwardRuleById(id).catch(() => undefined);
  await recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: id, hostId: Number((created as any)?.hostId || 0), action: "create", after: created });
  if (Number(payload.proxyNodeId || 0) > 0) signalRuleEntryDomainChanged(id, "rule-created");
  invalidateProxySubCacheForUser(Number(payload.userId || 0));
  return id;
}

// startIndex 保留在签名里只为兼容调用方：现在按被拖行原有的 sortOrder 位置重排，用不上页偏移。
export async function reorderForwardRules(category: ForwardRuleSortCategory, ids: number[], userId?: number, _startIndex = 0) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const orderedIds = ids.map((id) => Math.floor(Number(id))).filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const idList = inList(orderedIds);
  const q = quoteIdentifier;
  const params: any[] = [...idList.params, boolValue(false)];
  let userWhere = "";
  if (userId) {
    userWhere = ` AND r.${q("userId")} = ?`;
    params.push(userId);
  }
  const rows = await queryRaw<any>(
    `SELECT
        r.${q("id")} AS ${q("id")},
        r.${q("userId")} AS ${q("userId")},
        r.${q("tunnelId")} AS ${q("tunnelId")},
        r.${q("forwardGroupId")} AS ${q("forwardGroupId")},
        g.${q("groupMode")} AS ${q("groupMode")}
       FROM ${q("forward_rules")} r
       LEFT JOIN ${q("forward_groups")} g ON g.${q("id")} = r.${q("forwardGroupId")}
      WHERE r.${q("id")} IN ${idList.sql}
        AND r.${q("pendingDelete")} = ?
        AND r.${q("forwardGroupRuleId")} IS NULL
        AND r.${q("id")} NOT IN (
          SELECT ${q("ruleId")} FROM ${q("forward_group_members")} WHERE ${q("ruleId")} IS NOT NULL
        )
        ${userWhere}`,
    params,
  );
  if (rows.length !== orderedIds.length) throw new Error("排序中包含不存在或无权访问的规则");
  if (rows.some((row: any) => forwardRuleCategoryFromRow(row) !== category)) throw new Error("排序规则类型不一致");
  // 排序范围 = 这些规则主人的、同一分类下、会出现在规则列表里的全部规则（条件和列表 / nextForwardRuleSortOrder 一致），
  // 按列表的展示顺序排好。租户只会是自己；管理员按单个用户筛选后才能拖，这里按实际涉及的用户取。
  const ownerIds = Array.from(new Set(rows.map((row: any) => Number(row.userId)).filter((id: number) => id > 0)));
  const owners = inList(ownerIds.length > 0 ? ownerIds : [0]);
  await reorderWithinSortOrderScope({
    table: "forward_rules",
    orderedIds,
    loadScope: () => queryRaw<{ id: number; sortOrder: number }>(
      `SELECT r.${q("id")} AS ${q("id")}, r.${q("sortOrder")} AS ${q("sortOrder")}
         FROM ${q("forward_rules")} r
         LEFT JOIN ${q("forward_groups")} g ON g.${q("id")} = r.${q("forwardGroupId")}
        WHERE r.${q("userId")} IN ${owners.sql}
          AND COALESCE(r.${q("pendingDelete")}, ?) = ?
          AND COALESCE(r.${q("forwardGroupRuleId")}, 0) = 0
          AND COALESCE(r.${q("routeParentRuleId")}, 0) = 0
          AND r.${q("id")} NOT IN (
            SELECT ${q("ruleId")} FROM ${q("forward_group_members")} WHERE ${q("ruleId")} IS NOT NULL
          )
          AND ${forwardRuleCategorySql("r", "g")} = ?
        ORDER BY r.${q("sortOrder")} ASC, r.${q("createdAt")} DESC, r.${q("id")} DESC`,
      [...owners.params, boolValue(false), boolValue(false), category],
    ),
  });
}

/**
 * 只写「当前走哪条出站」这两列。
 *
 * 刻意不走 updateForwardRule：那条会写配置审计、并把 updatedAt 顶起来。
 * 主备切换是数据面的日常事件（一条线抖一下就切一次），当成配置变更记会把
 * 审计流水淹掉，而 updatedAt 在这个项目里是「这条规则被人改过」的意思，
 * 让 Agent 自己的上报去顶它，等于规则自己改自己。
 */
export async function updateForwardRuleFailoverActiveLine(id: number, target: string, atSeconds: number) {
  const db = await getDb();
  if (!db) return;
  const value = String(target || "").trim().slice(0, 256);
  if (!value) return;
  // epoch 列在各方言下统一按 Date 写入（sqlite 存整数秒，由 drizzle 转换）。
  const seconds = Math.max(0, Math.floor(Number(atSeconds) || 0)) || Math.floor(Date.now() / 1000);
  await db.update(forwardRules)
    .set({ failoverActiveTarget: value, failoverActiveAt: new Date(seconds * 1000) } as any)
    .where(eq(forwardRules.id, id));
}

// ==================== 线路组：切换记录与中转跳规则 ====================

export type ForwardRuleRouteEventInput = {
  ruleId: number;
  kind: string;
  fromKey?: string | null;
  toKey?: string | null;
  fromLabel?: string | null;
  toLabel?: string | null;
  reason?: string | null;
  score?: number | null;
  latencyMs?: number | null;
  /** 切换时新旧两条整条链的延迟（毫秒）、择优切过去前领先了多久（秒）。 */
  fromChainMs?: number | null;
  toChainMs?: number | null;
  heldSeconds?: number | null;
  /** 事件实际发生的时间（秒）。Agent 上报的事件带自己的时间戳；不给就是现在。 */
  atSeconds?: number | null;
};

const ROUTE_EVENT_TEXT_LIMIT = 500;

function routeEventText(value: unknown, limit = ROUTE_EVENT_TEXT_LIMIT) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function routeEventInt(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  // score / latencyMs 是 INT 列，Agent 报来的离谱值夹到 int 范围，别让整条事件写失败。
  return Number.isFinite(number) ? Math.max(-2147483648, Math.min(2147483647, Math.round(number))) : null;
}

/**
 * 切换记录和 updateForwardRuleFailoverActiveLine 一样，是数据面的日常事件，
 * 不走配置审计，也不动规则的 updatedAt。
 */
export async function insertForwardRuleRouteEvent(event: ForwardRuleRouteEventInput) {
  const db = await getDb();
  if (!db) return 0;
  const ruleId = Number(event.ruleId);
  const kind = routeEventText(event.kind, 24);
  if (!Number.isInteger(ruleId) || ruleId <= 0 || !kind) return 0;
  const seconds = Math.max(0, Math.floor(Number(event.atSeconds) || 0)) || Math.floor(Date.now() / 1000);
  const row = {
    ruleId,
    kind,
    fromKey: routeEventText(event.fromKey, 32),
    toKey: routeEventText(event.toKey, 32),
    fromLabel: routeEventText(event.fromLabel),
    toLabel: routeEventText(event.toLabel),
    reason: routeEventText(event.reason),
    score: routeEventInt(event.score),
    latencyMs: routeEventInt(event.latencyMs),
    fromChainMs: routeEventInt(event.fromChainMs),
    toChainMs: routeEventInt(event.toChainMs),
    heldSeconds: routeEventInt(event.heldSeconds),
    createdAt: new Date(seconds * 1000),
  };
  // drizzle 的 insert 结果三种库各长各样（MySQL 是 [ResultSetHeader]、PG 没有 id），统一走 insertAndGetId。
  return insertAndGetId("forward_rule_route_events", row);
}

export async function getForwardRuleRouteEvents(ruleId: number, limit = 20) {
  const db = await getDb();
  if (!db) return [];
  const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 20)));
  return db
    .select()
    .from(forwardRuleRouteEvents)
    .where(eq(forwardRuleRouteEvents.ruleId, ruleId))
    .orderBy(desc(forwardRuleRouteEvents.createdAt), desc(forwardRuleRouteEvents.id))
    .limit(size);
}

export async function deleteForwardRuleRouteEvents(ruleId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(forwardRuleRouteEvents).where(eq(forwardRuleRouteEvents.ruleId, ruleId));
}

export async function cleanOldForwardRuleRouteEvents(retainHours = 72) {
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("forward_rule_route_events")} WHERE ${quoteIdentifier("createdAt")} < ?`,
    [cutoff],
  );
}

/** 一条线路组规则在各中转跳上自动生成的转发规则（含等待删除的）。 */
export async function getRouteRelayRules(parentRuleId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardRules)
    .where(eq(forwardRules.routeParentRuleId, parentRuleId))
    .orderBy(forwardRules.routePathKey, forwardRules.routeHopIndex);
}

/** 所有中转跳规则（完整性修复用：父规则没了或路径删了的要回收）。 */
export async function getAllRouteRelayRules() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardRules)
    .where(and(sql`${forwardRules.routeParentRuleId} IS NOT NULL`, sql`${forwardRules.routeParentRuleId} <> 0`));
}

export async function updateForwardRule(id: number, data: Partial<InsertForwardRule>) {
  const db = await getDb();
  if (!db) return;
  const audit = shouldAuditConfigPatch(data as any);
  const before = audit ? await getForwardRuleById(id).catch(() => undefined) : undefined;
  await db.update(forwardRules).set({ ...data, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
  if (audit && before) {
    const after = await getForwardRuleById(id).catch(() => undefined);
    await recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: id, hostId: Number((after as any)?.hostId || (before as any)?.hostId || 0), action: "update", before, after });
  }
  if (RULE_ENTRY_DOMAIN_FIELDS.some((key) => (data as any)?.[key] !== undefined)) signalRuleEntryDomainChanged(id, "rule-updated");
  // 订阅内容依赖的那几列变了，这个用户缓存的订阅正文作废（isRunning 这种瞬时状态不算）。
  if (PROXY_SUB_RULE_FIELDS.some((key) => (data as any)?.[key] !== undefined)) {
    const owner = before || await getForwardRuleById(id).catch(() => undefined);
    invalidateProxySubCacheForUser(Number((owner as any)?.userId || 0));
  }
}

const PROXY_SUB_RULE_FIELDS = [
  "proxyNodeId", "proxyNodeVisible", "proxyNodeName", "isEnabled", "pendingDelete", "sourcePort", "hostId", "name",
  "targetIp", "targetPort", "protocol", "sortOrder", "entryDomainEnabled", "entryDomain", "entryDomainValue", "userId",
] as const;

export async function resetForwardRulesForUserSync(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({
    isRunning: false,
    updatedAt: nowDate(),
  }).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
    eq(forwardRules.isForwardGroupTemplate, false),
  ));
}

/**
 * 一批主机上还在跑的转发，只取计费判断要用的那几列。
 *
 * 给主机列表用：「这台机器上的转发是扣余额还是吃套餐流量」这件事，答案不在主机上 ——
 * 计费配置挂在**转发组 / 隧道**上（主机那一档只剩历史配置），所以只能顺着这台机器上
 * 的转发去问。一次查完而不是一台台查：一页十二台就是十二次往返。
 *
 * 排掉 pendingDelete：已经删掉、只等 Agent 确认的那些不该再影响「现在怎么计费」。
 */
export async function getBillingRelevantRulesByHostIds(hostIds: readonly number[]) {
  const db = await getDb();
  if (!db) return [];
  const wanted = Array.from(new Set(hostIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return [];
  const rows = await db
    .select({
      id: forwardRules.id,
      hostId: forwardRules.hostId,
      tunnelId: forwardRules.tunnelId,
      forwardGroupId: forwardRules.forwardGroupId,
      // 计费永远记在转发的主人头上（不是机器的主人），预检要按人汇总就得带上他。
      userId: forwardRules.userId,
    })
    .from(forwardRules)
    .where(and(
      inArray(forwardRules.hostId, wanted),
      eq(forwardRules.pendingDelete, false),
    ));
  return rows as any[];
}

/**
 * 一批主机上各有多少条转发 —— 不看启用状态，只按 hostId 数。
 *
 * 给主机列表的卡片用：「这台上挂了几条转发」。一次 GROUP BY 查完整页，不一台台查。
 * 没有转发的主机不会出现在结果里，调用方按 0 处理。
 * 已删除、等 Agent 确认清理的（pendingDelete）不算：规则列表本来就不显示它们，
 * 卡片上再把它们报成「受影响」就对不上号。
 */
export async function countForwardRulesByHostIds(hostIds: readonly number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  const db = await getDb();
  if (!db) return counts;
  const wanted = Array.from(new Set(hostIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return counts;
  const rows = await db
    .select({
      hostId: forwardRules.hostId,
      count: sql<number>`COUNT(*)`,
    })
    .from(forwardRules)
    .where(and(
      inArray(forwardRules.hostId, wanted),
      sql`COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    ))
    .groupBy(forwardRules.hostId);
  for (const row of rows as any[]) {
    counts.set(Number(row.hostId), Number(row.count || 0));
  }
  return counts;
}

/**
 * 一批用户名下还开着的转发有多少条。
 *
 * 给「配了兜底价会停掉谁」的预检用：余额扣不动时 setUserForwardAccess 停的是这个人
 * **名下全部**的转发，不只是这台机器上的那几条。只报这台机器上的条数会把后果说小 ——
 * 而这正是人会拿来做决定的那个数。
 */
/**
 * 某个用户名下还在跑的转发，只取计费判断要用的那几列。
 *
 * 给租户自己那一页用：「我有几条转发在按量扣钱」。和按主机查的那个是同一件事换个
 * 维度问 —— 计费永远记在转发的主人头上，不是机器的主人。
 */
export async function getBillingRelevantRulesByUserId(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const rows = await db
    .select({
      id: forwardRules.id,
      hostId: forwardRules.hostId,
      tunnelId: forwardRules.tunnelId,
      forwardGroupId: forwardRules.forwardGroupId,
    })
    .from(forwardRules)
    .where(and(
      eq(forwardRules.userId, id),
      eq(forwardRules.pendingDelete, false),
    ));
  return rows as any[];
}

export async function countEnabledForwardRulesByUserIds(userIds: readonly number[]) {
  const result = new Map<number, number>();
  const wanted = Array.from(new Set(userIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return result;
  const db = await getDb();
  if (!db) return result;
  const rows = await db
    .select({ userId: forwardRules.userId, count: sql<number>`COUNT(*)` })
    .from(forwardRules)
    .where(and(
      inArray(forwardRules.userId, wanted),
      eq(forwardRules.isEnabled, true),
      eq(forwardRules.pendingDelete, false),
    ))
    .groupBy(forwardRules.userId);
  for (const row of rows as any[]) result.set(Number(row.userId), Number(row.count || 0));
  return result;
}

export async function deleteForwardRule(id: number) {
  const db = await getDb();
  if (!db) return;
  const before = await getForwardRuleById(id).catch(() => undefined);
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, id));
  await releaseRuleSniNames(id);
  await db.update(forwardRules).set({
    isEnabled: false,
    isRunning: false,
    pendingDelete: true,
    updatedAt: nowDate(),
  }).where(eq(forwardRules.id, id));
  if (before) await recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: id, hostId: Number((before as any).hostId || 0), action: "delete", before });
  signalRuleEntryDomainChanged(id, "rule-deleted");
  invalidateProxySubCacheForUser(Number((before as any)?.userId || 0));
}

export async function markForwardRulePendingDelete(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, id));
  // 共享 TLS 入站上占的 SNI 立刻放掉：待删的规则不再参与分流，名字可以给别人了。
  await releaseRuleSniNames(id);
  await db.update(forwardRules).set({
    isEnabled: false,
    isRunning: true,
    pendingDelete: true,
    updatedAt: nowDate(),
  }).where(eq(forwardRules.id, id));
  signalRuleEntryDomainChanged(id, "rule-deleted");
}

export async function finalizeForwardRuleDelete(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, id));
  await releaseRuleSniNames(id);
  await db.update(forwardGroupMembers).set({
    ruleId: null,
    updatedAt: nowDate(),
  } as any).where(eq(forwardGroupMembers.ruleId, id));
  // 行删掉之前把发布过的专属域名记进待删表，否则 DNS 里那条记录就没人认领了。
  const retiredDomains = await recordRuleEntryDomainCleanupsBeforeDelete({ ruleId: id }).catch(() => 0);
  await db.delete(forwardRules).where(and(
    eq(forwardRules.id, id),
    eq(forwardRules.pendingDelete, true),
  ));
  if (retiredDomains > 0) signalRuleEntryDomainCleanup("rule-deleted");
}

export async function purgeSettledPendingForwardRuleDeletes() {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ id: forwardRules.id })
    .from(forwardRules)
    .where(and(
      eq(forwardRules.pendingDelete, true),
      eq(forwardRules.isRunning, false),
    ));
  let count = 0;
  for (const row of rows as any[]) {
    const id = Number(row?.id || 0);
    if (id <= 0) continue;
    await finalizeForwardRuleDelete(id);
    count += 1;
  }
  return count;
}

export async function markOrphanedForwardGroupTemplatesPendingDelete(hostId?: number) {
  const db = await getDb();
  if (!db) return 0;
  const conds: any[] = [
    eq(forwardRules.isForwardGroupTemplate, true),
    eq(forwardRules.pendingDelete, false),
    sql`(${forwardRules.forwardGroupId} IS NULL OR NOT EXISTS (
      SELECT 1 FROM ${forwardGroups} WHERE ${forwardGroups.id} = ${forwardRules.forwardGroupId}
    ))`,
  ];
  if (hostId) conds.push(eq(forwardRules.hostId, hostId));
  const templates = await db.select({ id: forwardRules.id }).from(forwardRules).where(and(...conds));
  let count = 0;
  for (const template of templates as any[]) {
    const id = Number(template.id || 0);
    if (id <= 0) continue;
    await withKeyedTaskLock(`rule:${id}`, async () => {
      const currentRows = await db.select({
        id: forwardRules.id,
        forwardGroupId: forwardRules.forwardGroupId,
        isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
        pendingDelete: forwardRules.pendingDelete,
      }).from(forwardRules).where(eq(forwardRules.id, id)).limit(1);
      const current = currentRows[0];
      if (!current || boolValue((current as any).pendingDelete) || !boolValue((current as any).isForwardGroupTemplate)) return;
      const currentGroupId = Number((current as any).forwardGroupId || 0);
      if (currentGroupId > 0) {
        const groups = await db.select({ id: forwardGroups.id })
          .from(forwardGroups)
          .where(eq(forwardGroups.id, currentGroupId))
          .limit(1);
        if (groups.length > 0) return;
      }
      const children = await db
        .select({ id: forwardRules.id, pendingDelete: forwardRules.pendingDelete })
        .from(forwardRules)
        .where(eq(forwardRules.forwardGroupRuleId, id));
      if ((children as any[]).some((child: any) => !boolValue(child.pendingDelete))) return;
      await deleteForwardRule(id);
      count += 1;
    });
  }
  return count;
}

export async function toggleForwardRule(id: number, isEnabled: boolean) {
  const db = await getDb();
  if (!db) return;
  const before = await getForwardRuleById(id).catch(() => undefined);
  await db.update(forwardRules).set({
    isEnabled,
    disabledByTunnel: false,
    disabledByGroup: false,
    disabledByUser: false,
    ...(isEnabled ? { isRunning: false, protocolBlockReason: null } : {}),
    updatedAt: nowDate(),
  } as any).where(eq(forwardRules.id, id));
  if (before) {
    const after = await getForwardRuleById(id).catch(() => undefined);
    await recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: id, hostId: Number((after as any)?.hostId || (before as any).hostId || 0), action: "update", before, after });
  }
  signalRuleEntryDomainChanged(id, isEnabled ? "rule-enabled" : "rule-disabled");
}

/**
 * loadedRule：调用方刚读过的同一条规则（Agent 状态上报那条路在同一次处理里已经读过）。
 * 传了就不再读一遍，只用它的 pendingDelete 决定是收尾删除还是更新运行状态。
 */
export async function updateRuleRunningStatus(id: number, isRunning: boolean, loadedRule?: { pendingDelete?: unknown } | null) {
  const db = await getDb();
  if (!db) return;
  const rule = loadedRule ?? await getForwardRuleById(id);
  if (rule && (rule as any).pendingDelete && !isRunning) {
    await finalizeForwardRuleDelete(id);
    return;
  }
  await db.update(forwardRules).set({ isRunning, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
}

export async function markForwardRulesNotRunning(ids: number[]) {
  const db = await getDb();
  if (!db) return 0;
  const ruleIds = Array.from(new Set(ids
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (ruleIds.length === 0) return 0;
  await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(inArray(forwardRules.id, ruleIds));
  return ruleIds.length;
}

export async function disableForwardRulesOutsideHostPortRange(
  hostId: number,
  policySource?: PortPolicySource | null,
  reason?: string,
) {
  const id = Number(hostId);
  const policy = portPolicyFrom(policySource);
  if (!Number.isFinite(id) || id <= 0 || !portPolicyHasRestriction(policy)) return 0;
  const rows = await getForwardRulesForAgent(id);
  const affected = rows.filter((rule: any) => {
    const port = Number(rule?.sourcePort || 0);
    return port > 0 && !isPortAllowedByPolicy(port, policy);
  });
  if (affected.length === 0) return 0;
  const message = String(reason || `入口端口不在当前主机允许范围 ${describePortPolicy(policy)} 内，请修改端口后再启用。`).slice(0, 300);
  const now = Math.floor(Date.now() / 1000);
  const ids = affected.map((rule: any) => Number(rule.id)).filter((ruleId: number) => Number.isInteger(ruleId) && ruleId > 0);
  if (ids.length === 0) return 0;
  await executeRaw(
    `UPDATE ${quoteIdentifier("forward_rules")}
     SET ${quoteIdentifier("isEnabled")} = ?,
         ${quoteIdentifier("isRunning")} = ?,
         ${quoteIdentifier("protocolBlockReason")} = ?,
         ${quoteIdentifier("updatedAt")} = ?
     WHERE ${quoteIdentifier("id")} IN ${inList(ids).sql}`,
    [boolValue(false), boolValue(false), message, now, ...ids],
  );
  return affected.length;
}

