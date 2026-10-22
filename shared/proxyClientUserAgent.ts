/**
 * 从 User-Agent 认出是哪家客户端、什么版本，以及该给它哪种订阅格式。
 *
 * 原来只认十来个子串，认不出来就落到令牌默认格式上。问题有两个：
 *   1. 新客户端（Happ、v2RayTun、Karing、Mihomo Party……）一律掉到默认格式；
 *   2. 同一家不同版本吃的格式不一样 —— v2rayN 6.40 起、v2rayNG 1.8.29 起能吃 Xray JSON
 *      （协议参数更全、不用再靠分享链接压缩），老版本只认 base64。
 *
 * 所以做成一张数据表：每条一个正则、一个版本正则、一个（可按版本变化的）目标格式。
 * 顺序有讲究：Stash 的 UA 里带 "Clash"，Clash Verge 的带 "clash"，先匹配更具体的。
 *
 * 版本门控的依据（Marzban 的 subscription router 和 Xboard 的 protocolRequirements 都这么做）：
 *   v2rayN   ≥ 6.40     → v2ray-json
 *   v2rayNG  ≥ 1.8.29   → v2ray-json
 *   Happ     ≥ 1.63.1   → v2ray-json
 * 其余 Xray 系客户端照旧 base64。
 */

import type { ProxySubscriptionFormat } from "./proxySubscription";

export type ProxyClientFamilyId =
  | "mihomo"
  | "clash-premium"
  | "stash"
  | "singbox"
  | "karing"
  | "hiddify"
  | "nekobox"
  | "shadowrocket"
  | "quantumultx"
  | "surge"
  | "surfboard"
  | "egern"
  | "loon"
  | "v2rayn"
  | "v2rayng"
  | "happ"
  | "streisand"
  | "v2raytun"
  | "browser"
  | "unknown";

export type DetectedProxyClient = {
  family: ProxyClientFamilyId;
  label: string;
  /** 认出来的版本号，认不出是空串。 */
  version: string;
  /** 该给它哪种格式；null 表示认不出客户端，交给调用方回落。 */
  target: ProxySubscriptionFormat | null;
  /** 浏览器打开的（给落地页用）。 */
  browser: boolean;
};

export const PROXY_CLIENT_FAMILY_LABELS: Record<ProxyClientFamilyId, string> = {
  mihomo: "Clash / mihomo",
  "clash-premium": "原版 Clash",
  stash: "Stash",
  singbox: "sing-box",
  karing: "Karing",
  hiddify: "Hiddify",
  nekobox: "NekoBox / NekoRay",
  shadowrocket: "Shadowrocket",
  quantumultx: "Quantumult X",
  surge: "Surge",
  surfboard: "Surfboard",
  egern: "Egern",
  loon: "Loon",
  v2rayn: "v2rayN",
  v2rayng: "v2rayNG",
  happ: "Happ",
  streisand: "Streisand",
  v2raytun: "v2RayTun",
  browser: "浏览器",
  unknown: "未识别",
};

type Rule = {
  family: ProxyClientFamilyId;
  pattern: RegExp;
  /** 从 UA 里取版本：第一个捕获组。不给就用通用的「家族名后面的数字串」。 */
  version?: RegExp;
  target: ProxySubscriptionFormat | ((version: string) => ProxySubscriptionFormat);
};

/** 比较 "1.8.29" 这种版本串；缺位按 0。 */
export function compareClientVersion(a: string, b: string): number {
  const pa = String(a || "").split(".").map((item) => Number.parseInt(item, 10) || 0);
  const pb = String(b || "").split(".").map((item) => Number.parseInt(item, 10) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (pa[index] || 0) - (pb[index] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function clientVersionAtLeast(version: string, minimum: string): boolean {
  if (!version) return false;
  return compareClientVersion(version, minimum) >= 0;
}

const v = (pattern: string) => new RegExp(pattern, "i");

/**
 * 顺序即优先级。每条写明依据的 UA 样本（来自各客户端源码或实际抓包）。
 */
const RULES: readonly Rule[] = [
  // Stash：Stash/2.6.0 (iPhone; iOS 17) … 带 Clash 字样，必须排在 Clash 前面。
  { family: "stash", pattern: /stash/i, version: v("stash[/ ]v?([0-9.]+)"), target: "clash" },
  // mihomo 系：clash-verge/v1.7.7、Clash Verge/1.x、clash.meta/1.18、mihomo/v1.18、
  // FlClash/0.8.0、Mihomo Party/1.5.0、ClashMetaForAndroid/2.11、ClashX Meta/1.4
  { family: "mihomo", pattern: /clash[- ]?verge|clash\.?meta|mihomo|flclash|clashmetaforandroid|clashx meta|meta/i, version: v("(?:clash[- ]?verge|clash\\.?meta|mihomo(?:[- ]party)?|flclash|clashmetaforandroid|clashx meta)[/ ]v?([0-9.]+)"), target: "clash" },
  // 原版 Clash（Premium 内核）：ClashX/1.118、ClashforWindows/0.20.39、clash/1.0
  { family: "clash-premium", pattern: /clashx\/|clash ?for ?windows|clash\//i, version: v("clash(?:x|forwindows| for windows)?[/ ]v?([0-9.]+)"), target: "clash" },
  // 兜底的 clash 字样（Clash for Android 等），按 mihomo 对待：mihomo 能读的它大多能读。
  { family: "mihomo", pattern: /clash/i, version: v("clash[^/]*[/ ]v?([0-9.]+)"), target: "clash" },
  // sing-box 系：SFA/1.9.0、SFI/1.9.0、SFM、SFT、sing-box 1.9.0、Karing/1.0.0、HiddifyNext/2.0
  // 带内核名的 GUI（Hiddify / NekoBox / Karing 的 UA 里都可能写着 sing-box x.y）要排在裸 sing-box 前面。
  { family: "karing", pattern: /karing/i, version: v("karing[/ ]v?([0-9.]+)"), target: "singbox" },
  // Hiddify：HiddifyNext/2.5.7 —— 它吃通用链接订阅（官方 wiki 的 sublink），不给 sing-box 全量配置。
  { family: "hiddify", pattern: /hiddify/i, version: v("hiddify(?:next)?[/ ]v?([0-9.]+)"), target: "base64" },
  { family: "nekobox", pattern: /nekobox|nekoray/i, version: v("neko(?:box|ray)[/ ]v?([0-9.]+)"), target: "base64" },
  { family: "singbox", pattern: /sing-?box|\bSF[AIMT]\b/i, version: v("(?:sing-?box|SF[AIMT])[/ ]v?([0-9.]+)"), target: "singbox" },
  { family: "shadowrocket", pattern: /shadowrocket/i, version: v("shadowrocket[/ ]v?([0-9.]+)"), target: "shadowrocket" },
  // QX 的 UA 里域名部分是 URL 编码的 "Quantumult%20X"。
  { family: "quantumultx", pattern: /quantumult/i, version: v("quantumult(?:%20| )?x[/ ]v?([0-9.]+)"), target: "quantumultx" },
  { family: "surfboard", pattern: /surfboard/i, version: v("surfboard[/ ]v?([0-9.]+)"), target: "surge" },
  // Egern 读 Surge 格式。
  { family: "egern", pattern: /egern/i, version: v("egern[/ ]v?([0-9.]+)"), target: "surge" },
  { family: "surge", pattern: /surge/i, version: v("surge(?: ios| mac|ios|mac)?[/ ]v?([0-9.]+)"), target: "surge" },
  { family: "loon", pattern: /loon/i, version: v("loon[/ ]v?([0-9.]+)"), target: "loon" },
  // v2rayNG 必须排在 v2rayN 前面：两者都含 "v2rayN"。
  { family: "v2rayng", pattern: /v2rayng/i, version: v("v2rayng[/ ]v?([0-9.]+)"), target: (version) => (clientVersionAtLeast(version, "1.8.29") ? "v2rayjson" : "base64") },
  { family: "v2rayn", pattern: /v2rayn/i, version: v("v2rayn[/ ]v?([0-9.]+)"), target: (version) => (clientVersionAtLeast(version, "6.40") ? "v2rayjson" : "base64") },
  { family: "happ", pattern: /\bhapp\b/i, version: v("happ[/ ]v?([0-9.]+)"), target: (version) => (clientVersionAtLeast(version, "1.63.1") ? "v2rayjson" : "base64") },
  { family: "streisand", pattern: /streisand/i, version: v("streisand[/ ]v?([0-9.]+)"), target: "base64" },
  { family: "v2raytun", pattern: /v2raytun/i, version: v("v2raytun[/ ]v?([0-9.]+)"), target: "base64" },
];

/**
 * `flag` 参数是 Xboard 那套的习惯：客户端 UA 认不出来时，用户可以在地址上手写
 * `flag=clash` 之类强制指定。值按家族 id 或常见别名解析。
 */
const FLAG_ALIASES: Record<string, ProxyClientFamilyId> = {
  clash: "mihomo",
  meta: "mihomo",
  mihomo: "mihomo",
  verge: "mihomo",
  flclash: "mihomo",
  stash: "stash",
  singbox: "singbox",
  "sing-box": "singbox",
  sfa: "singbox",
  sfi: "singbox",
  karing: "karing",
  hiddify: "hiddify",
  nekobox: "nekobox",
  nekoray: "nekobox",
  shadowrocket: "shadowrocket",
  quantumultx: "quantumultx",
  quanx: "quantumultx",
  qx: "quantumultx",
  surge: "surge",
  surfboard: "surfboard",
  egern: "egern",
  loon: "loon",
  v2rayn: "v2rayn",
  v2rayng: "v2rayng",
  happ: "happ",
  streisand: "streisand",
  v2raytun: "v2raytun",
};

function targetFor(rule: Rule, version: string): ProxySubscriptionFormat {
  return typeof rule.target === "function" ? rule.target(version) : rule.target;
}

function extractVersion(ua: string, rule: Rule): string {
  const match = rule.version ? ua.match(rule.version) : null;
  if (match && match[1]) return match[1].replace(/\.$/, "");
  return "";
}

export function detectProxyClient(userAgent: unknown, flag?: unknown): DetectedProxyClient {
  const ua = String(userAgent ?? "").trim();
  const flagText = String(flag ?? "").trim().toLowerCase();
  if (flagText && FLAG_ALIASES[flagText]) {
    const family = FLAG_ALIASES[flagText];
    const rule = RULES.find((item) => item.family === family);
    const version = rule ? extractVersion(ua, rule) : "";
    return {
      family,
      label: PROXY_CLIENT_FAMILY_LABELS[family],
      version,
      target: rule ? targetFor(rule, version) : null,
      browser: false,
    };
  }
  if (!ua) return { family: "unknown", label: PROXY_CLIENT_FAMILY_LABELS.unknown, version: "", target: null, browser: false };
  for (const rule of RULES) {
    if (!rule.pattern.test(ua)) continue;
    const version = extractVersion(ua, rule);
    return { family: rule.family, label: PROXY_CLIENT_FAMILY_LABELS[rule.family], version, target: targetFor(rule, version), browser: false };
  }
  // 浏览器：Mozilla 开头、带常见引擎名；订阅客户端里只有极少数伪装成浏览器，那些会先被上面认出。
  if (/^mozilla\/\d/i.test(ua) && /(gecko|webkit|trident|chrome|safari|firefox|edge)/i.test(ua)) {
    return { family: "browser", label: PROXY_CLIENT_FAMILY_LABELS.browser, version: "", target: null, browser: true };
  }
  return { family: "unknown", label: PROXY_CLIENT_FAMILY_LABELS.unknown, version: "", target: null, browser: false };
}

/**
 * 这家客户端在这个版本上，某项能力有没有。没列出的一律当作有 —— 宁可多发一个节点，
 * 也不要凭猜测吞掉（吞掉的那个用户看不见原因）。
 *
 * 版本依据：Xboard 的 protocolRequirements（hysteria2 / ECH 的最低版本），
 * mihomo 的 release notes（anytls 1.19.0、xhttp 1.19.2），sing-box 的（anytls 1.12，xhttp 无）。
 */
export type ProxyClientCapability = "vless" | "hysteria2" | "tuic" | "anytls" | "reality" | "xhttp" | "httpupgrade";

const CAPABILITY_NAMES: Record<ProxyClientCapability, string> = {
  vless: "VLESS",
  hysteria2: "Hysteria2",
  tuic: "TUIC",
  anytls: "AnyTLS",
  reality: "REALITY",
  xhttp: "XHTTP 传输",
  httpupgrade: "HTTPUpgrade 传输",
};

/**
 * 某个家族整个没有的能力（跟版本无关）。只列有把握的：原版 Clash（Premium 内核）
 * 2023 年停更，协议表里没有 VLESS / Hysteria2 / AnyTLS / REALITY，也没有 HTTPUpgrade / XHTTP。
 * 订阅格式那一层（proxySubscription.ts）管的是「这种格式写不写得出」，这里管的是
 * 「这家客户端读不读得懂」—— 同一份 Clash YAML，mihomo 读得懂，原版 Clash 读到 vless 就整份拒绝。
 */
const FAMILY_UNSUPPORTED: Partial<Record<ProxyClientFamilyId, readonly ProxyClientCapability[]>> = {
  "clash-premium": ["vless", "hysteria2", "anytls", "reality", "xhttp", "httpupgrade"],
};

export function clientFamilyUnsupportedReason(client: Pick<DetectedProxyClient, "family" | "label">, capability: ProxyClientCapability): string {
  const list = FAMILY_UNSUPPORTED[client.family];
  if (!list || !list.includes(capability)) return "";
  return `${client.label} 不支持 ${CAPABILITY_NAMES[capability]}`;
}

const MINIMUM_VERSIONS: Partial<Record<ProxyClientFamilyId, Partial<Record<ProxyClientCapability, string>>>> = {
  mihomo: { anytls: "1.19.0", xhttp: "1.19.2" },
  v2rayng: { hysteria2: "1.9.5", anytls: "1.9.40" },
  v2rayn: { hysteria2: "6.31", anytls: "7.5" },
  singbox: { anytls: "1.12.0" },
  karing: { anytls: "1.1.0" },
};

export function clientSupportsCapability(client: Pick<DetectedProxyClient, "family" | "version">, capability: ProxyClientCapability): boolean {
  const minimum = MINIMUM_VERSIONS[client.family]?.[capability];
  if (!minimum) return true;
  // 版本认不出来时不门控：拒绝的代价是整条节点消失，而版本缺失多半是 UA 没写全。
  if (!client.version) return true;
  return clientVersionAtLeast(client.version, minimum);
}

/** 能力门控的中文原因，写进文件头的「已跳过」说明。 */
export function clientCapabilityReason(client: DetectedProxyClient, capability: ProxyClientCapability): string {
  const minimum = MINIMUM_VERSIONS[client.family]?.[capability];
  if (!minimum || clientSupportsCapability(client, capability)) return "";
  return `${client.label} ${client.version} 不支持 ${CAPABILITY_NAMES[capability]}（需要 ${minimum} 以上）`;
}

/** 测试与界面用：所有识别规则覆盖的家族。 */
export function proxyClientFamiliesInUserAgentTable(): ProxyClientFamilyId[] {
  return Array.from(new Set(RULES.map((rule) => rule.family)));
}
