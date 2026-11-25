import assert from "node:assert/strict";
import test from "node:test";

import { PLAN_SUBSCRIBER_REFRESH_INLINE_THRESHOLD, refreshPlanSubscribers } from "./planSubscriberRefresh";

function harness() {
  const calls: number[] = [];
  const logs: Array<[string, string]> = [];
  let active = 0;
  let peak = 0;
  const gates = new Map<number, () => void>();
  const refresh = (userId: number) => new Promise<void>((resolve, reject) => {
    calls.push(userId);
    active += 1;
    peak = Math.max(peak, active);
    gates.set(userId, () => {
      active -= 1;
      if (userId === 13) reject(new Error("agent offline"));
      else resolve();
    });
  });
  const release = (userId: number) => { const gate = gates.get(userId); gates.delete(userId); gate?.(); };
  return { calls, logs, refresh, release, peak: () => peak, pending: () => gates.size, log: (level: string, message: string) => { logs.push([level, message]); } };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("不多于 3 个订户：在请求里刷完再返回（小面板立刻生效）", async () => {
  const h = harness();
  const pending = refreshPlanSubscribers(1, [1, 2, 3], "plan-updated", { refresh: h.refresh, log: h.log });
  await tick();
  assert.deepEqual(h.calls, [1, 2, 3]);
  let settled = false;
  void pending.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, "没刷完之前请求不返回");
  h.release(1); h.release(2); h.release(3);
  const result = await pending;
  assert.equal(result.mode, "inline");
  assert.equal(result.queued, 3);
  assert.equal(result.failed, 0);
  assert.equal(PLAN_SUBSCRIBER_REFRESH_INLINE_THRESHOLD, 3);
});

test("多于 3 个订户：请求立刻返回排了多少个，后台 3 路并发，失败只记日志不影响别人", async () => {
  const h = harness();
  const result = await refreshPlanSubscribers(2, [11, 12, 13, 14, 15, 15, 0], "plan-updated", { refresh: h.refresh, log: h.log });
  assert.equal(result.mode, "background");
  assert.equal(result.queued, 5, "去重、去掉非法 id");
  await tick();
  assert.deepEqual(h.calls, [11, 12, 13], "同时最多 3 个在跑");
  h.release(11);
  await tick();
  assert.deepEqual(h.calls, [11, 12, 13, 14]);
  h.release(13); // 这个失败
  await tick();
  assert.deepEqual(h.calls, [11, 12, 13, 14, 15], "一个失败了，剩下的照样排上");
  h.release(12); h.release(14); h.release(15);
  await result.done;
  assert.equal(h.peak(), 3);
  assert.ok(h.logs.some(([level, message]) => level === "warn" && /failed plan=2 user=13/.test(message)), JSON.stringify(h.logs));
  assert.ok(h.logs.some(([, message]) => /refresh done plan=2 users=5 failed=1/.test(message)), JSON.stringify(h.logs));
});

test("同一个套餐连着保存两次：第二批排在第一批后面，不叠成 6 路", async () => {
  const h = harness();
  const first = await refreshPlanSubscribers(3, [21, 22, 23, 24], "plan-updated", { refresh: h.refresh, log: h.log });
  const second = await refreshPlanSubscribers(3, [31, 32, 33, 34], "plan-updated", { refresh: h.refresh, log: h.log });
  await tick();
  assert.deepEqual(h.calls, [21, 22, 23]);
  for (const id of [21, 22, 23]) h.release(id);
  await tick();
  assert.deepEqual(h.calls, [21, 22, 23, 24], "第一批没完，第二批不开始");
  h.release(24);
  await first.done;
  await tick();
  assert.deepEqual(h.calls, [21, 22, 23, 24, 31, 32, 33]);
  for (const id of [31, 32, 33]) h.release(id);
  await tick();
  h.release(34);
  await second.done;
  assert.equal(h.peak(), 3);
});
