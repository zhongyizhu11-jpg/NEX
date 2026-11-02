import { useRef } from "react";

/**
 * 打开过一次之后一直是 true。
 *
 * 懒加载的弹窗（里面有 recharts 这种大块头）第一次打开时才挂上、才去下载；
 * 之后保持挂着，关闭时照常有收起动画，再打开也不用重新下载。
 */
export function useOpenedOnce(open: boolean) {
  const openedRef = useRef(false);
  if (open) openedRef.current = true;
  return openedRef.current;
}
