import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureDatabaseSchema } from "./dbSchema";

test("history cleanup predicates use time-leading SQLite indexes", async () => {
  const sqlite = new Database(":memory:");
  try {
    await ensureDatabaseSchema(sqlite);
    const cases = [
      ["forward_group_events", "createdAt"],
      ["tunnel_latency_stats", "recordedAt"],
      ["forward_group_latency_stats", "recordedAt"],
      ["forward_tests", "updatedAt"],
      ["route_path_quality_stats", "sampledAt"],
    ] as const;
    for (const [table, column] of cases) {
      const plan = sqlite.prepare(
        `EXPLAIN QUERY PLAN DELETE FROM "${table}" WHERE "${column}" < ?`,
      ).all(1) as Array<{ detail?: string }>;
      const detail = plan.map((row) => String(row.detail || "")).join(" | ");
      assert.match(detail, /USING INDEX/i, `${table}.${column}: ${detail}`);
      assert.match(detail, new RegExp(column, "i"), `${table}.${column}: ${detail}`);
    }
  } finally {
    sqlite.close();
  }
});

test("host status sweeps use the online-heartbeat SQLite index", async () => {
  const sqlite = new Database(":memory:");
  try {
    await ensureDatabaseSchema(sqlite);
    const plan = sqlite.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM "hosts"
       WHERE "isOnline" = 1
         AND "lastHeartbeat" IS NOT NULL
         AND "lastHeartbeat" < ?`,
    ).all(1) as Array<{ detail?: string }>;
    const detail = plan.map((row) => String(row.detail || "")).join(" | ");
    assert.match(detail, /USING INDEX/i, detail);
    assert.match(detail, /isOnline.*lastHeartbeat/i, detail);

    const updatePlan = sqlite.prepare(
      `EXPLAIN QUERY PLAN UPDATE "hosts" SET "isOnline" = 0, "updatedAt" = ?
       WHERE "id" = ?
         AND "isOnline" = 1
         AND "lastHeartbeat" IS NOT NULL
         AND "lastHeartbeat" < ?`,
    ).all(2, 1, 1) as Array<{ detail?: string }>;
    assert.match(updatePlan.map((row) => String(row.detail || "")).join(" | "), /PRIMARY KEY|INTEGER PRIMARY KEY/i);
  } finally {
    sqlite.close();
  }
});

/**
 * 派生节点的每一次读写都按 inboundId 过滤：保存入站、删除入站、主机换地址后重算、
 * 界面上列出某个端口派生了哪几条。原来这一列上没有索引，这些全是整表扫描 ——
 * 一个商家几百上千行节点时，删一个入站要扫一遍全表，而这条路上还挂着「删节点顺带
 * 解绑转发规则」，一次操作里要扫好几遍。
 */
test("派生节点按 inboundId 查要走索引", async () => {
  const sqlite = new Database(":memory:");
  try {
    await ensureDatabaseSchema(sqlite);
    for (const [sql, params] of [
      [`EXPLAIN QUERY PLAN SELECT * FROM "proxy_nodes" WHERE "inboundId" = ?`, [1]],
      [`EXPLAIN QUERY PLAN SELECT * FROM "proxy_nodes" WHERE "inboundId" IN (?, ?)`, [1, 2]],
    ] as Array<[string, number[]]>) {
      const plan = sqlite.prepare(sql).all(...params) as Array<{ detail?: string }>;
      const detail = plan.map((row) => String(row.detail || "")).join(" | ");
      assert.match(detail, /USING INDEX/i, `整表扫描：${detail}`);
      assert.match(detail, /inboundId/i, detail);
    }
  } finally {
    sqlite.close();
  }
});
