import type { RouteTargetHint } from "./types";

/**
 * 分层：聚合 / 复制时每条目标带 tier，Agent 只在最低的、还有健康路径的那一层里挑 / 分
 * （主线路那组几条一起分担，备用组只兜底）。别的分法不带，见 actionFailover 里 tiered 的说明。
 */
export const tierHint: RouteTargetHint = {
  name: "tier",
  fields: ({ path, context }) => (context.tiered ? { tier: Number(path.tier) } : {}),
};
