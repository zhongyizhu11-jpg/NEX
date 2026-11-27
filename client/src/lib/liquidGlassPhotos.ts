import { BUILTIN_WALLPAPERS, type LiquidGlassPhotoSource } from "@shared/personalization";

/*
  「液态玻璃」照片格里放哪几张（LiquidGlassBackdrop.tsx 用；2.3.550 抽出来并补兜底）。

  用户面板 2026-11-23：照片来源选的「自定义背景」，可「背景」里的选中项是空的（传过两张壁纸、都没选上），
  照片格里什么都没有，页面只剩一层很淡的彩色柔光，玻璃卡压在平的底色上，用户：「玻璃主题怎么一点都不像玻璃了」。
  现在没照片可放时先用内置壁纸顶着（随机照片拉不到也退到内置壁纸），玻璃永远有东西可透；
  真的不要照片的选「不放照片」。
*/

const LIQUID_GLASS_RANDOM_PHOTO_PROVIDER = "https://picsum.photos";

function liquidGlassRandomPhotoUrl(seed: number, index: number) {
  return `${LIQUID_GLASS_RANDOM_PHOTO_PROVIDER}/seed/${seed}-${index}/900/1200`;
}

/** 内置壁纸里按 seed 挑两张不同的：同一个标签页里稳定，下次打开换 */
export function liquidGlassBuiltinPair(seed: number): [string, string] {
  const list = BUILTIN_WALLPAPERS;
  const first = seed % list.length;
  const second = list.length > 1 ? (first + 1 + (Math.floor(seed / list.length) % (list.length - 1))) % list.length : first;
  return [list[first].url, list[second].url];
}

export type LiquidGlassPhotoSet = {
  /** 照片格里放的（空 = 不放照片，只剩渐变色块） */
  photos: string[];
  /** 某张拉不到时换成的内置壁纸（和 photos 一一对应；内置壁纸自己拉不到就没有兜底） */
  fallbacks: string[];
  /** 照片来源要的东西没有、临时用内置壁纸顶着（设置页据此提示） */
  substituted: boolean;
};

export function liquidGlassPhotoSet(input: { photoSource: LiquidGlassPhotoSource; wallpaper: string | null; seed: number }): LiquidGlassPhotoSet {
  const builtin = liquidGlassBuiltinPair(input.seed);
  const random = [liquidGlassRandomPhotoUrl(input.seed, 1), liquidGlassRandomPhotoUrl(input.seed, 2)];
  const wallpaper = input.wallpaper ? [input.wallpaper] : null;
  switch (input.photoSource) {
    case "none":
      return { photos: [], fallbacks: [], substituted: false };
    case "builtin":
      return { photos: builtin, fallbacks: [], substituted: false };
    case "wallpaper":
      return wallpaper
        ? { photos: wallpaper, fallbacks: [builtin[0]], substituted: false }
        : { photos: builtin, fallbacks: [], substituted: true };
    case "random":
      return { photos: random, fallbacks: builtin, substituted: false };
    default:
      return wallpaper
        ? { photos: wallpaper, fallbacks: [builtin[0]], substituted: false }
        : { photos: random, fallbacks: builtin, substituted: false };
  }
}

/** 设置页上「照片来源」要的东西还没有时的提示；不用提示返回空串。 */
export function liquidGlassPhotoSourceHint(photoSource: LiquidGlassPhotoSource, hasWallpaper: boolean): string {
  if (photoSource === "wallpaper" && !hasWallpaper) return "「背景」里还没选壁纸，先用内置壁纸顶着；在下面的「背景」里选一张并保存就换成你那张。";
  return "";
}
