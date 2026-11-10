/*
  系统平均负载（1 / 5 / 15 分钟，Agent 2.2.253 起随心跳报 loadAverage）。

  和 shared/hostLoad.ts 不是一回事：那边是「这台机器此刻有多忙」的 0–100 分（CPU、带宽占用取大），
  给线路评分用；这里是 Linux /proc/loadavg 的原始三个数 —— 在跑和等 CPU / 等磁盘的任务数的滑动平均，
  不是百分比，4 核的机器到 4 才算满。只拿来展示，不参与任何评分。

  Agent 报的是小数（0.12）。库里没有浮点列（server/dbSchema.ts 的列类型只有整数和文本），
  所以存成「乘 100 的整数」（loadAvg1 / loadAvg5 / loadAvg15），读出来再除回去。
  没有 /proc/loadavg 的平台、老 Agent 都不报，这三个数是 null，界面上什么都不多画。
*/

export type HostLoadAverage = { load1: number | null; load5: number | null; load15: number | null };
export type HostLoadAverageInput = { load1?: unknown; load5?: unknown; load15?: unknown } | null | undefined;

/** 负载上限：再大也只是个展示用的数，夹住它，免得一个坏上报把整型列撑爆。 */
const LOAD_AVERAGE_MAX = 100_000;

export function normalizeLoadAverageValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(LOAD_AVERAGE_MAX, Math.round(value * 100) / 100);
}

/** Agent 心跳里的 loadAverage：[1 分钟, 5 分钟, 15 分钟]。不是三个数的数组就当没报。 */
export function parseAgentLoadAverage(value: unknown): HostLoadAverage {
  const values = Array.isArray(value) && value.length >= 3 ? value : [];
  return {
    load1: normalizeLoadAverageValue(values[0]),
    load5: normalizeLoadAverageValue(values[1]),
    load15: normalizeLoadAverageValue(values[2]),
  };
}

/** 小数 → 库里的整数（乘 100）；null 还是 null。 */
export function loadAverageToStored(value: number | null | undefined): number | null {
  const normalized = normalizeLoadAverageValue(value);
  return normalized === null ? null : Math.round(normalized * 100);
}

/** 库里的整数 → 小数；null、坏值都是 null。 */
export function loadAverageFromStored(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const stored = Number(value);
  if (!Number.isFinite(stored) || stored < 0) return null;
  return Math.round(stored) / 100;
}

/** 三个数是不是都有 —— 缺一个就整体不画，不拼「0.12 / — / —」这种半截的。 */
export function hasHostLoadAverage(metric: HostLoadAverageInput): boolean {
  return [metric?.load1, metric?.load5, metric?.load15].every((value) => normalizeLoadAverageValue(value) !== null);
}

/** 「0.12 / 0.25 / 0.38」；没报回 null，由调用方决定不画。 */
export function formatHostLoadAverage(metric: HostLoadAverageInput): string | null {
  if (!hasHostLoadAverage(metric)) return null;
  return [metric?.load1, metric?.load5, metric?.load15]
    .map((value) => (normalizeLoadAverageValue(value) as number).toFixed(2))
    .join(" / ");
}

/** 悬停提示用的一整句：「负载（1 / 5 / 15 分钟）：0.12 / 0.25 / 0.38」。 */
export function hostLoadAverageTooltip(metric: HostLoadAverageInput): string | null {
  const text = formatHostLoadAverage(metric);
  return text ? `负载（1 / 5 / 15 分钟）：${text}` : null;
}
