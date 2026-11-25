/*
  从 client/src/pages/Rules.tsx 第 4258-4375 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { INITIAL_RULE_CARD_BUDGET, desktopRuleTypeLabels, getRuleDisplayType, type RuleCardRule, type RuleCategory, type RuleGroupType, type RulePageUser, type RuleResourceFilter, type RuleResourceRow, type RuleViewMode } from "../../pages/Rules";
import { type PersistentPaginationState } from "@/components/PersistentPagination";
import { useOptimisticSortableOrder, useSortableReorder } from "@/components/SortableDragHandle";
import { trpc } from "@/lib/trpc";
import { useDeferredValue, useMemo } from "react";

export type UseRuleSortingContext = {
  effectiveViewMode: RuleViewMode;
  filterResource: RuleResourceFilter;
  ruleSearchQuery: string;
  personalGroupFilter: number | null;
  personalGroupSortActive: boolean;
  user: RulePageUser;
  filterUser: string;
  ruleCategory: RuleCategory;
  pagedRules: Array<RuleCardRule>;
  rulePageQuery: Pick<ReturnType<typeof trpc.rules.listPage.useQuery>, "isPlaceholderData">;
  ruleReorderPending: boolean;
  ruleOrder: ReturnType<typeof useOptimisticSortableOrder<RuleCardRule>>;
  reorderRulesMutation: Pick<ReturnType<typeof trpc.rules.reorder.useMutation>, "mutate">;
  rulePagination: PersistentPaginationState<RuleCardRule>;
  utils: ReturnType<typeof trpc.useUtils>;
  forwardGroupById: Map<number, RuleResourceRow>;
  uiTheme: string;
};

export type UseRuleSortingResult = {
  ruleSortingEnabled: boolean;
  desktopRuleGroups: Array<{ type: "local"; label: "端口转发"; rules: RuleCardRule[]; } | { type: "tunnel"; label: "隧道转发"; rules: RuleCardRule[]; } | { type: "chain"; label: "转发链"; rules: RuleCardRule[]; } | { type: "group"; label: "转发组"; rules: RuleCardRule[]; }>;
  ruleGroupSortables: Record<RuleGroupType, ReturnType<typeof useSortableReorder<RuleCardRule>>>;
  ruleGroupSortingEnabled: (type: RuleGroupType) => boolean;
  ruleCardVisible: (rule: { id?: unknown; }) => boolean;
  shouldGroupRuleCards: boolean;
  ruleSortable: ReturnType<typeof useSortableReorder<RuleCardRule>>;
};

export function useRuleSorting(ctx: UseRuleSortingContext): UseRuleSortingResult {
  const { effectiveViewMode, filterResource, ruleSearchQuery, personalGroupFilter, personalGroupSortActive, user, filterUser, ruleCategory, pagedRules, rulePageQuery, ruleReorderPending, ruleOrder, reorderRulesMutation, rulePagination, utils, forwardGroupById, uiTheme } = ctx;
  const ruleSortingBase = effectiveViewMode !== "globe"
    && filterResource === "all"
    && ruleSearchQuery.trim().length === 0
    && personalGroupFilter === null
    && !personalGroupSortActive;
  const ruleSortOwnersOk = (rules: ReadonlyArray<{ userId?: unknown }>) => user?.role !== "admin"
    || filterUser !== "all"
    || new Set(rules.map((rule) => Number(rule.userId || 0))).size <= 1;
  const ruleSortingEnabled = ruleCategory !== "all"
    && ruleSortingBase
    && ruleSortOwnersOk(pagedRules);
  const ruleSortingReady = ruleSortingEnabled && !rulePageQuery.isPlaceholderData;
  const ruleSortableItems = useMemo(() => {
    if (!ruleSortingEnabled) return [];
    return pagedRules.filter((rule: RuleCardRule) => !rule.forwardGroupRuleId && !rule.forwardGroupMemberId);
  }, [pagedRules, ruleSortingEnabled]);
  const ruleSortable = useSortableReorder({
    items: ruleSortableItems,
    getId: (rule: RuleCardRule) => Number(rule.id),
    disabled: !ruleSortingReady || ruleReorderPending || ruleSortableItems.length < 2,
    onReorder: (nextRules) => {
      if (ruleCategory === "all") return;
      const requestId = ruleOrder.begin(nextRules);
      reorderRulesMutation.mutate({
        category: ruleCategory,
        ids: nextRules.map((rule: RuleCardRule) => Number(rule.id)),
        startIndex: (rulePagination.currentPage - 1) * rulePagination.pageSize,
      }, {
        onError: () => ruleOrder.release(requestId),
        onSettled: () => ruleOrder.resync(requestId, () => Promise.all([
          utils.rules.list.invalidate(),
          utils.rules.listPage.invalidate(),
          utils.rules.mapItems.invalidate(),
          utils.rules.listSummary.invalidate(),
        ])),
      });
    },
  });
  const desktopRuleGroups = useMemo(() => {
    const groups = [
      { type: "local" as const, label: desktopRuleTypeLabels.local, rules: [] as RuleCardRule[] },
      { type: "tunnel" as const, label: desktopRuleTypeLabels.tunnel, rules: [] as RuleCardRule[] },
      { type: "chain" as const, label: desktopRuleTypeLabels.chain, rules: [] as RuleCardRule[] },
      { type: "group" as const, label: desktopRuleTypeLabels.group, rules: [] as RuleCardRule[] },
    ];
    const groupByType = new Map(groups.map((group) => [group.type, group]));
    pagedRules.forEach((rule: RuleCardRule) => {
      groupByType.get(getRuleDisplayType(rule, forwardGroupById))?.rules.push(rule);
    });
    return groups.filter((group) => group.rules.length > 0);
  }, [forwardGroupById, pagedRules]);
  // 「深空」主题：「全部」也不分组，一张表到底；类型写在每一行名字前面的小标签上（RuleRow）
  // 按个人分组排序时也不按类型分段：分段会把排好的分组顺序拆开
  const shouldGroupRuleCards = ruleCategory === "all" && uiTheme !== "deepspace" && !personalGroupSortActive;
  /*
    换进这一页时先只画前几张卡（手机上刚好一屏），剩下的交给 React 的低优先级渲染随后补上：
    第一帧要画十几张卡的整棵树在手机上要几百毫秒，期间点什么都没反应（用户 2026-11-03 录屏
    「切到转发规则还是有点卡顿」）。useDeferredValue 的首次渲染拿到 false，紧接着的过渡渲染
    拿到 true —— 过渡是可打断的，不挡滚动和点击。占位块和卡同高，列表不会跳。
  */
  const ruleCardsHydrated = useDeferredValue(true, false);
  const initialRuleCardIds = useMemo(() => {
    const ordered = shouldGroupRuleCards ? desktopRuleGroups.flatMap((group) => group.rules) : pagedRules;
    return new Set(ordered.slice(0, INITIAL_RULE_CARD_BUDGET).map((rule: { id?: unknown }) => Number(rule.id)));
  }, [desktopRuleGroups, pagedRules, shouldGroupRuleCards]);
  const ruleCardVisible = (rule: { id?: unknown }) => ruleCardsHydrated || initialRuleCardIds.has(Number(rule.id));

  /**
   * 「全部」按类型分组显示时，每一组里也能拖。一组就是一个分类（端口转发 / 隧道转发 / 转发链 / 转发组），
   * 存的是那个分类自己的顺序 —— 和点进那个分类的页签去拖是同一份，两边看到的一样。
   */
  const ruleGroupSortItems = useMemo(() => {
    const byType: Record<RuleGroupType, typeof pagedRules> = { local: [], tunnel: [], chain: [], group: [] };
    if (!shouldGroupRuleCards || !ruleSortingBase) return byType;
    for (const group of desktopRuleGroups) {
      byType[group.type] = group.rules.filter((rule) => !rule.forwardGroupRuleId && !rule.forwardGroupMemberId);
    }
    return byType;
  }, [desktopRuleGroups, ruleSortingBase, shouldGroupRuleCards]);
  const ruleGroupSortingEnabled = (type: RuleGroupType) => shouldGroupRuleCards
    && ruleSortingBase
    && ruleGroupSortItems[type].length >= 2
    && ruleSortOwnersOk(ruleGroupSortItems[type]);
  const saveRuleGroupOrder = (type: RuleGroupType, nextGroupRules: typeof pagedRules) => {
    // 这一页上同组的位置按新顺序换人，别的组原地不动，拖完马上就是新顺序，不用等刷新。
    const sortableIds = new Set(ruleGroupSortItems[type].map((rule) => Number(rule.id)));
    const queue = [...nextGroupRules];
    const nextPage = pagedRules.map((rule) => (sortableIds.has(Number(rule.id)) ? queue.shift() : rule));
    const requestId = ruleOrder.begin(nextPage);
    reorderRulesMutation.mutate({
      category: type,
      ids: nextGroupRules.map((rule) => Number(rule.id)),
    }, {
      onError: () => ruleOrder.release(requestId),
      onSettled: () => ruleOrder.resync(requestId, () => Promise.all([
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
      ])),
    });
  };
  const ruleGroupSortableOptions = (type: RuleGroupType) => ({
    items: ruleGroupSortItems[type],
    getId: (rule: (typeof pagedRules)[number]) => Number(rule.id),
    disabled: !ruleGroupSortingEnabled(type) || rulePageQuery.isPlaceholderData || ruleReorderPending,
    onReorder: (nextRules: typeof pagedRules) => saveRuleGroupOrder(type, nextRules),
  });
  const localRuleGroupSortable = useSortableReorder(ruleGroupSortableOptions("local"));
  const tunnelRuleGroupSortable = useSortableReorder(ruleGroupSortableOptions("tunnel"));
  const chainRuleGroupSortable = useSortableReorder(ruleGroupSortableOptions("chain"));
  const groupRuleGroupSortable = useSortableReorder(ruleGroupSortableOptions("group"));
  const ruleGroupSortables: Record<RuleGroupType, typeof localRuleGroupSortable> = {
    local: localRuleGroupSortable,
    tunnel: tunnelRuleGroupSortable,
    chain: chainRuleGroupSortable,
    group: groupRuleGroupSortable,
  };
  return { ruleSortingEnabled, desktopRuleGroups, ruleGroupSortables, ruleGroupSortingEnabled, ruleCardVisible, shouldGroupRuleCards, ruleSortable };
}
