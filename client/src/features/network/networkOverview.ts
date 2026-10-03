import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";
import type { ForwardMapLink } from "@shared/forwardMapLinks";

import type { NetworkMapModel } from "./networkMapModel";

/**
 * 首页「概览」：白底上的一张简单连接图 —— 每台主机按经纬度落在大致的位置上，主机之间的隧道和
 * 转发各是一条线，线的颜色说状态。没有底图、没有海岸线，只有点和线。
 *
 * 这里是纯函数（落位、连线），画在 components/network/NetworkOverview.tsx。
 */

export type OverviewNode = {
  id: number;
  name: string;
  city: string;
  health: NetworkHealth;
  x: number;
  y: number;
  /** 没有经纬度、排在底下那一行的 */
  unlocated: boolean;
};

export type OverviewEdgeKind = "tunnel" | "forward";
/** 线的颜色：正常 / 降级 / 中断 / 停用（或还没结论） */
export type OverviewEdgeTone = "ok" | "warn" | "down" | "off";

export type OverviewEdge = {
  key: string;
  kind: OverviewEdgeKind;
  from: number;
  to: number;
  tone: OverviewEdgeTone;
  /** 提示里写的：隧道名，或「3 条转发」 */
  label: string;
  /** 合并进这一段的转发规则数（隧道是 1） */
  count: number;
};

export const OVERVIEW_PAD_X = 56;
export const OVERVIEW_PAD_TOP = 28;
/** 下面留出名字和地名两行字 */
export const OVERVIEW_PAD_BOTTOM = 44;
/** 至少按这么大的经纬度范围铺：三台同城的机器不会被放大成铺满整张图 */
const MIN_LNG_SPAN = 24;
const MIN_LAT_SPAN = 12;

type Located = { id: number; lng: number; lat: number };

/**
 * 经度是一个圈：美西（-122）和东京（139）按 -180~180 算隔着大半个地球、各在图的一头；
 * 换成 0~360 算，它们隔着太平洋挨着。两种都试，取范围小的那种。
 */
function unwrapLongitudes(points: Located[]): Located[] {
  if (points.length < 2) return points;
  const span = (values: number[]) => Math.max(...values) - Math.min(...values);
  const raw = points.map((point) => point.lng);
  const shifted = raw.map((lng) => (lng < 0 ? lng + 360 : lng));
  return span(shifted) < span(raw) ? points.map((point, index) => ({ ...point, lng: shifted[index] })) : points;
}

/**
 * 一个方向上的落位（0~1）：真实经 / 纬度的比例和名次各占一部分。
 *
 * 纯按经纬度画，香港、广州、台北、东京挤在左边一小块，美西一台独占右边，中间全是空白；
 * 纯按名次画又看不出远近。所以 35% 按真实距离、65% 按名次（同一个值的并列取平均名次）：
 * 东西南北的先后和真地图一致，离得远的仍然远一点，但整张卡都用上了。范围小于 minSpan 时
 * 真实距离那部分按 minSpan 算，同城的几台不会被放大成铺满整张图。
 */
function spreadAxis(values: number[], minSpan: number): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [0.5];
  const min = Math.min(...values), max = Math.max(...values);
  const span = Math.max(minSpan, max - min);
  const mid = (min + max) / 2;
  const sorted = [...values].sort((a, b) => a - b);
  const rankOf = (value: number) => {
    const first = sorted.indexOf(value);
    const last = sorted.lastIndexOf(value);
    return (first + last) / 2 / (values.length - 1);
  };
  const distinct = new Set(values).size;
  return values.map((value) => {
    const geo = 0.5 + (value - mid) / span;
    // 全都一样（同城）时名次没有意义，都放中间
    const rank = distinct === 1 ? 0.5 : rankOf(value);
    return 0.35 * geo + 0.65 * rank;
  });
}

/**
 * 落位。有经纬度的按 spreadAxis 铺进画布（东西南北的先后和真地图一致）；没经纬度的在底下排成一行。
 * 之后把挨得太近的推开（同城的几台、或者离得很近的城市），免得点和名字叠在一起。
 */
export function layoutOverview(
  nodes: ReadonlyArray<{ id: number; name: string; city?: string | null; health: NetworkHealth; geo?: { lat: number; lng: number } | null }>,
  width: number,
  height: number,
): OverviewNode[] {
  if (nodes.length === 0) return [];
  const innerW = Math.max(1, width - OVERVIEW_PAD_X * 2);
  const innerH = Math.max(1, height - OVERVIEW_PAD_TOP - OVERVIEW_PAD_BOTTOM);
  const located = unwrapLongitudes(
    nodes
      .filter((node) => node.geo && Number.isFinite(node.geo.lat) && Number.isFinite(node.geo.lng))
      .map((node) => ({ id: node.id, lng: node.geo!.lng, lat: node.geo!.lat })),
  );
  const unlocatedCount = nodes.length - located.length;
  // 有没定位的主机时，底下留一行给它们
  const geoH = unlocatedCount > 0 && located.length > 0 ? Math.max(1, innerH - 44) : innerH;
  const xs = spreadAxis(located.map((point) => point.lng), MIN_LNG_SPAN);
  // 纬度北大南小，画布 y 往下变大：取反了再铺
  const ys = spreadAxis(located.map((point) => -point.lat), MIN_LAT_SPAN);
  const byId = new Map(located.map((point, index) => [point.id, { x: xs[index], y: ys[index] }]));
  const project = (point: { x: number; y: number }) => ({ x: OVERVIEW_PAD_X + point.x * innerW, y: OVERVIEW_PAD_TOP + point.y * geoH });
  let unlocatedIndex = 0;
  const placed: OverviewNode[] = nodes.map((node) => {
    const point = byId.get(node.id);
    const base = { id: node.id, name: node.name, city: String(node.city || ""), health: node.health };
    if (point) return { ...base, ...project(point), unlocated: false };
    const t = unlocatedCount === 1 ? 0.5 : unlocatedIndex / (unlocatedCount - 1);
    unlocatedIndex += 1;
    return {
      ...base,
      x: OVERVIEW_PAD_X + t * innerW,
      y: located.length > 0 ? OVERVIEW_PAD_TOP + innerH : OVERVIEW_PAD_TOP + innerH / 2,
      unlocated: true,
    };
  });
  spreadApart(placed, innerW / Math.max(2, nodes.length));
  for (const node of placed) {
    node.x = Math.min(width - OVERVIEW_PAD_X, Math.max(OVERVIEW_PAD_X, node.x));
    node.y = Math.min(height - OVERVIEW_PAD_BOTTOM, Math.max(OVERVIEW_PAD_TOP, node.y));
  }
  return placed;
}

/**
 * 推开：一个点连两行字大约 80 宽、44 高。两点在横竖两个方向都靠得比这近就是叠着的 ——
 * 沿差得少的那个方向各退一半；完全重合（同城）的按 id 交替往左右分。
 */
function spreadApart(placed: OverviewNode[], share: number) {
  const gapX = Math.min(84, Math.max(60, share * 1.1));
  const gapY = 44;
  for (let round = 0; round < 80; round += 1) {
    let moved = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i], b = placed[j];
        let dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) dx = a.id < b.id ? 0.01 : -0.01;
        const overlapX = gapX - Math.abs(dx);
        const overlapY = gapY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapX / gapX <= overlapY / gapY) {
          const sign = dx >= 0 ? 1 : -1;
          a.x -= (overlapX / 2) * sign; b.x += (overlapX / 2) * sign;
        } else {
          const sign = dy >= 0 ? 1 : -1;
          a.y -= (overlapY / 2) * sign; b.y += (overlapY / 2) * sign;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function toneOfHealth(health: NetworkHealth): OverviewEdgeTone {
  const token = describeNetworkHealth(health).token;
  if (token === "healthy") return "ok";
  if (token === "warn" || token === "path") return "warn";
  if (token === "down") return "down";
  return "off";
}

/**
 * 连线：隧道按经过的主机一段一段拆开（入口 → 中转 → 出口），转发每对主机一条（服务端已经合并过）。
 * 两头有一头不在图上的不画。
 */
export function buildOverviewEdges(model: Pick<NetworkMapModel, "nodes" | "links">, forwardLinks: readonly ForwardMapLink[]): OverviewEdge[] {
  const ids = new Set(model.nodes.map((node) => node.id));
  const edges: OverviewEdge[] = [];
  for (const link of model.links) {
    const tone = toneOfHealth(link.health);
    for (let i = 0; i < link.path.length - 1; i += 1) {
      const from = link.path[i], to = link.path[i + 1];
      if (from === to || !ids.has(from) || !ids.has(to)) continue;
      edges.push({ key: `t${link.id}:${i}`, kind: "tunnel", from, to, tone, label: link.name, count: 1 });
    }
  }
  for (const link of forwardLinks) {
    if (!ids.has(link.fromHostId) || !ids.has(link.toHostId)) continue;
    edges.push({
      key: `f${link.fromHostId}>${link.toHostId}`,
      kind: "forward",
      from: link.fromHostId,
      to: link.toHostId,
      tone: link.enabled > 0 ? "ok" : "off",
      label: link.rules > 1 ? `${link.rules} 条转发` : "1 条转发",
      count: link.rules,
    });
  }
  return edges;
}

/** 图例上的数：隧道条数（不是段数）、有转发的主机对数、断了的隧道 */
export function overviewCounts(model: Pick<NetworkMapModel, "links" | "linkTotal" | "legend">, forwardLinks: readonly ForwardMapLink[]) {
  return {
    tunnels: model.linkTotal,
    forwards: forwardLinks.reduce((sum, link) => sum + link.rules, 0),
    down: model.legend.down,
  };
}

/**
 * 一段线的形状：两点之间稍微弯一点的二次曲线。同一对主机之间有几条线时，第 k 条往另一边弯、
 * 弯得更多一点，不叠成一根。两头各缩进 inset，箭头不扎进圆点里。
 */
export function overviewCurve(a: { x: number; y: number }, b: { x: number; y: number }, bend: number, inset: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const k = Math.min(36, len * 0.16) * bend;
  const cx = (a.x + b.x) / 2 + nx * k, cy = (a.y + b.y) / 2 + ny * k;
  const shrink = (from: { x: number; y: number }) => {
    const vx = cx - from.x, vy = cy - from.y;
    const vlen = Math.hypot(vx, vy) || 1;
    const step = Math.min(inset, vlen / 2);
    return { x: from.x + (vx / vlen) * step, y: from.y + (vy / vlen) * step };
  };
  const start = shrink(a), end = shrink(b);
  return `M${start.x.toFixed(1)} ${start.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}

/** 同一对主机之间第几条线该往哪边弯、弯多少（0 号直着走一点点弯，之后左右交替） */
export function overviewBends(edges: readonly OverviewEdge[]): Map<string, number> {
  const seen = new Map<string, number>();
  const bends = new Map<string, number>();
  for (const edge of edges) {
    const lo = Math.min(edge.from, edge.to), hi = Math.max(edge.from, edge.to);
    const pair = `${lo}-${hi}`;
    const index = seen.get(pair) || 0;
    seen.set(pair, index + 1);
    const magnitude = 0.35 + Math.floor(index / 2) * 0.9 + (index % 2 === 1 ? 0.55 : 0);
    const side = index % 2 === 0 ? 1 : -1;
    // 方向统一按「小 id → 大 id」算，反方向的线要把弯的方向翻过来，才会真的分到两边
    bends.set(edge.key, (edge.from === lo ? 1 : -1) * side * magnitude);
  }
  return bends;
}
