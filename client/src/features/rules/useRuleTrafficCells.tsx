/*
  从 client/src/pages/Rules.tsx 第 6477-6552 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { type ReactElement } from "react";
import { formatProbeAge, type RuleCardRule } from "../../pages/Rules";
import { LatencyRating } from "@/components/LatencyRating";
import { describeRuleLatency } from "@/features/rules/ruleCardProps";
import { formatBytes } from "@shared/formatBytes";
import { isLinkProbeFresh } from "@shared/linkProbePolicy";
import { describeProbeFailureShort } from "@shared/probeFailure";
import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine } from "lucide-react";

export type UseRuleTrafficCellsContext = {
  dailyTrafficByRule: Map<number, { bytesIn: number; bytesOut: number; }>;
  totalTrafficByRule: Map<number, { bytesIn: number; bytesOut: number; connections: number; }>;
  stableProbeByRule: any /* 原类型 Map<number, RuleProbeSummary>… 引用了拿不到的 RuleProbeSummary，手动收拾 */;
};

export type UseRuleTrafficCellsResult = {
  renderTableRuleDailyTraffic: (rule: RuleCardRule) => ReactElement;
  renderTableRuleTotalTraffic: (rule: RuleCardRule) => ReactElement;
  renderTableRuleLatency: (rule: RuleCardRule) => ReactElement;
};

export function useRuleTrafficCells(ctx: UseRuleTrafficCellsContext): UseRuleTrafficCellsResult {
  const { dailyTrafficByRule, totalTrafficByRule, stableProbeByRule } = ctx;
  const renderTrafficBytesValue = (t: { bytesIn?: number | null; bytesOut?: number | null } | undefined, direction: "in" | "out") => {
    const value = direction === "in" ? Number(t?.bytesIn || 0) : Number(t?.bytesOut || 0);
    if (!t || value <= 0) {
      return <span className="text-xs text-muted-foreground">—</span>;
    }
    const Icon = direction === "in" ? ArrowDownToLine : ArrowUpFromLine;
    // 入站走强调色、出站走次要字色（--fx-flow-*），和总览页的走势图同一对颜色：进出不是状态
    const color = direction === "in" ? "text-[var(--fx-flow-in)]" : "text-[var(--fx-flow-out)]";
    return (
      <span className={`flex items-center gap-1 whitespace-nowrap text-xs tabular-nums ${color}`}>
        <Icon className="h-3 w-3 shrink-0" /> {formatBytes(value)}
      </span>
    );
  };
  const renderRuleDailyTrafficValue = (rule: any, direction: "in" | "out") => (
    renderTrafficBytesValue(dailyTrafficByRule.get(rule.id), direction)
  );
  const renderRuleTotalTraffic = (rule: any) => {
    const t = totalTrafficByRule.get(rule.id);
    if (!t) {
      return <span className="text-xs text-muted-foreground">累计 —</span>;
    }
    const total = Number(t.bytesIn || 0) + Number(t.bytesOut || 0);
    return (
      <span
        className="flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums text-foreground"
        title={`累计入向 ${formatBytes(t.bytesIn)} / 出向 ${formatBytes(t.bytesOut)}`}
      >
        <ArrowRightLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
        累计 {formatBytes(total)}
      </span>
    );
  };
  const renderTableRuleTotalTraffic = (rule: any) => (
    <div className="min-w-0 whitespace-nowrap text-xs">
      {renderRuleTotalTraffic(rule)}
    </div>
  );

  const renderTableRuleDailyTraffic = (rule: any) => (
    <div className="flex min-w-0 flex-col items-start gap-0.5 whitespace-nowrap text-xs leading-4">
      {renderRuleDailyTrafficValue(rule, "in")}
      {renderRuleDailyTrafficValue(rule, "out")}
    </div>
  );

  const renderTableRuleLatency = (rule: any) => (
    <div className="min-w-0 whitespace-nowrap text-xs">
      {renderLatestLatency(rule)}
    </div>
  );

  const renderLatestLatency = (rule: any) => {
    const t = stableProbeByRule.get(Number(rule.id));
    if (!t?.latestLatencyAt) return <span className="whitespace-nowrap text-xs text-muted-foreground">未测试</span>;
    // 过了新鲜期的探测只能说明「当时」：数字灰掉、写明多久以前，不再冒充现在的延迟。
    if (!isLinkProbeFresh(t.latestLatencyAt)) {
      return (
        <span className="whitespace-nowrap text-xs text-muted-foreground" title={`整链：${formatProbeAge(t.latestLatencyAt)}测的，已过期；··· › 诊断 重新测`}>
          {t.latestLatencyIsTimeout ? describeProbeFailureShort(t.latestProbeFailure) : typeof t.latestLatencyMs === "number" && Number.isFinite(t.latestLatencyMs) ? `${Math.round(t.latestLatencyMs)} ms` : "未测试"} · {formatProbeAge(t.latestLatencyAt)}
        </span>
      );
    }
    if (t.latestLatencyIsTimeout) {
      return <LatencyRating isTimeout timeoutText="超时" className="whitespace-nowrap" />;
    }
    if (typeof t.latestLatencyMs === "number" && Number.isFinite(t.latestLatencyMs)) {
      // 和卡片同一句悬停：整链，写明是入口实时 / 定时探测 / 最近一次诊断
      return (
        <span title={describeRuleLatency(t, t.latestLatencyMs).title}>
          <LatencyRating latencyMs={t.latestLatencyMs} className="whitespace-nowrap" badge={false} />
        </span>
      );
    }
    return <span className="whitespace-nowrap text-xs text-muted-foreground">未测试</span>;
  };
  return { renderTableRuleDailyTraffic, renderTableRuleTotalTraffic, renderTableRuleLatency };
}
