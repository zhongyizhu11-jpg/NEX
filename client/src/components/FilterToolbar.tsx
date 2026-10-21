import { useId, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function FilterToolbar({ search, children, activeCount = 0, action, collapsed = false }: {
  search: ReactNode; children?: ReactNode; activeCount?: number;
  /** 桌面上也只留筛选图标、点开才展开那几个下拉（精简布局：分类条和这一行并排，放不下三个下拉）。 */
  collapsed?: boolean;
  /**
   * 这一页的主操作（「新建规则」这类）。
   *
   * 放在筛选按钮右边，而不是页面顶栏：手机上顶栏只有 393px，主操作挤在那儿
   * 要和页面标题、搜索、主题切换抢位置，长一点的文案还会被截断。筛选这一行
   * 本来就是「对这个列表做事」的地方，主操作和它并排才是同一类东西。
   */
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="workspace-filter" data-collapsed={collapsed ? "" : undefined}>
      <div className="workspace-filter-search">{search}</div>
      {children && <>
        {/*
          手机上只留图标（有筛选条件时带个数字）：「筛选」「新建规则」两个带字的按钮加上搜索框，
          393px 上一行放不下，原来只好让搜索框单独占第二行 —— 这一块 76px。只留图标之后
          三样并排一行 34px；按钮的名字还在 aria-label 里，读屏照样念得出来。
        */}
        <Button type="button" variant={open || activeCount > 0 ? "secondary" : "outline"}
          className={cn("fx-filter-pill h-10 w-10 shrink-0 gap-1 rounded-full", !collapsed && "sm:hidden")} aria-expanded={open} aria-controls={id}
          aria-label={activeCount > 0 ? `筛选（已设 ${activeCount} 项）` : "筛选"} title="筛选"
          onClick={() => setOpen(!open)}>
          <SlidersHorizontal className="h-4 w-4" />{activeCount > 0 && <span className="tabular-nums">{activeCount}</span>}
        </Button>
        <div id={id} className={cn("workspace-filter-options", open ? "flex" : collapsed ? "hidden" : "hidden sm:flex")}>
          {children}
        </div>
      </>}
      {action && <div className="workspace-filter-action">{action}</div>}
    </div>
  );
}
