/**
 * 订阅地址最近一次被拉取，是成了还是被拒了。
 *
 * 「客户说订阅更新不了」是商家最常接到的一句话，而面板原来只记成功：令牌行上写着
 * 「已拉取 3 次」，全是几天前的。于是下面这四种情况长得一模一样：
 *
 * 1. 客户根本没试（地址填错、客户端没刷新）
 * 2. 试了，但这条地址被停用了
 * 3. 试了，但账号到期 / 超流量 / 订阅权限被收了
 * 4. 试了，但服务端生成订阅时出错了
 *
 * 这四种要做的事完全不同 —— 第 3 种是去续费，第 1 种是让客户重新导入。所以失败也要
 * 记一笔，并且记下**为什么**。
 *
 * 一件事必须诚实：令牌本身不存在（地址被改过、被重置过）时**记不了** —— 那时候没有
 * 任何一行能挂上这笔记录。界面上不要假装能分辨这一种。
 */
export type ProxySubTokenFailureReason =
  | "disabled"
  | "token-expired"
  | "not-eligible"
  | "rate-limited"
  | "device-limit"
  | "hwid-required"
  | "error";

export const PROXY_SUB_TOKEN_FAILURE_LABELS: Record<ProxySubTokenFailureReason, string> = {
  disabled: "这条地址被停用了",
  "token-expired": "这条地址已过期",
  // 到期、超流量、被收回权限，落到客户端都是同一件事：拉不到。
  "not-eligible": "账号没有订阅资格（到期、超流量或权限被收回）",
  "rate-limited": "拉得太频繁，被限流了",
  "device-limit": "设备数已达上限",
  "hwid-required": "客户端没带设备标识（严格模式下不放行）",
  error: "服务端生成订阅时出错",
};

export function normalizeProxySubTokenFailureReason(value: unknown): ProxySubTokenFailureReason | null {
  const text = String(value ?? "").trim();
  return text in PROXY_SUB_TOKEN_FAILURE_LABELS ? text as ProxySubTokenFailureReason : null;
}

export type ProxySubTokenStatus =
  | { kind: "never" }
  | { kind: "ok"; at: number }
  | { kind: "failed"; at: number; reason: ProxySubTokenFailureReason };

/**
 * 这条地址现在该怎么说。
 *
 * 只比时间：最近一次发生的那件事才是现状。失败之后又成功了，就说成功 —— 客户已经
 * 拉到了，再挂着一条红字只会让人白紧张。
 */
export function proxySubTokenStatus(token: {
  lastAccessAt?: unknown;
  lastFailureAt?: unknown;
  lastFailureReason?: unknown;
}): ProxySubTokenStatus {
  const okAt = toTime(token?.lastAccessAt);
  const failAt = toTime(token?.lastFailureAt);
  const reason = normalizeProxySubTokenFailureReason(token?.lastFailureReason);
  if (failAt > 0 && reason && failAt >= okAt) return { kind: "failed", at: failAt, reason };
  if (okAt > 0) return { kind: "ok", at: okAt };
  return { kind: "never" };
}

function toTime(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value as any).getTime();
  return Number.isFinite(time) && time > 0 ? time : 0;
}
