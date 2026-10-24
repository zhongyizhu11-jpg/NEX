import type { LngLat } from "./networkMapGeometry";

/**
 * 主线路上流动的光点：两三颗错开的亮点沿隧道的大圆弧从入口往出口流，首尾相接一直流 ——
 * 「这条线上有流量在往出口走」，方向一眼就看得出。
 *
 * 纯数学、不碰 MapLibre：路径按 Web 墨卡托的长度参数化（屏幕上匀速，不会在高纬度
 * 突然变快），多跳隧道把每一跳的弧首尾相接成一条路。画布每帧只做「相位 → 路上的点」
 * 这一步，然后把点写进 GeoJSON 源。
 */

type MercatorPoint = { x: number; y: number };

/** Web 墨卡托，整个世界宽 1：屏幕像素 = 单位 × 512 × 2^zoom */
function mercator(point: LngLat): MercatorPoint {
  const lat = Math.max(-85.051129, Math.min(85.051129, point[1]));
  return {
    x: point[0] / 360 + 0.5,
    y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI),
  };
}

export type CometPath = {
  /** 首尾相接后的折线（经纬度） */
  points: LngLat[];
  /** 每个顶点处的累计长度（墨卡托单位） */
  cum: number[];
  total: number;
};

/**
 * 把一条隧道的各跳弧线接成一条路。相邻两跳共用一台主机，后一跳的第一个点和前一跳的
 * 最后一个点重合，接的时候去掉重复的那个；长度为零的路（所有点重合）返回 null。
 */
export function buildCometPath(hops: ReadonlyArray<ReadonlyArray<LngLat>>): CometPath | null {
  const points: LngLat[] = [];
  const cum: number[] = [];
  let total = 0;
  let previous: MercatorPoint | null = null;
  for (const hop of hops) {
    for (let index = 0; index < hop.length; index += 1) {
      const point = hop[index];
      const last = points[points.length - 1];
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      const projected = mercator(point);
      if (previous) total += Math.hypot(projected.x - previous.x, projected.y - previous.y);
      points.push([point[0], point[1]]);
      cum.push(total);
      previous = projected;
    }
  }
  if (points.length < 2 || !(total > 0)) return null;
  return { points, cum, total };
}

/** 路上离起点 s 远的那个点（s 夹在 [0, total] 里） */
export function pointAt(path: CometPath, s: number): LngLat {
  const { points, cum } = path;
  if (s <= 0) return points[0];
  if (s >= path.total) return points[points.length - 1];
  let low = 0;
  let high = cum.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (cum[mid] <= s) low = mid;
    else high = mid;
  }
  const span = cum[high] - cum[low];
  const f = span > 0 ? (s - cum[low]) / span : 0;
  return [points[low][0] + (points[high][0] - points[low][0]) * f, points[low][1] + (points[high][1] - points[low][1]) * f];
}

/** 相位往前走：dt 毫秒 / 一趟的毫秒数，回绕到 [0, 1) */
export function advanceCometPhase(phase: number, dtMs: number, periodMs: number): number {
  if (!(periodMs > 0) || !(dtMs > 0)) return phase;
  return (((phase + dtMs / periodMs) % 1) + 1) % 1;
}

/** 一趟多久：按屏幕上的长度走，大约 90px/s，短线不快于 1.4s 一趟、长线不慢于 6s */
export const COMET_SPEED_PX_PER_S = 90;
export const COMET_MIN_PERIOD_MS = 1400;
export const COMET_MAX_PERIOD_MS = 6000;

export function cometPeriodMs(screenLengthPx: number): number {
  const raw = (screenLengthPx / COMET_SPEED_PX_PER_S) * 1000;
  return Math.max(COMET_MIN_PERIOD_MS, Math.min(COMET_MAX_PERIOD_MS, Number.isFinite(raw) ? raw : COMET_MIN_PERIOD_MS));
}
