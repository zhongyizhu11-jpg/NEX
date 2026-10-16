import { appendPanelLog } from "./_core/panelLogger";
import { routePathsOf, type RouteGroupRule, type RoutePath } from "../shared/routeGroup";
import { getRouteStatus, type RouteAgentStats } from "./routeGroupStats";
import { insertRoutePathQualityStats, type RoutePathQualityRow } from "./repositories/routePathQualityRepository";

/*
  线路组路径质量的历史。

  routeGroupStats 里的评分只在内存里：界面上「现在 92 分」够用，但「昨晚八点那条线怎么样」
  答不上来。这里把入口 Agent 报上来的那份评分（延迟、丢包、抖动、可用率、评分）按路径
  落库，**每条路径最多一分钟一行** —— 心跳几秒一次，全写就是纯粹的写放大；一分钟一个点
  画七天的图足够细。

  节流按 (规则, 路径) 记在内存里。面板重启后第一份评分会立刻写一行，之后照旧一分钟一行，
  最多多写一个点，不影响什么。
*/

export const ROUTE_PATH_QUALITY_SAMPLE_INTERVAL_MS = 60_000;
/** 评分快照多旧就不算「这一分钟」的了：Agent 停报以后不该拿旧快照一直补点。 */
const ROUTE_PATH_QUALITY_FRESH_MS = 2 * 60_000;
const MAX_THROTTLE_ENTRIES = 50_000;

const lastWrittenAt = new Map<string, number>();
let lastWriteWarningAt = 0;

function throttleKey(ruleId: number, pathKey: string) {
  return `${ruleId}:${pathKey}`;
}

/**
 * 这份评分快照里哪些路径该落一行。纯函数（节流状态由调用方给），测试直接喂。
 *
 * 只认还有路径对得上的下标（路径删了、改了顺序以后 Agent 可能还报着旧下标，那时宁可不记）；
 * 一个样本都没有、也没有分数和延迟的不记 —— 那不是质量，是「还没探」。
 */
export function planRoutePathQualitySamples(input: {
  stats: Pick<RouteAgentStats, "ruleId" | "targets" | "reportedAt">;
  paths: readonly RoutePath[];
  nowMs: number;
  lastWritten: Map<string, number>;
  intervalMs?: number;
}): RoutePathQualityRow[] {
  const interval = input.intervalMs ?? ROUTE_PATH_QUALITY_SAMPLE_INTERVAL_MS;
  const ruleId = Number(input.stats.ruleId);
  if (!(ruleId > 0)) return [];
  if (input.nowMs - Number(input.stats.reportedAt || 0) > ROUTE_PATH_QUALITY_FRESH_MS) return [];
  const rows: RoutePathQualityRow[] = [];
  for (const target of input.stats.targets) {
    const path = input.paths[target.index];
    if (!path) continue;
    if (target.samples <= 0 && target.latencyMs === null && target.score === null) continue;
    const key = throttleKey(ruleId, path.key);
    const last = input.lastWritten.get(key) || 0;
    if (input.nowMs - last < interval) continue;
    input.lastWritten.set(key, input.nowMs);
    rows.push({
      ruleId,
      pathKey: path.key,
      sampledAt: input.nowMs,
      latencyMs: target.latencyMs,
      lossPct: target.lossPct,
      jitterMs: target.jitterMs,
      availabilityPct: target.availabilityPct,
      score: target.score,
    });
  }
  return rows;
}

function pruneThrottle(nowMs: number) {
  if (lastWrittenAt.size <= MAX_THROTTLE_ENTRIES) return;
  for (const [key, at] of lastWrittenAt) {
    if (nowMs - at > 10 * ROUTE_PATH_QUALITY_SAMPLE_INTERVAL_MS) lastWrittenAt.delete(key);
  }
}

/**
 * 收完一台机器的评分快照（recordRouteAgentStats）之后调：把这几条规则此刻的评分按路径落库。
 * 写失败只记日志，不影响心跳。返回写了几行。
 */
export async function recordRoutePathQuality(input: {
  rules: ReadonlyArray<RouteGroupRule & { id: unknown }>;
  nowMs?: number;
  insert?: (rows: RoutePathQualityRow[]) => Promise<unknown>;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const rows: RoutePathQualityRow[] = [];
  for (const rule of input.rules) {
    const ruleId = Number(rule.id);
    if (!(ruleId > 0)) continue;
    const agent = getRouteStatus(ruleId, nowMs).agent;
    if (!agent) continue;
    rows.push(...planRoutePathQualitySamples({ stats: agent, paths: routePathsOf(rule), nowMs, lastWritten: lastWrittenAt }));
  }
  if (rows.length === 0) return 0;
  pruneThrottle(nowMs);
  try {
    await (input.insert || insertRoutePathQualityStats)(rows);
    return rows.length;
  } catch (error) {
    // 没写进去的这一分钟下次再写：撤掉节流记录。
    for (const row of rows) lastWrittenAt.delete(throttleKey(row.ruleId, row.pathKey));
    if (nowMs - lastWriteWarningAt > 60_000) {
      lastWriteWarningAt = nowMs;
      appendPanelLog("warn", `[RouteQuality] 路径质量历史写入失败: ${String((error as any)?.message || error)}`);
    }
    return 0;
  }
}

export function forgetRoutePathQualityThrottle(ruleId: number) {
  const prefix = `${Number(ruleId)}:`;
  for (const key of Array.from(lastWrittenAt.keys())) if (key.startsWith(prefix)) lastWrittenAt.delete(key);
}

/** 测试用：模拟面板重启。 */
export function resetRoutePathQualityThrottleForTest() {
  lastWrittenAt.clear();
  lastWriteWarningAt = 0;
}

export type RouteQualityPoint = {
  /** 桶的起点，Unix 毫秒 */
  at: number;
  latencyMs: number | null;
  lossPct: number;
  jitterMs: number | null;
  availabilityPct: number | null;
  score: number | null;
  samples: number;
};

function average(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/**
 * 一条路径的历史按时间桶合并（七天一分钟一点是一万个点，图上画不了那么细）。
 * 延迟、抖动、评分、可用率取桶内平均；丢包取平均。延迟全空（全超时）的桶延迟为 null。
 */
export function bucketRouteQualityRows(rows: readonly RoutePathQualityRow[], bucketMs: number): RouteQualityPoint[] {
  const size = Math.max(60_000, Math.floor(bucketMs));
  const buckets = new Map<number, RoutePathQualityRow[]>();
  for (const row of rows) {
    const key = Math.floor(row.sampledAt / size) * size;
    const list = buckets.get(key) || [];
    list.push(row);
    buckets.set(key, list);
  }
  return Array.from(buckets.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([at, items]) => {
      const pick = (read: (row: RoutePathQualityRow) => number | null) => average(items.map(read).filter((value): value is number => value !== null && Number.isFinite(value)));
      const latency = pick((row) => row.latencyMs);
      const jitter = pick((row) => row.jitterMs);
      const availability = pick((row) => row.availabilityPct);
      const score = pick((row) => row.score);
      return {
        at,
        latencyMs: latency === null ? null : Math.round(latency * 10) / 10,
        lossPct: Math.round((pick((row) => row.lossPct) ?? 0) * 100) / 100,
        jitterMs: jitter === null ? null : Math.round(jitter * 10) / 10,
        availabilityPct: availability === null ? null : Math.round(availability * 100) / 100,
        score: score === null ? null : Math.round(score),
        samples: items.length,
      };
    });
}

/** 时间窗口 → 桶宽：最多大约 360 个点。 */
export function routeQualityBucketMs(hours: number) {
  const windowMs = Math.max(1, hours) * 3600 * 1000;
  const raw = windowMs / 360;
  const minutes = Math.max(1, Math.ceil(raw / 60_000));
  const nice = [1, 2, 5, 10, 15, 30, 60].find((value) => value >= minutes) ?? 60;
  return nice * 60_000;
}
