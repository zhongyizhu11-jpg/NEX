/**
 * 订阅模板：每种目标格式一份「开头部分」加一组自定义策略组。
 *
 * 为什么不是整份配置文件当模板（Xboard 的 resources/rules/*.yaml 那种）：那要求面板
 * 带一个 YAML 解析 / 序列化器去把节点塞进现成的树里，而面板到现在都没依赖 YAML 库。
 * 这里的分工是 —— 模板只管「节点之外」的部分（端口、DNS、TUN、日志……），节点、
 * 策略组、规则集、分流规则照旧由面板生成并接在后面。能改的东西覆盖了绝大多数需求
 * （「订阅导进去 DNS 不对」「想要 tun 模式」「要加个 🇭🇰 香港组」），又不会因为
 * 模板写坏一个缩进让整份订阅 500。
 *
 * 三种开头部分：
 *   - Clash：放在 proxies: 前面的 YAML 文本，不能含 proxies / proxy-groups / rule-providers / rules。
 *   - sing-box：一个 JSON 对象（log / dns / inbounds / experimental / route.rules……），面板把
 *     outbounds 和 route 并进去。
 *   - Surge / Loon / Quantumult X / Shadowrocket：整段 [General]（含那一行表头）。
 *   - Base64 / Xray JSON 没有模板（前者没有位置，后者的 DNS / 入站由客户端自己管）。
 *
 * 占位符：{{app_name}} {{panel_url}} {{sub_url}} {{username}} {{expire_date}} {{data_left}} {{test_url}}。
 */

import type { ProxySubCustomGroup } from "./proxySubscriptionPlan";
import type { ProxySubscriptionFormat } from "./proxySubscription";

export const PROXY_SUB_TEMPLATE_TARGETS = ["clash", "singbox", "surge", "loon", "quantumultx", "shadowrocket"] as const;

export type ProxySubTemplateTarget = (typeof PROXY_SUB_TEMPLATE_TARGETS)[number];

export const PROXY_SUB_TEMPLATE_TARGET_LABELS: Record<ProxySubTemplateTarget, string> = {
  clash: "Clash / mihomo / Stash",
  singbox: "sing-box",
  surge: "Surge / Surfboard",
  loon: "Loon",
  quantumultx: "Quantumult X",
  shadowrocket: "Shadowrocket",
};

export function proxySubTemplateTargetForFormat(format: ProxySubscriptionFormat): ProxySubTemplateTarget | null {
  return (PROXY_SUB_TEMPLATE_TARGETS as readonly string[]).includes(format) ? format as ProxySubTemplateTarget : null;
}

export type ProxySubTemplate = {
  id?: number;
  name: string;
  target: ProxySubTemplateTarget;
  prelude: string;
  customGroups: ProxySubCustomGroup[];
  isDefault?: boolean;
};

/** 内置的开头部分。改这里等于改所有没自定义模板的用户的订阅，要慎重。 */
export const PROXY_SUB_BUILTIN_PRELUDES: Record<ProxySubTemplateTarget, string> = {
  clash: [
    "# {{app_name}} 订阅 · {{username}}",
    "mixed-port: 7890",
    "allow-lan: false",
    "mode: rule",
    "log-level: info",
    "ipv6: true",
    "unified-delay: true",
    "tcp-concurrent: true",
    "dns:",
    "  enable: true",
    "  listen: 0.0.0.0:1053",
    "  ipv6: true",
    "  enhanced-mode: fake-ip",
    "  fake-ip-range: 198.18.0.1/16",
    "  fake-ip-filter:",
    "    - \"*.lan\"",
    "    - \"*.local\"",
    "    - \"localhost.ptlogin2.qq.com\"",
    "  default-nameserver:",
    "    - 223.5.5.5",
    "    - 119.29.29.29",
    "  nameserver:",
    "    - https://dns.alidns.com/dns-query",
    "    - https://doh.pub/dns-query",
    "  proxy-server-nameserver:",
    "    - https://dns.alidns.com/dns-query",
    "sniffer:",
    "  enable: true",
    "  sniff:",
    "    HTTP:",
    "      ports: [80, 8080-8880]",
    "    TLS:",
    "      ports: [443, 8443]",
    "",
  ].join("\n"),
  singbox: JSON.stringify({
    log: { level: "info", timestamp: true },
    dns: {
      servers: [
        { tag: "dns-remote", address: "https://1.1.1.1/dns-query", detour: "{{main_group}}" },
        { tag: "dns-direct", address: "https://223.5.5.5/dns-query", detour: "direct" },
        { tag: "dns-local", address: "local", detour: "direct" },
      ],
      rules: [
        { outbound: "any", server: "dns-local" },
        { rule_set: ["geosite-cn"], server: "dns-direct" },
      ],
      final: "dns-remote",
      strategy: "prefer_ipv4",
    },
    inbounds: [
      { type: "tun", tag: "tun-in", address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"], auto_route: true, strict_route: true, stack: "mixed", sniff: true },
      { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080, sniff: true },
    ],
    route: {
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
      ],
      rule_set: [
        { type: "remote", tag: "geosite-cn", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs", download_detour: "direct" },
      ],
      auto_detect_interface: true,
    },
    experimental: {
      cache_file: { enabled: true, store_fakeip: false },
      clash_api: { external_controller: "127.0.0.1:9090" },
    },
  }, null, 2),
  surge: [
    "[General]",
    "loglevel = notify",
    "skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local",
    "dns-server = system, 223.5.5.5, 119.29.29.29",
    "internet-test-url = {{test_url}}",
    "proxy-test-url = {{test_url}}",
  ].join("\n"),
  loon: [
    "[General]",
    "skip-proxy = 127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,100.64.0.0/10,localhost,*.local",
    "dns-server = system,223.5.5.5,119.29.29.29",
    "proxy-test-url = {{test_url}}",
    "internet-test-url = {{test_url}}",
  ].join("\n"),
  quantumultx: [
    "[general]",
    "server_check_url={{test_url}}",
  ].join("\n"),
  shadowrocket: [
    "[General]",
    "bypass-system = true",
    "skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local",
    "dns-server = system",
  ].join("\n"),
};

export type ProxySubTemplateVariables = {
  appName: string;
  panelUrl: string;
  subUrl: string;
  username: string;
  expireDate: string;
  dataLeft: string;
  testUrl: string;
  mainGroup: string;
};

/** 占位符替换。sing-box 的模板是 JSON，值里的引号和反斜杠要转义，否则一个用户名带引号就把 JSON 打坏。 */
export function renderProxySubTemplatePrelude(prelude: string, vars: ProxySubTemplateVariables, target: ProxySubTemplateTarget): string {
  const escape = (value: string) => (target === "singbox" ? JSON.stringify(value).slice(1, -1) : value);
  const map: Record<string, string> = {
    app_name: vars.appName,
    panel_url: vars.panelUrl,
    sub_url: vars.subUrl,
    username: vars.username,
    expire_date: vars.expireDate,
    data_left: vars.dataLeft,
    test_url: vars.testUrl,
    main_group: vars.mainGroup,
  };
  return String(prelude || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => (key in map ? escape(map[key]) : whole));
}

/** Clash 的开头部分不能带这几个键 —— 带了就和面板生成的部分撞车，客户端读到两份 proxies。 */
const CLASH_RESERVED_KEYS = /^(proxies|proxy-groups|rule-providers|rules|proxy-providers)\s*:/m;

export type ProxySubTemplateValidation = { ok: true } | { ok: false; error: string };

export function validateProxySubTemplate(template: Pick<ProxySubTemplate, "target" | "prelude" | "customGroups">): ProxySubTemplateValidation {
  const prelude = String(template.prelude || "");
  if (prelude.length > 60_000) return { ok: false, error: "模板太长（上限 60000 字符）" };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prelude)) return { ok: false, error: "模板里有控制字符" };
  if (template.target === "clash" && CLASH_RESERVED_KEYS.test(prelude)) {
    return { ok: false, error: "Clash 模板不能含 proxies / proxy-groups / rule-providers / rules，这几段由面板生成" };
  }
  if (template.target === "singbox" && prelude.trim()) {
    try {
      // 占位符先换成占位值再校验 JSON，否则 {{x}} 本身就不是合法 JSON。
      const probe = prelude.replace(/\{\{\s*[a-z_]+\s*\}\}/g, "x");
      const parsed = JSON.parse(probe);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "sing-box 模板必须是一个 JSON 对象" };
      if (Array.isArray((parsed as any).outbounds) && (parsed as any).outbounds.some((item: any) => item?.tag === "direct")) {
        return { ok: false, error: "sing-box 模板里不用写 direct 出站，面板会生成" };
      }
    } catch (error) {
      return { ok: false, error: `sing-box 模板不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if ((template.target === "surge" || template.target === "loon" || template.target === "shadowrocket") && prelude.trim() && !/^\s*\[General\]/i.test(prelude)) {
    return { ok: false, error: "这种模板要以 [General] 开头" };
  }
  if (template.target === "quantumultx" && prelude.trim() && !/^\s*\[general\]/i.test(prelude)) {
    return { ok: false, error: "Quantumult X 模板要以 [general] 开头" };
  }
  for (const group of template.customGroups || []) {
    const name = String(group.name || "").trim();
    if (!name) return { ok: false, error: "自定义策略组要有名字" };
    if (name.length > 64 || /[,=\u0000-\u001f]/.test(name)) return { ok: false, error: `策略组名「${name}」不合法（不能含逗号、等号）` };
    if (!["select", "url-test", "fallback", "load-balance"].includes(group.type)) return { ok: false, error: `策略组「${name}」的类型不认识` };
    if (String(group.filter || "").length > 200) return { ok: false, error: `策略组「${name}」的筛选表达式太长` };
  }
  return { ok: true };
}

export function normalizeProxySubCustomGroups(input: unknown): ProxySubCustomGroup[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item: any) => ({
      name: String(item?.name || "").trim().slice(0, 64),
      type: (["select", "url-test", "fallback", "load-balance"].includes(item?.type) ? item.type : "select") as ProxySubCustomGroup["type"],
      filter: String(item?.filter || "").trim().slice(0, 200),
      includeGroups: item?.includeGroups === true,
    }))
    .filter((item) => item.name)
    .slice(0, 30);
}

export function parseProxySubCustomGroupsJson(json: unknown): ProxySubCustomGroup[] {
  if (!json || typeof json !== "string") return [];
  try {
    return normalizeProxySubCustomGroups(JSON.parse(json));
  } catch {
    return [];
  }
}
