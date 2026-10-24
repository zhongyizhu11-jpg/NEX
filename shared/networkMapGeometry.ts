/**
 * 首页网络地图的几何：大圆弧、挨着的主机并组、出口箭头、按 marker 的像素精确框住。
 *
 * 纯函数，不碰 MapLibre —— 投影（经纬度 → 像素）由调用方传进来，这样能在 node 里测，
 * 也不用为了算一次布局去 mock 一整个地图。
 */

export type LngLat = [number, number];

/**
 * 两点之间的大圆弧，n 段折线。
 *
 * 直线在墨卡托上看着像航线图里没有的东西；大圆弧是飞机真正飞的路，广州 → 洛杉矶
 * 会往北弯过阿留申群岛，一眼就是「跨太平洋」。
 *
 * 越过日界线时把后面的点连续化（±360），否则 MapLibre 会画一条横跨整个地球的线。
 */
export function greatCircleArc(a: LngLat, b: LngLat, n = 40): LngLat[] {
  const toR = Math.PI / 180;
  const toD = 180 / Math.PI;
  const l1 = a[0] * toR;
  const p1 = a[1] * toR;
  const l2 = b[0] * toR;
  const p2 = b[1] * toR;
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!(d > 1e-7)) return [a, b];
  const pts: LngLat[] = [];
  for (let i = 0; i <= n; i += 1) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([Math.atan2(y, x) * toD, Math.atan2(z, Math.sqrt(x * x + y * y)) * toD]);
  }
  for (let k = 1; k < pts.length; k += 1) {
    while (pts[k][0] - pts[k - 1][0] > 180) pts[k][0] -= 360;
    while (pts[k][0] - pts[k - 1][0] < -180) pts[k][0] += 360;
  }
  // 起点按原样对齐到 a 所在的那一圈，整条线才和两端的 marker 在同一份世界副本上。
  const shift = a[0] - pts[0][0];
  if (Math.abs(shift) > 1e-9) for (const p of pts) p[0] += shift;
  return pts;
}

export type LayoutPoint = { key: string; lngLat: LngLat };

export type LayoutPosition = {
  /** marker 要放的经纬度：单独的点是自己，并进组的是组的中心 */
  lngLat: LngLat;
  /** 并在哪一组里（组里不止一个点时才有值） */
  clusterId: number | null;
};

export type LayoutGroup = { id: number; keys: string[]; center: LngLat; cx: number; cy: number };

export type MapLayout = {
  /** 不止一个点的组 —— 这些画成一枚带数量的环 */
  groups: LayoutGroup[];
  pos: Record<string, LayoutPosition>;
};

export type MapLayoutOptions = {
  /** 离组心多近算一组（像素） */
  clusterRadius: number;
  /**
   * 并组之后再吸一遍：单独的点离某个组的组心 (dx, dy) 像素时要不要并进去。组的环比单台的环大，
   * 按圆心距离分组会让紧挨着它的那台压在上面；调用方知道组画多大，由它来判断。
   */
  absorb?: (groupKeys: string[], offset: { dx: number; dy: number }) => boolean;
};

/**
 * 按屏幕像素距离并组：每台主机都画在真实坐标上，圆盘会压在一起的（clusterRadius 以内）并成一组，
 * 画成一枚带数量的环。不再错开成一圈 —— 错开会把主机挪到上千公里外，线看着像连错了。
 *
 * 贪心：按顺序把每个点归到第一个够近的组里，组心随之更新。点少（几十上百）时够用，
 * 而且是确定的 —— 同样的输入永远得到同样的组，marker 不会在两次 relayout 之间跳。
 */
export function computeMapLayout(
  points: readonly LayoutPoint[],
  project: (lngLat: LngLat) => { x: number; y: number },
  options: MapLayoutOptions,
): MapLayout {
  const radius = options.clusterRadius;
  const groups: Array<{ items: LayoutPoint[]; px: Array<{ x: number; y: number }>; cx: number; cy: number }> = [];
  for (const p of points) {
    const pt = project(p.lngLat);
    let group = null as (typeof groups)[number] | null;
    for (const g of groups) {
      if (Math.hypot(g.cx - pt.x, g.cy - pt.y) < radius) { group = g; break; }
    }
    if (!group) { groups.push({ items: [p], px: [pt], cx: pt.x, cy: pt.y }); continue; }
    group.items.push(p);
    group.px.push(pt);
    group.cx = group.px.reduce((s, q) => s + q.x, 0) / group.px.length;
    group.cy = group.px.reduce((s, q) => s + q.y, 0) / group.px.length;
  }
  if (options.absorb) {
    // 组心会随着吸进来的点挪，挪完可能又够到下一台，所以吸到没有变化为止（最多点数那么多轮）
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < groups.length && !changed; i += 1) {
        const single = groups[i];
        if (single.items.length !== 1) continue;
        for (const g of groups) {
          if (g === single || g.items.length < 2) continue;
          if (!options.absorb(g.items.map((it) => it.key), { dx: single.px[0].x - g.cx, dy: single.px[0].y - g.cy })) continue;
          g.items.push(single.items[0]);
          g.px.push(single.px[0]);
          g.cx = g.px.reduce((s, q) => s + q.x, 0) / g.px.length;
          g.cy = g.px.reduce((s, q) => s + q.y, 0) / g.px.length;
          groups.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
  }
  const pos: Record<string, LayoutPosition> = {};
  const outGroups: LayoutGroup[] = [];
  groups.forEach((g, gi) => {
    if (g.items.length === 1) {
      pos[g.items[0].key] = { lngLat: g.items[0].lngLat, clusterId: null };
      return;
    }
    const center: LngLat = [
      g.items.reduce((s, it) => s + it.lngLat[0], 0) / g.items.length,
      g.items.reduce((s, it) => s + it.lngLat[1], 0) / g.items.length,
    ];
    for (const it of g.items) pos[it.key] = { lngLat: center, clusterId: gi };
    outGroups.push({ id: gi, keys: g.items.map((it) => it.key), center, cx: g.cx, cy: g.cy });
  });
  return { groups: outGroups, pos };
}

/**
 * 一组点的外接范围，给 fitBounds 用。
 *
 * 越过日界线的点挪到 +360 那一侧，保证太平洋在中间、线不会绕地球一圈；
 * 单点或很近的点撑开 0.6°，否则 fitBounds 会放大到最大级别。
 */
export function boundsForPoints(points: readonly LngLat[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const x = p[0] < -30 ? p[0] + 360 : p[0];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  if (maxX - minX < 0.6) { minX -= 0.3; maxX += 0.3; }
  if (maxY - minY < 0.6) { minY -= 0.3; maxY += 0.3; }
  return [[minX, minY], [maxX, maxY]];
}

export type PixelPoint = { x: number; y: number };

/**
 * 弧线末端的箭头（屏幕像素里的三角形）：让方向不靠动画也看得出来。
 *
 * 方向取弧线最后一小段的切线 —— 从末端往回找到离末端至少 minTangentPx 远的顶点再算，
 * 缩到全球时最后一段可能不到一像素，直接用它方向会抖。backoff 把箭尖从主机的圆盘下
 * 挪出来，不然盘子把箭头盖住。太短的弧（整条不到 minTangentPx）不画，返回 null。
 * 返回 [箭尖, 左底角, 右底角]。
 */
export function arrowTriangleAlong(projected: readonly PixelPoint[], size: number, backoff: number, minTangentPx = 8, widthRatio = 0.55): [PixelPoint, PixelPoint, PixelPoint] | null {
  if (projected.length < 2) return null;
  const tip = projected[projected.length - 1];
  let from: PixelPoint | null = null;
  for (let index = projected.length - 2; index >= 0; index -= 1) {
    if (Math.hypot(tip.x - projected[index].x, tip.y - projected[index].y) >= minTangentPx) { from = projected[index]; break; }
  }
  if (!from) return null;
  const length = Math.hypot(tip.x - from.x, tip.y - from.y);
  const dx = (tip.x - from.x) / length;
  const dy = (tip.y - from.y) / length;
  const apex = { x: tip.x - dx * backoff, y: tip.y - dy * backoff };
  const base = { x: apex.x - dx * size, y: apex.y - dy * size };
  // 两腰离中线多远（相对箭长）：默认 0.55 是个胖三角；地图上用 0.4，细而尖
  const half = size * widthRatio;
  return [apex, { x: base.x - dy * half, y: base.y + dx * half }, { x: base.x + dy * half, y: base.y - dx * half }];
}

export type PixelBox = { x: number; y: number; w: number; h: number };

/** 两个盒子重叠的面积（不重叠是 0） */
export function boxOverlapArea(a: PixelBox, b: PixelBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function unionBox(boxes: readonly PixelBox[]): PixelBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x); minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w); maxY = Math.max(maxY, box.y + box.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export type FitItem = {
  /** 随缩放走的那个点：经纬度投影出来的像素（并进组的是组心） */
  anchor: PixelPoint;
  /** 画出来占的屏幕盒子：圆盘 + 名字这些不随缩放变的部分都算在内 */
  box: PixelBox;
};

export type FitInset = { top: number; right: number; bottom: number; left: number };

export type FitResult = {
  /** 地图要乘的比例：< 1 缩小、> 1 放大 */
  scale: number;
  /** 等价的 zoom 增量（log2 scale） */
  zoomDelta: number;
  /** 现在屏幕上的这个点变换后应该落在容器正中 —— 反投影它就是新的 center */
  centerPx: PixelPoint;
  /** 按这个比例所有盒子都能放进留白之内（放不进说明缩到 minScale 也不够） */
  fits: boolean;
};

/**
 * 把一批 marker 完整框进容器：算出该缩放多少、中心挪到哪。
 *
 * fitBounds 只知道经纬度，不知道圆盘有 20px、名字有 90px 宽 ——
 * 这些像素尺寸不随缩放变，于是贴边的主机总被裁掉半个盘。这里把每个 marker 拆成「随缩放
 * 走的锚点」和「不随缩放变的盒子边距」：整体宽度 W(k) = max(k·ax + 右边距) − min(k·ax − 左边距)
 * 是 k 的凸函数，二分就能找到最大的还放得下的 k（放得下就往里放大到 maxScale，放不下
 * 就缩小）。然后把所有盒子的并集挪到留白区域正中。
 *
 * 返回的是「当前屏幕上哪个点该成为新中心」+ 缩放比例；调用方 jumpTo(unproject(centerPx), zoom + zoomDelta)
 * 一次到位。marker 的分组随缩放会变（缩小后两台并成一组），所以调用方量一次、跳一次、再量一次，
 * 几轮就收敛。
 */
export function fitViewToBoxes(
  container: { width: number; height: number },
  items: readonly FitItem[],
  inset: FitInset,
  options: { /** 最多放大到这个比例（默认 1：只缩不放） */ maxScale?: number; /** 最多缩小到这个比例（默认 0） */ minScale?: number } = {},
): FitResult | null {
  if (items.length === 0) return null;
  const maxScale = Math.max(options.maxScale ?? 1, 1e-6);
  const minScale = Math.min(Math.max(options.minScale ?? 0, 0), maxScale);
  const availW = Math.max(1, container.width - inset.left - inset.right);
  const availH = Math.max(1, container.height - inset.top - inset.bottom);
  const c0 = { x: container.width / 2, y: container.height / 2 };
  const parts = items.map((item) => ({
    ax: item.anchor.x - c0.x, ay: item.anchor.y - c0.y,
    l: item.anchor.x - item.box.x, r: item.box.x + item.box.w - item.anchor.x,
    t: item.anchor.y - item.box.y, b: item.box.y + item.box.h - item.anchor.y,
  }));
  const extent = (k: number) => {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const p of parts) {
      minX = Math.min(minX, k * p.ax - p.l); maxX = Math.max(maxX, k * p.ax + p.r);
      minY = Math.min(minY, k * p.ay - p.t); maxY = Math.max(maxY, k * p.ay + p.b);
    }
    return { minX, maxX, minY, maxY };
  };
  const feasible = (k: number) => { const e = extent(k); return e.maxX - e.minX <= availW && e.maxY - e.minY <= availH; };
  let scale: number;
  let fits = true;
  if (feasible(maxScale)) scale = maxScale;
  else if (!feasible(minScale)) { scale = minScale; fits = false; }
  else {
    let lo = minScale;
    let hi = maxScale;
    for (let i = 0; i < 48; i += 1) {
      const mid = (lo + hi) / 2;
      if (feasible(mid)) lo = mid; else hi = mid;
    }
    scale = lo;
  }
  const e = extent(scale);
  // 并集（相对容器中心）的中点要挪到留白区域的中点
  const unionCenter = { x: (e.minX + e.maxX) / 2, y: (e.minY + e.maxY) / 2 };
  const target = { x: inset.left + availW / 2 - c0.x, y: inset.top + availH / 2 - c0.y };
  const pan = { x: target.x - unionCenter.x, y: target.y - unionCenter.y };
  // 变换：p' = c0 + k(p − c0) + pan；要让 q 变到 c0：q = c0 − pan / k
  return {
    scale,
    zoomDelta: Math.log2(scale),
    centerPx: { x: c0.x - pan.x / scale, y: c0.y - pan.y / scale },
    fits,
  };
}
