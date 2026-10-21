import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 手机 + 精简布局：列表页的搜索行收成分类条右边的一枚图标，点开才占一行。
 *
 * 393px 上「分类条」「搜索 + 筛选」各占一行，加上页头就是三行才到第一条数据；搜索一天
 * 用不了几次，收起来后两行。有搜索词或筛选条件在身上时图标带一个点，提醒列表不是全部。
 * 桌面和标准布局不走这里（Rules / Hosts / Tunnels 里按 collapsePhoneSearch 决定）。
 */
export function SearchToggle({ open, active = false, onToggle }: { open: boolean; active?: boolean; onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant={open || active ? "secondary" : "outline"}
      size="icon"
      className="fx-search-toggle relative shrink-0 rounded-full"
      aria-pressed={open}
      aria-label={open ? "收起搜索" : "搜索"}
      title="搜索"
      onClick={onToggle}
    >
      <Search className="h-4 w-4" />
      {active && !open ? <span aria-hidden="true" className="fx-search-toggle-dot" /> : null}
    </Button>
  );
}
