import { routeDestSpreadTargetFields } from "../../shared/routeGroup";
import type { RouteTargetHint } from "./types";

/**
 * 「落地怎么分」：一次走一条线路、这条线路选了「一起分」时，带上第几条线路、落地是哪一个、怎么分 ——
 * Agent 挑出该走的那条之后，在它那条线路的几个落地里按这个分新连接（routeDestSpreadTargetFields）。
 */
export const lineSpreadHint: RouteTargetHint = {
  name: "lineSpread",
  fields: ({ path, context }) => routeDestSpreadTargetFields(path, context.destSpreadReady),
};
