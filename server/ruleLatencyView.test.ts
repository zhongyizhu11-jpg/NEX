import assert from "node:assert/strict";
import test from "node:test";

import {
  recordRuleTargetLeg,
  recordTunnelExitLeg,
  resetRuleLatencyViewForTest,
  ruleChainLatency,
  ruleTunnelOf,
  tunnelExitLatency,
  tunnelInUseExitLatency,
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
  assert.deepEqual(chain, { exitHostId: 3, totalMs: 9, exitMs: 6, targetMs: 3, at: NOW - 20_000 });
  assert.deepEqual(ruleTunnelOf(8), { tunnelId: 7, primaryHostId: 2 });
  // 负载均衡快速探测里这台出口到目标的中位数更新：优先用它
  assert.equal(ruleChainLatency({ ruleId: 8, tunnelId: 7, exitHostId: 3, targetStateMs: 4, targetStateAt: NOW, nowMs: NOW })?.totalMs, 10);
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

test("链路卡「到出口」：在用一台写一个数，几台写区间；扛流量的那台写名字", () => {
  resetRuleLatencyViewForTest();
  recordTunnelExitLeg(1, 2, 7, NOW);
  recordTunnelExitLeg(1, 3, 5, NOW);
  recordTunnelExitLeg(1, 4, 6, NOW);
  const names = new Map([[2, "jinx"], [3, "hep ix"], [4, "Jinx2"]]);
  const hostName = (id: number) => names.get(id) || "";
  assert.deepEqual(tunnelInUseExitLatency({ tunnelId: 1, inUseHostIds: [3], hostName, nowMs: NOW }), {
    exitHostId: 3, exitName: "hep ix", exitMs: 5, lowMs: 5, highMs: 5, inUse: 1, at: NOW,
  });
  const several = tunnelInUseExitLatency({ tunnelId: 1, inUseHostIds: [4, 3, 2], hostName, nowMs: NOW });
  assert.deepEqual([several?.exitName, several?.exitMs, several?.lowMs, several?.highMs, several?.inUse], ["Jinx2", 6, 5, 7, 3]);
  // 在用的那台没测到：只算测到的；一台都没有返回 null（链路卡退回链路探测的总数）
  assert.equal(tunnelInUseExitLatency({ tunnelId: 1, inUseHostIds: [9, 3], hostName, nowMs: NOW })?.inUse, 1);
  assert.equal(tunnelInUseExitLatency({ tunnelId: 1, inUseHostIds: [9], hostName, nowMs: NOW }), null);
});
