import assert from "node:assert/strict";
import test from "node:test";
import { RuleBatchJobLimitError, RuleBatchJobQueue, RuleBatchJobStopError, type RuleBatchJobItem } from "./ruleBatchJobs";

const owner = (userId: number) => ({ userId, extra: null });
const items = (count: number): RuleBatchJobItem[] => Array.from({ length: count }, (_, index) => ({ ruleId: index + 1, label: `规则 ${index + 1}` }));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 每一项都等测试放行，才能在中途看进度、停任务。 */
function gatedExecutor() {
  const waiting: Array<{ item: RuleBatchJobItem; release: (error?: Error) => void }> = [];
  const seen: number[] = [];
  const executor = (_job: unknown, item: RuleBatchJobItem) => new Promise<void>((resolve, reject) => {
    seen.push(Number(item.ruleId));
    waiting.push({ item, release: (error) => (error ? reject(error) : resolve()) });
  });
  return { executor, waiting, seen };
}

test("进度：逐项推进，完成后 completed，百分比和计数都对", async () => {
  const gate = gatedExecutor();
  const queue = new RuleBatchJobQueue(gate.executor, { concurrency: 2 });
  const { snapshot, duplicate } = queue.start(owner(1), { operation: "pause", items: items(4) });
  assert.equal(duplicate, false);
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.total, 4);
  assert.equal(snapshot.percent, 0);
  await tick();
  assert.equal(gate.waiting.length, 2, "并发 2：同时只做两项");
  gate.waiting.shift()!.release();
  await tick();
  let current = queue.get(1, snapshot.id)!;
  assert.equal(current.processed, 1);
  assert.equal(current.percent, 25);
  while (gate.waiting.length) { gate.waiting.shift()!.release(); await tick(); }
  await queue.wait(snapshot.id);
  current = queue.get(1, snapshot.id)!;
  assert.equal(current.state, "completed");
  assert.equal(current.succeeded, 4);
  assert.equal(current.percent, 100);
  assert.ok(current.finishedAt);
  assert.equal(current.forgetAt, current.finishedAt! + 10 * 60 * 1000);
});

test("停止：正在做的做完，剩下的记成未执行", async () => {
  const gate = gatedExecutor();
  const queue = new RuleBatchJobQueue(gate.executor, { concurrency: 1 });
  const { snapshot } = queue.start(owner(1), { operation: "delete", items: items(5) });
  await tick();
  assert.equal(queue.stop(1, snapshot.id)!.state, "stopping");
  assert.equal(queue.stop(2, snapshot.id), null, "别人停不了");
  gate.waiting.shift()!.release();
  await queue.wait(snapshot.id);
  const done = queue.get(1, snapshot.id)!;
  assert.equal(done.state, "stopped");
  assert.equal(done.succeeded, 1);
  assert.equal(done.notRun, 4);
  assert.equal(done.stopReason, "已手动停止");
  assert.deepEqual(gate.seen, [1]);
});

test("逐项失败带明细；重试只重做失败的那几项", async () => {
  const calls: number[] = [];
  let failOdd = true;
  const queue = new RuleBatchJobQueue(async (_job, item) => {
    calls.push(Number(item.ruleId));
    if (failOdd && Number(item.ruleId) % 2 === 1) throw new Error(`无权操作此规则 ${item.ruleId}`);
    if (Number(item.ruleId) === 4) return { skipped: true };
    return undefined;
  }, { concurrency: 3 });
  const { snapshot } = queue.start(owner(1), { operation: "restart", items: items(6) });
  await queue.wait(snapshot.id);
  const done = queue.get(1, snapshot.id)!;
  assert.equal(done.failed, 3);
  assert.equal(done.skipped, 1);
  assert.equal(done.succeeded, 2);
  assert.deepEqual(done.failures.map((failure) => [failure.ruleId, failure.label, failure.error]).sort(), [
    [1, "规则 1", "无权操作此规则 1"], [3, "规则 3", "无权操作此规则 3"], [5, "规则 5", "无权操作此规则 5"],
  ]);
  failOdd = false;
  calls.length = 0;
  const retry = queue.retryFailed(owner(1), snapshot.id)!;
  assert.equal(retry.snapshot.total, 3);
  assert.equal(retry.snapshot.retryOf, snapshot.id);
  assert.match(retry.snapshot.title, /^重试：/);
  await queue.wait(retry.snapshot.id);
  assert.deepEqual(calls.sort(), [1, 3, 5]);
  assert.equal(queue.get(1, retry.snapshot.id)!.succeeded, 3);
  assert.equal(queue.retryFailed(owner(2), snapshot.id), null, "别人的任务重试不了");
  assert.throws(() => queue.retryFailed(owner(1), retry.snapshot.id), /没有失败的项/);
});

test("重复提交同一批返回已有任务；每人同时最多 2 个；项数有上限；只看得到自己的", async () => {
  const gate = gatedExecutor();
  const queue = new RuleBatchJobQueue(gate.executor, { maxItems: 10 });
  const first = queue.start(owner(1), { operation: "enable", items: items(3) });
  const again = queue.start(owner(1), { operation: "enable", items: items(3) });
  assert.equal(again.duplicate, true);
  assert.equal(again.snapshot.id, first.snapshot.id);
  // 同样的规则换个操作不算重复
  const pause = queue.start(owner(1), { operation: "pause", items: items(3) });
  assert.equal(pause.duplicate, false);
  assert.throws(() => queue.start(owner(1), { operation: "restart", items: items(3) }), (error) => error instanceof RuleBatchJobLimitError && /同时最多跑 2 个/.test(error.message));
  // 别人不受影响，也看不到 1 号的任务
  const other = queue.start(owner(2), { operation: "enable", items: items(3) });
  assert.notEqual(other.snapshot.id, first.snapshot.id);
  assert.equal(queue.get(2, first.snapshot.id), null);
  assert.deepEqual(queue.list(2).map((job) => job.id), [other.snapshot.id]);
  assert.throws(() => queue.start(owner(3), { operation: "enable", items: items(11) }), /最多 10 项/);
  assert.throws(() => queue.start(owner(3), { operation: "enable", items: [] }), /没有要处理的规则/);
  assert.equal(queue.dismiss(1, first.snapshot.id), false, "在跑的不能直接关掉");
  await tick();
  while (gate.waiting.length) { gate.waiting.shift()!.release(); await tick(); }
  await queue.wait(first.snapshot.id);
  // 做完以后同样的内容可以再提交一次
  assert.equal(queue.start(owner(1), { operation: "enable", items: items(3) }).duplicate, false);
  assert.equal(queue.dismiss(1, first.snapshot.id), true);
  assert.equal(queue.get(1, first.snapshot.id), null);
  await tick();
  while (gate.waiting.length) { gate.waiting.shift()!.release(); await tick(); }
});

test("认人失败（登录失效）时整个任务停下，不刷出一堆一样的失败", async () => {
  let calls = 0;
  const queue = new RuleBatchJobQueue(async () => {
    calls += 1;
    if (calls >= 2) throw new RuleBatchJobStopError("登录已失效，剩下的规则没有继续处理");
  }, { concurrency: 1 });
  const { snapshot } = queue.start(owner(1), { operation: "pause", items: items(50) });
  await queue.wait(snapshot.id);
  const done = queue.get(1, snapshot.id)!;
  assert.equal(done.state, "stopped");
  assert.equal(done.succeeded, 1);
  assert.equal(done.failed, 0);
  assert.equal(done.notRun, 49);
  assert.equal(done.stopReason, "登录已失效，剩下的规则没有继续处理");
  assert.equal(done.percent, 100);
});

test("做完的任务过了保留时间就忘掉", async () => {
  let now = 1_000_000;
  const queue = new RuleBatchJobQueue(async () => undefined, { retentionMs: 60_000, now: () => now });
  const { snapshot } = queue.start(owner(1), { operation: "pause", items: items(2) });
  await queue.wait(snapshot.id);
  now += 59_000;
  assert.ok(queue.get(1, snapshot.id));
  now += 2_000;
  assert.equal(queue.get(1, snapshot.id), null);
  assert.deepEqual(queue.list(1), []);
});
