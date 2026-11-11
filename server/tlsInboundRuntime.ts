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
 *   3. 转送规则（经隧道 / 转发链 / 转发组走，见 shared/tlsInbound.ts 的 sniRuleRouteKind）：规则在入口机上
 *      的入口（隧道入口、转发链第一跳、组成员上的子规则）只听 127.0.0.1:<规则端口>，分流器照样把连接
 *      交过去，限速、计数、配额还挂在规则自己的入口上。要 Agent 2.2.255，路由表带 revision，Agent 装上
 *      以后原样报回来 —— 报回来的和下发的一致，这台入口的 SNI 配置才算「已确认」（见 tlsInboundReadiness.ts）。
 */

import { createHash } from "node:crypto";

import {
  isSniRouteAgentSupported,
  isTlsInboundAgentSupported,
  isTlsInboundRoutedAgentSupported,
  parseSniNameJson,
  sniRuleRouteKind,
  TLS_INBOUND_PER_IP_HANDSHAKES,
} from "../shared/tlsInbound";
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
  /** 这张表的版本号（只发给 2.2.255 起的 Agent）：表的内容一变它就变，Agent 装上后原样回报。 */
  revision?: string;
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
  /*
    别的机器上的规则出现在这台的列表里，只可能是这台是它隧道的出口 / 中转：出口那一侧和普通隧道规则
    一模一样，原样放过（在这里停掉它，入口机上 SNI 分过来的连接就到不了目标）。入口那一侧的
    「只听回环」不看这个视图，按 isSniRuntimeRule 判断，所以隧道挂了入口组也不会在组里别的主机上
    对外开出这个端口。
  */
  if (Number(rule.hostId) !== Number(options.hostId)) return rule;
  const routeKind = sniRuleRouteKind(rule);
  const inbound = options.inboundById.get(Number(rule.tlsInboundId));
  const runnable = !!inbound
    && inbound.isEnabled
    && inbound.hostId === Number(options.hostId)
    && isSniRouteAgentSupported(routeKind, options.agentVersion);
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
  if (routeKind === "tunnel") {
    // 隧道规则的 PROXY 头分「入口收 / 入口发 / 出口收 / 出口发」四段，入口在回环上只能看到本机地址，
    // 这一版经隧道的 SNI 规则不带 PROXY 头（建规则时就清掉了，这里兜底）：分流器不发，入口不收。
    view.proxyProtocolReceive = false;
    view.proxyProtocolSend = false;
  }
  if (!runnable) {
    view.isEnabled = false;
    view.sniRuntimeBlocked = true;
  }
  return view as T;
}

/** 表的版本号：同样的内容永远算出同一个值，内容一变就变。只取前 16 位，够分辨又不占地方。 */
export function sniInboundRevision(spec: Omit<AgentSniInbound, "revision">) {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
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
    const spec: AgentSniInbound = {
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
    };
    // 老 Agent 不认 revision 也不回报，不给它发，免得它的表白白跟着版本号变来变去。
    if (isTlsInboundRoutedAgentSupported(options.agentVersion)) spec.revision = sniInboundRevision(spec);
    output.push(spec);
  }
  return output.sort((a, b) => a.port - b.port || a.id - b.id);
}

/*
  下发了哪张表、Agent 报回来装上了哪张：都只存内存。面板重启后一台入口要等它下一次心跳才重新算「已确认」，
  这段时间里 DDNS 不会把流量切到它上面（已经在用的入口不受影响，见 tlsInboundReadiness.ts）。
*/
const RUNTIME_STATUS_HOST_MAX = 4096;
const sentRevisionByHost = new Map<number, Map<number, string>>();

/** 心跳里生成 sniInbounds 用这个：和 buildAgentSniInbounds 一样，只是顺手记下下发的版本号。 */
export function planAgentSniInbounds(options: Parameters<typeof buildAgentSniInbounds>[0]): AgentSniInbound[] {
  const specs = buildAgentSniInbounds(options);
  const hostId = Number(options.hostId);
  if (hostId > 0) {
    const sent = new Map<number, string>();
    for (const spec of specs) if (spec.revision) sent.set(spec.id, spec.revision);
    if (!sentRevisionByHost.has(hostId) && sentRevisionByHost.size >= RUNTIME_STATUS_HOST_MAX) {
      const oldest = sentRevisionByHost.keys().next().value;
      if (oldest !== undefined) sentRevisionByHost.delete(oldest);
    }
    sentRevisionByHost.set(hostId, sent);
  }
  return specs;
}

export function getSentTlsInboundRevision(hostId: number, inboundId: number) {
  return sentRevisionByHost.get(Number(hostId))?.get(Number(inboundId)) || "";
}

/**
 * 这台机器上这个入站的路由表是不是已经确认：Agent 报它在听，而且报回来的版本号就是面板最近下发的那张。
 * 老 Agent 不报版本号，永远是 false。
 */
export function isTlsInboundTableConfirmed(hostId: number, inboundId: number) {
  const sent = getSentTlsInboundRevision(hostId, inboundId);
  if (!sent) return false;
  const status = getTlsInboundRuntimeStatus(hostId, inboundId);
  return !!status && status.listening && status.revision === sent;
}

/** Agent 在心跳里报上来的入站监听状态（只存内存，给主机详情显示「监听失败」用）。 */
export type TlsInboundRuntimeStatus = {
  id: number;
  port: number;
  listening: boolean;
  error: string;
  updatedAt: number;
  /** 以下 Agent 2.2.255 起才有：装上的表的版本号、可用的名字数、分流计数（监听起来以后累计）。 */
  revision: string;
  routes: number;
  matched: number;
  dropped: number;
  backendErrors: number;
};

function counterValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** Agent 2.2.255 起多报的那几项；老 Agent 没有，全是空 / 0。 */
function reportedTableFields(item: unknown) {
  const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
  return {
    revision: String(record.revision || "").slice(0, 64),
    routes: counterValue(record.routes),
    matched: counterValue(record.matched),
    dropped: counterValue(record.dropped),
    backendErrors: counterValue(record.backendErrors),
  };
}

const runtimeStatusByHost = new Map<number, Map<number, TlsInboundRuntimeStatus>>();

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
      ...reportedTableFields(item),
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
