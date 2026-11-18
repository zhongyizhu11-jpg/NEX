import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 线路按时间段启用：出口组的第二台机器只在北京时间 20:00-02:00 用。
 * - 存的时候在时段外：实际停着、标「时段停用」；
 * - 定时任务到点恢复，离开时段再停；
 * - 用户自己手动停的，进入时段也不恢复；
 * - 编辑表单把「时段停用」回显成开着，存一次不会变成手动停用。
 */
test("成员可用时段：进出时段自动停用 / 恢复，手动停用不受影响", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-member-schedule-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    console.info = () => {};
    console.warn = () => {};
    const repo = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
    const sweep = await import(moduleUrl("server/forwardGroupMemberSchedule.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    await exec("INSERT INTO hosts (id, name, ip, userId) VALUES (1, 'a', '10.0.0.1', 1), (2, 'b', '10.0.0.2', 1)");
    await exec('INSERT INTO forward_groups (id, name, "groupType", "groupMode", "targetIp", "userId", "isEnabled") VALUES (21, ?, ?, ?, ?, 1, 1)', ["exit", "host", "exit", "0.0.0.0"]);
    const peak = { timezone: "Asia/Shanghai", windows: [{ days: [], from: "20:00", to: "02:00" }] };
    const members = (enabledB = true) => [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: enabledB, activeSchedule: peak },
    ];
    const memberB = async () => (await query('SELECT "isEnabled", "scheduleSuspended", "activeSchedule" FROM forward_group_members WHERE "hostId" = 2'))[0];

    // 现在（真实时间）不一定在时段里：先存，再按「中午」和「晚上」两个时刻跑定时任务。
    await repo.replaceForwardGroupMembers(21, members(), { skipSync: true });
    assert.ok((await memberB()).activeSchedule.includes("20:00"));

    const noon = new Date("2026-10-18T04:00:00Z");
    const evening = new Date("2026-10-18T13:00:00Z");
    await sweep.applyForwardGroupMemberSchedules(noon);
    let b = await memberB();
    assert.equal(Number(b.isEnabled), 0, "中午不在时段里：停");
    assert.equal(Number(b.scheduleSuspended), 1);

    await sweep.applyForwardGroupMemberSchedules(evening);
    b = await memberB();
    assert.equal(Number(b.isEnabled), 1, "晚上进入时段：恢复");
    assert.equal(Number(b.scheduleSuspended), 0);
    const again = await sweep.applyForwardGroupMemberSchedules(evening);
    assert.equal(again.applied, 0, "状态没变就不重写成员");

    // 用户手动停用：进出时段都不碰
    await repo.replaceForwardGroupMembers(21, members(false), { skipSync: true });
    await sweep.applyForwardGroupMemberSchedules(noon);
    await sweep.applyForwardGroupMemberSchedules(evening);
    b = await memberB();
    assert.equal(Number(b.isEnabled), 0);
    assert.equal(Number(b.scheduleSuspended), 0, "手动停用不是时段停用");

    // 不传时段（旧客户端、机器人改成员）：保留原来的时段
    await repo.replaceForwardGroupMembers(21, [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: true },
    ], { skipSync: true });
    assert.ok((await memberB()).activeSchedule, "没传 activeSchedule 不清掉");
    // 清掉时段：一直可用
    await repo.replaceForwardGroupMembers(21, [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: true, activeSchedule: null },
    ], { skipSync: true });
    await sweep.applyForwardGroupMemberSchedules(noon);
    b = await memberB();
    assert.equal(b.activeSchedule, null);
    assert.equal(Number(b.isEnabled), 1);
    console.log("OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "schedule.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runScheduleScript(name: string, script: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `forwardx-member-schedule-${name}-`));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "schedule.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const scheduleScriptHead = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    console.info = () => {};
    console.warn = () => {};
    const repo = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
    const sweep = await import(moduleUrl("server/forwardGroupMemberSchedule.ts"));
    const locks = await import(moduleUrl("server/keyedTaskLock.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const peak = { timezone: "Asia/Shanghai", windows: [{ days: [], from: "20:00", to: "02:00" }] };
    const noon = new Date("2026-10-18T04:00:00Z");
    const evening = new Date("2026-10-18T13:00:00Z");
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const [id, ip] of [[1, "10.0.0.1"], [2, "10.0.0.2"], [3, "10.0.0.3"]]) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, 1, 1, ?)', [id, "h" + id, ip, ip, nowSeconds]);
    }
`;

/*
  P5：定时启停要和组编辑框拿同一把 forward-group:<组> 锁，拿到之后重新读成员。以前不拿锁、用进锁前读的
  成员清单整份写回 —— 用户正好在保存（这里是清掉时段）时，刚保存的改动被旧清单盖掉。
*/
test("定时启停和组编辑互斥：等编辑锁，拿到锁后按最新的成员重算", () => {
  runScheduleScript("lock", scheduleScriptHead + String.raw`
    await exec('INSERT INTO forward_groups (id, name, "groupType", "groupMode", "targetIp", "userId", "isEnabled") VALUES (21, ?, ?, ?, ?, 1, 1)', ["exit", "host", "exit", "0.0.0.0"]);
    await repo.replaceForwardGroupMembers(21, [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: true, activeSchedule: peak },
    ], { skipSync: true, scheduleAt: evening });
    const memberB = async () => (await query('SELECT "isEnabled", "scheduleSuspended", "activeSchedule" FROM forward_group_members WHERE "hostId" = 2'))[0];
    assert.equal(Number((await memberB()).isEnabled), 1);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let sweeping;
    const editing = locks.withKeyedTaskLock("forward-group:21", async () => {
      // 编辑还没保存完，定时任务到点了（中午：按旧清单要把 B 停掉）。
      sweeping = sweep.applyForwardGroupMemberSchedules(noon);
      await sleep(300);
      assert.equal(Number((await memberB()).isEnabled), 1, "编辑锁被占着时定时启停不能先写");
      // 用户这次保存清掉了 B 的时段。
      await repo.replaceForwardGroupMembers(21, [
        { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
        { memberType: "host", hostId: 2, priority: 1, isEnabled: true, activeSchedule: null },
      ], { skipSync: true, scheduleAt: noon });
      await gate;
    });
    await sleep(350);
    release();
    await editing;
    const result = await sweeping;
    assert.equal(result.applied, 0, "拿到锁后重读：时段已经清了，没有要动的");
    const b = await memberB();
    assert.equal(Number(b.isEnabled), 1, "刚保存的「一直可用」不能被旧清单盖掉");
    assert.equal(b.activeSchedule, null);
    console.log("OK");
  `);
});

/*
  P5：换成员是「删掉去掉的 + 写入新的」，以前一条条直接写，中途失败留下半份成员。这里用触发器让第三台
  写入失败：整份回滚，原来的两个成员都还在。
*/
test("换成员是一个事务：中途失败整份回滚，不留半份成员", () => {
  runScheduleScript("transaction", scheduleScriptHead + String.raw`
    await exec('INSERT INTO forward_groups (id, name, "groupType", "groupMode", "targetIp", "userId", "isEnabled") VALUES (22, ?, ?, ?, ?, 1, 1)', ["exit", "host", "exit", "0.0.0.0"]);
    await repo.replaceForwardGroupMembers(22, [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: true },
    ], { skipSync: true });
    await exec('CREATE TRIGGER fail_member_insert BEFORE INSERT ON forward_group_members WHEN NEW."hostId" = 3 BEGIN SELECT RAISE(ABORT, \'boom\'); END');
    await assert.rejects(repo.replaceForwardGroupMembers(22, [
      { memberType: "host", hostId: 2, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 3, priority: 1, isEnabled: true },
    ], { skipSync: true }));
    const rows = await query('SELECT "hostId", priority FROM forward_group_members WHERE "groupId" = 22 ORDER BY priority');
    assert.deepEqual(rows.map((row) => [Number(row.hostId), Number(row.priority)]), [[1, 0], [2, 1]], "失败后成员原样不动");
    console.log("OK");
  `);
});

/*
  P4：主备组的活动成员被定时停用后要马上换走。以前定时启停只同步子规则、不评估，解析还指着停用的成员；
  评估了也要等「异常多久切」（这里 600 秒）。停用是管理动作，不等。
*/
test("主备组：活动成员到点停用后立刻评估并换到下一个成员，不等故障观察时间", () => {
  runScheduleScript("evaluate", scheduleScriptHead + String.raw`
    await exec(
      'INSERT INTO forward_groups (id, name, "groupType", "groupMode", domain, "recordType", "targetIp", "userId", "isEnabled", "failoverSeconds", "recoverSeconds", "autoFailback") VALUES (30, ?, ?, ?, ?, ?, ?, 1, 1, 600, 600, 1)',
      ["failover", "host", "failover", "sched.example.test", "A", "0.0.0.0"],
    );
    await repo.replaceForwardGroupMembers(30, [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true, activeSchedule: peak },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: true },
    ], { skipSync: true, scheduleAt: evening });
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (300, 1, ?, ?, ?, 30, 1, 16000, ?, 80, 1, 1, 0)',
      ["template", "iptables", "tcp", "203.0.113.10"],
    );
    await repo.syncForwardGroupRules(30);
    const markHealthy = async () => {
      const children = await query('SELECT id, "hostId" FROM forward_rules WHERE "forwardGroupRuleId" = 300 AND "pendingDelete" = 0 AND "isEnabled" = 1');
      for (const child of children) {
        await exec('UPDATE forward_rules SET "isRunning" = 1 WHERE id = ?', [child.id]);
        await exec(
          'INSERT INTO tcping_stats ("ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt") VALUES (?, ?, 10, 0, ?, 0, ?)',
          [child.id, child.hostId, "healthy", Math.floor(Date.now() / 1000)],
        );
      }
      return children.length;
    };
    assert.equal(await markHealthy(), 2);
    await repo.runForwardGroupFailover(30);
    const members = await query('SELECT id, "hostId" FROM forward_group_members WHERE "groupId" = 30 ORDER BY priority');
    const active = async () => Number((await query('SELECT "activeMemberId" FROM forward_groups WHERE id = 30'))[0].activeMemberId);
    assert.equal(await active(), Number(members[0].id), "两个都健康：活动成员是第一个");

    const result = await sweep.applyForwardGroupMemberSchedules(noon);
    assert.equal(result.applied, 1);
    await markHealthy();
    const deadline = Date.now() + 5000;
    while (await active() !== Number(members[1].id) && Date.now() < deadline) await sleep(50);
    const debug = JSON.stringify({
      group: await query('SELECT "activeMemberId", "lastStatus", "lastMessage" FROM forward_groups WHERE id = 30'),
      members: await query('SELECT id, "hostId", "isEnabled", "healthStatus" FROM forward_group_members WHERE "groupId" = 30'),
      rules: await query('SELECT id, "hostId", "isEnabled", "isRunning", "pendingDelete", "forwardGroupMemberId" FROM forward_rules'),
    });
    assert.equal(await active(), Number(members[1].id), "活动成员被停用：不等 600 秒，马上换到第二个 " + debug);
    console.log("OK");
  `);
});
