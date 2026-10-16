/**
 * 心跳里共享 TLS 入站（SNI 分流）那一段怎么算。纯函数，单独拿出来好测。
 *
 * 两件事：
 *   1. 规则的运行视图（sniRuleRuntimeView）：入站不在 / 停用 / Agent 太旧时规则按「停用」下发，
 *      已经起着的守卫会被正常的停用流程撤掉；规则要往目标发 PROXY 头时，守卫改成先收入站
 *      给它的 PROXY 头（真实客户端地址在入站那里），再照常往下发。
 *   2. 下发给 Agent 的 sniInbounds：每个启用的入站一份路由表，名字 → 规则的回环端口。
 *      暂停 / 失效的规则照样列出来但标成不可用 —— Agent 看到这种名字直接断开，绝不落到
 *      默认规则上（否则一个用户停掉的规则，流量会跑到别人的默认规则里）。
 */

import { isTlsInboundAgentSupported, parseSniNameJson, TLS_INBOUND_PER_IP_HANDSHAKES } from "../shared/tlsInbound";
import type { TlsInboundRow } from "./repositories/tlsInboundRepository";

export type AgentSniRoute = {
  name: string;
  ruleId: number;
  backendPort: number;
  active: boolean;
  /** 0 = 不发 PROXY 头；1 / 2 = 按这个版本把真实客户端地址发给规则的守卫。 */
  proxyProtocolVersion: number;
};

export type AgentSniBackend = {
  ruleId: number;
  backendPort: number;
  proxyProtocolVersion: number;
};

export type AgentSniInbound = {
  id: number;
  port: number;
  proxyProtocol: "off" | "auto";
  rejectEmptySni: boolean;
  unknownSniAction: "reject" | "default_rule";
  maxHandshakes: number;
  maxHandshakesPerIp: number;
  handshakeTimeoutSeconds: number;
  allowedSni: string[];
  defaultBackend: AgentSniBackend | null;
  routes: AgentSniRoute[];
};

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
}

export function isSniRuntimeRule(rule: any) {
  return Number(rule?.tlsInboundId || 0) > 0;
}

/**
 * 规则在这台 Agent 上的运行视图。不是 SNI 规则原样返回（同一个对象，下游按引用比较的地方不受影响）。
 */
export function sniRuleRuntimeView<T extends Record<string, any>>(rule: T, options: {
  hostId: number;
  agentVersion: string;
  inboundById: Map<number, TlsInboundRow>;
}): T {
  if (!isSniRuntimeRule(rule)) return rule;
  const inbound = options.inboundById.get(Number(rule.tlsInboundId));
  const runnable = !!inbound
    && inbound.isEnabled
    && inbound.hostId === Number(options.hostId)
    && Number(rule.hostId) === Number(options.hostId)
    && isTlsInboundAgentSupported(options.agentVersion);
  const view: Record<string, any> = {
    ...rule,
    protocol: "tcp",
    // 入站给守卫的 PROXY 头只在规则要往目标发的时候才有，守卫收不收跟着它走。
    proxyProtocolReceive: truthy(rule.proxyProtocolSend),
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    failoverEnabled: false,
    blockHttp: false,
    blockSocks: false,
    blockTls: false,
  };
  if (!runnable) {
    view.isEnabled = false;
    view.sniRuntimeBlocked = true;
  }
  return view as T;
}

function ruleProxyVersion(rule: any) {
  if (!truthy(rule?.proxyProtocolSend)) return 0;
  return Number(rule?.proxyProtocolVersion) === 2 ? 2 : 1;
}

/**
 * 这台 Agent 要的 sniInbounds。rules 是已经过运行视图和授权闸的规则（isEnabled 就是「能不能跑」）。
 * Agent 太旧时回空数组：它不认这一段，规则也已经按停用下发了。
 */
export function buildAgentSniInbounds(options: {
  hostId: number;
  agentVersion: string;
  inbounds: readonly TlsInboundRow[];
  rules: readonly any[];
}): AgentSniInbound[] {
  if (!isTlsInboundAgentSupported(options.agentVersion)) return [];
  const rulesByInbound = new Map<number, any[]>();
  for (const rule of options.rules) {
    if (!isSniRuntimeRule(rule) || Number(rule.hostId) !== Number(options.hostId)) continue;
    if (truthy(rule.pendingDelete)) continue;
    const list = rulesByInbound.get(Number(rule.tlsInboundId)) || [];
    list.push(rule);
    rulesByInbound.set(Number(rule.tlsInboundId), list);
  }
  const output: AgentSniInbound[] = [];
  for (const inbound of options.inbounds) {
    if (!inbound.isEnabled || inbound.hostId !== Number(options.hostId) || inbound.port <= 0) continue;
    const routes = new Map<string, AgentSniRoute>();
    const rules = (rulesByInbound.get(inbound.id) || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
    for (const rule of rules) {
      const backendPort = Number(rule.sourcePort || 0);
      const active = truthy(rule.isEnabled) && backendPort > 0;
      for (const name of parseSniNameJson(rule.sniNames)) {
        // 侧表的唯一索引保证不会重名；万一真有（手改过库），先到的那条赢，后面的不覆盖。
        if (routes.has(name)) continue;
        routes.set(name, {
          name,
          ruleId: Number(rule.id),
          backendPort,
          active,
          proxyProtocolVersion: ruleProxyVersion(rule),
        });
      }
    }
    let defaultBackend: AgentSniBackend | null = null;
    if (inbound.unknownSniAction === "default_rule" && inbound.defaultRuleId) {
      const rule = rules.find((item) => Number(item.id) === Number(inbound.defaultRuleId));
      if (rule && truthy(rule.isEnabled) && Number(rule.sourcePort || 0) > 0) {
        defaultBackend = { ruleId: Number(rule.id), backendPort: Number(rule.sourcePort), proxyProtocolVersion: ruleProxyVersion(rule) };
      }
    }
    output.push({
      id: inbound.id,
      port: inbound.port,
      proxyProtocol: inbound.proxyProtocol,
      rejectEmptySni: inbound.rejectEmptySni,
      unknownSniAction: inbound.unknownSniAction,
      maxHandshakes: inbound.maxHandshakes,
      maxHandshakesPerIp: Math.min(TLS_INBOUND_PER_IP_HANDSHAKES, inbound.maxHandshakes),
      handshakeTimeoutSeconds: inbound.handshakeTimeoutSeconds,
      allowedSni: [...inbound.allowedSni].sort(),
      defaultBackend,
      routes: Array.from(routes.values()).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return output.sort((a, b) => a.port - b.port || a.id - b.id);
}

/** Agent 在心跳里报上来的入站监听状态（只存内存，给主机详情显示「监听失败」用）。 */
export type TlsInboundRuntimeStatus = { id: number; port: number; listening: boolean; error: string; updatedAt: number };

const runtimeStatusByHost = new Map<number, Map<number, TlsInboundRuntimeStatus>>();
const RUNTIME_STATUS_HOST_MAX = 4096;

export function recordTlsInboundRuntimeStatus(hostId: number, input: unknown, now = Date.now()) {
  if (!Array.isArray(input)) return;
  const id = Number(hostId);
  if (!(id > 0)) return;
  const next = new Map<number, TlsInboundRuntimeStatus>();
  for (const item of input.slice(0, 128)) {
    const inboundId = Number((item as any)?.id || 0);
    if (!(inboundId > 0)) continue;
    next.set(inboundId, {
      id: inboundId,
      port: Number((item as any)?.port || 0),
      listening: (item as any)?.listening === true,
      error: String((item as any)?.error || "").slice(0, 300),
      updatedAt: now,
    });
  }
  if (!runtimeStatusByHost.has(id) && runtimeStatusByHost.size >= RUNTIME_STATUS_HOST_MAX) {
    const oldest = runtimeStatusByHost.keys().next().value;
    if (oldest !== undefined) runtimeStatusByHost.delete(oldest);
  }
  runtimeStatusByHost.set(id, next);
}

export function getTlsInboundRuntimeStatus(hostId: number, inboundId: number) {
  return runtimeStatusByHost.get(Number(hostId))?.get(Number(inboundId)) || null;
}
