import { useEffect, useId, useState, type ReactNode } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown, Minus, Plus, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
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
  BALANCE_TARGET_PROBE_CHOICES,
  DEFAULT_BALANCE_DETECT,
  applyBalanceSensitivity,
  balanceDetectEquals,
  balanceSensitivityOf,
  balanceStrategyHint,
  balanceSwitchWithinSeconds,
  describeBalanceEffect,
  normalizeBalanceStrategy,
  type BalanceDetect,
  type BalanceJitterAction,
  type BalanceStrategy,
} from "@shared/loadBalance";

/*
  统一的负载均衡表单（出口组；线路组只用下拉框）。新建时已经是「自动 · 推荐」+「均衡」，什么都不用改就能用：

    分配方式  一个下拉框：自动（推荐）在最上面，其余 7 种在「其他方式」里；每项一句话，选中的那句写在下面。
    检测      灵敏 / 均衡 / 稳定三档，下面一句「坏了约 N 秒内切走」。逐项参数收在「高级」里，默认合着。
              「多久探一次出口机」和「多久探一次目标」分两项（2.3.541）：后者连的是别人的机器，高防目标会拉黑连得太勤的出口。
              延迟优先多一个开关「只走最快的一台」（BalanceDetect.fastestOnly）：不在一样快的几台里分，只走最快的那台。
              它不算灵敏度：选哪一档都留着它（applyBalanceSensitivity），三档也不因为它变成「自定义」。
*/

export function BalanceStrategySelect({
  value,
  onChange,
  allowed,
  ariaLabel = "分配方式",
  className,
}: {
  value: string | null | undefined;
  onChange: (value: BalanceStrategy) => void;
  /** 只给这几种；不给 = 全部 8 种 */
  allowed?: readonly BalanceStrategy[];
  ariaLabel?: string;
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
      <SelectTrigger aria-label={ariaLabel} className={cn("h-10 text-[15px] font-medium", className)}>
        <SelectValue placeholder="选一种分配方式" />
      </SelectTrigger>
      <SelectContent className="max-w-[min(26rem,calc(100vw-2rem))]">
        {common.length > 0 ? <SelectGroup>{common.map(renderItem)}</SelectGroup> : null}
        {common.length > 0 && custom.length > 0 ? <SelectPrimitive.Separator className="mx-2 my-1 h-px bg-border/70" /> : null}
        {custom.length > 0 ? (
          <SelectGroup>
            {common.length > 0 ? <SelectPrimitive.Label className="px-2 pb-1 pt-1.5 text-meta font-medium text-muted-foreground">其他方式</SelectPrimitive.Label> : null}
            {custom.map(renderItem)}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
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
      <button type="button" className="fx-lb-step-btn flex w-9 items-center justify-center text-muted-foreground hover:bg-muted/60 disabled:opacity-40" aria-label={`${label}减少`} disabled={value <= min} onClick={() => set(value - step)}>
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="flex min-w-[3.5rem] items-center justify-center border-x border-border/70 px-1 text-[13.5px] font-semibold tabular-nums whitespace-nowrap">
        {value} {unit}
      </span>
      <button type="button" className="fx-lb-step-btn flex w-9 items-center justify-center text-muted-foreground hover:bg-muted/60 disabled:opacity-40" aria-label={`${label}增加`} disabled={value >= max} onClick={() => set(value + step)}>
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * 秒数：一排常用的格子 + 下面一个能填任意秒数的框（2.3.541 用户：「自定义要能填任意秒」）。
 * 值正好是某一格时那格亮着；框里一直是当前值。填的时候不打断，离开框（或回车）时空的、不合法的夹回范围。
 */
export function SecondsPicker({ value, onChange, choices, min, max, label }: {
  value: number;
  onChange: (value: number) => void;
  choices: readonly number[];
  min: number;
  max: number;
  label: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const clamp = (raw: string) => {
    const number = Math.round(Number(raw));
    if (!raw.trim() || !Number.isFinite(number)) return value;
    return Math.min(max, Math.max(min, number));
  };
  const commit = () => {
    const next = clamp(draft);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <div className="space-y-1.5">
      <SegmentedControl
        ariaLabel={label}
        value={value}
        options={choices.map((seconds) => ({ value: seconds, label: `${seconds}秒` }))}
        onChange={onChange}
        listClassName="grid grid-flow-col auto-cols-fr gap-1"
        optionClassName="whitespace-nowrap px-0.5"
      />
      <label className="flex items-center gap-2 text-meta text-muted-foreground">
        <span className="shrink-0">自定义</span>
        <Input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          aria-label={`${label}（秒，${min}–${max}）`}
          className="h-8 w-24 tabular-nums"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            const number = Number(event.target.value);
            if (event.target.value.trim() && Number.isInteger(number) && number >= min && number <= max && number !== value) onChange(number);
          }}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }}
        />
        <span className="shrink-0">秒（{min}–{max}）</span>
      </label>
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

/** 「高级」：逐项的检测参数。改过任何一项，上面的三档就显示成「自定义」。 */
export function BalanceAdvanced({ value, onChange, strategy, weights, memberNames }: {
  value: BalanceDetect;
  onChange: (value: BalanceDetect) => void;
  strategy: BalanceStrategy | null;
  weights?: readonly number[];
  memberNames?: readonly string[];
}) {
  const patch = (next: Partial<BalanceDetect>) => onChange({ ...value, ...next });
  const limits = BALANCE_DETECT_LIMITS;
  return (
    <div className="pb-1">
      <div className="-mt-1 mb-1 flex justify-end">
        <button
          type="button"
          className="fx-lb-reset inline-flex items-center gap-1 text-meta font-medium text-primary disabled:text-muted-foreground disabled:opacity-60"
          disabled={balanceDetectEquals(value, DEFAULT_BALANCE_DETECT)}
          onClick={() => onChange({ ...DEFAULT_BALANCE_DETECT })}
        >
          <RotateCcw className="h-3 w-3" />恢复默认
        </button>
      </div>
      <SettingRow title="多久探一次出口机" hint="探自己的出口机，越短切得越快；每次只是连一下" stacked>
        <SecondsPicker
          label="多久探一次出口机"
          value={value.intervalSeconds}
          choices={BALANCE_INTERVAL_CHOICES}
          {...limits.intervalSeconds}
          onChange={(intervalSeconds) => patch({ intervalSeconds })}
        />
      </SettingRow>
      <SettingRow
        title="多久探一次目标"
        hint="出口机连一下规则目标就断。高防目标会把连得太勤的出口 IP 拉黑，别低于 5 秒；有真实流量时直接读内核的往返时间，不另外连"
        stacked
      >
        <SecondsPicker
          label="多久探一次目标"
          value={value.targetProbeSeconds}
          choices={BALANCE_TARGET_PROBE_CHOICES}
          {...limits.targetProbeSeconds}
          onChange={(targetProbeSeconds) => patch({ targetProbeSeconds })}
        />
      </SettingRow>
      <SettingRow title="几次不通算坏" hint={`默认 ${DEFAULT_BALANCE_DETECT.failThreshold} 次`}>
        <Stepper label="几次不通算坏" value={value.failThreshold} onChange={(failThreshold) => patch({ failThreshold })} {...limits.failThreshold} unit="次" />
      </SettingRow>
      <SettingRow title="恢复要连续通几次" hint="防刚好又坏">
        <Stepper label="恢复要连续通几次" value={value.recoverThreshold} onChange={(recoverThreshold) => patch({ recoverThreshold })} {...limits.recoverThreshold} unit="次" />
      </SettingRow>
      {strategy === "latency" ? (
        <>
          <SettingRow title="差多少算一样快" hint={value.fastestOnly ? "另一台要快出这么多（并且快两成）才换过去" : "比最快的慢不到这么多的一起分"}>
            <Stepper label="一样快的门槛" value={value.latencyMarginMs} onChange={(latencyMarginMs) => patch({ latencyMarginMs })} {...limits.latencyMarginMs} unit="ms" />
          </SettingRow>
          <SettingRow title="只走最快的一台" hint="只走整链最快的一台；快出门槛且稳 60 秒才换">
            <Switch aria-label="只走最快的一台" checked={value.fastestOnly} onCheckedChange={(fastestOnly) => patch({ fastestOnly })} />
          </SettingRow>
        </>
      ) : null}
      <SettingRow title="抖动超过多少算抖" hint="抖动这三项只对 NEX 隧道起作用">
        <Stepper label="抖动门槛" value={value.jitterMs} onChange={(jitterMs) => patch({ jitterMs })} {...limits.jitterMs} unit="ms" />
      </SettingRow>
      <SettingRow title="持续多久才处理" hint="偶尔抖一下不动">
        <Stepper label="持续多久才处理" value={value.jitterHoldSeconds} onChange={(jitterHoldSeconds) => patch({ jitterHoldSeconds })} {...limits.jitterHoldSeconds} unit="秒" />
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
        实际效果：{describeBalanceEffect({ strategy, detect: value, weights, memberNames })}
      </p>
    </div>
  );
}

/**
 * 出口组的「分配方式 + 检测」一块。note：分配方式那句后面补的一句（按权重的比例、没填带宽的点名）。
 */
export function LoadBalanceFields({
  strategy,
  onStrategyChange,
  detect,
  onDetectChange,
  note,
  weights,
  memberNames,
}: {
  strategy: BalanceStrategy | null;
  onStrategyChange: (value: BalanceStrategy) => void;
  detect: BalanceDetect;
  onDetectChange: (value: BalanceDetect) => void;
  note?: string | null;
  weights?: readonly number[];
  memberNames?: readonly string[];
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedId = useId();
  const sensitivity = balanceSensitivityOf(detect);
  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-muted/15 p-3" data-testid="load-balance-fields">
      <div className="space-y-1.5">
        <div className="text-[14px] font-semibold leading-5">分配方式</div>
        <BalanceStrategySelect value={strategy} onChange={onStrategyChange} />
        {strategy ? (
          <p className="text-meta leading-5 text-muted-foreground" data-testid="balance-strategy-hint">
            {balanceStrategyHint(strategy, false, detect)}{note ? `；${note}` : ""}
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <div className="text-[14px] font-semibold leading-5">检测灵敏度</div>
        <SegmentedControl<string>
          ariaLabel="检测灵敏度"
          value={sensitivity ?? "custom"}
          options={[
            ...BALANCE_SENSITIVITIES.map((key) => ({ value: key, label: BALANCE_SENSITIVITY_PRESETS[key].label })),
            ...(sensitivity ? [] : [{ value: "custom", label: "自定义" }]),
          ]}
          onChange={(key) => {
            if (key in BALANCE_SENSITIVITY_PRESETS) onDetectChange(applyBalanceSensitivity(detect, key as keyof typeof BALANCE_SENSITIVITY_PRESETS));
          }}
          listClassName="grid grid-flow-col auto-cols-fr gap-1"
        />
        <p className="text-meta leading-5 text-muted-foreground">
          {sensitivity ? BALANCE_SENSITIVITY_PRESETS[sensitivity].hint : "按高级里的设置"}；坏了约 {balanceSwitchWithinSeconds(detect)} 秒内切走
        </p>
        {strategy === "latency" && detect.fastestOnly ? (
          <p className="text-meta leading-5 text-muted-foreground" data-testid="balance-fastest-only">延迟优先：只走最快的一台</p>
        ) : null}
      </div>
      <div className="border-t border-border/50">
        <button
          type="button"
          className="flex min-h-9 w-full items-center justify-between gap-3 pt-2 text-left text-[13.5px] font-medium text-muted-foreground"
          aria-expanded={advancedOpen}
          aria-controls={advancedId}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          高级
          <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", advancedOpen ? "rotate-180" : "-rotate-90")} />
        </button>
        {advancedOpen ? (
          <div id={advancedId}>
            <BalanceAdvanced value={detect} onChange={onDetectChange} strategy={strategy} weights={weights} memberNames={memberNames} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
