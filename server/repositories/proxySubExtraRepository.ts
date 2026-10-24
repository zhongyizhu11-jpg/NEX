/**
 * 订阅系统升级后多出来的几张表：拉取日志、设备、模板、外部订阅；以及令牌的几个新查询。
 *
 * 和 proxySubscriptionRepository 分开是为了不让那个文件再长一千行；都从 server/db.ts 汇总导出。
 */

import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";

import {
  proxyNodes,
  proxySubAccessLogs,
  proxySubDevices,
  proxySubSources,
  proxySubTemplates,
  proxySubTokens,
  subscriptionPlans,
  userSubscriptions,
  users,
  type InsertProxySubSource,
  type InsertProxySubTemplate,
} from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { deleteExpiredHistoryRows } from "./historyRetention";
import { normalizeProxySubAlias } from "../../shared/proxySubTokenScope";
import { parseProxySubCustomGroupsJson, PROXY_SUB_TEMPLATE_TARGETS, type ProxySubTemplate, type ProxySubTemplateTarget } from "../../shared/proxySubTemplates";
import { invalidateProxySubCacheAll, invalidateProxySubCacheForUser } from "../proxySubCache";

// ==================== 拉取日志 ====================

export type ProxySubAccessLogInput = {
  tokenId: number;
  userId: number;
  ip: string;
  userAgent: string;
  clientFamily: string;
  clientVersion: string;
  format: string;
  profile: boolean;
  result: string;
  hwid: string;
  bytes: number;
};

export async function recordProxySubAccessLog(input: ProxySubAccessLogInput) {
  const db = await getDb();
  if (!db) return;
  await db.insert(proxySubAccessLogs).values({
    tokenId: Number(input.tokenId),
    userId: Number(input.userId),
    at: nowDate(),
    ip: String(input.ip || "").slice(0, 64) || null,
    userAgent: String(input.userAgent || "").slice(0, 200) || null,
    clientFamily: String(input.clientFamily || "").slice(0, 32) || null,
    clientVersion: String(input.clientVersion || "").slice(0, 32) || null,
    format: String(input.format || "").slice(0, 16) || null,
    profile: !!input.profile,
    result: String(input.result || "ok").slice(0, 32),
    hwid: String(input.hwid || "").slice(0, 80) || null,
    bytes: Math.max(0, Math.floor(Number(input.bytes) || 0)),
  } as any);
}

export async function listProxySubAccessLogs(options: {
  tokenId?: number;
  userId?: number;
  limit?: number;
  /** 只要这个时间（毫秒）之前的，翻页用。 */
  beforeMs?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [];
  if (options.tokenId) conds.push(eq(proxySubAccessLogs.tokenId, Number(options.tokenId)));
  if (options.userId) conds.push(eq(proxySubAccessLogs.userId, Number(options.userId)));
  if (options.beforeMs) conds.push(lt(proxySubAccessLogs.at, new Date(options.beforeMs)));
  const limit = Math.min(500, Math.max(1, Math.floor(Number(options.limit) || 50)));
  const query = db.select().from(proxySubAccessLogs);
  const rows = conds.length > 0
    ? await query.where(and(...conds)).orderBy(desc(proxySubAccessLogs.at), desc(proxySubAccessLogs.id)).limit(limit)
    : await query.orderBy(desc(proxySubAccessLogs.at), desc(proxySubAccessLogs.id)).limit(limit);
  return rows;
}

/** 最近 N 天按结果、按客户端家族的次数。管理员看全站，用户看自己。 */
export async function proxySubAccessStats(options: { userId?: number; tokenId?: number; days?: number }) {
  const db = await getDb();
  if (!db) return { byResult: [] as Array<{ result: string; count: number }>, byFamily: [] as Array<{ family: string; count: number }>, total: 0, distinctIps: 0 };
  const days = Math.min(365, Math.max(1, Math.floor(Number(options.days) || 7)));
  const since = new Date(Date.now() - days * 86_400_000);
  const conds: any[] = [gt(proxySubAccessLogs.at, since)];
  if (options.userId) conds.push(eq(proxySubAccessLogs.userId, Number(options.userId)));
  if (options.tokenId) conds.push(eq(proxySubAccessLogs.tokenId, Number(options.tokenId)));
  const where = and(...conds);
  const byResult = await db
    .select({ result: proxySubAccessLogs.result, count: sql<number>`count(*)` })
    .from(proxySubAccessLogs)
    .where(where)
    .groupBy(proxySubAccessLogs.result);
  const byFamily = await db
    .select({ family: proxySubAccessLogs.clientFamily, count: sql<number>`count(*)` })
    .from(proxySubAccessLogs)
    .where(where)
    .groupBy(proxySubAccessLogs.clientFamily);
  const totals = await db
    .select({ total: sql<number>`count(*)`, distinctIps: sql<number>`count(distinct ${proxySubAccessLogs.ip})` })
    .from(proxySubAccessLogs)
    .where(where);
  return {
    byResult: (byResult as any[]).map((row) => ({ result: String(row.result || "ok"), count: Number(row.count || 0) })),
    byFamily: (byFamily as any[]).map((row) => ({ family: String(row.family || "unknown"), count: Number(row.count || 0) })),
    total: Number((totals as any[])[0]?.total || 0),
    distinctIps: Number((totals as any[])[0]?.distinctIps || 0),
  };
}

export async function pruneProxySubAccessLogs(retentionDays: number) {
  const days = Math.floor(Number(retentionDays) || 0);
  if (days <= 0) return 0;
  const cutoff = Math.floor((Date.now() - days * 86_400_000) / 1000);
  return deleteExpiredHistoryRows("proxy_sub_access_logs", "at", cutoff);
}

// ==================== 设备 ====================

export async function listProxySubDevicesByToken(tokenId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(proxySubDevices).where(eq(proxySubDevices.tokenId, Number(tokenId))).orderBy(desc(proxySubDevices.lastSeenAt));
}

export async function countProxySubDevices(tokenId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ count: sql<number>`count(*)` }).from(proxySubDevices).where(eq(proxySubDevices.tokenId, Number(tokenId)));
  return Number((rows as any[])[0]?.count || 0);
}

/** 登记或刷新一台设备。返回是不是新的。 */
export async function touchProxySubDevice(input: {
  tokenId: number;
  userId: number;
  hwid: string;
  deviceOs?: string;
  osVersion?: string;
  model?: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ isNew: boolean }> {
  const db = await getDb();
  if (!db) return { isNew: false };
  const hwid = String(input.hwid || "").slice(0, 80);
  if (!hwid) return { isNew: false };
  const existing = await db
    .select({ id: proxySubDevices.id })
    .from(proxySubDevices)
    .where(and(eq(proxySubDevices.tokenId, Number(input.tokenId)), eq(proxySubDevices.hwid, hwid)))
    .limit(1);
  const patch = {
    lastSeenAt: nowDate(),
    lastIp: String(input.ip || "").slice(0, 64) || null,
    userAgent: String(input.userAgent || "").slice(0, 200) || null,
    ...(input.deviceOs ? { deviceOs: String(input.deviceOs).slice(0, 64) } : {}),
    ...(input.osVersion ? { osVersion: String(input.osVersion).slice(0, 64) } : {}),
    ...(input.model ? { model: String(input.model).slice(0, 120) } : {}),
  };
  if ((existing as any[]).length > 0) {
    await db.update(proxySubDevices).set(patch as any).where(eq(proxySubDevices.id, Number((existing as any[])[0].id)));
    return { isNew: false };
  }
  try {
    await db.insert(proxySubDevices).values({
      tokenId: Number(input.tokenId),
      userId: Number(input.userId),
      hwid,
      firstSeenAt: nowDate(),
      ...patch,
    } as any);
    return { isNew: true };
  } catch {
    // 并发下撞唯一键：另一路已经插进去了，按「不是新的」算。
    return { isNew: false };
  }
}

export async function deleteProxySubDevice(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(proxySubDevices).where(eq(proxySubDevices.id, Number(id)));
}

export async function getProxySubDeviceById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(proxySubDevices).where(eq(proxySubDevices.id, Number(id))).limit(1);
  return rows[0];
}

/** 令牌重置 / 删除时清空设备：旧地址上的设备和新地址没关系。 */
export async function clearProxySubDevices(tokenId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(proxySubDevices).where(eq(proxySubDevices.tokenId, Number(tokenId)));
}

/** 退化模式下过期的 IP 设备定期清掉。 */
export async function pruneStaleIpDevices(windowHours: number) {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - Math.max(1, windowHours) * 3_600_000);
  const result = await db
    .delete(proxySubDevices)
    .where(and(sql`${proxySubDevices.hwid} LIKE 'ip:%'`, lt(proxySubDevices.lastSeenAt, cutoff)));
  return Number((result as any)?.rowsAffected ?? (result as any)?.changes ?? 0);
}

// ==================== 模板 ====================

function rowToTemplate(row: any): ProxySubTemplate {
  return {
    id: Number(row.id),
    name: String(row.name || ""),
    target: String(row.target || "clash") as ProxySubTemplateTarget,
    prelude: String(row.prelude || ""),
    customGroups: parseProxySubCustomGroupsJson(row.customGroupsJson),
    isDefault: !!row.isDefault,
  };
}

export async function listProxySubTemplates(): Promise<ProxySubTemplate[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(proxySubTemplates).orderBy(asc(proxySubTemplates.target), asc(proxySubTemplates.id));
  return (rows as any[]).map(rowToTemplate);
}

export async function getProxySubTemplateById(id: number): Promise<ProxySubTemplate | null> {
  const db = await getDb();
  if (!db || !(Number(id) > 0)) return null;
  const rows = await db.select().from(proxySubTemplates).where(eq(proxySubTemplates.id, Number(id))).limit(1);
  return rows[0] ? rowToTemplate(rows[0]) : null;
}

export async function createProxySubTemplate(data: { name: string; target: ProxySubTemplateTarget; prelude: string; customGroupsJson: string | null; isDefault: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (!(PROXY_SUB_TEMPLATE_TARGETS as readonly string[]).includes(data.target)) throw new Error("模板的目标格式不认识");
  if (data.isDefault) await db.update(proxySubTemplates).set({ isDefault: false } as any).where(eq(proxySubTemplates.target, data.target));
  const id = await insertAndGetId("proxy_sub_templates", data as InsertProxySubTemplate as any);
  invalidateProxySubCacheAll();
  return id;
}

export async function updateProxySubTemplate(id: number, data: Partial<{ name: string; prelude: string; customGroupsJson: string | null; isDefault: boolean }>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await getProxySubTemplateById(id);
  if (!existing) throw new Error("模板不存在");
  if (data.isDefault) await db.update(proxySubTemplates).set({ isDefault: false } as any).where(eq(proxySubTemplates.target, existing.target));
  await db.update(proxySubTemplates).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxySubTemplates.id, Number(id)));
  invalidateProxySubCacheAll();
}

export async function deleteProxySubTemplate(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(proxySubTemplates).where(eq(proxySubTemplates.id, Number(id)));
  // 指向它的引用退回 0（= 看下一级）。
  await db.update(proxySubTokens).set({ templateId: 0 } as any).where(eq(proxySubTokens.templateId, Number(id)));
  await db.update(users).set({ proxySubTemplateId: 0 } as any).where(eq(users.proxySubTemplateId, Number(id)));
  await db.update(subscriptionPlans).set({ proxySubTemplateId: 0 } as any).where(eq(subscriptionPlans.proxySubTemplateId, Number(id)));
  invalidateProxySubCacheAll();
}

/**
 * 这个目标格式该用哪份模板：按优先级给的候选 id 里第一个存在且目标匹配的；
 * 都没有就用这个目标的默认模板；再没有返回 null（渲染时用内置的开头部分）。
 */
export async function resolveProxySubTemplate(target: ProxySubTemplateTarget, candidateIds: readonly number[]): Promise<ProxySubTemplate | null> {
  const db = await getDb();
  if (!db) return null;
  const ids = candidateIds.map((id) => Number(id)).filter((id) => id > 0);
  if (ids.length > 0) {
    const rows = await db.select().from(proxySubTemplates).where(and(inArray(proxySubTemplates.id, ids), eq(proxySubTemplates.target, target)));
    for (const id of ids) {
      const hit = (rows as any[]).find((row) => Number(row.id) === id);
      if (hit) return rowToTemplate(hit);
    }
  }
  const defaults = await db.select().from(proxySubTemplates).where(and(eq(proxySubTemplates.target, target), eq(proxySubTemplates.isDefault, true))).limit(1);
  return defaults[0] ? rowToTemplate(defaults[0]) : null;
}

// ==================== 外部订阅 ====================

export async function listProxySubSourcesByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(proxySubSources).where(eq(proxySubSources.userId, Number(userId))).orderBy(asc(proxySubSources.id));
}

export async function countProxySubSourcesByUser(userId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ count: sql<number>`count(*)` }).from(proxySubSources).where(eq(proxySubSources.userId, Number(userId)));
  return Number((rows as any[])[0]?.count || 0);
}

export async function getProxySubSourceById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(proxySubSources).where(eq(proxySubSources.id, Number(id))).limit(1);
  return rows[0];
}

export async function createProxySubSource(data: InsertProxySubSource) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("proxy_sub_sources", data as any);
}

export async function updateProxySubSource(id: number, data: Partial<InsertProxySubSource>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(proxySubSources).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxySubSources.id, Number(id)));
}

/** 删来源连同它同步来的节点。 */
export async function deleteProxySubSource(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const source = await getProxySubSourceById(id);
  const nodes = await db.select({ id: proxyNodes.id }).from(proxyNodes).where(eq(proxyNodes.sourceId, Number(id)));
  const { deleteProxyNode } = await import("./proxySubscriptionRepository");
  for (const node of nodes as any[]) await deleteProxyNode(Number(node.id));
  await db.delete(proxySubSources).where(eq(proxySubSources.id, Number(id)));
  if (source) invalidateProxySubCacheForUser(Number((source as any).userId));
}

/** 到点该拉的来源：开着、且上次拉取早于间隔（或从没拉过）。 */
export async function listDueProxySubSources(now = Date.now(), limit = 20) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(proxySubSources)
    .where(eq(proxySubSources.isEnabled, true))
    .orderBy(asc(proxySubSources.lastFetchAt), asc(proxySubSources.id))
    .limit(Math.max(1, limit * 5));
  return (rows as any[]).filter((row) => {
    const last = row.lastFetchAt ? new Date(row.lastFetchAt).getTime() : 0;
    return !last || now - last >= Math.max(600, Number(row.intervalSec) || 21600) * 1000;
  }).slice(0, limit);
}

export async function listProxyNodesBySource(sourceId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(proxyNodes).where(eq(proxyNodes.sourceId, Number(sourceId)));
}

// ==================== 令牌：别名、全站清单、用户自定义规则 ====================

export async function getProxySubTokenByAlias(alias: string) {
  const db = await getDb();
  const clean = normalizeProxySubAlias(alias);
  if (!db || !clean) return undefined;
  const rows = await db.select().from(proxySubTokens).where(eq(proxySubTokens.alias, clean)).limit(1);
  return rows[0];
}

export async function proxySubAliasInUse(alias: string, exceptTokenId = 0): Promise<boolean> {
  const row = await getProxySubTokenByAlias(alias);
  return !!row && Number((row as any).id) !== Number(exceptTokenId);
}

/** 管理员的全站令牌清单：带用户名，可按名字 / 用户名 / 别名搜。 */
export async function listAllProxySubTokens(options: { search?: string; page?: number; pageSize?: number; userId?: number }) {
  const db = await getDb();
  if (!db) return { items: [] as any[], total: 0 };
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(options.pageSize) || 20)));
  const search = String(options.search || "").trim().toLowerCase();
  const conds: any[] = [];
  if (options.userId) conds.push(eq(proxySubTokens.userId, Number(options.userId)));
  if (search) {
    const like = `%${search}%`;
    conds.push(or(
      sql`lower(${proxySubTokens.name}) like ${like}`,
      sql`lower(${users.username}) like ${like}`,
      sql`lower(coalesce(${proxySubTokens.alias}, '')) like ${like}`,
      sql`lower(coalesce(${proxySubTokens.remark}, '')) like ${like}`,
    ));
  }
  const where = conds.length > 0 ? and(...conds) : undefined;
  const base = db
    .select({
      id: proxySubTokens.id,
      userId: proxySubTokens.userId,
      username: users.username,
      userDisplayName: users.name,
      name: proxySubTokens.name,
      alias: proxySubTokens.alias,
      remark: proxySubTokens.remark,
      defaultFormat: proxySubTokens.defaultFormat,
      rulePreset: proxySubTokens.rulePreset,
      isEnabled: proxySubTokens.isEnabled,
      accessCount: proxySubTokens.accessCount,
      lastAccessAt: proxySubTokens.lastAccessAt,
      lastAccessIp: proxySubTokens.lastAccessIp,
      lastAccessUserAgent: proxySubTokens.lastAccessUserAgent,
      lastFailureAt: proxySubTokens.lastFailureAt,
      lastFailureReason: proxySubTokens.lastFailureReason,
      lastClientFamily: proxySubTokens.lastClientFamily,
      lastClientVersion: proxySubTokens.lastClientVersion,
      expiresAt: proxySubTokens.expiresAt,
      maxDevices: proxySubTokens.maxDevices,
      templateId: proxySubTokens.templateId,
      scopeJson: proxySubTokens.scopeJson,
      createdAt: proxySubTokens.createdAt,
    })
    .from(proxySubTokens)
    .leftJoin(users, eq(users.id, proxySubTokens.userId));
  const items = await (where ? base.where(where) : base)
    .orderBy(desc(proxySubTokens.lastAccessAt), desc(proxySubTokens.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const countQuery = db.select({ count: sql<number>`count(*)` }).from(proxySubTokens).leftJoin(users, eq(users.id, proxySubTokens.userId));
  const counted = await (where ? countQuery.where(where) : countQuery);
  return { items, total: Number((counted as any[])[0]?.count || 0) };
}

export async function setUserProxySubCustomRules(userId: number, text: string | null) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ proxySubCustomRules: text, updatedAt: nowDate() } as any).where(eq(users.id, Number(userId)));
  invalidateProxySubCacheForUser(userId);
}

export async function setUserProxySubTemplate(userId: number, templateId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ proxySubTemplateId: Math.max(0, Math.floor(Number(templateId) || 0)), updatedAt: nowDate() } as any).where(eq(users.id, Number(userId)));
  invalidateProxySubCacheForUser(userId);
}

/**
 * 这个人还生效的套餐里，订阅相关的那几项：名字、模板、设备数、外部订阅、信息节点、下次流量重置。
 * 落地页和 /info 接口要显示套餐名；模板解析要套餐的模板 id。
 */
export async function getUserPlanSubscriptionInfo(userId: number) {
  const db = await getDb();
  if (!db) return { planNames: [] as string[], templateIds: [] as number[], maxProxyDevices: 0, allowExternalSubSources: false, showSubInfoNodes: false, nextResetAt: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      planName: subscriptionPlans.name,
      templateId: subscriptionPlans.proxySubTemplateId,
      maxProxyDevices: subscriptionPlans.maxProxyDevices,
      allowExternalSubSources: subscriptionPlans.allowExternalSubSources,
      showSubInfoNodes: subscriptionPlans.showSubInfoNodes,
      nextTrafficResetAt: userSubscriptions.nextTrafficResetAt,
    })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, userSubscriptions.planId))
    .where(and(
      eq(userSubscriptions.userId, Number(userId)),
      eq(userSubscriptions.status, "active"),
      sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
    ));
  const list = rows as any[];
  let nextResetAt = 0;
  for (const row of list) {
    const at = row.nextTrafficResetAt ? new Date(row.nextTrafficResetAt).getTime() : 0;
    if (at > 0 && (nextResetAt === 0 || at < nextResetAt)) nextResetAt = at;
  }
  // 设备数：多个套餐取最大（0 = 不限，有一个不限就不限）。
  const limits = list.map((row) => Number(row.maxProxyDevices || 0));
  const maxProxyDevices = list.length === 0 || limits.some((value) => value === 0) ? 0 : Math.max(...limits);
  return {
    planNames: Array.from(new Set(list.map((row) => String(row.planName || "")).filter(Boolean))),
    templateIds: list.map((row) => Number(row.templateId || 0)).filter((id) => id > 0),
    maxProxyDevices,
    allowExternalSubSources: list.some((row) => !!row.allowExternalSubSources),
    showSubInfoNodes: list.some((row) => !!row.showSubInfoNodes),
    nextResetAt,
  };
}
