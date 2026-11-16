import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BALANCE_DETECT } from "../shared/loadBalance";
import {
  EXIT_TARGET_STALE_MS,
  exitTargetExcludedHostIds,
  exitTargetProbeSpec,
  exitTargetSummaryForTunnel,
  exitTargetUnstable,
  resetExitTargetStates,
  setExitTargetStateForTest,
  tunnelBalancesExits,
  withRuleExitTargets,
  type ExitTargetState,
} from "./exitTargetHealth";

function state(partial: Partial<ExitTargetState> & { hostId: number }): ExitTargetState {
  const now = Date.now();
  return {
    ruleId: 7,
    tunnelId: 3,
    hostName: `出口${partial.hostId}`,
    down: false,
    latencyMs: 40,
    medianMs: 40,
    jitterMs: 3,
    lossPct: 0,
    samples: 30,
    at: now,
    changedAt: now,
    unstable: false,
    gost: false,
    ...partial,
  };
}

test("负载均衡链路才算：开了、而且不是「只用第一个」", () => {
  assert.equal(tunnelBalancesExits({ id: 1, loadBalanceEnabled: true, loadBalanceStrategy: "auto" }), true);
  assert.equal(tunnelBalancesExits({ id: 1, loadBalanceEnabled: true, loadBalanceStrategy: "none" }), false);
  assert.equal(tunnelBalancesExits({ id: 1, loadBalanceEnabled: false, loadBalanceStrategy: "auto" }), false);
});

test("探测规格跟着链路的「检测与切换」：默认 2 秒一次、2 次不通算坏、3 次通算好", () => {
  assert.deepEqual(exitTargetProbeSpec(DEFAULT_BALANCE_DETECT), { intervalMs: 2000, timeoutMs: 2000, failThreshold: 2, recoverOks: 3 });
});

test("不稳：抖动或丢包超过门槛（样本太少不判）", () => {
  assert.equal(exitTargetUnstable({ jitterMs: 63, lossPct: 0, samples: 30 }, DEFAULT_BALANCE_DETECT), true);
  assert.equal(exitTargetUnstable({ jitterMs: 4, lossPct: 8.06, samples: 30 }, DEFAULT_BALANCE_DETECT), false);
  assert.equal(exitTargetUnstable({ jitterMs: 4, lossPct: 12, samples: 30 }, DEFAULT_BALANCE_DETECT), true);
  assert.equal(exitTargetUnstable({ jitterMs: 200, lossPct: 0, samples: 3 }, DEFAULT_BALANCE_DETECT), false);
  assert.equal(exitTargetUnstable({ jitterMs: 200, lossPct: 50, samples: 30 }, { ...DEFAULT_BALANCE_DETECT, jitterAction: "ignore" }), false);
});

test("GOST 摘出口：只摘连不上的；全都连不上、或剩下的没一台确认能通时一台都不摘", () => {
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, down: true }));
  setExitTargetStateForTest(state({ hostId: 2 }));
  assert.deepEqual([...exitTargetExcludedHostIds(7, [1, 2, 3])], [1]);
  setExitTargetStateForTest(state({ hostId: 2, down: true }));
  setExitTargetStateForTest(state({ hostId: 3, down: true }));
  assert.equal(exitTargetExcludedHostIds(7, [1, 2, 3]).size, 0, "三台都连不上：目标的问题，摘光等于断服");
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, down: true }));
  assert.equal(exitTargetExcludedHostIds(7, [1, 2]).size, 0, "另一台没报过（不知道能不能通）时不摘");
});

test("过期（90 秒没报）的状态当不知道", () => {
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, down: true, at: Date.now() - EXIT_TARGET_STALE_MS - 1000 }));
  setExitTargetStateForTest(state({ hostId: 2 }));
  assert.equal(exitTargetExcludedHostIds(7, [1, 2]).size, 0);
});

test("规则卡那一句：写清楚哪台连不上 / 抖 / 丢包；全都不行时说是目标的问题", () => {
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, hostName: "jinx(39.9y)", jitterMs: 63, unstable: true }));
  setExitTargetStateForTest(state({ hostId: 2, hostName: "Legend SG", down: true }));
  setExitTargetStateForTest(state({ hostId: 3, hostName: "jinx(29.9y)" }));
  const [row] = withRuleExitTargets([{ ruleId: 7 }]);
  assert.equal(row.exitTargetTotal, 3);
  assert.equal(row.exitTargetOk, 2);
  assert.equal(row.exitTargetNote, "3 台出口里 jinx(39.9y) 到目标抖动 63ms，已少分；Legend SG 连不上目标，已切走");
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, down: true }));
  setExitTargetStateForTest(state({ hostId: 2, down: true }));
  assert.match(String(withRuleExitTargets([{ ruleId: 7 }])[0].exitTargetNote), /多半是目标本身的问题/);
  const [plain] = withRuleExitTargets([{ ruleId: 99 }]);
  assert.equal(plain.exitTargetTotal, null);
});

test("GOST 隧道上的抖动只写出来，不说「已少分」", () => {
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, hostName: "A", lossPct: 12, unstable: true, gost: true }));
  setExitTargetStateForTest(state({ hostId: 2, hostName: "B", gost: true }));
  assert.equal(withRuleExitTargets([{ ruleId: 7 }])[0].exitTargetNote, "2 台出口里 A 到目标丢包 12%");
});

test("链路弹窗：每台出口取各条规则里最差的那次", () => {
  resetExitTargetStates();
  setExitTargetStateForTest(state({ hostId: 1, ruleId: 7, jitterMs: 5 }));
  setExitTargetStateForTest(state({ hostId: 1, ruleId: 8, jitterMs: 70, unstable: true }));
  setExitTargetStateForTest(state({ hostId: 2, ruleId: 7, down: true }));
  const summary = exitTargetSummaryForTunnel(3);
  assert.deepEqual(summary.map((item) => [item.hostId, item.rules, item.down, item.unstable, item.jitterMs]), [
    [1, 2, 0, 1, 70],
    [2, 1, 1, 0, 3],
  ]);
});
