import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendUpgradeJobLog,
  createUpgradeJobStore,
  formatUpgradeDuration,
  idleUpgradeJob,
  isUpgradeLogFlushPoint,
  reconcileRestoredUpgradeJob,
  resolveUpgradeJobStatePath,
  upgradeJobElapsedMs,
  UPGRADE_JOB_MAX_LOG_LINES,
  type UpgradeJob,
} from "./panelUpgradeJob";
import { APP_VERSION } from "../shared/versions";

/*
  升级任务原来只在内存里，脚本最后 systemctl restart 把面板杀掉任务就没了，客户端一直画着断线前的 74%。
  现在落盘、重启后读回来判断。
*/

const minute = 60 * 1000;
const now = Date.parse("2026-09-30T08:00:00Z");

function runningJob(overrides: Partial<UpgradeJob> = {}): UpgradeJob {
  return {
    ...idleUpgradeJob(),
    status: "running",
    mode: "upgrade",
    startedAt: new Date(now - 3 * minute).toISOString(),
    targetVersion: "2.3.398",
    logs: ["[NEX] Starting panel 升级 to 2.3.398", "[NEX] step 5/5 重启面板", "[NEX] restarting panel service (elapsed 170s)"],
    ...overrides,
  };
}

test("面板带着目标版本重启回来：任务判成功，记下重启和用时", () => {
  const job = reconcileRestoredUpgradeJob(runningJob(), { currentVersion: "2.3.398", now });
  assert.equal(job.status, "success");
  assert.equal(job.restarted, true);
  assert.equal(job.restartedAt, new Date(now).toISOString());
  assert.equal(job.error, null);
  assert.ok(job.logs.includes("[NEX] Panel restarted on v2.3.398"), job.logs.join("\n"));
  assert.ok(job.logs.some((line) => line.includes("升级用时 3 分 0 秒")), job.logs.join("\n"));
  // 用时按重启时刻算，不随之后的查询时间一直涨
  assert.equal(upgradeJobElapsedMs(job, now + 10 * minute), 3 * minute);
});

test("脚本已经报 success 但面板还没重启就被杀：重启后同样判成功；带 v 前缀的版本也认", () => {
  const job = reconcileRestoredUpgradeJob(runningJob({ status: "success", targetVersion: "v2.3.398" }), { currentVersion: "2.3.398", now });
  assert.equal(job.status, "success");
  assert.equal(job.restarted, true);
});

test("重启后版本没变：15 分钟内继续等，超过就算升级没生效并给出手动命令", () => {
  const fresh = reconcileRestoredUpgradeJob(runningJob(), { currentVersion: "2.3.397", now });
  assert.equal(fresh.status, "running");
  assert.equal(fresh.restarted, false);

  const stale = reconcileRestoredUpgradeJob(
    runningJob({ startedAt: new Date(now - 16 * minute).toISOString() }),
    { currentVersion: "2.3.397", now, manualHintLines: ["[NEX] Local: bash install.sh upgrade"] },
  );
  assert.equal(stale.status, "error");
  assert.match(stale.error || "", /面板重启后版本仍是 v2\.3\.397，升级没有生效/);
  assert.ok(stale.logs.includes("[NEX] Local: bash install.sh upgrade"));
  assert.equal(stale.finishedAt, new Date(now).toISOString());
});

test("回退用回退的说法", () => {
  const stale = reconcileRestoredUpgradeJob(
    runningJob({ mode: "rollback", targetVersion: "2.3.390", startedAt: new Date(now - 20 * minute).toISOString() }),
    { currentVersion: "2.3.397", now },
  );
  assert.match(stale.error || "", /回退没有生效/);
  const done = reconcileRestoredUpgradeJob(runningJob({ mode: "rollback", targetVersion: "2.3.390" }), { currentVersion: "2.3.390", now });
  assert.equal(done.status, "success");
  assert.ok(done.logs.some((line) => line.includes("回退用时")));
});

test("已经判过重启成功、又没人确认：30 分钟内保留，之后清掉；空的和坏的都当没有", () => {
  const acknowledgedLater = runningJob({ status: "success", restarted: true, restartedAt: new Date(now - 5 * minute).toISOString() });
  assert.equal(reconcileRestoredUpgradeJob(acknowledgedLater, { currentVersion: "2.3.398", now }).restarted, true);
  const forgotten = runningJob({ status: "success", restarted: true, restartedAt: new Date(now - 40 * minute).toISOString() });
  assert.equal(reconcileRestoredUpgradeJob(forgotten, { currentVersion: "2.3.398", now }).status, "idle");

  assert.equal(reconcileRestoredUpgradeJob(null, { currentVersion: "2.3.398", now }).status, "idle");
  assert.equal(reconcileRestoredUpgradeJob({ status: "running" }, { currentVersion: "2.3.398", now }).status, "idle");
  assert.equal(reconcileRestoredUpgradeJob("garbage", { currentVersion: "2.3.398", now }).status, "idle");
  assert.equal(reconcileRestoredUpgradeJob(idleUpgradeJob(), { currentVersion: "2.3.398", now }).status, "idle");
});

test("出错 / 等资产的旧任务：刚发生的保留，老的丢掉；目标版本已经是当前版本则判成功", () => {
  const recent = runningJob({ status: "error", error: "boom", finishedAt: new Date(now - 2 * minute).toISOString(), targetVersion: "2.3.399" });
  assert.equal(reconcileRestoredUpgradeJob(recent, { currentVersion: "2.3.397", now }).status, "error");
  const old = runningJob({ status: "waiting_assets", finishedAt: new Date(now - 60 * minute).toISOString(), targetVersion: "2.3.399" });
  assert.equal(reconcileRestoredUpgradeJob(old, { currentVersion: "2.3.397", now }).status, "idle");
  // 升级失败后用户手动跑了脚本，面板带着目标版本回来了
  const fixedByHand = runningJob({ status: "error", error: "exit 1", targetVersion: "2.3.398", startedAt: new Date(now - 10 * minute).toISOString() });
  const job = reconcileRestoredUpgradeJob(fixedByHand, { currentVersion: "2.3.398", now });
  assert.equal(job.status, "success");
  assert.equal(job.restarted, true);
});

test("下载进度行只留最新一条，别把前面的 step 标记挤出 300 行窗口", () => {
  const logs: string[] = [];
  appendUpgradeJobLog(logs, "[NEX] step 2/5 下载面板包");
  for (let i = 1; i <= 500; i += 1) appendUpgradeJobLog(logs, `[NEX] progress download ${i * 1000}/500000 ${Math.floor(i / 5)}%`);
  assert.deepEqual(logs, ["[NEX] step 2/5 下载面板包", "[NEX] progress download 500000/500000 100%"]);
  appendUpgradeJobLog(logs, "[NEX] step 3/5 解压文件");
  appendUpgradeJobLog(logs, "[NEX] progress download 1/2 50%");
  appendUpgradeJobLog(logs, "  ");
  assert.equal(logs.length, 4);
  for (let i = 0; i < UPGRADE_JOB_MAX_LOG_LINES + 20; i += 1) appendUpgradeJobLog(logs, `line ${i}`);
  assert.equal(logs.length, UPGRADE_JOB_MAX_LOG_LINES);
});

test("2.3.414 之前的脚本打的 [ForwardX] 下载进度行同样只留最新一条", () => {
  const logs: string[] = [];
  appendUpgradeJobLog(logs, "[ForwardX] step 2/5 下载面板包");
  for (let i = 1; i <= 50; i += 1) appendUpgradeJobLog(logs, `[ForwardX] progress download ${i * 1000}/50000 ${i * 2}%`);
  assert.deepEqual(logs, ["[ForwardX] step 2/5 下载面板包", "[ForwardX] progress download 50000/50000 100%"]);
});

test("重启前那几行必须同步落盘", () => {
  assert.equal(isUpgradeLogFlushPoint("[NEX] restarting panel service (elapsed 12s)"), true);
  assert.equal(isUpgradeLogFlushPoint("+ systemctl restart forwardx-panel"), true);
  assert.equal(isUpgradeLogFlushPoint("[NEX] progress download 1/2 50%"), false);
});

test("用时的说法", () => {
  assert.equal(formatUpgradeDuration(102_000), "1 分 42 秒");
  assert.equal(formatUpgradeDuration(59_400), "59 秒");
  assert.equal(formatUpgradeDuration(-5), "0 秒");
  assert.equal(upgradeJobElapsedMs(idleUpgradeJob()), null);
});

test("状态文件放在 SQLite 旁边，那个目录不能用就退到 cwd/data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-upgrade-state-"));
  try {
    assert.equal(
      resolveUpgradeJobStatePath({ sqlitePath: path.join(directory, "db", "forwardx.db") }, directory),
      path.join(directory, "db", "panel-upgrade-job.json"),
    );
    assert.ok(fs.existsSync(path.join(directory, "db")));
    // 目录位置被一个普通文件占着（mkdir 会 ENOTDIR，root 也建不出来）→ 退到 cwd/data
    fs.writeFileSync(path.join(directory, "blocker"), "");
    assert.equal(
      resolveUpgradeJobStatePath({ sqlitePath: path.join(directory, "blocker", "sub", "x.db") }, directory),
      path.join(directory, "data", "panel-upgrade-job.json"),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("落盘：immediate 同步写、普通写合并、原子替换、clear 删文件", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-upgrade-store-"));
  const filePath = path.join(directory, "nested", "panel-upgrade-job.json");
  try {
    const store = createUpgradeJobStore(filePath, 30);
    assert.equal(store.load(), null);
    const job = runningJob();
    store.save(job, { immediate: true });
    assert.deepEqual(store.load(), job);
    assert.equal(fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith(".tmp")).length, 0);

    // 之后追加日志再 save（不 immediate）：立刻读还是旧的，几十毫秒后合并写入
    job.logs.push("more");
    store.save(job);
    job.logs.push("even more");
    store.save(job);
    assert.equal((store.load() as UpgradeJob).logs.length, 3);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal((store.load() as UpgradeJob).logs.length, 5);

    fs.writeFileSync(filePath, "{not json");
    assert.equal(store.load(), null);

    store.clear();
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/*
  真刀真枪：起一个面板进程（SQLite + systemRouter），启动前把「正在升级」的状态文件放好，
  看 upgradeStatus 报什么、acknowledgeUpgrade 之后是不是清掉了。
*/
function runPanelWithSavedJob(saved: Record<string, unknown>, extra = "") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-upgrade-restart-"));
  const dataDir = path.join(directory, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "panel-upgrade-job.json"), JSON.stringify(saved));
  const script = String.raw`
    import path from "node:path";
    import fs from "node:fs";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw("INSERT INTO users (id, username, password, role, accountEnabled) VALUES (1, 'admin', 'hash', 'admin', 1)");
      const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
      const { systemRouter } = await import(url("server/_core/systemRouter.ts"));
      const system = systemRouter.createCaller(context);
      const out = {};
      const first = await system.upgradeStatus();
      out.first = { status: first.job.status, restarted: first.restarted, elapsedMs: first.elapsedMs, startedAt: first.startedAt, error: first.job.error, logs: first.job.logs };
      out.fileAfterRestore = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")).status;
      ${extra}
      process.stdout.write("RESULT " + JSON.stringify(out) + "\n");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_TYPE: "sqlite",
      SQLITE_PATH: path.join(dataDir, "forwardx.db"),
      STATE_FILE: path.join(dataDir, "panel-upgrade-job.json"),
      FORWARDX_UPGRADE_COMMAND: "/bin/bash /nonexistent/install-panel-local.sh upgrade",
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  const stateFileExists = fs.existsSync(path.join(dataDir, "panel-upgrade-job.json"));
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split("\n").find((item) => item.startsWith("RESULT "));
  assert.ok(line, result.stdout);
  return { out: JSON.parse(line.slice("RESULT ".length)), stateFileExists };
}

test("面板重启后：目标版本 == 当前版本 → upgradeStatus 报 success/restarted，确认后清掉状态文件", () => {
  const startedAt = new Date(Date.now() - 100_000).toISOString();
  const { out, stateFileExists } = runPanelWithSavedJob(
    { ...runningJob({ startedAt, targetVersion: APP_VERSION }) },
    String.raw`
      const ack = await system.acknowledgeUpgrade({ targetVersion: "${APP_VERSION}" });
      const second = await system.upgradeStatus();
      out.ack = ack;
      out.second = { status: second.job.status, restarted: second.restarted };
    `,
  );
  assert.equal(out.first.status, "success");
  assert.equal(out.first.restarted, true);
  assert.equal(out.first.startedAt, startedAt);
  assert.ok(out.first.elapsedMs >= 100_000 && out.first.elapsedMs < 130_000, String(out.first.elapsedMs));
  assert.ok(out.first.logs.includes(`[NEX] Panel restarted on v${APP_VERSION}`), out.first.logs.join("\n"));
  assert.equal(out.fileAfterRestore, "success");
  assert.deepEqual(out.ack, { cleared: true });
  assert.equal(out.second.status, "idle");
  assert.equal(out.second.restarted, false);
  assert.equal(stateFileExists, false);
});

test("面板重启后版本没变且任务已经很老 → error 带手动命令；确认接口不清 error", () => {
  const { out, stateFileExists } = runPanelWithSavedJob(
    { ...runningJob({ startedAt: new Date(Date.now() - 20 * minute).toISOString(), targetVersion: "99.0.0" }) },
    String.raw`
      out.ack = await system.acknowledgeUpgrade();
    `,
  );
  assert.equal(out.first.status, "error");
  assert.equal(out.first.restarted, false);
  assert.match(out.first.error, /升级没有生效/);
  assert.ok(out.first.logs.some((line: string) => /install-panel-local\.sh.*bash -s -- upgrade/.test(line)), out.first.logs.join("\n"));
  assert.deepEqual(out.ack, { cleared: false });
  assert.equal(stateFileExists, true);
});

test("面板重启后版本没变但任务还新 → 继续 running", () => {
  const { out } = runPanelWithSavedJob({ ...runningJob({ startedAt: new Date(Date.now() - minute).toISOString(), targetVersion: "99.0.0" }) });
  assert.equal(out.first.status, "running");
  assert.equal(out.first.restarted, false);
});
