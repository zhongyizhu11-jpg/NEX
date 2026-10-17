import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNoDirectSelfForwardLoop } from "./selfForwardLoop";

/**
 * 转发组换成员时也要查「本机端口转发回本机同端口」的死循环（规则新建 / 编辑时 rules.crud.ts 查过一遍）：
 * - 入口组加了一台主机：挂这个入口组的端口转发会在新主机上铺一条子规则；
 * - 端口转发 / 故障转移组自己加了成员：模板同样会铺到新成员上。
 * 新主机的地址正好是规则目标、端口又相同，子规则就是一个死循环，要整体拒绝、成员不变。
 */
function runScenario(name: string, body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `forwardx-group-loop-${name}-`));
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
    const memberHosts = async (groupId) => (await runtime.queryRaw('SELECT "hostId" FROM "forward_group_members" WHERE "groupId" = ? ORDER BY "hostId"', [groupId])).map((row) => Number(row.hostId));
    const hostCols = ["id", "name", "ip", "hostType", "userId"];
    const groupCols = ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled", "entryGroupId"];
    const memberCols = ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"];
    const ruleCols = ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "pendingDelete", "isForwardGroupTemplate", "forwardGroupId"];
    const host = (id, extra = {}) => ({ memberType: "host", hostId: id, priority: id, isEnabled: true, ...extra });
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
      for (const id of [1, 2, 3]) await insert("hosts", hostCols, [id, "h" + id, "198.51.100." + id, "slave", 1]);
      const groups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
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
        FORWARDX_TEST_DB: path.join(directory, "loop.db"),
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

test("入口组加了一台主机，挂它的端口转发在新主机上会转回自己：拒绝，成员不变", () => {
  runScenario("entry", String.raw`
    await insert("forward_groups", groupCols, [20, "entry", "host", "entry", "0.0.0.0", 1, 0, null]);
    await insert("forward_group_members", memberCols, [201, 20, "host", 1, 0, 1]);
    await insert("forward_groups", groupCols, [30, "port", "host", "port", "0.0.0.0", 1, 0, 20]);
    // 目标就是主机 2 的地址、同一个端口。
    await insert("forward_rules", ruleCols, [300, 1, "to-h2", "iptables", "tcp", 15000, "198.51.100.2", 15000, 1, 1, 0, 0, 1, 30]);

    await assert.rejects(() => groups.replaceForwardGroupMembers(20, [host(1), host(2)], { skipSync: true }), /死循环/);
    assert.deepEqual(await memberHosts(20), [1]);

    // 不会转回自己的主机照常加。
    await groups.replaceForwardGroupMembers(20, [host(1), host(3)], { skipSync: true });
    assert.deepEqual(await memberHosts(20), [1, 3]);
    // 停用状态加进来不会铺子规则，不拦；之后启用它要拦。
    await groups.replaceForwardGroupMembers(20, [host(1), host(3), host(2, { isEnabled: false })], { skipSync: true });
    await assert.rejects(() => groups.replaceForwardGroupMembers(20, [host(1), host(3), host(2)], { skipSync: true }), /死循环/);
  `);
});

test("故障转移组 / 端口转发自己加成员，模板会铺到新成员上：同样要拦", () => {
  runScenario("members", String.raw`
    await insert("forward_groups", groupCols, [40, "failover", "host", "failover", "0.0.0.0", 1, 0, null]);
    await insert("forward_group_members", memberCols, [401, 40, "host", 1, 0, 1]);
    await insert("forward_rules", ruleCols, [400, 1, "to-h2", "iptables", "tcp", 16000, "198.51.100.2", 16000, 1, 1, 0, 0, 1, 40]);
    await assert.rejects(() => groups.replaceForwardGroupMembers(40, [host(1), host(2)], { skipSync: true }), /死循环/);
    assert.deepEqual(await memberHosts(40), [1]);

    await insert("forward_groups", groupCols, [50, "port-own", "host", "port", "0.0.0.0", 1, 0, null]);
    await insert("forward_group_members", memberCols, [501, 50, "host", 1, 0, 1]);
    await insert("forward_rules", ruleCols, [500, 1, "to-localhost", "iptables", "tcp", 17000, "198.51.100.3", 17000, 1, 1, 0, 0, 1, 50]);
    await assert.rejects(() => groups.replaceForwardGroupMembers(50, [host(1), host(3)], { skipSync: true }), /死循环/);
    assert.deepEqual(await memberHosts(50), [1]);
    // 端口不一样就不是死循环。
    await runtime.executeRaw('UPDATE "forward_rules" SET "targetPort" = 17001 WHERE "id" = 500');
    await groups.replaceForwardGroupMembers(50, [host(1), host(3)], { skipSync: true });
    assert.deepEqual(await memberHosts(50), [1, 3]);
  `);
});

test("assertNoDirectSelfForwardLoop：同端口转回本机地址 / 环回地址才拦", () => {
  const host = { ip: "198.51.100.9", ipv6: "2001:db8::9", ddnsDomain: "edge.example.com" };
  for (const targetIp of ["198.51.100.9", "[2001:DB8::9]", "edge.example.com.", "127.0.0.1", "2130706433", "localhost", "::1"]) {
    assert.throws(() => assertNoDirectSelfForwardLoop({ host, sourcePort: 443, targetIp, targetPort: 443 }), /死循环/, targetIp);
  }
  assert.doesNotThrow(() => assertNoDirectSelfForwardLoop({ host, sourcePort: 443, targetIp: "198.51.100.9", targetPort: 8443 }));
  assert.doesNotThrow(() => assertNoDirectSelfForwardLoop({ host, sourcePort: 443, targetIp: "203.0.113.1", targetPort: 443 }));
  assert.doesNotThrow(() => assertNoDirectSelfForwardLoop({ host, sourcePort: 443, targetIp: "127.0.0.1", targetPort: 443, tunnelId: 3 }), "走隧道的不是本机直转");
});
