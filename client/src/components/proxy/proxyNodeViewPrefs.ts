import { normalizeProxyNodeGroupMode, type ProxyNodeGroupMode } from "@shared/proxyNodeGrouping";

/**
 * 「我的节点」列表的两个本地偏好：按什么分组、哪些组折叠着。
 *
 * 分组方式归页面（它传给 ProxyInboundsSection），折叠状态归「订阅内容」弹窗 ——
 * 两处读写同一个 localStorage 的规矩放在一起，省得两边各抄一份 try/catch。
 * 存不上也不影响用，只是下次进来又是默认的。
 */
export const NODE_GROUP_MODE_STORAGE_KEY = "forwardx.proxyNodes.groupMode";
export const NODE_COLLAPSED_STORAGE_KEY = "forwardx.proxyNodes.collapsed";

export function readStoredGroupMode(): ProxyNodeGroupMode {
  if (typeof window === "undefined") return "none";
  try {
    return normalizeProxyNodeGroupMode(window.localStorage.getItem(NODE_GROUP_MODE_STORAGE_KEY));
  } catch {
    return "none";
  }
}

/** 折叠起来的分组键。 */
export function readStoredCollapsed(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(NODE_COLLAPSED_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function writeStoredPref(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式下写不进去，忽略即可 —— 这只是个记住偏好的便利。
  }
}
