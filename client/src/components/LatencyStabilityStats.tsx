import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatStatLatency, formatStatPercent, type LatencyStabilityStats as LatencyStabilityStatsValue } from "@/lib/latencyChart";
import type { ReactNode } from "react";
import type { ProbeStatistics } from "@shared/probeStatistics";

type LatencyStabilityStatsProps = {
  stats: LatencyStabilityStatsValue;
  sampleLabel?: string;
  /** compact：窄面板里（线路组面板）一直三列；默认手机三列、宽屏一行九格。 */
  layout?: "auto" | "compact";
  /**
   * 传了就表示这个弹窗有累计探测计数可查（Agent 2.2.229+），卡片下面多一行说明次数从哪来。
   * undefined：这类数据没有累计计数（主机探测、线路组历史），不显示说明。
   */
  counterStatistics?: ProbeStatistics | null;
  /** 说明行后半句：这份次数统计的是什么（逐跳、单目标…），不是业务丢包。 */
  description?: string;
};

function formatCounterTime(value: Date | string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
}

/*
  延迟统计的九格卡片：隧道、转发链、TCPing / Ping、主机探测、线路组质量历史共用。

  每格一句短说明（悬停或长按标签看），说的是「这个数怎么来的」—— P95、抖动、可用率这几个
  词不是人人都熟，而丢包率和可用率又最容易被当成一回事。
*/
export const LATENCY_STAT_HINTS = {
  total: "这段时间里一共记了多少个探测包（一次多包探测按包数算）",
  availability: "至少通了一次的探测记录占比。和丢包率不同：5 个包丢 1 个算 20% 丢包，但这一次仍然可用。100% 减去它就是超时率",
  loss: "没回来的包占全部探测包的比例",
  avg: "所有成功探测的平均延迟",
  p95: "95% 的探测都不超过这个延迟；比平均值更能反映偶尔的卡顿",
  jitter: "延迟偏离中位数的典型幅度（中位数绝对偏差）；越小越稳，打游戏、语音最怕它大",
  min: "这段时间里最快的一次",
  max: "这段时间里最慢的一次（成功的探测里）",
  score: "综合丢包、抖动、尖峰、延迟和连续断线算出的 0–100 分",
  availabilityCounters: "按累计探测次数统计时不显示：可用率要按次看每次探测是否通，而状态样本省略了稳定成功的上报，按样本算会偏低",
} as const;

function StatCard({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="latency-stat-card min-w-0 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5 sm:rounded-lg sm:px-2.5 sm:py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <p className="cursor-help truncate text-[10px] text-muted-foreground underline decoration-dotted decoration-muted-foreground/40 underline-offset-2 sm:text-[11px]" tabIndex={0} aria-label={`${label}：${hint}`}>
            {label}
          </p>
        </TooltipTrigger>
        <TooltipContent side="top">{hint}</TooltipContent>
      </Tooltip>
      <div className="mt-0.5 min-w-0 sm:mt-1">{children}</div>
    </div>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <p className="truncate text-xs font-semibold tabular-nums sm:text-sm">{children}</p>;
}

export function LatencyStabilityStats({
  stats,
  sampleLabel = "统计次数",
  layout = "auto",
  counterStatistics,
  description,
}: LatencyStabilityStatsProps) {
  const empty = stats.total === 0;
  const grid = (
    <div
      className={cn("grid grid-cols-3 gap-1.5 sm:gap-2", layout === "auto" && "sm:grid-cols-9")}
      data-latency-stats="true"
    >
      <StatCard label={sampleLabel} hint={LATENCY_STAT_HINTS.total}>
        <Value>{stats.total}</Value>
      </StatCard>
      <StatCard label="可用率" hint={stats.fromCounters ? LATENCY_STAT_HINTS.availabilityCounters : LATENCY_STAT_HINTS.availability}>
        <Value>{empty ? "--" : formatStatPercent(stats.availability)}</Value>
      </StatCard>
      <StatCard label="丢包率" hint={LATENCY_STAT_HINTS.loss}>
        <Value>{empty ? "--" : formatStatPercent(stats.lossRate)}</Value>
      </StatCard>
      <StatCard label="平均延迟" hint={LATENCY_STAT_HINTS.avg}>
        <Value>{formatStatLatency(stats.avg)}</Value>
      </StatCard>
      <StatCard label="P95 延迟" hint={LATENCY_STAT_HINTS.p95}>
        <Value>{formatStatLatency(stats.p95)}</Value>
      </StatCard>
      <StatCard label="抖动" hint={LATENCY_STAT_HINTS.jitter}>
        <Value>{formatStatLatency(stats.jitter)}</Value>
      </StatCard>
      <StatCard label="最小延迟" hint={LATENCY_STAT_HINTS.min}>
        <Value>{formatStatLatency(stats.min)}</Value>
      </StatCard>
      <StatCard label="最大延迟" hint={LATENCY_STAT_HINTS.max}>
        <Value>{formatStatLatency(stats.max)}</Value>
      </StatCard>
      <StatCard label="稳定性" hint={LATENCY_STAT_HINTS.score}>
        <Value>{stats.score === null ? "--" : `${stats.score}/100`}</Value>
        <p className={`truncate text-[10px] font-medium sm:text-[11px] ${stats.rating.className}`}>
          {stats.rating.label}
        </p>
      </StatCard>
    </div>
  );
  if (counterStatistics === undefined) return grid;
  const latestAt = formatCounterTime(counterStatistics?.latestAt);
  return (
    <div className="space-y-1.5">
      {grid}
      <p className="text-[11px] leading-relaxed text-muted-foreground" data-probe-counter-note={stats.fromCounters ? "counters" : "samples"}>
        {stats.fromCounters
          ? `次数和丢包率按 Agent 上报的累计探测次数统计${latestAt ? `（截至 ${latestAt}）` : ""}，包含没有单独上报的稳定成功探测。`
          : "暂无累计探测计数，次数和丢包率按图上的状态样本统计：Agent 在链路稳定时约 5 分钟才报一次成功、失败却每次都报，丢包率会偏高。升级 Agent 后自动改按真实探测次数统计。"}
        {description ? ` ${description}` : ""}
      </p>
    </div>
  );
}
