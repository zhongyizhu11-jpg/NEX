import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { developerAnnouncementApplies, parseDeveloperAnnouncementFeed } from "./developerAnnouncementFeed";

test("开发者公告 feed：坏条目整条丢掉，版本范围和过期时间按条判断", () => {
  const items = parseDeveloperAnnouncementFeed({
    announcements: [
      { id: "ok-one", title: "标题", content: "正文", maxVersion: "2.3.523" },
      { id: "Bad Id", title: "x", content: "y" },
      { id: "no-content", title: "x", content: "  " },
      { id: "ok-one", title: "重复的 id", content: "z" },
      { id: "upgrade-no-target", title: "x", content: "y", type: "upgrade_popup" },
      { id: "popup-two", title: "弹窗", content: "y", type: "popup", minVersion: "v2.3.525", expiresAt: "2026-12-31T00:00:00Z" },
      null,
      "string",
    ],
  });
  assert.deepEqual(items.map((item) => item.id), ["ok-one", "popup-two"]);
  assert.equal(items[1].minVersion, "2.3.525");
  assert.equal(items[1].expiresAt, Date.parse("2026-12-31T00:00:00Z") / 1000);
  const now = Date.parse("2026-11-10T00:00:00Z") / 1000;
  assert.equal(developerAnnouncementApplies(items[0], "2.3.523", now), true);
  assert.equal(developerAnnouncementApplies(items[0], "2.3.525", now), false, "只提醒旧版本的");
  assert.equal(developerAnnouncementApplies(items[1], "2.3.523", now), false);
  assert.equal(developerAnnouncementApplies(items[1], "2.3.530", now), true);
  assert.equal(developerAnnouncementApplies(items[1], "2.3.530", Date.parse("2027-01-01T00:00:00Z") / 1000), false, "过期的不插");
  assert.deepEqual(parseDeveloperAnnouncementFeed([{ id: "bare-array", title: "a", content: "b" }]).map((item) => item.id), ["bare-array"]);
  assert.deepEqual(parseDeveloperAnnouncementFeed("nope"), []);
  assert.equal(parseDeveloperAnnouncementFeed({ announcements: Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}`, title: "a", content: "b" })) }).length, 20);
});

test("开发者公告 feed：每条只插一次，管理员删掉的不放回来；拉取失败什么都不改；有冷却", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-dev-feed-"));
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
      const feed = await import(url("server/developerAnnouncementFeed.ts"));
      const versions = await import(url("shared/versions.ts"));
      const body = JSON.stringify({ announcements: [
        { id: "for-everyone", title: "全体", content: "内容 A" },
        { id: "login-popup", title: "弹窗", content: "内容 B", type: "popup" },
        { id: "too-new", title: "将来", content: "C", minVersion: "99.0.0" },
      ] });
      // 已经有一个管理员自己发的登录弹窗：feed 的弹窗会把它顶掉（同时只开一个）
      await runtime.executeRaw('INSERT INTO "announcements" ("title", "content", "type", "isActive") VALUES (?, ?, ?, ?)', ["旧弹窗", "x", "popup", 1]);
      const first = await feed.syncDeveloperAnnouncementFeed(async () => body, 100_000_000);
      assert.deepEqual(first, ["for-everyone", "login-popup"]);
      const rows = await runtime.queryRaw('SELECT "title", "type", "isActive" FROM "announcements" ORDER BY "id"');
      assert.deepEqual(rows.map((row) => [row.title, row.type, Number(row.isActive)]), [["旧弹窗", "popup", 0], ["全体", "normal", 1], ["弹窗", "popup", 1]]);
      // 冷却内不再拉
      let called = false;
      assert.deepEqual(await feed.syncDeveloperAnnouncementFeed(async () => { called = true; return body; }, 100_000_000 + 60_000), []);
      assert.equal(called, false);
      // 管理员删掉了一条；半小时后再拉，也不放回来
      await runtime.executeRaw('DELETE FROM "announcements" WHERE "title" = ?', ["全体"]);
      assert.deepEqual(await feed.syncDeveloperAnnouncementFeed(async () => body, 100_000_000 + 31 * 60_000), []);
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "announcements" WHERE "title" = ?', ["全体"]))[0].n, 0);
      // 拉取失败 / 不是 JSON：什么都不改
      feed.resetDeveloperAnnouncementFeedForTests();
      assert.deepEqual(await feed.syncDeveloperAnnouncementFeed(async () => { throw new Error("network"); }, 500_000_000), []);
      feed.resetDeveloperAnnouncementFeedForTests();
      assert.deepEqual(await feed.syncDeveloperAnnouncementFeed(async () => "<html>", 600_000_000), []);
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "announcements"'))[0].n, 2);
      assert.ok(versions.APP_VERSION);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db") },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
