/**
 * 落地节点（入站）。
 *
 * 与 proxyNode.ts 的分工：proxyNode 描述「客户端怎么连」，本文件描述「落地机怎么听」。
 * 两边共用协议、端口、凭据，差别在于 Reality 的私钥只存在这一侧 —— 发给客户端的
 * 是公钥。面板每保存一次入站就派生一份 ProxyNode 落进 proxy_nodes，订阅那一整套
 * （中转改写、前置代理、六种渲染器）原样接上，不必再动。
 *
 * 运行时选 sing-box：它的入站覆盖我们渲染的全部八个协议（vless / vmess / trojan /
 * shadowsocks / hysteria2 / tuic / anytls / snell），出站也一样，一个二进制两头都够，
 * 不必像别家那样维护一个 Xray 分支去 cherry-pick 协议实现。
 *
 * 本文件保持纯计算：客户端也会 import 它，所以不能碰 node:crypto。Reality 密钥对
 * 由服务端生成（私钥绝不能经过浏览器），这里只接收结果。
 */

import {
  createEmptyProxyNode,
  PROXY_NODE_PROTOCOL_LABELS,
  type ProxyNode,
  type ProxyNodeProtocol,
  type ProxyNodeTransport,
} from "./proxyNode";

/** 能作为落地节点开出去的协议。与 PROXY_NODE_PROTOCOLS 一致，因为两头都由 sing-box 承担。 */
export const PROXY_INBOUND_PROTOCOLS = [
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "hysteria2",
  "tuic",
  "anytls",
  "snell",
] as const;

export type ProxyInboundProtocol = (typeof PROXY_INBOUND_PROTOCOLS)[number];

export const PROXY_INBOUND_SECURITIES = ["reality", "acme", "tls", "none"] as const;

export type ProxyInboundSecurity = (typeof PROXY_INBOUND_SECURITIES)[number];

export const PROXY_INBOUND_SECURITY_LABELS: Record<ProxyInboundSecurity, string> = {
  reality: "REALITY",
  acme: "TLS（自动签证书）",
  tls: "TLS（自备证书）",
  none: "无",
};

/**
 * 自动签证书走 sing-box 自己的 ACME，面板不实现 ACME 客户端。
 *
 * 这样证书的申请与续期都在落地机上完成，私钥一次都不经过面板 —— 面板只声明
 * 域名和邮箱。用的是 1.14 引入的 certificate.providers，不是 tls.acme：后者在
 * 1.14 已标记废弃、1.16 移除，建在上面等于给自己埋一个到点必炸的雷。
 */
export const PROXY_INBOUND_ACME_DATA_DIR = "/var/lib/forwardx-singbox/acme";

/**
 * REALITY 只能架在 TCP 上的 TLS 之上。
 *
 * Hysteria2 与 TUIC 跑在 QUIC 上，那一层没有 REALITY 的位置；Shadowsocks 与 Snell
 * 压根没有 TLS 层。AnyTLS 的服务端虽然能开 REALITY，但主流客户端（mihomo / Clash /
 * sing-box）都明说不会支持，开出来是一个没人连得上的节点，所以这里也不放行。
 */
export const PROXY_INBOUND_REALITY_PROTOCOLS: readonly ProxyInboundProtocol[] = ["vless", "vmess", "trojan"];

/** 协议自带 TLS，安全层不能选「无」。 */
const ALWAYS_TLS_PROTOCOLS: readonly ProxyInboundProtocol[] = ["trojan", "hysteria2", "tuic", "anytls"];

/** 压根没有 TLS 层的协议，安全层只能选「无」。 */
const NO_TLS_PROTOCOLS: readonly ProxyInboundProtocol[] = ["shadowsocks", "snell"];

/**
 * sing-box 的 Snell 入站只收 v5 和 v6 —— 注意这和出站不是一回事，出站收的是
 * v4 和 v6。不是笔误，是拿 1.14.0 的二进制逐个版本试出来的：
 *
 *   入站 v1/v2/v3/v4 → unsupported version
 *   出站 v5          → unsupported version
 *
 * 影响到订阅那一侧：v5 的落地渲染给 sing-box 客户端时会写成 v4（见
 * proxySubscription.ts 的 snell 分支）。这样能通，是因为 v4 与 v5 线格式一致。
 */
export const PROXY_INBOUND_SNELL_VERSIONS = [5, 6] as const;

/**
 * Shadowsocks 可选的加密方式。
 *
 * 前三种是 SS2022，后两种是老的 AEAD。两类的**密码规则完全不同**，这是这里
 * 最容易踩的坑：
 *
 *   SS2022    密码是定长的密钥，长度由算法定死（16 或 32 字节的 base64）。
 *             长度不对，sing-box 报 `bad key` 并拒绝加载**整份**配置 ——
 *             同一台机器上其他入站会跟着一起停。
 *   老 AEAD   密码是任意口令，密钥由它派生出来，多长都收（实测 7/24/44 字符
 *             都能通过 check）。
 *
 * 所以下面那张长度表只列 SS2022；老 AEAD 走普通随机口令那条路。
 */
export const PROXY_INBOUND_SHADOWSOCKS_METHODS = [
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
  "aes-128-gcm",
  "aes-256-gcm",
] as const;

export type ProxyInboundShadowsocksMethod = (typeof PROXY_INBOUND_SHADOWSOCKS_METHODS)[number];

/**
 * 定长密钥的算法及其字节数。只有 SS2022 在这里 —— 老 AEAD 的密码是口令不是密钥，
 * 给它按长度生成没有意义。查不到就表示「随便给个随机口令即可」。
 */
export const PROXY_INBOUND_SHADOWSOCKS_KEY_BYTES: Partial<Record<ProxyInboundShadowsocksMethod, number>> = {
  "2022-blake3-aes-128-gcm": 16,
  "2022-blake3-aes-256-gcm": 32,
  "2022-blake3-chacha20-poly1305": 32,
};

/** 这个算法要不要定长密钥；0 表示用普通随机口令。 */
export function proxyInboundShadowsocksKeyBytes(method: string): number {
  return PROXY_INBOUND_SHADOWSOCKS_KEY_BYTES[method as ProxyInboundShadowsocksMethod] ?? 0;
}

/** 老式 AEAD（非 SS2022）。这些有已知的主动探测手段，界面上要标出来。 */
export function isLegacyShadowsocksMethod(method: string): boolean {
  return isProxyInboundShadowsocksMethod(method) && proxyInboundShadowsocksKeyBytes(method) === 0;
}

/**
 * 默认 AES-128。
 *
 * 128 位密钥没有任何可行攻击，实际安全性不比 256 弱，但更快 —— 在没有 AES
 * 硬件加速的小机器上差得尤其明显。这也是 SS2022 作者推荐的默认。
 */
export const PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD: ProxyInboundShadowsocksMethod = "2022-blake3-aes-128-gcm";

export function isProxyInboundShadowsocksMethod(value: unknown): value is ProxyInboundShadowsocksMethod {
  return (PROXY_INBOUND_SHADOWSOCKS_METHODS as readonly string[]).includes(String(value ?? ""));
}

/** 入站默认开 v5：兼容面最广，mihomo 到 v5、Surge v1-v6 都认。 */
export const PROXY_INBOUND_SNELL_DEFAULT_VERSION = 5;

/** 这个协议能选哪些安全层。UI 用它来收窄下拉，而不是让用户选完再报错。 */
export function proxyInboundSecurities(protocol: ProxyInboundProtocol): ProxyInboundSecurity[] {
  if (NO_TLS_PROTOCOLS.includes(protocol)) return ["none"];
  const securities: ProxyInboundSecurity[] = ["acme", "tls"];
  if (PROXY_INBOUND_REALITY_PROTOCOLS.includes(protocol)) securities.unshift("reality");
  if (!ALWAYS_TLS_PROTOCOLS.includes(protocol)) securities.push("none");
  return securities;
}

/**
 * 能配多个用户（每人一份凭据）的协议。
 *
 * 这六个的「每用户凭据」与客户端字段是一对一的：uuid 或 password，各家客户端都有
 * 那个位置。另外两个刻意不做，理由是拿 sing-box 1.14.0 的真二进制验出来的：
 *
 *   Shadowsocks  SS2022 多用户要求顶层仍有服务端 PSK（少了报 missing psk），
 *                客户端密码则变成「服务端PSK:用户PSK」的组合。而 check 对
 *                「只填用户 PSK」和「填组合」两种写法都放行 —— 写错了在配置层
 *                看不出来，只在连接时失败。各家客户端怎么处理这个组合无法逐个核实。
 *   Snell        sing-box 用「共享 psk + 每用户 userkey」，而 Surge 与 mihomo 的
 *                节点配置里没有 userkey 这个位置，只有 sing-box 自己的出站有。
 *                开了多用户，除 sing-box 外的客户端都连不上。
 *
 * 与其给出一个「能保存、能下发、就是连不上」的功能，不如这两个明确只支持单用户。
 */
export const PROXY_INBOUND_MULTI_USER_PROTOCOLS: readonly ProxyInboundProtocol[] = [
  "vless",
  "vmess",
  "trojan",
  "hysteria2",
  "tuic",
  "anytls",
];

export function proxyInboundSupportsMultiUser(protocol: unknown): boolean {
  return PROXY_INBOUND_MULTI_USER_PROTOCOLS.includes(String(protocol ?? "") as ProxyInboundProtocol);
}

/**
 * 入站上的一个用户。多用户协议下凭据的唯一真相就在这里 ——
 * 入站自己的 uuid / password 只服务于单用户协议（Shadowsocks 的 PSK、Snell 的 PSK）。
 */
export type ProxyInboundUser = {
  /** 数据库行 id；0 表示还没存过。派生节点靠它跟用户对齐。 */
  id: number;
  /** 给人看的标签，会拼进派生出来的节点名，例如「HK 落地 · 小王」。 */
  name: string;
  /** vless / vmess / tuic 用 */
  uuid: string;
  /** trojan / hysteria2 / tuic / anytls 用 */
  password: string;
  /**
   * 这份凭据是为哪个面板用户单独发的（分享时自动开的），0 = 手工加的。
   *
   * 界面据此把它标成只读：它的生死跟着分享走，在入站弹窗里删掉它并不会取消
   * 分享，只会让对方莫名其妙连不上。
   */
  sharedUserId?: number;
};

export function createEmptyProxyInboundUser(): ProxyInboundUser {
  return { id: 0, name: "", uuid: "", password: "", sharedUserId: 0 };
}

/** 这个协议的每用户凭据是哪一种。决定要生成 UUID 还是密码。 */
export function proxyInboundUserCredentialKinds(protocol: ProxyInboundProtocol): Array<"uuid" | "password"> {
  if (protocol === "vless" || protocol === "vmess") return ["uuid"];
  if (protocol === "tuic") return ["uuid", "password"];
  if (proxyInboundSupportsMultiUser(protocol)) return ["password"];
  return [];
}

/** 需要真证书的安全层。REALITY 不在其列 —— 它正是拿来绕开证书的。 */
export function proxyInboundNeedsCertificate(security: ProxyInboundSecurity): boolean {
  return security === "tls" || security === "acme";
}

/**
 * 这个协议能选哪些传输。QUIC 系与裸 TCP 系都没有传输层可选。
 *
 * 注意没有 xhttp：那是 Xray 的传输，sing-box 不实现，所以我们开不出这样的落地。
 * 订阅渲染那一侧仍然支持 XHTTP —— 用户从别处拿到的 XHTTP 节点照常能粘进来、能中转。
 * 「能转发」和「能自建」是两件事，这里只管后者。
 */
export function proxyInboundTransports(protocol: ProxyInboundProtocol): ProxyNodeTransport[] {
  if (protocol === "vless" || protocol === "vmess" || protocol === "trojan") {
    // httpupgrade 比 ws 少一次握手往返，过 CDN 时更省事；sing-box 两端都支持。
    return ["tcp", "ws", "grpc", "http", "httpupgrade"];
  }
  // shadowsocks / snell / hysteria2 / tuic / anytls 都只有一种承载。
  return ["tcp"];
}

export type ProxyInbound = {
  protocol: ProxyInboundProtocol;
  /** 面板里的名字，也会成为派生节点的默认名。 */
  name: string;
  /** 落地机上的监听端口。 */
  port: number;
  transport: ProxyNodeTransport;
  security: ProxyInboundSecurity;
  /** vless / vmess / tuic 的用户 ID */
  uuid: string;
  /** trojan / shadowsocks / hysteria2 / tuic / anytls 的密码，以及 snell 的 psk */
  password: string;
  /** shadowsocks 的加密方式 */
  method: string;
  /** vless 的流控，例如 xtls-rprx-vision */
  flow: string;
  /** ws / http 的路径，grpc 时是 serviceName */
  path: string;
  /** ws / http 的 Host */
  host: string;
  /** XHTTP 的 mode：auto / stream-one / stream-up / packet-up */
  xhttpMode: string;
  /** TLS 的服务器名。security=reality 时同时是要偷的握手域名。 */
  serverName: string;
  alpn: string[];
  /** security=tls 时的证书路径，落地机本地路径。 */
  certPath: string;
  keyPath: string;
  /** security=acme 时用来注册 ACME 账户的邮箱。到期提醒会发到这里。 */
  acmeEmail: string;
  /** REALITY：私钥只在服务端，公钥才发给客户端。 */
  realityPrivateKey: string;
  realityPublicKey: string;
  realityShortId: string;
  /**
   * REALITY 的握手目标，形如 `dl.google.com:443`。
   * 留空时按 serverName:443 推导 —— 绝大多数情况这两者本来就该一致。
   */
  realityDest: string;
  /** Hysteria2 的混淆：salamander，空表示不混淆 */
  obfs: string;
  obfsPassword: string;
  /** Hysteria2 向客户端声明的带宽（Mbps），0 表示不限制 */
  upMbps: number;
  downMbps: number;
  /** TUIC 的拥塞控制：cubic / new_reno / bbr */
  congestionControl: string;
  /**
   * 入站上的用户。多用户协议下这里是凭据的唯一真相，一个用户派生一个客户端节点。
   * 单用户协议（Shadowsocks / Snell）不用它，凭据在入站自己的 password 上。
   */
  users: ProxyInboundUser[];
  /** Snell 的版本与 v6 的整形模式。入站只能是 5 或 6，见 PROXY_INBOUND_SNELL_VERSIONS。 */
  snellVersion: number;
  snellMode: string;
};

export function createEmptyProxyInbound(): ProxyInbound {
  return {
    protocol: "vless",
    name: "",
    port: 0,
    transport: "tcp",
    security: "reality",
    uuid: "",
    password: "",
    method: "",
    flow: "",
    path: "",
    host: "",
    xhttpMode: "",
    serverName: "",
    alpn: [],
    certPath: "",
    keyPath: "",
    acmeEmail: "",
    realityPrivateKey: "",
    realityPublicKey: "",
    realityShortId: "",
    realityDest: "",
    obfs: "",
    obfsPassword: "",
    upMbps: 0,
    downMbps: 0,
    congestionControl: "",
    users: [],
    snellVersion: 0,
    snellMode: "",
  };
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function toPort(value: unknown): number {
  const port = Number(text(value));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

/** REALITY 的 short-id 是 0 到 8 字节的十六进制，也就是最多 16 个字符且长度为偶数。 */
export function isValidRealityShortId(value: unknown): boolean {
  const raw = text(value);
  if (!raw) return true;
  return raw.length <= 16 && raw.length % 2 === 0 && /^[0-9a-f]+$/i.test(raw);
}

/**
 * 这些字段原样写进 sing-box 配置，sing-box 对不认识的取值是拒绝加载**整份**配置 ——
 * 同一台落地机上别人的入站跟着一起停。所以只收下面这些已知取值（空串表示不设置）。
 */
export const PROXY_INBOUND_VLESS_FLOWS = ["xtls-rprx-vision"] as const;
export const PROXY_INBOUND_HYSTERIA2_OBFS = ["salamander"] as const;
export const PROXY_INBOUND_SNELL_OBFS = ["none", "http", "tls"] as const;
export const PROXY_INBOUND_TUIC_CONGESTION_CONTROLS = ["cubic", "new_reno", "bbr"] as const;
export const PROXY_INBOUND_SNELL_V6_MODES = ["default", "unshaped", "unsafe-raw"] as const;

function enumFieldError(value: unknown, allowed: readonly string[], field: string): string {
  const raw = text(value);
  if (!raw || allowed.includes(raw)) return "";
  return `不支持的${field}「${raw.slice(0, 32)}」，只能是 ${allowed.join(" / ")} 或留空`;
}

/**
 * 只看会原样进 sing-box 配置的枚举字段，按协议取实际会用到的那几个。
 * 面板合成整台机器的配置时也用它把坏入站单独剔掉，而不是让整份配置校验失败。
 */
export function proxyInboundEnumFieldError(inbound: ProxyInbound): string {
  if (inbound.protocol === "vless") {
    return enumFieldError(inbound.flow, PROXY_INBOUND_VLESS_FLOWS, "流控");
  }
  if (inbound.protocol === "hysteria2") {
    return enumFieldError(inbound.obfs, PROXY_INBOUND_HYSTERIA2_OBFS, "混淆方式");
  }
  if (inbound.protocol === "tuic") {
    return enumFieldError(inbound.congestionControl, PROXY_INBOUND_TUIC_CONGESTION_CONTROLS, "拥塞控制");
  }
  if (inbound.protocol === "snell") {
    if (Number(inbound.snellVersion) === 6) {
      return enumFieldError(inbound.snellMode, PROXY_INBOUND_SNELL_V6_MODES, "Snell v6 整形模式");
    }
    return enumFieldError(inbound.obfs, PROXY_INBOUND_SNELL_OBFS, "Snell 混淆方式");
  }
  return "";
}

/**
 * 校验入站配置。返回可直接展示给用户的中文原因，空串表示没问题。
 *
 * 这里挡住的都是「存得下去、但开出来连不上」的组合 —— 那类问题在客户端只表现为
 * 一句连接失败，看不出是配置本身不成立。
 */
export function validateProxyInbound(inbound: ProxyInbound): string {
  const label = PROXY_NODE_PROTOCOL_LABELS[inbound.protocol as ProxyNodeProtocol] || inbound.protocol;
  if (!toPort(inbound.port)) return "监听端口不合法";

  if (!proxyInboundSecurities(inbound.protocol).includes(inbound.security)) {
    if (inbound.security === "reality") {
      return `${label} 不能用 REALITY —— REALITY 只能架在 TCP 的 TLS 之上`;
    }
    if (inbound.security === "none") return `${label} 自带 TLS，安全层不能选「无」`;
    return `${label} 没有 TLS 层，安全层只能选「无」`;
  }

  if (!proxyInboundTransports(inbound.protocol).includes(inbound.transport)) {
    if (inbound.transport === "xhttp") {
      return "XHTTP 是 Xray 的传输，sing-box 开不出这样的落地；从别处拿到的 XHTTP 节点仍然可以粘进来中转";
    }
    return `${label} 不支持 ${inbound.transport} 传输`;
  }

  // 凭据：缺了就是一个谁都连不上的节点。
  if (proxyInboundSupportsMultiUser(inbound.protocol)) {
    if (inbound.users.length === 0) return "至少要有一个用户";
    const kinds = proxyInboundUserCredentialKinds(inbound.protocol);
    const seen = new Set<string>();
    for (const user of inbound.users) {
      const who = text(user.name) || "未命名用户";
      for (const kind of kinds) {
        const value = kind === "uuid" ? text(user.uuid) : text(user.password);
        if (!value) return `用户「${who}」缺少${kind === "uuid" ? " UUID" : "密码"}`;
      }
      /**
       * 同一个入站里凭据不能重复。重了的后果不是报错，而是两个人共用一条身份 ——
       * 吊销其中一个会把另一个也踢下线，而界面上两行看着是独立的。
       */
      const key = kinds.map((kind) => (kind === "uuid" ? text(user.uuid) : text(user.password))).join("|");
      if (seen.has(key)) return `用户「${who}」的凭据和另一个用户重复了`;
      seen.add(key);
    }
  } else {
    if (!text(inbound.password)) return inbound.protocol === "snell" ? "缺少 PSK" : "缺少密码";
    if (inbound.protocol === "shadowsocks") {
      if (!text(inbound.method)) return "缺少加密方式";
      /**
       * 认不出来的加密方式挡在这里，而不是让它走到落地机上去。
       * sing-box 对不认识的 method 是拒绝加载整份配置 —— 同一台机器上其他入站
       * 会跟着一起停，而报错跟「你刚改了加密方式」看不出关联。
       */
      if (!isProxyInboundShadowsocksMethod(inbound.method)) {
        return `不支持的加密方式「${text(inbound.method)}」，只能用 SS2022 的那三种`;
      }
    }
  }

  if (inbound.security === "reality") {
    if (!text(inbound.realityPrivateKey)) return "缺少 REALITY 私钥";
    if (!text(inbound.realityPublicKey)) return "缺少 REALITY 公钥";
    if (!text(inbound.serverName)) return "REALITY 需要一个要偷的握手域名";
    if (!isValidRealityShortId(inbound.realityShortId)) {
      return "REALITY 的 short-id 只能是 0 到 8 字节的十六进制（最多 16 个字符，且长度为偶数）";
    }
  }
  if (inbound.security === "tls" && (!text(inbound.certPath) || !text(inbound.keyPath))) {
    return "TLS 需要证书和私钥的路径";
  }
  if (inbound.security === "acme") {
    if (!text(inbound.serverName)) return "自动签证书需要一个解析到这台落地机的域名";
    if (!text(inbound.acmeEmail)) return "自动签证书需要一个邮箱，用来注册 ACME 账户";
    /**
     * 域名必须是真域名：IP 签不出证书，而 ACME 失败在客户端只表现为握手失败。
     *
     * 顶级标签要求含字母 —— 只写「点分标签」的话 1.2.3.4 也能匹配上，因为标签
     * 本来就允许数字。真实顶级域一律含字母（punycode 的 xn-- 也含）。
     */
    const domain = text(inbound.serverName);
    const labelOk = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain);
    const tldHasLetter = /[a-z]/i.test(domain.slice(domain.lastIndexOf(".") + 1));
    if (!labelOk || !tldHasLetter) {
      return "自动签证书的域名看起来不是一个合法域名（不能填 IP）";
    }
  }
  if (inbound.protocol === "snell") {
    const version = Number(inbound.snellVersion) || 0;
    if (!(PROXY_INBOUND_SNELL_VERSIONS as readonly number[]).includes(version)) {
      // 放行 v4 的后果不是「这个节点连不上」，而是整份配置解析失败 ——
      // sing-box 会拒绝加载，同一台落地机上其他入站跟着一起停。
      return `sing-box 的 Snell 入站只支持 v${PROXY_INBOUND_SNELL_VERSIONS.join(" 和 v")}，这个是 v${version || "?"}`;
    }
  }
  const enumError = proxyInboundEnumFieldError(inbound);
  if (enumError) return enumError;
  return "";
}

/** REALITY 的握手目标：显式填了就用，否则按握手域名的 443 推导。 */
export function proxyInboundRealityDest(inbound: ProxyInbound): { server: string; port: number } {
  const raw = text(inbound.realityDest) || `${text(inbound.serverName)}:443`;
  const colon = raw.lastIndexOf(":");
  if (colon <= 0) return { server: raw, port: 443 };
  return { server: raw.slice(0, colon), port: toPort(raw.slice(colon + 1)) || 443 };
}

/**
 * 这个入站用的 ACME 证书提供者 tag。
 *
 * 按域名去重：同一个域名上的多个入站共用一张证书，既省一次签发，也避开
 * Let's Encrypt 按域名算的签发频率限制 —— 每个入站各签一次很容易撞上。
 */
export function proxyInboundAcmeTag(inbound: ProxyInbound): string {
  return `acme-${text(inbound.serverName).toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
}

function singboxServerTls(inbound: ProxyInbound): Record<string, unknown> | null {
  if (inbound.security === "none") return null;
  const tls: Record<string, unknown> = { enabled: true };
  if (inbound.serverName) tls.server_name = inbound.serverName;
  if (inbound.alpn.length) tls.alpn = [...inbound.alpn];
  if (inbound.security === "acme") {
    // 指向 certificate.providers 里的那一条。buildSingboxConfig 保证它一定存在 ——
    // sing-box 的 check 查不出悬空引用，那样只会在握手时才失败。
    tls.certificate_provider = proxyInboundAcmeTag(inbound);
    return tls;
  }
  if (inbound.security === "reality") {
    const dest = proxyInboundRealityDest(inbound);
    tls.reality = {
      enabled: true,
      handshake: { server: dest.server, server_port: dest.port },
      private_key: inbound.realityPrivateKey,
      // short_id 是数组，且允许空串 —— 空串表示不校验 short-id。
      short_id: [text(inbound.realityShortId)],
    };
  } else {
    tls.certificate_path = inbound.certPath;
    tls.key_path = inbound.keyPath;
  }
  return tls;
}

function singboxTransport(inbound: ProxyInbound): Record<string, unknown> | null {
  if (inbound.transport === "ws") {
    return {
      type: "ws",
      ...(inbound.path ? { path: inbound.path } : {}),
      ...(inbound.host ? { headers: { Host: inbound.host } } : {}),
    };
  }
  if (inbound.transport === "grpc") {
    return { type: "grpc", ...(inbound.path ? { service_name: inbound.path } : {}) };
  }
  if (inbound.transport === "http") {
    return {
      type: "http",
      ...(inbound.path ? { path: inbound.path } : {}),
      ...(inbound.host ? { host: [inbound.host] } : {}),
    };
  }
  if (inbound.transport === "httpupgrade") {
    // 注意 host 是单个字符串，不是 http 那样的数组 —— 写成数组 sing-box 直接拒配置。
    return {
      type: "httpupgrade",
      ...(inbound.path ? { path: inbound.path } : {}),
      ...(inbound.host ? { host: inbound.host } : {}),
    };
  }
  // tcp 没有传输块。xhttp 走不到这里 —— validateProxyInbound 已经挡在前面了。
  return null;
}

/** sing-box 日志里的用户标识，不参与鉴权。行 id 保证唯一，改名不影响它。 */
function singboxUserName(user: ProxyInboundUser, index: number): string {
  return user.id > 0 ? `u${user.id}` : `u-${index + 1}`;
}

/** 把入站上的用户摊成 sing-box 的 users 数组，凭据部分按协议由调用方给出。 */
function singboxUsers(
  inbound: ProxyInbound,
  credential: (user: ProxyInboundUser) => Record<string, unknown>,
): Record<string, unknown>[] {
  return inbound.users.map((user, index) => ({
    name: singboxUserName(user, index),
    ...credential(user),
  }));
}

/**
 * 生成一个 sing-box 入站。
 *
 * 字段名严格按官方入站文档，各协议不通用：Snell 的 psk 在顶层而不是 users 里，
 * Shadowsocks 的 method 与 password 也在顶层，其余协议都是 users 数组。
 */
export function buildSingboxInbound(inbound: ProxyInbound, tag: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: inbound.protocol,
    tag,
    listen: "::",
    listen_port: inbound.port,
  };

  if (inbound.protocol === "vless") {
    base.users = singboxUsers(inbound, (user) => ({
      uuid: user.uuid,
      // flow 是入站级的：同一个入站上让不同人用不同流控没有实际用途，
      // 只会多出一种「两个人里只有一个连得上」的排查场面。
      ...(inbound.flow ? { flow: inbound.flow } : {}),
    }));
  } else if (inbound.protocol === "vmess") {
    base.users = singboxUsers(inbound, (user) => ({ uuid: user.uuid }));
  } else if (inbound.protocol === "trojan") {
    base.users = singboxUsers(inbound, (user) => ({ password: user.password }));
  } else if (inbound.protocol === "shadowsocks") {
    // 单用户形态：method 与 password 都在顶层，没有 users 数组。
    base.method = inbound.method;
    base.password = inbound.password;
  } else if (inbound.protocol === "hysteria2") {
    base.users = singboxUsers(inbound, (user) => ({ password: user.password }));
    if (inbound.obfs) {
      base.obfs = { type: inbound.obfs, ...(inbound.obfsPassword ? { password: inbound.obfsPassword } : {}) };
    }
    if (inbound.upMbps > 0) base.up_mbps = inbound.upMbps;
    if (inbound.downMbps > 0) base.down_mbps = inbound.downMbps;
  } else if (inbound.protocol === "tuic") {
    base.users = singboxUsers(inbound, (user) => ({ uuid: user.uuid, password: user.password }));
    if (inbound.congestionControl) base.congestion_control = inbound.congestionControl;
  } else if (inbound.protocol === "anytls") {
    base.users = singboxUsers(inbound, (user) => ({ password: user.password }));
  } else {
    // Snell：psk 在顶层，版本决定是 obfs_mode 还是 mode。
    base.version = inbound.snellVersion || PROXY_INBOUND_SNELL_DEFAULT_VERSION;
    base.psk = inbound.password;
    if (inbound.snellVersion === 6) {
      if (inbound.snellMode) base.mode = inbound.snellMode;
    } else if (inbound.obfs && inbound.obfs !== "none") {
      base.obfs_mode = inbound.obfs;
    }
  }

  const tls = singboxServerTls(inbound);
  if (tls) base.tls = tls;
  const transport = singboxTransport(inbound);
  if (transport) base.transport = transport;
  return base;
}

/**
 * 这一批入站需要的 ACME 证书提供者。
 *
 * 与入站一起生成而不是分开配置：引用与被引用方同源，就不可能出现「入站指向一个
 * 不存在的 provider」——sing-box 的 check 查不出那种悬空引用，配置照样通过、服务
 * 照样起来，只在客户端握手时失败，又是一次看不出原因的连接失败。
 */
export function buildSingboxCertificateProviders(
  inbounds: readonly { inbound: ProxyInbound }[],
): Record<string, unknown>[] {
  const byTag = new Map<string, Record<string, unknown>>();
  for (const { inbound } of inbounds) {
    if (inbound.security !== "acme") continue;
    const tag = proxyInboundAcmeTag(inbound);
    if (byTag.has(tag)) continue;
    byTag.set(tag, {
      type: "acme",
      tag,
      domain: [inbound.serverName],
      email: inbound.acmeEmail,
      data_directory: PROXY_INBOUND_ACME_DATA_DIR,
    });
  }
  return Array.from(byTag.values());
}

/** 落地机上一份完整的 sing-box 配置。入站由面板下发，出站固定直连。 */
export function buildSingboxConfig(inbounds: readonly { inbound: ProxyInbound; tag: string }[]): string {
  const providers = buildSingboxCertificateProviders(inbounds);
  const config = {
    log: { level: "warn", timestamp: true },
    ...(providers.length > 0 ? { certificate: { providers } } : {}),
    inbounds: inbounds.map((item) => buildSingboxInbound(item.inbound, item.tag)),
    // 落地机的职责就是把流量放出去，不做分流。
    outbounds: [{ type: "direct", tag: "direct" }],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * 派生节点的名字。
 *
 * 只有一个用户时不加后缀 —— 「HK 落地 · 默认」这种噪音没有信息量。用户有名字才拼，
 * 因为订阅里的节点名是用户唯一能分辨「这条是谁的」的东西。
 */
export function proxyInboundNodeName(inbound: ProxyInbound, user?: ProxyInboundUser): string {
  const base = text(inbound.name);
  const label = text(user?.name);
  if (!label || inbound.users.length <= 1) return base;
  return base ? `${base} · ${label}` : label;
}

/**
 * 一个入站派生出的全部客户端节点：多用户协议下一个用户一条，单用户协议下一条。
 *
 * 返回里带上 user 是给调用方对齐用的 —— 派生节点要按用户增删，光有节点数组的话
 * 没法知道哪一条对应哪个用户，用户删掉之后就会留下一个连不上的孤儿节点。
 */
export function proxyNodesFromInbound(
  inbound: ProxyInbound,
  options: ProxyNodeFromInboundOptions,
): Array<{ user: ProxyInboundUser | null; node: ProxyNode }> {
  if (!proxyInboundSupportsMultiUser(inbound.protocol)) {
    return [{ user: null, node: proxyNodeFromInbound(inbound, options) }];
  }
  return inbound.users.map((user) => ({
    user,
    node: proxyNodeFromInbound(inbound, { ...options, name: "" }, user),
  }));
}

export type ProxyNodeFromInboundOptions = {
  /** 落地机的公网地址。入站自己只知道监听地址（::），不知道对外是哪个 IP。 */
  address: string;
  /** 节点名，留空时用入站的名字。 */
  name?: string;
};

/**
 * 从入站派生出客户端节点。
 *
 * 这是「服务端配置」到「客户端配置」的唯一转换点：私钥留在入站侧，客户端拿到的是
 * 公钥。派生结果直接存进 proxy_nodes，之后中转改写与订阅渲染都走既有那一套。
 */
export function proxyNodeFromInbound(
  inbound: ProxyInbound,
  options: ProxyNodeFromInboundOptions,
  user?: ProxyInboundUser,
): ProxyNode {
  /**
   * 没显式给用户时，多用户协议取第一个 —— 这个函数的单数形态仍然要可用（预览、
   * 只有一个用户的常见情形）。取不到就是一份没有凭据的节点，由 validateProxyInbound
   * 在保存前拦住。
   */
  const target = user ?? (proxyInboundSupportsMultiUser(inbound.protocol) ? inbound.users[0] : undefined);
  const node = createEmptyProxyNode();
  node.protocol = inbound.protocol as ProxyNodeProtocol;
  node.name = text(options.name) || proxyInboundNodeName(inbound, target);
  node.address = text(options.address);
  node.port = inbound.port;
  // 多用户协议下凭据来自用户；单用户协议（Shadowsocks / Snell）来自入站本身。
  node.uuid = target ? text(target.uuid) : inbound.uuid;
  node.password = target ? text(target.password) : inbound.password;
  node.method = inbound.method;
  node.flow = inbound.flow;
  node.transport = inbound.transport;
  node.path = inbound.path;
  node.host = inbound.host;
  node.xhttpMode = inbound.xhttpMode;
  node.tls = inbound.security !== "none";
  // 自动签的是公信证书，客户端不必跳过校验；自备证书那条路由用户自己保证。
  if (inbound.security === "acme") node.allowInsecure = false;
  node.sni = inbound.serverName;
  node.alpn = [...inbound.alpn];
  node.obfs = inbound.obfs;
  node.obfsPassword = inbound.obfsPassword;
  // 入站上声明的带宽就是客户端该按的速率：Hysteria2 的 Brutal 靠客户端报的这个
  // 数发包，不带过去客户端就只能退回 BBR，跨境丢包一重单连接就起不来。
  if (inbound.protocol === "hysteria2") {
    node.upMbps = Math.max(0, Math.floor(Number(inbound.upMbps) || 0));
    node.downMbps = Math.max(0, Math.floor(Number(inbound.downMbps) || 0));
  }
  node.congestionControl = inbound.congestionControl;
  node.snellVersion = inbound.snellVersion;
  node.snellMode = inbound.snellMode;
  if (inbound.security === "reality") {
    node.realityPublicKey = inbound.realityPublicKey;
    node.realityShortId = inbound.realityShortId;
    // REALITY 靠 uTLS 伪装成浏览器握手，指纹不填的话客户端行为不一致。
    node.fingerprint = "chrome";
  }
  return node;
}
