import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";
import type { ForwardMapLink } from "@shared/forwardMapLinks";

import type { NetworkMapModel } from "./networkMapModel";

/**
 * 首页「概览」：一张裁到主机范围的世界剪影（主色点阵，worldDots），主机按真实经纬度落在上面，
 * 主机之间的隧道和转发合成一条线，线的颜色说状态。没有瓦片、没有地图库，只有点和线。
 *
 * 这里是纯函数（取景、落位、合线、摆标签），画在 components/network/NetworkOverview.tsx。
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
  /** 隧道 id（转发没有）：合线时按它去重，名字不唯一 */
  tunnelId?: number;
  from: number;
  to: number;
  tone: OverviewEdgeTone;
  /** 提示里写的：隧道名，或「3 条转发」 */
  label: string;
  /** 合并进这一段的转发规则数（隧道是 1） */
  count: number;
};

/** 同一对主机之间的所有线合成的一条：图上只画这一条，粗细按条数 */
export type OverviewBundle = {
  key: string;
  from: number;
  to: number;
  /** 最差的那条的状态：中断 > 降级 > 正常 > 停用 */
  tone: OverviewEdgeTone;
  tunnels: number;
  tunnelNames: string[];
  /** 转发规则条数 */
  forwards: number;
};

/** 取景：经纬度 ↔ 画布像素。dots 按它把陆地点投到画布上，画布外的不画 */
export type OverviewViewport = {
  /** 经度按 0~360 算（跨太平洋时），画点时负的经度要 +360 */
  wrap: boolean;
  lon0: number;
  lat0: number;
  /** 每度多少像素 */
  sx: number;
  sy: number;
  x(lon: number): number;
  y(lat: number): number;
};

/** 两边给标签胶囊留的位置（胶囊可以伸出主机点 100px 左右） */
export const OVERVIEW_PAD_X = 56;
export const OVERVIEW_PAD_TOP = 28;
/** 下面留出名字和地名两行字 */
export const OVERVIEW_PAD_BOTTOM = 44;
/** 至少取这么大的经纬度范围：三台同城的机器不会被放大成铺满整张图，周围还看得到一点陆地 */
const MIN_LNG_SPAN = 60;
const MIN_LAT_SPAN = 30;
/** 两个方向的比例尺最多差这么多：横向跨太平洋、纵向只有几度时，纵向不会被拉得太夸张 */
const MAX_SCALE_RATIO = 1.6;

type Located = { id: number; lng: number; lat: number };

/**
 * 经度是一个圈：美西（-122）和东京（139）按 -180~180 算隔着大半个地球、各在图的一头；
 * 换成 0~360 算，它们隔着太平洋挨着。两种都试，取范围小的那种。
 */
function unwrapLongitudes(points: Located[]): { points: Located[]; wrap: boolean } {
  if (points.length < 2) return { points, wrap: false };
  const span = (values: number[]) => Math.max(...values) - Math.min(...values);
  const raw = points.map((point) => point.lng);
  const shifted = raw.map((lng) => (lng < 0 ? lng + 360 : lng));
  if (span(shifted) < span(raw)) return { points: points.map((point, index) => ({ ...point, lng: shifted[index] })), wrap: true };
  return { points, wrap: false };
}

/** 一个方向上的范围：至少 minSpan，中心不变 */
function expand(min: number, max: number, minSpan: number): [number, number] {
  const span = max - min;
  if (span >= minSpan) return [min, max];
  const mid = (min + max) / 2;
  return [mid - minSpan / 2, mid + minSpan / 2];
}

/**
 * 取景：有经纬度的主机的外接框，撑到最小范围，再按画布里主机可用的区域算比例尺。
 * 横竖的比例尺各算各的（世界图本来就不是等比的），但相差太多时把窄的那一边放大。
 * 一台主机都没定位时返回 null：那就没有底图，只有底下一行主机。
 */
export function overviewViewport(
  nodes: ReadonlyArray<{ geo?: { lat: number; lng: number } | null }>,
  width: number,
  height: number,
): OverviewViewport | null {
  const located = unwrapLongitudes(
    nodes
      .filter((node) => node.geo && Number.isFinite(node.geo.lat) && Number.isFinite(node.geo.lng))
      .map((node, index) => ({ id: index, lng: node.geo!.lng, lat: node.geo!.lat })),
  );
  if (located.points.length === 0) return null;
  const innerW = Math.max(1, width - OVERVIEW_PAD_X * 2);
  const innerH = Math.max(1, height - OVERVIEW_PAD_TOP - OVERVIEW_PAD_BOTTOM);
  const lngs = located.points.map((point) => point.lng), lats = located.points.map((point) => point.lat);
  let [lon0, lon1] = expand(Math.min(...lngs), Math.max(...lngs), MIN_LNG_SPAN);
  let [latMin, latMax] = expand(Math.min(...lats), Math.max(...lats), MIN_LAT_SPAN);
  let sx = innerW / (lon1 - lon0);
  let sy = innerH / (latMax - latMin);
  if (sy > sx * MAX_SCALE_RATIO) {
    sy = sx * MAX_SCALE_RATIO;
    [latMin, latMax] = expand(latMin, latMax, innerH / sy);
  } else if (sx > sy * MAX_SCALE_RATIO) {
    sx = sy * MAX_SCALE_RATIO;
    [lon0, lon1] = expand(lon0, lon1, innerW / sx);
  }
  const lat0 = latMax;
  return {
    wrap: located.wrap,
    lon0,
    lat0,
    sx,
    sy,
    x: (lon) => OVERVIEW_PAD_X + (lon - lon0) * sx,
    y: (lat) => OVERVIEW_PAD_TOP + (lat0 - lat) * sy,
  };
}

/**
 * 落位。有经纬度的按取景投到画布上；没经纬度的在底下排成一行。
 * 之后把挨得太近的推开（同城的几台、或者离得很近的城市），免得点和标签叠在一起。
 */
export function layoutOverview(
  nodes: ReadonlyArray<{ id: number; name: string; city?: string | null; health: NetworkHealth; geo?: { lat: number; lng: number } | null }>,
  width: number,
  height: number,
): OverviewNode[] {
  if (nodes.length === 0) return [];
  const innerW = Math.max(1, width - OVERVIEW_PAD_X * 2);
  const innerH = Math.max(1, height - OVERVIEW_PAD_TOP - OVERVIEW_PAD_BOTTOM);
  const viewport = overviewViewport(nodes, width, height);
  const locatedIds = new Set(nodes.filter((node) => node.geo && Number.isFinite(node.geo.lat) && Number.isFinite(node.geo.lng)).map((node) => node.id));
  const unlocatedCount = nodes.length - locatedIds.size;
  let unlocatedIndex = 0;
  const placed: OverviewNode[] = nodes.map((node) => {
    const base = { id: node.id, name: node.name, city: String(node.city || ""), health: node.health };
    if (viewport && locatedIds.has(node.id)) {
      const lng = viewport.wrap && node.geo!.lng < 0 ? node.geo!.lng + 360 : node.geo!.lng;
      return { ...base, x: viewport.x(lng), y: viewport.y(node.geo!.lat), unlocated: false };
    }
    const t = unlocatedCount === 1 ? 0.5 : unlocatedIndex / (unlocatedCount - 1);
    unlocatedIndex += 1;
    return {
      ...base,
      x: OVERVIEW_PAD_X + t * innerW,
      y: viewport ? OVERVIEW_PAD_TOP + innerH : OVERVIEW_PAD_TOP + innerH / 2,
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
 * 推开：一个点带标签大约 80 宽、44 高。两点在横竖两个方向都靠得比这近就是叠着的 ——
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

/** 标签胶囊的尺寸和摆法 */
export type OverviewLabel = {
  id: number;
  /** 胶囊左上角相对主机点的偏移 */
  dx: number;
  dy: number;
  width: number;
  height: number;
  /** 第一行：旗 + 城市；第二行：主机名（和城市一样时只有一行）。太长的截掉加 … */
  line1: string;
  line2: string | null;
};

/** 粗略量一行字：汉字按 1 em，旗帜按 1.3 em，其它按 0.58 em */
export function labelTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of Array.from(text)) {
    const code = char.codePointAt(0) || 0;
    if (code >= 0x1f1e6 && code <= 0x1f1ff) width += fontSize * 0.65; // 区域指示符，两个一面旗
    else if (/[⺀-鿿豈-﫿＀-￯]/.test(char)) width += fontSize;
    else if (char === " ") width += fontSize * 0.3;
    else width += fontSize * 0.58;
  }
  return width;
}

const LABEL_GAP = 11;
/** 胶囊里每行最多这么多字（汉字算 1），再长的截掉加 …；主机名可以随便起，胶囊不能盖住半张图 */
const LABEL_MAX_CITY = 10;
const LABEL_MAX_NAME = 18;

/** 截到 max 个字（按码点数，旗帜的两个区域指示符算一个） */
export function truncateLabel(text: string, max: number): string {
  const chars = Array.from(String(text || "").trim());
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}
const LABEL_CANDIDATES: Array<[number, number]> = [
  [1, -1], // 右上
  [-1, -1], // 左上
  [1, 1], // 右下
  [-1, 1], // 左下
];

/**
 * 摆标签：每台主机的胶囊在右上 / 左上 / 右下 / 左下里挑一个，不压别的主机点、不和已经摆好的
 * 胶囊叠在一起、不出画布；都不行就取叠得最少的。从上到下摆，先摆的先占位。
 */
export function placeOverviewLabels(
  nodes: ReadonlyArray<OverviewNode & { flag?: string | null }>,
  width: number,
  height: number,
): OverviewLabel[] {
  const taken: Array<{ x: number; y: number; w: number; h: number }> = nodes.map((node) => ({ x: node.x - 10, y: node.y - 10, w: 20, h: 20 }));
  const order = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = new Map<number, OverviewLabel>();
  for (const node of order) {
    const city = node.city || node.name;
    const line1 = [node.flag, truncateLabel(city, LABEL_MAX_CITY)].filter(Boolean).join(" ");
    const line2 = node.unlocated ? "未定位" : city === node.name ? null : truncateLabel(node.name, LABEL_MAX_NAME);
    const w = Math.min(width - LABEL_GAP * 2, Math.ceil(Math.max(labelTextWidth(line1, 12), line2 ? labelTextWidth(line2, 10) : 0) + 20));
    const h = line2 ? 36 : 24;
    let best: { dx: number; dy: number; score: number } | null = null;
    for (const [sx, sy] of LABEL_CANDIDATES) {
      const dx = sx > 0 ? LABEL_GAP : -LABEL_GAP - w;
      const dy = sy < 0 ? -h + 6 : -6;
      const box = { x: node.x + dx, y: node.y + dy, w, h };
      let score = 0;
      if (box.x < 2) score += 2 - box.x;
      if (box.x + box.w > width - 2) score += box.x + box.w - (width - 2);
      if (box.y < 2) score += 2 - box.y;
      if (box.y + box.h > height - 2) score += box.y + box.h - (height - 2);
      for (const other of taken) {
        const ox = Math.min(box.x + box.w, other.x + other.w) - Math.max(box.x, other.x);
        const oy = Math.min(box.y + box.h, other.y + other.h) - Math.max(box.y, other.y);
        if (ox > 0 && oy > 0) score += ox * oy;
      }
      if (!best || score < best.score) best = { dx, dy, score };
      if (score === 0) break;
    }
    const label = { id: node.id, dx: best!.dx, dy: best!.dy, width: w, height: h, line1, line2 };
    out.set(node.id, label);
    taken.push({ x: node.x + label.dx, y: node.y + label.dy, w, h });
  }
  return nodes.map((node) => out.get(node.id)!);
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
 * 两头有一头不在图上的不画；开着的转发有一头主机掉线的算降级。
 */
export function buildOverviewEdges(model: Pick<NetworkMapModel, "nodes" | "links">, forwardLinks: readonly ForwardMapLink[]): OverviewEdge[] {
  const ids = new Set(model.nodes.map((node) => node.id));
  // 一头的主机掉线了，开着的转发也到不了：画成降级（转发自己的运行状态这里拿不到，隧道有自己的状态）
  const downHosts = new Set(model.nodes.filter((node) => describeNetworkHealth(node.health).token === "down").map((node) => node.id));
  const edges: OverviewEdge[] = [];
  for (const link of model.links) {
    const tone = toneOfHealth(link.health);
    for (let i = 0; i < link.path.length - 1; i += 1) {
      const from = link.path[i], to = link.path[i + 1];
      if (from === to || !ids.has(from) || !ids.has(to)) continue;
      edges.push({ key: `t${link.id}:${i}`, kind: "tunnel", tunnelId: link.id, from, to, tone, label: link.name, count: 1 });
    }
  }
  for (const link of forwardLinks) {
    if (!ids.has(link.fromHostId) || !ids.has(link.toHostId)) continue;
    edges.push({
      key: `f${link.fromHostId}>${link.toHostId}`,
      kind: "forward",
      from: link.fromHostId,
      to: link.toHostId,
      tone: link.enabled === 0 ? "off" : downHosts.has(link.fromHostId) || downHosts.has(link.toHostId) ? "warn" : "ok",
      label: link.rules > 1 ? `${link.rules} 条转发` : "1 条转发",
      count: link.rules,
    });
  }
  return edges;
}

const TONE_RANK: Record<OverviewEdgeTone, number> = { off: 0, ok: 1, warn: 2, down: 3 };

/**
 * 合线：同一对主机之间的隧道段和转发合成一条，方向取第一条的方向（流动的光点往那边走），
 * 状态取最差的那条。同一条隧道在同一对主机之间只算一次（按 id 去重，名字只用来写提示）。
 */
export function bundleOverviewEdges(edges: readonly OverviewEdge[]): OverviewBundle[] {
  const bundles = new Map<string, OverviewBundle>();
  const seenTunnels = new Map<string, Set<number>>();
  for (const edge of edges) {
    const lo = Math.min(edge.from, edge.to), hi = Math.max(edge.from, edge.to);
    const key = `${lo}-${hi}`;
    let bundle = bundles.get(key);
    if (!bundle) {
      bundle = { key, from: edge.from, to: edge.to, tone: edge.tone, tunnels: 0, tunnelNames: [], forwards: 0 };
      bundles.set(key, bundle);
      seenTunnels.set(key, new Set());
    }
    if (TONE_RANK[edge.tone] > TONE_RANK[bundle.tone]) bundle.tone = edge.tone;
    if (edge.kind === "tunnel") {
      // 同一条隧道在同一对主机之间只算一次（按 id：两条隧道可以同名）
      const seen = seenTunnels.get(key)!;
      const id = edge.tunnelId ?? Number.NaN;
      if (!seen.has(id)) {
        seen.add(id);
        bundle.tunnels += 1;
        if (!bundle.tunnelNames.includes(edge.label)) bundle.tunnelNames.push(edge.label);
      }
    } else {
      bundle.forwards += edge.count;
    }
  }
  return [...bundles.values()];
}

/** 图例上的数：线路条数（不是段数）、转发规则条数、降级 / 中断的线路 */
export function overviewCounts(model: Pick<NetworkMapModel, "links" | "linkTotal" | "legend">, forwardLinks: readonly ForwardMapLink[]) {
  return {
    tunnels: model.linkTotal,
    forwards: forwardLinks.reduce((sum, link) => sum + link.rules, 0),
    degraded: model.legend.degraded,
    down: model.legend.down,
  };
}

/**
 * 一条线的形状：两点之间弯一点的二次曲线，弯的幅度跟长度走（长线弯得多一点，像航线）。
 * 两头各缩进 inset，不扎进主机点里。
 */
export function overviewCurve(a: { x: number; y: number }, b: { x: number; y: number }, bend: number, inset: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const k = Math.min(48, len * 0.2) * bend;
  const cx = (a.x + b.x) / 2 + nx * k, cy = (a.y + b.y) / 2 + ny * k;
  const shrink = (from: { x: number; y: number }) => {
    const vx = cx - from.x, vy = cy - from.y;
    const vlen = Math.hypot(vx, vy) || 1;
    const step = Math.min(inset, vlen / 2);
    return { x: from.x + (vx / vlen) * step, y: from.y + (vy / vlen) * step };
  };
  const start = shrink(a), end = shrink(b);
  return {
    d: `M${start.x.toFixed(1)} ${start.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
    /** 曲线中点（t = 0.5），放「中断」的那个 ⊗ */
    mid: { x: (start.x + 2 * cx + end.x) / 4, y: (start.y + 2 * cy + end.y) / 4 },
  };
}

/** 每条线往哪边弯：统一往「小 id → 大 id」方向的左手边弯，同一张图里的弧都顺着一个方向，看着像一组航线 */
export function overviewBend(bundle: Pick<OverviewBundle, "from" | "to">): number {
  return bundle.from < bundle.to ? 1 : -1;
}
