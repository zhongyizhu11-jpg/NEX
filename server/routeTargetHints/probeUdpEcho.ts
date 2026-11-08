import { routeUdpEchoProbeReady } from "../../shared/routeGroup";
import type { RouteTargetHint } from "./types";

/** UDP 回声探测：回探测报的是对端那台，对端是自己的机器才带（routeUdpEchoProbeReady）。 */
export const probeUdpEchoHint: RouteTargetHint = {
  name: "probeUdpEcho",
  fields: ({ path, dial, context }) => (
    dial && routeUdpEchoProbeReady({ protocol: context.protocol, path }) ? { probeUdpEcho: true } : {}
  ),
};
