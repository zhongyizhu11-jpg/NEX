import { normalizeAgentText } from "./agentInputValidation";
import { type RoutePath } from "../shared/routeGroup";

/*
  线路组的「现在怎么样」：两路数据，都只留在内存里。

  · 入口 Agent 随心跳报的评分（failoverStats）：每条路径的健康、评分、延迟、丢包、抖动、
    可用率、连接数，还有它此刻走的是哪条、正在预热哪条。这是调度器**真正**据以决策的
    数字，界面上「当前路径 · 92 优」写的就是它。
  · 中转跳的探测：路径里的每台中转上都有一条面板生成的中继规则（见 routeGroups.ts），
    中转机的 Agent 像探普通规则一样探它的目标（下一跳，或者落地），结果走 /api/agent/tcping
    回来。入口 Agent 只能探到第一跳，第一跳后面断了它看不见 —— 这一路补的就是这个盲区。

  为什么不落库：评分每次心跳都变，写库是纯粹的写放大；面板重启丢掉也没关系，下一次
  心跳（几秒）和下一轮探测（一分钟）就又有了。要留痕的是切换事件，那个在
  forward_rule_route_events 里。
*/

export type RouteTargetStat = {
  index: number;
  target: string;
  healthy: boolean;
  /** 面板下发的「这条路径的中转断了」提示，Agent 原样回显。 */
  down: boolean;
  downReason: string;
  /** 0–100；null = 还没探到足够样本。 */
  score: number | null;
  latencyMs: number | null;
  lossPct: number;
  jitterMs: number;
  availabilityPct: number;
  consecutiveFailures: number;
  connections: number;
  samples: number;
  /** Unix 毫秒；0 = 没探过。 */
  lastProbeAt: number;
  /** 真实连接最近 10 分钟的拨号：成功 / 失败 / 慢（慢的也在成功里）、耗时折半均值（0 = 没拨过）、最近一次（Unix 毫秒）。 */
  dials?: RouteDialStat;
};

export type RouteDialStat = { ok: number; failed: number; slow: number; dialMs: number; lastAt: number };

export type RouteAgentStats = {
  ruleId: number;
  hostId: number;
  sourcePort: number;
  strategy: string;
  activeIndex: number;
  /** Unix 毫秒 */
  activeSince: number;
  prewarmIndex: number;
  targets: RouteTargetStat[];
  /** 面板收到的时刻（Unix 毫秒） */
  reportedAt: number;
};

export type RouteHopProbe = {
  pathKey: string;
  hopIndex: number;
  /** 探测的那台中转 */
  hostId: number;
  hostName: string;
  /** 它探的是谁：下一跳中转的名字，或者「落地」 */
  nextLabel: string;
  ok: boolean;
  latencyMs: number | null;
  /** Unix 毫秒 */
  at: number;
  consecutiveFailures: number;
  /** 它探的下一台机器（落地为 0）：节点熔断按它算。 */
  nextHostId?: number;
  /** 最近几次的结果（新的在后），给「按段成功率」用。 */
  recent?: boolean[];
};

export type RouteHopHint = { down: boolean; reason: string; hopIndex: number };

/** 中转跳连续几次探不通才算这条路径在这一跳断了。探测一分钟一轮，三次就是两三分钟。 */
export const ROUTE_HOP_DOWN_THRESHOLD = 3;
/** 中转多久没报探测结果就不再拿它的旧结论说事：机器掉线时说「中转断了」是对的，但说的该是掉线，不是探测。 */
const ROUTE_HOP_STALE_MS = 15 * 60 * 1000;
const ROUTE_STATS_STALE_MS = 10 * 60 * 1000;
const MAX_TARGETS_PER_RULE = 16;

const agentStatsByRule = new Map<number, RouteAgentStats>();
const hopProbesByRule = new Map<number, Map<string, RouteHopProbe>>();

function integer(value: unknown, fallback = 0) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function finite(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hopKey(pathKey: string, hopIndex: number) {
  return `${pathKey}:${hopIndex}`;
}

/** Agent 报的时刻：秒和毫秒都认（按量级判断），认不出来当成没有。 */
function reportedMillis(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1e12 ? Math.floor(number * 1000) : Math.floor(number);
}

function sanitizeTarget(raw: any, index: number): RouteTargetStat | null {
  if (!raw || typeof raw !== "object") return null;
  const score = integer(raw.score, -1);
  const latency = finite(raw.latencyMs, -1);
  return {
    index: integer(raw.index, index),
    target: normalizeAgentText(raw.target, 256),
    healthy: raw.healthy === true,
    down: raw.down === true,
    downReason: normalizeAgentText(raw.downReason, 200),
    score: score >= 0 ? Math.min(100, score) : null,
    latencyMs: latency >= 0 ? Math.round(latency * 10) / 10 : null,
    lossPct: Math.max(0, Math.min(100, finite(raw.lossPct))),
    jitterMs: Math.max(0, finite(raw.jitterMs)),
    availabilityPct: Math.max(0, Math.min(100, finite(raw.availabilityPct, 100))),
    consecutiveFailures: Math.max(0, integer(raw.consecutiveFailures)),
    connections: Math.max(0, integer(raw.connections)),
    samples: Math.max(0, integer(raw.samples)),
    lastProbeAt: reportedMillis(raw.lastProbeAt),
    dials: {
      ok: Math.max(0, integer(raw.dialOk)),
      failed: Math.max(0, integer(raw.dialFailed)),
      slow: Math.max(0, integer(raw.dialSlow)),
      dialMs: Math.max(0, integer(raw.dialMs)),
      lastAt: reportedMillis(raw.lastDialAt),
    },
  };
}

/**
 * 收入口 Agent 的评分快照。规则归属必须验（isAllowed）：Agent 只能报自己机器上的规则。
 * 一条规则可能有几个监听端口（几个代理）；同一条规则取最近变过线的那份。
 */
export function recordRouteAgentStats(input: {
  hostId: number;
  reports: unknown;
  isAllowed: (ruleId: number) => boolean;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const reports = Array.isArray(input.reports) ? input.reports.slice(0, 1024) : [];
  let recorded = 0;
  const seen = new Map<number, RouteAgentStats>();
  for (const raw of reports as any[]) {
    const ruleId = integer(raw?.ruleId);
    if (ruleId <= 0 || !input.isAllowed(ruleId)) continue;
    const rawTargets = Array.isArray(raw?.targets) ? raw.targets.slice(0, MAX_TARGETS_PER_RULE) : [];
    const targets = rawTargets
      .map((item: unknown, index: number) => sanitizeTarget(item, index))
      .filter((item: RouteTargetStat | null): item is RouteTargetStat => !!item);
    const stats: RouteAgentStats = {
      ruleId,
      hostId: Number(input.hostId),
      sourcePort: Math.max(0, integer(raw?.sourcePort)),
      strategy: normalizeAgentText(raw?.strategy, 24) || "fallback",
      activeIndex: integer(raw?.activeIndex, -1),
      activeSince: reportedMillis(raw?.activeSince),
      prewarmIndex: integer(raw?.prewarmIndex, -1),
      targets,
      reportedAt: nowMs,
    };
    const existing = seen.get(ruleId);
    if (!existing || stats.activeSince >= existing.activeSince) seen.set(ruleId, stats);
  }
  for (const [ruleId, stats] of seen) {
    agentStatsByRule.set(ruleId, stats);
    recorded += 1;
  }
  return recorded;
}

function pathDownState(probes: Map<string, RouteHopProbe> | undefined, pathKey: string, nowMs: number) {
  if (!probes) return null;
  let worst: RouteHopProbe | null = null;
  for (const probe of probes.values()) {
    if (probe.pathKey !== pathKey) continue;
    if (nowMs - probe.at > ROUTE_HOP_STALE_MS) continue;
    if (probe.consecutiveFailures < ROUTE_HOP_DOWN_THRESHOLD) continue;
    if (!worst || probe.hopIndex < worst.hopIndex) worst = probe;
  }
  return worst;
}

/**
 * 收一次中转跳的探测。返回这条路径的「断了没」有没有翻转 —— 翻了调用方要立刻推一次
 * 入口 Agent，让它把这条路径标成不可用（或者恢复），不等下一次整轮心跳。
 */
export function recordRouteHopProbe(input: {
  parentRuleId: number;
  pathKey: string;
  hopIndex: number;
  hostId: number;
  hostName: string;
  nextLabel: string;
  ok: boolean;
  latencyMs: number | null;
  nextHostId?: number | null;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const ruleId = integer(input.parentRuleId);
  const pathKey = String(input.pathKey || "").trim();
  const hopIndex = Math.max(0, integer(input.hopIndex));
  if (ruleId <= 0 || !pathKey) return { downChanged: false, down: false };
  let probes = hopProbesByRule.get(ruleId);
  if (!probes) {
    probes = new Map();
    hopProbesByRule.set(ruleId, probes);
  }
  const before = pathDownState(probes, pathKey, nowMs);
  const key = hopKey(pathKey, hopIndex);
  const previous = probes.get(key);
  const latency = input.ok && typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs) && input.latencyMs >= 0
    ? Math.round(input.latencyMs * 10) / 10
    : null;
  probes.set(key, {
    pathKey,
    hopIndex,
    hostId: Number(input.hostId),
    hostName: String(input.hostName || "").trim() || `主机 ${input.hostId}`,
    nextLabel: String(input.nextLabel || "").trim() || "落地",
    ok: !!input.ok,
    latencyMs: latency,
    at: nowMs,
    consecutiveFailures: input.ok ? 0 : (previous?.consecutiveFailures || 0) + 1,
    nextHostId: Number(input.nextHostId || 0) || 0,
    recent: [...(previous?.recent || []), !!input.ok].slice(-ROUTE_HOP_RECENT),
  });
  const after = pathDownState(probes, pathKey, nowMs);
  const breaker = Number(input.nextHostId || 0) > 0
    ? noteNodeProbe(Number(input.nextHostId), `${ruleId}:${key}`, !!input.ok, (previous?.consecutiveFailures || 0) + (input.ok ? 0 : 1), nowMs)
    : null;
  return { downChanged: !!before !== !!after, down: !!after, breaker };
}

// ---------------------------------------------------------------- 节点熔断

/** 按段成功率看最近多少次探测。 */
const ROUTE_HOP_RECENT = 20;
/** 恢复后要稳定多久才把熔断解除。 */
export const ROUTE_BREAKER_RECOVER_MS = 60_000;
/** 一台机器多久之内有人探通过，就不算「都探不通」。 */
const ROUTE_BREAKER_OK_WINDOW_MS = 120_000;

type NodeBreakerState = { failing: Map<string, number>; lastOkAt: number; trippedAt: number; okSince: number };
const nodeBreakers = new Map<number, NodeBreakerState>();

/**
 * 一次「谁探 nextHost」的结果。任一条线路连续 3 次探不通它、而两分钟内没有任何线路探通过 →
 * 熔断：经过它的所有路径一起标成用不了，不用每条规则各自再探三轮。之后有探通的，稳定一分钟解除。
 * 返回熔断状态翻没翻（翻了调用方要推所有经过它的规则）。
 */
function noteNodeProbe(hostId: number, prober: string, ok: boolean, consecutiveFailures: number, nowMs: number): { hostId: number; tripped: boolean } | null {
  let state = nodeBreakers.get(hostId);
  if (!state) {
    state = { failing: new Map(), lastOkAt: 0, trippedAt: 0, okSince: 0 };
    nodeBreakers.set(hostId, state);
  }
  const wasTripped = state.trippedAt > 0;
  if (ok) {
    state.failing.delete(prober);
    state.lastOkAt = nowMs;
    if (wasTripped) {
      if (!state.okSince) state.okSince = nowMs;
      if (nowMs - state.okSince >= ROUTE_BREAKER_RECOVER_MS) {
        state.trippedAt = 0;
        state.okSince = 0;
        return { hostId, tripped: false };
      }
    }
    return null;
  }
  state.failing.set(prober, consecutiveFailures);
  state.okSince = 0;
  if (!wasTripped && consecutiveFailures >= ROUTE_HOP_DOWN_THRESHOLD && nowMs - state.lastOkAt > ROUTE_BREAKER_OK_WINDOW_MS) {
    state.trippedAt = nowMs;
    return { hostId, tripped: true };
  }
  return null;
}

/** 此刻熔断着的机器。 */
export function routeTrippedNodeIds(): Set<number> {
  const ids = new Set<number>();
  for (const [hostId, state] of nodeBreakers) if (state.trippedAt > 0) ids.add(hostId);
  return ids;
}

export function routeNodeBreakerState(hostId: number) {
  const state = nodeBreakers.get(Number(hostId));
  return state ? { tripped: state.trippedAt > 0, trippedAt: state.trippedAt || null, lastOkAt: state.lastOkAt || null, failingProbers: state.failing.size } : { tripped: false, trippedAt: null, lastOkAt: null, failingProbers: 0 };
}

/**
 * 一条路径「此刻不该走」的面板提示（Agent 认的短语，界面用 describeRouteIssue 翻译）：
 * 暂停 > 维护 > 离线 > 熔断。中转断了的提示在 routeHopDownHints 里。
 */
export function routeNodeHints(
  paths: readonly RoutePath[],
  node: (hostId: number) => { name: string; online: boolean; maintenance: boolean } | null,
  tripped: ReadonlySet<number> = routeTrippedNodeIds(),
) {
  const hints = new Map<string, RouteHopHint>();
  for (const path of paths) {
    if (path.paused) {
      hints.set(path.key, { down: true, hopIndex: 0, reason: "paused" });
      continue;
    }
    let found: RouteHopHint | null = null;
    path.hops.forEach((hostId, hopIndex) => {
      if (found) return;
      const status = node(hostId);
      const name = status?.name || `主机 ${hostId}`;
      if (status?.maintenance) found = { down: true, hopIndex, reason: `maintenance: ${name}` };
      else if (status && !status.online) found = { down: true, hopIndex, reason: `node offline: ${name}` };
      else if (tripped.has(Number(hostId))) found = { down: true, hopIndex, reason: `breaker: ${name}` };
    });
    if (found) hints.set(path.key, found);
  }
  return hints;
}

/** 入口 Agent 探不到的那几段（中继各自探的）加起来：Agent 拿它算整条链的分。 */
export function routePathDownstreamMs(ruleId: number, path: RoutePath, nowMs = Date.now()): number {
  const probes = hopProbesByRule.get(Number(ruleId));
  if (!probes) return 0;
  let total = 0;
  for (const probe of probes.values()) {
    if (probe.pathKey !== path.key || nowMs - probe.at > ROUTE_HOP_STALE_MS) continue;
    if (probe.ok && typeof probe.latencyMs === "number") total += probe.latencyMs;
  }
  return Math.round(total);
}

/** 一段最近的探测成功率（百分比）；没样本为 null。 */
export function routeHopSuccessPct(probe: Pick<RouteHopProbe, "recent">): number | null {
  const recent = probe.recent || [];
  if (recent.length === 0) return null;
  return Math.round((recent.filter(Boolean).length / recent.length) * 1000) / 10;
}

/**
 * 下发给入口 Agent 的「这条路径的中转断了」提示：按路径 key 给。
 *
 * 原因写成 Agent 认的短语（relay down: …），界面和 Telegram 用 describeRouteReason 翻成
 * 中文；Agent 自己不做中文。
 */
export function routeHopDownHints(ruleId: number, paths: readonly RoutePath[], nowMs = Date.now()) {
  const hints = new Map<string, RouteHopHint>();
  const probes = hopProbesByRule.get(Number(ruleId));
  if (!probes) return hints;
  for (const path of paths) {
    if (path.hops.length === 0) continue;
    const worst = pathDownState(probes, path.key, nowMs);
    if (!worst) continue;
    hints.set(path.key, {
      down: true,
      hopIndex: worst.hopIndex,
      reason: `relay down: ${worst.hostName} → ${worst.nextLabel}`,
    });
  }
  return hints;
}

export function getRouteStatus(ruleId: number, nowMs = Date.now()) {
  const agent = agentStatsByRule.get(Number(ruleId)) || null;
  const probes = hopProbesByRule.get(Number(ruleId));
  const hops = probes
    ? Array.from(probes.values())
      .filter((probe) => nowMs - probe.at <= ROUTE_HOP_STALE_MS)
      .sort((left, right) => left.pathKey.localeCompare(right.pathKey) || left.hopIndex - right.hopIndex)
    : [];
  return {
    agent: agent && nowMs - agent.reportedAt <= ROUTE_STATS_STALE_MS ? agent : null,
    /** 过了 10 分钟还没新快照，也把最后那份给出来，只是标成陈旧。 */
    staleAgent: agent && nowMs - agent.reportedAt > ROUTE_STATS_STALE_MS ? agent : null,
    hops,
  };
}

export function forgetRouteStats(ruleId: number) {
  agentStatsByRule.delete(Number(ruleId));
  hopProbesByRule.delete(Number(ruleId));
}

/** 测试用：模拟面板重启。 */
export function resetRouteStatsForTest() {
  agentStatsByRule.clear();
  hopProbesByRule.clear();
  nodeBreakers.clear();
}

/**
 * 一段（from → to）最近测到的延迟：所有线路里「from 探 to」的中继探测取最小。from = 入口机时，
 * 入口 Agent 报的「拨第一跳」也算。展开线路时拿它给候选排序；没测过返回 null。
 */
export function routeSegmentLatencyEstimate(fromHostId: number, toHostId: number, nowMs = Date.now()): number | null {
  let best: number | null = null;
  for (const probes of hopProbesByRule.values()) {
    for (const probe of probes.values()) {
      if (probe.hostId !== fromHostId || Number(probe.nextHostId || 0) !== toHostId) continue;
      if (!probe.ok || typeof probe.latencyMs !== "number" || nowMs - probe.at > ROUTE_HOP_STALE_MS) continue;
      if (best === null || probe.latencyMs < best) best = probe.latencyMs;
    }
  }
  return best;
}

/** 哪些规则的中继在探这台机器（它是那些路径的下一跳）。 */
export function routeRuleIdsProbingHost(hostId: number): number[] {
  const ids: number[] = [];
  for (const [ruleId, probes] of hopProbesByRule) {
    for (const probe of probes.values()) {
      if (Number(probe.nextHostId || 0) === Number(hostId)) {
        ids.push(ruleId);
        break;
      }
    }
  }
  return ids;
}
