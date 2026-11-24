/*
  从 client/src/pages/Rules.tsx 第 3181-3224 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { isForwardChainGroup, parseRuleResourceFilter, storeString, type RuleResourceFilter, type RuleTransferScopeType } from "../../pages/Rules";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { useCallback, useEffect, useMemo } from "react";

export type UseRuleTransferResourceListsContext = {
  availableForwardGroups: Array<any>;
  forwardGroups: Array<any> | undefined;
  tunnels: Array<any> | undefined;
  filterResource: RuleResourceFilter;
  setFilterResource: any /* 原类型 Dispatch<SetStateAction<RuleResourceFilter>>… 引用了拿不到的 Dispatch，手动收拾 */;
  filterResourceStorageKey: string;
  availablePortForwardGroups: Array<any>;
  supportedTunnels: Array<any>;
  availableForwardChainGroups: Array<any>;
  exportScopeType: RuleTransferScopeType;
  importScopeType: RuleTransferScopeType;
};

export type UseRuleTransferResourceListsResult = {
  availableFailoverForwardGroups: Array<any>;
  exportResources: Array<any>;
  importResources: Array<any>;
  getRuleFilterResources: (type: RuleTransferScopeType) => any[];
};

export function useRuleTransferResourceLists(ctx: UseRuleTransferResourceListsContext): UseRuleTransferResourceListsResult {
  const { availableForwardGroups, forwardGroups, tunnels, filterResource, setFilterResource, filterResourceStorageKey, availablePortForwardGroups, supportedTunnels, availableForwardChainGroups, exportScopeType, importScopeType } = ctx;
  const availableFailoverForwardGroups = useMemo(
    () => availableForwardGroups.filter((group: any) => forwardGroupModeOf(group) === "failover"),
    [availableForwardGroups]
  );
  const transferPortGroups = useMemo(
    () => (forwardGroups || []).filter((group: any) => forwardGroupModeOf(group) === "port"),
    [forwardGroups]
  );
  const transferChainGroups = useMemo(
    () => (forwardGroups || []).filter((group: any) => isForwardChainGroup(group)),
    [forwardGroups]
  );
  const transferRuleGroups = useMemo(
    () => (forwardGroups || []).filter((group: any) => forwardGroupModeOf(group) === "failover"),
    [forwardGroups]
  );
  const getRuleFilterResources = useCallback((type: RuleTransferScopeType): any[] => {
    if (type === "local") return transferPortGroups;
    if (type === "tunnel") return tunnels || [];
    if (type === "chain") return transferChainGroups;
    return transferRuleGroups;
  }, [transferChainGroups, transferPortGroups, transferRuleGroups, tunnels]);
  useEffect(() => {
    const selected = parseRuleResourceFilter(filterResource);
    if (!selected.type || !selected.id) return;
    if (selected.type === "tunnel" ? !Array.isArray(tunnels) : !Array.isArray(forwardGroups)) return;
    if (getRuleFilterResources(selected.type).some((resource: any) => Number(resource.id) === selected.id)) return;
    setFilterResource("all");
    storeString(filterResourceStorageKey, "all");
  }, [filterResource, filterResourceStorageKey, getRuleFilterResources]);
  const getTransferResources = useCallback((type: RuleTransferScopeType): any[] => {
    if (type === "local") return transferPortGroups;
    if (type === "tunnel") return tunnels || [];
    if (type === "chain") return transferChainGroups;
    return transferRuleGroups;
  }, [tunnels, transferPortGroups, transferChainGroups, transferRuleGroups]);
  const getImportResources = useCallback((type: RuleTransferScopeType): any[] => {
    if (type === "local") return availablePortForwardGroups;
    if (type === "tunnel") return supportedTunnels;
    if (type === "chain") return availableForwardChainGroups;
    return availableFailoverForwardGroups;
  }, [availableFailoverForwardGroups, availableForwardChainGroups, availablePortForwardGroups, supportedTunnels]);
  const exportResources = useMemo(() => getTransferResources(exportScopeType), [exportScopeType, getTransferResources]);
  const importResources = useMemo(() => getImportResources(importScopeType), [getImportResources, importScopeType]);
  return { availableFailoverForwardGroups, exportResources, importResources, getRuleFilterResources };
}
