/*
  概览「出口质量」的面板侧（Agent 扩展模块 "sitelatency"，Agent 2.2.237 起；Go 端
  agent/ext_sitelatency.go，站点表和样本形状在 shared/siteLatency.ts）。

  样本只放内存：每台主机每个站点最近 60 个（两小时）。不落库 —— 走势只看最近两小时，面板
  重启后第一轮指令带 since=0，Agent 把它手里的两小时整段交过来，不用等两小时攒。
  注册在 siteLatencyAgent.ts（只由 agentExtModules.ts 引入）。
*/
import { isAgentVersionAtLeast } from "../../shared/version";
import {
  mergeSiteSamples,
  normalizeSiteLatencyReport,
  SITE_LATENCY_AGENT_VERSION,
  SITE_LATENCY_INTERVAL_SECONDS,
  SITE_LATENCY_TARGETS,
  type SiteLatencySample,
} from "../../shared/siteLatency";
import type { AgentExtHost } from "./agentExt";

const store = new Map<number, Map<string, SiteLatencySample[]>>();

export function hostSupportsSiteLatency(host: { agentVersion?: string | null } | null | undefined) {
  return !!host && isAgentVersionAtLeast(String(host.agentVersion || "").replace(/^v/i, ""), SITE_LATENCY_AGENT_VERSION);
}

/** 面板手里这台主机最新一个样本的时刻（Unix 毫秒）；Agent 只补比它新的。 */
export function siteLatencySince(hostId: number) {
  let latest = 0;
  for (const samples of store.get(Number(hostId))?.values() || []) {
    const last = samples[samples.length - 1];
    if (last && last.at > latest) latest = last.at;
  }
  return latest;
}

export function siteLatencyDirectiveFor(host: AgentExtHost) {
  if (!hostSupportsSiteLatency(host)) return undefined;
  return {
    intervalSeconds: SITE_LATENCY_INTERVAL_SECONDS,
    targets: SITE_LATENCY_TARGETS.map(({ key, host: address, port }) => ({ key, host: address, port })),
    since: siteLatencySince(Number(host.id)),
  };
}

export function ingestSiteLatencyReport(host: AgentExtHost, raw: unknown, nowMs = Date.now()) {
  const report = normalizeSiteLatencyReport(raw);
  if (report.size === 0) return 0;
  const hostId = Number(host.id);
  const byKey = store.get(hostId) || new Map<string, SiteLatencySample[]>();
  let added = 0;
  for (const [key, samples] of report) {
    const before = byKey.get(key) || [];
    const merged = mergeSiteSamples(before, samples, nowMs);
    added += Math.max(0, merged.length - before.length);
    byKey.set(key, merged);
  }
  store.set(hostId, byKey);
  return added;
}

export function getSiteLatencySamples(hostId: number): Map<string, SiteLatencySample[]> {
  return store.get(Number(hostId)) || new Map();
}

export function resetSiteLatencyForTest() {
  store.clear();
}
