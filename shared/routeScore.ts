/**
 * 线路评分：一条路径此刻「有多好」，0–100 一个数 —— 只用来给人看（「92 优」）。
 *
 * 分数由 Agent 算好报上来（快照的 score、事件的 score），面板不自己算。它和调度用的是同一个数换算过来的：
 * lbcore 的「只看质量的成本」（lbcore/switch.go 的 QualityCost / DisplayScore）
 *
 *     成本 = (整链延迟 + 抖动) × (1 + 10 × 丢包率) × (1 + 10 × 拨号失败率) ÷ (1 − 沿途主机负载，最多按 95%)
 *     分数 = 成本 ≤ 40ms 满分，≥ 400ms 零分，中间线性
 *
 * 主备里的「整链最优」、「延迟优先」、「自动」比的都是这个成本（自动还乘上负载），所以分高的永远是调度认为更好的；
 * 分数本身不参与任何决定。探不通是 0；还没探出延迟时不打分（null）——「等评分」和「0 分」是两回事。
 */

/** 沿途主机负载从多少起在线路上标出来（「负载 85%」那枚药丸），到多少按最满算（成本最多 ÷ 0.05）。 */
export const ROUTE_LOAD_NOTICE_PCT = 70;
export const ROUTE_LOAD_MAX_PCT = 95;

/** 沿途主机负载让这条线路的成本按几倍算：1 ÷ (1 − 负载)，负载最多按 95%（和 lbcore 的 Headroom 一样）。不知道是 1。 */
export function routeLoadSlowdown(loadPct: number | null | undefined): number {
  const load = Number(loadPct);
  if (!Number.isFinite(load) || load <= 0) return 1;
  return 1 / (1 - Math.min(load, ROUTE_LOAD_MAX_PCT) / 100);
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
