import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  在真的 SQLite 上走一遍解锁检测的存储：建表、写入、latest 标记、按 runId 去重、
  每台主机只留 10 次（各 family 最新那一行不删）、列表页摘要、计划检测设置。
*/
test("解锁检测结果在 SQLite 上的存储和历史裁剪", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-unlock-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const unlock = await import(url("server/ops/unlock.ts"));
      const results = (status) => [
        { service: "netflix", status, region: "HK", detail: "x", ms: 10 },
        { service: "chatgpt", status: "ok", region: "HK", detail: "y", ms: 5 },
        { service: "claude", status: "blocked", region: null, detail: "z", ms: 5 },
      ];
      const base = 1_800_000_000;
      await unlock.recordUnlockRun({ hostId: 1, family: "ipv6", runId: "ul-v6", trigger: "manual", requestedBy: 1, checkedAt: base, results: results("partial") });
      for (let i = 1; i <= 12; i++) {
        await unlock.recordUnlockRun({ hostId: 1, family: "auto", runId: "ul-a" + i, trigger: i % 2 ? "manual" : "schedule", requestedBy: null, checkedAt: base + i * 60, results: results("ok") });
      }
      // 同一个 runId 再写一次不会多一行。
      await unlock.recordUnlockRun({ hostId: 1, family: "auto", runId: "ul-a12", trigger: "manual", requestedBy: null, checkedAt: base + 9999, results: results("blocked") });
      await unlock.recordUnlockRun({ hostId: 2, family: "ipv4", runId: "ul-b1", trigger: "manual", requestedBy: null, checkedAt: base, results: results("blocked") });

      const history = await unlock.listUnlockHistory(1);
      assert.equal(history.length, 10);
      assert.equal(history[0].runId, "ul-a12");
      assert.equal(history[0].trigger, "schedule");
      assert.equal(history[0].results.length, 3);
      const all = await runtime.queryRaw('SELECT "runId" FROM "host_unlock_checks" WHERE "hostId" = ? ORDER BY "checkedAt" DESC', [1]);
      assert.equal(all.length, 11, "10 次 + IPv6 最新那一行");
      assert.ok(all.some((row) => row.runId === "ul-v6"), "IPv6 最新结果不被几次 auto 挤掉");
      assert.ok(!all.some((row) => row.runId === "ul-a1" || row.runId === "ul-a2"));

      const latest = await unlock.latestUnlockRuns(1);
      assert.deepEqual(latest.map((run) => run.family + ":" + run.runId), ["auto:ul-a12", "ipv6:ul-v6"]);
      assert.equal(latest[1].results[0].status, "partial");

      const summaries = await unlock.latestUnlockSummariesByHostIds([1, 2, 3]);
      assert.equal(summaries.size, 2);
      assert.equal(summaries.get(1).family, "auto");
      assert.deepEqual(summaries.get(1).items.map((item) => item.text), ["NF 全解", "GPT ✓", "Claude ✗"]);
      assert.deepEqual(summaries.get(2).items.map((item) => item.text), ["NF ✗", "GPT ✓", "Claude ✗"]);

      assert.equal(await unlock.getUnlockSchedule(), "off");
      await unlock.setUnlockSchedule("weekly");
      assert.equal(await unlock.getUnlockSchedule(), "weekly");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
