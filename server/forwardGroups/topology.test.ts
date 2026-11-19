import assert from "node:assert/strict";
import test from "node:test";
import { ForwardGroupPublishQueue, ddnsProviderAccountKey } from "./publish";
import { markForwardGroupPanelReady, setForwardGroupPanelReadyAtForTests, staleSampleWithinReadinessGrace, forwardGroupPanelReadyAt } from "./readiness";
import { TopologyCache, parsePeerObserverHostIds, planPeerObservers, selectPeerProbePorts, serializePeerObserverHostIds } from "./topology";

test("拓扑缓存：没过期只建一次，并发只建一次，作废后重建", async () => {
  let now = 1_000;
  let builds = 0;
  const cache = new TopologyCache(async () => { builds += 1; return { version: builds }; }, 30_000, () => now);
  const [first, second] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(builds, 1);
  assert.equal(first, second);
  now += 29_000;
  assert.equal((await cache.get()).version, 1);
  now += 2_000;
  assert.equal((await cache.get()).version, 2, "TTL 到了重建");
  cache.invalidate();
  assert.equal(cache.peek(), null);
  assert.equal((await cache.get()).version, 3, "作废后重建");
});

test("拓扑缓存：建的过程中被作废，那一份不留在缓存里", async () => {
  let release!: () => void;
  let builds = 0;
  const cache = new TopologyCache(async () => {
    builds += 1;
    const mine = builds;
    if (mine === 1) await new Promise<void>((resolve) => { release = resolve; });
    return mine;
  }, 30_000);
  const stale = cache.get();
  await new Promise((resolve) => setImmediate(resolve));
  cache.invalidate();
  const fresh = cache.get();
  release();
  assert.equal(await stale, 1, "已经在等的调用方拿到它那一份");
  assert.equal(await fresh, 2, "作废之后来的重新建");
  assert.equal(cache.peek(), 2);
});

test("探哪些端口：TCP 优先，同端口的 UDP 让给 TCP，最多三个", () => {
  assert.deepEqual(
    selectPeerProbePorts([
      { port: 8443, protocol: "both" },
      { port: 443, protocol: "tcp" },
      { port: 443, protocol: "udp" },
      { port: 5353, protocol: "udp" },
      { port: 0, protocol: "tcp" },
      { port: 9000, protocol: "tcp" },
      { port: 9001, protocol: "tcp" },
    ]),
    [{ port: 443, method: "tcp" }, { port: 8443, method: "tcp" }, { port: 9000, method: "tcp" }],
  );
  // 只有 UDP 规则：探 UDP（Agent 端说不准时退回 ping）
  assert.deepEqual(selectPeerProbePorts([{ port: 5353, protocol: "udp" }]), [{ port: 5353, method: "udp" }]);
});

const member = (memberId: number, hostId: number, patch: Record<string, unknown> = {}) => ({
  memberId,
  hostId,
  enabled: true,
  targetIp: `198.51.100.${hostId}`,
  ports: [{ port: 443, method: "tcp" as const }],
  ...patch,
});

test("观察点：先用同组别的成员（轮着取），不够再用指定的主机，每个成员最多三个", () => {
  const members = [member(101, 1), member(102, 2), member(103, 3), member(104, 4), member(105, 5)];
  const plan = planPeerObservers({ members, capableHostIds: new Set([1, 2, 3, 4, 5]), explicitObservers: [{ hostId: 9, capable: true }] });
  assert.deepEqual(plan.find((entry) => entry.memberId === 101)?.observerHostIds, [2, 3, 4]);
  assert.deepEqual(plan.find((entry) => entry.memberId === 104)?.observerHostIds, [5, 1, 2]);
  // 每台机器当观察点的次数一样多
  const load = new Map<number, number>();
  for (const entry of plan) for (const hostId of entry.observerHostIds) load.set(hostId, (load.get(hostId) || 0) + 1);
  assert.deepEqual([...load.values()], [3, 3, 3, 3, 3]);
});

test("观察点：Agent 太旧的不算，成员自己不探自己，没地址没端口的成员不探", () => {
  const plan = planPeerObservers({
    members: [member(101, 1), member(102, 2), member(103, 3, { ports: [] }), member(104, 4, { targetIp: "" }), member(105, 5, { enabled: false })],
    capableHostIds: new Set([1, 3, 4]),
    explicitObservers: [{ hostId: 1, capable: true }, { hostId: 8, capable: false }, { hostId: 9, capable: true }],
  });
  assert.deepEqual(plan.map((entry) => entry.memberId), [101, 102]);
  // 成员 101（主机 1）：同组能用的是 3、4；指定的 1 是它自己，8 太旧，9 可以
  assert.deepEqual(plan[0].observerHostIds, [3, 4, 9]);
  assert.deepEqual(plan[1].observerHostIds, [3, 4, 1]);
  // 单成员组：只有指定了观察主机才探
  assert.deepEqual(planPeerObservers({ members: [member(1, 1)], capableHostIds: new Set([1]) }), []);
  assert.deepEqual(planPeerObservers({ members: [member(1, 1)], capableHostIds: new Set([1]), explicitObservers: [{ hostId: 9, capable: true }] })[0].observerHostIds, [9]);
});

test("指定的观察主机清单：规整、去重、最多八台", () => {
  assert.deepEqual(parsePeerObserverHostIds("[3, 3, \"5\", 0, -1, 2.5]"), [3, 5]);
  assert.deepEqual(parsePeerObserverHostIds("7,8"), [7, 8]);
  assert.deepEqual(parsePeerObserverHostIds(null), []);
  assert.equal(serializePeerObserverHostIds([]), null);
  assert.equal(serializePeerObserverHostIds([1, 2, 3, 4, 5, 6, 7, 8, 9]), "[1,2,3,4,5,6,7,8]");
});

function manualTimers() {
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  let now = 0;
  return {
    setTimer: (run: () => void, delayMs: number) => {
      const timer = { at: now + delayMs, run, cancelled: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => { (timer as unknown as { cancelled: boolean }).cancelled = true; },
    advance: (ms: number) => {
      now += ms;
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) continue;
        if (timer.at <= now) timer.run();
        else timers.push(timer);
      }
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("发布队列：一个账号慢不拖别的账号，同账号并发有上限", async () => {
  const started: number[] = [];
  const releases = new Map<number, () => void>();
  const queue = new ForwardGroupPublishQueue((groupId) => {
    started.push(groupId);
    return new Promise<void>((resolve) => { releases.set(groupId, resolve); });
  }, { concurrency: 2 });
  for (const groupId of [1, 2, 3]) queue.enqueue("slow", groupId);
  queue.enqueue("fast", 10);
  await tick();
  assert.deepEqual(started, [1, 2, 10], "慢账号最多同时跑两个，另一个账号不用等");
  releases.get(1)!();
  await tick();
  assert.deepEqual(started, [1, 2, 10, 3]);
  for (const release of releases.values()) release();
  await queue.whenIdle();
  assert.equal(queue.pending(), 0);
});

test("发布队列：同一个组只排一份，跑的时候又来一次就跑完再来一遍", async () => {
  let runs = 0;
  let release!: () => void;
  const queue = new ForwardGroupPublishQueue(() => {
    runs += 1;
    return new Promise<void>((resolve) => { release = resolve; });
  }, { concurrency: 1 });
  queue.enqueue("a", 1);
  queue.enqueue("a", 2);
  queue.enqueue("a", 2);
  queue.enqueue("a", 2);
  await tick();
  assert.equal(runs, 1);
  // 组 1 正在跑的时候又来了两次：只再跑一次
  queue.enqueue("a", 1);
  queue.enqueue("a", 1);
  release();
  await tick();
  assert.equal(runs, 2, "组 2 排着的三次只跑一次");
  release();
  await tick();
  assert.equal(runs, 3, "组 1 跑完再来一遍");
  release();
  await queue.whenIdle();
  assert.equal(runs, 3);
});

test("发布队列：失败按退避重试，成功后清零；等重试时来了新结论马上再试", async () => {
  const timers = manualTimers();
  const delays: number[] = [];
  let failures = 3;
  let runs = 0;
  const queue = new ForwardGroupPublishQueue(async () => {
    runs += 1;
    if (failures > 0) {
      failures -= 1;
      throw new Error("provider down");
    }
  }, { retryBaseMs: 1_000, retryMaxMs: 3_000, setTimer: timers.setTimer, clearTimer: timers.clearTimer, onError: (_error, context) => delays.push(context.retryDelayMs) });
  queue.enqueue("a", 1);
  await tick();
  assert.deepEqual(delays, [1_000]);
  timers.advance(1_000);
  await tick();
  assert.deepEqual(delays, [1_000, 2_000]);
  // 还在等 2 秒的重试：新的评估结论来了，不等定时器
  queue.enqueue("a", 1);
  await tick();
  assert.deepEqual(delays, [1_000, 2_000, 3_000], "退避封顶 3 秒");
  assert.equal(runs, 3);
  timers.advance(3_000);
  await tick();
  assert.equal(runs, 4);
  await queue.whenIdle();
  assert.equal(queue.isPending(1), false);
});

test("服务商账号的键：同一个账号同一个键，密钥不出现在键里", () => {
  const tencent = ddnsProviderAccountKey({ provider: "tencentcloud", tencentcloudSecretId: "AKIDexample" });
  assert.equal(tencent, ddnsProviderAccountKey({ provider: "tencentcloud", tencentcloudSecretId: "AKIDexample" }));
  assert.notEqual(tencent, ddnsProviderAccountKey({ provider: "tencentcloud", tencentcloudSecretId: "AKIDother" }));
  assert.notEqual(tencent, ddnsProviderAccountKey({ provider: "aliyun", aliyunAccessKeyId: "AKIDexample" }));
  assert.ok(!tencent.includes("AKIDexample"));
  assert.match(ddnsProviderAccountKey({ provider: "cloudflare", cloudflareApiToken: "secret-token" }), /^cloudflare:[0-9a-f]{12}$/);
});

test("就绪时刻：只记第一次，数据库恢复强制重记；旧样本在宽限里不算过期", () => {
  setForwardGroupPanelReadyAtForTests(0);
  try {
    assert.equal(staleSampleWithinReadinessGrace(1, 10_000), false, "没记过就绪时宽限不生效");
    assert.equal(markForwardGroupPanelReady(100_000), 100_000);
    assert.equal(markForwardGroupPanelReady(200_000), 100_000, "调度器重试不把宽限往后推");
    assert.equal(markForwardGroupPanelReady(300_000, { force: true }), 300_000, "数据库恢复重新给一段宽限");
    assert.equal(forwardGroupPanelReadyAt(), 300_000);
    assert.equal(staleSampleWithinReadinessGrace(250_000, 310_000), true, "就绪之前的样本：还在等新样本");
    assert.equal(staleSampleWithinReadinessGrace(305_000, 310_000), false, "就绪之后的样本照常判");
    assert.equal(staleSampleWithinReadinessGrace(250_000, 300_000 + 150_000), false, "宽限过了照常判");
  } finally {
    setForwardGroupPanelReadyAtForTests(0);
  }
});
