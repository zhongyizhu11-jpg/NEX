import assert from "node:assert/strict";
import test from "node:test";

import {
  counterIncrease,
  DEFAULT_RESOURCE_ALERT_CONFIG,
  emptyLossWindowState,
  emptyResourceAlertHostState,
  evaluateLossSample,
  normalizeServiceRestarts,
  serviceRestartIncreases,
  evaluateResourceAlertSample,
  normalizeResourceAlertConfig,
  type ResourceAlertConfig,
  type ResourceAlertHostState,
  type ResourceAlertSample,
} from "./resourceAlert";

const config: ResourceAlertConfig = { ...DEFAULT_RESOURCE_ALERT_CONFIG, enabled: true, sustainSeconds: 60 };

function run(samples: Array<[number, ResourceAlertSample]>, cfg = config) {
  let state: ResourceAlertHostState = emptyResourceAlertHostState();
  const all = [];
  for (const [atSeconds, sample] of samples) {
    const result = evaluateResourceAlertSample(state, cfg, sample, atSeconds * 1000);
    state = result.state;
    all.push(...result.transitions.map((t) => ({ at: atSeconds, ...t })));
  }
  return { state, transitions: all };
}

test("一次冲高不报，持续超过才报", () => {
  assert.equal(run([[0, { cpu: 99 }], [10, { cpu: 20 }]]).transitions.length, 0);
  const { transitions } = run([[0, { cpu: 95 }], [30, { cpu: 97 }], [60, { cpu: 96 }]]);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].kind, "fire");
  assert.equal(transitions[0].metric, "cpu");
  assert.equal(transitions[0].peak, 97);
  assert.equal(transitions[0].durationSeconds, 60);
});

test("中间回落一次，计时从头算", () => {
  const { transitions } = run([[0, { cpu: 95 }], [40, { cpu: 50 }], [50, { cpu: 95 }], [100, { cpu: 95 }]]);
  assert.equal(transitions.length, 0);
});

test("告警期间只报一次，回落到阈值减回差以下才恢复", () => {
  const { transitions, state } = run([
    [0, { memory: 92 }],
    [60, { memory: 93 }],
    [120, { memory: 99 }],
    [180, { memory: 88 }], // 还在 85 以上，不算恢复
    [240, { memory: 84 }],
  ]);
  assert.deepEqual(transitions.map((t) => t.kind), ["fire", "recover"]);
  assert.equal(transitions[1].peak, 99);
  assert.equal(transitions[1].durationSeconds, 180);
  assert.equal(state.memory.firing, false);
});

test("缺数据不当作恢复", () => {
  const { transitions, state } = run([[0, { disk: 95 }], [60, { disk: 95 }], [120, {}], [180, { disk: null }]]);
  assert.deepEqual(transitions.map((t) => t.kind), ["fire"]);
  assert.equal(state.disk.firing, true);
});

test("关掉功能或把阈值设成 0，正在告警的直接清掉，不报恢复", () => {
  const firing = run([[0, { cpu: 95 }], [60, { cpu: 95 }]]).state;
  const off = evaluateResourceAlertSample(firing, { ...config, enabled: false }, { cpu: 10 }, 120_000);
  assert.equal(off.transitions.length, 0);
  assert.equal(off.state.cpu.firing, false);
  const zero = evaluateResourceAlertSample(firing, { ...config, cpuPercent: 0 }, { cpu: 99 }, 120_000);
  assert.equal(zero.transitions.length, 0);
  assert.equal(zero.state.cpu.firing, false);
});

test("各项指标互不影响", () => {
  const { transitions } = run([[0, { cpu: 95, memory: 50, disk: 95 }], [60, { cpu: 95, memory: 50, disk: 95 }]]);
  assert.deepEqual(transitions.map((t) => t.metric).sort(), ["cpu", "disk"]);
});

test("设置规整：脏值退回默认，阈值 0 保留、过低抬到 50", () => {
  const normalized = normalizeResourceAlertConfig({ enabled: "true", cpuPercent: "abc", memoryPercent: 0, diskPercent: 10, sustainSeconds: 5, recoverMarginPercent: 99 });
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.cpuPercent, DEFAULT_RESOURCE_ALERT_CONFIG.cpuPercent);
  assert.equal(normalized.memoryPercent, 0);
  assert.equal(normalized.diskPercent, 50);
  assert.equal(normalized.sustainSeconds, 30);
  assert.equal(normalized.recoverMarginPercent, 30);
  assert.equal(normalizeResourceAlertConfig(null).enabled, false);
});

test("累计计数器：基线、增长、重置", () => {
  assert.equal(counterIncrease(undefined, 5), 0);
  assert.equal(counterIncrease(3, 5), 2);
  assert.equal(counterIncrease(5, 5), 0);
  assert.equal(counterIncrease(9, 0), 0); // 机器重启后计数归零
});

test("服务重启：第一次见到只做基线，新出现的服务从 0 算，清零不报", () => {
  assert.deepEqual(serviceRestartIncreases(null, { "forwardx-runtime.service": 4 }), []);
  assert.deepEqual(
    serviceRestartIncreases({ "forwardx-runtime.service": 4 }, { "forwardx-runtime.service": 6, "forwardx-realm-3.service": 1 }),
    [
      { unit: "forwardx-realm-3.service", delta: 1, total: 1 },
      { unit: "forwardx-runtime.service", delta: 2, total: 6 },
    ],
  );
  assert.deepEqual(serviceRestartIncreases({ "forwardx-runtime.service": 4 }, {}), []);
});

test("serviceRestarts 规整：只认 forwardx-* 和非负整数", () => {
  assert.equal(normalizeServiceRestarts(null), null);
  assert.equal(normalizeServiceRestarts([1, 2]), null);
  assert.deepEqual(
    normalizeServiceRestarts({ "forwardx-runtime.service": 2, "sshd.service": 3, "forwardx-x": -1, "forwardx-y": 1.5, "forwardx-z;rm": 1 }),
    { "forwardx-runtime.service": 2 },
  );
});

test("丢包：探测数不够不判定，达到阈值报一次，回落到一半以下恢复", () => {
  let state = emptyLossWindowState();
  const t = (s: number) => s * 1000;
  let r = evaluateLossSample(state, 20, { count: 4, ok: 0 }, t(0));
  assert.equal(r.transition, null); // 只有 4 次探测
  state = r.state;
  r = evaluateLossSample(state, 20, { count: 6, ok: 4 }, t(30));
  assert.equal(r.transition?.kind, "fire"); // 10 次里丢 6 次
  assert.equal(r.transition?.lossPercent, 60);
  state = r.state;
  r = evaluateLossSample(state, 20, { count: 4, ok: 4 }, t(60));
  assert.equal(r.transition, null); // 已经在告警，不重复报
  state = r.state;
  // 窗口滑过去，早先的失败掉出窗口
  r = evaluateLossSample(state, 20, { count: 20, ok: 20 }, t(30 + 600));
  assert.equal(r.transition?.kind, "recover");
  assert.equal(r.transition?.peak, 60);
  assert.equal(r.state.firing, false);
});

test("丢包阈值 0 表示不报", () => {
  const r = evaluateLossSample(emptyLossWindowState(), 0, { count: 100, ok: 0 }, 0);
  assert.equal(r.transition, null);
  assert.equal(r.state.samples.length, 0);
});
