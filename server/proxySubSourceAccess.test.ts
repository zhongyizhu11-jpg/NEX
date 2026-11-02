import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 外部订阅（P1-4）：管理员关了外部订阅、或者套餐不再包含时，已有的源不能再改地址、强制拉取，
 * 定时任务也不再替他去拉（记成失败并写明原因）；改名、停用、删除照样能做。
 */
test("外部订阅关掉以后：改地址、立即同步、定时拉取都停下", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-sub-source-access-"));
  const databasePath = path.join(directory, "source-access.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const { proxySubscriptionsRouter } = await import(url("server/routers/proxySubscriptions.ts"));
    const settings = await import(url("server/proxySubSettings.ts"));
    const sync = await import(url("server/proxySubSourceSync.ts"));

    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'tenant', 'x', 'user', 1)");
    // 源指向一个不可能连上的地址：真去拉的话会记成「拉取失败」，和「暂停拉取」区分得开。
    await exec("INSERT INTO proxy_sub_sources (id, userId, name, url, intervalSec, mode, isEnabled) VALUES (1, 1, 'a', 'http://127.0.0.1:9/sub', 3600, 'import', 1)");
    await settings.saveProxySubSettings({ externalSourcesEnabled: false });
    settings.invalidateProxySubSettingsCache();

    const caller = proxySubscriptionsRouter.createCaller({ user: { id: 1, role: "user", username: "tenant" }, req: { headers: {}, socket: {} }, res: {} });
    await assert.rejects(() => caller.updateSource({ id: 1, url: "http://198.51.100.7/sub" }), /没有开放外部订阅/);
    await assert.rejects(() => caller.updateSource({ id: 1, userAgent: "x" }), /没有开放外部订阅/);
    await assert.rejects(() => caller.updateSource({ id: 1, isEnabled: true }), /没有开放外部订阅/);
    await assert.rejects(() => caller.syncSource({ id: 1 }), /没有开放外部订阅/);
    // 改名、停用照样能改。
    await caller.updateSource({ id: 1, name: "renamed", isEnabled: false });
    let row = (await query("SELECT name, url, isEnabled FROM proxy_sub_sources WHERE id = 1"))[0];
    assert.equal(row.name, "renamed");
    assert.equal(row.url, "http://127.0.0.1:9/sub");
    assert.equal(Number(row.isEnabled), 0);

    // 定时任务：全局关着 → 不拉，记原因。
    await exec("UPDATE proxy_sub_sources SET isEnabled = 1, lastFetchAt = NULL WHERE id = 1");
    assert.equal(await sync.runProxySubSourceSync(), 0);
    row = (await query("SELECT lastStatus, lastError, lastFetchAt FROM proxy_sub_sources WHERE id = 1"))[0];
    assert.equal(row.lastStatus, "error");
    assert.match(String(row.lastError), /暂停拉取/);
    assert.ok(row.lastFetchAt, "要刷新拉取时间，免得一直排在到点队列最前面");

    // 全局开着、但套餐不包含：接口拒，定时任务也不拉。
    await settings.saveProxySubSettings({ externalSourcesEnabled: true });
    settings.invalidateProxySubSettingsCache();
    await assert.rejects(() => caller.syncSource({ id: 1 }), /套餐不包含外部订阅/);
    await exec("UPDATE proxy_sub_sources SET lastFetchAt = NULL, lastError = NULL WHERE id = 1");
    assert.equal(await sync.runProxySubSourceSync(), 0);
    row = (await query("SELECT lastError FROM proxy_sub_sources WHERE id = 1"))[0];
    assert.match(String(row.lastError), /套餐不包含外部订阅/);

    // 套餐包含：照常拉（这里地址连不上，记成拉取失败而不是暂停）。
    await exec("INSERT INTO subscription_plans (id, name, allowExternalSubSources) VALUES (1, 'p', 1)");
    await exec("INSERT INTO user_subscriptions (id, userId, planId, status) VALUES (1, 1, 1, 'active')");
    await exec("UPDATE proxy_sub_sources SET lastFetchAt = NULL, lastError = NULL WHERE id = 1");
    assert.equal(await sync.runProxySubSourceSync(), 1);
    row = (await query("SELECT lastError FROM proxy_sub_sources WHERE id = 1"))[0];
    assert.doesNotMatch(String(row.lastError), /暂停拉取/);
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
