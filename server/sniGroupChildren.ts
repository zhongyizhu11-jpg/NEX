/**
 * 转发组 / 转发链 / 端口转发资源上的 SNI 规则：模板在每台入口机上的子规则挂哪个入站、占哪些名字。
 *
 * 模板的 tlsInboundId 是建规则时选的那个入站（「锚点」，在某一台入口机上）。每台入口机上的子规则
 * 挂**这台机器自己的**、和锚点同端口的入站（shared/tlsInbound.ts 的 pickMemberTlsInbound）：
 *
 *   - 找到了、名字在它的白名单里、名字没被别人占：子规则挂它，名字记进侧表（rule_sni_names，
 *     记在子规则名下；锚点那台的名字记在模板名下，不重复记）。
 *   - 找不到 / 名字被占 / 不在白名单：子规则挂锚点（别的机器上的入站），心跳的运行视图看到
 *     「入站不在这台机器上」就按停用下发 —— 这台成员机不会对外开出这个端口，DDNS 也不会切过来
 *     （见 tlsInboundReadiness.ts）。原因写进面板日志。
 *
 * 只有「对外的那一跳」是这样：端口转发 / 主备组的每个成员、转发链的第一跳（或挂的入口组里的每台）。
 * 转发链后面几跳是公网上的普通监听，跟 SNI 无关。
 */

import { appendPanelLog } from "./_core/panelLogger";
import { isDatabaseTransactionActive } from "./dbRuntime";
import { updateForwardRule } from "./repositories/forwardRuleRepository";
import { getForwardRuleById } from "./repositories/forwardRuleRepository";
import {
  findSniNameOwners,
  getTlsInboundById,
  listTlsInboundsByHost,
  releaseRuleSniNames,
  replaceRuleSniNames,
  type TlsInboundRow,
} from "./repositories/tlsInboundRepository";
import { parseSniNameJson, pickMemberTlsInbound, sniNamesOutsideAllowlist } from "../shared/tlsInbound";

/** 子规则同步时用到的模板那几列（库里的规则行就满足）。 */
export type SniGroupTemplate = { id: unknown; tlsInboundId?: unknown; sniNames?: unknown };

export function isSniGroupTemplate(template: SniGroupTemplate | null | undefined) {
  return Number(template?.tlsInboundId || 0) > 0;
}

export type SniChildPlan = {
  /** 写进子规则的几列。 */
  columns: { tlsInboundId: number; sniNames: string; protocol: "tcp"; entryDomainEnabled: false };
  /** 子规则要在哪个入站上记名字；null = 不记（锚点那台由模板记着，或这台用不了）。 */
  registerOn: TlsInboundRow | null;
  /** 这台用不了的原因；null = 能用。 */
  blockedReason: string | null;
};

/**
 * 算出一台入口机上子规则的 SNI 那几列。不是 SNI 模板回 null（子规则照旧）。
 * excludeRuleIds：模板自己和这台机器上已有的子规则（它们占着的名字不算冲突）。
 */
export async function planSniChild(template: SniGroupTemplate, hostId: number, excludeRuleIds: readonly number[]): Promise<SniChildPlan | null> {
  if (!isSniGroupTemplate(template)) return null;
  const anchorId = Number(template.tlsInboundId);
  const names = parseSniNameJson(template.sniNames);
  const [anchor, inbounds] = await Promise.all([getTlsInboundById(anchorId), listTlsInboundsByHost(Number(hostId))]);
  const member = pickMemberTlsInbound(anchor, Number(hostId), inbounds);
  const blocked = (reason: string): SniChildPlan => ({
    columns: { tlsInboundId: anchorId, sniNames: JSON.stringify(names), protocol: "tcp", entryDomainEnabled: false },
    registerOn: null,
    blockedReason: reason,
  });
  if (!anchor) return blocked("规则挂的共享 TLS 入站已不存在");
  if (!member) return blocked(`这台入口上没有端口 ${anchor.port} 的共享 TLS 入站`);
  const outside = sniNamesOutsideAllowlist(names, member.allowedSni);
  if (outside.length > 0) return blocked(`这台入口的入站白名单不包含：${outside.slice(0, 5).join("、")}`);
  const exclude = new Set([Number(template.id), ...excludeRuleIds.map(Number)]);
  const owners = (await findSniNameOwners(member.id, names)).filter((owner) => !exclude.has(owner.ruleId));
  if (owners.length > 0) return blocked(`这台入口的入站上这些名字已被其他规则占用：${owners.slice(0, 5).map((owner) => owner.name).join("、")}`);
  return {
    columns: { tlsInboundId: member.id, sniNames: JSON.stringify(names), protocol: "tcp", entryDomainEnabled: false },
    // 锚点那台：名字已经记在模板名下（同一个入站上同一个名字只能记一份）。
    registerOn: member.id === anchorId ? null : member,
    blockedReason: null,
  };
}

/**
 * 子规则写进库以后把名字记上（或放掉）。后台同步时并发抢名字撞了唯一索引：这台先不用，子规则改挂
 * 锚点，下一次同步再试。返回最终用的入站 id。
 */
export async function registerSniChildNames(childRuleId: number, template: SniGroupTemplate, plan: SniChildPlan, context: { groupId: number; hostId: number }) {
  if (plan.blockedReason) {
    appendPanelLog("warn", `[SniGroup] group=${context.groupId} template=${Number(template.id)} host=${context.hostId} child=${childRuleId}: ${plan.blockedReason}`);
  }
  if (!plan.registerOn) {
    await releaseRuleSniNames(childRuleId);
    return plan.columns.tlsInboundId;
  }
  const names = parseSniNameJson(template.sniNames);
  // 已经记好了就不动（后台每次同步都会走到这里，删了重记反而给别人留出抢名字的空当）。
  const held = await findSniNameOwners(plan.registerOn.id, names);
  if (held.length === names.length && held.every((owner) => owner.ruleId === Number(childRuleId))) return plan.registerOn.id;
  try {
    await replaceRuleSniNames(childRuleId, plan.registerOn.id, names);
    return plan.registerOn.id;
  } catch (error) {
    // 事务里（建 / 改模板、转发链同步）语句报错后整个事务只能回滚（PostgreSQL），不能再接着写：
    // 原样抛出去，整次保存失败、提示名字被占。
    if (isDatabaseTransactionActive()) throw error;
    appendPanelLog("warn", `[SniGroup] group=${context.groupId} template=${Number(template.id)} host=${context.hostId} child=${childRuleId}: ${error instanceof Error ? error.message : String(error)}`);
    await releaseRuleSniNames(childRuleId);
    await updateForwardRule(Number(childRuleId), { tlsInboundId: Number(template.tlsInboundId) });
    return Number(template.tlsInboundId);
  }
}

/**
 * 同步完一条对外子规则后调用：按子规则此刻挂的入站把名字记上或放掉（规则见 planSniChild）。
 * 不看同步时的中间状态，只看库里的结果 —— 子规则走的是「新建 / 原地换 / 整份重写」哪条路都一样。
 */
export async function syncSniChildNames(childRuleId: number, template: SniGroupTemplate, context: { groupId: number }) {
  if (!isSniGroupTemplate(template) || !(Number(childRuleId) > 0)) return;
  const child = await getForwardRuleById(Number(childRuleId));
  if (!child) return;
  const inboundId = Number(child.tlsInboundId || 0);
  const inbound = inboundId > 0 ? await getTlsInboundById(inboundId) : null;
  const usable = !!inbound && inbound.hostId === Number(child.hostId);
  const plan: SniChildPlan = {
    columns: { tlsInboundId: inboundId, sniNames: String(child.sniNames || "[]"), protocol: "tcp", entryDomainEnabled: false },
    registerOn: usable && inboundId !== Number(template.tlsInboundId) ? inbound : null,
    blockedReason: usable ? null : inbound ? `这台入口上没有端口 ${inbound.port} 的可用共享 TLS 入站（子规则不下发）` : "规则挂的共享 TLS 入站已不存在",
  };
  await registerSniChildNames(Number(childRuleId), template, plan, { groupId: context.groupId, hostId: Number(child.hostId) });
}
