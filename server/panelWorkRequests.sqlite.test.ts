import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  交给持有实例的待办（server/panelWorkRequests.ts，评审 F7）接上真库（SQLite）：
  - 处理函数跑的时候那一行还在（先认领、成功了才删）：持有者跑到一半没了，下一任还能接着跑；
  - 失败了不丢：按 2 秒起翻倍退避重试，退避期间不重跑；
  - 跑的时候又来了同一件事：跑完那一行留着，下一轮按新的再跑一次；
  - 放了 10 分钟还没跑成的丢掉，「10 分钟」按库的时钟算。
*/

process.env.DATABASE_TYPE = "sqlite";
process.env.FORWARDX_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nex-panel-work-logs-"));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-panel-work-"));
const runtime = await import("./dbRuntime");
const { ensureDatabaseSchema } = await import("./dbSchema");
const work = await import("./panelWorkRequests");
await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "work.db") } });
await ensureDatabaseSchema();
const rows = () => runtime.queryRaw<{ name: string; payload: string | null; attempts: number }>('SELECT "name", "payload", "attempts" FROM "panel_work_requests" ORDER BY "name"');
const originalWarn = console.warn;

test.beforeEach(async () => {
  await runtime.executeRaw('DELETE FROM "panel_work_requests"');
  work.setPanelWorkClockOffsetForTests(0);
  console.warn = () => {};
});
test.after(async () => {
  console.warn = originalWarn;
  await runtime.closeDatabase().catch(() => undefined);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("处理函数跑的时候那一行还在；成功了才删", async () => {
  const seenDuringRun: string[] = [];
  work.registerPanelWorkHandler("t-claim", async (key) => {
    seenDuringRun.push(...(await rows()).map((row) => row.name));
    assert.equal(key, "1");
  });
  await work.requestPanelWork("t-claim", 1, { manual: true });
  assert.equal(await work.drainPanelWorkRequests(), 1);
  assert.deepEqual(seenDuringRun, ["t-claim:1"], "跑之前就删了：跑到一半进程没了，这件事就丢了");
  assert.deepEqual(await rows(), []);
});

test("失败了不丢：退避重试，退避期间不重跑，成功后删掉", async () => {
  let calls = 0;
  let failing = true;
  work.registerPanelWorkHandler("t-retry", async () => {
    calls += 1;
    if (failing) throw new Error("database busy");
  });
  await work.requestPanelWork("t-retry", 7, { forceSync: true });
  assert.equal(await work.drainPanelWorkRequests(), 0);
  assert.equal(calls, 1);
  assert.deepEqual((await rows()).map((row) => [row.name, row.attempts]), [["t-retry:7", 1]], "失败的请求被丢了");
  // 退避期间（2 秒）不重跑
  assert.equal(await work.drainPanelWorkRequests(), 0);
  assert.equal(calls, 1);
  work.setPanelWorkClockOffsetForTests(2_500);
  assert.equal(await work.drainPanelWorkRequests(), 0);
  assert.equal(calls, 2);
  assert.equal((await rows())[0].attempts, 2);
  // 第二次失败退避 4 秒
  work.setPanelWorkClockOffsetForTests(5_000);
  await work.drainPanelWorkRequests();
  assert.equal(calls, 2);
  failing = false;
  work.setPanelWorkClockOffsetForTests(7_000);
  assert.equal(await work.drainPanelWorkRequests(), 1);
  assert.equal(calls, 3);
  assert.deepEqual(await rows(), []);
});

test("跑的时候又来了同一件事：跑完那一行留着，下一轮按新的再跑一次", async () => {
  const payloads: unknown[] = [];
  work.registerPanelWorkHandler("t-again", async (_key, payload) => {
    payloads.push(payload);
    if (payloads.length === 1) await work.requestPanelWork("t-again", 3, { round: 2 });
  });
  await work.requestPanelWork("t-again", 3, { round: 1 });
  assert.equal(await work.drainPanelWorkRequests(), 1);
  assert.deepEqual((await rows()).map((row) => row.payload), [JSON.stringify({ round: 2 })]);
  assert.equal(await work.drainPanelWorkRequests(), 1);
  assert.deepEqual(payloads, [{ round: 1 }, { round: 2 }]);
  assert.deepEqual(await rows(), []);
});

test("放了 10 分钟还没跑成的丢掉（按库的时钟）；不认识的活留给认识它的实例", async () => {
  let calls = 0;
  work.registerPanelWorkHandler("t-old", () => { calls += 1; });
  await work.requestPanelWork("t-old", 1);
  await work.requestPanelWork("t-unknown-kind", 1);
  assert.equal(await work.drainPanelWorkRequests(), 0 + 1);
  assert.deepEqual((await rows()).map((row) => row.name), ["t-unknown-kind:1"]);
  await work.requestPanelWork("t-old", 2);
  work.setPanelWorkClockOffsetForTests(work.PANEL_WORK_REQUEST_MAX_AGE_MS + 1_000);
  assert.equal(await work.drainPanelWorkRequests(), 0);
  assert.equal(calls, 1);
  assert.deepEqual(await rows(), []);
});
