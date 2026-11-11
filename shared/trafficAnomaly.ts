/*
  流量异常检测（设置 › Webhook 下方「流量异常」）里不碰数据库、不碰网络的那部分：
  设置的规整、基线怎么算、一次采样怎么判、什么时候算恢复。面板侧的执行在 server/ops/trafficAnomaly.ts。

  口径（文档 docs/guide/traffic-anomaly.md 写的就是这里）：
  - 速率取「较大的一向」（上行、下行里大的那个，Mbps）：规则限速对两个方向各用同一个数，
    拿较大的一向比、限速也限到这一向，前后说得通。
  - 基线 = max(近 3 天每 30 分钟一档的中位数, 前几天同一时段的典型值)。只用中位数的话，每天晚高峰
    都会被当成「突增」；只用同时段的话，三天就三个点，太容易被一次偶然拉高。两个取大的那个，宁可少报。
  - 「突增」= 现在 ≥ 基线 × 倍数 且 ≥ 绝对下限；连续这么久才算（持续时间）。
  - 资历不够不判：规则（或用户）建起来不满 24 小时、面板攒的分桶数据不满 24 小时，都没有基线。
  - 恢复：回落到异常线的 70% 以下，同样连续那么久才算，免得在线附近来回报。
  - 冷却：同一个对象报过一次之后这么久之内再犯不再发事件和通知（只写面板日志），对应的恢复也不报。
*/

export type TrafficAnomalySensitivity = "high" | "normal" | "low" | "custom";

export type TrafficAnomalyConfig = {
  enabled: boolean;
  sensitivity: TrafficAnomalySensitivity;
  /** 现在是基线的几倍算突增。 */
  multiplier: number;
  /** 绝对下限（Mbps）：低于它不管多少倍都不算。 */
  minMbps: number;
  /** 连续多少分钟才算（恢复也按这个）。 */
  sustainMinutes: number;
  /** 一条规则上单个来源 IP 的连接数达到多少算暴涨；0 = 不看连接数。 */
  ipConnThreshold: number;
  /** 规则突增时自动临时限速（默认关）。 */
  autoThrottle: boolean;
  /** 临时限速多久后自动撤掉。 */
  throttleMinutes: number;
  /** 同一对象报过之后多久内不重复报。 */
  cooldownMinutes: number;
};

type SensitivityPreset = Pick<TrafficAnomalyConfig, "multiplier" | "minMbps" | "sustainMinutes" | "ipConnThreshold">;

export const TRAFFIC_ANOMALY_PRESETS: Record<Exclude<TrafficAnomalySensitivity, "custom">, SensitivityPreset> = {
  high: { multiplier: 3, minMbps: 20, sustainMinutes: 5, ipConnThreshold: 300 },
  normal: { multiplier: 5, minMbps: 50, sustainMinutes: 10, ipConnThreshold: 800 },
  low: { multiplier: 10, minMbps: 100, sustainMinutes: 15, ipConnThreshold: 2000 },
};

export const TRAFFIC_ANOMALY_SENSITIVITY_OPTIONS: ReadonlyArray<{ value: TrafficAnomalySensitivity; label: string; description: string }> = [
  { value: "high", label: "灵敏", description: "3 倍、20 Mbps 以上、持续 5 分钟；单 IP 300 个连接" },
  { value: "normal", label: "标准", description: "5 倍、50 Mbps 以上、持续 10 分钟；单 IP 800 个连接" },
  { value: "low", label: "宽松", description: "10 倍、100 Mbps 以上、持续 15 分钟；单 IP 2000 个连接" },
  { value: "custom", label: "自定义", description: "自己填倍数、下限、持续时间和单 IP 连接数" },
];

export const TRAFFIC_ANOMALY_THROTTLE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "1 小时" },
  { value: 120, label: "2 小时" },
];

export const DEFAULT_TRAFFIC_ANOMALY_CONFIG: TrafficAnomalyConfig = {
  enabled: false,
  sensitivity: "normal",
  ...TRAFFIC_ANOMALY_PRESETS.normal,
  autoThrottle: false,
  throttleMinutes: 30,
  cooldownMinutes: 360,
};

/** 规则 / 用户的基线：建起来、攒数据都要满这么久。 */
export const TRAFFIC_BASELINE_MIN_HISTORY_HOURS = 24;
/** 分桶表只留 72 小时（server/repositories/metricsRepository.ts 的 TRAFFIC_BUCKET_RETENTION_HOURS）。 */
export const TRAFFIC_BASELINE_LOOKBACK_HOURS = 72;
/** 最近这一小时不进基线：正在冲高的那一段把基线一起拉高，就永远报不出来了。 */
export const TRAFFIC_BASELINE_EXCLUDE_RECENT_SECONDS = 3600;
export const TRAFFIC_BUCKET_SECONDS = 30 * 60;
/** 恢复线：异常线的 70%。 */
export const TRAFFIC_RECOVER_RATIO = 0.7;

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value: unknown, fallback: boolean) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

export function normalizeTrafficAnomalySensitivity(value: unknown): TrafficAnomalySensitivity {
  return value === "high" || value === "low" || value === "custom" ? value : "normal";
}

/** 选了三档之一时，四个阈值一律按那一档（存库的旧数不算数）；自定义才用自己填的。 */
export function normalizeTrafficAnomalyConfig(raw: Partial<Record<keyof TrafficAnomalyConfig, unknown>>): TrafficAnomalyConfig {
  const d = DEFAULT_TRAFFIC_ANOMALY_CONFIG;
  const sensitivity = normalizeTrafficAnomalySensitivity(raw.sensitivity);
  const custom: SensitivityPreset = {
    multiplier: clampInt(raw.multiplier, 2, 100, d.multiplier),
    minMbps: clampInt(raw.minMbps, 1, 100_000, d.minMbps),
    sustainMinutes: clampInt(raw.sustainMinutes, 1, 120, d.sustainMinutes),
    ipConnThreshold: Number(raw.ipConnThreshold) === 0 ? 0 : clampInt(raw.ipConnThreshold, 20, 1_000_000, d.ipConnThreshold),
  };
  return {
    enabled: bool(raw.enabled, d.enabled),
    sensitivity,
    ...(sensitivity === "custom" ? custom : TRAFFIC_ANOMALY_PRESETS[sensitivity]),
    autoThrottle: bool(raw.autoThrottle, d.autoThrottle),
    throttleMinutes: clampInt(raw.throttleMinutes, 5, 24 * 60, d.throttleMinutes),
    cooldownMinutes: clampInt(raw.cooldownMinutes, 10, 24 * 60, d.cooldownMinutes),
  };
}

// ---------------- 速率 ----------------

/** 字节 / 秒 → Mbps（保留一位小数）。 */
export function bytesPerSecondToMbps(bps: number) {
  const value = Math.max(0, Number(bps) || 0) * 8 / 1_000_000;
  return Math.round(value * 10) / 10;
}

/** 两个方向里大的那个（Mbps）。 */
export function dominantMbps(inBps: number, outBps: number) {
  return bytesPerSecondToMbps(Math.max(Number(inBps) || 0, Number(outBps) || 0));
}

// ---------------- 基线 ----------------

export type TrafficBucketSample = { bucketStart: number; bytesIn: number; bytesOut: number };

export type TrafficBaseline = {
  /** 用来判定的基线（Mbps）。 */
  baselineMbps: number;
  medianMbps: number;
  /** 前几天同一时段的典型值；一天都对不上时为 null。 */
  sameSlotMbps: number | null;
  /** 基线用了多少小时的数据。 */
  historyHours: number;
};

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

/**
 * 从 30 分钟一档的分桶算基线。
 *
 * historyStart：这个对象「从什么时候起该有数据」（秒）—— 取规则 / 用户的创建时间、面板最早一档分桶、
 * 回看窗口三者里最晚的那个。从它到「一小时前」之间没有分桶的档按 0 算（那段时间就是没流量），
 * 所以一条放了三天没人用的规则突然跑起来是会报的；但这段不满 24 小时就不判（返回 null）。
 */
export function computeTrafficBaseline(
  buckets: readonly TrafficBucketSample[],
  options: { nowSec: number; historyStart: number },
): TrafficBaseline | null {
  const step = TRAFFIC_BUCKET_SECONDS;
  const cutoff = Math.floor((options.nowSec - TRAFFIC_BASELINE_EXCLUDE_RECENT_SECONDS) / step) * step;
  const lookbackStart = options.nowSec - TRAFFIC_BASELINE_LOOKBACK_HOURS * 3600;
  // 向上取整到档：落在半档里的那一档不完整，算进去会把中位数压低。
  const start = Math.ceil(Math.max(options.historyStart, lookbackStart) / step) * step;
  if (!(cutoff > start) || cutoff - start < TRAFFIC_BASELINE_MIN_HISTORY_HOURS * 3600) return null;
  const rateBySlot = new Map<number, number>();
  for (const bucket of buckets) {
    const slot = Math.floor(Number(bucket.bucketStart) / step) * step;
    if (slot < start || slot >= cutoff) continue;
    const bytes = Math.max(Number(bucket.bytesIn) || 0, Number(bucket.bytesOut) || 0);
    rateBySlot.set(slot, (rateBySlot.get(slot) || 0) + bytes);
  }
  const rates: number[] = [];
  for (let slot = start; slot < cutoff; slot += step) rates.push(((rateBySlot.get(slot) || 0) * 8) / step / 1_000_000);
  const medianMbps = median(rates);
  const perDay: number[] = [];
  const nowSlot = Math.floor(options.nowSec / step) * step;
  for (let day = 1; day * 86400 <= TRAFFIC_BASELINE_LOOKBACK_HOURS * 3600; day += 1) {
    const center = nowSlot - day * 86400;
    let best: number | null = null;
    for (const slot of [center - step, center, center + step]) {
      if (slot < start || slot >= cutoff) continue;
      const value = ((rateBySlot.get(slot) || 0) * 8) / step / 1_000_000;
      best = best === null ? value : Math.max(best, value);
    }
    if (best !== null) perDay.push(best);
  }
  const sameSlotMbps = perDay.length > 0 ? median(perDay) : null;
  return {
    baselineMbps: round1(Math.max(medianMbps, sameSlotMbps ?? 0)),
    medianMbps: round1(medianMbps),
    sameSlotMbps: sameSlotMbps === null ? null : round1(sameSlotMbps),
    historyHours: Math.floor((cutoff - start) / 3600),
  };
}

/** 异常线（Mbps）：基线 × 倍数，和绝对下限取大的。没有基线就没有线（不判）。 */
export function trafficAnomalyThreshold(baselineMbps: number | null, config: Pick<TrafficAnomalyConfig, "multiplier" | "minMbps">) {
  if (baselineMbps === null || !Number.isFinite(baselineMbps)) return null;
  return round1(Math.max(config.minMbps, Math.max(0, baselineMbps) * config.multiplier));
}

/** 自动限速限到多少：就限到异常线（向上取整到整数 Mbps，至少 1）。 */
export function trafficThrottleMbps(thresholdMbps: number) {
  return Math.max(1, Math.ceil(Number(thresholdMbps) || 0));
}

// ---------------- 判定 ----------------

export type AnomalyState = {
  firing: boolean;
  /** 连续超过异常线是从什么时候开始的（毫秒）。 */
  overSince: number | null;
  /** 告警中，连续低于恢复线从什么时候开始。 */
  underSince: number | null;
  firedAt: number | null;
  /** 告警期间最高值。 */
  peak: number;
  /** 告警那一刻冻住的异常线：冲高持续一两个小时也不会把线一起抬上去。 */
  threshold: number | null;
  baseline: number | null;
  lastSampleAt: number | null;
  /** 上一次真的发出事件的时间（冷却用）。 */
  lastNotifiedAt: number | null;
  /** 这一轮告警在冷却里，没发事件 —— 对应的恢复也不发。 */
  silent: boolean;
};

export function emptyAnomalyState(): AnomalyState {
  return { firing: false, overSince: null, underSince: null, firedAt: null, peak: 0, threshold: null, baseline: null, lastSampleAt: null, lastNotifiedAt: null, silent: false };
}

export type AnomalyTransition =
  | { kind: "fire"; notify: boolean; value: number; threshold: number; baseline: number | null; durationMs: number }
  | { kind: "recover"; notify: boolean; value: number; threshold: number; baseline: number | null; peak: number; durationMs: number };

export type AnomalyJudgeOptions = { sustainMs: number; cooldownMs: number; nowMs: number };

/** 两次采样隔了这么久（面板卡住、定时器停过）就不往下接着算「连续」。 */
const MAX_SAMPLE_GAP_MS = 3 * 60_000;
/** 定时器有几秒抖动：差几秒也算够了。 */
const SUSTAIN_SLACK_MS = 5_000;

/**
 * 一次采样。threshold 为 null 表示「判不了」（没有基线）：没在告警的就从头算；正在告警的用冻住的线。
 */
export function judgeAnomalySample(
  previous: AnomalyState,
  sample: { value: number; threshold: number | null; baseline?: number | null },
  options: AnomalyJudgeOptions,
): { state: AnomalyState; transition: AnomalyTransition | null } {
  const now = options.nowMs;
  const value = Math.max(0, Number(sample.value) || 0);
  const state: AnomalyState = { ...previous };
  const gap = state.lastSampleAt !== null && now - state.lastSampleAt > MAX_SAMPLE_GAP_MS;
  state.lastSampleAt = now;
  const sustained = (since: number | null) => since !== null && now - since >= options.sustainMs - SUSTAIN_SLACK_MS;

  if (!state.firing) {
    const threshold = sample.threshold;
    if (threshold === null || value < threshold) {
      state.overSince = null;
      return { state, transition: null };
    }
    if (state.overSince === null || gap) state.overSince = now;
    if (!sustained(state.overSince)) return { state, transition: null };
    const notify = state.lastNotifiedAt === null || now - state.lastNotifiedAt >= options.cooldownMs;
    const durationMs = now - state.overSince;
    Object.assign(state, {
      firing: true,
      firedAt: state.overSince,
      underSince: null,
      peak: value,
      threshold,
      baseline: sample.baseline ?? null,
      silent: !notify,
      lastNotifiedAt: notify ? now : state.lastNotifiedAt,
    });
    return { state, transition: { kind: "fire", notify, value, threshold, baseline: state.baseline, durationMs } };
  }

  const threshold = state.threshold ?? sample.threshold ?? 0;
  state.peak = Math.max(state.peak, value);
  // 告警中照样记着「连续超线」：自动限速到期撤掉后，要再连续超这么久才重新限。
  if (value >= threshold) {
    if (state.overSince === null || gap) state.overSince = now;
  } else {
    state.overSince = null;
  }
  if (value >= threshold * TRAFFIC_RECOVER_RATIO) {
    state.underSince = null;
    return { state, transition: null };
  }
  if (state.underSince === null || gap) state.underSince = now;
  if (!sustained(state.underSince)) return { state, transition: null };
  const transition: AnomalyTransition = {
    kind: "recover",
    notify: !state.silent,
    value,
    threshold,
    baseline: state.baseline,
    peak: state.peak,
    durationMs: Math.max(0, now - (state.firedAt ?? now)),
  };
  Object.assign(state, { firing: false, overSince: null, underSince: null, firedAt: null, peak: 0, threshold: null, baseline: null, silent: false });
  return { state, transition };
}

/** 这份状态还有没有必要留着：没在告警、没在攒「连续」、冷却也过了。 */
export function isAnomalyStateIdle(state: AnomalyState, nowMs: number, cooldownMs: number) {
  if (state.firing || state.overSince !== null) return false;
  return state.lastNotifiedAt === null || nowMs - state.lastNotifiedAt >= cooldownMs;
}

// ---------------- 临时限速 ----------------

export type AnomalyThrottle = { ruleId: number; mbps: number; appliedAt: number; expiresAt: number };

/**
 * 叠上临时限速之后规则这一级的限速（Mbps）。人手动设的 manualMbps 原样留着，只是取两者里严的那个：
 * 手动的更严就等于临时限速不起作用；撤掉临时限速就回到手动那个数。
 */
export function combineRuleRateWithThrottle(manualMbps: unknown, throttle: Pick<AnomalyThrottle, "mbps" | "expiresAt"> | null | undefined, nowMs: number) {
  const manual = Math.max(0, Math.floor(Number(manualMbps) || 0));
  if (!throttle || !(throttle.expiresAt > nowMs) || !(throttle.mbps > 0)) return manual;
  return manual > 0 ? Math.min(manual, throttle.mbps) : throttle.mbps;
}

/** 要不要加临时限速：手动限速已经不比它松（≤ 临时那个数）就不加，加了也是摆设。 */
export function shouldApplyThrottle(manualMbps: unknown, throttleMbps: number) {
  const manual = Math.max(0, Math.floor(Number(manualMbps) || 0));
  return throttleMbps > 0 && (manual === 0 || manual > throttleMbps);
}

/** 「14:30」：按北京时间，和 Telegram 通知里的时间一致。 */
export function formatThrottleUntil(ms: number) {
  try {
    return new Date(ms).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

/** 「12 分钟」「1 小时 5 分钟」。 */
export function formatAnomalyDuration(ms: number) {
  const minutes = Math.max(1, Math.round(Math.max(0, ms) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

export function formatMbps(value: number) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1000) return `${round1(n / 1000)} Gbps`;
  return `${n >= 100 ? Math.round(n) : round1(n)} Mbps`;
}
