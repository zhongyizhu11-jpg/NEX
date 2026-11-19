/*
  一次组评估的作用域：这一轮要用的主机 / 隧道 / 子规则状态先批量读好放在这里，评估里那些
  「按成员取主机」「按规则取最新探测」的辅助函数先看这里，没有才去查库（P7：以前每个成员各查几次）。
  不在评估里调用这些辅助函数（保存校验、别的模块）时没有作用域，照旧逐个查。
  deferProviderWrite：这一轮只算结论时，走到要写服务商的地方记一笔，评估完交给发布队列。
*/

import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, inArray, sql } from "drizzle-orm";
import { forwardRules } from "../../drizzle/schema";
import { getDb, queryRaw } from "../dbRuntime";
import { flushPendingWrites } from "../dbWriteBatcher";
import { quoteIdentifier } from "../dbCompat";
import { getHostById } from "../repositories/hostRepository";
import { getTunnelById } from "../repositories/tunnelRepository";
import { dbBool, sqlBool } from "../repositories/repositoryUtils";
import { LooseRow } from "./common";

type ForwardGroupEvaluationRules = {
  childRulesByMemberId: Map<number, LooseRow[]>;
  enabledTemplateIds: Set<number>;
  latestTcpingByRuleId: Map<number, LooseRow>;
};

export type ForwardGroupEvaluationScope = {
  hostById: Map<number, LooseRow | null>;
  tunnelById: Map<number, LooseRow | null>;
  rules: ForwardGroupEvaluationRules | null;
  deferPublish: boolean;
  /** 这一轮碰到了要写服务商的地方但没写（deferPublish）：评估完把组交给发布队列。 */
  deferred: boolean;
};

export const forwardGroupEvaluationScope = new AsyncLocalStorage<ForwardGroupEvaluationScope>();

export async function evaluationHost(hostIdValue: unknown) {
  const hostId = Number(hostIdValue || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return null;
  const scope = forwardGroupEvaluationScope.getStore();
  if (scope?.hostById.has(hostId)) return scope.hostById.get(hostId) ?? null;
  const host = (await getHostById(hostId)) ?? null;
  scope?.hostById.set(hostId, host);
  return host;
}

export async function evaluationTunnel(tunnelIdValue: unknown) {
  const tunnelId = Number(tunnelIdValue || 0);
  if (!Number.isInteger(tunnelId) || tunnelId <= 0) return null;
  const scope = forwardGroupEvaluationScope.getStore();
  if (scope?.tunnelById.has(tunnelId)) return scope.tunnelById.get(tunnelId) ?? null;
  const tunnel = (await getTunnelById(tunnelId)) ?? null;
  scope?.tunnelById.set(tunnelId, tunnel);
  return tunnel;
}

/** 评估走到要写服务商的地方时问一句：这一轮只算结论的话记一笔、返回 true，调用方不写、不改组状态。 */
export function deferProviderWrite() {
  const scope = forwardGroupEvaluationScope.getStore();
  if (!scope?.deferPublish) return false;
  scope.deferred = true;
  return true;
}

/**
 * 一批规则各自最新的一条探测结果，一次查完（P7：以前每条子规则先刷一次写缓冲再查一次）。
 * 同一秒有几条时取 id 最大的那条。
 */
async function latestTcpingByRuleIds(ruleIds: number[]) {
  const ids = Array.from(new Set(ruleIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const latest = new Map<number, LooseRow>();
  if (ids.length === 0) return latest;
  await flushPendingWrites("tcping_stats");
  const table = quoteIdentifier("tcping_stats");
  const ruleId = quoteIdentifier("ruleId");
  const recordedAt = quoteIdentifier("recordedAt");
  const rows = await queryRaw<LooseRow>(
    `SELECT t.* FROM ${table} t JOIN (SELECT ${ruleId} AS ${quoteIdentifier("latestRuleId")}, MAX(${recordedAt}) AS ${quoteIdentifier("latestAt")} FROM ${table} WHERE ${ruleId} IN (${ids.map(() => "?").join(", ")}) GROUP BY ${ruleId}) m ON m.${quoteIdentifier("latestRuleId")} = t.${ruleId} AND m.${quoteIdentifier("latestAt")} = t.${recordedAt}`,
    ids,
  );
  for (const row of rows) {
    const id = Number(row.ruleId || 0);
    const previous = latest.get(id);
    if (!previous || Number(row.id || 0) > Number(previous.id || 0)) latest.set(id, row);
  }
  return latest;
}

/** 主备组这一轮评估要用的子规则状态：成员的子规则、哪些模板启用着、每条在跑的子规则最新的探测，三次查询读完。 */
export async function loadForwardGroupEvaluationRules(members: LooseRow[]): Promise<ForwardGroupEvaluationRules> {
  const db = await getDb();
  const memberIds = members.map((member) => Number(member?.id || 0)).filter((id) => id > 0);
  const childRows = memberIds.length > 0
    ? await db.select().from(forwardRules).where(and(
      inArray(forwardRules.forwardGroupMemberId, memberIds),
      sql`COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    )).orderBy(desc(forwardRules.createdAt))
    : [];
  const childRulesByMemberId = new Map<number, LooseRow[]>(memberIds.map((id) => [id, []]));
  for (const rule of childRows as LooseRow[]) childRulesByMemberId.get(Number(rule.forwardGroupMemberId || 0))?.push(rule);
  const templateRuleIds = Array.from(new Set((childRows as LooseRow[])
    .map((rule) => Number(rule.forwardGroupRuleId || 0))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const templateRows = templateRuleIds.length > 0
    ? await db
      .select({ id: forwardRules.id, isEnabled: forwardRules.isEnabled, pendingDelete: forwardRules.pendingDelete })
      .from(forwardRules)
      .where(inArray(forwardRules.id, templateRuleIds))
    : [];
  const enabledTemplateIds = new Set((templateRows as LooseRow[])
    .filter((rule) => dbBool(rule.isEnabled) && !dbBool(rule.pendingDelete))
    .map((rule) => Number(rule.id || 0))
    .filter((id) => id > 0));
  const probedRuleIds = (childRows as LooseRow[])
    .filter((rule) => enabledTemplateIds.has(Number(rule.forwardGroupRuleId || 0)) && dbBool(rule.isEnabled) && dbBool(rule.isRunning))
    .map((rule) => Number(rule.id));
  return { childRulesByMemberId, enabledTemplateIds, latestTcpingByRuleId: await latestTcpingByRuleIds(probedRuleIds) };
}

export async function latestTcping(ruleId: number) {
  const scoped = forwardGroupEvaluationScope.getStore()?.rules;
  if (scoped) return scoped.latestTcpingByRuleId.get(Number(ruleId));
  await flushPendingWrites("tcping_stats");
  const table = quoteIdentifier("tcping_stats");
  const result = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${quoteIdentifier("ruleId")} = ? ORDER BY ${quoteIdentifier("recordedAt")} DESC LIMIT 1`,
    [ruleId],
  );
  return result[0];
}
