/*
  列表页「卡片 / 列表 / 地图」这类视图偏好记在本地：原来十二处各写一份 getStoredX / storeX，
  一样的 try / catch、一样的「浏览器禁了本地存储就回到默认」。读写收在这里，各处只剩 key 和取值。

  手机和电脑分开记（Open-Box 0.1.361 / 0.1.368 也是这么改的）：同一个账号在手机上把规则
  切成卡片、回到电脑上发现表格没了 —— 两种屏幕适合的视图本来就不一样，一份偏好两端共用等于
  谁最后改谁说了算。手机那一份的 key 带 `.mobile` 后缀；老 key 留给电脑，升级不丢偏好。
*/

const MOBILE_QUERY = "(max-width: 767px)";

function isMobileViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(MOBILE_QUERY).matches;
  } catch {
    return false;
  }
}

/** 这台设备用哪个 key：手机带 `.mobile` 后缀。导出给测试和想要固定设备的调用方。 */
export function viewModeStorageKey(key: string, mobile = isMobileViewport()) {
  return mobile ? `${key}.mobile` : key;
}

export function readStoredViewMode<T extends string>(key: string, values: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(viewModeStorageKey(key));
    return values.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredViewMode(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(viewModeStorageKey(key), value);
  } catch {
    // 浏览器禁了本地存储时照常工作，只是下次进来回到默认视图。
  }
}
