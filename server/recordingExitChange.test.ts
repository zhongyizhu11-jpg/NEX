import assert from "node:assert/strict";
import test from "node:test";
import type { LiveExit, LiveRuleReport } from "./balanceLive";
import { recordingExitChanges, resetRecordingExitsForTest } from "./exitTargetHealth";

/*
  2.3.559 复现：出口机要不要探某条规则的目标，是完整心跳里按「此刻在用哪台」分派的（server/heartbeat/forwardGroupProbes.ts）。
  入口把流量从 jinx(7) 换到 hep ix(12) 之后，两台出口机都还在稳定快路径上（5 分钟才完整核对一次）：
  hep ix 拿不到这条探测，jinx 照旧探、结果因为「不是在用的那台」被丢掉 —— 卡片上的延迟空好几分钟。
  在用的那台一变，就要把新旧两台的快路径作废、叫它们马上重新心跳。
*/
const exit = (hostId: number, state: LiveExit["state"], share: number | null): LiveExit => ({
  hostId, hostName: `主机 ${hostId}`, host: `198.51.100.${hostId}`, port: 24000 + hostId, state, reason: null, share, picks: 10,
  medianMs: 8, exitMs: 5, targetMs: 3, targetLatencyUnknown: false, jitterMs: 1, lossPct: 0, samples: 10, udpState: null, peerOutdated: false,
});
const report = (carrying: number): LiveRuleReport => ({
  ruleId: 33, tunnelId: 5, entryHostId: 9, entryHostName: "入口", strategy: "fallback", targetAware: false, source: "agent",
  exits: [7, 12, 2].map((hostId) => exit(hostId, hostId === carrying ? "active" : "standby", hostId === carrying ? 1 : null)),
  events: [], at: Date.now(),
});

test("在用的出口换了：新旧两台出口机都要马上重算探测分派；没换、或者第一次见到（面板刚启动）不打扰", () => {
  resetRecordingExitsForTest();
  assert.deepEqual(recordingExitChanges([report(7)]), [], "第一次见到：面板刚启动，出口机的快路径本来就是空的");
  assert.deepEqual(recordingExitChanges([report(7)]), [], "没换");
  assert.deepEqual(recordingExitChanges([report(12)]).sort((a, b) => a - b), [7, 12], "jinx → hep ix");
  assert.deepEqual(recordingExitChanges([report(12)]), []);
  // 同一批里几条规则都换到同一台：每台只叫一次
  const other = { ...report(12), ruleId: 34 };
  recordingExitChanges([other]);
  assert.deepEqual(recordingExitChanges([report(2), { ...other, exits: report(2).exits }]).sort((a, b) => a - b), [2, 12]);
});
