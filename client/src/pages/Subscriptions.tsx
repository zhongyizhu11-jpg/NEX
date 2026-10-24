import WorkspaceHeader from "@/components/WorkspaceHeader";
import DashboardLayout from "@/components/DashboardLayout";
import EmptyState from "@/components/EmptyState";
import { SummaryStrip } from "@/components/entity/SummaryStrip";
import { quotaSourceLabel, subscriptionSourceLabel, subscriptionStatusLabel } from "@shared/ledgerLabels";
import { formatQuotaBytes } from "@shared/formatBytes";
import { formatMoneyCents as money } from "@shared/formatMoney";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { usePaymentOrderDialog } from "@/components/PaymentOrderDialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { useAuth } from "@/_core/hooks/useAuth";
import { planResourceText } from "@/lib/planDisplay";
import { pollingInterval } from "@/lib/polling";
import { trafficQuotaBreakdown } from "@/lib/trafficQuota";
import { trpc } from "@/lib/trpc";
import { formatTrafficPricePerGb } from "@shared/trafficBillingPrice";
import { AlertTriangle, CalendarClock, CheckCircle2, Coins, CreditCard, Eye, EyeOff, Gauge, Package, RefreshCw, ShoppingBag, TicketPercent, Trash2, WalletCards } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { BILLING_DATE_TIME_FORMAT_OPTIONS } from "@shared/billingTime";
import { planDurationLabel } from "@shared/planPricing";

function speed(value?: number | null) {
  const num = Number(value || 0);
  return num > 0 ? `${parseFloat(num.toFixed(2))} Mbps` : "不限";
}

function dateTime(value?: string | Date | null) {
  if (!value) return "---";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "---";
  return date.toLocaleString();
}

function billingDateTime(value?: string | Date | null) {
  if (!value) return "---";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "---";
  return date.toLocaleString("zh-CN", BILLING_DATE_TIME_FORMAT_OPTIONS);
}

function cycleEnd(sub: any) {
  return sub?.nextTrafficResetAt || sub?.expiresAt || null;
}

export default function Subscriptions() {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const confirmDialog = useConfirmDialog();
  const [, setLocation] = useLocation();
  /**
   * 到期前一天用余额自动续一期。余额不够就安静跳过，照常到期 ——
   * 不会反复扣、也不会扣成负数。
   */
  const setAutoRenew = trpc.plans.setAutoRenew.useMutation({
    onSuccess: (_result, variables) => {
      utils.plans.mySubscriptions.invalidate();
      toast.success(variables.autoRenew ? "已开启自动续费，到期前用余额自动续一期" : "已关闭自动续费");
    },
    onError: (error) => toast.error(error.message || "设置失败"),
  });
  const { data: storeStatus } = trpc.plans.storeStatus.useQuery();
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery();
  const { data: billingFeatures } = trpc.billing.featureStatus.useQuery();
  /*
    「我有几条转发在按量扣钱、按什么价」。

    这一页原来只讲套餐额度。一个纯按量计费的租户在这儿是一片空白，还被劝「去商店
    下单」—— 而他的「还剩多少」根本不是额度、是余额，在账单中心那一页。他真正要
    知道的三件事（按什么价用、花了多少、余额够不够）一件都看不到。
  */
  const { data: metered } = trpc.trafficBilling.myMeteredForwards.useQuery(undefined, {
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const { data: meteredSummary } = trpc.trafficBilling.status.useQuery(undefined, {
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const { data: paymentMethods = [] } = trpc.payment.availableMethods.useQuery(undefined, {
    enabled: !!storeStatus?.enabled,
  });
  const {
    data: subscriptions = [],
    isLoading,
    error: subscriptionsError,
    isFetching: subscriptionsFetching,
    refetch: refetchSubscriptions,
  } = trpc.plans.mySubscriptions.useQuery();
  const { data: userTraffic = [] } = trpc.dashboard.userTraffic.useQuery(undefined, {
    refetchInterval: pollingInterval("slow"),
    placeholderData: (previousData) => previousData,
  });
  const [selected, setSelected] = useState<{ sub: any; addon: any } | null>(null);
  const [renewingSub, setRenewingSub] = useState<any | null>(null);
  const [paymentType, setPaymentType] = useState<"alipay" | "wxpay" | "stripe" | "usdt">("stripe");
  const [selectedPayMode, setPayMode] = useState<"gateway" | "balance">("gateway");
  const [discountCode, setDiscountCode] = useState("");
  const [discountPreview, setDiscountPreview] = useState<any | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  const activeCount = useMemo(
    () => subscriptions.filter((sub: any) => sub.status === "active" && (!sub.expiresAt || new Date(sub.expiresAt) > new Date())).length,
    [subscriptions],
  );
  const cancelledCount = useMemo(
    () => subscriptions.filter((sub: any) => sub.status === "cancelled").length,
    [subscriptions],
  );
  const visibleSubscriptions = useMemo(
    () => showCancelled ? subscriptions : subscriptions.filter((sub: any) => sub.status !== "cancelled"),
    [showCancelled, subscriptions],
  );
  const currentUserTraffic = useMemo(
    () => userTraffic.find((item: any) => Number(item.id) === Number(user?.id)) || user,
    [user, userTraffic],
  );
  const quota = useMemo(
    () => trafficQuotaBreakdown(currentUserTraffic, subscriptions),
    [currentUserTraffic, subscriptions],
  );
  const effectiveTrafficLimit = quota.unlimited
    ? 0
    : Number(currentUserTraffic?.trafficLimit || 0) || quota.totalBytes;

  const deleteCancelledSubscription = trpc.plans.deleteCancelledSubscription.useMutation({
    onSuccess: () => {
      toast.success("已取消的订阅记录已删除");
      utils.plans.mySubscriptions.invalidate();
      utils.billing.ledgerPage.invalidate();
    },
    onError: (error) => toast.error(error.message || "删除订阅记录失败"),
  });

  const confirmDeleteCancelledSubscription = async (sub: any) => {
    const confirmed = await confirmDialog({
      title: "删除订阅记录",
      description: `确认删除“${sub.planName || `套餐 #${sub.planId}`}”的已取消记录？支付和余额流水会继续保留。`,
      confirmText: "删除",
      tone: "destructive",
    });
    if (confirmed) deleteCancelledSubscription.mutate({ id: Number(sub.id) });
  };

  const purchaseAddon = trpc.billing.purchaseTrafficAddonWithBalance.useMutation({
    onSuccess: () => {
      toast.success("附加流量已购买");
      setSelected(null);
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
      utils.dashboard.userTraffic.invalidate();
    },
    onError: (error) => toast.error(error.message || "购买附加流量失败"),
  });

  const closeRenewDialog = () => {
    setRenewingSub(null);
    setDiscountCode("");
    setDiscountPreview(null);
  };

  // 扫码支付（微信 Native / 支付宝当面付）要渲染二维码；跳转支付被拦截时要有能点的链接
  const paymentDialog = usePaymentOrderDialog({
    onPaid: () => {
      utils.payment.myOrders.invalidate();
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
      utils.dashboard.userTraffic.invalidate();
    },
  });

  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success("续费订单已创建");
      closeRenewDialog();
      utils.payment.myOrders.invalidate();
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
      paymentDialog.launch(order);
    },
    onError: (error) => toast.error(error.message || "创建续费订单失败"),
  });

  const renewWithBalance = trpc.billing.purchasePlanWithBalance.useMutation({
    onSuccess: () => {
      toast.success("套餐已续费");
      closeRenewDialog();
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
      utils.dashboard.userTraffic.invalidate();
    },
    onError: (error) => toast.error(error.message || "续费失败"),
  });

  const previewDiscount = trpc.billing.previewDiscount.useMutation({
    onSuccess: (data) => {
      setDiscountPreview(data);
      toast.success("折扣码已应用");
    },
    onError: (error) => {
      setDiscountPreview(null);
      toast.error(error.message || "折扣码不可用");
    },
  });

  const openRenew = (sub: any) => {
    const firstMethod = paymentMethods[0]?.value as "alipay" | "wxpay" | "stripe" | "usdt" | undefined;
    if (firstMethod) setPaymentType(firstMethod);
    setPayMode(firstMethod ? "gateway" : "balance");
    setDiscountCode("");
    setDiscountPreview(null);
    setRenewingSub(sub);
  };

  const confirmRenew = () => {
    if (!renewingSub?.planId) return;
    const planId = Number(renewingSub.planId);
    const code = billingFeatures?.discountEnabled ? discountCode.trim() || undefined : undefined;
    /**
     * 续**当初买的那一档**。
     *
     * 不传的话服务端按默认档算：买年付的人点一下「续费」就变成了续一个月。
     * renewDurationDays / renewPriceCents 都由服务端算好（那一档被下架时它会自己
     * 退回默认档），前端不重算 —— 这是要扣钱的数。
     */
    const durationDays = Number(renewingSub.renewDurationDays || 0) || undefined;
    if (payMode === "balance") {
      renewWithBalance.mutate({
        planId,
        subscriptionId: Number(renewingSub.id),
        durationDays,
        discountCode: code,
      });
      return;
    }
    createOrder.mutate({
      amount: renewPriceCents / 100,
      paymentType,
      planId,
      planDurationDays: durationDays,
      subscriptionId: Number(renewingSub.id),
      discountCode: code,
      returnPath: "/subscriptions",
    });
  };


  const selectedPrice = Number(selected?.addon?.priceCents || 0);
  const balanceCents = wallet?.balanceCents == null ? null : Number(wallet.balanceCents);
  const meteredRules = Number(metered?.meteredRules || 0);
  const meteredCharged = Number(meteredSummary?.totalAmountCents || 0);
  const meteredGb = Number(meteredSummary?.totalBilledGb || 0);
  /*
    几条转发挂在不同资源上、单价不一样时给一个区间，不编一个平均价。
    「¥0.5–2.8/GB」是句实话，「¥1.65/GB」不是。
  */
  const meteredPriceText = (() => {
    const low = formatTrafficPricePerGb(metered?.minPricePerGbMilliCents);
    const high = formatTrafficPricePerGb(metered?.maxPricePerGbMilliCents);
    if (!low) return "";
    if (!high || low === high) return low;
    return `${low.replace("/GB", "")}–${high.replace("¥", "")}`;
  })();
  const balanceReady = !walletLoading && balanceCents !== null;
  const balance = balanceCents ?? 0;
  const balanceEnough = balanceReady && balance >= selectedPrice;
  /** 续费原价：按当初买的那一档，不是套餐主表的默认价。 */
  const renewPriceCents = Number(renewingSub?.renewPriceCents ?? renewingSub?.priceCents ?? 0);
  const renewingPrice = renewPriceCents;
  const renewFinalAmountCents = Number(discountPreview?.finalAmountCents ?? renewingPrice);
  const renewBalanceEnough = balanceReady && balance >= renewFinalAmountCents;
  // 0 元续费（免费套餐或折扣抵满）走网关会被拒（最低 0.01），只能走余额通道：不扣钱，直接续期。
  const isFreeRenew = !!renewingSub && renewFinalAmountCents <= 0;
  const payMode: "gateway" | "balance" = isFreeRenew ? "balance" : selectedPayMode;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <WorkspaceHeader title={<>我的套餐</>} description={<>已购买和已分配的套餐。</>} actions={<>
            {storeStatus?.enabled && (
              <Button type="button" size="sm" onClick={() => setLocation("/store")}>
                <ShoppingBag className="mr-2 h-3.5 w-3.5" /> 去商店
              </Button>
            )}
            {cancelledCount > 0 && (
              <Button type="button" size="sm" variant="outline" onClick={() => setShowCancelled((value) => !value)}>
                {showCancelled ? <EyeOff className="mr-2 h-3.5 w-3.5" /> : <Eye className="mr-2 h-3.5 w-3.5" />}
                {showCancelled ? "隐藏已取消" : `已取消 ${cancelledCount}`}
              </Button>
            )}
            <Badge variant="outline" className="w-fit gap-1.5 px-3 py-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-[var(--fx-healthy-text)]" />
              {activeCount} 个生效套餐
            </Badge>
          </>} />

        {/*
          额度这一条原来是页面上两根横线夹着的一行字，和别的页头那条摘要（一块白、细线分栏）
          不是一种画法。说的是同一类事 —— 几个数并排 —— 就用同一条。
        */}
        {!isLoading && quota.hasQuota && (
          <SummaryStrip
            ariaLabel="流量额度"
            items={[
              { key: "total", label: "当前总额度", value: quota.unlimited ? "不限" : formatQuotaBytes(effectiveTrafficLimit) },
              ...quota.sources.map((source) => ({
                key: source.kind,
                label: quotaSourceLabel(source.kind),
                value: source.unlimited ? "不限" : formatQuotaBytes(source.bytes),
              })),
            ]}
          />
        )}

        {/*
          按量计费那一路。只在他真的有转发在按量扣钱时才出现 —— 纯套餐用户看到
          「余额」只会以为自己还得再掏一笔。
        */}
        {meteredRules > 0 && (
          <Card className="border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn)]/[0.04]">
            <CardHeader className="gap-2 pb-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Coins className="h-4 w-4 text-[var(--fx-warn-text)]" /> 按量计费
                </CardTitle>
                <CardDescription>
                  你有 {meteredRules} 条转发按 GB 扣余额{meteredPriceText ? `，${meteredPriceText}` : ""}。这部分不占套餐流量额度。
                </CardDescription>
              </div>
              <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={() => setLocation("/wallet")}>
                <WalletCards className="mr-2 h-3.5 w-3.5" /> 去充值
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-8">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">当前余额</p>
                  <p className="mt-0.5 truncate text-sm font-semibold tabular-nums">
                    {balanceCents == null ? "—" : money(balanceCents)}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">累计已扣</p>
                  <p className="mt-0.5 truncate text-sm font-medium tabular-nums">{money(meteredCharged)}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">已计费流量</p>
                  <p className="mt-0.5 truncate text-sm font-medium tabular-nums">{meteredGb} GB</p>
                </div>
              </div>
              {/*
                余额见底不是「提示」，是会真的发生的事：余额 ≤ 0 时面板会停掉他
                名下**全部**转发，不只是按量的那几条。
              */}
              {balanceCents != null && balanceCents <= 0 ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>余额已经是 0，按量计费扣不动的时候，你名下全部转发都会被停掉。尽快充值。</span>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">余额扣完会自动停掉你名下全部转发，不只是按量计费的这几条。</p>
              )}
            </CardContent>
          </Card>
        )}

        {isLoading && (
          <DataSectionLoading label="正在加载订阅数据" />
        )}

        {/*
          「还没有套餐记录」是一个结论，读取失败时我们并不知道它成不成立 —— 而这句话会
          让一个刚买过套餐的人以为订单丢了。
        */}
        {!isLoading && subscriptionsError && subscriptions.length === 0 && (
          <DataSectionError
            label="你的套餐"
            error={subscriptionsError}
            retrying={subscriptionsFetching}
            onRetry={() => { void refetchSubscriptions(); }}
          />
        )}

        {!isLoading && !subscriptionsError && visibleSubscriptions.length === 0 && (
          <EmptyState
            icon={<Package />}
            title="暂无可显示订阅"
            description={(
              <>
                {cancelledCount > 0
                  ? "已取消记录当前处于隐藏状态。"
                  /*
                    他正在按量计费的话，「还没有套餐记录，去下单吧」是条错的建议 ——
                    他本来就不走套餐，上面那张卡才是他要看的东西。
                  */
                  : meteredRules > 0
                    ? "你走的是按量计费，不需要套餐也能用 —— 用量按上面那张卡的单价扣余额。想改成包月的话可以再买套餐。"
                    : storeStatus?.enabled
                      ? "当前账户还没有套餐记录，可以去商店自助下单。"
                      : "当前账户还没有套餐记录。商店暂未开放，请联系管理员为你分配套餐。"}
              </>
            )}
            actions={storeStatus?.enabled ? (
              <Button onClick={() => setLocation("/store")}>
                <ShoppingBag className="mr-2 h-4 w-4" /> 去商店下单
              </Button>
            ) : undefined}
          />
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {visibleSubscriptions.map((sub: any) => {
            const isActive = sub.status === "active" && (!sub.expiresAt || new Date(sub.expiresAt) > new Date());
            const addons = isActive && Number(sub.trafficLimit || 0) > 0 ? (sub.trafficAddons || []) : [];
            const currentAddonBytes = Number(sub.activeTrafficAddonBytes || 0);
            const purchasedAddonBytes = Number(sub.purchasedTrafficAddonBytes || 0);
            const grantedAddonBytes = Number(sub.grantedTrafficAddonBytes || 0);
            const validUntil = cycleEnd(sub);
            const canRenew = !!storeStatus?.enabled && !!sub.planId && sub.status !== "cancelled"
              && (sub.source === "payment" || sub.source === "balance");
            const requiresAdminRenewal = sub.status !== "cancelled"
              && (sub.source === "admin" || sub.source === "redeem");

            return (
              <Card key={sub.id} className="flex flex-col">
                <CardHeader>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 truncate">
                        <Package className="h-5 w-5 shrink-0" />
                        <span className="truncate">{sub.planName || `套餐 #${sub.planId}`}</span>
                      </CardTitle>
                      <CardDescription keep className="mt-2">{subscriptionSourceLabel(sub.source)}</CardDescription>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                      <Badge variant={isActive ? "default" : "secondary"}>{subscriptionStatusLabel(sub.status)}</Badge>
                      {sub.status === "cancelled" && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive"
                          title="删除已取消订阅"
                          aria-label="删除已取消订阅"
                          onClick={() => void confirmDeleteCancelledSubscription(sub)}
                          disabled={deleteCancelledSubscription.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                      {canRenew && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => openRenew(sub)}
                          disabled={createOrder.isPending || renewWithBalance.isPending}
                        >
                          <CreditCard className="mr-2 h-3.5 w-3.5" />
                          续费
                        </Button>
                      )}
                      {requiresAdminRenewal && (
                        <span className="text-xs text-muted-foreground">请联系管理员续期</span>
                      )}
                      {canRenew && (
                        /*
                          自动续费开在这里而不是设置页：决定要不要自动扣钱的时候，
                          人正看着这条订阅的价格和到期时间。
                        */
                        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                          <Switch
                            aria-label={`自动续费 ${sub.planName || `套餐 #${sub.planId}`}`}
                            checked={!!sub.autoRenew}
                            disabled={setAutoRenew.isPending}
                            onCheckedChange={(checked) => setAutoRenew.mutate({ id: Number(sub.id), autoRenew: checked })}
                          />
                          自动续费
                        </label>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 space-y-4">
                  <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                    <div className="rounded-md border border-border/50 p-3">
                      <div className="text-xs">端口段</div>
                      <div className="mt-1 font-medium text-foreground">{sub.portRangeStart && sub.portRangeEnd ? `${sub.portRangeStart}-${sub.portRangeEnd}` : "---"}</div>
                    </div>
                    <div className="rounded-md border border-border/50 p-3">
                      <div className="text-xs">可用资源</div>
                      <div className="mt-1 font-medium text-foreground">{planResourceText(sub)}</div>
                    </div>
                    <div className="rounded-md border border-border/50 p-3">
                      <div className="text-xs">套餐额度</div>
                      <div className="mt-1 font-medium text-foreground">{formatQuotaBytes(sub.trafficLimit)}</div>
                    </div>
                    {purchasedAddonBytes > 0 && (
                      <div className="rounded-md border border-border/50 p-3">
                        <div className="text-xs">已购附加流量</div>
                        <div className="mt-1 font-medium text-foreground">{formatQuotaBytes(purchasedAddonBytes)}</div>
                      </div>
                    )}
                    {grantedAddonBytes > 0 && (
                      <div className="rounded-md border border-border/50 p-3">
                        <div className="text-xs">管理员加赠</div>
                        <div className="mt-1 font-medium text-foreground">{formatQuotaBytes(grantedAddonBytes)}</div>
                      </div>
                    )}
                    <div className="rounded-md border border-border/50 p-3">
                      <div className="text-xs">限速</div>
                      <div className="mt-1 font-medium text-foreground">{speed(sub.rateLimitMbps)}</div>
                    </div>
                  </div>

                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <div className="flex items-center gap-2">
                      <CalendarClock className="h-3.5 w-3.5" />
                      到期：{dateTime(sub.expiresAt)}
                    </div>
                    <div className="flex items-center gap-2">
                      <Gauge className="h-3.5 w-3.5" />
                      下次流量周期：{billingDateTime(sub.nextTrafficResetAt)}
                    </div>
                  </div>

                  {addons.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-sm font-medium">购买附加流量</div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {addons.map((addon: any) => (
                          <Button
                            key={addon.id}
                            type="button"
                            variant="outline"
                            className="h-auto justify-between gap-3 px-3 py-2"
                            onClick={() => setSelected({ sub, addon })}
                            disabled={purchaseAddon.isPending}
                          >
                            <span className="font-medium">{formatQuotaBytes(addon.trafficBytes)}</span>
                            <span className="text-muted-foreground">{money(addon.priceCents)}</span>
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  {isActive && Number(sub.trafficLimit || 0) > 0 && addons.length === 0 && (
                    <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                      暂无可购买的附加流量包
                    </div>
                  )}
                </CardContent>
                {isActive && currentAddonBytes > 0 && validUntil && (
                  <CardFooter className="text-xs text-muted-foreground">
                    本周期附加流量有效至 {dateTime(validUntil)}
                  </CardFooter>
                )}
              </Card>
            );
          })}
        </div>

        <Dialog open={!!renewingSub} onOpenChange={(open) => !open && closeRenewDialog()}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                续费套餐
              </DialogTitle>
              <DialogDescription>
                再次购买 {renewingSub?.planName || "当前套餐"} 会延长当前订阅有效期。
                {/* 说清楚续的是哪一档：买年付的人得看得见这次续的还是一年。 */}
                {renewingSub?.renewDurationDays
                  ? `本次续期 ${planDurationLabel(Number(renewingSub.renewDurationDays))}。`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">原价</span>
                  <span>{money(renewingPrice, renewingSub?.currency || "CNY")}</span>
                </div>
                {discountPreview && (
                  <div className="mt-1 flex items-center justify-between text-[var(--fx-healthy-text)]">
                    <span>优惠</span>
                    <span>-{money(discountPreview.discountAmountCents, renewingSub?.currency || "CNY")}</span>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between font-medium">
                  <span>应付</span>
                  <span>{money(renewFinalAmountCents, renewingSub?.currency || "CNY")}</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>当前到期</span>
                  <span>{dateTime(renewingSub?.expiresAt)}</span>
                </div>
              </div>

              {billingFeatures?.discountEnabled && (
                <div className="flex gap-2">
                  <Input value={discountCode} onChange={(e) => setDiscountCode(e.target.value.toUpperCase())} placeholder="折扣码（可选）" />
                  <Button
                    variant="outline"
                    onClick={() => renewingSub && previewDiscount.mutate({ code: discountCode, amountCents: renewingPrice, planId: Number(renewingSub.planId) })}
                    disabled={!discountCode.trim() || previewDiscount.isPending}
                  >
                    <TicketPercent className="mr-2 h-4 w-4" /> 应用
                  </Button>
                </div>
              )}

              <div className="grid gap-2">
                {isFreeRenew && (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    本单无需支付，确认后直接续期，不扣余额。
                  </div>
                )}
                {!isFreeRenew && (
                <button
                  type="button"
                  onClick={() => setPayMode("balance")}
                  disabled={walletLoading}
                  className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
                    payMode === "balance" ? "border-primary bg-primary/10 text-primary" : "border-border/60 bg-background/60 hover:bg-muted/60"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <WalletCards className="h-4 w-4" />
                    余额支付（
                    <AnimatedStatValue
                      value={money(balance)}
                      loading={walletLoading}
                      cacheKey="subscriptions.wallet.balance.inline"
                      fallbackValue={money(0)}
                      className="inline-block align-middle"
                    />
                    ）
                  </span>
                  {payMode === "balance" && <CheckCircle2 className="h-4 w-4" />}
                </button>
                )}
                {!isFreeRenew && paymentMethods.map((method: any) => (
                  <button
                    key={method.value}
                    type="button"
                    onClick={() => { setPayMode("gateway"); setPaymentType(method.value); }}
                    className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
                      payMode === "gateway" && paymentType === method.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/60 bg-background/60 hover:bg-muted/60"
                    }`}
                  >
                    <span className="font-medium">{method.label}</span>
                    {payMode === "gateway" && paymentType === method.value && <CheckCircle2 className="h-4 w-4" />}
                  </button>
                ))}
                {!isFreeRenew && paymentMethods.length === 0 && (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    暂无在线支付方式。
                  </div>
                )}
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={closeRenewDialog}>取消</Button>
              <Button
                onClick={confirmRenew}
                disabled={
                  !renewingSub ||
                  createOrder.isPending ||
                  renewWithBalance.isPending ||
                  (payMode === "gateway" && paymentMethods.length === 0) ||
                  (payMode === "balance" && !isFreeRenew && (walletLoading || !renewBalanceEnough))
                }
              >
                {(createOrder.isPending || renewWithBalance.isPending) ? <RefreshCw className="forwardx-icon-spin mr-2 h-4 w-4" /> : <ShoppingBag className="mr-2 h-4 w-4" />}
                {isFreeRenew ? "免费续期" : payMode === "balance" ? (walletLoading ? "余额加载中" : renewBalanceEnough ? "余额续费" : "余额不足") : "去支付"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <WalletCards className="h-5 w-5" />
                购买附加流量
              </DialogTitle>
              <DialogDescription>
                {selected?.sub?.planName || "当前套餐"} · {selected ? formatQuotaBytes(selected.addon.trafficBytes) : "-"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-muted-foreground">价格</span>
                <span className="font-medium">{money(selected?.addon?.priceCents)}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-muted-foreground">余额</span>
                <AnimatedStatValue
                  as="span"
                  value={money(balance)}
                  loading={walletLoading}
                  cacheKey="subscriptions.wallet.balance.addon"
                  fallbackValue={money(0)}
                  className={balanceEnough ? "font-medium" : "font-medium text-destructive"}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-muted-foreground">有效期</span>
                <span className="font-medium">{dateTime(selected ? cycleEnd(selected.sub) : null)}</span>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setSelected(null)}>取消</Button>
              <Button
                onClick={() => selected && purchaseAddon.mutate({ addonId: Number(selected.addon.id), subscriptionId: Number(selected.sub.id) })}
                disabled={!selected || purchaseAddon.isPending || walletLoading || !balanceEnough}
              >
                {purchaseAddon.isPending ? <RefreshCw className="forwardx-icon-spin mr-2 h-4 w-4" /> : <ShoppingBag className="mr-2 h-4 w-4" />}
                {walletLoading ? "余额加载中" : balanceEnough ? "余额购买" : "余额不足"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {paymentDialog.dialog}
      </div>
    </DashboardLayout>
  );
}
