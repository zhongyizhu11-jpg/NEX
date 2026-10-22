import { eq, inArray, like } from "drizzle-orm";
import { systemSettings } from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb } from "../dbRuntime";

// ==================== System Settings (key-value) ====================

const ALL_SETTINGS_CACHE_TTL_MS = 5_000;
let allSettingsCache: {
  db: unknown;
  expiresAt: number;
  values: Record<string, string | null>;
} | null = null;
let allSettingsLoad: {
  db: unknown;
  promise: Promise<Record<string, string | null>>;
} | null = null;
let allSettingsGeneration = 0;

/**
 * 「一天只做一次」这类去重标记用的键前缀。
 *
 * 到期提醒、流量提醒、主机续费提醒、余额自动续费都会往 system_settings 里写一行
 * `<前缀>:<...>:<YYYY-MM-DD>` 来防重复 —— 写完就再也没人删。一个五百人的面板跑
 * 一年能攒下十万行，而 getAllSettings() 是**整表读**（几十处在调），于是这些垃圾
 * 每次缓存过期都要重新加载一遍：面板越用越慢，还找不到原因。
 *
 * 它们只会被 getSetting(精确键) 读，所以既要定期清，也不该混进设置表里。
 */
const EPHEMERAL_SETTING_PREFIXES = [
  "emailReminder:",
  "telegramReminder:",
  "autoRenew:",
  // 订阅拉取事件的通知去重（server/proxySubNotify.ts）。
  "proxySubNotify:",
] as const;

/**
 * 面板自己用的运行时缓存（比如 server/tunnelExitPorts 记的出口端口）：借设置表存，好让面板重启后
 * 接着用。它们不是设置，只按前缀读（getSettingsByPrefix），不进 getAllSettings。
 */
export const RUNTIME_CACHE_SETTING_PREFIX = "runtimeCache:";

/** 这个键是不是「用完即弃」的日标记。 */
export function isEphemeralSettingKey(key: unknown): boolean {
  const text = String(key || "");
  return EPHEMERAL_SETTING_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** 从日标记键尾部取出那个日期；取不到返回 null（那就别动它）。 */
function ephemeralKeyDate(key: string): string | null {
  const match = /:(\d{4}-\d{2}-\d{2})$/.exec(key);
  return match ? match[1] : null;
}

function settingUpdatedAtMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  // 列是秒级 epoch；万一驱动给回毫秒，也认得出来。
  return numeric > 1e12 ? numeric : numeric * 1000;
}

/**
 * 清掉过期的日标记。
 *
 * 去重窗口只有一天，留 7 天纯属保险（跨时区、面板停机几天再回来）。
 *
 * 到期类提醒的键不带日期（按「这一次到期 + 这一档」去重，见 scheduler 的
 * expiryThresholdKey）：它们按行上的写入时间清。每一档只在到期前那 24 小时里有效，
 * 过了就再也不会被问到，同样留 7 天足够。
 *
 * 日期和写入时间都解析不出来的键一律不动 —— 宁可留着垃圾，也不能误删一条真设置。
 */
export async function pruneEphemeralSettings(retainDays = 7): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const cutoffMs = Date.now() - Math.max(1, retainDays) * 24 * 3600 * 1000;
  const cutoff = new Date(cutoffMs)
    .toISOString()
    .slice(0, 10);
  const rows = await db.select({ key: systemSettings.key, updatedAt: systemSettings.updatedAt }).from(systemSettings);
  const stale = (rows as Array<{ key: string; updatedAt: unknown }>)
    .filter((row) => isEphemeralSettingKey(row.key))
    .filter((row) => {
      const date = ephemeralKeyDate(String(row.key || ""));
      if (date) return date < cutoff;
      const updatedAtMs = settingUpdatedAtMs(row.updatedAt);
      return updatedAtMs !== null && updatedAtMs < cutoffMs;
    })
    .map((row) => String(row.key || ""));
  if (stale.length === 0) return 0;
  // 分批删：一条 IN 里塞几万个参数，MySQL 那边会直接拒绝。
  for (let i = 0; i < stale.length; i += 200) {
    const batch = stale.slice(i, i + 200);
    await db.delete(systemSettings).where(inArray(systemSettings.key, batch));
  }
  invalidateAllSettingsCache();
  return stale.length;
}

export function invalidateAllSettingsCache() {
  allSettingsCache = null;
  allSettingsLoad = null;
  allSettingsGeneration += 1;
}

/** 读取单个系统设置；不存在返回 null */
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const r = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
  return r[0]?.value ?? null;
}

/**
 * 这一批键里，哪些已经存着非空值。
 *
 * 提醒类任务原来是「一个人问一次库」：到期提醒、流量提醒、主机流量、主机续费、
 * 落地节点、落地端口各来一次 getSetting(精确键)，全是单行主键查。一千个用户加
 * 一千台机器，一轮就是一万两千次往返，而这一轮每六小时跑一次、天天跑。
 *
 * 这些键全是当天的日标记，值只有「sent」一种，所以一次 IN 问清就够了 ——
 * 剩下的判断在内存里做。分批 200 个：一条 IN 里塞几万个参数，MySQL 那边会直接拒绝。
 *
 * 值为空的行按「没发过」算，和原来 `!(await getSetting(key))` 的口径一致。
 */
export async function getSentSettingKeys(keys: string[]): Promise<Set<string>> {
  const sent = new Set<string>();
  const db = await getDb();
  if (!db) return sent;
  const unique = Array.from(new Set(keys.filter((key) => typeof key === "string" && key.length > 0)));
  for (let i = 0; i < unique.length; i += 200) {
    const batch = unique.slice(i, i + 200);
    const rows = await db.select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(inArray(systemSettings.key, batch));
    for (const row of rows as Array<{ key: string; value: string | null }>) {
      if (row.value) sent.add(String(row.key));
    }
  }
  return sent;
}

/** 批量读取所有系统设置 */
export async function getAllSettings(): Promise<Record<string, string | null>> {
  const db = await getDb();
  if (!db) return {};
  const now = Date.now();
  const cached = allSettingsCache;
  if (cached && cached.db === db && cached.expiresAt > now) {
    return { ...cached.values };
  }
  const activeLoad = allSettingsLoad;
  if (activeLoad && activeLoad.db === db) return { ...await activeLoad.promise };

  const generation = allSettingsGeneration;
  const promise = db.select().from(systemSettings).then((rows: Array<{ key: string; value: string | null }>) => {
    const values: Record<string, string | null> = {};
    // 日标记不进设置表：它们只会被 getSetting(精确键) 读，混进来只是让这份
    // 每隔几秒就要重建的映射白白变大。
    for (const row of rows) {
      if (isEphemeralSettingKey(row.key) || String(row.key || "").startsWith(RUNTIME_CACHE_SETTING_PREFIX)) continue;
      values[row.key] = row.value ?? null;
    }
    if (generation === allSettingsGeneration) {
      allSettingsCache = { db, expiresAt: Date.now() + ALL_SETTINGS_CACHE_TTL_MS, values };
    }
    return values;
  });
  allSettingsLoad = { db, promise };
  try {
    return { ...await promise };
  } finally {
    if (allSettingsLoad?.promise === promise) allSettingsLoad = null;
  }
}

/**
 * 按前缀读一批键（运行时缓存用，见 RUNTIME_CACHE_SETTING_PREFIX）。LIKE 只用前缀里第一个 %、_ 或 \ 之前
 * 的那段，剩下的在这里按原样比，不会把它们当通配符。
 */
export async function getSettingsByPrefix(prefix: string): Promise<Record<string, string | null>> {
  const db = await getDb();
  if (!db || !prefix) return {};
  const literal = prefix.split(/[\\%_]/)[0];
  const rows = await db.select().from(systemSettings).where(like(systemSettings.key, `${literal}%`));
  const values: Record<string, string | null> = {};
  for (const row of rows as Array<{ key: string; value: string | null }>) {
    if (String(row.key || "").startsWith(prefix)) values[row.key] = row.value ?? null;
  }
  return values;
}

/**
 * 这个键写进去会不会改变 getAllSettings() 的结果。
 *
 * 日标记和运行时缓存本来就不进那份映射（见 getAllSettings），写它们时不必把整份
 * 设置缓存作废 —— 否则一轮提醒发一千条，就是一千次「下一次读设置得整表重读」。
 */
function affectsAllSettingsCache(key: string) {
  return !isEphemeralSettingKey(key) && !String(key || "").startsWith(RUNTIME_CACHE_SETTING_PREFIX);
}

/** UPSERT 单个系统设置 */
export async function setSetting(key: string, value: string | null): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const invalidatesCache = affectsAllSettingsCache(key);
  if (invalidatesCache) invalidateAllSettingsCache();
  const nowSec = Math.floor(Date.now() / 1000);
  if (getDatabaseKind() === "sqlite") {
    await executeRaw(
      "INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt",
      [key, value, nowSec],
    );
  } else if (getDatabaseKind() === "postgresql") {
    await executeRaw(
      'INSERT INTO system_settings ("key", value, "updatedAt") VALUES (?, ?, ?) ON CONFLICT ("key") DO UPDATE SET value=excluded.value, "updatedAt"=excluded."updatedAt"',
      [key, value, nowSec],
    );
  } else {
    await executeRaw(
      "INSERT INTO system_settings (`key`, value, updatedAt) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value), updatedAt=VALUES(updatedAt)",
      [key, value, nowSec],
    );
  }
  if (invalidatesCache) invalidateAllSettingsCache();
}
/** 批量 UPSERT */
export async function setSettings(map: Record<string, string | null>): Promise<void> {
  for (const [k, v] of Object.entries(map)) {
    await setSetting(k, v);
  }
}

