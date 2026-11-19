import assert from "node:assert/strict";
import test from "node:test";
import {
  PANEL_LEASE_RENEW_INTERVAL_MS,
  PANEL_LEASE_TTL_MS,
  PanelLease,
  describePanelBackgroundLease,
  type PanelLeaseRecord,
  type PanelLeaseStore,
} from "./panelLease";
import { createNonOverlappingScheduledTask } from "./scheduledTask";

/*
  后台任务租约的规矩（server/panelLease.ts），用假时钟和内存里的表跑：
  - 同一时刻只有一个实例是持有者，只有它跑「只由持有者跑」的任务；
  - 持有者不再续约后，另一个实例最迟在 TTL + 一个续约间隔内接手；
  - 持有者续不上时，在别人能接手之前自己先停手（不会两边同时跑）；
  - 正常退出放掉租约，下一轮续约就接手。
*/

class MemoryLeaseStore implements PanelLeaseStore {
  readonly rows = new Map<string, PanelLeaseRecord>();
  failing = false;

  private check() {
    if (this.failing) throw new Error("database unavailable");
  }

  async tryAcquire(name: string, holder: string, now: number, ttlMs: number) {
    this.check();
    const row = this.rows.get(name);
    if (row && row.holder !== holder && row.expiresAt > now) return false;
    this.rows.set(name, { name, holder, expiresAt: now + ttlMs, updatedAt: now });
    return true;
  }

  async read(name: string) {
    this.check();
    return this.rows.get(name) ?? null;
  }

  async list(prefix: string) {
    this.check();
    return Array.from(this.rows.values()).filter((row) => row.name.startsWith(prefix));
  }

  async release(name: string, holder: string) {
    this.check();
    if (this.rows.get(name)?.holder === holder) this.rows.delete(name);
  }

  async prune(prefix: string, before: number) {
    this.check();
    let removed = 0;
    for (const [name, row] of this.rows) {
      if (name.startsWith(prefix) && row.expiresAt < before) {
        this.rows.delete(name);
        removed += 1;
      }
    }
    return removed;
  }
}

const quiet = { info: () => {}, warn: () => {} };

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function makeLease(store: PanelLeaseStore, clock: { now: () => number }, instanceId: string) {
  // 定时器交给测试手动推进：tick() 由测试按续约间隔调用。
  return new PanelLease({
    store,
    instanceId,
    now: clock.now,
    setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
    logger: quiet,
  });
}

test("两个实例抢同一个租约：只有一个是持有者，另一个知道是谁在跑", async () => {
  const store = new MemoryLeaseStore();
  const clock = makeClock();
  const a = makeLease(store, clock, "aaaa");
  const b = makeLease(store, clock, "bbbb");
  await a.start();
  await b.start();
  assert.equal(a.isHolder(), true);
  assert.equal(b.isHolder(), false);
  assert.equal(b.status().holderId, "aaaa");
  assert.equal(b.status().role, "standby");
  assert.deepEqual(a.status().otherInstanceIds, [], "A 续第一轮时 B 还没登记");
  await a.tick();
  assert.deepEqual(a.status().otherInstanceIds, ["bbbb"]);
  assert.equal(a.hasOtherInstances(), true);
  assert.match(describePanelBackgroundLease(b.status()), /另一实例 aaaa/);
  assert.match(describePanelBackgroundLease(a.status()), /本实例执行/);

  // 几轮续约之后仍然是 A
  for (let round = 0; round < 6; round += 1) {
    clock.advance(PANEL_LEASE_RENEW_INTERVAL_MS);
    await a.tick();
    await b.tick();
    assert.equal(a.isHolder(), true);
    assert.equal(b.isHolder(), false);
  }
});

test("持有者不再续约：另一个实例在 TTL + 一个续约间隔内接手，期间从不两边同时是持有者", async () => {
  const store = new MemoryLeaseStore();
  const clock = makeClock();
  const a = makeLease(store, clock, "aaaa");
  const b = makeLease(store, clock, "bbbb");
  await a.start();
  await b.start();
  const lastRenewAt = clock.now();
  // A 卡死（不再 tick），B 照常每 10 秒续一次
  let takeoverAt: number | null = null;
  for (let elapsed = 0; elapsed <= PANEL_LEASE_TTL_MS + 2 * PANEL_LEASE_RENEW_INTERVAL_MS; elapsed += 1_000) {
    if (elapsed > 0) clock.advance(1_000);
    if (elapsed % PANEL_LEASE_RENEW_INTERVAL_MS === 0 && elapsed > 0) await b.tick();
    assert.ok(!(a.isHolder() && b.isHolder()), `t=${elapsed} 两边同时是持有者`);
    if (b.isHolder() && takeoverAt === null) takeoverAt = clock.now();
  }
  assert.ok(takeoverAt !== null, "B 没接手");
  assert.ok(takeoverAt! - lastRenewAt <= PANEL_LEASE_TTL_MS + PANEL_LEASE_RENEW_INTERVAL_MS, `接手用了 ${takeoverAt! - lastRenewAt}ms`);
  assert.ok(takeoverAt! - lastRenewAt >= PANEL_LEASE_TTL_MS, "到期之前就被抢走了");
  assert.equal(a.isHolder(), false, "A 自己的有效期也过了");

  // A 醒过来再续：抢不回来
  await a.tick();
  assert.equal(a.isHolder(), false);
  assert.equal(a.status().holderId, "bbbb");
});

test("持有者续不上（库连不上）：在别人能接手之前自己先停手", async () => {
  const store = new MemoryLeaseStore();
  const clock = makeClock();
  const a = makeLease(store, clock, "aaaa");
  const changes: boolean[] = [];
  a.onChange((holder) => changes.push(holder));
  await a.start();
  assert.equal(a.isHolder(), true);
  const expiresAt = store.rows.get("background")!.expiresAt;
  store.failing = true;
  clock.advance(PANEL_LEASE_RENEW_INTERVAL_MS);
  await a.tick();
  assert.equal(a.isHolder(), true, "一次续不上不马上停");
  clock.advance(PANEL_LEASE_RENEW_INTERVAL_MS);
  await a.tick();
  clock.advance(PANEL_LEASE_RENEW_INTERVAL_MS - 4_000);
  assert.ok(clock.now() < expiresAt, "还没到库里的到期时刻");
  assert.equal(a.isHolder(), false, "到期前 5 秒自己停手");
  await a.tick();
  assert.deepEqual(changes, [true, false]);
  assert.match(a.status().lastError || "", /database unavailable/);
  // 库恢复：自己那一行还在（或已过期），续上
  store.failing = false;
  clock.advance(PANEL_LEASE_RENEW_INTERVAL_MS);
  await a.tick();
  assert.equal(a.isHolder(), true);
  assert.deepEqual(changes, [true, false, true]);
});

test("正常退出放掉租约：另一个实例下一轮续约就接手", async () => {
  const store = new MemoryLeaseStore();
  const clock = makeClock();
  const a = makeLease(store, clock, "aaaa");
  const b = makeLease(store, clock, "bbbb");
  await a.start();
  await b.start();
  await a.stop({ release: true });
  assert.equal(a.isHolder(), false);
  assert.equal(store.rows.has("background"), false);
  assert.equal(store.rows.has("instance:aaaa"), false);
  clock.advance(1_000);
  await b.tick();
  assert.equal(b.isHolder(), true);
  assert.equal(b.hasOtherInstances(), false);
});

test("只由持有者跑的定时任务：两个实例各起一份，每一轮只跑一次；换了持有者也只跑一次", async () => {
  const store = new MemoryLeaseStore();
  const clock = makeClock();
  const a = makeLease(store, clock, "aaaa");
  const b = makeLease(store, clock, "bbbb");
  await a.start();
  await b.start();
  const writes: string[] = [];
  const sweepFor = (lease: PanelLease) => createNonOverlappingScheduledTask(
    `ddns sweep ${lease.instanceId}`,
    async () => { writes.push(lease.instanceId); },
    { shouldRun: () => lease.isHolder(), logger: quiet as any },
  );
  const sweepA = sweepFor(a);
  const sweepB = sweepFor(b);
  for (let round = 0; round < 3; round += 1) {
    await sweepA();
    await sweepB();
  }
  assert.deepEqual(writes, ["aaaa", "aaaa", "aaaa"]);

  // A 卡住不再续约（不放租约）：它在自己的有效期里照跑，过了有效期谁都不跑，B 接手后只有 B 跑；每一轮最多一个实例跑
  writes.length = 0;
  const perRound: string[][] = [];
  for (let elapsed = PANEL_LEASE_RENEW_INTERVAL_MS; elapsed <= PANEL_LEASE_TTL_MS + 2 * PANEL_LEASE_RENEW_INTERVAL_MS; elapsed += PANEL_LEASE_RENEW_INTERVAL_MS) {
    clock.advance(PANEL_LEASE_RENEW_INTERVAL_MS);
    await b.tick();
    const before = writes.length;
    await sweepA();
    await sweepB();
    perRound.push(writes.slice(before));
  }
  assert.ok(perRound.every((round) => round.length <= 1), `同一轮两边都跑了：${JSON.stringify(perRound)}`);
  const firstB = writes.indexOf("bbbb");
  assert.ok(firstB >= 0, "B 接手后要跑");
  assert.ok(writes.slice(firstB).every((id) => id === "bbbb"), `B 接手后还有 A 跑：${writes.join(",")}`);
});

test("没启动租约（单进程 / 测试 / 命令行）：当作持有者", async () => {
  const lease = await import("./panelLease");
  lease.setPanelBackgroundLeaseForTests(null);
  assert.equal(lease.isPanelBackgroundLeaseHolder(), true);
  assert.equal(lease.panelHasOtherLiveInstances(), false);
  assert.equal(lease.panelBackgroundLeaseStatus(), null);
  assert.equal(describePanelBackgroundLease(null), "后台任务由本实例执行");
});
