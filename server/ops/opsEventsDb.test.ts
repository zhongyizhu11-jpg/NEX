import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 事件时间线 / Webhook / 每日简报接上真库（SQLite）跑一遍：
 * 挂钩写得进去、恢复时算得出断了多久、接口带得出名字并能翻页、简报各块不报错、
 * Webhook 地址只收 https 且不许内网、读回来的地址是打码的。
 */
test("events, webhook settings and digest blocks work against a real database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ops-events-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const hooks = await import(url("server/ops/eventHooks.ts"));
      const users = await import(url("server/repositories/userRepository.ts"));
      const { eventsRouter } = await import(url("server/routers/ops/events.ts"));
      const webhooks = await import(url("server/ops/webhooks.ts"));
      const digest = await import(url("server/ops/digestContent.ts"));
      const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

      const now = Math.floor(Date.now() / 1000);
      await runtime.executeRaw('INSERT INTO users (id, username, password, role, "canAddRules", "trafficLimit", "trafficUsed", "expiresAt") VALUES (1, ?, ?, ?, 1, 0, 0, NULL)', ["admin", "h", "admin"]);
      await runtime.executeRaw('INSERT INTO users (id, username, name, password, role, "canAddRules", "trafficLimit", "trafficUsed", "expiresAt") VALUES (2, ?, ?, ?, ?, 1, 100, 97, ?)', ["u2", "小王", "h", "user", now + 86400]);
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, isOnline) VALUES (1, '港-1', '203.0.113.1', 'slave', 'tok1', 1, 1)");

      // 掉线（最后一次心跳 35 分钟前）→ 恢复：消息里带上断了多久
      hooks.recordHostStatusEvent({ id: 1, name: "港-1", lastHeartbeat: new Date((now - 35 * 60) * 1000) }, "offline");
      await settled();
      hooks.recordHostStatusEvent({ id: 1, name: "港-1" }, "online");
      await settled();
      hooks.recordHostRestartEvent({ id: 1, name: "港-1" }, { reboot: false, processRestart: true, upgradedTo: "2.2.216" });
      // 计费锁 / 事务里暂停用户：提交后才写事件
      await runtime.withDatabaseTransaction(async () => {
        assert.equal(await users.setUserForwardAccess(2, false, "traffic_limit"), true);
      });
      await settled();
      hooks.recordRuleStatusEvent({ rule: { id: 9, name: "web", isEnabled: true, sourcePort: 443, userId: 2 }, host: { id: 1, name: "港-1" }, wasRunning: true, isRunning: false, message: "bind: address already in use" });
      hooks.recordRuleStatusEvent({ rule: { id: 9, name: "web", isEnabled: true, sourcePort: 443, userId: 2 }, host: { id: 1, name: "港-1" }, wasRunning: false, isRunning: false, message: "bind: address already in use" });
      hooks.recordRuleStatusEvent({ rule: { id: 9, name: "web", isEnabled: true, sourcePort: 443, userId: 2 }, host: { id: 1, name: "港-1" }, wasRunning: false, isRunning: true });
      await settled();

      const caller = eventsRouter.createCaller({
        req: { headers: {}, ip: "127.0.0.1", socket: {} },
        res: { cookie() {}, clearCookie() {} },
        user: { id: 1, role: "admin", username: "admin" },
        authSession: null,
        authFailureReason: null,
      });
      const recent = await caller.recent({ limit: 20 });
      const messages = recent.map((event) => event.message);
      assert.deepEqual(messages, [
        "规则「web」（港-1 :443）恢复运行",
        "规则「web」（港-1 :443）出错：bind: address already in use",
        "用户 小王 流量用完，转发已暂停",
        "港-1 的 Agent 升级到 2.2.216 并重启",
        "港-1 断线 35 分钟后恢复",
        "港-1 断线",
      ], "同一个错误五分钟内只记一次");
      assert.equal(recent[0].hostName, "港-1");
      assert.equal(recent[2].userName, "小王");

      const warnOnly = await caller.list({ minLevel: "warn", limit: 50 });
      assert.deepEqual(warnOnly.items.map((event) => event.kind), ["rule.error", "user.quota_exhausted", "host.offline"]);
      const page1 = await caller.list({ limit: 2 });
      assert.equal(page1.items.length, 2);
      assert.ok(page1.nextCursor);
      const page2 = await caller.list({ limit: 50, cursor: page1.nextCursor });
      assert.equal(page2.items.length, 4);
      assert.equal(page2.nextCursor, null);
      const hostOnly = await caller.recent({ limit: 10, hostId: 1 });
      assert.equal(hostOnly.length, 5);

      // Webhook：只收 https、挡内网，读回来是打码的
      await assert.rejects(() => webhooks.saveWebhookSettings({ enabled: true, url: "http://example.com/hook", categories: ["host"], minLevel: "info" }), /https/);
      await assert.rejects(() => webhooks.saveWebhookSettings({ enabled: true, url: "https://127.0.0.1/hook", categories: ["host"], minLevel: "info" }), /受限地址/);
      await assert.rejects(() => webhooks.saveWebhookSettings({ enabled: true, categories: ["host"], minLevel: "info" }), /先填写/);
      const view = await webhooks.getWebhookSettingsView();
      assert.equal(view.configured, false);
      assert.equal(view.enabled, false);
      assert.deepEqual(view.categories, ["host", "user", "rule", "account", "security", "ticket"]);

      // 简报：默认 9 点、不加块；全开时每块都能出（安全巡检表现在由 hostSecurityTables 建，没有问题时说一句「没有待处理的问题」）
      assert.deepEqual(await digest.getDigestSettings(), { hour: 9, blocks: [] });
      assert.deepEqual(await digest.buildOpsDigestExtraLines(), []);
      await digest.saveDigestSettings({ hour: 21, blocks: ["security", "hostTraffic", "topUsers", "availability", "offlineNow", "expiring", "lowQuota", "bogus"] });
      const saved = await digest.getDigestSettings();
      assert.equal(saved.hour, 21);
      assert.deepEqual(saved.blocks, ["hostTraffic", "topUsers", "availability", "offlineNow", "expiring", "lowQuota", "security"]);
      const lines = (await digest.buildOpsDigestExtraLines()).join("\n");
      assert.match(lines, /过去 24 小时掉线 1 台/);
      assert.match(lines, /港-1：1 次，共 35 分钟/);
      assert.match(lines, /3 天内到期/);
      assert.match(lines, /小王：剩 3%/);
      assert.match(lines, /安全巡检：没有待处理的问题/);

      // 快到期扫描：一天只记一次
      assert.equal(await hooks.recordExpiringUsersEvents(), 1);
      assert.equal(await hooks.recordExpiringUsersEvents(), 0);
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "ops-events.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
