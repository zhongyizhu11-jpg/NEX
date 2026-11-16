import assert from "node:assert/strict";
import test from "node:test";
import {
  BALANCE_COMMON_STRATEGIES,
  BALANCE_CUSTOM_STRATEGIES,
  BALANCE_STRATEGIES,
  DEFAULT_BALANCE_DETECT,
  balanceStrategyForLegacyRuntime,
  balanceSwitchWithinSeconds,
  describeBalanceDetectShort,
  describeBalanceEffect,
  normalizeBalanceDetect,
  normalizeBalanceStrategy,
  serializeBalanceDetect,
} from "./loadBalance";

test("统一的分配方式：常用 3 个 + 自定义 5 个，一个不漏也不重复", () => {
  assert.deepEqual([...BALANCE_COMMON_STRATEGIES], ["auto", "fallback", "ip_hash"]);
  assert.deepEqual([...BALANCE_CUSTOM_STRATEGIES], ["latency", "least_load", "weighted", "round_robin", "random"]);
  assert.deepEqual(new Set([...BALANCE_COMMON_STRATEGIES, ...BALANCE_CUSTOM_STRATEGIES]), new Set(BALANCE_STRATEGIES));
});

test("老值：只用第一个当主备，least_conn 当按负载，空和认不出的算没选", () => {
  assert.equal(normalizeBalanceStrategy("none"), "fallback");
  assert.equal(normalizeBalanceStrategy("least_conn"), "least_load");
  assert.equal(normalizeBalanceStrategy("AUTO"), "auto");
  assert.equal(normalizeBalanceStrategy(""), null);
  assert.equal(normalizeBalanceStrategy("whatever"), null);
});

test("老 FXP 不认自动 / 延迟优先，换成按负载；别的照旧", () => {
  assert.equal(balanceStrategyForLegacyRuntime("auto"), "least_load");
  assert.equal(balanceStrategyForLegacyRuntime("latency"), "least_load");
  assert.equal(balanceStrategyForLegacyRuntime("weighted"), "weighted");
  assert.equal(balanceStrategyForLegacyRuntime(null), "round_robin");
});

test("检测参数：缺的按默认补，越界的夹回范围，坏 JSON 当默认", () => {
  assert.deepEqual(normalizeBalanceDetect(null), DEFAULT_BALANCE_DETECT);
  assert.deepEqual(normalizeBalanceDetect("{not json"), DEFAULT_BALANCE_DETECT);
  const detect = normalizeBalanceDetect({ intervalSeconds: 0.2, failThreshold: 99, jitterAction: "switch", slowStart: false });
  assert.equal(detect.intervalSeconds, 1);
  assert.equal(detect.failThreshold, 10);
  assert.equal(detect.jitterAction, "switch");
  assert.equal(detect.slowStart, false);
  assert.equal(detect.recoverThreshold, DEFAULT_BALANCE_DETECT.recoverThreshold);
  assert.equal(normalizeBalanceDetect(JSON.stringify({ jitterMs: 45 })).jitterMs, 45);
});

test("和默认一样存 null（以后改默认跟着走），不一样存 JSON", () => {
  assert.equal(serializeBalanceDetect({ ...DEFAULT_BALANCE_DETECT }), null);
  const stored = serializeBalanceDetect({ ...DEFAULT_BALANCE_DETECT, intervalSeconds: 5 });
  assert.equal(normalizeBalanceDetect(stored).intervalSeconds, 5);
});

test("默认参数：每 2 秒探一次、2 次不通算坏，约 5 秒内切走", () => {
  assert.equal(balanceSwitchWithinSeconds(DEFAULT_BALANCE_DETECT), 5);
  assert.equal(describeBalanceDetectShort(DEFAULT_BALANCE_DETECT), "每 2 秒探一次 · 2 次不通算坏 · 抖动超过 30ms 少分");
});

test("实际效果那句话跟着设置变", () => {
  const text = describeBalanceEffect({ strategy: "weighted", detect: DEFAULT_BALANCE_DETECT, weights: [5, 3, 2], memberNames: ["A", "B", "C"] });
  assert.match(text, /每 2 秒探一次，坏了约 5 秒内切走/);
  assert.match(text, /新连接按 5 : 3 : 2 分给 A、B、C/);
  assert.match(text, /抖动超过 30ms 持续 30 秒，就把它降到 4 分之 1/);
  const ignore = describeBalanceEffect({ strategy: "auto", detect: { ...DEFAULT_BALANCE_DETECT, jitterAction: "ignore" } });
  assert.doesNotMatch(ignore, /抖动超过/);
  assert.match(describeBalanceEffect({ strategy: "auto", detect: DEFAULT_BALANCE_DETECT, gost: true }), /GOST 隧道/);
});
