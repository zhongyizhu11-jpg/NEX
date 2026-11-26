import assert from "node:assert/strict";
import test from "node:test";
import {
  BALANCE_COMMON_STRATEGIES,
  BALANCE_CUSTOM_STRATEGIES,
  BALANCE_STRATEGIES,
  BALANCE_SENSITIVITY_PRESETS,
  BALANCE_TARGET_PROBE_CHOICES,
  DEFAULT_BALANCE_DETECT,
  applyBalanceSensitivity,
  balanceDetectEquals,
  balanceDetectForRuntime,
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
    { sensitive: [2, 5], balanced: [10, 10], stable: [30, 30] },
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

test("默认参数：每 10 秒探一次、2 次不通算坏，约 25 秒内切走（2.3.544 三档 2 / 10 / 30 秒）", () => {
  assert.equal(balanceSwitchWithinSeconds(DEFAULT_BALANCE_DETECT), 25);
  assert.equal(balanceSwitchWithinSeconds(BALANCE_SENSITIVITY_PRESETS.sensitive.detect), 5);
  assert.equal(balanceSwitchWithinSeconds(BALANCE_SENSITIVITY_PRESETS.stable.detect), 105);
});

test("实际效果那句话跟着设置变", () => {
  const text = describeBalanceEffect({ strategy: "weighted", detect: DEFAULT_BALANCE_DETECT, weights: [5, 3, 2], memberNames: ["A", "B", "C"] });
  // 2.3.557 起默认只看出口组：不碰目标
  assert.match(text, /每 10 秒探一次出口机，出口机连不上约 25 秒内切走；不碰目标/);
  const withTarget = describeBalanceEffect({ strategy: "weighted", detect: { ...DEFAULT_BALANCE_DETECT, scope: "chain" } });
  assert.match(withTarget, /附加：每 10 秒查一次出口到目标，连不上目标的出口先不分/);
  assert.match(describeBalanceEffect({ strategy: "auto", detect: DEFAULT_BALANCE_DETECT, dns: true }), /^每 10 秒探一次，坏了约 25 秒内改解析/);
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

test("只走最快的一台：默认关、三档都关，老数据读出来是关；开了要存下来、能读回来", () => {
  assert.equal(DEFAULT_BALANCE_DETECT.fastestOnly, false);
  for (const preset of Object.values(BALANCE_SENSITIVITY_PRESETS)) assert.equal(preset.detect.fastestOnly, false);
  const legacy = { intervalSeconds: 5, targetProbeSeconds: 30, failThreshold: 3, recoverThreshold: 5, latencyMarginMs: 80, jitterMs: 50, jitterHoldSeconds: 60, jitterAction: "reduce", slowStart: true };
  assert.equal(normalizeBalanceDetect(JSON.stringify(legacy)).fastestOnly, false);
  assert.equal(normalizeBalanceDetect({ fastestOnly: "yes" }).fastestOnly, false, "不是布尔值的当没填");
  const on = { ...DEFAULT_BALANCE_DETECT, fastestOnly: true };
  const stored = serializeBalanceDetect(on);
  assert.notEqual(stored, null, "和默认不一样，要存");
  assert.equal(normalizeBalanceDetect(stored).fastestOnly, true);
  assert.equal(balanceDetectEquals(on, DEFAULT_BALANCE_DETECT), false);
  assert.equal(balanceDetectForRuntime(stored).fastestOnly, true, "交给 FXP 的检测参数里带着它");
});

test("只走最快的一台不算灵敏度：开着照样是那一档，换档时留着它", () => {
  const on = { ...BALANCE_SENSITIVITY_PRESETS.stable.detect, fastestOnly: true };
  assert.equal(balanceSensitivityOf(on), "stable");
  assert.equal(balanceSensitivityOf({ ...DEFAULT_BALANCE_DETECT, fastestOnly: true }), "balanced");
  const switched = applyBalanceSensitivity(on, "sensitive");
  assert.equal(switched.fastestOnly, true);
  assert.equal(switched.intervalSeconds, BALANCE_SENSITIVITY_PRESETS.sensitive.detect.intervalSeconds);
  // 老数据没有 targetProbeSeconds 时按档推，开着它也认得出是哪一档
  const { targetProbeSeconds: _drop, ...noTarget } = on;
  assert.equal(normalizeBalanceDetect(noTarget).targetProbeSeconds, BALANCE_SENSITIVITY_PRESETS.stable.detect.targetProbeSeconds);
});

test("只走最快的一台：分配方式那一句、实际效果那一句都说它；只对延迟优先", () => {
  const on = { ...DEFAULT_BALANCE_DETECT, fastestOnly: true };
  assert.equal(balanceStrategyHint("latency"), BALANCE_STRATEGY_LABELS.latency.hint, "不给检测参数时还是原来那句");
  assert.match(balanceStrategyHint("latency", false, on), /只走最快的一台，别的候补；快出门槛且稳 60 秒才换/);
  assert.equal(balanceStrategyHint("auto", false, on), BALANCE_STRATEGY_LABELS.auto.hint);
  assert.match(describeBalanceEffect({ strategy: "latency", detect: on }), /延迟优先：只走最快的一台，别的候补；快出 50ms 且稳 60 秒才换/);
  assert.doesNotMatch(describeBalanceEffect({ strategy: "latency", detect: DEFAULT_BALANCE_DETECT }), /只走最快的一台/);
  assert.doesNotMatch(describeBalanceEffect({ strategy: "auto", detect: on }), /只走最快的一台/);
});

test("负载均衡看哪一段：2.3.557 起默认只看出口组（新建、老数据都是）；附加检查要自己打开；不算灵敏度，换档留着", async () => {
  const { normalizeBalanceDetect, serializeBalanceDetect, balanceSensitivityOf, applyBalanceSensitivity, describeBalanceEffect, DEFAULT_BALANCE_DETECT: defaults, BALANCE_SENSITIVITY_PRESETS: presets } = await import("./loadBalance");
  assert.equal(defaults.scope, "tunnel");
  for (const preset of Object.values(presets)) assert.equal(preset.detect.scope, "tunnel", "三档都是只看出口组");
  assert.equal(normalizeBalanceDetect('{"intervalSeconds":60}').scope, "tunnel", "老数据没有这一项：关");
  assert.equal(normalizeBalanceDetect(null).scope, "tunnel");
  assert.equal(normalizeBalanceDetect({ scope: "chain" }).scope, "chain");
  assert.equal(normalizeBalanceDetect({ scope: "bogus" }).scope, "tunnel");
  const chain = normalizeBalanceDetect({ ...defaults, scope: "chain" });
  assert.equal(balanceSensitivityOf(chain), "balanced", "附加检查不影响「均衡」这一档的判断");
  assert.equal(applyBalanceSensitivity(chain, "stable").scope, "chain", "换档留着");
  assert.notEqual(serializeBalanceDetect(chain), null, "打开了附加检查：要存");
  assert.equal(serializeBalanceDetect(defaults), null);
  assert.match(describeBalanceEffect({ strategy: "latency", detect: defaults }), /不碰目标/);
  assert.match(describeBalanceEffect({ strategy: "latency", detect: chain }), /出口到目标/);
});
