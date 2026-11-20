import assert from "node:assert/strict";
import test from "node:test";

import { applyRuleCurrentLatency, describeRuleCurrentLatency } from "./diagnosisCurrentLatency";

/*
  用户面板（2026-11-20 23:14）：规则「广港us/2」诊断 入口→hep ix 6 + hep ix→目标 149 = 155，规则卡 159（5 + 153.8，23:16 测的）。
  用户：「弹窗测出来的延迟怎么和卡片上的不一样？」—— 弹窗画卡片那一份。
*/
const DIAGNOSIS_AT = "2026-11-20T15:14:53.000Z";
const parsed = {
  kind: "forward-via-tunnel",
  message: "隧道整体链路测试 成功; 出口到目标 zzy.example:19001 149ms; 入口到 hep ix 6ms",
  details: [
    { fromHostId: 9, toHostId: 12, hopIndex: 0, hopCount: 1, hopLabel: "1/1 9->12", routeLabel: "Po0(200M) -> hep ix", method: "tcp", pending: false, success: true, latencyMs: 6, message: "链路探测" },
    { success: true, latencyMs: 149, message: "解析到 108.171.195.157", fromHostId: 12, hopLabel: "出口 -> 目标 zzy.example:19001", routeLabel: "出口 -> 目标 zzy.example:19001", method: "tcp" },
  ],
  totalLatencyMs: 155,
  tunnelLatencyMs: 6,
};

test("卡片比诊断新：两段和合计换成卡片上的，合计正好是卡片的数", () => {
  const view = applyRuleCurrentLatency({
    parsed,
    diagnosisAt: DIAGNOSIS_AT,
    diagnosisSuccess: true,
    current: {
      latestLatencyMs: 159,
      latestLatencyIsTimeout: false,
      latestLatencyAt: "2026-11-20T15:16:57.045Z",
      latestLatencySource: "panel",
      latestLatencyChain: { exitHostId: 12, exitName: "hep ix", exitMs: 5, targetMs: 153.8 },
    },
  });
  assert.ok(view);
  assert.equal(view.latencyMs, 159);
  assert.equal(view.parsed.totalLatencyMs, 159);
  assert.equal(view.parsed.tunnelLatencyMs, 5);
  assert.deepEqual(view.parsed.details.map((detail) => detail.latencyMs), [5, 154]);
  assert.equal(view.parsed.details[0].routeLabel, "Po0(200M) -> hep ix", "出口没换，节点不动");
  assert.equal(describeRuleCurrentLatency(view, () => "11-20 23:16"), "延迟为 11-20 23:16 的定时探测，和规则卡一致");
});

test("诊断自己就是最新的（同一秒内）、卡片超时、卡片没数、诊断没通：照旧画诊断", () => {
  const current = { latestLatencyMs: 159, latestLatencyIsTimeout: false, latestLatencyAt: DIAGNOSIS_AT, latestLatencySource: "panel", latestLatencyChain: { exitHostId: 12, exitName: "hep ix", exitMs: 5, targetMs: 153.8 } };
  assert.equal(applyRuleCurrentLatency({ parsed, diagnosisAt: DIAGNOSIS_AT, diagnosisSuccess: true, current }), null);
  assert.equal(applyRuleCurrentLatency({ parsed, diagnosisAt: DIAGNOSIS_AT, diagnosisSuccess: true, current: { ...current, latestLatencyAt: "2026-11-20T15:14:53.900Z" } }), null, "数据库里诊断时间只到秒");
  assert.equal(applyRuleCurrentLatency({ parsed, diagnosisAt: DIAGNOSIS_AT, diagnosisSuccess: true, current: { ...current, latestLatencyAt: "2026-11-20T15:16:00Z", latestLatencyIsTimeout: true, latestLatencyMs: null } }), null);
  assert.equal(applyRuleCurrentLatency({ parsed, diagnosisAt: DIAGNOSIS_AT, diagnosisSuccess: true, current: null }), null);
  assert.equal(applyRuleCurrentLatency({ parsed, diagnosisAt: DIAGNOSIS_AT, diagnosisSuccess: false, current: { ...current, latestLatencyAt: "2026-11-20T15:16:00Z" } }), null);
  assert.equal(applyRuleCurrentLatency({ parsed, diagnosisAt: DIAGNOSIS_AT, diagnosisSuccess: true, current: { ...current, latestLatencyAt: "2026-11-20T15:16:00Z", latestLatencySource: "diagnosis" } }), null, "来源是诊断就是同一份");
});

test("在用出口换了：节点跟着卡片换（hep ix → jinx）", () => {
  const view = applyRuleCurrentLatency({
    parsed,
    diagnosisAt: DIAGNOSIS_AT,
    diagnosisSuccess: true,
    current: {
      latestLatencyMs: 12,
      latestLatencyIsTimeout: false,
      latestLatencyAt: "2026-11-20T15:20:00Z",
      latestLatencySource: "panel",
      latestLatencyChain: { exitHostId: 7, exitName: "jinx", exitMs: 7.4, targetMs: 4.2 },
    },
  });
  assert.ok(view);
  const [hop, target] = view.parsed.details;
  assert.equal(hop.toHostId, 7);
  assert.equal(hop.routeLabel, "Po0(200M) -> jinx");
  assert.equal(hop.hopLabel, "1/1 9->7");
  assert.equal(target.fromHostId, 7);
  assert.equal(target.routeLabel, "出口 -> 目标 zzy.example:19001", "「出口 -> 目标」这种写法不带名字，不动");
  assert.deepEqual([hop.latencyMs, target.latencyMs, view.parsed.totalLatencyMs], [7, 5, 12]);
});

test("直连规则：消息是一句话，换合计和那句里的延迟", () => {
  const view = applyRuleCurrentLatency({
    parsed: { message: "目标 172.81.104.158:45855 TCP可达，延迟 7ms", details: [], totalLatencyMs: null },
    diagnosisAt: DIAGNOSIS_AT,
    diagnosisSuccess: true,
    current: { latestLatencyMs: 9, latestLatencyIsTimeout: false, latestLatencyAt: "2026-11-20T15:20:17Z", latestLatencySource: "probe", latestLatencyChain: null },
  });
  assert.ok(view);
  assert.equal(view.latencyMs, 9);
  assert.equal(view.parsed.message, "目标 172.81.104.158:45855 TCP可达，延迟 9ms");
  assert.equal(view.parsed.totalLatencyMs, 9);
});

test("定时探测只有合计（没有两段）：两段多于一跳时只换合计", () => {
  const view = applyRuleCurrentLatency({
    parsed,
    diagnosisAt: DIAGNOSIS_AT,
    diagnosisSuccess: true,
    current: { latestLatencyMs: 157, latestLatencyIsTimeout: false, latestLatencyAt: "2026-11-20T15:20:17Z", latestLatencySource: "probe", latestLatencyChain: null },
  });
  assert.ok(view);
  assert.equal(view.parsed.totalLatencyMs, 157);
  assert.deepEqual(view.parsed.details.map((detail) => detail.latencyMs), [6, 149], "两段没有新的数，留着诊断的");
});
