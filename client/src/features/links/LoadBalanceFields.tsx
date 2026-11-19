import { useId, useState, type ReactNode } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown, Minus, Plus, RotateCcw } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  BALANCE_COMMON_STRATEGIES,
  BALANCE_CUSTOM_STRATEGIES,
  BALANCE_DETECT_LIMITS,
  BALANCE_INTERVAL_CHOICES,
  BALANCE_JITTER_ACTION_LABELS,
  BALANCE_JITTER_ACTIONS,
  BALANCE_SENSITIVITIES,
  BALANCE_SENSITIVITY_PRESETS,
  BALANCE_STRATEGY_LABELS,
  DEFAULT_BALANCE_DETECT,
  balanceDetectEquals,
  balanceSensitivityOf,
  balanceSwitchWithinSeconds,
  describeBalanceDetectShort,
  describeBalanceEffect,
  normalizeBalanceStrategy,
  type BalanceDetect,
  type BalanceJitterAction,
  type BalanceStrategy,
} from "@shared/loadBalance";

/*
  统一的负载均衡表单（2026-11 用户定的样子，效果图 ①～④）：

    分配方式   一个下拉框。常用 3 个（自动 · 推荐 / 主备 / 按访客固定）+ 分隔线 + 自定义 5 个；每项下面一行灰字说明，
               合上的框里只放名字。下面一行绿点说明现在怎么分、坏了多久切走。
    检测与切换  默认收起，只写一行当前设置；点开原地展开：多久探一次、几次不通算坏、恢复要通几次、延迟门槛、
               抖动门槛、持续多久、抖动时怎么办、刚恢复慢慢加量，最下面一句「实际效果」，右上角「恢复默认」。

  链路负载均衡、出口组、线路组线路里的几个落地都用这一套。新建时不预选，让人自己挑（用户要求）。
*/

export function BalanceStrategySelect({
  value,
  onChange,
  allowed,
  ariaLabel = "分配方式",
  placeholder = "请选择分配方式",
  className,
}: {
  value: string | null | undefined;
  onChange: (value: BalanceStrategy) => void;
  /** 只给这几种（转发组只有主备之类）；不给 = 全部 8 种 */
  allowed?: readonly BalanceStrategy[];
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}) {
  const selected = normalizeBalanceStrategy(value);
  const keep = (list: readonly BalanceStrategy[]) => (allowed ? list.filter((item) => allowed.includes(item)) : [...list]);
  const common = keep(BALANCE_COMMON_STRATEGIES);
  const custom = keep(BALANCE_CUSTOM_STRATEGIES);
  const renderItem = (strategy: BalanceStrategy) => (
    <SelectItem key={strategy} value={strategy} className="py-2">
      <span className="fx-select-two flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5 font-medium">
          {BALANCE_STRATEGY_LABELS[strategy].label}
          {strategy === "auto" ? <span className="fx-lb-badge">推荐</span> : null}
        </span>
        <span className="fx-select-sub text-meta leading-5 text-muted-foreground">{BALANCE_STRATEGY_LABELS[strategy].hint}</span>
      </span>
    </SelectItem>
  );
  return (
    <Select value={selected ?? undefined} onValueChange={(next) => { const strategy = normalizeBalanceStrategy(next); if (strategy) onChange(strategy); }}>
      <SelectTrigger aria-label={ariaLabel} className={cn("h-11 text-[15px] font-medium", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-w-[min(26rem,calc(100vw-2rem))]">
        {common.length > 0 ? (
          <SelectGroup>
            {custom.length > 0 ? <SelectPrimitive.Label className="px-2 pb-1 pt-1.5 text-meta font-medium text-muted-foreground">综合</SelectPrimitive.Label> : null}
            {common.map(renderItem)}
          </SelectGroup>
        ) : null}
        {common.length > 0 && custom.length > 0 ? <SelectPrimitive.Separator className="mx-2 my-1 h-px bg-border/70" /> : null}
        {custom.length > 0 ? (
          <SelectGroup>
            <SelectPrimitive.Label className="px-2 pb-1 pt-1.5 text-meta font-medium text-muted-foreground">其他方式</SelectPrimitive.Label>
            {custom.map(renderItem)}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}

/** 下拉框下面那一行：绿点 + 现在怎么分 + 坏了多久切走。 */
export function BalanceSummaryLine({ strategy, detect, extra, dns = false }: {
  strategy: string | null | undefined;
  detect: BalanceDetect;
  extra?: ReactNode;
  dns?: boolean;
}) {
  const selected = normalizeBalanceStrategy(strategy);
  if (!selected) {
    return <p className="text-meta leading-5 text-muted-foreground">选一种分配方式：不知道选哪个就用「自动」。</p>;
  }
  return (
    <p className="flex gap-2 text-meta leading-5 text-muted-foreground">
      <span aria-hidden className="mt-[7px] h-2 w-2 shrink-0 rounded-full bg-[var(--fx-ok,#22a55a)]" />
      <span className="min-w-0">
        {BALANCE_STRATEGY_LABELS[selected].hint}；坏了约 {balanceSwitchWithinSeconds(detect)} 秒内{dns ? "改解析" : "切走"}
        {extra ? <>；{extra}</> : null}
      </span>
    </p>
  );
}

function Stepper({ value, onChange, min, max, step = 1, unit, label }: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit: string;
  label: string;
}) {
  const set = (next: number) => onChange(Math.min(max, Math.max(min, Math.round(next / step) * step)));
  return (
    <div className="fx-lb-step inline-flex shrink-0 items-stretch overflow-hidden rounded-[10px] border border-border/80 bg-background" role="group" aria-label={label}>
      <button type="button" className="fx-lb-step-btn flex w-8 items-center justify-center text-muted-foreground hover:bg-muted/60 disabled:opacity-40" aria-label={`${label}减少`} disabled={value <= min} onClick={() => set(value - step)}>
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="flex min-w-[3.25rem] items-center justify-center border-x border-border/70 px-1 text-[13.5px] font-semibold tabular-nums">
        {value}{unit}
      </span>
      <button type="button" className="fx-lb-step-btn flex w-8 items-center justify-center text-muted-foreground hover:bg-muted/60 disabled:opacity-40" aria-label={`${label}增加`} disabled={value >= max} onClick={() => set(value + step)}>
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SettingRow({ title, hint, children, stacked = false }: { title: string; hint?: string; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={cn("border-t border-border/50 py-2.5 first:border-t-0", stacked ? "space-y-2" : "flex items-center justify-between gap-3")}>
      <div className="min-w-0">
        <div className="text-[14px] font-medium leading-5">{title}</div>
        {hint ? <div className="text-meta leading-5 text-muted-foreground">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * 「检测与切换」：默认收起，只写一行当前设置；点开原地展开。
 * dns：转发组 / 入口组（改解析）—— 只影响「实际效果」那句话和要不要给灵敏度三档。
 * 链路 / 出口组：先选一档检测灵敏度（灵敏 / 均衡 / 稳定，默认均衡），逐项的参数收在下面的「高级」里。
 */
export function BalanceDetectPanel({
  value,
  onChange,
  strategy,
  defaults = DEFAULT_BALANCE_DETECT,
  weights,
  memberNames,
  dns = false,
  defaultOpen = false,
}: {
  value: BalanceDetect;
  onChange: (value: BalanceDetect) => void;
  strategy?: string | null;
  defaults?: BalanceDetect;
  weights?: readonly number[];
  memberNames?: readonly string[];
  dns?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const patch = (next: Partial<BalanceDetect>) => onChange({ ...value, ...next });
  const isDefault = balanceDetectEquals(value, defaults);
  const intervalChoices = Array.from(new Set<number>([...BALANCE_INTERVAL_CHOICES, defaults.intervalSeconds])).sort((a, b) => a - b);
  // 灵敏度三档（2.3.539）：大多数人选一档就够；转发组 / 入口组靠改解析，默认值不一样，不给三档
  const sensitivity = dns ? null : balanceSensitivityOf(value);
  return (
    <div className="rounded-xl border border-border/60 bg-background/60">
      {!dns ? (
        <div className="space-y-1.5 px-3 pt-2.5">
          <div className="text-[14.5px] font-semibold leading-5">检测灵敏度</div>
          <SegmentedControl<string>
            ariaLabel="检测灵敏度"
            value={sensitivity ?? "custom"}
            options={[
              ...BALANCE_SENSITIVITIES.map((key) => ({ value: key, label: BALANCE_SENSITIVITY_PRESETS[key].label })),
              ...(sensitivity ? [] : [{ value: "custom", label: "自定义" }]),
            ]}
            onChange={(key) => {
              const preset = BALANCE_SENSITIVITY_PRESETS[key as keyof typeof BALANCE_SENSITIVITY_PRESETS];
              if (preset) onChange({ ...preset.detect });
            }}
            listClassName="grid grid-flow-col auto-cols-fr gap-1"
          />
          <p className="text-meta leading-5 text-muted-foreground">
            {sensitivity ? `${BALANCE_SENSITIVITY_PRESETS[sensitivity].hint}；` : "已按下面的高级设置；"}坏了约 {balanceSwitchWithinSeconds(value)} 秒内切走
          </p>
        </div>
      ) : null}
      <button
        type="button"
        className="fx-lb-detect-toggle flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0">
          <span className={cn("block leading-5", dns ? "text-[14.5px] font-semibold" : "text-[13.5px] font-medium text-muted-foreground")}>{dns ? "检测与切换" : "高级"}</span>
          {!open && dns ? <span className="block truncate text-meta leading-5 text-muted-foreground">{describeBalanceDetectShort(value)}</span> : null}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open ? "rotate-180" : "-rotate-90")} />
      </button>
      {open ? (
        <div id={bodyId} className="px-3 pb-3">
          <div className="-mt-1 mb-1 flex justify-end">
            <button
              type="button"
              className="fx-lb-reset inline-flex items-center gap-1 text-meta font-medium text-primary disabled:text-muted-foreground disabled:opacity-60"
              disabled={isDefault}
              onClick={() => onChange({ ...defaults })}
            >
              <RotateCcw className="h-3 w-3" />恢复默认
            </button>
          </div>
          <SettingRow title="多久探一次" hint="越短切得越快；每次只是连一下，流量很小" stacked>
            <SegmentedControl
              ariaLabel="多久探一次"
              value={value.intervalSeconds}
              options={intervalChoices.map((seconds) => ({ value: seconds, label: `${seconds} 秒` }))}
              onChange={(intervalSeconds) => patch({ intervalSeconds })}
              listClassName="grid grid-flow-col auto-cols-fr gap-1"
              optionClassName="whitespace-nowrap px-1"
            />
          </SettingRow>
          <SettingRow title="几次不通算坏" hint={`默认 ${defaults.failThreshold} 次`}>
            <Stepper label="几次不通算坏" value={value.failThreshold} onChange={(failThreshold) => patch({ failThreshold })} min={BALANCE_DETECT_LIMITS.failThreshold.min} max={BALANCE_DETECT_LIMITS.failThreshold.max} unit=" 次" />
          </SettingRow>
          <SettingRow title="恢复要连续通几次" hint="防刚好又坏">
            <Stepper label="恢复要连续通几次" value={value.recoverThreshold} onChange={(recoverThreshold) => patch({ recoverThreshold })} min={BALANCE_DETECT_LIMITS.recoverThreshold.min} max={BALANCE_DETECT_LIMITS.recoverThreshold.max} unit=" 次" />
          </SettingRow>
          <SettingRow title="延迟优先：差多少算一样快" hint="只对延迟优先起作用">
            <Stepper label="一样快的门槛" value={value.latencyMarginMs} onChange={(latencyMarginMs) => patch({ latencyMarginMs })} min={BALANCE_DETECT_LIMITS.latencyMarginMs.min} max={BALANCE_DETECT_LIMITS.latencyMarginMs.max} step={BALANCE_DETECT_LIMITS.latencyMarginMs.step} unit="ms" />
          </SettingRow>
          <SettingRow title="抖动超过多少算抖" hint="延迟上下浮动的幅度；这三项只对 NEX 隧道起作用">
            <Stepper label="抖动门槛" value={value.jitterMs} onChange={(jitterMs) => patch({ jitterMs })} min={BALANCE_DETECT_LIMITS.jitterMs.min} max={BALANCE_DETECT_LIMITS.jitterMs.max} step={BALANCE_DETECT_LIMITS.jitterMs.step} unit="ms" />
          </SettingRow>
          <SettingRow title="持续多久才处理" hint="偶尔抖一下不动">
            <Stepper label="持续多久才处理" value={value.jitterHoldSeconds} onChange={(jitterHoldSeconds) => patch({ jitterHoldSeconds })} min={BALANCE_DETECT_LIMITS.jitterHoldSeconds.min} max={BALANCE_DETECT_LIMITS.jitterHoldSeconds.max} step={BALANCE_DETECT_LIMITS.jitterHoldSeconds.step} unit=" 秒" />
          </SettingRow>
          <SettingRow title="抖动大的时候" stacked>
            <SegmentedControl<BalanceJitterAction>
              ariaLabel="抖动大的时候"
              value={value.jitterAction}
              options={BALANCE_JITTER_ACTIONS.map((action) => ({ value: action, label: BALANCE_JITTER_ACTION_LABELS[action] }))}
              onChange={(jitterAction) => patch({ jitterAction })}
              listClassName="grid grid-cols-3 gap-1"
            />
          </SettingRow>
          <SettingRow title="刚恢复的慢慢加量" hint="1 分钟内从一小份加到满份">
            <Switch aria-label="刚恢复的慢慢加量" checked={value.slowStart} onCheckedChange={(slowStart) => patch({ slowStart })} />
          </SettingRow>
          <p className="mt-2 rounded-xl border border-primary/15 bg-primary/5 px-3 py-2 text-meta leading-5 text-foreground/80">
            实际效果：{describeBalanceEffect({ strategy, detect: value, weights, memberNames, dns })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
