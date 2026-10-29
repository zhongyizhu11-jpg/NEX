import assert from "node:assert/strict";
import test from "node:test";

import { summarizeRouteSwitches } from "./routeSwitchSummary";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const sw = (minutesAgo: number, from: string, to: string, reason = "health check") => ({
  kind: "switch", at: NOW - minutesAgo * 60_000, fromKey: from, toKey: to, fromLabel: from, toLabel: to, reason,
});

test("只数切换，预热和预检没过不算；一小时和一天分开数", () => {
  const summary = summarizeRouteSwitches([
    sw(5, "a", "b"),
    { kind: "prewarm", at: NOW - 6 * 60_000, toKey: "b" },
    { kind: "precheck_failed", at: NOW - 7 * 60_000, toKey: "b" },
    sw(300, "b", "a", "failback"),
    sw(30 * 60, "a", "b"),
  ], NOW);
  assert.equal(summary.count1h, 1);
  assert.equal(summary.count24h, 2, "30 小时前那次不算在一天里");
  assert.equal(summary.flapping, false, "五小时间隔的两次不是来回漂");
  assert.equal(summary.lastToLabel, "b");
});

test("十分钟内切出去又切回来算来回漂；一小时超过三次也算", () => {
  const bounce = summarizeRouteSwitches([sw(2, "b", "a", "failback"), sw(8, "a", "b")], NOW);
  assert.equal(bounce.flapping, true);
  const busy = summarizeRouteSwitches([sw(5, "a", "b"), sw(20, "b", "c"), sw(35, "c", "d"), sw(50, "d", "e")], NOW);
  assert.equal(busy.flapping, true);
  const calm = summarizeRouteSwitches([sw(5, "a", "b"), sw(50, "b", "c")], NOW);
  assert.equal(calm.flapping, false);
});

test("人工指定引起的切换单独数", () => {
  const summary = summarizeRouteSwitches([sw(5, "a", "b", "pin"), sw(90, "b", "a", "pin expired"), sw(200, "a", "b")], NOW);
  assert.equal(summary.manual24h, 2);
  assert.equal(summary.count24h, 3);
});

test("没有记录时全是零", () => {
  const summary = summarizeRouteSwitches([], NOW);
  assert.deepEqual(summary, { count24h: 0, count1h: 0, manual24h: 0, flapping: false, lastAt: null, lastFromLabel: null, lastToLabel: null, lastReason: null });
});
