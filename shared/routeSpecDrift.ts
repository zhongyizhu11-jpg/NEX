/*
  期望 vs 实际对账（2.3.524）。

  面板按用户配的那份（模板 / 规则上的 routePolicyOf）算出「机器该按什么跑」，Agent 随心跳报它此刻
  真正在按什么跑（failoverStats[].spec，Agent 2.2.253 起），两边一比，对不上就是「面板存了、机器没拿到」
  —— 2.3.522 线上「切到备用 1 还是走主线路」就是这种，只看面板永远发现不了。

  比的是**语义**，不是心跳 JSON 的逐字节：面板下发前有归一化（cold 不带、没钉传 null），Agent 收到后又
  归一化一次（阈值夹进范围、时段表扔掉空窗口），两边各自规整后再比。字段的读法和 agentHeartbeatRoute
  里 actionFailover 的下发是同一套，改那边记得改这边（server/routeSpecDrift.test.ts 钉着）。
*/
import { parseFailoverSchedule, type FailoverSchedule } from "./failoverSchedule";
import { normalizeRouteDelivery, type RouteGroupPolicy } from "./routeGroupModel";
import { routeDeliveryStrategy } from "./routeGroupPolicy";

/** Agent 报的「此刻生效的规格」（agent/route_group.go failoverSpecReport），面板侧已经规整过。 */
export type RouteAgentSpec = {
  /** 此刻生效的钉子；null = 没钉（到期也算没钉）。 */
  pinnedIndex: number | null;
  /** 钉到什么时候（Unix 毫秒）；0 = 一直钉着 / 没钉。 */
  pinnedUntil: number;
  schedule: FailoverSchedule | null;
  minHoldSeconds: number;
  preferFastest: boolean;
  strategy: string;
  /** cold / hot / aggregate / replicate（Agent 没带就是 cold）。 */
  delivery: string;
  failoverSeconds: number;
  recoverSeconds: number;
  autoFailback: boolean;
  failureThreshold: number;
  scoreMargin: number;
  scoreHoldSeconds: number;
  prewarmSeconds: number;
  switchMode: string;
  targetCount: number;
};

export type RouteSpecDriftField = {
  key: string;
  /** 给人看的字段名：人工指定、时段表… */
  label: string;
  /** 面板这边（用户配的） */
  expected: string;
  /** 机器那边（Agent 报的） */
  actual: string;
};

export type RouteSpecDrift = {
  fields: RouteSpecDriftField[];
  /** Agent 报这份规格的时刻（Unix 毫秒）。 */
  reportedAt: number;
};

/**
 * 改了配置之后给机器留的宽限：推送、Agent 原地换规格、下一次心跳报回来，正常几秒内；20 秒还没对上才算不一致。
 * 钉子到期那一刻两边各自按自己的钟判，前后差个几秒也在这个宽限里。
 */
export const ROUTE_SPEC_DRIFT_GRACE_MS = 20_000;

/** 面板该下发给机器的规格：和 agentHeartbeatRoute 的 actionFailover 一个读法。 */
export function expectedRouteAgentSpec(policy: RouteGroupPolicy, pathCount: number): RouteAgentSpec {
  const delivery = normalizeRouteDelivery(policy.delivery);
  const pin = policy.mode === "weighted" ? null : policy.pin;
  return {
    pinnedIndex: pin ? pin.index : null,
    pinnedUntil: pin?.untilMs ?? 0,
    schedule: policy.mode === "scheduled" || policy.mode === "hybrid" ? policy.schedule : null,
    minHoldSeconds: policy.minHoldSeconds,
    preferFastest: policy.mode === "smart" || policy.mode === "hybrid",
    strategy: routeDeliveryStrategy(policy, delivery),
    delivery,
    failoverSeconds: policy.failoverSeconds,
    recoverSeconds: policy.recoverSeconds,
    autoFailback: policy.autoFailback,
    failureThreshold: policy.failureThreshold,
    scoreMargin: policy.scoreMargin,
    scoreHoldSeconds: policy.scoreHoldSeconds,
    prewarmSeconds: policy.prewarmSeconds,
    switchMode: policy.switchMode,
    targetCount: pathCount,
  };
}

/** Agent 报上来的原始 JSON → 规整后的规格；认不出来（老 Agent 没报）返回 null。 */
export function parseRouteAgentSpec(raw: unknown): RouteAgentSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const int = (input: unknown, fallback = 0) => {
    const number = Math.floor(Number(input));
    return Number.isFinite(number) ? number : fallback;
  };
  const pinnedRaw = value.pinnedIndex;
  const pinnedIndex = pinnedRaw === null || pinnedRaw === undefined ? null : int(pinnedRaw, -1);
  return {
    pinnedIndex: pinnedIndex !== null && pinnedIndex >= 0 ? pinnedIndex : null,
    pinnedUntil: pinnedIndex !== null && pinnedIndex >= 0 ? Math.max(0, int(value.pinnedUntil)) : 0,
    schedule: parseFailoverSchedule(value.schedule),
    minHoldSeconds: Math.max(0, int(value.minHoldSeconds)),
    preferFastest: value.preferFastest === true,
    strategy: String(value.strategy || "fallback").trim().slice(0, 24),
    delivery: normalizeRouteDelivery(value.delivery),
    failoverSeconds: Math.max(0, int(value.failoverSeconds)),
    recoverSeconds: Math.max(0, int(value.recoverSeconds)),
    autoFailback: value.autoFailback === true,
    failureThreshold: Math.max(0, int(value.failureThreshold)),
    scoreMargin: Math.max(0, int(value.scoreMargin)),
    scoreHoldSeconds: Math.max(0, int(value.scoreHoldSeconds)),
    prewarmSeconds: Math.max(0, int(value.prewarmSeconds)),
    switchMode: String(value.switchMode || "smooth").trim().slice(0, 16),
    targetCount: Math.max(0, int(value.targetCount)),
  };
}

function scheduleKey(schedule: FailoverSchedule | null) {
  if (!schedule || schedule.windows.length === 0) return "";
  return [schedule.timezone, ...schedule.windows.map((window) => `${[...window.days].sort((a, b) => a - b).join(",")}|${window.from}|${window.to}|${window.targetIndex}`)].join(";");
}

function formatDuration(seconds: number) {
  if (seconds <= 0) return "0 秒";
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

const DELIVERY_LABEL: Record<string, string> = { cold: "冷备", hot: "热备", aggregate: "聚合", replicate: "复制" };
const STRATEGY_LABEL: Record<string, string> = {
  fallback: "主备（一次走一条）", weighted: "按权重", least_load: "按负载", round_robin: "轮流", random: "随机", ip_hash: "按访客固定", auto: "自动权重",
};
const SWITCH_LABEL: Record<string, string> = { smooth: "平滑", fast: "故障时断开", force: "每次都断开" };

/**
 * 面板该下发的和机器报的差在哪：没差返回空数组。labelOf 把路径序号翻成名字（「备用 1」）。
 *
 * 钉子到期前后那几秒不算差（面板和机器各按自己的钟判到期）。
 */
export function routeSpecDriftFields(
  expected: RouteAgentSpec,
  actual: RouteAgentSpec,
  labelOf: (index: number) => string,
  options: { nowMs?: number } = {},
): RouteSpecDriftField[] {
  const nowMs = options.nowMs ?? Date.now();
  const fields: RouteSpecDriftField[] = [];
  const nearExpiry = (untilMs: number) => untilMs > 0 && Math.abs(untilMs - nowMs) < ROUTE_SPEC_DRIFT_GRACE_MS;
  const pinText = (index: number | null, untilMs: number) => {
    if (index === null) return "没有";
    const name = labelOf(index);
    return untilMs > 0 ? `${name} · 到 ${formatClock(untilMs)}` : `${name} · 一直`;
  };
  const pinSame = expected.pinnedIndex === actual.pinnedIndex && expected.pinnedUntil === actual.pinnedUntil;
  if (!pinSame && !nearExpiry(expected.pinnedUntil) && !nearExpiry(actual.pinnedUntil)) {
    fields.push({ key: "pin", label: "人工指定", expected: pinText(expected.pinnedIndex, expected.pinnedUntil), actual: pinText(actual.pinnedIndex, actual.pinnedUntil) });
  }
  if (scheduleKey(expected.schedule) !== scheduleKey(actual.schedule)) {
    const text = (schedule: FailoverSchedule | null) => (schedule && schedule.windows.length > 0 ? `${schedule.windows.length} 个时段` : "没有");
    const both = expected.schedule && actual.schedule && expected.schedule.windows.length > 0 && actual.schedule.windows.length > 0;
    fields.push({ key: "schedule", label: "时段表", expected: both ? `${text(expected.schedule)}（内容不同）` : text(expected.schedule), actual: text(actual.schedule) });
  }
  const same = <T,>(key: string, label: string, left: T, right: T, format: (value: T) => string) => {
    if (left !== right) fields.push({ key, label, expected: format(left), actual: format(right) });
  };
  same("strategy", "怎么分配", expected.strategy, actual.strategy, (value) => STRATEGY_LABEL[value] || value);
  same("delivery", "备用怎么候着", expected.delivery, actual.delivery, (value) => DELIVERY_LABEL[value] || value);
  same("preferFastest", "只走最快", expected.preferFastest, actual.preferFastest, (value) => (value ? "开" : "关"));
  same("minHold", "最短驻留", expected.minHoldSeconds, actual.minHoldSeconds, formatDuration);
  same("failureThreshold", "连续失败几次算异常", expected.failureThreshold, actual.failureThreshold, (value) => `${value} 次`);
  same("failoverSeconds", "异常多久切走", expected.failoverSeconds, actual.failoverSeconds, formatDuration);
  same("recoverSeconds", "恢复观察", expected.recoverSeconds, actual.recoverSeconds, formatDuration);
  same("autoFailback", "恢复后切回", expected.autoFailback, actual.autoFailback, (value) => (value ? "切回" : "不切回"));
  same("scoreMargin", "评分差多少才换", expected.scoreMargin, actual.scoreMargin, (value) => `${value} 分`);
  same("scoreHold", "更优持续多久才换", expected.scoreHoldSeconds, actual.scoreHoldSeconds, formatDuration);
  same("prewarm", "计划切换预热", expected.prewarmSeconds, actual.prewarmSeconds, formatDuration);
  same("switchMode", "旧连接", expected.switchMode, actual.switchMode, (value) => SWITCH_LABEL[value] || value);
  same("targets", "线路数", expected.targetCount, actual.targetCount, (value) => `${value} 条`);
  return fields;
}

function formatClock(ms: number) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  } catch {
    return new Date(ms).toTimeString().slice(0, 5);
  }
}

/**
 * 这份 Agent 报告能不能拿来对账：机器要在配置改完、留足宽限之后报的，不然报的还是改之前那份。
 * configChangedAt：规则（模板和它展开的那条都算）最后一次改动的时刻。
 */
export function routeSpecReportUsable(reportedAtMs: number, configChangedAtMs: number) {
  return reportedAtMs > 0 && reportedAtMs - configChangedAtMs >= ROUTE_SPEC_DRIFT_GRACE_MS;
}
