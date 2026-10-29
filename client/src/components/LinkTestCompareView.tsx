import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { compareLinkTest, type CompareRow, type CompareSample, type ExpectedLatencyLike } from "@/lib/linkTestCompare";
import { formatAgo } from "@shared/dashboardAttention";
import type { LinkTestPlannedSegment, ParsedLinkTestMessage } from "./LinkTestLatencySummary";

/*
  诊断对话框下半截的「推算 vs 实测」：一段一行，左边后台探测以为的数、右边这次诊断测的数、
  最右差多少。对不上的那行整行标出来，并写一句为什么 —— 「这一段比后台探测慢得多」比
  两个数字摆在那儿让人自己减要有用。

  不一致有两种意思，都得说出来：实测比推算差得多，是这一段此刻出了事；实测比推算好得多
  或者推算说不通、实测却通了，是后台的数陈旧了。
*/

function sampleText(sample: CompareSample) {
  if (sample.missing) return "—";
  if (sample.timeout) return "不通";
  return `${Math.round(sample.latencyMs || 0)} ms`;
}

function Cell({ sample, when }: { sample: CompareSample; when?: boolean }) {
  return (
    <span className={cn("fx-cmp-cell", sample.timeout && "fx-cmp-cell-timeout", sample.missing && "fx-cmp-cell-missing")}>
      <span className="font-mono tabular-nums">{sampleText(sample)}</span>
      {when && !sample.missing && sample.at ? <span className="fx-cmp-when">{formatAgo(Date.now() - sample.at)}</span> : null}
    </span>
  );
}

function Row({ row, head }: { row: CompareRow; head?: boolean }) {
  const delta = row.deltaMs === null ? "" : `${row.deltaMs > 0 ? "+" : ""}${row.deltaMs} ms`;
  return (
    <div className={cn("fx-cmp-row", head && "fx-cmp-row-total")} data-mismatch={row.mismatch ? "" : undefined} data-testid="compare-row">
      <span className="fx-cmp-seg">
        <b className="truncate">{row.from}</b>
        <span aria-hidden="true">→</span>
        <b className="truncate">{row.to}</b>
      </span>
      <Cell sample={row.expected} when />
      <Cell sample={row.measured} />
      <span className={cn("fx-cmp-delta font-mono tabular-nums", row.mismatch && "fx-cmp-delta-bad")}>{delta}</span>
      {row.note ? <span className="fx-cmp-note">{head ? row.note.replace("这一段", "整链") : row.note}</span> : null}
    </div>
  );
}

export function LinkTestCompareView({ planned, parsed, expected, measuredAt, isTesting, className }: {
  planned: readonly LinkTestPlannedSegment[] | undefined;
  parsed: ParsedLinkTestMessage | null;
  expected: ExpectedLatencyLike | null | undefined;
  /** 这次诊断结果的时刻（Unix 毫秒）。 */
  measuredAt?: number | null;
  isTesting?: boolean;
  className?: string;
}) {
  const result = useMemo(
    () => compareLinkTest({ planned: planned || [], parsed, expected: expected || null, measuredAt: measuredAt ?? null }),
    [planned, parsed, expected, measuredAt],
  );
  const hasExpected = !!expected && (expected.segments.length > 0 || !!expected.total);
  if ((planned || []).length === 0 && !result.total) return null;
  return (
    <section className={cn("fx-cmp", className)} data-testid="link-test-compare" aria-label="推算与实测对照">
      <header className="fx-cmp-head">
        <span className="text-secondary-type font-semibold text-foreground">推算 vs 实测</span>
        <span className="text-meta text-muted-foreground">
          {isTesting
            ? "实测中…"
            : result.mismatches > 0
              ? `${result.mismatches} 段对不上`
              : hasExpected ? "和后台探测一致" : "后台还没有这条链的逐段探测，只有实测"}
        </span>
      </header>
      <div className="fx-cmp-cols" aria-hidden="true">
        <span>段</span><span>推算（后台探测）</span><span>实测（这次诊断）</span><span>差</span>
      </div>
      <div className="fx-cmp-rows">
        {result.rows.map((row) => <Row key={row.key} row={row} />)}
        {result.total ? <Row row={{ ...result.total, from: "入口", to: "目标（整链）" }} head /> : null}
      </div>
      <p className="fx-cmp-foot">推算是后台定时探测（入口探到底、隧道 / 转发链 / 线路组逐跳）最近一次的结果；差超过 20ms 且超过 30%，或一边通一边不通，算对不上。</p>
    </section>
  );
}
