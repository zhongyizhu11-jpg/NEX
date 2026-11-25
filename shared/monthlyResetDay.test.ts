import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { billingCalendarParts, billingMonthlyBoundary, MONTHLY_RESET_MAX_DAY } from "./billingTime";
import { normalizeProxyNodeResetDay } from "./proxyNodeQuota";

/**
 * 「每月 31 号清零」在二月怎么办。
 *
 * 早先重置日卡死在 1-28，就是怕这个。但卡住输入并没有解决问题，只是不让人表达
 * 「月末结算」这个再常见不过的机房周期。真正要做的是触发判断拿当月天数夹一下。
 */
test("重置日能填到 31", () => {
  assert.equal(MONTHLY_RESET_MAX_DAY, 31);
  assert.equal(normalizeProxyNodeResetDay(31), 31);
  assert.equal(normalizeProxyNodeResetDay(29), 29);
  assert.equal(normalizeProxyNodeResetDay(32), 31, "超出上限往回夹，不是丢掉");
  assert.equal(normalizeProxyNodeResetDay(0), 1);
  assert.equal(normalizeProxyNodeResetDay("abc"), 1);
});

test("每月 31 号在短月份落到当月最后一天", () => {
  /*
    用 billingCalendarParts 读，不用 Date#getDate()。整条计费链路的「几号」都是
    Asia/Shanghai 口径，而容器里的进程时区是 UTC —— 拿 getDate() 读会差一天，
    看起来像代码算错了，其实是量错了。第一版这个用例就是这么写错的。
  */
  const dayOf = (reference: string, resetDay: number) =>
    billingCalendarParts(billingMonthlyBoundary(new Date(reference), resetDay)).day;

  assert.equal(dayOf("2027-02-15T12:00:00Z", 31), 28, "平年二月的「31 号」就是 28 号");
  assert.equal(dayOf("2028-02-15T12:00:00Z", 31), 29, "闰年二月的「31 号」是 29 号");
  assert.equal(dayOf("2027-04-15T12:00:00Z", 31), 30, "四月只有 30 天");
  assert.equal(dayOf("2027-03-15T12:00:00Z", 31), 31, "长月份原样");
  assert.equal(dayOf("2027-02-15T12:00:00Z", 30), 28, "30 号在二月同样落到月末");
  assert.equal(dayOf("2027-02-15T12:00:00Z", 15), 15, "填得下的日子不动");
});

/**
 * 这一条是那个 bug 本身：原来的预筛是 `trafficResetDay <= 今天几号`，
 * 二月 28 号那天 `31 <= 28` 不成立 —— 设成每月 31 号的整个二月都不会重置，
 * 而用户看到的只是「设了自动重置却从来没重置过」。
 */
test("二月最后一天，设成 31 号的必须算作已到期", () => {
  // 2027-02-28 12:00 上海 = 2027-02-28T04:00Z
  const lastDayOfFeb = new Date("2027-02-28T04:00:00Z");
  assert.equal(billingCalendarParts(lastDayOfFeb).day, 28, "先确认参考时刻确实是二月最后一天");
  const boundary = billingMonthlyBoundary(lastDayOfFeb, normalizeProxyNodeResetDay(31));
  assert.ok(
    lastDayOfFeb.getTime() >= boundary.getTime(),
    "二月 28 号已经到了「每月 31 号」这个边界，不能整月不触发",
  );
});

test("还没到重置日就不该触发", () => {
  // 2027-03-10 12:00 上海
  const midMonth = new Date("2027-03-10T04:00:00Z");
  const boundary = billingMonthlyBoundary(midMonth, normalizeProxyNodeResetDay(31));
  assert.ok(midMonth.getTime() < boundary.getTime(), "3 月 10 号离月末还早，不能提前清零");
});

test("用户管理的重置日选择不再卡在 28 号", () => {
  // 重置日选择在「流量与权限设置」弹窗里，弹窗已从 Users.tsx 抽成独立组件；两处一起看
  const source = ["../client/src/pages/Users.tsx", "../client/src/components/users/UserTrafficSettingsDialog.tsx"]
    .map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(source, /length: 28\b/);
  assert.doesNotMatch(source, /\.day, 28\)/);
  assert.match(source, /Array\.from\(\{ length: MONTHLY_RESET_MAX_DAY \}/);
  assert.match(source, /小月在月末重置/);
});
