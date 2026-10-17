import { z } from "zod";
import * as db from "../db";
import { isAgentVersionAtLeast } from "../agentRouteUtils";
import { RULE_TRAFFIC_MODES, type RuleTrafficMode } from "../../shared/ruleLimits";

/**
 * 单条规则限额的入参（创建 / 编辑共用）。只有管理员能传；校验和落库都在这里，
 * 三条创建路（直连、转发组、共享 TLS 入站）和编辑都调同一套。
 */
export const RULE_RATE_LIMIT_MIN_AGENT_VERSION = "2.2.187";

export const ruleLimitInputShape = {
  /** 限速 Mbps，0 = 不限。 */
  rateLimitMbps: z.number().int().min(0).max(1_000_000).optional(),
  /** 流量额度（字节），0 = 不限。 */
  trafficLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  trafficMode: z.enum(RULE_TRAFFIC_MODES as unknown as [RuleTrafficMode, ...RuleTrafficMode[]]).optional(),
  /** 到期时间，null = 永久。 */
  expiresAt: z.coerce.date().nullable().optional(),
};

export type RuleLimitInput = {
  rateLimitMbps?: number;
  trafficLimit?: number;
  trafficMode?: RuleTrafficMode;
  expiresAt?: Date | null;
};

const RULE_LIMIT_KEYS = Object.keys(ruleLimitInputShape) as Array<keyof RuleLimitInput>;

/** 从入参里摘出限额字段（摘掉之后，创建那条路把入参整个展开进规则行也不会带进去）。 */
export function takeRuleLimitInput(input: Record<string, any>): RuleLimitInput {
  const taken: Record<string, any> = {};
  for (const key of RULE_LIMIT_KEYS) {
    if (input[key] !== undefined) taken[key] = input[key];
    delete input[key];
  }
  return taken as RuleLimitInput;
}

export function hasRuleLimitInput(input: RuleLimitInput) {
  return RULE_LIMIT_KEYS.some((key) => input[key] !== undefined);
}

export function validateRuleLimitInput(role: string, input: RuleLimitInput, existing?: { createdAt?: unknown } | null) {
  if (!hasRuleLimitInput(input)) return;
  if (role !== "admin") throw new Error("只有管理员可以设置单条规则的限速、流量额度和到期时间");
  if (input.expiresAt) {
    const expiresAt = new Date(input.expiresAt).getTime();
    // 新建时不能一建就到期；编辑时允许把到期改到过去（立刻停用），但不能早于创建时间。
    const floor = existing?.createdAt ? new Date(existing.createdAt as any).getTime() : Date.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= floor) {
      throw new Error(existing ? "到期时间必须晚于规则的创建时间" : "到期时间必须晚于现在");
    }
  }
}

/** 要写进规则行的列。adminManaged 一旦为真就一直为真（清空限额也不把规则交还给用户）。 */
export function ruleLimitColumns(input: RuleLimitInput, adminManaged: boolean) {
  const columns: Record<string, unknown> = {};
  if (input.rateLimitMbps !== undefined) columns.rateLimitMbps = input.rateLimitMbps;
  if (input.trafficLimit !== undefined) columns.trafficLimit = input.trafficLimit;
  if (input.trafficMode !== undefined) columns.trafficMode = input.trafficMode;
  if (input.expiresAt !== undefined) columns.expiresAt = input.expiresAt;
  if (adminManaged) columns.adminManaged = true;
  return columns;
}

/**
 * 限速要靠入口机上的限速守卫（gost limiter / 协议守卫），太旧的 Agent 会悄悄忽略：
 * 设限速前先确认每台入口机都撑得住，免得界面写着限速、实际没限。
 */
export async function validateRuleRateLimitTargets(rule: Record<string, any>) {
  if (!(Number(rule.rateLimitMbps) > 0)) return;
  let hostIds: number[] = [];
  if (Number(rule.forwardGroupId || 0) > 0) {
    hostIds = await db.getForwardGroupRuleEntryHostIds(Number(rule.forwardGroupId));
  } else if (Number(rule.tunnelId || 0) > 0 && Number(rule.hostId || 0) > 0) {
    hostIds = await db.forwardRuleListenHostIds(Number(rule.hostId), Number(rule.tunnelId));
  } else if (Number(rule.tunnelId || 0) > 0) {
    const tunnel: any = await db.getTunnelById(Number(rule.tunnelId));
    if (tunnel) hostIds = [Number(tunnel.entryHostId)];
  } else if (Number(rule.hostId || 0) > 0) {
    hostIds = [Number(rule.hostId)];
  }
  for (const id of new Set(hostIds)) {
    const host: any = await db.getHostById(id);
    if (!host) continue;
    if (!isAgentVersionAtLeast(String(host.agentVersion || ""), RULE_RATE_LIMIT_MIN_AGENT_VERSION)) {
      throw new Error(`单条规则限速需要入口机 Agent ${RULE_RATE_LIMIT_MIN_AGENT_VERSION} 或以上（${host.name || `主机 #${id}`} 还是 ${host.agentVersion || "未知版本"}），请先升级 Agent`);
    }
  }
}
