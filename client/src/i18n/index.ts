import { createDomTranslator, type DomTranslator } from "./domTranslator";
import {
  formatLocaleFor,
  navigatorLanguages,
  readLanguagePreference,
  resolveLanguage,
  writeLanguagePreference,
  type Language,
  type LanguagePreference,
} from "./language";
import { PATTERNS } from "./patterns";
import { createTranslator, interpolate, type Dictionary, type TranslateValues, type Translator } from "./translate";

export { LANGUAGE_PREFERENCES, LANGUAGE_STORAGE_KEY, type Language, type LanguagePreference } from "./language";

/*
  界面语言的运行时状态。

  · 中文是源语言：getLanguage() === "zh-CN" 时 t() 原样返回，DOM 翻译器不挂，词典也不下载。
  · 英文词典（en.json，几百 KB）按需动态加载：中文用户的首包不变大。启动时如果记的是英文，
    main.tsx 会等 prepareLanguage() 把词典下完再挂 React，第一帧就是英文。
  · 页面上的字由 domTranslator 在绘制前换掉；t() 只给「拼字符串」的代码路径用（通知、确认框、标题）。
*/

let preference: LanguagePreference = readLanguagePreference();
let language: Language = resolveLanguage(preference, navigatorLanguages());
let translator: Translator | null = null;
let dictionaryPromise: Promise<Translator> | null = null;
let domTranslator: DomTranslator | null = null;
const listeners = new Set<() => void>();

function loadTranslator(): Promise<Translator> {
  if (translator) return Promise.resolve(translator);
  dictionaryPromise ??= import("./en.json").then((module) => {
    const dictionary = ((module as { default?: Dictionary }).default ?? module) as Dictionary;
    translator = createTranslator(dictionary, PATTERNS);
    return translator;
  });
  return dictionaryPromise;
}

/** 测试 / 预渲染直接塞一份词典进来，不走动态 import */
export function installDictionary(dictionary: Dictionary) {
  translator = createTranslator(dictionary, PATTERNS);
  dictionaryPromise = Promise.resolve(translator);
}

export function getLanguage(): Language {
  return language;
}

export function getLanguagePreference(): LanguagePreference {
  return preference;
}

/** toLocaleString / Intl 用的 locale：中文 zh-CN，英文 en-US */
export function getFormatLocale(): string {
  return formatLocaleFor(language);
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function englishActive(): Translator | null {
  return language === "en" ? translator : null;
}

/**
 * 拼字符串的地方用：t("已选 {n} 条", { n: 3 })。中文界面原样插值；英文界面先找整句（含占位的键），
 * 找不到再按模板 / 正则翻插值后的整句，都没有就是中文原文。
 */
export function t(source: string, values?: TranslateValues): string {
  const active = englishActive();
  if (!active) return interpolate(source, values);
  const hit = active.exact(source);
  if (hit != null) return interpolate(hit, values);
  const filled = interpolate(source, values);
  return active.translate(filled) ?? filled;
}

/** 已经拼好的一段界面文字（含模板 / 正则）；对不上原样返回 */
export function translateText(text: string): string {
  const active = englishActive();
  return active ? (active.translate(text) ?? text) : text;
}

/** 服务端给的中文（报错、通知）：只认整句精确匹配，认不出就留中文，不做模板猜测 */
export function translateServerText(text: string): string {
  const active = englishActive();
  return active ? (active.exact(text) ?? text) : text;
}

function getDomTranslator(): DomTranslator | null {
  if (typeof document === "undefined") return null;
  domTranslator ??= createDomTranslator({
    root: () => document.body,
    translate: (text) => translator?.translate(text) ?? null,
  });
  return domTranslator;
}

function syncDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
  const dom = getDomTranslator();
  if (!dom) return;
  if (language === "en" && translator) dom.start();
  else dom.stop();
  // 给自测 / 排查用：看翻译器每帧花了多少毫秒
  (globalThis as { __nexI18nStats?: unknown }).__nexI18nStats = dom.stats;
}

async function applyLanguage(next: Language) {
  if (next === "en") await loadTranslator();
  const changed = next !== language;
  language = next;
  syncDocument();
  if (changed) for (const listener of listeners) listener();
}

/**
 * 启动时调一次（main.tsx 挂 React 之前）：英文就先把词典下好并挂上翻译器。
 * 词典下不来（断网、旧缓存）就退回中文，不让整页卡在启动底色上。
 */
export async function prepareLanguage(): Promise<void> {
  try {
    await applyLanguage(language);
  } catch {
    language = "zh-CN";
    syncDocument();
  }
  if (typeof window !== "undefined") {
    // 跟随浏览器时，系统语言改了跟着走；别的标签页改了偏好，这里也跟上
    window.addEventListener("languagechange", () => {
      if (preference === "auto") void applyLanguage(resolveLanguage("auto", navigatorLanguages()));
    });
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== "forwardx.language") return;
      preference = readLanguagePreference();
      void applyLanguage(resolveLanguage(preference, navigatorLanguages()));
    });
  }
}

/** 换语言：记下偏好，原地切换（不刷新）。返回是否记住了（存储被禁用时只对这一页生效）。 */
export async function setLanguagePreference(next: LanguagePreference): Promise<boolean> {
  const saved = writeLanguagePreference(next);
  preference = next;
  await applyLanguage(resolveLanguage(next, navigatorLanguages()));
  for (const listener of listeners) listener();
  return saved;
}
