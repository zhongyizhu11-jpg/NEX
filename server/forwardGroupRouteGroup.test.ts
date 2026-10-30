import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 转发组的子规则跟着模板开线路组：以前子规则只在 TCP + gost 时才开（和规则本身的限制一致），
 * 规则那边放开到 UDP、TCP+UDP 和 realm / socat / nginx 之后，这里得跟着放开 —— 不然模板存得下、
 * 子规则却悄悄不切换。内核转发（iptables / nftables）照旧不开：调度器插不进去。
 */
test("转发组子规则：UDP、TCP+UDP、realm / socat 跟着模板开线路组，内核转发不开", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-route-"));
  const databasePath = path.join(directory, "group-route.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role"], [1, "admin", "hash", "admin"]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [1, "host-1", "198.51.100.10", "198.51.100.10", 1, 1, now]);
      await insert("forward_groups", [
        "id", "name", "groupType", "groupMode", "forwardType", "failoverRuntimeInheritanceEnabled", "targetIp", "userId", "isEnabled",
      ], [10, "group", "host", "failover", "gost", 0, "0.0.0.0", 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      const backup = JSON.stringify([{ targetIp: "198.51.100.9", targetPort: 80 }]);
      const templates = [
        [100, "realm", "udp", 16000],
        [110, "iptables", "tcp", 16010],
        [120, "socat", "both", 16020],
        [130, "gost", "tcp", 16030],
      ];
      for (const [id, forwardType, protocol, sourcePort] of templates) {
        await insert("forward_rules", [
          "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
          "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "failoverEnabled", "failoverTargets",
        ], [id, 1, "template-" + id, forwardType, protocol, 10, 1, sourcePort, "203.0.113.10", 80, 1, 1, 0, 1, backup]);
      }

      const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      await forwardGroups.syncForwardGroupRules(10);
      const children = await runtime.queryRaw(
        'SELECT "forwardGroupRuleId", "forwardType", "protocol", "failoverEnabled", "failoverTargets" FROM "forward_rules"'
          + ' WHERE "forwardGroupId" = ? AND "isForwardGroupTemplate" = 0 ORDER BY "forwardGroupRuleId"',
        [10],
      );
      const byTemplate = Object.fromEntries(children.map((row) => [Number(row.forwardGroupRuleId), row]));
      for (const id of [100, 120, 130]) {
        assert.ok(byTemplate[id], "模板 " + id + " 没有生成子规则");
        assert.equal(Number(byTemplate[id].failoverEnabled), 1, "模板 " + id + "（" + byTemplate[id].forwardType + " " + byTemplate[id].protocol + "）的子规则应当开着线路组");
        assert.equal(byTemplate[id].failoverTargets, backup);
      }
      assert.ok(byTemplate[110], "iptables 模板没有生成子规则");
      assert.equal(Number(byTemplate[110].failoverEnabled), 0, "内核转发的子规则开不了线路组");
      assert.equal(byTemplate[110].failoverTargets, null);
      console.log("GROUP-ROUTE-OK");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
    encoding: "utf8",
    timeout: 120_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /GROUP-ROUTE-OK/);
});

/**
 * 端口转发（转发组模板）开线路组、路径带中转：模板不跑，子规则照抄路径并各自在中转机上建中继；
 * 模板自己一条中继都不建。去掉中转后子规则的路径和中继一起收掉。
 */
test("端口转发模板的线路组带中转：子规则照抄路径、中转机上建中继、模板不建", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-route-hops-"));
  const databasePath = path.join(directory, "group-route-hops.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role"], [1, "admin", "hash", "admin"]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [1, "entry-1", "198.51.100.10", "198.51.100.10", 1, 1, now]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [2, "relay-a", "198.51.100.20", "198.51.100.20", 1, 1, now]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [3, "relay-b", "198.51.100.30", "198.51.100.30", 1, 1, now]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled"], [10, "Df", "host", "port", "gost", "0.0.0.0", 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      const paths = JSON.stringify([
        { key: "a", name: "主线路", hops: [2], dest: null, weight: 1, probe: null, dial: null },
        { key: "b", name: "备用 1", hops: [3], dest: null, weight: 1, probe: null, dial: null },
      ]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "failoverEnabled", "routeMode", "routePaths",
      ], [200, 1, "tpl", "gost", "tcp", 10, 1, 17000, "203.0.113.10", 45855, 1, 1, 0, 1, "failover", paths]);

      const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const routeGroups = await import(moduleUrl("server/routeGroups.ts"));
      await forwardGroups.syncForwardGroupRules(10);
      // 模板保存后也会走一遍中继同步：模板自己不该建
      await routeGroups.syncRouteRelayRulesForRule(200, { reason: "test" });

      const child = (await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "forwardGroupRuleId" = ? AND "isForwardGroupTemplate" = 0', [200]))[0];
      assert.ok(child, "没有生成子规则");
      assert.equal(child.routeMode, "failover");
      const childPaths = JSON.parse(child.routePaths);
      assert.deepEqual(childPaths.map((item) => item.hops), [[2], [3]], "子规则应当照抄模板的路径");
      const relays = await runtime.queryRaw('SELECT "hostId", "routeParentRuleId", "routePathKey", "targetIp", "targetPort" FROM "forward_rules" WHERE "routeParentRuleId" IS NOT NULL AND "routeParentRuleId" > 0 AND "pendingDelete" = 0 ORDER BY "hostId"');
      assert.deepEqual(relays.map((row) => [Number(row.hostId), Number(row.routeParentRuleId), row.routePathKey]), [[2, Number(child.id), "a"], [3, Number(child.id), "b"]], "中继应当挂在子规则上，模板一条都没有");
      assert.ok(relays.every((row) => row.targetIp === "203.0.113.10" && Number(row.targetPort) === 45855), "中继转到落地");
      const resolved = JSON.parse((await runtime.queryRaw('SELECT "routePaths" FROM "forward_rules" WHERE "id" = ?', [child.id]))[0].routePaths);
      assert.ok(resolved[0].dial && resolved[0].dial.ip === "198.51.100.20", "子规则的主线路应当拨中转 relay-a：" + JSON.stringify(resolved[0]));

      // 再同步一次：路径没变，dial 保留，不重建中继
      await forwardGroups.syncForwardGroupRules(10);
      const again = JSON.parse((await runtime.queryRaw('SELECT "routePaths" FROM "forward_rules" WHERE "id" = ?', [child.id]))[0].routePaths);
      assert.deepEqual(again[0].dial, resolved[0].dial, "组同步不该冲掉子规则解析出来的 dial");

      // 线路（2.3.496）和切换方式跟着模板：模板改成热备、带上线路定义，组同步带到子规则
      const lines = JSON.stringify([{ key: "a", name: "主线路", layers: [{ kind: "hosts", hostIds: [2] }] }, { key: "b", name: "备用 1", layers: [{ kind: "hosts", hostIds: [3] }] }]);
      await runtime.executeRaw('UPDATE "forward_rules" SET "routeDelivery" = ?, "routeLines" = ? WHERE "id" = ?', ["hot", lines, 200]);
      await forwardGroups.syncForwardGroupRules(10);
      const inherited = (await runtime.queryRaw('SELECT "routeDelivery", "routeLines", "routePaths" FROM "forward_rules" WHERE "id" = ?', [child.id]))[0];
      assert.equal(inherited.routeDelivery, "hot", "子规则应当跟着模板换成热备");
      assert.equal(inherited.routeLines, lines, "子规则应当带着模板的线路定义");
      assert.deepEqual(JSON.parse(inherited.routePaths)[0].dial, resolved[0].dial, "只换切换方式不该冲掉 dial");

      // 模板去掉中转：子规则的路径清掉，中继收掉
      await runtime.executeRaw('UPDATE "forward_rules" SET "routePaths" = NULL, "routeMode" = NULL WHERE "id" = ?', [200]);
      await forwardGroups.syncForwardGroupRules(10);
      const cleared = (await runtime.queryRaw('SELECT "routePaths", "routeLines", "routeDelivery" FROM "forward_rules" WHERE "id" = ?', [child.id]))[0];
      assert.equal(cleared.routePaths, null);
      assert.equal(cleared.routeLines, null, "去掉中转后子规则的线路定义一起清掉");
      assert.equal(cleared.routeDelivery, "cold");
      const live = await runtime.queryRaw('SELECT "id" FROM "forward_rules" WHERE "routeParentRuleId" = ? AND "pendingDelete" = 0', [child.id]);
      assert.equal(live.length, 0, "去掉中转后中继应当收掉");
      console.log("GROUP-ROUTE-HOPS-OK");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
    encoding: "utf8",
    timeout: 120_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /GROUP-ROUTE-HOPS-OK/);
});
