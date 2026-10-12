import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceAvailabilityTick,
  availabilityLast24h,
  availabilityOfCells,
  buildDayCells,
  coverageFromSamples,
  gapDownIntervals,
  intersectIntervals,
  lastShanghaiDays,
  mergeIntervals,
  shanghaiDayKey,
  shanghaiDayKeyStart,
  shanghaiDayStart,
  splitByShanghaiDay,
} from "./statusAvailabilityLogic";

// 2026-10-04 00:00 北京时间 = 2026-10-03 16:00 UTC
const OCT4 = Date.UTC(2026, 9, 3, 16, 0, 0) / 1000;

test("北京时间切日", () => {
  assert.equal(shanghaiDayKey(OCT4), "2026-10-04");
  assert.equal(shanghaiDayKey(OCT4 - 1), "2026-10-03");
  assert.equal(shanghaiDayStart(OCT4 + 5000), OCT4);
  assert.equal(shanghaiDayKeyStart("2026-10-04"), OCT4);
});

test("跨日的区间按日界切开", () => {
  assert.deepEqual(splitByShanghaiDay(OCT4 - 60, OCT4 + 30), [
    { day: "2026-10-03", seconds: 60 },
    { day: "2026-10-04", seconds: 30 },
  ]);
  assert.deepEqual(splitByShanghaiDay(OCT4, OCT4), []);
});

test("最近 30 天的日期键，旧在前、今天在最后", () => {
  const days = lastShanghaiDays(OCT4 + 100, 30);
  assert.equal(days.length, 30);
  assert.equal(days[29], "2026-10-04");
  assert.equal(days[0], "2026-09-05");
});

test("心跳间隔超过阈值才算断线；当前离线时补上尾段", () => {
  const samples = [0, 300, 600, 2400, 2700];
  assert.deepEqual(gapDownIntervals(samples, { until: 2800, currentlyOnline: true }), [[900, 2400]]);
  assert.deepEqual(gapDownIntervals(samples, { until: 4000, currentlyOnline: false }), [[900, 2400], [3000, 4000]]);
  // 刚刚才报过心跳的离线主机，尾段还不到一个心跳周期，不算
  assert.deepEqual(gapDownIntervals([0, 300], { until: 500, currentlyOnline: false }), []);
});

test("区间并集与交集", () => {
  assert.deepEqual(mergeIntervals([[5, 10], [0, 3], [2, 6]]), [[0, 10]]);
  assert.deepEqual(intersectIntervals([[0, 100]], [[10, 20], [50, 200]]), [[10, 20], [50, 100]]);
  // 面板停机：别的主机那段也没有心跳，这台的断线段被扣掉
  const others = coverageFromSamples([0, 300, 600, 3000, 3300], 300);
  assert.deepEqual(intersectIntervals([[900, 3000]], others), [[2700, 3000]]);
});

test("实时采样：状态切换与间隔过长时只记一个周期", () => {
  const first = advanceAvailabilityTick(null, { online: true, at: 1000 });
  assert.deepEqual(first, { from: 940, to: 1000, down: false, transition: null });
  const down = advanceAvailabilityTick({ online: true, at: 1000 }, { online: false, at: 1060 });
  assert.deepEqual(down, { from: 1000, to: 1060, down: true, transition: "down" });
  const up = advanceAvailabilityTick({ online: false, at: 1060 }, { online: true, at: 1120 });
  assert.equal(up.transition, "up");
  assert.equal(up.down, false);
  // 面板卡了 10 分钟：中间那段不知道，只记最近 60 秒
  const stalled = advanceAvailabilityTick({ online: true, at: 1000 }, { online: true, at: 1600 });
  assert.equal(stalled.from, 1540);
});

test("每日格子与 30 天可用率只算公开页能看到的主机", () => {
  const rows = [
    { hostId: 1, day: "2026-10-03", downSeconds: 0, observedSeconds: 86400 },
    { hostId: 2, day: "2026-10-03", downSeconds: 2100, observedSeconds: 86400 },
    { hostId: 3, day: "2026-10-03", downSeconds: 86400, observedSeconds: 86400 },
    { hostId: 1, day: "2026-10-04", downSeconds: 0, observedSeconds: 3600 },
  ];
  const visible = new Set([1, 2]);
  const cells = buildDayCells(rows, ["2026-10-02", "2026-10-03", "2026-10-04"], visible);
  assert.deepEqual(cells.map((cell) => cell.state), ["none", "partial", "up"]);
  assert.equal(cells[1].downSeconds, 2100);
  assert.equal(cells[1].hostsAffected, 1);
  const ratio = availabilityOfCells(cells)!;
  assert.ok(Math.abs(ratio - (1 - 2100 / (86400 * 2 + 3600))) < 1e-9);
  assert.equal(availabilityOfCells([]), null);
  // 断线超过一成算大故障
  assert.equal(buildDayCells(rows, ["2026-10-03"], new Set([3]))[0].state, "major");
});

test("近 24 小时：断线按事件精确算，昨天的观察时间按比例折算", () => {
  const now = OCT4 + 6 * 3600; // 10 月 4 日 06:00
  const rows = [
    { hostId: 1, day: "2026-10-03", downSeconds: 0, observedSeconds: 86400 },
    { hostId: 1, day: "2026-10-04", downSeconds: 600, observedSeconds: 6 * 3600 },
  ];
  const incidents = [
    { hostId: 1, startedAt: now - 3600, endedAt: now - 3000 },
    // 窗口外的不算
    { hostId: 1, startedAt: now - 3 * 86400, endedAt: now - 2 * 86400 },
  ];
  const ratio = availabilityLast24h(rows, incidents, new Set([1]), now)!;
  assert.ok(Math.abs(ratio - (1 - 600 / 86400)) < 1e-9);
  // 还没恢复的事件算到现在
  const ongoing = availabilityLast24h(rows, [{ hostId: 1, startedAt: now - 1200, endedAt: null }], new Set([1]), now)!;
  assert.ok(Math.abs(ongoing - (1 - 1200 / 86400)) < 1e-9);
  assert.equal(availabilityLast24h([], [], new Set([1]), now), null);
});
