import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * 「这个弹窗现在对着谁」。
 *
 * 原来每个弹窗三个 state：showXxx / xxxUserId / xxxUserName，打开时三连 set、关掉时三连清，
 * Users 页里有 12 组。这里收成一个 target：open(t) 打开、close() 关、dialogProps 直接铺到 <Dialog> 上。
 *
 * `shown` 是给关闭动画用的：关的那一下 target 已经是 null，而面板还要再画 130ms ——
 * 用 target 画会先塌成只剩标题再消失，用 shown（上一份）接着画就不会。shown 一直留到下次 open。
 *
 * 要「每次打开都重置表单」的，拿 target 的 id 做 effect 的 key（见 useResetOnOpen）。
 */
export function useDialogTarget<T>() {
  const [target, setTarget] = useState<T | null>(null);
  const lastRef = useRef<T | null>(null);
  if (target !== null) lastRef.current = target;
  const shown = target ?? lastRef.current;

  const open = useCallback((next: T) => setTarget(next), []);
  const close = useCallback(() => setTarget(null), []);
  const isOpen = target !== null;
  const dialogProps = useMemo(() => ({
    open: isOpen,
    onOpenChange: (next: boolean) => { if (!next) setTarget(null); },
  }), [isOpen]);

  return { target, shown, isOpen, open, close, setTarget: setTarget as Dispatch<SetStateAction<T | null>>, dialogProps };
}

export type DialogTarget<T> = ReturnType<typeof useDialogTarget<T>>;

/**
 * 关闭动画期间接着画上一份：调用方已经把 value 清掉了（open 为 false 或 value 为 null），返回上一次打开时的那份。
 * RoutePolicySheet / RouteGroupSheet 原来各自写了一个 last ref，就是这个。
 */
export function useLastShown<T>(open: boolean, value: T | null | undefined): T | null {
  const lastRef = useRef<T | null>(null);
  if (open && value != null) lastRef.current = value;
  return lastRef.current;
}

/**
 * 弹窗每次打开（或换了对象）都跑一遍 reset：effect 以 [open, key] 为键。
 * Users 的权限弹窗踩过「effect 只以 data 为键，第二次打开同一个人 effect 不跑、列表停在空数组」的坑，
 * 所以键里要有 open 和对象的 id，不能只看数据引用。
 */
export function useResetOnOpen(open: boolean, key: unknown, reset: () => void) {
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    if (open) resetRef.current();
  }, [open, key]);
}
