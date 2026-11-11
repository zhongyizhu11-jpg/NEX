/*
  界面语言的偏好与解析（纯函数 + 本地存储读写，不碰 DOM）。

  偏好三选一：auto（跟浏览器）/ zh-CN / en，存在 localStorage。auto 时浏览器语言里先出现中文就中文、
  先出现英文就英文，都没有就中文——NEX 的用户绝大多数是中文，拿不准时别把人突然切成英文。
  存储键和上游 poouo/Forwardx 一样，两边换着用记得住同一个选择。
*/

export type Language = "zh-CN" | "en";
export type LanguagePreference = Language | "auto";

export const LANGUAGE_STORAGE_KEY = "forwardx.language";
export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = ["auto", "zh-CN", "en"];

export function parseLanguagePreference(value: unknown): LanguagePreference {
  return value === "en" || value === "zh-CN" ? value : "auto";
}

export function browserLanguage(languages: readonly string[]): Language | null {
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return null;
}

export function resolveLanguage(preference: LanguagePreference, languages: readonly string[]): Language {
  if (preference !== "auto") return preference;
  return browserLanguage(languages) ?? "zh-CN";
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Safari 隐私模式 / 禁用站点数据时访问 localStorage 本身就会抛
    return null;
  }
}

export function readLanguagePreference(storage: StorageLike | null = defaultStorage()): LanguagePreference {
  try {
    return parseLanguagePreference(storage?.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

/** 记不住（存储被禁用）返回 false：这一页照样切过去，只是刷新后回到 auto */
export function writeLanguagePreference(preference: LanguagePreference, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    if (preference === "auto") storage.removeItem(LANGUAGE_STORAGE_KEY);
    else storage.setItem(LANGUAGE_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

export function navigatorLanguages(): readonly string[] {
  // Node 21+ 也有全局 navigator（语言取自系统 locale）：不在浏览器里就当没有，测试和工具脚本一律按中文
  if (typeof window === "undefined" || typeof navigator === "undefined") return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

export function formatLocaleFor(language: Language): string {
  return language === "en" ? "en-US" : "zh-CN";
}
