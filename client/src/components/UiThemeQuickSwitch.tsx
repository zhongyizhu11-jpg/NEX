import { useEffect, useState } from "react";
import { Check, Palette } from "lucide-react";

import { PERSONALIZATION_UI_THEMES } from "@shared/personalization";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { readUiThemeOverride, setUiThemeOverride, UI_THEME_OVERRIDE_EVENT } from "@/lib/personalizationTheme";

/*
  顶栏的调色盘：给**自己**挑一套界面主题，只记在这台设备上，不改站点默认（那个在设置 › 个性化里）。
  参考 Rosélune 面板顶栏的 Look 菜单（2026-10-11）：每项前面一枚小圆，底是那套的页面底色、
  右上一点是它的强调色，一眼看得出是哪一套。
*/
export const UI_THEME_DOTS: Record<string, { a: string; b: string }> = {
  classic: { a: "#3ea4ec", b: "#f5f5f7" },
  aurora: { a: "#a78bfa", b: "#eef1fb" },
  gilt: { a: "#b08d57", b: "#f5f2ec" },
  rose: { a: "#c13a66", b: "#fbf0f2" },
  cinnabar: { a: "#d42a33", b: "#f6f6f4" },
  "liquid-glass": { a: "#2563eb", b: "#dfe7f3" },
  indigo: { a: "#4268aa", b: "#f2f3f5" },
};

export function UiThemeDot({ id }: { id: string }) {
  const dot = UI_THEME_DOTS[id] || UI_THEME_DOTS.classic;
  return <span className="fx-theme-dot" style={{ ["--sw-a" as any]: dot.a, ["--sw-b" as any]: dot.b }} aria-hidden="true" />;
}

export function UiThemeQuickSwitch({ className }: { className?: string }) {
  const [override, setOverride] = useState<string | null>(() => readUiThemeOverride());
  useEffect(() => {
    const sync = () => setOverride(readUiThemeOverride());
    window.addEventListener(UI_THEME_OVERRIDE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(UI_THEME_OVERRIDE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={className || "workspace-appbar-icon"} aria-label="界面主题" title="给自己换一套界面主题">
          <Palette className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">界面主题（只在这台设备）</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setUiThemeOverride(null)} className="gap-2.5">
          <span className="fx-theme-dot fx-theme-dot-auto" aria-hidden="true" />
          <span className="flex-1">跟随站点默认</span>
          {override === null ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {PERSONALIZATION_UI_THEMES.map((theme) => (
          <DropdownMenuItem key={theme.id} onSelect={() => setUiThemeOverride(theme.id)} className="gap-2.5">
            <UiThemeDot id={theme.id} />
            <span className="flex-1">{theme.name}</span>
            {override === theme.id ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
