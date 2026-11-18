import { normalizeExitGroupStrategy } from "@shared/exitStrategy";
import { FXP_TARGET_AWARE_VERSION } from "@shared/loadBalance";
import { isAgentVersionAtLeast } from "@shared/version";

export type ExitGroupTunnelMember = {
  hostId?: number | null;
  connectHost?: string | null;
  priority?: number | null;
  isEnabled?: boolean | number | string | null;
};

export type TunnelExitEndpointSnapshot = {
  hostId?: number | null;
  listenPort?: number | null;
  mimicPort?: number | null;
  connectHost?: string | null;
};

export type PlannedTunnelExitEndpoint = {
  hostId: number;
  listenPort: number;
  mimicPort: number;
  connectHost: string | null;
};

function memberEnabled(value: unknown) {
  // SQLite/MySQL adapters may expose a boolean column as a number or string.
  // In particular, the string "0" is truthy in JavaScript and must not make
  // a disabled exit participate in endpoint planning.  Missing values retain
  // the schema's enabled-by-default behaviour.
  if (value === undefined || value === null || value === "") return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "0" || normalized === "false") return false;
  }
  return true;
}

export function planExitGroupTunnelEndpoints(
  members: ExitGroupTunnelMember[],
  existingEndpoints: TunnelExitEndpointSnapshot[],
): PlannedTunnelExitEndpoint[] {
  const existingByHostId = new Map<number, TunnelExitEndpointSnapshot>();
  for (const endpoint of existingEndpoints) {
    const hostId = Number(endpoint?.hostId || 0);
    if (hostId > 0 && !existingByHostId.has(hostId)) existingByHostId.set(hostId, endpoint);
  }

  const seen = new Set<number>();
  return [...members]
    .sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0))
    .filter((member) => memberEnabled(member.isEnabled))
    .map((member) => ({ ...member, hostId: Number(member.hostId || 0) }))
    .filter((member) => {
      if (member.hostId <= 0 || seen.has(member.hostId)) return false;
      seen.add(member.hostId);
      return true;
    })
    .map((member) => {
      const existing = existingByHostId.get(member.hostId);
      return {
        hostId: member.hostId,
        listenPort: Number(existing?.listenPort || 0),
        mimicPort: Number(existing?.mimicPort || 0),
        connectHost: String(member.connectHost || "").trim() || null,
      };
    });
}

/**
 * 交给 FXP 的出口策略。auto（自动）/ latency（延迟优先）只有 FXP 2.2.142 起认得（老的会当轮流），
 * 入口机的 FXP 还旧时换成最接近的「按负载」。
 */
export function forwardXExitStrategy(value: unknown, supportsTargetAware = true) {
  const strategy = normalizeExitGroupStrategy(value);
  if (strategy === "none") return "round_robin";
  if (!supportsTargetAware && (strategy === "auto" || strategy === "latency")) return "least_load";
  return strategy;
}

/** 这台机器上的 FXP 认不认「出口回报连目标的结果」、auto / latency 策略（2.2.142 起）。 */
export function fxpSupportsTargetAware(fxpVersion: unknown) {
  return isAgentVersionAtLeast(String(fxpVersion || ""), FXP_TARGET_AWARE_VERSION);
}

/**
 * A failed multi-exit dial must not wait on the runtime's longer default
 * timeout before the handler retries another exit. Relay failover uses the
 * same fast path even when it has no exit group.
 */
export function shouldUseFastTunnelFailover(exitCandidateCount: number, relayFailover = false) {
  return relayFailover || Number(exitCandidateCount) > 1;
}

/**
 * 按权重：gost 用 random，份数写在节点的 metadata.weight（gost 3 的 random 按它加权随机）；nginx 写 weight=N。
 * 份数见 shared/exitStrategy.ts 的 exitGroupWeights。
 * 「按负载」gost 看不到实时负载，退成按带宽加权随机；nginx 用 least_conn + 权重。
 * 注意 metadata.weight 要写成字符串：gost 读 JSON 配置时数字是 float64，它取整数的函数只认 int / 字符串，
 * 写成数字会被当成 1（实测：权重 9 / 1 写成数字时两台各分一半，写成 "9" / "1" 才是九比一）。
 */
export function gostExitSelector(value: unknown) {
  const strategy = normalizeExitGroupStrategy(value);
  return {
    // 延迟优先：面板按到目标的延迟把节点排好（快的在前），GOST 按顺序用（2.3.535，以前当随机）
    strategy: strategy === "fallback" || strategy === "latency" ? "fifo"
      : strategy === "random" || strategy === "weighted" || strategy === "least_load" || strategy === "auto" ? "random"
        : strategy === "ip_hash" ? "hash" : "round",
    maxFails: 1,
    failTimeout: strategy === "fallback" || strategy === "latency" ? "5s" : "15s",
  };
}

/**
 * 从这个 NEX 构建号起，运行时自己不会再「出口全挂时绕过隧道」（gost-runtime/nex-selector-noempty.patch）。
 */
export const GOST_NO_BYPASS_MIN_NEX_BUILD = 6;

/** 主机上报的运行时版本（"3.2.6-nex6"）是不是已经带上面那个补丁。官方 gost、问不出版本的都算没有。 */
export function gostRuntimeHasNoBypassFix(runtimeVersion: unknown) {
  const match = /-nex(\d+)\b/i.exec(String(runtimeVersion || ""));
  return !!match && Number(match[1]) >= GOST_NO_BYPASS_MIN_NEX_BUILD;
}

/**
 * 给还没换上 nex6 的运行时（nex5 以前、官方 gost）用的兜底节点：挂在多节点那一跳的最后。
 *
 * 毛病（见 gost-runtime/nex-selector-noempty.patch）：一跳里的节点全在 failTimeout 里时，失败过滤器筛完是空的，
 * gost 就不走链、由入口机（多跳时是中转机）直连目标。这个节点让过滤器永远筛不空：
 *   - metadata.maxFails 极大 → 它自己永远不会被当成失败节点摘掉；
 *   - metadata.backup → 只要还有一台真出口没被摘，备用过滤器就把它排除，平时一条连接都不会分给它；
 *   - 地址 127.0.0.1:0 → 端口 0 上不可能有监听，拨它立刻失败。
 * 所以真出口全挂时选中的是它，连接马上失败（该失败的），而不是绕过隧道。
 * 拿真的 3.2.6-nex5 验过（BYPASS_GUARD=1 gost-runtime/test/bypass-check/run.sh）：单跳 / 多跳、TCP / UDP 都不再绕过；
 * 出口回来后要等 failTimeout 过去才恢复（和没打补丁的 gost 原来一样）。
 *
 * 两个必须：
 *   1. maxFails 一定写成字符串。gost 读 JSON 配置时数字是 float64，而它取整数的函数只认 int / 字符串，
 *      写成数字等于没写（按 1 算），这个节点就白挂了。节点的 metadata.weight 同理。
 *   2. 只给没带补丁的运行时挂（gostRuntimeHasNoBypassFix 为假）。nex6 上挂了它，「全挂时照样在全部出口里试」
 *      就退回成「等 failTimeout」，没有必要。
 */
export function gostNoBypassGuardNode(name: string) {
  return {
    name,
    addr: "127.0.0.1:0",
    connector: { type: "relay" },
    dialer: { type: "tcp" },
    metadata: { backup: true, maxFails: "1000000000" },
  };
}

/**
 * 一跳的节点列表：不止一个节点、而且这台机器的运行时还没带补丁时，在最后补上兜底节点；其余情况原样返回。
 * 单节点的跳没有选择器，不会筛空，不用挂。
 */
export function withGostNoBypassGuard<T>(nodes: T[], guardName: string, runtimeVersion: unknown): Array<T | ReturnType<typeof gostNoBypassGuardNode>> {
  if (nodes.length < 2 || gostRuntimeHasNoBypassFix(runtimeVersion)) return nodes;
  return [...nodes, gostNoBypassGuardNode(guardName)];
}
