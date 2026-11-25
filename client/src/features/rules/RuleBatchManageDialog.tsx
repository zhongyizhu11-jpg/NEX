/*
  从 client/src/pages/Rules.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。
  「批量管理转发规则」弹窗近 800 行 JSX（复制 / 编辑 / 导出 / 导入 / 调整分组 / 启停六种模式的左右两栏），
  只有点开时才用得上，原来和规则列表打在同一个包里。
  state 与动作留在页面那头（useRuleBatchManageState / useRuleBatchManage）：导入草稿、目标选择关掉弹窗后还要保留；这里只负责画。
*/
import { type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  desktopRuleTypeLabels, getForwardGroupRuleForwardType, getRuleCategory, importRuleTransferScopeOptions, routeModeOptionClass, ruleTransferScopeLabels, ruleTransferScopeOptions,
  type RuleCardRule, type RuleCategory, type RuleGroupType, type RuleProtocol, type RuleResourceRow, type RuleRouteMode, type RuleTransferScopeType,
} from "../../pages/Rules";
import type { RuleBatchManageState } from "./useRuleBatchManageState";
import type { RuleBatchManageHandle } from "./useRuleBatchManage";
import { RulePersonalGroupBadges } from "@/components/rules/PersonalRuleGroups";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { segmentedControlClassName } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatForwardRuleProtocol } from "@shared/forwardTypes";
import { formatPortSpan, formatRuleTargetPort, ruleSourcePortEnd } from "@shared/portRange";
import type { PersonalRuleGroup } from "@shared/ruleGroups";
import { ArrowRight, ArrowRightLeft, CheckCircle2, ClipboardCopy, Download, Folder, FolderCog, Loader2, Pause, Pencil, Play, RotateCw, Search, Trash2, Upload, XCircle } from "lucide-react";

/** 弹窗还要从页面拿的那几样：权限、资源列表和几个下拉 / 徽标的渲染助手（它们在页面别处也用，不搬）。 */
export type RuleBatchManageDialogPageProps = {
  showCopyDialog: boolean;
  setShowCopyDialog: Dispatch<SetStateAction<boolean>>;
  setRuleGroupManagerOpen: Dispatch<SetStateAction<boolean>>;
  personalGroups: PersonalRuleGroup[];
  canAdd: boolean;
  forwardTypeDisplayLabel: (forwardType: unknown) => string;
  supportedTunnels: RuleResourceRow[];
  forwardGroupById: Map<number, RuleResourceRow>;
  canUseSavedLocalForward: boolean;
  canUseGost: boolean;
  canUseForwardChain: boolean;
  canUseFailoverGroup: boolean;
  getTunnelSelectText: (tunnel: RuleResourceRow) => string;
  renderTunnelSelectLabel: (tunnel: RuleResourceRow) => ReactNode;
  getForwardGroupSelectText: (group: RuleResourceRow) => string;
  renderForwardGroupSelectLabel: (group: RuleResourceRow) => ReactNode;
  renderTunnelRoute: (tunnel: RuleResourceRow, compact?: boolean) => ReactNode;
  selectedImportResource: RuleResourceRow | null;
  filteredImportResources: RuleResourceRow[];
  renderTransferResourceOption: (type: RuleTransferScopeType, resource: RuleResourceRow, options?: { showStatus?: boolean }) => ReactNode;
  getForwardGroupMemberLabel: (member: RuleResourceRow) => string;
  renderRuleGroupIcon: (type: RuleGroupType, className?: string) => ReactNode;
};

export default function RuleBatchManageDialog({ state, handle, page }: {
  /** useRuleBatchManageState 的返回：弹窗里所有 state 与 setter。 */
  state: RuleBatchManageState;
  /** useRuleBatchManage 的返回：派生数据与动作。 */
  handle: RuleBatchManageHandle;
  page: RuleBatchManageDialogPageProps;
}) {
  const { copyRuleCategory, setCopyRuleCategory, copyRuleSearch, setCopyRuleSearch, setCopyRuleIds, copyRulePersonalGroup, setCopyRulePersonalGroup, copyRuleIds, batchGroupTargetIds, batchGroupMode, setBatchGroupMode, setBatchGroupTargetIds, importingRules, importSourceMode, setImportSourceMode, setImportManualText, setImportFile, setImportFileName, setImportFileError, setImportFileInputKey, importFileInputKey, importManualText, importFileName, importFileError, importNyanpassProtocol, setImportNyanpassProtocol, importNyanpassAcknowledged, setImportNyanpassAcknowledged, importScopeType, setImportScopeType, setImportResourceId, setImportResourceSearch, importResourceSearch, importResourceId, batchEditForm, setBatchEditForm, copyConflictStrategy, setCopyConflictStrategy, copyTargetScopeType, commitCopyTargetSelection, setCopyTargetSearch, copyTargetSearch, copyTargetSelectionRef, copyTargetResourceIds, copyWorking } = state;
  const { selectedBatchRuleCount, copyableSourceRules, allVisibleCopyRulesSelected, copyActionPending, toggleCopyRule, isBatchGroupMode, isBatchCopyMode, switchCopyManageMode, transferSourceRules, isBatchEditMode, isBatchExportMode, isBatchImportMode, isBatchStateMode, importValidation, handleImportFileChange, isNyanpassImport, resetImportDialog, getTransferResourceLabel, batchFlowHintLabel, copySelectedRules, hasBatchEditChanges, hasBatchEditRouteSelection, setBatchEditRouteMode, selectedBatchEditTunnel, selectedBatchEditTunnelDisplay, batchEditAvailableGroups, selectedBatchEditForwardGroup, hasBatchEditTargetIpChange, hasBatchEditTargetPortChange, copyTargetScopeLabel, selectedBatchTargetCount, filteredCopyTargetResources, allVisibleCopyTargetsSelected, toggleCopyTargetResource, selectedCopyTargetResources, handleImportRules, handleBatchGroupRules, handleBatchStateRules, handleBatchExportRules, handleBatchDeleteRules, handleBatchEditRules, handleCopyRules, batchEditDisabled, batchCopyDisabled } = handle;
  const { showCopyDialog, setShowCopyDialog, setRuleGroupManagerOpen, personalGroups, canAdd, forwardTypeDisplayLabel, supportedTunnels, forwardGroupById, canUseSavedLocalForward, canUseGost, canUseForwardChain, canUseFailoverGroup, getTunnelSelectText, renderTunnelSelectLabel, getForwardGroupSelectText, renderForwardGroupSelectLabel, renderTunnelRoute, selectedImportResource, filteredImportResources, renderTransferResourceOption, getForwardGroupMemberLabel, renderRuleGroupIcon } = page;
  const batchRuleSelectionPanel = (
    <div className="space-y-3 rounded-md border border-border/60 bg-background/55 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Label>规则筛选</Label>
          <div data-fx-help="" className="text-xs text-muted-foreground">先选择规则，再根据上方模式填写对应内容。</div>
        </div>
        <div className="inline-flex items-center gap-2 self-start rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          <span>已选规则</span>
          <span className="rounded-full bg-background/90 px-2 py-0.5 tabular-nums">{selectedBatchRuleCount}</span>
          <span className="text-primary/70">/ {copyableSourceRules.length}</span>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <Select value={copyRuleCategory} onValueChange={(value) => setCopyRuleCategory(value as RuleCategory)}>
          <SelectTrigger aria-label="规则类别" className="h-9 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部规则</SelectItem>
            <SelectItem value="local">端口转发</SelectItem>
            <SelectItem value="tunnel">隧道转发</SelectItem>
            <SelectItem value="chain">转发链</SelectItem>
            <SelectItem value="group">转发组</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={copyRuleSearch}
            onChange={(event) => setCopyRuleSearch(event.target.value)}
            placeholder="查找规则名称、端口或目标地址"
            className="h-9 pl-8 pr-8 text-xs"
          />
          {copyRuleSearch ? (
            <button
              type="button"
              aria-label="清空查找"
              className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setCopyRuleSearch("")}
            >
              <XCircle className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => {
            const visibleRuleIds = copyableSourceRules.map((rule: RuleCardRule) => Number(rule.id));
            const visibleRuleIdSet = new Set(visibleRuleIds);
            setCopyRuleIds((prev) => (
              allVisibleCopyRulesSelected
                ? prev.filter((id) => !visibleRuleIdSet.has(id))
                : Array.from(new Set([...prev, ...visibleRuleIds]))
            ));
          }}
          disabled={copyableSourceRules.length === 0 || copyActionPending}
        >
          {allVisibleCopyRulesSelected ? "取消" : "全选"}
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {copyableSourceRules.length} 项
        </span>
        {/* 按个人分组筛：换一个分组就清掉勾选，免得带着看不见的规则去做批量操作 */}
        <Select
          value={copyRulePersonalGroup === null ? "all" : String(copyRulePersonalGroup)}
          onValueChange={(value) => {
            setCopyRulePersonalGroup(value === "all" ? null : Number(value));
            setCopyRuleIds([]);
          }}
          disabled={copyActionPending}
        >
          <SelectTrigger aria-label="按个人分组筛选" className="ml-auto h-8 w-[9.5rem] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部分组</SelectItem>
            {personalGroups.map((group) => <SelectItem key={group.id} value={String(group.id)}>{group.name}</SelectItem>)}
            <SelectItem value="0">未分组</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="max-h-[24rem] space-y-2 overflow-y-auto rounded-md border border-border/60 p-2">
        {copyableSourceRules.length > 0 ? copyableSourceRules.map((rule: RuleCardRule) => {
          const category = getRuleCategory(rule, forwardGroupById);
          return (
            <label
              key={rule.id}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-2 transition-colors hover:bg-muted/40 ${
                copyRuleIds.includes(Number(rule.id))
                  ? "border-primary/50 bg-primary/5 shadow-sm"
                  : "border-border/40 bg-background/70"
              }`}
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={copyRuleIds.includes(Number(rule.id))}
                disabled={copyActionPending}
                onChange={(event) => toggleCopyRule(Number(rule.id), event.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {renderRuleGroupIcon(category, "h-3.5 w-3.5")}
                  <span className="min-w-0 truncate text-sm font-medium" data-no-translate="">{rule.name}</span>
                  <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[11px]">{desktopRuleTypeLabels[category]}</Badge>
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  :{formatPortSpan(rule.sourcePort, ruleSourcePortEnd(rule))} -&gt; {rule.targetIp}:{formatRuleTargetPort(rule)} / {forwardTypeDisplayLabel(rule.forwardType)} / {formatForwardRuleProtocol(rule.protocol)}
                </span>
                {rule.personalGroupIds?.length ? (
                  <span className="mt-1 flex min-w-0"><RulePersonalGroupBadges groupIds={rule.personalGroupIds} groups={personalGroups} maxVisible={3} /></span>
                ) : null}
              </span>
            </label>
          );
        }) : (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {isBatchGroupMode && batchGroupTargetIds.length === 0 ? "先在右侧选择目标分组" : "没有匹配的转发规则"}
          </div>
        )}
      </div>
    </div>
  );
  // 启停 / 重启（上游 2.3.292）：右侧只说明三种操作分别做什么，按钮在底部。
  const batchStatePanel = (
    <div className="space-y-3 rounded-md border border-border/60 bg-background/55 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Label>启停 / 重启</Label>
        <div className="inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          <span>已选</span>
          <span className="rounded-full bg-background/90 px-2 py-0.5 tabular-nums">{selectedBatchRuleCount}</span>
        </div>
      </div>
      <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
        <li><span className="font-medium text-foreground">启用</span>：和单条打开开关一样检查端口、套餐与授权，通过的才启用。</li>
        <li><span className="font-medium text-foreground">暂停</span>：停止转发，规则和统计都保留。</li>
        <li><span className="font-medium text-foreground">重启</span>：启用中的规则按当前配置重新下发给 Agent；已暂停的保持暂停，流量统计不清零。</li>
      </ul>
      <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        提交后在右下角看进度，可停止剩余或只重试失败项；同一批规则正在处理时不会重复提交。
      </div>
    </div>
  );
  const batchGroupPanel = (
    <div className="space-y-3 rounded-md border border-border/60 bg-background/55 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Label>目标分组</Label>
          <div className="text-xs text-muted-foreground">分组只有你自己看得见，不影响转发和授权。</div>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 self-start text-xs" onClick={() => setRuleGroupManagerOpen(true)} disabled={copyActionPending}>
          <FolderCog className="h-3.5 w-3.5" />管理分组
        </Button>
      </div>
      <div className={segmentedControlClassName}>
        <div className="grid grid-cols-2 gap-1">
          {(["add", "remove"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={routeModeOptionClass(batchGroupMode === mode, copyActionPending)}
              aria-pressed={batchGroupMode === mode}
              disabled={copyActionPending}
              onClick={() => {
                if (batchGroupMode === mode) return;
                setBatchGroupMode(mode);
                setCopyRuleIds([]);
              }}
            >
              <span className="truncate">{mode === "add" ? "加入分组" : "移出分组"}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[19rem] space-y-1 overflow-y-auto rounded-md border border-border/60 p-2">
        {personalGroups.length > 0 ? personalGroups.map((group) => {
          const checked = batchGroupTargetIds.includes(Number(group.id));
          return (
            <label key={group.id} className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/40 ${checked ? "bg-primary/5" : ""}`}>
              <Checkbox
                checked={checked}
                disabled={copyActionPending}
                onCheckedChange={(next) => {
                  setBatchGroupTargetIds((current) => next ? Array.from(new Set([...current, Number(group.id)])) : current.filter((id) => id !== Number(group.id)));
                  // 目标分组变了，左边能改的规则也跟着变：清掉勾选，不带着看不见的规则走
                  setCopyRuleIds([]);
                }}
              />
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{group.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{group.count}</span>
            </label>
          );
        }) : (
          <div className="py-8 text-center text-sm text-muted-foreground">还没有分组，先点「管理分组」建一个</div>
        )}
      </div>
      <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
        {batchGroupMode === "add"
          ? "左边只列出还没在全部所选分组里的规则；只在其中几个组里的照样列出，加入时补齐。规则原来的其他分组不变。"
          : "左边只列出在任一所选分组里的规则；移出只去掉所选的分组，规则的其他分组保留。"}
      </div>
    </div>
  );
  return (
  <Dialog open={showCopyDialog} onOpenChange={(open) => !copyActionPending && setShowCopyDialog(open)}>
    <DialogContent className="sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ClipboardCopy className="h-5 w-5" />
          批量管理转发规则
        </DialogTitle>
        <DialogDescription data-fx-help="">筛选并选择规则后，可批量复制、编辑、导出、删除、调整分组或启停 / 重启。删除、复制、启停和重启在服务端后台执行。</DialogDescription>
      </DialogHeader>
      <div className="max-h-[72svh] space-y-4 overflow-y-auto pr-1">
        <div className={segmentedControlClassName}>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-6">
            <button
              type="button"
              className={routeModeOptionClass(isBatchCopyMode, copyActionPending)}
              aria-pressed={isBatchCopyMode}
              onClick={() => switchCopyManageMode("copy")}
              disabled={copyActionPending || !transferSourceRules.length}
            >
              <ClipboardCopy className="h-4 w-4 shrink-0" />
              <span className="truncate">批量复制</span>
            </button>
            <button
              type="button"
              className={routeModeOptionClass(isBatchEditMode, copyActionPending)}
              aria-pressed={isBatchEditMode}
              onClick={() => switchCopyManageMode("edit")}
              disabled={copyActionPending || !transferSourceRules.length}
            >
              <Pencil className="h-4 w-4 shrink-0" />
              <span className="truncate">批量编辑</span>
            </button>
            <button
              type="button"
              className={routeModeOptionClass(isBatchExportMode, copyActionPending)}
              aria-pressed={isBatchExportMode}
              onClick={() => switchCopyManageMode("export")}
              disabled={copyActionPending || !transferSourceRules.length}
            >
              <Download className="h-4 w-4 shrink-0" />
              <span className="truncate">批量导出</span>
            </button>
            <button
              type="button"
              className={routeModeOptionClass(isBatchImportMode, copyActionPending)}
              aria-pressed={isBatchImportMode}
              onClick={() => switchCopyManageMode("import")}
              disabled={copyActionPending || importingRules || !canAdd}
            >
              <Upload className="h-4 w-4 shrink-0" />
              <span className="truncate">批量导入</span>
            </button>
            <button
              type="button"
              className={routeModeOptionClass(isBatchGroupMode, copyActionPending)}
              aria-pressed={isBatchGroupMode}
              onClick={() => switchCopyManageMode("group")}
              disabled={copyActionPending || !transferSourceRules.length}
            >
              <Folder className="h-4 w-4 shrink-0" />
              <span className="truncate">调整分组</span>
            </button>
            <button
              type="button"
              className={routeModeOptionClass(isBatchStateMode, copyActionPending)}
              aria-pressed={isBatchStateMode}
              onClick={() => switchCopyManageMode("state")}
              disabled={copyActionPending || !transferSourceRules.length}
            >
              <Play className="h-4 w-4 shrink-0" />
              <span className="truncate">启停 / 重启</span>
            </button>
          </div>
        </div>

        {isBatchImportMode ? (
          <>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_3.5rem_minmax(0,0.82fr)] lg:items-start">
            <div className="space-y-3 rounded-md border border-border/60 bg-background/55 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <Label>导入文件</Label>
                  <div className="text-xs text-muted-foreground">支持从文件导入、手动输入目标地址，或粘贴 ny 导出的规则。</div>
                </div>
                <div className="inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                  <span>待导入</span>
                  <span className="rounded-full bg-background/90 px-2 py-0.5 tabular-nums">{importValidation.rules.length}</span>
                </div>
              </div>
              <div className={segmentedControlClassName}>
                <div className="grid grid-cols-3 gap-1">
                  <button
                    type="button"
                    className={routeModeOptionClass(importSourceMode === "file", importingRules)}
                    aria-pressed={importSourceMode === "file"}
                    onClick={() => {
                      setImportSourceMode("file");
                      setImportManualText("");
                    }}
                    disabled={importingRules}
                  >
                    <Upload className="h-4 w-4 shrink-0" />
                    <span className="truncate">文件导入</span>
                  </button>
                  <button
                    type="button"
                    className={routeModeOptionClass(importSourceMode === "manual", importingRules)}
                    aria-pressed={importSourceMode === "manual"}
                    onClick={() => {
                      setImportSourceMode("manual");
                      setImportFile(null);
                      setImportFileName("");
                      setImportFileError("");
                      setImportFileInputKey((key) => key + 1);
                    }}
                    disabled={importingRules}
                  >
                    <Pencil className="h-4 w-4 shrink-0" />
                    <span className="truncate">手动输入</span>
                  </button>
                  <button
                    type="button"
                    className={routeModeOptionClass(importSourceMode === "nyanpass", importingRules)}
                    aria-pressed={importSourceMode === "nyanpass"}
                    onClick={() => {
                      setImportSourceMode("nyanpass");
                      setImportManualText("");
                      setImportFile(null);
                      setImportFileName("");
                      setImportFileError("");
                      setImportFileInputKey((key) => key + 1);
                    }}
                    disabled={importingRules}
                  >
                    <ArrowRightLeft className="h-4 w-4 shrink-0" />
                    <span className="truncate">ny 迁移</span>
                  </button>
                </div>
              </div>
              {/* 文件框和手填框只会出现一个，共用一个 FormField 的 id 不会撞。 */}
              <FormField className="space-y-2">
                <Label>{importSourceMode === "file" ? "规则文件" : importSourceMode === "nyanpass" ? "ny 导出的规则" : "目标地址列表"}</Label>
                {importSourceMode === "file" ? (
                  <Input key={importFileInputKey} type="file" accept=".json,.jsonl,.txt,application/json" onChange={handleImportFileChange} />
                ) : importSourceMode === "nyanpass" ? (
                  <Textarea
                    value={importManualText}
                    onChange={(event) => setImportManualText(event.target.value)}
                    placeholder={'一行一条，例如：\n{"name":"HK","listen_port":10001,"dest":["1.2.3.4:443"]}'}
                    className="min-h-[7.5rem] resize-y font-mono text-xs"
                  />
                ) : (
                  <Textarea
                    value={importManualText}
                    onChange={(event) => setImportManualText(event.target.value)}
                    placeholder={"每行一个目标地址，格式如：\nexample.com:443\n10.0.0.8:8080\n[2408:xxxx::1]:8443"}
                    className="min-h-[7.5rem] resize-y"
                  />
                )}
              </FormField>
              {(importSourceMode === "file" || importFileName || importFileError || importValidation.ok || String(importManualText || "").trim()) && (
                <div
                  className={`rounded-md border px-3 py-2 text-sm ${
                    importValidation.ok
                      ? "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]"
                      : importFileName || importFileError || String(importManualText || "").trim()
                        ? "border-destructive/30 bg-destructive/10 text-destructive"
                        : "border-border/60 bg-muted/30 text-muted-foreground"
                  }`}
                >
                  {importValidation.message}
                </div>
              )}
              {isNyanpassImport ? (
                <div className="space-y-2 rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_35%,transparent)] bg-[var(--fx-warn-soft)] p-3 text-xs">
                  <p className="font-medium text-[var(--fx-warn-text)]">ny / Nyanpass 迁移（实验性）</p>
                  <p className="leading-5 text-muted-foreground">ny 的导出里没有协议、启停状态和线路拓扑。选一个协议；规则导进来先停用，不迁移历史流量，不覆盖已有规则，入口端口冲突的不换端口、留作失败项。</p>
                  <Select value={importNyanpassProtocol} onValueChange={(value) => setImportNyanpassProtocol(value as RuleProtocol)} disabled={importingRules}>
                    <SelectTrigger aria-label="ny 规则的协议" className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(["tcp", "udp", "both"] as const).map((value) => <SelectItem key={value} value={value}>{formatForwardRuleProtocol(value)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <label className="flex cursor-pointer items-start gap-2 leading-5">
                    <Checkbox className="mt-0.5" checked={importNyanpassAcknowledged} onCheckedChange={(checked) => setImportNyanpassAcknowledged(!!checked)} disabled={importingRules} />
                    <span>我已核对导入目标、协议和下面的预览，接受实验性导入的限制</span>
                  </label>
                </div>
              ) : null}
              {importValidation.rules.length > 0 && (
                <div className="max-h-[24rem] space-y-2 overflow-y-auto rounded-md border border-border/60 p-2">
                  {importValidation.rules.map((rule, index) => (
                    <div key={`${rule.name}-${rule.sourcePort}-${index}`} className="rounded-md border border-border/40 bg-background/70 px-3 py-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <ArrowRightLeft className="h-3.5 w-3.5 text-primary" />
                        <span className="min-w-0 truncate text-sm font-medium" data-no-translate="">{rule.name}</span>
                        <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[11px]">{formatForwardRuleProtocol(rule.protocol)}</Badge>
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {rule.sourcePort > 0 ? `:${rule.sourcePort}` : "随机端口"} -&gt; {rule.targetIp}:{rule.targetPort} / {forwardTypeDisplayLabel(rule.forwardType)}
                      </div>
                      {isNyanpassImport && (rule.failoverEnabled || rule.proxyProtocolReceive || rule.proxyProtocolSend || rule.rateLimitMbps) ? (
                        <div className="mt-1 break-words text-xs text-muted-foreground">
                          {[
                            rule.failoverEnabled ? `另有 ${rule.failoverTargets.length} 个目标 · ${rule.failoverStrategy}` : "",
                            rule.proxyProtocolReceive || rule.proxyProtocolSend ? `PROXY 收 ${rule.proxyProtocolReceive ? "开" : "关"} · 发 ${rule.proxyProtocolSend ? `v${rule.proxyProtocolVersion}` : "关"}` : "",
                            rule.rateLimitMbps ? `限速 ${rule.rateLimitMbps} Mbps` : "",
                            "导入后停用",
                          ].filter(Boolean).join(" · ")}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="hidden lg:flex min-h-full items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <div className="rounded-full border border-primary/20 bg-primary/5 p-3 text-primary shadow-sm">
                  <ArrowRight className="h-5 w-5" />
                </div>
                <div data-fx-help="" className="text-center text-[11px] font-medium leading-4 text-muted-foreground">
                  导入到右侧目标
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-border/60 bg-background/55 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <Label>导入目标</Label>
                  <div className="text-xs text-muted-foreground">选择要导入到哪个端口转发、隧道、转发链或转发组。</div>
                </div>
                <div className="inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full bg-[var(--fx-healthy-soft)] px-3 py-1 text-xs font-medium text-[var(--fx-healthy-text)]">
                  <span>已选择</span>
                  <span className="rounded-full bg-background/90 px-2 py-0.5 tabular-nums">{selectedImportResource ? 1 : 0}</span>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <Select
                  value={importScopeType}
                  onValueChange={(value) => {
                    setImportScopeType(value as RuleTransferScopeType);
                    setImportResourceId("");
                    setImportResourceSearch("");
                    resetImportDialog();
                  }}
                >
                  <SelectTrigger aria-label="导入来源类型" className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {importRuleTransferScopeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={importResourceSearch}
                    onChange={(event) => setImportResourceSearch(event.target.value)}
                    placeholder={`查找${ruleTransferScopeLabels[importScopeType]}`}
                    className="h-9 pl-8 pr-8 text-xs"
                  />
                  {importResourceSearch ? (
                    <button
                      type="button"
                      aria-label="清空导入目标查找"
                      className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setImportResourceSearch("")}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {filteredImportResources.length} 项
                </span>
              </div>
              <div className="max-h-[19rem] space-y-2 overflow-y-auto rounded-md border border-border/60 p-2">
                {filteredImportResources.length > 0 ? filteredImportResources.map((resource: RuleResourceRow) => {
                  const selected = String(resource.id) === importResourceId;
                  return (
                    <button
                      key={resource.id}
                      type="button"
                      title={getTransferResourceLabel(importScopeType, resource)}
                      aria-pressed={selected}
                      onClick={() => setImportResourceId(String(resource.id))}
                      className={`flex w-full min-w-0 items-start gap-3 rounded-md border p-2 text-left transition-colors hover:bg-muted/40 ${
                        selected
                          ? "border-[color-mix(in_srgb,var(--fx-healthy)_50%,transparent)] bg-[color-mix(in_srgb,var(--fx-healthy)_5%,transparent)] shadow-sm"
                          : "border-border/40 bg-background/70"
                      }`}
                    >
                      {selected ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      ) : (
                        <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-border/70 bg-background" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1">{renderTransferResourceOption(importScopeType, resource, { showStatus: true })}</span>
                    </button>
                  );
                }) : (
                  <div className="py-10 text-center text-sm text-muted-foreground">没有可选择的{ruleTransferScopeLabels[importScopeType]}</div>
                )}
              </div>
              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                {selectedImportResource
                  ? `将导入到 ${getTransferResourceLabel(importScopeType, selectedImportResource)}`
                  : `请选择${ruleTransferScopeLabels[importScopeType]}`}
              </div>
            </div>
          </div>
          {importSourceMode === "file" && (
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
              导入会保留文件中的规则配置，并应用到右侧当前选择的目标资源。
            </div>
          )}
          </>
        ) : (
        <>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_3.5rem_minmax(0,0.82fr)] lg:items-start">
          {batchRuleSelectionPanel}

          <div className="hidden lg:flex min-h-full items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-full border border-primary/20 bg-primary/5 p-3 text-primary shadow-sm">
                <ArrowRight className="h-5 w-5" />
              </div>
              <div className="text-center text-[11px] font-medium leading-4 text-muted-foreground">
                {batchFlowHintLabel}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {isBatchGroupMode ? batchGroupPanel : isBatchStateMode ? batchStatePanel : isBatchExportMode ? (
            <div className="space-y-3 rounded-md border border-border/60 bg-background/55 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <Label>导出内容</Label>
                  <div className="text-xs text-muted-foreground">将左侧选中的规则导出为 JSON 文件，便于备份或迁移。</div>
                </div>
                <div className="inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full bg-[var(--fx-path-soft)] px-3 py-1 text-xs font-medium text-[var(--fx-path)]">
                  <span>待导出</span>
                  <span className="rounded-full bg-background/90 px-2 py-0.5 tabular-nums">{selectedBatchRuleCount}</span>
                </div>
              </div>
              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                {selectedBatchRuleCount > 0 ? `将导出 ${selectedBatchRuleCount} 条选中规则` : "请先在左侧选择要导出的规则"}
              </div>
              {copySelectedRules.length > 0 ? (
                <div className="max-h-[19rem] space-y-2 overflow-y-auto rounded-md border border-border/60 p-2">
                  {copySelectedRules.map((rule: RuleCardRule) => {
                    const category = getRuleCategory(rule, forwardGroupById);
                    return (
                      <div key={rule.id} className="rounded-md border border-border/40 bg-background/70 px-3 py-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          {renderRuleGroupIcon(category, "h-3.5 w-3.5")}
                          <span className="min-w-0 truncate text-sm font-medium" data-no-translate="">{rule.name}</span>
                          <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[11px]">{desktopRuleTypeLabels[category]}</Badge>
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          :{formatPortSpan(rule.sourcePort, ruleSourcePortEnd(rule))} -&gt; {rule.targetIp}:{formatRuleTargetPort(rule)} / {forwardTypeDisplayLabel(rule.forwardType)} / {formatForwardRuleProtocol(rule.protocol)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
            ) : isBatchEditMode ? (
            <div className="space-y-3 rounded-md border border-border/60 bg-background/55 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <Label>批量编辑内容</Label>
                  <div className="text-xs text-muted-foreground">
                    入口资源和目标地址可独立替换；未填写的项会保留每条规则原来的值。
                  </div>
                </div>
                <div className="inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full bg-[var(--fx-warn-soft)] px-3 py-1 text-xs font-medium text-[var(--fx-warn-text)]">
                  {hasBatchEditChanges ? "按填写项替换" : "未设置替换项"}
                </div>
              </div>

              <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm">替换入口资源</Label>
                  <span className="text-xs text-muted-foreground">
                    {hasBatchEditRouteSelection ? "已设置新入口" : "保持原入口"}
                  </span>
                </div>
                <FormField className="space-y-2">
                  <Label>入口类型</Label>
                  <Select
                    value={batchEditForm.routeMode}
                    onValueChange={(value) => setBatchEditRouteMode(value as RuleRouteMode)}
                    disabled={copyActionPending}
                  >
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local" disabled={!canUseSavedLocalForward}>端口转发</SelectItem>
                      <SelectItem value="tunnel" disabled={!canUseGost}>隧道转发</SelectItem>
                      <SelectItem value="chain" disabled={!canUseForwardChain}>转发链</SelectItem>
                      <SelectItem value="group" disabled={!canUseFailoverGroup}>转发组</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>

                {batchEditForm.routeMode === "tunnel" ? (
                  <FormField className="space-y-2">
                    <Label>使用隧道</Label>
                    <Select
                      value={batchEditForm.tunnelId ? String(batchEditForm.tunnelId) : "none"}
                      disabled={copyActionPending}
                      onValueChange={(value) => {
                        setBatchEditForm((prev) => ({
                          ...prev,
                          tunnelId: value === "none" ? null : Number(value),
                          forwardGroupId: null,
                          forwardType: "gost",
                        }));
                      }}
                    >
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">不替换入口</SelectItem>
                        {supportedTunnels.map((tunnel: RuleResourceRow) => (
                          <SelectItem key={tunnel.id} value={String(tunnel.id)} textValue={getTunnelSelectText(tunnel)}>
                            {renderTunnelSelectLabel(tunnel)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedBatchEditTunnel && (
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {renderTunnelRoute(selectedBatchEditTunnel, true)}
                        <code className="rounded bg-background/60 px-1.5 py-0.5">:{selectedBatchEditTunnel.listenPort}</code>
                        <span className="rounded bg-background/60 px-1.5 py-0.5">{selectedBatchEditTunnelDisplay.shortLabel}</span>
                      </div>
                    )}
                  </FormField>
                ) : (
                  <FormField className="space-y-2">
                    <Label>{batchEditForm.routeMode === "local" ? "使用端口转发" : batchEditForm.routeMode === "chain" ? "使用转发链" : "使用转发组"}</Label>
                    <Select
                      value={batchEditForm.forwardGroupId ? String(batchEditForm.forwardGroupId) : "none"}
                      disabled={copyActionPending}
                      onValueChange={(value) => {
                        const nextGroupId = value === "none" ? null : Number(value);
                        const group = nextGroupId ? forwardGroupById.get(nextGroupId) : null;
                        setBatchEditForm((prev) => ({
                          ...prev,
                          forwardGroupId: nextGroupId,
                          tunnelId: null,
                          forwardType: getForwardGroupRuleForwardType(group, prev.forwardType),
                        }));
                      }}
                    >
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">不替换入口</SelectItem>
                        {batchEditAvailableGroups.map((group: RuleResourceRow) => (
                          <SelectItem key={group.id} value={String(group.id)} textValue={getForwardGroupSelectText(group)}>
                            {renderForwardGroupSelectLabel(group)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedBatchEditForwardGroup && (
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {(selectedBatchEditForwardGroup.members || []).slice(0, 4).map((member: RuleResourceRow, index: number) => (
                          <span key={member.id} className="rounded bg-background/60 px-1.5 py-0.5">
                            {index + 1}. {getForwardGroupMemberLabel(member)}
                          </span>
                        ))}
                        {(selectedBatchEditForwardGroup.members || []).length > 4 && <span>+{(selectedBatchEditForwardGroup.members || []).length - 4}</span>}
                      </div>
                    )}
                  </FormField>
                )}
              </div>

              <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm">替换目标地址</Label>
                  <span className="text-xs text-muted-foreground">
                    {hasBatchEditTargetIpChange || hasBatchEditTargetPortChange ? "按填写项替换" : "保持原目标"}
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField className="space-y-2">
                    <Label>目标地址</Label>
                    <Input
                      placeholder="留空则保持原目标地址"
                      value={batchEditForm.targetIp}
                      onChange={(event) => setBatchEditForm((prev) => ({ ...prev, targetIp: event.target.value }))}
                      disabled={copyActionPending}
                    />
                  </FormField>
                  <FormField className="space-y-2">
                    <Label>目标端口</Label>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      step={1}
                      placeholder="留空则保持原目标端口"
                      value={batchEditForm.targetPort || ""}
                      onChange={(event) => setBatchEditForm((prev) => ({ ...prev, targetPort: parseInt(event.target.value) || 0 }))}
                      disabled={copyActionPending}
                    />
                  </FormField>
                </div>
              </div>

              <FormField className="space-y-2">
                <Label>端口冲突处理</Label>
                <Select value={copyConflictStrategy} onValueChange={(value) => setCopyConflictStrategy(value as "skip" | "auto" | "error")} disabled={!hasBatchEditRouteSelection}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">跳过冲突规则</SelectItem>
                    <SelectItem value="auto">自动分配新端口</SelectItem>
                    <SelectItem value="error">遇到冲突时报错</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">仅在替换入口资源且原源端口冲突时生效。</p>
              </FormField>
            </div>
            ) : (
            <div className="space-y-3 rounded-md border border-border/60 bg-background/55 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <Label>复制目标</Label>
                  <div className="text-xs text-muted-foreground">可同时选择多个{copyTargetScopeLabel}；搜索仅筛选显示，不会取消已选目标。</div>
                </div>
                <div className="inline-flex items-center gap-2 self-start rounded-full bg-[var(--fx-healthy-soft)] px-3 py-1 text-xs font-medium text-[var(--fx-healthy-text)]">
                  <span>已选目标</span>
                  <span className="rounded-full bg-background/90 px-2 py-0.5 tabular-nums">{selectedBatchTargetCount}</span>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <Select
                  value={copyTargetScopeType}
                  disabled={copyActionPending}
                  onValueChange={(value) => {
                    commitCopyTargetSelection(value as RuleTransferScopeType, []);
                    setCopyTargetSearch("");
                  }}
                >
                  <SelectTrigger aria-label="复制目标类型" className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ruleTransferScopeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={copyTargetSearch}
                    onChange={(event) => setCopyTargetSearch(event.target.value)}
                    placeholder={"查找" + copyTargetScopeLabel}
                    className="h-9 pl-8 pr-8 text-xs"
                    disabled={copyActionPending}
                  />
                  {copyTargetSearch ? (
                    <button
                      type="button"
                      aria-label="清空目标查找"
                      className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setCopyTargetSearch("")}
                      disabled={copyActionPending}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
              <FormField className="space-y-2">
                <Label>端口冲突处理</Label>
                <Select value={copyConflictStrategy} onValueChange={(value) => setCopyConflictStrategy(value as "skip" | "auto" | "error")} disabled={copyActionPending}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">跳过冲突规则</SelectItem>
                    <SelectItem value="auto">自动分配新端口</SelectItem>
                    <SelectItem value="error">遇到冲突时报错</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => {
                    const visibleTargetIds = filteredCopyTargetResources.map((resource: RuleResourceRow) => Number(resource.id));
                    const visibleTargetIdSet = new Set(visibleTargetIds);
                    const current = copyTargetSelectionRef.current;
                    const renderedScopeType = copyTargetScopeType;
                    const currentIds = current.scopeType === renderedScopeType ? current.resourceIds : [];
                    const visibleSelected = visibleTargetIds.length > 0
                      && visibleTargetIds.every((id) => currentIds.includes(id));
                    const nextIds = visibleSelected
                      ? currentIds.filter((id) => !visibleTargetIdSet.has(id))
                      : Array.from(new Set([...currentIds, ...visibleTargetIds]));
                    commitCopyTargetSelection(renderedScopeType, nextIds);
                  }}
                  disabled={filteredCopyTargetResources.length === 0 || copyActionPending}
                >
                  {allVisibleCopyTargetsSelected ? "取消" : "全选"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => commitCopyTargetSelection(copyTargetScopeType, [])}
                  disabled={copyTargetResourceIds.length === 0 || copyActionPending}
                >
                  清空目标
                </Button>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {filteredCopyTargetResources.length} 项
                </span>
              </div>
              <div className="max-h-[19rem] space-y-2 overflow-y-auto rounded-md border border-border/60 p-2">
                {filteredCopyTargetResources.length > 0 ? filteredCopyTargetResources.map((resource: RuleResourceRow) => (
                  <label
                    key={`${copyTargetScopeType}:${resource.id}`}
                    className={`flex cursor-pointer items-start gap-3 rounded-md border p-2 transition-colors hover:bg-muted/40 ${
                      copyTargetResourceIds.includes(Number(resource.id))
                        ? "border-[color-mix(in_srgb,var(--fx-healthy)_50%,transparent)] bg-[color-mix(in_srgb,var(--fx-healthy)_5%,transparent)] shadow-sm"
                        : "border-border/40 bg-background/70"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={copyTargetResourceIds.includes(Number(resource.id))}
                      disabled={copyActionPending}
                      onChange={(event) => toggleCopyTargetResource(Number(resource.id), event.target.checked, copyTargetScopeType)}
                    />
                    <span className="min-w-0 flex-1">{renderTransferResourceOption(copyTargetScopeType, resource, { showStatus: true })}</span>
                  </label>
                )) : (
                  <div className="py-10 text-center text-sm text-muted-foreground">没有可选择的{copyTargetScopeLabel}</div>
                )}
              </div>
              <div className="rounded-md border border-[color-mix(in_srgb,var(--fx-healthy)_20%,transparent)] bg-[color-mix(in_srgb,var(--fx-healthy)_5%,transparent)] px-3 py-2 text-xs leading-5 text-[var(--fx-healthy-text)]">
                {selectedCopyTargetResources.length > 0 ? (
                  <>
                    <span className="font-medium">本次复制目标：</span>
                    <span>
                      {selectedCopyTargetResources.slice(0, 4).map((resource: RuleResourceRow, index: number) => (
                        <span key={`${copyTargetScopeType}-summary-${resource.id}`}>
                          {index > 0 ? "、" : ""}{getTransferResourceLabel(copyTargetScopeType, resource)} (#{Number(resource.id)})
                        </span>
                      ))}
                      {selectedCopyTargetResources.length > 4 ? ` 等 ${selectedCopyTargetResources.length} 个目标` : ""}
                    </span>
                  </>
                ) : (
                  <span>尚未选择复制目标</span>
                )}
              </div>
            </div>
            )}
          </div>
        </div>
        <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
          {isBatchGroupMode
            ? "调整分组只改你自己的分组归属，不会重启、停用或修改任何转发规则。"
            : isBatchStateMode
            ? "启用、暂停、重启逐条走和单条操作一样的权限检查，在服务端后台执行；任务只保存在面板内存中，面板重启后进度不保留。"
            : isBatchExportMode
            ? "批量导出会按左侧当前选中的规则生成 JSON 文件，不会受右侧资源范围限制。"
            : isBatchEditMode
            ? "批量编辑会按你实际填写的项逐条覆盖：入口资源未选择则保留原入口，目标地址或端口留空则保留原目标值。"
            : "复制会保留原规则基础配置，并按当前选择的目标资源生成副本。"}
        </div>
        </>
        )}
      </div>
      <DialogFooter className="gap-2 sm:justify-between">
        {isBatchImportMode ? (
          <>
            <div />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setShowCopyDialog(false)} disabled={importingRules}>取消</Button>
              <Button type="button" onClick={handleImportRules} disabled={!importValidation.ok || importingRules}>
                {importingRules && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                导入规则
              </Button>
            </div>
          </>
        ) : isBatchGroupMode ? (
          <>
            <div />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setShowCopyDialog(false)} disabled={copyActionPending}>取消</Button>
              <Button type="button" onClick={handleBatchGroupRules} disabled={selectedBatchRuleCount === 0 || batchGroupTargetIds.length === 0 || copyActionPending}>
                {copyActionPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Folder className="mr-2 h-4 w-4" />}
                {`${batchGroupMode === "add" ? "加入分组" : "移出分组"}（${selectedBatchRuleCount} 条）`}
              </Button>
            </div>
          </>
        ) : isBatchStateMode ? (
          <>
            <div className="text-xs text-muted-foreground sm:max-w-[16rem]">重启会按当前配置重新下发，已暂停的保持暂停。</div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setShowCopyDialog(false)} disabled={copyActionPending}>取消</Button>
              <Button type="button" variant="outline" onClick={() => { void handleBatchStateRules("pause"); }} disabled={selectedBatchRuleCount === 0 || copyActionPending}>
                <Pause className="mr-2 h-4 w-4" />暂停所选
              </Button>
              <Button type="button" variant="outline" onClick={() => { void handleBatchStateRules("restart"); }} disabled={selectedBatchRuleCount === 0 || copyActionPending}>
                <RotateCw className="mr-2 h-4 w-4" />重启所选
              </Button>
              <Button type="button" onClick={() => { void handleBatchStateRules("enable"); }} disabled={selectedBatchRuleCount === 0 || copyActionPending}>
                {copyActionPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}启用所选（{selectedBatchRuleCount} 条）
              </Button>
            </div>
          </>
        ) : isBatchExportMode ? (
          <>
            <div />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setShowCopyDialog(false)}>取消</Button>
              <Button type="button" onClick={handleBatchExportRules} disabled={selectedBatchRuleCount === 0 || copyActionPending}>
                <Download className="mr-2 h-4 w-4" />
                导出规则
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="destructive" onClick={handleBatchDeleteRules} disabled={selectedBatchRuleCount === 0 || copyActionPending}>
                {copyWorking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                删除所选
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setShowCopyDialog(false)} disabled={copyActionPending}>取消</Button>
              <Button
                type="button"
                variant={isBatchEditMode ? "default" : "outline"}
                onClick={isBatchEditMode ? handleBatchEditRules : handleCopyRules}
                disabled={isBatchEditMode ? batchEditDisabled : batchCopyDisabled}
              >
                {copyActionPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : isBatchEditMode ? <Pencil className="mr-2 h-4 w-4" /> : <ClipboardCopy className="mr-2 h-4 w-4" />}
                {isBatchEditMode ? "应用批量编辑" : "复制所选规则"}
              </Button>
            </div>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  </Dialog>
  );
}
