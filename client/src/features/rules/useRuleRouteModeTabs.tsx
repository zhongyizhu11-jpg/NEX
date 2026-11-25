/*
  从 client/src/pages/Rules.tsx 第 3386-3418 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { type RuleFormData, type RuleResourceRow } from "../../pages/Rules";
import { type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { type RuleRouteTab } from "@/features/rules/routeModeHints";
import { ArrowRightLeft, Combine, GitBranch, Layers3, Network } from "lucide-react";

export type UseRuleRouteModeTabsContext = {
  canUseLocalForward: boolean;
  routeModeLocked: boolean;
  form: RuleFormData;
  canUseGost: boolean;
  plainTunnels: Array<RuleResourceRow>;
  aggregateTunnels: Array<RuleResourceRow>;
  routeTab: RuleRouteTab;
  canUseForwardChain: boolean;
  canUseFailoverGroup: boolean;
};

export type UseRuleRouteModeTabsResult = {
  routeModeTabItems: Array<SlidingTabItem<RuleRouteTab>>;
};

export function useRuleRouteModeTabs(ctx: UseRuleRouteModeTabsContext): UseRuleRouteModeTabsResult {
  const { canUseLocalForward, routeModeLocked, form, canUseGost, plainTunnels, aggregateTunnels, routeTab, canUseForwardChain, canUseFailoverGroup } = ctx;
  const routeModeTabItems: SlidingTabItem<RuleRouteTab>[] = [
    {
      value: "local",
      label: "端口转发",
      icon: ArrowRightLeft,
      disabled: !canUseLocalForward || (routeModeLocked && form.routeMode !== "local"),
    },
    {
      value: "tunnel",
      label: "隧道转发",
      icon: Network,
      disabled: !canUseGost || plainTunnels.length === 0 || (routeModeLocked && form.routeMode !== "tunnel"),
    },
    // 有叠加才出这个标签，没用到的人界面不变。
    ...(aggregateTunnels.length > 0 || routeTab === "aggregate" ? [{
      value: "aggregate" as const,
      label: "叠加",
      icon: Combine,
      disabled: !canUseGost || aggregateTunnels.length === 0 || (routeModeLocked && form.routeMode !== "tunnel"),
    }] : []),
    {
      value: "chain",
      label: "转发链",
      icon: GitBranch,
      disabled: !canUseForwardChain || (routeModeLocked && form.routeMode !== "chain"),
    },
    {
      value: "group",
      label: "转发组",
      icon: Layers3,
      disabled: !canUseFailoverGroup || (routeModeLocked && form.routeMode !== "group"),
    },
  ];
  return { routeModeTabItems };
}
