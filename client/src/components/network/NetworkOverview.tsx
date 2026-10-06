import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  buildOverviewEdges,
  clusterOverviewBundles,
  layoutOverview,
  overviewDotRadius,
  overviewBend,
  overviewCurve,
  overviewViewport,
  placeOverviewLabels,
  type OverviewBundle,
  type OverviewCluster,
  type OverviewEdgeTone,
} from "@/features/network/networkOverview";
import type { NetworkMapModel } from "@/features/network/networkMapModel";
import { WORLD_GEO_UNIT, worldBordersPath, worldLandPath } from "@/features/network/worldGeo";
import { describeNetworkHealth, networkHealthPriority, type NetworkHealth } from "@shared/networkHealth";
import type { ForwardMapLink } from "@shared/forwardMapLinks";

/**
 * 首页「概览」图：底下一层矢量世界底图（Natural Earth 50m 陆地 + 国界，等经纬投影，裁到主机所在的那片）：
 * 浅色是白色陆地 + 淡主色海面，深色是炭灰陆地，海面颜色跟着配色走。
 * 一座城市一个点：同城的几台合成一个，点里写台数，点一下展开列表；不同城市不合。
 * 两座城市在画布上压在一起时（全图下的广州和香港），点各让开一点，真实位置留一个小点、细线连过去。
 * 每个点一枚一行的胶囊「旗 城市」，近处放不下就挪远一点、画一根引线；
 * 有问题的点先摆、画在最上层、字是红 / 琥珀色。
 * 点之间的线合成一条：正常 = 主色实线 + 往出口流动的光点，降级 = 琥珀虚线，中断 = 红虚线、正中一个 ⊗，停用 = 灰虚线；
 * 两头在同一个点里的线不画，状态算进那个点的颜色。纯 SVG，没有瓦片、没有地图库、没有图片。
 *
 * 点单台主机去主机页，点合起来的点展开列表，点线去隧道页（这一对只有转发时去转发页）。
 */
type NodeTone = "ok" | "warn" | "down" | "off";
const TONE_RANK: Record<NodeTone, number> = { off: 0, ok: 1, warn: 2, down: 3 };

const TONE_STROKE: Record<OverviewEdgeTone, string> = {
  ok: "var(--fx-primary-fill)",
  warn: "var(--fx-warn)",
  down: "var(--fx-down)",
  off: "var(--fx-text-muted)",
};

function hostTone(health: NetworkHealth): NodeTone {
  const token = describeNetworkHealth(health).token;
  return token === "healthy" ? "ok" : token === "down" ? "down" : token === "warn" || token === "path" ? "warn" : "off";
}

/** 点的颜色：成员里最差的主机，和点里面那些没画出来的线，取更差的 */
function clusterTone(cluster: OverviewCluster, inner: OverviewEdgeTone | undefined): NodeTone {
  const host = hostTone(cluster.health);
  return inner && TONE_RANK[inner] > TONE_RANK[host] ? inner : host;
}

/** 提示里的状态：主机的状态，点内有断掉 / 降级的线（线没画出来、只改了点的颜色）就一并说 */
function clusterTitleStatus(cluster: OverviewCluster, inner: OverviewEdgeTone | undefined) {
  const host = describeNetworkHealth(cluster.health).label;
  if (!inner || TONE_RANK[inner] <= TONE_RANK[hostTone(cluster.health)]) return host;
  return `${host} · 点内连线${inner === "down" ? "中断" : "降级"}`;
}

function clusterRadius(cluster: OverviewCluster) {
  return overviewDotRadius(cluster.members.length);
}

/** 提示和线的说明里怎么称呼一个点：单台写主机名，合起来的写城市 */
function clusterName(cluster: OverviewCluster) {
  return cluster.members.length <= 1 ? cluster.name : cluster.city || cluster.name;
}

function useMeasuredWidth(fallback: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.max(260, Math.round(element.getBoundingClientRect().width)) || fallback);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallback]);
  return { ref, width };
}

/** 画布高度：手机上接近 3:2，桌面封顶，和 NetworkMapCardPlaceholder 的占位一致 */
export function overviewHeight(width: number) {
  return Math.round(Math.min(320, Math.max(220, width * 0.66)));
}

function bundleTitle(bundle: OverviewBundle, a: OverviewCluster, b: OverviewCluster) {
  const parts: string[] = [];
  if (bundle.tunnels > 0) parts.push(`隧道 ${bundle.tunnelNames.join("、")}`);
  if (bundle.forwards > 0) parts.push(`${bundle.forwards} 条转发`);
  if (bundle.tone === "down") parts.push("中断");
  else if (bundle.tone === "warn") parts.push("降级");
  else if (bundle.tone === "off") parts.push("停用");
  return `${clusterName(a)} → ${clusterName(b)} · ${parts.join(" · ")}`;
}

/** 引线：从点的边上连到胶囊最近的那一点 */
function leaderPath(r: number, box: { x: number; y: number; w: number; h: number }) {
  const px = Math.min(Math.max(0, box.x), box.x + box.w);
  const py = Math.min(Math.max(0, box.y), box.y + box.h);
  const len = Math.hypot(px, py) || 1;
  return `M${((px / len) * (r + 2)).toFixed(1)} ${((py / len) * (r + 2)).toFixed(1)}L${px.toFixed(1)} ${py.toFixed(1)}`;
}

const POPOVER_W = 208;
const POPOVER_ROWS = 30;
/** 气泡的上下内边距；行高跟着全局触摸规则走（手指屏上按钮至少 44px），用来估气泡多高 */
const POPOVER_PAD = 12;
function popoverRowHeight() {
  try {
    return window.matchMedia("(pointer: coarse)").matches ? 44 : 32;
  } catch {
    return 32;
  }
}

export function NetworkOverview({ model, forwardLinks, onOpen, initialWidth = 720 }: {
  model: Pick<NetworkMapModel, "nodes" | "links">;
  forwardLinks: readonly ForwardMapLink[];
  onOpen?: (href: string) => void;
  /** 量到真实宽度之前（以及服务端渲染时）按这个宽度画 */
  initialWidth?: number;
}) {
  const { ref, width } = useMeasuredWidth(initialWidth);
  const height = overviewHeight(width);
  const [openId, setOpenId] = useState<number | null>(null);
  const viewport = useMemo(() => overviewViewport(model.nodes, width, height), [model.nodes, width, height]);
  const placed = useMemo(() => layoutOverview(model.nodes, width, height), [model.nodes, width, height]);
  const byId = useMemo(() => new Map(placed.map((node) => [node.id, node])), [placed]);
  const { bundles, inner } = useMemo(() => clusterOverviewBundles(buildOverviewEdges(model, forwardLinks), placed), [model, forwardLinks, placed]);
  const tones = useMemo(() => new Map(placed.map((node) => [node.id, clusterTone(node, inner.get(node.id))])), [placed, inner]);
  // 旗：点里的主机都在同一个国家 / 地区才写
  const flags = useMemo(() => {
    const emoji = new Map(model.nodes.map((node) => [node.id, node.emoji || null]));
    return new Map(placed.map((node) => {
      const set = new Set(node.members.map((member) => emoji.get(member.id) || null));
      return [node.id, set.size === 1 ? [...set][0] : null] as const;
    }));
  }, [model.nodes, placed]);
  // 中断线正中的 ⊗：标签别盖住它
  const marks = useMemo(() => bundles.flatMap((bundle) => {
    const a = byId.get(bundle.from), b = byId.get(bundle.to);
    if (bundle.tone !== "down" || !a || !b) return [];
    const inset = Math.max(clusterRadius(a), clusterRadius(b)) + 5;
    return [{ ...overviewCurve(a, b, overviewBend(bundle), inset).mid, r: 7 }];
  }), [bundles, byId]);
  const labels = useMemo(
    () => placeOverviewLabels(
      placed.map((node) => ({
        ...node,
        flag: flags.get(node.id),
        priority: TONE_RANK[tones.get(node.id) ?? "off"] >= 2 ? TONE_RANK[tones.get(node.id) ?? "off"] : 0,
        radius: clusterRadius(node),
        count: node.members.length,
      })),
      width,
      height,
      marks,
    ),
    [placed, flags, tones, width, height, marks],
  );

  const idBase = useId().replace(/:/g, "");
  const ids = { ring: `${idBase}-ring`, vignette: `${idBase}-vig`, line: `${idBase}-line`, clip: `${idBase}-clip` };
  const land = viewport ? worldLandPath() : "";
  const borders = viewport ? worldBordersPath() : "";
  const geoTransform = (offset: number) => viewport
    ? `translate(${viewport.x(offset).toFixed(2)} ${viewport.y(0).toFixed(2)}) scale(${(viewport.sx / WORLD_GEO_UNIT).toFixed(5)} ${(-viewport.sy / WORLD_GEO_UNIT).toFixed(5)})`
    : undefined;

  // 断了的线放最上面画，不被正常的线盖住
  const drawOrder = [...bundles].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  // 胶囊：有问题的画在最后（最上层）
  const labelOrder = placed.map((node, index) => ({ node, label: labels[index], tone: tones.get(node.id) ?? "off" }))
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  const openCluster = openId === null ? null : byId.get(openId) ?? null;

  const nearest = new Map(placed.map((node) => [
    node.id,
    placed.reduce((min, other) => (other === node ? min : Math.min(min, Math.hypot(other.x - node.x, other.y - node.y))), Infinity),
  ]));

  const openNode = (node: OverviewCluster) => {
    if (node.members.length > 1) setOpenId((current) => (current === node.id ? null : node.id));
    else onOpen?.("/hosts");
  };

  return (
    <div ref={ref} className="fx-overview relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="block h-auto w-full"
        role="img"
        aria-label={`概览：${model.nodes.length} 台主机，${placed.length} 个地点，${bundles.length} 段连线`}
        onClick={(event) => { if (event.target === event.currentTarget) setOpenId(null); }}
      >
        <defs>
          <linearGradient id={ids.ring} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="color-mix(in srgb, var(--fx-primary-fill) 55%, white)" />
            <stop offset="1" stopColor="var(--fx-primary-fill)" />
          </linearGradient>
          {/* 线的渐变按画布坐标铺（objectBoundingBox 遇到接近水平 / 竖直的线会画不出来） */}
          <linearGradient id={ids.line} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={width} y2="0">
            <stop offset="0" stopColor="color-mix(in srgb, var(--fx-primary-fill) 62%, white)" />
            <stop offset="1" stopColor="var(--fx-primary-fill)" />
          </linearGradient>
          <clipPath id={ids.clip}><rect width={width} height={height} /></clipPath>
          <radialGradient id={ids.vignette} cx="50%" cy="45%" r="70%">
            <stop offset="0.6" stopColor="var(--fx-overview-canvas)" stopOpacity="0" />
            <stop offset="1" stopColor="var(--fx-overview-canvas)" stopOpacity="0.75" />
          </radialGradient>
        </defs>

        {viewport ? (
          // 陆地填色 + 海岸线，再描一层陆地国界；单位 0.05° 的 path 整体缩放到画布上，描边不跟着缩；跨太平洋时再画一份 +360°
          <g aria-hidden="true" clipPath={`url(#${ids.clip})`} pointerEvents="none">
            {[0, 360].map((offset) => (
              <g key={offset} transform={geoTransform(offset)}>
                <path d={land} className="fx-overview-land" fillRule="evenodd" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                <path d={borders} className="fx-overview-borders" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </g>
            ))}
          </g>
        ) : null}

        <rect width={width} height={height} fill={`url(#${ids.vignette})`} pointerEvents="none" aria-hidden="true" />

        <g>
          {drawOrder.map((bundle) => {
            const a = byId.get(bundle.from), b = byId.get(bundle.to);
            if (!a || !b) return null;
            const inset = Math.max(clusterRadius(a), clusterRadius(b)) + 5;
            const { d, mid } = overviewCurve(a, b, overviewBend(bundle), inset);
            const href = bundle.tunnels > 0 ? "/tunnels" : "/rules";
            const strokeWidth = 1.6 + Math.min(4, bundle.tunnels + bundle.forwards) * 0.45;
            const dashed = bundle.tone !== "ok";
            return (
              <g key={bundle.key} className={onOpen ? "cursor-pointer" : undefined} onClick={onOpen ? () => onOpen(href) : undefined}>
                <title>{bundleTitle(bundle, a, b)}</title>
                {!dashed ? <path d={d} fill="none" stroke="var(--fx-primary-fill)" strokeOpacity={0.14} strokeWidth={strokeWidth + 5} strokeLinecap="round" /> : null}
                <path
                  d={d}
                  fill="none"
                  stroke={dashed ? TONE_STROKE[bundle.tone] : `url(#${ids.line})`}
                  strokeWidth={dashed ? 1.8 : strokeWidth}
                  strokeOpacity={bundle.tone === "off" ? 0.6 : 0.95}
                  strokeDasharray={dashed ? "5 5" : undefined}
                  strokeLinecap="round"
                />
                {!dashed ? <path d={d} fill="none" strokeWidth={Math.max(1.6, strokeWidth - 1.6)} className="fx-overview-flow" /> : null}
                {bundle.tone === "down" ? (
                  <g transform={`translate(${mid.x.toFixed(1)} ${mid.y.toFixed(1)})`}>
                    <circle r={7} fill="var(--fx-l1-surface)" stroke="var(--fx-down)" strokeWidth={1.5} />
                    <path d="M-3 -3 l6 6 M3 -3 l-6 6" stroke="var(--fx-down)" strokeWidth={1.6} strokeLinecap="round" />
                  </g>
                ) : null}
                {/* 透明的粗一层，细线也点得中 */}
                <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
              </g>
            );
          })}
        </g>

        {/* 被推开的城市：真实位置一个小点，细线连到画出来的点上 */}
        <g aria-hidden="true" pointerEvents="none">
          {placed.map((node) => {
            const dx = node.x - node.anchor.x, dy = node.y - node.anchor.y;
            const d = Math.hypot(dx, dy);
            if (d < 2) return null;
            const r = clusterRadius(node);
            const tone = tones.get(node.id) ?? "off";
            const color = tone === "ok" ? "var(--fx-primary-fill)" : TONE_STROKE[tone];
            const ex = node.x - (dx / d) * r, ey = node.y - (dy / d) * r;
            return (
              <g key={node.id}>
                {d > r ? <path d={`M${node.anchor.x.toFixed(1)} ${node.anchor.y.toFixed(1)} L${ex.toFixed(1)} ${ey.toFixed(1)}`} className="fx-overview-tether" /> : null}
                <circle cx={node.anchor.x} cy={node.anchor.y} r={2.2} fill={color} />
              </g>
            );
          })}
        </g>

        <g>
          {placed.map((node) => {
            const tone = tones.get(node.id) ?? "off";
            const r = clusterRadius(node);
            const many = node.members.length > 1;
            const fill = tone === "ok" ? `url(#${ids.ring})` : TONE_STROKE[tone];
            const names = node.members.slice(0, 8).map((member) => member.name).join("、");
            return (
              <g
                key={node.id}
                transform={`translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`}
                className={onOpen || many ? "cursor-pointer" : undefined}
                onClick={() => openNode(node)}
                data-cluster={many ? node.members.length : undefined}
              >
                <title>{`${node.unlocated ? "未定位" : node.city || node.name} · ${names}${node.members.length > 8 ? ` 等 ${node.members.length} 台` : ""} · ${clusterTitleStatus(node, inner.get(node.id))}`}</title>
                {tone === "ok" ? (
                  <>
                    <circle r={r + 9.5} fill="var(--fx-primary-fill)" fillOpacity={0.1} />
                    <circle r={r + 4} fill="var(--fx-primary-fill)" fillOpacity={0.22} />
                  </>
                ) : tone === "down" || tone === "warn" ? (
                  <circle r={r + 6.5} fill={TONE_STROKE[tone]} fillOpacity={0.14} />
                ) : null}
                {many ? (
                  <>
                    <circle r={r} fill={fill} stroke="var(--fx-l1-surface)" strokeWidth={2} />
                    <text y={3.6} textAnchor="middle" className="fx-overview-count">{node.members.length}</text>
                  </>
                ) : (
                  <circle r={r} fill="var(--fx-l1-surface)" stroke={fill} strokeWidth={2.6} />
                )}
                {/* 透明的大一圈，手指也点得中；挨着别的点时不超过两点距离的一半，免得盖住邻居 */}
                <circle r={Math.max(r + 1, Math.min(Math.max(14, r + 6), (nearest.get(node.id) ?? Infinity) / 2))} fill="transparent" />
              </g>
            );
          })}
        </g>

        <g>
          {labelOrder.map(({ node, label, tone }) => (
            <g
              key={node.id}
              transform={`translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`}
              className={onOpen || node.members.length > 1 ? "cursor-pointer" : undefined}
              onClick={() => openNode(node)}
            >
              {label.leader ? (
                <path d={leaderPath(clusterRadius(node), { x: label.dx, y: label.dy, w: label.width, h: label.height })} className="fx-overview-leader" />
              ) : null}
              <g transform={`translate(${label.dx.toFixed(1)} ${label.dy.toFixed(1)})`} className="fx-overview-label">
                <rect width={label.width} height={label.height} rx={12} className="fx-overview-label-box" />
                <text x={10} y={16} className="fx-overview-city" data-tone={tone === "down" || tone === "warn" ? tone : undefined}>{label.line1}</text>
              </g>
            </g>
          ))}
        </g>
      </svg>

      {openCluster ? (
        <ClusterPopover
          cluster={openCluster}
          width={width}
          height={height}
          onClose={() => setOpenId(null)}
          onOpenHost={() => { setOpenId(null); onOpen?.("/hosts"); }}
        />
      ) : null}
    </div>
  );
}

/** 合起来的点展开的列表：最该先看的排前面（和首页「需要关注」同一个顺序），放不下就在气泡里滚，点一行去主机页 */
function ClusterPopover({ cluster, width, height, onClose, onOpenHost }: {
  cluster: OverviewCluster;
  width: number;
  height: number;
  onClose: () => void;
  onOpenHost: () => void;
}) {
  const r = clusterRadius(cluster);
  const left = Math.min(Math.max(cluster.x - POPOVER_W / 2, 6), width - POPOVER_W - 6);
  const members = [...cluster.members].sort((a, b) => networkHealthPriority(a.health) - networkHealthPriority(b.health) || a.id - b.id);
  // 手机上地图只有两百来像素高：气泡最高到地图高减 16，放不下的行在气泡里滚，气泡整个留在地图里
  const rowH = popoverRowHeight();
  const shown = members.length <= POPOVER_ROWS ? members : members.slice(0, POPOVER_ROWS - 1);
  const popH = Math.min(height - 16, rowH + POPOVER_PAD + rowH * (shown.length + (members.length > shown.length ? 1 : 0)));
  // 点下面地方大就放下面，否则放上面；哪边都放不下就贴着地图上下边，盖住点也没关系
  const below = height - cluster.y >= cluster.y;
  const wanted = below ? cluster.y + r + 8 : cluster.y - r - 8 - popH;
  const top = Math.min(Math.max(wanted, 8), height - popH - 8);
  const title = cluster.unlocated ? "未定位" : cluster.city || "这几台";
  return (
    <div
      role="dialog"
      aria-label={`${title}的 ${cluster.members.length} 台主机`}
      className="fx-overview-popover"
      style={{
        left,
        width: POPOVER_W,
        top,
        maxHeight: height - 16,
      }}
    >
      <div className="fx-overview-popover-head">
        <span className="truncate">{title}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{cluster.members.length} 台</span>
        <button type="button" aria-label="收起" className="fx-overview-popover-close" onClick={onClose}>×</button>
      </div>
      <div className="fx-overview-popover-list">
      {shown.map((member) => (
        <button key={member.id} type="button" className="fx-overview-popover-row" onClick={onOpenHost}>
          <span aria-hidden="true" className="fx-overview-popover-dot" data-tone={hostTone(member.health)} />
          <span className="min-w-0 flex-1 truncate text-left">{member.name}</span>
          {member.city && member.city !== title ? <span className="shrink-0 text-muted-foreground">{member.city}</span> : null}
        </button>
      ))}
      {members.length > shown.length ? (
        <button type="button" className="fx-overview-popover-row text-muted-foreground" onClick={onOpenHost}>还有 {members.length - shown.length} 台 →</button>
      ) : null}
      </div>
    </div>
  );
}
