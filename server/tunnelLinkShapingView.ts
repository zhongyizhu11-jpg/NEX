import { tunnelLinkShaping as tunnelLinkShapingConfig, hostEgressShaping } from "./tunnelFxpRuntime";

/*
  链路整形状态「还算不算数」。

  tunnel_link_shaping 里存的是 FXP 报上来的最后一眼（forwardx-fxp/link_shaper.go，60 s 一报）。
  这份记录是留着的：学到的限速点换机器、重装都不该丢。可是关掉整形、把隧道协议从 NEX
  换成 GOST 之后，FXP 就不再报了，那条「正在找限速点」会一直挂在隧道卡片上，看着像还在跑。

  所以展示之前先过一遍这里：
  - 隧道/主机现在就没开整形（协议不是 NEX，或档位是关），一条都不给；
  - 开着但好一会儿没上报了（主机离线、隧道停了、FXP 没起来），标成 stale，
    界面当没有实时状态处理，learnedMbps 这些值照样留着给自动档当提示。
*/

/** 超过这么久没上报就不算实时状态了（FXP 60 s 一报，留五倍余量）。 */
export const LINK_SHAPING_STALE_MS = 5 * 60_000;

export function linkShapingReportedAtMs(value: unknown): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? (value < 1e12 ? value * 1000 : value) : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num < 1e12 ? num * 1000 : num;
  }
  return 0;
}

/** 这条上报是不是已经过期（没有时间的也算过期：老记录补不出来）。 */
export function isLinkShapingReportStale(updatedAt: unknown, now = Date.now()) {
  const reportedAt = linkShapingReportedAtMs(updatedAt);
  if (reportedAt <= 0) return true;
  return now - reportedAt > LINK_SHAPING_STALE_MS;
}

export type LinkShapingRow = {
  tunnelId?: unknown;
  hostId?: unknown;
  role?: unknown;
  direction?: unknown;
  mode?: unknown;
  state?: unknown;
  rateMbps?: unknown;
  learnedMbps?: unknown;
  lossPermille?: unknown;
  updatedAt?: unknown;
};

export type LinkShapingStatusView = {
  hostId: number;
  role: string;
  direction: string;
  mode: string;
  state: string;
  rateMbps: number;
  learnedMbps: number;
  lossPct: number;
  updatedAt: unknown;
  stale: boolean;
};

function toStatusView(row: LinkShapingRow, now: number): LinkShapingStatusView {
  return {
    hostId: Number((row as any).hostId || 0),
    role: String((row as any).role || "entry"),
    direction: String((row as any).direction || ""),
    mode: String((row as any).mode || "off"),
    state: String((row as any).state || "off"),
    rateMbps: Number((row as any).rateMbps || 0),
    learnedMbps: Number((row as any).learnedMbps || 0),
    lossPct: Number((row as any).lossPermille || 0) / 10,
    updatedAt: (row as any).updatedAt ?? null,
    stale: isLinkShapingReportStale((row as any).updatedAt, now),
  };
}

/**
 * 隧道卡片/编辑框要用的那几条：隧道现在开着整形才给，过期的带 stale。
 */
export function tunnelLinkShapingStatusView(tunnel: any, rows: readonly LinkShapingRow[], now = Date.now()): LinkShapingStatusView[] {
  if (tunnelLinkShapingConfig(tunnel).mode === "off") return [];
  return rows.map((row) => toStatusView(row, now));
}

/**
 * 主机卡片要用的那一条：这台机器现在开着公网出口整形才给，过期的带 stale。
 */
export function hostEgressShapingStatusView(host: any, row: LinkShapingRow | null | undefined, now = Date.now()): LinkShapingStatusView | null {
  if (!row) return null;
  if (hostEgressShaping(host).mode === "off") return null;
  return toStatusView(row, now);
}
