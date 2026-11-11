import { isAgentVersionAtLeast } from "@shared/version";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";
import { classifyRuleRuntimeFailure, type RuleRuntimeFailureKind, type RuleRuntimeFailureOptions } from "./ruleRuntimeFailureText";

/*
  主机实际监听端口核对（端口占用告警）。

  两路来源，结论都只放内存（和「内核快速转发」的状态一样，面板重启后等下一轮上报，最多一分钟）：
    · 黄：Agent 的扩展模块 ports（agent/ext_ports.go，面板端 server/ops/portOccupancyAgent.ts）每轮报一次
      「启用规则的入口端口上，有不归 ForwardX 管的进程在监听」。内核转发（iptables / nftables）不绑
      socket，外来进程照样能听这个端口而不报错，只能靠这条核对发现；
    · 红：规则的动作状态（/api/agent/rule-status）里绑定失败的原因 —— 用户态转发起不来时 Agent 会说
      「port 443/tcp occupied by nginx (pid 812)」或者 address already in use；内核转发装不上 DOCKER-USER
      放行之类（[docker-compat]）也在这里显示，不再只剩一个「没运行」。用户态转发监听没起来的原因
      （IPv6 不可用、运行时没装、服务日志里的报错，Agent 2.2.256 起带上）也是这一路，见 ruleRuntimeFailureText.ts。
  冲突消失（下一轮上报不再有、规则报运行）就清掉。随机分配端口时避开最近见过被占的端口
  （tunnelRepository.findAvailablePort 调 knownOccupiedPortsOnHost）。

  这里不碰数据库：tunnelRepository 也要引它，引了仓库层会成环。
*/

/** 从这个 Agent 版本起有 ports 扩展模块（agent/ext_ports.go）；更老的不发指令，也就不会有黄色告警。 */
export const AGENT_PORT_OCCUPANCY_VERSION = "2.2.255";

export function agentSupportsPortOccupancy(agentVersion: string | null | undefined) {
  return isAgentVersionAtLeast(agentVersion, AGENT_PORT_OCCUPANCY_VERSION);
}

export type PortOccupancyListener = { address: string; process?: string; pid?: number };
export type PortOccupancyConflict = {
  ruleId: number;
  port: number;
  protocol: "tcp" | "udp";
  forwardType: string;
  listeners: PortOccupancyListener[];
};
export type PortOccupancyReport = {
  usable: boolean;
  collectedAt: number;
  checkedPorts: number;
  conflicts: PortOccupancyConflict[];
};

export type RulePortWarning = {
  level: "warn" | "error";
  /** runtime：用户态转发的监听没起来（IPv6 不可用、运行时没装……），原因见 ruleRuntimeFailureText.ts。 */
  kind: "occupied" | RuleRuntimeFailureKind;
  label: string;
  message: string;
  hostId: number;
  port: number;
};

const MAX_HOSTS = 10_000;
const MAX_CONFLICTS_PER_HOST = 200;
const MAX_LISTENERS = 8;
const MAX_FAILURES = 20_000;
/** 一台主机多久没报就不再显示它的黄色告警（扩展通道 60 秒一轮，留出几轮的余量）。 */
export const PORT_OCCUPANCY_FRESH_MS = 10 * 60 * 1000;
/** 绑定失败多久没再报就不显示：失败的规则每次心跳都会重下发、重报，一直没消息说明已经不在重试了。 */
const RULE_FAILURE_TTL_MS = 2 * 60 * 60 * 1000;
/** 随机分配避开「最近见过被占」的端口：规则删掉以后外来进程多半还在，过了这么久再给机会。 */
const KNOWN_OCCUPIED_TTL_MS = 6 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;

type StoredConflict = PortOccupancyConflict & { displayRuleId: number };
const hostConflicts = new Map<number, { receivedAt: number; collectedAt: number; conflicts: StoredConflict[] }>();
type StoredFailure = { hostId: number; kind: RuleRuntimeFailureKind; label: string; port: number; admin: string; user: string; at: number };
/** 键：展示用的规则编号（转发组成员 / 线路组中继算到模板上），再按主机分。 */
const ruleFailures = new Map<number, Map<number, StoredFailure>>();
const knownOccupied = new Map<number, Map<string, number>>();

type RawRecord = Record<string, unknown>;
/** 规则行：列表、状态回执里传进来的都是数据库行，这里只读几个字段。 */
type RuleRow = RawRecord;

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : {};
}

function positiveInt(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= max ? number : 0;
}

function cleanText(value: unknown, limit: number) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit);
}

/** 校验 Agent 的上报：格式不对整份丢掉（返回 null），不拿半份去清别人的告警。 */
export function parsePortOccupancyReport(raw: unknown, now = Date.now()): PortOccupancyReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as RawRecord;
  if (input.schema !== 1 || typeof input.usable !== "boolean" || !Array.isArray(input.conflicts)) return null;
  const collectedAt = Number(input.collectedAt);
  if (!Number.isFinite(collectedAt) || collectedAt <= 0 || collectedAt > now + FUTURE_SKEW_MS) return null;
  const rawConflicts = input.conflicts as unknown[];
  if (rawConflicts.length > MAX_CONFLICTS_PER_HOST) return null;
  const conflicts: PortOccupancyConflict[] = [];
  for (const rawItem of rawConflicts) {
    const item = asRecord(rawItem);
    const ruleId = positiveInt(item.ruleId);
    const port = positiveInt(item.port, 65535);
    const protocol = item.protocol === "tcp" || item.protocol === "udp" ? item.protocol : null;
    const rawListeners = Array.isArray(item.listeners) ? item.listeners as unknown[] : [];
    if (!ruleId || !port || !protocol || rawListeners.length === 0) return null;
    const listeners: PortOccupancyListener[] = [];
    for (const rawListener of rawListeners.slice(0, MAX_LISTENERS)) {
      const listener = asRecord(rawListener);
      const address = cleanText(listener.address, 64);
      if (!address) return null;
      const process = cleanText(listener.process, 64);
      const pid = positiveInt(listener.pid, 4_194_304);
      listeners.push({ address, ...(process ? { process } : {}), ...(pid ? { pid } : {}) });
    }
    conflicts.push({ ruleId, port, protocol, forwardType: cleanText(item.forwardType, 32), listeners });
  }
  return { usable: input.usable, collectedAt, checkedPorts: Math.max(0, Math.floor(Number(input.checkedPorts) || 0)), conflicts };
}

function rememberOccupied(hostId: number, port: number, protocols: Array<"tcp" | "udp">, now: number) {
  let ports = knownOccupied.get(hostId);
  if (!ports) {
    ports = new Map();
    setBoundedMapValue(knownOccupied, hostId, ports, MAX_HOSTS);
  }
  for (const protocol of protocols) ports.set(`${port}/${protocol}`, now);
}

/**
 * 收一台主机的一轮上报。displayRuleIdOf 把 Agent 报的规则编号换成界面上那条（转发组成员规则算到模板上）；
 * 返回 0 表示这条规则已经删了 / 停了 / 不归这台主机，丢掉。usable 为 false 的一轮什么都确认不了：
 * 保留上一轮的结论，但不续期，十分钟后自然消失。
 */
export function recordHostPortOccupancy(
  hostId: number,
  report: PortOccupancyReport,
  displayRuleIdOf: (ruleId: number) => number,
  now = Date.now(),
) {
  if (!positiveInt(hostId) || !report.usable) return;
  const conflicts: StoredConflict[] = [];
  for (const conflict of report.conflicts) {
    const displayRuleId = positiveInt(displayRuleIdOf(conflict.ruleId));
    if (!displayRuleId) continue;
    conflicts.push({ ...conflict, displayRuleId });
    rememberOccupied(hostId, conflict.port, [conflict.protocol], now);
  }
  setBoundedMapValue(hostConflicts, hostId, { receivedAt: now, collectedAt: report.collectedAt, conflicts }, MAX_HOSTS);
}

/** 展示用的规则编号：转发组成员规则、线路组中继规则的告警挂到用户看得到的那条上。 */
export function displayRuleIdForRow(rule: RuleRow | null | undefined) {
  return positiveInt(rule?.forwardGroupRuleId) || positiveInt(rule?.routeParentRuleId) || positiveInt(rule?.id);
}

/** 归类和中文原因在 ruleRuntimeFailureText.ts（事件时间线、规则异常提醒也用它）；这里沿用老名字导出。 */
export { classifyRuleRuntimeFailure };

/**
 * 规则状态回执（agentStatusRoutes.applyAgentRuleStatus）：报运行就清掉这台主机上的失败；报没运行且原因认得出来
 * 就记下。认不出的原因不动已有记录 —— 同一次失败后面跟着的通用回执不该把具体原因冲掉。
 */
export function recordRuleRuntimeStatus(input: { rule: RuleRow; hostId: number; isRunning: boolean; message?: unknown } & RuleRuntimeFailureOptions, now = Date.now()) {
  const hostId = positiveInt(input.hostId);
  const displayRuleId = displayRuleIdForRow(input.rule);
  if (!hostId || !displayRuleId) return;
  if (input.isRunning) {
    const perHost = ruleFailures.get(displayRuleId);
    if (perHost?.delete(hostId) && perHost.size === 0) ruleFailures.delete(displayRuleId);
    return;
  }
  const port = positiveInt(input.rule?.sourcePort, 65535);
  const failure = classifyRuleRuntimeFailure(input.message, port, { agentVersion: input.agentVersion });
  if (!failure) return;
  let perHost = ruleFailures.get(displayRuleId);
  if (!perHost) {
    perHost = new Map();
    setBoundedMapValue(ruleFailures, displayRuleId, perHost, MAX_FAILURES);
  }
  perHost.set(hostId, { ...failure, hostId, at: now });
  if (failure.kind === "bind" && failure.port) {
    const protocol = String(input.rule?.protocol || "").toLowerCase();
    rememberOccupied(hostId, failure.port, protocol === "udp" ? ["udp"] : protocol === "tcp" ? ["tcp"] : ["tcp", "udp"], now);
  }
}

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function describeListeners(conflict: StoredConflict, admin: boolean) {
  const proto = conflict.protocol.toUpperCase();
  if (!admin) return `入口端口 ${conflict.port}/${proto} 有其他程序在监听`;
  const owners = conflict.listeners.map((listener) => {
    const owner = listener.process ? `${listener.process}${listener.pid ? `（pid ${listener.pid}）` : ""}` : "未知进程";
    return `${proto} ${listener.address}:${conflict.port} ← ${owner}`;
  });
  return `入口端口有其他程序在监听：${owners.join("、")}`;
}

/** 一条规则（列表里用户看得到的那条）此刻的端口告警。停用 / 待删除的规则不显示。 */
export function getRulePortWarnings(rule: RuleRow, admin: boolean, now = Date.now()): RulePortWarning[] {
  const ruleId = positiveInt(rule?.id);
  if (!ruleId || !truthy(rule?.isEnabled) || truthy(rule?.pendingDelete)) return [];
  const warnings: RulePortWarning[] = [];
  const failures = ruleFailures.get(ruleId);
  for (const failure of failures?.values() || []) {
    if (now - failure.at > RULE_FAILURE_TTL_MS) continue;
    warnings.push({
      level: "error",
      kind: failure.kind,
      label: failure.label,
      message: admin ? failure.admin : failure.user,
      hostId: failure.hostId,
      port: failure.port,
    });
  }
  for (const [hostId, entry] of hostConflicts) {
    if (now - entry.receivedAt > PORT_OCCUPANCY_FRESH_MS) continue;
    for (const conflict of entry.conflicts) {
      if (conflict.displayRuleId !== ruleId) continue;
      // 同一台主机上这条规则已经报了绑定失败：红的那条已经说清楚了，不再叠一条黄的。
      if (warnings.some((item) => item.kind === "bind" && item.hostId === hostId)) continue;
      warnings.push({
        level: "warn",
        kind: "occupied",
        label: "端口被占用",
        message: describeListeners(conflict, admin),
        hostId,
        port: conflict.port,
      });
    }
  }
  return warnings;
}

/** 给规则列表（list / listPage / mapItems）带上 portWarnings；没有告警的行原样返回，不多一个字段。 */
export function withRulePortWarnings<T>(value: T, admin: boolean, now = Date.now()): T {
  if (hostConflicts.size === 0 && ruleFailures.size === 0) return value;
  const decorate = (row: unknown) => {
    const rule = asRecord(row);
    const warnings = getRulePortWarnings(rule, admin, now);
    return warnings.length > 0 ? { ...rule, portWarnings: warnings } : row;
  };
  if (Array.isArray(value)) return value.map(decorate) as T;
  const page = asRecord(value);
  if (Array.isArray(page.items)) return { ...page, items: (page.items as unknown[]).map(decorate) } as T;
  return value;
}

/** 随机分配端口时要避开的：这台主机上最近见过被外来进程占着的端口（按协议）。 */
export function knownOccupiedPortsOnHost(hostId: number, protocol?: unknown, now = Date.now()): number[] {
  const ports = knownOccupied.get(Number(hostId));
  if (!ports) return [];
  const wanted = String(protocol || "").toLowerCase();
  const result = new Set<number>();
  for (const [key, seenAt] of ports) {
    if (now - seenAt > KNOWN_OCCUPIED_TTL_MS) {
      ports.delete(key);
      continue;
    }
    const [portText, proto] = key.split("/");
    if ((wanted === "tcp" || wanted === "udp") && proto !== wanted) continue;
    result.add(Number(portText));
  }
  return Array.from(result);
}

export function prunePortOccupancy(now = Date.now()) {
  pruneMapEntries(hostConflicts, (entry) => now - entry.receivedAt > PORT_OCCUPANCY_FRESH_MS * 6);
  for (const [ruleId, perHost] of ruleFailures) {
    pruneMapEntries(perHost, (failure) => now - failure.at > RULE_FAILURE_TTL_MS);
    if (perHost.size === 0) ruleFailures.delete(ruleId);
  }
  for (const [hostId, ports] of knownOccupied) {
    pruneMapEntries(ports, (seenAt) => now - seenAt > KNOWN_OCCUPIED_TTL_MS);
    if (ports.size === 0) knownOccupied.delete(hostId);
  }
}

/** 只给测试用：清空内存里的状态。 */
export function resetPortOccupancyForTests() {
  hostConflicts.clear();
  ruleFailures.clear();
  knownOccupied.clear();
}
