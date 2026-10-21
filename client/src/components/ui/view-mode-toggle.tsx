import type { ComponentType } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ViewModeToggleItem<T extends string> = {
  value: T;
  /** 按钮的 title 和 aria-label：「卡片视图」「列表视图」「3D 地球视图」 */
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** 窄屏上不放（地图那两档）。 */
  hideBelow?: "md";
  /** 鼠标移上去 / 聚焦时预取（地球视图的那包代码）。 */
  onHover?: () => void;
};

/*
  列表页右上角那组「卡片 / 列表 / 地图」图标按钮：一圈弱线、按钮不圆角、选中的那格灰底。
  原来主机、Token、分组、服务、套餐、转发组、规则、链路各自复制了一份同样的几行；现在就这一份。
  默认手机上不显示（sm:flex）—— 手机上列表只有一种摆法；要一直显示传 className="flex"。
*/
export function ViewModeToggle<T extends string>({
  items,
  value,
  onChange,
  ariaLabel = "视图",
  className,
}: {
  items: ReadonlyArray<ViewModeToggleItem<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex", className)}>
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.value === value;
        return (
          <Button
            key={item.value}
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="icon"
            className={cn("h-8 w-8 rounded-none", item.hideBelow === "md" && "hidden md:inline-flex")}
            title={item.label}
            aria-label={item.label}
            aria-pressed={active}
            onClick={() => onChange(item.value)}
            onPointerEnter={item.onHover}
            onFocus={item.onHover}
          >
            <Icon className="h-4 w-4" />
          </Button>
        );
      })}
    </div>
  );
}
