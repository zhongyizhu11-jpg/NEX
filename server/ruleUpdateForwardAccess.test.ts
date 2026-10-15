import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runScript(prefix: string, script: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    const scriptPath = path.join(directory, "probe.mjs");
    fs.writeFileSync(scriptPath, script, "utf8");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "t.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const prelude = String.raw`
  import assert from "node:assert/strict";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(moduleUrl("server/dbRuntime.ts"));
  const schema = await import(moduleUrl("server/dbSchema.ts"));
  const q = (name) => '"' + name + '"';
  const insert = (table, columns, values) => runtime.executeRaw(
    "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
    values,
  );
  const context = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
  await schema.ensureDatabaseSchema();
`;

/**
 * 被暂停 / 已到期的用户，不能靠「编辑」把规则重新启用：转发组模板那条路、直连改成转发组那条路，
 * 都要和开关（toggle）同一套检查。新建隧道同理。
 */
test("paused or expired users cannot re-enable rules through update, nor create tunnels", () => {
  runScript("forwardx-update-access-", prelude + String.raw`
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const { tunnelsRouter } = await import(moduleUrl("server/routers/tunnels.ts"));
    const state = async (id) => (await runtime.queryRaw('SELECT "isEnabled", "forwardGroupId" FROM "forward_rules" WHERE "id" = ?', [id]))[0];
    try {
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled"], [1, "admin", "x", "admin", 1, 1, 1]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled", "forwardAccessPauseReason"], [2, "member", "x", "user", 1, 1, 1, "manual"]);
      for (const id of [1, 2, 3]) {
        await insert("hosts", ["id", "name", "ip", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [id, "h" + id, "198.18.2." + id, 1, 1, now, 10000, 30000]);
      }
      await insert("user_host_permissions", ["userId", "hostId"], [2, 1]);
      await insert("user_host_permissions", ["userId", "hostId"], [2, 2]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled"], [20, "port-group", "host", "port", "", "A", "0.0.0.0", 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [220, 20, "host", 3, 0, 1]);
      await insert("user_forward_group_permissions", ["userId", "forwardGroupId"], [2, 20]);
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "disabledByUser"],
        [100, 3, "stopped-template", "iptables", "tcp", 20, 1, 12000, "203.0.113.10", 80, 2, 0, 0, 1],
      );
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "disabledByUser"],
        [101, 1, "stopped-direct", "iptables", "tcp", 12001, "203.0.113.11", 80, 2, 0, 0, 1],
      );

      const member = { id: 2, username: "member", role: "user", accountEnabled: true, allowedForwardTypes: null };
      const memberRules = rulesRouter.createCaller(context(member));
      await assert.rejects(() => memberRules.update({ id: 100, isEnabled: true }), /暂停/);
      assert.equal(Number((await state(100)).isEnabled), 0);
      await assert.rejects(() => memberRules.update({ id: 101, forwardGroupId: 20, isEnabled: true }), /暂停/);
      assert.equal(Number((await state(101)).isEnabled), 0);
      assert.equal((await state(101)).forwardGroupId, null);

      const memberTunnels = tunnelsRouter.createCaller(context(member));
      await assert.rejects(
        () => memberTunnels.create({ name: "new-tunnel", entryHostId: 1, exitHostId: 2, mode: "tls" }),
        /暂停/,
      );
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "tunnels"'))[0].count, 0);

      // 不启用的编辑照常可以做
      await memberRules.update({ id: 100, name: "renamed-while-paused" });
      assert.equal(Number((await state(100)).isEnabled), 0);

      // 恢复正常后，编辑时启用可以通过
      await runtime.executeRaw('UPDATE "users" SET "forwardAccessPauseReason" = NULL WHERE "id" = 2');
      await memberRules.update({ id: 100, isEnabled: true });
      assert.equal(Number((await state(100)).isEnabled), 1);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `);
});

/**
 * 隧道规则（gost + 隧道）配了线路组后，编辑保存不能把线路组弄丢。
 *
 * 2.3.439 之前：update 里 nextMainBackupEnabled 卡着 protocol === "tcp"，而规则表单默认 TCP+UDP，
 * 客户端每次保存都带上 failoverEnabled，于是编辑一条 TCP+UDP / UDP 的隧道线路组规则时，
 * 服务端把 failoverEnabled、routePaths 一起清空 —— 还不报错、照样「保存成功」。新建没这条卡，
 * 所以只有编辑会丢。这里建一条带线路组的 TCP+UDP 隧道规则，模拟客户端「只点了保存」
 * （带 failoverEnabled、不重报路径），断言线路组还在。
 */
test("editing a TCP+UDP tunnel rule keeps its route group", () => {
  runScript("forwardx-route-group-keep-", prelude + String.raw`
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const rowOf = async (id) => (await runtime.queryRaw('SELECT "failoverEnabled", "routeMode", "routePaths", "protocol", "name" FROM "forward_rules" WHERE "id" = ?', [id]))[0];
    try {
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled"], [1, "admin", "x", "admin", 1, 1, 1]);
      for (const id of [1, 2]) {
        await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [id, "h" + id, "198.18.4." + id, "198.18.4." + id, 1, 1, now, 10000, 30000]);
      }
      await insert("tunnels", ["id", "name", "mode", "entryHostId", "exitHostId", "listenPort", "userId", "isEnabled"], [30, "tls-tunnel", "tls", 1, 2, 25000, 1, 1]);
      const paths = JSON.stringify([
        { key: "a", name: "主线路", hops: [], dest: null, weight: 50 },
        { key: "b", name: "备用1", hops: [], dest: { ip: "203.0.113.9", port: 24895 }, weight: 50 },
      ]);
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "failoverEnabled", "routeMode", "routePaths"],
        [100, 1, "tunnel-route-group", "gost", "both", 30, 11000, "203.0.113.10", 24895, 1, 1, 0, 1, "failover", paths],
      );

      const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true, allowedForwardTypes: null };
      const adminRules = rulesRouter.createCaller(context(admin));
      // 客户端保存时带 failoverEnabled（不重报 routeGroup），只改了个名字
      await adminRules.update({ id: 100, name: "renamed", failoverEnabled: true });

      const row = await rowOf(100);
      assert.equal(row.name, "renamed");
      assert.equal(Number(row.failoverEnabled), 1, "route group must survive the edit");
      assert.equal(String(row.routeMode), "failover");
      const savedPaths = JSON.parse(row.routePaths || "[]");
      assert.equal(savedPaths.length, 2, "both paths must survive: " + row.routePaths);
      assert.equal(savedPaths[1].dest && savedPaths[1].dest.port, 24895);

      // 明确关掉线路组仍然可以
      await adminRules.update({ id: 100, failoverEnabled: false });
      assert.equal(Number((await rowOf(100)).failoverEnabled), 0);

      // 内核转发（iptables）老行里残留的 failoverEnabled：编辑保存应当把它关掉，而不是报错
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "failoverEnabled", "routeMode", "routePaths"],
        [101, 1, "legacy-iptables", "iptables", "both", 11001, "203.0.113.11", 80, 1, 1, 0, 1, "failover", paths],
      );
      await adminRules.update({ id: 101, name: "legacy-renamed", failoverEnabled: true });
      const legacy = await rowOf(101);
      assert.equal(legacy.name, "legacy-renamed");
      assert.equal(Number(legacy.failoverEnabled), 0, "unsupported kernel forward must have its stale route group cleared, not error");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `);
});

/**
 * 线路组的中继规则算进端口配额，而且普通用户的中继端口只在他那台中转机的套餐端口区间里挑。
 */
test("route relay listeners count toward maxPorts and stay inside the owner's plan port range", () => {
  runScript("forwardx-route-relay-quota-", prelude + String.raw`
    const permissions = await import(moduleUrl("server/repositories/permissionRepository.ts"));
    const routeGroups = await import(moduleUrl("server/routeGroups.ts"));
    const { assertRouteRelayPortQuota } = await import(moduleUrl("server/routers/rules.crud.ts"));
    try {
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled", "maxPorts"], [1, "admin", "x", "admin", 1, 1, 1, 0]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled", "maxPorts"], [2, "member", "x", "user", 1, 1, 1, 3]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [1, "entry", "198.18.3.1", "198.18.3.1", 1, 1, now, 10000, 30000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [2, "hop", "198.18.3.2", "198.18.3.2", 1, 1, now, 10000, 30000]);
      await insert("subscription_plans", ["id", "name"], [50, "hop-plan"]);
      await insert("subscription_plan_hosts", ["planId", "hostId"], [50, 2]);
      await insert("user_subscriptions", ["id", "userId", "planId", "status", "portRangeStart", "portRangeEnd"], [60, 2, 50, "active", 21000, 21010]);
      const paths = JSON.stringify([
        { key: "aa", name: "", hops: [], dest: null, weight: 50 },
        { key: "bb", name: "", hops: [2], dest: { ip: "203.0.113.20", port: 80 }, weight: 50 },
      ]);
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "failoverEnabled", "routeMode", "routePaths"],
        [100, 1, "route-group", "gost", "tcp", 11000, "203.0.113.10", 80, 2, 1, 0, 1, "failover", paths],
      );
      assert.equal(await permissions.getUserPortCount(2), 1);
      const synced = await routeGroups.syncRouteRelayRulesForRule(100, { deferRefresh: true });
      assert.equal(synced.created, 1);
      const relays = await runtime.queryRaw('SELECT "hostId", "sourcePort" FROM "forward_rules" WHERE "routeParentRuleId" = 100');
      assert.equal(relays.length, 1);
      assert.equal(Number(relays[0].hostId), 2);
      const relayPort = Number(relays[0].sourcePort);
      assert.ok(relayPort >= 21000 && relayPort <= 21010, "relay port " + relayPort + " must stay in the plan range");
      assert.equal(await permissions.getUserPortCount(2), 2, "the relay listener counts as a port");

      const member = { id: 2, role: "user" };
      // 已经有的中继不重复计；再加两跳就超出 maxPorts=3
      await assertRouteRelayPortQuota(member, paths, 100);
      const morePaths = JSON.stringify([
        { key: "aa", hops: [], dest: null, weight: 50 },
        { key: "bb", hops: [2], dest: { ip: "203.0.113.20", port: 80 }, weight: 50 },
        { key: "cc", hops: [2, 1], dest: { ip: "203.0.113.21", port: 80 }, weight: 50 },
      ]);
      await assert.rejects(() => assertRouteRelayPortQuota(member, morePaths, 100), /端口配额/);
      await assert.rejects(() => assertRouteRelayPortQuota(member, paths, null), /端口配额/, "a new rule needs its own port plus the relay");
      await assertRouteRelayPortQuota({ id: 1, role: "admin" }, morePaths, 100);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `);
});
