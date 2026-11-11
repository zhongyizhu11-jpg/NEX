/**
 * Egern 自己的 YAML 配置（Profile.yaml）。
 *
 * 以前面板给 Egern 发 Surge 格式（Egern 读得懂），但 Surge 的配置里没有模块的位置，VLESS / REALITY
 * 也写不进去。Egern 有自己的一套 YAML：proxies / policy_groups / rules / modules，写法和 Clash 都不同
 * —— 每一项是「类型名作键、字段作值」的单键映射（`- shadowsocks: {name: …}`），字段名是下划线式。
 *
 * 字段名全部集中在下面的 EGERN_SCHEMA 一张表里：照 egernapp.com/docs/configuration 的
 * proxies / policy_groups / rules / modules / example 几页逐项对过（2026-11）。哪天 Egern 改了名字，
 * 改这一张表就行，渲染代码不用动。表里标了「推断」的是文档没写死、按语义推出来的那几处。
 *
 * 只写文档里有的键：Egern 用 Rust 解析配置，认不出的键是被忽略还是整份报错没核实，
 * 宁可少写一个可选字段，也不赌一份打不开的配置。
 *
 * 这个文件只依赖类型和 proxySubModules（不反过来引 proxySubscription.ts 的函数），
 * 免得两个模块互相 import 成环、在初始化顺序上出 TDZ。
 */

import type { ProxyNode } from "./proxyNode";
import type { ProxySubscriptionGroup } from "./proxySubscriptionPlan";
import { parseEgernModuleArguments, proxySubModuleProblem, type ProxySubTemplateModule } from "./proxySubModules";

// ==================== 字段表 ====================

export const EGERN_SCHEMA = {
  /** 顶层的几段。auto_update 相当于 Surge 的 #!MANAGED-CONFIG（example 页第一项）。 */
  top: {
    proxies: "proxies",
    policyGroups: "policy_groups",
    rules: "rules",
    modules: "modules",
    autoUpdate: "auto_update",
    autoUpdateUrl: "url",
    autoUpdateInterval: "interval",
  },
  /**
   * NEX 协议 → Egern 代理类型。Egern 文档列的协议：Shadowsocks、Snell、Trojan、AnyTLS、Hysteria2、
   * TUIC、SOCKS5、SOCKS5 over TLS、SSH、HTTP、HTTPS、Vmess、Vless、WireGuard —— NEX 的九种全在里面。
   */
  proxyType: {
    shadowsocks: "shadowsocks",
    vmess: "vmess",
    vless: "vless",
    trojan: "trojan",
    hysteria2: "hysteria2",
    tuic: "tuic",
    anytls: "anytls",
    snell: "snell",
    socks5: "socks5",
    /** 带 TLS 的 SOCKS5 是另一个类型名，不是 socks5 加个 tls 开关。 */
    socks5Tls: "socks5_tls",
  },
  /** 每种代理都有的字段，以及 TLS 那几个（各类型同名）。 */
  proxy: {
    name: "name",
    server: "server",
    port: "port",
    /** 前置代理（链式代理）：上一跳的名字。所有代理类型都有，所以 Egern 不用像 Loon 那样在名字上标「需手动接」。 */
    prevHop: "prev_hop",
    /** UDP 转发的开关。Egern 没有叫 udp 的键。Hysteria2 / TUIC 没有这个键（QUIC 自带）。 */
    udpRelay: "udp_relay",
    sni: "sni",
    skipTlsVerify: "skip_tls_verify",
    /** 证书钉扎：叶子证书的 SHA-256（十六进制，可带 : 或 -）。设了它 skip_tls_verify 就不看了。 */
    certSha256: "fingerprint_sha256",
    reality: "reality",
    realityPublicKey: "public_key",
    realityShortId: "short_id",
    password: "password",
    username: "username",
  },
  shadowsocks: { method: "method" },
  /** VMess / VLESS 的用户 ID 叫 user_id（不是 uuid）；VMess 的加密叫 security。 */
  vmess: {
    userId: "user_id",
    security: "security",
    /** 老式 VMess（alterId > 0 的 MD5 认证）。推断：文档只说「旧版协议格式」，alterId > 0 正是那一种。 */
    legacy: "legacy",
    transport: "transport",
  },
  vless: { userId: "user_id", flow: "flow", transport: "transport" },
  /** Trojan 的 WebSocket 不走 transport，是自己的 websocket 子块（path 必填、host 可选）。 */
  trojan: { websocket: "websocket", wsPath: "path", wsHost: "host" },
  /** Hysteria2 的密码叫 auth；bandwidth 是「上行」Mbps，设了就走 Brutal。 */
  hysteria2: { auth: "auth", obfs: "obfs", obfsPassword: "obfs_password", bandwidth: "bandwidth" },
  tuic: { uuid: "uuid", udpRelayMode: "udp_relay_mode", alpn: "alpn" },
  snell: { psk: "psk", version: "version", obfs: "obfs", obfsHost: "obfs_host" },
  /**
   * VMess / VLESS 的 transport 子块。没有「tcp」这个键：不写 transport 就是裸 TCP。
   * NEX 的 http 传输（sing-box 的 http：带 TLS 时是 H2）对到 http2 / http1 —— 推断，没和服务端实测过。
   */
  transport: {
    tls: "tls",
    ws: "ws",
    wss: "wss",
    grpc: "grpc",
    http1: "http1",
    http2: "http2",
    path: "path",
    headers: "headers",
    serviceName: "service_name",
  },
  /** 策略组类型。注意「自动选最快」在 Egern 叫 auto_test，不是 url_test。 */
  groupType: {
    select: "select",
    "url-test": "auto_test",
    fallback: "fallback",
    "load-balance": "load_balance",
  } satisfies Record<ProxySubscriptionGroup["type"], string>,
  group: {
    name: "name",
    policies: "policies",
    interval: "interval",
    tolerance: "tolerance",
    /** 组自己的测速地址，盖过全局的 proxy_latency_test_url。 */
    latencyTestUrl: "latency_test_url",
    /** 负载均衡的算法：默认 hash（同目标钉一台），round_robin 每条新连接换下一台，带宽才叠得起来。 */
    algorithm: "algorithm",
    roundRobin: "round_robin",
    /** 组上挂订阅地址（透传的外部订阅），节点排在 policies 后面、按名字去重。 */
    urls: "urls",
    updateInterval: "update_interval",
  },
  /** 规则：每条是「规则类型: {match, policy}」，兜底是 default（只有 policy）。 */
  ruleType: {
    domain: "domain",
    domainSuffix: "domain_suffix",
    domainKeyword: "domain_keyword",
    ipCidr: "ip_cidr",
    ipCidr6: "ip_cidr6",
    geoip: "geoip",
    ruleSet: "rule_set",
    final: "default",
  },
  rule: { match: "match", policy: "policy", noResolve: "no_resolve", updateInterval: "update_interval" },
  /** 模块引用：name 盖过模块文件里的名字；参数叫 compat_arguments（键值对象），只覆盖模块文件里声明过的键。 */
  module: { url: "url", name: "name", enabled: "enabled", arguments: "compat_arguments" },
} as const;

/** Shadowsocks 能用的加密方式（文档原样）。chacha20-ietf-poly1305 是 example 页里写的，同样收。 */
export const EGERN_SHADOWSOCKS_METHODS: readonly string[] = [
  "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305",
  "chacha20-poly1305", "chacha20-ietf-poly1305", "aes-256-gcm", "aes-128-gcm",
  "none", "table", "rc4", "rc4-md5", "aes-128-cfb", "aes-192-cfb", "aes-256-cfb", "aes-128-ctr", "aes-192-ctr", "aes-256-ctr",
  "bf-cfb", "camellia-128-cfb", "camellia-192-cfb", "camellia-256-cfb", "cast5-cfb", "des-cfb", "idea-cfb", "rc2-cfb", "seed-cfb",
  "salsa20", "chacha20", "chacha20-ietf",
];

/** VMess 的 security 取值（文档原样）。 */
export const EGERN_VMESS_SECURITIES: readonly string[] = ["auto", "aes-128-gcm", "chacha20-poly1305", "none", "zero"];

/** Snell：文档写 1-5，v5 按 v4 实现。没有 v6。 */
export const EGERN_SNELL_VERSIONS: readonly number[] = [1, 2, 3, 4, 5];

const S = EGERN_SCHEMA;

// ==================== 能不能写 ====================

/**
 * 这个节点 Egern 写不写得出来；写不出来返回中文原因（进文件头的「已跳过」注释），能写返回空串。
 *
 * 协议都支持，挡掉的是参数：认不出的加密方式、Egern 没有的传输组合。写一行它读不懂的值，
 * 要么这条节点连不上、要么整份配置解析失败，都不如跳过并说清楚。
 * REALITY / XHTTP / HTTPUpgrade 这几样由 proxySubscription.ts 的通用表管。
 */
export function egernUnsupportedReason(node: ProxyNode): string {
  if (node.protocol === "shadowsocks" && !EGERN_SHADOWSOCKS_METHODS.includes(String(node.method || "").toLowerCase())) {
    return `Egern 的 Shadowsocks 没有 ${node.method || "（空）"} 这种加密方式`;
  }
  if (node.protocol === "vmess" && !EGERN_VMESS_SECURITIES.includes(String(node.method || "auto").toLowerCase())) {
    return `Egern 的 VMess 没有 ${node.method} 这种加密方式`;
  }
  if (node.protocol === "snell") {
    const version = node.snellVersion || 1;
    if (!EGERN_SNELL_VERSIONS.includes(version)) return `Egern 的 Snell 只支持 v1–v5，这个节点是 v${version}`;
    if (node.obfs && node.obfs !== "none" && node.obfs !== "http" && node.obfs !== "tls") return `Egern 的 Snell 只支持 http / tls 混淆，这个节点用的是 ${node.obfs}`;
  }
  if (node.protocol === "hysteria2" && node.obfs && node.obfs !== "salamander") {
    return `Egern 的 Hysteria2 只支持 salamander 混淆，这个节点用的是 ${node.obfs}`;
  }
  // Trojan 在 Egern 里只有 websocket 一个子块，没有 gRPC / HTTP 的位置。
  if (node.protocol === "trojan" && node.transport !== "tcp" && node.transport !== "ws") {
    return `Egern 的 Trojan 只能走 TCP 或 WebSocket，这个节点是 ${node.transport}`;
  }
  if (node.protocol === "vmess" || node.protocol === "vless") {
    // Egern 的 gRPC 传输总是套着 TLS，服务端没开 TLS 时握手必失败。
    if (node.transport === "grpc" && !node.tls && !node.realityPublicKey) return "Egern 的 gRPC 传输总是带 TLS，这个节点没开 TLS";
    // REALITY 只能挂在 tls / grpc 传输下面，ws / http 上没有位置。
    if (node.realityPublicKey && node.transport !== "tcp" && node.transport !== "grpc") return `Egern 的 REALITY 只能配 TCP 或 gRPC 传输，这个节点是 ${node.transport}`;
  }
  return "";
}

// ==================== 渲染 ====================

export type EgernRenderSettings = {
  testUrl: string;
  testIntervalSec: number;
  toleranceMs: number;
  rulesetIntervalSec: number;
  updateIntervalHours: number;
};

/** 和 proxySubscription.ts 的 ProfileRule 同形（那边按 Surge 的规则列表展开好、镜像也换好了再传进来）。 */
export type EgernProfileRule =
  | { kind: "list"; url: string; tag: string; target: string }
  | { kind: "domain"; suffix: boolean; domain: string; target: string }
  | { kind: "keyword"; keyword: string; target: string }
  | { kind: "cidr"; cidr: string; v6: boolean; target: string }
  | { kind: "geoip-cn"; target: string }
  | { kind: "geoip"; code: string; target: string }
  | { kind: "final"; target: string };

/** 双引号字符串。控制字符在进渲染器之前已经剥掉了（sanitizeDocumentForTextFormats），这里只转义 \ 和 "。 */
function q(value: unknown): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 按缩进攒行。值为 null 表示后面跟一个子块（写成 `key:`，不留尾随空格）。 */
class Lines {
  readonly out: string[] = [];
  push(indent: number, key: string, value: string | null) {
    this.out.push(`${" ".repeat(indent)}${key}:${value === null ? "" : ` ${value}`}`);
  }
  item(indent: number, text: string) {
    this.out.push(`${" ".repeat(indent)}- ${text}`);
  }
}

const bool = (value: boolean) => (value ? "true" : "false");

/** TLS 那几个字段（sni / 跳过校验 / 证书钉扎 / REALITY），各代理类型和 transport 子块里同名。 */
function tlsFields(lines: Lines, indent: number, node: ProxyNode, options: { reality: boolean; explicitSkip?: boolean }) {
  if (node.sni && !(node.protocol === "tuic" && node.disableSni)) lines.push(indent, S.proxy.sni, q(node.sni));
  // AnyTLS 不写这个键时 Egern 默认**跳过**校验（文档特别说明）；NEX 的语义是没勾「跳过」就校验，所以显式写 false。
  if (node.allowInsecure) lines.push(indent, S.proxy.skipTlsVerify, "true");
  else if (options.explicitSkip) lines.push(indent, S.proxy.skipTlsVerify, "false");
  if (node.certSha256) lines.push(indent, S.proxy.certSha256, q(node.certSha256));
  if (options.reality && node.realityPublicKey) {
    lines.push(indent, S.proxy.reality, null);
    lines.push(indent + 2, S.proxy.realityPublicKey, q(node.realityPublicKey));
    if (node.realityShortId) lines.push(indent + 2, S.proxy.realityShortId, q(node.realityShortId));
  }
}

/** VMess / VLESS 的 transport 子块；裸 TCP 不写。 */
function transportBlock(lines: Lines, indent: number, node: ProxyNode) {
  const T = S.transport;
  const secure = node.tls || !!node.realityPublicKey;
  const headers = (at: number) => {
    if (!node.host) return;
    lines.push(at, T.headers, null);
    lines.push(at + 2, "Host", q(node.host));
  };
  let kind: string | null = null;
  if (node.transport === "ws") kind = secure ? T.wss : T.ws;
  else if (node.transport === "grpc") kind = T.grpc;
  else if (node.transport === "http") kind = secure ? T.http2 : T.http1;
  else if (secure) kind = T.tls;
  if (!kind) return;
  lines.push(indent, node.protocol === "vless" ? S.vless.transport : S.vmess.transport, null);
  lines.push(indent + 2, kind, null);
  const at = indent + 4;
  if (kind === T.ws || kind === T.wss) {
    lines.push(at, T.path, q(node.path || "/"));
    headers(at);
  } else if (kind === T.http1 || kind === T.http2) {
    if (node.path) lines.push(at, T.path, q(node.path));
    headers(at);
  } else if (kind === T.grpc) {
    if (node.path) lines.push(at, T.serviceName, q(node.path));
  }
  if (kind !== T.ws && kind !== T.http1) tlsFields(lines, at, node, { reality: kind === T.tls || kind === T.grpc });
}

/** 一个节点 → proxies 下的一项。调用前已经过 egernUnsupportedReason。 */
export function egernProxyLines(node: ProxyNode): string[] {
  const lines = new Lines();
  const P = S.proxy;
  const tlsSocks = node.protocol === "socks5" && node.tls;
  const type = tlsSocks ? S.proxyType.socks5Tls : S.proxyType[node.protocol];
  lines.item(2, `${type}:`);
  const at = 6;
  lines.push(at, P.name, q(node.name));
  lines.push(at, P.server, q(node.address));
  lines.push(at, P.port, String(node.port));

  if (node.protocol === "shadowsocks") {
    lines.push(at, S.shadowsocks.method, q(node.method));
    lines.push(at, P.password, q(node.password));
    lines.push(at, P.udpRelay, bool(node.udp));
  } else if (node.protocol === "vmess") {
    lines.push(at, S.vmess.userId, q(node.uuid));
    lines.push(at, S.vmess.security, q(String(node.method || "auto").toLowerCase()));
    if (node.alterId > 0) lines.push(at, S.vmess.legacy, "true");
    lines.push(at, P.udpRelay, bool(node.udp));
    transportBlock(lines, at, node);
  } else if (node.protocol === "vless") {
    lines.push(at, S.vless.userId, q(node.uuid));
    if (node.flow) lines.push(at, S.vless.flow, q(node.flow));
    lines.push(at, P.udpRelay, bool(node.udp));
    transportBlock(lines, at, node);
  } else if (node.protocol === "trojan") {
    lines.push(at, P.password, q(node.password));
    lines.push(at, P.udpRelay, bool(node.udp));
    tlsFields(lines, at, node, { reality: true });
    if (node.transport === "ws") {
      lines.push(at, S.trojan.websocket, null);
      lines.push(at + 2, S.trojan.wsPath, q(node.path || "/"));
      if (node.host) lines.push(at + 2, S.trojan.wsHost, q(node.host));
    }
  } else if (node.protocol === "anytls") {
    lines.push(at, P.password, q(node.password));
    lines.push(at, P.udpRelay, bool(node.udp));
    tlsFields(lines, at, node, { reality: true, explicitSkip: true });
  } else if (node.protocol === "hysteria2") {
    lines.push(at, S.hysteria2.auth, q(node.password));
    if (node.obfs === "salamander") {
      lines.push(at, S.hysteria2.obfs, q("salamander"));
      if (node.obfsPassword) lines.push(at, S.hysteria2.obfsPassword, q(node.obfsPassword));
    }
    // Egern 只有一个 bandwidth，文档写的是上行；下行由服务端按自己的上限发。
    if (node.upMbps > 0) lines.push(at, S.hysteria2.bandwidth, String(Math.floor(node.upMbps)));
    tlsFields(lines, at, node, { reality: false });
  } else if (node.protocol === "tuic") {
    lines.push(at, S.tuic.uuid, q(node.uuid));
    lines.push(at, P.password, q(node.password));
    // 只有 native / quic 两种；拥塞控制 Egern 没有这个键，不写。
    if (node.udpRelayMode === "native" || node.udpRelayMode === "quic") lines.push(at, S.tuic.udpRelayMode, q(node.udpRelayMode));
    if (node.alpn.length) {
      lines.push(at, S.tuic.alpn, null);
      for (const item of node.alpn) lines.item(at + 2, q(item));
    }
    tlsFields(lines, at, node, { reality: false });
  } else if (node.protocol === "snell") {
    const version = node.snellVersion || 1;
    lines.push(at, S.snell.psk, q(node.password));
    lines.push(at, S.snell.version, String(version));
    // UDP 只有 v3 起才有（v5 按 v4 实现）；v1 / v2 写了也不生效。
    if (version >= 3) lines.push(at, P.udpRelay, bool(node.udp));
    if (node.obfs === "http" || node.obfs === "tls") {
      lines.push(at, S.snell.obfs, q(node.obfs));
      if (node.host) lines.push(at, S.snell.obfsHost, q(node.host));
    }
  } else {
    if (node.username) lines.push(at, P.username, q(node.username));
    if (node.password) lines.push(at, P.password, q(node.password));
    lines.push(at, P.udpRelay, bool(node.udp));
    if (tlsSocks) tlsFields(lines, at, node, { reality: true });
  }
  if (node.frontProxyName) lines.push(at, P.prevHop, q(node.frontProxyName));
  return lines.out;
}

function proxiesSection(nodes: readonly ProxyNode[]): string[] {
  if (nodes.length === 0) return [`${S.top.proxies}: []`];
  return [`${S.top.proxies}:`, ...nodes.flatMap(egernProxyLines)];
}

/**
 * 节点订阅：只有 proxies（Egern 文档里「订阅文件格式」就是这样：一份只有 proxies 的 YAML，
 * 挂在策略组的 urls 上或者「添加订阅」进默认的外部组）。策略组、规则在规则订阅里。
 */
export function renderEgernNodes(nodes: readonly ProxyNode[], notices: readonly string[]): string {
  return `${[...notices, ...proxiesSection(nodes)].join("\n")}\n`;
}

function groupLines(group: ProxySubscriptionGroup, settings: EgernRenderSettings, providers: ReadonlyMap<string, { url: string; intervalSec: number }>): string[] {
  const G = S.group;
  const lines = new Lines();
  lines.item(2, `${S.groupType[group.type]}:`);
  const at = 6;
  lines.push(at, G.name, q(group.name));
  const members = Array.from(new Set(group.members));
  const used = (group.use || []).map((name) => providers.get(name)).filter((item): item is { url: string; intervalSec: number } => !!item);
  if (members.length > 0) {
    lines.push(at, G.policies, null);
    for (const member of members) lines.item(at + 2, q(member));
  } else if (used.length === 0) {
    lines.push(at, G.policies, "[]");
  }
  if (used.length > 0) {
    lines.push(at, G.urls, null);
    for (const provider of used) lines.item(at + 2, q(provider.url));
    // 同一组挂了几份更新间隔不同的订阅时取最短的；最短 10 分钟，和 Clash 的 proxy-providers 一样。
    lines.push(at, G.updateInterval, String(Math.max(600, Math.floor(Math.min(...used.map((provider) => provider.intervalSec || 21600))))));
  }
  if (group.type !== "select") {
    // 测速地址写在组上（和 Clash 一样），模板的开头部分没写 proxy_latency_test_url 时设置页的测速地址照样生效。
    lines.push(at, G.latencyTestUrl, q(settings.testUrl));
    if (group.type === "url-test" || group.type === "fallback") lines.push(at, G.interval, String(settings.testIntervalSec));
    // 容差避免两条延迟接近的线路来回横跳，每次切换都会断开正在进行的连接。
    if (group.type === "url-test") lines.push(at, G.tolerance, String(settings.toleranceMs));
    // 轮询而不是默认的 hash：hash 按目标钉一台，测速和多线程下载叠不起来。和 Clash / Loon 的取舍一致。
    if (group.type === "load-balance") lines.push(at, G.algorithm, G.roundRobin);
  }
  return lines.out;
}

function ruleLines(rule: EgernProfileRule, settings: EgernRenderSettings): string[] {
  const R = S.rule;
  const T = S.ruleType;
  const lines = new Lines();
  const head = (type: string, match: string | null) => {
    lines.item(2, `${type}:`);
    if (match !== null) lines.push(6, R.match, q(match));
    lines.push(6, R.policy, q(rule.target));
  };
  if (rule.kind === "list") {
    // Egern 认 Surge 的规则列表（官方 FAQ），所以规则集沿用给 Surge 的那几份 .list，镜像设置同样生效。
    head(T.ruleSet, rule.url);
    lines.push(6, R.updateInterval, String(settings.rulesetIntervalSec));
  } else if (rule.kind === "domain") head(rule.suffix ? T.domainSuffix : T.domain, rule.domain);
  else if (rule.kind === "keyword") head(T.domainKeyword, rule.keyword);
  else if (rule.kind === "cidr") {
    head(rule.v6 ? T.ipCidr6 : T.ipCidr, rule.cidr);
    // 和 Surge 的写法一致：网段规则不为了匹配去解析域名。
    lines.push(6, R.noResolve, "true");
  } else if (rule.kind === "geoip-cn") head(T.geoip, "CN");
  else if (rule.kind === "geoip") head(T.geoip, rule.code);
  else head(T.final, null);
  return lines.out;
}

/**
 * 模板里挂的模块 → modules 下的一项。校验没过的（存进来之后规则又收紧了）整条不写，
 * 宁可少一个模块，也不要一份 Egern 读不懂的配置。
 */
export function egernModuleLines(module: ProxySubTemplateModule): string[] {
  if (proxySubModuleProblem(module, 0, "egern")) return [];
  const M = S.module;
  const lines = new Lines();
  lines.item(2, `${M.url}: ${q(module.url)}`);
  if (module.tag) lines.push(4, M.name, q(module.tag));
  // enabled 默认就是 true，但照样写出来：关掉的模块也留在配置里，用户在 Egern 里自己能打开。
  lines.push(4, M.enabled, bool(module.enabled));
  const parsed = parseEgernModuleArguments(module.argument);
  if (parsed.ok && parsed.pairs.length > 0) {
    lines.push(4, M.arguments, null);
    // 一律写成字符串：模块文件里的占位符是纯文本替换，带不带引号由模块文件那一侧决定。
    for (const [key, value] of parsed.pairs) lines.push(6, q(key), q(value));
  }
  return lines.out;
}

export type EgernProfileInput = {
  nodes: readonly ProxyNode[];
  groups: readonly ProxySubscriptionGroup[];
  rules: readonly EgernProfileRule[];
  notices: readonly string[];
  /** 模板的开头部分（占位符已替换），原样放在 proxies 前面。 */
  prelude: string;
  /** 这份配置自己的地址；有就写 auto_update，让 Egern 定时重新下载。 */
  profileUrl: string;
  modules: readonly ProxySubTemplateModule[];
  providers: readonly { name: string; url: string; intervalSec: number }[];
  settings: EgernRenderSettings;
};

/** 规则订阅：完整的 Profile.yaml（开头部分 + proxies + policy_groups + rules + modules）。 */
export function renderEgernProfile(input: EgernProfileInput): string {
  const lines: string[] = [...input.notices];
  // 和 Clash 的开头部分同样处理：去掉行尾空白，连续空行只留一个。
  const prelude = input.prelude.split("\n").map((line) => line.replace(/\s+$/, "")).filter((line, index, all) => line || (index > 0 && all[index - 1]));
  if (prelude.length > 0) lines.push(...prelude);
  // 模板自己写了 auto_update 就不再写一份：YAML 里同一个键出现两次，有的解析器直接报错。
  if (input.profileUrl && !/^auto_update\s*:/m.test(input.prelude)) {
    lines.push(`${S.top.autoUpdate}:`);
    lines.push(`  ${S.top.autoUpdateUrl}: ${q(input.profileUrl)}`);
    lines.push(`  ${S.top.autoUpdateInterval}: ${Math.max(1, Math.floor(input.settings.updateIntervalHours * 3600))}`);
  }
  lines.push(...proxiesSection(input.nodes));
  const providers = new Map(input.providers.map((provider) => [provider.name, provider]));
  if (input.groups.length === 0) lines.push(`${S.top.policyGroups}: []`);
  else {
    lines.push(`${S.top.policyGroups}:`);
    for (const group of input.groups) lines.push(...groupLines(group, input.settings, providers));
  }
  lines.push(`${S.top.rules}:`);
  for (const rule of input.rules) lines.push(...ruleLines(rule, input.settings));
  const modules = input.modules.flatMap(egernModuleLines);
  // 没有模块就不出这一段（不留一个空的 modules:）。
  if (modules.length > 0) lines.push(`${S.top.modules}:`, ...modules);
  return `${lines.join("\n")}\n`;
}
