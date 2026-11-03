import { routeGroupOf } from "../shared/routeGroup";
import { isIP } from "net";
import { resolve4, resolve6 } from "dns/promises";
import { setBoundedMapValue } from "./boundedCache";
import {
  buildCountingCleanupCmds,
  buildIptablesForwardCleanupCmds,
  buildManagedPortCleanupCmds,
  buildNftCleanupCmds,
} from "./agentActionCommands";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import { resolveTargetIpWithTimeout, selectResolvedTargetIp } from "./dnsTargetResolution";
import {
  AGENT_DNS_RESOLVE_TTL_MS,
  AGENT_DYNAMIC_CACHE_MAX,
  resolvedIpCache,
  resolvedIpCheckedAt,
  resolvedIpInflight,
} from "./agentHeartbeatState";
import { runtimeBool } from "./agentHeartbeatRuntime";

/*
  心跳里的目标域名解析：面板自己解析、按规则缓存（缓存本身在 agentHeartbeatState.ts），
  要 Agent 盯着的域名（dnsWatch），以及 Agent 报 DNS 变了以后清理旧 IP 的命令。
  从 server/agentHeartbeatRoute.ts 里原样搬出来，行为不变。
*/

/**
 * Agent 报上来的 DNS 变化只用于这台 Agent 自己这一次的下发，不写进全面板共享的解析缓存。
 *
 * 这个缓存按规则 id 存，同一条规则的其他入口 / 跳点 / 出口（包括负载均衡的其他出口）都会
 * 复用它。以前直接把 Agent 给的 IP 写进去、还顺手刷新时间：多出口隧道里租户自己的那台
 * 出口报一个假解析，所有出口都会把明文流量转去它指定的 IP。现在只让缓存过期，由面板
 * 自己重新解析。
 */
export function expireSharedResolvedIp(ruleId: number) {
  resolvedIpCheckedAt.delete(ruleId);
}

export type AgentDnsWatch = {
  host: string;
  scope: string;
  refId?: number;
};

function isHostnameAddress(value: string) {
  const text = String(value || "").trim();
  return !!text && !isIP(text) && /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$/.test(text);
}

export function addDnsWatch(watches: Map<string, AgentDnsWatch>, host: string, scope: string, refId?: number) {
  const value = String(host || "").trim();
  if (!isHostnameAddress(value)) return;
  const key = `${scope}:${refId || 0}:${value.toLowerCase()}`;
  watches.set(key, { host: value, scope, ...(refId ? { refId } : {}) });
}

// 解析失败或超过 TARGET_DNS_RESOLVE_TIMEOUT_MS 都返回原值，由 selectResolvedTargetIp 回落到上次结果。
async function resolveTargetIp(raw: string): Promise<string> {
  return await resolveTargetIpWithTimeout(raw, { resolve4, resolve6 });
}

export async function resolveTargetIpCached(ruleId: number, raw: string, force = false): Promise<string> {
  const trimmed = String(raw || "").trim();
  if (!trimmed || isIP(trimmed)) return trimmed;
  const now = Date.now();
  const cachedIp = resolvedIpCache.get(ruleId);
  const checkedAt = resolvedIpCheckedAt.get(ruleId) || 0;
  if (!force && cachedIp && cachedIp.raw === trimmed && now - checkedAt < AGENT_DNS_RESOLVE_TTL_MS) return cachedIp.ip;
  const inflightKey = trimmed.toLowerCase();
  let work = resolvedIpInflight.get(inflightKey);
  if (!work) {
    work = resolveTargetIp(trimmed).finally(() => {
      if (resolvedIpInflight.get(inflightKey) === work) resolvedIpInflight.delete(inflightKey);
    });
    resolvedIpInflight.set(inflightKey, work);
  }
  const resolved = selectResolvedTargetIp(trimmed, await work, cachedIp);
  setBoundedMapValue(resolvedIpCache, ruleId, { raw: trimmed, ip: resolved }, AGENT_DYNAMIC_CACHE_MAX);
  setBoundedMapValue(resolvedIpCheckedAt, ruleId, Date.now(), AGENT_DYNAMIC_CACHE_MAX);
  return resolved;
}

// DNS 变更的规则：生成清理旧 IP 规则的动作
export const buildForwardTargetCleanup = (rule: any, targetIp: string, targetPort: number): string[] => {
  const port = rule.sourcePort;
  const cleanupRule = { ...rule, targetIp, targetPort };
  const cmds: string[] = [];
  if (rule.forwardType === "iptables") {
    cmds.push(...buildIptablesForwardCleanupCmds(cleanupRule));
  } else if (rule.forwardType === "nftables") {
    cmds.push(...buildNftCleanupCmds(cleanupRule));
  } else {
    cmds.push(...buildManagedPortCleanupCmds(Number(port), targetIp, targetPort, rule.protocol));
  }
  if (rule.forwardType === "iptables") cmds.push(...buildCountingCleanupCmds(port, targetIp, targetPort, rule.protocol));
  return cmds;
};
export const buildDnsChangeCleanup = (rule: any, oldIp: string): string[] => (
  buildForwardTargetCleanup(rule, oldIp, Number(rule.targetPort) || 0)
);
export const failoverProxyHandlesTargetDns = (rule: any) => (
  runtimeBool(rule?.failoverEnabled)
  && rule.forwardType === "gost"
  && normalizeForwardRuleProtocol(rule.protocol) === "tcp"
  && (routeGroupOf(rule)?.paths.length || 0) >= 2
);
