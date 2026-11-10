import type { CSSProperties } from "react";

import type { UiThemePreview } from "@shared/uiThemePackage";

/*
  界面主题的预览小屏（.fx-uitheme-swatch，画法在 client/src/styles/ui-theme-shared.css）。

  内置的三套和官方主题库里的五套各有一份手画的预览（按 data-theme 选）；别的主题包没有，
  用清单里的三种预览色（页面底 / 卡片 / 强调色）套经典那套形状：颜色从这里写到 style 上，
  样式表按 data-theme-package 取。官方主题库的那几套两样都带着，手画的那份排在后面，盖过通用的。
*/
export function UiThemeSwatch({ id, preview, builtin }: { id: string; preview: UiThemePreview; builtin?: boolean }) {
  const style = builtin ? undefined : {
    "--sw-page": preview.light.page,
    "--sw-card": preview.light.card,
    "--sw-accent": preview.light.accent,
    "--sw-page-dark": preview.dark.page,
    "--sw-card-dark": preview.dark.card,
    "--sw-accent-dark": preview.dark.accent,
  } as CSSProperties;
  return (
    <span className="fx-uitheme-swatch" data-theme={id} data-theme-package={builtin ? undefined : ""} style={style} aria-hidden="true">
      <i /><i /><b />
    </span>
  );
}
