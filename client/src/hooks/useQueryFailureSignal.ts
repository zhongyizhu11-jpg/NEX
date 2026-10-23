import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  NO_QUERY_FAILURES,
  isSilentFailureQuery,
  nextDismissedQueryPaths,
  nextQueryFailures,
  queryKeyPath,
  shouldShowQueryFailureBanner,
  undismissedQueryFailures,
  type QueryFailureItem,
} from "@/lib/queryFailureBanner";

/**
 * 「知道了」压下去的查询路径。放在模块级：换页、布局重挂都不丢，刷新页面才清。
 * 路径在它真正读到数据之前都不再提示（见 nextDismissedQueryPaths）。
 */
let dismissedQueryPaths: ReadonlySet<string> = new Set<string>();

/**
 * 这一页现在有几项数据没读到。
 *
 * 只数**页面上真的有人在看**的查询（observers > 0）：缓存里躺着的旧查询失败与否，
 * 跟当前这一页没关系，数进来就会在别的页面弹出莫名其妙的提示。
 *
 * 不数查询自己声明 meta.silentFailure 的：检查更新、公告弹窗、Telegram 状态这类
 * 锦上添花的东西读不到，页面并不残缺，拉横幅只会让人每天盯着一条没法处理的提示。
 *
 * 登录失效那一类不在这里管 —— main.tsx 里已经直接跳登录页了，再提示一遍是多余的。
 */
export function useQueryFailureSignal() {
  const queryClient = useQueryClient();
  const [failures, setFailures] = useState<readonly QueryFailureItem[]>(NO_QUERY_FAILURES);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => dismissedQueryPaths);
  const [failingSinceMs, setFailingSinceMs] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const sinceRef = useRef(0);
  const loggedRef = useRef("");

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const recount = () => {
      const watched = cache.getAll().filter((query) => query.getObserversCount() > 0 && !isSilentFailureQuery(query.meta));
      const failing = watched.filter((query) => query.state.status === "error");
      // 关掉过的路径一旦真正读到数据，就从「关过」里拿掉：下次再失败是新情况，该说。
      const recovered = watched
        .filter((query) => query.state.status === "success")
        .map((query) => queryKeyPath(query.queryKey) || "未知查询");
      const nextDismissed = nextDismissedQueryPaths(dismissedQueryPaths, recovered);
      if (nextDismissed !== dismissedQueryPaths) {
        dismissedQueryPaths = nextDismissed;
        setDismissed(nextDismissed);
      }
      const next = failing.map((query) => ({
        path: queryKeyPath(query.queryKey),
        message: String((query.state.error as { message?: unknown } | null)?.message ?? ""),
      }));
      // 引用不变 React 就不重渲染；每次 set 一个新数组会让布局在每次缓存通知后都重渲染，
      // 渲染又触发缓存通知，几十个来回就撞上更新深度上限（2.3.473 白屏）。
      setFailures((previous) => nextQueryFailures(previous, next));
      const pending = undismissedQueryFailures(next, nextDismissed);
      if (pending.length === 0) {
        sinceRef.current = 0;
        setFailingSinceMs(0);
        return;
      }
      if (sinceRef.current === 0) {
        sinceRef.current = Date.now();
        setFailingSinceMs(sinceRef.current);
      }
      // 控制台也留一份：横幅上截断过的错误信息，这里是全的。同一批只打一次。
      const signature = pending.map((item) => `${item.path}:${item.message}`).join("\n");
      if (signature !== loggedRef.current) {
        loggedRef.current = signature;
        console.warn("[QueryFailure] 这一页有查询没读到：", pending);
      }
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

  const pendingFailures = useMemo(() => undismissedQueryFailures(failures, dismissed), [failures, dismissed]);
  const failureCount = pendingFailures.length;

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
    dismissedAtCount: 0,
    now,
  }), [failureCount, failingSinceMs, now]);

  return {
    visible,
    failureCount,
    failures: pendingFailures,
    dismiss: () => {
      const next = nextDismissedQueryPaths(dismissedQueryPaths, [], pendingFailures.map((item) => item.path || "未知查询"));
      dismissedQueryPaths = next;
      setDismissed(next);
      sinceRef.current = 0;
      setFailingSinceMs(0);
    },
    retry: () => {
      void queryClient.refetchQueries({ type: "active", stale: false });
    },
  };
}
