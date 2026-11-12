import { isAgentVersionAtLeast } from "./version";
import { normalizeForwardXVersion } from "./forwardTypes";

/*
  NEX V3：FXP 的 V3 传输（移植自上游 ForwardX，见 forwardx-fxp/internal/v3/PROTOCOL.md）。

  V1 是 TCP 上直接跑 FXP 加密帧，V3 把每一跳的 TCP 承载换成「HTTP 样式 / WS 样式 / TLS」外层，
  里面一层独立的认证加密记录层，可选多条业务连接共用一条物理连接。适合 V1 的特征被识别、
  限速或阻断的线路。UDP 直连不经过外层，和 V1 一样。

  两端（以及中转）的 FXP 都要认识 v3：老 FXP 不认识 v3，会把它当 V1 跑，和新的一端谁也连
  不上谁。所以保存时就核对隧道上每台机器的 Agent / FXP 版本（和抗丢包传输一样）。
  这两个版本是第一版带 V3 的 Agent / FXP，以后升版本号不用跟着改。
*/
export const FORWARDX_V3_MIN_AGENT_VERSION = "2.2.257";
export const FORWARDX_V3_MIN_FXP_VERSION = "2.2.141";

export const FORWARDX_V3_TRANSPORTS = ["http", "ws", "tls"] as const;
export type ForwardXV3Transport = (typeof FORWARDX_V3_TRANSPORTS)[number];

export const FORWARDX_V3_TRANSPORT_LABELS: Record<ForwardXV3Transport, string> = {
  http: "HTTP",
  ws: "WebSocket",
  tls: "TLS",
};

/** 默认外层：TLS（外面看是一条普通的 TLS 连接，证书公钥由隧道密钥派生、两端钉死）。 */
export const FORWARDX_V3_DEFAULT_TRANSPORT: ForwardXV3Transport = "tls";
/**
 * 默认不复用：每条业务连接一条自己的 TCP（建连的往返由预热连接池在后台做完），一条卡住不影响
 * 别的。复用时窗口会按线路自动放大（最大 32 MiB），高延迟线路上单连接也跑得起来，但所有连接
 * 挤在一条 TCP 上，一个丢包大家一起等。丢包线路上的实测（forwardx-fxp/internal/v3/BENCHMARKS.md
 * 「丢包 + 高延迟线路」）：不复用的吞吐和交互延迟都和 V1 一样；复用在丢包时交互延迟高一截，
 * 所以默认仍然不复用。
 */
export const FORWARDX_V3_DEFAULT_MULTIPLEX = false;

export const FORWARDX_V3_HOST_MAX = 253;
export const FORWARDX_V3_PATH_MAX = 1024;
export const FORWARDX_V3_USER_AGENT_MAX = 512;
export const FORWARDX_V3_SERVER_NAME_MAX = 253;

export type ForwardXV3Options = {
  v3Transport: ForwardXV3Transport;
  v3Host: string;
  v3Path: string;
  v3UserAgent: string;
  v3ServerName: string;
  v3Multiplex: boolean;
};

export function normalizeForwardXV3Transport(value: unknown): ForwardXV3Transport | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (FORWARDX_V3_TRANSPORTS as readonly string[]).includes(normalized) ? normalized as ForwardXV3Transport : undefined;
}

/** 数据库里布尔值可能是 true / 1 / "1" / "true"；没存过（null）按默认。 */
export function normalizeForwardXV3Multiplex(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return FORWARDX_V3_DEFAULT_MULTIPLEX;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return FORWARDX_V3_DEFAULT_MULTIPLEX;
}

/** 隧道行（或表单）上的 V3 选项，去掉首尾空白、补默认值。路径没写按 /。 */
export function normalizeForwardXV3Options(input: Record<string, unknown> | null | undefined): ForwardXV3Options {
  const v3Transport = normalizeForwardXV3Transport(input?.v3Transport) || FORWARDX_V3_DEFAULT_TRANSPORT;
  let v3Path = String(input?.v3Path ?? "").trim();
  if (v3Path && !v3Path.startsWith("/")) v3Path = `/${v3Path}`;
  return {
    v3Transport,
    v3Host: v3Transport === "tls" ? "" : String(input?.v3Host ?? "").trim(),
    v3Path: v3Transport === "tls" ? "" : v3Path,
    v3UserAgent: v3Transport === "tls" ? "" : String(input?.v3UserAgent ?? "").trim(),
    v3ServerName: v3Transport === "tls" ? String(input?.v3ServerName ?? "").trim() : "",
    v3Multiplex: normalizeForwardXV3Multiplex(input?.v3Multiplex),
  };
}

// 换行、制表符、NUL 会注入 HTTP 请求头；Host 和路径里也不该有空格。FXP 自己也会拒。
const HEADER_CONTROL = /[\u0000-\u001f\u007f]/;

/** 选项写得对不对，不对时给出原因（中文，直接给用户看）。空字符串表示没问题。 */
export function forwardXV3OptionsError(raw: Record<string, unknown> | null | undefined): string {
  const transport = String(raw?.v3Transport ?? "").trim();
  if (transport && !normalizeForwardXV3Transport(transport)) return "NEX V3 的外层只能选 HTTP、WebSocket 或 TLS";
  const options = normalizeForwardXV3Options(raw);
  if (options.v3Transport === "tls") {
    if (options.v3ServerName.length > FORWARDX_V3_SERVER_NAME_MAX) return `TLS 服务器名称（SNI）最长 ${FORWARDX_V3_SERVER_NAME_MAX} 个字符`;
    if (options.v3ServerName && !/^[A-Za-z0-9.-]+$/.test(options.v3ServerName)) return "TLS 服务器名称（SNI）只能是域名（字母、数字、点和连字符）";
    return "";
  }
  if (options.v3Host.length > FORWARDX_V3_HOST_MAX) return `Host 最长 ${FORWARDX_V3_HOST_MAX} 个字符`;
  if (options.v3Host && (HEADER_CONTROL.test(options.v3Host) || /\s/.test(options.v3Host))) return "Host 里不能有空格、换行这类字符";
  if (options.v3Path.length > FORWARDX_V3_PATH_MAX) return `路径最长 ${FORWARDX_V3_PATH_MAX} 个字符`;
  if (HEADER_CONTROL.test(options.v3Path) || /\s/.test(options.v3Path)) return "路径里不能有空格、换行这类字符";
  if (options.v3UserAgent.length > FORWARDX_V3_USER_AGENT_MAX) return `User-Agent 最长 ${FORWARDX_V3_USER_AGENT_MAX} 个字符`;
  if (HEADER_CONTROL.test(options.v3UserAgent)) return "User-Agent 里不能有换行这类字符";
  return "";
}

/**
 * 写进隧道行的 V3 外层选项：只有 NEX V3 隧道存，其余模式 / 版本一律清空（旧值不留在库里，
 * 免得以后切回 V3 时带出意料之外的设置）。选项写得不对直接抛中文原因。
 */
export function forwardXV3TunnelPatch(source: Record<string, unknown> | null | undefined, mode: unknown, forwardxVersion: unknown) {
  if (String(mode || "").trim().toLowerCase() !== "forwardx" || normalizeForwardXVersion(forwardxVersion) !== "v3") {
    return { v3Transport: null, v3Host: null, v3Path: null, v3UserAgent: null, v3ServerName: null, v3Multiplex: false };
  }
  const error = forwardXV3OptionsError(source);
  if (error) throw new Error(error);
  const options = normalizeForwardXV3Options(source);
  return {
    v3Transport: options.v3Transport as ForwardXV3Transport | null,
    v3Host: options.v3Host || null,
    v3Path: options.v3Path || null,
    v3UserAgent: options.v3UserAgent || null,
    v3ServerName: options.v3ServerName || null,
    v3Multiplex: options.v3Multiplex,
  };
}

export function isForwardXV3Tunnel(tunnel: unknown) {
  const row = tunnel as { mode?: unknown; forwardxVersion?: unknown } | null | undefined;
  return String(row?.mode || "").trim().toLowerCase() === "forwardx"
    && normalizeForwardXVersion(row?.forwardxVersion) === "v3";
}

/**
 * 下发给 FXP 的 V3 字段（只给 V3 隧道）。空的可选项不写，FXP 按自己的默认来；多路复用总是
 * 显式写（FXP 没写时按开，面板的默认是关）。
 */
export function forwardXV3SpecFields(tunnel: unknown) {
  if (!isForwardXV3Tunnel(tunnel)) return null;
  const options = normalizeForwardXV3Options(tunnel as Record<string, unknown>);
  return {
    v3Transport: options.v3Transport,
    ...(options.v3Host ? { v3Host: options.v3Host } : {}),
    ...(options.v3Path ? { v3Path: options.v3Path } : {}),
    ...(options.v3UserAgent ? { v3UserAgent: options.v3UserAgent } : {}),
    ...(options.v3ServerName ? { v3ServerName: options.v3ServerName } : {}),
    v3Multiplex: options.v3Multiplex,
  };
}

/**
 * 隧道上 V3 不能和哪些特性一起开。relayMode / parallelStreams 现在都可以和 V3 组合，
 * 调用方照旧传进来，这里不再据此拒绝。
 */
export type ForwardXV3ConflictInput = {
  lossTolerant?: unknown;
  kernelPassthrough?: unknown;
  relayMode?: unknown;
  parallelStreams?: unknown;
};

const truthy = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";

/**
 * V3 和 NEX 已有特性的组合：不能组合的保存时就拒，并说清为什么（不让它静默失效）。
 * - 抗丢包传输：它把下一跳的 TCP 换成 UDP 上的 KCP，V3 的 HTTP / WS / TLS 外层就没了；
 * - 内核直通：只对 V2（内核 WireGuard）有意义。
 * 能组合的：UDP 直连、UDP 抗丢包、mimic、链路整形、TCP Fast Open、PROXY、多出口负载均衡、
 * 中转「顺序」「主备」「叠加」「热备」、单连接多路并发（FXP 2.2.141 起：多路径的每条腿是一条
 * 自己的 V3 物理连接，开着多路复用也不会把腿并进同一条连接）。
 */
export function forwardXV3ConflictReason(input: ForwardXV3ConflictInput): string {
  if (truthy(input.lossTolerant)) {
    return "NEX V3 不能和「抗丢包传输」同时开：抗丢包传输把隧道里的 TCP 换成 UDP 上的 KCP，V3 的 HTTP / WebSocket / TLS 外层就没有了。二选一。";
  }
  if (truthy(input.kernelPassthrough)) {
    return "「内核直通」只对 NEX V2（WireGuard）隧道有效，V3 隧道请关掉它。";
  }
  return "";
}

export type ForwardXV3Host = {
  id: number;
  name?: string | null;
  agentVersion?: string | null;
  fxpVersion?: string | null;
};

export type ForwardXV3Blocker = {
  hostId: number;
  name: string;
  missing: Array<"agent" | "fxp">;
};

/** 隧道上哪些机器的 Agent / FXP 还不够新。没上报过版本的也算不够。 */
export function forwardXV3Blockers(hosts: Array<ForwardXV3Host | null | undefined>, hostIds: number[]): ForwardXV3Blocker[] {
  const byId = new Map(hosts.filter((host): host is ForwardXV3Host => !!host).map((host) => [Number(host.id), host]));
  const blockers: ForwardXV3Blocker[] = [];
  for (const id of Array.from(new Set(hostIds))) {
    const host = byId.get(id);
    const missing: Array<"agent" | "fxp"> = [];
    if (!isAgentVersionAtLeast(host?.agentVersion, FORWARDX_V3_MIN_AGENT_VERSION)) missing.push("agent");
    if (!isAgentVersionAtLeast(host?.fxpVersion, FORWARDX_V3_MIN_FXP_VERSION)) missing.push("fxp");
    if (missing.length > 0) blockers.push({ hostId: id, name: String(host?.name || `#${id}`), missing });
  }
  return blockers;
}

export function forwardXV3BlockerMessage(blockers: ForwardXV3Blocker[]) {
  const parts = blockers.slice(0, 4).map((blocker) => {
    const what = blocker.missing.map((item) => (item === "agent" ? `Agent ${FORWARDX_V3_MIN_AGENT_VERSION}` : `FXP ${FORWARDX_V3_MIN_FXP_VERSION}`)).join("、");
    return `${blocker.name}（要 ${what} 以上）`;
  });
  const more = blockers.length > 4 ? ` 等 ${blockers.length} 台` : "";
  return `NEX V3 要隧道上每台机器都升级：${parts.join("，")}${more}。先升级这些主机再切到 V3。`;
}
