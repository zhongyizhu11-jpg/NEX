import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { segmentedControlClassName, segmentedOptionClassName } from "./segmented";

/*
  分段选择：一组互斥的选项，读屏读成单选组（role=radiogroup / radio）。

  键盘照单选组的规矩走：Tab 只停在选中的那一格（没有选中就停第一格能点的），
  方向键左右 / 上下在格子之间挪，挪到哪格就选哪格；Home / End 到头尾。禁用的格子跳过。

  长相默认是 segmented.ts 那一套（槽深一档、选中项浅一档）；个别地方长得不一样的
  （比如线路工作台那组小号的），传 getOptionClassName 自己给格子的样子，键盘行为照旧。
*/

export type SegmentedControlOption<T extends string | number> = {
  value: T;
  label: ReactNode;
  /** 格子里文字前面的图标 */
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
  /** 读屏用的名字：label 不是纯文字时给 */
  ariaLabel?: string;
  testId?: string;
};

export type SegmentedControlProps<T extends string | number> = {
  value: T | null | undefined;
  options: ReadonlyArray<SegmentedControlOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** 整组禁用（保存中之类） */
  disabled?: boolean;
  /** 加在外面那条槽上 */
  className?: string;
  /** 给了就在槽里再包一层（比如 "grid grid-cols-3 gap-1"），和原来两层写法长得一样 */
  listClassName?: string;
  /** 加在每一格上（默认样子之上） */
  optionClassName?: string;
  /** 整个换掉格子的样子 */
  getOptionClassName?: (active: boolean, disabled: boolean) => string;
  style?: CSSProperties;
  testId?: string;
};

/**
 * 按了哪个键该挪到第几格：-1 是这个键不管。方向键循环，跳过禁用的；Home / End 到第一格 / 最后一格能点的。
 */
export function segmentedKeyTarget(key: string, index: number, count: number, isDisabled: (index: number) => boolean): number {
  const step = (from: number, delta: 1 | -1) => {
    for (let offset = 1; offset <= count; offset += 1) {
      const next = (((from + delta * offset) % count) + count) % count;
      if (!isDisabled(next)) return next;
    }
    return index;
  };
  if (count <= 0) return -1;
  if (key === "ArrowRight" || key === "ArrowDown") return step(index, 1);
  if (key === "ArrowLeft" || key === "ArrowUp") return step(index, -1);
  if (key === "Home") return step(-1, 1);
  if (key === "End") return step(count, -1);
  return -1;
}

export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
  listClassName,
  optionClassName,
  getOptionClassName,
  style,
  testId,
}: SegmentedControlProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const isDisabled = (index: number) => disabled || !!options[index]?.disabled;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const firstEnabled = options.findIndex((_, index) => !isDisabled(index));
  // Tab 停在选中那格；选中那格被禁用或没有选中，就停第一格能点的
  const tabStop = selectedIndex >= 0 && !isDisabled(selectedIndex) ? selectedIndex : firstEnabled;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = segmentedKeyTarget(event.key, index, options.length, isDisabled);
    if (next < 0) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    const option = options[next];
    if (option && option.value !== value) onChange(option.value);
  };

  const items = options.map((option, index) => {
    const active = option.value === value;
    const optionDisabled = isDisabled(index);
    return (
      <button
        key={String(option.value)}
        ref={(node) => { buttons.current[index] = node; }}
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={option.ariaLabel}
        tabIndex={index === tabStop ? 0 : -1}
        disabled={optionDisabled}
        title={option.title}
        data-testid={option.testId}
        onClick={() => { if (!active) onChange(option.value); }}
        onKeyDown={(event) => onKeyDown(event, index)}
        className={getOptionClassName ? getOptionClassName(active, optionDisabled) : segmentedOptionClassName(active, optionDisabled, optionClassName)}
      >
        {option.icon}
        {option.label}
      </button>
    );
  });

  return (
    <div role="radiogroup" aria-label={ariaLabel} aria-disabled={disabled || undefined} data-testid={testId} className={cn(segmentedControlClassName, className)} style={style}>
      {listClassName ? <div className={listClassName}>{items}</div> : items}
    </div>
  );
}
