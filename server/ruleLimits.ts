import { and, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { forwardRules } from "../drizzle/schema";
import * as db from "./db";
import { executeRaw, getDb, withDatabaseTransaction } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { appendPanelLog } from "./_core/panelLogger";
import { isAdminManagedRule, normalizeRuleLimitReason, ruleLimitReason, type RuleLimitReason } from "../shared/ruleLimits";

/**
 * 单条规则限额的执行（判定见 shared/ruleLimits.ts）。
 *
 * 计量不另起一套：流量上报那一路（agentReportRoutes /api/agent/traffic）在同一个记账事务里，
 * 把已经通过「这台机器替谁记账」判定、写进 traffic_stats 的那一批（trafficBatch）顺手累加到
 * 规则行的 quotaUsedIn/Out 上。转发组成员汇总到模板、线路组中转跳不计（它们本来就不记账），
 * 转发链只算第一跳 —— 都由 shouldAccountForwardRuleTraffic 先筛过。
 *
 * 停用不改规则自己的开关：到期或额度用尽时只在规则上记 ruleLimitReason，心跳下发时由
 * gateForwardRulesForRuntime → applyRuleLimitsForRuntime 把它当成停用（和授权失效一样），
 * 管理员放宽限额 / 延期 / 重置用量后自动恢复，不需要记住「停之前是开着的」。
 */

/** 一条规则的限额归哪一行管：转发组成员归模板，线路组中转跳归父规则。 */
export function ruleLimitRootId(rule: any) {
  return Number(rule?.forwardGroupRuleId || 0) || Number(rule?.routeParentRuleId || 0) || Number(rule?.id || 0);
}

function isDerivedRule(rule: any) {
  return Number(rule?.forwardGroupRuleId || 0) > 0 || Number(rule?.routeParentRuleId || 0) > 0;
}

/** 根规则（不是转发组成员）里的限额策略。不给 ids 时只取设过额度 / 到期 / 记过原因的。 */
export async function getRuleLimitPolicies(ids?: number[]): Promise<any[]> {
  const connection = await getDb();
  const uniqueIds = ids ? Array.from(new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))) : undefined;
  if (!connection || (uniqueIds && uniqueIds.length === 0)) return [];
  return connection.select().from(forwardRules).where(and(
    eq(forwardRules.pendingDelete, false),
    or(isNull(forwardRules.forwardGroupRuleId), eq(forwardRules.forwardGroupRuleId, 0)),
    uniqueIds
      ? inArray(forwardRules.id, uniqueIds)
      : or(gt(forwardRules.trafficLimit, 0), isNotNull(forwardRules.expiresAt), isNotNull(forwardRules.ruleLimitReason)),
  ));
}

type TrafficTotals = { bytesIn: number; bytesOut: number };

async function counterTotalsForRules(ids: number[]) {
  const totals = new Map<number, TrafficTotals>();
  if (ids.length === 0) return totals;
  for (const row of await db.getTrafficCounterSummaryByRule({ ruleIds: ids, includeLatency: false })) {
    const total = totals.get(Number(row.ruleId)) || { bytesIn: 0, bytesOut: 0 };
    total.bytesIn += Number(row.bytesIn) || 0;
    total.bytesOut += Number(row.bytesOut) || 0;
    totals.set(Number(row.ruleId), total);
  }
  return totals;
}

async function reasonsForPolicies(policies: any[]) {
  // 管理员刚接手一条已经在跑的规则：用量第一次从现有的累计计数起算，之后只增不减
  // （成员规则换掉、计数表重建都不会把额度清零）。
  const quotaIds = policies.filter((rule) => isAdminManagedRule(rule) && rule.quotaUsedIn == null).map((rule) => Number(rule.id));
  const totals = new Map<number, TrafficTotals>();
  if (quotaIds.length > 0) {
    const baseline = await counterTotalsForRules(quotaIds);
    const connection = await getDb();
    if (connection) {
      for (const id of quotaIds) {
        const total = baseline.get(id) || { bytesIn: 0, bytesOut: 0 };
        // 并发的上报可能已经初始化过：只在还是 null 的时候写，绝不覆盖已有的计数。
        await connection.update(forwardRules).set({ quotaUsedIn: total.bytesIn, quotaUsedOut: total.bytesOut } as any)
          .where(and(eq(forwardRules.id, id), isNull(forwardRules.quotaUsedIn)));
      }
    }
    for (const policy of await getRuleLimitPolicies(quotaIds)) {
      totals.set(Number(policy.id), { bytesIn: Number(policy.quotaUsedIn) || 0, bytesOut: Number(policy.quotaUsedOut) || 0 });
    }
  }
  return new Map<number, RuleLimitReason | null>(policies.map((rule) => [Number(rule.id), ruleLimitReason(rule, totals.get(Number(rule.id)) || {
    bytesIn: Number(rule.quotaUsedIn) || 0,
    bytesOut: Number(rule.quotaUsedOut) || 0,
  })]));
}

/**
 * 在流量上报的记账事务里调用（同一批 trafficBatch、同一把用户锁），把这一批累加到规则用量上。
 */
export async function recordRuleQuotaTraffic(items: db.TrafficStatBatchItem[], contexts: Map<number, any>) {
  const deltas = new Map<number, TrafficTotals>();
  for (const item of items) {
    const rule = contexts.get(Number(item.stat.ruleId))?.rule;
    if (!rule) continue;
    // 普通规则只有管理员管理的、或已经开始记的才累加；成员规则要看模板，统一查一次。
    if (!isDerivedRule(rule) && !isAdminManagedRule(rule) && rule.quotaUsedIn == null) continue;
    const id = ruleLimitRootId(rule);
    const delta = deltas.get(id) || { bytesIn: 0, bytesOut: 0 };
    delta.bytesIn += Math.max(0, Number(item.stat.bytesIn) || 0);
    delta.bytesOut += Math.max(0, Number(item.stat.bytesOut) || 0);
    deltas.set(id, delta);
  }
  if (deltas.size === 0) return;
  const policies = (await getRuleLimitPolicies([...deltas.keys()]))
    .filter((rule) => isAdminManagedRule(rule) || rule.quotaUsedIn != null);
  const missingIds = policies.filter((rule) => rule.quotaUsedIn == null).map((rule) => Number(rule.id));
  const totals = await counterTotalsForRules(missingIds);
  for (const policy of policies) {
    const id = Number(policy.id);
    const delta = deltas.get(id);
    if (!delta) continue;
    const total = totals.get(id) || delta;
    // 计数表里已经含这一批：第一次初始化时基线要扣掉这一批；COALESCE 兜住并发初始化。
    await executeRaw(
      `UPDATE ${q("forward_rules")} SET
        ${q("quotaUsedIn")} = COALESCE(${q("quotaUsedIn")}, ?) + ?,
        ${q("quotaUsedOut")} = COALESCE(${q("quotaUsedOut")}, ?) + ?
      WHERE ${q("id")} = ?`,
      [Math.max(0, total.bytesIn - delta.bytesIn), delta.bytesIn, Math.max(0, total.bytesOut - delta.bytesOut), delta.bytesOut, id],
    );
  }
}

/** 管理员重置规则数据时一并清零规则用量（只动设过额度或已经在记的）。 */
export async function resetRuleQuotaCounters(ids: number[]) {
  const connection = await getDb();
  const ruleIds = Array.from(new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  if (!connection || ruleIds.length === 0) return;
  await connection.update(forwardRules).set({ quotaUsedIn: 0, quotaUsedOut: 0 } as any).where(and(
    inArray(forwardRules.id, ruleIds),
    or(isNotNull(forwardRules.quotaUsedIn), gt(forwardRules.trafficLimit, 0)),
  ));
}

/**
 * 下发前把限额套到运行时视图上：成员规则 / 中转跳继承根规则的限速，根规则到期或额度用尽时
 * 整组按停用下发（克隆出来的行，不改数据库）。到期每次现算，不等定时任务把原因写回。
 */
export async function applyRuleLimitsForRuntime<T extends Record<string, any>>(rules: T[]): Promise<T[]> {
  if (rules.length === 0) return rules;
  const parentIds = Array.from(new Set(rules.filter(isDerivedRule).map(ruleLimitRootId)));
  const policies = [...rules.filter((rule) => !isDerivedRule(rule)), ...await getRuleLimitPolicies(parentIds)];
  const byId = new Map<number, any>(policies.map((rule) => [Number(rule.id), rule]));
  const reasons = await reasonsForPolicies(policies.filter((rule) => (
    Number(rule.trafficLimit) > 0 || !!rule.expiresAt || !!rule.ruleLimitReason || isAdminManagedRule(rule)
  )));
  return rules.map((rule) => {
    const policy = byId.get(ruleLimitRootId(rule));
    if (!policy) return rule;
    const reason = reasons.get(Number(policy.id)) || null;
    // 没有限额要套的原样返回（同一个对象）：调用方靠对象身份避免无谓的重建。成员规则 / 中转跳
    // 只有根规则设了限额时才需要克隆出一份带着继承来的限速。
    const policyHasLimits = Number(policy.rateLimitMbps) > 0 || Number(policy.trafficLimit) > 0 || !!policy.expiresAt;
    if (!reason && !rule.ruleLimitReason && (!isDerivedRule(rule) || !policyHasLimits)) return rule;
    return {
      ...rule,
      rateLimitMbps: policy.rateLimitMbps,
      expiresAt: policy.expiresAt,
      trafficLimit: policy.trafficLimit,
      trafficMode: policy.trafficMode,
      ruleLimitReason: reason,
      ...(reason ? { isEnabled: false, resourceAccessDenied: true } : {}),
    };
  });
}

/** 限额状态或限速变了：通知这条规则（和它的成员、中转跳、隧道两头）所在的机器重算。 */
export async function refreshRuleLimitAgents(policy: any, reason = "rule-limits-changed") {
  const rows: any[] = [policy, ...await db.getForwardGroupChildRulesForTemplate(Number(policy.id)).catch(() => [] as any[])];
  const hostIds = new Set<number>(rows.map((rule) => Number(rule.hostId)).filter((id) => id > 0));
  for (const tunnelId of new Set(rows.map((rule) => Number(rule.tunnelId)).filter((id) => id > 0))) {
    const tunnel: any = await db.getTunnelById(tunnelId);
    if (!tunnel) continue;
    for (const id of await db.forwardRuleListenHostIds(Number(policy.hostId || tunnel.entryHostId), tunnelId).catch(() => [] as number[])) hostIds.add(Number(id));
    hostIds.add(Number(tunnel.entryHostId));
    hostIds.add(Number(tunnel.exitHostId));
    for (const hop of await db.getTunnelHops(tunnelId)) hostIds.add(Number((hop as any).hostId));
    for (const exit of await db.getTunnelExitNodes(tunnelId)) hostIds.add(Number((exit as any).hostId));
  }
  // 不清隧道的就绪状态：正常的对账会只重发变了的那条规则，不牵动同一隧道上的其他规则。
  const { pushAgentRefresh } = await import("./agentEvents");
  for (const id of hostIds) if (id > 0) pushAgentRefresh(id, reason, { urgent: true });
  await db.pushRouteRelayHostsForParents([Number(policy.id)], reason);
}

/**
 * 重新判定一批（或全部有限额的）规则，原因变了就写回并通知 Agent。返回这批里有没有设流量额度的
 * —— 流量上报据此把上报间隔调短（额度要及时生效）。
 */
export async function reconcileRuleLimits(ids?: number[], forceRefresh = false) {
  if (ids && ids.length === 0) return false;
  return withKeyedTaskLock("rule-limits-reconcile", async () => {
    const candidates = await getRuleLimitPolicies(ids);
    if (!forceRefresh && !candidates.some((rule) => Number(rule.trafficLimit) > 0 || rule.expiresAt || rule.ruleLimitReason)) return false;
    // 网络通知放到事务外面做。
    const outcome = await withDatabaseTransaction(async () => {
      const policies = await getRuleLimitPolicies(ids);
      const reasons = await reasonsForPolicies(policies);
      const connection = await getDb();
      const refresh: any[] = [];
      const transitions: Array<{ id: number; reason: RuleLimitReason | null }> = [];
      if (!connection) return { policies, refresh, transitions };
      for (const policy of policies) {
        const reason = reasons.get(Number(policy.id)) || null;
        const changed = normalizeRuleLimitReason(policy.ruleLimitReason) !== reason;
        if (changed) {
          await connection.update(forwardRules).set({ ruleLimitReason: reason } as any).where(eq(forwardRules.id, policy.id));
          transitions.push({ id: Number(policy.id), reason });
        }
        if (changed || forceRefresh) refresh.push(policy);
      }
      return { policies, refresh, transitions };
    });
    for (const transition of outcome.transitions) {
      appendPanelLog(transition.reason ? "warn" : "info", `[RuleLimits] rule=${transition.id} state=${transition.reason || "available"}`);
    }
    for (const policy of outcome.refresh) await refreshRuleLimitAgents(policy);
    return outcome.policies.some((policy) => Number(policy.trafficLimit) > 0);
  });
}
