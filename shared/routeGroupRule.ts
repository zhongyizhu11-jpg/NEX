/*
  规则和线路组之间来回换：从规则读出整个线路组、写回规则的列（新列和老的 failover* 列）、
  新建草稿、保存前的校验。shared/routeGroup.ts 统一再导出。
*/
import { formatFailoverEndpoint, type FailoverTarget } from "./failoverTargets";
import {
  MAX_ROUTE_HOPS,
  MAX_ROUTE_PATHS,
  normalizeRouteDelivery,
  ROUTE_GUARD_DEFAULTS,
  type RouteGroup,
  type RouteGroupPolicy,
  type RouteGroupRule,
} from "./routeGroupModel";
import {
  newRoutePath,
  routePathDial,
  routePathLabel,
  routePathRoadKey,
  routePathsOf,
  serializeRoutePaths,
} from "./routeGroupPaths";
import { applyRouteMode, routeAgentStrategy, routePolicyOf } from "./routeGroupPolicy";
import { truthy } from "./routeGroupUtil";

/** 整个线路组：路径 + 策略。没开主备返回 null。 */
export function routeGroupOf(rule: RouteGroupRule, options: { nowMs?: number } = {}): RouteGroup | null {
  if (!truthy(rule.failoverEnabled, false)) return null;
  const paths = routePathsOf(rule);
  return { paths, policy: routePolicyOf(rule, { nowMs: options.nowMs, pathCount: paths.length }) };
}

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
    // 暂停的线路不算：停着的主线路和备用走同一台是常事（停主线路就是要让备用顶上）
    if (path.paused) continue;
    // 落地池的几台成员是同一个池节点、不同的机器（destHostId），不算重复
    const signature = routePathRoadKey(path);
    const previous = signatures.get(signature);
    if (previous !== undefined) return `「${routePathLabel(paths[previous], previous)}」和「${routePathLabel(path, index)}」走的是同一条路：备用要换一台中转、一条隧道或者一个落地`;
    signatures.set(signature, index);
  }
  return null;
}
