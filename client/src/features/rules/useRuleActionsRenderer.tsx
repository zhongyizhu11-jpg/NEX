/*
  从 client/src/pages/Rules.tsx 第 5001-5038 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { getRuleCategory, type RuleCardRule, type RuleCardUi, type RulePageUser, type RuleResourceRow } from "../../pages/Rules";
import { EntityActions } from "@/components/entity/EntityActions";
import { trpc } from "@/lib/trpc";
import { isUserspaceForwardType } from "@shared/forwardTypes";
import { ruleLatencyProbeMethodForRule } from "@shared/latencyProbe";
import { isAdminManagedRule } from "@shared/ruleLimits";
import { Loader2, Pencil, RotateCcw, Stethoscope, Trash2 } from "lucide-react";
import { type Dispatch, type ReactElement, type SetStateAction } from "react";

export type UseRuleActionsRendererContext = {
  forwardGroupById: Map<number, RuleResourceRow>;
  resetTrafficMutation: Pick<ReturnType<typeof trpc.rules.resetTraffic.useMutation>, "isPending" | "variables">;
  user: RulePageUser;
  setSelfTestRule: Dispatch<SetStateAction<{ id: number; name: string; isForwardChain?: boolean; chainKernel?: boolean; probeMethod?: "tcping" | "ping"; tab?: string; } | null>>;
  ruleCardUi: RuleCardUi;
  confirmResetTraffic: (target: { scope: "all"; } | { scope: "rule"; rule: RuleCardRule; }) => void;
  confirmDeleteRule: (rule: RuleCardRule) => void;
};

export type UseRuleActionsRendererResult = {
  renderRuleActions: (rule: RuleCardRule, menuOnly?: boolean, tableCompact?: boolean) => ReactElement;
};

export function useRuleActionsRenderer(ctx: UseRuleActionsRendererContext): UseRuleActionsRendererResult {
  const { forwardGroupById, resetTrafficMutation, user, setSelfTestRule, ruleCardUi, confirmResetTraffic, confirmDeleteRule } = ctx;
  const renderRuleActions = (rule: RuleCardRule, menuOnly = false, tableCompact = false) => {
    const ruleCategory = getRuleCategory(rule, forwardGroupById);
    const isForwardChainRule = ruleCategory === "chain";
    const probeMethod = ruleLatencyProbeMethodForRule(rule);
    // 哪条规则正在重置看 mutation 自己记的 variables，不另存一份目标
    const resettingVariables = resetTrafficMutation.variables;
    const resetting = resetTrafficMutation.isPending && resettingVariables?.scope === "rule" && Number(resettingVariables.ruleId) === Number(rule.id);
    const readOnly = user?.role !== "admin" && isAdminManagedRule(rule);
    const testAction = {
      key: "test",
      label: "诊断",
      ariaLabel: `诊断 ${rule.name}：转发链路自测`,
      icon: <Stethoscope className="h-3.5 w-3.5" />,
      onSelect: () => setSelfTestRule({ id: rule.id, name: rule.name, isForwardChain: isForwardChainRule, chainKernel: !isUserspaceForwardType(rule.forwardType), probeMethod }),
    };
    const editAction = { key: "edit", label: "编辑", ariaLabel: `编辑 ${rule.name}`, icon: <Pencil className="h-3.5 w-3.5" />, onSelect: () => ruleCardUi.openEdit(rule) };
    return (
      <EntityActions
        primary={tableCompact
          ? (readOnly ? [] : [editAction])
          : readOnly ? [testAction] : [testAction, editAction]}
        menu={[
          ...(tableCompact ? [testAction] : []),
          {
            key: "reset",
            label: resetting ? "正在重置统计" : "重置统计",
            ariaLabel: `重置 ${rule.name} 的统计数据`,
            icon: resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />,
            disabled: resetTrafficMutation.isPending,
            onSelect: () => confirmResetTraffic({ scope: "rule", rule }),
          },
          { key: "delete", label: "删除", ariaLabel: `删除 ${rule.name}`, icon: <Trash2 className="h-3.5 w-3.5" />, destructive: true, onSelect: () => confirmDeleteRule(rule) },
        ].filter((action) => !readOnly || (action.key !== "reset" && action.key !== "delete"))}
        menuLabel={`${rule.name} 的更多操作`}
        menuOnly={menuOnly}
      />
    );
  };
  return { renderRuleActions };
}
