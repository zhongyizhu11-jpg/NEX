/*
  哪些支付订单能删（上游 2.3.298「删除未支付订单」）。前端据此决定显不显示勾选框 / 删除按钮，
  服务端在锁住订单行之后用同一条规则再判一次（server/repositories/billingRepository.ts）。

  只删「从没付过款」的：状态是待支付 / 已过期 / 已取消 / 失败，而且没有付款时间、没有网关付款回调
  （rawNotify：金额对不上被拒的那种 failed 单是网关说过「付了」的，留着对账）。已支付、处理中、
  已完成的一律不能删 —— 那是收过钱的凭证。
*/

export const DELETABLE_PAYMENT_ORDER_STATUSES = ["pending", "expired", "cancelled", "failed"] as const;

/** 一次最多删多少笔：和其它批量删除一个量级。 */
export const MAX_PAYMENT_ORDER_DELETE_BATCH = 500;

export type PaymentOrderDeletionCandidate = {
  status?: string | null;
  paidAt?: unknown;
  rawNotify?: unknown;
};

/** 返回不能删的原因；能删返回 null。 */
export function paymentOrderUndeletableReason(order: PaymentOrderDeletionCandidate): string | null {
  const status = String(order.status || "");
  if (!(DELETABLE_PAYMENT_ORDER_STATUSES as readonly string[]).includes(status)) return "已支付或已完成的订单不能删除";
  if (order.paidAt) return "这笔订单有付款时间，不能删除";
  if (order.rawNotify !== null && order.rawNotify !== undefined && String(order.rawNotify).trim() !== "") {
    return "这笔订单收到过支付网关的付款通知，留着对账，不能删除";
  }
  return null;
}

/** 前端用：列表行里没带 rawNotify 时只按状态和付款时间判断，最终以服务端为准。 */
export function isPaymentOrderDeletable(order: PaymentOrderDeletionCandidate) {
  return paymentOrderUndeletableReason(order) === null;
}
