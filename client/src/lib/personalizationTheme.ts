import {
  getPersonalizationThemePreset,
  linearGradient135,
  normalizePersonalizationCardStyle,
  normalizePersonalizationPageTint,
  normalizePersonalizationThemePresetId,
  normalizePersonalizationUiTheme,
  type PersonalizationUiThemeId,
  personalizationPageTintVars,
  primaryGradientStops,
} from "@shared/personalization";

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
const ACCENT_VARS = ["--fx-accent", "--fx-accent-strong", "--fx-accent-soft", "--fx-accent-fill", "--fx-accent-fill-foreground"] as const;

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

export function applyPersonalizationTheme(value: unknown, root?: HTMLElement) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  const id = normalizePersonalizationThemePresetId(value);
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
  界面主题（经典 / 极光 / 墨金 / 玫瑰）是 <html data-ui-theme>，画法全在 theme-*.css。经典不写属性。
  首屏在 publicInfo 回来之前先按经典画，再切到极光会闪一下：所以把选过的主题记进 localStorage，
  index.html 顶部那段内联脚本开机就按它先把属性挂上（和深浅色 forwardx-theme 同一套做法）。
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

export function readUiThemeOverride(): PersonalizationUiThemeId | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(UI_THEME_OVERRIDE_STORAGE_KEY);
    if (!raw) return null;
    const id = normalizePersonalizationUiTheme(raw);
    return id === raw ? id : null;
  } catch {
    return null;
  }
}

export function setUiThemeOverride(value: string | null) {
  try {
    if (typeof localStorage !== "undefined") {
      if (value) localStorage.setItem(UI_THEME_OVERRIDE_STORAGE_KEY, normalizePersonalizationUiTheme(value));
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

export function applyPersonalizationSurface(
  input: { pageTint?: unknown; cardStyle?: unknown; uiTheme?: unknown; ignoreOverride?: boolean },
  root?: HTMLElement,
) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  const pageTint = normalizePersonalizationPageTint(input.pageTint);
  const cardStyle = normalizePersonalizationCardStyle(input.cardStyle);
  const override = input.ignoreOverride ? null : readUiThemeOverride();
  const uiTheme = override ?? normalizePersonalizationUiTheme(input.uiTheme);
  if (!target) return { pageTint, cardStyle, uiTheme };
  target.setAttribute("data-card-style", cardStyle);
  if (uiTheme === "classic") target.removeAttribute("data-ui-theme");
  else target.setAttribute("data-ui-theme", uiTheme);
  rememberUiTheme(uiTheme);
  const dark = target.classList.contains("dark");
  fadeIfChanged(target, `${uiTheme}|${dark ? "dark" : "light"}|${pageTint}`);
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
  for (const cssVar of PAGE_TINT_VARS) target.style.removeProperty(cssVar);
  target.removeAttribute("data-page-tint");
  target.removeAttribute("data-card-style");
  target.removeAttribute("data-ui-theme");
  target.removeAttribute("data-fx-surface");
}
