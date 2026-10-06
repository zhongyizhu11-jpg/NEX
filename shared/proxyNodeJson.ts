/**
 * 从 JSON 里读出节点。
 *
 * 同样是「节点配置」，不同工具给出的 JSON 结构差别很大，这里按结构自动判断：
 *
 *   sing-box 出站   { "type":"vless", "server":"1.2.3.4", "server_port":443, ... }
 *   Clash 节点条目  { "name":"HK", "type":"vless", "server":"1.2.3.4", "port":443, ... }
 *   v2rayN VMess    { "v":"2", "ps":"HK", "add":"1.2.3.4", "port":"443", "id":"..." }
 *   完整客户端配置  { "outbounds":[ ... ] }  → 取第一个真正的代理出站
 *   服务端配置      { "inbounds":[ ... ] }   → 取第一个代理入站
 *
 * 服务端配置有个绕不开的限制：listen 通常是 0.0.0.0，它不知道自己的公网地址，
 * 所以解析出来的地址会是空的，得由调用方补上。这不是可以「猜」的东西 ——
 * 猜错会生成一个连不上的节点，而用户在客户端侧完全看不出原因。
 */

import {
  createEmptyProxyNode,
  proxyNodeAlwaysTls,
  PROXY_NODE_TRANSPORTS,
  type ProxyNode,
  type ProxyNodeProtocol,
  type ProxyNodeTransport,
} from "./proxyNode";

export type ParseProxyNodeJsonResult =
  | { ok: true; node: ProxyNode; needsAddress: boolean; source: ProxyNodeJsonSource }
  | { ok: false; error: string };

export type ProxyNodeJsonSource = "singbox-outbound" | "clash-proxy" | "vmess-v2rayn" | "server-inbound";

const PROTOCOL_ALIASES: Record<string, ProxyNodeProtocol> = {
  vless: "vless",
  vmess: "vmess",
  trojan: "trojan",
  ss: "shadowsocks",
  shadowsocks: "shadowsocks",
  hysteria2: "hysteria2",
  // hy2 是 Hysteria 2 的官方简写，部分工具的配置里就写这个。
  hy2: "hysteria2",
  tuic: "tuic",
  anytls: "anytls",
  snell: "snell",
};

/** 不是代理协议的出/入站类型，遍历时要跳过。 */
// 注意 "hysteria" 是 v1，与 hysteria2 是两个不兼容的协议，这里挡的只是 v1。
const NON_PROXY_TYPES = new Set([
  "direct", "block", "dns", "selector", "urltest", "hysteria", "socks", "http",
  "dokodemo-door", "api", "freedom", "blackhole", "wireguard", "tun", "mixed", "redirect", "tproxy",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toPort(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

/**
 * 带宽字段统一成 Mbps 整数。sing-box 是裸数字（Mbps）；mihomo 的 up / down 可以是
 * 裸数字（按 Mbps）或 "30 Mbps"、"1 Gbps" 这样的带单位字符串；Stash 的 up-speed /
 * down-speed 是裸数字（Mbps）。
 */
export function bandwidthMbps(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const raw = text(value).toLowerCase();
  if (!raw) return 0;
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?)(?:bps|b)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const scale = { "": 1, k: 1 / 1000, m: 1, g: 1000, t: 1_000_000 }[match[2] as "" | "k" | "m" | "g" | "t"] ?? 1;
  return Math.max(0, Math.floor(amount * scale));
}

function toBool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function toTransport(value: unknown): ProxyNodeTransport {
  const raw = text(value).toLowerCase();
  if (raw === "websocket") return "ws";
  if (raw === "h2" || raw === "http2") return "http";
  if (raw === "none" || raw === "") return "tcp";
  return (PROXY_NODE_TRANSPORTS as readonly string[]).includes(raw) ? (raw as ProxyNodeTransport) : "tcp";
}

function toAlpn(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  const raw = text(value);
  return raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function protocolOf(value: unknown): ProxyNodeProtocol | null {
  return PROTOCOL_ALIASES[text(value).toLowerCase()] ?? null;
}

/** 地址是回环或通配时视为「没有地址」—— 服务端配置里的 listen 就是这样。 */
function usableAddress(value: unknown): string {
  const address = text(value);
  if (!address) return "";
  if (address === "0.0.0.0" || address === "::" || address === "*") return "";
  return address;
}

// ==================== sing-box 出站 ====================

function fromSingboxOutbound(raw: Record<string, unknown>): ProxyNode | null {
  const protocol = protocolOf(raw.type);
  if (!protocol) return null;

  const node = createEmptyProxyNode();
  node.protocol = protocol;
  node.name = text(raw.tag);
  node.address = usableAddress(raw.server);
  node.port = toPort(raw.server_port);
  node.uuid = text(raw.uuid);
  node.password = text(raw.password);
  node.method = text(raw.method);
  node.alterId = Number(raw.alter_id) || 0;
  node.flow = text(raw.flow);
  node.congestionControl = text(raw.congestion_control);
  node.udpRelayMode = text(raw.udp_relay_mode);
  node.upMbps = bandwidthMbps(raw.up_mbps);
  node.downMbps = bandwidthMbps(raw.down_mbps);
  if (protocol === "snell") {
    // sing-box 的 Snell 鉴权字段是 psk，不是 password。
    node.password = text(raw.psk) || node.password;
    node.snellVersion = Number(raw.version) || 1;
    node.obfs = text(raw.obfs_mode).toLowerCase();
    node.host = text(raw.obfs_host) || node.host;
    node.snellMode = text(raw.mode);
  }
  const obfs = raw.obfs as Record<string, unknown> | undefined;
  if (obfs && typeof obfs === "object") {
    node.obfs = text(obfs.type).toLowerCase();
    node.obfsPassword = text(obfs.password);
  }

  const transport = raw.transport as Record<string, unknown> | undefined;
  if (transport && typeof transport === "object") {
    node.transport = toTransport(transport.type);
    node.xhttpMode = text(transport.mode);
    // grpc 用 service_name，ws/http 用 path。
    node.path = text(transport.service_name) || text(transport.path);
    const headers = transport.headers as Record<string, unknown> | undefined;
    node.host = text(transport.host) || text(headers?.Host) || text(headers?.host);
  }

  const tls = raw.tls as Record<string, unknown> | undefined;
  if (tls && typeof tls === "object" && toBool(tls.enabled)) {
    node.tls = true;
    node.sni = text(tls.server_name);
    node.alpn = toAlpn(tls.alpn);
    node.allowInsecure = toBool(tls.insecure);
    node.disableSni = toBool(tls.disable_sni);
    const utls = tls.utls as Record<string, unknown> | undefined;
    node.fingerprint = text(utls?.fingerprint);
    const reality = tls.reality as Record<string, unknown> | undefined;
    if (reality && toBool(reality.enabled)) {
      node.realityPublicKey = text(reality.public_key);
      node.realityShortId = text(reality.short_id);
    }
  }

  return node;
}

// ==================== Clash 节点条目 ====================

function fromClashProxy(raw: Record<string, unknown>): ProxyNode | null {
  const protocol = protocolOf(raw.type);
  if (!protocol) return null;

  const node = createEmptyProxyNode();
  node.protocol = protocol;
  node.name = text(raw.name);
  node.address = usableAddress(raw.server);
  node.port = toPort(raw.port);
  node.uuid = text(raw.uuid);
  // trojan 用 password，ss 也用 password；vmess 的 id 落在 uuid 上。
  node.password = text(raw.password);
  node.method = text(raw.cipher);
  node.alterId = Number(raw.alterId) || 0;
  node.flow = text(raw.flow);
  node.udp = raw.udp === undefined ? true : toBool(raw.udp);
  node.obfs = text(raw.obfs).toLowerCase();
  node.obfsPassword = text(raw["obfs-password"]);
  // Hysteria2 的 Brutal 带宽：mihomo 叫 up / down（可带单位），Stash 叫 up-speed / down-speed。
  node.upMbps = bandwidthMbps(raw.up ?? raw["up-speed"]);
  node.downMbps = bandwidthMbps(raw.down ?? raw["down-speed"]);
  // Stash 的 hysteria2 鉴权键叫 auth，mihomo 叫 password。
  if (protocol === "hysteria2" && !node.password) node.password = text(raw.auth);
  // mihomo 的 tuic 键名是 congestion-controller，别写成 sing-box 的 congestion_control。
  node.congestionControl = text(raw["congestion-controller"]);
  node.udpRelayMode = text(raw["udp-relay-mode"]);
  node.disableSni = toBool(raw["disable-sni"]);
  if (protocol === "snell") {
    node.password = text(raw.psk) || node.password;
    node.snellVersion = Number(raw.version) || 1;
    const obfsOpts = raw["obfs-opts"] as Record<string, unknown> | undefined;
    if (obfsOpts && typeof obfsOpts === "object") {
      node.obfs = text(obfsOpts.mode).toLowerCase();
      node.host = text(obfsOpts.host) || node.host;
    }
  }

  node.transport = toTransport(raw.network);
  const wsOpts = raw["ws-opts"] as Record<string, unknown> | undefined;
  if (wsOpts && typeof wsOpts === "object") {
    node.path = text(wsOpts.path);
    const headers = wsOpts.headers as Record<string, unknown> | undefined;
    node.host = text(headers?.Host) || text(headers?.host);
  }
  const grpcOpts = raw["grpc-opts"] as Record<string, unknown> | undefined;
  if (grpcOpts && typeof grpcOpts === "object") {
    node.path = text(grpcOpts["grpc-service-name"]);
  }
  const xhttpOpts = raw["xhttp-opts"] as Record<string, unknown> | undefined;
  if (xhttpOpts && typeof xhttpOpts === "object") {
    node.path = text(xhttpOpts.path) || node.path;
    node.host = text(xhttpOpts.host) || node.host;
    node.xhttpMode = text(xhttpOpts.mode);
  }

  // Clash 里 vless/trojan 默认走 TLS，vmess 看 tls 字段。
  node.tls = toBool(raw.tls) || protocol === "trojan" || (protocol === "vless" && raw.tls === undefined);
  // Clash 的 vless/vmess 用 servername，trojan 用 sni。
  node.sni = text(raw.servername) || text(raw.sni);
  node.alpn = toAlpn(raw.alpn);
  node.allowInsecure = toBool(raw["skip-cert-verify"]);
  node.fingerprint = text(raw["client-fingerprint"]);

  const reality = raw["reality-opts"] as Record<string, unknown> | undefined;
  if (reality && typeof reality === "object") {
    node.realityPublicKey = text(reality["public-key"]);
    node.realityShortId = text(reality["short-id"]);
    if (node.realityPublicKey) node.tls = true;
  }

  return node;
}

// ==================== v2rayN 的 VMess JSON ====================

function fromVmessJson(raw: Record<string, unknown>): ProxyNode | null {
  if (!text(raw.add) || !text(raw.id)) return null;

  const node = createEmptyProxyNode();
  node.protocol = "vmess";
  node.name = text(raw.ps);
  node.address = usableAddress(raw.add);
  node.port = toPort(raw.port);
  node.uuid = text(raw.id);
  node.alterId = Number(raw.aid) || 0;
  node.method = text(raw.scy) || "auto";
  node.transport = toTransport(raw.net);
  node.path = text(raw.path);
  node.host = text(raw.host);
  node.tls = text(raw.tls).toLowerCase() === "tls";
  node.sni = text(raw.sni) || node.host;
  node.alpn = toAlpn(raw.alpn);
  node.fingerprint = text(raw.fp);
  return node;
}

// ==================== 服务端入站 ====================

function fromServerInbound(raw: Record<string, unknown>): ProxyNode | null {
  // sing-box 服务端用 type，Xray 用 protocol。
  const protocol = protocolOf(raw.type) ?? protocolOf(raw.protocol);
  if (!protocol) return null;

  const node = createEmptyProxyNode();
  node.protocol = protocol;
  node.name = text(raw.tag);
  // listen 是监听地址，不是公网地址；0.0.0.0 会被 usableAddress 归零。
  node.address = usableAddress(raw.listen);
  node.port = toPort(raw.listen_port) || toPort(raw.port);

  // sing-box 服务端把用户放在 users 数组里。
  const users = raw.users as Array<Record<string, unknown>> | undefined;
  const user = Array.isArray(users) ? users[0] : undefined;
  if (user) {
    node.uuid = text(user.uuid);
    // Snell 服务端的鉴权字段是 psk（妙妙屋X 的 Snell 入站就是这么写的）。
    node.password = text(user.password) || text(user.psk);
    node.snellVersion = Number(user.version) || node.snellVersion;
    node.obfs = text(user.obfsMode).toLowerCase() || node.obfs;
    node.host = text(user.obfsHost) || node.host;
    node.snellMode = text(user.v6Mode) || node.snellMode;
    node.flow = text(user.flow);
    node.alterId = Number(user.alterId) || 0;
  }
  node.method = text(raw.method);

  // Xray 服务端把用户放在 settings.clients 里；Snell 与 AnyTLS 用的是 settings.users。
  const settings = raw.settings as Record<string, unknown> | undefined;
  const settingsUsers = settings?.users as Array<Record<string, unknown>> | undefined;
  const settingsUser = Array.isArray(settingsUsers) ? settingsUsers[0] : undefined;
  if (settingsUser) {
    node.password = node.password || text(settingsUser.password) || text(settingsUser.psk);
    node.uuid = node.uuid || text(settingsUser.id);
    node.snellVersion = node.snellVersion || Number(settingsUser.version) || 0;
    node.obfs = node.obfs || text(settingsUser.obfsMode).toLowerCase();
    node.host = node.host || text(settingsUser.obfsHost);
    node.snellMode = node.snellMode || text(settingsUser.v6Mode);
  }
  const clients = settings?.clients as Array<Record<string, unknown>> | undefined;
  const client = Array.isArray(clients) ? clients[0] : undefined;
  if (client) {
    node.uuid = node.uuid || text(client.id);
    node.password = node.password || text(client.password);
    node.flow = node.flow || text(client.flow);
  }
  node.password = node.password || text(settings?.password);
  node.method = node.method || text(settings?.method);

  const singboxTls = raw.tls as Record<string, unknown> | undefined;
  if (singboxTls && typeof singboxTls === "object" && toBool(singboxTls.enabled)) {
    node.tls = true;
    const names = singboxTls.server_name;
    node.sni = text(names) || (Array.isArray(names) ? text(names[0]) : "");
    node.alpn = toAlpn(singboxTls.alpn);
    const reality = singboxTls.reality as Record<string, unknown> | undefined;
    if (reality && toBool(reality.enabled)) {
      // 服务端只有私钥，公钥得从客户端链接拿 —— 这里留空，由调用方提示。
      node.realityShortId = text((reality.short_id as string[] | undefined)?.[0]);
    }
  }

  const stream = raw.streamSettings as Record<string, unknown> | undefined;
  if (stream && typeof stream === "object") {
    node.transport = toTransport(stream.network);
    const wsSettings = stream.wsSettings as Record<string, unknown> | undefined;
    if (wsSettings) {
      node.path = text(wsSettings.path);
      const headers = wsSettings.headers as Record<string, unknown> | undefined;
      node.host = text(headers?.Host) || text(headers?.host);
    }
    const grpcSettings = stream.grpcSettings as Record<string, unknown> | undefined;
    if (grpcSettings) node.path = text(grpcSettings.serviceName);
    const security = text(stream.security).toLowerCase();
    if (security === "tls" || security === "reality") {
      node.tls = true;
      const tlsSettings = stream.tlsSettings as Record<string, unknown> | undefined;
      node.sni = node.sni || text(tlsSettings?.serverName);
      const realitySettings = stream.realitySettings as Record<string, unknown> | undefined;
      if (realitySettings) {
        node.sni = node.sni || text((realitySettings.serverNames as string[] | undefined)?.[0]);
        node.realityShortId = node.realityShortId || text((realitySettings.shortIds as string[] | undefined)?.[0]);
      }
    }
  }

  return node;
}

// ==================== 入口 ====================

function firstProxyEntry(list: unknown): Record<string, unknown> | null {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const kind = text(raw.type).toLowerCase() || text(raw.protocol).toLowerCase();
    if (NON_PROXY_TYPES.has(kind)) continue;
    if (protocolOf(kind)) return raw;
  }
  return null;
}

/** 输入看起来像 JSON 吗 —— 只是形状判断，不代表能解析成功。 */
export function looksLikeProxyNodeJson(input: unknown): boolean {
  const raw = typeof input === "string" ? input.trim() : "";
  return raw.startsWith("{") || raw.startsWith("[");
}

export function parseProxyNodeJson(input: unknown): ParseProxyNodeJsonResult {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return { ok: false, error: "内容为空" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "不是合法的 JSON，请确认是完整复制的（花括号要配对）" };
  }

  // 顶层是数组时（例如 Clash 的 proxies 片段），取第一个代理条目。
  const root = Array.isArray(parsed) ? firstProxyEntry(parsed) : (parsed as Record<string, unknown> | null);
  if (!root || typeof root !== "object") {
    return { ok: false, error: "JSON 里没有找到节点配置" };
  }

  // 完整配置：先看出站，再看入站。出站是客户端配置，参数更全，优先。
  if (Array.isArray(root.outbounds)) {
    const entry = firstProxyEntry(root.outbounds);
    if (!entry) return { ok: false, error: "配置里的 outbounds 没有代理节点（只有 direct / block 之类）" };
    const node = fromSingboxOutbound(entry) ?? fromClashProxy(entry);
    if (!node) return { ok: false, error: "outbounds 里的节点类型暂不支持" };
    return finish(node, "singbox-outbound");
  }

  if (Array.isArray(root.inbounds)) {
    const entry = firstProxyEntry(root.inbounds);
    if (!entry) return { ok: false, error: "服务端配置里没有代理入站" };
    const node = fromServerInbound(entry);
    if (!node) return { ok: false, error: "服务端入站的协议暂不支持" };
    return finish(node, "server-inbound");
  }

  // 单条：按特征字段判断是哪一种。
  if (text(root.add) && text(root.id)) {
    const node = fromVmessJson(root);
    if (!node) return { ok: false, error: "VMess JSON 缺少必要字段（add / id）" };
    return finish(node, "vmess-v2rayn");
  }

  if (root.server !== undefined) {
    const node = root.server_port !== undefined ? fromSingboxOutbound(root) : fromClashProxy(root);
    if (!node) {
      return {
        ok: false,
        error: `暂不支持该协议：${text(root.type) || "未知"}。目前支持 VLESS / VMess / Trojan / Shadowsocks / Hysteria2 / TUIC / AnyTLS / Snell`,
      };
    }
    return finish(node, root.server_port !== undefined ? "singbox-outbound" : "clash-proxy");
  }

  if (root.listen !== undefined || root.protocol !== undefined) {
    const node = fromServerInbound(root);
    if (node) return finish(node, "server-inbound");
  }

  return { ok: false, error: "认不出这份 JSON 的结构，请粘贴单个节点配置或完整的客户端/服务端配置" };
}

function finish(node: ProxyNode, source: ProxyNodeJsonSource): ParseProxyNodeJsonResult {
  if (!node.port) return { ok: false, error: "配置里没有可用的端口" };
  const hasCredential = node.uuid || node.password;
  if (!hasCredential) return { ok: false, error: "配置里没有找到 UUID 或密码" };
  // Hysteria2 / TUIC / AnyTLS 的配置里不会写 tls: true —— TLS 是协议自带的。
  // 漏掉这一步，渲染时会当成明文节点，客户端握手直接失败。
  if (proxyNodeAlwaysTls(node.protocol)) node.tls = true;
  return { ok: true, node, needsAddress: !node.address, source };
}
