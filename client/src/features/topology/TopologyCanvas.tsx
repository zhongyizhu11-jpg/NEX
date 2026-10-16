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

export const TOPOLOGY_KIND_COLORS: Record<TopologyEdge["kind"], string> = {
  rule: "#64748b",
  tunnel: "#2563eb",
  chain: "#7c3aed",
  routePath: "#d97706",
  subscription: "#0d9488",
  group: "#4f46e5",
};

const STATUS_COLORS = { failed: "#dc2626", degraded: "#ea580c" } as const;

export const TOPOLOGY_TONE_COLORS: Record<ReturnType<typeof topologyNodeTone>, string> = {
  entry: "#0284c7",
  relay: "#7c3aed",
  exit: "#d97706",
  landing: "#059669",
  target: "#64748b",
  inbound: "#0d9488",
  group: "#4f46e5",
  masked: "#94a3b8",
  idle: "#94a3b8",
};

export function topologyEdgeColor(edge: Pick<TopologyEdge, "kind" | "status">) {
  if (edge.status === "failed") return STATUS_COLORS.failed;
  if (edge.status === "degraded") return STATUS_COLORS.degraded;
  return TOPOLOGY_KIND_COLORS[edge.kind];
}

function edgeDash(edge: Pick<TopologyEdge, "kind" | "status">) {
  if (edge.status === "stopped") return "6 4";
  if (edge.kind === "subscription") return "2 3";
  if (edge.kind === "group") return "5 3";
  return undefined;
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
};

type Hover = { kind: "node" | "edge"; id: string; x: number; y: number } | null;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
}, ref) {
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
    const widthFit = (size.width - 16) / layout.width;
    const heightFit = (size.height - 16) / layout.height;
    const all = clamp(Math.min(widthFit, heightFit), 0.15, 1.25);
    if (mode === "all" || all >= 0.6) {
      setTransform({ k: all, x: (size.width - layout.width * all) / 2, y: (size.height - layout.height * all) / 2 });
      return;
    }
    const k = clamp(Math.min(widthFit, 1), 0.6, 1.25);
    // 对准主机那几列（入口、中转、出口）的中间：目标那一列再长，要紧的也是前面这几列。
    const inner = nodes.filter((node) => node.kind !== "target" && node.kind !== "inbound").map((node) => layout.nodes.get(node.id)).filter((box) => !!box);
    const boxes = inner.length > 0 ? inner : Array.from(layout.nodes.values());
    const top = Math.min(...boxes.map((box) => box!.y));
    const bottom = Math.max(...boxes.map((box) => box!.y + box!.height));
    const left = Math.min(...boxes.map((box) => box!.x));
    const centerY = (top + bottom) / 2;
    const x = layout.width * k <= size.width ? (size.width - layout.width * k) / 2 : 8 - left * k;
    setTransform({ k, x, y: size.height / 2 - centerY * k });
  }, [size.width, size.height, layout, nodes]);

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
      style={{ touchAction: "none", cursor: gesture.current?.dragged ? "grabbing" : "grab" }}
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
          {edgeGeometry.map(({ edge, d }) => {
            const color = topologyEdgeColor(edge);
            const selected = selectedId === edge.id;
            const faded = dimmed(edge.id, "edge");
            return (
              <g key={edge.id} data-edge-id={edge.id} opacity={faded ? 0.12 : edge.status === "stopped" ? 0.5 : 1}>
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
                  strokeWidth={topologyEdgeWidth(edge.ruleIds.length) + (selected ? 1.5 : 0)}
                  strokeDasharray={edgeDash(edge)}
                  strokeLinecap="round"
                  markerEnd={`url(#${markerId(color)})`}
                  pointerEvents="none"
                />
              </g>
            );
          })}
          {nodes.map((node) => {
            const box = layout.nodes.get(node.id);
            if (!box) return null;
            const tone = TOPOLOGY_TONE_COLORS[topologyNodeTone(node)];
            const selected = selectedId === node.id;
            const flag = node.country ? countryFlagLabel(node.country) : "";
            const statusColor = node.online === null ? null : node.online ? "#16a34a" : "#dc2626";
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
                {statusColor ? <circle cx={box.width - 11} cy={12} r={4} fill={statusColor} /> : null}
                <text x={14} y={20} fontSize={12.5} fontWeight={600} className="fill-foreground">
                  {flag && flag.length <= 4 ? `${flag} ` : ""}{truncate(node.label, flag ? 16 : 19)}
                </text>
                <text x={14} y={37} fontSize={10.5} className="fill-muted-foreground">
                  {truncate(topologyRoleText(node), 22)}
                </text>
              </g>
            );
          })}
        </g>
        {/* 列标题钉在画布顶上（跟着横向平移和缩放，不跟着上下拖走） */}
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
              </p>
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
