import { LINK_SPREAD_LABELS } from "./linkTerms";
import { proxyLoadBalanceWeights } from "./linkWeights";

export const EXIT_GROUP_STRATEGIES = [
  "none",
  "fallback",
  "round_robin",
  "random",
  "ip_hash",
  "weighted",
] as const;

export type ExitGroupStrategy = (typeof EXIT_GROUP_STRATEGIES)[number];

// 名字和线路组的分配方式同一套（shared/linkTerms.ts）。
export const EXIT_GROUP_STRATEGY_LABELS: Record<ExitGroupStrategy, string> = {
  none: "只用第一个出口",
  fallback: `${LINK_SPREAD_LABELS.fallback.label} - ${LINK_SPREAD_LABELS.fallback.hint}`,
  round_robin: `${LINK_SPREAD_LABELS.round_robin.label} - ${LINK_SPREAD_LABELS.round_robin.hint}`,
  random: `${LINK_SPREAD_LABELS.random.label} - ${LINK_SPREAD_LABELS.random.hint}`,
  ip_hash: `${LINK_SPREAD_LABELS.ip_hash.label} - ${LINK_SPREAD_LABELS.ip_hash.hint}`,
  weighted: `${LINK_SPREAD_LABELS.weighted.label} - ${LINK_SPREAD_LABELS.weighted.hint}`,
};

export function normalizeExitGroupStrategy(value: unknown): ExitGroupStrategy {
  const normalized = String(value || "").trim().toLowerCase();
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
  if (normalizeExitGroupStrategy(strategy) !== "weighted") return null;
  return proxyLoadBalanceWeights(bandwidthsMbps);
}
