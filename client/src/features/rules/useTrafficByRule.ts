/*
  从 client/src/pages/Rules.tsx 第 5003-5071 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { type RuleChainLatencyLike } from "@/features/rules/ruleCardProps";
import { useMemo } from "react";

export type UseTrafficByRuleContext = {
  dailyTrafficSummaryRows: Array<any>;
};

export type UseTrafficByRuleResult = {
  trafficByRule: any /* 类型太长或引用了别的模块，手动收拾 */;
};

export function useTrafficByRule(ctx: UseTrafficByRuleContext): UseTrafficByRuleResult {
  const { dailyTrafficSummaryRows } = ctx;
  const trafficByRule = useMemo(() => {
    const m = new Map<number, {
      bytesIn: number;
      bytesOut: number;
      connections: number;
      latestLatencyMs: number | null;
      latestLatencyIsTimeout: boolean;
      latestLatencyAt: Date | string | null;
      latestProbeFailure: string | null;
      /** 负载均衡链路：几台出口报了到目标的情况、其中连得上的几台、规则卡上那一句（server/exitTargetHealth.ts） */
      exitTargetTotal: number | null;
      exitTargetOk: number | null;
      exitTargetNote: string | null;
      /** 负载均衡链路：入口报的在用出口（扛流量最多的排第一；2.3.537 起只在主出口切走时有，现在入口报了就有） */
      exitTargetVia: string[] | null;
      exitTargetViaHostIds: number[] | null;
      /** 卡上的延迟是面板探的两段相加：在用那台出口、入口到它、它到目标（server/exitTargetHealth.ts 的 RuleChainLatencyView） */
      latestLatencyChain: RuleChainLatencyLike | null;
      /** 卡上这个延迟从哪来：live 入口实时、probe 定时探测、diagnosis 最近一次诊断（悬停写明） */
      latestLatencySource: string | null;
    }>();
    dailyTrafficSummaryRows.forEach((t: any) => {
      const rid = Number(t.ruleId);
      const prev = m.get(rid);
      if (prev) {
        if (t.exitTargetTotal != null) {
          prev.exitTargetTotal = Number(t.exitTargetTotal);
          prev.exitTargetOk = t.exitTargetOk == null ? null : Number(t.exitTargetOk);
          prev.exitTargetNote = t.exitTargetNote || null;
        }
        // 在用的出口：只有一台出口报了数据时 exitTargetTotal 是空的，照样要带上（2.3.539）
        if (Array.isArray(t.exitTargetVia)) {
          prev.exitTargetVia = t.exitTargetVia.map(String);
          prev.exitTargetViaHostIds = Array.isArray(t.exitTargetViaHostIds) ? t.exitTargetViaHostIds.map(Number) : null;
        }
        prev.bytesIn += Number(t.bytesIn) || 0;
        prev.bytesOut += Number(t.bytesOut) || 0;
        prev.connections += Number(t.connections) || 0;
        const prevAt = prev.latestLatencyAt ? new Date(prev.latestLatencyAt).getTime() : 0;
        const nextAt = t.latestLatencyAt ? new Date(t.latestLatencyAt).getTime() : 0;
        if (nextAt > prevAt) {
          prev.latestLatencyMs = t.latestLatencyMs === null || t.latestLatencyMs === undefined ? null : Number(t.latestLatencyMs);
          prev.latestLatencyIsTimeout = !!t.latestLatencyIsTimeout;
          prev.latestLatencyAt = t.latestLatencyAt || null;
          prev.latestProbeFailure = t.latestProbeFailure || null;
          prev.latestLatencyChain = t.latestLatencyChain || null;
          prev.latestLatencySource = t.latestLatencySource || null;
        }
      } else {
        m.set(rid, {
          bytesIn: Number(t.bytesIn) || 0,
          bytesOut: Number(t.bytesOut) || 0,
          connections: Number(t.connections) || 0,
          latestLatencyMs: t.latestLatencyMs === null || t.latestLatencyMs === undefined ? null : Number(t.latestLatencyMs),
          latestLatencyIsTimeout: !!t.latestLatencyIsTimeout,
          latestLatencyAt: t.latestLatencyAt || null,
          latestProbeFailure: t.latestProbeFailure || null,
          exitTargetTotal: t.exitTargetTotal == null ? null : Number(t.exitTargetTotal),
          exitTargetOk: t.exitTargetOk == null ? null : Number(t.exitTargetOk),
          exitTargetNote: t.exitTargetNote || null,
          exitTargetVia: Array.isArray(t.exitTargetVia) ? t.exitTargetVia.map(String) : null,
          exitTargetViaHostIds: Array.isArray(t.exitTargetViaHostIds) ? t.exitTargetViaHostIds.map(Number) : null,
          latestLatencyChain: t.latestLatencyChain || null,
          latestLatencySource: t.latestLatencySource || null,
        });
      }
    });
    return m;
  }, [dailyTrafficSummaryRows]);
  return { trafficByRule };
}
