/**
 * 支付设置页的「订单记录」。
 *
 * 从 Payments 页面拆出来并 memo：原来它和三十多个配置输入框同在一个组件里，每敲一个键，
 * 一百条订单（手机卡片 + 表格各一遍）全部重画。现在它只在自己的查询 / 选择变化时重画，
 * 而且每个断点只渲染一种列表（useIsMobile 判定，手机卡片或表格），DOM 少一半。
 *
 * 列表在服务端分页（payment.listOrdersPage，和账单页的 PersistentPagination 同一套）：
 * 原来只拿最近 100 条，更早的订单在面板上翻不到。页码记在 localStorage，筛选一变回到第一页。
 */

import DataSectionError, { DataTableErrorRow } from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import EmptyState from "@/components/EmptyState";
import MobileInfoRow from "@/components/MobileInfoRow";
import { PersistentPagination, usePersistentPageRequest, useServerPagination } from "@/components/PersistentPagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useIsMobile } from "@/hooks/useMobile";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { isPaymentOrderDeletable } from "@shared/paymentOrderDeletion";
import { CreditCard, Trash2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PAYMENT_ORDER_STATUS_LABELS, formatDate, formatMoney, paymentTypeLabel, providerLabel, statusBadge } from "./paymentOrderFormat";

/**
 * 一行订单在这里用到的字段。payment 路由的输出类型推不出来（和原来页面里 `(order: any)` 是同一个原因），
 * 所以按用到的字段写一份结构类型，不在组件里散落 any。
 */
type PaymentOrderRow = {
  id: number | string;
  outTradeNo: string;
  userId: number;
  username?: string | null;
  name?: string | null;
  provider: string;
  paymentType: string;
  status: string;
  amountCents: number;
  currency: string;
  tradeNo?: string | null;
  createdAt: unknown;
  paidAt?: unknown;
};

const PAGE_SIZE = 20;
const EMPTY_ORDERS: PaymentOrderRow[] = [];
/** 筛选下拉里列的状态，按订单的生命周期排。 */
const STATUS_FILTERS = ["pending", "paid", "processing", "completed", "expired", "cancelled", "failed"] as const;

export const PaymentOrdersCard = memo(function PaymentOrdersCard() {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const isMobile = useIsMobile();
  const pageRequest = usePersistentPageRequest("forwardx.payments.orders.page");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  // 搜索停手 300 ms 再查，期间留着上一页的结果 —— 不然每敲一个键整张表闪一次「加载中」。
  const keyword = useDebouncedValue(search.trim(), 300);
  const query = trpc.payment.listOrdersPage.useQuery(
    { page: pageRequest.page, pageSize: PAGE_SIZE, status: status === "all" ? undefined : status, keyword: keyword || undefined },
    { refetchInterval: pollingInterval("slow"), placeholderData: (previous) => previous },
  );
  /*
    换筛选回到第一页。用 ref 记住上一次的筛选而不是直接 useEffect([status, keyword])：
    那样首次挂载也会跑一次，把 localStorage 里记着的页码当场清成 1，持久化就白做了。
  */
  const filterKey = `${status}\u0000${keyword}`;
  const lastFilterKey = useRef(filterKey);
  const setPage = pageRequest.setPage;
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    setPage(1);
  }, [filterKey, setPage]);

  const orders = (query.data?.items as PaymentOrderRow[] | undefined) ?? EMPTY_ORDERS;
  const pagination = useServerPagination(
    orders,
    Number(query.data?.totalItems || 0),
    pageRequest,
    { pageSize: PAGE_SIZE, isReady: !query.isLoading && !!query.data },
  );

  /*
    删除未支付订单（上游 2.3.298）：只有没付过款的（待支付 / 已过期 / 已取消 / 失败）能勾、能删。
    这里按列表里的状态先挑一遍，服务端锁住订单行后再判一次 —— 列表是几秒前的，期间可能刚好付了款。
  */
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>([]);
  const deletableOrderIds = useMemo<number[]>(
    () => orders.filter((order) => isPaymentOrderDeletable(order)).map((order) => Number(order.id)),
    [orders],
  );
  useEffect(() => {
    // 列表刷新（或翻页）后，已经不在 / 不能删的订单从勾选里拿掉
    const allowed = new Set(deletableOrderIds);
    setSelectedOrderIds((current) => (current.every((id) => allowed.has(id)) ? current : current.filter((id) => allowed.has(id))));
  }, [deletableOrderIds]);
  const deleteOrders = trpc.payment.deleteOrders.useMutation({
    onSuccess: (result) => {
      void utils.payment.listOrdersPage.invalidate();
      void utils.payment.stats.invalidate();
      const deletedIds = new Set(result.deleted.map((item) => Number(item.id)));
      setSelectedOrderIds((current) => current.filter((id) => !deletedIds.has(id)));
      if (result.skipped.length > 0) {
        toast.error(`已删除 ${result.deleted.length} 笔，${result.skipped.length} 笔未删除：${result.skipped[0].reason}`);
      } else {
        toast.success(`已删除 ${result.deleted.length} 笔未支付订单`);
      }
    },
    onError: (error) => toast.error(error.message || "删除订单失败"),
  });
  const confirmDeleteOrders = async (ids: number[]) => {
    if (ids.length === 0) return;
    const ok = await confirmDialog({
      title: "删除未支付订单",
      description: `确认删除 ${ids.length} 笔未支付订单？占用的套餐库存和折扣码会退回；删除后客户若仍完成付款，实付金额会自动转入其余额。`,
      confirmText: "删除",
      tone: "destructive",
    });
    if (ok) deleteOrders.mutate({ ids });
  };
  const toggleOrderSelected = (id: number, checked: boolean) => {
    setSelectedOrderIds((current) => (checked ? Array.from(new Set([...current, id])) : current.filter((item) => item !== id)));
  };
  const allDeletableSelected = deletableOrderIds.length > 0 && deletableOrderIds.every((id) => selectedOrderIds.includes(id));

  // 「暂无支付订单」会让人以为客户没付。读失败时说这句最要命。
  const emptyOrError = orders.length === 0
    ? (query.error ? "error" : "empty")
    : null;

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>订单记录</CardTitle>
          <CardDescription>套餐订单和测试订单。未支付的订单可以删除，已支付的不能删。</CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={selectedOrderIds.length === 0 || deleteOrders.isPending}
          onClick={() => { void confirmDeleteOrders(selectedOrderIds); }}
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          删除所选{selectedOrderIds.length > 0 ? `（${selectedOrderIds.length}）` : ""}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="按订单号、网关流水、用户名搜"
            aria-label="搜索订单"
            className="h-8 max-w-xs text-xs"
          />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger aria-label="按状态筛选订单" className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {STATUS_FILTERS.map((value) => <SelectItem key={value} value={value}>{PAYMENT_ORDER_STATUS_LABELS[value]}</SelectItem>)}
            </SelectContent>
          </Select>
          {query.data ? <span className="text-xs text-muted-foreground">共 {pagination.totalItems} 笔</span> : null}
        </div>
        {query.isLoading ? (
          <DataSectionLoading label="正在加载支付订单" />
        ) : isMobile ? (
          <div className="grid gap-3">
            {orders.map((order) => (
              <div key={order.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{order.name || order.username || `#${order.userId}`}</p>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{order.outTradeNo}</p>
                  </div>
                  <div className="shrink-0 text-right text-sm font-semibold tabular-nums">
                    {formatMoney(order.amountCents, order.currency)}
                  </div>
                </div>
                <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                  <MobileInfoRow label="通道">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Badge variant="secondary">{providerLabel(order.provider)}</Badge>
                      <Badge variant="outline">{paymentTypeLabel(order.paymentType)}</Badge>
                    </div>
                  </MobileInfoRow>
                  <MobileInfoRow label="状态">{statusBadge(order.status)}</MobileInfoRow>
                  <MobileInfoRow label="网关流水" valueClassName="font-mono text-xs text-muted-foreground">
                    {order.tradeNo || "-"}
                  </MobileInfoRow>
                  <MobileInfoRow label="创建时间">{formatDate(order.createdAt)}</MobileInfoRow>
                  <MobileInfoRow label="支付时间">{formatDate(order.paidAt)}</MobileInfoRow>
                </div>
                {isPaymentOrderDeletable(order) && (
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/40 pt-3">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        aria-label={`选择订单 ${order.outTradeNo}`}
                        checked={selectedOrderIds.includes(Number(order.id))}
                        onCheckedChange={(checked) => toggleOrderSelected(Number(order.id), checked === true)}
                      />
                      选择
                    </label>
                    <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={deleteOrders.isPending} onClick={() => { void confirmDeleteOrders([Number(order.id)]); }}>
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />删除
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {emptyOrError === "error" ? (
              <DataSectionError
                label="支付订单"
                error={query.error}
                retrying={query.isFetching}
                onRetry={() => { void query.refetch(); }}
                minHeight="min-h-[120px]"
              />
            ) : emptyOrError === "empty" ? (
              <EmptyState icon={<CreditCard />} title="暂无支付订单" />
            ) : null}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="全选未支付订单"
                      disabled={deletableOrderIds.length === 0}
                      checked={allDeletableSelected}
                      onCheckedChange={(checked) => setSelectedOrderIds(checked === true ? deletableOrderIds : [])}
                    />
                  </TableHead>
                  <TableHead>订单号</TableHead>
                  <TableHead>用户</TableHead>
                  <TableHead>通道</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>网关流水</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>支付时间</TableHead>
                  <TableHead className="w-16 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell>
                      {isPaymentOrderDeletable(order) ? (
                        <Checkbox
                          aria-label={`选择订单 ${order.outTradeNo}`}
                          checked={selectedOrderIds.includes(Number(order.id))}
                          onCheckedChange={(checked) => toggleOrderSelected(Number(order.id), checked === true)}
                        />
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{order.outTradeNo}</TableCell>
                    <TableCell>{order.name || order.username || `#${order.userId}`}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="secondary">{providerLabel(order.provider)}</Badge>
                        <Badge variant="outline">{paymentTypeLabel(order.paymentType)}</Badge>
                      </div>
                    </TableCell>
                    <TableCell>{formatMoney(order.amountCents, order.currency)}</TableCell>
                    <TableCell>{statusBadge(order.status)}</TableCell>
                    <TableCell className="font-mono text-xs">{order.tradeNo || "-"}</TableCell>
                    <TableCell>{formatDate(order.createdAt)}</TableCell>
                    <TableCell>{formatDate(order.paidAt)}</TableCell>
                    <TableCell className="text-right">
                      {isPaymentOrderDeletable(order) ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive"
                          aria-label={`删除订单 ${order.outTradeNo}`}
                          disabled={deleteOrders.isPending}
                          onClick={() => { void confirmDeleteOrders([Number(order.id)]); }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
                {emptyOrError === "error" ? (
                  <DataTableErrorRow
                    colSpan={10}
                    label="支付订单"
                    error={query.error}
                    retrying={query.isFetching}
                    onRetry={() => { void query.refetch(); }}
                  />
                ) : emptyOrError === "empty" ? (
                  <TableRow>
                    <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                      暂无支付订单
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        )}
        <PersistentPagination pagination={pagination} itemName="笔订单" />
      </CardContent>
    </Card>
  );
});
