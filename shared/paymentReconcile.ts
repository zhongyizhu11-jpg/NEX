/**
 * 主动查单：判断支付网关回来的那份 JSON 是不是「已付」。
 *
 * 为什么需要这件事：整条收款链路目前只靠**网关回调**。回调丢一次（网关那边网络
 * 抖、面板正好在重启、反代把 POST 拦了），订单就一直挂在 pending 直到过期 ——
 * 而客户那边钱已经付了。这是收款系统最典型的一种事故，业内叫「掉单」，标准解法
 * 就是面板自己隔一会儿去问一句「这单付了没」。
 *
 * 解析放在这里而不是 payment.ts：判断「付没付」是纯逻辑，判错的后果是白送服务
 * 或者收了钱不发货，值得单独测。网络那一半留在服务端。
 */

export type PaymentQueryResult = {
  /** 网关明确说付了。任何含糊的回答都不算。 */
  paid: boolean;
  /** 网关侧的交易号，便于对账；拿不到就是 null。 */
  tradeNo: string | null;
  /** 网关明确说这单不存在 / 已关闭，可以不用再问了。 */
  closed: boolean;
  /** 网关报的实付金额（分）。有就拿它和订单比对，跟回调走同一套校验。 */
  amountCents?: number;
  /** 网关报的币种。 */
  currency?: string;
};

const NOT_PAID: PaymentQueryResult = { paid: false, tradeNo: null, closed: false };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value);
}

/**
 * 易支付 `api.php?act=order` 的返回。
 *
 * 形如 `{"code":1,"trade_no":"...","status":1,...}`：
 * - `code` 是「这次查询成功没有」，不是「付没付」——两者混淆的后果是把一次
 *   查询成功当成付款成功，直接白送。
 * - `status` 才是付款状态，1 = 已支付。
 */
export function parseEasyPayOrderQuery(payload: unknown): PaymentQueryResult {
  if (!payload || typeof payload !== "object") return NOT_PAID;
  const row = payload as Record<string, unknown>;
  const code = text(row.code);
  if (code !== "1") {
    // code=-1 等于「查无此单」：网关不认识它，再问多少次也一样。
    return { paid: false, tradeNo: null, closed: code === "-1" };
  }
  const status = text(row.status);
  return {
    paid: status === "1",
    tradeNo: text(row.trade_no) || null,
    closed: false,
  };
}

/**
 * Stripe Checkout Session 的返回。
 *
 * 看 `payment_status`，不看 `status`：后者 complete 只表示这个结账会话走完了，
 * 异步付款方式（部分本地支付）会出现 complete 但 payment_status=unpaid。
 * 认错的后果同样是发货了但没收到钱。
 */
export function parseStripeSessionQuery(payload: unknown): PaymentQueryResult {
  if (!payload || typeof payload !== "object") return NOT_PAID;
  const row = payload as Record<string, unknown>;
  const paymentStatus = text(row.payment_status);
  const status = text(row.status);
  const paymentIntent = row.payment_intent;
  const tradeNo = typeof paymentIntent === "string"
    ? paymentIntent
    : paymentIntent && typeof paymentIntent === "object"
      ? text((paymentIntent as Record<string, unknown>).id) || null
      : null;
  return {
    paid: paymentStatus === "paid" || paymentStatus === "no_payment_required",
    tradeNo: tradeNo || text(row.id) || null,
    closed: status === "expired",
  };
}

/**
 * 这一单现在该不该去问。
 *
 * 两头都要拦：太新的别问（用户可能还停在收银台，回调本来也就几秒的事，问了纯属
 * 给网关添堵），已经过了有效期的别问（那时该做的是关单）。
 */
export function shouldQueryPendingOrder(
  order: { createdAt?: unknown; expiresAt?: unknown },
  now = Date.now(),
  minAgeMs = 2 * 60 * 1000,
): boolean {
  const createdAt = order.createdAt ? new Date(order.createdAt as any).getTime() : 0;
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  if (now - createdAt < minAgeMs) return false;
  const expiresAt = order.expiresAt ? new Date(order.expiresAt as any).getTime() : 0;
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) return false;
  return true;
}
