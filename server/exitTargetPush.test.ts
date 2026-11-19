import assert from "node:assert/strict";
import test from "node:test";
import { ExitTargetPushDebouncer } from "./exitTargetPush";

/** 手拨的时钟和定时器：advance 把到点的定时器按时间顺序跑掉。 */
function harness() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const pushes: Array<{ hostId: number; at: number; urgent: boolean }> = [];
  const debouncer = new ExitTargetPushDebouncer(
    (hostId, _reason, options) => { pushes.push({ hostId, at: now, urgent: options.urgent }); },
    () => now,
    ((callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    }),
    ((timer: ReturnType<typeof setTimeout>) => { timers.delete(timer as unknown as number); }),
  );
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = Array.from(timers.entries()).filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = end;
  };
  return { debouncer, pushes, advance, start: now, nowValue: () => now };
}

test("普通的翻转攒 1.5 秒发一次：一阵翻转只推一次", () => {
  const { debouncer, pushes, advance, start } = harness();
  for (let index = 0; index < 20; index += 1) {
    debouncer.request(7);
    advance(50);
  }
  assert.equal(pushes.length, 0, "合并窗口里不发");
  advance(600);
  assert.deepEqual(pushes.map((push) => push.at - start), [1500], "从第一次算起 1.5 秒发一次");
  assert.equal(debouncer.pendingCount(), 0);
});

test("紧急的马上发，但一台入口一秒最多一次；一秒内再来的并到这一秒结束时", () => {
  const { debouncer, pushes, advance, start } = harness();
  debouncer.request(7, { urgent: true });
  assert.deepEqual(pushes.map((push) => push.at - start), [0], "第一次连不上：马上");
  for (let index = 0; index < 10; index += 1) {
    advance(50);
    debouncer.request(7, { urgent: true });
  }
  assert.equal(pushes.length, 1, "一秒内不再发第二次");
  advance(600);
  assert.deepEqual(pushes.map((push) => push.at - start), [0, 1000], "并成一次，在一秒的边界上发");
  // 另一台入口不受影响
  debouncer.request(8, { urgent: true });
  assert.equal(pushes.filter((push) => push.hostId === 8).length, 1);
});

test("紧急的把攒着的提前；一次推送覆盖之前所有待发的", () => {
  const { debouncer, pushes, advance, start } = harness();
  debouncer.request(7, { notBefore: start + 20_000 });
  debouncer.request(7);
  advance(1000);
  debouncer.request(7, { urgent: true });
  assert.deepEqual(pushes.map((push) => push.at - start), [1000]);
  advance(30_000);
  assert.equal(pushes.length, 1, "攒着的那两次已经被这次覆盖，不再单独发");
});

test("指定了最早时间的：到点才发", () => {
  const { debouncer, pushes, advance, start } = harness();
  debouncer.request(7, { notBefore: start + 20_000 });
  advance(19_000);
  assert.equal(pushes.length, 0);
  advance(1_000);
  assert.deepEqual(pushes.map((push) => push.at - start), [20_000]);
});
