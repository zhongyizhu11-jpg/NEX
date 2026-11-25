/*
  从 client/src/pages/Rules.tsx 第 4880-4984 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { getForwardGroupRouteLabel, getTunnelDisplay, type RuleCardRule, type RuleResourceRow, unsupportedProtocolTitle } from "../../pages/Rules";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { ArrowRightLeft, Layers3, Network, Shield, Zap } from "lucide-react";
import { type ReactNode } from "react";
import { type ReactElement } from "react";

export type UseRuleRouteBadgeContext = {
  tunnelById: Map<number, RuleResourceRow>;
  forwardGroupById: Map<number, RuleResourceRow>;
  getRuleKernelForwardWarning: (rule: RuleCardRule) => string | null;
  renderKernelForwardWarningBadge: (warning: string | null) => ReactElement | null;
  renderTunnelFxpIssueBadge: (tunnel: RuleResourceRow) => ReactElement | null;
  renderPortWarningBadge: (rule: { portWarnings?: unknown; }) => ReactElement | null;
  nginxTunnelEnabled: boolean;
  forwardTypeDisplayLabel: (forwardType: unknown) => string;
  renderSubscriptionBadge: (rule: RuleCardRule, placement?: "table" | "card") => ReactElement | null;
  renderForwardToolBadge: (rule: RuleCardRule, group?: RuleResourceRow | null) => ReactElement;
  hosts: Array<RuleResourceRow> | undefined;
  renderTunnelRoute: (tunnel: RuleResourceRow, compact?: boolean) => ReactElement;
};

export type UseRuleRouteBadgeResult = {
  renderUnsupportedHint: (children: ReactNode, title?: string) => ReactElement;
  renderRouteBadge: (rule: RuleCardRule, compactRow?: boolean, hideRoute?: boolean) => ReactElement;
};

export function useRuleRouteBadge(ctx: UseRuleRouteBadgeContext): UseRuleRouteBadgeResult {
  const { tunnelById, forwardGroupById, getRuleKernelForwardWarning, renderKernelForwardWarningBadge, renderTunnelFxpIssueBadge, renderPortWarningBadge, nginxTunnelEnabled, forwardTypeDisplayLabel, renderSubscriptionBadge, renderForwardToolBadge, hosts, renderTunnelRoute } = ctx;
  const renderRouteBadge = (rule: RuleCardRule, compactRow = false, hideRoute = false) => {
    const tunnel = rule.forwardType === "gost" && rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const groupMode = forwardGroupModeOf(group);
    const groupRouteLabel = getForwardGroupRouteLabel(group);
    const GroupRouteIcon = groupMode === "port" ? ArrowRightLeft : Layers3;
    const kernelWarning = getRuleKernelForwardWarning(rule);
    const kernelWarningBadge = renderKernelForwardWarningBadge(kernelWarning);
    const fxpIssueBadge = renderTunnelFxpIssueBadge(tunnel);
    const portWarningBadge = renderPortWarningBadge(rule);
    const warningBadge = kernelWarningBadge || fxpIssueBadge || portWarningBadge ? <>{kernelWarningBadge}{fxpIssueBadge}{portWarningBadge}</> : null;
    const badge = (
      <Badge
        variant="outline"
        className={`w-fit whitespace-nowrap text-[11px] ${
          rule.forwardGroupId
            ? "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] text-[var(--fx-healthy-text)]"
            : rule.forwardType === "iptables" || rule.forwardType === "nftables"
            ? "border-[color-mix(in_srgb,var(--fx-accent)_30%,transparent)] text-[var(--fx-accent)]"
            : rule.forwardType === "socat"
            ? "border-[color-mix(in_srgb,var(--fx-cat-orange)_30%,transparent)] text-[var(--fx-cat-orange)]"
            : rule.forwardType === "gost"
            ? "border-[color-mix(in_srgb,var(--fx-cat-teal)_30%,transparent)] text-[var(--fx-cat-teal)]"
            : "border-[color-mix(in_srgb,var(--fx-cat-indigo)_30%,transparent)] text-[var(--fx-cat-indigo)]"
        }`}
      >
        {rule.forwardGroupId ? (
          <><GroupRouteIcon className="h-3 w-3 mr-1" />{groupRouteLabel}</>
        ) : tunnel ? (
          <><Network className="h-3 w-3 mr-1" />{getTunnelDisplay(tunnel, nginxTunnelEnabled).badgeLabel}</>
        ) : rule.forwardType === "iptables" ? (
          <><Shield className="h-3 w-3 mr-1" />iptables</>
        ) : rule.forwardType === "nftables" ? (
          <><Shield className="h-3 w-3 mr-1" />nftables</>
        ) : rule.forwardType === "nginx" ? (
          <><Zap className="h-3 w-3 mr-1" />{forwardTypeDisplayLabel(rule.forwardType)}</>
        ) : rule.forwardType === "socat" ? (
          <><ArrowRightLeft className="h-3 w-3 mr-1" />socat</>
        ) : rule.forwardType === "gost" ? (
          <><Network className="h-3 w-3 mr-1" />gost</>
        ) : (
          <><Zap className="h-3 w-3 mr-1" />realm</>
        )}
      </Badge>
    );
    const subscriptionBadge = renderSubscriptionBadge(rule);
    if (rule.forwardGroupId) {
      return (
        <div className={`flex min-w-0 items-center gap-1 ${compactRow ? "overflow-hidden" : "flex-wrap"}`}>
          {badge}
          {renderForwardToolBadge(rule, group)}
          {warningBadge}
          {subscriptionBadge}
        </div>
      );
    }
    if (!tunnel) {
      return warningBadge || subscriptionBadge ? (
        <div className={`flex min-w-0 items-center gap-1 ${compactRow ? "overflow-hidden" : "flex-wrap"}`}>
          {badge}
          {warningBadge}
          {subscriptionBadge}
        </div>
      ) : badge;
    }
    if (hideRoute) {
      return warningBadge || subscriptionBadge ? (
        <div className={`flex min-w-0 items-center gap-1 ${compactRow ? "overflow-hidden" : "flex-wrap"}`}>
          {badge}
          {warningBadge}
          {subscriptionBadge}
        </div>
      ) : badge;
    }
    if (compactRow) {
      /*
        表格这一格只有 110～150px：路径排在徽标后面只露得出一个箭头，后面的主机名被裁掉、连省略号都没有
        （2026-11 桌面走查）。这里只放徽标，整条路径挂在悬停提示上；规则名下面那行和卡片视图照旧画路径。
      */
      return (
        <div className="flex min-w-0 items-center gap-1 overflow-hidden" title={getTunnelRouteText(tunnel, hosts)}>
          {badge}
          {warningBadge}
        </div>
      );
    }
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {badge}
        <div className="min-w-0 text-muted-foreground">
          {renderTunnelRoute(tunnel, true)}
        </div>
        {fxpIssueBadge}
      </div>
    );
  };

  const renderUnsupportedHint = (children: ReactNode, title = unsupportedProtocolTitle) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
  return { renderUnsupportedHint, renderRouteBadge };
}
