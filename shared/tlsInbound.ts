/**
 * 共享 TLS 入站（SNI 分流）—— 面板、界面、测试共用的那一份规则。
 *
 * 一台主机上开一个 TCP 端口（通常是 443），多条规则（可以属于不同用户）共用它：
 * Agent 读 TLS ClientHello 里的 SNI，把**还没解密**的连接原样交给对应规则。节点上
 * 不终止 TLS、不放证书，也不看 HTTP Host —— 纯透传。
 *
 * 这里只放纯函数和常量：名字怎么规整、白名单怎么匹配、入站设置的取值范围。
 * IDNA（中文域名 → xn--）由调用方注入：服务端用 node:url 的 domainToASCII，
 * 浏览器里用 URL 解析做同样的事（只是给输入框提示用，最终以服务端为准）。
 */

import { isAgentVersionAtLeast } from "./version";

/** Agent 从这一版起认得 sniInbounds 段。比它旧的 Agent 上，共享入站和挂在上面的规则都不下发。 */
export const TLS_INBOUND_AGENT_VERSION = "2.2.224";
/** 一台主机最多开几个共享入站。 */
export const TLS_INBOUND_MAX_PER_HOST = 64;
/** 一条规则最多几个 SNI。 */
export const TLS_INBOUND_MAX_SNI_PER_RULE = 32;
/** 白名单最多几条。 */
export const TLS_INBOUND_MAX_ALLOWLIST = 256;
/** 同时在等 ClientHello 的连接数上限（整个入站）。 */
export const TLS_INBOUND_DEFAULT_MAX_HANDSHAKES = 128;
export const TLS_INBOUND_MAX_HANDSHAKES_LIMIT = 4096;
/** 同一个来源 IP 同时在等 ClientHello 的连接数上限。 */
export const TLS_INBOUND_PER_IP_HANDSHAKES = 16;
/** 等 ClientHello 的超时（秒）。 */
export const TLS_INBOUND_DEFAULT_HANDSHAKE_TIMEOUT = 5;
export const TLS_INBOUND_MAX_HANDSHAKE_TIMEOUT = 30;

export const TLS_INBOUND_SNI_CONFLICT_MESSAGE = "此 SNI 已被其他规则占用（暂停的规则也会保留 SNI）";

export const TLS_INBOUND_UNKNOWN_SNI_ACTIONS = ["reject", "default_rule"] as const;
export type TlsInboundUnknownSniAction = typeof TLS_INBOUND_UNKNOWN_SNI_ACTIONS[number];
export const TLS_INBOUND_PROXY_PROTOCOL_MODES = ["off", "auto"] as const;
export type TlsInboundProxyProtocolMode = typeof TLS_INBOUND_PROXY_PROTOCOL_MODES[number];

export type TlsInboundSettings = {
  name: string;
  port: number;
  isEnabled: boolean;
  allowedSni: string[];
  rejectEmptySni: boolean;
  unknownSniAction: TlsInboundUnknownSniAction;
  defaultRuleId: number | null;
  proxyProtocol: TlsInboundProxyProtocolMode;
  maxHandshakes: number;
  handshakeTimeoutSeconds: number;
};

export type ToAscii = (value: string) => string;

type NameResult = { ok: true; name: string } | { ok: false; error: string };

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * 已经是 ASCII 的主机名合不合法。合法回 null，否则回给人看的原因。
 * 规则：总长 ≤ 253，至少两段，每段 1～63 个 [a-z0-9-]、不以连字符开头或结尾，最后一段不能全是数字。
 */
export function asciiHostnameError(ascii: string): string | null {
  if (!ascii) return "域名格式无效";
  if (ascii.length > 253) return "域名太长（最多 253 个字符）";
  const labels = ascii.split(".");
  if (labels.length < 2) return "请填写完整域名，例如 example.com";
  for (const label of labels) {
    if (!label) return "域名里不能有空段（连续的点）";
    if (label.length > 63) return `域名的每一段最多 63 个字符：${label.slice(0, 20)}…`;
    if (!LABEL_PATTERN.test(label)) return `域名里有无效的一段：${label}`;
  }
  if (/^\d+$/.test(labels[labels.length - 1])) return "SNI 不能是 IP 地址";
  return null;
}

/**
 * 把用户填的一个名字规整成运行时比对用的样子：小写、去掉末尾的点、IDNA 转 ASCII。
 * IP、通配符、端口、协议前缀、路径一律拒绝 —— 运行时只做精确匹配。
 */
export function normalizeSniName(raw: unknown, toAscii: ToAscii): NameResult {
  let value = String(raw ?? "").trim();
  if (!value) return { ok: false, error: "SNI 不能为空" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { ok: false, error: `不要带协议前缀：${value}` };
  if (value.includes("/")) return { ok: false, error: `不要带路径：${value}` };
  if (value.includes("*")) return { ok: false, error: `不支持通配符，请逐个填写域名：${value}` };
  if (value.startsWith("[") || (value.match(/:/g) || []).length > 1) return { ok: false, error: `SNI 不能是 IP 地址：${value}` };
  if (value.includes(":")) return { ok: false, error: `不要带端口：${value}` };
  if (/\s/.test(value)) return { ok: false, error: `域名里不能有空格：${value}` };
  value = value.toLowerCase();
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (!value) return { ok: false, error: "SNI 不能为空" };
  if (IPV4_PATTERN.test(value)) return { ok: false, error: `SNI 不能是 IP 地址：${value}` };
  let ascii = "";
  try {
    ascii = String(toAscii(value) || "").toLowerCase();
  } catch {
    ascii = "";
  }
  if (!ascii) return { ok: false, error: `域名格式无效：${value}` };
  if (ascii.endsWith(".")) ascii = ascii.slice(0, -1);
  if (IPV4_PATTERN.test(ascii)) return { ok: false, error: `SNI 不能是 IP 地址：${value}` };
  const error = asciiHostnameError(ascii);
  if (error) return { ok: false, error: `${error}（${value}）` };
  return { ok: true, name: ascii };
}

/** 文本框里一行一个；也容忍逗号、空格分隔。 */
export function splitSniNameLines(text: unknown): string[] {
  if (Array.isArray(text)) return text.map((item) => String(item ?? "").trim()).filter(Boolean);
  return String(text ?? "")
    .split(/[\n\r,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export type SniNameListResult = { ok: true; names: string[] } | { ok: false; error: string; names: string[] };

/** 规则的 SNI 列表：逐个规整、去重、排序，1～32 个。 */
export function normalizeSniNameList(input: unknown, toAscii: ToAscii): SniNameListResult {
  const raw = splitSniNameLines(input);
  const names = new Set<string>();
  for (const item of raw) {
    const result = normalizeSniName(item, toAscii);
    if (!result.ok) return { ok: false, error: result.error, names: Array.from(names).sort() };
    names.add(result.name);
  }
  const sorted = Array.from(names).sort();
  if (sorted.length === 0) return { ok: false, error: "请至少填写一个 SNI 域名", names: sorted };
  if (sorted.length > TLS_INBOUND_MAX_SNI_PER_RULE) {
    return { ok: false, error: `一条规则最多 ${TLS_INBOUND_MAX_SNI_PER_RULE} 个 SNI，当前 ${sorted.length} 个`, names: sorted };
  }
  return { ok: true, names: sorted };
}

/**
 * 白名单的一项：`example.com` 放行它自己和所有子域名，`.example.com` 只放行子域名。
 * `*.example.com` 当作 `.example.com` 收下（很多人习惯这么写）。
 */
export function normalizeSniAllowlistEntry(raw: unknown, toAscii: ToAscii): NameResult {
  let value = String(raw ?? "").trim();
  if (!value) return { ok: false, error: "白名单项不能为空" };
  let subdomainsOnly = false;
  if (value.startsWith("*.")) {
    subdomainsOnly = true;
    value = value.slice(2);
  } else if (value.startsWith(".")) {
    subdomainsOnly = true;
    value = value.slice(1);
  }
  const result = normalizeSniName(value, toAscii);
  if (!result.ok) return result;
  return { ok: true, name: subdomainsOnly ? `.${result.name}` : result.name };
}

export function normalizeSniAllowlist(input: unknown, toAscii: ToAscii): SniNameListResult {
  const entries = new Set<string>();
  for (const item of splitSniNameLines(input)) {
    const result = normalizeSniAllowlistEntry(item, toAscii);
    if (!result.ok) return { ok: false, error: `白名单：${result.error}`, names: Array.from(entries).sort() };
    entries.add(result.name);
  }
  const sorted = Array.from(entries).sort();
  if (sorted.length > TLS_INBOUND_MAX_ALLOWLIST) {
    return { ok: false, error: `白名单最多 ${TLS_INBOUND_MAX_ALLOWLIST} 项`, names: sorted };
  }
  return { ok: true, names: sorted };
}

/** 名字在不在白名单里。白名单为空表示全部放行。名字和白名单都必须是规整过的。 */
export function sniAllowedByAllowlist(name: string, allowlist: readonly string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const value = String(name || "");
  if (!value) return false;
  for (const entry of allowlist) {
    if (!entry) continue;
    if (entry.startsWith(".")) {
      if (value.length > entry.length && value.endsWith(entry)) return true;
      continue;
    }
    if (value === entry || value.endsWith(`.${entry}`)) return true;
  }
  return false;
}

export function sniNamesOutsideAllowlist(names: readonly string[], allowlist: readonly string[]): string[] {
  return names.filter((name) => !sniAllowedByAllowlist(name, allowlist));
}

/** 库里存的 JSON 文本 → 名字数组。坏数据当空。 */
export function parseSniNameJson(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  const text = String(value ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeTlsInboundUnknownSniAction(value: unknown): TlsInboundUnknownSniAction {
  return String(value || "").trim() === "default_rule" ? "default_rule" : "reject";
}

export function normalizeTlsInboundProxyProtocol(value: unknown): TlsInboundProxyProtocolMode {
  return String(value || "").trim() === "auto" ? "auto" : "off";
}

export function normalizeTlsInboundMaxHandshakes(value: unknown) {
  return clampInt(value, 1, TLS_INBOUND_MAX_HANDSHAKES_LIMIT, TLS_INBOUND_DEFAULT_MAX_HANDSHAKES);
}

export function normalizeTlsInboundHandshakeTimeout(value: unknown) {
  return clampInt(value, 1, TLS_INBOUND_MAX_HANDSHAKE_TIMEOUT, TLS_INBOUND_DEFAULT_HANDSHAKE_TIMEOUT);
}

export function isTlsInboundAgentSupported(agentVersion: string | null | undefined) {
  return isAgentVersionAtLeast(agentVersion, TLS_INBOUND_AGENT_VERSION);
}

/** 老 Agent 上的提示语，界面和服务端说同一句。 */
export function tlsInboundAgentUpgradeMessage(hostName?: string | null) {
  const name = String(hostName || "").trim();
  return `${name ? `主机「${name}」的` : ""}Agent 版本低于 ${TLS_INBOUND_AGENT_VERSION}，不支持共享 TLS 入站，需要升级 Agent`;
}

/** 规则卡片上的一行：「SNI：a.com、b.com @ 主机:443」。名字多了只列前三个。 */
export function formatSniRuleEntry(options: { names: readonly string[]; hostName?: string | null; port?: number | null; max?: number }) {
  const max = Math.max(1, options.max ?? 3);
  const names = options.names.slice(0, max).join("、");
  const more = options.names.length > max ? ` 等 ${options.names.length} 个` : "";
  const host = String(options.hostName || "").trim() || "主机";
  const port = Number(options.port || 0);
  return `SNI：${names || "—"}${more} @ ${host}${port > 0 ? `:${port}` : ""}`;
}

export type TlsInboundRuleState = "ok" | "agent_upgrade" | "inbound_disabled" | "inbound_missing";

/** 一条挂在共享入站上的规则现在能不能跑；不能跑时界面用的标签。 */
export function tlsInboundRuleState(options: {
  inbound: { isEnabled?: unknown } | null | undefined;
  agentVersion: string | null | undefined;
}): TlsInboundRuleState {
  if (!options.inbound) return "inbound_missing";
  const enabled = options.inbound.isEnabled === true || options.inbound.isEnabled === 1 || options.inbound.isEnabled === "1";
  if (!enabled) return "inbound_disabled";
  if (!isTlsInboundAgentSupported(options.agentVersion)) return "agent_upgrade";
  return "ok";
}

export const TLS_INBOUND_RULE_STATE_LABELS: Record<Exclude<TlsInboundRuleState, "ok">, string> = {
  agent_upgrade: "需要升级 Agent",
  inbound_disabled: "入站已停用",
  inbound_missing: "入站不存在",
};

/**
 * 浏览器里的 IDNA：URL 解析会把中文域名转成 xn--。只给输入框提示用，最终以服务端
 * （node:url 的 domainToASCII）为准。解析失败回空串。
 */
export function urlHostnameToAscii(value: string): string {
  try {
    const hostname = new URL(`http://${value}`).hostname;
    return hostname.startsWith("[") ? "" : hostname;
  } catch {
    return "";
  }
}

/** 规则编辑框里「共享 TLS 入站」这一种入口还差什么；null 表示可以提交。和服务端说同样的话。 */
export function sniRuleFormBlocker(
  form: { tlsInboundId: number | null; sniNamesText: string; targetIp: string; targetPort: number },
  inbound: { allowedSni?: readonly string[]; isEnabled?: boolean; agentSupported?: boolean; hostName?: string } | null | undefined,
  toAscii: ToAscii = urlHostnameToAscii,
): string | null {
  if (!form.tlsInboundId || !inbound) return "还没选共享 TLS 入站";
  if (inbound.isEnabled === false) return "这个共享 TLS 入站已停用";
  if (inbound.agentSupported === false) return tlsInboundAgentUpgradeMessage(inbound.hostName);
  const names = normalizeSniNameList(form.sniNamesText, toAscii);
  if (!names.ok) return names.error;
  const outside = sniNamesOutsideAllowlist(names.names, inbound.allowedSni || []);
  if (outside.length > 0) return `以下 SNI 不在这个入站的白名单内：${outside.slice(0, 5).join("、")}`;
  if (!String(form.targetIp || "").trim()) return "还缺目标地址";
  const port = Number(form.targetPort);
  if (!port) return "还缺目标端口";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "目标端口必须在 1-65535 之间";
  return null;
}
