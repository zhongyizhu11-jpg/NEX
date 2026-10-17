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
  /** 内核 OOM killer 杀了进程时告警（Agent ≥ 2.2.230）。 */
  oomAlert: boolean;
  /** forwardx-* 服务崩溃后被 systemd 自动拉起时告警（Agent ≥ 2.2.230）。 */
  crashAlert: boolean;
  /** 隧道探测 10 分钟内丢包率达到多少（%）告警，0 = 不报。 */
  lossPercent: number;
};

export const DEFAULT_RESOURCE_ALERT_CONFIG: ResourceAlertConfig = {
  enabled: false,
  cpuPercent: 90,
  memoryPercent: 90,
  diskPercent: 90,
  sustainSeconds: 300,
  recoverMarginPercent: 5,
  emailEnabled: false,
  oomAlert: true,
  crashAlert: true,
  lossPercent: 20,
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
    oomAlert: source.oomAlert === undefined ? d.oomAlert : source.oomAlert === true || source.oomAlert === "true",
    crashAlert: source.crashAlert === undefined ? d.crashAlert : source.crashAlert === true || source.crashAlert === "true",
    lossPercent: clampInt(source.lossPercent, 0, 100, d.lossPercent),
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

// ---------------- OOM / 服务崩溃（累计计数器） ----------------

/**
 * 累计计数器涨了多少。上一次不知道（面板刚启动、旧 Agent）当作基线，返回 0；
 * 变小了（机器重启、服务被手动 restart 清零）也当作基线重置，返回 0。
 */
export function counterIncrease(previous: number | null | undefined, next: number | null | undefined): number {
  if (previous === null || previous === undefined || next === null || next === undefined) return 0;
  const a = Number(previous);
  const b = Number(next);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return b - a;
}

/** 规整 Agent 报上来的 serviceRestarts：只留 forwardx-* 服务名和非负整数，最多 512 项。 */
export function normalizeServiceRestarts(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  let kept = 0;
  for (const [unit, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= 512) break;
    if (!/^forwardx-[A-Za-z0-9@_.:-]{1,120}$/.test(unit)) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) continue;
    out[unit] = n;
    kept += 1;
  }
  return out;
}

/**
 * 哪些服务这次比上次多重启了。上次是 null（基线）时不报；上次没出现的服务按 0 算
 * （Agent 只报大于 0 的那些，第一次崩就是从 0 变 1）。
 */
export function serviceRestartIncreases(
  previous: Record<string, number> | null | undefined,
  next: Record<string, number>,
): Array<{ unit: string; delta: number; total: number }> {
  if (!previous) return [];
  const out: Array<{ unit: string; delta: number; total: number }> = [];
  for (const [unit, total] of Object.entries(next)) {
    const delta = counterIncrease(previous[unit] ?? 0, total);
    if (delta > 0) out.push({ unit, delta, total });
  }
  return out.sort((a, b) => a.unit.localeCompare(b.unit));
}

// ---------------- 丢包（隧道探测） ----------------

export const LOSS_WINDOW_MS = 10 * 60_000;
/** 窗口里至少这么多次探测才判定，几个包的偶然失败不算。 */
export const LOSS_MIN_PROBES = 10;

export type LossWindowState = {
  samples: Array<{ at: number; count: number; ok: number }>;
  firing: boolean;
  firedAt: number | null;
  peak: number;
};

export function emptyLossWindowState(): LossWindowState {
  return { samples: [], firing: false, firedAt: null, peak: 0 };
}

export type LossTransition = { kind: "fire" | "recover"; lossPercent: number; peak: number; probes: number; durationSeconds: number };

/**
 * 吃一次探测结果（count 个包里成功 ok 个），算 10 分钟窗口里的丢包率。
 * 达到阈值报一次；回落到阈值的一半以下报恢复。阈值是 0 时清掉状态、什么都不报。
 */
export function evaluateLossSample(
  state: LossWindowState,
  thresholdPercent: number,
  sample: { count: number; ok: number },
  nowMs: number,
): { state: LossWindowState; transition: LossTransition | null } {
  if (!(thresholdPercent > 0)) return { state: emptyLossWindowState(), transition: null };
  const count = Math.max(0, Math.floor(Number(sample.count) || 0));
  const ok = Math.min(count, Math.max(0, Math.floor(Number(sample.ok) || 0)));
  const samples = state.samples.filter((item) => nowMs - item.at < LOSS_WINDOW_MS);
  if (count > 0) samples.push({ at: nowMs, count, ok });
  // 心跳几秒一次，窗口最多留 600 个点。
  while (samples.length > 600) samples.shift();
  const probes = samples.reduce((sum, item) => sum + item.count, 0);
  const succeeded = samples.reduce((sum, item) => sum + item.ok, 0);
  const next: LossWindowState = { ...state, samples };
  if (probes < LOSS_MIN_PROBES) return { state: next, transition: null };
  const lossPercent = Math.round(((probes - succeeded) / probes) * 1000) / 10;
  if (next.firing) {
    next.peak = Math.max(next.peak, lossPercent);
    if (lossPercent < thresholdPercent / 2) {
      const transition: LossTransition = {
        kind: "recover",
        lossPercent,
        peak: next.peak,
        probes,
        durationSeconds: Math.max(0, Math.round((nowMs - (next.firedAt ?? nowMs)) / 1000)),
      };
      return { state: { samples, firing: false, firedAt: null, peak: 0 }, transition };
    }
    return { state: next, transition: null };
  }
  if (lossPercent >= thresholdPercent) {
    return {
      state: { samples, firing: true, firedAt: nowMs, peak: lossPercent },
      transition: { kind: "fire", lossPercent, peak: lossPercent, probes, durationSeconds: 0 },
    };
  }
  return { state: next, transition: null };
}
