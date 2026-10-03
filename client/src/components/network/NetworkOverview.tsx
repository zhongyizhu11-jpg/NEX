import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  buildOverviewEdges,
  layoutOverview,
  overviewBends,
  overviewCurve,
  type OverviewEdge,
  type OverviewEdgeTone,
  type OverviewNode,
} from "@/features/network/networkOverview";
import type { NetworkMapModel } from "@/features/network/networkMapModel";
import { describeNetworkHealth } from "@shared/networkHealth";
import type { ForwardMapLink } from "@shared/forwardMapLinks";

/**
 * 首页「概览」图：白底，主机是一颗小圆点（颜色说在线 / 离线），落在它大致的地理位置上；
 * 隧道是主色的线，端口转发 / 转发链是深灰的线，箭头指向流量去的那台；断了的红色虚线，停用的浅灰虚线。
 * 不画地图、不画动画 —— 一眼看清「机器在哪、谁转给谁、哪条断了」。
 *
 * 点主机去主机页，点隧道去隧道页，点转发去转发页。
 */
const NODE_R = 5.5;
const INSET = NODE_R + 4;

const TONE_STROKE: Record<OverviewEdgeTone, string> = {
  ok: "",
  warn: "var(--fx-warn)",
  down: "var(--fx-down)",
  off: "var(--fx-text-muted)",
};

function edgeStroke(edge: OverviewEdge) {
  if (edge.tone !== "ok") return TONE_STROKE[edge.tone];
  return edge.kind === "tunnel" ? "var(--fx-accent)" : "var(--fx-text-secondary)";
}

function nodeFill(node: OverviewNode) {
  const token = describeNetworkHealth(node.health).token;
  return token === "healthy" ? "var(--fx-healthy)" : token === "down" ? "var(--fx-down)" : "var(--fx-text-muted)";
}

function truncate(text: string, max: number) {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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

export function NetworkOverview({ model, forwardLinks, onOpen, initialWidth = 720 }: {
  model: Pick<NetworkMapModel, "nodes" | "links">;
  forwardLinks: readonly ForwardMapLink[];
  onOpen?: (href: string) => void;
  /** 量到真实宽度之前（以及服务端渲染时）按这个宽度画 */
  initialWidth?: number;
}) {
  const { ref, width } = useMeasuredWidth(initialWidth);
  const height = Math.round(Math.min(360, Math.max(240, width * 0.44)));
  const placed = useMemo(() => layoutOverview(model.nodes, width, height), [model.nodes, width, height]);
  const byId = useMemo(() => new Map(placed.map((node) => [node.id, node])), [placed]);
  const edges = useMemo(() => buildOverviewEdges(model, forwardLinks), [model, forwardLinks]);
  const bends = useMemo(() => overviewBends(edges), [edges]);
  const labelMax = width < 480 ? 8 : 12;
  const markerBase = useId().replace(/:/g, "");
  const markerId = (edge: OverviewEdge) => `${markerBase}-${edge.tone === "ok" ? edge.kind : edge.tone}`;
  const markers: Array<{ id: string; color: string }> = [
    { id: `${markerBase}-tunnel`, color: "var(--fx-accent)" },
    { id: `${markerBase}-forward`, color: "var(--fx-text-secondary)" },
    { id: `${markerBase}-warn`, color: TONE_STROKE.warn },
    { id: `${markerBase}-down`, color: TONE_STROKE.down },
    { id: `${markerBase}-off`, color: TONE_STROKE.off },
  ];

  // 断了的线放最上面画，不被正常的线盖住
  const drawOrder = [...edges].sort((a, b) => toneRank(a.tone) - toneRank(b.tone));

  return (
    <div ref={ref} className="fx-overview relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="block h-auto w-full"
        role="img"
        aria-label={`概览：${model.nodes.length} 台主机，${edges.length} 段连线`}
      >
        <defs>
          {markers.map((marker) => (
            <marker key={marker.id} id={marker.id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
              <path d="M0.5 0.8 L7.5 4 L0.5 7.2 Z" fill={marker.color} />
            </marker>
          ))}
        </defs>

        <g>
          {drawOrder.map((edge) => {
            const a = byId.get(edge.from), b = byId.get(edge.to);
            if (!a || !b) return null;
            const d = overviewCurve(a, b, bends.get(edge.key) ?? 0.35, INSET);
            const href = edge.kind === "tunnel" ? "/tunnels" : "/rules";
            const title = `${a.name} → ${b.name} · ${edge.kind === "tunnel" ? `隧道 ${edge.label}` : edge.label}${edge.tone === "down" ? " · 中断" : edge.tone === "off" ? " · 停用" : edge.tone === "warn" ? " · 降级" : ""}`;
            return (
              <g key={edge.key} className={onOpen ? "cursor-pointer" : undefined} onClick={onOpen ? () => onOpen(href) : undefined}>
                <title>{title}</title>
                <path
                  d={d}
                  fill="none"
                  stroke={edgeStroke(edge)}
                  strokeWidth={edge.kind === "tunnel" ? 1.8 : 1.4}
                  strokeOpacity={edge.tone === "off" ? 0.6 : 0.9}
                  strokeDasharray={edge.tone === "down" || edge.tone === "off" ? "5 4" : undefined}
                  strokeLinecap="round"
                  markerEnd={`url(#${markerId(edge)})`}
                />
                {/* 透明的粗一层，细线也点得中 */}
                <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
              </g>
            );
          })}
        </g>

        <g>
          {placed.map((node) => {
            const note = node.unlocated ? "未定位" : node.city && node.city !== node.name ? node.city : "";
            return (
              <g
                key={node.id}
                transform={`translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`}
                className={onOpen ? "cursor-pointer" : undefined}
                onClick={onOpen ? () => onOpen("/hosts") : undefined}
              >
                <title>{`${node.name}${note ? ` · ${note}` : ""} · ${describeNetworkHealth(node.health).label}`}</title>
                <circle r={NODE_R + 3} fill="var(--fx-l1-surface)" />
                <circle r={NODE_R} fill={nodeFill(node)} />
                <text y={NODE_R + 14} textAnchor="middle" className="fx-overview-label">{truncate(node.name, labelMax)}</text>
                {note ? <text y={NODE_R + 26} textAnchor="middle" className="fx-overview-note">{truncate(note, labelMax + 2)}</text> : null}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function toneRank(tone: OverviewEdgeTone) {
  return tone === "off" ? 0 : tone === "ok" ? 1 : tone === "warn" ? 2 : 3;
}
