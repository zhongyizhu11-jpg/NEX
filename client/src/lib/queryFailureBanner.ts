/**
 * 「有几项数据没读到」这条全局提示什么时候该出现。
 *
 * 每一页都各自挂着十几个查询，不可能每个列表都单独接一遍失败态；而一次面板重启或者
 * 网络抖动会让好几个查询同时失败。这条横幅是兜底：**没被单独处理的那些**也得让人
 * 知道「这一页现在显示的东西不完整」，而不是默默把空白当成事实。
 *
 * 难点全在「别吵」上：
 *
 * - 轮询的查询失败一次、下一轮就好了，这种不该闪一下横幅 —— 所以要连续失败一段时间
 *   才出现；
 * - 人手动关掉之后，同一批失败不要再弹回来；但**新的**失败必须再说一次，否则关一次
 *   就等于永久静音；
 * - 数据一恢复就立刻收起来，不留一个假的警告在页面上。
 */

export type QueryFailureBannerInput = {
  /** 当前处于失败状态、且页面上真的有人在用的查询数。 */
  failureCount: number;
  /** 这一批失败是什么时候开始的（毫秒时间戳）；没有失败时给 0。 */
  failingSinceMs: number;
  /** 人手动关掉时的失败数；0 表示没关过。 */
  dismissedAtCount: number;
  now: number;
  /** 连续失败多久才提示。默认 4 秒：足够盖掉一次轮询抖动。 */
  graceMs?: number;
};

export function shouldShowQueryFailureBanner(input: QueryFailureBannerInput): boolean {
  const graceMs = input.graceMs ?? 4_000;
  if (input.failureCount <= 0 || input.failingSinceMs <= 0) return false;
  // 关掉之后，只有失败**变多**了才再提示：同一批别再弹。
  if (input.dismissedAtCount > 0 && input.failureCount <= input.dismissedAtCount) return false;
  return input.now - input.failingSinceMs >= graceMs;
}

/** 横幅上那句话。数量说清楚，别用「部分」这种含糊词。 */
export function queryFailureBannerText(failureCount: number): string {
  const count = Math.max(1, Math.floor(failureCount));
  return count === 1
    ? "有 1 项数据没读到，这一页显示的可能不全。"
    : `有 ${count} 项数据没读到，这一页显示的可能不全。`;
}

export type QueryFailureItem = {
  /** tRPC 路径（tunnels.listPage 这种）；非 tRPC 的查询给键的字符串形式 */
  path: string;
  message: string;
};

/**
 * 横幅第二行：到底是哪几项没读到、报的什么错。
 *
 * 原来只写「有 1 项数据没读到」，用户在 App 里一直看到它却说不出是哪一项，
 * 我们这边也没法查。路径和错误信息直接写出来，截图就能定位。
 */
export function queryFailureDetailText(items: QueryFailureItem[]): string {
  const paths = Array.from(new Set(items.map((item) => item.path).filter(Boolean)));
  if (paths.length === 0) return "";
  const message = items.map((item) => String(item.message || "").trim()).find(Boolean) || "";
  const shortMessage = message.length > 120 ? `${message.slice(0, 120)}…` : message;
  return `没读到：${paths.join("、")}${shortMessage ? `（${shortMessage}）` : ""}`;
}

/** 从 react-query 的 queryKey 里取出 tRPC 路径：[["tunnels","listPage"], {...}] → tunnels.listPage */
export function queryKeyPath(queryKey: unknown): string {
  if (!Array.isArray(queryKey) || queryKey.length === 0) return "";
  const head = queryKey[0];
  if (Array.isArray(head)) return head.map((part) => String(part)).join(".");
  if (typeof head === "string") return head;
  try { return JSON.stringify(head); } catch { return ""; }
}
