import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";
import type { ForwardMapLink } from "@shared/forwardMapLinks";

import type { NetworkMapModel } from "./networkMapModel";

/**
 * 首页「概览」：一张裁到主机范围的矢量世界底图（国界，worldCountries），主机按真实经纬度落在上面，
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
/** 至少取这么大的经纬度范围：三台同城的机器不会被放大成一个省，周围还看得到海岸线和邻国 */
const MIN_LNG_SPAN = 28;
const MIN_LAT_SPAN = 14;
/** 两个方向的比例尺一样大：底下铺的是真地球图，横竖拉得不一样会把大陆拉变形 */
const MAX_SCALE_RATIO = 1;

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
 * 横竖用同一个比例尺（等经纬投影，地球图才不变形）：窄的那一边把范围放大到填满。
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
 * 落位：有经纬度的按取景投到画布上，位置就是真实位置，不为了避让挪动；没经纬度的在底下排成一行。
 */
export function projectOverview(
  nodes: ReadonlyArray<{ id: number; name: string; city?: string | null; health: NetworkHealth; geo?: { lat: number; lng: number } | null }>,
  width: number,
  height: number,
): OverviewNode[] {
  if (nodes.length === 0) return [];
  const innerW = Math.max(1, width - OVERVIEW_PAD_X * 2);
  const innerH = Math.max(1, height - OVERVIEW_PAD_TOP - OVERVIEW_PAD_BOTTOM);
  const viewport = overviewViewport(nodes, width, height);
  const isLocated = (node: (typeof nodes)[number]) => !!node.geo && Number.isFinite(node.geo.lat) && Number.isFinite(node.geo.lng);
  const unlocatedCount = nodes.filter((node) => !isLocated(node)).length;
  let unlocatedIndex = 0;
  return nodes.map((node) => {
    const base = { id: node.id, name: node.name, city: String(node.city || ""), health: node.health };
    if (viewport && isLocated(node)) {
      const lng = viewport.wrap && node.geo!.lng < 0 ? node.geo!.lng + 360 : node.geo!.lng;
      return { ...base, x: viewport.x(lng), y: viewport.y(node.geo!.lat), unlocated: false };
    }
    const t = unlocatedCount === 1 ? 0.5 : unlocatedIndex / (unlocatedCount - 1);
    unlocatedIndex += 1;
    return {
      ...base,
      x: OVERVIEW_PAD_X + t * innerW,
      y: viewport ? OVERVIEW_PAD_TOP + innerH + 18 : OVERVIEW_PAD_TOP + innerH / 2,
      unlocated: true,
    };
  });
}

/** 一个图上的点：一座城市（同城的几台合在一起），或者没定位的那一堆 */
export type OverviewCluster = OverviewNode & {
  /** 点里的主机（按 id 排） */
  members: Array<{ id: number; name: string; city: string; health: NetworkHealth }>;
  /** 出现的城市（一个点就是一座城，最多一个；没写城市的为空） */
  cities: string[];
  /** 城市的真实位置。点和别的城市压在一起时会被推开一点，这里留着原位，画一根细线连回去 */
  anchor: { x: number; y: number };
};

const HEALTH_RANK: Record<string, number> = { standby: 0, healthy: 1, path: 2, warn: 2, down: 3 };
function healthRank(health: NetworkHealth) {
  return HEALTH_RANK[describeNetworkHealth(health).token] ?? 0;
}

/** 点的半径：单台 5.5，合了几台的 9.5，十台以上 11（数字要放得下） */
export function overviewDotRadius(count: number) {
  return count <= 1 ? 5.5 : count < 10 ? 9.5 : 11;
}

/**
 * 合点：一座城市一个点。同城的主机（城市名相同）合成一个，点放在它们的重心；没写城市的按画布上的
 * 落点（取整到 1px）合。不同城市不合，挨得再近也各是各的点（见 separateOverview）。
 * 没定位的全部合成底下一个「未定位」点。点的 id 取成员里最小的主机 id，health 取成员里最差的。
 */
export function clusterOverview(placed: readonly OverviewNode[]): OverviewCluster[] {
  const groups = new Map<string, OverviewNode[]>();
  for (const node of placed) {
    const key = node.unlocated ? "unlocated" : node.city ? `city:${node.city}` : `at:${Math.round(node.x)},${Math.round(node.y)}`;
    const list = groups.get(key);
    if (list) list.push(node);
    else groups.set(key, [node]);
  }
  return [...groups.values()].map((group) => {
    const members = [...group].sort((a, b) => a.id - b.id);
    const unlocated = members[0].unlocated;
    const x = members.reduce((sum, node) => sum + node.x, 0) / members.length;
    const y = unlocated ? members[0].y : members.reduce((sum, node) => sum + node.y, 0) / members.length;
    const city = members[0].city;
    const worst = members.reduce((acc, member) => (healthRank(member.health) > healthRank(acc.health) ? member : acc), members[0]);
    return {
      id: members[0].id,
      name: members.length === 1 ? members[0].name : `${members.length} 台`,
      city: unlocated ? "" : city,
      health: worst.health,
      x,
      y,
      unlocated,
      members: members.map(({ id, name, city: memberCity, health }) => ({ id, name, city: memberCity, health })),
      cities: !unlocated && city ? [city] : [],
      anchor: { x, y },
    };
  });
}

/** 两个点之间至少留的缝（边到边） */
const DOT_GAP = 4;

/**
 * 分开压在一起的城市：两个点的圆叠上了（比如全图下的广州和香港只差两三个像素），就沿两点连线
 * 各让一半，反复几轮直到不叠；让开的点仍在画布里。真实位置留在 anchor 上，画的时候连一根细线回去。
 */
export function separateOverview(clusters: OverviewCluster[], width: number, height: number): OverviewCluster[] {
  const items = clusters.map((cluster) => ({ ...cluster, r: overviewDotRadius(cluster.members.length) }));
  const minX = OVERVIEW_PAD_X / 2, maxX = width - OVERVIEW_PAD_X / 2;
  const minY = OVERVIEW_PAD_TOP / 2, maxY = height - 12;
  for (let round = 0; round < 120; round += 1) {
    let moved = false;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i], b = items[j];
        const need = a.r + b.r + DOT_GAP;
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= need - 0.01) continue;
        if (d < 0.01) {
          // 完全重合：按 id 定一个方向，结果每次都一样
          const angle = ((a.id * 7 + b.id * 13) % 12) * (Math.PI / 6);
          dx = Math.cos(angle); dy = Math.sin(angle); d = 1;
          a.x -= dx * 0.01; a.y -= dy * 0.01;
        }
        const push = (need - d) / 2 + 0.05;
        const ux = dx / d, uy = dy / d;
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
        moved = true;
      }
    }
    for (const item of items) {
      item.x = Math.min(Math.max(item.x, minX), maxX);
      item.y = Math.min(Math.max(item.y, minY), maxY);
    }
    if (!moved) break;
  }
  return items.map(({ r: _r, ...cluster }) => cluster);
}

/** 落位 + 合点 + 分开：图上实际画的那些点 */
export function layoutOverview(
  nodes: ReadonlyArray<{ id: number; name: string; city?: string | null; health: NetworkHealth; geo?: { lat: number; lng: number } | null }>,
  width: number,
  height: number,
): OverviewCluster[] {
  return separateOverview(clusterOverview(projectOverview(nodes, width, height)), width, height);
}

/** 标签胶囊的尺寸和摆法 */
export type OverviewLabel = {
  id: number;
  /** 胶囊左上角相对点的偏移 */
  dx: number;
  dy: number;
  width: number;
  height: number;
  /** 一行：旗 + 城市（合点时「广州 · 香港」）。太长的截掉加 … */
  line1: string;
  line2: string | null;
  /** 离点远了，画一条细引线连回去 */
  leader: boolean;
};

/** 粗略量一行字：汉字按 1 em，旗帜按 1.3 em，其它按 0.58 em */
export function labelTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of Array.from(text)) {
    const code = char.codePointAt(0) || 0;
    if (code >= 0x1f1e6 && code <= 0x1f1ff) width += fontSize * 0.65; // 区域指示符，两个一面旗
    else if (/[⺀-鿿豈-﫿＀-￯]/.test(char)) width += fontSize;
    else if (char === " ") width += fontSize * 0.3;
    else width += fontSize * 0.58;
  }
  return width;
}

const LABEL_GAP = 11;
/** 远一点的那一圈位置：近处都被占了就挪到这里，画引线 */
const LABEL_FAR_GAP = 34;
const LABEL_HEIGHT = 24;
/** 胶囊里最多这么多字（汉字算 1），再长的截掉加 … */
const LABEL_MAX_CITY = 12;

/** 截到 max 个字（按码点数，旗帜的两个区域指示符算一个） */
export function truncateLabel(text: string, max: number): string {
  const chars = Array.from(String(text || "").trim());
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/** 右上 / 左上 / 右下 / 左下 / 正上 / 正下 */
/** [左右, 上下]：左右 ±1 是点的右 / 左边，0 是正上 / 正下；上下 ±1 是胶囊和点齐平偏上 / 偏下，±2 是整个在点的上 / 下沿外 */
const LABEL_DIRECTIONS: Array<[number, number]> = [[1, -1], [-1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [1, 2], [-1, 2], [1, -2], [-1, -2]];

/** 点到矩形的最近距离（点在矩形里为 0） */
function boxDistance(box: { x: number; y: number; w: number; h: number }, point: { x: number; y: number }) {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.w));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.h));
  return Math.hypot(dx, dy);
}

/**
 * 摆标签：一行「旗 城市」。先摆有问题的点（中断 > 降级），再从上到下摆别的；每个先试紧挨着点的十个位置，
 * 都压到别的点、胶囊或 ⊗ 就试远一圈（画引线）；离别的点比离自己还近的位置要罚分（免得读错是谁的）；
 * 出画布按面积的 4 倍算，放不下时整体挪回画布。
 */

export function placeOverviewLabels(
  nodes: ReadonlyArray<OverviewNode & { flag?: string | null; priority?: number; radius?: number; count?: number }>,
  width: number,
  height: number,
  /** 别的也不能压的圆（线中间的 ⊗ 之类） */
  avoid: ReadonlyArray<{ x: number; y: number; r: number }> = [],
): OverviewLabel[] {
  const taken: Array<{ x: number; y: number; w: number; h: number }> = [
    ...nodes.map((node) => ({ x: node.x, y: node.y, r: (node.radius ?? 6) + 3 })),
    ...avoid.map((item) => ({ ...item, r: item.r + 2 })),
  ].map(({ x, y, r }) => ({ x: x - r, y: y - r, w: r * 2, h: r * 2 }));
  const order = [...nodes].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.y - b.y || a.x - b.x);
  const out = new Map<number, OverviewLabel>();
  for (const node of order) {
    const text = node.unlocated ? ((node.count ?? 1) > 1 ? `未定位 ${node.count} 台` : "未定位") : node.city || node.name;
    const line1 = [node.unlocated ? null : node.flag, truncateLabel(text, LABEL_MAX_CITY)].filter(Boolean).join(" ");
    const w = Math.min(width - LABEL_GAP * 2, Math.ceil(labelTextWidth(line1, 12) + 20));
    const h = LABEL_HEIGHT;
    const r = node.radius ?? 6;
    let best: { dx: number; dy: number; score: number; leader: boolean } | null = null;
    for (const gap of [LABEL_GAP + r - 6, LABEL_FAR_GAP + r - 6]) {
      for (const [sx, sy] of LABEL_DIRECTIONS) {
        const dx = sx > 0 ? gap : sx < 0 ? -gap - w : -Math.round(w / 2);
        const far = gap - LABEL_GAP;
        const dy = sx === 0
          ? (sy < 0 ? -h - gap : gap)
          : sy === -1 ? -h + 6 - far : sy === 1 ? -6 + far : sy === 2 ? 2 + far : -h - 2 - far;
        const box = { x: node.x + dx, y: node.y + dy, w, h };
        let outside = 0;
        if (box.x < 2) outside += (2 - box.x) * h;
        if (box.x + box.w > width - 2) outside += (box.x + box.w - (width - 2)) * h;
        if (box.y < 2) outside += (2 - box.y) * w;
        if (box.y + box.h > height - 2) outside += (box.y + box.h - (height - 2)) * w;
        let score = outside * 4 + (gap > LABEL_GAP + r - 6 ? 40 : 0);
        // 标签离别的点比离自己的点还近，一眼会读错是谁的（香港的字贴在新加坡旁边）
        const own = boxDistance(box, node);
        for (const other of nodes) {
          if (other !== node && boxDistance(box, other) + 2 < own) score += 160;
        }
        for (const other of taken) {
          const ox = Math.min(box.x + box.w, other.x + other.w) - Math.max(box.x, other.x);
          const oy = Math.min(box.y + box.h, other.y + other.h) - Math.max(box.y, other.y);
          if (ox > 0 && oy > 0) score += ox * oy * 3;
        }
        if (!best || score < best.score) best = { dx, dy, score, leader: gap > LABEL_GAP + r - 6 };
        if (score === 0) break;
      }
      if (best && best.score === 0) break;
    }
    // 哪个位置都放不下（画布太窄）就整体挪回画布里
    const x = Math.min(Math.max(node.x + best!.dx, 2), width - 2 - w);
    const y = Math.min(Math.max(node.y + best!.dy, 2), height - 2 - h);
    const label = { id: node.id, dx: x - node.x, dy: y - node.y, width: w, height: h, line1, line2: null, leader: best!.leader };
    out.set(node.id, label);
    taken.push({ x, y, w, h });
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

/**
 * 按合出来的点重新合线：两头落在同一个点里的线不画（那几台挨在一起，线画出来只是一个点），
 * 它们最差的状态记在 inner 里，点的外圈按它变色 —— 断在点里面的隧道不会就这么消失。
 */
export function clusterOverviewBundles(
  edges: readonly OverviewEdge[],
  clusters: ReadonlyArray<Pick<OverviewCluster, "id" | "members">>,
): { bundles: OverviewBundle[]; inner: Map<number, OverviewEdgeTone> } {
  const clusterOf = new Map<number, number>();
  for (const cluster of clusters) for (const member of cluster.members) clusterOf.set(member.id, cluster.id);
  const inner = new Map<number, OverviewEdgeTone>();
  const outer: OverviewEdge[] = [];
  for (const edge of edges) {
    const from = clusterOf.get(edge.from), to = clusterOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (from === to) {
      const current = inner.get(from);
      if (current === undefined || TONE_RANK[edge.tone] > TONE_RANK[current]) inner.set(from, edge.tone);
      continue;
    }
    outer.push({ ...edge, from, to });
  }
  return { bundles: bundleOverviewEdges(outer), inner };
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
