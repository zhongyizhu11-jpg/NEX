import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { applyPersonalizationSurface, applyPersonalizationTheme, clearPersonalizationSurface, clearPersonalizationTheme, UI_THEME_OVERRIDE_EVENT, UI_THEME_OVERRIDE_STORAGE_KEY } from "@/lib/personalizationTheme";
import { setInstalledUiThemes, uiThemeListKey } from "@/lib/installedUiThemes";
import { setUiThemeAssetBase } from "@/lib/uiThemeStyles";
import { useEffect, useLayoutEffect, useState } from "react";

const MOBILE_BACKGROUND_MEDIA = "(max-width: 767px), (pointer: coarse)";

function cssUrl(value: string) {
  return `url("${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

function shouldReduceMobileBackground() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(MOBILE_BACKGROUND_MEDIA).matches;
}

export default function PersonalizationLayer() {
  const { data } = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  });
  const [reduceMobileBackground, setReduceMobileBackground] = useState(shouldReduceMobileBackground);
  const background = data?.personalizationBackground;
  const effectiveUrl = String(background?.effectiveUrl || "");
  const source = background?.source || "none";
  const urlType = background?.urlType || "image";
  const opacity = Math.min(1, Math.max(0, Number(background?.opacity ?? 0.22)));
  const blur = Math.min(32, Math.max(0, Number(background?.blur ?? 0)));
  const personalizationTheme = (data as any)?.personalizationTheme;
  const personalizationPageTint = (data as any)?.personalizationPageTint;
  const personalizationCardStyle = (data as any)?.personalizationCardStyle;
  const personalizationUiTheme = (data as any)?.personalizationUiTheme;
  // 这个面板上装着的主题包（id + 样式版本）：变了要重新算一遍现在该用哪套（刚装上的也许正是站点默认，正用着的也许被卸了）
  const installedUiThemes: unknown = data && "installedUiThemes" in data ? data.installedUiThemes : undefined;
  const installedUiThemesKey = uiThemeListKey(installedUiThemes);
  const effectiveBlur = reduceMobileBackground ? 0 : blur;
  const scale = 1 + effectiveBlur / 320;
  const isVideoBackground = source === "url" && urlType === "video" && !!effectiveUrl;
  const showVideo = isVideoBackground && !reduceMobileBackground;
  const showImage = source !== "none" && !isVideoBackground && !!effectiveUrl;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(MOBILE_BACKGROUND_MEDIA);
    const sync = () => setReduceMobileBackground(media.matches);
    sync();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }
    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--personalization-bg-opacity", String(opacity));
    root.style.setProperty("--personalization-bg-blur", `${effectiveBlur}px`);
    root.style.setProperty("--personalization-bg-scale", String(scale));
    if (showImage) {
      root.style.setProperty("--personalization-bg-image", cssUrl(effectiveUrl));
      root.setAttribute("data-personalization-background", "image");
    } else {
      root.style.removeProperty("--personalization-bg-image");
      if (!showVideo) root.setAttribute("data-personalization-background", "none");
    }
    if (showVideo) root.setAttribute("data-personalization-background", "video");
    return () => {
      root.style.removeProperty("--personalization-bg-image");
      root.style.removeProperty("--personalization-bg-opacity");
      root.style.removeProperty("--personalization-bg-blur");
      root.style.removeProperty("--personalization-bg-scale");
      root.removeAttribute("data-personalization-background");
    };
  }, [effectiveBlur, effectiveUrl, opacity, scale, showImage, showVideo]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    // 名单要先于主题：下面算「该用哪一套」、去哪取样式都靠它。publicInfo 还没回来时不动开机读到的那份缓存。
    if (installedUiThemesKey !== null) setInstalledUiThemes(installedUiThemes);
    setUiThemeAssetBase(mobileAuth.isNative ? mobileAuth.panelOrigin() : "");
    const applyTheme = () => {
      applyPersonalizationTheme(personalizationTheme, root);
      // 底色只在浅色下写，所以深浅切换（class 变化）时要跟着重算
      applyPersonalizationSurface({ pageTint: personalizationPageTint, cardStyle: personalizationCardStyle, uiTheme: personalizationUiTheme }, root);
    };
    applyTheme();
    const observer = new MutationObserver(applyTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    // 顶栏调色盘给自己换了一套（这一页或别的标签页）：马上重挂
    const onStorage = (event: StorageEvent) => { if (event.key === UI_THEME_OVERRIDE_STORAGE_KEY) applyTheme(); };
    window.addEventListener(UI_THEME_OVERRIDE_EVENT, applyTheme);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(UI_THEME_OVERRIDE_EVENT, applyTheme);
      window.removeEventListener("storage", onStorage);
      observer.disconnect();
      clearPersonalizationTheme(root);
      clearPersonalizationSurface(root);
    };
    // installedUiThemes 本身每次请求都是新数组，用拼出来的 key 判断有没有变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personalizationTheme, personalizationPageTint, personalizationCardStyle, personalizationUiTheme, installedUiThemesKey]);

  if (!showVideo) return null;

  return (
    <video
      key={effectiveUrl}
      className="personalization-video-background"
      src={effectiveUrl}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
    />
  );
}
