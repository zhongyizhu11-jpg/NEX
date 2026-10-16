import crypto from "crypto";
import dns from "node:dns";
import net from "node:net";
import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";
import { appendPanelLog } from "./_core/panelLogger";
import {
  buildDiagnosticsReport,
  DIAGNOSTIC_GROUPS,
  type DiagnosticGroup,
  type DiagnosticItem,
  type DiagnosticSubjectKind,
  type LinkDiagnosticsReport,
} from "../shared/linkDiagnostics";
import { FORWARD_PROTOCOL_LABELS, isUserspaceForwardType, normalizeForwardRuleProtocol } from "../shared/forwardTypes";
import { combineHostPortPolicyWithRange, combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "../shared/portPolicy";
import { sameNetworkAddress } from "../shared/ipAddress";
import { dbBool } from "./repositories/repositoryUtils";
import { normalizeRuleEgressType } from "../shared/ssEgress";
import { evaluateRuleEgress, loadEgressRuntimeContext } from "./ssEgress";
import { getForwardProtocolSettings, getRuleProtocolKey, getTunnelProtocolKey, isForwardProtocolKeyEnabled } from "./forwardProtocolSettings";
import { isForwardXTunnel } from "./tunnelFxpRuntime";
import { isForwardXWireGuardV2 } from "./forwardXWireGuard";
import { getTunnelRuntimeHostStatus } from "./tunnelRuntimeStatus";
import { selectTunnelDialAddress, selectTunnelHopDialAddress } from "./tunnelAddressSelection";
import {
  agentCheckHints,
  agentCheckItems,
  agentSupportsDiagnostics,
  evaluateConfigItems,
  evaluateDomainItem,
  evaluateHostItem,
  evaluatePortConflictItem,
  evaluateRuntimeItem,
  evaluateTargetAddressItem,
  formatHostPort,
  type AgentHostGate,
  type DiagnosticOwnerFacts,
  type PlannedAgentCheck,
} from "./linkDiagnosticsChecks";
import {
  enqueueDiagnosticsAgentTask,
  getDiagnosticsTaskStatus,
  type DiagnosticsAgentCheck,
} from "./diagnosticsAgentTasks";

/*
  一键链路诊断：把一条规则 / 隧道 / 转发链拆成一张清单。

  面板侧的项在 start 时当场算完（配置、主机在线与版本、运行状态、端口冲突、入口域名、目标
  地址），主机侧的项给每台涉及的主机排一个 diagnostics 任务，status 每 2 秒被浏览器问一次，
  按任务状态把「等待」换成结果。一次诊断（session）只在内存里留 15 分钟。

  判定规则在 linkDiagnosticsChecks.ts；这里只管取数据、排任务、拼顺序。
*/

type Ctx = { user: { id: number; role: string } };

type Slot =
  | { kind: "panel"; item: DiagnosticItem }
  | { kind: "agent"; planned: PlannedAgentCheck };

type Session = {
  id: string;
  userId: number;
  subject: LinkDiagnosticsReport["subject"];
  startedAt: string;
  slots: Slot[];
  gates: Map<number, AgentHostGate>;
  expiresAt: number;
};

const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_MAX = 500;
const PANEL_DNS_TIMEOUT_MS = 4_000;
const sessions = new Map<string, Session>();

function pruneSessions(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
  while (sessions.size > SESSION_MAX) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

const sessionCleanupTimer = setInterval(() => pruneSessions(), 60 * 1000);
sessionCleanupTimer.unref?.();

/* ───────────────────────── 小工具 ───────────────────────── */

function positive(value: unknown) {
  const n = Number(value || 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function hostLabel(host: any, hostId: number) {
  return String(host?.name || "").trim() || `主机 #${hostId}`;
}

function literalHostAddresses(host: any) {
  return Array.from(new Set([host?.ipv4, host?.ipv6, host?.ip, host?.entryIp]
    .map((value) => String(value || "").trim().replace(/^\[|\]$/g, ""))
    .filter((value) => value && net.isIP(value))));
}

function primaryPublicIp(host: any) {
  for (const value of [host?.ipv4, host?.ip, host?.ipv6]) {
    const text = String(value || "").trim().replace(/^\[|\]$/g, "");
    if (text && net.isIP(text)) return text;
  }
  return "";
}

async function lookupWithTimeout(name: string): Promise<{ addresses: string[] | null; error?: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      dns.promises.lookup(name, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${PANEL_DNS_TIMEOUT_MS / 1000} 秒内没解析出来`)), PANEL_DNS_TIMEOUT_MS);
      }),
    ]);
    const addresses = Array.from(new Set(result.map((entry) => entry.address)));
    return addresses.length > 0 ? { addresses } : { addresses: null, error: "没有记录" };
  } catch (error: any) {
    const code = String(error?.code || "");
    const message = code === "ENOTFOUND" ? "域名不存在（NXDOMAIN）" : code === "ENODATA" ? "没有 A / AAAA 记录" : String(error?.message || error || "查询失败");
    return { addresses: null, error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

/* ───────────────────────── 拓扑 ───────────────────────── */

export type TunnelHopEdge = {
  fromHostId: number;
  toHostId: number;
  address: string;
  port: number;
};

/**
 * 隧道每一段「谁拨谁」：有 tunnel_hops（多跳，第一项是入口、最后一项是出口）就按顺序一段段，
 * 没有就是入口直接拨出口的 listenPort。地址的选法和心跳下发隧道探测时一样
 * （connectHost 优先，内网隧道用内网地址，否则主机入口地址）。
 */
export function tunnelHopEdges(tunnel: any, hops: readonly any[], hostById: ReadonlyMap<number, any>): TunnelHopEdge[] {
  const ordered = [...(hops || [])].sort((a, b) => Number(a?.seq || 0) - Number(b?.seq || 0));
  if (ordered.length >= 2) {
    const edges: TunnelHopEdge[] = [];
    for (let index = 0; index < ordered.length - 1; index++) {
      const from = ordered[index];
      const to = ordered[index + 1];
      const toHostId = positive(to?.hostId);
      const isLast = index + 1 === ordered.length - 1;
      const address = selectTunnelHopDialAddress(to, hostById.get(toHostId), tunnel)
        || (isLast ? selectTunnelDialAddress(tunnel, hostById.get(toHostId)) : "");
      edges.push({
        fromHostId: positive(from?.hostId),
        toHostId,
        address,
        port: positive(to?.listenPort) || (isLast ? positive(tunnel?.listenPort) : 0),
      });
    }
    return edges;
  }
  const exitHostId = positive(tunnel?.exitHostId);
  return [{
    fromHostId: positive(tunnel?.entryHostId),
    toHostId: exitHostId,
    address: selectTunnelDialAddress(tunnel, hostById.get(exitHostId)),
    port: positive(tunnel?.listenPort),
  }];
}

/* ───────────────────────── 构建一次诊断 ───────────────────────── */

class PlanBuilder {
  slots: Slot[] = [];
  hosts = new Map<number, any>();
  roles = new Map<number, string>();
  fxpHosts = new Set<number>();
  private seq = 0;
  private hostOrder: number[] = [];

  constructor(readonly ctx: Ctx) {}

  async loadHosts(ids: readonly unknown[]) {
    const wanted = ids.map(positive).filter((id) => id > 0 && !this.hosts.has(id));
    if (wanted.length === 0) return;
    for (const host of await db.getHostsByIds(wanted) as any[]) this.hosts.set(Number(host.id), host);
  }

  role(hostId: number, role: string, options: { fxp?: boolean } = {}) {
    if (hostId <= 0) return;
    if (!this.roles.has(hostId)) {
      this.roles.set(hostId, role);
      this.hostOrder.push(hostId);
    }
    if (options.fxp) this.fxpHosts.add(hostId);
  }

  name(hostId: number) {
    return hostLabel(this.hosts.get(hostId), hostId);
  }

  online(hostId: number) {
    return !!this.hosts.get(hostId)?.isOnline;
  }

  panel(item: DiagnosticItem) {
    this.slots.push({ kind: "panel", item });
  }

  agent(hostId: number, group: DiagnosticGroup, title: string, check: Omit<DiagnosticsAgentCheck, "id">, hintRole?: "entry" | "hop" | "target") {
    if (hostId <= 0) return;
    const full: DiagnosticsAgentCheck = { id: `c${++this.seq}`, ...check };
    this.slots.push({
      kind: "agent",
      planned: { check: full, group, title, hostId, hostName: this.name(hostId), ...agentCheckHints(full, { role: hintRole }) },
    });
  }

  /** 主机一项一台，排在「主机」组里，按在链路上出现的顺序。 */
  hostItems() {
    const items = this.hostOrder.map((hostId) => {
      const host = this.hosts.get(hostId);
      if (!host) {
        return { key: `host:${hostId}`, group: "host" as const, title: `${this.roles.get(hostId)}「主机 #${hostId}」`, status: "fail" as const, summary: "主机已被删除", hint: "编辑规则 / 隧道，换一台现有主机", source: "panel" as const, hostId };
      }
      return evaluateHostItem({
        id: hostId,
        name: this.name(hostId),
        role: this.roles.get(hostId) || "主机",
        isOnline: host.isOnline,
        lastHeartbeat: host.lastHeartbeat,
        agentVersion: host.agentVersion,
        fxpVersion: host.fxpVersion,
      }, { requireFxp: this.fxpHosts.has(hostId) });
    });
    return items;
  }

  hostIds() {
    return [...this.hostOrder];
  }
}

async function ownerFacts(userId: unknown): Promise<DiagnosticOwnerFacts | null> {
  const id = positive(userId);
  if (!id) return null;
  const owner = await db.getUserById(id) as any;
  if (!owner) return { exists: false, role: "user", accountEnabled: false, canAddRules: false, pauseReason: null, expiresAt: null, trafficLimit: 0, trafficUsed: 0, maxRules: 0, ruleCount: null };
  const ruleCount = String(owner.role) !== "admin" && Number(owner.maxRules || 0) > 0
    ? await db.getUserRuleCount(id).catch(() => null)
    : null;
  return {
    exists: true,
    role: String(owner.role || "user"),
    accountEnabled: owner.accountEnabled,
    canAddRules: owner.canAddRules,
    pauseReason: owner.forwardAccessPauseReason ? String(owner.forwardAccessPauseReason) : null,
    expiresAt: owner.expiresAt,
    trafficLimit: Number(owner.trafficLimit || 0),
    trafficUsed: Number(owner.trafficUsed || 0),
    maxRules: Number(owner.maxRules || 0),
    ruleCount,
  };
}

function forwardTypeAllowedFor(owner: any, forwardType: string): boolean | null {
  if (!owner || String(owner.role) === "admin") return null;
  const raw = owner.allowedForwardTypes;
  if (raw === null || raw === undefined) return null;
  const allowed = new Set(String(raw).split(",").map((value) => value.trim()).filter(Boolean));
  return allowed.has(forwardType);
}

/** 入口的那几项主机侧检查：监听（或内核转发规则）、防火墙、回环、进程。 */
function planEntryListener(plan: PlanBuilder, input: {
  hostId: number;
  port: number;
  protocol: string;
  forwardType: string;
  tunnel?: any | null;
  group?: DiagnosticGroup;
  label?: string;
}) {
  const { hostId, port } = input;
  if (hostId <= 0 || port <= 0) return;
  const group = input.group || "entry";
  const protocol = normalizeForwardRuleProtocol(input.protocol, "both");
  const forwardType = String(input.forwardType || "").toLowerCase();
  const where = input.label ? `${input.label} ` : "";
  const kernel = !input.tunnel && !isUserspaceForwardType(forwardType);
  if (kernel) {
    plan.agent(hostId, group, `${where}内核转发规则（端口 ${port}）`, { kind: "nat", port, protocol, forwardType });
  } else {
    plan.agent(hostId, group, `${where}端口 ${port}/${protocol === "both" ? "tcp+udp" : protocol} 在监听`, { kind: "listen", port, protocol });
  }
  plan.agent(hostId, group, `${where}防火墙放行端口 ${port}`, { kind: "firewall", port, protocol, forwardType });
  if (!kernel && protocol !== "udp") {
    plan.agent(hostId, group, `${where}本机连得上端口 ${port}`, { kind: "loopback", port, protocol: "tcp", publicIp: primaryPublicIp(plan.hosts.get(hostId)) });
  }
  const processType = input.tunnel
    ? (isForwardXTunnel(input.tunnel) ? "fxp" : "gost")
    : forwardType;
  if (["realm", "socat", "gost", "nginx", "fxp"].includes(processType)) {
    plan.agent(hostId, group, `${where}转发进程在运行`, {
      kind: "process", port, protocol, forwardType: processType,
      ...(input.tunnel ? { tunnelId: Number(input.tunnel.id) } : {}),
    });
  }
}

function planTargetDial(plan: PlanBuilder, hostId: number, target: string, port: number, protocol: string) {
  if (hostId <= 0 || !target) return;
  const literal = net.isIP(target.replace(/^\[|\]$/g, ""));
  if (!literal) {
    plan.agent(hostId, "target", `「${plan.name(hostId)}」解析 ${target}`, { kind: "dns", host: target });
  }
  if (port > 0) {
    plan.agent(hostId, "target", `「${plan.name(hostId)}」连得上 ${formatHostPort(target, port)}`, { kind: "dial", host: target, port, protocol: normalizeForwardRuleProtocol(protocol, "tcp") }, "target");
  }
}

/**
 * 走 Shadowsocks 出口的规则（2.3.445）：真实路径是 入口 → SS 服务器 →（落地主机）→ 目标，
 * 不是入口直接拨目标。落地主机上的入站：检查入口能不能连上 SS 端口、落地主机能不能连上目标；
 * 外部 SS 链接：只能检查入口到 SS 端口，目标那一段在别人的机器上，面板查不到。
 * 返回 false 表示这条规则没有出口，调用方照直连处理。
 */
async function planEgressPath(plan: PlanBuilder, rule: any, entryHostId: number, target: string, targetPort: number) {
  const type = normalizeRuleEgressType(rule?.egressType);
  if (type === "none") return false;
  await plan.loadHosts([entryHostId]);
  const entryHost = plan.hosts.get(entryHostId);
  const context = await loadEgressRuntimeContext([rule]);
  const evaluation = evaluateRuleEgress(rule, {
    entryHostId,
    entryAgentVersion: String(entryHost?.agentVersion || ""),
    entryHostName: plan.name(entryHostId),
    context,
  });
  const landingHostId = type === "ss_host" ? Number(evaluation?.landingHost?.id || 0) : 0;
  if (landingHostId > 0) {
    await plan.loadHosts([landingHostId]);
    plan.role(landingHostId, "落地出口");
  }
  const endpoint = evaluation?.endpoint || null;
  const where = type === "ss_host"
    ? `落地「${landingHostId > 0 ? plan.name(landingHostId) : "?"}」`
    : endpoint ? `外部 SS ${formatHostPort(endpoint.server, endpoint.port)}` : "外部 SS";
  const state = evaluation?.state || "config_invalid";
  const status = state === "running" ? "pass" : state === "paused" ? "warn" : "fail";
  plan.panel({
    key: `egress:${rule.id}`,
    group: "link",
    title: "Shadowsocks 出口",
    status,
    summary: state === "running" ? `经 ${where} 出口` : (evaluation?.message || "出口配置无效"),
    hint: status === "fail" ? "出口失效时规则按停用下发、不会退回直连；按提示修好出口或在规则里改掉出口" : undefined,
    source: "panel",
  });
  if (endpoint) {
    plan.agent(entryHostId, "link", `「${plan.name(entryHostId)}」→ SS 出口 ${formatHostPort(endpoint.server, endpoint.port)}`, {
      kind: "dial", host: endpoint.server, port: endpoint.port, protocol: "tcp",
    }, "hop");
  }
  if (landingHostId > 0) {
    // 出口只走 TCP（SS_EGRESS_UDP_SUPPORTED = false），目标那一段由落地主机去连
    planTargetDial(plan, landingHostId, target, targetPort, "tcp");
  } else {
    plan.panel({ key: `egress-target:${rule.id}`, group: "target", title: "目标连通（经外部 SS）", status: "skip", summary: "目标由外部 SS 服务器去连，面板查不到这一段", source: "panel" });
  }
  return true;
}

async function planTargetAddress(plan: PlanBuilder, target: string) {
  const value = String(target || "").trim().replace(/^\[|\]$/g, "");
  if (!value) return;
  let managedHostName: string | null = null;
  const findManaged = (addresses: string[]) => {
    for (const host of plan.hosts.values()) {
      if (addresses.some((address) => [host.ipv4, host.ipv6, host.ip, host.entryIp, host.tunnelEntryIp].some((candidate) => sameNetworkAddress(candidate, address)))) {
        return hostLabel(host, Number(host.id));
      }
    }
    return null;
  };
  if (net.isIP(value)) {
    managedHostName = findManaged([value]);
    if (!managedHostName && plan.ctx.user.role === "admin") {
      // 目标是内网地址时，看看是不是面板里别的主机（同机房内网转发）。只有管理员查全表。
      const all = await db.getHosts().catch(() => []) as any[];
      for (const host of all) {
        if ([host.ipv4, host.ipv6, host.ip, host.entryIp, host.tunnelEntryIp].some((candidate: unknown) => sameNetworkAddress(candidate, value))) {
          managedHostName = hostLabel(host, Number(host.id));
          break;
        }
      }
    }
    plan.panel(evaluateTargetAddressItem({ target: value, managedHostName }));
    return;
  }
  const lookup = await lookupWithTimeout(value);
  plan.panel(evaluateTargetAddressItem({
    target: value,
    resolved: lookup.addresses,
    resolveError: lookup.error,
    managedHostName: lookup.addresses ? findManaged(lookup.addresses) : null,
  }));
}

async function planEntryDomains(plan: PlanBuilder, rule: any, entryHostId: number) {
  const host = plan.hosts.get(entryHostId);
  const expected = literalHostAddresses(host);
  const checks: Array<Promise<void>> = [];
  const ruleDomain = String(rule?.entryDomain || "").trim();
  if (rule && dbBool(rule.entryDomainEnabled, true) && ruleDomain) {
    checks.push(lookupWithTimeout(ruleDomain).then((lookup) => {
      plan.panel(evaluateDomainItem({
        key: "entry.domain", label: "入口域名", domain: ruleDomain, hostId: entryHostId, hostName: plan.name(entryHostId),
        expected, resolved: lookup.addresses, error: lookup.error, publishError: rule.entryDomainError ? String(rule.entryDomainError) : null,
      }));
    }));
  } else if (rule && String(rule.entryDomainError || "").trim()) {
    plan.panel({ key: "entry.domain", group: "entry", title: "入口域名", status: "warn", summary: `入口域名没发布成功：${String(rule.entryDomainError).trim()}`, hint: "检查系统设置里的入口域名 / DNS 接口配置", source: "panel", hostId: entryHostId, hostName: plan.name(entryHostId) });
  }
  const ddnsDomain = String(host?.ddnsDomain || "").trim();
  if (host && dbBool(host.ddnsEnabled) && ddnsDomain) {
    checks.push(lookupWithTimeout(ddnsDomain).then((lookup) => {
      plan.panel(evaluateDomainItem({
        key: `entry.ddns:${entryHostId}`, label: "主机 DDNS", domain: ddnsDomain, hostId: entryHostId, hostName: plan.name(entryHostId),
        expected, resolved: lookup.addresses, error: lookup.error, publishError: host.lastDdnsError ? String(host.lastDdnsError) : null,
      }));
    }));
  }
  await Promise.all(checks);
}

async function planPortConflict(plan: PlanBuilder, rule: any, hostIds: number[], excludeRuleIds: number[]) {
  const port = positive(rule?.sourcePort);
  if (!port) return;
  for (const hostId of hostIds) {
    try {
      const used = await db.isPortUsedOnHost(hostId, port, excludeRuleIds, rule.protocol, undefined, false);
      const reason = used ? await db.entryBridgePortConflictMessageForHosts([hostId], port, excludeRuleIds).catch(() => null) : null;
      plan.panel(evaluatePortConflictItem({ hostId, hostName: plan.name(hostId), port, used, reason }));
    } catch (error) {
      plan.panel(evaluatePortConflictItem({ hostId, hostName: plan.name(hostId), port, used: false, error: safeMessage(error) }));
    }
  }
}

async function portPolicyFacts(rule: any, tunnel: any | null, owner: any) {
  const hostId = positive(rule?.hostId);
  const port = positive(rule?.sourcePort);
  if (!hostId || !port || dbBool(rule?.isForwardGroupTemplate)) return null;
  const host = await db.getHostById(hostId);
  if (!host) return null;
  const base = tunnel
    ? combineHostPortPolicyWithRange(host as any, tunnel.portRangeStart, tunnel.portRangeEnd)
    : portPolicyFrom(host as any);
  if (!isPortAllowedByPolicy(port, base)) return { allowed: false, reason: portPolicyErrorMessage(base) };
  if (owner && String(owner.role) !== "admin") {
    const planRange = await db.getUserPlanPortRange(Number(owner.id), hostId, tunnel ? Number(tunnel.id) : undefined).catch(() => null);
    if (planRange) {
      const effective = combinePortPolicies(base, portPolicyFrom({ portRanges: planRange.ranges } as any));
      if (!isPortAllowedByPolicy(port, effective)) return { allowed: false, reason: portPolicyErrorMessage(effective, "套餐端口") };
    }
  }
  return { allowed: true };
}

/** 隧道本身的链路：每台中转 / 出口上监听口在不在、防火墙，每一段下一跳拨不拨得通，出口的进程。 */
async function planTunnelLinks(plan: PlanBuilder, tunnel: any, hops: any[], options: { includeRuntime: boolean }) {
  const edges = tunnelHopEdges(tunnel, hops, plan.hosts);
  const wireGuard = isForwardXWireGuardV2(tunnel);
  const exitHostId = positive(tunnel.exitHostId);
  for (const edge of edges) {
    const toName = plan.name(edge.toHostId);
    const isExit = edge.toHostId === exitHostId;
    if (options.includeRuntime) {
      const running = isExit && edges.length === 1
        ? dbBool(tunnel.isRunning)
        : getTunnelRuntimeHostStatus(Number(tunnel.id), edge.toHostId) ?? (isExit ? dbBool(tunnel.isRunning) : undefined);
      plan.panel(evaluateRuntimeItem({
        key: `runtime.tunnel:${edge.toHostId}`, group: "link", hostId: edge.toHostId, hostName: toName,
        what: "隧道", running, hostOnline: plan.online(edge.toHostId),
      }));
    }
    if (edge.port > 0) {
      plan.agent(edge.toHostId, "link", `「${toName}」隧道端口 ${edge.port} 在监听`, { kind: "listen", port: edge.port, protocol: wireGuard ? "udp" : "any" });
      plan.agent(edge.toHostId, "link", `「${toName}」防火墙放行隧道端口 ${edge.port}`, { kind: "firewall", port: edge.port, protocol: wireGuard ? "udp" : "tcp" });
    }
    if (isExit) {
      plan.agent(edge.toHostId, "link", `「${toName}」隧道进程在运行`, { kind: "process", forwardType: isForwardXTunnel(tunnel) ? "fxp" : "tunnel", tunnelId: Number(tunnel.id), port: edge.port });
    }
    if (!edge.address || edge.port <= 0) {
      plan.panel({ key: `link.edge:${edge.fromHostId}-${edge.toHostId}`, group: "link", title: `「${plan.name(edge.fromHostId)}」→「${toName}」`, status: "fail", summary: "算不出下一跳的地址或端口", hint: "检查隧道的连接地址和出口主机的 IP", source: "panel" });
      continue;
    }
    if (wireGuard) {
      plan.panel({ key: `link.edge:${edge.fromHostId}-${edge.toHostId}`, group: "link", title: `「${plan.name(edge.fromHostId)}」→「${toName}」`, status: "skip", summary: "NEX v2 走 WireGuard（UDP），没法用 TCP 连接测；看「延迟测试」", source: "panel" });
      continue;
    }
    plan.agent(edge.fromHostId, "link", `「${plan.name(edge.fromHostId)}」→「${toName}」${formatHostPort(edge.address, edge.port)}`, { kind: "dial", host: edge.address, port: edge.port, protocol: "tcp" }, "hop");
  }
}

async function planRule(plan: PlanBuilder, rule: any, options: { subjectKind: DiagnosticSubjectKind; group?: any | null }) {
  const protocolSettings = await getForwardProtocolSettings();
  const owner = positive(rule.userId) ? await db.getUserById(Number(rule.userId)) as any : null;
  const tunnel = positive(rule.tunnelId) ? await db.getTunnelById(Number(rule.tunnelId)) as any : null;
  const group = options.group ?? (positive(rule.forwardGroupId) ? await db.getForwardGroupById(Number(rule.forwardGroupId)) as any : null);
  const protocolKey = getRuleProtocolKey(rule, tunnel);

  plan.slots.push(...evaluateConfigItems({
    subjectKind: options.subjectKind,
    rule,
    tunnel: tunnel ? { name: String(tunnel.name || `#${tunnel.id}`), isEnabled: tunnel.isEnabled, disabledByGroup: tunnel.disabledByGroup } : null,
    group: group && options.subjectKind === "forwardGroup" ? { name: String(group.name || `#${group.id}`), isEnabled: group.isEnabled } : null,
    protocolEnabled: isForwardProtocolKeyEnabled(protocolSettings, protocolKey) && !(rule.forwardType === "gost" && tunnel && !getTunnelProtocolKey(tunnel)),
    protocolLabel: protocolKey ? FORWARD_PROTOCOL_LABELS[protocolKey] : String(rule.forwardType || ""),
    forwardTypeAllowed: forwardTypeAllowedFor(owner, String(rule.forwardType || "")),
    portPolicy: await portPolicyFacts(rule, tunnel, owner).catch(() => null),
    owner: await ownerFacts(rule.userId),
  }).map((item) => ({ kind: "panel" as const, item })));

  const target = String(rule.targetIp || "").trim();
  const targetPort = positive(rule.targetPort);

  /* 转发组模板：真正跑的是组里每台主机上的子规则。 */
  if (dbBool(rule.isForwardGroupTemplate) && group) {
    const children = ((await db.getForwardGroupChildRulesForTemplate(Number(rule.id))) as any[])
      .filter((child) => !dbBool(child.pendingDelete));
    const isChain = String(group.groupMode || "failover") === "chain";
    if (isChain) {
      const probes = await db.getForwardGroupChainProbes(Number(group.id), { includeFinalTarget: true, templateRule: rule }).catch(() => []) as any[];
      const finalIndex = probes.length - 1;
      await plan.loadHosts([...children.map((child) => child.hostId), ...probes.map((probe) => probe.fromHostId)]);
      probes.forEach((probe, index) => {
        plan.role(positive(probe.fromHostId), index === 0 ? "入口" : index === finalIndex ? "出口" : "中转");
      });
      for (const child of children) plan.role(positive(child.hostId), "中转");
      for (const child of children.slice(0, 12)) {
        const hostId = positive(child.hostId);
        const isEntry = plan.roles.get(hostId) === "入口";
        plan.panel(evaluateRuntimeItem({
          key: `runtime.rule:${child.id}`, group: isEntry ? "entry" : "link", hostId, hostName: plan.name(hostId),
          what: "规则", running: dbBool(child.isRunning), hostOnline: plan.online(hostId),
        }));
        planEntryListener(plan, {
          hostId, port: positive(child.sourcePort), protocol: child.protocol, forwardType: child.forwardType,
          group: isEntry ? "entry" : "link", label: isEntry ? undefined : `「${plan.name(hostId)}」`,
        });
      }
      const entryHostIds = children.filter((child) => plan.roles.get(positive(child.hostId)) === "入口").map((child) => positive(child.hostId));
      await planPortConflict(plan, rule, Array.from(new Set(entryHostIds)), [Number(rule.id), ...children.map((child) => Number(child.id))]);
      if (entryHostIds[0]) await planEntryDomains(plan, rule, entryHostIds[0]);
      probes.forEach((probe, index) => {
        const fromHostId = positive(probe.fromHostId);
        if (index === finalIndex && target && String(probe.targetIp) === target) return; // 最后一段就是目标，下面单独测
        // 链上每一段的监听口都是 TCP 可连的（延迟探测用 ping 的那几段也照样能拨端口）；没端口的段跳过。
        if (!probe.targetIp || positive(probe.targetPort) <= 0) return;
        plan.agent(fromHostId, "link", `「${plan.name(fromHostId)}」→ ${probe.hopLabel || formatHostPort(String(probe.targetIp), Number(probe.targetPort))}`, {
          kind: "dial", host: String(probe.targetIp), port: Number(probe.targetPort), protocol: "tcp",
        }, "hop");
      });
      await planTargetAddress(plan, target);
      const lastProbe = probes[finalIndex];
      const dialHostId = positive(lastProbe?.fromHostId) || positive(children[children.length - 1]?.hostId);
      planTargetDial(plan, dialHostId, target, targetPort, rule.protocol);
      return;
    }
    // 非链式的组：每个成员上一条子规则，各自拨目标。
    await plan.loadHosts(children.map((child) => child.hostId));
    for (const child of children) plan.role(positive(child.hostId), "成员");
    for (const child of children.slice(0, 8)) {
      const hostId = positive(child.hostId);
      plan.panel(evaluateRuntimeItem({ key: `runtime.rule:${child.id}`, group: "entry", hostId, hostName: plan.name(hostId), what: "规则", running: dbBool(child.isRunning), hostOnline: plan.online(hostId) }));
      planEntryListener(plan, { hostId, port: positive(child.sourcePort), protocol: child.protocol, forwardType: child.forwardType, label: `「${plan.name(hostId)}」` });
    }
    await planPortConflict(plan, rule, Array.from(new Set(children.map((child) => positive(child.hostId)))), [Number(rule.id), ...children.map((child) => Number(child.id))]);
    await planTargetAddress(plan, target);
    for (const child of children.slice(0, 8)) {
      if (positive(child.tunnelId)) continue;
      const childTarget = String(child.targetIp || target);
      const childPort = positive(child.targetPort) || targetPort;
      if (await planEgressPath(plan, child, positive(child.hostId), childTarget, childPort)) continue;
      planTargetDial(plan, positive(child.hostId), childTarget, childPort, child.protocol);
    }
    if (children.length === 0) {
      plan.panel({ key: "config.children", group: "config", title: "组成员规则", status: "fail", summary: "转发组里还没有生成成员规则", hint: "检查组里有没有启用的成员，然后重新保存一次规则", source: "panel" });
    }
    return;
  }

  /* 隧道规则：入口在规则主机，目标从出口拨。 */
  if (tunnel) {
    const hops = await db.getTunnelHops(Number(tunnel.id)).catch(() => []) as any[];
    const fxp = isForwardXTunnel(tunnel);
    await plan.loadHosts([rule.hostId, tunnel.entryHostId, tunnel.exitHostId, ...hops.map((hop) => hop.hostId)]);
    const entryHostId = positive(rule.hostId) || positive(tunnel.entryHostId);
    const exitHostId = positive(tunnel.exitHostId);
    plan.role(entryHostId, "入口", { fxp });
    for (const hop of hops) {
      const hostId = positive(hop.hostId);
      if (hostId !== entryHostId && hostId !== exitHostId) plan.role(hostId, "中转", { fxp });
    }
    plan.role(exitHostId, "出口", { fxp });
    plan.panel(evaluateRuntimeItem({ key: `runtime.rule:${rule.id}`, group: "entry", hostId: entryHostId, hostName: plan.name(entryHostId), what: "规则", running: dbBool(rule.isRunning), hostOnline: plan.online(entryHostId) }));
    await planPortConflict(plan, rule, [entryHostId], [Number(rule.id)]);
    await planEntryDomains(plan, rule, entryHostId);
    planEntryListener(plan, { hostId: entryHostId, port: positive(rule.sourcePort), protocol: rule.protocol, forwardType: rule.forwardType, tunnel });
    await planTunnelLinks(plan, tunnel, hops, { includeRuntime: true });
    await planTargetAddress(plan, target);
    planTargetDial(plan, exitHostId, target, targetPort, rule.protocol);
    return;
  }

  /* 直连规则。 */
  const entryHostId = positive(rule.hostId);
  await plan.loadHosts([entryHostId]);
  plan.role(entryHostId, "入口");
  plan.panel(evaluateRuntimeItem({ key: `runtime.rule:${rule.id}`, group: "entry", hostId: entryHostId, hostName: plan.name(entryHostId), what: "规则", running: dbBool(rule.isRunning), hostOnline: plan.online(entryHostId) }));
  await planPortConflict(plan, rule, [entryHostId], [Number(rule.id)]);
  await planEntryDomains(plan, rule, entryHostId);
  planEntryListener(plan, { hostId: entryHostId, port: positive(rule.sourcePort), protocol: rule.protocol, forwardType: rule.forwardType });
  await planTargetAddress(plan, target);
  if (await planEgressPath(plan, rule, entryHostId, target, targetPort)) return;
  planTargetDial(plan, entryHostId, target, targetPort, rule.protocol);
}

async function planTunnel(plan: PlanBuilder, tunnel: any) {
  const protocolSettings = await getForwardProtocolSettings();
  const key = getTunnelProtocolKey(tunnel);
  plan.slots.push(...evaluateConfigItems({
    subjectKind: "tunnel",
    rule: null,
    tunnel: { name: String(tunnel.name || `#${tunnel.id}`), isEnabled: tunnel.isEnabled, disabledByGroup: tunnel.disabledByGroup },
    protocolEnabled: key !== null && isForwardProtocolKeyEnabled(protocolSettings, key),
    protocolLabel: key ? FORWARD_PROTOCOL_LABELS[key] : String(tunnel.mode || ""),
    forwardTypeAllowed: null,
    portPolicy: null,
    owner: await ownerFacts(tunnel.userId),
  }).map((item) => ({ kind: "panel" as const, item })));
  const hops = await db.getTunnelHops(Number(tunnel.id)).catch(() => []) as any[];
  const fxp = isForwardXTunnel(tunnel);
  const entryHostId = positive(tunnel.entryHostId);
  const exitHostId = positive(tunnel.exitHostId);
  await plan.loadHosts([entryHostId, exitHostId, ...hops.map((hop) => hop.hostId)]);
  plan.role(entryHostId, "入口", { fxp });
  for (const hop of hops) {
    const hostId = positive(hop.hostId);
    if (hostId !== entryHostId && hostId !== exitHostId) plan.role(hostId, "中转", { fxp });
  }
  plan.role(exitHostId, "出口", { fxp });
  await planTunnelLinks(plan, tunnel, hops, { includeRuntime: true });
}

async function buildPlan(ctx: Ctx, subject: { kind: DiagnosticSubjectKind; id: number }) {
  const plan = new PlanBuilder(ctx);
  const isAdmin = ctx.user.role === "admin";
  let name = "";
  if (subject.kind === "rule") {
    const rule = await db.getForwardRuleById(subject.id) as any;
    if (!rule || dbBool(rule.pendingDelete)) throw new Error("规则不存在或已删除");
    if (!isAdmin && Number(rule.userId) !== Number(ctx.user.id)) throw new Error("无权诊断此规则");
    name = String(rule.name || `规则 #${rule.id}`);
    await planRule(plan, rule, { subjectKind: "rule" });
  } else if (subject.kind === "tunnel") {
    const tunnel = await db.getTunnelById(subject.id) as any;
    if (!tunnel) throw new Error("隧道不存在");
    if (!isAdmin && Number(tunnel.userId) !== Number(ctx.user.id)) throw new Error("无权诊断此隧道");
    name = String(tunnel.name || `隧道 #${tunnel.id}`);
    await planTunnel(plan, tunnel);
  } else {
    const group = await db.getForwardGroupById(subject.id) as any;
    if (!group) throw new Error("转发链不存在");
    if (!isAdmin && Number(group.userId) !== Number(ctx.user.id) && !(await db.checkUserForwardGroupPermission(ctx.user.id, subject.id))) {
      throw new Error("无权诊断此转发链");
    }
    name = String(group.name || `转发链 #${group.id}`);
    const template = await db.getForwardGroupPrimaryTemplateRule(subject.id) as any;
    if (!template) {
      plan.panel({ key: "config.enabled", group: "config", title: "转发链已启用", status: dbBool(group.isEnabled, true) ? "pass" : "fail", summary: dbBool(group.isEnabled, true) ? "已启用" : "转发链已停用", source: "panel" });
      plan.panel({ key: "config.template", group: "config", title: "转发链上的规则", status: "fail", summary: "这条转发链上还没有规则，没有可诊断的流量路径", hint: "先在这条链上添加一条转发规则", source: "panel" });
    } else {
      if (!isAdmin && Number(template.userId) !== Number(ctx.user.id) && Number(group.userId) !== Number(ctx.user.id)) {
        throw new Error("无权诊断此转发链");
      }
      await planRule(plan, template, { subjectKind: "forwardGroup", group });
    }
  }
  return { plan, name };
}

/* ───────────────────────── 对外 ───────────────────────── */

function reportFor(session: Session): LinkDiagnosticsReport {
  const items: DiagnosticItem[] = [];
  const agentByHost = new Map<number, PlannedAgentCheck[]>();
  for (const slot of session.slots) {
    if (slot.kind === "agent") {
      const list = agentByHost.get(slot.planned.hostId) || [];
      list.push(slot.planned);
      agentByHost.set(slot.planned.hostId, list);
    }
  }
  const agentItemByKey = new Map<string, DiagnosticItem>();
  for (const [hostId, planned] of agentByHost) {
    const gate = session.gates.get(hostId) || { online: false, detailVisible: false };
    const task = gate.taskId ? getDiagnosticsTaskStatus(gate.taskId) : null;
    for (const entry of agentCheckItems(planned, gate, task)) agentItemByKey.set(entry.key, entry);
  }
  for (const slot of session.slots) {
    if (slot.kind === "panel") items.push(slot.item);
    else {
      const key = `agent:${slot.planned.hostId}:${slot.planned.check.id}`;
      const entry = agentItemByKey.get(key);
      if (entry) items.push(entry);
    }
  }
  // 同组的放在一起，组内保持计划时的顺序。
  const order = new Map(DIAGNOSTIC_GROUPS.map((group, index) => [group, index] as const));
  const sorted = items.map((value, index) => ({ value, index }))
    .sort((a, b) => (order.get(a.value.group)! - order.get(b.value.group)!) || a.index - b.index)
    .map(({ value }) => value);
  return buildDiagnosticsReport({ sessionId: session.id, subject: session.subject, startedAt: session.startedAt, items: sorted });
}

export async function startLinkDiagnostics(ctx: Ctx, subject: { kind: DiagnosticSubjectKind; id: number }): Promise<LinkDiagnosticsReport> {
  pruneSessions();
  const { plan, name } = await buildPlan(ctx, subject);
  const slots: Slot[] = [];
  // 主机组的项放在配置后面、入口前面（reportFor 按组排序，这里顺序无所谓）。
  slots.push(...plan.hostItems().map((item) => ({ kind: "panel" as const, item })), ...plan.slots);
  const gates = new Map<number, AgentHostGate>();
  const checksByHost = new Map<number, DiagnosticsAgentCheck[]>();
  for (const slot of slots) {
    if (slot.kind !== "agent") continue;
    const list = checksByHost.get(slot.planned.hostId) || [];
    list.push(slot.planned.check);
    checksByHost.set(slot.planned.hostId, list);
  }
  const isAdmin = ctx.user.role === "admin";
  for (const [hostId, checks] of checksByHost) {
    const host = plan.hosts.get(hostId);
    const gate: AgentHostGate = {
      online: !!host?.isOnline,
      agentVersion: host?.agentVersion ? String(host.agentVersion) : null,
      detailVisible: isAdmin || Number(host?.userId) === Number(ctx.user.id),
    };
    if (gate.online && agentSupportsDiagnostics(gate.agentVersion) && String(host?.agentToken || "")) {
      try {
        gate.taskId = enqueueDiagnosticsAgentTask(hostId, checks).taskId;
        pushAgentRefresh(hostId, "link-diagnostics", { urgent: true });
      } catch (error) {
        appendPanelLog("warn", `[Diagnostics] host=${hostId} enqueue failed: ${safeMessage(error)}`);
      }
    }
    gates.set(hostId, gate);
  }
  const session: Session = {
    id: crypto.randomUUID(),
    userId: Number(ctx.user.id),
    subject: { kind: subject.kind, id: subject.id, name },
    startedAt: new Date().toISOString(),
    slots,
    gates,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(session.id, session);
  appendPanelLog("info", `[Diagnostics] start ${subject.kind}=${subject.id} user=${ctx.user.id} hosts=${checksByHost.size} agentChecks=${[...checksByHost.values()].reduce((sum, list) => sum + list.length, 0)}`);
  return reportFor(session);
}

export function getLinkDiagnosticsReport(ctx: Ctx, sessionId: string): LinkDiagnosticsReport {
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) throw new Error("这次诊断已过期，请重新诊断");
  if (ctx.user.role !== "admin" && session.userId !== Number(ctx.user.id)) throw new Error("这次诊断已过期，请重新诊断");
  return reportFor(session);
}
