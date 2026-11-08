import { routePathExitIp } from "../../shared/routeGroup";
import type { RouteTargetHint } from "./types";

/** 这条路径最后从哪个 IP 出去：挂了换路时 Agent 优先挑一样的（routePathExitIp）。 */
export const exitIpHint: RouteTargetHint = {
  name: "exitIp",
  fields: ({ path, dial, context }) => {
    if (!dial) return {};
    const exitIp = routePathExitIp(path, context.routeRule, context.hostEgressIp);
    return exitIp ? { exitIp } : {};
  },
};
