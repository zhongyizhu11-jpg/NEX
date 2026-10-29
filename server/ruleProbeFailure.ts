import { setBoundedMapValue } from "./boundedCache";
import { normalizeProbeFailure, type ProbeFailureKind } from "../shared/probeFailure";

/*
  每条规则最近一次探测失败的种类（shared/probeFailure）。只留内存：tcping_stats 里只有
  isTimeout 一个布尔，加一列要改三种数据库的表；而这个词只在「此刻为什么红」时有用，
  面板重启丢了，下一轮探测（一分钟内）就又有了。探测成功就清掉。
*/

type Entry = { kind: ProbeFailureKind; at: number };

const MAX_RULES = 20_000;
const STALE_MS = 15 * 60_000;
const byRule = new Map<number, Entry>();

export function recordRuleProbeFailure(ruleId: number, failure: unknown, nowMs = Date.now()) {
  const id = Math.floor(Number(ruleId));
  if (!(id > 0)) return;
  const kind = normalizeProbeFailure(failure);
  if (!kind) {
    byRule.delete(id);
    return;
  }
  setBoundedMapValue(byRule, id, { kind, at: nowMs }, MAX_RULES);
}

export function getRuleProbeFailure(ruleId: number, nowMs = Date.now()): ProbeFailureKind | null {
  const entry = byRule.get(Math.floor(Number(ruleId)));
  if (!entry || nowMs - entry.at > STALE_MS) return null;
  return entry.kind;
}

/** 给一批汇总行补上 latestProbeFailure：只有最近一次探测是超时的行才有意义。 */
export function withRuleProbeFailures<T extends { ruleId: number | string; latestLatencyIsTimeout?: boolean }>(rows: T[], nowMs = Date.now()): Array<T & { latestProbeFailure: ProbeFailureKind | null }> {
  return rows.map((row) => ({
    ...row,
    latestProbeFailure: row.latestLatencyIsTimeout ? getRuleProbeFailure(Number(row.ruleId), nowMs) : null,
  }));
}

export function resetRuleProbeFailuresForTest() {
  byRule.clear();
}
