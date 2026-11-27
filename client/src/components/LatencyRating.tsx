import { Activity, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { latencyLevel } from "@/lib/latencyLevel";

const TONE_TEXT = {
  healthy: "text-[var(--fx-healthy-text)]",
  ok: "text-[var(--fx-healthy-text)]",
  warn: "text-[var(--fx-warn-text)]",
  down: "text-[var(--fx-down-text)]",
} as const;

export function getLatencyRating(latencyMs: number | null | undefined) {
  // 刻度只在 client/src/lib/latencyLevel.ts 一处
  const level = latencyLevel(latencyMs);
  if (!level) return { label: "", className: "text-muted-foreground" };
  return { label: level.label, className: TONE_TEXT[level.tone], tone: level.tone };
}

export function LatencyRating({
  latencyMs,
  isTimeout = false,
  emptyText = "暂无数据",
  timeoutText = "超时/不可达",
  className,
  icon = "activity",
  badge = true,
}: {
  latencyMs?: number | null;
  isTimeout?: boolean;
  emptyText?: string;
  timeoutText?: string;
  className?: string;
  icon?: "activity" | "none";
  /** 「优秀 / 良好 …」那枚小标签。窄的表格列里放不下（会被裁成「优秀」半个字），传 false 只留毫秒数，颜色照样分档。 */
  badge?: boolean;
}) {
  if (isTimeout) {
    return (
      <span className={cn("inline-flex items-center gap-1 text-xs text-destructive", className)}>
        <XCircle className="h-3 w-3" />
        {timeoutText}
      </span>
    );
  }

  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
    return <span className={cn("text-xs text-muted-foreground", className)}>{emptyText}</span>;
  }

  const rating = getLatencyRating(latencyMs);
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", rating.className, className)}>
      {icon === "activity" ? <Activity className="h-3 w-3" /> : null}
      <span className="tabular-nums" title={badge ? undefined : rating.label}>{latencyMs} ms</span>
      {badge ? (
        <span className="rounded-full border border-current/20 px-1.5 py-0.5 text-[11px] font-medium leading-none">
          {rating.label}
        </span>
      ) : null}
    </span>
  );
}
