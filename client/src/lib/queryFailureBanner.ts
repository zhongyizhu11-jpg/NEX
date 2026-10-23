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
export function queryFailureDetailText(items: readonly QueryFailureItem[]): string {
  if (items.length === 0) return "";
  // 认不出路径也要说点什么：一行空白等于又回到「说不出是哪一项」。
  const paths = Array.from(new Set(items.map((item) => item.path || "未知查询")));
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

/** 稳定的空列表：没有失败时每次都返回同一个引用，setState 才会判定「没变」而不触发重渲染。 */
export const NO_QUERY_FAILURES: readonly QueryFailureItem[] = Object.freeze([]);

/**
 * 两批失败是不是同一回事（路径和错误逐项相同）。
 *
 * useQueryFailureSignal 每收到一次查询缓存通知就重新数一遍。原来数完直接
 * setFailures(新数组)，内容没变引用也变了，React 当成新状态重渲染整个布局；
 * 布局一渲染，页面里的 useQuery 又挂上 / 卸下观察者，缓存再发通知，这里再数再
 * set …… 几十个来回就撞上 React 的更新深度上限（2.3.473 一打开面板就白屏）。
 * 内容相同就沿用旧引用，这条链在这里断掉。
 */
export function sameQueryFailures(left: readonly QueryFailureItem[], right: readonly QueryFailureItem[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i].path !== right[i].path || left[i].message !== right[i].message) return false;
  }
  return true;
}

/** 给 setState 用：内容没变就返回上一次的引用（React 据此跳过重渲染），变了才换新的。 */
export function nextQueryFailures(previous: readonly QueryFailureItem[], next: readonly QueryFailureItem[]): readonly QueryFailureItem[] {
  if (next.length === 0) return previous.length === 0 ? previous : NO_QUERY_FAILURES;
  return sameQueryFailures(previous, next) ? previous : next;
}

/**
 * 「知道了」要记住的是**哪几项**，不是「几项」。
 *
 * 原来记的是关掉时的失败数，数据一恢复就清零。换页时这一页的查询卸掉、下一页的还没
 * 挂上，失败数短暂归零 —— 「关过」就被清掉了，到下一页同一个失败的查询又弹一次，
 * 用户每翻一页看一次横幅。现在按路径记：关掉过的路径，在它**真正读到数据**之前不再
 * 提示；新的路径失败了照样提示。
 *
 * 返回值内容没变时沿用传入的那个 Set（引用不变，调用方据此跳过重渲染）。
 */
export function nextDismissedQueryPaths(
  dismissed: ReadonlySet<string>,
  recoveredPaths: Iterable<string>,
  newlyDismissedPaths: Iterable<string> = [],
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const path of recoveredPaths) {
    if (!dismissed.has(path) && !(next && next.has(path))) continue;
    next = next ?? new Set(dismissed);
    next.delete(path);
  }
  for (const path of newlyDismissedPaths) {
    if (!path || (next ? next.has(path) : dismissed.has(path))) continue;
    next = next ?? new Set(dismissed);
    next.add(path);
  }
  return next ?? dismissed;
}

/** 还没被「知道了」压下去的那几项。 */
export function undismissedQueryFailures(items: readonly QueryFailureItem[], dismissed: ReadonlySet<string>): readonly QueryFailureItem[] {
  if (dismissed.size === 0) return items;
  const kept = items.filter((item) => !dismissed.has(item.path || "未知查询"));
  return kept.length === items.length ? items : kept;
}

/** 查询自己声明「失败了别拉横幅」（useQuery 的 meta.silentFailure）：检查更新、公告弹窗这类锦上添花的。 */
export function isSilentFailureQuery(meta: unknown): boolean {
  return !!(meta as { silentFailure?: unknown } | null | undefined)?.silentFailure;
}
