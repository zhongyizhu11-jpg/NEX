/**
 * 共享 TLS 入站（SNI 分流）的服务端规则：入站设置怎么校验、规则的 SNI 怎么校验、
 * 谁能用哪个入站、规则在本机的回环端口怎么分。
 *
 * 运行时的样子（为什么规则还要一个端口）：
 *
 *   客户端 ──TLS──▶ 主机:443（Agent 里的 SNI 分流器，按 SNI 找规则）
 *                      └─▶ 127.0.0.1:<规则端口>（这条规则自己的守卫，只听回环）
 *                             └─▶ 规则的转发工具 / 直接拨目标
 *
 * 规则端口就是规则行的 sourcePort：面板在这台主机上挑一个空闲端口给它，只在回环上听。
 * 这样计数（按端口装的 nft 计数器）、限速（守卫 / gost 的限速器）、状态上报和普通规则
 * 走的是同一套，按规则计费不需要另起一份。
 */

import { domainToASCII } from "node:url";

import * as db from "./db";
import { getLinkAccessScope } from "./linkAccessView";
import { requireHostUseAccess } from "./routers/helpers";
import { reserveAvailableHostPortOnHosts, type HostPortReservation } from "./portReservations";
import { pickAvailablePort, portPolicyFrom } from "../shared/portPolicy";
import {
  isTlsInboundAgentSupported,
  normalizeSniAllowlist,
  normalizeSniName,
  normalizeSniNameList,
  normalizeTlsInboundHandshakeTimeout,
  normalizeTlsInboundMaxHandshakes,
  normalizeTlsInboundProxyProtocol,
  normalizeTlsInboundUnknownSniAction,
  parseSniNameJson,
  sniNamesOutsideAllowlist,
  tlsInboundAgentUpgradeMessage,
  TLS_INBOUND_MAX_PER_HOST,
  TLS_INBOUND_SNI_CONFLICT_MESSAGE,
  type TlsInboundSettings,
} from "../shared/tlsInbound";
import type { TlsInboundRow } from "./repositories/tlsInboundRepository";

/** node:url 的 IDNA。失败时回空串，上层报「域名格式无效」。 */
export function sniToAscii(value: string) {
  return domainToASCII(value);
}

export function normalizeServerSniName(raw: unknown) {
  return normalizeSniName(raw, sniToAscii);
}

export function normalizeServerSniNameList(raw: unknown) {
  return normalizeSniNameList(raw, sniToAscii);
}

export function normalizeServerSniAllowlist(raw: unknown) {
  return normalizeSniAllowlist(raw, sniToAscii);
}

/** 规则在本机回环上听的端口从这段里挑：避开常用服务端口，也离守卫内部端口的起点远一些。 */
export const SNI_BACKEND_PORT_RANGE = { start: 45000, end: 59999 } as const;

/** 共享入站规则能用哪些转发工具：都走「守卫在回环上接 → 工具 / 直拨」这条路，六种都行。 */
export const SNI_RULE_FORWARD_TYPES = ["iptables", "nftables", "realm", "socat", "gost", "nginx"] as const;

export type TlsInboundInput = {
  name?: unknown;
  port?: unknown;
  isEnabled?: unknown;
  allowedSni?: unknown;
  rejectEmptySni?: unknown;
  unknownSniAction?: unknown;
  defaultRuleId?: unknown;
  proxyProtocol?: unknown;
  maxHandshakes?: unknown;
  handshakeTimeoutSeconds?: unknown;
};

/** 把表单值收成完整的设置；只做格式层面的检查（端口冲突、白名单覆盖等在 validateTlsInboundChange 里）。 */
export function normalizeTlsInboundInput(input: TlsInboundInput, current?: TlsInboundSettings | null): TlsInboundSettings {
  const name = String(input.name ?? current?.name ?? "").trim();
  if (!name) throw new Error("请填写入站名称");
  if (name.length > 64) throw new Error("入站名称最多 64 个字符");
  const port = Math.floor(Number(input.port ?? current?.port ?? 0));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须在 1-65535 之间");
  const allowlist = input.allowedSni === undefined
    ? { ok: true as const, names: current?.allowedSni || [] }
    : normalizeServerSniAllowlist(input.allowedSni);
  if (!allowlist.ok) throw new Error(allowlist.error);
  const unknownSniAction = normalizeTlsInboundUnknownSniAction(input.unknownSniAction ?? current?.unknownSniAction);
  const defaultRuleIdRaw = input.defaultRuleId === undefined ? current?.defaultRuleId : input.defaultRuleId;
  const defaultRuleId = Math.floor(Number(defaultRuleIdRaw || 0));
  return {
    name,
    port,
    isEnabled: input.isEnabled === undefined ? (current?.isEnabled ?? true) : input.isEnabled === true,
    allowedSni: allowlist.names,
    rejectEmptySni: input.rejectEmptySni === undefined ? (current?.rejectEmptySni ?? true) : input.rejectEmptySni === true,
    unknownSniAction,
    defaultRuleId: unknownSniAction === "default_rule" && defaultRuleId > 0 ? defaultRuleId : null,
    proxyProtocol: normalizeTlsInboundProxyProtocol(input.proxyProtocol ?? current?.proxyProtocol),
    maxHandshakes: normalizeTlsInboundMaxHandshakes(input.maxHandshakes ?? current?.maxHandshakes),
    handshakeTimeoutSeconds: normalizeTlsInboundHandshakeTimeout(input.handshakeTimeoutSeconds ?? current?.handshakeTimeoutSeconds),
  };
}

/**
 * 新建 / 修改入站前的检查：数量上限、端口冲突、白名单还盖不盖得住已有规则、默认规则合不合格。
 * 只读不写，抛出的都是给管理员看的话。
 */
export async function validateTlsInboundChange(options: {
  hostId: number;
  inboundId?: number | null;
  settings: TlsInboundSettings;
}) {
  const hostId = Number(options.hostId);
  const inboundId = Number(options.inboundId || 0);
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  if (!inboundId) {
    const count = await db.countTlsInboundsOnHost(hostId);
    if (count >= TLS_INBOUND_MAX_PER_HOST) throw new Error(`一台主机最多 ${TLS_INBOUND_MAX_PER_HOST} 个共享 TLS 入站`);
  }
  const sameHostInbounds = await db.listTlsInboundsByHost(hostId);
  if (sameHostInbounds.some((inbound) => inbound.id !== inboundId && inbound.port === options.settings.port)) {
    throw new Error(`端口 ${options.settings.port} 已有另一个共享 TLS 入站`);
  }
  // 规则、隧道、落地节点、换隧道桥接、Agent 中转……这台机器上的任何监听都不能和它撞。
  if (await db.isPortUsedOnHost(hostId, options.settings.port, undefined, "tcp", undefined, true, undefined, undefined, inboundId || undefined)) {
    throw new Error(`端口 ${options.settings.port} 在这台主机上已被占用（转发规则、隧道、落地节点或其他监听）`);
  }
  const rules = inboundId ? await db.getSniRulesForInbound(inboundId) as any[] : [];
  if (options.settings.allowedSni.length > 0) {
    for (const rule of rules) {
      const outside = sniNamesOutsideAllowlist(parseSniNameJson(rule.sniNames), options.settings.allowedSni);
      if (outside.length > 0) {
        throw new Error(`新的白名单不再覆盖规则「${String(rule.name || rule.id)}」的 SNI：${outside.slice(0, 5).join("、")}，请先修改或删除这条规则`);
      }
    }
  }
  if (options.settings.unknownSniAction === "default_rule") {
    const defaultRuleId = Number(options.settings.defaultRuleId || 0);
    if (!defaultRuleId) throw new Error("未知 SNI 交给默认规则时，请选择一条默认规则");
    const rule = rules.find((item) => Number(item.id) === defaultRuleId);
    if (!rule) throw new Error("默认规则必须是挂在这个入站上的规则");
    const owner = await db.getUserById(Number(rule.userId));
    if (!owner || owner.role !== "admin") throw new Error("默认规则必须是管理员自己的规则（避免把别人的流量交给某个用户）");
  }
  return { host, rules };
}

/** 删入站前：上面还挂着规则就不让删（暂停的也算，它们还占着名字）。 */
export async function assertTlsInboundDeletable(inboundId: number) {
  const count = await db.countSniRulesForInbound(inboundId);
  if (count > 0) throw new Error(`这个入站上还有 ${count} 条规则，请先删除或迁走这些规则再删除入站`);
}

/**
 * 普通用户能不能把规则挂到这台主机的入站上：和直连规则同一套主机授权（主机主人、
 * 主机授权、按量计费资源），再加上套餐的主机范围（运行时的闸 gateForwardRulesForRuntime 认的也是它）。
 */
export async function requireTlsInboundHostAccess(actor: { id: number; role: string }, hostId: number) {
  const access = await requireHostUseAccess({ user: actor }, hostId);
  if (actor.role !== "admin" && !access.isTrafficBillingResource) {
    const scope = await getLinkAccessScope(actor);
    if (scope && !(scope.useHostIds || scope.hostIds).has(Number(hostId))) {
      throw new Error("这台主机不在您的授权范围内，不能使用它上面的共享 TLS 入站");
    }
  }
  return access;
}

/** 当前用户能用的入站所在的主机。管理员是全部。 */
export async function usableTlsInboundHostIds(actor: { id: number; role: string }, hostIds: readonly number[]) {
  const unique = Array.from(new Set(hostIds.map(Number).filter((id) => id > 0)));
  if (actor.role === "admin") return new Set(unique);
  const allowed = new Set<number>();
  for (const hostId of unique) {
    try {
      await requireTlsInboundHostAccess(actor, hostId);
      allowed.add(hostId);
    } catch {
      // 没授权的主机不列出来。
    }
  }
  return allowed;
}

/**
 * 规则要挂的入站能不能用、这些名字能不能拿。返回规整后的名字。
 * excludeRuleId：改规则时排除它自己已经占着的名字。
 */
export async function validateSniRuleNames(options: {
  inbound: TlsInboundRow;
  names: unknown;
  excludeRuleId?: number;
}) {
  const normalized = normalizeServerSniNameList(options.names);
  if (!normalized.ok) throw new Error(normalized.error);
  const outside = sniNamesOutsideAllowlist(normalized.names, options.inbound.allowedSni);
  if (outside.length > 0) {
    throw new Error(`以下 SNI 不在这个入站的白名单内：${outside.slice(0, 5).join("、")}`);
  }
  const owners = await db.findSniNameOwners(options.inbound.id, normalized.names, Number(options.excludeRuleId || 0));
  if (owners.length > 0) {
    throw new Error(`${TLS_INBOUND_SNI_CONFLICT_MESSAGE}：${owners.map((owner) => owner.name).slice(0, 5).join("、")}`);
  }
  return normalized.names;
}

/** 入站本身能不能挂新规则 / 启用规则：要启用着、Agent 版本够。 */
export async function requireTlsInboundRunnable(inbound: TlsInboundRow) {
  const host = await db.getHostById(inbound.hostId);
  if (!host) throw new Error("入站所在的主机不存在");
  if (!inbound.isEnabled) throw new Error(`共享 TLS 入站「${inbound.name}」已停用`);
  if (!isTlsInboundAgentSupported(String((host as any).agentVersion || ""))) {
    throw new Error(tlsInboundAgentUpgradeMessage((host as any).name));
  }
  return host;
}

/** 规则的目标不能绕回入站自己（也不能指向自己的回环端口），否则就是死循环。 */
export function assertSniRuleTargetNotLoop(options: { host: any; inboundPort: number; backendPort?: number; targetIp: unknown; targetPort: number }) {
  const target = String(options.targetIp ?? "").trim().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  if (!target) return;
  const hostTokens = new Set(
    [options.host?.ip, options.host?.ipv4, options.host?.ipv6, options.host?.entryIp, options.host?.tunnelEntryIp, options.host?.ddnsDomain]
      .map((value) => String(value || "").trim().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase())
      .filter(Boolean),
  );
  const loopback = target === "localhost" || target.startsWith("127.") || target === "::1" || target === "0.0.0.0" || target === "::";
  const port = Number(options.targetPort || 0);
  if ((loopback || hostTokens.has(target)) && (port === Number(options.inboundPort) || (options.backendPort && port === Number(options.backendPort)))) {
    throw new Error("目标不能指回这台主机的共享 TLS 入站自己，这会造成转发死循环");
  }
}

/** 给 SNI 规则在主机上分一个回环端口并占住（和普通规则共用端口占用表，所以谁也不会撞上它）。 */
export async function reserveSniBackendPort(hostId: number, excludeRuleIds: number[] = []): Promise<HostPortReservation | null> {
  return reserveAvailableHostPortOnHosts({
    hostIds: [hostId],
    protocol: "tcp",
    findPort: async (reservedPorts) => {
      const used = await db.getUsedPortsOnHost(hostId, excludeRuleIds, "both", undefined, false);
      for (const port of reservedPorts) used.add(Number(port));
      return pickAvailablePort(portPolicyFrom(null), used, SNI_BACKEND_PORT_RANGE);
    },
    isUsed: (listenHostId, port) => db.isPortUsedOnHost(listenHostId, port, excludeRuleIds, "both", undefined, false),
  });
}

export function isSniRule(rule: any) {
  return Number(rule?.tlsInboundId || 0) > 0;
}
