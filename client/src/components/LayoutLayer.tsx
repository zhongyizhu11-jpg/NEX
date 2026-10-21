import { useEffect } from "react";

import { useLayoutPreference } from "@/hooks/useCompactLayout";

/*
  把现在生效的布局写到 <html data-layout>：精简是 "compact"，标准不带属性。compact.css 现在对两种布局都生效
  （紧凑外壳就是标准），这个属性留给以后只在精简下才做的样式；四页的区别走页面上的 data-fx-std-page。
  刷新那一下 auth.me 还没回来，先按上次记住的值挂上，免得先画一遍标准再跳成精简。
*/
export const LAYOUT_STORAGE_KEY = "forwardx.layout";

export function applyLayoutAttribute(layout: string, root?: HTMLElement) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  if (!target) return;
  if (layout === "compact") target.setAttribute("data-layout", "compact");
  else target.removeAttribute("data-layout");
}

export function applyRememberedLayout() {
  if (typeof window === "undefined") return;
  try {
    applyLayoutAttribute(window.localStorage.getItem(LAYOUT_STORAGE_KEY) || "standard");
  } catch {
    /* 隐私模式读不到就先按标准画 */
  }
}

export default function LayoutLayer() {
  const { effective } = useLayoutPreference();
  useEffect(() => {
    applyLayoutAttribute(effective);
    try { window.localStorage.setItem(LAYOUT_STORAGE_KEY, effective); } catch { /* 记不住就下次刷新多画一帧 */ }
  }, [effective]);
  return null;
}
