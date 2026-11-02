import { useEffect, useReducer, useState, type ReactNode } from "react";

/*
  倒计时只让显示数字的那一小块每秒重画。

  以前 DashboardLayout 自己存一个每秒更新的时间戳（Telegram 绑定码、2FA 二维码、升级公告的按钮），
  整个布局连同侧栏、页头、当前页面每秒重新渲染一遍；Telegram 绑定码甚至在弹窗关掉后还在跳。
  现在布局只在「到点」那一刻刷新一次（useDeadlinePassed），每秒变的数字交给 <Countdown>。
*/

/** 剩余整秒数（向上取整，到点为 0）。deadlineMs 为 0 时当作已经到点。 */
export function secondsLeft(deadlineMs: number, now = Date.now()) {
  return deadlineMs > 0 ? Math.max(0, Math.ceil((deadlineMs - now) / 1000)) : 0;
}

/** 「m:ss」 */
export function formatCountdown(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** 到点了没有。不每秒刷新，只在到点那一刻让调用方重画一次。 */
export function useDeadlinePassed(deadlineMs: number) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!(deadlineMs > 0)) return;
    const wait = deadlineMs - Date.now();
    if (wait <= 0) return;
    const timer = window.setTimeout(rerender, Math.min(wait + 20, MAX_TIMEOUT_MS));
    return () => window.clearTimeout(timer);
  }, [deadlineMs]);
  return secondsLeft(deadlineMs) <= 0;
}

/** 每秒更新剩余秒数；到点后停。只在用它的组件里重画。 */
export function useSecondsLeft(deadlineMs: number) {
  const [left, setLeft] = useState(() => secondsLeft(deadlineMs));
  useEffect(() => {
    setLeft(secondsLeft(deadlineMs));
    if (secondsLeft(deadlineMs) <= 0) return;
    const timer = window.setInterval(() => {
      const next = secondsLeft(deadlineMs);
      setLeft(next);
      if (next <= 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deadlineMs]);
  return left;
}

/** 渲染函数拿到剩余秒数：<Countdown deadlineMs={x}>{(left) => …}</Countdown> */
export function Countdown({ deadlineMs, children }: { deadlineMs: number; children: (secondsLeft: number) => ReactNode }) {
  const left = useSecondsLeft(deadlineMs);
  return <>{children(left)}</>;
}
