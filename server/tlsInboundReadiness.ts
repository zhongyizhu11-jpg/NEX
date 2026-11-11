/**
 * 转发组 / 入口组的一台入口机上，共享 TLS 入站（SNI 分流）的配置「确认好了没有」。
 *
 * 为什么要单独判断：组的 DDNS 一切过去，客户端就按域名连到这台机器的 443。要是这台机器的 SNI 路由表
 * 还没装上（Agent 太旧、入站没开、子规则还没起来、表还没下发到），连接会被直接断开 —— 比留在原来
 * 那台上糟得多。所以组里有 SNI 规则时，DDNS 只会切到（入口组只会新加进）这里判定为就绪的成员。
 *
 * 就绪的条件（组里每条启用的 SNI 模板都要满足）：
 *   1. 入口机 Agent ≥ TLS_INBOUND_ROUTED_AGENT_VERSION（老 Agent 不回报版本号，确认不了）；
 *   2. 这台机器上有这条模板的子规则，而且挂在**这台机器自己的**、启用着的入站上（同端口）；
 *   3. 子规则启用着、Agent 已经报它在跑（规则自己的回环入口起来了）；
 *   4. Agent 报回来的路由表版本号就是面板最近下发的那张（tlsInboundRuntime.ts）。
 *
 * 只挡「切过去 / 加进去」，不挡「留在原地」：面板刚重启时谁都还没确认，已经在用的入口照旧在用，
 * 等下一次心跳确认了就恢复正常判断（调用方负责只拿它筛候选，见 forwardGroupRepository.ts）。
 */

import { and, eq, inArray } from "drizzle-orm";

import { forwardRules } from "../drizzle/schema";
import { getDb } from "./dbRuntime";
import { getHostById } from "./repositories/hostRepository";
import { dbBool } from "./repositories/repositoryUtils";
import { listTlsInboundsByHost, type TlsInboundRow } from "./repositories/tlsInboundRepository";
import { isTlsInboundTableConfirmed } from "./tlsInboundRuntime";
import { isTlsInboundRoutedAgentSupported, TLS_INBOUND_ROUTED_AGENT_VERSION } from "../shared/tlsInbound";

export type SniReadinessTemplate = { id: number; name?: unknown; isEnabled?: unknown; tlsInboundId?: unknown; pendingDelete?: unknown };
export type SniReadinessChild = {
  id: number;
  hostId: unknown;
  forwardGroupRuleId: unknown;
  tlsInboundId: unknown;
  isEnabled: unknown;
  isRunning: unknown;
  pendingDelete?: unknown;
};

export type SniMemberReadiness = { ready: boolean; reason: string | null };

/** 组里需要看的 SNI 模板：启用着、挂着入站、没在删除中。 */
export function activeSniTemplates<T extends SniReadinessTemplate>(templates: readonly T[]) {
  return templates.filter((template) => Number(template.tlsInboundId || 0) > 0
    && dbBool(template.isEnabled)
    && !dbBool(template.pendingDelete));
}

/** 纯函数：给定这台入口机上的东西，判断它的 SNI 配置就没就绪。没有 SNI 模板时永远就绪（不挡普通组）。 */
export function evaluateSniMemberReadiness(input: {
  hostId: number;
  agentVersion: string | null | undefined;
  templates: readonly SniReadinessTemplate[];
  children: readonly SniReadinessChild[];
  inboundById: ReadonlyMap<number, Pick<TlsInboundRow, "id" | "hostId" | "port" | "isEnabled">>;
  confirmed: (hostId: number, inboundId: number) => boolean;
}): SniMemberReadiness {
  const templates = activeSniTemplates(input.templates);
  if (templates.length === 0) return { ready: true, reason: null };
  const hostId = Number(input.hostId);
  if (!isTlsInboundRoutedAgentSupported(input.agentVersion)) {
    return { ready: false, reason: `Agent 版本低于 ${TLS_INBOUND_ROUTED_AGENT_VERSION}，共享 TLS 入站的路由表无法确认` };
  }
  for (const template of templates) {
    const label = String(template.name || "").trim() || `#${template.id}`;
    const child = input.children.find((rule) => Number(rule.forwardGroupRuleId) === Number(template.id)
      && Number(rule.hostId) === hostId
      && !dbBool(rule.pendingDelete));
    if (!child) return { ready: false, reason: `规则「${label}」在这台入口上还没有子规则` };
    const inbound = input.inboundById.get(Number(child.tlsInboundId || 0));
    if (!inbound || Number(inbound.hostId) !== hostId) {
      return { ready: false, reason: `这台入口上没有规则「${label}」要用的共享 TLS 入站（同端口）` };
    }
    if (!inbound.isEnabled) return { ready: false, reason: `这台入口上的共享 TLS 入站（端口 ${inbound.port}）已停用` };
    if (!dbBool(child.isEnabled)) return { ready: false, reason: `规则「${label}」在这台入口上的子规则已停用` };
    if (!dbBool(child.isRunning)) return { ready: false, reason: `规则「${label}」在这台入口上还没跑起来` };
    if (!input.confirmed(hostId, inbound.id)) {
      return { ready: false, reason: `这台入口的 SNI 路由表（端口 ${inbound.port}）还没被 Agent 确认` };
    }
  }
  return { ready: true, reason: null };
}

/**
 * 从库里取齐一台入口机要看的东西再判断。templates 是相关组的模板（调用方手里通常已经有了）。
 * 取数出错按「没就绪」处理：宁可不切，也不切到一台说不清的机器上。
 */
export async function loadSniMemberReadiness(hostId: number, templates: readonly SniReadinessTemplate[]): Promise<SniMemberReadiness> {
  const active = activeSniTemplates(templates);
  if (active.length === 0) return { ready: true, reason: null };
  try {
    const db = await getDb();
    if (!db) return { ready: false, reason: "数据库不可用" };
    const [host, children, inbounds] = await Promise.all([
      getHostById(Number(hostId)),
      db.select({
        id: forwardRules.id,
        hostId: forwardRules.hostId,
        forwardGroupRuleId: forwardRules.forwardGroupRuleId,
        tlsInboundId: forwardRules.tlsInboundId,
        isEnabled: forwardRules.isEnabled,
        isRunning: forwardRules.isRunning,
        pendingDelete: forwardRules.pendingDelete,
      }).from(forwardRules).where(and(
        eq(forwardRules.hostId, Number(hostId)),
        inArray(forwardRules.forwardGroupRuleId, active.map((template) => Number(template.id))),
      )),
      listTlsInboundsByHost(Number(hostId)),
    ]);
    return evaluateSniMemberReadiness({
      hostId: Number(hostId),
      agentVersion: String(host?.agentVersion || ""),
      templates: active,
      children: children as SniReadinessChild[],
      inboundById: new Map(inbounds.map((inbound) => [inbound.id, inbound] as const)),
      confirmed: isTlsInboundTableConfirmed,
    });
  } catch (error) {
    return { ready: false, reason: `无法确认共享 TLS 入站状态：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * DDNS 选成员时用：只留下 SNI 已就绪的候选。keepMemberId（当前在用的那台）不受影响 ——
 * 「不切过去」不等于「从原地撤走」。返回没就绪的成员和原因，调用方写进事件里。
 */
export async function filterSniReadyCandidates<M extends { id: unknown }>(options: {
  candidates: readonly M[];
  keepMemberId?: unknown;
  templates: readonly SniReadinessTemplate[];
  hostIdOf: (member: M) => number | Promise<number>;
  /** 测试里替换；默认从库里取（loadSniMemberReadiness）。 */
  load?: (hostId: number, templates: readonly SniReadinessTemplate[]) => Promise<SniMemberReadiness>;
}): Promise<{ ready: M[]; blocked: Array<{ member: M; reason: string }> }> {
  const load = options.load || loadSniMemberReadiness;
  if (activeSniTemplates(options.templates).length === 0) return { ready: [...options.candidates], blocked: [] };
  const ready: M[] = [];
  const blocked: Array<{ member: M; reason: string }> = [];
  for (const member of options.candidates) {
    if (Number(member.id) === Number(options.keepMemberId || 0)) {
      ready.push(member);
      continue;
    }
    const hostId = Number(await options.hostIdOf(member)) || 0;
    const readiness = hostId > 0 ? await load(hostId, options.templates) : { ready: false, reason: "成员没有入口主机" };
    if (readiness.ready) ready.push(member);
    else blocked.push({ member, reason: readiness.reason || "共享 TLS 入站未就绪" });
  }
  return { ready, blocked };
}
