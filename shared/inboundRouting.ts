/**
 * 落地节点的「分流」（端口级分流 + 按解锁检测选出口）。
 *
 * 落地机原来只做一件事：入站进来的流量全部直连出去。可一台落地往往只解锁一部分服务 ——
 * 美西机解 Netflix 不解 ChatGPT、港机反过来。分流就是给一个入站（端口）加几条规则：
 *   「Netflix / Disney+ / 自定义域名」→ 直连 / 拒绝 / 另一台落地的 Shadowsocks 入站 / 自动按解锁挑；
 *   其余的照旧直连。
 *
 * 「自动按解锁挑」：面板每次算 sing-box 配置时，在这个入站主人能用的 SS 落地里挑一台
 * 最新一次解锁检测里这几个服务都「可用」的（规则里的服务都要解锁，挑不出来就直连）。
 * 检测结果变了（定期检测、手动检测），下一次心跳配置跟着变 —— 用户不用回来改。
 *
 * 做在落地的 sing-box 上而不是入口的 gost 上：要按域名分，得先嗅探出这条连接去哪，
 * sing-box 本来就能 sniff（TLS SNI / HTTP Host / QUIC），gost 那条路要动 Agent。这样
 * 整件事只改面板生成的配置，已经装好的 Agent 和 sing-box 都不用升级。
 *
 * 本文件是纯函数：规则的规整 / 校验、预设域名、以及「解析好的路由 → sing-box 配置片段」。
 * 挑出口（要查库）在 server/inboundRoutingRuntime.ts。
 */

import { UNLOCK_SERVICES } from "./unlockCheck";

export type InboundRoutePreset = {
  /** 与 shared/unlockCheck.ts 的服务 id 一致 —— 自动选出口就是按这个 id 查检测结果。 */
  id: string;
  name: string;
  /** sing-box 的 domain_suffix：写 netflix.com 同时匹配 netflix.com 和 *.netflix.com。 */
  domains: readonly string[];
};

/**
 * 每个服务的域名后缀。只收各家自己的主域和 CDN 域，不收共享的大 CDN（akamai、cloudfront）——
 * 那会把半个互联网都拐到另一台机器上。漏一两个次要域名的代价是那部分走直连，
 * 多收一个共享域名的代价是不相干的网站全绕路，宁可前者。
 */
const PRESET_DOMAINS: Record<string, readonly string[]> = {
  netflix: ["netflix.com", "netflix.net", "nflxext.com", "nflximg.com", "nflximg.net", "nflxso.net", "nflxvideo.net", "fast.com"],
  disney: ["disneyplus.com", "disney-plus.net", "dssott.com", "bamgrid.com", "disneystreaming.com", "disneynow.com"],
  youtube_premium: ["youtube.com", "googlevideo.com", "ytimg.com", "youtu.be", "youtube-nocookie.com", "ggpht.com", "youtubei.googleapis.com"],
  tiktok: ["tiktok.com", "tiktokv.com", "tiktokcdn.com", "tiktokcdn-us.com", "byteoversea.com", "ibytedtos.com", "ibyteimg.com", "muscdn.com"],
  chatgpt: ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "sora.com"],
  claude: ["claude.ai", "anthropic.com", "claude.com", "claudeusercontent.com"],
  gemini: ["gemini.google.com", "bard.google.com", "generativelanguage.googleapis.com", "aistudio.google.com", "makersuite.google.com", "alkalimakersuite-pa.clients6.google.com"],
  grok: ["grok.com", "x.ai"],
  perplexity: ["perplexity.ai", "pplx.ai"],
};

export const INBOUND_ROUTE_PRESETS: readonly InboundRoutePreset[] = UNLOCK_SERVICES
  .filter((service) => PRESET_DOMAINS[service.id])
  .map((service) => ({ id: service.id, name: service.name, domains: PRESET_DOMAINS[service.id] }));

const PRESET_BY_ID = new Map(INBOUND_ROUTE_PRESETS.map((preset) => [preset.id, preset]));

export function inboundRoutePreset(id: string) {
  return PRESET_BY_ID.get(id);
}

export const INBOUND_ROUTE_TARGETS = ["direct", "block", "landing", "auto_unlock"] as const;
export type InboundRouteTargetType = (typeof INBOUND_ROUTE_TARGETS)[number];

export const INBOUND_ROUTE_TARGET_LABELS: Record<InboundRouteTargetType, string> = {
  direct: "直连",
  block: "拒绝",
  landing: "走另一台落地",
  auto_unlock: "自动：挑解锁的落地",
};

export type InboundRoute = {
  presets: string[];
  domains: string[];
  target: InboundRouteTargetType;
  /** target = landing 时：另一台落地上的 Shadowsocks 入站 id。 */
  landingInboundId: number;
};

export type InboundRouting = { routes: InboundRoute[] };

export const MAX_INBOUND_ROUTES = 10;
export const MAX_INBOUND_ROUTE_DOMAINS = 200;

/**
 * 自定义域名的规整：去掉协议、路径、端口、开头的 *. 和点，小写。
 * 只收像域名的东西（字母数字、- 和 .，至少一个点）—— 写错的那条丢掉，不让它变成匹配一切的空串。
 */
export function normalizeRouteDomain(value: unknown): string {
  let text = String(value ?? "").trim().toLowerCase();
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  text = text.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
  if (text.length > 253 || !text.includes(".")) return "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(text)) return "";
  if (text.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return "";
  return text;
}

/** 一段文本里的域名（换行、逗号、空格分隔都行）。 */
export function parseRouteDomains(text: string): string[] {
  return normalizeDomainList(String(text || "").split(/[\s,，;；]+/));
}

function normalizeDomainList(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const domain = normalizeRouteDomain(value);
    if (domain && !out.includes(domain)) out.push(domain);
    if (out.length >= MAX_INBOUND_ROUTE_DOMAINS) break;
  }
  return out;
}

function normalizeRoute(raw: any): InboundRoute | null {
  if (!raw || typeof raw !== "object") return null;
  const presets: string[] = [];
  for (const id of Array.isArray(raw.presets) ? raw.presets : []) {
    const key = String(id);
    if (PRESET_BY_ID.has(key) && !presets.includes(key)) presets.push(key);
  }
  const domains = normalizeDomainList(Array.isArray(raw.domains) ? raw.domains : []);
  const target = (INBOUND_ROUTE_TARGETS as readonly string[]).includes(String(raw.target)) ? raw.target as InboundRouteTargetType : "direct";
  const landingInboundId = target === "landing" ? Math.max(0, Math.floor(Number(raw.landingInboundId) || 0)) : 0;
  if (presets.length === 0 && domains.length === 0) return null;
  return { presets, domains, target, landingInboundId };
}

/** 从存储 / 接口还原。坏的条目丢掉；一条都不剩返回 null（= 不分流，全部直连）。 */
export function parseInboundRouting(raw: unknown): InboundRouting | null {
  let value = raw;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const list = Array.isArray((value as any)?.routes) ? (value as any).routes : [];
  const routes = list.map(normalizeRoute).filter((route: InboundRoute | null): route is InboundRoute => !!route).slice(0, MAX_INBOUND_ROUTES);
  return routes.length > 0 ? { routes } : null;
}

export function serializeInboundRouting(routing: InboundRouting | null | undefined): string | null {
  const parsed = parseInboundRouting(routing ?? null);
  return parsed ? JSON.stringify(parsed) : null;
}

/**
 * 保存前的形态检查（不查库）。权限、落地入站是不是 SS、是不是同一台机器在服务端查。
 * 返回给人看的原因；没问题返回 null。
 */
export function inboundRoutingShapeError(raw: unknown): string | null {
  const list = Array.isArray((raw as any)?.routes) ? (raw as any).routes : [];
  if (list.length > MAX_INBOUND_ROUTES) return `分流规则最多 ${MAX_INBOUND_ROUTES} 条`;
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const label = `第 ${index + 1} 条分流`;
    const rawDomains = Array.isArray(item?.domains) ? item.domains.filter((value: unknown) => String(value ?? "").trim()) : [];
    const bad = rawDomains.find((value: unknown) => !normalizeRouteDomain(value));
    if (bad !== undefined) return `${label}里的「${String(bad).slice(0, 60)}」不是域名`;
    const route = normalizeRoute(item);
    if (!route) return `${label}没有选服务也没有填域名`;
    if (route.target === "landing" && route.landingInboundId <= 0) return `${label}要选一台落地`;
    if (route.target === "auto_unlock" && route.presets.length === 0) return `${label}选「自动挑解锁的落地」时至少要选一个服务（按服务的检测结果挑）`;
  }
  return null;
}

/** 这条分流匹配的全部域名后缀（预设 + 自定义，去重）。 */
export function inboundRouteDomainSuffixes(route: Pick<InboundRoute, "presets" | "domains">): string[] {
  const out: string[] = [];
  for (const id of route.presets) {
    for (const domain of PRESET_BY_ID.get(id)?.domains || []) if (!out.includes(domain)) out.push(domain);
  }
  for (const domain of route.domains) if (!out.includes(domain)) out.push(domain);
  return out;
}

export function describeInboundRoute(route: InboundRoute, landingName?: string) {
  const what = [
    ...route.presets.map((id) => PRESET_BY_ID.get(id)?.name || id),
    ...(route.domains.length > 0 ? [route.domains.length <= 2 ? route.domains.join("、") : `${route.domains.length} 个域名`] : []),
  ].join("、");
  const where = route.target === "landing" && landingName ? `走「${landingName}」` : INBOUND_ROUTE_TARGET_LABELS[route.target];
  return `${what} → ${where}`;
}

/* ── 解析好的路由 → sing-box 配置片段 ──────────────────────────────── */

export type ResolvedShadowsocksEgress = {
  server: string;
  port: number;
  method: string;
  password: string;
};

/** 面板挑好出口之后的一条路由：直连、拒绝，或者从某个 SS 出口出去。 */
export type ResolvedInboundRoute = {
  domainSuffix: string[];
  action: "direct" | "block" | "shadowsocks";
  egress?: ResolvedShadowsocksEgress;
};

export type InboundRoutingPlanEntry = { tag: string; routes: readonly ResolvedInboundRoute[] };

/**
 * 生成 route 和多出来的出站。
 *
 * - 每个有分流的入站先来一条 sniff（不嗅探就只认得 IP，按域名分不了）；
 * - 每条分流一条 rule，限定 inbound 为这个入站 —— 别的端口不受影响；
 * - 同一个 SS 出口（地址 + 端口 + 方法 + 密码一样）只建一个出站，多条规则共用；
 * - final 是 direct：没命中的照旧直连，和没有分流时一模一样。
 *
 * 没有任何分流时返回 null —— 调用方就不写 route，生成的配置和以前逐字节一致，
 * 已经在跑的落地不会因为面板升级而重启。
 */
export function buildSingboxRouting(entries: readonly InboundRoutingPlanEntry[]): {
  route: Record<string, unknown>;
  outbounds: Record<string, unknown>[];
} | null {
  const active = entries.filter((entry) => entry.routes.some((route) => route.domainSuffix.length > 0));
  if (active.length === 0) return null;
  const outbounds: Record<string, unknown>[] = [];
  const outboundByKey = new Map<string, string>();
  const egressTag = (egress: ResolvedShadowsocksEgress) => {
    const key = JSON.stringify([egress.server, egress.port, egress.method, egress.password]);
    const existing = outboundByKey.get(key);
    if (existing) return existing;
    const tag = `route-ss-${outboundByKey.size + 1}`;
    outboundByKey.set(key, tag);
    outbounds.push({ type: "shadowsocks", tag, server: egress.server, server_port: egress.port, method: egress.method, password: egress.password });
    return tag;
  };
  const rules: Record<string, unknown>[] = [{ inbound: active.map((entry) => entry.tag), action: "sniff" }];
  for (const entry of active) {
    for (const route of entry.routes) {
      if (route.domainSuffix.length === 0) continue;
      const match = { inbound: [entry.tag], domain_suffix: [...route.domainSuffix] };
      if (route.action === "block") rules.push({ ...match, action: "reject" });
      else if (route.action === "shadowsocks" && route.egress) rules.push({ ...match, action: "route", outbound: egressTag(route.egress) });
      else rules.push({ ...match, action: "route", outbound: "direct" });
    }
  }
  return { route: { rules, final: "direct" }, outbounds };
}
