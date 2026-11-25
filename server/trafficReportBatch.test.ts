import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";
import { DEFAULT_TRAFFIC_REPORT_BATCH_MS, readTrafficReportBatchMs } from "./trafficReportBatch";

/*
  流量上报跨主机攒批提交（server/trafficReportBatch.ts）接到真实的库上（SQLite，设了
  FORWARDX_TEST_DB_KIND=postgresql 时也在 PostgreSQL 上跑一遍）：
  - 一个窗口里的几份上报进同一个事务，回执在提交之后才给；
  - 用户锁按 id 升序拿齐（并集），别人握着中间那个用户的锁时整批等着、后面的锁不先拿；
  - 整批失败后各自单独重跑：坏的那份自己报错，好的照常提交；只有一份时不重试；
  - 关掉攒批 / 调用方已经在事务里时当场应用。
*/

const setup = String.raw`
  const batch = await import(url("server/trafficReportBatch.ts"));
  const locks = await import(url("server/keyedTaskLock.ts"));
  for (const id of [1, 2, 3]) {
    await exec('INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)', [id, "user-" + id, "x", id === 1 ? "admin" : "user"]);
  }
  const insertReport = (hostId, reportId) => exec(
    'INSERT INTO "agent_traffic_reports" ("hostId", "producerId", "reportId", "receivedAt") VALUES (?, ?, ?, ?)',
    [hostId, "producer-" + hostId, reportId, Math.floor(Date.now() / 1000)],
  );
  const reportIds = async () => (await query('SELECT "reportId" FROM "agent_traffic_reports" ORDER BY "reportId"')).map((row) => row.reportId);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const withinSeconds = (label, promise, seconds = 5) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT: " + label + " did not finish in " + seconds + "s")), seconds * 1000)),
  ]);
  const settled = async (promise) => {
    let state = "pending";
    promise.then(() => { state = "resolved"; }, () => { state = "rejected"; });
    await sleep(0);
    return state !== "pending";
  };
`;

test("traffic reports arriving within one window share a transaction and are acknowledged only after commit", () => {
  runInDatabase(String.raw`
    assert.equal(batch.isTrafficReportBatchingEnabled(), true, "默认就开着攒批");
    batch.configureTrafficReportBatcher({ batchMs: 60_000 });
    const transactionsSeen = new Set();
    const applied = [];
    const commit = (hostId, userIds, reportId) => batch.commitTrafficReport({
      hostId,
      userIds,
      apply: async () => {
        assert.equal(runtime.isDatabaseTransactionActive(), true, "apply 在事务里跑");
        // 同一批共用一个事务：前一份插的行这一份在事务里已经看得到
        const seen = await reportIds();
        for (const id of applied) assert.ok(seen.includes(id), "同一事务里看得到 " + id);
        // 这些用户的进程内锁此刻都握在手里
        for (const userId of userIds) assert.equal(locks.keyedTaskDepth(locks.trafficBillingUserLockKey(userId)), 1, "user " + userId + " 的锁已拿到");
        await insertReport(hostId, reportId);
        applied.push(reportId);
        transactionsSeen.add(await runtime.getDb());
      },
    });
    const commits = [commit(11, [1], "a"), commit(12, [2, 1], "b"), commit(13, [], "c")];
    await sleep(50);
    assert.equal(batch.pendingTrafficReportCount(), 3, "窗口没到期：三份都还排着");
    assert.equal(applied.length, 0);
    for (const promise of commits) assert.equal(await settled(promise), false, "没提交前不给回执");

    await batch.flushTrafficReportBatch();
    await withinSeconds("batch commit", Promise.all(commits));
    assert.deepEqual(applied, ["a", "b", "c"], "按到达顺序应用");
    assert.deepEqual(await reportIds(), ["a", "b", "c"]);
    assert.equal(transactionsSeen.size, 1, "三份上报用的是同一个事务连接");
    const stats = batch.getTrafficReportBatcherStats();
    assert.equal(stats.batches, 1);
    assert.equal(stats.batched, 3);
    assert.equal(stats.batchFailures, 0);
    assert.equal(stats.pending, 0);
    for (const userId of [1, 2]) assert.equal(locks.keyedTaskDepth(locks.trafficBillingUserLockKey(userId)), 0, "锁都放掉了");

    // 攒满就提交，不等窗口
    batch.configureTrafficReportBatcher({ batchMs: 60_000, maxReports: 2 });
    const full = [commit(14, [3], "d"), commit(15, [3], "e")];
    await withinSeconds("max-reports flush", Promise.all(full), 5);
    assert.equal(batch.getTrafficReportBatcherStats().batches, 2);
    assert.deepEqual(await reportIds(), ["a", "b", "c", "d", "e"]);
  `, { name: "traffic-report-batch", setup, quiet: true });
});

test("the batch takes every user's billing lock in ascending order and re-enters its own locks", () => {
  runInDatabase(String.raw`
    batch.configureTrafficReportBatcher({ batchMs: 20 });
    const key = (userId) => locks.trafficBillingUserLockKey(userId);
    let releaseUser2;
    const user2Held = new Promise((resolve) => { releaseUser2 = resolve; });
    // 别人正握着用户 2 的锁
    const holder = locks.withTrafficBillingUserLock(2, () => user2Held);
    await sleep(10);
    assert.equal(locks.keyedTaskDepth(key(2)), 1);

    const applied = [];
    const commits = [
      batch.commitTrafficReport({ hostId: 21, userIds: [3, 1], apply: async () => {
        // 批里的用户锁可重入：上报里触发的结算 / 停规则再为同一个用户拿锁不会自己等自己
        const reentered = await withinSeconds("re-entrant lock", locks.withTrafficBillingUserLock(3, async () => "ok"), 3);
        assert.equal(reentered, "ok");
        await insertReport(21, "first");
        applied.push("first");
      } }),
      batch.commitTrafficReport({ hostId: 22, userIds: [2], apply: async () => {
        await insertReport(22, "second");
        applied.push("second");
      } }),
    ];
    await sleep(200);
    // 并集 {1, 2, 3} 按升序拿：1 已拿到，2 排在别人后面等着，3 还没去拿
    assert.equal(applied.length, 0, "用户 2 的锁没放，整批都不动");
    assert.equal(locks.keyedTaskDepth(key(1)), 1, "user 1 的锁已被这批拿到");
    assert.equal(locks.keyedTaskDepth(key(2)), 2, "这批排在用户 2 锁的持有者后面");
    assert.equal(locks.keyedTaskDepth(key(3)), 0, "还没轮到用户 3，不先拿后面的锁");
    for (const promise of commits) assert.equal(await settled(promise), false);

    releaseUser2();
    await holder;
    await withinSeconds("batch after lock release", Promise.all(commits));
    assert.deepEqual(applied, ["first", "second"]);
    assert.deepEqual(await reportIds(), ["first", "second"]);
    for (const userId of [1, 2, 3]) assert.equal(locks.keyedTaskDepth(key(userId)), 0);
    assert.equal(batch.getTrafficReportBatcherStats().batches, 1);
  `, { name: "traffic-report-batch-locks", setup, quiet: true });
});

test("one failing report in a batch is retried alone and does not take the others down", () => {
  runInDatabase(String.raw`
    batch.configureTrafficReportBatcher({ batchMs: 20 });
    const attempts = new Map();
    const count = (name) => attempts.set(name, (attempts.get(name) || 0) + 1);
    const good = (hostId, reportId) => batch.commitTrafficReport({ hostId, userIds: [1], apply: async () => {
      count(reportId);
      await insertReport(hostId, reportId);
    } });
    // 应用层抛错（比如查上下文失败）
    const appFailure = batch.commitTrafficReport({ hostId: 32, userIds: [2], apply: async () => {
      count("app-bad");
      await insertReport(32, "app-bad");
      throw new Error("injected application failure");
    } });
    const results = await withinSeconds("mixed batch", Promise.allSettled([good(31, "ok-1"), appFailure, good(33, "ok-2")]));
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.match(String(results[1].reason?.message), /injected application failure/);
    assert.deepEqual(await reportIds(), ["ok-1", "ok-2"], "坏的那份一行都没留下，好的两份都在");
    // 整批回滚 + 各自单独重跑：坏的那份排在最前（先入队），批里一到它就停，后面两份只在单独重跑时跑了一次
    assert.deepEqual(Object.fromEntries(attempts), { "app-bad": 2, "ok-1": 1, "ok-2": 1 });
    let stats = batch.getTrafficReportBatcherStats();
    assert.equal(stats.batchFailures, 1);
    assert.equal(stats.retriedAlone, 3);

    // 库层面的失败（PostgreSQL 上一条语句出错整个事务作废）：同样整批回滚、各自重跑
    attempts.clear();
    await failWrite("traffic_batch_bad_row", { table: '"agent_traffic_reports"', event: "INSERT", when: 'NEW."reportId" = \'db-bad\'', message: "injected db failure" });
    const dbResults = await withinSeconds("db failure batch", Promise.allSettled([good(34, "ok-3"), good(35, "db-bad"), good(36, "ok-4")]));
    assert.deepEqual(dbResults.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.match(String(dbResults[1].reason?.message), /injected db failure/);
    assert.deepEqual(await reportIds(), ["ok-1", "ok-2", "ok-3", "ok-4"]);
    // 排在坏的前面的那份在批里跑过一次、重跑一次；排在后面的只在重跑时跑
    assert.deepEqual(Object.fromEntries(attempts), { "ok-3": 2, "db-bad": 2, "ok-4": 1 });
    await dropFailWrite("traffic_batch_bad_row", '"agent_traffic_reports"');

    // 只有一份的批：失败直接报错，不重试
    attempts.clear();
    const lone = await Promise.allSettled([batch.commitTrafficReport({ hostId: 37, userIds: [1], apply: async () => {
      count("lone");
      throw new Error("lone failure");
    } })]);
    assert.equal(lone[0].status, "rejected");
    assert.deepEqual(Object.fromEntries(attempts), { lone: 1 });
    stats = batch.getTrafficReportBatcherStats();
    assert.equal(stats.batchFailures, 2);
    assert.equal(stats.pending, 0);
    assert.equal(locks.keyedTaskDepth(locks.trafficBillingUserLockKey(1)), 0);
    assert.equal(locks.keyedTaskDepth(locks.trafficBillingUserLockKey(2)), 0);

    // 用户行不存在：锁行就报 User not found，别的照常
    const missing = await withinSeconds("missing user", Promise.allSettled([good(38, "ok-5"), batch.commitTrafficReport({ hostId: 39, userIds: [999], apply: async () => insertReport(39, "ghost") })]));
    assert.deepEqual(missing.map((result) => result.status), ["fulfilled", "rejected"]);
    assert.match(String(missing[1].reason?.message), /User not found/);
    assert.deepEqual(await reportIds(), ["ok-1", "ok-2", "ok-3", "ok-4", "ok-5"]);
  `, { name: "traffic-report-batch-failure", setup, quiet: true });
});

test("batching off or an enclosing transaction applies the report at once", () => {
  runInDatabase(String.raw`
    batch.configureTrafficReportBatcher({ batchMs: 0 });
    assert.equal(batch.isTrafficReportBatchingEnabled(), false);
    let activeInApply = null;
    await withinSeconds("immediate", batch.commitTrafficReport({ hostId: 41, userIds: [1], apply: async () => {
      activeInApply = runtime.isDatabaseTransactionActive();
      assert.equal(locks.keyedTaskDepth(locks.trafficBillingUserLockKey(1)), 1, "关掉攒批也照样拿用户锁");
      await insertReport(41, "immediate");
    } }));
    assert.equal(activeInApply, true, "照旧在自己的事务里");
    assert.deepEqual(await reportIds(), ["immediate"]);
    assert.equal(batch.getTrafficReportBatcherStats().immediate, 1);
    assert.equal(batch.getTrafficReportBatcherStats().pending, 0);

    // 调用方已经在事务里：不排队，写进它的事务，跟着它回滚
    batch.configureTrafficReportBatcher({ batchMs: 60_000 });
    await assert.rejects(runtime.withDatabaseTransaction(async () => {
      await batch.commitTrafficReport({ hostId: 42, userIds: [2], apply: async () => insertReport(42, "enclosed") });
      assert.equal(batch.pendingTrafficReportCount(), 0, "没有排队");
      assert.deepEqual(await reportIds(), ["enclosed", "immediate"], "写进了调用方的事务");
      throw new Error("roll back the caller");
    }), /roll back the caller/);
    assert.deepEqual(await reportIds(), ["immediate"], "跟着调用方的事务一起回滚了");
    assert.equal(batch.getTrafficReportBatcherStats().immediate, 2);
  `, { name: "traffic-report-batch-inline", setup, quiet: true });
});

test("FORWARDX_TRAFFIC_BATCH_MS parsing", () => {
  assert.equal(readTrafficReportBatchMs({}), DEFAULT_TRAFFIC_REPORT_BATCH_MS);
  assert.equal(readTrafficReportBatchMs({ FORWARDX_TRAFFIC_BATCH_MS: "" }), DEFAULT_TRAFFIC_REPORT_BATCH_MS);
  assert.equal(readTrafficReportBatchMs({ FORWARDX_TRAFFIC_BATCH_MS: "abc" }), DEFAULT_TRAFFIC_REPORT_BATCH_MS);
  assert.equal(readTrafficReportBatchMs({ FORWARDX_TRAFFIC_BATCH_MS: "0" }), 0);
  assert.equal(readTrafficReportBatchMs({ FORWARDX_TRAFFIC_BATCH_MS: "250" }), 250);
  assert.equal(readTrafficReportBatchMs({ FORWARDX_TRAFFIC_BATCH_MS: "-5" }), 0);
  assert.equal(readTrafficReportBatchMs({ FORWARDX_TRAFFIC_BATCH_MS: "99999" }), 5000);
});
