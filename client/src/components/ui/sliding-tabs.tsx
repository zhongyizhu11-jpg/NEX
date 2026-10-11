import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/useMobile";
import { useUiTheme } from "@/hooks/useUiTheme";
import { cn } from "@/lib/utils";

export type SlidingTabItem<T extends string = string> = {
  value: T; label: string;
  icon?: ComponentType<{ className?: string }>;
  badge?: ReactNode; disabled?: boolean;
};
type SlidingTabsListProps<T extends string> = {
  items: readonly SlidingTabItem<T>[]; activeValue: T; ariaLabel?: string;
  className?: string; listClassName?: string; triggerClassName?: string;
  iconClassName?: string; badgeClassName?: string;
  /** Retained for callers; tabs now size to their labels. */
  minItemWidthRem?: number;
};

function revealActiveTab(element: HTMLDivElement) {
  if (element.scrollWidth <= element.clientWidth) return;
  const selected = element.querySelector<HTMLElement>('[data-state="active"]');
  if (!selected) return;
  const item = selected.getBoundingClientRect();
  const frame = element.getBoundingClientRect();
  // Leave room for the 44px touch scroll controls without moving the page.
  if (item.left < frame.left + 44) element.scrollLeft -= frame.left + 44 - item.left;
  else if (item.right > frame.right - 44) element.scrollLeft += item.right - frame.right + 44;
}
/*
  折叠式分类条（墨金主题、手机上）。

  2026-10-11 用户看了墨金的截图要「把分类条做成折叠式」：五六个分类在 393px 上横着排
  要左右滑，折起来只占一个小按钮的位置 —— 当前分类的名字 + 数 + 一个小箭头，点开是一列
  分类的下拉，选一个就收起。搜索和新建那一行紧挨着它排在同一行右边（theme-gilt.css 里
  用 float 做的），顶上这一块从两行变一行。

  只在墨金 + 手机下折；经典 / 极光和桌面仍是横着排的分段条。Tabs 的状态机还是 Radix 的
  （TabsTrigger 照用），只是列表平时不渲染、点开才渲染。
*/
function FoldedTabsList<T extends string>({
  items, activeValue, ariaLabel, className, listClassName, triggerClassName, iconClassName, badgeClassName,
}: SlidingTabsListProps<T>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); }, [activeValue]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const active = items.find((item) => item.value === activeValue) ?? items[0];
  const ActiveIcon = active?.icon;
  return (
    <div ref={root} className={cn("workspace-tabs-folded", className)} data-open={open ? "" : undefined}>
      <button
        type="button"
        className="workspace-tabs-fold"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ? `${ariaLabel}：${active?.label ?? ""}` : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {ActiveIcon && <ActiveIcon className={cn("h-4 w-4 shrink-0", iconClassName)} />}
        <span className="workspace-tabs-fold-label">{active?.label}</span>
        {active?.badge !== undefined && active?.badge !== null && (
          <span className={cn("workspace-tab-count", badgeClassName)}>{active.badge}</span>
        )}
        <ChevronDown className="workspace-tabs-fold-chevron h-4 w-4 shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <div className="workspace-tabs-fold-panel">
          <TabsList aria-label={ariaLabel} className={cn("workspace-tabs-fold-list", listClassName)}>
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <TabsTrigger key={item.value} value={item.value} disabled={item.disabled}
                  data-active={item.value === activeValue ? "true" : undefined}
                  className={cn("workspace-tab-folded", triggerClassName)}>
                  {Icon && <Icon className={cn("h-4 w-4 shrink-0", iconClassName)} />}
                  <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                  {item.badge !== undefined && item.badge !== null && (
                    <span className={cn("workspace-tab-count", badgeClassName)}>{item.badge}</span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
      )}
    </div>
  );
}

export function SlidingTabsList<T extends string>(props: SlidingTabsListProps<T>) {
  const isMobile = useIsMobile();
  const uiTheme = useUiTheme();
  if (isMobile && uiTheme === "gilt") return <FoldedTabsList {...props} />;
  return <ScrollingTabsList {...props} />;
}

function ScrollingTabsList<T extends string>({
  items, activeValue, ariaLabel, className, listClassName,
  triggerClassName, iconClassName, badgeClassName,
}: SlidingTabsListProps<T>) {
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    // 滚动时每个 scroll 事件都会进来；两端状态没变就别换新对象，免得整条分类条跟着重渲染
    const measure = () => {
      const left = element.scrollLeft > 2;
      const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 2;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    const observer = new ResizeObserver(() => { revealActiveTab(element); measure(); });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => { observer.disconnect(); element.removeEventListener("scroll", measure); };
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (element) revealActiveTab(element);
  }, [activeValue]);
  const scroll = (direction: number) => {
    const element = viewport.current;
    if (element) element.scrollBy({ left: direction * element.clientWidth * 0.7, behavior: "instant" });
  };
  return (
    <div
      className={cn("workspace-tabs relative min-w-0", className)}
      // 触屏上不画箭头，靠这两个属性把还有内容的那一边淡出去（workspace.css）
      data-more-left={edges.left ? "" : undefined}
      data-more-right={edges.right ? "" : undefined}
    >
      <div ref={viewport} className="workspace-tabs-viewport">
        <TabsList aria-label={ariaLabel} className={cn("workspace-tabs-list", listClassName)}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <TabsTrigger key={item.value} value={item.value} disabled={item.disabled}
                data-active={item.value === activeValue ? "true" : undefined}
                className={cn("workspace-tab group", triggerClassName)}>
                {Icon && <Icon className={cn("h-4 w-4 shrink-0", iconClassName)} />}
                {item.label}
                {item.badge !== undefined && item.badge !== null && (
                  <span className={cn("workspace-tab-count", badgeClassName)}>{item.badge}</span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
      {edges.left && <button type="button" className="workspace-tab-scroll left-0" aria-label="查看前面的分类" onClick={() => scroll(-1)}><ChevronLeft className="h-4 w-4" /></button>}
      {edges.right && <button type="button" className="workspace-tab-scroll right-0" aria-label="查看更多分类" onClick={() => scroll(1)}><ChevronRight className="h-4 w-4" /></button>}
    </div>
  );
}
