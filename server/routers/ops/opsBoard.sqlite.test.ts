import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 监控 › 看板：账务、流量、来源三块都从现成的表聚合，按北京时间切天。 */
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ops-board-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "db.sqlite");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("../../dbRuntime");
let board: typeof import("./opsBoard");

// 2026-10-17 12:00 北京时间
const NOW = Date.parse("2026-10-17T12:00:00+08:00") / 1000;
const DAY = 86400;

before(async () => {
  runtime = await import("../../dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("../../dbSchema")).ensureDatabaseSchema();
  board = await import("./opsBoard");
  const exec = (sql: string, params: unknown[] = []) => runtime.executeRaw(sql, params);
  await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin'), (2, 'bob', 'h', 'user')");
  const order = (no: string, status: string, cents: number, at: number, currency = "CNY", type = "balance") => exec(
    "INSERT INTO payment_orders (outTradeNo, userId, provider, paymentType, status, subject, amountCents, currency, orderType, createdAt, updatedAt) VALUES (?, 2, 'easypay', 'alipay', ?, 's', ?, ?, ?, ?, ?)",
    [no, status, cents, currency, type, at, at],
  );
  await order("A", "completed", 1000, NOW - 60);
  await order("B", "processing", 500, NOW - 60);
  await order("C", "pending", 700, NOW - 60);
  await order("D", "expired", 900, NOW - 60);
  await order("E", "completed", 300, NOW - 60, "USD");
  await order("T", "completed", 99999, NOW - 60, "CNY", "test");
  await order("OLD", "completed", 5000, NOW - 3 * DAY);
  await exec("INSERT INTO balance_transactions (userId, type, amountCents, balanceAfterCents, createdAt) VALUES (2, 'payment', 1000, 1000, ?), (2, 'traffic', -250, 750, ?)", [NOW - 30, NOW - 20]);
  await exec("INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId) VALUES (5, 1, '香港 01', 'gost', 'tcp', 1000, '1.1.1.1', 443, 2)").catch(async () => {
    await exec("INSERT INTO hosts (id, name, ip, userId) VALUES (1, 'h', '10.0.0.1', 1)");
    await exec("INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId) VALUES (5, 1, '香港 01', 'gost', 'tcp', 1000, '1.1.1.1', 443, 2)");
  });
  // 今天两段、昨天一段，加一条已删除规则的流量
  const bucket = (start: number, ruleId: number, inBytes: number, outBytes: number) => exec(
    "INSERT INTO traffic_stat_buckets (bucketStart, bucketMinutes, userId, ruleId, hostId, bytesIn, bytesOut) VALUES (?, 30, 2, ?, 1, ?, ?)",
    [start, ruleId, inBytes, outBytes],
  );
  await bucket(NOW - 3600, 5, 100, 200);
  await bucket(NOW - 1800, 5, 10, 20);
  await bucket(NOW - DAY, 5, 1, 2);
  await bucket(NOW - 1800, 99, 1000, 0);
  const seen = (ip: string, ruleId: number, conns: number) => exec(
    "INSERT INTO ip_sightings (hostId, ip, userId, ruleId, inboundId, firstSeenAt, lastSeenAt, connCount) VALUES (1, ?, 2, ?, 0, ?, ?, ?)",
    [ip, ruleId, NOW - 100, NOW - 50, conns],
  );
  await seen("1.1.1.1", 5, 3);
  await seen("1.1.1.1", 6, 1);
  await seen("10.0.0.9", 5, 9);
});

after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("账务：已完成和开通中的算实收，按币种分开；测试单和范围外的不算", async () => {
  const data = await board.buildOpsBoard(1, NOW);
  assert.deepEqual(data.finance.revenue, [{ currency: "CNY", cents: 1500 }, { currency: "USD", cents: 300 }]);
  assert.deepEqual(data.finance.orders, { completed: 2, delivering: 1, pending: 1, closed: 1 });
  assert.equal(data.finance.balanceInCents, 1000);
  assert.equal(data.finance.balanceOutCents, 250);
  const week = await board.buildOpsBoard(7, NOW);
  assert.equal(week.finance.revenue[0].cents, 6500);
});

test("流量：按北京时间逐天，空的天也有一格；规则排行带已删除的", async () => {
  const data = await board.buildOpsBoard(7, NOW);
  assert.equal(data.traffic.daily.length, 7);
  assert.deepEqual(data.traffic.daily.at(-1), { date: "2026-10-17", inBytes: 1110, outBytes: 220 });
  assert.deepEqual(data.traffic.daily.at(-2), { date: "2026-10-16", inBytes: 1, outBytes: 2 });
  assert.equal(data.traffic.daily[0].inBytes, 0);
  assert.equal(data.traffic.topRules[0].ruleId, 99);
  assert.equal(data.traffic.topRules[0].deleted, true);
  assert.equal(data.traffic.topRules[1].name, "香港 01");
});

test("来源：按 IP 归并，连接数多的排前面", async () => {
  const data = await board.buildOpsBoard(1, NOW);
  assert.equal(data.sources.distinctIps, 2);
  assert.equal(data.sources.top[0].ip, "10.0.0.9");
  const cloudflare = data.sources.top.find((row) => row.ip === "1.1.1.1")!;
  assert.equal(cloudflare.rules, 2);
  assert.equal(cloudflare.conns, 3);
  assert.equal(data.sources.areas.reduce((sum, area) => sum + area.count, 0), 2);
});
