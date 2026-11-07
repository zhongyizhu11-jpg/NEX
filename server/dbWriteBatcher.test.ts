import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("write batcher: size / time flush, cap, env switch, transactions, shutdown hook", async (t) => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const batcher = await import("./dbWriteBatcher");
  const { databaseHealth } = await import("./databaseHealthState");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-write-batcher-"));
  const databasePath = path.join(directory, "batcher.db");
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: databasePath } });
    await runtime.executeRaw('CREATE TABLE "samples" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "queue" TEXT NOT NULL, "value" INTEGER NOT NULL)');
    const count = async (queue: string) => Number((await runtime.queryRaw<{ n: unknown }>('SELECT COUNT(*) AS "n" FROM "samples" WHERE "queue" = ?', [queue]))[0].n);
    /** 按 id（写入顺序）列出这个队列写进去的值 */
    const values = async (queue: string) => (await runtime.queryRaw<{ value: unknown }>('SELECT "value" FROM "samples" WHERE "queue" = ? ORDER BY "id"', [queue])).map((row) => Number(row.value));
    const insert = (queue: string, rows: number[]) => runtime.executeRaw(
      `INSERT INTO "samples" ("queue", "value") VALUES ${rows.map(() => "(?, ?)").join(", ")}`,
      rows.flatMap((value) => [queue, value]),
    );
    const writerCalls: number[] = [];
    const define = (queue: string, options: { chunkRows?: number } = {}) => batcher.defineBatchedWrite<number>(queue, async (rows) => {
      writerCalls.push(rows.length);
      await insert(queue, rows);
    }, options);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await predicate()) return;
        await sleep(10);
      }
      assert.fail(`timed out waiting for ${what}`);
    };
    const withinMs = <T>(work: Promise<T>, ms: number, what: string) => Promise.race([
      work,
      sleep(ms).then(() => { throw new Error(`${what} did not finish within ${ms}ms`); }),
    ]);

    await t.test("env switch", () => {
      assert.equal(batcher.readWriteBatchMs({}), batcher.DEFAULT_WRITE_BATCH_MS);
      assert.equal(batcher.readWriteBatchMs({ FORWARDX_WRITE_BATCH_MS: "500" }), 500);
      assert.equal(batcher.readWriteBatchMs({ FORWARDX_WRITE_BATCH_MS: "0" }), 0, "0 关掉攒批");
      assert.equal(batcher.readWriteBatchMs({ FORWARDX_WRITE_BATCH_MS: "-5" }), 0);
      assert.equal(batcher.readWriteBatchMs({ FORWARDX_WRITE_BATCH_MS: "abc" }), batcher.DEFAULT_WRITE_BATCH_MS);
      assert.equal(batcher.readWriteBatchMs({ FORWARDX_WRITE_BATCH_MS: "999999" }), 60_000);
      assert.equal(batcher.isWriteBatchingEnabled(), true, "默认开着");
    });

    await t.test("size flush: a queue reaching maxRows is written at once, in one transaction with multi-row inserts", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000, maxRows: 200 });
      const queue = define("size", { chunkRows: 100 });
      writerCalls.length = 0;
      await queue.push(Array.from({ length: 199 }, (_, index) => index));
      assert.equal(batcher.pendingWriteCount("size"), 199);
      assert.equal(await count("size"), 0, "还没到 200 行，不写");
      await queue.push(199);
      await waitFor(async () => (await count("size")) === 200, "size flush");
      assert.equal(batcher.pendingWriteCount("size"), 0);
      assert.deepEqual(writerCalls, [100, 100], "200 行分两条多行 INSERT");
      await queue.push([1000, 1001]);
      await batcher.flushPendingWrites("size");
      assert.deepEqual(writerCalls, [100, 100, 2]);
      assert.equal(await count("size"), 202);
    });

    await t.test("time flush: rows are written after batchMs even when the queue stays small", async () => {
      batcher.configureWriteBatcher({ batchMs: 40, maxRows: 200 });
      const queue = define("time");
      await queue.push(1);
      assert.equal(await count("time"), 0);
      await waitFor(async () => (await count("time")) === 1, "timer flush");
      assert.equal(batcher.pendingWriteCount("time"), 0);
      // 第二轮：定时器重新武装
      await queue.push([2, 3]);
      await waitFor(async () => (await count("time")) === 3, "second timer flush");
    });

    await t.test("flush by name leaves the other queues alone", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000, maxRows: 200 });
      const a = define("only-a");
      const b = define("only-b");
      await a.push(1);
      await b.push(1);
      await a.flush();
      assert.equal(await count("only-a"), 1);
      assert.equal(await count("only-b"), 0);
      assert.equal(batcher.pendingWriteCount("only-b"), 1);
      await batcher.flushPendingWrites();
      assert.equal(await count("only-b"), 1);
    });

    await t.test("a reader waits for its own table's in-flight flush, not for another table's", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000 });
      const slow = batcher.defineBatchedWrite<number>("slow", async (rows) => {
        await sleep(300);
        await insert("slow", rows);
      });
      await slow.push(1);
      const slowFlush = batcher.flushPendingWrites("slow");
      await sleep(30);
      assert.equal(batcher.pendingWriteCount("slow"), 0, "行已经被正在跑的刷新取走");
      const otherStarted = Date.now();
      await batcher.flushPendingWrites("unrelated");
      assert.ok(Date.now() - otherStarted < 100, "别的表没攒东西，不跟着排队");
      await batcher.flushPendingWrites("slow");
      assert.equal(await count("slow"), 1, "同一张表：等正在跑的那次写完才返回");
      await slowFlush;
    });

    await t.test("queue cap drops the oldest rows and keeps the newest", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000, maxRows: 10_000, queueCap: 5 });
      const queue = define("cap");
      const before = batcher.getWriteBatcherStats().dropped;
      await queue.push([1, 2, 3, 4, 5, 6, 7]);
      assert.equal(batcher.pendingWriteCount("cap"), 5);
      assert.equal(batcher.getWriteBatcherStats().dropped - before, 2);
      await queue.flush();
      assert.deepEqual(await values("cap"), [3, 4, 5, 6, 7]);
      batcher.configureWriteBatcher({ maxRows: batcher.WRITE_BATCH_MAX_ROWS, queueCap: batcher.WRITE_BATCH_QUEUE_CAP });
    });

    await t.test("FORWARDX_WRITE_BATCH_MS=0 restores immediate writes", async () => {
      batcher.configureWriteBatcher({ batchMs: 0 });
      assert.equal(batcher.isWriteBatchingEnabled(), false);
      const queue = define("immediate");
      await queue.push([1, 2]);
      assert.equal(batcher.pendingWriteCount("immediate"), 0);
      assert.equal(await count("immediate"), 2, "关掉攒批就是原来的立刻写");
      batcher.configureWriteBatcher({ batchMs: 60_000 });
    });

    await t.test("inside a transaction rows join the caller's transaction, older queued rows first", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000 });
      const queue = define("tx");
      await queue.push([1, 2]);
      await runtime.withDatabaseTransaction(async () => {
        await queue.push(3);
        assert.equal(await count("tx"), 3, "事务里马上可见，排着的旧行也一起写进来了");
      });
      assert.equal(batcher.pendingWriteCount("tx"), 0);
      assert.deepEqual(await values("tx"), [1, 2, 3], "id 跟时间同序：排着的旧行在前");
      await queue.push(4);
      await assert.rejects(runtime.withDatabaseTransaction(async () => {
        await queue.push(5);
        throw new Error("rollback");
      }), /rollback/);
      assert.deepEqual(await values("tx"), [1, 2, 3], "跟着调用方一起回滚（连同搬进去的旧行），不会事后补写");
      assert.equal(batcher.pendingWriteCount("tx"), 0);
    });

    await t.test("a flush inside a transaction does not wait for a background flush queued behind that transaction's lock", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000 });
      const queue = define("deadlock");
      await queue.push([1, 2]);
      let entered!: () => void;
      const enteredTransaction = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const transaction = runtime.withDatabaseTransaction(async () => {
        entered();
        await gate;
        // 删行 / 读最新一条之前的那一下刷新（deleteHost 就在 deleteHostWithChecks 的事务里）
        await batcher.flushPendingWrites("deadlock");
        assert.equal(await count("deadlock"), 2, "排着的行写进了这个事务");
      });
      await enteredTransaction;
      // 事务外起一次后台刷新：它要排队等上面那个事务手里的 SQLite 连接锁
      const background = batcher.flushPendingWrites("deadlock");
      await sleep(30);
      assert.equal(batcher.pendingWriteCount("deadlock"), 2, "等锁的刷新还没把行取走");
      release();
      await withinMs(Promise.all([transaction, background]), 5_000, "transaction + background flush");
      assert.deepEqual(await values("deadlock"), [1, 2], "只写一次");
      assert.equal(batcher.pendingWriteCount("deadlock"), 0);
    });

    await t.test("inside a transaction a failing flush drops the queued rows, a failing push still throws", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000 });
      const broken = batcher.defineBatchedWrite<number>("broken-in-tx", async () => {
        throw new Error("boom");
      });
      const fine = define("fine-in-tx");
      await broken.push([1, 2]);
      const before = batcher.getWriteBatcherStats().dropped;
      await runtime.withDatabaseTransaction(async () => {
        await batcher.flushPendingWrites();
        // 调用方自己的事照常做完
        await fine.push(1);
      });
      assert.equal(batcher.getWriteBatcherStats().dropped - before, 2, "别人排着的行写不进去就丢，不让调用方的事务失败");
      assert.equal(await count("fine-in-tx"), 1);
      await assert.rejects(runtime.withDatabaseTransaction(() => broken.push(3)), /boom/, "调用方自己的行写不进去照常报错");
      assert.equal(batcher.pendingWriteCount(), 0);
    });

    await t.test("a background flush never opens a database by itself", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000 });
      const queue = define("closed");
      await runtime.closeDatabase();
      try {
        await queue.push(1);
        await batcher.flushPendingWrites("closed");
        assert.equal(runtime.getDatabaseKind(), null, "刷新没有自己去连（默认路径的）库");
        assert.equal(batcher.pendingWriteCount("closed"), 1, "行留着，等库连上再写");
      } finally {
        await runtime.connectDatabase({ type: "sqlite", sqlite: { path: databasePath } });
      }
      await batcher.flushPendingWrites("closed");
      assert.equal(await count("closed"), 1);
    });

    await t.test("an unavailable database drops rows with a warning instead of queueing forever", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000 });
      const queue = define("down");
      await queue.push([1, 2]);
      const before = batcher.getWriteBatcherStats().dropped;
      databaseHealth.unavailable(new Error("probe failed"), false, true);
      assert.equal(databaseHealth.isUnavailable(), true);
      try {
        await queue.push(3);
        assert.equal(batcher.pendingWriteCount("down"), 2, "故障期间新来的直接丢");
        await batcher.flushPendingWrites("down");
        assert.equal(batcher.pendingWriteCount("down"), 0, "攒着的也丢掉，不留到恢复后");
        assert.equal(batcher.getWriteBatcherStats().dropped - before, 3);
      } finally {
        databaseHealth.healthy();
      }
      assert.equal(await count("down"), 0);
      await queue.push(4);
      await queue.flush();
      assert.equal(await count("down"), 1, "恢复后照常写");
    });

    await t.test("a failing writer only loses its own queue's batch", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000 });
      const good = define("good");
      const bad = batcher.defineBatchedWrite<number>("bad", async () => {
        throw new Error("boom");
      });
      await good.push([1, 2]);
      await bad.push([1, 2, 3]);
      const before = batcher.getWriteBatcherStats().dropped;
      await batcher.flushPendingWrites();
      assert.equal(await count("good"), 2, "好的那张表照常写进去");
      assert.equal(batcher.getWriteBatcherStats().dropped - before, 3);
      assert.equal(batcher.pendingWriteCount(), 0);
    });

    await t.test("shutdown hook flushes before exit and exits at once when nothing is queued", async () => {
      batcher.configureWriteBatcher({ batchMs: 60_000 });
      const queue = define("shutdown");
      await queue.push([1, 2, 3]);
      const exits: number[] = [];
      const target = Object.assign(new EventEmitter(), { exit: (code?: number) => { exits.push(Number(code ?? 0)); } });
      batcher.installWriteBatcherShutdownHooks(target as unknown as NodeJS.Process, { log: () => {} });
      target.emit("SIGTERM");
      await waitFor(() => exits.length === 1, "exit after flush");
      assert.equal(await count("shutdown"), 3, "退出前把攒着的写掉");
      assert.deepEqual(exits, [0]);
      target.emit("SIGINT");
      await sleep(20);
      assert.equal(exits.length, 1, "只退出一次");

      const idle: number[] = [];
      const idleTarget = Object.assign(new EventEmitter(), { exit: (code?: number) => { idle.push(Number(code ?? 0)); } });
      batcher.installWriteBatcherShutdownHooks(idleTarget as unknown as NodeJS.Process, { log: () => {} });
      idleTarget.emit("SIGINT");
      assert.deepEqual(idle, [0], "没攒东西就直接退");

      await queue.push(4);
      idleTarget.emit("beforeExit");
      await waitFor(async () => (await count("shutdown")) === 4, "beforeExit flush");
    });
    assert.equal(batcher.pendingWriteCount(), 0, "测试没留下没写的行");
  } finally {
    console.warn = originalWarn;
    batcher.configureWriteBatcher({ batchMs: batcher.DEFAULT_WRITE_BATCH_MS, maxRows: batcher.WRITE_BATCH_MAX_ROWS, queueCap: batcher.WRITE_BATCH_QUEUE_CAP });
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
