import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { forwardRules, hosts, ruleEntryDomainCleanups } from "../../drizzle/schema";
import { getDb, nowDate } from "../dbRuntime";
import { normalizeRuleEntryDomainSuffix, ruleEntryDomainRecordType } from "@shared/ruleEntryDomain";
import { getAllSettings } from "./settingsRepository";
import { invalidateProxySubCacheAll } from "../proxySubCache";

/*
  规则专属域名的读写（同步逻辑见 server/ruleEntryDomain.ts）。

  单独成一个仓库文件、不依赖 ddns / db 入口：forwardRuleRepository 和 hostRepository
  删规则行之前要调这里记下待删域名，而 server/ddns.ts 又 import 了 ./db —— 放在
  同步模块里就成了循环依赖。

  写这些列时**不碰 updatedAt、不写配置审计**：它们只是面板对 DNS 的簿记，和 Agent
  要跑的配置无关；动了 updatedAt 会让心跳那边以为规则改过。
*/

const RULE_ENTRY_DOMAIN_DDNS_PROVIDERS = new Set(["cloudflare", "webhook", "huaweicloud", "aliyun", "tencentcloud"]);

export type RuleEntryDomainRuntimeSettings = {
  /** DNS 服务商已配置并启用：只有这时才能动 DNS 记录。 */
  ddnsActive: boolean;
  /** 规整后的后缀；为空表示功能未开启（或后缀无效）。 */
  suffix: string;
  /** 真正生效的后缀：DNS 可用且后缀有效时才非空。订阅按它决定用不用域名。 */
  activeSuffix: string;
};

/** 从一份系统设置里算出功能状态（设置接口已经拿到全部设置时直接用，不再查一次库）。 */
export function resolveRuleEntryDomainRuntimeSettings(all: Record<string, string | null | undefined>): RuleEntryDomainRuntimeSettings {
  const provider = String(all.ddnsProvider || "disabled");
  const ddnsActive = all.ddnsEnabled === "true" && RULE_ENTRY_DOMAIN_DDNS_PROVIDERS.has(provider);
  const suffix = normalizeRuleEntryDomainSuffix(all.ruleEntryDomainSuffix);
  return { ddnsActive, suffix, activeSuffix: ddnsActive ? suffix : "" };
}

export async function getRuleEntryDomainRuntimeSettings(): Promise<RuleEntryDomainRuntimeSettings> {
  return resolveRuleEntryDomainRuntimeSettings(await getAllSettings());
}

const RULE_COLUMNS = {
  id: forwardRules.id,
  hostId: forwardRules.hostId,
  userId: forwardRules.userId,
  isEnabled: forwardRules.isEnabled,
  pendingDelete: forwardRules.pendingDelete,
  isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
  routeParentRuleId: forwardRules.routeParentRuleId,
  proxyNodeId: forwardRules.proxyNodeId,
  proxyNodeVisible: forwardRules.proxyNodeVisible,
  entryDomainEnabled: forwardRules.entryDomainEnabled,
  entryDomain: forwardRules.entryDomain,
  entryDomainValue: forwardRules.entryDomainValue,
  entryDomainAt: forwardRules.entryDomainAt,
  entryDomainError: forwardRules.entryDomainError,
};

export type RuleEntryDomainRuleRow = {
  id: number;
  hostId: number;
  userId: number;
  isEnabled: unknown;
  pendingDelete: unknown;
  isForwardGroupTemplate: unknown;
  routeParentRuleId: number | null;
  proxyNodeId: number | null;
  proxyNodeVisible: unknown;
  entryDomainEnabled: unknown;
  entryDomain: string | null;
  entryDomainValue: string | null;
  entryDomainAt: Date | null;
  entryDomainError: string | null;
};

export async function getRuleEntryDomainRule(ruleId: number): Promise<RuleEntryDomainRuleRow | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select(RULE_COLUMNS).from(forwardRules).where(eq(forwardRules.id, ruleId)).limit(1);
  return (rows[0] as RuleEntryDomainRuleRow | undefined) ?? null;
}

/**
 * 定时对账要看的规则：绑了节点模板的（可能该有域名），或者身上还挂着发布过的域名的
 * （可能该删）。两类之外的规则跟这个功能无关，不读。
 */
export async function listRuleEntryDomainCandidates(): Promise<RuleEntryDomainRuleRow[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select(RULE_COLUMNS).from(forwardRules)
    .where(or(isNotNull(forwardRules.proxyNodeId), isNotNull(forwardRules.entryDomain)))
    .orderBy(asc(forwardRules.id));
  return rows as RuleEntryDomainRuleRow[];
}

/** 一台主机上和规则域名有关的规则（主机入口地址变了时用）。 */
export async function listRuleEntryDomainRuleIdsForHost(hostId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: forwardRules.id }).from(forwardRules)
    .where(and(
      eq(forwardRules.hostId, hostId),
      or(isNotNull(forwardRules.proxyNodeId), isNotNull(forwardRules.entryDomain)),
    ));
  return (rows as Array<{ id: number }>).map((row) => Number(row.id)).filter((id) => id > 0);
}

/** 批量取入口主机（只取推导入口地址要用的列）。 */
export async function getRuleEntryDomainHosts(hostIds: number[]) {
  const ids = Array.from(new Set(hostIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  return db.select({
    id: hosts.id,
    ip: hosts.ip,
    ipv4: hosts.ipv4,
    ipv6: hosts.ipv6,
    entryIp: hosts.entryIp,
    ddnsEnabled: hosts.ddnsEnabled,
    ddnsDomain: hosts.ddnsDomain,
  }).from(hosts).where(inArray(hosts.id, ids));
}

export async function markRuleEntryDomainPublished(ruleId: number, domain: string, value: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({
    entryDomain: domain,
    entryDomainValue: value,
    entryDomainAt: nowDate(),
    entryDomainError: null,
  } as any).where(eq(forwardRules.id, ruleId));
  // 这里绕开了 forwardRuleRepository，订阅缓存得自己清；这类写入很少，整体清掉即可。
  invalidateProxySubCacheAll();
}

/**
 * 记下发布失败的原因。
 *
 * 规则身上还没有域名时顺手把要发布的域名记上（值留空）：发布可能半途失败（比如
 * 记录已经建了、回包超时），不记的话这条记录就没人知道、再也删不掉。值为空时订阅
 * 不会用它，见 publishedRuleEntryDomain。
 */
export async function markRuleEntryDomainFailed(ruleId: number, message: string, claimDomain?: string) {
  const db = await getDb();
  if (!db) return;
  const text = String(message || "未知错误").slice(0, 1000);
  await db.update(forwardRules).set({ entryDomainError: text } as any).where(eq(forwardRules.id, ruleId));
  if (claimDomain) {
    await db.update(forwardRules).set({ entryDomain: claimDomain, entryDomainValue: null } as any)
      .where(and(eq(forwardRules.id, ruleId), isNull(forwardRules.entryDomain)));
    invalidateProxySubCacheAll();
  }
}

export async function clearRuleEntryDomainError(ruleId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({ entryDomainError: null } as any)
    .where(and(eq(forwardRules.id, ruleId), isNotNull(forwardRules.entryDomainError)));
}

/** 这个域名此刻是不是有规则认领着（发布过、还挂在身上）。 */
export async function isRuleEntryDomainClaimed(domain: string, exceptRuleId = 0): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ id: forwardRules.id }).from(forwardRules)
    .where(eq(forwardRules.entryDomain, domain)).limit(2);
  return (rows as Array<{ id: number }>).some((row) => Number(row.id) !== exceptRuleId);
}

async function upsertCleanup(db: any, input: { domain: string; recordType: string | null; ruleId: number }) {
  const existing = await db.select({ id: ruleEntryDomainCleanups.id, recordType: ruleEntryDomainCleanups.recordType })
    .from(ruleEntryDomainCleanups).where(eq(ruleEntryDomainCleanups.domain, input.domain)).limit(1);
  if (existing[0]) {
    // 已有一行时类型不一致就改成「不知道」，删的时候三种都删，免得漏掉一种。
    const recordType = existing[0].recordType === input.recordType ? input.recordType : null;
    await db.update(ruleEntryDomainCleanups).set({
      recordType,
      ruleId: input.ruleId,
      nextRetryAt: null,
      updatedAt: nowDate(),
    } as any).where(eq(ruleEntryDomainCleanups.id, existing[0].id));
    return;
  }
  await db.insert(ruleEntryDomainCleanups).values({
    domain: input.domain,
    recordType: input.recordType,
    ruleId: input.ruleId,
    attempts: 0,
  } as any);
}

/**
 * 把规则身上发布过的域名挪进待删表，并清掉规则上的这几列。
 *
 * 两步的先后是故意的：先记待删、再清列。中间断掉最多是「列还在、待删表里也有」，
 * 下一轮对账会再挪一次（upsert 幂等）；反过来断在中间就会丢掉一条记录的下落。
 * 只在列里的域名还是调用方看到的那个时才清，挡住并发的另一次发布。
 */
export async function retireRuleEntryDomain(ruleId: number, domain: string, value: string | null) {
  const db = await getDb();
  if (!db || !domain) return;
  await upsertCleanup(db, { domain, recordType: ruleEntryDomainRecordType(value) ?? null, ruleId });
  await db.update(forwardRules).set({
    entryDomain: null,
    entryDomainValue: null,
    entryDomainAt: null,
    entryDomainError: null,
  } as any).where(and(eq(forwardRules.id, ruleId), eq(forwardRules.entryDomain, domain)));
  invalidateProxySubCacheAll();
}

/**
 * 规则行要被真正删掉之前调用：把它们身上发布过的域名记进待删表。
 *
 * 规则行一删，entryDomain 就跟着没了，DNS 里那条记录再也找不回来 —— 所以删行的
 * 两处（finalizeForwardRuleDelete、deleteHost）都要先过这里。之后的删除由同步模块
 * 异步去做，删不成留给定时对账。
 */
export async function recordRuleEntryDomainCleanupsBeforeDelete(filter: { ruleId?: number; hostId?: number }) {
  const db = await getDb();
  if (!db) return 0;
  const condition = filter.ruleId
    ? eq(forwardRules.id, filter.ruleId)
    : filter.hostId
      ? eq(forwardRules.hostId, filter.hostId)
      : null;
  if (!condition) return 0;
  const rows = await db.select({
    id: forwardRules.id,
    entryDomain: forwardRules.entryDomain,
    entryDomainValue: forwardRules.entryDomainValue,
  }).from(forwardRules).where(and(condition, isNotNull(forwardRules.entryDomain)));
  let count = 0;
  for (const row of rows as Array<{ id: number; entryDomain: string | null; entryDomainValue: string | null }>) {
    const domain = String(row.entryDomain || "").trim();
    if (!domain) continue;
    await upsertCleanup(db, { domain, recordType: ruleEntryDomainRecordType(row.entryDomainValue) ?? null, ruleId: Number(row.id) });
    count += 1;
  }
  return count;
}

export type RuleEntryDomainCleanupRow = {
  id: number;
  domain: string;
  recordType: string | null;
  ruleId: number;
  attempts: number;
  lastError: string | null;
  nextRetryAt: Date | null;
};

/** 到了重试时间的待删域名。domain 指定时只取那一个（不管重试时间）。 */
export async function listDueRuleEntryDomainCleanups(options: { limit?: number; domain?: string } = {}): Promise<RuleEntryDomainCleanupRow[]> {
  const db = await getDb();
  if (!db) return [];
  const where = options.domain
    ? eq(ruleEntryDomainCleanups.domain, options.domain)
    : or(isNull(ruleEntryDomainCleanups.nextRetryAt), lte(ruleEntryDomainCleanups.nextRetryAt, nowDate()));
  const rows = await db.select().from(ruleEntryDomainCleanups)
    .where(where)
    .orderBy(asc(ruleEntryDomainCleanups.id))
    .limit(Math.max(1, Math.min(500, Number(options.limit || 100))));
  return rows as RuleEntryDomainCleanupRow[];
}

export async function deleteRuleEntryDomainCleanup(domain: string) {
  const db = await getDb();
  if (!db) return;
  await db.delete(ruleEntryDomainCleanups).where(eq(ruleEntryDomainCleanups.domain, domain));
}

export async function markRuleEntryDomainCleanupFailed(domain: string, attempts: number, message: string, nextRetryAt: Date) {
  const db = await getDb();
  if (!db) return;
  await db.update(ruleEntryDomainCleanups).set({
    attempts,
    lastError: String(message || "未知错误").slice(0, 1000),
    nextRetryAt,
    updatedAt: nowDate(),
  } as any).where(eq(ruleEntryDomainCleanups.domain, domain));
}
