import { Check, Palette } from "lucide-react";

import { toast } from "sonner";

import { normalizePersonalizationUiTheme, PERSONALIZATION_UI_THEMES } from "@shared/personalization";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setUiThemeOverride } from "@/lib/personalizationTheme";
import { useUiThemeOverride } from "@/hooks/useUiThemeOverride";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";

/*
  顶栏的调色盘。管理员：和设置 › 个性化 › 界面主题是同一个值，选了就存成站点主题（2.3.436 起，
  原来只记在这台设备上，和设置里各管各的，用户觉得「不同步」）。其他人改不了站点设置：仍然只给
  **自己**这台设备挑一套（localStorage），不影响别人，没选就跟随站点默认。
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
  pearl: { a: "#0e1116", b: "#f4f6f5" },
};

export function UiThemeDot({ id }: { id: string }) {
  const dot = UI_THEME_DOTS[id] || UI_THEME_DOTS.classic;
  return <span className="fx-theme-dot" style={{ ["--sw-a" as any]: dot.a, ["--sw-b" as any]: dot.b }} aria-hidden="true" />;
}

export function UiThemeQuickSwitch({ className }: { className?: string }) {
  const override = useUiThemeOverride();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const { data: publicInfo } = trpc.system.publicInfo.useQuery(undefined, { enabled: isAdmin, staleTime: 60_000, refetchOnWindowFocus: false, retry: false });
  const siteTheme = normalizePersonalizationUiTheme((publicInfo as any)?.personalizationUiTheme);
  const saveSiteTheme = trpc.system.updateSettings.useMutation();

  /*
    管理员：顶栏调色盘和设置 › 个性化 › 界面主题是同一个值（2.3.436 用户要求「完全同步」）。
    这里一选就存成站点主题，设置页、别的设备跟着变；先把两份缓存改掉让页面当场换，存失败再撤回。
    顺手清掉这台设备以前在这里选过的「只给自己」那一套，不然它会盖过刚存的站点主题；存失败连它一起放回去。
  */
  const selectSiteTheme = (id: string) => {
    const next = normalizePersonalizationUiTheme(id);
    const previousOverride = override;
    setUiThemeOverride(null);
    const previous = siteTheme;
    utils.system.publicInfo.setData(undefined, (old: any) => (old ? { ...old, personalizationUiTheme: next } : old));
    utils.system.getSettings.setData(undefined, (old: any) => (old ? { ...old, personalizationUiTheme: next } : old));
    saveSiteTheme.mutate(
      { personalizationUiTheme: next },
      {
        onSuccess: () => {
          void utils.system.publicInfo.invalidate();
          void utils.system.getSettings.invalidate();
        },
        onError: (error) => {
          utils.system.publicInfo.setData(undefined, (old: any) => (old ? { ...old, personalizationUiTheme: previous } : old));
          utils.system.getSettings.setData(undefined, (old: any) => (old ? { ...old, personalizationUiTheme: previous } : old));
          if (previousOverride) setUiThemeOverride(previousOverride);
          toast.error(error.message || "界面主题保存失败");
        },
      },
    );
  };

  if (isAdmin) {
    const current = override ?? siteTheme;
    return (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={className || "workspace-appbar-icon"} aria-label="界面主题" title="换一套界面主题（和设置里同步）">
            <Palette className="h-4 w-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">界面主题（全站，和设置同步）</DropdownMenuLabel>
          {PERSONALIZATION_UI_THEMES.map((theme) => (
            <DropdownMenuItem key={theme.id} onSelect={() => selectSiteTheme(theme.id)} disabled={saveSiteTheme.isPending} className="gap-2.5">
              <UiThemeDot id={theme.id} />
              <span className="flex-1">{theme.name}</span>
              {current === theme.id ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  /* 其他人改不了站点设置：顶栏仍然只给自己这台设备换，没选就跟随站点默认 */
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
