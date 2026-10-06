import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MIGRATION_TABLES, getDatabaseTableDefs } from "./dbSchema";

function runSqliteScript(script: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("订阅相关的表已登记进面板迁移，升级面板不会丢配置", () => {
  // 节点模板和令牌是用户配置而非可重建的历史数据，漏登记会在迁移面板时静默丢失。
  assert.ok(MIGRATION_TABLES.includes("proxy_nodes" as never));
  assert.ok(MIGRATION_TABLES.includes("proxy_sub_tokens" as never));
});

test("转发规则的订阅绑定字段在表定义里", () => {
  const forwardRules = getDatabaseTableDefs().find((table) => table.name === "forward_rules");
  assert.ok(forwardRules);
  const columns = new Set(forwardRules!.columns.map((column) => column.name));

  assert.ok(columns.has("proxyNodeId"));
  assert.ok(columns.has("proxyNodeVisible"));
  assert.ok(columns.has("proxyNodeName"));
});

test("订阅权限的列在 users 与套餐表上", () => {
  const defs = getDatabaseTableDefs();
  const columnsOf = (name: string) =>
    new Set(defs.find((table) => table.name === name)?.columns.map((column) => column.name) ?? []);

  const users = columnsOf("users");
  // 有效值与手动授权分开存：有效值由手动与套餐合并得出，不能直接覆盖手动授权。
  assert.ok(users.has("allowProxySubscription"));
  assert.ok(users.has("manualAllowProxySubscription"));
  assert.ok(columnsOf("subscription_plans").has("allowProxySubscription"));
});

test("全新数据库会建出订阅所需的表和列", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-schema-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      import BetterSqlite3 from "better-sqlite3";
      const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const schema = await import(moduleUrl("server/dbSchema.ts"));

      const db = new BetterSqlite3(process.env.FORWARDX_TEST_DB);
      await schema.ensureDatabaseSchema(db);

      const columnsOf = (table) => new Set(db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => row.name));

      const nodeColumns = columnsOf("proxy_nodes");
      for (const name of ["userId", "name", "protocol", "address", "port", "uuid", "password", "method", "transport", "tls", "sni", "realityPublicKey", "autoGroup", "isEnabled"]) {
        assert.ok(nodeColumns.has(name), "proxy_nodes 缺列: " + name);
      }

      const tokenColumns = columnsOf("proxy_sub_tokens");
      for (const name of ["userId", "name", "token", "defaultFormat", "rulePreset", "isEnabled", "lastAccessAt", "expiresAt"]) {
        assert.ok(tokenColumns.has(name), "proxy_sub_tokens 缺列: " + name);
      }

      const ruleColumns = columnsOf("forward_rules");
      for (const name of ["proxyNodeId", "proxyNodeVisible", "proxyNodeName"]) {
        assert.ok(ruleColumns.has(name), "forward_rules 缺列: " + name);
      }

      // 令牌必须唯一，否则两个用户可能拿到同一个订阅地址。
      db.prepare("INSERT INTO proxy_sub_tokens (userId, name, token) VALUES (1, 'phone', 'token-a')").run();
      assert.throws(() => db.prepare("INSERT INTO proxy_sub_tokens (userId, name, token) VALUES (2, 'other', 'token-a')").run());

      console.log("ok");
    `;
    const output = runSqliteScript(script, { FORWARDX_TEST_DB: path.join(directory, "panel.db") });
    assert.match(output, /ok/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("已有安装升级时通过 ALTER TABLE 补齐新列且不丢数据", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-upgrade-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      import BetterSqlite3 from "better-sqlite3";
      const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const schema = await import(moduleUrl("server/dbSchema.ts"));

      const db = new BetterSqlite3(process.env.FORWARDX_TEST_DB);

      // 模拟升级前的库：forward_rules 没有订阅相关列，且已有一条转发。
      db.exec("CREATE TABLE forward_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, hostId INTEGER NOT NULL, name TEXT NOT NULL, sourcePort INTEGER NOT NULL, targetIp TEXT NOT NULL, targetPort INTEGER NOT NULL, userId INTEGER NOT NULL, sortOrder INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0)");
      db.prepare("INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId) VALUES (1, 1, '广州转发', 20001, '203.0.113.9', 443, 1)").run();

      await schema.ensureDatabaseSchema(db);

      const ruleColumns = new Set(db.prepare("PRAGMA table_info(forward_rules)").all().map((row) => row.name));
      for (const name of ["proxyNodeId", "proxyNodeVisible", "proxyNodeName"]) {
        assert.ok(ruleColumns.has(name), "升级后 forward_rules 仍缺列: " + name);
      }

      // 既有转发必须还在，并且默认不进订阅（未绑定模板）。
      const row = db.prepare("SELECT * FROM forward_rules WHERE id = 1").get();
      assert.equal(row.name, "广州转发");
      assert.equal(row.sourcePort, 20001);
      assert.equal(row.proxyNodeId, null);
      // 显示开关默认开启，绑定模板后无需再手动打开。
      assert.equal(Number(row.proxyNodeVisible), 1);

      console.log("ok");
    `;
    const output = runSqliteScript(script, { FORWARDX_TEST_DB: path.join(directory, "panel.db") });
    assert.match(output, /ok/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Drizzle 的 proxyNodes 声明了物理表 proxy_nodes 的每一列", async () => {
  // 物理列加在 server/dbSchema.ts 里就会建出来，但 db.select().from(proxyNodes) 只投影
  // drizzle/schema.ts 里声明过的列：漏声明的列读出来永远是 undefined，订阅里就是 0。
  const { getTableColumns } = await import("drizzle-orm");
  const { proxyNodes } = await import("../drizzle/schema");
  const physical = getDatabaseTableDefs().find((table) => table.name === "proxy_nodes");
  assert.ok(physical);
  const columns = getTableColumns(proxyNodes) as Record<string, { name: string }>;
  const declared = new Set(Object.values(columns).map((column) => column.name));
  for (const column of physical!.columns) {
    assert.ok(declared.has(column.name), `drizzle/schema.ts 的 proxyNodes 缺列: ${column.name}`);
  }
});
