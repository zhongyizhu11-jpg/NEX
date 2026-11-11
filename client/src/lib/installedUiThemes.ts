import { useSyncExternalStore } from "react";

import { isValidUiThemePackageId, normalizeUiThemePreview, type UiThemePreview } from "@shared/uiThemePackage";

/*
  这个面板上装着哪些主题包（shared/uiThemePackage.ts），浏览器这头的一份名单。

  名单的来源是 system.publicInfo 的 installedUiThemes（PersonalizationLayer 拿到就写进来）。
  它要在 publicInfo 回来之前就能用：开机时 index.html 的内联脚本、main.tsx 要按上次记住的主题去下样式，
  得先知道「这个 id 是不是装着的主题、样式地址带哪个 revision、启动底色是什么」。所以每次更新都往
  localStorage 里记一份（UI_THEMES_STORAGE_KEY），开机先读它；publicInfo 回来后以服务端的为准。

  内置的三套（经典 / 珍珠 / 液态玻璃）不在这份名单里：它们的样式跟着页面打包，不用问服务端。
*/
export type InstalledUiTheme = {
  id: string;
  name: string;
  description: string;
  version: string;
  preview: UiThemePreview;
  /** 样式内容的 sha256；样式地址带着它，主题更新后地址跟着变 */
  revision: string;
};

export const UI_THEMES_STORAGE_KEY = "forwardx-ui-themes";

function sanitize(raw: unknown): InstalledUiTheme[] {
  if (!Array.isArray(raw)) return [];
  const list: InstalledUiTheme[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const id = String(source.id || "");
    const revision = String(source.revision || "");
    // revision 会拼进样式地址：只收 sha256 那种写法，别的（旧缓存、被人改过的 localStorage）整条不要
    if (!isValidUiThemePackageId(id) || seen.has(id) || !/^[a-f0-9]{16,64}$/.test(revision)) continue;
    seen.add(id);
    list.push({
      id,
      name: String(source.name || id).slice(0, 40),
      description: String(source.description || "").slice(0, 300),
      version: String(source.version || "").slice(0, 32),
      preview: normalizeUiThemePreview(source.preview),
      revision,
    });
  }
  return list;
}

function readCache(): InstalledUiTheme[] {
  try {
    if (typeof localStorage === "undefined") return [];
    return sanitize(JSON.parse(localStorage.getItem(UI_THEMES_STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

let installed: InstalledUiTheme[] | null = null;
const listeners = new Set<() => void>();

function current() {
  if (!installed) installed = readCache();
  return installed;
}

export function getInstalledUiThemes(): InstalledUiTheme[] {
  return current();
}

export function installedUiThemeIds(): string[] {
  return current().map((theme) => theme.id);
}

export function findInstalledUiTheme(id: string | null | undefined): InstalledUiTheme | null {
  if (!id) return null;
  return current().find((theme) => theme.id === id) || null;
}

function sameList(a: InstalledUiTheme[], b: InstalledUiTheme[]) {
  return a.length === b.length && a.every((theme, index) => theme.id === b[index].id
    && theme.revision === b[index].revision && theme.name === b[index].name
    && JSON.stringify(theme.preview) === JSON.stringify(b[index].preview));
}

/**
 * 用服务端给的名单换掉这一份。返回名单有没有变（变了，调用的人要重新算一遍现在该用哪套主题：
 * 也许刚装上的那套正是站点默认，也许正用着的那套被卸了）。
 */
export function setInstalledUiThemes(raw: unknown): boolean {
  const next = sanitize(raw);
  if (sameList(current(), next)) return false;
  installed = next;
  try {
    if (typeof localStorage !== "undefined") {
      if (next.length === 0) localStorage.removeItem(UI_THEMES_STORAGE_KEY);
      else localStorage.setItem(UI_THEMES_STORAGE_KEY, JSON.stringify(next.map(({ id, name, description, version, preview, revision }) => ({ id, name, description, version, preview, revision }))));
    }
  } catch {
    // 存不了只是下次开机少一份预载，不影响这一次
  }
  for (const listener of listeners) listener();
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 装着的主题包（名单一变组件跟着重渲染）。顶栏调色盘、设置页的主题列表用。 */
export function useInstalledUiThemes(): InstalledUiTheme[] {
  return useSyncExternalStore(subscribe, getInstalledUiThemes, getInstalledUiThemes);
}

/**
 * 服务端给的名单拼成一个短字符串（id@revision,…），给 React 的依赖比较用：接口每次返回的都是新数组，
 * 直接放进依赖里每次都算「变了」。不是数组（还没拿到）返回 null。
 */
export function uiThemeListKey(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((theme) => {
    const item = theme && typeof theme === "object" ? theme as Record<string, unknown> : {};
    return `${String(item.id ?? "")}@${String(item.revision ?? "")}`;
  }).join(",");
}

/** 测试用：忘掉内存里那份，下次重新读 localStorage。 */
export function resetInstalledUiThemesForTests() {
  installed = null;
}
