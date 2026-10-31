/*
  落地池（2.3.500）：节点池的「落地」用途。

  几台机器 + 一份落地配置（协议、端口、密钥、用户）。面板照这一份在每台成员机上开一个一模一样的
  入站（proxy_inbounds.nodePoolId，凭据逐字相同），所以客户端拿到的那一份配置连哪台都能通：

    · 订阅里整个池只出一条（池节点，proxy_nodes.nodePoolId），不是每台一条。
    · 走中转（默认）：转发、线路的落地选这个池，面板在成员里挑 / 分流 / 坏了切。
    · 直连（可选）：设一个域名，DNS 只解析到能用的成员，订阅里多一条直连。没设域名就没有直连。
    · 池里加机器 = 那台自动开上这份配置；去掉 = 那台的入站收掉；改配置、换密钥 = 每台一起改。

  这个文件是纯计算（客户端也 import）：配置的形状、第一版支持哪些协议、每台用哪个端口、首选哪台、
  DNS 写哪些值。凭据和 REALITY 密钥对由服务端生成（server/landingPools.ts），私钥不出接口。

  第一版的协议：VLESS + REALITY、Shadowsocks（含 2022）、VMess / VLESS 不加 TLS、Snell、SOCKS5。
  要证书的（TLS / 自动签证书）不做：证书是按机器、按域名的，几台共用一份配置对不上。
*/

import {
  createEmptyProxyInbound,
  isProxyInboundShadowsocksMethod,
  PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD,
  PROXY_INBOUND_SNELL_DEFAULT_VERSION,
  PROXY_INBOUND_SNELL_VERSIONS,
  proxyInboundSupportsMultiUser,
  proxyInboundUserCredentialKinds,
  validateProxyInbound,
  type ProxyInbound,
  type ProxyInboundUser,
} from "./proxyInbound";
import type { ProxyNodeTransport } from "./proxyNode";

export const LANDING_POOL_PROTOCOLS = ["vless", "vmess", "shadowsocks", "snell", "socks5"] as const;
export type LandingPoolProtocol = (typeof LANDING_POOL_PROTOCOLS)[number];

export const LANDING_POOL_PROTOCOL_LABELS: Record<LandingPoolProtocol, string> = {
  vless: "VLESS",
  vmess: "VMess",
  shadowsocks: "Shadowsocks",
  snell: "Snell",
  socks5: "SOCKS5",
};

export type LandingPoolSecurity = "reality" | "none";

/** 落地池最多几台：每台都要开入站，线路展开时一台一条路径（Agent 出站上限 8 条）。 */
export const MAX_LANDING_POOL_MEMBERS = 8;
/** 一个池最多几份凭据（手工加的 + 分享时单独发的）。 */
export const MAX_LANDING_POOL_USERS = 64;

export type LandingPoolUser = {
  /** 池里的编号，从 1 起、删了不复用：池节点按它对齐（proxy_nodes.inboundUserId）。 */
  id: number;
  name: string;
  /** vless / vmess 的 UUID；socks5 拿它当用户名。 */
  uuid: string;
  /** socks5 的密码。 */
  password: string;
  /** 分享时单独给这个人发的（收件人的用户 id）；0 = 手工加的。生死跟着分享走，界面上只读。 */
  sharedUserId: number;
};

export type LandingConfig = {
  protocol: LandingPoolProtocol;
  /** 每台成员机上听的端口。某台被占了换一个（开了域名直连时不换：那台不开，报出来）。 */
  port: number;
  transport: ProxyNodeTransport;
  security: LandingPoolSecurity;
  /** VLESS + REALITY 的流控：xtls-rprx-vision 或空。 */
  flow: string;
  /** REALITY 要偷的握手域名。 */
  serverName: string;
  /** REALITY 的握手目标（空 = serverName:443）。 */
  realityDest: string;
  realityPrivateKey: string;
  realityPublicKey: string;
  realityShortId: string;
  /** ws / http / httpupgrade 的路径，grpc 的 serviceName。 */
  path: string;
  /** ws / http / httpupgrade 的 Host。 */
  host: string;
  /** Shadowsocks 的加密方式。 */
  method: string;
  /** Shadowsocks 的密码（SS2022 是定长密钥）、Snell 的 PSK。单用户协议的凭据在这里。 */
  password: string;
  snellVersion: number;
  /** Snell v5 的混淆（none / http / tls）。 */
  obfs: string;
  /** Snell v6 的整形模式。 */
  snellMode: string;
  /** 多用户协议（VLESS / VMess / SOCKS5）的用户；单用户协议是空的。 */
  users: LandingPoolUser[];
  /** 下一个池用户的编号。 */
  nextUserId: number;
};

const REALITY_TRANSPORTS: readonly ProxyNodeTransport[] = ["tcp"];
const PLAIN_V2_TRANSPORTS: readonly ProxyNodeTransport[] = ["tcp", "ws", "grpc", "http", "httpupgrade"];

/** 这个协议在落地池里能用哪些安全层。只有 VLESS 能上 REALITY；别的都不加 TLS。 */
export function landingPoolSecurities(protocol: LandingPoolProtocol): LandingPoolSecurity[] {
  return protocol === "vless" ? ["reality", "none"] : ["none"];
}

/** 这个协议 + 安全层能用哪些传输。REALITY 只放 TCP（配 Vision 流控最稳）。 */
export function landingPoolTransports(protocol: LandingPoolProtocol, security: LandingPoolSecurity): ProxyNodeTransport[] {
  if (protocol === "vless" && security === "reality") return [...REALITY_TRANSPORTS];
  if (protocol === "vless" || protocol === "vmess") return [...PLAIN_V2_TRANSPORTS];
  return ["tcp"];
}

export function isLandingPoolProtocol(value: unknown): value is LandingPoolProtocol {
  return (LANDING_POOL_PROTOCOLS as readonly string[]).includes(String(value ?? ""));
}

/** 新建落地池的默认配置：VLESS + REALITY + Vision，443。 */
export function createDefaultLandingConfig(): LandingConfig {
  return {
    protocol: "vless",
    port: 443,
    transport: "tcp",
    security: "reality",
    flow: "xtls-rprx-vision",
    serverName: "",
    realityDest: "",
    realityPrivateKey: "",
    realityPublicKey: "",
    realityShortId: "",
    path: "",
    host: "",
    method: "",
    password: "",
    snellVersion: 0,
    obfs: "",
    snellMode: "",
    users: [],
    nextUserId: 1,
  };
}

function text(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

function intOf(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function sanitizeUser(raw: any): LandingPoolUser | null {
  if (!raw || typeof raw !== "object") return null;
  const id = intOf(raw.id, 1, 1_000_000, 0);
  if (!id) return null;
  return {
    id,
    name: text(raw.name, 64),
    uuid: text(raw.uuid, 128),
    password: text(raw.password, 256),
    sharedUserId: intOf(raw.sharedUserId, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

/** node_pools.landingJson → 配置。认不出来的一律 null（界面当「还没配」）。 */
export function parseLandingConfig(raw: unknown): LandingConfig | null {
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !isLandingPoolProtocol(parsed.protocol)) return null;
  const protocol = parsed.protocol as LandingPoolProtocol;
  const securities = landingPoolSecurities(protocol);
  const security = securities.includes(parsed.security) ? parsed.security as LandingPoolSecurity : securities[0];
  const transports = landingPoolTransports(protocol, security);
  const transport = transports.includes(parsed.transport) ? parsed.transport as ProxyNodeTransport : transports[0];
  const seen = new Set<number>();
  const users = (Array.isArray(parsed.users) ? parsed.users : [])
    .map(sanitizeUser)
    .filter((user: LandingPoolUser | null): user is LandingPoolUser => {
      if (!user || seen.has(user.id)) return false;
      seen.add(user.id);
      return true;
    })
    .slice(0, MAX_LANDING_POOL_USERS);
  const maxId = users.reduce((max: number, user: LandingPoolUser) => Math.max(max, user.id), 0);
  return {
    protocol,
    port: intOf(parsed.port, 1, 65535, 0),
    transport,
    security,
    flow: text(parsed.flow, 64),
    serverName: text(parsed.serverName, 253),
    realityDest: text(parsed.realityDest),
    realityPrivateKey: text(parsed.realityPrivateKey, 128),
    realityPublicKey: text(parsed.realityPublicKey, 128),
    realityShortId: text(parsed.realityShortId, 32),
    path: text(parsed.path, 200),
    host: text(parsed.host, 253),
    method: text(parsed.method, 64),
    password: text(parsed.password, 256),
    snellVersion: intOf(parsed.snellVersion, 0, 10, 0),
    obfs: text(parsed.obfs, 32).toLowerCase(),
    snellMode: text(parsed.snellMode, 32),
    users: proxyInboundSupportsMultiUser(protocol) ? users : [],
    nextUserId: Math.max(intOf(parsed.nextUserId, 1, 1_000_000, 1), maxId + 1),
  };
}

export function serializeLandingConfig(config: LandingConfig): string {
  return JSON.stringify(config);
}

/**
 * 池配置 → 一个入站模型（成员机上开的就是它）。users 的 id 由调用方给（成员入站自己那张用户表的行 id，
 * 0 = 新的）；不给就用池用户的编号（派生池节点时用，节点按它对齐）。
 */
export function landingConfigToInbound(
  config: LandingConfig,
  name: string,
  userIds?: ReadonlyMap<number, number>,
): ProxyInbound {
  const inbound = createEmptyProxyInbound();
  inbound.protocol = config.protocol;
  inbound.name = name;
  inbound.port = config.port;
  inbound.transport = config.transport;
  inbound.security = config.security;
  inbound.flow = config.protocol === "vless" && config.security === "reality" ? config.flow : "";
  inbound.path = config.path;
  inbound.host = config.host;
  if (config.security === "reality") {
    inbound.serverName = config.serverName;
    inbound.realityDest = config.realityDest;
    inbound.realityPrivateKey = config.realityPrivateKey;
    inbound.realityPublicKey = config.realityPublicKey;
    inbound.realityShortId = config.realityShortId;
  }
  if (config.protocol === "shadowsocks") {
    inbound.method = config.method;
    inbound.password = config.password;
  }
  if (config.protocol === "snell") {
    inbound.password = config.password;
    inbound.snellVersion = config.snellVersion;
    inbound.obfs = config.snellVersion === 6 ? "" : config.obfs;
    inbound.snellMode = config.snellVersion === 6 ? config.snellMode : "";
  }
  inbound.users = proxyInboundSupportsMultiUser(config.protocol)
    ? config.users.map((user): ProxyInboundUser => ({
      id: userIds ? Number(userIds.get(user.id) || 0) : user.id,
      name: user.name,
      uuid: user.uuid,
      password: user.password,
      sharedUserId: user.sharedUserId,
    }))
    : [];
  return inbound;
}

/**
 * 落地池配置能不能用。返回给人看的原因，空串 = 没问题。凭据要先补齐（服务端补）再校验 ——
 * 剩下的规矩（REALITY 要密钥、SS2022 的方法、Snell 只能 v5/v6、用户凭据不能重复）和单台入站是同一套。
 */
export function validateLandingConfig(config: LandingConfig): string {
  if (!isLandingPoolProtocol(config.protocol)) return "落地池第一版只支持 VLESS、VMess、Shadowsocks、Snell、SOCKS5";
  if (!(config.port >= 1 && config.port <= 65535)) return "监听端口不合法";
  if (!landingPoolSecurities(config.protocol).includes(config.security)) {
    return config.security === "reality"
      ? `${LANDING_POOL_PROTOCOL_LABELS[config.protocol]} 不能用 REALITY：落地池里只有 VLESS 能上 REALITY`
      : "落地池不做要证书的 TLS：证书是按机器、按域名签的，几台共用一份配置对不上";
  }
  if (!landingPoolTransports(config.protocol, config.security).includes(config.transport)) {
    return config.security === "reality" ? "REALITY 在落地池里只用 TCP 传输" : `${LANDING_POOL_PROTOCOL_LABELS[config.protocol]} 不支持 ${config.transport} 传输`;
  }
  if (config.protocol === "shadowsocks" && !isProxyInboundShadowsocksMethod(config.method)) {
    return `不支持的加密方式「${config.method || "空"}」`;
  }
  if (config.protocol === "snell" && !(PROXY_INBOUND_SNELL_VERSIONS as readonly number[]).includes(config.snellVersion)) {
    return `Snell 入站只支持 v${PROXY_INBOUND_SNELL_VERSIONS.join(" 和 v")}`;
  }
  if (proxyInboundSupportsMultiUser(config.protocol)) {
    const ids = new Set<number>();
    for (const user of config.users) {
      if (ids.has(user.id)) return "池里两个用户的编号重复了";
      ids.add(user.id);
    }
  }
  return validateProxyInbound(landingConfigToInbound(config, "落地池"));
}

/** 这份配置需要的凭据种类（多用户协议的每个用户）。服务端按它生成。 */
export function landingUserCredentialKinds(protocol: LandingPoolProtocol): Array<"uuid" | "password"> {
  return proxyInboundUserCredentialKinds(protocol);
}

/** 新配置该补的默认值（和单台入站的默认一致）。凭据、密钥由服务端补。 */
export function withLandingDefaults(config: LandingConfig): LandingConfig {
  const next = { ...config };
  if (next.protocol === "shadowsocks" && !isProxyInboundShadowsocksMethod(next.method)) next.method = PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD;
  if (next.protocol === "snell" && !next.snellVersion) next.snellVersion = PROXY_INBOUND_SNELL_DEFAULT_VERSION;
  if (next.protocol !== "vless" || next.security !== "reality") next.flow = "";
  if (next.security !== "reality") {
    next.serverName = "";
    next.realityDest = "";
    next.realityPrivateKey = "";
    next.realityPublicKey = "";
    next.realityShortId = "";
  }
  if (next.transport === "tcp") {
    next.path = "";
    next.host = "";
  }
  return next;
}

/**
 * 换协议、安全层、加密方式之后旧凭据不能沿用（REALITY 密钥对、SS2022 定长密钥都对不上新的形状）。
 * 返回 true 就要清空凭据重新生成 —— 每台成员一起换，客户端要重新拉订阅。
 */
export function landingConfigShapeChanged(before: LandingConfig | null, after: LandingConfig): boolean {
  if (!before) return true;
  return before.protocol !== after.protocol || before.security !== after.security || before.method !== after.method || before.snellVersion !== after.snellVersion;
}

/** 一句话说清这份配置：「VLESS · REALITY · 443」。 */
export function describeLandingConfig(config: Pick<LandingConfig, "protocol" | "security" | "port" | "transport" | "method" | "snellVersion">): string {
  const parts: string[] = [LANDING_POOL_PROTOCOL_LABELS[config.protocol] || config.protocol];
  if (config.security === "reality") parts.push("REALITY");
  if (config.transport && config.transport !== "tcp") parts.push(config.transport.toUpperCase());
  if (config.protocol === "shadowsocks" && config.method) parts.push(config.method.startsWith("2022-") ? "SS2022" : config.method);
  if (config.protocol === "snell" && config.snellVersion) parts.push(`v${config.snellVersion}`);
  parts.push(String(config.port || "—"));
  return parts.join(" · ");
}

// ---------------------------------------------------------------- 成员

/** 上次同步每台成员的结果（node_pools.landingStateJson）。 */
export type LandingMemberState = {
  hostId: number;
  /** 这台上的成员入站；0 = 没开出来（看 error）。 */
  inboundId: number;
  /** 实际听的端口；0 = 没开出来。 */
  port: number;
  /** 池的端口在这台被占了，换了一个。 */
  portFallback: boolean;
  error: string | null;
};

export function parseLandingState(raw: unknown): LandingMemberState[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object" && Number(item.hostId) > 0)
      .map((item) => ({
        hostId: Math.floor(Number(item.hostId)),
        inboundId: Math.max(0, Math.floor(Number(item.inboundId) || 0)),
        port: intOf(item.port, 0, 65535, 0),
        portFallback: item.portFallback === true,
        error: item.error ? String(item.error).slice(0, 200) : null,
      }));
  } catch {
    return [];
  }
}

export function serializeLandingState(states: readonly LandingMemberState[]): string {
  return JSON.stringify(states);
}

/**
 * 一台成员用哪个端口。纯函数，库里的占用情况由调用方查好了传进来。
 *
 *   · 池的端口在这台能用：就用它（以前换过端口的，池端口空出来了也换回来）。
 *   · 被占了、开了域名直连：不开这台 —— 域名解析到它，客户端连的是池的端口，换了端口就连不上。
 *   · 被占了、这台已经在换过的端口上跑着：接着用，不来回换（客户端走中转，面板知道它在哪个端口）。
 *   · 被占了：换一个空闲的（调用方挑好的 fallbackPort）。
 */
export function landingMemberPort(input: {
  desiredPort: number;
  /** 池端口在这台能用（不算这个成员自己）。 */
  desiredFree: boolean;
  /** 这台现在的成员入站在哪个端口（没有 = 0）。 */
  currentPort: number;
  /** 现在这个端口还能用（不算这个成员自己）。 */
  currentFree: boolean;
  /** 开了域名直连：每台必须同一个端口。 */
  requireSamePort: boolean;
  /** 调用方挑好的空闲端口；挑不出来 = 0。 */
  fallbackPort: number;
}): { port: number; fallback: boolean; error: string | null } {
  if (input.desiredFree) return { port: input.desiredPort, fallback: false, error: null };
  if (input.requireSamePort) {
    return { port: 0, fallback: false, error: `${input.desiredPort} 端口在这台被占了：开了域名直连，每台要同一个端口，这台没开` };
  }
  if (input.currentPort > 0 && input.currentPort !== input.desiredPort && input.currentFree) {
    return { port: input.currentPort, fallback: true, error: null };
  }
  if (input.fallbackPort > 0) return { port: input.fallbackPort, fallback: true, error: null };
  return { port: 0, fallback: false, error: `${input.desiredPort} 端口被占了，也挑不出空闲端口` };
}

export type LandingMemberHealth = {
  hostId: number;
  /** 成员入站开出来了、没报错。 */
  ready: boolean;
  /** 在线、不在维护。 */
  healthy: boolean;
  /** 对外地址（客户端 / 中转连它用的）。 */
  address: string;
  ipv4: string;
  port: number;
};

/**
 * 池节点用哪台的地址：池里排在前面、开出来了、在线的那台；都不在线就排最前、开出来了的那台。
 * 只用在两个地方：没设域名时池节点的地址（订阅里不出直连，只是有个地址可看）、普通转发指向的那一台。
 */
export function landingPoolPrimary(members: readonly LandingMemberHealth[]): LandingMemberHealth | null {
  return members.find((member) => member.ready && member.healthy && member.address)
    || members.find((member) => member.ready && member.address)
    || null;
}

/** 域名直连该解析到哪些 IP：开出来了、在线、和池同端口、有 IPv4 的成员。一台都没有时返回空（调用方保持原样）。 */
export function landingPoolDnsValues(members: readonly LandingMemberHealth[], port: number): string[] {
  return Array.from(new Set(members
    .filter((member) => member.ready && member.healthy && member.port === port && member.ipv4)
    .map((member) => member.ipv4)));
}

/** 池节点的名字：一份凭据就叫池名；多份时带上用户名（和单台入站派生节点同一个口径）。 */
export function landingPoolNodeName(poolName: string, user: Pick<LandingPoolUser, "name"> | null, userCount: number): string {
  const base = text(poolName, 60) || "落地池";
  const label = text(user?.name, 64);
  if (!label || userCount <= 1) return base;
  return `${base} · ${label}`;
}
