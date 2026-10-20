import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/*
  规则编辑框里「出口」「线路组」的折叠框，和「更多设置」同一个样子：默认收起，标题后面挂一句当前状态
  （收纳不是藏）；有要用户处理的问题时由调用方把它打开（open），摘要也标成提醒色（warn）。
*/
export function RuleFormCollapsible({
  title,
  summary,
  warn = false,
  open,
  onOpenChange,
  testId,
  children,
}: {
  title: string;
  summary: ReactNode;
  warn?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="fx-rule-collapsible rounded-md border border-border/60 bg-muted/15" data-testid={testId}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <span className="shrink-0 font-medium">{title}</span>
        <span className={cn("min-w-0 flex-1 truncate text-xs", warn ? "text-[var(--fx-warn-text)]" : "text-muted-foreground")}>
          {summary}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? <div className="space-y-2.5 border-t border-border/60 p-3">{children}</div> : null}
    </div>
  );
}
