/*
  线路组的调度策略：从规则的列读出策略、套模板、下发给 Agent 的分法、要不要带「落地怎么分」、
  探测间隔和多久能切走。shared/routeGroup.ts 统一再导出。
*/
import { readFailoverPin } from "./failoverPin";
import { parseFailoverSchedule, type FailoverSchedule } from "./failoverSchedule";
import {
  normalizeRouteDelivery,
  normalizeRouteMode,
  normalizeRouteSpread,
  normalizeRouteSwitchMode,
  ROUTE_GUARD_DEFAULTS,
  ROUTE_GUARD_LIMITS,
  type RouteDelivery,
  type RouteGroupPolicy,
  type RouteGroupRule,
  type RouteGuards,
  type RouteLineDestSpread,
  type RouteMode,
  type RoutePath,
  type RouteSpread,
} from "./routeGroupModel";
import { routePathLandingKey, routePathsOf } from "./routeGroupPaths";
import { clampInt, truthy } from "./routeGroupUtil";

/**
 * 下发给 Agent 时带不带「落地怎么分」：一次走一条线路（分配策略是 fallback、不分层 —— 按权重、聚合 / 复制时
 * 整组本来就在分）、有线路选了一起分。
 */
export function routeDestSpreadReady(options: {
  strategy: string;
  tiered: boolean;
  paths: ReadonlyArray<Pick<RoutePath, "destSpread" | "tier">>;
}): boolean {
  return options.strategy === "fallback" && !options.tiered
    && options.paths.some((path) => !!path.destSpread && typeof path.tier === "number");
}

/** 一条目标上的「落地怎么分」字段：第几条线路、落地是哪一个、怎么分；这条线路没选一起分就不带。 */
export function routeDestSpreadTargetFields(
  path: Pick<RoutePath, "destSpread" | "tier" | "dest" | "destNodeId"> & { destHostId?: number | null },
  ready: boolean,
): { line: number; landing: string; spread: RouteLineDestSpread } | Record<string, never> {
  if (!ready || !path.destSpread || typeof path.tier !== "number") return {};
  return { line: path.tier, landing: routePathLandingKey(path), spread: path.destSpread };
}

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

/** Agent 拿到的分配策略名：权重负载按它的分法，其余都是主备（fallback）。 */
export function routeAgentStrategy(policy: Pick<RouteGroupPolicy, "mode" | "spread">): "fallback" | RouteSpread {
  return policy.mode === "weighted" ? policy.spread : "fallback";
}

/**
 * 下发给 Agent 的分配策略，算上「备用怎么候着」：聚合 = 主线路那一组里按负载分（Agent 只在最低健康
 * tier 里挑，备用组照旧等着）；其余按线路组自己的分法（routeAgentStrategy）。
 */
export function routeDeliveryStrategy(
  policy: Pick<RouteGroupPolicy, "mode" | "spread">,
  delivery: RouteDelivery,
): "fallback" | RouteSpread {
  if (delivery === "aggregate") return "least_load";
  return routeAgentStrategy(policy);
}
