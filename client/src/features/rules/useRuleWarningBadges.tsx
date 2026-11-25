/*
  从 client/src/pages/Rules.tsx 第 6157-6214 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { type ReactElement } from "react";
import { type RuleResourceRow } from "../../pages/Rules";
import { Badge } from "@/components/ui/badge";
import { tunnelFxpIssueText } from "@/features/links/TunnelFxpIssueNotice";
import { cn } from "@/lib/utils";
import { AlertCircle, AlertTriangle } from "lucide-react";

export type UseRuleWarningBadgesResult = {
  renderKernelForwardWarningBadge: (warning: string | null) => ReactElement | null;
  renderTunnelFxpIssueBadge: (tunnel: RuleResourceRow) => ReactElement | null;
  renderPortWarningBadge: (rule: { portWarnings?: unknown; }) => ReactElement | null;
};

export function useRuleWarningBadges(): UseRuleWarningBadgesResult {
  const renderTunnelFxpIssueBadge = (tunnel: any) => {
    const issue = tunnelFxpIssueText(tunnel);
    if (!issue) return null;
    return (
      <Badge
        key="fxp-issue"
        variant="outline"
        className="h-5 w-fit border-destructive/30 px-1.5 text-[11px] text-destructive"
        title={issue}
      >
        <AlertCircle className="mr-1 h-3 w-3" />
        隧道 FXP 过旧
      </Badge>
    );
  };
  const renderKernelForwardWarningBadge = (warning: string | null) => {
    if (!warning) return null;
    return (
      <Badge
        variant="outline"
        className="h-5 w-fit border-[color-mix(in_srgb,var(--fx-warn)_35%,transparent)] bg-[var(--fx-warn-soft)] px-1.5 text-[11px] text-[var(--fx-warn-text)]"
        title={warning}
      >
        <AlertCircle className="mr-1 h-3 w-3" />
        跨 IPv4/IPv6 风险
      </Badge>
    );
  };
  /*
    端口占用告警（server/rulePortOccupancy.ts）：和规则的运行状态分开的一枚。
    黄 = Agent 核对到入口端口上有别的程序在监听（内核转发不绑端口，只能这样发现）；
    红 = 绑定失败或内核转发没装全，后面跟着 Agent 报的原因。冲突消失后下一轮就不再带这个字段。
  */
  const renderPortWarningBadge = (rule: { portWarnings?: unknown }) => {
    const warnings = (Array.isArray(rule?.portWarnings) ? rule.portWarnings : []) as Array<{ level: string; label: string; message: string }>;
    if (warnings.length === 0) return null;
    const error = warnings.find((item) => item.level === "error");
    const head = error || warnings[0];
    const title = warnings.map((item) => item.message).join("\n");
    return (
      <Badge
        key="port-warning"
        variant="outline"
        data-testid="rule-port-warning"
        data-level={error ? "error" : "warn"}
        className={cn(
          "h-5 w-fit max-w-full truncate px-1.5 text-[11px]",
          error
            ? "border-destructive/30 text-destructive"
            : "border-[color-mix(in_srgb,var(--fx-warn)_35%,transparent)] bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]",
        )}
        title={title}
      >
        <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />
        {head.label}{warnings.length > 1 ? ` · ${warnings.length}` : ""}
      </Badge>
    );
  };
  return { renderKernelForwardWarningBadge, renderTunnelFxpIssueBadge, renderPortWarningBadge };
}
