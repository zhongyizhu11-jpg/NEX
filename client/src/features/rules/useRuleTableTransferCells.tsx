/*
  从 client/src/pages/Rules.tsx 第 6062-6145 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { getForwardGroupRuleForwardType, normalizeRuleForwardType } from "../../pages/Rules";
import { Badge } from "@/components/ui/badge";
import { ArrowRightLeft, Copy, Network, Shield, Zap } from "lucide-react";

export type UseRuleTableTransferCellsContext = {
  getRuleTransferDisplay: (rule: any) => { entryAddresses: Array<{ text: string; copyable: boolean; label: string; value: any; }>; entryAddress: string; targetAddress: string; entryTitle: string; failoverCount: number; failoverEnabled: boolean; routeLabel: string; };
  copyEntryAddress: (rule: any, entryValue?: string) => Promise<void>;
  copyTargetAddress: (text: string) => Promise<void>;
  forwardTypeDisplayLabel: (forwardType: unknown) => string;
};

export type UseRuleTableTransferCellsResult = {
  renderForwardToolBadge: any /* 原类型 (rule: any, group?: any | null) => JSX.Element… 引用了拿不到的 JSX，手动收拾 */;
  renderTableTransferEntry: any /* 原类型 (rule: any) => JSX.Element… 引用了拿不到的 JSX，手动收拾 */;
  renderTableTransferExit: any /* 原类型 (rule: any) => JSX.Element… 引用了拿不到的 JSX，手动收拾 */;
};

export function useRuleTableTransferCells(ctx: UseRuleTableTransferCellsContext): UseRuleTableTransferCellsResult {
  const { getRuleTransferDisplay, copyEntryAddress, copyTargetAddress, forwardTypeDisplayLabel } = ctx;
  const renderTableTransferEntry = (rule: any) => {
    const { entryAddresses, entryTitle } = getRuleTransferDisplay(rule);
    // 表里的地址是等宽的裸文字（参考站的模型名那一列），不再套小框；能复制的悬停时才显出底。
    // 精简的表里地址画成药丸、写全不截（用户定的：规则信息要全）；列宽让给入口，太长的域名在药丸里换行（compact.css）。
    return (
      <div className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-[12px] leading-5">
        {entryAddresses.map((entry) => (
          <button
            key={`${entry.label}:${entry.value}`}
            type="button"
            onClick={() => entry.copyable && copyEntryAddress(rule, entry.value)}
            disabled={!entry.copyable}
            className="group inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded-inner px-1 py-0.5 -mx-1 text-left transition-colors enabled:hover:bg-[var(--fx-l2-group)] disabled:cursor-default disabled:text-muted-foreground"
            title={entry.copyable ? `${entryTitle}${entryAddresses.length > 1 ? ` (${entry.label})` : ""}` : entry.text}
          >
            {entryAddresses.length > 1 && <span className="shrink-0 text-[11px] text-muted-foreground">{entry.label}</span>}
            <code className="fx-table-addr min-w-0 truncate">{entry.text}</code>
            {entry.copyable && <Copy className="h-3 w-3 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />}
          </button>
        ))}
      </div>
    );
  };

  const renderTableTransferExit = (rule: any) => {
    const { targetAddress, failoverCount, failoverEnabled, routeLabel } = getRuleTransferDisplay(rule);
    // 出口和入口一样点一下就复制（用户要的）：表里原来只有入口能复制
    return (
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] leading-5">
        <button
          type="button"
          onClick={() => copyTargetAddress(targetAddress)}
          className="group inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded-inner px-1 py-0.5 -mx-1 text-left transition-colors hover:bg-[var(--fx-l2-group)]"
          title={`复制目标地址: ${targetAddress}`}
        >
          <code className="fx-table-addr min-w-0 truncate">{targetAddress}</code>
          <Copy className="h-3 w-3 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
        </button>
        {failoverEnabled && (
          <Badge variant="outline" className="h-5 shrink-0 border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] px-1.5 text-[11px] text-[var(--fx-warn-text)]">
            {routeLabel} {failoverCount} 条
          </Badge>
        )}
      </div>
    );
  };

  /*
    转发工具的标签回答的是「它是哪一种」，不是「它好不好」，所以走分类色，不碰状态色：
    原来 socat 是红、gost 是琥珀 —— 一枚红标签在一列灰字里看着像出错了。
    内核转发（iptables / nftables）用强调色，和「路径」同一个色；其余三个各一个分类色。
  */
  const forwardToolBadgeClass = (forwardType: unknown) => {
    const type = String(forwardType || "");
    if (type === "iptables" || type === "nftables") return "border-[color-mix(in_srgb,var(--fx-accent)_30%,transparent)] bg-[var(--fx-accent-soft)] text-[var(--fx-accent)]";
    if (type === "socat") return "border-[color-mix(in_srgb,var(--fx-cat-orange)_30%,transparent)] bg-[var(--fx-cat-orange-soft)] text-[var(--fx-cat-orange)]";
    if (type === "gost") return "border-[color-mix(in_srgb,var(--fx-cat-teal)_30%,transparent)] bg-[var(--fx-cat-teal-soft)] text-[var(--fx-cat-teal)]";
    return "border-[color-mix(in_srgb,var(--fx-cat-indigo)_30%,transparent)] bg-[var(--fx-cat-indigo-soft)] text-[var(--fx-cat-indigo)]";
  };

  const renderForwardToolBadge = (rule: any, group?: any | null) => {
    const forwardType = group
      ? getForwardGroupRuleForwardType(group, rule.forwardType)
      : normalizeRuleForwardType(rule.forwardType);
    const label = forwardTypeDisplayLabel(forwardType);
    return (
      <Badge
        variant="outline"
        className={`w-fit whitespace-nowrap text-[11px] ${forwardToolBadgeClass(forwardType)}`}
        title={`转发工具：${label}`}
      >
        {forwardType === "iptables" || forwardType === "nftables" ? (
          <Shield className="mr-1 h-3 w-3" />
        ) : forwardType === "socat" ? (
          <ArrowRightLeft className="mr-1 h-3 w-3" />
        ) : forwardType === "gost" ? (
          <Network className="mr-1 h-3 w-3" />
        ) : (
          <Zap className="mr-1 h-3 w-3" />
        )}
        {label}
      </Badge>
    );
  };
  return { renderForwardToolBadge, renderTableTransferEntry, renderTableTransferExit };
}
