import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

import { MIGRATION_TABLES } from "./dbSchema";
import { OPS_MIGRATION_TABLES, OPS_TABLE_DEFS } from "./ops/opsTables";

test("拓扑手动标注的表：建表、跟着迁移走、节点在连线前面、老库缺表不算错", () => {
  for (const name of ["topology_manual_nodes", "topology_manual_links"]) {
    assert.ok(OPS_TABLE_DEFS.some((table) => table.name === name), `${name} 要交给 dbSchema 建表`);
    assert.ok(OPS_MIGRATION_TABLES.includes(name));
    assert.ok((MIGRATION_TABLES as readonly string[]).includes(name));
  }
  const source = fs.readFileSync(path.join(process.cwd(), "server/migration.ts"), "utf8");
  const order = source.slice(source.indexOf("IMPORT_TABLE_ORDER"));
  assert.ok(order.indexOf('"topology_manual_nodes"') < order.indexOf('"topology_manual_links"'));
  const optional = source.slice(source.indexOf("DIRECT_SQLITE_OPTIONAL_SOURCE_TABLES = new Set(["));
  assert.ok(optional.slice(0, optional.indexOf("]);")).includes('"topology_manual_links"'));
});

test("拓扑手动标注：每个账号各画各的、主机要有权限、删节点连线跟着删、并进拓扑图、迁移导入重映射 ID", () => {
  runInDatabase(String.raw`
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
      await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'alice', 'hash', 'user')");
      await exec('INSERT INTO hosts (id, name, ip, "hostType", "agentToken", "userId") VALUES (1, ?, ?, ?, ?, 1)', ["管理员的机器", "8.8.8.8", "slave", "tok1"]);
      await exec('INSERT INTO hosts (id, name, ip, "hostType", "agentToken", "userId") VALUES (2, ?, ?, ?, ?, 2)', ["alice 的机器", "9.9.9.9", "slave", "tok2"]);
      const { topologyRouter } = await import(url("server/routers/topology.ts"));
      const ctx = (id, role) => ({ user: { id, role, username: role }, req: { headers: {} }, res: { setHeader: () => {} } });
      const alice = topologyRouter.createCaller(ctx(2, "user"));
      const admin = topologyRouter.createCaller(ctx(1, "admin"));

      const { id: nodeId } = await alice.createManualNode({ label: "IPLC 日本端", note: "100M", country: "jp" });
      await assert.rejects(() => alice.createManualLink({ fromRef: "host:2", toRef: "host:1" }), /外部节点/, "两头都是主机不行");
      await assert.rejects(() => alice.createManualLink({ fromRef: "manual:" + nodeId, toRef: "host:1" }), /无权/, "别人的主机不能连");
      await alice.createManualLink({ fromRef: "host:2", toRef: "manual:" + nodeId, label: "IPLC" });
      // 管理员看不到 alice 的标注
      assert.equal((await admin.manual()).nodes.length, 0);
      await assert.rejects(() => admin.deleteManualNode({ id: nodeId }), /不存在/);

      const graph = await alice.graph();
      const external = graph.nodes.find((n) => n.id === "manual:" + nodeId);
      assert.equal(external.kind, "external");
      assert.equal(external.country, "JP");
      assert.ok(graph.nodes.some((n) => n.id === "host:2"), "没跑转发的主机也补上节点");
      assert.equal(graph.edges.filter((e) => e.kind === "manual").length, 1);

      // 只动这两张表：没有规则、主机被改
      const rules = await query("SELECT COUNT(*) AS c FROM forward_rules");
      assert.equal(Number(rules[0].c), 0);

      // 迁移：导出 → 换个已经有数据的库导入，用户、主机、标注节点的 ID 都换了
      const migration = await import(url("server/migration.ts"));
      const snapshot = await migration.exportMigrationSnapshot();
      assert.equal(snapshot.tables.topology_manual_nodes.length, 1);
      assert.equal(snapshot.tables.topology_manual_links.length, 1);
      // 第二个面板用一个 SQLite 文件库；跑在 PostgreSQL 上时产品不允许进程内换库种（DatabaseDialectMismatchError），这段只在 SQLite 上跑
      if (runtime.getDatabaseKind() === "sqlite") {
      await runtime.closeDatabase();
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(path.dirname(process.env.FORWARDX_TEST_DB), "panel2.db") } });
      await schema.ensureDatabaseSchema();
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'root', 'hash', 'admin')");
      await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'bob', 'hash', 'user')");
      await exec('INSERT INTO hosts (id, name, ip, "hostType", "agentToken", "userId") VALUES (1, ?, ?, ?, ?, 1)', ["已有", "1.0.0.1", "slave", "tok-x"]);
      await exec('INSERT INTO hosts (id, name, ip, "hostType", "agentToken", "userId") VALUES (2, ?, ?, ?, ?, 1)', ["已有2", "1.0.0.2", "slave", "tok-y"]);
      await exec('INSERT INTO topology_manual_nodes (id, "userId", label) VALUES (1, 2, ?)', ["bob 的节点"]);
      const result = await migration.importMigrationSnapshot(snapshot);
      assert.equal(result.success, true, JSON.stringify(result));
      const newAlice = (await query("SELECT id FROM users WHERE username = 'alice'"))[0].id;
      const newHost = (await query('SELECT id FROM hosts WHERE "agentToken" = ?', ["tok2"]))[0].id;
      const nodes = await query('SELECT * FROM topology_manual_nodes WHERE "userId" = ?', [newAlice]);
      assert.equal(nodes.length, 1);
      assert.notEqual(Number(nodes[0].id), nodeId, "节点 ID 撞上已有的那一行，换了新的");
      const links = await query('SELECT * FROM topology_manual_links WHERE "userId" = ?', [newAlice]);
      assert.equal(links.length, 1);
      assert.equal(links[0].fromRef, "host:" + newHost);
      assert.equal(links[0].toRef, "manual:" + nodes[0].id);

      // 回到第一个库
      await runtime.closeDatabase();
      await runtime.connectDatabase(JSON.parse(process.env.FORWARDX_TEST_DB_CONFIG));
      }

      // 删节点连线跟着删；删用户标注跟着删
      const second = await alice.createManualNode({ label: "上游机房" });
      await alice.createManualLink({ fromRef: "manual:" + second.id, toRef: "manual:" + nodeId });
      await alice.deleteManualNode({ id: nodeId });
      assert.equal((await alice.manual()).links.length, 0);
      const db = await import(url("server/db.ts"));
      await db.deleteUser(2);
      assert.equal(Number((await query("SELECT COUNT(*) AS c FROM topology_manual_nodes"))[0].c), 0);
  `, { name: "topology-manual", timeoutMs: 180_000 });
});
