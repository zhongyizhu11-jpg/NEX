import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import pg from "pg";

/*
  后台任务租约（server/panelLease.ts）和交给持有者的待办（server/panelWorkRequests.ts）在外部库上跑一遍：
  建表、抢 / 续 / 放、过期接手、并发抢同一个租约只有一个成功、待办的覆盖写和取走。
  要真的数据库，没设环境变量就跳过（CI 里没有）：
      FORWARDX_TEST_POSTGRES_URL=postgres://用户:密码@127.0.0.1:5432/postgres   （要能建库）
      FORWARDX_TEST_MYSQL_URL=mysql://用户:密码@127.0.0.1:3306                    （要能建库）
*/
const postgresUrl = String(process.env.FORWARDX_TEST_POSTGRES_URL || "").trim();
const mysqlUrl = String(process.env.FORWARDX_TEST_MYSQL_URL || "").trim();

const script = String.raw`
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import path from "node:path";
  import { pathToFileURL } from "node:url";

  const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(moduleUrl("server/dbRuntime.ts"));
  const schema = await import(moduleUrl("server/dbSchema.ts"));
  await runtime.connectDatabase(JSON.parse(fs.readFileSync(process.env.NEX_TEST_DB_CONFIG, "utf8")));
  await schema.ensureDatabaseSchema();
  const leaseModule = await import(moduleUrl("server/panelLease.ts"));
  const work = await import(moduleUrl("server/panelWorkRequests.ts"));
  const store = new leaseModule.SqlPanelLeaseStore();

  // 并发抢一个没人拿过的租约：只有一个成功
  const t0 = Date.now();
  const contenders = Array.from({ length: 8 }, (_, index) => "racer-" + index);
  const results = await Promise.all(contenders.map((holder) => store.tryAcquire("race", holder, t0, 30_000)));
  assert.equal(results.filter(Boolean).length, 1, "并发抢到了 " + results.filter(Boolean).length + " 个");
  const winner = contenders[results.indexOf(true)];
  assert.equal((await store.read("race")).holder, winner);
  // 拿着的续得上（同一毫秒再续也算），别人抢不到
  assert.equal(await store.tryAcquire("race", winner, t0, 30_000), true);
  assert.equal(await store.tryAcquire("race", winner, t0 + 10_000, 30_000), true);
  assert.equal(await store.tryAcquire("race", "other", t0 + 20_000, 30_000), false);
  // 过期之后：并发接手也只有一个成功
  const after = t0 + 10_000 + 30_000;
  const takeover = await Promise.all(contenders.map((holder) => store.tryAcquire("race", holder, after, 30_000)));
  assert.equal(takeover.filter(Boolean).length, 1, "过期后接手了 " + takeover.filter(Boolean).length + " 个");
  const next = contenders[takeover.indexOf(true)];
  await store.release("race", "not-the-holder");
  assert.equal((await store.read("race")).holder, next, "别人放不掉");
  await store.release("race", next);
  assert.equal(await store.read("race"), null);

  // 两个实例用 PanelLease：一个持有、一个待命；持有者不续，另一个在 TTL + 一个续约间隔内接手
  let clock = Date.now();
  const quiet = { info: () => {}, warn: () => {} };
  const makeLease = (instanceId) => new leaseModule.PanelLease({
    store, instanceId, now: () => clock, logger: quiet, setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  const a = makeLease("ext-a");
  const b = makeLease("ext-b");
  await a.start();
  await b.start();
  await a.tick();
  assert.equal(a.isHolder(), true);
  assert.equal(b.isHolder(), false);
  assert.deepEqual(a.status().otherInstanceIds, ["ext-b"]);
  const lastRenew = clock;
  let takeoverAt = null;
  while (clock - lastRenew <= leaseModule.PANEL_LEASE_TTL_MS + 2 * leaseModule.PANEL_LEASE_RENEW_INTERVAL_MS) {
    clock += leaseModule.PANEL_LEASE_RENEW_INTERVAL_MS;
    await b.tick();
    assert.ok(!(a.isHolder() && b.isHolder()));
    if (b.isHolder() && takeoverAt === null) takeoverAt = clock;
  }
  assert.ok(takeoverAt !== null && takeoverAt - lastRenew <= leaseModule.PANEL_LEASE_TTL_MS + leaseModule.PANEL_LEASE_RENEW_INTERVAL_MS);
  await a.tick();
  assert.equal(a.isHolder(), false);
  assert.equal(a.status().holderId, "ext-b");
  await b.stop({ release: true });
  clock += 1_000;
  await a.tick();
  assert.equal(a.isHolder(), true);
  assert.equal(await store.prune("instance:", clock + 60_000) >= 1, true);

  // 待办：同一件事覆盖写只留一行，取走时执行一次
  const seen = [];
  work.registerPanelWorkHandler("probe", (key, payload) => { seen.push([key, payload]); });
  await work.requestPanelWork("probe", 12, { manual: true }, 1000);
  await work.requestPanelWork("probe", 12, { forceSync: true }, 2000);
  await work.requestPanelWork("probe", "abc", null, 3000);
  const rows = await runtime.queryRaw('SELECT COUNT(*) AS n FROM ' + runtime.quoteDbIdentifier("panel_work_requests"));
  assert.equal(Number(rows[0].n), 2);
  assert.equal(await work.drainPanelWorkRequests({ now: 4000 }), 2);
  assert.deepEqual(seen, [["12", { forceSync: true }], ["abc", null]]);
  assert.equal(await work.drainPanelWorkRequests({ now: 5000 }), 0);
  console.log("ok " + runtime.getDatabaseKind());
  process.exit(0);
`;

function runScript(config: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-panel-lease-ext-"));
  try {
    const configPath = path.join(directory, "database.json");
    fs.writeFileSync(configPath, JSON.stringify(config));
    const scriptPath = path.join(directory, "lease.mjs");
    fs.writeFileSync(scriptPath, script, "utf8");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, NEX_TEST_DB_CONFIG: configPath, DATABASE_CONFIG_PATH: configPath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
    return result.stdout;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("PostgreSQL：租约原子抢占 / 续约 / 接手，待办覆盖写与取走", { skip: postgresUrl ? false : "没设 FORWARDX_TEST_POSTGRES_URL" }, async () => {
  const name = `nex_lease_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(postgresUrl);
    const output = runScript({
      type: "postgresql",
      postgresql: { host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: name, ssl: false },
    });
    assert.match(output, /ok postgresql/);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined);
    await admin.end();
  }
});

test("MySQL：租约原子抢占 / 续约 / 接手，待办覆盖写与取走", { skip: mysqlUrl ? false : "没设 FORWARDX_TEST_MYSQL_URL" }, async () => {
  const name = `nex_lease_${process.pid}_${Date.now()}`;
  const url = new URL(mysqlUrl);
  const admin = await mysql.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) });
  try {
    await admin.query(`CREATE DATABASE \`${name}\``);
    const output = runScript({
      type: "mysql",
      mysql: { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: name, ssl: false },
    });
    assert.match(output, /ok mysql/);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``).catch(() => undefined);
    await admin.end();
  }
});
