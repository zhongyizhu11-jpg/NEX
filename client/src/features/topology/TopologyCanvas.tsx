import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { countryFlagLabel } from "@/lib/flagEmojiSupport";
import { TOPOLOGY_EDGE_KIND_LABELS, TOPOLOGY_STATUS_LABELS, type TopologyEdge, type TopologyNode } from "@shared/networkTopology";
import type { TopologyLayout } from "./topologyLayout";
import { topologyEdgeWidth, topologyNodeTone, topologyRoleText } from "./topologyView";

/*
  拓扑图的画布：内联 SVG，滚轮缩放、拖动平移（手机上单指拖、双指捏合），一个「适应窗口」。

  不用图形库：节点几十到几百个，SVG 直接画足够快；布局在 topologyLayout.ts 里算好，这里只管
  画和手势。拖动超过 4px 才算拖（之前的按下 / 抬起仍然是点击），所以点节点、点连线不会被平移吃掉。
*/

/*
  颜色全走主题令牌（SVG 属性里直接写 var()，换主题、切深浅色跟着变，不用重画）：
  连线按「哪一种」上色用分类色（--fx-cat-* / 图表色），状态只用状态色（红 / 琥珀），两套不混。
*/
export const TOPOLOGY_KIND_COLORS: Record<TopologyEdge["kind"], string> = {
  rule: "var(--fx-standby)",
  tunnel: "var(--fx-path)",
  chain: "var(--fx-chart-3)",
  routePath: "var(--fx-cat-orange)",
  subscription: "var(--fx-cat-teal)",
  group: "var(--fx-cat-indigo)",
};

const STATUS_COLORS = { failed: "var(--fx-down)", degraded: "var(--fx-warn)" } as const;

/** 没接上 / 被遮住的节点：比「目标」那种灰再淡一档 */
const FADED_GRAY = "color-mix(in srgb, var(--fx-standby) 60%, transparent)";

export const TOPOLOGY_TONE_COLORS: Record<ReturnType<typeof topologyNodeTone>, string> = {
  entry: "var(--fx-chart-1)",
  relay: "var(--fx-chart-3)",
  exit: "var(--fx-cat-orange)",
  landing: "var(--fx-chart-5)",
  target: "var(--fx-standby)",
  inbound: "var(--fx-cat-teal)",
  group: "var(--fx-cat-indigo)",
  masked: FADED_GRAY,
  idle: FADED_GRAY,
};

export function topologyEdgeColor(edge: Pick<TopologyEdge, "kind" | "status">) {
  if (edge.status === "failed") return STATUS_COLORS.failed;
  if (edge.status === "degraded") return STATUS_COLORS.degraded;
  return TOPOLOGY_KIND_COLORS[edge.kind];
}

function edgeDash(edge: Pick<TopologyEdge, "kind" | "status" | "activePath">) {
  if (edge.status === "stopped") return "6 4";
  // 线路组的备用路径：细虚线，和「在走的那条」一眼分开。
  if (edge.activePath === false) return "3 4";
  if (edge.kind === "subscription") return "2 3";
  if (edge.kind === "group") return "5 3";
  return undefined;
}

/** 边上那枚小药丸写什么：有延迟写延迟，没延迟但有流量写速率；都没有不画。 */
export function topologyEdgeBadge(edge: Pick<TopologyEdge, "latencyMs" | "rateBps" | "status">): string | null {
  if (edge.status === "stopped") return null;
  if (edge.latencyMs !== null && edge.latencyMs !== undefined) return `${Math.round(edge.latencyMs)} ms`;
  if (edge.rateBps && edge.rateBps > 0) return formatEdgeRate(edge.rateBps);
  return null;
}

export function formatEdgeRate(bps: number) {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(bps >= 10 * 1024 ? 0 : 1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

/** 有流量在走、而且线是正常的：画流动的小段。 */
function edgeFlowing(edge: Pick<TopologyEdge, "rateBps" | "status" | "activePath">) {
  return !!edge.rateBps && edge.rateBps > 0 && edge.status !== "stopped" && edge.status !== "failed" && edge.activePath !== false;
}

type Transform = { k: number; x: number; y: number };

export type TopologyCanvasHandle = { fit: (mode?: "all" | "readable") => void; zoomBy: (factor: number) => void };

export type TopologyCanvasProps = {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  layout: TopologyLayout;
  columnLabels: string[];
  highlight: { nodeIds: Set<string>; edgeIds: Set<string> } | null;
  selectedId: string | null;
  ruleNames: Map<number, string>;
  onSelectNode: (node: TopologyNode) => void;
  onSelectEdge: (edge: TopologyEdge) => void;
  onClearSelection: () => void;
  className?: string;
  /** 节点第二行写什么；不给就写角色（入口 · 中转 / 落地入站 / 外部目标…），和拓扑图一样。 */
  nodeCaption?: (node: TopologyNode) => string;
  /** 紧凑：字小一号、边距收窄，配窄格子用（手机上的「我的线路」）。 */
  compact?: boolean;
  /** 自动适应时，整张放下后不小于这个倍数就整张放下，否则按这个倍数放、上下拖着看。 */
  minReadableScale?: number;
  /** 顶上留给列标题的高度：适应窗口时图从这下面开始放，免得列标题压在第一行节点上。 */
  topInset?: number;
  /**
   * 手指在图上竖着划交给谁："none" 全归画布（拖动 / 双指缩放，拓扑图）；"pan-y" 竖着划滚页面、
   * 横着拖才平移（手机上「我的线路」画布和图一样高，整张图在页面里，下面还有线路清单要划到）。
   */
  touchAction?: "none" | "pan-y";
};

/** 节点里字的大小和位置：常规 / 紧凑。 */
const NODE_TEXT = {
  // labelPad 里含右上角状态点的位置（dotRoom）；没有状态点的节点（外部目标、落地地址）名字可以多写这么宽。
  normal: { label: 12.5, caption: 10.5, x: 14, labelY: 20, captionY: 37, dotY: 12, dotR: 4, labelPad: 34, dotRoom: 12, captionPad: 22, flag: 20, badgeFont: 10, badgeChar: 6.2, badgePad: 12 },
  compact: { label: 11.5, caption: 9.5, x: 11, labelY: 17, captionY: 31, dotY: 10, dotR: 3.5, labelPad: 28, dotRoom: 10, captionPad: 16, flag: 18, badgeFont: 9, badgeChar: 5.4, badgePad: 8 },
} as const;

type Hover = { kind: "node" | "edge"; id: string; x: number; y: number } | null;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 按格子宽度截断节点上的字：中日韩字、全角符号按一个字宽算，别的按 0.6 个（无衬线字体的大致平均）。
 * 以前按字数截（16 / 19 / 22 个），中文名一长就画出格子；「我的线路」那张图的格子更窄，也得按宽度来。
 */
export function fitNodeText(text: string, maxWidth: number, fontSize: number) {
  // 按码点走，表情、生僻字这种两个 UTF-16 单元的字不会被从中间切开。
  const chars = Array.from(text);
  const widthOf = (char: string) => ((char.codePointAt(0) ?? 0) >= 0x2e80 ? fontSize : fontSize * 0.6);
  const total = chars.reduce((sum, char) => sum + widthOf(char), 0);
  if (total <= maxWidth) return text;
  const budget = maxWidth - widthOf("…");
  let used = 0;
  let end = 0;
  while (end < chars.length && used + widthOf(chars[end]) <= budget) {
    used += widthOf(chars[end]);
    end += 1;
  }
  return `${chars.slice(0, Math.max(1, end)).join("")}…`;
}

export const TopologyCanvas = forwardRef<TopologyCanvasHandle, TopologyCanvasProps>(function TopologyCanvas({
  nodes,
  edges,
  layout,
  columnLabels,
  highlight,
  selectedId,
  ruleNames,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  className,
  nodeCaption = topologyRoleText,
  compact = false,
  minReadableScale = 0.6,
  topInset = 0,
  touchAction = "none",
}, ref) {
  const nodeText = compact ? NODE_TEXT.compact : NODE_TEXT.normal;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<Transform>({ k: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<Hover>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; origin: Transform; dragged: boolean; pinchDistance?: number; pinchCenter?: { x: number; y: number } } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /*
    适应窗口：整张图刚好放下。图很高（几十个外部目标排成一列）时整张放下字就小得看不清了，
    所以自动适应用「读得清」的版本：缩到不小于 0.6 倍，宽度能放下就按宽放、顶端对齐，
    剩下的上下拖着看；右上角的按钮才是真正的「全部放下」。
  */
  const fit = useCallback((mode: "all" | "readable" = "all") => {
    if (size.width <= 0 || size.height <= 0 || layout.width <= 0) return;
    const usableHeight = Math.max(1, size.height - topInset);
    const widthFit = (size.width - 16) / layout.width;
    const heightFit = (usableHeight - 16) / layout.height;
    const all = clamp(Math.min(widthFit, heightFit), 0.15, 1.25);
    if (mode === "all" || all >= minReadableScale) {
      setTransform({ k: all, x: (size.width - layout.width * all) / 2, y: topInset + (usableHeight - layout.height * all) / 2 });
      return;
    }
    const k = clamp(Math.min(widthFit, 1), minReadableScale, 1.25);
    // 对准主机那几列（入口、中转、出口）的中间：目标那一列再长，要紧的也是前面这几列。
    const inner = nodes.filter((node) => node.kind !== "target" && node.kind !== "inbound").map((node) => layout.nodes.get(node.id)).filter((box) => !!box);
    const boxes = inner.length > 0 ? inner : Array.from(layout.nodes.values());
    const top = Math.min(...boxes.map((box) => box!.y));
    const bottom = Math.max(...boxes.map((box) => box!.y + box!.height));
    const left = Math.min(...boxes.map((box) => box!.x));
    const centerY = (top + bottom) / 2;
    const x = layout.width * k <= size.width ? (size.width - layout.width * k) / 2 : 8 - left * k;
    setTransform({ k, x, y: topInset + usableHeight / 2 - centerY * k });
  }, [size.width, size.height, layout, nodes, minReadableScale, topInset]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setTransform((current) => {
      const k = clamp(current.k * factor, 0.2, 3);
      const ratio = k / current.k;
      return { k, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
    });
  }, []);

  useImperativeHandle(ref, () => ({
    fit,
    zoomBy: (factor: number) => zoomAt(factor, size.width / 2, size.height / 2),
  }), [fit, zoomAt, size.width, size.height]);

  // 布局一变（筛选、换用户）就重新适应窗口；同一张图轮询刷新不动用户的缩放。
  const layoutSignature = `${layout.width}x${layout.height}:${layout.nodes.size}`;
  const fittedFor = useRef("");
  useEffect(() => {
    if (size.width <= 0) return;
    const key = `${layoutSignature}@${size.width}x${size.height}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    fit("readable");
  }, [layoutSignature, size.width, size.height, fit]);

  // 滚轮缩放要 preventDefault，React 的 onWheel 是 passive 的，只能自己挂。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left || 0), y: event.clientY - (rect?.top || 0) };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    suppressClick.current = false;
    if (pointers.current.size === 1) {
      gesture.current = { startX: point.x, startY: point.y, origin: transform, dragged: false };
    } else if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      gesture.current = {
        startX: point.x,
        startY: point.y,
        origin: transform,
        dragged: true,
        pinchDistance: Math.hypot(a.x - b.x, a.y - b.y),
        pinchCenter: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    const current = gesture.current;
    if (!current) return;
    if (pointers.current.size >= 2 && current.pinchDistance && current.pinchCenter) {
      const [a, b] = Array.from(pointers.current.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = clamp(current.origin.k * (distance / Math.max(1, current.pinchDistance)), 0.2, 3);
      const ratio = k / current.origin.k;
      setTransform({
        k,
        x: center.x - (current.pinchCenter.x - current.origin.x) * ratio,
        y: center.y - (current.pinchCenter.y - current.origin.y) * ratio,
      });
      return;
    }
    const dx = point.x - current.startX;
    const dy = point.y - current.startY;
    if (!current.dragged && Math.hypot(dx, dy) < 4) return;
    if (!current.dragged) {
      current.dragged = true;
      suppressClick.current = true;
      setHover(null);
      try {
        containerRef.current?.setPointerCapture(event.pointerId);
      } catch {
        // 有的浏览器在指针已经离开时不让捕获，拖动照样能用。
      }
    }
    setTransform({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
    } else if (pointers.current.size === 1) {
      const [remaining] = Array.from(pointers.current.values());
      gesture.current = { startX: remaining.x, startY: remaining.y, origin: transform, dragged: true };
    }
  };

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  // 同一对节点之间的几条连线（不同种类）错开一点，不叠成一条。
  const edgeGeometry = useMemo(() => {
    const groups = new Map<string, TopologyEdge[]>();
    for (const edge of edges) {
      const key = [edge.from, edge.to].sort().join("|");
      const list = groups.get(key) || [];
      list.push(edge);
      groups.set(key, list);
    }
    const result: Array<{ edge: TopologyEdge; d: string; mid: { x: number; y: number } }> = [];
    for (const list of groups.values()) {
      list.forEach((edge, index) => {
        const source = layout.nodes.get(edge.from);
        const target = layout.nodes.get(edge.to);
        if (!source || !target) return;
        const offset = (index - (list.length - 1) / 2) * 7;
        if (target.layer > source.layer) {
          const x1 = source.x + source.width;
          const y1 = source.y + source.height / 2 + offset;
          const x2 = target.x;
          const y2 = target.y + target.height / 2 + offset;
          const bend = Math.max(36, (x2 - x1) * 0.45);
          result.push({
            edge,
            d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
            mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
          });
        } else {
          // 回边 / 同列：从下面绕一道弧。
          const x1 = source.x + source.width / 2 + offset;
          const y1 = source.y + source.height;
          const x2 = target.x + target.width / 2 + offset;
          const y2 = target.y + target.height;
          const drop = 46 + Math.abs(x1 - x2) * 0.12;
          result.push({
            edge,
            d: `M ${x1} ${y1} C ${x1} ${y1 + drop}, ${x2} ${y2 + drop}, ${x2} ${y2}`,
            mid: { x: (x1 + x2) / 2, y: Math.max(y1, y2) + drop * 0.75 },
          });
        }
      });
    }
    return result;
  }, [edges, layout]);

  const markerColors = useMemo(() => Array.from(new Set(edges.map(topologyEdgeColor))).sort(), [edges]);
  const markerId = (color: string) => `topo-arrow-${markerColors.indexOf(color)}`;

  const hoverNode = hover?.kind === "node" ? nodeById.get(hover.id) : undefined;
  const hoverEdge = hover?.kind === "edge" ? edges.find((edge) => edge.id === hover.id) : undefined;
  const dimmed = (id: string, type: "node" | "edge") => !!highlight && !(type === "node" ? highlight.nodeIds.has(id) : highlight.edgeIds.has(id));

  return (
    <div
      ref={containerRef}
      className={`relative select-none overflow-hidden ${className || ""}`}
      style={{ touchAction, cursor: gesture.current?.dragged ? "grabbing" : "grab" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onClick={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        if (event.target === event.currentTarget || (event.target as Element).tagName === "svg") onClearSelection();
      }}
      data-testid="topology-canvas"
    >
      <svg width={size.width} height={size.height} role="img" aria-label="网络拓扑图" className="block">
        <defs>
          {markerColors.map((color) => (
            <marker key={color} id={markerId(color)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          {edgeGeometry.map(({ edge, d, mid }) => {
            const color = topologyEdgeColor(edge);
            const selected = selectedId === edge.id;
            const faded = dimmed(edge.id, "edge");
            const standby = edge.activePath === false;
            const flowing = edgeFlowing(edge);
            const badge = transform.k >= 0.55 && !standby ? topologyEdgeBadge(edge) : null;
            const badgeWidth = badge ? badge.length * nodeText.badgeChar + nodeText.badgePad : 0;
            return (
              <g key={edge.id} data-edge-id={edge.id} data-flowing={flowing ? "" : undefined} data-standby={standby ? "" : undefined} opacity={faded ? 0.12 : edge.status === "stopped" ? 0.5 : standby ? 0.55 : 1}>
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  style={{ cursor: "pointer" }}
                  onPointerEnter={(event) => {
                    if (gesture.current?.dragged) return;
                    const point = localPoint(event);
                    setHover({ kind: "edge", id: edge.id, x: point.x, y: point.y });
                  }}
                  onPointerLeave={() => setHover((current) => (current?.id === edge.id ? null : current))}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    onSelectEdge(edge);
                  }}
                />
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={(standby ? 1.2 : topologyEdgeWidth(edge.ruleIds.length)) + (selected ? 1.5 : 0)}
                  strokeDasharray={edgeDash(edge)}
                  strokeLinecap="round"
                  markerEnd={`url(#${markerId(color)})`}
                  pointerEvents="none"
                />
                {flowing ? (
                  // 流动的小段叠在线上：这是「此刻有流量」，不是状态。少动效模式下停住（CSS）。
                  <path d={d} fill="none" stroke="var(--color-card)" strokeWidth={Math.max(1.2, topologyEdgeWidth(edge.ruleIds.length) - 1.2)} strokeDasharray="3 11" strokeLinecap="round" className="topo-flow" pointerEvents="none" opacity={0.9} />
                ) : null}
                {badge ? (
                  <g transform={`translate(${mid.x - badgeWidth / 2} ${mid.y - 9})`} pointerEvents="none">
                    <rect width={badgeWidth} height={18} rx={9} fill="var(--color-card)" stroke={color} strokeOpacity={0.55} strokeWidth={1} />
                    <text x={badgeWidth / 2} y={compact ? 12 : 12.5} textAnchor="middle" fontSize={nodeText.badgeFont} fontWeight={600} fontFamily="var(--fx-font-mono)" className="fill-foreground">{badge}</text>
                  </g>
                ) : null}
              </g>
            );
          })}
          {nodes.map((node) => {
            const box = layout.nodes.get(node.id);
            if (!box) return null;
            const tone = TOPOLOGY_TONE_COLORS[topologyNodeTone(node)];
            const selected = selectedId === node.id;
            const flag = node.country ? countryFlagLabel(node.country) : "";
            const statusColor = node.online === null ? null : node.online ? "var(--fx-healthy)" : "var(--fx-down)";
            return (
              <g
                key={node.id}
                data-node-id={node.id}
                transform={`translate(${box.x} ${box.y})`}
                opacity={dimmed(node.id, "node") ? 0.22 : 1}
                style={{ cursor: "pointer" }}
                onPointerEnter={(event) => {
                  if (gesture.current?.dragged) return;
                  const point = localPoint(event);
                  setHover({ kind: "node", id: node.id, x: point.x, y: point.y });
                }}
                onPointerLeave={() => setHover((current) => (current?.id === node.id ? null : current))}
                onClick={(event) => {
                  event.stopPropagation();
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  onSelectNode(node);
                }}
              >
                <rect
                  width={box.width}
                  height={box.height}
                  rx={node.kind === "target" ? 24 : 10}
                  fill="var(--color-card)"
                  stroke={selected ? "var(--color-primary)" : tone}
                  strokeWidth={selected ? 2.4 : 1.2}
                  strokeDasharray={node.masked ? "4 3" : undefined}
                />
                <rect x={0} y={0} width={5} height={box.height} rx={2.5} fill={tone} opacity={node.kind === "target" ? 0 : 1} />
                {statusColor ? <circle cx={box.width - nodeText.x + 3} cy={nodeText.dotY} r={nodeText.dotR} fill={statusColor} /> : null}
                <text x={nodeText.x} y={nodeText.labelY} fontSize={nodeText.label} fontWeight={600} className="fill-foreground">
                  {flag && flag.length <= 4 ? `${flag} ` : ""}{fitNodeText(node.label, box.width - nodeText.labelPad + (statusColor ? 0 : nodeText.dotRoom) - (flag && flag.length <= 4 ? nodeText.flag : 0), nodeText.label)}
                </text>
                <text x={nodeText.x} y={nodeText.captionY} fontSize={nodeText.caption} className="fill-muted-foreground">
                  {fitNodeText(nodeCaption(node), box.width - nodeText.captionPad, nodeText.caption)}
                </text>
              </g>
            );
          })}
        </g>
        {/* 列标题钉在画布顶上（跟着横向平移和缩放，不跟着上下拖走）；留了顶边就垫一层底色，图往上拖时节点从标题下面过，不叠字 */}
        {topInset > 0 ? <rect x={0} y={0} width={size.width} height={topInset} fill="var(--color-card)" opacity={0.92} pointerEvents="none" /> : null}
        {columnLabels.map((label, index) => {
          const column = layout.layers[index] || [];
          const first = column.length > 0 ? layout.nodes.get(column[0]) : undefined;
          if (!first || !label) return null;
          const x = transform.x + (first.x + layout.nodeWidth / 2) * transform.k;
          if (x < -40 || x > size.width + 40) return null;
          return (
            <text key={`column-${index}`} x={x} y={16} textAnchor="middle" className="fill-muted-foreground" fontSize={11} fontWeight={600} pointerEvents="none">
              {label}
            </text>
          );
        })}
      </svg>
      {hover && (hoverNode || hoverEdge) ? (
        <div
          className="pointer-events-none absolute z-10 max-w-[260px] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
          style={{ left: clamp(hover.x + 14, 4, Math.max(4, size.width - 268)), top: clamp(hover.y + 14, 4, Math.max(4, size.height - 120)) }}
          role="tooltip"
        >
          {hoverNode ? (
            <>
              <p className="font-semibold">{hoverNode.label}</p>
              <p className="text-muted-foreground">{topologyRoleText(hoverNode)}{hoverNode.sublabel ? ` · ${hoverNode.sublabel}` : ""}</p>
              {hoverNode.online !== null ? <p>{hoverNode.online ? "在线" : "离线"}</p> : null}
              <p className="text-muted-foreground">{hoverNode.ruleIds.length} 条规则 · {hoverNode.tunnelIds.length} 条隧道 · {hoverNode.groupIds.length} 个组</p>
            </>
          ) : hoverEdge ? (
            <>
              <p className="font-semibold">{TOPOLOGY_EDGE_KIND_LABELS[hoverEdge.kind]}{hoverEdge.label ? ` · ${hoverEdge.label}` : ""}</p>
              <p>
                {nodeById.get(hoverEdge.from)?.label} → {nodeById.get(hoverEdge.to)?.label}
              </p>
              <p className="text-muted-foreground">
                {TOPOLOGY_STATUS_LABELS[hoverEdge.status]}
                {hoverEdge.protocol ? ` · ${hoverEdge.protocol.toUpperCase()}` : ""}
                {hoverEdge.port ? ` · :${hoverEdge.port}` : ""}
                {hoverEdge.latencyMs !== null ? ` · ${hoverEdge.latencyMs} ms` : ""}
                {hoverEdge.rateBps !== null && hoverEdge.rateBps > 0 ? ` · ${formatEdgeRate(hoverEdge.rateBps)}` : ""}
              </p>
              {hoverEdge.activePath !== null ? (
                <p className="text-muted-foreground">{hoverEdge.activePath ? "当前走的路径" : "备用路径（此刻没走）"}</p>
              ) : null}
              {hoverEdge.ruleIds.length > 0 ? (
                <p className="text-muted-foreground">
                  {hoverEdge.ruleIds.slice(0, 3).map((id) => ruleNames.get(id) || `规则 ${id}`).join("、")}
                  {hoverEdge.ruleIds.length > 3 ? ` 等 ${hoverEdge.ruleIds.length} 条` : ""}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
