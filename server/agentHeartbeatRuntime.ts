import * as db from "./db";
import { effectiveGithubAccelerator } from "../shared/githubAccelerator";
import { killByPatternCmd, removeManagedServiceCmd, shQuote } from "./agentActionCommands";
import {
  cleanEndpointHost,
  endpointHostPort,
  isIpv6Literal,
  legacyRealmConfigPathForPort,
  legacyRealmServiceNameForPort,
  legacySocatServiceNameForPort,
} from "./forwardRuntimeConfigs";
import { isForwardRuleProtocolUdpEnabled, normalizeForwardRuleProtocol } from "@shared/forwardTypes";

/*
  下发给 Agent 的运行时（共享 gost、隧道 gost、realm / socat 旧服务、mimic）的路径、名字和小工具：
  数据库布尔值规整、GOST 监听参数、旧服务清理命令、运行时二进制就位命令、sing-box 下载加速设置。
  从 server/agentHeartbeatRoute.ts 里原样搬出来，行为不变。
*/

/**
 * Normalize boolean values read from the database before they participate in
 * runtime planning.  SQLite adapters normally return 0/1, while some MySQL
 * drivers (and legacy rows) expose those values as strings.  JavaScript's
 * truthiness would otherwise treat the string "0" as enabled and could make
 * the Agent create listeners for disabled tunnels or exit nodes.
 *
 * Unknown values are returned unchanged so this helper is safe to use on
 * optional columns whose historical default is represented by `undefined`.
 */
export function normalizeAgentRuntimeBoolean(value: unknown): unknown {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return value;
}

export function runtimeBool(value: unknown, fallback = false): boolean {
  const normalized = normalizeAgentRuntimeBoolean(value);
  if (normalized === undefined || normalized === null || normalized === "") return fallback;
  if (normalized === true || normalized === false) return normalized;
  // Preserve the caller's historical default for malformed/legacy values.
  // In particular, fields that used to be checked with `value !== false`
  // pass `fallback=true` so an absent/unknown optional flag remains enabled.
  return fallback;
}

export const RUNTIME_BIN = "/usr/local/bin/forwardx-runtime";
export const RUNTIME_SERVICE_NAME = "forwardx-runtime";
export const TUNNEL_RUNTIME_SERVICE_NAME = "forwardx-tunnel-runtime";
export const RUNTIME_CONFIG_PATH = "/etc/forwardx/runtime/gost.json";
export const TUNNEL_RUNTIME_CONFIG_PATH = "/etc/forwardx/runtime/tunnel-gost.json";
export const RUNTIME_CONFIG_DIR = "/etc/forwardx/runtime";

export const LEGACY_GOST_SERVICE_NAME = "forwardx-gost";
export const LEGACY_TUNNEL_SERVICE_NAME = "forwardx-tunnels";
export const MIMIC_CONFIG_DIR = "/etc/mimic";

export const SHARED_GOST_FORWARD_TYPES = new Set([
  "gost",
  "gost-tunnel",
  "gost-tunnel-exit",
  "gost-tunnel-hop",
]);

const GOST_TUNNEL_MODES = new Set(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]);

/** 多条规则共用一个进程的运行时（gost、隧道 gost）的句柄上限，和 Agent 自己的一致。 */
export const SHARED_RUNTIME_NOFILE = 1048576;
const GOST_UDP_LISTENER_METADATA = {
  keepalive: true,
  ttl: "30s",
  // GOST v3.2.6 GetInt ignores JSON numbers decoded as float64, so integer metadata stays string-encoded.
  // 队列里每个包占一块 readBufferSize 大小的缓冲，所以缓冲保持 8K（公网 UDP 包
  // 远小于此），只把每个客户端的队列从 64 包放到 256 包：64 包在突发（QUIC 握手、
  // 游戏开局）时直接丢包，256 包最坏也只占 2MB。
  readBufferSize: "8192",
  readQueueSize: "256",
  backlog: "128",
} as const;

export function buildGostRuleListener(protocol: "tcp" | "udp") {
  return protocol === "udp"
    ? { type: protocol, metadata: { ...GOST_UDP_LISTENER_METADATA } }
    : { type: protocol };
}

export function forwardXUDPTargetAddress(rule: any): string {
  return String(rule?.targetIp || rule?._originalTargetIp || "").trim();
}

export function selectForwardChainListenerPort(
  childRules: any[],
  memberIdValue: unknown,
  hostIdValue: unknown,
  fallbackPortValue: unknown,
) {
  const memberId = Number(memberIdValue || 0);
  const hostId = Number(hostIdValue || 0);
  const fallbackPort = Number(fallbackPortValue || 0);
  const child = childRules.find((candidate: any) => {
    const pendingDelete = candidate?.pendingDelete === true
      || candidate?.pendingDelete === 1
      || candidate?.pendingDelete === "1"
      || String(candidate?.pendingDelete || "").toLowerCase() === "true";
    return !pendingDelete
      && Number(candidate?.forwardGroupMemberId || 0) === memberId
      && Number(candidate?.hostId || 0) === hostId;
  });
  const port = Number(child?.sourcePort || 0);
  return port > 0 ? port : fallbackPort;
}

/**
 * 下载 sing-box 用的 GitHub 加速设置。
 *
 * 每次心跳都读一遍设置表，但缓存几秒 —— 这个值几乎不变，而心跳是每台主机每
 * 半分钟一次，不缓存的话纯属白查。
 */
let singboxAcceleratorCache: { value: { enabled: boolean; url: string }; at: number } | null = null;
const SINGBOX_ACCELERATOR_CACHE_MS = 30_000;

export async function getSingboxAccelerator() {
  const now = Date.now();
  if (singboxAcceleratorCache && now - singboxAcceleratorCache.at < SINGBOX_ACCELERATOR_CACHE_MS) {
    return singboxAcceleratorCache.value;
  }
  const all = await db.getAllSettings().catch(() => ({} as Record<string, string | null>));
  const value = effectiveGithubAccelerator({
    enabled: all.githubAcceleratorEnabled === "true",
    url: all.githubAcceleratorUrl ?? "",
  });
  singboxAcceleratorCache = { value, at: now };
  return value;
}

export function isForwardXTunnelMode(tunnel: any) {
  return String(tunnel?.mode || "").toLowerCase() === "forwardx";
}

export function isGostTunnelMode(tunnel: any) {
  return !!tunnel && GOST_TUNNEL_MODES.has(String(tunnel?.mode || "").toLowerCase());
}

export function legacyRealmCleanupCmds(port: unknown, protocol: unknown) {
  const normalized = normalizeForwardRuleProtocol(protocol, "both");
  if (normalized === "udp") return [];
  const serviceName = legacyRealmServiceNameForPort(port);
  const configPath = legacyRealmConfigPathForPort(port);
  return [
    removeManagedServiceCmd(serviceName),
    killByPatternCmd(`[r]ealm .*${configPath}`),
    `rm -f ${shQuote(configPath)} ${shQuote(`${configPath}.sha256`)} 2>/dev/null || true`,
  ];
}

export function legacySocatCleanupCmds(port: unknown, protocol: unknown) {
  const normalized = normalizeForwardRuleProtocol(protocol, "both");
  if (normalized === "udp") return [];
  return [removeManagedServiceCmd(legacySocatServiceNameForPort(port))];
}

export function socatKillByProtocolCmd(port: unknown, protocol: unknown) {
  const normalized = normalizeForwardRuleProtocol(protocol, "both");
  if (normalized === "both") return killByPatternCmd(`[s]ocat.*LISTEN:${Number(port) || 0}`);
  const protoUpper = normalized === "udp" ? "UDP" : "TCP";
  return killByPatternCmd(`[s]ocat.*${protoUpper}[46]?-LISTEN:${Number(port) || 0}`);
}

export function mimicFilterEndpoint(host: unknown, port: unknown) {
  const clean = cleanEndpointHost(host);
  const p = Number(port) || 0;
  if (!clean || p <= 0 || p > 65535) return "";
  if (clean === "0.0.0.0" || clean === "::" || clean === "[::]") {
    return isIpv6Literal(clean) ? "[::]:" + p : "0.0.0.0:" + p;
  }
  return endpointHostPort(clean, p);
}

export function udpOverTcpEnabled(rule: any, tunnel: any) {
  return !!rule
    && !!tunnel
    && isForwardXTunnelMode(tunnel)
    && (runtimeBool((rule as any).udpOverTcp) || runtimeBool((tunnel as any).udpOverTcp))
    && isForwardRuleProtocolUdpEnabled(rule?.protocol);
}

export function ensureRuntimeBinaryCmd() {
  const runtime = shQuote(RUNTIME_BIN);
  return `if [ -e ${runtime} ]; then chmod 0755 ${runtime} 2>/dev/null || true; else for bin in /usr/local/bin/gost $(command -v gost 2>/dev/null || true); do [ -n "$bin" ] || continue; [ -x "$bin" ] || continue; install -m 0755 "$bin" ${runtime} && break; done; fi; [ -x ${runtime} ]`;
}
