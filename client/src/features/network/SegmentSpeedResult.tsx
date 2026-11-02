import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SegmentSpeedRunView, SegmentSpeedSegment } from "../../../../server/lineSegmentSpeed";

/*
  逐段测带宽的结果（2.3.506 起两处共用一份）：网络测试页「iperf3 对拉」和线路详情里的「逐段测带宽」。

  两边背后是同一个东西（server/lineSegmentSpeed.ts，进度都是 SegmentSpeedRunView），原来各画各的：
  一边写「不测」一边写「测不了」，一边有反向、单条连接、重传，一边只有一个数。现在同一个组件：
  full 是对拉页那种一段一张卡；compact 塞在线路详情里，一段一行，字段和叫法跟 full 一样，只是少画几项。
*/

export type SpeedRun = Pick<SegmentSpeedRunView, "status" | "error" | "segments" | "slowest">;

export function formatMbps(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} Gbps` : `${Math.round(value)} Mbps`;
}

function perGB(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return value >= 10_000 ? `${Math.round(value / 1000)}k / GB` : `${value} / GB`;
}

/** 这一段是不是「最慢」：测出来不止一段时才标，只有一段谈不上瓶颈。 */
export function isSlowestSegment(run: SpeedRun, index: number) {
  return run.slowest === index && run.segments.filter((item) => item.status === "done").length > 1;
}

/** 一段的状态，两处一个叫法。 */
export function segmentStateText(segment: Pick<SegmentSpeedSegment, "status">, slowest: boolean) {
  switch (segment.status) {
    case "running": return "测试中";
    case "pending": return "排队";
    case "skipped": return "不测";
    case "error": return "失败";
    default: return slowest ? "最慢" : "完成";
  }
}

function Stat({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("truncate tabular-nums", strong ? "text-[17px] font-semibold text-foreground" : "text-[13px] text-foreground")}>{value}</p>
    </div>
  );
}

function StateLabel({ segment, slowest }: { segment: SegmentSpeedSegment; slowest: boolean }) {
  const text = segmentStateText(segment, slowest);
  if (segment.status === "running") return <span className="inline-flex items-center gap-1"><Loader2 className="forwardx-icon-spin h-3 w-3" />{text}</span>;
  if (segment.status === "error") return <span className="text-[var(--fx-down-text)]">{text}</span>;
  if (slowest) return <span className="font-medium text-[var(--fx-warn-text)]">{text}</span>;
  return <>{text}</>;
}

export function SegmentSpeedResult({ run, variant = "full" }: { run: SpeedRun; variant?: "full" | "compact" }) {
  if (variant === "compact") {
    return (
      <div className="flex flex-col gap-0.5 rounded-xl bg-[var(--fx-l1-surface)] px-3 py-2 text-xs" data-testid="segment-speed-result" data-variant="compact">
        {run.segments.map((segment, index) => {
          const slowest = isSlowestSegment(run, index);
          return (
            <div key={index} className={cn("flex items-center justify-between gap-2", slowest && "font-semibold text-[var(--fx-warn-text)]")} data-testid="segment-speed-row">
              <span className="truncate">{segment.from.name} → {segment.to.name}</span>
              <span className="shrink-0 font-mono">
                {segment.status === "done"
                  ? <>{formatMbps(segment.mbps)}{segment.reverseMbps !== null ? ` · 反向 ${formatMbps(segment.reverseMbps)}` : ""}{slowest ? " · 最慢" : ""}</>
                  : <StateLabel segment={segment} slowest={slowest} />}
              </span>
            </div>
          );
        })}
        {run.segments.filter((segment) => segment.error && segment.status !== "pending" && segment.status !== "done").map((segment, index) => (
          <p key={`e${index}`} className={cn("text-[11px]", segment.status === "error" ? "text-[var(--fx-down-text)]" : "text-muted-foreground")}>{segment.from.name} → {segment.to.name}：{segment.error}</p>
        ))}
        {run.segments.filter((segment) => segment.status === "done" && segment.verdict).slice(0, 1).map((segment, index) => (
          <p key={`v${index}`} className="text-[11px] leading-relaxed text-muted-foreground">{segment.verdict}</p>
        ))}
        {run.error && run.status === "error" ? <p className="text-[11px] text-[var(--fx-down-text)]">{run.error}</p> : null}
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="segment-speed-result" data-variant="full">
      {run.segments.map((segment, index) => {
        const slowest = isSlowestSegment(run, index);
        return (
          <div key={index} className={cn("rounded-xl border p-3", slowest ? "border-[var(--fx-warn-text)]/50" : "border-border/60")} data-testid="iperf3-pair-segment">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-[13.5px] font-medium">{segment.from.name} → {segment.to.name}</p>
              <span className="shrink-0 text-[11.5px] text-muted-foreground"><StateLabel segment={segment} slowest={slowest} /></span>
            </div>
            {segment.status === "done" ? (
              <>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
                  <Stat label="正向（上游 → 下游）" value={formatMbps(segment.mbps)} strong />
                  <Stat label="反向（下游 → 上游）" value={formatMbps(segment.reverseMbps)} strong />
                  <Stat label="单条连接" value={formatMbps(segment.singleMbps)} />
                  <Stat label="多条里最慢 ~ 最快" value={segment.streamRange ? `${Math.round(segment.streamRange.min)} ~ ${Math.round(segment.streamRange.max)}` : "—"} />
                  <Stat label="重传 正 / 反" value={`${perGB(segment.retransPerGB)} · ${perGB(segment.reverseRetransPerGB)}`} />
                </div>
                {segment.verdict ? <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{segment.verdict}</p> : null}
              </>
            ) : segment.error && segment.status !== "pending" ? (
              <p className={cn("mt-1.5 text-[12px]", segment.status === "error" ? "text-[var(--fx-down-text)]" : "text-muted-foreground")}>{segment.error}</p>
            ) : null}
          </div>
        );
      })}
      {run.error && run.status === "error" ? <p className="text-[12px] text-[var(--fx-down-text)]">{run.error}</p> : null}
    </div>
  );
}
