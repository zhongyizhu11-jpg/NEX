/**
 * 落地节点的在线状态。
 *
 * 数据来源是中转机 Agent 对转发目标做的 tcping —— 一条转发的目标地址就是它绑定的
 * 那个落地节点的 host:port，所以规则的探测结果直接就是「这个落地通不通」。
 *
 * 有两件事必须讲清楚，否则这个小绿点会骗人：
 *
 * 1. 探测是**从中转机发出**的，不是从你的客户端。中转机连得上不等于你连得上
 *    （你那一段可能被墙），反过来也一样。
 * 2. 没有转发绑定的节点没有任何东西在探它，只能是「未知」。装在这里显示成
 *    「离线」是错的 —— 那会把一个好端端的节点标成红的。
 */

import { isLinkProbeFresh } from "./linkProbePolicy";

/**
 * 节点流量的统计窗口。
 *
 * 明确写死而不是依赖 metrics 的默认值：traffic_stats 只保留 72 小时，再往前的
 * 明细已经被清掉了，查更长的窗口只会得到一个悄悄偏小的数。界面上的「近 72 小时」
 * 和这里查的窗口必须是同一个常量，否则改一边就会变成一句假话。
 */
export const PROXY_NODE_TRAFFIC_WINDOW_HOURS = 72;

export type ProxyNodeHealthState = "online" | "offline" | "unknown";

/** 一条转发规则上最近一次探测的结果。 */
export type ProxyNodeProbeSample = {
  /** 可达时的往返延迟；超时或没测到时为 null。 */
  latencyMs: number | null;
  isTimeout: boolean;
  /** 探测时间，epoch 毫秒；0 表示没有探测记录。 */
  at: number;
};

export type ProxyNodeHealth = {
  state: ProxyNodeHealthState;
  /** 在线时给出最快那条中转的延迟，其余情况为 null。 */
  latencyMs: number | null;
  /** 鼠标悬停时的说明，直接可显示。 */
  title: string;
};

/** 探测是不是还算数。太旧的结果不能拿来标颜色 —— 半小时前通不等于现在通。 */
export function isProbeFresh(at: number, now = Date.now()): boolean {
  return isLinkProbeFresh(at, now);
}

/**
 * 把一个落地节点身上所有转发的探测结果并成一个状态。
 *
 * 判定是「任一可达即在线」：同一个落地被三台中转指向时，只要有一台连得上，
 * 这个落地本身就是活的 —— 另外两台连不上是那两条线路的问题，不是落地的问题。
 * 按「全部可达才算在线」去判，机房抖一下就会把落地误标成挂了。
 */
export function resolveProxyNodeHealth(
  samples: readonly ProxyNodeProbeSample[],
  now = Date.now(),
): ProxyNodeHealth {
  const fresh = samples.filter((sample) => isProbeFresh(sample.at, now));
  if (fresh.length === 0) {
    return { state: "unknown", latencyMs: null, title: "暂无探测结果" };
  }

  const reachable = fresh.filter((sample) => !sample.isTimeout
    && sample.latencyMs !== null
    && Number.isFinite(sample.latencyMs)
    && (sample.latencyMs as number) >= 0);

  if (reachable.length === 0) {
    const label = fresh.length > 1 ? `${fresh.length} 条中转探测均超时` : "最近一次探测超时";
    return { state: "offline", latencyMs: null, title: label };
  }

  const best = Math.min(...reachable.map((sample) => Number(sample.latencyMs)));
  const rounded = Math.round(best);
  const label = fresh.length > reachable.length
    ? `可达（最快 ${rounded}ms，${fresh.length - reachable.length} 条中转探测超时）`
    : `可达（${rounded}ms）`;
  return { state: "online", latencyMs: rounded, title: label };
}

/**
 * 一堆节点的在线情况怎么说给人听。
 *
 * 关键是**没探测过 ≠ 在线**。刚建好的节点还没有任何探测结果，它既不在线也不离线；
 * 拿「离线数为 0」当成「全都在线」，页面就会在一个还没连通的面板上写着「节点全在线」，
 * 或者写出「9 个节点：0 在线 · 0 离线」这种自相矛盾的话。
 *
 * 所以不知道就不说 —— 顶上那个徽标宁可不出现，也不替探测下结论。
 */
export type ProxyNodeHealthSummary = {
  /** 顶上那个小徽标；不知道就是 null（不显示）。 */
  badge: { text: string; tone: "ok" | "warn" } | null;
  /** 概览卡副标题：只写数得清的那几类。 */
  subtitle: string;
  unknown: number;
};

export function summarizeProxyNodeHealthCounts(input: {
  total: number;
  online: number;
  offline: number;
}): ProxyNodeHealthSummary {
  const total = Math.max(0, Math.floor(Number(input?.total) || 0));
  const online = Math.max(0, Math.floor(Number(input?.online) || 0));
  const offline = Math.max(0, Math.floor(Number(input?.offline) || 0));
  const unknown = Math.max(0, total - online - offline);

  if (total === 0) return { badge: null, subtitle: "还没有节点", unknown: 0 };

  const parts = [
    online > 0 ? `${online} 在线` : "",
    offline > 0 ? `${offline} 离线` : "",
    unknown > 0 ? `${unknown} 待探测` : "",
  ].filter(Boolean);

  const badge = offline > 0
    ? { text: `${offline} 个节点离线`, tone: "warn" as const }
    : online === total
      ? { text: "节点全在线", tone: "ok" as const }
      : null;

  return { badge, subtitle: parts.join(" · ") || "等待探测", unknown };
}
