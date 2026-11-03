import { appendPanelLog } from "./_core/panelLogger";
import { setBoundedMapValue } from "./boundedCache";
import {
  AGENT_HOST_CACHE_MAX,
  agentHeartbeatSummaryLogCache,
  agentRuntimeDriftLogCache,
  mimicRuntimeLogCache,
} from "./agentHeartbeatState";

/*
  心跳的日志节流：每台主机隔一段时间才写一条摘要、mimic 计划和运行态漂移的日志也按间隔写。
  从 server/agentHeartbeatRoute.ts 里原样搬出来，行为不变。
*/

const AGENT_HEARTBEAT_SUMMARY_LOG_INTERVAL_MS = 5 * 60 * 1000;

const MIMIC_RUNTIME_PLAN_LOG_INTERVAL_MS = 5 * 60 * 1000;
const AGENT_RUNTIME_DRIFT_LOG_INTERVAL_MS = 5 * 60 * 1000;

export function logAgentHeartbeatSummary(input: {
  hostId: number;
  hostName?: string;
  expectedRules: number;
  reportedRules: number;
  reportedServices: number;
  actions: number;
  pendingApply: number;
  pendingRemove: number;
  recoveryPending: boolean;
  requestLocalState: boolean;
  coalesced?: boolean;
  stable: boolean;
  runtimeDrift?: number;
  metricsWatching?: boolean;
  nextInterval?: number;
  interactiveTasks?: number;
}) {
  const hostId = Number(input.hostId);
  if (!Number.isFinite(hostId) || hostId <= 0) return;
  const now = Date.now();
  const last = agentHeartbeatSummaryLogCache.get(hostId) || 0;
  if (last > 0 && now - last < AGENT_HEARTBEAT_SUMMARY_LOG_INTERVAL_MS) return;
  setBoundedMapValue(agentHeartbeatSummaryLogCache, hostId, now, AGENT_HOST_CACHE_MAX);
  const name = String(input.hostName || "-")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 96) || "-";
  const safeCount = (value: unknown) => {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  };
  const pending = safeCount(input.pendingApply) + safeCount(input.pendingRemove);
  const status = input.coalesced
    ? "reconciliation-coalesced"
    : input.requestLocalState
      ? "local-state-requested"
      : input.recoveryPending
        ? "recovery-pending"
        : input.stable
          ? "stable"
          : pending > 0
            ? "actions-pending"
            : "reconciling";
  appendPanelLog(
    "info",
    `[AgentHeartbeat] summary host=${hostId} name=${name} status=${status}`
      + ` expectedRules=${safeCount(input.expectedRules)}`
      + ` reportedRules=${safeCount(input.reportedRules)}`
      + ` reportedServices=${safeCount(input.reportedServices)}`
      + ` actions=${safeCount(input.actions)}`
      + ` pendingApply=${safeCount(input.pendingApply)}`
      + ` pendingRemove=${safeCount(input.pendingRemove)}`
      + ` drift=${safeCount(input.runtimeDrift)}`
      + ` metricsWatching=${input.metricsWatching === true}`
      + ` interactiveTasks=${safeCount(input.interactiveTasks)}`
      + (Number.isFinite(Number(input.nextInterval)) ? ` nextInterval=${safeCount(input.nextInterval)}` : "")
      + ` recoveryPending=${input.recoveryPending}`
      + ` requestLocalState=${input.requestLocalState}`,
  );
}

export function compactMimicFiltersForLog(filters: string[]) {
  const items = filters.map((item) => String(item || "").trim()).filter(Boolean).sort();
  if (items.length <= 6) return items.join(",");
  return `${items.slice(0, 6).join(",")},+${items.length - 6}`;
}

export function shouldLogMimicRuntimePlan(hostId: number, signature: string) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0 || !signature) return false;
  const now = Date.now();
  const cached = mimicRuntimeLogCache.get(id);
  if (!cached || cached.signature !== signature || now - cached.loggedAt >= MIMIC_RUNTIME_PLAN_LOG_INTERVAL_MS) {
    setBoundedMapValue(mimicRuntimeLogCache, id, { signature, loggedAt: now }, AGENT_HOST_CACHE_MAX);
    return true;
  }
  return false;
}

export function shouldLogAgentRuntimeDrift(hostId: number, ruleId: number) {
  const key = `${hostId}:${ruleId}`;
  const now = Date.now();
  const last = agentRuntimeDriftLogCache.get(key) || 0;
  if (now - last < AGENT_RUNTIME_DRIFT_LOG_INTERVAL_MS) return false;
  setBoundedMapValue(agentRuntimeDriftLogCache, key, now, 5_000);
  if (agentRuntimeDriftLogCache.size > 5000) {
    for (const [cachedKey, loggedAt] of agentRuntimeDriftLogCache) {
      if (now - loggedAt > AGENT_RUNTIME_DRIFT_LOG_INTERVAL_MS * 2) agentRuntimeDriftLogCache.delete(cachedKey);
    }
  }
  return true;
}
