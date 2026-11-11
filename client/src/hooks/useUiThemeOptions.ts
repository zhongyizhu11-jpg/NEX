import { useMemo } from "react";

import { PERSONALIZATION_UI_THEMES } from "@shared/personalization";
import { DEFAULT_UI_THEME_PREVIEW, type UiThemePreview } from "@shared/uiThemePackage";
import { useInstalledUiThemes } from "@/lib/installedUiThemes";

/*
  能选的界面主题：内置的三套在前，后面跟着这个面板上装着的主题包（装的先后）。
  顶栏调色盘和设置 › 个性化 › 界面主题都用这一份，两边列出来的永远一样。
*/
export type UiThemeOption = {
  id: string;
  name: string;
  description: string;
  /** 内置的随页面打包；不是内置的就是装上去的主题包 */
  builtin: boolean;
  /** 预览色：主题包来自清单；内置的只给调色盘里那枚小圆点用（设置页的预览小屏是 CSS 画的） */
  preview: UiThemePreview;
};

const BUILTIN_PREVIEWS: Record<string, UiThemePreview> = {
  classic: DEFAULT_UI_THEME_PREVIEW,
  pearl: { light: { page: "#f4f6f5", card: "#ffffff", accent: "#0e1116" }, dark: { page: "#161b1e", card: "#1f2629", accent: "#f4f6f5" } },
  "liquid-glass": { light: { page: "#dfe7f3", card: "#ffffff", accent: "#2563eb" }, dark: { page: "#111318", card: "#181c26", accent: "#3b82f6" } },
};

export function useUiThemeOptions(): UiThemeOption[] {
  const installed = useInstalledUiThemes();
  return useMemo(() => [
    ...PERSONALIZATION_UI_THEMES.map((theme) => ({
      id: theme.id as string,
      name: theme.name as string,
      description: theme.description as string,
      builtin: true,
      preview: BUILTIN_PREVIEWS[theme.id] || DEFAULT_UI_THEME_PREVIEW,
    })),
    ...installed.map((theme) => ({ id: theme.id, name: theme.name, description: theme.description, builtin: false, preview: theme.preview })),
  ], [installed]);
}
