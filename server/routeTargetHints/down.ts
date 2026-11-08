import type { RouteTargetHint } from "./types";

/**
 * 用不了的路径：解析不出拨号地址的标成 down（原因是路径自己的 issue）；解析得出来的看面板的提示 ——
 * 暂停、维护中、离线、熔断（routeNodeHints）比中转探测的结论（routeHopDownHints）更硬，压过它。
 * 入口 Agent 自己只探得到第一跳，中间断了要靠面板告诉它。
 */
export const downHint: RouteTargetHint = {
  name: "down",
  fields: ({ path, dial, context }) => {
    if (!dial) return { down: true, downReason: path.issue || "path unresolved" };
    const hint = context.nodeHints.get(path.key) || context.hopHints.get(path.key);
    return hint?.down ? { down: true, downReason: hint.reason } : {};
  },
};
