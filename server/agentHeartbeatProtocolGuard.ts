import { isAgentVersionAtLeast } from "./agentRouteUtils";
import { removeManagedServiceCmd, shQuote } from "./agentActionCommands";
import { REALM_CONFIG_DIR } from "./forwardRuntimeConfigs";
import { isForwardRuleProtocolTcpEnabled } from "@shared/forwardTypes";
import { forwardRateTiersForAgent } from "../shared/forwardRateLimit";

/*
  协议守卫（Guard：协议拦截、限速、PROXY protocol 的前置进程）：内部端口的分配、
  限速 / PROXY protocol 参数的选择、守卫后端进程的清理命令，以及按主机取的协议拦截策略。
  从 server/agentHeartbeatRoute.ts 里原样搬出来，行为不变（心跳处理函数里那几个不依赖本次请求的小函数提到了模块顶层）。
*/

export const AGENT_RATE_LIMIT_GUARD_VERSION = "2.2.187";
/** 多级限速、上下行分开、突发（guardRule.rateLimits）从这一版 Agent 起。 */
export const AGENT_RATE_TIERS_VERSION = "2.2.230";
const RATE_LIMIT_GUARD_FORWARD_TYPES = new Set(["iptables", "nftables", "realm", "socat", "nginx"]);

export type ProtocolGuardPortPlan = {
  guardListenPort: number;
  failoverProxyPort: number;
  guardBackendPort: number;
};

export const PROTOCOL_GUARD_PORT_MIN = 20000;
export const PROTOCOL_GUARD_PORT_MAX = 65535;
export const PROTOCOL_GUARD_LEGACY_SPAN = 20000;
const PROTOCOL_GUARD_PROCESS_BACKENDS = new Set(["gost", "realm", "socat", "nginx"]);

export function shouldReconcileProtocolGuardBackend(useRuleGuard: boolean, forwardType: unknown) {
  return useRuleGuard && PROTOCOL_GUARD_PROCESS_BACKENDS.has(String(forwardType || ""));
}

export function allocateProtocolGuardPorts(
  rules: Array<{ id?: unknown; sourcePort?: unknown; targetPort?: unknown }>,
  reservedPorts: Iterable<unknown> = [],
): Map<number, ProtocolGuardPortPlan> {
  const used = new Set<number>();
  const reserve = (value: unknown) => {
    const port = Number(value || 0);
    if (Number.isInteger(port) && port > 0 && port <= PROTOCOL_GUARD_PORT_MAX) used.add(port);
  };
  for (const port of reservedPorts) reserve(port);
  for (const rule of rules) {
    reserve(rule?.sourcePort);
    // A target may be a service on this Agent. Reserving every target port is
    // conservative, but prevents a loopback Guard backend from taking over a
    // real local service before the target address has been resolved.
    reserve(rule?.targetPort);
  }

  const ruleIds = Array.from(new Set(rules
    .map((rule) => Number(rule?.id || 0))
    .filter((id) => Number.isInteger(id) && id > 0)))
    .sort((left, right) => left - right);
  const poolSize = PROTOCOL_GUARD_PORT_MAX - PROTOCOL_GUARD_PORT_MIN + 1;
  const allocate = (preferredPort: number) => {
    const preferredOffset = preferredPort - PROTOCOL_GUARD_PORT_MIN;
    for (let offset = 0; offset < poolSize; offset += 1) {
      const port = PROTOCOL_GUARD_PORT_MIN + ((preferredOffset + offset) % poolSize);
      if (used.has(port)) continue;
      used.add(port);
      return port;
    }
    throw new Error("No free protocol guard internal port is available");
  };

  const plans = new Map<number, ProtocolGuardPortPlan>();
  for (const ruleId of ruleIds) {
    const legacyOffset = ruleId % PROTOCOL_GUARD_LEGACY_SPAN;
    plans.set(ruleId, {
      guardListenPort: allocate(39000 + legacyOffset),
      failoverProxyPort: allocate(41000 + legacyOffset),
      guardBackendPort: allocate(43000 + legacyOffset),
    });
  }
  return plans;
}

export function realmGuardConfigPathForPort(port: unknown) {
  return `${REALM_CONFIG_DIR}/forwardx-realm-guard-${Number(port) || 0}.toml`;
}

export function selectProtocolGuardRateLimit(options: {
  agentVersion: string;
  hostId: number;
  rule: { forwardType?: unknown; tunnelId?: unknown; userId?: unknown; tunnelMode?: unknown; tunnelEntry?: unknown };
  limitIn: number;
  limitOut: number;
  rateLimitScope?: unknown;
  /** 多级限速（shared/forwardRateLimit.ts 的 forwardRateTiersForAgent），Agent ≥ 2.2.230 才下发。 */
  rateLimits?: ReturnType<typeof forwardRateTiersForAgent>;
}) {
  const forwardType = String(options.rule?.forwardType || "").trim();
  const tunnelId = Number(options.rule?.tunnelId || 0);
  const nginxTunnelEntry = tunnelId > 0
    && String(options.rule?.tunnelMode || "").trim().toLowerCase() === "nginx_stream"
    && options.rule?.tunnelEntry === true;
  const userId = Number(options.rule?.userId || 0);
  const limitIn = Math.max(0, Math.floor(Number(options.limitIn) || 0));
  const limitOut = Math.max(0, Math.floor(Number(options.limitOut) || 0));
  if (
    !isAgentVersionAtLeast(options.agentVersion, AGENT_RATE_LIMIT_GUARD_VERSION)
    || (tunnelId > 0 && !nginxTunnelEntry)
    || (!RATE_LIMIT_GUARD_FORWARD_TYPES.has(forwardType) && !nginxTunnelEntry)
    || (nginxTunnelEntry && forwardType !== "gost")
    || userId <= 0
    || (limitIn <= 0 && limitOut <= 0)
  ) {
    return { rateLimitScope: "", limitIn: 0, limitOut: 0 };
  }
  const tiers = Array.isArray(options.rateLimits) ? options.rateLimits : [];
  return {
    rateLimitScope: String(options.rateLimitScope || "").trim() || (nginxTunnelEntry
      ? `user-${userId}-host-${Math.max(0, Number(options.hostId) || 0)}-tunnel-${tunnelId}`
      : `user-${userId}-host-${Math.max(0, Number(options.hostId) || 0)}`),
    limitIn,
    limitOut,
    ...(tiers.length > 0 && isAgentVersionAtLeast(options.agentVersion, AGENT_RATE_TIERS_VERSION) ? { rateLimits: tiers } : {}),
  };
}

export function selectProtocolGuardProxyProtocol(options: {
  backendPort: number;
  backendForwardType?: unknown;
  receive: boolean;
  send: boolean;
}) {
  const receive = options.receive === true;
  const send = options.send === true;
  const backendForwardType = String(options.backendForwardType || "").trim().toLowerCase();
  const backendConsumesProxyProtocol = Number(options.backendPort) > 0
    && (backendForwardType === "gost" || backendForwardType === "realm");
  return {
    proxyProtocolReceive: receive,
    // GOST and Realm consume the Guard's internal PROXY header before applying
    // their own send setting. Transparent backends such as Nginx must only see
    // a header when the user explicitly enabled sending it downstream.
    proxyProtocolSend: send || (receive && backendConsumesProxyProtocol),
  };
}

export const protocolPolicyFromHost = (hostLike: any) => ({
  blockHttp: !!(hostLike as any)?.blockHttp,
  blockSocks: !!(hostLike as any)?.blockSocks,
  blockTls: !!(hostLike as any)?.blockTls,
});
export const hasProtocolPolicy = (policy: any) => {
  return policy.blockHttp || policy.blockSocks || policy.blockTls;
};

export const shouldUseProcessBackendGuard = (rule: any) => PROTOCOL_GUARD_PROCESS_BACKENDS.has(String(rule?.forwardType || ""));

export const shouldUseProtocolGuard = (rule: any, policy: any) => isForwardRuleProtocolTcpEnabled(rule?.protocol) && hasProtocolPolicy(policy);

export const cleanupGuardBackendCmds = (rule: any, keepNames: string[] = []) => {
  const sourcePort = Number(rule?.sourcePort || 0);
  if (!sourcePort) return [];
  const keep = new Set(keepNames.map((name) => String(name || "").trim()).filter(Boolean));
  const realmGuardService = `forwardx-realm-guard-${sourcePort}`;
  const services = [
    realmGuardService,
    `forwardx-socat-guard-${sourcePort}`,
    `forwardx-socat-guard-tcp-${sourcePort}`,
    `forwardx-socat-guard-udp-${sourcePort}`,
  ];
  const cmds = services.filter((name) => !keep.has(name)).map((name) => removeManagedServiceCmd(name));
  if (!keep.has(realmGuardService)) {
    cmds.push(`rm -f ${shQuote(realmGuardConfigPathForPort(sourcePort))} ${shQuote(`${realmGuardConfigPathForPort(sourcePort)}.sha256`)} 2>/dev/null || true`);
  }
  return cmds;
};
