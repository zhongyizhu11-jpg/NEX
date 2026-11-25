/**
 * 支付订单在界面上怎么写：时间、通道 / 支付方式的中文名、状态徽章。
 *
 * 原来都写在 Payments 页面文件里；订单记录拆成独立组件（PaymentOrdersCard）之后，
 * 概览条（已支付金额）和订单卡两边都要用，放到这里一份。
 * 金额不在这里：走 shared/formatMoney 的 formatMoneyCents，和钱包 / 账单页同一种写法
 * （原来这边写「12.34 CNY」、那边写「¥12.34」，同一笔钱两个页面两个样）。
 */

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/formatTime";

export function formatDate(value: unknown) {
  return formatDateTime(value, "-");
}

export function paymentTypeLabel(value: string) {
  if (value === "alipay") return "支付宝";
  if (value === "wxpay") return "微信";
  if (value === "stripe") return "Stripe";
  if (value === "usdt") return "USDT";
  return value;
}

export function providerLabel(value: string) {
  if (value === "easypay") return "易支付";
  if (value === "alipay") return "支付宝官方";
  if (value === "wxpay") return "微信官方";
  if (value === "stripe") return "Stripe";
  if (value === "gmpay") return "GM Pay";
  return value;
}

/** 状态值 → 中文。订单记录的筛选下拉也用这张表，所以单独导出。 */
export const PAYMENT_ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  processing: "处理中",
  completed: "已完成",
  expired: "已过期",
  cancelled: "已取消",
  failed: "失败",
};

export function statusBadge(status: string) {
  const tone = status === "paid" || status === "processing" || status === "completed"
    ? "border-[var(--fx-healthy-soft)] bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]"
    : status === "pending"
      ? "border-[var(--fx-warn-soft)] bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]"
      : "border-border bg-muted text-muted-foreground";
  return <Badge variant="outline" className={tone}>{PAYMENT_ORDER_STATUS_LABELS[status] || status}</Badge>;
}
