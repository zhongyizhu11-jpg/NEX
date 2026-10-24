import WorkspaceHeader from "@/components/WorkspaceHeader";
import { PlanDescriptionView } from "@/components/plans/PlanDescription";
import DashboardLayout from "@/components/DashboardLayout";
import EmptyState from "@/components/EmptyState";
import { pricePerGbMilliCentsOf } from "@shared/trafficBillingPrice";
import { formatQuotaBytes } from "@shared/formatBytes";
import { formatMoneyCents as money, formatMoneyMilliCents as moneyFromMilliCents } from "@shared/formatMoney";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { EntityCard } from "@/components/entity/EntityCard";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { useUrlTab } from "@/hooks/useUrlTab";
import { planResourceText } from "@/lib/planDisplay";
import { trpc } from "@/lib/trpc";
import { formatTrafficMultiplier } from "@shared/trafficMultiplier";
import {
  defaultPricingOption,
  findPricingOption,
  planDurationLabel,
  planPricingOptions,
  type PlanPricingOption,
  planMonthlyEquivalentCents,
} from "@shared/planPricing";
import { Check, CheckCircle2, Coins, CreditCard, Lock, Package, RefreshCw, Route, Server, ShoppingBag, TicketPercent, WalletCards } from "lucide-react";
import { useMemo, useState } from "react";
import { usePaymentOrderDialog } from "@/components/PaymentOrderDialog";
import { toast } from "sonner";

function speed(value?: number | null) {
  const num = Number(value || 0);
  return num > 0 ? `${parseFloat(num.toFixed(2))} Mbps` : "不限";
}

// 周期名称与管理端共用 shared/planPricing 那一份，免得两处各写一遍。

type StoreTab = "plans" | "billing";
const STORE_TABS = ["plans", "billing"] as const;
const STORE_TAB_STORAGE_KEY = "forwardx.store.tab";

function durationLabel(days?: number | null) {
  return planDurationLabel(days);
}

function planDescription(plan: any) {
  return String(plan?.description || "").trim();
}

function billingDescription(config: any) {
  return String(config?.description || "").trim();
}

function effectiveBillingPriceMilliCents(config: any) {
  return Math.round(pricePerGbMilliCentsOf(config) * Number(config.multiplier || 100) / 100);
}

function planBenefitItems(plan: any) {
  const items = [
    `连续端口 ${plan.portCount || 0} 个`,
    `套餐流量 ${formatQuotaBytes(plan.trafficLimit)}`,
    `限速 ${speed(plan.rateLimitMbps)}`,
    `规则 ${plan.maxRules || "不限"} · 连接 ${plan.maxConnections || "不限"} · 单 IP ${plan.maxIPs || "不限"}`,
    "计数范围：端口转发按主机，隧道转发按隧道",
    `可用资源 ${planResourceText(plan)}`,
  ];
  // 附带节点是买点，得写在卡片上 —— 买之前看不到，买完才发现订阅里有节点，
  // 等于白送了个卖点。
  const proxyNodeCount = Array.isArray(plan.proxyNodeIds) ? plan.proxyNodeIds.length : 0;
  if (proxyNodeCount > 0) items.splice(1, 0, `附带落地节点 ${proxyNodeCount} 个（自动进订阅）`);
  if (Number(plan.durationDays || 0) > 30 && Number(plan.trafficLimit || 0) > 0) {
    items.splice(2, 0, "购买日起按月重置套餐流量");
  }
  return items;
}

function StorePlanCard({
  plan,
  purchasing,
  onBuy,
}: {
  plan: any;
  purchasing?: boolean;
  /** 买的是哪一档 —— 卡片上选的那一档要一路带到收银台，不能到那儿又变回默认。 */
  onBuy: (option: PlanPricingOption) => void;
}) {
  const benefits = planBenefitItems(plan);
  const options = useMemo(() => planPricingOptions(plan, plan?.priceTiers), [plan]);
  /**
   * 默认选总价最低那一档，不是每天最划算的那档（通常是年付）—— 一进商店就默认
   * 选中金额最大的那个，点错一下就是一年的钱。省多少用角标标出来就够了。
   */
  const [selectedDays, setSelectedDays] = useState<number>(() => defaultPricingOption(options)?.durationDays ?? 30);
  const active = findPricingOption(options, selectedDays) || defaultPricingOption(options) || options[0];

  /*
    V1 这张卡是五层：顶上一条渐变装饰线、一个图标方块、「周期 / 端口」两个小框（套在一个
    灰框里，第一格还浮起来一层）、一个装权益的框、最底下价格。周期就写在价格后面
    （「/ 一个月」），端口就是权益第一条「连续端口 20 个」—— 那两个小框把同样的话又说了
    一遍，而买的人最先找的价格压在最底下。

    现在是一块白：名字 → 价格（一眼先看到）→ 多档时的周期切换（切了价格就在它上面变）
    → 权益清单 → 购买。
  */
  return (
    <EntityCard className="h-full p-[var(--fx-card-padding)]">
      <h3 className="line-clamp-1 text-primary-type font-semibold text-foreground">{plan.name}</h3>
      {/* div 不用 p：手机上 `.workspace-main p` 会在名字和说明之间再撑出 12px。 */}
      <PlanDescriptionView text={planDescription(plan)} fallback="订阅后自动开通端口段和可用资源。" />

      <div className="mt-4 flex flex-wrap items-baseline gap-x-1.5">
        <span className="break-words text-metric font-semibold tabular-nums text-foreground">
          {money(active?.priceCents ?? plan.priceCents, plan.currency)}
        </span>
        <span className="text-meta text-muted-foreground">
          / {durationLabel(active?.durationDays)}
          {/* 长周期总价更大，换算成每月多少钱才好跟月付比。 */}
          {options.length > 1 && active && active.durationDays >= 60
            ? ` · 约 ${money(planMonthlyEquivalentCents(active), plan.currency)} / 月`
            : ""}
        </span>
      </div>

      {/*
        多档时才出现这一排。只有一档的套餐（存量全是这样）看起来跟以前一模一样 ——
        一个按钮的切换器是纯噪音。
      */}
      {options.length > 1 ? (
        <div className={`${segmentedControlClassName} mt-3 flex flex-wrap gap-1`} role="group" aria-label="购买周期">
          {options.map((option) => {
            const isActive = option.durationDays === active?.durationDays;
            return (
              <button
                key={option.durationDays}
                type="button"
                aria-pressed={isActive}
                onClick={() => setSelectedDays(option.durationDays)}
                className={segmentedOptionClassName(isActive, false, "h-8 flex-1 px-2.5 text-xs")}
              >
                {durationLabel(option.durationDays)}
                {option.discountPercent > 0 ? (
                  <span className="text-[var(--fx-healthy-text)]">省 {option.discountPercent}%</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <ul className="mt-4 flex-1 space-y-2" aria-label="套餐权益">
        {benefits.map((item) => (
          <li key={item} className="flex items-start gap-2 text-secondary-type text-foreground">
            {/* 勾是「包含」，不是状态 —— 不染健康绿。 */}
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 break-words">{item}</span>
          </li>
        ))}
      </ul>

      <Button
        className="mt-5 w-full"
        onClick={() => active && onBuy(active)}
        disabled={purchasing || !active}
      >
        <ShoppingBag className="mr-2 h-4 w-4" />
        购买套餐
      </Button>
    </EntityCard>
  );
}

export default function Store() {
  const utils = trpc.useUtils();
  const {
    data: storeStatus,
    isLoading: storeStatusLoading,
    error: storeStatusError,
    isFetching: storeStatusFetching,
    refetch: refetchStoreStatus,
  } = trpc.plans.storeStatus.useQuery();
  const {
    data: plans = [],
    isLoading,
    error: plansError,
    isFetching: plansFetching,
    refetch: refetchPlans,
  } = trpc.plans.storeList.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const {
    data: trafficBillingStore,
    isLoading: trafficBillingLoading,
    error: trafficBillingError,
    isFetching: trafficBillingFetching,
    refetch: refetchTrafficBilling,
  } = trpc.trafficBilling.storeResources.useQuery(undefined, {
    enabled: !!storeStatus?.enabled,
    placeholderData: (previousData) => previousData,
  });
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const { data: billingFeatures } = trpc.billing.featureStatus.useQuery();
  const { data: paymentMethods = [] } = trpc.payment.availableMethods.useQuery(undefined, {
    enabled: !!storeStatus?.enabled,
    placeholderData: (previousData) => previousData,
  });
  const [selectedPlan, setSelectedPlan] = useState<any | null>(null);
  /** 卡片上选中的那一档。只有一档的套餐也会带上，省得后面到处判空。 */
  const [selectedOption, setSelectedOption] = useState<PlanPricingOption | null>(null);
  const [paymentType, setPaymentType] = useState<"alipay" | "wxpay" | "stripe" | "usdt">("stripe");
  const [selectedPayMode, setPayMode] = useState<"gateway" | "balance">("gateway");
  const [discountCode, setDiscountCode] = useState("");
  const [discountPreview, setDiscountPreview] = useState<any | null>(null);
  const [activeTab, setActiveTab] = useUrlTab<StoreTab>({
    values: STORE_TABS,
    defaultValue: "plans",
    storageKey: STORE_TAB_STORAGE_KEY,
  });

  // 扫码（precreate / native）或跳转支付（page / wap / stripe / h5）后的等待弹窗，和充值、续费共用
  const paymentDialog = usePaymentOrderDialog({
    onPaid: () => {
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
    },
  });

  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success("订单已创建");
      setSelectedPlan(null);
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
      paymentDialog.launch(order);
    },
    onError: (error) => toast.error(error.message || "创建订单失败"),
  });

  const buyWithBalance = trpc.billing.purchasePlanWithBalance.useMutation({
    onSuccess: () => {
      toast.success("套餐已购买");
      setSelectedPlan(null);
      setDiscountCode("");
      setDiscountPreview(null);
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
    },
    onError: (error) => toast.error(error.message || "购买失败"),
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

  const buy = (plan: any, option: PlanPricingOption) => {
    const firstMethod = paymentMethods[0]?.value as "alipay" | "wxpay" | "stripe" | "usdt" | undefined;
    if (firstMethod) setPaymentType(firstMethod);
    setPayMode(firstMethod ? "gateway" : "balance");
    setDiscountCode("");
    setDiscountPreview(null);
    // 卡片上选的那一档要带进弹窗：收银台里显示的金额、扣的钱、开的天数都按它。
    setSelectedOption(option);
    setSelectedPlan(plan);
  };

  const confirmBuy = () => {
    if (!selectedPlan) return;
    const durationDays = selectedOption?.durationDays;
    if (payMode === "balance") {
      buyWithBalance.mutate({
        planId: selectedPlan.id,
        durationDays,
        discountCode: billingFeatures?.discountEnabled ? discountCode.trim() || undefined : undefined,
      });
      return;
    }
    createOrder.mutate({
      amount: listPriceCents / 100,
      paymentType,
      planId: selectedPlan.id,
      planDurationDays: durationDays,
      discountCode: billingFeatures?.discountEnabled ? discountCode.trim() || undefined : undefined,
      returnPath: "/store",
    });
  };

  /** 这一单的原价：选了档就按那一档，没选（只有一档的套餐）按套餐主表价。 */
  const listPriceCents = Number(selectedOption?.priceCents ?? selectedPlan?.priceCents ?? 0);
  const finalAmountCents = discountPreview?.finalAmountCents ?? listPriceCents;
  /*
    免费套餐（或折扣抵到 0 元）走网关会带着 0 元去下单，服务端直接拒绝（最低 0.01）。
    这种单只能走余额通道：余额购买遇到 0 元不扣钱，直接开通。
  */
  const isFreeOrder = !!selectedPlan && finalAmountCents <= 0;
  const payMode: "gateway" | "balance" = isFreeOrder ? "balance" : selectedPayMode;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <WorkspaceHeader title={<>商店</>} description={<>购买套餐，开通资源。</>} />

        {storeStatusLoading && (
          <DataSectionLoading label="正在加载商店状态" />
        )}

        {/* 状态没读到就别替商店宣布关门 —— 那句话会让客户以为是管理员关的。 */}
        {!storeStatusLoading && storeStatusError && !storeStatus && (
          <DataSectionError
            label="商店状态"
            error={storeStatusError}
            retrying={storeStatusFetching}
            onRetry={() => { void refetchStoreStatus(); }}
          />
        )}

        {!storeStatusLoading && !storeStatusError && !storeStatus?.enabled && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Lock className="h-5 w-5" /> 商店暂未开启</CardTitle>
              <CardDescription>请联系管理员开通。</CardDescription>
            </CardHeader>
          </Card>
        )}

        {!storeStatusLoading && storeStatus?.enabled && (
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as StoreTab)} className="space-y-4">
            <TabsList className="grid h-auto w-full grid-cols-2 sm:w-auto">
              <TabsTrigger value="plans" className="gap-2">
                <Package className="h-4 w-4" /> 套餐
              </TabsTrigger>
              <TabsTrigger value="billing" className="gap-2">
                <Coins className="h-4 w-4" /> 按量计费
              </TabsTrigger>
            </TabsList>

            <TabsContent value="plans" className="mt-0">
              {isLoading ? (
                <DataSectionLoading label="正在加载商店套餐" />
              ) : (
                <AutoAnimateContainer className="standard-card-grid gap-4">
                  {plans.map((plan: any) => (
                    <StorePlanCard
                      key={plan.id}
                      plan={plan}
                      purchasing={createOrder.isPending || buyWithBalance.isPending}
                      onBuy={(option) => buy(plan, option)}
                    />
                  ))}
                  {/*
                    读取失败不能画成「管理员还没上架」—— 那是在替后端下一个它自己都不知道的
                    结论，客户会照着这句话去找管理员，而管理员那边什么问题都没有。
                  */}
                  {!isLoading && plans.length === 0 && (plansError ? (
                    <DataSectionError
                      className="col-span-full"
                      label="商店套餐"
                      error={plansError}
                      retrying={plansFetching}
                      onRetry={() => { void refetchPlans(); }}
                    />
                  ) : (
                    <EmptyState
                      className="col-span-full"
                      icon={<Package />}
                      title="暂无可购买套餐"
                      description="管理员还没有把套餐放上商店，需要的话可以联系他分配。"
                    />
                  ))}
                </AutoAnimateContainer>
              )}
            </TabsContent>

            <TabsContent value="billing" className="mt-0">
              {trafficBillingLoading ? (
                <DataSectionLoading label="正在加载按量计费资源" />
              ) : (
                <AutoAnimateContainer className="standard-card-grid gap-4">
                  {(trafficBillingStore?.configs || []).map((config: any) => (
                    /*
                      和套餐卡同一种画法：名字 → 单价 → 明细。原来底下还套着一个灰框写「该资源无需
                      购买套餐；账户有余额即可使用」—— 和明细最后一行「按实际计费流量从余额扣费」
                      是同一件事，并成一句。
                    */
                    <EntityCard key={`${config.resourceType}-${config.resourceId}`} className="h-full p-[var(--fx-card-padding)]">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="flex min-w-0 items-center gap-2 text-primary-type font-semibold text-foreground">
                          {config.resourceType === "host" ? <Server className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <Route className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                          <span className="truncate">{config.resourceName}</span>
                        </h3>
                        <Badge variant="outline">{config.resourceKind || (config.resourceType === "host" ? "整台主机" : config.resourceType === "tunnel" ? "隧道转发" : "转发资源")}</Badge>
                      </div>
                      <div className="mt-1 text-secondary-type text-muted-foreground">余额可用时可直接在转发规则中使用。</div>
                      <div className="mt-4 flex flex-wrap items-baseline gap-x-1.5">
                        <span className="text-metric font-semibold tabular-nums text-foreground">{moneyFromMilliCents(effectiveBillingPriceMilliCents(config))}</span>
                        <span className="text-meta text-muted-foreground">/ 计费 GB</span>
                      </div>
                      {billingDescription(config) ? (
                        <div className="mt-3 whitespace-pre-line break-words text-secondary-type text-muted-foreground">
                          {billingDescription(config)}
                        </div>
                      ) : (
                        <>
                          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-secondary-type">
                            <dt className="text-muted-foreground">基础单价</dt>
                            <dd className="tabular-nums text-foreground">{moneyFromMilliCents(pricePerGbMilliCentsOf(config))} / GB</dd>
                            <dt className="text-muted-foreground">倍率</dt>
                            <dd className="tabular-nums text-foreground">{config.multiplierText || formatTrafficMultiplier(config.multiplier || 100)}</dd>
                            <dt className="text-muted-foreground">资源编号</dt>
                            <dd className="font-mono text-foreground">#{config.resourceId}</dd>
                          </dl>
                          <div className="mt-3 text-meta text-muted-foreground">
                            创建规则时选择该资源，按实际计费流量从余额扣费；不用买套餐，账户有余额就能用。
                          </div>
                        </>
                      )}
                    </EntityCard>
                  ))}
                  {(trafficBillingStore?.configs || []).length === 0 && trafficBillingError && (
                    <DataSectionError
                      className="col-span-full"
                      label="按量计费资源"
                      error={trafficBillingError}
                      retrying={trafficBillingFetching}
                      onRetry={() => { void refetchTrafficBilling(); }}
                    />
                  )}
                  {(trafficBillingStore?.configs || []).length === 0 && !trafficBillingError && (
                    <EmptyState
                      className="col-span-full"
                      icon={<Coins />}
                      title="暂无公开按量计费资源"
                      description="管理员公开资源后会在这里展示倍率和单价。"
                    />
                  )}
                </AutoAnimateContainer>
              )}
            </TabsContent>
          </Tabs>
        )}

        {paymentDialog.dialog}

        <Dialog open={!!selectedPlan} onOpenChange={(open) => {
          if (open) return;
          setSelectedPlan(null);
          // 档位也一起清掉：留着的话，下次点另一张只有一档的卡会拿上一次的档去下单。
          setSelectedOption(null);
        }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                选择支付方式
              </DialogTitle>
              <DialogDescription>
                购买 {selectedPlan?.name || "套餐"}
                {selectedOption ? `（${durationLabel(selectedOption.durationDays)}）` : ""}
                ，金额 {selectedPlan ? money(finalAmountCents, selectedPlan.currency) : "-"}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">原价</span>
                  <span>{selectedPlan ? money(listPriceCents, selectedPlan.currency) : "-"}</span>
                </div>
                {discountPreview && (
                  <div className="mt-1 flex items-center justify-between text-[var(--fx-healthy-text)]">
                    <span>优惠</span>
                    <span>-{money(discountPreview.discountAmountCents, selectedPlan?.currency)}</span>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between font-medium">
                  <span>应付</span>
                  <span>{money(finalAmountCents, selectedPlan?.currency)}</span>
                </div>
              </div>
              {billingFeatures?.discountEnabled && (
              <div className="flex gap-2">
                <Input value={discountCode} onChange={(e) => setDiscountCode(e.target.value.toUpperCase())} placeholder="折扣码（可选）" />
                <Button
                  variant="outline"
                  onClick={() => selectedPlan && previewDiscount.mutate({ code: discountCode, amountCents: listPriceCents, planId: selectedPlan.id })}
                  disabled={!discountCode.trim() || previewDiscount.isPending}
                >
                  <TicketPercent className="mr-2 h-4 w-4" /> 应用
                </Button>
              </div>
              )}
              <div className="grid gap-2">
                {!isFreeOrder && (
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
                      value={money(wallet?.balanceCents)}
                      loading={walletLoading}
                      cacheKey="store.wallet.balance.inline"
                      fallbackValue={money(0)}
                      className="inline-block align-middle"
                    />
                    ）
                  </span>
                  {payMode === "balance" && <CheckCircle2 className="h-4 w-4" />}
                </button>
                )}
                {!isFreeOrder && paymentMethods.map((method: any) => (
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
                {isFreeOrder && (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    本单无需支付，确认后直接开通，不扣余额。
                  </div>
                )}
                {!isFreeOrder && paymentMethods.length === 0 && (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    暂无在线支付方式。
                  </div>
                )}
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setSelectedPlan(null)}>取消</Button>
              <Button onClick={confirmBuy} disabled={createOrder.isPending || buyWithBalance.isPending || (payMode === "gateway" && paymentMethods.length === 0) || (payMode === "balance" && walletLoading && !isFreeOrder)}>
                {(createOrder.isPending || buyWithBalance.isPending) ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ShoppingBag className="mr-2 h-4 w-4" />}
                {isFreeOrder ? "免费开通" : payMode === "balance" ? (walletLoading ? "余额加载中" : "余额购买") : "去支付"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
