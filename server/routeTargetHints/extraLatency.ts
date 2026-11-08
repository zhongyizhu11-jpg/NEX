import { routePathDownstreamMs } from "../routeGroupStats";
import type { RouteTargetHint } from "./types";

/**
 * 入口探不到的后面几段（中继各自探的）加起来：Agent 按整条链打分。
 * Agent 那边是整数毫秒（Go int），小数会让整份规格解不开。
 */
export const extraLatencyHint: RouteTargetHint = {
  name: "extraLatencyMs",
  fields: ({ path, dial, context }) => {
    if (!dial) return {};
    const extraLatencyMs = Math.round(routePathDownstreamMs(context.ruleId, path));
    return extraLatencyMs > 0 ? { extraLatencyMs } : {};
  },
};
