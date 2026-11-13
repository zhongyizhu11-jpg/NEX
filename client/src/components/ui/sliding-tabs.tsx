import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
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

/*
  选中的页签被裁掉了才把它滑进来，而且只滑到刚好露出来。

  原来不管看没看得见，离边 44px 以内就滑（给鼠标那两枚左右箭头留位置）：手机上没有箭头，
  点一个已经整个在眼前的页签，整条还是左右挪一截，再点回去又挪回来 —— 用户录屏里
  「页面左右晃」就是这个（2026-11-04）。触屏上按边缘淡出的那 28px 算，鼠标上才给箭头留位。
*/
const TOUCH_EDGE_PX = 28;
const POINTER_EDGE_PX = 44;

function revealActiveTab(element: HTMLDivElement) {
  if (element.scrollWidth <= element.clientWidth) return;
  const selected = element.querySelector<HTMLElement>('[data-state="active"]');
  if (!selected) return;
  const item = selected.getBoundingClientRect();
  const frame = element.getBoundingClientRect();
  const coarse = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  const edge = coarse ? TOUCH_EDGE_PX : POINTER_EDGE_PX;
  // 两边都还没碰到留白区就什么都不做：整条不动，点下去只换高亮
  if (item.left >= frame.left + edge && item.right <= frame.right - edge) return;
  if (item.width + edge * 2 > frame.width) {
    // 页签比整条还宽（极窄屏）：对齐左边就够了
    element.scrollLeft += item.left - frame.left - edge;
    return;
  }
  if (item.left < frame.left + edge) element.scrollLeft -= frame.left + edge - item.left;
  else element.scrollLeft += item.right - frame.right + edge;
}
/*
  墨金主题在手机上曾经把分类条折成一枚「当前分类 ⌄」的下拉（2026-10-11 加的 FoldedTabsList）。
  2026-11 用户在 iPhone 上看，和主题里把搜索收成圆钮、新建只留「＋」一起，像排版坏了（分类变下拉框、
  中间空一大块），墨金 1.0.1 撤掉了这一套，所有主题手机上都是横着滑的分段条。
*/
export function SlidingTabsList<T extends string>({
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
