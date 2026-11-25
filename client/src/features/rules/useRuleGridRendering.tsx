/*
  从 client/src/pages/Rules.tsx 第 5124-5198 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { ruleTypeDescriptions, type RuleCardRule, type RuleCardSize, type RuleCategory, type RuleDisplayMode, type RuleGroupType, type RuleViewMode } from "../../pages/Rules";
import { IconTile, type IconTileTone } from "@/components/entity/IconTile";
import { Badge } from "@/components/ui/badge";
import { ArrowRightLeft, ChevronRight, GitBranch, Layers3, Network } from "lucide-react";
import { type ReactElement } from "react";

export type UseRuleGridRenderingContext = {
  uiTheme: string;
  effectiveRuleCardSize: RuleCardSize;
  effectiveViewMode: RuleViewMode;
  displayMode: RuleDisplayMode;
  ruleCategory: RuleCategory;
  ruleGroupCollapsed: Partial<Record<"local" | "tunnel" | "chain" | "group", boolean>>;
  toggleRuleGroupCollapsed: (type: RuleGroupType) => void;
};

export type UseRuleGridRenderingResult = {
  groupedRuleMobileGridClass: string;
  groupedRuleCardGridClass: string;
  sortableRuleMobileGridClass: string;
  sortableRuleCardGridClass: string;
  denseRuleRows: boolean;
  ruleContentTransitionKey: string;
  renderRuleGroupHeader: (group: { type: RuleGroupType; label: string; rules: RuleCardRule[]; }, compact?: boolean) => ReactElement;
  groupedRuleMobileSectionsClass: string;
  renderRuleGroupIcon: (type: RuleGroupType, className?: string) => ReactElement;
};

export function useRuleGridRendering(ctx: UseRuleGridRenderingContext): UseRuleGridRenderingResult {
  const { uiTheme, effectiveRuleCardSize, effectiveViewMode, displayMode, ruleCategory, ruleGroupCollapsed, toggleRuleGroupCollapsed } = ctx;
  const denseRuleRows = uiTheme === "deepspace";
  const groupedRuleCardGridClass = denseRuleRows ? "fx-ds-rule-list" : effectiveRuleCardSize === "compact"
    ? "standard-card-grid-compact rule-card-grid-static rule-card-grid-static-compact gap-3"
    : "standard-card-grid rule-card-grid-static rule-card-grid-static-standard gap-4";
  const sortableRuleCardGridClass = denseRuleRows ? "fx-ds-rule-list" : effectiveRuleCardSize === "compact"
    ? "standard-card-grid-compact gap-3"
    : "standard-card-grid gap-4";
  /*
    手机上卡片已经没有边框和底色了，「这几行是一条规则」全靠间距说话。
    实测过一版反的：两条规则之间 12px，而一条规则内部 22～30px —— 内紧外松
    做反了，眼睛按接近性分组，于是十二条规则糊成一片。
    这里把组间距放到 gap-0（由卡片自己的上下内边距 14px 撑开，等于组间 28px），
    组内间距在 CSS 里收到 5px。
  */
  const groupedRuleMobileGridClass = denseRuleRows ? "fx-ds-rule-list" : effectiveRuleCardSize === "compact"
    ? "grid rule-card-grid-static rule-card-grid-static-compact gap-0"
    : "grid rule-card-grid-static rule-card-grid-static-standard gap-3";
  const groupedRuleMobileSectionsClass = denseRuleRows ? "grid gap-4" : groupedRuleMobileGridClass;
  const sortableRuleMobileGridClass = denseRuleRows ? "fx-ds-rule-list" : effectiveRuleCardSize === "compact"
    ? "grid gap-0"
    : "grid gap-3";
  const ruleContentModeKey = effectiveViewMode === "card" ? "card" : displayMode;
  // 只按分类 / 视图切换做进出场；加载中 → 列表 → 空这种状态变化就地换内容，不再先退场再进场（那是 200ms 的空白）
  const ruleContentTransitionKey = `${ruleCategory}-${ruleContentModeKey}`;

  /*
    分组图标一律中性。

    以前四类各刷一个颜色：转发链琥珀、转发组绿、隧道红、端口转发品牌色 ——
    而这四个颜色在面板里分别是「降级」「正常」「故障」和「主操作」。于是一个
    转发链分组的标题看着像在报警，一个转发组的标题看着像在说「一切正常」。

    类型该由图标形状和旁边的文字说，颜色只留给状态。
  */
  /*
    卡头和分组标题上的小图标格：四类各一个颜色 —— 端口转发天蓝（主色）、隧道紫、转发链青、
    转发组橙。这是身份不是状态：卡片出了事由状态点说，格子不变色。
  */
  const RULE_TILE: Record<RuleGroupType, { icon: typeof ArrowRightLeft; tone: IconTileTone }> = {
    local: { icon: ArrowRightLeft, tone: "sky" },
    tunnel: { icon: Network, tone: "violet" },
    chain: { icon: GitBranch, tone: "teal" },
    group: { icon: Layers3, tone: "orange" },
  };
  const renderRuleTile = (type: RuleGroupType, size: "xs" | "sm" | "md" = "md") => {
    const spec = RULE_TILE[type] || RULE_TILE.local;
    return <IconTile icon={spec.icon} tone={spec.tone} size={size} />;
  };

  function renderRuleGroupIcon(type: RuleGroupType, className = "h-4 w-4") {
    const tone = `${className} text-muted-foreground`;
    if (type === "chain") return <GitBranch className={tone} />;
    if (type === "group") return <Layers3 className={tone} />;
    if (type === "tunnel") return <Network className={tone} />;
    return <ArrowRightLeft className={tone} />;
  }

  const renderRuleGroupHeader = (group: { type: RuleGroupType; label: string; rules: RuleCardRule[] }, compact = false) => {
    const collapsed = !!ruleGroupCollapsed[group.type];
    return (
      <button
        type="button"
        aria-expanded={!collapsed}
        className="fx-rule-group-header flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => toggleRuleGroupCollapsed(group.type)}
      >
        {/* 一枚这类规则的小图标格、名字、个数、一句说明；折叠箭头在最右边（iOS 的展开样式） */}
        {renderRuleTile(group.type, "xs")}
        <span className="truncate text-[15px] font-medium">{group.label}</span>
        <Badge variant="outline" className="h-5 min-w-5 shrink-0 justify-center rounded-full px-1.5 text-[11px] font-normal text-muted-foreground">{group.rules.length}</Badge>
        {!compact && <span data-fx-help="" className="min-w-0 truncate text-xs text-muted-foreground">{ruleTypeDescriptions[group.type]}</span>}
        <ChevronRight className={`ml-auto h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 ${collapsed ? "" : "rotate-90"}`} />
      </button>
    );
  };
  return { groupedRuleMobileGridClass, groupedRuleCardGridClass, sortableRuleMobileGridClass, sortableRuleCardGridClass, denseRuleRows, ruleContentTransitionKey, renderRuleGroupHeader, groupedRuleMobileSectionsClass, renderRuleGroupIcon };
}
