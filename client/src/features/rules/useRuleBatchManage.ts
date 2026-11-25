/*
  从 client/src/pages/Rules.tsx 第 4514-5173 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { defaultForm, downloadRuleTransferFiles, formatAddressWithPort, getForwardGroupKindLabel, getForwardGroupRuleForwardType, getTunnelDisplay, isForwardRuleVisibleByFilters, normalizePositiveRuleNumber, normalizeProxyProtocolVersion, normalizeRuleProtocol, ruleTransferScopeLabels, type BatchEditFormData, type RuleBatchManageMode, type RuleCardRule, type RuleCategory, type RuleFilterState, type RuleResourceRow, type RuleRouteMode, type RuleTransferScopeType } from "../../pages/Rules";
import { batchOperationErrorMessage, chunkBatchItems, isBatchPortConflictError, runBatchOperations } from "@/lib/batchOperations";
import { parseCompatibleRuleTransferText, type CompatibleRuleFile, type ImportedRule, validateNyanpassImportTarget } from "@/lib/nyanpassImport";
import { RULE_TRANSFER_MAX_FILE_SIZE, normalizeFailoverStrategy, type RuleTransferFileRule } from "@/lib/ruleTransfer";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { parseFailoverTargets } from "@shared/failoverTargets";
import { isValidForwardPort, isValidTargetHost } from "@shared/forwardRuleForm";
import { type ForwardType } from "@shared/forwardTypes";
import { MAX_PERSONAL_RULE_GROUP_CHANGE, canChangePersonalRuleGroups, matchesPersonalRuleGroup } from "@shared/ruleGroups";
import { useCallback, useEffect, useMemo, type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { trpc } from "@/lib/trpc";
import type { RuleBatchManageState } from "./useRuleBatchManageState";
import { toast } from "sonner";

export type UseRuleBatchManageContext = RuleBatchManageState & {
  personalGroupFilter: number | null;
  ruleCategory: RuleCategory;
  ruleSearchQuery: string;
  canUseSavedLocalForward: boolean;
  canUseGost: boolean;
  canUseForwardChain: boolean;
  canUseFailoverGroup: boolean;
  showCopyDialog: boolean;
  setShowCopyDialog: Dispatch<SetStateAction<boolean>>;
  createOwnerUserId: number | undefined;
  telegramBotReady: boolean;
  canAdd: boolean;
  availablePortForwardGroups: RuleResourceRow[];
  supportedTunnels: RuleResourceRow[];
  availableForwardChainGroups: RuleResourceRow[];
  availableFailoverForwardGroups: RuleResourceRow[];
  invalidateRuleProbeStatuses: (ruleIds: Iterable<number> | undefined) => void;
  utils: ReturnType<typeof trpc.useUtils>;
  fullRulesQuery: ReturnType<typeof trpc.rules.list.useQuery>;
  confirmDialog: ReturnType<typeof useConfirmDialog>;
  selectedScopeQueryEnabled: boolean;
  selectedScopedRules: RuleCardRule[] | undefined;
  needsFullRuleList: boolean;
  baseScopedRules: RuleCardRule[];
  ruleFilters: RuleFilterState;
  isRuleSupported: (rule: RuleCardRule) => boolean;
  hosts: RuleResourceRow[] | undefined;
  tunnels: RuleResourceRow[] | undefined;
  forwardGroupById: Map<number, RuleResourceRow>;
  tunnelById: Map<number, RuleResourceRow>;
  nginxTunnelEnabled: boolean;
  selectedImportResource: RuleResourceRow | null;
  user: ReturnType<typeof useAuth>["user"];
  manualImportValidation: { ok: boolean; message: string; rules: RuleTransferFileRule[] };
};

/** 规则更新 / 创建的入参类型：批量编辑拼的是宽对象，交给 mutation 前按这个收口。 */
type RuleUpdateInput = Parameters<ReturnType<typeof trpc.rules.update.useMutation>["mutateAsync"]>[0];

/**
 * 批量管理弹窗的派生数据与所有动作（打开、切模式、复制、编辑、导出、删除、启停、调整分组、导入）。
 * state 来自 useRuleBatchManageState，其余是页面上的权限 / 资源列表 / 查询；返回的对象整个交给 RuleBatchManageDialog。
 */
export function useRuleBatchManage(ctx: UseRuleBatchManageContext) {
  const { setCopyManageMode, setBatchEditForm, setCopyRulePersonalGroup, personalGroupFilter, setBatchGroupTargetIds, setBatchGroupMode, setCopyRuleCategory, ruleCategory, setCopyRuleSearch, ruleSearchQuery, canUseSavedLocalForward, canUseGost, canUseForwardChain, commitCopyTargetSelection, setCopyTargetSearch, setCopyRuleIds, setCopyConflictStrategy, setImportScopeType, setImportResourceId, setImportResourceSearch, setShowCopyDialog, copyManageMode, copyTargetSelectionRef, batchEditForm, canUseFailoverGroup, createOwnerUserId, telegramBotReady, batchUpdateMutation, copyConflictStrategy, canAdd, availablePortForwardGroups, supportedTunnels, availableForwardChainGroups, availableFailoverForwardGroups, ruleBatchJob, setCopyWorking, invalidateRuleProbeStatuses, utils, showCopyDialog, fullRulesQuery, confirmDialog, selectedScopeQueryEnabled, selectedScopedRules, needsFullRuleList, baseScopedRules, ruleFilters, copyRuleCategory, copyRuleSearch, isRuleSupported, copyRulePersonalGroup, batchGroupMode, batchGroupTargetIds, copyRuleIds, copyTargetScopeType, copyTargetSearch, hosts, copyTargetResourceIds, copyWorking, batchCreateMutation, batchDeleteMutation, moveToPersonalGroupsMutation, refreshPersonalRuleGroups, tunnels, forwardGroupById, nginxTunnelEnabled, importSourceMode, importManualText, importFile, setImportNyanpassAcknowledged, importResourceId, importScopeType, importNyanpassProtocol, selectedImportResource, user, importNyanpassAcknowledged, manualImportValidation, importFileError, setImportFile, setImportFileName, setImportFileError, setImportFileInputKey, setImportManualText, tunnelById, importingRulesRef, setImportingRules, importCreateMutation, setImportSourceMode } = ctx;
  const openCopyDialog = () => {
    setCopyManageMode(transferSourceRules.length ? "copy" : "import");
    setBatchEditForm(buildEmptyBatchEditForm());
    setCopyRulePersonalGroup(personalGroupFilter);
    setBatchGroupTargetIds([]);
    setBatchGroupMode("add");
    setCopyRuleCategory(ruleCategory);
    setCopyRuleSearch(ruleSearchQuery);
    const preferredCopyTargetScope: RuleTransferScopeType = canUseSavedLocalForward
      ? "local"
      : canUseGost
        ? "tunnel"
        : canUseForwardChain
          ? "chain"
          : "group";
    commitCopyTargetSelection(preferredCopyTargetScope, []);
    setCopyTargetSearch("");
    setCopyRuleIds([]);
    setCopyConflictStrategy("auto");
    const preferredImportType: RuleTransferScopeType = canUseSavedLocalForward
      ? "local"
      : canUseGost
        ? "tunnel"
        : canUseForwardChain
          ? "chain"
          : "group";
    setImportScopeType(preferredImportType);
    setImportResourceId("");
    setImportResourceSearch("");
    setShowCopyDialog(true);
  };
  const toggleCopyRule = (ruleId: number, checked: boolean) => {
    setCopyRuleIds((prev) => checked ? Array.from(new Set([...prev, ruleId])) : prev.filter((id) => id !== ruleId));
  };

  const switchCopyManageMode = (mode: RuleBatchManageMode) => {
    // 进出「调整分组」时清掉勾选：那里只列得出能改的规则，带着别处勾的规则过去，等于改了看不见的规则。
    if ((mode === "group") !== (copyManageMode === "group")) setCopyRuleIds([]);
    setCopyManageMode(mode);
    if (mode === "edit") {
      commitCopyTargetSelection(copyTargetSelectionRef.current.scopeType, []);
      setBatchEditForm(buildEmptyBatchEditForm());
    }
    if (mode === "import") {
      const preferredImportType: RuleTransferScopeType = canUseSavedLocalForward
        ? "local"
        : canUseGost
          ? "tunnel"
          : canUseForwardChain
            ? "chain"
            : "group";
      setImportScopeType(preferredImportType);
      setImportResourceId("");
      setImportResourceSearch("");
      resetImportDialog();
    }
  };

  const setBatchEditRouteMode = (mode: RuleRouteMode) => {
    if (mode === batchEditForm.routeMode) return;
    if (mode === "local" && !canUseSavedLocalForward) return;
    if (mode === "tunnel" && !canUseGost) return;
    if (mode === "chain" && !canUseForwardChain) return;
    if (mode === "group" && !canUseFailoverGroup) return;
    setBatchEditForm((prev) => ({
      ...prev,
      routeMode: mode,
      forwardType: mode === "tunnel" ? "gost" : prev.forwardType,
      tunnelId: null,
      forwardGroupId: null,
    }));
  };

  const toggleCopyTargetResource = (resourceId: number, checked: boolean, renderedScopeType: RuleTransferScopeType) => {
    const current = copyTargetSelectionRef.current;
    // If the scope selector changed but this checkbox belongs to the previous
    // render, do not mix IDs from the two scopes.  The checkbox's rendered
    // scope is the authoritative context for this event.
    const currentIds = current.scopeType === renderedScopeType ? current.resourceIds : [];
    const nextIds = !checked
      ? currentIds.filter((id) => id !== resourceId)
      : copyManageMode === "edit"
        ? [resourceId]
        : Array.from(new Set([...currentIds, resourceId]));
    commitCopyTargetSelection(renderedScopeType, nextIds);
  };

  const buildBatchCopyRulePayload = (rule: RuleCardRule, targetType: RuleTransferScopeType, resource: RuleResourceRow, sourcePort: number) => {
    const isTunnelTarget = targetType === "tunnel";
    const isForwardGroupTarget = !isTunnelTarget;
    const forwardType = isTunnelTarget ? "gost" : getForwardGroupRuleForwardType(resource, rule.forwardType);
    const keepFailover = targetType === "group" && !!rule.failoverEnabled;
    return {
      hostId: isTunnelTarget ? Number(resource.entryHostId) : undefined,
      userId: createOwnerUserId,
      name: String(rule.name || "复制规则").trim().slice(0, 128) || "复制规则",
      forwardType,
      protocol: normalizeRuleProtocol(rule.protocol),
      gostMode: "direct" as const,
      gostRelayHost: null,
      gostRelayPort: null,
      tunnelId: isTunnelTarget ? Number(resource.id) : null,
      forwardGroupId: isForwardGroupTarget ? Number(resource.id) : null,
      sourcePort,
      targetIp: String(rule.targetIp || ""),
      targetPort: Number(rule.targetPort || 0),
      telegramErrorNotifyEnabled: telegramBotReady && !!rule.telegramErrorNotifyEnabled,
      entryDomainEnabled: rule.entryDomainEnabled !== false,
      proxyProtocolReceive: !!rule.proxyProtocolReceive,
      proxyProtocolSend: !!rule.proxyProtocolSend,
      proxyProtocolExitReceive: !!rule.proxyProtocolExitReceive,
      proxyProtocolExitSend: !!rule.proxyProtocolExitSend,
      proxyProtocolVersion: normalizeProxyProtocolVersion(rule.proxyProtocolVersion),
      tcpFastOpen: !!rule.tcpFastOpen,
      zeroCopy: !!rule.zeroCopy,
      udpOverTcp: !!rule.udpOverTcp,
      udpOverTcpPort: Number(rule.udpOverTcpPort || 0),
      failoverEnabled: keepFailover,
      failoverStrategy: normalizeFailoverStrategy(rule.failoverStrategy),
      failoverTargets: keepFailover ? parseFailoverTargets(rule.failoverTargets) : [],
      failoverSeconds: normalizePositiveRuleNumber(rule.failoverSeconds, 60),
      recoverSeconds: normalizePositiveRuleNumber(rule.recoverSeconds, 120),
      autoFailback: rule.autoFailback !== false,
    };
  };

  const buildBatchEditRulePayload = (rule: RuleCardRule, sourcePort: number) => {
    const payload: Record<string, unknown> = { id: Number(rule.id) };
    if (hasBatchEditRouteSelection) {
      if (batchEditForm.routeMode === "tunnel" && selectedBatchEditTunnel) {
        payload.forwardType = "gost";
        payload.tunnelId = Number(selectedBatchEditTunnel.id);
        payload.forwardGroupId = null;
        payload.hostId = Number(selectedBatchEditTunnel.entryHostId);
        payload.sourcePort = sourcePort;
      } else if (selectedBatchEditForwardGroup) {
        payload.forwardGroupId = Number(selectedBatchEditForwardGroup.id);
        payload.forwardType = getForwardGroupRuleForwardType(selectedBatchEditForwardGroup, rule.forwardType);
        payload.sourcePort = sourcePort;
      }
    }
    if (hasBatchEditTargetIpChange) payload.targetIp = batchEditTargetIp;
    if (hasBatchEditTargetPortChange) payload.targetPort = batchEditTargetPort;
    return payload;
  };

  const updateBatchRuleTarget = async (rule: RuleCardRule) => {
    const sourcePort = Number(rule.sourcePort || 0);
    try {
      await batchUpdateMutation.mutateAsync(buildBatchEditRulePayload(rule, sourcePort) as unknown as RuleUpdateInput);
      return { updated: true, skipped: false };
    } catch (error) {
      if (!hasBatchEditRouteSelection || copyConflictStrategy === "error" || !isBatchPortConflictError(error)) throw error;
      if (copyConflictStrategy === "auto") {
        await batchUpdateMutation.mutateAsync(buildBatchEditRulePayload(rule, 0) as unknown as RuleUpdateInput);
        return { updated: true, skipped: false };
      }
      return { updated: false, skipped: true };
    }
  };

  const handleCopyRules = async () => {
    if (!canAdd) {
      toast.error("当前账号没有添加转发规则的权限");
      return;
    }
    if (copySelectedRules.length === 0) {
      toast.error("请选择要复制的规则");
      return;
    }
    // Read the eagerly-updated selection snapshot instead of relying solely
    // on values captured by the render that created this click handler.  This
    // prevents a checkbox click immediately followed by "复制" from using a
    // previous target (or a previous scope when the resource list is being
    // refreshed).
    const targetSelection = copyTargetSelectionRef.current;
    const targetType = targetSelection.scopeType;
    const targetResources = targetType === "local"
      ? availablePortForwardGroups
      : targetType === "tunnel"
        ? supportedTunnels
        : targetType === "chain"
          ? availableForwardChainGroups
          : availableFailoverForwardGroups;
    const selectedTargetIds = new Set(targetSelection.resourceIds.map(Number));
    const selectedTargets = targetResources.filter((resource: RuleResourceRow) => selectedTargetIds.has(Number(resource.id)));
    if (selectedTargets.length === 0) {
      toast.error("请选择目标" + ruleTransferScopeLabels[targetType]);
      return;
    }
    const targetNames = selectedTargets.map((resource: RuleResourceRow) => (
      `${getTransferResourceLabel(targetType, resource)} (#${Number(resource.id)})`
    ));
    const targetSummary = targetNames.length <= 3
      ? targetNames.join("、")
      : `${targetNames.slice(0, 3).join("、")} 等 ${targetNames.length} 个目标`;
    /*
      批量复制交给服务端任务（上游 2.3.290）：每条副本的参数在这里按原来的规则拼好，服务端逐条调 rules.create，
      端口冲突按所选策略换端口或跳过。提交即返回，进度、失败明细、重试失败项都在右下角的小窗里。
    */
    const copyItems = selectedTargets.flatMap((resource: RuleResourceRow) => copySelectedRules.map((rule: RuleCardRule) => ({
      label: `${String(rule.name || `规则 #${rule.id}`)} → ${getTransferResourceLabel(targetType, resource)}`.slice(0, 160),
      input: buildBatchCopyRulePayload(rule, targetType, resource, Number(rule.sourcePort || 0)) as Record<string, unknown>,
    })));
    const submitted = await ruleBatchJob.submit({
      operation: "copy",
      title: `复制 ${copySelectedRules.length} 条规则到 ${targetSummary}`.slice(0, 80),
      copyItems,
      conflictStrategy: copyConflictStrategy,
    });
    if (submitted) setShowCopyDialog(false);
  };

  const handleBatchEditRules = async () => {
    if (copySelectedRules.length === 0) {
      toast.error("请选择要批量编辑的规则");
      return;
    }
    if (!hasBatchEditChanges) {
      toast.error("请至少选择要替换的入口资源，或填写目标地址/端口");
      return;
    }
    if (batchEditForm.routeMode === "tunnel" && !selectedBatchEditTunnel && !hasBatchEditTargetIpChange && !hasBatchEditTargetPortChange) {
      toast.error("请选择要替换到的隧道");
      return;
    }
    if (batchEditForm.routeMode !== "tunnel" && !selectedBatchEditForwardGroup && !hasBatchEditTargetIpChange && !hasBatchEditTargetPortChange) {
      toast.error(batchEditForm.routeMode === "local" ? "请选择要替换到的端口转发" : batchEditForm.routeMode === "chain" ? "请选择要替换到的转发链" : "请选择要替换到的转发组");
      return;
    }
    if (hasBatchEditTargetIpChange && !isValidTargetHost(batchEditTargetIp)) {
      toast.error("请输入有效的目标地址");
      return;
    }
    if (batchEditForm.targetPort && !hasBatchEditTargetPortChange) {
      toast.error("请输入有效的目标端口");
      return;
    }
    setCopyWorking(true);
    let updated = 0;
    let skipped = 0;
    try {
      const results = await runBatchOperations(copySelectedRules, 6, (rule) => updateBatchRuleTarget(rule));
      for (const result of results) {
        if (result.status === "rejected") continue;
        if (result.value.updated) updated += 1;
        if (result.value.skipped) skipped += 1;
      }
      invalidateRuleProbeStatuses(results
        .filter((result) => result.status === "fulfilled" && result.value.updated)
        .map((result) => Number(result.item.id)));
      await Promise.all([
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
        utils.rules.trafficSummary.invalidate(),
      ]);
      if (showCopyDialog) await fullRulesQuery.refetch();
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        toast.error(`批量编辑完成：成功 ${updated} 条，跳过 ${skipped} 条，失败 ${failures.length} 条。${batchOperationErrorMessage(failures[0].reason)}`);
      } else {
        toast.success("已批量编辑 " + updated + " 条规则" + (skipped ? "，跳过 " + skipped + " 条" : ""));
        if (updated > 0) setShowCopyDialog(false);
      }
    } catch (error) {
      toast.error("批量编辑处理失败：" + ((error instanceof Error && error.message) || "请检查目标配置"));
    } finally {
      setCopyWorking(false);
    }
  };

  const handleBatchExportRules = () => {
    if (copySelectedRules.length === 0) {
      toast.error("请选择要导出的规则");
      return;
    }
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const partCount = downloadRuleTransferFiles(
      copySelectedRules,
      { type: "batch", name: "批量管理选中规则" },
      `forwardx-rules-batch-${date}`,
    );
    toast.success(`已导出 ${copySelectedRules.length} 条规则${partCount > 1 ? `，共 ${partCount} 个文件` : ""}`);
  };

  /** 批量删除 / 启用 / 暂停 / 重启都交给服务端任务：提交即返回，进度见右下角的小窗。 */
  const batchRuleLabels = (rules: RuleCardRule[]) => Object.fromEntries(rules.map((rule: RuleCardRule) => [
    String(rule.id),
    String(rule.name || `规则 #${rule.id}`).slice(0, 160),
  ]));

  const handleBatchDeleteRules = async () => {
    if (copySelectedRules.length === 0) {
      toast.error("请选择要删除的规则");
      return;
    }
    if (!(await confirmDialog({
      title: "删除转发规则",
      description: `确认删除选中的 ${copySelectedRules.length} 条转发规则？删除在后台逐条进行，可以随时停止剩下的。`,
      confirmText: "删除",
      tone: "destructive",
    }))) return;
    const requestedIds = Array.from(new Set(copySelectedRules.map((rule: RuleCardRule) => Number(rule.id))));
    const submitted = await ruleBatchJob.submit({
      operation: "delete",
      ruleIds: requestedIds,
      ruleLabels: batchRuleLabels(copySelectedRules),
      conflictStrategy: "error",
    });
    if (submitted) {
      setCopyRuleIds([]);
      setShowCopyDialog(false);
    }
  };

  const handleBatchStateRules = async (operation: "enable" | "pause" | "restart") => {
    if (copySelectedRules.length === 0) {
      toast.error("请选择规则");
      return;
    }
    if (operation === "restart" && !(await confirmDialog({
      title: "重启转发规则",
      description: `按当前配置把选中的 ${copySelectedRules.length} 条规则重新下发给 Agent。已暂停的规则保持暂停，流量统计不受影响。`,
      confirmText: "重启",
    }))) return;
    const submitted = await ruleBatchJob.submit({
      operation,
      ruleIds: Array.from(new Set(copySelectedRules.map((rule: RuleCardRule) => Number(rule.id)))),
      ruleLabels: batchRuleLabels(copySelectedRules),
      conflictStrategy: "error",
    });
    if (submitted) setShowCopyDialog(false);
  };

  // Batch tools need all matching source rules, while the page itself stays
  // on its current server page.  Keep these two data sources separate.
  // 用 useMemo 包一层：空列表的 [] 不再每次渲染新建，下游 copyableSourceRules / copySelectedRules 的依赖才稳。
  const fullRuleListData = fullRulesQuery.data as RuleCardRule[] | undefined;
  const transferSourceRules = useMemo<RuleCardRule[]>(() => (selectedScopeQueryEnabled
    ? selectedScopedRules || []
    : needsFullRuleList
      ? fullRuleListData || []
      : baseScopedRules), [baseScopedRules, fullRuleListData, needsFullRuleList, selectedScopeQueryEnabled, selectedScopedRules]);
  const copyableSourceRules = useMemo(() => {
    const batchFilters: RuleFilterState = {
      ...ruleFilters,
      filterResource: "all",
      ruleCategory: copyRuleCategory,
      searchQuery: copyRuleSearch,
    };
    const groupMode = copyManageMode === "group";
    // 启停 / 重启和调整分组一样不搬家：共享 TLS 入站上的规则也能勾。
    const keepsResource = groupMode || copyManageMode === "state";
    return transferSourceRules
      // 共享 TLS 入站上的规则不参与批量复制 / 迁移：它们没有自己的端口，搬到别的资源上就不是同一条规则了。
      // 调整分组只是贴标签，这些规则照样能分组。
      .filter((rule: RuleCardRule) => !rule.forwardGroupRuleId && !rule.forwardGroupMemberId && (keepsResource || (!(Number(rule.tlsInboundId || 0) > 0) && isRuleSupported(rule))))
      .filter((rule: RuleCardRule) => isForwardRuleVisibleByFilters(rule, batchFilters))
      .filter((rule) => matchesPersonalRuleGroup(rule.personalGroupIds, copyRulePersonalGroup))
      .filter((rule) => !groupMode || canChangePersonalRuleGroups(rule.personalGroupIds, batchGroupMode, batchGroupTargetIds));
  }, [batchGroupMode, batchGroupTargetIds, copyManageMode, copyRuleCategory, copyRulePersonalGroup, copyRuleSearch, isRuleSupported, ruleFilters, transferSourceRules]);
  const copySelectedRules = useMemo(() => {
    const selected = new Set(copyRuleIds.map(Number));
    if (copyManageMode === "group") {
      // 勾着的、而且此刻还真的会被改到的（列表刷新后有的规则可能已经在组里了）
      return transferSourceRules.filter((rule) => selected.has(Number(rule.id)) && !rule.forwardGroupRuleId && !rule.forwardGroupMemberId
        && canChangePersonalRuleGroups(rule.personalGroupIds, batchGroupMode, batchGroupTargetIds));
    }
    return transferSourceRules.filter((rule: RuleCardRule) => selected.has(Number(rule.id)) && !rule.forwardGroupRuleId && !rule.forwardGroupMemberId
      && (copyManageMode === "state" || !(Number(rule.tlsInboundId || 0) > 0)));
  }, [batchGroupMode, batchGroupTargetIds, copyManageMode, copyRuleIds, transferSourceRules]);
  const copyTargetResources = useMemo(() => {
    if (copyTargetScopeType === "local") return availablePortForwardGroups;
    if (copyTargetScopeType === "tunnel") return supportedTunnels;
    if (copyTargetScopeType === "chain") return availableForwardChainGroups;
    return availableFailoverForwardGroups;
  }, [availableFailoverForwardGroups, availableForwardChainGroups, availablePortForwardGroups, copyTargetScopeType, supportedTunnels]);
  const filteredCopyTargetResources = useMemo(() => {
    const keyword = copyTargetSearch.trim().toLowerCase();
    if (!keyword) return copyTargetResources;
    return copyTargetResources.filter((resource: RuleResourceRow) => {
      const values = [
        resource?.id,
        resource?.name,
        resource?.description,
        resource?.displayRemark,
        resource?.domain,
        resource?.forwardType,
        resource?.groupMode,
        resource?.groupType,
        resource?.mode,
        resource?.listenPort,
        resource?.entryHostId,
        resource?.exitHostId,
        getForwardGroupKindLabel(resource),
        copyTargetScopeType === "tunnel" ? getTunnelRouteText(resource, hosts || []) : "",
      ];
      (resource?.members || []).forEach((member: RuleResourceRow) => {
        values.push(member?.hostId, member?.tunnelId, member?.entryAddress, member?.connectHost, member?.name);
      });
      return values.filter((value) => value !== undefined && value !== null && String(value).trim()).join(" ").toLowerCase().includes(keyword);
    });
  }, [copyTargetResources, copyTargetScopeType, copyTargetSearch, hosts]);
  const selectedCopyTargetResources = useMemo(() => {
    const selected = new Set(copyTargetResourceIds.map(Number));
    return copyTargetResources.filter((resource: RuleResourceRow) => selected.has(Number(resource.id)));
  }, [copyTargetResourceIds, copyTargetResources]);
  const copyTargetScopeLabel = ruleTransferScopeLabels[copyTargetScopeType];
  const copyActionPending = copyWorking || ruleBatchJob.isPending || batchCreateMutation.isPending || batchUpdateMutation.isPending || batchDeleteMutation.isPending || moveToPersonalGroupsMutation.isPending;
  const isBatchGroupMode = copyManageMode === "group";
  const isBatchStateMode = copyManageMode === "state";
  const isBatchEditMode = copyManageMode === "edit";
  const isBatchCopyMode = copyManageMode === "copy";
  const isBatchExportMode = copyManageMode === "export";
  const isBatchImportMode = copyManageMode === "import";
  const selectedBatchRuleCount = copySelectedRules.length;
  const selectedBatchTargetCount = selectedCopyTargetResources.length;
  const allVisibleCopyRulesSelected = copyableSourceRules.length > 0
    && copyableSourceRules.every((rule: RuleCardRule) => copyRuleIds.includes(Number(rule.id)));
  const allVisibleCopyTargetsSelected = filteredCopyTargetResources.length > 0
    && filteredCopyTargetResources.every((resource: RuleResourceRow) => copyTargetResourceIds.includes(Number(resource.id)));
  const batchFlowHintLabel = isBatchGroupMode
    ? batchGroupMode === "add" ? "加入右侧分组" : "移出右侧分组"
    : isBatchStateMode
    ? "启停或重启所选"
    : isBatchEditMode
    ? "按右侧设置处理"
    : isBatchExportMode
      ? "导出左侧已选规则"
      : "复制到右侧目标";
  /** 「调整分组」：把勾选的规则加入 / 移出右边选的那几个组。一次最多 500 条，多了分几次交。 */
  const handleBatchGroupRules = async () => {
    const ids = Array.from(new Set(copySelectedRules.map((rule) => Number(rule.id))));
    if (ids.length === 0 || batchGroupTargetIds.length === 0) return;
    setCopyWorking(true);
    let done = 0;
    try {
      for (const chunk of chunkBatchItems(ids, MAX_PERSONAL_RULE_GROUP_CHANGE)) {
        const result = await moveToPersonalGroupsMutation.mutateAsync({ ids: chunk, groupIds: batchGroupTargetIds, mode: batchGroupMode });
        done += Number(result.count || chunk.length);
      }
      setCopyRuleIds([]);
      toast.success(`已${batchGroupMode === "add" ? "加入" : "移出"}分组：${done} 条规则`);
    } catch (error) {
      toast.error(`${done > 0 ? `已处理 ${done} 条，其余` : ""}调整分组失败：${(error instanceof Error && error.message) || "请稍后重试"}`);
    } finally {
      await refreshPersonalRuleGroups();
      if (showCopyDialog) await fullRulesQuery.refetch();
      setCopyWorking(false);
    }
  };
  const buildEmptyBatchEditForm = useCallback((): BatchEditFormData => ({
    routeMode: canUseSavedLocalForward ? "local" : canUseGost ? "tunnel" : canUseForwardChain ? "chain" : canUseFailoverGroup ? "group" : "local",
    forwardType: defaultForm.forwardType,
    tunnelId: null,
    forwardGroupId: null,
    targetIp: "",
    targetPort: 0,
  }), [canUseFailoverGroup, canUseForwardChain, canUseGost, canUseSavedLocalForward]);
  const selectedBatchEditTunnel = useMemo(() => {
    if (!batchEditForm.tunnelId || !tunnels) return null;
    return tunnels.find((t: RuleResourceRow) => Number(t.id) === Number(batchEditForm.tunnelId)) || null;
  }, [batchEditForm.tunnelId, tunnels]);
  const selectedBatchEditForwardGroup = useMemo(() => {
    if (!batchEditForm.forwardGroupId) return null;
    return forwardGroupById.get(Number(batchEditForm.forwardGroupId)) || null;
  }, [batchEditForm.forwardGroupId, forwardGroupById]);
  const selectedBatchEditTunnelDisplay = useMemo(
    () => getTunnelDisplay(selectedBatchEditTunnel, nginxTunnelEnabled),
    [selectedBatchEditTunnel, nginxTunnelEnabled],
  );
  const batchEditAvailableGroups = useMemo(
    () => batchEditForm.routeMode === "local"
      ? availablePortForwardGroups
      : batchEditForm.routeMode === "chain"
        ? availableForwardChainGroups
        : availableFailoverForwardGroups,
    [availableFailoverForwardGroups, availableForwardChainGroups, availablePortForwardGroups, batchEditForm.routeMode],
  );
  const batchEditTargetIp = String(batchEditForm.targetIp || "").trim();
  const batchEditTargetPort = Number(batchEditForm.targetPort || 0);
  const hasBatchEditRouteSelection = batchEditForm.routeMode === "tunnel"
    ? !!selectedBatchEditTunnel
    : !!selectedBatchEditForwardGroup;
  const hasBatchEditTargetIpChange = batchEditTargetIp.length > 0;
  const hasBatchEditTargetPortChange = isValidForwardPort(batchEditTargetPort);
  const hasBatchEditChanges = hasBatchEditRouteSelection || hasBatchEditTargetIpChange || hasBatchEditTargetPortChange;
  const batchCopyDisabled = !canAdd || copyActionPending || selectedBatchRuleCount === 0 || selectedBatchTargetCount === 0;
  const batchEditDisabled = copyActionPending || selectedBatchRuleCount === 0 || !hasBatchEditChanges;
  const getTransferResourceLabel = (type: RuleTransferScopeType, resource: RuleResourceRow) => {
    if (!resource) return "";
    if (type === "local") return resource.name || `端口转发 #${resource.id}`;
    if (type === "tunnel") return `${resource.name || `#${resource.id}`} / ${getTunnelRouteText(resource, hosts || [])}`;
    return resource.name || `#${resource.id}`;
  };
  /*
    ny / Nyanpass 导入（实验性）：粘贴 ny 导出的逐行 JSON，或者直接选 ny 的导出文件（文件导入会自动认出来）。
    导进来一律先停用；入口端口冲突就留作失败项，不像普通导入那样改成随机端口 —— 迁移过来的规则
    对外公布的端口不能悄悄变。
  */
  const nyanpassPaste = useMemo(() => (importSourceMode === "nyanpass" && importManualText.trim()
    ? parseCompatibleRuleTransferText(importManualText)
    : null), [importSourceMode, importManualText]);
  const nyanpassFile = importSourceMode === "nyanpass"
    ? (nyanpassPaste?.ok && (nyanpassPaste.file as CompatibleRuleFile).importSource === "nyanpass" ? nyanpassPaste.file as CompatibleRuleFile : null)
    : importSourceMode === "file" && importFile?.importSource === "nyanpass" ? importFile : null;
  const isNyanpassImport = importSourceMode === "nyanpass" || !!nyanpassFile;
  useEffect(() => { setImportNyanpassAcknowledged(false); }, [importResourceId, importScopeType, importNyanpassProtocol, importManualText, setImportNyanpassAcknowledged]);

  const importValidation = useMemo<{ ok: boolean; message: string; rules: ImportedRule[] }>(() => {
    if (!importResourceId) return { ok: false, message: `请选择${ruleTransferScopeLabels[importScopeType]}`, rules: [] };
    if (isNyanpassImport) {
      if (nyanpassPaste && !nyanpassPaste.ok) return { ok: false, message: nyanpassPaste.error, rules: [] };
      if (!nyanpassFile) return { ok: false, message: "粘贴 ny 导出的规则（一行一条 JSON），或选 ny 的导出文件", rules: [] };
      const rules = nyanpassFile.rules.map((rule) => ({ ...rule, protocol: importNyanpassProtocol }));
      const error = validateNyanpassImportTarget(rules, { protocol: importNyanpassProtocol, scope: importScopeType, resource: selectedImportResource, admin: user?.role === "admin" });
      if (error) return { ok: false, message: error, rules };
      if (!importNyanpassAcknowledged) return { ok: false, message: "请先勾选下面的实验性导入说明", rules };
      return { ok: true, message: `ny（实验性）：识别到 ${rules.length} 条规则，导入后先停用，端口冲突的留作失败项`, rules };
    }
    if (importSourceMode === "manual") {
      if (!manualImportValidation.ok) return manualImportValidation;
      return manualImportValidation;
    }
    if (importFileError) return { ok: false, message: importFileError, rules: [] };
    if (!importFile) return { ok: false, message: "请选择导入文件", rules: [] };
    return { ok: true, message: `已识别 ${importFile.rules.length} 条${ruleTransferScopeLabels[importScopeType]}规则`, rules: importFile.rules };
  }, [importFile, importFileError, importResourceId, importScopeType, importSourceMode, manualImportValidation, isNyanpassImport, nyanpassPaste, nyanpassFile, importNyanpassProtocol, importNyanpassAcknowledged, selectedImportResource, user?.role]);

  const resetImportDialog = () => {
    setImportFile(null);
    setImportFileName("");
    setImportFileError("");
    setImportFileInputKey((key) => key + 1);
    setImportManualText("");
    setImportNyanpassAcknowledged(false);
  };

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setImportFile(null);
    setImportFileError("");
    setImportFileName(file?.name || "");
    if (!file) return;
    if (Number(file.size || 0) > RULE_TRANSFER_MAX_FILE_SIZE) {
      setImportFileError("规则文件不能超过 5 MiB");
      return;
    }
    try {
      const rawText = await file.text();
      // NEX 自己的导出文件照原来的严格校验；不是的话按 ny 的导出格式试一遍。
      const result = parseCompatibleRuleTransferText(rawText);
      if (!result.ok) {
        setImportFileError(result.error);
        return;
      }
      setImportFile(result.file);
    } catch {
      setImportFileError("文件无法解析，请选择 JSON 格式的规则文件");
    }
  };

  const buildImportRulePayload = (rule: ImportedRule) => {
    const resourceId = Number(importResourceId);
    const selectedTunnel = importScopeType === "tunnel" ? tunnelById.get(resourceId) : null;
    const selectedGroup = importScopeType === "tunnel" ? null : forwardGroupById.get(resourceId);
    const payloadForwardType: ForwardType = importScopeType === "tunnel"
      ? "gost"
      : getForwardGroupRuleForwardType(selectedGroup, rule.forwardType);
    return {
      hostId: importScopeType === "tunnel" ? Number(selectedTunnel?.entryHostId || 0) : undefined,
      userId: createOwnerUserId,
      name: rule.name,
      forwardType: payloadForwardType,
      protocol: rule.protocol,
      gostMode: "direct" as const,
      gostRelayHost: null,
      gostRelayPort: null,
      tunnelId: importScopeType === "tunnel" ? resourceId : null,
      forwardGroupId: importScopeType === "tunnel" ? null : resourceId,
      sourcePort: rule.sourcePort,
      targetIp: rule.targetIp,
      targetPort: rule.targetPort,
      isEnabled: rule.isEnabled,
      telegramErrorNotifyEnabled: telegramBotReady && !!rule.telegramErrorNotifyEnabled,
      proxyProtocolReceive: rule.proxyProtocolReceive,
      proxyProtocolSend: rule.proxyProtocolSend,
      proxyProtocolExitReceive: rule.proxyProtocolExitReceive,
      proxyProtocolExitSend: rule.proxyProtocolExitSend,
      proxyProtocolVersion: rule.proxyProtocolVersion,
      tcpFastOpen: rule.tcpFastOpen,
      zeroCopy: rule.zeroCopy,
      udpOverTcp: rule.udpOverTcp,
      udpOverTcpPort: rule.udpOverTcpPort || null,
      failoverEnabled: importScopeType === "chain" ? false : rule.failoverEnabled,
      failoverStrategy: rule.failoverStrategy,
      failoverTargets: importScopeType === "chain" || !rule.failoverEnabled ? [] : rule.failoverTargets,
      failoverSeconds: rule.failoverSeconds,
      recoverSeconds: rule.recoverSeconds,
      autoFailback: rule.autoFailback,
      // ny 规则自带的限速（只有管理员能设，validateNyanpassImportTarget 已拦过非管理员）。
      ...(isNyanpassImport && rule.rateLimitMbps && user?.role === "admin" ? { rateLimitMbps: rule.rateLimitMbps } : {}),
    };
  };

  const handleImportRules = async () => {
    if (importingRulesRef.current) return;
    if (!importValidation.ok) {
      toast.error(importValidation.message);
      return;
    }
    importingRulesRef.current = true;
    setImportingRules(true);
    try {
      const results = await runBatchOperations(importValidation.rules, 6, async (rule) => {
        const payload = buildImportRulePayload(rule);
        try {
          return await importCreateMutation.mutateAsync(payload);
        } catch (error) {
          // ny 迁移过来的入口端口是对外公布过的：冲突就留作失败项，不换随机端口。
          if (isNyanpassImport || rule.sourcePort <= 0 || !isBatchPortConflictError(error)) throw error;
          return importCreateMutation.mutateAsync({ ...payload, sourcePort: 0 });
        }
      });
      const importedCount = results.filter((result) => result.status === "fulfilled").length;
      const failures = results.filter((result) => result.status === "rejected");
      await Promise.all([
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
        utils.rules.trafficSummary.invalidate(),
      ]);
      if (showCopyDialog) await fullRulesQuery.refetch();
      if (failures.length > 0) {
        const failedRules = failures.map((result) => result.item);
        if (isNyanpassImport && nyanpassFile) {
          setImportSourceMode("file");
          setImportManualText("");
          setImportFile({ ...nyanpassFile, rules: failedRules });
        } else if (importSourceMode === "file") {
          setImportFile((current) => current ? { ...current, rules: failedRules } : current);
        } else {
          setImportManualText(failedRules
            .map((rule) => formatAddressWithPort(rule.targetIp, rule.targetPort))
            .join("\n"));
        }
        toast.error(`批量导入完成：成功 ${importedCount} 条，失败 ${failures.length} 条，已仅保留失败项供重试。${batchOperationErrorMessage(failures[0].reason)}`);
      } else {
        toast.success(`已导入 ${importedCount} 条规则`);
        setShowCopyDialog(false);
        resetImportDialog();
      }
    } catch (error) {
      toast.error(`批量导入处理失败：${(error instanceof Error && error.message) || "请检查规则配置"}`);
    } finally {
      importingRulesRef.current = false;
      setImportingRules(false);
    }
  };
  return { selectedBatchRuleCount, copyableSourceRules, allVisibleCopyRulesSelected, copyActionPending, toggleCopyRule, isBatchGroupMode, openCopyDialog, transferSourceRules, isBatchCopyMode, switchCopyManageMode, isBatchEditMode, isBatchExportMode, isBatchImportMode, isBatchStateMode, importValidation, handleImportFileChange, isNyanpassImport, resetImportDialog, getTransferResourceLabel, batchFlowHintLabel, copySelectedRules, hasBatchEditChanges, hasBatchEditRouteSelection, setBatchEditRouteMode, selectedBatchEditTunnel, selectedBatchEditTunnelDisplay, batchEditAvailableGroups, selectedBatchEditForwardGroup, hasBatchEditTargetIpChange, hasBatchEditTargetPortChange, copyTargetScopeLabel, selectedBatchTargetCount, filteredCopyTargetResources, allVisibleCopyTargetsSelected, toggleCopyTargetResource, selectedCopyTargetResources, handleImportRules, handleBatchGroupRules, handleBatchStateRules, handleBatchExportRules, handleBatchDeleteRules, handleBatchEditRules, handleCopyRules, batchEditDisabled, batchCopyDisabled };
}

export type RuleBatchManageHandle = ReturnType<typeof useRuleBatchManage>;
