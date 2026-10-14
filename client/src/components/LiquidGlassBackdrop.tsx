import { useEffect, useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { useUiTheme } from "@/hooks/useUiTheme";

/*
  「液态玻璃」主题（theme-liquid-glass.css）的两件动的东西，只在 <html data-ui-theme="liquid-glass"> 下挂：

    1. 照片底   两张大幅圆角照片错落铺在页面后面（预览站 BackgroundScroll 的画法）。默认和预览站一样每次
                打开随机拉两张（picsum.photos），记在 sessionStorage 里，同一个标签页里换页不换图；用户在
                设置 › 个性化 › 背景图里设了壁纸就两格都放那张（视频壁纸这套不放，照片格退回渐变色块）。
                图拉不到（断网、被墙）就让 CSS 里那组渐变色块露出来，卡仍然是玻璃。
    2. 光标跟随 鼠标在玻璃卡上移动时，卡里跟着亮一团白光：把光标相对卡的位置写进卡的 --fx-sheen-x/y，
                进来 --fx-sheen-a 置 1、离开置 0，画法在 CSS 的卡片背景第一层。只在有鼠标的设备上监听
                （hover: hover + pointer: fine），触屏一次都不跑。pointermove 只写三个自定义属性、不读布局
                （getBoundingClientRect 在 pointerenter 时读一次缓存起来），一帧之内合并成一次。
*/

const PHOTO_PROVIDER = "https://picsum.photos";
const SEED_STORAGE_KEY = "forwardx-liquid-glass-seed";
const SHEEN_MEDIA = "(hover: hover) and (pointer: fine)";
const SHEEN_TARGETS = '.workspace-main [data-slot="card"], .fx-card-face, .fx-summary, .auth-card-surface';

function readSeed(): string {
  try {
    const saved = sessionStorage.getItem(SEED_STORAGE_KEY);
    if (saved) return saved;
    const fresh = String(Math.floor(Math.random() * 100000));
    sessionStorage.setItem(SEED_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return String(Math.floor(Math.random() * 100000));
  }
}

function photoUrl(seed: string, index: number) {
  return `${PHOTO_PROVIDER}/seed/${seed}-${index}/900/1200`;
}

function Photo({ src }: { src: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);
  const show = !!src && !failed;
  return (
    <div className="fx-lg-photo" data-loaded={show && loaded ? "true" : "false"}>
      {show ? (
        <img
          src={src}
          alt=""
          loading="eager"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}

function useCursorSheen(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia(SHEEN_MEDIA).matches) return;
    let current: HTMLElement | null = null;
    let rect: DOMRect | null = null;
    let frame = 0;
    let pending: { x: number; y: number } | null = null;

    const flush = () => {
      frame = 0;
      if (!current || !rect || !pending) return;
      const x = ((pending.x - rect.left) / Math.max(1, rect.width)) * 100;
      const y = ((pending.y - rect.top) / Math.max(1, rect.height)) * 100;
      current.style.setProperty("--fx-sheen-x", `${x.toFixed(1)}%`);
      current.style.setProperty("--fx-sheen-y", `${y.toFixed(1)}%`);
    };
    const leave = () => {
      if (!current) return;
      current.style.setProperty("--fx-sheen-a", "0");
      current = null;
      rect = null;
    };
    const onMove = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(SHEEN_TARGETS) : null;
      if (target !== current) {
        leave();
        if (target) {
          current = target;
          rect = target.getBoundingClientRect();
          target.style.setProperty("--fx-sheen-a", "1");
        }
      }
      if (!current) return;
      pending = { x: event.clientX, y: event.clientY };
      if (!frame) frame = window.requestAnimationFrame(flush);
    };
    const onLeaveDocument = () => leave();
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeaveDocument);
    window.addEventListener("scroll", onLeaveDocument, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeaveDocument);
      window.removeEventListener("scroll", onLeaveDocument);
      if (frame) window.cancelAnimationFrame(frame);
      leave();
    };
  }, [enabled]);
}

export default function LiquidGlassBackdrop() {
  const uiTheme = useUiTheme();
  const active = uiTheme === "liquid-glass";
  const { data } = trpc.system.publicInfo.useQuery(undefined, {
    enabled: active && (!mobileAuth.isNative || mobileAuth.hasPanelUrl()),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  });
  const seed = useMemo(() => readSeed(), []);
  useCursorSheen(active);
  if (!active) return null;

  const background = data?.personalizationBackground;
  const source = background?.source || "none";
  const urlType = background?.urlType || "image";
  const customUrl = String(background?.effectiveUrl || "");
  const isVideo = source === "url" && urlType === "video";
  const sources: [string | null, string | null] = isVideo
    ? [null, null]
    : source !== "none" && customUrl
      ? [customUrl, customUrl]
      : [photoUrl(seed, 1), photoUrl(seed, 2)];

  return (
    <div className="fx-lg-backdrop" aria-hidden="true">
      <div className="fx-lg-backdrop-wings">
        <Photo src={sources[0]} />
        <Photo src={sources[1]} />
      </div>
    </div>
  );
}
