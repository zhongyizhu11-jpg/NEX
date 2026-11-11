import { MotionGlobalConfig } from "motion/react";

/*
  界面动画开关（个人资料 › 界面，上游 2.3.287），按账号存在 users.uiPreferences.motion（shared/uiPreferences.ts）。

  关掉时 <html data-motion="off">：
  · index.css 里一条全局规则把 CSS 的 transition / animation 压到一瞬（转圈的加载图标除外 —— 那是状态，不是装饰）；
  · motion（framer-motion）的动画是 JS / WAAPI 驱动的，不吃 CSS，用 MotionGlobalConfig.skipAnimations 直接跳到终点；
  · SectionTransition 这类自己判断的组件读 useMotionEnabled（components/LayoutLayer.tsx 旁边那套同样的做法）。

  刷新那一下 auth.me 还没回来：先按本机上次记住的挂上（main.tsx 里 applyRememberedMotion），
  和布局偏好（LayoutLayer）一样，免得先播一遍动画再停。
*/
export const MOTION_STORAGE_KEY = "forwardx.motion";
export const MOTION_ATTRIBUTE = "data-motion";

type MotionRoot = Pick<HTMLElement, "setAttribute" | "removeAttribute">;

export function applyMotionAttribute(enabled: boolean, root?: MotionRoot | null) {
  const target = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (target) {
    if (enabled) target.removeAttribute(MOTION_ATTRIBUTE);
    else target.setAttribute(MOTION_ATTRIBUTE, "off");
  }
  MotionGlobalConfig.skipAnimations = !enabled;
}

type MotionStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): MotionStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 本机记住的值：只有明确记成 "off" 才算关（没记过、读不到都按开）。 */
export function readRememberedMotion(storage: MotionStorage | null = defaultStorage()) {
  try {
    return storage?.getItem(MOTION_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function rememberMotion(enabled: boolean, storage: MotionStorage | null = defaultStorage()) {
  try {
    storage?.setItem(MOTION_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    /* 记不住就下次刷新多播一帧动画 */
  }
}

export function applyRememberedMotion(root?: MotionRoot | null, storage?: MotionStorage | null) {
  applyMotionAttribute(readRememberedMotion(storage === undefined ? defaultStorage() : storage), root);
}

export function isMotionAttributeOff(root?: Pick<HTMLElement, "getAttribute"> | null) {
  const target = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  return target?.getAttribute(MOTION_ATTRIBUTE) === "off";
}
