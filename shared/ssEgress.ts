/**
 * 转发规则的「Shadowsocks 出口」—— 面板、界面、测试共用的那一份规则。
 *
 * 普通的直连规则是入口机自己去连目标。开了 Shadowsocks 出口之后，入口机上的 gost 不再直接
 * 拨目标，而是把连接交给一台 Shadowsocks 服务器，请它代为连接目标：流量从那台服务器（「落地」）
 * 出去，目标看到的来源 IP 是落地的。
 *
 *   客户端 ──▶ 入口机:sourcePort（gost 监听，计数、限速照旧）
 *                └─ chain：ss 连接器 ──▶ 落地 SS 服务器 ──▶ 目标
 *
 * 出口有两种来源：
 *   ss_host  面板管的一台主机上的 Shadowsocks 落地入站（proxy_inbounds，sing-box 跑的）；
 *   ss_link  用户粘贴的外部 ss:// 链接（凭据在面板里加密保存）。
 *
 * 能用哪些加密方式不是拍脑袋定的，是拿随 Agent 下发的 gost 运行时（3.2.6，go-gost/x 0.8.1）
 * 对着 sing-box 1.14.0 的真二进制一条条试出来的：
 *   - aes-128-gcm / aes-256-gcm / chacha20-ietf-poly1305 的 TCP：互通；
 *   - SS2022（2022-blake3-*）的 TCP：gost 和 gost 之间通，和 sing-box 不通（回程解不出来）；
 *   - 所有方法的 UDP：不通（经典 AEAD 的回包 gost 解不出，SS2022 的包 sing-box 验不过）。
 * 所以出口目前只走 TCP、只收经典 AEAD。等 gost 运行时换了能互通的版本，改这里的两个常量即可，
 * 面板、Agent 两边的下发和校验代码都已经按「TCP + UDP、经典 + SS2022」写好了。
 *
 * 这里只放纯函数和常量；加密、查库在 server/ssEgress.ts。
 */

import { parseProxyNodeLink } from "./proxyNode";
import { isAgentVersionAtLeast } from "./version";

/** Agent 从这一版起会在写入 gost 配置前校验 Shadowsocks 出口节点。比它旧的 Agent 上，带出口的规则按停用下发。 */
export const SS_EGRESS_AGENT_VERSION = "2.2.226";

export const RULE_EGRESS_TYPES = ["none", "ss_host", "ss_link"] as const;
export type RuleEgressType = (typeof RULE_EGRESS_TYPES)[number];

export const RULE_EGRESS_TYPE_LABELS: Record<RuleEgressType, string> = {
  none: "直接连接",
  ss_host: "落地主机（Shadowsocks）",
  ss_link: "外部 Shadowsocks 链接",
};

/**
 * gost 运行时认得的全部 Shadowsocks 方法（go-gost/go-shadowsocks2 v0.1.1 的 SupportedMethods）。
 * 2022-blake3-chacha20-poly1305 在那份表里是注释掉的。Agent 的配置校验用的是这一张（和 agent/gost_ss_egress.go 一致）。
 */
export const GOST_RUNTIME_SS_METHODS = [
  "aes-128-gcm",
  "aes-256-gcm",
  "chacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
] as const;

/** 面板允许用来做出口的方法：和 sing-box 实测互通的那几个（见文件开头）。 */
export const SS_EGRESS_METHODS = ["aes-256-gcm", "aes-128-gcm", "chacha20-ietf-poly1305"] as const;
export type SsEgressMethod = (typeof SS_EGRESS_METHODS)[number];

/** 一键创建落地入站时用的方法。 */
export const SS_EGRESS_DEFAULT_METHOD: SsEgressMethod = "aes-256-gcm";

/** UDP 能不能走出口。见文件开头：当前 gost 运行时的 SS UDP 和 sing-box 不互通。 */
export const SS_EGRESS_UDP_SUPPORTED = false;

export const SS_EGRESS_UDP_UNSUPPORTED_MESSAGE =
  "当前 gost 运行时的 Shadowsocks UDP 转发和 sing-box 不互通，UDP 暂时不能走出口；请把协议改成 TCP";

/** 常见的别名（v2rayN / Clash / 老 SIP002 链接里会写成这样）。 */
const METHOD_ALIASES: Record<string, string> = {
  aead_aes_128_gcm: "aes-128-gcm",
  aead_aes_256_gcm: "aes-256-gcm",
  aead_chacha20_poly1305: "chacha20-ietf-poly1305",
  "chacha20-poly1305": "chacha20-ietf-poly1305",
};

export function normalizeSsMethod(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  return METHOD_ALIASES[value] || value;
}

export function isSs2022Method(method: unknown): boolean {
  return normalizeSsMethod(method).startsWith("2022-");
}

/** 这个方法能不能做出口。能回 null，否则回给人看的原因。 */
export function ssEgressMethodError(raw: unknown): string | null {
  const method = normalizeSsMethod(raw);
  if (!method) return "缺少加密方式";
  if ((SS_EGRESS_METHODS as readonly string[]).includes(method)) return null;
  const supported = SS_EGRESS_METHODS.join(" / ");
  if (isSs2022Method(method)) {
    return `暂不支持 ${method} 做出口：当前 gost 运行时的 SS2022 和 sing-box 等主流服务端不互通。请改用 ${supported}`;
  }
  if (["none", "plain", "table", "rc4-md5"].includes(method) || /-(cfb|ctr|ofb)$/.test(method)) {
    return `${method} 是不安全的老式加密，不支持做出口。请改用 ${supported}`;
  }
  return `不支持的加密方式 ${method}，出口只支持 ${supported}`;
}

export type SsEgressEndpoint = {
  server: string;
  port: number;
  method: string;
  password: string;
  /** 链接里带的名字，只用来显示。 */
  name?: string;
};

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function normalizeServer(value: unknown) {
  return String(value ?? "").trim().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

function isPlausibleServer(server: string) {
  if (!server) return false;
  if (server.includes(":")) return /^[0-9a-f:.]+$/i.test(server);
  return HOSTNAME_PATTERN.test(server);
}

/** 出口服务器这一份配置合不合格。合格回 null。 */
export function ssEgressEndpointError(endpoint: Partial<SsEgressEndpoint> | null | undefined): string | null {
  if (!endpoint) return "缺少出口配置";
  const server = normalizeServer(endpoint.server);
  if (!isPlausibleServer(server)) return "出口服务器地址无效";
  const lower = server.toLowerCase();
  if (lower === "localhost" || lower.startsWith("127.") || lower === "::1" || lower === "0.0.0.0" || lower === "::") {
    return "出口服务器不能是本机地址";
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "出口服务器端口必须在 1-65535 之间";
  const methodError = ssEgressMethodError(endpoint.method);
  if (methodError) return methodError;
  const password = String(endpoint.password ?? "");
  if (!password) return "出口缺少密码";
  if (password.length > 512) return "出口密码太长";
  if (/[\r\n\0]/.test(password)) return "出口密码里不能有换行";
  return null;
}

export type ParseSsEgressLinkResult =
  | { ok: true; endpoint: SsEgressEndpoint }
  | { ok: false; error: string };

/**
 * 解析用户粘贴的 ss:// 链接（SIP002 和老的整段 base64 两种都认，复用 shared/proxyNode 的解析）。
 * 带插件（obfs-local / v2ray-plugin）的链接拒绝：gost 的 ss 连接器不跑插件，连上去只会握手失败。
 */
export function parseSsEgressLink(input: unknown): ParseSsEgressLinkResult {
  const link = String(input ?? "").trim();
  if (!link) return { ok: false, error: "请粘贴 ss:// 链接" };
  if (link.length > 4096) return { ok: false, error: "链接太长" };
  if (!/^ss:\/\//i.test(link)) return { ok: false, error: "只支持 ss:// 开头的 Shadowsocks 链接" };
  const query = link.split("#")[0].split("?")[1] || "";
  if (/(^|&)plugin=/i.test(query)) {
    return { ok: false, error: "不支持带插件（plugin）的 Shadowsocks 链接，请换一条不带插件的" };
  }
  const parsed = parseProxyNodeLink(link);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const node = parsed.node;
  if (node.protocol !== "shadowsocks") return { ok: false, error: "这不是 Shadowsocks 链接" };
  if (node.transport && node.transport !== "tcp") {
    return { ok: false, error: `不支持带 ${node.transport} 传输的 Shadowsocks 链接` };
  }
  const endpoint: SsEgressEndpoint = {
    server: normalizeServer(node.address),
    port: Number(node.port),
    method: normalizeSsMethod(node.method),
    password: String(node.password || ""),
    name: String(node.name || "").trim().slice(0, 64) || undefined,
  };
  const error = ssEgressEndpointError(endpoint);
  if (error) return { ok: false, error };
  return { ok: true, endpoint };
}

/** 给界面看的样子：密码永远不出现。 */
export function maskSsEgressEndpoint(endpoint: Pick<SsEgressEndpoint, "server" | "port" | "method"> | null | undefined): string {
  if (!endpoint) return "";
  const server = normalizeServer(endpoint.server);
  const host = server.includes(":") ? `[${server}]` : server;
  return `ss://${normalizeSsMethod(endpoint.method)}:******@${host}:${Number(endpoint.port) || 0}`;
}

export function isSsEgressAgentSupported(version: string | null | undefined) {
  return isAgentVersionAtLeast(version, SS_EGRESS_AGENT_VERSION);
}

export function ssEgressAgentUpgradeMessage(hostName?: unknown) {
  const name = String(hostName || "").trim();
  return `${name ? `主机「${name}」` : "入口主机"}的 Agent 需要升级到 ${SS_EGRESS_AGENT_VERSION} 或更新版本才能使用 Shadowsocks 出口`;
}

export function normalizeRuleEgressType(value: unknown): RuleEgressType {
  const text = String(value ?? "").trim();
  return (RULE_EGRESS_TYPES as readonly string[]).includes(text) ? (text as RuleEgressType) : "none";
}

export function ruleHasEgress(rule: { egressType?: unknown } | null | undefined) {
  return normalizeRuleEgressType(rule?.egressType) !== "none";
}

export type RuleEgressColumns = {
  egressType: RuleEgressType;
  egressInboundId: number | null;
  egressConfigJson: string | null;
  egressUdp: boolean;
};

export const NO_EGRESS_COLUMNS: RuleEgressColumns = Object.freeze({
  egressType: "none",
  egressInboundId: null,
  egressConfigJson: null,
  egressUdp: false,
}) as RuleEgressColumns;

/** 规则行上的出口那几列，规整成固定的样子（转发组的子规则从模板照抄用）。 */
export function ruleEgressColumnsOf(rule: any): RuleEgressColumns {
  const egressType = normalizeRuleEgressType(rule?.egressType);
  if (egressType === "none") return { ...NO_EGRESS_COLUMNS };
  return {
    egressType,
    egressInboundId: egressType === "ss_host" ? Number(rule?.egressInboundId || 0) || null : null,
    egressConfigJson: egressType === "ss_link" ? (String(rule?.egressConfigJson || "") || null) : null,
    egressUdp: truthy(rule?.egressUdp),
  };
}

/** 规则长什么样才能挂出口。这几样任何一样不对，出口都没法做。 */
export type RuleEgressShape = {
  egressType: unknown;
  forwardType: unknown;
  protocol: unknown;
  egressUdp?: unknown;
  tunnelId?: unknown;
  /** 规则挂的转发组是哪种：port（端口转发资源）/ chain / failover；没挂为空。 */
  forwardGroupMode?: unknown;
  failoverEnabled?: unknown;
  tlsInboundId?: unknown;
};

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value ?? "").toLowerCase() === "true";
}

/** 规则形态对不对。对回 null，否则回给人看的原因。 */
export function ruleEgressShapeError(shape: RuleEgressShape): string | null {
  if (normalizeRuleEgressType(shape.egressType) === "none") return null;
  if (Number(shape.tlsInboundId || 0) > 0) return "共享 TLS 入站上的规则不能使用 Shadowsocks 出口";
  if (Number(shape.tunnelId || 0) > 0) return "走隧道的规则不能再使用 Shadowsocks 出口：隧道出口本身就是落地，二选一即可";
  const groupMode = String(shape.forwardGroupMode ?? "").trim();
  if (groupMode && groupMode !== "port") return "转发链 / 转发组上的规则不能使用 Shadowsocks 出口，请用端口转发或直连规则";
  if (truthy(shape.failoverEnabled)) return "使用 Shadowsocks 出口的规则暂不支持线路组 / 主备线路";
  if (String(shape.forwardType ?? "") !== "gost") {
    return "使用 Shadowsocks 出口的规则必须用 gost 转发（出口是 gost 的转发链实现的），请把转发工具改成 gost";
  }
  const protocol = String(shape.protocol ?? "both");
  const wantsUdp = protocol === "udp" || protocol === "both";
  const udp = truthy(shape.egressUdp);
  if (!SS_EGRESS_UDP_SUPPORTED) {
    if (wantsUdp || udp) return SS_EGRESS_UDP_UNSUPPORTED_MESSAGE;
    return null;
  }
  if (protocol === "udp" && !udp) return "协议只有 UDP 时必须开启「UDP 也走出口」";
  if (protocol === "both" && !udp) return "规则包含 UDP：请开启「UDP 也走出口」，或把协议改成 TCP（否则 UDP 会绕过出口直连目标）";
  if (protocol === "tcp" && udp) return "协议是 TCP，不需要开启「UDP 也走出口」";
  return null;
}

/** 规则卡片上出口那一枚的状态。 */
export const RULE_EGRESS_STATES = [
  "running",
  "paused",
  "agent_upgrade",
  "landing_offline",
  "inbound_missing",
  "inbound_disabled",
  "method_unsupported",
  "config_invalid",
  "self_loop",
  "shape_invalid",
] as const;
export type RuleEgressState = (typeof RULE_EGRESS_STATES)[number];

export const RULE_EGRESS_STATE_LABELS: Record<RuleEgressState, string> = {
  running: "运行",
  paused: "已暂停",
  agent_upgrade: "需要升级 Agent",
  landing_offline: "落地离线",
  inbound_missing: "落地入站已删除",
  inbound_disabled: "落地入站已停用",
  method_unsupported: "加密方式不支持",
  config_invalid: "出口配置失效",
  self_loop: "落地机不能是入口机",
  shape_invalid: "规则需改用 gost 直连",
};

/** 哪些状态下规则根本不会下发（按停用处理）；「落地离线」照样下发：落地上的 sing-box 可能还活着，只是 Agent 掉线。 */
export function ruleEgressStateBlocksDelivery(state: RuleEgressState) {
  return state !== "running" && state !== "paused" && state !== "landing_offline";
}

export function ruleEgressStateTone(state: RuleEgressState): "ok" | "muted" | "warn" {
  if (state === "running") return "ok";
  if (state === "paused") return "muted";
  return "warn";
}

/** 卡片上那一句。 */
export function ruleEgressSummaryText(egress: { type: unknown; landingHostName?: unknown } | null | undefined) {
  const type = normalizeRuleEgressType(egress?.type);
  if (type === "ss_host") {
    const name = String(egress?.landingHostName || "").trim();
    return `经 落地主机 ${name || "（已删除）"} 出口`;
  }
  if (type === "ss_link") return "经 外部 SS 出口";
  return "";
}
