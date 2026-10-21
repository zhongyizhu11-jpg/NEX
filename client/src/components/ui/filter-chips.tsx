import { cn } from "@/lib/utils";

export type FilterChipItem<T extends string> = {
  value: T;
  label: string;
  /** 这一类有几个。null / undefined 就不画数字（还没数出来） */
  count?: number | null;
  disabled?: boolean;
};

/**
 * 一排筛选药丸：「全部 16 · 端口转发 6 · 隧道转发 4 …」。
 *
 * 分类是**选择**，不是标签页：换一类只是过滤同一张列表，页面别的地方都不变，所以
 * 不用带轨道的分段控件（那是在几个视图之间切换的意思），而是一排各自独立的药丸，
 * 选中的那一枚走主色渐变 —— 和主按钮、底栏选中项同一道渐变，跟着「默认配色」换。
 *
 * 手机上一行横滑不换行（列表页第一屏寸土寸金），桌面上换行。样式在 workspace.css 的 .fx-chip。
 */
export function FilterChips<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
  wrap,
}: {
  items: readonly FilterChipItem<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
  /** 手机上也换行、不横滑：放在弹窗里时用（横滑的那一截被弹窗边切掉，看不出还有更多） */
  wrap?: boolean;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("fx-chip-scroller min-w-0 items-center", wrap && "fx-chip-wrap", className)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            disabled={item.disabled}
            className={cn("fx-chip", active && "fx-chip-on")}
            onClick={() => onChange(item.value)}
          >
            <span>{item.label}</span>
            {item.count !== undefined && item.count !== null ? <span className="fx-chip-count">{item.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
