import type { ReactNode } from "react";
import { SortableItem, SortableReorderContext, useSortableReorder } from "@/components/SortableDragHandle";

type SortableRenderState = Parameters<Parameters<typeof SortableItem>[0]["children"]>[0];

/**
 * 一列能拖的卡：手机上按住卡片 1 秒拖，鼠标抓卡上的手柄（卡自己决定手柄放哪，没放就只能触屏拖）。
 * 拖完把新顺序交给 onReorder，存不存、怎么存由调用方定。少于两项、或 disabled 时就是普通列表。
 */
export function SortableList<T>({
  items,
  getId,
  onReorder,
  disabled = false,
  strategy = "vertical",
  className,
  children,
}: {
  items: T[];
  getId: (item: T) => number;
  onReorder: (next: T[]) => void;
  disabled?: boolean;
  strategy?: "vertical" | "rect";
  className?: string;
  children: (item: T, state: SortableRenderState | undefined) => ReactNode;
}) {
  const off = disabled || items.length < 2;
  const sortable = useSortableReorder({ items, getId, onReorder, disabled: off });
  if (off) return <div className={className}>{items.map((item) => children(item, undefined))}</div>;
  return (
    <SortableReorderContext sortable={sortable} ids={items.map(getId)} strategy={strategy} restrictToList={strategy === "vertical"}>
      <div className={className}>
        {items.map((item) => (
          <SortableItem key={getId(item)} id={getId(item)} disabled={sortable.disabled}>
            {(state) => children(item, state)}
          </SortableItem>
        ))}
      </div>
    </SortableReorderContext>
  );
}
