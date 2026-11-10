/**
 * 端口段规则保存前的那一道闸（规则本身的定义和纯校验在 shared/portRange.ts）。
 *
 * 建规则、改规则、重新启用、批量添加都走这里：段要**整体**参与端口策略、套餐端口段、
 * 共享主机系统端口保护、进程内预留和占用检查 —— 段里任何一个端口不行，整条都不建。
 * 单端口规则不经过这里，原来那套逐端口的检查一点没动。
 */
import * as db from "./db";
import {
  PORT_RANGE_MIN_AGENT_VERSION,
  formatPortSpan,
  normalizeSourcePortEnd,
  portRangeShapeError,
  portRangeUnsupportedReason,
  type PortRangeRuleContext,
} from "@shared/portRange";
import { describePortPolicy, isPortAllowedByPolicy, type PortPolicy } from "@shared/portPolicy";
import { isAgentVersionAtLeast } from "@shared/version";
import { assertTenantListenPortAllowed } from "./tenantListenPortGuard";
import { tryReserveHostPortRange, type HostPortReservation } from "./portReservations";

type PortRangeActor = { id: number; role?: string | null };
type PortRangeHost = { id?: unknown; userId?: unknown; agentVersion?: unknown; rateLimitMbps?: unknown; name?: unknown } | null | undefined;
type PlanPortRange = { ranges: Array<{ start: number; end: number }> } | null | undefined;

/** 老 Agent 上不下发端口段：它的就绪检查和计数修复只认单端口（见 PORT_RANGE_MIN_AGENT_VERSION）。 */
export function portRangeAgentUnsupportedReason(host: PortRangeHost): string | null {
  const version = String(host?.agentVersion || "").trim();
  if (isAgentVersionAtLeast(version, PORT_RANGE_MIN_AGENT_VERSION)) return null;
  return `端口段需要 Agent ${PORT_RANGE_MIN_AGENT_VERSION} 或更新（这台是 ${version || "未上报版本"}），请先升级 Agent`;
}

/**
 * 这条规则会不会被限速。内核转发一旦要限速，心跳就把它换成用户态守卫（一个端口一个进程），
 * 端口段做不到 —— 所以保存时先拦，心跳那头再兜一次（限速是之后才加上的情况）。
 */
export async function portRangeRuleRateLimited(host: PortRangeHost, ownerUserId: number, ruleRateLimitMbps: unknown) {
  if (Number(ruleRateLimitMbps || 0) > 0) return true;
  if (Number(host?.rateLimitMbps || 0) > 0) return true;
  const owner = await db.getUserById(Number(ownerUserId)) as { gostRateLimitIn?: unknown; gostRateLimitOut?: unknown } | undefined;
  return Number(owner?.gostRateLimitIn || 0) > 0 || Number(owner?.gostRateLimitOut || 0) > 0;
}

/** 段里第一个不在策略里的端口；都在就 null。 */
export function firstPortOutsidePolicy(start: number, end: number, policy: PortPolicy): number | null {
  for (let port = start; port <= end; port += 1) {
    if (!isPortAllowedByPolicy(port, policy)) return port;
  }
  return null;
}

export type PortRangeSaveInput = PortRangeRuleContext & {
  sourcePort: number;
  sourcePortEnd: number;
  targetPort: number;
  targetPortEnd?: number | null;
  protocol?: unknown;
  rateLimitMbps?: unknown;
};

/**
 * 不查库的那部分：形状、能不能用端口段。批量预览逐行先过这一步。
 */
export function portRangeStaticError(rule: PortRangeSaveInput): string | null {
  return portRangeShapeError(rule) || portRangeUnsupportedReason(rule);
}

/**
 * 校验一条端口段规则并占住整段；成功返回预留（调用方负责 release），任何一步不过就抛出说人话的错。
 *
 * excludeRuleIds：改规则时把它自己排除掉。entryPolicy 是主机自己的端口范围 / 允许名单，
 * planRange 是非管理员的套餐端口段（管理员传 null）。
 */
export async function reserveRulePortRange(options: {
  actor: PortRangeActor;
  ownerUserId: number;
  host: PortRangeHost;
  rule: PortRangeSaveInput;
  entryPolicy: PortPolicy;
  planRange: PlanPortRange;
  excludeRuleIds?: number[];
}): Promise<HostPortReservation> {
  const { rule, host } = options;
  const hostId = Number(host?.id || 0);
  if (!hostId) throw new Error("主机不存在");
  const start = Number(rule.sourcePort);
  const end = Number(rule.sourcePortEnd);
  const span = formatPortSpan(start, end);
  const rateLimited = await portRangeRuleRateLimited(host, options.ownerUserId, rule.rateLimitMbps);
  const staticError = portRangeStaticError({ ...rule, rateLimited });
  if (staticError) throw new Error(staticError);
  const agentReason = portRangeAgentUnsupportedReason(host);
  if (agentReason) throw new Error(agentReason);
  const outsideEntry = firstPortOutsidePolicy(start, end, options.entryPolicy);
  if (outsideEntry !== null) {
    throw new Error(`端口段 ${span} 里的 ${outsideEntry} 不在这台主机允许的范围内：${describePortPolicy(options.entryPolicy)}`);
  }
  if (options.planRange) {
    const outsidePlan = Array.from({ length: end - start + 1 }, (_, index) => start + index)
      .find((port) => !db.isPortAllowedByUserPlanRange(port, options.planRange));
    if (outsidePlan !== undefined) {
      const ranges = options.planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
      throw new Error(`套餐端口必须在 ${ranges} 区间内（端口段 ${span} 里的 ${outsidePlan} 不在）`);
    }
  }
  for (let port = start; port <= end; port += 1) {
    assertTenantListenPortAllowed({ actor: options.actor, host: host as { userId?: number | null }, port, label: `端口段 ${span} 里的端口` });
  }
  const reservation = tryReserveHostPortRange(hostId, start, end, rule.protocol);
  if (!reservation) throw new Error(`端口段 ${span} 里有端口正在被其他请求分配，请稍后重试`);
  try {
    const used = await db.findUsedPortInRangeOnHost(hostId, start, end, options.excludeRuleIds || [], rule.protocol);
    if (used !== null) throw new Error(`端口 ${used} 已被占用（在端口段 ${span} 里），请换一段`);
  } catch (error) {
    reservation.release();
    throw error;
  }
  return reservation;
}

/**
 * 从入参 + 已存的规则算出保存后的 sourcePortEnd。
 *
 * 入参没给 sourcePortEnd 就沿用库里的（只改名字、目标的老调用方不必知道这一列）；给了 null / 0
 * 就是改回单端口。起点 0（随机分配）配一个结尾是说不通的，直接报错而不是悄悄当成单端口。
 */
export function resolveNextSourcePortEnd(input: { sourcePort?: unknown; sourcePortEnd?: unknown }, stored?: { sourcePort?: unknown; sourcePortEnd?: unknown } | null) {
  const nextStart = Number(input.sourcePort ?? stored?.sourcePort ?? 0);
  const rawEnd = input.sourcePortEnd !== undefined ? input.sourcePortEnd : stored?.sourcePortEnd;
  if (Number(rawEnd || 0) > 0 && nextStart <= 0) throw new Error("端口段不能随机分配，请写出起止端口");
  if (Number(rawEnd || 0) > 0 && Number(rawEnd) < nextStart) throw new Error("端口段要从小写到大，比如 20000-20100");
  return normalizeSourcePortEnd(nextStart, rawEnd);
}
