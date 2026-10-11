export const BUILTIN_WALLPAPERS = [
  { id: "anime-1", name: "插画 1", url: "/wallpapers/anime-1.jpg" },
  { id: "anime-2", name: "二次元 2", url: "/wallpapers/anime-2.jpg" },
  { id: "anime-3", name: "二次元 3", url: "/wallpapers/anime-3.jpg" },
  { id: "anime-4", name: "二次元 4", url: "/wallpapers/anime-4.jpg" },
  { id: "illustration-1", name: "二次元 1", url: "/wallpapers/illustration-1.jpg" },
] as const;

export type BuiltinWallpaperId = typeof BUILTIN_WALLPAPERS[number]["id"];

/*
  配色预设换的是**强调色**（主按钮、开关、选中项、焦点环、路径、入站流量），
  状态色（健康 / 警告 / 故障）不跟着换 —— 它们说的是「它现在好不好」，换了预设也不该变。

  `ink` 是每个面板出厂就写进设置表的那个 id（dbSchema 的默认值），所以它就是「面板默认」：
  不往 <html> 上写任何变量，让 shared/design-tokens.css 里的天蓝强调和浅深色两套值直接生效。
  想要以前那种黑白的选 `mono`，想要上一版的薰衣草紫选 `lavender`。其余预设只给出 primary / ring 这几个值，
  强调色的三档由 applyPersonalizationTheme 从它们推出来（见 client/src/lib/personalizationTheme.ts）。
  `accent` 是可选的：给那些主色太浅、直接当小字过不了 4.5:1 的预设（樱粉、暖阳）。
*/
export const PERSONALIZATION_THEME_PRESETS = [
  {
    id: "ink",
    name: "面板默认",
    description: "跟随面板自带的配色：主按钮和选中项是一道天蓝渐变，白底细线卡片、炭灰深色，浅深色各一套。",
    swatches: ["#56aaf2", "#e6f2fc", "#1e1e1e"],
    followsTokens: true,
    light: {
      primary: "var(--fx-accent-fill)",
      primaryForeground: "var(--fx-accent-fill-foreground)",
      ring: "var(--fx-accent)",
      chart1: "var(--fx-chart-1)",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "var(--fx-accent-fill)",
      sidebarPrimaryForeground: "var(--fx-accent-fill-foreground)",
      sidebarRing: "var(--fx-accent)",
    },
    dark: {
      primary: "var(--fx-accent-fill)",
      primaryForeground: "var(--fx-accent-fill-foreground)",
      ring: "var(--fx-accent)",
      chart1: "var(--fx-chart-1)",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "var(--fx-accent-fill)",
      sidebarPrimaryForeground: "var(--fx-accent-fill-foreground)",
      sidebarRing: "var(--fx-accent)",
    },
  },
  {
    id: "mono",
    name: "墨色",
    description: "黑白灰：主按钮和选中项反黑，只有状态色带颜色。",
    swatches: ["#0a0a0a", "#e9e9e9", "#707070"],
    light: {
      primary: "var(--fx-text)",
      primaryForeground: "var(--fx-text-inverse)",
      ring: "var(--fx-text-secondary)",
      accent: "var(--fx-text)",
      chart1: "var(--fx-text-secondary)",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "var(--fx-text)",
      sidebarPrimaryForeground: "var(--fx-text-inverse)",
      sidebarRing: "var(--fx-text-secondary)",
    },
    dark: {
      primary: "var(--fx-text)",
      primaryForeground: "var(--fx-text-inverse)",
      ring: "var(--fx-text-secondary)",
      accent: "var(--fx-text)",
      chart1: "var(--fx-text-secondary)",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "var(--fx-text)",
      sidebarPrimaryForeground: "var(--fx-text-inverse)",
      sidebarRing: "var(--fx-text-secondary)",
    },
  },
  {
    id: "lavender",
    name: "薰衣草",
    description: "上一版的淡紫强调：字 #6550b9、实色 #6e56cf、淡底 #e5dff5。",
    swatches: ["#6e56cf", "#e5dff5", "#6550b9"],
    light: {
      primary: "#6e56cf",
      primaryForeground: "#ffffff",
      ring: "#7d66d9",
      accent: "#6550b9",
      chart1: "#6e56cf",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#6e56cf",
      sidebarPrimaryForeground: "#ffffff",
      sidebarRing: "#7d66d9",
    },
    dark: {
      primary: "#6e56cf",
      primaryForeground: "#ffffff",
      ring: "#7d66d9",
      accent: "#baa7ff",
      chart1: "#baa7ff",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#6e56cf",
      sidebarPrimaryForeground: "#ffffff",
      sidebarRing: "#7d66d9",
    },
  },
  {
    id: "teal",
    name: "松石",
    description: "清爽青绿色，和浅色玻璃背景更协调。",
    swatches: ["#0f766e", "#99f6e4", "#134e4a"],
    light: {
      primary: "oklch(0.48 0.12 180)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.58 0.10 180)",
      chart1: "oklch(0.58 0.13 178)",
      chart2: "oklch(0.64 0.14 165)",
      chart3: "oklch(0.58 0.10 205)",
      chart4: "oklch(0.70 0.13 95)",
      sidebarPrimary: "oklch(0.48 0.12 180)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.58 0.10 180)",
    },
    dark: {
      primary: "oklch(0.72 0.14 180)",
      primaryForeground: "oklch(0.12 0.02 190)",
      ring: "oklch(0.72 0.11 180)",
      chart1: "oklch(0.72 0.14 180)",
      chart2: "oklch(0.76 0.14 165)",
      chart3: "oklch(0.72 0.10 205)",
      chart4: "oklch(0.80 0.13 95)",
      sidebarPrimary: "oklch(0.72 0.14 180)",
      sidebarPrimaryForeground: "oklch(0.12 0.02 190)",
      sidebarRing: "oklch(0.72 0.11 180)",
    },
  },
  {
    id: "forest",
    name: "森绿",
    description: "偏稳重的绿色，适合运维和资源管理场景。",
    swatches: ["#166534", "#86efac", "#14532d"],
    light: {
      primary: "oklch(0.43 0.12 145)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.54 0.10 145)",
      chart1: "oklch(0.56 0.13 145)",
      chart2: "oklch(0.60 0.15 135)",
      chart3: "oklch(0.50 0.10 170)",
      chart4: "oklch(0.70 0.13 95)",
      sidebarPrimary: "oklch(0.43 0.12 145)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.54 0.10 145)",
    },
    dark: {
      primary: "oklch(0.72 0.14 145)",
      primaryForeground: "oklch(0.12 0.02 150)",
      ring: "oklch(0.72 0.11 145)",
      chart1: "oklch(0.72 0.14 145)",
      chart2: "oklch(0.76 0.15 135)",
      chart3: "oklch(0.70 0.10 170)",
      chart4: "oklch(0.80 0.13 95)",
      sidebarPrimary: "oklch(0.72 0.14 145)",
      sidebarPrimaryForeground: "oklch(0.12 0.02 150)",
      sidebarRing: "oklch(0.72 0.11 145)",
    },
  },
  {
    id: "wisteria",
    name: "紫藤",
    description: "低饱和紫色，保留一点个性但不刺眼。",
    swatches: ["#6d28d9", "#ddd6fe", "#312e81"],
    light: {
      primary: "oklch(0.45 0.13 300)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.58 0.09 300)",
      chart1: "oklch(0.56 0.13 300)",
      chart2: "oklch(0.62 0.11 330)",
      chart3: "oklch(0.58 0.12 270)",
      chart4: "oklch(0.70 0.12 25)",
      sidebarPrimary: "oklch(0.45 0.13 300)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.58 0.09 300)",
    },
    dark: {
      primary: "oklch(0.74 0.13 300)",
      primaryForeground: "oklch(0.14 0.02 300)",
      ring: "oklch(0.74 0.10 300)",
      chart1: "oklch(0.74 0.13 300)",
      chart2: "oklch(0.78 0.11 330)",
      chart3: "oklch(0.74 0.12 270)",
      chart4: "oklch(0.80 0.12 25)",
      sidebarPrimary: "oklch(0.74 0.13 300)",
      sidebarPrimaryForeground: "oklch(0.14 0.02 300)",
      sidebarRing: "oklch(0.74 0.10 300)",
    },
  },
  {
    id: "ember",
    name: "暖阳",
    description: "温暖琥珀色，适合偏活泼的面板风格。",
    swatches: ["#92400e", "#fcd34d", "#451a03"],
    light: {
      primary: "oklch(0.50 0.12 70)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.62 0.10 70)",
      accent: "oklch(0.46 0.12 70)",
      chart1: "oklch(0.62 0.14 75)",
      chart2: "oklch(0.66 0.13 45)",
      chart3: "oklch(0.58 0.11 85)",
      chart4: "oklch(0.70 0.14 30)",
      sidebarPrimary: "oklch(0.50 0.12 70)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.62 0.10 70)",
    },
    dark: {
      primary: "oklch(0.78 0.14 75)",
      primaryForeground: "oklch(0.16 0.03 70)",
      ring: "oklch(0.78 0.11 75)",
      chart1: "oklch(0.78 0.14 75)",
      chart2: "oklch(0.80 0.13 45)",
      chart3: "oklch(0.76 0.11 85)",
      chart4: "oklch(0.82 0.14 30)",
      sidebarPrimary: "oklch(0.78 0.14 75)",
      sidebarPrimaryForeground: "oklch(0.16 0.03 70)",
      sidebarRing: "oklch(0.78 0.11 75)",
    },
  },
  {
    id: "sakura",
    name: "樱粉",
    description: "偏少女感的泡泡糖粉，适合柔和甜一点的面板风格。",
    swatches: ["#ff4fa3", "#ffd6ea", "#c4b5fd"],
    light: {
      primary: "oklch(0.70 0.18 350)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.78 0.12 350)",
      accent: "oklch(0.55 0.20 350)",
      chart1: "oklch(0.74 0.16 350)",
      chart2: "oklch(0.86 0.08 15)",
      chart3: "oklch(0.80 0.12 325)",
      chart4: "oklch(0.82 0.10 285)",
      sidebarPrimary: "oklch(0.70 0.18 350)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.78 0.12 350)",
    },
    dark: {
      primary: "oklch(0.86 0.14 350)",
      primaryForeground: "oklch(0.16 0.03 350)",
      ring: "oklch(0.88 0.11 350)",
      chart1: "oklch(0.86 0.14 350)",
      chart2: "oklch(0.90 0.08 15)",
      chart3: "oklch(0.88 0.11 325)",
      chart4: "oklch(0.86 0.10 285)",
      sidebarPrimary: "oklch(0.86 0.14 350)",
      sidebarPrimaryForeground: "oklch(0.16 0.03 350)",
      sidebarRing: "oklch(0.88 0.11 350)",
    },
  },
] as const;

export type PersonalizationThemePresetId = typeof PERSONALIZATION_THEME_PRESETS[number]["id"];

/*
  主色控件（主按钮、选中的分段项 / chip / 侧栏项、开关、复选框）是一道渐变，走令牌 --fx-primary-gradient。
  「面板默认」的两端就是 design-tokens.css 里那两组（照 kfchost 主按钮量的），这里抄一份给设置页的色块用，
  shared/personalization.test.ts 守着两边一致。其余预设从各自的主色推：浅色是「主色兑白 → 主色」，
  深色是「主色 → 主色兑黑」—— 和默认那道一样，左上亮、右下深。
*/
export const PANEL_DEFAULT_PRIMARY_GRADIENT = {
  light: ["#8ccfff", "#56aaf2"],
  dark: ["#5fb0f5", "#2f86d6"],
} as const;

export function primaryGradientStops(primary: string, mode: "light" | "dark"): [string, string] {
  return mode === "dark"
    ? [primary, `color-mix(in oklab, ${primary} 75%, black)`]
    : [`color-mix(in oklab, ${primary} 65%, white)`, primary];
}

export function linearGradient135([from, to]: readonly [string, string]) {
  return `linear-gradient(135deg, ${from} 0%, ${to} 100%)`;
}

/** 设置页色卡上第一枚色块：这套预设在浅色下主按钮的那道渐变。 */
export function personalizationSwatchGradient(value: unknown) {
  const preset = getPersonalizationThemePreset(value);
  if ((preset as { followsTokens?: boolean }).followsTokens === true) {
    return linearGradient135(PANEL_DEFAULT_PRIMARY_GRADIENT.light);
  }
  return linearGradient135(primaryGradientStops(preset.swatches[0], "light"));
}

export function normalizePersonalizationThemePresetId(value: unknown): PersonalizationThemePresetId {
  const text = String(value || "").trim();
  return PERSONALIZATION_THEME_PRESETS.some((preset) => preset.id === text)
    ? text as PersonalizationThemePresetId
    : "ink";
}

export function getPersonalizationThemePreset(value: unknown) {
  const id = normalizePersonalizationThemePresetId(value);
  return PERSONALIZATION_THEME_PRESETS.find((preset) => preset.id === id) || PERSONALIZATION_THEME_PRESETS[0];
}

export type PersonalizationBackgroundSource = "none" | "builtin" | "upload" | "url";
export type PersonalizationBackgroundUrlType = "image" | "video";

export type PersonalizationBackgroundImage = {
  id: string;
  name: string;
  dataUrl: string;
  size?: number;
  createdAt?: number;
};

export type PersonalizationBackgroundConfig = {
  source: PersonalizationBackgroundSource;
  opacity: number;
  blur: number;
  selectedId: string | null;
  url: string;
  urlType: PersonalizationBackgroundUrlType;
  images: PersonalizationBackgroundImage[];
};

export const DEFAULT_PERSONALIZATION_BACKGROUND: PersonalizationBackgroundConfig = {
  source: "none",
  opacity: 0.22,
  blur: 0,
  selectedId: null,
  url: "",
  urlType: "image",
  images: [],
};

export function isBuiltinWallpaperId(value: unknown): value is BuiltinWallpaperId {
  return BUILTIN_WALLPAPERS.some((item) => item.id === value);
}

export function builtinWallpaperById(value: unknown) {
  return BUILTIN_WALLPAPERS.find((item) => item.id === value) || null;
}

export function clampBackgroundOpacity(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PERSONALIZATION_BACKGROUND.opacity;
  return Math.min(1, Math.max(0, num));
}

export function clampBackgroundBlur(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PERSONALIZATION_BACKGROUND.blur;
  return Math.min(32, Math.max(0, num));
}

/*
  页面底色（设置 › 个性化 › 页面底色）。

  白卡下面那一层的颜色。浅色模式下页面本来是 iOS 的 #f5f5f7 浅灰，这里给几种同样很淡的
  冷暖底色、一种「跟随配色」（当前主色兑到近白），和一个自定义十六进制色。深色模式不受影响：
  炭灰页面是成套设计的，换底色只会把卡片的层次弄乱。

  存储值是预设 id，或一个小写的 #rrggbb（自定义）。`grey` 是出厂值，意思是「不覆盖令牌」。
  和底色配套的还有一档「控件槽」色（搜索框、分段控件的槽）：白卡坐在底色上靠软影成形，
  而搜索框直接坐在底色上，得比底色再深一档才成形，所以底色一换它也要换。
*/
export const PERSONALIZATION_PAGE_TINTS = [
  { id: "grey", name: "浅灰", page: "#f5f5f7", control: "#e9e9e9", followsTokens: true },
  { id: "cool", name: "冷白", page: "#f3f5f9", control: "#e4e8ef" },
  { id: "warm", name: "暖米", page: "#f8f5ef", control: "#ebe6da" },
  { id: "mist", name: "雾蓝", page: "#edf3fb", control: "#d9e5f2" },
  { id: "lilac", name: "淡紫", page: "#f3f0fa", control: "#e3ddf0" },
  { id: "mint", name: "薄荷", page: "#eef6f2", control: "#d9e9e1" },
  { id: "accent", name: "跟随配色", page: "color-mix(in srgb, var(--fx-primary-fill) 8%, #f8f8f9)", control: "color-mix(in srgb, var(--fx-primary-fill) 16%, #ebebec)" },
] as const;

export type PersonalizationPageTintId = typeof PERSONALIZATION_PAGE_TINTS[number]["id"];

const HEX_COLOR = /^#([0-9a-f]{6})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value.trim());
}

/** 预设 id 或 #rrggbb；别的一律回到浅灰。 */
export function normalizePersonalizationPageTint(value: unknown): PersonalizationPageTintId | `#${string}` {
  const text = String(value || "").trim();
  if (PERSONALIZATION_PAGE_TINTS.some((tint) => tint.id === text)) return text as PersonalizationPageTintId;
  if (isHexColor(text)) return text.toLowerCase() as `#${string}`;
  return "grey";
}

/**
 * 这个底色要写到 <html> 上的两个变量；`grey` 返回 null（不写，令牌直接生效）。
 * 自定义色的控件槽从底色兑 5% 黑推出来（#f5f5f7 → #e9e9e9 就是这个比例）。
 */
export function personalizationPageTintVars(value: unknown): { page: string; control: string } | null {
  const tint = normalizePersonalizationPageTint(value);
  if (tint.startsWith("#")) {
    return { page: tint, control: `color-mix(in srgb, ${tint} 95%, black)` };
  }
  const preset = PERSONALIZATION_PAGE_TINTS.find((item) => item.id === tint) || PERSONALIZATION_PAGE_TINTS[0];
  if ((preset as { followsTokens?: boolean }).followsTokens === true) return null;
  return { page: preset.page, control: preset.control };
}

/*
  卡片风格（设置 › 个性化 › 卡片风格）：卡上那一点颜色怎么给。

  四种都由 workspace.css 按 <html data-card-style> 画，颜色跟卡的状态走（规则卡、链路卡
  有状态色；别的卡用主色）：
    glow  状态光 —— 左上角一抹状态色的光（2.3.379 规则卡那种）
    edge  彩色描边 —— 1.5px 的渐变细边，卡身纯白
    bar   渐变卡头 —— 顶上一条 3px 渐变线，卡身从上到下极淡的同色渐变
    plain 纯白 —— 什么都不加
  出厂值是 edge：最轻、最像 iOS，和可选底色一起用最协调。
*/
export const PERSONALIZATION_CARD_STYLES = [
  { id: "edge", name: "彩色描边", description: "1.5px 渐变细边，卡身纯白，颜色跟状态走。" },
  { id: "glow", name: "状态光", description: "左上角一抹状态色的光，卡身其余部分是白的。" },
  { id: "bar", name: "渐变卡头", description: "顶上一条 3px 渐变线，卡身从上到下一层极淡的同色渐变。" },
  { id: "plain", name: "纯白", description: "卡上不加任何颜色，只留状态点和标签。" },
] as const;

export type PersonalizationCardStyleId = typeof PERSONALIZATION_CARD_STYLES[number]["id"];

export function normalizePersonalizationCardStyle(value: unknown): PersonalizationCardStyleId {
  const text = String(value || "").trim();
  return PERSONALIZATION_CARD_STYLES.some((style) => style.id === text)
    ? text as PersonalizationCardStyleId
    : "edge";
}

/*
  界面主题（设置 › 个性化 › 界面主题）：整套界面的气质，一次换掉底、卡、外壳、控件的形状。
  配色 / 页面底色 / 卡片风格那三项是「在当前主题上微调」，主题是它们底下那一层。

    classic 经典 —— 现在这套：浅灰页面托白卡、细线、天蓝渐变控件；深色是炭灰。出厂值，不往 <html> 上写属性。
    aurora  极光 —— 页面是一层淡淡的彩色柔光（主色 + 薄荷 + 淡紫），卡片是半透明的玻璃片
            （白 72% + 白高光边 + 带一点主色的软影，**不做 backdrop 模糊**，滚动不卡），
            分段控件、搜索框、按钮全部改成胶囊，顶栏和底部标签栏更透。深色是深蓝黑底上压暗的同一组光。

  画法全在 client/src/styles/theme-aurora.css 里按 <html data-ui-theme> 选；这里只管 id 和文案。
  存的是 id；别的值一律回到 classic。
*/
export const PERSONALIZATION_UI_THEMES = [
  { id: "classic", name: "经典", description: "浅灰底托白卡、细线分区、天蓝渐变控件；深色是炭灰。现在这套。" },
  { id: "aurora", name: "极光", description: "彩色柔光底 + 半透明玻璃卡 + 胶囊控件，顶栏和标签栏更通透；深色是深蓝黑底上的微光。" },
] as const;

export type PersonalizationUiThemeId = typeof PERSONALIZATION_UI_THEMES[number]["id"];

export function normalizePersonalizationUiTheme(value: unknown): PersonalizationUiThemeId {
  const text = String(value || "").trim();
  return PERSONALIZATION_UI_THEMES.some((theme) => theme.id === text)
    ? text as PersonalizationUiThemeId
    : "classic";
}
