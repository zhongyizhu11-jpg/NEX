import { domainToASCII } from "node:url";
import { appendPanelLog } from "./_core/panelLogger";
import { updateDdnsRecordValues, type DdnsRecordValuesInput } from "./ddns";
import { HostDdnsRetryScheduler, HostDdnsUpdateCoordinator } from "./hostDdns";
import { withKeyedTaskLock } from "./keyedTaskLock";
import * as repo from "./repositories/ruleEntryDomainRepository";
import { registerRuleEntryDomainListener } from "./ruleEntryDomainSignals";
import { getHostEntryAddress } from "@shared/hostEntryAddress";
import {
  normalizeRuleEntryDomainSuffix,
  normalizeRuleEntryDomainValue,
  ruleEntryDomainName,
  ruleEntryDomainRecordType,
  ruleQualifiesForEntryDomain,
  type RuleEntryDomainRecordType,
} from "@shared/ruleEntryDomain";

/*
  规则专属域名的同步（命名、资格见 shared/ruleEntryDomain.ts）。

  做法照着主机 DDNS（server/hostDdns.ts）：按规则一把在途闸，失败按指数退避重试，
  面板日志统一打 [RuleDomain]。

  状态只有两处：
  - 规则行上的 entryDomain / entryDomainValue：「此刻属于这条规则、发布成功了的那条记录」；
  - rule_entry_domain_cleanups：要删还没删掉的记录。
  规则不再需要域名（停用、解绑、隐藏、删除、后缀改了、功能关了）时，先把域名挪进
  待删表、清掉规则上的列，再去删 DNS。这样订阅立刻退回入口地址，删记录失败也只是
  待删表里多留一行，定时对账接着删 —— 规则行被真正删掉之后同样靠这张表找回下落。
*/

/**
 * Webhook 负载里 groupId 的取值空间：转发组用正数，主机 DDNS 用 -hostId，规则域名用
 * -(10 亿 + 规则 ID)。主机 ID 到不了 10 亿，两者不会撞；MySQL INT 的规则 ID 上限约
 * 21 亿，结果在 -31 亿以内，JSON 和 JS 数字都放得下。接 Webhook 的脚本可以按
 * 「<= -1000000000」认出这是规则域名。
 */
export const RULE_ENTRY_DOMAIN_WEBHOOK_GROUP_ID_BASE = 1_000_000_000;

export function ruleEntryDomainWebhookGroupId(ruleId: number) {
  return -(RULE_ENTRY_DOMAIN_WEBHOOK_GROUP_ID_BASE + Math.max(0, Math.floor(Number(ruleId) || 0)));
}

/** 同一条规则在这段时间内的多次触发合成一次（一次保存会连着改好几列）。 */
const RULE_ENTRY_DOMAIN_DEBOUNCE_MS = 300;
const RULE_ENTRY_DOMAIN_RETRY_BASE_MS = 60_000;
const RULE_ENTRY_DOMAIN_RETRY_MAX_MS = 30 * 60_000;
const RULE_ENTRY_DOMAIN_RECORD_TYPES: RuleEntryDomainRecordType[] = ["A", "AAAA", "CNAME"];

export type RuleEntryDomainDnsClient = {
  updateValues(input: DdnsRecordValuesInput): Promise<void>;
};

const defaultDnsClient: RuleEntryDomainDnsClient = {
  updateValues: (input) => updateDdnsRecordValues(input),
};
let dnsClient: RuleEntryDomainDnsClient = defaultDnsClient;

/*
  在途闸和重试定时器借用主机 DDNS 的两个类（按正整数键，和主机无关）。用到时才建：
  hostDdns → db → …… → 本模块 这条引用链上，本模块可能先于 hostDdns 求值完，
  模块顶层直接 new 会撞上类还没初始化。
*/
let retryBaseMs = RULE_ENTRY_DOMAIN_RETRY_BASE_MS;
let retryMaxMs = RULE_ENTRY_DOMAIN_RETRY_MAX_MS;
let coordinatorInstance: HostDdnsUpdateCoordinator | null = null;
let retrySchedulerInstance: HostDdnsRetryScheduler | null = null;

function coordinator() {
  coordinatorInstance ??= new HostDdnsUpdateCoordinator(Date.now, retryBaseMs, retryMaxMs);
  return coordinatorInstance;
}

function retryScheduler() {
  retrySchedulerInstance ??= createRetryScheduler();
  return retrySchedulerInstance;
}

function createRetryScheduler() {
  return new HostDdnsRetryScheduler(
    (ruleId) => {
      if (!coordinator().canReconcile(ruleId)) return;
      return runRuleEntryDomainSync(ruleId, "rule-domain-retry");
    },
    Date.now,
    setTimeout,
    clearTimeout,
    (error) => {
      appendPanelLog("warn", `[RuleDomain] retry wake failed: ${errorMessage(error)}`);
    },
  );
}

/** 测试用：换掉 DNS 客户端、缩短退避。传 null 恢复默认。 */
export function configureRuleEntryDomainForTests(options: {
  dnsClient?: RuleEntryDomainDnsClient | null;
  retryBaseMs?: number;
  retryMaxMs?: number;
} = {}) {
  if (options.dnsClient !== undefined) dnsClient = options.dnsClient || defaultDnsClient;
  if (options.retryBaseMs !== undefined || options.retryMaxMs !== undefined) {
    retryBaseMs = options.retryBaseMs ?? RULE_ENTRY_DOMAIN_RETRY_BASE_MS;
    retryMaxMs = options.retryMaxMs ?? RULE_ENTRY_DOMAIN_RETRY_MAX_MS;
    coordinatorInstance = null;
    retrySchedulerInstance = null;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function lockKey(domain: string) {
  return `rule-entry-domain:${domain}`;
}

/**
 * 系统设置里填的后缀 → 存库的值。空串表示关闭；格式不对抛错，让设置页直接报出来。
 * 国际化域名在这里转成 punycode，DNS 服务商只认 ASCII。
 */
export function normalizeRuleEntryDomainSuffixInput(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
  if (!raw) return "";
  const ascii = domainToASCII(raw.toLowerCase()) || "";
  const normalized = normalizeRuleEntryDomainSuffix(ascii);
  if (!normalized) {
    throw new Error("规则专属域名后缀格式不正确，请填写 DNS 服务商里已托管区域下的域名，例如 node.example.com");
  }
  return normalized;
}

// ===== 调度 =====

const debounceTimers = new Map<number, { timer: ReturnType<typeof setTimeout>; reason: string; force: boolean }>();
const inFlightRuns = new Set<Promise<void>>();

function track(promise: Promise<void>) {
  inFlightRuns.add(promise);
  void promise.finally(() => inFlightRuns.delete(promise));
  return promise;
}

/**
 * 某条规则的域名可能要变了：稍等一下再同步（合并同一次保存里的多次触发，也避开
 * 调用方还没提交的事务）。不等结果、不抛错。
 */
export function scheduleRuleEntryDomainSync(ruleIdValue: unknown, reason: string, options: { force?: boolean } = {}) {
  const ruleId = Number(ruleIdValue);
  if (!Number.isInteger(ruleId) || ruleId <= 0) return;
  const existing = debounceTimers.get(ruleId);
  if (existing) clearTimeout(existing.timer);
  const force = !!options.force || !!existing?.force;
  const timer = setTimeout(() => {
    debounceTimers.delete(ruleId);
    void track(runRuleEntryDomainSync(ruleId, reason, { force }));
  }, RULE_ENTRY_DOMAIN_DEBOUNCE_MS);
  timer.unref?.();
  debounceTimers.set(ruleId, { timer, reason, force });
}

/** 一台主机的入口地址变了：它上面和规则域名有关的规则都要重算记录值。 */
export async function scheduleRuleEntryDomainSyncForHost(hostIdValue: unknown, reason: string) {
  const hostId = Number(hostIdValue);
  if (!Number.isInteger(hostId) || hostId <= 0) return 0;
  try {
    const ruleIds = await repo.listRuleEntryDomainRuleIdsForHost(hostId);
    for (const ruleId of ruleIds) scheduleRuleEntryDomainSync(ruleId, reason);
    return ruleIds.length;
  } catch (error) {
    appendPanelLog("warn", `[RuleDomain] host=${hostId} schedule failed: ${errorMessage(error)}`);
    return 0;
  }
}

/** 规则行被删之后：尽快去删记下来的待删域名。 */
let cleanupSweepTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleRuleEntryDomainCleanupSweep(reason = "rule-deleted") {
  // 一批删行只扫一遍待删表。
  if (cleanupSweepTimer) return;
  cleanupSweepTimer = setTimeout(() => {
    cleanupSweepTimer = null;
    void track(processRuleEntryDomainCleanups({ reason }).then(() => undefined, (error) => {
      appendPanelLog("warn", `[RuleDomain] cleanup sweep failed: ${errorMessage(error)}`);
    }));
  }, RULE_ENTRY_DOMAIN_DEBOUNCE_MS);
  cleanupSweepTimer.unref?.();
}

/** 测试用：等排着的和在跑的同步都结束（不含退避中的重试）。 */
export async function waitForRuleEntryDomainIdle(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (debounceTimers.size > 0 || cleanupSweepTimer || inFlightRuns.size > 0) {
    if (Date.now() > deadline) throw new Error("rule entry domain sync did not settle");
    if (inFlightRuns.size > 0) await Promise.allSettled(Array.from(inFlightRuns));
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runRuleEntryDomainSync(ruleId: number, reason: string, options: { force?: boolean } = {}) {
  if (options.force) retryScheduler().replace(ruleId, null);
  if (!coordinator().tryStart(ruleId, options)) return;
  let retryAt: number | null = null;
  try {
    const ok = await executeRuleEntryDomainSync(ruleId, reason, options);
    if (ok) {
      coordinator().recordSuccess(ruleId);
      retryScheduler().replace(ruleId, null);
    } else {
      retryAt = coordinator().recordFailure(ruleId);
    }
  } catch (error) {
    // executeRuleEntryDomainSync 自己会记错误；走到这里的是读库之类的意外。
    retryAt = coordinator().recordFailure(ruleId);
    appendPanelLog("warn", `[RuleDomain] rule=${ruleId} sync crashed reason=${reason}: ${errorMessage(error)}`);
  } finally {
    // 和主机 DDNS 一样：先放掉在途闸再挂重试，免得重试定时器被自己挡掉。
    const outcome = coordinator().finish(ruleId);
    if (retryAt) retryScheduler().replace(ruleId, retryAt);
    if (outcome.immediate) {
      coordinator().recordSuccess(ruleId);
      retryScheduler().replace(ruleId, null);
    }
    if (outcome.rerunRequested && coordinator().canReconcile(ruleId)) {
      void track(runRuleEntryDomainSync(ruleId, `${reason}-rerun`, { force: outcome.immediate }));
    }
  }
}

// ===== 单条规则 =====

async function deleteRecord(domain: string, recordType: string | null, ruleId: number) {
  const types = recordType && RULE_ENTRY_DOMAIN_RECORD_TYPES.includes(recordType as RuleEntryDomainRecordType)
    ? [recordType]
    : RULE_ENTRY_DOMAIN_RECORD_TYPES;
  for (const type of types) {
    await dnsClient.updateValues({ domain, recordType: type, values: [], groupId: ruleEntryDomainWebhookGroupId(ruleId) });
  }
}

/**
 * 删一条待删域名。还有规则认领着它（面板迁移后 ID 重排、或者它刚被重新发布）就只
 * 去掉待删行、不删记录。和发布共用按域名的锁，两边不会交错。
 */
async function processCleanup(row: repo.RuleEntryDomainCleanupRow, reason: string) {
  return withKeyedTaskLock(lockKey(row.domain), async () => {
    if (await repo.isRuleEntryDomainClaimed(row.domain)) {
      await repo.deleteRuleEntryDomainCleanup(row.domain);
      return true;
    }
    try {
      await deleteRecord(row.domain, row.recordType, Number(row.ruleId));
      await repo.deleteRuleEntryDomainCleanup(row.domain);
      appendPanelLog("info", `[RuleDomain] rule=${row.ruleId} deleted ${row.recordType || "A/AAAA/CNAME"} ${row.domain} reason=${reason}`);
      return true;
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(attempts - 1, 30)));
      await repo.markRuleEntryDomainCleanupFailed(row.domain, attempts, errorMessage(error), new Date(Date.now() + delay)).catch(() => undefined);
      appendPanelLog("warn", `[RuleDomain] rule=${row.ruleId} delete failed domain=${row.domain}: ${errorMessage(error)}`);
      return false;
    }
  });
}

/**
 * 把一条规则的域名对到它该有的样子。返回 false 表示要退避重试。
 */
async function executeRuleEntryDomainSync(ruleId: number, reason: string, options: { force?: boolean }) {
  const settings = await repo.getRuleEntryDomainRuntimeSettings();
  const rule = await repo.getRuleEntryDomainRule(ruleId);
  // 行已经没了：它的域名在删行前记进了待删表，由待删表那边处理。
  if (!rule) return true;

  const desiredDomain = settings.activeSuffix && ruleQualifiesForEntryDomain(rule)
    ? ruleEntryDomainName(rule.id, settings.activeSuffix)
    : "";
  let publishedDomain = String(rule.entryDomain || "").trim().toLowerCase();
  let publishedValue = String(rule.entryDomainValue || "").trim();

  // 1. 身上的域名不是该有的那个（不再需要、后缀改了、DNS 关了）：挪进待删表再删。
  if (publishedDomain && publishedDomain !== desiredDomain) {
    const retiredDomain = publishedDomain;
    await withKeyedTaskLock(lockKey(retiredDomain), () => repo.retireRuleEntryDomain(ruleId, retiredDomain, publishedValue || null));
    publishedDomain = "";
    publishedValue = "";
    if (settings.ddnsActive) {
      const [cleanup] = await repo.listDueRuleEntryDomainCleanups({ domain: retiredDomain });
      // 删失败不算这条规则失败：待删表自己按退避重试。
      if (cleanup) await processCleanup(cleanup, reason);
    }
  }
  if (!desiredDomain) {
    if (rule.entryDomainError && !publishedDomain) await repo.clearRuleEntryDomainError(ruleId);
    return true;
  }

  // 2. 记录值 = 规则当前入口主机的首选入口地址（和订阅原来用的是同一个）。
  const [host] = await repo.getRuleEntryDomainHosts([Number(rule.hostId)]);
  const value = normalizeRuleEntryDomainValue(getHostEntryAddress(host as any));
  const recordType = ruleEntryDomainRecordType(value);
  if (!value || !recordType || value === desiredDomain) {
    // 入口机没有可用地址：不动已有记录（旧值多半还能用），等主机报上地址再触发。
    const message = value === desiredDomain ? "入口地址指向了规则域名自己" : "入口主机没有可用地址";
    if (rule.entryDomainError !== message) await repo.markRuleEntryDomainFailed(ruleId, message);
    return true;
  }
  if (!options.force && publishedDomain === desiredDomain && publishedValue === value && !rule.entryDomainError) {
    return true;
  }

  // 3. 发布。
  try {
    await withKeyedTaskLock(lockKey(desiredDomain), async () => {
      const groupId = ruleEntryDomainWebhookGroupId(ruleId);
      const previousType = publishedDomain === desiredDomain ? ruleEntryDomainRecordType(publishedValue) : null;
      // 换了类型（A → CNAME 之类）先删旧的：同名的 CNAME 和别的记录不能并存，服务商会拒。
      if (previousType && previousType !== recordType) {
        await dnsClient.updateValues({ domain: desiredDomain, recordType: previousType, values: [], groupId });
      }
      await dnsClient.updateValues({ domain: desiredDomain, recordType, values: [value], groupId });
      // 这个域名现在有主了，待删表里要是还挂着（后缀改回来、停用又启用）就撤掉。
      await repo.deleteRuleEntryDomainCleanup(desiredDomain);
      await repo.markRuleEntryDomainPublished(ruleId, desiredDomain, value);
    });
    appendPanelLog("info", `[RuleDomain] rule=${ruleId} ${recordType} ${desiredDomain} -> ${value} reason=${reason}`);
    return true;
  } catch (error) {
    const message = errorMessage(error);
    await repo.markRuleEntryDomainFailed(ruleId, message, desiredDomain).catch(() => undefined);
    appendPanelLog("warn", `[RuleDomain] rule=${ruleId} update failed domain=${desiredDomain} value=${value}: ${message}`);
    return false;
  }
}

// ===== 对账 =====

/** 删到期的待删域名。DNS 不可用时什么也不做（删不了），等它恢复。 */
export async function processRuleEntryDomainCleanups(options: { reason?: string; limit?: number } = {}) {
  const settings = await repo.getRuleEntryDomainRuntimeSettings();
  if (!settings.ddnsActive) return { deleted: 0, failed: 0 };
  const rows = await repo.listDueRuleEntryDomainCleanups({ limit: options.limit ?? 100 });
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    if (await processCleanup(row, options.reason || "rule-domain-cleanup")) deleted += 1;
    else failed += 1;
  }
  return { deleted, failed };
}

/**
 * 定时对账：找出和期望对不上的规则逐条同步，再删到期的待删域名。
 *
 * 规则的开关、解绑、删除、换入口在保存时都会立刻触发同步；这里兜的是漏掉的那些
 * （批量改库、面板重启时正在重试的、主机地址变了没赶上的），以及退避到期的重试。
 * 先同步规则、后删待删域名：规则重新认领的域名会先从待删表里撤掉，不会被误删。
 */
export async function reconcileRuleEntryDomains(reason = "rule-domain-reconcile", options: { force?: boolean } = {}) {
  const settings = await repo.getRuleEntryDomainRuntimeSettings();
  const rules = await repo.listRuleEntryDomainCandidates();
  const hostRows = await repo.getRuleEntryDomainHosts(rules.map((rule) => Number(rule.hostId)));
  const hostById = new Map((hostRows as any[]).map((host) => [Number(host.id), host]));
  let synced = 0;
  for (const rule of rules) {
    const ruleId = Number(rule.id);
    const desiredDomain = settings.activeSuffix && ruleQualifiesForEntryDomain(rule)
      ? ruleEntryDomainName(ruleId, settings.activeSuffix)
      : "";
    const publishedDomain = String(rule.entryDomain || "").trim().toLowerCase();
    let drifted: boolean;
    if (!desiredDomain) {
      drifted = !!publishedDomain;
    } else {
      const value = normalizeRuleEntryDomainValue(getHostEntryAddress(hostById.get(Number(rule.hostId))));
      // 入口机眼下没地址时没什么可发的，只处理「身上挂着别的域名」要撤的情况；
      // 等主机报上地址，地址变更那条路会触发同步。
      drifted = !value
        ? !!publishedDomain && publishedDomain !== desiredDomain
        : !!options.force
          || publishedDomain !== desiredDomain
          || String(rule.entryDomainValue || "") !== value
          || !!rule.entryDomainError;
    }
    if (!drifted) continue;
    // 退避中的不打扰（force 除外），到期了再来。
    if (!options.force && !coordinator().canReconcile(ruleId)) continue;
    await track(runRuleEntryDomainSync(ruleId, reason, options));
    synced += 1;
  }
  const cleanups = await processRuleEntryDomainCleanups({ reason });
  return { synced, ...cleanups };
}

/** 设置改了之后整体对账一次（不等结果；测试可以用 waitForRuleEntryDomainIdle 等它做完）。 */
export function scheduleRuleEntryDomainReconcile(reason: string, options: { force?: boolean } = {}) {
  void track(reconcileRuleEntryDomains(reason, options).then(() => undefined, (error) => {
    appendPanelLog("warn", `[RuleDomain] reconcile failed reason=${reason}: ${errorMessage(error)}`);
  }));
}

// 仓库层的改动通知从这里接进来（见 server/ruleEntryDomainSignals.ts）。
registerRuleEntryDomainListener({
  sync: (ruleId, reason) => scheduleRuleEntryDomainSync(ruleId, reason),
  cleanup: (reason) => scheduleRuleEntryDomainCleanupSweep(reason),
});
