/*
  Telegram 每日简报的发送时间和可选内容块（设置 › Telegram 底部，第五套主题「朱砂」）。

  原来简报固定北京时间 9 点发、内容固定。现在钟点可调（默认还是 9 点），并多了几块
  可选内容，默认都关 —— 不动设置的人收到的简报和以前一模一样。
*/

export const DEFAULT_DIGEST_HOUR = 9;

/** 0–23 的整数钟点；认不出来（空、小数、越界、乱写）就回到默认 9 点。接受 9、"9"、"09"、"09:00"。 */
export function normalizeDigestHour(value: unknown): number {
  if (value === null || value === undefined || value === "") return DEFAULT_DIGEST_HOUR;
  const text = typeof value === "number" ? String(value) : String(value).trim();
  const match = /^(\d{1,2})(?::00)?$/.exec(text);
  if (!match) return DEFAULT_DIGEST_HOUR;
  const hour = Number(match[1]);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_DIGEST_HOUR;
}

/**
 * 现在（北京时间的钟点）该不该发今天那一份。
 *
 * 过了设定钟点就算到点 —— 调度十分钟看一次，面板在 9 点那十分钟里恰好重启也不会漏；
 * 「今天发过没有」由带日期的去重键管（见 telegramBot.runTelegramDigests），这里不管。
 * 所以当天把钟点从 20 点改到 9 点（已经过了），下一轮就会补发今天那一份。
 */
export function isDigestDue(currentHour: number, configuredHour: unknown): boolean {
  const hour = Math.floor(Number(currentHour));
  if (!Number.isFinite(hour)) return false;
  return hour >= normalizeDigestHour(configuredHour);
}

/** 「09:00」 */
export function formatDigestHour(hour: unknown): string {
  return `${String(normalizeDigestHour(hour)).padStart(2, "0")}:00`;
}

export type DigestBlockKey =
  | "hostTraffic"
  | "topUsers"
  | "availability"
  | "offlineNow"
  | "expiring"
  | "lowQuota"
  | "security";

export const DIGEST_BLOCKS: ReadonlyArray<{ key: DigestBlockKey; label: string; description: string }> = [
  { key: "hostTraffic", label: "各主机流量", description: "每台主机今天和本月各用了多少。" },
  { key: "topUsers", label: "今日流量前五的用户", description: "今天谁用得最多。" },
  { key: "availability", label: "过去 24 小时的掉线", description: "哪些主机断过线、断了多久。" },
  { key: "offlineNow", label: "此刻离线的主机", description: "全部列出，带已离线多久。" },
  { key: "expiring", label: "3 天内到期", description: "快到期的用户套餐和主机。" },
  { key: "lowQuota", label: "流量快用完的用户", description: "剩余不到 10% 的用户。" },
  { key: "security", label: "安全巡检", description: "还没处理的巡检问题有几条。" },
];

export const DIGEST_BLOCK_KEYS: readonly DigestBlockKey[] = DIGEST_BLOCKS.map((block) => block.key);

/** 逗号分隔存；认不出的丢掉，按固定顺序去重。空（没设过）= 一块都不加。 */
export function parseDigestBlocks(raw: unknown): DigestBlockKey[] {
  if (raw === null || raw === undefined) return [];
  const values = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
  const wanted = new Set(values.map((value) => value.trim()));
  return DIGEST_BLOCK_KEYS.filter((key) => wanted.has(key));
}
