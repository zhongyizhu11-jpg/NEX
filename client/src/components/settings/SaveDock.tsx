import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUiTheme } from "@/hooks/useUiTheme";
import { useCompactLayout } from "@/hooks/useCompactLayout";

/*
  设置页的「贴底保存栏」（界面主题「玫瑰」下才出现，2026-10-11 用户要的）。

  参考的是 Rosélune 面板设置页：整个分区一个表单，底下一条贴底的栏，「放弃 / 保存」，
  没改动时两个按钮都是灰的，一改动「保存」才亮。NEX 的设置页是一张卡一个保存按钮，
  所以这里不重写表单，而是让每张卡**登记**自己：叫什么、现在有没有改动、怎么存、怎么撤。
  栏只看登记了的那些：有改动的几项一起存（一项一项按顺序存，前一项失败就停，失败那项
  自己的报错照常弹），「放弃」把有改动的几项都撤回到已保存的值。没有未保存的改动时整条
  栏不画，存完只留一句「改动都已保存」亮一下就收走。

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

/** 这条栏现在画不画：只在玫瑰和朱砂两套主题下（两套的设置页都是编号分节）。卡片据此决定要不要把自己的保存按钮交出去。 */
export function useSaveDockActive() {
  const uiTheme = useUiTheme();
  // 精简布局也走这条栏：二十来张卡各自一个「保存」按钮占一行，收进底下一条（compact.css 藏 data-dock-save）
  const compactLayout = useCompactLayout();
  return compactLayout || uiTheme === "rose" || uiTheme === "cinnabar";
}

/** 存完之后那句「改动都已保存」在屏幕上留多久（毫秒）。 */
export const SAVE_DOCK_SAVED_FLASH_MS = 1200;

/**
 * 这条栏此刻画不画。
 *
 * 它是「还有东西没存」的提醒，不是常驻摆设：没有未保存的改动就收起来（存完那句话
 * 亮一下也走）。以前不管有没有改动都挂在页底，两个灰按钮点哪都不消失。
 */
export function shouldShowSaveDock(input: { active: boolean; dirtyCount: number; busy: boolean; savedFlash: boolean }) {
  if (!input.active) return false;
  return input.dirtyCount > 0 || input.busy || input.savedFlash;
}

export function SaveDockBar() {
  const active = useSaveDockActive();
  const items = useContext(SaveDockItemsContext);
  const registry = useContext(SaveDockContext);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const dirty = useMemo(() => items.filter((item) => item.dirty), [items]);
  const busy = saving || items.some((item) => item.pending);

  // 存完那句话亮一下就收走；中途又改了东西就不用再亮了（栏自己会回来）
  useEffect(() => {
    if (!savedFlash) return;
    const timer = setTimeout(() => setSavedFlash(false), SAVE_DOCK_SAVED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [savedFlash]);
  useEffect(() => {
    if (dirty.length > 0) setSavedFlash(false);
  }, [dirty.length]);

  // 没有未保存的改动就不画（2026-10-12 用户报的：存完之后它还赖在页底，点哪都不走）
  if (!registry || !shouldShowSaveDock({ active, dirtyCount: dirty.length, busy, savedFlash })) return null;

  const summary = dirty.length === 0
    ? "改动都已保存"
    : `${dirty.length} 处改动未保存：${dirty.map((item) => item.label).join("、")}`;

  const handleSave = async () => {
    if (busy || dirty.length === 0) return;
    setSaving(true);
    let saved = true;
    try {
      // 一项存完、页面重渲染之后，后面几项的 save 可能已经换了新的：每次都去登记表里拿最新的那份
      for (const { id } of dirty) {
        const item = registry.get(id);
        if (!item || !item.dirty) continue;
        const ok = await item.save();
        if (ok === false) {
          saved = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      // 先把「存好了」亮起来再松开 saving，免得栏在两次渲染之间先消失一下
      setSavedFlash(saved);
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    for (const { id } of dirty) registry.get(id)?.reset();
    setSavedFlash(false);
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
