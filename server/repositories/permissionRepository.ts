import { and, eq, inArray, sql } from "drizzle-orm";
import {
  forwardRules,
  forwardGroups,
  hosts,
  proxyNodeShares,
  tunnels,
  userForwardGroupPermissions,
  userHostPermissions,
  userSubscriptions,
  userTunnelPermissions,
} from "../../drizzle/schema";
import { getDb } from "../dbRuntime";
import { sqlCountAll, sqlCountDistinct } from "../dbCompat";
import { getActiveUserSubscriptions } from "./billingRepository";
import { getTrafficBillingAccessSnapshot, getUserUsableTrafficBillingResourceIds } from "./trafficBillingRepository";
import { clearLinkAccessScopeCache } from "../linkAccessView";

let lastPermissionLookupWarningAt = 0;

function warnPermissionLookupFailure(error: unknown) {
  const now = Date.now();
  if (now - lastPermissionLookupWarningAt < 60_000) return;
  lastPermissionLookupWarningAt = now;
  console.warn("[Permissions] optional resource lookup failed; direct user-owned resources remain available:", error instanceof Error ? error.message : String(error));
}

// ==================== User-Host Permissions ====================

function compareTunnelDisplayOrder(a: any, b: any) {
  const sortA = Number(a?.sortOrder || 0);
  const sortB = Number(b?.sortOrder || 0);
  if (sortA !== sortB) return sortA - sortB;
  const createdA = Number(a?.createdAt || 0);
  const createdB = Number(b?.createdAt || 0);
  if (createdA !== createdB) return createdB - createdA;
  return Number(b?.id || 0) - Number(a?.id || 0);
}

/** 获取某用户被授权的主机ID列表 */
export async function getUserAllowedHostIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ hostId: userHostPermissions.hostId }).from(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  return rows.map((r: any) => r.hostId);
}

export async function getUserEffectiveAllowedHostIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ hostId: userHostPermissions.hostId }).from(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  const planRows = await _getActiveSubscriptionHostIds(userId);
  return Array.from(new Set([...rows.map((r: any) => r.hostId), ...planRows]));
}

async function _getActiveSubscriptionHostIds(userId: number): Promise<number[]> {
  const active = await getActiveUserSubscriptions(userId);
  const ids = new Set<number>();
  for (const sub of active as any[]) {
    for (const hostId of sub.hostIds || []) ids.add(Number(hostId));
  }
  return Array.from(ids);
}

async function _getActiveSubscriptionTunnelIds(userId: number): Promise<number[]> {
  const active = await getActiveUserSubscriptions(userId);
  const ids = new Set<number>();
  for (const sub of active as any[]) {
    for (const tunnelId of sub.tunnelIds || []) ids.add(Number(tunnelId));
  }
  return Array.from(ids);
}

async function _getActiveSubscriptionForwardGroupIds(userId: number): Promise<number[]> {
  const active = await getActiveUserSubscriptions(userId);
  const ids = new Set<number>();
  for (const sub of active as any[]) {
    for (const forwardGroupId of sub.forwardGroupIds || []) ids.add(Number(forwardGroupId));
  }
  return Array.from(ids);
}

/** 设置某用户的主机权限（全量替换） */
export async function setUserHostPermissions(userId: number, hostIds: number[]) {
  const db = await getDb();
  if (!db) return;
  // 先删除旧权限
  await db.delete(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  // 插入新权限
  if (hostIds.length > 0) {
    await db.insert(userHostPermissions).values(hostIds.map(hostId => ({ userId, hostId })));
  }
  clearLinkAccessScopeCache();
}

/** 检查用户是否有某主机的使用权限 */
export async function checkUserHostPermission(userId: number, hostId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select().from(userHostPermissions).where(
    and(eq(userHostPermissions.userId, userId), eq(userHostPermissions.hostId, hostId))
  ).limit(1);
  if (rows.length > 0) return true;
  const planHostIds = await _getActiveSubscriptionHostIds(userId);
  return planHostIds.includes(hostId);
}

/**
 * checkUserHostPermission 的批量版：这批主机里哪些该用户有使用权限（直接授权或有效套餐附带）。
 *
 * 口径与单个版本一致：先看 user_host_permissions，没有的再看有效套餐。单个版本在
 * 列表接口里被逐台调用，一次 500 台就是上千次查询；这里是一次 IN 查询，外加至多一次套餐查询。
 */
export async function getUserPermittedHostIdsAmong(userId: number, hostIds: readonly number[]): Promise<Set<number>> {
  const permitted = new Set<number>();
  const wanted = Array.from(new Set(hostIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return permitted;
  const db = await getDb();
  if (!db) return permitted;
  const rows = await db.select({ hostId: userHostPermissions.hostId }).from(userHostPermissions).where(
    and(eq(userHostPermissions.userId, userId), inArray(userHostPermissions.hostId, wanted))
  );
  for (const row of rows as any[]) permitted.add(Number(row.hostId));
  if (wanted.every((id) => permitted.has(id))) return permitted;
  const planHostIds = await _getActiveSubscriptionHostIds(userId);
  for (const id of planHostIds) {
    if (wanted.includes(id)) permitted.add(id);
  }
  return permitted;
}

/** 删除主机时清理相关权限 */
export async function deleteHostPermissions(hostId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userHostPermissions).where(eq(userHostPermissions.hostId, hostId));
}

/** 删除用户时清理相关权限 */
export async function deleteUserPermissions(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  await db.delete(userTunnelPermissions).where(eq(userTunnelPermissions.userId, userId));
  // 分享给他的节点记录也清掉：留着就是一条指向不存在用户的分享，
  // 节点主人那边还显示「已分享给 1 人」。
  await db.delete(proxyNodeShares).where(eq(proxyNodeShares.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  clearLinkAccessScopeCache();
}

// ==================== User Rule/Port Count ====================

/** 获取某用户的规则数量 */
export async function getUserRuleCount(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.select({ count: sqlCountAll() }).from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
    // 线路组的中继规则是面板生成的，不算用户的配额。
    sql`${forwardRules.routeParentRuleId} IS NULL`,
  ));
  return Number(r[0]?.count) || 0;
}

/**
 * 获取某用户使用的端口数量（去重）。
 *
 * 线路组的中继规则算在内：它们是替这个用户在中转机上开的真实监听，一条规则最多能开出几十个。
 * 规则数（getUserRuleCount）不算它们 —— 那是面板生成的，不是用户建的规则。
 */
export async function getUserPortCount(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.select({ count: sqlCountDistinct(forwardRules.sourcePort) }).from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
    // 挂在共享 TLS 入站上的规则没有自己的对外端口（sourcePort 是本机回环端口），不占端口额度。
    sql`${forwardRules.tlsInboundId} IS NULL`,
  ));
  return Number(r[0]?.count) || 0;
}

/** 获取所有用户的主机权限映射 */
export async function getAllUserHostPermissions(): Promise<Array<{ userId: number; hostId: number }>> {
  const db = await getDb();
  if (!db) return [];
  return db.select({ userId: userHostPermissions.userId, hostId: userHostPermissions.hostId }).from(userHostPermissions);
}

export async function getAllUserTunnelPermissions(): Promise<Array<{ userId: number; tunnelId: number }>> {
  const db = await getDb();
  if (!db) return [];
  const manual = await db.select({ userId: userTunnelPermissions.userId, tunnelId: userTunnelPermissions.tunnelId }).from(userTunnelPermissions);
  const active = await getActiveUserSubscriptions();
  const out = [...manual];
  for (const sub of active) {
    for (const tunnelId of (sub as any).tunnelIds || []) out.push({ userId: sub.userId, tunnelId });
  }
  return out;
}

export async function getUserAllowedTunnelIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ tunnelId: userTunnelPermissions.tunnelId }).from(userTunnelPermissions).where(eq(userTunnelPermissions.userId, userId));
  return rows.map((r: any) => r.tunnelId);
}

export async function getUserEffectiveAllowedTunnelIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ tunnelId: userTunnelPermissions.tunnelId }).from(userTunnelPermissions).where(eq(userTunnelPermissions.userId, userId));
  const planRows = await _getActiveSubscriptionTunnelIds(userId);
  return Array.from(new Set([...rows.map((r: any) => r.tunnelId), ...planRows]));
}

export async function getUserManualAllowedForwardGroupIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ forwardGroupId: userForwardGroupPermissions.forwardGroupId }).from(userForwardGroupPermissions).where(eq(userForwardGroupPermissions.userId, userId));
  return rows.map((r: any) => Number(r.forwardGroupId)).filter((id: number) => Number.isFinite(id) && id > 0);
}

export async function getUserAllowedForwardGroupIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const [ownedRows, manualRows, planRows, billingSnapshot] = await Promise.all([
    db.select({ id: forwardGroups.id }).from(forwardGroups).where(eq(forwardGroups.userId, userId)).catch((error: unknown) => {
      warnPermissionLookupFailure(error);
      return [];
    }),
    getUserManualAllowedForwardGroupIds(userId).catch((error) => {
      warnPermissionLookupFailure(error);
      return [];
    }),
    _getActiveSubscriptionForwardGroupIds(userId).catch((error) => {
      warnPermissionLookupFailure(error);
      return [];
    }),
    getTrafficBillingAccessSnapshot(userId),
  ]);
  if (billingSnapshot.status === "failed") return [];
  const allowedIds = new Set([
    ...ownedRows.map((row: any) => Number(row.id)),
    ...manualRows,
    ...planRows,
  ]);
  for (const id of billingSnapshot.activeResourceIds.forwardGroupIds) allowedIds.delete(Number(id));
  for (const id of billingSnapshot.usableResourceIds.forwardGroupIds) allowedIds.add(Number(id));
  return Array.from(allowedIds);
}

export async function setUserForwardGroupPermissions(userId: number, forwardGroupIds: number[]) {
  const db = await getDb();
  if (!db) return;
  const uniqueIds = Array.from(new Set(forwardGroupIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)));
  await db.delete(userForwardGroupPermissions).where(eq(userForwardGroupPermissions.userId, userId));
  if (uniqueIds.length > 0) {
    await db.insert(userForwardGroupPermissions).values(uniqueIds.map((forwardGroupId) => ({ userId, forwardGroupId })));
  }
  clearLinkAccessScopeCache();
}

export async function checkUserForwardGroupPermission(userId: number, forwardGroupId: number): Promise<boolean> {
  const allowedIds = await getUserAllowedForwardGroupIds(userId);
  return allowedIds.includes(Number(forwardGroupId));
}

export async function getTunnelsForUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const owned = await db.select().from(tunnels).where(eq(tunnels.userId, userId));
  const [allowedTunnelIds, billingResourceIds] = await Promise.all([
    getUserEffectiveAllowedTunnelIds(userId),
    getUserUsableTrafficBillingResourceIds(userId),
  ]);
  const allAllowedTunnelIds = Array.from(new Set([...allowedTunnelIds, ...billingResourceIds.tunnelIds]));
  if (allAllowedTunnelIds.length === 0) return owned.sort(compareTunnelDisplayOrder);
  const ids = new Set(allAllowedTunnelIds);
  const all = await db.select().from(tunnels);
  const merged = new Map<number, any>();
  for (const tunnel of owned) merged.set(tunnel.id, tunnel);
  for (const tunnel of all) {
    if (ids.has(tunnel.id)) merged.set(tunnel.id, tunnel);
  }
  return Array.from(merged.values()).sort(compareTunnelDisplayOrder);
}

export async function setUserTunnelPermissions(userId: number, tunnelIds: number[]) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userTunnelPermissions).where(eq(userTunnelPermissions.userId, userId));
  if (tunnelIds.length > 0) {
    await db.insert(userTunnelPermissions).values(tunnelIds.map(tunnelId => ({ userId, tunnelId })));
  }
  clearLinkAccessScopeCache();
}

export async function checkUserTunnelPermission(userId: number, tunnelId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select().from(userTunnelPermissions).where(
    and(eq(userTunnelPermissions.userId, userId), eq(userTunnelPermissions.tunnelId, tunnelId))
  ).limit(1);
  if (rows.length > 0) return true;
  const planTunnelIds = await _getActiveSubscriptionTunnelIds(userId);
  return planTunnelIds.includes(tunnelId);
}

