import { normalizeExitGroupStrategy } from "@shared/exitStrategy";
import { FXP_TARGET_AWARE_VERSION } from "@shared/loadBalance";
import { isAgentVersionAtLeast } from "@shared/version";

export type ExitGroupTunnelMember = {
  hostId?: number | null;
  connectHost?: string | null;
  priority?: number | null;
  isEnabled?: boolean | number | string | null;
};

export type TunnelExitEndpointSnapshot = {
  hostId?: number | null;
  listenPort?: number | null;
  mimicPort?: number | null;
  connectHost?: string | null;
};

export type PlannedTunnelExitEndpoint = {
  hostId: number;
  listenPort: number;
  mimicPort: number;
  connectHost: string | null;
};

function memberEnabled(value: unknown) {
  // SQLite/MySQL adapters may expose a boolean column as a number or string.
  // In particular, the string "0" is truthy in JavaScript and must not make
  // a disabled exit participate in endpoint planning.  Missing values retain
  // the schema's enabled-by-default behaviour.
  if (value === undefined || value === null || value === "") return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "0" || normalized === "false") return false;
  }
  return true;
}

export function planExitGroupTunnelEndpoints(
  members: ExitGroupTunnelMember[],
  existingEndpoints: TunnelExitEndpointSnapshot[],
): PlannedTunnelExitEndpoint[] {
  const existingByHostId = new Map<number, TunnelExitEndpointSnapshot>();
  for (const endpoint of existingEndpoints) {
    const hostId = Number(endpoint?.hostId || 0);
    if (hostId > 0 && !existingByHostId.has(hostId)) existingByHostId.set(hostId, endpoint);
  }

  const seen = new Set<number>();
  return [...members]
    .sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0))
    .filter((member) => memberEnabled(member.isEnabled))
    .map((member) => ({ ...member, hostId: Number(member.hostId || 0) }))
    .filter((member) => {
      if (member.hostId <= 0 || seen.has(member.hostId)) return false;
      seen.add(member.hostId);
      return true;
    })
    .map((member) => {
      const existing = existingByHostId.get(member.hostId);
      return {
        hostId: member.hostId,
        listenPort: Number(existing?.listenPort || 0),
        mimicPort: Number(existing?.mimicPort || 0),
        connectHost: String(member.connectHost || "").trim() || null,
      };
    });
}

/**
 * 交给 FXP 的出口策略。auto（自动）/ latency（延迟优先）只有 FXP 2.2.142 起认得（老的会当轮流），
 * 入口机的 FXP 还旧时换成最接近的「按负载」。
 */
export function forwardXExitStrategy(value: unknown, supportsTargetAware = true) {
  const strategy = normalizeExitGroupStrategy(value);
  if (strategy === "none") return "round_robin";
  if (!supportsTargetAware && (strategy === "auto" || strategy === "latency")) return "least_load";
  return strategy;
}

/** 这台机器上的 FXP 认不认「出口回报连目标的结果」、auto / latency 策略（2.2.142 起）。 */
export function fxpSupportsTargetAware(fxpVersion: unknown) {
  return isAgentVersionAtLeast(String(fxpVersion || ""), FXP_TARGET_AWARE_VERSION);
}
