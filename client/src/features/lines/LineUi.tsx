import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";

import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";

/*
  线路这几屏（线路详情、编辑线路组、节点维护、线路工作台、节点池）共用的小零件，尺寸照效果图
  （2.3.496 的 mock.html / mock2.html）：卡片 16px 圆角、14px 内边距；胶囊 11.5px；chip 11.5px、
  内边距 3×9（2.3.498 起，约 23px 高，和 24px 的小图标钮、22px 的胶囊齐平）；行 12px 圆角、9×10 内边距
  （2.3.499 起，约 43px 高，行里的胶囊和暂停钮不再贴着边框）；
  小图标钮 24×24、8px 圆角。颜色全走主题令牌：
  强调色跟着「默认配色」换（薰衣草就是效果图那个紫），状态色是全站那一套。
*/

/** 效果图里浅灰的那种底（胶囊「待命」、徽章「备 1」、分段控件的槽）：字色兑一点进卡片色，跟着深浅主题走。 */
export const LINE_GRAY_BG = "bg-[color-mix(in_oklab,var(--fx-text)_7%,var(--fx-l1-surface))]";

export function LineTitle({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 px-1">
      <div className="min-w-0">
        <h2 className="truncate text-[19px] font-bold leading-tight">{title}</h2>
        {sub ? <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{sub}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export const LineCard = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function LineCard({ className, ...props }, ref) {
  return <div ref={ref} className={cn("min-w-0 rounded-[16px] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] p-[14px]", className)} {...props} />;
});

/** 分节标题：左边写这节是什么，右边一句说明（「拖动排序」「近 7 天」）。 */
export function LineSec({ left, right, className }: { left: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-1 mb-[7px] mt-[14px] flex min-w-0 items-center justify-between gap-3 text-[12.5px] text-muted-foreground first:mt-0", className)}>
      <span className="min-w-0 truncate">{left}</span>
      {right ? <span className="shrink-0">{right}</span> : null}
    </div>
  );
}

export type LineTone = "ok" | "warn" | "down" | "acc" | "gray";

const PILL_TONE: Record<LineTone, string> = {
  ok: "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]",
  warn: "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]",
  down: "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]",
  acc: "bg-[var(--fx-accent-soft)] text-[var(--fx-accent)]",
  gray: cn(LINE_GRAY_BG, "text-muted-foreground"),
};

export const LINE_TONE_TEXT: Record<LineTone, string> = {
  ok: "text-[var(--fx-healthy-text)]",
  warn: "text-[var(--fx-warn-text)]",
  down: "text-[var(--fx-down-text)]",
  acc: "text-[var(--fx-accent)]",
  gray: "text-muted-foreground",
};

export function LineDot({ tone, className }: { tone?: LineTone; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-current", tone ? LINE_TONE_TEXT[tone] : null, className)} />;
}

export function LinePill({ tone = "gray", dot = false, className, title, children, testId }: { tone?: LineTone; dot?: boolean; className?: string; title?: string; children: ReactNode; testId?: string }) {
  return (
    <span title={title} data-testid={testId} className={cn("inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full px-[9px] py-[3px] text-[11.5px] font-semibold leading-[1.35]", PILL_TONE[tone], className)}>
      {dot ? <LineDot /> : null}
      {children}
    </span>
  );
}

/** 「主」「备 1」那种小方块。 */
export function LineBadge({ main = false, children }: { main?: boolean; children: ReactNode }) {
  return (
    <span className={cn("shrink-0 whitespace-nowrap rounded-inner px-[7px] py-[2px] text-[11px] font-bold leading-[1.35]", main ? "bg-[var(--fx-accent)] text-on-accent" : cn(LINE_GRAY_BG, "text-muted-foreground"))}>
      {children}
    </span>
  );
}

export type LineChipVariant = "default" | "sel" | "add";

export function lineChipClass(variant: LineChipVariant = "default", className?: string) {
  return cn(
    "inline-flex max-w-full items-center gap-[5px] whitespace-nowrap rounded-full border px-[9px] py-[3px] text-[11.5px] leading-[1.3]",
    variant === "sel"
      ? "border-[var(--fx-accent)] bg-[var(--fx-accent-soft)] font-semibold text-[var(--fx-accent)]"
      : variant === "add"
        ? "border-dashed border-[var(--fx-stroke)] bg-[var(--fx-l1-surface)] text-muted-foreground"
        : "border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] text-foreground",
    className,
  );
}

export function LineChip({ variant = "default", className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { variant?: LineChipVariant }) {
  return <span className={lineChipClass(variant, className)} {...props}>{children}</span>;
}

export const LineChipButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: LineChipVariant }>(
  function LineChipButton({ variant = "default", className, type = "button", ...props }, ref) {
    return <button ref={ref} type={type} className={lineChipClass(variant, cn("disabled:cursor-not-allowed disabled:opacity-50", className))} {...props} />;
  },
);

/** chip 里那个绿色的毫秒数；null = 测了不通（红 ×），undefined = 没测（不画）。 */
export function LineMs({ value }: { value: number | null | undefined }) {
  if (value === undefined) return null;
  return (
    <span className={cn("font-mono text-[10.5px] font-semibold", value === null ? "text-[var(--fx-down-text)]" : "text-[var(--fx-healthy-text)]")}>
      {value === null ? "×" : formatLineMs(value)}
    </span>
  );
}

/** 毫秒：10 以下留一位小数（0.8 / 1.0 / 2.3），往上取整。 */
export function formatLineMs(value: number) {
  return value < 10 ? (Math.round(value * 10) / 10).toFixed(1) : String(Math.round(value));
}

export const LineIconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function LineIconButton({ className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "fx-compact-touch inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
});

/** 效果图里的两个小图标（13px）：暂停、闪电。 */
export function LinePauseGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={cn("h-[13px] w-[13px]", className)}>
      <rect x="4" y="3" width="3" height="10" rx="1" />
      <rect x="9" y="3" width="3" height="10" rx="1" />
    </svg>
  );
}

export function LinePlayGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={cn("h-[13px] w-[13px]", className)}>
      <path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" />
    </svg>
  );
}

export function LineZapGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={cn("h-[13px] w-[13px]", className)}>
      <path d="M9 1 3 9h4l-1 6 6-8H8l1-6z" />
    </svg>
  );
}

/** 一行：线路、DNS 记录。on = 在用（强调色描边 + 一圈淡光），bad = 坏了（划掉、变灰）。 */
export function LineRow({ on = false, bad = false, className, children, ...props }: HTMLAttributes<HTMLDivElement> & { on?: boolean; bad?: boolean }) {
  return (
    <div
      data-state={on ? "on" : bad ? "bad" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-[12px] border bg-[var(--fx-l1-surface)] px-[10px] py-[9px] text-[13px]",
        on ? "border-[var(--fx-accent)] shadow-[0_0_0_2px_var(--fx-accent-soft)]" : "border-[var(--fx-stroke-weak)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** 行里的路径文字：灰、12px、一行放不下就省略；坏了划掉。 */
export function LinePath({ bad = false, className, children, title }: { bad?: boolean; className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("min-w-0 flex-1 truncate text-[12px]", bad ? "text-muted-foreground/70 line-through" : "text-muted-foreground", className)}>
      {children}
    </span>
  );
}

/** 大数字：等宽、粗、-1px 字距，单位小一号。 */
export function LineBig({ value, unit, tone = "acc", size = 34, className }: { value: ReactNode; unit?: ReactNode; tone?: LineTone | "text"; size?: number; className?: string }) {
  return (
    <div
      className={cn("font-mono font-bold leading-none tracking-[-1px]", tone === "text" ? "text-foreground" : LINE_TONE_TEXT[tone], className)}
      style={{ fontSize: size }}
    >
      {value}
      {unit ? <small className="ml-[2px] text-[13px] font-medium tracking-normal" style={size < 30 ? { fontSize: Math.max(11, Math.round(size * 0.5)) } : undefined}>{unit}</small> : null}
    </div>
  );
}

/** 键值行（维护卡里的「广港hkt　备 2 → 已避开」、工作台的告警行）。 */
export function LineKv({ left, right, onClick, active = false }: { left: ReactNode; right: ReactNode; onClick?: () => void; active?: boolean }) {
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 truncate text-foreground">{left}</span>
      <span className="shrink-0 text-muted-foreground">{right}</span>
    </>
  );
  const className = "flex w-full min-w-0 items-center justify-between gap-3 border-b border-[var(--fx-stroke-weak)] py-2 text-left text-[13px] last:border-b-0";
  // 选中的那行不加粗（效果图没有）：下面的小标题已经写了看的是哪条
  return onClick ? (
    <button type="button" className={cn(className, "hover:bg-[var(--fx-hover)]")} aria-pressed={active} onClick={onClick}>{content}</button>
  ) : (
    <div className={className}>{content}</div>
  );
}

/** 四格的分段控件（「怎么切」）。 */
export function LineSegmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  // 键盘（方向键切换、Tab 只停选中那格）交给共用的分段选择，这里只给小号的样子
  return (
    <SegmentedControl
      ariaLabel={ariaLabel}
      value={value}
      options={options}
      onChange={onChange}
      className={cn("grid gap-[3px] rounded-[10px] p-[3px] text-center text-[11.5px]", LINE_GRAY_BG)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      getOptionClassName={(on) => cn("rounded-[8px] py-[6px] focus-visible:outline-none focus-visible:shadow-[var(--fx-focus-ring)]", on ? "bg-[var(--fx-l1-surface)] font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted-foreground hover:text-foreground")}
    />
  );
}

/** 卡里那句灰色说明（11.5px，上边 8px）。 */
export function LineHint({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn("mt-2 text-[11.5px] leading-[1.5] text-muted-foreground", className)}>{children}</p>;
}

/** 落地名：手机上只写「落地」（地址、域名太长），sm 以上写全；title 里总有全名。 */
export function LineLandingName({ name, className }: { name: string; className?: string }) {
  const full = String(name || "").trim() || "落地";
  return (
    <span className={className} title={full}>
      <span className="sm:hidden">落地</span>
      <span className="hidden sm:inline">{full}</span>
    </span>
  );
}

/*
  弹窗里的表单（节点池弹窗，2.3.501），照 iOS 设置那种分组列表排：
    一节一个灰色小标题（右边可以放一个小按钮），下面一张白卡，卡底下可以跟一句灰字；
    卡里一行一项，名字在左、值在右，行间一根从文字起的细线（LINE_FORM_ROW；不用 .fx-list-row：精简布局给它
    钉了 8×12 的内边距，行就比小标题多缩进 12px）；
    卡里的输入框、选择框不带框，值直接写在右边，点一下就能改。
  上一版是「标签压在框上 + 框里套框 + 每个控件下面一句说明」，一屏七八个框、七八句灰字。
*/
export function LineField({ label, aside, footer, children, className, testId }: {
  label?: ReactNode;
  aside?: ReactNode;
  /** 卡底下那句灰字。 */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-[7px]", className)} data-testid={testId}>
      {label || aside ? (
        <div className="flex min-h-[22px] min-w-0 items-center justify-between gap-3 px-[14px] text-[12px] leading-[1.3] text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1 truncate">{label}</span>
          {aside ? <span className="flex shrink-0 items-center gap-1.5">{aside}</span> : null}
        </div>
      ) : null}
      {children}
      {footer ? <div className="px-[14px] text-[11.5px] leading-[1.55] text-muted-foreground">{footer}</div> : null}
    </section>
  );
}

/** 分组列表的白卡：左边留 14px，行间细线从文字起、一直画到右边（iOS 那样）。 */
export function LineFormGroup({ className, children, testId }: { className?: string; children: ReactNode; testId?: string }) {
  return <div className={cn("min-w-0 overflow-hidden rounded-[14px] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] pl-[14px]", className)} data-testid={testId}>{children}</div>;
}

/** 分组列表里行与行之间那根线：除了第一行，每行上边一根。 */
export const LINE_FORM_ROW = "border-t border-[var(--fx-stroke-weak)] first:border-t-0";

/** 分组列表里的一行：名字在左，值或控件靠右。 */
export function LineFormRow({ label, className, children, testId }: { label: ReactNode; className?: string; children?: ReactNode; testId?: string }) {
  return (
    <div className={cn(LINE_FORM_ROW, "flex min-h-[46px] min-w-0 items-center justify-between gap-4 py-[5px] pr-[14px]", className)} data-testid={testId}>
      <span className="shrink-0 text-[14px] leading-[1.35] text-foreground">{label}</span>
      {children ? <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{children}</div> : null}
    </div>
  );
}

/**
 * 卡里不带框的输入框：值靠右写（一整行只有它时靠左）。用自己的 data-slot：主题给 [data-slot="input"] 加的
 * 圆角、底色、内阴影不落到它身上。
 */
export const LineBareInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { align?: "left" | "right" }>(
  function LineBareInput({ className, align = "right", type = "text", ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="line-bare-input"
        className={cn(
          // 没有框，聚焦时也得看得见焦点在哪：和别的输入框一样，一道强调色细边加一圈淡光
          "h-9 w-full min-w-0 rounded-inner border-0 bg-transparent p-0 text-[14px] text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus-visible:shadow-[0_0_0_1px_var(--fx-path),var(--fx-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60",
          align === "right" ? "text-right" : "text-left",
          className,
        )}
        {...props}
      />
    );
  },
);

/** 卡里不带框的选择框（给 SelectTrigger 用，配 data-slot="line-bare-select"）：只剩值和一个小箭头。 */
export const LINE_BARE_SELECT = "h-9 w-auto max-w-full justify-end gap-1 rounded-none border-0 bg-transparent px-0 py-0 text-[14px] text-foreground shadow-none focus:outline-none [&>span]:truncate";
