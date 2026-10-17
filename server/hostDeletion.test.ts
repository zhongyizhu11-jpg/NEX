import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 删主机时「还有规则在机器上等清理」这件事怎么处理（照上游 poouo/Forwardx server/hostDeletion.ts 移植）：
 * - 主机在线：拒绝删除，顺手催 Agent 刷新一次把规则停掉；
 * - 主机离线：面板没法确认规则已经停了，要调用方明确确认（confirmOfflineCleanup）才删；
 * - 引用检查和删除在同一个事务里，删到一半失败不能留下删了一半的主机；
 * - 检查前先修好转发组模板上过期的主机引用，别让一条早就不在这台机器上的模板挡住删除。
 */
function runScenario(name: string, body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `forwardx-host-delete-${name}-`));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const agentEvents = await import(moduleUrl("server/agentEvents.ts"));
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
    const hostCols = ["id", "name", "ip", "hostType", "userId", "isOnline", "lastHeartbeat"];
    const now = Math.floor(Date.now() / 1000);
    const ruleCols = ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "pendingDelete", "isForwardGroupTemplate", "forwardGroupId"];
    /** 假装这台机器的 Agent 连着事件流，记下面板推了几次事件。 */
    class FakeEventResponse extends EventEmitter {
      writes = [];
      write(value) { this.writes.push(String(value)); return true; }
      end() { this.emit("finish"); }
      destroy() { this.emit("close"); }
    }
    const connectAgent = (hostId) => {
      const response = new FakeEventResponse();
      agentEvents.registerAgentEventClient(hostId, "token-" + hostId, response);
      return response;
    };
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "name"], [99, "customer-a", "x", "user", 1, "Customer A"]);
      const { hostsRouter } = await import(moduleUrl("server/routers/hosts.ts"));
      const caller = hostsRouter.createCaller(context(admin));
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
        FORWARDX_TEST_DB: path.join(directory, "host-delete.db"),
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

test("在线主机还有待清理的规则：拒绝删除，并催 Agent 刷新", () => {
  runScenario("online-pending", String.raw`
    await insert("hosts", hostCols, [1, "tokyo", "198.51.100.1", "slave", 1, 1, now]);
    await insert("forward_rules", ruleCols, [10, 1, "removed", "gost", "tcp", 10000, "203.0.113.1", 80, 1, 0, 1, 1, 0, null]);
    const agent = connectAgent(1);

    await assert.rejects(() => caller.delete({ id: 1 }), (error) => {
      assert.match(error.message, /正在清理已删除的规则/);
      assert.equal(error.code, "CONFLICT");
      return true;
    });
    // 即便调用方说「我确认」，在线主机也要等 Agent 自己停掉。
    await assert.rejects(() => caller.delete({ id: 1, confirmOfflineCleanup: true }), /正在清理已删除的规则/);
    assert.ok(agent.writes.length > 0, "面板应该推一次 agent-refresh 让 Agent 去停规则");
    assert.ok(await one('SELECT "id" FROM "hosts" WHERE "id" = 1'), "主机还在");
    const rule = await one('SELECT "isRunning", "pendingDelete" FROM "forward_rules" WHERE "id" = 10');
    assert.equal(Number(rule.isRunning), 1, "待清理的规则不能被面板单方面标成已停");
    assert.equal(Number(rule.pendingDelete), 1);
  `);
});

test("离线主机还有待清理的规则：要明确确认才删", () => {
  runScenario("offline-pending", String.raw`
    await insert("hosts", hostCols, [2, "offline", "198.51.100.2", "slave", 1, 0, null]);
    await insert("forward_rules", ruleCols, [20, 2, "removed", "gost", "tcp", 10000, "203.0.113.1", 80, 1, 0, 1, 1, 0, null]);
    await insert("user_host_permissions", ["id", "userId", "hostId"], [1, 99, 2]);

    await assert.rejects(() => caller.delete({ id: 2 }), (error) => {
      assert.match(error.message, /主机离线/);
      assert.equal(error.code, "PRECONDITION_FAILED");
      return true;
    });
    assert.ok(await one('SELECT "id" FROM "hosts" WHERE "id" = 2'), "没确认就不删");
    assert.equal(Number((await one('SELECT "isRunning" FROM "forward_rules" WHERE "id" = 20')).isRunning), 1);

    assert.deepEqual(await caller.delete({ id: 2, confirmOfflineCleanup: true }), { success: true });
    assert.equal(await one('SELECT "id" FROM "hosts" WHERE "id" = 2'), undefined);
    assert.equal(await one('SELECT "id" FROM "user_host_permissions" WHERE "hostId" = 2'), undefined, "主机权限一起删");
  `);
});

test("没有待清理规则的主机照常删，不用确认", () => {
  runScenario("plain", String.raw`
    await insert("hosts", hostCols, [3, "idle", "198.51.100.3", "slave", 1, 0, null]);
    await insert("forward_rules", ruleCols, [30, 3, "stopped history", "gost", "tcp", 10000, "203.0.113.1", 80, 1, 0, 0, 1, 0, null]);
    assert.deepEqual(await caller.delete({ id: 3 }), { success: true });
    assert.equal(await one('SELECT "id" FROM "hosts" WHERE "id" = 3'), undefined);
  `);
});

test("还挂着规则时，管理员能看到是谁的规则", () => {
  runScenario("owners", String.raw`
    await insert("hosts", hostCols, [4, "busy", "198.51.100.4", "slave", 1, 1, now]);
    await insert("forward_rules", ruleCols, [40, 4, "live", "gost", "tcp", 10000, "203.0.113.1", 80, 99, 1, 1, 0, 0, null]);
    await assert.rejects(() => caller.delete({ id: 4 }), (error) => {
      assert.match(error.message, /还有 1 条转发规则/);
      assert.match(error.message, /Customer A（customer-a）：1 条/);
      return true;
    });
  `);
});

test("转发组模板上过期的主机引用先修好，不再挡住删除", () => {
  runScenario("stale-template", String.raw`
    await insert("hosts", hostCols, [5, "old-member", "198.51.100.5", "slave", 1, 0, null]);
    await insert("hosts", hostCols, [6, "new-member", "198.51.100.6", "slave", 1, 0, null]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled"], [50, "g", "host", "failover", "0.0.0.0", 1, 1]);
    // 主机 5 早就从组里换掉了，模板的 hostId 还停在它身上。
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [501, 50, "host", 6, 0, 1]);
    await insert("forward_rules", ruleCols, [55, 5, "template", "gost", "tcp", 12000, "203.0.113.9", 80, 1, 1, 0, 0, 1, 50]);

    assert.deepEqual(await caller.delete({ id: 5 }), { success: true });
    assert.equal(await one('SELECT "id" FROM "hosts" WHERE "id" = 5'), undefined);
    const template = await one('SELECT "hostId", "pendingDelete" FROM "forward_rules" WHERE "id" = 55');
    assert.equal(Number(template.hostId), 6, "模板改指向组里现在的成员");
    assert.equal(Number(template.pendingDelete), 0, "模板本身不受影响");
    // 组里现在的成员照样删不掉。
    await assert.rejects(() => caller.delete({ id: 6 }), /转发组/);
  `);
});

test("检查和删除在一个事务里：删到一半失败，权限、待清理规则都原样留着", () => {
  runScenario("atomic", String.raw`
    await insert("hosts", hostCols, [7, "fragile", "198.51.100.7", "slave", 1, 0, null]);
    await insert("forward_rules", ruleCols, [70, 7, "removed", "gost", "tcp", 10000, "203.0.113.1", 80, 1, 0, 1, 1, 0, null]);
    await insert("user_host_permissions", ["id", "userId", "hostId"], [7, 99, 7]);
    await runtime.executeRaw('CREATE TRIGGER fail_host_delete BEFORE DELETE ON "hosts" BEGIN SELECT RAISE(ABORT, ' + "'boom'" + '); END');

    await assert.rejects(() => caller.delete({ id: 7, confirmOfflineCleanup: true }), /boom/);
    assert.ok(await one('SELECT "id" FROM "hosts" WHERE "id" = 7'));
    assert.ok(await one('SELECT "id" FROM "user_host_permissions" WHERE "hostId" = 7'), "权限不能先删掉");
    const rule = await one('SELECT "isRunning" FROM "forward_rules" WHERE "id" = 70');
    assert.ok(rule, "规则行不能先删掉");
    assert.equal(Number(rule.isRunning), 1, "待清理状态不能先放掉");
  `);
});
