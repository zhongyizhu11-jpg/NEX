import { resolveSiteTitle } from "@shared/brand";
import { trpc } from "@/lib/trpc";
import { ACCOUNT_DISABLED_ERR_MSG, SESSION_REPLACED_ERR_MSG, TRPC_MAX_BATCH_SIZE, UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, httpLink, splitLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { mobileAuth } from "./lib/mobileAuth";
import { clearPersistedQueryCache, restorePersistedQueryCache, startQueryCachePersistence } from "./lib/queryPersistence";
import "./index.css";
import { applyRememberedLayout } from "./components/LayoutLayer";
import { prefetchRoute } from "./pages/routeChunks";
import { startLayoutProbeIfRequested } from "./lib/layoutProbe";
import { DATABASE_UNAVAILABLE_MESSAGE } from "@shared/databaseHealth";
import { DATABASE_HEALTH_QUERY_KEY } from "./components/DatabaseHealthGate";
import { loadUiThemeStyles, setUiThemeAssetBase } from "./lib/uiThemeStyles";
import { userImpersonation } from "./lib/userImpersonation";

/*
  管理员「进入用户后台」开出来的标签页：在任何请求发出去之前认出来、把令牌从地址栏拿掉，
  并让这个标签页的 /api/ 请求都带代入令牌、不带 cookie（lib/userImpersonation.ts）。普通标签页什么都不变。
*/
userImpersonation.initialize();
globalThis.fetch = userImpersonation.wrapFetch(globalThis.fetch.bind(globalThis));

// 精简布局：刷新时先按上次记住的挂上，auth.me 回来后 LayoutLayer 再校正
applyRememberedLayout();

/*
  界面主题的样式按需下（lib/uiThemeStyles.ts）：index.html 的内联脚本已经按上次记住的那套挂好了
  data-ui-theme（内置的，或者上次记下的已安装主题包），这里马上去下那一套，bootstrap 里等它下完再 createRoot —— 第一帧就是那套主题，
  不会先画成经典再跳过去。和 bootstrap 里页面包的预取、手机 App 读登录态同时进行，一般不多等。
  网太慢时最多等 BOOT_THEME_WAIT_MS：宁可主题晚一点补上，也不让整页一直停在启动底色上。
*/
const BOOT_THEME_WAIT_MS = 5_000;
// App 里页面不在面板的域名下：主题包的样式要到登录时填的面板地址去取
setUiThemeAssetBase(mobileAuth.isNative ? mobileAuth.panelOrigin() : "");
const bootUiThemeStyles = typeof document === "undefined"
  ? Promise.resolve()
  : loadUiThemeStyles(document.documentElement.getAttribute("data-ui-theme"));

const LOGIN_EXPIRED_NOTICE = "登录状态已失效，请重新登录";

const cachedSiteTitle = (() => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem("forwardx.siteTitle")?.trim() || "";
  } catch {
    return "";
  }
})();

if (cachedSiteTitle) {
  document.title = resolveSiteTitle(cachedSiteTitle);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof TRPCClientError) {
          // 数据库故障：重试没有意义，交给故障页每 5 秒检查一次恢复。
          if (error.message === DATABASE_UNAVAILABLE_MESSAGE) return false;
          if (
            error.message === UNAUTHED_ERR_MSG ||
            error.message === ACCOUNT_DISABLED_ERR_MSG ||
            error.message === SESSION_REPLACED_ERR_MSG
          ) return false;
        }
        return failureCount < 1;
      },
      staleTime: 5_000,
      gcTime: 30 * 60_000,
    },
  },
});

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;
  // 代入窗口：401 说明代入结束了（到期、管理员退出、目标被停用）。不去登录页、不清本机缓存 ——
  // 登录页和那份缓存都是管理员自己的；这个标签页只显示「代入已结束」。
  if (userImpersonation.isEntry()) {
    if (error.data?.code === "UNAUTHORIZED") {
      userImpersonation.finish();
      void queryClient.cancelQueries();
      queryClient.clear();
    }
    return;
  }

  const isUnauthorized =
    error.message === UNAUTHED_ERR_MSG ||
    error.message === ACCOUNT_DISABLED_ERR_MSG ||
    error.message === SESSION_REPLACED_ERR_MSG;

  if (!isUnauthorized) return;
  const notice = error.message === ACCOUNT_DISABLED_ERR_MSG || error.message === SESSION_REPLACED_ERR_MSG
    ? error.message
    : LOGIN_EXPIRED_NOTICE;
  if (mobileAuth.isNative || error.message === ACCOUNT_DISABLED_ERR_MSG) {
    mobileAuth.clear();
  }
  window.sessionStorage.setItem("forwardx.loginNotice", notice);
  clearPersistedQueryCache();
  void queryClient.cancelQueries();
  queryClient.clear();

  // Only redirect if not already in a public bootstrapping flow.
  if (window.location.pathname !== "/login" && window.location.pathname !== "/setup") {
    window.location.href = "/login";
  }
};

/** 业务请求拿到「数据库暂时不可用」：立刻查一次健康状态，故障页不用等下一轮。不跳登录页、不清登录态。 */
const checkDatabaseHealthOnOutage = (error: unknown) => {
  if (!(error instanceof TRPCClientError) || error.message !== DATABASE_UNAVAILABLE_MESSAGE) return false;
  void queryClient.invalidateQueries({ queryKey: [DATABASE_HEALTH_QUERY_KEY] });
  return true;
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    if (checkDatabaseHealthOnOutage(error)) return;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    if (checkDatabaseHealthOnOutage(error)) return;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const criticalQueryPaths = new Set([
  "auth.me",
  "setup.status",
  // 首页最上面那一块（状态 + 需要关注）读的是它；dashboard.stats 首页已经不再调用。
  "dashboard.health",
  "dashboard.trafficTotals",
  "dashboard.trafficSeries",
  "dashboard.trafficBreakdown",
  "dashboard.userTraffic",
]);

const trpcFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  let requestInput = input;
  if (mobileAuth.isNative) {
    const panelUrl = mobileAuth.getPanelUrl();
    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const parsed = new URL(rawUrl, window.location.href);
    if (panelUrl && parsed.pathname.startsWith("/api/trpc")) {
      requestInput = `${panelUrl}${parsed.pathname}${parsed.search}`;
    }
  }
  const headers = new Headers(init?.headers);
  if (mobileAuth.isNative) {
    headers.set("x-forwardx-mobile", "1");
    const token = mobileAuth.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return globalThis.fetch(requestInput, {
    ...(init ?? {}),
    headers,
    credentials: "include",
  });
};

const trpcClient = trpc.createClient({
  links: [
    splitLink({
      condition: (op) => op.type === "query" && criticalQueryPaths.has(op.path),
      true: httpLink({
        url: "/api/trpc",
        transformer: superjson,
        fetch: trpcFetch,
      }),
      false: httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        fetch: trpcFetch,
        // 服务端对单个 batch 有上限，超出的调用由客户端自己拆成多个请求。
        maxItems: TRPC_MAX_BATCH_SIZE,
      }),
    }),
  ],
});

async function bootstrap() {
  /*
    这一页的代码和入口包一起下：刷新 /rules 时不等外壳渲染到路由那一层才去取 Rules 的包
    （本机缓存也要先取再求值，排在入口包的那 60ms 之后），现在和入口包的求值并行。
    不认识的地址（登录页、公开页）这里直接返回 undefined，没有副作用。
  */
  if (typeof window !== "undefined") void prefetchRoute(window.location.pathname);
  startLayoutProbeIfRequested();
  await mobileAuth.hydrateNative();

  if (mobileAuth.isNative) {
    document.documentElement.classList.add("capacitor-native");
    document.documentElement.classList.toggle("capacitor-ios", mobileAuth.platform === "ios");
  }

  // 先把上一次的数据放进缓存再挂页面：有缓存时不再整屏空白等接口，接口回来再换新的。
  // App 里按面板地址分开存，换了面板不会串。
  const cacheScope = () => (mobileAuth.isNative ? mobileAuth.getPanelUrl() || "native" : "");
  // 代入窗口不读也不写本机缓存：那份缓存和管理员的标签页共用一个 localStorage，
  // 读了会先画出管理员的数据，写了会让管理员下次打开时先看到这个用户的数据。
  if (!userImpersonation.isEntry()) {
    restorePersistedQueryCache(queryClient, { scope: cacheScope() });
    startQueryCachePersistence(queryClient, { scope: cacheScope });
  }

  await Promise.race([bootUiThemeStyles, new Promise<void>((resolve) => setTimeout(resolve, BOOT_THEME_WAIT_MS))]);

  createRoot(document.getElementById("root")!).render(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  );
  // index.html 里的启动底色只管脚本跑起来之前；页面画上之后交还给正常样式（页面底色、壁纸）。
  requestAnimationFrame(() => document.documentElement.classList.remove("fx-booting"));
}

void bootstrap();
