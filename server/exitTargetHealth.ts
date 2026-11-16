import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh } from "./agentEvents";
import { getForwardRulesByIds } from "./repositories/forwardRuleRepository";
import { getForwardGroupById } from "./repositories/forwardGroupRepository";
import { getHostNamesByIds } from "./repositories/hostRepository";
import { getTunnelExitNodesByTunnelIds, getTunnelsByIds } from "./repositories/tunnelRepository";
import { normalizeExitGroupStrategy } from "../shared/exitStrategy";
import { DEFAULT_BALANCE_DETECT, normalizeBalanceDetect, type BalanceDetect } from "../shared/loadBalance";

/*
  负载均衡链路：每台出口「连得上规则的目标吗」（2026-11，用户：「规则都这样了，链路负载均衡还是没切机器」）。

  以前规则的端到端探测只从主出口测、只用来显示红点。三台出口里一台到落地丢包，负载均衡照样往它那儿分。

  现在面板给负载均衡链路上的每台出口都下发一条快速探测（线路组「下一跳」那条通道，Agent 2.2.258 起会探，
  2.2.259 起多报中位数 / 抖动 / 丢包，见 agent/route_hop_probe.go），按链路的「检测与切换」节奏探规则的目标，
  翻转立刻报。面板在这里记下来：

    · 规则卡、链路卡的弹窗上写清楚是哪台出口连不上、抖、丢包；
    · GOST 隧道没法在一条连接里换出口：连不上目标的出口从这条规则的出口列表里摘掉（热更新，不断连接），
      恢复后加回；全都连不上时不摘（那是目标的问题，摘光等于断服）。
    · NEX 隧道（FXP 2.2.142 起）入口自己会当场换出口，这里只用来显示。

  只记在内存里：面板重启后 Agent 下一次全量（30 秒内）就补上。90 秒没报算过期，当不知道。
*/

export const EXIT_TARGET_STALE_MS = 90_000;
const UNSTABLE_LOSS_PCT = 10;

export type ExitTargetReport = {
  ruleId: number;
  down: boolean;
  latencyMs?: number | null;
  medianMs?: number | null;
  jitterMs?: number | null;
  lossPct?: number | null;
  samples?: number | null;
};

export type ExitTargetState = {
  ruleId: number;
  tunnelId: number;
  hostId: number;
  hostName: string;
  down: boolean;
  latencyMs: number | null;
  medianMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  samples: number;
  at: number;
  changedAt: number;
  /** 按链路的「检测与切换」算出来的：抖动 / 丢包超过门槛 */
  unstable: boolean;
  /** GOST 隧道（不能少分，只能摘掉连不上的） */
  gost: boolean;
};

const states = new Map<string, ExitTargetState>();

function stateKey(ruleId: number, hostId: number) {
  return `${ruleId}:${hostId}`;
}

function finiteOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 只给测试用 */
export function resetExitTargetStates() {
  states.clear();
  latencyLeaderByRule.clear();
}

/** 只给测试用：直接放一条状态（不走数据库校验） */
export function setExitTargetStateForTest(state: ExitTargetState) {
  states.set(stateKey(state.ruleId, state.hostId), state);
}

type TunnelRow = {
  id: number;
  mode?: string | null;
  balancePinHostId?: number | null;
  entryHostId?: number | null;
  entryGroupId?: number | null;
  exitHostId?: number | null;
  loadBalanceEnabled?: unknown;
  loadBalanceStrategy?: string | null;
  balanceDetect?: string | null;
};

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** 这条链路是不是「几台出口一起分」的负载均衡。 */
export function tunnelBalancesExits(tunnel: TunnelRow | null | undefined) {
  return !!tunnel && truthy(tunnel.loadBalanceEnabled) && normalizeExitGroupStrategy(tunnel.loadBalanceStrategy) !== "none";
}

/** 链路的检测参数（没设 = 默认值）。 */
export function tunnelBalanceDetect(tunnel: TunnelRow | null | undefined): BalanceDetect {
  return normalizeBalanceDetect(tunnel?.balanceDetect ?? null, DEFAULT_BALANCE_DETECT);
}

/** 给 Agent 的快速探测规格（和线路组「下一跳」同一种）。 */
export function exitTargetProbeSpec(detect: BalanceDetect) {
  return {
    intervalMs: Math.max(1000, detect.intervalSeconds * 1000),
    timeoutMs: Math.min(5000, Math.max(1500, detect.intervalSeconds * 1000)),
    failThreshold: detect.failThreshold,
    recoverOks: detect.recoverThreshold,
  };
}

export function exitTargetUnstable(state: Pick<ExitTargetState, "jitterMs" | "lossPct" | "samples">, detect: BalanceDetect) {
  if (detect.jitterAction === "ignore") return false;
  if ((state.samples || 0) < 5) return false;
  return (state.jitterMs ?? 0) > detect.jitterMs || (state.lossPct ?? 0) >= UNSTABLE_LOSS_PCT;
}

/**
 * 收一台机器报上来的快速探测：只认「这条规则走负载均衡链路、这台机器是它的出口之一」的。
 * 其余的（线路组下一跳那些）原样留给 routeGroups.ingestRouteHopFastReports。
 */
export async function ingestExitTargetReports(input: {
  hostId: number;
  hostName: string;
  results: readonly ExitTargetReport[];
  nowMs?: number;
}) {
  const hostId = Number(input.hostId);
  const nowMs = input.nowMs ?? Date.now();
  const reports = (input.results || []).filter((report) => Number(report.ruleId) > 0).slice(0, 2048);
  if (reports.length === 0 || hostId <= 0) return { recorded: 0, flipped: [] as number[] };
  const rules = await getForwardRulesByIds(Array.from(new Set(reports.map((report) => Number(report.ruleId))))) as Array<{ id: number; tunnelId?: number | null; pendingDelete?: unknown; routeParentRuleId?: number | null }>;
  const ruleById = new Map(rules.map((rule) => [Number(rule.id), rule]));
  const tunnelIds = Array.from(new Set(rules.map((rule) => Number(rule.tunnelId || 0)).filter((id) => id > 0)));
  if (tunnelIds.length === 0) return { recorded: 0, flipped: [] as number[] };
  const [tunnels, exitNodes] = await Promise.all([
    getTunnelsByIds(tunnelIds) as Promise<TunnelRow[]>,
    getTunnelExitNodesByTunnelIds(tunnelIds) as Promise<Array<{ tunnelId: number; hostId: number }>>,
  ]);
  const tunnelById = new Map(tunnels.map((tunnel) => [Number(tunnel.id), tunnel]));
  const exitHostsByTunnel = new Map<number, Set<number>>();
  for (const tunnel of tunnels) exitHostsByTunnel.set(Number(tunnel.id), new Set([Number(tunnel.exitHostId || 0)]));
  for (const node of exitNodes) exitHostsByTunnel.get(Number(node.tunnelId))?.add(Number(node.hostId));
  let hostName = String(input.hostName || "").trim();
  if (!hostName) hostName = (await getHostNamesByIds([hostId])).get(hostId) || `主机 ${hostId}`;
  let recorded = 0;
  const flipped: number[] = [];
  const refreshHosts = new Set<number>();
  for (const report of reports) {
    const rule = ruleById.get(Number(report.ruleId));
    if (!rule || truthy(rule.pendingDelete) || Number(rule.routeParentRuleId || 0) > 0) continue;
    const tunnel = tunnelById.get(Number(rule.tunnelId || 0));
    if (!tunnel || !tunnelBalancesExits(tunnel) || !exitHostsByTunnel.get(Number(tunnel.id))?.has(hostId)) continue;
    const key = stateKey(Number(rule.id), hostId);
    const previous = states.get(key);
    const detect = tunnelBalanceDetect(tunnel);
    const next: ExitTargetState = {
      ruleId: Number(rule.id),
      tunnelId: Number(tunnel.id),
      hostId,
      hostName,
      down: !!report.down,
      latencyMs: finiteOrNull(report.latencyMs),
      medianMs: finiteOrNull(report.medianMs),
      jitterMs: finiteOrNull(report.jitterMs),
      lossPct: finiteOrNull(report.lossPct),
      samples: Math.max(0, Math.round(Number(report.samples) || 0)),
      at: nowMs,
      changedAt: previous?.changedAt ?? nowMs,
      unstable: false,
      gost: String(tunnel.mode || "").toLowerCase() !== "forwardx",
    };
    next.unstable = exitTargetUnstable(next, detect);
    const wasBad = !!previous && (previous.down || exitTargetUnstable(previous, detect));
    const isBad = next.down || exitTargetUnstable(next, detect);
    if (!previous || previous.down !== next.down || wasBad !== isBad) next.changedAt = nowMs;
    states.set(key, next);
    recorded += 1;
    const isGost = String(tunnel.mode || "").toLowerCase() !== "forwardx";
    // GOST「延迟优先」：最快的那台换了（过了滞后门槛），入口要重新拿配置才会按新顺序走
    let leaderChanged = false;
    if (isGost && normalizeExitGroupStrategy(tunnel.loadBalanceStrategy) === "latency") {
      const exitIds = Array.from(exitHostsByTunnel.get(Number(tunnel.id)) || []);
      const leader = latencyLeaderByRule.get(Number(rule.id));
      const nextLeader = exitIds.length > 1 ? latencyOrderedExitHostIds(Number(rule.id), exitIds, detect, { nowMs, remember: false })[0] : undefined;
      leaderChanged = leader != null && nextLeader != null && nextLeader !== leader;
      if (leaderChanged) appendPanelLog("info", `[LoadBalance] rule=${rule.id} 延迟优先换到出口 ${nextLeader}（tunnel=${tunnel.id}）`);
    }
    if ((previous && previous.down !== next.down) || leaderChanged) {
      if (previous && previous.down !== next.down) {
        flipped.push(Number(rule.id));
        appendPanelLog(next.down ? "warn" : "info", `[LoadBalance] rule=${rule.id} 出口 ${hostName} ${next.down ? "连不上目标" : "到目标恢复"}（tunnel=${tunnel.id}）`);
      }
      // GOST 隧道要入口重新拿配置才会摘掉 / 加回这台出口；NEX 隧道入口自己会换，不用推。
      if (isGost) {
        if (Number(tunnel.entryHostId || 0) > 0) refreshHosts.add(Number(tunnel.entryHostId));
        // 入口是入口组：组里每台都替这条链路监听，都要推
        if (Number(tunnel.entryGroupId || 0) > 0) {
          const group = await getForwardGroupById(Number(tunnel.entryGroupId)).catch(() => null) as { members?: Array<{ hostId?: number | null }> } | null;
          for (const member of group?.members || []) if (Number(member?.hostId || 0) > 0) refreshHosts.add(Number(member.hostId));
        }
      }
    }
  }
  for (const entryHostId of refreshHosts) pushAgentRefresh(entryHostId, "exit-target-flip", { urgent: true });
  return { recorded, flipped };
}

/**
 * 一条链路每台出口到目标的情况（链路卡上点「负载均衡 ×N」的弹窗用）：每台出口取它在各条规则上最差的那次，
 * 再数一数几条规则连不上 / 不稳。
 */
export type ExitTargetExitSummary = {
  hostId: number;
  /** 有数据的规则条数 */
  rules: number;
  /** 只有这台连不上的规则条数（每台都连不上的算目标的问题，不记在这里） */
  down: number;
  /** 只有这台不稳的规则条数 */
  unstable: number;
  /** 各条规则到目标延迟的中位数（不取最差：目标远的那条规则每台都慢，不是出口的问题） */
  medianMs: number | null;
  /** 各条规则到目标延迟的最小 / 最大（规则的目标远近不同，弹窗写成 10–212ms） */
  minMs: number | null;
  maxMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  /** 按现在的分配方式会分到流量的规则条数（NEX 隧道是面板按同一套规则估的，GOST 是真实的节点顺序） */
  activeRules: number;
};

export type ExitTargetTunnelSummary = {
  exits: ExitTargetExitSummary[];
  /** 每台出口都连不上 / 都不稳的规则：问题在目标那边 */
  targetIssues: Array<{ ruleId: number; kind: "down" | "unstable" }>;
  /** 一句话：现在怎么走 */
  how: string | null;
};

const middle = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** 打分：到目标延迟 + 抖动（和 FXP 的「延迟优先」一样）；没数据返回 null。 */
function exitTargetScore(state: ExitTargetState | undefined) {
  if (!state || state.down) return null;
  const median = state.medianMs ?? state.latencyMs;
  return median == null ? null : median + (state.jitterMs ?? 0);
}

/*
  GOST「延迟优先」：GOST 只会按顺序用（fifo，前面的连不上换下一台），面板按每台出口到这条规则目标的
  延迟 + 抖动排好顺序给它。带一点滞后：新的最快那台要比现在排第一的快过「延迟差多少才换」（默认 50ms）
  才换到前面 —— 不然两台差不多快时每次探测都在换顺序，GOST 跟着热更新。
*/
const latencyLeaderByRule = new Map<number, number>();

export function latencyOrderedExitHostIds(
  ruleId: number,
  hostIds: readonly number[],
  detect: BalanceDetect,
  options: { nowMs?: number; remember?: boolean } = {},
): number[] {
  const fresh = new Map(exitTargetStatesForRule(ruleId, options.nowMs).map((state) => [state.hostId, state]));
  const penalized = (hostId: number) => detect.jitterAction !== "ignore" && fresh.get(hostId)?.unstable === true;
  const scored = hostIds.map((hostId, index) => ({ hostId, index, score: exitTargetScore(fresh.get(hostId)), bad: penalized(hostId) }));
  const rank = (item: (typeof scored)[number]) => [item.score == null ? 2 : item.bad ? 1 : 0, item.score ?? 0, item.index];
  const ordered = [...scored].sort((left, right) => {
    const a = rank(left);
    const b = rank(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  const leader = latencyLeaderByRule.get(Number(ruleId));
  const current = leader != null ? ordered.find((item) => item.hostId === leader) : undefined;
  const best = ordered[0];
  if (current && best && current !== best && current.score != null && best.score != null && !current.bad
    && best.score > current.score - detect.latencyMarginMs) {
    ordered.splice(ordered.indexOf(current), 1);
    ordered.unshift(current);
  }
  if (options.remember !== false && ordered[0]?.score != null) latencyLeaderByRule.set(Number(ruleId), ordered[0].hostId);
  return ordered.map((item) => item.hostId);
}

/**
 * 一条规则按现在的分配方式会走哪几台（链路弹窗「怎么走」用）。
 * NEX 隧道：入口的 FXP 自己挑，面板拿不到它每次挑了谁，这里按同一套规则估（不含入口到出口那一段）。
 * GOST：主备 / 延迟优先是真实的节点顺序；其余是随机 / 轮流，摘掉连不上的。
 */
function activeExitsForRule(input: {
  strategy: string;
  gost: boolean;
  ordered: readonly number[];
  fresh: Map<number, ExitTargetState>;
  detect: BalanceDetect;
  allDown: boolean;
  pinHostId: number;
  ruleId: number;
}): number[] {
  const { strategy, gost, ordered, fresh, detect } = input;
  if (input.pinHostId > 0 && ordered.includes(input.pinHostId)) return [input.pinHostId];
  const usable = input.allDown ? [...ordered] : ordered.filter((hostId) => fresh.get(hostId)?.down !== true);
  if (usable.length === 0) return [];
  const dropUnstable = (list: number[]) => {
    if (gost || detect.jitterAction !== "switch") return list;
    const stable = list.filter((hostId) => fresh.get(hostId)?.unstable !== true);
    return stable.length > 0 ? stable : list;
  };
  if (strategy === "fallback") return [usable[0]];
  if (strategy === "latency") {
    if (gost) return [latencyOrderedExitHostIds(input.ruleId, usable, detect, { remember: false })[0]];
    const candidates = dropUnstable(usable);
    const scores = candidates.map((hostId) => exitTargetScore(fresh.get(hostId)));
    const known = scores.filter((score): score is number => score != null);
    if (known.length === 0) return candidates;
    const best = Math.min(...known);
    return candidates.filter((_, index) => scores[index] != null && (scores[index] as number) - best <= detect.latencyMarginMs);
  }
  return gost ? usable : dropUnstable(usable);
}

function describeHow(input: { strategy: string; gost: boolean; pinned: boolean; active: number[]; total: number; names: (ids: number[]) => string; marginMs: number }) {
  const { strategy, gost, active, names } = input;
  if (active.length === 0) return null;
  if (input.pinned) return `手动指定：只走 ${names(active)}`;
  const rest = input.total - active.length;
  const restText = rest > 0 ? `，${rest} 台备用` : "";
  switch (strategy) {
    case "fallback":
      return `主备：走 ${names(active)}${restText}`;
    case "latency":
      if (gost) return `延迟优先：走 ${names(active)}（到目标最快），连不上自动换下一台`;
      return active.length === 1
        ? `延迟优先：走 ${names(active)}（到目标最快）${restText}`
        : `延迟优先：${names(active)}（差不到 ${input.marginMs}ms，按负载分）${restText}`;
    case "auto":
      return gost ? `自动：在 ${names(active)} 之间随机分${restText}` : `自动：分给 ${names(active)}，按延迟、抖动和负载挑${restText}`;
    case "least_load":
      return gost ? `按负载：在 ${names(active)} 之间随机分${restText}` : `按负载：分给 ${names(active)}，谁闲给谁${restText}`;
    case "weighted":
      return `按权重：分给 ${names(active)}${restText}`;
    case "round_robin":
      return `轮流：${names(active)} 一台一个连接${restText}`;
    case "random":
      return `随机：在 ${names(active)} 之间随机分${restText}`;
    case "ip_hash":
      return `按访客固定：同一个访客一直走同一台（${names(active)}）${restText}`;
    default:
      return `分给 ${names(active)}${restText}`;
  }
}

/**
 * 链路弹窗：每台出口到目标的情况 + 现在怎么走。
 * 每台出口都连不上（或都不稳）的规则单独列出来，不算到哪台出口头上 —— 那是目标的问题；延迟取各条规则的中位数，
 * 不取最差（以前一条规则的目标在国外，三台出口都显示 200ms、全标「不稳定」）。
 */
export function exitTargetSummaryForTunnel(
  tunnel: TunnelRow | null | undefined,
  orderedExitHostIds: readonly number[],
  options: { nowMs?: number; pinOnline?: boolean; hostNames?: Map<number, string> } = {},
): ExitTargetTunnelSummary {
  const nowMs = options.nowMs ?? Date.now();
  const tunnelId = Number(tunnel?.id || 0);
  const exitIds = orderedExitHostIds.map(Number).filter((id) => id > 0);
  const detect = tunnelBalanceDetect(tunnel);
  const strategy = normalizeExitGroupStrategy(tunnel?.loadBalanceStrategy);
  const gost = String(tunnel?.mode || "").toLowerCase() !== "forwardx";
  const pinHostId = options.pinOnline === false ? 0 : Number(tunnel?.balancePinHostId || 0);
  const byRule = new Map<number, Map<number, ExitTargetState>>();
  for (const state of states.values()) {
    if (state.tunnelId !== tunnelId || nowMs - state.at > EXIT_TARGET_STALE_MS || !exitIds.includes(state.hostId)) continue;
    const map = byRule.get(state.ruleId) || new Map<number, ExitTargetState>();
    map.set(state.hostId, state);
    byRule.set(state.ruleId, map);
  }
  const perExit = new Map(exitIds.map((hostId) => [hostId, { rules: 0, down: 0, unstable: 0, medians: [] as number[], jitters: [] as number[], losses: [] as number[], activeRules: 0 }]));
  const targetIssues: ExitTargetTunnelSummary["targetIssues"] = [];
  const hows = new Map<string, number>();
  const names = (ids: number[]) => ids.map((id) => options.hostNames?.get(id) || `主机 ${id}`).join("、");
  for (const [ruleId, fresh] of byRule) {
    const reporting = Array.from(fresh.values());
    const allDown = reporting.length >= 2 && reporting.length === exitIds.length && reporting.every((state) => state.down);
    const allUnstable = !allDown && reporting.length >= 2 && reporting.length === exitIds.length && reporting.every((state) => state.down || state.unstable);
    if (allDown) targetIssues.push({ ruleId, kind: "down" });
    else if (allUnstable) targetIssues.push({ ruleId, kind: "unstable" });
    for (const state of reporting) {
      const entry = perExit.get(state.hostId);
      if (!entry) continue;
      entry.rules += 1;
      if (state.down && !allDown) entry.down += 1;
      else if (state.unstable && !allDown && !allUnstable) entry.unstable += 1;
      const median = state.medianMs ?? state.latencyMs;
      if (!state.down && median != null) entry.medians.push(median);
      if (!state.down && state.jitterMs != null) entry.jitters.push(state.jitterMs);
      if (state.lossPct != null) entry.losses.push(state.lossPct);
    }
    // 每台都连不上的规则：入口怎么挑都一样，不算「怎么走」
    if (allDown) continue;
    const active = activeExitsForRule({ strategy, gost, ordered: exitIds, fresh, detect, allDown, pinHostId, ruleId });
    for (const hostId of active) {
      const entry = perExit.get(hostId);
      if (entry) entry.activeRules += 1;
    }
    const how = describeHow({ strategy, gost, pinned: pinHostId > 0 && exitIds.includes(pinHostId), active, total: exitIds.length, names, marginMs: detect.latencyMarginMs });
    if (how) hows.set(how, (hows.get(how) || 0) + 1);
  }
  let how: string | null = null;
  if (hows.size > 0) {
    const sorted = Array.from(hows.entries()).sort((left, right) => right[1] - left[1]);
    const counted = sorted.reduce((sum, [, count]) => sum + count, 0);
    how = sorted[0][0] + (sorted.length > 1 ? `（${counted} 条规则里 ${sorted[0][1]} 条）` : "");
  } else if (exitIds.length > 0) {
    // 还没有探测数据：按配置说
    const active = pinHostId > 0 && exitIds.includes(pinHostId) ? [pinHostId] : strategy === "fallback" ? [exitIds[0]] : [...exitIds];
    how = describeHow({ strategy: strategy === "latency" ? "auto" : strategy, gost, pinned: pinHostId > 0 && exitIds.includes(pinHostId), active, total: exitIds.length, names, marginMs: detect.latencyMarginMs });
    if (strategy === "latency") how = `延迟优先：还在测每台到目标的延迟，测出来之前分给 ${names(active)}`;
  }
  return {
    exits: exitIds.map((hostId) => {
      const entry = perExit.get(hostId)!;
      return {
        hostId,
        rules: entry.rules,
        down: entry.down,
        unstable: entry.unstable,
        medianMs: middle(entry.medians),
        minMs: entry.medians.length > 0 ? Math.min(...entry.medians) : null,
        maxMs: entry.medians.length > 0 ? Math.max(...entry.medians) : null,
        jitterMs: middle(entry.jitters),
        lossPct: middle(entry.losses),
        activeRules: entry.activeRules,
      };
    }),
    targetIssues,
    how,
  };
}

/** 一条规则各台出口到目标的情况（只要新鲜的）。 */
export function exitTargetStatesForRule(ruleId: number, nowMs = Date.now()): ExitTargetState[] {
  const out: ExitTargetState[] = [];
  for (const state of states.values()) {
    if (state.ruleId === Number(ruleId) && nowMs - state.at <= EXIT_TARGET_STALE_MS) out.push(state);
  }
  return out.sort((left, right) => left.hostId - right.hostId);
}

/**
 * GOST 隧道这条规则该摘掉哪几台出口：新鲜的、报「连不上」的。全都连不上（或剩下的没一台确认能通）时
 * 一台都不摘 —— 那是目标本身的问题，摘光等于直接断服。
 */
export function exitTargetExcludedHostIds(ruleId: number, exitHostIds: readonly number[], nowMs = Date.now()): Set<number> {
  const fresh = new Map(exitTargetStatesForRule(ruleId, nowMs).map((state) => [state.hostId, state]));
  const down = exitHostIds.filter((hostId) => fresh.get(Number(hostId))?.down === true);
  if (down.length === 0 || down.length >= exitHostIds.length) return new Set();
  const remainingKnownGood = exitHostIds.some((hostId) => !down.includes(hostId) && fresh.get(Number(hostId))?.down === false);
  return remainingKnownGood ? new Set(down.map(Number)) : new Set();
}

export type RuleExitTargetSummary = {
  total: number;
  reporting: number;
  bad: Array<{ hostId: number; hostName: string; reason: "down" | "unstable"; medianMs: number | null; jitterMs: number | null; lossPct: number | null }>;
  allBad: boolean;
};

/** 规则卡上那一句用：几台出口、哪几台有问题、是不是全都有问题。 */
export function summarizeRuleExitTargets(ruleId: number, tunnel: TunnelRow | null | undefined, exitHostIds: readonly number[], nowMs = Date.now()): RuleExitTargetSummary | null {
  if (!tunnelBalancesExits(tunnel) || exitHostIds.length < 2) return null;
  const detect = tunnelBalanceDetect(tunnel);
  const fresh = exitTargetStatesForRule(ruleId, nowMs).filter((state) => exitHostIds.includes(state.hostId));
  if (fresh.length === 0) return null;
  const bad = fresh
    .filter((state) => state.down || exitTargetUnstable(state, detect))
    .map((state) => ({
      hostId: state.hostId,
      hostName: state.hostName,
      reason: (state.down ? "down" : "unstable") as "down" | "unstable",
      medianMs: state.medianMs ?? state.latencyMs,
      jitterMs: state.jitterMs,
      lossPct: state.lossPct,
    }));
  return { total: exitHostIds.length, reporting: fresh.length, bad, allBad: bad.length > 0 && bad.length >= fresh.length && fresh.length >= exitHostIds.length };
}

/**
 * 给规则的流量 / 延迟汇总行补上「各台出口到目标」：exitTargetTotal（报上来的出口数，≥2 才有）、
 * exitTargetOk（其中连得上的）、exitTargetNote（规则卡上那一句，没问题时 null）。只用内存里的状态，不查库。
 */
export function withRuleExitTargets<T extends { ruleId: number | string }>(rows: T[], nowMs = Date.now()): Array<T & { exitTargetTotal: number | null; exitTargetOk: number | null; exitTargetNote: string | null }> {
  return rows.map((row) => {
    const fresh = exitTargetStatesForRule(Number(row.ruleId), nowMs);
    if (fresh.length < 2) return { ...row, exitTargetTotal: null, exitTargetOk: null, exitTargetNote: null };
    const bad = fresh.filter((state) => state.down || state.unstable).map((state) => ({
      hostId: state.hostId,
      hostName: state.hostName,
      reason: (state.down ? "down" : "unstable") as "down" | "unstable",
      medianMs: state.medianMs ?? state.latencyMs,
      jitterMs: state.jitterMs,
      lossPct: state.lossPct,
    }));
    const summary: RuleExitTargetSummary = { total: fresh.length, reporting: fresh.length, bad, allBad: bad.length > 0 && bad.length >= fresh.length };
    return {
      ...row,
      exitTargetTotal: fresh.length,
      exitTargetOk: fresh.filter((state) => !state.down).length,
      exitTargetNote: describeRuleExitTargetSummary(summary, fresh.some((state) => state.gost)),
    };
  });
}

/**
 * 规则卡上那一句话。没有问题返回 null。
 * gost：GOST 隧道只能把连不上的出口摘掉，抖动、丢包没法少分，只写出来。
 */
export function describeRuleExitTargetSummary(summary: RuleExitTargetSummary | null, gost = false): string | null {
  if (!summary || summary.bad.length === 0) return null;
  if (summary.allBad) return `${summary.total} 台出口都连不好目标：多半是目标本身的问题，换出口没用`;
  const parts = summary.bad.map((item) => {
    if (item.reason === "down") return `${item.hostName} 连不上目标，已切走`;
    const detail = item.lossPct && item.lossPct >= UNSTABLE_LOSS_PCT ? `丢包 ${Math.round(item.lossPct)}%` : `抖动 ${Math.round(item.jitterMs ?? 0)}ms`;
    return gost ? `${item.hostName} 到目标${detail}` : `${item.hostName} 到目标${detail}，已少分`;
  });
  return `${summary.total} 台出口里 ${parts.join("；")}`;
}
