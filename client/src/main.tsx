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

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
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
  await mobileAuth.hydrateNative();

  if (mobileAuth.isNative) {
    document.documentElement.classList.add("capacitor-native");
    document.documentElement.classList.toggle("capacitor-ios", mobileAuth.platform === "ios");
  }

  // 先把上一次的数据放进缓存再挂页面：有缓存时不再整屏空白等接口，接口回来再换新的。
  // App 里按面板地址分开存，换了面板不会串。
  const cacheScope = () => (mobileAuth.isNative ? mobileAuth.getPanelUrl() || "native" : "");
  restorePersistedQueryCache(queryClient, { scope: cacheScope() });
  startQueryCachePersistence(queryClient, { scope: cacheScope });

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
