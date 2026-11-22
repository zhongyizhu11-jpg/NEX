/* 从 client/src/pages/Settings.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */
import { resolveSiteTitle } from "@shared/brand";
import { FormField } from "@/components/ui/form-field";
import { formatBytes } from "@shared/formatBytes";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { LayoutDefaultCard } from "@/components/settings/LayoutDefaultCard";
import { UiThemeManagerCard } from "@/components/settings/UiThemeManagerCard";
import { UiThemeSwatch } from "@/components/settings/UiThemeSwatch";
import { useUiThemeOptions } from "@/hooks/useUiThemeOptions";
import { setInstalledUiThemes, uiThemeListKey } from "@/lib/installedUiThemes";
import DataSectionLoading from "@/components/DataSectionLoading";
import { trpc } from "@/lib/trpc";
import { compressImageFile, imageDataUrlSize } from "@/lib/imageUpload";
import { applyPersonalizationSurface, applyPersonalizationTheme, setPersonalizationPreview, setUiThemeOverride } from "@/lib/personalizationTheme";
import { cn } from "@/lib/utils";
import { MAX_CUSTOM_SIDEBAR_ICON_BYTES, MAX_CUSTOM_SIDEBAR_PAGES, CUSTOM_SIDEBAR_OPEN_MODES, decodeCustomSidebarIconDataUrl, isSafeCustomSidebarSvg, isValidCustomSidebarUrl, normalizeCustomSidebarUrl, normalizeCustomSidebarPages, type CustomSidebarPage, type CustomSidebarOpenMode, type CustomSidebarVisibility } from "@shared/customSidebarPages";
import { Trash2, CheckCircle2, Globe, ExternalLink, RefreshCw, Eye, Upload, Loader2, Palette, Image as ImageIcon, PanelLeft, Pencil, Plus } from "lucide-react";
import { useCallback, useRef, useState, useEffect } from "react";
import { useSaveDockActive, useSaveDockItem } from "@/components/settings/SaveDock";
import { UiThemeDot } from "@/components/UiThemeQuickSwitch";
import { setLiquidGlassPreview } from "@/lib/liquidGlass";
import { useUiThemeOverride } from "@/hooks/useUiThemeOverride";
import { toast } from "sonner";
import { BRAND_LOGO_MAX_BYTES } from "@shared/avatar";
import { BUILTIN_WALLPAPERS, DEFAULT_PERSONALIZATION_BACKGROUND, PERSONALIZATION_CARD_STYLES, PERSONALIZATION_PAGE_TINTS, PERSONALIZATION_THEME_PRESETS, isHexColor, normalizePersonalizationCardStyle, normalizeLiquidGlassConfig, DEFAULT_LIQUID_GLASS, LIQUID_GLASS_LIMITS, LIQUID_GLASS_PHOTO_SOURCES, LIQUID_GLASS_LAYOUTS, type LiquidGlassConfig, normalizePersonalizationPageTint, normalizePersonalizationUiTheme, personalizationSwatchGradient, clampBackgroundBlur, clampBackgroundOpacity, getPersonalizationThemePreset, normalizePersonalizationThemePresetId, type PersonalizationBackgroundConfig, type PersonalizationThemePresetId, type PersonalizationBackgroundImage, type PersonalizationBackgroundUrlType } from "@shared/personalization";

function createDefaultHomepageHtml(themeId: PersonalizationThemePresetId) {
  const theme = getPersonalizationThemePreset(themeId);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NEX</title>
  <style>
    :root {
      --fx-primary: ${theme.light.primary};
      --fx-primary-foreground: ${theme.light.primaryForeground};
      --fx-ring: ${theme.light.ring};
      --fx-chart-1: ${theme.light.chart1};
      --fx-chart-2: ${theme.light.chart2};
      --fx-chart-3: ${theme.light.chart3};
      --fx-chart-4: ${theme.light.chart4};
      --fx-bg: #f8fafc;
      --fx-ink: #0f172a;
      --fx-muted: #475569;
      --fx-border: rgba(15, 23, 42, .10);
      --fx-card: rgba(255, 255, 255, .76);
      --fx-card-soft: rgba(248, 250, 252, .72);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --fx-primary: ${theme.dark.primary};
        --fx-primary-foreground: ${theme.dark.primaryForeground};
        --fx-ring: ${theme.dark.ring};
        --fx-chart-1: ${theme.dark.chart1};
        --fx-chart-2: ${theme.dark.chart2};
        --fx-chart-3: ${theme.dark.chart3};
        --fx-chart-4: ${theme.dark.chart4};
        --fx-bg: #0b1020;
        --fx-ink: #f8fafc;
        --fx-muted: #a8b3c7;
        --fx-border: rgba(226, 232, 240, .14);
        --fx-card: rgba(15, 23, 42, .72);
        --fx-card-soft: rgba(15, 23, 42, .56);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--fx-ink);
      background:
        radial-gradient(circle at 16% -10%, color-mix(in oklch, var(--fx-chart-1) 20%, transparent) 0, transparent 34rem),
        radial-gradient(circle at 92% 0%, color-mix(in oklch, var(--fx-chart-2) 16%, transparent) 0, transparent 30rem),
        linear-gradient(135deg, color-mix(in oklch, var(--fx-bg) 94%, white 6%) 0%, var(--fx-bg) 52%, color-mix(in oklch, var(--fx-bg) 88%, var(--fx-chart-4) 12%) 100%);
    }
    .page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 18px;
    }
    .hero {
      width: min(1080px, 100%);
      display: grid;
      grid-template-columns: 1.1fr .9fr;
      gap: 36px;
      align-items: center;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid color-mix(in oklch, var(--fx-primary) 28%, transparent);
      background: var(--fx-card);
      color: var(--fx-primary);
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--fx-primary);
    }
    h1 {
      margin: 18px 0 14px;
      font-size: clamp(42px, 7vw, 76px);
      line-height: .95;
      letter-spacing: 0;
    }
    p {
      max-width: 620px;
      color: var(--fx-muted);
      font-size: 17px;
      line-height: 1.8;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 26px;
    }
    .btn {
      display: inline-flex;
      min-height: 44px;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      padding: 0 18px;
      text-decoration: none;
      font-weight: 700;
    }
    .btn.primary {
      color: var(--fx-primary-foreground);
      background: var(--fx-primary);
      box-shadow: 0 14px 30px color-mix(in oklch, var(--fx-primary) 26%, transparent);
    }
    .btn.secondary {
      color: var(--fx-ink);
      border: 1px solid var(--fx-border);
      background: var(--fx-card);
    }
    .panel {
      border: 1px solid var(--fx-border);
      background: var(--fx-card);
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 24px 80px color-mix(in oklch, var(--fx-primary) 14%, transparent);
      backdrop-filter: blur(18px);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .item {
      border: 1px solid var(--fx-border);
      border-radius: 12px;
      padding: 16px;
      background: var(--fx-card-soft);
    }
    .item b {
      display: block;
      margin-bottom: 6px;
    }
    .item span {
      color: var(--fx-muted);
      font-size: 13px;
      line-height: 1.6;
    }
    @media (max-width: 820px) {
      .hero { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div>
        <span class="eyebrow"><span class="dot"></span>NEX 面板</span>
        <h1>多主机转发管理</h1>
        <p>管理转发、隧道、用户和流量。</p>
        <div class="actions">
          <a class="btn primary" href="/login">进入面板</a>
          <a class="btn secondary" href="/login?mode=register">创建账号</a>
        </div>
      </div>
      <div class="panel">
        <div class="grid">
          <div class="item"><b>多节点</b><span>管理多台 Linux 主机和隧道。</span></div>
          <div class="item"><b>流量统计</b><span>按用户和规则记录转发用量。</span></div>
          <div class="item"><b>套餐订阅</b><span>支持余额、套餐和支付配置。</span></div>
          <div class="item"><b>Telegram</b><span>用户可通过机器人自助查询和管理。</span></div>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;
}


function normalizePersonalizationBackgroundConfig(value: any): PersonalizationBackgroundConfig {
  const source = value && typeof value === "object" ? value : {};
  const normalizedSource = source.source === "builtin" || source.source === "upload" || source.source === "url" ? source.source : "none";
  return {
    ...DEFAULT_PERSONALIZATION_BACKGROUND,
    ...source,
    source: normalizedSource,
    opacity: clampBackgroundOpacity(source.opacity),
    blur: clampBackgroundBlur(source.blur),
    selectedId: source.selectedId ? String(source.selectedId) : null,
    url: String(source.url || ""),
    urlType: normalizedSource === "url" && source.urlType === "video" ? "video" : "image",
    images: Array.isArray(source.images) ? source.images : [],
  };
}


function createLocalId(prefix: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}


type CustomSidebarPageDraft = {
  id: string;
  name: string;
  url: string;
  visibility: CustomSidebarVisibility;
  openMode: CustomSidebarOpenMode;
  svg: string;
};


function createCustomSidebarPageDraft(): CustomSidebarPageDraft {
  return {
    id: createLocalId("page"),
    name: "",
    url: "",
    visibility: "admin",
    openMode: "embed",
    svg: "",
  };
}


function encodeSvgDataUrl(svg: string) {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:image/svg+xml;base64,${globalThis.btoa(binary)}`;
}


type PersonalizationSaveKey = "title" | "logo" | "theme" | "uiTheme" | "liquidGlass" | "pageTint" | "cardStyle" | "background" | "homepage" | "sidebarPages";


const personalizationSaveMessages: Record<PersonalizationSaveKey, string> = {
  title: "网站标题已保存",
  logo: "Logo 已保存",
  theme: "默认配色已保存",
  uiTheme: "界面主题已保存",
  liquidGlass: "液态玻璃参数已保存",
  pageTint: "页面底色已保存",
  cardStyle: "卡片风格已保存",
  background: "自定义背景已保存",
  homepage: "公开首页已保存",
  sidebarPages: "自定义菜单已保存",
};


const personalizationSaveErrorMessages: Record<PersonalizationSaveKey, string> = {
  title: "网站标题保存失败",
  logo: "Logo 保存失败",
  theme: "默认配色保存失败",
  uiTheme: "界面主题保存失败",
  liquidGlass: "液态玻璃参数保存失败",
  pageTint: "页面底色保存失败",
  cardStyle: "卡片风格保存失败",
  background: "自定义背景保存失败",
  homepage: "公开首页保存失败",
  sidebarPages: "自定义菜单保存失败",
};


export default function PersonalizationSettingsSection() {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const personalizationSettingsData = settings;
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const customSidebarIconInputRef = useRef<HTMLInputElement | null>(null);
  const savingSectionRef = useRef<PersonalizationSaveKey | null>(null);
  const pendingCustomSidebarPagesRef = useRef<CustomSidebarPage[] | null>(null);
  const [siteTitleInput, setSiteTitleInput] = useState("NEX");
  const [siteLogoDataUrl, setSiteLogoDataUrl] = useState("");
  const [personalizationTheme, setPersonalizationTheme] = useState<PersonalizationThemePresetId>("ink");
  const [savedPersonalizationTheme, setSavedPersonalizationTheme] = useState<PersonalizationThemePresetId>("ink");
  const [pageTint, setPageTint] = useState<string>("grey");
  const [savedPageTint, setSavedPageTint] = useState<string>("grey");
  const [customTintInput, setCustomTintInput] = useState<string>("#eef3fb");
  const [cardStyle, setCardStyle] = useState<string>("edge");
  const [savedCardStyle, setSavedCardStyle] = useState<string>("edge");
  const [uiTheme, setUiTheme] = useState<string>("classic");
  const [savedUiTheme, setSavedUiTheme] = useState<string>("classic");
  /* 能选的主题：内置的三套 + 装着的主题包（下面「主题管理」里装 / 卸，名单跟着变） */
  const uiThemeOptions = useUiThemeOptions();
  /* 这台设备在顶栏调色盘里给自己选的主题；有它时页面显示的是它，不是下面存的站点默认 */
  const uiThemeOverride = useUiThemeOverride();
  const [liquidGlass, setLiquidGlass] = useState<LiquidGlassConfig>(DEFAULT_LIQUID_GLASS);
  const [savedLiquidGlass, setSavedLiquidGlass] = useState<LiquidGlassConfig>(DEFAULT_LIQUID_GLASS);
  const [homepageEnabled, setHomepageEnabled] = useState(true);
  const [homepageCustomEnabled, setHomepageCustomEnabled] = useState(false);
  const [homepageHtml, setHomepageHtml] = useState("");
  const [backgroundConfig, setBackgroundConfig] = useState<PersonalizationBackgroundConfig>(DEFAULT_PERSONALIZATION_BACKGROUND);
  const [backgroundSourceMode, setBackgroundSourceMode] = useState<Exclude<PersonalizationBackgroundConfig["source"], "none">>("builtin");
  const [backgroundUrlInput, setBackgroundUrlInput] = useState("");
  const [backgroundUrlType, setBackgroundUrlType] = useState<PersonalizationBackgroundUrlType>("image");
  const [savingSection, setSavingSection] = useState<PersonalizationSaveKey | null>(null);
  const [compressingLogo, setCompressingLogo] = useState(false);
  const [compressingBackground, setCompressingBackground] = useState(false);
  const [customSidebarPages, setCustomSidebarPages] = useState<CustomSidebarPage[]>([]);
  const [customSidebarDialogOpen, setCustomSidebarDialogOpen] = useState(false);
  const [customSidebarDraft, setCustomSidebarDraft] = useState<CustomSidebarPageDraft>(() => createCustomSidebarPageDraft());

  const loadPersonalizationFromSettings = useCallback((settings: NonNullable<typeof personalizationSettingsData>) => {
    const nextBackground = normalizePersonalizationBackgroundConfig(
      (settings as any).personalizationBackgroundConfig || settings.personalizationBackground,
    );
    setSiteTitleInput(resolveSiteTitle(settings.siteTitle));
    setSiteLogoDataUrl(settings.siteLogoDataUrl || "");
    const nextTheme = normalizePersonalizationThemePresetId((settings as any).personalizationTheme);
    setPersonalizationTheme(nextTheme);
    setSavedPersonalizationTheme(nextTheme);
    const nextTint = normalizePersonalizationPageTint((settings as any).personalizationPageTint);
    setPageTint(nextTint);
    setSavedPageTint(nextTint);
    if (nextTint.startsWith("#")) setCustomTintInput(nextTint);
    const nextCardStyle = normalizePersonalizationCardStyle((settings as any).personalizationCardStyle);
    setCardStyle(nextCardStyle);
    setSavedCardStyle(nextCardStyle);
    // 服务端已经按「内置 + 已安装的主题包」核对过这个值，这里不再用只认内置的那份名单过一遍
    const nextUiTheme = String(settings.personalizationUiTheme || "classic");
    setUiTheme(nextUiTheme);
    setSavedUiTheme(nextUiTheme);
    const nextLiquidGlass = normalizeLiquidGlassConfig((settings as any).personalizationLiquidGlass);
    setLiquidGlass(nextLiquidGlass);
    setSavedLiquidGlass(nextLiquidGlass);
    setHomepageEnabled(settings.homepageEnabled ?? true);
    setHomepageCustomEnabled(!!settings.homepageCustomEnabled);
    setHomepageHtml(settings.homepageHtml || "");
    setBackgroundConfig(nextBackground);
    setBackgroundSourceMode(nextBackground.source === "none" ? "builtin" : nextBackground.source);
    setBackgroundUrlInput(nextBackground.url || "");
    setBackgroundUrlType(nextBackground.urlType || "image");
    setCustomSidebarPages(normalizeCustomSidebarPages((settings as any).customSidebarPages));
  }, []);

  /*
    什么时候把表单按库里的值重灌：只在个性化那几项的**内容**变了时，不是 settings 对象一换就灌
    —— 查询重取、顶栏调色盘改完主题写缓存都会换对象，原来一换就把没保存的页面底色、首页
    HTML、自定义页面全冲掉（Codex 在 #120 指出）。界面主题单独跟：顶栏选了就同步到这里的
    下拉和「已保存」值，别的字段的草稿不动。
  */
  const personalizationSnapshot = settings
    ? JSON.stringify([
      settings.siteTitle, settings.siteLogoDataUrl, (settings as any).personalizationTheme,
      (settings as any).personalizationPageTint, (settings as any).personalizationCardStyle,
      (settings as any).personalizationLiquidGlass, settings.homepageEnabled, settings.homepageCustomEnabled,
      settings.homepageHtml, (settings as any).personalizationBackgroundConfig, settings.personalizationBackground,
      (settings as any).customSidebarPages,
    ])
    : null;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    if (settingsRef.current) loadPersonalizationFromSettings(settingsRef.current);
  }, [personalizationSnapshot, loadPersonalizationFromSettings]);
  const settingsUiTheme = settings ? String(settings.personalizationUiTheme || "classic") : null;
  useEffect(() => {
    if (!settingsUiTheme) return;
    setUiTheme(settingsUiTheme);
    setSavedUiTheme(settingsUiTheme);
  }, [settingsUiTheme]);
  /*
    getSettings 带着的「已安装主题包」名单：和上面的站点默认是同一次请求里的，拿它当准。
    · 写进浏览器这头的名单（lib/installedUiThemes），上面的 uiThemeOptions、顶栏调色盘马上就有它们，
      不用等 publicInfo 下一次刷新；
    · 试看着的那套主题包刚被卸载了：回到存着的站点默认（它也没了就是经典）。只按这份名单判断 ——
      用 uiThemeOptions 判断的话，设置先到、名单后到的那一下会把一个装着的主题误当成「没了」。
  */
  const settingsInstalledUiThemeKey = uiThemeListKey(settings?.installedUiThemes);
  useEffect(() => {
    if (settingsInstalledUiThemeKey === null) return;
    setInstalledUiThemes(settingsRef.current?.installedUiThemes);
  }, [settingsInstalledUiThemeKey]);
  useEffect(() => {
    if (settingsInstalledUiThemeKey === null) return;
    const installedIds = settingsInstalledUiThemeKey.split(",").map((item) => item.split("@")[0]).filter(Boolean);
    const known = (id: string) => normalizePersonalizationUiTheme(id, installedIds) === id;
    if (known(uiTheme)) return;
    setUiTheme(known(savedUiTheme) ? savedUiTheme : "classic");
  }, [settingsInstalledUiThemeKey, uiTheme, savedUiTheme]);

  const updateSettingsMutation = trpc.system.updateSettings.useMutation({
    onSuccess: async () => {
      const key = savingSectionRef.current;
      if (key === "theme") {
        setSavedPersonalizationTheme(personalizationTheme);
        applyPersonalizationTheme(personalizationTheme);
      }
      if (key === "pageTint") {
        setSavedPageTint(pageTint);
        applyPersonalizationSurface({ pageTint, cardStyle: savedCardStyle, uiTheme: savedUiTheme });
      }
      if (key === "cardStyle") {
        setSavedCardStyle(cardStyle);
        applyPersonalizationSurface({ pageTint: savedPageTint, cardStyle, uiTheme: savedUiTheme });
      }
      if (key === "uiTheme") {
        setSavedUiTheme(uiTheme);
        /*
          在这里存主题，意思就是「这台设备也要看这套」：顶栏调色盘给这台设备选过的那套优先级更高，
          不清掉的话存完页面还是原样，看起来像没生效（2.3.435 用户反馈「快捷图标和设置里换主题不同步」）。
        */
        setUiThemeOverride(null);
        applyPersonalizationSurface({ pageTint: savedPageTint, cardStyle: savedCardStyle, uiTheme });
      }
      if (key === "liquidGlass") {
        setSavedLiquidGlass(liquidGlass);
        setLiquidGlassPreview(null);
      }
      if (key === "sidebarPages" && pendingCustomSidebarPagesRef.current) {
        setCustomSidebarPages(pendingCustomSidebarPagesRef.current);
        setCustomSidebarDialogOpen(false);
      }
      await Promise.all([
        utils.system.getSettings.invalidate(),
        utils.system.publicInfo.invalidate(),
        utils.system.sidebarPages.invalidate(),
      ]);
      toast.success(key ? personalizationSaveMessages[key] : "个性化配置已保存");
    },
    onError: (err) => {
      const key = savingSectionRef.current;
      toast.error(err.message || (key ? personalizationSaveErrorMessages[key] : "保存失败"));
    },
    onSettled: () => {
      savingSectionRef.current = null;
      pendingCustomSidebarPagesRef.current = null;
      setSavingSection(null);
    },
  });

  const personalizationSaving = updateSettingsMutation.isPending;
  const isSavingPersonalization = (key: PersonalizationSaveKey) => savingSection === key && personalizationSaving;
  const themeDirty = personalizationTheme !== savedPersonalizationTheme;
  const pageTintDirty = pageTint !== savedPageTint;
  const cardStyleDirty = cardStyle !== savedCardStyle;
  const uiThemeDirty = uiTheme !== savedUiTheme;
  const liquidGlassDirty = JSON.stringify(liquidGlass) !== JSON.stringify(savedLiquidGlass);
  /*
    返回「存成了没有」，给玫瑰主题下的贴底保存栏用（它一项一项按顺序存）。正在存的判断看 ref 不看
    personalizationSaving：栏连着存两项时，第二项拿到的还是上一次渲染的 isPending。
  */
  const savePersonalizationSection = (
    key: PersonalizationSaveKey,
    payload: Parameters<typeof updateSettingsMutation.mutate>[0],
  ): Promise<boolean> => {
    if (savingSectionRef.current !== null) return Promise.resolve(false);
    savingSectionRef.current = key;
    setSavingSection(key);
    return updateSettingsMutation.mutateAsync(payload).then(() => true, () => false);
  };

  const updateBackground = (patch: Partial<PersonalizationBackgroundConfig>) => {
    setBackgroundConfig((current) => normalizePersonalizationBackgroundConfig({ ...current, ...patch }));
    if (patch.source && patch.source !== "none") setBackgroundSourceMode(patch.source);
  };

  const selectedUploadedBackground = backgroundConfig.images.find((item) => item.id === backgroundConfig.selectedId) || null;
  const selectedBuiltinBackground = BUILTIN_WALLPAPERS.find((item) => item.id === backgroundConfig.selectedId) || null;
  const previewBackgroundUrl =
    backgroundConfig.source === "builtin"
      ? selectedBuiltinBackground?.url || ""
      : backgroundConfig.source === "upload"
        ? selectedUploadedBackground?.dataUrl || ""
        : backgroundConfig.source === "url"
          ? backgroundConfig.url
          : "";
  const previewIsVideo = backgroundConfig.source === "url" && backgroundConfig.urlType === "video";
  const opacityPercent = Math.round(clampBackgroundOpacity(backgroundConfig.opacity) * 100);
  const blurAmount = Math.round(clampBackgroundBlur(backgroundConfig.blur));
  const backgroundEnabled = backgroundConfig.source !== "none" && !!previewBackgroundUrl;
  const mobileBackgroundHint = previewIsVideo
    ? "移动端不会渲染视频背景，并会回退到默认背景，避免浏览器持续解码视频导致卡顿。"
    : "移动端会自动关闭背景虚化和缩放效果，只保留静态背景和不透明度，降低页面滚动卡顿。";
  const previewBackdropStyle = {
    filter: `blur(${blurAmount}px)`,
    transform: `scale(${1.04 + blurAmount / 280})`,
  };
  const backgroundSourceOptions = [
    { value: "builtin" as const, label: "内置壁纸", icon: ImageIcon },
    { value: "upload" as const, label: "上传图片", icon: Upload },
    { value: "url" as const, label: "外部链接", icon: Globe },
  ];

  const handleLogoUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      setCompressingLogo(true);
      const result = await compressImageFile(file, {
        maxBytes: BRAND_LOGO_MAX_BYTES,
        maxSide: 512,
        preferredType: file.type === "image/png" ? "image/png" : "image/webp",
        minQuality: 0.55,
      });
      setSiteLogoDataUrl(result.dataUrl);
      toast.success(`Logo 已处理为 ${formatBytes(result.size)}`);
    } catch (err: any) {
      toast.error(err?.message || "Logo 上传失败");
    } finally {
      setCompressingLogo(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  };

  const handleBackgroundUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      setCompressingBackground(true);
      const result = await compressImageFile(file, {
        maxBytes: 1.5 * 1024 * 1024,
        maxSide: 1920,
        preferredType: "image/jpeg",
        minQuality: 0.62,
      });
      const item: PersonalizationBackgroundImage = {
        id: createLocalId("wallpaper"),
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "上传背景",
        dataUrl: result.dataUrl,
        size: result.size,
        createdAt: Date.now(),
      };
      setBackgroundConfig((current) => {
        const images = [item, ...current.images].slice(0, 6);
        return normalizePersonalizationBackgroundConfig({
          ...current,
          source: "upload",
          selectedId: item.id,
          urlType: "image",
          images,
        });
      });
      setBackgroundSourceMode("upload");
      toast.success(`背景已处理为 ${formatBytes(result.size)}`);
    } catch (err: any) {
      toast.error(err?.message || "背景上传失败");
    } finally {
      setCompressingBackground(false);
      if (backgroundInputRef.current) backgroundInputRef.current.value = "";
    }
  };

  const handleDeleteUploadedBackground = (id: string) => {
    setBackgroundConfig((current) => {
      const images = current.images.filter((item) => item.id !== id);
      const selectedDeleted = current.source === "upload" && current.selectedId === id;
      return normalizePersonalizationBackgroundConfig({
        ...current,
        source: selectedDeleted ? "none" : current.source,
        selectedId: selectedDeleted ? null : current.selectedId,
        images,
      });
    });
  };

  const applyBackgroundUrl = () => {
    const url = backgroundUrlInput.trim();
    if (!url) {
      toast.error("请填写背景链接");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      toast.error("背景链接必须以 http:// 或 https:// 开头");
      return;
    }
    updateBackground({
      source: "url",
      url,
      urlType: backgroundUrlType,
      selectedId: null,
    });
  };

  const handlePreviewHomepage = () => {
    const previewId = createLocalId("homepage");
    const previewKey = `forwardx.homepage.preview.${previewId}`;
    try {
      window.localStorage.setItem(previewKey, homepageHtml);
      window.sessionStorage.setItem("forwardx.homepage.preview", homepageHtml);
    } catch {
      window.sessionStorage.setItem("forwardx.homepage.preview", homepageHtml);
    }
    window.open(`/homepage-preview?mode=draft&id=${encodeURIComponent(previewId)}`, "_blank", "noopener,noreferrer");
  };

  const handleUseHomepageTemplate = async () => {
    if (homepageHtml.trim()) {
      const confirmed = await confirmDialog({
        title: "覆盖首页内容",
        description: "当前编辑内容会被示例模板覆盖，确定继续吗？",
        confirmText: "覆盖",
      });
      if (!confirmed) return;
    }
    setHomepageHtml(createDefaultHomepageHtml(personalizationTheme));
  };

  const handleSaveTitle = () => {
    return savePersonalizationSection("title", { siteTitle: siteTitleInput.trim().slice(0, 64) });
  };

  const handleSaveLogo = () => {
    if (siteLogoDataUrl && imageDataUrlSize(siteLogoDataUrl) > BRAND_LOGO_MAX_BYTES) {
      toast.error("Logo 超过 100KB，请重新上传");
      return false;
    }
    return savePersonalizationSection("logo", { siteLogoDataUrl });
  };

  const handleThemePresetSelect = (theme: PersonalizationThemePresetId) => {
    setPersonalizationTheme(theme);
  };

  const handleSaveThemePreset = () => {
    return savePersonalizationSection("theme", { personalizationTheme });
  };

  const handleSavePageTint = () => {
    return savePersonalizationSection("pageTint", { personalizationPageTint: pageTint });
  };

  const handleCustomTintChange = (value: string) => {
    setCustomTintInput(value);
    if (isHexColor(value)) setPageTint(value.trim().toLowerCase());
  };

  const handleSaveCardStyle = () => {
    return savePersonalizationSection("cardStyle", { personalizationCardStyle: cardStyle });
  };

  const handleSaveUiTheme = () => {
    return savePersonalizationSection("uiTheme", { personalizationUiTheme: uiTheme });
  };

  const handleSaveLiquidGlass = () => {
    return savePersonalizationSection("liquidGlass", { personalizationLiquidGlass: liquidGlass });
  };
  const updateLiquidGlass = (patch: Partial<LiquidGlassConfig>) => {
    setLiquidGlass((prev) => normalizeLiquidGlassConfig({ ...prev, ...patch }));
  };

  const handleSaveBackground = () => {
    const nextBackground = normalizePersonalizationBackgroundConfig(backgroundConfig);
    if (nextBackground.source === "url") {
      if (!nextBackground.url.trim()) {
        toast.error("请先应用背景链接");
        return false;
      }
      if (!/^https?:\/\//i.test(nextBackground.url.trim())) {
        toast.error("背景链接必须以 http:// 或 https:// 开头");
        return false;
      }
    }
    return savePersonalizationSection("background", { personalizationBackground: nextBackground });
  };

  const handleResetBackground = () => {
    setBackgroundConfig((current) =>
      normalizePersonalizationBackgroundConfig({
        ...DEFAULT_PERSONALIZATION_BACKGROUND,
        images: current.images,
      }),
    );
  };

  const handleSaveHomepage = () => {
    return savePersonalizationSection("homepage", {
      homepageEnabled,
      homepageCustomEnabled,
      homepageHtml,
    });
  };

  /*
    「点一下就试看」（参考 Rosélune 设置页的 Look：Click one to try it here）：界面主题、配色、页面底色、
    卡片风格选了就先在这一页挂上看效果，不用先存；存了才对所有人生效。离开设置页没存的话，退回到
    存着的那套（PersonalizationLayer 的规矩，含顶栏给自己选的那套）。
  */
  const savedLookRef = useRef({ theme: savedPersonalizationTheme, pageTint: savedPageTint, cardStyle: savedCardStyle, uiTheme: savedUiTheme });
  savedLookRef.current = { theme: savedPersonalizationTheme, pageTint: savedPageTint, cardStyle: savedCardStyle, uiTheme: savedUiTheme };
  const previewTouchedRef = useRef(false);
  useEffect(() => {
    if (!settings) return;
    const saved = savedLookRef.current;
    const changed = personalizationTheme !== saved.theme || pageTint !== saved.pageTint || cardStyle !== saved.cardStyle || uiTheme !== saved.uiTheme;
    if (!changed && !previewTouchedRef.current) return;
    previewTouchedRef.current = changed;
    // 记成「试看中」：PersonalizationLayer 之后再重挂（深浅色、淡入改了 class）也挂这一份，不会把它改回存着的
    setPersonalizationPreview(changed ? { theme: personalizationTheme, pageTint, cardStyle, uiTheme } : null);
    applyPersonalizationTheme(personalizationTheme);
    // 试看的是站点默认那一套：绕过顶栏给自己选的；什么都没改时回到平常的规矩
    applyPersonalizationSurface({ pageTint, cardStyle, uiTheme, ignoreOverride: changed });
  }, [settings, personalizationTheme, pageTint, cardStyle, uiTheme, savedPersonalizationTheme, savedPageTint, savedCardStyle, savedUiTheme]);
  useEffect(() => () => {
    setPersonalizationPreview(null);
    if (!previewTouchedRef.current) return;
    const saved = savedLookRef.current;
    applyPersonalizationTheme(saved.theme);
    applyPersonalizationSurface({ pageTint: saved.pageTint, cardStyle: saved.cardStyle, uiTheme: saved.uiTheme });
  }, []);
  /* 液态玻璃的旋钮同样点一下就试看：拨了就把草稿广播给照片层，存了或离开这页就撤 */
  useEffect(() => {
    setLiquidGlassPreview(liquidGlassDirty ? liquidGlass : null);
  }, [liquidGlass, liquidGlassDirty]);
  useEffect(() => () => setLiquidGlassPreview(null), []);

  /* 玫瑰主题下的贴底保存栏：每一块登记自己（见 SaveDock.tsx）。自定义菜单在弹窗里存，不登记。 */
  const dockActive = useSaveDockActive();
  const resetPersonalizationDraft = () => { if (settings) loadPersonalizationFromSettings(settings); };
  const savedBackgroundJson = settings
    ? JSON.stringify(normalizePersonalizationBackgroundConfig((settings as any).personalizationBackgroundConfig || settings.personalizationBackground))
    : "";
  const personalizationDockItems: Array<{ id: PersonalizationSaveKey; label: string; dirty: boolean; save: () => Promise<boolean> | boolean }> = [
    { id: "title", label: "网站标题", dirty: !!settings && siteTitleInput.trim().slice(0, 64) !== resolveSiteTitle(settings.siteTitle), save: handleSaveTitle },
    { id: "logo", label: "Logo", dirty: !!settings && siteLogoDataUrl !== (settings.siteLogoDataUrl || ""), save: handleSaveLogo },
    { id: "uiTheme", label: "界面主题", dirty: uiThemeDirty, save: handleSaveUiTheme },
    { id: "liquidGlass", label: "液态玻璃", dirty: liquidGlassDirty, save: handleSaveLiquidGlass },
    { id: "theme", label: "配色", dirty: themeDirty, save: handleSaveThemePreset },
    { id: "pageTint", label: "页面底色", dirty: pageTintDirty, save: handleSavePageTint },
    { id: "cardStyle", label: "卡片风格", dirty: cardStyleDirty, save: handleSaveCardStyle },
    { id: "background", label: "背景", dirty: !!settings && JSON.stringify(normalizePersonalizationBackgroundConfig(backgroundConfig)) !== savedBackgroundJson, save: handleSaveBackground },
    {
      id: "homepage",
      label: "首页",
      dirty: !!settings && (
        homepageEnabled !== (settings.homepageEnabled ?? true)
        || homepageCustomEnabled !== !!settings.homepageCustomEnabled
        || homepageHtml !== (settings.homepageHtml || "")
      ),
      save: handleSaveHomepage,
    },
  ];
  for (const item of personalizationDockItems) {
    // 列表是固定的八项、顺序不变，所以在循环里调 hook 是安全的
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useSaveDockItem({ ...item, id: `personalization.${item.id}`, pending: isSavingPersonalization(item.id), reset: resetPersonalizationDraft });
  }

  const openCustomSidebarDialog = (page?: CustomSidebarPage) => {
    setCustomSidebarDraft(page ? {
      id: page.id,
      name: page.name,
      url: page.url,
      visibility: page.visibility,
      openMode: page.openMode,
      svg: decodeCustomSidebarIconDataUrl(page.iconDataUrl),
    } : createCustomSidebarPageDraft());
    setCustomSidebarDialogOpen(true);
  };

  const handleCustomSidebarIconUpload = async (file?: File) => {
    if (!file) return;
    try {
      if (!file.name.toLowerCase().endsWith(".svg") && file.type !== "image/svg+xml") {
        throw new Error("请选择 SVG 文件");
      }
      if (file.size > MAX_CUSTOM_SIDEBAR_ICON_BYTES) {
        throw new Error("SVG 图标不能超过 24KB");
      }
      const svg = (await file.text()).trim();
      if (!isSafeCustomSidebarSvg(svg)) {
        throw new Error("SVG 图标包含脚本、外部资源或不支持的标签");
      }
      setCustomSidebarDraft((current) => ({ ...current, svg }));
    } catch (error: any) {
      toast.error(error?.message || "SVG 图标读取失败");
    } finally {
      if (customSidebarIconInputRef.current) customSidebarIconInputRef.current.value = "";
    }
  };

  const handleSaveCustomSidebarPage = () => {
    const name = customSidebarDraft.name.trim();
    const url = normalizeCustomSidebarUrl(customSidebarDraft.url);
    const svg = customSidebarDraft.svg.trim();
    if (!name) {
      toast.error("请填写菜单名称");
      return;
    }
    if (!isValidCustomSidebarUrl(url)) {
      toast.error("请输入有效的 HTTP/HTTPS 地址或面板路径（例如 /monitor）");
      return;
    }
    if (svg && !isSafeCustomSidebarSvg(svg)) {
      toast.error("SVG 图标包含脚本、外部资源或不支持的标签");
      return;
    }
    const page: CustomSidebarPage = {
      id: customSidebarDraft.id,
      name: name.slice(0, 64),
      url,
      visibility: customSidebarDraft.visibility,
      openMode: customSidebarDraft.openMode,
      ...(svg ? { iconDataUrl: encodeSvgDataUrl(svg) } : {}),
    };
    const exists = customSidebarPages.some((item) => item.id === page.id);
    if (!exists && customSidebarPages.length >= MAX_CUSTOM_SIDEBAR_PAGES) {
      toast.error(`最多添加 ${MAX_CUSTOM_SIDEBAR_PAGES} 个菜单项`);
      return;
    }
    const next = normalizeCustomSidebarPages(
      exists
        ? customSidebarPages.map((item) => item.id === page.id ? page : item)
        : [...customSidebarPages, page],
    );
    if (next.length !== (exists ? customSidebarPages.length : customSidebarPages.length + 1)) {
      toast.error("菜单项内容校验失败");
      return;
    }
    pendingCustomSidebarPagesRef.current = next;
    savePersonalizationSection("sidebarPages", { customSidebarPages: next });
  };

  const handleDeleteCustomSidebarPage = async (page: CustomSidebarPage) => {
    const confirmed = await confirmDialog({
      title: "删除菜单项",
      description: `确定删除“${page.name}”吗？`,
      confirmText: "删除",
      tone: "destructive",
    });
    if (!confirmed) return;
    const next = customSidebarPages.filter((item) => item.id !== page.id);
    pendingCustomSidebarPagesRef.current = next;
    savePersonalizationSection("sidebarPages", { customSidebarPages: next });
  };

  const customSidebarIconPreview = isSafeCustomSidebarSvg(customSidebarDraft.svg)
    ? encodeSvgDataUrl(customSidebarDraft.svg.trim())
    : "";

  if (isLoading) {
    return <DataSectionLoading label="正在加载个性化配置" minHeight="min-h-[220px]" />;
  }

  const previewUiTheme = uiThemeOptions.find((theme) => theme.id === uiTheme) || uiThemeOptions[0];

  return (
    <div className="space-y-4">
      {/*
        玫瑰主题下顶上一张「大家看到的样子」预览卡（参考 Rosélune 设置页 Name and logo 左边那张）：
        Logo、站点名、现在选的界面主题，跟着下面的输入实时变，不用先存。
      */}
      {dockActive ? (
        <div className="fx-brand-preview" aria-label="预览">
          <span className="fx-brand-preview-logo">
            {siteLogoDataUrl ? (
              <img src={siteLogoDataUrl} alt="" />
            ) : (
              <>
                <img src="/logo-light.png" alt="" className="dark:hidden" />
                <img src="/logo-dark.png" alt="" className="hidden dark:block" />
              </>
            )}
          </span>
          <b className="fx-brand-preview-name">{siteTitleInput.trim() || "NEX"}</b>
          <span className="fx-brand-preview-meta">
            <UiThemeDot theme={previewUiTheme} />
            {previewUiTheme.name}
            {uiThemeDirty ? <em>试看中，未保存</em> : null}
          </span>
        </div>
      ) : null}
      <div className="pt-2 first:pt-0">
        <p className="text-sm font-semibold text-foreground">站点</p>
        <p className="text-xs leading-5 text-muted-foreground">名字、Logo、菜单和公开首页，和主题无关。</p>
      </div>
      <div className="grid gap-4 @[58rem]:grid-cols-2">
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4 text-primary" />
              网站标题
            </CardTitle>
            <CardDescription>
              配置后台显示的品牌名称。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={siteTitleInput}
                onChange={(event) => setSiteTitleInput(event.target.value.slice(0, 64))}
                placeholder="NEX"
                className="flex-1"
              />
              <Button type="button" data-dock-save onClick={handleSaveTitle} disabled={isSavingPersonalization("title")} className="gap-2">
                {isSavingPersonalization("title") && <Loader2 className="h-4 w-4 animate-spin" />}
                保存
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              用于侧边栏、浏览器标题和移动端顶部展示，最多 64 个字符。
            </p>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ImageIcon className="h-4 w-4 text-primary" />
              Logo
            </CardTitle>
            <CardDescription>
              上传后会用于登录页、公开首页和侧边栏。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-muted/30">
                {siteLogoDataUrl ? (
                  <img src={siteLogoDataUrl} alt="Logo 预览" className="h-full w-full object-contain p-2" />
                ) : (
                  <>
                    <img src="/logo-light.png" alt="默认 Logo" className="h-full w-full object-contain p-2 dark:hidden" />
                    <img src="/logo-dark.png" alt="默认 Logo" className="hidden h-full w-full object-contain p-2 dark:block" />
                  </>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => handleLogoUpload(event.target.files?.[0])}
                  />
                  <Button type="button" variant="outline" onClick={() => logoInputRef.current?.click()} disabled={compressingLogo || isSavingPersonalization("logo")}>
                    {compressingLogo ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                    上传 Logo
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setSiteLogoDataUrl("")} disabled={!siteLogoDataUrl || compressingLogo || isSavingPersonalization("logo")}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    还原默认
                  </Button>
                  <Button type="button" data-dock-save onClick={handleSaveLogo} disabled={compressingLogo || isSavingPersonalization("logo")} className="gap-2">
                    {isSavingPersonalization("logo") && <Loader2 className="h-4 w-4 animate-spin" />}
                    保存 Logo
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  最大 100KB，超过后会在浏览器内自动压缩。
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <PanelLeft className="h-4 w-4 text-primary" />
              自定义菜单
            </CardTitle>
            <CardDescription>在左侧导航中嵌入常用页面；禁止 iframe 的网站可改为新窗口打开。</CardDescription>
          </div>
          <Button
            type="button"
            className="w-full gap-2 sm:w-auto"
            onClick={() => openCustomSidebarDialog()}
            disabled={isSavingPersonalization("sidebarPages") || customSidebarPages.length >= MAX_CUSTOM_SIDEBAR_PAGES}
          >
            <Plus className="h-4 w-4" />
            新增菜单项
          </Button>
        </CardHeader>
        <CardContent>
          {customSidebarPages.length ? (
            <div className="divide-y divide-border/40 overflow-hidden rounded-md border border-border/40 bg-muted/15">
              {customSidebarPages.map((page) => (
                <div key={page.id} className="flex min-w-0 items-center gap-3 px-3 py-3 sm:px-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background/70">
                    {page.iconDataUrl ? (
                      <img src={page.iconDataUrl} alt="" className="h-6 w-6 object-contain" />
                    ) : (
                      <Globe className="h-5 w-5 text-primary" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="max-w-full truncate text-sm font-medium">{page.name}</p>
                      <Badge variant="outline" className="shrink-0 text-[11px]">
                        {page.visibility === "admin" ? "仅管理员" : "所有用户"}
                      </Badge>
                      <Badge variant="secondary" className="shrink-0 text-[11px]">
                        {page.openMode === "external" ? "新窗口" : "嵌入"}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={page.url}>{page.url}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="编辑菜单项"
                      aria-label={`编辑 ${page.name}`}
                      disabled={isSavingPersonalization("sidebarPages")}
                      onClick={() => openCustomSidebarDialog(page)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      title="删除菜单项"
                      aria-label={`删除 ${page.name}`}
                      disabled={isSavingPersonalization("sidebarPages")}
                      onClick={() => void handleDeleteCustomSidebarPage(page)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => openCustomSidebarDialog()}
              className="flex min-h-28 w-full flex-col items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/15 px-4 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
            >
              <Plus className="mb-2 h-5 w-5" />
              新增第一个菜单项
            </button>
          )}
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4 text-primary" />
              公开首页
            </CardTitle>
            <CardDescription>
              设置未登录时展示的首页。
            </CardDescription>
          </div>
          <Button type="button" data-dock-save onClick={handleSaveHomepage} disabled={isSavingPersonalization("homepage")} className="w-full gap-2 sm:w-auto">
            {isSavingPersonalization("homepage") && <Loader2 className="h-4 w-4 animate-spin" />}
            保存首页
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <SettingList>
            <SettingRow
              asLabel
              label="启用公开首页"
              description="关闭后直接进入登录页。"
              control={<Checkbox aria-label="启用公开首页" checked={homepageEnabled} onCheckedChange={setHomepageEnabled} />}
            />
            <SettingRow
              asLabel
              label="使用自定义 H5"
              description="优先展示自定义页面。"
              control={<Checkbox aria-label="使用自定义 H5" checked={homepageCustomEnabled} onCheckedChange={setHomepageCustomEnabled} />}
            />
          </SettingList>
          {homepageCustomEnabled && (
            <div className="space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <Label className="text-sm font-medium">首页 H5/HTML 代码</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    支持完整 HTML 或 body 内容。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handleUseHomepageTemplate}>
                    使用示例
                  </Button>
                  <Button variant="outline" size="sm" onClick={handlePreviewHomepage} className="gap-2">
                    <Eye className="h-4 w-4" />
                    预览
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <a href="/homepage-preview" target="_blank" rel="noopener noreferrer">
                      查看已保存
                    </a>
                  </Button>
                </div>
              </div>
              <Textarea
                value={homepageHtml}
                onChange={(e) => setHomepageHtml(e.target.value)}
                placeholder="粘贴你的首页 H5/HTML 代码"
                className="min-h-72 font-mono text-xs leading-5"
              />
              <p className="text-xs text-muted-foreground">
                {homepageHtml.length.toLocaleString()} / 60,000 字符
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="pt-2 first:pt-0">
        <p className="text-sm font-semibold text-foreground">主题</p>
        <p className="text-xs leading-5 text-muted-foreground">先选一套整体风格；选的那套有自己的参数时，参数跟在下面。</p>
      </div>
      {/*
        界面主题：整套界面的气质（底、卡、外壳、控件形状一起换），是配色 / 底色 / 卡片风格底下那一层。
        三枚预览是 CSS 画的小手机屏（.fx-uitheme-swatch，见 styles/ui-theme-shared.css：主题样式按需加载，预览得跟主样式表走），经典是灰底白卡，
        极光是柔光底玻璃卡，墨金是米白纸上两张带暖线的奶白卡加一截金线；预览自带颜色，和当前选的是哪个无关。
      */}
      <Card className="border-border bg-card">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="h-4 w-4 text-primary" />
              界面主题
            </CardTitle>
            <CardDescription>
              一套换掉底色、卡片、顶栏和控件形状的整体风格。下面的配色、页面底色、卡片风格都是在它之上微调。点一下就在这一页试看，保存后才对所有人生效；顶栏的调色盘和这里是同一个设置，在那里换也会存到这里。这里列的是面板自带的三套和已经安装的主题包，更多主题在下面的「主题管理」里安装。
            </CardDescription>
          </div>
          <Button
            type="button"
            data-dock-save
            onClick={handleSaveUiTheme}
            disabled={isSavingPersonalization("uiTheme") || !uiThemeDirty}
            className="w-full gap-2 sm:w-auto"
          >
            {isSavingPersonalization("uiTheme") && <Loader2 className="h-4 w-4 animate-spin" />}
            保存主题
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {uiThemeOverride && uiThemeOverride !== savedUiTheme ? (
            <div className="flex flex-col gap-2 rounded-lg border border-[color-mix(in_srgb,var(--fx-warn)_25%,transparent)] bg-[var(--fx-warn-soft)] px-3 py-2.5 text-xs leading-5 text-[var(--fx-warn-text)] sm:flex-row sm:items-center sm:justify-between">
              <span>
                这台设备在顶栏调色盘里选了「{uiThemeOptions.find((theme) => theme.id === uiThemeOverride)?.name || uiThemeOverride}」，它盖过了这里的站点默认，所以你现在看到的是它。在这里保存主题，这台设备会自动改回跟随站点默认。
              </span>
              <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setUiThemeOverride(null)}>
                跟随站点默认
              </Button>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:max-w-3xl sm:grid-cols-3">
            {uiThemeOptions.map((theme) => {
              const active = uiTheme === theme.id;
              const deviceActive = (uiThemeOverride || savedUiTheme) === theme.id;
              return (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => setUiTheme(theme.id)}
                  disabled={isSavingPersonalization("uiTheme")}
                  aria-pressed={active}
                  className={cn(
                    "group flex flex-col gap-2 rounded-lg border p-2.5 text-left transition hover:border-primary/50 disabled:pointer-events-none disabled:opacity-70",
                    active ? "border-primary bg-primary/5 ring-2 ring-primary/15" : "border-border/40",
                  )}
                >
                  <UiThemeSwatch id={theme.id} preview={theme.preview} builtin={theme.builtin} />
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn("text-sm", active ? "font-semibold text-foreground" : "font-medium text-foreground")}>{theme.name}</span>
                    {active ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> : null}
                  </span>
                  {uiThemeOverride && deviceActive ? (
                    <span className="w-fit rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">本机在用（顶栏选的）</span>
                  ) : null}
                  <span className="text-xs leading-5 text-muted-foreground">{theme.description}</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* 主题管理：装 / 更新 / 卸载主题包（官方主题库、上传、链接）。装好的出现在上面那张卡片里。 */}
      <UiThemeManagerCard />

      {/*
        液态玻璃的旋钮只在界面主题选的是液态玻璃（或者刚拨过还没存）时露出来：别的主题下它们一个都不生效，
        摆在这里只会让人分不清哪些设置在管现在这套（2.3.546，用户：「各主题的配置有点乱」）。
      */}
      {uiTheme === "liquid-glass" || liquidGlassDirty ? (
        <Card className="border-border bg-card">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                <Palette className="h-4 w-4 text-primary" />
                液态玻璃
              </CardTitle>
              <CardDescription>
                「液态玻璃」主题自己的参数：照片从哪来、铺满全屏还是左右错落、浅色下照片上罩多厚的白雾、深色下照片多亮、玻璃卡模糊多少、卡片多不透、鼠标移上去要不要跟着亮。
                {uiTheme !== "liquid-glass" ? "现在选的不是液态玻璃，调了要切到那套才看得见。" : "拨一下就在这一页试看，保存后才对所有人生效。"}
              </CardDescription>
            </div>
            <Button
              type="button"
              data-dock-save
              onClick={handleSaveLiquidGlass}
              disabled={isSavingPersonalization("liquidGlass") || !liquidGlassDirty}
              className="w-full gap-2 sm:w-auto"
            >
              {isSavingPersonalization("liquidGlass") && <Loader2 className="h-4 w-4 animate-spin" />}
              保存参数
            </Button>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>照片来源</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {LIQUID_GLASS_PHOTO_SOURCES.map((item) => {
                  const active = liquidGlass.photoSource === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => updateLiquidGlass({ photoSource: item.id })}
                      disabled={isSavingPersonalization("liquidGlass")}
                      aria-pressed={active}
                      className={cn(
                        "flex flex-col gap-1 rounded-lg border p-2.5 text-left transition hover:border-primary/50 disabled:pointer-events-none disabled:opacity-70",
                        active ? "border-primary bg-primary/5 ring-2 ring-primary/15" : "border-border/40",
                      )}
                    >
                      <span className={cn("text-sm", active ? "font-semibold text-foreground" : "font-medium text-foreground")}>{item.name}</span>
                      <span className="text-xs leading-5 text-muted-foreground">{item.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-2">
              <Label>照片布局</Label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {LIQUID_GLASS_LAYOUTS.map((item) => {
                  const active = liquidGlass.layout === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => updateLiquidGlass({ layout: item.id })}
                      disabled={isSavingPersonalization("liquidGlass")}
                      aria-pressed={active}
                      className={cn(
                        "flex flex-col gap-1 rounded-lg border p-2.5 text-left transition hover:border-primary/50 disabled:pointer-events-none disabled:opacity-70",
                        active ? "border-primary bg-primary/5 ring-2 ring-primary/15" : "border-border/40",
                      )}
                    >
                      <span className={cn("text-sm", active ? "font-semibold text-foreground" : "font-medium text-foreground")}>{item.name}</span>
                      <span className="text-xs leading-5 text-muted-foreground">{item.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid gap-4 @[42rem]:grid-cols-2 @[58rem]:grid-cols-4 [&>*]:min-w-0">
              {([
                { key: "cardOpacity", label: "卡片不透明度", unit: "%", hint: "玻璃卡和分类条的底色浓度：浅色是白、深色是墨，越大越不透、字越清楚" },
                { key: "wash", label: "浅色白雾", unit: "%", hint: "罩在照片上的页面底色，越大照片越淡、字越清楚" },
                { key: "darkOpacity", label: "深色照片亮度", unit: "%", hint: "深色模式下照片的不透明度" },
                { key: "blur", label: "玻璃模糊", unit: "px", hint: "卡片背后的模糊半径，手机上卡多时调小更顺" },
              ] as const).map((item) => {
                const [min, max] = LIQUID_GLASS_LIMITS[item.key];
                const value = liquidGlass[item.key];
                return (
                  <FormField key={item.key} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_5rem] sm:items-center">
                    <div className="space-y-2">
                      <Label>{item.label}</Label>
                      <input
                        type="range"
                        aria-label={item.label}
                        min={min}
                        max={max}
                        step={1}
                        value={value}
                        onChange={(event) => updateLiquidGlass({ [item.key]: Number(event.target.value) })}
                        className="w-full accent-primary"
                      />
                      <p className="text-xs leading-5 text-muted-foreground">{item.hint}</p>
                    </div>
                    <div className="flex items-center gap-1 sm:mt-6 sm:self-start">
                      <Input
                        aria-label={`${item.label}（${item.unit}）`}
                        value={String(value)}
                        onChange={(event) => updateLiquidGlass({ [item.key]: Number(event.target.value.replace(/\D/g, "") || 0) })}
                        inputMode="numeric"
                      />
                      <span className="text-xs text-muted-foreground">{item.unit}</span>
                    </div>
                  </FormField>
                );
              })}
            </div>
            <SettingRow
              label="光标跟随的光斑"
              description="鼠标在玻璃卡上移动时，卡里跟着亮一团光。只在有鼠标的设备上有，触屏不跑。"
              control={<Checkbox aria-label="光标跟随的光斑" checked={liquidGlass.sheen} onCheckedChange={(checked) => updateLiquidGlass({ sheen: checked === true })} disabled={isSavingPersonalization("liquidGlass")} />}
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="pt-2 first:pt-0">
        <p className="text-sm font-semibold text-foreground">外观微调（所有主题通用）</p>
        <p className="text-xs leading-5 text-muted-foreground">在主题之上再调：配色、页面底色、卡片风格、布局密度、背景。</p>
      </div>
      <Card className="border-border bg-card">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="h-4 w-4 text-primary" />
              默认配色
            </CardTitle>
            <CardDescription>
              选择后保存，按钮、选中态、提示框、侧边栏主色和背景轻微渐变会同步变化。
            </CardDescription>
          </div>
          <Button
            type="button"
            data-dock-save
            onClick={handleSaveThemePreset}
            disabled={isSavingPersonalization("theme") || !themeDirty}
            className="w-full gap-2 sm:w-auto"
          >
            {isSavingPersonalization("theme") && <Loader2 className="h-4 w-4 animate-spin" />}
            保存配色
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2 @[58rem]:grid-cols-6">
            {PERSONALIZATION_THEME_PRESETS.map((preset) => {
              const active = personalizationTheme === preset.id;
              const saving = isSavingPersonalization("theme") && active;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleThemePresetSelect(preset.id)}
                  disabled={isSavingPersonalization("theme")}
                  className={cn(
                    "group flex min-h-32 flex-col justify-between rounded-lg border bg-background/50 p-3 text-left text-foreground transition hover:-translate-y-0.5 hover:border-primary/50 hover:bg-primary/5 disabled:pointer-events-none disabled:opacity-70",
                    active ? "border-primary bg-primary/5 ring-2 ring-primary/15" : "border-border/40",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{preset.name}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {preset.description}
                      </p>
                    </div>
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      ) : active ? (
                        <CheckCircle2 className="h-4 w-4 text-primary" />
                      ) : null}
                    </span>
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    {/* 第一枚是这套预设的主按钮渐变（浅色），和实际按钮一致；后两枚是淡底和深色 */}
                    {[personalizationSwatchGradient(preset.id), ...preset.swatches.slice(1)].map((color, index) => (
                      <span
                        key={`${preset.id}-${index}`}
                        className="h-7 w-7 rounded-full border border-background shadow-sm ring-1 ring-border/60"
                        style={{ background: color }}
                      />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/*
        页面底色：白卡下面那层底的颜色。色块画的就是效果本身：一小块底色上一枚白色的圆角矩形
        （一张卡），选中的描一圈主色。「跟随配色」那块用当前主色兑出来的底，自定义那块是彩虹。
        深色模式不受影响（applyPersonalizationSurface 只在浅色下写变量）。
      */}
      <Card className="border-border bg-card">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="h-4 w-4 text-primary" />
              页面底色
            </CardTitle>
            <CardDescription>
              白卡下面那一层底的颜色。选「跟随配色」时用当前配色兑出来的极淡色；深色模式不受影响。
            </CardDescription>
          </div>
          <Button
            type="button"
            data-dock-save
            onClick={handleSavePageTint}
            disabled={isSavingPersonalization("pageTint") || !pageTintDirty}
            className="w-full gap-2 sm:w-auto"
          >
            {isSavingPersonalization("pageTint") && <Loader2 className="h-4 w-4 animate-spin" />}
            保存底色
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
            {[...PERSONALIZATION_PAGE_TINTS.map((tint) => ({ id: tint.id as string, name: tint.name, page: tint.page, custom: false })), { id: "custom", name: "自定义", page: "", custom: true }].map((tint) => {
              const active = tint.custom ? pageTint.startsWith("#") : pageTint === tint.id;
              const swatchBackground = tint.custom
                ? (pageTint.startsWith("#") ? pageTint : "linear-gradient(135deg, #ffd6d6, #fff2cc 30%, #d9f5e5 60%, #dbe7ff 80%, #efdcff)")
                : tint.page;
              return (
                <button
                  key={tint.id}
                  type="button"
                  onClick={() => (tint.custom ? setPageTint(isHexColor(customTintInput) ? customTintInput.toLowerCase() : "#eef3fb") : setPageTint(tint.id))}
                  disabled={isSavingPersonalization("pageTint")}
                  aria-pressed={active}
                  className="group flex flex-col items-center gap-1.5 text-center disabled:pointer-events-none disabled:opacity-70"
                >
                  <span
                    className={cn(
                      "fx-tint-swatch flex h-14 w-full items-center justify-center rounded-xl border transition",
                      active ? "border-primary ring-2 ring-primary/20" : "border-border/50 group-hover:border-primary/40",
                    )}
                    style={{ background: swatchBackground }}
                  >
                    <span className="h-5 w-3/5 rounded-md bg-white shadow-[0_1px_2px_rgb(0_0_0/6%),0_6px_14px_-8px_rgb(0_0_0/25%)]" />
                  </span>
                  <span className={cn("text-xs", active ? "font-semibold text-foreground" : "text-muted-foreground")}>{tint.name}</span>
                </button>
              );
            })}
          </div>
          {pageTint.startsWith("#") ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                自定义颜色
                <input
                  type="color"
                  value={isHexColor(customTintInput) ? customTintInput : "#eef3fb"}
                  onChange={(event) => handleCustomTintChange(event.target.value)}
                  className="h-9 w-12 cursor-pointer rounded-md border border-border/60 bg-transparent p-0.5"
                  aria-label="选择自定义底色"
                />
              </label>
              <Input
                value={customTintInput}
                onChange={(event) => handleCustomTintChange(event.target.value)}
                placeholder="#eef3fb"
                className="h-9 w-32 font-mono text-sm"
                aria-label="自定义底色的十六进制值"
              />
              <span className="text-xs text-muted-foreground">建议选很浅的颜色：白卡靠软影坐在底上，底一深卡就浮不起来。</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/*
        卡片风格：卡上那一点颜色怎么给。色块画的是四种风格各自的缩影（左上角一抹光 / 一圈渐变边 /
        顶上一条线 / 纯白），和真卡用的是同一套 CSS 变量，所以色块和实际效果一致。
      */}
      <Card className="border-border bg-card">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="h-4 w-4 text-primary" />
              卡片风格
            </CardTitle>
            <CardDescription>
              卡片上的一点颜色：状态光、彩色描边、渐变卡头，或者都不要。颜色跟卡的状态走（正常主色、偏高琥珀、中断红）。
            </CardDescription>
          </div>
          <Button
            type="button"
            data-dock-save
            onClick={handleSaveCardStyle}
            disabled={isSavingPersonalization("cardStyle") || !cardStyleDirty}
            className="w-full gap-2 sm:w-auto"
          >
            {isSavingPersonalization("cardStyle") && <Loader2 className="h-4 w-4 animate-spin" />}
            保存风格
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {PERSONALIZATION_CARD_STYLES.map((style) => {
              const active = cardStyle === style.id;
              return (
                <button
                  key={style.id}
                  type="button"
                  onClick={() => setCardStyle(style.id)}
                  disabled={isSavingPersonalization("cardStyle")}
                  aria-pressed={active}
                  className={cn(
                    "group flex flex-col gap-2 rounded-lg border p-2.5 text-left transition hover:border-primary/50 disabled:pointer-events-none disabled:opacity-70",
                    active ? "border-primary bg-primary/5 ring-2 ring-primary/15" : "border-border/40",
                  )}
                >
                  <span className="fx-cardstyle-swatch" data-style={style.id} aria-hidden="true">
                    <span className="fx-cardstyle-swatch-face" />
                  </span>
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn("text-sm", active ? "font-semibold text-foreground" : "font-medium text-foreground")}>{style.name}</span>
                    {active ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> : null}
                  </span>
                  <span className="text-xs leading-5 text-muted-foreground">{style.description}</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* 布局密度：站点默认（standard / compact），每个账号可以在个人资料里覆盖。点了就存，不走上面的保存条。 */}
      <LayoutDefaultCard />

      <Card className="border-border bg-card">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="h-4 w-4 text-primary" />
              自定义背景
            </CardTitle>
            <CardDescription>
              默认不使用背景，可选择内置、上传或链接背景。
            </CardDescription>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button type="button" variant="outline" onClick={handleResetBackground} disabled={isSavingPersonalization("background")} className="w-full gap-2 sm:w-auto">
              <RefreshCw className="h-4 w-4" />
              恢复默认
            </Button>
            <Button type="button" data-dock-save onClick={handleSaveBackground} disabled={compressingBackground || isSavingPersonalization("background")} className="w-full gap-2 sm:w-auto">
              {isSavingPersonalization("background") && <Loader2 className="h-4 w-4 animate-spin" />}
              保存背景
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 @[58rem]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="space-y-4">
              <div className="relative min-h-52 overflow-hidden rounded-lg border border-border/40 bg-muted/30">
                {previewBackgroundUrl ? (
                  previewIsVideo ? (
                    <video
                      src={previewBackgroundUrl}
                      muted
                      loop
                      playsInline
                      autoPlay
                      className="absolute inset-0 h-full w-full object-cover opacity-70 transition-[filter,transform] duration-200"
                      style={previewBackdropStyle}
                    />
                  ) : (
                    <img
                      src={previewBackgroundUrl}
                      alt=""
                      aria-hidden="true"
                      loading="eager"
                      decoding="async"
                      className="absolute inset-0 h-full w-full object-cover opacity-70 transition-[filter,transform] duration-200"
                      style={previewBackdropStyle}
                    />
                  )
                ) : (
                  <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
                    未启用背景
                  </div>
                )}
                {previewBackgroundUrl && (
                  <div
                    className="absolute inset-0 bg-background"
                    style={{ opacity: 1 - clampBackgroundOpacity(backgroundConfig.opacity) }}
                  />
                )}
                {previewBackgroundUrl && (
                  <div className="absolute right-3 top-3 flex aspect-video w-28 max-w-[38%] items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background/70 p-1 shadow-sm backdrop-blur sm:w-32">
                    {previewIsVideo ? (
                      <video
                        src={previewBackgroundUrl}
                        muted
                        loop
                        playsInline
                        autoPlay
                        className="h-full w-full rounded-[4px] object-contain"
                      />
                    ) : (
                      <img
                        src={previewBackgroundUrl}
                        alt="背景原图预览"
                        loading="eager"
                        decoding="async"
                        className="h-full w-full rounded-[4px] object-contain"
                      />
                    )}
                  </div>
                )}
                <div className="absolute bottom-3 left-3 rounded-md border border-border/50 bg-background/75 px-3 py-2 text-xs backdrop-blur">
                  {backgroundEnabled ? `不透明度 ${opacityPercent}% / 虚化 ${blurAmount}px` : "无背景"}
                </div>
              </div>

              {backgroundEnabled && (
                <div className="space-y-3">
                  <div className="grid gap-4 @[42rem]:grid-cols-2 [&>*]:min-w-0">
                    <FormField className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem] sm:items-center">
                      <div className="space-y-2">
                        <Label>背景不透明度</Label>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          value={opacityPercent}
                          onChange={(event) => updateBackground({ opacity: Number(event.target.value) / 100 })}
                          className="w-full accent-primary"
                        />
                      </div>
                      <Input
                        value={String(opacityPercent)}
                        onChange={(event) => {
                          const value = Math.min(100, Math.max(0, Number(event.target.value.replace(/\D/g, "") || 0)));
                          updateBackground({ opacity: value / 100 });
                        }}
                        inputMode="numeric"
                        className="sm:mt-6"
                      />
                    </FormField>
                    <FormField className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem] sm:items-center">
                      <div className="space-y-2">
                        <Label>背景虚化程度</Label>
                        <input
                          type="range"
                          min={0}
                          max={32}
                          step={1}
                          value={blurAmount}
                          onChange={(event) => updateBackground({ blur: Number(event.target.value) })}
                          className="w-full accent-primary"
                        />
                      </div>
                      <Input
                        value={String(blurAmount)}
                        onChange={(event) => {
                          const value = Math.min(32, Math.max(0, Number(event.target.value.replace(/\D/g, "") || 0)));
                          updateBackground({ blur: value });
                        }}
                        inputMode="numeric"
                        className="sm:mt-6"
                      />
                    </FormField>
                  </div>
                  <div className="rounded-lg border border-[color-mix(in_srgb,var(--fx-warn)_25%,transparent)] bg-[var(--fx-warn-soft)] px-3 py-2 text-xs leading-5 text-[var(--fx-warn-text)]">
                    {mobileBackgroundHint}
                  </div>
                </div>
              )}

            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                {backgroundSourceOptions.map((option) => {
                  const Icon = option.icon;
                  const active = backgroundSourceMode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setBackgroundSourceMode(option.value)}
                      className={cn(
                        "flex min-h-10 items-center justify-center gap-2 rounded-lg border px-2 text-sm transition",
                        active ? "border-primary bg-primary/10 text-primary" : "border-border/40 bg-muted/20 hover:border-primary/50",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{option.label}</span>
                    </button>
                  );
                })}
              </div>

              {backgroundSourceMode === "builtin" && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">内置壁纸</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 @[58rem]:grid-cols-5">
                    {BUILTIN_WALLPAPERS.map((item) => {
                      const active = backgroundConfig.source === "builtin" && backgroundConfig.selectedId === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => updateBackground({ source: "builtin", selectedId: item.id, urlType: "image" })}
                          className={cn(
                            "group overflow-hidden rounded-lg border bg-muted/20 text-left transition",
                            active ? "border-primary ring-2 ring-primary/25" : "border-border/40 hover:border-primary/50",
                          )}
                        >
                          <img
                            src={item.url}
                            alt={item.name}
                            loading="lazy"
                            decoding="async"
                            className="aspect-[16/9] w-full bg-muted/40 object-contain transition-transform group-hover:scale-[1.02]"
                          />
                          <div className="px-3 py-2 text-xs font-medium">{item.name}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {backgroundSourceMode === "upload" && (
                <div className="space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium">上传背景</p>
                      <p className="text-xs text-muted-foreground">最多保留 6 张，单张最大 1.5MB，超过会自动压缩。</p>
                    </div>
                    <div>
                      <input
                        ref={backgroundInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => handleBackgroundUpload(event.target.files?.[0])}
                      />
                      <Button type="button" variant="outline" onClick={() => backgroundInputRef.current?.click()} disabled={compressingBackground || isSavingPersonalization("background")}>
                        {compressingBackground ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                        上传背景
                      </Button>
                    </div>
                  </div>
                  {backgroundConfig.images.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2 @[58rem]:grid-cols-3">
                      {backgroundConfig.images.map((item) => {
                        const active = backgroundConfig.source === "upload" && backgroundConfig.selectedId === item.id;
                        return (
                          <div
                            key={item.id}
                            className={cn(
                              "overflow-hidden rounded-lg border bg-muted/20",
                              active ? "border-primary ring-2 ring-primary/25" : "border-border/40",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => updateBackground({ source: "upload", selectedId: item.id, urlType: "image" })}
                              className="block w-full text-left"
                            >
                              <img src={item.dataUrl} alt={item.name} loading="lazy" decoding="async" className="aspect-[16/9] w-full bg-muted/40 object-contain" />
                            </button>
                            <div className="flex items-center justify-between gap-2 px-3 py-2">
                              <div className="min-w-0">
                                <p className="truncate text-xs font-medium" title={item.name}>{item.name}</p>
                                <p className="text-[11px] text-muted-foreground">{formatBytes(item.size || imageDataUrlSize(item.dataUrl))}</p>
                              </div>
                              <Button type="button" variant="ghost" size="icon" onClick={() => handleDeleteUploadedBackground(item.id)} aria-label={`删除 ${item.name}`}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/50 bg-muted/20 p-4 text-sm text-muted-foreground">
                      还没有上传背景。
                    </div>
                  )}
                </div>
              )}

              {backgroundSourceMode === "url" && (
                <div className="space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm font-medium">自定义链接</p>
                    <Button variant="outline" size="sm" className="w-full gap-1.5 sm:w-auto" asChild>
                      <a href="https://c.7zz.cn/home?path=cloudreve%3A%2F%2FVaU6%40share" target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-3.5 w-3.5" />
                        动态 MP4 视频库
                      </a>
                    </Button>
                  </div>
                  <div className="grid gap-2 @[42rem]:grid-cols-[9rem_minmax(0,1fr)_auto]">
                    <Select value={backgroundUrlType} onValueChange={(value) => setBackgroundUrlType(value as PersonalizationBackgroundUrlType)}>
                      <SelectTrigger aria-label="背景链接类型">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="image">图片链接</SelectItem>
                        <SelectItem value="video">视频链接</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={backgroundUrlInput}
                      onChange={(event) => setBackgroundUrlInput(event.target.value)}
                      placeholder="https://example.com/background.jpg"
                    />
                    <Button type="button" variant="outline" onClick={applyBackgroundUrl}>
                      应用链接
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    视频背景会静音循环播放，建议使用 HTTPS 链接；移动端不会展示视频背景。
                  </p>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={customSidebarDialogOpen}
        onOpenChange={(open) => {
          if (isSavingPersonalization("sidebarPages")) return;
          setCustomSidebarDialogOpen(open);
        }}
      >
        <DialogContent className="flex max-h-[calc(100svh-1.5rem)] max-w-xl flex-col overflow-hidden p-0">
          <DialogHeader className="px-4 pt-4 sm:px-6 sm:pt-6">
            <DialogTitle>
              {customSidebarPages.some((page) => page.id === customSidebarDraft.id) ? "编辑菜单项" : "新增菜单项"}
            </DialogTitle>
            <DialogDescription>配置左侧导航名称、页面地址、打开方式和可见范围。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 overflow-y-auto px-4 py-2 sm:px-6">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
              <div className="space-y-2">
                <Label htmlFor="custom-sidebar-name">菜单名称</Label>
                <Input
                  id="custom-sidebar-name"
                  value={customSidebarDraft.name}
                  maxLength={64}
                  onChange={(event) => setCustomSidebarDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="例如：监控中心"
                />
              </div>
              <FormField className="space-y-2">
                <Label>可见角色</Label>
                <Select
                  value={customSidebarDraft.visibility}
                  onValueChange={(visibility) => setCustomSidebarDraft((current) => ({
                    ...current,
                    visibility: visibility as CustomSidebarVisibility,
                  }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">仅管理员</SelectItem>
                    <SelectItem value="all">所有用户</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-sidebar-url">页面 URL</Label>
              <Input
                id="custom-sidebar-url"
                type="url"
                value={customSidebarDraft.url}
                maxLength={1000}
                onChange={(event) => setCustomSidebarDraft((current) => ({ ...current, url: event.target.value }))}
                placeholder="https://example.com/dashboard"
              />
              <p className="text-xs text-muted-foreground">支持完整网址、裸域名和面板相对路径（例如 /monitor）。</p>
            </div>
            <FormField className="space-y-2">
              <Label>打开方式</Label>
              <Select
                value={customSidebarDraft.openMode}
                onValueChange={(openMode) => setCustomSidebarDraft((current) => ({
                  ...current,
                  openMode: openMode as CustomSidebarOpenMode,
                }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={CUSTOM_SIDEBAR_OPEN_MODES[0]}>面板内嵌入</SelectItem>
                  <SelectItem value={CUSTOM_SIDEBAR_OPEN_MODES[1]}>新窗口打开</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">目标网站设置了 X-Frame-Options 或 CSP 时，请选择新窗口打开。</p>
            </FormField>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="custom-sidebar-svg">SVG 图标</Label>
                <div className="flex items-center gap-2">
                  <input
                    ref={customSidebarIconInputRef}
                    type="file"
                    accept=".svg,image/svg+xml"
                    className="hidden"
                    onChange={(event) => void handleCustomSidebarIconUpload(event.target.files?.[0])}
                  />
                  <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => customSidebarIconInputRef.current?.click()}>
                    <Upload className="h-3.5 w-3.5" />
                    上传 SVG
                  </Button>
                  {customSidebarDraft.svg && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setCustomSidebarDraft((current) => ({ ...current, svg: "" }))}>
                      清除
                    </Button>
                  )}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_4.5rem]">
                <Textarea
                  id="custom-sidebar-svg"
                  value={customSidebarDraft.svg}
                  onChange={(event) => setCustomSidebarDraft((current) => ({ ...current, svg: event.target.value.slice(0, 32 * 1024) }))}
                  placeholder={'<svg viewBox="0 0 24 24">...</svg>'}
                  className="min-h-28 font-mono text-xs leading-5"
                />
                <div className="flex min-h-20 items-center justify-center rounded-md border border-border/50 bg-muted/20">
                  {customSidebarIconPreview ? (
                    <img src={customSidebarIconPreview} alt="图标预览" className="h-8 w-8 object-contain" />
                  ) : (
                    <PanelLeft className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">可选，最大 24KB。</p>
            </div>
          </div>
          <DialogFooter className="gap-2 border-t border-border/40 px-4 py-3 sm:px-6">
            <Button type="button" variant="outline" disabled={isSavingPersonalization("sidebarPages")} onClick={() => setCustomSidebarDialogOpen(false)}>
              取消
            </Button>
            <Button type="button" className="gap-2" disabled={isSavingPersonalization("sidebarPages")} onClick={handleSaveCustomSidebarPage}>
              {isSavingPersonalization("sidebarPages") && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
