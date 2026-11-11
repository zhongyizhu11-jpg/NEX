import { getFormatLocale } from "@/i18n";

/**
 * 面板里「某个时间点」的统一写法：24 小时制，不随浏览器语言变成 10/16/2026, 3:40:50 AM。
 * 区域跟界面语言走（getFormatLocale：中文 zh-CN，英文 en-US），中文界面的写法和原来一样。
 *
 * 原来好几个页面各抄一份 formatTime，有的空值给「—」、有的给「-」、有的跟着浏览器语言走，
 * 同一个时间在两页上长得不一样。空值（含 0）和解析不出来的值都给 fallback（默认「—」）。
 */
export function formatDateTime(value: unknown, fallback = "—"): string {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(getFormatLocale(), { hour12: false }) : fallback;
}
