import { useSyncExternalStore } from "react";
import { mobileAuth } from "@/lib/mobileAuth";

const MOBILE_BREAKPOINT = 768;

/*
  整个应用共用一个 matchMedia 订阅。

  原来每个用到它的组件各自 useState + useEffect：effect 里读 window.innerWidth —— 这一读会强制
  排版，而其他组件的 effect 又在中间改样式 / 启动动画，于是每读一次就重排一次。转发页一屏十几张
  卡、几十个组件都在用，一次刷新光这一个 hook 就吃掉近 100ms（2026-11-03 的性能剖析）。

  matchMedia 的 matches 只看视口宽度，不需要排版；useSyncExternalStore 又让首屏就是真实宽度，
  没有「先按桌面画一遍再改成手机」的那次返工。
*/
let mediaQuery: MediaQueryList | null = null;
const listeners = new Set<() => void>();

function getMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  if (!mediaQuery) {
    mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    mediaQuery.addEventListener("change", () => {
      listeners.forEach((listener) => listener());
    });
  }
  return mediaQuery;
}

function subscribe(listener: () => void) {
  getMediaQuery();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  if (mobileAuth.isNative) return true;
  const query = getMediaQuery();
  if (query) return query.matches;
  return typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT;
}

function getServerSnapshot() {
  return mobileAuth.isNative;
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
