/*
  按路由拆出去的页面包，一处登记。

  App.tsx 里的 lazy() 和这里用的是同一个 import() 表达式，所以 Vite 打出来是同一个
  chunk —— 这张表的用处是**提前取**：标签栏和侧栏在空闲时把最常去的几页先拉下来，
  手指点过去时代码已经在缓存里，不用再看一次「正在加载页面」。

  为什么不直接在 App.tsx 里 export 那些 lazy 组件：lazy 组件只在渲染时才触发 import，
  预取要的是「现在就下」，得拿到原始的 import 函数。
*/
export const routeChunks: Record<string, () => Promise<unknown>> = {
  "/hosts": () => import("@/pages/Hosts"),
  "/rules": () => import("@/pages/Rules"),
  "/tunnels": () => import("@/pages/Tunnels"),
  "/more": () => import("@/pages/More"),
  "/client-subscriptions": () => import("@/pages/ClientSubscriptions"),
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

/** 把某一页的代码先拉下来。重复调用拿到的是同一个 promise：在路上就等它，到了就立刻 resolve。 */
export function prefetchRoute(path: string): Promise<unknown> | undefined {
  const loader = routeChunks[path];
  if (!loader) return undefined;
  const existing = pendingChunks.get(path);
  if (existing) return existing;
  const pending = loader().catch(() => {
    // 网络抖一下没取到：忘掉这一次，下次预取重新下；点击时 lazy() 也会自己再试。
    pendingChunks.delete(path);
  });
  pendingChunks.set(path, pending);
  return pending;
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
