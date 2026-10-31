import { formatFailoverEndpoint } from "@shared/failoverTargets";
import { describeRouteIssue, normalizeRouteDelivery, routeSwitchWithinSeconds, type RouteMode } from "@shared/routeGroup";
import type { RouteStatus, RouteStatusPath } from "./RouteGroupSheet";

/*
  线路详情、线路工作台、切换记录共用的几句字（2.3.497 从 RouteLineOverview.tsx 拆出来）：
  整条链多少毫秒、按什么切、一条线路几条路径算一行、行上那条链怎么写。纯函数，不碰 React。
*/

type Path = RouteStatusPath;

/** 毫秒保留一位小数。 */
export const roundMs = (value: number) => Math.round(value * 10) / 10;

/** 整条链：入口这一段（入口 Agent 探的）+ 后面各段（各中转探的）。没探到 = null。 */
export function chainLatency(path: Path | null | undefined): number | null {
  if (!path || path.latencyMs === null || path.latencyMs === undefined) return null;
  return roundMs(Number(path.latencyMs) + Number(path.downstreamMs || 0));
}

/** 线路卡、副标题、工作台 chip 上那几个字。 */
export const ROUTE_LINE_MODE_LABEL: Record<RouteMode, string> = {
  failover: "主备顺序",
  smart: "整链最优",
  weighted: "按权重",
  scheduled: "按时段",
  hybrid: "按时段 · 择优",
  manual: "人工指定",
};

/** 坏了几秒内切走：和编辑框「怎么切」下面那句同一个算法（shared/routeGroup 的 routeSwitchWithinSeconds）。 */
export function routeSwitchSeconds(policy: { failoverSeconds?: number | null; failureThreshold?: number | null } | null | undefined) {
  return routeSwitchWithinSeconds(policy || {});
}

/** 「线路」那一行右边：这条规则按什么切。 */
export function routeLineSwitchSummary(status: RouteStatus) {
  if (normalizeRouteDelivery(status.delivery) === "aggregate") return "主线路那组一起分担";
  const back = status.policy.autoFailback === false ? "不自动切回" : "恢复后切回";
  switch (status.policy.mode) {
    case "weighted": return "按权重分 · 坏了先跳过";
    case "smart": return `挑整链最快的 · ${back}`;
    case "scheduled":
    case "hybrid": return "按时段首选 · 坏了往下切";
    case "manual": return "走指定那条 · 坏了临时切";
    default: return `按顺序切换 · ${back}`;
  }
}

export type RouteLineGroup = {
  key: string;
  /** 0 = 主线路，1.. = 备 N */
  index: number;
  name: string;
  paths: Path[];
  /** 行上画哪一条：在走的那条，没有就第一条。 */
  shown: Path;
  active: boolean;
  paused: boolean;
  allDown: boolean;
  reason: string;
  failures: number;
};

/** 同一条线路展开的几条路径算一行，按线路顺序（tier）排。 */
export function routeLineGroups(status: RouteStatus): RouteLineGroup[] {
  const groups: Array<Omit<RouteLineGroup, "index" | "shown" | "active" | "paused" | "allDown" | "reason" | "failures"> & { tier: number }> = [];
  for (const path of status.paths) {
    const key = path.lineKey || path.key;
    let group = groups.find((item) => item.key === key);
    if (!group) {
      group = { key, name: path.name, tier: typeof path.tier === "number" ? path.tier : groups.length, paths: [] };
      groups.push(group);
    }
    group.paths.push(path);
  }
  return groups
    .sort((a, b) => a.tier - b.tier)
    .map((group, index) => {
      const activePath = group.paths.find((path) => path.active) || null;
      const allDown = group.paths.every((path) => path.down);
      return {
        key: group.key,
        index,
        name: group.name,
        paths: group.paths,
        shown: activePath || group.paths[0],
        active: !!activePath,
        paused: group.paths.every((path) => !!path.paused),
        allDown,
        reason: group.paths.find((path) => path.downReason)?.downReason || "",
        failures: Math.max(0, ...group.paths.map((path) => Number(path.consecutiveFailures || 0))),
      };
    });
}

export function lineBadgeText(index: number) {
  return index === 0 ? "主" : `备 ${index}`;
}

export function lineLongName(index: number) {
  return index === 0 ? "主线路" : `备 ${index}`;
}

/** 落地写成什么（图上的框、行上的链）：名字（我的节点 / 自己的机器），没有就写地址，地址也没有才写「落地」。 */
export function routeLandingName(path: Path | null | undefined) {
  if (!path) return "落地";
  return String(path.destName || "").trim() || String(path.dest?.ip || "").trim() || "落地";
}

/** 行上的那条链：Po0 → 隧道 Jinx → HK 落地。 */
export function routePathText(status: RouteStatus, path: Path, options: { tunnelPrefix?: boolean } = {}) {
  const hops = path.hops.map((hop) => (hop.viaTunnel && options.tunnelPrefix !== false ? `隧道 ${hop.name}` : hop.name));
  return [status.entry?.name || "入口", ...hops, routeLandingName(path)].join(" → ");
}

/** 落地写什么：自己的地址，没有就是「规则目标」。 */
export function routeDestLabel(path: Path) {
  return path.dest?.ip ? formatFailoverEndpoint(path.dest.ip, path.dest.port) : "规则目标";
}

/** 副标题：整链最优 · 3 条线路 · 1 条故障已避开。 */
export function routeLineSubtitle(status: RouteStatus | null, mode: RouteMode) {
  const parts = [ROUTE_LINE_MODE_LABEL[mode] || ROUTE_LINE_MODE_LABEL.failover];
  if (!status) return parts.join(" · ");
  const groups = routeLineGroups(status);
  parts.push(`${groups.length} 条线路`);
  const down = groups.filter((group) => group.allDown && !group.paused).length;
  const anyActive = groups.some((group) => group.active);
  if (down > 0) parts.push(anyActive ? `${down} 条故障已避开` : `${down} 条故障`);
  const paused = groups.filter((group) => group.paused).length;
  if (paused > 0) parts.push(`${paused} 条暂停`);
  return parts.join(" · ");
}

/** 时:分:秒（按给的时区）。 */
export function lineClockText(ms: number, timeZone?: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone }).format(new Date(ms));
  } catch {
    return new Date(ms).toTimeString().slice(0, 8);
  }
}

export function lineShortClock(ms: number, timeZone?: string) {
  return lineClockText(ms, timeZone).slice(0, 5);
}

/** 线路行右边的徽章只放几个字（节点名截短），完整原因在 title 里。状态里的原因已经是说人话的那句。 */
export function lineShortIssue(reason: string) {
  const text = describeRouteIssue(reason);
  const scoped = /^(.+?)\s+(离线|维护中|熔断)/.exec(text);
  if (scoped) {
    const name = scoped[1].length > 6 ? `${scoped[1].slice(0, 5)}…` : scoped[1];
    return `${name} ${scoped[2]}`;
  }
  return text.length > 8 ? `${text.slice(0, 7)}…` : text;
}
