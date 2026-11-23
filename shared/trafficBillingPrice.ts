/**
 * 按量计费的单价换算。
 *
 * 库里存的是**毫分**（milli-cents）：1 元 = 100 分 = 100000 毫分。用这么细的单位
 * 是因为每 GB 的价钱常常不足一分（比如 0.003 元/GB），存成分就只能四舍五入成 0。
 *
 * 抽出来单独测，是因为这一步错了不会报错、只会静静地把价钱显示成十倍 ——
 * 我第一版就把它写成了 `/ 100 / 100`（那是「分→元」两次），0.5 元/GB 显示成 5 元。
 * 这种错没有任何东西会拦，只有把它摆成一个能被断言的函数才拦得住。
 */
export const MILLI_CENTS_PER_YUAN = 100_000;

/** 毫分 → 元。0 或脏值返回 0。 */
export function yuanFromMilliCents(milliCents: unknown): number {
  const value = Number(milliCents);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / MILLI_CENTS_PER_YUAN;
}

/**
 * 给界面用的「¥x/GB」。没设单价时返回空串 —— 显示「¥0/GB」会被当成免费。
 *
 * 不固定小数位：一分钱以下的单价（0.003 元/GB）也要看得出来，硬截两位就成了 0.00。
 */
export function formatTrafficPricePerGb(milliCents: unknown): string {
  const yuan = yuanFromMilliCents(milliCents);
  if (yuan <= 0) return "";
  return `¥${Number(yuan.toFixed(5))}/GB`;
}

/**
 * 能配的最低单价：0.001 元/GB（100 毫分）。
 *
 * 有下限是因为 0 在这里不是「免费」而是「没设价」—— 一条价钱为 0 的计费配置
 * 会把资源标成在计费、却一分不扣，账对不上还找不到原因。
 */
export const MIN_PRICE_PER_GB_MILLI_CENTS = 100;

/** 元 → 毫分。界面上填的是元，库里存的是毫分。 */
export function milliCentsFromYuan(yuan: unknown): number {
  const value = Number(yuan);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * MILLI_CENTS_PER_YUAN);
}

/** 毫分 → 输入框里的元。没设价时给空串，而不是 "0"（那会被当成填过 0）。 */
export function priceInputFromMilliCents(milliCents: unknown): string {
  const yuan = yuanFromMilliCents(milliCents);
  if (yuan <= 0) return "";
  return String(Number(yuan.toFixed(5)));
}

const MILLI_CENTS_PER_CENT = 1000;

/**
 * 从一条计费配置里取出单价（毫分/GB），兼容老字段。
 *
 * 流量计费配置页和套餐商店原来各存一份。老数据里价钱存在 `pricePerGbCents`
 * （分），新字段是 `pricePerGbMilliCents`（毫分）—— 两份各自判「用哪个」，
 * 漂了就意味着同一条配置在两页显示成两个价钱。这是**正在收钱的数字**。
 */
export function pricePerGbMilliCentsOf(config: any) {
  const milliCents = Math.round(Number(config?.pricePerGbMilliCents || 0));
  if (milliCents > 0) return milliCents;
  return Math.round(Number(config?.pricePerGbCents || 0)) * MILLI_CENTS_PER_CENT;
}
