import assert from "node:assert/strict";
import { test } from "node:test";
import { recordLoginFailureEvent, resetEventHookMemory } from "./eventHooks";

// 没有数据库时 recordPanelEvent 只记一行警告，这里只看「什么时候该记」。
test("repeated login failures from one IP are recorded at 5, 20 and 100 attempts", () => {
  resetEventHookMemory();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const start = 1_000_000;
    const recordedAt: number[] = [];
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      if (recordLoginFailureEvent("203.0.113.9", "admin", start + attempt * 1000)) recordedAt.push(attempt);
    }
    assert.deepEqual(recordedAt, [5, 20, 100]);
    // 另一个 IP 自己数
    for (let attempt = 1; attempt <= 4; attempt += 1) assert.equal(recordLoginFailureEvent("198.51.100.1", "x", start + attempt), false);
    // 15 分钟没动静就重新数
    const later = start + 100_000 + 16 * 60_000;
    for (let attempt = 1; attempt <= 4; attempt += 1) assert.equal(recordLoginFailureEvent("203.0.113.9", "admin", later + attempt), false);
    assert.equal(recordLoginFailureEvent("203.0.113.9", "admin", later + 5), true);
  } finally {
    console.warn = warn;
    resetEventHookMemory();
  }
});
