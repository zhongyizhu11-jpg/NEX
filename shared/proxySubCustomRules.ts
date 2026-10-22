/**
 * 自定义分流规则：管理员全局的（前置 / 后置）、按用户的、按令牌的，都是同一种文本。
 *
 * 一行一条，写法照 Clash / Surge 的习惯：
 *
 *   DOMAIN,example.com,DIRECT
 *   DOMAIN-SUFFIX,openai.com,🤖 AI 服务
 *   DOMAIN-KEYWORD,google,PROXY
 *   IP-CIDR,10.1.0.0/16,DIRECT,no-resolve
 *   IP-CIDR6,2001:db8::/32,DIRECT
 *   GEOIP,JP,PROXY
 *   GEOSITE,netflix,🎥 奈飞视频
 *   # 井号开头是注释
 *
 * 去向：DIRECT / REJECT / PROXY（主选择器）/ 某个策略组名 / 某个节点名。
 * 渲染时查不到的组名回落到主选择器 —— 指向不存在的组会让 Clash 拒绝整份配置。
 *
 * 只收这七种类型：PROCESS-NAME、SCRIPT 之类各家写法不同，放进来只会在某几家坏掉。
 */

import type { ProxyRouteRule } from "./proxyRuleset";

export const PROXY_CUSTOM_RULE_TYPES = [
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
  "GEOIP",
  "GEOSITE",
] as const;

export type ProxyCustomRuleType = (typeof PROXY_CUSTOM_RULE_TYPES)[number];

export type ProxyCustomRule = {
  type: ProxyCustomRuleType;
  value: string;
  target: string;
  noResolve: boolean;
  /** 原文行号（从 1 起），报错用。 */
  line: number;
};

export type ProxyCustomRuleParseResult = {
  rules: ProxyCustomRule[];
  errors: Array<{ line: number; message: string }>;
};

/** 去向的保留字：主选择器写 PROXY，渲染时换成实际的组名。 */
export const PROXY_CUSTOM_RULE_TARGET_PROXY = "PROXY";

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;
const IPV4_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const IPV6_CIDR_RE = /^[0-9a-f:]+(?:\/(\d{1,3}))?$/i;

function validIpv4Cidr(value: string): boolean {
  const match = value.match(IPV4_CIDR_RE);
  if (!match) return false;
  for (let index = 1; index <= 4; index += 1) {
    const octet = Number(match[index]);
    if (octet < 0 || octet > 255) return false;
  }
  if (match[5] !== undefined) {
    const bits = Number(match[5]);
    if (bits < 0 || bits > 32) return false;
  }
  return true;
}

function validIpv6Cidr(value: string): boolean {
  const match = value.match(IPV6_CIDR_RE);
  if (!match) return false;
  const address = value.split("/")[0];
  if (!address.includes(":") || address.split("::").length > 2) return false;
  if (match[1] !== undefined) {
    const bits = Number(match[1]);
    if (bits < 0 || bits > 128) return false;
  }
  return true;
}

/** 解析一段文本。错误行跳过并报出来，合法的照收 —— 一行写坏不该让其余的都失效。 */
export function parseProxyCustomRules(text: unknown, options: { maxRules?: number } = {}): ProxyCustomRuleParseResult {
  const rules: ProxyCustomRule[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const max = options.maxRules ?? 500;
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const content = rawLine.trim();
    if (!content || content.startsWith("#") || content.startsWith(";") || content.startsWith("//")) return;
    if (rules.length >= max) {
      errors.push({ line, message: `最多 ${max} 条，后面的没收` });
      return;
    }
    const parts = content.split(",").map((item) => item.trim());
    const type = String(parts[0] || "").toUpperCase() as ProxyCustomRuleType;
    if (!(PROXY_CUSTOM_RULE_TYPES as readonly string[]).includes(type)) {
      errors.push({ line, message: `不认识的类型「${parts[0]}」，只收 ${PROXY_CUSTOM_RULE_TYPES.join(" / ")}` });
      return;
    }
    const value = String(parts[1] || "");
    const target = String(parts[2] || "");
    const extras = parts.slice(3).map((item) => item.toLowerCase());
    if (!value) {
      errors.push({ line, message: "缺少匹配值" });
      return;
    }
    if (!target) {
      errors.push({ line, message: "缺少去向（DIRECT / REJECT / PROXY 或策略组名）" });
      return;
    }
    if (target.length > 64 || /[\u0000-\u001f]/.test(target)) {
      errors.push({ line, message: "去向名字太长或含有控制字符" });
      return;
    }
    for (const extra of extras) {
      if (extra !== "no-resolve") {
        errors.push({ line, message: `不认识的选项「${extra}」` });
        return;
      }
    }
    let normalizedValue = value;
    if (type === "DOMAIN" || type === "DOMAIN-SUFFIX") {
      normalizedValue = value.toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
      if (!DOMAIN_RE.test(normalizedValue)) {
        errors.push({ line, message: `「${value}」不是合法域名` });
        return;
      }
    } else if (type === "DOMAIN-KEYWORD") {
      normalizedValue = value.toLowerCase();
      if (normalizedValue.length > 100 || /[\s,]/.test(normalizedValue)) {
        errors.push({ line, message: `关键字「${value}」不合法` });
        return;
      }
    } else if (type === "IP-CIDR") {
      if (!validIpv4Cidr(value)) {
        errors.push({ line, message: `「${value}」不是合法的 IPv4 网段` });
        return;
      }
      if (!value.includes("/")) normalizedValue = `${value}/32`;
    } else if (type === "IP-CIDR6") {
      if (!validIpv6Cidr(value)) {
        errors.push({ line, message: `「${value}」不是合法的 IPv6 网段` });
        return;
      }
      if (!value.includes("/")) normalizedValue = `${value}/128`;
    } else if (type === "GEOIP") {
      normalizedValue = value.toUpperCase();
      if (!/^[A-Z]{2}$/.test(normalizedValue) && normalizedValue !== "PRIVATE") {
        errors.push({ line, message: `GEOIP 要两位国家码，「${value}」不是` });
        return;
      }
    } else if (type === "GEOSITE") {
      normalizedValue = value.toLowerCase();
      if (!/^[a-z0-9@!.-]{1,64}$/.test(normalizedValue)) {
        errors.push({ line, message: `GEOSITE 键「${value}」不合法` });
        return;
      }
    }
    rules.push({
      type,
      value: normalizedValue,
      target: target.toUpperCase() === "PROXY" ? PROXY_CUSTOM_RULE_TARGET_PROXY : target,
      noResolve: extras.includes("no-resolve"),
      line,
    });
  });
  return { rules, errors };
}

/**
 * 转成订阅文档里的路由规则。
 *
 * 去向解析：DIRECT / REJECT 原样；PROXY 换成主选择器；其它名字只有在 knownTargets
 * 里才原样，不在就回落到主选择器。
 */
export function customRulesToRouteRules(
  rules: readonly ProxyCustomRule[],
  options: { mainGroupName: string; knownTargets: ReadonlySet<string> },
): ProxyRouteRule[] {
  const resolveTarget = (target: string): string => {
    if (target === "DIRECT" || target === "REJECT") return target;
    if (target === PROXY_CUSTOM_RULE_TARGET_PROXY) return options.mainGroupName;
    return options.knownTargets.has(target) ? target : options.mainGroupName;
  };
  return rules.map((rule): ProxyRouteRule => {
    const target = resolveTarget(rule.target);
    if (rule.type === "DOMAIN") return { type: "domain", match: "exact", value: rule.value, target };
    if (rule.type === "DOMAIN-SUFFIX") return { type: "domain", match: "suffix", value: rule.value, target };
    if (rule.type === "DOMAIN-KEYWORD") return { type: "domain", match: "keyword", value: rule.value, target };
    if (rule.type === "IP-CIDR") return { type: "ip-cidr", value: rule.value, v6: false, target, noResolve: rule.noResolve };
    if (rule.type === "IP-CIDR6") return { type: "ip-cidr", value: rule.value, v6: true, target, noResolve: rule.noResolve };
    if (rule.type === "GEOIP") return { type: "geoip", code: rule.value, target, noResolve: rule.noResolve };
    return { type: "geosite", key: rule.value, target };
  });
}

/** 把规则还原成文本（界面上回显 / 规范化保存）。 */
export function formatProxyCustomRules(rules: readonly ProxyCustomRule[]): string {
  return rules
    .map((rule) => `${rule.type},${rule.value},${rule.target}${rule.noResolve ? ",no-resolve" : ""}`)
    .join("\n");
}
