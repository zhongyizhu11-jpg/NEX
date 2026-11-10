import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  转发规则个人分组在真的 SQLite 上走一遍（server/ruleGroups.ts、server/ruleGroupRelations.ts、
  规则列表的分组筛选 / 排序、rules.* 的几个接口）。

  盯四件事：
    · 账号之间隔离：看不到、改不了、筛不出别人的组；普通用户只能归自己的规则；管理员能把别人的规则
      放进**自己的**组，规则的主人看不到；
    · 一条规则同时在好几个组里，列表按组筛不出重复行，未分组排最后；
    · 删规则（标成待删、真正删行）、删主机、删用户时关系跟着清，不留孤儿；
    · 删组不删规则，也不动规则在别的组里的关系；删过的组不会被迟到的归组请求「复活」。
*/
function runSqliteScript(script: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-rule-groups-"));
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db") },
    encoding: "utf8",
    timeout: 120_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

/** 每段脚本共用的开头：连库、建表、三个账号（1 管理员、2 和 3 普通用户）、两台主机、几条规则。 */
const PRELUDE = String.raw`
  import assert from "node:assert/strict";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(url("server/dbRuntime.ts"));
  const schema = await import(url("server/dbSchema.ts"));
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
  await schema.ensureDatabaseSchema();
  const exec = (sql, params = []) => runtime.executeRaw(sql, params);
  const query = (sql, params = []) => runtime.queryRaw(sql, params);
  const groups = await import(url("server/ruleGroups.ts"));
  const rules = await import(url("server/repositories/forwardRuleRepository.ts"));

  await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
  await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'alice', 'h', 'user')");
  await exec("INSERT INTO users (id, username, password, role) VALUES (3, 'bob', 'h', 'user')");
  await exec("INSERT INTO hosts (id, name, ip, userId, agentToken) VALUES (1, 'hk', '192.0.2.1', 1, 't1')");
  await exec("INSERT INTO hosts (id, name, ip, userId, agentToken) VALUES (2, 'jp', '192.0.2.2', 1, 't2')");
  const rule = (id, userId, hostId = 1, extra = {}) => runtime.insertAndGetId("forward_rules", {
    id, hostId, userId, name: "r" + id, forwardType: "gost", protocol: "tcp",
    sourcePort: 20000 + id, targetIp: "198.51.100.1", targetPort: 80, sortOrder: id, ...extra,
  });
  // 11、12、13 是 alice 的；21 是 bob 的；31 是管理员自己的，在第二台主机上。
  for (const id of [11, 12, 13]) await rule(id, 2);
  await rule(21, 3);
  await rule(31, 1, 2);

  const admin = { id: 1, role: "admin" };
  const alice = { id: 2, role: "user" };
  const bob = { id: 3, role: "user" };
  const memberRows = async () => (await query('SELECT "userId", "ruleId", "groupId" FROM rule_group_members ORDER BY "userId", "ruleId", "groupId"'))
    .map((row) => row.userId + ":" + row.ruleId + ":" + row.groupId).join(" ");
  const groupIdsOf = async (userId, ruleId) => (await groups.getRulePersonalGroupIds(userId, [ruleId])).get(ruleId) || [];
  const pageIds = async (input) => (await rules.getForwardRulesPage({ category: "all", search: "", page: 1, pageSize: 50, ...input })).items.map((item) => Number(item.id));
  const rejects = async (work, code) => {
    await assert.rejects(work, (error) => {
      assert.equal(error.code, code, String(error.message));
      return true;
    });
  };
`;

test("个人分组按账号隔离：互相看不到、改不了，管理员只能把别人的规则放进自己的组", () => {
  runSqliteScript(PRELUDE + String.raw`
    try {
      // 两个人可以各有一个同名的组；同一个人不行（不分大小写）。
      const aliceGames = (await groups.savePersonalRuleGroup(alice, { name: "Games" })).id;
      const bobGames = (await groups.savePersonalRuleGroup(bob, { name: "Games" })).id;
      const adminWatch = (await groups.savePersonalRuleGroup(admin, { name: "盯着看" })).id;
      assert.notEqual(aliceGames, bobGames);
      await rejects(groups.savePersonalRuleGroup(alice, { name: " games " }), "CONFLICT");

      // 别人的组：改名、删除、排序、往里放规则，一律当「不存在」。
      await rejects(groups.savePersonalRuleGroup(alice, { id: bobGames, name: "mine" }), "NOT_FOUND");
      await rejects(groups.deletePersonalRuleGroup(alice, bobGames), "NOT_FOUND");
      await rejects(groups.reorderPersonalRuleGroups(alice, [bobGames]), "BAD_REQUEST");
      await rejects(groups.moveRulesToPersonalGroups(alice, [11], [bobGames], "add"), "NOT_FOUND");
      // 管理员也碰不到别人的组。
      await rejects(groups.moveRulesToPersonalGroups(admin, [11], [aliceGames], "add"), "NOT_FOUND");
      await rejects(groups.deletePersonalRuleGroup(admin, aliceGames), "NOT_FOUND");

      // 普通用户只能归自己的规则；一批里混着一条别人的，整批不做。
      await rejects(groups.moveRulesToPersonalGroups(alice, [11, 21], [aliceGames], "add"), "FORBIDDEN");
      assert.equal(await memberRows(), "");
      await groups.moveRulesToPersonalGroups(alice, [11, 12], [aliceGames], "add");
      await groups.moveRulesToPersonalGroups(bob, [21], [bobGames], "add");

      // 管理员能把别人的规则放进自己的组：关系记在管理员名下，规则的主人看不到。
      await groups.moveRulesToPersonalGroups(admin, [11, 21, 31], [adminWatch], "add");
      assert.deepEqual(await groupIdsOf(1, 11), [adminWatch]);
      assert.deepEqual(await groupIdsOf(2, 11), [aliceGames]);
      assert.deepEqual(await groupIdsOf(3, 11), []);

      // 分组栏：每个人只列出自己的组，数字只数自己看得见的范围。
      const aliceView = await groups.getPersonalRuleGroupOverview(2, { ownerUserId: 2, category: "all" });
      assert.deepEqual(aliceView.groups.map((group) => [group.name, group.count]), [["Games", 2]]);
      assert.deepEqual([aliceView.total, aliceView.ungrouped], [3, 1]);
      const adminAll = await groups.getPersonalRuleGroupOverview(1, { ownerUserId: undefined, category: "all" });
      assert.deepEqual(adminAll.groups.map((group) => [group.name, group.count]), [["盯着看", 3]]);
      assert.deepEqual([adminAll.total, adminAll.ungrouped], [5, 2]);
      const adminSelf = await groups.getPersonalRuleGroupOverview(1, { ownerUserId: 1, category: "all" });
      assert.deepEqual(adminSelf.groups.map((group) => group.count), [1]);
      assert.deepEqual([adminSelf.total, adminSelf.ungrouped], [1, 0]);

      // 列表按组筛：拿别人的组 id 来筛，一条都筛不出来；不带「谁在看」也是一条都不给。
      assert.deepEqual(await pageIds({ ownerUserId: 2, personalGroupOwnerId: 2, personalGroupId: aliceGames }), [11, 12]);
      assert.deepEqual(await pageIds({ ownerUserId: 2, personalGroupOwnerId: 2, personalGroupId: bobGames }), []);
      assert.deepEqual(await pageIds({ ownerUserId: 2, personalGroupOwnerId: 2, personalGroupId: adminWatch }), []);
      assert.deepEqual(await pageIds({ ownerUserId: 2, personalGroupId: aliceGames }), []);
      // 管理员看「所有用户」按自己的组筛：筛出来的是三个人的规则。
      assert.deepEqual((await pageIds({ personalGroupOwnerId: 1, personalGroupId: adminWatch })).sort(), [11, 21, 31]);

      // 接口这一层：主人永远是登录的人，入参里塞别人的 id 也没用；规则上带的是看的人自己的组。
      const { rulesRouter } = await import(url("server/routers/rules.ts"));
      const caller = (user) => rulesRouter.createCaller({ user: { ...user, username: "u" + user.id, accountEnabled: true }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null });
      const viaApi = await caller(alice).personalGroups({ userId: 3, scope: "all" });
      assert.deepEqual(viaApi.groups.map((group) => group.id), [aliceGames]);
      assert.equal(viaApi.total, 3);
      const alicePage = await caller(alice).listPage({ page: 1, pageSize: 50, category: "all" });
      assert.deepEqual(alicePage.items.map((item) => [item.id, item.personalGroupIds]), [[11, [aliceGames]], [12, [aliceGames]], [13, []]]);
      const adminPage = await caller(admin).listPage({ page: 1, pageSize: 50, category: "all", scope: "all", personalGroupId: adminWatch });
      assert.deepEqual(adminPage.items.map((item) => item.personalGroupIds), [[adminWatch], [adminWatch], [adminWatch]]);
      await rejects(caller(alice).moveToPersonalGroups({ ids: [21], groupIds: [aliceGames], mode: "add" }), "FORBIDDEN");
      await rejects(caller(alice).deletePersonalGroup({ id: adminWatch }), "NOT_FOUND");
      await rejects(caller(alice).moveToPersonalGroups({ ids: [11], groupIds: [], mode: "add" }), "BAD_REQUEST");

      // 管理员降成普通用户以后，以前放进组里的别人的规则还能清出去（加是加不了了）。
      const demoted = { id: 1, role: "user" };
      await rejects(groups.moveRulesToPersonalGroups(demoted, [21], [adminWatch], "add"), "FORBIDDEN");
      await groups.moveRulesToPersonalGroups(demoted, [11, 21], [adminWatch], "remove");
      assert.deepEqual(await groupIdsOf(1, 21), []);
      assert.deepEqual(await groupIdsOf(2, 11), [aliceGames]);
    } finally {
      await runtime.closeDatabase();
    }
  `);
});

test("一条规则可以在多个组里：加入 / 移出 / 替换、筛选不重复、未分组排最后、组能改名和排序", () => {
  runSqliteScript(PRELUDE + String.raw`
    try {
      const work = (await groups.savePersonalRuleGroup(alice, { name: "工作" })).id;
      const play = (await groups.savePersonalRuleGroup(alice, { name: "游戏" })).id;
      const spare = (await groups.savePersonalRuleGroup(alice, { name: "备用" })).id;

      // 12 在两个组里，13 只在「游戏」里，11 一个组都不在。
      await groups.moveRulesToPersonalGroups(alice, [12], [work, play], "add");
      await groups.moveRulesToPersonalGroups(alice, [13], [play], "add");
      assert.deepEqual(await groupIdsOf(2, 12), [work, play]);
      // 重复加入不出重复行。
      await groups.moveRulesToPersonalGroups(alice, [12, 13], [play, play], "add");
      assert.equal((await query("SELECT COUNT(*) AS n FROM rule_group_members"))[0].n, 3);

      const overview = await groups.getPersonalRuleGroupOverview(2, { ownerUserId: 2, category: "all" });
      assert.deepEqual(overview.groups.map((group) => [group.name, group.count]), [["工作", 1], ["游戏", 2], ["备用", 0]]);
      assert.deepEqual([overview.total, overview.ungrouped], [3, 1]);

      // 按组筛：在两个组里的规则只出一行；总数、摘要、地图分批和分页对得上；0 = 未分组。
      const scope = { ownerUserId: 2, personalGroupOwnerId: 2, category: "all", search: "" };
      const page = await rules.getForwardRulesPage({ ...scope, personalGroupId: play, page: 1, pageSize: 50 });
      assert.deepEqual(page.items.map((item) => Number(item.id)), [12, 13]);
      assert.equal(page.totalItems, 2);
      // 分类条上的数字不跟分组筛选走。
      assert.equal(page.categoryCounts.all, 3);
      assert.equal(page.scopeTotalItems, 3);
      assert.equal((await rules.getForwardRuleSummarySelection({ ...scope, personalGroupId: play })).totalItems, 2);
      assert.equal((await rules.getForwardRuleMapBatch({ ...scope, personalGroupId: play }, 0, 50)).totalItems, 2);
      assert.deepEqual(await pageIds({ ...scope, personalGroupId: 0 }), [11]);
      assert.deepEqual(await pageIds({ ...scope, personalGroupId: spare }), []);

      // 按分组排序：「工作」在前（12），然后「游戏」（13），未分组的 11 排最后。
      assert.deepEqual(await pageIds({ ...scope, sortByPersonalGroup: true }), [12, 13, 11]);
      // 把「游戏」拖到最前面：12 两个组都在，名次跟着最靠前的那个组走。
      await groups.reorderPersonalRuleGroups(alice, [play, spare, work]);
      assert.deepEqual((await groups.getPersonalRuleGroupOverview(2, { ownerUserId: 2, category: "all" })).groups.map((group) => group.name), ["游戏", "备用", "工作"]);
      assert.deepEqual(await groupIdsOf(2, 12), [play, work]);
      assert.deepEqual(await pageIds({ ...scope, sortByPersonalGroup: true }), [12, 13, 11]);
      await groups.moveRulesToPersonalGroups(alice, [12], [play], "remove");
      assert.deepEqual(await pageIds({ ...scope, sortByPersonalGroup: true }), [13, 12, 11]);
      // 排序的列表必须正好是自己全部的组。
      await rejects(groups.reorderPersonalRuleGroups(alice, [play, work]), "BAD_REQUEST");
      await rejects(groups.reorderPersonalRuleGroups(alice, [play, play, work]), "BAD_REQUEST");

      // 移出只动选中的组，别的组里的关系留着；替换成空 = 清空归属。
      await groups.moveRulesToPersonalGroups(alice, [12, 13], [play, spare], "replace");
      assert.deepEqual(await groupIdsOf(2, 12), [play, spare]);
      assert.deepEqual(await groupIdsOf(2, 13), [play, spare]);
      await groups.moveRulesToPersonalGroups(alice, [13], [], "replace");
      assert.deepEqual(await groupIdsOf(2, 13), []);

      // 管理弹窗保存：改名和这次勾选 / 取消勾选的规则一起生效，不是整组覆盖（12 还在组里）。
      await groups.savePersonalRuleGroup(alice, { id: play, name: "娱乐", addRuleIds: [11], removeRuleIds: [13] });
      assert.deepEqual((await pageIds({ ...scope, personalGroupId: play })).sort(), [11, 12]);
      assert.equal((await groups.getPersonalRuleGroupOverview(2, { ownerUserId: 2, category: "all" })).groups[0].name, "娱乐");
      // 里面有一条不是自己的规则：整个保存都不生效，名字也不改。
      await rejects(groups.savePersonalRuleGroup(alice, { id: play, name: "改不了", addRuleIds: [21] }), "FORBIDDEN");
      assert.equal((await groups.getPersonalRuleGroupOverview(2, { ownerUserId: 2, category: "all" })).groups[0].name, "娱乐");

      // 转发组展开出来的子规则不在列表里，也进不了组。
      await rule(14, 2, 1, { forwardGroupRuleId: 11 });
      await rejects(groups.moveRulesToPersonalGroups(alice, [14], [play], "add"), "FORBIDDEN");
    } finally {
      await runtime.closeDatabase();
    }
  `);
});

test("删规则、删主机、删用户时分组关系跟着清；删组不删规则", () => {
  runSqliteScript(PRELUDE + String.raw`
    try {
      const hosts = await import(url("server/repositories/hostRepository.ts"));
      const users = await import(url("server/repositories/userRepository.ts"));
      const a = (await groups.savePersonalRuleGroup(alice, { name: "A" })).id;
      const b = (await groups.savePersonalRuleGroup(alice, { name: "B" })).id;
      const watch = (await groups.savePersonalRuleGroup(admin, { name: "盯着看" })).id;
      const bobs = (await groups.savePersonalRuleGroup(bob, { name: "bob" })).id;
      await groups.moveRulesToPersonalGroups(alice, [11, 12, 13], [a, b], "add");
      await groups.moveRulesToPersonalGroups(admin, [11, 12, 21, 31], [watch], "add");
      await groups.moveRulesToPersonalGroups(bob, [21], [bobs], "add");
      const count = async (where = "1 = 1", params = []) => Number((await query("SELECT COUNT(*) AS n FROM rule_group_members WHERE " + where, params))[0].n);
      assert.equal(await count(), 11);

      // 删组：只少了这个组和它的关系；规则一条不少，规则在别的组里的关系也在。
      await groups.deletePersonalRuleGroup(alice, a);
      assert.equal(Number((await query("SELECT COUNT(*) AS n FROM forward_rules"))[0].n), 5);
      assert.deepEqual(await groupIdsOf(2, 11), [b]);
      assert.equal(await count('"groupId" = ?', [a]), 0);
      assert.equal(await count(), 8);
      // 删过的组不会被迟到的请求「复活」：归组在锁里现读，组已经不在就整批拒绝，一行关系都不写。
      await rejects(groups.moveRulesToPersonalGroups(alice, [13], [a, b], "add"), "NOT_FOUND");
      await rejects(groups.savePersonalRuleGroup(alice, { id: a, name: "A", addRuleIds: [13] }), "NOT_FOUND");
      assert.equal(await count('"groupId" = ?', [a]), 0);
      assert.equal(await count(), 8);

      // 删规则（面板上点删除：先标成待删）：它在所有人组里的关系当场清掉，包括管理员组里的那一行。
      await rules.deleteForwardRule(11);
      assert.equal(await count('"ruleId" = 11'), 0);
      assert.equal((await groups.getPersonalRuleGroupOverview(1, { category: "all" })).groups[0].count, 3);
      // 待删的规则已经不在列表里，也不能再往组里放。
      await rejects(groups.moveRulesToPersonalGroups(alice, [11], [b], "add"), "FORBIDDEN");
      // 真正删行时再兜一次底：就算待删期间留下了关系（这里手工塞一行），行消失前也清干净。
      await exec('INSERT INTO rule_group_members ("userId", "ruleId", "groupId") VALUES (2, 11, ?)', [b]);
      await rules.finalizeForwardRuleDelete(11);
      assert.equal(Number((await query("SELECT COUNT(*) AS n FROM forward_rules WHERE id = 11"))[0].n), 0);
      assert.equal(await count('"ruleId" = 11'), 0);
      // Agent 那条路（先标待删、等机器确认再删行）也一样。
      await rules.markForwardRulePendingDelete(12);
      assert.equal(await count('"ruleId" = 12'), 0);

      // 删主机：上面的规则整批删行，关系一起清；另一台主机上的规则不受影响。
      await hosts.deleteHost(2);
      assert.equal(await count('"ruleId" = 31'), 0);
      assert.equal(await memberRows(), "1:21:" + watch + " 2:13:" + b + " 3:21:" + bobs);

      // 删用户：他自己的组和组里的关系一起没了，别人的不动。
      await users.deleteUser(3);
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM rule_groups WHERE "userId" = 3'))[0].n), 0);
      assert.equal(await memberRows(), "1:21:" + watch + " 2:13:" + b);

      // 没有任何一行关系指向不存在的规则或组。
      const orphans = await query(
        'SELECT m.id FROM rule_group_members m LEFT JOIN forward_rules r ON r.id = m."ruleId" LEFT JOIN rule_groups g ON g.id = m."groupId" WHERE r.id IS NULL OR g.id IS NULL',
      );
      assert.equal(orphans.length, 0);
    } finally {
      await runtime.closeDatabase();
    }
  `);
});

test("个人分组跟着备份 / 迁移走：导出的快照里有这两张表，导入后关系指向的还是那几条规则", () => {
  runSqliteScript(PRELUDE + String.raw`
    try {
      const migration = await import(url("server/migration.ts"));
      assert.ok(schema.MIGRATION_TABLES.includes("rule_groups"));
      assert.ok(schema.MIGRATION_TABLES.indexOf("rule_groups") < schema.MIGRATION_TABLES.indexOf("rule_group_members"));
      const a = (await groups.savePersonalRuleGroup(alice, { name: "A" })).id;
      const watch = (await groups.savePersonalRuleGroup(admin, { name: "盯着看" })).id;
      await groups.moveRulesToPersonalGroups(alice, [11, 12], [a], "add");
      await groups.moveRulesToPersonalGroups(admin, [11], [watch], "add");

      const snapshot = await migration.exportMigrationSnapshot(undefined, { dataScope: "essential" });
      assert.equal(snapshot.tables.rule_groups.length, 2);
      assert.equal(snapshot.tables.rule_group_members.length, 3);

      // 清空再导回来（恢复模式）：组、关系都回来，没有被当成「没导进来的关键数据」。
      for (const table of [...schema.MIGRATION_TABLES].reverse()) await exec('DELETE FROM "' + table + '"');
      const result = await migration.importMigrationSnapshot(snapshot);
      assert.equal(result.skipped?.rule_groups || 0, 0);
      assert.equal(result.skipped?.rule_group_members || 0, 0);
      // 用户导进来会拿到新的 id，关系和组上的 userId 得跟着映射过去 —— 按用户名和组名对。
      const restored = (await query(
        'SELECT u.username AS username, m."ruleId" AS "ruleId", g.name AS "groupName", gu.username AS "groupOwner"'
          + ' FROM rule_group_members m INNER JOIN users u ON u.id = m."userId"'
          + ' INNER JOIN rule_groups g ON g.id = m."groupId" INNER JOIN users gu ON gu.id = g."userId"'
          + ' INNER JOIN forward_rules r ON r.id = m."ruleId"'
          + ' ORDER BY u.username, m."ruleId"',
      )).map((row) => [row.username, Number(row.ruleId), row.groupName, row.groupOwner].join(":")).join(" ");
      assert.equal(restored, "admin:11:盯着看:admin alice:11:A:alice alice:12:A:alice");
      const aliceId = Number((await query("SELECT id FROM users WHERE username = 'alice'"))[0].id);
      assert.deepEqual((await pageIds({ ownerUserId: aliceId, personalGroupOwnerId: aliceId, personalGroupId: 0 })), [13]);
    } finally {
      await runtime.closeDatabase();
    }
  `);
});
