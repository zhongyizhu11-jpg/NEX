import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("forward access recovery restores only rules paused by eligibility", () => {
  runInDatabase(String.raw`
    const users = await import(url("server/repositories/userRepository.ts"));
    const recovery = await import(url("server/repositories/userForwardAccessRecovery.ts"));
    const groups = await import(url("server/db.ts"));
    const tunnels = await import(url("server/repositories/tunnelRepository.ts"));
    const locks = await import(url("server/keyedTaskLock.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => exec(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const rule = async (id) => (await query(
      'SELECT "isEnabled", "isRunning", "pendingDelete", "disabledByUser", "disabledByTunnel", "disabledByGroup", "protocolBlockReason" FROM "forward_rules" WHERE "id" = ?',
      [id],
    ))[0];
    const bool = (value) => value === true || value === 1 || value === "1";

    await insert("users", ["id", "username", "password", "role", "canAddRules", "allowForwardXTunnel", "accountEnabled"], [1, "member", "x", "user", 1, 1, 1]);
    for (const [id, name, ip] of [[1, "direct", "198.51.100.1"], [2, "group-a", "198.51.100.2"], [3, "group-b", "198.51.100.3"], [4, "exit", "198.51.100.4"]]) {
      await insert("hosts", ["id", "name", "ip", "userId", "portRangeStart", "portRangeEnd"], [id, name, ip, 1, 10000, 20000]);
    }
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled"], [20, "enabled-group", "host", "port", "203.0.113.20", 1, 1]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled"], [21, "disabled-group", "host", "port", "203.0.113.21", 1, 0]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled"], [22, "tunnel-entry-group", "host", "entry", "203.0.113.22", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "isEnabled"], [200, 20, "host", 2, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "isEnabled"], [210, 21, "host", 3, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "isEnabled"], [220, 22, "host", 2, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "isEnabled"], [221, 22, "host", 3, 1]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [30, "disabled-tunnel", 1, 4, "tls", 19000, 1, 0]);
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "entryGroupId", "mode", "listenPort", "userId", "isEnabled"], [31, "multi-entry-tunnel", 1, 4, 22, "tls", 19001, 1, 1]);

    const directColumns = ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "disabledByUser", "disabledByTunnel", "protocolBlockReason", "pendingDelete"];
    await insert("forward_rules", directColumns, [100, 1, "previously-running", "iptables", "tcp", 11000, "203.0.113.1", 80, 1, 1, 1, 0, 0, null, 0]);
    await insert("forward_rules", directColumns, [101, 1, "manually-off", "iptables", "tcp", 11001, "203.0.113.2", 80, 1, 0, 0, 0, 0, null, 0]);
    await insert("forward_rules", directColumns, [102, 1, "pending-delete", "iptables", "tcp", 11002, "203.0.113.3", 80, 1, 0, 0, 1, 0, null, 1]);
    await insert("forward_rules", directColumns, [103, 1, "tunnel-blocked", "iptables", "tcp", 11003, "203.0.113.4", 80, 1, 0, 0, 1, 1, null, 0]);
    await insert("forward_rules", directColumns, [104, 1, "protocol-blocked", "iptables", "tcp", 11004, "203.0.113.5", 80, 1, 0, 0, 1, 0, "blocked by agent", 0]);
    await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "disabledByUser"], [109, 1, "disabled-tunnel-rule", "gost", "tcp", 30, 11009, "203.0.113.9", 80, 1, 0, 1]);
    await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "disabledByUser"], [110, 1, "multi-entry-tunnel-rule", "gost", "tcp", 31, 11010, "203.0.113.10", 80, 1, 1, 0]);

    const groupedColumns = ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "disabledByUser"];
    await insert("forward_rules", groupedColumns, [105, 2, "enabled-template", "iptables", "tcp", 20, null, null, 1, 11105, "203.0.113.6", 80, 1, 0, 0, 1]);
    await insert("forward_rules", groupedColumns, [106, 2, "enabled-child", "iptables", "tcp", 20, 105, 200, 0, 11105, "203.0.113.6", 80, 1, 0, 0, 1]);
    await insert("forward_rules", groupedColumns, [107, 3, "disabled-template", "iptables", "tcp", 21, null, null, 1, 11107, "203.0.113.7", 80, 1, 0, 0, 1]);
    await insert("forward_rules", groupedColumns, [108, 3, "disabled-child", "iptables", "tcp", 21, 107, 210, 0, 11107, "203.0.113.7", 80, 1, 0, 0, 1]);
    await insert("forward_rules", groupedColumns, [114, 2, "tunnel-blocked-child-template", "iptables", "tcp", 20, null, null, 1, 11114, "203.0.113.14", 80, 1, 0, 0, 1]);
    await insert("forward_rules", [...groupedColumns, "disabledByTunnel"], [115, 2, "tunnel-blocked-child", "iptables", "tcp", 20, 114, 200, 0, 11114, "203.0.113.14", 80, 1, 0, 0, 1, 1]);

    await users.disableAllUserRules(1);
    assert.equal(bool((await rule(100)).disabledByUser), true);
    assert.equal(bool((await rule(101)).disabledByUser), false, "a manually disabled rule must not become recoverable");
    assert.equal(bool((await rule(102)).disabledByUser), true, "pending deletes must remain untouched");

    const restored = await recovery.restoreUserForwardRulesAfterAccessRecovery(1);
    assert.ok(restored.clearedRuleIds.includes(100));
    assert.equal(bool((await rule(100)).isEnabled), true);
    assert.equal(bool((await rule(101)).isEnabled), false);
    assert.equal(bool((await rule(101)).disabledByUser), false);
    assert.equal(bool((await rule(102)).disabledByUser), true);
    assert.equal(bool((await rule(103)).isEnabled), false);
    assert.equal(bool((await rule(103)).disabledByUser), false);
    assert.equal(bool((await rule(103)).disabledByTunnel), true);
    assert.equal(bool((await rule(104)).isEnabled), false);
    assert.equal((await rule(104)).protocolBlockReason, "blocked by agent");
    assert.equal(bool((await rule(105)).isEnabled), true);
    assert.equal(bool((await rule(106)).isEnabled), true, "managed children follow the restored template");
    assert.equal(bool((await rule(107)).isEnabled), false);
    assert.equal(bool((await rule(108)).isEnabled), false, "a disabled group must keep its child stopped");
    assert.equal(bool((await rule(107)).disabledByGroup), true, "the group recovery path must retain ownership of the blocker");
    assert.equal(bool((await rule(114)).isEnabled), true);
    assert.equal(bool((await rule(115)).isEnabled), false, "group sync must not clear a generated child's tunnel blocker");
    assert.equal(bool((await rule(115)).disabledByTunnel), true);
    assert.equal(bool((await rule(109)).isEnabled), false, "a disabled tunnel must keep its rule stopped");
    assert.equal(bool((await rule(109)).disabledByTunnel), true, "the tunnel recovery path must retain ownership of the blocker");
    assert.equal(bool((await rule(110)).isEnabled), true);
    assert.deepEqual(
      [1, 2, 3, 4].filter((hostId) => restored.refreshedHostIds.includes(hostId)),
      [1, 2, 3, 4],
      "multi-entry tunnel recovery must refresh every enabled endpoint Agent",
    );

    await groups.setForwardGroupEnabled(21, true);
    assert.equal(bool((await rule(107)).isEnabled), true);
    assert.equal(bool((await rule(108)).isEnabled), true, "enabling the group later must finish restoring its child");
    await tunnels.updateTunnel(30, { isEnabled: true });
    await tunnels.restoreForwardRulesByTunnel(30);
    assert.equal(bool((await rule(109)).isEnabled), true, "enabling the tunnel later must finish restoring its direct rule");

    await exec('UPDATE "forward_rules" SET "isEnabled" = 0, "disabledByUser" = 1 WHERE "id" = 100');
    await runtime.withDatabaseTransaction(async () => {
      await recovery.scheduleUserForwardRulesAfterAccessRecovery(1);
      assert.equal(bool((await rule(100)).isEnabled), false, "restore must wait for the surrounding transaction to commit");
    });
    assert.equal(bool((await rule(100)).isEnabled), true);

    await exec('UPDATE "forward_rules" SET "isEnabled" = 0, "disabledByUser" = 1 WHERE "id" = 100');
    const billingLock = locks.trafficBillingUserLockKey(1);
    await locks.withKeyedTaskLock(billingLock, async () => {
      await runtime.withDatabaseTransaction(async () => {
        await recovery.scheduleUserForwardRulesAfterAccessRecovery(1);
      });
      assert.equal(bool((await rule(100)).isEnabled), false, "restore queued by a billing transaction must not deadlock its lock holder");
    });
    await locks.withKeyedTaskLock(billingLock, async () => undefined);
    assert.equal(bool((await rule(100)).isEnabled), true, "restore must run immediately after the billing lock is released");

    await exec('UPDATE "forward_rules" SET "isEnabled" = 0, "disabledByUser" = 1 WHERE "id" = 100');
    await exec('UPDATE "users" SET "accountEnabled" = 0 WHERE "id" = 1');
    await recovery.restoreUserForwardRulesAfterAccessRecovery(1);
    assert.equal(bool((await rule(100)).disabledByUser), true, "a disabled account cannot restore rules");
    await exec('UPDATE "users" SET "accountEnabled" = 1, "forwardAccessPauseReason" = ? WHERE "id" = 1', ["manual"]);
    await recovery.restoreUserForwardRulesAfterAccessRecovery(1);
    assert.equal(bool((await rule(100)).disabledByUser), true, "a manual access pause cannot restore rules");
  `, { name: "access-recovery" });
});
