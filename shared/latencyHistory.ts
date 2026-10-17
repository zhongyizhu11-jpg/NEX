/*
  30 天延迟历史（上游 v2.3.284 的「按天色块」）。

  上游的做法是把原始延迟样本从 72 小时改成保留 30 天。NEX 不这么做：原始样本表
  （tcping_stats / tunnel_latency_stats / forward_group_latency_stats）是全库最大的几张表，
  保留期拉长 10 倍，库就跟着涨 10 倍。这里另建一张按天汇总的小表 latency_daily_stats，
  每个对象每天一行（探测次数、成功次数、成功加权的延迟和、最小 / 最大延迟），30 天就是
  每个对象 30 行；原始样本照旧只留 72 小时、照旧画小时级曲线。

  「一天」按面板时区（BILLING_TIME_ZONE = Asia/Shanghai，固定 UTC+8、没有夏令时）切，
  和账单、提醒同一套日历：服务端汇总时就得定下边界，不能按每个浏览器的本地时区各算一份。
*/
export const LATENCY_HISTORY_DAYS = 30;

/** 面板时区相对 UTC 的偏移（秒）。Asia/Shanghai 全年 +08:00。 */
export const LATENCY_DAY_OFFSET_SECONDS = 8 * 3600;
export const LATENCY_DAY_SECONDS = 86_400;

export type LatencyHistoryTargetType = "rule" | "tunnel" | "group";

/** 某个时刻所在那一天的开始（epoch 秒，面板时区的 0 点）。 */
export function latencyDayStart(epochSeconds: number) {
  return Math.floor((epochSeconds + LATENCY_DAY_OFFSET_SECONDS) / LATENCY_DAY_SECONDS) * LATENCY_DAY_SECONDS - LATENCY_DAY_OFFSET_SECONDS;
}

/** 那一天的日期（YYYY-MM-DD，面板时区）。 */
export function latencyDayKey(dayStartSeconds: number) {
  const date = new Date((dayStartSeconds + LATENCY_DAY_OFFSET_SECONDS) * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** 最近 30 天（含今天），从早到晚。 */
export function latencyHistoryDays(nowMs = Date.now(), count = LATENCY_HISTORY_DAYS) {
  const today = latencyDayStart(Math.floor(nowMs / 1000));
  return Array.from({ length: count }, (_, index) => {
    const dayStart = today - (count - 1 - index) * LATENCY_DAY_SECONDS;
    const date = latencyDayKey(dayStart);
    const [, month, day] = date.split("-").map(Number);
    return { index: index + 1, dayStart, date, label: `${month}/${day}`, isToday: index === count - 1 };
  });
}

export type LatencyDaySummary = {
  dayStart: number;
  probeCount: number;
  probeSuccesses: number;
  avgLatencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
};

export type LatencyDayHealth = "none" | "good" | "warning" | "bad";

/** 按当天的丢包率上色：≤1% 绿、≤5% 黄、>5% 红，没有样本灰（和上游同一档）。 */
export function latencyDayHealth(probeCount: number, probeSuccesses: number): LatencyDayHealth {
  const total = Math.max(0, Number(probeCount) || 0);
  if (total <= 0) return "none";
  const successes = Math.max(0, Math.min(total, Number(probeSuccesses) || 0));
  const loss = (total - successes) / total * 100;
  return loss <= 1 ? "good" : loss <= 5 ? "warning" : "bad";
}

export function latencyDayLossPercent(summary: Pick<LatencyDaySummary, "probeCount" | "probeSuccesses"> | null | undefined) {
  const total = Math.max(0, Number(summary?.probeCount) || 0);
  if (total <= 0) return null;
  const successes = Math.max(0, Math.min(total, Number(summary?.probeSuccesses) || 0));
  return (total - successes) / total * 100;
}
