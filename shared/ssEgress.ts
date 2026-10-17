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
 * 能用哪些加密方式、UDP 能不能走，不是拍脑袋定的，是拿随 Agent 下发的 gost 运行时对着 sing-box 1.14.0
 * 的真二进制一条条试出来的（gost-runtime/test/ss-egress-e2e）：
 *   - 上游 gost 3.2.6（go-gost/x 0.8.1）：经典 AEAD 的 TCP 通；所有 UDP 不通（gost 收不到回包）；
 *     SS2022 只能 gost 对 gost。
 *   - NEX 运行时 3.2.6-nex3 起（gost-runtime/nex-ssu.patch、nex-shadowsocks2.patch 修好了）：经典 AEAD 和
 *     SS2022（2022-blake3-aes-128-gcm / 2022-blake3-aes-256-gcm）的 TCP、UDP 都和 sing-box 互通。
 * 所以「UDP 走出口」和「SS2022 做出口」看的是入口机的能力：Agent ≥ 2.2.227 并且它上报了能力
 * （Agent 实测装着的运行时是 nex3 或更新、没有回滚，才报 ssEgressUdp / ssEgress2022）。
 * 没有能力的入口机上，经典 AEAD 的 TCP 出口照旧；要 UDP 或 SS2022 的规则按停用下发（不退回直连），
 * 卡片显示「UDP 出口需要升级 Agent/运行时」。SS_EGRESS_UDP_SUPPORTED / SS_EGRESS_SS2022_SUPPORTED
 * 是总开关，关掉就回到「只有经典 AEAD 的 TCP」。
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

/** 经典 AEAD：所有支持出口的 Agent（2.2.226 起）上 TCP 都能用。 */
export const SS_EGRESS_CLASSIC_METHODS = ["aes-256-gcm", "aes-128-gcm", "chacha20-ietf-poly1305"] as const;

/** SS2022：要入口机报 ssEgress2022（运行时 nex3 起）。2022-blake3-chacha20-poly1305 gost 不认得。 */
export const SS_EGRESS_2022_METHODS = ["2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm"] as const;

/** 总开关：SS2022 能不能做出口（还要看入口机的能力）。 */
export const SS_EGRESS_SS2022_SUPPORTED = true;

/** 面板允许用来做出口的方法（SS2022 还要入口机有能力，见 ssEgressHostCapabilityError）。 */
export const SS_EGRESS_METHODS: readonly string[] = [
  ...SS_EGRESS_CLASSIC_METHODS,
  ...(SS_EGRESS_SS2022_SUPPORTED ? SS_EGRESS_2022_METHODS : []),
];
export type SsEgressMethod = (typeof SS_EGRESS_CLASSIC_METHODS)[number] | (typeof SS_EGRESS_2022_METHODS)[number];

/** 一键创建落地入站时用的方法：经典 AEAD，所有入口机都能用。 */
export const SS_EGRESS_DEFAULT_METHOD: SsEgressMethod = "aes-256-gcm";

/** 总开关：UDP 能不能走出口（还要看入口机的能力）。 */
export const SS_EGRESS_UDP_SUPPORTED = true;

export const SS_EGRESS_UDP_UNSUPPORTED_MESSAGE =
  "UDP 暂时不能走 Shadowsocks 出口；请把协议改成 TCP";

/**
 * 从这一版起 Agent 会检测装着的 gost 运行时并上报能力。比它旧的 Agent 不报能力，一律按「没有」算。
 */
export const SS_EGRESS_CAPABILITY_AGENT_VERSION = "2.2.227";
/** 运行时的 NEX 构建号门槛：3.2.6-nex3 起 Shadowsocks UDP / SS2022 和 sing-box 互通。 */
export const SS_EGRESS_RUNTIME_MIN_NEX_BUILD = 3;
export const SS_EGRESS_RUNTIME_MIN_VERSION_LABEL = `3.2.6-nex${SS_EGRESS_RUNTIME_MIN_NEX_BUILD}`;
/**
 * 这一版面板带的自编运行时构建号（gost-runtime/build.sh 的 NEX_GOST_BUILD，scripts/check-versions.mjs 会查）。
 * 装机脚本把比它旧的 NEX 自编版换成它；能力门槛仍是上面的 nex3（nex4 只加固了 SS2022 UDP 回包校验；
 * nex5 让关服务时连它的连接一起关，见 shared/gostRuntimeApi.ts GOST_API_CONN_CLOSE_MIN_NEX_BUILD）。
 */
export const NEX_GOST_RUNTIME_BUILD = 5;
/** Agent 心跳里 agentCapabilities 的两项（和 agent/gost_runtime_version.go 一致）。 */
export const AGENT_CAPABILITY_SS_EGRESS_UDP = "ssEgressUdp";
export const AGENT_CAPABILITY_SS_EGRESS_2022 = "ssEgress2022";

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
    if (SS_EGRESS_SS2022_SUPPORTED) return `暂不支持 ${method} 做出口（gost 运行时不认得这个方法）。请改用 ${supported}`;
    return `暂不支持 ${method} 做出口：SS2022 出口已关闭。请改用 ${supported}`;
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
  const keyBytes = ss2022KeyBytes(normalizeSsMethod(endpoint.method));
  if (keyBytes > 0) {
    // SS2022 的密码是 base64 的定长密钥；多用户的「iPSK:uPSK」gost 客户端不支持。
    if (password.includes(":")) return "SS2022 出口不支持多用户密钥（iPSK:uPSK），请用单用户的密钥";
    if (base64KeyLength(password) !== keyBytes) return `${normalizeSsMethod(endpoint.method)} 的密码必须是 ${keyBytes} 字节密钥的 base64`;
  }
  return null;
}

function ss2022KeyBytes(method: string) {
  if (method === "2022-blake3-aes-128-gcm") return 16;
  if (method === "2022-blake3-aes-256-gcm") return 32;
  return 0;
}

/**
 * gost 解 SS2022 密钥只认带「=」补齐的标准 base64（core.Base64Decode = StdEncoding），解不开就留下空的
 * 连接器，第一条连接进来整个运行时崩掉。用户粘的链接常常不带补齐，下发前统一补好；经典方法原样返回。
 */
export function canonicalSsEgressPassword(method: unknown, password: unknown) {
  const text = String(password ?? "");
  if (!ss2022KeyBytes(normalizeSsMethod(String(method ?? "")))) return text;
  const key = text.trim().replace(/=+$/, "");
  return key.length % 4 === 0 ? key : key + "=".repeat(4 - (key.length % 4));
}

/** base64 解出来的字节数；补齐和长度对不上（解不开）时 -1。补不补「=」都认，下发前由 canonicalSsEgressPassword 补齐。 */
function base64KeyLength(value: string) {
  const match = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(value.trim());
  if (!match) return -1;
  const body = match[1].length;
  const padding = match[2].length;
  // 去掉「=」后余 1 的长度不是合法 base64；带了「=」就必须正好补到 4 的倍数。
  if (body % 4 === 1) return -1;
  if (padding > 0 && (body + padding) % 4 !== 0) return -1;
  return Math.floor((body * 3) / 4);
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

/** 心跳里上报的能力列表（数组或逗号分隔的字符串）规整成去重的数组。 */
export function parseAgentCapabilities(raw: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string") {
    const text = raw.trim();
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        list = [];
      }
    } else list = text.split(",");
  }
  return Array.from(new Set(list
    .map((item) => String(item ?? "").trim())
    .filter((item) => /^[A-Za-z0-9_.-]{1,64}$/.test(item))))
    .slice(0, 64)
    .sort();
}

export type SsEgressHostCapabilities = { udp: boolean; ss2022: boolean };

/**
 * 入口机现在能不能做 UDP 出口 / SS2022 出口。两样都要：Agent ≥ 2.2.227（旧 Agent 不会报能力，这里
 * 再把一道，防止降级后库里留着旧的能力）、它这次上报的能力里有对应的那一项。
 */
export function hostSsEgressCapabilities(host: { agentVersion?: unknown; agentCapabilities?: unknown } | null | undefined): SsEgressHostCapabilities {
  if (!host || !isAgentVersionAtLeast(String(host.agentVersion || ""), SS_EGRESS_CAPABILITY_AGENT_VERSION)) {
    return { udp: false, ss2022: false };
  }
  const caps = new Set(parseAgentCapabilities(host.agentCapabilities));
  return {
    udp: SS_EGRESS_UDP_SUPPORTED && caps.has(AGENT_CAPABILITY_SS_EGRESS_UDP),
    ss2022: SS_EGRESS_SS2022_SUPPORTED && caps.has(AGENT_CAPABILITY_SS_EGRESS_2022),
  };
}

function hostLabelOf(host: { name?: unknown } | null | undefined) {
  const name = String(host?.name || "").trim();
  return name ? `主机「${name}」` : "入口主机";
}

function runtimeRequirementText(host: { agentVersion?: unknown; runtimeVersion?: unknown } | null | undefined) {
  const agent = String(host?.agentVersion || "").trim() || "未知";
  const runtime = String(host?.runtimeVersion || "").trim() || "未知";
  return `需要 Agent ${SS_EGRESS_CAPABILITY_AGENT_VERSION} 或更新、gost 运行时 ${SS_EGRESS_RUNTIME_MIN_VERSION_LABEL} 或更新（当前 Agent ${agent}，运行时 ${runtime}）`;
}

/** UDP 出口需要升级时给人看的话。 */
export function ssEgressUdpUpgradeMessage(host?: { name?: unknown; agentVersion?: unknown; runtimeVersion?: unknown } | null) {
  return `${hostLabelOf(host)}还不能让 UDP 走 Shadowsocks 出口：${runtimeRequirementText(host)}。请在主机列表里升级 Agent（会一起升级运行时）`;
}

export function ssEgress2022UpgradeMessage(host?: { name?: unknown; agentVersion?: unknown; runtimeVersion?: unknown } | null) {
  return `${hostLabelOf(host)}还不能用 SS2022 做 Shadowsocks 出口：${runtimeRequirementText(host)}。请升级 Agent，或改用 ${SS_EGRESS_CLASSIC_METHODS.join(" / ")}`;
}

/**
 * 这台入口机撑不撑得起这个出口（UDP / SS2022 两样能力）。撑得起回 null，否则回给人看的原因。
 * 只管能力；Agent 低于 2.2.226 的情况由 isSsEgressAgentSupported 先拦。
 */
export function ssEgressHostCapabilityError(
  host: { name?: unknown; agentVersion?: unknown; runtimeVersion?: unknown; agentCapabilities?: unknown } | null | undefined,
  need: { udp: boolean; method?: unknown },
): string | null {
  const caps = hostSsEgressCapabilities(host);
  if (need.method !== undefined && isSs2022Method(need.method) && !caps.ss2022) return ssEgress2022UpgradeMessage(host);
  if (need.udp && !caps.udp) return ssEgressUdpUpgradeMessage(host);
  return null;
}

/** 这条规则的出口要不要 UDP 能力：协议里有 UDP，并且勾了「UDP 也走出口」。 */
export function ruleEgressWantsUdp(rule: { protocol?: unknown; egressUdp?: unknown } | null | undefined) {
  const protocol = String(rule?.protocol ?? "both");
  return truthy(rule?.egressUdp) && (protocol === "udp" || protocol === "both");
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
  "udp_runtime_upgrade",
  "ss2022_runtime_upgrade",
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
  udp_runtime_upgrade: "UDP 出口需要升级 Agent/运行时",
  ss2022_runtime_upgrade: "SS2022 出口需要升级 Agent/运行时",
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
export function ruleEgressSummaryText(egress: { type: unknown; landingHostName?: unknown; udp?: unknown } | null | undefined) {
  const type = normalizeRuleEgressType(egress?.type);
  // udp 是「UDP 出口确实下发了」，不是「勾了」：撑不起的入口机上不写「含 UDP」。
  const udp = egress?.udp === true ? "（含 UDP）" : "";
  if (type === "ss_host") {
    const name = String(egress?.landingHostName || "").trim();
    return `经 落地主机 ${name || "（已删除）"} 出口${udp}`;
  }
  // 外部 SS 服务器开没开 UDP 中继面板查不到：如实写成「需对端支持」，不当成已经通了。
  if (type === "ss_link") return `经 外部 SS 出口${egress?.udp === true ? "（含 UDP，需对端支持 UDP）" : ""}`;
  return "";
}
