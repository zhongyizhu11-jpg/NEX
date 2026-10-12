/** 「刚刚 / 5 分钟前 / 3 小时前 / 2 天前」，超过 30 天给日期。设备、令牌、通行密钥列表共用。 */
export function relativeTimeLabel(value: Date | string | number | null | undefined, empty = "从未") {
  if (value === null || value === undefined || value === "") return empty;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time) || time <= 0) return empty;
  const diff = Date.now() - time;
  if (diff < 0) return dateLabel(date);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days} 天前`;
  return dateLabel(date);
}

export function dateLabel(value: Date | string | number | null | undefined, empty = "—") {
  if (value === null || value === undefined || value === "") return empty;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return empty;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
