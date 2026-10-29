import { useEffect, useMemo, useState } from "react";
import { formatLatencyTimeLabel } from "@/lib/latencyTimeLabel";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { LatencyPeakCutToggle } from "@/components/LatencyPeakCutToggle";
import {
  DEFAULT_LATENCY_TIME_RANGE_HOURS,
  filterLatencySeriesByTimeRange,
  latencyTimeRangeLabel,
  LatencyTimeRangeSelect,
  type LatencyTimeRangeHours,
} from "@/components/LatencyTimeRangeSelect";
import { LatencyStabilityStats } from "@/components/LatencyStabilityStats";
import { Skeleton } from "@/components/ui/skeleton";
import {
  applyLatencyPeakCut,
  clipLatencyForChart,
  getLatencyStabilityStats,
  getLatencyYAxisMax,
  getLatencyYAxisTicks,
  isLatencySeriesCacheFresh,
  normalizeLatencyProbeCounts,
} from "@/lib/latencyChart";
import { pollingInterval } from "@/lib/polling";
import { LatencyHistoryDayStrip } from "@/components/LatencyHistoryDays";
import { trpc } from "@/lib/trpc";

type TcpingChartPoint = {
  label: string;
  fullLabel: string;
  latency: number;
  chartLatency: number;
  isTimeout: boolean;
  probeCount?: number | null;
  probeSuccesses?: number | null;
  atMs?: number;
};

type TcpingSeriesDatum = {
  recordedAt: string | Date;
  latencyMs?: number | null;
  isTimeout?: boolean | null;
  probeCount?: number | null;
  probeSuccesses?: number | null;
};

const tcpingSeriesCache = new Map<number, TcpingSeriesDatum[]>();
const tcpingAnimatedKeys = new Set<number>();

function TcpingTooltipContent({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const data = payload[0]?.payload;
  if (!data) return null;
  const latency = Number(data.latency || 0);
  const counts = normalizeLatencyProbeCounts(data);
  const isTimeout = counts.isTimeout;
  return (
    <div className="pointer-events-none rounded-lg border border-border bg-card px-3 py-2 shadow-md">
      <p className="mb-1 text-xs text-muted-foreground">{data.fullLabel || label}</p>
      {isTimeout ? (
        <p className="text-sm font-semibold text-destructive">超时</p>
      ) : latency > 0 ? (
        <p className="text-sm font-semibold tabular-nums">
          <span className={latency < 50 ? "text-[var(--fx-healthy-text)]" : latency < 100 ? "text-[var(--fx-accent)]" : latency < 200 ? "text-[var(--fx-warn-text)]" : "text-destructive"}>
            {latency}ms
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">无数据</p>
      )}
      {counts.probeCount > 1 && counts.probeSuccesses < counts.probeCount ? (
        <p className="mt-1 text-xs text-muted-foreground">
          丢包 {counts.probeCount - counts.probeSuccesses}/{counts.probeCount}（{((counts.probeCount - counts.probeSuccesses) / counts.probeCount * 100).toFixed(0)}%）
        </p>
      ) : null}
    </div>
  );
}

/*
  延迟记录的正文（图、稳定性统计、近 30 天色块），没有对话框外壳：
  并进转发的「诊断」框当一页（Rules.tsx 传给 DiagnoseDialog 的 extraTabs）。
  active 为 false 时不查询（和原来 open 的作用一样）。
*/
export function TcpingDetailBody({
  ruleId,
  isForwardChain = false,
  chainKernel = false,
  probeMethod = "tcping",
  active,
}: {
  ruleId: number;
  isForwardChain?: boolean;
  /** 内核（iptables / nftables）转发链：入口机的一次探测就是端到端；用户态链是各跳相加。 */
  chainKernel?: boolean;
  probeMethod?: "tcping" | "ping";
  active: boolean;
}) {
  const open = active;
  const [peakCutEnabled, setPeakCutEnabled] = useState(false);
  const [timeRangeHours, setTimeRangeHours] = useState<LatencyTimeRangeHours>(DEFAULT_LATENCY_TIME_RANGE_HOURS);
  const methodLabel = probeMethod === "ping" ? "Ping" : "TCPing";
  const { data: counterStatistics } = trpc.rules.probeStatistics.useQuery(
    { ruleId, hours: timeRangeHours },
    { enabled: open, refetchInterval: pollingInterval("slow", open), refetchOnMount: "always" },
  );
  const { data, isLoading, isFetching } = trpc.rules.tcpingSeries.useQuery(
    { ruleId, hours: 24 },
    { enabled: open, refetchInterval: pollingInterval("slow", open), refetchOnMount: "always" },
  );
  // 近 30 天按天的色块：一天一行的汇总，一分钟内不重复请求（server/repositories/latencyDailyRepository.ts）。
  const history = trpc.rules.latencyHistory.useQuery({ ruleId }, { enabled: open, staleTime: 60_000, refetchOnWindowFocus: false });
  const cachedData = tcpingSeriesCache.get(ruleId);
  const rawSeriesData = (data ?? cachedData) as TcpingSeriesDatum[] | undefined;
  const waitForFreshSeries = open && isFetching && !isLatencySeriesCacheFresh(rawSeriesData);
  const seriesData = waitForFreshSeries ? undefined : rawSeriesData;
  const rangedSeriesData = useMemo(
    () => filterLatencySeriesByTimeRange(seriesData, timeRangeHours),
    [seriesData, timeRangeHours],
  );
  const showInitialLoading = (isLoading || waitForFreshSeries) && !seriesData;

  useEffect(() => {
    if (data) tcpingSeriesCache.set(ruleId, data as TcpingSeriesDatum[]);
  }, [data, ruleId]);

  const rawChartData = useMemo<TcpingChartPoint[]>(() => {
    if (!rangedSeriesData.length) return [];
    return rangedSeriesData.map((d: TcpingSeriesDatum): TcpingChartPoint => {
      const counts = normalizeLatencyProbeCounts(d);
      const latency = Number(d.latencyMs) || 0;
      return {
        label: formatLatencyTimeLabel(d.recordedAt),
        fullLabel: formatLatencyTimeLabel(d.recordedAt),
        latency: counts.isTimeout ? 0 : latency,
        chartLatency: counts.isTimeout ? 0 : clipLatencyForChart(latency),
        isTimeout: counts.isTimeout,
        probeCount: counts.probeCount,
        probeSuccesses: counts.probeSuccesses,
        atMs: new Date(d.recordedAt).getTime(),
      };
    });
  }, [rangedSeriesData]);

  const chartData = useMemo<TcpingChartPoint[]>(() => {
    if (!peakCutEnabled) return rawChartData;
    return applyLatencyPeakCut(rawChartData, [
      { dataKey: "latency", timeoutKey: "isTimeout" },
      { dataKey: "chartLatency", timeoutKey: "isTimeout" },
    ]) as TcpingChartPoint[];
  }, [peakCutEnabled, rawChartData]);

  const yMax = useMemo(() => {
    if (!chartData.length) return 120;
    return getLatencyYAxisMax(Math.max(...chartData.map((d) => d.chartLatency)), 120);
  }, [chartData]);
  const yTicks = useMemo(() => getLatencyYAxisTicks(yMax), [yMax]);

  const tcpingStats = useMemo(
    () => getLatencyStabilityStats(chartData, counterStatistics ?? null),
    [chartData, counterStatistics],
  );
  const shouldAnimateChart = open && chartData.length > 0 && !tcpingAnimatedKeys.has(ruleId);

  useEffect(() => {
    if (shouldAnimateChart) tcpingAnimatedKeys.add(ruleId);
  }, [shouldAnimateChart, ruleId]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <span data-fx-help="" className="mr-auto text-xs text-muted-foreground">
            {isForwardChain
              ? chainKernel
                ? `最近 ${latencyTimeRangeLabel(timeRangeHours)}：入口机沿这条链到目标的端到端延迟和丢包。`
                : `最近 ${latencyTimeRangeLabel(timeRangeHours)}：链上各跳探测相加的端到端延迟和丢包。`
              : `最近 ${latencyTimeRangeLabel(timeRangeHours)} 延迟和丢包。`}
          </span>
          <LatencyTimeRangeSelect value={timeRangeHours} onChange={setTimeRangeHours} />
          <LatencyPeakCutToggle id={`tcping-peak-cut-${ruleId}`} checked={peakCutEnabled} onCheckedChange={setPeakCutEnabled} className="shrink-0" />
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
          <div className="h-[42svh] min-h-[220px] w-full sm:h-72">
            {showInitialLoading ? (
              <Skeleton className="h-full w-full" />
            ) : chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                暂无 {methodLabel} 数据
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="tcpingGradientRule" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={48} interval="preserveStartEnd" />
                  <YAxis
                    tick={{ fontSize: 9 }}
                    tickFormatter={(v) => `${v}ms`}
                    width={44}
                    domain={[0, yMax]}
                    allowDecimals={false}
                    ticks={yTicks}
                  />
                  <RTooltip
                    content={<TcpingTooltipContent />}
                    cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }}
                    offset={12}
                    wrapperStyle={{ pointerEvents: "none" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="chartLatency"
                    name="延迟"
                    stroke="var(--color-chart-2)"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="url(#tcpingGradientRule)"
                    dot={false}
                    activeDot={{ r: 4, fill: "var(--color-chart-2)", stroke: "var(--color-background)", strokeWidth: 2 }}
                    isAnimationActive={shouldAnimateChart}
                    animationDuration={shouldAnimateChart ? 500 : 0}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          <LatencyStabilityStats
            stats={tcpingStats}
            counterStatistics={counterStatistics ?? null}
            description={isForwardChain
              ? chainKernel
                ? "内核转发链是透传的：入口机对第一跳的每次 TCP 探测都要走完整条链才算通，统计的就是这条转发自己的端到端探测，不代表业务丢包。"
                : "用户态转发链每跳各自探下一跳，这里按各跳串起来算（一个包要每跳都过）；不代表业务丢包。"
              : "统计的是当前目标的实际探测，不代表业务丢包。"}
          />
          <LatencyHistoryDayStrip summaries={history.data} loading={history.isLoading} />
        </div>
    </div>
  );
}
