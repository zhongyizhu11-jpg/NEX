/**
 * 线路评分：一条路径此刻「有多好」，0–100 一个数。
 *
 * 调度器不能只看延迟。「谁延迟低就切谁」会让线路一直漂 —— 两条线在几毫秒之间来回，
 * 每次探测都能得出不同的结论。评分把延迟、丢包、抖动、可用率揉成一个数，切换的门槛
 * 再按分差和持续时间来定（见 Agent 的 fastestIndexLocked），线路才稳得住。
 *
 * 用户不需要理解算法，只看到：
 *
 *     A    92   优
 *     B    87   良
 *     C    61   较差
 *
 * 公式**写死**，不做成设置项：多一个旋钮就多一次「这个填多少合适」的为难，而这几个
 * 权重的合理范围很窄。四项各占的分：
 *
 *     延迟    40 分   ≤ 40 ms 满分，≥ 400 ms 零分，中间线性
 *     丢包    30 分   0% 满分，≥ 4% 零分（丢包对交互类流量的伤害远大于延迟，所以斜率陡）
 *     抖动    15 分   0 ms 满分，≥ 100 ms 零分
 *     可用率  15 分   探测成功的比例
 *
 * 再减主机负载（Agent 2.2.251 起）：面板按这条路径沿途的中转机、落地机（是 NEX 主机时）里最忙的
 * 那台给一个 loadPct（CPU 和带宽占用取大的），70% 以下不扣，往上线性扣，95% 起扣满 15 分。一台快被跑满的
 * 中转再快也该让一让 —— 分扣下来，整链最优和「自动」分法都会少走它。扣不到负数，最低 0。
 *
 * 探不通（healthy = false）直接 0 分：一条连不上的线路谈不上「有多好」。还没探出延迟时
 * 不打分（null）—— 「等评分」和「0 分」是两回事，前者不该被显示成最差。
 *
 * 评分在 Agent（Go）和面板（TS）各算一遍：Agent 拿它做切换决定，面板拿它解释「为什么
 * 走这条」。两份实现共用 routeScore.cases.json 那张用例表：谁改出了偏差，谁那边红。
 */

export type RouteQuality = {
  /** 最近探测的往返耗时（毫秒）；还没探出来是 null。 */
  latencyMs: number | null;
  /** 探测失败的比例，0–100。 */
  lossPct: number;
  /** 相邻两次探测耗时之差的平均值（毫秒）。 */
  jitterMs: number;
  /** 观察窗口里探测成功的比例，0–100。 */
  availabilityPct: number;
  /** Agent 此刻认为这条线路能不能用。 */
  healthy: boolean;
  /** 沿途主机里最忙那台的负载（0–100）；不知道是 null / 不给，不扣分。 */
  loadPct?: number | null;
};

export const ROUTE_SCORE_LATENCY_FULL_MS = 40;
export const ROUTE_SCORE_LATENCY_ZERO_MS = 400;
export const ROUTE_SCORE_LOSS_ZERO_PCT = 4;
export const ROUTE_SCORE_JITTER_ZERO_MS = 100;
/** 主机负载从多少起扣分、多少扣满、最多扣几分。 */
export const ROUTE_SCORE_LOAD_FROM_PCT = 70;
export const ROUTE_SCORE_LOAD_FULL_PCT = 95;
export const ROUTE_SCORE_LOAD_MAX_PENALTY = 15;

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

/** 主机负载扣几分（小数）：70% 以下 0，95% 起 15，中间线性。和 Agent 的 routeLoadPenalty 逐字一致。 */
export function routeLoadPenalty(loadPct: number | null | undefined): number {
  const load = Number(loadPct);
  if (!Number.isFinite(load)) return 0;
  return clamp01((load - ROUTE_SCORE_LOAD_FROM_PCT) / (ROUTE_SCORE_LOAD_FULL_PCT - ROUTE_SCORE_LOAD_FROM_PCT)) * ROUTE_SCORE_LOAD_MAX_PENALTY;
}

/** 0–100 的整数；探不通是 0，还没探出延迟是 null。运算顺序和 Agent 的 routeScore 逐字一致。 */
export function routeScore(quality: RouteQuality): number | null {
  if (!quality.healthy) return 0;
  if (quality.latencyMs === null || quality.latencyMs === undefined || !Number.isFinite(quality.latencyMs)) return null;
  const latency = clamp01((ROUTE_SCORE_LATENCY_ZERO_MS - quality.latencyMs) / (ROUTE_SCORE_LATENCY_ZERO_MS - ROUTE_SCORE_LATENCY_FULL_MS)) * 40;
  const loss = clamp01(1 - (Number(quality.lossPct) || 0) / ROUTE_SCORE_LOSS_ZERO_PCT) * 30;
  const jitter = clamp01(1 - (Number(quality.jitterMs) || 0) / ROUTE_SCORE_JITTER_ZERO_MS) * 15;
  const availability = clamp01((Number(quality.availabilityPct) || 0) / 100) * 15;
  // 负载扣分是整体减的，不进四项里；减到负数按 0（先截再取整，两边才一样）。
  const total = latency + loss + jitter + availability - routeLoadPenalty(quality.loadPct);
  return Math.round(total < 0 ? 0 : total);
}

export type RouteScoreGrade = {
  label: "优" | "良" | "较差" | "不可用" | "等评分";
  /** 语义色的令牌名，和状态点一套。 */
  tone: "healthy" | "warn" | "down" | "standby";
};

/** 用户看到的那个词。门槛写死：90 起是优，80 起是良，其余较差。 */
export function routeScoreGrade(score: number | null | undefined): RouteScoreGrade {
  if (score === null || score === undefined || !Number.isFinite(score)) return { label: "等评分", tone: "standby" };
  if (score <= 0) return { label: "不可用", tone: "down" };
  if (score >= 90) return { label: "优", tone: "healthy" };
  if (score >= 80) return { label: "良", tone: "healthy" };
  return { label: "较差", tone: "warn" };
}

/** 「92 优」这种写法；没分就是「等评分」。 */
export function formatRouteScore(score: number | null | undefined): string {
  const grade = routeScoreGrade(score);
  if (score === null || score === undefined || !Number.isFinite(score)) return grade.label;
  return `${Math.round(score)} ${grade.label}`;
}
