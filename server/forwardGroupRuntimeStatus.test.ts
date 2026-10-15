import assert from "node:assert/strict";
import test from "node:test";
import { summarizeForwardGroupRuntime } from "./forwardGroupRuntimeStatus";

test("forward group runtime requires every expected managed child listener", () => {
  const base = {
    group: { id: 1, groupMode: "failover", isEnabled: true },
    members: [
      { id: 11, isEnabled: true },
      { id: 12, isEnabled: true },
    ],
    templateRules: [{ id: 100, isEnabled: true, pendingDelete: false }],
  };

  const partial = summarizeForwardGroupRuntime({
    ...base,
    childRules: [
      { id: 101, forwardGroupRuleId: 100, forwardGroupMemberId: 11, isEnabled: true, isRunning: true, pendingDelete: false },
      { id: 103, forwardGroupRuleId: 100, forwardGroupMemberId: 11, isEnabled: true, isRunning: true, pendingDelete: false },
    ],
  });
  assert.equal(partial.status, "degraded");
  assert.equal(partial.expectedRuleCount, 2);
  assert.equal(partial.runningRuleCount, 1);
  assert.equal(partial.failedRuleCount, 1);
  assert.equal(partial.ruleStatuses[0]?.status, "degraded");

  const healthy = summarizeForwardGroupRuntime({
    ...base,
    childRules: [
      { id: 101, forwardGroupRuleId: 100, forwardGroupMemberId: 11, isEnabled: true, isRunning: true, pendingDelete: false },
      { id: 102, forwardGroupRuleId: 100, forwardGroupMemberId: 12, isEnabled: true, isRunning: true, pendingDelete: false },
    ],
  });
  assert.equal(healthy.status, "running");
  assert.equal(healthy.failedRuleCount, 0);
});

test("forward chain runtime includes external entry listeners", () => {
  const summary = summarizeForwardGroupRuntime({
    group: { id: 2, groupMode: "chain", entryGroupId: 9, isEnabled: true },
    members: [{ id: 21, hostId: 201, isEnabled: true }, { id: 22, hostId: 202, isEnabled: true }],
    entryMembers: [{ id: 91, hostId: 901, isEnabled: true }, { id: 92, hostId: 902, isEnabled: true }],
    templateRules: [{ id: 200, isEnabled: true, pendingDelete: false }],
    childRules: [],
  });

  assert.equal(summary.status, "pending");
  assert.equal(summary.expectedRuleCount, 4);
  assert.equal(summary.ruleStatuses[0]?.expectedRuleCount, 4);
});

test("saved forward group without template rules remains idle", () => {
  const summary = summarizeForwardGroupRuntime({
    group: { id: 3, groupMode: "port", isEnabled: true },
    members: [{ id: 31, isEnabled: true }],
  });
  assert.equal(summary.status, "idle");
  assert.equal(summary.expectedRuleCount, 0);
});

test("多台入口的端口转发：每台入口算一个托管监听，少一台在跑就是 degraded（2 / 3）", () => {
  const summary = summarizeForwardGroupRuntime({
    group: { id: 4, groupMode: "port", isEnabled: true },
    members: [{ id: 41, hostId: 401, isEnabled: true }, { id: 42, hostId: 402, isEnabled: true }, { id: 43, hostId: 403, isEnabled: true }],
    templateRules: [{ id: 400, isEnabled: true, pendingDelete: false }],
    childRules: [
      { id: 4001, hostId: 401, forwardGroupRuleId: 400, forwardGroupMemberId: 41, isEnabled: true, isRunning: true },
      { id: 4002, hostId: 402, forwardGroupRuleId: 400, forwardGroupMemberId: 42, isEnabled: true, isRunning: true },
      { id: 4003, hostId: 403, forwardGroupRuleId: 400, forwardGroupMemberId: 43, isEnabled: true, isRunning: false },
    ],
  });
  assert.equal(summary.status, "degraded");
  assert.equal(summary.expectedRuleCount, 3);
  assert.equal(summary.runningRuleCount, 2);
  assert.equal(summary.failedRuleCount, 1);
  assert.deepEqual(summary.ruleStatuses.map((item) => [item.templateRuleId, item.status, item.runningRuleCount, item.expectedRuleCount]), [[400, "degraded", 2, 3]]);
});

test("挂了入口组的端口转发：托管监听按入口组的主机数，子规则记的是入口组成员 id", () => {
  const summary = summarizeForwardGroupRuntime({
    group: { id: 5, groupMode: "port", entryGroupId: 9, isEnabled: true },
    members: [],
    entryMembers: [{ id: 91, hostId: 901, isEnabled: true }, { id: 92, hostId: 902, isEnabled: true }, { id: 93, hostId: 903, isEnabled: false }],
    templateRules: [{ id: 500, isEnabled: true, pendingDelete: false }],
    childRules: [
      { id: 5001, hostId: 901, forwardGroupRuleId: 500, forwardGroupMemberId: 91, isEnabled: true, isRunning: true },
      { id: 5002, hostId: 902, forwardGroupRuleId: 500, forwardGroupMemberId: 92, isEnabled: true, isRunning: true },
    ],
  });
  assert.equal(summary.status, "running");
  assert.equal(summary.expectedRuleCount, 2);
  assert.equal(summary.runningRuleCount, 2);
});
