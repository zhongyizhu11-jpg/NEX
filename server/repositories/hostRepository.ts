import { and, asc, desc, eq, inArray, isNotNull, or, sql, type SQLWrapper } from "drizzle-orm";
import { isFreshHostHeartbeat, isHostConsideredOnline } from "../hostHeartbeatPolicy";
export { isFreshHostHeartbeat } from "../hostHeartbeatPolicy";
import {
  agentTokens,
  forwardGroupMembers,
  forwardGroups,
  forwardRuleTunnelExits,
  forwardRules,
  hostGroupMembers,
  hostGroups,
  hostMetrics,
  hostProbeServiceStats,
  hosts,
  forwardRuleTrafficCounters,
  hostTrafficCounters,
  InsertHost,
  subscriptionPlanHosts,
  subscriptionPlans,
  trafficBillingConfigs,
  trafficStats,
  trafficStatBuckets,
  tunnelExitNodes,
  tunnelHops,
  tunnels,
  userHostPermissions,
  users,
} from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate, queryRaw, rawAffectedRows, refreshDatabasePoolSettings, withDatabaseTransaction } from "../dbRuntime";
import { boolValue, inList, quoteIdentifier, sqlCountAll } from "../dbCompat";
import { recordRuleEntryDomainCleanupsBeforeDelete } from "./ruleEntryDomainRepository";
import { signalRuleEntryDomainCleanup } from "../ruleEntryDomainSignals";
import { repairPortForwardRuleHostReferences } from "../portForwardRuleHosts";
import { sqlBool } from "./repositoryUtils";
import { repairForwardGroupRuleIntegrity } from "../forwardGroupRuleIntegrity";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import { recordConfigAuditEvent, shouldAuditConfigPatch } from "../configAudit";
import { HOST_ONLINE_TTL_MS } from "../hostHeartbeatPolicy";
import { invalidateAgentAuthTokenCandidates } from "./tokenRepository";
import { getSetting, setSetting } from "./settingsRepository";
import {
  removePresenceCapableHost,
} from "../agentFastLiveness";
import {
  billingAddMonthsClamped,
  billingCalendarParts,
  billingDateTime,
  billingDaysInMonth,
  billingMonthStart,
} from "../../shared/billingTime";

// ==================== Host Queries ====================

export { HOST_ONLINE_TTL_MS };

function withComputedOnline<T extends { id?: unknown; isOnline?: boolean; lastHeartbeat?: unknown }>(host: T): T {
  return { ...host, isOnline: isHostConsideredOnline(host) };
}

export async function getHosts(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  if (userId) {
    const rows = await db.select().from(hosts).where(eq(hosts.userId, userId)).orderBy(asc(hosts.sortOrder), desc(hosts.createdAt), desc(hosts.id));
    return rows.map(withComputedOnline);
  }
  const rows = await db.select().from(hosts).orderBy(asc(hosts.sortOrder), desc(hosts.createdAt), desc(hosts.id));
  return rows.map(withComputedOnline);
}

export type HostListQuery = PageRequest & {
  ownerUserId?: number;
  allowedHostIds?: number[];
  sortUserId?: number;
  search?: string;
  groupId?: number | null;
  orderByGroups?: boolean;
  preferredHostIds?: number[];
};

const USER_HOST_DISPLAY_ORDER_PREFIX = "ui.hostOrder.user.";

function userHostDisplayOrderKey(userId: number) {
  return `${USER_HOST_DISPLAY_ORDER_PREFIX}${Math.max(0, Math.floor(Number(userId) || 0))}.v1`;
}

export function parseUserHostDisplayOrder(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return [] as number[];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [] as number[];
    return normalizeIds(parsed);
  } catch {
    return [] as number[];
  }
}

async function getUserHostDisplayOrder(userId: number | undefined) {
  const normalizedUserId = Math.max(0, Math.floor(Number(userId) || 0));
  if (!normalizedUserId) return [] as number[];
  return parseUserHostDisplayOrder(await getSetting(userHostDisplayOrderKey(normalizedUserId)));
}

function compareHostDefaultOrder(a: any, b: any) {
  const sortA = Math.max(0, Math.floor(Number(a?.sortOrder) || 0));
  const sortB = Math.max(0, Math.floor(Number(b?.sortOrder) || 0));
  if (sortA !== sortB) return sortA - sortB;
  const createdAtA = new Date(a?.createdAt || 0).getTime();
  const createdAtB = new Date(b?.createdAt || 0).getTime();
  if (Number.isFinite(createdAtA) && Number.isFinite(createdAtB) && createdAtA !== createdAtB) return createdAtB - createdAtA;
  return Number(b?.id || 0) - Number(a?.id || 0);
}

export function orderHostsForUser<T extends { id?: unknown; sortOrder?: unknown; createdAt?: unknown }>(hostRows: T[], preferredHostIds: number[]) {
  const rank = new Map(normalizeIds(preferredHostIds).map((hostId, index) => [hostId, index]));
  return [...hostRows].sort((a, b) => {
    const rankA = rank.get(Number(a?.id));
    const rankB = rank.get(Number(b?.id));
    if (rankA !== undefined || rankB !== undefined) {
      if (rankA === undefined) return 1;
      if (rankB === undefined) return -1;
      if (rankA !== rankB) return rankA - rankB;
    }
    return compareHostDefaultOrder(a, b);
  });
}

function reorderHostWindow(currentIds: number[], orderedIds: number[], startIndex: number) {
  const requested = new Set(orderedIds);
  const remaining = currentIds.filter((hostId) => !requested.has(hostId));
  const insertionIndex = Math.min(remaining.length, Math.max(0, Math.floor(Number(startIndex) || 0)));
  return [
    ...remaining.slice(0, insertionIndex),
    ...orderedIds,
    ...remaining.slice(insertionIndex),
  ];
}

function preferredHostOrderExpression(preferredHostIds: number[]) {
  const ids = normalizeIds(preferredHostIds);
  if (ids.length === 0) return null;
  const cases = ids.map((hostId, index) => sql`WHEN ${hostId} THEN ${index}`);
  return sql<number>`CASE ${hosts.id} ${sql.join(cases, sql` `)} ELSE ${ids.length} END`;
}

function normalizeIds(values: unknown[] | undefined) {
  return Array.from(new Set((values || [])
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function escapeLikeToken(value: string) {
  return value.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

function hostListCondition(input: Omit<HostListQuery, keyof PageRequest>) {
  const conditions: any[] = [];
  if (Number(input.ownerUserId || 0) > 0) {
    const allowedIds = normalizeIds(input.allowedHostIds);
    conditions.push(allowedIds.length > 0
      ? or(eq(hosts.userId, Number(input.ownerUserId)), inArray(hosts.id, allowedIds))
      : eq(hosts.userId, Number(input.ownerUserId)));
  }
  if (Number(input.groupId || 0) > 0) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${hostGroupMembers}
      INNER JOIN ${hostGroups} ON ${hostGroups.id} = ${hostGroupMembers.groupId}
      WHERE ${hostGroupMembers.hostId} = ${hosts.id}
        AND ${hostGroupMembers.groupId} = ${Number(input.groupId)}
        AND ${hostGroups.isEnabled} = ${sqlBool(true)}
    )`);
  }
  const tokens = String(input.search || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const pattern = `%${escapeLikeToken(token)}%`;
    const textConditions = [
      hosts.name,
      hosts.ip,
      hosts.ipv4,
      hosts.ipv6,
      hosts.entryIp,
      hosts.tunnelEntryIp,
      hosts.osInfo,
      hosts.cpuInfo,
      hosts.agentVersion,
      hosts.hostType,
    ].map((column) => sql`LOWER(COALESCE(${column}, '')) LIKE ${pattern} ESCAPE '!'`);
    const numericId = /^\d+$/.test(token) ? Number(token) : 0;
    conditions.push(or(
      ...textConditions,
      // 超出安全整数的数字传给 PG 的 BIGINT 列会报 out of range，整个列表 500。
      ...(Number.isSafeInteger(numericId) && numericId > 0 ? [eq(hosts.id, numericId)] : []),
    ));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function hostListOrder(input: Omit<HostListQuery, keyof PageRequest>) {
  if (Number(input.groupId || 0) > 0) {
    return [
      sql`(
        SELECT ${hostGroupMembers.sortOrder}
        FROM ${hostGroupMembers}
        WHERE ${hostGroupMembers.groupId} = ${Number(input.groupId)}
          AND ${hostGroupMembers.hostId} = ${hosts.id}
        ORDER BY ${hostGroupMembers.sortOrder} ASC, ${hostGroupMembers.id} ASC
        LIMIT 1
      ) ASC`,
      asc(hosts.sortOrder),
      desc(hosts.createdAt),
      desc(hosts.id),
    ];
  }
  if (input.orderByGroups) {
    const firstGroupValue = (column: SQLWrapper) => sql`(
      SELECT ${column}
      FROM ${hostGroupMembers}
      INNER JOIN ${hostGroups} ON ${hostGroups.id} = ${hostGroupMembers.groupId}
      WHERE ${hostGroupMembers.hostId} = ${hosts.id}
        AND ${hostGroups.isEnabled} = ${sqlBool(true)}
      ORDER BY ${hostGroups.sortOrder} ASC, ${hostGroups.createdAt} DESC, ${hostGroups.id} DESC,
        ${hostGroupMembers.sortOrder} ASC, ${hostGroupMembers.id} ASC
      LIMIT 1
    )`;
    const firstGroupSort = firstGroupValue(hostGroups.sortOrder);
    const firstGroupCreatedAt = firstGroupValue(hostGroups.createdAt);
    const firstGroupId = firstGroupValue(hostGroups.id);
    const firstMemberSort = firstGroupValue(hostGroupMembers.sortOrder);
    const firstMemberId = firstGroupValue(hostGroupMembers.id);
    return [
      sql`CASE WHEN ${firstGroupSort} IS NULL THEN 1 ELSE 0 END ASC`,
      sql`${firstGroupSort} ASC`,
      sql`${firstGroupCreatedAt} DESC`,
      sql`${firstGroupId} DESC`,
      sql`${firstMemberSort} ASC`,
      sql`${firstMemberId} ASC`,
      asc(hosts.sortOrder),
      desc(hosts.createdAt),
      desc(hosts.id),
    ];
  }
  const preferredOrder = preferredHostOrderExpression(input.preferredHostIds || []);
  if (preferredOrder) {
    return [asc(preferredOrder), asc(hosts.sortOrder), desc(hosts.createdAt), desc(hosts.id)];
  }
  return [asc(hosts.sortOrder), desc(hosts.createdAt), desc(hosts.id)];
}

export async function getHostsPage(input: HostListQuery) {
  const db = await getDb();
  if (!db) return { ...pageResult([], 0, input), scopeTotalItems: 0, onlineItems: 0, versionCounts: [] };
  const preferredHostIds = await getUserHostDisplayOrder(input.sortUserId);
  const orderedInput = { ...input, preferredHostIds };
  const condition = hostListCondition(input);
  const cutoffSeconds = Math.floor((Date.now() - HOST_ONLINE_TTL_MS) / 1000);
  const onlineExpression = sql<number>`CASE
    WHEN ${hosts.isOnline} = ${sqlBool(true)}
      AND ${hosts.lastHeartbeat} IS NOT NULL
      AND ${hosts.lastHeartbeat} >= ${cutoffSeconds}
    THEN 1 ELSE 0 END`;
  const aggregateQuery = db
    .select({
      totalItems: sql<number>`COUNT(*)`,
      onlineItems: sql<number>`COALESCE(SUM(${onlineExpression}), 0)`,
    })
    .from(hosts);
  const [totals] = condition ? await aggregateQuery.where(condition) : await aggregateQuery;
  const totalItems = Number(totals?.totalItems || 0);
  const onlineItems = Number(totals?.onlineItems || 0);
  const scopeCondition = hostListCondition({
    ownerUserId: input.ownerUserId,
    allowedHostIds: input.allowedHostIds,
  });
  let scopeTotalItems = totalItems;
  if (String(input.search || "").trim() || Number(input.groupId || 0) > 0) {
    const scopeQuery = db.select({ count: sql<number>`COUNT(*)` }).from(hosts);
    const [scopeTotals] = scopeCondition ? await scopeQuery.where(scopeCondition) : await scopeQuery;
    scopeTotalItems = Number(scopeTotals?.count || 0);
  }
  const window = pageWindowForTotal(input, totalItems);
  const listQuery = db.select().from(hosts);
  const pageRows = condition
    ? await listQuery.where(condition).orderBy(...hostListOrder(orderedInput)).limit(window.pageSize).offset(window.offset)
    : await listQuery.orderBy(...hostListOrder(orderedInput)).limit(window.pageSize).offset(window.offset);
  const versionQuery = db
    .select({
      agentVersion: hosts.agentVersion,
      fxpVersion: hosts.fxpVersion,
      count: sql<number>`COUNT(*)`,
      onlineCount: sql<number>`COALESCE(SUM(${onlineExpression}), 0)`,
    })
    .from(hosts);
  // 按 Agent + FXP 版本一起分组：Agent 已是最新、FXP 却旧了的主机也要算进「可升级」。
  const versionRows = condition
    ? await versionQuery.where(condition).groupBy(hosts.agentVersion, hosts.fxpVersion)
    : await versionQuery.groupBy(hosts.agentVersion, hosts.fxpVersion);
  const versionCounts = versionRows.flatMap((row: any) => {
    const count = Math.max(0, Number(row.count || 0));
    const onlineCount = Math.min(count, Math.max(0, Number(row.onlineCount || 0)));
    const offlineCount = count - onlineCount;
    return [
      ...(onlineCount > 0 ? [{ agentVersion: row.agentVersion || null, fxpVersion: row.fxpVersion || null, online: true, count: onlineCount }] : []),
      ...(offlineCount > 0 ? [{ agentVersion: row.agentVersion || null, fxpVersion: row.fxpVersion || null, online: false, count: offlineCount }] : []),
    ];
  });
  return {
    ...pageResult(pageRows.map(withComputedOnline), totalItems, window),
    scopeTotalItems,
    onlineItems,
    versionCounts,
  };
}

export async function getHostSummaryScope(input: Omit<HostListQuery, keyof PageRequest>) {
  const db = await getDb();
  if (!db) return { hostIds: [] as number[], totalHosts: 0, onlineHosts: 0 };
  const condition = hostListCondition(input);
  const cutoffSeconds = Math.floor((Date.now() - HOST_ONLINE_TTL_MS) / 1000);
  const onlineExpression = sql<number>`CASE
    WHEN ${hosts.isOnline} = ${sqlBool(true)}
      AND ${hosts.lastHeartbeat} IS NOT NULL
      AND ${hosts.lastHeartbeat} >= ${cutoffSeconds}
    THEN 1 ELSE 0 END`;
  const aggregate = db
    .select({
      totalHosts: sql<number>`COUNT(*)`,
      onlineHosts: sql<number>`COALESCE(SUM(${onlineExpression}), 0)`,
    })
    .from(hosts);
  const idsQuery = db.select({ id: hosts.id }).from(hosts);
  const [totals, idRows] = await Promise.all([
    condition ? aggregate.where(condition) : aggregate,
    condition ? idsQuery.where(condition) : idsQuery,
  ]);
  return {
    hostIds: idRows.map((row: any) => Number(row.id)).filter((id: number) => id > 0),
    totalHosts: Number(totals[0]?.totalHosts || 0),
    onlineHosts: Number(totals[0]?.onlineHosts || 0),
  };
}

export async function getHostStatusRows(input: Omit<HostListQuery, keyof PageRequest> & { hostIds: number[] }) {
  const db = await getDb();
  if (!db) return [];
  const requestedIds = normalizeIds(input.hostIds);
  if (requestedIds.length === 0) return [];
  const scopeCondition = hostListCondition(input);
  const idCondition = inArray(hosts.id, requestedIds);
  const condition = scopeCondition ? and(scopeCondition, idCondition) : idCondition;
  const rows = await db
    .select({
      id: hosts.id,
      isOnline: hosts.isOnline,
      lastHeartbeat: hosts.lastHeartbeat,
      agentVersion: hosts.agentVersion,
      fxpVersion: hosts.fxpVersion,
      agentUpgradeRequested: hosts.agentUpgradeRequested,
      agentUpgradeTargetVersion: hosts.agentUpgradeTargetVersion,
      agentUpgradeRequestedAt: hosts.agentUpgradeRequestedAt,
      updatedAt: hosts.updatedAt,
    })
    .from(hosts)
    .where(condition);
  return rows.map(withComputedOnline);
}

export async function getHostUpgradeCandidates(input: Omit<HostListQuery, keyof PageRequest>) {
  const db = await getDb();
  if (!db) return [];
  const condition = hostListCondition(input);
  const query = db
    .select({
      id: hosts.id,
      isOnline: hosts.isOnline,
      lastHeartbeat: hosts.lastHeartbeat,
      agentVersion: hosts.agentVersion,
      fxpVersion: hosts.fxpVersion,
      agentUpgradeRequested: hosts.agentUpgradeRequested,
      agentUpgradeTargetVersion: hosts.agentUpgradeTargetVersion,
      agentUpgradeRequestedAt: hosts.agentUpgradeRequestedAt,
    })
    .from(hosts);
  const rows = condition ? await query.where(condition) : await query;
  return rows.map(withComputedOnline);
}

function compactHostOption(host: any) {
  return {
    id: host?.id,
    userId: host?.userId,
    name: host?.name,
    ip: host?.ip,
    ipv4: host?.ipv4,
    ipv6: host?.ipv6,
    entryIp: host?.entryIp,
    tunnelEntryIp: host?.tunnelEntryIp,
    hostType: host?.hostType,
    isOnline: host?.isOnline,
    lastHeartbeat: host?.lastHeartbeat,
    agentVersion: host?.agentVersion,
    fxpVersion: host?.fxpVersion,
    memoryTotal: host?.memoryTotal,
    ddnsEnabled: host?.ddnsEnabled,
    ddnsDomain: host?.ddnsDomain,
    portRangeStart: host?.portRangeStart,
    portRangeEnd: host?.portRangeEnd,
    portAllowlist: host?.portAllowlist,
    blockHttp: host?.blockHttp,
    blockSocks: host?.blockSocks,
    blockTls: host?.blockTls,
    geoCountryCode: host?.geoCountryCode,
    geoCountryName: host?.geoCountryName,
    geoRegion: host?.geoRegion,
    geoEmoji: host?.geoEmoji,
    geoLatitudeMicro: host?.geoLatitudeMicro,
    geoLongitudeMicro: host?.geoLongitudeMicro,
    geoUpdatedAt: host?.geoUpdatedAt,
    geoManual: !!host?.geoManual,
    addressManual: !!host?.addressManual,
  };
}

function normalizeRawHostDate(value: unknown) {
  if (value === null || value === undefined || value === "") return value ?? null;
  if (value instanceof Date) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric < 100_000_000_000 ? numeric * 1000 : numeric);
  }
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : value;
}

function normalizeRawHostRow(row: Record<string, any>): Record<string, any> {
  return {
    ...row,
    lastHeartbeat: normalizeRawHostDate(row.lastHeartbeat),
    createdAt: normalizeRawHostDate(row.createdAt),
    updatedAt: normalizeRawHostDate(row.updatedAt),
    geoUpdatedAt: normalizeRawHostDate(row.geoUpdatedAt),
  };
}

export async function getHostOptions(ownerUserId?: number, allowedHostIds?: number[], sortUserId?: number) {
  const db = await getDb();
  if (!db) return [];
  const condition = hostListCondition({ ownerUserId, allowedHostIds });

  try {
    const preferredHostIds = await getUserHostDisplayOrder(sortUserId);
    const query = db
      .select({
        id: hosts.id,
        userId: hosts.userId,
        name: hosts.name,
        ip: hosts.ip,
        ipv4: hosts.ipv4,
        ipv6: hosts.ipv6,
        entryIp: hosts.entryIp,
        tunnelEntryIp: hosts.tunnelEntryIp,
        hostType: hosts.hostType,
        isOnline: hosts.isOnline,
        lastHeartbeat: hosts.lastHeartbeat,
        agentVersion: hosts.agentVersion,
        // compactHostOption 会带上 fxpVersion，但这条投影原来没选它：主机选项里的 FXP 版本
        // 一直是 undefined，FxpRuntimeBadge 就看不到「FXP 过旧」。
        fxpVersion: hosts.fxpVersion,
        // 内存要写「2.1G / 4.0G」时：已用在 host_metrics 里，总量只有主机表有
        memoryTotal: hosts.memoryTotal,
        ddnsEnabled: hosts.ddnsEnabled,
        ddnsDomain: hosts.ddnsDomain,
        portRangeStart: hosts.portRangeStart,
        portRangeEnd: hosts.portRangeEnd,
        portAllowlist: hosts.portAllowlist,
        blockHttp: hosts.blockHttp,
        blockSocks: hosts.blockSocks,
        blockTls: hosts.blockTls,
        geoCountryCode: hosts.geoCountryCode,
        geoCountryName: hosts.geoCountryName,
        geoRegion: hosts.geoRegion,
        geoEmoji: hosts.geoEmoji,
        geoLatitudeMicro: hosts.geoLatitudeMicro,
        geoLongitudeMicro: hosts.geoLongitudeMicro,
        geoUpdatedAt: hosts.geoUpdatedAt,
        geoManual: hosts.geoManual,
        addressManual: hosts.addressManual,
      })
      .from(hosts);
    const rows = condition
      ? await query.where(condition).orderBy(...hostListOrder({ ownerUserId, allowedHostIds, sortUserId, preferredHostIds }))
      : await query.orderBy(...hostListOrder({ ownerUserId, allowedHostIds, sortUserId, preferredHostIds }));
    return rows.map(withComputedOnline).map(compactHostOption);
  } catch (error) {
    // Older databases and some dialect/driver combinations can reject the
    // compact projection or its computed ordering. A failed options query
    // must not look like an account has no hosts: fall back to SELECT * and
    // apply the same visibility/order rules in memory. This also keeps all
    // callers (not only the chain/tunnel UI) compatible during migration.
    console.warn(
      `[Hosts] compact options query failed; using compatibility fallback owner=${Number(ownerUserId || 0) || "all"}`,
      error instanceof Error ? error.message : String(error),
    );
    // Drizzle expands `db.select().from(hosts)` to every column declared in
    // the current schema, so it is not a real SELECT * fallback when an older
    // database is missing one of those columns. Use the raw driver query,
    // whose projection is resolved by the database itself, and apply the
    // visibility predicate in memory.
    const fallbackRows: Array<Record<string, any>> = await queryRaw<Record<string, any>>(`SELECT * FROM ${quoteIdentifier("hosts")}`);
    const allowed = new Set((allowedHostIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0));
    let visibleRows = fallbackRows
      .map((row) => normalizeRawHostRow(row))
      .filter((row) => Number(ownerUserId || 0) <= 0
        || Number(row.userId) === Number(ownerUserId)
        || allowed.has(Number(row.id)))
      .map(withComputedOnline);
    const preferredHostIds = await getUserHostDisplayOrder(sortUserId).catch(() => [] as number[]);
    const orderedRows = orderHostsForUser(visibleRows, preferredHostIds);
    // Keep the compatibility path subject to the same compact response
    // contract as the primary projection; in particular, never expose the
    // persisted Agent token to an options consumer.
    return orderedRows.map(compactHostOption);
  }
}

export async function orderVisibleHostsForUser<T extends { id?: unknown; sortOrder?: unknown; createdAt?: unknown }>(hostRows: T[], userId: number) {
  return orderHostsForUser(hostRows, await getUserHostDisplayOrder(userId));
}

export async function getHostById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
  return r[0] ? withComputedOnline(r[0]) : undefined;
}

/**
 * 按 id 取一批主机。
 *
 * 只查用到的那些，不整表读：调用方手里已经有 id 了，而一个部署里主机可能有上千台
 * （订阅组装那条路就吃过整表读的亏）。查不到的 id 不出现在结果里，调用方自己决定
 * 「这台机器不见了」怎么显示。
 */
export async function getHostsByIds(ids: readonly number[]) {
  const db = await getDb();
  if (!db) return [];
  const wanted = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return [];
  const rows = await db.select().from(hosts).where(inArray(hosts.id, wanted));
  return (rows as any[]).map((row) => withComputedOnline(row));
}

/**
 * 这些机器里哪些是管理员的（或者没有主人）。
 *
 * 流量记账要看入口机能不能信：租户自己的机器上跑的 Agent/FXP 可以被改成少报，
 * 管理员的不会。一次查完，只读 id、userId 和主人的角色。查不到的机器、主人已经
 * 不在的机器都不算可信。
 */
export async function getAdminTrustedHostIds(ids: readonly number[]): Promise<Set<number>> {
  const trusted = new Set<number>();
  const db = await getDb();
  if (!db) return trusted;
  const wanted = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return trusted;
  const rows = await db
    .select({ id: hosts.id, userId: hosts.userId, ownerRole: users.role })
    .from(hosts)
    .leftJoin(users, eq(hosts.userId, users.id))
    .where(inArray(hosts.id, wanted));
  for (const row of rows as any[]) {
    const ownerId = Number(row.userId || 0);
    if (ownerId <= 0 || String(row.ownerRole || "") === "admin") trusted.add(Number(row.id));
  }
  return trusted;
}

/**
 * 只要名字。
 *
 * 提醒文案里「这个端口开在哪台机器上」只需要一个名字，而 getHostsByIds 会把
 * agentToken、DDNS 配置、端口区间那一整行都读回来再扔掉 —— 定时任务每轮都跑。
 */
export async function getHostNamesByIds(ids: readonly number[]): Promise<Map<number, string>> {
  const db = await getDb();
  const result = new Map<number, string>();
  if (!db) return result;
  const wanted = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return result;
  const rows = await db.select({ id: hosts.id, name: hosts.name }).from(hosts).where(inArray(hosts.id, wanted));
  for (const row of rows as any[]) result.set(Number(row.id), String(row.name || ""));
  return result;
}

/**
 * 只数个数，不把机器整行读出来。
 *
 * 自助加机器的配额检查原来写成 `(await getHosts(userId)).length` —— 为了得到
 * 一个数字，把这个人名下每台机器的每一列（含 agentToken、DDNS 配置、端口区间
 * 那一堆）全查回来再扔掉。一个有几百台机器的用户，每点一次「添加主机」和每开
 * 一次那个对话框都要走一遍。
 */
export async function countHostsByUserId(userId: number) {
  const db = await getDb();
  if (!db) return 0;
  const owner = Number(userId);
  if (!Number.isInteger(owner) || owner <= 0) return 0;
  const rows = await db.select({ count: sql<number>`COUNT(*)` }).from(hosts).where(eq(hosts.userId, owner));
  return Math.max(0, Math.trunc(Number((rows as any[])[0]?.count) || 0));
}

/**
 * 给一组 id，回其中真实存在的那些。校验「这些主机在不在」用这个，
 * 别整表读回来再在内存里建 Set。
 */
export async function findExistingHostIds(ids: readonly number[]) {
  const db = await getDb();
  if (!db) return new Set<number>();
  const wanted = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return new Set<number>();
  const rows = await db.select({ id: hosts.id }).from(hosts).where(inArray(hosts.id, wanted));
  return new Set((rows as any[]).map((row) => Number(row.id)));
}

export async function createHost(host: InsertHost) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = await insertAndGetId("hosts", host as any);
  invalidateAgentAuthTokenCandidates();
  const created = await getHostById(id).catch(() => undefined);
  await recordConfigAuditEvent({ resourceType: "host", resourceId: id, hostId: id, action: "create", after: created });
  await refreshDatabasePoolSettings().catch(() => undefined);
  return id;
}

export async function updateHost(id: number, data: Partial<InsertHost>) {
  const db = await getDb();
  if (!db) return;
  const audit = shouldAuditConfigPatch(data as any);
  const before = audit ? await getHostById(id).catch(() => undefined) : undefined;
  await db.update(hosts).set({ ...data, updatedAt: nowDate() }).where(eq(hosts.id, id));
  if (Object.prototype.hasOwnProperty.call(data, "agentToken") || Object.prototype.hasOwnProperty.call(data, "name")) {
    invalidateAgentAuthTokenCandidates();
  }
  if (audit && before) {
    const after = await getHostById(id).catch(() => undefined);
    await recordConfigAuditEvent({ resourceType: "host", resourceId: id, hostId: id, action: "update", before, after });
  }
}

export async function reorderHosts(ids: number[], userId?: number, startIndex = 0) {
  const orderedIds = Array.from(ids)
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const q = quoteIdentifier;
  const params: any[] = [];
  let userWhere = "";
  if (userId) {
    userWhere = ` WHERE ${q("userId")} = ?`;
    params.push(userId);
  }
  const rows = await queryRaw<{ id: number; sortOrder: number }>(
    `SELECT ${q("id")}, ${q("sortOrder")} FROM ${q("hosts")}${userWhere}
      ORDER BY ${q("sortOrder")} ASC, ${q("createdAt")} DESC, ${q("id")} DESC`,
    params,
  );
  const visibleIds = rows.map((row) => Number(row.id));
  const visibleSet = new Set(visibleIds);
  if (orderedIds.some((hostId) => !visibleSet.has(hostId))) throw new Error("排序中包含无权操作或不存在的主机");
  const nextIds = reorderHostWindow(visibleIds, orderedIds, startIndex);
  const previousOrder = new Map(rows.map((row) => [Number(row.id), Number(row.sortOrder)]));
  const now = Math.floor(Date.now() / 1000);
  await withDatabaseTransaction(async () => {
    for (const [index, id] of nextIds.entries()) {
      if (previousOrder.get(id) === index) continue;
      await executeRaw(`UPDATE ${q("hosts")} SET ${q("sortOrder")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`, [index, now, id]);
    }
  });
}

export async function reorderVisibleHostsForUser(ids: number[], userId: number, allowedHostIds: number[] = [], startIndex = 0) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const normalizedUserId = Math.max(0, Math.floor(Number(userId) || 0));
  const orderedIds = normalizeIds(ids);
  if (!normalizedUserId || orderedIds.length === 0 || orderedIds.length !== ids.length) throw new Error("排序数据无效");
  const allowedIds = normalizeIds(allowedHostIds);
  const condition = allowedIds.length > 0
    ? or(eq(hosts.userId, normalizedUserId), inArray(hosts.id, allowedIds))
    : eq(hosts.userId, normalizedUserId);
  const rows = await db.select({
    id: hosts.id,
    sortOrder: hosts.sortOrder,
    createdAt: hosts.createdAt,
  }).from(hosts).where(condition);
  const preferredHostIds = await getUserHostDisplayOrder(normalizedUserId);
  const currentIds = orderHostsForUser(rows, preferredHostIds).map((host) => Number(host.id));
  const visibleSet = new Set(currentIds);
  if (orderedIds.some((hostId) => !visibleSet.has(hostId))) throw new Error("排序中包含无权操作或不存在的主机");
  const nextIds = reorderHostWindow(currentIds, orderedIds, startIndex);
  await setSetting(userHostDisplayOrderKey(normalizedUserId), JSON.stringify(nextIds));
}

export async function deleteHost(id: number) {
  const db = await getDb();
  if (!db) return;
  const before = await getHostById(id).catch(() => undefined);
  await repairPortForwardRuleHostReferences();
  /**
   * 这台机器上的落地入站要连同派生节点一起删。
   *
   * 不删的话它们全都留着：入站行指向一台已经不存在的主机（「新建节点」那一段还
   * 会把它列出来，地址解析不出来），派生节点继续待在订阅里 —— 租户的客户端里多
   * 一条永远连不上的线路，而分享记录还在，管理端看上去一切正常。
   *
   * 走 deleteProxyInbound 而不是直接 delete：它会顺带删掉派生节点，而删节点那一步
   * 又会解绑引用它的转发规则、清掉分享行。这三件事漏一件都会留下一处对不上。
   */
  const { getProxyInboundsByHost, deleteProxyInbound } = await import("./proxyInboundRepository");
  for (const inbound of await getProxyInboundsByHost(id)) {
    await deleteProxyInbound(Number((inbound as any).id));
  }
  // 这台机器上的规则整批删行：先把它们发布过的专属域名记进待删表（见 ruleEntryDomainRepository）。
  const retiredRuleDomains = await recordRuleEntryDomainCleanupsBeforeDelete({ hostId: id }).catch(() => 0);
  await db.delete(forwardRules).where(eq(forwardRules.hostId, id));
  if (retiredRuleDomains > 0) signalRuleEntryDomainCleanup("host-deleted");
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.exitHostId, id));
  await db.delete(agentTokens).where(eq(agentTokens.hostId, id));
  await db.delete(userHostPermissions).where(eq(userHostPermissions.hostId, id));
  await db.delete(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.hostId, id));
  await db.delete(hostGroupMembers).where(eq(hostGroupMembers.hostId, id));
  await db.delete(hostMetrics).where(eq(hostMetrics.hostId, id));
  await db.delete(hostProbeServiceStats).where(eq(hostProbeServiceStats.hostId, id));
  await db.delete(hostTrafficCounters).where(eq(hostTrafficCounters.hostId, id));
  /**
   * 按规则记的那份计数也要删。
   *
   * 上下这几行已经清了整机计数、流量明细和分桶统计，唯独这一张漏了 —— 而它是
   * 四张里**唯一没有按时间清理的**：明细和分桶有 72 小时的保留期兜底，这张是
   * 累计计数，没有时间戳可扫，只能靠删。
   *
   * 留着的后果不是多几行垃圾：重算用户总流量时是直接 SUM 这张表、不 join
   * forward_rules 的，于是一台已经删掉的机器跑过的量会永远算在这个租户头上，
   * 而管理员再也没法把它清掉 —— 「重置这条转发的流量」要按规则 id 来，规则
   * 已经跟着主机一起没了。
   */
  await db.delete(forwardRuleTrafficCounters).where(eq(forwardRuleTrafficCounters.hostId, id));
  await db.delete(trafficStats).where(eq(trafficStats.hostId, id));
  await db.delete(trafficStatBuckets).where(eq(trafficStatBuckets.hostId, id));
  await db.delete(trafficBillingConfigs).where(and(
    eq(trafficBillingConfigs.resourceType, "host"),
    eq(trafficBillingConfigs.resourceId, id),
  ));
  await db.delete(hosts).where(eq(hosts.id, id));
  removePresenceCapableHost(id);
  invalidateAgentAuthTokenCandidates();
  if (before) await recordConfigAuditEvent({ resourceType: "host", resourceId: id, hostId: id, action: "delete", before });
  await refreshDatabasePoolSettings().catch(() => undefined);
}

/**
 * 手动删主机前，列出还有哪些东西在用这台机器。
 *
 * deleteHost 只清规则、权限、套餐关联这些「挂在主机下面」的行，不动隧道、跃点、额外出口、
 * 转发组成员 —— 这些行删了主机后还留着，指向一个不存在的 hostId：隧道下发时找不到入口/出口，
 * 转发组 DDNS 解析到空地址，套餐继续卖一台已经没有的机器。所以要求先解除引用再删。
 * Agent 令牌不算：它就是这台机器自己的，deleteHost 会一起删。
 */
export async function getHostDeleteReferenceLabels(hostId: number): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const [tunnelRows, hopRows, extraExitRows, groupRows, planRows] = await Promise.all([
    db.select({ id: tunnels.id, name: tunnels.name, entryHostId: tunnels.entryHostId, exitHostId: tunnels.exitHostId })
      .from(tunnels)
      .where(sql`${tunnels.entryHostId} = ${hostId} OR ${tunnels.exitHostId} = ${hostId}`),
    db.select({ id: tunnels.id, name: tunnels.name })
      .from(tunnelHops)
      .innerJoin(tunnels, eq(tunnelHops.tunnelId, tunnels.id))
      .where(eq(tunnelHops.hostId, hostId)),
    db.select({ id: tunnels.id, name: tunnels.name })
      .from(tunnelExitNodes)
      .innerJoin(tunnels, eq(tunnelExitNodes.tunnelId, tunnels.id))
      .where(eq(tunnelExitNodes.hostId, hostId)),
    db.select({ id: forwardGroups.id, name: forwardGroups.name })
      .from(forwardGroupMembers)
      .innerJoin(forwardGroups, eq(forwardGroupMembers.groupId, forwardGroups.id))
      .where(and(eq(forwardGroupMembers.memberType, "host"), eq(forwardGroupMembers.hostId, hostId))),
    db.select({ id: subscriptionPlans.id, name: subscriptionPlans.name })
      .from(subscriptionPlanHosts)
      .innerJoin(subscriptionPlans, eq(subscriptionPlanHosts.planId, subscriptionPlans.id))
      .where(eq(subscriptionPlanHosts.hostId, hostId)),
  ]);
  const names = (rows: any[]) => {
    const unique = Array.from(new Map(rows.map((row) => [Number(row.id), String(row.name || `#${row.id}`)])).values());
    const shown = unique.slice(0, 5).map((name) => `「${name}」`).join("、");
    return unique.length > 5 ? `${shown} 等 ${unique.length} 个` : shown;
  };
  const labels: string[] = [];
  const entryTunnels = (tunnelRows as any[]).filter((row) => Number(row.entryHostId) === hostId);
  const exitTunnels = (tunnelRows as any[]).filter((row) => Number(row.exitHostId) === hostId);
  if (entryTunnels.length > 0) labels.push(`隧道入口 ${names(entryTunnels)}`);
  if (exitTunnels.length > 0) labels.push(`隧道出口 ${names(exitTunnels)}`);
  if (hopRows.length > 0) labels.push(`隧道中转 ${names(hopRows as any[])}`);
  if (extraExitRows.length > 0) labels.push(`隧道额外出口 ${names(extraExitRows as any[])}`);
  if (groupRows.length > 0) labels.push(`转发组成员 ${names(groupRows as any[])}`);
  if (planRows.length > 0) labels.push(`套餐 ${names(planRows as any[])}`);
  return labels;
}

async function hostHasLiveReferences(hostId: number) {
  const db = await getDb();
  if (!db) return true;
  const [ruleBlockers, forwardGroupRows, tunnelRows, tunnelHopRows, tunnelExitRows, planRows, tokenRows] = await Promise.all([
    getHostRuleDeleteBlockers(hostId),
    db.select({ count: sqlCountAll() }).from(forwardGroupMembers).where(and(
      eq(forwardGroupMembers.memberType, "host"),
      eq(forwardGroupMembers.hostId, hostId),
    )),
    db.select({ count: sqlCountAll() }).from(tunnels).where(sql`${tunnels.entryHostId} = ${hostId} OR ${tunnels.exitHostId} = ${hostId}`),
    db.select({ count: sqlCountAll() }).from(tunnelHops).where(eq(tunnelHops.hostId, hostId)),
    db.select({ count: sqlCountAll() }).from(tunnelExitNodes).where(eq(tunnelExitNodes.hostId, hostId)),
    db.select({ count: sqlCountAll() }).from(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.hostId, hostId)),
    db.select({ count: sqlCountAll() }).from(agentTokens).where(eq(agentTokens.hostId, hostId)),
  ]);
  return ruleBlockers.ruleCount > 0
    || ruleBlockers.managedRuleCount > 0
    || Number(forwardGroupRows[0]?.count) > 0
    || Number(tunnelRows[0]?.count) > 0
    || Number(tunnelHopRows[0]?.count) > 0
    || Number(tunnelExitRows[0]?.count) > 0
    || Number(planRows[0]?.count) > 0
    || Number(tokenRows[0]?.count) > 0;
}

export async function deleteHostIfUnreferenced(hostId: number) {
  const id = Number(hostId || 0);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (await hostHasLiveReferences(id)) return false;
  await deleteHost(id);
  return true;
}

export async function purgeOrphanedAgentHosts() {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ id: hosts.id }).from(hosts).where(sql`
    (${hosts.agentToken} IS NULL OR ${hosts.agentToken} = '')
    AND ${hosts.agentVersion} IS NOT NULL
  `);
  let removed = 0;
  for (const row of rows as any[]) {
    if (await deleteHostIfUnreferenced(Number(row.id || 0))) removed += 1;
  }
  return removed;
}

export async function updateHostHeartbeat(id: number, metrics?: Partial<InsertHost>) {
  const db = await getDb();
  if (!db) return;
  const now = nowDate();
  await db.update(hosts).set({ isOnline: true, lastHeartbeat: now, updatedAt: now, ...(metrics ?? {}) }).where(eq(hosts.id, id));
}

/**
 * Refresh only the liveness columns. Presence requests must not write a
 * metric row or carry any runtime reconciliation fields.
 */
export async function touchHostHeartbeat(id: number) {
  const db = await getDb();
  if (!db) return;
  const now = nowDate();
  await db.update(hosts).set({ isOnline: true, lastHeartbeat: now, updatedAt: now }).where(eq(hosts.id, id));
}

export async function getStaleOnlineHosts(timeoutMs = HOST_ONLINE_TTL_MS) {
  const db = await getDb();
  if (!db) return [];
  const cutoffSec = Math.floor((Date.now() - timeoutMs) / 1000);
  return db.select().from(hosts).where(sql`
    ${hosts.isOnline} = ${sqlBool(true)}
    AND ${hosts.lastHeartbeat} IS NOT NULL
    AND ${hosts.lastHeartbeat} < ${cutoffSec}
  `);
}

/**
 * 还没定到位、也不是手动指定位置的主机。
 *
 * 给定时补漏用：以前只有打开主机列表才会触发一次定位，ipapi.co 限流那阵子
 * 没定到的机器就一直空着，直到有人再翻列表。选整行是因为定位要用 ipv4/ipv6/
 * entryIp 挑地址，跟 scheduleHostGeoRefresh 吃的是同一种行。
 */
export async function getHostsMissingGeo(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(hosts).where(sql`
    ${hosts.geoCountryCode} IS NULL OR ${hosts.geoCountryCode} = ''
      OR ${hosts.geoLatitudeMicro} IS NULL OR ${hosts.geoLongitudeMicro} IS NULL
  `).orderBy(asc(hosts.id)).limit(Math.max(1, Math.floor(limit)));
  return rows.map(withComputedOnline);
}

/** 以前手动指定过位置的主机：清掉标记和坐标，交回自动定位。返回改了几台。 */
export async function resetManualHostLocations() {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ id: hosts.id }).from(hosts).where(sql`${hosts.geoManual} = ${sqlBool(true)}`);
  if (rows.length === 0) return 0;
  await db.update(hosts).set({
    geoManual: false,
    geoCountryCode: null,
    geoCountryName: null,
    geoRegion: null,
    geoEmoji: null,
    geoLatitudeMicro: null,
    geoLongitudeMicro: null,
    geoUpdatedAt: null,
  } as any).where(inArray(hosts.id, rows.map((row: { id: number }) => row.id)));
  return rows.length;
}

export async function markHostsOffline(hostIds: number[]) {
  const ids = Array.from(new Set(hostIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  if (ids.length === 0) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const idList = inList(ids);
  await executeRaw(
    `UPDATE ${quoteIdentifier("hosts")}
     SET ${quoteIdentifier("isOnline")} = ?,
         ${quoteIdentifier("updatedAt")} = ?
     WHERE ${quoteIdentifier("id")} IN ${idList.sql}`,
    [boolValue(false), nowSec, ...idList.params],
  );
  return ids.length;
}

/**
 * Atomically transition only hosts whose heartbeat is still stale. The
 * conditional update prevents a presence request racing the sweep from being
 * overwritten, and the returned IDs let callers notify exactly once.
 */
export async function markStaleHostsOffline(hostIds: number[], timeoutMs = HOST_ONLINE_TTL_MS) {
  const ids = Array.from(new Set(hostIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  if (ids.length === 0) return [] as number[];
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = Math.floor((Date.now() - timeoutMs) / 1000);
  const transitioned: number[] = [];
  for (const id of ids) {
    const result = await executeRaw(
      `UPDATE ${quoteIdentifier("hosts")}
       SET ${quoteIdentifier("isOnline")} = ?,
           ${quoteIdentifier("updatedAt")} = ?
       WHERE ${quoteIdentifier("id")} = ?
         AND ${quoteIdentifier("isOnline")} = ?
         AND ${quoteIdentifier("lastHeartbeat")} IS NOT NULL
         AND ${quoteIdentifier("lastHeartbeat")} < ?`,
      [boolValue(false), nowSec, id, boolValue(true), cutoffSec],
    );
    if (rawAffectedRows(result) > 0) transitioned.push(id);
  }
  return transitioned;
}

export async function markHostOffline(hostId: number) {
  return markHostsOffline([hostId]);
}

export async function requestHostAgentUpgrade(
  hostId: number,
  targetVersion: string | null,
  releaseVersion?: string | null,
  requestedAt?: Date | null,
) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({
    agentUpgradeRequested: true,
    agentUpgradeTargetVersion: targetVersion,
    agentUpgradeReleaseVersion: releaseVersion || null,
    agentUpgradeRequestedAt: requestedAt || nowDate(),
    updatedAt: nowDate(),
  }).where(eq(hosts.id, hostId));
}

export async function clearHostAgentUpgradeRequest(hostId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({
    agentUpgradeRequested: false,
    agentUpgradeTargetVersion: null,
    agentUpgradeReleaseVersion: null,
    updatedAt: nowDate(),
  }).where(eq(hosts.id, hostId));
}

export async function clearStaleHostAgentUpgradeRequests(timeoutMs = 10 * 60 * 1000) {
  const db = await getDb();
  if (!db) return;
  const cutoffSec = Math.floor((Date.now() - timeoutMs) / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  await executeRaw(
    `UPDATE ${quoteIdentifier("hosts")}
     SET ${quoteIdentifier("agentUpgradeRequested")} = ?,
         ${quoteIdentifier("agentUpgradeTargetVersion")} = NULL,
         ${quoteIdentifier("agentUpgradeReleaseVersion")} = NULL,
         ${quoteIdentifier("updatedAt")} = ?
     WHERE ${quoteIdentifier("agentUpgradeRequested")} = ?
       AND ${quoteIdentifier("agentUpgradeRequestedAt")} IS NOT NULL
       AND ${quoteIdentifier("agentUpgradeRequestedAt")} < ?`,
    [boolValue(false), nowSec, boolValue(true), cutoffSec],
  );
}

function dateTimeMs(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) && time > 0 ? time : null;
  }
  const text = String(value).trim();
  const numericText = typeof value === "number" || /^\d+(\.\d+)?$/.test(text);
  const numberValue = Number(value);
  if (numericText) {
    return Number.isFinite(numberValue) && numberValue > 0
      ? (numberValue < 100_000_000_000 ? numberValue * 1000 : numberValue)
      : null;
  }
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hostResetDueToday(host: any, now: Date) {
  const calendar = billingCalendarParts(now);
  const resetDay = Math.min(31, Math.max(1, Math.floor(Number(host?.trafficResetDay || 1))));
  const dueDay = Math.min(resetDay, billingDaysInMonth(calendar.year, calendar.month));
  if (calendar.day < dueDay) return false;

  const nowMs = now.getTime();
  const purchasedAt = dateTimeMs(host?.purchasedAt);
  if (purchasedAt != null && nowMs < purchasedAt) return false;
  const stoppedAt = dateTimeMs(host?.stoppedAt);
  if (stoppedAt != null && nowMs >= stoppedAt) return false;

  const monthStartMs = billingMonthStart(now).getTime();
  const lastResetAt = dateTimeMs(host?.lastTrafficReset);
  return lastResetAt == null || lastResetAt < monthStartMs;
}

export async function getHostsForTrafficAutoReset(now = new Date()) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(hosts).where(eq(hosts.trafficAutoReset, true));
  return rows.filter((host: any) => hostResetDueToday(host, now));
}

export async function markHostTrafficReset(hostId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({ lastTrafficReset: nowDate(), updatedAt: nowDate() }).where(eq(hosts.id, hostId));
}

const HOST_BILLING_CYCLE_MONTHS = new Set([1, 3, 6, 12, 24, 36]);

function hostBillingCycleMonths(value: unknown) {
  const months = Math.floor(Number(value));
  return HOST_BILLING_CYCLE_MONTHS.has(months) ? months : 1;
}

function hostBillingMonth(value: unknown) {
  return Math.min(12, Math.max(1, Math.floor(Number(value) || 1)));
}

function hostBillingDay(value: unknown) {
  return Math.min(31, Math.max(1, Math.floor(Number(value) || 1)));
}

function hostDate(value: unknown) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const text = String(value ?? "").trim();
  const numeric = Number(value);
  const date = text && Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(text)
    ? new Date(numeric < 100_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value as any);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Calculate the next host expiry while keeping all calendar arithmetic in the
 * panel billing timezone. Monthly/quarterly/half-year cycles advance from the
 * current expiry and use billingDay; annual cycles additionally honour
 * the configured billingMonth. Short cycles retain the original month
 * because a month anchor is not meaningful for a monthly period.
 */
export function nextHostBillingExpiry(
  stoppedAt: Date,
  cycleMonthsValue: unknown,
  billingMonthValue: unknown,
  billingDayValue: unknown,
) {
  const cycleMonths = hostBillingCycleMonths(cycleMonthsValue);
  const billingMonth = hostBillingMonth(billingMonthValue);
  const billingDay = hostBillingDay(billingDayValue);
  const current = billingCalendarParts(stoppedAt);
  let next: Date;

  if (cycleMonths >= 12) {
    const years = Math.max(1, Math.floor(cycleMonths / 12));
    const year = current.year + years;
    const day = Math.min(billingDay, billingDaysInMonth(year, billingMonth));
    next = billingDateTime(year, billingMonth, day, current.hour, current.minute, current.second, stoppedAt.getMilliseconds());
  } else {
    const advanced = billingAddMonthsClamped(stoppedAt, cycleMonths);
    const target = billingCalendarParts(advanced);
    const day = Math.min(billingDay, billingDaysInMonth(target.year, target.month));
    next = billingDateTime(target.year, target.month, day, current.hour, current.minute, current.second, stoppedAt.getMilliseconds());
  }

  // A malformed/legacy anchor must never leave an already expired value in
  // place. Advance until it is strictly in the future (bounded for safety).
  let guard = 0;
  while (next.getTime() <= stoppedAt.getTime() && guard++ < 1200) {
    const previous = next;
    if (cycleMonths >= 12) {
      const nextYear = billingCalendarParts(previous).year + Math.max(1, Math.floor(cycleMonths / 12));
      const day = Math.min(billingDay, billingDaysInMonth(nextYear, billingMonth));
      next = billingDateTime(nextYear, billingMonth, day, current.hour, current.minute, current.second, stoppedAt.getMilliseconds());
    } else {
      const advanced = billingAddMonthsClamped(previous, cycleMonths);
      const target = billingCalendarParts(advanced);
      const day = Math.min(billingDay, billingDaysInMonth(target.year, target.month));
      next = billingDateTime(target.year, target.month, day, current.hour, current.minute, current.second, stoppedAt.getMilliseconds());
    }
  }
  return next;
}

/** Extend hosts whose configured expiry action is cycle-based.
 *
 * The conditional update makes the sweep idempotent across multiple panel
 * instances: if another worker advances the same host first, this update is a
 * no-op. Existing hosts default to `none` and are therefore untouched.
 */
export async function extendDueHostBillingPeriods(now = new Date()) {
  const db = await getDb();
  if (!db) return 0;
  const dueHosts = await db.select().from(hosts).where(and(
    eq(hosts.expiryHandling, "extend_cycle"),
    isNotNull(hosts.stoppedAt),
  ));
  let extended = 0;
  for (const host of dueHosts as any[]) {
    const stoppedAt = hostDate(host.stoppedAt);
    if (!stoppedAt || stoppedAt.getTime() > now.getTime()) continue;
    const next = nextHostBillingExpiry(
      stoppedAt,
      host.billingCycleMonths,
      host.billingMonth,
      host.billingDay,
    );
    // Catch up a host that was offline for several billing periods in one
    // sweep so reminders immediately use the next future expiry.
    let future = next;
    let guard = 0;
    while (future.getTime() <= now.getTime() && guard++ < 1200) {
      future = nextHostBillingExpiry(future, host.billingCycleMonths, host.billingMonth, host.billingDay);
    }
    const result = await db.update(hosts).set({
      stoppedAt: future,
      updatedAt: nowDate(),
    }).where(and(
      eq(hosts.id, Number(host.id)),
      eq(hosts.expiryHandling, "extend_cycle"),
      eq(hosts.stoppedAt, stoppedAt),
    ));
    if (rawAffectedRows(result) > 0) extended += 1;
  }
  return extended;
}

export async function getHostByAgentToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(hosts).where(eq(hosts.agentToken, token)).limit(1);
  return r[0];
}

export async function getHostAgentPresenceById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select({
    id: hosts.id,
    name: hosts.name,
    ip: hosts.ip,
    ipv4: hosts.ipv4,
    ipv6: hosts.ipv6,
    isOnline: hosts.isOnline,
    lastHeartbeat: hosts.lastHeartbeat,
  })
    .from(hosts)
    .where(eq(hosts.id, id))
    .limit(1);
  return rows[0];
}

export async function getHostRuleDeleteBlockers(hostId: number) {
  const db = await getDb();
  if (!db) return {
    ruleCount: 0,
    ruleOwners: [],
    managedRuleCount: 0,
    managedRuleOwners: [],
    pendingCleanupCount: 0,
  };
  await repairPortForwardRuleHostReferences();
  await repairForwardGroupRuleIntegrity(hostId);
  const managedRuleSql = sql`
    ${forwardRules.forwardGroupId} IS NOT NULL
    OR ${forwardRules.forwardGroupRuleId} IS NOT NULL
    OR ${forwardRules.forwardGroupMemberId} IS NOT NULL
    OR ${forwardRules.isForwardGroupTemplate} = ${sqlBool(true)}
    OR ${forwardRules.id} IN (SELECT ${forwardGroupMembers.ruleId} FROM ${forwardGroupMembers} WHERE ${forwardGroupMembers.ruleId} IS NOT NULL)
  `;
  const [ruleOwnerRows, managedOwnerRows, pendingRows] = await Promise.all([
    db.select({
      userId: forwardRules.userId,
      username: users.username,
      name: users.name,
      count: sqlCountAll(),
    })
      .from(forwardRules)
      .leftJoin(users, eq(users.id, forwardRules.userId))
      .where(sql`
        ${forwardRules.hostId} = ${hostId}
        AND ${forwardRules.pendingDelete} = ${sqlBool(false)}
        AND NOT (${managedRuleSql})
      `)
      .groupBy(forwardRules.userId, users.username, users.name),
    db.select({
      userId: forwardRules.userId,
      username: users.username,
      name: users.name,
      count: sqlCountAll(),
    })
      .from(forwardRules)
      .leftJoin(users, eq(users.id, forwardRules.userId))
      .where(sql`
        ${forwardRules.hostId} = ${hostId}
        AND ${forwardRules.pendingDelete} = ${sqlBool(false)}
        AND (${managedRuleSql})
      `)
      .groupBy(forwardRules.userId, users.username, users.name),
    db.select({ count: sqlCountAll() }).from(forwardRules).where(sql`
      ${forwardRules.hostId} = ${hostId}
      AND ${forwardRules.pendingDelete} = ${sqlBool(true)}
      AND ${forwardRules.isRunning} = ${sqlBool(true)}
    `),
  ]);
  const normalizeOwners = (rows: any[]) => rows
    .map((row: any) => ({
      userId: Number(row.userId) || 0,
      username: String(row.username || "").trim() || null,
      name: String(row.name || "").trim() || null,
      ruleCount: Number(row.count) || 0,
    }))
    .filter((owner) => owner.ruleCount > 0)
    .sort((a, b) => b.ruleCount - a.ruleCount || a.userId - b.userId);
  const ruleOwners = normalizeOwners(ruleOwnerRows as any[]);
  const managedRuleOwners = normalizeOwners(managedOwnerRows as any[]);
  return {
    ruleCount: ruleOwners.reduce((total, owner) => total + owner.ruleCount, 0),
    ruleOwners,
    managedRuleCount: managedRuleOwners.reduce((total, owner) => total + owner.ruleCount, 0),
    managedRuleOwners,
    pendingCleanupCount: Number(pendingRows[0]?.count) || 0,
  };
}

export async function releaseHostPendingRuleCleanup(hostId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ count: sqlCountAll() }).from(forwardRules).where(sql`
    ${forwardRules.hostId} = ${hostId}
    AND ${forwardRules.pendingDelete} = ${sqlBool(true)}
    AND ${forwardRules.isRunning} = ${sqlBool(true)}
  `);
  const count = Number(rows[0]?.count) || 0;
  if (count <= 0) return 0;
  await db.update(forwardRules).set({
    isEnabled: false,
    isRunning: false,
    updatedAt: nowDate(),
  }).where(sql`
    ${forwardRules.hostId} = ${hostId}
    AND ${forwardRules.pendingDelete} = ${sqlBool(true)}
    AND ${forwardRules.isRunning} = ${sqlBool(true)}
  `);
  return count;
}

