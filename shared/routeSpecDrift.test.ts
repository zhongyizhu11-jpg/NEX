import assert from "node:assert/strict";
import test from "node:test";

import { ROUTE_GUARD_DEFAULTS, type RouteGroupPolicy } from "./routeGroupModel";
import {
  ROUTE_SPEC_DRIFT_GRACE_MS,
  expectedRouteAgentSpec,
  parseRouteAgentSpec,
  routeSpecDriftFields,
  routeSpecReportUsable,
  type RouteAgentSpec,
} from "./routeSpecDrift";

const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);
const label = (index: number) => (index === 0 ? "主线路" : `备用 ${index}`);
const policy = (patch: Partial<RouteGroupPolicy> = {}): RouteGroupPolicy => ({
  ...ROUTE_GUARD_DEFAULTS,
  mode: "smart",
  spread: "weighted",
  schedule: null,
  pin: null,
  switchMode: "smooth",
  delivery: "hot",
  ...patch,
});
/** Agent 规整之后报上来的样子（agent/route_group.go specReportLocked）。 */
const reported = (patch: Partial<RouteAgentSpec> = {}): RouteAgentSpec => ({
  ...expectedRouteAgentSpec(policy(), 2),
  ...patch,
});

test("面板该下发的规格和 actionFailover 一个读法：整链最优 + 热备 → 只走最快、主备分配、热备", () => {
  const spec = expectedRouteAgentSpec(policy(), 2);
  assert.equal(spec.preferFastest, true);
  assert.equal(spec.strategy, "fallback");
  assert.equal(spec.delivery, "hot");
  assert.equal(spec.pinnedIndex, null);
  assert.equal(spec.schedule, null, "整链最优没有时段表");
  assert.equal(spec.targetCount, 2);
  // 聚合下发成按负载；按权重的没有钉子
  assert.equal(expectedRouteAgentSpec(policy({ mode: "failover", delivery: "aggregate" }), 3).strategy, "least_load");
  assert.equal(expectedRouteAgentSpec(policy({ mode: "weighted", spread: "round_robin", pin: { index: 1, untilMs: null } }), 2).pinnedIndex, null);
});

test("机器没拿到钉子：面板钉在备用 1，机器报没钉 —— 这就是 2.3.522 线上那种", () => {
  const expected = expectedRouteAgentSpec(policy({ pin: { index: 1, untilMs: NOW + 3_600_000 } }), 2);
  const fields = routeSpecDriftFields(expected, reported(), label, { nowMs: NOW });
  assert.equal(fields.length, 1);
  assert.equal(fields[0].key, "pin");
  assert.equal(fields[0].label, "人工指定");
  assert.match(fields[0].expected, /^备用 1 · 到 /);
  assert.equal(fields[0].actual, "没有");
});

test("两边一样就是一样：钉子、时段表、阈值全对上，没有差异", () => {
  const schedule = { timezone: "Asia/Shanghai", windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] };
  const expected = expectedRouteAgentSpec(policy({ mode: "hybrid", schedule, pin: { index: 0, untilMs: null }, minHoldSeconds: 60 }), 2);
  // Agent 报回来的时段表 days 顺序可能不同：按内容比
  const actual = { ...expected, schedule: { timezone: "Asia/Shanghai", windows: [{ days: [5, 4, 3, 2, 1], from: "18:00", to: "01:00", targetIndex: 1 }] } };
  assert.deepEqual(routeSpecDriftFields(expected, actual, label, { nowMs: NOW }), []);
});

test("钉子到期前后那几秒不算差：面板和机器各按自己的钟判到期", () => {
  const until = NOW + 5_000;
  const expected = expectedRouteAgentSpec(policy({ pin: { index: 1, untilMs: until } }), 2);
  assert.deepEqual(routeSpecDriftFields(expected, reported(), label, { nowMs: NOW }), [], "还差 5 秒到期，机器已经当成没钉：不报");
  const expired = expectedRouteAgentSpec(policy(), 2);
  assert.deepEqual(routeSpecDriftFields(expired, reported({ pinnedIndex: 1, pinnedUntil: NOW - 3_000 }), label, { nowMs: NOW }), [], "刚过期 3 秒，机器还钉着：不报");
  assert.equal(routeSpecDriftFields(expired, reported({ pinnedIndex: 1, pinnedUntil: NOW - 60_000 }), label, { nowMs: NOW }).length, 1, "过期一分钟还钉着就是真不一致");
});

test("时段表、最短驻留、备用怎么候着、阈值的差异各报各的，字写成人话", () => {
  const schedule = { timezone: "Asia/Shanghai", windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] };
  const expected = expectedRouteAgentSpec(policy({ mode: "scheduled", schedule, minHoldSeconds: 600, delivery: "cold", failureThreshold: 2 }), 2);
  const fields = routeSpecDriftFields(expected, reported({ schedule: null, minHoldSeconds: 0, delivery: "hot", failureThreshold: 3, preferFastest: false }), label, { nowMs: NOW });
  const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
  assert.deepEqual(Object.keys(byKey).sort(), ["delivery", "failureThreshold", "minHold", "schedule"]);
  assert.equal(byKey.schedule.expected, "1 个时段");
  assert.equal(byKey.schedule.actual, "没有");
  assert.equal(byKey.minHold.expected, "10 分钟");
  assert.equal(byKey.minHold.actual, "0 秒");
  assert.equal(byKey.delivery.expected, "冷备");
  assert.equal(byKey.delivery.actual, "热备");
  assert.equal(byKey.failureThreshold.expected, "2 次");
});

test("Agent 报的原始 JSON：null 是没钉、省略的时段表是没有、老 Agent 没报就是 null", () => {
  assert.equal(parseRouteAgentSpec(undefined), null);
  assert.equal(parseRouteAgentSpec("x"), null);
  const spec = parseRouteAgentSpec({ pinnedIndex: null, minHoldSeconds: 60, preferFastest: true, strategy: "fallback", failoverSeconds: 3, recoverSeconds: 300, autoFailback: true, failureThreshold: 2, scoreMargin: 10, scoreHoldSeconds: 30, prewarmSeconds: 300, switchMode: "smooth", targetCount: 2 });
  assert.ok(spec);
  assert.equal(spec.pinnedIndex, null);
  assert.equal(spec.schedule, null);
  assert.equal(spec.delivery, "cold", "没带 delivery 就是冷备");
  const pinned = parseRouteAgentSpec({ pinnedIndex: 1, pinnedUntil: NOW + 1000, targetCount: 2 });
  assert.equal(pinned?.pinnedIndex, 1);
  assert.equal(pinned?.pinnedUntil, NOW + 1000);
});

test("配置刚改完的那 20 秒里机器报的还是旧的，不拿来比", () => {
  const changedAt = NOW;
  assert.equal(routeSpecReportUsable(changedAt + 5_000, changedAt), false);
  assert.equal(routeSpecReportUsable(changedAt + ROUTE_SPEC_DRIFT_GRACE_MS, changedAt), true);
  assert.equal(routeSpecReportUsable(0, changedAt), false, "没报过不比");
});
