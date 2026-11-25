/*
  从 client/src/pages/Rules.tsx 第 3932-4014 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { EMPTY_RULE_CATEGORY_COUNTS, getRuleCategory, isForwardRuleVisibleByFilters, normalizeRuleCategoryCounts, readCachedRuleCategoryCounts, ruleCategoryCountsEqual, type RuleCardRule, type RuleCategory, type RuleCategoryCounts, type RuleFilterState, type RulePageUser, type RuleResourceFilter, type RuleResourceRow, writeCachedRuleCategoryCounts } from "../../pages/Rules";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";
import { useEffect, useMemo, useRef, useState } from "react";

type RulesRouterOutputs = inferRouterOutputs<AppRouter>["rules"];

export type UseRuleFilterCountsContext = {
  filterUser: string;
  filterResource: RuleResourceFilter;
  ruleCategory: RuleCategory;
  ruleSearchQuery: string;
  user: RulePageUser;
  hostById: Map<number, RuleResourceRow>;
  tunnelById: Map<number, RuleResourceRow>;
  userById: Map<number, RuleResourceRow>;
  forwardGroupById: Map<number, RuleResourceRow>;
  getRuleEntryHostIdForSort: (rule: RuleCardRule) => number;
  rules: Array<RuleCardRule> | undefined;
  selectedScopeQueryEnabled: boolean;
  selectedScopeRules: undefined;
  ruleListDataReady: boolean;
  rulePageQuery: { data: RulesRouterOutputs["listPage"] | undefined; isPlaceholderData: boolean };
};

export type UseRuleFilterCountsResult = {
  ruleCategoryCountsReady: boolean;
  ruleCategoryCounts: RuleCategoryCounts;
  filteredRules: Array<RuleCardRule>;
  selectedScopedRules: undefined;
  ruleFilterCacheScope: string;
  scopedRulesReady: boolean;
  filteredRulesPrimed: boolean;
  baseScopedRules: Array<RuleCardRule>;
  ruleFilters: RuleFilterState;
};

export function useRuleFilterCounts(ctx: UseRuleFilterCountsContext): UseRuleFilterCountsResult {
  const { filterUser, filterResource, ruleCategory, ruleSearchQuery, user, hostById, tunnelById, userById, forwardGroupById, getRuleEntryHostIdForSort, rules, selectedScopeQueryEnabled, selectedScopeRules, ruleListDataReady, rulePageQuery } = ctx;
  const ruleFilters = useMemo<RuleFilterState>(() => ({
    filterUser,
    filterResource,
    ruleCategory,
    searchQuery: ruleSearchQuery,
    isAdmin: user?.role === "admin",
    userId: user?.id,
    hostById,
    tunnelById,
    userById,
    forwardGroupById,
    getRuleEntryHostId: getRuleEntryHostIdForSort,
  }), [filterResource, forwardGroupById, getRuleEntryHostIdForSort, hostById, ruleCategory, ruleSearchQuery, filterUser, tunnelById, user?.id, user?.role, userById]);
  const baseScopedRules = useMemo(() => rules || [], [rules]);
  const selectedScopedRules = selectedScopeQueryEnabled ? selectedScopeRules : undefined;
  const scopedRulesReady = selectedScopeQueryEnabled ? selectedScopedRules !== undefined : ruleListDataReady;
  /*
    列表同步算出来，不再经一个 effect「下一轮」才填：以前第一次渲染是空的（数据明明在缓存里），
    等 effect 填上才有卡 —— 中间先画了一帧「没有规则」，分区切换动画又要先把那一帧退场（200ms）
    再把列表进场，换到这一页要空着 300ms 才见到卡（用户 2026-11-03 录屏）。
    数据还没就绪（第一次打开、缓存里没有）时沿用上一次算出的列表，不闪空。
  */
  const lastFilteredRulesRef = useRef<RuleCardRule[]>([]);
  const filteredRules = useMemo(() => {
    if (!scopedRulesReady) return lastFilteredRulesRef.current;
    const sourceRules = selectedScopeQueryEnabled ? selectedScopedRules || [] : baseScopedRules;
    const next = sourceRules.filter((rule: RuleCardRule) => isForwardRuleVisibleByFilters(rule, ruleFilters));
    lastFilteredRulesRef.current = next;
    return next;
  }, [baseScopedRules, ruleFilters, scopedRulesReady, selectedScopedRules, selectedScopeQueryEnabled]);
  const filteredRulesPrimed = scopedRulesReady || lastFilteredRulesRef.current.length > 0;
  const ruleFilterCacheScope = user?.role === "admin"
    ? `admin-${user?.id || "self"}-${filterUser}`
    : `user-${user?.id || "self"}`;
  // 分类条的数字只按「谁的规则」数（服务端同样不看搜索 / 筛选），缓存键也只跟这个走
  const ruleCategoryCountsCacheKey = useMemo(
    () => encodeURIComponent(ruleFilterCacheScope),
    [ruleFilterCacheScope],
  );
  const [stableRuleCategoryCounts, setStableRuleCategoryCounts] = useState(() => {
    const cached = readCachedRuleCategoryCounts(ruleCategoryCountsCacheKey);
    return { counts: cached || EMPTY_RULE_CATEGORY_COUNTS, ready: !!cached };
  });
  const previousRuleCategoryCountsCacheKey = useRef(ruleCategoryCountsCacheKey);
  useEffect(() => {
    if (previousRuleCategoryCountsCacheKey.current === ruleCategoryCountsCacheKey) return;
    previousRuleCategoryCountsCacheKey.current = ruleCategoryCountsCacheKey;
    const cached = readCachedRuleCategoryCounts(ruleCategoryCountsCacheKey);
    setStableRuleCategoryCounts({ counts: cached || EMPTY_RULE_CATEGORY_COUNTS, ready: !!cached });
  }, [ruleCategoryCountsCacheKey]);
  const liveRuleCategoryCounts = useMemo<RuleCategoryCounts>(() => {
    if (rulePageQuery.data?.categoryCounts) {
      return normalizeRuleCategoryCounts(rulePageQuery.data.categoryCounts);
    }
    const sourceRules = selectedScopeQueryEnabled ? selectedScopedRules || [] : baseScopedRules;
    const baseFilters = {
      ...ruleFilters,
      ruleCategory: "all" as RuleCategory,
      filterResource: "all" as RuleResourceFilter,
      searchQuery: "",
    };
    const counts: RuleCategoryCounts = { ...EMPTY_RULE_CATEGORY_COUNTS };
    sourceRules
      .filter((rule: RuleCardRule) => isForwardRuleVisibleByFilters(rule, baseFilters))
      .forEach((rule: RuleCardRule) => {
        const category = getRuleCategory(rule, forwardGroupById);
        counts.all += 1;
        counts[category] += 1;
      });
    return counts;
  }, [baseScopedRules, forwardGroupById, ruleFilters, rulePageQuery.data?.categoryCounts, selectedScopeQueryEnabled, selectedScopedRules]);
  const hasFreshRuleCategoryCounts = rulePageQuery.data !== undefined && !rulePageQuery.isPlaceholderData;
  useEffect(() => {
    if (!hasFreshRuleCategoryCounts) return;
    setStableRuleCategoryCounts((previous) => (
      previous.ready && ruleCategoryCountsEqual(previous.counts, liveRuleCategoryCounts)
        ? previous
        : { counts: liveRuleCategoryCounts, ready: true }
    ));
    writeCachedRuleCategoryCounts(ruleCategoryCountsCacheKey, liveRuleCategoryCounts);
  }, [hasFreshRuleCategoryCounts, liveRuleCategoryCounts, ruleCategoryCountsCacheKey]);
  const ruleCategoryCountsReady = hasFreshRuleCategoryCounts || stableRuleCategoryCounts.ready;
  const ruleCategoryCounts = hasFreshRuleCategoryCounts ? liveRuleCategoryCounts : stableRuleCategoryCounts.counts;
  return { ruleCategoryCountsReady, ruleCategoryCounts, filteredRules, selectedScopedRules, ruleFilterCacheScope, scopedRulesReady, filteredRulesPrimed, baseScopedRules, ruleFilters };
}
