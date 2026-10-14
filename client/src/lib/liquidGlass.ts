import { normalizeLiquidGlassConfig, type LiquidGlassConfig } from "@shared/personalization";

/*
  「液态玻璃」参数怎么落到页面上。

  存着的那份从 publicInfo 来（LiquidGlassBackdrop.tsx 读）；设置页拨旋钮时「点一下就试看」：把草稿
  通过 setLiquidGlassPreview 广播出去，照片层听到就按草稿画，离开设置页或存完清掉（传 null）。
  三个数字落成 <html> 上的变量，CSS 里 blur / 罩层 / 深色照片透明度都读它们；光标跟随由照片层自己按
  sheen 开关挂不挂监听。
*/
export const LIQUID_GLASS_PREVIEW_EVENT = "fx-liquid-glass-preview";

let preview: LiquidGlassConfig | null = null;

export function readLiquidGlassPreview() {
  return preview;
}

export function setLiquidGlassPreview(value: LiquidGlassConfig | null) {
  preview = value ? normalizeLiquidGlassConfig(value) : null;
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof Event === "function") {
    window.dispatchEvent(new Event(LIQUID_GLASS_PREVIEW_EVENT));
  }
}

const VARS = ["--fx-lg-wash", "--fx-lg-dark-opacity", "--fx-lg-blur-px"] as const;

export function applyLiquidGlassVars(config: LiquidGlassConfig, root?: HTMLElement) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  if (!target) return;
  target.style.setProperty("--fx-lg-wash", `${config.wash}%`);
  target.style.setProperty("--fx-lg-dark-opacity", String(config.darkOpacity / 100));
  target.style.setProperty("--fx-lg-blur-px", `${config.blur}px`);
}

export function clearLiquidGlassVars(root?: HTMLElement) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  if (!target) return;
  for (const name of VARS) target.style.removeProperty(name);
}
