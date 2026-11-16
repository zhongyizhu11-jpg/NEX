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
}

/** 只给测试用：直接放一条状态（不走数据库校验） */
export function setExitTargetStateForTest(state: ExitTargetState) {
  states.set(stateKey(state.ruleId, state.hostId), state);
}

type TunnelRow = {
  id: number;
  mode?: string | null;
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
    if (previous && previous.down !== next.down) {
      flipped.push(Number(rule.id));
      appendPanelLog(next.down ? "warn" : "info", `[LoadBalance] rule=${rule.id} 出口 ${hostName} ${next.down ? "连不上目标" : "到目标恢复"}（tunnel=${tunnel.id}）`);
      // GOST 隧道要入口重新拿配置才会摘掉 / 加回这台出口；NEX 隧道入口自己会换，不用推。
      if (String(tunnel.mode || "").toLowerCase() !== "forwardx") {
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
export function exitTargetSummaryForTunnel(tunnelId: number, nowMs = Date.now()) {
  const byHost = new Map<number, { hostId: number; rules: number; down: number; unstable: number; medianMs: number | null; jitterMs: number | null; lossPct: number | null }>();
  for (const state of states.values()) {
    if (state.tunnelId !== Number(tunnelId) || nowMs - state.at > EXIT_TARGET_STALE_MS) continue;
    const entry = byHost.get(state.hostId) || { hostId: state.hostId, rules: 0, down: 0, unstable: 0, medianMs: null, jitterMs: null, lossPct: null };
    entry.rules += 1;
    if (state.down) entry.down += 1;
    else if (state.unstable) entry.unstable += 1;
    const median = state.medianMs ?? state.latencyMs;
    if (median != null) entry.medianMs = Math.max(entry.medianMs ?? 0, median);
    if (state.jitterMs != null) entry.jitterMs = Math.max(entry.jitterMs ?? 0, state.jitterMs);
    if (state.lossPct != null) entry.lossPct = Math.max(entry.lossPct ?? 0, state.lossPct);
    byHost.set(state.hostId, entry);
  }
  return Array.from(byHost.values()).sort((left, right) => left.hostId - right.hostId);
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
