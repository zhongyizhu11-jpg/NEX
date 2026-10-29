import { LINK_TERM_FAILOVER, LINK_TERM_SPLIT_CONNECTION } from "./linkTerms";

export const TUNNEL_RELAY_MODES = ["chain", "failover", "aggregate", "hot_standby"] as const;

export type TunnelRelayMode = (typeof TUNNEL_RELAY_MODES)[number];

export const AGENT_FORWARDX_RELAY_FAILOVER_VERSION = "2.2.160";

/**
 * Single-connection multipath aggregation is a NEX protocol feature, so an
 * Agent older than this cannot run an aggregate tunnel.
 */
export const AGENT_FORWARDX_RELAY_AGGREGATE_VERSION = "2.2.194";

/**
 * 热备（hot_standby）：每条连接同时连上全部中转，平时只走第一台，其余几条腿连着不送；
 * 第一台停住几百毫秒内就由下一台接手，连接不断。腿上的 standby 标记要 Agent / FXP 认得
 * 才有用（老的会把它当叠加腿一起送 —— 也能通，只是不省流量）。
 */
export const AGENT_FORWARDX_RELAY_HOT_STANDBY_VERSION = "2.2.238";

/**
 * 隧道编辑框里「中转方式」三个选项的名字：顺序 / 主备 / 叠加（叠加就是 shared/linkTerms.ts 的单连接叠加，
 * 和链路管理的「叠加」页签同一个东西；选叠加的隧道保存后列在那一栏）。
 */
export const TUNNEL_RELAY_MODE_LABELS: Record<TunnelRelayMode, string> = {
  chain: "顺序",
  failover: LINK_TERM_FAILOVER,
  aggregate: "叠加",
  hot_standby: "热备",
};

export const TUNNEL_RELAY_MODE_HINTS: Record<TunnelRelayMode, string> = {
  chain: "流量按顺序经过每一台中转，最终到达出口。",
  failover: "入口每次只用一台中转，坏了才换下一台。",
  aggregate: "每条连接拆开同时走全部中转，出口拼回来，单条连接也能用上几台中转的带宽之和；保存后列在「叠加」页签。",
  hot_standby: "每条连接同时连上全部中转，平时只走第一台，其余连着不送；第一台停住几百毫秒内就由下一台接手，连接不断、不用重连。",
};

export function normalizeTunnelRelayMode(value: unknown): TunnelRelayMode {
  const normalized = String(value || "").trim().toLowerCase();
  return (TUNNEL_RELAY_MODES as readonly string[]).includes(normalized)
    ? normalized as TunnelRelayMode
    : "chain";
}

export function tunnelRelayFailoverSupported(mode: unknown) {
  const normalized = String(mode || "").trim().toLowerCase();
  return normalized === "forwardx" || ["tls", "wss", "tcp", "mtls", "mwss", "mtcp"].includes(normalized);
}

/**
 * Bandwidth aggregation splits one connection across the relays and reassembles
 * it at the exit, which only the NEX protocol implements. GOST transports
 * can fail over between relays but cannot stripe a single stream across them.
 */
export function tunnelRelayAggregateSupported(mode: unknown) {
  return String(mode || "").trim().toLowerCase() === "forwardx";
}

/** 热备和叠加走同一套单连接多腿机制，所以也只有 NEX 隧道支持。 */
export function tunnelRelayHotStandbySupported(mode: unknown) {
  return tunnelRelayAggregateSupported(mode);
}

export function tunnelRelayCandidates<T>(hops: T[]) {
  return Array.isArray(hops) && hops.length >= 3 ? hops.slice(1, -1) : [];
}

export function isTunnelRelayFailover(tunnel: any, hops: any[]) {
  return normalizeTunnelRelayMode(tunnel?.relayMode) === "failover"
    && tunnelRelayFailoverSupported(tunnel?.mode)
    && tunnelRelayCandidates(hops).length >= 2;
}

/**
 * True when this tunnel stripes each client connection over every relay.
 *
 * Aggregation needs at least two relays to have anything to combine; with one
 * relay the tunnel behaves as an ordinary single-path chain.
 */
export function isTunnelRelayAggregate(tunnel: any, hops: any[]) {
  return normalizeTunnelRelayMode(tunnel?.relayMode) === "aggregate"
    && tunnelRelayAggregateSupported(tunnel?.mode)
    && tunnelRelayCandidates(hops).length >= 2;
}

/**
 * True when the relays sit side by side rather than in series, so each one
 * dials the final exit and the entry addresses them all.
 *
 * Failover and aggregation share this topology and differ only in how the entry
 * uses it: failover picks one relay per connection, aggregation uses them all at
 * once.
 */
export function tunnelRelayUsesParallelRelays(tunnel: any, hops: any[]) {
  return isTunnelRelayFailover(tunnel, hops) || isTunnelRelayAggregate(tunnel, hops) || isTunnelRelayHotStandby(tunnel, hops);
}

/**
 * True when this tunnel keeps every relay connected per client connection but
 * sends on the first one only, the rest standing by to take over in place.
 */
export function isTunnelRelayHotStandby(tunnel: any, hops: any[]) {
  return normalizeTunnelRelayMode(tunnel?.relayMode) === "hot_standby"
    && tunnelRelayHotStandbySupported(tunnel?.mode)
    && tunnelRelayCandidates(hops).length >= 2;
}

/**
 * True when the entry opens one FXP leg per relay for each client connection,
 * whether to stripe over them (aggregate) or to hold the spares warm (hot
 * standby). Both need the same hello / leg support along the way.
 */
export function isTunnelRelayMultiLeg(tunnel: any, hops: any[]) {
  return isTunnelRelayAggregate(tunnel, hops) || isTunnelRelayHotStandby(tunnel, hops);
}

/** Minimum relays before a side-by-side relay mode has anything to work with. */
export const TUNNEL_RELAY_PARALLEL_MIN_RELAYS = 2;

export type TunnelRelayModeAvailability = {
  available: boolean;
  /** Empty when available; otherwise why the mode cannot be picked. */
  reason: string;
};

/**
 * Why each side-by-side relay mode is or is not selectable for a hop list.
 *
 * The panel keeps unavailable modes visible and disabled rather than hiding
 * them, so the reason is part of the result: a hidden control gives no way to
 * discover the mode exists or what it needs.
 */
export function tunnelRelayModeAvailability(options: {
  relayCount: number;
  aggregateSupported: boolean;
}): { failover: TunnelRelayModeAvailability; aggregate: TunnelRelayModeAvailability; hot_standby: TunnelRelayModeAvailability } {
  const relayCount = Math.max(0, Math.floor(Number(options.relayCount) || 0));
  const hasEnoughRelays = relayCount >= TUNNEL_RELAY_PARALLEL_MIN_RELAYS;
  const relayCountReason = `需要至少 ${TUNNEL_RELAY_PARALLEL_MIN_RELAYS} 台中转，当前 ${relayCount} 台`;
  const multiLeg: TunnelRelayModeAvailability = {
    // The protocol check comes first: telling an operator to add relays would
    // be wrong when the transport cannot open several legs at all.
    available: hasEnoughRelays && !!options.aggregateSupported,
    reason: !options.aggregateSupported
      ? "仅 NEX 隧道支持"
      : hasEnoughRelays
        ? ""
        : relayCountReason,
  };
  return {
    hot_standby: multiLeg,
    failover: {
      available: hasEnoughRelays,
      reason: hasEnoughRelays ? "" : relayCountReason,
    },
    aggregate: {
      // The protocol check comes first: telling an operator to add relays would
      // be wrong when the transport cannot stripe a connection at all.
      available: hasEnoughRelays && !!options.aggregateSupported,
      reason: !options.aggregateSupported
        ? `仅 NEX 隧道支持${LINK_TERM_SPLIT_CONNECTION}`
        : hasEnoughRelays
          ? ""
          : relayCountReason,
    },
  };
}
