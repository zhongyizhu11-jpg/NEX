/**
 * 套餐 / 按量计费资源的库存。
 *
 * 两种商品共用一套口径：`stockLimit` 是总量（0 = 不限），`stockUsed` 是已占用的份数。
 * - 套餐的 stockUsed 是存下来的计数：新购、分配、兑换、待支付订单各占一份，只增不减
 *   （未付款的订单关闭时才退回）。
 * - 按量资源的 stockUsed 是现算的：有几个账号在这个资源上还留着逻辑规则。
 *
 * 前后端都从这里取「还剩多少 / 是否售罄」，免得两边各写一遍判断、边界对不上。
 */

/** 库存总量、每账号规则上限的输入上界：再大就不是库存而是「不限」，直接填 0。 */
export const MAX_PRODUCT_STOCK = 1_000_000_000;

export type ProductStockInput = { stockLimit?: number | null; stockUsed?: number | null };

export function productStock(product: ProductStockInput | null | undefined) {
  const limit = Math.max(0, Math.floor(Number(product?.stockLimit) || 0));
  const used = Math.max(0, Math.floor(Number(product?.stockUsed) || 0));
  const unlimited = limit === 0;
  return {
    unlimited,
    limit,
    used,
    // 管理员把总量调到比已售还小时，剩余按 0 算，不出现负数。
    remaining: unlimited ? null : Math.max(0, limit - used),
    // 不限永远不会售罄：used 再大也只是个销量数字。
    soldOut: !unlimited && used >= limit,
  };
}

/** 剩余数量的展示文本：不限显示 ∞。 */
export function productStockText(product: ProductStockInput | null | undefined) {
  const stock = productStock(product);
  return stock.unlimited ? "∞" : String(stock.remaining);
}
