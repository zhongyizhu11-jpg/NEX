import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  balanceTransactions,
  forwardGroups,
  forwardRules,
  hosts,
  trafficBillingConfigs,
  trafficBillingRecords,
  trafficBillingRuleUsage,
  trafficBillingUsage,
  trafficStats,
  tunnels,
  userTrafficBillingPermissions,
  users,
  type InsertTrafficBillingConfig,
} from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, insertAndGetId, nowDate, queryRaw, quoteDbIdentifier, withDatabaseTransaction } from "../dbRuntime";
import { getSetting, setSetting } from "./settingsRepository";
import { getTrafficStockUsage } from "./productStockRepository";
import { MAX_PRODUCT_STOCK } from "../../shared/productStock";
import { formatTrafficMultiplier, normalizeTrafficMultiplier } from "../../shared/trafficMultiplier";
import { countEnabledForwardRulesByUserIds, getBillingRelevantRulesByHostIds, getBillingRelevantRulesByUserId } from "./forwardRuleRepository";

const GB_BYTES = 1024 ** 3;
const MILLI_CENTS_PER_CENT = 1000;
const BILLING_DENOMINATOR = 100n * BigInt(MILLI_CENTS_PER_CENT);
const TRAFFIC_BILLING_RULE_USAGE_BACKFILL_MARKER = "traffic-billing-rule-usage-v1";
const TRAFFIC_BILLING_ENABLED_CACHE_MS = 5_000;
const TRAFFIC_BILLING_LOCK_CHUNK = 500;
let trafficBillingEnabledCache: { value: boolean; expiresAt: number } | null = null;
let lastTrafficBillingAccessWarningAt = 0;

/**
 * Serialize usage read/modify/write operations across panel instances.
 * SQLite transactions already hold a database-wide write reservation; the
 * row lock is required for MySQL/PostgreSQL where multiple instances share
 * the same database.
 */
export async function lockTrafficBillingUserRows(userIds: number | number[]) {
  const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : [userIds])
    .map((value) => Math.floor(Number(value) || 0))
    .filter((value) => value > 0)))
    .sort((left, right) => left - right);
  if (ids.length === 0) return;
  const q = quoteDbIdentifier;
  const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
  /*
    以前一个用户一条 SELECT … FOR UPDATE：一次流量上报涉及几百个用户就是几百次往返，
    而且全程握着事务。改成按 id 分批（500 个一批，躲开各库的占位符上限）一条语句锁住：
    - 加锁顺序不变：ids 已升序、批次按升序处理，每批 ORDER BY id 让 MySQL / PostgreSQL
      按主键升序逐行上锁，和并发的其他上报之间仍是同一个全局顺序，不会互相死锁；
    - SQLite 没有行锁（事务本身已独占写），这里只是一次存在性检查；
    - 少了任何一行就和以前一样报 User not found。
  */
  for (let index = 0; index < ids.length; index += TRAFFIC_BILLING_LOCK_CHUNK) {
    const chunk = ids.slice(index, index + TRAFFIC_BILLING_LOCK_CHUNK);
    const rows = await queryRaw<{ id: number }>(
      `SELECT ${q("id")} AS ${q("id")} FROM ${q("users")} WHERE ${q("id")} IN (${chunk.map(() => "?").join(", ")}) ORDER BY ${q("id")}${lock}`,
      chunk,
    );
    if (rows.length < chunk.length) throw new Error("User not found");
  }
}

export type TrafficBillingResourceType = "host" | "tunnel" | "forward_group";

export type TrafficBillingResourceIds = {
  hostIds: number[];
  tunnelIds: number[];
  forwardGroupIds: number[];
};

export type TrafficBillingAccessSnapshot = {
  status: "disabled" | "ready" | "degraded" | "failed";
  enabled: boolean;
  activeResourceIds: TrafficBillingResourceIds;
  usableResourceIds: TrafficBillingResourceIds;
};

function emptyTrafficBillingResourceIds() {
  return { hostIds: [] as number[], tunnelIds: [] as number[], forwardGroupIds: [] as number[] };
}

function trafficBillingResourceIdsFromRows(rows: any[]) {
  return {
    hostIds: Array.from(new Set(rows
      .filter((row: any) => row.resourceType === "host")
      .map((row: any) => Number(row.resourceId))
      .filter((id: number) => id > 0))),
    tunnelIds: Array.from(new Set(rows
      .filter((row: any) => row.resourceType === "tunnel")
      .map((row: any) => Number(row.resourceId))
      .filter((id: number) => id > 0))),
    forwardGroupIds: Array.from(new Set(rows
      .filter((row: any) => row.resourceType === "forward_group")
      .map((row: any) => Number(row.resourceId))
      .filter((id: number) => id > 0))),
  };
}

function warnTrafficBillingAccessFailure(error: unknown) {
  const now = Date.now();
  if (now - lastTrafficBillingAccessWarningAt < 60_000) return;
  lastTrafficBillingAccessWarningAt = now;
  console.warn("[TrafficBilling] optional access lookup failed; self-owned resources remain available:", error instanceof Error ? error.message : String(error));
}

function normalizeMultiplier(value: number) {
  return normalizeTrafficMultiplier(value);
}

function normalizePrice(value: number) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function normalizePriceMilliCents(value: number) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function configPriceMilliCents(config: any) {
  const milliCents = normalizePriceMilliCents(Number(config?.pricePerGbMilliCents || 0));
  if (milliCents > 0) return milliCents;
  return normalizePrice(Number(config?.pricePerGbCents || 0)) * MILLI_CENTS_PER_CENT;
}

function billedFullGb(totalBytes: number) {
  return Math.max(0, Math.floor(Math.max(0, Number(totalBytes) || 0) / GB_BYTES));
}

function effectiveAmountCentsForGb(gb: number, pricePerGbMilliCents: number, multiplier: number) {
  const numerator = BigInt(Math.max(0, Math.floor(gb)))
    * BigInt(normalizePriceMilliCents(pricePerGbMilliCents))
    * BigInt(normalizeMultiplier(multiplier));
  return Number(numerator / BILLING_DENOMINATOR);
}

function effectiveAmountCentsForBytes(bytes: number, pricePerGbMilliCents: number, multiplier: number) {
  const normalizedBytes = Math.max(0, Math.floor(Number(bytes) || 0));
  const numerator = BigInt(normalizedBytes)
    * BigInt(normalizePriceMilliCents(pricePerGbMilliCents))
    * BigInt(normalizeMultiplier(multiplier));
  return Number(numerator / (BigInt(GB_BYTES) * BILLING_DENOMINATOR));
}

function isTrafficBillingResourceType(value: unknown): value is TrafficBillingResourceType {
  return value === "host" || value === "tunnel" || value === "forward_group";
}

function forwardGroupBillingKind(group: any) {
  const mode = String(group?.groupMode || "failover");
  if (mode === "port") return "端口转发";
  if (mode === "chain") return "转发链";
  if (mode === "entry") return "入口组";
  if (mode === "exit") return "出口组";
  if (group?.groupType === "tunnel") return "隧道转发组";
  return "转发组";
}

function trafficBillingResourceLabel(resourceType: TrafficBillingResourceType) {
  if (resourceType === "host") return "整台主机";
  if (resourceType === "tunnel") return "隧道转发";
  return "转发资源";
}

async function getBillingResourceMultiplier(resourceType: TrafficBillingResourceType, resourceId: number, fallback = 100) {
  const db = await getDb();
  if (!db) return normalizeMultiplier(fallback);
  if (resourceType === "tunnel") {
    const rows = await db.select({ trafficMultiplier: tunnels.trafficMultiplier }).from(tunnels).where(eq(tunnels.id, resourceId)).limit(1);
    return normalizeMultiplier(Number((rows[0] as any)?.trafficMultiplier || fallback));
  }
  if (resourceType === "forward_group") {
    const rows = await db.select({ trafficMultiplier: forwardGroups.trafficMultiplier }).from(forwardGroups).where(eq(forwardGroups.id, resourceId)).limit(1);
    return normalizeMultiplier(Number((rows[0] as any)?.trafficMultiplier || fallback));
  }
  return normalizeMultiplier(fallback);
}

async function assertBillingResourceExists(resourceType: TrafficBillingResourceType, resourceId: number) {
  const db = await getDb();
  if (!db) return;
  if (resourceType === "host") {
    const rows = await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, resourceId)).limit(1);
    if (!rows[0]) throw new Error("主机资源不存在");
    return;
  }
  if (resourceType === "tunnel") {
    const rows = await db.select({ id: tunnels.id }).from(tunnels).where(eq(tunnels.id, resourceId)).limit(1);
    if (!rows[0]) throw new Error("隧道资源不存在");
    return;
  }
  const rows = await db.select({ id: forwardGroups.id }).from(forwardGroups).where(eq(forwardGroups.id, resourceId)).limit(1);
  if (!rows[0]) throw new Error("转发资源不存在");
}

export function trafficBillingResourceCandidatesForRule(rule: any) {
  const candidates: Array<{ resourceType: TrafficBillingResourceType; resourceId: number }> = [];
  const forwardGroupId = Number(rule?.forwardGroupId || 0);
  const tunnelId = Number(rule?.tunnelId || 0);
  const hostId = Number(rule?.hostId || 0);
  if (forwardGroupId > 0) candidates.push({ resourceType: "forward_group", resourceId: forwardGroupId });
  if (tunnelId > 0) candidates.push({ resourceType: "tunnel", resourceId: tunnelId });
  if (hostId > 0) candidates.push({ resourceType: "host", resourceId: hostId });
  return candidates;
}

export async function findTrafficBillingResourcesForRules(rules: any[]) {
  const result = new Map<number, {
    resourceType: TrafficBillingResourceType;
    resourceId: number;
    config: any;
  }>();
  const candidatesByRuleId = new Map<number, ReturnType<typeof trafficBillingResourceCandidatesForRule>>();
  const resourceIds = new Map<TrafficBillingResourceType, Set<number>>([
    ["host", new Set<number>()],
    ["tunnel", new Set<number>()],
    ["forward_group", new Set<number>()],
  ]);
  for (const rule of rules) {
    const ruleId = Number(rule?.id || 0);
    if (!Number.isInteger(ruleId) || ruleId <= 0) continue;
    const candidates = trafficBillingResourceCandidatesForRule(rule);
    candidatesByRuleId.set(ruleId, candidates);
    for (const candidate of candidates) resourceIds.get(candidate.resourceType)?.add(candidate.resourceId);
  }
  if (candidatesByRuleId.size === 0) return result;

  const db = await getDb();
  if (!db) return result;
  const resourceConditions = Array.from(resourceIds.entries())
    .filter((entry): entry is [TrafficBillingResourceType, Set<number>] => entry[1].size > 0)
    .map(([resourceType, ids]) => and(
      eq(trafficBillingConfigs.resourceType, resourceType),
      inArray(trafficBillingConfigs.resourceId, Array.from(ids)),
    ));
  if (resourceConditions.length === 0) return result;
  const configs = await db
    .select()
    .from(trafficBillingConfigs)
    .where(and(
      eq(trafficBillingConfigs.enabled, true),
      or(...resourceConditions),
    ));
  const configsByResource = new Map((configs as any[]).map((config) => [
    `${String(config.resourceType)}:${Number(config.resourceId)}`,
    config,
  ]));
  for (const [ruleId, candidates] of candidatesByRuleId) {
    for (const candidate of candidates) {
      const config = configsByResource.get(`${candidate.resourceType}:${candidate.resourceId}`);
      if (!config) continue;
      result.set(ruleId, { ...candidate, config });
      break;
    }
  }
  return result;
}

export async function findTrafficBillingResourceForRule(rule: any) {
  const ruleId = Number(rule?.id || 0);
  if (Number.isInteger(ruleId) && ruleId > 0) {
    return (await findTrafficBillingResourcesForRules([rule])).get(ruleId) || null;
  }
  for (const candidate of trafficBillingResourceCandidatesForRule(rule)) {
    const config = await findTrafficBillingConfig(candidate.resourceType, candidate.resourceId);
    if (config) return { ...candidate, config };
  }
  return null;
}

async function getHistoricalRuleTrafficBytes(ruleId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({
      totalBytes: sql<number>`COALESCE(SUM(${trafficStats.bytesIn} + ${trafficStats.bytesOut}), 0)`,
    })
    .from(trafficStats)
    .where(eq(trafficStats.ruleId, ruleId));
  return Number(rows[0]?.totalBytes || 0);
}

export async function backfillTrafficBillingRuleUsageFromStats() {
  if (await getSetting(TRAFFIC_BILLING_RULE_USAGE_BACKFILL_MARKER)) return { skipped: true, inserted: 0 };
  const db = await getDb();
  if (!db) return { skipped: true, inserted: 0 };

  const usageRows = await db.select().from(trafficBillingUsage);
  let inserted = 0;
  for (const usage of usageRows as any[]) {
    const userId = Number(usage?.userId || 0);
    const resourceType = String(usage?.resourceType || "") as TrafficBillingResourceType;
    const resourceId = Number(usage?.resourceId || 0);
    if (userId <= 0 || resourceId <= 0 || !isTrafficBillingResourceType(resourceType)) continue;

    const existingRows = await db
      .select({ ruleId: trafficBillingRuleUsage.ruleId })
      .from(trafficBillingRuleUsage)
      .where(and(
        eq(trafficBillingRuleUsage.resourceType, resourceType),
        eq(trafficBillingRuleUsage.resourceId, resourceId),
      ));
    const existingRuleIds = new Set((existingRows as any[]).map((row) => Number(row.ruleId || 0)));
    const ruleConditions: any[] = [eq(forwardRules.userId, userId)];
    if (resourceType === "host") {
      ruleConditions.push(eq(forwardRules.hostId, resourceId));
      ruleConditions.push(sql`(${forwardRules.tunnelId} IS NULL OR ${forwardRules.tunnelId} = 0)`);
    } else if (resourceType === "tunnel") {
      ruleConditions.push(eq(forwardRules.tunnelId, resourceId));
    } else {
      ruleConditions.push(eq(forwardRules.forwardGroupId, resourceId));
    }
    const ruleRows = await db
      .select({ id: forwardRules.id })
      .from(forwardRules)
      .where(and(...ruleConditions));

    for (const rule of ruleRows as any[]) {
      const ruleId = Number(rule?.id || 0);
      if (ruleId <= 0 || existingRuleIds.has(ruleId)) continue;
      const totalBytes = Math.max(0, await getHistoricalRuleTrafficBytes(ruleId));
      if (totalBytes <= 0) continue;
      await db.insert(trafficBillingRuleUsage).values({
        userId,
        ruleId,
        resourceType,
        resourceId,
        totalBytes,
        billedGb: Math.ceil(totalBytes / GB_BYTES),
        pendingMilliCents: 0,
        settled: false,
        updatedAt: nowDate(),
      } as any);
      existingRuleIds.add(ruleId);
      inserted += 1;
    }
  }
  await setSetting(TRAFFIC_BILLING_RULE_USAGE_BACKFILL_MARKER, String(Math.floor(Date.now() / 1000)));
  return { skipped: false, inserted };
}
async function loadTrafficBillingEnabled(options: { acceptCachedDisabled?: boolean } = {}) {
  const now = Date.now();
  if (
    trafficBillingEnabledCache
    && trafficBillingEnabledCache.expiresAt > now
    && (trafficBillingEnabledCache.value || options.acceptCachedDisabled !== false)
  ) {
    return trafficBillingEnabledCache.value;
  }
  const value = (await getSetting("trafficBillingEnabled")) === "true";
  trafficBillingEnabledCache = { value, expiresAt: now + TRAFFIC_BILLING_ENABLED_CACHE_MS };
  return value;
}

export async function isTrafficBillingEnabled() {
  try {
    return await loadTrafficBillingEnabled();
  } catch (error) {
    warnTrafficBillingAccessFailure(error);
    return false;
  }
}

/**
 * Accounting writes must distinguish an explicitly disabled feature from an
 * unavailable settings query. A cached disabled value is revalidated so a
 * failed lookup rolls back the surrounding traffic transaction for retry.
 */
export async function getTrafficBillingEnabledForWrite() {
  return loadTrafficBillingEnabled({ acceptCachedDisabled: false });
}

export async function setTrafficBillingEnabled(enabled: boolean) {
  await setSetting("trafficBillingEnabled", enabled ? "true" : "false");
  trafficBillingEnabledCache = { value: enabled, expiresAt: Date.now() + TRAFFIC_BILLING_ENABLED_CACHE_MS };
}

async function loadTrafficBillingConfigSnapshot() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      resourceType: trafficBillingConfigs.resourceType,
      resourceId: trafficBillingConfigs.resourceId,
      requiresPermission: trafficBillingConfigs.requiresPermission,
    })
    .from(trafficBillingConfigs)
    .where(eq(trafficBillingConfigs.enabled, true));
  return {
    activeResourceIds: trafficBillingResourceIdsFromRows(rows as any[]),
    usableResourceIds: trafficBillingResourceIdsFromRows((rows as any[]).filter((row) => !row.requiresPermission)),
  };
}

/**
 * Resolve active and usable billing resources from one joined query so an
 * authorization decision cannot combine two different configuration states.
 * If the permission join fails, a config-only fallback still identifies the
 * resources that must be denied without blocking unrelated owned resources.
 */
export async function getTrafficBillingAccessSnapshot(userId: number): Promise<TrafficBillingAccessSnapshot> {
  const empty = emptyTrafficBillingResourceIds;
  try {
    // Re-read a cached disabled state so another panel instance cannot enable
    // private billing resources while this authorization path still bypasses them.
    if (!(await loadTrafficBillingEnabled({ acceptCachedDisabled: false }))) {
      return {
        status: "disabled",
        enabled: false,
        activeResourceIds: empty(),
        usableResourceIds: empty(),
      };
    }
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const rows = await db
      .select({
        resourceType: trafficBillingConfigs.resourceType,
        resourceId: trafficBillingConfigs.resourceId,
        requiresPermission: trafficBillingConfigs.requiresPermission,
        permissionId: userTrafficBillingPermissions.id,
      })
      .from(trafficBillingConfigs)
      .leftJoin(userTrafficBillingPermissions, and(
        eq(userTrafficBillingPermissions.userId, userId),
        eq(userTrafficBillingPermissions.resourceType, trafficBillingConfigs.resourceType),
        eq(userTrafficBillingPermissions.resourceId, trafficBillingConfigs.resourceId),
      ))
      .where(eq(trafficBillingConfigs.enabled, true));
    const activeResourceIds = trafficBillingResourceIdsFromRows(rows as any[]);
    const usableRows = (rows as any[]).filter((row) => (
      !row.requiresPermission || Number(row.permissionId || 0) > 0
    ));
    return {
      status: "ready",
      enabled: true,
      activeResourceIds,
      usableResourceIds: trafficBillingResourceIdsFromRows(usableRows),
    };
  } catch (error) {
    warnTrafficBillingAccessFailure(error);
    try {
      const fallback = await loadTrafficBillingConfigSnapshot();
      return {
        status: "degraded",
        enabled: true,
        activeResourceIds: fallback.activeResourceIds,
        usableResourceIds: fallback.usableResourceIds,
      };
    } catch (fallbackError) {
      warnTrafficBillingAccessFailure(fallbackError);
      return {
        status: "failed",
        enabled: true,
        activeResourceIds: empty(),
        usableResourceIds: empty(),
      };
    }
  }
}

export function trafficBillingSnapshotResourceState(
  snapshot: TrafficBillingAccessSnapshot,
  resourceType: TrafficBillingResourceType,
  resourceId: number,
) {
  const key = resourceType === "host" ? "hostIds" : resourceType === "tunnel" ? "tunnelIds" : "forwardGroupIds";
  const id = Number(resourceId);
  return {
    active: snapshot.activeResourceIds[key].includes(id),
    usable: snapshot.usableResourceIds[key].includes(id),
  };
}

/** 库存总量 / 每账号规则上限：非负整数，超出上界按上界算；没传（undefined）表示这次不改。 */
function normalizeStockInput(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(MAX_PRODUCT_STOCK, number);
}

/**
 * @param viewerUserId 传了就顺带算出「这个人自己在各资源上建了几条规则」（商店里要用：
 *   他已经占着席位的话，售罄对他不构成限制）。
 */
export async function listTrafficBillingConfigs(viewerUserId?: number) {
  const db = await getDb();
  if (!db) return [];
  const configs = await db.select().from(trafficBillingConfigs).orderBy(desc(trafficBillingConfigs.updatedAt));
  const hostIds = Array.from(new Set((configs as any[])
    .filter((config: any) => config.resourceType === "host")
    .map((config: any) => Number(config.resourceId))
    .filter((id: number) => id > 0)));
  const tunnelIds = Array.from(new Set((configs as any[])
    .filter((config: any) => config.resourceType === "tunnel")
    .map((config: any) => Number(config.resourceId))
    .filter((id: number) => id > 0)));
  const forwardGroupIds = Array.from(new Set((configs as any[])
    .filter((config: any) => config.resourceType === "forward_group")
    .map((config: any) => Number(config.resourceId))
    .filter((id: number) => id > 0)));
  const [hostRows, tunnelRows, forwardGroupRows] = await Promise.all([
    hostIds.length > 0
      ? db.select({ id: hosts.id, name: hosts.name }).from(hosts).where(inArray(hosts.id, hostIds))
      : Promise.resolve([]),
    tunnelIds.length > 0
      ? db.select({
        id: tunnels.id,
        name: tunnels.name,
        trafficMultiplier: tunnels.trafficMultiplier,
        mode: tunnels.mode,
      }).from(tunnels).where(inArray(tunnels.id, tunnelIds))
      : Promise.resolve([]),
    forwardGroupIds.length > 0
      ? db.select({
        id: forwardGroups.id,
        name: forwardGroups.name,
        groupType: forwardGroups.groupType,
        groupMode: forwardGroups.groupMode,
        trafficMultiplier: forwardGroups.trafficMultiplier,
      }).from(forwardGroups).where(inArray(forwardGroups.id, forwardGroupIds))
      : Promise.resolve([]),
  ]);
  const hostNames = new Map(hostRows.map((host: any) => [Number(host.id), host.name]));
  const tunnelById = new Map<number, any>(tunnelRows.map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const forwardGroupById = new Map<number, any>(forwardGroupRows.map((group: any) => [Number(group.id), group]));
  // 账号库存的占用数不落库，每次按现有规则现算（见 productStockRepository 开头的说明）。
  const stockUsage = configs.length > 0 ? await getTrafficStockUsage(viewerUserId) : null;
  return configs.map((config: any) => ({
    ...config,
    stockUsed: stockUsage?.usedByConfigId.get(Number(config.id)) || 0,
    currentUserRuleCount: stockUsage?.viewerRulesByConfigId.get(Number(config.id)) || 0,
    pricePerGbMilliCents: configPriceMilliCents(config),
    ...(() => {
      const resourceId = Number(config.resourceId);
      if (config.resourceType === "host") {
        return {
          resourceName: hostNames.get(resourceId) || `主机 #${config.resourceId}`,
          resourceKind: "整台主机",
          resourceMissing: !hostNames.has(resourceId),
          configuredMultiplier: normalizeMultiplier(Number(config.multiplier || 100)),
          multiplier: normalizeMultiplier(Number(config.multiplier || 100)),
          multiplierText: formatTrafficMultiplier(config.multiplier),
        };
      }
      if (config.resourceType === "forward_group") {
        const group = forwardGroupById.get(resourceId);
        const multiplier = normalizeMultiplier(Number(group?.trafficMultiplier || config.multiplier || 100));
        return {
          resourceName: group?.name || `转发资源 #${config.resourceId}`,
          resourceKind: group ? forwardGroupBillingKind(group) : "转发资源",
          resourceMissing: !group,
          configuredMultiplier: normalizeMultiplier(Number(config.multiplier || 100)),
          multiplier,
          multiplierText: formatTrafficMultiplier(multiplier),
        };
      }
      const tunnel = tunnelById.get(resourceId);
      const multiplier = normalizeMultiplier(Number(tunnel?.trafficMultiplier || config.multiplier || 100));
      return {
        resourceName: tunnel?.name || `隧道 #${config.resourceId}`,
        resourceKind: "隧道转发",
        resourceMissing: !tunnel,
        configuredMultiplier: normalizeMultiplier(Number(config.multiplier || 100)),
        multiplier,
        multiplierText: formatTrafficMultiplier(multiplier),
      };
    })(),
  }));
}

export async function getUserTrafficBillingPermissions(userId: number) {
  const db = await getDb();
  if (!db) return { hostIds: [], tunnelIds: [], forwardGroupIds: [] };
  const rows = await db.select().from(userTrafficBillingPermissions).where(eq(userTrafficBillingPermissions.userId, userId));
  return {
    hostIds: rows.filter((row: any) => row.resourceType === "host").map((row: any) => Number(row.resourceId)),
    tunnelIds: rows.filter((row: any) => row.resourceType === "tunnel").map((row: any) => Number(row.resourceId)),
    forwardGroupIds: rows.filter((row: any) => row.resourceType === "forward_group").map((row: any) => Number(row.resourceId)),
  };
}

export async function getUserUsableTrafficBillingResourceIds(userId: number) {
  return (await getTrafficBillingAccessSnapshot(userId)).usableResourceIds;
}

export async function setUserTrafficBillingPermissions(userId: number, hostIds: number[], tunnelIds: number[], forwardGroupIds: number[] = []) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userTrafficBillingPermissions).where(eq(userTrafficBillingPermissions.userId, userId));
  const rows = [
    ...Array.from(new Set(hostIds.map(Number).filter((id) => id > 0))).map((resourceId) => ({ userId, resourceType: "host", resourceId })),
    ...Array.from(new Set(tunnelIds.map(Number).filter((id) => id > 0))).map((resourceId) => ({ userId, resourceType: "tunnel", resourceId })),
    ...Array.from(new Set(forwardGroupIds.map(Number).filter((id) => id > 0))).map((resourceId) => ({ userId, resourceType: "forward_group", resourceId })),
  ];
  if (rows.length > 0) await db.insert(userTrafficBillingPermissions).values(rows as any);
}

/**
 * 「给这台机器配整台兜底价，会把谁接管过去、会停掉谁」。
 *
 * 兜底价是转发找计费配置的最后一档，所以它会接管这台机器上**所有**没被转发组 / 隧道
 * 单独计价的转发 —— 包括走套餐的租户的。而计费那条路的判断里从头到尾没有「这个人是
 * 套餐户还是计费户」（面板里没这个字段），套餐户通常余额又是 0，于是：
 *
 *   余额 ≤ 0 → setUserForwardAccess(false) → **停掉他名下全部转发**，不只是这台上的。
 *
 * 保存之前把这件事摆出来。不摆的话，你只有在租户来问「我的转发怎么全停了」的时候
 * 才会知道 —— 而那时候钱和业务都已经出事了。
 */
export async function previewHostTrafficBillingTakeover(hostId: number) {
  const empty = { totalRules: 0, takeoverRules: 0, users: [] as any[], stopUsers: 0, stopRules: 0 };
  const id = Number(hostId);
  if (!Number.isInteger(id) || id <= 0) return empty;
  const db = await getDb();
  if (!db) return empty;

  const rules = await getBillingRelevantRulesByHostIds([id]);
  if (rules.length === 0) return empty;

  /*
    只问**上面两档**：转发组 → 隧道。

    把 hostId 抹成 0 是因为 trafficBillingResourceCandidatesForRule 只在 hostId > 0 时
    才生成主机那一档候选 —— 抹掉它，解析出来的就正好是「不算兜底价的话，这条转发现在
    有没有价」。已经有价的不受兜底价影响（上面的档优先），剩下的才是会被接管的。
  */
  const higherTierByRuleId = await findTrafficBillingResourcesForRules(
    rules.map((rule: any) => ({ ...rule, hostId: 0 })),
  );
  const takeover = rules.filter((rule: any) => !higherTierByRuleId.get(Number(rule.id))?.config);
  if (takeover.length === 0) {
    return { ...empty, totalRules: rules.length };
  }

  const rulesByUserId = new Map<number, number>();
  for (const rule of takeover) {
    const userId = Number(rule.userId || 0);
    if (userId <= 0) continue;
    rulesByUserId.set(userId, (rulesByUserId.get(userId) || 0) + 1);
  }
  const userIds = Array.from(rulesByUserId.keys());
  if (userIds.length === 0) return { ...empty, totalRules: rules.length, takeoverRules: takeover.length };

  const [userRows, enabledRuleCounts] = await Promise.all([
    db.select({
      id: users.id,
      username: users.username,
      role: users.role,
      balanceCents: users.balanceCents,
      trafficLimit: users.trafficLimit,
    }).from(users).where(inArray(users.id, userIds)),
    countEnabledForwardRulesByUserIds(userIds),
  ]);

  const rows = (userRows as any[]).map((user) => {
    const userId = Number(user.id);
    // 余额 ≤ 0 就扣不动。管理员也一样 —— 计费那条路上没有按角色放行。
    const balanceCents = Number(user.balanceCents || 0);
    const wouldStop = balanceCents <= 0;
    return {
      userId,
      username: String(user.username || `#${userId}`),
      role: String(user.role || "user"),
      balanceCents,
      // 有套餐额度的人，正是「本来走套餐、会被兜底价接管走」的那一类。
      hasPlanQuota: Number(user.trafficLimit || 0) > 0,
      takeoverRules: rulesByUserId.get(userId) || 0,
      // 停的是他名下全部的转发，不只是这台机器上的这几条。
      enabledRules: enabledRuleCounts.get(userId) || 0,
      wouldStop,
    };
  }).sort((left, right) => Number(right.wouldStop) - Number(left.wouldStop) || right.takeoverRules - left.takeoverRules);

  return {
    totalRules: rules.length,
    takeoverRules: takeover.length,
    users: rows,
    stopUsers: rows.filter((row) => row.wouldStop).length,
    stopRules: rows.filter((row) => row.wouldStop).reduce((total, row) => total + row.enabledRules, 0),
  };
}

export async function upsertTrafficBillingConfig(data: InsertTrafficBillingConfig) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const resourceType = String((data as any).resourceType || "") as TrafficBillingResourceType;
  const resourceId = Number((data as any).resourceId || 0);
  const id = Number((data as any).id || 0);
  if (!isTrafficBillingResourceType(resourceType)) throw new Error("资源类型无效");
  if (resourceId <= 0) throw new Error("资源无效");
  await assertBillingResourceExists(resourceType, resourceId);
  const existingById = id > 0
    ? (await db.select().from(trafficBillingConfigs).where(eq(trafficBillingConfigs.id, id)).limit(1))[0]
    : null;
  const pricePerGbMilliCents = normalizePriceMilliCents(
    Number((data as any).pricePerGbMilliCents || 0) || normalizePrice(Number((data as any).pricePerGbCents || 0)) * MILLI_CENTS_PER_CENT,
  );
  const multiplier = await getBillingResourceMultiplier(
    resourceType,
    resourceId,
    Number((data as any).multiplier || (existingById as any)?.multiplier || 100),
  );
  const payload = {
    resourceType,
    resourceId,
    enabled: !!(data as any).enabled,
    requiresPermission: !!(data as any).requiresPermission,
    description: String((data as any).description || "").trim() || null,
    pricePerGbCents: Math.floor(pricePerGbMilliCents / MILLI_CENTS_PER_CENT),
    pricePerGbMilliCents,
    multiplier,
    // 没传就不进 payload：只配单价的入口（主机管理里的计费弹窗）不会把已设的库存冲回不限。
    ...(normalizeStockInput(data.stockLimit) !== undefined ? { stockLimit: normalizeStockInput(data.stockLimit) } : {}),
    ...(normalizeStockInput(data.maxRulesPerUser) !== undefined ? { maxRulesPerUser: normalizeStockInput(data.maxRulesPerUser) } : {}),
    updatedAt: nowDate(),
  };
  if (id > 0) {
    if (!existingById) throw new Error("计费配置不存在");
    await db.update(trafficBillingConfigs).set(payload as any).where(eq(trafficBillingConfigs.id, id));
    return { ...existingById, ...payload };
  }
  const existing = await db.select().from(trafficBillingConfigs).where(and(
    eq(trafficBillingConfigs.resourceType, resourceType),
    eq(trafficBillingConfigs.resourceId, resourceId),
  )).limit(1);
  if (existing[0]) {
    await db.update(trafficBillingConfigs).set(payload as any).where(eq(trafficBillingConfigs.id, existing[0].id));
    return { ...existing[0], ...payload };
  }
  const createdId = await insertAndGetId("traffic_billing_configs", { ...payload, createdAt: nowDate() });
  return { id: createdId, ...payload };
}

export async function deleteTrafficBillingConfig(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(trafficBillingConfigs).where(eq(trafficBillingConfigs.id, id));
}

/**
 * 一批主机各自的「整台兜底价」配置。
 *
 * 主机这一档是转发找计费配置时的最后一级兜底（转发组 → 隧道 → 主机），所以它回答
 * 的是「这台机器上没被单独计价的转发，按多少钱算」。主机管理里那个按量计费弹窗要
 * 拿它回填，一页十二台一次查完。
 *
 * **停用的也要返回**：弹窗得能显示「配过、但现在停着」，并且让人重新开起来。
 * 换成只查启用中的，停用过的那台在界面上会和从没配过的长得一模一样，
 * 于是人会再配一条，撞上唯一约束。
 */
export async function findHostTrafficBillingConfigs(hostIds: readonly number[]) {
  const result = new Map<number, {
    id: number;
    enabled: boolean;
    requiresPermission: boolean;
    pricePerGbMilliCents: number;
    multiplier: number;
    description: string | null;
  }>();
  const wanted = Array.from(new Set(hostIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return result;
  const db = await getDb();
  if (!db) return result;
  const rows = await db.select().from(trafficBillingConfigs).where(and(
    eq(trafficBillingConfigs.resourceType, "host"),
    inArray(trafficBillingConfigs.resourceId, wanted),
  ));
  for (const row of rows as any[]) {
    result.set(Number(row.resourceId), {
      id: Number(row.id),
      enabled: !!row.enabled,
      requiresPermission: !!row.requiresPermission,
      pricePerGbMilliCents: configPriceMilliCents(row),
      multiplier: normalizeMultiplier(Number(row.multiplier || 100)),
      description: row.description ?? null,
    });
  }
  return result;
}

export async function findTrafficBillingConfig(resourceType: TrafficBillingResourceType, resourceId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(trafficBillingConfigs).where(and(
    eq(trafficBillingConfigs.resourceType, resourceType),
    eq(trafficBillingConfigs.resourceId, resourceId),
    eq(trafficBillingConfigs.enabled, true),
  )).limit(1);
  return rows[0];
}

async function insertTrafficBillingCharge(input: {
  userId: number;
  ruleId: number;
  resourceType: TrafficBillingResourceType;
  resourceId: number;
  bytes: number;
  billedGb: number;
  amountCents: number;
  pricePerGbMilliCents: number;
  multiplier: number;
  description: string;
}) {
  return withDatabaseTransaction(async () => {
  const amountCents = Math.max(0, Math.floor(Number(input.amountCents) || 0));
  if (amountCents <= 0) return null;
  const db = await getDb();
  if (!db) return null;
  const q = quoteDbIdentifier;
  const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
  const [user] = await queryRaw<any>(`SELECT ${q("balanceCents")} AS ${q("balanceCents")} FROM ${q("users")} WHERE ${q("id")} = ?${lock}`, [input.userId]);
  if (!user) return null;
  const balanceAfterCents = Number((user as any).balanceCents || 0) - amountCents;
  await executeRaw(`UPDATE ${q("users")} SET ${q("balanceCents")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`, [balanceAfterCents, nowDate(), input.userId]);
  await db.insert(balanceTransactions).values({
    userId: input.userId,
    type: "traffic_billing",
    amountCents: -amountCents,
    balanceAfterCents,
    description: input.description,
    createdAt: nowDate(),
  } as any);
  await db.insert(trafficBillingRecords).values({
    userId: input.userId,
    ruleId: input.ruleId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    bytes: Math.max(0, Math.floor(Number(input.bytes) || 0)),
    billedGb: Math.max(0, Math.floor(Number(input.billedGb) || 0)),
    pricePerGbCents: Math.floor(input.pricePerGbMilliCents / MILLI_CENTS_PER_CENT),
    pricePerGbMilliCents: input.pricePerGbMilliCents,
    multiplier: input.multiplier,
    amountCents,
    balanceAfterCents,
    createdAt: nowDate(),
  } as any);
  return { amountCents, billedGb: input.billedGb, balanceAfterCents };
  });
}

/**
 * precomputed：调用方在**同一个事务**里已经拿到的东西，用来跳过重复的查询和加锁。
 * 流量上报那条路在事务开头已经读过计费开关、按规则批量取过计费配置，并按顺序锁住了
 * 这些用户的行；逐条计费时再各查一遍、再锁一遍纯属重复。
 *
 * - config：该资源的已启用计费配置（与 findTrafficBillingConfig 读的是同一行）。
 * - billingEnabled：同一事务里 getTrafficBillingEnabledForWrite 的结果。
 * - alreadyLocked：调用方已在同一事务里对 input.userId 调过 lockTrafficBillingUserRows。
 *
 * 不传时行为与原来完全一样；其他调用方不用改。
 */
export async function billTrafficUsage(input: {
  userId: number;
  ruleId: number;
  bytes: number;
  resourceType: TrafficBillingResourceType;
  resourceId: number;
}, precomputed: {
  config?: any;
  billingEnabled?: boolean;
  alreadyLocked?: boolean;
} = {}) {
  return withDatabaseTransaction(async () => {
  if (input.bytes <= 0) return null;
  const billingEnabled = precomputed.billingEnabled ?? await getTrafficBillingEnabledForWrite();
  if (!billingEnabled) return null;
  const config = precomputed.config !== undefined
    ? precomputed.config
    : await findTrafficBillingConfig(input.resourceType, input.resourceId);
  const pricePerGbMilliCents = configPriceMilliCents(config);
  if (!config || pricePerGbMilliCents <= 0) return null;
  const db = await getDb();
  if (!db) return null;
  // Lock the owning user before reading usage counters. This keeps the
  // read/compute/write sequence atomic across multiple panel instances.
  if (!precomputed.alreadyLocked) await lockTrafficBillingUserRows(input.userId);
  const [usageRows, ruleUsageRows] = await Promise.all([
    db.select().from(trafficBillingUsage).where(and(
      eq(trafficBillingUsage.userId, input.userId),
      eq(trafficBillingUsage.resourceType, input.resourceType),
      eq(trafficBillingUsage.resourceId, input.resourceId),
    )).limit(1),
    db.select().from(trafficBillingRuleUsage).where(and(
      eq(trafficBillingRuleUsage.ruleId, input.ruleId),
      eq(trafficBillingRuleUsage.resourceType, input.resourceType),
      eq(trafficBillingRuleUsage.resourceId, input.resourceId),
    )).limit(1),
  ]);
  const usage = usageRows[0] as any;
  const previousBytes = Number(usage?.totalBytes || 0);
  const totalBytes = previousBytes + input.bytes;
  const previousBilledGb = Number(usage?.billedGb || 0);
  const multiplier = await getBillingResourceMultiplier(input.resourceType, input.resourceId, Number(config.multiplier || 100));
  const ruleUsage = ruleUsageRows[0] as any;
  const hasAnyRuleUsage = ruleUsage
    ? true
    : (await db.select({ id: trafficBillingRuleUsage.id }).from(trafficBillingRuleUsage).where(eq(trafficBillingRuleUsage.ruleId, input.ruleId)).limit(1)).length > 0;
  const historicalRuleBytes = ruleUsage || hasAnyRuleUsage || !usage
    ? 0
    : Math.max(0, (await getHistoricalRuleTrafficBytes(input.ruleId)) - input.bytes);
  const previousRuleBytes = Number(ruleUsage?.totalBytes || historicalRuleBytes);
  const previousRuleBilledGb = Number(ruleUsage?.billedGb || (historicalRuleBytes > 0 ? Math.ceil(historicalRuleBytes / GB_BYTES) : 0));
  const nextRuleBytes = previousRuleBytes + input.bytes;
  const nextRuleBilledGb = billedFullGb(nextRuleBytes);
  const newlyBilledGb = Math.max(0, nextRuleBilledGb - previousRuleBilledGb);
  const storedRuleBilledGb = Math.max(previousRuleBilledGb, nextRuleBilledGb);
  if (usage) {
    await db.update(trafficBillingUsage).set({
      totalBytes,
      billedGb: previousBilledGb + newlyBilledGb,
      pendingMilliCents: 0,
      updatedAt: nowDate(),
    } as any).where(eq(trafficBillingUsage.id, usage.id));
  } else {
    await db.insert(trafficBillingUsage).values({
      userId: input.userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      totalBytes,
      billedGb: newlyBilledGb,
      pendingMilliCents: 0,
      updatedAt: nowDate(),
    } as any);
  }
  if (ruleUsage) {
    await db.update(trafficBillingRuleUsage).set({
      userId: input.userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      totalBytes: nextRuleBytes,
      billedGb: storedRuleBilledGb,
      pendingMilliCents: 0,
      settled: false,
      updatedAt: nowDate(),
    } as any).where(eq(trafficBillingRuleUsage.id, ruleUsage.id));
  } else {
    await db.insert(trafficBillingRuleUsage).values({
      userId: input.userId,
      ruleId: input.ruleId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      totalBytes: nextRuleBytes,
      billedGb: storedRuleBilledGb,
      pendingMilliCents: 0,
      settled: false,
      updatedAt: nowDate(),
    } as any);
  }
  if (newlyBilledGb <= 0) return null;
  const amountCents = effectiveAmountCentsForGb(newlyBilledGb, pricePerGbMilliCents, multiplier);
  return insertTrafficBillingCharge({
    userId: input.userId,
    ruleId: input.ruleId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    bytes: input.bytes,
    billedGb: newlyBilledGb,
    pricePerGbMilliCents,
    multiplier,
    amountCents,
    description: `流量计费：${trafficBillingResourceLabel(input.resourceType)} #${input.resourceId} 新增 ${newlyBilledGb}GB x ${(multiplier / 100).toFixed(2)}`,
  });
  });
}

export async function settleTrafficBillingRuleOnDelete(input: {
  userId: number;
  ruleId: number;
  resourceType: TrafficBillingResourceType;
  resourceId: number;
}) {
  return withDatabaseTransaction(async () => {
  if (!(await getTrafficBillingEnabledForWrite())) return null;
  const db = await getDb();
  if (!db) return null;
  // Rule settlement also reads and updates the same usage rows. Serialize it
  // with live reports so a delete cannot lose a concurrently reported delta.
  await lockTrafficBillingUserRows(input.userId);
  let rows = await db.select().from(trafficBillingRuleUsage).where(eq(trafficBillingRuleUsage.ruleId, input.ruleId));
  if (rows.length === 0) {
    const usageRows = await db.select({ id: trafficBillingUsage.id }).from(trafficBillingUsage).where(and(
      eq(trafficBillingUsage.userId, input.userId),
      eq(trafficBillingUsage.resourceType, input.resourceType),
      eq(trafficBillingUsage.resourceId, input.resourceId),
    )).limit(1);
    const historicalRuleBytes = usageRows.length > 0 ? await getHistoricalRuleTrafficBytes(input.ruleId) : 0;
    if (historicalRuleBytes > 0) {
      await db.insert(trafficBillingRuleUsage).values({
        userId: input.userId,
        ruleId: input.ruleId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        totalBytes: historicalRuleBytes,
        billedGb: Math.ceil(historicalRuleBytes / GB_BYTES),
        pendingMilliCents: 0,
        settled: false,
        updatedAt: nowDate(),
      } as any);
      rows = await db.select().from(trafficBillingRuleUsage).where(eq(trafficBillingRuleUsage.ruleId, input.ruleId));
    }
  }
  let totalAmountCents = 0;
  let balanceAfterCents: number | null = null;
  for (const usage of rows as any[]) {
    if (!usage || usage.settled) continue;
    const resourceType = String(usage.resourceType || input.resourceType) as TrafficBillingResourceType;
    const resourceId = Number(usage.resourceId || input.resourceId);
    const config = isTrafficBillingResourceType(resourceType)
      ? await findTrafficBillingConfig(resourceType, resourceId)
      : null;
    const pricePerGbMilliCents = configPriceMilliCents(config);
    const totalBytes = Math.max(0, Number(usage.totalBytes || 0));
    const billedBytes = Math.max(0, Number(usage.billedGb || 0)) * GB_BYTES;
    const remainingBytes = Math.max(0, totalBytes - billedBytes);
    const multiplier = await getBillingResourceMultiplier(resourceType, resourceId, Number(config?.multiplier || 100));
    const amountCents = config && pricePerGbMilliCents > 0
      ? effectiveAmountCentsForBytes(remainingBytes, pricePerGbMilliCents, multiplier)
      : 0;
    await db.update(trafficBillingRuleUsage).set({
      pendingMilliCents: 0,
      settled: true,
      updatedAt: nowDate(),
    } as any).where(eq(trafficBillingRuleUsage.id, usage.id));
    if (remainingBytes <= 0 || amountCents <= 0) continue;
    const charged = await insertTrafficBillingCharge({
      userId: input.userId,
      ruleId: input.ruleId,
      resourceType,
      resourceId,
      bytes: remainingBytes,
      billedGb: 0,
      pricePerGbMilliCents,
      multiplier,
      amountCents,
      description: `流量计费：${trafficBillingResourceLabel(resourceType)} #${resourceId} 删除规则结算 ${remainingBytes} bytes x ${(multiplier / 100).toFixed(2)}`,
    });
    if (charged) {
      totalAmountCents += charged.amountCents;
      balanceAfterCents = charged.balanceAfterCents;
    }
  }
  if (totalAmountCents <= 0 || balanceAfterCents === null) return null;
  return { amountCents: totalAmountCents, billedGb: 0, balanceAfterCents };
  });
}

export async function listTrafficBillingRecords(options?: { userId?: number; limit?: number }) {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.max(1, Math.min(500, Number(options?.limit || 100)));
  const base = db
    .select({
      id: trafficBillingRecords.id,
      userId: trafficBillingRecords.userId,
      username: users.username,
      name: users.name,
      ruleId: trafficBillingRecords.ruleId,
      ruleName: forwardRules.name,
      resourceType: trafficBillingRecords.resourceType,
      resourceId: trafficBillingRecords.resourceId,
      bytes: trafficBillingRecords.bytes,
      billedGb: trafficBillingRecords.billedGb,
      pricePerGbCents: trafficBillingRecords.pricePerGbCents,
      pricePerGbMilliCents: trafficBillingRecords.pricePerGbMilliCents,
      multiplier: trafficBillingRecords.multiplier,
      amountCents: trafficBillingRecords.amountCents,
      balanceAfterCents: trafficBillingRecords.balanceAfterCents,
      createdAt: trafficBillingRecords.createdAt,
    })
    .from(trafficBillingRecords)
    .leftJoin(users, eq(trafficBillingRecords.userId, users.id))
    .leftJoin(forwardRules, eq(trafficBillingRecords.ruleId, forwardRules.id));
  if (options?.userId) {
    return base.where(eq(trafficBillingRecords.userId, options.userId)).orderBy(desc(trafficBillingRecords.createdAt)).limit(limit);
  }
  return base.orderBy(desc(trafficBillingRecords.createdAt)).limit(limit);
}

/**
 * 「按量计费这一套，我到底配好了没有」。
 *
 * 这件事原来散在四个地方：总开关在一个**侧边栏点不到**的页面里，资源定价在套餐管理
 * 的一个 tab 下（那里还看不到总开关），授权在用户管理的用户编辑弹窗里，余额在账单
 * 与兑换。四处都对了才真的能收到钱，错一处就是静悄悄不生效 —— 而没有任何一个地方
 * 告诉你缺哪一环。
 *
 * 所以把四环的现状一次算出来，摆在计费中心页上。每一环都返回**能拿来做判断的数**，
 * 不是一个笼统的 ok/not ok：「3 个资源在计费」和「都要授权但一个人都没授权」是完全
 * 不同的处境，缩成一个布尔值就等于没说。
 */
/**
 * 租户自己那一屏要的：「我有几条转发在按量扣钱、按什么价」。
 *
 * 「我的套餐」原来只讲套餐额度。一个纯按量计费的租户在那一页上是一片空白，还被劝
 * 「去商店下单」—— 而他的「还剩多少」根本不是额度，是余额，在另一页。他真正要知道
 * 的三件事（在按什么价用、花了多少、余额还够不够）一个都看不到。
 *
 * 单价**要给他看**。主机卡片上对非管理员藏价钱是因为那是商家给别人机器的定价；
 * 这里是他自己在付的钱，藏起来才是不对的。
 */
export async function getUserMeteredForwardSummary(userId: number) {
  const empty = { meteredRules: 0, totalRules: 0, minPricePerGbMilliCents: 0, maxPricePerGbMilliCents: 0 };
  if (!(await isTrafficBillingEnabled())) return empty;
  const rules = await getBillingRelevantRulesByUserId(userId);
  if (rules.length === 0) return empty;
  const byRuleId = await findTrafficBillingResourcesForRules(rules);
  const prices: number[] = [];
  for (const rule of rules) {
    const config = byRuleId.get(Number(rule.id))?.config;
    if (!config) continue;
    prices.push(configPriceMilliCents(config));
  }
  if (prices.length === 0) return { ...empty, totalRules: rules.length };
  return {
    meteredRules: prices.length,
    totalRules: rules.length,
    minPricePerGbMilliCents: Math.min(...prices),
    maxPricePerGbMilliCents: Math.max(...prices),
  };
}

export async function getTrafficBillingSetupStatus() {
  const enabled = await isTrafficBillingEnabled();
  const db = await getDb();
  if (!db) {
    return {
      enabled,
      configs: { total: 0, active: 0, open: 0, permissionOnly: 0 },
      authorizedUsers: 0,
      fundedUsers: 0,
      tenantUsers: 0,
    };
  }

  const [configRows, permissionRows, userRows] = await Promise.all([
    db.select({
      enabled: trafficBillingConfigs.enabled,
      requiresPermission: trafficBillingConfigs.requiresPermission,
      resourceType: trafficBillingConfigs.resourceType,
      resourceId: trafficBillingConfigs.resourceId,
    }).from(trafficBillingConfigs),
    db.select({
      userId: userTrafficBillingPermissions.userId,
      resourceType: userTrafficBillingPermissions.resourceType,
      resourceId: userTrafficBillingPermissions.resourceId,
    }).from(userTrafficBillingPermissions),
    db.select({ id: users.id, role: users.role, balanceCents: users.balanceCents }).from(users),
  ]);

  const active = (configRows as any[]).filter((row) => !!row.enabled);
  const activeKeys = new Set(active.map((row) => `${String(row.resourceType)}:${Number(row.resourceId)}`));
  // 只数**启用中**资源上的授权。停用资源上的旧授权不代表谁现在用得上，
  // 拿它去说「已经授权了 3 个人」是在报一个假的就绪状态。
  const authorizedUsers = new Set((permissionRows as any[])
    .filter((row) => activeKeys.has(`${String(row.resourceType)}:${Number(row.resourceId)}`))
    .map((row) => Number(row.userId)));

  const tenants = (userRows as any[]).filter((row) => String(row.role || "user") !== "admin");
  return {
    enabled,
    configs: {
      total: configRows.length,
      active: active.length,
      // 不需要单独授权的：任何有余额的租户都能直接用，也会出现在商店里。
      open: active.filter((row) => !row.requiresPermission).length,
      permissionOnly: active.filter((row) => !!row.requiresPermission).length,
    },
    authorizedUsers: authorizedUsers.size,
    // 余额 ≤ 0 的租户扣不动钱，转发会被停 —— 「有几个人真付得起」是这一环的实话。
    fundedUsers: tenants.filter((row) => Number(row.balanceCents || 0) > 0).length,
    tenantUsers: tenants.length,
  };
}

export async function getTrafficBillingSummary(userId?: number) {
  const db = await getDb();
  if (!db) return { enabled: await isTrafficBillingEnabled(), totalAmountCents: 0, totalBilledGb: 0, totalBytes: 0, records: [] };
  const records = await listTrafficBillingRecords({ userId, limit: 20 });
  const totalsQuery = db
    .select({
      totalAmountCents: sql<number>`COALESCE(SUM(${trafficBillingRecords.amountCents}), 0)`,
    })
    .from(trafficBillingRecords);
  const usageQuery = db
    .select({
      totalBytes: sql<number>`COALESCE(SUM(${trafficBillingUsage.totalBytes}), 0)`,
      totalBilledGb: sql<number>`COALESCE(SUM(${trafficBillingUsage.billedGb}), 0)`,
    })
    .from(trafficBillingUsage);
  const [rows, usageRows] = await Promise.all([
    userId ? totalsQuery.where(eq(trafficBillingRecords.userId, userId)) : totalsQuery,
    userId ? usageQuery.where(eq(trafficBillingUsage.userId, userId)) : usageQuery,
  ]);
  return {
    enabled: await isTrafficBillingEnabled(),
    totalAmountCents: Number(rows[0]?.totalAmountCents || 0),
    totalBilledGb: Number(usageRows[0]?.totalBilledGb || 0),
    totalBytes: Number(usageRows[0]?.totalBytes || 0),
    records,
  };
}
