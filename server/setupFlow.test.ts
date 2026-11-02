import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runSetupFlow(body: string, options: { config?: (directory: string, databasePath: string) => unknown; connect?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-setup-flow-"));
  const databasePath = path.join(directory, "forwardx.db");
  const configPath = path.join(directory, "database.json");
  const config = options.config ? options.config(directory, databasePath) : { type: "sqlite", sqlite: { path: databasePath } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const connect = options.connect !== false;

  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const db = await import(url("server/db.ts"));
    const migration = await import(url("server/migration.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));
    const taskLocks = await import(url("server/keyedTaskLock.ts"));
    const { setupRouter } = await import(url("server/routers/setup.ts"));
    try {
      if (${connect}) {
        await runtime.connectDatabase();
        await schema.ensureDatabaseSchema();
      }
      const caller = setupRouter.createCaller({ user: null });
      ${body}
    } finally {
      await runtime.closeDatabase();
    }
  `;

  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_CONFIG_PATH: configPath,
      SQLITE_PATH: databasePath,
      JWT_SECRET: "setup-flow-test-secret",
      NODE_ENV: "test",
      FORWARDX_TEST_DIRECTORY: directory,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("initial admin email login is case-insensitive and an existing admin always completes setup", () => {
  runSetupFlow(String.raw`
    await caller.createAdmin({
      email: "Admin@Example.COM",
      password: " correct-horse-123 ",
      name: "Admin",
    });
    const stored = (await runtime.queryRaw('SELECT "id", "username", "role" FROM "users"'))[0];
    assert.equal(stored.username, "admin@example.com");
    assert.ok(await users.authenticateUser("ADMIN@example.com", " correct-horse-123 "));
    assert.equal(await users.authenticateUser("admin@example.com", "correct-horse-123"), null);
    await runtime.executeRaw('UPDATE "users" SET "email" = ? WHERE "id" = ?', ["owner@example.net", stored.id]);
    assert.ok(await users.authenticateUser("OWNER@EXAMPLE.NET", " correct-horse-123 "));

    await runtime.executeRaw(
      'INSERT INTO "hosts" ("name", "ip", "hostType", "userId") VALUES (?, ?, ?, ?)',
      ["legacy-host", "127.0.0.1", "slave", stored.id],
    );
    await runtime.executeRaw('DELETE FROM "system_settings" WHERE "key" = ?', ["setupDataChoice"]);
    const status = await caller.status();
    assert.equal(status.hasAdmin, true);
    assert.equal(status.setupComplete, true);
  `);
});

test("a stale local marker stays locked until local recovery and concurrent setup creates one admin", () => {
  runSetupFlow(String.raw`
    const marker = path.join(process.env.FORWARDX_TEST_DIRECTORY, ".setup-complete");
    fs.writeFileSync(marker, "legacy\n");
    const lockedStatus = await caller.status();
    assert.equal(lockedStatus.setupLocked, true);
    assert.equal(lockedStatus.hasExistingData, false);
    assert.equal(lockedStatus.existingData, null);
    assert.equal(lockedStatus.setupDataChoice, null);
    assert.equal(lockedStatus.config, null);
    assert.equal(lockedStatus.defaultSqlitePath, "");
    assert.equal(lockedStatus.error, null);
    const localAdminStatus = await setupRouter.createCaller({ user: { role: "admin" } }).status();
    assert.notEqual(localAdminStatus.config, null);
    assert.notEqual(localAdminStatus.defaultSqlitePath, "");
    await assert.rejects(
      caller.createAdmin({ email: "Blocked@Example.com", password: "blocked-password", name: "Blocked" }),
      /SETUP_LOCKED/,
    );
    assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "users"'))[0].count, 0);

    fs.unlinkSync(marker);
    await assert.rejects(
      caller.createAdmin({ email: "Spaces@Example.com", password: "        ", name: "Spaces" }),
      /请输入管理员密码/,
    );
    const attempts = await Promise.allSettled([
      caller.createAdmin({ email: "First@Example.com", password: "first-password", name: "First" }),
      caller.createAdmin({ email: "Second@Example.com", password: "second-password", name: "Second" }),
    ]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
    const count = (await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "users" WHERE "role" = ?', ["admin"]))[0].count;
    assert.equal(count, 1);
    assert.equal(await db.getSetting("setupDataChoice"), "new-panel");
  `);
});

test("concurrent admin creation prevents a stale setup reset from deleting the new account", () => {
  runSetupFlow(String.raw`
    const lockKey = "panel-setup-write";
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const blocker = taskLocks.withKeyedTaskLock(lockKey, () => gate);
    const waitForDepth = async (expected) => {
      for (let attempt = 0; attempt < 100 && taskLocks.keyedTaskDepth(lockKey) < expected; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (taskLocks.keyedTaskDepth(lockKey) < expected) {
        releaseGate();
        throw new Error('setup request did not enter the shared lock');
      }
    };

    const createdPromise = caller.createAdmin({ email: "Winner@Example.com", password: "winner-password", name: "Winner" });
    await waitForDepth(2);
    const resetPromise = caller.resetExistingData();
    await waitForDepth(3);
    releaseGate();
    await blocker;
    const [created, reset] = await Promise.allSettled([createdPromise, resetPromise]);
    assert.equal(created.status, "fulfilled");
    assert.equal(reset.status, "rejected");
    assert.match(String(reset.status === "rejected" ? reset.reason?.message : ""), /SETUP_LOCKED/);
    const admins = await runtime.queryRaw('SELECT "username" FROM "users" WHERE "role" = ?', ["admin"]);
    assert.deepEqual(admins.map((row) => row.username), ["winner@example.com"]);
    assert.equal(await db.getSetting("setupDataChoice"), "new-panel");
    assert.equal(fs.existsSync(path.join(process.env.FORWARDX_TEST_DIRECTORY, ".setup-complete")), true);
  `);
});

test("an active panel migration keeps setup open after administrator rows arrive", () => {
  runSetupFlow(String.raw`
    // Exercise real setup/migration state without requiring a non-loopback NIC
    // or making network requests. URL validation still runs normally.
    const originalFetch = globalThis.fetch;
    let finishRequest = () => {};
    let markRequestSeen;
    const requestSeen = new Promise((resolve) => { markRequestSeen = resolve; });
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "http://10.0.0.1:9810/api/migration/export");
      assert.equal(options.method, "POST");
      assert.equal(JSON.parse(options.body).migrationCode, "migration-test-code");
      return new Promise((resolve) => {
        finishRequest = () => resolve(new Response("migration test finished", { status: 503 }));
        markRequestSeen();
      });
    };
    try {
      const job = await caller.startMigration({
        oldPanelUrl: "http://10.0.0.1:9810",
        migrationCode: "migration-test-code",
        targetPanelUrl: "http://127.0.0.1:9810",
        dataScope: "essential",
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("migration request was not received")), 3000);
        requestSeen.then(() => {
          clearTimeout(timer);
          resolve();
        }, reject);
      });
      await db.createInitialAdmin({ email: "Migrated@Example.com", password: "migrated-password", name: "Migrated" });
      const status = await caller.status();
      assert.equal(status.hasAdmin, true);
      assert.equal(status.setupComplete, false);

      finishRequest();
      for (let attempt = 0; attempt < 100 && migration.getMigrationJob(job.id)?.status !== "failed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(migration.getMigrationJob(job.id)?.status, "failed");
    } finally {
      finishRequest();
      globalThis.fetch = originalFetch;
    }
  `);
});

test("setup writes are refused after install, for administrators too", () => {
  runSetupFlow(String.raw`
    const adminCaller = setupRouter.createCaller({ user: { role: "admin" } });
    // 全新安装：没有管理员、没有完成标记时，向导可以写（带不带登录态都一样）。
    await adminCaller.testDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
    await caller.createAdmin({ email: "Owner@Example.com", password: "owner-password", name: "Owner" });
    const marker = path.join(process.env.FORWARDX_TEST_DIRECTORY, ".setup-complete");
    assert.equal(fs.existsSync(marker), true);

    const attempts = [
      () => adminCaller.resetExistingData(),
      () => adminCaller.useExistingData(),
      () => adminCaller.updateAdmin({ email: "attacker@example.com", password: "attacker-password" }),
      () => adminCaller.createAdmin({ email: "second@example.com", password: "second-password" }),
      () => adminCaller.saveDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } }),
      () => adminCaller.testDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt(), /SETUP_LOCKED/);
    }

    // 本机标记丢了，但库里已有管理员：照样锁住。
    fs.unlinkSync(marker);
    await assert.rejects(adminCaller.resetExistingData(), /SETUP_LOCKED/);
    await assert.rejects(adminCaller.updateAdmin({ email: "attacker@example.com" }), /SETUP_LOCKED/);

    const admins = await runtime.queryRaw('SELECT "username" FROM "users" WHERE "role" = ?', ["admin"]);
    assert.deepEqual(admins.map((row) => row.username), ["owner@example.com"]);
    assert.ok(await users.authenticateUser("owner@example.com", "owner-password"));
  `);
});

test("database recovery during a pending first install still reaches the setup database step", () => {
  // 库路径指向一个目录：连不上库。database.json 带 setupPending（安装脚本写的），说明首次安装还没完成。
  const brokenConfig = (directory: string) => {
    const blocked = path.join(directory, "not-a-database");
    fs.mkdirSync(blocked, { recursive: true });
    return { type: "sqlite", sqlite: { path: blocked }, setupPending: true };
  };
  runSetupFlow(String.raw`
    const target = path.join(process.env.FORWARDX_TEST_DIRECTORY, "recovered.db");
    const result = await caller.testDatabase({ type: "sqlite", sqlite: { path: target } });
    assert.equal(result.success, true);
    const adminResult = await setupRouter.createCaller({ user: { role: "admin" } })
      .testDatabase({ type: "sqlite", sqlite: { path: target } });
    assert.equal(adminResult.success, true);
    // 不在恢复白名单里的写接口照旧拒绝。
    await assert.rejects(caller.useExistingData(), /SETUP_LOCKED/);
  `, { config: brokenConfig, connect: false });
});

test("a broken database without a pending install stays locked", () => {
  const brokenConfig = (directory: string) => {
    const blocked = path.join(directory, "not-a-database");
    fs.mkdirSync(blocked, { recursive: true });
    return { type: "sqlite", sqlite: { path: blocked } };
  };
  runSetupFlow(String.raw`
    // 第一次失败记下数据库故障，之后的请求由故障中间件直接 503；两种都是拒绝。
    const target = path.join(process.env.FORWARDX_TEST_DIRECTORY, "other.db");
    await assert.rejects(caller.testDatabase({ type: "sqlite", sqlite: { path: target } }), /SETUP_LOCKED|数据库暂时不可用/);
    await assert.rejects(
      setupRouter.createCaller({ user: { role: "admin" } }).saveDatabase({ type: "sqlite", sqlite: { path: target } }),
      /SETUP_LOCKED|数据库暂时不可用/,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(JSON.parse(fs.readFileSync(process.env.DATABASE_CONFIG_PATH, "utf8")).sqlite.path.endsWith("not-a-database"), true);
  `, { config: brokenConfig, connect: false });
});
