/*
  列表页「卡片 / 列表 / 地图」这类视图偏好记在本地：原来十二处各写一份 getStoredX / storeX，
  一样的 try / catch、一样的「浏览器禁了本地存储就回到默认」。读写收在这里，各处只剩 key 和取值。
*/
export function readStoredViewMode<T extends string>(key: string, values: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return values.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredViewMode(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 浏览器禁了本地存储时照常工作，只是下次进来回到默认视图。
  }
}
