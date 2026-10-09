/**
 * 每个人在 Telegram 里自己的通知开关。
 *
 * 面板设置里的开关（主机上下线总开关、规则上的「异常通知」、转发组的「切换通知」）决定
 * 「这件事要不要发」；这里决定「发给我的那份要不要」。管理员一多，有人只想看掉线、
 * 不想被线路切换刷屏，又不该替别人把总开关关掉。
 *
 * 存成一个设置键（JSON，按用户 ID 分），读走 getAllSettings 的 5 秒缓存，通知路径上
 * 不会多一次查库。没写过的人一律按「全收」处理；每日简报管理员默认收、普通用户默认不收
 * —— 没主动开过的用户不该每天早上被机器人打扰。
 */
import { getAllSettings, setSetting } from "./repositories/settingsRepository";

export type TelegramNotifyCategory = "host" | "rule" | "route";

export const TELEGRAM_NOTIFY_CATEGORIES: ReadonlyArray<{ key: TelegramNotifyCategory; label: string }> = [
  { key: "host", label: "主机上下线" },
  { key: "rule", label: "规则异常" },
  { key: "route", label: "线路切换" },
];

export const TELEGRAM_NOTIFY_PREFS_KEY = "telegramNotifyPrefs";

type TelegramNotifyPref = { muted?: TelegramNotifyCategory[]; digest?: boolean };
export type TelegramNotifyPrefs = Record<string, TelegramNotifyPref>;

const CATEGORY_KEYS = new Set<string>(TELEGRAM_NOTIFY_CATEGORIES.map((item) => item.key));

export function parseTelegramNotifyPrefs(raw: unknown): TelegramNotifyPrefs {
  let parsed: unknown = null;
  try {
    parsed = typeof raw === "string" && raw.trim() ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const prefs: TelegramNotifyPrefs = {};
  for (const [userId, value] of Object.entries(parsed as Record<string, any>)) {
    if (!/^\d+$/.test(userId) || !value || typeof value !== "object") continue;
    const muted = Array.isArray(value.muted)
      ? Array.from(new Set(value.muted.filter((item: unknown) => CATEGORY_KEYS.has(String(item))))) as TelegramNotifyCategory[]
      : [];
    prefs[userId] = {
      muted,
      ...(typeof value.digest === "boolean" ? { digest: value.digest } : {}),
    };
  }
  return prefs;
}

export function isTelegramNotifyMuted(prefs: TelegramNotifyPrefs, userId: unknown, category: TelegramNotifyCategory) {
  return !!prefs[String(Number(userId))]?.muted?.includes(category);
}

export function isTelegramDigestEnabled(prefs: TelegramNotifyPrefs, user: { id?: unknown; role?: unknown }) {
  const stored = prefs[String(Number(user?.id))]?.digest;
  return typeof stored === "boolean" ? stored : user?.role === "admin";
}

export async function readTelegramNotifyPrefs(): Promise<TelegramNotifyPrefs> {
  const settings = await getAllSettings().catch(() => ({} as Record<string, string | null>));
  return parseTelegramNotifyPrefs(settings[TELEGRAM_NOTIFY_PREFS_KEY]);
}

export async function updateTelegramNotifyPref(
  userId: number,
  change: { toggleCategory?: TelegramNotifyCategory; digest?: boolean },
) {
  const prefs = await readTelegramNotifyPrefs();
  const key = String(Number(userId));
  const current = prefs[key] || { muted: [] };
  const muted = new Set(current.muted || []);
  if (change.toggleCategory) {
    if (muted.has(change.toggleCategory)) muted.delete(change.toggleCategory);
    else muted.add(change.toggleCategory);
  }
  prefs[key] = {
    muted: Array.from(muted),
    ...(typeof change.digest === "boolean" ? { digest: change.digest } : typeof current.digest === "boolean" ? { digest: current.digest } : {}),
  };
  await setSetting(TELEGRAM_NOTIFY_PREFS_KEY, JSON.stringify(prefs));
  return prefs;
}

/** 通知发出前过一遍：把关掉这一类的人去掉。读不到偏好时照常全发 —— 漏发告警比多发一条糟。 */
export async function filterTelegramRecipients<T extends { id?: unknown }>(recipients: T[], category: TelegramNotifyCategory): Promise<T[]> {
  if (recipients.length === 0) return recipients;
  const prefs = await readTelegramNotifyPrefs().catch(() => ({} as TelegramNotifyPrefs));
  return recipients.filter((recipient) => !isTelegramNotifyMuted(prefs, recipient?.id, category));
}
