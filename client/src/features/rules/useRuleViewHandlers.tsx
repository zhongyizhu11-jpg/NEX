/*
  从 client/src/pages/Rules.tsx 第 5039-5118 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { RULE_PAGE_SIZE_OPTIONS, normalizeRuleResourceFilter, parseRuleResourceFilter, storeRuleCardSize, storeRuleGroupCollapsed, storeRulePageSize, storeRuleViewMode, storeString, type RuleCardSize, type RuleCategory, type RuleDisplayMode, type RuleGroupType, type RulePageSize, type RulePageUser, type RuleResourceFilter, type RuleTransferScopeType, type RuleViewMode } from "../../pages/Rules";
import { type Dispatch, type SetStateAction } from "react";

export type UseRuleViewHandlersContext = {
  setViewMode: Dispatch<SetStateAction<RuleViewMode>>;
  setRuleCardSize: Dispatch<SetStateAction<RuleCardSize>>;
  effectiveViewMode: RuleViewMode;
  effectiveRuleCardSize: RuleCardSize;
  setRuleCategory: (nextValue: string) => void;
  filterResource: RuleResourceFilter;
  setFilterResource: Dispatch<SetStateAction<RuleResourceFilter>>;
  filterResourceStorageKey: string;
  setRuleResourceMenuType: Dispatch<SetStateAction<RuleTransferScopeType>>;
  setFilterUser: Dispatch<SetStateAction<string>>;
  filterUserStorageKey: string;
  setRuleResourceMenuOpen: Dispatch<SetStateAction<boolean>>;
  setRuleSearchQuery: Dispatch<SetStateAction<string>>;
  handlePersonalGroupFilterChange: (value: number | null) => void;
  user: RulePageUser;
  setRulePageSize: Dispatch<SetStateAction<RulePageSize>>;
  setRuleGroupCollapsed: Dispatch<SetStateAction<Partial<Record<"local" | "tunnel" | "chain" | "group", boolean>>>>;
};

export type UseRuleViewHandlersResult = {
  displayMode: RuleDisplayMode;
  toggleRuleGroupCollapsed: (type: RuleGroupType) => void;
  handleDisplayModeChange: (nextMode: RuleDisplayMode) => void;
  handleRuleCategoryChange: (value: string) => void;
  handleFilterUserChange: (value: string) => void;
  handleFilterResourceChange: (value: string) => void;
  handleRulePageSizeChange: (value: string) => void;
  clearRuleFilters: () => void;
};

export function useRuleViewHandlers(ctx: UseRuleViewHandlersContext): UseRuleViewHandlersResult {
  const { setViewMode, setRuleCardSize, effectiveViewMode, effectiveRuleCardSize, setRuleCategory, filterResource, setFilterResource, filterResourceStorageKey, setRuleResourceMenuType, setFilterUser, filterUserStorageKey, setRuleResourceMenuOpen, setRuleSearchQuery, handlePersonalGroupFilterChange, user, setRulePageSize, setRuleGroupCollapsed } = ctx;
  const handleViewModeChange = (nextViewMode: RuleViewMode) => {
    setViewMode(nextViewMode);
    storeRuleViewMode(nextViewMode);
  };

  const handleDisplayModeChange = (nextMode: RuleDisplayMode) => {
    if (nextMode === "globe") {
      handleViewModeChange("globe");
      return;
    }
    if (nextMode === "table") {
      handleViewModeChange("table");
      return;
    }
    setViewMode("card");
    storeRuleViewMode("card");
    setRuleCardSize(nextMode);
    storeRuleCardSize(nextMode);
  };

  const displayMode: RuleDisplayMode = effectiveViewMode === "table" || effectiveViewMode === "globe" ? effectiveViewMode : effectiveRuleCardSize;

  const handleRuleCategoryChange = (value: string) => {
    const next = (value === "local" || value === "tunnel" || value === "chain" || value === "group" ? value : "all") as RuleCategory;
    setRuleCategory(next);
    const selected = parseRuleResourceFilter(filterResource);
    if (next === "all" && selected.type) {
      setFilterResource("all");
      storeString(filterResourceStorageKey, "all");
    } else if (next !== "all" && selected.type !== next) {
      setFilterResource(next);
      storeString(filterResourceStorageKey, next);
      setRuleResourceMenuType(next);
    }
  };

  const handleFilterUserChange = (value: string) => {
    setFilterUser(value);
    storeString(filterUserStorageKey, value);
  };

  const handleFilterResourceChange = (value: string) => {
    const next = normalizeRuleResourceFilter(value);
    const parsed = parseRuleResourceFilter(next);
    setFilterResource(next);
    storeString(filterResourceStorageKey, next);
    if (parsed.type) {
      setRuleResourceMenuType(parsed.type);
      setRuleCategory(parsed.type);
    } else {
      setRuleCategory("all");
    }
    setRuleResourceMenuOpen(false);
  };

  const clearRuleFilters = () => {
    setRuleSearchQuery("");
    setRuleCategory("all");
    handleFilterResourceChange("all");
    handlePersonalGroupFilterChange(null);
    if (user?.role === "admin") {
      setFilterUser("self");
      storeString(filterUserStorageKey, "self");
    }
  };

  const handleRulePageSizeChange = (value: string) => {
    const nextPageSize = Number(value) as RulePageSize;
    if (!RULE_PAGE_SIZE_OPTIONS.includes(nextPageSize)) return;
    setRulePageSize(nextPageSize);
    storeRulePageSize(nextPageSize);
  };

  const toggleRuleGroupCollapsed = (type: RuleGroupType) => {
    setRuleGroupCollapsed((prev) => {
      const next = { ...prev, [type]: !prev[type] };
      storeRuleGroupCollapsed(next);
      return next;
    });
  };
  return { displayMode, toggleRuleGroupCollapsed, handleDisplayModeChange, handleRuleCategoryChange, handleFilterUserChange, handleFilterResourceChange, handleRulePageSizeChange, clearRuleFilters };
}
