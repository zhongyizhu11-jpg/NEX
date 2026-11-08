import type { RouteTargetHint } from "./types";

/** 权重：按权重分、自动的时候 Agent 按它分新连接。 */
export const weightHint: RouteTargetHint = {
  name: "weight",
  fields: ({ path }) => ({ weight: path.weight }),
};
