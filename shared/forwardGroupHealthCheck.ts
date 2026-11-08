
/**
 * Health check method for forward group and entry group members.
 *
 * The panel probes each member from its own Agent to decide whether that member
 * still carries traffic. TCPing connects to a port on the target; ping measures
 * ICMP round-trip. Ping needs no port, and works against hosts that answer ICMP
 * but expose no reachable TCP port. UDP（Agent 2.2.251 起）探 UDP 端口：对端回
 * ICMP 端口不可达算不通，回了包算通，没回包说不准就退回 ping。
 */

export const FORWARD_GROUP_HEALTH_CHECK_METHODS = ["tcp", "ping", "udp"] as const;

export type ForwardGroupHealthCheckMethod = (typeof FORWARD_GROUP_HEALTH_CHECK_METHODS)[number];

export const FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS: Record<ForwardGroupHealthCheckMethod, string> = {
  tcp: "TCPing - 连接目标端口",
  ping: "Ping - ICMP 延迟",
  udp: "UDP - 探测 UDP 端口",
};

export const FORWARD_GROUP_HEALTH_CHECK_METHOD_HINTS: Record<ForwardGroupHealthCheckMethod, string> = {
  tcp: "连接目标的 IP 和端口，能确认端口真的可用。目标必须写成 主机:端口。",
  ping: "只发 ICMP 探测延迟，不需要端口。适合目标不开放 TCP 端口、或只想看链路通断和延迟的场景。",
  udp: "对目标的 UDP 端口发一个空包：端口关着（回 ICMP 端口不可达）算不通，有回包算通；UDP 服务多半不回陌生包，没回包时退回 Ping 探主机。目标必须写成 主机:端口。",
};

/** TCPing and UDP need a port on the target; ping does not. */
export function healthCheckTargetNeedsPort(method: unknown) {
  return normalizeForwardGroupHealthCheckMethod(method) !== "ping";
}

export function normalizeForwardGroupHealthCheckMethod(value: unknown): ForwardGroupHealthCheckMethod {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "ping") return "ping";
  if (text === "udp") return "udp";
  return "tcp";
}

/** Default probe target per method: TCPing carries a port, ping is host only, UDP 探一个常开的公共 DNS 端口。 */
export function defaultHealthCheckTarget(method: unknown) {
  const normalized = normalizeForwardGroupHealthCheckMethod(method);
  if (normalized === "udp") return "223.5.5.5:53";
  return normalized === "tcp" ? "www.189.cn:80" : "www.189.cn";
}

/** 没写端口时按方法补：TCPing 补 80，UDP 补 53（DNS）。 */
export function defaultHealthCheckPort(method: unknown) {
  return normalizeForwardGroupHealthCheckMethod(method) === "udp" ? 53 : 80;
}

/** Placeholder shown in the target field for the selected method. */
export function healthCheckTargetPlaceholder(method: unknown) {
  const normalized = normalizeForwardGroupHealthCheckMethod(method);
  if (normalized === "udp") return "留空默认 223.5.5.5:53，IPv6 用 [地址]:端口";
  return normalized === "tcp"
    ? "留空默认 www.189.cn:80，IPv6 用 [地址]:端口"
    : "留空默认 www.189.cn，IPv6 直接填地址";
}

/** 方法的短名，写在「怎么算健康」那句话里。 */
export function healthCheckMethodShortLabel(method: unknown) {
  const normalized = normalizeForwardGroupHealthCheckMethod(method);
  return normalized === "ping" ? "Ping" : normalized === "udp" ? "UDP 探测" : "TCPing";
}
