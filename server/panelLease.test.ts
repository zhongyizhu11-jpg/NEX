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

/** 内存里的表；「库的时钟」是 databaseClock（不传就用各实例共用的测试时钟）。 */
class MemoryLeaseStore implements PanelLeaseStore {
  readonly rows = new Map<string, PanelLeaseRecord>();
  failing = false;
  databaseClock: () => number = () => sharedClock.now();

  private check() {
    if (this.failing) throw new Error("database unavailable");
  }

  async now() {
    this.check();
    return this.databaseClock();
  }

  async tryAcquire(name: string, holder: string, ttlMs: number) {
    this.check();
    const now = this.databaseClock();
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

  async prune(prefix: string, olderThanMs: number) {
    this.check();
    const before = this.databaseClock() - olderThanMs;
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
const sharedClock = { now: () => Date.now() };

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  sharedClock.now = clock.now;
  return clock;
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

/*
  续约排期（评审 F5）：下一轮续约按「这次续上的有效期」排，不按「上一轮结束后再等一个间隔」。库慢、一次续约
  卡了十几秒时，以前下一轮排在有效期之后，中间有一段谁都不是持有者（后台任务停了又起）；续约一直卡着不回时，
  丢了持有也要等那一轮结束才说出来。
  这里的假定时器按到点时刻逐个跑；库的时钟就是测试时钟，tryAcquire 慢的时候把时钟往前拨。
  （改之前的版本跑这两条时用的是一个兼容旧签名的假库，两条都不过。）
*/
class FakeTimers {
  private timers: Array<{ due: number; callback: () => void; cancelled: boolean }> = [];
  constructor(private clock: { now: () => number; set: (ms: number) => void }) {}
  setTimer = (callback: () => void, delayMs: number) => {
    const timer = { due: this.clock.now() + Math.max(0, delayMs), callback, cancelled: false };
    this.timers.push(timer);
    return { unref() {}, timer } as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimer = (handle: ReturnType<typeof setTimeout>) => {
    const timer = (handle as unknown as { timer?: { cancelled: boolean } }).timer;
    if (timer) timer.cancelled = true;
  };
  /** 跑到 until 为止：每个定时器到点时先调 beforeFire（看那一刻的状态），再跑它，等它的异步链走完。 */
  async runUntil(until: number, beforeFire: (at: number) => void = () => {}) {
    for (;;) {
      const next = this.timers.filter((timer) => !timer.cancelled && timer.due <= until).sort((left, right) => left.due - right.due)[0];
      if (!next) break;
      next.cancelled = true;
      if (next.due > this.clock.now()) this.clock.set(next.due);
      beforeFire(next.due);
      next.callback();
      for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    if (until > this.clock.now()) this.clock.set(until);
  }
}

class SlowLeaseStore extends MemoryLeaseStore {
  slowMs = 0;
  hang: Promise<void> | null = null;
  constructor(clock: { now: () => number; set: (ms: number) => void }) {
    super();
    this.databaseClock = clock.now;
    this.advance = (ms) => clock.set(clock.now() + ms);
  }
  private readonly advance: (ms: number) => void;
  override async tryAcquire(name: string, holder: string, ttlMs: number) {
    if (name === "background" && this.hang) await this.hang;
    if (name === "background" && this.slowMs > 0) this.advance(this.slowMs);
    return super.tryAcquire(name, holder, ttlMs);
  }
}

function settableClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, set: (ms: number) => { now = ms; } };
}

test("库慢、每次续约都卡十几秒：下一轮按有效期提前续，持有从不中断", async () => {
  const clock = settableClock();
  const timers = new FakeTimers(clock);
  const store = new SlowLeaseStore(clock);
  const lease = new PanelLease({ store, instanceId: "aaaa", now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, logger: quiet });
  const changes: boolean[] = [];
  lease.onChange((holder) => changes.push(holder));
  await lease.start();
  const startedAt = clock.now();
  store.slowMs = 16_000;
  const gaps: number[] = [];
  await timers.runUntil(startedAt + 120_000, (at) => { if (!lease.isHolder()) gaps.push(at - startedAt); });
  assert.deepEqual(gaps, [], `这些时刻不是持有者：${gaps.join(",")}`);
  assert.equal(lease.isHolder(), true);
  assert.deepEqual(changes, [true], "持有状态一次都没翻");
});

test("续约一直卡着不回：到有效期那一刻就说「不再持有」，不等那一轮结束", async () => {
  const clock = settableClock();
  const timers = new FakeTimers(clock);
  const store = new SlowLeaseStore(clock);
  const lease = new PanelLease({ store, instanceId: "aaaa", now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, logger: quiet });
  const changes: Array<[boolean, number]> = [];
  lease.onChange((holder) => changes.push([holder, clock.now()]));
  await lease.start();
  const startedAt = clock.now();
  let release!: () => void;
  store.hang = new Promise<void>((resolve) => { release = resolve; });
  await timers.runUntil(startedAt + PANEL_LEASE_TTL_MS);
  assert.equal(lease.isHolder(), false);
  assert.deepEqual(changes.map(([holder]) => holder), [true, false], "卡着的续约还没回，丢了持有也要马上说");
  const lostAt = changes[1][1];
  assert.ok(lostAt <= startedAt + PANEL_LEASE_TTL_MS - 5_000, `丢了持有 ${lostAt - startedAt}ms 后才说`);
  // 库恢复：那一轮回来、接着续上
  store.hang = null;
  release();
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
  await timers.runUntil(clock.now() + 2 * PANEL_LEASE_RENEW_INTERVAL_MS);
  assert.equal(lease.isHolder(), true);
  assert.deepEqual(changes.map(([holder]) => holder), [true, false, true]);
});

test("各实例的时钟差几十秒：快的那个也抢不走还在有效期里的租约（过期按库的时钟算）", async () => {
  const store = new MemoryLeaseStore();
  const databaseClock = makeClock();
  store.databaseClock = databaseClock.now;
  const a = makeLease(store, databaseClock, "aaaa");
  // B 的时钟快 40 秒（比 TTL 还多）
  const b = makeLease(store, { now: () => databaseClock.now() + 40_000 }, "bbbb");
  await a.start();
  await b.start();
  for (let round = 0; round < 6; round += 1) {
    databaseClock.advance(PANEL_LEASE_RENEW_INTERVAL_MS);
    await a.tick();
    await b.tick();
    assert.equal(a.isHolder(), true);
    assert.equal(b.isHolder(), false, "时钟快的实例把租约抢走了");
  }
});
