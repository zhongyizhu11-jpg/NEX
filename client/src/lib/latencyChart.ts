
import type { ProbeStatistics } from "@shared/probeStatistics";

export type LatencyStabilitySample = {
  latency: number;
  isTimeout?: boolean | null;
  probeCount?: number | null;
  probeSuccesses?: number | null;
  /** 这条样本的时间（毫秒）。都有时可用率按时间算（computeTimeWeightedAvailability）。 */
  atMs?: number | null;
};

export type LatencyStabilityRating = {
  label: string;
  className: string;
};

export type LatencyStabilityStats = {
  total: number;
  timeout: number;
  valid: number;
  lossRate: number;
  max: number | null;
  min: number | null;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  jitter: number | null;
  spikeRate: number;
  maxLossRun: number;
  /**
   * 可用率（%）：有几成的探测记录至少通了一次。和丢包率不同 —— 丢包按包算（5 个包丢 1 个
   * 是 20%），可用率按次算（那一次还是通的）。没有记录时为 null。
   */
  availability: number | null;
  /** 超时率（%）：整次探测一个包都没回来的记录占比，等于 100 − 可用率。 */
  timeoutRate: number;
  score: number | null;
  rating: LatencyStabilityRating;
  /**
   * 次数与丢包率来自 Agent 的累计探测计数（2.2.229+），而不是图表上的状态样本。
   * 状态样本里稳定成功的上报 5 分钟才发一次、失败每次都发，直接按样本算会把丢包率算高。
   */
  fromCounters?: boolean;
};

/** 累计计数能不能用：有上报、数字自洽。拿不到时退回按状态样本统计（旧 Agent）。 */
export function usableProbeCounters(actual: ProbeStatistics | null | undefined): actual is ProbeStatistics {
  return !!actual?.available
    && Number.isSafeInteger(actual.total) && actual.total > 0
    && Number.isSafeInteger(actual.successes) && actual.successes >= 0 && actual.successes <= actual.total;
}

/** 统计卡片上的毫秒数：没有就是「--」。 */
export function formatStatLatency(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "--" : `${Math.round(value)} ms`;
}

/** 统计卡片上的百分比：整数写「75%」「100%」，其余按位数保留小数；没有就是「--」。 */
export function formatStatPercent(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  const clamped = Math.max(0, Math.min(100, value));
  if (Number.isInteger(clamped)) return `${clamped}%`;
  return `${clamped.toFixed(digits)}%`;
}

/** 按时间算可用率时，一条样本最多代表这么久：稳定成功约 5 分钟报一次，再长就是没数据（Agent 离线之类），不算。 */
export const AVAILABILITY_MAX_SEGMENT_MS = 10 * 60 * 1000;

/**
 * 按时间算的可用率（%）：这段时间里链路通着的时间占比。
 *
 * 图上的点是状态样本：链路稳定时约 5 分钟才报一次成功，失败却每次都报。按「几个点通了」算，
 * 失败的点被过度代表，可用率偏低；所以有了累计计数以后干脆不显示它。按时间算就没有这个偏差：
 * 每个样本的状态一直延续到下一个样本（最多 10 分钟，再长算没数据），通着的时长 ÷ 有数据的时长。
 * 有样本缺时间就返回 null。
 */
export function computeTimeWeightedAvailability(
  samples: ReadonlyArray<Partial<LatencyStabilitySample>>,
  nowMs = Date.now(),
): number | null {
  if (samples.length === 0) return null;
  const timed = samples.map((sample) => ({ at: Number(sample.atMs), ok: normalizeLatencyProbeCounts(sample).probeSuccesses > 0 }));
  if (timed.some((item) => !Number.isFinite(item.at) || item.at <= 0)) return null;
  timed.sort((a, b) => a.at - b.at);
  let up = 0;
  let known = 0;
  for (let index = 0; index < timed.length; index += 1) {
    const end = index + 1 < timed.length ? timed[index + 1].at : Math.max(timed[index].at, nowMs);
    // 最后一个样本到现在也算（链路一直是那个状态），只是同样封顶。至少记 1 秒，免得只有一个样本时没分母。
    const span = Math.min(AVAILABILITY_MAX_SEGMENT_MS, Math.max(1000, end - timed[index].at));
    known += span;
    if (timed[index].ok) up += span;
  }
  return known > 0 ? (up / known) * 100 : null;
}

/**
 * 一段时间里链路的可用率（%）：至少通了一次的探测记录 / 全部记录。
 * 多包探测（一次 ping 5 个包）只要回来一个就算这一次可用；整次全丢才算不可用。
 */
export function computeLinkAvailability(samples: ReadonlyArray<Pick<LatencyStabilitySample, "isTimeout" | "probeCount" | "probeSuccesses">>): number | null {
  if (samples.length === 0) return null;
  let ok = 0;
  for (const sample of samples) {
    if (normalizeLatencyProbeCounts(sample).probeSuccesses > 0) ok += 1;
  }
  return (ok / samples.length) * 100;
}

export type NormalizedLatencyProbeCounts = {
  probeCount: number;
  probeSuccesses: number;
  /** True only when every represented probe failed. */
  isTimeout: boolean;
};

/**
 * Normalize packet counters received from old and new panel/Agent versions.
 * Older rows have no counters (or may have the database's zero default), so
 * a non-timeout row retains the historical one-success-sample semantics.
 */
export function normalizeLatencyProbeCounts(sample: Pick<LatencyStabilitySample, "isTimeout" | "probeCount" | "probeSuccesses"> | null | undefined): NormalizedLatencyProbeCounts {
  const rawCount = Number(sample?.probeCount);
  const probeCount = Number.isInteger(rawCount) && rawCount >= 1 ? Math.min(rawCount, 1024) : 1;
  const rawSuccesses = Number(sample?.probeSuccesses);
  const hasSuccesses = sample?.probeSuccesses !== undefined
    && sample?.probeSuccesses !== null
    && Number.isInteger(rawSuccesses);
  let probeSuccesses = hasSuccesses ? rawSuccesses : (sample?.isTimeout ? 0 : probeCount);
  probeSuccesses = Math.max(0, Math.min(probeCount, probeSuccesses));
  if (!sample?.isTimeout && probeSuccesses === 0) probeSuccesses = probeCount;
  return {
    probeCount,
    probeSuccesses,
    isTimeout: !!sample?.isTimeout && probeSuccesses <= 0,
  };
}

export type PeakCutSample = {
  [key: string]: unknown;
};

export type PeakCutSeries = {
  dataKey: string;
  outputKey?: string;
  timeoutKey?: string;
};

export function isLatencySeriesCacheFresh<T extends { recordedAt: string | Date }>(
  series: T[] | null | undefined,
  maxLatestAgeMs = 10 * 60 * 1000,
) {
  if (!series?.length) return false;
  const latest = series.reduce((max, item) => {
    const time = new Date(item.recordedAt).getTime();
    return Number.isFinite(time) ? Math.max(max, time) : max;
  }, 0);
  const now = Date.now();
  return latest > 0 && latest >= now - maxLatestAgeMs && latest <= now + 60_000;
}

export function clipLatencyForChart(latency: number) {
  if (!Number.isFinite(latency) || latency <= 0) return 0;
  return latency;
}

export function getLatencyYAxisMax(maxLatency: number, fallback = 120) {
  if (!Number.isFinite(maxLatency) || maxLatency <= 0) return fallback;

  const clipped = Math.max(0, maxLatency);
  const padding =
    clipped < 20 ? 1.35
      : clipped < 50 ? 1.25
        : clipped < 150 ? 1.2
          : clipped < 300 ? 1.15
            : 1.1;
  const padded = Math.max(clipped + 1, clipped * padding);
  const step = getNiceLatencyStep(padded / 5);
  const rounded = Math.ceil(padded / step) * step;
  return Math.max(1, Math.ceil(rounded));
}

export function getLatencyYAxisTicks(yMax: number) {
  if (!Number.isFinite(yMax) || yMax <= 0) return [0];
  const max = Math.ceil(yMax);
  const step = getNiceLatencyStep(max / 6);
  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}

export function applyLatencyPeakCut<T extends PeakCutSample>(
  data: T[],
  series: PeakCutSeries[],
  options: { windowSize?: number; alpha?: number } = {},
): T[] {
  if (!data.length || !series.length) return data;
  const windowSize = Math.max(3, options.windowSize || 11);
  const alpha = Number.isFinite(options.alpha) ? Number(options.alpha) : 0.3;
  const ewmaHistory: Record<string, number> = {};

  return data.map((point, index) => {
    if (index < windowSize - 1) return point;
    const window = data.slice(index - windowSize + 1, index + 1);
    let changed = false;
    const next: PeakCutSample = { ...point };

    for (const item of series) {
      const outputKey = item.outputKey || item.dataKey;
      if (item.timeoutKey && point[item.timeoutKey]) continue;
      const values = window
        .filter((row) => !item.timeoutKey || !row[item.timeoutKey])
        .map((row) => Number(row[item.dataKey]))
        .filter((value) => Number.isFinite(value) && value > 0);
      const processed = processPeakCutValues(values, alpha);
      if (processed === null) continue;
      if (ewmaHistory[outputKey] === undefined) {
        ewmaHistory[outputKey] = processed;
      } else {
        ewmaHistory[outputKey] = alpha * processed + (1 - alpha) * ewmaHistory[outputKey];
      }
      next[outputKey] = Math.max(1, Math.round(ewmaHistory[outputKey]));
      changed = true;
    }
    return changed ? next as T : point;
  });
}

function getNiceLatencyStep(rawStep: number) {
  if (!Number.isFinite(rawStep) || rawStep <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const candidates = magnitude >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
  const selected = candidates.find((step) => normalized <= step) ?? 10;
  return selected * magnitude;
}

function getMedian(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function processPeakCutValues(values: number[], alpha: number) {
  if (values.length === 0) return null;
  const median = getMedian(values);
  if (!Number.isFinite(median) || median <= 0) return null;
  const deviations = values.map((value) => Math.abs(value - median));
  const medianDeviation = getMedian(deviations) * 1.4826;
  const validValues = values.filter((value) => {
    const withinMad = medianDeviation <= 0 ? value <= median * 3 : Math.abs(value - median) <= 3 * medianDeviation;
    return withinMad && value <= median * 3;
  });
  const filtered = validValues.length > 0 ? validValues : [median];
  let ewma = filtered[0];
  for (let index = 1; index < filtered.length; index += 1) {
    ewma = alpha * filtered[index] + (1 - alpha) * ewma;
  }
  return ewma;
}

/**
 * @param actual 累计探测计数（rules/tunnels/forwardGroups.probeStatistics）。可用时次数、丢包率
 *   按真实探测算，延迟分布仍取自样本；不可用（旧 Agent、还没上报）时与原来一样全按样本算。
 */
export function getLatencyStabilityStats(samples: LatencyStabilitySample[], actual?: ProbeStatistics | null): LatencyStabilityStats {
  const weightedSamples = samples.map((sample) => {
    const counts = normalizeLatencyProbeCounts(sample);
    return { sample, ...counts };
  });
  const fromCounters = usableProbeCounters(actual);
  const total = fromCounters
    ? actual.total
    : weightedSamples.reduce((sum, item) => sum + item.probeCount, 0);
  const timeout = fromCounters
    ? actual.total - actual.successes
    : weightedSamples.reduce((sum, item) => sum + item.probeCount - item.probeSuccesses, 0);
  const lossRate = total > 0 ? (timeout / total) * 100 : 0;
  const weightedValues = weightedSamples
    .filter(({ sample, probeSuccesses }) => probeSuccesses > 0 && Number.isFinite(sample.latency) && sample.latency > 0)
    .map(({ sample, probeSuccesses }) => ({ value: sample.latency, weight: probeSuccesses }))
    .sort((a, b) => a.value - b.value);
  const valid = weightedValues.reduce((sum, item) => sum + item.weight, 0);
  // 状态样本里的连续失败不是一串独立的探测（稳定成功被省略、链路复用缓存的跳），
  // 有累计计数时不再拿它扣分；可用率同理按样本算会偏低，此时不显示。
  const maxLossRun = fromCounters ? 0 : getMaxLossRun(samples);
  // 样本都带时间：按时间算，没有偏差，有没有累计计数都能显示。没时间的（老调用方）照旧：有计数时不显示。
  const timedAvailability = computeTimeWeightedAvailability(samples);
  const availability = timedAvailability !== null ? timedAvailability : fromCounters ? null : computeLinkAvailability(samples);
  const timeoutRate = availability === null ? 0 : 100 - availability;
  const counterFlag = fromCounters ? { fromCounters: true } : {};

  if (total === 0) {
    return {
      total,
      timeout,
      valid,
      lossRate,
      max: null,
      min: null,
      avg: null,
      p50: null,
      p95: null,
      jitter: null,
      spikeRate: 0,
      maxLossRun,
      availability,
      timeoutRate,
      score: null,
      rating: getLatencyStabilityRating(null),
      ...counterFlag,
    };
  }

  if (valid === 0) {
    // 有成功的累计探测却没有延迟样本（样本窗口里恰好都是失败行）：不给 0 分误导。
    const score = fromCounters && actual.successes > 0 ? null : applyStabilityCaps(0, lossRate, null, maxLossRun);
    return {
      total,
      timeout,
      valid,
      lossRate,
      max: null,
      min: null,
      avg: null,
      p50: null,
      p95: null,
      jitter: null,
      spikeRate: 0,
      maxLossRun,
      availability,
      timeoutRate,
      score,
      rating: getLatencyStabilityRating(score),
      ...counterFlag,
    };
  }

  const sum = weightedValues.reduce((acc, item) => acc + item.value * item.weight, 0);
  const p50 = weightedPercentile(weightedValues, 50);
  const p95 = weightedPercentile(weightedValues, 95);
  const deviations = weightedValues
    .map((item) => ({ value: Math.abs(item.value - p50), weight: item.weight }))
    .sort((a, b) => a.value - b.value);
  const jitter = weightedPercentile(deviations, 50);
  const spikeThreshold = p50 + Math.max(50, jitter * 4);
  const spikeRate = weightedValues
    .filter((item) => item.value > spikeThreshold)
    .reduce((sum, item) => sum + item.weight, 0) / Math.max(valid, 1);

  const lossScore = interpolateScore(lossRate, [
    [0, 100],
    [0.1, 98],
    [1, 90],
    [3, 75],
    [5, 55],
    [10, 30],
    [20, 10],
    [35, 0],
  ]);
  const latencyScore = interpolateScore(p50, [
    [20, 100],
    [60, 97],
    [120, 92],
    [200, 84],
    [300, 74],
    [500, 58],
    [800, 40],
    [1200, 22],
  ]);
  const jitterScore = Math.min(
    interpolateScore(jitter, [
      [3, 100],
      [10, 96],
      [25, 86],
      [60, 66],
      [120, 42],
      [250, 15],
    ]),
    interpolateScore(jitter / Math.max(p50, 1), [
      [0.03, 100],
      [0.08, 96],
      [0.16, 84],
      [0.3, 64],
      [0.6, 38],
      [1, 15],
    ])
  );
  const spikeScore = Math.min(
    interpolateScore(p95 / Math.max(p50, 1), [
      [1.1, 100],
      [1.35, 92],
      [1.8, 76],
      [2.5, 55],
      [4, 28],
      [6, 10],
    ]),
    interpolateScore(spikeRate * 100, [
      [0, 100],
      [1, 96],
      [3, 88],
      [8, 70],
      [15, 45],
      [30, 18],
    ])
  );
  const continuityScore = interpolateScore(maxLossRun, [
    [0, 100],
    [1, 88],
    [2, 76],
    [4, 55],
    [8, 30],
    [16, 10],
  ]);

  const rawScore =
    lossScore * 0.4
    + jitterScore * 0.2
    + spikeScore * 0.18
    + latencyScore * 0.17
    + continuityScore * 0.05;
  const score = applyStabilityCaps(Math.round(rawScore), lossRate, p50, maxLossRun);

  return {
    total,
    timeout,
    valid,
    lossRate,
    max: weightedValues[weightedValues.length - 1].value,
    min: weightedValues[0].value,
    avg: Math.round(sum / valid),
    p50: Math.round(p50),
    p95: Math.round(p95),
    jitter: Math.round(jitter),
    spikeRate,
    maxLossRun,
    availability,
    timeoutRate,
    score,
    rating: getLatencyStabilityRating(score),
    ...counterFlag,
  };
}

export function getLatencyStabilityRating(score: number | null): LatencyStabilityRating {
  if (score === null) return { label: "暂无", className: "text-muted-foreground" };
  if (score >= 90) return { label: "优秀", className: "text-[var(--fx-healthy-text)]" };
  if (score >= 80) return { label: "良好", className: "text-[var(--fx-healthy-text)]" };
  if (score >= 65) return { label: "一般", className: "text-[var(--fx-warn-text)]" };
  if (score >= 45) return { label: "较差", className: "text-[var(--fx-warn-text)]" };
  if (score >= 25) return { label: "不稳定", className: "text-[var(--fx-down-text)]" };
  return { label: "严重不可用", className: "text-destructive" };
}

function weightedPercentile(
  sortedValues: Array<{ value: number; weight: number }>,
  percentileValue: number,
) {
  if (sortedValues.length === 0) return 0;
  const totalWeight = sortedValues.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (totalWeight <= 0) return 0;
  const target = (Math.max(0, Math.min(100, percentileValue)) / 100) * (totalWeight - 1);
  let cumulative = 0;
  for (const item of sortedValues) {
    const weight = Math.max(0, item.weight);
    if (weight <= 0) continue;
    if (target < cumulative + weight) return item.value;
    cumulative += weight;
  }
  return sortedValues[sortedValues.length - 1].value;
}

function interpolateScore(value: number, points: Array<[number, number]>) {
  if (!Number.isFinite(value)) return 0;
  if (value <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index += 1) {
    const [limit, score] = points[index];
    const [prevLimit, prevScore] = points[index - 1];
    if (value <= limit) {
      const ratio = (value - prevLimit) / Math.max(limit - prevLimit, 1);
      return prevScore + (score - prevScore) * ratio;
    }
  }
  return points[points.length - 1][1];
}

function getMaxLossRun(samples: LatencyStabilitySample[]) {
  let current = 0;
  let max = 0;
  for (const sample of samples) {
    const { probeCount, probeSuccesses, isTimeout } = normalizeLatencyProbeCounts(sample);
    const hasLoss = isTimeout || probeSuccesses < probeCount;
    if (hasLoss) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function applyStabilityCaps(score: number, lossRate: number, p50: number | null, maxLossRun: number) {
  let capped = Math.max(0, Math.min(100, score));
  if (lossRate >= 20) capped = Math.min(capped, 10);
  else if (lossRate >= 10) capped = Math.min(capped, 25);
  else if (lossRate >= 5) capped = Math.min(capped, 45);
  else if (lossRate >= 1) capped = Math.min(capped, 70);

  if (maxLossRun >= 12) capped = Math.min(capped, 35);
  else if (maxLossRun >= 6) capped = Math.min(capped, 55);

  if (p50 !== null) {
    if (p50 >= 1200) capped = Math.min(capped, 55);
    else if (p50 >= 800) capped = Math.min(capped, 65);
    else if (p50 >= 500) capped = Math.min(capped, 75);
    else if (p50 >= 300) capped = Math.min(capped, 85);
    else if (p50 >= 200) capped = Math.min(capped, 92);
  }

  return Math.round(capped);
}
