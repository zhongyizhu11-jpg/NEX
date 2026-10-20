/*
  一键链路诊断：每一项「通过 / 警告 / 失败 / 跳过 / 等待」怎么判，全在这里，都是纯函数。

  取数据（查库、DNS、排 Agent 任务）在 server/linkDiagnostics.ts；这里只拿已经取好的
  事实给结论和一句修复建议，所以每一项都能拿假数据单测（linkDiagnosticsChecks.test.ts）。
*/

import net from "node:net";
import {
  DIAGNOSTIC_NEEDS_UPGRADE_SUMMARY,
  LINK_DIAGNOSTICS_AGENT_VERSION,
  type DiagnosticGroup,
  type DiagnosticItem,
  type DiagnosticStatus,
} from "../shared/linkDiagnostics";
import { classifyIpAddress, isPrivateOrReservedAddress, sameNetworkAddress } from "../shared/ipAddress";
import { forwardAccessBlockedReasonText } from "../shared/forwardAccessMessage";
import { isAgentVersionAtLeast, isAgentVersionBehind } from "../shared/version";
import { AGENT_VERSION } from "../shared/versions";
import { fxpRuntimeIncompatible, fxpRuntimeIssueMessage } from "../shared/fxpRuntime";
import type { DiagnosticsAgentCheck, DiagnosticsTaskStatus } from "./diagnosticsAgentTasks";

function item(input: Omit<DiagnosticItem, "source"> & { source?: DiagnosticItem["source"] }): DiagnosticItem {
  const out: DiagnosticItem = { source: "panel", ...input };
  if (!out.hint) delete out.hint;
  if (!out.detail) delete out.detail;
  return out;
}

function truthy(value: unknown, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return !!value;
}

function formatTime(value: unknown) {
  if (!value) return "";
  const date = new Date(value as any);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/* ───────────────────────── 配置 ───────────────────────── */

export type DiagnosticOwnerFacts = {
  exists: boolean;
  role: string;
  accountEnabled: unknown;
  canAddRules: unknown;
  pauseReason: string | null;
  expiresAt: unknown;
  trafficLimit: number;
  trafficUsed: number;
  maxRules: number;
  ruleCount: number | null;
};

export type DiagnosticConfigFacts = {
  subjectKind: "rule" | "tunnel" | "forwardGroup";
  /** 规则本身（隧道 / 转发链诊断时是它的模板规则，没有就 null）。 */
  rule: {
    isEnabled: unknown;
    pendingDelete?: unknown;
    disabledByTunnel?: unknown;
    disabledByGroup?: unknown;
    disabledByUser?: unknown;
    protocolBlockReason?: string | null;
    targetIp?: string | null;
    targetPort?: number | null;
    sourcePort?: number | null;
    forwardType?: string | null;
  } | null;
  tunnel?: { name: string; isEnabled: unknown; disabledByGroup?: unknown } | null;
  group?: { name: string; isEnabled: unknown } | null;
  /** 面板「转发协议开关」里这条规则用的协议开着没有。 */
  protocolEnabled: boolean;
  protocolLabel: string;
  /** 主人能不能用这种转发方式；null = 不限（管理员 / 没配白名单）。 */
  forwardTypeAllowed: boolean | null;
  /** 入口端口在主机 / 隧道 / 套餐允许的范围里没有；null = 不适用。 */
  portPolicy: { allowed: boolean; reason?: string } | null;
  owner: DiagnosticOwnerFacts | null;
  now?: number;
};

function enabledItem(facts: DiagnosticConfigFacts): DiagnosticItem {
  const title = facts.subjectKind === "tunnel" ? "隧道已启用" : facts.subjectKind === "forwardGroup" ? "转发链已启用" : "规则已启用";
  if (facts.group && !truthy(facts.group.isEnabled, true)) {
    return item({ key: "config.enabled", group: "config", title, status: "fail", summary: `转发链「${facts.group.name}」已停用`, hint: "在转发链列表里打开它" });
  }
  if (facts.tunnel && !truthy(facts.tunnel.isEnabled, true)) {
    const byGroup = truthy(facts.tunnel.disabledByGroup);
    return item({
      key: "config.enabled", group: "config", title, status: "fail",
      summary: byGroup ? `隧道「${facts.tunnel.name}」随它所在的主机组一起被停用了` : `隧道「${facts.tunnel.name}」已停用`,
      hint: byGroup ? "先恢复入口 / 出口组，再打开隧道" : "在隧道列表里打开它，挂在上面的规则会一起恢复",
    });
  }
  const rule = facts.rule;
  if (rule) {
    if (truthy(rule.pendingDelete)) {
      return item({ key: "config.enabled", group: "config", title, status: "fail", summary: "规则正在删除中", hint: "等删除完成；要继续用请重新建一条" });
    }
    if (!truthy(rule.isEnabled, true)) {
      let summary = "规则已停用";
      let hint = "在规则列表里打开开关";
      if (truthy(rule.disabledByTunnel)) {
        summary = "所在的隧道被停用，规则跟着停了";
        hint = "先恢复隧道，规则会自动恢复";
      } else if (truthy(rule.disabledByGroup)) {
        summary = "所在的转发组被停用，规则跟着停了";
        hint = "先恢复转发组";
      } else if (String(rule.protocolBlockReason || "").trim()) {
        summary = `规则被系统停用：${String(rule.protocolBlockReason).trim()}`;
        hint = "按原因处理（例如换一个没被占用的端口）后手动打开";
      } else if (truthy(rule.disabledByUser)) {
        summary = "规则被手动停用";
      }
      return item({ key: "config.enabled", group: "config", title, status: "fail", summary, hint });
    }
  }
  return item({ key: "config.enabled", group: "config", title, status: "pass", summary: "已启用" });
}

function targetItem(facts: DiagnosticConfigFacts): DiagnosticItem | null {
  if (facts.subjectKind === "tunnel" || !facts.rule) return null;
  const target = String(facts.rule.targetIp || "").trim();
  const port = Number(facts.rule.targetPort || 0);
  if (!target) {
    return item({ key: "config.target", group: "config", title: "目标地址", status: "fail", summary: "没填目标地址", hint: "编辑规则，填上要转发到的 IP 或域名" });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return item({ key: "config.target", group: "config", title: "目标地址", status: "fail", summary: `目标端口 ${port || "（空）"} 不在 1-65535`, hint: "编辑规则，改成正确的目标端口" });
  }
  return item({ key: "config.target", group: "config", title: "目标地址", status: "pass", summary: `${formatHostPort(target, port)}` });
}

export function formatHostPort(host: string, port: number) {
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function portItem(facts: DiagnosticConfigFacts): DiagnosticItem | null {
  if (!facts.portPolicy) return null;
  const port = Number(facts.rule?.sourcePort || 0);
  if (!facts.portPolicy.allowed) {
    return item({
      key: "config.port", group: "config", title: "入口端口在允许范围内", status: "fail",
      summary: facts.portPolicy.reason || `入口端口 ${port} 不在允许范围内`,
      hint: "编辑规则换一个范围内的端口，或请管理员放宽主机 / 隧道 / 套餐的端口范围",
    });
  }
  return item({ key: "config.port", group: "config", title: "入口端口在允许范围内", status: "pass", summary: port > 0 ? `端口 ${port} 允许使用` : "允许" });
}

function forwardTypeItem(facts: DiagnosticConfigFacts): DiagnosticItem {
  const label = facts.protocolLabel || String(facts.rule?.forwardType || "") || "转发方式";
  if (!facts.protocolEnabled) {
    return item({ key: "config.forwardType", group: "config", title: "转发方式可用", status: "fail", summary: `管理员已在「转发协议」里关闭了 ${label}`, hint: "换一种转发方式，或请管理员在系统设置里重新打开" });
  }
  if (facts.forwardTypeAllowed === false) {
    return item({ key: "config.forwardType", group: "config", title: "转发方式可用", status: "fail", summary: `这个账户不允许使用 ${label}`, hint: "换一种允许的转发方式，或请管理员给账户授权" });
  }
  return item({ key: "config.forwardType", group: "config", title: "转发方式可用", status: "pass", summary: label });
}

function ownerItems(facts: DiagnosticConfigFacts): DiagnosticItem[] {
  const owner = facts.owner;
  if (!owner) return [];
  if (!owner.exists) {
    return [item({ key: "config.account", group: "config", title: "账户状态", status: "fail", summary: "规则的主人账户已经不存在", hint: "把规则转给现有用户，或删掉它" })];
  }
  if (owner.role === "admin") {
    return [item({ key: "config.account", group: "config", title: "账户状态", status: "pass", summary: "管理员账户，不受套餐和流量限制" })];
  }
  const now = facts.now ?? Date.now();
  const items: DiagnosticItem[] = [];
  const expiresAt = owner.expiresAt ? new Date(owner.expiresAt as any).getTime() : NaN;
  if (!truthy(owner.accountEnabled, true)) {
    items.push(item({ key: "config.account", group: "config", title: "账户状态", status: "fail", summary: "账户已被停用", hint: "请管理员在用户管理里启用账户" }));
  } else if (Number.isFinite(expiresAt) && expiresAt <= now) {
    items.push(item({ key: "config.account", group: "config", title: "账户状态", status: "fail", summary: `账户已于 ${formatTime(expiresAt)} 到期`, hint: forwardAccessBlockedReasonText("expired") }));
  } else if (!truthy(owner.canAddRules) || String(owner.pauseReason || "").trim()) {
    const reason = String(owner.pauseReason || "").trim() || null;
    items.push(item({
      key: "config.account", group: "config", title: "账户状态", status: "fail",
      summary: reason === "manual" || !reason ? "账户的转发权限被关闭" : "账户的转发被暂停",
      hint: reason === "manual" || !reason ? "请管理员在用户管理里打开「转发」" : forwardAccessBlockedReasonText(reason),
    }));
  } else {
    const days = Number.isFinite(expiresAt) ? Math.ceil((expiresAt - now) / 86_400_000) : null;
    items.push(item({
      key: "config.account", group: "config", title: "账户状态",
      status: days !== null && days <= 3 ? "warn" : "pass",
      summary: days === null ? "正常，永不过期" : `正常，${formatTime(expiresAt)} 到期（还剩 ${days} 天）`,
      hint: days !== null && days <= 3 ? "快到期了，记得续期" : undefined,
    }));
  }

  const limit = Number(owner.trafficLimit || 0);
  const used = Number(owner.trafficUsed || 0);
  if (limit > 0) {
    const ratio = used / limit;
    const summary = `已用 ${formatBytes(used)} / ${formatBytes(limit)}（${Math.min(999, Math.round(ratio * 100))}%）`;
    if (used >= limit) {
      items.push(item({ key: "config.traffic", group: "config", title: "流量额度", status: "fail", summary: `流量已用完：${summary}`, hint: forwardAccessBlockedReasonText("traffic_limit") }));
    } else if (ratio >= 0.9) {
      items.push(item({ key: "config.traffic", group: "config", title: "流量额度", status: "warn", summary, hint: "快用完了，用完后转发会被暂停" }));
    } else {
      items.push(item({ key: "config.traffic", group: "config", title: "流量额度", status: "pass", summary }));
    }
  } else {
    items.push(item({ key: "config.traffic", group: "config", title: "流量额度", status: "pass", summary: `不限（已用 ${formatBytes(used)}）` }));
  }

  const maxRules = Number(owner.maxRules || 0);
  if (maxRules > 0 && owner.ruleCount !== null) {
    if (owner.ruleCount > maxRules) {
      items.push(item({ key: "config.quota", group: "config", title: "规则数量配额", status: "warn", summary: `已有 ${owner.ruleCount} 条，超过套餐的 ${maxRules} 条`, hint: "删掉不用的规则，或升级套餐；超出的规则可能被停用" }));
    } else {
      items.push(item({ key: "config.quota", group: "config", title: "规则数量配额", status: "pass", summary: `${owner.ruleCount} / ${maxRules} 条` }));
    }
  }
  return items;
}

export function evaluateConfigItems(facts: DiagnosticConfigFacts): DiagnosticItem[] {
  return [
    enabledItem(facts),
    targetItem(facts),
    portItem(facts),
    forwardTypeItem(facts),
    ...ownerItems(facts),
  ].filter((entry): entry is DiagnosticItem => !!entry);
}

/* ───────────────────────── 主机 ───────────────────────── */

export type DiagnosticHostFacts = {
  id: number;
  name: string;
  isOnline: unknown;
  lastHeartbeat?: unknown;
  agentVersion?: string | null;
  fxpVersion?: string | null;
  /** 在这条链路上的角色：入口 / 中转 / 出口 / 落地…… */
  role: string;
};

/** 一台主机一项：在线、Agent 版本、（NEX 隧道上）FXP 版本。 */
export function evaluateHostItem(host: DiagnosticHostFacts, options: { requireFxp?: boolean } = {}): DiagnosticItem {
  const base = { key: `host:${host.id}`, group: "host" as DiagnosticGroup, title: `${host.role}「${host.name}」`, hostId: host.id, hostName: host.name };
  const version = String(host.agentVersion || "").trim();
  if (!truthy(host.isOnline)) {
    const last = formatTime(host.lastHeartbeat);
    return item({
      ...base, status: "fail",
      summary: last ? `离线（最后心跳 ${last}）` : "离线（从没收到过心跳）",
      hint: "到这台主机上看 Agent：systemctl status forwardx-agent；网络断了或面板地址变了也会离线",
    });
  }
  if (options.requireFxp && fxpRuntimeIncompatible(host as any)) {
    return item({ ...base, status: "fail", summary: fxpRuntimeIssueMessage(host.name, host as any), hint: "在主机页点「升级 Agent」，会一并装上新的 FXP" });
  }
  const parts = [`在线`, version ? `Agent ${version}` : "Agent 版本未知"];
  if (options.requireFxp && host.fxpVersion) parts.push(`FXP ${host.fxpVersion}`);
  if (!version) {
    return item({ ...base, status: "warn", summary: parts.join(" · "), hint: "Agent 没报版本，升级一次 Agent" });
  }
  if (!isAgentVersionAtLeast(version, LINK_DIAGNOSTICS_AGENT_VERSION)) {
    return item({ ...base, status: "warn", summary: `${parts.join(" · ")}（主机上的检查需要 ${LINK_DIAGNOSTICS_AGENT_VERSION}）`, hint: `在主机页点「升级 Agent」到 ${AGENT_VERSION}` });
  }
  if (isAgentVersionBehind(version, AGENT_VERSION)) {
    return item({ ...base, status: "pass", summary: `${parts.join(" · ")}（可升级到 ${AGENT_VERSION}）` });
  }
  return item({ ...base, status: "pass", summary: parts.join(" · ") });
}

/* ───────────────────────── 运行状态 ───────────────────────── */

/**
 * 规则 / 隧道在某台主机上报的运行状态（Agent 的 rule-status 上报落到库里的 isRunning，
 * 隧道多跳是内存里的分主机状态）。running = undefined 表示面板还没收到这台的报告。
 */
export function evaluateRuntimeItem(input: {
  key: string;
  group: DiagnosticGroup;
  hostId: number;
  hostName: string;
  what: string;
  running: boolean | undefined;
  hostOnline: boolean;
}): DiagnosticItem {
  const base = { key: input.key, group: input.group, title: `${input.what}在「${input.hostName}」上运行`, hostId: input.hostId, hostName: input.hostName };
  if (!input.hostOnline) {
    return item({ ...base, status: "skip", summary: "主机离线，运行状态不可信" });
  }
  if (input.running === undefined) {
    return item({ ...base, status: "warn", summary: "面板还没收到这台主机的运行状态", hint: "等一两个心跳；一直没有就看这台主机的 Agent 日志" });
  }
  if (!input.running) {
    return item({ ...base, status: "fail", summary: "Agent 报告没在运行", hint: "多半是端口被占用或转发程序起不来：看主机上的 Agent 日志（journalctl -u forwardx-agent -n 100）" });
  }
  return item({ ...base, status: "pass", summary: "Agent 报告正在运行" });
}

/* ───────────────────────── 入口 ───────────────────────── */

export function evaluatePortConflictItem(input: { hostId: number; hostName: string; port: number; used: boolean; reason?: string | null; error?: string | null }): DiagnosticItem {
  const base = { key: `entry.portConflict:${input.hostId}`, group: "entry" as DiagnosticGroup, title: `端口 ${input.port} 没被别的规则占用`, hostId: input.hostId, hostName: input.hostName };
  if (input.error) return item({ ...base, status: "skip", summary: `没查成：${input.error}` });
  if (input.used) {
    return item({
      ...base, status: "fail",
      summary: input.reason || `「${input.hostName}」上还有别的规则 / 隧道 / 入站用着端口 ${input.port}`,
      hint: "编辑规则换一个端口，或停掉占着它的那条",
    });
  }
  return item({ ...base, status: "pass", summary: `「${input.hostName}」上只有这条在用 ${input.port}` });
}

/**
 * 入口域名（规则的入口域名 / 主机 DDNS）解析出来的地址是不是这台入口主机现在的 IP。
 * resolved = null 表示查询失败（error 是原因）。
 */
export function evaluateDomainItem(input: {
  key: string;
  label: string;
  domain: string;
  hostId: number;
  hostName: string;
  expected: string[];
  resolved: string[] | null;
  error?: string | null;
  publishError?: string | null;
}): DiagnosticItem {
  const base = { key: input.key, group: "entry" as DiagnosticGroup, title: `${input.label} ${input.domain}`, hostId: input.hostId, hostName: input.hostName };
  const expected = input.expected.filter(Boolean);
  const detail = [
    `解析结果：${input.resolved && input.resolved.length > 0 ? input.resolved.join(", ") : "（无）"}`,
    `入口主机地址：${expected.length > 0 ? expected.join(", ") : "（未知）"}`,
    input.publishError ? `上次发布出错：${input.publishError}` : "",
  ].filter(Boolean).join("\n");
  if (!input.resolved) {
    return item({
      ...base, status: "fail", detail,
      summary: `从面板解析失败：${input.error || "没有记录"}`,
      hint: input.publishError ? `域名没发布成功：${input.publishError}` : "检查 DNS 服务商里这条记录还在不在，以及 DNS 接口的 Token 是否有效",
    });
  }
  if (expected.length === 0) {
    return item({ ...base, status: "skip", detail, summary: `解析到 ${input.resolved.join(", ")}，但不知道入口主机的 IP，没法比对` });
  }
  const matched = input.resolved.some((address) => expected.some((value) => sameNetworkAddress(address, value)));
  if (!matched) {
    return item({
      ...base, status: "warn", detail,
      summary: `解析到 ${input.resolved.join(", ")}，不是入口主机的 ${expected.join(" / ")}`,
      hint: "主机换过 IP 时记录还没更新（等 DDNS 同步或 TTL 过期）；套了 CDN 的话这是正常的",
    });
  }
  if (input.publishError) {
    return item({ ...base, status: "warn", detail, summary: `解析正确，但上次同步出错：${input.publishError}`, hint: "检查 DNS 接口配置，下次换 IP 时可能同步不上" });
  }
  return item({ ...base, status: "pass", detail, summary: `解析到 ${input.resolved.join(", ")}，与入口主机一致` });
}

/* ───────────────────────── 目标 ───────────────────────── */

/**
 * 目标地址合不合理（面板这边能看的部分）：IP 字面量看是不是内网 / 保留地址，域名看面板能不能
 * 解析。内网地址如果正好是面板里某台主机的地址（同机房内网转发），算正常。
 */
export function evaluateTargetAddressItem(input: {
  target: string;
  managedHostName?: string | null;
  resolved?: string[] | null;
  resolveError?: string | null;
}): DiagnosticItem {
  const target = String(input.target || "").trim().replace(/^\[|\]$/g, "");
  const base = { key: "target.address", group: "target" as DiagnosticGroup, title: `目标地址 ${target || "（空）"}` };
  if (!target) return item({ ...base, status: "skip", summary: "没有目标地址" });
  const family = net.isIP(target);
  if (family) {
    if (input.managedHostName) {
      return item({ ...base, status: "pass", summary: `是面板里的主机「${input.managedHostName}」` });
    }
    if (isPrivateOrReservedAddress(target)) {
      const cls = classifyIpAddress(target);
      return item({
        ...base, status: "warn",
        summary: cls === "loopback" ? "目标是本机回环地址，只会连到拨号那台主机自己" : `目标是内网 / 保留地址（${cls}）`,
        hint: "只有拨号的那台主机和目标在同一内网时才通；不是的话改成目标的公网地址",
      });
    }
    return item({ ...base, status: "pass", summary: `公网 IPv${family}` });
  }
  if (input.resolved === null || input.resolved === undefined) {
    return item({
      ...base, status: "warn",
      summary: `面板解析不了这个域名${input.resolveError ? `：${input.resolveError}` : ""}`,
      hint: "检查域名拼写和解析记录；面板和主机的 DNS 可能不一样，以主机上的「DNS 解析」一项为准",
    });
  }
  const privates = input.resolved.filter((address) => isPrivateOrReservedAddress(address));
  const detail = `面板解析结果：${input.resolved.join(", ")}`;
  if (privates.length > 0 && privates.length === input.resolved.length && !input.managedHostName) {
    return item({ ...base, status: "warn", detail, summary: `解析到内网 / 保留地址 ${privates.join(", ")}`, hint: "只有拨号的那台主机和目标在同一内网时才通" });
  }
  return item({ ...base, status: "pass", detail, summary: `面板解析到 ${input.resolved.slice(0, 4).join(", ")}${input.resolved.length > 4 ? " 等" : ""}` });
}

/* ───────────────────────── Agent 项 ───────────────────────── */

export type PlannedAgentCheck = {
  check: DiagnosticsAgentCheck;
  group: DiagnosticGroup;
  title: string;
  hostId: number;
  hostName: string;
  /** 失败 / 警告时给的修复建议。 */
  hintFail?: string;
  hintWarn?: string;
};

export type AgentHostGate = {
  online: boolean;
  agentVersion?: string | null;
  /** 面板给这台排了任务；没排（离线 / 太旧）就是 undefined。 */
  taskId?: string;
  /** 非管理员看别人的主机：不给原始输出。 */
  detailVisible: boolean;
};

export function agentSupportsDiagnostics(agentVersion: string | null | undefined) {
  return isAgentVersionAtLeast(agentVersion, LINK_DIAGNOSTICS_AGENT_VERSION);
}

/** 把这台主机上计划的检查变成清单里的项：没排任务、还在等、超时、已回报各是什么样。 */
export function agentCheckItems(
  planned: readonly PlannedAgentCheck[],
  gate: AgentHostGate,
  task: DiagnosticsTaskStatus | null,
): DiagnosticItem[] {
  return planned.map((entry) => {
    const base = {
      key: `agent:${entry.hostId}:${entry.check.id}`,
      group: entry.group,
      title: entry.title,
      hostId: entry.hostId,
      hostName: entry.hostName,
      source: "agent" as const,
    };
    if (!gate.online) {
      return item({ ...base, status: "skip", summary: "主机离线，没法在上面检查" });
    }
    if (!agentSupportsDiagnostics(gate.agentVersion)) {
      return item({
        ...base, status: "skip", needsUpgrade: true,
        summary: DIAGNOSTIC_NEEDS_UPGRADE_SUMMARY,
        hint: `这台是 ${gate.agentVersion || "未知版本"}，在主机页点「升级 Agent」后再诊断`,
      });
    }
    if (!gate.taskId || !task) {
      return item({ ...base, status: "skip", summary: "这一轮诊断的结果已过期，请重新诊断" });
    }
    const result = task.results.find((value) => value.id === entry.check.id);
    if (result) {
      const status: DiagnosticStatus = result.status;
      const hint = status === "fail" ? entry.hintFail : status === "warn" ? entry.hintWarn || entry.hintFail : undefined;
      return item({
        ...base,
        status,
        summary: result.summary,
        hint,
        detail: gate.detailVisible ? result.detail : result.detail ? "（原始输出只有管理员能看）" : undefined,
        ...(typeof result.latencyMs === "number" ? { latencyMs: result.latencyMs } : {}),
      });
    }
    if (task.status === "queued") return item({ ...base, status: "pending", summary: "等主机来取诊断任务…" });
    if (task.status === "running") return item({ ...base, status: "pending", summary: "主机正在检查…" });
    if (task.status === "timeout") {
      return item({ ...base, status: "warn", summary: task.error || "主机没在时限内回报", hint: "主机可能刚断线或很忙；稍后重新诊断" });
    }
    return item({ ...base, status: "skip", summary: task.error ? `Agent 没测这一项：${task.error}` : "Agent 没回这一项" });
  });
}

/* ───────────────────────── 修复建议 ───────────────────────── */

export function agentCheckHints(check: DiagnosticsAgentCheck, context: { role?: "entry" | "hop" | "target" } = {}) {
  const port = Number(check.port || 0);
  const proto = check.protocol === "udp" ? "udp" : check.protocol === "both" ? "tcp/udp" : "tcp";
  switch (check.kind) {
    case "listen":
      return {
        hintFail: `端口 ${port} 没有程序在听：先看「运行状态」一项；端口可能被别的程序占了（ss -ltnup | grep :${port}），或转发程序起不来（journalctl -u forwardx-agent -n 100）`,
      };
    case "nat":
      return { hintFail: `没找到端口 ${port} 的内核转发规则：在面板里重新保存一次规则，或在主机上执行 nft list ruleset / iptables-save -t nat 核对` };
    case "firewall":
      return {
        hintWarn: `主机防火墙可能挡住 ${port}/${proto}：放行它（ufw allow ${port}/${proto === "tcp/udp" ? "tcp" : proto}，或 firewall-cmd --add-port=${port}/${proto === "tcp/udp" ? "tcp" : proto} --permanent），云服务器还要放行安全组`,
        hintFail: `主机防火墙挡住了 ${port}/${proto}：放行这个端口，云服务器还要放行安全组`,
      };
    case "loopback":
      return {
        hintFail: "在主机本机上都连不上这个端口：转发程序没正常工作，在面板里重新启用规则，或看 Agent 日志",
        hintWarn: "本机能连 127.0.0.1，连自己的公网 IP 不通：NAT 机器常见（不支持回环），从外面再测一次；也可能是安全组没放行",
      };
    case "dns":
      return { hintFail: "主机解析不了这个域名：检查主机的 /etc/resolv.conf 和域名的解析记录，或把目标改成 IP" };
    case "dial":
      return context.role === "hop"
        ? {
          hintFail: "连不上下一跳：检查下一跳主机上隧道 / 规则是否在运行，以及它的防火墙、云安全组是否放行这个端口",
          hintWarn: "下一跳连接不稳定，看看两台主机之间的线路",
        }
        : {
          hintFail: "主机连不上目标：确认目标服务在运行、目标的防火墙放行了这台主机的出口 IP；目标是内网地址时这台主机要在同一内网",
          hintWarn: "目标能连上但不太稳，多测几次或用「延迟测试」看抖动",
        };
    case "process":
      return { hintFail: "转发进程没在运行：在面板里关掉再打开这条规则；还不行就在主机上 systemctl status 看它为什么退出" };
    default:
      return {};
  }
}
