import { useState, useSyncExternalStore } from "react";
import { Check, Languages } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getLanguage, getLanguagePreference, setLanguagePreference, subscribeLanguage, type LanguagePreference } from "@/i18n";
import { cn } from "@/lib/utils";

/*
  界面语言切换。三处用：登录页右上角、首次部署向导、顶栏账户菜单（菜单里是一行「语言」，点一下中英互换）。
  选项名一律写成该语言自己的写法（「简体中文」「English」），并且标 data-no-translate：
  不管当前是哪种语言，看不懂的人也找得到回去的那一项。
*/

const OPTIONS: ReadonlyArray<{ value: LanguagePreference; label: string; hint?: string }> = [
  { value: "auto", label: "自动 · Auto", hint: "跟随浏览器 · Browser" },
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
];

export function useLanguagePreference() {
  const preference = useSyncExternalStore(subscribeLanguage, getLanguagePreference, getLanguagePreference);
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  return { preference, language };
}

const ICON_BUTTON_CLASS = "flex h-9 w-9 items-center justify-center rounded-md bg-[var(--fx-l1-surface)] text-foreground shadow-[var(--fx-elevation-control)] transition-colors hover:bg-[var(--fx-hover)] focus:outline-none focus-visible:shadow-[var(--fx-focus-ring)]";

/** 独立的小按钮 + 下拉（登录页、首次部署） */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { preference } = useLanguagePreference();
  const [busy, setBusy] = useState(false);
  const choose = (value: LanguagePreference) => {
    setBusy(true);
    void setLanguagePreference(value).finally(() => setBusy(false));
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(ICON_BUTTON_CLASS, className)} aria-label="语言 / Language" title="语言 / Language" disabled={busy} data-no-translate="">
          <Languages className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44" data-no-translate="">
        {OPTIONS.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => choose(option.value)} className="gap-2.5" role="menuitemradio" aria-checked={preference === option.value}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{option.label}</span>
              {option.hint ? <span className="text-xs text-muted-foreground">{option.hint}</span> : null}
            </span>
            {preference === option.value ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 顶栏账户菜单里的一行：点一下中英互换，菜单不关，当场看到 */
export function LanguageMenuItem() {
  const { language } = useLanguagePreference();
  const next = language === "en" ? "zh-CN" : "en";
  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault();
        void setLanguagePreference(next);
      }}
      className="cursor-pointer"
      data-no-translate=""
    >
      <Languages />
      <span>{language === "en" ? "Language" : "语言"}</span>
      <span className="ml-auto text-xs text-muted-foreground">{language === "en" ? "English → 中文" : "中文 → English"}</span>
    </DropdownMenuItem>
  );
}
