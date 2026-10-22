/**
 * 节点处理器：Sub-Store 那套「过滤 → 改名 → 加旗帜 → 排序 → 去重」的流水线。
 *
 * 全部作用在 ProxySubscriptionPlan 的条目上（那时还知道入口主机、模板、规则是谁），
 * 跑完再交给 buildProxySubscriptionDocument 去重名、建组。顺序固定：
 *
 *   作用域过滤 → 命名模板 → 旗帜 / 协议前缀 / 前后缀 → 正则改名 → 去重 → 排序
 *   → udp / skip-cert-verify 覆盖
 *
 * 信息节点（剩余流量 / 到期 / 公告）另算：它们不是真节点，在文档建好之后再插到
 * 最前面，不进任何策略组。
 */

import { formatBytes } from "./formatBytes";
import { createEmptyProxyNode, PROXY_NODE_PROTOCOL_LABELS, type ProxyNode } from "./proxyNode";
import type { ProxySubscriptionEntry, ProxySubscriptionPlan } from "./proxySubscriptionPlan";
import { guessProxySubRegionCode, proxySubRegionFlag, proxySubRegionName, stripProxySubRegionFlag } from "./proxySubRegion";
import type { ProxySubSettings } from "./proxySubSettings";
import {
  makeLooseMatcher,
  resolveTriState,
  type ProxySubSortMode,
  type ProxySubTokenOptions,
  type ProxySubTokenScope,
} from "./proxySubTokenScope";

/** 每条条目带的元信息；plan 构建时填，处理器按它改名。 */
export type ProxySubEntryMeta = {
  hostName: string;
  templateName: string;
  ruleName: string;
  /** 用户在转发上手填了显示名：命名模板不动它。 */
  customName: boolean;
  /** 国家码；空 = 不知道。 */
  regionCode: string;
  /** 面板探测到的延迟（毫秒）；null = 没探测过或不通。 */
  latencyMs?: number | null;
};

export function entryMeta(entry: ProxySubscriptionEntry): ProxySubEntryMeta {
  return entry.meta || { hostName: "", templateName: "", ruleName: "", customName: false, regionCode: "" };
}

// ==================== 作用域 ====================

export function applyProxySubScope(plan: ProxySubscriptionPlan, scope: ProxySubTokenScope): ProxySubscriptionPlan {
  const include = makeLooseMatcher(scope.include);
  const exclude = makeLooseMatcher(scope.exclude);
  const only = new Set(scope.templateIds);
  const banned = new Set(scope.excludeTemplateIds);
  const protocols = new Set<string>(scope.protocols);
  const regions = new Set(scope.regions);
  const entries = plan.entries.filter((entry) => {
    if (only.size > 0 && !only.has(entry.templateId)) return false;
    if (banned.has(entry.templateId)) return false;
    if (protocols.size > 0 && !protocols.has(entry.node.protocol)) return false;
    if (regions.size > 0 && !regions.has(entryMeta(entry).regionCode)) return false;
    if (scope.excludeDirect && entry.kind === "direct") return false;
    if (scope.excludeRelay && entry.kind === "relay") return false;
    if (include && !include(entry.node.name)) return false;
    if (exclude && exclude(entry.node.name)) return false;
    return true;
  });
  /**
   * 被作用域挡掉的条目若是别人的前置，引用要清掉 —— 否则 dialer-proxy 指向一个
   * 不存在的节点，Clash 拒绝整份配置。
   */
  const kept = new Set(entries.filter((entry) => entry.kind === "direct").map((entry) => entry.templateId));
  return {
    ...plan,
    entries: entries.map((entry) => (entry.frontTemplateId && !kept.has(entry.frontTemplateId) ? { ...entry, frontTemplateId: 0 } : entry)),
  };
}

// ==================== 命名 ====================

export type ProxySubNamingContext = {
  options: ProxySubTokenOptions;
  settings: ProxySubSettings;
};

/** 模板变量展开后清掉多余的分隔符：「 → HKT」「HKT → 」「[VLESS]  」这种。 */
function tidyName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s→\-|/·]+/, "")
    .replace(/[\s→\-|/·]+$/, "")
    .replace(/(?:\s*[→\-|/·]\s*){2,}/g, " → ")
    .trim();
}

export function renderProxySubNodeName(template: string, vars: Record<string, string>): string {
  // 空变量先换成占位符，再把紧挨着它的分隔符一起去掉：「{host} → {node}」在直连条目上
  // 不该剩一个孤零零的箭头。
  const EMPTY = "\u0000";
  const rendered = String(template || "").replace(/\{([a-z]+)\}/gi, (whole, key: string) => {
    const value = vars[key.toLowerCase()];
    if (value === undefined) return whole;
    return value === "" ? EMPTY : value;
  });
  const withoutEmpty = rendered
    .replace(/\s*[→\-|/·]\s*\u0000/g, EMPTY)
    .replace(/\u0000\s*[→\-|/·]\s*/g, EMPTY)
    .replace(/\u0000/g, "");
  return tidyName(withoutEmpty);
}

export function applyProxySubNaming(plan: ProxySubscriptionPlan, context: ProxySubNamingContext): ProxySubscriptionPlan {
  const { options, settings } = context;
  const template = options.nameTemplate || settings.nameTemplateDefault || "{host} → {node}";
  const useFlag = resolveTriState(options.flagEmoji, settings.flagEmojiDefault);
  const useProtocol = resolveTriState(options.protocolPrefix, settings.protocolPrefixDefault);
  const renames = options.renames
    .map((rule) => {
      try {
        return { regex: new RegExp(rule.from, "g"), to: rule.to };
      } catch {
        return { regex: null, from: rule.from, to: rule.to };
      }
    });
  const templateHasFlag = /\{flag\}/i.test(template);
  // 不是默认模板的话，手填的名字照样套：用户选模板就是想统一外观；默认模板下保留原来的行为。
  const isDefaultTemplate = template.trim() === "{host} → {node}";

  const entries = plan.entries.map((entry, index) => {
    const meta = entryMeta(entry);
    const code = meta.regionCode || guessProxySubRegionCode(`${meta.templateName} ${meta.hostName} ${entry.node.name}`);
    const flag = proxySubRegionFlag(code);
    let name = entry.node.name;
    if (!(meta.customName && isDefaultTemplate)) {
      const rendered = renderProxySubNodeName(template, {
        flag,
        country: proxySubRegionName(code),
        code,
        host: meta.hostName,
        node: meta.templateName,
        rule: meta.ruleName,
        protocol: PROXY_NODE_PROTOCOL_LABELS[entry.node.protocol] || entry.node.protocol,
        index: String(index + 1),
        name: entry.node.name,
      });
      // 自定义名字在非默认模板下也套模板：{name} 可以把它放回去；没写 {name} 就按模板。
      if (rendered) name = meta.customName && !/\{(host|node|name)\}/i.test(template) ? entry.node.name : rendered;
    }
    if (useFlag && flag && !templateHasFlag) name = `${flag} ${stripProxySubRegionFlag(name)}`;
    if (useProtocol) name = `[${PROXY_NODE_PROTOCOL_LABELS[entry.node.protocol] || entry.node.protocol}] ${name}`;
    if (options.prefix) name = `${options.prefix}${name}`;
    if (options.suffix) name = `${name}${options.suffix}`;
    for (const rule of renames) {
      if (rule.regex) name = name.replace(rule.regex, rule.to);
      else name = name.split((rule as any).from).join(rule.to);
    }
    name = tidyName(name) || entry.node.name || "节点";
    return {
      ...entry,
      meta: { ...meta, regionCode: code },
      node: { ...entry.node, name, regionCode: code || undefined },
    };
  });
  return { ...plan, entries };
}

// ==================== 去重与排序 ====================

export function dedupeProxySubEntries(plan: ProxySubscriptionPlan): ProxySubscriptionPlan {
  const seen = new Set<string>();
  const entries = plan.entries.filter((entry) => {
    const node = entry.node;
    const key = `${node.protocol}|${node.address.toLowerCase()}|${node.port}|${node.uuid || node.password}|${node.transport}|${node.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...plan, entries };
}

const PROTOCOL_ORDER = ["vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic", "anytls", "snell", "socks5"];

export function sortProxySubEntries(plan: ProxySubscriptionPlan, mode: ProxySubSortMode): ProxySubscriptionPlan {
  if (mode === "manual") return plan;
  const entries = plan.entries.map((entry, index) => ({ entry, index }));
  const byName = (a: ProxySubscriptionEntry, b: ProxySubscriptionEntry) => a.node.name.localeCompare(b.node.name, "zh-Hans-CN");
  entries.sort((a, b) => {
    let diff = 0;
    if (mode === "name") diff = byName(a.entry, b.entry);
    else if (mode === "region") {
      const ra = entryMeta(a.entry).regionCode || "ZZ";
      const rb = entryMeta(b.entry).regionCode || "ZZ";
      diff = ra.localeCompare(rb) || byName(a.entry, b.entry);
    } else if (mode === "protocol") {
      diff = PROTOCOL_ORDER.indexOf(a.entry.node.protocol) - PROTOCOL_ORDER.indexOf(b.entry.node.protocol) || byName(a.entry, b.entry);
    } else if (mode === "latency") {
      const la = entryMeta(a.entry).latencyMs;
      const lb = entryMeta(b.entry).latencyMs;
      const va = la === null || la === undefined ? Number.POSITIVE_INFINITY : la;
      const vb = lb === null || lb === undefined ? Number.POSITIVE_INFINITY : lb;
      diff = va === vb ? 0 : va < vb ? -1 : 1;
    }
    // 稳定排序：相同的按原顺序。
    return diff || a.index - b.index;
  });
  return { ...plan, entries: entries.map((item) => item.entry) };
}

// ==================== 字段覆盖 ====================

export function applyProxySubNodeOverrides(plan: ProxySubscriptionPlan, options: ProxySubTokenOptions): ProxySubscriptionPlan {
  if (options.udp === "default" && options.skipCertVerify === "default") return plan;
  const entries = plan.entries.map((entry) => {
    const node = { ...entry.node };
    if (options.udp !== "default") node.udp = options.udp === "on";
    if (options.skipCertVerify !== "default") node.allowInsecure = options.skipCertVerify === "on";
    return { ...entry, node };
  });
  return { ...plan, entries };
}

// ==================== 组合 ====================

export type ProxySubProcessorInput = {
  scope: ProxySubTokenScope;
  options: ProxySubTokenOptions;
  settings: ProxySubSettings;
};

/** 按固定顺序跑完所有条目级处理器。 */
export function runProxySubEntryProcessors(plan: ProxySubscriptionPlan, input: ProxySubProcessorInput): ProxySubscriptionPlan {
  let next = applyProxySubScope(plan, input.scope);
  next = applyProxySubNaming(next, { options: input.options, settings: input.settings });
  if (input.options.dedupe) next = dedupeProxySubEntries(next);
  next = sortProxySubEntries(next, input.options.sortMode);
  next = applyProxySubNodeOverrides(next, input.options);
  return next;
}

// ==================== 信息节点 ====================

export type ProxySubInfoNodeInput = {
  trafficUsed: number;
  /** 0 = 不限。 */
  trafficLimit: number;
  /** 毫秒时间戳，0 = 长期。 */
  expiresAt: number;
  announce?: string;
  /** 下次流量重置（毫秒），0 = 没有。 */
  nextResetAt?: number;
  now?: number;
};

/** 信息节点的名字；界面预览和服务端共用，保证两边一个字不差。 */
export function proxySubInfoNodeNames(input: ProxySubInfoNodeInput): string[] {
  const names: string[] = [];
  const used = Math.max(0, Number(input.trafficUsed) || 0);
  const limit = Math.max(0, Number(input.trafficLimit) || 0);
  if (limit > 0) {
    const left = Math.max(0, limit - used);
    names.push(`📊 剩余 ${formatBytes(left)} / ${formatBytes(limit)}`);
  } else {
    names.push(`📊 已用 ${formatBytes(used)}（不限量）`);
  }
  if (input.expiresAt > 0) {
    const now = input.now ?? Date.now();
    const days = Math.max(0, Math.ceil((input.expiresAt - now) / 86_400_000));
    const date = new Date(input.expiresAt);
    const text = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    names.push(`📅 ${text} 到期（剩 ${days} 天）`);
  } else {
    names.push("📅 长期有效");
  }
  if (input.nextResetAt && input.nextResetAt > 0) {
    const date = new Date(input.nextResetAt);
    names.push(`🔄 ${date.getMonth() + 1}月${date.getDate()}日 重置流量`);
  }
  const announce = String(input.announce || "").replace(/\s+/g, " ").trim();
  if (announce) names.push(`📢 ${Array.from(announce).slice(0, 48).join("")}`);
  return names;
}

/**
 * 信息节点本体：一个指向本机、永远连不上的 Shadowsocks 节点。
 *
 * 选 Shadowsocks 是因为七种格式都写得出它，而且字段最少。客户端测速会把它标红 ——
 * 这是已知代价，所以默认关着，文档里说明。
 */
export function buildProxySubInfoNodes(input: ProxySubInfoNodeInput): ProxyNode[] {
  return proxySubInfoNodeNames(input).map((name) => {
    const node = createEmptyProxyNode();
    node.protocol = "shadowsocks";
    node.name = name;
    node.address = "127.0.0.1";
    node.port = 1;
    node.method = "aes-128-gcm";
    node.password = "info";
    node.udp = false;
    node.transport = "tcp";
    return node;
  });
}
