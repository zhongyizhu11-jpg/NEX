import assert from "node:assert/strict";
import test from "node:test";

import {
  clearRuleConnectionsTasksForTest,
  completeRuleConnectionsTask,
  enqueueRuleConnectionsTask,
  getRuleConnectionsTaskStatus,
  hasQueuedRuleConnectionsTasks,
  hasRunningRuleConnectionsTasks,
  normalizeRuleConnectionRows,
  takeRuleConnectionsTasks,
} from "./ruleConnectionsAgentTasks";

test("排队 → 心跳取走 → 回报：状态一路对得上，别的机器回报不认", () => {
  clearRuleConnectionsTasksForTest();
  const task = enqueueRuleConnectionsTask(7, { ruleId: 42, port: 10001, protocol: "tcp", dnat: false });
  assert.equal(hasQueuedRuleConnectionsTasks(7), true);
  assert.equal(getRuleConnectionsTaskStatus(task.taskId)?.status, "queued");
  const taken = takeRuleConnectionsTasks(7);
  assert.equal(taken.length, 1);
  assert.equal(taken[0].limit, 200);
  assert.equal(hasQueuedRuleConnectionsTasks(7), false);
  assert.equal(hasRunningRuleConnectionsTasks(7), true);
  assert.equal(completeRuleConnectionsTask(8, { taskId: task.taskId, rows: [] }), false, "别的机器不能替它回报");
  assert.equal(completeRuleConnectionsTask(7, { taskId: task.taskId, rows: [{ peer: "1.2.3.4:5", local: "10.0.0.1:10001", protocol: "tcp", bytesIn: 10, bytesOut: 20 }], total: 300, truncated: true, source: "proc+ss" }), true);
  const status = getRuleConnectionsTaskStatus(task.taskId)!;
  assert.equal(status.status, "done");
  assert.equal(status.snapshot?.total, 300);
  assert.equal(status.snapshot?.truncated, true);
  assert.equal(status.snapshot?.rows[0].bytesOut, 20);
  assert.equal(hasRunningRuleConnectionsTasks(7), false);
  clearRuleConnectionsTasksForTest();
});

test("面板时限到了没回报：queued 和 running 各说各的原因", async () => {
  clearRuleConnectionsTasksForTest();
  const queued = enqueueRuleConnectionsTask(1, { ruleId: 1, port: 1, protocol: "tcp", dnat: false }, 20);
  const running = enqueueRuleConnectionsTask(2, { ruleId: 2, port: 2, protocol: "udp", dnat: true }, 20);
  takeRuleConnectionsTasks(2);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(getRuleConnectionsTaskStatus(queued.taskId)?.error || "", /没来取/);
  assert.match(getRuleConnectionsTaskStatus(running.taskId)?.error || "", /没在时限内/);
  assert.equal(getRuleConnectionsTaskStatus(running.taskId)?.status, "timeout");
  clearRuleConnectionsTasksForTest();
});

test("回报的行收敛：行数封顶、协议只认 tcp/udp、负数不要、地址截断", () => {
  const rows = normalizeRuleConnectionRows([
    { peer: " 1.2.3.4:5 ", local: "x", protocol: "sctp", bytesIn: -1, bytesOut: 3.7, state: "ESTABLISHED" },
    { peer: "", local: "y" },
    { peer: "a".repeat(100), protocol: "UDP" },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { protocol: "tcp", peer: "1.2.3.4:5", local: "x", bytesOut: 4, state: "ESTABLISHED" });
  assert.equal(rows[1].protocol, "udp");
  assert.equal(rows[1].peer.length, 64);
  assert.equal(normalizeRuleConnectionRows(Array.from({ length: 500 }, () => ({ peer: "p" }))).length, 200);
});
