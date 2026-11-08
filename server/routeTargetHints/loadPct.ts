import { routePathLoadHint } from "../hostLoad";
import type { RouteTargetHint } from "./types";

/**
 * 沿途主机里最忙那台的负载（0–100，整数）：Agent 拿它扣评分、算「自动」的权重。
 * 和 extraLatencyMs 一样是运行时提示：不进 Agent 的签名、不重建代理，面板也不因为它重发期望状态
 * （server/agentDesiredStateHash.ts 的 failoverWithoutRuntimeHints），靠 runningRules 送到。
 */
export const loadPctHint: RouteTargetHint = {
  name: "loadPct",
  fields: ({ path, dial }) => {
    if (!dial) return {};
    const loadPct = routePathLoadHint(path);
    return loadPct > 0 ? { loadPct } : {};
  },
};
