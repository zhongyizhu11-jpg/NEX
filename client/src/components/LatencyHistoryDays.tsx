import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  LATENCY_HISTORY_DAYS,
  latencyDayHealth,
  latencyDayLossPercent,
  latencyHistoryDays,
  type LatencyDayHealth,
  type LatencyDaySummary,
} from "@shared/latencyHistory";

/*
  近 30 天按天的色块（上游 v2.3.284 移植，见 shared/latencyHistory.ts）。

  一格一天，颜色只看当天的丢包率：≤1% 正常色、≤5% 降级色、>5% 故障色、没有样本灰。
  颜色走语义令牌（--fx-healthy / --fx-warn / --fx-down），所有主题、深浅色自己会换。
  悬停 / 聚焦看当天的样本数、丢包率和平均 / 最小 / 最大延迟。

  两种尺寸：详情弹窗里的 "detail"（带日期刻度），卡片上的 "compact"（一条细条）。
*/

const HEALTH_LABEL: Record<LatencyDayHealth, string> = {
  none: "无数据",
  good: "正常",
  warning: "有丢包",
  bad: "丢包严重",
};

const HEALTH_CELL: Record<LatencyDayHealth, string> = {
  none: "bg-muted",
  good: "bg-[var(--fx-healthy)]",
  warning: "bg-[var(--fx-warn)]",
  bad: "bg-[var(--fx-down)]",
};

export type LatencyHistoryDay = ReturnType<typeof latencyHistoryDays>[number] & {
  summary: LatencyDaySummary | null;
  health: LatencyDayHealth;
};

/** 把服务端返回的按天汇总铺到最近 30 天上（没数据的天补空）。 */
export function buildLatencyHistoryDays(summaries: LatencyDaySummary[] | null | undefined, nowMs = Date.now()): LatencyHistoryDay[] {
  const byDay = new Map((summaries || []).map((summary) => [Number(summary.dayStart), summary]));
  return latencyHistoryDays(nowMs).map((day) => {
    const summary = byDay.get(day.dayStart) || null;
    return { ...day, summary, health: latencyDayHealth(summary?.probeCount || 0, summary?.probeSuccesses || 0) };
  });
}

/** 30 天合起来的丢包率和有数据的天数，给标题旁那一句用。 */
export function summarizeLatencyHistory(days: LatencyHistoryDay[]) {
  let total = 0;
  let successes = 0;
  let measuredDays = 0;
  for (const day of days) {
    if (!day.summary || day.summary.probeCount <= 0) continue;
    measuredDays += 1;
    total += day.summary.probeCount;
    successes += Math.min(day.summary.probeCount, day.summary.probeSuccesses);
  }
  return { measuredDays, lossPercent: total > 0 ? (total - successes) / total * 100 : null };
}

function formatLoss(value: number | null) {
  if (value == null) return "—";
  if (value === 0) return "0%";
  return value < 0.1 ? "<0.1%" : `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function DayTooltip({ day }: { day: LatencyHistoryDay }) {
  const summary = day.summary;
  return (
    <TooltipContent side="top" className="max-w-64 space-y-0.5 text-xs">
      <p className="font-medium">{day.date}{day.isToday ? "（今天）" : ""} · {HEALTH_LABEL[day.health]}</p>
      {summary && summary.probeCount > 0 ? (
        <>
          <p className="tabular-nums">探测 {summary.probeCount.toLocaleString("zh-CN")} 次 · 丢包 {formatLoss(latencyDayLossPercent(summary))}</p>
          <p className="tabular-nums">
            平均 {summary.avgLatencyMs == null ? "—" : `${summary.avgLatencyMs} ms`}
            {summary.minLatencyMs != null ? ` · 最低 ${summary.minLatencyMs}` : ""}
            {summary.maxLatencyMs != null ? ` · 最高 ${summary.maxLatencyMs} ms` : ""}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">这一天没有延迟记录</p>
      )}
    </TooltipContent>
  );
}

export function LatencyHistoryDayStrip({
  summaries,
  loading = false,
  variant = "detail",
  className,
  nowMs,
}: {
  summaries: LatencyDaySummary[] | null | undefined;
  loading?: boolean;
  variant?: "detail" | "compact";
  className?: string;
  nowMs?: number;
}) {
  const days = useMemo(() => buildLatencyHistoryDays(summaries, nowMs), [summaries, nowMs]);
  const overall = useMemo(() => summarizeLatencyHistory(days), [days]);
  const compact = variant === "compact";
  const caption = loading
    ? "加载中"
    : overall.measuredDays === 0
      ? "还没有记录"
      : `${overall.measuredDays} 天有记录 · 丢包 ${formatLoss(overall.lossPercent)}`;

  if (compact) {
    return (
      <div className={cn("flex min-w-0 items-center gap-2", className)} data-latency-history="compact">
        <span className="shrink-0 text-[11px] text-muted-foreground">30 天</span>
        <div role="list" aria-label={`近 ${LATENCY_HISTORY_DAYS} 天延迟：${caption}`} className="flex h-2.5 min-w-0 flex-1 gap-px">
          {days.map((day) => (
            <Tooltip key={day.date}>
              <TooltipTrigger asChild>
                <span
                  role="listitem"
                  tabIndex={-1}
                  aria-label={`${day.date} ${HEALTH_LABEL[day.health]}`}
                  data-health={day.health}
                  className={cn("h-full min-w-0 flex-1 rounded-[2px]", loading ? "animate-pulse bg-muted" : HEALTH_CELL[day.health], day.isToday && "opacity-80")}
                />
              </TooltipTrigger>
              <DayTooltip day={day} />
            </Tooltip>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className={cn("space-y-2 rounded-lg border bg-muted/20 p-3", className)} aria-label={`近 ${LATENCY_HISTORY_DAYS} 天延迟`} data-latency-history="detail">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium">近 {LATENCY_HISTORY_DAYS} 天</h3>
        <p className="text-xs tabular-nums text-muted-foreground">{caption}</p>
      </div>
      <div role="list" className="flex h-7 gap-0.5 sm:gap-1">
        {days.map((day) => (
          <Tooltip key={day.date}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="listitem"
                aria-label={`${day.date} ${HEALTH_LABEL[day.health]}`}
                data-health={day.health}
                className={cn(
                  "h-full min-w-0 flex-1 rounded-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  loading ? "animate-pulse bg-muted" : HEALTH_CELL[day.health],
                  day.isToday && "ring-1 ring-inset ring-foreground/25",
                )}
              />
            </TooltipTrigger>
            <DayTooltip day={day} />
          </Tooltip>
        ))}
      </div>
      <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>{days[0]?.label}</span>
        <span className="hidden items-center gap-3 sm:flex" aria-hidden="true">
          <span className="inline-flex items-center gap-1"><span className={cn("h-2 w-2 rounded-sm", HEALTH_CELL.good)} />丢包 ≤1%</span>
          <span className="inline-flex items-center gap-1"><span className={cn("h-2 w-2 rounded-sm", HEALTH_CELL.warning)} />≤5%</span>
          <span className="inline-flex items-center gap-1"><span className={cn("h-2 w-2 rounded-sm", HEALTH_CELL.bad)} />&gt;5%</span>
          <span className="inline-flex items-center gap-1"><span className={cn("h-2 w-2 rounded-sm", HEALTH_CELL.none)} />无数据</span>
        </span>
        <span>今天</span>
      </div>
    </section>
  );
}
