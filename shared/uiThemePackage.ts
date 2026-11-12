/*
  界面主题包（2.3.525 起）：面板只自带三套界面主题（经典 / 珍珠 / 液态玻璃），其余按需安装。

  为什么拆：八套主题全打在面板里，可一个站点一般只用一套；新主题每加一套，所有人的安装包都跟着变大，
  第三方也没法自己做一套。现在一套主题就是一个压缩包：

      theme.json   清单（下面的 UiThemeManifest）
      theme.css    样式，规则都写在 html[data-ui-theme="<id>"] 下面
      其余          样式里 url() 引用的图片 / 字体（装的时候内联成 data: 地址）

  三条安装途径（设置 › 个性化 › 主题管理，都只有管理员能用）：
    · 官方主题库：随面板发布的那几套（themes/official/，构建时拷到 dist/themes/official），点一下就装，不用外网；
    · 上传压缩包：ZIP 或 TAR.GZ；
    · 从链接安装：填一个压缩包直链，面板去下。
  装好的主题和内置的排在一起，谁都能在顶栏调色盘里选；卸载后选着它的设备自动回到站点默认。

  原来内置、现在挪进官方主题库的五套（深空 / 墨金 / 玫瑰 / 朱砂 / 靛蓝）id 不变：
  界面里按主题换结构的那几处（深空的顶部导航和转发一张表、墨金手机上的分类条）认的就是 id，装上以后照旧生效。
  升级时站点默认正好是这五套之一的，面板开机会自动把它装上（server/uiThemes.ts 的 ensureSiteUiThemeInstalled）。

  这里只放两头都要用的东西：id 规则、清单的形状和校验、预览色、上限。读包 / 校验 CSS 在 server/uiThemePackage.ts。
*/

export const UI_THEME_API_VERSION = 1;

/** 面板自带、不能卸载的三套。和 shared/personalization.ts 的 PERSONALIZATION_UI_THEMES 是同一份名单（那边有测试守着）。 */
export const BUILTIN_UI_THEME_IDS = ["classic", "pearl", "liquid-glass"] as const;
export type BuiltinUiThemeId = typeof BUILTIN_UI_THEME_IDS[number];

/** 官方主题库里的那几套：前五套原来内置，后三套（控制台 / 精修 / 深色运维）2.3.525 之后新加。顺序就是主题库里的显示顺序。 */
export const OFFICIAL_UI_THEME_IDS = ["deepspace", "gilt", "rose", "cinnabar", "indigo", "console", "refined", "nightops"] as const;
export type OfficialUiThemeId = typeof OFFICIAL_UI_THEME_IDS[number];

export const UI_THEME_LIMITS = {
  /** 压缩包本身。上传是 base64 放在 JSON 里走 tRPC（请求体上限 10MB，见 server/bodyParsers.ts），6MB 编码后是 8MB */
  archiveBytes: 6 * 1024 * 1024,
  /** 解压后全部文件加起来 */
  expandedBytes: 16 * 1024 * 1024,
  /** 单个文件 */
  fileBytes: 4 * 1024 * 1024,
  /** theme.css 原文 */
  cssBytes: 512 * 1024,
  /** 资源内联之后的样式（存库、下发给浏览器的那一份） */
  compiledCssBytes: 6 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  files: 64,
  /** 最多装几套（不算内置） */
  installed: 24,
} as const;

/** 预览用的三种颜色：页面底、卡片、强调色。只收十六进制色，别的写法界面上不认。 */
export type UiThemePreviewColors = { page: string; card: string; accent: string };
export type UiThemePreview = { light: UiThemePreviewColors; dark: UiThemePreviewColors };

export type UiThemeManifest = {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage: string;
  stylesheet: string;
  preview: UiThemePreview;
};

export type UiThemeSource = "official" | "upload" | "url";

/** 装好的一套主题给界面看的那几样（不带样式正文）。publicInfo 里也是这个形状，所以不能放任何敏感的东西。 */
export type UiThemeSummary = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage: string;
  preview: UiThemePreview;
  /** 样式的 sha256：样式地址带着它，换了内容地址就变，浏览器不会用旧缓存 */
  revision: string;
  source: UiThemeSource;
  installedAt: number;
};

export const DEFAULT_UI_THEME_PREVIEW: UiThemePreview = {
  light: { page: "#f5f5f7", card: "#ffffff", accent: "#3ea4ec" },
  dark: { page: "#1e1e1e", card: "#2a2a2a", accent: "#3ea4ec" },
};

const THEME_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_./-]+$/;

export function isBuiltinUiThemeId(value: unknown): value is BuiltinUiThemeId {
  return (BUILTIN_UI_THEME_IDS as readonly string[]).includes(String(value || ""));
}

export function isOfficialUiThemeId(value: unknown): value is OfficialUiThemeId {
  return (OFFICIAL_UI_THEME_IDS as readonly string[]).includes(String(value || ""));
}

/** 能当主题包 id 的写法：小写字母开头，小写字母 / 数字 / 连字符，3～32 个字符，不和内置的重名。 */
export function isValidUiThemePackageId(value: unknown): value is string {
  const text = String(value || "");
  return THEME_ID_PATTERN.test(text) && !text.includes("--") && !isBuiltinUiThemeId(text);
}

/** 压缩包里的路径：只收相对路径，不许 ..、不许绝对路径、不许奇怪的字符。 */
export function isSafeUiThemePath(name: string) {
  return name.length > 0 && name.length <= 200 && SAFE_PATH_PATTERN.test(name)
    && !name.startsWith("/") && !name.split("/").some((part) => part === ".." || part === "." || part === "");
}

function cleanText(value: unknown, max: number) {
  // 清单里的文字会原样显示在设置页上：去掉控制字符，压成一行
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizePreviewColors(raw: unknown, fallback: UiThemePreviewColors): UiThemePreviewColors {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const pick = (key: keyof UiThemePreviewColors) => {
    const text = String(source[key] ?? "").trim();
    return HEX_COLOR_PATTERN.test(text) ? text.toLowerCase() : fallback[key];
  };
  return { page: pick("page"), card: pick("card"), accent: pick("accent") };
}

/** 预览色：缺的、写得不对的都回到默认，不因为预览色让整个包装不上。 */
export function normalizeUiThemePreview(raw: unknown): UiThemePreview {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const light = normalizePreviewColors(source.light, DEFAULT_UI_THEME_PREVIEW.light);
  return { light, dark: normalizePreviewColors(source.dark, { ...DEFAULT_UI_THEME_PREVIEW.dark, accent: light.accent }) };
}

export class UiThemeManifestError extends Error {}

/**
 * 校验 theme.json。出错时抛 UiThemeManifestError，文字是给管理员看的（哪一项不对、该怎么写）。
 * 不认识的字段直接忽略：以后清单加了新字段，旧面板还能装新主题。
 */
export function parseUiThemeManifest(raw: unknown): UiThemeManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UiThemeManifestError("theme.json 必须是一个对象");
  const source = raw as Record<string, unknown>;
  if (Number(source.apiVersion) !== UI_THEME_API_VERSION) {
    throw new UiThemeManifestError(`theme.json 的 apiVersion 必须是 ${UI_THEME_API_VERSION}（这个面板只认这一版主题格式）`);
  }
  const id = String(source.id ?? "").trim();
  if (isBuiltinUiThemeId(id)) throw new UiThemeManifestError(`主题 id「${id}」和内置主题重名，请换一个`);
  if (!isValidUiThemePackageId(id)) {
    throw new UiThemeManifestError("主题 id 只能用小写字母、数字和连字符，小写字母开头，3 到 32 个字符（例如 my-theme）");
  }
  const name = cleanText(source.name, 40);
  if (!name) throw new UiThemeManifestError("theme.json 缺少 name（主题的名字）");
  const version = String(source.version ?? "").trim();
  if (!VERSION_PATTERN.test(version) || version.length > 32) {
    throw new UiThemeManifestError("theme.json 的 version 要写成 1.0.0 这样的三段版本号");
  }
  const stylesheet = String(source.stylesheet ?? "theme.css").trim() || "theme.css";
  if (!isSafeUiThemePath(stylesheet) || !stylesheet.toLowerCase().endsWith(".css")) {
    throw new UiThemeManifestError("theme.json 的 stylesheet 要指向压缩包里的一个 .css 文件（例如 theme.css）");
  }
  const homepage = cleanText(source.homepage, 200);
  return {
    apiVersion: UI_THEME_API_VERSION,
    id,
    name,
    version,
    description: cleanText(source.description, 300),
    author: cleanText(source.author, 60),
    homepage: /^https?:\/\//i.test(homepage) ? homepage : "",
    stylesheet,
    preview: normalizeUiThemePreview(source.preview),
  };
}

/**
 * 一个存着的主题 id 现在还能不能用：内置的一直能用，其余要在「已安装」名单里。
 * 不能用的（主题被卸载了、从别的面板带过来的旧值）回到经典。
 */
export function resolveUiThemeId(value: unknown, installedIds: Iterable<string> = []): string {
  const text = String(value || "").trim();
  if (isBuiltinUiThemeId(text)) return text;
  for (const id of installedIds) if (id === text) return text;
  return "classic";
}

/** 版本号比较：a 比 b 新返回正数。只比三段数字，后缀不参与（1.0.0-beta 和 1.0.0 算一样新）。 */
export function compareUiThemeVersions(a: string, b: string) {
  const parts = (text: string) => String(text || "").split("-")[0].split(".").map((item) => Number(item) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 开发模板里的 theme.css：够看出效果，又不至于让人以为必须写这么多。 */
export function uiThemeStarterFiles(id = "my-theme"): Record<string, string> {
  const manifest = {
    apiVersion: UI_THEME_API_VERSION,
    id,
    name: "我的主题",
    version: "1.0.0",
    description: "一句话说说这套主题长什么样。",
    author: "你的名字",
    homepage: "",
    stylesheet: "theme.css",
    preview: {
      light: { page: "#f3f6f4", card: "#ffffff", accent: "#2f8f6b" },
      dark: { page: "#101614", card: "#18211e", accent: "#5cc79e" },
    },
  };
  const css = `/*
  NEX 界面主题（主题格式 v1）。

  规矩只有一条：每条规则都写在 html[data-ui-theme="${id}"] 下面。主题没被选中时这些规则一条都不生效，
  深色模式在前面加 .dark：html.dark[data-ui-theme="${id}"]。
  颜色、圆角、阴影尽量改变量（下面这些是面板的设计令牌，完整名单见 shared/design-tokens.css），
  少直接改某个类 —— 面板升级后类名可能变，变量不会。

  可以引用包里的图片和字体：url("assets/bg.webp")，安装时会内联进样式。不能引用外网地址，也不能带脚本。
*/
html[data-ui-theme="${id}"] {
  --fx-l0-page: #f3f6f4;        /* 页面底 */
  --fx-l1-surface: #ffffff;     /* 卡片 */
  --fx-card-fill: #ffffff;
  --fx-card-stroke: #dfe7e3;    /* 卡片的细线 */
  --fx-l3-control-fill: #e6ece9; /* 分段控件的槽、搜索框的底 */
  --fx-primary-fill: #2f8f6b;   /* 主按钮、选中态 */
  --fx-primary-fill-hover: #277b5c;
  --fx-primary-gradient: linear-gradient(135deg, #46b088 0%, #2f8f6b 100%);
  --fx-primary-gradient-hover: linear-gradient(135deg, #3da47d 0%, #277b5c 100%);
}

html.dark[data-ui-theme="${id}"] {
  --fx-l0-page: #101614;
  --fx-l1-surface: #18211e;
  --fx-card-fill: #18211e;
  --fx-card-stroke: #26332e;
  --fx-l3-control-fill: #222d29;
  --fx-primary-fill: #5cc79e;
  --fx-primary-fill-hover: #6fd3ac;
  --fx-primary-gradient: linear-gradient(135deg, #6fd3ac 0%, #45b58a 100%);
  --fx-primary-gradient-hover: linear-gradient(135deg, #82dcb9 0%, #55c198 100%);
}
`;
  const readme = `# NEX 界面主题模板

1. 改 theme.json：id（小写字母、数字、连字符，3～32 个字符，装好以后别再改）、name、version、preview（设置页预览用的三种颜色）。
2. 改 theme.css：所有规则都写在 html[data-ui-theme="你的 id"] 下面。
3. 把这几个文件打成 ZIP（theme.json 要在压缩包的根目录），到「系统设置 › 个性化 › 主题管理」上传，或者放到网上用直链安装。
4. 升级：id 不变、version 调大，重新安装时勾上「替换已安装的同名主题」。

写法和限制见使用文档的「界面主题」一页。
`;
  return { "theme.json": `${JSON.stringify(manifest, null, 2)}\n`, "theme.css": css, "README.md": readme };
}
