/*
  首页「概览」地图收没收起来：记在这个浏览器里（localStorage），下次进来照旧。
  只是界面上的一个折叠，不值得为它在账号偏好里多存一个字段；无痕模式 / 存储被禁时每次都是展开的。
  Slot（占位）和卡片本身都要读它：收起时占位也只画标题那一行，页面不跳。
*/
const COLLAPSED_KEY = "forwardx.home.netmap.collapsed";

export function readNetworkMapCollapsed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeNetworkMapCollapsed(collapsed: boolean) {
  try {
    if (typeof window === "undefined") return;
    if (collapsed) window.localStorage.setItem(COLLAPSED_KEY, "1");
    else window.localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // 存不下就只管这一次：收起照样收起，下次进来是展开的
  }
}
