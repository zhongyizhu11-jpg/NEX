import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeOutages } from "./digestFormat";

const windowStart = 1_000_000;
const now = windowStart + 86400;

test("offline/online pairs add up per host", () => {
  const result = summarizeOutages([
    { hostId: 1, kind: "host.offline", at: windowStart + 100 },
    { hostId: 1, kind: "host.online", at: windowStart + 100 + 35 * 60 },
    { hostId: 1, kind: "host.offline", at: windowStart + 5000 },
    { hostId: 1, kind: "host.online", at: windowStart + 5600 },
  ], windowStart, now);
  assert.deepEqual(result, [{ hostId: 1, count: 2, totalSeconds: 35 * 60 + 600, ongoing: false }]);
});

test("an outage still open is counted until now and sorted first", () => {
  const result = summarizeOutages([
    { hostId: 2, kind: "host.offline", at: windowStart + 1000 },
    { hostId: 2, kind: "host.online", at: windowStart + 4600 },
    { hostId: 3, kind: "host.offline", at: now - 600 },
  ], windowStart, now);
  assert.deepEqual(result, [
    { hostId: 3, count: 1, totalSeconds: 600, ongoing: true },
    { hostId: 2, count: 1, totalSeconds: 3600, ongoing: false },
  ]);
});

test("an outage that started before the window is clipped to the window", () => {
  const result = summarizeOutages([
    { hostId: 4, kind: "host.online", at: windowStart + 600, offlineSince: windowStart - 7200 },
    // 孤立的上线（新机器 / 不知道从什么时候断的）不算掉线
    { hostId: 5, kind: "host.online", at: windowStart + 50 },
  ], windowStart, now);
  assert.deepEqual(result, [{ hostId: 4, count: 1, totalSeconds: 600, ongoing: false }]);
});

test("same-second events keep write order and offline uses the last heartbeat", () => {
  const result = summarizeOutages([
    { id: 2, hostId: 7, kind: "host.online", at: windowStart + 3000, offlineSince: windowStart + 900 },
    { id: 3, hostId: 7, kind: "host.offline", at: windowStart + 5000, offlineSince: windowStart + 4900 },
    { id: 4, hostId: 7, kind: "host.online", at: windowStart + 5000 },
    { id: 1, hostId: 7, kind: "host.offline", at: windowStart + 1000, offlineSince: windowStart + 900 },
  ], windowStart, now);
  assert.deepEqual(result, [{ hostId: 7, count: 2, totalSeconds: 2100 + 100, ongoing: false }]);
});

test("unsorted input and duplicate offline events are handled", () => {
  const result = summarizeOutages([
    { hostId: 6, kind: "host.online", at: windowStart + 900 },
    { hostId: 6, kind: "host.offline", at: windowStart + 600 },
    { hostId: 6, kind: "host.offline", at: windowStart + 300 },
    { hostId: 6, kind: "host.rebooted", at: windowStart + 800 },
  ], windowStart, now);
  assert.deepEqual(result, [{ hostId: 6, count: 1, totalSeconds: 600, ongoing: false }]);
});
