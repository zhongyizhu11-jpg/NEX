/*
  从 client/src/pages/Rules.tsx 第 4953-5022 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { type RuleViewMode } from "../../pages/Rules";
import { useDailyTrafficSpark } from "@/features/traffic/useDailyTrafficSpark";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { useMemo } from "react";

export type UseRuleTrafficSeriesContext = {
  dailyTrafficSummaryRows: Array<any>;
  secondaryQueriesReady: boolean;
  visibleRuleIdsForMetrics: Array<number>;
  effectiveViewMode: RuleViewMode;
  totalTrafficSummaryRows: Array<any>;
};

export type UseRuleTrafficSeriesResult = {
  dailyTrafficByRule: Map<number, { bytesIn: number; bytesOut: number; }>;
  totalTrafficByRule: Map<number, { bytesIn: number; bytesOut: number; connections: number; }>;
  sparkByRule: Map<number, Array<number>>;
  dailySpark: { values: Array<number>; bytesIn: number; bytesOut: number; loading: boolean; };
};

export function useRuleTrafficSeries(ctx: UseRuleTrafficSeriesContext): UseRuleTrafficSeriesResult {
  const { dailyTrafficSummaryRows, secondaryQueriesReady, visibleRuleIdsForMetrics, effectiveViewMode, totalTrafficSummaryRows } = ctx;
  const dailyTrafficByRule = useMemo(() => {
    const m = new Map<number, { bytesIn: number; bytesOut: number }>();
    dailyTrafficSummaryRows.forEach((t: any) => {
      const rid = Number(t.ruleId);
      const prev = m.get(rid);
      if (prev) {
        prev.bytesIn += Number(t.bytesIn) || 0;
        prev.bytesOut += Number(t.bytesOut) || 0;
      } else {
        m.set(rid, {
          bytesIn: Number(t.bytesIn) || 0,
          bytesOut: Number(t.bytesOut) || 0,
        });
      }
    });
    return m;
  }, [dailyTrafficSummaryRows]);
  /*
    规则卡上那条小走势线：这一页规则近 24 小时的逐时字节，一次请求全拿。表格和地图视图
    不画它，就不请求。
  */
  // 页头右上角那条近 24H 小走势（和首页图表同一条数据，服务端按用户缓存）
  const dailySpark = useDailyTrafficSpark(secondaryQueriesReady);
  const { data: ruleTrafficSeriesRows } = trpc.rules.trafficSeriesBatch.useQuery(
    { ruleIds: visibleRuleIdsForMetrics, hours: 24, bucketMinutes: 60 },
    {
      enabled: secondaryQueriesReady && visibleRuleIdsForMetrics.length > 0 && effectiveViewMode === "card",
      refetchInterval: pollingInterval("slow"),
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      placeholderData: (previousData) => previousData,
    }
  );
  const sparkByRule = useMemo(() => {
    const m = new Map<number, number[]>();
    if (!ruleTrafficSeriesRows) return m;
    const hourMs = 60 * 60 * 1000;
    // 24 格 = 过去 24 个整点小时；正在走的这个小时并进最后一格，刚发生的流量不会被截掉。
    const firstHour = Math.floor(Date.now() / hourMs) - 24;
    ruleTrafficSeriesRows.forEach((row: any) => {
      const rid = Number(row.ruleId);
      const at = new Date(row.bucket).getTime();
      if (!Number.isFinite(at)) return;
      const index = Math.min(23, Math.floor(at / hourMs) - firstHour);
      if (index < 0) return;
      const slots = m.get(rid) || new Array<number>(24).fill(0);
      slots[index] += (Number(row.bytesIn) || 0) + (Number(row.bytesOut) || 0);
      m.set(rid, slots);
    });
    return m;
  }, [ruleTrafficSeriesRows]);
  const totalTrafficByRule = useMemo(() => {
    const m = new Map<number, { bytesIn: number; bytesOut: number; connections: number }>();
    totalTrafficSummaryRows.forEach((t: any) => {
      const rid = Number(t.ruleId);
      const prev = m.get(rid);
      if (prev) {
        prev.bytesIn += Number(t.bytesIn) || 0;
        prev.bytesOut += Number(t.bytesOut) || 0;
        prev.connections += Number(t.connections) || 0;
      } else {
        m.set(rid, {
          bytesIn: Number(t.bytesIn) || 0,
          bytesOut: Number(t.bytesOut) || 0,
          connections: Number(t.connections) || 0,
        });
      }
    });
    return m;
  }, [totalTrafficSummaryRows]);
  return { dailyTrafficByRule, totalTrafficByRule, sparkByRule, dailySpark };
}
