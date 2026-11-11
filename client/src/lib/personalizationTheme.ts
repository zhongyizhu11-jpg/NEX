import {
  getPersonalizationThemePreset,
  linearGradient135,
  normalizePersonalizationCardStyle,
  normalizePersonalizationPageTint,
  normalizePersonalizationThemePresetId,
  normalizePersonalizationUiTheme,
  personalizationPageTintVars,
  primaryGradientStops,
} from "@shared/personalization";

import { installedUiThemeIds } from "./installedUiThemes";
import { isUiThemeStyleReady, isUiThemeStyleUsable, loadUiThemeStyles, syncUiThemePackageSheets } from "./uiThemeStyles";

/*
  预设写到 <html> 上的变量。

  chart2～4 落到第 6～8 位（分类色），不再盖 --chart-2～4：那三位现在就是状态色
  （图表里的绿必须是列表里的绿），预设换的是强调色，不该把「正常」染成它的配色。
*/
const THEME_VAR_MAP = {
  primary: ["--primary", "--color-primary"],
  primaryForeground: ["--primary-foreground", "--color-primary-foreground"],
  ring: ["--ring", "--color-ring"],
  chart1: ["--chart-1", "--color-chart-1"],
  chart2: ["--chart-6", "--color-chart-6"],
  chart3: ["--chart-7", "--color-chart-7"],
  chart4: ["--chart-8", "--color-chart-8"],
  sidebarPrimary: ["--sidebar-primary", "--color-sidebar-primary"],
  sidebarPrimaryForeground: ["--sidebar-primary-foreground", "--color-sidebar-primary-foreground"],
  sidebarRing: ["--sidebar-ring", "--color-sidebar-ring"],
} as const;

/*
  强调色的三档也跟着预设走，否则换成紫藤之后按钮是紫的、侧栏选中项还是青的。
  字（--fx-accent）默认就用主色，主色太浅的预设自己给 accent；线用 ring；淡底从主色兑 12%。
  --fx-path / --fx-flow-in / --fx-focus-ring 在令牌里都指向 --fx-accent，不用单独写。
*/
const ACCENT_VARS = ["--fx-accent", "--fx-accent-strong", "--fx-accent-soft", "--fx-accent-fill", "--fx-accent-fill-foreground", "--fx-on-accent"] as const;

/*
  主色控件的那道渐变也跟着预设走。2.3.375 把主按钮、选中的分段项 / chip / 侧栏项、开关换成
  --fx-primary-gradient 之后，这里只改了强调色，换成薰衣草时按钮还是天蓝 —— 用户看到的就是「没生效」。
  渐变两端由主色推出来（见 shared/personalization.ts 的 primaryGradientStops），字色用预设的 primaryForeground。
  --fx-mesh-1 是首页背景那团最大的淡色，也换成主色，对得上「背景轻微渐变会同步变化」那句说明。
*/
const PRIMARY_CONTROL_VARS = [
  "--fx-primary-gradient",
  "--fx-primary-gradient-hover",
  "--fx-primary-fill",
  "--fx-primary-fill-hover",
  "--fx-primary-text",
  "--fx-primary-stroke",
  "--fx-primary-shadow",
  "--fx-mesh-1",
] as const;

type PresetColors = { primary: string; primaryForeground: string; ring: string; accent?: string };

function presetFollowsTokens(preset: unknown) {
  return (preset as { followsTokens?: boolean }).followsTokens === true;
}

/*
  设置 › 个性化里点一下「试看」的那一份（配色 / 页面底色 / 卡片风格 / 界面主题）。

  试看只是把草稿挂到页面上，没存。可 PersonalizationLayer 一直盯着 <html> 的 class（深浅色切换要重算底色），
  每次变化都按**存着的**站点设置重挂一遍 —— 而换主题那一下的淡入本身就会往 class 上加 fx-theme-fading，
  于是试看刚挂上就被它当场改回去，点了等于没点（2.3.524 及以前一直这样）。
  现在试看的值记在这里：只要它在，谁来重挂页面上的 <html>，挂的都是试看的这一份；设置页存了或离开时清掉。
  只管页面上那个 <html>：测试里传进来的假节点不受影响。
*/
export type PersonalizationPreview = { theme?: unknown; pageTint?: unknown; cardStyle?: unknown; uiTheme?: unknown };
let personalizationPreview: PersonalizationPreview | null = null;

export function setPersonalizationPreview(preview: PersonalizationPreview | null) {
  personalizationPreview = preview ? { ...preview } : null;
}

function previewFor(target: HTMLElement) {
  return personalizationPreview && typeof document !== "undefined" && target === document.documentElement ? personalizationPreview : null;
}

export function applyPersonalizationTheme(value: unknown, root?: HTMLElement) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  const previewed = target ? previewFor(target) : null;
  const id = normalizePersonalizationThemePresetId(previewed && previewed.theme !== undefined ? previewed.theme : value);
  if (!target) return id;
  const preset = getPersonalizationThemePreset(id);
  /*
    「面板默认」不写任何变量：让 design-tokens.css 里的值直接生效。写成
    `--fx-accent: var(--fx-accent)` 是自引用，浏览器会把整条链判成无效。
  */
  if (presetFollowsTokens(preset)) {
    clearThemeVariables(target);
    target.setAttribute("data-personalization-theme", id);
    return id;
  }
  const mode = target.classList.contains("dark") ? "dark" : "light";
  const values = mode === "dark" ? preset.dark : preset.light;
  for (const [key, cssVars] of Object.entries(THEME_VAR_MAP)) {
    const cssValue = values[key as keyof typeof values];
    for (const cssVar of cssVars) {
      target.style.setProperty(cssVar, cssValue);
    }
  }
  const colors = values as PresetColors;
  target.style.setProperty("--fx-accent", colors.accent || colors.primary);
  target.style.setProperty("--fx-accent-strong", colors.ring);
  target.style.setProperty("--fx-accent-soft", `color-mix(in srgb, ${colors.primary} 12%, transparent)`);
  target.style.setProperty("--fx-accent-fill", colors.primary);
  target.style.setProperty("--fx-accent-fill-foreground", colors.primaryForeground);
  /*
    强调色上的字：强调色就是主色时用主色配的字色；单给了 accent 的预设，浅色下 accent 偏深、
    深色下偏浅，用反色字（浅色白、深色近黑）正好对得上。
  */
  target.style.setProperty("--fx-on-accent", colors.accent ? "var(--fx-text-inverse)" : colors.primaryForeground);
  const [from, to] = primaryGradientStops(colors.primary, mode);
  const darker = (color: string) => `color-mix(in oklab, ${color} 90%, black)`;
  target.style.setProperty("--fx-primary-gradient", linearGradient135([from, to]));
  target.style.setProperty("--fx-primary-gradient-hover", linearGradient135([darker(from), darker(to)]));
  target.style.setProperty("--fx-primary-fill", to);
  target.style.setProperty("--fx-primary-fill-hover", darker(to));
  target.style.setProperty("--fx-primary-text", colors.primaryForeground);
  target.style.setProperty("--fx-primary-stroke", `color-mix(in srgb, ${colors.primary} 45%, transparent)`);
  target.style.setProperty("--fx-primary-shadow", `0 8px 18px -10px color-mix(in srgb, ${to} 70%, transparent)`);
  target.style.setProperty("--fx-mesh-1", `color-mix(in srgb, ${colors.primary} ${mode === "dark" ? 18 : 22}%, transparent)`);
  target.setAttribute("data-personalization-theme", id);
  return id;
}

function clearThemeVariables(target: HTMLElement) {
  for (const cssVars of Object.values(THEME_VAR_MAP)) {
    for (const cssVar of cssVars) {
      target.style.removeProperty(cssVar);
    }
  }
  for (const cssVar of [...ACCENT_VARS, ...PRIMARY_CONTROL_VARS]) {
    target.style.removeProperty(cssVar);
  }
}

export function clearPersonalizationTheme(root?: HTMLElement) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  if (!target) return;
  clearThemeVariables(target);
  target.removeAttribute("data-personalization-theme");
}

/*
  页面底色和卡片风格（设置 › 个性化）。

  底色只在浅色下写：--fx-l0-page 是页面底，--fx-l3-control-fill 是坐在页面上的搜索框 / 分段
  控件的槽。深色模式下两个都不写，让令牌里的炭灰生效 —— 内联在 <html> 上的变量会盖过
  .dark 那一组，所以切到深色时要主动撤掉，PersonalizationLayer 在 class 变化时会再调一次。
  卡片风格只是 <html> 上一个属性，四种画法都在 workspace.css 里按它选。
*/
const PAGE_TINT_VARS = ["--fx-l0-page", "--fx-l3-control-fill"] as const;

/*
  界面主题（内置的经典 / 珍珠 / 液态玻璃，和装上去的主题包）是 <html data-ui-theme>，画法在各自的样式里。经典不写属性。
  首屏在 publicInfo 回来之前先按经典画，再切到极光会闪一下：所以把选过的主题记进 localStorage，
  index.html 顶部那段内联脚本开机就按它先把属性挂上（和深浅色 forwardx-theme 同一套做法）。
  主题样式现在按需下（uiThemeStyles.ts），main.tsx 也按这个属性先把那一套的样式下完再画第一帧。
*/
export const UI_THEME_STORAGE_KEY = "forwardx-ui-theme";

function rememberUiTheme(uiTheme: string) {
  try {
    if (typeof localStorage === "undefined") return;
    if (uiTheme === "classic") localStorage.removeItem(UI_THEME_STORAGE_KEY);
    else localStorage.setItem(UI_THEME_STORAGE_KEY, uiTheme);
  } catch {
    // 隐私模式 / 存储被禁用：只是少了首屏预载，不影响功能
  }
}

/*
  「我自己看哪一套」（顶栏调色盘，2026-10-11 参考 Rosélune 面板加的）：站点默认是管理员在设置里存的那套，
  每个人还可以在顶栏给自己选一套，只记在这台设备上（localStorage），不影响别人。没选就跟站点默认。
  设置页里点主题卡片「试看」时要看的是站点默认那一套，所以那里传 ignoreOverride 绕过它。
*/
export const UI_THEME_OVERRIDE_STORAGE_KEY = "forwardx-ui-theme-override";
export const UI_THEME_OVERRIDE_EVENT = "fx-ui-theme-override";

/*
  主题安全模式：地址带上 ?themeSafe=1，这个浏览器标签页里不挂任何主题包，只认内置的三套。
  主题包是别人写的样式，写坏了可能把按钮都藏起来；站点默认又是存在服务端的，清本地存储没用。
  进了安全模式就能照常进设置页把它换掉或卸载。记在 sessionStorage：关掉标签页就恢复，?themeSafe=0 当场退出。
  index.html 开机那段脚本认同一个开关。
*/
export const UI_THEME_SAFE_MODE_KEY = "forwardx-ui-theme-safe";

export function isUiThemeSafeMode(): boolean {
  try {
    if (typeof window === "undefined" || typeof sessionStorage === "undefined") return false;
    const flag = new URLSearchParams(window.location?.search || "").get("themeSafe");
    if (flag === "1") sessionStorage.setItem(UI_THEME_SAFE_MODE_KEY, "1");
    else if (flag === "0") sessionStorage.removeItem(UI_THEME_SAFE_MODE_KEY);
    return sessionStorage.getItem(UI_THEME_SAFE_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 一个主题 id 现在该按哪一套画：内置的、这个面板上装着的主题包都认（安全模式下只认内置的），别的回到经典。 */
export function resolveUiTheme(value: unknown): string {
  return normalizePersonalizationUiTheme(value, isUiThemeSafeMode() ? [] : installedUiThemeIds());
}

export function readUiThemeOverride(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(UI_THEME_OVERRIDE_STORAGE_KEY);
    if (!raw) return null;
    // 选的那套主题包后来被卸载了：当没选，跟回站点默认（记录留着，装回来又生效）
    const id = resolveUiTheme(raw);
    return id === raw ? id : null;
  } catch {
    return null;
  }
}

export function setUiThemeOverride(value: string | null) {
  try {
    if (typeof localStorage !== "undefined") {
      if (value) localStorage.setItem(UI_THEME_OVERRIDE_STORAGE_KEY, resolveUiTheme(value));
      else localStorage.removeItem(UI_THEME_OVERRIDE_STORAGE_KEY);
    }
  } catch {
    // 存不了就只在这一次生效
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof Event === "function") {
    window.dispatchEvent(new Event(UI_THEME_OVERRIDE_EVENT));
  }
}

/*
  浏览器外框的颜色（<meta name="theme-color">）：iOS Safari 的地址栏 / 状态栏、安卓 Chrome 的顶栏
  会涂成这个颜色。跟着页面底色走，切到玫瑰时外框也是胭脂粉，不再是一条白边。
  读的是算出来的 --fx-l0-page，所以页面底色设置、深浅色都算在里面。
*/
function syncThemeColorMeta(target: HTMLElement) {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return;
  if (target !== document.documentElement) return;
  const page = getComputedStyle(target).getPropertyValue("--fx-l0-page").trim();
  if (!page) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head?.appendChild(meta);
  }
  if (meta.content !== page) meta.content = page;
}

/*
  换主题 / 深浅色时 0.5 秒淡过去，不是一下跳过去（参考站 body 上的 .5s 过渡）。只在「换」的那一下
  给 <html> 挂 fx-theme-fading，0.6 秒后摘掉，平时不带任何过渡（不影响滚动和别的动画）。
  第一次挂上（开机）不淡：开机那一下本来就该是最终的样子。
*/
const FADE_CLASS = "fx-theme-fading";
const fadeTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
function fadeIfChanged(target: HTMLElement, key: string) {
  const previous = target.getAttribute("data-fx-surface");
  target.setAttribute("data-fx-surface", key);
  if (previous === null || previous === key) return;
  if (typeof setTimeout !== "function") return;
  target.classList.add(FADE_CLASS);
  const timer = fadeTimers.get(target);
  if (timer) clearTimeout(timer);
  fadeTimers.set(target, setTimeout(() => {
    target.classList.remove(FADE_CLASS);
    fadeTimers.delete(target);
  }, 600));
}

/*
  界面主题的样式是按需下的（uiThemeStyles.ts）：属性只在那一套的样式到了之后才改，没到之前屏幕上
  还是原来那一套。下面两张表按 <html> 记：
    pendingUiTheme  正在等样式的那一套。等的时候又换了一套（连点几下），先到的旧样式回来时对不上号就作废。
    clearedUiTheme  clearPersonalizationSurface 刚撤掉的那一套。PersonalizationLayer 的依赖一变（比如顶栏
                    调色盘存了站点主题），React 会先跑上一轮的清理、紧接着再挂新的 —— 新的那套要是还在下，
                    中间这段属性是空的，就会先闪一下经典。同一轮里接着来的那次 apply 发现要等，就把刚撤掉的
                    那套先放回去顶着；下一个微任务就忘掉（真卸载时不会有人接着 apply）。
  只有页面上那个 <html> 走这条路；测试里传进来的假节点、没有 document 的环境照旧同步挂上。
*/
const pendingUiTheme = new WeakMap<HTMLElement, { uiTheme: string; pageTint: string }>();
const clearedUiTheme = new WeakMap<HTMLElement, string>();

function isDocumentRoot(target: HTMLElement) {
  return typeof document !== "undefined" && target === document.documentElement;
}

function commitUiTheme(target: HTMLElement, requested: string, pageTint: string) {
  // 主题包的样式没取下来（刚被卸载、面板连不上）：挂它的 id 只会得到没有样式的四不像，退回经典
  const uiTheme = isDocumentRoot(target) && !isUiThemeStyleUsable(requested) ? "classic" : requested;
  if (uiTheme === "classic") target.removeAttribute("data-ui-theme");
  else target.setAttribute("data-ui-theme", uiTheme);
  if (isDocumentRoot(target)) syncUiThemePackageSheets(uiTheme);
  const dark = target.classList.contains("dark");
  fadeIfChanged(target, `${uiTheme}|${dark ? "dark" : "light"}|${pageTint}`);
}

export function applyPersonalizationSurface(
  input: { pageTint?: unknown; cardStyle?: unknown; uiTheme?: unknown; ignoreOverride?: boolean },
  root?: HTMLElement,
) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  const previewed = target ? previewFor(target) : null;
  const pageTint = normalizePersonalizationPageTint(previewed && previewed.pageTint !== undefined ? previewed.pageTint : input.pageTint);
  const cardStyle = normalizePersonalizationCardStyle(previewed && previewed.cardStyle !== undefined ? previewed.cardStyle : input.cardStyle);
  // 试看的是站点默认那一套：和 ignoreOverride 一样绕过顶栏给自己选的
  const override = input.ignoreOverride || (previewed && previewed.uiTheme !== undefined) ? null : readUiThemeOverride();
  const uiTheme = override ?? resolveUiTheme(previewed && previewed.uiTheme !== undefined ? previewed.uiTheme : input.uiTheme);
  if (!target) return { pageTint, cardStyle, uiTheme };
  target.setAttribute("data-card-style", cardStyle);
  const ready = !isDocumentRoot(target) || isUiThemeStyleReady(uiTheme);
  const cleared = clearedUiTheme.get(target);
  clearedUiTheme.delete(target);
  if (ready) {
    pendingUiTheme.delete(target);
    commitUiTheme(target, uiTheme, pageTint);
  } else {
    pendingUiTheme.set(target, { uiTheme, pageTint });
    if (cleared && target.getAttribute("data-ui-theme") === null && isUiThemeStyleReady(cleared)) target.setAttribute("data-ui-theme", cleared);
    void loadUiThemeStyles(uiTheme).then(() => {
      // 等的这段时间里又来过几次 apply（深浅色切换会再调一次）：用最后一次的底色算淡入的 key
      const pending = pendingUiTheme.get(target);
      if (!pending || pending.uiTheme !== uiTheme) return;
      pendingUiTheme.delete(target);
      commitUiTheme(target, pending.uiTheme, pending.pageTint);
      syncThemeColorMeta(target);
    });
  }
  // 记的是「要的」那一套，不等样式：这时候刷新，开机就直接去下它
  rememberUiTheme(uiTheme);
  const dark = target.classList.contains("dark");
  const vars = dark ? null : personalizationPageTintVars(pageTint);
  if (vars) {
    target.style.setProperty("--fx-l0-page", vars.page);
    target.style.setProperty("--fx-l3-control-fill", vars.control);
    target.setAttribute("data-page-tint", pageTint);
  } else {
    for (const cssVar of PAGE_TINT_VARS) target.style.removeProperty(cssVar);
    target.removeAttribute("data-page-tint");
  }
  syncThemeColorMeta(target);
  return { pageTint, cardStyle, uiTheme };
}

export function clearPersonalizationSurface(root?: HTMLElement) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  if (!target) return;
  pendingUiTheme.delete(target);
  const shown = target.getAttribute("data-ui-theme");
  if (shown && isDocumentRoot(target)) {
    clearedUiTheme.set(target, shown);
    queueMicrotask(() => { if (clearedUiTheme.get(target) === shown) clearedUiTheme.delete(target); });
  }
  for (const cssVar of PAGE_TINT_VARS) target.style.removeProperty(cssVar);
  target.removeAttribute("data-page-tint");
  target.removeAttribute("data-card-style");
  target.removeAttribute("data-ui-theme");
  target.removeAttribute("data-fx-surface");
}
