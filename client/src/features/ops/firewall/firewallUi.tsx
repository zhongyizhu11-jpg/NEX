import { useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import {
  FIREWALL_COMMON_COUNTRIES,
  FIREWALL_COUNTRY_CODES,
  countryFlagEmoji,
  firewallCountryName,
  type FirewallMode,
} from "@shared/firewallCountries";

/*
  地区规则页和 IP 封禁页共用的小件：编号分节、模式分段、国家多选、时间格式。
*/

export const FIREWALL_MODE_LABELS: Record<FirewallMode, string> = {
  off: "关闭",
  block: "拦截这些国家",
  allow: "只放行这些国家",
};

/** 一节：左上角一个 01 / 02 的序号，标题、说明，下面是内容。 */
export function NumberedSection({ index, title, description, children, aside }: {
  index: number;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="rounded-[var(--fx-radius-surface)] bg-[var(--fx-l1-surface)] p-3 sm:p-4" aria-label={title}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-primary" aria-hidden="true">
            {String(index).padStart(2, "0")}
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-snug sm:text-base">{title}</h2>
            {description ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground sm:text-[13px]">{description}</p> : null}
          </div>
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </header>
      <div className="mt-3 space-y-3 sm:mt-4">{children}</div>
    </section>
  );
}

export function ModeSegmented({ value, onChange, ariaLabel, disabled }: {
  value: FirewallMode;
  onChange: (mode: FirewallMode) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn(segmentedControlClassName, "flex gap-1")} role="radiogroup" aria-label={ariaLabel}>
      {(["off", "block", "allow"] as FirewallMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          disabled={disabled}
          onClick={() => onChange(mode)}
          className={segmentedOptionClassName(value === mode, disabled, "h-8 flex-1 px-2 text-[12.5px] sm:text-[13px]")}
        >
          {mode === "off" ? "关闭" : mode === "block" ? "拦截" : "只放行"}
        </button>
      ))}
    </div>
  );
}

export function countryLabel(code: string) {
  const flag = countryFlagEmoji(code);
  return `${flag ? `${flag} ` : ""}${firewallCountryName(code)}`;
}

/** 国家多选：上面是已选的小块（点 × 去掉），下面一个搜索框，聚焦或输入时展开候选列表。 */
export function CountryPicker({ value, onChange, disabled, label = "国家或地区" }: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selected = useMemo(() => new Set(value), [value]);
  const options = useMemo(() => {
    const all = [...FIREWALL_COMMON_COUNTRIES, ...FIREWALL_COUNTRY_CODES.filter((code) => !FIREWALL_COMMON_COUNTRIES.includes(code))];
    const text = query.trim().toLowerCase();
    if (!text) return all;
    return all.filter((code) => code.toLowerCase().startsWith(text) || firewallCountryName(code).toLowerCase().includes(text));
  }, [query]);

  const toggle = (code: string) => {
    if (selected.has(code)) onChange(value.filter((item) => item !== code));
    else onChange([...value, code].sort());
  };

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`已选的${label}`}>
          {value.map((code) => (
            <li key={code}>
              <span className="inline-flex h-7 items-center gap-1 rounded-full border border-[var(--fx-stroke-base)] pl-2.5 pr-1 text-[12.5px]">
                <span>{countryLabel(code)}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(code)}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--fx-hover)] hover:text-foreground"
                  aria-label={`去掉${firewallCountryName(code)}`}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">还没选{label}。</p>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          ref={inputRef}
          value={query}
          disabled={disabled}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (options[0]) { toggle(options[0]); setQuery(""); setOpen(false); }
            }
            if (event.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
          }}
          placeholder="搜索并添加，例如 香港、JP"
          className="pl-8"
          aria-label={`搜索${label}`}
        />
      {/*
        候选列表浮在输入框下面、不占位：原来跟在下面占一块，输入框一失焦就收起，下面的「保存」
        跟着往上跳 —— 手指按下去那一刻按钮正好挪走，点了个空。
      */}
      {open && !disabled ? (
        <ul
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-[var(--fx-stroke-weak)] bg-popover p-1 text-popover-foreground shadow-[var(--fx-elevation-popover)] overscroll-contain"
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
        >
          {options.length === 0 ? (
            <li className="px-2.5 py-2 text-[12.5px] text-muted-foreground">没有匹配的国家或地区</li>
          ) : options.map((code) => {
            const active = selected.has(code);
            return (
              <li key={code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  // 用 mousedown 而不是 click：click 到来之前输入框已经失焦、列表已经收起。
                  onMouseDown={(event) => { event.preventDefault(); toggle(code); }}
                  onClick={(event) => { if (event.detail === 0) toggle(code); }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--fx-hover)]",
                    active && "font-medium",
                  )}
                >
                  <span className="min-w-0 truncate">{countryLabel(code)}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">{code}</span>
                    <Check className={cn("h-3.5 w-3.5 text-primary", !active && "invisible")} aria-hidden="true" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      </div>
    </div>
  );
}

export function describeCountries(countries: string[], max = 3) {
  if (countries.length === 0) return "";
  const shown = countries.slice(0, max).map(countryLabel).join("、");
  return countries.length > max ? `${shown} 等 ${countries.length} 个` : shown;
}

export function formatDateTime(value: unknown) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value as any);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export type CountryDataItem = {
  country: string;
  name: string;
  v4Count: number;
  v6Count: number;
  source: string | null;
  fetchedAt: Date | string | null;
  lastError: string | null;
  downloading: boolean;
};

/** 「国家数据更新于 …」或者「正在下载 …」。 */
export function CountryDataLine({ items, onRetry, retrying }: { items: CountryDataItem[]; onRetry?: () => void; retrying?: boolean }) {
  if (items.length === 0) return null;
  const pending = items.filter((item) => !item.fetchedAt);
  const failed = pending.filter((item) => item.lastError && !item.downloading);
  const empty = items.filter((item) => item.fetchedAt && item.v4Count + item.v6Count === 0);
  if (failed.length > 0) {
    return (
      <p className="text-[12.5px] text-[var(--fx-down-text)]">
        {failed.map((item) => item.name).join("、")}的 IP 段下载失败（{failed[0].lastError}），一小时后自动重试。规则在下载好之前不生效。
        {onRetry ? (
          <button type="button" className="ml-1 underline underline-offset-2" onClick={onRetry} disabled={retrying}>立即重试</button>
        ) : null}
      </p>
    );
  }
  if (pending.length > 0) {
    return (
      <p className="text-[12.5px] text-[var(--fx-warn-text)]">
        正在下载{pending.map((item) => item.name).join("、")}的 IP 段，下载好之前规则不生效。
      </p>
    );
  }
  const oldest = items
    .map((item) => new Date(item.fetchedAt as any).getTime())
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b)[0];
  return (
    <p className="text-[12.5px] text-muted-foreground">
      国家数据更新于 {formatDateTime(new Date(oldest))}，每周自动更新。
      {empty.length > 0 ? `${empty.map((item) => item.name).join("、")}没有 IP 段数据。` : ""}
      {onRetry ? (
        <button type="button" className="ml-1 underline underline-offset-2" onClick={onRetry} disabled={retrying}>立即更新</button>
      ) : null}
    </p>
  );
}
