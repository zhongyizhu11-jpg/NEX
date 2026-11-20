import { isLinkProbeFresh } from "../shared/linkProbePolicy";

/*
  延迟口径（2026-11 用户：「转发延迟显示都不统一」）：界面上的每一个延迟数都是面板自己探的那几段，和「诊断」同一套：

    入口 → 出口机    链路的定时探测（Agent 经隧道 TCPing 出口机的监听口；负载均衡时每台出口一条分支 primary / exit-N）
    出口机 → 目标    规则的定时探测（出口机 TCPing 目标）；负载均衡的快速探测（exitTargetStatesForRule 的 medianMs）

  链路卡「到出口」= 第一段；规则卡「整链」= 第一段 + 第二段（在用的那台出口）；弹窗每台出口写两段。
  入口实时上报（FXP / Agent）里的 exitMs 是建隧道握手的时间（含加密），比 TCPing 大一截（用户面板：12.1 vs 6 ms），
  那个数只在面板一段都没测到时、标明「Agent 自测」才用；在用哪台出口照旧按它报的。

  这里只放内存里的最新值（探测上报时写进来），读的地方都不查库：规则卡的汇总、链路列表、链路弹窗共用这一份。
*/

type Leg = { ms: number; at: number };

/** 链路 → 出口机 → 入口到这台出口机的最新探测 */
const exitLegByTunnel = new Map<number, Map<number, Leg>>();
/** 规则 → 出口机 → 这台出口机到目标的最新探测；primaryHostId 是上报时这条链路的主出口 */
const targetLegByRule = new Map<number, { tunnelId: number; primaryHostId: number; byHost: Map<number, Leg> }>();

const MAX_TUNNELS = 20_000;
const MAX_RULES = 50_000;

function positive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function latency(value: unknown) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number >= 0 ? number : null;
}

/** 链路定时探测的一个结果（一台出口一条；超时 / 不通传 null，把旧的清掉）。 */
export function recordTunnelExitLeg(tunnelId: unknown, exitHostId: unknown, ms: number | null | undefined, at = Date.now()) {
  const tid = positive(tunnelId);
  const hid = positive(exitHostId);
  if (!tid || !hid) return;
  const value = latency(ms);
  let byHost = exitLegByTunnel.get(tid);
  if (value === null) {
    byHost?.delete(hid);
    return;
  }
  if (!byHost) {
    if (exitLegByTunnel.size >= MAX_TUNNELS) exitLegByTunnel.delete(exitLegByTunnel.keys().next().value as number);
    byHost = new Map();
    exitLegByTunnel.set(tid, byHost);
  }
  const previous = byHost.get(hid);
  if (previous && previous.at > at) return;
  byHost.set(hid, { ms: value, at });
}

/** 规则定时探测里「出口机到目标」那一段（出口机报的，超时传 null）。 */
export function recordRuleTargetLeg(input: {
  ruleId: unknown;
  tunnelId: unknown;
  exitHostId: unknown;
  primaryHostId?: unknown;
  ms: number | null | undefined;
  at?: number;
}) {
  const ruleId = positive(input.ruleId);
  const hostId = positive(input.exitHostId);
  if (!ruleId || !hostId) return;
  const at = input.at ?? Date.now();
  const value = latency(input.ms);
  let entry = targetLegByRule.get(ruleId);
  if (value === null) {
    entry?.byHost.delete(hostId);
    return;
  }
  if (!entry) {
    if (targetLegByRule.size >= MAX_RULES) targetLegByRule.delete(targetLegByRule.keys().next().value as number);
    entry = { tunnelId: positive(input.tunnelId), primaryHostId: positive(input.primaryHostId), byHost: new Map() };
    targetLegByRule.set(ruleId, entry);
  }
  entry.tunnelId = positive(input.tunnelId) || entry.tunnelId;
  entry.primaryHostId = positive(input.primaryHostId) || entry.primaryHostId;
  const previous = entry.byHost.get(hostId);
  if (previous && previous.at > at) return;
  entry.byHost.set(hostId, { ms: value, at });
}

/** 入口到这台出口机（链路定时探测，新鲜的）。 */
export function tunnelExitLatency(tunnelId: unknown, hostId: unknown, nowMs = Date.now()): Leg | null {
  const leg = exitLegByTunnel.get(positive(tunnelId))?.get(positive(hostId));
  return leg && isLinkProbeFresh(leg.at, nowMs) ? leg : null;
}

/** 这条规则上报时记下的链路和主出口（规则卡要知道「没有实时上报时在用的就是主出口」）。 */
export function ruleTunnelOf(ruleId: unknown): { tunnelId: number; primaryHostId: number } | null {
  const entry = targetLegByRule.get(positive(ruleId));
  return entry ? { tunnelId: entry.tunnelId, primaryHostId: entry.primaryHostId } : null;
}

/** 这台出口机到这条规则的目标（规则定时探测，新鲜的）。 */
export function ruleTargetLatency(ruleId: unknown, hostId: unknown, nowMs = Date.now()): Leg | null {
  const leg = targetLegByRule.get(positive(ruleId))?.byHost.get(positive(hostId));
  return leg && isLinkProbeFresh(leg.at, nowMs) ? leg : null;
}

export type RuleChainLatency = {
  exitHostId: number;
  /** 整链 = exitMs + targetMs */
  totalMs: number;
  exitMs: number;
  targetMs: number;
  /** 两段里旧的那一段是什么时候测的 */
  at: number;
};

/**
 * 一条链路规则的整链（入口 → 在用出口 → 目标），两段都是面板探的。缺一段返回 null（调用方退回规则的定时探测、再退回诊断）。
 * targetStateMs：负载均衡快速探测里这台出口到目标的中位数（exitTargetStatesForRule），有就优先用，它比一分钟一次的普通探测新。
 */
export function ruleChainLatency(input: {
  ruleId: unknown;
  tunnelId: unknown;
  exitHostId: unknown;
  targetStateMs?: number | null;
  targetStateAt?: number | null;
  nowMs?: number;
}): RuleChainLatency | null {
  const nowMs = input.nowMs ?? Date.now();
  const exitHostId = positive(input.exitHostId);
  if (!exitHostId) return null;
  const exitLeg = tunnelExitLatency(input.tunnelId, exitHostId, nowMs);
  if (!exitLeg) return null;
  const stateMs = latency(input.targetStateMs);
  const targetLeg = stateMs !== null && stateMs > 0
    ? { ms: stateMs, at: Number(input.targetStateAt) || nowMs }
    : ruleTargetLatency(input.ruleId, exitHostId, nowMs);
  if (!targetLeg) return null;
  return {
    exitHostId,
    totalMs: exitLeg.ms + targetLeg.ms,
    exitMs: exitLeg.ms,
    targetMs: targetLeg.ms,
    at: Math.min(exitLeg.at, targetLeg.at),
  };
}

export type TunnelExitLatencySummary = {
  exitHostId: number;
  exitName: string;
  exitMs: number;
  lowMs: number;
  highMs: number;
  /** 有探测数的在用出口台数 */
  inUse: number;
  at: number;
};

/**
 * 链路卡「到出口」：在用的几台出口（inUseHostIds，扛流量最多的排第一；空的时候是主出口）各自的探测数，
 * 一台写一个数，几台写区间。一台都没测到返回 null（链路卡退回链路探测的总数）。
 */
export function tunnelInUseExitLatency(input: {
  tunnelId: unknown;
  inUseHostIds: readonly number[];
  hostName?: (hostId: number) => string;
  nowMs?: number;
}): TunnelExitLatencySummary | null {
  const nowMs = input.nowMs ?? Date.now();
  const measured = input.inUseHostIds
    .map((hostId) => ({ hostId: Number(hostId), leg: tunnelExitLatency(input.tunnelId, hostId, nowMs) }))
    .filter((item): item is { hostId: number; leg: Leg } => item.hostId > 0 && !!item.leg);
  if (measured.length === 0) return null;
  const values = measured.map((item) => item.leg.ms);
  const carrying = measured[0];
  return {
    exitHostId: carrying.hostId,
    exitName: input.hostName?.(carrying.hostId) || `主机 ${carrying.hostId}`,
    exitMs: Math.round(carrying.leg.ms),
    lowMs: Math.round(Math.min(...values)),
    highMs: Math.round(Math.max(...values)),
    inUse: measured.length,
    at: Math.min(...measured.map((item) => item.leg.at)),
  };
}

/** 只给测试用 */
export function resetRuleLatencyViewForTest() {
  exitLegByTunnel.clear();
  targetLegByRule.clear();
}
