/**
 * 余额流水和订阅来源的中文口径，全站唯一一份。
 *
 * 原来 balanceTypeLabel 有三份（服务端通知一份、账单页一份、钱包页一份），
 * subscriptionSourceLabel 有两份 —— 而且**已经漂了**：同一条 source='payment'
 * 的订阅记录，服务端通知里叫「在线购买」，用户管理页叫「在线支付」；兜底文案
 * 一个是「套餐变更」、一个是「套餐记录」。
 *
 * 一笔钱在两个地方叫两个名字，比叫错更让人不敢信 —— 租户会开始怀疑是不是两笔。
 * 这里以服务端那份为准：通知是推到人手机上的，改它的代价最大。
 */

const BALANCE_TYPE_LABELS: Record<string, string> = {
  admin_recharge: "管理员充值",
  admin_adjust: "管理员修改",
  payment: "在线充值入账",
  purchase: "余额消费",
  redeem: "兑换入账",
  traffic_billing: "流量计费",
  traffic_addon_purchase: "购买附加流量",
  referral_commission: "邀请返利",
};

/** 认不出的类型原样显示，不要吞成一句「余额变动」把信息抹掉。 */
export function balanceTypeLabel(type?: string | null) {
  const key = String(type || "");
  return BALANCE_TYPE_LABELS[key] || key || "余额变动";
}

const SUBSCRIPTION_SOURCE_LABELS: Record<string, string> = {
  admin: "管理员分配",
  payment: "在线购买",
  redeem: "兑换套餐",
  balance: "余额购买",
};

export function subscriptionSourceLabel(source?: string | null) {
  const key = String(source || "");
  return SUBSCRIPTION_SOURCE_LABELS[key] || key || "套餐变更";
}

const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  active: "生效中",
  expired: "已过期",
  cancelled: "已取消",
};

/** 订阅当前处于什么状态。用户管理和「我的套餐」原来各存一份。 */
export function subscriptionStatusLabel(status?: string | null) {
  const key = String(status || "");
  return SUBSCRIPTION_STATUS_LABELS[key] || key || "-";
}

const QUOTA_SOURCE_LABELS: Record<string, string> = {
  manual: "手工额度",
  addon: "已购附加流量",
  grant: "管理员加赠",
};

/**
 * 这一档流量额度是哪来的。仪表盘和「我的套餐」原来各存一份。
 *
 * 认不出来时回「套餐额度」而不是原样显示 —— 这一列的取值是面板自己定的枚举，
 * 不是用户填的，出现新值只可能是版本没对齐，那时候按最常见的那种说更不容易误导。
 */
export function quotaSourceLabel(kind?: string | null) {
  return QUOTA_SOURCE_LABELS[String(kind || "")] || "套餐额度";
}
