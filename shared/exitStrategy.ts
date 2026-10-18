import { LINK_SPREAD_LABELS } from "./linkTerms";

export const EXIT_GROUP_STRATEGIES = [
  "none",
  "fallback",
  "round_robin",
  "random",
  "ip_hash",
] as const;

export type ExitGroupStrategy = (typeof EXIT_GROUP_STRATEGIES)[number];

// 名字和线路组的分配方式同一套（shared/linkTerms.ts）。
export const EXIT_GROUP_STRATEGY_LABELS: Record<ExitGroupStrategy, string> = {
  none: "只用第一个出口",
  fallback: `${LINK_SPREAD_LABELS.fallback.label} - ${LINK_SPREAD_LABELS.fallback.hint}`,
  round_robin: `${LINK_SPREAD_LABELS.round_robin.label} - ${LINK_SPREAD_LABELS.round_robin.hint}`,
  random: `${LINK_SPREAD_LABELS.random.label} - ${LINK_SPREAD_LABELS.random.hint}`,
  ip_hash: `${LINK_SPREAD_LABELS.ip_hash.label} - ${LINK_SPREAD_LABELS.ip_hash.hint}`,
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
