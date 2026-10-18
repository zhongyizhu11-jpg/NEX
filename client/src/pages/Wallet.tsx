import { FormField } from "@/components/ui/form-field";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { useAuth } from "@/_core/hooks/useAuth";
import { forwardAccessRestoredNote } from "@shared/forwardAccessMessage";
import { ledgerTone } from "@/lib/ledgerTone";
import { balanceTypeLabel } from "@shared/ledgerLabels";
import { formatMoneyCents as money } from "@shared/formatMoney";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import DashboardLayout from "@/components/DashboardLayout";
import EmptyState from "@/components/EmptyState";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError, { DataTableErrorRow } from "@/components/DataSectionError";
import { LedgerRow, ledgerMeta } from "@/components/LedgerRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { usePaymentOrderDialog } from "@/components/PaymentOrderDialog";
import { PersistentPagination, usePersistentPageRequest, useServerPagination } from "@/components/PersistentPagination";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { queryErrorHint } from "@/lib/queryErrorMessage";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, CreditCard, Gift, Package, ReceiptText, RefreshCw, WalletCards } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type PaymentType = "alipay" | "wxpay" | "stripe" | "usdt";

function dateText(value?: string | Date | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN");
}

function orderTypeText(type?: string | null) {
  if (type === "plan") return "套餐";
  if (type === "test") return "测试";
  return "余额";
}

function paymentMethodText(type?: string | null) {
  if (type === "alipay") return "支付宝";
  if (type === "wxpay") return "微信支付";
  if (type === "stripe") return "Stripe";
  if (type === "usdt" || type === "gmpay") return "USDT";
  return type || "-";
}

function ledgerIcon(item: any) {
  if (item.kind === "payment") return CreditCard;
  if (item.kind === "subscription") return Package;
  return WalletCards;
}

export default function Wallet() {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const {
    data: wallet,
    isLoading: walletLoading,
    error: walletError,
    isFetching: walletFetching,
    refetch: refetchWallet,
  } = trpc.billing.me.useQuery(undefined, { placeholderData: (previousData) => previousData });
  // 账单服务端分页（上游 2.3.285）：原来只拿最近 150 条，更早的翻不到。
  const ledgerPageRequest = usePersistentPageRequest("forwardx.wallet.ledger.page");
  const ledgerQuery = trpc.billing.ledgerPage.useQuery(
    { page: ledgerPageRequest.page, pageSize: 30 },
    { placeholderData: (previousData) => previousData },
  );
  const ledger = (ledgerQuery.data?.items || []) as any[];
  const ledgerLoading = ledgerQuery.isLoading;
  const ledgerError = ledgerQuery.error;
  const ledgerFetching = ledgerQuery.isFetching;
  const refetchLedger = ledgerQuery.refetch;
  const ledgerPagination = useServerPagination(
    ledger,
    Number(ledgerQuery.data?.totalItems || 0),
    ledgerPageRequest,
    { pageSize: 30, isReady: !ledgerLoading && !!ledgerQuery.data },
  );
  const { data: billingFeatures } = trpc.billing.featureStatus.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const {
    data: paymentOrders = [],
    isLoading: paymentOrdersLoading,
    error: paymentOrdersError,
    isFetching: paymentOrdersFetching,
    refetch: refetchPaymentOrders,
  } = trpc.payment.myOrders.useQuery({ limit: 50 }, { placeholderData: (previousData: any) => previousData });
  const { data: paymentMethods = [] } = trpc.payment.availableMethods.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [amount, setAmount] = useState("50");
  const [paymentType, setPaymentType] = useState<PaymentType>("stripe");
  const [redeemCode, setRedeemCode] = useState("");

  // 扫码支付（微信 Native / 支付宝当面付）要渲染二维码；跳转支付被拦截时要有能点的链接
  const paymentDialog = usePaymentOrderDialog({
    onPaid: () => {
      utils.payment.myOrders.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
    },
  });

  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success("充值订单已创建");
      setRechargeOpen(false);
      utils.payment.myOrders.invalidate();
      utils.billing.ledgerPage.invalidate();
      paymentDialog.launch(order);
    },
    onError: (error) => toast.error(error.message || "创建订单失败"),
  });

  const redeem = trpc.billing.redeem.useMutation({
    onSuccess: (data) => {
      /*
        余额耗尽被停了转发的人，兑换一张码往往就是为了把转发救回来。
        服务端算出来了，这里必须说 —— 只说「兑换成功」他还得自己去试。
      */
      const note = forwardAccessRestoredNote((data as any)?.forwardAccessRestored, "self");
      toast.success(note ? `已兑换 · ${note}` : "已兑换");
      setRedeemCode("");
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
      utils.plans.mySubscriptions.invalidate();
    },
    onError: (error) => toast.error(error.message || "兑换失败"),
  });

  const openRecharge = () => {
    const first = paymentMethods[0]?.value as PaymentType | undefined;
    if (first) setPaymentType(first);
    setRechargeOpen(true);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <WorkspaceHeader title={<>账单中心</>} description={<>余额、充值和订单记录。</>} />
          <Button onClick={openRecharge}>
            <CreditCard className="mr-2 h-4 w-4" />
            自助充值
          </Button>
        </div>

        <div className={`grid gap-4 ${billingFeatures?.redemptionEnabled ? "md:grid-cols-2" : ""}`}>
          <Card>
            <CardHeader>
              <CardDescription>当前余额</CardDescription>
              {/*
                余额读不到时**不能**显示 ¥0.00。这一页上的每个数字都是钱：把「没取到」
                画成「你没有钱」，看到的人下一步就是再充一次。
              */}
              {walletError && !wallet ? (
                <div className="space-y-2">
                  <CardTitle className="text-2xl text-muted-foreground">余额没读到</CardTitle>
                  <p className="text-xs text-muted-foreground">{queryErrorHint(walletError) || "这一次没取到，不是余额为零。"}</p>
                  <Button variant="outline" size="sm" onClick={() => { void refetchWallet(); }} disabled={walletFetching}>
                    <RefreshCw className={`mr-2 h-3.5 w-3.5 ${walletFetching ? "forwardx-icon-spin" : ""}`} />
                    重试
                  </Button>
                </div>
              ) : (
                <AnimatedStatValue
                  as={CardTitle}
                  value={money(wallet?.balanceCents)}
                  loading={walletLoading}
                  cacheKey={`wallet.balance.${user?.id || "current"}`}
                  fallbackValue={money(0)}
                  className="text-4xl"
                />
              )}
            </CardHeader>
          </Card>

          {billingFeatures?.redemptionEnabled && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Gift className="h-5 w-5" />
                  兑换码
                </CardTitle>
                <CardDescription>输入兑换码即可使用。</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 sm:flex-row">
                <Input
                  value={redeemCode}
                  onChange={(event) => setRedeemCode(event.target.value.toUpperCase())}
                  placeholder="输入兑换码"
                />
                <Button onClick={() => redeem.mutate({ code: redeemCode.trim() })} disabled={!redeemCode.trim() || redeem.isPending}>
                  {redeem.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                  兑换
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ReceiptText className="h-5 w-5" />
              账单流水
            </CardTitle>
            <CardDescription>按时间查看全部记录。</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {ledgerLoading ? (
              <DataSectionLoading label="正在加载账单流水" />
            ) : (
            <>
            {/* 手机上不画表：六列挤进 393px，「类型」那一列会被压成一个字一行。 */}
            <div className="md:hidden" data-testid="ledger-mobile">
              {ledger.length === 0 ? (
                ledgerError ? (
                  <DataSectionError label="账单流水" error={ledgerError} retrying={ledgerFetching} onRetry={() => { void refetchLedger(); }} minHeight="min-h-[120px]" />
                ) : (
                  <EmptyState icon={<ReceiptText />} title="暂无账单流水" />
                )
              ) : ledger.map((item: any) => {
                const Icon = ledgerIcon(item);
                return (
                  <LedgerRow
                    key={item.id}
                    icon={<Icon className="h-4 w-4" />}
                    title={item.title}
                    meta={ledgerMeta(item.description, item.category !== item.title && item.category, item.statusLabel || item.status, dateText(item.createdAt))}
                    amount={item.kind === "subscription" && Number(item.amountCents || 0) === 0 ? "-" : money(item.amountCents, item.currency || "CNY")}
                    amountClassName={ledgerTone(item)}
                  />
                );
              })}
            </div>
            <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>项目</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>关联信息</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.map((item: any) => {
                  const Icon = ledgerIcon(item);
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="flex min-w-56 items-start gap-3">
                          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/30">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{item.title}</p>
                            <p className="truncate text-xs text-muted-foreground">{item.description || "-"}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell><Badge variant="outline">{item.category}</Badge></TableCell>
                      <TableCell className={ledgerTone(item)}>
                        {item.kind === "subscription" && Number(item.amountCents || 0) === 0 ? "-" : money(item.amountCents, item.currency || "CNY")}
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.status === "completed" || item.status === "paid" || item.status === "active" ? "default" : "secondary"}>
                          {item.statusLabel || item.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {item.paymentOrderNo || item.tradeNo || (item.planId ? `plan#${item.planId}` : "-")}
                      </TableCell>
                      <TableCell>{dateText(item.createdAt)}</TableCell>
                    </TableRow>
                  );
                })}
                {ledger.length === 0 && (ledgerError ? (
                  <DataTableErrorRow
                    colSpan={6}
                    label="账单流水"
                    error={ledgerError}
                    retrying={ledgerFetching}
                    onRetry={() => { void refetchLedger(); }}
                  />
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      暂无账单流水
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
            <PersistentPagination pagination={ledgerPagination} itemName="条账单" />
            </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <WalletCards className="h-5 w-5" />
              余额流水
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {walletLoading ? (
              <DataSectionLoading label="正在加载余额流水" />
            ) : (
            <>
            <div className="md:hidden" data-testid="wallet-mobile">
              {(wallet?.transactions || []).length === 0 ? (
                <EmptyState icon={<WalletCards />} title="暂无余额流水" />
              ) : (wallet?.transactions || []).map((tx: any) => (
                <LedgerRow
                  key={tx.id}
                  title={tx.typeLabel || balanceTypeLabel(tx.type)}
                  meta={ledgerMeta(tx.description, `余额 ${money(tx.balanceAfterCents)}`, dateText(tx.createdAt))}
                  amount={money(tx.amountCents)}
                  amountClassName={Number(tx.amountCents) >= 0 ? "text-[var(--fx-healthy-text)]" : "text-destructive"}
                />
              ))}
            </div>
            <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>类型</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>余额</TableHead>
                  <TableHead>说明</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(wallet?.transactions || []).map((tx: any) => (
                  <TableRow key={tx.id}>
                    <TableCell>
                      <Badge variant="outline">{tx.typeLabel || balanceTypeLabel(tx.type)}</Badge>
                    </TableCell>
                    <TableCell className={Number(tx.amountCents) >= 0 ? "text-[var(--fx-healthy-text)]" : "text-destructive"}>
                      {money(tx.amountCents)}
                    </TableCell>
                    <TableCell>{money(tx.balanceAfterCents)}</TableCell>
                    <TableCell>{tx.description || "-"}</TableCell>
                    <TableCell>{dateText(tx.createdAt)}</TableCell>
                  </TableRow>
                ))}
                {(!wallet?.transactions || wallet.transactions.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      暂无余额流水
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            </div>
            </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              支付流水
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {paymentOrdersLoading ? (
              <DataSectionLoading label="正在加载支付流水" />
            ) : (
            <>
            <div className="md:hidden" data-testid="payments-mobile">
              {paymentOrders.length === 0 ? (
                paymentOrdersError ? (
                  <DataSectionError label="支付流水" error={paymentOrdersError} retrying={paymentOrdersFetching} onRetry={() => { void refetchPaymentOrders(); }} minHeight="min-h-[120px]" />
                ) : (
                  <EmptyState icon={<CreditCard />} title="暂无支付流水" />
                )
              ) : paymentOrders.map((order: any) => (
                <LedgerRow
                  key={order.id}
                  title={orderTypeText(order.orderType)}
                  meta={ledgerMeta(order.outTradeNo, paymentMethodText(order.paymentType || order.provider), order.status, dateText(order.createdAt))}
                  amount={money(order.amountCents, order.currency || "CNY")}
                />
              ))}
            </div>
            <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>订单号</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>支付方式</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentOrders.map((order: any) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono text-xs">{order.outTradeNo}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{orderTypeText(order.orderType)}</Badge>
                    </TableCell>
                    <TableCell>{paymentMethodText(order.paymentType || order.provider)}</TableCell>
                    <TableCell>{money(order.amountCents, order.currency || "CNY")}</TableCell>
                    <TableCell>
                      <Badge variant={order.status === "completed" || order.status === "paid" ? "default" : "secondary"}>
                        {order.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{dateText(order.createdAt)}</TableCell>
                  </TableRow>
                ))}
                {paymentOrders.length === 0 && (paymentOrdersError ? (
                  <DataTableErrorRow
                    colSpan={6}
                    label="支付流水"
                    error={paymentOrdersError}
                    retrying={paymentOrdersFetching}
                    onRetry={() => { void refetchPaymentOrders(); }}
                  />
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      暂无支付流水
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
            </>
            )}
          </CardContent>
        </Card>

        {paymentDialog.dialog}

        <Dialog open={rechargeOpen} onOpenChange={setRechargeOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>自助充值</DialogTitle>
              <DialogDescription>充值成功后自动入账。</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <FormField className="space-y-2">
                <Label>充值金额</Label>
                <Input type="number" min={0.01} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
              </FormField>
              <FormField className="space-y-2">
                <Label>支付方式</Label>
                <Select value={paymentType} onValueChange={(value: PaymentType) => setPaymentType(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择支付方式" />
                  </SelectTrigger>
                  <SelectContent>
                    {paymentMethods.map((method: any) => (
                      <SelectItem key={method.value} value={method.value}>
                        {method.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRechargeOpen(false)}>
                取消
              </Button>
              <Button
                onClick={() => createOrder.mutate({ amount: Number(amount), paymentType, returnPath: "/wallet" })}
                disabled={!amount || paymentMethods.length === 0 || createOrder.isPending}
              >
                {createOrder.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
                去支付
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
