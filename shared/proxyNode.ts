/**
 * 客户端节点模型。
 *
 * 端口转发规则本身只存 host:port，不含任何节点凭据（UUID、密码、加密方式、
 * TLS 参数都没有），因为 NEX 是四层转发器，并不知道目标端口后面跑的是
 * 什么协议。所以订阅功能要求用户把落地机的原始节点链接粘贴一次，这里把它
 * 解析成统一模型，之后由 proxySubscription.ts 渲染成各家客户端的格式。
 *
 * 注意与「套餐订阅」（subscription_plans / user_subscriptions）区分：那是计费
 * 概念，本文件全部是代理节点概念，命名一律用 proxy 前缀。
 */

// 循环引用：proxyNodeJson 也从这里取 createEmptyProxyNode 和类型。两边的使用都在
// 函数体内（延迟求值），运行时安全 —— proxyNode.test.ts 里有端到端用例实际验证这一点。
import { looksLikeProxyNodeJson, parseProxyNodeJson } from "./proxyNodeJson";

export const PROXY_NODE_PROTOCOLS = [
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "hysteria2",
  "tuic",
  "anytls",
  "snell",
] as const;

export type ProxyNodeProtocol = (typeof PROXY_NODE_PROTOCOLS)[number];

export const PROXY_NODE_PROTOCOL_LABELS: Record<ProxyNodeProtocol, string> = {
  vless: "VLESS",
  vmess: "VMess",
  trojan: "Trojan",
  shadowsocks: "Shadowsocks",
  hysteria2: "Hysteria2",
  tuic: "TUIC v5",
  anytls: "AnyTLS",
  snell: "Snell",
};

/**
 * 跑在 QUIC 上的协议，也就是只走 UDP 的那几个。
 *
 * NEX 的转发规则可以只放行 TCP。把这类节点绑到一条 TCP-only 的转发上，
 * 客户端能导入、能识别协议，握手时却永远收不到回包 —— 报出来只是一句超时，
 * 跟「转发没放 UDP」毫无字面关联。所以要在绑定时就拦住。
 */
export const PROXY_NODE_QUIC_PROTOCOLS: readonly ProxyNodeProtocol[] = ["hysteria2", "tuic"];

export function proxyNodeRequiresUdp(protocol: unknown): boolean {
  return PROXY_NODE_QUIC_PROTOCOLS.includes(String(protocol ?? "") as ProxyNodeProtocol);
}

/**
 * 这几个协议自带 TLS（Hysteria2 / TUIC 是 QUIC-TLS，AnyTLS 顾名思义），
 * 链接里不会写 security=tls，解析和渲染时都按「一定有 TLS」处理。
 */
export const PROXY_NODE_ALWAYS_TLS_PROTOCOLS: readonly ProxyNodeProtocol[] = [
  "trojan",
  "hysteria2",
  "tuic",
  "anytls",
];

export function proxyNodeAlwaysTls(protocol: unknown): boolean {
  return PROXY_NODE_ALWAYS_TLS_PROTOCOLS.includes(String(protocol ?? "") as ProxyNodeProtocol);
}

export const PROXY_NODE_TRANSPORTS = ["tcp", "ws", "grpc", "http", "httpupgrade", "xhttp"] as const;

export type ProxyNodeTransport = (typeof PROXY_NODE_TRANSPORTS)[number];

export type ProxyNode = {
  protocol: ProxyNodeProtocol;
  name: string;
  address: string;
  port: number;
  /** vless / vmess 的用户 ID */
  uuid: string;
  /** trojan / shadowsocks 的密码 */
  password: string;
  /** shadowsocks 的加密方式，或 vmess 的 security */
  method: string;
  /** vmess 的 alterId，现代节点一律为 0 */
  alterId: number;
  /** vless 的流控，例如 xtls-rprx-vision */
  flow: string;
  transport: ProxyNodeTransport;
  /** ws / http 的路径，grpc 时存 serviceName */
  path: string;
  /** ws / http 的 Host 头 */
  host: string;
  tls: boolean;
  sni: string;
  alpn: string[];
  fingerprint: string;
  allowInsecure: boolean;
  /** Reality 公钥，非空表示该节点用 Reality 而非普通 TLS */
  realityPublicKey: string;
  realityShortId: string;
  udp: boolean;
  /** Hysteria2 的混淆方式：salamander 或 gecko，空表示不混淆 */
  obfs: string;
  /** Hysteria2 的混淆密码 */
  obfsPassword: string;
  /**
   * Hysteria2 客户端向服务端声明的带宽（Mbps），0 表示不声明。
   *
   * 填了之后 Hysteria2 走 Brutal 拥塞控制：按这个速率发包，不把跨境线路的丢包当
   * 拥塞，单条连接也能跑到声明的速率 —— 这正是 BBR / cubic 在高丢包线路上做不到
   * 的。不填就退回 BBR。服务端若也配了上限，实际取两者较小值。
   */
  upMbps: number;
  downMbps: number;
  /** TUIC 的拥塞控制：cubic / new_reno / bbr */
  congestionControl: string;
  /** TUIC 的 UDP 转发模式：native 或 quic */
  udpRelayMode: string;
  /** TUIC 的握手不带 SNI */
  disableSni: boolean;
  /**
   * Snell 的版本号（1-6）。0 表示不是 Snell 节点。
   *
   * 各家支持的区间不一样：Surge 全都有，mihomo 到 v5 为止，sing-box 只有 v4 与 v6
   * （v4/v5 线格式一致，可以按 v4 发）。版本对不上不是「参数少一个」而是握手完全
   * 不兼容，所以渲染时按版本逐家判断能不能出。
   */
  snellVersion: number;
  /** Snell v6 的流量整形：default / unshaped / unsafe-raw */
  snellMode: string;
  /** XHTTP 的模式：auto / stream-one / stream-up / packet-up */
  xhttpMode: string;
  /**
   * 前置代理：这个节点的连接要先经由哪个节点建立（按名称引用）。
   *
   * 只有 Clash（dialer-proxy）、sing-box（detour）、Surge（underlying-proxy）能表达；
   * Loon 与 Quantumult X 的订阅格式没有这个位置，那边只能在客户端里手连一次。
   */
  frontProxyName?: string;
};

export function createEmptyProxyNode(): ProxyNode {
  return {
    protocol: "vless",
    name: "",
    address: "",
    port: 0,
    uuid: "",
    password: "",
    method: "",
    alterId: 0,
    flow: "",
    transport: "tcp",
    path: "",
    host: "",
    tls: false,
    sni: "",
    alpn: [],
    fingerprint: "",
    allowInsecure: false,
    realityPublicKey: "",
    realityShortId: "",
    udp: true,
    obfs: "",
    obfsPassword: "",
    upMbps: 0,
    downMbps: 0,
    congestionControl: "",
    udpRelayMode: "",
    disableSni: false,
    snellVersion: 0,
    snellMode: "",
    xhttpMode: "",
  };
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function toPort(value: unknown): number {
  const port = Number(text(value));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function normalizeTransport(value: unknown): ProxyNodeTransport {
  const raw = text(value).toLowerCase();
  // v2ray 的 net=h2 与 type=http 是同一种传输，统一收敛成 http。
  if (raw === "h2" || raw === "http") return "http";
  if (raw === "ws" || raw === "websocket") return "ws";
  if (raw === "grpc") return "grpc";
  // HTTPUpgrade 比 ws 少一次握手往返。v2rayN 写 httpupgrade，也见过 httpu 的简写。
  if (raw === "httpupgrade" || raw === "httpu") return "httpupgrade";
  // XHTTP 是 Xray 用来取代 H2 的新传输，只有 VLESS 用得上。
  if (raw === "xhttp" || raw === "splithttp") return "xhttp";
  return "tcp";
}

function splitAlpn(value: unknown): string[] {
  return text(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTruthyFlag(value: unknown): boolean {
  const raw = text(value).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** UTF-8 安全的 base64 解码，容忍 URL-safe 变体和缺失的补位。 */
export function decodeBase64Utf8(input: string): string {
  let normalized = text(input).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (!normalized) return "";
  const remainder = normalized.length % 4;
  if (remainder === 2) normalized += "==";
  else if (remainder === 3) normalized += "=";
  else if (remainder === 1) return "";
  let binary = "";
  try {
    binary = atob(normalized);
  } catch {
    return "";
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

/** UTF-8 安全的 base64 编码；节点名常含中文，不能直接 btoa。 */
export function encodeBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(String(input ?? ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function stripScheme(link: string, scheme: string): string {
  return link.slice(scheme.length);
}

function parseFragmentName(fragment: string): string {
  if (!fragment) return "";
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

type SplitLink = {
  body: string;
  query: URLSearchParams;
  name: string;
};

/** 把 `凭据@地址:端口?查询#名称` 拆开。不用 URL 是因为部分链接的凭据段不是合法 userinfo。 */
function splitLink(rest: string): SplitLink {
  let working = rest;
  let name = "";
  const hashIndex = working.indexOf("#");
  if (hashIndex >= 0) {
    name = parseFragmentName(working.slice(hashIndex + 1));
    working = working.slice(0, hashIndex);
  }
  let query = new URLSearchParams();
  const queryIndex = working.indexOf("?");
  if (queryIndex >= 0) {
    query = new URLSearchParams(working.slice(queryIndex + 1));
    working = working.slice(0, queryIndex);
  }
  return { body: working, query, name };
}

type HostPort = { address: string; port: number };

/** 从 `地址:端口` 取出两段，兼容 `[v6]:端口` 字面量。 */
function splitHostPort(value: string): HostPort {
  const raw = text(value).replace(/\/+$/, "");
  if (!raw) return { address: "", port: 0 };
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) return { address: "", port: 0 };
    const address = raw.slice(1, close);
    const remainder = raw.slice(close + 1);
    return { address, port: remainder.startsWith(":") ? toPort(remainder.slice(1)) : 0 };
  }
  const colon = raw.lastIndexOf(":");
  if (colon < 0) return { address: raw, port: 0 };
  return { address: raw.slice(0, colon), port: toPort(raw.slice(colon + 1)) };
}

function applyTlsQuery(node: ProxyNode, query: URLSearchParams) {
  const security = text(query.get("security")).toLowerCase();
  const publicKey = text(query.get("pbk"));
  // Shadowrocket 那套链接不写 security，而是 tls=1；Reality 靠 pbk 存在与否判断。
  // 少认一种写法的后果是整条链接解析失败，用户只会看到「格式无法识别」。
  node.tls = security === "tls" || security === "reality" || security === "xtls"
    || isTruthyFlag(query.get("tls"));
  node.sni = text(query.get("sni")) || text(query.get("peer"));
  node.alpn = splitAlpn(query.get("alpn"));
  node.fingerprint = text(query.get("fp"));
  node.allowInsecure = isTruthyFlag(query.get("allowInsecure")) || isTruthyFlag(query.get("insecure"));
  if (security === "reality" || publicKey) {
    node.tls = true;
    node.realityPublicKey = publicKey;
    node.realityShortId = text(query.get("sid"));
  }
}

function applyTransportQuery(node: ProxyNode, query: URLSearchParams) {
  node.transport = normalizeTransport(query.get("type") || query.get("net"));
  if (node.transport === "grpc") {
    node.path = text(query.get("serviceName")) || text(query.get("path"));
  } else {
    node.path = text(query.get("path"));
  }
  node.host = text(query.get("host"));
  // XHTTP 的 mode 决定上下行怎么拆包，两端不一致会连不上，属于必须带的参数。
  if (node.transport === "xhttp") node.xhttpMode = text(query.get("mode"));
}

function parseVlessLink(link: string): ProxyNode | null {
  const { body, query, name } = splitLink(stripScheme(link, "vless://"));

  /**
   * 两种写法都要认：
   *   标准       vless://uuid@host:port?security=reality&pbk=...
   *   Shadowrocket vless://base64(method:uuid@host:port)?tls=1&peer=...&pbk=...
   * 后者整段是 base64，里面还多一个 method 前缀（vless 用不上，丢掉）。
   */
  let payload = body;
  if (!payload.includes("@")) {
    const decoded = decodeBase64Utf8(payload);
    if (!decoded.includes("@")) return null;
    payload = decoded;
  }

  const at = payload.lastIndexOf("@");
  if (at < 0) return null;
  let credential = text(decodeURIComponent(payload.slice(0, at)));
  // base64 形式里是 method:uuid，vless 没有加密方式这一说，取冒号后面的。
  const colon = credential.lastIndexOf(":");
  if (colon > 0) credential = credential.slice(colon + 1);
  const uuid = credential;
  const { address, port } = splitHostPort(payload.slice(at + 1));
  if (!uuid || !address || !port) return null;
  const node = createEmptyProxyNode();
  node.protocol = "vless";
  // Shadowrocket 把名字放在 remarks 参数里，不是 # 后面。
  node.name = name || text(query.get("remarks"));
  node.address = address;
  node.port = port;
  node.uuid = uuid;
  // xtls=N 是 Shadowrocket 的写法。现役 Xray 只剩 vision 一种流控，
  // direct / splice 早已移除，所以有 xtls 就按 vision 算。
  // xtls 是 Shadowrocket 的写法，取值是数字（见过 1 和 2），不是布尔，
  // 所以不能用 isTruthyFlag —— 那样 xtls=2 会被当成假。非 0 即启用。
  const xtls = text(query.get("xtls"));
  node.flow = text(query.get("flow"))
    || (xtls && xtls !== "0" ? "xtls-rprx-vision" : "");
  applyTransportQuery(node, query);
  applyTlsQuery(node, query);
  return node;
}

function parseTrojanLink(link: string): ProxyNode | null {
  const { body, query, name } = splitLink(stripScheme(link, "trojan://"));
  const at = body.lastIndexOf("@");
  if (at < 0) return null;
  const password = text(decodeURIComponent(body.slice(0, at)));
  const { address, port } = splitHostPort(body.slice(at + 1));
  if (!password || !address || !port) return null;
  const node = createEmptyProxyNode();
  node.protocol = "trojan";
  node.name = name;
  node.address = address;
  node.port = port;
  node.password = password;
  applyTransportQuery(node, query);
  applyTlsQuery(node, query);
  // Trojan 本身就跑在 TLS 上，链接里通常不写 security=tls。
  if (!text(query.get("security"))) node.tls = true;
  return node;
}

/** vmess:// 的主流形态是 base64(JSON)，字段名沿用 v2rayN 的定义。 */
function parseVmessLink(link: string): ProxyNode | null {
  const decoded = decodeBase64Utf8(stripScheme(link, "vmess://"));
  if (!decoded) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
  const address = text(raw.add);
  const port = toPort(raw.port);
  const uuid = text(raw.id);
  if (!address || !port || !uuid) return null;
  const node = createEmptyProxyNode();
  node.protocol = "vmess";
  node.name = text(raw.ps);
  node.address = address;
  node.port = port;
  node.uuid = uuid;
  node.alterId = Number(text(raw.aid)) || 0;
  node.method = text(raw.scy) || "auto";
  node.transport = normalizeTransport(raw.net);
  node.path = node.transport === "grpc" ? text(raw.path) : text(raw.path);
  node.host = text(raw.host);
  const tls = text(raw.tls).toLowerCase();
  node.tls = tls === "tls" || tls === "reality";
  node.sni = text(raw.sni);
  node.alpn = splitAlpn(raw.alpn);
  node.fingerprint = text(raw.fp);
  return node;
}

/**
 * ss:// 有两种历史形态：
 *   SIP002  ss://base64url(method:password)@host:port#name
 *   旧版     ss://base64(method:password@host:port)#name
 */
function parseShadowsocksLink(link: string): ProxyNode | null {
  const { body, query, name } = splitLink(stripScheme(link, "ss://"));
  const node = createEmptyProxyNode();
  node.protocol = "shadowsocks";
  node.name = name;

  const at = body.lastIndexOf("@");
  if (at >= 0) {
    const credential = body.slice(0, at);
    const decoded = decodeBase64Utf8(credential) || text(decodeURIComponent(credential));
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    node.method = decoded.slice(0, separator).trim();
    node.password = decoded.slice(separator + 1).trim();
    const { address, port } = splitHostPort(body.slice(at + 1));
    node.address = address;
    node.port = port;
  } else {
    const decoded = decodeBase64Utf8(body);
    const innerAt = decoded.lastIndexOf("@");
    if (innerAt < 0) return null;
    const credential = decoded.slice(0, innerAt);
    const separator = credential.indexOf(":");
    if (separator < 0) return null;
    node.method = credential.slice(0, separator).trim();
    node.password = credential.slice(separator + 1).trim();
    const { address, port } = splitHostPort(decoded.slice(innerAt + 1));
    node.address = address;
    node.port = port;
  }

  if (!node.method || !node.password || !node.address || !node.port) return null;
  // v2rayN 会把 ss 的传输参数放在查询串里，保留下来以免中转后丢配置。
  if (query.has("type")) applyTransportQuery(node, query);
  return node;
}

/**
 * hysteria2:// 与 hy2:// 是同一种，见 Hysteria 2 官方的 URI Scheme。
 *
 *   hysteria2://[auth@]hostname[:port]/?obfs=&obfs-password=&sni=&insecure=#name
 *
 * 端口可以省，省略时按官方默认的 443 算；auth 整段就是密码（部分面板会发
 * `用户:密码` 的形式，那也是一整个字符串，不能在冒号处劈开）。
 */
function parseHysteria2Link(link: string, scheme: string): ProxyNode | null {
  const { body, query, name } = splitLink(stripScheme(link, scheme));
  const at = body.lastIndexOf("@");
  // 没有 auth 段的链接是合法的（服务端可以不校验），此时整段都是地址。
  const password = at >= 0 ? text(decodeURIComponent(body.slice(0, at))) : "";
  const { address, port } = splitHostPort(at >= 0 ? body.slice(at + 1) : body);
  if (!address) return null;

  const node = createEmptyProxyNode();
  node.protocol = "hysteria2";
  node.name = name;
  node.address = address;
  node.port = port || 443;
  node.password = password;
  node.tls = true;
  node.sni = text(query.get("sni"));
  node.alpn = splitAlpn(query.get("alpn"));
  node.allowInsecure = isTruthyFlag(query.get("insecure")) || isTruthyFlag(query.get("allowInsecure"));
  node.obfs = text(query.get("obfs")).toLowerCase();
  node.obfsPassword = text(query.get("obfs-password")) || text(query.get("obfsPassword"));
  return node;
}

/**
 * tuic:// 是 TUIC v5 的分享链接：
 *
 *   tuic://uuid:password@host:port?congestion_control=&udp_relay_mode=&alpn=&sni=&allow_insecure=&disable_sni=#name
 *
 * v4 用的是单一 token，这里不认 —— v4 与 v5 的握手不兼容，猜错版本生成的
 * 节点连不上，而客户端只会报超时。
 */
function parseTuicLink(link: string): ProxyNode | null {
  const { body, query, name } = splitLink(stripScheme(link, "tuic://"));
  const at = body.lastIndexOf("@");
  if (at < 0) return null;
  const credential = text(decodeURIComponent(body.slice(0, at)));
  const colon = credential.indexOf(":");
  if (colon < 0) return null;
  const uuid = credential.slice(0, colon).trim();
  const password = credential.slice(colon + 1).trim();
  const { address, port } = splitHostPort(body.slice(at + 1));
  if (!uuid || !address || !port) return null;

  const node = createEmptyProxyNode();
  node.protocol = "tuic";
  node.name = name;
  node.address = address;
  node.port = port;
  node.uuid = uuid;
  node.password = password;
  node.tls = true;
  node.sni = text(query.get("sni"));
  // TUIC 跑在 QUIC 上，ALPN 不写时各家默认值不一致，缺省补 h3 免得两端对不上。
  node.alpn = splitAlpn(query.get("alpn"));
  if (!node.alpn.length) node.alpn = ["h3"];
  node.allowInsecure = isTruthyFlag(query.get("allow_insecure")) || isTruthyFlag(query.get("insecure"));
  node.disableSni = isTruthyFlag(query.get("disable_sni"));
  node.congestionControl = text(query.get("congestion_control")) || text(query.get("congestion_controller"));
  node.udpRelayMode = text(query.get("udp_relay_mode"));
  return node;
}

/**
 * anytls:// 见 anytls-go 的 URI Scheme：
 *
 *   anytls://password@hostname[:port]/?sni=&insecure=
 *
 * 端口省略时按官方文档的默认 443。AnyTLS 跑在 TCP 上，不是 QUIC。
 */
function parseAnytlsLink(link: string): ProxyNode | null {
  const { body, query, name } = splitLink(stripScheme(link, "anytls://"));
  const at = body.lastIndexOf("@");
  if (at < 0) return null;
  const password = text(decodeURIComponent(body.slice(0, at)));
  const { address, port } = splitHostPort(body.slice(at + 1));
  if (!password || !address) return null;

  const node = createEmptyProxyNode();
  node.protocol = "anytls";
  node.name = name;
  node.address = address;
  node.port = port || 443;
  node.password = password;
  node.tls = true;
  node.sni = text(query.get("sni"));
  node.alpn = splitAlpn(query.get("alpn"));
  node.allowInsecure = isTruthyFlag(query.get("insecure")) || isTruthyFlag(query.get("allowInsecure"));
  node.fingerprint = text(query.get("fp"));
  return node;
}

/**
 * Snell 没有分享链接 —— 它是 Surge 自家的协议，社区里也没有形成 snell:// 的事实
 * 标准（Sub-Store 同样只从 Clash 条目和 Surge 配置里读）。用户手上最可能有的就是
 * 一行 Surge 节点配置，所以这里认那一行；Clash 条目与 sing-box 出站走 JSON 那条路。
 *
 *   名字 = snell, 1.2.3.4, 8000, psk=xxx, version=4, obfs=http, obfs-host=bing.com
 *   名字 = snell, 1.2.3.4, 8000, psk="xxx", version=6, mode=default
 */
function looksLikeSurgeSnellLine(input: string): boolean {
  const eq = input.indexOf("=");
  if (eq < 0) return false;
  return text(input.slice(eq + 1)).split(",")[0]?.trim().toLowerCase() === "snell";
}

function parseSurgeSnellLine(input: string): ProxyNode | null {
  const eq = input.indexOf("=");
  if (eq < 0) return null;
  const name = text(input.slice(0, eq));
  const parts = input.slice(eq + 1).split(",").map((item) => item.trim()).filter(Boolean);
  // 前三段固定是 snell、地址、端口，之后一律是 键=值。
  if (parts.length < 3) return null;
  const address = text(parts[1]);
  const port = toPort(parts[2]);
  if (!address || !port) return null;

  const options = new Map<string, string>();
  for (const part of parts.slice(3)) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    // Surge 的 psk 惯例带引号。
    options.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim().replace(/^"|"$/g, ""));
  }

  const psk = text(options.get("psk"));
  if (!psk) return null;

  const node = createEmptyProxyNode();
  node.protocol = "snell";
  node.name = name;
  node.address = address;
  node.port = port;
  node.password = psk;
  // Surge 手册写的默认版本就是 1；不猜成 4，版本猜错是握手完全不兼容。
  node.snellVersion = Number(text(options.get("version"))) || 1;
  node.obfs = text(options.get("obfs")).toLowerCase();
  node.host = text(options.get("obfs-host"));
  node.snellMode = text(options.get("mode"));
  node.udp = true;
  return node;
}

export type ParseProxyNodeResult =
  | { ok: true; node: ProxyNode }
  | { ok: false; error: string };

/** 解析单条节点链接。失败时返回可直接展示给用户的中文原因。 */
export function parseProxyNodeLink(input: unknown): ParseProxyNodeResult {
  const link = text(input);
  if (!link) return { ok: false, error: "节点链接为空" };

  // 粘的是 JSON（sing-box 出站、Clash 条目、v2rayN 的 VMess、或整份配置）走另一条路。
  if (looksLikeProxyNodeJson(link)) {
    const result = parseProxyNodeJson(link);
    if (!result.ok) return { ok: false, error: result.error };
    if (result.needsAddress) {
      return {
        ok: false,
        error: "这份配置里没有公网地址（服务端配置的 listen 通常是 0.0.0.0），请在「地址」栏补上落地机的地址",
      };
    }
    return { ok: true, node: result.node };
  }

  // Snell 走 Surge 节点行，没有 scheme 可判断，所以先看这一条。
  if (looksLikeSurgeSnellLine(link)) {
    const node = parseSurgeSnellLine(link);
    if (!node) {
      return { ok: false, error: "Snell 节点行格式无法识别，需要形如 `名字 = snell, 地址, 端口, psk=密钥, version=4`" };
    }
    return { ok: true, node };
  }

  const lower = link.toLowerCase();
  let node: ProxyNode | null = null;
  if (lower.startsWith("vless://")) node = parseVlessLink(link);
  else if (lower.startsWith("vmess://")) node = parseVmessLink(link);
  else if (lower.startsWith("trojan://")) node = parseTrojanLink(link);
  else if (lower.startsWith("ss://")) node = parseShadowsocksLink(link);
  else if (lower.startsWith("hysteria2://")) node = parseHysteria2Link(link, "hysteria2://");
  else if (lower.startsWith("hy2://")) node = parseHysteria2Link(link, "hy2://");
  else if (lower.startsWith("tuic://")) node = parseTuicLink(link);
  else if (lower.startsWith("anytls://")) node = parseAnytlsLink(link);
  else {
    return {
      ok: false,
      error: `暂不支持该协议，目前支持 ${PROXY_NODE_PROTOCOLS.map((item) => PROXY_NODE_PROTOCOL_LABELS[item]).join(" / ")}`,
    };
  }
  if (!node) return { ok: false, error: "节点链接格式无法识别，请确认是从落地机原样复制的完整链接" };
  return { ok: true, node };
}

export type ProxyNodeRelayEntry = {
  address: string;
  port: number;
  name: string;
};

/**
 * 把节点改写成经中转入口访问的形态：只替换地址和端口，凭据与 TLS 参数原样保留。
 *
 * 关键细节：TLS 的 SNI 和 ws/http 的 Host 头若原本留空，客户端会退化成用连接
 * 地址填充。中转后连接地址变成入口 IP，握手就会带着 IP 当 SNI 发给落地机而
 * 失败。所以这里在改写地址前，先把原地址固化进 sni / host，避免这种静默失效。
 */
export function relayProxyNode(node: ProxyNode, entry: ProxyNodeRelayEntry): ProxyNode {
  const relayed: ProxyNode = { ...node, alpn: [...node.alpn] };
  if (relayed.tls && !relayed.sni) relayed.sni = node.address;
  /**
   * 中转改写地址之后 Host 头要留着原来的落地域名 —— 不然发出去的是中转 IP，
   * 对端按 Host 路由就找不到人。httpupgrade 和 ws 一样靠 Host 头，同等对待。
   */
  if ((relayed.transport === "ws" || relayed.transport === "http" || relayed.transport === "httpupgrade") && !relayed.host) {
    relayed.host = node.address;
  }
  relayed.address = text(entry.address);
  relayed.port = toPort(entry.port);
  relayed.name = text(entry.name) || node.name;
  return relayed;
}

function appendQuery(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
}

function buildTransportQuery(node: ProxyNode, params: URLSearchParams) {
  params.set("type", node.transport);
  if (node.transport === "grpc") appendQuery(params, "serviceName", node.path);
  else appendQuery(params, "path", node.path);
  if (node.transport !== "tcp") appendQuery(params, "host", node.host);
  if (node.transport === "xhttp") appendQuery(params, "mode", node.xhttpMode);
}

function buildTlsQuery(node: ProxyNode, params: URLSearchParams) {
  if (node.realityPublicKey) {
    params.set("security", "reality");
    appendQuery(params, "pbk", node.realityPublicKey);
    appendQuery(params, "sid", node.realityShortId);
  } else if (node.tls) {
    params.set("security", "tls");
  } else {
    params.set("security", "none");
  }
  appendQuery(params, "sni", node.sni);
  if (node.alpn.length) params.set("alpn", node.alpn.join(","));
  appendQuery(params, "fp", node.fingerprint);
  if (node.allowInsecure) params.set("allowInsecure", "1");
}

function formatHostForUri(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}

/** 把模型还原成节点链接，用于通用 base64 订阅。 */
export function formatProxyNodeLink(node: ProxyNode): string {
  // Snell 没有分享链接。编一个 snell:// 出来只会让客户端报「无法识别」，
  // 所以由调用方（base64 渲染器）在协议清单里跳过，这里给一个明确的空值兜底。
  if (node.protocol === "snell") return "";
  const host = formatHostForUri(node.address);
  const fragment = node.name ? `#${encodeURIComponent(node.name)}` : "";
  if (node.protocol === "vmess") {
    const payload = {
      v: "2",
      ps: node.name,
      add: node.address,
      port: String(node.port),
      id: node.uuid,
      aid: String(node.alterId),
      scy: node.method || "auto",
      net: node.transport,
      type: "none",
      host: node.host,
      path: node.path,
      tls: node.tls ? "tls" : "",
      sni: node.sni,
      alpn: node.alpn.join(","),
      fp: node.fingerprint,
    };
    return `vmess://${encodeBase64Utf8(JSON.stringify(payload))}`;
  }
  if (node.protocol === "hysteria2") {
    const params = new URLSearchParams();
    appendQuery(params, "sni", node.sni);
    if (node.alpn.length) params.set("alpn", node.alpn.join(","));
    appendQuery(params, "obfs", node.obfs);
    appendQuery(params, "obfs-password", node.obfsPassword);
    if (node.allowInsecure) params.set("insecure", "1");
    const query = params.toString();
    // 官方 URI 里主机与查询串之间带一个 /，照写以免个别客户端的解析器挑剔。
    return `hysteria2://${encodeURIComponent(node.password)}@${host}:${node.port}/${query ? `?${query}` : ""}${fragment}`;
  }
  if (node.protocol === "tuic") {
    const params = new URLSearchParams();
    appendQuery(params, "sni", node.sni);
    if (node.alpn.length) params.set("alpn", node.alpn.join(","));
    appendQuery(params, "congestion_control", node.congestionControl);
    appendQuery(params, "udp_relay_mode", node.udpRelayMode);
    if (node.disableSni) params.set("disable_sni", "1");
    if (node.allowInsecure) params.set("allow_insecure", "1");
    const credential = `${encodeURIComponent(node.uuid)}:${encodeURIComponent(node.password)}`;
    const query = params.toString();
    return `tuic://${credential}@${host}:${node.port}${query ? `?${query}` : ""}${fragment}`;
  }
  if (node.protocol === "anytls") {
    const params = new URLSearchParams();
    appendQuery(params, "sni", node.sni);
    if (node.allowInsecure) params.set("insecure", "1");
    const query = params.toString();
    return `anytls://${encodeURIComponent(node.password)}@${host}:${node.port}/${query ? `?${query}` : ""}${fragment}`;
  }
  if (node.protocol === "shadowsocks") {
    const credential = encodeBase64Utf8(`${node.method}:${node.password}`)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `ss://${credential}@${host}:${node.port}${fragment}`;
  }
  const params = new URLSearchParams();
  if (node.protocol === "vless") {
    params.set("encryption", "none");
    appendQuery(params, "flow", node.flow);
  }
  buildTlsQuery(node, params);
  buildTransportQuery(node, params);
  const credential = encodeURIComponent(node.protocol === "trojan" ? node.password : node.uuid);
  return `${node.protocol}://${credential}@${host}:${node.port}?${params.toString()}${fragment}`;
}
