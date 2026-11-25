import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";
import { portForwardTemplateHostRepairs } from "./portForwardRuleHosts";

test("repairs stale port-forward template hosts using the current highest-priority member", () => {
  const repairs = portForwardTemplateHostRepairs([
    { ruleId: 10, storedHostId: 1, groupId: 5, memberId: 22, memberHostId: 3, memberPriority: 1 },
    { ruleId: 10, storedHostId: 1, groupId: 5, memberId: 21, memberHostId: 2, memberPriority: 0 },
    { ruleId: 11, storedHostId: 4, groupId: 6, memberId: 23, memberHostId: 4, memberPriority: 0 },
  ]);

  assert.deepEqual(repairs, [
    { ruleId: 10, groupId: 5, fromHostId: 1, toHostId: 2 },
  ]);
});

test("ignores invalid and duplicate member rows", () => {
  assert.deepEqual(portForwardTemplateHostRepairs([
    { ruleId: 0, storedHostId: 1, groupId: 5, memberId: 1, memberHostId: 2, memberPriority: 0 },
    { ruleId: 12, storedHostId: 1, groupId: 5, memberId: 1, memberHostId: 0, memberPriority: 0 },
  ]), []);
});

test("repairs persisted port-forward hosts before host deletion checks", () => {
  runInDatabase(String.raw`
    const repairModule = await import(url("server/portForwardRuleHosts.ts"));
    const hostRepository = await import(url("server/repositories/hostRepository.ts"));

    const BOOL = runtime.getDatabaseKind() === "postgresql" ? "BOOLEAN" : "INTEGER";
    await exec('CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "username" TEXT NOT NULL, "name" TEXT)');
    await exec('CREATE TABLE "forward_groups" ("id" INTEGER PRIMARY KEY, "groupMode" TEXT NOT NULL, "entryGroupId" INTEGER)');
    await exec('CREATE TABLE "forward_group_members" ("id" INTEGER PRIMARY KEY, "groupId" INTEGER NOT NULL, "memberType" TEXT NOT NULL, "hostId" INTEGER, "priority" INTEGER NOT NULL, "ruleId" INTEGER, "isEnabled" ' + BOOL + ' NOT NULL DEFAULT 1)');
    await exec('CREATE TABLE "forward_rules" ("id" INTEGER PRIMARY KEY, "hostId" INTEGER NOT NULL, "userId" INTEGER NOT NULL, "forwardGroupId" INTEGER, "forwardGroupRuleId" INTEGER, "forwardGroupMemberId" INTEGER, "isForwardGroupTemplate" ' + BOOL + ' NOT NULL, "isEnabled" ' + BOOL + ' NOT NULL, "pendingDelete" ' + BOOL + ' NOT NULL, "isRunning" ' + BOOL + ' NOT NULL, "updatedAt" INTEGER NOT NULL)');
    await exec('CREATE TABLE "forward_rule_tunnel_exits" ("id" INTEGER PRIMARY KEY, "ruleId" INTEGER NOT NULL)');
    // 删规则时一并清个人分组关系（server/ruleGroupRelations.ts），这张表也要有
    await exec('CREATE TABLE "rule_group_members" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "ruleId" INTEGER NOT NULL, "groupId" INTEGER NOT NULL)');
    await exec('INSERT INTO "users" ("id", "username", "name") VALUES (9, \'owner\', \'Owner\')');
    await exec('INSERT INTO "forward_groups" ("id", "groupMode") VALUES (5, \'port\')');
    await exec('INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "ruleId") VALUES (20, 5, \'host\', 2, 0, NULL)');
    await exec('INSERT INTO "forward_rules" ("id", "hostId", "userId", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "isEnabled", "pendingDelete", "isRunning", "updatedAt") VALUES (10, 1, 9, 5, NULL, NULL, 1, 1, 0, 1, 1)');

    // 挂了入口组的端口转发（组 6 自己没成员，入口组 7 里第一台启用的是主机 3）：模板钉到主机 3
    await exec('INSERT INTO "forward_groups" ("id", "groupMode", "entryGroupId") VALUES (7, \'entry\', NULL)');
    await exec('INSERT INTO "forward_groups" ("id", "groupMode", "entryGroupId") VALUES (6, \'port\', 7)');
    await exec('INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "ruleId", "isEnabled") VALUES (30, 7, \'host\', 8, 0, NULL, 0)');
    await exec('INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "ruleId", "isEnabled") VALUES (31, 7, \'host\', 3, 1, NULL, 1)');
    await exec('INSERT INTO "forward_rules" ("id", "hostId", "userId", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "isEnabled", "pendingDelete", "isRunning", "updatedAt") VALUES (11, 1, 9, 6, NULL, NULL, 1, 1, 0, 1, 1)');
    const entryGroupRepairs = await repairModule.repairPortForwardRuleHostReferences(6);
    assert.deepEqual(entryGroupRepairs, [{ ruleId: 11, groupId: 6, fromHostId: 1, toHostId: 3 }]);

    const repairs = await repairModule.repairPortForwardRuleHostReferences(5);
    assert.deepEqual(repairs, [{ ruleId: 10, groupId: 5, fromHostId: 1, toHostId: 2 }]);
    const rows = await query('SELECT "hostId", "isRunning" FROM "forward_rules" WHERE "id" = 10');
    assert.deepEqual(rows.map((row) => ({ hostId: Number(row.hostId), isRunning: Number(row.isRunning) })), [{ hostId: 2, isRunning: 0 }]);

    const oldHostBlockers = await hostRepository.getHostRuleDeleteBlockers(1);
    assert.deepEqual(oldHostBlockers, { ruleCount: 0, ruleOwners: [], managedRuleCount: 0, managedRuleOwners: [], pendingCleanupCount: 0 });
    const currentHostBlockers = await hostRepository.getHostRuleDeleteBlockers(2);
    assert.deepEqual(currentHostBlockers, {
      ruleCount: 0,
      ruleOwners: [],
      managedRuleCount: 1,
      managedRuleOwners: [{ userId: 9, username: "owner", name: "Owner", ruleCount: 1 }],
      pendingCleanupCount: 0,
    });

    await exec('DELETE FROM "forward_groups" WHERE "id" = 5');
    const orphanBlockers = await hostRepository.getHostRuleDeleteBlockers(2);
    assert.deepEqual(orphanBlockers, { ruleCount: 0, ruleOwners: [], managedRuleCount: 0, managedRuleOwners: [], pendingCleanupCount: 0 });
    const orphanRows = await query('SELECT "pendingDelete", "isRunning" FROM "forward_rules" WHERE "id" = 10');
    assert.deepEqual(orphanRows.map((row) => ({ pendingDelete: Number(row.pendingDelete), isRunning: Number(row.isRunning) })), [{ pendingDelete: 1, isRunning: 0 }]);

    await exec('DELETE FROM "forward_rules" WHERE "hostId" = 1');
    const retained = await query('SELECT "id", "hostId" FROM "forward_rules" WHERE "id" = 10');
    assert.deepEqual(retained, [{ id: 10, hostId: 2 }]);
  `, { name: "port-host", ensureSchema: false });
});

test("pending rule cleanup never remains an active host delete blocker", () => {
  runInDatabase(String.raw`
    const hostRepository = await import(url("server/repositories/hostRepository.ts"));
    const ruleRepository = await import(url("server/repositories/forwardRuleRepository.ts"));

    const BOOL = runtime.getDatabaseKind() === "postgresql" ? "BOOLEAN" : "INTEGER";
    await exec('CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "username" TEXT NOT NULL, "name" TEXT)');
    await exec('CREATE TABLE "forward_groups" ("id" INTEGER PRIMARY KEY, "groupMode" TEXT NOT NULL, "entryGroupId" INTEGER)');
    await exec('CREATE TABLE "forward_group_members" ("id" INTEGER PRIMARY KEY, "groupId" INTEGER NOT NULL, "memberType" TEXT NOT NULL, "hostId" INTEGER, "priority" INTEGER NOT NULL, "ruleId" INTEGER, "updatedAt" INTEGER, "isEnabled" ' + BOOL + ' NOT NULL DEFAULT 1)');
    await exec('CREATE TABLE "forward_rules" ("id" INTEGER PRIMARY KEY, "hostId" INTEGER NOT NULL, "userId" INTEGER NOT NULL, "forwardGroupId" INTEGER, "forwardGroupRuleId" INTEGER, "forwardGroupMemberId" INTEGER, "isForwardGroupTemplate" ' + BOOL + ' NOT NULL, "isEnabled" ' + BOOL + ' NOT NULL, "pendingDelete" ' + BOOL + ' NOT NULL, "isRunning" ' + BOOL + ' NOT NULL, "updatedAt" INTEGER NOT NULL)');
    await exec('CREATE TABLE "forward_rule_tunnel_exits" ("id" INTEGER PRIMARY KEY, "ruleId" INTEGER NOT NULL)');
    // 删规则时一并清个人分组关系（server/ruleGroupRelations.ts），这张表也要有
    await exec('CREATE TABLE "rule_group_members" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "ruleId" INTEGER NOT NULL, "groupId" INTEGER NOT NULL)');
    await exec('INSERT INTO "users" ("id", "username", "name") VALUES (99, \'customer-a\', \'Customer A\')');
    await exec('INSERT INTO "forward_rules" ("id", "hostId", "userId", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "isEnabled", "pendingDelete", "isRunning", "updatedAt") VALUES (10, 2, 99, NULL, NULL, NULL, 0, 1, 0, 1, 1)');

    assert.deepEqual(await hostRepository.getHostRuleDeleteBlockers(2), {
      ruleCount: 1,
      ruleOwners: [{ userId: 99, username: "customer-a", name: "Customer A", ruleCount: 1 }],
      managedRuleCount: 0,
      managedRuleOwners: [],
      pendingCleanupCount: 0,
    });

    await ruleRepository.markForwardRulePendingDelete(10);
    assert.deepEqual(await hostRepository.getHostRuleDeleteBlockers(2), {
      ruleCount: 0,
      ruleOwners: [],
      managedRuleCount: 0,
      managedRuleOwners: [],
      pendingCleanupCount: 1,
    });

    assert.equal(await hostRepository.releaseHostPendingRuleCleanup(2), 1);
    assert.deepEqual(await hostRepository.getHostRuleDeleteBlockers(2), {
      ruleCount: 0,
      ruleOwners: [],
      managedRuleCount: 0,
      managedRuleOwners: [],
      pendingCleanupCount: 0,
    });
    assert.deepEqual((await query('SELECT "pendingDelete", "isRunning" FROM "forward_rules" WHERE "id" = 10')).map((row) => ({ pendingDelete: Number(row.pendingDelete), isRunning: Number(row.isRunning) })), [
      { pendingDelete: 1, isRunning: 0 },
    ]);

    assert.equal(await ruleRepository.purgeSettledPendingForwardRuleDeletes(), 1);
    assert.deepEqual(await query('SELECT "id" FROM "forward_rules" WHERE "id" = 10'), []);
  `, { name: "rule-cleanup", ensureSchema: false });
});
