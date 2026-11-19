/*
  国内健康度 / 健康检测目标的规整（「主机:端口」、IPv6、Ping 不带端口）。纯函数：探测拓扑（probeTopology.ts）和
  健康上报（health.ts）都要用，放在这里两边都不用互相引。
*/

import { isIP } from "node:net";
import { defaultHealthCheckPort, defaultHealthCheckTarget, healthCheckTargetNeedsPort, normalizeForwardGroupHealthCheckMethod } from "../../shared/forwardGroupHealthCheck";
import { normalizeIpCandidate } from "./common";

export function normalizeChinaHealthTarget(raw: unknown, method?: unknown) {
  const probeMethod = normalizeForwardGroupHealthCheckMethod(method);
  const needsPort = healthCheckTargetNeedsPort(probeMethod);
  const source = String(raw || "").trim() || defaultHealthCheckTarget(probeMethod);
  const withoutScheme = source.replace(/^(?:tcp|udp|icmp|ping):\/\//i, "").replace(/：/g, ":").trim();
  let host = withoutScheme;
  let port = defaultHealthCheckPort(probeMethod);

  const bracketMatch = withoutScheme.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    host = bracketMatch[1];
    port = bracketMatch[2] ? Number(bracketMatch[2]) : defaultHealthCheckPort(probeMethod);
  } else {
    const lastColon = withoutScheme.lastIndexOf(":");
    if (lastColon > 0) {
      const maybeHost = withoutScheme.slice(0, lastColon).trim();
      const maybePortText = withoutScheme.slice(lastColon + 1);
      const maybePort = Number(maybePortText);
      const singleColonHostPort = withoutScheme.indexOf(":") === lastColon;
      const nakedIpv6HostPort = !singleColonHostPort && isIP(maybeHost) === 6;
      if ((singleColonHostPort || nakedIpv6HostPort) && /^\d+$/.test(maybePortText) && Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
        host = maybeHost;
        port = maybePort;
      }
    }
  }

  host = normalizeIpCandidate(host).trim();
  // Ping ignores ports entirely, so a port left over from TCPing is stripped
  // rather than reported as a malformed IPv6 address.
  if (!needsPort && host.includes(":") && isIP(host) !== 6) {
    const trailingPort = host.match(/^(.*?):(\d+)$/);
    if (trailingPort && isIP(trailingPort[1]) !== 6) host = trailingPort[1].trim();
  }
  if (host.includes(":") && isIP(host) !== 6) {
    throw new Error("China health IPv6 target format is invalid");
  }
  if (!host || host.length > 253 || /[\s'"<>/]/.test(host)) {
    throw new Error("China health target format is invalid");
  }
  if (needsPort && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("China health target port must be 1-65535");
  }
  const textHost = isIP(host) === 6 ? `[${host}]` : host;
  // Ping carries no port, so the stored text is the bare host and the probe is
  // emitted with port 0.
  if (!needsPort) return { host, port: 0, text: textHost, method: probeMethod };
  return { host, port, text: `${textHost}:${port}`, method: probeMethod };
}
