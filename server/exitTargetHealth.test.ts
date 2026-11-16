import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BALANCE_DETECT } from "../shared/loadBalance";
import {
  EXIT_TARGET_STALE_MS,
  exitTargetExcludedHostIds,
  exitTargetProbeSpec,
  exitTargetSummaryForTunnel,
  exitTargetUnstable,
  latencyOrderedExitHostIds,
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

test("链路弹窗：延迟取各条规则的中位数，每台都连不上的规则算目标的问题", () => {
  resetExitTargetStates();
  const tunnel = { id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "least_load" };
  // 规则 7：两台都正常；规则 8：目标在国外，两台都慢；规则 9：两台都连不上（目标挂了）
  setExitTargetStateForTest(state({ hostId: 1, ruleId: 7, medianMs: 10 }));
  setExitTargetStateForTest(state({ hostId: 2, ruleId: 7, medianMs: 12 }));
  setExitTargetStateForTest(state({ hostId: 1, ruleId: 8, medianMs: 210 }));
  setExitTargetStateForTest(state({ hostId: 2, ruleId: 8, medianMs: 220 }));
  setExitTargetStateForTest(state({ hostId: 1, ruleId: 9, down: true }));
  setExitTargetStateForTest(state({ hostId: 2, ruleId: 9, down: true }));
  const summary = exitTargetSummaryForTunnel(tunnel, [1, 2]);
  assert.deepEqual(summary.exits.map((item) => [item.hostId, item.rules, item.down, item.medianMs]), [
    [1, 3, 0, 110],
    [2, 3, 0, 116],
  ]);
  assert.deepEqual(summary.targetIssues, [{ ruleId: 9, kind: "down" }]);
});

test("链路弹窗：只有一台连不上才记在那台头上", () => {
  resetExitTargetStates();
  const tunnel = { id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "fallback" };
  setExitTargetStateForTest(state({ hostId: 1, down: true }));
  setExitTargetStateForTest(state({ hostId: 2 }));
  const summary = exitTargetSummaryForTunnel(tunnel, [1, 2], { hostNames: new Map([[1, "A"], [2, "B"]]) });
  assert.deepEqual(summary.exits.map((item) => [item.hostId, item.down, item.activeRules]), [[1, 1, 0], [2, 0, 1]]);
  assert.deepEqual(summary.targetIssues, []);
  assert.equal(summary.how, "主备：走 B，1 台备用");
});

test("链路弹窗「怎么走」：NEX 延迟优先，差不到门槛的一起分，慢的备用", () => {
  resetExitTargetStates();
  const tunnel = { id: 3, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "latency" };
  setExitTargetStateForTest(state({ hostId: 1, medianMs: 10, jitterMs: 2 }));
  setExitTargetStateForTest(state({ hostId: 2, medianMs: 9, jitterMs: 26 }));
  setExitTargetStateForTest(state({ hostId: 3, medianMs: 180, jitterMs: 5 }));
  const summary = exitTargetSummaryForTunnel(tunnel, [1, 2, 3], { hostNames: new Map([[1, "A"], [2, "B"], [3, "C"]]) });
  assert.deepEqual(summary.exits.map((item) => item.activeRules), [1, 1, 0]);
  assert.equal(summary.how, "延迟优先：A、B（差不到 50ms，按负载分），1 台备用");
});

test("GOST 延迟优先：按延迟排顺序，差不多快时不来回换", () => {
  resetExitTargetStates();
  const detect = { ...DEFAULT_BALANCE_DETECT };
  setExitTargetStateForTest(state({ hostId: 1, ruleId: 20, medianMs: 40, jitterMs: 0, gost: true }));
  setExitTargetStateForTest(state({ hostId: 2, ruleId: 20, medianMs: 10, jitterMs: 0, gost: true }));
  setExitTargetStateForTest(state({ hostId: 3, ruleId: 20, down: true, gost: true }));
  assert.deepEqual(latencyOrderedExitHostIds(20, [1, 2, 3], detect), [2, 1, 3]);
  // 1 号变快了一点，但没快过 50ms：还是 2 号在前
  setExitTargetStateForTest(state({ hostId: 1, ruleId: 20, medianMs: 5, jitterMs: 0, gost: true }));
  assert.deepEqual(latencyOrderedExitHostIds(20, [1, 2, 3], detect), [2, 1, 3]);
  // 2 号慢到比 1 号多 50ms 以上：换
  setExitTargetStateForTest(state({ hostId: 2, ruleId: 20, medianMs: 90, jitterMs: 0, gost: true }));
  assert.deepEqual(latencyOrderedExitHostIds(20, [1, 2, 3], detect), [1, 2, 3]);
});
