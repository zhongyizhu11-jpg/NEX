/*
  网络测试页的「配置体检」：每一项怎么判（纯函数，networkConfigCheckItems.test.ts 拿假数据测）。

  取数据在 server/networkConfigCheck.ts。体检只读面板里已有的状态（数据库里的主机 / 规则、Agent 心跳
  报上来的版本和运行状态、端口占用核对的内存记录），不给主机派任务、不改任何配置。

  产出和「一键诊断」同一种清单项（shared/linkDiagnostics.ts 的 DiagnosticItem），页面用同一个清单组件画，
  复制出来的文字也是同一种格式。能复用的判定直接复用：
    · 主机在线 / Agent 版本：linkDiagnosticsChecks.evaluateHostItem；
    · 「可升级」到底是 Agent 还是 FXP：shared/fxpRuntime.ts 的 hostUpgradeReason；
    · 规则没运行的原因（端口被占、运行时没装、IPv6 不可用……）：rulePortOccupancy.getRulePortWarnings
      （里面是 ruleRuntimeFailureText.ts 归好类的那几句）。
*/

import { type DiagnosticGroup, type DiagnosticItem } from "../shared/linkDiagnostics";
import { hostUpgradeReason, fxpRuntimeIncompatible } from "../shared/fxpRuntime";
import { hostIpv6ListenAvailable } from "../shared/hostIpv6Listen";
import { HOST_TRAFFIC_FAILOVER_EXCLUDED_MESSAGE } from "../shared/hostTrafficPolicy";
import { forwardRuleProtocols } from "../shared/forwardTypes";
import { evaluateHostItem } from "./linkDiagnosticsChecks";
import { AGENT_PORT_OCCUPANCY_VERSION, agentSupportsPortOccupancy, type RulePortWarning } from "./rulePortOccupancy";

function item(input: Omit<DiagnosticItem, "source">): DiagnosticItem {
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

function positive(value: unknown) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/* ───────────────────────── 主机 ───────────────────────── */

export type ConfigCheckHostFacts = {
  id: number;
  name: string;
  isOnline: unknown;
  lastHeartbeat?: unknown;
  /** 绑定过 Agent（有 agentToken）。 */
  hasAgent: boolean;
  agentVersion?: string | null;
  fxpVersion?: string | null;
  ipv6ListenAvailable?: unknown;
  maintenanceMode?: unknown;
  /** 流量到了故障转移阈值、被暂停组调度（shared/hostTrafficPolicy.hostTrafficExcluded，不含维护）。 */
  trafficExcluded?: boolean;
};

/**
 * 主机这几项：Agent 装没装、在不在线、版本（evaluateHostItem）、该升级的是哪一件（hostUpgradeReason）、
 * IPv6 监听，以及（管理员 / 主机主人才看的）维护、流量暂停。
 */
export function evaluateHostCheckItems(
  host: ConfigCheckHostFacts,
  options: { latestAgentVersion: string; showHostState: boolean },
): DiagnosticItem[] {
  const base = { group: "host" as DiagnosticGroup, hostId: host.id, hostName: host.name };
  if (!host.hasAgent) {
    return [item({
      ...base, key: "host.agent", title: "Agent 安装", status: "fail",
      summary: "这台主机还没有绑定 Agent，网络测试、转发都跑不起来",
      hint: "在主机页复制安装命令，到这台机器上用 root 执行",
    })];
  }
  const items: DiagnosticItem[] = [evaluateHostItem({
    id: host.id,
    name: host.name,
    role: "主机",
    isOnline: host.isOnline,
    lastHeartbeat: host.lastHeartbeat,
    agentVersion: host.agentVersion,
    fxpVersion: host.fxpVersion,
  })];

  const upgrade = evaluateUpgradeItem(host, options.latestAgentVersion);
  if (upgrade) items.push(upgrade);

  if (!hostIpv6ListenAvailable(host)) {
    items.push(item({
      ...base, key: "host.ipv6Listen", title: "IPv6 监听", status: "warn",
      summary: "这台机器的内核关了 IPv6，转发只监听 IPv4",
      hint: "需要 IPv6 入口时在主机上打开 IPv6（去掉 ipv6.disable=1）后重启 Agent；只用 IPv4 可以不管",
    }));
  }

  if (options.showHostState) {
    if (truthy(host.maintenanceMode)) {
      items.push(item({
        ...base, group: "config", key: "config.maintenance", title: "节点维护", status: "warn",
        summary: "主机处于维护中，已从所有转发组、线路的候选里拿掉",
        hint: "维护完在主机页关掉「节点维护」",
      }));
    } else if (host.trafficExcluded) {
      items.push(item({
        ...base, group: "config", key: "config.trafficFailover", title: "流量故障转移", status: "warn",
        summary: HOST_TRAFFIC_FAILOVER_EXCLUDED_MESSAGE,
        hint: "流量重置或调高阈值后会自动恢复参与调度",
      }));
    }
  }
  return items;
}

/**
 * 「该升级了」是哪一件（hostUpgradeReason）：Agent 落后于面板带的版本 → 警告；Agent 已是最新、FXP 握不上
 * 或没装 → 警告（用不到 NEX 隧道可以不管）；FXP 只是有新版 → 通过、写明可升级。没报版本的不出这一项
 * （evaluateHostItem 已经说了「Agent 版本未知」）。withName：规则体检里一条规则可能经过好几台主机；
 * agentOnly：只说 Agent 过旧（规则体检里 FXP 由一键诊断的主机项按隧道类型判，这里不重复）。
 */
export function evaluateUpgradeItem(
  host: { id: number; name: string; agentVersion?: string | null; fxpVersion?: string | null },
  latestAgentVersion: string,
  options: { withName?: boolean; agentOnly?: boolean } = {},
): DiagnosticItem | null {
  const version = String(host.agentVersion || "").trim();
  if (!version) return null;
  const agentTitle = options.withName ? `「${host.name}」的 Agent 版本` : "Agent 版本";
  const fxpTitle = options.withName ? `「${host.name}」的 FXP 运行时` : "FXP 运行时";
  const base = { key: `host.upgrade:${host.id}`, group: "host" as DiagnosticGroup, hostId: host.id, hostName: host.name };
  const versions = { agentVersion: version, fxpVersion: host.fxpVersion };
  const reason = hostUpgradeReason(versions, latestAgentVersion);
  if (!reason) return item({ ...base, title: agentTitle, status: "pass", summary: `已是最新（Agent ${version}）` });
  if (reason.kind === "agent") {
    return item({
      ...base, title: agentTitle, status: "warn",
      summary: `Agent 版本过旧：${reason.detail}`,
      hint: "在主机页点「升级 Agent」；新功能和问题修复要新版本的 Agent 才有，老版本上部分检查和测试会缺项",
    });
  }
  if (options.agentOnly) return null;
  const broken = fxpRuntimeIncompatible(versions);
  return item({
    ...base, title: fxpTitle, status: broken ? "warn" : "pass",
    summary: `${reason.label}：${reason.detail}`,
    hint: broken ? "用不到 NEX 隧道可以不管；要用的话在主机页点「升级 Agent」，会一并装上 FXP" : undefined,
  });
}

/* ───────────────────────── 资源 ───────────────────────── */

/** 最近一次采样超过这么久就不拿来下结论（Agent 每分钟左右报一次）。 */
export const METRIC_FRESH_MS = 3 * 60 * 1000;
export const RESOURCE_WARN_PERCENT = 90;

export function evaluateResourceItem(
  host: { id: number; name: string; isOnline: unknown },
  metric: { cpuUsage?: number | null; memoryUsage?: number | null; diskUsage?: number | null; recordedAt?: unknown } | null,
  now = Date.now(),
): DiagnosticItem {
  const base = { key: "host.resource", group: "host" as DiagnosticGroup, title: "资源占用", hostId: host.id, hostName: host.name };
  const recordedAt = metric?.recordedAt;
  const at = recordedAt instanceof Date || typeof recordedAt === "string" || typeof recordedAt === "number" ? new Date(recordedAt).getTime() : NaN;
  if (!metric || !Number.isFinite(at) || now - at > METRIC_FRESH_MS) {
    return item({ ...base, status: "skip", summary: truthy(host.isOnline) ? "没有最近几分钟的资源采样，不拿旧数据下结论" : "主机离线，没有近期的资源采样" });
  }
  const parts: string[] = [];
  const high: string[] = [];
  for (const [label, value] of [["CPU", metric.cpuUsage], ["内存", metric.memoryUsage], ["磁盘", metric.diskUsage]] as const) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
    const percent = Number(value);
    parts.push(`${label} ${percent.toFixed(0)}%`);
    if (percent >= RESOURCE_WARN_PERCENT) high.push(label);
  }
  if (parts.length === 0) return item({ ...base, status: "skip", summary: "Agent 没报资源使用率" });
  if (high.length > 0) {
    return item({
      ...base, status: "warn", summary: parts.join(" · "),
      hint: high.includes("磁盘")
        ? "磁盘快满了：Agent 写不了配置和日志时转发会起不来，先清理日志或扩容"
        : "CPU / 内存接近打满：转发会卡顿，网络测试的延迟也会偏高；看看是不是有别的程序占着",
    });
  }
  return item({ ...base, status: "pass", summary: parts.join(" · ") });
}

/* ───────────────────────── 规则 ───────────────────────── */

export type ConfigCheckRuleFacts = {
  id: number;
  name: string;
  sourcePort: number;
  sourcePortEnd?: number | null;
  protocol?: unknown;
  isEnabled: unknown;
  isRunning: unknown;
  pendingDelete?: unknown;
  /** 这条规则在这台主机上的端口告警（getRulePortWarnings 过滤到本机）。 */
  warnings: readonly RulePortWarning[];
  /** 面板端口占用表里查到它的入口端口还被别的规则 / 隧道 / 入站用着（只查了没运行的那几条）。 */
  portConflict?: { used: boolean; reason?: string | null } | null;
};

/** 一次体检最多单独列出这么多条有问题的规则，其余合成一句。 */
export const MAX_RULE_ITEMS = 8;

function ruleLabel(rule: ConfigCheckRuleFacts) {
  const port = positive(rule.sourcePort);
  const end = positive(rule.sourcePortEnd);
  const ports = port ? (end > port ? `${port}-${end}` : String(port)) : "";
  return ports ? `规则「${rule.name}」（端口 ${ports}）` : `规则「${rule.name}」`;
}

export function runtimeHint(warning: RulePortWarning | undefined) {
  switch (warning?.kind) {
    case "bind":
      return "换一个入口端口，或停掉占着这个端口的程序（在主机上 ss -ltnup | grep :端口 能看到是谁）";
    case "kernel":
      return "在面板里重新保存一次规则；主机上装了 Docker 或别的防火墙管理工具时，看看是不是它把转发规则清掉了";
    case "runtime":
      // 归好类的叫「运行时没安装」（ruleRuntimeFailureText），认不出原文时按关键词归的叫「运行时没装」（rulePortOccupancy）。
      return /^运行时没/.test(warning.label)
        ? "转发程序不在这台机器上：在主机页点「升级 Agent」重新安装"
        : "看主机上的 Agent 日志找原因：journalctl -u forwardx-agent -n 100";
    default:
      return "等一两个心跳；一直不运行就看主机上的 Agent 日志：journalctl -u forwardx-agent -n 100";
  }
}

export function enabledRules(rules: readonly ConfigCheckRuleFacts[]) {
  return rules.filter((rule) => truthy(rule.isEnabled, true) && !truthy(rule.pendingDelete));
}

/** 启用的规则里谁没在运行，为什么。主机离线时运行状态不可信，只给一项跳过。 */
export function evaluateRuleRuntimeItems(
  host: { id: number; name: string; isOnline: unknown },
  rules: readonly ConfigCheckRuleFacts[],
): DiagnosticItem[] {
  const base = { group: "entry" as DiagnosticGroup, hostId: host.id, hostName: host.name };
  const enabled = enabledRules(rules);
  if (enabled.length === 0) {
    return [item({ ...base, key: "rules.runtime", title: "规则运行", status: "skip", summary: "这台主机上没有启用的规则" })];
  }
  if (!truthy(host.isOnline)) {
    return [item({ ...base, key: "rules.runtime", title: "规则运行", status: "skip", summary: `主机离线，${enabled.length} 条启用规则的运行状态不可信` })];
  }
  const stopped = enabled.filter((rule) => !truthy(rule.isRunning));
  if (stopped.length === 0) {
    return [item({ ...base, key: "rules.runtime", title: "规则运行", status: "pass", summary: `${enabled.length} 条启用的规则都在运行` })];
  }
  const items = stopped.slice(0, MAX_RULE_ITEMS).map((rule) => {
    const warning = rule.warnings.find((entry) => entry.level === "error");
    return item({
      ...base,
      key: `rules.runtime:${rule.id}`,
      title: ruleLabel(rule),
      status: "fail",
      summary: warning ? warning.message : "Agent 报告没在运行",
      hint: runtimeHint(warning),
    });
  });
  if (stopped.length > MAX_RULE_ITEMS) {
    items.push(item({
      ...base, key: "rules.runtime.more", title: "规则运行", status: "fail",
      summary: `另外还有 ${stopped.length - MAX_RULE_ITEMS} 条启用的规则没在运行`,
      hint: "到规则列表里按状态筛「异常」逐条看",
    }));
  }
  return items;
}

type PortSpan = { rule: ConfigCheckRuleFacts; start: number; end: number; protocols: Set<string> };

function spanOf(rule: ConfigCheckRuleFacts): PortSpan | null {
  const start = positive(rule.sourcePort);
  if (!start) return null;
  const end = Math.max(start, positive(rule.sourcePortEnd));
  return { rule, start, end, protocols: new Set(forwardRuleProtocols(rule.protocol)) };
}

/** 这几条规则之间入口端口（含端口段）和协议都重叠的成对组合。 */
export function overlappingRulePairs(rules: readonly ConfigCheckRuleFacts[]) {
  const spans = enabledRules(rules).map(spanOf).filter((span): span is PortSpan => !!span)
    .sort((a, b) => a.start - b.start || a.rule.id - b.rule.id);
  const pairs: Array<{ a: ConfigCheckRuleFacts; b: ConfigCheckRuleFacts; port: number }> = [];
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length && spans[j].start <= spans[i].end; j += 1) {
      const shared = [...spans[i].protocols].some((protocol) => spans[j].protocols.has(protocol));
      if (shared) pairs.push({ a: spans[i].rule, b: spans[j].rule, port: spans[j].start });
    }
  }
  return pairs;
}

/**
 * 端口冲突：三路来源，各说各的。
 *   1. 看得到的规则之间端口（段）和协议重叠 —— 正常建规则时会被拦下，出现了多半是老数据或手改过库；
 *   2. 没在运行的规则，在面板的端口占用表里查到端口还被别的规则 / 隧道 / 入站用着；
 *   3. Agent 2.2.255 起的端口占用核对：入口端口上有不归 NEX 管的进程在监听（getRulePortWarnings 里的 occupied）。
 */
export function evaluatePortItems(
  host: { id: number; name: string; agentVersion?: string | null },
  rules: readonly ConfigCheckRuleFacts[],
): DiagnosticItem[] {
  const base = { group: "entry" as DiagnosticGroup, hostId: host.id, hostName: host.name };
  const enabled = enabledRules(rules);
  if (enabled.length === 0) return [];
  const items: DiagnosticItem[] = [];

  for (const pair of overlappingRulePairs(enabled).slice(0, MAX_RULE_ITEMS)) {
    items.push(item({
      ...base, key: `ports.overlap:${pair.a.id}:${pair.b.id}`,
      title: `端口 ${pair.port} 只给一条规则用`, status: "fail",
      summary: `「${pair.a.name}」和「${pair.b.name}」用了重叠的入口端口和协议，只有一条能监听成功`,
      hint: "编辑其中一条换个端口，或停掉不用的那条",
    }));
  }

  for (const rule of enabled) {
    if (rule.portConflict?.used && items.length < MAX_RULE_ITEMS * 2) {
      items.push(item({
        ...base, key: `ports.used:${rule.id}`, title: `端口 ${positive(rule.sourcePort)} 没被别的规则占用`, status: "fail",
        summary: rule.portConflict.reason || `「${rule.name}」的入口端口还被别的规则 / 隧道 / 入站用着`,
        hint: "编辑规则换一个端口，或停掉占着它的那一项",
      }));
    }
    for (const warning of rule.warnings) {
      if (warning.kind !== "occupied" || items.length >= MAX_RULE_ITEMS * 2) continue;
      items.push(item({
        ...base, key: `ports.occupied:${rule.id}:${warning.port}`, title: `端口 ${warning.port} 没被别的程序占用`, status: "warn",
        summary: warning.message,
        hint: "内核转发不绑端口，别的程序照样能听这个端口而不报错：停掉那个程序，或给规则换个端口",
      }));
    }
  }

  if (items.length === 0) {
    const checked = `${enabled.length} 条启用规则的入口端口没有发现冲突`;
    if (!agentSupportsPortOccupancy(host.agentVersion)) {
      items.push(item({
        ...base, key: "ports", title: "端口冲突", status: "pass",
        summary: `${checked}（Agent 低于 ${AGENT_PORT_OCCUPANCY_VERSION}，查不了外来程序占用）`,
      }));
    } else {
      items.push(item({ ...base, key: "ports", title: "端口冲突", status: "pass", summary: checked }));
    }
  }
  return items;
}

/* ───────────────────────── 规则体检 ───────────────────────── */

/**
 * 规则体检用的是一键诊断的「面板那一半」（linkDiagnostics.buildPanelOnlyDiagnostics），这里补两样它没有的：
 *   · 「Agent 报告没在运行」后面接上为什么（端口被占、运行时没装、IPv6 不可用……，getRulePortWarnings）；
 *   · 入口端口上有外来程序在听（端口占用核对的黄色告警）。
 * 一键诊断要到主机上实测才知道的项，体检不做，由调用方提示用户去点「诊断」。
 */
export function annotateRuleCheckItems(
  items: readonly DiagnosticItem[],
  warnings: readonly RulePortWarning[],
): DiagnosticItem[] {
  const out = items.map((entry) => {
    if (!entry.key.startsWith("runtime.rule:") || entry.status !== "fail") return entry;
    const warning = warnings.find((value) => value.level === "error" && (!entry.hostId || value.hostId === entry.hostId));
    if (!warning) return entry;
    return { ...entry, summary: `${entry.summary}：${warning.message}`, hint: runtimeHint(warning) };
  });
  for (const warning of warnings) {
    if (warning.kind !== "occupied") continue;
    out.push(item({
      key: `entry.occupied:${warning.hostId}:${warning.port}`,
      group: "entry",
      title: `端口 ${warning.port} 没被别的程序占用`,
      status: "warn",
      summary: warning.message,
      hint: "内核转发不绑端口，别的程序照样能听这个端口而不报错：停掉那个程序，或给规则换个端口",
      hostId: warning.hostId,
    }));
  }
  return out;
}
