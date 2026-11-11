import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUp, Check, Columns3, Lock, RotateCcw } from "lucide-react";

import {
  isDefaultTableColumnPreference,
  moveTableColumn,
  resolveTableColumns,
  setTableColumnVisible,
  setTableColumnWidth,
  clampTableColumnWidth,
  type ResolvedTableColumn,
  type TableColumnDefinition,
  type TableColumnPreference,
  type UiPreferenceTable,
} from "@shared/uiPreferences";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useUiPreferences } from "@/hooks/useUiPreferences";
import { cn } from "@/lib/utils";

/*
  列表视图的「列设置」（上游 2.3.287）：显示哪些列、什么顺序、多宽，按账号存在 users.uiPreferences
  （shared/uiPreferences.ts），换设备也一样。主机列表和转发规则的列表视图在用；卡片视图不受影响。

  · 名称、操作两列必须显示，而且钉在头尾不参与排序（主机表的这两列还是冻结列）。
  · 顺序用「上移 / 下移」按钮（键盘：在那一行上按 Alt + ↑ / ↓），不靠拖拽，读屏和触屏都能用。
  · 列宽在表头右边缘拖；双击那条边恢复这一列的默认宽度；聚焦后左右方向键一次 16px。
  · 存下来的偏好里有现在已经没有的列：直接忽略；以后新加的列按默认位置出现。
*/

export type TableColumnMeta = TableColumnDefinition & { label: string };

export type TableColumnSettings = ReturnType<typeof useTableColumnSettings>;

const KEYBOARD_RESIZE_STEP = 16;

export function useTableColumnSettings(
  table: UiPreferenceTable,
  definitions: readonly TableColumnMeta[],
  /** 账号上还没存过这张表的偏好时用它（比如转发页原来记在本机的「显示分组列」）。 */
  fallback?: TableColumnPreference | null,
) {
  const { preferences, update, saving } = useUiPreferences();
  const saved = preferences.tables?.[table] ?? null;
  const preference = saved ?? fallback ?? null;
  // 拖动中的宽度只放在本地，松手才存一次
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  /*
    列的数组按内容记住：行组件是 memo 的，别每次渲染都给一个新数组（偏好每次都是从 auth.me 新解析出来的）。
    内容没变，签名就没变，拿到的还是上一次那个数组。
  */
  const computed = resolveTableColumns(definitions, preference).map((column) => (
    liveWidths[column.key] !== undefined ? { ...column, width: liveWidths[column.key] } : column
  ));
  const signature = JSON.stringify(computed);
  const columns = useMemo(() => JSON.parse(signature) as ResolvedTableColumn[], [signature]);
  const visibleColumns = useMemo(() => columns.filter((column) => column.visible), [columns]);
  const labels = useMemo(() => new Map(definitions.map((definition) => [definition.key, definition.label])), [definitions]);

  const save = useCallback((next: TableColumnPreference | null) => (
    update({ table: { id: table, columns: next } }, "列设置保存失败")
  ), [table, update]);

  const toggle = useCallback((key: string, visible: boolean) => {
    void save(setTableColumnVisible(definitions, preference, key, visible));
  }, [definitions, preference, save]);
  const move = useCallback((key: string, delta: -1 | 1) => {
    void save(moveTableColumn(definitions, preference, key, delta));
  }, [definitions, preference, save]);
  const resizeLive = useCallback((key: string, width: number) => {
    const definition = definitions.find((item) => item.key === key);
    setLiveWidths((current) => ({ ...current, [key]: clampTableColumnWidth(width, definition?.minWidth, definition?.maxWidth) }));
  }, [definitions]);
  const commitWidth = useCallback((key: string, width: number | null) => {
    // 先存（本地缓存当场就是新值），再撤掉拖动中的临时宽度，不会闪回旧宽度
    void save(setTableColumnWidth(definitions, preference, key, width));
    setLiveWidths((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, [definitions, preference, save]);
  const reset = useCallback(() => {
    setLiveWidths({});
    void save(null);
  }, [save]);

  return {
    columns,
    visibleColumns,
    labels,
    saving,
    isDefault: isDefaultTableColumnPreference(definitions, preference),
    toggle,
    move,
    resizeLive,
    commitWidth,
    reset,
  };
}

/** 列表视图工具栏上的「列设置」按钮 + 菜单。 */
export function TableColumnSettingsMenu({ settings, className }: { settings: TableColumnSettings; className?: string }) {
  const movable = settings.columns.filter((column) => !column.pin);
  const moveButton = (column: ResolvedTableColumn, delta: -1 | 1) => {
    const index = movable.findIndex((item) => item.key === column.key);
    const disabled = column.pin !== null || index < 0 || index + delta < 0 || index + delta >= movable.length;
    const label = settings.labels.get(column.key) ?? column.key;
    return (
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        disabled={disabled}
        aria-label={`${label}${delta < 0 ? "上移" : "下移"}`}
        title={delta < 0 ? "上移" : "下移"}
        // 这两个按钮在菜单项里面：点它们只挪位置，不要顺带切换显示
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          settings.move(column.key, delta);
        }}
      >
        {delta < 0 ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
      </button>
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-8 gap-1.5 px-2.5", className)} aria-label="列设置" title="列设置：显示哪些列、顺序和列宽">
          <Columns3 className="h-4 w-4" />
          <span className="hidden md:inline">列设置</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>显示的列</DropdownMenuLabel>
        {settings.columns.map((column) => {
          const label = settings.labels.get(column.key) ?? column.key;
          return (
            <DropdownMenuItem
              key={column.key}
              disabled={column.required}
              onSelect={(event) => {
                // 菜单不关：一般要连着勾好几列
                event.preventDefault();
                settings.toggle(column.key, !column.visible);
              }}
              onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || column.pin) return;
                event.preventDefault();
                settings.move(column.key, event.key === "ArrowUp" ? -1 : 1);
              }}
              aria-checked={column.visible}
              role="menuitemcheckbox"
            >
              {column.required
                ? <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                : column.visible ? <Check className="h-4 w-4" aria-hidden="true" /> : <span className="h-4 w-4" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {column.pin ? (
                <span className="text-[11px] text-muted-foreground">{column.pin === "start" ? "固定在最前" : "固定在最后"}</span>
              ) : (
                <span className="flex shrink-0 items-center">
                  {moveButton(column, -1)}
                  {moveButton(column, 1)}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[11px] leading-4 text-muted-foreground">拖表头右边缘调列宽，双击边缘恢复这一列。设置跟着账号走。</p>
        <DropdownMenuItem disabled={settings.isDefault} onSelect={() => settings.reset()}>
          <RotateCcw className="h-4 w-4" />
          恢复默认
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 表头右边缘那条拖动条。放在 <th> 里面，<th> 得是定位元素（relative 或 sticky）。
 * 起始宽度量的是这一格现在实际画出来的宽度（table-fixed 下可能被按比例放大过）。
 */
export function TableColumnResizeHandle({ settings, column, label }: { settings: TableColumnSettings; column: ResolvedTableColumn; label: string }) {
  const dragRef = useRef<{ startX: number; startWidth: number; width: number; pointerId: number } | null>(null);
  const measure = (element: HTMLElement) => element.closest("th")?.getBoundingClientRect().width ?? column.width ?? 120;
  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startWidth = measure(event.currentTarget);
    dragRef.current = { startX: event.clientX, startWidth, width: startWidth, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.width = drag.startWidth + event.clientX - drag.startX;
    settings.resizeLive(column.key, drag.width);
  };
  const finish = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (Math.abs(drag.width - drag.startWidth) >= 1) settings.commitWidth(column.key, drag.width);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = column.width ?? measure(event.currentTarget);
    settings.commitWidth(column.key, current + (event.key === "ArrowRight" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP));
  };
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`调整「${label}」列宽`}
      tabIndex={0}
      title="拖动调整列宽，双击恢复默认"
      className="absolute inset-y-1 right-0 z-10 w-2 cursor-col-resize touch-none select-none rounded-sm after:absolute after:inset-y-1 after:right-[3px] after:w-px after:bg-[var(--fx-stroke-weak)] hover:after:bg-primary focus-visible:outline-none focus-visible:after:bg-primary"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        settings.commitWidth(column.key, null);
      }}
      onKeyDown={onKeyDown}
    />
  );
}

/** 表格的最小宽度：可见列的宽度（拖过的按拖的，没拖过的按默认）加起来。 */
export function tableColumnsMinWidth(columns: readonly ResolvedTableColumn[], defaultWidth: (key: string) => number, extra = 0) {
  return Math.round(columns.reduce((sum, column) => sum + (column.width ?? defaultWidth(column.key)), extra));
}
