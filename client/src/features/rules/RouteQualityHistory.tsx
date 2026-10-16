import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";

import { LatencyStabilityStats } from "@/components/LatencyStabilityStats";
import { Skeleton } from "@/components/ui/skeleton";
import { formatStatLatency, formatStatPercent, getLatencyYAxisMax, getLatencyYAxisTicks } from "@/lib/latencyChart";
import { formatLatencyTimeLabel } from "@/lib/latencyTimeLabel";
import { routeQualityStats, type RouteQualityPoint } from "@/lib/routeQuality";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/*
  线路组面板里的「线路质量」：每条路径近几小时 / 几天的延迟、抖动走势，下面是和隧道、
  TCPing 同一套统计卡片（P95、抖动、可用率……）。

  数据来自 route_path_quality_stats：入口 Agent 每次心跳报评分，面板每条路径一分钟留一行，
  留 7 天。所以 Agent 升级到会报评分（2.2.198）之前这里是空的。
*/

const RANGE_OPTIONS = [
  { hours: 6, label: "6H" },
  { hours: 24, label: "24H" },
  { hours: 72, label: "3 天" },
  { hours: 168, label: "7 天" },
] as const;

type RouteQualityPath = { key: string; index: number; letter: string; name: string; points: RouteQualityPoint[] };

function QualityTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as (RouteQualityPoint & { fullLabel: string }) | undefined;
  if (!point) return null;
  return (
    <div className="pointer-events-none rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-md">
      <p className="mb-1 text-muted-foreground">{point.fullLabel}</p>
      <p>延迟 <b className="tabular-nums">{point.latencyMs === null ? "超时" : formatStatLatency(point.latencyMs)}</b></p>
      <p>抖动 <span className="tabular-nums">{formatStatLatency(point.jitterMs)}</span> · 丢包 <span className="tabular-nums">{formatStatPercent(point.lossPct, 1)}</span></p>
      <p>可用率 <span className="tabular-nums">{formatStatPercent(point.availabilityPct, 1)}</span>{point.score !== null ? ` · 评分 ${point.score}` : ""}</p>
    </div>
  );
}

export function RouteQualityHistory({ ruleId, enabled, activeKey }: { ruleId: number; enabled: boolean; activeKey?: string | null }) {
  const [hours, setHours] = useState<number>(24);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const query = trpc.rules.routeQualityHistory.useQuery(
    { ruleId, hours },
    { enabled: enabled && ruleId > 0, refetchInterval: enabled ? 60_000 : false, staleTime: 30_000, placeholderData: (previous) => previous },
  );
  const paths = ((query.data as { paths?: RouteQualityPath[] } | null | undefined)?.paths || []) as RouteQualityPath[];
  const selected = paths.find((path) => path.key === pickedKey)
    || paths.find((path) => path.key === activeKey)
    || paths.find((path) => path.points.length > 0)
    || paths[0]
    || null;
  const chartData = useMemo(() => (selected?.points || []).map((point) => ({
    ...point,
    label: formatLatencyTimeLabel(new Date(point.at)),
    fullLabel: new Date(point.at).toLocaleString("zh-CN", { hour12: false }),
  })), [selected]);
  const stats = useMemo(() => routeQualityStats(selected?.points || []), [selected]);
  const yMax = getLatencyYAxisMax(Math.max(0, ...chartData.map((point) => Math.max(point.latencyMs || 0, point.jitterMs || 0))));
  const yTicks = getLatencyYAxisTicks(yMax);

  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="route-quality-history">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-secondary-type font-semibold text-foreground">线路质量</p>
        <div className="flex items-center gap-1" role="group" aria-label="时间范围">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.hours}
              type="button"
              aria-pressed={hours === option.hours}
              className={cn(
                "rounded-full px-2 py-0.5 text-meta tabular-nums transition-colors",
                hours === option.hours ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
              onClick={() => setHours(option.hours)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {paths.length > 1 ? (
        <div className="flex flex-wrap gap-1 px-1" role="group" aria-label="选择路径">
          {paths.map((path) => (
            <button
              key={path.key}
              type="button"
              aria-pressed={selected?.key === path.key}
              className={cn(
                "max-w-full truncate rounded-[var(--fx-radius-control)] border px-2 py-0.5 text-meta transition-colors",
                selected?.key === path.key ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted",
              )}
              onClick={() => setPickedKey(path.key)}
            >
              {path.letter} {path.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="h-44 w-full">
        {query.isLoading && !query.data ? (
          <Skeleton className="h-full w-full" />
        ) : chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-[var(--fx-radius-control)] border border-dashed border-border px-4 text-center text-meta text-muted-foreground">
            这段时间还没有质量记录。入口 Agent 报评分（2.2.198 起）后，每条路径每分钟记一个点，保留 7 天。
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 6, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={40} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 9 }} tickFormatter={(value) => `${value}ms`} width={44} domain={[0, yMax]} ticks={yTicks} allowDecimals={false} />
              <RTooltip content={<QualityTooltip />} cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }} wrapperStyle={{ pointerEvents: "none" }} />
              <Line type="monotone" dataKey="latencyMs" name="延迟" stroke="var(--color-chart-2)" strokeWidth={1.6} dot={false} connectNulls={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="jitterMs" name="抖动" stroke="var(--color-chart-4)" strokeWidth={1.2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <LatencyStabilityStats stats={stats} sampleLabel="采样点" layout="compact" />
    </section>
  );
}
