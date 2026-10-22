/**
 * 自建入站（落地节点）在各家客户端里能不能用。
 *
 * 判断分两层，顺序有讲究：
 *   1. 客户端本身认不认这个协议 / 传输 / 安全层（下面的 CLIENT_FACTS）。
 *   2. 面板发给它的那种订阅格式装不装得下（proxySubscription.ts 的 unsupportedReason）——
 *      客户端认、但订阅格式写不出来，用户照样拿不到这个节点，所以也算「用不了」。
 *
 * 取值只有三种：能用、不能用、没核实。没把握的一律标「没核实」而不是猜 ——
 * 标错一个「能用」，用户会以为是节点坏了；标错一个「不能用」，用户会白白换客户端。
 *
 * 依据（只写有把握的）：
 *   - 订阅格式能力：proxySubscription.ts 的 FORMAT_UNSUPPORTED_PROTOCOLS 等表，那边逐条对过官方手册。
 *   - Surge 手册的策略类型里没有 VLESS；传输只有 WebSocket（没有 gRPC / H2 / HTTPUpgrade）。
 *   - Quantumult X 官方 sample.conf：只有 shadowsocks / vmess / vless / trojan / http，
 *     传输写在 obfs 里（ws / wss / over-tls / http），没有 gRPC，也没有 REALITY。
 *   - 原版 Clash（Dreamacro/clash，Premium 内核，ClashX / Clash for Windows 用它）2023 年已停更，
 *     协议表里没有 VLESS / Hysteria2 / AnyTLS，没有 REALITY，Snell 只到 v3，
 *     Shadowsocks 没有 2022-blake3 系列。
 *   - mihomo（Clash.Meta）：VLESS / REALITY / Hysteria2 / TUIC / AnyTLS 都有，Snell 到 v5。
 *   - v2rayN / v2rayNG 默认是 Xray 内核：VLESS / REALITY / Vision / SS2022 / HTTPUpgrade 都有。
 *   - Hiddify、NekoBox / NekoRay 用 sing-box 内核，能力跟 sing-box 走，但 Snell 没有分享链接，
 *     通用订阅装不下。
 */

import { PROXY_CLIENT_TARGETS } from "./proxyClientImport";
import {
  createEmptyProxyNode,
  PROXY_NODE_PROTOCOL_LABELS,
  type ProxyNodeProtocol,
  type ProxyNodeTransport,
} from "./proxyNode";
import { isLegacyShadowsocksMethod, type ProxyInboundProtocol } from "./proxyInbound";
import { proxyNodeUnsupportedReasonForFormat, type ProxySubscriptionFormat } from "./proxySubscription";

/** true = 能用，false = 用不了，null = 没核实。 */
export type CompatVerdict = true | false | null;

type Fact = CompatVerdict;

type ClientFacts = {
  /** 每个协议：能 / 不能 / 没核实 */
  protocols: Record<ProxyInboundProtocol, Fact>;
  /** VLESS / VMess / Trojan 上的 REALITY */
  reality: Fact;
  /** VLESS 的 xtls-rprx-vision 流控 */
  vision: Fact;
  /** Shadowsocks 2022（2022-blake3-*） */
  ss2022: Fact;
  /** 能用的 Snell 版本；空数组 = 一个都不行（或协议本身就不行） */
  snellVersions: readonly number[] | null;
  /** VLESS / VMess / Trojan 的传输层 */
  transports: Partial<Record<ProxyNodeTransport, Fact>>;
};

export type ProxyClientFamily = {
  id: string;
  /** 网格里显示的名字 */
  label: string;
  /** 面板发给它的订阅格式（决定第二层判断） */
  format: ProxySubscriptionFormat;
  /** 这家对应 PROXY_CLIENT_TARGETS 里的哪些导入目标（测试用来保证没漏掉哪家） */
  importTargets: readonly string[];
  facts: ClientFacts;
};

const Y = true;
const N = false;
const U = null;

const ALL_PROTOCOLS_YES: Record<ProxyInboundProtocol, Fact> = {
  vless: Y,
  vmess: Y,
  trojan: Y,
  shadowsocks: Y,
  hysteria2: Y,
  tuic: Y,
  anytls: Y,
  snell: Y,
  // SOCKS5 各家客户端都有，是最老的那一档。
  socks5: Y,
};

/** sing-box 内核、但走通用 Base64 订阅的客户端（Hiddify / NekoBox）。 */
const SINGBOX_CORE_VIA_LINKS: ClientFacts = {
  // AnyTLS 进 sing-box 是 1.12，这些 GUI 跟进内核的节奏不一，没核实。
  protocols: { ...ALL_PROTOCOLS_YES, anytls: U, snell: N },
  reality: Y,
  vision: Y,
  ss2022: Y,
  snellVersions: [],
  transports: { tcp: Y, ws: Y, grpc: Y, http: U, httpupgrade: U },
};

/** Xray 内核、走通用 Base64 / Xray JSON 订阅的客户端（Happ / v2RayTun / Streisand）。 */
const XRAY_CORE_VIA_LINKS: ClientFacts = {
  protocols: { ...ALL_PROTOCOLS_YES, hysteria2: U, tuic: U, anytls: U, snell: N },
  reality: Y,
  vision: Y,
  ss2022: Y,
  snellVersions: [],
  transports: { tcp: Y, ws: Y, grpc: Y, httpupgrade: Y, http: U },
};

export const PROXY_CLIENT_FAMILIES: readonly ProxyClientFamily[] = [
  {
    id: "mihomo",
    label: "Clash Verge / mihomo",
    format: "clash",
    importTargets: ["clash"],
    facts: {
      protocols: ALL_PROTOCOLS_YES,
      reality: Y,
      vision: Y,
      ss2022: Y,
      // proxySubscription.ts：mihomo 的 Snell 只到 v5。
      snellVersions: [1, 2, 3, 4, 5],
      // http（H2）：sing-box 的 http 传输带 TLS 时是 H2，订阅里写的是 network: http，
      // mihomo 那边 http 与 h2 是两种东西，没实测过能不能对上。
      transports: { tcp: Y, ws: Y, grpc: Y, httpupgrade: Y, http: U },
    },
  },
  {
    id: "clash-premium",
    label: "原版 Clash",
    format: "clash",
    importTargets: [],
    facts: {
      // TUIC：Premium 内核晚期的版本说法不一，没核实。
      protocols: { ...ALL_PROTOCOLS_YES, vless: N, hysteria2: N, tuic: U, anytls: N },
      reality: N,
      vision: N,
      ss2022: N,
      snellVersions: [1, 2, 3],
      transports: { tcp: Y, ws: Y, grpc: Y, httpupgrade: N, http: U },
    },
  },
  {
    id: "stash",
    label: "Stash",
    format: "clash",
    importTargets: ["stash"],
    facts: {
      protocols: { ...ALL_PROTOCOLS_YES, anytls: U, snell: U },
      reality: U,
      vision: U,
      ss2022: U,
      snellVersions: null,
      transports: { tcp: Y, ws: Y, grpc: Y, httpupgrade: U, http: U },
    },
  },
  {
    id: "singbox",
    label: "sing-box",
    format: "singbox",
    importTargets: ["singbox"],
    facts: {
      protocols: ALL_PROTOCOLS_YES,
      reality: Y,
      vision: Y,
      ss2022: Y,
      // v5 与 v4 线格式一致，订阅里按 v4 发（见 proxySubscription.ts）。
      snellVersions: [4, 5, 6],
      transports: { tcp: Y, ws: Y, grpc: Y, http: Y, httpupgrade: Y },
    },
  },
  {
    id: "shadowrocket",
    label: "Shadowrocket",
    format: "shadowrocket",
    importTargets: ["shadowrocket"],
    facts: {
      // Snell 没有分享链接，节点订阅（Base64）装不下。
      protocols: { ...ALL_PROTOCOLS_YES, anytls: U, snell: N },
      reality: Y,
      vision: Y,
      ss2022: Y,
      snellVersions: [],
      transports: { tcp: Y, ws: Y, grpc: Y, httpupgrade: U, http: U },
    },
  },
  {
    id: "quantumultx",
    label: "Quantumult X",
    format: "quantumultx",
    importTargets: ["quantumultx"],
    facts: {
      protocols: { ...ALL_PROTOCOLS_YES, hysteria2: N, tuic: N, anytls: N, snell: N },
      reality: N,
      vision: U,
      ss2022: U,
      snellVersions: [],
      transports: { tcp: Y, ws: Y, grpc: N, http: N, httpupgrade: N },
    },
  },
  {
    id: "surge",
    label: "Surge",
    format: "surge",
    importTargets: ["surge"],
    facts: {
      protocols: { ...ALL_PROTOCOLS_YES, vless: N },
      reality: N,
      vision: N,
      ss2022: Y,
      snellVersions: [1, 2, 3, 4, 5, 6],
      transports: { tcp: Y, ws: Y, grpc: N, http: N, httpupgrade: N },
    },
  },
  {
    id: "surfboard",
    label: "Surfboard",
    format: "surge",
    importTargets: ["surfboard"],
    facts: {
      // 读 Surge 的格式，但协议跟进得比 Surge 慢，新协议都没核实。
      protocols: { ...ALL_PROTOCOLS_YES, vless: N, hysteria2: U, tuic: U, anytls: U, snell: U },
      reality: N,
      vision: N,
      ss2022: U,
      snellVersions: null,
      transports: { tcp: Y, ws: Y, grpc: N, http: N, httpupgrade: N },
    },
  },
  {
    id: "loon",
    label: "Loon",
    format: "loon",
    importTargets: ["loon"],
    facts: {
      protocols: { ...ALL_PROTOCOLS_YES, tuic: N, snell: N },
      reality: Y,
      vision: U,
      ss2022: U,
      snellVersions: [],
      transports: { tcp: Y, ws: Y, grpc: U, http: U, httpupgrade: N },
    },
  },
  {
    id: "hiddify",
    label: "Hiddify",
    format: "base64",
    importTargets: ["hiddify"],
    facts: SINGBOX_CORE_VIA_LINKS,
  },
  {
    id: "v2rayn",
    label: "v2rayN / v2rayNG",
    format: "base64",
    importTargets: ["v2rayn", "v2rayng"],
    facts: {
      // Hysteria2 / TUIC / AnyTLS 在这两个客户端里靠另挂内核，各版本差别大，没核实。
      protocols: { ...ALL_PROTOCOLS_YES, hysteria2: U, tuic: U, anytls: U, snell: N },
      reality: Y,
      vision: Y,
      ss2022: Y,
      snellVersions: [],
      transports: { tcp: Y, ws: Y, grpc: Y, httpupgrade: Y, http: U },
    },
  },
  {
    id: "nekobox",
    label: "NekoBox / NekoRay",
    format: "base64",
    importTargets: ["nekobox", "nekoray"],
    facts: SINGBOX_CORE_VIA_LINKS,
  },
  {
    id: "karing",
    label: "Karing",
    format: "singbox",
    importTargets: ["karing"],
    // sing-box 内核，吃 sing-box 配置；AnyTLS 跟内核版本走，没核实。
    facts: { ...SINGBOX_CORE_VIA_LINKS, protocols: { ...ALL_PROTOCOLS_YES, anytls: U, snell: U }, snellVersions: null, transports: { tcp: Y, ws: Y, grpc: Y, http: Y, httpupgrade: Y } },
  },
  {
    id: "happ",
    label: "Happ",
    format: "base64",
    importTargets: ["happ"],
    // Xray 内核（和 v2rayN 一样），新版吃 Xray JSON；QUIC 系协议靠另挂内核，没核实。
    facts: XRAY_CORE_VIA_LINKS,
  },
  {
    id: "v2raytun",
    label: "v2RayTun",
    format: "base64",
    importTargets: ["v2raytun"],
    facts: XRAY_CORE_VIA_LINKS,
  },
  {
    id: "streisand",
    label: "Streisand",
    format: "base64",
    importTargets: ["streisand"],
    facts: XRAY_CORE_VIA_LINKS,
  },
];

/** 判断要用到的那几个入站字段。直接收接口返回的行（any），取不到的按默认值算。 */
export type CompatInboundInput = {
  protocol?: unknown;
  transport?: unknown;
  security?: unknown;
  flow?: unknown;
  method?: unknown;
  snellVersion?: unknown;
  obfs?: unknown;
};

export type ProxyClientCompatResult = {
  id: string;
  label: string;
  ok: CompatVerdict;
  /** 一句话原因。能用时是空串。 */
  why: string;
};

const TRANSPORT_NAMES: Record<string, string> = {
  tcp: "TCP",
  ws: "WebSocket",
  grpc: "gRPC",
  http: "HTTP/2",
  httpupgrade: "HTTPUpgrade",
  xhttp: "XHTTP",
};

function str(value: unknown): string {
  return String(value ?? "").trim();
}

function protocolLabel(protocol: string): string {
  return PROXY_NODE_PROTOCOL_LABELS[protocol as ProxyNodeProtocol] || protocol;
}

/** 一家客户端：第一层看客户端本身，第二层看订阅格式。 */
function judge(family: ProxyClientFamily, inbound: CompatInboundInput): Omit<ProxyClientCompatResult, "id" | "label"> {
  const protocol = str(inbound.protocol) as ProxyInboundProtocol;
  const transport = (str(inbound.transport) || "tcp") as ProxyNodeTransport;
  const security = str(inbound.security);
  const facts = family.facts;
  const name = family.label;
  const unknowns: string[] = [];

  const check = (fact: Fact | undefined, noWhy: string, unknownWhy: string): string => {
    if (fact === false) return noWhy;
    if (fact !== true) unknowns.push(unknownWhy);
    return "";
  };

  const protoFact = facts.protocols[protocol];
  if (protoFact === undefined) return { ok: null, why: `没核实 ${name} 对 ${protocolLabel(protocol)} 的支持` };
  let no = check(protoFact, `${name} 不支持 ${protocolLabel(protocol)}`, `${protocolLabel(protocol)} 没核实`);
  if (no) return { ok: false, why: no };

  if (security === "reality") {
    no = check(facts.reality, `${name} 不支持 REALITY`, "REALITY 没核实");
    if (no) return { ok: false, why: no };
  }
  if (protocol === "vless" && str(inbound.flow)) {
    no = check(facts.vision, `${name} 不支持 Vision 流控`, "Vision 流控没核实");
    if (no) return { ok: false, why: no };
  }
  if (protocol === "shadowsocks") {
    const method = str(inbound.method);
    if (method && !isLegacyShadowsocksMethod(method)) {
      no = check(facts.ss2022, `${name} 不支持 Shadowsocks 2022 加密`, "Shadowsocks 2022 没核实");
      if (no) return { ok: false, why: no };
    }
  }
  if (protocol === "snell") {
    const version = Number(inbound.snellVersion) || 0;
    if (facts.snellVersions && version > 0 && !facts.snellVersions.includes(version)) {
      return { ok: false, why: `${name} 不支持 Snell v${version}` };
    }
    if (!facts.snellVersions) unknowns.push(`Snell v${version || "?"} 没核实`);
  }
  // 只有 VLESS / VMess / Trojan 有传输可选；其余协议的 transport 恒为 tcp。
  if ((protocol === "vless" || protocol === "vmess" || protocol === "trojan") && transport !== "tcp") {
    const label = TRANSPORT_NAMES[transport] || transport;
    no = check(facts.transports[transport], `${name} 不支持 ${label} 传输`, `${label} 传输没核实`);
    if (no) return { ok: false, why: no };
  }
  // Quantumult X：面板给它的 Trojan 只写 over-tls，不带 WebSocket 参数（见 quantumultxNodeLine）。
  if (family.format === "quantumultx" && protocol === "trojan" && transport !== "tcp") {
    return { ok: false, why: "面板给 Quantumult X 的 Trojan 节点只带 TLS，不带传输参数" };
  }

  // 第二层：订阅格式装不装得下。原因文案来自 proxySubscription.ts，已经是一句完整的话。
  const node = createEmptyProxyNode();
  node.protocol = protocol as ProxyNodeProtocol;
  node.transport = transport;
  // 公钥只用来让判断函数知道「这是 REALITY」，内容无所谓。
  node.realityPublicKey = security === "reality" ? "reality" : "";
  node.snellVersion = Number(inbound.snellVersion) || 0;
  node.obfs = str(inbound.obfs);
  const formatReason = proxyNodeUnsupportedReasonForFormat(node, family.format);
  if (formatReason) return { ok: false, why: `订阅里不会出现：${formatReason}` };

  if (unknowns.length > 0) return { ok: null, why: `${unknowns.join("，")}，以客户端实际为准` };
  return { ok: true, why: "" };
}

export function proxyClientCompatibility(inbound: CompatInboundInput): ProxyClientCompatResult[] {
  return PROXY_CLIENT_FAMILIES.map((family) => ({ id: family.id, label: family.label, ...judge(family, inbound) }));
}

export type ProxyClientCompatSummary = {
  okCount: number;
  noCount: number;
  unknownCount: number;
  total: number;
  /** 行内小标的文字：「所有客户端」或「8/12 款客户端」 */
  label: string;
};

export function summarizeProxyClientCompatibility(results: readonly ProxyClientCompatResult[]): ProxyClientCompatSummary {
  const okCount = results.filter((item) => item.ok === true).length;
  const noCount = results.filter((item) => item.ok === false).length;
  const unknownCount = results.length - okCount - noCount;
  const total = results.length;
  return {
    okCount,
    noCount,
    unknownCount,
    total,
    label: okCount === total ? "所有客户端" : `${okCount}/${total} 款客户端`,
  };
}

/** 测试用：PROXY_CLIENT_TARGETS 里哪些导入目标没被任何一家覆盖。 */
export function uncoveredProxyClientTargets(): string[] {
  const covered = new Set(PROXY_CLIENT_FAMILIES.flatMap((family) => family.importTargets));
  return PROXY_CLIENT_TARGETS.map((target) => target.id).filter((id) => !covered.has(id));
}
