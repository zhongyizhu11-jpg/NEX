/*
  从 client/src/pages/Rules.tsx 第 5824-5893 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { type ReactElement } from "react";
import { type RuleCardRule } from "../../pages/Rules";
import { Badge } from "@/components/ui/badge";
import { resolveForwardRuleNotRunningReason, resolveForwardRuleVisualStatus, type ForwardRuleVisualStatus } from "@/lib/forwardRuleStatus";
import { cn } from "@/lib/utils";
import { ADMIN_MANAGED_RULE_MESSAGE, isAdminManagedRule } from "@shared/ruleLimits";
import { RULE_EGRESS_STATE_LABELS, normalizeRuleEgressType, ruleEgressStateTone, ruleEgressSummaryText, type RuleEgressState } from "@shared/ssEgress";
import { TLS_INBOUND_RULE_STATE_LABELS, formatSniRuleEntry, parseSniNameJson, sniRuleRouteKind, tlsInboundRuleState } from "@shared/tlsInbound";
import { Lock } from "lucide-react";

export type UseRuleStateBadgesContext = {
  ruleVisualStatuses: Map<number, ForwardRuleVisualStatus>;
  resolveRuleVisualStatus: (rule: any) => ReturnType<typeof resolveForwardRuleVisualStatus>;
  user: any;
  tlsInboundById: Map<number, any>;
};

export type UseRuleStateBadgesResult = {
  renderNotRunningReason: (rule: { id?: unknown; portWarnings?: unknown; }) => ReactElement | null;
  renderAdminManagedBadge: (rule: RuleCardRule) => ReactElement | null;
  renderSniRuleBadge: (rule: RuleCardRule) => ReactElement | null;
  renderEgressBadge: (rule: RuleCardRule) => ReactElement | null;
};

export function useRuleStateBadges(ctx: UseRuleStateBadgesContext): UseRuleStateBadgesResult {
  const { ruleVisualStatuses, resolveRuleVisualStatus, user, tlsInboundById } = ctx;
  const renderNotRunningReason = (rule: { id?: unknown; portWarnings?: unknown }) => {
    const visual = ruleVisualStatuses.get(Number(rule.id)) || resolveRuleVisualStatus(rule);
    const reason = resolveForwardRuleNotRunningReason(visual, rule?.portWarnings);
    if (!reason) return null;
    return (
      <span
        className={cn("mt-0.5 block truncate text-[11px] leading-4", reason.tone === "down" ? "text-[var(--fx-down-text)]" : "text-muted-foreground")}
        title={reason.detail}
        data-rule-not-running=""
      >
        {reason.label}
      </span>
    );
  };

  /** 共享 TLS 入站规则卡片上那枚：「SNI：a.com、b.com @ 主机:443」，入站停用 / Agent 太旧时换成原因。 */
  /** 规则主人看到的那枚「管理员管理」：说明为什么编辑、开关、删除都不在。 */
  const renderAdminManagedBadge = (rule: any) => (
    user?.role !== "admin" && isAdminManagedRule(rule) ? (
      <Badge key="admin-managed" variant="outline" className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground" title={ADMIN_MANAGED_RULE_MESSAGE}>
        <Lock className="h-3 w-3" aria-hidden="true" />
        管理员管理
      </Badge>
    ) : null
  );

  const renderSniRuleBadge = (rule: any) => {
    if (!(Number(rule?.tlsInboundId || 0) > 0)) return null;
    const inbound = tlsInboundById.get(Number(rule.tlsInboundId));
    const state = tlsInboundRuleState({ inbound, agentVersion: inbound?.agentVersion, routeKind: sniRuleRouteKind(rule) });
    const text = formatSniRuleEntry({ names: parseSniNameJson(rule.sniNames), hostName: inbound?.hostName, port: inbound?.port });
    return (
      <span key="sni" className="inline-flex min-w-0 max-w-full items-center gap-1">
        <Badge variant="outline" className="h-5 min-w-0 max-w-full truncate px-1.5 text-[11px] font-normal" title={text}>{text}</Badge>
        {state !== "ok" ? (
          <Badge variant="outline" className="h-5 shrink-0 border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] px-1.5 text-[11px] text-[var(--fx-warn-text)]">
            {TLS_INBOUND_RULE_STATE_LABELS[state]}
          </Badge>
        ) : null}
      </span>
    );
  };

  /** Shadowsocks 出口那一枚：「经 落地主机 X 出口」/「经 外部 SS 出口」，后面跟状态（运行 / 落地离线 / 需要升级 Agent…）。 */
  const renderEgressBadge = (rule: any) => {
    const egress = rule?.egress;
    if (!egress || normalizeRuleEgressType(egress.type) === "none") return null;
    const state = String(egress.state || "running") as RuleEgressState;
    const tone = ruleEgressStateTone(state);
    const text = ruleEgressSummaryText({ type: egress.type, landingHostName: egress.landingHostName, udp: egress.udp === true });
    const title = [text, egress.masked, egress.message].filter(Boolean).join(" · ");
    return (
      <span key="egress" className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1" data-testid="rule-egress-badge">
        <Badge variant="outline" className="h-5 min-w-0 max-w-full truncate px-1.5 text-[11px] font-normal" title={title}>{text}</Badge>
        <Badge
          variant="outline"
          className={cn(
            // 状态那一枚（例如「UDP 出口需要升级 Agent/运行时」）在窄屏上可能比剩下的宽度长：整枚换行，不截字。
            "h-5 max-w-full shrink-0 truncate px-1.5 text-[11px]",
            tone === "ok" && "border-[color-mix(in_srgb,var(--fx-healthy)_40%,transparent)] text-[var(--fx-healthy-text)]",
            tone === "warn" && "border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] text-[var(--fx-warn-text)]",
            tone === "muted" && "text-muted-foreground",
          )}
          title={egress.message || undefined}
        >
          {RULE_EGRESS_STATE_LABELS[state] || state}
        </Badge>
      </span>
    );
  };
  return { renderNotRunningReason, renderAdminManagedBadge, renderSniRuleBadge, renderEgressBadge };
}
