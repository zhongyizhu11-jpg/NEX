import { getLatencyStabilityStats, type LatencyStabilityStats } from "@/lib/latencyChart";

/** rules.routeQualityHistory 给的一个点（一个时间桶的平均）。 */
export type RouteQualityPoint = {
  at: number;
  latencyMs: number | null;
  lossPct: number;
  jitterMs: number | null;
  availabilityPct: number | null;
  score: number | null;
  samples: number;
};

/**
 * 线路组路径的质量历史 → 和隧道、TCPing 同一套九格统计。
 *
 * 每个点是入口 Agent 一分钟里的评分快照（再按桶平均），不是一次探测。所以：
 *   · 延迟分位数、抖动按「每个点的平均延迟」算 —— 看的是这段时间里延迟怎么起伏；
 *   · 丢包按每个点报的丢包率平均（每个点按 100 个包算权重）；
 *   · 可用率直接取 Agent 报的可用率的平均，而不是「有几个点通了」—— Agent 自己探得比一分钟细；
 *   · 「统计次数」写的是点数。
 */
export function routeQualityStats(points: readonly RouteQualityPoint[]): LatencyStabilityStats {
  const samples = points.map((point) => {
    const successes = Math.max(0, Math.min(100, Math.round(100 - (Number(point.lossPct) || 0))));
    const latency = point.latencyMs === null ? 0 : Number(point.latencyMs);
    return {
      latency,
      isTimeout: point.latencyMs === null && successes === 0,
      probeCount: 100,
      probeSuccesses: successes,
    };
  });
  const stats = getLatencyStabilityStats(samples);
  const availabilities = points
    .map((point) => point.availabilityPct)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const availability = availabilities.length > 0
    ? availabilities.reduce((sum, value) => sum + value, 0) / availabilities.length
    : stats.availability;
  return {
    ...stats,
    total: points.length,
    availability,
    timeoutRate: availability === null ? 0 : 100 - availability,
  };
}
