/*
  按路由拆出去的页面包，一处登记。

  App.tsx 里的 lazy() 和这里用的是同一个 import() 表达式，所以 Vite 打出来是同一个
  chunk —— 这张表的用处是**提前取**：标签栏和侧栏在空闲时把最常去的几页先拉下来，
  手指点过去时代码已经在缓存里，不用再看一次「正在加载页面」。

  为什么不直接在 App.tsx 里 export 那些 lazy 组件：lazy 组件只在渲染时才触发 import，
  预取要的是「现在就下」，得拿到原始的 import 函数。
*/
import { createElement, use, type ComponentType } from "react";

/** 路由页面组件：各页 props 不同（Tickets 有 mode），这里不约束。 */
type RouteComponent = ComponentType<Record<string, unknown>>;

export const routeChunks: Record<string, () => Promise<unknown>> = {
  "/hosts": () => import("@/pages/Hosts"),
  "/rules": () => import("@/pages/Rules"),
  "/tunnels": () => import("@/pages/Tunnels"),
  "/more": () => import("@/pages/More"),
  "/client-subscriptions": () => import("@/pages/ClientSubscriptions"),
  "/admin/subscriptions": () => import("@/pages/AdminSubscriptions"),
  "/profile": () => import("@/pages/Profile"),
  "/settings": () => import("@/pages/Settings"),
  "/announcements": () => import("@/pages/Announcements"),
  // 用户的工单和管理员的工单管理是同一个页面组件，同一个包。
  "/tickets": () => import("@/pages/Tickets"),
  "/admin/tickets": () => import("@/pages/Tickets"),
  "/subscriptions": () => import("@/pages/Subscriptions"),
  "/looking-glass": () => import("@/pages/LookingGlass"),
  "/users": () => import("@/pages/Users"),
  "/plans": () => import("@/pages/Plans"),
  "/billing": () => import("@/pages/Billing"),
  "/payments": () => import("@/pages/Payments"),
  "/wallet": () => import("@/pages/Wallet"),
  "/referrals": () => import("@/pages/Referrals"),
  "/store": () => import("@/pages/Store"),
  "/forward-groups": () => import("@/pages/ForwardGroupsRoute"),
  "/proxy-inbounds": () => import("@/pages/ProxyInbounds"),
  "/traffic-billing": () => import("@/pages/TrafficBilling"),
  "/plugins": () => import("@/pages/Plugins"),
  "/insights": () => import("@/pages/Insights"),
  "/topology": () => import("@/pages/Topology"),
};

/*
  每一页记住**同一个** promise，而不是只记「取过了」：手指按下 / 悬停时开始取，
  包还没到用户就点了，navigateAfterPrefetch 要等的是那一次还在路上的下载 ——
  如果这里回一个已经 resolve 的空 promise，它会立刻换页，Suspense 照样先转一圈。
*/
const pendingChunks = new Map<string, Promise<unknown>>();
/** 已经到手的页面组件：lazyRoute 先查这里，查到就同步渲染，连 Suspense 都不经过。 */
const loadedRoutes = new Map<string, RouteComponent>();
/** 上一次下载失败的原因：lazyRoute 渲染时抛给 ErrorBoundary，抛过就清掉，重试会重新下。 */
const routeErrors = new Map<string, unknown>();

/** 把某一页的代码先拉下来。重复调用拿到的是同一个 promise：在路上就等它，到了就立刻 resolve。 */
export function prefetchRoute(path: string): Promise<unknown> | undefined {
  const loader = routeChunks[path];
  if (!loader) return undefined;
  const existing = pendingChunks.get(path);
  if (existing) return existing;
  const pending = loader()
    .then((module) => {
      const component = (module as { default?: unknown } | undefined)?.default;
      if (typeof component === "function" || (component && typeof component === "object")) {
        loadedRoutes.set(path, component as RouteComponent);
      }
      routeErrors.delete(path);
    })
    .catch((error: unknown) => {
      // 网络抖一下没取到：忘掉这一次，下次预取重新下；页面渲染时 lazyRoute 也会自己再试。
      routeErrors.set(path, error);
      pendingChunks.delete(path);
    });
  pendingChunks.set(path, pending);
  return pending;
}

/**
 * 代替 React.lazy 的路由组件。
 *
 * React.lazy 第一次渲染**一定**挂起：哪怕包早就预取到了，它也要先 then 一下、下一个微任务
 * 才知道结果。挂起就要先提交一次 fallback，而 React 对「fallback 刚提交又马上出结果」有 300ms
 * 的节流（避免闪一下）—— 于是第一次点进转发规则，代码明明在缓存里，内容也要等 300ms 才画出来
 * （2026-11-03 用户：「换页面或者刷新时……感觉卡顿，特别是打开转发规则时」）。
 *
 * 这里把下载结果记在模块级：预取到了就同步渲染，不经过 Suspense；真没到才挂起等那一次下载。
 */
export function lazyRoute(path: string): RouteComponent {
  function RouteChunk(props: Record<string, unknown>) {
    const loaded = loadedRoutes.get(path);
    if (loaded) return createElement(loaded, props);
    if (!pendingChunks.has(path)) {
      const error = routeErrors.get(path);
      if (error !== undefined) {
        routeErrors.delete(path);
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
    const pending = prefetchRoute(path);
    if (!pending) throw new Error(`没有登记的页面：${path}`);
    use(pending);
    const loadedNow = loadedRoutes.get(path);
    if (loadedNow) return createElement(loadedNow, props);
    const error = routeErrors.get(path);
    routeErrors.delete(path);
    throw error instanceof Error ? error : new Error(error !== undefined ? String(error) : `页面包里没有组件：${path}`);
  }
  RouteChunk.displayName = `RouteChunk(${path})`;
  return RouteChunk;
}

type NetworkInformationLike = { saveData?: boolean; effectiveType?: string };

/**
 * 省流量模式或慢网（3G 及以下）不做空闲批量预取：那一批加起来四百多 KB（gzip），
 * 在按流量计费的手机上是替用户花钱，慢网上还会跟首屏的数据请求抢带宽。
 * 点击 / 悬停时的单页预取不受影响。
 */
export function shouldSkipIdlePrefetch(connection: NetworkInformationLike | null | undefined) {
  if (!connection) return false;
  if (connection.saveData === true) return true;
  return connection.effectiveType === "slow-2g" || connection.effectiveType === "2g" || connection.effectiveType === "3g";
}

/**
 * 空闲时把一批页面拉下来。用 requestIdleCallback：首屏的数据请求和渲染先走，
 * 页面包排在它们后面 —— 预取是为了让第二屏快，不能让第一屏慢。
 */
export function prefetchRoutesWhenIdle(paths: string[]) {
  if (typeof window === "undefined") return () => undefined;
  if (shouldSkipIdlePrefetch((navigator as any).connection)) return () => undefined;
  const run = () => { for (const path of paths) void prefetchRoute(path); };
  const idle = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout: number }) => number);
  if (idle) {
    const handle = idle(run, { timeout: 4000 });
    return () => (window as any).cancelIdleCallback?.(handle);
  }
  const timer = window.setTimeout(run, 1500);
  return () => window.clearTimeout(timer);
}

/**
 * 点击前先等一小会儿让代码到位，再换页。
 *
 * 换页时的转圈来自 Suspense：路由一变，新页面的代码还没到，就先画 fallback。这里把
 * 顺序倒过来 —— 先取代码，最多等 `maxWaitMs`，到了就换页（代码已缓存时是同步的），
 * 没到也换页（还是原来的 fallback 兜底）。用户看到的是「点了就切过去」，而不是
 * 「点了 → 转圈 → 出来」。
 */
export function navigateAfterPrefetch(path: string, navigate: () => void, maxWaitMs = 250) {
  const pending = prefetchRoute(path);
  if (!pending) { navigate(); return; }
  let done = false;
  const go = () => { if (done) return; done = true; navigate(); };
  const timer = window.setTimeout(go, maxWaitMs);
  void pending.then(() => { window.clearTimeout(timer); go(); });
}
