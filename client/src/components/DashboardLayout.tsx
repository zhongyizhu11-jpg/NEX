import { resolveSiteTitle } from "@shared/brand";
import { avatarQuotaState } from "@/lib/avatarQuota";
import { useAuth } from "@/_core/hooks/useAuth";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
  SidebarGroup,
  SidebarGroupLabel,
} from "@/components/ui/sidebar";
import { useTheme } from "@/contexts/ThemeContext";
import { UiThemeQuickSwitch } from "@/components/UiThemeQuickSwitch";
import {
  LayoutDashboard,
  Ellipsis,
  LogOut,
  PanelLeft,
  Server,
  ArrowRightLeft,
  Users,
  Settings,
  Shield,
  Network,
  KeyRound,
  UserRound,
  Rocket,
  Route,
  Rss,
  Sun,
  Moon,
  Zap,
  CreditCard,
  WalletCards,
  ReceiptText,
  Package,
  ShoppingBag,
  Megaphone,
  LifeBuoy,
  Send,
  Copy,
  Link2Off,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Download,
  RefreshCw,
  ExternalLink,
  Image,
  Globe2,
  BellOff,
  Puzzle,
  Search,
  Activity,
  Gift,
  Check,
  Rows3,
  type LucideIcon,
} from "lucide-react";
import { useOpsFeatures } from "@/features/ops/useOpsFeatures";
import OpsMaintenanceBanner from "@/features/ops/maintenance/MaintenanceBanner";
import { App as CapacitorApp } from "@capacitor/app";
import { rememberSidebarScroll } from "@/lib/sidebarScroll";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IosTabBar } from "@/components/ios/TabBar";
import { MobileNavContext, type MobileNavEntry } from "@/components/ios/navigationContext";
import { MORE_TAB_PATH, pickTabBarItems } from "@/components/ios/tabBarModel";
import { useLocation } from "wouter";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { PasswordInput } from "./ui/password-input";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useQueryFailureSignal } from "@/hooks/useQueryFailureSignal";
import { queryFailureBannerText } from "@/lib/queryFailureBanner";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { authErrorMessage } from "@/lib/authErrorMessage";
import { renderMixedHtml } from "@/lib/htmlContent";
import { mobileAuth } from "@/lib/mobileAuth";
import { openMobileReleasePage } from "@/lib/mobileNotifications";
import { useMobileAppUpdateCheck } from "@/lib/mobileAppUpdateCheck";
import { cn } from "@/lib/utils";
import { getPanelUpgradeProgress, markPanelUpgradeRefreshed, panelUpgradeJobKey, resolvePanelUpgradeRefresh } from "@/lib/panelUpgrade";
import { copyTextToClipboard } from "@/lib/clipboard";
import { AvatarPicker } from "@/components/AvatarPicker";
import { UserAvatar } from "@/components/UserAvatar";
import { normalizeSidebarMenuSettings, type SidebarMenuKey } from "@shared/sidebarMenu";
import { buildPanelInstallerCommand } from "@shared/githubAccelerator";
import { WorkspaceCommand, type WorkspaceDestination } from "@/components/WorkspaceNavigation";
import PearlNavMarker from "@/components/PearlNavMarker";
import { useUiTheme } from "@/hooks/useUiTheme";
import { useLayoutPreference } from "@/hooks/useCompactLayout";
import { navigateAfterPrefetch, prefetchRoute, prefetchRoutesWhenIdle } from "@/pages/routeChunks";
import { docsUrl } from "@/lib/docsLinks";

const TWO_FACTOR_SETUP_SECONDS = 5 * 60;
/*
  外壳上的配置类查询（站点信息、侧栏页面、商店开关、公告、2FA/TG 绑定状态……）
  一天也变不了几次，改了的地方都会 invalidate。全局默认 5 秒就过期，
  别的页面一挂同 key 的查询就要重拉一轮，这里放宽到 5 分钟。
*/
const SHELL_META_STALE_MS = 5 * 60 * 1000;
const SITE_LOGO_CACHE_KEY = "forwardx.siteLogoDataUrl";
type SidebarNavItem = {
  icon: LucideIcon;
  label: string;
  path: string;
  menuKey?: SidebarMenuKey;
  iconSrc?: string;
  externalUrl?: string;
  /** 侧栏右边的小计数（工单管理的待处理数），0 或不给就不画。 */
  badge?: number;
};

const announcementsMenuItem: SidebarNavItem = { icon: Megaphone, label: "公告", path: "/announcements", menuKey: "announcements" };
/** 工单：用户提单的入口跟在商店 / 账单后面；管理员的「工单管理」在管理区。同一个菜单开关管两边。 */
const userTicketsMenuItem: SidebarNavItem = { icon: LifeBuoy, label: "工单", path: "/tickets", menuKey: "tickets" };
const ADMIN_TICKETS_PATH = "/admin/tickets";
const ADMIN_TICKET_COUNTS_POLL_MS = 60 * 1000;

const mainMenuItems: SidebarNavItem[] = [
  { icon: LayoutDashboard, label: "总览", path: "/", menuKey: "dashboard" },
  { icon: Server, label: "主机管理", path: "/hosts" },
  { icon: Route, label: "链路管理", path: "/tunnels" },
  { icon: Network, label: "网络拓扑", path: "/topology", menuKey: "topology" },
  { icon: ArrowRightLeft, label: "转发规则", path: "/rules" },
  { icon: Rss, label: "订阅管理", path: "/client-subscriptions" },
];
const profileMenuItem: SidebarNavItem = { icon: UserRound, label: "个人资料", path: "/profile", menuKey: "profile" };
/** 邀请返利：返利没开（publicInfo.referralEnabled）时不显示；管理员也能有自己的邀请码，一样显示。 */
const referralsMenuItem: SidebarNavItem = { icon: Gift, label: "邀请返利", path: "/referrals", menuKey: "referrals" };
const lookingGlassMenuItem: SidebarNavItem = { icon: Globe2, label: "网络测试", path: "/looking-glass", menuKey: "lookingGlass" };
const pluginManagementMenuItem: SidebarNavItem = { icon: Puzzle, label: "插件管理", path: "/plugins", menuKey: "plugins" };
/** 监控：那批运维功能的入口页（见 client/src/features/ops/useOpsFeatures.ts），只给管理员。 */
const insightsMenuItem: SidebarNavItem = { icon: Activity, label: "监控", path: "/insights" };

const adminMenuItems: SidebarNavItem[] = [
  { icon: CreditCard, label: "支付对接", path: "/payments", menuKey: "payments" },
  { icon: WalletCards, label: "账单与兑换", path: "/billing", menuKey: "billing" },
  { icon: Package, label: "套餐管理", path: "/plans", menuKey: "plans" },
  { icon: Users, label: "用户管理", path: "/users", menuKey: "users" },
  // 订阅运营：全站令牌、拉取统计、模板、设置。用户自己的订阅在主菜单的「订阅管理」。
  { icon: Rss, label: "订阅运营", path: "/admin/subscriptions" },
  { icon: LifeBuoy, label: "工单管理", path: ADMIN_TICKETS_PATH, menuKey: "tickets" },
  lookingGlassMenuItem,
  { icon: Settings, label: "系统设置", path: "/settings", menuKey: "settings" },
];

const PANEL_UPGRADE_SESSION_KEY = "forwardx.panel.upgrade";
const PANEL_UPGRADE_NOTICE_DISMISSED_KEY = "forwardx.panel.upgrade.dismissedVersion";
const PANEL_UPGRADE_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const UPDATE_AUTO_CHECK_REFETCH_MS = 6 * 60 * 60 * 1000;
const POPUP_ANNOUNCEMENT_SESSION_KEY = "forwardx.popupAnnouncement.seen";
const UPGRADE_ANNOUNCEMENT_VERSION_KEY = "forwardx.upgradeAnnouncement.lastSeenVersion";
const UPGRADE_ANNOUNCEMENT_DISPLAY_SESSION_KEY = "forwardx.upgradeAnnouncement.displayed";
const UPGRADE_ANNOUNCEMENT_COUNTDOWN_SECONDS = 5;
type PanelUpgradeSession = { targetVersion: string; startedAt: number; mode?: "upgrade" | "rollback" };
type UpgradeAnnouncementDisplaySession = { key: string; shownAt: number };

function popupAnnouncementSessionKey(userId?: number | null) {
  return `${POPUP_ANNOUNCEMENT_SESSION_KEY}:${Number(userId || 0)}`;
}

function upgradeAnnouncementVersionKey(userId?: number | null) {
  return `${UPGRADE_ANNOUNCEMENT_VERSION_KEY}:${Number(userId || 0)}`;
}

function upgradeAnnouncementDisplaySessionKey(userId?: number | null) {
  return `${UPGRADE_ANNOUNCEMENT_DISPLAY_SESSION_KEY}:${Number(userId || 0)}`;
}

function readSeenPopupAnnouncementIds(userId?: number | null) {
  if (typeof window === "undefined" || !userId) return [] as number[];
  try {
    const raw = window.sessionStorage.getItem(popupAnnouncementSessionKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

function markPopupAnnouncementSeen(userId?: number | null, announcementId?: number | null) {
  if (typeof window === "undefined" || !userId || !announcementId) return;
  try {
    const next = Array.from(new Set([...readSeenPopupAnnouncementIds(userId), Number(announcementId)]));
    window.sessionStorage.setItem(popupAnnouncementSessionKey(userId), JSON.stringify(next));
  } catch {
    // Ignore storage failures so popup behavior still works with server-side dismiss.
  }
}

function clearSeenPopupAnnouncements(userId?: number | null) {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.sessionStorage.removeItem(popupAnnouncementSessionKey(userId));
  } catch {
    // Ignore storage failures.
  }
}

function readLastSeenUpgradeAnnouncementVersion(userId?: number | null) {
  if (typeof window === "undefined" || !userId) return "";
  try {
    return normalizePanelVersion(window.localStorage.getItem(upgradeAnnouncementVersionKey(userId)));
  } catch {
    return "";
  }
}

function writeLastSeenUpgradeAnnouncementVersion(userId: number, version: string) {
  if (typeof window === "undefined" || !userId) return;
  const normalizedVersion = normalizePanelVersion(version);
  if (!normalizedVersion) return;
  try {
    window.localStorage.setItem(upgradeAnnouncementVersionKey(userId), normalizedVersion);
  } catch {
    // Ignore storage failures and fall back to server-side read tracking.
  }
}

function readUpgradeAnnouncementDisplaySession(userId?: number | null): UpgradeAnnouncementDisplaySession | null {
  if (typeof window === "undefined" || !userId) return null;
  try {
    const raw = window.sessionStorage.getItem(upgradeAnnouncementDisplaySessionKey(userId));
    if (!raw) return null;
    const value = JSON.parse(raw);
    const key = String(value?.key || "");
    const shownAt = Number(value?.shownAt || 0);
    if (!key || !Number.isFinite(shownAt) || shownAt <= 0) return null;
    return { key, shownAt };
  } catch {
    return null;
  }
}


function writeUpgradeAnnouncementDisplaySession(userId: number, session: UpgradeAnnouncementDisplaySession) {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.sessionStorage.setItem(upgradeAnnouncementDisplaySessionKey(userId), JSON.stringify(session));
  } catch {
    // Ignore storage failures; the announcement can still be dismissed normally.
  }
}


function clearUpgradeAnnouncementDisplaySession(userId?: number | null) {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.sessionStorage.removeItem(upgradeAnnouncementDisplaySessionKey(userId));
  } catch {
    // Ignore storage failures.
  }
}

function readCachedSiteLogo() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(SITE_LOGO_CACHE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

function normalizePanelVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

function comparePanelVersions(a: string | null | undefined, b: string | null | undefined) {
  const pa = normalizePanelVersion(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = normalizePanelVersion(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function clearPanelUpgradeSession() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PANEL_UPGRADE_SESSION_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function readDismissedPanelUpgradeNoticeVersion() {
  if (typeof window === "undefined") return "";
  try {
    return normalizePanelVersion(window.localStorage.getItem(PANEL_UPGRADE_NOTICE_DISMISSED_KEY));
  } catch {
    return "";
  }
}

function readPanelUpgradeSession(): PanelUpgradeSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PANEL_UPGRADE_SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    const startedAt = Number(value?.startedAt);
    if (!value?.targetVersion || !Number.isFinite(startedAt)) {
      clearPanelUpgradeSession();
      return null;
    }
    if (Date.now() - startedAt > PANEL_UPGRADE_SESSION_TTL_MS) {
      clearPanelUpgradeSession();
      return null;
    }
    const mode = value?.mode === "rollback" ? "rollback" : "upgrade";
    return { targetVersion: String(value.targetVersion), startedAt, mode };
  } catch {
    clearPanelUpgradeSession();
    return null;
  }
}

/*
  外壳常驻：App 在登录后的路由外面挂一次 <AppShell>，换页时侧边栏、标签栏、
  弹窗状态和外壳的十几个查询都不再拆了重建；页面代码还在下载时，转圈只出现在
  内容区里。

  各页面仍然自己包一层 <DashboardLayout> —— 在 AppShell 里面它只原样渲染
  children；不在里面（未登录、或者某个没登记进 App 外壳路由表的页面）时
  它退回原来的整套外壳，行为不变。
*/
const AppShellContext = createContext(false);

/** 常驻外壳。只有已登录时才画；未登录交给页面自己（公开首页 / 跳登录）。 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <AppShellContext.Provider value={true}>
      <SidebarProvider className="workspace-layout">
        <DashboardLayoutContent>
          {children}
        </DashboardLayoutContent>
      </SidebarProvider>
    </AppShellContext.Provider>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const insideShell = useContext(AppShellContext);
  const { loading, user } = useAuth();

  if (insideShell) return <>{children}</>;

  if (loading) return null;

  if (!user) {
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    return null;
  }

  return <AppShell>{children}</AppShell>;
}

function DashboardLayoutContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar, isMobile, openMobile, setOpenMobile } = useSidebar();
  const uiTheme = useUiTheme();
  const openMobileRef = useRef(openMobile);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  /*
    外壳常驻以后换页不再整页重挂，原来顺带「归零」的东西要自己做：滚动位置回到
    顶部（不然从规则页底部点到主机页会落在半中间），手机抽屉和账户菜单收起。
    只改 ?tab= 不算换页；首次挂载也不动。
  */
  const shellPathRef = useRef(location);
  useLayoutEffect(() => {
    if (shellPathRef.current === location) return;
    shellPathRef.current = location;
    setOpenMobile(false);
    setAccountMenuOpen(false);
    if (!window.location.hash) window.scrollTo(0, 0);
  }, [location, setOpenMobile]);
  const [commandOpen, setCommandOpen] = useState(false);
  const commandOpenRef = useRef(commandOpen);
  const accountMenuOpenRef = useRef(accountMenuOpen);
  const isDesktopCollapsed = !isMobile && state === "collapsed";
  const isAdmin = user?.role === "admin";
  const layoutPreference = useLayoutPreference();
  const compactLayout = layoutPreference.effective === "compact";
  /*
    侧栏滚动位置（上游 2.3.285）：每个页面自己包一层外壳，换页时侧栏重新挂载、滚动条跳回顶部。
    按账号 + 侧栏形态记住位置，挂载后还原；用户自己一滚就以他为准。
  */
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) return;
    const scroll = rememberSidebarScroll(content, `${user?.id ?? 0}:${isMobile ? "mobile" : state}`);
    scroll.restore();
    const interrupt = (event: Event) => {
      if (event instanceof KeyboardEvent && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      scroll.interrupt();
    };
    const inputEvents = ["wheel", "touchstart", "pointerdown", "keydown"];
    content.addEventListener("scroll", scroll.save, { passive: true });
    for (const name of inputEvents) content.addEventListener(name, interrupt, { passive: true });
    // 菜单（插件页、自定义页）可能是异步补进来的：内容一变再试着还原一次。
    const mutations = new MutationObserver(() => scroll.restore());
    mutations.observe(content, { childList: true, subtree: true });
    return () => {
      scroll.save();
      mutations.disconnect();
      content.removeEventListener("scroll", scroll.save);
      for (const name of inputEvents) content.removeEventListener(name, interrupt);
    };
  }, [user?.id, isMobile, state]);
  const opsFeatures = useOpsFeatures();
  const utils = trpc.useUtils();
  const queryFailure = useQueryFailureSignal();
  const { resolvedTheme, setTheme } = useTheme();
  const [deferBackgroundQueries, setDeferBackgroundQueries] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setDeferBackgroundQueries(false), 1200);
    return () => window.clearTimeout(timer);
  }, []);
  const { data: publicInfo } = trpc.system.publicInfo.useQuery(undefined, {
    staleTime: SHELL_META_STALE_MS,
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: customSidebarPages = [] } = trpc.system.sidebarPages.useQuery(undefined, {
    staleTime: SHELL_META_STALE_MS,
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: pluginSidebarPages = [] } = trpc.plugins.sidebarPages.useQuery(undefined, {
    staleTime: SHELL_META_STALE_MS,
    enabled: isAdmin && publicInfo?.pluginsEnabled === true,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const updateAutoCheckReady = !isAdmin || !!publicInfo;
  const updateAutoCheckEnabled = publicInfo?.updateAutoCheckEnabled !== false;
  const { data: updateInfo } = trpc.system.checkUpdate.useQuery(undefined, {
    enabled: isAdmin && !deferBackgroundQueries && updateAutoCheckReady && updateAutoCheckEnabled,
    refetchInterval: updateAutoCheckEnabled ? UPDATE_AUTO_CHECK_REFETCH_MS : false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60 * 1000,
  });
  const { data: storeStatus } = trpc.plans.storeStatus.useQuery(undefined, {
    staleTime: SHELL_META_STALE_MS,
    enabled: !!user && !isAdmin,
    refetchOnWindowFocus: false,
    retry: false,
  });
  /**
   * 快到期的提示。
   *
   * 邮件和 Telegram 提醒都要先绑定，没绑的人在到期前收不到任何消息 —— 断了才
   * 发现，而那时续费还要走一遍支付。这条谁都看得见。
   */
  const { data: expiryNotice } = trpc.plans.myExpiryNotice.useQuery(undefined, {
    enabled: !!user && !isAdmin,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: SHELL_META_STALE_MS,
  });
  /**
   * 只在提醒档位覆盖到的天数里显示，跟邮件 / TG 用的是同一份配置 —— 三处各有
   * 一套阈值的话，用户会收到互相矛盾的说法。
   */
  const expiryDaysLeft = expiryNotice?.daysLeft ?? null;
  const expiryNoticeVisible = expiryDaysLeft !== null
    && expiryDaysLeft >= 0
    && expiryDaysLeft <= Math.max(0, ...(expiryNotice?.reminderDays || [7]));
  const { data: popupAnnouncement } = trpc.announcements.popup.useQuery(undefined, {
    staleTime: SHELL_META_STALE_MS,
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: upgradeAnnouncement, isFetched: upgradeAnnouncementFetched } = trpc.announcements.upgradePopup.useQuery(undefined, {
    staleTime: SHELL_META_STALE_MS,
    enabled: !!user && isAdmin,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: telegramStatus } = trpc.telegram.status.useQuery(undefined, {
    staleTime: SHELL_META_STALE_MS,
    enabled: !!user,
    refetchInterval: (query) => {
      const status = query.state.data;
      if (!status || status.bound) return false;
      const expiresAt = status.pendingBind?.expiresAt ? new Date(status.pendingBind.expiresAt).getTime() : 0;
      return expiresAt > Date.now() ? 2000 : false;
    },
    refetchOnWindowFocus: false,
    retry: false,
  });
  const sidebarMenuSettings = useMemo(
    () => normalizeSidebarMenuSettings(publicInfo?.sidebarMenu),
    [publicInfo?.sidebarMenu]
  );
  const siteTitle = resolveSiteTitle(publicInfo?.siteTitle);
  const [cachedSiteLogo, setCachedSiteLogo] = useState(() => readCachedSiteLogo());
  const defaultLogoSrc = resolvedTheme === "dark" ? "/logo-dark.png" : "/logo-light.png";
  const logoSrc = publicInfo?.siteLogoDataUrl || (publicInfo ? defaultLogoSrc : cachedSiteLogo);
  const [displayLogoSrc, setDisplayLogoSrc] = useState(logoSrc);
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoMark = logoLoadFailed ? (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
      <Zap className="h-4 w-4" />
    </div>
  ) : !displayLogoSrc ? (
    <span className="h-7 w-7 shrink-0" aria-hidden="true" />
  ) : (
    <img
      src={displayLogoSrc}
      alt={siteTitle}
      className="h-7 w-7 shrink-0 object-contain"
      onError={() => setLogoLoadFailed(true)}
    />
  );
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [showUpgradeAnnouncement, setShowUpgradeAnnouncement] = useState(false);
  const [upgradeAnnouncementCountdown, setUpgradeAnnouncementCountdown] = useState(UPGRADE_ANNOUNCEMENT_COUNTDOWN_SECONDS);
  const [showTelegramDialog, setShowTelegramDialog] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const {
    checking: checkingMobileUpdate,
    updateInfo: mobileUpdateInfo,
    check: handleMobileUpdateCheck,
  } = useMobileAppUpdateCheck(() => setShowMobileUpdateDialog(true));
  const [showMobileUpdateDialog, setShowMobileUpdateDialog] = useState(false);
  const upgradeRefreshTimerRef = useRef<number | null>(null);
  const upgradeRefreshIntervalRef = useRef<number | null>(null);
  const displayedUpgradeAnnouncementKeyRef = useRef("");
  const [upgradeRefreshScheduled, setUpgradeRefreshScheduled] = useState(false);
  const [upgradeRefreshCountdown, setUpgradeRefreshCountdown] = useState<number | null>(null);
  const [backgroundUpgrade, setBackgroundUpgrade] = useState<PanelUpgradeSession | null>(() => readPanelUpgradeSession());
  const [dismissedPanelUpgradeNoticeVersion, setDismissedPanelUpgradeNoticeVersion] = useState(() => readDismissedPanelUpgradeNoticeVersion());
  const [telegramBind, setTelegramBind] = useState<any | null>(null);
  const [telegramBindTick, setTelegramBindTick] = useState(Date.now());
  const [showTwoFactorDialog, setShowTwoFactorDialog] = useState(false);
  const [twoFactorSetup, setTwoFactorSetup] = useState<{ setupId: string; secret: string; otpauthUrl: string; expiresAt: Date; expiresInSeconds: number } | null>(null);
  const [twoFactorQrCode, setTwoFactorQrCode] = useState("");
  const [twoFactorSetupTick, setTwoFactorSetupTick] = useState(Date.now());
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  /*
    升级进行中的轮询要熬过面板重启和 iOS 锁屏：
    - 面板重启那几秒请求全失败，data 留着上一次的（react-query 出错不清 data），isError 用来把文案换成「等待恢复」；
    - iOS 锁屏 / 切走时定时器被冻住，回来靠 refetchOnWindowFocus 和下面的 visibilitychange / online 立刻拉一次；
    - refetchIntervalInBackground 让标签页在后台（桌面端切到别的标签）也继续轮询。
  */
  const upgradeStatusQuery = trpc.system.upgradeStatus.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: (query) => {
      const status = (query.state.data as any)?.job?.status;
      return status === "running" || backgroundUpgrade ? 2000 : false;
    },
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: (query) => (query.state.data as any)?.job?.status === "running" || !!backgroundUpgrade,
    retry: false,
  });
  const { data: upgradeStatus, refetch: refetchUpgradeStatus, isError: upgradeStatusUnreachable } = upgradeStatusQuery;
  const { mutate: acknowledgeUpgrade } = trpc.system.acknowledgeUpgrade.useMutation();
  const acknowledgedUpgradeRef = useRef(false);
  const upgradeRefreshDeadlineRef = useRef<number | null>(null);
  const upgradeRefreshMarkRef = useRef<() => void>(() => undefined);
  // 安排刷新那一刻的任务快照：服务端确认后会把任务清成 idle，页面刷新前还要接着显示「升级完成，用时…」。
  const completedUpgradeJobRef = useRef<{ job: NonNullable<typeof upgradeStatus>["job"]; elapsedMs: number | null } | null>(null);
  const [upgradeClock, setUpgradeClock] = useState(() => Date.now());

  const startUpgradeMutation = trpc.system.startUpgrade.useMutation({
    onSuccess: (data) => {
      const targetVersion = data?.targetVersion || upgradeTargetVersion || "";
      if (targetVersion) {
        const next: PanelUpgradeSession = { targetVersion, startedAt: Date.now(), mode: "upgrade" };
        setBackgroundUpgrade(next);
        try {
          window.sessionStorage.setItem(PANEL_UPGRADE_SESSION_KEY, JSON.stringify(next));
        } catch {
          // Session persistence is only used to keep the upgrade notice visible after a temporary reconnect.
        }
      }
      setShowUpgradeDialog(false);
      toast.success("升级任务已在后台执行");
      refetchUpgradeStatus();
    },
    onError: (error) => toast.error(error.message || "启动升级失败"),
  });

  const scheduleUpgradeRefresh = useCallback((jobKey = "") => {
    if (upgradeRefreshTimerRef.current !== null) return;
    clearPanelUpgradeSession();
    // 截止时刻跨页面记在 sessionStorage（上游 2.3.285）：换页接着数，同一个任务刷过一次就不再刷。
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { storage = null; }
    const deadline = resolvePanelUpgradeRefresh(storage, jobKey, Date.now());
    if (deadline === null) return;
    const reload = () => {
      markPanelUpgradeRefreshed(storage);
      window.location.reload();
    };
    // 倒计时按截止时刻算而不是每秒减一：iOS 把定时器冻住再放开时，直接跳到正确的剩余秒数；
    // 到点了定时器还没触发（被冻住那种），visibilitychange / 下一次轮询会看这个截止时刻直接刷新。
    upgradeRefreshDeadlineRef.current = deadline;
    upgradeRefreshMarkRef.current = () => markPanelUpgradeRefreshed(storage);
    setUpgradeRefreshScheduled(true);
    setUpgradeRefreshCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    upgradeRefreshIntervalRef.current = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setUpgradeRefreshCountdown(remaining);
      if (remaining <= 0) reload();
    }, 1000);
    upgradeRefreshTimerRef.current = window.setTimeout(() => {
      if (upgradeRefreshIntervalRef.current !== null) {
        window.clearInterval(upgradeRefreshIntervalRef.current);
        upgradeRefreshIntervalRef.current = null;
      }
      reload();
    }, Math.max(0, deadline - Date.now()));
  }, []);

  useEffect(() => {
    return () => {
      if (upgradeRefreshTimerRef.current !== null) {
        window.clearTimeout(upgradeRefreshTimerRef.current);
      }
      if (upgradeRefreshIntervalRef.current !== null) {
        window.clearInterval(upgradeRefreshIntervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!popupAnnouncement?.id || !user?.id) return;
    if (readSeenPopupAnnouncementIds(user.id).includes(Number(popupAnnouncement.id))) return;
    markPopupAnnouncementSeen(user.id, popupAnnouncement.id);
    setShowAnnouncement(true);
  }, [popupAnnouncement?.id, user?.id]);

  useEffect(() => {
    if (!isAdmin) {
      setShowUpgradeAnnouncement(false);
      displayedUpgradeAnnouncementKeyRef.current = "";
      clearUpgradeAnnouncementDisplaySession(user?.id);
      return;
    }
    const currentVersion = normalizePanelVersion(publicInfo?.version);
    const userId = user?.id;
    if (!userId || !currentVersion || !upgradeAnnouncementFetched) return;

    const seenVersion = readLastSeenUpgradeAnnouncementVersion(userId);
    if (seenVersion && comparePanelVersions(seenVersion, currentVersion) >= 0) {
      setShowUpgradeAnnouncement(false);
      clearUpgradeAnnouncementDisplaySession(userId);
      utils.announcements.upgradePopup.setData(undefined, undefined);
      return;
    }

    if (upgradeAnnouncement?.id) {
      const announcementKey = String(userId) + ":" + currentVersion + ":" + String(upgradeAnnouncement.id);
      if (displayedUpgradeAnnouncementKeyRef.current !== announcementKey) {
        displayedUpgradeAnnouncementKeyRef.current = announcementKey;
        const existingDisplay = readUpgradeAnnouncementDisplaySession(userId);
        const shownAt = existingDisplay?.key === announcementKey ? existingDisplay.shownAt : Date.now();
        if (existingDisplay?.key !== announcementKey) {
          writeUpgradeAnnouncementDisplaySession(userId, { key: announcementKey, shownAt });
        }
        const elapsedSeconds = Math.floor(Math.max(0, Date.now() - shownAt) / 1000);
        setUpgradeAnnouncementCountdown(Math.max(0, UPGRADE_ANNOUNCEMENT_COUNTDOWN_SECONDS - elapsedSeconds));
      }
      setShowUpgradeAnnouncement(true);
      return;
    }

    writeLastSeenUpgradeAnnouncementVersion(userId, currentVersion);
    clearUpgradeAnnouncementDisplaySession(userId);
  }, [isAdmin, publicInfo?.version, upgradeAnnouncement?.id, upgradeAnnouncementFetched, user?.id, utils.announcements.upgradePopup]);

  useEffect(() => {
    if (!showUpgradeAnnouncement) return;
    const timer = window.setInterval(() => {
      setUpgradeAnnouncementCountdown((value) => (value <= 1 ? 0 : value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [showUpgradeAnnouncement, upgradeAnnouncement?.id]);

  useEffect(() => {
    if (!publicInfo) return;
    const nextLogo = publicInfo.siteLogoDataUrl || "";
    setCachedSiteLogo(nextLogo);
    try {
      if (nextLogo) {
        window.localStorage.setItem(SITE_LOGO_CACHE_KEY, nextLogo);
      } else {
        window.localStorage.removeItem(SITE_LOGO_CACHE_KEY);
      }
    } catch {
      // Logo caching only prevents refresh flicker; it is safe to skip when storage is unavailable.
    }
  }, [publicInfo]);

  useEffect(() => {
    setLogoLoadFailed(false);
    if (!logoSrc) {
      setDisplayLogoSrc("");
      return;
    }
    if (logoSrc === displayLogoSrc) return;

    let disposed = false;
    const image = new window.Image();
    image.onload = () => {
      if (!disposed) setDisplayLogoSrc(logoSrc);
    };
    image.onerror = () => {
      if (!disposed && !displayLogoSrc) setLogoLoadFailed(true);
    };
    image.src = logoSrc;
    return () => {
      disposed = true;
    };
  }, [displayLogoSrc, logoSrc]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.title = siteTitle;
    }
    try {
      window.localStorage.setItem("forwardx.siteTitle", siteTitle);
    } catch {
      // Title caching only prevents refresh flicker; it is safe to skip when storage is unavailable.
    }
  }, [siteTitle]);

  useEffect(() => {
    if (upgradeStatus?.job?.status !== "running" || backgroundUpgrade) return;
    const targetVersion = upgradeStatus.job.targetVersion;
    if (!targetVersion) return;
    const next: PanelUpgradeSession = {
      targetVersion,
      startedAt: upgradeStatus.job.startedAt ? new Date(upgradeStatus.job.startedAt).getTime() : Date.now(),
      mode: upgradeStatus.job.mode === "rollback" ? "rollback" : "upgrade",
    };
    setBackgroundUpgrade(next);
    try {
      window.sessionStorage.setItem(PANEL_UPGRADE_SESSION_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  }, [backgroundUpgrade, upgradeStatus?.job?.mode, upgradeStatus?.job?.startedAt, upgradeStatus?.job?.status, upgradeStatus?.job?.targetVersion]);

  useEffect(() => {
    if (upgradeStatus?.job?.status !== "success") return;
    if (!completedUpgradeJobRef.current) {
      completedUpgradeJobRef.current = { job: upgradeStatus.job, elapsedMs: upgradeStatus.elapsedMs ?? null };
    }
    // 面板已经带着新版本重启回来：告诉服务端「看到了」，它才把状态清掉；不然刷新后又看到 success 再刷新，没完没了。
    if (upgradeStatus.restarted && !acknowledgedUpgradeRef.current) {
      acknowledgedUpgradeRef.current = true;
      acknowledgeUpgrade({ targetVersion: upgradeStatus.job.targetVersion || undefined });
    }
    scheduleUpgradeRefresh(panelUpgradeJobKey(upgradeStatus.job as any));
  }, [acknowledgeUpgrade, scheduleUpgradeRefresh, upgradeStatus?.elapsedMs, upgradeStatus?.job, upgradeStatus?.restarted]);

  useEffect(() => {
    if (!backgroundUpgrade?.targetVersion || !upgradeStatus?.currentVersion) return;
    if (upgradeStatus.job?.status === "running") return;

    if (Date.now() - backgroundUpgrade.startedAt > PANEL_UPGRADE_SESSION_TTL_MS) {
      clearPanelUpgradeSession();
      setBackgroundUpgrade(null);
      return;
    }

    const compareResult = comparePanelVersions(upgradeStatus.currentVersion, backgroundUpgrade.targetVersion);
    if (backgroundUpgrade.mode === "rollback") {
      if (compareResult > 0) return;
    } else if (compareResult < 0) {
      return;
    }

    clearPanelUpgradeSession();
    setBackgroundUpgrade(null);
    if (upgradeRefreshDeadlineRef.current !== null && Date.now() >= upgradeRefreshDeadlineRef.current) {
      // 倒计时早就该到了（定时器被 iOS 冻住），这次轮询回来直接刷新。
      upgradeRefreshMarkRef.current();
      window.location.reload();
      return;
    }
    scheduleUpgradeRefresh(`${backgroundUpgrade.mode}:${backgroundUpgrade.targetVersion}:${backgroundUpgrade.startedAt}`);
  }, [
    backgroundUpgrade?.startedAt,
    backgroundUpgrade?.mode,
    backgroundUpgrade?.targetVersion,
    scheduleUpgradeRefresh,
    upgradeStatus?.currentVersion,
    upgradeStatus?.job?.status,
  ]);

  const dismissAnnouncement = trpc.announcements.dismiss.useMutation({
    onMutate: () => {
      setShowAnnouncement(false);
      markPopupAnnouncementSeen(user?.id, popupAnnouncement?.id);
      utils.announcements.popup.setData(undefined, undefined);
    },
    onSuccess: () => {
      setShowAnnouncement(false);
      utils.announcements.popup.setData(undefined, undefined);
    },
    onError: (error) => {
      toast.error(error.message || "关闭公告失败");
    },
    onSettled: () => {
      utils.announcements.popup.invalidate();
    },
  });

  const dismissUpgradeAnnouncement = trpc.announcements.dismiss.useMutation({
    onMutate: () => {
      if (user?.id && publicInfo?.version) {
        writeLastSeenUpgradeAnnouncementVersion(user.id, publicInfo.version);
        clearUpgradeAnnouncementDisplaySession(user.id);
      }
      setShowUpgradeAnnouncement(false);
      setUpgradeAnnouncementCountdown(UPGRADE_ANNOUNCEMENT_COUNTDOWN_SECONDS);
      displayedUpgradeAnnouncementKeyRef.current = "";
      utils.announcements.upgradePopup.setData(undefined, undefined);
    },
    onSuccess: () => {
      setShowUpgradeAnnouncement(false);
      utils.announcements.upgradePopup.setData(undefined, undefined);
    },
    onError: (error) => {
      toast.error(error.message || "关闭升级公告失败");
    },
    onSettled: () => {
      utils.announcements.upgradePopup.invalidate();
    },
  });

  const handleLogout = useCallback(() => {
    clearSeenPopupAnnouncements(user?.id);
    logout();
  }, [logout, user?.id]);

  // Change password dialog state
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showAvatarDialog, setShowAvatarDialog] = useState(false);
  const [avatarDraft, setAvatarDraft] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const changePasswordMutation = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      toast.success("密码已修改");
      setShowChangePassword(false);
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (error) => {
      toast.error(error.message || "密码修改失败");
    },
  });

  const { data: avatarQuota } = trpc.users.avatarQuota.useQuery(undefined, {
    staleTime: SHELL_META_STALE_MS,
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { exhausted: avatarQuotaExhausted } = avatarQuotaState(avatarQuota, (user as any)?.role === "admin");

  const updateAvatarMutation = trpc.users.updateAvatar.useMutation({
    onSuccess: () => {
      utils.auth.me.invalidate();
      utils.users.avatarQuota.invalidate();
      toast.success("头像已更新");
      setShowAvatarDialog(false);
    },
    onError: (error) => toast.error(error.message || "头像更新失败"),
  });

  const openAvatarDialog = () => {
    setAvatarDraft(String((user as any)?.avatar || ""));
    setShowAvatarDialog(true);
    setAccountMenuOpen(false);
  };

  const handleSaveAvatar = () => {
    if (!avatarDraft) {
      toast.error("请选择头像");
      return;
    }
    /*
      这一条原来只有个人资料页有。侧边栏这条路让用户挑完裁完点了保存，才被
      服务端顶回来 —— 同一个功能，两个入口，一个提前说一个事后说。
    */
    if (avatarQuotaExhausted) {
      toast.error("今日头像修改次数已用完");
      return;
    }
    updateAvatarMutation.mutate({ avatar: avatarDraft });
  };

  const createTelegramBindMutation = trpc.telegram.createBindCode.useMutation({
    onSuccess: (data) => {
      setTelegramBind(data);
      setTelegramBindTick(Date.now());
      setShowTelegramDialog(true);
      utils.telegram.status.invalidate();
      toast.success("Telegram 绑定码已生成");
    },
    onError: (error) => toast.error(error.message || "生成 Telegram 绑定码失败"),
  });

  const unbindTelegramMutation = trpc.telegram.unbind.useMutation({
    onSuccess: () => {
      setTelegramBind(null);
      utils.telegram.status.invalidate();
      toast.success("Telegram 已解绑");
      setShowTelegramDialog(false);
    },
    onError: (error) => toast.error(error.message || "解绑 Telegram 失败"),
  });

  const handleChangePassword = () => {
    if (!oldPassword) {
      toast.error("请输入当前密码");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("新密码至少6个字符");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    changePasswordMutation.mutate({ oldPassword, newPassword });
  };

  const copyText = async (text: string) => {
    const copied = await copyTextToClipboard(text);
    if (copied) toast.success("已复制到剪贴板");
    else toast.error("复制失败，请长按或手动选中复制");
  };

  const openTelegramDialog = () => {
    if (telegramStatus?.bound) {
      setShowTelegramDialog(true);
      return;
    }
    if (telegramStatus?.configured === false) {
      setTelegramBind(null);
      setShowTelegramDialog(true);
      return;
    }
    createTelegramBindMutation.mutate();
  };

  const { data: twoFactorStatus } = trpc.auth.twoFactorStatus.useQuery(undefined, {
    staleTime: SHELL_META_STALE_MS,
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const beginTwoFactorSetupMutation = trpc.auth.beginTwoFactorSetup.useMutation({
    onSuccess: (data) => {
      setTwoFactorSetup(data);
      setTwoFactorQrCode("");
      setTwoFactorSetupTick(Date.now());
      setTwoFactorCode("");
      toast.success("双重验证二维码已生成");
    },
    onError: (error) => toast.error(error.message || "生成双重验证二维码失败"),
  });

  const enableTwoFactorMutation = trpc.auth.enableTwoFactor.useMutation({
    onSuccess: () => {
      toast.success("双重验证已启用");
      setTwoFactorSetup(null);
      setTwoFactorQrCode("");
      setTwoFactorPassword("");
      setTwoFactorCode("");
      utils.auth.twoFactorStatus.invalidate();
      utils.auth.me.invalidate();
    },
    onError: (error) => toast.error(authErrorMessage(error.message, "启用双重验证失败")),
  });

  const disableTwoFactorMutation = trpc.auth.disableTwoFactor.useMutation({
    onSuccess: () => {
      toast.success("双重验证已关闭");
      setTwoFactorPassword("");
      setTwoFactorCode("");
      utils.auth.twoFactorStatus.invalidate();
      utils.auth.me.invalidate();
    },
    onError: (error) => toast.error(authErrorMessage(error.message, "关闭双重验证失败")),
  });

  useEffect(() => {
    if (!twoFactorSetup?.otpauthUrl) {
      setTwoFactorQrCode("");
      return;
    }
    let cancelled = false;
    // 二维码库只在开双重验证时才用得上，不跟布局一起进入口包
    import("qrcode")
      .then(({ default: QRCode }) => QRCode.toDataURL(twoFactorSetup.otpauthUrl, {
        errorCorrectionLevel: "M",
        margin: 1,
        scale: 8,
        color: {
          dark: "#0f172aff",
          light: "#ffffffff",
        },
      }))
      .then((url) => {
        if (!cancelled) setTwoFactorQrCode(url);
      })
      .catch(() => {
        if (!cancelled) {
          setTwoFactorQrCode("");
          toast.error("二维码生成失败，请使用手动密钥添加");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [twoFactorSetup?.otpauthUrl]);

  useEffect(() => {
    if (!showTwoFactorDialog || twoFactorStatus?.enabled || !twoFactorSetup) return;
    const timer = window.setInterval(() => setTwoFactorSetupTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [showTwoFactorDialog, twoFactorSetup, twoFactorStatus?.enabled]);

  useEffect(() => {
    if (!telegramBind?.expiresAt) return;
    const timer = window.setInterval(() => setTelegramBindTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [telegramBind?.expiresAt]);

  const twoFactorSetupExpiresAt = twoFactorSetup?.expiresAt ? new Date(twoFactorSetup.expiresAt).getTime() : 0;
  const twoFactorSetupRemaining = twoFactorSetupExpiresAt ? Math.max(0, Math.ceil((twoFactorSetupExpiresAt - twoFactorSetupTick) / 1000)) : 0;
  const twoFactorSetupExpired = !!twoFactorSetup && twoFactorSetupRemaining <= 0;
  const twoFactorSetupRemainingLabel = `${Math.floor(twoFactorSetupRemaining / 60)}:${String(twoFactorSetupRemaining % 60).padStart(2, "0")}`;
  const telegramBindExpiresAt = telegramBind?.expiresAt ? new Date(telegramBind.expiresAt).getTime() : 0;
  const telegramBindRemaining = telegramBindExpiresAt ? Math.max(0, Math.ceil((telegramBindExpiresAt - telegramBindTick) / 1000)) : 0;
  const telegramBindExpired = !!telegramBind && telegramBindRemaining <= 0;
  const telegramBindRemainingLabel = `${Math.floor(telegramBindRemaining / 60)}:${String(telegramBindRemaining % 60).padStart(2, "0")}`;

  const openTwoFactorDialog = () => {
    setShowTwoFactorDialog(true);
    setTwoFactorPassword("");
    setTwoFactorCode("");
    setTwoFactorQrCode("");
    if (!twoFactorStatus?.enabled && twoFactorStatus?.globalEnabled) {
      beginTwoFactorSetupMutation.mutate();
    }
  };

  const handleEnableTwoFactor = () => {
    if (!twoFactorSetup) {
      beginTwoFactorSetupMutation.mutate();
      return;
    }
    if (twoFactorSetupExpired) {
      toast.error("二维码已过期，请重新生成");
      return;
    }
    if (!twoFactorPassword) {
      toast.error("请输入当前密码");
      return;
    }
    if (twoFactorCode.length < 6) {
      toast.error("请输入 6 位动态验证码");
      return;
    }
    enableTwoFactorMutation.mutate({
      setupId: twoFactorSetup.setupId,
      password: twoFactorPassword,
      code: twoFactorCode,
    });
  };

  const handleDisableTwoFactor = () => {
    if (!twoFactorPassword) {
      toast.error("请输入当前密码");
      return;
    }
    if (twoFactorCode.length < 6) {
      toast.error("请输入 6 位动态验证码");
      return;
    }
    disableTwoFactorMutation.mutate({
      password: twoFactorPassword,
      code: twoFactorCode,
    });
  };

  const openDetectedMobileRelease = () => {
    void openMobileReleasePage(mobileUpdateInfo?.releaseUrl);
    setShowMobileUpdateDialog(false);
  };

  const telegramBindUrl = telegramBind?.botUsername && telegramBind?.code
    ? `https://t.me/${telegramBind.botUsername}?start=${encodeURIComponent(telegramBind.code)}`
    : "";
  const telegramBotUrl = (telegramBind?.botUsername || telegramStatus?.botUsername)
    ? `https://t.me/${telegramBind?.botUsername || telegramStatus?.botUsername}`
    : "";
  const accountDisplayName = String(user?.name || "").trim() || String(user?.username || "").trim() || "账号";
  const accountUsername = String(user?.username || "").trim() || accountDisplayName;

  useEffect(() => {
    if (telegramStatus?.bound) {
      if (telegramBind) setTelegramBind(null);
      return;
    }
    if (!telegramBind && telegramStatus?.pendingBind?.code) {
      setTelegramBind(telegramStatus.pendingBind);
      setTelegramBindTick(Date.now());
    }
  }, [telegramBind, telegramStatus?.bound, telegramStatus?.pendingBind]);

  const toggleTheme = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  /*
    「主机管理」现在租户也能进：他能自助加机器，就得有个地方看这些机器的状况。
    那一页按角色收口（服务端只给他自己的机器，管理员专属的入口不渲染），
    所以不必再从侧边栏藏起来。链路管理仍然是管理员的。
  */
  const hiddenNormalUserMainPaths = ["/tunnels"];
  // 没有客户端订阅权限的用户不该在侧边栏看到这一项。管理员始终可见。
  const proxySubscriptionPermission = trpc.proxySubscriptions.permission.useQuery(undefined, {
    enabled: !isAdmin,
    staleTime: 60_000,
  });
  const canShowProxySubscription = isAdmin || proxySubscriptionPermission.data?.allowed === true;
  const isSidebarNavItemVisible = (item: SidebarNavItem) => {
    if (item.menuKey === "plugins" && publicInfo?.pluginsEnabled !== true) return false;
    if (item.menuKey === "referrals" && publicInfo?.referralEnabled !== true) return false;
    return !item.menuKey || sidebarMenuSettings[item.menuKey] !== false;
  };
  const filterSidebarNavItems = (items: SidebarNavItem[]) => items.filter(isSidebarNavItemVisible);
  const visibleMainMenuItems = filterSidebarNavItems(
    (isAdmin
      ? mainMenuItems
      : mainMenuItems.filter((item) => !hiddenNormalUserMainPaths.includes(item.path))
    ).filter((item) => (
      // 落地节点与客户端订阅是同一件事的两头，共用一个权限开关。
      item.path !== "/client-subscriptions" || canShowProxySubscription
    ))
  );
  const canShowNetworkTest = (isAdmin || publicInfo?.lookingGlassUserEnabled === true) && sidebarMenuSettings.lookingGlass !== false;
  const userStoreMenuItems: SidebarNavItem[] = !isAdmin
    ? [
        { icon: Package, label: "我的套餐", path: "/subscriptions" },
        { icon: ReceiptText, label: "账单中心", path: "/wallet" },
        ...(storeStatus?.enabled ? [{ icon: ShoppingBag, label: "商店", path: "/store" }] : []),
        // 工单总开关关了（publicInfo.ticketsEnabled）普通用户不显示；管理员的「工单管理」照常。
        ...(publicInfo?.ticketsEnabled !== false && isSidebarNavItemVisible(userTicketsMenuItem) ? [userTicketsMenuItem] : []),
      ]
    : [];
  // 管理员侧栏「工单管理」上的待处理数，一分钟问一次（只数一下，很便宜）。
  const { data: ticketCounts } = trpc.tickets.adminCounts.useQuery(undefined, {
    enabled: isAdmin && sidebarMenuSettings.tickets !== false,
    refetchInterval: ADMIN_TICKET_COUNTS_POLL_MS,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const waitingTicketCount = Number(ticketCounts?.waitingStaff || 0);
  const visibleAnnouncementsMenuItems = isSidebarNavItemVisible(announcementsMenuItem) ? [announcementsMenuItem] : [];
  const visibleProfileMenuItems = isSidebarNavItemVisible(profileMenuItem) ? [profileMenuItem] : [];
  const visibleReferralsMenuItems = isSidebarNavItemVisible(referralsMenuItem) ? [referralsMenuItem] : [];
  const visibleAdminMenuItems = filterSidebarNavItems(opsFeatures ? [insightsMenuItem, ...adminMenuItems] : adminMenuItems)
    .map((item) => (item.path === ADMIN_TICKETS_PATH && waitingTicketCount > 0 ? { ...item, badge: waitingTicketCount } : item));
  const customPageMenuItems: SidebarNavItem[] = customSidebarPages.map((page: {
    id: string;
    name: string;
    url: string;
    openMode: "embed" | "external";
    iconDataUrl?: string;
  }) => ({
    icon: Globe2,
    iconSrc: page.iconDataUrl,
    label: page.name,
    path: `/custom-pages/${page.id}`,
    ...(page.openMode === "external" ? { externalUrl: page.url } : {}),
  }));
  const pluginPageMenuItems: SidebarNavItem[] = isAdmin
    ? pluginSidebarPages.map((page: { pluginId: string; label: string; icon?: string; corePath?: string }) => ({
        icon: Puzzle,
        iconSrc: page.icon || undefined,
        label: page.label,
        // 功能写在核心里的插件（自动换 IP）：入口直接开核心页面
        path: page.corePath || `/plugins/sidebar/${page.pluginId}`,
      }))
    : [];
  const primaryMenuItems = [
    ...visibleMainMenuItems,
    ...userStoreMenuItems,
    ...visibleReferralsMenuItems,
    ...visibleAnnouncementsMenuItems,
  ];
  const otherMenuItems: SidebarNavItem[] = [
    ...(isAdmin && isSidebarNavItemVisible(pluginManagementMenuItem) ? [pluginManagementMenuItem] : []),
    ...pluginPageMenuItems,
    ...customPageMenuItems,
  ];

  const allMenuItems = isAdmin
    ? [...primaryMenuItems, ...visibleProfileMenuItems, ...visibleAdminMenuItems, ...otherMenuItems]
    : [...primaryMenuItems, ...(canShowNetworkTest ? [lookingGlassMenuItem] : []), ...visibleProfileMenuItems, ...otherMenuItems];

  const currentPath = location.split("?")[0] || "/";
  const activeMenuItem = allMenuItems.find((item) => item.path === currentPath);
  const upgradeJob = upgradeStatus?.job;
  const displayUpgradeJob = useMemo(() => {
    if (upgradeRefreshScheduled) {
      const completed = completedUpgradeJobRef.current?.job;
      return {
        status: "success",
        startedAt: completed?.startedAt || upgradeJob?.startedAt || (backgroundUpgrade?.startedAt ? new Date(backgroundUpgrade.startedAt).toISOString() : null),
        finishedAt: completed?.finishedAt || upgradeJob?.finishedAt || new Date().toISOString(),
        targetVersion: completed?.targetVersion || upgradeJob?.targetVersion || backgroundUpgrade?.targetVersion || upgradeStatus?.currentVersion || "",
        logs: completed?.logs || upgradeJob?.logs || ["[NEX] Upgrade completed; browser refresh scheduled"],
        error: null,
        mode: completed?.mode || upgradeJob?.mode || backgroundUpgrade?.mode || "upgrade",
        restarted: completed?.restarted ?? upgradeJob?.restarted ?? false,
        restartedAt: completed?.restartedAt ?? upgradeJob?.restartedAt ?? null,
      };
    }
    if (upgradeJob?.status && upgradeJob.status !== "idle") return upgradeJob;
    if (!backgroundUpgrade) return upgradeJob;
    return {
      status: "running",
      startedAt: new Date(backgroundUpgrade.startedAt).toISOString(),
      finishedAt: null,
      targetVersion: backgroundUpgrade.targetVersion,
      logs: ["[NEX] Starting upgrade in background"],
      error: null,
      mode: backgroundUpgrade.mode || "upgrade",
    };
  }, [backgroundUpgrade, upgradeJob, upgradeRefreshScheduled, upgradeStatus?.currentVersion]);
  const isUpgradeJobRunning = displayUpgradeJob?.status === "running";
  const upgradeProgress = getPanelUpgradeProgress(displayUpgradeJob, {
    now: upgradeClock,
    // 跑着的时候按本地时钟每秒走；结束了用服务端定格的用时（安排刷新后任务可能已经被清掉，用快照里的）。
    elapsedMs: isUpgradeJobRunning ? null : (completedUpgradeJobRef.current?.elapsedMs ?? upgradeStatus?.elapsedMs ?? null),
    disconnected: isUpgradeJobRunning && upgradeStatusUnreachable,
  });
  useEffect(() => {
    if (!isUpgradeJobRunning) return;
    setUpgradeClock(Date.now());
    const timer = window.setInterval(() => setUpgradeClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isUpgradeJobRunning]);
  useEffect(() => {
    if (!isAdmin || (!isUpgradeJobRunning && !upgradeRefreshScheduled)) return;
    // 手机锁屏 / 切走再回来：定时器可能一直没跑，回来先看该不该直接刷新，否则立刻拉一次状态。
    const wake = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const deadline = upgradeRefreshDeadlineRef.current;
      if (deadline !== null && Date.now() >= deadline) {
        upgradeRefreshMarkRef.current();
        window.location.reload();
        return;
      }
      void refetchUpgradeStatus();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
    };
  }, [isAdmin, isUpgradeJobRunning, refetchUpgradeStatus, upgradeRefreshScheduled]);
  const isPanelVersionTaskVisible = !!displayUpgradeJob?.status && displayUpgradeJob.status !== "idle";
  const isPanelRollbackTask = displayUpgradeJob?.mode === "rollback";
  const panelVersionActionLabel = isPanelRollbackTask ? "回退" : "升级";
  const upgradeTargetVersion = isPanelVersionTaskVisible
    ? (displayUpgradeJob?.targetVersion || "")
    : (updateInfo?.latestVersion || upgradeStatus?.update?.latestVersion || "");
  const normalizedUpgradeTargetVersion = normalizePanelVersion(upgradeTargetVersion);
  const isPanelUpdateNoticeDismissed = !!normalizedUpgradeTargetVersion && dismissedPanelUpgradeNoticeVersion === normalizedUpgradeTargetVersion;
  const isDockerDeployment = !!upgradeStatus?.docker;
  const dockerUpgradeCommand = upgradeStatus?.manualUpgradeCommand || buildPanelInstallerCommand({
    deployment: "docker",
    action: "upgrade",
    accelerator: upgradeStatus?.githubAccelerator?.panelUpdateEnabled
      ? upgradeStatus.githubAccelerator
      : null,
  });
  const upgradeRefreshText = upgradeRefreshCountdown !== null
    ? (upgradeRefreshCountdown > 0 ? `${upgradeRefreshCountdown} 秒后自动刷新` : "正在刷新页面")
    : "系统恢复后将自动刷新";
  const hasPanelUpdate = isAdmin && !!updateInfo?.hasUpdate && !!upgradeTargetVersion;
  const showUpgradeNotice = isAdmin && (
    (hasPanelUpdate && !isPanelUpdateNoticeDismissed) ||
    displayUpgradeJob?.status === "running" ||
    displayUpgradeJob?.status === "success" ||
    displayUpgradeJob?.status === "waiting_assets" ||
    displayUpgradeJob?.status === "error"
  );
  const canDismissPanelUpdateNotice = hasPanelUpdate && !isPanelVersionTaskVisible && !!normalizedUpgradeTargetVersion;
  const dismissPanelUpdateNotice = () => {
    if (!canDismissPanelUpdateNotice) return;
    setDismissedPanelUpgradeNoticeVersion(normalizedUpgradeTargetVersion);
    try {
      window.localStorage.setItem(PANEL_UPGRADE_NOTICE_DISMISSED_KEY, normalizedUpgradeTargetVersion);
    } catch {
      // Local dismissal only affects the sidebar notice.
    }
    setShowUpgradeDialog(false);
    toast.success(`v${normalizedUpgradeTargetVersion} 不再在左下角提醒`);
  };
  const managementMenuItems: SidebarNavItem[] = isAdmin
    ? [...visibleProfileMenuItems, ...visibleAdminMenuItems]
    : [...(canShowNetworkTest ? [lookingGlassMenuItem] : []), ...visibleProfileMenuItems];
  /*
    个人资料、系统设置在右上角账户菜单里已经各有一项，侧栏不再重复放（命令面板里照旧能搜到）。
    管理与账户那一组少两行，普通用户的「工具与账户」常常就只剩网络测试 / 邀请返利。
  */
  const SIDEBAR_DEDUPED_PATHS = ["/profile", "/settings"];
  const sidebarManagementItems = managementMenuItems.filter((item) => !SIDEBAR_DEDUPED_PATHS.includes(item.path));
  const commandItems: WorkspaceDestination[] = [
    ...primaryMenuItems.map(item => ({ ...item, group: "工作空间" })),
    ...managementMenuItems.map(item => ({ ...item, group: isAdmin ? "管理与账户" : "工具与账户" })),
    ...otherMenuItems.map(item => ({ ...item, group: "扩展" })),
  ];
  /*
    ── 手机端底部标签栏 ──────────────────────────────────────────

    上一版手机端是「汉堡 → 抽屉」，而抽屉的问题不是不好看，是**它把常用的和
    罕用的放在同一个深度**：去「转发规则」和去「支付对接」都是点汉堡、找一行、
    点一下。实际使用里前者一天几十次，后者一个月一次。

    标签栏摊开最常去的四格，剩下的收进「更多」。优先级表写在这里而不是写死在
    组件里，因为它要和权限过滤后的结果求交集 —— 一个只有转发权限的租户不该
    拿到一个点进去 403 的「主机」格。
  */
  const tabBarPlan = pickTabBarItems({
    destinations: commandItems,
    preferred: ["/", "/rules", "/hosts", "/tunnels", "/client-subscriptions"],
    /*
      标签栏一格 78px、字号 10px，「转发规则」四个汉字挤进去要么截断要么
      糊成一团。侧边栏保持全名（那里有横向空间，也要和别的「…管理」区分），
      标签栏用短名 —— iOS 自己的标签也全是两个词以内。
    */
    shortLabels: {
      "/rules": "转发",
      "/hosts": "主机",
      "/tunnels": "链路",
      "/client-subscriptions": "订阅",
    },
    more: { path: MORE_TAB_PATH, label: "更多", icon: Ellipsis },
  });

  /*
    空闲时把标签栏 / 侧栏上最常去的几页先拉下来。手机上换页的那一下转圈，就是
    在等这几个包 —— 提前取好之后，点过去是同步换页。首屏的数据请求先走，这个
    排在浏览器空闲之后。
  */
  /*
    只取这个角色走得进去的页：租户的导航里没有「链路管理」（App.tsx 用 AdminRoute 守着），
    就不替他下那一页的包。拼成一个字符串当依赖 —— 标签栏每次渲染都会重算出一个新数组，
    拿数组当依赖的话每渲染一次就取消、重排一次空闲回调，数据一轮询预取就永远排不上。
  */
  const prefetchKey = useMemo(() => {
    const reachable = new Set(commandItems.map((item) => item.path));
    const extras = ["/rules", "/hosts", "/tunnels"].filter((path) => reachable.has(path));
    return Array.from(new Set([...tabBarPlan.tabs.map((tab) => tab.path), ...extras])).join("\n");
  }, [commandItems, tabBarPlan.tabs]);
  useEffect(() => prefetchRoutesWhenIdle(prefetchKey.split("\n").filter(Boolean)), [prefetchKey]);

  const closeMobileNavigation = () => {
    if (isMobile) {
      setAccountMenuOpen(false);
      setOpenMobile(false);
    }
  };
  const navigateFromSidebar = (path: string) => {
    closeMobileNavigation();
    if (path === currentPath) return;
    // 先把那一页的代码取到手再换页（最多等 250ms），换页时就不用先转一圈
    navigateAfterPrefetch(path, () => setLocation(path));
  };
  const navigateToDestination = (item: WorkspaceDestination) => {
    if (item.externalUrl) {
      closeMobileNavigation();
      window.open(item.externalUrl, "_blank", "noopener,noreferrer");
    } else navigateFromSidebar(item.path);
  };

  const mobileNavValue = {
    overflow: tabBarPlan.overflow as MobileNavEntry[],
    currentPath,
    navigate: navigateToDestination,
    account: {
      name: accountDisplayName,
      detail: `${isAdmin ? "管理员" : "普通用户"} · ${accountUsername}`,
      avatar: <UserAvatar user={user as any} className="h-7 w-7 shrink-0" />,
    },
    theme: { isDark: resolvedTheme === "dark", toggle: toggleTheme },
    onLogout: handleLogout,
    onOpenSearch: () => setCommandOpen(true),
  };

  const navigateFromAccountMenu = (path: string) => {
    setAccountMenuOpen(false);
    window.requestAnimationFrame(() => navigateFromSidebar(path));
  };
  const openPanelUpdateFromAccountMenu = async () => {
    if (!isAdmin) return;
    setAccountMenuOpen(false);
    if (
      hasPanelUpdate ||
      displayUpgradeJob?.status === "running" ||
      displayUpgradeJob?.status === "success" ||
      displayUpgradeJob?.status === "waiting_assets" ||
      displayUpgradeJob?.status === "error"
    ) {
      setShowUpgradeDialog(true);
      refetchUpgradeStatus();
      return;
    }
    try {
      const latestInfo = await utils.system.checkUpdate.fetch({ force: true });
      await refetchUpgradeStatus();
      if (latestInfo?.hasUpdate) {
        setShowUpgradeDialog(true);
      } else {
        toast.success("当前已是最新版本");
      }
    } catch (error: any) {
      toast.error(error?.message || "检查更新失败");
    }
  };
  const renderSidebarItems = (items: SidebarNavItem[]) => items.map((item) => {
    const isActive = currentPath === item.path;
    const handleClick = () => {
      if (!item.externalUrl) {
        navigateFromSidebar(item.path);
        return;
      }
      closeMobileNavigation();
      window.open(item.externalUrl, "_blank", "noopener,noreferrer");
    };
    return (
      <SidebarMenuItem key={item.path}>
        <SidebarMenuButton
          isActive={isActive}
          onClick={handleClick}
          onPointerEnter={() => { if (!item.externalUrl) void prefetchRoute(item.path); }}
          tooltip={item.label}
          className={cn("h-8 transition-[width,height,padding,background-color,color,box-shadow] font-normal mobile-sidebar-menu-button", isDesktopCollapsed && "justify-center", mobileAuth.isNative && "text-[13px]")}
        >
          {item.iconSrc ? (
            <img
              src={item.iconSrc}
              alt=""
              className={cn("sidebar-nav-icon h-4 w-4 shrink-0 rounded-[3px] object-contain", isDesktopCollapsed && "h-[18px] w-[18px]")}
            />
          ) : (
            <item.icon className={cn("sidebar-nav-icon h-4 w-4", isDesktopCollapsed && "h-[18px] w-[18px]")} />
          )}
          <span className={cn(isDesktopCollapsed && "sr-only")}>{item.label}</span>
          {item.badge ? (
            isDesktopCollapsed ? (
              <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[var(--fx-down)]" aria-label={`${item.badge} 张待处理`} />
            ) : (
              <span
                className="ml-auto min-w-[1.25rem] rounded-full bg-[var(--fx-down-soft)] px-1.5 text-center text-[11px] font-medium leading-5 text-[var(--fx-down-text)]"
                aria-label={`${item.badge} 张待处理`}
              >
                {item.badge > 99 ? "99+" : item.badge}
              </span>
            )
          ) : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  });

  useEffect(() => {
    openMobileRef.current = openMobile;
  }, [openMobile]);

  useEffect(() => {
    accountMenuOpenRef.current = accountMenuOpen;
  }, [accountMenuOpen]);

  useEffect(() => { commandOpenRef.current = commandOpen; }, [commandOpen]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k" || event.isComposing) return;
      // Do not cover a form or confirmation that is already open.
      if (!commandOpenRef.current && document.querySelector('[role="dialog"][data-state="open"]:not([data-mobile-sidebar])')) return;
      event.preventDefault();
      setOpenMobile(false);
      setCommandOpen(value => !value);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [setOpenMobile]);

  useEffect(() => {
    if (isMobile && !openMobile) setAccountMenuOpen(false);
  }, [isMobile, openMobile]);

  useEffect(() => {
    if (!mobileAuth.isNative || !isMobile) return;
    let disposed = false;
    let removeListener: (() => void) | undefined;
    CapacitorApp.addListener("backButton", (event) => {
      if (commandOpenRef.current) { setCommandOpen(false); return; }
      if (accountMenuOpenRef.current || openMobileRef.current) {
        setAccountMenuOpen(false);
        setOpenMobile(false);
        return;
      }
      if (event.canGoBack) {
        window.history.back();
        return;
      }
      void CapacitorApp.minimizeApp();
    })
      .then((handle) => {
        if (disposed) {
          handle.remove();
          return;
        }
        removeListener = () => handle.remove();
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [isMobile, setOpenMobile]);

  const pearl = uiTheme === "pearl";
  const appbarSearchButton = (
            <button
              type="button"
              className="workspace-appbar-search"
              onClick={() => { closeMobileNavigation(); setCommandOpen(true); }}
              aria-label="查找功能"
              title="查找功能（Ctrl / ⌘ K）"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              <span className="workspace-appbar-search-label">搜索</span>
              <kbd className="workspace-appbar-kbd">⌘K</kbd>
            </button>
  );
  /* 顶栏的深浅色按钮：用户要顶栏 UI 不变（2026-10-21），不并进调色盘菜单 */
  const appbarThemeButton = (
            <button
              type="button"
              onClick={toggleTheme}
              className="workspace-appbar-icon"
              aria-label={resolvedTheme === "dark" ? "切换浅色主题" : "切换深色主题"}
              title={resolvedTheme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
            >
              {resolvedTheme === "dark" ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
            </button>
  );
  const accountMenuContent = (
            <DropdownMenuContent align="end" className="w-56">
              <div className="px-2 py-1.5">
                <div className="flex items-start gap-2">
                  <UserAvatar user={user as any} className="h-8 w-8 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{accountDisplayName}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{isAdmin ? "管理员" : "普通用户"} · {accountUsername}</p>
                  </div>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => navigateFromAccountMenu("/profile")}
                className="cursor-pointer"
              >
                <UserRound />
                <span>个人资料</span>
              </DropdownMenuItem>
              {!mobileAuth.isNative && isAdmin && (
                <DropdownMenuItem
                  onClick={openPanelUpdateFromAccountMenu}
                  className="cursor-pointer"
                >
                  <Download />
                  <span>软件更新</span>
                </DropdownMenuItem>
              )}
              {mobileAuth.isNative && (
                <DropdownMenuItem
                  onClick={handleMobileUpdateCheck}
                  disabled={checkingMobileUpdate}
                  className="cursor-pointer"
                >
                  {checkingMobileUpdate ? (
                    <RefreshCw className="forwardx-icon-spin" />
                  ) : (
                    <Download />
                  )}
                  <span>{checkingMobileUpdate ? "检查中..." : "软件更新"}</span>
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  onClick={() => navigateFromAccountMenu("/settings")}
                  className="cursor-pointer"
                >
                  <Settings />
                  <span>系统设置</span>
                </DropdownMenuItem>
              )}
              {/*
                精简布局一键切：记成这个账号的偏好（个人资料 › 界面 里的同一个值）。
                菜单不关，点完当场看到界面换过去；想回到「跟随站点」去个人资料里选。
              */}
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  void layoutPreference.setPreference(compactLayout ? "standard" : "compact");
                }}
                disabled={layoutPreference.saving}
                className="cursor-pointer"
                aria-checked={compactLayout}
                role="menuitemcheckbox"
              >
                <Rows3 />
                <span>精简布局</span>
                {compactLayout ? <Check className="ml-auto h-4 w-4 text-primary" aria-hidden="true" /> : null}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleLogout}
                variant="destructive"
              >
                <LogOut />
                <span>退出登录</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
  );
  const pearlPageLabel = activeMenuItem?.label ?? siteTitle;
  const pearlAccountRole = `${isAdmin ? "管理员" : "用户"} · ${telegramStatus?.bound ? "TG 已绑定" : "TG 未绑定"}`;
  const pearlAppbar = pearl ? (
      <header className="workspace-appbar fx-pearl-topbar" data-mobile={isMobile ? "" : undefined}>
        <div className="workspace-appbar-inner">
          {isMobile ? (
            <>
              <button type="button" onClick={toggleSidebar} className="workspace-appbar-icon fx-pearl-drawer-trigger" aria-label="打开导航" aria-expanded={openMobile}>
                <PanelLeft className="h-5 w-5" aria-hidden="true" />
              </button>
              <span className="fx-pearl-topbar-title">{pearlPageLabel}</span>
            </>
          ) : (
            <nav className="fx-pearl-crumb" aria-label="当前位置">
              <span className="fx-pearl-crumb-site">{siteTitle}</span>
              <span className="fx-pearl-crumb-sep" aria-hidden="true">/</span>
              <span className="fx-pearl-crumb-page">{pearlPageLabel}</span>
            </nav>
          )}
          <div className="workspace-appbar-actions">
            {appbarSearchButton}
            {appbarThemeButton}
            <UiThemeQuickSwitch />
            {!isMobile ? <span className="fx-pearl-topbar-user" title={accountDisplayName}>{accountDisplayName}</span> : null}
          </div>
        </div>
      </header>
  ) : null;

  return (
    <>
      {/*
        ── 顶栏 ──────────────────────────────────────────────────

        照参考站（New API / Vexo）的外壳：一条 48px 的顶栏横贯整个宽度，品牌在左，
        搜索、主题、账户在右；侧栏从顶栏下面开始，只放导航。上一版把品牌、主题开关、
        折叠键塞在侧栏头上、账户塞在侧栏脚下 —— 侧栏一列要干四件事，而参考站的侧栏
        只干一件：导航。

        手机上顶栏也在（品牌 + 搜索 + 账户），导航仍交给底部标签栏。
      */}
      {pearl ? null : (
      <header className="workspace-appbar">
        <div className="workspace-appbar-inner">
          {!isMobile ? (
            <button
              type="button"
              onClick={toggleSidebar}
              className="workspace-appbar-icon"
              aria-label={isDesktopCollapsed ? "展开导航" : "收起导航"}
            >
              <PanelLeft className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" className="workspace-appbar-brand" onClick={() => navigateFromSidebar("/")} title={siteTitle}>
            {logoMark}
            <span className="workspace-appbar-title">{siteTitle}</span>
            {publicInfo?.version ? <span className="workspace-appbar-version">v{String(publicInfo.version).replace(/^v/i, "")}</span> : null}
          </button>
          <div className="workspace-appbar-actions">
            {appbarSearchButton}
            {appbarThemeButton}
            <UiThemeQuickSwitch />
          <DropdownMenu open={accountMenuOpen} onOpenChange={setAccountMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="workspace-appbar-account"
                title={accountDisplayName}
                aria-label={`账户：${accountDisplayName}`}
              >
                <UserAvatar user={user as any} className="h-7 w-7 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            {accountMenuContent}
          </DropdownMenu>
          </div>
        </div>
      </header>
      )}
      {/*
        「珍珠」主题（theme-pearl.css）照上游 Forwardx 的 Pearl 外壳：桌面上顶栏在侧栏右边（左边一条
        「站点 / 页面」面包屑，右边搜索、深浅色、调色盘、一段用户名），品牌和折叠键挪到侧栏头上，
        账户挪到侧栏脚下一张用户卡；手机上是一条「抽屉键 + 页面名」的顶栏，导航走抽屉，不要底部标签栏。
        只在珍珠下渲染，别的主题这里一个节点都不多。
      */}
      {pearl && isMobile ? pearlAppbar : null}

      <div className="workspace-body">
      {/*
        侧栏是一列白纸，靠右侧一条细线和页面分开（参考站同款）。它从顶栏下面开始，
        只放导航：品牌、搜索、主题、账户都在顶栏上。
      */}
      <Sidebar collapsible="icon" className="workspace-sidebar">
        {pearl ? (
          <SidebarHeader className="fx-pearl-sidebar-header">
            {isDesktopCollapsed ? (
              <button type="button" onClick={toggleSidebar} className="fx-pearl-sidebar-logo-button" aria-label="展开导航" title={siteTitle}>
                {logoMark}
              </button>
            ) : (
              <>
                <button type="button" className="fx-pearl-sidebar-brand" onClick={() => navigateFromSidebar("/")} title={siteTitle}>
                  {logoMark}
                  <span className="fx-pearl-sidebar-title">{siteTitle}</span>
                </button>
                {!isMobile ? (
                  <button type="button" onClick={toggleSidebar} className="fx-pearl-sidebar-toggle" aria-label="收起导航">
                    <PanelLeft className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </>
            )}
          </SidebarHeader>
        ) : null}
        <SidebarContent ref={sidebarContentRef} className="gap-1 pb-2 mobile-sidebar-content">
          <PearlNavMarker collapsed={isDesktopCollapsed || isMobile} />
          {primaryMenuItems.length > 0 && (
            <SidebarGroup className={cn("pb-2 mobile-sidebar-group", mobileAuth.isNative && "pb-1.5")}>
              <SidebarGroupLabel className="text-xs text-muted-foreground uppercase tracking-wider">
                工作空间
              </SidebarGroupLabel>
              <SidebarMenu className={cn("py-1 mobile-sidebar-menu", isDesktopCollapsed ? "items-center px-0" : "px-2")}>
                {renderSidebarItems(primaryMenuItems)}
              </SidebarMenu>
            </SidebarGroup>
          )}

          {sidebarManagementItems.length > 0 && (
            <SidebarGroup className={cn("mt-1 shrink-0 pt-2 mobile-sidebar-group mobile-sidebar-admin-group", !mobileAuth.isNative && "border-t border-sidebar-border/50", mobileAuth.isNative && "mt-0 pt-2 border-t border-sidebar-border/50")}>
              <SidebarGroupLabel className="text-xs text-muted-foreground uppercase tracking-wider">
                {isAdmin ? "管理与账户" : "工具与账户"}
              </SidebarGroupLabel>
              <SidebarMenu className={cn("py-1 mobile-sidebar-menu", isDesktopCollapsed ? "items-center px-0" : "px-2")}>
                {renderSidebarItems(sidebarManagementItems)}
              </SidebarMenu>
            </SidebarGroup>
          )}

          {otherMenuItems.length > 0 && (
            <SidebarGroup className={cn("mt-1 shrink-0 pt-2 mobile-sidebar-group mobile-sidebar-admin-group", !mobileAuth.isNative && "border-t border-sidebar-border/50", mobileAuth.isNative && "mt-0 pt-2 border-t border-sidebar-border/50")}>
              <SidebarGroupLabel className="text-xs text-muted-foreground uppercase tracking-wider">
                扩展
              </SidebarGroupLabel>
              <SidebarMenu className={cn("py-1 mobile-sidebar-menu", isDesktopCollapsed ? "items-center px-0" : "px-2")}>
                {renderSidebarItems(otherMenuItems)}
              </SidebarMenu>
            </SidebarGroup>
          )}

        </SidebarContent>

        <SidebarFooter className={cn("mobile-sidebar-footer", isDesktopCollapsed ? "items-center p-1.5" : "p-3")}>
          {showUpgradeNotice && (
            <button
              type="button"
              onClick={() => {
                setShowUpgradeDialog(true);
                refetchUpgradeStatus();
              }}
              className="w-full rounded-lg border border-primary/20 bg-primary/10 px-3 py-2.5 text-left text-primary shadow-sm transition-colors hover:bg-primary/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:h-9 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0"
              title={
                displayUpgradeJob?.status === "running"
                  ? upgradeProgress.label
                  : displayUpgradeJob?.status === "success"
                    ? upgradeRefreshText
                    : displayUpgradeJob?.status === "waiting_assets"
                      ? "发布资产构建中"
                    : displayUpgradeJob?.status === "error"
                      ? `${panelVersionActionLabel}失败`
                      : `发现新版本 ${upgradeTargetVersion}`
              }
            >
              <div className="flex items-center gap-2">
                {displayUpgradeJob?.status === "running" ? (
                  <Loader2 className="forwardx-icon-spin h-4 w-4 shrink-0" />
                ) : displayUpgradeJob?.status === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--fx-healthy-text)]" />
                ) : displayUpgradeJob?.status === "waiting_assets" ? (
                  <RefreshCw className="h-4 w-4 shrink-0 text-[var(--fx-warn-text)]" />
                ) : displayUpgradeJob?.status === "error" ? (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                ) : (
                  <Rocket className="h-4 w-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-xs font-semibold">
                    {displayUpgradeJob?.status === "running"
                      ? `正在${panelVersionActionLabel}`
                      : displayUpgradeJob?.status === "success"
                        ? (displayUpgradeJob.restarted ? upgradeProgress.label : `${panelVersionActionLabel}完成，正在重启`)
                        : displayUpgradeJob?.status === "waiting_assets"
                          ? "发布资产构建中"
                        : displayUpgradeJob?.status === "error"
                          ? `${panelVersionActionLabel}失败`
                          : "发现新版本"}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-primary/75">
                    {displayUpgradeJob?.status === "running"
                      ? upgradeProgress.label
                      : displayUpgradeJob?.status === "success"
                        ? upgradeRefreshText
                        : displayUpgradeJob?.status === "waiting_assets"
                          ? (displayUpgradeJob.error || "请稍后重新检查更新")
                        : displayUpgradeJob?.status === "error"
                          ? (displayUpgradeJob.error || "点击查看详情")
                          : `可升级到 ${upgradeTargetVersion}`}
                  </p>
                  {displayUpgradeJob?.status === "running" && upgradeProgress.detail && (
                    <p className="mt-0.5 truncate text-[10px] tabular-nums text-primary/60">{upgradeProgress.detail}</p>
                  )}
                  {(displayUpgradeJob?.status === "running" || displayUpgradeJob?.status === "waiting_assets") && (
                    <div className="mt-2 space-y-2">
                      <Progress value={upgradeProgress.percent} className="h-1" />
                      <div className="space-y-1">
                        {upgradeProgress.steps.map((step) => (
                          <div key={step.label} className="flex min-w-0 items-center gap-1.5 text-[10px] leading-4 text-primary/75">
                            {step.done ? (
                              <CheckCircle2 className="h-3 w-3 shrink-0 text-[var(--fx-healthy-text)]" />
                            ) : step.active ? (
                              <Loader2 className="forwardx-icon-spin h-3 w-3 shrink-0" />
                            ) : (
                              <span className="h-3 w-3 shrink-0 rounded-full border border-primary/25" />
                            )}
                            <span className="truncate">{step.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </button>
          )}
          {pearl ? (
            <DropdownMenu open={accountMenuOpen} onOpenChange={setAccountMenuOpen} modal={false}>
              <DropdownMenuTrigger asChild>
                <button type="button" className="fx-pearl-user-card" title={accountDisplayName} aria-label={`账户：${accountDisplayName}`}>
                  <UserAvatar user={user as any} className="fx-pearl-user-avatar shrink-0" />
                  <span className="fx-pearl-user-text">
                    <span className="fx-pearl-user-name">{accountDisplayName}</span>
                    <span className="fx-pearl-user-role">{pearlAccountRole}</span>
                  </span>
                </button>
              </DropdownMenuTrigger>
              {accountMenuContent}
            </DropdownMenu>
          ) : null}
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="workspace-inset workspace-with-mobile-nav">
        <a className="workspace-skip-link" href="#workspace-content">跳到主要内容</a>
        {pearl && !isMobile ? pearlAppbar : null}
        {/*
          手机端不再有这条常驻顶栏。

          它同时干四件事：写页面名、挂主操作、放搜索、放主题开关 —— 而这四件事
          在 iOS 上分属三个地方：页面名是页面自己的大标题（滚动时才收进顶栏），
          主操作跟着大标题走，搜索和主题在「更多」里。常驻一条 56px 的栏去放
          这些，等于每一页都先扣掉一条规则的高度。

          页面名由各页的 WorkspaceHeader 画，见那个组件。
        */}
        <main id="workspace-content" tabIndex={-1} data-mobile-main="true" className={cn("workspace-main flex-1 px-3 pb-4 pt-3 sm:px-6 sm:pb-6 sm:pt-5 lg:px-8", isMobile && tabBarPlan.tabs.length && !pearl ? "workspace-has-tabbar" : null, isMobile ? "workspace-has-iosnav" : null)}>
          {/*
            兜底的「没读到」提示。
            各个列表自己会画失败态，但一页上挂着十几个查询，不可能每个都单独接一遍；
            面板重启或者网络抖动时好几个会一起失败。这条横幅让人知道「现在看到的不完整」，
            而不是把空白当成事实。只在持续失败几秒后才出现，免得轮询抖一下就闪。
          */}
          {queryFailure.visible ? (
            <div className="mb-4 flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0">{queryFailureBannerText(queryFailure.failureCount)}</p>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" variant="outline" onClick={queryFailure.retry}>
                  全部重试
                </Button>
                <Button size="sm" variant="ghost" onClick={queryFailure.dismiss}>
                  知道了
                </Button>
              </div>
            </div>
          ) : null}
          <OpsMaintenanceBanner />
          {expiryNoticeVisible ? (
            <div className="mb-4 flex flex-col gap-2 rounded-lg border border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn-soft)] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0">
                {expiryDaysLeft === 0
                  ? `「${expiryNotice?.planName || "你的套餐"}」今天到期，到期后订阅和转发都会停。`
                  : `「${expiryNotice?.planName || "你的套餐"}」还有 ${expiryDaysLeft} 天到期。`}
              </p>
              <Button size="sm" className="shrink-0" onClick={() => setLocation("/subscriptions")}>
                去续费
              </Button>
            </div>
          ) : null}
          <div key={location} className="route-content-enter">
            {/*
              「更多」页要的东西全部由这里算好递下去：它已经按权限过滤过一次，
              页面不该再算第二遍。算两遍的下场是两边不一致 —— 侧边栏里没有的
              入口在「更多」里还点得到。
            */}
            <MobileNavContext.Provider value={mobileNavValue}>
              {children}
            </MobileNavContext.Provider>
          </div>
        </main>
        {/* 精简布局：页脚那一行链接不占每页的底部（设置 › 关于 里都有） */}
        <footer data-fx-compact-hide="" className="hidden pb-4 text-center text-xs text-muted-foreground md:block">
          <div className="inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <a
              href={publicInfo?.repoUrl || "https://github.com/zhongyizhu11-jpg/NEX"}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-foreground"
            >
              项目地址
            </a>
            <span className="text-muted-foreground/45">|</span>
            <a
              href={docsUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-foreground"
            >
              使用教程
            </a>
            {publicInfo?.telegramBotUrl ? (
              <>
                <span className="text-muted-foreground/45">|</span>
                <a
                  href={publicInfo.telegramBotUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-foreground"
                >
                  联系TG
                </a>
              </>
            ) : null}
          </div>
        </footer>
        {isMobile && !pearl ? (
          <IosTabBar plan={tabBarPlan} currentPath={currentPath} onNavigate={(path) => navigateFromSidebar(path)} />
        ) : null}
      </SidebarInset>
      </div>

      <WorkspaceCommand open={commandOpen} onOpenChange={setCommandOpen} items={commandItems} currentPath={currentPath} onNavigate={navigateToDestination} />

      <Dialog open={showUpgradeDialog} onOpenChange={setShowUpgradeDialog}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[560px] overflow-x-hidden sm:max-w-xl">
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-primary" />
            {isPanelRollbackTask ? "面板版本回退" : "发现新版本"}
          </DialogTitle>
          <DialogDescription>
            {isPanelRollbackTask
              ? "后台回退，完成后自动重启。"
              : (isDockerDeployment ? "复制一键脚本后在服务器执行，脚本会重建 NEX 容器。" : "后台升级，完成后自动重启。")}
          </DialogDescription>
          {(() => {
            const job = displayUpgradeJob;
            const progress = upgradeProgress;
            const isRunning = job?.status === "running";
            const isSuccess = job?.status === "success";
            const isWaitingAssets = job?.status === "waiting_assets";
            const isError = job?.status === "error";
            const targetVersion = upgradeTargetVersion || "-";
            const currentVersion = upgradeStatus?.currentVersion || updateInfo?.currentVersion || "-";
            return (
              <div className="min-w-0 space-y-4 overflow-x-hidden py-2">
                <div className="grid gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">当前版本</p>
                    <p className="mt-1 break-all font-mono">v{currentVersion}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">目标版本</p>
                    <p className="mt-1 break-all font-mono">{String(targetVersion).startsWith("v") ? targetVersion : `v${targetVersion}`}</p>
                  </div>
                </div>

                {upgradeStatus?.upgradeEnabled === false && (
                  <div className="rounded-lg border border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] p-3 text-sm text-[var(--fx-warn-text)]">
                    {isDockerDeployment ? `Docker 部署请复制下方一键脚本到服务器执行${panelVersionActionLabel}。` : `当前环境未配置自动${panelVersionActionLabel}命令，无法在面板内一键${panelVersionActionLabel}。`}
                  </div>
                )}

                {isDockerDeployment && (
                  <div className="space-y-3 rounded-lg border border-border/40 bg-background/60 p-3">
                    {updateInfo?.pendingReason && !updateInfo.error && (
                      <div className="rounded-lg border border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] p-3 text-xs leading-5 text-[var(--fx-warn-text)]">
                        {updateInfo.pendingReason}
                      </div>
                    )}
                    <code className="block max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
                      {dockerUpgradeCommand}
                    </code>
                  </div>
                )}

                {(isRunning || isSuccess || isWaitingAssets || isError) && (
                  <div className="space-y-3 rounded-lg border border-border/40 bg-background/60 p-3">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 font-medium">{progress.label}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{progress.percent}%</span>
                    </div>
                    {progress.detail && (
                      <p className="text-xs tabular-nums text-muted-foreground">{progress.detail}</p>
                    )}
                    <Progress value={progress.percent} className="h-2" />
                    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                      {progress.steps.map((step) => (
                        <div key={step.label} className="flex min-w-0 items-center gap-2 text-xs">
                          {step.done ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--fx-healthy-text)]" />
                          ) : step.active ? (
                            <Loader2 className="forwardx-icon-spin h-3.5 w-3.5 shrink-0 text-primary" />
                          ) : (
                            <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                          )}
                          <span className={step.done || step.active ? "truncate text-foreground" : "truncate text-muted-foreground"}>{step.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {isWaitingAssets && (
                  <div className="rounded-lg border border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] p-3 text-sm text-[var(--fx-warn-text)]">
                    <div className="flex items-center gap-2 font-medium">
                      <RefreshCw className="h-4 w-4" />
                      发布资产构建中
                    </div>
                    <p className="mt-2 break-words text-xs leading-5">
                      {job?.error || `GitHub Actions 正在生成面板安装包或 Docker 镜像，请稍后重新检查${panelVersionActionLabel}。`}
                    </p>
                  </div>
                )}

                {isError && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    <div className="flex items-center gap-2 font-medium">
                      <AlertTriangle className="h-4 w-4" />
                      {panelVersionActionLabel}失败
                    </div>
                    <p className="mt-1 text-xs">{job?.error || `${panelVersionActionLabel}命令执行失败，请到系统设置查看日志。`}</p>
                  </div>
                )}

                {isSuccess && (
                  <div className="rounded-lg border border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] bg-[var(--fx-healthy-soft)] p-3 text-sm text-[var(--fx-healthy-text)]">
                    {panelVersionActionLabel}任务已完成，面板正在重启。{upgradeRefreshText}。
                  </div>
                )}

              </div>
            );
          })()}
          <DialogFooter className="gap-2">
            {canDismissPanelUpdateNotice && (
              <Button className="w-full gap-2 sm:w-auto" variant="outline" onClick={dismissPanelUpdateNotice}>
                <BellOff className="h-4 w-4" />
                不再提醒
              </Button>
            )}
            <Button className="w-full sm:w-auto" variant="outline" onClick={() => setShowUpgradeDialog(false)}>
              {displayUpgradeJob?.status === "running" ? "后台执行" : "取消"}
            </Button>
            {isDockerDeployment ? (
              <Button className="w-full gap-2 sm:w-auto" onClick={() => copyText(dockerUpgradeCommand)}>
                <Copy className="h-4 w-4" />
                复制脚本
              </Button>
            ) : (
              <Button
                className="w-full gap-2 sm:w-auto"
                disabled={
                  !upgradeTargetVersion ||
                  isPanelRollbackTask ||
                  upgradeStatus?.upgradeEnabled === false ||
                  displayUpgradeJob?.status === "running" ||
                  displayUpgradeJob?.status === "success" ||
                  startUpgradeMutation.isPending
                }
                onClick={() => upgradeTargetVersion && startUpgradeMutation.mutate({ targetVersion: upgradeTargetVersion })}
              >
                {startUpgradeMutation.isPending || displayUpgradeJob?.status === "running" ? (
                  <Loader2 className="forwardx-icon-spin h-4 w-4" />
                ) : (
                  <Rocket className="h-4 w-4" />
                )}
                {isPanelRollbackTask
                  ? (displayUpgradeJob?.status === "running" ? "回退中..." : "请到系统设置处理")
                  : (displayUpgradeJob?.status === "running" ? "升级中..." : "确认升级")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showMobileUpdateDialog} onOpenChange={setShowMobileUpdateDialog}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[420px] overflow-hidden rounded-xl border-border/60 bg-background p-0 shadow-2xl">
          <div className="border-b border-border/40 bg-primary/10 px-5 py-4">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Download className="h-5 w-5 text-primary" />
              发现 APP 新版本
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              前往下载新版 {mobileUpdateInfo?.packageLabel || "安装包"}。
            </DialogDescription>
          </div>
          <div className="space-y-3 px-5 py-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border border-border/40 bg-muted/25 p-3">
                <p className="text-xs text-muted-foreground">当前版本</p>
                <p className="mt-1 font-mono">{mobileUpdateInfo?.currentVersion ? `v${mobileUpdateInfo.currentVersion.replace(/^v/i, "")}` : "-"}</p>
              </div>
              <div className="rounded-lg border border-primary/25 bg-primary/10 p-3">
                <p className="text-xs text-muted-foreground">最新版本</p>
                <p className="mt-1 font-mono text-primary">{mobileUpdateInfo?.latestVersion ? `v${mobileUpdateInfo.latestVersion.replace(/^v/i, "")}` : "-"}</p>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 border-t border-border/40 px-5 py-4">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setShowMobileUpdateDialog(false)}>
              稍后再说
            </Button>
            <Button className="w-full gap-2 sm:w-auto" onClick={openDetectedMobileRelease}>
              <ExternalLink className="h-4 w-4" />
              前往下载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change Password Dialog */}
      <Dialog open={showChangePassword} onOpenChange={setShowChangePassword}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>请输入当前密码和新密码</DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="old-password">当前密码</Label>
              <PasswordInput
                id="old-password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="请输入当前密码"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">新密码</Label>
              <PasswordInput
                id="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="请输入新密码（至少6个字符）"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">确认新密码</Label>
              <PasswordInput
                id="confirm-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="请再次输入新密码"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowChangePassword(false)}>
              取消
            </Button>
            <Button
              onClick={handleChangePassword}
              disabled={changePasswordMutation.isPending}
            >
              {changePasswordMutation.isPending ? "修改中..." : "确认修改"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAvatarDialog} onOpenChange={setShowAvatarDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>头像设置</DialogTitle>
          <DialogDescription>选择预设头像或上传自定义头像。</DialogDescription>
          <AvatarPicker
            value={avatarDraft}
            onChange={setAvatarDraft}
            fallback={user?.id || user?.username}
            disabled={updateAvatarMutation.isPending}
            onError={(message) => toast.error(message)}
            className="py-2"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAvatarDialog(false)} disabled={updateAvatarMutation.isPending}>
              取消
            </Button>
            <Button onClick={handleSaveAvatar} disabled={updateAvatarMutation.isPending}>
              {updateAvatarMutation.isPending ? "保存中..." : "保存头像"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showTwoFactorDialog} onOpenChange={setShowTwoFactorDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            双重验证
          </DialogTitle>
          <DialogDescription>使用 2FA 软件生成动态验证码。</DialogDescription>
          {!twoFactorStatus?.globalEnabled ? (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
              管理员尚未启用双重验证功能。
            </div>
          ) : twoFactorStatus?.enabled ? (
            <div className="space-y-4 py-2">
              <div className="rounded-lg border border-[color-mix(in_srgb,var(--fx-healthy)_25%,transparent)] bg-[var(--fx-healthy-soft)] p-3 text-sm text-[var(--fx-healthy-text)]">
                当前账户已启用双重验证。
              </div>
              <div className="space-y-2">
                <Label htmlFor="two-factor-disable-password">当前密码</Label>
                <PasswordInput
                  id="two-factor-disable-password"
                  value={twoFactorPassword}
                  onChange={(e) => setTwoFactorPassword(e.target.value)}
                  placeholder="请输入当前密码"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="two-factor-disable-code">动态验证码</Label>
                <Input
                  id="two-factor-disable-code"
                  inputMode="numeric"
                  maxLength={6}
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="请输入 6 位验证码"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
                扫码添加，{Math.round((twoFactorSetup?.expiresInSeconds || TWO_FACTOR_SETUP_SECONDS) / 60)} 分钟内有效。
              </div>
              <div className="flex flex-col items-center gap-3">
                <div className={`flex h-48 w-48 items-center justify-center rounded-lg border bg-white p-3 ${twoFactorSetupExpired ? "opacity-45" : ""}`}>
                  {beginTwoFactorSetupMutation.isPending ? (
                    <Loader2 className="forwardx-icon-spin h-6 w-6 text-muted-foreground" />
                  ) : twoFactorQrCode ? (
                    <img src={twoFactorQrCode} alt="2FA 绑定二维码" className="h-full w-full" />
                  ) : (
                    <span className="text-xs text-muted-foreground">二维码生成中</span>
                  )}
                </div>
                <div className={`text-xs ${twoFactorSetupExpired ? "text-destructive" : "text-muted-foreground"}`}>
                  {twoFactorSetup
                    ? twoFactorSetupExpired
                      ? "二维码已过期，请重新生成"
                      : `剩余 ${twoFactorSetupRemainingLabel}`
                    : "正在生成二维码"}
                </div>
              </div>
              {twoFactorSetup?.otpauthUrl && (
                <Button variant="outline" asChild className="w-full gap-2">
                  <a href={twoFactorSetup.otpauthUrl}>
                    <ExternalLink className="h-4 w-4" />
                    打开 2FA 软件添加
                  </a>
                </Button>
              )}
              <div className="space-y-2">
                <Label>备用密钥</Label>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md border bg-background px-3 py-2 font-mono text-sm">
                    {twoFactorSetup?.secret || "正在生成..."}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => twoFactorSetup?.secret && copyText(twoFactorSetup.secret)}
                    disabled={!twoFactorSetup?.secret || twoFactorSetupExpired}
                    title="复制备用密钥"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="two-factor-enable-password">当前密码</Label>
                <PasswordInput
                  id="two-factor-enable-password"
                  value={twoFactorPassword}
                  onChange={(e) => setTwoFactorPassword(e.target.value)}
                  placeholder="请输入当前密码"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="two-factor-enable-code">动态验证码</Label>
                <Input
                  id="two-factor-enable-code"
                  inputMode="numeric"
                  maxLength={6}
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="请输入 6 位验证码"
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowTwoFactorDialog(false)}>
              关闭
            </Button>
            {twoFactorStatus?.globalEnabled && twoFactorStatus?.enabled ? (
              <Button
                variant="destructive"
                onClick={handleDisableTwoFactor}
                disabled={disableTwoFactorMutation.isPending}
              >
                {disableTwoFactorMutation.isPending ? "关闭中..." : "关闭双重验证"}
              </Button>
            ) : twoFactorStatus?.globalEnabled ? (
              <>
                {twoFactorSetupExpired && (
                  <Button
                    variant="outline"
                    onClick={() => beginTwoFactorSetupMutation.mutate()}
                    disabled={beginTwoFactorSetupMutation.isPending}
                  >
                    {beginTwoFactorSetupMutation.isPending ? "生成中..." : "重新生成二维码"}
                  </Button>
                )}
                <Button
                  onClick={handleEnableTwoFactor}
                  disabled={beginTwoFactorSetupMutation.isPending || enableTwoFactorMutation.isPending || twoFactorSetupExpired}
                >
                  {enableTwoFactorMutation.isPending ? "启用中..." : "启用双重验证"}
                </Button>
              </>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showTelegramDialog} onOpenChange={setShowTelegramDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" />
            Telegram 绑定
          </DialogTitle>
          <DialogDescription>绑定后可用 Telegram 登录和查询。</DialogDescription>
          <div className="space-y-4 py-2">
            {telegramStatus?.bound ? (
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-sm font-medium">
                  {telegramStatus.account?.username ? `@${telegramStatus.account.username}` : telegramStatus.account?.id}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  绑定时间：{telegramStatus.account?.linkedAt ? new Date(telegramStatus.account.linkedAt).toLocaleString() : "-"}
                </p>
              </div>
            ) : telegramBind ? (
              <div className="space-y-3">
                {telegramBotUrl && (
                  <a
                    href={telegramBotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary transition-colors hover:bg-primary/10"
                  >
                    <span>
                      当前机器人：<b>@{telegramBind.botUsername || telegramStatus?.botUsername}</b>
                    </span>
                    <Send className="h-4 w-4" />
                  </a>
                )}
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <p className="text-xs text-muted-foreground">绑定码</p>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className={`break-all font-mono text-lg font-semibold tracking-widest ${telegramBindExpired ? "text-muted-foreground line-through" : ""}`}>
                          {telegramBind.code}
                        </code>
                        <Badge variant={telegramBindExpired ? "destructive" : "outline"} className="shrink-0">
                          {telegramBindExpired ? "已过期" : `${telegramBindRemainingLabel} 后过期`}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {telegramBindExpired ? "绑定码已过期，请重新生成。" : "5 分钟内有效，可复制备用，也可以直接打开 Telegram 完成绑定。"}
                      </p>
                    </div>
                    <Button variant="outline" size="icon" aria-label="复制绑定码" onClick={() => copyText(telegramBind.code)} disabled={telegramBindExpired}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  打开 Telegram 点 Start，或发送 <code>/bind {telegramBind.code}</code>。
                </p>
                {telegramBindUrl && !telegramBindExpired && (
                  <Button variant="outline" asChild className="w-full gap-2">
                    <a href={telegramBindUrl} target="_blank" rel="noopener noreferrer">
                      <Send className="h-4 w-4" />
                      打开 Telegram 完成绑定
                    </a>
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {telegramBotUrl && (
                  <a
                    href={telegramBotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary transition-colors hover:bg-primary/10"
                  >
                    <span>
                      当前机器人：<b>@{telegramStatus?.botUsername}</b>
                    </span>
                    <Send className="h-4 w-4" />
                  </a>
                )}
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
                  {telegramStatus?.configured ? "先生成绑定码。" : "Telegram 尚未配置。"}
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            {telegramStatus?.bound ? (
              <>
                {telegramBotUrl && (
                  <Button variant="outline" asChild className="gap-2">
                    <a href={telegramBotUrl} target="_blank" rel="noopener noreferrer">
                      <Send className="h-4 w-4" />
                      打开机器人
                    </a>
                  </Button>
                )}
                <Button
                  variant="destructive"
                  className="gap-2"
                  onClick={() => unbindTelegramMutation.mutate()}
                  disabled={unbindTelegramMutation.isPending}
                >
                  <Link2Off className="h-4 w-4" />
                  解除绑定
                </Button>
              </>
            ) : (
              <Button
                onClick={() => createTelegramBindMutation.mutate()}
                disabled={createTelegramBindMutation.isPending || telegramStatus?.configured === false}
              >
                {createTelegramBindMutation.isPending ? "生成中..." : telegramBindExpired ? "重新生成绑定码" : "生成绑定码"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAnnouncement} onOpenChange={(open) => {
        if (!open && popupAnnouncement?.id) dismissAnnouncement.mutate({ id: popupAnnouncement.id });
        setShowAnnouncement(open);
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5" />
            {popupAnnouncement?.title || "公告"}
          </DialogTitle>
          <DialogDescription>关闭后可在公告中查看。</DialogDescription>
          <div
            className="max-h-[50svh] overflow-y-auto rounded-lg border bg-background/45 p-4 text-sm leading-6"
            dangerouslySetInnerHTML={{ __html: renderMixedHtml(popupAnnouncement?.content || "") }}
          />
          <DialogFooter>
            <Button onClick={() => popupAnnouncement?.id && dismissAnnouncement.mutate({ id: popupAnnouncement.id })}>我知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showUpgradeAnnouncement} onOpenChange={(open) => {
        if (open) setShowUpgradeAnnouncement(true);
      }}>
        <DialogContent className="sm:max-w-lg [&>button]:hidden">
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5" />
            {upgradeAnnouncement?.title || "升级公告"}
          </DialogTitle>
          <DialogDescription>
            已检测到面板已升级。请阅读本次版本公告，{UPGRADE_ANNOUNCEMENT_COUNTDOWN_SECONDS}S 后可确认进入页面。
          </DialogDescription>
          <div
            className="max-h-[50svh] overflow-y-auto rounded-lg border bg-background/45 p-4 text-sm leading-6"
            dangerouslySetInnerHTML={{ __html: renderMixedHtml(upgradeAnnouncement?.content || "") }}
          />
          <DialogFooter>
            <Button
              onClick={() => upgradeAnnouncement?.id && dismissUpgradeAnnouncement.mutate({ id: upgradeAnnouncement.id })}
              disabled={upgradeAnnouncementCountdown > 0 || dismissUpgradeAnnouncement.isPending}
            >
              {upgradeAnnouncementCountdown > 0 ? `${upgradeAnnouncementCountdown}S` : "我知道了"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
