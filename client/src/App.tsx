import { LazyMotion, MotionConfig } from "motion/react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import NotFound from "@/pages/NotFound";
import { matchRoute, Redirect, Route, Switch, useLocation, useRouter } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import RouteFallback from "./components/RouteFallback";
import { AppShell } from "./components/DashboardLayout";
import { prefetchRoute, routeChunks } from "@/pages/routeChunks";
import { ThemeProvider } from "./contexts/ThemeContext";
import PersonalizationLayer from "./components/PersonalizationLayer";
import Live2DWidgetHost from "./components/plugins/Live2DWidgetHost";
import HomePage from "@/pages/Home";
import LoginPage from "@/pages/Login";

const loadMotionFeatures = () => import("@/motionFeatures").then((mod) => mod.default);

/*
  除了登录页和总览，其余页面按路由拆包。

  原来 26 个页面全是静态导入，打出来的主 chunk 有 3.48 MB：一个只想看
  「我的套餐」的租户，手机上要先把 Settings（6460 行）、Rules（8778 行）、
  Plugins 的全部代码下完才能看到第一屏。

  Login 和 Home 刻意留同步 —— 它们是所有人的入口，拆了会在最常见的那两屏
  上多一次往返、闪一下 fallback，省下来的字节反而不划算。初始化向导（一辈子
  只走一次）和未登录的落地页（Home 里按需 lazy）不在此列，不进入口包。

  import() 表达式登记在 pages/routeChunks.ts：外壳在空闲时按同一张表预取，
  标签栏点过去时代码已经在缓存里。
*/
const SetupPage = lazy(() => import("./pages/Setup"));
const AnnouncementsPage = lazy(routeChunks["/announcements"] as () => Promise<{ default: ComponentType<any> }>);
const BillingPage = lazy(routeChunks["/billing"] as () => Promise<{ default: ComponentType<any> }>);
const CustomSidebarPage = lazy(() => import("@/pages/CustomSidebarPage"));
const EmailSettingsPage = lazy(() => import("@/pages/EmailSettingsRoute"));
const ForwardGroupsPage = lazy(routeChunks["/forward-groups"] as () => Promise<{ default: ComponentType<any> }>);
const HomepagePreviewPage = lazy(() => import("@/pages/HomepagePreview"));
const HostMonitorPage = lazy(() => import("@/pages/HostMonitor"));
const HostsPage = lazy(routeChunks["/hosts"] as () => Promise<{ default: ComponentType<any> }>);
const MorePage = lazy(routeChunks["/more"] as () => Promise<{ default: ComponentType<any> }>);
const LookingGlassPage = lazy(routeChunks["/looking-glass"] as () => Promise<{ default: ComponentType<any> }>);
const PaymentsPage = lazy(routeChunks["/payments"] as () => Promise<{ default: ComponentType<any> }>);
const PlansPage = lazy(routeChunks["/plans"] as () => Promise<{ default: ComponentType<any> }>);
const PluginsPage = lazy(routeChunks["/plugins"] as () => Promise<{ default: ComponentType<any> }>);
const ProfilePage = lazy(routeChunks["/profile"] as () => Promise<{ default: ComponentType<any> }>);
const RulesPage = lazy(routeChunks["/rules"] as () => Promise<{ default: ComponentType<any> }>);
const SettingsPage = lazy(routeChunks["/settings"] as () => Promise<{ default: ComponentType<any> }>);
const StorePage = lazy(routeChunks["/store"] as () => Promise<{ default: ComponentType<any> }>);
const SubscriptionsPage = lazy(routeChunks["/subscriptions"] as () => Promise<{ default: ComponentType<any> }>);
const ClientSubscriptionsPage = lazy(routeChunks["/client-subscriptions"] as () => Promise<{ default: ComponentType<any> }>);
const ProxyInboundsPage = lazy(routeChunks["/proxy-inbounds"] as () => Promise<{ default: ComponentType<any> }>);
const TrafficBillingPage = lazy(routeChunks["/traffic-billing"] as () => Promise<{ default: ComponentType<any> }>);
const TunnelsPage = lazy(routeChunks["/tunnels"] as () => Promise<{ default: ComponentType<any> }>);
const UsersPage = lazy(routeChunks["/users"] as () => Promise<{ default: ComponentType<any> }>);
const WalletPage = lazy(routeChunks["/wallet"] as () => Promise<{ default: ComponentType<any> }>);

type RoutableComponent = ComponentType<any>;

/*
  Suspense 边界要贴着页面本身，不能包在整个 <Switch> 外面。

  包在外面的话，页面代码还在下载时整棵树都处于挂起状态，守卫（AdminRoute）会跟着
  重新渲染 —— 而守卫在渲染期会返回 <Redirect>，那会同步改地址，进而更新所有
  useLocation 的订阅者（侧边栏就是其中之一）。于是「渲染 A 的时候更新了 B」，
  几个来回就撞上 React 的更新深度上限，整页掉进 ErrorBoundary。

  放在守卫里面，挂起就只影响页面这一小块，守卫已经算完、不会被重来。
*/
function LazyBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

function routeComponent(Component: RoutableComponent) {
  return () => <LazyBoundary><Component /></LazyBoundary>;
}

function isLoginRoute(location: string) {
  return location.startsWith("/login");
}

const isLocalDevPanel = (import.meta as any).env?.VITE_FORWARDX_DEV_PANEL === "1";

function AdminRoute({ component: Component }: { component: RoutableComponent }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin") return <Redirect to="/" />;
  return <LazyBoundary><Component /></LazyBoundary>;
}

function LookingGlassRoute() {
  const { user, loading } = useAuth();
  const publicInfo = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (loading) return null;
  if (user && publicInfo.isLoading && !publicInfo.data) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin" && publicInfo.data?.lookingGlassUserEnabled !== true) return <Redirect to="/" />;
  return <LazyBoundary><LookingGlassPage /></LazyBoundary>;
}

function PluginsRoute({ sidebarPluginId }: { sidebarPluginId?: string }) {
  const { user, loading } = useAuth();
  const publicInfo = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (loading) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin") return <Redirect to="/" />;
  if (publicInfo.isLoading && !publicInfo.data) return <LazyBoundary><PluginsPage sidebarPluginId={sidebarPluginId} /></LazyBoundary>;
  if (publicInfo.data?.pluginsEnabled !== true) return <Redirect to="/settings" />;
  return <LazyBoundary><PluginsPage sidebarPluginId={sidebarPluginId} /></LazyBoundary>;
}

function Routes() {
  return (
    <Switch>
      <Route path="/setup">{routeComponent(SetupPage)}</Route>
      <Route path="/login">{routeComponent(LoginPage)}</Route>
      <Route path="/session-wait"><Redirect to="/login" /></Route>
      <Route path="/homepage-preview">{routeComponent(HomepagePreviewPage)}</Route>
      <Route path="/">{routeComponent(HomePage)}</Route>
      <Route path="/profile">{routeComponent(ProfilePage)}</Route>
      {/*
        主机管理对租户也开放：他能自助加机器，就得有个地方看这些机器的状况
        （CPU、内存、磁盘、流量、在不在线）。页面按角色收口 —— 服务端只给他
        自己的机器（listPage 的 ownedOnly），分组/Token 两个 tab 和 Agent 升级、
        重置流量这些管理员专属的入口都不渲染。
      */}
      <Route path="/hosts">{routeComponent(HostsPage)}</Route>
      {/* 手机端标签栏第五格。桌面端左侧边栏已经列全了，这一页会说明这一点 */}
      <Route path="/more">{routeComponent(MorePage)}</Route>
      {/*
        整页「网络地图」已经去掉，地图只留在总览那一张卡片里。旧书签、别处贴过的 /map（含 ?host= / ?link=）
        回到总览：不写这条的话 /map 会落进下面的 /:monitorPath，被当成公开监控页的路径。
      */}
      <Route path="/map"><Redirect to="/" /></Route>
      <Route path="/rules">{routeComponent(RulesPage)}</Route>
      <Route path="/looking-glass" component={LookingGlassRoute} />
      <Route path="/forward-groups">{() => <AdminRoute component={ForwardGroupsPage} />}</Route>
      <Route path="/tunnels">{() => <AdminRoute component={TunnelsPage} />}</Route>
      <Route path="/users">{() => <AdminRoute component={UsersPage} />}</Route>
      <Route path="/email-settings">{() => <AdminRoute component={EmailSettingsPage} />}</Route>
      <Route path="/payments">{() => <AdminRoute component={PaymentsPage} />}</Route>
      <Route path="/billing">{() => <AdminRoute component={BillingPage} />}</Route>
      <Route path="/traffic-billing">{() => <AdminRoute component={TrafficBillingPage} />}</Route>
      <Route path="/plans">{() => <AdminRoute component={PlansPage} />}</Route>
      <Route path="/plugins/sidebar/:pluginId">
        {(params) => <PluginsRoute sidebarPluginId={params.pluginId} />}
      </Route>
      <Route path="/plugins">{() => <PluginsRoute />}</Route>
      <Route path="/store">{routeComponent(StorePage)}</Route>
      <Route path="/subscriptions">{routeComponent(SubscriptionsPage)}</Route>
      <Route path="/client-subscriptions">{routeComponent(ClientSubscriptionsPage)}</Route>
      <Route path="/proxy-inbounds">{routeComponent(ProxyInboundsPage)}</Route>
      <Route path="/wallet">{routeComponent(WalletPage)}</Route>
      <Route path="/announcements">{routeComponent(AnnouncementsPage)}</Route>
      <Route path="/settings">{() => <AdminRoute component={SettingsPage} />}</Route>
      <Route path="/custom-pages/:pageId">
        {(params) => <LazyBoundary><CustomSidebarPage pageId={params.pageId} /></LazyBoundary>}
      </Route>
      <Route path="/404" component={NotFound} />
      <Route path="/:monitorPath">{routeComponent(HostMonitorPage)}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

/*
  登录后才看得到的页面：这些路由外面常驻一层外壳（侧边栏 / 标签栏 / 外壳上的查询），
  换页只换内容区，页面代码在下载时转圈也只出现在内容区里。

  "/" 也在其中：未登录时它是公开落地页，那时 AppShell 不画，下面的 Router 直接给
  不带外壳的路由。公开监控页（/:monitorPath）、登录、初始化、预览不在表里。
  新加一个登录后页面要记得登记在这里；漏了也不会坏，只是那一页退回到自己包外壳、
  进出时外壳重建。
*/
const shellRoutePatterns = [
  "/",
  "/profile",
  "/hosts",
  "/more",
  "/map",
  "/rules",
  "/looking-glass",
  "/forward-groups",
  "/tunnels",
  "/users",
  "/email-settings",
  "/payments",
  "/billing",
  "/traffic-billing",
  "/plans",
  "/plugins/sidebar/:pluginId",
  "/plugins",
  "/store",
  "/subscriptions",
  "/client-subscriptions",
  "/proxy-inbounds",
  "/wallet",
  "/announcements",
  "/settings",
  "/custom-pages/:pageId",
];

function useIsShellRoute(location: string) {
  const { parser } = useRouter();
  return shellRoutePatterns.some((pattern) => matchRoute(parser, pattern, location)[0]);
}

/*
  和 useAuth 是同一个查询（参数一致，共用缓存）。只在外壳路由上问：登录页、公开页
  不该因为外壳多发一次 auth.me —— 会话被顶掉时它报错，会在登录页上再清一遍缓存。
*/
function useShellAuth(shellRoute: boolean) {
  return trpc.auth.me.useQuery(undefined, {
    enabled: shellRoute && (!mobileAuth.isNative || mobileAuth.hasPanelUrl()),
    retry: false,
    refetchOnWindowFocus: false,
  });
}

function Router() {
  const [location] = useLocation();
  const shellRoute = useIsShellRoute(location);
  const { data: user, isLoading: loading } = useShellAuth(shellRoute);

  if (shellRoute && (loading || user)) {
    return <AppShell><Routes /></AppShell>;
  }
  return <Routes />;
}

function SetupGate() {
  const [location] = useLocation();
  const hasMobilePanelUrl = !mobileAuth.isNative || mobileAuth.hasPanelUrl();
  const loginRoute = isLoginRoute(location);

  // Keep this hook unconditional.  Local development redirects /login to the
  // seeded dashboard, and returning before the query here makes the hook list
  // change when the redirect completes.
  const setup = trpc.setup.status.useQuery(undefined, {
    enabled: hasMobilePanelUrl && !loginRoute,
    retry: false,
    refetchOnWindowFocus: false,
  });
  /*
    登录态、初始化状态、这一页的代码三样一起取。原来是串行的：setup.status 回来
    才挂页面，页面代码到了才发 auth.me，首屏要多等一到两个来回。
  */
  const shellRoute = useIsShellRoute(location);
  const auth = useShellAuth(shellRoute);
  useEffect(() => {
    if (shellRoute && auth.isLoading) void prefetchRoute(location);
  }, [shellRoute, auth.isLoading, location]);

  // The local dev panel injects the seeded administrator in the server
  // context, so showing a login form here only creates a needless gate.
  if (isLocalDevPanel && (loginRoute || location === "/session-wait")) {
    return <Redirect to="/" />;
  }

  if (!hasMobilePanelUrl) {
    if (location !== "/login") return <Redirect to="/login" />;
    return <Router />;
  }

  if (loginRoute) return <Router />;

  if (setup.isError) {
    if (mobileAuth.isNative) {
      if (location !== "/login") return <Redirect to="/login" />;
      return <Router />;
    }
    return <Router />;
  }

  // 没有本机缓存（第一次打开、刚升级）时要等这一个来回：接着显示 index.html 里那条启动进度条，不留空白。
  if (setup.isLoading) return <div id="fx-boot" aria-hidden="true" />;

  const ready = !!setup.data?.setupComplete;
  if (!ready && location !== "/setup") return <Redirect to="/setup" />;
  if (ready && location === "/setup") return <Redirect to="/login" />;
  return <Router />;
}

function App() {
  return (
    /*
      动画库按需加载：入口包里只有 LazyMotion + m.*（几 KB）；淡入淡出的实现
      （domAnimation）走动态 import，首屏画完再到。原来用 motion.* 会把整套
      framer-motion（压缩前 458 kB 源码）打进入口包，而全站只有两处淡入淡出在用它。
      strict 模式下再写 motion.* 会直接报错，防止又长回去。
    */
    <LazyMotion features={loadMotionFeatures} strict>
    <MotionConfig reducedMotion="user">
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <ConfirmDialogProvider>
            <PersonalizationLayer />
            <Live2DWidgetHost />
            <Toaster />
            <SetupGate />
          </ConfirmDialogProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
    </MotionConfig>
    </LazyMotion>
  );
}

export default App;
