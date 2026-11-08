/*
  线路组下发给 Agent 的每条目标，按「装饰器」一层层拼出来：每个文件管一个字段（或一组字段），
  在这里按顺序注册。顺序就是下发的 JSON 里键的顺序 —— Agent 不看顺序，但期望状态的摘要、
  对照基准（scripts/bench/heartbeat-golden）按字节比，挪了顺序就算变了。

  新加一种提示：在这个目录里加一个文件，在下面的表里放到该放的位置。只是运行时提示的（像
  loadPct、extraLatencyMs），记得在 server/agentDesiredStateHash.ts 的 failoverWithoutRuntimeHints
  里也去掉它，不然它一变就会重发整份期望状态。
*/
import { routePathDial, type RoutePath } from "../../shared/routeGroup";
import { dialHint } from "./dial";
import { downHint } from "./down";
import { exitIpHint } from "./exitIp";
import { extraLatencyHint } from "./extraLatency";
import { lineSpreadHint } from "./lineSpread";
import { loadPctHint } from "./loadPct";
import { probeHint } from "./probe";
import { probeUdpEchoHint } from "./probeUdpEcho";
import { tierHint } from "./tier";
import { weightHint } from "./weight";
import type { RouteFailoverTarget, RouteTargetHint, RouteTargetHintContext } from "./types";

export type { RouteFailoverTarget, RouteTargetHint, RouteTargetHintContext } from "./types";

/** 注册表：按这个顺序拼。dial、weight 是每条都有的核心字段，其余是提示。 */
export const ROUTE_TARGET_HINTS: readonly RouteTargetHint[] = [
  dialHint,
  probeHint,
  probeUdpEchoHint,
  weightHint,
  tierHint,
  lineSpreadHint,
  extraLatencyHint,
  loadPctHint,
  exitIpHint,
  downHint,
];

/** 一条路径 → 一条目标。 */
export function buildRouteFailoverTarget(path: RoutePath, context: RouteTargetHintContext): RouteFailoverTarget {
  const dial = routePathDial(path, context.routeRule);
  const target: Partial<RouteFailoverTarget> = {};
  for (const hint of ROUTE_TARGET_HINTS) Object.assign(target, hint.fields({ path, dial, context }));
  return target as RouteFailoverTarget;
}

/** 一条规则的全部路径 → 目标，下标和路径一一对应（解析不出来的路径也占一个）。 */
export function buildRouteFailoverTargets(paths: readonly RoutePath[], context: RouteTargetHintContext): RouteFailoverTarget[] {
  return paths.map((path) => buildRouteFailoverTarget(path, context));
}
