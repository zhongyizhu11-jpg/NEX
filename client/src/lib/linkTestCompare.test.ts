import assert from "node:assert/strict";
import test from "node:test";

import { compareLinkTest } from "./linkTestCompare";

const planned = [
  { from: "HK entry", to: "JP relay", fromHostId: 1, toHostId: 2, hopIndex: 0, hopCount: 3 },
  { from: "JP relay", to: "US exit", fromHostId: 2, toHostId: 3, hopIndex: 1, hopCount: 3 },
  { from: "US exit", to: "目标", fromHostId: 3, toHostId: null, hopIndex: 2, hopCount: 3 },
];
const expected = {
  total: { latencyMs: 120, isTimeout: false, at: 1000 },
  segments: [
    { hopIndex: 0, fromHostId: 1, toHostId: 2, latencyMs: 40, isTimeout: false, at: 1000 },
    { hopIndex: 1, fromHostId: 2, toHostId: 3, latencyMs: 50, isTimeout: false, at: 1000 },
    { hopIndex: 2, fromHostId: 3, toHostId: null, latencyMs: 30, isTimeout: false, at: 1000 },
  ],
};

test("按两端主机对段：差在 20ms 和 30% 以内算一致，超了算对不上", () => {
  const result = compareLinkTest({
    planned,
    parsed: {
      message: "", totalLatencyMs: 300,
      details: [
        { success: true, latencyMs: 45, fromHostId: 1, toHostId: 2, hopIndex: 0 },
        { success: true, latencyMs: 220, fromHostId: 2, toHostId: 3, hopIndex: 1 },
        { success: true, latencyMs: 31, fromHostId: 3, hopIndex: 2 },
      ],
    },
    expected,
    measuredAt: 2000,
  });
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].mismatch, false);
  assert.equal(result.rows[0].deltaMs, 5);
  assert.equal(result.rows[1].mismatch, true, "50 → 220 是这一段突然变差");
  assert.match(result.rows[1].note || "", /慢得多/);
  assert.equal(result.rows[2].mismatch, false);
  assert.equal(result.total?.mismatch, true);
  assert.equal(result.mismatches, 2);
});

test("一边通一边不通算对不上；实测里没这段写「未测」不算", () => {
  const result = compareLinkTest({
    planned,
    parsed: {
      message: "", totalLatencyMs: null,
      details: [
        { success: true, latencyMs: 40, fromHostId: 1, toHostId: 2, hopIndex: 0 },
        { success: false, latencyMs: null, message: "超时", fromHostId: 2, toHostId: 3, hopIndex: 1 },
      ],
    },
    expected,
  });
  assert.equal(result.rows[1].mismatch, true);
  assert.match(result.rows[1].note || "", /这次实测不通/);
  assert.equal(result.rows[2].measured.missing, true);
  assert.equal(result.rows[2].mismatch, false);
});

test("没有后台数据时只有实测一列，什么都不算对不上", () => {
  const result = compareLinkTest({
    planned,
    parsed: { message: "", totalLatencyMs: 90, details: [{ success: true, latencyMs: 90, fromHostId: 1, toHostId: 2, hopIndex: 0 }] },
    expected: null,
  });
  assert.equal(result.mismatches, 0);
  assert.equal(result.rows[0].expected.missing, true);
  assert.equal(result.total?.expected.missing, true);
  assert.equal(result.total?.measured.latencyMs, 90);
});

test("两边都没有 id 时按顺序对（段数一样才敢）", () => {
  const bare = [{ from: "A", to: "B" }, { from: "B", to: "C" }];
  const result = compareLinkTest({
    planned: bare,
    parsed: { message: "", totalLatencyMs: null, details: [{ success: true, latencyMs: 10 }, { success: true, latencyMs: 200 }] },
    expected: { total: null, segments: [{ hopIndex: 0, fromHostId: null, toHostId: null, latencyMs: 12, isTimeout: false, at: null }, { hopIndex: 1, fromHostId: null, toHostId: null, latencyMs: 15, isTimeout: false, at: null }] },
  });
  assert.equal(result.rows[0].mismatch, false);
  assert.equal(result.rows[1].mismatch, true);
});
