/*
  从 client/src/pages/Rules.tsx 第 2307-2373 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { defaultForm, type BatchEditFormData, type RuleBatchManageMode, type RuleCategory, type RuleProtocol, type RuleTransferScopeType } from "../../pages/Rules";
import { useRefreshPersonalRuleGroups } from "@/components/rules/PersonalRuleGroups";
import { useRuleBatchJobSubmit } from "@/components/rules/useRuleBatchJobSubmit";
import { type CompatibleRuleFile } from "@/lib/nyanpassImport";
import { trpc } from "@/lib/trpc";
import { useCallback, useRef, useState } from "react";

/**
 * 批量管理弹窗（复制 / 编辑 / 导出 / 导入 / 调整分组 / 启停）的全部 state 与 mutation。
 * 留在页面这一层而不是弹窗组件里：导入草稿、目标选择这些在关掉弹窗后还要保留，而弹窗本身是按需挂载的。
 * 返回类型交给推断，别处用 RuleBatchManageState。
 */
export function useRuleBatchManageState() {
  const [copyRuleIds, setCopyRuleIds] = useState<number[]>([]);
  const [copyRuleSearch, setCopyRuleSearch] = useState("");
  const [copyRuleCategory, setCopyRuleCategory] = useState<RuleCategory>("all");
  const [copyManageMode, setCopyManageMode] = useState<RuleBatchManageMode>("copy");
  /*
    批量管理里的个人分组（上游 2.3.290）：左边按分组筛（每种操作都能用，打开时沿用页面上的分组筛选）；
    「调整分组」先选目标分组和加入 / 移出，左边只列出真的会被改到的规则（canChangePersonalRuleGroups）。
  */
  const [copyRulePersonalGroup, setCopyRulePersonalGroup] = useState<number | null>(null);
  const [batchGroupTargetIds, setBatchGroupTargetIds] = useState<number[]>([]);
  const [batchGroupMode, setBatchGroupMode] = useState<"add" | "remove">("add");
  const moveToPersonalGroupsMutation = trpc.rules.moveToPersonalGroups.useMutation();
  const refreshPersonalRuleGroups = useRefreshPersonalRuleGroups();
  const [copyTargetScopeType, setCopyTargetScopeType] = useState<RuleTransferScopeType>("local");
  const [copyTargetResourceIds, setCopyTargetResourceIds] = useState<number[]>([]);
  // Keep an eagerly-updated snapshot of the target selection.  React state is
  // normally flushed before the next click, but a user can click a checkbox
  // and the action button in the same frame (especially on a busy page).  In
  // that case the button handler may still be running the previous render's
  // closure.  The ref is updated by the selection handlers before scheduling
  // the state update, so a copy always uses the most recent explicit choice.
  const copyTargetSelectionRef = useRef<{
    scopeType: RuleTransferScopeType;
    resourceIds: number[];
  }>({ scopeType: "local", resourceIds: [] });
  const commitCopyTargetSelection = useCallback((scopeType: RuleTransferScopeType, resourceIds: readonly number[]) => {
    const normalizedIds = Array.from(new Set(resourceIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)));
    copyTargetSelectionRef.current = { scopeType, resourceIds: normalizedIds };
    setCopyTargetScopeType(scopeType);
    setCopyTargetResourceIds(normalizedIds);
  }, []);
  const [copyTargetSearch, setCopyTargetSearch] = useState("");
  const [copyConflictStrategy, setCopyConflictStrategy] = useState<"skip" | "auto" | "error">("auto");
  const [copyWorking, setCopyWorking] = useState(false);
  const [batchEditForm, setBatchEditForm] = useState<BatchEditFormData>({
    routeMode: "local",
    forwardType: defaultForm.forwardType,
    tunnelId: null,
    forwardGroupId: null,
    targetIp: "",
    targetPort: 0,
  });
  const [exportScopeType] = useState<RuleTransferScopeType>("local");
  const [exportResourceId, setExportResourceId] = useState("");
  const [importScopeType, setImportScopeType] = useState<RuleTransferScopeType>("tunnel");
  const [importResourceId, setImportResourceId] = useState("");
  const [importResourceSearch, setImportResourceSearch] = useState("");
  const [importSourceMode, setImportSourceMode] = useState<"file" | "manual" | "nyanpass">("file");
  const [importFile, setImportFile] = useState<CompatibleRuleFile | null>(null);
  /** ny 导出里没有协议，导入时统一选一个（上游 2.3.285，实验性）。 */
  const [importNyanpassProtocol, setImportNyanpassProtocol] = useState<RuleProtocol>("tcp");
  const [importNyanpassAcknowledged, setImportNyanpassAcknowledged] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importFileError, setImportFileError] = useState("");
  const [importFileInputKey, setImportFileInputKey] = useState(0);
  const [importManualText, setImportManualText] = useState("");
  const [importingRules, setImportingRules] = useState(false);
  const importingRulesRef = useRef(false);

  const batchCreateMutation = trpc.rules.create.useMutation();
  const batchUpdateMutation = trpc.rules.update.useMutation();
  const batchDeleteMutation = trpc.rules.deleteBatch.useMutation();
  const ruleBatchJob = useRuleBatchJobSubmit();

  const importCreateMutation = trpc.rules.create.useMutation();
  return { exportScopeType, importScopeType, exportResourceId, setExportResourceId, importResourceId, setImportResourceId, importResourceSearch, importManualText, setCopyManageMode, setBatchEditForm, setCopyRulePersonalGroup, setBatchGroupTargetIds, setBatchGroupMode, setCopyRuleCategory, setCopyRuleSearch, commitCopyTargetSelection, setCopyTargetSearch, setCopyRuleIds, setCopyConflictStrategy, setImportScopeType, setImportResourceSearch, copyManageMode, copyTargetSelectionRef, batchEditForm, batchUpdateMutation, copyConflictStrategy, ruleBatchJob, setCopyWorking, copyRuleCategory, copyRuleSearch, copyRulePersonalGroup, batchGroupMode, batchGroupTargetIds, copyRuleIds, copyTargetScopeType, copyTargetSearch, copyTargetResourceIds, copyWorking, batchCreateMutation, batchDeleteMutation, moveToPersonalGroupsMutation, refreshPersonalRuleGroups, importSourceMode, importFile, setImportNyanpassAcknowledged, importNyanpassProtocol, importNyanpassAcknowledged, importFileError, setImportFile, setImportFileName, setImportFileError, setImportFileInputKey, setImportManualText, importingRulesRef, setImportingRules, importCreateMutation, setImportSourceMode, importingRules, importFileInputKey, importFileName, setImportNyanpassProtocol };
}

export type RuleBatchManageState = ReturnType<typeof useRuleBatchManageState>;
