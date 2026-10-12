/*
  事件时间线（第五套主题「朱砂」的「监控 › 事件」、首页「最近动态」、主机详情「最近动态」）
  前后端共用的小工具：断线时长怎么说、按天分组、「今天 / 昨天 / 10月9日」、相对时间。

  全是纯函数，日期按运行环境的本地时区算 —— 在浏览器里就是看的人自己的时区：
  人在国外看面板，「今天」应该是他的今天。服务端只用 formatOutageDuration。
*/

export type OpsEventLevel = "info" | "warn" | "crit";

/** 「35 分钟」「2 小时 5 分钟」「3 天 4 小时」「不到 1 分钟」。秒数 → 一句人话，只留两档。 */
export function formatOutageDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return "不到 1 分钟";
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

/** 这一天的分组键（本地日期 YYYY-MM-DD）。 */
export function eventDayKey(value: Date | number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 「今天」「昨天」「10月9日」；不是今年的带上年份「2025年12月31日」。 */
export function eventDayLabel(value: Date | number, now: Date | number = Date.now()): string {
  const date = new Date(value);
  const today = new Date(now);
  // 按日历日比，不按 24 小时比：昨晚 23:59 到今早 00:01 是「昨天」，不是「今天」。
  const diffDays = Math.round((startOfLocalDay(today) - startOfLocalDay(date)) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  const label = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === today.getFullYear() ? label : `${date.getFullYear()}年${label}`;
}

/**
 * 「刚刚」「5 分钟前」「3 小时前」；超过一天就直接写钟点「09:31」（分组标题已经说了是哪天）。
 * 将来的时间（服务器和浏览器钟差）按「刚刚」算。
 */
export function eventRelativeTime(value: Date | number, now: Date | number = Date.now()): string {
  const date = new Date(value);
  const diffSeconds = Math.floor((new Date(now).getTime() - date.getTime()) / 1000);
  if (diffSeconds < 60) return "刚刚";
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export type EventDayGroup<T> = { key: string; label: string; items: T[] };

/**
 * 按天分组，保持传进来的顺序（接口按 id 倒序给，新的在前）。
 * 同一天的事件在列表里不一定挨着（理论上不会，但时钟回拨时可能）：按第一次出现的位置成组，
 * 不会出现两个「今天」。
 */
export function groupEventsByDay<T extends { createdAt: Date | number | string }>(
  items: readonly T[],
  now: Date | number = Date.now(),
): EventDayGroup<T>[] {
  const groups: EventDayGroup<T>[] = [];
  const byKey = new Map<string, EventDayGroup<T>>();
  for (const item of items) {
    const at = new Date(item.createdAt);
    if (!Number.isFinite(at.getTime())) continue;
    const key = eventDayKey(at);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: eventDayLabel(at, now), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** 恢复类事件（上线、规则恢复）用绿点，其余 info 用灰点。 */
export function isRecoveryEventKind(kind: string): boolean {
  return /(?:\.online|\.recovered)$/.test(String(kind || ""));
}
