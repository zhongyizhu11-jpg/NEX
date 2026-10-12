import assert from "node:assert/strict";
import { test } from "node:test";
import { eventDayLabel, eventRelativeTime, formatOutageDuration, groupEventsByDay, isRecoveryEventKind } from "./opsEvents";

// 用本地时间构造，测试在任何时区下都成立
const now = new Date(2026, 9, 12, 10, 0, 0);

test("outage durations read as plain Chinese with at most two units", () => {
  assert.equal(formatOutageDuration(0), "不到 1 分钟");
  assert.equal(formatOutageDuration(59), "不到 1 分钟");
  assert.equal(formatOutageDuration(35 * 60), "35 分钟");
  assert.equal(formatOutageDuration(2 * 3600), "2 小时");
  assert.equal(formatOutageDuration(2 * 3600 + 5 * 60 + 30), "2 小时 5 分钟");
  assert.equal(formatOutageDuration(3 * 86400 + 4 * 3600 + 59), "3 天 4 小时");
  assert.equal(formatOutageDuration(86400), "1 天");
  assert.equal(formatOutageDuration(-5), "不到 1 分钟");
});

test("day labels follow calendar days, not 24 hour windows", () => {
  assert.equal(eventDayLabel(new Date(2026, 9, 12, 0, 1), now), "今天");
  assert.equal(eventDayLabel(new Date(2026, 9, 11, 23, 59), now), "昨天");
  assert.equal(eventDayLabel(new Date(2026, 9, 9, 12), now), "10月9日");
  assert.equal(eventDayLabel(new Date(2025, 11, 31, 12), now), "2025年12月31日");
});

test("relative time switches to a clock time after a day", () => {
  assert.equal(eventRelativeTime(new Date(now.getTime() - 20_000), now), "刚刚");
  assert.equal(eventRelativeTime(new Date(now.getTime() + 60_000), now), "刚刚");
  assert.equal(eventRelativeTime(new Date(now.getTime() - 5 * 60_000), now), "5 分钟前");
  assert.equal(eventRelativeTime(new Date(now.getTime() - 3 * 3600_000), now), "3 小时前");
  assert.equal(eventRelativeTime(new Date(2026, 9, 9, 9, 31), now), "09:31");
});

test("events group by day in the order given", () => {
  const items = [
    { id: 5, createdAt: new Date(2026, 9, 12, 9) },
    { id: 4, createdAt: new Date(2026, 9, 12, 1) },
    { id: 3, createdAt: new Date(2026, 9, 11, 22).toISOString() },
    { id: 2, createdAt: new Date(2026, 9, 9, 8).getTime() },
    { id: 1, createdAt: "not a date" },
  ];
  const groups = groupEventsByDay(items, now);
  assert.deepEqual(groups.map((group) => group.label), ["今天", "昨天", "10月9日"]);
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.id)), [[5, 4], [3], [2]]);
  assert.deepEqual(groupEventsByDay([], now), []);
});

test("recovery kinds are recognised", () => {
  assert.equal(isRecoveryEventKind("host.online"), true);
  assert.equal(isRecoveryEventKind("rule.recovered"), true);
  assert.equal(isRecoveryEventKind("host.offline"), false);
  assert.equal(isRecoveryEventKind("account.login"), false);
});
