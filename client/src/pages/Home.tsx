import WorkspaceHeader from "@/components/WorkspaceHeader";
import { useAuth } from "@/_core/hooks/useAuth";
import { quotaSourceLabel } from "@shared/ledgerLabels";
import { formatMoneyCents as money } from "@shared/formatMoney";
import { formatBytes } from "@shared/formatBytes";
import DashboardLayout from "@/components/DashboardLayout";
import MobileAppSettings from "@/components/MobileAppSettings";
import SystemStatusHeader, { type SystemHealth } from "@/components/SystemStatusHeader";
import { mobileAuth } from "@/lib/mobileAuth";
import { pollingInterval } from "@/lib/polling";
import { trafficQuotaBreakdown } from "@/lib/trafficQuota";
import { trpc } from "@/lib/trpc";
import { AccountSection } from "@/features/dashboard/AccountSection";
import { AttentionSection } from "@/features/dashboard/AttentionSection";
import { NetworkMapSlot } from "@/features/dashboard/NetworkMapSlot";
import { QuickStartSection } from "@/features/dashboard/QuickStartSection";
import { TrafficSurface, type TrafficChartPoint } from "@/features/dashboard/TrafficSurface";
import { lazy, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

// 未登录才用得到的落地页不进入口包；外面 App 的 Suspense 兜着。
const PublicHome = lazy(() => import("./PublicHome"));
const CustomPublicHome = lazy(() => import("./PublicHome").then((mod) => ({ default: mod.CustomPublicHome })));

const LOGIN_WELCOME_TOAST_KEY = "forwardx.loginWelcome";

function formatTrafficTime(value: string | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "永久有效";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "永久有效" : date.toLocaleDateString("zh-CN");
}

function getExpiryStatus(value: string | Date | null | undefined) {
  if (!value) return { label: "永久有效", tone: "normal" as const };
  const expiry = new Date(value).getTime();
  if (Number.isNaN(expiry)) return { label: "永久有效", tone: "normal" as const };
  const diffDays = Math.ceil((expiry - Date.now()) / 86_400_000);
  if (diffDays < 0) return { label: "已到期", tone: "danger" as const };
  if (diffDays <= 7) return { label: diffDays === 0 ? "今日到期" : `剩余 ${diffDays} 天`, tone: "warning" as const };
  return { label: `剩余 ${diffDays} 天`, tone: "normal" as const };
}

function DashboardContent() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [, setLocation] = useLocation();
  const { data: trafficTotals, isLoading: trafficTotalsLoading } = trpc.dashboard.trafficTotals.useQuery(undefined, {
    refetchInterval: pollingInterval("normal"),
    staleTime: 5000,
    placeholderData: (previousData) => previousData,
  });
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery(undefined, { enabled: !isAdmin, placeholderData: (previousData) => previousData });
  const { data: trafficBilling, isLoading: trafficBillingLoading } = trpc.trafficBilling.status.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const { data: subscriptions = [], isLoading: subscriptionsLoading } = trpc.plans.mySubscriptions.useQuery(undefined, { enabled: !isAdmin, placeholderData: (previousData) => previousData });
  const { data: userTraffic = [], isLoading: userTrafficLoading } = trpc.dashboard.userTraffic.useQuery(undefined, { refetchInterval: pollingInterval("slow"), placeholderData: (previousData) => previousData });
  const { data: trafficBreakdown, isLoading: breakdownLoading } = trpc.dashboard.trafficBreakdown.useQuery(
    { hours: 24, limit: 30 },
    { refetchInterval: pollingInterval("slow"), staleTime: 25000, placeholderData: (previousData) => previousData },
  );
  const { data: trafficSeries, isLoading: trendLoading } = trpc.dashboard.trafficSeries.useQuery(
    { hours: 24, bucketMinutes: 60 },
    { refetchInterval: pollingInterval("slow"), staleTime: 25000, placeholderData: (previousData) => previousData },
  );

  const { data: health, isLoading: healthLoading, refetch: refetchHealth } = trpc.dashboard.health.useQuery(undefined, {
    refetchInterval: pollingInterval("normal"),
    placeholderData: (previousData) => previousData,
  });

  /*
    近 24H 流量直接汇总上面那条 series —— 它本来就要取来画图，再为顶上那一个
    数字发一次请求是白跑。series 还没回来时给 undefined 而不是 0：
    「还没有数」和「真的是 0」在这一格上是两回事。
  */
  const recentBytes = useMemo(() => {
    if (!trafficSeries) return undefined;
    return (trafficSeries as any[]).reduce(
      (total, point) => total + (Number(point.bytesIn) || 0) + (Number(point.bytesOut) || 0),
      0,
    );
  }, [trafficSeries]);

  const chartData = useMemo<TrafficChartPoint[]>(
    () =>
      (trafficSeries || []).map((point: any) => ({
        label: formatTrafficTime(point.bucket),
        fullLabel: formatTrafficTime(point.bucket),
        bytesIn: Number(point.bytesIn) || 0,
        bytesOut: Number(point.bytesOut) || 0,
      })),
    [trafficSeries],
  );

  const currentUserTraffic = useMemo(() => {
    if (!userTraffic.length) return null;
    return userTraffic.find((item: any) => Number(item.id) === Number(user?.id)) || userTraffic[0];
  }, [userTraffic, user?.id]);

  const [cachedTrafficBreakdown, setCachedTrafficBreakdown] = useState<typeof trafficBreakdown | null>(null);
  useEffect(() => {
    if (trafficBreakdown) setCachedTrafficBreakdown(trafficBreakdown);
  }, [trafficBreakdown]);
  const visibleTrafficBreakdown = trafficBreakdown || cachedTrafficBreakdown;

  const accountTrafficLimit = Number(currentUserTraffic?.trafficLimit) || 0;
  const trafficUsed = Number(currentUserTraffic?.trafficUsed) || 0;
  const trafficBillingEnabled = !!trafficBilling?.enabled;
  const trafficBillingBytes = Number(trafficBilling?.totalBytes || 0);
  const trafficBillingAmount = Number(trafficBilling?.totalAmountCents || 0);
  const trafficBillingBilledGb = Number(trafficBilling?.totalBilledGb || 0);

  const activeSubscriptions = useMemo(() => {
    const now = Date.now();
    return (subscriptions || []).filter((subscription: any) => {
      const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt).getTime() : Number.POSITIVE_INFINITY;
      return subscription.status === "active" && expiresAt > now;
    });
  }, [subscriptions]);
  const activeSubscription = activeSubscriptions[0];
  const quota = useMemo(
    () => trafficQuotaBreakdown(currentUserTraffic || user, subscriptions),
    [currentUserTraffic, subscriptions, user],
  );
  const trafficLimit = quota.unlimited
    ? 0
    : accountTrafficLimit > 0
      ? accountTrafficLimit
      : quota.totalBytes;
  const trafficPercent = trafficLimit > 0 ? Math.min(100, Math.round((trafficUsed / trafficLimit) * 100)) : 0;
  const accountStatusLoading = userTrafficLoading || subscriptionsLoading || trafficBillingLoading || (!isAdmin && walletLoading);
  const accountCacheScope = user?.id ? String(user.id) : "current";
  const accountExpiresAt = currentUserTraffic ? currentUserTraffic.expiresAt ?? null : activeSubscription?.expiresAt ?? null;
  const expiry = quota.hasQuota ? getExpiryStatus(accountExpiresAt) : { label: "---", tone: "normal" as const };
  const canForward = isAdmin || !!currentUserTraffic?.canAddRules;
  const quotaExpiryText = quota.hasQuota ? formatDate(accountExpiresAt) : "---";
  const trafficBillingBytesText = trafficBillingEnabled ? formatBytes(trafficBillingBytes) : "未开启";
  const trafficBillingAmountText = trafficBillingEnabled ? money(trafficBillingAmount) : "-";

  const mobileReminderSnapshot = useMemo(
    () => ({
      trafficLimit: quota.hasQuota ? trafficLimit : 0,
      trafficUsed: quota.hasQuota ? trafficUsed : 0,
      expiresAt: quota.hasQuota ? accountExpiresAt : null,
    }),
    [accountExpiresAt, quota.hasQuota, trafficLimit, trafficUsed],
  );

  const accountSection = (
    <AccountSection
      isAdmin={isAdmin}
      loading={accountStatusLoading}
      cacheScope={accountCacheScope}
      onOpen={setLocation}
      trafficUsed={trafficUsed}
      billing={{
        enabled: trafficBillingEnabled,
        bytesText: trafficBillingBytesText,
        amountText: trafficBillingAmountText,
        billedText: `已计费 ${trafficBillingBilledGb}GB`,
      }}
      quota={{
        hasQuota: quota.hasQuota,
        unlimited: quota.unlimited,
        used: trafficUsed,
        limit: trafficLimit,
        percent: trafficPercent,
        sourcesText: quota.sources.length > 0
          ? `额度来源：${quota.sources.map((source) => `${quotaSourceLabel(source.kind)} ${source.unlimited ? "不限" : formatBytes(source.bytes)}`).join("、")}。`
          : null,
        autoResetDay: currentUserTraffic?.trafficAutoReset ? Number(currentUserTraffic.trafficResetDay || 1) : null,
      }}
      expiry={{ dateText: quotaExpiryText, label: expiry.label, tone: expiry.tone }}
      planText={activeSubscriptions.length > 1
        ? `${activeSubscription?.planName || "---"} 等 ${activeSubscriptions.length} 个`
        : activeSubscription?.planName || "---"}
      balanceText={money(wallet?.balanceCents)}
      canForward={canForward}
      forwardPaused={((health as SystemHealth | undefined)?.attention?.totals["forward-paused"] ?? 0) > 0}
    />
  );

  const trafficSection = (
    <TrafficSurface
      recentBytes={recentBytes}
      chartData={chartData}
      chartLoading={trendLoading}
      breakdown={visibleTrafficBreakdown}
      breakdownLoading={breakdownLoading}
      totals={trafficTotals}
      totalsLoading={trafficTotalsLoading}
    />
  );

  /*
    页面从上往下是一个问题接一个问题：有没有问题 → 要处理什么 → 流量怎么样 →
    我的账户。租户把账户提到流量前面：对他来说「额度还剩多少、哪天到期」就是
    他的「系统状态」，比一张走势图要紧。
  */
  return (
    <div className="space-y-6">
      {/*
        标题下面那一行是此刻的数（「4 台主机 · 19 条线路 · 19 条转发」），不是一句说明书。
        「查看运行状态、资源使用和流量趋势」是在解释这一页叫总览 —— 它叫总览就够了。
      */}
      <WorkspaceHeader title="总览" status={health ? (
        <span className="tabular-nums">
          {[
            isAdmin ? `${health.hosts.total} 台主机` : null,
            `${health.links.total} 条线路`,
            `${health.forwards.total} 条转发`,
          ].filter(Boolean).join(" · ")}
        </span>
      ) : null} />
      {/*
        概览放在数字前面：这一页第一眼看到的是「机器在哪、谁转给谁、哪条断了」，数字是第二眼的事
        （用户 2026-09-27 明确要它留在顶端）。没有主机时它自己不出现。
        它的几条请求不等 health：health 还没回来时照常并行取，health 说没有主机才停。
      */}
      <NetworkMapSlot enabled={!health || health.hosts.total > 0} cacheScope={accountCacheScope} onOpen={setLocation} />
      <SystemStatusHeader
        health={health as SystemHealth | undefined}
        loading={healthLoading}
        isAdmin={isAdmin}
        onRetry={() => { void refetchHealth(); }}
        onOpenAttention={() => {
          document.getElementById("dashboard-attention")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />
      <QuickStartSection health={health as SystemHealth | undefined} isAdmin={isAdmin} onOpen={setLocation} />
      <AttentionSection
        attention={(health as SystemHealth | undefined)?.attention}
        isAdmin={isAdmin}
        onOpen={setLocation}
      />
      {isAdmin ? trafficSection : accountSection}
      {isAdmin ? accountSection : trafficSection}
      <MobileAppSettings snapshot={mobileReminderSnapshot} />
    </div>
  );
}

export default function Home() {
  const { user, loading } = useAuth();
  const { data: settings } = trpc.system.getSettings.useQuery(undefined, {
    enabled: !user && (!mobileAuth.isNative || mobileAuth.hasPanelUrl()),
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!user || typeof window === "undefined") return;
    const welcomeName = window.sessionStorage.getItem(LOGIN_WELCOME_TOAST_KEY);
    if (!welcomeName) return;
    window.sessionStorage.removeItem(LOGIN_WELCOME_TOAST_KEY);
    toast.success(`欢迎回来！${welcomeName} 用户`, { position: "top-right" });
  }, [user?.id]);

  if (loading) return null;

  if (!user) {
    if (mobileAuth.isNative) {
      if (typeof window !== "undefined") window.location.href = "/login";
      return null;
    }
    if (settings?.homepageEnabled !== false) {
      if (settings?.homepageCustomEnabled && settings?.homepageHtml?.trim()) {
        return <CustomPublicHome html={settings.homepageHtml} />;
      }
      return <PublicHome />;
    }
    if (typeof window !== "undefined") window.location.href = "/login";
    return null;
  }

  return (
    <DashboardLayout>
      <DashboardContent />
    </DashboardLayout>
  );
}
