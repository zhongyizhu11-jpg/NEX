/*
  监控 › 看板（运维看板，参考上游 2.3.285）的纯计算部分：按北京时间切天、订单状态归类、
  来源 IP 的省份归并。网络和数据库在 server/routers/ops/opsBoard.ts。
*/

export const OPS_BOARD_RANGES = [1, 7, 30] as const;
export type OpsBoardRange = typeof OPS_BOARD_RANGES[number];

/** 自动刷新档位（秒）。0 = 不刷新。离开页面 / 切到后台时由页面自己暂停。 */
export const OPS_BOARD_REFRESH_OPTIONS = [5, 10, 30, 0] as const;

const DAY = 86_400;
const BEIJING_OFFSET = 8 * 3600;

/** 这一刻所在的北京时间那一天的 0 点（Unix 秒）。看板按北京时间算「今天」，跟服务器时区无关。 */
export function beijingDayStart(seconds: number) {
  return Math.floor((seconds + BEIJING_OFFSET) / DAY) * DAY - BEIJING_OFFSET;
}

/** 「今天 / 7 天 / 30 天」的起点：含今天在内往回数 range 天。 */
export function opsBoardSince(range: OpsBoardRange, nowSeconds: number) {
  return beijingDayStart(nowSeconds) - (range - 1) * DAY;
}

/** 起点到今天的每一天（北京时间的 YYYY-MM-DD），空的天也要占一格，柱子才连得上。 */
export function opsBoardDays(range: OpsBoardRange, nowSeconds: number) {
  const first = opsBoardSince(range, nowSeconds);
  return Array.from({ length: range }, (_, index) => beijingDate(first + index * DAY));
}

export function beijingDate(seconds: number) {
  return new Date((seconds + BEIJING_OFFSET) * 1000).toISOString().slice(0, 10);
}

/** 订单状态归成看板上的四类。paid / processing 是「收到钱、还在发货」，单独算一类，不能混进成功或失败。 */
export type OrderBucket = "completed" | "delivering" | "pending" | "closed";
export function orderStatusBucket(status: unknown): OrderBucket {
  const value = String(status || "");
  if (value === "completed") return "completed";
  if (value === "paid" || value === "processing") return "delivering";
  if (value === "pending") return "pending";
  return "closed";
}

export const ORDER_BUCKET_LABELS: Record<OrderBucket, string> = {
  completed: "已完成",
  delivering: "已付款，开通中",
  pending: "待支付",
  closed: "已关闭 / 失败",
};

/** 省份名归一：离线库给的是「广东省」「广西壮族自治区」这种全称，看板上显示「广东」「广西」。 */
export function shortProvinceName(region: string | null | undefined) {
  const value = String(region || "").trim();
  if (!value) return "";
  return value
    .replace(/(壮族|回族|维吾尔)?自治区$/, "")
    .replace(/特别行政区$/, "")
    .replace(/(省|市)$/, "");
}

/**
 * 来源地区的一个分组键：国内按省份，港澳台各自一组，境外按国家。
 * countryCode 认不出（内网、离线库没有）的归「未知」。
 */
export function sourceAreaLabel(geo: { countryCode?: string | null; countryName?: string | null; region?: string | null } | null | undefined) {
  if (!geo?.countryCode) return "未知";
  const code = geo.countryCode.toUpperCase();
  if (code === "HK") return "香港";
  if (code === "MO") return "澳门";
  if (code === "TW") return "台湾";
  if (code === "CN") return shortProvinceName(geo.region) || "中国（未知省份）";
  return geo.countryName || code;
}
