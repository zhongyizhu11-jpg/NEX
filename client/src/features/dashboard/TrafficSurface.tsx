import { lazy, Suspense, useEffect, useMemo } from "react";

import { ListSection } from "@/components/ios/GroupedList";
import { Metric, MetricGroup } from "@/components/entity/Metric";
import { Skeleton } from "@/components/ui/skeleton";
import { CHART_TRAFFIC_COLORS } from "@/lib/chartPalette";
import { formatBytes } from "@shared/formatBytes";

import {
  formatShare,
  rankRuleTraffic,
  TRAFFIC_RANK_KIND_LABELS,
  type TrafficBreakdown,
} from "./trafficRanking";

/*
  走势图按需加载 —— recharts 不进首屏包。首屏画完就开始取（和走势数据并行），
  不等数据回来再排队下图表库，所以在观感上是免费的。
*/
const loadTrafficCharts = () => import("@/components/charts/DashboardTrafficCharts");
const TrafficAreaChart = lazy(() => loadTrafficCharts().then((m) => ({ default: m.TrafficAreaChart })));

export type TrafficChartPoint = { label: string; fullLabel: string; bytesIn: number; bytesOut: number };

/** 排行画几行。再往下的合成一句「其余 N 条共 X」。 */
const TRAFFIC_RANK_ROWS = 5;

function SeriesKey({ color, label, bytes }: { color: string; label: string; bytes: number | undefined }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      {label}
      <span className="truncate font-medium tabular-nums text-foreground">{bytes === undefined ? "—" : formatBytes(bytes)}</span>
    </span>
  );
}

/**
 * 首页的「流量」。
 *
 * 原来这件事散在四块里：顶上状态区的「近 24H 流量」一格、单独一块「累计入站 /
 * 累计出站」、一张走势图卡、三张按类型拆开的环形图卡 —— 393px 下光这几块就是
 * 2200 多 px，而它们回答的是同一个问题：流量怎么样。
 *
 * 现在是一块：先给一个数（近 24H 总量）和它的入站 / 出站，下面是走势，再下面是
 * 谁用得最多，最后是账户累计。一个问题一块面，从总到分往下读。
 *
 * 颜色：入站走路径青（「流动的数据」本来就是它的语义），出站走中性。上一版入站
 * 用「正常」绿、出站用「降级」琥珀 —— 出站流量不是一个警告。
 */
export function TrafficSurface({
  recentBytes,
  chartData,
  chartLoading,
  breakdown,
  breakdownLoading,
  totals,
  totalsLoading,
}: {
  /** 近 24H 总量；series 还没回来时是 undefined —— 「还没有数」和「真的是 0」是两回事 */
  recentBytes: number | undefined;
  chartData: TrafficChartPoint[];
  chartLoading: boolean;
  breakdown: TrafficBreakdown | null | undefined;
  breakdownLoading: boolean;
  totals: { totalTrafficIn?: number; totalTrafficOut?: number } | null | undefined;
  totalsLoading: boolean;
}) {
  const recentIn = useMemo(() => (chartData.length ? chartData.reduce((sum, point) => sum + point.bytesIn, 0) : undefined), [chartData]);
  const recentOut = useMemo(() => (chartData.length ? chartData.reduce((sum, point) => sum + point.bytesOut, 0) : undefined), [chartData]);
  const ranking = useMemo(() => rankRuleTraffic(breakdown, TRAFFIC_RANK_ROWS), [breakdown]);
  const cumulativeReady = !(totalsLoading && !totals);
  // 挂上就预取图表库（effect 在首屏画完之后才跑）；取不到时 lazy 渲染那一下会再取、再报错
  useEffect(() => { void loadTrafficCharts().catch(() => {}); }, []);

  return (
    <ListSection header="流量 · 近 24H">
      <div className="flex min-w-0 flex-col gap-[var(--fx-space-4)] p-[var(--fx-card-padding)]">
        {/*
          宽屏上走势和排行并排：竖着叠的话，桌面上这一块要 800px，而右边大半截是空的。
        */}
        <div className="grid min-w-0 gap-[var(--fx-space-4)] lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-[var(--fx-space-8)]">
          <div className="flex min-w-0 flex-col gap-[var(--fx-space-4)]">
            <div className="flex min-w-0 flex-col gap-[var(--fx-space-1)]">
              <Metric size="display" value={recentBytes === undefined ? "—" : formatBytes(recentBytes)} />
              <div className="flex min-w-0 flex-wrap gap-x-[var(--fx-space-4)] gap-y-[var(--fx-space-1)]">
                <SeriesKey color={CHART_TRAFFIC_COLORS.in} label="入站" bytes={recentIn} />
                <SeriesKey color={CHART_TRAFFIC_COLORS.out} label="出站" bytes={recentOut} />
              </div>
            </div>

            {/* data-fx-empty：没数据时精简下这块压成一行（compact.css），不留一大块空白 */}
            <div className="h-40 w-full sm:h-52" data-fx-chart="traffic" data-fx-empty={!chartLoading && chartData.length === 0 ? "" : undefined}>
              {chartLoading && chartData.length === 0 ? (
                <Skeleton className="h-full w-full" />
              ) : chartData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-secondary-type text-muted-foreground">暂无流量数据</div>
              ) : (
                <Suspense fallback={<Skeleton className="h-full w-full" />}>
                  <TrafficAreaChart chartData={chartData} />
                </Suspense>
              )}
            </div>
          </div>

          {breakdownLoading && ranking.items.length === 0 ? (
            <div className="flex flex-col gap-[var(--fx-space-3)] border-t border-[var(--fx-stroke-weak)] pt-[var(--fx-space-4)] lg:border-t-0 lg:pt-0" aria-hidden="true">
              {[0, 1, 2].map((item) => <Skeleton key={item} className="h-7 w-full" />)}
            </div>
          ) : ranking.items.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-[var(--fx-space-3)] border-t border-[var(--fx-stroke-weak)] pt-[var(--fx-space-4)] lg:border-t-0 lg:pt-0">
              <h3 className="text-meta font-medium text-muted-foreground">用得最多</h3>
              <ol className="flex min-w-0 flex-col gap-[var(--fx-space-3)]">
                {ranking.items.map((item) => (
                  <li key={item.key} className="flex min-w-0 flex-col gap-[var(--fx-space-1)]">
                    <div className="flex min-w-0 items-baseline gap-[var(--fx-space-2)]">
                      <span className="min-w-0 flex-1 truncate text-secondary-type text-foreground" title={item.name}>{item.name}</span>
                      <span className="shrink-0 text-secondary-type font-medium tabular-nums text-foreground">{formatBytes(item.bytes)}</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-[var(--fx-space-2)]">
                      {/*
                        条的长度相对第一名，不相对总量：五条都在 20% 上下时，按总量画
                        就是五截差不多长的短条，比不出谁多谁少。
                      */}
                      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-[var(--fx-radius-pill)] bg-[var(--fx-stroke-weak)]">
                        <span
                          className="block h-full rounded-[var(--fx-radius-pill)] bg-[var(--fx-network-path-muted)]"
                          style={{ width: `${Math.max(2, Math.round(item.relative * 100))}%` }}
                        />
                      </span>
                      <span className="shrink-0 text-meta text-muted-foreground">
                        {TRAFFIC_RANK_KIND_LABELS[item.kind]} · <span className="tabular-nums">{formatShare(item.share)}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
              {ranking.restCount > 0 ? (
                <p className="text-meta text-muted-foreground">
                  其余 {ranking.restCount} 条共 <span className="tabular-nums">{formatBytes(ranking.restBytes)}</span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/*
          累计和近 24H 是两个口径，放在同一块里才说得清；原来它单独占一块卡片，
          夹在状态区和账户之间，看着像又一组「现在的状态」。
        */}
        <MetricGroup columns={2} className="border-t border-[var(--fx-stroke-weak)] pt-[var(--fx-space-4)]">
          <Metric
            size="inline"
            label="累计入站"
            value={cumulativeReady ? formatBytes(totals?.totalTrafficIn ?? 0) : "—"}
          />
          <Metric
            size="inline"
            label="累计出站"
            value={cumulativeReady ? formatBytes(totals?.totalTrafficOut ?? 0) : "—"}
          />
        </MetricGroup>
      </div>
    </ListSection>
  );
}
