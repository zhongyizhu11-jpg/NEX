import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
  「新连接怎么分」的选择：线路组的分配方式和出口组的出口策略共用这一个。

  两处以前一个是一排按钮、一个是下拉框，名字也各写各的；现在名字都来自 shared/linkTerms.ts
  的 LINK_SPREAD_LABELS，样子也一样：一排单选按钮，选中的那个下面写一句它会怎么做。
*/

export function linkChoiceClass(active: boolean) {
  return cn(
    "inline-flex h-8 min-w-0 items-center justify-center rounded-[var(--fx-radius-control)] px-2.5 text-xs transition-colors",
    active
      ? "bg-[var(--fx-text)] font-semibold text-[var(--fx-text-inverse)]"
      : "border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] text-muted-foreground hover:text-foreground",
  );
}

export function LinkSpreadPicker<T extends string>({
  value,
  options,
  labels,
  onChange,
  ariaLabel,
  hint,
}: {
  value: T;
  options: readonly T[];
  labels: Record<T, { label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** 选中那一项的说明，放在按钮下面。 */
  hint?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={ariaLabel}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={linkChoiceClass(value === option)}
            onClick={() => onChange(option)}
          >
            {labels[option].label}
          </button>
        ))}
      </div>
      {hint ? <p className="text-meta leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
