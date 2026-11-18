import assert from "node:assert/strict";
import test from "node:test";
import { forwardGroupFlapHoldAt, forwardGroupFlapHoldMs } from "./forwardGroupFlapHold";

test("抖动抑制的时长：三次起 5 分钟，每多一次翻倍，最多一小时（和线路组一致）", () => {
  assert.equal(forwardGroupFlapHoldMs(0), 0);
  assert.equal(forwardGroupFlapHoldMs(2), 0);
  assert.equal(forwardGroupFlapHoldMs(3), 5 * 60_000);
  assert.equal(forwardGroupFlapHoldMs(4), 10 * 60_000);
  assert.equal(forwardGroupFlapHoldMs(5), 20 * 60_000);
  assert.equal(forwardGroupFlapHoldMs(6), 40 * 60_000);
  assert.equal(forwardGroupFlapHoldMs(7), 60 * 60_000);
  assert.equal(forwardGroupFlapHoldMs(100), 60 * 60_000);
});

test("抖动抑制：只数一小时内的自动切换，从最后一次切换算起", () => {
  const now = 10_000_000;
  const minutes = (n: number) => n * 60_000;
  assert.deepEqual(forwardGroupFlapHoldAt([now - minutes(50), now - minutes(2)], now), { switches: 2, holdMs: 0, untilMs: 0 });
  const held = forwardGroupFlapHoldAt([now - minutes(50), now - minutes(20), now - minutes(2)], now);
  assert.equal(held.switches, 3);
  assert.equal(held.untilMs, now - minutes(2) + minutes(5));
  // 最后一次切换已经过了 5 分钟：不压了
  assert.equal(forwardGroupFlapHoldAt([now - minutes(50), now - minutes(20), now - minutes(6)], now).untilMs, 0);
  // 一小时以前的不算
  assert.equal(forwardGroupFlapHoldAt([now - minutes(61), now - minutes(20), now - minutes(2)], now).untilMs, 0);
});
