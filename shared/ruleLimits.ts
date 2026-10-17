/**
 * 单条规则限额（管理员设置）：限速、流量额度、到期时间，以及「管理员管理的规则」。
 *
 * 判定都在这里，面板的执行（server/ruleLimits.ts）和界面的展示（RuleLimitsForm /
 * RuleLimitSummary）共用同一套算法：界面上显示「已用 / 额度」和服务端停规则用的是同一个数。
 */
export type RuleTrafficMode = "outbound" | "both" | "max";
export type RuleLimitReason = "expired" | "traffic_limit";

export const RULE_TRAFFIC_MODES: readonly RuleTrafficMode[] = ["outbound", "both", "max"];

export const RULE_TRAFFIC_MODE_LABELS: Record<RuleTrafficMode, string> = {
  outbound: "仅出向",
  both: "双向合计",
  max: "取较大的一向",
};

export const RULE_LIMIT_REASON_LABELS: Record<RuleLimitReason, string> = {
  expired: "规则已到期",
  traffic_limit: "规则流量额度已用尽",
};

export function normalizeRuleTrafficMode(value: unknown): RuleTrafficMode {
  return value === "outbound" || value === "max" ? value : "both";
}

export function normalizeRuleLimitReason(value: unknown): RuleLimitReason | null {
  return value === "expired" || value === "traffic_limit" ? value : null;
}

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** 设过任何限额，或管理员替用户建的规则：用户只能看，不能改、停、删。 */
export function isAdminManagedRule(rule: any): boolean {
  return truthy(rule?.adminManaged)
    || Number(rule?.rateLimitMbps) > 0 || Number(rule?.trafficLimit) > 0 || !!rule?.expiresAt;
}

/** 规则上有没有任何一项限额（界面据此决定显示不显示用量摘要）。 */
export function hasRuleLimits(rule: any): boolean {
  return Number(rule?.rateLimitMbps) > 0 || Number(rule?.trafficLimit) > 0 || !!rule?.expiresAt;
}

export const ADMIN_MANAGED_RULE_MESSAGE = "这条规则由管理员管理，仅可查看；需要修改请联系管理员";

export function assertRuleWritable(actor: { id: number; role: string }, rule: any) {
  if (actor.role === "admin") return;
  if (Number(rule?.userId) !== Number(actor.id)) throw new Error("无权操作此规则");
  if (isAdminManagedRule(rule)) throw new Error(ADMIN_MANAGED_RULE_MESSAGE);
}

export function ruleTrafficUsed(mode: unknown, bytesIn: number, bytesOut: number): number {
  const inbound = Math.max(0, Number(bytesIn) || 0);
  const outbound = Math.max(0, Number(bytesOut) || 0);
  const normalized = normalizeRuleTrafficMode(mode);
  if (normalized === "outbound") return outbound;
  if (normalized === "max") return Math.max(inbound, outbound);
  return inbound + outbound;
}

/**
 * 这条规则现在该不该停、为什么停。到期优先于额度；创建时间只是记录，不是生效时间。
 */
export function ruleLimitReason(
  rule: { expiresAt?: unknown; trafficLimit?: unknown; trafficMode?: unknown },
  traffic: { bytesIn: number; bytesOut: number } = { bytesIn: 0, bytesOut: 0 },
  now = Date.now(),
): RuleLimitReason | null {
  if (rule.expiresAt) {
    const expiresAt = new Date(rule.expiresAt as any).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= now) return "expired";
  }
  const limit = Number(rule.trafficLimit || 0);
  return limit > 0 && ruleTrafficUsed(rule.trafficMode, traffic.bytesIn, traffic.bytesOut) >= limit ? "traffic_limit" : null;
}
