import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_FAST_LIVENESS_ELSEWHERE_SILENCE_MS,
  AGENT_FAST_LIVENESS_SILENCE_MS,
  AgentFastLivenessTracker,
  type AgentFastLivenessTransition,
} from "./agentFastLiveness";

/*
  多个面板实例时（server/panelLease.ts），Agent 只连其中一个。别的实例从库里的 hosts.lastHeartbeat 知道它还活着
  （server/agentPresenceElsewhere.ts），不能按自己内存里的沉默把它判成离线；Agent 连在本实例上时，掉线照样 90 秒判出来。
*/

type FakeTimer = { callback: () => void; delayMs: number; at: number; cleared: boolean; unref: () => void };

function harness(startedAt: number) {
  let current = startedAt;
  const timers: FakeTimer[] = [];
  return {
    now: () => current,
    setTimer: ((callback: () => void, delayMs: number) => {
      const timer: FakeTimer = { callback, delayMs, at: current + delayMs, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    }) as any,
    clearTimer: ((timer: FakeTimer) => { timer.cleared = true; }) as any,
    /** 把时钟推到 target，按时刻顺序触发到期的定时器。 */
    advanceTo(target: number) {
      for (;;) {
        const due = timers.filter((timer) => !timer.cleared && timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cleared = true;
        current = Math.max(current, due.at);
        due.callback();
      }
      current = target;
    },
  };
}

function tracker(clock: ReturnType<typeof harness>, elsewhere: Map<number, number> | null) {
  const instance = new AgentFastLivenessTracker({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    lastSeenElsewhere: elsewhere ? (hostId) => elsewhere.get(hostId) ?? null : undefined,
  });
  const events: AgentFastLivenessTransition[] = [];
  instance.subscribe((event) => { events.push(event); });
  return { instance, events };
}

test("单实例（没有别处的来源）：沉默 90 秒判离线，和以前一样", () => {
  const clock = harness(1_000_000);
  const { instance, events } = tracker(clock, null);
  instance.registerPresenceCapableHost(7, clock.now());
  clock.advanceTo(1_000_000 + AGENT_FAST_LIVENESS_SILENCE_MS - 1);
  assert.equal(instance.isConfirmedOffline(7), false);
  clock.advanceTo(1_000_000 + AGENT_FAST_LIVENESS_SILENCE_MS);
  assert.equal(instance.isConfirmedOffline(7), true);
  assert.deepEqual(events.map((event) => event.kind), ["confirmed-offline"]);
});

test("Agent 连在别的实例上：库里有更晚的时刻就不判离线，按库里的时刻再等", () => {
  const start = 1_000_000;
  const clock = harness(start);
  const elsewhere = new Map<number, number>();
  const { instance, events } = tracker(clock, elsewhere);
  // 本实例启动时从库里预热（startupGrace），之后这台的请求都打到另一个实例
  instance.primeHosts([{ id: 7, agentVersion: "2.2.264", lastHeartbeat: start - 1_000 }]);
  // 另一个实例约每 90 秒往库里写一次
  for (let at = start + 30_000; at <= start + 600_000; at += 90_000) {
    clock.advanceTo(at);
    elsewhere.set(7, at);
    assert.equal(instance.isConfirmedOffline(7), false, `t=${at - start} 被判离线`);
  }
  assert.equal(events.length, 0);
  // 那边也不写了（Agent 真掉了）：从最后一次写库算，等满「别处」的沉默期限才判
  const lastWrite = elsewhere.get(7)!;
  clock.advanceTo(lastWrite + AGENT_FAST_LIVENESS_ELSEWHERE_SILENCE_MS - 1);
  assert.equal(instance.isConfirmedOffline(7), false);
  clock.advanceTo(lastWrite + AGENT_FAST_LIVENESS_ELSEWHERE_SILENCE_MS + AGENT_FAST_LIVENESS_SILENCE_MS);
  assert.equal(instance.isConfirmedOffline(7), true);
  assert.deepEqual(events.map((event) => event.kind), ["confirmed-offline"]);
});

test("Agent 连在本实例上：库里的时刻是本实例自己写的，不推迟离线判定", () => {
  const start = 2_000_000;
  const clock = harness(start);
  const elsewhere = new Map<number, number>();
  const { instance } = tracker(clock, elsewhere);
  instance.registerPresenceCapableHost(9, start);
  // 本实例看到它的那一刻顺手写了库（秒级取整，可能比看到的晚几百毫秒）
  elsewhere.set(9, start + 900);
  clock.advanceTo(start + AGENT_FAST_LIVENESS_SILENCE_MS);
  assert.equal(instance.isConfirmedOffline(9), true);
});

test("判了离线之后库里出现更晚的时刻（它换连到别的实例）：当它回来了", () => {
  const start = 3_000_000;
  const clock = harness(start);
  const elsewhere = new Map<number, number>();
  const { instance, events } = tracker(clock, elsewhere);
  instance.registerPresenceCapableHost(5, start);
  clock.advanceTo(start + AGENT_FAST_LIVENESS_SILENCE_MS);
  assert.equal(instance.isConfirmedOffline(5), true);
  const offlineAt = instance.state(5)!.offlineAt!;
  // 判离线之前的时刻不算
  assert.equal(instance.observeElsewhereActivity(5, offlineAt - 1_000), false);
  assert.equal(instance.isConfirmedOffline(5), true);
  clock.advanceTo(offlineAt + 20_000);
  assert.equal(instance.observeElsewhereActivity(5, offlineAt + 15_000), true);
  assert.equal(instance.isConfirmedOffline(5), false);
  const restored = events.at(-1)!;
  assert.equal(restored.kind, "activity-restored");
  assert.equal(restored.elsewhere, true);
  assert.equal(restored.isCurrent(), true);
  assert.equal(instance.state(5)!.lastSeenElsewhereAt, offlineAt + 15_000);
});
