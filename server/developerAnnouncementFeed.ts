import { APP_VERSION } from "../shared/versions";
import { compareVersions } from "../shared/version";
import { executeRaw, insertAndGetId, quoteDbIdentifier } from "./dbRuntime";
import { getSetting, setSetting } from "./repositories/settingsRepository";

/*
  开发者公告从 GitHub 拉（上游 poouo/Forwardx 2.3.293 起「每半小时从 GitHub 检查」）。

  原来开发者要通知大家的事（安全提醒、升级注意事项）只能随新版本发：偏偏最需要看到的是还没升级的那些面板。
  现在仓库里放一个 announcements/feed.json，面板在「检查更新」的时候顺手取一次（和检查更新同一个开关、
  同一个 GitHub 加速站，管理员打开页面时才查，最多半小时一次），把适用于这个版本、还没发过的那几条插进公告。

  每条只插一次（按 id 记在设置里）：管理员删掉、停用、改过的不会被下一次拉取放回来。
  feed 是开发者写的，内容照样走公告页本来的安全渲染；这里再限条数、长度、id 写法，坏条目整条丢掉。
*/

export const DEVELOPER_ANNOUNCEMENT_FEED_PATH = "announcements/feed.json";
const FEED_COOLDOWN_MS = 30 * 60_000;
const MAX_ITEMS = 20;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;

export type DeveloperAnnouncementType = "normal" | "popup" | "upgrade_popup";

export type DeveloperAnnouncement = {
  id: string;
  title: string;
  content: string;
  type: DeveloperAnnouncementType;
  /** 只发给版本 >= 它的面板 */
  minVersion: string | null;
  /** 只发给版本 <= 它的面板（常用：提醒还停在旧版本的去升级） */
  maxVersion: string | null;
  /** upgrade_popup 的目标版本 */
  targetVersion: string | null;
  startsAt: number | null;
  expiresAt: number | null;
};

function seconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  // 写成毫秒或 ISO 时间都认；存的是秒
  return Math.floor(parsed > 10_000_000_000 ? parsed / 1000 : typeof value === "number" ? parsed : parsed / 1000);
}

function version(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return VERSION_PATTERN.test(text) ? text.replace(/^v/i, "") : null;
}

/** 解析 feed.json：{ "announcements": [...] } 或直接一个数组。认不出的条目丢掉，不让一条坏的拖垮全部。 */
export function parseDeveloperAnnouncementFeed(raw: unknown): DeveloperAnnouncement[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { announcements?: unknown }).announcements)
    ? (raw as { announcements: unknown[] }).announcements
    : [];
  const seen = new Set<string>();
  const items: DeveloperAnnouncement[] = [];
  for (const entry of list.slice(0, MAX_ITEMS)) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const id = String(source.id ?? "").trim();
    const title = String(source.title ?? "").trim().slice(0, 120);
    const content = String(source.content ?? "").trim().slice(0, 10_000);
    const type = source.type === "popup" || source.type === "upgrade_popup" ? source.type : "normal";
    if (!ID_PATTERN.test(id) || seen.has(id) || !title || !content) continue;
    const targetVersion = type === "upgrade_popup" ? version(source.targetVersion) : null;
    if (type === "upgrade_popup" && !targetVersion) continue;
    seen.add(id);
    items.push({
      id,
      title,
      content,
      type,
      minVersion: version(source.minVersion),
      maxVersion: version(source.maxVersion),
      targetVersion,
      startsAt: seconds(source.startsAt),
      expiresAt: seconds(source.expiresAt),
    });
  }
  return items;
}

/** 这一条该不该出现在这个面板上：版本在范围里、还没过期。 */
export function developerAnnouncementApplies(item: DeveloperAnnouncement, panelVersion = APP_VERSION, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (item.minVersion && compareVersions(panelVersion, item.minVersion) < 0) return false;
  if (item.maxVersion && compareVersions(panelVersion, item.maxVersion) > 0) return false;
  if (item.expiresAt && item.expiresAt <= nowSeconds) return false;
  return true;
}

const markerKey = (id: string) => `developer-announcement-feed:${id}`;

/** 把适用的、还没发过的几条插进公告。返回这次插了哪几条。 */
export async function applyDeveloperAnnouncementFeed(items: DeveloperAnnouncement[], panelVersion = APP_VERSION, nowSeconds = Math.floor(Date.now() / 1000)) {
  const inserted: string[] = [];
  for (const item of items) {
    if (!developerAnnouncementApplies(item, panelVersion, nowSeconds)) continue;
    if (await getSetting(markerKey(item.id))) continue;
    // 先记「发过了」再插：插的时候面板挂了，最多少一条公告，不会重复插
    await setSetting(markerKey(item.id), String(nowSeconds));
    if (item.type === "popup") {
      // 登录弹窗同时只开一个（和管理员自己发弹窗的规矩一样）
      const q = quoteDbIdentifier;
      await executeRaw(`UPDATE ${q("announcements")} SET ${q("isActive")} = ? WHERE ${q("type")} = ?`, [false, "popup"]);
    }
    await insertAndGetId("announcements", {
      title: item.title,
      content: item.content,
      type: item.type,
      targetVersion: item.targetVersion,
      isActive: true,
      startsAt: item.startsAt,
      expiresAt: item.expiresAt,
      createdByUserId: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
    });
    inserted.push(item.id);
  }
  return inserted;
}

let lastSyncAt = 0;
let inflight: Promise<string[]> | null = null;

/**
 * 拉一次 feed（最多半小时一次，同时只有一个在拉）。fetchText 由调用方给：检查更新那边已经带着加速站、
 * 超时和「拿到的确实是 JSON」的校验。拉失败只打一行日志，什么都不改。
 */
export function syncDeveloperAnnouncementFeed(fetchText: () => Promise<string>, now = Date.now()): Promise<string[]> {
  if (inflight) return inflight;
  if (now - lastSyncAt < FEED_COOLDOWN_MS) return Promise.resolve([]);
  lastSyncAt = now;
  inflight = fetchText()
    .then((text) => applyDeveloperAnnouncementFeed(parseDeveloperAnnouncementFeed(JSON.parse(text))))
    .then((ids) => {
      if (ids.length) console.info(`[Announcement] Developer feed added ${ids.length} announcement(s): ${ids.join(", ")}`);
      return ids;
    })
    .catch((error) => {
      console.warn("[Announcement] Developer feed skipped:", error instanceof Error ? error.message : String(error));
      return [];
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function resetDeveloperAnnouncementFeedForTests() {
  lastSyncAt = 0;
  inflight = null;
}
