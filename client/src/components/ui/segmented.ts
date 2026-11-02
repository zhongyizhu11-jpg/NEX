import { cn } from "@/lib/utils";

/*
  分段控件：一条比面深一档的槽、不描边，选中项是白块加 1px 软影（深色下退回浅灰块）。
  槽和选项都不画线 —— 形状由「槽深一档、选项浅一档」这一次明暗差给出。
*/
export const segmentedControlClassName = "rounded-md bg-[var(--fx-l3-control-fill)] p-[3px]";

export function segmentedOptionClassName(active: boolean, disabled = false, className?: string) {
  return cn(
    "group flex h-8 min-w-0 items-center justify-center gap-2 rounded-inner px-3 text-center text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:shadow-[var(--fx-focus-ring)]",
    active
      ? "bg-[var(--fx-l1-surface)] text-foreground shadow-[var(--fx-elevation-control)] dark:bg-[var(--fx-hover)] dark:shadow-none"
      : "text-muted-foreground hover:text-foreground",
    disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
    className,
  );
}

export function segmentedIconClassName(active: boolean, className?: string) {
  return cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-current", className);
}