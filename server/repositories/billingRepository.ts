import crypto from "crypto";
import { balanceTypeLabel, subscriptionSourceLabel } from "../../shared/ledgerLabels";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  balanceTransactions, InsertBalanceTransaction,
  discountCodePlans,
  discountCodes, InsertDiscountCode,
  forwardGroups,
  forwardRules,
  paymentOrders, InsertPaymentOrder,
  redemptionCodes, InsertRedemptionCode,
  subscriptionPlans, InsertSubscriptionPlan,
  subscriptionPlanForwardGroups,
  subscriptionPlanHosts,
  subscriptionPlanTrafficAddons,
  subscriptionPlanPrices,
  subscriptionPlanProxyNodes,
  subscriptionPlanTunnels,
  userTrafficAddons,
  userSubscriptions, InsertUserSubscription,
  users,
} from "../../drizzle/schema";
import {
  defaultPricingOption,
  findPricingOption,
  normalizePlanPriceTiers,
  planPricingOptions,
  renewalPricingOption,
  type PlanPriceTier,
} from "../../shared/planPricing";
import { executeRaw, getDatabaseKind, getDb, insertAndGetId, isDatabaseTransactionActive, nowDate, queryRaw, quoteDbIdentifier, rawAffectedRows, withDatabaseTransaction } from "../dbRuntime";
import { getForwardRulesForUserSync, resetForwardRulesForUserSync } from "./forwardRuleRepository";
import { getForwardGroupEntryPortRange } from "./forwardGroupRepository";
import { getHostById } from "./hostRepository";
import { getTunnelById, updateTunnel } from "./tunnelRepository";
import { pruneMapEntries, setBoundedMapValue } from "../boundedCache";
import {
  disableAllUserRules,
  getAllUsers,
  getUserById,
  resetUserTraffic,
  resetUserTrafficForCycle,
  setUserForwardAccess,
  updateUserTrafficSettings,
  type ForwardAccessPauseReason,
} from "./userRepository";
import { dbBool, sqlBool } from "./repositoryUtils";
import { pushAgentRefresh } from "../agentEvents";
import { getUserUsableTrafficBillingResourceIds } from "./trafficBillingRepository";
import { getSetting, setSetting } from "./settingsRepository";
import { getReferralSettings } from "./referralRepository";
import {
  evaluateReferralCommission,
  formatRateBps,
  maskUsername,
  type ReferralSkipReason,
  type ReferralSourceType,
} from "../../shared/referral";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import { withKeyedTaskLock, withTrafficBillingUserLock } from "../keyedTaskLock";
import {
  getUserForwardRuleIdsDisabledByAccess,
  scheduleUserForwardRulesAfterAccessRecovery,
  restoreUserForwardRulesAfterAccessRecovery,
} from "./userForwardAccessRecovery";
import {
  billingAddMonthsClamped,
  billingCalendarParts,
  billingMonthlyBoundary,
  MONTHLY_RESET_MAX_DAY,
  billingStartOfCalendarDay,
} from "../../shared/billingTime";

let lastActiveSubscriptionWarningAt = 0;
const SUBSCRIPTION_PORT_ALLOCATION_LOCK_KEY = "subscription-port-allocation";
const SUBSCRIPTION_PORT_ALLOCATION_MARKER = "subscription-port-allocation-lock";
const SUBSCRIPTION_PLAN_PAYMENT_MARKER = "subscription-plan-payment-lock";

function warnActiveSubscriptionLookupFailure(error: unknown) {
  const now = Date.now();
  if (now - lastActiveSubscriptionWarningAt < 60_000) return;
  lastActiveSubscriptionWarningAt = now;
  console.warn("[Billing] optional subscription lookup failed; self-owned resources remain available:", error instanceof Error ? error.message : String(error));
}

async function lockTrafficBillingUserRow(userId: number) {
  const q = quoteDbIdentifier;
  const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
  const rows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")} AS ${q("id")} FROM ${q("users")} WHERE ${q("id")} = ?${lock}`,
    [userId],
  );
  if (!rows[0]) throw new Error("用户不存在");
}

async function withTrafficBillingUserTransaction<T>(userId: number, task: () => Promise<T>) {
  return withTrafficBillingUserLock(userId, () => withDatabaseTransaction(async () => {
    await lockTrafficBillingUserRow(userId);
    return task();
  }));
}

async function withSubscriptionPortAllocationLock<T>(task: () => Promise<T>) {
  return withKeyedTaskLock(SUBSCRIPTION_PORT_ALLOCATION_LOCK_KEY, async () => {
    // Updating one stable row gives MySQL/PostgreSQL instances the same lock;
    // SQLite is already serialized by BEGIN IMMEDIATE.
    await setSetting(SUBSCRIPTION_PORT_ALLOCATION_MARKER, "1");
    return task();
  });
}

// ==================== Payment Orders ====================

export async function createPaymentOrder(order: InsertPaymentOrder) {
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) return undefined;
    if (order.planId) {
      // Serialize against plan deletion across panel instances. The setting
      // update holds one stable database row until this transaction commits.
      await setSetting(SUBSCRIPTION_PLAN_PAYMENT_MARKER, "1");
      const plan = await db
        .select({ id: subscriptionPlans.id })
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, Number(order.planId)))
        .limit(1);
      if (!plan[0]) throw new Error("套餐已删除，无法创建支付订单");
    }
    await db.insert(paymentOrders).values(order);
    return getPaymentOrderByOutTradeNo(order.outTradeNo);
  });
}

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

const BILLING_CODE_BODY_LENGTH = 24;

export function generateBillingCode(prefix = "") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bodyLength = BILLING_CODE_BODY_LENGTH;
  const raw = crypto.randomBytes(bodyLength);
  let body = "";
  for (let i = 0; i < bodyLength; i++) {
    body += chars[raw[i] % chars.length];
  }
  return `${prefix}${body}`.slice(0, 64).toUpperCase();
}

type RedemptionAttemptEntry = {
  count: number;
  lastFailAt: number;
};

const redemptionAttemptStore = new Map<string, RedemptionAttemptEntry>();
const redemptionCodeLocks = new Map<string, Promise<void>>();
const redemptionScopeLocks = new Map<string, Promise<void>>();
const REDEMPTION_ATTEMPT_WINDOW_MS = 30 * 60 * 1000;
const REDEMPTION_ATTEMPT_BLOCK_MS = 15 * 60 * 1000;
const REDEMPTION_ATTEMPT_THRESHOLD = 8;
const REDEMPTION_ATTEMPT_SOURCE_THRESHOLD = 20;
const REDEMPTION_ATTEMPT_MAX_KEYS = 50_000;

/*
  试码计数分「种类」：兑换码一类，折扣码一类。

  用同一套窗口和封禁逻辑，但**各记各的账** —— 一个人正常试错两次兑换码，不该把
  他结账时预览折扣码的额度也吃掉。
*/
type AttemptKind = "redeem" | "discount";

function redemptionAttemptUserKey(userId: number, kind: AttemptKind = "redeem") {
  return kind === "redeem" ? `user:${userId}` : `${kind}:user:${userId}`;
}

function redemptionAttemptSourceKey(scope?: string | null, kind: AttemptKind = "redeem") {
  const normalized = String(scope || "").trim().slice(0, 128);
  if (!normalized) return null;
  return kind === "redeem" ? `source:${normalized}` : `${kind}:source:${normalized}`;
}

function getActiveRedemptionAttemptEntry(key: string) {
  const entry = redemptionAttemptStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.lastFailAt < REDEMPTION_ATTEMPT_WINDOW_MS) return entry;
  redemptionAttemptStore.delete(key);
  return null;
}

function recordRedemptionAttemptFailureForKey(key: string) {
  const entry = getActiveRedemptionAttemptEntry(key);
  const now = Date.now();
  if (entry) {
    entry.count += 1;
    entry.lastFailAt = now;
    setBoundedMapValue(redemptionAttemptStore, key, entry, REDEMPTION_ATTEMPT_MAX_KEYS);
  } else {
    setBoundedMapValue(redemptionAttemptStore, key, { count: 1, lastFailAt: now }, REDEMPTION_ATTEMPT_MAX_KEYS);
  }
}

export function pruneRedemptionAttemptStore(now = Date.now()) {
  return pruneMapEntries(redemptionAttemptStore, (entry) => now - entry.lastFailAt >= REDEMPTION_ATTEMPT_WINDOW_MS);
}

const redemptionAttemptCleanupTimer = setInterval(() => pruneRedemptionAttemptStore(), 5 * 60 * 1000);
redemptionAttemptCleanupTimer.unref?.();

function redemptionAttemptKeys(userId: number, scope?: string | null, kind: AttemptKind = "redeem") {
  const keys = [redemptionAttemptUserKey(userId, kind)];
  const sourceKey = redemptionAttemptSourceKey(scope, kind);
  if (sourceKey) keys.push(sourceKey);
  return keys;
}

function recordRedemptionAttemptFailure(userId: number, scope?: string | null, kind: AttemptKind = "redeem") {
  for (const key of redemptionAttemptKeys(userId, scope, kind)) {
    recordRedemptionAttemptFailureForKey(key);
  }
}

function clearRedemptionAttemptFailures(userId: number, scope?: string | null) {
  for (const key of redemptionAttemptKeys(userId, scope)) {
    redemptionAttemptStore.delete(key);
  }
}

function redemptionAttemptRateLimitState(userId: number, scope?: string | null, kind: AttemptKind = "redeem") {
  const checks = [
    { key: redemptionAttemptUserKey(userId, kind), threshold: REDEMPTION_ATTEMPT_THRESHOLD },
    ...(redemptionAttemptSourceKey(scope, kind) ? [{ key: redemptionAttemptSourceKey(scope, kind)!, threshold: REDEMPTION_ATTEMPT_SOURCE_THRESHOLD }] : []),
  ];
  let retryAfterSeconds = 0;
  for (const check of checks) {
    const entry = getActiveRedemptionAttemptEntry(check.key);
    if (!entry || entry.count < check.threshold) {
      continue;
    }
    const now = Date.now();
    const retryAt = entry.lastFailAt + REDEMPTION_ATTEMPT_BLOCK_MS;
    if (retryAt <= now) {
      redemptionAttemptStore.delete(check.key);
      continue;
    }
    retryAfterSeconds = Math.max(retryAfterSeconds, Math.ceil((retryAt - now) / 1000));
  }
  return retryAfterSeconds > 0
    ? { limited: true, retryAfterSeconds: Math.max(1, retryAfterSeconds) }
    : { limited: false, retryAfterSeconds: 0 };
}

async function withRedemptionLock<T>(locks: Map<string, Promise<void>>, key: string, fn: () => Promise<T>) {
  const previous = locks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  if (previous) await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  }
}

function redemptionAttemptLockKey(userId: number, scope?: string | null) {
  return redemptionAttemptSourceKey(scope) || redemptionAttemptUserKey(userId);
}

async function withRedemptionScopeLock<T>(userId: number, scope: string | null | undefined, fn: () => Promise<T>) {
  return withRedemptionLock(redemptionScopeLocks, redemptionAttemptLockKey(userId, scope), fn);
}

async function withRedemptionCodeLock<T>(code: string, fn: () => Promise<T>) {
  return withRedemptionLock(redemptionCodeLocks, code, fn);
}

export async function getPaymentOrderByOutTradeNo(outTradeNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(paymentOrders).where(eq(paymentOrders.outTradeNo, outTradeNo)).limit(1);
  return r[0];
}

export async function getPaymentOrderByOutTradeNoForUpdate(outTradeNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const q = quoteDbIdentifier;
  const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
  const rows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")} AS ${q("id")} FROM ${q("payment_orders")} WHERE ${q("outTradeNo")} = ? LIMIT 1${lock}`,
    [outTradeNo],
  );
  if (!rows[0]) return undefined;
  return getPaymentOrderByOutTradeNo(outTradeNo);
}

// ==================== Subscription Plans ====================

async function getPlanHostIds(planId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ hostId: subscriptionPlanHosts.hostId }).from(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, planId));
  return rows.map((r: any) => r.hostId);
}

async function getPlanTunnelIds(planId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ tunnelId: subscriptionPlanTunnels.tunnelId }).from(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, planId));
  return rows.map((r: any) => r.tunnelId);
}

/** 套餐附带的落地节点。买了自动发凭据，到期自动收 —— 见 syncPlanProxyNodeSharesForUser。 */
async function getPlanProxyNodeIds(planId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ nodeId: subscriptionPlanProxyNodes.nodeId })
    .from(subscriptionPlanProxyNodes)
    .where(eq(subscriptionPlanProxyNodes.planId, planId));
  return rows.map((r: any) => Number(r.nodeId)).filter(Boolean);
}

async function getPlanForwardGroupIds(planId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ forwardGroupId: subscriptionPlanForwardGroups.forwardGroupId })
    .from(subscriptionPlanForwardGroups)
    .where(eq(subscriptionPlanForwardGroups.planId, planId));
  return rows.map((r: any) => Number(r.forwardGroupId)).filter(Boolean);
}

async function getPlanTrafficAddons(planId: number, includeInactive = true) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [eq(subscriptionPlanTrafficAddons.planId, planId)];
  if (!includeInactive) conds.push(eq(subscriptionPlanTrafficAddons.isActive, true));
  return db
    .select()
    .from(subscriptionPlanTrafficAddons)
    .where(and(...conds))
    .orderBy(asc(subscriptionPlanTrafficAddons.sortOrder), asc(subscriptionPlanTrafficAddons.priceCents));
}

function normalizeTrafficAddons(addons: any[] = []) {
  return addons
    .map((addon, index) => ({
      trafficBytes: Math.max(0, Math.floor(Number(addon?.trafficBytes || 0))),
      priceCents: Math.max(0, Math.floor(Number(addon?.priceCents || 0))),
      isActive: addon?.isActive !== false,
      sortOrder: Math.max(0, Math.floor(Number(addon?.sortOrder ?? index))),
    }))
    .filter((addon) => addon.trafficBytes > 0)
    .slice(0, 20);
}

function normalizeNumericIds(values: any[] = []) {
  return Array.from(new Set(values.map(Number).filter((id) => Number.isFinite(id) && id > 0)));
}

function buildPlanSnapshot(plan: any) {
  return {
    name: plan?.name || null,
    portCount: Number(plan?.portCount ?? 20),
    trafficLimit: Number(plan?.trafficLimit || 0),
    rateLimitMbps: Number(plan?.rateLimitMbps || 0),
    maxRules: Number(plan?.maxRules ?? 20),
    /**
     * 订阅那一套的两个上限也要冻进快照。
     *
     * 漏了它们的后果不是「按套餐算」，而是**当成不限**：0 在配额合并那边表示
     * 不限，于是卖「2 个自建节点」的套餐，租户能开无限个。
     */
    maxProxyInbounds: Number(plan?.maxProxyInbounds || 0),
    maxProxySubTokens: Number(plan?.maxProxySubTokens || 0),
    maxProxyDevices: Number(plan?.maxProxyDevices || 0),
    maxConnections: Number(plan?.maxConnections ?? 2000),
    maxIPs: Number(plan?.maxIPs ?? 10),
    hostIds: normalizeNumericIds(plan?.hostIds || []),
    tunnelIds: normalizeNumericIds(plan?.tunnelIds || []),
    forwardGroupIds: normalizeNumericIds(plan?.forwardGroupIds || []),
    /**
     * 套餐带的落地节点也要冻进快照。
     *
     * 漏了它的后果最难发现：管理员勾掉「同步已有订阅者」，主机、隧道、转发组
     * 都按老套餐留着，**只有节点还是照着套餐当前内容算**。于是老客户身上随便
     * 发生一件小事（充值、流量重置、权益重算）就会触发一次同步，把他买的时候
     * 送的那个节点悄悄收走 —— 管理员明明说了「不要动老客户」。
     */
    proxyNodeIds: normalizeNumericIds(plan?.proxyNodeIds || []),
  };
}

function parsePlanSnapshot(value: unknown) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      portCount: Number(parsed.portCount ?? 20),
      trafficLimit: Number(parsed.trafficLimit || 0),
      rateLimitMbps: Number(parsed.rateLimitMbps || 0),
      maxRules: Number(parsed.maxRules ?? 20),
      /**
       * 这两项是后加的，老快照里没有 —— 缺就返回 undefined，让叠加那边退回
       * 套餐当前值。默认成 0 会把老订阅一律变成「不限」，正好是要修的那个 bug。
       */
      maxProxyInbounds: parsed.maxProxyInbounds === undefined ? undefined : Number(parsed.maxProxyInbounds || 0),
      maxProxySubTokens: parsed.maxProxySubTokens === undefined ? undefined : Number(parsed.maxProxySubTokens || 0),
      maxProxyDevices: parsed.maxProxyDevices === undefined ? undefined : Number(parsed.maxProxyDevices || 0),
      maxConnections: Number(parsed.maxConnections ?? 2000),
      maxIPs: Number(parsed.maxIPs ?? 10),
      hostIds: normalizeNumericIds(Array.isArray(parsed.hostIds) ? parsed.hostIds : []),
      tunnelIds: normalizeNumericIds(Array.isArray(parsed.tunnelIds) ? parsed.tunnelIds : []),
      forwardGroupIds: normalizeNumericIds(Array.isArray(parsed.forwardGroupIds) ? parsed.forwardGroupIds : []),
      /**
       * 和上面那两项同一个道理：这一列是后加的，老快照里没有。缺就返回
       * undefined，让节点授权退回「按套餐当前内容算」—— 也就是加这一列之前的
       * 行为。默认成空数组会把所有老订阅者的节点一次性收光。
       */
      proxyNodeIds: Array.isArray(parsed.proxyNodeIds)
        ? normalizeNumericIds(parsed.proxyNodeIds)
        : undefined,
    };
  } catch {
    return null;
  }
}

async function snapshotForPlanId(planId: number) {
  const plan = await getSubscriptionPlanById(planId);
  return plan ? buildPlanSnapshot(plan) : null;
}

async function attachSubscriptionSnapshots<T extends { planId: number; planSnapshot?: string | null }>(subscriptions: T[]) {
  return Promise.all(subscriptions.map(async (subscription: any) => {
    const snapshot = parsePlanSnapshot(subscription.planSnapshot);
    const addonTraffic = await getActiveTrafficAddonBreakdownForSubscription(Number(subscription.id));
    return {
      ...subscription,
      planName: snapshot?.name || subscription.planName,
      portCount: snapshot?.portCount ?? subscription.portCount,
      trafficLimit: snapshot?.trafficLimit ?? subscription.trafficLimit,
      rateLimitMbps: snapshot?.rateLimitMbps ?? subscription.rateLimitMbps,
      maxRules: snapshot?.maxRules ?? subscription.maxRules,
      maxProxyInbounds: snapshot?.maxProxyInbounds ?? subscription.maxProxyInbounds,
      maxProxySubTokens: snapshot?.maxProxySubTokens ?? subscription.maxProxySubTokens,
      maxProxyDevices: snapshot?.maxProxyDevices ?? subscription.maxProxyDevices,
      maxConnections: snapshot?.maxConnections ?? subscription.maxConnections,
      maxIPs: snapshot?.maxIPs ?? subscription.maxIPs,
      hostIds: snapshot ? snapshot.hostIds : await getPlanHostIds(Number(subscription.planId)),
      tunnelIds: snapshot ? snapshot.tunnelIds : await getPlanTunnelIds(Number(subscription.planId)),
      forwardGroupIds: snapshot ? snapshot.forwardGroupIds : await getPlanForwardGroupIds(Number(subscription.planId)),
      trafficAddons: await getPlanTrafficAddons(Number(subscription.planId), false),
      activeTrafficAddonBytes: addonTraffic.totalBytes,
      purchasedTrafficAddonBytes: addonTraffic.purchasedBytes,
      grantedTrafficAddonBytes: addonTraffic.grantedBytes,
    };
  }));
}


async function attachPlanResources<T extends { id: number }>(plans: T[]) {
  const db = await getDb();
  if (!db || plans.length === 0) {
    return plans.map((plan) => ({
      ...plan,
      hostIds: [] as number[],
      tunnelIds: [] as number[],
      forwardGroupIds: [] as number[],
      forwardGroupRefs: [] as Array<{ id: number; groupMode: string | null; groupType: string | null }>,
      proxyNodeIds: [] as number[],
      priceTiers: [] as PlanPriceTier[],
      trafficAddons: [] as any[],
    }));
  }
  const planIds = Array.from(new Set(plans.map((plan) => Number(plan.id)).filter((id) => id > 0)));
  const [hostRows, tunnelRows, groupRows, proxyNodeRows, priceRows, addonRows] = await Promise.all([
    db.select({
      planId: subscriptionPlanHosts.planId,
      hostId: subscriptionPlanHosts.hostId,
    }).from(subscriptionPlanHosts).where(inArray(subscriptionPlanHosts.planId, planIds)),
    db.select({
      planId: subscriptionPlanTunnels.planId,
      tunnelId: subscriptionPlanTunnels.tunnelId,
    }).from(subscriptionPlanTunnels).where(inArray(subscriptionPlanTunnels.planId, planIds)),
    db.select({
      planId: subscriptionPlanForwardGroups.planId,
      forwardGroupId: subscriptionPlanForwardGroups.forwardGroupId,
      groupMode: forwardGroups.groupMode,
      groupType: forwardGroups.groupType,
    })
      .from(subscriptionPlanForwardGroups)
      .leftJoin(forwardGroups, eq(forwardGroups.id, subscriptionPlanForwardGroups.forwardGroupId))
      .where(inArray(subscriptionPlanForwardGroups.planId, planIds)),
    db.select({
      planId: subscriptionPlanProxyNodes.planId,
      nodeId: subscriptionPlanProxyNodes.nodeId,
    }).from(subscriptionPlanProxyNodes).where(inArray(subscriptionPlanProxyNodes.planId, planIds)),
    db.select({
      planId: subscriptionPlanPrices.planId,
      durationDays: subscriptionPlanPrices.durationDays,
      priceCents: subscriptionPlanPrices.priceCents,
    }).from(subscriptionPlanPrices)
      .where(inArray(subscriptionPlanPrices.planId, planIds))
      .orderBy(asc(subscriptionPlanPrices.planId), asc(subscriptionPlanPrices.durationDays)),
    db.select()
      .from(subscriptionPlanTrafficAddons)
      .where(inArray(subscriptionPlanTrafficAddons.planId, planIds))
      .orderBy(
        asc(subscriptionPlanTrafficAddons.planId),
        asc(subscriptionPlanTrafficAddons.sortOrder),
        asc(subscriptionPlanTrafficAddons.priceCents),
      ),
  ]);
  const hostIdsByPlan = new Map<number, number[]>();
  const tunnelIdsByPlan = new Map<number, number[]>();
  const groupRefsByPlan = new Map<number, Array<{ id: number; groupMode: string | null; groupType: string | null }>>();
  const proxyNodeIdsByPlan = new Map<number, number[]>();
  const addonsByPlan = new Map<number, any[]>();
  for (const row of hostRows as any[]) {
    const planId = Number(row.planId);
    const values = hostIdsByPlan.get(planId) || [];
    values.push(Number(row.hostId));
    hostIdsByPlan.set(planId, values);
  }
  for (const row of tunnelRows as any[]) {
    const planId = Number(row.planId);
    const values = tunnelIdsByPlan.get(planId) || [];
    values.push(Number(row.tunnelId));
    tunnelIdsByPlan.set(planId, values);
  }
  for (const row of groupRows as any[]) {
    const planId = Number(row.planId);
    const values = groupRefsByPlan.get(planId) || [];
    values.push({
      id: Number(row.forwardGroupId),
      groupMode: row.groupMode ? String(row.groupMode) : null,
      groupType: row.groupType ? String(row.groupType) : null,
    });
    groupRefsByPlan.set(planId, values);
  }
  for (const row of proxyNodeRows as any[]) {
    const planId = Number(row.planId);
    const values = proxyNodeIdsByPlan.get(planId) || [];
    values.push(Number(row.nodeId));
    proxyNodeIdsByPlan.set(planId, values);
  }
  const priceTiersByPlan = new Map<number, PlanPriceTier[]>();
  for (const row of priceRows as any[]) {
    const planId = Number(row.planId);
    const values = priceTiersByPlan.get(planId) || [];
    values.push({ durationDays: Number(row.durationDays), priceCents: Number(row.priceCents) });
    priceTiersByPlan.set(planId, values);
  }
  for (const row of addonRows as any[]) {
    const planId = Number(row.planId);
    const values = addonsByPlan.get(planId) || [];
    values.push(row);
    addonsByPlan.set(planId, values);
  }
  return plans.map((plan) => {
    const refs = groupRefsByPlan.get(Number(plan.id)) || [];
    return {
      ...plan,
      hostIds: hostIdsByPlan.get(Number(plan.id)) || [],
      tunnelIds: tunnelIdsByPlan.get(Number(plan.id)) || [],
      forwardGroupIds: refs.map((ref) => ref.id),
      forwardGroupRefs: refs,
      proxyNodeIds: proxyNodeIdsByPlan.get(Number(plan.id)) || [],
      /**
       * 多周期定价。空数组 = 这个套餐只有它自己那一档 —— 前端一律走
       * planPricingOptions()，那边会退回套餐主表上的 durationDays / priceCents，
       * 所以存量套餐在界面上跟以前一模一样。
       */
      priceTiers: priceTiersByPlan.get(Number(plan.id)) || [],
      trafficAddons: addonsByPlan.get(Number(plan.id)) || [],
    };
  });
}

export async function listSubscriptionPlans(includeHidden = true) {
  const db = await getDb();
  if (!db) return [];
  const rows = includeHidden
    ? await db.select().from(subscriptionPlans).orderBy(asc(subscriptionPlans.sortOrder), desc(subscriptionPlans.createdAt))
    : await db.select().from(subscriptionPlans).where(and(eq(subscriptionPlans.isActive, true), eq(subscriptionPlans.isStoreVisible, true))).orderBy(asc(subscriptionPlans.sortOrder), desc(subscriptionPlans.createdAt));
  return attachPlanResources(rows);
}

export async function listSubscriptionPlanOptions(includeHidden = true) {
  const db = await getDb();
  if (!db) return [];
  const query = db
    .select({
      id: subscriptionPlans.id,
      name: subscriptionPlans.name,
      durationDays: subscriptionPlans.durationDays,
      portCount: subscriptionPlans.portCount,
      priceCents: subscriptionPlans.priceCents,
      currency: subscriptionPlans.currency,
      isActive: subscriptionPlans.isActive,
      isStoreVisible: subscriptionPlans.isStoreVisible,
    })
    .from(subscriptionPlans);
  const rows = includeHidden
    ? await query.orderBy(asc(subscriptionPlans.sortOrder), desc(subscriptionPlans.createdAt))
    : await query
      .where(and(eq(subscriptionPlans.isActive, true), eq(subscriptionPlans.isStoreVisible, true)))
      .orderBy(asc(subscriptionPlans.sortOrder), desc(subscriptionPlans.createdAt));
  /**
   * 档位也带上：手动分配套餐时要按档选周期，不然卖月付 / 年付的套餐，管理员
   * 想手动给一个年付都给不了（只能给默认档）。
   */
  const planIds = (rows as any[]).map((row) => Number(row.id)).filter((id) => id > 0);
  if (planIds.length === 0) return rows;
  const tierRows = await db
    .select({
      planId: subscriptionPlanPrices.planId,
      durationDays: subscriptionPlanPrices.durationDays,
      priceCents: subscriptionPlanPrices.priceCents,
    })
    .from(subscriptionPlanPrices)
    .where(inArray(subscriptionPlanPrices.planId, planIds))
    .orderBy(asc(subscriptionPlanPrices.planId), asc(subscriptionPlanPrices.durationDays));
  const tiersByPlan = new Map<number, PlanPriceTier[]>();
  for (const row of tierRows as any[]) {
    const planId = Number(row.planId);
    const values = tiersByPlan.get(planId) || [];
    values.push({ durationDays: Number(row.durationDays), priceCents: Number(row.priceCents) });
    tiersByPlan.set(planId, values);
  }
  return (rows as any[]).map((row) => ({ ...row, priceTiers: tiersByPlan.get(Number(row.id)) || [] }));
}


export async function getSubscriptionPlanSummary() {
  const db = await getDb();
  if (!db) {
    return {
      totalItems: 0,
      activeItems: 0,
      storeVisibleItems: 0,
      resources: {
        legacyHosts: 0,
        tunnels: 0,
        ports: 0,
        chains: 0,
        groups: 0,
        otherForwardResources: 0,
      },
    };
  }
  const [planRows, hostRows, tunnelRows, groupRows] = await Promise.all([
    db.select({
      totalItems: sql<number>`COUNT(*)`,
      activeItems: sql<number>`COALESCE(SUM(CASE WHEN ${subscriptionPlans.isActive} = ${sqlBool(true)} THEN 1 ELSE 0 END), 0)`,
      storeVisibleItems: sql<number>`COALESCE(SUM(CASE WHEN ${subscriptionPlans.isActive} = ${sqlBool(true)} AND ${subscriptionPlans.isStoreVisible} = ${sqlBool(true)} THEN 1 ELSE 0 END), 0)`,
    }).from(subscriptionPlans),
    db.select({ count: sql<number>`COUNT(*)` }).from(subscriptionPlanHosts),
    db.select({ count: sql<number>`COUNT(*)` }).from(subscriptionPlanTunnels),
    db.select({
      groupMode: forwardGroups.groupMode,
      count: sql<number>`COUNT(*)`,
    })
      .from(subscriptionPlanForwardGroups)
      .leftJoin(forwardGroups, eq(forwardGroups.id, subscriptionPlanForwardGroups.forwardGroupId))
      .groupBy(forwardGroups.groupMode),
  ]);
  const resources = {
    legacyHosts: Number(hostRows[0]?.count || 0),
    tunnels: Number(tunnelRows[0]?.count || 0),
    ports: 0,
    chains: 0,
    groups: 0,
    otherForwardResources: 0,
  };
  for (const row of groupRows as any[]) {
    const count = Number(row.count || 0);
    const mode = String(row.groupMode || "");
    if (mode === "port") resources.ports += count;
    else if (mode === "chain") resources.chains += count;
    else if (mode === "failover") resources.groups += count;
    else resources.otherForwardResources += count;
  }
  return {
    totalItems: Number(planRows[0]?.totalItems || 0),
    activeItems: Number(planRows[0]?.activeItems || 0),
    storeVisibleItems: Number(planRows[0]?.storeVisibleItems || 0),
    resources,
  };
}

export async function listSubscriptionPlansPage(input: PageRequest) {
  const db = await getDb();
  if (!db) return { ...pageResult([], 0, input), activeItems: 0 };
  const [totals] = await db
    .select({
      totalItems: sql<number>`COUNT(*)`,
      activeItems: sql<number>`COALESCE(SUM(CASE WHEN ${subscriptionPlans.isActive} = ${sqlBool(true)} THEN 1 ELSE 0 END), 0)`,
    })
    .from(subscriptionPlans);
  const totalItems = Number(totals?.totalItems || 0);
  const activeItems = Number(totals?.activeItems || 0);
  const window = pageWindowForTotal(input, totalItems);
  const rows = await db
    .select()
    .from(subscriptionPlans)
    .orderBy(asc(subscriptionPlans.sortOrder), desc(subscriptionPlans.createdAt), desc(subscriptionPlans.id))
    .limit(window.pageSize)
    .offset(window.offset);
  return {
    ...pageResult(await attachPlanResources(rows), totalItems, window),
    activeItems,
  };
}

export async function getSubscriptionPlanById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id)).limit(1);
  if (!rows[0]) return undefined;
  return (await attachPlanResources([rows[0]]))[0];
}

export async function createSubscriptionPlan(data: InsertSubscriptionPlan, hostIds: number[], tunnelIds: number[], forwardGroupIds: number[] = [], trafficAddons: any[] = [], proxyNodeIds: number[] = [], priceTiers: Array<Partial<PlanPriceTier>> = []) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = await insertAndGetId("subscription_plans", data as any);
  await setSubscriptionPlanResources(id, hostIds, tunnelIds, forwardGroupIds, proxyNodeIds);
  await setSubscriptionPlanTrafficAddons(id, trafficAddons);
  if (priceTiers.length > 0) await setSubscriptionPlanPrices(id, priceTiers);
  return getSubscriptionPlanById(id);
}

export async function updateSubscriptionPlan(id: number, data: Partial<InsertSubscriptionPlan>, hostIds?: number[], tunnelIds?: number[], forwardGroupIds?: number[], trafficAddons?: any[], proxyNodeIds?: number[], priceTiers?: Array<Partial<PlanPriceTier>>) {
  const db = await getDb();
  if (!db) return undefined;
  await db.update(subscriptionPlans).set({ ...data, updatedAt: nowDate() } as any).where(eq(subscriptionPlans.id, id));
  if (hostIds || tunnelIds || forwardGroupIds || proxyNodeIds) {
    await setSubscriptionPlanResources(
      id,
      hostIds ?? await getPlanHostIds(id),
      tunnelIds ?? await getPlanTunnelIds(id),
      forwardGroupIds ?? await getPlanForwardGroupIds(id),
      proxyNodeIds ?? await getPlanProxyNodeIds(id),
    );
  }
  if (trafficAddons) await setSubscriptionPlanTrafficAddons(id, trafficAddons);
  // 定价放在最后：它会把默认档写回主表，不能被上面那次 update 覆盖掉。
  if (priceTiers) await setSubscriptionPlanPrices(id, priceTiers);
  return getSubscriptionPlanById(id);
}

export async function freezePlanSubscriberSnapshots(planId: number) {
  const db = await getDb();
  if (!db) return [];
  const currentSnapshot = await snapshotForPlanId(planId);
  if (!currentSnapshot) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
      planSnapshot: userSubscriptions.planSnapshot,
    })
    .from(userSubscriptions)
    .where(and(
      eq(userSubscriptions.planId, planId),
      eq(userSubscriptions.status, "active"),
      sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
    ));
  const userIds = new Set<number>();
  for (const row of rows as any[]) {
    const userId = Number(row.userId || 0);
    if (userId > 0) userIds.add(userId);
    if (parsePlanSnapshot(row.planSnapshot)) continue;
    await updateUserSubscription(Number(row.id), { planSnapshot: JSON.stringify(currentSnapshot) } as any);
  }
  return Array.from(userIds);
}

export async function syncPlanSubscribers(planId: number) {
  const db = await getDb();
  if (!db) return [];
  const snapshot = await snapshotForPlanId(planId);
  if (!snapshot) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
    })
    .from(userSubscriptions)
    .where(and(
      eq(userSubscriptions.planId, planId),
      eq(userSubscriptions.status, "active"),
      sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
    ));
  const subscriptionIdsByUser = new Map<number, number[]>();
  for (const row of rows as any[]) {
    const subscriptionId = Number(row.id || 0);
    const userId = Number(row.userId || 0);
    if (subscriptionId <= 0 || userId <= 0) continue;
    const subscriptionIds = subscriptionIdsByUser.get(userId) || [];
    subscriptionIds.push(subscriptionId);
    subscriptionIdsByUser.set(userId, subscriptionIds);
  }
  const affectedUserIds = Array.from(subscriptionIdsByUser.keys());
  for (const [userId, subscriptionIds] of subscriptionIdsByUser) {
    await withTrafficBillingUserTransaction(userId, async () => {
      for (const subscriptionId of subscriptionIds) {
        await updateUserSubscription(subscriptionId, { planSnapshot: JSON.stringify(snapshot) } as any);
      }
      await syncUserSubscriptionEntitlementsUnlocked(userId);
    });
  }
  return affectedUserIds;
}

export async function deleteSubscriptionPlan(id: number) {
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) return;
    await setSetting(SUBSCRIPTION_PLAN_PAYMENT_MARKER, "1");
    const blockingOrder = await db
      .select({ outTradeNo: paymentOrders.outTradeNo })
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.planId, id),
        inArray(paymentOrders.status, ["pending", "paid", "processing"] as any),
      ))
      .limit(1);
    if (blockingOrder[0]) {
      throw new Error("套餐仍有待支付或待发放订单，暂时不能删除");
    }
    await db.delete(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, id));
    await db.delete(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, id));
    await db.delete(subscriptionPlanForwardGroups).where(eq(subscriptionPlanForwardGroups.planId, id));
    await db.delete(subscriptionPlanProxyNodes).where(eq(subscriptionPlanProxyNodes.planId, id));
    await db.delete(subscriptionPlanTrafficAddons).where(eq(subscriptionPlanTrafficAddons.planId, id));
    await db.delete(subscriptionPlanPrices).where(eq(subscriptionPlanPrices.planId, id));
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, id));
  });
}

export async function setSubscriptionPlanResources(
  planId: number,
  hostIds: number[],
  tunnelIds: number[],
  forwardGroupIds: number[] = [],
  proxyNodeIds: number[] = [],
) {
  const db = await getDb();
  if (!db) return;
  await db.delete(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, planId));
  await db.delete(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, planId));
  await db.delete(subscriptionPlanForwardGroups).where(eq(subscriptionPlanForwardGroups.planId, planId));
  await db.delete(subscriptionPlanProxyNodes).where(eq(subscriptionPlanProxyNodes.planId, planId));
  const uniqueHostIds = Array.from(new Set(hostIds.filter(id => id > 0)));
  const uniqueTunnelIds = Array.from(new Set(tunnelIds.filter(id => id > 0)));
  const uniqueForwardGroupIds = Array.from(new Set(forwardGroupIds.filter(id => id > 0)));
  const uniqueProxyNodeIds = Array.from(new Set(proxyNodeIds.filter(id => id > 0)));
  if (uniqueHostIds.length > 0) await db.insert(subscriptionPlanHosts).values(uniqueHostIds.map(hostId => ({ planId, hostId })));
  if (uniqueTunnelIds.length > 0) await db.insert(subscriptionPlanTunnels).values(uniqueTunnelIds.map(tunnelId => ({ planId, tunnelId })));
  if (uniqueForwardGroupIds.length > 0) await db.insert(subscriptionPlanForwardGroups).values(uniqueForwardGroupIds.map(forwardGroupId => ({ planId, forwardGroupId })));
  if (uniqueProxyNodeIds.length > 0) await db.insert(subscriptionPlanProxyNodes).values(uniqueProxyNodeIds.map(nodeId => ({ planId, nodeId })));
}

/**
 * 写这个套餐的多周期定价。
 *
 * 顺手把**默认档**（总价最低那一档）同步回套餐主表的 durationDays / priceCents：
 * 兑换码、后台分配、老的下单路径读的都是那两列，不同步的话它们会拿着一个已经不
 * 卖了的价格继续算。传空数组就等于「只有主表那一档」，退回改动前的形态。
 */
export async function setSubscriptionPlanPrices(planId: number, tiers: Array<Partial<PlanPriceTier>> = []) {
  const db = await getDb();
  if (!db) return;
  const rows = normalizePlanPriceTiers(tiers);
  await db.delete(subscriptionPlanPrices).where(eq(subscriptionPlanPrices.planId, planId));
  if (rows.length === 0) return;
  await db.insert(subscriptionPlanPrices).values(rows.map((tier) => ({
    planId,
    durationDays: tier.durationDays,
    priceCents: tier.priceCents,
  })));
  const fallback = defaultPricingOption(planPricingOptions({}, rows));
  if (fallback) {
    await db.update(subscriptionPlans).set({
      durationDays: fallback.durationDays,
      priceCents: fallback.priceCents,
      updatedAt: nowDate(),
    } as any).where(eq(subscriptionPlans.id, planId));
  }
}

/**
 * 客户选的这一档到底卖不卖、卖多少钱 —— 收钱前的唯一裁判。
 *
 * 不传周期就是默认档（老客户端、兑换码、后台分配都走这条）。传了但认不出来就
 * 报错，绝不拿默认档顶上：那会变成「我买的是年付，开出来是月付」。
 */
export async function resolvePlanPricing(planId: number, durationDays?: number | null) {
  const plan = await getSubscriptionPlanById(planId);
  if (!plan) throw new Error("套餐不存在");
  const options = planPricingOptions(plan as any, (plan as any).priceTiers || []);
  if (durationDays === null || durationDays === undefined) {
    const fallback = defaultPricingOption(options);
    if (!fallback) throw new Error("套餐没有可购买的周期");
    return { plan, option: fallback, options };
  }
  const option = findPricingOption(options, durationDays);
  if (!option) throw new Error("该套餐没有这个购买周期，请刷新后重试");
  return { plan, option, options };
}

export async function setSubscriptionPlanTrafficAddons(planId: number, addons: any[] = []) {
  const db = await getDb();
  if (!db) return;
  await db.delete(subscriptionPlanTrafficAddons).where(eq(subscriptionPlanTrafficAddons.planId, planId));
  const rows = normalizeTrafficAddons(addons);
  if (rows.length === 0) return;
  await db.insert(subscriptionPlanTrafficAddons).values(rows.map((addon) => ({
    planId,
    trafficBytes: addon.trafficBytes,
    priceCents: addon.priceCents,
    isActive: addon.isActive,
    sortOrder: addon.sortOrder,
  })));
}

function userSubscriptionsListQuery(db: any) {
  const base = db
    .select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
      username: users.username,
      name: users.name,
      planId: userSubscriptions.planId,
      planName: subscriptionPlans.name,
      priceCents: subscriptionPlans.priceCents,
      currency: subscriptionPlans.currency,
      durationDays: subscriptionPlans.durationDays,
      /**
       * 这条订阅当初买的那一档。续费按它算 —— 拿套餐主表的默认档去续，买年付的
       * 人点一下「续费」就变成了续一个月，而金额还是照年付显示的那个。
       * 老数据（这一列之前不存在）是 null，调用方退回默认档。
       */
      purchasedDurationDays: userSubscriptions.durationDays,
      portCount: subscriptionPlans.portCount,
      trafficLimit: subscriptionPlans.trafficLimit,
      rateLimitMbps: subscriptionPlans.rateLimitMbps,
      maxRules: subscriptionPlans.maxRules,
      maxProxyInbounds: subscriptionPlans.maxProxyInbounds,
      maxProxySubTokens: subscriptionPlans.maxProxySubTokens,
      maxProxyDevices: subscriptionPlans.maxProxyDevices,
      maxConnections: subscriptionPlans.maxConnections,
      maxIPs: subscriptionPlans.maxIPs,
      status: userSubscriptions.status,
      source: userSubscriptions.source,
      autoRenew: userSubscriptions.autoRenew,
      paymentOrderNo: userSubscriptions.paymentOrderNo,
      planSnapshot: userSubscriptions.planSnapshot,
      portRangeStart: userSubscriptions.portRangeStart,
      portRangeEnd: userSubscriptions.portRangeEnd,
      nextTrafficResetAt: userSubscriptions.nextTrafficResetAt,
      lastTrafficResetAt: userSubscriptions.lastTrafficResetAt,
      userDismissedAt: userSubscriptions.userDismissedAt,
      adminDismissedAt: userSubscriptions.adminDismissedAt,
      startedAt: userSubscriptions.startedAt,
      expiresAt: userSubscriptions.expiresAt,
      createdAt: userSubscriptions.createdAt,
      updatedAt: userSubscriptions.updatedAt,
    })
    .from(userSubscriptions)
    .leftJoin(users, eq(userSubscriptions.userId, users.id))
    .leftJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id));
  return base;
}

type SubscriptionListVisibility = "all" | "user" | "admin";

function subscriptionVisibilityConditions(visibility: SubscriptionListVisibility) {
  if (visibility === "user") {
    return [isNull(userSubscriptions.userDismissedAt), isNull(userSubscriptions.adminDismissedAt)];
  }
  if (visibility === "admin") return [isNull(userSubscriptions.adminDismissedAt)];
  return [];
}

export async function listUserSubscriptions(
  userId?: number,
  options: { visibility?: SubscriptionListVisibility } = {},
) {
  const db = await getDb();
  if (!db) return [];
  const base = userSubscriptionsListQuery(db);
  const conditions = subscriptionVisibilityConditions(options.visibility || "all");
  if (userId !== undefined) conditions.push(eq(userSubscriptions.userId, userId));
  const rows = conditions.length > 0
    ? await base.where(and(...conditions)).orderBy(desc(userSubscriptions.createdAt))
    : await base.orderBy(desc(userSubscriptions.createdAt));
  return attachUserSubscriptionDetails(rows);
}

export async function getUserSubscriptionById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await userSubscriptionsListQuery(db)
    .where(eq(userSubscriptions.id, id))
    .limit(1);
  if (!rows[0]) return undefined;
  return (await attachUserSubscriptionDetails(rows))[0];
}

export async function listUserSubscriptionsPage(input: PageRequest & {
  userId?: number;
  excludeCancelled?: boolean;
  visibility?: SubscriptionListVisibility;
}) {
  const db = await getDb();
  if (!db) return { ...pageResult([], 0, input), activeItems: 0 };
  const conditions = [] as any[];
  if (input.userId !== undefined) conditions.push(eq(userSubscriptions.userId, input.userId));
  if (input.excludeCancelled !== false) conditions.push(sql`${userSubscriptions.status} <> 'cancelled'`);
  conditions.push(...subscriptionVisibilityConditions(input.visibility || "all"));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const nowSec = Math.floor(Date.now() / 1000);
  const aggregateQuery = db
    .select({
      totalItems: sql<number>`COUNT(*)`,
      activeItems: sql<number>`COALESCE(SUM(CASE
        WHEN ${userSubscriptions.status} = 'active'
          AND (${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})
        THEN 1 ELSE 0 END), 0)`,
    })
    .from(userSubscriptions);
  const [totals] = where ? await aggregateQuery.where(where) : await aggregateQuery;
  const totalItems = Number(totals?.totalItems || 0);
  const activeItems = Number(totals?.activeItems || 0);
  const window = pageWindowForTotal(input, totalItems);
  const listQuery = userSubscriptionsListQuery(db);
  const rows = where
    ? await listQuery
      .where(where)
      .orderBy(desc(userSubscriptions.createdAt), desc(userSubscriptions.id))
      .limit(window.pageSize)
      .offset(window.offset)
    : await listQuery
      .orderBy(desc(userSubscriptions.createdAt), desc(userSubscriptions.id))
      .limit(window.pageSize)
      .offset(window.offset);
  return {
    ...pageResult(await attachUserSubscriptionDetails(rows), totalItems, window),
    activeItems,
  };
}

async function attachUserSubscriptionDetails<T extends { id: number; planId: number }>(subscriptions: T[]) {
  const withSnapshots = await attachSubscriptionSnapshots(subscriptions as any);
  return attachRenewalPricing(withSnapshots as any[]);
}

/**
 * 给每条订阅算出「续费按哪一档、多少钱」。
 *
 * 放在服务端算而不是让前端自己拼：续费金额是要扣钱的数，前端各页面各算一遍迟早
 * 会有一处忘了跟上。前端只管显示 renewPriceCents 和 renewDurationDays。
 */
async function attachRenewalPricing(rows: any[]) {
  const db = await getDb();
  if (!db || rows.length === 0) return rows;
  const planIds = Array.from(new Set(rows.map((row) => Number(row.planId)).filter((id) => id > 0)));
  if (planIds.length === 0) return rows;
  const tierRows = await db
    .select({
      planId: subscriptionPlanPrices.planId,
      durationDays: subscriptionPlanPrices.durationDays,
      priceCents: subscriptionPlanPrices.priceCents,
    })
    .from(subscriptionPlanPrices)
    .where(inArray(subscriptionPlanPrices.planId, planIds))
    .orderBy(asc(subscriptionPlanPrices.planId), asc(subscriptionPlanPrices.durationDays));
  const tiersByPlan = new Map<number, PlanPriceTier[]>();
  for (const row of tierRows as any[]) {
    const planId = Number(row.planId);
    const values = tiersByPlan.get(planId) || [];
    values.push({ durationDays: Number(row.durationDays), priceCents: Number(row.priceCents) });
    tiersByPlan.set(planId, values);
  }
  return rows.map((row) => {
    const options = planPricingOptions(
      { durationDays: row.durationDays, priceCents: row.priceCents },
      tiersByPlan.get(Number(row.planId)) || [],
    );
    const { option } = renewalPricingOption(options, row.purchasedDurationDays);
    return {
      ...row,
      priceTiers: tiersByPlan.get(Number(row.planId)) || [],
      renewDurationDays: option?.durationDays ?? Number(row.durationDays || 0),
      renewPriceCents: option?.priceCents ?? Number(row.priceCents || 0),
    };
  });
}

async function getActiveTrafficAddonBreakdownForSubscription(subscriptionId: number) {
  const db = await getDb();
  if (!db || !subscriptionId) return { totalBytes: 0, purchasedBytes: 0, grantedBytes: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${userTrafficAddons.trafficBytes}), 0)`,
      purchased: sql<number>`COALESCE(SUM(CASE WHEN ${userTrafficAddons.source} = 'user' THEN ${userTrafficAddons.trafficBytes} ELSE 0 END), 0)`,
      granted: sql<number>`COALESCE(SUM(CASE WHEN ${userTrafficAddons.source} = 'admin' THEN ${userTrafficAddons.trafficBytes} ELSE 0 END), 0)`,
    })
    .from(userTrafficAddons)
    .innerJoin(userSubscriptions, eq(userTrafficAddons.subscriptionId, userSubscriptions.id))
    .where(and(
      eq(userTrafficAddons.subscriptionId, subscriptionId),
      eq(userTrafficAddons.status, "active"),
      sql`(${userTrafficAddons.expiresAt} IS NULL OR ${userTrafficAddons.expiresAt} > ${nowSec})`,
      eq(userSubscriptions.status, "active"),
      sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
    ));
  return {
    totalBytes: Number(rows?.[0]?.total || 0),
    purchasedBytes: Number(rows?.[0]?.purchased || 0),
    grantedBytes: Number(rows?.[0]?.granted || 0),
  };
}

export async function getActiveUserTrafficAddonBytes(userId: number) {
  const db = await getDb();
  if (!db || !userId) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({ total: sql<number>`COALESCE(SUM(${userTrafficAddons.trafficBytes}), 0)` })
    .from(userTrafficAddons)
    .innerJoin(userSubscriptions, eq(userTrafficAddons.subscriptionId, userSubscriptions.id))
    .where(and(
      eq(userTrafficAddons.userId, userId),
      eq(userTrafficAddons.status, "active"),
      sql`(${userTrafficAddons.expiresAt} IS NULL OR ${userTrafficAddons.expiresAt} > ${nowSec})`,
      eq(userSubscriptions.status, "active"),
      sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
    ));
  return Number(rows?.[0]?.total || 0);
}

export async function getActiveUserSubscriptions(userId?: number) {
  try {
    const db = await getDb();
    if (!db) return [];
    const nowSec = Math.floor(Date.now() / 1000);
    const conds: any[] = [
      eq(userSubscriptions.status, "active"),
      sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
    ];
    if (userId !== undefined) conds.push(eq(userSubscriptions.userId, userId));
    const rows = await db
      .select({
        id: userSubscriptions.id,
        userId: userSubscriptions.userId,
        planId: userSubscriptions.planId,
        status: userSubscriptions.status,
        source: userSubscriptions.source,
        autoRenew: userSubscriptions.autoRenew,
        paymentOrderNo: userSubscriptions.paymentOrderNo,
        planSnapshot: userSubscriptions.planSnapshot,
        portRangeStart: userSubscriptions.portRangeStart,
        portRangeEnd: userSubscriptions.portRangeEnd,
        nextTrafficResetAt: userSubscriptions.nextTrafficResetAt,
        lastTrafficResetAt: userSubscriptions.lastTrafficResetAt,
        startedAt: userSubscriptions.startedAt,
        expiresAt: userSubscriptions.expiresAt,
        planName: subscriptionPlans.name,
        portCount: subscriptionPlans.portCount,
        trafficLimit: subscriptionPlans.trafficLimit,
        rateLimitMbps: subscriptionPlans.rateLimitMbps,
        maxRules: subscriptionPlans.maxRules,
        // 这两列以前没查出来，于是配额合并那边看到 undefined、当成 0 =「不限」——
        // 套餐上填的自建节点数和订阅地址数等于白填。
        maxProxyInbounds: subscriptionPlans.maxProxyInbounds,
        maxProxySubTokens: subscriptionPlans.maxProxySubTokens,
        maxProxyDevices: subscriptionPlans.maxProxyDevices,
        maxConnections: subscriptionPlans.maxConnections,
        maxIPs: subscriptionPlans.maxIPs,
        allowProxySubscription: subscriptionPlans.allowProxySubscription,
      })
      .from(userSubscriptions)
      .leftJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
      .where(and(...conds))
      .orderBy(desc(userSubscriptions.createdAt));
    return attachSubscriptionSnapshots(rows as any);
  } catch (error) {
    warnActiveSubscriptionLookupFailure(error);
    return [];
  }
}

export async function createUserSubscription(data: InsertUserSubscription) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("user_subscriptions", data as any);
}

export async function updateUserSubscription(id: number, data: Partial<InsertUserSubscription>) {
  const db = await getDb();
  if (!db) return;
  await db.update(userSubscriptions).set({ ...data, updatedAt: nowDate() } as any).where(eq(userSubscriptions.id, id));
}

function validDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value as any);
  return Number.isFinite(date.getTime()) ? date : null;
}

function boundTrafficResetAt(resetAt: Date | null, expiresAt: Date | null) {
  if (!resetAt) return null;
  return !expiresAt || resetAt.getTime() < expiresAt.getTime() ? resetAt : null;
}

function nextBillingMonthlyTrafficReset(start: Date, expiresAt: Date | null) {
  const next = billingStartOfCalendarDay(billingAddMonthsClamped(start, 1));
  return !expiresAt || next.getTime() < expiresAt.getTime() ? next : null;
}

function nextAnchoredSubscriptionTrafficReset(startedAt: unknown, reference: Date, expiresAt: Date | null) {
  const anchor = validDate(startedAt) || reference;
  const referenceCalendar = billingCalendarParts(reference);
  const anchorCalendar = billingCalendarParts(anchor);
  const monthDelta = Math.max(
    1,
    (referenceCalendar.year - anchorCalendar.year) * 12 + referenceCalendar.month - anchorCalendar.month,
  );
  let months = monthDelta;
  let next = billingStartOfCalendarDay(billingAddMonthsClamped(anchor, months));
  while (next.getTime() <= reference.getTime()) {
    months += 1;
    next = billingStartOfCalendarDay(billingAddMonthsClamped(anchor, months));
  }
  return boundTrafficResetAt(next, expiresAt);
}

function nextConfiguredSubscriptionTrafficReset(
  user: { trafficResetDay?: unknown },
  subscription: { startedAt?: unknown; lastTrafficResetAt?: unknown },
  reference: Date,
  expiresAt: Date | null,
) {
  const resetDay = Math.min(MONTHLY_RESET_MAX_DAY, Math.max(1, Math.floor(Number(user.trafficResetDay) || 1)));
  let monthOffset = 0;
  let next = billingMonthlyBoundary(reference, resetDay, monthOffset);

  // A subscription created after this month's boundary did not participate in
  // that cycle. A boundary already settled for it must not run twice.
  const startedAt = validDate(subscription.startedAt);
  const lastTrafficResetAt = validDate(subscription.lastTrafficResetAt);
  const handledThrough = Math.max(
    startedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    lastTrafficResetAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  while (next.getTime() <= handledThrough) {
    monthOffset += 1;
    next = billingMonthlyBoundary(reference, resetDay, monthOffset);
  }
  return boundTrafficResetAt(next, expiresAt);
}

function subscriptionTrafficLimit(row: any) {
  return Number(parsePlanSnapshot(row?.planSnapshot)?.trafficLimit ?? row?.planTrafficLimit ?? row?.trafficLimit ?? 0);
}

function sameEpochSecond(left: unknown, right: unknown) {
  const leftDate = validDate(left);
  const rightDate = validDate(right);
  if (!leftDate || !rightDate) return leftDate === rightDate;
  return Math.floor(leftDate.getTime() / 1000) === Math.floor(rightDate.getTime() / 1000);
}

async function updateActiveTrafficAddonCycleEnd(
  subscriptionId: number,
  nextTrafficResetAt: Date | null,
  expiresAt: Date | null,
) {
  const db = await getDb();
  if (!db || subscriptionId <= 0) return;
  const cycleEnd = nextTrafficResetAt || expiresAt;
  await db.update(userTrafficAddons).set({
    cycleResetAt: cycleEnd,
    expiresAt: cycleEnd,
    updatedAt: nowDate(),
  } as any).where(and(
    eq(userTrafficAddons.subscriptionId, subscriptionId),
    eq(userTrafficAddons.status, "active"),
    cycleEnd
      ? or(
        isNull(userTrafficAddons.expiresAt),
        ne(userTrafficAddons.expiresAt, cycleEnd),
        isNull(userTrafficAddons.cycleResetAt),
        ne(userTrafficAddons.cycleResetAt, cycleEnd),
      )
      : or(isNotNull(userTrafficAddons.expiresAt), isNotNull(userTrafficAddons.cycleResetAt)),
  ));
}

async function subscriptionCycleRows(input: { userId?: number; autoResetOnly?: boolean; preserveDue?: boolean } = {}) {
  const db = await getDb();
  if (!db) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const conditions: any[] = [
    eq(userSubscriptions.status, "active"),
    sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
  ];
  if (input.userId !== undefined) conditions.push(eq(userSubscriptions.userId, input.userId));
  if (input.autoResetOnly) conditions.push(eq(users.trafficAutoReset, true));
  return db.select({
    id: userSubscriptions.id,
    userId: userSubscriptions.userId,
    planSnapshot: userSubscriptions.planSnapshot,
    nextTrafficResetAt: userSubscriptions.nextTrafficResetAt,
    lastTrafficResetAt: userSubscriptions.lastTrafficResetAt,
    startedAt: userSubscriptions.startedAt,
    expiresAt: userSubscriptions.expiresAt,
    planTrafficLimit: subscriptionPlans.trafficLimit,
    trafficAutoReset: users.trafficAutoReset,
    trafficResetDay: users.trafficResetDay,
  })
    .from(userSubscriptions)
    .innerJoin(users, eq(userSubscriptions.userId, users.id))
    .leftJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(and(...conditions));
}

/**
 * 这份订阅下一次该在什么时候清流量。
 *
 * 只有一处定义：对齐时按它写库，巡检时也按它判断「要不要进锁」。两边各算一套的话，
 * 迟早出现「巡检说没事、进去之后又改了」或者反过来 —— 而这是计费。
 */
function computeSubscriptionTrafficResetAt(row: any, reference: Date, expiresAt: Date | null) {
  if (subscriptionTrafficLimit(row) <= 0) return null;
  return row.trafficAutoReset
    ? nextConfiguredSubscriptionTrafficReset(row, row, reference, expiresAt)
    : nextAnchoredSubscriptionTrafficReset(row.startedAt, reference, expiresAt);
}

async function alignSubscriptionTrafficCycles(
  reference: Date,
  input: { userId?: number; autoResetOnly?: boolean; preserveDue?: boolean } = {},
) {
  const rows = await subscriptionCycleRows(input);
  let updated = 0;
  for (const row of rows as any[]) {
    const existingResetAt = validDate(row.nextTrafficResetAt);
    if (input.preserveDue && existingResetAt && existingResetAt.getTime() <= reference.getTime()) {
      continue;
    }
    const expiresAt = validDate(row.expiresAt);
    const nextTrafficResetAt = computeSubscriptionTrafficResetAt(row, reference, expiresAt);
    await updateActiveTrafficAddonCycleEnd(Number(row.id), nextTrafficResetAt, expiresAt);
    if (sameEpochSecond(row.nextTrafficResetAt, nextTrafficResetAt)) continue;
    await updateUserSubscription(Number(row.id), { nextTrafficResetAt } as any);
    updated += 1;
  }
  return updated;
}

type ActiveAddonCycle = { cycleResetAt: unknown; expiresAt: unknown };

/** 所有生效中的流量加油包，按订阅归好 —— 一次问清，供巡检在内存里比对。 */
async function activeTrafficAddonCycles(): Promise<Map<number, ActiveAddonCycle[]>> {
  const cycles = new Map<number, ActiveAddonCycle[]>();
  const db = await getDb();
  if (!db) return cycles;
  const rows = await db.select({
    subscriptionId: userTrafficAddons.subscriptionId,
    cycleResetAt: userTrafficAddons.cycleResetAt,
    expiresAt: userTrafficAddons.expiresAt,
  }).from(userTrafficAddons).where(eq(userTrafficAddons.status, "active"));
  for (const row of rows as any[]) {
    const subscriptionId = Number(row.subscriptionId || 0);
    if (subscriptionId <= 0) continue;
    const list = cycles.get(subscriptionId);
    if (list) list.push(row);
    else cycles.set(subscriptionId, [row]);
  }
  return cycles;
}

/**
 * 这份订阅这一轮有没有活可做。
 *
 * 每小时的流量重置巡检原来是**每个用户都进一趟锁**：进去先重新对齐（一次查、一次
 * 几乎必然命中 0 行的 UPDATE），再查一次「有没有到期该充的」，然后绝大多数时候
 * 什么都没做就出来了。实测稳态是精确的 3N + 5 次查询、N 次写 —— 一千个用户就是
 * 每小时三千次白跑的往返，而一个月里七百多次巡检都长这样。
 *
 * 但「有没有活」完全可以在外面那一次全量读里就看出来，判据只有三条：
 *
 *   1. 已经到了该清流量的时刻；
 *   2. 算出来的下次重置时刻和库里存的不一样（比如用户改了重置日）；
 *   3. 名下加油包的周期末尾和订阅对不上。
 *
 * 三条都不成立时，进锁之后那一趟一个字节都不会改 —— 对齐会被 sameEpochSecond 挡下，
 * 加油包那条 UPDATE 的 WHERE 命中 0 行，到期查询返回空。所以这里跳过它是**等价**的，
 * 不是近似。
 *
 * 真要做事的用户仍然照原样进锁、在锁里重新读一遍最新状态再算 —— 这里只负责把
 * 明摆着没事的挑出去，权威计算一步没少。
 */
function subscriptionCycleNeedsWork(row: any, reference: Date, addons: ActiveAddonCycle[] | undefined) {
  const existingResetAt = validDate(row.nextTrafficResetAt);
  if (existingResetAt && existingResetAt.getTime() <= reference.getTime()) return true;

  const expiresAt = validDate(row.expiresAt);
  const nextTrafficResetAt = computeSubscriptionTrafficResetAt(row, reference, expiresAt);
  if (!sameEpochSecond(row.nextTrafficResetAt, nextTrafficResetAt)) return true;

  if (!addons || addons.length === 0) return false;
  const cycleEnd = nextTrafficResetAt || expiresAt;
  return addons.some((addon) =>
    !sameEpochSecond(addon.cycleResetAt, cycleEnd) || !sameEpochSecond(addon.expiresAt, cycleEnd));
}

async function expireTrafficAddonsForSubscriptionIds(subscriptionIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(subscriptionIds.map(Number).filter((id) => id > 0)));
  if (!db || ids.length === 0) return [];
  const now = nowDate();
  const rows = await db
    .select({ userId: userTrafficAddons.userId })
    .from(userTrafficAddons)
    .where(and(
      eq(userTrafficAddons.status, "active"),
      inArray(userTrafficAddons.subscriptionId, ids),
    ));
  await db.update(userTrafficAddons).set({
    status: "expired",
    expiredAt: now,
    updatedAt: now,
  } as any).where(and(
    eq(userTrafficAddons.status, "active"),
    inArray(userTrafficAddons.subscriptionId, ids),
  ));
  return Array.from(new Set((rows as any[]).map((row: any) => Number(row.userId)).filter((id: number) => id > 0)));
}

async function expireTrafficAddonsForSubscriptionCycles(
  cycles: Array<{ id: number; dueBoundary: Date }>,
) {
  const db = await getDb();
  if (!db || cycles.length === 0) return [];
  const now = nowDate();
  const userIds = new Set<number>();
  const boundaryBySubscription = new Map<number, number>();
  for (const cycle of cycles) {
    const id = Number(cycle.id || 0);
    const boundarySec = Math.floor(cycle.dueBoundary.getTime() / 1000);
    if (id <= 0 || !Number.isFinite(boundarySec)) continue;
    boundaryBySubscription.set(id, Math.max(boundaryBySubscription.get(id) ?? Number.NEGATIVE_INFINITY, boundarySec));
  }
  for (const [subscriptionId, boundarySec] of boundaryBySubscription) {
    // createdAt is compared strictly so an add-on bought at or after the cycle
    // boundary belongs to the new cycle, even if another panel instance is
    // still finishing the old one.
    const conditions = and(
      eq(userTrafficAddons.subscriptionId, subscriptionId),
      eq(userTrafficAddons.status, "active"),
      sql`${userTrafficAddons.createdAt} < ${boundarySec}`,
    );
    const rows = await db.select({ userId: userTrafficAddons.userId })
      .from(userTrafficAddons)
      .where(conditions);
    for (const row of rows as any[]) {
      const userId = Number(row.userId || 0);
      if (userId > 0) userIds.add(userId);
    }
    await db.update(userTrafficAddons).set({
      status: "expired",
      expiredAt: now,
      updatedAt: now,
    } as any).where(conditions);
  }
  return Array.from(userIds);
}

export async function expireDueTrafficAddons(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const now = nowDate();
  const nowSec = Math.floor(now.getTime() / 1000);
  const conds: any[] = [
    eq(userTrafficAddons.status, "active"),
    sql`${userTrafficAddons.expiresAt} IS NOT NULL`,
    sql`${userTrafficAddons.expiresAt} <= ${nowSec}`,
  ];
  if (userId !== undefined) conds.push(eq(userTrafficAddons.userId, userId));
  const rows = await db
    .select({ userId: userTrafficAddons.userId })
    .from(userTrafficAddons)
    .where(and(...conds));
  await db.update(userTrafficAddons).set({
    status: "expired",
    expiredAt: now,
    updatedAt: now,
  } as any).where(and(...conds));
  return Array.from(new Set((rows as any[]).map((row: any) => Number(row.userId)).filter((id: number) => id > 0)));
}

async function expireInvalidTrafficAddonsForUser(userId: number, now = nowDate()) {
  const db = await getDb();
  if (!db || userId <= 0) return 0;
  const nowSec = Math.floor(now.getTime() / 1000);
  const rows = await db.select({ id: userTrafficAddons.id })
    .from(userTrafficAddons)
    .innerJoin(userSubscriptions, eq(userTrafficAddons.subscriptionId, userSubscriptions.id))
    .where(and(
      eq(userTrafficAddons.userId, userId),
      eq(userTrafficAddons.status, "active"),
      or(
        ne(userSubscriptions.status, "active"),
        and(
          isNotNull(userSubscriptions.expiresAt),
          sql`${userSubscriptions.expiresAt} <= ${nowSec}`,
        ),
      ),
    ));
  const ids = (rows as any[]).map((row) => Number(row.id || 0)).filter((id) => id > 0);
  if (ids.length === 0) return 0;
  await db.update(userTrafficAddons).set({
    status: "expired",
    expiredAt: now,
    updatedAt: now,
  } as any).where(and(
    eq(userTrafficAddons.status, "active"),
    inArray(userTrafficAddons.id, ids),
  ));
  return ids.length;
}

async function withUserSubscriptionLock<T>(id: number, task: () => Promise<T>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [subscription] = await db.select({
    userId: userSubscriptions.userId,
  }).from(userSubscriptions).where(eq(userSubscriptions.id, id)).limit(1);
  if (!subscription) throw new Error("订阅不存在");
  return withTrafficBillingUserTransaction(Number(subscription.userId), task);
}

export async function cancelUserSubscription(id: number) {
  return withUserSubscriptionLock(id, () => withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const [subscription] = await db.select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
      status: userSubscriptions.status,
    }).from(userSubscriptions).where(eq(userSubscriptions.id, id)).limit(1);
    if (!subscription) throw new Error("订阅不存在");
    if (subscription.status !== "cancelled") {
      await updateUserSubscription(id, { status: "cancelled" } as any);
    }
    await expireTrafficAddonsForSubscriptionIds([id]);
    const limits = await syncUserSubscriptionEntitlements(Number(subscription.userId));
    return {
      id: Number(subscription.id),
      userId: Number(subscription.userId),
      trafficLimit: limits.trafficLimit,
    };
  }));
}

export async function dismissCancelledUserSubscription(input: {
  id: number;
  viewerUserId: number;
  isAdmin: boolean;
}) {
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const [subscription] = await db.select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
      status: userSubscriptions.status,
    }).from(userSubscriptions).where(eq(userSubscriptions.id, input.id)).limit(1);
    if (!subscription) throw new Error("订阅不存在");
    if (subscription.status !== "cancelled") throw new Error("只能删除已取消的订阅记录");
    if (!input.isAdmin && Number(subscription.userId) !== Number(input.viewerUserId)) {
      throw new Error("无权删除该订阅记录");
    }

    const dismissedAt = nowDate();
    await db.update(userSubscriptions).set(input.isAdmin
      ? { adminDismissedAt: dismissedAt, updatedAt: dismissedAt } as any
      : { userDismissedAt: dismissedAt, updatedAt: dismissedAt } as any)
      .where(eq(userSubscriptions.id, input.id));
    return { id: Number(subscription.id), userId: Number(subscription.userId) };
  });
}

async function setUserSubscriptionExpiresAtUnlocked(id: number, expiresAt: Date | null) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(userSubscriptions).where(eq(userSubscriptions.id, id)).limit(1);
  const subscription = rows[0] as any;
  if (!subscription) throw new Error("订阅不存在");
  if (subscription.status === "cancelled") throw new Error("已取消的订阅不能更改到期时间");
  const nextExpiresAt = expiresAt ? new Date(expiresAt) : null;
  if (nextExpiresAt && !Number.isFinite(nextExpiresAt.getTime())) throw new Error("到期时间无效");
  const now = nowDate();
  const expired = !!nextExpiresAt && nextExpiresAt.getTime() <= now.getTime();
  let nextTrafficResetAt = subscription.nextTrafficResetAt ? new Date(subscription.nextTrafficResetAt) : null;
  const plan = await getSubscriptionPlanById(Number(subscription.planId));
  const user = await getUserById(Number(subscription.userId));
  const subscriptionSnapshot = parsePlanSnapshot((subscription as any).planSnapshot);
  const subscriptionTrafficLimit = Number(subscriptionSnapshot?.trafficLimit ?? plan?.trafficLimit ?? 0);
  if (subscriptionTrafficLimit > 0 && !expired) {
    if ((user as any)?.trafficAutoReset) {
      nextTrafficResetAt = nextConfiguredSubscriptionTrafficReset(user as any, subscription, now, nextExpiresAt);
    } else if (
      !nextTrafficResetAt ||
      !Number.isFinite(nextTrafficResetAt.getTime()) ||
      nextTrafficResetAt.getTime() <= now.getTime() ||
      (nextExpiresAt && nextTrafficResetAt.getTime() >= nextExpiresAt.getTime())
    ) {
      nextTrafficResetAt = nextBillingMonthlyTrafficReset(now, nextExpiresAt);
    }
    if (nextTrafficResetAt && nextExpiresAt && nextTrafficResetAt.getTime() >= nextExpiresAt.getTime()) {
      nextTrafficResetAt = null;
    }
  } else {
    nextTrafficResetAt = null;
  }
  await updateUserSubscription(id, {
    status: expired ? "expired" : "active",
    expiresAt: nextExpiresAt,
    nextTrafficResetAt,
  } as any);
  await updateActiveTrafficAddonCycleEnd(id, nextTrafficResetAt, nextExpiresAt);
  if (expired) await expireTrafficAddonsForSubscriptionIds([id]);
  const limits = await syncUserSubscriptionEntitlements(Number(subscription.userId));
  return {
    id,
    userId: Number(subscription.userId),
    expiresAt: nextExpiresAt,
    nextTrafficResetAt,
    trafficLimit: limits.trafficLimit,
  };
}

export async function setUserSubscriptionExpiresAt(id: number, expiresAt: Date | null) {
  return withUserSubscriptionLock(id, () => withDatabaseTransaction(
    () => setUserSubscriptionExpiresAtUnlocked(id, expiresAt),
  ));
}

async function extendUserSubscriptionUnlocked(id: number, days: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const extraDays = Math.floor(Number(days || 0));
  if (!Number.isFinite(extraDays) || extraDays <= 0) throw new Error("延长天数必须大于 0");
  const rows = await db.select().from(userSubscriptions).where(eq(userSubscriptions.id, id)).limit(1);
  const subscription = rows[0] as any;
  if (!subscription) throw new Error("订阅不存在");
  if (subscription.status === "cancelled") throw new Error("已取消的订阅不能延长");
  if (!subscription.expiresAt) throw new Error("永久订阅无需延长");
  const now = nowDate();
  const currentExpiresAt = new Date(subscription.expiresAt);
  const base = Number.isFinite(currentExpiresAt.getTime()) && currentExpiresAt.getTime() > now.getTime()
    ? currentExpiresAt
    : now;
  const expiresAt = new Date(base.getTime() + extraDays * 24 * 3600 * 1000);
  let nextTrafficResetAt = subscription.nextTrafficResetAt ? new Date(subscription.nextTrafficResetAt) : null;
  const plan = await getSubscriptionPlanById(Number(subscription.planId));
  const user = await getUserById(Number(subscription.userId));
  const subscriptionSnapshot = parsePlanSnapshot((subscription as any).planSnapshot);
  const subscriptionTrafficLimit = Number(subscriptionSnapshot?.trafficLimit ?? plan?.trafficLimit ?? 0);
  if (subscriptionTrafficLimit > 0) {
    if ((user as any)?.trafficAutoReset) {
      nextTrafficResetAt = nextConfiguredSubscriptionTrafficReset(user as any, subscription, now, expiresAt);
    } else if (!nextTrafficResetAt || !Number.isFinite(nextTrafficResetAt.getTime()) || nextTrafficResetAt.getTime() <= now.getTime()) {
      nextTrafficResetAt = nextBillingMonthlyTrafficReset(now, expiresAt);
    }
    if (nextTrafficResetAt && nextTrafficResetAt.getTime() >= expiresAt.getTime()) nextTrafficResetAt = null;
  } else {
    nextTrafficResetAt = null;
  }
  await updateUserSubscription(id, {
    status: "active",
    expiresAt,
    nextTrafficResetAt,
  } as any);
  await updateActiveTrafficAddonCycleEnd(id, nextTrafficResetAt, expiresAt);
  const limits = await syncUserSubscriptionEntitlements(Number(subscription.userId));
  return {
    id,
    userId: Number(subscription.userId),
    expiresAt,
    nextTrafficResetAt,
    trafficLimit: limits.trafficLimit,
  };
}

/**
 * 到期前用余额自动续一期。
 *
 * 「到期 → 断服 → 客户发现 → 手工去付 → 等回调」这一串每一步都在掉人，而余额
 * 本来就躺在账上。所以在到期清扫**之前**跑这一遍：开了自动续费、余额够、套餐
 * 还在上架的，直接扣款续期。
 *
 * 三条自我约束：
 * - 只提前一天内续，不提前太多 —— 提前半个月扣钱，客户会觉得是乱扣。
 * - 扣不动就安静跳过，让它照常到期；不重试、不写日志刷屏。失败本身会被到期
 *   提醒兜住（那条提醒已经发过了）。
 * - 每天每条订阅只试一次，靠 system_settings 里的日键去重 —— 调度器是几分钟
 *   一轮，不去重就会在余额不足时每轮都撞一次数据库。
 */
export async function runSubscriptionAutoRenew(): Promise<{ renewed: number; failed: number }> {
  const db = await getDb();
  if (!db) return { renewed: 0, failed: 0 };
  const now = Date.now();
  const horizonSec = Math.floor((now + 24 * 60 * 60 * 1000) / 1000);
  const rows = await db
    .select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
      planId: userSubscriptions.planId,
      durationDays: userSubscriptions.durationDays,
      expiresAt: userSubscriptions.expiresAt,
    })
    .from(userSubscriptions)
    .where(and(
      eq(userSubscriptions.status, "active"),
      eq(userSubscriptions.autoRenew, true),
      isNotNull(userSubscriptions.expiresAt),
      sql`${userSubscriptions.expiresAt} <= ${horizonSec}`,
    ));

  let renewed = 0;
  let failed = 0;
  for (const row of rows as any[]) {
    const subscriptionId = Number(row.id);
    const dayKey = `autoRenew:${subscriptionId}:${new Date(now).toISOString().slice(0, 10)}`;
    if (await getSetting(dayKey)) continue;
    await setSetting(dayKey, "tried");
    try {
      const plan = await getSubscriptionPlanById(Number(row.planId));
      if (!plan || !plan.isActive || !plan.isStoreVisible) continue;
      /**
       * 续**上次买的那一档**。
       *
       * 按月付的人不该某天醒来发现被扣了一年的钱；反过来，按年付的人也不该被悄悄
       * 降成月付。那一档被管理员下掉了才退回默认档，并且写一行日志说清楚 ——
       * 否则「为什么这次扣的钱不一样」查无对证。
       */
      const options = planPricingOptions(plan as any, (plan as any).priceTiers || []);
      const { option, fellBack } = renewalPricingOption(options, row.durationDays);
      if (!option) continue;
      if (fellBack) {
        console.warn(`[Billing] Auto-renew tier ${row.durationDays} gone for plan=${row.planId}, falling back to ${option.durationDays}d`);
      }
      const user = await getUserById(Number(row.userId));
      const balance = Number((user as any)?.balanceCents || 0);
      if (balance < Number(option.priceCents || 0)) {
        failed += 1;
        continue;
      }
      await purchasePlanWithBalance(Number(row.userId), Number(row.planId), null, subscriptionId, option.durationDays);
      renewed += 1;
      console.log(`[Billing] Auto-renewed subscription=${subscriptionId} user=${row.userId} plan=${row.planId} duration=${option.durationDays}`);
    } catch (error) {
      failed += 1;
      console.warn(`[Billing] Auto-renew failed subscription=${subscriptionId}:`, error instanceof Error ? error.message : error);
    }
  }
  return { renewed, failed };
}

/** 用户自己开关自动续费。只能改自己的那条。 */
export async function setUserSubscriptionAutoRenew(
  subscriptionId: number,
  userId: number,
  autoRenew: boolean,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: userSubscriptions.id })
    .from(userSubscriptions)
    .where(and(eq(userSubscriptions.id, Number(subscriptionId)), eq(userSubscriptions.userId, Number(userId))))
    .limit(1);
  if (!rows[0]) return false;
  await db
    .update(userSubscriptions)
    .set({ autoRenew: !!autoRenew, updatedAt: nowDate() } as any)
    .where(eq(userSubscriptions.id, Number(subscriptionId)));
  return true;
}

export async function expireUserSubscriptions() {
  const db = await getDb();
  if (!db) return 0;
  const now = nowDate();
  const nowSec = Math.floor(now.getTime() / 1000);
  const [subscriptionCandidates, addonCandidates] = await Promise.all([
    db.select({ userId: userSubscriptions.userId })
      .from(userSubscriptions)
      .where(and(
        eq(userSubscriptions.status, "active"),
        isNotNull(userSubscriptions.expiresAt),
        sql`${userSubscriptions.expiresAt} <= ${nowSec}`,
      )),
    db.select({ userId: userTrafficAddons.userId })
      .from(userTrafficAddons)
      .innerJoin(userSubscriptions, eq(userTrafficAddons.subscriptionId, userSubscriptions.id))
      .where(and(
        eq(userTrafficAddons.status, "active"),
        or(
          and(
            isNotNull(userTrafficAddons.expiresAt),
            sql`${userTrafficAddons.expiresAt} <= ${nowSec}`,
          ),
          ne(userSubscriptions.status, "active"),
          and(
            isNotNull(userSubscriptions.expiresAt),
            sql`${userSubscriptions.expiresAt} <= ${nowSec}`,
          ),
        ),
      )),
  ]);
  const userIds = Array.from(new Set([
    ...(subscriptionCandidates as any[]).map((row) => Number(row.userId || 0)),
    ...(addonCandidates as any[]).map((row) => Number(row.userId || 0)),
  ].filter((userId) => userId > 0)));
  const addonCandidateUserIds = new Set(
    (addonCandidates as any[])
      .map((row) => Number(row.userId || 0))
      .filter((userId) => userId > 0),
  );
  let expiredCount = 0;
  for (const userId of userIds) {
    await withTrafficBillingUserLock(userId, async () => {
      const outcome = await withDatabaseTransaction(async () => {
        await lockTrafficBillingUserRow(userId);
        const txDb = await getDb();
        if (!txDb) throw new Error("Database not available");
        const rules = await getForwardRulesForUserSync(userId);
        const userBeforeSync = await getUserById(userId);
        const dueRows = await txDb.select({ id: userSubscriptions.id })
          .from(userSubscriptions)
          .where(and(
            eq(userSubscriptions.userId, userId),
            eq(userSubscriptions.status, "active"),
            isNotNull(userSubscriptions.expiresAt),
            sql`${userSubscriptions.expiresAt} <= ${nowSec}`,
          ));
        const expiredSubscriptionIds: number[] = [];
        for (const row of dueRows as any[]) {
          const id = Number(row.id || 0);
          if (id <= 0) continue;
          const result = await executeRaw(
            `UPDATE ${quoteDbIdentifier("user_subscriptions")}
             SET ${quoteDbIdentifier("status")} = 'expired', ${quoteDbIdentifier("updatedAt")} = ?
             WHERE ${quoteDbIdentifier("id")} = ?
               AND ${quoteDbIdentifier("userId")} = ?
               AND ${quoteDbIdentifier("status")} = 'active'
               AND ${quoteDbIdentifier("expiresAt")} IS NOT NULL
               AND ${quoteDbIdentifier("expiresAt")} <= ?`,
            [nowSec, id, userId, nowSec],
          );
          if (rawAffectedRows(result) > 0) expiredSubscriptionIds.push(id);
        }

        await expireDueTrafficAddons(userId);
        await expireTrafficAddonsForSubscriptionIds(expiredSubscriptionIds);
        await expireInvalidTrafficAddonsForUser(userId, now);
        const limits = await syncUserSubscriptionEntitlementsUnlocked(userId);
        const active = await getActiveUserSubscriptions(userId);
        const accessBecameDisabled = !!(userBeforeSync as any)?.canAddRules && !limits.canAddRules;
        return {
          expiredCount: expiredSubscriptionIds.length,
          rules,
          // Even when another subscription remains active, the resource ACL
          // may have changed. Invalidate the Agent's stable heartbeat plan so
          // it gates and removes rules that belonged only to the expired
          // subscription. Add-on expiry can also cross the traffic limit and
          // therefore needs the same runtime refresh.
          shouldRefreshRuntime: expiredSubscriptionIds.length > 0 || addonCandidateUserIds.has(userId),
          shouldResetRuntime: active.length === 0 || accessBecameDisabled,
        };
      });
      expiredCount += outcome.expiredCount;
      if (!outcome.shouldRefreshRuntime) return;

      if (outcome.shouldResetRuntime) {
        await resetForwardRulesForUserSync(userId);
      }
      const hostIds = new Set<number>();
      const tunnelIds = new Set<number>();
      for (const rule of outcome.rules as any[]) {
        if (rule.hostId) hostIds.add(Number(rule.hostId));
        if (rule.tunnelId) tunnelIds.add(Number(rule.tunnelId));
      }
      for (const tunnelId of tunnelIds) {
        const tunnel = await getTunnelById(tunnelId);
        if (tunnel) {
          await updateTunnel(tunnelId, { isRunning: false } as any);
          hostIds.add(Number(tunnel.entryHostId));
          hostIds.add(Number(tunnel.exitHostId));
        }
      }
      for (const hostId of hostIds) {
        if (hostId > 0) pushAgentRefresh(hostId, "subscription-expired");
      }
    });
  }
  return expiredCount;
}

export async function getEffectiveUserPlanLimits(userId: number) {
  const active = await getActiveUserSubscriptions(userId);
  if (active.length === 0) {
    return {
      canAddRules: false,
      allowForwardXTunnel: false,
      allowProxySubscription: false,
      maxPorts: 0,
      maxRules: 0,
      maxProxyInbounds: 0,
      maxProxySubTokens: 0,
      maxProxyDevices: 0,
      maxConnections: 0,
      maxIPs: 0,
      baseTrafficLimit: 0,
      addonTrafficLimit: 0,
      trafficLimit: 0,
      gostRateLimitIn: 0,
      gostRateLimitOut: 0,
      expiresAt: null as Date | null,
    };
  }

  let expiresAt: Date | null = null;
  const maxOf = (field: string) => Math.max(...active.map((sub: any) => Number(sub[field] || 0)));
  const sumWithUnlimited = (field: string) => {
    if (active.some((sub: any) => Number(sub[field] || 0) === 0)) return 0;
    return active.reduce((total, sub: any) => total + Math.max(0, Number(sub[field] || 0)), 0);
  };
  for (const sub of active as any[]) {
    const subExpiresAt = sub.expiresAt ? new Date(sub.expiresAt) : null;
    if (!subExpiresAt) {
      expiresAt = null;
      break;
    }
    if (!expiresAt || subExpiresAt.getTime() > expiresAt.getTime()) expiresAt = subExpiresAt;
  }

  const hasUnlimitedTraffic = (active as any[]).some((sub: any) => Number(sub.trafficLimit || 0) === 0);
  const baseTrafficLimit = hasUnlimitedTraffic
    ? 0
    : active.reduce((total, sub: any) => total + Math.max(0, Number(sub.trafficLimit || 0)), 0);
  const addonTrafficLimit = baseTrafficLimit > 0 ? await getActiveUserTrafficAddonBytes(userId) : 0;

  return {
    canAddRules: true,
    allowForwardXTunnel: true,
    // 与 canAddRules 不同：客户端订阅要套餐显式开启，不是有订阅就给。
    allowProxySubscription: (active as any[]).some((sub: any) => !!sub.allowProxySubscription),
    maxPorts: sumWithUnlimited("portCount"),
    maxRules: sumWithUnlimited("maxRules"),
    maxProxyInbounds: sumWithUnlimited("maxProxyInbounds"),
    maxProxySubTokens: sumWithUnlimited("maxProxySubTokens"),
    maxProxyDevices: sumWithUnlimited("maxProxyDevices"),
    maxConnections: sumWithUnlimited("maxConnections"),
    maxIPs: sumWithUnlimited("maxIPs"),
    baseTrafficLimit,
    addonTrafficLimit,
    trafficLimit: baseTrafficLimit > 0 ? baseTrafficLimit + addonTrafficLimit : baseTrafficLimit,
    gostRateLimitIn: maxOf("rateLimitMbps"),
    gostRateLimitOut: maxOf("rateLimitMbps"),
    expiresAt,
  };
}

function normalizeForwardAccessPauseReason(value: unknown): ForwardAccessPauseReason {
  const reason = String(value || "").trim();
  if (reason === "manual" || reason === "traffic_billing_balance" || reason === "traffic_limit" || reason === "expired") {
    return reason;
  }
  return null;
}

function isExpiredAt(value: unknown) {
  return !!value && new Date(value as any).getTime() <= Date.now();
}

function isTrafficLimitExceeded(trafficUsed: unknown, trafficLimit: unknown) {
  const limit = Number(trafficLimit || 0);
  return limit > 0 && Number(trafficUsed || 0) >= limit;
}

function positiveInt(value: unknown) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function mergeLimitValue(sources: Array<{ active: boolean; value: unknown }>) {
  let hasSource = false;
  let max = 0;
  for (const source of sources) {
    if (!source.active) continue;
    hasSource = true;
    const value = positiveInt(source.value);
    if (value === 0) return 0;
    max = Math.max(max, value);
  }
  return hasSource ? max : 0;
}

function latestExpiresAtValue(sources: Array<{ active: boolean; value: unknown }>): Date | null {
  let latest: Date | null = null;
  for (const source of sources) {
    if (!source.active) continue;
    if (!source.value) return null;
    const date = new Date(source.value as any);
    if (!Number.isFinite(date.getTime())) continue;
    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

export function mergeManualAndPlanLimits(user: any, planLimits: any) {
  const manualCanAddRules = !!user?.manualCanAddRules;
  const planCanAddRules = !!planLimits?.canAddRules;
  const manualAllowForwardXTunnel = !!user?.manualAllowForwardXTunnel;
  const planAllowForwardXTunnel = !!planLimits?.allowForwardXTunnel;
  const manualAllowProxySubscription = !!user?.manualAllowProxySubscription;
  const planAllowProxySubscription = !!planLimits?.allowProxySubscription;
  const manualDefaultActive = manualCanAddRules && !planCanAddRules;
  const manualMaxRules = positiveInt(user?.manualMaxRules);
  const manualMaxProxyInbounds = positiveInt(user?.manualMaxProxyInbounds);
  const manualMaxProxySubTokens = positiveInt(user?.manualMaxProxySubTokens);
  const manualMaxProxyDevices = positiveInt(user?.manualMaxProxyDevices);
  const manualMaxPorts = positiveInt(user?.manualMaxPorts);
  const manualMaxConnections = positiveInt(user?.manualMaxConnections);
  const manualMaxIPs = positiveInt(user?.manualMaxIPs);
  const manualTrafficLimit = positiveInt(user?.manualTrafficLimit);
  const manualGostRateLimitIn = positiveInt(user?.manualGostRateLimitIn);
  const manualGostRateLimitOut = positiveInt(user?.manualGostRateLimitOut);
  const planBaseTrafficLimit = positiveInt(
    planLimits?.baseTrafficLimit === undefined
      ? planLimits?.trafficLimit
      : planLimits.baseTrafficLimit,
  );
  const addonTrafficLimit = planCanAddRules ? positiveInt(planLimits?.addonTrafficLimit) : 0;
  const baseTrafficLimit = mergeLimitValue([
    { active: planCanAddRules, value: planBaseTrafficLimit },
    { active: manualDefaultActive || manualTrafficLimit > 0, value: manualTrafficLimit },
  ]);
  return {
    canAddRules: manualCanAddRules || planCanAddRules,
    allowForwardXTunnel: manualAllowForwardXTunnel || planAllowForwardXTunnel,
    allowProxySubscription: manualAllowProxySubscription || planAllowProxySubscription,
    maxPorts: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.maxPorts },
      { active: manualDefaultActive || manualMaxPorts > 0, value: manualMaxPorts },
    ]),
    maxRules: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.maxRules },
      { active: manualDefaultActive || manualMaxRules > 0, value: manualMaxRules },
    ]),
    /**
     * 自建落地节点数。套餐那一侧按**订阅权限**开闸，不是按转发权限 ——
     * 这是订阅那一套的配额，一个只买了转发、没买订阅的套餐不该顺带给出落地节点额度。
     *
     * 手动那一侧沿用其他配额的规矩：管理员填了数就算数。
     */
    maxProxyInbounds: mergeLimitValue([
      { active: planAllowProxySubscription, value: planLimits?.maxProxyInbounds },
      { active: manualMaxProxyInbounds > 0, value: manualMaxProxyInbounds },
    ]),
    /** 订阅地址条数。同样按订阅权限开闸，与 maxProxyInbounds 一套规矩。 */
    maxProxySubTokens: mergeLimitValue([
      { active: planAllowProxySubscription, value: planLimits?.maxProxySubTokens },
      { active: manualMaxProxySubTokens > 0, value: manualMaxProxySubTokens },
    ]),
    maxProxyDevices: mergeLimitValue([
      { active: planAllowProxySubscription, value: planLimits?.maxProxyDevices },
      { active: manualMaxProxyDevices > 0, value: manualMaxProxyDevices },
    ]),
    maxConnections: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.maxConnections },
      { active: manualDefaultActive || manualMaxConnections > 0, value: manualMaxConnections },
    ]),
    maxIPs: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.maxIPs },
      { active: manualDefaultActive || manualMaxIPs > 0, value: manualMaxIPs },
    ]),
    trafficLimit: baseTrafficLimit > 0 ? baseTrafficLimit + addonTrafficLimit : baseTrafficLimit,
    gostRateLimitIn: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.gostRateLimitIn },
      { active: manualDefaultActive || manualGostRateLimitIn > 0, value: manualGostRateLimitIn },
    ]),
    gostRateLimitOut: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.gostRateLimitOut },
      { active: manualDefaultActive || manualGostRateLimitOut > 0, value: manualGostRateLimitOut },
    ]),
    expiresAt: latestExpiresAtValue([
      { active: planCanAddRules, value: planLimits?.expiresAt },
      { active: manualDefaultActive || !!user?.manualExpiresAt, value: user?.manualExpiresAt },
    ]),
  };
}

export type ForwardAccessCheckResult = {
  allowed: boolean;
  restored: boolean;
  user: any | null;
  restoredRuleIds?: number[];
  reason?: ForwardAccessPauseReason | "not_found" | "no_access";
  message?: string;
};

async function restoreUserForwardRulesIfEligible(userId: number) {
  const user = await getUserById(userId) as any;
  if (
    !user
    || user.accountEnabled === false
    || !user.canAddRules
    || String(user.forwardAccessPauseReason || "").trim()
  ) {
    return { affectedRuleIds: [] as number[], restoredRuleIds: [] as number[], forwardGroupIds: [] as number[] };
  }
  const affectedRuleIds = await getUserForwardRuleIdsDisabledByAccess(userId);
  if (affectedRuleIds.length === 0) {
    return { affectedRuleIds, restoredRuleIds: [] as number[], forwardGroupIds: [] as number[] };
  }
  const recovery = await scheduleUserForwardRulesAfterAccessRecovery(userId);
  return {
    affectedRuleIds,
    restoredRuleIds: recovery?.enabledRuleIds ?? [],
    forwardGroupIds: [] as number[],
  };
}

export async function extendUserSubscription(id: number, days: number) {
  return withUserSubscriptionLock(id, () => withDatabaseTransaction(
    () => extendUserSubscriptionUnlocked(id, days),
  ));
}

async function recoverUserForwardAccessIfEligibleUnlocked(
  userId: number,
  options: { allowTrafficBillingRecovery?: boolean } = {},
): Promise<ForwardAccessCheckResult> {
  await expireDueTrafficAddons(userId);
  const user = await getUserById(userId);
  if (!user) {
    return { allowed: false, restored: false, user: null, reason: "not_found", message: "用户不存在" };
  }
  if ((user as any).role === "admin") {
    return { allowed: true, restored: false, user };
  }

  const pauseReason = normalizeForwardAccessPauseReason((user as any).forwardAccessPauseReason);
  if (pauseReason === "manual") {
    return {
      allowed: false,
      restored: false,
      user,
      reason: "manual",
      message: "转发权限已由管理员暂停，请联系管理员开启",
    };
  }

  const limits = await getEffectiveUserPlanLimits(userId);
  const billingResources = await getUserUsableTrafficBillingResourceIds(userId);
  const effectiveLimits = mergeManualAndPlanLimits(user, limits);
  const hasTrafficBillingResource = billingResources.hostIds.length > 0 || billingResources.tunnelIds.length > 0 || billingResources.forwardGroupIds.length > 0;
  const hasTrafficBillingBalance = Number((user as any).balanceCents || 0) > 0;
  // 只有转发权限完全来自流量计费的人，余额不足才整户暂停。有套餐 / 手动权限的人
  // 继续往下走（旧版本留下的整户暂停在这里撤掉），计费资源上的规则由
  // reconcileTrafficBillingRuleBlocks 单独停。
  if (pauseReason === "traffic_billing_balance" && hasTrafficBillingResource && !hasTrafficBillingBalance && !effectiveLimits.canAddRules) {
    return {
      allowed: false,
      restored: false,
      user,
      reason: "traffic_billing_balance",
      message: "流量计费余额不足，请充值后再启用规则",
    };
  }

  if (effectiveLimits.canAddRules) {
    if (isTrafficLimitExceeded((user as any).trafficUsed, effectiveLimits.trafficLimit)) {
      if (options.allowTrafficBillingRecovery && hasTrafficBillingResource && hasTrafficBillingBalance) {
        // 套餐流量已经用完，这次操作走的是按流量计费的资源：只放行这一次计费操作。
        // 以前这里会撤掉「超额」暂停并恢复所有因超额停下的规则 —— 包括不计费、吃套餐
        // 额度的规则，等于有一点余额就能把用完的套餐额度继续白跑。套餐规则要一直停到
        // 额度重置 / 换套餐 / 买流量包；账户上的超额暂停也留着（还没暂停的这里补上，
        // 与下面不走计费的分支一致），计费规则的流量本来就不记进套餐额度，不受这个暂停影响。
        if ((user as any).canAddRules || pauseReason !== "traffic_limit") {
          await setUserForwardAccess(userId, false, "traffic_limit");
        }
        return {
          allowed: true,
          restored: false,
          user: await getUserById(userId) ?? user,
        };
      }
      if ((user as any).canAddRules || pauseReason !== "traffic_limit") {
        await setUserForwardAccess(userId, false, "traffic_limit");
      }
      return {
        allowed: false,
        restored: false,
        user: await getUserById(userId) ?? user,
        reason: "traffic_limit",
        message: "套餐流量已用完，请购买附加流量包或等待下个周期重置后再启用规则",
      };
    }

    let restored = !(user as any).canAddRules || !!pauseReason;
    await updateUserTrafficSettings(userId, {
      ...effectiveLimits,
      canAddRules: true,
      allowForwardXTunnel: true,
      forwardAccessPauseReason: null,
    });
    const ruleRecovery = await restoreUserForwardRulesIfEligible(userId);
    restored = restored || ruleRecovery.affectedRuleIds.length > 0;
    return {
      allowed: true,
      restored,
      restoredRuleIds: ruleRecovery.restoredRuleIds,
      user: await getUserById(userId) ?? user,
    };
  }

  if (isExpiredAt((user as any).expiresAt) && !hasTrafficBillingResource) {
    if ((user as any).canAddRules || pauseReason !== "expired") {
      await setUserForwardAccess(userId, false, "expired");
    }
    return {
      allowed: false,
      restored: false,
      user: await getUserById(userId) ?? user,
      reason: "expired",
      message: "账户已到期，请续费后再启用规则",
    };
  }

  if (hasTrafficBillingResource) {
    if (hasTrafficBillingBalance) {
      let restored = !(user as any).canAddRules || !!pauseReason;
      await updateUserTrafficSettings(userId, {
        canAddRules: true,
        allowForwardXTunnel: true,
        expiresAt: null,
        trafficLimit: 0,
        forwardAccessPauseReason: null,
      });
      const ruleRecovery = await restoreUserForwardRulesIfEligible(userId);
      restored = restored || ruleRecovery.affectedRuleIds.length > 0;
      return {
        allowed: true,
        restored,
        restoredRuleIds: ruleRecovery.restoredRuleIds,
        user: await getUserById(userId) ?? user,
      };
    }
    if ((user as any).canAddRules || pauseReason !== "traffic_billing_balance") {
      await setUserForwardAccess(userId, false, "traffic_billing_balance");
    }
    return {
      allowed: false,
      restored: false,
      user: await getUserById(userId) ?? user,
      reason: "traffic_billing_balance",
      message: "流量计费余额不足，请充值后再启用规则",
    };
  }

  // canAddRules may have been granted temporarily by traffic billing. Once no
  // usable billing resource remains, rebuild it from manual/subscription data.
  const baseline = await syncUserSubscriptionEntitlementsUnlocked(userId);
  const baselineUser = await getUserById(userId) ?? user;
  if (baseline.canAddRules) {
    return {
      allowed: true,
      restored: baseline.restoredRuleIds.length > 0,
      restoredRuleIds: baseline.restoredRuleIds,
      user: baselineUser,
    };
  }
  return {
    allowed: false,
    restored: false,
    user: baselineUser,
    reason: "no_access",
    message: "转发权限已暂停，请续费后再启用规则",
  };
}

export async function recoverUserForwardAccessIfEligible(
  userId: number,
  options: { allowTrafficBillingRecovery?: boolean } = {},
) {
  const result = await withTrafficBillingUserTransaction(
    userId,
    () => recoverUserForwardAccessIfEligibleUnlocked(userId, options),
  );
  // Recovery notifications are deferred while the billing transaction still
  // owns the per-user lock. Once the outer transaction has settled, run one
  // serialized pass so callers immediately observe the new rule state instead
  // of racing the queued after-commit task.
  if (!isDatabaseTransactionActive() && result.allowed) {
    const { reconcileTrafficBillingRuleBlocks } = await import("../trafficBillingRuleBlock");
    const recovery = await withTrafficBillingUserLock(userId, async () => {
      // 先处理余额：没余额时先给计费资源上的规则打上原因，下面的账户恢复就不会把它们带起来。
      const billingRuleIds = await reconcileTrafficBillingRuleBlocks(userId);
      const accessRecovery = await restoreUserForwardRulesAfterAccessRecovery(userId);
      return [...billingRuleIds, ...accessRecovery.enabledRuleIds];
    });
    if (recovery.length > 0) {
      return {
        ...result,
        restored: true,
        restoredRuleIds: Array.from(new Set([
          ...(result.restoredRuleIds || []),
          ...recovery,
        ])),
      };
    }
  }
  return result;
}

export async function ensureUserForwardAccessReady(userId: number, options?: { allowTrafficBillingRecovery?: boolean }) {
  return recoverUserForwardAccessIfEligible(userId, options);
}

async function syncUserSubscriptionEntitlementsUnlocked(
  userId: number,
  options: { deferRuleRecovery?: boolean } = {},
) {
  await expireDueTrafficAddons(userId);
  const limits = await getEffectiveUserPlanLimits(userId);
  const user = await getUserById(userId);
  const pauseReason = normalizeForwardAccessPauseReason((user as any)?.forwardAccessPauseReason);
  const effectiveLimits = mergeManualAndPlanLimits(user, limits);
  const trafficExceeded = effectiveLimits.canAddRules && isTrafficLimitExceeded((user as any)?.trafficUsed, effectiveLimits.trafficLimit);
  const manualPaused = pauseReason === "manual";
  const nextLimits = {
    ...effectiveLimits,
    canAddRules: effectiveLimits.canAddRules && !manualPaused && !trafficExceeded,
    allowForwardXTunnel: effectiveLimits.allowForwardXTunnel && !manualPaused && !trafficExceeded,
    // 超流量时转发已被停用，订阅里的节点本就连不通，权限一并收回避免给出死节点。
    allowProxySubscription: effectiveLimits.allowProxySubscription && !manualPaused && !trafficExceeded,
    forwardAccessPauseReason: (effectiveLimits.canAddRules && !manualPaused && !trafficExceeded
      ? null
      : manualPaused
      ? "manual"
      : trafficExceeded
      ? "traffic_limit"
      : pauseReason) as ForwardAccessPauseReason,
  };
  await updateUserTrafficSettings(userId, nextLimits);
  /**
   * 套餐附带的落地节点在这里对账 —— 这个函数是「重算这个人的权益」的总入口，
   * 下单、后台分配、改套餐、到期清扫都会走到，挂在这里就不必每条路各记一遍。
   *
   * 只有还有客户端订阅权限的人才发凭据：权限没了（到期、超流量、管理员收回）
   * 就一并收回，省得订阅地址已经拉不动了，手上那份凭据还连得上。
   */
  const { syncPlanProxyNodeSharesForUser } = await import("./proxySubscriptionRepository");
  await syncPlanProxyNodeSharesForUser(
    userId,
    String((user as any)?.username || (user as any)?.name || "") || undefined,
    { allowed: !!nextLimits.allowProxySubscription },
  );
  let restoredRuleIds: number[] = [];
  if (!nextLimits.canAddRules) {
    await disableAllUserRules(userId);
  } else if (!options.deferRuleRecovery) {
    const ruleRecovery = await restoreUserForwardRulesIfEligible(userId);
    restoredRuleIds = ruleRecovery.restoredRuleIds;
  }
  return { ...nextLimits, restoredRuleIds };
}

export async function syncUserSubscriptionEntitlements(
  userId: number,
  options: { deferRuleRecovery?: boolean } = {},
) {
  return withTrafficBillingUserTransaction(
    userId,
    () => syncUserSubscriptionEntitlementsUnlocked(userId, options),
  );
}

export async function updateUserManualEntitlements(userId: number, data: {
  manualTrafficLimit?: number;
  manualGostRateLimitIn?: number;
  manualGostRateLimitOut?: number;
  manualExpiresAt?: Date | null;
  manualCanAddRules?: boolean;
  manualMaxRules?: number;
  manualMaxPorts?: number;
  manualMaxConnections?: number;
  manualMaxIPs?: number;
  manualAllowForwardXTunnel?: boolean;
  allowedForwardTypes?: string | null;
  displayRemark?: string | null;
  trafficAutoReset?: boolean;
  trafficResetDay?: number;
  forwardAccessPauseReason?: ForwardAccessPauseReason;
  /**
   * 自助能加几台机器。0 = 跟随系统设置的全局上限，不是「不限」。
   *
   * 不带 manual 前缀：上面那些是「手工额度」，要和套餐给的额度算优先级；
   * 这一项套餐不给，就是一个普通设置，没有两份来源要合。
   */
  maxSelfServiceHosts?: number | null;
}) {
  return withTrafficBillingUserTransaction(userId, async () => {
    await updateUserTrafficSettings(userId, data as any);
    if (
      Object.prototype.hasOwnProperty.call(data, "trafficAutoReset") ||
      Object.prototype.hasOwnProperty.call(data, "trafficResetDay")
    ) {
      await alignSubscriptionTrafficCycles(nowDate(), { userId });
    }
    return syncUserSubscriptionEntitlementsUnlocked(userId);
  });
}

export async function backfillManualEntitlementsFromEffectiveUsers() {
  if (await getSetting("manual-entitlements-backfill-v1")) return;
  const allUsers = await getAllUsers();
  for (const user of allUsers as any[]) {
    if (user.role === "admin") continue;
    const planLimits = await getEffectiveUserPlanLimits(Number(user.id));
    const hasPlan = !!planLimits.canAddRules;
    const manualCanAddRules = !!user.canAddRules && !hasPlan;
    const overPlan = (effective: unknown, plan: unknown) => {
      const current = positiveInt(effective);
      const planValue = positiveInt(plan);
      if (!hasPlan) return current;
      if (current === 0) return planValue === 0 ? 0 : 0;
      if (planValue === 0) return 0;
      return current > planValue ? current : 0;
    };
    const manualExpiresAt = hasPlan ? null : (user.expiresAt ? new Date(user.expiresAt) : null);
    await updateUserTrafficSettings(Number(user.id), {
      manualCanAddRules,
      manualAllowForwardXTunnel: manualCanAddRules && !!user.allowForwardXTunnel,
      manualAllowProxySubscription: manualCanAddRules && !!(user as any).allowProxySubscription,
      manualMaxRules: overPlan(user.maxRules, planLimits.maxRules),
      manualMaxPorts: overPlan(user.maxPorts, planLimits.maxPorts),
      manualMaxConnections: overPlan(user.maxConnections, planLimits.maxConnections),
      manualMaxIPs: overPlan(user.maxIPs, planLimits.maxIPs),
      manualGostRateLimitIn: overPlan(user.gostRateLimitIn, planLimits.gostRateLimitIn),
      manualGostRateLimitOut: overPlan(user.gostRateLimitOut, planLimits.gostRateLimitOut),
      manualTrafficLimit: overPlan(user.trafficLimit, planLimits.trafficLimit),
      manualExpiresAt,
    } as any);
    await syncUserSubscriptionEntitlements(Number(user.id));
  }
  await setSetting("manual-entitlements-backfill-v1", String(Math.floor(Date.now() / 1000)));
}

export async function repairSubscriptionBillingStateOnce() {
  const marker = "subscription-billing-state-v3";
  if (await getSetting(marker)) return { users: 0, resets: 0 };
  const db = await getDb();
  if (!db) return { users: 0, resets: 0 };
  const now = nowDate();
  const rows = await db.select({
    userId: userSubscriptions.userId,
    role: users.role,
  }).from(userSubscriptions)
    .innerJoin(users, eq(userSubscriptions.userId, users.id));
  const userIds = Array.from(new Set((rows as any[])
    .filter((row) => row.role !== "admin")
    .map((row) => Number(row.userId || 0))
    .filter((userId) => userId > 0)));
  let resets = 0;
  for (const userId of userIds) {
    resets += await withTrafficBillingUserLock(userId, async () => {
      const cycle = await rechargeSubscriptionTrafficCyclesForUserUnlocked(userId, now);
      await syncUserSubscriptionEntitlements(userId);
      return cycle.resetCount;
    });
  }
  await setSetting(marker, String(Math.floor(now.getTime() / 1000)));
  return { users: userIds.length, resets };
}

/** 账户级流量计数器跟随的主订阅：生效、有限额、开通最早（同时开通取 id 小的）。 */
function primaryTrafficCycleSubscriptionId(rows: any[]) {
  let primary: { id: number; startedAt: number } | null = null;
  for (const row of rows) {
    if (subscriptionTrafficLimit(row) <= 0) continue;
    const id = Number(row.id || 0);
    if (id <= 0) continue;
    const startedAt = validDate(row.startedAt)?.getTime() ?? Number.POSITIVE_INFINITY;
    if (!primary || startedAt < primary.startedAt || (startedAt === primary.startedAt && id < primary.id)) {
      primary = { id, startedAt };
    }
  }
  return primary?.id ?? 0;
}

async function rechargeSubscriptionTrafficCyclesForUserUnlocked(userId: number, now: Date) {
  const db = await getDb();
  if (!db) return { resetCount: 0, settled: false };
  await alignSubscriptionTrafficCycles(now, { userId, preserveDue: true });
  const nowSec = Math.floor(now.getTime() / 1000);
  const due = await db.select({
    id: userSubscriptions.id,
    userId: userSubscriptions.userId,
    nextTrafficResetAt: userSubscriptions.nextTrafficResetAt,
    lastTrafficResetAt: userSubscriptions.lastTrafficResetAt,
    startedAt: userSubscriptions.startedAt,
    expiresAt: userSubscriptions.expiresAt,
    trafficAutoReset: users.trafficAutoReset,
    trafficResetDay: users.trafficResetDay,
  }).from(userSubscriptions).innerJoin(users, eq(userSubscriptions.userId, users.id)).where(and(
    eq(userSubscriptions.userId, userId),
    eq(userSubscriptions.status, "active"),
    sql`${userSubscriptions.nextTrafficResetAt} IS NOT NULL`,
    sql`${userSubscriptions.nextTrafficResetAt} <= ${nowSec}`,
    sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
  ));
  /*
    用户已用流量只有一个计数器（users.trafficUsed），额度却是所有生效订阅相加。
    按各自开通日锚定（trafficAutoReset 关）时，以前每份订阅的锚点到了都会把这个共用
    计数器清零 —— 错开日子买几份便宜的附加套餐，一个月就能清好几次，额度成倍放大。
    现在账户级计数器只跟一个锚点走：当前生效、有限额的订阅里开通最早的那份（主订阅）。
    其余订阅的周期照常推进（自己的加油包照常按周期到期），只是不再清共用计数器。
    trafficAutoReset 开时所有订阅共用用户设置的重置日，本来就只清一次，行为不变。
  */
  const primarySubscriptionId = primaryTrafficCycleSubscriptionId(
    await subscriptionCycleRows({ userId }),
  );
  let dueBoundary = Number.NEGATIVE_INFINITY;
  const cycleUpdates: Array<{ id: number; dueBoundary: Date; nextTrafficResetAt: Date | null; expiresAt: Date | null }> = [];
  for (const sub of due as any[]) {
    const expiresAt = sub.expiresAt ? new Date(sub.expiresAt) : null;
    let next = sub.nextTrafficResetAt ? new Date(sub.nextTrafficResetAt) : null;
    if (!next) continue;
    const subscriptionDueBoundary = next.getTime();
    if (sub.trafficAutoReset) {
      next = nextConfiguredSubscriptionTrafficReset(
        sub,
        { ...sub, lastTrafficResetAt: now },
        now,
        expiresAt,
      );
    } else {
      next = nextAnchoredSubscriptionTrafficReset(sub.startedAt, now, expiresAt);
    }
    const boundedNext = next && (!expiresAt || next.getTime() < expiresAt.getTime()) ? next : null;
    cycleUpdates.push({
      id: Number(sub.id),
      dueBoundary: new Date(subscriptionDueBoundary),
      nextTrafficResetAt: boundedNext,
      expiresAt,
    });
    if (sub.trafficAutoReset || Number(sub.id) === primarySubscriptionId) {
      dueBoundary = Math.max(dueBoundary, subscriptionDueBoundary);
    }
  }
  if (cycleUpdates.length === 0) return { resetCount: 0, settled: false };
  const reset = Number.isFinite(dueBoundary)
    ? await resetUserTrafficForCycle(userId, new Date(dueBoundary), now)
    : false;
  await expireTrafficAddonsForSubscriptionCycles(cycleUpdates);
  for (const cycle of cycleUpdates) {
    await updateUserSubscription(cycle.id, {
      nextTrafficResetAt: cycle.nextTrafficResetAt,
      lastTrafficResetAt: now,
    } as any);
    /*
      上面只把「上一周期」的加油包（开通时刻早于这次重置边界的）判了过期。
      边界之后才加上的加油包（比如 1 号 00:00 已过、每小时的巡检还没跑到时管理员
      发的流量包，或订阅刚开、下次重置时刻还没对齐过）属于新周期，周期末尾却还
      停在刚刚过去的那个边界上 —— 不跟着改，紧接着 expireDueTrafficAddons 就按
      「已到期」把它收走，用户白丢一个刚到手的流量包。这里把幸存的加油包对齐到
      新周期的末尾。
    */
    await updateActiveTrafficAddonCycleEnd(cycle.id, cycle.nextTrafficResetAt, cycle.expiresAt);
  }
  return { resetCount: reset ? 1 : 0, settled: true };
}

export async function rechargeSubscriptionTrafficCycles() {
  const rows = await subscriptionCycleRows();
  const now = nowDate();
  /*
    先把没事可做的订阅挑出去，再决定进谁的锁。

    外面这一次全量读本来就带齐了判断所需的全部字段，加上一次把生效加油包问清，
    整轮的固定开销是两次查询 —— 换掉原来的「每个用户三次」。判据见
    subscriptionCycleNeedsWork：三条都不成立时进锁那一趟是空跑。
  */
  const addonCycles = await activeTrafficAddonCycles();
  const userIds = Array.from(new Set((rows as any[])
    .filter((row) => subscriptionCycleNeedsWork(row, now, addonCycles.get(Number(row.id))))
    .map((row) => Number(row.userId || 0))
    .filter((userId) => userId > 0)));
  let resetCount = 0;
  for (const userId of userIds) {
    const result = await withTrafficBillingUserLock(
      userId,
      () => rechargeSubscriptionTrafficCyclesForUserUnlocked(userId, now),
    );
    resetCount += result.resetCount;
    if (result.settled) {
      await recoverUserForwardAccessIfEligible(userId);
    }
  }
  return resetCount;
}

export type SubscriptionPortRange = {
  start: number;
  end: number;
};

export type UserPlanPortRange = SubscriptionPortRange & {
  ranges: SubscriptionPortRange[];
};

function mergeSubscriptionPortRanges(ranges: SubscriptionPortRange[]) {
  const sorted = ranges
    .map((range) => ({ start: Math.max(1, Math.floor(Number(range.start))), end: Math.min(65535, Math.floor(Number(range.end))) }))
    .filter((range) => range.start <= range.end)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SubscriptionPortRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function userPlanPortRangeResult(ranges: SubscriptionPortRange[]): UserPlanPortRange | null {
  const merged = mergeSubscriptionPortRanges(ranges);
  if (merged.length === 0) return null;
  return {
    start: merged[0].start,
    end: merged[merged.length - 1].end,
    ranges: merged,
  };
}

export async function getUserPlanPortRanges(userId: number, hostId?: number, tunnelId?: number): Promise<SubscriptionPortRange[]> {
  const active = await getActiveUserSubscriptions(userId);
  const ranges: SubscriptionPortRange[] = [];
  for (const sub of active as any[]) {
    if (!sub.portRangeStart || !sub.portRangeEnd) continue;
    const matches = tunnelId
      ? (Array.isArray(sub.tunnelIds) && sub.tunnelIds.includes(tunnelId))
        || (!!hostId && Array.isArray(sub.hostIds) && sub.hostIds.includes(hostId))
      : !!hostId && Array.isArray(sub.hostIds) && sub.hostIds.includes(hostId);
    if (matches) ranges.push({ start: Number(sub.portRangeStart), end: Number(sub.portRangeEnd) });
  }
  return mergeSubscriptionPortRanges(ranges);
}

export async function getUserPlanPortRange(userId: number, hostId?: number, tunnelId?: number): Promise<UserPlanPortRange | null> {
  return userPlanPortRangeResult(await getUserPlanPortRanges(userId, hostId, tunnelId));
}

export async function getUserForwardGroupPlanPortRanges(userId: number, forwardGroupId: number): Promise<SubscriptionPortRange[]> {
  const active = await getActiveUserSubscriptions(userId);
  const ranges: SubscriptionPortRange[] = [];
  for (const sub of active as any[]) {
    if (!sub.portRangeStart || !sub.portRangeEnd) continue;
    if (Array.isArray(sub.forwardGroupIds) && sub.forwardGroupIds.includes(forwardGroupId)) {
      ranges.push({ start: Number(sub.portRangeStart), end: Number(sub.portRangeEnd) });
    }
  }
  return mergeSubscriptionPortRanges(ranges);
}

export async function getUserForwardGroupPlanPortRange(userId: number, forwardGroupId: number): Promise<UserPlanPortRange | null> {
  return userPlanPortRangeResult(await getUserForwardGroupPlanPortRanges(userId, forwardGroupId));
}

export function isPortAllowedByUserPlanRange(port: number, range: UserPlanPortRange | null | undefined) {
  if (!range) return true;
  const candidate = Number(port);
  return range.ranges.some((item) => candidate >= item.start && candidate <= item.end);
}

/**
 * 套餐端口段分配时看到的「可分配范围 + 已占用端口」。
 *
 * exclude 用于续费时复核旧端口段：这份订阅自己的段、以及它主人自己的规则不算占用。
 */
async function subscriptionPortAllocationState(
  hostIds: number[],
  tunnelIds: number[],
  forwardGroupIds: number[],
  exclude: { subscriptionId?: number; ruleUserId?: number } = {},
) {
  const db = await getDb();
  if (!db) return null;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const hostId of hostIds) {
    const host = await getHostById(hostId);
    if (!host) continue;
    const start = Number((host as any).portRangeStart || 10000);
    const end = Number((host as any).portRangeEnd || 65535);
    ranges.push({ start, end });
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await getTunnelById(tunnelId);
    if (!tunnel) continue;
    const start = Number((tunnel as any).portRangeStart || 10000);
    const end = Number((tunnel as any).portRangeEnd || 65535);
    ranges.push({ start, end });
  }
  for (const forwardGroupId of forwardGroupIds) {
    const range = await getForwardGroupEntryPortRange(forwardGroupId);
    if (!range) continue;
    ranges.push(range);
  }
  const start = ranges.length ? Math.max(...ranges.map((r) => r.start)) : 10000;
  const end = ranges.length ? Math.min(...ranges.map((r) => r.end)) : 65535;
  if (start <= 0 || end < start) return null;

  const used = new Set<number>();
  const ruleRows = await db.select({ port: forwardRules.sourcePort, userId: forwardRules.userId }).from(forwardRules).where(and(
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ));
  (ruleRows as any[]).forEach((row: any) => {
    if (exclude.ruleUserId && Number(row.userId) === exclude.ruleUserId) return;
    used.add(Number(row.port));
  });
  const subRows = await db.select({
    id: userSubscriptions.id,
    portRangeStart: userSubscriptions.portRangeStart,
    portRangeEnd: userSubscriptions.portRangeEnd,
  }).from(userSubscriptions).where(and(
    eq(userSubscriptions.status, "active"),
    sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${Math.floor(Date.now() / 1000)})`,
  ));
  (subRows as any[]).forEach((row: any) => {
    if (exclude.subscriptionId && Number(row.id) === exclude.subscriptionId) return;
    const s = Number(row.portRangeStart || 0);
    const e = Number(row.portRangeEnd || 0);
    for (let p = s; p > 0 && p <= e; p++) used.add(p);
  });
  return { start, end, used };
}

/**
 * 续费一份已经不在生效中的订阅（过期后再续）时，旧端口段还是不是它的。
 *
 * 订阅一过期，它的端口段就不再算占用，可能已经分给了别人的新订阅。原样沿用的话，
 * 两个租户拿着重叠的端口段，谁先建规则谁占。
 */
async function isSubscriptionPortRangeStillFree(
  range: { start: number; end: number },
  hostIds: number[],
  tunnelIds: number[],
  forwardGroupIds: number[],
  owner: { subscriptionId: number; userId: number },
) {
  const state = await subscriptionPortAllocationState(hostIds, tunnelIds, forwardGroupIds, {
    subscriptionId: owner.subscriptionId,
    ruleUserId: owner.userId,
  });
  if (!state || range.start < state.start || range.end > state.end || range.end < range.start) return false;
  for (let port = range.start; port <= range.end; port++) {
    if (state.used.has(port)) return false;
  }
  return true;
}

export async function findAvailableSubscriptionPortBlock(portCount: number, hostIds: number[], tunnelIds: number[], forwardGroupIds: number[] = []) {
  const count = Math.max(1, portCount);
  const state = await subscriptionPortAllocationState(hostIds, tunnelIds, forwardGroupIds);
  if (!state) return null;
  const { start, end, used } = state;
  if (end - start + 1 < count) return null;

  for (let port = start; port <= end - count + 1; port++) {
    let ok = true;
    for (let p = port; p < port + count; p++) {
      if (used.has(p)) {
        ok = false;
        port = p;
        break;
      }
    }
    if (ok) return { start: port, end: port + count - 1 };
  }
  return null;
}

export type SubscriptionSource = "admin" | "payment" | "redeem" | "balance";

/**
 * 开通 / 续费套餐时「重试也不会成功」的错误：套餐不存在或已停用、续费目标已取消或不可续、
 * 没有空闲端口段等。在线支付发货遇到它时不再无限重试，而是把实付金额转入余额（见
 * payment.ts 的 finalizePaidOrder）；数据库、锁之类的临时错误仍然抛普通 Error 继续重试。
 */
export class PermanentDeliveryError extends Error {
  readonly permanentDelivery = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentDeliveryError";
  }
}

export function isPermanentDeliveryError(error: unknown): error is PermanentDeliveryError {
  return error instanceof PermanentDeliveryError || (error as any)?.permanentDelivery === true;
}

/** Store purchases may be renewed by the owner; administrative grants and
 * redemption grants require a fresh assignment/administrative action. */
export function isUserRenewableSubscriptionSource(source: unknown) {
  return source === "payment" || source === "balance";
}

function addSubscriptionDays(base: Date, days: number) {
  return new Date(base.getTime() + days * 24 * 3600 * 1000);
}

async function applySubscriptionToUserUnlocked(
  userId: number,
  planId: number,
  source: SubscriptionSource,
  paymentOrderNo?: string | null,
  startsAt?: Date,
  overrideDurationDays?: number | null,
  targetSubscriptionId?: number | null,
) {
  const plan = await getSubscriptionPlanById(planId);
  if (!plan) throw new PermanentDeliveryError("套餐不存在");
  if (!plan.isActive) throw new PermanentDeliveryError("套餐已停用");
  const hostIds = (plan as any).hostIds || [];
  const tunnelIds = (plan as any).tunnelIds || [];
  const forwardGroupIds = (plan as any).forwardGroupIds || [];
  if (hostIds.length === 0 && tunnelIds.length === 0 && forwardGroupIds.length === 0) throw new PermanentDeliveryError("套餐未绑定任何端口转发、隧道、转发链或转发组");
  const now = startsAt || new Date();
  const durationDays = overrideDurationDays === null || overrideDurationDays === undefined
    ? Number(plan.durationDays)
    : Number(overrideDurationDays);
  const activeSubscriptions = await getActiveUserSubscriptions(userId);
  const user = await getUserById(userId);
  const hadActiveSubscription = activeSubscriptions.length > 0;
  // A purchase/assignment without an explicit target is always a new
  // subscription. Renewal must name the exact subscription being extended.
  let sameActiveSubscription = targetSubscriptionId
    ? await getUserSubscriptionById(Number(targetSubscriptionId))
    : null;
  if (targetSubscriptionId) {
    if (!sameActiveSubscription || Number(sameActiveSubscription.userId) !== Number(userId)) {
      throw new PermanentDeliveryError("订阅不存在或无权操作");
    }
    if (Number(sameActiveSubscription.planId) !== Number(planId)) {
      throw new PermanentDeliveryError("续费套餐与目标订阅不一致");
    }
    if (sameActiveSubscription.status === "cancelled") {
      throw new PermanentDeliveryError("已取消的订阅不能续费");
    }
    if (!isUserRenewableSubscriptionSource(sameActiveSubscription.source)) {
      throw new PermanentDeliveryError("管理员分配的套餐不能自行续费，请联系管理员处理");
    }
    if (!isUserRenewableSubscriptionSource(source)) {
      throw new PermanentDeliveryError("当前来源不支持用户续费");
    }
  }
  if (sameActiveSubscription) {
    const currentExpiresAt = sameActiveSubscription.expiresAt ? new Date(sameActiveSubscription.expiresAt) : null;
    const baseExpiresAt = currentExpiresAt && Number.isFinite(currentExpiresAt.getTime()) && currentExpiresAt.getTime() > now.getTime()
      ? currentExpiresAt
      : now;
    const expiresAt = !currentExpiresAt
      ? null
      : durationDays > 0
        ? addSubscriptionDays(baseExpiresAt, durationDays)
        : null;
    const existingNextTrafficResetAt = sameActiveSubscription.nextTrafficResetAt ? new Date(sameActiveSubscription.nextTrafficResetAt) : null;
    let nextTrafficResetAt = existingNextTrafficResetAt && Number.isFinite(existingNextTrafficResetAt.getTime())
      ? existingNextTrafficResetAt
      : null;
    if (Number(plan.trafficLimit || 0) > 0) {
      if ((user as any)?.trafficAutoReset) {
        nextTrafficResetAt = nextConfiguredSubscriptionTrafficReset(user as any, sameActiveSubscription, now, expiresAt);
      } else if (!nextTrafficResetAt || !Number.isFinite(nextTrafficResetAt.getTime()) || nextTrafficResetAt.getTime() <= now.getTime()) {
        nextTrafficResetAt = !existingNextTrafficResetAt && currentExpiresAt && expiresAt && currentExpiresAt.getTime() > now.getTime() && currentExpiresAt.getTime() < expiresAt.getTime()
          ? currentExpiresAt
          : nextBillingMonthlyTrafficReset(now, expiresAt);
      }
      if (expiresAt && nextTrafficResetAt && nextTrafficResetAt.getTime() >= expiresAt.getTime()) {
        nextTrafficResetAt = null;
      }
    } else {
      nextTrafficResetAt = null;
    }

    let portRangeStart = Number(sameActiveSubscription.portRangeStart || 0);
    let portRangeEnd = Number(sameActiveSubscription.portRangeEnd || 0);
    const wasActive = sameActiveSubscription.status === "active"
      && (!currentExpiresAt || currentExpiresAt.getTime() > Date.now());
    if (!wasActive && portRangeStart && portRangeEnd && !(await isSubscriptionPortRangeStillFree(
      { start: portRangeStart, end: portRangeEnd },
      hostIds,
      tunnelIds,
      forwardGroupIds,
      { subscriptionId: Number(sameActiveSubscription.id), userId },
    ))) {
      // 旧段已经被别人占了：像新购一样重新分一段（下面那支）；分不到就是永久失败，
      // 在线支付那边会把钱转入余额。
      console.warn(`[Billing] renewing inactive subscription=${sameActiveSubscription.id} user=${userId}: port range ${portRangeStart}-${portRangeEnd} was re-allocated, assigning a new block`);
      portRangeStart = 0;
      portRangeEnd = 0;
    }
    const updateData: Partial<InsertUserSubscription> = {
      status: "active",
      expiresAt,
      nextTrafficResetAt,
      planSnapshot: JSON.stringify(buildPlanSnapshot(plan)),
      // 续期时按这一次买的档记：从月付改成年付之后，下次自动续费要跟着变成年付。
      durationDays,
    } as any;
    if (paymentOrderNo) {
      (updateData as any).paymentOrderNo = paymentOrderNo;
    }
    if (!portRangeStart || !portRangeEnd) {
      const block = await findAvailableSubscriptionPortBlock(Number(plan.portCount) || 1, hostIds, tunnelIds, forwardGroupIds);
      if (!block) throw new PermanentDeliveryError("套餐可用端口不足，无法分配连续端口段");
      portRangeStart = block.start;
      portRangeEnd = block.end;
      (updateData as any).portRangeStart = block.start;
      (updateData as any).portRangeEnd = block.end;
    }
    await updateUserSubscription(Number(sameActiveSubscription.id), updateData);
    await updateActiveTrafficAddonCycleEnd(Number(sameActiveSubscription.id), nextTrafficResetAt, expiresAt);
    await syncUserSubscriptionEntitlements(userId);
    return {
      subscriptionId: Number(sameActiveSubscription.id),
      portRangeStart,
      portRangeEnd,
      expiresAt,
      extended: true,
    };
  }

  const block = await findAvailableSubscriptionPortBlock(Number(plan.portCount) || 1, hostIds, tunnelIds, forwardGroupIds);
  if (!block) throw new PermanentDeliveryError("套餐可用端口不足，无法分配连续端口段");
  const expiresAt = durationDays > 0 ? addSubscriptionDays(now, durationDays) : null;
  const nextTrafficResetAt = Number(plan.trafficLimit || 0) > 0
    ? (user as any)?.trafficAutoReset
      ? nextConfiguredSubscriptionTrafficReset(user as any, { startedAt: now }, now, expiresAt)
      : nextBillingMonthlyTrafficReset(now, expiresAt)
    : null;
  const subscriptionId = await createUserSubscription({
    userId,
    planId,
    status: "active",
    source,
    paymentOrderNo: paymentOrderNo ?? null,
    planSnapshot: JSON.stringify(buildPlanSnapshot(plan)),
    // 买的是哪一档。自动续费按它续 —— 按月付的人不该某天醒来发现被扣了一年的钱。
    durationDays,
    portRangeStart: block.start,
    portRangeEnd: block.end,
    nextTrafficResetAt,
    startedAt: now,
    expiresAt,
  } as any);
  await syncUserSubscriptionEntitlements(userId);
  if (!hadActiveSubscription && Number(user?.trafficUsed || 0) >= Number(user?.trafficLimit || 0) && Number(user?.trafficLimit || 0) > 0) {
    await resetUserTraffic(userId);
    await syncUserSubscriptionEntitlements(userId);
  }
  return { subscriptionId, portRangeStart: block.start, portRangeEnd: block.end, expiresAt };
}

export async function applySubscriptionToUser(
  userId: number,
  planId: number,
  source: SubscriptionSource,
  paymentOrderNo?: string | null,
  startsAt?: Date,
  overrideDurationDays?: number | null,
  targetSubscriptionId?: number | null,
) {
  return withTrafficBillingUserLock(userId, () => withDatabaseTransaction(
    // Port blocks are allocated by reading all active reservations and then
    // inserting the selected range. Hold the shared database marker row for
    // the entire transaction so separate panel instances cannot choose the
    // same range concurrently.
    () => withSubscriptionPortAllocationLock(() => applySubscriptionToUserUnlocked(
      userId,
      planId,
      source,
      paymentOrderNo,
      startsAt,
      overrideDurationDays,
      targetSubscriptionId,
    )),
  )).then(async (result) => {
    /**
     * 开通即可用：买了（或被分配）套餐还没有订阅地址的话，自动开一条。
     *
     * 只挂在「开通」这一刻，不挂在通用的权益重算上 —— 那个每次到期清扫、每次
     * 改套餐都会跑，用户自己删掉的地址会被一次次加回来，删不掉。
     */
    const user = await getUserById(userId);
    if ((user as any)?.allowProxySubscription || String((user as any)?.role || "") === "admin") {
      const { ensureDefaultProxySubToken } = await import("./proxySubscriptionRepository");
      await ensureDefaultProxySubToken(userId);
    }
    return result;
  });
}

function getTrafficAddonCycleEnd(subscription: any) {
  const now = new Date();
  const nextTrafficResetAt = subscription?.nextTrafficResetAt ? new Date(subscription.nextTrafficResetAt) : null;
  if (nextTrafficResetAt && nextTrafficResetAt.getTime() > now.getTime()) return nextTrafficResetAt;
  const expiresAt = subscription?.expiresAt ? new Date(subscription.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() > now.getTime()) return expiresAt;
  return billingStartOfCalendarDay(billingAddMonthsClamped(now, 1));
}

function formatAddonTraffic(bytes: number) {
  const gb = bytes / 1024 / 1024 / 1024;
  return `${Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(2)}GB`;
}

async function getTrafficAddonById(addonId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select({
      id: subscriptionPlanTrafficAddons.id,
      planId: subscriptionPlanTrafficAddons.planId,
      planName: subscriptionPlans.name,
      planTrafficLimit: subscriptionPlans.trafficLimit,
      planIsActive: subscriptionPlans.isActive,
      planIsStoreVisible: subscriptionPlans.isStoreVisible,
      trafficBytes: subscriptionPlanTrafficAddons.trafficBytes,
      priceCents: subscriptionPlanTrafficAddons.priceCents,
      isActive: subscriptionPlanTrafficAddons.isActive,
      sortOrder: subscriptionPlanTrafficAddons.sortOrder,
    })
    .from(subscriptionPlanTrafficAddons)
    .leftJoin(subscriptionPlans, eq(subscriptionPlanTrafficAddons.planId, subscriptionPlans.id))
    .where(eq(subscriptionPlanTrafficAddons.id, addonId))
    .limit(1);
  return rows[0] as any;
}

function pickActiveFiniteTrafficSubscription(activeSubscriptions: any[], planId?: number, subscriptionId?: number) {
  const matched = activeSubscriptions.filter((sub: any) => {
    if (planId && Number(sub.planId) !== Number(planId)) return false;
    if (subscriptionId && Number(sub.id) !== Number(subscriptionId)) return false;
    return Number(sub.trafficLimit || 0) > 0;
  });
  return matched
    .sort((a: any, b: any) => {
      const aEnd = getTrafficAddonCycleEnd(a).getTime();
      const bEnd = getTrafficAddonCycleEnd(b).getTime();
      return aEnd - bEnd;
    })[0];
}

export async function purchaseTrafficAddonWithBalance(userId: number, addonId: number, subscriptionId?: number | null) {
  let cycleSettled = false;
  let entitlementsSynced = false;
  try {
  return await withTrafficBillingUserLock(userId, async () => {
  const cycle = await rechargeSubscriptionTrafficCyclesForUserUnlocked(userId, nowDate());
  cycleSettled = cycle.settled;
  return withDatabaseTransaction(async () => {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await expireDueTrafficAddons(userId);
  const addon = await getTrafficAddonById(addonId);
  if (!addon || !addon.isActive || Number(addon.trafficBytes || 0) <= 0) throw new Error("流量包不可购买");
  // 和余额买套餐同一套条件：套餐停用或已从商店下架时，挂在它下面的流量包也不能再买。
  if (!dbBool(addon.planIsActive) || !dbBool(addon.planIsStoreVisible)) throw new Error("流量包不可购买");
  if (Number(addon.planTrafficLimit || 0) <= 0) throw new Error("不限流量套餐无需购买流量包");
  const activeSubscriptions = await getActiveUserSubscriptions(userId);
  const subscription = pickActiveFiniteTrafficSubscription(activeSubscriptions as any[], Number(addon.planId), subscriptionId || undefined);
  if (!subscription) throw new Error("当前没有可购买流量包的生效套餐");
  const amountCents = Number(addon.priceCents || 0);
  const balance = await getUserBalance(userId);
  if (balance < amountCents) throw new Error("余额不足");
  const expiresAt = getTrafficAddonCycleEnd(subscription);
  const description = `购买附加流量：${addon.planName || `套餐 #${addon.planId}`} ${formatAddonTraffic(Number(addon.trafficBytes || 0))}`;
  if (amountCents > 0) {
    await addUserBalance(userId, -amountCents, {
      type: "traffic_addon_purchase",
      description,
    } as any);
  }
  const now = nowDate();
  const id = await insertAndGetId("user_traffic_addons", {
    userId,
    subscriptionId: subscription.id,
    planId: addon.planId,
    addonId: addon.id,
    trafficBytes: Number(addon.trafficBytes || 0),
    priceCents: amountCents,
    source: "user",
    status: "active",
    description,
    cycleResetAt: expiresAt,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  const limits = await syncUserSubscriptionEntitlements(userId, { deferRuleRecovery: true });
  entitlementsSynced = true;
  return {
    id,
    subscriptionId: subscription.id,
    trafficBytes: Number(addon.trafficBytes || 0),
    priceCents: amountCents,
    expiresAt,
    trafficLimit: limits.trafficLimit,
  };
  });
  });
  } finally {
    if (cycleSettled || entitlementsSynced) {
      try {
        await recoverUserForwardAccessIfEligible(userId);
      } catch (error) {
        console.warn(`[Billing] post-cycle access recovery failed user=${userId}:`, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

export async function adminAddUserTrafficAddon(input: {
  userId: number;
  trafficBytes: number;
  subscriptionId?: number | null;
  operatorUserId?: number | null;
  description?: string | null;
}) {
  let cycleSettled = false;
  let entitlementsSynced = false;
  try {
  return await withTrafficBillingUserLock(input.userId, async () => {
  const cycle = await rechargeSubscriptionTrafficCyclesForUserUnlocked(input.userId, nowDate());
  cycleSettled = cycle.settled;
  return withDatabaseTransaction(async () => {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const trafficBytes = Math.floor(Number(input.trafficBytes || 0));
  if (!Number.isFinite(trafficBytes) || trafficBytes <= 0) throw new Error("附加流量必须大于 0");
  await expireDueTrafficAddons(input.userId);
  const activeSubscriptions = await getActiveUserSubscriptions(input.userId);
  const subscription = pickActiveFiniteTrafficSubscription(activeSubscriptions as any[], undefined, input.subscriptionId || undefined);
  if (!subscription) throw new Error("该用户没有可附加流量的生效流量套餐");
  const expiresAt = getTrafficAddonCycleEnd(subscription);
  const description = input.description?.trim() || `管理员附加本周期流量：${formatAddonTraffic(trafficBytes)}`;
  const now = nowDate();
  const id = await insertAndGetId("user_traffic_addons", {
    userId: input.userId,
    subscriptionId: subscription.id,
    planId: subscription.planId,
    addonId: null,
    trafficBytes,
    priceCents: 0,
    source: "admin",
    status: "active",
    operatorUserId: input.operatorUserId || null,
    description,
    cycleResetAt: expiresAt,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  const limits = await syncUserSubscriptionEntitlements(input.userId, { deferRuleRecovery: true });
  entitlementsSynced = true;
  return {
    id,
    subscriptionId: subscription.id,
    trafficBytes,
    expiresAt,
    trafficLimit: limits.trafficLimit,
  };
  });
  });
  } finally {
    if (cycleSettled || entitlementsSynced) {
      try {
        await recoverUserForwardAccessIfEligible(input.userId);
      } catch (error) {
        console.warn(`[Billing] post-cycle access recovery failed user=${input.userId}:`, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

// ==================== Balance ====================

export async function getUserBalance(userId: number) {
  const user = await getUserById(userId);
  return Number((user as any)?.balanceCents || 0);
}

async function addUserBalanceInTransaction(userId: number, amountCents: number, meta: Omit<InsertBalanceTransaction, "userId" | "amountCents" | "balanceAfterCents">) {
  const q = quoteDbIdentifier;
  const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
  const rows = await queryRaw<{ balanceCents: number }>(
    `SELECT ${q("balanceCents")} AS ${q("balanceCents")} FROM ${q("users")} WHERE ${q("id")} = ?${lock}`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new Error("用户不存在");
  const current = Number(row.balanceCents || 0);
  const delta = Math.round(amountCents);
  const next = current + delta;
  if (next < 0) throw new Error("余额不足");
  const now = Math.floor(Date.now() / 1000);
  await executeRaw(`UPDATE ${q("users")} SET ${q("balanceCents")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`, [next, now, userId]);
  // 带回流水 id：余额买套餐拿它当这一笔的唯一标识（邀请返利的幂等键，见 purchasePlanWithBalance）。
  const transactionId = await insertAndGetId("balance_transactions", {
    userId,
    type: meta.type,
    amountCents: delta,
    balanceAfterCents: next,
    description: meta.description ?? null,
    operatorUserId: meta.operatorUserId ?? null,
    paymentOrderNo: meta.paymentOrderNo ?? null,
    redemptionCodeId: meta.redemptionCodeId ?? null,
    createdAt: now,
  });
  return { balanceCents: next, transactionId };
}


export async function getBillingAdminSummary() {
  const db = await getDb();
  if (!db) {
    return {
      userCount: 0,
      totalBalanceCents: 0,
      activeRedemptionCodes: 0,
      activeDiscountCodes: 0,
    };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const [userRows, redemptionRows, discountRows] = await Promise.all([
    db.select({
      userCount: sql<number>`COUNT(*)`,
      totalBalanceCents: sql<number>`COALESCE(SUM(${users.balanceCents}), 0)`,
    }).from(users),
    db.select({
      count: sql<number>`COALESCE(SUM(CASE
        WHEN ${redemptionCodes.isActive} = ${sqlBool(true)}
          AND ${redemptionCodes.usedAt} IS NULL
        THEN 1 ELSE 0 END), 0)`,
    }).from(redemptionCodes),
    db.select({
      count: sql<number>`COALESCE(SUM(CASE
        WHEN ${discountCodes.isActive} = ${sqlBool(true)}
          AND (${discountCodes.startsAt} IS NULL OR ${discountCodes.startsAt} <= ${nowSec})
          AND (${discountCodes.expiresAt} IS NULL OR ${discountCodes.expiresAt} > ${nowSec})
          AND (${discountCodes.maxUses} = 0 OR ${discountCodes.usedCount} < ${discountCodes.maxUses})
        THEN 1 ELSE 0 END), 0)`,
    }).from(discountCodes),
  ]);
  return {
    userCount: Number(userRows[0]?.userCount || 0),
    totalBalanceCents: Number(userRows[0]?.totalBalanceCents || 0),
    activeRedemptionCodes: Number(redemptionRows[0]?.count || 0),
    activeDiscountCodes: Number(discountRows[0]?.count || 0),
  };
}

export async function listBalanceTransactions(userId?: number, limit = 100, selectedIds?: number[]) {
  const db = await getDb();
  if (!db || selectedIds?.length === 0) return [];
  const base = db
    .select({
      id: balanceTransactions.id,
      userId: balanceTransactions.userId,
      username: users.username,
      name: users.name,
      type: balanceTransactions.type,
      amountCents: balanceTransactions.amountCents,
      balanceAfterCents: balanceTransactions.balanceAfterCents,
      description: balanceTransactions.description,
      operatorUserId: balanceTransactions.operatorUserId,
      paymentOrderNo: balanceTransactions.paymentOrderNo,
      redemptionCodeId: balanceTransactions.redemptionCodeId,
      createdAt: balanceTransactions.createdAt,
    })
    .from(balanceTransactions)
    .leftJoin(users, eq(balanceTransactions.userId, users.id));
  const conditions = [
    ...(userId !== undefined ? [eq(balanceTransactions.userId, userId)] : []),
    ...(selectedIds ? [inArray(balanceTransactions.id, selectedIds)] : []),
  ];
  const rows = await base
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(balanceTransactions.createdAt), desc(balanceTransactions.id))
    .limit(limit);
  return (rows as any[]).map((row) => ({
    ...row,
    typeLabel: balanceTypeLabel(row.type),
  }));
}

function normalizeBillingLimit(limit = 100) {
  return Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
}

function billingTime(value: unknown) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function paymentStatusLabel(status: string) {
  if (status === "pending") return "待支付";
  if (status === "paid") return "已支付";
  if (status === "processing") return "处理中";
  if (status === "completed") return "已完成";
  if (status === "expired") return "已过期";
  if (status === "cancelled") return "已取消";
  if (status === "failed") return "失败";
  return status || "-";
}

function paymentOrderTypeLabel(type: string | null | undefined) {
  if (type === "plan") return "套餐订单";
  if (type === "test") return "测试订单";
  return "余额充值";
}



async function listUserSubscriptionsForLedger(
  userId: number | undefined,
  limit: number,
  options: { isAdmin: boolean; includeCancelledSubscriptions: boolean },
  selectedIds?: number[],
) {
  const db = await getDb();
  if (!db || selectedIds?.length === 0) return [];
  const query = userSubscriptionsListQuery(db);
  const conditions = subscriptionVisibilityConditions(options.isAdmin ? "admin" : "user");
  if (userId !== undefined) conditions.push(eq(userSubscriptions.userId, userId));
  if (!options.includeCancelledSubscriptions) conditions.push(ne(userSubscriptions.status, "cancelled"));
  if (selectedIds) conditions.push(inArray(userSubscriptions.id, selectedIds));
  return query
    .where(and(...conditions))
    .orderBy(desc(userSubscriptions.createdAt), desc(userSubscriptions.id))
    .limit(limit);
}

export async function listBillingLedger(options?: {
  viewerUserId?: number;
  isAdmin?: boolean;
  userId?: number;
  limit?: number;
  includeCancelledSubscriptions?: boolean;
}, selectedIds?: { balance: number[]; payment: number[]; subscription: number[] }) {
  const limit = normalizeBillingLimit(options?.limit);
  const targetUserId = options?.isAdmin ? options?.userId : options?.viewerUserId;
  if (!options?.isAdmin && !targetUserId) return [];

  const [transactions, orders, subscriptions] = await Promise.all([
    listBalanceTransactions(targetUserId, limit, selectedIds?.balance),
    listPaymentOrders(limit, targetUserId, selectedIds?.payment),
    listUserSubscriptionsForLedger(targetUserId, limit, {
      isAdmin: !!options?.isAdmin,
      includeCancelledSubscriptions: !!options?.includeCancelledSubscriptions,
    }, selectedIds?.subscription),
  ]);

  const items = [
    ...transactions.map((tx: any) => ({
      id: `balance-${tx.id}`,
      sourceId: tx.id,
      kind: "balance",
      category: balanceTypeLabel(tx.type),
      title: balanceTypeLabel(tx.type),
      description: tx.description || "-",
      userId: tx.userId,
      username: tx.username,
      name: tx.name,
      amountCents: Number(tx.amountCents || 0),
      currency: "CNY",
      balanceAfterCents: Number(tx.balanceAfterCents || 0),
      status: "completed",
      statusLabel: "已完成",
      paymentOrderNo: tx.paymentOrderNo,
      redemptionCodeId: tx.redemptionCodeId,
      operatorUserId: tx.operatorUserId,
      createdAt: tx.createdAt,
    })),
    ...orders.map((order: any) => ({
      id: `payment-${order.id}`,
      sourceId: order.id,
      kind: "payment",
      category: paymentOrderTypeLabel(order.orderType),
      title: order.subject || paymentOrderTypeLabel(order.orderType),
      description: order.outTradeNo,
      userId: order.userId,
      username: order.username,
      name: order.name,
      amountCents: Number(order.amountCents || 0),
      currency: order.currency || "CNY",
      status: order.status,
      statusLabel: paymentStatusLabel(order.status),
      paymentType: order.paymentType,
      provider: order.provider,
      paymentOrderNo: order.outTradeNo,
      tradeNo: order.tradeNo,
      planId: order.planId,
      subscriptionId: order.subscriptionId,
      discountAmountCents: Number(order.discountAmountCents || 0),
      createdAt: order.createdAt,
      paidAt: order.paidAt,
    })),
    ...subscriptions.map((sub: any) => ({
      id: `subscription-${sub.id}`,
      sourceId: sub.id,
      kind: "subscription",
      category: "套餐记录",
      title: `${subscriptionSourceLabel(sub.source)}：${sub.planName || `套餐 #${sub.planId}`}`,
      description: sub.portRangeStart && sub.portRangeEnd ? `端口段 ${sub.portRangeStart}-${sub.portRangeEnd}` : "-",
      userId: sub.userId,
      username: sub.username,
      name: sub.name,
      amountCents: sub.source === "admin" || sub.source === "redeem" ? 0 : Number(sub.priceCents || 0),
      currency: "CNY",
      status: sub.status,
      statusLabel: sub.status === "active" ? "生效中" : sub.status === "expired" ? "已过期" : sub.status === "cancelled" ? "已取消" : sub.status,
      planId: sub.planId,
      planName: sub.planName,
      paymentOrderNo: sub.paymentOrderNo,
      portRangeStart: sub.portRangeStart,
      portRangeEnd: sub.portRangeEnd,
      startedAt: sub.startedAt,
      expiresAt: sub.expiresAt,
      createdAt: sub.createdAt,
    })),
  ];

  return items
    .sort((a, b) => billingTime(b.createdAt) - billingTime(a.createdAt))
    .slice(0, limit);
}

/**
 * 余额流水分页（上游 2.3.285）：原来一次最多拿 100 / 500 条，再早的流水在面板上就看不到了。
 */
export async function listBalanceTransactionsPage(input: PageRequest & { userId?: number }) {
  const db = await getDb();
  if (!db) return pageResult([], 0, input, 20);
  const condition = input.userId === undefined ? undefined : eq(balanceTransactions.userId, input.userId);
  const [count] = await db.select({ count: sql<number>`COUNT(*)` }).from(balanceTransactions).where(condition);
  const total = Number(count?.count || 0);
  const window = pageWindowForTotal(input, total, 20);
  const selected = await db.select({ id: balanceTransactions.id }).from(balanceTransactions).where(condition)
    .orderBy(desc(balanceTransactions.createdAt), desc(balanceTransactions.id)).limit(window.pageSize).offset(window.offset);
  const items = await listBalanceTransactions(input.userId, window.pageSize, selected.map((row: any) => Number(row.id)));
  return pageResult(items, total, window, 20);
}

/**
 * 账单（余额流水 + 支付订单 + 套餐记录三张表合在一起）分页（上游 2.3.285）。
 *
 * 原来三张表各取最近 N 条再合并截断，N 之前的记录永远翻不到。现在先在 SQL 里把三张表的
 * （类别、id、时间）UNION 起来排序分页，只取这一页的 id，再按 id 把详情读出来 —— 不整表读，
 * 同一时刻的多条按类别、id 定序，翻页不重不漏。
 */
export async function listBillingLedgerPage(input: NonNullable<Parameters<typeof listBillingLedger>[0]> & PageRequest) {
  const targetUserId = input.isAdmin ? input.userId : input.viewerUserId;
  if (!input.isAdmin && !targetUserId) return pageResult([], 0, input, 20);
  const q = quoteDbIdentifier;
  const parameters: unknown[] = [];
  const parts = ([
    ["balance", "balance_transactions"], ["payment", "payment_orders"], ["subscription", "user_subscriptions"],
  ] as const).map(([kind, table]) => {
    const conditions: string[] = [];
    if (targetUserId !== undefined) { conditions.push(`${q("userId")} = ?`); parameters.push(targetUserId); }
    if (kind === "subscription") {
      conditions.push(`${q("adminDismissedAt")} IS NULL`);
      if (!input.isAdmin) conditions.push(`${q("userDismissedAt")} IS NULL`);
      if (!input.includeCancelledSubscriptions) { conditions.push(`${q("status")} <> ?`); parameters.push("cancelled"); }
    }
    return `SELECT '${kind}' AS ${q("kind")}, ${q("id")} AS ${q("sourceId")}, ${q("createdAt")} AS ${q("createdAt")}
      FROM ${q(table)}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`;
  });
  const union = parts.join(" UNION ALL ");
  const [count] = await queryRaw<{ totalItems: number }>(`SELECT COUNT(*) AS ${q("totalItems")} FROM (${union}) AS ${q("ledger")}`, parameters);
  const total = Number(count?.totalItems || 0);
  const window = pageWindowForTotal(input, total, 20);
  const selected = await queryRaw<{ kind: "balance" | "payment" | "subscription"; sourceId: number }>(
    `SELECT * FROM (${union}) AS ${q("ledger")} ORDER BY ${q("createdAt")} DESC, ${q("kind")} ASC, ${q("sourceId")} DESC
     LIMIT ${window.pageSize} OFFSET ${window.offset}`, parameters,
  );
  const ids = { balance: [] as number[], payment: [] as number[], subscription: [] as number[] };
  for (const row of selected) ids[row.kind].push(Number(row.sourceId));
  const hydrated = await listBillingLedger({ ...input, limit: window.pageSize }, ids);
  const byId = new Map(hydrated.map((item) => [item.id, item]));
  const items = selected.map((row) => byId.get(`${row.kind}-${row.sourceId}`)).filter((item): item is NonNullable<typeof item> => !!item);
  return pageResult(items, total, window, 20);
}

export async function addUserBalance(userId: number, amountCents: number, meta: Omit<InsertBalanceTransaction, "userId" | "amountCents" | "balanceAfterCents">) {
  if (!Number.isFinite(amountCents) || amountCents === 0) throw new Error("金额无效");
  return withDatabaseTransaction(() => addUserBalanceInTransaction(userId, amountCents, meta));
}

export async function setUserBalance(userId: number, balanceCents: number, meta: Omit<InsertBalanceTransaction, "userId" | "amountCents" | "balanceAfterCents">) {
  if (!Number.isFinite(balanceCents) || balanceCents < 0) throw new Error("金额无效");
  return withDatabaseTransaction(async () => {
  const q = quoteDbIdentifier;
  const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
  const [user] = await queryRaw<any>(`SELECT ${q("balanceCents")} AS ${q("balanceCents")} FROM ${q("users")} WHERE ${q("id")} = ?${lock}`, [userId]);
  if (!user) throw new Error("用户不存在");
  const previous = Number((user as any).balanceCents || 0);
  const next = Math.round(balanceCents);
  const delta = next - previous;
  if (delta === 0) {
    return { balanceCents: next, previousBalanceCents: previous, amountCents: 0, changed: false };
  }
  const result = await addUserBalance(userId, delta, meta);
  return { ...result, previousBalanceCents: previous, amountCents: delta, changed: true };
  });
}

export async function purchasePlanWithBalance(
  userId: number,
  planId: number,
  discountCodeId?: number | null,
  subscriptionId?: number | null,
  /** 买的是哪一档周期。不传 = 默认档（老客户端、自动续费回退时都走这条）。 */
  durationDays?: number | null,
) {
  return withTrafficBillingUserLock(userId, () => withDatabaseTransaction(async () => {
  const { plan, option } = await resolvePlanPricing(planId, durationDays ?? null);
  if (!plan.isActive || !plan.isStoreVisible) throw new Error("套餐不可购买");
  const discount = discountCodeId ? await getDiscountCodeById(discountCodeId) : null;
  if (discount) {
    const allowedPlanIds = Array.isArray((discount as any).planIds) ? (discount as any).planIds.map(Number) : [];
    if (allowedPlanIds.length > 0 && !allowedPlanIds.includes(Number(planId))) {
      throw new Error("折扣码不适用于该套餐");
    }
  }
  // 价格取**选中那一档**，不是套餐主表上的默认价 —— 拿主表价去扣年付的单，
  // 等于按月付的钱卖了一年。
  const amountCents = calculateDiscountedAmount(Number(option.priceCents || 0), discount);
  let purchaseTransactionId = 0;
  if (amountCents > 0) {
    const debit = await addUserBalance(userId, -amountCents, {
      type: "purchase",
      description: `购买套餐：${plan.name}（${option.durationDays} 天）`,
    } as any);
    purchaseTransactionId = Number(debit.transactionId || 0);
  }
  if (discount) await consumeDiscountCode(discount.id);
  const result = await applySubscriptionToUser(
    userId,
    planId,
    "balance",
    null,
    undefined,
    option.durationDays,
    subscriptionId || null,
  );
  /*
   * 邀请返利：真花了钱（amountCents > 0）才返，0 元套餐不返。和扣款、开通在同一个事务里：
   * 开通失败回滚时返利一起回滚；返利自己出错只撤销返利那一段，购买照常完成。
   * 幂等键是这笔扣款的余额流水 id —— 每次购买 / 续费各是一笔，不会撞上别的单。
   * 扣的是余额，余额是人民币。
   */
  if (amountCents > 0 && purchaseTransactionId > 0) {
    await creditReferralCommissionInTransaction({
      inviteeId: userId,
      planId,
      planName: plan.name,
      baseAmountCents: amountCents,
      currency: "CNY",
      sourceType: "balance_purchase",
      sourceRef: `balance_tx:${purchaseTransactionId}`,
    });
  }
  return result;
  }));
}

// ==================== Referral commission ====================

const REFERRAL_SAVEPOINT = "nex_referral_commission";

/** 保存点语句：MySQL 走文本协议（预处理语句不一定认 SAVEPOINT），SQLite / PG 走 executeRaw。 */
async function runReferralSavepointStatement(statement: string) {
  if (getDatabaseKind() === "mysql") {
    await queryRaw(statement);
    return;
  }
  await executeRaw(statement);
}

export type ReferralCreditInput = {
  inviteeId: number;
  planId: number;
  planName?: string | null;
  /** 被邀请人这一单实际付了多少（折扣之后），分。 */
  baseAmountCents: number;
  currency?: string | null;
  sourceType: ReferralSourceType;
  /** 幂等键：在线支付是订单号，余额购买是 balance_tx:<扣款流水 id>。 */
  sourceRef: string;
  /** 这一单是什么时候下的（秒）。在线支付是订单创建时刻，余额购买就是现在；不传按现在算。 */
  orderCreatedAt?: number | Date | null;
};

export type ReferralCommissionResult = {
  credited: boolean;
  commissionCents: number;
  inviterId?: number | null;
  reason?: ReferralSkipReason | "duplicate" | "error";
};

function referralEpochSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

async function inviteeHasPriorPaidPlanOrder(inviteeId: number, sourceType: ReferralSourceType, sourceRef: string) {
  const q = quoteDbIdentifier;
  const currentOrderNo = sourceType === "payment_order" ? sourceRef : "";
  const currentTxId = sourceType === "balance_purchase" ? Number(String(sourceRef).replace(/^balance_tx:/, "")) || 0 : 0;
  const onlineRows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")} AS ${q("id")} FROM ${q("payment_orders")}
      WHERE ${q("userId")} = ? AND ${q("outTradeNo")} <> ? AND ${q("orderType")} = 'plan'
        AND ${q("planId")} IS NOT NULL AND ${q("amountCents")} > 0 AND ${q("status")} = 'completed'
      LIMIT 1`,
    [inviteeId, currentOrderNo],
  );
  if (onlineRows.length > 0) return true;
  const balanceRows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")} AS ${q("id")} FROM ${q("balance_transactions")}
      WHERE ${q("userId")} = ? AND ${q("type")} = 'purchase' AND ${q("amountCents")} < 0 AND ${q("id")} <> ?
      LIMIT 1`,
    [inviteeId, currentTxId],
  );
  return balanceRows.length > 0;
}

/**
 * 给邀请人记一笔返利。**只在套餐购买的事务里调**：在线支付套餐单发货（payment.ts 的
 * finalizePaidOrder）、余额买套餐和余额自动续费（purchasePlanWithBalance）。
 * 充值、兑换码、管理员分配、测试单、转入余额的兜底退款都不走这里 —— 充值不返是因为钱
 * 之后拿去买套餐时还会返一次，两头都返就重复了。
 *
 * 不返的情况在 evaluateReferralCommission 里按顺序判断：返利没开、没有邀请人、邀请人是
 * 自己、邀请人停用或删了、套餐比例为 0、0 元单、非人民币单（Stripe 可能收别的币种，余额
 * 是人民币，没有可靠的汇率，干脆不返并记一行日志）、绑定邀请人之前下的单、首单模式下之前已经付过
 * 套餐单（不管当时返没返）、算出来不足一分。
 *
 * 失败不能连累被邀请人的这一单：
 * - 整段包在一个保存点里（SQLite / MySQL / PG 都支持事务内 SAVEPOINT）。PG 上任何一条语句
 *   失败都会让整个事务作废，不回滚到保存点的话购买也跟着没了。出错就 ROLLBACK TO SAVEPOINT，
 *   只撤销返利这一段 —— 返利记录、邀请人余额、返利流水要么一起在，要么一起不在 —— 然后照常返回。
 * - 保存点名字固定：同一个事务里只会顺序调一次，不会有两段交错；不同事务各有各的保存点。
 *   固定名也不会挤占 SQLite 的语句缓存。
 * - 幂等：(sourceType, sourceRef) 唯一。插入用「冲突就什么都不做」的写法，不靠抛唯一约束
 *   错误（那在 PG 上一样会弄坏事务）；插不进去就是已经返过，不再加钱。
 *
 * 返利流水的 paymentOrderNo 必须留空：getBalanceTransactionByPaymentOrderNo 拿它判断「这笔
 * 订单是否已入账」，带上被邀请人的订单号会让他自己的订单被当成已处理。
 */
export async function creditReferralCommissionInTransaction(input: ReferralCreditInput): Promise<ReferralCommissionResult> {
  return withDatabaseTransaction(async () => {
    // 保存点建不起来就说不清事务处在什么状态，只能往外抛，让整单按失败处理（会重试）。
    await runReferralSavepointStatement(`SAVEPOINT ${REFERRAL_SAVEPOINT}`);
    let result: ReferralCommissionResult;
    try {
      result = await creditReferralCommissionUnprotected(input);
    } catch (error) {
      // 回滚到保存点再释放；这一步也失败说明事务本身坏了，同样只能往外抛。
      await runReferralSavepointStatement(`ROLLBACK TO SAVEPOINT ${REFERRAL_SAVEPOINT}`);
      await runReferralSavepointStatement(`RELEASE SAVEPOINT ${REFERRAL_SAVEPOINT}`);
      console.warn(`[Referral] commission failed and was rolled back, purchase continues source=${input.sourceType}:${input.sourceRef} invitee=${input.inviteeId}: ${error instanceof Error ? error.message : String(error)}`);
      return { credited: false, commissionCents: 0, reason: "error" };
    }
    await runReferralSavepointStatement(`RELEASE SAVEPOINT ${REFERRAL_SAVEPOINT}`);
    if (result.reason === "non_cny") {
      console.warn(`[Referral] skipped non-CNY order source=${input.sourceType}:${input.sourceRef} currency=${input.currency || "-"} invitee=${input.inviteeId}`);
    } else if (result.credited) {
      console.info(`[Referral] commission credited inviter=${result.inviterId} invitee=${input.inviteeId} amount=${result.commissionCents} source=${input.sourceType}:${input.sourceRef}`);
    }
    return result;
  });
}

async function creditReferralCommissionUnprotected(input: ReferralCreditInput): Promise<ReferralCommissionResult> {
  const q = quoteDbIdentifier;
  const settings = await getReferralSettings();
  if (!settings.enabled) return { credited: false, commissionCents: 0, reason: "disabled" };
  const [invitee] = await queryRaw<{ id: number; username: string; inviterId: number | null; inviterBoundAt: unknown; createdAt: unknown }>(
    `SELECT ${q("id")} AS ${q("id")}, ${q("username")} AS ${q("username")}, ${q("inviterId")} AS ${q("inviterId")}, ${q("inviterBoundAt")} AS ${q("inviterBoundAt")}, ${q("createdAt")} AS ${q("createdAt")} FROM ${q("users")} WHERE ${q("id")} = ?`,
    [input.inviteeId],
  );
  const inviterId = Number(invitee?.inviterId || 0) || null;
  let inviterActive = false;
  if (inviterId && inviterId !== input.inviteeId) {
    const [inviter] = await queryRaw<{ id: number; accountEnabled: unknown }>(
      `SELECT ${q("id")} AS ${q("id")}, ${q("accountEnabled")} AS ${q("accountEnabled")} FROM ${q("users")} WHERE ${q("id")} = ?`,
      [inviterId],
    );
    inviterActive = !!inviter && dbBool(inviter.accountEnabled, true);
  }
  const [plan] = await queryRaw<{ id: number; name: string; referralRateBps: number }>(
    `SELECT ${q("id")} AS ${q("id")}, ${q("name")} AS ${q("name")}, ${q("referralRateBps")} AS ${q("referralRateBps")} FROM ${q("subscription_plans")} WHERE ${q("id")} = ?`,
    [input.planId],
  );
  /*
   * 绑定时刻（照上游 poouo/Forwardx affiliateRepository 的语义）：绑定这个邀请人之前下的单不返 ——
   * 管理员后补的邀请人拿不到之前的单。老数据没记绑定时刻，按注册时刻算（那时绑定的只可能是注册时）。
   */
  const boundAtSec = referralEpochSeconds(invitee?.inviterBoundAt) ?? referralEpochSeconds(invitee?.createdAt);
  const orderedAtSec = referralEpochSeconds(input.orderCreatedAt) ?? Math.floor(Date.now() / 1000);
  const orderedBeforeInviterBound = !!inviterId && boundAtSec !== null && orderedAtSec < boundAtSec;
  /*
   * 首单 = 这个人之前没有付过钱的套餐单（在线支付已完成的套餐单，或余额买套餐 / 自动续费的扣款），
   * 不看「返没返过」：返利关着时买的、绑定邀请人之前买的、比例为 0 的套餐都算。
   * 当前这一单自己不算（在线支付按订单号排除，余额购买按扣款流水 id 排除）。
   */
  let hasPriorPaidOrder = false;
  if (settings.mode === "first" && inviterId) {
    hasPriorPaidOrder = await inviteeHasPriorPaidPlanOrder(input.inviteeId, input.sourceType, input.sourceRef);
  }
  const baseAmountCents = Math.floor(Number(input.baseAmountCents || 0));
  const decision = evaluateReferralCommission({
    enabled: settings.enabled,
    mode: settings.mode,
    inviteeId: input.inviteeId,
    inviterId,
    inviterActive,
    rateBps: Number(plan?.referralRateBps || 0),
    baseAmountCents,
    currency: input.currency,
    hasPriorPaidOrder,
    orderedBeforeInviterBound,
  });
  if (!decision.eligible) return { credited: false, commissionCents: 0, inviterId, reason: decision.reason };

  const planName = String(input.planName || plan?.name || `套餐 #${input.planId}`);
  const row: Array<[string, unknown]> = [
    ["inviterId", inviterId],
    ["inviteeId", input.inviteeId],
    ["sourceType", input.sourceType],
    ["sourceRef", input.sourceRef],
    ["planId", input.planId],
    ["planName", planName],
    ["baseAmountCents", baseAmountCents],
    ["rateBps", decision.rateBps],
    ["commissionCents", decision.commissionCents],
    ["mode", settings.mode],
    ["createdAt", Math.floor(Date.now() / 1000)],
  ];
  const columnSql = row.map(([column]) => q(column)).join(", ");
  const placeholders = row.map(() => "?").join(", ");
  const insertSql = getDatabaseKind() === "mysql"
    ? `INSERT IGNORE INTO ${q("referral_commissions")} (${columnSql}) VALUES (${placeholders})`
    : `INSERT INTO ${q("referral_commissions")} (${columnSql}) VALUES (${placeholders}) ON CONFLICT (${q("sourceType")}, ${q("sourceRef")}) DO NOTHING`;
  const inserted = rawAffectedRows(await executeRaw(insertSql, row.map(([, value]) => value)));
  if (inserted <= 0) return { credited: false, commissionCents: 0, inviterId, reason: "duplicate" };

  await addUserBalanceInTransaction(inviterId as number, decision.commissionCents, {
    type: "referral_commission",
    description: `邀请返利：${maskUsername(invitee?.username)} 购买套餐「${planName}」，返利 ${formatRateBps(decision.rateBps)}%`,
    // 故意不带 paymentOrderNo，见 creditReferralCommissionInTransaction 的说明。
    paymentOrderNo: null,
  } as any);
  return { credited: true, commissionCents: decision.commissionCents, inviterId };
}

// ==================== Redemption Codes ====================


function redemptionCodesListQuery(db: any) {
  return db
    .select({
      id: redemptionCodes.id,
      code: redemptionCodes.code,
      type: redemptionCodes.type,
      planId: redemptionCodes.planId,
      planName: subscriptionPlans.name,
      durationDays: redemptionCodes.durationDays,
      amountCents: redemptionCodes.amountCents,
      startsAt: redemptionCodes.startsAt,
      expiresAt: redemptionCodes.expiresAt,
      isActive: redemptionCodes.isActive,
      usedByUserId: redemptionCodes.usedByUserId,
      usedByUsername: users.username,
      usedAt: redemptionCodes.usedAt,
      createdByUserId: redemptionCodes.createdByUserId,
      createdAt: redemptionCodes.createdAt,
      updatedAt: redemptionCodes.updatedAt,
    })
    .from(redemptionCodes)
    .leftJoin(subscriptionPlans, eq(redemptionCodes.planId, subscriptionPlans.id))
    .leftJoin(users, eq(redemptionCodes.usedByUserId, users.id));
}

export async function listRedemptionCodes() {
  const db = await getDb();
  if (!db) return [];
  return redemptionCodesListQuery(db).orderBy(desc(redemptionCodes.createdAt), desc(redemptionCodes.id));
}

export async function listRedemptionCodesPage(input: PageRequest & {
  usage?: "all" | "unused" | "used";
}) {
  const db = await getDb();
  if (!db) return pageResult([], 0, input, 50);
  const condition = input.usage === "unused"
    ? and(isNull(redemptionCodes.usedAt), isNull(redemptionCodes.usedByUserId))
    : input.usage === "used"
      ? or(isNotNull(redemptionCodes.usedAt), isNotNull(redemptionCodes.usedByUserId))
      : undefined;
  const aggregate = db.select({ count: sql<number>`COUNT(*)` }).from(redemptionCodes);
  const [totals] = condition ? await aggregate.where(condition) : await aggregate;
  const totalItems = Number(totals?.count || 0);
  const window = pageWindowForTotal(input, totalItems, 50);
  const query = redemptionCodesListQuery(db);
  const items = condition
    ? await query
      .where(condition)
      .orderBy(desc(redemptionCodes.createdAt), desc(redemptionCodes.id))
      .limit(window.pageSize)
      .offset(window.offset)
    : await query
      .orderBy(desc(redemptionCodes.createdAt), desc(redemptionCodes.id))
      .limit(window.pageSize)
      .offset(window.offset);
  return pageResult(items, totalItems, window, 50);
}

export async function createRedemptionCodes(data: Omit<InsertRedemptionCode, "code"> & { code?: string }, count = 1) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const created: string[] = [];
  const total = Math.max(1, Math.min(500, Math.floor(count)));
  for (let i = 0; i < total; i++) {
    const code = normalizeCode(i === 0 && data.code ? data.code : generateBillingCode("FXR"));
    await db.insert(redemptionCodes).values({ ...data, code } as any);
    created.push(code);
  }
  return created;
}

export async function deleteRedemptionCode(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(redemptionCodes).where(eq(redemptionCodes.id, id));
}

export async function redeemCode(userId: number, code: string, attemptScope?: string | null) {
  return withTrafficBillingUserLock(userId, () => withRedemptionScopeLock(userId, attemptScope, async () => {
    const limited = redemptionAttemptRateLimitState(userId, attemptScope);
    if (limited.limited) {
      throw new Error(`兑换过于频繁，请 ${limited.retryAfterSeconds} 秒后再试`);
    }
    const normalized = normalizeCode(code);
    try {
      return await withRedemptionCodeLock(normalized, async () => {
        return withDatabaseTransaction(async () => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        const q = quoteDbIdentifier;
        const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
        const lockedRows = await queryRaw<{ id: number }>(
          `SELECT ${q("id")} AS ${q("id")} FROM ${q("redemption_codes")} WHERE ${q("code")} = ? LIMIT 1${lock}`,
          [normalized],
        );
        const rows = lockedRows[0]
          ? await db.select().from(redemptionCodes).where(eq(redemptionCodes.id, Number(lockedRows[0].id))).limit(1)
          : [];
        const item = rows[0] as any;
        if (!item || !item.isActive) throw new Error("兑换码无效");
        if (item.usedAt || item.usedByUserId) throw new Error("兑换码已被使用");
        const now = new Date();
        if (item.startsAt && new Date(item.startsAt).getTime() > now.getTime()) throw new Error("兑换码尚未生效");
        if (item.expiresAt && new Date(item.expiresAt).getTime() <= now.getTime()) throw new Error("兑换码已过期");
        if (item.type === "balance") {
          if (Number(item.amountCents) <= 0) throw new Error("兑换码金额无效");
          const balance = await addUserBalance(userId, Number(item.amountCents), {
            type: "redeem",
            description: `兑换余额：${normalized}`,
            redemptionCodeId: item.id,
          } as any);
          await db.update(redemptionCodes).set({ usedByUserId: userId, usedAt: nowDate(), updatedAt: nowDate() } as any).where(eq(redemptionCodes.id, item.id));
          clearRedemptionAttemptFailures(userId, attemptScope);
          return {
            success: true,
            type: item.type,
            amountCents: Number(item.amountCents),
            balanceCents: Number((balance as any)?.balanceCents || 0),
          };
        } else if (item.type === "plan") {
          if (!item.planId) throw new Error("兑换码套餐无效");
          const subscription = await applySubscriptionToUser(userId, Number(item.planId), "redeem", null, now, item.durationDays || null);
          const plan = await getSubscriptionPlanById(Number(item.planId));
          await db.update(redemptionCodes).set({ usedByUserId: userId, usedAt: nowDate(), updatedAt: nowDate() } as any).where(eq(redemptionCodes.id, item.id));
          clearRedemptionAttemptFailures(userId, attemptScope);
          return {
            success: true,
            type: item.type,
            planId: Number(item.planId),
            planName: (plan as any)?.name || null,
            durationDays: Number(item.durationDays || 0),
            expiresAt: subscription.expiresAt,
            portRangeStart: subscription.portRangeStart,
            portRangeEnd: subscription.portRangeEnd,
          };
        } else {
          throw new Error("兑换码类型无效");
        }
        });
      });
    } catch (error) {
      const message = String((error as any)?.message || error || "");
      if (message !== "Database not available" && !message.includes("兑换过于频繁")) {
        recordRedemptionAttemptFailure(userId, attemptScope);
      }
      throw error;
    }
  }));
}

// ==================== Discount Codes ====================


export async function listDiscountCodes() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(discountCodes).orderBy(desc(discountCodes.createdAt), desc(discountCodes.id));
  return attachDiscountPlans(rows);
}

export async function listDiscountCodesPage(input: PageRequest) {
  const db = await getDb();
  if (!db) return pageResult([], 0, input, 50);
  const [totals] = await db.select({ count: sql<number>`COUNT(*)` }).from(discountCodes);
  const totalItems = Number(totals?.count || 0);
  const window = pageWindowForTotal(input, totalItems, 50);
  const rows = await db
    .select()
    .from(discountCodes)
    .orderBy(desc(discountCodes.createdAt), desc(discountCodes.id))
    .limit(window.pageSize)
    .offset(window.offset);
  return pageResult(await attachDiscountPlans(rows), totalItems, window, 50);
}

async function attachDiscountPlans<T extends { id: number }>(codes: T[]) {
  const db = await getDb();
  if (!db || codes.length === 0) return codes.map((code) => ({ ...code, planIds: [] as number[] }));
  const ids = codes.map((code) => Number(code.id)).filter((id) => id > 0);
  const rows = await db
    .select({
      discountCodeId: discountCodePlans.discountCodeId,
      planId: discountCodePlans.planId,
    })
    .from(discountCodePlans)
    .where(inArray(discountCodePlans.discountCodeId, ids));
  const planIdsByCode = new Map<number, number[]>();
  for (const row of rows as any[]) {
    const codeId = Number(row.discountCodeId);
    const values = planIdsByCode.get(codeId) || [];
    values.push(Number(row.planId));
    planIdsByCode.set(codeId, values);
  }
  return codes.map((code) => ({
    ...code,
    planIds: planIdsByCode.get(Number(code.id)) || [],
  }));
}

export async function setDiscountCodePlans(discountCodeId: number, planIds: number[]) {
  const db = await getDb();
  if (!db) return;
  await db.delete(discountCodePlans).where(eq(discountCodePlans.discountCodeId, discountCodeId));
  const uniquePlanIds = Array.from(new Set(planIds.filter(id => Number(id) > 0).map(Number)));
  if (uniquePlanIds.length > 0) {
    await db.insert(discountCodePlans).values(uniquePlanIds.map(planId => ({ discountCodeId, planId })));
  }
}

export async function createDiscountCode(data: InsertDiscountCode, planIds: number[] = []) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const code = normalizeCode(data.code || generateBillingCode("FXD"));
  await db.insert(discountCodes).values({ ...data, code } as any);
  const created = await getDiscountCodeByCode(code);
  if (created) await setDiscountCodePlans(created.id, planIds);
  return getDiscountCodeByCode(code);
}

export async function deleteDiscountCode(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(discountCodePlans).where(eq(discountCodePlans.discountCodeId, id));
  await db.delete(discountCodes).where(eq(discountCodes.id, id));
}

export async function getDiscountCodeById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(discountCodes).where(eq(discountCodes.id, id)).limit(1);
  if (!rows[0]) return undefined;
  return (await attachDiscountPlans([rows[0]]))[0];
}

export async function getDiscountCodeByCode(code: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(discountCodes).where(eq(discountCodes.code, normalizeCode(code))).limit(1);
  if (!rows[0]) return undefined;
  return (await attachDiscountPlans([rows[0]]))[0];
}

export function discountCodeStatus(code: any) {
  const now = Date.now();
  if (!code?.isActive) return "disabled";
  if (code.startsAt && new Date(code.startsAt).getTime() > now) return "pending";
  if (code.expiresAt && new Date(code.expiresAt).getTime() <= now) return "expired";
  if (Number(code.maxUses || 0) > 0 && Number(code.usedCount || 0) >= Number(code.maxUses)) return "used_up";
  return "active";
}

export function calculateDiscountedAmount(amountCents: number, code: any | null | undefined) {
  const amount = Math.max(0, Math.round(amountCents));
  if (!code) return amount;
  if (discountCodeStatus(code) !== "active") throw new Error("折扣码不可用");
  if (code.discountType === "percent") {
    const pct = Math.max(0, Math.min(100, Number(code.discountValue || 0)));
    return Math.max(0, Math.round(amount * (100 - pct) / 100));
  }
  const discount = Math.max(0, Number(code.discountValue || 0));
  return Math.max(0, amount - discount);
}

/**
 * 预览折扣：算给用户看「这张折扣码能省多少」。
 *
 * 这条路原来**一点频率限制都没有**，而隔壁兑换码那条路有（按用户 8 次、按来源
 * 20 次，超了封 15 分钟）。两条都是「拿一个码来问对不对」，但只有一条上了锁 ——
 * 门锁了，旁边的窗户开着。
 *
 * 为什么要紧：折扣码是管理员手打的（`SALE50` 这类），好猜；而这个接口对不存在的
 * 码直接回「折扣码不存在」，是个干净的探测口。任何登录用户都能全速试，把商家还
 * 没公布的、或者只发给某个客户的码翻出来，然后自己在结账时用掉。
 *
 * 所以复用兑换码那一套计数器，但**单独记一类账** —— 正常结账时预览一两次不该
 * 把兑换码的额度吃掉，反过来也是。
 */
export async function previewDiscount(
  code: string,
  amountCents: number,
  planId?: number | null,
  actor?: { userId: number; attemptScope?: string | null },
) {
  const limiterUserId = Number(actor?.userId || 0);
  const limited = limiterUserId
    ? redemptionAttemptRateLimitState(limiterUserId, actor?.attemptScope, "discount")
    : { limited: false, retryAfterSeconds: 0 };
  if (limited.limited) {
    throw new Error(`折扣码试得太频繁，请 ${limited.retryAfterSeconds} 秒后再试`);
  }
  const noteFailure = () => {
    if (limiterUserId) recordRedemptionAttemptFailure(limiterUserId, actor?.attemptScope, "discount");
  };
  const item = await getDiscountCodeByCode(code);
  if (!item) {
    noteFailure();
    throw new Error("折扣码不存在");
  }
  const allowedPlanIds = Array.isArray((item as any).planIds) ? (item as any).planIds.map(Number) : [];
  if (allowedPlanIds.length > 0 && (!planId || !allowedPlanIds.includes(Number(planId)))) {
    /*
      「码是对的、但不适用于这个套餐」**不计入失败**。

      我一开始把它也算进去了，理由是「不然拿一个已知有效的码去遍历套餐 id，
      能把它适用哪些套餐问出来」。真面板上一跑就看出这个理由站不住：
      要遍历套餐，前提是**已经拿到一个有效码**了 —— 而拿到有效码这件事本身
      走的是「不存在」那条路，那条是计数的。挡住了前面，后面这点信息不值得。

      代价却是实打实的：结账时手里有几张码、试到一张是别的套餐的，就白扣一次
      额度；扣满 8 次，人就被挡在付款外面 15 分钟。**拦试码的人，不该拦正在
      掏钱的人。**
    */
    throw new Error("折扣码不适用于该套餐");
  }
  const finalAmountCents = calculateDiscountedAmount(amountCents, item);
  return {
    discountCodeId: item.id,
    code: item.code,
    originalAmountCents: amountCents,
    finalAmountCents,
    discountAmountCents: Math.max(0, amountCents - finalAmountCents),
    status: discountCodeStatus(item),
  };
}

export async function consumeDiscountCode(id: number) {
  const q = quoteDbIdentifier;
  const now = Math.floor(Date.now() / 1000);
  const result = await executeRaw(
    `UPDATE ${q("discount_codes")}
        SET ${q("usedCount")} = ${q("usedCount")} + 1, ${q("updatedAt")} = ?
      WHERE ${q("id")} = ?
        AND ${q("isActive")} = ?
        AND (${q("startsAt")} IS NULL OR ${q("startsAt")} <= ?)
        AND (${q("expiresAt")} IS NULL OR ${q("expiresAt")} > ?)
        AND (${q("maxUses")} <= 0 OR ${q("usedCount")} < ${q("maxUses")})`,
    [now, id, true, now, now],
  );
  if (rawAffectedRows(result) !== 1) throw new Error("折扣码已失效或使用次数已达上限");
  return true;
}

export async function releaseDiscountCode(id: number) {
  const q = quoteDbIdentifier;
  const result = await executeRaw(
    `UPDATE ${q("discount_codes")}
        SET ${q("usedCount")} = ${q("usedCount")} - 1, ${q("updatedAt")} = ?
      WHERE ${q("id")} = ? AND ${q("usedCount")} > 0`,
    [Math.floor(Date.now() / 1000), id],
  );
  return rawAffectedRows(result) === 1;
}

export async function listPaymentOrders(limit = 100, userId?: number, selectedIds?: number[]) {
  const db = await getDb();
  if (!db || selectedIds?.length === 0) return [];
  const base = db
    .select({
      id: paymentOrders.id,
      outTradeNo: paymentOrders.outTradeNo,
      userId: paymentOrders.userId,
      username: users.username,
      name: users.name,
      provider: paymentOrders.provider,
      paymentType: paymentOrders.paymentType,
      status: paymentOrders.status,
      subject: paymentOrders.subject,
      amountCents: paymentOrders.amountCents,
      currency: paymentOrders.currency,
      tradeNo: paymentOrders.tradeNo,
      payUrl: paymentOrders.payUrl,
      qrCode: paymentOrders.qrCode,
      orderType: paymentOrders.orderType,
      planId: paymentOrders.planId,
      subscriptionId: paymentOrders.subscriptionId,
      discountCodeId: paymentOrders.discountCodeId,
      discountConsumed: paymentOrders.discountConsumed,
      discountAmountCents: paymentOrders.discountAmountCents,
      expiresAt: paymentOrders.expiresAt,
      paidAt: paymentOrders.paidAt,
      createdAt: paymentOrders.createdAt,
      updatedAt: paymentOrders.updatedAt,
    })
    .from(paymentOrders)
    .leftJoin(users, eq(paymentOrders.userId, users.id));
  const conditions = [
    ...(userId !== undefined ? [eq(paymentOrders.userId, userId)] : []),
    ...(selectedIds ? [inArray(paymentOrders.id, selectedIds)] : []),
  ];
  return base.where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(desc(paymentOrders.createdAt), desc(paymentOrders.id)).limit(limit);
}

export async function updatePaymentOrder(outTradeNo: string, data: Partial<InsertPaymentOrder>) {
  const db = await getDb();
  if (!db) return undefined;
  await db
    .update(paymentOrders)
    .set({ ...data, updatedAt: nowDate() } as Partial<InsertPaymentOrder>)
    .where(eq(paymentOrders.outTradeNo, outTradeNo));
  return getPaymentOrderByOutTradeNo(outTradeNo);
}

function affectedRows(result: any) {
  return rawAffectedRows(result);
}

export async function claimPaidPaymentOrder(outTradeNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const result = await executeRaw(
    `UPDATE ${quoteDbIdentifier("payment_orders")}
     SET ${quoteDbIdentifier("status")} = ?, ${quoteDbIdentifier("updatedAt")} = ?
     WHERE ${quoteDbIdentifier("outTradeNo")} = ? AND ${quoteDbIdentifier("status")} = ?`,
    ["processing", now, outTradeNo, "paid"],
  );
  if (affectedRows(result) <= 0) return undefined;
  return getPaymentOrderByOutTradeNo(outTradeNo);
}

export async function resetStaleProcessingPaymentOrder(outTradeNo: string, before: Date) {
  const db = await getDb();
  if (!db) return false;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = Math.floor(before.getTime() / 1000);
  const result = await executeRaw(
    `UPDATE ${quoteDbIdentifier("payment_orders")}
     SET ${quoteDbIdentifier("status")} = ?, ${quoteDbIdentifier("updatedAt")} = ?
     WHERE ${quoteDbIdentifier("outTradeNo")} = ?
       AND ${quoteDbIdentifier("status")} = ?
       AND ${quoteDbIdentifier("updatedAt")} < ?`,
    ["paid", now, outTradeNo, "processing", cutoff],
  );
  return affectedRows(result) > 0;
}

export async function markPaymentOrderPaid(outTradeNo: string, data: { tradeNo?: string | null; rawNotify?: string | null; amountCents?: number; currency?: string }) {
  const now = nowDate();
  const result = await executeRaw(
    `UPDATE ${quoteDbIdentifier("payment_orders")}
     SET ${quoteDbIdentifier("status")} = ?,
         ${quoteDbIdentifier("tradeNo")} = COALESCE(?, ${quoteDbIdentifier("tradeNo")}),
         ${quoteDbIdentifier("rawNotify")} = COALESCE(?, ${quoteDbIdentifier("rawNotify")}),
         ${quoteDbIdentifier("currency")} = COALESCE(?, ${quoteDbIdentifier("currency")}),
         ${quoteDbIdentifier("paidAt")} = ?,
         ${quoteDbIdentifier("updatedAt")} = ?
     WHERE ${quoteDbIdentifier("outTradeNo")} = ?
       AND ${quoteDbIdentifier("status")} = ?`,
    [
      "paid",
      data.tradeNo || null,
      data.rawNotify || null,
      data.currency || null,
      now,
      now,
      outTradeNo,
      "pending",
    ],
  );
  if (affectedRows(result) > 0) return getPaymentOrderByOutTradeNo(outTradeNo);

  // A duplicate callback for an already claimed/completed order is harmless,
  // but terminal failed/expired/cancelled orders must never be reactivated.
  const existing = await getPaymentOrderByOutTradeNo(outTradeNo);
  if (!existing) return undefined;
  if (existing.status === "paid" || existing.status === "processing" || existing.status === "completed") {
    return updatePaymentOrder(outTradeNo, {
      tradeNo: data.tradeNo || existing.tradeNo,
      rawNotify: data.rawNotify || existing.rawNotify,
    } as Partial<InsertPaymentOrder>);
  }
  return existing;
}

/** Return orders needing background maintenance without a recent-row limit. */
export async function listPaymentOrdersForMaintenance(statuses: string[], limit = 1000) {
  const db = await getDb();
  if (!db || statuses.length === 0) return [];
  return db
    .select()
    .from(paymentOrders)
    .where(inArray(paymentOrders.status, statuses as any))
    .orderBy(asc(paymentOrders.updatedAt))
    .limit(Math.max(1, Math.min(10000, limit)));
}

export async function getBalanceTransactionByPaymentOrderNo(paymentOrderNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(balanceTransactions).where(eq(balanceTransactions.paymentOrderNo, paymentOrderNo)).limit(1);
  return rows[0];
}

export async function getUserSubscriptionByPaymentOrderNo(paymentOrderNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(userSubscriptions).where(eq(userSubscriptions.paymentOrderNo, paymentOrderNo)).limit(1);
  return rows[0];
}

export async function getPaymentOrderStats() {
  const db = await getDb();
  if (!db) return { totalOrders: 0, pendingOrders: 0, paidOrders: 0, paidAmountCents: 0 };
  const rows = await db
    .select({
      totalOrders: sql<number>`COUNT(*)`,
      pendingOrders: sql<number>`SUM(CASE WHEN ${paymentOrders.status} = 'pending' THEN 1 ELSE 0 END)`,
      paidOrders: sql<number>`SUM(CASE WHEN ${paymentOrders.status} IN ('paid', 'processing', 'completed') THEN 1 ELSE 0 END)`,
      paidAmountCents: sql<number>`COALESCE(SUM(CASE WHEN ${paymentOrders.status} IN ('paid', 'processing', 'completed') THEN ${paymentOrders.amountCents} ELSE 0 END), 0)`,
    })
    .from(paymentOrders);
  const row = rows[0];
  return {
    totalOrders: Number(row?.totalOrders || 0),
    pendingOrders: Number(row?.pendingOrders || 0),
    paidOrders: Number(row?.paidOrders || 0),
    paidAmountCents: Number(row?.paidAmountCents || 0),
  };
}


