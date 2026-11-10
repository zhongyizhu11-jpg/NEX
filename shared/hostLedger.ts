import {
  billingCalendarParts,
  billingMonthlyBoundary,
} from "./billingTime";
import { planHostRenewalReminder, planHostTrafficReminder } from "./hostReminder";

/**
 * 主机账本：每台 VPS 花多少钱、什么时候到期、这个周期的流量还剩多少、按 95 计费会是多少。
 *
 * 这里全是纯计算，服务端（server/routers/hostLedger.ts）把库里的数喂进来，界面只负责画。
 * 到期提醒、流量自动重置、流量故障转移那几套逻辑一行都不碰：这里只读它们的结果
 * （stoppedAt、计数器的 resetAt、planHost*Reminder 的判断），自己不改任何状态。
 *
 * 钱一律按「分」存整数（和订阅套餐 priceCents 一样），不同币种**不相加** ——
 * 面板没有汇率，把美元和人民币加成一个数等于编一个数出来。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// ==================== 费用 ====================

export const HOST_COST_CURRENCIES = ["CNY", "USD", "EUR", "HKD", "JPY", "GBP"] as const;
export type HostCostCurrency = typeof HOST_COST_CURRENCIES[number];

/** 认不出来的币种按人民币：面板别处（订阅套餐）的默认币种也是它。 */
export function normalizeHostCostCurrency(value: unknown): HostCostCurrency {
  const text = String(value ?? "").trim().toUpperCase();
  return (HOST_COST_CURRENCIES as readonly string[]).includes(text) ? text as HostCostCurrency : "CNY";
}

/** 一期费用的上限：一千万（按分存）。再大多半是多敲了几个零，不如直接拦下来。 */
export const HOST_COST_MAX_CENTS = 1_000_000_000;

/** 0 = 没填。免费的机器和没填的机器在账本上都不计钱，不必分开。 */
export function normalizeHostCostCents(value: unknown): number {
  const cents = Math.round(Number(value));
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  return Math.min(HOST_COST_MAX_CENTS, cents);
}

export type HostBandwidthBilling = "fixed" | "p95";

export const HOST_BANDWIDTH_BILLING_LABELS: Record<HostBandwidthBilling, string> = {
  fixed: "固定费用",
  p95: "按 95 值计费",
};

export function normalizeHostBandwidthBilling(value: unknown): HostBandwidthBilling {
  return value === "p95" ? "p95" : "fixed";
}

const CYCLE_LABELS: Record<number, string> = { 1: "月", 3: "季", 6: "半年", 12: "年", 24: "两年", 36: "三年" };

/** 「每季」「每年」里那个字。认不出的周期按月。 */
export function hostCycleLabel(cycleMonths: unknown): string {
  return CYCLE_LABELS[Math.floor(Number(cycleMonths))] ?? "月";
}

function cycleMonthsOf(value: unknown) {
  const months = Math.floor(Number(value));
  return CYCLE_LABELS[months] ? months : 1;
}

/**
 * 一期的费用折成每月多少（分，可以带小数，展示时再取整）。
 *
 * 填的是「每期」的钱：季付 30 就是每月 10，年付 120 也是每月 10。不在这里取整 ——
 * 十台季付 10 元的机器各自取整成 3.33 再相加，合计会和实际差出几分钱。
 */
export function hostMonthlyCostCents(costCents: unknown, cycleMonths: unknown): number {
  const cents = normalizeHostCostCents(costCents);
  return cents > 0 ? cents / cycleMonthsOf(cycleMonths) : 0;
}

// ==================== 到期 ====================

/**
 * 从 from 到 to 隔了几个日历日（面板计费时区）。
 *
 * 不用「毫秒差 / 一天」：明早 0 点到期、现在是晚上 11 点，毫秒差算出来是 0.04 天，
 * 向上取整说「还剩 1 天」，向下取整说「今天到期」—— 两种都和人看日历的直觉对不上。
 * 按日历日数，明天到期就是 1，今天到期就是 0，跨月、闰年都由日历本身管。
 */
export function billingCalendarDaysBetween(from: Date | number, to: Date | number): number {
  const a = billingCalendarParts(from);
  const b = billingCalendarParts(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

export type HostExpiryView = {
  /** 到期时间点（毫秒）；没填就是 null。 */
  expiresAtMs: number | null;
  /** 还剩几个日历日；已经过了是负数；没填是 null。 */
  daysLeft: number | null;
  /** 快到期（要高亮）：已过期，或者落在提醒天数 / 7 天以内。 */
  soon: boolean;
  /** 和「续费提醒」同一个判断（shared/hostReminder.ts），这里只读不改。 */
  reminderDue: boolean;
};

/** 账本上「快到期」的最少天数：提醒天数默认才 3 天，账本上看一周更有用。 */
export const HOST_LEDGER_EXPIRY_HIGHLIGHT_DAYS = 7;

export function hostExpiryView(
  host: { renewalReminderDays?: unknown },
  expiresAtMs: number | null,
  nowMs: number,
): HostExpiryView {
  if (expiresAtMs === null || !Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    return { expiresAtMs: null, daysLeft: null, soon: false, reminderDue: false };
  }
  const daysLeft = billingCalendarDaysBetween(nowMs, expiresAtMs);
  const reminder = planHostRenewalReminder({ stoppedAt: expiresAtMs, renewalReminderDays: host.renewalReminderDays }, nowMs);
  const highlight = Math.max(HOST_LEDGER_EXPIRY_HIGHLIGHT_DAYS, Math.floor(Number(host.renewalReminderDays) || 0));
  return { expiresAtMs, daysLeft, soon: daysLeft <= highlight, reminderDue: reminder.due };
}

// ==================== 流量周期与预计用量 ====================

export type HostTrafficPeriod = {
  /** 这个周期从哪一刻开始算已用（计数器最后一次清零和周期起点取晚的那个）。 */
  startMs: number;
  /** 周期末；算不出来（没开每月重置、也没填到期时间）是 null。 */
  endMs: number | null;
  source: "monthly" | "since_reset";
};

/**
 * 这台机器「本周期」是哪一段。
 *
 * - 开了每月自动重置：按重置日切月（29/30/31 日在小月收敛到月末，同 billingMonthlyBoundary）。
 *   计数器要是在周期中间被手动清过零，已用量是从那一刻起的，起点取那一刻 —— 否则速度算慢了。
 * - 没开：计数器一直累加，起点就是它上次清零（或第一次建）的时候；周期末只能拿到期时间顶上，
 *   没填到期时间就说不出「到周期末」是哪天，返回 endMs = null，界面上不编预计用量。
 */
export function hostTrafficPeriod(
  host: { trafficAutoReset?: unknown; trafficResetDay?: unknown },
  counterStartMs: number | null,
  expiresAtMs: number | null,
  nowMs: number,
): HostTrafficPeriod | null {
  const counterStart = counterStartMs !== null && Number.isFinite(counterStartMs) && counterStartMs > 0 ? counterStartMs : null;
  const autoReset = host.trafficAutoReset === true || host.trafficAutoReset === 1 || host.trafficAutoReset === "1" || host.trafficAutoReset === "true";
  if (autoReset) {
    const resetDay = host.trafficResetDay;
    const thisMonth = billingMonthlyBoundary(nowMs, resetDay).getTime();
    const startMs = nowMs >= thisMonth ? thisMonth : billingMonthlyBoundary(nowMs, resetDay, -1).getTime();
    const endMs = nowMs >= thisMonth ? billingMonthlyBoundary(nowMs, resetDay, 1).getTime() : thisMonth;
    return { startMs: Math.min(nowMs, Math.max(startMs, counterStart ?? startMs)), endMs, source: "monthly" };
  }
  if (counterStart === null) return null;
  const endMs = expiresAtMs !== null && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs ? expiresAtMs : null;
  return { startMs: Math.min(nowMs, counterStart), endMs, source: "since_reset" };
}

/** 周期过去不到一天时，速度是拿几个小时外推一个月 —— 照算，但要说清只是粗估。 */
export const HOST_PROJECTION_MIN_ELAPSED_MS = DAY_MS;

export type HostTrafficProjection = {
  /** 按这个周期到目前的平均速度，到周期末一共会用多少；算不出是 null。 */
  projectedBytes: number | null;
  /** 剩余额度 ÷ 剩余天数（含今天）；没设额度或没有周期末是 null。 */
  dailyBudgetBytes: number | null;
  /** 剩余额度（可以是 0）；没设额度是 null。 */
  remainingBytes: number | null;
  /** 剩几天（含今天，至少 1）；没有周期末是 null。 */
  daysLeft: number | null;
  /** 已经用超了。 */
  exceeded: boolean;
  /** 按当前速度周期末前会用超。 */
  willExceed: boolean;
  /** 按当前速度哪一刻用完；不会超、已经超了或算不出时是 null。 */
  exhaustAtMs: number | null;
  /** 周期刚开始，外推不可靠。 */
  lowSample: boolean;
};

export function hostTrafficProjection(input: {
  usedBytes: number;
  limitBytes: number;
  period: HostTrafficPeriod | null;
  nowMs: number;
}): HostTrafficProjection {
  const used = Math.max(0, Number(input.usedBytes) || 0);
  const limit = Math.max(0, Number(input.limitBytes) || 0);
  const remainingBytes = limit > 0 ? Math.max(0, limit - used) : null;
  const exceeded = limit > 0 && used >= limit;
  const period = input.period;
  if (!period) {
    return { projectedBytes: null, dailyBudgetBytes: null, remainingBytes, daysLeft: null, exceeded, willExceed: false, exhaustAtMs: null, lowSample: true };
  }
  const elapsedMs = Math.max(0, input.nowMs - period.startMs);
  const lowSample = elapsedMs < HOST_PROJECTION_MIN_ELAPSED_MS;
  const restMs = period.endMs !== null ? Math.max(0, period.endMs - input.nowMs) : null;
  const daysLeft = restMs !== null ? Math.max(1, Math.ceil(restMs / DAY_MS)) : null;
  // 一分钟都没过就没有速度可言（除零）；这时宁可不报，也不报一个无穷大。
  const rate = elapsedMs >= 60_000 ? used / elapsedMs : null;
  const projectedBytes = rate !== null && restMs !== null ? Math.round(used + rate * restMs) : null;
  const willExceed = limit > 0 && !exceeded && projectedBytes !== null && projectedBytes > limit;
  const exhaustAtMs = willExceed && rate !== null && rate > 0 ? Math.round(input.nowMs + (limit - used) / rate) : null;
  const dailyBudgetBytes = remainingBytes !== null && daysLeft !== null ? Math.floor(remainingBytes / daysLeft) : null;
  return { projectedBytes, dailyBudgetBytes, remainingBytes, daysLeft, exceeded, willExceed, exhaustAtMs, lowSample };
}

// ==================== 95 值 ====================

/** 95 计费的取样粒度：5 分钟一个点，这是机房的通行做法。 */
export const P95_BUCKET_SECONDS = 300;
/**
 * 一个 5 分钟桶至少要有多少秒是真有数据的，才算一个样本。
 * Agent 掉线半个桶、面板重启丢了半个桶的累加 —— 这种桶的速度按实际覆盖的秒数算，
 * 但覆盖不到一半的不要：拿 30 秒的数代表 5 分钟，抖一下就是一个假峰值。
 */
export const P95_MIN_BUCKET_COVERAGE_SECONDS = 150;
/** 至少一天的样本（288 个 5 分钟）才敢说这是个 95 值。 */
export const P95_MIN_SAMPLES = 288;
/** 覆盖率低于九成就标样本不足：缺掉的那些点里可能正好有峰值。 */
export const P95_MIN_COVERAGE_RATIO = 0.9;

export type HostRateBucket = {
  /** 桶起点（epoch 秒，按 300 秒对齐）。 */
  bucketStart: number;
  bytesIn: number;
  bytesOut: number;
  /** 这个桶里真有数据的秒数（0–300）。 */
  coveredSeconds: number;
};

/** 一个桶出入两个方向里较大的那个速率（Mbps）；覆盖不够返回 null。 */
export function bucketPeakMbps(bucket: HostRateBucket): number | null {
  const covered = Math.min(P95_BUCKET_SECONDS, Math.max(0, Number(bucket.coveredSeconds) || 0));
  if (covered < P95_MIN_BUCKET_COVERAGE_SECONDS) return null;
  const bytes = Math.max(Math.max(0, Number(bucket.bytesIn) || 0), Math.max(0, Number(bucket.bytesOut) || 0));
  return (bytes * 8) / covered / 1_000_000;
}

/**
 * 去掉最高的 5% 之后剩下的最大值。
 *
 * n 个点去掉 floor(n × 5%) 个最高的：一个月 8640 个点去掉 432 个，等价于「每月最多有
 * 36 小时的峰值不计费」。不插值 —— 机房账单上的 95 值就是序列里实际出现过的某个点。
 */
export function percentile95(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const drop = Math.floor(sorted.length * 0.05);
  return sorted[sorted.length - 1 - drop];
}

export type HostP95Estimate = {
  mbps: number | null;
  samples: number;
  expectedSamples: number;
  /** 样本够不够（见 P95_MIN_SAMPLES / P95_MIN_COVERAGE_RATIO）。不够也照样给数，只是标「样本不足」。 */
  sufficient: boolean;
  /** 不够的原因：没有样本 / 不到一天的样本（周期刚开始、刚改成 95 计费）/ 中间缺了太多。 */
  shortReason: "no_samples" | "too_few" | "low_coverage" | null;
};

/**
 * 这个计费周期到目前为止的 95 值。
 *
 * 周期没走完之前，这个数只是「到今天为止」的 95 值，月底的真实值可能更高也可能更低 ——
 * 所以界面上一律写「估算」，样本不够时再加「样本不足」。
 */
export function hostP95Estimate(
  buckets: readonly HostRateBucket[],
  window: { startMs: number; endMs: number; nowMs: number },
): HostP95Estimate {
  const startSec = Math.floor(window.startMs / 1000);
  const stopSec = Math.floor(Math.min(window.nowMs, window.endMs) / 1000);
  const rates: number[] = [];
  for (const bucket of buckets) {
    const start = Number(bucket.bucketStart);
    if (!(start >= startSec && start < stopSec)) continue;
    const rate = bucketPeakMbps(bucket);
    if (rate !== null) rates.push(rate);
  }
  const expectedSamples = Math.max(0, Math.floor((stopSec - startSec) / P95_BUCKET_SECONDS));
  const samples = rates.length;
  const mbps = percentile95(rates);
  let shortReason: HostP95Estimate["shortReason"] = null;
  if (samples === 0) shortReason = "no_samples";
  else if (samples < P95_MIN_SAMPLES) shortReason = "too_few";
  else if (expectedSamples > 0 && samples < expectedSamples * P95_MIN_COVERAGE_RATIO) shortReason = "low_coverage";
  return { mbps, samples, expectedSamples, sufficient: shortReason === null, shortReason };
}

/**
 * 95 计费的周期：按账单日切月（和机房出账的日子对齐，29/30/31 在小月收敛到月末）。
 * 季付、年付的机器 95 一般也是按月结，所以这里不跟着 billingCycleMonths 走。
 */
export function hostP95Period(billingDay: unknown, nowMs: number): { startMs: number; endMs: number } {
  const thisMonth = billingMonthlyBoundary(nowMs, billingDay).getTime();
  if (nowMs >= thisMonth) return { startMs: thisMonth, endMs: billingMonthlyBoundary(nowMs, billingDay, 1).getTime() };
  return { startMs: billingMonthlyBoundary(nowMs, billingDay, -1).getTime(), endMs: thisMonth };
}

/** 单价（分 / Mbps / 月）× 95 值。95 值不到 1 Mbps 也按实际小数算，不向上取整 —— 各家规则不一，宁可少说。 */
export function hostP95CostCents(mbps: number | null, priceCentsPerMbps: unknown): number | null {
  const price = normalizeHostCostCents(priceCentsPerMbps);
  if (mbps === null || !Number.isFinite(mbps) || price <= 0) return null;
  return mbps * price;
}

// ==================== 一行与合计 ====================

export type HostLedgerRow = {
  hostId: number;
  name: string;
  currency: HostCostCurrency;
  cycleMonths: number;
  /** 每期费用（分）；0 = 没填。 */
  costCents: number;
  /** 固定费用折到每月（分）。 */
  monthlyFixedCents: number;
  bandwidthBilling: HostBandwidthBilling;
  p95PriceCents: number;
  p95: HostP95Estimate | null;
  /** 95 值 × 单价（分 / 月）；不是 95 计费、或者算不出是 null。 */
  p95CostCents: number | null;
  /** 每月合计（固定 + 95 估算）。 */
  monthlyTotalCents: number;
  expiry: HostExpiryView;
  usedBytes: number;
  limitBytes: number;
  period: HostTrafficPeriod | null;
  projection: HostTrafficProjection;
  /** 和「流量耗尽提醒」同一个判断（剩余百分比低于阈值）。 */
  trafficReminderDue: boolean;
  /** 账本上算「流量快用完」：提醒该发了、已经超了，或按当前速度会超。 */
  trafficTight: boolean;
};

export type HostLedgerSource = {
  id: number;
  name: string;
  costCents?: unknown;
  costCurrency?: unknown;
  billingCycleMonths?: unknown;
  billingDay?: unknown;
  bandwidthBilling?: unknown;
  p95PriceCents?: unknown;
  renewalReminderDays?: unknown;
  trafficLimit?: unknown;
  trafficAlertThresholdPercent?: unknown;
  trafficAutoReset?: unknown;
  trafficResetDay?: unknown;
};

export function buildHostLedgerRow(input: {
  host: HostLedgerSource;
  /** 下次到期（服务端已经替「周期顺延」的机器往后推到了下一期）。 */
  expiresAtMs: number | null;
  usedBytes: number;
  /** 计数器从哪一刻开始累计（resetAt，没有就是建的时候）。 */
  counterStartMs: number | null;
  /** 只有 95 计费的机器才有；其余传 null。 */
  rateBuckets: readonly HostRateBucket[] | null;
  nowMs: number;
}): HostLedgerRow {
  const { host, nowMs } = input;
  const currency = normalizeHostCostCurrency(host.costCurrency);
  const cycleMonths = cycleMonthsOf(host.billingCycleMonths);
  const costCents = normalizeHostCostCents(host.costCents);
  const monthlyFixedCents = hostMonthlyCostCents(costCents, cycleMonths);
  const bandwidthBilling = normalizeHostBandwidthBilling(host.bandwidthBilling);
  const p95PriceCents = normalizeHostCostCents(host.p95PriceCents);
  const p95 = bandwidthBilling === "p95"
    ? hostP95Estimate(input.rateBuckets ?? [], { ...hostP95Period(host.billingDay, nowMs), nowMs })
    : null;
  const p95CostCents = p95 ? hostP95CostCents(p95.mbps, p95PriceCents) : null;
  const limitBytes = Math.max(0, Math.floor(Number(host.trafficLimit) || 0));
  const usedBytes = Math.max(0, Math.floor(Number(input.usedBytes) || 0));
  const period = hostTrafficPeriod(host, input.counterStartMs, input.expiresAtMs, nowMs);
  const projection = hostTrafficProjection({ usedBytes, limitBytes, period, nowMs });
  const trafficReminderDue = planHostTrafficReminder(host, usedBytes).due;
  return {
    hostId: Number(host.id),
    name: String(host.name || `主机 #${host.id}`),
    currency,
    cycleMonths,
    costCents,
    monthlyFixedCents,
    bandwidthBilling,
    p95PriceCents,
    p95,
    p95CostCents,
    monthlyTotalCents: monthlyFixedCents + (p95CostCents ?? 0),
    expiry: hostExpiryView(host, input.expiresAtMs, nowMs),
    usedBytes,
    limitBytes,
    period,
    projection,
    trafficReminderDue,
    trafficTight: limitBytes > 0 && (trafficReminderDue || projection.exceeded || projection.willExceed),
  };
}

export type HostLedgerSummary = {
  /** 每种币种一项，按金额从大到小。 */
  monthlyByCurrency: Array<{ currency: HostCostCurrency; cents: number; includesP95Estimate: boolean }>;
  /** 30 天内（含今天）到期的台数。 */
  expiringWithin30Days: number;
  /** 已经过了到期时间、还没续上的台数（单列：混进「30 天内」会让人以为还来得及）。 */
  expired: number;
  trafficTight: number;
  /** 填了费用的台数（剩下的没算进成本）。 */
  pricedHosts: number;
  totalHosts: number;
};

export function summarizeHostLedger(rows: readonly HostLedgerRow[]): HostLedgerSummary {
  const byCurrency = new Map<HostCostCurrency, { cents: number; includesP95Estimate: boolean }>();
  let expiringWithin30Days = 0;
  let expired = 0;
  let trafficTight = 0;
  let pricedHosts = 0;
  for (const row of rows) {
    if (row.monthlyTotalCents > 0) {
      pricedHosts += 1;
      const entry = byCurrency.get(row.currency) ?? { cents: 0, includesP95Estimate: false };
      entry.cents += row.monthlyTotalCents;
      if (row.p95CostCents !== null) entry.includesP95Estimate = true;
      byCurrency.set(row.currency, entry);
    }
    if (row.expiry.daysLeft !== null && row.expiry.daysLeft < 0) expired += 1;
    else if (row.expiry.daysLeft !== null && row.expiry.daysLeft <= 30) expiringWithin30Days += 1;
    if (row.trafficTight) trafficTight += 1;
  }
  return {
    monthlyByCurrency: Array.from(byCurrency, ([currency, entry]) => ({ currency, cents: Math.round(entry.cents), includesP95Estimate: entry.includesP95Estimate }))
      .sort((a, b) => b.cents - a.cents),
    expiringWithin30Days,
    expired,
    trafficTight,
    pricedHosts,
    totalHosts: rows.length,
  };
}
