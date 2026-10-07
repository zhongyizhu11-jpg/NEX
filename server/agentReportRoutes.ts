import { Router, Request, Response } from "express";
import * as db from "./db";
import { appendPanelLog } from "./_core/panelLogger";
import { isHostMetricsWatching, pushAgentRefresh } from "./agentEvents";
import { handleTrafficBillingShortfall } from "./trafficBillingRuleBlock";
import {
  isAgentForwardGroupLatencyResult,
  isAgentHostProbeServiceResult,
  isAgentHostTrafficStat,
  isAgentTcpingResult,
  isAgentTrafficStat,
  isAgentTunnelTcpingResult,
  normalizeAgentProbeCounts,
  type AgentForwardGroupLatencyResult,
  type AgentHostProbeServiceResult,
  type AgentHostTrafficStat,
  type AgentTcpingResult,
  type AgentTrafficStat,
  type AgentTunnelTcpingResult,
} from "../shared/agentDtos";
import {
  isProxyInboundTrafficRuleId,
  proxyInboundIdFromTrafficRuleId,
} from "../shared/proxyInboundTraffic";
import { isEntryBridgeRuleId } from "../shared/ruleEntryBridge";
import { recordForwardGroupAutoHopLatency } from "./forwardGroupAutoLatencyState";
import { getTunnelAutoHopAggregate, recordTunnelAutoHopLatency } from "./tunnelAutoLatencyState";
import { getTunnelMultiEntryLatency, recordTunnelMultiEntryLatency } from "./tunnelMultiEntryLatencyState";
import { completeLookingGlassAgentTask, updateLookingGlassAgentTaskProgress, type LookingGlassMethod } from "./lookingGlassAgentTasks";
import { completeIperf3AgentTask } from "./iperf3AgentTasks";
import { completePluginAgentTask } from "./pluginAgentTasks";
import { getAgentHostIdentityFromRequest } from "./agentAuth";
import { ingestRouteHopProbeReports } from "./routeGroups";
import { applyTrafficMultiplier, normalizeTrafficMultiplier } from "../shared/trafficMultiplier";
import { normalizeTrafficCounterBytes, normalizeTrafficCounterConnections } from "../shared/trafficCounterBytes";
import { mapWithConcurrency } from "./asyncPool";
import { forwardGroupProbeTopologyKey, tunnelProbeTopologyKey } from "./probeTopology";
import { withKeyedTaskLock, withTrafficBillingUserLock } from "./keyedTaskLock";
import { isTunnelRelayFailover, tunnelRelayCandidates } from "../shared/tunnelRelay";
import { exitGroupUsesMultipleExits } from "../shared/exitStrategy";
import { isRuleLatencyReportMethodCompatible } from "../shared/latencyProbe";
import { completeSupportBundleHost } from "./supportBundle";
import {
  combineTunnelRuleLatencySample,
  validateTunnelRuleLatencyReport,
} from "./ruleLatency";
import { clearRuleLatencyQueryCache } from "./ruleLatencyQueryCache";
import { agentTcpingReportGate } from "./agentTcpingReportGate";
import { selectAgentTrafficReportInterval } from "./agentHeartbeatGate";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

const VERBOSE_AGENT_REPORTS = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_VERBOSE_AGENT_REPORTS || ""));

async function refreshUserRuleAgents(userId: number, reason: string) {
  const rules = await db.getForwardRulesForUserSync(userId);
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules as any[]) {
    if (rule.hostId) hostIds.add(Number(rule.hostId));
    if (rule.tunnelId) tunnelIds.add(Number(rule.tunnelId));
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await db.getTunnelById(tunnelId);
    if (!tunnel) continue;
    await db.updateTunnel(tunnelId, { isRunning: false } as any);
    hostIds.add(Number(tunnel.entryHostId));
    hostIds.add(Number(tunnel.exitHostId));
  }
  for (const hostId of hostIds) {
    if (hostId > 0) pushAgentRefresh(hostId, reason);
  }
}

function cleanTunnelSeriesKey(value: unknown) {
  const key = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return key.slice(0, 64);
}

function cleanTunnelSeriesLabel(value: unknown, fallback: string) {
  const label = String(value || "").trim().replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
  return (label || fallback).slice(0, 96);
}
function isForwardXTunnel(tunnel: any) {
  return String(tunnel?.mode || "").toLowerCase() === "forwardx";
}

function tunnelUsesExtraExitHosts(tunnel: any) {
  return !!tunnel?.loadBalanceEnabled
    && String(tunnel?.loadBalanceStrategy || "").trim().toLowerCase() !== "none";
}

async function withTrafficAccountingUserLocks<T>(userIds: number[], task: () => Promise<T>): Promise<T> {
  const ids = Array.from(new Set(userIds
    .map((id) => Math.floor(Number(id) || 0))
    .filter((id) => id > 0)))
    .sort((left, right) => left - right);
  // 用 withTrafficBillingUserLock 而不是裸的键锁：它同时把「持有这把锁」记进调用链，
  // 里面记账触发的结算 / 停规则再为同一个用户拿这把锁时按重入处理，不会自己等自己。
  const run = (index: number): Promise<T> => index >= ids.length
    ? task()
    : withTrafficBillingUserLock(ids[index], () => run(index + 1));
  return run(0);
}

/**
 * NEX（forwardx）隧道的流量按哪一边记。
 *
 * 入口看得到协议层的细节，历来按入口记；但入口机是租户自己的机器时，它上面的
 * Agent/FXP 可以被改成报 0，流量白走管理员的出口，配额和计费都不动。所以只要有
 * 一台入口机（主入口、入口组里的机器）不是管理员的，就改按出口记（出口 FXP 也会
 * 按规则报一份，见 forwardx-fxp/exit_traffic.go）。入口全是管理员的（或没有主人）
 * 时照旧按入口。两边永远只记一边。
 */
export function forwardXTrafficAccountedAtExit(tunnel: any | null, entryTrusted: boolean) {
  return !!tunnel && isForwardXTunnel(tunnel) && !entryTrusted;
}

export function trafficAccountingHostIds(
  rule: any,
  tunnel: any | null,
  entryHostIds: Set<number> | undefined,
  extraExitHostIds: Set<number> | undefined,
  entryTrusted: boolean,
) {
  if (!tunnel) return new Set([Number(rule.hostId || 0)]);
  if (isForwardXTunnel(tunnel) && entryTrusted) {
    return entryHostIds && entryHostIds.size > 0
      ? new Set(entryHostIds)
      : new Set([Number(tunnel.entryHostId || 0)]);
  }
  // 其余隧道，以及入口不可信的 NEX 隧道：按出口（主出口 + 负载均衡里启用的出口）记。
  const ids = new Set<number>([Number(tunnel.exitHostId || 0)]);
  if (tunnelUsesExtraExitHosts(tunnel)) {
    for (const hostId of extraExitHostIds || []) ids.add(Number(hostId));
  }
  return ids;
}

/**
 * 这份上报算不算：得是这条规则的记账机器报的，而且是记账那一边报的。
 *
 * fromForwardXExit 是出口 FXP 替规则记的那份（上报里 reportSide=exit）。只看机器不够：
 * 一台机器可能既在入口组里又是出口，入口那份和出口那份都会从它报上来，只能按「这份
 * 是哪边记的」挑一份，不然就记两遍。
 */
export function isTrafficAccountingReport(input: {
  rule: any;
  tunnel: any | null;
  entryHostIds: Set<number> | undefined;
  extraExitHostIds: Set<number> | undefined;
  entryTrusted: boolean;
  hostId: number;
  fromForwardXExit: boolean;
}) {
  const hostIds = trafficAccountingHostIds(
    input.rule,
    input.tunnel,
    input.entryHostIds,
    input.extraExitHostIds,
    input.entryTrusted,
  );
  if (!hostIds.has(Number(input.hostId))) return false;
  return input.fromForwardXExit === forwardXTrafficAccountedAtExit(input.tunnel, input.entryTrusted);
}

export function shouldAccountForwardRuleTraffic(rule: any, group: any | null) {
  // 线路组的中继规则：流量在入口那条规则上已经算过了，中转上每一跳再算一遍就是按跳数翻倍。
  if (Number(rule?.routeParentRuleId || 0) > 0) return false;
  const groupId = Number(rule?.forwardGroupId || 0);
  const templateId = Number(rule?.forwardGroupRuleId || 0);
  const memberId = Number(rule?.forwardGroupMemberId || 0);
  if (!groupId || !templateId || !memberId) return true;
  if (String(group?.groupMode || "failover") !== "chain") return true;
  const members = [...(group.members || [])]
    .filter((member: any) => !!member.isEnabled)
    .sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
  const firstMember = members[0] as any;
  if (Number(firstMember?.id || 0) !== memberId) return false;
  const firstHostId = Number(firstMember?.hostId || 0);
  if (!firstHostId) return true;
  return Number(rule?.hostId || 0) === firstHostId;
}

function quotaTrafficMultiplierForRule(rule: any, tunnel: any | null, group: any | null) {
  const groupId = Number(rule?.forwardGroupId || 0);
  if (groupId > 0) {
    if (group && ["port", "chain", "failover"].includes(String(group?.groupMode || "failover"))) {
      return normalizeTrafficMultiplier(group?.trafficMultiplier);
    }
  }
  if (tunnel) return normalizeTrafficMultiplier((tunnel as any).trafficMultiplier);
  return 100;
}

const trafficReportLogIntervalMs = 10_000;
const tcpingReportLogIntervalMs = 30_000;
// Keep one operational traffic summary per host every few minutes. Per-rule
// samples remain opt-in via FORWARDX_VERBOSE_AGENT_REPORTS.
const trafficReportSummaryLogIntervalMs = 5 * 60_000;
const REPORT_LOG_CACHE_MAX = 20_000;
const REPORT_LOG_CACHE_RETENTION_MS = 60 * 60 * 1000;

type TrafficReportLogBucket = {
  lastLoggedAt: number;
  updatedAt: number;
  samples: number;
  bytesIn: number;
  bytesOut: number;
  connectionsMax: number;
};

const trafficReportLogBuckets = new Map<string, TrafficReportLogBucket>();
const reportLogTimes = new Map<string, number>();

function pruneReportLogCaches(now = Date.now()) {
  pruneMapEntries(
    trafficReportLogBuckets,
    (bucket) => !Number.isFinite(bucket.updatedAt) || now - bucket.updatedAt >= REPORT_LOG_CACHE_RETENTION_MS,
  );
  pruneMapEntries(
    reportLogTimes,
    (loggedAt) => !Number.isFinite(loggedAt) || now - loggedAt >= REPORT_LOG_CACHE_RETENTION_MS,
  );
}

const reportLogCacheCleanupTimer = setInterval(() => pruneReportLogCaches(), 10 * 60 * 1000);
reportLogCacheCleanupTimer.unref?.();

function logTrafficReportSample(key: string, label: string, bytesIn: number, bytesOut: number, connections: number) {
  if (!VERBOSE_AGENT_REPORTS) return;
  const now = Date.now();
  const bucket = trafficReportLogBuckets.get(key) || {
    lastLoggedAt: 0,
    updatedAt: now,
    samples: 0,
    bytesIn: 0,
    bytesOut: 0,
    connectionsMax: 0,
  };
  bucket.samples += 1;
  bucket.bytesIn += Math.max(0, Number(bytesIn) || 0);
  bucket.bytesOut += Math.max(0, Number(bytesOut) || 0);
  bucket.connectionsMax = Math.max(bucket.connectionsMax, Number(connections) || 0);
  bucket.updatedAt = now;
  if (bucket.lastLoggedAt === 0 || now - bucket.lastLoggedAt >= trafficReportLogIntervalMs) {
    console.log(`${label} samples=${bucket.samples} in=${bucket.bytesIn} out=${bucket.bytesOut} connectionsMax=${bucket.connectionsMax}`);
    setBoundedMapValue(trafficReportLogBuckets, key, {
      lastLoggedAt: now,
      updatedAt: now,
      samples: 0,
      bytesIn: 0,
      bytesOut: 0,
      connectionsMax: 0,
    }, REPORT_LOG_CACHE_MAX);
    return;
  }
  setBoundedMapValue(trafficReportLogBuckets, key, bucket, REPORT_LOG_CACHE_MAX);
}

function shouldLogReport(key: string, intervalMs: number) {
  const now = Date.now();
  const last = reportLogTimes.get(key) || 0;
  if (now - last < intervalMs) return false;
  setBoundedMapValue(reportLogTimes, key, now, REPORT_LOG_CACHE_MAX);
  return true;
}

function logTrafficReportSummary(input: {
  hostId: number;
  hostName?: string;
  reported: number;
  accepted: number;
  routedAway: number;
  ignored: number;
  bytesIn: number;
  bytesOut: number;
  hostBytesIn?: number;
  hostBytesOut?: number;
  duplicate?: boolean;
  durationMs: number;
}) {
  if (input.hostId <= 0 || !shouldLogReport(`traffic-summary:${input.hostId}`, trafficReportSummaryLogIntervalMs)) return;
  const name = String(input.hostName || "-").replace(/[\r\n\t]+/g, " ").slice(0, 96);
  const hostBytes = input.hostBytesIn !== undefined || input.hostBytesOut !== undefined
    ? ` hostBytes=${Math.max(0, Number(input.hostBytesIn) || 0)}/${Math.max(0, Number(input.hostBytesOut) || 0)}`
    : "";
  console.info(
    `[Agent Traffic] summary host=${input.hostId} name=${name} reported=${input.reported} accepted=${input.accepted}`
      + ` routedAway=${input.routedAway} ignored=${input.ignored}`
      + ` bytes=${Math.max(0, Number(input.bytesIn) || 0)}/${Math.max(0, Number(input.bytesOut) || 0)}`
      + `${hostBytes} duplicate=${input.duplicate === true} duration=${Math.max(0, Number(input.durationMs) || 0)}ms`,
  );
}

function logTcpingReportSummary(
  hostId: number,
  results: AgentTcpingResult[],
  tunnelResults: AgentTunnelTcpingResult[],
  forwardGroupResults: AgentForwardGroupLatencyResult[],
  serviceResults: AgentHostProbeServiceResult[],
) {
  if (!VERBOSE_AGENT_REPORTS) return;
  if (!shouldLogReport(`tcping:${hostId}`, tcpingReportLogIntervalMs)) return;
  const all = [...results, ...tunnelResults, ...forwardGroupResults, ...serviceResults] as Array<{ latencyMs?: unknown; isTimeout?: unknown }>;
  const timeouts = all.filter((item) => !!item.isTimeout).length;
  const latencies = all
    .map((item) => Number(item.latencyMs))
    .filter((value) => Number.isFinite(value) && value > 0);
  const avgLatency = latencies.length
    ? `${Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)}ms`
    : "-";
  console.info(`[Agent TCPing] host=${hostId} rules=${results.length} tunnels=${tunnelResults.length} groups=${forwardGroupResults.length} services=${serviceResults.length} timeouts=${timeouts}/${all.length} avg=${avgLatency}`);
}

function compactTrafficStats(value: unknown): AgentTrafficStat[] {
  if (!Array.isArray(value)) return [];
  const stats: AgentTrafficStat[] = [];
  for (const row of value) {
    if (!Array.isArray(row)) continue;
    const ruleId = Number(row[0]);
    if (!Number.isFinite(ruleId)) continue;
    stats.push({
      ruleId,
      bytesIn: Number(row[1]) || 0,
      bytesOut: Number(row[2]) || 0,
      connections: Number(row[3]) || 0,
    });
  }
  return stats;
}

/**
 * 一次上报内按 entryGroupId 复用入口组的查询结果。
 *
 * 一次流量 / TCPing 上报里往往有很多条隧道共用同一个入口组，原来每条隧道各查一遍
 * getForwardGroupById（连成员一起）。存的是 Promise，并发的几条隧道也只会查一次。
 * 只在单次请求内有效，不跨请求缓存，所以不会读到别的请求之前的旧数据。
 */
type EntryGroupMemo = Map<number, Promise<any>>;

async function tunnelEntryHostIds(tunnel: any, entryGroupMemo?: EntryGroupMemo) {
  return (await tunnelEntryHostScope(tunnel, entryGroupMemo)).active;
}

/**
 * active：现在算入口的机器（主入口 + 启用的入口组里启用的机器），入口记账认它们。
 * all：判断入口可不可信时要看的机器，入口组里停用的机器也算上 —— 停用的成员
 * 手里还有隧道密钥，它要是租户的机器，照样能往出口送流量。
 */
async function tunnelEntryHostScope(tunnel: any, entryGroupMemo?: EntryGroupMemo) {
  const active = new Set<number>();
  const all = new Set<number>();
  const primary = Number(tunnel?.entryHostId || 0);
  if (primary > 0) {
    active.add(primary);
    all.add(primary);
  }
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId > 0) {
    let groupPromise = entryGroupMemo?.get(entryGroupId);
    if (!groupPromise) {
      groupPromise = db.getForwardGroupById(entryGroupId);
      entryGroupMemo?.set(entryGroupId, groupPromise);
    }
    const group = await groupPromise as any;
    const groupActive = !!group?.isEnabled && String(group?.groupMode || "") === "entry";
    for (const member of group?.members || []) {
      const hostId = member?.memberType === "host" ? Number(member.hostId || 0) : 0;
      if (hostId <= 0) continue;
      all.add(hostId);
      if (groupActive && member?.isEnabled !== false) active.add(hostId);
    }
  }
  return { active, all };
}

export function tunnelProbeTargetHostId(
  tunnel: any,
  hops: any[],
  exitNodes: any[],
  report: AgentTunnelTcpingResult,
  seriesKey = "",
) {
  const hopIndex = Number(report.hopIndex);
  const hopCount = Number(report.hopCount);
  if (Number.isInteger(hopIndex) && Number.isInteger(hopCount) && hopCount > 0) {
    if (isTunnelRelayFailover(tunnel, hops) && /^relay-\d+$/.test(seriesKey)) {
      const relayIndex = Number(seriesKey.slice("relay-".length)) - 1;
      const relay = tunnelRelayCandidates(hops)[relayIndex] as any;
      if (relay && hopIndex === 0) return Number(relay.hostId || 0) || null;
      if (relay && hopIndex === 1) return Number(hops[hops.length - 1]?.hostId || 0) || null;
    }
    return Number(hops[hopIndex + 1]?.hostId || 0) || null;
  }
  if (seriesKey === "primary") return Number(tunnel?.exitHostId || 0) || null;
  const exitMatch = seriesKey.match(/^exit-(\d+)$/);
  if (exitMatch && tunnel?.loadBalanceEnabled && exitGroupUsesMultipleExits(tunnel?.loadBalanceStrategy)) {
    const exitIndex = Number(exitMatch[1]) - 2;
    const activeExits = [...(exitNodes || [])]
      .filter((node) => node?.isEnabled !== false && Number(node?.hostId || 0) > 0 && Number(node?.listenPort || 0) > 0)
      .sort((left, right) => Number(left?.seq || 0) - Number(right?.seq || 0));
    if (exitIndex >= 0) return Number(activeExits[exitIndex]?.hostId || 0) || null;
  }
  return Number(tunnel?.exitHostId || 0) || null;
}

type TunnelRelayAggregate = {
  key: string;
  label: string;
  aggregate: { success: boolean; latencyMs: number | null; probeCount?: number; probeSuccesses?: number } | null;
};

export function readyTunnelRelayAggregates(aggregates: TunnelRelayAggregate[]) {
  const completed = aggregates.filter((item): item is TunnelRelayAggregate & {
    aggregate: { success: boolean; latencyMs: number | null; probeCount?: number; probeSuccesses?: number };
  } => item.aggregate !== null);
  return completed.some((item) => item.aggregate.success) || completed.length === aggregates.length
    ? completed
    : [];
}

export async function validateTunnelProbeSource(
  hostId: number,
  tunnel: any,
  report: AgentTunnelTcpingResult,
  context?: { hops: any[]; exitNodes: any[]; entryHostIds?: Set<number>; topologyKey?: string },
) {
  if (!tunnel?.isEnabled) return false;
  const hops = context?.hops || await db.getTunnelHops(Number(tunnel.id)) as any[];
  const exitNodes = context?.exitNodes || await db.getTunnelExitNodes(Number(tunnel.id)) as any[];
  const topologyKey = String((report as any).topologyKey || "");
  const expectedTopologyKey = context?.topologyKey || tunnelProbeTopologyKey(tunnel, hops, exitNodes);
  if (topologyKey && topologyKey !== expectedTopologyKey) return false;
  const hopIndex = Number(report.hopIndex);
  const hopCount = Number(report.hopCount);
  if (Number.isInteger(hopIndex) && Number.isInteger(hopCount) && hopCount > 0) {
    if (isTunnelRelayFailover(tunnel, hops)) {
      const relayMatch = String(report.seriesKey || "").match(/^relay-(\d+)$/);
      const relayIndex = Number(relayMatch?.[1] || 0);
      const relays = tunnelRelayCandidates(hops) as any[];
      if (!relayMatch || relayIndex <= 0 || relayIndex > relays.length || hopCount !== 2 || hopIndex < 0 || hopIndex > 1) return false;
      const relay = relays[relayIndex - 1] as any;
      if (hopIndex === 0) {
        const entryHostIds = context?.entryHostIds || await tunnelEntryHostIds(tunnel);
        return entryHostIds.has(Number(hostId))
          && (!report.targetPort || Number(relay?.listenPort || 0) === Number(report.targetPort));
      }
      const finalExit = hops[hops.length - 1] as any;
      return Number(relay?.hostId || 0) === Number(hostId)
        && (!report.targetPort || Number(finalExit?.listenPort || 0) === Number(report.targetPort));
    }
    if (!Array.isArray(hops) || hops.length - 1 !== hopCount || hopIndex < 0 || hopIndex >= hopCount) return false;
    if (hopIndex === 0) {
      const entryHostIds = context?.entryHostIds || await tunnelEntryHostIds(tunnel);
      if (!entryHostIds.has(Number(hostId))) return false;
    } else if (Number(hops[hopIndex]?.hostId || 0) !== Number(hostId)) {
      return false;
    }
    const expectedPort = Number(hops[hopIndex + 1]?.listenPort || 0);
    return !report.targetPort || expectedPort === Number(report.targetPort);
  }
  const entryHostIds = context?.entryHostIds || await tunnelEntryHostIds(tunnel);
  if (!entryHostIds.has(Number(hostId))) return false;
  const expectedPorts = new Set<number>([Number(tunnel.listenPort || 0)]);
  for (const node of exitNodes) {
    if (node?.isEnabled !== false && Number(node?.listenPort || 0) > 0) expectedPorts.add(Number(node.listenPort));
  }
  return !report.targetPort || expectedPorts.has(Number(report.targetPort));
}

function sameProbeTarget(left: unknown, right: unknown) {
  return String(left || "").trim().replace(/^\[|\]$/g, "").toLowerCase()
    === String(right || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

export function summarizeTunnelBranches(branches: Array<{ latencyMs: number | null; isTimeout: boolean; probeCount?: number; probeSuccesses?: number }>) {
  const successful = branches.filter((branch) => !branch.isTimeout && Number(branch.latencyMs || 0) > 0);
  const normalizeBranchCounts = (branch: typeof branches[number]) => {
    const rawCount = Number(branch.probeCount);
    const probeCount = Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 1024 ? rawCount : 1;
    const rawSuccesses = Number(branch.probeSuccesses);
    const hasSuccesses = branch.probeSuccesses !== undefined
      && branch.probeSuccesses !== null
      && Number.isInteger(rawSuccesses);
    const probeSuccesses = Math.max(0, Math.min(
      probeCount,
      hasSuccesses ? rawSuccesses : (branch.isTimeout ? 0 : probeCount),
    ));
    return { probeCount, probeSuccesses };
  };
  const successfulCounts = successful
    .map(normalizeBranchCounts)
    .sort((left, right) => right.probeSuccesses / right.probeCount - left.probeSuccesses / left.probeCount);
  const allCounts = branches.map(normalizeBranchCounts);
  const result: {
    unavailable: boolean;
    partial: boolean;
    latencyMs: number | null;
    probeCount?: number;
    probeSuccesses?: number;
  } = {
    unavailable: successful.length === 0,
    partial: successful.length > 0 && successful.length < branches.length,
    latencyMs: successful.length > 0 ? Math.max(...successful.map((branch) => Number(branch.latencyMs))) : null,
  };
  let probeCount = 1;
  let probeSuccesses = result.unavailable ? 0 : 1;
  if (successfulCounts.length > 0) {
    ({ probeCount, probeSuccesses } = successfulCounts[0]);
  } else if (allCounts.length > 0) {
    probeCount = Math.max(...allCounts.map((counts) => counts.probeCount), 1);
    const ratio = Math.min(...allCounts.map((counts) => counts.probeSuccesses / counts.probeCount));
    probeSuccesses = Math.max(0, Math.min(probeCount, Math.floor(ratio * probeCount + 1e-9)));
  }
  if (probeCount !== 1 || probeSuccesses !== (result.unavailable ? 0 : 1)) {
    result.probeCount = probeCount;
    result.probeSuccesses = probeSuccesses;
  }
  return result;
}

/**
 * Compose the exit-to-target probe with the current tunnel sample. Both
 * probes describe the same end-to-end request from different hops, so retain
 * the lowest success ratio instead of silently reporting a clean target
 * probe when the tunnel itself had partial loss.
 */
export function combineTunnelRuleProbeCounts(input: {
  target: { isTimeout?: unknown; probeCount?: unknown; probeSuccesses?: unknown };
  tunnel?: { isTimeout?: unknown; probeCount?: unknown; probeSuccesses?: unknown } | null;
  combinedIsTimeout: boolean;
}) {
  const target = normalizeAgentProbeCounts(input.target, { legacyZeroAsSuccess: false });
  if (!input.tunnel) {
    return {
      probeCount: target.probeCount,
      probeSuccesses: input.combinedIsTimeout ? 0 : target.probeSuccesses,
    };
  }
  // Tunnel rows can predate counter telemetry. Successful legacy rows have
  // the new column's zero default, which normalizeAgentProbeCounts recognizes
  // as one successful probe at this database-read boundary.
  const tunnel = normalizeAgentProbeCounts(input.tunnel);
  const probeCount = Math.max(target.probeCount, tunnel.probeCount, 1);
  if (input.combinedIsTimeout) return { probeCount, probeSuccesses: 0 };
  const successRatio = Math.min(
    target.probeSuccesses / target.probeCount,
    tunnel.probeSuccesses / tunnel.probeCount,
  );
  return {
    probeCount,
    probeSuccesses: Math.max(0, Math.min(probeCount, Math.floor(successRatio * probeCount + 1e-9))),
  };
}

function compactHostTraffic(value: unknown): AgentHostTrafficStat | null {
  if (!Array.isArray(value)) return null;
  const bytesIn = Number(value[0]) || 0;
  const bytesOut = Number(value[1]) || 0;
  if (!Number.isFinite(bytesIn) && !Number.isFinite(bytesOut)) return null;
  return { bytesIn, bytesOut };
}

export function registerAgentReportRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/support-bundle-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const taskId = String(req.body?.taskId || "").trim();
    if (!taskId) {
      res.status(400).json({ error: "taskId is required" });
      return;
    }
    const accepted = completeSupportBundleHost(taskId, Number(host.id), {
      diagnostics: req.body?.diagnostics,
      error: req.body?.error,
    });
    res.json({ success: accepted });
  } catch (error) {
    console.error("[SupportBundle] Agent report failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/looking-glass-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const result = req.body?.result;
    if (!result?.taskId) {
      res.status(400).json({ error: "result.taskId is required" });
      return;
    }
    const ok = completeLookingGlassAgentTask(host.id, {
      taskId: String(result.taskId),
      method: result.method as LookingGlassMethod,
      target: String(result.target || ""),
      port: result.port === undefined || result.port === null ? undefined : Number(result.port),
      resolvedAddress: String(result.resolvedAddress || ""),
      resolvedAddresses: Array.isArray(result.resolvedAddresses) ? result.resolvedAddresses.map(String) : [],
      output: String(result.output || ""),
      exitCode: result.exitCode === undefined || result.exitCode === null ? null : Number(result.exitCode),
      timedOut: !!result.timedOut,
      durationMs: Number(result.durationMs || 0),
      startedAt: String(result.startedAt || new Date().toISOString()),
      finishedAt: String(result.finishedAt || new Date().toISOString()),
      error: result.error ? String(result.error) : undefined,
    });
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent LookingGlass] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/looking-glass-progress", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const result = req.body?.result;
    if (!result?.taskId) {
      res.status(400).json({ error: "result.taskId is required" });
      return;
    }
    const ok = updateLookingGlassAgentTaskProgress(host.id, {
      taskId: String(result.taskId),
      output: String(result.output || ""),
      durationMs: Number(result.durationMs || 0),
      startedAt: String(result.startedAt || new Date().toISOString()),
      error: result.error ? String(result.error) : undefined,
    });
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent LookingGlassProgress] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/iperf3-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const result = req.body?.result;
    if (!result?.taskId) {
      res.status(400).json({ error: "result.taskId is required" });
      return;
    }
    const ok = completeIperf3AgentTask(host.id, {
      taskId: String(result.taskId),
      op: result.op === "stop" ? "stop" : "start",
      port: Number(result.port || 5201),
      status: result.status === "stopped" ? "stopped" : result.status === "error" ? "error" : "running",
      output: String(result.output || ""),
      pid: result.pid === undefined || result.pid === null ? null : Number(result.pid),
      startedAt: result.startedAt ? String(result.startedAt) : undefined,
      updatedAt: result.updatedAt ? String(result.updatedAt) : undefined,
      error: result.error ? String(result.error) : undefined,
    });
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent Iperf3] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/plugin-action-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const result = req.body?.result;
    if (!result?.taskId || !result?.groupId || !result?.pluginId || !result?.actionId) {
      res.status(400).json({ error: "plugin action result identifiers are required" });
      return;
    }
    let data = result.data;
    if (data !== undefined) {
      try {
        if (Buffer.byteLength(JSON.stringify(data), "utf8") > 256 * 1024) {
          res.status(400).json({ error: "plugin action result data is too large" });
          return;
        }
      } catch {
        res.status(400).json({ error: "plugin action result data is invalid" });
        return;
      }
    }
    const ok = completePluginAgentTask(host.id, {
      taskId: String(result.taskId),
      groupId: String(result.groupId),
      pluginId: String(result.pluginId),
      actionId: String(result.actionId),
      success: !!result.success,
      output: String(result.output || "").slice(0, 256 * 1024),
      stderr: String(result.stderr || "").slice(0, 256 * 1024),
      data,
      exitCode: result.exitCode === undefined || result.exitCode === null ? null : Number(result.exitCode),
      timedOut: !!result.timedOut,
      durationMs: Math.max(0, Number(result.durationMs || 0)),
      startedAt: result.startedAt ? String(result.startedAt) : undefined,
      finishedAt: result.finishedAt ? String(result.finishedAt) : undefined,
      error: result.error ? String(result.error).slice(0, 4000) : undefined,
      errorDetail: result.errorDetail ? String(result.errorDetail).slice(0, 4000) : undefined,
      advice: result.advice ? String(result.advice).slice(0, 4000) : undefined,
      processError: result.processError ? String(result.processError).slice(0, 4000) : undefined,
    });
    if (ok) await db.syncPluginAgentActionState(String(result.pluginId), String(result.groupId));
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent Plugin Action] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// FXP 报链路整形状态（forwardx-fxp/link_shaper_report.go）：一条隧道一次，两个方向。
agentRouter.post("/api/agent/fxp-link-shaping", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const tunnelId = Math.floor(Number(req.body?.tunnelId || 0));
    const role = String(req.body?.role || "").trim().toLowerCase().slice(0, 16);
    const rawShapers = Array.isArray(req.body?.shapers) ? req.body.shapers : [];
    const shapers = rawShapers.map(db.normalizeTunnelLinkShapingReport).filter(Boolean) as db.TunnelLinkShapingReport[];
    if (!Number.isFinite(tunnelId) || tunnelId <= 0 || shapers.length === 0 || rawShapers.length > 4) {
      res.status(400).json({ error: "tunnelId and shapers are required" });
      return;
    }
    const tunnel = await db.getTunnelById(tunnelId);
    if (!tunnel) {
      res.status(404).json({ error: "tunnel not found" });
      return;
    }
    const saved = await db.recordTunnelLinkShaping(tunnelId, Number((host as any).id), role, shapers);
    res.json({ ok: true, saved });
  } catch (error) {
    appendPanelLog("error", `[LinkShaping] report failed: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ error: "failed to record link shaping status" });
  }
});

agentRouter.post("/api/agent/traffic", async (req: Request, res: Response) => {
  const requestStartedAt = Date.now();
  let logHostId = 0;
  let logHostName = "";
  let reportedStatCount = 0;
  let acceptedStatCount = 0;
  let routedAwayStatCount = 0;
  let ignoredStatCount = 0;
  let acceptedBytesIn = 0;
  let acceptedBytesOut = 0;
  let strictTrafficAccounting = false;
  let trafficReportId = "";
  let trafficReportProducerId = "";
  let duplicateTrafficReport = false;
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    logHostId = Number((host as any).id || 0);
    logHostName = cleanTunnelSeriesLabel((host as any).name, "-");
    trafficReportId = typeof req.body?.reportId === "string"
      ? req.body.reportId.trim().slice(0, 128)
      : "";
    trafficReportProducerId = typeof req.body?.reportProducerId === "string"
      ? req.body.reportProducerId.trim().slice(0, 128)
      : "";
    // 出口 FXP 替规则记的那份带 reportSide=exit，其余（入口 FXP、Agent 自己的计数）都没有。
    const trafficReportFromForwardXExit = req.body?.reportSide === "exit";

    const objectStats = Array.isArray(req.body?.stats)
      ? req.body.stats.filter(isAgentTrafficStat)
      : [];
    const compactStats = compactTrafficStats(req.body?.s);
    const reportedStats: AgentTrafficStat[] = objectStats.length > 0 ? objectStats : compactStats;
    reportedStatCount = reportedStats.length;
    /*
      换隧道后旧入口桥接（shared/ruleEntryBridge）的计数一进门就丢掉：这份流量随即到达新入口，
      新入口上的规则本身会再记一遍、再计一次费；这里再记就是同一份流量扣两次。
      丢掉的也不能拿去查规则 —— 那个编号不是规则 id。
    */
    const stats = reportedStats.filter((stat) => !isEntryBridgeRuleId(stat.ruleId));
    ignoredStatCount += reportedStats.length - stats.length;
    const hostTraffic: AgentHostTrafficStat | null = isAgentHostTrafficStat(req.body?.hostTraffic)
      ? req.body.hostTraffic
      : compactHostTraffic(req.body?.h);
    if (!Array.isArray(req.body?.stats) && !Array.isArray(req.body?.s) && !hostTraffic) {
      res.status(400).json({ error: "stats array or hostTraffic is required" });
      return;
    }
    // An idle Agent may only report the host-wide network counters. Avoid
    // opening the full traffic transaction and querying billing/rule/tunnel
    // context when there are no rule deltas to account.
    if (stats.length === 0) {
      await db.withDatabaseTransaction(async () => {
        if (trafficReportId && !await db.claimAgentTrafficReport(host.id, trafficReportId, trafficReportProducerId)) {
          duplicateTrafficReport = true;
          return;
        }
        if (hostTraffic) {
          await db.recordHostTrafficSample(host.id, {
            bytesIn: normalizeTrafficCounterBytes(hostTraffic.bytesIn),
            bytesOut: normalizeTrafficCounterBytes(hostTraffic.bytesOut),
          });
        }
      });
      if (duplicateTrafficReport) {
        logTrafficReportSummary({
          hostId: logHostId,
          hostName: logHostName,
          reported: 0,
          accepted: 0,
          routedAway: 0,
          ignored: 0,
          bytesIn: 0,
          bytesOut: 0,
          hostBytesIn: hostTraffic ? Number(hostTraffic.bytesIn) || 0 : undefined,
          hostBytesOut: hostTraffic ? Number(hostTraffic.bytesOut) || 0 : undefined,
          duplicate: true,
          durationMs: Date.now() - requestStartedAt,
        });
        res.json({ success: true, duplicate: true });
        return;
      }
      const durationMs = Date.now() - requestStartedAt;
      logTrafficReportSummary({
        hostId: logHostId,
        hostName: logHostName,
        reported: 0,
        accepted: 0,
        routedAway: 0,
        ignored: 0,
        bytesIn: 0,
        bytesOut: 0,
        hostBytesIn: hostTraffic ? Number(hostTraffic.bytesIn) || 0 : undefined,
        hostBytesOut: hostTraffic ? Number(hostTraffic.bytesOut) || 0 : undefined,
        durationMs,
      });
      if (durationMs >= 2_000 && shouldLogReport(`traffic-slow:${logHostId}`, 60_000)) {
        console.warn(`[Agent Traffic] slow host=${logHostId} name=${logHostName || "-"} stats=0 duration=${durationMs}ms`);
      }
      // No rule delta means the panel cannot infer whether this host is on a
      // strict quota/billing path. Preserve the Agent's last confirmed policy.
      res.json({ success: true });
      return;
    }

    /**
     * 落地入站的上报混在同一个 stats 数组里，靠 ruleId 的基数偏移区分。
     *
     * 必须先拆开再去查转发规则：入站的那个 id 不是转发规则 id，混着查会白查一遍，
     * 而且它会走到「查不到上下文」的分支被当成无效数据丢掉 —— 那正是「都要记」
     * 却记不上的静默失败。
     */
    const inboundStats = stats.filter((stat) => isProxyInboundTrafficRuleId(stat.ruleId));
    const ruleStats = stats.filter((stat) => !isProxyInboundTrafficRuleId(stat.ruleId));
    const inboundOwners = inboundStats.length > 0
      ? await db.getProxyInboundTrafficOwnersByIds(inboundStats.map((stat) => proxyInboundIdFromTrafficRuleId(stat.ruleId)))
      : new Map<number, db.ProxyInboundTrafficOwner>();

    const trafficContexts = await db.getForwardRuleTrafficContextsByIds(ruleStats.map((stat) => Number(stat.ruleId)));
    const contextsByRuleId = new Map((trafficContexts as any[]).map((context) => [Number(context.rule.id), context]));
    const tunnelContextsById = new Map<number, any>();
    for (const context of trafficContexts as any[]) {
      const tunnelId = Number(context?.tunnel?.id || 0);
      if (tunnelId > 0 && !tunnelContextsById.has(tunnelId)) {
        tunnelContextsById.set(tunnelId, context.tunnel);
      }
    }
    const tunnelContexts = Array.from(tunnelContextsById.values());
    const tunnelIds = Array.from(tunnelContextsById.keys());
    const entryGroupMemo: EntryGroupMemo = new Map();
    const [entryHostScopePairs, tunnelExitNodes] = await Promise.all([
      Promise.all(tunnelContexts.map(async (tunnel) => [Number(tunnel.id), await tunnelEntryHostScope(tunnel, entryGroupMemo)] as const)),
      tunnelIds.length > 0
        ? db.getTunnelExitNodesByTunnelIds(tunnelIds)
        : Promise.resolve([]),
    ]);
    const entryHostsByTunnelId = new Map<number, Set<number>>(
      entryHostScopePairs.map(([tunnelId, scope]) => [tunnelId, scope.active] as const),
    );
    // NEX 隧道的入口可不可信（见 forwardXTrafficAccountedAtExit）：入口机一次查完主人。
    // 其他隧道按出口记，不用查。
    const forwardXEntryScopes = entryHostScopePairs
      .filter(([tunnelId]) => isForwardXTunnel(tunnelContextsById.get(tunnelId)));
    const trustedEntryHostIds = forwardXEntryScopes.length > 0
      ? await db.getAdminTrustedHostIds(forwardXEntryScopes.flatMap(([, scope]) => Array.from(scope.all)))
      : new Set<number>();
    const trustedEntryTunnelIds = new Set<number>(forwardXEntryScopes
      .filter(([, scope]) => scope.all.size > 0 && Array.from(scope.all).every((hostId) => trustedEntryHostIds.has(hostId)))
      .map(([tunnelId]) => tunnelId));
    const extraExitHostsByTunnelId = new Map<number, Set<number>>();
    for (const node of tunnelExitNodes as any[]) {
      const tunnelId = Number(node?.tunnelId || 0);
      const hostId = Number(node?.hostId || 0);
      if (tunnelId <= 0 || hostId <= 0 || node?.isEnabled === false) continue;
      const hosts = extraExitHostsByTunnelId.get(tunnelId) || new Set<number>();
      hosts.add(hostId);
      extraExitHostsByTunnelId.set(tunnelId, hosts);
    }
    // 只锁这台机器真的要替他记账的人。以前按上报里出现的所有规则 id 去锁：一台租户
    // 的 Agent 报一串别人的规则 id（字节数全 0），就能挨个锁住所有用户的计费行，
    // 拖住全面板的流量、配额和计费处理。
    const isAccountingHostFor = (context: any) => {
      const tunnelId = Number(context?.tunnel?.id || context?.rule?.tunnelId || 0);
      return isTrafficAccountingReport({
        rule: context.rule,
        tunnel: context.tunnel,
        entryHostIds: entryHostsByTunnelId.get(tunnelId),
        extraExitHostIds: extraExitHostsByTunnelId.get(tunnelId),
        entryTrusted: trustedEntryTunnelIds.has(tunnelId),
        hostId: Number(host.id),
        fromForwardXExit: trafficReportFromForwardXExit,
      });
    };
    const accountingUserIds = Array.from(new Set([
      ...(trafficContexts as any[])
        .filter(isAccountingHostFor)
        .map((context) => Number(context?.rule?.userId || 0)),
      // 入站的所有者也要一起上锁，否则同一个用户的两条计费路径可能并发写配额。
      // 这里宁可多锁一个人：非本机的入站待会儿会被丢掉，锁了也只是白锁。
      ...Array.from(inboundOwners.values()).map((owner) => Number(owner.userId)),
    ])).filter((userId) => userId > 0);
    await withTrafficAccountingUserLocks(accountingUserIds, () => db.withDatabaseTransaction(async () => {
      // Lock database rows in the same deterministic order as the in-process
      // keyed locks. This protects quota/billing counters when reports arrive
      // concurrently on different panel instances.
      await db.lockTrafficBillingUserRows(accountingUserIds);
      if (trafficReportId && !await db.claimAgentTrafficReport(host.id, trafficReportId, trafficReportProducerId)) {
        duplicateTrafficReport = true;
        return;
      }
      if (hostTraffic) {
        await db.recordHostTrafficSample(host.id, {
          bytesIn: normalizeTrafficCounterBytes(hostTraffic.bytesIn),
          bytesOut: normalizeTrafficCounterBytes(hostTraffic.bytesOut),
        });
      }

    const quotaTrafficByUser = new Map<number, number>();
    /**
     * 每个落地节点这一批走了多少字节。
     *
     * 落地机的「已用流量」要跨 72 小时保留期累计，所以必须在入库这一刻就加到
     * proxy_nodes.trafficUsed 上 —— traffic_stats 过期会被清掉，事后算不回来。
     */
    const trafficByProxyNode = new Map<number, number>();
    // 落地端口自己的用量。计数链装在监听端口上，一个多用户入站派生出的几个节点
    // 共用这一个端口，字节数分不到人头，所以记在入站上而不是派生节点上。
    const trafficByProxyInbound = new Map<number, number>();
    const trafficBatch: db.TrafficStatBatchItem[] = [];
    const billingEntries: Array<{
      rule: any;
      ruleBytes: number;
      billingResource: NonNullable<Awaited<ReturnType<typeof db.findTrafficBillingResourceForRule>>>;
    }> = [];
    const trafficBillingEnabled = await db.getTrafficBillingEnabledForWrite();
    const rulesWithBytes = new Set(stats
      .filter((stat) => normalizeTrafficCounterBytes(stat.bytesIn) + normalizeTrafficCounterBytes(stat.bytesOut) > 0)
      .map((stat) => Number(stat.ruleId)));
    const billingResourcesByRuleId = trafficBillingEnabled
      ? await db.findTrafficBillingResourcesForRules((trafficContexts as any[])
        .map((context) => context.rule)
        .filter((rule) => rulesWithBytes.has(Number(rule.id))))
      : new Map();
    /**
     * 落地入站的流量按「转发套餐」算，与转发规则走同一个配额出口。
     *
     * 只累加配额，不写 traffic_stats —— 那张表是按 ruleId 组织的历史明细，塞一个
     * 不存在的规则 id 进去会污染按规则看的报表。落地流量在主机维度的统计里本来
     * 就看得到。
     */
    for (const stat of inboundStats) {
      const inboundId = proxyInboundIdFromTrafficRuleId(stat.ruleId);
      const owner = inboundOwners.get(inboundId);
      const userId = Number(owner?.userId || 0);
      const bytes = normalizeTrafficCounterBytes(stat.bytesIn) + normalizeTrafficCounterBytes(stat.bytesOut);
      if (userId <= 0 || bytes <= 0) {
        ignoredStatCount += 1;
        continue;
      }
      /**
       * 这个入站得真的开在这台机器上。
       *
       * token 认的是「哪台机器」，不是「哪个入站的主人」—— 而入站号是连号的，猜得到。
       * 少了这一比，任何一台装了 Agent 的机器（包括租户自己加的那台）都能报别人机器上
       * 的入站号：字节数会记到那个租户的配额上，记满了面板就自动停掉他名下所有转发。
       * 转发那条路早就按 accountingHostIds 比过一次了，落地这条不能是个例外。
       *
       * 入站迁到别的机器、或者原机器上的 sing-box 还没收到新配置时，也会走到这里：
       * 那是过时的上报，同样不该计费。
       */
      if (Number(owner?.hostId || 0) !== Number(host.id)) {
        routedAwayStatCount += 1;
        logTrafficReportSample(
          `inbound-foreign:${host.id}:${inboundId}`,
          `[ProxyInboundTraffic] 丢弃非本机上报 host=${host.id} inbound=${inboundId} owner-host=${Number(owner?.hostId || 0)}`,
          normalizeTrafficCounterBytes(stat.bytesIn),
          normalizeTrafficCounterBytes(stat.bytesOut),
          normalizeTrafficCounterConnections(stat.connections),
        );
        continue;
      }
      // 停用的入站不该还在跑；还在报说明是停用前的存量，不计费（转发那条路同样跳过停用规则）。
      if (!owner?.isEnabled) {
        ignoredStatCount += 1;
        continue;
      }
      acceptedStatCount += 1;
      acceptedBytesIn += normalizeTrafficCounterBytes(stat.bytesIn);
      acceptedBytesOut += normalizeTrafficCounterBytes(stat.bytesOut);
      quotaTrafficByUser.set(userId, (quotaTrafficByUser.get(userId) || 0) + bytes);
      /*
        端口自己也要记一笔。原来这里只往租户配额上加，端口的已用量就永远是 0 ——
        于是「这台落地机的套餐」那一整套（额度、到量提醒）对自建的端口完全不响，
        而自建的那台机器恰恰才是有机房账单、会超量被停机的那一个。
      */
      trafficByProxyInbound.set(inboundId, (trafficByProxyInbound.get(inboundId) || 0) + bytes);
    }

    for (const stat of ruleStats) {
      // 先洗再用：入库那层本来就会洗一遍，这边不洗的话，同一次上报写进历史明细和
      // 写进配额的会是两个数（见 shared/trafficCounterBytes）。
      const bytesIn = normalizeTrafficCounterBytes(stat.bytesIn);
      const bytesOut = normalizeTrafficCounterBytes(stat.bytesOut);
      const context = contextsByRuleId.get(Number(stat.ruleId)) as any;
      if (!context) {
        ignoredStatCount += 1;
        continue;
      }
      const { rule, tunnel, group } = context;
      if ((rule as any).pendingDelete || !(rule as any).isEnabled) {
        ignoredStatCount += 1;
        continue;
      }
      if (!shouldAccountForwardRuleTraffic(rule, group)) {
        ignoredStatCount += 1;
        continue;
      }
      const tunnelId = Number((rule as any).tunnelId || 0);
      // 和上锁时的 isAccountingHostFor 同一个判断：不是这台机器、或不是这一边记的，都算「记在别处」。
      if (!isAccountingHostFor(context)) {
        routedAwayStatCount += 1;
        const ruleBytes = bytesIn + bytesOut;
        if (ruleBytes > 0 && tunnel && !isForwardXTunnel(tunnel)) {
          logTrafficReportSample(
            `tunnel:${host.id}:${tunnelId}:${rule.id}`,
            `[TunnelTraffic] host=${host.id} tunnel=${tunnelId} rule=${rule.id}`,
            bytesIn,
            bytesOut,
            normalizeTrafficCounterConnections(stat.connections),
          );
        }
        continue;
      }
      trafficBatch.push({
        stat: {
          ruleId: stat.ruleId,
          hostId: host.id,
          bytesIn,
          bytesOut,
          connections: normalizeTrafficCounterConnections(stat.connections),
        },
        userId: Number(rule.userId),
      });
      acceptedStatCount += 1;
      acceptedBytesIn += bytesIn;
      acceptedBytesOut += bytesOut;
      const ruleBytes = bytesIn + bytesOut;
      if (ruleBytes > 0) {
        logTrafficReportSample(
          `rule:${host.id}:${rule.id}`,
          `[Traffic] host=${host.id} rule=${rule.id}`,
          bytesIn,
          bytesOut,
          normalizeTrafficCounterConnections(stat.connections),
        );
        const proxyNodeId = Number((rule as any).proxyNodeId || 0);
        if (proxyNodeId > 0) {
          // 用未乘倍率的原始字节：这是落地机实际跑的量，机房按这个算，
          // 而倍率是面板向用户计费用的，两回事。
          trafficByProxyNode.set(proxyNodeId, (trafficByProxyNode.get(proxyNodeId) || 0) + ruleBytes);
        }
        const billingResource = billingResourcesByRuleId.get(Number(rule.id));
        if (billingResource?.config) {
          billingEntries.push({ rule, ruleBytes, billingResource });
        } else {
          const quotaBytes = applyTrafficMultiplier(ruleBytes, quotaTrafficMultiplierForRule(rule, tunnel, group));
          quotaTrafficByUser.set(rule.userId, (quotaTrafficByUser.get(rule.userId) || 0) + quotaBytes);
        }
      }
    }

    await db.insertTrafficStatsBatch(trafficBatch);
    // 不再按「有流量」把规则记成运行中：改完规则后 isRunning=false 表示「待重新下发」，
    // 这时旧配置照样有流量，记回 true 会让心跳以为新配置已经生效、不再下发。运行状态只认
    // Agent 的下发回执（/status，带重试）和心跳按本机监听做的恢复。
    await db.addProxyNodeTraffic(trafficByProxyNode);
    await db.addProxyInboundTraffic(trafficByProxyInbound);

    // 一次上报里同一个人的多条计费规则只处理一次余额不足。
    const shortfallUserIds = new Set<number>();
    // 同一次上报里同一个人只读一次用户行：一台机器上几十条计费规则往往属于同一个人，
    // 原来每条都 getUserById 一次。这些用户的行已在本事务开头锁住，其间只有下面的
    // 计费会改余额 —— 扣费后把返回的余额写回这份缓存，后面几条读到的与重新查询一致。
    const billingUserById = new Map<number, Awaited<ReturnType<typeof db.getUserById>>>();
    const getBillingUser = async (userId: number) => {
      if (!billingUserById.has(userId)) billingUserById.set(userId, await db.getUserById(userId));
      return billingUserById.get(userId);
    };
    for (const { rule, ruleBytes, billingResource } of billingEntries) {
      strictTrafficAccounting = true;
      const user = await getBillingUser(Number(rule.userId));
      if (String((user as any)?.role || "") === "admin") {
        // 管理员用自己的资源不计费，也不会因为余额为 0 被停转发；流量照常记进配额统计。
        const context = contextsByRuleId.get(Number(rule.id)) as any;
        const quotaBytes = applyTrafficMultiplier(ruleBytes, quotaTrafficMultiplierForRule(rule, context?.tunnel, context?.group));
        quotaTrafficByUser.set(rule.userId, (quotaTrafficByUser.get(rule.userId) || 0) + quotaBytes);
        continue;
      }
      // 已经跑出来的流量先照常计费（余额可以扣成负数），再看要不要停。以前余额为 0 时
      // 这段流量直接丢掉：既不扣费也不计配额，规则被停后再手动打开就能白跑一段。
      // 计费开关、计费配置都是本事务里刚读过的，用户行也已在开头 lockTrafficBillingUserRows
      // 锁过（billingEntries 只来自 isAccountingHostFor 通过的规则，其主人都在 accountingUserIds 里）。
      const billed = await db.billTrafficUsage({
        userId: Number(rule.userId),
        ruleId: Number(rule.id),
        bytes: ruleBytes,
        resourceType: billingResource.resourceType,
        resourceId: billingResource.resourceId,
      }, {
        config: billingResource.config,
        billingEnabled: trafficBillingEnabled,
        alreadyLocked: accountingUserIds.includes(Number(rule.userId)),
      });
      if (billed && user) billingUserById.set(Number(rule.userId), { ...user, balanceCents: Number(billed.balanceAfterCents) } as any);
      const balanceAfterCents = billed ? Number(billed.balanceAfterCents) : Number((user as any)?.balanceCents || 0);
      if (user && balanceAfterCents <= 0 && !shortfallUserIds.has(Number(rule.userId))) {
        shortfallUserIds.add(Number(rule.userId));
        console.warn(`[TrafficBilling] user=${rule.userId} balance ${balanceAfterCents < 0 ? "negative" : "unavailable"}, stopping traffic-billed rules`);
        const shortfall = await handleTrafficBillingShortfall(Number(rule.userId), balanceAfterCents < 0 ? "balance-negative" : "balance-unavailable");
        if (shortfall.accountPaused) await refreshUserRuleAgents(rule.userId, "traffic-billing-balance-unavailable");
      }
    }

    // 累加用户已用流量
    await mapWithConcurrency(Array.from(quotaTrafficByUser.entries()), 8, async ([userId, totalBytes]) => {
      if (totalBytes <= 0) return;
      const user = await db.addUserTraffic(userId, totalBytes);

      // 检查用户流量配额
      if (user) {
        if (Number(user.trafficLimit || 0) > 0) strictTrafficAccounting = true;
        // 流量超额：自动禁用该用户所有规则
        if (user.trafficLimit > 0 && user.trafficUsed >= user.trafficLimit) {
          console.log(`[Traffic] User ${user.id} traffic exceeded limit, disabling rules`);
          await db.setUserForwardAccess(user.id, false, "traffic_limit");
          await refreshUserRuleAgents(user.id, "traffic-limit-exceeded");
        }
        // 账户到期：自动禁用该用户所有规则
        if (user.expiresAt && new Date(user.expiresAt) <= new Date()) {
          console.log(`[Traffic] User ${user.id} account expired, disabling rules`);
          await db.setUserForwardAccess(user.id, false, "expired");
          await refreshUserRuleAgents(user.id, "user-expired");
        }
      }
    });
    }));

    if (duplicateTrafficReport) {
      logTrafficReportSummary({
        hostId: logHostId,
        hostName: logHostName,
        reported: reportedStatCount,
        accepted: 0,
        routedAway: 0,
        ignored: 0,
        bytesIn: 0,
        bytesOut: 0,
        duplicate: true,
        durationMs: Date.now() - requestStartedAt,
      });
      res.json({ success: true, duplicate: true });
      return;
    }

    const durationMs = Date.now() - requestStartedAt;
    logTrafficReportSummary({
      hostId: logHostId,
      hostName: logHostName,
      reported: reportedStatCount,
      accepted: acceptedStatCount,
      routedAway: routedAwayStatCount,
      ignored: ignoredStatCount,
      bytesIn: acceptedBytesIn,
      bytesOut: acceptedBytesOut,
      hostBytesIn: hostTraffic ? Number(hostTraffic.bytesIn) || 0 : undefined,
      hostBytesOut: hostTraffic ? Number(hostTraffic.bytesOut) || 0 : undefined,
      durationMs,
    });
    if (durationMs >= 2_000 && shouldLogReport(`traffic-slow:${logHostId}`, 60_000)) {
      console.warn(`[Agent Traffic] slow host=${logHostId} name=${logHostName || "-"} stats=${reportedStatCount} duration=${durationMs}ms`);
    }

    res.json({
      success: true,
      trafficReportInterval: selectAgentTrafficReportInterval({
        metricsWatching: isHostMetricsWatching(Number(host.id)),
        strictAccounting: strictTrafficAccounting,
      }),
    });
  } catch (error) {
    console.error(`[Agent Traffic] Error host=${logHostId || "-"} name=${logHostName || "-"}:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent TCPing 上报接口
agentRouter.post("/api/agent/tcping", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const parsedResults: AgentTcpingResult[] = Array.isArray(req.body?.results)
      ? req.body.results.filter(isAgentTcpingResult)
      : [];
    const rawTunnelResults = Array.isArray(req.body?.tunnels)
      ? req.body.tunnels
      : (Array.isArray(req.body?.tunnelResults) ? req.body.tunnelResults : []);
    const parsedTunnelResults: AgentTunnelTcpingResult[] = rawTunnelResults.filter(isAgentTunnelTcpingResult);
    const rawForwardGroupResults = Array.isArray(req.body?.forwardGroups)
      ? req.body.forwardGroups
      : (Array.isArray(req.body?.forwardGroupResults) ? req.body.forwardGroupResults : []);
    const parsedForwardGroupResults: AgentForwardGroupLatencyResult[] = rawForwardGroupResults.filter(isAgentForwardGroupLatencyResult);
    const rawServiceResults = Array.isArray(req.body?.services)
      ? req.body.services
      : (Array.isArray(req.body?.serviceResults) ? req.body.serviceResults : []);
    const parsedServiceResults: AgentHostProbeServiceResult[] = rawServiceResults.filter(isAgentHostProbeServiceResult);
    // Normalize the optional counters once at the ingress boundary.  This
    // keeps old Agents (which omit them) compatible while preserving partial
    // packet loss reported by newer Agents through every persistence path.
    for (const report of [
      ...parsedResults,
      ...parsedTunnelResults,
      ...parsedForwardGroupResults,
      ...parsedServiceResults,
    ]) {
      const probeCounts = normalizeAgentProbeCounts(report, { legacyZeroAsSuccess: false });
      Object.assign(report, probeCounts);
      // Keep the legacy boolean and packet counters coherent at the trust
      // boundary. Packet counters are authoritative: a partially successful
      // probe is reachable, while a report with zero successful packets is a
      // timeout even if an Agent used an inconsistent legacy boolean.
      report.isTimeout = probeCounts.probeSuccesses <= 0;
    }
    if (parsedResults.length === 0 && parsedTunnelResults.length === 0 && parsedForwardGroupResults.length === 0 && parsedServiceResults.length === 0) {
      res.status(400).json({ error: "results, tunnels, forwardGroups or services array is required" });
      return;
    }
    const force = req.body?.force === true;
    const topologyGatePlan = agentTcpingReportGate.plan({
      hostId: Number(host.id),
      force,
      gateRules: false,
      results: parsedResults,
      tunnels: parsedTunnelResults,
      forwardGroups: parsedForwardGroupResults,
      services: parsedServiceResults,
    });
    const {
      results,
      tunnels: tunnelResults,
      forwardGroups: forwardGroupResults,
      services: serviceResults,
    } = topologyGatePlan;
    if (results.length === 0 && tunnelResults.length === 0 && forwardGroupResults.length === 0 && serviceResults.length === 0) {
      res.json({ success: true });
      return;
    }
    logTcpingReportSummary(host.id, results, tunnelResults, forwardGroupResults, serviceResults);

    const tunnelResultsById = new Map<number, AgentTunnelTcpingResult[]>();
    for (const report of tunnelResults) {
      const tunnelId = Number(report.tunnelId || 0);
      if (tunnelId <= 0) continue;
      const rows = tunnelResultsById.get(tunnelId) || [];
      rows.push(report);
      tunnelResultsById.set(tunnelId, rows);
    }
    const entryGroupMemo: EntryGroupMemo = new Map();
    await mapWithConcurrency(Array.from(tunnelResultsById.entries()), 12, async ([tunnelId, reports]) => withKeyedTaskLock(`tunnel-latency:${tunnelId}`, async () => {
      const [tunnel, hops, exitNodes] = await Promise.all([
        db.getTunnelById(tunnelId),
        db.getTunnelHops(tunnelId),
        db.getTunnelExitNodes(tunnelId),
      ]) as [any, any[], any[]];
      if (!tunnel) return;
      const entryHostIds = await tunnelEntryHostIds(tunnel, entryGroupMemo);
      const topologyKey = tunnelProbeTopologyKey(tunnel, hops, exitNodes);
      const orderedEntryHostIds = Array.from(entryHostIds).sort((left, right) => left - right);
      const multiEntry = orderedEntryHostIds.length > 1;
      const multiEntryGeneration = `${topologyKey}:entries:${orderedEntryHostIds.join(",")}`;
      const relayFailover = isTunnelRelayFailover(tunnel, hops);
      const relayCandidateCount = relayFailover ? tunnelRelayCandidates(hops).length : 0;
      const branchByKey = new Map<string, { key: string; label: string; latencyMs: number | null; isTimeout: boolean; probeCount?: number; probeSuccesses?: number }>();
      for (const report of reports) {
        if (!await validateTunnelProbeSource(Number(host.id), tunnel, report, { hops, exitNodes, entryHostIds, topologyKey })) continue;
        const latencyValue = typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null;
        const isTimeout = !!report.isTimeout || latencyValue === null;
        const seriesKey = cleanTunnelSeriesKey(report.seriesKey);
        const hopIndex = Number(report.hopIndex);
        const hopCount = Number(report.hopCount);
        const hasHop = Number.isInteger(hopIndex) && Number.isInteger(hopCount) && hopCount > 0;
        if (multiEntry) {
          const aggregate = recordTunnelMultiEntryLatency({
            tunnelId,
            sourceHostId: Number(host.id),
            sourceLabel: String((host as any).name || `入口 ${host.id}`),
            expectedEntryHostIds: orderedEntryHostIds,
            hopIndex: hasHop ? hopIndex : 0,
            hopCount: hasHop ? hopCount : 1,
            latencyMs: latencyValue,
            isTimeout,
            probeCount: report.probeCount,
            probeSuccesses: report.probeSuccesses,
            generation: multiEntryGeneration,
            pathKey: seriesKey || "default",
            toHostId: tunnelProbeTargetHostId(tunnel, hops, exitNodes, report, seriesKey),
          });
          if (!aggregate) continue;
          const recordedAt = new Date();
          await mapWithConcurrency(aggregate.details, 4, async (detail) => {
            const detailSeriesKey = cleanTunnelSeriesKey(`entry-${detail.hostId}${seriesKey ? `-${seriesKey}` : ""}`);
            const branchLabel = seriesKey ? cleanTunnelSeriesLabel(report.seriesLabel, seriesKey) : "";
            await db.insertTunnelLatencyStat({
              tunnelId,
              latencyMs: detail.isTimeout ? null : detail.latencyMs,
              isTimeout: detail.isTimeout,
              probeCount: detail.probeCount ?? 1,
              probeSuccesses: detail.probeSuccesses ?? (detail.isTimeout ? 0 : 1),
              seriesKey: detailSeriesKey,
              seriesLabel: cleanTunnelSeriesLabel(
                branchLabel ? `${detail.label} / ${branchLabel}` : detail.label,
                `入口 ${detail.hostId}`,
              ),
              recordedAt,
            }, { preserveMessage: true, updateTunnel: false });
          });
          if (seriesKey) {
            const label = cleanTunnelSeriesLabel(report.seriesLabel, seriesKey === "primary" ? "主出口" : seriesKey);
            branchByKey.set(seriesKey, {
              key: seriesKey,
              label,
              latencyMs: aggregate.success ? aggregate.latencyMs : null,
              isTimeout: !aggregate.success,
              probeCount: aggregate.probeCount ?? 1,
              probeSuccesses: aggregate.probeSuccesses ?? (aggregate.success ? 1 : 0),
            });
            continue;
          }
          await db.insertTunnelLatencyStat({
            tunnelId,
            latencyMs: aggregate.success ? aggregate.latencyMs : null,
            isTimeout: !aggregate.success,
            probeCount: aggregate.probeCount ?? 1,
            probeSuccesses: aggregate.probeSuccesses ?? (aggregate.success ? 1 : 0),
            seriesKey: "total",
            seriesLabel: aggregate.partial ? "可用入口最大延迟" : "多入口最大延迟",
            recordedAt,
          }, { preserveMessage: true });
          if (aggregate.success && !tunnel.isRunning) {
            await db.updateTunnelRunningStatus(tunnelId, true);
            tunnel.isRunning = true;
          }
          continue;
        }
        if (relayFailover && seriesKey && /^relay-\d+$/.test(seriesKey)) {
          recordTunnelAutoHopLatency({
            tunnelId,
            hopIndex: Number(report.hopIndex),
            hopCount: 2,
            latencyMs: latencyValue,
            isTimeout,
            probeCount: report.probeCount,
            probeSuccesses: report.probeSuccesses,
            generation: topologyKey,
            pathKey: seriesKey,
            allowEarlyFailure: true,
            fromHostId: Number(host.id),
            toHostId: tunnelProbeTargetHostId(tunnel, hops, exitNodes, report, seriesKey),
          });
          continue;
        }
        if (seriesKey) {
          recordTunnelAutoHopLatency({
            tunnelId,
            hopIndex: hasHop ? hopIndex : 0,
            hopCount: hasHop ? hopCount : 1,
            latencyMs: latencyValue,
            isTimeout,
            probeCount: report.probeCount,
            probeSuccesses: report.probeSuccesses,
            generation: topologyKey,
            pathKey: seriesKey,
            fromHostId: Number(host.id),
            toHostId: tunnelProbeTargetHostId(tunnel, hops, exitNodes, report, seriesKey),
          });
          const label = cleanTunnelSeriesLabel(report.seriesLabel, seriesKey === "primary" ? "主出口" : seriesKey);
          branchByKey.set(seriesKey, {
            key: seriesKey,
            label,
            latencyMs: latencyValue,
            isTimeout,
            probeCount: Number(report.probeCount) || 1,
            probeSuccesses: Number(report.probeSuccesses) || 0,
          });
          continue;
        }
        if (hasHop) {
          const aggregate = recordTunnelAutoHopLatency({
            tunnelId,
            hopIndex,
            hopCount,
            latencyMs: latencyValue,
            isTimeout,
            probeCount: report.probeCount,
            probeSuccesses: report.probeSuccesses,
            generation: topologyKey,
            fromHostId: Number(host.id),
            toHostId: tunnelProbeTargetHostId(tunnel, hops, exitNodes, report, seriesKey),
          });
          if (!aggregate) continue;
          await db.insertTunnelLatencyStat({
            tunnelId,
            latencyMs: aggregate.success ? aggregate.latencyMs : null,
            isTimeout: !aggregate.success,
            probeCount: aggregate.probeCount ?? 1,
            probeSuccesses: aggregate.probeSuccesses ?? (aggregate.success ? 1 : 0),
            seriesKey: "total",
            seriesLabel: "总延迟",
          }, { preserveMessage: true });
          if (aggregate.success && !tunnel.isRunning) {
            await db.updateTunnelRunningStatus(tunnelId, true);
            tunnel.isRunning = true;
          }
          continue;
        }
        await db.insertTunnelLatencyStat({
          tunnelId,
          latencyMs: latencyValue,
          isTimeout,
          probeCount: Number(report.probeCount) || 1,
          probeSuccesses: Number(report.probeSuccesses) || 0,
          seriesKey: "total",
          seriesLabel: "总延迟",
        }, { preserveMessage: true });
        if (!isTimeout && !tunnel.isRunning) {
          await db.updateTunnelRunningStatus(tunnelId, true);
          tunnel.isRunning = true;
        }
      }

      if (relayFailover) {
        const aggregates = Array.from({ length: relayCandidateCount }, (_, index) => {
          const key = `relay-${index + 1}`;
          return {
            key,
            label: `中转 ${index + 1}`,
            aggregate: multiEntry
              ? getTunnelMultiEntryLatency({
                tunnelId,
                expectedEntryHostIds: orderedEntryHostIds,
                hopCount: 2,
                generation: multiEntryGeneration,
                pathKey: key,
              })
              : getTunnelAutoHopAggregate(tunnelId, 2, topologyKey, key, true),
          };
        });
        const readyAggregates = readyTunnelRelayAggregates(aggregates);
        if (readyAggregates.length > 0) {
          for (const item of readyAggregates) {
            branchByKey.set(item.key, {
              key: item.key,
              label: item.label,
              latencyMs: item.aggregate.success ? item.aggregate.latencyMs : null,
              isTimeout: !item.aggregate.success,
              probeCount: item.aggregate.probeCount ?? 1,
              probeSuccesses: item.aggregate.probeSuccesses ?? (item.aggregate.success ? 1 : 0),
            });
          }
        }
      }

      const branches = Array.from(branchByKey.values());
      if (branches.length === 0) return;
      const recordedAt = new Date();
      await mapWithConcurrency(branches, 4, async (branch) => {
        await db.insertTunnelLatencyStat({
          tunnelId,
          latencyMs: branch.isTimeout ? null : branch.latencyMs,
          isTimeout: branch.isTimeout,
          probeCount: branch.probeCount || 1,
          probeSuccesses: branch.probeSuccesses ?? (branch.isTimeout ? 0 : 1),
          seriesKey: branch.key,
          seriesLabel: branch.label,
          recordedAt,
        }, { preserveMessage: true, updateTunnel: false });
      });
      const summary = summarizeTunnelBranches(branches);
      await db.insertTunnelLatencyStat({
        tunnelId,
        latencyMs: summary.latencyMs,
        isTimeout: summary.unavailable,
        probeCount: summary.probeCount ?? 1,
        probeSuccesses: summary.probeSuccesses ?? (summary.unavailable ? 0 : 1),
        seriesKey: "total",
        seriesLabel: summary.partial ? "可用出口最大延迟" : "最大延迟",
        recordedAt,
      }, { preserveMessage: true });
      if (!summary.unavailable && !tunnel.isRunning) await db.updateTunnelRunningStatus(tunnelId, true);
    }));
    const needsForwardGroupHealthTopology = forwardGroupResults.some((report) => {
      const type = String(report.probeType || "");
      return type === "china" || type === "entry";
    });
    const healthTopology = needsForwardGroupHealthTopology
      ? await db.getForwardGroupProbeTopologyForHost(Number(host.id)) as any
      : { chinaHealthProbes: [], entryHealthProbes: [] };
    const chinaExpected = healthTopology.chinaHealthProbes || [];
    const chinaExpectedByKey = new Map(chinaExpected.map((probe: any) => [
      `${Number(probe.groupId)}:${Number(probe.memberId)}`,
      probe,
    ]));
    const entryExpectedByKey = new Map((healthTopology.entryHealthProbes || []).map((probe: any) => [
      `${Number(probe.groupId)}:${Number(probe.memberId)}`,
      probe,
    ]));
    const forwardGroupResultsById = new Map<number, AgentForwardGroupLatencyResult[]>();
    for (const report of forwardGroupResults) {
      const groupId = Number(report.groupId || 0);
      if (groupId <= 0) continue;
      const rows = forwardGroupResultsById.get(groupId) || [];
      rows.push(report);
      forwardGroupResultsById.set(groupId, rows);
    }
    await mapWithConcurrency(Array.from(forwardGroupResultsById.entries()), 12, async ([groupId, reports]) => {
      const group = await db.getForwardGroupById(groupId) as any;
      if (!group?.isEnabled) return;
      const chainProbes = String(group.groupMode || "failover") === "chain"
        ? await db.getForwardGroupChainProbes(groupId)
        : [];
      const topologyKey = forwardGroupProbeTopologyKey(groupId, chainProbes);
      for (const report of reports) {
        if (String(report.probeType || "") === "china") {
          const expected = chinaExpectedByKey.get(`${groupId}:${Number(report.memberId || 0)}`) as any;
          if (!expected) continue;
          if (report.targetIp && !sameProbeTarget(report.targetIp, expected.targetIp)) continue;
          if (report.targetPort && Number(report.targetPort) !== Number(expected.targetPort)) continue;
          await db.updateForwardGroupMemberChinaHealth({
            groupId,
            memberId: Number(report.memberId || 0),
            hostId: Number(host.id),
            latencyMs: typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null,
            isTimeout: !!report.isTimeout,
            healthStatus: report.healthStatus,
          });
          continue;
        }
        if (String(report.probeType || "") === "entry") {
          const expected = entryExpectedByKey.get(`${groupId}:${Number(report.memberId || 0)}`) as any;
          if (!expected || report.healthStatus === undefined) continue;
          await db.updateForwardGroupMemberAgentHealth({
            groupId,
            memberId: Number(report.memberId || 0),
            hostId: Number(host.id),
            healthStatus: report.healthStatus,
          });
          continue;
        }
        if (String(group.groupMode || "failover") !== "chain") continue;
        if (report.topologyKey && report.topologyKey !== topologyKey) continue;
        const hopIndex = Number(report.hopIndex);
        const hopCount = Number(report.hopCount);
        if (!Number.isInteger(hopIndex) || !Number.isInteger(hopCount) || hopCount <= 0) continue;
        const expected = (chainProbes as any[]).find((probe: any) => (
          Number(probe.fromHostId) === Number(host.id)
          && Number(probe.hopIndex) === hopIndex
          && Number(probe.hopCount) === hopCount
          && (!report.targetIp || sameProbeTarget(report.targetIp, probe.targetIp))
          && (!report.targetPort || Number(report.targetPort) === Number(probe.targetPort))
        ));
        if (!expected) continue;
        const aggregate = recordForwardGroupAutoHopLatency({
          groupId,
          hopIndex,
          hopCount,
          latencyMs: typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null,
          isTimeout: !!report.isTimeout,
          probeCount: report.probeCount,
          probeSuccesses: report.probeSuccesses,
          generation: topologyKey,
        });
        if (!aggregate) continue;
        await db.insertForwardGroupLatencyStat({
          groupId,
          latencyMs: aggregate.success ? aggregate.latencyMs : null,
          isTimeout: !aggregate.success,
          probeCount: aggregate.probeCount ?? 1,
          probeSuccesses: aggregate.probeSuccesses ?? (aggregate.success ? 1 : 0),
        });
      }
    });

    const expectedServices = serviceResults.length > 0 ? await db.getHostProbeTasksForHost(Number(host.id)) as any[] : [];
    const expectedServiceById = new Map(expectedServices.map((service: any) => [Number(service.serviceId), service]));
    const serviceStats = serviceResults.flatMap((report) => {
      const serviceId = Number(report.serviceId || 0);
      const expected = expectedServiceById.get(serviceId) as any;
      if (!expected) return [];
      if (report.targetIp && !sameProbeTarget(report.targetIp, expected.targetIp)) return [];
      if (report.targetPort && Number(report.targetPort) !== Number(expected.targetPort || 0)) return [];
      return [{
        serviceId,
        hostId: host.id,
        latencyMs: typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null,
        isTimeout: !!report.isTimeout,
        probeCount: Number(report.probeCount) || 1,
        probeSuccesses: Number(report.probeSuccesses) || 0,
      }];
    });
    if (serviceStats.length > 0) {
      await db.insertHostProbeServiceStats(serviceStats);
    }

    const reportedRuleRows = await db.getForwardRulesByIds(results.map((report) => Number(report.ruleId || 0))) as any[];
    const reportedRuleById = new Map(reportedRuleRows.map((rule: any) => [Number(rule.id), rule]));
    // 线路组的中转跳：中继规则的探测结果就是「这一跳通不通」，见 server/routeGroups.ts。
    await ingestRouteHopProbeReports({
      hostId: Number(host.id),
      hostName: String((host as any).name || ""),
      results,
      rulesById: reportedRuleById,
    }).catch((error) => {
      console.warn(`[Agent TCPing] route hop probes host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
    const tunnelLatencyById = new Map<number, Promise<any>>();
    const tunnelContextById = new Map<number, Promise<{ tunnel: any } | null>>();
    const getTunnelContext = (tunnelId: number) => {
      let work = tunnelContextById.get(tunnelId);
      if (!work) {
        work = (async () => {
          const tunnel = await db.getTunnelById(tunnelId) as any;
          if (!tunnel) return null;
          return { tunnel };
        })();
        tunnelContextById.set(tunnelId, work);
      }
      return work;
    };
    const getLatestTunnelLatency = (tunnelId: number) => {
      let work = tunnelLatencyById.get(tunnelId);
      if (!work) {
        work = db.getLatestTunnelLatency(tunnelId);
        tunnelLatencyById.set(tunnelId, work);
      }
      return work;
    };
    const ruleStats = await mapWithConcurrency(results, 16, async (report) => {
      const ruleId = Number(report.ruleId);
      if (ruleId <= 0) return null;
      const rule = reportedRuleById.get(ruleId) as any;
      if (!rule || rule.pendingDelete || !rule.isEnabled) return null;
      const tunnelId = Number(rule.tunnelId || 0);
      const baseLatency = typeof report.latencyMs === "number" && Number.isFinite(report.latencyMs) && report.latencyMs >= 0
        ? Number(report.latencyMs)
        : null;
      if (tunnelId <= 0) {
        if (Number(rule.hostId || 0) !== Number(host.id)) return null;
        if (report.sourcePort && Number(report.sourcePort) !== Number(rule.sourcePort || 0)) return null;
        if (report.targetPort && Number(report.targetPort) !== Number(rule.targetPort || 0)) return null;
        if (!isRuleLatencyReportMethodCompatible(rule.protocol, report.method)) return null;
        const isTimeout = !!report.isTimeout || baseLatency === null;
        const latencyMs = isTimeout ? null : baseLatency;
        return {
          stat: {
            ruleId,
            hostId: host.id,
            latencyMs,
            isTimeout,
            probeCount: Number(report.probeCount) || 1,
            probeSuccesses: Number(report.probeSuccesses) || 0,
            healthStatus: report.healthStatus || null,
            healthPending: !!report.healthPending,
          },
          gateReport: { ...report, latencyMs, isTimeout },
        };
      }

      const tunnelContext = await getTunnelContext(tunnelId);
      if (!tunnelContext || !validateTunnelRuleLatencyReport({
        hostId: host.id,
        rule,
        tunnel: tunnelContext.tunnel,
        report,
      })) return null;
      const latestTunnelLatency = report.isTimeout ? null : await getLatestTunnelLatency(tunnelId);
      const combined = combineTunnelRuleLatencySample({
        targetLatencyMs: baseLatency,
        targetIsTimeout: !!report.isTimeout,
        tunnelLatencyMs: latestTunnelLatency?.latencyMs,
        tunnelIsTimeout: !!latestTunnelLatency?.isTimeout,
        tunnelRecordedAt: latestTunnelLatency?.recordedAt,
      });
      if (!combined) return null;
      const tunnelIntroducedTimeout = combined.isTimeout && !report.isTimeout;
      // Compose target and tunnel counters. If the tunnel path timed out,
      // no end-to-end packet can be considered successful; otherwise retain
      // the lower success ratio from either segment.
      const composedProbeCounts = combineTunnelRuleProbeCounts({
        target: report,
        tunnel: latestTunnelLatency,
        combinedIsTimeout: combined.isTimeout,
      });
      return {
        stat: {
          ruleId,
          hostId: host.id,
          latencyMs: combined.latencyMs,
          isTimeout: combined.isTimeout,
          probeCount: composedProbeCounts.probeCount,
          probeSuccesses: composedProbeCounts.probeSuccesses,
          healthStatus: tunnelIntroducedTimeout ? null : report.healthStatus || null,
          healthPending: tunnelIntroducedTimeout ? false : !!report.healthPending,
        },
        gateReport: {
          ...report,
          tunnelId,
          latencyMs: combined.latencyMs,
          isTimeout: combined.isTimeout,
        },
      };
    });
    const validRuleStats = ruleStats.filter((entry): entry is NonNullable<typeof entry> => !!entry);
    const ruleGatePlan = agentTcpingReportGate.plan({
      hostId: Number(host.id),
      force,
      results: validRuleStats.map((entry) => entry.gateReport),
      tunnels: [],
      forwardGroups: [],
      services: [],
    });
    const acceptedRuleIds = new Set(ruleGatePlan.results.map((report) => Number(report.ruleId)));
    const stats = validRuleStats
      .filter((entry) => acceptedRuleIds.has(Number(entry.stat.ruleId)))
      .map((entry) => entry.stat);

    if (stats.length > 0) {
      await db.insertTcpingStats(stats);
      clearRuleLatencyQueryCache();
      db.scheduleForwardGroupFailover(Array.from(new Set(stats
        .filter((stat) => ruleGatePlan.transitionRuleIds.has(Number(stat.ruleId)))
        .map((stat) => Number(reportedRuleById.get(stat.ruleId)?.forwardGroupId || 0))
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0))));
    }

    topologyGatePlan.commit();
    ruleGatePlan.commit();
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent TCPing] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

}
