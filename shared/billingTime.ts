export const BILLING_TIME_ZONE = "Asia/Shanghai";

export const BILLING_DATE_TIME_FORMAT_OPTIONS = {
  timeZone: BILLING_TIME_ZONE,
  hourCycle: "h23",
} satisfies Intl.DateTimeFormatOptions;

export type BillingCalendarParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const billingCalendarFormatter = new Intl.DateTimeFormat("en-US-u-nu-latn", {
  timeZone: BILLING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function validDate(value: Date | number | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid billing date");
  return date;
}

export function billingCalendarParts(value: Date | number | string): BillingCalendarParts {
  const parts = billingCalendarFormatter.formatToParts(validDate(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const numeric = Number(parts.find((part) => part.type === type)?.value);
    if (!Number.isFinite(numeric)) throw new RangeError(`Missing billing date part: ${type}`);
    return numeric;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

export function billingDaysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function billingDateTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
) {
  if (![year, month, day, hour, minute, second, millisecond].every(Number.isInteger)) {
    throw new RangeError("Invalid billing calendar date");
  }
  if (month < 1 || month > 12 || day < 1 || day > billingDaysInMonth(year, month)) {
    throw new RangeError("Billing calendar date is out of range");
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 || millisecond < 0 || millisecond > 999) {
    throw new RangeError("Billing calendar time is out of range");
  }

  const targetWallClockMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let candidateMs = targetWallClockMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = billingCalendarParts(candidateMs);
    const renderedWallClockMs = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second,
      millisecond,
    );
    const adjustmentMs = targetWallClockMs - renderedWallClockMs;
    candidateMs += adjustmentMs;
    if (adjustmentMs === 0) break;
  }
  return new Date(candidateMs);
}

function billingStartOfDay(year: number, month: number, day: number) {
  return billingDateTime(year, month, day);
}

export function billingStartOfCalendarDay(value: Date | number | string) {
  const { year, month, day } = billingCalendarParts(value);
  return billingStartOfDay(year, month, day);
}

export function billingAddMonthsClamped(value: Date | number | string, months: number) {
  const date = validDate(value);
  const current = billingCalendarParts(date);
  const monthIndex = current.year * 12 + current.month - 1 + Math.trunc(months);
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  const day = Math.min(current.day, billingDaysInMonth(year, month));
  return billingDateTime(
    year,
    month,
    day,
    current.hour,
    current.minute,
    current.second,
    date.getMilliseconds(),
  );
}

export function billingMonthStart(reference: Date | number | string) {
  const { year, month } = billingCalendarParts(reference);
  return billingStartOfDay(year, month, 1);
}

/**
 * 每月重置日的上限。
 *
 * 29/30/31 是可以填的：`billingMonthlyBoundary` 会把它收敛到当月的最后一天，
 * 所以「每月 31 号」在二月就是 28 号（闰年 29 号）—— 也就是「月末」，而机房按
 * 月末结算本来就很常见。
 *
 * 早先这里卡在 28，是因为怕落在不存在的日子上会整月不触发。真正该修的是触发
 * 判断（拿当月天数去夹一下），而不是不让人填。
 */
export const MONTHLY_RESET_MAX_DAY = 31;

export function billingMonthlyBoundary(
  reference: Date | number | string,
  resetDay: unknown,
  monthOffset = 0,
  maximumResetDay: number = MONTHLY_RESET_MAX_DAY,
) {
  const current = billingCalendarParts(reference);
  const monthIndex = current.year * 12 + current.month - 1 + Math.trunc(monthOffset);
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  const maximum = Math.max(1, Math.floor(Number(maximumResetDay) || 1));
  const requested = Math.max(1, Math.floor(Number(resetDay) || 1));
  const day = Math.min(requested, maximum, billingDaysInMonth(year, month));
  return billingStartOfDay(year, month, day);
}

/**
 * 「到期日期」输入框（YYYY-MM-DD）和存下来的时间点之间的换算，统一按面板计费时区。
 *
 * 选「2026-10-01」表示在计费时区的 2026-10-01 00:00 到期 —— 和套餐延期一致。
 * 以前服务端 `new Date("2026-10-01")` 取的是 UTC 零点（北京时间 08:00），浏览器再按本地时区
 * 读回来，西半球的管理员会看到前一天。旧数据（UTC 零点）按计费时区读仍是同一天，照样有效。
 */
export function parseBillingDateInput(value: unknown): Date | null {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > billingDaysInMonth(year, month)) return null;
  return billingStartOfDay(year, month, day);
}

/** 时间点 → 计费时区下的 YYYY-MM-DD；空值或无效值返回空串。 */
export function formatBillingDateInput(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value as string | number);
  const time = date.getTime();
  if (!Number.isFinite(time) || time <= 0) return "";
  const { year, month, day } = billingCalendarParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 服务端接收「到期时间」：纯日期按计费时区当天零点，完整的 ISO 时间点原样使用。
 * 无法解析时返回 undefined，由调用方报错。
 */
export function parseBillingExpiryInput(value: string): Date | undefined {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) return parseBillingDateInput(text) ?? undefined;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
