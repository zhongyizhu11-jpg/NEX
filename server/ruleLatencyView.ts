import { isLinkProbeFresh } from "../shared/linkProbePolicy";

/*
  实时数据只有这一份（2.3.559 起，用户：「什么都是实时数据」「能统一就统一成一体」）：

    内存里是「现在」，数据库是「历史」。界面上「现在多少 ms、通不通」一律读这里；数据库（tcping_stats / tunnel_latency_stats）
    按上报闸门节流写历史，给延迟记录和 30 天色块用，面板刚重启、这里还空着时退回读最新一条。

  写进来的：
    规则样本     每条规则自己最新一次端到端（定时探测每次上报都写，不管数据库那边闸门收不收；诊断完成也写，来源记 diagnosis）
    链路样本     每条链路最新一次总延迟（入口到出口，多跳 / 多出口是汇总后的那个数）
    出口段       入口 → 每台出口机（负载均衡每台出口一条分支）、每台出口机 → 规则目标

  延迟口径（2026-11 用户：「转发延迟显示都不统一」）：界面上的每个延迟数都是面板自己探的这几段，和「诊断」同一套。
  入口实时上报（FXP / Agent）里的 exitMs 是建隧道握手的时间（含加密），比 TCPing 大一截，只在面板一段都没测到时标明「Agent 自测」才用。
*/

type Leg = { ms: number; at: number };

/** 链路 → 出口机 → 入口到这台出口机的最新探测 */
const exitLegByTunnel = new Map<number, Map<number, Leg>>();
/** 规则 → 出口机 → 这台出口机到目标的最新探测；primaryHostId 是上报时这条链路的主出口 */
const targetLegByRule = new Map<number, { tunnelId: number; primaryHostId: number; byHost: Map<number, Leg> }>();

/**
 * 规则 → 规则自己最新一次端到端（定时探测或诊断）：多少 ms、超没超时、哪台机器测的。隧道规则是此刻在用的那台出口测的
 * （2.3.555）：卡片据此分清「超时是在用的这台自己测的」（流量真的过不去）和「是切换前那台测的」（刚切走，新的还没测到）。
 */
export type RuleSample = { hostId: number; ms: number | null; isTimeout: boolean; at: number; source: "probe" | "diagnosis" };
const ruleSampleByRule = new Map<number, RuleSample>();
/** 链路 → 最新一次总延迟（入口到出口；多跳 / 多出口是汇总后的那个数） */
export type TunnelSample = { ms: number | null; isTimeout: boolean; at: number; source: "probe" | "diagnosis" };
const tunnelSampleByTunnel = new Map<number, TunnelSample>();

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

function setBounded<K, V extends { at: number }>(map: Map<K, V>, key: K, value: V, max: number) {
  const previous = map.get(key);
  if (previous && previous.at > value.at) return;
  if (!previous && map.size >= max) map.delete(map.keys().next().value as K);
  map.set(key, value);
}

/** 规则最新一次端到端（定时探测每次上报、诊断完成都写；超时传 isTimeout）。 */
export function noteRuleSample(input: { ruleId: unknown; hostId: unknown; ms?: number | null; isTimeout: boolean; at?: number; source?: RuleSample["source"] }) {
  const ruleId = positive(input.ruleId);
  if (!ruleId) return;
  const ms = input.isTimeout ? null : latency(input.ms);
  setBounded(ruleSampleByRule, ruleId, {
    hostId: positive(input.hostId),
    ms,
    isTimeout: input.isTimeout || ms === null,
    at: input.at ?? Date.now(),
    source: input.source ?? "probe",
  }, MAX_RULES);
}

/** 规则最新一次端到端（新鲜的）。 */
export function ruleSample(ruleId: unknown, nowMs = Date.now()): RuleSample | null {
  const sample = ruleSampleByRule.get(positive(ruleId));
  return sample && isLinkProbeFresh(sample.at, nowMs) ? sample : null;
}

/** 链路最新一次总延迟（定时探测汇总后、诊断完成都写；超时传 isTimeout）。 */
export function noteTunnelSample(input: { tunnelId: unknown; ms?: number | null; isTimeout: boolean; at?: number; source?: TunnelSample["source"] }) {
  const tunnelId = positive(input.tunnelId);
  if (!tunnelId) return;
  const ms = input.isTimeout ? null : latency(input.ms);
  setBounded(tunnelSampleByTunnel, tunnelId, {
    ms,
    isTimeout: input.isTimeout || ms === null,
    at: input.at ?? Date.now(),
    source: input.source ?? "probe",
  }, MAX_TUNNELS);
}

/** 链路最新一次总延迟（新鲜的）。 */
export function tunnelSample(tunnelId: unknown, nowMs = Date.now()): TunnelSample | null {
  const sample = tunnelSampleByTunnel.get(positive(tunnelId));
  return sample && isLinkProbeFresh(sample.at, nowMs) ? sample : null;
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
  /** 最近一次更新是什么时候（两段里新的那一段）：诊断弹窗按它判断卡片有没有比上次诊断新的数 */
  at: number;
};

/**
 * 一条链路规则的整链（入口 → 在用出口 → 目标），两段都是面板探的。缺一段返回 null（调用方退回规则的定时探测、再退回诊断）。
 * 出口到目标那一段先用出口机一分钟一次的 TCPing（诊断也是这么测的，2.3.544 起每台出口都探）；没有新鲜的才用负载均衡
 * 快速探测的中位数（targetStateMs，exitTargetStatesForRule）—— 那是一窗口样本的中位数，和诊断的单次 TCPing 不是一个数，
 * 用户面板上 149 对 153.8、3 对 7，卡片和诊断就对不上。
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
  const targetLeg = ruleTargetLatency(input.ruleId, exitHostId, nowMs)
    ?? (stateMs !== null && stateMs > 0 ? { ms: stateMs, at: Number(input.targetStateAt) || nowMs } : null);
  if (!targetLeg) return null;
  return {
    exitHostId,
    totalMs: exitLeg.ms + targetLeg.ms,
    exitMs: exitLeg.ms,
    targetMs: targetLeg.ms,
    at: Math.max(exitLeg.at, targetLeg.at),
  };
}


/**
 * 链路换了拓扑（出口 / 入口 / 中转 / 出口组 / 负载均衡开关，server/tunnelTopologyChange.ts）：这条链路的「入口到出口」
 * 和它上面各条规则的「出口到目标」都是旧路线测的，整段忘掉，等新路线的探测报上来再画（卡片这段时间退回定时探测 / 诊断）。
 */
export function forgetTunnelLatencyView(tunnelId: unknown, ruleIds: readonly unknown[] = []) {
  const tid = positive(tunnelId);
  if (tid) {
    exitLegByTunnel.delete(tid);
    tunnelSampleByTunnel.delete(tid);
  }
  for (const ruleId of ruleIds) {
    const rid = positive(ruleId);
    if (rid) {
      targetLegByRule.delete(rid);
      ruleSampleByRule.delete(rid);
    }
  }
  if (tid) {
    for (const [rid, entry] of targetLegByRule) {
      if (entry.tunnelId !== tid) continue;
      targetLegByRule.delete(rid);
      ruleSampleByRule.delete(rid);
    }
  }
}

/** 只给测试用 */
export function resetRuleLatencyViewForTest() {
  exitLegByTunnel.clear();
  targetLegByRule.clear();
  ruleSampleByRule.clear();
  tunnelSampleByTunnel.clear();
}

/**
 * 卡片 / 表格 / 订阅读的那份规则汇总（数据库最新一条，缓存 5 秒）补上内存里更新的实时样本（2.3.559）：
 * 数据库那条按闸门 5 分钟才写一次，内存里每次上报、每次诊断都写。比数据库那条新才盖；转发组父规则的延迟是拼出来的，不盖。
 */
export function withRuleLiveSamples<T extends { ruleId: number | string; latestLatencyAt?: unknown; latencyComposed?: unknown }>(rows: T[], nowMs = Date.now()): T[] {
  return rows.map((row) => {
    if (row.latencyComposed === true || !("latestLatencyMs" in row)) return row;
    const sample = ruleSample(row.ruleId, nowMs);
    if (!sample) return row;
    const dbAt = row.latestLatencyAt ? new Date(row.latestLatencyAt as string | number | Date).getTime() : 0;
    if (Number.isFinite(dbAt) && dbAt >= sample.at) return row;
    return {
      ...row,
      latestLatencyMs: sample.isTimeout ? null : sample.ms,
      latestLatencyIsTimeout: sample.isTimeout,
      latestLatencyAt: new Date(sample.at),
      latestLatencySource: sample.source,
    };
  });
}
