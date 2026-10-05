import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  buildOverviewEdges,
  bundleOverviewEdges,
  layoutOverview,
  overviewBend,
  overviewCurve,
  overviewViewport,
  placeOverviewLabels,
  type OverviewBundle,
  type OverviewEdgeTone,
  type OverviewNode,
} from "@/features/network/networkOverview";
import type { NetworkMapModel } from "@/features/network/networkMapModel";
import { worldDots } from "@/features/network/worldDots";
import { describeNetworkHealth } from "@shared/networkHealth";
import type { ForwardMapLink } from "@shared/forwardMapLinks";

/**
 * 首页「概览」图：一层主色点阵的世界剪影（裁到主机所在的那片），主机按真实位置落在上面，
 * 画成带渐变环的点，旁边一枚两行的胶囊写「旗 · 城市 / 主机名」；主机之间的线合成一条，
 * 正常 = 主色实线 + 往出口流动的光点，降级 = 琥珀虚线，中断 = 红虚线、正中一个 ⊗，停用 = 灰虚线。
 * 纯 SVG，没有瓦片、没有地图库。
 *
 * 点主机去主机页，点线去隧道页（这一对只有转发时去转发页）。
 */
const NODE_R = 5.5;
const EDGE_INSET = NODE_R + 5;
/** 画布外再多画一点点阵，圆角裁掉的地方不留白边 */
const DOT_MARGIN = 2;

const TONE_STROKE: Record<OverviewEdgeTone, string> = {
  ok: "var(--fx-primary-fill)",
  warn: "var(--fx-warn)",
  down: "var(--fx-down)",
  off: "var(--fx-text-muted)",
};

function nodeStroke(node: OverviewNode, gradientId: string) {
  const token = describeNetworkHealth(node.health).token;
  return token === "healthy" ? `url(#${gradientId})` : token === "down" ? "var(--fx-down)" : "var(--fx-text-muted)";
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

function bundleTitle(bundle: OverviewBundle, a: OverviewNode, b: OverviewNode) {
  const parts: string[] = [];
  if (bundle.tunnels > 0) parts.push(`隧道 ${bundle.tunnelNames.join("、")}`);
  if (bundle.forwards > 0) parts.push(`${bundle.forwards} 条转发`);
  if (bundle.tone === "down") parts.push("中断");
  else if (bundle.tone === "warn") parts.push("降级");
  else if (bundle.tone === "off") parts.push("停用");
  return `${a.name} → ${b.name} · ${parts.join(" · ")}`;
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
  const viewport = useMemo(() => overviewViewport(model.nodes, width, height), [model.nodes, width, height]);
  const placed = useMemo(() => layoutOverview(model.nodes, width, height), [model.nodes, width, height]);
  const byId = useMemo(() => new Map(placed.map((node) => [node.id, node])), [placed]);
  const flags = useMemo(() => new Map(model.nodes.map((node) => [node.id, node.emoji || null])), [model.nodes]);
  const labels = useMemo(
    () => placeOverviewLabels(placed.map((node) => ({ ...node, flag: flags.get(node.id) })), width, height),
    [placed, flags, width, height],
  );
  const bundles = useMemo(() => bundleOverviewEdges(buildOverviewEdges(model, forwardLinks)), [model, forwardLinks]);
  const dots = useMemo(() => {
    if (!viewport) return [];
    const out: Array<[number, number]> = [];
    for (const [lon, lat] of worldDots()) {
      const x = viewport.x(viewport.wrap && lon < 0 ? lon + 360 : lon);
      const y = viewport.y(lat);
      if (x < -DOT_MARGIN || x > width + DOT_MARGIN || y < -DOT_MARGIN || y > height + DOT_MARGIN) continue;
      out.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    }
    return out;
  }, [viewport, width, height]);
  // 点阵的亮度从主机那一片往外淡出：中心取主机的重心
  const center = useMemo(() => {
    const located = placed.filter((node) => !node.unlocated);
    if (located.length === 0) return { x: width / 2, y: height / 2 };
    return {
      x: located.reduce((sum, node) => sum + node.x, 0) / located.length,
      y: located.reduce((sum, node) => sum + node.y, 0) / located.length,
    };
  }, [placed, width, height]);

  const idBase = useId().replace(/:/g, "");
  const ids = { ring: `${idBase}-ring`, dots: `${idBase}-dots`, vignette: `${idBase}-vig`, line: `${idBase}-line` };

  // 断了的线放最上面画，不被正常的线盖住
  const drawOrder = [...bundles].sort((a, b) => toneRank(a.tone) - toneRank(b.tone));

  return (
    <div ref={ref} className="fx-overview relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="block h-auto w-full"
        role="img"
        aria-label={`概览：${model.nodes.length} 台主机，${bundles.length} 段连线`}
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
          <radialGradient id={ids.dots} gradientUnits="userSpaceOnUse" cx={center.x} cy={center.y} r={width * 0.62}>
            <stop offset="0" stopColor="var(--fx-primary-fill)" stopOpacity="0.42" />
            <stop offset="1" stopColor="var(--fx-primary-fill)" stopOpacity="0.1" />
          </radialGradient>
          <radialGradient id={ids.vignette} cx="50%" cy="45%" r="70%">
            <stop offset="0.6" stopColor="var(--fx-overview-canvas)" stopOpacity="0" />
            <stop offset="1" stopColor="var(--fx-overview-canvas)" stopOpacity="0.75" />
          </radialGradient>
        </defs>

        {dots.length > 0 ? (
          <g fill={`url(#${ids.dots})`} aria-hidden="true">
            {dots.map(([x, y]) => <circle key={`${x},${y}`} cx={x} cy={y} r={1.4} />)}
          </g>
        ) : null}
        <rect width={width} height={height} fill={`url(#${ids.vignette})`} pointerEvents="none" aria-hidden="true" />

        <g>
          {drawOrder.map((bundle) => {
            const a = byId.get(bundle.from), b = byId.get(bundle.to);
            if (!a || !b) return null;
            const { d, mid } = overviewCurve(a, b, overviewBend(bundle), EDGE_INSET);
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

        <g>
          {placed.map((node, index) => {
            const token = describeNetworkHealth(node.health).token;
            const label = labels[index];
            const note = node.unlocated ? "未定位" : "";
            return (
              <g
                key={node.id}
                transform={`translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`}
                className={onOpen ? "cursor-pointer" : undefined}
                onClick={onOpen ? () => onOpen("/hosts") : undefined}
              >
                <title>{`${node.name}${note ? ` · ${note}` : node.city && node.city !== node.name ? ` · ${node.city}` : ""} · ${describeNetworkHealth(node.health).label}`}</title>
                {token === "healthy" ? (
                  <>
                    <circle r={15} fill="var(--fx-primary-fill)" fillOpacity={0.1} />
                    <circle r={9.5} fill="var(--fx-primary-fill)" fillOpacity={0.22} />
                  </>
                ) : token === "down" ? (
                  <circle r={12} fill="var(--fx-down)" fillOpacity={0.12} />
                ) : null}
                <circle r={NODE_R} fill="var(--fx-l1-surface)" stroke={nodeStroke(node, ids.ring)} strokeWidth={2.6} />
                <g transform={`translate(${label.dx} ${label.dy})`} className="fx-overview-label">
                  <rect width={label.width} height={label.height} rx={12} className="fx-overview-label-box" />
                  <text x={10} y={label.line2 ? 15 : 16} className="fx-overview-city">{label.line1}</text>
                  {label.line2 ? <text x={10} y={29} className="fx-overview-name">{label.line2}</text> : null}
                </g>
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
