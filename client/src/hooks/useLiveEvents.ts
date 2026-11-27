import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { panelFetch } from "@/lib/panelFetch";
import { LIVE_RESYNC_TOPICS, liveQueriesForTopics, parseLiveStream, type LiveQueryKey } from "@/lib/liveEvents";

/*
  连着面板的实时通知（GET /api/live，server/liveEvents.ts）：规则、链路、负载均衡、主机一变，马上重取这一页正在看的那几份，
  不用等下一次轮询（用户：「整个系统链路和规则线路调整要实时显示」）。轮询照旧在，连不上时兜底。

  - 用 fetch 读流而不是 EventSource：手机 App 要带登录令牌的请求头，EventSource 带不了。
  - 页面切到后台就断开（不占连接），切回来重连并把「现在」的几份都刷一遍（中间可能错过了）。
  - 100 毫秒内收到的合成一次刷新（面板那边已经按 200 毫秒合过一次）。
*/
const COALESCE_MS = 100;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export function useLiveEvents(enabled: boolean) {
  const utils = trpc.useUtils();
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") return;
    const invalidate: Record<LiveQueryKey, () => unknown> = {
      "rules.trafficSummary": () => utils.rules.trafficSummary.invalidate(),
      "rules.routeStatus": () => utils.rules.routeStatus.invalidate(),
      "rules.*": () => utils.rules.invalidate(),
      "tunnels.listPage": () => utils.tunnels.listPage.invalidate(),
      "tunnels.exitTargets": () => utils.tunnels.exitTargets.invalidate(),
      "tunnels.*": () => utils.tunnels.invalidate(),
      "forwardGroups.*": () => utils.forwardGroups.invalidate(),
      "hosts.*": () => utils.hosts.invalidate(),
    };
    const pending = new Set<string>();
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      const topics = Array.from(pending);
      pending.clear();
      for (const key of liveQueriesForTopics(topics)) void invalidate[key]();
    };
    const queue = (topics: readonly string[]) => {
      for (const topic of topics) pending.add(topic);
      if (flushTimer === null && pending.size > 0) flushTimer = window.setTimeout(flush, COALESCE_MS);
    };

    let controller: AbortController | null = null;
    let retryTimer: number | null = null;
    let retryMs = RETRY_MIN_MS;
    let stopped = false;

    const scheduleRetry = () => {
      if (stopped || document.hidden || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => { retryTimer = null; void connect(); }, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
    const connect = async () => {
      if (stopped || document.hidden || controller) return;
      const current = new AbortController();
      controller = current;
      try {
        const response = await panelFetch("/api/live", { signal: current.signal, headers: { Accept: "text/event-stream" }, cache: "no-store" });
        if (!response.ok || !response.body) throw new Error(`live ${response.status}`);
        retryMs = RETRY_MIN_MS;
        // 连上了：断开的这段时间可能错过了，「现在」的几份刷一遍
        queue(LIVE_RESYNC_TOPICS);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseLiveStream(buffer);
          buffer = parsed.rest.length > 64_000 ? "" : parsed.rest;
          if (parsed.topics.length > 0) queue(parsed.topics);
        }
      } catch {
        // 断了 / 面板重启 / 没登录：退避重连，轮询照常兜着
      } finally {
        if (controller === current) controller = null;
      }
      scheduleRetry();
    };
    const disconnect = () => {
      controller?.abort();
      controller = null;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };
    const onVisibility = () => {
      if (document.hidden) disconnect();
      else {
        retryMs = RETRY_MIN_MS;
        void connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void connect();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      disconnect();
      if (flushTimer !== null) window.clearTimeout(flushTimer);
    };
  }, [enabled, utils]);
}
