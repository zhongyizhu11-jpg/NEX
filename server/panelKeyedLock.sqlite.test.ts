import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  跨实例的按 key 串行锁（server/panelKeyedLock.ts，评审 F4）接上真库（SQLite）：
  - 只有一个实例时只是本进程的锁，不碰库；
  - 有别的活着的实例时，在 panel_leases 里占一行 lock:<key>；别的实例占着时等它放掉才跑；
  - 占着的实例没了（不放），那一行按库的时钟过期后别人接着拿。
*/
test("跨实例锁：别的实例占着就等，放掉或过期后才跑；单实例不碰库", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-panel-keyed-lock-"));
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const leaseModule = await import("./panelLease");
  const locks = await import("./panelKeyedLock");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "l.db") } });
    await ensureDatabaseSchema();
    const rows = async () => (await runtime.queryRaw<{ name: string }>('SELECT "name" FROM "panel_leases" WHERE "name" LIKE ?', ["lock:%"])).map((row) => row.name);

    // 单实例：不写库
    leaseModule.setPanelBackgroundLeaseForTests(null);
    let seen: string[] = [];
    await locks.withForwardGroupEditLock(5, async () => { seen = await rows(); });
    assert.deepEqual(seen, []);

    // 两个实例
    let offset = 0;
    const store = new leaseModule.SqlPanelLeaseStore({ clockOffsetMs: () => offset });
    locks.setPanelKeyedLockStoreForTests(store);
    const quiet = { info: () => {}, warn: () => {} };
    const makeLease = (instanceId: string) => new leaseModule.PanelLease({ store, instanceId, logger: quiet, setTimer: (() => ({ unref() {} })) as any, clearTimer: () => {} });
    const a = makeLease("a");
    const b = makeLease("b");
    await a.start();
    await b.start();
    await a.tick();
    leaseModule.setPanelBackgroundLeaseForTests(a);
    assert.equal(leaseModule.panelHasOtherLiveInstances(), true);
    await locks.withForwardGroupEditLock(5, async () => { seen = await rows(); });
    assert.deepEqual(seen, ["lock:forward-group:5"], "有别的实例时要在库里占一行");
    assert.deepEqual(await rows(), [], "跑完放掉");

    // 另一个实例（b）占着评估锁：这边等它放掉
    assert.equal(await store.tryAcquire("lock:forward-group-failover:7", "b:held", locks.PANEL_KEYED_LOCK_TTL_MS), true);
    const order: string[] = [];
    const waiting = locks.withForwardGroupEvaluationLock(7, async () => { order.push("ran"); });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(order.length, 0, "别的实例占着锁时就跑了");
    order.push("released");
    await store.release("lock:forward-group-failover:7", "b:held");
    await waiting;
    assert.deepEqual(order, ["released", "ran"]);

    // 占着的实例没了（不放）：过期后接着拿
    assert.equal(await store.tryAcquire("lock:forward-group-failover:8", "b:dead", locks.PANEL_KEYED_LOCK_TTL_MS), true);
    const late = locks.withForwardGroupEvaluationLock(8, async () => { order.push("ran-after-expiry"); });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(order.includes("ran-after-expiry"), false);
    offset += locks.PANEL_KEYED_LOCK_TTL_MS + 1_000;
    await late;
    assert.equal(order.includes("ran-after-expiry"), true);
    await a.stop({ release: true });
    await b.stop({ release: true });
  } finally {
    locks.setPanelKeyedLockStoreForTests(null);
    leaseModule.setPanelBackgroundLeaseForTests(null);
    await runtime.closeDatabase().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
