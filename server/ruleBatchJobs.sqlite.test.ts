import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/*
  规则批量任务接上真的单条接口（SQLite）：每一项按单条接口的权限判断，别人的规则逐项失败；
  重启不动暂停的规则、不清统计；账号中途停用整个任务停下。
*/

const setup = String.raw`
  const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
  const { rulesRouter } = await import(url("server/routers/rules.ts"));
  const { ruleBatchJobQueue } = await import(url("server/routers/rules.batchJobs.ts"));
  await exec("INSERT INTO users (id, username, password, role, accountEnabled) VALUES (1, 'admin', 'h', 'admin', 1)");
  await exec("INSERT INTO users (id, username, password, role, accountEnabled) VALUES (2, 'alice', 'h', 'user', 1)");
  await exec("INSERT INTO users (id, username, password, role, accountEnabled) VALUES (3, 'bob', 'h', 'user', 1)");
  await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (10, 'h10', '203.0.113.9', 'tok10', 1)");
  let nextPort = 21000;
  const rule = async (userId, extra = {}) => Number(await rules.createForwardRule({
    hostId: 10, userId, name: "r" + nextPort, forwardType: "realm", protocol: "both",
    sourcePort: nextPort++, targetIp: "127.0.0.1", targetPort: 80, ...extra,
  }));
  const context = (user) => ({ req: { headers: {} }, res: { clearCookie() {}, setHeader() {} }, user, authSession: null, authFailureReason: null });
  const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
  const alice = { id: 2, username: "alice", role: "user", accountEnabled: true };
  const row = async (id) => (await query("SELECT isEnabled, isRunning, pendingDelete, quotaUsedIn, quotaUsedOut FROM forward_rules WHERE id = ?", [id]))[0];
  const runJob = async (caller, input) => {
    const { snapshot, duplicate } = await caller.batchJobStart(input);
    await ruleBatchJobQueue.wait(snapshot.id);
    return { snapshot: (await caller.batchJobStatus({ ids: [snapshot.id] }))[0].job, duplicate, id: snapshot.id };
  };
`;

function runInDatabase(body: string) {
  runSharedDatabaseTest(body, { name: "rule-batch-jobs", setup, quiet: true });
}

test("批量暂停 / 删除逐项走单条接口的权限：别人的规则失败，自己的照常", () => {
  runInDatabase(String.raw`
    const mine = [await rule(2), await rule(2)];
    const bobs = await rule(3);
    const caller = rulesRouter.createCaller(context(alice));
    const paused = await runJob(caller, { operation: "pause", ruleIds: [...mine, bobs], ruleLabels: { [bobs]: "bob 的规则" } });
    assert.equal(paused.snapshot.state, "completed");
    assert.equal(paused.snapshot.succeeded, 2);
    assert.equal(paused.snapshot.failed, 1);
    assert.deepEqual(paused.snapshot.failures.map((f) => [f.ruleId, f.label]), [[bobs, "bob 的规则"]]);
    assert.match(paused.snapshot.failures[0].error, /无权操作此规则/);
    for (const id of mine) assert.equal(Number((await row(id)).isEnabled), 0);
    assert.equal(Number((await row(bobs)).isEnabled), 1, "别人的规则没被动");

    // 别人看不到这个任务
    const bobCaller = rulesRouter.createCaller(context({ id: 3, username: "bob", role: "user", accountEnabled: true }));
    assert.equal((await bobCaller.batchJobStatus({ ids: [paused.id] }))[0].job, null);
    await assert.rejects(() => bobCaller.batchJobStop({ id: paused.id }), /不存在或已过期/);

    const deleted = await runJob(caller, { operation: "delete", ruleIds: [mine[0], bobs] });
    assert.equal(deleted.snapshot.succeeded, 1);
    assert.equal(deleted.snapshot.failed, 1);
    assert.match(deleted.snapshot.failures[0].error, /无权操作此规则/);
    assert.equal(Number((await row(bobs)).pendingDelete || 0), 0);
    assert.ok(!(await row(mine[0])) || Number((await row(mine[0])).pendingDelete) === 1);
  `);
});

test("批量重启：启用的重新下发，暂停的保持暂停，统计不清", () => {
  runInDatabase(String.raw`
    const running = await rule(2);
    const paused = await rule(2);
    await exec("UPDATE forward_rules SET isRunning = 1, quotaUsedIn = 111, quotaUsedOut = 222 WHERE id IN (?, ?)", [running, paused]);
    await exec("UPDATE forward_rules SET isEnabled = 0, disabledByUser = 1 WHERE id = ?", [paused]);
    const caller = rulesRouter.createCaller(context(admin));
    const restarted = await runJob(caller, { operation: "restart", ruleIds: [running, paused] });
    assert.equal(restarted.snapshot.failed, 0, JSON.stringify(restarted.snapshot.failures));
    assert.equal(restarted.snapshot.succeeded, 1);
    assert.equal(restarted.snapshot.skipped, 1);
    const a = await row(running);
    assert.equal(Number(a.isEnabled), 1);
    assert.equal(Number(a.isRunning), 0, "等 Agent 按新下发的配置重新报运行状态");
    assert.equal(Number(a.quotaUsedIn), 111);
    assert.equal(Number(a.quotaUsedOut), 222);
    const b = await row(paused);
    assert.equal(Number(b.isEnabled), 0, "暂停的规则不会被重启顶回启用");
    assert.equal(Number(b.quotaUsedIn), 111);

    // 普通用户重启别人的规则：逐项失败
    const bobs = await rule(3);
    const aliceJob = await runJob(rulesRouter.createCaller(context(alice)), { operation: "restart", ruleIds: [bobs] });
    assert.equal(aliceJob.snapshot.failed, 1);
    assert.match(aliceJob.snapshot.failures[0].error, /无权操作此规则/);
  `);
});

test("提交后账号被停用：任务停下，剩下的记成未执行；只读令牌提交不了", () => {
  runInDatabase(String.raw`
    const ids = [];
    for (let i = 0; i < 30; i += 1) ids.push(await rule(2));
    const caller = rulesRouter.createCaller(context(alice));
    const { snapshot } = await caller.batchJobStart({ operation: "pause", ruleIds: ids });
    await exec("UPDATE users SET accountEnabled = 0 WHERE id = 2");
    await ruleBatchJobQueue.wait(snapshot.id);
    const done = ruleBatchJobQueue.get(2, snapshot.id);
    assert.equal(done.state, "stopped");
    assert.match(done.stopReason, /已停用/);
    assert.ok(done.notRun > 0);
    assert.equal(done.failed, 0);
    assert.equal(done.succeeded + done.notRun, 30);

    const readOnly = rulesRouter.createCaller({ ...context(admin), apiToken: { id: 9, name: "ro", scope: "read", modules: [] } });
    await assert.rejects(() => readOnly.batchJobStart({ operation: "pause", ruleIds: [ids[0]] }), /只读|read/i);
  `);
});
