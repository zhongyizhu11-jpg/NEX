import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * 一条小走势线：规则卡上「近 24 小时」的字节起伏。
 *
 * 只画形状，不画坐标轴、不画刻度、不响应悬停 —— 它回答的是「这条线路这一天有没有在动、
 * 什么时候忙」，要看具体数字点进详情。线是状态色（跟着卡的色调），线下一层从状态色到透明
 * 的渐变，像 iOS 股票那种。全 0 或没数据时画一条很淡的虚线，位置不塌，卡的节奏不变。
 */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  stroke = "var(--fx-primary-fill)",
  className,
  title,
  minScale = 0,
}: {
  values: number[];
  /** 纵轴顶至少到这个值：数都很小时（3ms 的延迟抖 2ms）不把小波动撑满整个高度。 */
  minScale?: number;
  width?: number;
  height?: number;
  /** 线色，CSS 颜色或 var() */
  stroke?: string;
  className?: string;
  title?: string;
}) {
  const gradientId = useId();
  const points = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const peak = points.reduce((acc, value) => Math.max(acc, value), 0);
  const max = peak > 0 ? Math.max(peak, minScale) : 0;
  const empty = points.length < 2 || max <= 0;
  const padY = 2;
  const usableH = height - padY * 2;
  const stepX = points.length > 1 ? width / (points.length - 1) : width;
  const coords = points.map((value, index) => ({
    x: index * stepX,
    y: empty ? height - padY : padY + usableH * (1 - value / max),
  }));
  // Catmull-Rom 转三次贝塞尔：24 个点连成一条顺滑的线，不用一根根折线
  let line = "";
  coords.forEach((point, index) => {
    if (index === 0) {
      line += `M${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
      return;
    }
    const p0 = coords[index - 2] || coords[index - 1];
    const p1 = coords[index - 1];
    const p2 = point;
    const p3 = coords[index + 1] || point;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    line += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  });
  const area = coords.length > 0
    ? `${line} L${width} ${height} L0 ${height} Z`
    : "";

  return (
    <svg
      className={cn("fx-sparkline", className)}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-empty={empty ? "" : undefined}
    >
      {empty ? (
        <line x1={0} x2={width} y1={height - padY} y2={height - padY} stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.5} strokeDasharray="3 4" strokeLinecap="round" />
      ) : (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={stroke} stopOpacity={0.32} />
              <stop offset="1" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradientId})`} />
          <path d={line} fill="none" stroke={stroke} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}
