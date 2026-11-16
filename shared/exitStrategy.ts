import { LINK_SPREAD_LABELS } from "./linkTerms";
import { proxyLoadBalanceWeights } from "./linkWeights";
import { BALANCE_STRATEGY_LABELS } from "./loadBalance";

export const EXIT_GROUP_STRATEGIES = [
  "none",
  "auto",
  "latency",
  "fallback",
  "round_robin",
  "random",
  "ip_hash",
  "weighted",
  "least_load",
] as const;

export type ExitGroupStrategy = (typeof EXIT_GROUP_STRATEGIES)[number];

// 名字和线路组的分配方式同一套（shared/linkTerms.ts）。
export const EXIT_GROUP_STRATEGY_LABELS: Record<ExitGroupStrategy, string> = {
  none: "只用第一个出口",
  auto: `${BALANCE_STRATEGY_LABELS.auto.label} - ${BALANCE_STRATEGY_LABELS.auto.hint}`,
  latency: `${BALANCE_STRATEGY_LABELS.latency.label} - ${BALANCE_STRATEGY_LABELS.latency.hint}`,
  fallback: `${LINK_SPREAD_LABELS.fallback.label} - ${LINK_SPREAD_LABELS.fallback.hint}`,
  round_robin: `${LINK_SPREAD_LABELS.round_robin.label} - ${LINK_SPREAD_LABELS.round_robin.hint}`,
  random: `${LINK_SPREAD_LABELS.random.label} - ${LINK_SPREAD_LABELS.random.hint}`,
  ip_hash: `${LINK_SPREAD_LABELS.ip_hash.label} - ${LINK_SPREAD_LABELS.ip_hash.hint}`,
  weighted: `${LINK_SPREAD_LABELS.weighted.label} - ${LINK_SPREAD_LABELS.weighted.hint}`,
  least_load: `${LINK_SPREAD_LABELS.least_load.label} - ${LINK_SPREAD_LABELS.least_load.hint}`,
};

export function normalizeExitGroupStrategy(value: unknown): ExitGroupStrategy {
  const raw = String(value || "").trim().toLowerCase();
  // 隧道上老的 least_conn（以前从没真正生效，一直当轮流）就是现在的「按负载」。
  const normalized = raw === "least_conn" ? "least_load" : raw;
  return (EXIT_GROUP_STRATEGIES as readonly string[]).includes(normalized)
    ? normalized as ExitGroupStrategy
    : "round_robin";
}

export function exitGroupUsesMultipleExits(value: unknown) {
  return normalizeExitGroupStrategy(value) !== "none";
}

/**
 * 「按权重」时每个出口分几份：按出口主机的线路带宽（hostBandwidthHintMbps）算，500M / 300M → [5, 3]。
 * 不是 weighted、只有一个出口、有一台不知道带宽或都一样时返回 null —— 这时就是轮流。
 */
export function exitGroupWeights(strategy: unknown, bandwidthsMbps: readonly number[]): number[] | null {
  // 「按负载」在 GOST / nginx 上没有实时负载可看：GOST 退成按带宽加权轮流，nginx 是 least_conn + 权重。
  const normalized = normalizeExitGroupStrategy(strategy);
  // 自动 / 延迟优先在 GOST / nginx 上同样看不到实时延迟和负载，和「按负载」一样退成按带宽加权
  if (normalized !== "weighted" && normalized !== "least_load" && normalized !== "auto" && normalized !== "latency") return null;
  return proxyLoadBalanceWeights(bandwidthsMbps);
}

/**
 * 交给 FXP 的每个出口的线路带宽（Mbps）：「按负载」按它折算该分多少，「按访客固定」按它加权。
 * 只要有一台不知道就都不给（FXP 那边也是要么全按带宽、要么一样大）。
 */
export function exitGroupCapacities(strategy: unknown, bandwidthsMbps: readonly number[]): number[] | null {
  const normalized = normalizeExitGroupStrategy(strategy);
  if (normalized !== "least_load" && normalized !== "ip_hash" && normalized !== "auto" && normalized !== "latency") return null;
  if (bandwidthsMbps.length < 2 || bandwidthsMbps.some((value) => !(value > 0))) return null;
  return bandwidthsMbps.map((value) => Math.floor(value));
}
