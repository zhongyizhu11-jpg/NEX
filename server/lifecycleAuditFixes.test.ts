import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 规则 / 隧道 / 转发组生命周期的几处回归用例。每个用例在独立进程里起一个 SQLite 库，
 * 和 forwardGroupDeleteReferences.test.ts 的写法一样。
 */
function runScenario(name: string, body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `forwardx-lifecycle-${name}-`));
  const script = String.raw`
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
    const one = async (sqlText, params = []) => (await runtime.queryRaw(sqlText, params))[0];
    const context = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
    const ruleCols = ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "pendingDelete", "isForwardGroupTemplate"];
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
      ${body}
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "lifecycle.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("tunnel update does not wait on a rule exit-mapping lock while its SQLite transaction is open", () => {
  runScenario("tunnel-lock", String.raw`
    const { tunnelsRouter } = await import(moduleUrl("server/routers/tunnels.ts"));
    const { withKeyedTaskLock } = await import(moduleUrl("server/keyedTaskLock.ts"));
    const hostCols = ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"];
    await insert("hosts", hostCols, [1, "entry", "198.51.100.1", "slave", 1, 10000, 10099, 1]);
    await insert("hosts", hostCols, [2, "exit", "198.51.100.2", "slave", 1, 20000, 20099, 1]);
    await insert("hosts", hostCols, [3, "extra-exit", "198.51.100.3", "slave", 1, 30000, 30099, 1]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "loadBalanceEnabled", "loadBalanceStrategy", "userId", "isEnabled"],
      [10, "lb", 1, 2, "tls", 20000, 1, "round_robin", 1, 1]);
    await insert("tunnel_exit_nodes", ["id", "tunnelId", "seq", "hostId", "listenPort", "isEnabled"], [100, 10, 1, 3, 30000, 1]);
    await insert("forward_rules", ruleCols, [20, 1, "r", "gost", "tcp", 10, 20000, 10001, "203.0.113.1", 443, 1, 1, 1, 0, 0]);

    // 模拟心跳：先拿到这条规则的出口映射键锁，稍后再去查库。
    const holder = withKeyedTaskLock("rule-tunnel-exits:20", async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await runtime.queryRaw("SELECT 1");
    });
    const update = tunnelsRouter.createCaller(context(admin)).update({
      id: 10,
      name: "lb-renamed",
      loadBalanceEnabled: true,
      loadBalanceExits: [{ hostId: 3 }],
    });
    const deadlock = setTimeout(() => {
      console.error("tunnel update deadlocked with the heartbeat exit-mapping lock");
      process.exit(3);
    }, 15_000);
    await Promise.all([holder, update]);
    clearTimeout(deadlock);
    const row = await one('SELECT "name" FROM "tunnels" WHERE "id" = 10');
    assert.equal(row.name, "lb-renamed");
    const mapping = await one('SELECT "tunnelExitPort" FROM "forward_rule_tunnel_exits" WHERE "ruleId" = 20');
    assert.ok(mapping && Number(mapping.tunnelExitPort) >= 30000 && Number(mapping.tunnelExitPort) <= 30099,
      "exit mapping must still be reconciled after commit: " + JSON.stringify(mapping));
  `);
});

test("entry-group members count tunnel rules as occupying their source port", () => {
  runScenario("entry-group-ports", String.raw`
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const groups = await import(moduleUrl("server/db.ts"));
    const { tunnelsRouter } = await import(moduleUrl("server/routers/tunnels.ts"));
    const hostCols = ["id", "name", "ip", "hostType", "userId", "isOnline"];
    await insert("hosts", hostCols, [1, "entry-a", "198.51.100.1", "slave", 1, 1]);
    await insert("hosts", hostCols, [2, "entry-b", "198.51.100.2", "slave", 1, 1]);
    await insert("hosts", hostCols, [3, "exit", "198.51.100.3", "slave", 1, 1]);
    await insert("hosts", hostCols, [4, "entry-c", "198.51.100.4", "slave", 1, 1]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"],
      [20, "entry", "host", "entry", "entry.example.test", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [201, 20, "host", 1, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [202, 20, "host", 2, 1, 1]);
    await insert("tunnels", ["id", "name", "entryGroupId", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
      [10, "grouped", 20, 1, 3, "tls", 25000, 1, 1]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
      [11, "plain", 1, 3, "tls", 25001, 1, 1]);
    await insert("forward_rules", ruleCols, [30, 1, "tunnel-rule", "gost", "tcp", 10, 25000, 15000, "203.0.113.1", 443, 1, 1, 1, 0, 0]);

    assert.equal(await tunnelRepo.isPortUsedOnHost(2, 15000, undefined, "tcp"), true, "entry-group member listens on the tunnel rule port");
    assert.equal(await tunnelRepo.isPortUsedOnHost(2, 15001, undefined, "tcp"), false);
    assert.equal((await tunnelRepo.getUsedPortsOnHost(2, undefined, "tcp")).has(15000), true);
    assert.equal(await tunnelRepo.isPortUsedOnHost(1, 15000, 30, "tcp"), false, "the rule itself is excluded");

    // 新加入入口组的主机上已经有同端口的直连规则：拒绝，成员不变。
    await insert("forward_rules", ruleCols, [31, 4, "direct-on-c", "iptables", "tcp", null, null, 15000, "203.0.113.2", 80, 1, 1, 1, 0, 0]);
    await assert.rejects(() => groups.replaceForwardGroupMembers(20, [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: true },
      { memberType: "host", hostId: 4, priority: 2, isEnabled: true },
    ], { skipSync: true }), /端口 15000 已被占用/);
    const members = await runtime.queryRaw('SELECT "hostId" FROM "forward_group_members" WHERE "groupId" = 20 ORDER BY "hostId"');
    assert.deepEqual(members.map((row) => Number(row.hostId)), [1, 2]);

    // 把隧道挂到入口组时，组里主机上的端口同样要先查。
    await insert("forward_rules", ruleCols, [32, 1, "plain-rule", "gost", "tcp", 11, 25001, 16000, "203.0.113.3", 443, 1, 1, 1, 0, 0]);
    await insert("forward_rules", ruleCols, [33, 2, "direct-on-b", "iptables", "tcp", null, null, 16000, "203.0.113.4", 80, 1, 1, 1, 0, 0]);
    await assert.rejects(
      () => tunnelsRouter.createCaller(context(admin)).update({ id: 11, entryGroupId: 20 }),
      /端口 16000 已被占用/,
    );
    assert.equal((await one('SELECT "entryGroupId" FROM "tunnels" WHERE "id" = 11')).entryGroupId, null);
  `);
});

test("a host still referenced by tunnels, groups or plans cannot be deleted", () => {
  runScenario("host-delete", String.raw`
    const { hostsRouter } = await import(moduleUrl("server/routers/hosts.ts"));
    const caller = hostsRouter.createCaller(context(admin));
    const hostCols = ["id", "name", "ip", "hostType", "userId"];
    for (const id of [1, 2, 3, 4, 5]) await insert("hosts", hostCols, [id, "h" + id, "198.51.100." + id, "slave", 1]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [10, "t", 1, 2, "tls", 25000, 1, 1]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled"], [20, "g", "host", "failover", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [201, 20, "host", 3, 0, 1]);
    await insert("subscription_plans", ["id", "name"], [40, "plan"]);
    await insert("subscription_plan_hosts", ["id", "planId", "hostId"], [401, 40, 4]);

    await assert.rejects(() => caller.delete({ id: 1 }), /隧道入口 「t」/);
    await assert.rejects(() => caller.delete({ id: 2 }), /隧道出口 「t」/);
    await assert.rejects(() => caller.delete({ id: 3 }), /转发组成员 「g」/);
    await assert.rejects(() => caller.delete({ id: 4 }), /套餐 「plan」/);
    const remaining = await runtime.queryRaw('SELECT "id" FROM "hosts" ORDER BY "id"');
    assert.deepEqual(remaining.map((row) => Number(row.id)), [1, 2, 3, 4, 5]);
    await caller.delete({ id: 5 });
    assert.equal(await one('SELECT "id" FROM "hosts" WHERE "id" = 5'), undefined, "an unreferenced host is deleted");
  `);
});

test("deleting a user retires their rules and refuses while they own infrastructure", () => {
  runScenario("user-delete", String.raw`
    const { usersRouter } = await import(moduleUrl("server/routers/users.ts"));
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const caller = usersRouter.createCaller(context(admin));
    await insert("users", ["id", "username", "password", "role", "canAddRules"], [2, "owner", "x", "user", 1]);
    await insert("users", ["id", "username", "password", "role", "canAddRules"], [3, "tenant", "x", "user", 1]);
    await insert("hosts", ["id", "name", "ip", "hostType", "userId"], [1, "h1", "198.51.100.1", "slave", 1]);
    await insert("hosts", ["id", "name", "ip", "hostType", "userId"], [2, "h2", "198.51.100.2", "slave", 1]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [10, "owned", 1, 2, "tls", 25000, 2, 1]);
    await insert("forward_rules", ruleCols, [30, 1, "tenant-rule", "iptables", "tcp", null, null, 15000, "203.0.113.1", 80, 3, 1, 1, 0, 0]);

    await assert.rejects(() => caller.delete({ userId: 2 }), /1 条隧道/);
    assert.ok(await one('SELECT "id" FROM "users" WHERE "id" = 2'), "owner is kept");

    await caller.delete({ userId: 3 });
    assert.equal(await one('SELECT "id" FROM "users" WHERE "id" = 3'), undefined);
    const rule = await one('SELECT "isEnabled", "pendingDelete" FROM "forward_rules" WHERE "id" = 30');
    assert.equal(Number(rule.pendingDelete), 1, "the deleted user's rule goes through the normal delete path");
    assert.equal(Number(rule.isEnabled), 0);

    assert.equal(await tunnelRepo.forwardRuleOwnerAllowsRuntime(3), false, "a rule whose owner row is gone must not run");
    assert.equal(await tunnelRepo.forwardRuleOwnerAllowsRuntime(0), true, "system rules without an owner are unaffected");
  `);
});

test("re-enabling or restoring a tunnel rule re-reserves its exit port and pending deletes stay deleted", () => {
  runScenario("exit-port", String.raw`
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    // 先引 rules 路由再引 rules.crud：两者互相引用，反过来会撞上初始化顺序。
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const crud = await import(moduleUrl("server/routers/rules.crud.ts"));
    const hostCols = ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"];
    await insert("hosts", hostCols, [1, "entry", "198.51.100.1", "slave", 1, 10000, 10099, 1]);
    await insert("hosts", hostCols, [2, "exit", "198.51.100.2", "slave", 1, 22600, 22699, 1]);
    const tunnelCols = ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"];
    await insert("tunnels", tunnelCols, [10, "t10", 1, 2, "tls", 22600, 1, 1]);
    await insert("forward_rules", ruleCols, [20, 1, "primary", "gost", "tcp", 10, 22600, 10001, "203.0.113.1", 443, 1, 1, 1, 0, 0]);
    await insert("forward_rules", ruleCols, [21, 1, "was-off", "gost", "tcp", 10, 22601, 10002, "203.0.113.2", 443, 1, 0, 0, 0, 0]);
    await insert("forward_rules", ruleCols, [22, 1, "took-port", "gost", "tcp", 10, 22601, 10003, "203.0.113.3", 443, 1, 1, 1, 0, 0]);

    await crud.toggleForwardRuleForActor(admin, 21, true);
    const toggled = await one('SELECT "isEnabled", "tunnelExitPort" FROM "forward_rules" WHERE "id" = 21');
    assert.equal(Number(toggled.isEnabled), 1);
    assert.ok(![22600, 22601].includes(Number(toggled.tunnelExitPort)), "re-enabled rule must not keep a taken exit port: " + toggled.tunnelExitPort);
    assert.ok(Number(toggled.tunnelExitPort) >= 22600 && Number(toggled.tunnelExitPort) <= 22699);

    // 隧道重新启用时恢复的规则同理。
    await insert("tunnels", tunnelCols, [11, "t11", 1, 2, "tls", 22610, 1, 1]);
    await insert("forward_rules", [...ruleCols, "disabledByTunnel"], [23, 1, "restored", "gost", "tcp", 11, 22620, 10004, "203.0.113.4", 443, 1, 0, 0, 0, 0, 1]);
    await insert("forward_rules", ruleCols, [24, 1, "holder", "gost", "tcp", 10, 22620, 10005, "203.0.113.5", 443, 1, 1, 1, 0, 0]);
    await insert("forward_rules", ruleCols, [25, 1, "t11-primary", "gost", "tcp", 11, 22610, 10006, "203.0.113.6", 443, 1, 1, 1, 0, 0]);
    await tunnelRepo.restoreForwardRulesByTunnel(11);
    const restored = await one('SELECT "isEnabled", "tunnelExitPort" FROM "forward_rules" WHERE "id" = 23');
    assert.equal(Number(restored.isEnabled), 1);
    assert.notEqual(Number(restored.tunnelExitPort), 22620, "restored rule must not reuse a port taken while it was stopped");

    // 待删除的规则不能再被打开或修改。
    await insert("forward_rules", ruleCols, [26, 1, "deleting", "iptables", "tcp", null, null, 10007, "203.0.113.7", 80, 1, 0, 1, 1, 0]);
    await assert.rejects(() => crud.toggleForwardRuleForActor(admin, 26, true), /规则不存在/);
    await assert.rejects(() => rulesRouter.createCaller(context(admin)).update({ id: 26, isEnabled: true }), /规则不存在/);
    const pending = await one('SELECT "isEnabled", "pendingDelete" FROM "forward_rules" WHERE "id" = 26');
    assert.deepEqual([Number(pending.isEnabled), Number(pending.pendingDelete)], [0, 1]);
  `);
});

test("forward-group member ports are validated before writing and a conflict does not abort the whole sync", () => {
  runScenario("group-members", String.raw`
    const groups = await import(moduleUrl("server/db.ts"));
    const hostCols = ["id", "name", "ip", "ipv4", "hostType", "userId", "isOnline"];
    for (const id of [1, 2, 3]) await insert("hosts", hostCols, [id, "h" + id, "198.51.100." + id, "198.51.100." + id, "slave", 1, 1]);
    const groupCols = ["id", "name", "groupType", "groupMode", "forwardType", "domain", "recordType", "targetIp", "userId", "isEnabled"];
    await insert("forward_groups", groupCols, [10, "failover", "host", "failover", "realm", "fo.example.test", "A", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
    await insert("forward_rules", [...ruleCols, "forwardGroupId"], [100, 1, "template", "realm", "tcp", null, null, 16000, "203.0.113.10", 80, 1, 1, 0, 0, 1, 10]);
    await insert("forward_rules", ruleCols, [200, 2, "direct", "iptables", "tcp", null, null, 16000, "203.0.113.20", 80, 1, 1, 1, 0, 0]);

    await assert.rejects(() => groups.replaceForwardGroupMembers(10, [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: true },
    ], { skipSync: true }), /端口 16000 已被占用/);
    const members = await runtime.queryRaw('SELECT "hostId" FROM "forward_group_members" WHERE "groupId" = 10 ORDER BY "hostId"');
    assert.deepEqual(members.map((row) => Number(row.hostId)), [1], "members are untouched after a rejected change");

    // 历史数据里已经有冲突的成员：同步跳过它，其他成员照常同步，不再整组抛错。
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [103, 10, "host", 3, 2, 1]);
    await groups.syncForwardGroupRules(10);
    const children = await runtime.queryRaw('SELECT "forwardGroupMemberId", "isEnabled" FROM "forward_rules" WHERE "forwardGroupRuleId" = 100 ORDER BY "forwardGroupMemberId"');
    assert.deepEqual(children.map((row) => [Number(row.forwardGroupMemberId), Number(row.isEnabled)]), [[101, 1], [103, 1]]);

    // 删除转发组时模板直接收掉（模板从不在 Agent 上运行，等不到停止确认）。
    await groups.deleteForwardGroup(10);
    assert.equal(await one('SELECT "id" FROM "forward_rules" WHERE "id" = 100'), undefined);

    // 入口/出口组里残留的模板也一样。
    await insert("forward_groups", groupCols, [11, "entry", "host", "entry", "iptables", "entry.example.test", "A", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [111, 11, "host", 1, 0, 1]);
    await insert("forward_rules", [...ruleCols, "forwardGroupId"], [110, 1, "stale-template", "iptables", "tcp", null, null, 17000, "203.0.113.11", 80, 1, 1, 0, 0, 1, 11]);
    await groups.syncForwardGroupRules(11);
    assert.equal(await one('SELECT "id" FROM "forward_rules" WHERE "id" = 110'), undefined);
  `);
});

test("monthly traffic reset days past the end of a short month reset on its last day", () => {
  runScenario("reset-day", String.raw`
    const users = await import(moduleUrl("server/repositories/userRepository.ts"));
    for (const [id, day] of [[11, 31], [12, 30], [13, 29], [14, 15], [15, 28]]) {
      await insert("users", ["id", "username", "password", "role", "trafficAutoReset", "trafficResetDay"], [id, "u" + id, "x", "user", 1, day]);
    }
    const due = async (iso) => (await users.getUsersForAutoReset(new Date(iso))).map((row) => Number(row.id)).sort((a, b) => a - b);
    // 北京时间 2026-02-27 / 2026-02-28 中午。
    assert.deepEqual(await due("2026-02-27T04:00:00.000Z"), [14]);
    assert.deepEqual(await due("2026-02-28T04:00:00.000Z"), [11, 12, 13, 14, 15]);
    // 小月：4 月 29 日只到 29 号，4 月 30 日（月末）把 31 号也带上。
    assert.deepEqual(await due("2026-04-29T04:00:00.000Z"), [13, 14, 15]);
    assert.deepEqual(await due("2026-04-30T04:00:00.000Z"), [11, 12, 13, 14, 15]);
    // 重置过的这个月不再重复。
    await runtime.executeRaw('UPDATE "users" SET "lastAutoTrafficReset" = ? WHERE "id" = 11', [Math.floor(Date.parse("2026-02-28T01:00:00.000Z") / 1000)]);
    assert.deepEqual(await due("2026-02-28T04:00:00.000Z"), [12, 13, 14, 15]);
  `);
});

test("restoring a tunnel on an entry group checks the rule port on every enabled group host", () => {
  runScenario("entry-group-restore", String.raw`
    const groups = await import(moduleUrl("server/db.ts"));
    const hostCols = ["id", "name", "ip", "hostType", "userId", "isOnline"];
    await insert("hosts", hostCols, [1, "entry-a", "198.51.100.1", "slave", 1, 1]);
    await insert("hosts", hostCols, [2, "entry-b", "198.51.100.2", "slave", 1, 1]);
    await insert("hosts", hostCols, [3, "exit", "198.51.100.3", "slave", 1, 1]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"],
      [20, "entry", "host", "entry", "entry.example.test", "0.0.0.0", 1, 0]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [201, 20, "host", 1, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [202, 20, "host", 2, 1, 1]);
    await insert("tunnels", ["id", "name", "entryGroupId", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled", "disabledByGroup"],
      [10, "grouped", 20, 1, 3, "tls", 25000, 1, 0, 1]);
    const stopped = [...ruleCols, "disabledByTunnel"];
    await insert("forward_rules", stopped, [30, 1, "clash", "gost", "tcp", 10, 25000, 15000, "203.0.113.1", 443, 1, 0, 0, 0, 0, 1]);
    await insert("forward_rules", stopped, [31, 1, "free", "gost", "tcp", 10, 25001, 15001, "203.0.113.2", 443, 1, 0, 0, 0, 0, 1]);
    // 入口组停用期间，组里的 entry-b 上有人建了同端口的直连规则（那时组没启用，不算冲突）。
    await insert("forward_rules", ruleCols, [40, 2, "direct-on-b", "iptables", "tcp", null, null, 15000, "203.0.113.9", 80, 1, 1, 1, 0, 0]);

    await groups.setForwardGroupEnabled(20, true);
    assert.equal(Number((await one('SELECT "isEnabled" FROM "tunnels" WHERE "id" = 10')).isEnabled), 1);
    const clash = await one('SELECT "isEnabled", "protocolBlockReason" FROM "forward_rules" WHERE "id" = 30');
    assert.equal(Number(clash.isEnabled), 0, "a rule whose port is taken on an entry-group host must not be restored");
    assert.match(String(clash.protocolBlockReason || ""), /端口 15000/);
    const free = await one('SELECT "isEnabled", "protocolBlockReason" FROM "forward_rules" WHERE "id" = 31');
    assert.equal(Number(free.isEnabled), 1);
    assert.equal(free.protocolBlockReason, null);
    assert.equal(Number((await one('SELECT "isEnabled" FROM "forward_rules" WHERE "id" = 40')).isEnabled), 1, "the direct rule keeps running");
  `);
});

test("rules on an entry-group tunnel check and pick ports on every group host", () => {
  runScenario("entry-group-rule-ports", String.raw`
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const crud = await import(moduleUrl("server/routers/rules.crud.ts"));
    const caller = rulesRouter.createCaller(context(admin));
    const hostCols = ["id", "name", "ip", "hostType", "userId", "isOnline", "portRangeStart", "portRangeEnd"];
    await insert("hosts", hostCols, [1, "entry-a", "198.51.100.1", "slave", 1, 1, 16000, 16001]);
    await insert("hosts", hostCols, [2, "entry-b", "198.51.100.2", "slave", 1, 1, 16000, 16001]);
    await insert("hosts", hostCols, [3, "exit", "198.51.100.3", "slave", 1, 1, 26000, 26099]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"],
      [20, "entry", "host", "entry", "entry.example.test", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [201, 20, "host", 1, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [202, 20, "host", 2, 1, 1]);
    await insert("tunnels", ["id", "name", "entryGroupId", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
      [10, "grouped", 20, 1, 3, "tls", 26000, 1, 1]);
    await insert("forward_rules", ruleCols, [40, 2, "direct-on-b", "iptables", "tcp", null, null, 16000, "203.0.113.9", 80, 1, 1, 1, 0, 0]);

    const checked = await caller.checkPort({ hostId: 1, tunnelId: 10, sourcePort: 16000, protocol: "tcp" });
    assert.equal(checked.used, true, "port check must include entry-group hosts");
    assert.equal((await caller.checkPort({ hostId: 1, sourcePort: 16000, protocol: "tcp" })).used, false, "a plain rule on host 1 only checks host 1");
    assert.equal((await caller.randomPort({ hostId: 1, tunnelId: 10, protocol: "tcp" })).port, 16001);

    const base = { hostId: 1, tunnelId: 10, forwardType: "gost", protocol: "tcp", targetIp: "203.0.113.1", targetPort: 443 };
    await assert.rejects(() => crud.createDirectForwardRuleForActor(admin, { ...base, name: "fixed", sourcePort: 16000 }), /16000/);
    await crud.createDirectForwardRuleForActor(admin, { ...base, name: "random", sourcePort: 0 });
    const row = await one('SELECT "sourcePort" FROM "forward_rules" WHERE "name" = ?', ["random"]);
    assert.equal(Number(row.sourcePort), 16001, "random port must be free on every entry-group host");

    // 停着的隧道规则：重新打开 / 改到同一个端口都要看组里的主机。
    await insert("forward_rules", ruleCols, [50, 1, "stopped", "gost", "tcp", 10, 26050, 16000, "203.0.113.5", 443, 1, 0, 0, 0, 0]);
    await assert.rejects(() => crud.toggleForwardRuleForActor(admin, 50, true), /16000/);
    assert.equal(Number((await one('SELECT "isEnabled" FROM "forward_rules" WHERE "id" = 50')).isEnabled), 0);
    await runtime.executeRaw('UPDATE "forward_rules" SET "sourcePort" = 16002 WHERE "id" = 50');
    await assert.rejects(() => caller.update({ id: 50, sourcePort: 16000, isEnabled: true }), /16000/);
    assert.equal(Number((await one('SELECT "sourcePort" FROM "forward_rules" WHERE "id" = 50')).sourcePort), 16002);
  `);
});

test("system stop/restore of a route-group parent refreshes its relay hosts", () => {
  runScenario("relay-refresh", String.raw`
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const recovery = await import(moduleUrl("server/ruleBlockRecovery.ts"));
    const gate = await import(moduleUrl("server/agentHeartbeatGate.ts"));
    // pushAgentRefresh 会让主机的稳定心跳计划失效：记下被失效的主机。
    const invalidated = [];
    const original = gate.agentStableHeartbeatPlanCache.invalidate.bind(gate.agentStableHeartbeatPlanCache);
    gate.agentStableHeartbeatPlanCache.invalidate = (hostId) => { invalidated.push(Number(hostId)); return original(hostId); };
    const hostCols = ["id", "name", "ip", "hostType", "userId", "isOnline"];
    for (const id of [1, 2, 5]) await insert("hosts", hostCols, [id, "h" + id, "198.51.100." + id, "slave", 1, 1]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [10, "t", 1, 2, "tls", 25000, 1, 1]);
    await insert("forward_rules", ruleCols, [40, 1, "parent", "gost", "tcp", 10, 25000, 15000, "203.0.113.1", 443, 1, 1, 1, 0, 0]);
    await insert("forward_rules", [...ruleCols, "routeParentRuleId"], [41, 5, "relay", "gost", "tcp", null, null, 17000, "203.0.113.2", 443, 1, 1, 1, 0, 0, 40]);

    await tunnelRepo.disableForwardRulesByTunnel(10, "test");
    assert.ok(invalidated.includes(5), "relay host must be refreshed when the parent is stopped with its tunnel: " + JSON.stringify(invalidated));
    invalidated.length = 0;
    await tunnelRepo.restoreForwardRulesByTunnel(10);
    assert.equal(Number((await one('SELECT "isEnabled" FROM "forward_rules" WHERE "id" = 40')).isEnabled), 1);
    assert.ok(invalidated.includes(5), "relay host must be refreshed when the parent is restored");
    invalidated.length = 0;
    await recovery.refreshBlockedRuleRuntime([{ id: 40, hostId: 1, tunnelId: 10 }], "test-block");
    assert.ok(invalidated.includes(5), "relay host must be refreshed when the parent is blocked or unblocked");
  `);
});

test("a DDNS provider error while enabling a forward group does not roll the enable back", () => {
  runScenario("enable-ddns", String.raw`
    const groups = await import(moduleUrl("server/db.ts"));
    const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
    // Webhook 地址为空：DDNS 更新直接报错，正好模拟 DNS 服务商出错。
    await settings.setSettings({ ddnsEnabled: "true", ddnsProvider: "webhook", ddnsWebhookUrl: "" });
    const now = Math.floor(Date.now() / 1000);
    const hostCols = ["id", "name", "ip", "ipv4", "hostType", "userId", "isOnline", "lastHeartbeat"];
    await insert("hosts", hostCols, [1, "h1", "198.51.100.1", "198.51.100.1", "slave", 1, 1, now]);
    const groupCols = ["id", "name", "groupType", "groupMode", "forwardType", "domain", "recordType", "targetIp", "userId", "isEnabled"];
    await insert("forward_groups", groupCols, [10, "failover", "host", "failover", "realm", "fo.example.test", "A", "0.0.0.0", 1, 0]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
    await insert("forward_rules", [...ruleCols, "forwardGroupId", "disabledByGroup"], [100, 1, "template", "realm", "tcp", null, null, 16000, "203.0.113.10", 80, 1, 0, 0, 0, 1, 10, 1]);

    await groups.setForwardGroupEnabled(10, true);
    assert.equal(Number((await one('SELECT "isEnabled" FROM "forward_groups" WHERE "id" = 10')).isEnabled), 1, "the group stays enabled");
    assert.equal(Number((await one('SELECT "isEnabled" FROM "forward_rules" WHERE "id" = 100')).isEnabled), 1, "restored rules stay enabled");
    const error = await one('SELECT "type" FROM "forward_group_events" WHERE "groupId" = 10 AND "type" = ?', ["ddns-error"]);
    assert.ok(error, "the DDNS failure is still recorded");
  `);
});

test("a background forward-group sync treats a port reserved by another request as a conflict", () => {
  runScenario("group-sync-reservation", String.raw`
    const groups = await import(moduleUrl("server/db.ts"));
    const reservations = await import(moduleUrl("server/portReservations.ts"));
    const hostCols = ["id", "name", "ip", "ipv4", "hostType", "userId", "isOnline"];
    for (const id of [1, 2]) await insert("hosts", hostCols, [id, "h" + id, "198.51.100." + id, "198.51.100." + id, "slave", 1, 1]);
    const groupCols = ["id", "name", "groupType", "groupMode", "forwardType", "domain", "recordType", "targetIp", "userId", "isEnabled"];
    await insert("forward_groups", groupCols, [10, "failover", "host", "failover", "realm", "fo.example.test", "A", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 1, 1]);
    await insert("forward_rules", [...ruleCols, "forwardGroupId"], [100, 1, "template", "realm", "tcp", null, null, 16000, "203.0.113.10", 80, 1, 1, 0, 0, 1, 10]);
    const children = async () => (await runtime.queryRaw('SELECT "forwardGroupMemberId" FROM "forward_rules" WHERE "forwardGroupRuleId" = 100 ORDER BY "forwardGroupMemberId"'))
      .map((row) => Number(row.forwardGroupMemberId));

    // 另一个请求正在 h2 上分配 16000：后台同步不能退回只查库、跟它抢这个端口。
    const other = reservations.tryReserveHostPort(2, 16000, "tcp");
    await groups.syncForwardGroupRules(10);
    assert.deepEqual(await children(), [101], "the member whose port is being allocated elsewhere is skipped this round");

    // 调用方（建/改模板的请求）自己持有的预留：照常建子规则。
    await reservations.runWithHeldHostPortReservations([other], () => groups.syncForwardGroupRules(10));
    assert.deepEqual(await children(), [101, 102]);
    other.release();
  `);
});

test("lock-taking batch lifecycle paths refuse to run inside a database transaction", () => {
  runScenario("tx-guard", String.raw`
    const groups = await import(moduleUrl("server/db.ts"));
    await assert.rejects(
      () => runtime.withDatabaseTransaction(() => groups.healAutoStoppedForwardRules("test")),
      /programming error/,
    );
    const result = await groups.healAutoStoppedForwardRules("test");
    assert.equal(result.tunnels, 0);
  `);
});
