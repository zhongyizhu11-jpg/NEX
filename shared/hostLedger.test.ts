import assert from "node:assert/strict";
import test from "node:test";

import { billingDateTime } from "./billingTime";
import {
  billingCalendarDaysBetween,
  buildHostLedgerRow,
  hostExpiryView,
  hostMonthlyCostCents,
  hostP95Estimate,
  hostP95Period,
  hostTrafficPeriod,
  hostTrafficProjection,
  normalizeHostCostCurrency,
  P95_BUCKET_SECONDS,
  percentile95,
  summarizeHostLedger,
  type HostRateBucket,
} from "./hostLedger";

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
/** 面板计费时区（北京时间）的某一刻。 */
const at = (year: number, month: number, day: number, hour = 0, minute = 0) => billingDateTime(year, month, day, hour, minute).getTime();

test("月均折算：季付按三个月摊、年付按十二个月摊、没填就是 0", () => {
  assert.equal(hostMonthlyCostCents(3000, 3), 1000);
  assert.equal(hostMonthlyCostCents(12000, 12), 1000);
  assert.equal(hostMonthlyCostCents(1999, 1), 1999);
  assert.equal(hostMonthlyCostCents(36000, 36), 1000);
  // 不在单台上取整：三台季付 10 元的机器合计正好 10 元，而不是 9.99
  assert.ok(Math.abs(hostMonthlyCostCents(1000, 3) * 3 - 1000) < 1e-9);
  assert.equal(hostMonthlyCostCents(0, 3), 0);
  assert.equal(hostMonthlyCostCents(-5, 1), 0);
  // 认不出的周期按月付，宁可算多也不凭空除以一个数
  assert.equal(hostMonthlyCostCents(500, 7), 500);
});

test("币种认不出来时按人民币，大小写都认", () => {
  assert.equal(normalizeHostCostCurrency("usd"), "USD");
  assert.equal(normalizeHostCostCurrency("BTC"), "CNY");
  assert.equal(normalizeHostCostCurrency(null), "CNY");
});

test("到期剩余天数按面板时区的日历日数：跨月、闰年都对", () => {
  // 1 月 30 日晚上 → 2 月 2 日零点：跨月 3 天
  assert.equal(billingCalendarDaysBetween(at(2027, 1, 30, 22), at(2027, 2, 2)), 3);
  // 闰年 2 月有 29 日：2 月 28 日 → 3 月 1 日是两天；平年是一天
  assert.equal(billingCalendarDaysBetween(at(2028, 2, 28, 12), at(2028, 3, 1)), 2);
  assert.equal(billingCalendarDaysBetween(at(2027, 2, 28, 12), at(2027, 3, 1)), 1);
  // 跨年
  assert.equal(billingCalendarDaysBetween(at(2026, 12, 31, 23, 59), at(2027, 1, 1, 0, 1)), 1);
  // 今天晚些时候到期：0 天（「今天到期」），不是 1 天
  assert.equal(billingCalendarDaysBetween(at(2026, 11, 10, 9), at(2026, 11, 10, 18)), 0);
  // 已经过了：负数
  assert.equal(billingCalendarDaysBetween(at(2026, 11, 10, 9), at(2026, 11, 8, 18)), -2);
});

test("快到期的判断：一周以内或提醒天数以内都高亮，没填到期时间不高亮", () => {
  const now = at(2026, 11, 10, 10);
  assert.equal(hostExpiryView({ renewalReminderDays: 3 }, at(2026, 11, 16), now).soon, true);
  assert.equal(hostExpiryView({ renewalReminderDays: 3 }, at(2026, 11, 20), now).soon, false);
  // 提醒天数设得比一周还长，就按提醒天数
  assert.equal(hostExpiryView({ renewalReminderDays: 15 }, at(2026, 11, 20), now).soon, true);
  // 和续费提醒是同一个判断
  assert.equal(hostExpiryView({ renewalReminderDays: 3 }, at(2026, 11, 12, 12), now).reminderDue, true);
  const none = hostExpiryView({ renewalReminderDays: 3 }, null, now);
  assert.deepEqual([none.daysLeft, none.soon], [null, false]);
});

test("每月重置的流量周期：按重置日切月，31 日在小月收敛到月末", () => {
  const now = at(2026, 11, 10, 10);
  const period = hostTrafficPeriod({ trafficAutoReset: true, trafficResetDay: 5 }, null, null, now);
  assert.deepEqual(period, { startMs: at(2026, 11, 5), endMs: at(2026, 12, 5), source: "monthly" });
  // 还没到本月重置日：周期是上个月的那天到这个月的那天
  const early = hostTrafficPeriod({ trafficAutoReset: true, trafficResetDay: 20 }, null, null, now);
  assert.deepEqual([early?.startMs, early?.endMs], [at(2026, 10, 20), at(2026, 11, 20)]);
  // 2 月没有 31 日：2 月那段在 28 日（平年）结束
  const feb = hostTrafficPeriod({ trafficAutoReset: true, trafficResetDay: 31 }, null, null, at(2027, 2, 10));
  assert.deepEqual([feb?.startMs, feb?.endMs], [at(2027, 1, 31), at(2027, 2, 28)]);
  // 周期中间手动清过零：从清零那一刻起算
  const manual = hostTrafficPeriod({ trafficAutoReset: true, trafficResetDay: 1 }, at(2026, 11, 6), null, now);
  assert.equal(manual?.startMs, at(2026, 11, 6));
});

test("没开每月重置：从计数器清零起算，周期末只能用到期时间顶，没填到期就没有周期末", () => {
  const now = at(2026, 11, 10);
  const withExpiry = hostTrafficPeriod({ trafficAutoReset: false }, at(2026, 11, 1), at(2026, 12, 1), now);
  assert.deepEqual(withExpiry, { startMs: at(2026, 11, 1), endMs: at(2026, 12, 1), source: "since_reset" });
  assert.equal(hostTrafficPeriod({ trafficAutoReset: false }, at(2026, 11, 1), null, now)?.endMs, null);
  // 到期时间已经过了也不能当周期末
  assert.equal(hostTrafficPeriod({ trafficAutoReset: false }, at(2026, 11, 1), at(2026, 11, 5), now)?.endMs, null);
  // 一次都没报过流量：没有起点
  assert.equal(hostTrafficPeriod({ trafficAutoReset: false }, null, null, now), null);
});

test("预计用量：按周期平均速度外推到周期末，并给出每天还能用多少", () => {
  const period = { startMs: at(2026, 11, 1), endMs: at(2026, 12, 1), source: "monthly" as const };
  // 过了 10 天用了 300G，额度 1000G：按速度到月底 900G，不会超；剩 20 天，每天 35G
  const fine = hostTrafficProjection({ usedBytes: 300 * GB, limitBytes: 1000 * GB, period, nowMs: at(2026, 11, 11) });
  assert.equal(fine.projectedBytes, 900 * GB);
  assert.equal(fine.willExceed, false);
  assert.equal(fine.daysLeft, 20);
  assert.equal(fine.dailyBudgetBytes, Math.floor(700 * GB / 20));
  assert.equal(fine.lowSample, false);
  // 过了 10 天用了 500G：到月底 1500G，会超；第 20 天用完
  const tight = hostTrafficProjection({ usedBytes: 500 * GB, limitBytes: 1000 * GB, period, nowMs: at(2026, 11, 11) });
  assert.equal(tight.willExceed, true);
  assert.equal(tight.exhaustAtMs, at(2026, 11, 21));
  // 已经用超：不算「会超」，算「已超」，每天能用 0
  const over = hostTrafficProjection({ usedBytes: 1200 * GB, limitBytes: 1000 * GB, period, nowMs: at(2026, 11, 11) });
  assert.deepEqual([over.exceeded, over.willExceed, over.dailyBudgetBytes], [true, false, 0]);
  // 没设额度：只给预计用量，不给每天还能用多少
  const unlimited = hostTrafficProjection({ usedBytes: 300 * GB, limitBytes: 0, period, nowMs: at(2026, 11, 11) });
  assert.deepEqual([unlimited.projectedBytes, unlimited.dailyBudgetBytes, unlimited.willExceed], [900 * GB, null, false]);
  // 周期才开始几个小时：照样外推，但标出来只是粗估
  assert.equal(hostTrafficProjection({ usedBytes: GB, limitBytes: 1000 * GB, period, nowMs: at(2026, 11, 1, 6) }).lowSample, true);
  // 没有周期末：不编预计用量
  const open = hostTrafficProjection({ usedBytes: GB, limitBytes: 10 * GB, period: { ...period, endMs: null }, nowMs: at(2026, 11, 11) });
  assert.deepEqual([open.projectedBytes, open.dailyBudgetBytes, open.remainingBytes], [null, null, 9 * GB]);
});

test("95 值：去掉最高的 5% 之后取最大值，不插值", () => {
  // 1..100：去掉最高 5 个（96–100），剩下最大是 95
  assert.equal(percentile95(Array.from({ length: 100 }, (_, index) => index + 1)), 95);
  // 20 个点去掉 1 个
  assert.equal(percentile95([...Array.from({ length: 19 }, () => 10), 500]), 10);
  // 不到 20 个点一个都不去：最大值就是 95 值
  assert.equal(percentile95([1, 2, 3, 99]), 99);
  // 顺序无关
  assert.equal(percentile95([5, 100, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]), 19);
  assert.equal(percentile95([]), null);
});

function bucketsFor(startMs: number, count: number, mbps: (index: number) => { inMbps: number; outMbps: number }, coveredSeconds = P95_BUCKET_SECONDS): HostRateBucket[] {
  const startSec = Math.floor(startMs / 1000);
  return Array.from({ length: count }, (_, index) => {
    const rate = mbps(index);
    return {
      bucketStart: startSec + index * P95_BUCKET_SECONDS,
      bytesIn: (rate.inMbps * 1_000_000 / 8) * coveredSeconds,
      bytesOut: (rate.outMbps * 1_000_000 / 8) * coveredSeconds,
      coveredSeconds,
    };
  });
}

test("95 值按 5 分钟桶出入方向较大的那个算", () => {
  const startMs = at(2026, 11, 1);
  const nowMs = startMs + 2 * DAY;
  // 576 个桶：入方向一直 10，出方向 20；另外有 20 个桶出方向冲到 900（不到 5%，应当被去掉）
  const buckets = bucketsFor(startMs, 576, (index) => ({ inMbps: 10, outMbps: index < 20 ? 900 : 20 }));
  const estimate = hostP95Estimate(buckets, { startMs, endMs: at(2026, 12, 1), nowMs });
  assert.ok(Math.abs((estimate.mbps ?? 0) - 20) < 1e-6, String(estimate.mbps));
  assert.equal(estimate.samples, 576);
  assert.equal(estimate.expectedSamples, 576);
  assert.equal(estimate.sufficient, true);
  // 入方向大的时候取入方向
  const inbound = hostP95Estimate(bucketsFor(startMs, 576, () => ({ inMbps: 50, outMbps: 5 })), { startMs, endMs: at(2026, 12, 1), nowMs });
  assert.ok(Math.abs((inbound.mbps ?? 0) - 50) < 1e-6);
  // 覆盖不到一半的桶不当样本：只有 60 秒的数，速度按 60 秒算也可能是个假尖峰
  const partial = hostP95Estimate(bucketsFor(startMs, 10, () => ({ inMbps: 10, outMbps: 10 }), 60), { startMs, endMs: at(2026, 12, 1), nowMs });
  assert.equal(partial.samples, 0);
  // 周期之外的桶不算
  const outside = hostP95Estimate(bucketsFor(startMs - DAY, 288, () => ({ inMbps: 1, outMbps: 1 })), { startMs, endMs: at(2026, 12, 1), nowMs });
  assert.equal(outside.samples, 0);
});

test("样本不足的判定：没样本、周期刚开始、中间缺太多，三种都如实标出来", () => {
  const startMs = at(2026, 11, 1);
  const endMs = at(2026, 12, 1);
  const none = hostP95Estimate([], { startMs, endMs, nowMs: startMs + 2 * DAY });
  assert.deepEqual([none.mbps, none.sufficient, none.shortReason], [null, false, "no_samples"]);
  // 周期才过 6 小时：72 个点，照样给数，但标样本不足
  const young = hostP95Estimate(bucketsFor(startMs, 72, () => ({ inMbps: 10, outMbps: 10 })), { startMs, endMs, nowMs: startMs + 6 * 60 * 60 * 1000 });
  assert.equal(young.sufficient, false);
  assert.equal(young.shortReason, "too_few");
  assert.ok(young.mbps !== null);
  // 过了 4 天只有 2 天的点（中途改成 95 计费、或者掉线了两天）：覆盖 50%，样本不足
  const gappy = hostP95Estimate(bucketsFor(startMs + 2 * DAY, 576, () => ({ inMbps: 10, outMbps: 10 })), { startMs, endMs, nowMs: startMs + 4 * DAY });
  assert.equal(gappy.shortReason, "low_coverage");
  // 覆盖九成以上：够了
  const enough = hostP95Estimate(bucketsFor(startMs, 1100, () => ({ inMbps: 10, outMbps: 10 })), { startMs, endMs, nowMs: startMs + 4 * DAY });
  assert.equal(enough.sufficient, true);
});

test("95 计费周期按账单日切月", () => {
  assert.deepEqual(hostP95Period(15, at(2026, 11, 10)), { startMs: at(2026, 10, 15), endMs: at(2026, 11, 15) });
  assert.deepEqual(hostP95Period(1, at(2026, 11, 10)), { startMs: at(2026, 11, 1), endMs: at(2026, 12, 1) });
  // 闰年 2 月：账单日 30 收敛到 29 日
  assert.deepEqual(hostP95Period(30, at(2028, 3, 5)), { startMs: at(2028, 2, 29), endMs: at(2028, 3, 30) });
});

test("账本一行和合计：不同币种分开加，95 估算单独标出来", () => {
  const nowMs = at(2026, 11, 11);
  const base = { trafficAutoReset: true, trafficResetDay: 1, renewalReminderDays: 3, trafficAlertThresholdPercent: 20 };
  const quarterly = buildHostLedgerRow({
    host: { id: 1, name: "港-1", costCents: 9000, costCurrency: "CNY", billingCycleMonths: 3, trafficLimit: 1000 * GB, ...base },
    expiresAtMs: at(2026, 11, 20), usedBytes: 500 * GB, counterStartMs: null, rateBuckets: null, nowMs,
  });
  assert.equal(quarterly.monthlyFixedCents, 3000);
  assert.equal(quarterly.expiry.daysLeft, 9);
  // 10 天 500G，到月底 1500G：会超，算「流量快用完」
  assert.equal(quarterly.projection.willExceed, true);
  assert.equal(quarterly.trafficTight, true);
  assert.equal(quarterly.p95, null);

  const startMs = at(2026, 11, 1);
  const p95 = buildHostLedgerRow({
    host: { id: 2, name: "日-1", costCents: 500, costCurrency: "usd", billingCycleMonths: 1, billingDay: 1, bandwidthBilling: "p95", p95PriceCents: 100, ...base },
    expiresAtMs: at(2026, 11, 13), usedBytes: 0, counterStartMs: null,
    rateBuckets: bucketsFor(startMs, 2880, () => ({ inMbps: 30, outMbps: 40 })), nowMs,
  });
  assert.equal(p95.currency, "USD");
  assert.ok(Math.abs((p95.p95?.mbps ?? 0) - 40) < 1e-6);
  assert.ok(Math.abs((p95.p95CostCents ?? 0) - 4000) < 1e-3);
  assert.ok(Math.abs(p95.monthlyTotalCents - 4500) < 1e-3);
  // 没设额度的机器不算流量吃紧
  assert.equal(p95.trafficTight, false);

  const expired = buildHostLedgerRow({
    host: { id: 3, name: "美-1", costCents: 1200, costCurrency: "CNY", billingCycleMonths: 12, ...base },
    expiresAtMs: at(2026, 11, 1), usedBytes: 0, counterStartMs: null, rateBuckets: null, nowMs,
  });
  const free = buildHostLedgerRow({
    host: { id: 4, name: "白嫖", ...base }, expiresAtMs: null, usedBytes: 0, counterStartMs: null, rateBuckets: null, nowMs,
  });
  const summary = summarizeHostLedger([quarterly, p95, expired, free]);
  assert.deepEqual(summary.monthlyByCurrency, [
    { currency: "USD", cents: 4500, includesP95Estimate: true },
    { currency: "CNY", cents: 3100, includesP95Estimate: false },
  ]);
  assert.equal(summary.expiringWithin30Days, 2);
  assert.equal(summary.expired, 1);
  assert.equal(summary.trafficTight, 1);
  assert.deepEqual([summary.pricedHosts, summary.totalHosts], [3, 4]);
});
