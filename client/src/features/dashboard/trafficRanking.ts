/**
 * 近 24H 哪几条转发用的流量最多 —— 一张排行，替掉原来的三张饼图。
 *
 * 原来首页按类型摆了三张环形图：隧道流量、端口转发流量、转发组流量。三个问题：
 *
 * 一、饼图回答的是「占多大比例」，而这里真正要回答的是「谁用得最多」。五段弧长
 *     差 2% 的时候眼睛根本比不出来（实测种子数据里四段是 25.4% / 25.1% / 24.9% /
 *     24.6%），一条按长度排好的列表一眼就比出来了。
 * 二、按类型拆成三张，最大的那条如果是隧道，它和端口转发里的第一名永远不在同一张
 *     图里比 —— 而用户关心的是「哪条转发最费流量」，不是「隧道里哪条最费」。
 * 三、分片颜色取的是图表色板的前几位，而前四位刻意绑定了状态色：排第四的那条
 *     转发被涂成故障红，看着像出事了。排名不是状态，不该有状态色。
 *
 * 类型还在，只是从「分三张图」退成每一行上的一个标记。
 */

type TrafficBreakdownItem = {
  id: number;
  name: string;
  bytesIn?: number;
  bytesOut?: number;
  totalBytes: number;
};

export type TrafficBreakdown = {
  tunnelRules?: TrafficBreakdownItem[] | null;
  portRules?: TrafficBreakdownItem[] | null;
  forwardGroupRules?: TrafficBreakdownItem[] | null;
};

export type TrafficRankKind = "tunnel" | "port" | "group";

export const TRAFFIC_RANK_KIND_LABELS: Record<TrafficRankKind, string> = {
  tunnel: "隧道",
  port: "端口转发",
  group: "转发组",
};

type TrafficRankItem = {
  key: string;
  id: number;
  name: string;
  kind: TrafficRankKind;
  bytes: number;
  /** 占全部可见转发流量的比例（0–1） */
  share: number;
  /** 相对第一名的长度（0–1）—— 条的长度用它，第一名永远是满格 */
  relative: number;
};

export type TrafficRanking = {
  items: TrafficRankItem[];
  /** 没排进前几名的那些：几条、一共多少 */
  restCount: number;
  restBytes: number;
  totalBytes: number;
};

const SOURCES: Array<[keyof TrafficBreakdown, TrafficRankKind]> = [
  ["tunnelRules", "tunnel"],
  ["portRules", "port"],
  ["forwardGroupRules", "group"],
];

export function rankRuleTraffic(breakdown: TrafficBreakdown | null | undefined, limit = 5): TrafficRanking {
  const all = SOURCES.flatMap(([field, kind]) => (breakdown?.[field] || []).map((item) => ({
    // 三类的 id 都是规则 id，本来不会撞；key 还是带上类型，免得哪天口径变了悄悄合并两行。
    key: `${kind}:${Number(item.id)}`,
    id: Number(item.id),
    name: String(item.name || "").trim() || `规则 #${Number(item.id)}`,
    kind,
    bytes: Math.max(0, Number(item.totalBytes) || 0),
  })))
    // 0 字节的不上榜：「排第五，用了 0 B」不是信息。
    .filter((item) => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  const totalBytes = all.reduce((sum, item) => sum + item.bytes, 0);
  const top = all.slice(0, Math.max(0, Math.trunc(limit)));
  const max = top[0]?.bytes || 0;
  const rest = all.slice(top.length);

  return {
    items: top.map((item) => ({
      ...item,
      share: totalBytes > 0 ? item.bytes / totalBytes : 0,
      relative: max > 0 ? item.bytes / max : 0,
    })),
    restCount: rest.length,
    restBytes: rest.reduce((sum, item) => sum + item.bytes, 0),
    totalBytes,
  };
}

/** 「25%」「0.4%」「<0.1%」—— 小于 1% 的留一位小数，否则所有小的都写成 0%。 */
export function formatShare(share: number): string {
  const percent = Math.max(0, Number(share) || 0) * 100;
  if (percent === 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  if (percent < 1) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}
