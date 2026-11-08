/*
  线路组的数据模型：路径、调度策略的类型和取值范围，以及把存储值规整成这些类型的函数。
  shared/routeGroup.ts 统一再导出；别处照旧从 shared/routeGroup 引。
*/
import type { FailoverPin } from "./failoverPin";
import type { FailoverSchedule } from "./failoverSchedule";
import { MAX_FAILOVER_TARGETS } from "./failoverTargets";
import { timestampMillis } from "./timestamp";

/** 主线路 + 备用：Agent 那边出站上限是主线路外加 10 条。 */
export const MAX_ROUTE_PATHS = MAX_FAILOVER_TARGETS + 1;

export const MAX_ROUTE_HOPS = 5;

/**
 * 线路组能挂在哪些转发工具上。
 *
 * 调度层是入口 Agent 里的一个代理：前面的转发工具把连接交给它，它按连接（UDP 按会话）挑
 * 路径。所以前面得是**用户态**转发 —— gost、realm、socat、nginx 都是「收下连接、再自己另拨
 * 一条」，把「另拨」的目标换成调度器就行。iptables / nftables 在内核里改写目的地，没有
 * 「收下连接」这一步，调度器插不进去：它们要切只能改 DNAT 规则，按连接分、旧连接留在原
 * 线路、按路径评分都做不到。
 */
export const ROUTE_GROUP_FORWARD_TYPES = ["gost", "realm", "socat", "nginx"] as const;

export function routeGroupForwardTypeSupported(forwardType: unknown): boolean {
  const normalized = String(forwardType ?? "").trim().toLowerCase();
  return (ROUTE_GROUP_FORWARD_TYPES as readonly string[]).includes(normalized);
}

/**
 * 能挂线路组的隧道：GOST 隧道、Nginx 隧道和 NEX 隧道。调度器都在隧道出口机上：出口的
 * gost / nginx / FXP 把流量交给它。
 */
export const ROUTE_GROUP_TUNNEL_MODES = ["tls", "wss", "tcp", "mtls", "mwss", "mtcp", "nginx_stream", "forwardx"] as const;

export function routeGroupTunnelModeSupported(mode: unknown): boolean {
  const normalized = String(mode ?? "").trim().toLowerCase();
  return (ROUTE_GROUP_TUNNEL_MODES as readonly string[]).includes(normalized);
}

/**
 * NEX 隧道的线路组：FXP 的出口是整条隧道共用的一个进程，按入口给的目标拨出去（UDP 按面板给出口的
 * udpTargets），出口机上没有这条规则自己的进程可以挂调度器。所以出口机收到一条「只跑调度器」的运行规则
 * （runningRules[].schedulerOnly）：只开调度器，不占规则端口、不写端口状态、不装计数链 —— 流量照旧在
 * 入口计。入口让出口拨出口本机的调度器。
 */
export function routeGroupIsForwardXTunnel(mode: unknown): boolean {
  return String(mode ?? "").trim().toLowerCase() === "forwardx";
}

export type RouteEndpoint = { ip: string; port: number };

export type RoutePath = {
  /** 稳定标识：切换历史、时段表、人工指定都按它引用；改名不影响。 */
  key: string;
  /** 「主线路」「晚高峰线路」 */
  name: string;
  /** 中转主机 id，按流量经过的顺序；空 = 入口直连落地。 */
  hops: number[];
  /** 落地；null = 这条规则自己的目标（同一落地）。 */
  dest: RouteEndpoint | null;
  /**
   * 落地选的是「我的节点」时记节点 id：地址端口由面板从节点解析进 dest，节点地址变了跟着改
   * （server/proxyNodeFollow.ts）。null = 手填的 dest 或同目标。
   */
  destNodeId: number | null;
  /**
   * 落地选的是落地池（destNodeId 是池节点，2.3.500）：这条路径落在池里的哪台成员上。地址端口由面板按
   * 那台的成员入站解析进 dest（server/routeGroups.ts），成员去掉了这条路径就用不了。
   */
  destHostId?: number | null;
  /** 权重（权重负载模式按它分新连接），1–100。 */
  weight: number;
  /** 自定探测目标；null = 探拨号地址本身。 */
  probe: RouteEndpoint | null;
  /**
   * 入口 Agent 实际拨的地址。没有中转时就是落地；有中转时是第一跳中转上那条中继规则的
   * 入口地址。由面板解析后写入（server/routeGroups.ts），界面只读。
   */
  dial: RouteEndpoint | null;
  /** 解析时发现的问题（中转离线、没有入口地址、分不出端口）；有它这条路径就用不了。 */
  issue: string | null;
  /**
   * 进入 hops[i] 那一段走哪条隧道（隧道 id）；null / 缺省 = 普通中继。和 hops 等长或为空。
   * 隧道段的中继规则建在上一个节点（入口机或上一跳）上，走这条隧道，隧道出口直接拨下一跳 ——
   * 出口机自己不再建中继（见 server/routeGroups.ts）。
   */
  hopVia?: Array<number | null>;
  /**
   * 第几组：0 = 主线路那一组，1.. = 备用 1、2……。从「线路」展开出来的路径才有（shared/routeLines.ts）；
   * 老数据没有这一项，Agent 就按原来的办法（主备按顺序、择优在全部里挑）。
   */
  tier?: number | null;
  /** 手动暂停：面板给调度器下发「这条用不了」，恢复前不会切过去。 */
  paused?: boolean;
  /** 从哪条线路定义展开来的（routeLines 里的 key）。 */
  lineKey?: string | null;
  /**
   * 这条路径所在的线路有几个落地、选了「一起分」时（2.3.501）：这条线路在用时，新连接在它的几个落地之间
   * 怎么分。只有线路展开出来的路径才有；没有 = 主备（老样子）。
   */
  destSpread?: RouteLineDestSpread | null;
};

/**
 * 一条线路有几个落地（「+ 并列」的、落地池里的几台）时，这条线路在用时新连接怎么用它们（2.3.501）：
 *   one         主备：和以前一样，几个落地里按「怎么切」挑一个走，坏了换下一个
 *   least_load  按负载分：给现在挂着连接最少的那个落地
 *   round_robin 轮流
 *   random      随机
 *   ip_hash     按访客固定：同一个访客 IP 一直走同一个落地
 *   auto        自动：按最近延迟和落地主机的负载算权重，随机挑两个取更好的那个（Agent 2.2.251 起）
 * 「怎么切」照旧决定走哪条线路；按权重（整组一起分）、聚合 / 复制时不用它。Agent 2.2.245 起。
 */
export const ROUTE_DEST_SPREADS = ["one", "least_load", "round_robin", "random", "ip_hash", "auto"] as const;

export type RouteDestSpread = (typeof ROUTE_DEST_SPREADS)[number];

/** 路径上记的：只有「一起分」的几种（主备不记）。 */
export type RouteLineDestSpread = Exclude<RouteDestSpread, "one">;

export function normalizeRouteDestSpread(value: unknown): RouteDestSpread {
  const text = String(value ?? "").trim();
  return (ROUTE_DEST_SPREADS as readonly string[]).includes(text) ? text as RouteDestSpread : "one";
}

export const ROUTE_MODES = ["failover", "scheduled", "manual", "smart", "hybrid", "weighted"] as const;

export type RouteMode = (typeof ROUTE_MODES)[number];

/** 权重负载模式下新连接怎么分：按权重、按负载、轮流、随机、按访客固定、自动（动态权重，Agent 2.2.251 起）。 */
export const ROUTE_SPREADS = ["weighted", "least_load", "round_robin", "random", "ip_hash", "auto"] as const;

export type RouteSpread = (typeof ROUTE_SPREADS)[number];

/**
 * 切换时旧连接怎么办：
 *   smooth  平滑：旧连接留在原线路，新连接走新线路（默认）
 *   fast    快速切换：线路挂了才断旧连接让客户端重连；按计划、按评分切换仍然平滑
 *   force   强制：每次切换都断旧连接
 */
export const ROUTE_SWITCH_MODES = ["smooth", "fast", "force"] as const;

export type RouteSwitchMode = (typeof ROUTE_SWITCH_MODES)[number];

export type RouteGuards = {
  /** 连续探测失败几次才标记异常（新连接拨不通也算一次）。 */
  failureThreshold: number;
  /** 持续异常多少秒才切走。 */
  failoverSeconds: number;
  /** 恢复后要连续正常多少秒才重新启用。 */
  recoverSeconds: number;
  /** 刚切过去之后至少走多久才允许再按优先级切回；0 不限。 */
  minHoldSeconds: number;
  /** 首选恢复后切不切回。 */
  autoFailback: boolean;
  /** 智能择优：候选要比当前高多少分才算「明显更好」。 */
  scoreMargin: number;
  /** 智能择优：明显更好要持续多少秒才切。 */
  scoreHoldSeconds: number;
  /** 计划切换提前多少秒开始预热和预检；0 = 不预热。 */
  prewarmSeconds: number;
  switchMode: RouteSwitchMode;
};

export const ROUTE_GUARD_DEFAULTS: RouteGuards = {
  failureThreshold: 3,
  failoverSeconds: 60,
  recoverSeconds: 120,
  minHoldSeconds: 0,
  autoFailback: true,
  scoreMargin: 10,
  scoreHoldSeconds: 180,
  prewarmSeconds: 300,
  switchMode: "smooth",
};

/*
  2.3.498 起下限放低：异常多久切 / 恢复观察最少 1 秒，择优持续最少 5 秒。Agent 2.2.244 起探测间隔跟着「异常多久切」
  走（一半，1–5 秒），设得短就探得勤，真能几秒内切走；老 Agent 照旧 5 秒一轮，最快也是下一轮探测时切。
*/
export const ROUTE_GUARD_LIMITS = {
  failureThreshold: { min: 1, max: 20 },
  failoverSeconds: { min: 1, max: 3600 },
  recoverSeconds: { min: 1, max: 3600 },
  minHoldSeconds: { min: 0, max: 86400 },
  scoreMargin: { min: 1, max: 60 },
  scoreHoldSeconds: { min: 5, max: 3600 },
  prewarmSeconds: { min: 0, max: 3600 },
  weight: { min: 1, max: 100 },
} as const;

/**
 * 备用线路怎么候着：
 *   cold       冷备：平时只探测，主线路坏了才切（默认，和以前一样）
 *   hot        热备：备用和主线路一样频繁地探，一坏就切、旧连接马上重连；NEX 隧道的路径走热备腿，切换不断连
 *   aggregate  聚合：几条路径同时跑，一个连接拆到多条上（只有 NEX 隧道能做）
 *   replicate  复制：同一份数据在两条路径上同时发，一条断了连接不断（只有 NEX 隧道能做）
 */
export const ROUTE_DELIVERIES = ["cold", "hot", "aggregate", "replicate"] as const;

export type RouteDelivery = (typeof ROUTE_DELIVERIES)[number];

export function normalizeRouteDelivery(value: unknown): RouteDelivery {
  const text = String(value ?? "").trim() as RouteDelivery;
  return (ROUTE_DELIVERIES as readonly string[]).includes(text) ? text : "cold";
}

export type RouteGroupPolicy = RouteGuards & {
  mode: RouteMode;
  spread: RouteSpread;
  schedule: FailoverSchedule | null;
  /** 人工指定：手动主备模式的常态，其余模式的应急开关。 */
  pin: FailoverPin | null;
  /** 备用怎么候着；缺省冷备（老数据）。 */
  delivery?: RouteDelivery;
};

export type RouteGroup = {
  paths: RoutePath[];
  policy: RouteGroupPolicy;
};

export function normalizeRouteMode(value: unknown): RouteMode | null {
  const text = String(value ?? "").trim() as RouteMode;
  return (ROUTE_MODES as readonly string[]).includes(text) ? text : null;
}

export function normalizeRouteSpread(value: unknown): RouteSpread {
  const text = String(value ?? "").trim() as RouteSpread;
  return (ROUTE_SPREADS as readonly string[]).includes(text) ? text : "weighted";
}

export function normalizeRouteSwitchMode(value: unknown): RouteSwitchMode {
  const text = String(value ?? "").trim() as RouteSwitchMode;
  return (ROUTE_SWITCH_MODES as readonly string[]).includes(text) ? text : "smooth";
}

export type RouteGroupRule = {
  failoverEnabled?: unknown;
  targetIp?: unknown;
  targetPort?: unknown;
  failoverTargets?: unknown;
  failoverProbeTarget?: unknown;
  failoverStrategy?: unknown;
  failoverSchedule?: unknown;
  failoverMinHoldSeconds?: unknown;
  failoverPinnedIndex?: unknown;
  failoverPinnedUntil?: unknown;
  failoverPreferFastest?: unknown;
  failoverSeconds?: unknown;
  recoverSeconds?: unknown;
  autoFailback?: unknown;
  routeMode?: unknown;
  routePaths?: unknown;
  routeSwitchMode?: unknown;
  routeFailureThreshold?: unknown;
  routeScoreMargin?: unknown;
  routeScoreHoldSeconds?: unknown;
  routePrewarmSeconds?: unknown;
  routeDelivery?: unknown;
  routeLines?: unknown;
};

export const ROUTE_EVENT_KINDS = ["switch", "unhealthy", "recovered", "precheck_failed", "prewarm", "pinned", "unpinned", "issue", "flap_hold", "slow_dial"] as const;

export type RouteEventKind = (typeof ROUTE_EVENT_KINDS)[number];

export function normalizeRouteEventKind(value: unknown): RouteEventKind | null {
  const text = String(value ?? "").trim() as RouteEventKind;
  return (ROUTE_EVENT_KINDS as readonly string[]).includes(text) ? text : null;
}

/** 事件里的时刻统一成 Unix 毫秒；库里读出来的是 Date 或秒。 */
export function routeEventMillis(value: unknown): number {
  return timestampMillis(value);
}
