import { normalizeExitGroupStrategy } from "@shared/exitStrategy";
import { BALANCE_ANTI_FLAP, GOST_BALANCE_MAX_EXITS, type BalanceDetect } from "@shared/loadBalance";

/*
  GOST 隧道的出口组交给入口机的本机代理挑（入口机的 Agent 要能执行统一调度：shared/loadBalance.ts 的 agentSupportsUnifiedBalance）。

  2.3.539 加过一版「GOST 由入口自己切」，可从来没生效：下发前有一句「入口要带目标就跳过」，而 GOST 的 relay
  隧道入口永远要带目标（出口拨哪儿是入口在 relay 请求里说的），所以每条规则都被跳过；就算不跳，每台出口的本机
  gost 服务没有 forwarder，出口不知道该拨哪儿，流量也是断的。这一版把两头都补上，并把 UDP、访客地址、
  PROXY protocol、手动指定一起接过来。

  数据怎么走（入口机上）：

    公网端口（gost 听：计数、限速、连接数限制都还在这里；它给每条连接 / 每个 UDP 会话先发一个 PROXY 头）
      → 127.0.0.1:调度端口（Agent 的 failoverProxy，和线路组同一个调度器，挑出口）
      → 127.0.0.1:每台出口一个本机 gost 端口（单节点链，没有选择器；forwarder 是出口该拨的目标）
      → 出口机的 relay → 目标

  这个文件只管「交给 Agent 的规格」：分配方式怎么对应、探测节奏、权重、手动指定、面板提示。gost 那一半在
  server/agentHeartbeatGostPlan.ts，哪些规则用得上在 agentHeartbeatRoute.ts 的 gostBalancePlans。
  Agent 那边怎么判健康见 agent/failover_exit_group.go。
*/

export type GostBalanceExit = {
  hostId: number;
  /** 入口机上只走这台出口的本机 gost 端口（TCP、UDP 同一个号） */
  localPort: number;
  /** 出口机的拨号地址和隧道监听端口：Agent 直接探它（入口到出口这一段） */
  dialHost: string;
  listenPort: number;
  /** 多跳链路：出口在中转后面，入口机连不到它，不直接探（Agent 靠真实连接被关后的经出口复核和面板提示） */
  viaRelay?: boolean;
};

export type GostBalanceSpecInput = {
  /** 调度端口（127.0.0.1） */
  listenPort: number;
  /** 规则的协议：tcp / udp / both */
  protocol: string;
  /** 链路的分配方式（tunnels.loadBalanceStrategy） */
  strategy: unknown;
  detect: BalanceDetect;
  tunnelId: number;
  exits: readonly GostBalanceExit[];
  /** 每台出口的份数，和 exits 一一对应；null = 一样大。和 FXP 用的同一个来源（手填份数 / 线路带宽）。 */
  weights: readonly number[] | null;
  /** 手动指定的出口主机（tunnels.balancePinHostId）；0 = 没指定。不看它在不在线：指定的那台坏了由代理当场不理它。 */
  pinHostId: number;
  /** 面板从出口机的探测得知「到目标不通」的出口 */
  downHostIds: ReadonlySet<number>;
  /** 每台出口到规则目标的延迟（出口机探的，毫秒） */
  extraLatencyMs: ReadonlyMap<number, number>;
  /** 规则往目标发 PROXY 头（隧道的「入口发送」）：头原样转过去；否则这个头只是给调度器看访客地址的，读完扔掉。 */
  proxyHeaderForward: boolean;
  proxyProtocolVersion: 1 | 2;
};

/**
 * 面板的分配方式 → 调度器认的策略。
 *
 *   auto          → auto：份数 × 延迟系数 × 负载系数，随机挑两台取更闲的
 *   fallback/none → fallback：按顺序用第一台，坏了换下一台，好了切回（切过去至少待 1 分钟）
 *   ip_hash       → ip_hash：按访客地址加权 rendezvous 哈希（访客地址从 gost 加的 PROXY 头里读）
 *   latency       → fallback + 自动择优：整链延迟（入口探出口 + 出口探目标）明显更好、而且持续够久才换。
 *                   「择优」和「好了切回」不会互相打架（Agent 2.2.263 起：开了择优，同样健康的两台之间由评分
 *                   说了算，不再按顺序切回；agent 的 TestExitGroupLatencyDoesNotPingPong 钉着）
 *   least_load    → least_load：(挂着的连接 + 1) ÷ 份数最小的
 *   weighted      → weighted：平滑加权轮询
 *   round_robin   → round_robin
 *   random        → random
 */
export function gostBalanceProxyStrategy(value: unknown): { strategy: string; preferFastest: boolean } {
  const strategy = normalizeExitGroupStrategy(value);
  if (strategy === "latency") return { strategy: "fallback", preferFastest: true };
  if (strategy === "none") return { strategy: "fallback", preferFastest: false };
  return { strategy, preferFastest: false };
}

/** 份数压进调度器认的 1–100，比例不变（手填的份数可以比 100 大）。 */
export function gostBalanceTargetWeights(weights: readonly number[] | null, count: number): number[] | null {
  if (!weights || weights.length !== count) return null;
  const clean = weights.map((weight) => Math.max(0, Number(weight) || 0));
  const max = Math.max(...clean);
  if (!(max > 0)) return null;
  const scale = max > 100 ? 100 / max : 1;
  return clean.map((weight) => Math.max(1, Math.min(100, Math.round(weight * scale))));
}

/**
 * 探测节奏：照「检测与切换」里填的来。
 *
 *   每 intervalSeconds 一轮（固定节拍），一次探测等 1 秒（间隔 2 秒以内）或 2 秒；
 *   连续 failThreshold 轮不通判坏：failoverSeconds = 间隔 × (次数 − 1)，也就是第 N 轮失败的那一刻；
 *   连着通 recoverThreshold 轮算恢复：recoverSeconds = 间隔 × (次数 − 1)。
 *
 * 默认（2 秒 / 2 次 / 3 次）：出口被黑洞最坏 2 + 2 + 1 = 5 秒摘掉，恢复最坏 2 + 4 = 6 秒回来。
 */
export function gostBalanceProbeTiming(detect: BalanceDetect) {
  const interval = Math.max(1, Math.round(detect.intervalSeconds));
  return {
    probeIntervalSeconds: interval,
    probeTimeoutMs: interval <= 2 ? 1000 : 2000,
    failureThreshold: Math.max(1, detect.failThreshold),
    failoverSeconds: Math.max(1, interval * (Math.max(1, detect.failThreshold) - 1)),
    recoverSeconds: Math.max(1, interval * (Math.max(1, detect.recoverThreshold) - 1)),
  };
}

export function buildGostBalanceProxySpec(input: GostBalanceSpecInput) {
  const exits = input.exits.slice(0, GOST_BALANCE_MAX_EXITS);
  const hostIds = exits.map((exit) => exit.hostId);
  const { strategy, preferFastest } = gostBalanceProxyStrategy(input.strategy);
  const weights = gostBalanceTargetWeights(input.weights, exits.length);
  const timing = gostBalanceProbeTiming(input.detect);
  const pinIndex = input.pinHostId > 0 ? hostIds.indexOf(input.pinHostId) : -1;
  return {
    enabled: true,
    listenPort: input.listenPort,
    bindAddress: "127.0.0.1",
    protocol: input.protocol,
    strategy,
    preferFastest,
    targets: exits.map((exit, index) => {
      const extra = input.extraLatencyMs.get(exit.hostId);
      return {
        targetIp: "127.0.0.1",
        targetPort: exit.localPort,
        // 直接探出口机的隧道监听（入口到出口这一段）；出口到目标那一段由出口机探、经面板给提示
        probeIp: exit.dialHost,
        probePort: exit.listenPort,
        ...(exit.viaRelay ? { viaRelay: true } : {}),
        ...(weights ? { weight: weights[index] } : {}),
        ...(input.downHostIds.has(exit.hostId) ? { down: true, downReason: "出口连不上目标" } : {}),
        ...(extra != null && extra > 0 ? { extraLatencyMs: Math.round(extra) } : {}),
      };
    }),
    failoverSeconds: timing.failoverSeconds,
    recoverSeconds: timing.recoverSeconds,
    failureThreshold: timing.failureThreshold,
    probeIntervalSeconds: timing.probeIntervalSeconds,
    probeTimeoutMs: timing.probeTimeoutMs,
    autoFailback: true,
    // 切过去至少用 1 分钟；一小时切 3 次以上放慢是调度器内置的
    minHoldSeconds: BALANCE_ANTI_FLAP.minHoldSeconds,
    // 延迟优先：更好的那台要连着领先这么久才换（「检测与切换」里的「持续多久才处理」）
    ...(preferFastest ? { scoreHoldSeconds: Math.max(10, input.detect.jitterHoldSeconds) } : {}),
    ...(input.detect.slowStart ? {} : { noSlowStart: true }),
    pinnedIndex: pinIndex >= 0 ? pinIndex : null,
    pinnedUntil: 0,
    // 公网端口上的 gost 总是先发一个 PROXY 头：访客地址从里面读（按访客固定、「连上就被关」算谁的账）。
    // 规则本来就往目标发头的原样转；否则读完扔掉。UDP 的头（v2，一个单独的包）永远是给调度器的。
    proxyProtocolReceive: true,
    ...(input.proxyHeaderForward ? {} : { proxyProtocolStrip: true }),
    proxyProtocolSend: input.proxyHeaderForward,
    proxyProtocolVersion: input.proxyProtocolVersion,
    balanceReport: { tunnelId: input.tunnelId, hostIds },
  };
}

export type GostBalanceProxySpec = ReturnType<typeof buildGostBalanceProxySpec>;
