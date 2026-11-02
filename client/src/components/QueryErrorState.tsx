import { AlertTriangle, RefreshCw } from "lucide-react";

import DataSectionError, { DataTableErrorRow } from "@/components/DataSectionError";
import { Button } from "@/components/ui/button";
import { queryErrorHint } from "@/lib/queryErrorMessage";
import { cn } from "@/lib/utils";

/*
  查询失败时页面上显示的那一块：一句原因 + 「重试」。

  页面拿到的往往是 `data = []` 这种默认值，一失败就画成「暂无」，用户以为真的没有。
  这里直接收 useQuery 的结果：失败且手里没有数据时才算失败（轮询失败一次、上一轮的数据还在，
  就继续显示数据，不闪错误）。大块的样子沿用 DataSectionError，表格里用一整行，
  卡片里放不下大块时用 compact 的一行。
*/

/** useQuery 返回值里这里用得到的那几项。 */
export type QueryLike = {
  isError: boolean;
  error: unknown;
  data?: unknown;
  isFetching?: boolean;
  refetch: () => unknown;
};

/** 失败且没有可显示的数据：该显示出错，而不是「暂无」。 */
export function isQueryFailed(query: QueryLike | null | undefined): query is QueryLike {
  return !!query && query.isError && query.data === undefined;
}

/** 一组查询里失败的那些，给 QueryErrorState 用：显示第一条的原因，重试时全部重拉。 */
export function failedQueryState(...queries: Array<QueryLike | null | undefined | false>) {
  const failed = queries.filter((query): query is QueryLike => !!query && isQueryFailed(query));
  if (failed.length === 0) return null;
  return {
    error: failed[0].error,
    retrying: failed.some((query) => !!query.isFetching),
    onRetry: () => {
      for (const query of failed) void query.refetch();
    },
  };
}

type QueryErrorStateProps = {
  /** 这块是什么数据，例如「令牌列表」。 */
  label?: string;
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  /** 放在卡片、列表行里的一行版本。 */
  compact?: boolean;
  className?: string;
  minHeight?: string;
};

export default function QueryErrorState({ label = "数据", error, onRetry, retrying = false, compact = false, className, minHeight }: QueryErrorStateProps) {
  if (!compact) {
    return <DataSectionError label={label} error={error} onRetry={onRetry} retrying={retrying} className={className} minHeight={minHeight} />;
  }
  const hint = queryErrorHint(error);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-[var(--fx-radius-control)] bg-[var(--fx-down-soft)] px-3 py-2 text-left",
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--fx-down-text)]" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-xs text-foreground">
        {label}加载失败
        <span className="text-muted-foreground">{hint ? `：${hint}` : "，请重试。"}</span>
      </span>
      {onRetry ? (
        <Button variant="outline" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={cn("mr-1 h-3 w-3", retrying && "forwardx-icon-spin")} aria-hidden="true" />
          重试
        </Button>
      ) : null}
    </div>
  );
}

/** 表格里的同一件事：占满一行。 */
export const QueryErrorRow = DataTableErrorRow;
