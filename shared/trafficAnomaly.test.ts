import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TRAFFIC_ANOMALY_CONFIG,
  TRAFFIC_BUCKET_SECONDS,
  combineRuleRateWithThrottle,
  computeTrafficBaseline,
  emptyAnomalyState,
  isAnomalyStateIdle,
  judgeAnomalySample,
  normalizeTrafficAnomalyConfig,
  shouldApplyThrottle,
  trafficAnomalyThreshold,
  trafficThrottleMbps,
  type AnomalyState,
  type TrafficBucketSample,
} from "./trafficAnomaly";

const NOW_SEC = 1_800_000_000; // 对齐到半小时
const MIN = 60_000;

/** 每档都按 mbps（较大的一向）造一份分桶。 */
function bucketsAt(mbps: (slotStart: number) => number, fromSec: number, toSec: number): TrafficBucketSample[] {
  const out: TrafficBucketSample[] = [];
  for (let slot = Math.ceil(fromSec / TRAFFIC_BUCKET_SECONDS) * TRAFFIC_BUCKET_SECONDS; slot < toSec; slot += TRAFFIC_BUCKET_SECONDS) {
    const bytes = (mbps(slot) * 1_000_000 / 8) * TRAFFIC_BUCKET_SECONDS;
    out.push({ bucketStart: slot, bytesIn: bytes / 10, bytesOut: bytes });
  }
  return out;
}

test("默认是关着的，自动限速也是关着的", () => {
  assert.equal(DEFAULT_TRAFFIC_ANOMALY_CONFIG.enabled, false);
  assert.equal(DEFAULT_TRAFFIC_ANOMALY_CONFIG.autoThrottle, false);
  const fromEmpty = normalizeTrafficAnomalyConfig({});
  assert.equal(fromEmpty.enabled, false);
  assert.equal(fromEmpty.sensitivity, "normal");
  assert.equal(fromEmpty.multiplier, 5);
  assert.equal(fromEmpty.minMbps, 50);
});

test("选了三档之一时阈值一律按那一档，选自定义才用自己填的、并且夹在范围里", () => {
  const preset = normalizeTrafficAnomalyConfig({ sensitivity: "high", multiplier: 99, minMbps: 1 });
  assert.equal(preset.multiplier, 3);
  assert.equal(preset.minMbps, 20);
  assert.equal(preset.sustainMinutes, 5);
  const custom = normalizeTrafficAnomalyConfig({ sensitivity: "custom", multiplier: 1, minMbps: 0, sustainMinutes: 500, ipConnThreshold: 0, enabled: "true" });
  assert.equal(custom.multiplier, 2);
  assert.equal(custom.minMbps, 1);
  assert.equal(custom.sustainMinutes, 120);
  assert.equal(custom.ipConnThreshold, 0, "填 0 = 不看连接数");
  assert.equal(custom.enabled, true);
});

test("基线：平稳的 10 Mbps 跑了两天，基线就是 10，最近一小时的冲高不算进去", () => {
  const buckets = bucketsAt((slot) => (slot >= NOW_SEC - 3600 ? 500 : 10), NOW_SEC - 48 * 3600, NOW_SEC);
  const baseline = computeTrafficBaseline(buckets, { nowSec: NOW_SEC, historyStart: NOW_SEC - 48 * 3600 });
  assert.ok(baseline);
  assert.equal(baseline.medianMbps, 10);
  assert.equal(baseline.baselineMbps, 10);
  assert.ok(baseline.historyHours >= 46);
});

test("基线：每天晚高峰的那个时段，同时段的典型值把基线抬上去，晚高峰不会被当成突增", () => {
  // 平时 5 Mbps，每天「现在」这个点前后一小时 80 Mbps。
  const peak = (slot: number) => {
    const secondsOfDay = ((slot - NOW_SEC) % 86400 + 86400) % 86400;
    return secondsOfDay < 3600 || secondsOfDay > 86400 - 3600 ? 80 : 5;
  };
  const baseline = computeTrafficBaseline(bucketsAt(peak, NOW_SEC - 72 * 3600, NOW_SEC), { nowSec: NOW_SEC, historyStart: 0 });
  assert.ok(baseline);
  assert.equal(baseline.medianMbps, 5);
  assert.equal(baseline.sameSlotMbps, 80);
  assert.equal(baseline.baselineMbps, 80);
});

test("基线：建起来不满 24 小时的新规则没有基线（不判）", () => {
  const buckets = bucketsAt(() => 10, NOW_SEC - 20 * 3600, NOW_SEC);
  assert.equal(computeTrafficBaseline(buckets, { nowSec: NOW_SEC, historyStart: NOW_SEC - 20 * 3600 }), null);
});

test("基线：老规则三天没流量，平时就是 0（突然跑起来是要报的）", () => {
  const baseline = computeTrafficBaseline([], { nowSec: NOW_SEC, historyStart: NOW_SEC - 30 * 86400 });
  assert.ok(baseline);
  assert.equal(baseline.baselineMbps, 0);
  assert.equal(trafficAnomalyThreshold(baseline.baselineMbps, { multiplier: 5, minMbps: 50 }), 50, "基线 0 时异常线就是绝对下限");
});

test("异常线 = 基线 × 倍数 和 绝对下限 取大的；没有基线就没有线", () => {
  assert.equal(trafficAnomalyThreshold(20, { multiplier: 5, minMbps: 50 }), 100);
  assert.equal(trafficAnomalyThreshold(4, { multiplier: 5, minMbps: 50 }), 50);
  assert.equal(trafficAnomalyThreshold(null, { multiplier: 5, minMbps: 50 }), null);
  assert.equal(trafficThrottleMbps(57.2), 58);
});

const OPTIONS = { sustainMs: 10 * MIN, cooldownMs: 360 * MIN };

function run(state: AnomalyState, samples: Array<{ at: number; value: number; threshold: number | null }>) {
  const transitions = [];
  let current = state;
  for (const sample of samples) {
    const result = judgeAnomalySample(current, { value: sample.value, threshold: sample.threshold, baseline: 10 }, { ...OPTIONS, nowMs: sample.at });
    current = result.state;
    if (result.transition) transitions.push(result.transition);
  }
  return { state: current, transitions };
}

function minutes(from: number, count: number, value: number, threshold: number | null = 50) {
  return Array.from({ length: count }, (_, i) => ({ at: from + i * MIN, value, threshold }));
}

test("要连续超线够持续时间才报：冲高 5 分钟又回去不报，连续 10 分钟才报一次", () => {
  const t0 = 1_000 * MIN;
  const brief = run(emptyAnomalyState(), [...minutes(t0, 5, 200), ...minutes(t0 + 5 * MIN, 3, 10)]);
  assert.equal(brief.transitions.length, 0);
  assert.equal(brief.state.firing, false);
  const sustained = run(emptyAnomalyState(), minutes(t0, 12, 200));
  assert.equal(sustained.transitions.length, 1);
  assert.equal(sustained.transitions[0].kind, "fire");
  assert.equal(sustained.transitions[0].notify, true);
  assert.equal(sustained.state.firing, true);
});

test("没有基线（threshold 为 null）的对象从不报", () => {
  const result = run(emptyAnomalyState(), minutes(0, 30, 10_000, null));
  assert.equal(result.transitions.length, 0);
});

test("恢复要回落到异常线的 70% 以下、同样连续那么久；在线附近来回不算恢复", () => {
  const t0 = 0;
  const fired = run(emptyAnomalyState(), minutes(t0, 11, 200));
  assert.equal(fired.state.firing, true);
  const hovering = run(fired.state, minutes(t0 + 11 * MIN, 20, 40)); // 40 ≥ 50 × 0.7
  assert.equal(hovering.transitions.length, 0);
  assert.equal(hovering.state.firing, true);
  const recovered = run(hovering.state, minutes(t0 + 31 * MIN, 11, 10));
  assert.equal(recovered.transitions.length, 1);
  const transition = recovered.transitions[0];
  assert.equal(transition.kind, "recover");
  assert.equal(transition.notify, true);
  if (transition.kind === "recover") assert.equal(transition.peak, 200);
});

test("冷却：报过一次后冷却期内再犯不发事件，对应的恢复也不发；冷却过了照常报", () => {
  const t0 = 0;
  const first = run(emptyAnomalyState(), [...minutes(t0, 11, 200), ...minutes(t0 + 11 * MIN, 11, 0)]);
  assert.deepEqual(first.transitions.map((item) => [item.kind, item.notify]), [["fire", true], ["recover", true]]);
  const again = run(first.state, [...minutes(t0 + 60 * MIN, 11, 200), ...minutes(t0 + 71 * MIN, 11, 0)]);
  assert.deepEqual(again.transitions.map((item) => [item.kind, item.notify]), [["fire", false], ["recover", false]]);
  const later = run(again.state, minutes(t0 + 400 * MIN, 11, 200));
  assert.deepEqual(later.transitions.map((item) => [item.kind, item.notify]), [["fire", true]]);
});

test("告警时冻住异常线：之后基线变了也按告警那一刻的线判恢复", () => {
  const fired = run(emptyAnomalyState(), minutes(0, 11, 200, 50));
  assert.equal(fired.state.threshold, 50);
  // 新算出来的线是 500，但冻住的是 50：120 仍然算异常，不恢复。
  const result = run(fired.state, minutes(11 * MIN, 15, 120, 500));
  assert.equal(result.transitions.length, 0);
  assert.equal(result.state.firing, true);
});

test("采样中断太久（面板卡住）不往下接着算连续", () => {
  const result = run(emptyAnomalyState(), [...minutes(0, 6, 200), ...minutes(30 * MIN, 6, 200)]);
  assert.equal(result.transitions.length, 0);
});

test("状态闲下来（没告警、冷却过了）才能丢", () => {
  const fired = run(emptyAnomalyState(), minutes(0, 11, 200)).state;
  assert.equal(isAnomalyStateIdle(fired, 20 * MIN, OPTIONS.cooldownMs), false);
  const recovered = run(fired, minutes(11 * MIN, 11, 0)).state;
  assert.equal(isAnomalyStateIdle(recovered, 30 * MIN, OPTIONS.cooldownMs), false, "冷却还没过，要记着");
  assert.equal(isAnomalyStateIdle(recovered, 400 * MIN, OPTIONS.cooldownMs), true);
});

test("临时限速和手动限速取严的那个，到期就不再叠；手动的数原样不动", () => {
  const now = 1_000_000;
  const throttle = { mbps: 60, expiresAt: now + MIN };
  assert.equal(combineRuleRateWithThrottle(0, throttle, now), 60);
  assert.equal(combineRuleRateWithThrottle(500, throttle, now), 60);
  assert.equal(combineRuleRateWithThrottle(20, throttle, now), 20, "手动的更严：还是手动的");
  assert.equal(combineRuleRateWithThrottle(500, throttle, now + 2 * MIN), 500, "到期了回到手动那个数");
  assert.equal(combineRuleRateWithThrottle(500, null, now), 500);
});

test("手动限速已经不比临时的松，就不加临时限速", () => {
  assert.equal(shouldApplyThrottle(0, 60), true);
  assert.equal(shouldApplyThrottle(100, 60), true);
  assert.equal(shouldApplyThrottle(60, 60), false);
  assert.equal(shouldApplyThrottle(20, 60), false);
});
