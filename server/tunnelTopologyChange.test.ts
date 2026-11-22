import assert from "node:assert/strict";
import test from "node:test";

import { forgetBalanceLiveTunnel, liveBalanceForRule, resetBalanceLiveForTest, setBalanceLiveReportForTest } from "./balanceLive";
import { exitTargetStatesForRule, forgetExitTargetTunnel, resetExitTargetStates, setExitTargetStateForTest } from "./exitTargetHealth";
import { forgetTunnelLatencyView, recordRuleTargetLeg, recordTunnelExitLeg, resetRuleLatencyViewForTest, ruleTargetLatency, ruleTunnelOf, tunnelExitLatency } from "./ruleLatencyView";

/*
  链路换拓扑后面板内存里的旧路线状态要整段忘掉（2.3.547，用户：「隧道换了出口，转发的不实时变过来？」）。
  实验室基线（GOST 链路、出口组 → 单出口）：流量 2 秒切走，规则卡的「经 3 台出口」35 秒才清、出口汇总 97 秒才跟上。
*/
const NOW = 1_800_000_000_000;

test("ruleLatencyView：忘掉这条链路的入口到出口、它上面各规则的出口到目标；别的链路不动", () => {
  resetRuleLatencyViewForTest();
  recordTunnelExitLeg(2, 3, 2, NOW);
  recordTunnelExitLeg(9, 3, 7, NOW);
  recordRuleTargetLeg({ ruleId: 3, tunnelId: 2, exitHostId: 3, primaryHostId: 2, ms: 1, at: NOW });
  recordRuleTargetLeg({ ruleId: 4, tunnelId: 2, exitHostId: 3, primaryHostId: 2, ms: 1, at: NOW });
  recordRuleTargetLeg({ ruleId: 50, tunnelId: 9, exitHostId: 3, primaryHostId: 3, ms: 5, at: NOW });
  forgetTunnelLatencyView(2, [3]);
  assert.equal(tunnelExitLatency(2, 3, NOW), null);
  assert.equal(ruleTargetLatency(3, 3, NOW), null);
  assert.equal(ruleTunnelOf(4), null, "没列出来、但记着是这条链路的规则也忘");
  assert.ok(tunnelExitLatency(9, 3, NOW));
  assert.ok(ruleTargetLatency(50, 3, NOW));
  // 只忘一条规则（规则自己换了隧道）
  forgetTunnelLatencyView(0, [50]);
  assert.equal(ruleTargetLatency(50, 3, NOW), null);
  assert.ok(tunnelExitLatency(9, 3, NOW), "链路的入口到出口不动");
});

test("exitTargetHealth：忘掉这些规则的出口快速探测状态", () => {
  resetExitTargetStates();
  const base = { tunnelId: 2, hostName: "出口2", down: false, unstable: false, latencyMs: 2, medianMs: 2, jitterMs: 0, lossPct: 0, at: NOW, probedAt: NOW, probeIntervalMs: 10_000 } as const;
  setExitTargetStateForTest({ ...base, ruleId: 3, hostId: 3 } as never);
  setExitTargetStateForTest({ ...base, ruleId: 50, tunnelId: 9, hostId: 3 } as never);
  assert.equal(exitTargetStatesForRule(3, NOW).length, 1);
  forgetExitTargetTunnel(2, [3]);
  assert.equal(exitTargetStatesForRule(3, NOW).length, 0);
  assert.equal(exitTargetStatesForRule(50, NOW).length, 1);
});

test("balanceLive：忘掉这条链路的入口实时上报（按链路或按规则都认）", () => {
  resetBalanceLiveForTest();
  const report = (ruleId: number, tunnelId: number) => ({
    ruleId,
    tunnelId,
    hostId: 1,
    source: "agent" as const,
    exits: [{ hostId: 3, hostName: "出口2", host: "10.77.0.22", port: 20085, state: "active" as const, picks: 10, share: 1, medianMs: 2 }],
    events: [],
    at: NOW,
  });
  setBalanceLiveReportForTest(report(3, 2) as never, 1);
  setBalanceLiveReportForTest(report(50, 9) as never, 1);
  assert.ok(liveBalanceForRule(3, NOW));
  forgetBalanceLiveTunnel(2, []);
  assert.equal(liveBalanceForRule(3, NOW), null);
  assert.ok(liveBalanceForRule(50, NOW));
  forgetBalanceLiveTunnel(0, [50]);
  assert.equal(liveBalanceForRule(50, NOW), null);
});
