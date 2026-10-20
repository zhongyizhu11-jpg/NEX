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
  /*
    下面五套搬自 monitor-probe 的 HEX 主题（src/styles/tokens.css 的 [data-palette]）：
    浅色一个沉稳的中间调、深色一个亮一档的同色；它的经典蓝就是「靛蓝」界面主题的出厂色，不单列。
    它们是普通的强调色预设，任何界面主题下都能选；在「靛蓝」主题下按钮是平色，所以换起来最像原版。
    id 不叫 forest / rose：forest 已经是「森绿」，rose 是同名的界面主题，所以用 pine / rouge。
  */
  {
    id: "ocean",
    name: "海洋",
    description: "青蓝色，取自 monitor-probe 的 HEX 主题：#167e90，深色下是 #74d1df。",
    swatches: ["#167e90", "color-mix(in srgb, #167e90 12%, white)", "#74d1df"],
    light: {
      primary: "#167e90",
      primaryForeground: "#ffffff",
      ring: "#167e90",
      chart1: "#167e90",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#167e90",
      sidebarPrimaryForeground: "#ffffff",
      sidebarRing: "#167e90",
    },
    dark: {
      primary: "#74d1df",
      primaryForeground: "#0b2a30",
      ring: "#74d1df",
      chart1: "#74d1df",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#74d1df",
      sidebarPrimaryForeground: "#0b2a30",
      sidebarRing: "#74d1df",
    },
  },
  {
    id: "sunset",
    name: "落日",
    description: "砖橙色，取自 monitor-probe 的 HEX 主题：#b65b2c，深色下是 #f5b38c。",
    swatches: ["#b65b2c", "color-mix(in srgb, #b65b2c 12%, white)", "#f5b38c"],
    light: {
      primary: "#b65b2c",
      primaryForeground: "#ffffff",
      ring: "#b65b2c",
      chart1: "#b65b2c",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#b65b2c",
      sidebarPrimaryForeground: "#ffffff",
      sidebarRing: "#b65b2c",
    },
    dark: {
      primary: "#f5b38c",
      primaryForeground: "#30170c",
      ring: "#f5b38c",
      chart1: "#f5b38c",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#f5b38c",
      sidebarPrimaryForeground: "#30170c",
      sidebarRing: "#f5b38c",
    },
  },
  {
    id: "pine",
    name: "森林",
    description: "松绿色，取自 monitor-probe 的 HEX 主题：#248064，深色下是 #7dd8b4。",
    swatches: ["#248064", "color-mix(in srgb, #248064 12%, white)", "#7dd8b4"],
    light: {
      primary: "#248064",
      primaryForeground: "#ffffff",
      ring: "#248064",
      chart1: "#248064",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#248064",
      sidebarPrimaryForeground: "#ffffff",
      sidebarRing: "#248064",
    },
    dark: {
      primary: "#7dd8b4",
      primaryForeground: "#0c2a20",
      ring: "#7dd8b4",
      chart1: "#7dd8b4",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#7dd8b4",
      sidebarPrimaryForeground: "#0c2a20",
      sidebarRing: "#7dd8b4",
    },
  },
  {
    id: "midnight",
    name: "午夜",
    description: "蓝紫色，取自 monitor-probe 的 HEX 主题：#7860bb，深色下是 #c2adff。",
    swatches: ["#7860bb", "color-mix(in srgb, #7860bb 12%, white)", "#c2adff"],
    light: {
      primary: "#7860bb",
      primaryForeground: "#ffffff",
      ring: "#7860bb",
      chart1: "#7860bb",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#7860bb",
      sidebarPrimaryForeground: "#ffffff",
      sidebarRing: "#7860bb",
    },
    dark: {
      primary: "#c2adff",
      primaryForeground: "#1c1534",
      ring: "#c2adff",
      chart1: "#c2adff",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#c2adff",
      sidebarPrimaryForeground: "#1c1534",
      sidebarRing: "#c2adff",
    },
  },
  {
    id: "rouge",
    name: "玫红",
    description: "玫红色，取自 monitor-probe 的 HEX 主题：#b24e77，深色下是 #f2a9c5。",
    swatches: ["#b24e77", "color-mix(in srgb, #b24e77 12%, white)", "#f2a9c5"],
    light: {
      primary: "#b24e77",
      primaryForeground: "#ffffff",
      ring: "#b24e77",
      chart1: "#b24e77",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#b24e77",
      sidebarPrimaryForeground: "#ffffff",
      sidebarRing: "#b24e77",
    },
    dark: {
      primary: "#f2a9c5",
      primaryForeground: "#311220",
      ring: "#f2a9c5",
      chart1: "#f2a9c5",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "#f2a9c5",
      sidebarPrimaryForeground: "#311220",
      sidebarRing: "#f2a9c5",
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

    gilt    墨金 —— 米白纸底托奶白卡（暖色细线 + 软影），页面标题、卡标题、统计大数字用衬线，标题下一截
            金线，分组小标题金色小字；筛选 chip 选中态墨色实心（深色下金色）。深色是暖墨黑配金线。
            高端杂志 / 精品酒店的气质；主按钮仍是主色渐变。

    rose    玫瑰 —— 胭脂粉底上一层很淡的玫瑰 / 淡紫 / 蜜桃柔光，卡片是没有边线的大圆角白瓣（软影浮着），
            数字嵌在卡里一枚胭脂色托盘中；页面标题和大数字用斜体衬线；分段控件是一圈细线的空槽、
            选中格淡底墨字，全部药丸。设置页在这套下改成编号分节 + 贴底保存栏。深色是酒红墨色。
            参考 Rosélune 面板的 Romance（design/losantos-settings-2026-10-11/）。

    cinnabar 朱砂 —— 参考 Rosélune 的 Umbrella：素白纸面、几乎直角（3px）的卡和控件、标签全大写加宽字距、
            页面标题前一枚朱红菱形、每节顶线左端一段朱红短线、页顶一条细斜纹。2.3.425 ～ 2.3.436 只有这套
            主题下才出现「监控」页和那批借鉴来的运维功能入口（见 client/src/features/ops/），2.3.437 起所有主题都有。

    liquid-glass 液态玻璃 —— 照 freetodo/monitor-theme-liquid-glass（Apple Liquid Glass）搬过来：页面后面两张大幅圆角
            照片错落铺着（默认随机拉，设了壁纸就用壁纸），卡片是真毛玻璃（白 45% + 白边 + backdrop 模糊 28px），
            鼠标移上去卡里跟着亮一团光；顶栏是浮着的玻璃条，按钮 / chip / 分段全是胶囊玻璃，选中态 Apple 蓝实心；
            Inter 字体、标题和大数字字重 500。深色是 #111318 底上压暗到 40% 的照片。
            照片层和光标跟随在 client/src/components/LiquidGlassBackdrop.tsx。

    indigo  靛蓝 —— 照 8bitNull 的 monitor-probe 主题 HEX：冷灰底（#f2f3f5）托纯白 1px 细线卡、不投影；强调色是沉稳的
            靛蓝（#4268aa），按钮是平色、选中态是淡底 + 靛蓝字；整套换成系统字，读数粗黑 + 底下一根细进度条，
            统计条是「小灰标签 + 26px 大数字」；控件一律 8px 圆角，底部标签栏是贴底通栏条。深色是蓝黑（#121417）。

    pearl   珍珠 —— 照上游 poouo/Forwardx 现在那套 Pearl Glass（改编自 scaffold-master，MIT，见 THIRD_PARTY_NOTICES.md）：
            带一丝灰绿的珍珠灰底（#f4f6f5）托瓷片卡（白→珍珠白的淡渐变 + 1px 灰绿细线 + 两层很淡的影 + 顶部白高光，
            16px 圆角）；控件 12px 圆角，主按钮是上游出厂的墨色（深色下是一块亮白瓷），分段控件是一条凹槽、选中格是
            浮起来的瓷片；侧栏选中项也是一块瓷片，换页时滑过去（client/src/components/PearlNavMarker.tsx）；
            页面标题下一道细线，系统字。深色是蓝灰墨（#161b1e）。

  画法全在 client/src/styles/theme-aurora.css / theme-gilt.css / theme-rose.css / theme-cinnabar.css / theme-liquid-glass.css / theme-indigo.css / theme-pearl.css 里按 <html data-ui-theme> 选；这里只管 id 和文案。
  存的是 id；别的值一律回到 classic。
*/
export const PERSONALIZATION_UI_THEMES = [
  { id: "classic", name: "经典", description: "浅灰底托白卡、细线分区、天蓝渐变控件；深色是炭灰。现在这套。" },
  { id: "aurora", name: "极光", description: "彩色柔光底 + 半透明玻璃卡 + 胶囊控件，顶栏和标签栏更通透；深色是深蓝黑底上的微光。" },
  { id: "gilt", name: "墨金", description: "米白纸底、平贴的小圆角卡纸，数字放在米色带上；衬线标题、金色下划线分段、方标签筛选；深色是墨黑配金。" },
  { id: "rose", name: "玫瑰", description: "胭脂粉底、无边线的浮起白瓣卡，数字嵌在托盘里；斜体衬线标题、细线空槽分段、全药丸；设置页改为编号分节。" },
  { id: "cinnabar", name: "朱砂", description: "素白纸面、3px 小方角、朱红短线和菱形标记，标签全大写加宽字距，一份技术规格书的样子。" },
  { id: "liquid-glass", name: "液态玻璃", description: "Apple Liquid Glass：页面后面两张随机照片（设了壁纸就用壁纸），卡片是真毛玻璃、鼠标移上去跟着亮一团光，浮着的玻璃顶栏、胶囊玻璃按钮、Apple 蓝选中态；深色是压暗的照片。" },
  { id: "indigo", name: "靛蓝", description: "冷灰底托纯白细线卡、靛蓝平色控件、系统字；读数粗黑、底下一根细进度条，像一块监控大屏；深色是蓝黑。照 monitor-probe 的 HEX 主题。" },
  { id: "pearl", name: "珍珠", description: "珍珠灰底托瓷片卡：细线、淡渐变、两层软影和一道顶部高光；墨色主按钮、凹槽分段控件里浮起的选中格，侧栏选中项会滑；深色是蓝灰墨。照上游 Forwardx 的 Pearl Glass。" },
] as const;

export type PersonalizationUiThemeId = typeof PERSONALIZATION_UI_THEMES[number]["id"];

export function normalizePersonalizationUiTheme(value: unknown): PersonalizationUiThemeId {
  const text = String(value || "").trim();
  return PERSONALIZATION_UI_THEMES.some((theme) => theme.id === text)
    ? text as PersonalizationUiThemeId
    : "classic";
}

/*
  布局密度（精简布局）。画法全在 client/src/styles/compact.css 里按 <html data-layout="compact"> 选，
  这里只管 id、文案和「谁说了算」：

    站点默认  设置 › 个性化 › 布局（personalizationLayout），管理员定，所有人跟着走
    个人偏好  个人资料 › 界面（users.uiLayout）：null 跟随站点，standard / compact 自己定

  精简 = 同样的数据和功能，更密的摆法：控件和卡片更矮、圆角更小、说明文字不占地方、侧栏更窄。
  2.3.466 那版（users.compactLayout 布尔开关）只在几页上零散改过摆法，用户看不出差别；
  这一版整个外壳一起换。老开关开着的账号自动算成「精简」，不用再点一次。
*/
export const PERSONALIZATION_LAYOUTS = [
  { id: "standard", name: "标准", description: "现在这套：留白充足、每项带说明，第一次用的人看得明白。" },
  { id: "compact", name: "精简", description: "控件和卡片更矮、圆角更小、说明文字收起来、侧栏更窄，一屏多看一截。功能和数据一样。" },
] as const;

export type PersonalizationLayoutId = typeof PERSONALIZATION_LAYOUTS[number]["id"];

export function normalizePersonalizationLayout(value: unknown): PersonalizationLayoutId {
  const text = String(value || "").trim();
  return PERSONALIZATION_LAYOUTS.some((layout) => layout.id === text)
    ? text as PersonalizationLayoutId
    : "standard";
}

/** 个人偏好：null = 跟随站点默认。 */
export function normalizeUserLayoutPreference(value: unknown): PersonalizationLayoutId | null {
  const text = String(value || "").trim();
  return PERSONALIZATION_LAYOUTS.some((layout) => layout.id === text) ? text as PersonalizationLayoutId : null;
}

/**
 * 这个账号最终看到哪一套：个人偏好 › 2.3.466 的老开关 › 站点默认。
 * user 为空（没登录、还在加载）时按站点默认。
 */
export function resolveEffectiveLayout(
  user: { uiLayout?: unknown; compactLayout?: unknown } | null | undefined,
  siteLayout: unknown,
): PersonalizationLayoutId {
  const preference = normalizeUserLayoutPreference(user?.uiLayout);
  if (preference) return preference;
  if (user && (user.compactLayout === true || user.compactLayout === 1)) return "compact";
  return normalizePersonalizationLayout(siteLayout);
}

/*
  「液态玻璃」主题的几个旋钮（设置 › 个性化 › 液态玻璃）。只在界面主题是 liquid-glass 时生效，
  存成一段 JSON（personalizationLiquidGlass），画法在 client/src/styles/theme-liquid-glass.css，
  照片和光标跟随在 client/src/components/LiquidGlassBackdrop.tsx。

    photoSource  照片从哪来：
      auto      设了「自定义背景」就用那张，没设就随机拉（出厂值）
      random    每次打开从 picsum.photos 拉两张随机照片（预览站的做法；国内服务器可能拉不到，拉不到退回色块）
      wallpaper 只用「自定义背景」里设的那张；没设就是色块
      builtin   面板自带的那几张壁纸里随机挑两张，不依赖外网
      none      不放照片，只留渐变色块
    wash         浅色下罩在照片上的那层页面底色，0～80%：数字越大照片越淡、压在照片上的字越清楚
    darkOpacity  深色下照片的不透明度，10～100%（预览站是 40）
    blur         玻璃卡的模糊半径，0～40px（预览站是 28；手机上卡多时调小更顺）
    sheen        鼠标移上去卡里跟着亮一团光（只在有鼠标的设备上）
    layout       照片怎么铺：
      auto   只有一张图（用的是自定义背景）或者屏幕窄（手机）就铺满全屏一张；两张不同的照片、宽屏时才左右错落（出厂值）
      full   永远铺满全屏一张，没有边距和圆角
      wings  永远左右错落两张（预览站的样子）；只有一张图时两格放同一张
*/
export const LIQUID_GLASS_PHOTO_SOURCES = [
  { id: "auto", name: "自动", description: "设了自定义背景就用那张，没设就随机拉。" },
  { id: "random", name: "随机照片", description: "每次打开从 picsum.photos 拉两张，和预览站一样；拉不到退回色块。" },
  { id: "wallpaper", name: "自定义背景", description: "只用「自定义背景」里设的那张。" },
  { id: "builtin", name: "内置壁纸", description: "面板自带的壁纸里随机挑两张，不依赖外网。" },
  { id: "none", name: "不放照片", description: "只留渐变色块。" },
] as const;

export type LiquidGlassPhotoSource = typeof LIQUID_GLASS_PHOTO_SOURCES[number]["id"];

export const LIQUID_GLASS_LAYOUTS = [
  { id: "auto", name: "自动", description: "一张图或手机上铺满全屏，两张不同的照片在宽屏上左右错落。" },
  { id: "full", name: "铺满全屏", description: "一张照片铺满整个屏幕，没有边距和圆角。" },
  { id: "wings", name: "左右错落", description: "两张圆角照片一左一右错落（预览站的样子）。" },
] as const;

export type LiquidGlassLayout = typeof LIQUID_GLASS_LAYOUTS[number]["id"];

export type LiquidGlassConfig = {
  photoSource: LiquidGlassPhotoSource;
  wash: number;
  darkOpacity: number;
  blur: number;
  sheen: boolean;
  layout: LiquidGlassLayout;
};

export const DEFAULT_LIQUID_GLASS: LiquidGlassConfig = { photoSource: "auto", wash: 30, darkOpacity: 40, blur: 28, sheen: true, layout: "auto" };
export const LIQUID_GLASS_LIMITS = { wash: [0, 80], darkOpacity: [10, 100], blur: [0, 40] } as const;

function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeLiquidGlassConfig(value: unknown): LiquidGlassConfig {
  let raw: any = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LIQUID_GLASS };
  const source = String(raw.photoSource || "");
  const layout = String(raw.layout || "");
  return {
    photoSource: LIQUID_GLASS_PHOTO_SOURCES.some((item) => item.id === source) ? source as LiquidGlassPhotoSource : DEFAULT_LIQUID_GLASS.photoSource,
    wash: clampInt(raw.wash, LIQUID_GLASS_LIMITS.wash, DEFAULT_LIQUID_GLASS.wash),
    darkOpacity: clampInt(raw.darkOpacity, LIQUID_GLASS_LIMITS.darkOpacity, DEFAULT_LIQUID_GLASS.darkOpacity),
    blur: clampInt(raw.blur, LIQUID_GLASS_LIMITS.blur, DEFAULT_LIQUID_GLASS.blur),
    sheen: raw.sheen === undefined ? DEFAULT_LIQUID_GLASS.sheen : raw.sheen === true || raw.sheen === "true",
    layout: LIQUID_GLASS_LAYOUTS.some((item) => item.id === layout) ? layout as LiquidGlassLayout : DEFAULT_LIQUID_GLASS.layout,
  };
}
