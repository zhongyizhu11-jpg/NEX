import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AGENT_TUNNEL_PATHS } from "./agentEncryptionMiddleware";
import {
  clearDiagnosticsAgentTasksForTest,
  completeDiagnosticsAgentTask,
  DIAGNOSTICS_MAX_ACTIVE_PER_HOST,
  enqueueDiagnosticsAgentTask,
  getDiagnosticsTaskStatus,
  hasQueuedDiagnosticsAgentTasks,
  hasRunningDiagnosticsAgentTasks,
  normalizeDiagnosticsResults,
  takeDiagnosticsAgentTasks,
} from "./diagnosticsAgentTasks";

const checks = [
  { id: "c1", kind: "listen" as const, port: 443, protocol: "tcp" as const },
  { id: "c2", kind: "dial" as const, host: "1.1.1.1", port: 443, protocol: "tcp" as const },
];

test("诊断任务：排队 → 心跳取走（running）→ 回报（done），结果按 id 对上", () => {
  clearDiagnosticsAgentTasksForTest();
  const task = enqueueDiagnosticsAgentTask(5, checks);
  assert.equal(task.checks.length, 2);
  assert.ok(task.timeoutMs <= 30_000, "Agent 整包时限不超过 30 秒");
  assert.equal(hasQueuedDiagnosticsAgentTasks(5), true);
  assert.equal(getDiagnosticsTaskStatus(task.taskId)?.status, "queued");

  assert.deepEqual(takeDiagnosticsAgentTasks(6), [], "别的主机取不到");
  const taken = takeDiagnosticsAgentTasks(5);
  assert.equal(taken.length, 1);
  assert.equal(hasQueuedDiagnosticsAgentTasks(5), false, "取走以后不再挡心跳快路径");
  assert.equal(hasRunningDiagnosticsAgentTasks(5), true);
  assert.equal(getDiagnosticsTaskStatus(task.taskId)?.status, "running");

  assert.equal(completeDiagnosticsAgentTask(6, { taskId: task.taskId, results: [] }), false, "别的主机不能替它回报");
  assert.equal(completeDiagnosticsAgentTask(5, {
    taskId: task.taskId,
    durationMs: 812,
    results: [
      { id: "c1", kind: "listen", status: "pass", summary: "在听：0.0.0.0:443/tcp" },
      { id: "c2", kind: "dial", status: "fail", summary: "连接超时", latencyMs: 12.4 },
      { id: "c9", kind: "dial", status: "pass", summary: "面板没发过这一项" },
    ],
  }), true);
  const status = getDiagnosticsTaskStatus(task.taskId)!;
  assert.equal(status.status, "done");
  assert.equal(status.durationMs, 812);
  assert.deepEqual(status.results.map((entry) => [entry.id, entry.status]), [["c1", "pass"], ["c2", "fail"]]);
  assert.equal(status.results[1].latencyMs, 12);
  assert.equal(hasRunningDiagnosticsAgentTasks(5), false);
  assert.equal(completeDiagnosticsAgentTask(5, { taskId: task.taskId, results: [] }), false, "重复回报不覆盖");
});

test("诊断任务：一台主机同时最多几轮", () => {
  clearDiagnosticsAgentTasksForTest();
  for (let i = 0; i < DIAGNOSTICS_MAX_ACTIVE_PER_HOST; i++) enqueueDiagnosticsAgentTask(9, checks);
  assert.throws(() => enqueueDiagnosticsAgentTask(9, checks), /已有几轮诊断/);
  enqueueDiagnosticsAgentTask(10, checks);
});

test("诊断任务：面板时限到了没回来记 timeout，晚到的结果仍然收", async () => {
  clearDiagnosticsAgentTasksForTest();
  const task = enqueueDiagnosticsAgentTask(3, checks, 20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const status = getDiagnosticsTaskStatus(task.taskId)!;
  assert.equal(status.status, "timeout");
  assert.match(status.error || "", /没来取/);
  assert.equal(hasQueuedDiagnosticsAgentTasks(3), false, "超时的任务从队列里拿掉");
  assert.equal(completeDiagnosticsAgentTask(3, { taskId: task.taskId, results: [{ id: "c1", status: "pass", summary: "ok" }] }), true);
  assert.equal(getDiagnosticsTaskStatus(task.taskId)?.status, "done");
});

test("回报收敛：状态不认识当 warn，超长文本截断", () => {
  const task = { taskId: "t", checks, timeoutMs: 1, createdAt: "" };
  const [first] = normalizeDiagnosticsResults(task, [{ id: "c1", status: "exploded", summary: "x".repeat(1000), detail: "y".repeat(10_000) }]);
  assert.equal(first.status, "warn");
  assert.ok(first.summary.length < 400);
  assert.ok((first.detail || "").length < 4100);
  assert.deepEqual(normalizeDiagnosticsResults(task, "not-an-array"), []);
});

test("诊断结果的上报路径在 /api/sync 白名单里，排着的任务会打断心跳快路径", () => {
  assert.ok(AGENT_TUNNEL_PATHS.has("/api/agent/diagnostics-result"));
  const source = fs.readFileSync(path.join(process.cwd(), "server/agentHeartbeatRoute.ts"), "utf8");
  const start = source.indexOf("agentStableHeartbeatPlanCache.match(");
  assert.notEqual(start, -1);
  const blockingWork = source.slice(start, source.indexOf("recoveryTriggered,", start));
  assert.match(blockingWork, /hasBlockingWork:[\s\S]*hasQueuedDiagnosticsAgentTasks\(host\.id\)/);
  assert.match(source, /takeDiagnosticsAgentTasks\(host\.id\)/);
  assert.match(source, /diagnosticsTasks \} : \{\}\)/, "完整心跳把任务带下去");
  const agent = fs.readFileSync(path.join(process.cwd(), "agent/main.go"), "utf8");
  assert.match(agent, /DiagnosticsTasks\s+\[\]diagnosticsTask\s+`json:"diagnosticsTasks,omitempty"`/);
  assert.match(agent, /go handleDiagnosticsTask\(cfg, task\)/);
});
