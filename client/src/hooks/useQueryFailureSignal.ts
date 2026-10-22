import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { NO_QUERY_FAILURES, nextQueryFailures, queryKeyPath, shouldShowQueryFailureBanner, type QueryFailureItem } from "@/lib/queryFailureBanner";

/**
 * 这一页现在有几项数据没读到。
 *
 * 只数**页面上真的有人在看**的查询（observers > 0）：缓存里躺着的旧查询失败与否，
 * 跟当前这一页没关系，数进来就会在别的页面弹出莫名其妙的提示。
 *
 * 登录失效那一类不在这里管 —— main.tsx 里已经直接跳登录页了，再提示一遍是多余的。
 */
export function useQueryFailureSignal() {
  const queryClient = useQueryClient();
  const [failureCount, setFailureCount] = useState(0);
  const [failures, setFailures] = useState<readonly QueryFailureItem[]>(NO_QUERY_FAILURES);
  const [failingSinceMs, setFailingSinceMs] = useState(0);
  const [dismissedAtCount, setDismissedAtCount] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const sinceRef = useRef(0);

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const recount = () => {
      const failing = cache.getAll().filter((query) => (
        query.state.status === "error" && query.getObserversCount() > 0
      ));
      const count = failing.length;
      if (count <= 0) {
        sinceRef.current = 0;
        setFailingSinceMs(0);
        setFailureCount(0);
        // 引用不变 React 就不重渲染；每次 set 一个新的 [] 会让布局在每次缓存通知后都重渲染，
        // 渲染又触发缓存通知，几十个来回就撞上更新深度上限（2.3.473 白屏）。
        setFailures((previous) => nextQueryFailures(previous, NO_QUERY_FAILURES));
        // 恢复之后把「关过」也清掉：下一次是新的一批失败，该说还得说。
        setDismissedAtCount(0);
        return;
      }
      if (sinceRef.current === 0) {
        sinceRef.current = Date.now();
        setFailingSinceMs(sinceRef.current);
      }
      setFailureCount(count);
      const next = failing.map((query) => ({
        path: queryKeyPath(query.queryKey),
        message: String((query.state.error as { message?: unknown } | null)?.message ?? ""),
      }));
      setFailures((previous) => nextQueryFailures(previous, next));
    };
    recount();
    /*
      挪到微任务里数，不在通知里当场数。

      查询缓存的通知是同步发的：别的组件渲染时第一次挂上一个查询（useQuery 在渲染里
      建观察者、往缓存里加查询），这里就在「别人渲染到一半」时 setState —— 订阅管理页、
      网络测试页一打开，控制台就报「Cannot update a component while rendering a different
      component」。挪到微任务里，渲染那一段同步代码跑完才数；同一轮里的几十个通知也只
      数一次（原来打开一页，这里要把整个缓存来回数几十遍）。
    */
    let scheduled = false;
    let active = true;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (active) recount();
      });
    };
    const unsubscribe = cache.subscribe(schedule);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [queryClient]);

  // 失败要「持续一段时间」才提示，所以得有个心跳把时间推过那道门槛。
  useEffect(() => {
    if (failureCount <= 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    setNow(Date.now());
    return () => window.clearInterval(timer);
  }, [failureCount]);

  const visible = useMemo(() => shouldShowQueryFailureBanner({
    failureCount,
    failingSinceMs,
    dismissedAtCount,
    now,
  }), [failureCount, failingSinceMs, dismissedAtCount, now]);

  return {
    visible,
    failureCount,
    failures,
    dismiss: () => setDismissedAtCount(failureCount),
    retry: () => {
      void queryClient.refetchQueries({ type: "active", stale: false });
    },
  };
}
