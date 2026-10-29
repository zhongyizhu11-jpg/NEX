import assert from "node:assert/strict";
import test from "node:test";

import { getRuleProbeFailure, recordRuleProbeFailure, resetRuleProbeFailuresForTest, withRuleProbeFailures } from "./ruleProbeFailure";

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);

test("记最近一次不通的种类；通了就清；十五分钟没新消息就不再拿它说事", () => {
  resetRuleProbeFailuresForTest();
  recordRuleProbeFailure(5, "refused", T0);
  assert.equal(getRuleProbeFailure(5, T0 + 60_000), "refused");
  assert.equal(getRuleProbeFailure(5, T0 + 16 * 60_000), null);
  recordRuleProbeFailure(5, null, T0 + 1000);
  assert.equal(getRuleProbeFailure(5, T0 + 2000), null);
  recordRuleProbeFailure(5, "nonsense", T0);
  assert.equal(getRuleProbeFailure(5, T0), null, "认不出的词不记");
});

test("汇总行只在最近一次是超时的那些上补种类", () => {
  resetRuleProbeFailuresForTest();
  recordRuleProbeFailure(1, "dns", T0);
  recordRuleProbeFailure(2, "dns", T0);
  const rows = withRuleProbeFailures([
    { ruleId: 1, latestLatencyIsTimeout: true },
    { ruleId: 2, latestLatencyIsTimeout: false },
    { ruleId: 3, latestLatencyIsTimeout: true },
  ], T0 + 1000);
  assert.deepEqual(rows.map((row) => row.latestProbeFailure), ["dns", null, null]);
});
