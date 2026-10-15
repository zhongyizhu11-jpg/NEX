import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_MIMIC_INSTALL_VERSION,
  clearMimicInstallTasksForTest,
  enqueueMimicInstallTask,
  getMimicInstallTask,
  hasPendingMimicInstallTask,
  readMimicInstallerScript,
  reportMimicInstallResult,
  takeMimicInstallTask,
} from "./mimicInstallTasks";

const host = { id: 7, name: "hk-1", isOnline: true, agentVersion: AGENT_MIMIC_INSTALL_VERSION };

test("离线或 Agent 太旧的主机不排 mimic 安装任务", () => {
  clearMimicInstallTasksForTest();
  assert.throws(() => enqueueMimicInstallTask({ host: { ...host, isOnline: false }, mode: "install", version: "0.7.1" }), /离线/);
  assert.throws(() => enqueueMimicInstallTask({ host: { ...host, agentVersion: "2.2.222" }, mode: "install", version: "0.7.1" }), /升级 Agent/);
  assert.equal(getMimicInstallTask(7), null);
});

test("任务排队 → 心跳取走变 running → 进度回传 → 终态带回 mimic 环境", () => {
  clearMimicInstallTasksForTest();
  const queued = enqueueMimicInstallTask({ host, mode: "repair", version: "v0.7.1", acceleratorEnabled: true, acceleratorUrl: "https://ghfast.example", script: "#!/bin/bash\nMIMIC_REPO=x\n" });
  assert.equal(queued.status, "queued");
  assert.equal(queued.version, "0.7.1");
  assert.equal(hasPendingMimicInstallTask(7), true);
  // 排着的时候再点一次不会多排一个
  assert.equal(enqueueMimicInstallTask({ host, mode: "install", version: "0.7.1" }).taskId, queued.taskId);

  const payload = takeMimicInstallTask(7);
  assert.ok(payload);
  assert.equal(payload!.taskId, queued.taskId);
  assert.equal(payload!.mode, "repair");
  assert.equal(payload!.acceleratorEnabled, true);
  assert.match(payload!.script || "", /MIMIC_REPO/);
  assert.equal(takeMimicInstallTask(7), null, "取走一次就不再给");
  assert.equal(getMimicInstallTask(7)?.status, "running");

  assert.equal(reportMimicInstallResult(7, { taskId: payload!.taskId, status: "running", output: "[NEX mimic] downloading…" }), true);
  assert.equal(getMimicInstallTask(7)?.output, "[NEX mimic] downloading…");
  assert.equal(reportMimicInstallResult(7, { taskId: "someone-else", status: "success" }), false);

  assert.equal(reportMimicInstallResult(7, {
    taskId: payload!.taskId,
    status: "success",
    output: "[NEX mimic] mimic 0.7.1 is ready",
    exitCode: 0,
    mimicEnvironment: { available: true, status: "ready", version: "0.7.1" },
  }), true);
  const done = getMimicInstallTask(7)!;
  assert.equal(done.status, "success");
  assert.equal(done.exitCode, 0);
  assert.equal(done.environment?.available, true);
  assert.equal(hasPendingMimicInstallTask(7), false);
  // 做完了再排是一个新任务
  assert.notEqual(enqueueMimicInstallTask({ host, mode: "install", version: "0.7.1" }).taskId, done.taskId);
  clearMimicInstallTasksForTest();
});

test("失败结果保留错误摘要和输出尾巴", () => {
  clearMimicInstallTasksForTest();
  const queued = enqueueMimicInstallTask({ host, mode: "install", version: "0.7.1" });
  takeMimicInstallTask(7);
  reportMimicInstallResult(7, { taskId: queued.taskId, status: "error", output: "x".repeat(70 * 1024), error: "[NEX mimic] ERROR: dkms build failed", exitCode: 1 });
  const failed = getMimicInstallTask(7)!;
  assert.equal(failed.status, "error");
  assert.equal(failed.output.length, 64 * 1024);
  assert.match(failed.error || "", /dkms build failed/);
  clearMimicInstallTasksForTest();
});

test("面板自带的安装脚本能读到（发布包里没有时退回空串）", () => {
  const script = readMimicInstallerScript();
  assert.ok(script === "" || script.includes("MIMIC_REPO="));
});
