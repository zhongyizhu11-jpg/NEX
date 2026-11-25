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
  type InsertProxySubAccessLog,
  type InsertProxySubSource,
  type InsertProxySubTemplate,
} from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, insertAndGetId, nowDate, quoteDbIdentifier, rawAffectedRows, withDatabaseTransaction } from "../dbRuntime";
import { defineBatchedWrite } from "../dbWriteBatcher";
import { deleteExpiredHistoryRows } from "./historyRetention";
import { normalizeProxySubAlias } from "../../shared/proxySubTokenScope";
import { parseProxySubCustomGroupsJson, PROXY_SUB_TEMPLATE_TARGETS, type ProxySubTemplate, type ProxySubTemplateTarget } from "../../shared/proxySubTemplates";
import { parseProxySubTemplateModulesJson } from "../../shared/proxySubModules";
import { invalidateProxySubCacheAll, invalidateProxySubCacheForUser, onProxySubCacheInvalidateAll } from "../proxySubCache";

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

/*
  拉取日志攒批写（server/dbWriteBatcher.ts，和延迟样本同一套）：每次拉取一行 INSERT 自己一个事务，
  一个商家几百个客户端一起刷时就是几百次提交。这张表只进历史、没人等着立刻读；读它的几处
  （清单、统计、清理）先 flush 再查，「拉完马上看得到」不变。退出前的刷写由 index.ts 装的钩子统一做。
  行上的 at 在排队时就定下来，不然晚两秒落库的记录时间也晚两秒。
*/
const PROXY_SUB_ACCESS_LOG_WRITE_QUEUE = "proxy_sub_access_logs";
const accessLogWrites = defineBatchedWrite<InsertProxySubAccessLog>(PROXY_SUB_ACCESS_LOG_WRITE_QUEUE, async (rows) => {
  const db = await getDb();
  if (!db) return;
  await db.insert(proxySubAccessLogs).values(rows);
});

/** 把攒着的拉取日志写进库（测试、读清单之前用）。 */
export function flushProxySubAccessLogs() {
  return accessLogWrites.flush();
}

export async function recordProxySubAccessLog(input: ProxySubAccessLogInput) {
  await accessLogWrites.push({
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
  });
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
  await accessLogWrites.flush();
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
  await accessLogWrites.flush();
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
  await accessLogWrites.flush();
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

/** 一批令牌各有几台设备（令牌清单用）：一条 GROUP BY，不按令牌逐条数。没设备的令牌不在结果里。 */
export async function countProxySubDevicesByTokens(tokenIds: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = Array.from(new Set(tokenIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return out;
  const db = await getDb();
  if (!db) return out;
  const rows = await db
    .select({ tokenId: proxySubDevices.tokenId, count: sql<number>`count(*)` })
    .from(proxySubDevices)
    .where(inArray(proxySubDevices.tokenId, ids))
    .groupBy(proxySubDevices.tokenId);
  for (const row of rows as any[]) out.set(Number(row.tokenId), Number(row.count || 0));
  return out;
}

/**
 * 刚来过的设备不再刷 lastSeenAt：设备表是给人看「哪台多久没来」的，几分钟的误差没人在意，
 * 省下的是每次拉取对设备表的一条 UPDATE。按 IP 退化统计的窗口按小时算，远大于这个数。
 */
const DEVICE_TOUCH_INTERVAL_MS = 5 * 60_000;

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
  /**
   * 调用方刚列过这条令牌的设备时带上，省一次查询：这一台在清单里就给它的 id 和上次时间，
   * 不在就给 null。不带（undefined）时自己查一次。
   */
  known?: { id: number; lastSeenAt: unknown } | null;
}): Promise<{ isNew: boolean }> {
  const db = await getDb();
  if (!db) return { isNew: false };
  const hwid = String(input.hwid || "").slice(0, 80);
  if (!hwid) return { isNew: false };
  const now = nowDate();
  let known = input.known;
  if (known === undefined) {
    const existing = await db
      .select({ id: proxySubDevices.id, lastSeenAt: proxySubDevices.lastSeenAt })
      .from(proxySubDevices)
      .where(and(eq(proxySubDevices.tokenId, Number(input.tokenId)), eq(proxySubDevices.hwid, hwid)))
      .limit(1);
    const row = (existing as any[])[0];
    known = row ? { id: Number(row.id), lastSeenAt: row.lastSeenAt } : null;
  }
  const patch = {
    lastSeenAt: now,
    lastIp: String(input.ip || "").slice(0, 64) || null,
    userAgent: String(input.userAgent || "").slice(0, 200) || null,
    ...(input.deviceOs ? { deviceOs: String(input.deviceOs).slice(0, 64) } : {}),
    ...(input.osVersion ? { osVersion: String(input.osVersion).slice(0, 64) } : {}),
    ...(input.model ? { model: String(input.model).slice(0, 120) } : {}),
  };
  if (known) {
    const lastSeen = known.lastSeenAt ? new Date(known.lastSeenAt as any).getTime() : 0;
    if (lastSeen && now.getTime() - lastSeen < DEVICE_TOUCH_INTERVAL_MS) return { isNew: false };
    await db.update(proxySubDevices).set(patch as any).where(eq(proxySubDevices.id, Number(known.id)));
    return { isNew: false };
  }
  /*
    新设备：插入时撞唯一键（并发的另一路、或调用方的清单旧了）就当没插。
    原来是 INSERT 失败再 catch —— 结果一样，但 PostgreSQL 会把每次唯一键冲突记进服务端日志。
  */
  if (await insertProxySubDeviceIgnoringConflict({
    tokenId: Number(input.tokenId),
    userId: Number(input.userId),
    hwid,
    firstSeenAt: now,
    ...patch,
  })) return { isNew: true };
  // 另一路刚插进去了：把这一次的来路补上去，按「不是新的」算。
  await db.update(proxySubDevices).set(patch as any).where(and(eq(proxySubDevices.tokenId, Number(input.tokenId)), eq(proxySubDevices.hwid, hwid)));
  return { isNew: false };
}

/** INSERT 一台设备，(tokenId, hwid) 已有就忽略。插进去了返回 true。三种库各自的写法，和 settingsRepository 的 claimSettingKey 一致。 */
async function insertProxySubDeviceIgnoringConflict(values: Record<string, unknown>): Promise<boolean> {
  const q = quoteDbIdentifier;
  const columns = Object.keys(values).filter((key) => values[key] !== undefined);
  const list = columns.map(q).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const params = columns.map((key) => values[key]);
  const result = getDatabaseKind() === "mysql"
    ? await executeRaw(`INSERT IGNORE INTO ${q("proxy_sub_devices")} (${list}) VALUES (${placeholders})`, params)
    : await executeRaw(`INSERT INTO ${q("proxy_sub_devices")} (${list}) VALUES (${placeholders}) ON CONFLICT (${q("tokenId")}, ${q("hwid")}) DO NOTHING`, params);
  return rawAffectedRows(result) > 0;
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
  // 三种驱动的受影响行数字段各不一样（changes / affectedRows / rowCount），mysql2 还包在元组里；统一走 rawAffectedRows。
  return rawAffectedRows(Array.isArray(result) ? result[0] : result);
}

// ==================== 模板 ====================

function rowToTemplate(row: any): ProxySubTemplate {
  return {
    id: Number(row.id),
    name: String(row.name || ""),
    target: String(row.target || "clash") as ProxySubTemplateTarget,
    prelude: String(row.prelude || ""),
    customGroups: parseProxySubCustomGroupsJson(row.customGroupsJson),
    customRules: String(row.customRules || ""),
    modules: parseProxySubTemplateModulesJson(row.modulesJson),
    isDefault: !!row.isDefault,
  };
}

/*
  模板清单放在内存里。每次拉订阅都要解析一次「这条令牌用哪份模板」（令牌 → 用户 → 套餐 → 默认），
  原来每次一两条查询，而模板全站就几份、几乎不改。改模板的三条路都走 invalidateProxySubCacheAll，
  在那里登记一个监听把这份清单一起清掉；再加一分钟 TTL 兜底（备份导入这种直接写表的路不经过它）。
  按 db 实例记：切库之后不拿旧库的清单。
*/
const TEMPLATES_CACHE_TTL_MS = 60_000;
let templatesCache: { db: unknown; expiresAt: number; rows: ProxySubTemplate[] } | null = null;
let templatesLoad: { db: unknown; promise: Promise<ProxySubTemplate[]> } | null = null;

export function invalidateProxySubTemplatesCache() {
  templatesCache = null;
  templatesLoad = null;
}

onProxySubCacheInvalidateAll(invalidateProxySubTemplatesCache);

async function loadProxySubTemplates(): Promise<ProxySubTemplate[]> {
  const db = await getDb();
  if (!db) return [];
  const now = Date.now();
  if (templatesCache && templatesCache.db === db && templatesCache.expiresAt > now) return templatesCache.rows;
  if (templatesLoad && templatesLoad.db === db) return templatesLoad.promise;
  const promise = Promise.resolve(db.select().from(proxySubTemplates).orderBy(asc(proxySubTemplates.target), asc(proxySubTemplates.id)))
    .then((rows: unknown[]) => {
      const list = rows.map(rowToTemplate);
      // 加载期间有人作废过（templatesLoad 被清掉）就不存，下一次重读。
      if (templatesLoad?.promise === promise) templatesCache = { db, expiresAt: Date.now() + TEMPLATES_CACHE_TTL_MS, rows: list };
      return list;
    });
  templatesLoad = { db, promise };
  try {
    return await promise;
  } finally {
    if (templatesLoad?.promise === promise) templatesLoad = null;
  }
}

export async function listProxySubTemplates(): Promise<ProxySubTemplate[]> {
  return [...await loadProxySubTemplates()];
}

export async function getProxySubTemplateById(id: number): Promise<ProxySubTemplate | null> {
  if (!(Number(id) > 0)) return null;
  return (await loadProxySubTemplates()).find((template) => template.id === Number(id)) ?? null;
}

export async function createProxySubTemplate(data: { name: string; target: ProxySubTemplateTarget; prelude: string; customGroupsJson: string | null; customRules?: string | null; modulesJson?: string | null; isDefault: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (!(PROXY_SUB_TEMPLATE_TARGETS as readonly string[]).includes(data.target)) throw new Error("模板的目标格式不认识");
  if (data.isDefault) await db.update(proxySubTemplates).set({ isDefault: false } as any).where(eq(proxySubTemplates.target, data.target));
  const id = await insertAndGetId("proxy_sub_templates", data as InsertProxySubTemplate as any);
  invalidateProxySubCacheAll();
  return id;
}

export async function updateProxySubTemplate(id: number, data: Partial<{ name: string; prelude: string; customGroupsJson: string | null; customRules: string | null; modulesJson: string | null; isDefault: boolean }>) {
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
  // 四条语句一个事务：删了模板、引用还没退回就断掉，令牌 / 用户 / 套餐会指着一个不存在的模板 id。
  await withDatabaseTransaction(async () => {
    await db.delete(proxySubTemplates).where(eq(proxySubTemplates.id, Number(id)));
    // 指向它的引用退回 0（= 看下一级）。
    await db.update(proxySubTokens).set({ templateId: 0 } as any).where(eq(proxySubTokens.templateId, Number(id)));
    await db.update(users).set({ proxySubTemplateId: 0 } as any).where(eq(users.proxySubTemplateId, Number(id)));
    await db.update(subscriptionPlans).set({ proxySubTemplateId: 0 } as any).where(eq(subscriptionPlans.proxySubTemplateId, Number(id)));
  });
  invalidateProxySubCacheAll();
}

/**
 * 这个目标格式该用哪份模板：按优先级给的候选 id 里第一个存在且目标匹配的；
 * 都没有就用这个目标的默认模板；再没有返回 null（渲染时用内置的开头部分）。
 */
export async function resolveProxySubTemplate(target: ProxySubTemplateTarget, candidateIds: readonly number[]): Promise<ProxySubTemplate | null> {
  const templates = await loadProxySubTemplates();
  if (templates.length === 0) return null;
  for (const id of candidateIds.map((id) => Number(id)).filter((id) => id > 0)) {
    const hit = templates.find((template) => template.id === id && template.target === target);
    if (hit) return hit;
  }
  // 清单按 (target, id) 排好序，第一个默认的就是原来 LIMIT 1 取到的那个。
  return templates.find((template) => template.target === target && template.isDefault) ?? null;
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
  const { deleteProxyNodes } = await import("./proxySubscriptionRepository");
  // 同步来的几十上百条一起删（每步一条 IN），不是每条八条语句。
  await deleteProxyNodes((nodes as Array<{ id: unknown }>).map((node) => Number(node.id)));
  await db.delete(proxySubSources).where(eq(proxySubSources.id, Number(id)));
  if (source) invalidateProxySubCacheForUser(Number((source as any).userId));
}

/** 到点该拉的来源：开着、且上次拉取早于间隔（或从没拉过）。 */
export async function listDueProxySubSources(now = Date.now(), limit = 20) {
  const db = await getDb();
  if (!db) return [];
  /*
    「到点没到点」在 SQL 里判，不先取一批再在 JS 里过滤：原来取 5 倍再筛，来源一多，前面几十条
    「没到点但 lastFetchAt 最早」的会把真到点的挤出那一批，永远轮不到；PostgreSQL 上 NULL 排在最后，
    从没拉过的更是最先被挤掉。时间列存的是秒，这里也按秒比；间隔的口径和原来 JS 里一样：
    没填或 0 按 21600，最少 600。
  */
  const interval = sql`CASE WHEN COALESCE(${proxySubSources.intervalSec}, 0) <= 0 THEN 21600 WHEN ${proxySubSources.intervalSec} < 600 THEN 600 ELSE ${proxySubSources.intervalSec} END`;
  const lastFetch = sql`COALESCE(${proxySubSources.lastFetchAt}, 0)`;
  return db
    .select()
    .from(proxySubSources)
    .where(and(eq(proxySubSources.isEnabled, true), sql`${lastFetch} + ${interval} <= ${Math.floor(now / 1000)}`))
    .orderBy(lastFetch, asc(proxySubSources.id))
    .limit(Math.max(1, limit));
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
