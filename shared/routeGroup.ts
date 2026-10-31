import { LINK_SPREAD_LABELS } from "./linkTerms";
import { readFailoverPin, type FailoverPin } from "./failoverPin";
import { parseFailoverSchedule, type FailoverSchedule } from "./failoverSchedule";
import {
  MAX_FAILOVER_TARGETS,
  formatFailoverEndpoint,
  parseFailoverEndpoint,
  parseFailoverTargets,
  type FailoverTarget,
} from "./failoverTargets";
import { normalizeForwardRuleProtocol } from "./forwardTypes";
import { timestampMillis } from "./timestamp";

/**
 * 线路组：一个入口 + 多条路径 + 一个调度策略。全站唯一一份模型。
 *
 * 上一版的「主备线路」切的是**落地地址**：备用只是一个 `host:port`，要走中转就得另建
 * 一条转发再把它的地址抄进来 —— 用户看到的是「两个独立转发」，而不是「同一个入口后面的
 * 两条路」。线路组把「一条线 = 一个地址」升级成「一条线 = 一条路径」：
 *
 *     转发：美国游戏线路
 *     入口：0.0.0.0:10001
 *     线路组
 *     ├─ A  主线路   HK01 → JP01 → US01:443
 *     └─ B  备用线路 HK02 → SG01 → US01:443
 *     切换策略  ● 自动故障切换 ○ 定时主备 ○ 手动主备 ○ 智能择优 ○ 混合策略 ○ 权重负载
 *
 * 几条定死的语义：
 *
 *   · **入口就是这条规则所在的机器**。客户端连的 IP:端口落在哪台机上，调度层就在哪台机的
 *     Agent 里，所以每条路径的第一跳都从它出发；路径里写的是**中转**（0 到 5 台）和落地。
 *     想让备用从另一台线路机出发，就把那台机写成备用路径的第一个中转。
 *   · **主备只是调度策略，不是转发架构**。六种模式共用同一份路径清单，换模式不用重建路径。
 *   · **切换只改新连接**（平滑切换）。旧连接留在原来那条上，直到它自己结束；要断旧连接
 *     得明确选「强制切换」。
 *   · 路径里的中转由面板在中转机上**按需建中继规则**（见 server/routeGroups.ts），入口
 *     Agent 拿到的仍然是一份「拨哪个地址」的清单（dial）—— Agent 不需要理解路径。
 *
 * 存储：路径存在 forward_rules.routePaths（JSON），策略存在 routeMode 和几列参数上；老的
 * failover* 列由它们**推导**出来（legacyFailoverFields），老 Agent 和老代码照常工作。
 */

/** 主线路 + 备用：Agent 那边出站上限是主线路外加 10 条。 */
export const MAX_ROUTE_PATHS = MAX_FAILOVER_TARGETS + 1;
export const MAX_ROUTE_HOPS = 5;
/** 评分、权重、预热预检、强制切换、上报评分：Agent 2.2.198 起。更老的只按主备切。 */
export const ROUTE_GROUP_AGENT_VERSION = "2.2.198";
/**
 * UDP、TCP+UDP 的线路组：Agent 2.2.199 起（按会话调度，见 agent/route_group_udp.go）。
 *
 * 更老的 Agent 只会开 TCP 监听，前面的转发工具把 UDP 转给它就进了黑洞。所以版本不够时
 * 面板**不下发**调度：流量直接走主线路（路径 A），不切换，等 Agent 升级。
 */
export const ROUTE_GROUP_UDP_AGENT_VERSION = "2.2.199";

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
 * NEX 隧道的线路组：出口 Agent 2.2.199 起。
 *
 * FXP 的出口是整条隧道共用的一个进程，按入口给的目标拨出去（UDP 按面板给出口的 udpTargets），
 * 出口机上没有这条规则自己的进程可以挂调度器。所以出口机收到一条「只跑调度器」的运行规则
 * （runningRules[].schedulerOnly）：只开调度器，不占规则端口、不写端口状态、不装计数链 ——
 * 流量照旧在入口计。入口让出口拨出口本机的调度器。更老的 Agent 认不出 schedulerOnly，会把它
 * 当成普通规则去装端口状态和计数链，所以版本不够时面板不下发，出口直接拨路径 A、不切换。
 */
export const ROUTE_GROUP_FORWARDX_AGENT_VERSION = "2.2.199";

export function routeGroupIsForwardXTunnel(mode: unknown): boolean {
  return String(mode ?? "").trim().toLowerCase() === "forwardx";
}

/** 这条规则的线路组要不要 UDP 调度（Agent 2.2.199 起）。 */
export function routeGroupNeedsUdpAgent(protocol: unknown): boolean {
  return normalizeForwardRuleProtocol(protocol) !== "tcp";
}

/**
 * 调度所在机器的 Agent 至少要多新，面板才下发调度：NEX 隧道、UDP、TCP+UDP 要 2.2.199；
 * 其余返回 null（老 Agent 照老规矩按主备切）。版本不够时前面的转发工具拨路径 A、不切换。
 */
export function routeGroupSchedulerAgentVersion(protocol: unknown, tunnelMode?: unknown): string | null {
  if (routeGroupIsForwardXTunnel(tunnelMode)) return ROUTE_GROUP_FORWARDX_AGENT_VERSION;
  if (routeGroupNeedsUdpAgent(protocol)) return ROUTE_GROUP_UDP_AGENT_VERSION;
  return null;
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
};

export const ROUTE_MODES = ["failover", "scheduled", "manual", "smart", "hybrid", "weighted"] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

/** 权重负载模式下新连接怎么分：按权重、轮流、随机、按访客固定。 */
export const ROUTE_SPREADS = ["weighted", "least_load", "round_robin", "random", "ip_hash"] as const;
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

export const ROUTE_DELIVERY_INFO: Record<RouteDelivery, { label: string; hint: string }> = {
  cold: { label: "冷备", hint: "平时只走一条，备用只做探测；坏了切走，旧连接留在原线路" },
  hot: { label: "热备", hint: "握手慢了同时拨下一条，谁先通用谁；坏了 10 秒内切走，旧连接断开让客户端马上重连（连接一点不断要靠 NEX 隧道自己的热备）" },
  aggregate: { label: "聚合", hint: "主线路那组的几条路径一起分担：新连接分到最空的那条，带宽按连接叠加；单个连接仍走一条（单连接叠加用 NEX 叠加隧道）" },
  replicate: { label: "复制", hint: "主线路走的 NEX 叠加隧道里，同一份数据在几条腿上同时发，一条腿断了连接不断（隧道要开「复制」）" },
};

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

export type RouteModeInfo = {
  label: string;
  /** 选项下面那一句：它会怎么做。 */
  hint: string;
  /** 策略模板的名字：创建线路组时先问「你希望怎么用这些线路」，答案就是它。 */
  template: string;
};

export const ROUTE_MODE_INFO: Record<RouteMode, RouteModeInfo> = {
  failover: { label: "自动故障切换", template: "稳定优先", hint: "平时只走主线路，出问题自动换到下一条；主线路恢复并稳定一阵子再切回" },
  scheduled: { label: "定时主备", template: "早晚高峰", hint: "按时段表决定首选（比如晚高峰走 B），时段外回主线路；出问题照样往下切" },
  manual: { label: "手动主备", template: "人工掌控", hint: "一直走你指定的那条，直到你换；它挂了才临时往下切，恢复后再回来" },
  smart: { label: "智能择优", template: "延迟优先", hint: "按线路评分（延迟、丢包、抖动、可用率）走最好的一条；分差够大、持续够久才换，不来回漂" },
  hybrid: { label: "混合策略", template: "晚高峰优化", hint: "时段表给出首选，到点前先预热预检；预检不过就不切，继续走当前这条" },
  weighted: { label: "权重负载", template: "负载均衡", hint: "新连接按权重分到各条路径，旧连接不动；哪条出问题就先跳过它" },
};

/** 模板那句说明：纯 UDP 规则没有连接，权重负载那句换成会话；其余几句不提连接，原样用。 */
const ROUTE_MODE_SESSION_HINTS: Partial<Record<RouteMode, string>> = {
  weighted: "新会话按权重分到各条路径，旧会话不动；哪条出问题就先跳过它",
};

export function routeModeHint(mode: RouteMode, perSession = false): string {
  return (perSession && ROUTE_MODE_SESSION_HINTS[mode]) || ROUTE_MODE_INFO[mode].hint;
}

/** 徽标上的两个字：「主备 · 主线路」「定时 · 晚高峰线路」。 */
export const ROUTE_MODE_SHORT: Record<RouteMode, string> = {
  failover: "主备",
  scheduled: "定时",
  manual: "手动",
  smart: "择优",
  hybrid: "混合",
  weighted: "负载",
};

// 名字和出口组的策略同一套（shared/linkTerms.ts），只是这里说的是「路径」。
export const ROUTE_SPREAD_LABELS: Record<RouteSpread, { label: string; hint: string }> = {
  weighted: { label: LINK_SPREAD_LABELS.weighted.label, hint: "新连接按每条路径的权重分配" },
  least_load: { label: LINK_SPREAD_LABELS.least_load.label, hint: "新连接给现在挂着连接最少的那条（按权重折算），长连接多时比按权重更均匀" },
  round_robin: { label: LINK_SPREAD_LABELS.round_robin.label, hint: "新连接轮流走每一条" },
  random: { label: LINK_SPREAD_LABELS.random.label, hint: "新连接随机挑一条能用的" },
  ip_hash: { label: LINK_SPREAD_LABELS.ip_hash.label, hint: "同一个来源 IP 总走同一条，适合要保持登录的服务" },
};

export const ROUTE_SWITCH_MODE_INFO: Record<RouteSwitchMode, { label: string; hint: string }> = {
  smooth: { label: "平滑切换", hint: "旧连接留在原线路，新连接走新线路，基本无感（推荐）" },
  fast: { label: "快速切换", hint: "线路挂了就断开它上面的旧连接，让客户端马上重连到新线路；计划和择优切换仍然平滑" },
  force: { label: "强制切换", hint: "每次切换都断开旧连接，全部客户端立刻走新线路，可能重连" },
};

/*
  纯 UDP 没有连接：Agent 按会话（同一个来源地址发来的包）挑路径，切换时丢的是会话映射，
  下一个包重新挑一条。选项还是那几个，只是说法换成「会话」。
*/
export const ROUTE_SPREAD_SESSION_HINTS: Record<RouteSpread, string> = {
  weighted: "新会话按每条路径的权重分配",
  least_load: "新会话给现在连接最少的那条（按权重折算）",
  round_robin: "新会话轮流走每一条",
  random: "新会话随机挑一条能用的",
  ip_hash: "UDP 分不出访客：同一个会话一直走同一条，同一个访客的不同会话可能分到不同路径",
};

export const ROUTE_SWITCH_MODE_SESSION_HINTS: Record<RouteSwitchMode, string> = {
  smooth: "已有的会话留在原路径，新会话走新路径，基本无感（推荐）",
  fast: "路径挂了就丢掉它上面的会话，下一个包改走新路径；计划和择优切换仍然平滑",
  force: "每次切换都丢掉旧会话，下一个包改走新路径",
};

/**
 * 策略模板：选一种用法，切换保护的参数按推荐值预填。
 *
 * 普通用户不需要理解 failover threshold / hold-down / prewarm；选「稳定优先」就得到一组
 * 能直接用的数。高级用户再去「高级策略」里调。数值的来源：连续失败 3 次才标记异常、
 * 持续异常 10 秒才切、恢复要稳定 5 分钟、刚切过去至少驻留 10 分钟 —— 这组数拦得住
 * 网络抖一下引起的 A → B → A → B。
 */
/** Agent 多久探一轮线路（2.2.244 起跟着「异常多久切」走：它的一半，1–5 秒）。 */
export function routeProbeIntervalSeconds(failoverSeconds: number) {
  return Math.min(5, Math.max(1, Number(failoverSeconds || 0) / 2));
}

/**
 * 坏了最多多少秒切走（界面上「N 秒内切走」）。最坏的情况是刚探完就坏：等下一轮探到，再要连续失败够次数、
 * 而且持续异常够「异常多久切」。真实连接拨不通会当场换下一条，不用等这么久。
 */
export function routeSwitchWithinSeconds(policy: { failoverSeconds?: number | null; failureThreshold?: number | null }) {
  const failoverSeconds = Math.max(0, Number(policy.failoverSeconds || 0));
  const threshold = Math.max(1, Math.round(Number(policy.failureThreshold || 1)));
  const probe = routeProbeIntervalSeconds(failoverSeconds);
  return Math.ceil(probe + Math.max(failoverSeconds, (threshold - 1) * probe));
}

export function routeTemplateGuards(mode: RouteMode): RouteGuards {
  // 坏了尽快切走（连续 2 次、3 秒，Agent 1.5 秒探一轮，5 秒内切走）；切回照旧稳着来（恢复 5 分钟、至少驻留 10 分钟）。
  const base: RouteGuards = {
    ...ROUTE_GUARD_DEFAULTS,
    failureThreshold: 2,
    failoverSeconds: 3,
    recoverSeconds: 300,
    minHoldSeconds: 600,
    autoFailback: true,
  };
  switch (mode) {
    case "manual":
      // 人工指定的那条恢复了就该回去，不用驻留拦着。
      return { ...base, minHoldSeconds: 0 };
    case "weighted":
      // 分摊流量时没有「切回」这件事，驻留也没有意义。
      return { ...base, minHoldSeconds: 0 };
    case "smart":
    case "hybrid":
      // 整链最优：别的线路明显更快、持续 30 秒就切（快得多的 Agent 10 秒就切）；切过去至少走 1 分钟，防来回漂。
      return { ...base, minHoldSeconds: 60, scoreMargin: 10, scoreHoldSeconds: 30, prewarmSeconds: 300 };
    default:
      return base;
  }
}

/** 定时 / 混合模式默认的时段：工作日晚高峰走第二条路径。 */
export function defaultRouteSchedule(timezone: string, pathCount: number): FailoverSchedule {
  return { timezone, windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: Math.min(1, Math.max(0, pathCount - 1)) }] };
}

/** 换模式时策略该长什么样：参数按模板预填，只保留仍然适用的时段表和指定。 */
export function applyRouteMode(policy: RouteGroupPolicy, mode: RouteMode, options: { timezone: string; pathCount: number }): RouteGroupPolicy {
  const guards = routeTemplateGuards(mode);
  const keepsSchedule = mode === "scheduled" || mode === "hybrid";
  const schedule = keepsSchedule
    ? (policy.schedule && policy.schedule.windows.length > 0 ? policy.schedule : defaultRouteSchedule(options.timezone, options.pathCount))
    : null;
  const pin = mode === "manual"
    ? (policy.pin || { index: 0, untilMs: null })
    : mode === "weighted" ? null : policy.pin;
  return { ...policy, ...guards, mode, spread: mode === "weighted" ? (policy.spread || "weighted") : policy.spread, schedule, pin };
}

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

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function sanitizeEndpoint(raw: unknown): RouteEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const ip = String((raw as any).ip ?? (raw as any).host ?? "").trim();
  const port = Math.floor(Number((raw as any).port));
  if (!ip || !(port >= 1 && port <= 65535)) return null;
  return { ip, port };
}

/** 一段稳定的路径标识。字母开头、够短、够随机，切换历史里看着不刺眼。 */
export function newRoutePathKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let key = alphabet[Math.floor(Math.random() * 26)];
  for (let index = 0; index < 5; index += 1) key += alphabet[Math.floor(Math.random() * alphabet.length)];
  return key;
}

const PATH_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function sanitizePath(raw: any, index: number): RoutePath | null {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key ?? "").trim().toLowerCase();
  const hops = Array.isArray(raw.hops)
    ? Array.from(new Set(raw.hops.map((hop: unknown) => Math.floor(Number(hop))).filter((hop: number) => Number.isInteger(hop) && hop > 0)))
      .slice(0, MAX_ROUTE_HOPS) as number[]
    : [];
  const hopVia = Array.isArray(raw.hopVia) && raw.hopVia.length === hops.length
    ? raw.hopVia.map((value: unknown) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : null))
    : undefined;
  const tier = raw.tier === null || raw.tier === undefined || raw.tier === "" ? undefined : clampInt(raw.tier, 0, MAX_ROUTE_PATHS, 0);
  const lineKey = typeof raw.lineKey === "string" && PATH_KEY_PATTERN.test(raw.lineKey.trim().toLowerCase()) ? raw.lineKey.trim().toLowerCase() : undefined;
  return {
    key: PATH_KEY_PATTERN.test(key) ? key : `p${index + 1}`,
    name: String(raw.name ?? "").trim().slice(0, 40),
    hops,
    ...(hopVia && hopVia.some((value: number | null) => value !== null) ? { hopVia } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(raw.paused === true || raw.paused === 1 || raw.paused === "1" ? { paused: true } : {}),
    ...(lineKey ? { lineKey } : {}),
    dest: sanitizeEndpoint(raw.dest),
    destNodeId: Number.isInteger(Number(raw.destNodeId)) && Number(raw.destNodeId) > 0 ? Math.floor(Number(raw.destNodeId)) : null,
    ...(Number.isInteger(Number(raw.destHostId)) && Number(raw.destHostId) > 0 && Number(raw.destNodeId) > 0 ? { destHostId: Math.floor(Number(raw.destHostId)) } : {}),
    weight: clampInt(raw.weight, ROUTE_GUARD_LIMITS.weight.min, ROUTE_GUARD_LIMITS.weight.max, 50),
    probe: sanitizeEndpoint(raw.probe),
    dial: sanitizeEndpoint(raw.dial),
    issue: String(raw.issue ?? "").trim().slice(0, 200) || null,
  };
}

/** routePaths 那一列（JSON 或已解析的数组）→ 路径清单。认不出的一律扔掉，不猜。 */
export function parseRoutePaths(raw: unknown): RoutePath[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    const paths = parsed.map(sanitizePath).filter((path): path is RoutePath => !!path).slice(0, MAX_ROUTE_PATHS);
    // key 撞了后面的那条改名：两条同名路径会让切换历史指向不清。
    const seen = new Set<string>();
    return paths.map((path, index) => {
      let key = path.key;
      while (seen.has(key)) key = `${path.key}-${index + 1}`;
      seen.add(key);
      return key === path.key ? path : { ...path, key };
    });
  } catch {
    return [];
  }
}

export function serializeRoutePaths(paths: RoutePath[] | null | undefined): string | null {
  if (!paths || paths.length === 0) return null;
  return JSON.stringify(paths.map((path) => ({
    key: path.key,
    name: path.name,
    hops: path.hops,
    dest: path.dest,
    ...(path.destNodeId ? { destNodeId: path.destNodeId } : {}),
    ...(path.destNodeId && path.destHostId ? { destHostId: path.destHostId } : {}),
    weight: path.weight,
    probe: path.probe,
    dial: path.dial,
    ...(path.issue ? { issue: path.issue } : {}),
    ...(path.hopVia && path.hopVia.some((value) => value !== null) ? { hopVia: path.hopVia } : {}),
    ...(typeof path.tier === "number" ? { tier: path.tier } : {}),
    ...(path.paused ? { paused: true } : {}),
    ...(path.lineKey ? { lineKey: path.lineKey } : {}),
  })));
}

/** 「主线路」「备用 1」：没起名时的默认叫法，和老主备一致。 */
export function defaultRoutePathName(index: number): string {
  return index === 0 ? "主线路" : `备用 ${index}`;
}

export function routePathLabel(path: Pick<RoutePath, "name"> | null | undefined, index: number): string {
  return String(path?.name || "").trim() || defaultRoutePathName(index);
}

/** 路径的字母序号：A、B、C…… 卡片和切换历史里用它当短称。 */
export function routePathLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `#${index + 1}`;
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

function truthy(value: unknown, fallback: boolean) {
  if (value === null || value === undefined) return fallback;
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function endpointOfFailoverTarget(target: FailoverTarget): RouteEndpoint {
  return { ip: target.targetIp, port: target.targetPort };
}

function probeOfFailoverTarget(target: FailoverTarget): RouteEndpoint | null {
  return target.probeIp && target.probePort ? { ip: target.probeIp, port: target.probePort } : null;
}

/**
 * 老主备 → 路径清单：主线路是规则自己的目标，备用各是一个直连的落地。
 *
 * 只在 routePaths 还是空的时候用（2.3.376 之前配的主备）。保存一次之后 routePaths 就有了，
 * 之后以它为准 —— 它才存得下中转。
 */
export function legacyRoutePaths(rule: RouteGroupRule): RoutePath[] {
  const mainProbe = parseFailoverEndpoint(rule.failoverProbeTarget);
  const main: RoutePath = {
    key: "main",
    name: "",
    hops: [],
    dest: null,
    destNodeId: null,
    weight: 50,
    probe: mainProbe && !("error" in mainProbe) ? { ip: mainProbe.host, port: mainProbe.port } : null,
    dial: null,
    issue: null,
  };
  const backups = parseFailoverTargets(rule.failoverTargets).map((target, index): RoutePath => ({
    key: `backup-${index + 1}`,
    name: "",
    hops: [],
    destNodeId: null,
    dest: endpointOfFailoverTarget(target),
    weight: 50,
    probe: probeOfFailoverTarget(target),
    dial: null,
    issue: null,
  }));
  return [main, ...backups];
}

/** 这条规则的路径清单：有 routePaths 就用它，没有就从老主备推。 */
export function routePathsOf(rule: RouteGroupRule): RoutePath[] {
  const stored = parseRoutePaths(rule.routePaths);
  return stored.length > 0 ? stored : legacyRoutePaths(rule);
}

/** 这条路径的落地：没写就是规则自己的目标。 */
export function routePathDestination(path: RoutePath, rule: Pick<RouteGroupRule, "targetIp" | "targetPort">): RouteEndpoint {
  if (path.dest) return path.dest;
  return { ip: String(rule.targetIp || "").trim(), port: Math.floor(Number(rule.targetPort) || 0) };
}

/**
 * 入口 Agent 拨的地址。
 *
 * 有中转而还没解析出 dial 的路径拨不了 —— 返回 null，调用方该把它当成不可用，而不是
 * 退回直连落地：那会绕过中转，和用户配的路径不是一回事。
 */
export function routePathDial(path: RoutePath, rule: Pick<RouteGroupRule, "targetIp" | "targetPort">): RouteEndpoint | null {
  if (path.dial) return path.dial;
  if (path.hops.length > 0) return null;
  const dest = routePathDestination(path, rule);
  return dest.ip && dest.port > 0 ? dest : null;
}

/**
 * 老 failover* 列的读法，和上一版一样；只是「模式」这个概念在老数据里要推：
 * 分配方式不是主备的就是权重负载（轮流 / 随机 / 按访客），开了自动择优就是智能择优，
 * 有时段表就是定时主备，其余都是自动故障切换。
 */
export function routePolicyOf(rule: RouteGroupRule, options: { nowMs?: number; pathCount?: number } = {}): RouteGroupPolicy {
  const paths = options.pathCount ?? routePathsOf(rule).length;
  const strategy = String(rule.failoverStrategy || "fallback");
  const schedule = parseFailoverSchedule(rule.failoverSchedule);
  const preferFastest = truthy(rule.failoverPreferFastest, false);
  const pin = readFailoverPin(rule as any, { nowMs: options.nowMs, lineCount: paths });
  let mode = normalizeRouteMode(rule.routeMode);
  if (!mode) {
    if (strategy !== "fallback") mode = "weighted";
    else if (schedule && preferFastest) mode = "hybrid";
    else if (schedule) mode = "scheduled";
    else if (preferFastest) mode = "smart";
    else mode = "failover";
  }
  return {
    mode,
    spread: strategy === "fallback" ? "weighted" : normalizeRouteSpread(strategy),
    schedule: mode === "scheduled" || mode === "hybrid" ? schedule : null,
    pin: mode === "weighted" ? null : pin,
    failureThreshold: clampInt(rule.routeFailureThreshold, ROUTE_GUARD_LIMITS.failureThreshold.min, ROUTE_GUARD_LIMITS.failureThreshold.max, ROUTE_GUARD_DEFAULTS.failureThreshold),
    failoverSeconds: clampInt(rule.failoverSeconds, ROUTE_GUARD_LIMITS.failoverSeconds.min, ROUTE_GUARD_LIMITS.failoverSeconds.max, ROUTE_GUARD_DEFAULTS.failoverSeconds),
    recoverSeconds: clampInt(rule.recoverSeconds, ROUTE_GUARD_LIMITS.recoverSeconds.min, ROUTE_GUARD_LIMITS.recoverSeconds.max, ROUTE_GUARD_DEFAULTS.recoverSeconds),
    minHoldSeconds: clampInt(rule.failoverMinHoldSeconds, ROUTE_GUARD_LIMITS.minHoldSeconds.min, ROUTE_GUARD_LIMITS.minHoldSeconds.max, ROUTE_GUARD_DEFAULTS.minHoldSeconds),
    autoFailback: truthy(rule.autoFailback, true),
    scoreMargin: clampInt(rule.routeScoreMargin, ROUTE_GUARD_LIMITS.scoreMargin.min, ROUTE_GUARD_LIMITS.scoreMargin.max, ROUTE_GUARD_DEFAULTS.scoreMargin),
    scoreHoldSeconds: clampInt(rule.routeScoreHoldSeconds, ROUTE_GUARD_LIMITS.scoreHoldSeconds.min, ROUTE_GUARD_LIMITS.scoreHoldSeconds.max, ROUTE_GUARD_DEFAULTS.scoreHoldSeconds),
    prewarmSeconds: clampInt(rule.routePrewarmSeconds, ROUTE_GUARD_LIMITS.prewarmSeconds.min, ROUTE_GUARD_LIMITS.prewarmSeconds.max, ROUTE_GUARD_DEFAULTS.prewarmSeconds),
    switchMode: normalizeRouteSwitchMode(rule.routeSwitchMode),
    delivery: normalizeRouteDelivery(rule.routeDelivery),
  };
}

/** 整个线路组：路径 + 策略。没开主备返回 null。 */
export function routeGroupOf(rule: RouteGroupRule, options: { nowMs?: number } = {}): RouteGroup | null {
  if (!truthy(rule.failoverEnabled, false)) return null;
  const paths = routePathsOf(rule);
  return { paths, policy: routePolicyOf(rule, { nowMs: options.nowMs, pathCount: paths.length }) };
}

/** Agent 拿到的分配策略名：权重负载按它的分法，其余都是主备（fallback）。 */
export function routeAgentStrategy(policy: Pick<RouteGroupPolicy, "mode" | "spread">): "fallback" | RouteSpread {
  return policy.mode === "weighted" ? policy.spread : "fallback";
}

/**
 * 下发给 Agent 的分配策略，算上「备用怎么候着」：聚合 = 主线路那一组里按负载分（Agent 只在最低健康
 * tier 里挑，备用组照旧等着）；「按负载」老 Agent 不认（会退成主备），改发「按权重」。
 */
export function routeDeliveryStrategy(
  policy: Pick<RouteGroupPolicy, "mode" | "spread">,
  delivery: RouteDelivery,
  agentAtLeast: (version: string) => boolean,
): "fallback" | RouteSpread {
  const leastLoad = agentAtLeast(ROUTE_LEAST_LOAD_AGENT_VERSION) ? "least_load" : "weighted";
  if (delivery === "aggregate") return leastLoad;
  const strategy = routeAgentStrategy(policy);
  return strategy === "least_load" ? leastLoad : strategy;
}

/** 「按负载」：Agent 2.2.232 起（和 shared/exitStrategy 的 LEAST_LOAD_AGENT_VERSION 同一个）。 */
export const ROUTE_LEAST_LOAD_AGENT_VERSION = "2.2.232";

/** 线路（分层候选、tier、整链打分、热备抢拨、保存即测）：Agent 2.2.243 起。 */
export const ROUTE_LINES_AGENT_VERSION = "2.2.243";

/**
 * 线路组 → 老 failover* 列。
 *
 * 老列继续存着，两个原因：老 Agent（2.2.197 及更早）只认它们；面板里一大批读规则的
 * 代码（列表徽标、策略面板、Telegram）也读它们。它们是推导出来的，**不是**第二份配置：
 * 保存时一起写，读的时候以 routePaths / routeMode 为准。
 */
export function legacyFailoverFields(group: RouteGroup, rule: Pick<RouteGroupRule, "targetIp" | "targetPort">) {
  const { policy, paths } = group;
  const backups: FailoverTarget[] = paths.slice(1).flatMap((path) => {
    const dial = routePathDial(path, rule);
    if (!dial) return [];
    const probe = path.probe;
    return [probe ? { targetIp: dial.ip, targetPort: dial.port, probeIp: probe.ip, probePort: probe.port } : { targetIp: dial.ip, targetPort: dial.port }];
  });
  const main = paths[0];
  const usesSchedule = policy.mode === "scheduled" || policy.mode === "hybrid";
  const pin = policy.mode === "weighted" ? null : policy.pin;
  return {
    failoverStrategy: routeAgentStrategy(policy),
    failoverTargets: JSON.stringify(backups),
    failoverProbeTarget: main?.probe ? formatFailoverEndpoint(main.probe.ip, main.probe.port) : null,
    failoverSchedule: usesSchedule && policy.schedule && policy.schedule.windows.length > 0 ? JSON.stringify(policy.schedule) : null,
    failoverMinHoldSeconds: policy.minHoldSeconds,
    failoverPinnedIndex: pin ? pin.index : null,
    failoverPinnedUntil: pin ? pin.untilMs : null,
    failoverPreferFastest: policy.mode === "smart" || policy.mode === "hybrid",
    failoverSeconds: policy.failoverSeconds,
    recoverSeconds: policy.recoverSeconds,
    autoFailback: policy.autoFailback,
  };
}

/**
 * 线路组 → 规则上的全部相关列（老 failover* 列 + 新 route* 列）。
 *
 * 编辑框里拿还没保存的表单算「此刻」时用它拼出一条「规则」喂给 describeRoutePolicy；服务端
 * 落库时也是这一份，所以编辑框里看到的和保存后面板算出来的是同一套。
 */
export function routeGroupRuleFields(group: RouteGroup, rule: Pick<RouteGroupRule, "targetIp" | "targetPort">) {
  const { policy } = group;
  return {
    ...legacyFailoverFields(group, rule),
    routeMode: policy.mode,
    routePaths: serializeRoutePaths(group.paths),
    routeSwitchMode: policy.switchMode,
    routeFailureThreshold: policy.failureThreshold,
    routeScoreMargin: policy.scoreMargin,
    routeScoreHoldSeconds: policy.scoreHoldSeconds,
    routePrewarmSeconds: policy.prewarmSeconds,
    routeDelivery: normalizeRouteDelivery(policy.delivery),
  };
}

/** 一条新的路径：还没有中转、落地同规则目标、权重和别的路径一样。 */
export function newRoutePath(index: number, patch: Partial<RoutePath> = {}): RoutePath {
  return { key: newRoutePathKey(), name: defaultRoutePathName(index), hops: [], dest: null, destNodeId: null, weight: 50, probe: null, dial: null, issue: null, ...patch };
}

/** 勾上「线路组」那一刻的草稿：主线路 + 一条空的备用，稳定优先模板。 */
export function newRouteGroupDraft(options: { timezone: string }): RouteGroup {
  const paths = [newRoutePath(0), newRoutePath(1)];
  const base: RouteGroupPolicy = { ...ROUTE_GUARD_DEFAULTS, mode: "failover", spread: "weighted", schedule: null, pin: null };
  return { paths, policy: applyRouteMode(base, "failover", { timezone: options.timezone, pathCount: paths.length }) };
}

export type RouteGroupValidationContext = {
  /** 入口机器：路径的中转不能是它自己。 */
  entryHostId: number | null;
  /** 认得的主机 id；不给就不查中转存不存在。 */
  hostIds?: Set<number> | null;
  /** 规则自己的目标填了没有：没写落地的路径要靠它。 */
  hasRuleTarget: boolean;
  /** 两条路径一模一样时拒绝（新编辑框按线路提交时开；老数据里已有的重复不拦，免得改别的字段也存不了）。 */
  rejectDuplicates?: boolean;
};

/**
 * 线路组能不能保存；null 表示可以。只报第一个问题：一次列三条没人读。
 *
 * 客户端提交前和服务端落库前跑的是同一份，所以「面板收下了、机器上不生效」这种分家
 * 不会发生在校验这一层。
 */
export function validateRouteGroup(group: RouteGroup, context: RouteGroupValidationContext): string | null {
  const { paths, policy } = group;
  if (paths.length < 2) return "线路组至少要两条路径：主线路之外再加一条";
  if (paths.length > MAX_ROUTE_PATHS) return `最多 ${MAX_ROUTE_PATHS} 条路径`;
  const keys = new Set<string>();
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const label = routePathLabel(path, index);
    if (keys.has(path.key)) return `路径「${label}」的标识重复了`;
    keys.add(path.key);
    if (path.hops.length > MAX_ROUTE_HOPS) return `「${label}」最多经过 ${MAX_ROUTE_HOPS} 台中转`;
    if (context.entryHostId && path.hops.includes(context.entryHostId)) return `「${label}」的中转不能是入口机器自己`;
    if (new Set(path.hops).size !== path.hops.length) return `「${label}」里同一台中转出现了两次`;
    if (path.hopVia && path.hopVia.length !== path.hops.length) return `「${label}」的隧道段和中转对不上`;
    if (context.hostIds) {
      // 隧道段到的是隧道出口机：用的是隧道的权限（建中继时查），不要求它在自己的主机列表里。
      const missing = path.hops.find((hop, index) => !path.hopVia?.[index] && !context.hostIds!.has(hop));
      if (missing !== undefined) return `「${label}」里有一台中转不在你的主机列表里`;
    }
    if (!path.dest && !context.hasRuleTarget) return `「${label}」没写落地，而规则的目标也还没填`;
  }
  if (policy.mode === "scheduled" && (!policy.schedule || policy.schedule.windows.length === 0)) {
    return "定时主备要至少配一个时段";
  }
  if (policy.schedule) {
    const bad = policy.schedule.windows.find((window) => window.targetIndex >= paths.length);
    if (bad) return `时段表指向了第 ${bad.targetIndex + 1} 条路径，可是一共只有 ${paths.length} 条`;
  }
  if (policy.mode === "manual" && !policy.pin) return "手动主备要指定走哪条路径";
  if (policy.pin && policy.pin.index >= paths.length) return "指定的路径不存在了";
  if (policy.mode === "weighted" && policy.spread === "weighted" && paths.every((path) => path.weight <= 0)) {
    return "权重不能全是 0";
  }
  if (paths.every((path) => path.paused)) return "不能把所有线路都暂停：至少留一条能走";
  // 两条路径走的是同一条路（同样的中转、同样的隧道段、同一个落地）：备用等于没备。
  const signatures = new Map<string, number>();
  for (let index = 0; context.rejectDuplicates && index < paths.length; index += 1) {
    const path = paths[index];
    // 落地池的几台成员是同一个池节点、不同的机器（destHostId），不算重复
    const dest = path.destNodeId ? `n${path.destNodeId}${path.destHostId ? `h${path.destHostId}` : ""}` : path.dest ? `${path.dest.ip}:${path.dest.port}` : "";
    const signature = `${path.hops.join(".")}|${(path.hopVia || []).map((value) => value ?? "").join(".")}|${dest}`;
    const previous = signatures.get(signature);
    if (previous !== undefined) return `「${routePathLabel(paths[previous], previous)}」和「${routePathLabel(path, index)}」走的是同一条路：备用要换一台中转、一条隧道或者一个落地`;
    signatures.set(signature, index);
  }
  return null;
}

/** 「HK01 → JP01 → US01:443」：路径怎么走的一句话，给列表、事件、Telegram 用。 */
export function describeRoutePath(
  path: RoutePath,
  rule: Pick<RouteGroupRule, "targetIp" | "targetPort">,
  hostName: (hostId: number) => string,
): string {
  const dest = routePathDestination(path, rule);
  const stops = path.hops.map((hop) => hostName(hop));
  stops.push(dest.ip ? formatFailoverEndpoint(dest.ip, dest.port) : "落地");
  return stops.join(" → ");
}

export const ROUTE_EVENT_KINDS = ["switch", "unhealthy", "recovered", "precheck_failed", "prewarm", "pinned", "unpinned", "issue", "flap_hold", "slow_dial"] as const;
export type RouteEventKind = (typeof ROUTE_EVENT_KINDS)[number];

export const ROUTE_EVENT_KIND_LABELS: Record<RouteEventKind, string> = {
  switch: "切换",
  unhealthy: "线路异常",
  recovered: "线路恢复",
  precheck_failed: "计划切换未执行",
  prewarm: "预热",
  pinned: "人工指定",
  unpinned: "交回自动",
  issue: "路径不可用",
  flap_hold: "抖动抑制",
  slow_dial: "连接变慢",
};

export function normalizeRouteEventKind(value: unknown): RouteEventKind | null {
  const text = String(value ?? "").trim() as RouteEventKind;
  return (ROUTE_EVENT_KINDS as readonly string[]).includes(text) ? text : null;
}

/**
 * Agent 报上来的切换原因 → 人话。
 *
 * Agent 里原因是几个固定的英文短语（health check / dial failed / schedule / score / pin /
 * failback / precheck / relay down: …），Go 那边不做中文。翻译只在这一处，Telegram 和
 * 界面说的才是同一句。
 */
export function describeRouteReason(reason: unknown): string {
  const text = String(reason ?? "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  if (lower === "health check") return "连续探测不通";
  if (lower === "dial failed") return "新连接拨不通";
  if (lower === "schedule") return "按时段表";
  if (lower === "score") return "线路评分更优";
  if (lower === "pin") return "人工指定";
  if (lower === "unpin" || lower === "pin expired") return "指定到期，交回自动";
  if (lower === "failback") return "首选恢复，切回";
  if (lower === "startup" || lower === "spec updated") return "线路组重新下发";
  if (lower === "relay recovered") return "中转恢复";
  if (lower.startsWith("precheck:")) return `预检未通过：${describeRouteIssue(text.slice("precheck:".length))}`;
  if (lower.startsWith("relay down") || lower === "paused" || lower.startsWith("maintenance:") || lower.startsWith("node offline:") || lower.startsWith("breaker:")) return describeRouteIssue(text);
  if (lower.startsWith("panel:")) return text.slice("panel:".length).trim();
  // Agent 的抖动抑制：flap: 3 switches in 1h, hold 5m until 2026-…
  const flap = /^flap:\s*(\d+)\s+switches in 1h,\s*hold\s+(\d+)m/i.exec(text);
  if (flap) return `一小时内自动切了 ${flap[1]} 次，线路在来回漂：暂停自动切换 ${flap[2]} 分钟（当前线路挂了照样切）`;
  // Agent 的真实连接反馈：slow dial: 820ms x3, probe 40ms
  const slow = /^slow dial:\s*(\d+)ms\s*x(\d+),\s*probe\s+(\d+)ms/i.exec(text);
  if (slow) return `新连接连续 ${slow[2]} 次拨得慢（拨号约 ${slow[1]}ms${Number(slow[3]) > 0 ? `，探测 ${slow[3]}ms` : ""}）：记一次失败，立刻复查`;
  return text;
}

/**
 * Agent 预检 / 中转探测报的问题 → 人话：unreachable、latency 520ms、loss 6%、relay down: JP01。
 * 面板自己写的问题（中转离线、没有入口地址）本来就是中文，原样过。
 */
export function describeRouteIssue(issue: unknown): string {
  const text = String(issue ?? "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  if (lower === "unreachable") return "连不上";
  if (lower === "relay down") return "中转异常";
  if (lower.startsWith("relay down:")) return `中转异常：${text.slice("relay down:".length).trim()}`;
  const latency = /^latency\s+(\d+)\s*ms$/i.exec(text);
  if (latency) return `延迟 ${latency[1]}ms`;
  const loss = /^loss\s+(\d+(?:\.\d+)?)\s*%$/i.exec(text);
  if (loss) return `丢包 ${loss[1]}%`;
  if (lower === "path unresolved") return "路径还没解析出拨号地址";
  if (lower === "paused") return "已手动暂停";
  if (lower.startsWith("maintenance:")) return `${text.slice("maintenance:".length).trim()} 维护中`;
  if (lower.startsWith("node offline:")) return `${text.slice("node offline:".length).trim()} 离线`;
  if (lower.startsWith("breaker:")) return `${text.slice("breaker:".length).trim()} 熔断：几条线路都探不通它`;
  return text;
}

/** 权重按比例换算成百分比，给界面和 Telegram 写「A 70% / B 30%」。 */
export function routeWeightShares(paths: Pick<RoutePath, "weight">[]): number[] {
  const total = paths.reduce((sum, path) => sum + Math.max(0, path.weight), 0);
  if (total <= 0) return paths.map(() => Math.round(100 / Math.max(1, paths.length)));
  return paths.map((path) => Math.round((Math.max(0, path.weight) / total) * 100));
}

/** 事件里的时刻统一成 Unix 毫秒；库里读出来的是 Date 或秒。 */
export function routeEventMillis(value: unknown): number {
  return timestampMillis(value);
}
