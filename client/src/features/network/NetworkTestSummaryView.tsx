import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  pingSummaryNotes,
  routeSummaryNotes,
  type PingSummary,
  type RouteHop,
  type RouteSummary,
  type SummaryNote,
} from "@shared/networkTestSummary";

/*
  网络测试页结果卡里的摘要（解析在 shared/networkTestSummary.ts）：
    · Ping：发送 / 收到 / 丢包率 / 最小 / 平均 / 最大 / 抖动 一行小格子，下面一两句结论；
    · Traceroute / MTR：逐跳一张表（跳数、地址、无回应 / 丢包、延迟），上面一两句结论。
  原始输出照旧在，摘要只是读给人看的那一层。
*/

function ms(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined ? "-" : `${value.toFixed(digits)} ms`;
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : `${Number(value.toFixed(1))}%`;
}

const NOTE_STYLE: Record<SummaryNote["level"], { icon: typeof Info; className: string }> = {
  ok: { icon: CheckCircle2, className: "text-[var(--fx-healthy-text)]" },
  info: { icon: Info, className: "text-muted-foreground" },
  warn: { icon: AlertTriangle, className: "text-[var(--fx-warn-text)]" },
};

function SummaryNotes({ notes }: { notes: SummaryNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-1">
      {notes.map((note) => {
        const style = NOTE_STYLE[note.level];
        const Icon = style.icon;
        return (
          <li key={note.text} className={cn("flex items-start gap-1.5 text-xs leading-5", style.className)}>
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{note.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function PingSummaryStrip({ summary }: { summary: PingSummary }) {
  const lossy = (summary.lossPercent ?? 0) > 0;
  const cells: Array<{ label: string; value: string; tone?: "warn" }> = [
    { label: "发送", value: summary.sent === null ? "-" : String(summary.sent) },
    { label: "收到", value: String(summary.received) },
    { label: "丢包率", value: percent(summary.lossPercent), tone: lossy ? "warn" : undefined },
    { label: "最小", value: ms(summary.minMs, 2) },
    { label: "平均", value: ms(summary.avgMs, 2) },
    { label: "最大", value: ms(summary.maxMs, 2) },
    { label: "抖动", value: ms(summary.jitterMs, 2) },
  ];
  return (
    <div className="shrink-0 space-y-2 border-b border-border/40 px-4 py-3" aria-label="Ping 摘要">
      <dl className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {cells.map((cell) => (
          <div key={cell.label} className="min-w-0 rounded-md border border-border/40 bg-muted/20 px-2 py-1.5">
            <dt className="text-[11px] text-muted-foreground">{cell.label}</dt>
            <dd className={cn("truncate font-mono text-xs tabular-nums", cell.tone === "warn" && "text-[var(--fx-warn-text)]")}>{cell.value}</dd>
          </div>
        ))}
      </dl>
      {summary.stddevMs !== null && (
        <p className="text-[11px] text-muted-foreground">标准差（mdev）{ms(summary.stddevMs, 2)}；抖动按相邻两次回包的差算</p>
      )}
      <SummaryNotes notes={pingSummaryNotes(summary)} />
    </div>
  );
}

function hopLossClass(hop: RouteHop, isLast: boolean) {
  if (hop.timedOut) return "text-muted-foreground";
  if ((hop.lossPercent ?? 0) <= 0) return "";
  return isLast ? "text-[var(--fx-down-text)]" : "text-[var(--fx-warn-text)]";
}

export function RouteHopTable({ summary }: { summary: RouteSummary }) {
  const mtr = summary.tool === "mtr";
  const notes = routeSummaryNotes(summary);
  return (
    <div className="space-y-3 px-4 py-3">
      <SummaryNotes notes={notes} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-xs">
          <thead>
            <tr className="border-b border-border/40 text-left text-[11px] text-muted-foreground">
              <th className="w-10 py-1.5 pr-2 font-medium">跳</th>
              <th className="py-1.5 pr-2 font-medium">地址</th>
              <th className="py-1.5 pr-2 text-right font-medium">{mtr ? "丢包" : "无回应"}</th>
              {mtr && <th className="py-1.5 pr-2 text-right font-medium">发送</th>}
              <th className="py-1.5 pr-2 text-right font-medium">平均</th>
              <th className="py-1.5 pr-2 text-right font-medium">最好</th>
              <th className="py-1.5 pr-2 text-right font-medium">最差</th>
              {mtr && <th className="py-1.5 text-right font-medium">标准差</th>}
            </tr>
          </thead>
          <tbody>
            {summary.hops.map((hop, index) => {
              const isLast = index === summary.hops.length - 1;
              return (
                <tr key={`${hop.hop}-${index}`} className="border-b border-border/20 align-top last:border-0">
                  <td className="py-1.5 pr-2 font-mono tabular-nums text-muted-foreground">{hop.hop}</td>
                  <td className="py-1.5 pr-2 font-mono">
                    {hop.timedOut ? (
                      <span className="text-muted-foreground">无回应</span>
                    ) : (
                      <span className="break-all">{hop.addresses.join(" / ")}</span>
                    )}
                    {hop.annotations.length > 0 && <span className="ml-1 text-[var(--fx-down-text)]">{hop.annotations.join(" ")}</span>}
                  </td>
                  <td className={cn("py-1.5 pr-2 text-right font-mono tabular-nums", hopLossClass(hop, isLast))}>{percent(hop.lossPercent)}</td>
                  {mtr && <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-muted-foreground">{hop.sent ?? "-"}</td>}
                  <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{ms(hop.avgMs)}</td>
                  <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-muted-foreground">{ms(hop.bestMs)}</td>
                  <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-muted-foreground">{ms(hop.worstMs)}</td>
                  {mtr && <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">{ms(hop.stddevMs)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {mtr
          ? "MTR 每跳发 10 个探测。中间跳丢包、终点不丢，多半是路由器对探测限速，不影响业务；看终点那一行。"
          : "Traceroute 每跳只发 3 个探测，「无回应」只能看个大概；要看丢包用 MTR。"}
      </p>
    </div>
  );
}
