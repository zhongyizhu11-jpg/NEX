import assert from "node:assert/strict";
import test from "node:test";

import {
  recordRuleTargetLeg,
  recordTunnelExitLeg,
  resetRuleLatencyViewForTest,
  ruleChainLatency,
  ruleTunnelOf,
  tunnelExitLatency,
  forgetTunnelLatencyView,
  noteRuleSample,
  noteTunnelSample,
  ruleSample,
  tunnelSample,
  withRuleLiveSamples,
} from "./ruleLatencyView";

/*
  延迟口径（2026-11 用户：「转发延迟显示都不统一」）：卡上的数都是面板探的几段，和诊断一样。
  用户面板上规则 8：诊断 入口→hep ix 6 ms、hep ix→目标 3 ms、合计 9 ms；卡片原来写 16 ms（FXP 报的 exitMs 12.1 是握手时间）。
*/
const NOW = 1_800_000_000_000;

test("整链 = 入口到在用出口（链路探测）+ 在用出口到目标（出口机探测）：6 + 3 = 9", () => {
  resetRuleLatencyViewForTest();
  recordTunnelExitLeg(7, 3, 6, NOW - 20_000);
  recordRuleTargetLeg({ ruleId: 8, tunnelId: 7, exitHostId: 3, primaryHostId: 2, ms: 3, at: NOW - 10_000 });
  const chain = ruleChainLatency({ ruleId: 8, tunnelId: 7, exitHostId: 3, nowMs: NOW });
  assert.deepEqual(chain, { exitHostId: 3, totalMs: 9, exitMs: 6, targetMs: 3, at: NOW - 10_000 }, "at 是两段里新的那一段");
  assert.deepEqual(ruleTunnelOf(8), { tunnelId: 7, primaryHostId: 2 });
  // 负载均衡快速探测的中位数（4）和出口机 TCPing（3）不是一个数：有 TCPing 用 TCPing（诊断也是 TCPing），卡片才和诊断一样
  assert.equal(ruleChainLatency({ ruleId: 8, tunnelId: 7, exitHostId: 3, targetStateMs: 4, targetStateAt: NOW, nowMs: NOW })?.totalMs, 9);
  // TCPing 过期了（六分钟以前）才退回快速探测的中位数
  assert.equal(ruleChainLatency({ ruleId: 8, tunnelId: 7, exitHostId: 3, targetStateMs: 4, targetStateAt: NOW, nowMs: NOW + 7 * 60_000 }), null, "入口到出口那段也过期了");
  recordTunnelExitLeg(7, 3, 6, NOW + 7 * 60_000);
  assert.equal(ruleChainLatency({ ruleId: 8, tunnelId: 7, exitHostId: 3, targetStateMs: 4, targetStateAt: NOW + 7 * 60_000, nowMs: NOW + 7 * 60_000 })?.totalMs, 10);
});

test("缺一段返回 null（调用方退回规则的定时探测、再退回诊断）；超时把旧的清掉；过期的不算", () => {
  resetRuleLatencyViewForTest();
  recordTunnelExitLeg(7, 3, 6, NOW);
  assert.equal(ruleChainLatency({ ruleId: 8, tunnelId: 7, exitHostId: 3, nowMs: NOW }), null, "到目标那段没测到");
  recordRuleTargetLeg({ ruleId: 8, tunnelId: 7, exitHostId: 4, ms: 3, at: NOW });
  assert.equal(ruleChainLatency({ ruleId: 8, tunnelId: 7, exitHostId: 4, nowMs: NOW }), null, "入口到这台出口没测到");
  recordRuleTargetLeg({ ruleId: 8, tunnelId: 7, exitHostId: 3, ms: 3, at: NOW });
  assert.equal(ruleChainLatency({ ruleId: 8, tunnelId: 7, exitHostId: 3, nowMs: NOW })?.totalMs, 9);
  recordRuleTargetLeg({ ruleId: 8, tunnelId: 7, exitHostId: 3, ms: null, at: NOW + 1000 });
  assert.equal(ruleChainLatency({ ruleId: 8, tunnelId: 7, exitHostId: 3, nowMs: NOW }), null, "出口到目标超时了：没有整链");
  recordTunnelExitLeg(8, 3, 6, NOW - 7 * 60_000);
  assert.equal(tunnelExitLatency(8, 3, NOW), null, "六分钟以前的探测不算数");
});

test("实时样本：新的盖旧的、乱序回来的旧样本不盖新的；六分钟以前的不算", () => {
  resetRuleLatencyViewForTest();
  noteRuleSample({ ruleId: 5, hostId: 3, ms: 9, isTimeout: false, at: NOW });
  noteRuleSample({ ruleId: 5, hostId: 2, ms: null, isTimeout: true, at: NOW - 1000 });
  assert.deepEqual(ruleSample(5, NOW), { hostId: 3, ms: 9, isTimeout: false, at: NOW, source: "probe" });
  noteRuleSample({ ruleId: 5, hostId: 3, ms: 7, isTimeout: false, at: NOW + 1000, source: "diagnosis" });
  assert.equal(ruleSample(5, NOW + 1000)?.source, "diagnosis");
  assert.equal(ruleSample(5, NOW + 7 * 60_000), null);
  noteTunnelSample({ tunnelId: 1, ms: 12, isTimeout: false, at: NOW });
  assert.equal(tunnelSample(1, NOW)?.ms, 12);
  noteTunnelSample({ tunnelId: 1, isTimeout: true, at: NOW + 1 });
  assert.deepEqual(tunnelSample(1, NOW + 1), { ms: null, isTimeout: true, at: NOW + 1, source: "probe" });
  forgetTunnelLatencyView(1, [5]);
  assert.equal(tunnelSample(1, NOW + 1), null);
  assert.equal(ruleSample(5, NOW + 1000), null);
});

test("规则汇总补实时样本：诊断刚测完，卡片就是这次的数（用户：「诊断延迟返回后，规则还显示 7ms 8 分钟前」）", () => {
  resetRuleLatencyViewForTest();
  const dbRow = { ruleId: 9, latestLatencyMs: 7, latestLatencyIsTimeout: false, latestLatencyAt: new Date(NOW - 8 * 60_000), latestLatencySource: "probe" };
  noteRuleSample({ ruleId: 9, hostId: 3, ms: 12, isTimeout: false, at: NOW - 2_000, source: "diagnosis" });
  const [live] = withRuleLiveSamples([dbRow], NOW);
  assert.deepEqual([live.latestLatencyMs, live.latestLatencySource, (live.latestLatencyAt as Date).getTime()], [12, "diagnosis", NOW - 2_000]);
  // 数据库那条更新（刚写进去的）就用数据库的；转发组父规则的延迟是拼出来的，不盖；没有延迟字段的（累计流量）不加
  assert.equal(withRuleLiveSamples([{ ...dbRow, latestLatencyAt: new Date(NOW - 1_000) }], NOW)[0].latestLatencyMs, 7);
  assert.equal(withRuleLiveSamples([{ ...dbRow, latencyComposed: true }], NOW)[0].latestLatencyMs, 7);
  assert.equal("latestLatencyMs" in withRuleLiveSamples([{ ruleId: 9 }], NOW)[0], false);
  // 超时也照实盖上去
  noteRuleSample({ ruleId: 9, hostId: 3, isTimeout: true, at: NOW - 1_000 });
  assert.deepEqual([withRuleLiveSamples([dbRow], NOW)[0].latestLatencyIsTimeout, withRuleLiveSamples([dbRow], NOW)[0].latestLatencyMs], [true, null]);
});
