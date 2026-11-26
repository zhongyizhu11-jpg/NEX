import assert from "node:assert/strict";
import test from "node:test";

import { resetBalanceLiveForTest, setBalanceLiveReportForTest, type LiveExit } from "./balanceLive";
import { recordTunnelExitLeg, resetRuleLatencyViewForTest } from "./ruleLatencyView";
import { tunnelExitChips } from "./tunnelExitChips";

/* 负载均衡链路卡上每台出口一个小标签（2.3.557）：只说出口组这一层 —— 入口到这台出口多快、入口分不分给它。 */
const TUNNEL = 1;
const now = Date.now();

function exit(hostId: number, state: LiveExit["state"], reason: LiveExit["reason"] = null, share: number | null = null): LiveExit {
  return {
    hostId, hostName: `h${hostId}`, host: `198.51.100.${hostId}`, port: 40000 + hostId, state, reason, share, picks: 0,
    medianMs: null, exitMs: null, targetMs: null, targetLatencyUnknown: false, jitterMs: null, lossPct: null, samples: 10,
    udpState: null, peerOutdated: false,
  };
}

function report(ruleId: number, exits: LiveExit[]) {
  setBalanceLiveReportForTest({
    ruleId, tunnelId: TUNNEL, entryHostId: 9, entryHostName: "入口", strategy: "round_robin", targetAware: false, source: "agent",
    exits, events: [], at: now,
  }, 9);
}

test("没有实时上报：测到的算通（不说分不分给它），没测到写不知道，离线的写连不上", () => {
  resetBalanceLiveForTest();
  resetRuleLatencyViewForTest();
  recordTunnelExitLeg(TUNNEL, 7, 7.4, now);
  recordTunnelExitLeg(TUNNEL, 12, 5, now);
  const chips = tunnelExitChips({ tunnelId: TUNNEL, exitHostIds: [7, 12, 2, 15], offlineHostIds: new Set([15]), nowMs: now });
  assert.deepEqual(chips.map((chip) => [chip.hostId, chip.state, chip.ms]), [[7, "ok", 7], [12, "ok", 5], [2, "unknown", null], [15, "down", null]]);
  assert.equal(chips[3].reason, "exit");
});

test("实时上报：几条规则里有一条在用就算在用；都备用是备用；都判坏才是坏，写明是哪一段", () => {
  resetBalanceLiveForTest();
  resetRuleLatencyViewForTest();
  recordTunnelExitLeg(TUNNEL, 7, 7, now);
  report(33, [exit(7, "down", "target"), exit(12, "active", null, 1), exit(2, "standby")]);
  report(8, [exit(7, "active", null, 0.5), exit(12, "active", null, 0.5), exit(2, "down", "exit")]);
  const chips = tunnelExitChips({ tunnelId: TUNNEL, exitHostIds: [7, 12, 2], nowMs: now });
  assert.deepEqual(chips.map((chip) => [chip.hostId, chip.state]), [[7, "active"], [12, "active"], [2, "standby"]]);
  assert.equal(chips[1].share, 0.75);

  report(8, [exit(7, "down", "target"), exit(12, "active", null, 1), exit(2, "down", "exit")]);
  const after = tunnelExitChips({ tunnelId: TUNNEL, exitHostIds: [7, 12, 2], nowMs: now });
  assert.deepEqual(after.map((chip) => [chip.hostId, chip.state, chip.reason]), [[7, "down", "target"], [12, "active", null], [2, "standby", null]]);
  assert.equal(after[0].ms, 7, "坏了也照样写到出口的数（到出口是通的，是目标那边不行）");
});
