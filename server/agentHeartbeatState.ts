import { agentStableHeartbeatPlanCache } from "./agentHeartbeatGate";
import { pruneMapEntries } from "./boundedCache";
import { agentActionIssueTracker } from "./agentStatusOrdering";
import { DnsRuntimeGenerationTracker } from "./dnsRuntimeGeneration";
import type { AgentLocalRuntimeState } from "./agentHeartbeatReport";

/*
  心跳跨请求留在内存里的状态：按主机 / 规则记的各种缓存，以及清掉它们的几个入口
  （主机删了、规则删了、定时清过期的、期望状态要重算）。每份状态只在这里有一份，别的模块 import。
  主机 / 规则删除的挂钩和十分钟一次的定时清理仍在 agentHeartbeatRoute.ts 里注册，模块加载时的先后不变。
  从 server/agentHeartbeatRoute.ts 里原样搬出来，行为不变。
*/

// DNS 解析缓存：ruleId → 主目标上次解析到的 IPv4 地址。
// 备用线路策略里的域名由 Agent 的 TCP 拨号和健康检查动态解析。
export const AGENT_DNS_RESOLVE_TTL_MS = 5 * 60 * 1000;
export const resolvedIpCache = new Map<number, { raw: string; ip: string }>();
export const resolvedIpCheckedAt = new Map<number, number>();

export const resolvedIpInflight = new Map<string, Promise<string>>();
export const tunnelRouteLogCache = new Map<string, string>();
export const nginxRuntimeLogCache = new Map<number, string>();
export const mimicRuntimeLogCache = new Map<number, { signature: string; loggedAt: number }>();
export const dnsRuntimeGenerations = new DnsRuntimeGenerationTracker();
export const agentActionBatchCache = new Map<number, { signature: string; issuedAt: number; seenAt: number }>();
export const agentDesiredStateSendCache = new Map<number, { signature: string; sentAt: number }>();
export const agentDesiredDispatchAuditHash = new Map<number, string>();
export const agentRuntimeSyncActionCache = new Map<string, { signature: string; sentAt: number }>();
export const agentPluginSyncActionCache = new Map<string, { signature: string; sentAt: number }>();
export const fxpUdpTargetSignatureCache = new Map<string, string>();
export const agentRuntimeDriftLogCache = new Map<string, number>();
export const fxpEndpointStatusCache = new Map<string, string>();
export const AGENT_HOST_CACHE_MAX = 10_000;
export const AGENT_DYNAMIC_CACHE_MAX = 20_000;
const AGENT_CACHE_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

export const agentHeartbeatSummaryLogCache = new Map<number, number>();
// 孤儿端口迟滞：hostId -> (ruleId:port:protocol -> 连续判定为孤儿的心跳次数)。
// 一个上报端口若其 ruleId 属于面板已知的本机启用规则，则该端口极可能只是运行态推导
// 的瞬时缺口（如隧道出口端口某轮未算出），必须连续多轮都判孤儿才真正下发拆除，
// 否则会与 apply 形成 apply→remove→apply 抖动死循环。
export const agentOrphanPortStreakCache = new Map<number, Map<string, number>>();
export const AGENT_ORPHAN_REMOVE_MIN_STREAK = 3;

export const agentLocalRuntimeStateCache = new Map<number, { signature: string; state: AgentLocalRuntimeState; updatedAt: number }>();

/** 主机删掉后清掉心跳里按这台主机记的缓存（见 server/entityCleanup.ts）。 */
export function forgetAgentHeartbeatHost(hostId: number) {
  const id = Number(hostId);
  for (const cache of [
    nginxRuntimeLogCache,
    mimicRuntimeLogCache,
    agentActionBatchCache,
    agentDesiredStateSendCache,
    agentDesiredDispatchAuditHash,
    agentHeartbeatSummaryLogCache,
    agentOrphanPortStreakCache,
    agentLocalRuntimeStateCache,
  ] as Map<number, unknown>[]) cache.delete(id);
  const prefix = `${id}:`;
  for (const cache of [agentRuntimeSyncActionCache, agentPluginSyncActionCache] as Map<string, unknown>[]) {
    for (const key of Array.from(cache.keys())) if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** 规则删掉后清掉它的目标域名解析缓存。 */
export function forgetAgentHeartbeatRule(ruleId: number) {
  const id = Number(ruleId);
  resolvedIpCache.delete(id);
  resolvedIpCheckedAt.delete(id);
}

export function pruneAgentHeartbeatCaches(now = Date.now()) {
  const stale = (timestamp: number) => !Number.isFinite(timestamp) || now - timestamp >= AGENT_CACHE_IDLE_TTL_MS;
  for (const [ruleId, checkedAt] of resolvedIpCheckedAt) {
    if (!stale(checkedAt)) continue;
    resolvedIpCheckedAt.delete(ruleId);
    resolvedIpCache.delete(ruleId);
  }
  pruneMapEntries(mimicRuntimeLogCache, (entry) => stale(entry.loggedAt));
  pruneMapEntries(agentActionBatchCache, (entry) => stale(entry.seenAt));
  agentActionIssueTracker.prune(now);
  pruneMapEntries(agentDesiredStateSendCache, (entry) => stale(entry.sentAt));
  pruneMapEntries(agentRuntimeSyncActionCache, (entry) => stale(entry.sentAt));
  pruneMapEntries(agentPluginSyncActionCache, (entry) => stale(entry.sentAt));
  pruneMapEntries(agentRuntimeDriftLogCache, (loggedAt) => stale(loggedAt));
  pruneMapEntries(agentHeartbeatSummaryLogCache, (loggedAt) => stale(loggedAt));
  pruneMapEntries(agentLocalRuntimeStateCache, (entry) => stale(entry.updatedAt));
}

export function invalidateAgentDesiredStateCache(
  hostId: number,
  options: { preserveLocalRuntimeState?: boolean } = {},
) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return;
  agentStableHeartbeatPlanCache.invalidate(id);
  agentActionBatchCache.delete(id);
  agentActionIssueTracker.forgetPrefix(`agent-status:${id}:`);
  agentDesiredStateSendCache.delete(id);
  if (!options.preserveLocalRuntimeState) agentLocalRuntimeStateCache.delete(id);
  for (const key of Array.from(agentRuntimeSyncActionCache.keys())) {
    if (key.startsWith(`${id}:`)) agentRuntimeSyncActionCache.delete(key);
  }
  for (const key of Array.from(agentPluginSyncActionCache.keys())) {
    if (key.startsWith(`${id}:`)) agentPluginSyncActionCache.delete(key);
  }
  agentOrphanPortStreakCache.delete(id);
}
