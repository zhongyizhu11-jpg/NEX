import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUiTheme } from "@/hooks/useUiTheme";

/*
  设置页的「贴底保存栏」（界面主题「玫瑰」下才出现，2026-10-11 用户要的）。

  参考的是 Rosélune 面板设置页：整个分区一个表单，底下一条贴底的栏，「放弃 / 保存」，
  没改动时两个按钮都是灰的，一改动「保存」才亮。NEX 的设置页是一张卡一个保存按钮，
  所以这里不重写表单，而是让每张卡**登记**自己：叫什么、现在有没有改动、怎么存、怎么撤。
  栏只看登记了的那些：有改动的几项一起存（一项一项按顺序存，前一项失败就停，失败那项
  自己的报错照常弹），「放弃」把有改动的几项都撤回到已保存的值。

  玫瑰下登记过的卡把自己那个保存按钮藏起来（按钮上挂 data-dock-save，CSS 在 theme-rose.css）；
  没登记的卡（要确认重启的端口 / SSL、弹窗里改的协议和菜单）保持原样，自己的按钮照常在。
  别的主题下这条栏不画，登记也不影响任何东西。
*/

export type SaveDockItem = {
  id: string;
  label: string;
  dirty: boolean;
  pending?: boolean;
  /** 存这一项。返回 false（或 resolve 成 false）表示没存成：校验没过、请求失败。 */
  save: () => Promise<boolean> | boolean;
  /** 撤回到已保存的值。 */
  reset: () => void;
};

type Registry = {
  set: (item: SaveDockItem) => void;
  remove: (id: string) => void;
  /** 这一项此刻登记着的样子（最新的 save / reset / dirty）。 */
  get: (id: string) => SaveDockItem | undefined;
};

const SaveDockContext = createContext<Registry | null>(null);
const SaveDockItemsContext = createContext<SaveDockItem[]>([]);

export function SaveDockProvider({ children }: { children: ReactNode }) {
  const itemsRef = useRef(new Map<string, SaveDockItem>());
  const [items, setItems] = useState<SaveDockItem[]>([]);

  const publish = useCallback(() => setItems(Array.from(itemsRef.current.values())), []);
  const registry = useMemo<Registry>(() => ({
    set: (item) => {
      const previous = itemsRef.current.get(item.id);
      itemsRef.current.set(item.id, item);
      // save / reset 每次渲染都是新函数，只在栏要显示的东西变了时才重渲染栏
      if (!previous || previous.dirty !== item.dirty || previous.pending !== item.pending || previous.label !== item.label) publish();
    },
    remove: (id) => {
      if (itemsRef.current.delete(id)) publish();
    },
    get: (id) => itemsRef.current.get(id),
  }), [publish]);

  // 栏按 id 去 Map 里拿最新的 save / reset（上面只在显示变化时才刷新 items）
  const live = useMemo(() => items.map((item) => itemsRef.current.get(item.id) || item), [items]);

  return (
    <SaveDockContext.Provider value={registry}>
      <SaveDockItemsContext.Provider value={live}>{children}</SaveDockItemsContext.Provider>
    </SaveDockContext.Provider>
  );
}

/** 卡片登记自己。不在 SaveDockProvider 里时什么也不做。 */
export function useSaveDockItem(item: SaveDockItem) {
  const registry = useContext(SaveDockContext);
  useLayoutEffect(() => {
    registry?.set(item);
  });
  useLayoutEffect(() => {
    if (!registry) return;
    return () => registry.remove(item.id);
  }, [registry, item.id]);
}

/** 这条栏现在画不画：只在玫瑰主题下。卡片据此决定要不要把自己的保存按钮交出去。 */
export function useSaveDockActive() {
  return useUiTheme() === "rose";
}

export function SaveDockBar() {
  const active = useSaveDockActive();
  const items = useContext(SaveDockItemsContext);
  const registry = useContext(SaveDockContext);
  const [saving, setSaving] = useState(false);
  if (!active || !registry || items.length === 0) return null;

  const dirty = items.filter((item) => item.dirty);
  const busy = saving || items.some((item) => item.pending);
  const summary = dirty.length === 0
    ? "改动都已保存"
    : `${dirty.length} 处改动未保存：${dirty.map((item) => item.label).join("、")}`;

  const handleSave = async () => {
    if (busy || dirty.length === 0) return;
    setSaving(true);
    try {
      // 一项存完、页面重渲染之后，后面几项的 save 可能已经换了新的：每次都去登记表里拿最新的那份
      for (const { id } of dirty) {
        const item = registry.get(id);
        if (!item || !item.dirty) continue;
        const ok = await item.save();
        if (ok === false) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    for (const { id } of dirty) registry.get(id)?.reset();
  };

  return (
    <div className="fx-save-dock" data-dirty={dirty.length > 0 ? "" : undefined} role="region" aria-label="保存设置">
      <span className="fx-save-dock-text" aria-live="polite">{summary}</span>
      <span className="fx-save-dock-actions">
        <Button type="button" variant="ghost" onClick={handleDiscard} disabled={busy || dirty.length === 0}>
          放弃
        </Button>
        <Button type="button" onClick={handleSave} disabled={busy || dirty.length === 0}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          保存
        </Button>
      </span>
    </div>
  );
}
