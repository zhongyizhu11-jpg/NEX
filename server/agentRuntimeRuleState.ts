import { normalizeForwardXVersion } from "../shared/forwardTypes";

function validPort(value: unknown) {
  const port = Number(value || 0);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

export type ForwardXRuntimeTransportVersion = "v1" | "v2" | "v3";

/** Agent 心跳里报的传输版本：认 v1 / v2 / v3，别的（老 Agent 没写、写坏了）当没报。 */
export function parseReportedForwardXTransportVersion(value: unknown): ForwardXRuntimeTransportVersion | undefined {
  const reported = String(value || "").trim().toLowerCase();
  return reported === "v1" || reported === "v2" || reported === "v3" ? reported : undefined;
}

export function resolveLocalForwardXTransportVersion(input: {
  reportedTransportVersion?: unknown;
  tunnel?: any;
}): ForwardXRuntimeTransportVersion | undefined {
  const reported = parseReportedForwardXTransportVersion(input.reportedTransportVersion);
  if (reported) return reported;
  if (!input.tunnel) return undefined;
  const mode = String(input.tunnel?.mode || "").trim().toLowerCase();
  if (mode !== "forwardx") return undefined;
  return normalizeForwardXVersion(input.tunnel?.forwardxVersion);
}

export function resolveRuleTrafficPortForHost(input: {
  sourcePort: unknown;
  usesTunnelRuntime: boolean;
  isEntry: boolean;
  exitPorts?: unknown[];
}) {
  const sourcePort = validPort(input.sourcePort);
  if (!input.usesTunnelRuntime || input.isEntry) return sourcePort;
  for (const value of input.exitPorts || []) {
    const port = validPort(value);
    if (port > 0) return port;
  }
  return 0;
}
