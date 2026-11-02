import { Check, ChevronDown } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/useMobile";
import { useUiTheme } from "@/hooks/useUiTheme";
import { cn } from "@/lib/utils";

/*
  链路管理的分类条（2.3.506）：常用的几个摆在条上，其余收进最后一格「更多」。

  原来九个页签排一行，手机 390px 上要左右滑，新用户也不知道该先看哪个。现在条上只留三个最常用的
  （隧道链路、端口转发、线路概览），转发链、各种组、叠加、节点池在「更多」里分组列出 —— 页签本身、
  ?tab= 的值、每一页的内容都没变，只是换了个地方放。选中「更多」里的一项时，那一格写的是它的名字，
  一眼看得出现在在哪一页。

  墨金主题的手机上分类条本来就折成一个下拉（sliding-tabs 的 FoldedTabsList），那里照旧整列都给。
*/

export type LinkSectionGroup<T extends string> = { label: string; values: readonly T[] };

export function splitLinkSections<T extends string>(items: readonly SlidingTabItem<T>[], primary: readonly T[]) {
  return {
    primary: items.filter((item) => primary.includes(item.value)),
    more: items.filter((item) => !primary.includes(item.value)),
  };
}

export function LinkSectionTabs<T extends string>({
  items,
  primary,
  groups,
  activeValue,
  onValueChange,
  ariaLabel,
}: {
  /** 全部页签，按原来的先后。 */
  items: readonly SlidingTabItem<T>[];
  /** 摆在条上的那几个。 */
  primary: readonly T[];
  /** 「更多」里怎么分组；没列进任何一组的放在最后。 */
  groups?: readonly LinkSectionGroup<T>[];
  activeValue: T;
  onValueChange: (value: T) => void;
  ariaLabel: string;
}) {
  const isMobile = useIsMobile();
  const uiTheme = useUiTheme();
  if (isMobile && uiTheme === "gilt") return <SlidingTabsList items={items} activeValue={activeValue} ariaLabel={ariaLabel} />;
  return <LinkSectionTabsBar items={items} primary={primary} groups={groups} activeValue={activeValue} onValueChange={onValueChange} ariaLabel={ariaLabel} />;
}

/** 分类条本身（拆出来是为了在 node 里直接渲染测试，不经过主题和屏宽的 hook）。 */
export function LinkSectionTabsBar<T extends string>({
  items,
  primary,
  groups = [],
  activeValue,
  onValueChange,
  ariaLabel,
}: {
  items: readonly SlidingTabItem<T>[];
  primary: readonly T[];
  groups?: readonly LinkSectionGroup<T>[];
  activeValue: T;
  onValueChange: (value: T) => void;
  ariaLabel: string;
}) {
  const split = splitLinkSections(items, primary);
  const activeMore = split.more.find((item) => item.value === activeValue) || null;
  const grouped = groups.map((group) => ({ label: group.label, items: split.more.filter((item) => group.values.includes(item.value)) })).filter((group) => group.items.length > 0);
  const rest = split.more.filter((item) => !groups.some((group) => group.values.includes(item.value)));
  if (rest.length > 0) grouped.push({ label: "", items: rest });
  const ActiveMoreIcon = activeMore?.icon;
  return (
    <div className="workspace-tabs relative min-w-0" data-testid="link-section-tabs">
      <div className="workspace-tabs-viewport">
        <TabsList aria-label={ariaLabel} className="workspace-tabs-list">
          {split.primary.map((item) => {
            const Icon = item.icon;
            return (
              <TabsTrigger key={item.value} value={item.value} disabled={item.disabled} data-active={item.value === activeValue ? "true" : undefined} className="workspace-tab group">
                {Icon && <Icon className="h-4 w-4 shrink-0" />}
                {item.label}
                {item.badge !== undefined && item.badge !== null && <span className="workspace-tab-count">{item.badge}</span>}
              </TabsTrigger>
            );
          })}
          {split.more.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="workspace-tab group inline-flex items-center justify-center whitespace-nowrap"
                  // 选中的是「更多」里的一页时，这一格就是选中态（样式跟着 workspace.css 的 data-state=active 走）
                  data-state={activeMore ? "active" : "inactive"}
                  data-active={activeMore ? "true" : undefined}
                  aria-label={activeMore ? `${ariaLabel}：${activeMore.label}，更多分类` : "更多分类"}
                  data-testid="link-section-more"
                >
                  {ActiveMoreIcon ? <ActiveMoreIcon className="h-4 w-4 shrink-0" /> : null}
                  {activeMore ? activeMore.label : "更多"}
                  {/* 包一层：手机上 workspace.css 把分类条里直接挂着的图标藏掉，箭头要留着 */}
                  <span aria-hidden="true" className="inline-flex"><ChevronDown className="h-3.5 w-3.5 opacity-70" /></span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {grouped.map((group, index) => (
                  <div key={group.label || `rest-${index}`}>
                    {index > 0 ? <DropdownMenuSeparator /> : null}
                    {group.label ? <DropdownMenuLabel className="text-[11.5px] font-normal text-muted-foreground">{group.label}</DropdownMenuLabel> : null}
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const selected = item.value === activeValue;
                      return (
                        <DropdownMenuItem key={item.value} disabled={item.disabled} onSelect={() => onValueChange(item.value)} data-testid={`link-section-more-${item.value}`}>
                          {Icon ? <Icon className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
                          <span className={cn("min-w-0 flex-1 truncate", selected && "font-semibold")}>{item.label}</span>
                          {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
                        </DropdownMenuItem>
                      );
                    })}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </TabsList>
      </div>
    </div>
  );
}
