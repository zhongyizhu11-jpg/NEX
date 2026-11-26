import assert from "node:assert/strict";
import test from "node:test";

import { setBalanceLiveReportForTest, resetBalanceLiveForTest, type LiveExit } from "./balanceLive";
import { resetExitTargetStates, ruleHasReachableExit, setExitTargetStateForTest, withRuleExitTargets, type ExitTargetState } from "./exitTargetHealth";
import { recordRuleTargetLeg, recordTunnelExitLeg, resetRuleLatencyViewForTest } from "./ruleLatencyView";

/*
  用户面板（2026-11-26）：高防目标 hkboil.ddos.top 一直拦着 jinx(39.9y)、Jinx(29.9y)，hep ix 通。
    · 卡片写「经 jinx(39.9y) · 14 ms」绿色，诊断却超时 —— 拿的是它一分钟一次定时探测里上一次成功的数；
    · 订阅「自动隐藏不通的节点」看规则的定时端到端探测（从主出口测，连着超时），节点被藏掉，流量其实在 hep ix 上照走。
*/
const RULE = 33;
const TUNNEL = 1;
const now = Date.now();

function exitState(hostId: number, hostName: string, down: boolean): ExitTargetState {
  return { ruleId: RULE, tunnelId: TUNNEL, hostId, hostName, down, latencyMs: down ? null : 3, medianMs: down ? null : 3, jitterMs: 0, lossPct: down ? 100 : 0, samples: 10, at: now, changedAt: now, unstable: false, gost: true, probedAt: now };
}

function liveExit(hostId: number, hostName: string, state: LiveExit["state"]): LiveExit {
  return { hostId, hostName, host: `198.51.100.${hostId}`, port: 40000 + hostId, state, reason: state === "down" ? "target" : null, share: state === "active" ? 1 : null, picks: 0, medianMs: null, exitMs: null, targetMs: null, targetLatencyUnknown: false, jitterMs: null, lossPct: null, samples: 10 } as LiveExit;
}

function setup(liveStates: Array<[number, string, LiveExit["state"]]> | null, down: Record<number, boolean>) {
  resetBalanceLiveForTest();
  resetExitTargetStates();
  resetRuleLatencyViewForTest();
  for (const [hostId, name] of [[7, "jinx(39.9y)"], [12, "hep ix"], [2, "Jinx(29.9y)"]] as const) {
    setExitTargetStateForTest(exitState(hostId, name, !!down[hostId]));
  }
  if (liveStates) {
    setBalanceLiveReportForTest({
      ruleId: RULE, tunnelId: TUNNEL, entryHostId: 9, entryHostName: "Po0(200M)", strategy: "fallback", targetAware: true, source: "agent",
      exits: liveStates.map(([hostId, name, state]) => liveExit(hostId, name, state)), events: [], at: now,
    }, 9);
  }
}

test("在用的出口快速探测已经连不上目标：卡片不拿它一分钟前那次成功的数写绿色", () => {
  // 入口还报着 jinx(39.9y) 在用（还没切走），快速探测已经说它连不上；它一分钟一次的定时探测上一次是 7 ms
  setup([[7, "jinx(39.9y)", "active"], [12, "hep ix", "standby"], [2, "Jinx(29.9y)", "down"]], { 7: true, 2: true });
  recordTunnelExitLeg(TUNNEL, 7, 7);
  recordRuleTargetLeg({ ruleId: RULE, tunnelId: TUNNEL, exitHostId: 7, primaryHostId: 7, ms: 7 });
  const [row] = withRuleExitTargets([{ ruleId: RULE, latestLatencyMs: 14, latestLatencyIsTimeout: false }], now);
  assert.equal(row.latestLatencyIsTimeout, true, "在用的出口连不上目标：不是绿色");
  assert.equal(row.latestLatencyChain, null);
  assert.equal(row.exitTargetOk, 1, "还有 hep ix 连得上：卡片是橙色（forwardRuleStatus），写明哪台连不上");

  // 入口切到 hep ix 了：整链照常
  setup([[7, "jinx(39.9y)", "down"], [12, "hep ix", "active"], [2, "Jinx(29.9y)", "down"]], { 7: true, 2: true });
  recordTunnelExitLeg(TUNNEL, 12, 5);
  recordRuleTargetLeg({ ruleId: RULE, tunnelId: TUNNEL, exitHostId: 12, primaryHostId: 7, ms: 3 });
  const [switched] = withRuleExitTargets([{ ruleId: RULE, latestLatencyMs: null, latestLatencyIsTimeout: true }], now);
  assert.equal(switched.latestLatencyIsTimeout, false, "主出口的定时探测超时，但流量在 hep ix 上：不标红");
  assert.equal(switched.latestLatencyMs, 8);
  assert.deepEqual(switched.exitTargetVia, ["hep ix"]);
});

test("订阅自动隐藏：负载均衡的规则还有一台出口连得上就不算不通", () => {
  setup([[7, "jinx(39.9y)", "down"], [12, "hep ix", "active"], [2, "Jinx(29.9y)", "down"]], { 7: true, 2: true });
  assert.equal(ruleHasReachableExit(RULE, now), true);

  // 入口报的在用那台，快速探测已经说连不上（还没切走）、别的也没在用：算不通
  setup([[7, "jinx(39.9y)", "active"], [12, "hep ix", "standby"], [2, "Jinx(29.9y)", "down"]], { 7: true, 2: true, 12: false });
  assert.equal(ruleHasReachableExit(RULE, now), false);

  // 没有入口上报：看快速探测里有没有一台通的
  setup(null, { 7: true, 2: true });
  assert.equal(ruleHasReachableExit(RULE, now), true);
  setup(null, { 7: true, 2: true, 12: true });
  assert.equal(ruleHasReachableExit(RULE, now), false);

  // 不是负载均衡的规则：没有数据，交回调用方照旧按探测判断
  resetBalanceLiveForTest();
  resetExitTargetStates();
  assert.equal(ruleHasReachableExit(999, now), null);
});
