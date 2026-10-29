import type { LinkTestDetail, LinkTestPlannedSegment, ParsedLinkTestMessage } from "@/components/LinkTestLatencySummary";
import { getLinkTestDetailEndpointIds } from "@/components/LinkTestLatencySummary";

/*
  诊断的「推算 vs 实测」：按段把三份东西对起来 —— 规划的段（入口 → 中转 → … → 目标）、
  后台探测以为的数（推算）、这次诊断测出来的数（实测），再判断哪一段对不上。

  对段的办法：先按两端主机 id（fromHostId / toHostId）对，对不上再按 hopIndex，最后
  （两边段数一样时）按顺序。实测里一段没有就是「未测」，不是 0。

  「对不上」的口径：一边通一边不通；或者两边都有数、差超过 20ms 且超过 30%（和线路组
  择优的「明显更快」同一套门槛 —— 20ms 以内的差异在公网上就是噪声）。
*/

export type CompareSample = {
  latencyMs: number | null;
  /** 探测过且不通。 */
  timeout: boolean;
  /** 没有这一段的数。 */
  missing: boolean;
  /** Unix 毫秒；推算那边是后台探测的时刻。 */
  at: number | null;
};

export type ExpectedSegmentLike = {
  hopIndex: number;
  fromHostId: number | null;
  toHostId: number | null;
  latencyMs: number | null;
  isTimeout: boolean;
  at: number | null;
};

export type ExpectedLatencyLike = {
  total: { latencyMs: number | null; isTimeout: boolean; at: number | null } | null;
  tunnelTotal?: { latencyMs: number | null; isTimeout: boolean; at: number | null } | null;
  segments: ExpectedSegmentLike[];
};

export type CompareRow = {
  key: string;
  from: string;
  to: string;
  expected: CompareSample;
  measured: CompareSample;
  /** 实测 − 推算（毫秒）；任一边没数就是 null。 */
  deltaMs: number | null;
  /** 对不上。 */
  mismatch: boolean;
  /** 一句话：为什么算对不上。 */
  note: string | null;
};

export type CompareResult = {
  rows: CompareRow[];
  total: CompareRow | null;
  mismatches: number;
};

const ABS_MS = 20;
const RATIO = 0.3;

const none: CompareSample = { latencyMs: null, timeout: false, missing: true, at: null };

function judge(expected: CompareSample, measured: CompareSample): { deltaMs: number | null; mismatch: boolean; note: string | null } {
  if (expected.missing || measured.missing) return { deltaMs: null, mismatch: false, note: null };
  if (expected.timeout !== measured.timeout) {
    return { deltaMs: null, mismatch: true, note: measured.timeout ? "后台探测还通着，这次实测不通" : "后台探测说不通，这次实测通了：后台的数该更新了" };
  }
  if (expected.timeout || expected.latencyMs === null || measured.latencyMs === null) return { deltaMs: null, mismatch: false, note: null };
  const delta = measured.latencyMs - expected.latencyMs;
  const base = Math.max(1, expected.latencyMs);
  const mismatch = Math.abs(delta) >= ABS_MS && Math.abs(delta) / base >= RATIO;
  return {
    deltaMs: Math.round(delta),
    mismatch,
    note: mismatch ? (delta > 0 ? "这一段比后台探测慢得多" : "这一段比后台探测快得多：后台的数偏旧") : null,
  };
}

function measuredOf(detail: LinkTestDetail | null): CompareSample {
  if (!detail || detail.pending) return none;
  const latency = typeof detail.latencyMs === "number" && Number.isFinite(detail.latencyMs) && detail.latencyMs > 0 ? detail.latencyMs : null;
  if (detail.success && latency !== null) return { latencyMs: latency, timeout: false, missing: false, at: null };
  return { latencyMs: null, timeout: true, missing: false, at: null };
}

function expectedOf(segment: ExpectedSegmentLike | null): CompareSample {
  if (!segment) return none;
  if (segment.isTimeout) return { latencyMs: null, timeout: true, missing: false, at: segment.at };
  if (segment.latencyMs === null || !Number.isFinite(segment.latencyMs)) return none;
  return { latencyMs: segment.latencyMs, timeout: false, missing: false, at: segment.at };
}

function sameEnds(a: { fromHostId?: number | null; toHostId?: number | null }, b: { fromHostId?: number | null; toHostId?: number | null }) {
  const af = Number(a.fromHostId || 0);
  const bf = Number(b.fromHostId || 0);
  const at = Number(a.toHostId || 0);
  const bt = Number(b.toHostId || 0);
  if (af > 0 && bf > 0 && af !== bf) return false;
  if (at > 0 && bt > 0 && at !== bt) return false;
  return (af > 0 && bf > 0) || (at > 0 && bt > 0);
}

export function compareLinkTest(input: {
  planned: readonly LinkTestPlannedSegment[];
  parsed: ParsedLinkTestMessage | null;
  expected: ExpectedLatencyLike | null;
  measuredAt?: number | null;
}): CompareResult {
  const details = (input.parsed?.details || []).filter((detail) => detail.success || detail.message || detail.pending || typeof detail.latencyMs === "number");
  const detailIds = details.map((detail) => ({ detail, ids: getLinkTestDetailEndpointIds(detail) }));
  const expectedSegments = input.expected?.segments || [];
  const planned = input.planned;
  const usedDetails = new Set<number>();
  const rows: CompareRow[] = planned.map((segment, index) => {
    let detailIndex = detailIds.findIndex((item, itemIndex) => !usedDetails.has(itemIndex) && sameEnds(segment, item.ids));
    if (detailIndex < 0) detailIndex = detailIds.findIndex((item, itemIndex) => !usedDetails.has(itemIndex) && item.ids.hopIndex !== null && item.ids.hopIndex === (segment.hopIndex ?? index));
    if (detailIndex < 0 && details.length === planned.length && !usedDetails.has(index)) detailIndex = index;
    if (detailIndex >= 0) usedDetails.add(detailIndex);
    const detail = detailIndex >= 0 ? detailIds[detailIndex].detail : null;
    const expectedSegment = expectedSegments.find((item) => sameEnds(segment, item))
      || expectedSegments.find((item) => item.hopIndex === (segment.hopIndex ?? index))
      || (expectedSegments.length === planned.length ? expectedSegments[index] : null)
      || null;
    const measured = measuredOf(detail);
    if (!measured.missing && input.measuredAt) measured.at = input.measuredAt;
    const expected = expectedOf(expectedSegment);
    const verdict = judge(expected, measured);
    return { key: `${segment.fromHostId ?? segment.from}-${segment.toHostId ?? segment.to}-${index}`, from: segment.from, to: segment.to, expected, measured, ...verdict };
  });

  const measuredTotal: CompareSample = input.parsed && typeof input.parsed.totalLatencyMs === "number" && input.parsed.totalLatencyMs > 0
    ? { latencyMs: input.parsed.totalLatencyMs, timeout: false, missing: false, at: input.measuredAt ?? null }
    : none;
  const expectedTotal: CompareSample = input.expected?.total
    ? (input.expected.total.isTimeout
      ? { latencyMs: null, timeout: true, missing: false, at: input.expected.total.at }
      : input.expected.total.latencyMs !== null ? { latencyMs: input.expected.total.latencyMs, timeout: false, missing: false, at: input.expected.total.at } : none)
    : none;
  const total: CompareRow | null = expectedTotal.missing && measuredTotal.missing
    ? null
    : { key: "total", from: "入口", to: "目标", expected: expectedTotal, measured: measuredTotal, ...judge(expectedTotal, measuredTotal) };
  return { rows, total, mismatches: rows.filter((row) => row.mismatch).length + (total?.mismatch ? 1 : 0) };
}
