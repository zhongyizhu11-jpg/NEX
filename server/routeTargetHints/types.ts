import type { RouteEndpoint, RouteGroupRule, RouteLineDestSpread, RoutePath } from "../../shared/routeGroup";
import type { RouteHopHint } from "../routeGroupStats";

/**
 * 下发给 Agent 的一条线路组目标（agent 的 failoverTarget）。字段顺序就是下发的 JSON 里的顺序，
 * 由 index.ts 里注册的先后决定，别在别处另拼。
 */
export type RouteFailoverTarget = {
  targetIp: string;
  targetPort: number;
  probeIp?: string;
  probePort?: number;
  probeUdpEcho?: true;
  weight: number;
  tier?: number;
  line?: number;
  landing?: string;
  spread?: RouteLineDestSpread;
  extraLatencyMs?: number;
  loadPct?: number;
  exitIp?: string;
  down?: true;
  downReason?: string;
};

/** 拼一条规则的目标时，每条路径都一样的东西：心跳在 actionFailover 里算好一次传进来。 */
export type RouteTargetHintContext = {
  ruleId: number;
  /** 目标改成解析后地址的规则（processTarget 过的），拨号地址、出口 IP 都按它算。 */
  routeRule: RouteGroupRule & Record<string, unknown>;
  protocol: unknown;
  /** 聚合 / 复制：每条目标带 tier。 */
  tiered: boolean;
  /** 「落地怎么分」这一回要不要带（routeDestSpreadReady）。 */
  destSpreadReady: boolean;
  /** 暂停、维护中、离线、熔断（routeNodeHints），压过中转探测的结论。 */
  nodeHints: ReadonlyMap<string, RouteHopHint>;
  /** 中转跳探测发现中间断了（routeHopDownHints）。 */
  hopHints: ReadonlyMap<string, RouteHopHint>;
  /** 落地主机的出口地址（面板看到的心跳来源，没有就是登记的地址）。 */
  hostEgressIp: (hostId: number) => string;
};

/** 一个提示看到的东西：路径、它的拨号地址（解析不出来是 null）、整条规则的上下文。 */
export type RouteTargetHintInput = {
  path: RoutePath;
  dial: RouteEndpoint | null;
  context: RouteTargetHintContext;
};

/** 一个提示（装饰器）：给这条目标添几个字段；不该带时返回空对象。 */
export type RouteTargetHint = {
  name: string;
  fields: (input: RouteTargetHintInput) => Partial<RouteFailoverTarget>;
};
