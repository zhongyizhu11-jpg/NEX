import type { RouteTargetHint } from "./types";

/** 每条路径可以有自己的探测目标（探落地而不是探中转），见 shared/failoverTargets 里为什么需要它。 */
export const probeHint: RouteTargetHint = {
  name: "probe",
  fields: ({ path, dial }) => (dial && path.probe ? { probeIp: path.probe.ip, probePort: path.probe.port } : {}),
};
