/*
  资源告警（设置 › 资源告警）前后端共用的定义和判定：CPU / 内存 / 磁盘超过阈值、持续一段时间才报，
  回落到阈值减去回差以下才算恢复。

  - 持续时间：一次心跳冲到 100% 不报（编译、备份、开机都会这样），连续超过 sustainSeconds 才报。
    中间有一次心跳回落到阈值以下，计时从头算。
  - 回差：阈值 90%、回差 5 —— 报警之后要回到 85% 以下才算恢复，免得在 89% / 91% 之间来回报。
  - 一次告警只报一次「超过」和一次「恢复」；告警期间的最高值记在 peak 里，恢复消息里带上。
  - 全是纯函数：状态由调用方（server/resourceAlertNotifier.ts）按主机存着，这里只算下一步。
*/

export type ResourceAlertMetric = "cpu" | "memory" | "disk";

export const RESOURCE_ALERT_METRICS: ReadonlyArray<{ key: ResourceAlertMetric; label: string }> = [
  { key: "cpu", label: "CPU" },
  { key: "memory", label: "内存" },
  { key: "disk", label: "磁盘" },
];

export type ResourceAlertConfig = {
  enabled: boolean;
  /** 各项阈值（%），0 = 这一项不报。 */
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
  /** 连续超过多少秒才报。 */
  sustainSeconds: number;
  /** 回落到「阈值 - 回差」以下才算恢复。 */
  recoverMarginPercent: number;
  /** 是否同时发邮件给有邮箱的管理员（需要面板邮件服务已开启）。 */
  emailEnabled: boolean;
};

export const DEFAULT_RESOURCE_ALERT_CONFIG: ResourceAlertConfig = {
  enabled: false,
  cpuPercent: 90,
  memoryPercent: 90,
  diskPercent: 90,
  sustainSeconds: 300,
  recoverMarginPercent: 5,
  emailEnabled: false,
};

export const RESOURCE_ALERT_SUSTAIN_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 60, label: "1 分钟" },
  { value: 180, label: "3 分钟" },
  { value: 300, label: "5 分钟" },
  { value: 600, label: "10 分钟" },
  { value: 1800, label: "30 分钟" },
];

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 阈值：0 关掉这一项；否则 50–100。 */
function normalizeThreshold(value: unknown, fallback: number) {
  const n = clampInt(value, 0, 100, fallback);
  return n === 0 ? 0 : Math.max(50, n);
}

export function normalizeResourceAlertConfig(raw: Partial<Record<keyof ResourceAlertConfig, unknown>> | null | undefined): ResourceAlertConfig {
  const source = raw || {};
  const d = DEFAULT_RESOURCE_ALERT_CONFIG;
  return {
    enabled: source.enabled === true || source.enabled === "true",
    cpuPercent: normalizeThreshold(source.cpuPercent, d.cpuPercent),
    memoryPercent: normalizeThreshold(source.memoryPercent, d.memoryPercent),
    diskPercent: normalizeThreshold(source.diskPercent, d.diskPercent),
    sustainSeconds: clampInt(source.sustainSeconds, 30, 3600, d.sustainSeconds),
    recoverMarginPercent: clampInt(source.recoverMarginPercent, 0, 30, d.recoverMarginPercent),
    emailEnabled: source.emailEnabled === true || source.emailEnabled === "true",
  };
}

export function resourceAlertThreshold(config: ResourceAlertConfig, metric: ResourceAlertMetric) {
  return metric === "cpu" ? config.cpuPercent : metric === "memory" ? config.memoryPercent : config.diskPercent;
}

export type ResourceAlertMetricState = {
  /** 从什么时候起连续超过阈值（毫秒）；没超过是 null。 */
  aboveSince: number | null;
  /** 已经报过「超过」、还没恢复。 */
  firing: boolean;
  firedAt: number | null;
  peak: number;
};

export type ResourceAlertHostState = Record<ResourceAlertMetric, ResourceAlertMetricState>;

export function emptyResourceAlertHostState(): ResourceAlertHostState {
  const blank = (): ResourceAlertMetricState => ({ aboveSince: null, firing: false, firedAt: null, peak: 0 });
  return { cpu: blank(), memory: blank(), disk: blank() };
}

export type ResourceAlertSample = Partial<Record<ResourceAlertMetric, number | null | undefined>>;

export type ResourceAlertTransition = {
  metric: ResourceAlertMetric;
  kind: "fire" | "recover";
  value: number;
  threshold: number;
  peak: number;
  /** fire：已经持续超过多少秒；recover：告警持续了多少秒。 */
  durationSeconds: number;
};

/**
 * 吃一次心跳的指标，返回新状态和这次该报的事（可能为空）。
 *
 * 没报的指标（旧 Agent、读不到）保持原状态，不当作回落 —— 不然一次缺数据就会误报恢复。
 * 阈值改成 0（关掉这一项）或整个功能关掉时，正在告警的那几项直接清掉，不报恢复。
 */
export function evaluateResourceAlertSample(
  state: ResourceAlertHostState,
  config: ResourceAlertConfig,
  sample: ResourceAlertSample,
  nowMs: number,
): { state: ResourceAlertHostState; transitions: ResourceAlertTransition[] } {
  const next: ResourceAlertHostState = {
    cpu: { ...state.cpu },
    memory: { ...state.memory },
    disk: { ...state.disk },
  };
  const transitions: ResourceAlertTransition[] = [];
  for (const { key } of RESOURCE_ALERT_METRICS) {
    const threshold = resourceAlertThreshold(config, key);
    const current = next[key];
    if (!config.enabled || threshold <= 0) {
      next[key] = { aboveSince: null, firing: false, firedAt: null, peak: 0 };
      continue;
    }
    const raw = sample[key];
    if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) continue;
    const value = Math.max(0, Math.min(100, Number(raw)));
    if (current.firing) {
      current.peak = Math.max(current.peak, value);
      const recoverBelow = Math.max(0, threshold - config.recoverMarginPercent);
      if (value < recoverBelow) {
        transitions.push({
          metric: key,
          kind: "recover",
          value,
          threshold,
          peak: current.peak,
          durationSeconds: Math.max(0, Math.round((nowMs - (current.firedAt ?? nowMs)) / 1000)),
        });
        next[key] = { aboveSince: null, firing: false, firedAt: null, peak: 0 };
      }
      continue;
    }
    if (value < threshold) {
      next[key] = { aboveSince: null, firing: false, firedAt: null, peak: 0 };
      continue;
    }
    const since = current.aboveSince ?? nowMs;
    const peak = Math.max(current.aboveSince === null ? 0 : current.peak, value);
    const elapsedSeconds = (nowMs - since) / 1000;
    if (elapsedSeconds >= config.sustainSeconds) {
      transitions.push({ metric: key, kind: "fire", value, threshold, peak, durationSeconds: Math.round(elapsedSeconds) });
      next[key] = { aboveSince: since, firing: true, firedAt: nowMs, peak };
    } else {
      next[key] = { aboveSince: since, firing: false, firedAt: null, peak };
    }
  }
  return { state: next, transitions };
}

export function resourceAlertMetricLabel(metric: ResourceAlertMetric) {
  return RESOURCE_ALERT_METRICS.find((item) => item.key === metric)?.label ?? metric;
}
