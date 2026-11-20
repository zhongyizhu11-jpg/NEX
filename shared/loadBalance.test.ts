import assert from "node:assert/strict";
import test from "node:test";
import {
  BALANCE_COMMON_STRATEGIES,
  BALANCE_CUSTOM_STRATEGIES,
  BALANCE_STRATEGIES,
  BALANCE_SENSITIVITY_PRESETS,
  BALANCE_TARGET_PROBE_CHOICES,
  DEFAULT_BALANCE_DETECT,
  balanceDetectEquals,
  balanceSensitivityOf,
  balanceSwitchWithinSeconds,
  balanceStrategyHint,
  BALANCE_STRATEGY_LABELS,
  describeBalanceEffect,
  nginxBalanceBasicSupportNote,
  normalizeBalanceDetect,
  normalizeBalanceStrategy,
  serializeBalanceDetect,
} from "./loadBalance";

test("统一的分配方式：常用 3 个 + 自定义 5 个，一个不漏也不重复", () => {
  assert.deepEqual([...BALANCE_COMMON_STRATEGIES], ["auto"]);
  assert.deepEqual([...BALANCE_CUSTOM_STRATEGIES], ["latency", "fallback", "ip_hash", "least_load", "weighted", "round_robin", "random"]);
  assert.deepEqual(new Set([...BALANCE_COMMON_STRATEGIES, ...BALANCE_CUSTOM_STRATEGIES]), new Set(BALANCE_STRATEGIES));
});

test("老值：只用第一个当主备，least_conn 当按负载，空和认不出的算没选", () => {
  assert.equal(normalizeBalanceStrategy("none"), "fallback");
  assert.equal(normalizeBalanceStrategy("least_conn"), "least_load");
  assert.equal(normalizeBalanceStrategy("AUTO"), "auto");
  assert.equal(normalizeBalanceStrategy(""), null);
  assert.equal(normalizeBalanceStrategy("whatever"), null);
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

test("探目标和探出口机分开：三档的两个节拍，老数据没有 targetProbeSeconds 时按档推出来", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(BALANCE_SENSITIVITY_PRESETS).map(([key, preset]) => [key, [preset.detect.intervalSeconds, preset.detect.targetProbeSeconds]])),
    { sensitive: [1, 5], balanced: [2, 10], stable: [5, 30] },
  );
  assert.deepEqual([...BALANCE_TARGET_PROBE_CHOICES], [5, 10, 30, 60]);
  assert.equal(DEFAULT_BALANCE_DETECT.targetProbeSeconds, 10);
  for (const key of ["sensitive", "balanced", "stable"] as const) {
    const { targetProbeSeconds: _drop, ...legacy } = BALANCE_SENSITIVITY_PRESETS[key].detect;
    const restored = normalizeBalanceDetect(JSON.stringify(legacy));
    assert.equal(restored.targetProbeSeconds, BALANCE_SENSITIVITY_PRESETS[key].detect.targetProbeSeconds, key);
    assert.equal(balanceSensitivityOf(restored), key);
  }
  // 逐项改过的老数据：出口机间隔的 5 倍，至少 5 秒、最多 300 秒
  assert.equal(normalizeBalanceDetect({ intervalSeconds: 1, failThreshold: 4 }).targetProbeSeconds, 5);
  assert.equal(normalizeBalanceDetect({ intervalSeconds: 3 }).targetProbeSeconds, 15);
  assert.equal(normalizeBalanceDetect({ intervalSeconds: 60 }).targetProbeSeconds, 300);
  // 存了的照存的，越界夹回 2–300
  assert.equal(normalizeBalanceDetect({ ...DEFAULT_BALANCE_DETECT, targetProbeSeconds: 45 }).targetProbeSeconds, 45);
  assert.equal(normalizeBalanceDetect({ targetProbeSeconds: 1 }).targetProbeSeconds, 2);
  assert.equal(normalizeBalanceDetect({ targetProbeSeconds: 9999 }).targetProbeSeconds, 300);
  // 只改目标间隔就是自定义，也会存下来
  const custom = { ...DEFAULT_BALANCE_DETECT, targetProbeSeconds: 60 };
  assert.equal(balanceSensitivityOf(custom), null);
  assert.equal(balanceDetectEquals(custom, DEFAULT_BALANCE_DETECT), false);
  assert.equal(normalizeBalanceDetect(serializeBalanceDetect(custom)).targetProbeSeconds, 60);
  assert.equal(serializeBalanceDetect({ ...DEFAULT_BALANCE_DETECT, targetProbeSeconds: undefined }), null);
});

test("默认参数：每 2 秒探一次、2 次不通算坏，约 5 秒内切走", () => {
  assert.equal(balanceSwitchWithinSeconds(DEFAULT_BALANCE_DETECT), 5);
});

test("实际效果那句话跟着设置变", () => {
  const text = describeBalanceEffect({ strategy: "weighted", detect: DEFAULT_BALANCE_DETECT, weights: [5, 3, 2], memberNames: ["A", "B", "C"] });
  assert.match(text, /每 2 秒探一次出口机、每 10 秒探一次目标，坏了约 5 秒内切走/);
  assert.match(describeBalanceEffect({ strategy: "auto", detect: DEFAULT_BALANCE_DETECT, dns: true }), /^每 2 秒探一次，坏了约 5 秒内改解析/);
  assert.match(text, /新连接按 5 : 3 : 2 分给 A、B、C/);
  assert.match(text, /抖动超过 30ms 持续 30 秒，就把它降到 4 分之 1/);
  const ignore = describeBalanceEffect({ strategy: "auto", detect: { ...DEFAULT_BALANCE_DETECT, jitterAction: "ignore" } });
  assert.doesNotMatch(ignore, /抖动超过/);
  // GOST 隧道和 NEX 隧道一样由入口自己探、自己切：不再有「GOST 不能当场换出口」那句
  assert.doesNotMatch(describeBalanceEffect({ strategy: "auto", detect: DEFAULT_BALANCE_DETECT }), /GOST/);
  // Nginx 隧道不经统一调度：界面上另写一句「基础支持」
  assert.match(String(nginxBalanceBasicSupportNote("nginx_stream")), /^基础支持：/);
  assert.equal(nginxBalanceBasicSupportNote("tls"), null);
  assert.equal(nginxBalanceBasicSupportNote("forwardx"), null);
});

test("每种方式一句话：主备说清先用谁、什么时候换、什么时候切回；只转 UDP 时说新会话", () => {
  assert.equal(BALANCE_STRATEGY_LABELS.fallback.hint, "先用第一个，连不上才换下一个，恢复稳定后切回");
  assert.equal(balanceStrategyHint("round_robin"), "新连接一个一个轮着走");
  assert.equal(balanceStrategyHint("round_robin", true), "新会话一个一个轮着走");
  assert.match(balanceStrategyHint("least_load", true), /会话数/);
  for (const strategy of BALANCE_STRATEGIES) assert.ok(BALANCE_STRATEGY_LABELS[strategy].hint.length <= 48, strategy);
});
