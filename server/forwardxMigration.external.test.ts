import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import mysql from "mysql2/promise";
import pg from "pg";

import { createForwardxUpstreamMysql, createForwardxUpstreamPostgres } from "./forwardxMigration.fixture";

/*
  原版 ForwardX 用外部数据库的部署迁到 NEX（要真的数据库，没设环境变量就跳过，CI 里没有）：
  - PostgreSQL：来源是 PostgreSQL，目标分别是 SQLite（默认）和另一个空的 PostgreSQL 库（--target-config）。
      FORWARDX_TEST_POSTGRES_URL=postgres://用户:密码@127.0.0.1:5432/postgres   （要能建库）
  - MySQL / MariaDB：来源是 MySQL，目标是 SQLite。
      FORWARDX_TEST_MYSQL_URL=mysql://用户:密码@127.0.0.1:3306   （要能建库）
*/
const adminUrl = String(process.env.FORWARDX_TEST_POSTGRES_URL || "").trim();
const mysqlUrl = String(process.env.FORWARDX_TEST_MYSQL_URL || "").trim();
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "server", "forwardxMigrationCli.ts");

function databaseUrl(name: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url;
}

async function withAdmin<T>(work: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, JWT_SECRET: "e".repeat(64), DATABASE_TYPE: "", DATABASE_CONFIG_PATH: "/nonexistent/database.json" },
    timeout: 180_000,
  });
}

test("原版 PostgreSQL 库 → NEX（SQLite / 空的 PostgreSQL），原库只读", { skip: adminUrl ? false : "没设 FORWARDX_TEST_POSTGRES_URL" }, async () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const sourceName = `fx_src_${suffix}`;
  const targetName = `fx_dst_${suffix}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-forwardx-pg-"));
  await withAdmin(async (client) => {
    await client.query(`CREATE DATABASE "${sourceName}"`);
    await client.query(`CREATE DATABASE "${targetName}"`);
  });
  try {
    const source = new pg.Client({ connectionString: databaseUrl(sourceName).toString() });
    await source.connect();
    try { await createForwardxUpstreamPostgres(source); } finally { await source.end(); }
    const url = databaseUrl(sourceName);
    const sourceConfig = path.join(dir, "database.json");
    fs.writeFileSync(sourceConfig, JSON.stringify({
      type: "postgresql",
      postgresql: { host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: sourceName, ssl: false },
    }));

    // 目标 1：SQLite
    const sqliteTarget = path.join(dir, "forwardx.db.nex-import");
    const toSqlite = runCli(["import", "--source-config", sourceConfig, "--target-sqlite", sqliteTarget, "--json"]);
    assert.equal(toSqlite.status, 0, `${toSqlite.stdout}\n${toSqlite.stderr}`);
    const output = JSON.parse(toSqlite.stdout);
    assert.equal(output.report.sourceKind, "postgresql");
    assert.deepEqual(output.report.counts, { users: 2, hosts: 2, forwardRules: 2, tunnels: 1, forwardGroups: 0 });
    const nex = new Database(sqliteTarget, { readonly: true });
    try {
      assert.deepEqual((nex.prepare('SELECT id, "agentToken" FROM hosts ORDER BY id').all() as any[]).map((row) => [row.id, row.agentToken]), [[10, "tok-entry"], [11, "tok-exit"]]);
      assert.equal((nex.prepare("SELECT COUNT(*) AS n FROM ticket_messages").get() as any).n, 2);
      assert.equal((nex.prepare("SELECT value FROM system_settings WHERE key = 'panelPublicUrl'").get() as any).value, "https://panel.example.com");
    } finally {
      nex.close();
    }

    // 目标 2：另一个空的 PostgreSQL 库
    const targetUrl = databaseUrl(targetName);
    const targetConfig = path.join(dir, "target.json");
    fs.writeFileSync(targetConfig, JSON.stringify({
      type: "postgresql",
      postgresql: { host: targetUrl.hostname, port: Number(targetUrl.port || 5432), user: decodeURIComponent(targetUrl.username), password: decodeURIComponent(targetUrl.password), database: targetName, ssl: false },
    }));
    const toPostgres = runCli(["import", "--source-config", sourceConfig, "--target-config", targetConfig, "--json"]);
    assert.equal(toPostgres.status, 0, `${toPostgres.stdout}\n${toPostgres.stderr}`);
    const target = new pg.Client({ connectionString: targetUrl.toString() });
    await target.connect();
    try {
      const hosts = await target.query('SELECT id, "agentDistribution" FROM hosts ORDER BY id');
      assert.deepEqual(hosts.rows.map((row) => [Number(row.id), row.agentDistribution]), [[10, "forwardx"], [11, "forwardx"]]);
      const rules = await target.query('SELECT id, "tunnelId" FROM forward_rules ORDER BY id');
      assert.deepEqual(rules.rows.map((row) => [Number(row.id), row.tunnelId === null ? null : Number(row.tunnelId)]), [[100, null], [101, 3]]);
      // 序列跟上了：之后新建主机不会撞迁过来的 ID
      const next = await target.query("SELECT nextval(pg_get_serial_sequence('hosts', 'id')) AS id");
      assert.ok(Number(next.rows[0].id) > 11);
    } finally {
      await target.end();
    }
    // 再导一次：目标库已经有数据，拒绝
    const again = runCli(["import", "--source-config", sourceConfig, "--target-config", targetConfig, "--json"]);
    assert.equal(again.status, 4, again.stderr);

    // 原库没被改：表还是原版的结构（没被加上 NEX 的列）
    const check = new pg.Client({ connectionString: databaseUrl(sourceName).toString() });
    await check.connect();
    try {
      const columns = await check.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'hosts' AND column_name = 'agentDistribution'");
      assert.equal(columns.rowCount, 0);
    } finally {
      await check.end();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${sourceName}"`);
      await client.query(`DROP DATABASE IF EXISTS "${targetName}"`);
    });
  }
});

test("原版 MySQL 库 → NEX（SQLite），原库只读", { skip: mysqlUrl ? false : "没设 FORWARDX_TEST_MYSQL_URL" }, async () => {
  const name = `fx_src_${process.pid}_${Date.now()}`;
  const url = new URL(mysqlUrl);
  const connectionOptions = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-forwardx-mysql-"));
  try {
    const source = await mysql.createConnection({ ...connectionOptions, database: name });
    try { await createForwardxUpstreamMysql(source); } finally { await source.end(); }
    // 原版 Docker 部署把 MySQL 配在 .env 里（MYSQL_*），这里走 --source-env-file
    const envFile = path.join(dir, ".env");
    fs.writeFileSync(envFile, [
      `MYSQL_HOST=${connectionOptions.host}`,
      `MYSQL_PORT=${connectionOptions.port}`,
      `MYSQL_USER=${connectionOptions.user}`,
      `MYSQL_PASSWORD=${connectionOptions.password}`,
      `MYSQL_DATABASE=${name}`,
      "",
    ].join("\n"));
    const target = path.join(dir, "forwardx.db.nex-import");
    const result = runCli(["import", "--source-env-file", envFile, "--target-sqlite", target, "--json"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.report.sourceKind, "mysql");
    assert.deepEqual(output.report.counts, { users: 2, hosts: 2, forwardRules: 2, tunnels: 1, forwardGroups: 0 });
    const nex = new Database(target, { readonly: true });
    try {
      assert.deepEqual((nex.prepare('SELECT id, "agentToken", "agentDistribution" FROM hosts ORDER BY id').all() as any[]).map((row) => [row.id, row.agentToken, row.agentDistribution]), [[10, "tok-entry", "forwardx"], [11, "tok-exit", "forwardx"]]);
      const users = nex.prepare("SELECT username, \"googleSub\", \"inviterId\" FROM users ORDER BY username").all() as any[];
      assert.equal(users.find((user) => user.username === "alice")?.googleSub, "google-sub-alice");
      assert.equal((nex.prepare("SELECT title FROM tickets").get() as any).title, "隧道连不上", "中文不乱码");
    } finally {
      nex.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  }
});
