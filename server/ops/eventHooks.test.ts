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

test("线路异常 / 恢复：进时间线，恢复带异常时长，同一条路径 30 秒内不重复记", async () => {
  const { routeHealthPanelEvent } = await import("./eventHooks");
  resetEventHookMemory();
  try {
    const rule = { id: 7, name: "港日", userId: 3, hostId: 1 };
    const start = 5_000_000;
    const down = routeHealthPanelEvent({ rule, hostId: 2, kind: "unhealthy", pathKey: "p2", pathLabel: "B 备用", reason: "probe_failed" }, start);
    assert.equal(down?.kind, "route.unhealthy");
    assert.equal(down?.level, "warn");
    assert.equal(down?.ruleId, 7);
    assert.equal(down?.hostId, 2);
    assert.match(String(down?.message), /「港日」的线路 B 备用 异常/);
    // 30 秒内同一条路径再报异常：不记
    assert.equal(routeHealthPanelEvent({ rule, kind: "unhealthy", pathKey: "p2", pathLabel: "B 备用" }, start + 10_000), null);
    // 另一条路径自己算
    assert.equal(routeHealthPanelEvent({ rule, kind: "unhealthy", pathKey: "p3", pathLabel: "C" }, start + 10_000)?.kind, "route.unhealthy");
    const up = routeHealthPanelEvent({ rule, kind: "recovered", pathKey: "p2", pathLabel: "B 备用" }, start + 300_000);
    assert.equal(up?.kind, "route.recovered");
    assert.equal(up?.level, "info");
    assert.equal(up?.hostId, 1); // 没给 hostId 用规则的入口
    assert.deepEqual(up?.data, { path: "B 备用", pathKey: "p2", durationSeconds: 300 });
    assert.match(String(up?.message), /恢复（异常了 5 分钟）/);
    // 之前没记过异常的恢复：不带时长
    const orphan = routeHealthPanelEvent({ rule, kind: "recovered", pathKey: "p9", pathLabel: "D" }, start + 300_000);
    assert.equal(orphan?.kind, "route.recovered");
    assert.equal((orphan?.data as any).durationSeconds, undefined);
    // 别的 kind 不归它管
    assert.equal(routeHealthPanelEvent({ rule, kind: "switch", pathKey: "p2" }, start), null);
    assert.equal(routeHealthPanelEvent({ rule: {}, kind: "unhealthy", pathKey: "p2" }, start), null);
  } finally {
    resetEventHookMemory();
  }
});
