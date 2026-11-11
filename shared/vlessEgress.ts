/**
 * 转发规则的「VLESS Reality 出口」—— 面板、界面、测试共用的那一份规则（Shadowsocks 出口见 shared/ssEgress.ts）。
 *
 * 和 Shadowsocks 出口一样：入口机不直接拨目标，而是请落地代连，目标看到的是落地的 IP。差别在入口机怎么拨落地：
 *
 *   客户端 ──▶ 入口机:sourcePort（gost 监听，计数、限速照旧）
 *                └─ chain：socks5 连接器 ──▶ 127.0.0.1:桥接端口（本机 sing-box，socks 入站，带随机凭据）
 *                                               └─ vless 出站（REALITY + Vision）──▶ 落地 ──▶ 目标
 *
 * 为什么不让 gost 直接拨 VLESS：随 Agent 下发的 gost 运行时（gost 3.2.6 + NEX 的 nex1~nex5 补丁，见
 * gost-runtime/build.sh）根本没有 vless 连接器，REALITY 也没有 —— 那是 Xray / sing-box 的东西，往 gost 里
 * 移植一份等于自己维护一个 REALITY 客户端。面板给落地入站本来就装着 sing-box 1.14.0（server/singboxRuntimePlan.ts），
 * 它的 vless 出站支持 REALITY + Vision，于是入口机上再起一个 sing-box，只听 127.0.0.1、只做「socks 进、vless 出」，
 * gost 把它当成链上的一个 socks5 节点。监听、计数、限速都还在 gost 那一侧，和 Shadowsocks 出口完全一样。
 *
 * 这个 sing-box 是单独的服务（forwardx-singbox-egress，配置 /etc/forwardx/singbox/egress.json），不和落地入站的
 * forwardx-singbox 合在一份配置里：规则一改桥接配置就要重启 sing-box，合在一起的话这台机器上开着的落地节点
 * 每次都跟着断线；而落地入站的配置校验不过时，也不该把这台机器上所有规则的出口一起拖下水。
 *
 * 只收「能原样表示」的那一种：RAW/TCP 传输 + REALITY + xtls-rprx-vision。别的组合（ws / grpc / xhttp 传输、
 * 普通 TLS、不带 Vision、spiderX、后量子校验 pqv……）sing-box 的出站要么没有对应字段、要么行为不一样，
 * 静默丢掉只会换来一个「显示在走出口、其实连不上」的规则，所以解析时直接拒绝并说清是哪一项。
 *
 * 只转 TCP：gost 的 socks5 连接器转 UDP 时默认走它自己的 UDP-over-TCP 扩展，sing-box 的 socks 入站不认；
 * 标准 UDP ASSOCIATE 这条路也没拿真二进制验过。没验过的组合不发，规则协议必须是 TCP（见 ruleEgressShapeError）。
 *
 * 这里只放纯函数和常量（客户端也 import，不能碰 node:crypto / Buffer）；凭据加密、查库在 server/vlessEgress.ts。
 */

import { isAgentVersionAtLeast } from "./version";

/**
 * Agent 从这一版起认得 VLESS 出口的桥接配置：写入 /etc/forwardx/singbox/egress.json 前逐项校验
 * （只许听回环地址、只许 vless + REALITY 出站、没有直连出站 —— 见 agent/singbox_egress_bridge.go）。
 * 比它旧的 Agent 上，带 VLESS 出口的规则按停用下发，卡片显示「需要升级 Agent」。
 */
export const VLESS_EGRESS_AGENT_VERSION = "2.2.253";

/** 唯一收的流控。 */
export const VLESS_EGRESS_FLOW = "xtls-rprx-vision";

/** sing-box 1.14 的 uTLS 和 Xray 都认得的指纹；链接里不带 fp 时按 chrome（和面板派生的 REALITY 节点一致）。 */
export const VLESS_EGRESS_FINGERPRINTS = ["chrome", "firefox", "safari", "edge", "ios", "android", "360", "qq", "random", "randomized"] as const;
export const VLESS_EGRESS_DEFAULT_FINGERPRINT = "chrome";

export type VlessEgressEndpoint = {
  server: string;
  port: number;
  uuid: string;
  /** REALITY 握手时的 SNI（要偷的那个域名）。 */
  serverName: string;
  /** REALITY 公钥：x25519，base64url 不带补齐，43 个字符。 */
  publicKey: string;
  /** 0~8 字节的十六进制；空串表示服务端不校验 short-id。 */
  shortId: string;
  fingerprint: string;
  /** 链接里带的名字，只用来显示。 */
  name?: string;
};

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHORT_ID_PATTERN = /^(?:[0-9a-f]{2}){0,8}$/i;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeServer(value: unknown) {
  return text(value).replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
}

function isPlausibleServer(server: string) {
  if (!server) return false;
  if (server.includes(":")) return /^[0-9a-f:.]+$/i.test(server);
  return HOSTNAME_PATTERN.test(server);
}

/**
 * 公钥规整成 sing-box 认的样子（base64url、不带补齐）。标准 base64 的 +/ 一一对应 -_，换过去不丢信息；
 * 解出来不是 32 字节（或者最后一个字符带了多余的位）就不是 x25519 公钥。认不出来回空串。
 */
export function canonicalRealityPublicKey(value: unknown): string {
  const key = text(value).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (!PUBLIC_KEY_PATTERN.test(key)) return "";
  // 43 个字符 = 258 位，最后一个字符只有高 4 位有用：低 2 位不是 0 说明不是一份规范编码的 32 字节。
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  if (alphabet.indexOf(key[42]) % 4 !== 0) return "";
  return key;
}

/** 这一份出口配置合不合格。合格回 null，否则回给人看的原因。 */
export function vlessEgressEndpointError(endpoint: Partial<VlessEgressEndpoint> | null | undefined): string | null {
  if (!endpoint) return "缺少出口配置";
  const server = normalizeServer(endpoint.server);
  if (!isPlausibleServer(server)) return "出口服务器地址无效";
  if (server === "localhost" || server.startsWith("127.") || server === "::1" || server === "0.0.0.0" || server === "::") {
    return "出口服务器不能是本机地址";
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "出口服务器端口必须在 1-65535 之间";
  if (!UUID_PATTERN.test(text(endpoint.uuid))) return "VLESS 的 UUID 格式不对（sing-box 不认 Xray 那种任意字符串 ID，要标准的 UUID）";
  const serverName = text(endpoint.serverName).toLowerCase();
  if (!serverName || !HOSTNAME_PATTERN.test(serverName) || /^[0-9.]+$/.test(serverName)) return "REALITY 需要一个握手域名（sni），不能是 IP";
  if (!canonicalRealityPublicKey(endpoint.publicKey)) return "REALITY 公钥（pbk）不对：要 43 个字符的 base64url（32 字节 x25519 公钥）";
  if (!SHORT_ID_PATTERN.test(text(endpoint.shortId))) return "REALITY 的 short-id（sid）只能是 0~8 字节的十六进制（最多 16 个字符、长度为偶数）";
  const fingerprint = text(endpoint.fingerprint).toLowerCase();
  if (fingerprint && !(VLESS_EGRESS_FINGERPRINTS as readonly string[]).includes(fingerprint)) {
    return `不支持的 uTLS 指纹「${fingerprint.slice(0, 24)}」，只能是 ${VLESS_EGRESS_FINGERPRINTS.join(" / ")}`;
  }
  return null;
}

export type ParseVlessEgressLinkResult =
  | { ok: true; endpoint: VlessEgressEndpoint }
  | { ok: false; error: string };

/**
 * 链接里认得的参数，以及它们能取的值。不在这张表里的参数一律拒绝：认不出来就没法保证 sing-box 那一侧
 * 照原样连过去。空值的 host / path / serviceName / mode 是很多客户端导出 RAW 链接时顺手带上的，放行。
 */
const ALLOWED_PARAMS = new Set([
  "type", "security", "encryption", "flow", "sni", "fp", "pbk", "sid", "spx",
  "headertype", "host", "path", "servicename", "mode", "alpn", "allowinsecure", "insecure", "remarks",
]);

function decodeComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * 严格解析外部 vless:// 链接：只收 RAW/TCP + REALITY + xtls-rprx-vision。
 * 不复用 shared/proxyNode 的宽松解析：那边是「尽量导进来」，这边是「出口照原样连不上就别存」。
 */
export function parseVlessEgressLink(input: unknown): ParseVlessEgressLinkResult {
  const link = text(input);
  if (!link) return { ok: false, error: "请粘贴 vless:// 链接" };
  if (link.length > 4096) return { ok: false, error: "链接太长" };
  if (!/^vless:\/\//i.test(link)) return { ok: false, error: "只支持 vless:// 开头的 VLESS 链接" };
  let rest = link.slice("vless://".length);
  let name = "";
  const hashIndex = rest.indexOf("#");
  if (hashIndex >= 0) {
    name = (decodeComponent(rest.slice(hashIndex + 1)) ?? "").trim().slice(0, 64);
    rest = rest.slice(0, hashIndex);
  }
  const queryIndex = rest.indexOf("?");
  const authority = (queryIndex >= 0 ? rest.slice(0, queryIndex) : rest).replace(/\/$/, "");
  const queryText = queryIndex >= 0 ? rest.slice(queryIndex + 1) : "";
  const at = authority.lastIndexOf("@");
  if (at <= 0) return { ok: false, error: "链接里没有 UUID@地址:端口（整段 base64 的 Shadowrocket 写法不支持，请导出标准的 vless:// 链接）" };
  if (authority.includes("/")) return { ok: false, error: "链接里带了路径，RAW/TCP 的 VLESS 链接不应该有路径" };
  const uuid = (decodeComponent(authority.slice(0, at)) ?? "").trim().toLowerCase();
  const hostPort = authority.slice(at + 1);
  let server = "";
  let portText = "";
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0 || hostPort[close + 1] !== ":") return { ok: false, error: "服务器地址或端口不对" };
    server = hostPort.slice(1, close);
    portText = hostPort.slice(close + 2);
  } else {
    const colon = hostPort.lastIndexOf(":");
    if (colon <= 0) return { ok: false, error: "链接里缺少端口" };
    server = hostPort.slice(0, colon);
    portText = hostPort.slice(colon + 1);
  }
  if (!/^\d{1,5}$/.test(portText)) return { ok: false, error: "端口不对" };

  const params = new Map<string, string>();
  for (const part of queryText.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawKey = eq >= 0 ? part.slice(0, eq) : part;
    const rawValue = eq >= 0 ? part.slice(eq + 1) : "";
    const key = (decodeComponent(rawKey.replace(/\+/g, " ")) ?? "").trim().toLowerCase();
    const value = decodeComponent(rawValue.replace(/\+/g, "%2B")) ?? null;
    if (value === null) return { ok: false, error: `参数 ${key || rawKey} 的值解码失败` };
    if (!ALLOWED_PARAMS.has(key)) {
      if (key === "pqv") return { ok: false, error: "链接带了 REALITY 后量子校验（pqv），sing-box 的出站没有这一项，连不过去" };
      if (key === "extra") return { ok: false, error: "链接带了 XHTTP 的 extra 参数，只支持 RAW/TCP 传输" };
      return { ok: false, error: `不认识的参数「${key.slice(0, 24)}」，没法确认出口能照原样连过去` };
    }
    if (params.has(key)) return { ok: false, error: `参数 ${key} 出现了两次` };
    params.set(key, value.trim());
  }

  const transport = (params.get("type") || "tcp").toLowerCase();
  if (transport !== "tcp" && transport !== "raw") {
    return { ok: false, error: `只支持 RAW/TCP 传输，这条是 ${transport}（ws / grpc / xhttp / httpupgrade 这些不支持做出口）` };
  }
  const headerType = (params.get("headertype") || "none").toLowerCase();
  if (headerType !== "none") return { ok: false, error: `不支持 TCP 的 ${headerType} 伪装头` };
  for (const key of ["host", "path", "servicename", "mode"]) {
    const value = params.get(key) || "";
    if (value && !(key === "path" && value === "/")) return { ok: false, error: `RAW/TCP 链接不应该带 ${key}=${value.slice(0, 24)}（这像是别的传输的参数）` };
  }
  const security = (params.get("security") || "").toLowerCase();
  if (security !== "reality") {
    return { ok: false, error: security ? `只支持 REALITY，这条是 ${security}` : "链接没写 security=reality：只支持 VLESS + REALITY" };
  }
  const encryption = (params.get("encryption") || "none").toLowerCase();
  if (encryption !== "none") return { ok: false, error: `不支持 VLESS 的 encryption=${encryption}（只认 none）` };
  const flow = (params.get("flow") || "").toLowerCase();
  if (flow !== VLESS_EGRESS_FLOW) {
    return { ok: false, error: flow ? `只支持 ${VLESS_EGRESS_FLOW} 流控，这条是 ${flow}` : `链接没带 flow=${VLESS_EGRESS_FLOW}：只支持 REALITY + Vision` };
  }
  const spiderX = params.get("spx") || "";
  if (spiderX && spiderX !== "/") return { ok: false, error: "链接带了 spiderX（spx），sing-box 的出站没有这一项；只能是 / 或者不带" };
  const insecure = (params.get("allowinsecure") || params.get("insecure") || "").toLowerCase();
  if (insecure && insecure !== "0" && insecure !== "false") return { ok: false, error: "REALITY 链接不应该带 allowInsecure=1" };
  const alpn = params.get("alpn") || "";
  if (alpn) return { ok: false, error: "REALITY + Vision 的链接不应该指定 alpn，出口照原样表示不了" };

  const endpoint: VlessEgressEndpoint = {
    server: normalizeServer(server),
    port: Number(portText),
    uuid,
    serverName: (params.get("sni") || "").toLowerCase(),
    publicKey: canonicalRealityPublicKey(params.get("pbk")),
    shortId: (params.get("sid") || "").toLowerCase(),
    fingerprint: (params.get("fp") || VLESS_EGRESS_DEFAULT_FINGERPRINT).toLowerCase(),
    ...(name || params.get("remarks") ? { name: (name || params.get("remarks") || "").slice(0, 64) } : {}),
  };
  if (!params.get("pbk")) return { ok: false, error: "链接没带 REALITY 公钥（pbk）" };
  const error = vlessEgressEndpointError(endpoint);
  if (error) return { ok: false, error };
  return { ok: true, endpoint };
}

/** 给界面看的样子：UUID 永远不出现。 */
export function maskVlessEgressEndpoint(endpoint: Pick<VlessEgressEndpoint, "server" | "port" | "serverName"> | null | undefined): string {
  if (!endpoint) return "";
  const server = normalizeServer(endpoint.server);
  const host = server.includes(":") ? `[${server}]` : server;
  return `vless://******@${host}:${Number(endpoint.port) || 0}?security=reality&sni=${text(endpoint.serverName)}`;
}

/**
 * 面板里的落地入站能不能做 VLESS 出口。能回 null，否则回给人看的原因。
 * 收的和外部链接同一种：VLESS + RAW/TCP + REALITY + Vision，并且有公钥（老行没存公钥的要换一次密钥）。
 */
export function vlessEgressInboundError(inbound: {
  protocol?: unknown;
  transport?: unknown;
  security?: unknown;
  flow?: unknown;
  realityPublicKey?: unknown;
  serverName?: unknown;
} | null | undefined): string | null {
  if (!inbound) return "落地入站不存在";
  if (text(inbound.protocol) !== "vless") return "不是 VLESS 入站";
  if ((text(inbound.transport) || "tcp") !== "tcp") return `传输是 ${text(inbound.transport)}，VLESS 出口只支持 RAW/TCP`;
  if (text(inbound.security) !== "reality") return "安全层不是 REALITY，VLESS 出口只支持 REALITY";
  if (text(inbound.flow) !== VLESS_EGRESS_FLOW) return `没开 ${VLESS_EGRESS_FLOW} 流控，VLESS 出口只支持 REALITY + Vision`;
  if (!canonicalRealityPublicKey(inbound.realityPublicKey)) return "这个入站没有可用的 REALITY 公钥，请在入站里换一次密钥";
  if (!text(inbound.serverName)) return "这个入站没有握手域名";
  return null;
}

export function isVlessEgressAgentSupported(version: string | null | undefined) {
  return isAgentVersionAtLeast(version, VLESS_EGRESS_AGENT_VERSION);
}

export function vlessEgressAgentUpgradeMessage(hostName?: unknown) {
  const name = text(hostName);
  return `${name ? `主机「${name}」` : "入口主机"}的 Agent 需要升级到 ${VLESS_EGRESS_AGENT_VERSION} 或更新版本才能使用 VLESS Reality 出口`;
}

export const VLESS_EGRESS_TCP_ONLY_MESSAGE = "VLESS Reality 出口只转发 TCP，请把协议改成 TCP";
export const VLESS_EGRESS_TUNNEL_MESSAGE = "走隧道的规则暂时只能接 Shadowsocks 出口，VLESS Reality 出口只支持直连规则和端口转发资源";
