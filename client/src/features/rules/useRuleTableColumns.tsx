/*
  从 client/src/pages/Rules.tsx 第 5208-5396 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { RULE_TABLE_MIN_WIDTH_RATIO, desktopRuleTypeLabels, entryBridgeNotes, getRuleCategory, getRuleDisplayType, revokedResourceTitle, type RuleCardRule, type RulePageUser, type RuleResourceRow, unsupportedProtocolTitle } from "../../pages/Rules";
import { StatusDot } from "@/components/network/StatusDot";
import { RulePersonalGroupBadges } from "@/components/rules/PersonalRuleGroups";
import { RuleLimitSummary } from "@/components/rules/RuleLimitSummary";
import { Badge } from "@/components/ui/badge";
import { resolveForwardRuleStopReason } from "@/lib/forwardRuleStatus";
import { cn } from "@/lib/utils";
import { formatBytes } from "@shared/formatBytes";
import { formatForwardRuleProtocol, isUserspaceForwardType, type ForwardProtocolKey } from "@shared/forwardTypes";
import { ruleLatencyProbeMethodForRule } from "@shared/latencyProbe";
import { type PersonalRuleGroup } from "@shared/ruleGroups";
import type { ResolvedTableColumn } from "@shared/uiPreferences";
import { ChevronDown } from "lucide-react";
import { type Dispatch, type ReactElement, type ReactNode, type SetStateAction } from "react";
import type { UseRuleSourceBadgesResult } from "./useRuleSourceBadges";
import type { UseRuleStateBadgesResult } from "./useRuleStateBadges";
import type { UseRuleTableTransferCellsResult } from "./useRuleTableTransferCells";
import type { UseRuleTrafficCellsResult } from "./useRuleTrafficCells";

export type UseRuleTableColumnsContext = {
  compactLayout: boolean;
  isRuleSupported: (rule: RuleCardRule) => boolean;
  getRuleProtocolKey: (rule: RuleCardRule) => ForwardProtocolKey | null;
  user: RulePageUser;
  getRuleOwnerName: (rule: RuleCardRule) => string;
  renderStatusDot: (rule: RuleCardRule) => ReactElement;
  forwardGroupById: Map<number, RuleResourceRow>;
  renderNotRunningReason: UseRuleStateBadgesResult["renderNotRunningReason"];
  protocolUnsupportedLabel: (protocolKey: ForwardProtocolKey | null | undefined) => string;
  renderAdminManagedBadge: UseRuleStateBadgesResult["renderAdminManagedBadge"];
  personalGroupSortActive: boolean;
  toggleRuleSortByGroup: () => void;
  personalGroups: Array<PersonalRuleGroup>;
  getRuleResourceName: (rule: RuleCardRule) => string;
  renderRouteBadge: (rule: RuleCardRule, compactRow?: boolean, hideRoute?: boolean) => ReactElement;
  renderFailoverLineBadge: UseRuleSourceBadgesResult["renderFailoverLineBadge"];
  renderTableTransferEntry: UseRuleTableTransferCellsResult["renderTableTransferEntry"];
  renderTableTransferExit: UseRuleTableTransferCellsResult["renderTableTransferExit"];
  totalTrafficByRule: Map<number, { bytesIn: number; bytesOut: number; connections: number; }>;
  dailyTrafficByRule: Map<number, { bytesIn: number; bytesOut: number; }>;
  setSelfTestRule: Dispatch<SetStateAction<{ id: number; name: string; isForwardChain?: boolean; chainKernel?: boolean; probeMethod?: "tcping" | "ping"; tab?: string; } | null>>;
  renderTableRuleDailyTraffic: UseRuleTrafficCellsResult["renderTableRuleDailyTraffic"];
  renderTableRuleTotalTraffic: UseRuleTrafficCellsResult["renderTableRuleTotalTraffic"];
  renderTableRuleLatency: UseRuleTrafficCellsResult["renderTableRuleLatency"];
  renderRuleEnabledSwitch: (rule: RuleCardRule) => ReactElement;
  renderRuleActions: (rule: RuleCardRule, menuOnly?: boolean, tableCompact?: boolean) => ReactElement;
  ruleColumnSettings: { columns: Array<ResolvedTableColumn>; visibleColumns: Array<ResolvedTableColumn>; labels: Map<string, string>; saving: boolean; isDefault: boolean; toggle: (key: string, visible: boolean) => void; move: (key: string, delta: -1 | 1) => void; resizeLive: (key: string, width: number) => void; commitWidth: (key: string, width: number | null) => void; reset: () => void; };
  ruleSortingEnabled: boolean;
};

export type RuleTableColumn = {
  key: string;
  width: number;
  head: ReactNode;
  headClassName?: string;
  cellClassName?: string;
  cell: (rule: RuleCardRule) => ReactNode;
};

export type UseRuleTableColumnsResult = {
  shownRuleTableColumns: Array<RuleTableColumn & { resolved: ResolvedTableColumn; }>;
  ruleTableMinWidth: number;
  ruleTableColumnCount: number;
};

export function useRuleTableColumns(ctx: UseRuleTableColumnsContext): UseRuleTableColumnsResult {
  const { compactLayout, isRuleSupported, getRuleProtocolKey, user, getRuleOwnerName, renderStatusDot, forwardGroupById, renderNotRunningReason, protocolUnsupportedLabel, renderAdminManagedBadge, personalGroupSortActive, toggleRuleSortByGroup, personalGroups, getRuleResourceName, renderRouteBadge, renderFailoverLineBadge, renderTableTransferEntry, renderTableTransferExit, totalTrafficByRule, dailyTrafficByRule, setSelfTestRule, renderTableRuleDailyTraffic, renderTableRuleTotalTraffic, renderTableRuleLatency, renderRuleEnabledSwitch, renderRuleActions, ruleColumnSettings, ruleSortingEnabled } = ctx;
  const ruleTableColumns: RuleTableColumn[] = [
    {
      key: "rule",
      width: compactLayout ? 170 : 200,
      head: "规则",
      cell: (rule) => {
        const supported = isRuleSupported(rule);
        const protocolKey = getRuleProtocolKey(rule);
        const owner = user?.role === "admin" ? getRuleOwnerName(rule) : "";
        const subtitle = [formatForwardRuleProtocol(rule.protocol), owner].filter(Boolean).join(" · ");
        return (
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-[3px] shrink-0">
              {supported ? renderStatusDot(rule) : <StatusDot health="down" size="large" label={unsupportedProtocolTitle} />}
            </span>
            <div className="min-w-0 flex-1">
              <span className="block truncate font-medium" title={rule.name} data-no-translate="">{rule.name}</span>
              {compactLayout ? (
                /* 精简的表：协议自己一列，名字下面挂类型标签（端口转发 / 隧道转发 / 转发链 / 转发组）和所属人 */
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[11px] font-normal">{desktopRuleTypeLabels[getRuleDisplayType(rule, forwardGroupById)]}</Badge>
                  {owner ? <span className="truncate text-[11px] leading-4 text-muted-foreground" title={owner}>{owner}</span> : null}
                </span>
              ) : (
                <span className="block truncate text-[11px] leading-4 text-muted-foreground" title={subtitle}>{subtitle}</span>
              )}
              {supported ? renderNotRunningReason(rule) : null}
              {!supported && (
                <span className="mt-1 block text-[11px] text-destructive">
                  {protocolUnsupportedLabel(protocolKey)} 当前不支持
                </span>
              )}
              {(rule.protocolBlockReason || rule.resourceAccessAllowed === false) && (
                <span className="mt-1 block text-[11px] leading-4 text-destructive">
                  {rule.protocolBlockReason || revokedResourceTitle}
                </span>
              )}
              {renderAdminManagedBadge(rule) ? <div className="mt-1">{renderAdminManagedBadge(rule)}</div> : null}
              <div className="fx-table-row-limits"><RuleLimitSummary rule={rule} /></div>
              {(() => {
                const stop = !rule.protocolBlockReason && rule.resourceAccessAllowed !== false ? resolveForwardRuleStopReason(rule) : null;
                return stop?.autoResume ? (
                  <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{stop.detail}</span>
                ) : null;
              })()}
              {entryBridgeNotes(rule).map((note) => (
                <span key={note} className="mt-1 block text-[11px] leading-4 text-muted-foreground">{note}</span>
              ))}
            </div>
          </div>
        );
      },
    },
    /*
      分组列（上游 2.3.287）：最多画两个，多的写「+N」；表头点一下按分组排序（未分组排最后），再点一下回到原来的顺序。
      ··· 菜单、「列设置」里都能把这一列关掉（显不显示由 ruleColumnSettings 定，这里总是定义着）。
    */
    {
      key: "personalGroups",
      width: compactLayout ? 120 : 140,
      head: (
        <button
          type="button"
          className={cn("inline-flex items-center gap-1 hover:text-foreground", personalGroupSortActive && "text-foreground")}
          onClick={toggleRuleSortByGroup}
          title={personalGroupSortActive ? "按分组排序中（未分组在最后），点一下恢复默认顺序" : "按分组排序（未分组在最后）"}
          aria-pressed={personalGroupSortActive}
        >
          分组{personalGroupSortActive ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : null}
        </button>
      ),
      cellClassName: "overflow-hidden",
      cell: (rule) => <RulePersonalGroupBadges groupIds={rule.personalGroupIds} groups={personalGroups} emptyPlaceholder />,
    },
    {
      key: "resource",
      width: compactLayout ? 110 : 150,
      head: "所属资源",
      cell: (rule) => (
        <div className="min-w-0">
          <span className="block truncate text-sm text-muted-foreground" title={getRuleResourceName(rule)}>
            {getRuleResourceName(rule)}
          </span>
          {/* 主备那一小块跟着线路走：它说的是「现在走哪条」，点进去是策略。 */}
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
            {renderRouteBadge(rule, true)}
            {renderFailoverLineBadge(rule)}
          </div>
        </div>
      ),
    },
    { key: "entry", width: compactLayout ? 200 : 150, head: "转发入口", cell: (rule) => renderTableTransferEntry(rule) },
    { key: "exit", width: compactLayout ? 160 : 130, head: "转发出口", cell: (rule) => renderTableTransferExit(rule) },
    /*
      精简的表（用户 2026-10-21 照着老版本表格样稿定的「条状」）：协议一列、累计一列（24H 做小字），
      开关并进「操作」列和「编辑 / ···」排一起。标准照旧：累计 / 24H 合成「流量」，开关自己一列。
    */
    ...(compactLayout ? [
      {
        key: "protocol",
        width: 70,
        head: "协议",
        headClassName: "text-center",
        cellClassName: "text-center",
        cell: (rule: RuleCardRule) => <Badge variant="secondary" className="whitespace-nowrap text-[11px] font-normal">{formatForwardRuleProtocol(rule.protocol)}</Badge>,
      },
      {
        key: "total",
        width: 100,
        head: "累计",
        cellClassName: "overflow-hidden",
        cell: (rule: RuleCardRule) => {
          const t = totalTrafficByRule.get(rule.id);
          const total = t ? Number(t.bytesIn || 0) + Number(t.bytesOut || 0) : null;
          const isForwardChainRule = getRuleCategory(rule, forwardGroupById) === "chain";
          const daily = dailyTrafficByRule.get(rule.id);
          // 24H 两个方向都是零就不画那一行小字（两个「—」只是噪音）
          const hasDaily = !!daily && (Number(daily.bytesIn || 0) > 0 || Number(daily.bytesOut || 0) > 0);
          return (
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums">
                <span className="font-medium text-foreground" title={t ? `累计入向 ${formatBytes(t.bytesIn)} / 出向 ${formatBytes(t.bytesOut)}` : "还没有流量"}>
                  {total === null ? "—" : formatBytes(total)}
                </span>
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                  onClick={() => setSelfTestRule({ id: rule.id, name: rule.name, isForwardChain: isForwardChainRule, chainKernel: !isUserspaceForwardType(rule.forwardType), probeMethod: ruleLatencyProbeMethodForRule(rule), tab: "history" })}
                >
                  详细
                </button>
              </span>
              {hasDaily ? <div className="fx-table-daily">{renderTableRuleDailyTraffic(rule)}</div> : null}
            </div>
          );
        },
      },
    ] satisfies RuleTableColumn[] : [
      {
        key: "traffic",
        width: 110,
        head: "流量",
        cellClassName: "overflow-hidden",
        cell: (rule: RuleCardRule) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            {renderTableRuleTotalTraffic(rule)}
            {renderTableRuleDailyTraffic(rule)}
          </div>
        ),
      },
    ] satisfies RuleTableColumn[]),
    { key: "latency", width: compactLayout ? 80 : 84, head: "延迟", cellClassName: "overflow-hidden", cell: (rule) => renderTableRuleLatency(rule) },
    ...(compactLayout ? [] : [{
      key: "enabled",
      width: 52,
      head: "开关",
      headClassName: "text-center",
      cell: (rule: RuleCardRule) => <div className="flex justify-center">{renderRuleEnabledSwitch(rule)}</div>,
    } satisfies RuleTableColumn]),
    {
      key: "actions",
      width: compactLayout ? 150 : 140,
      head: "操作",
      headClassName: "text-right",
      cellClassName: "text-right",
      cell: (rule) => compactLayout ? (
        <div className="flex items-center justify-end gap-2">
          {renderRuleEnabledSwitch(rule)}
          {renderRuleActions(rule, false, true)}
        </div>
      ) : renderRuleActions(rule),
    },
  ];
  /* 真正画出来的列：按列设置的顺序、只要显示的那些，拖过的列宽盖掉默认宽度 */
  const ruleTableColumnByKey = new Map(ruleTableColumns.map((column) => [column.key, column]));
  const shownRuleTableColumns: (RuleTableColumn & { resolved: ResolvedTableColumn })[] = ruleColumnSettings.visibleColumns.flatMap((resolved) => {
    const column = ruleTableColumnByKey.get(resolved.key);
    return column ? [{ ...column, width: resolved.width ?? column.width, resolved }] : [];
  });
  const ruleTableColumnCount = shownRuleTableColumns.length + (ruleSortingEnabled ? 1 : 0);
  const ruleTableMinWidth = Math.round(shownRuleTableColumns.reduce((sum, column) => sum + column.width, ruleSortingEnabled ? 44 : 0) * RULE_TABLE_MIN_WIDTH_RATIO);
  return { shownRuleTableColumns, ruleTableMinWidth, ruleTableColumnCount };
}
