import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RESOURCE_ALERT_CONFIG,
  emptyResourceAlertHostState,
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
