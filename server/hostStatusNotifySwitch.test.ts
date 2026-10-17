import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 主机的「上下线通知」开关（上游 2.3.285）：
 * - 老库升级、新建主机都默认开；只有管理员能关，主人改别的字段不会把它改回去；
 * - 关掉之后这台的上线 / 离线都不推，但离线照样判定、事件照样记；
 * - 一批掉线里有关掉的，汇总消息也不把它算进去。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-notify-switch-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const messages = [];
      globalThis.fetch = async (_target, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        messages.push(String(body.text || ""));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: messages.length } }) };
      };
      console.info = () => {};
      console.warn = () => {};

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      // 先建一张没有这一列的老 hosts 表，再跑建表升级：老主机也要默认开。
      await runtime.executeRaw('CREATE TABLE hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL, "userId" INTEGER NOT NULL, "createdAt" INTEGER NOT NULL DEFAULT 0, "updatedAt" INTEGER NOT NULL DEFAULT 0)');
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, \"userId\") VALUES (1, 'legacy', '198.51.100.1', 1)");
      const schema = await import(url("server/dbSchema.ts"));
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const db = await import(url("server/db.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      for (const [key, value] of Object.entries({ telegramBotEnabled: "true", telegramBotToken: "1:token", telegramHostStatusNotify: "true" })) {
        await settings.setSetting(key, value);
      }
      await exec('INSERT INTO users (id, username, password, role, "telegramId") VALUES (1, ?, ?, ?, ?)', ["admin", "h", "admin", "tg-admin"]);
      await exec('INSERT INTO users (id, username, password, role) VALUES (2, ?, ?, ?)', ["tenant", "h", "user"]);
      const router = (await import(url("server/routers/hosts.ts"))).hostsRouter;
      const caller = (id, role) => router.createCaller({ user: { id, role, username: "u" + id, accountEnabled: true }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null });
      const admin = caller(1, "admin");
      const tenant = caller(2, "user");
      const notifier = await import(url("server/hostStatusNotifier.ts"));

      ${body}

      console.log("OK");
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "hosts.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        TELEGRAM_BOT_TOKEN: "",
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("老库升级、新建主机默认开；只有管理员能关", () => {
  runInDatabase(String.raw`
    assert.equal((await db.getHostById(1)).hostStatusNotifyEnabled, true, "老主机升级后默认开");
    const created = await admin.create({ name: "a", ip: "198.51.100.2" });
    assert.equal((await db.getHostById(created.id)).hostStatusNotifyEnabled, true);
    const muted = await admin.create({ name: "m", ip: "198.51.100.3", hostStatusNotifyEnabled: false });
    assert.equal((await db.getHostById(muted.id)).hostStatusNotifyEnabled, false);
    const owned = await tenant.create({ name: "t", ip: "198.51.100.4", hostStatusNotifyEnabled: false });
    assert.equal((await db.getHostById(owned.id)).hostStatusNotifyEnabled, true, "租户建机器时关不掉");
    await admin.update({ id: owned.id, hostStatusNotifyEnabled: false });
    await tenant.update({ id: owned.id, name: "renamed", hostStatusNotifyEnabled: true });
    const after = await db.getHostById(owned.id);
    assert.equal(after.hostStatusNotifyEnabled, false, "租户改不回管理员的设置");
    assert.equal(after.name, "renamed");
    await admin.update({ id: owned.id, name: "admin rename" });
    assert.equal((await db.getHostById(owned.id)).hostStatusNotifyEnabled, false, "改别的字段不动它");
  `);
});

test("关掉的主机上下线都不推，但照样判离线；批量掉线的汇总也不算它", () => {
  runInDatabase(String.raw`
    const now = Math.floor(Date.now() / 1000);
    for (let id = 10; id < 20; id += 1) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, "机器" + id, "10.8.0." + id, "10.8.0." + id, "slave", "tk" + id, now]);
    }
    // 10..16 关掉通知：掉 10 台，真正要推的只剩 3 台，低于汇总阈值，应当一台一条。
    await exec('UPDATE hosts SET "hostStatusNotifyEnabled" = 0 WHERE id BETWEEN 10 AND 16');
    await notifier.primeHostStatusNotifier();
    messages.length = 0;
    await exec('UPDATE hosts SET "lastHeartbeat" = ? WHERE id >= 10', [now - 3600]);
    assert.equal(await notifier.sweepOfflineHostsAndNotify(), 10, "离线判定不受开关影响");
    for (let id = 10; id < 20; id += 1) assert.equal((await db.getHostById(id)).isOnline, false);
    assert.equal(messages.length, 3, JSON.stringify(messages));
    assert.ok(messages.every((text) => /机器1[789]/.test(text)), "只推开着通知的那几台");

    messages.length = 0;
    await db.touchHostHeartbeat(10);
    await notifier.notifyHostOnlineIfNeeded(await db.getHostById(10));
    assert.equal(messages.length, 0, "上线也不推");
    await db.touchHostHeartbeat(17);
    await notifier.notifyHostOnlineIfNeeded(await db.getHostById(17));
    assert.equal(messages.length, 1);
  `);
});
