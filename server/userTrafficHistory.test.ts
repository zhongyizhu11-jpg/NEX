import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { aggregateBucketsByDay, billingDayKey, billingDayStarts } from "./userTrafficHistory";
import { MIGRATION_TABLES } from "./dbSchema";
import { OPS_TABLE_DEFS } from "./ops/opsTables";

test("按计费时区切天：桶聚到天、天的起点连续", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const starts = billingDayStarts(3, now);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 23 * 3600 && starts[1] - starts[0] <= 25 * 3600);
  assert.equal(billingDayKey(starts[2]), billingDayKey(Math.floor(now.getTime() / 1000)));
  const rows = aggregateBucketsByDay([
    { userId: 2, ruleId: 7, bucketStart: starts[2], bytesIn: 100, bytesOut: 1000 },
    { userId: 2, ruleId: 7, bucketStart: starts[2] + 1800, bytesIn: 50, bytesOut: 500 },
    { userId: 2, ruleId: 8, bucketStart: starts[1] + 3600, bytesIn: 1, bytesOut: 2 },
    { userId: 0, ruleId: 8, bucketStart: starts[1], bytesIn: 9, bytesOut: 9 },
  ]);
  assert.deepEqual(rows.find((row) => row.ruleId === 7), { userId: 2, ruleId: 7, dayStart: starts[2], bytesIn: 150, bytesOut: 1500 });
  assert.equal(rows.find((row) => row.ruleId === 8)?.dayStart, starts[1]);
  assert.equal(rows.length, 2, "没有用户的桶不算");
  assert.ok(OPS_TABLE_DEFS.some((table) => table.name === "user_traffic_daily"));
  assert.ok((MIGRATION_TABLES as readonly string[]).includes("user_traffic_daily"));
});

test("用户流量历史：从流量桶汇总（子规则记到模板上）、重算幂等、Top 规则、只给管理员", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-user-traffic-"));
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
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
      await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'alice', 'hash', 'user')");
      await exec('INSERT INTO hosts (id, name, ip, "hostType", "agentToken", "userId") VALUES (1, ?, ?, ?, ?, 1)', ["h", "8.8.8.8", "slave", "tok1"]);
      const rule = (id, name, extra = {}) => exec(
        'INSERT INTO forward_rules (id, "hostId", "userId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "forwardGroupId", "forwardGroupRuleId", "isForwardGroupTemplate") VALUES (?, 1, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, name, "gost", "tcp", 10000 + id, "example.com", 443, extra.groupId ?? null, extra.parent ?? null, extra.template ? 1 : 0],
      );
      await rule(10, "游戏");
      await rule(11, "网站模板", { groupId: 5, template: true });
      await rule(12, "网站成员", { groupId: 5, parent: 11 });
      const history = await import(url("server/userTrafficHistory.ts"));
      const [d0, d1, d2] = history.billingDayStarts(3);
      const bucket = (start, ruleId, bytesIn, bytesOut) => exec(
        'INSERT INTO traffic_stat_buckets ("bucketStart", "bucketMinutes", "userId", "ruleId", "hostId", "bytesIn", "bytesOut", connections) VALUES (?, 30, 2, ?, 1, ?, ?, 0)',
        [start, ruleId, bytesIn, bytesOut],
      );
      await bucket(d0 + 1800, 10, 100, 1000);
      await bucket(d1 + 3600, 12, 5000, 50000);
      await bucket(d2, 10, 1, 2);
      await bucket(d2 + 1800, 404, 7, 7);

      assert.ok(await history.rollupUserTrafficDaily() >= 3);
      assert.ok(await history.rollupUserTrafficDaily() >= 3, "再算一遍");
      const rows = await runtime.queryRaw('SELECT * FROM user_traffic_daily WHERE "userId" = 2');
      assert.equal(rows.length, 4, "重算不会重复计数");
      assert.ok(rows.some((row) => Number(row.ruleId) === 11), "成员子规则记到模板规则上");

      const { userTrafficHistoryRouter } = await import(url("server/routers/userTrafficHistory.ts"));
      const ctx = (id, role) => ({ user: { id, role, username: role }, req: { headers: {} }, res: { setHeader: () => {} } });
      const view = await userTrafficHistoryRouter.createCaller(ctx(1, "admin")).daily({ userId: 2, days: 30 });
      assert.equal(view.days.length, 30);
      assert.equal(view.totals.bytesIn, 5108);
      assert.equal(view.totals.bytesOut, 51009);
      assert.equal(view.topRules[0].name, "网站模板");
      assert.ok(view.topRules.some((r) => r.deleted && r.name.includes("#404")));
      assert.ok(view.recordedSince);
      assert.equal(view.days[29].bytesIn, 8);
      await assert.rejects(() => userTrafficHistoryRouter.createCaller(ctx(2, "user")).daily({ userId: 2, days: 30 }));
      await assert.rejects(() => userTrafficHistoryRouter.createCaller(ctx(1, "admin")).daily({ userId: 99, days: 30 }), /不存在/);
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
