import { useMemo } from "react";

import { tunnelHealthFromAvailability } from "@/features/links/tunnelHealth";
import { hostGeoCoordinate } from "@/lib/hostGeo";
import { countryFlagLabel } from "@/lib/flagEmojiSupport";
import { getTunnelHopIds } from "@/lib/tunnelDisplay";
import { TUNNEL_PROTOCOLS, normalizeForwardProtocolSettings } from "@shared/forwardTypes";
import { buildLinkAvailabilityIndex } from "@shared/linkAvailability";
import { formatAgo } from "@shared/dashboardAttention";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";
import { countryNameZh, hostPlaceNameZh } from "@shared/placeNameZh";

import { useNetworkMapData, type NetworkMapData } from "./networkMapData";
import { lineKindOfHealth, lineLegend, type LineKind } from "./networkMapLines";

/**
 * 首页「网络地图」的数据模型。
 *
 * 数据用的是各页已经在用的两条轻量列表（hosts.options / tunnels.options，见 networkMapData）。
 * 隧道的状态和隧道页一样从 linkAvailability 算 —— 这里红的，点进隧道页也是红的。
 *
 * 节点和线带上概览图要的几样：中文城市名、国家代码、四类线的哪一类、逐跳延迟。
 */
function hostNote(host: any, now: number, linkCount: number): string | null {
  if (host?.isOnline === false || host?.isOnline === 0) {
    const seen = host?.lastHeartbeat ? new Date(host.lastHeartbeat).getTime() : NaN;
    return Number.isFinite(seen) && seen > 0 ? `离线 · ${formatAgo(now - seen)}` : "离线";
  }
  if (host?.lastHeartbeat == null && host?.isOnline !== true) return "还没接入";
  return linkCount > 0 ? `${linkCount} 条线路` : "在线";
}

/**
 * 图上写的地名：一律中文（规则在 shared/placeNameZh：手动定位原样 → 城市表 → 坐标最近的城市 → 省 / 州
 * 对照表 → 国家 / 地区的中文名 → 实在没有才写原文）。IP 定位给的 region 多半是英文的省名
 * （「Guangdong」「New South Wales」），以前原样写上图，就成了「Guangdong · 香港」。
 */
export function mapCityName(host: Parameters<typeof hostPlaceNameZh>[0]): string | null {
  return hostPlaceNameZh(host);
}

/** 点主机时提示里那段地区：和图上同一个中文地名；连地名都没有（只有国家代码）时写国家 / 地区名 */
export function mapRegionText(host: Parameters<typeof hostPlaceNameZh>[0]): string | null {
  return hostPlaceNameZh(host) || countryNameZh(host?.geoCountryCode) || null;
}

function hostHealth(host: any): NetworkHealth {
  if (host?.isOnline === true || host?.isOnline === 1) return "healthy";
  if (host?.lastHeartbeat == null) return "unknown";
  return "down";
}

/** 图上的一台主机 */
export type NetworkMapNode = {
  id: number;
  name: string;
  health: NetworkHealth;
  /** 「香港 · 2 条线路」这种一句话；没有就按状态写 */
  note?: string | null;
  /** 有经纬度的按它落位 */
  geo?: { lat: number; lng: number } | null;
  /** 国旗（由国家码算出来） */
  emoji?: string | null;
};

/** 图上的一条隧道 */
export type NetworkMapLink = {
  id: number;
  name: string;
  /** 依次经过的主机 id：入口、中转…、出口。少于两个的不画 */
  path: number[];
  health: NetworkHealth;
  latencyMs?: number | null;
};

export type NetworkMapHostNode = NetworkMapNode & {
  countryCode: string | null;
  /** 图上写的中文城市名：地区 → 国家 → 主机名 */
  city: string;
  /** 「香港 · Central」这种给人看的地区（点主机时的提示） */
  region: string | null;
  isOnline: boolean;
  linkCount: number;
};

export type NetworkMapTunnelLink = NetworkMapLink & {
  /** 逐跳延迟（来自最近一次诊断），按 path 的段序；拿不到是空数组 */
  hopLatencies: Array<number | null>;
  /** 地图上的四类线之一（networkMapLines：正常 = 主线路、停用 / 未上报 = 备用…） */
  kind: LineKind;
};

/** 租户看不到一端的隧道：画不成线，但计入图例 */
export type NetworkMapStub = {
  tunnelId: number;
  hostId: number;
  health: NetworkHealth;
};

export type NetworkMapModel = {
  nodes: NetworkMapHostNode[];
  links: NetworkMapTunnelLink[];
  stubs: NetworkMapStub[];
  /** 隧道总数，包括画不出来的那些 —— 示意图的「N 条线路」用这个数 */
  linkTotal: number;
  /** 两端里至少一端是这个账号看不到的主机的隧道数；它们存在、有状态，只是没法画成线 */
  hiddenLinkCount: number;
  legend: { healthy: number; degraded: number; down: number; standby: number };
  /** 图例上四类线各几条 */
  lines: Record<LineKind, number>;
};

/**
 * 逐跳延迟：从隧道最近一次诊断结果里按 fromHostId → toHostId 对上 path 的每一段。
 * 诊断结果是 JSON 文本（LinkTestLatencySummary.parseLinkTestMessage 那套），这里只认
 * 带 hostId 的明细；老格式、租户被抹掉的字段都对不上，就给空。
 */
export function tunnelHopLatencies(tunnel: any, path: number[]): Array<number | null> {
  const raw = typeof tunnel?.lastTestMessage === "string" ? tunnel.lastTestMessage.trim() : "";
  if (!raw || path.length < 2) return [];
  let details: any[] = [];
  try {
    const parsed = JSON.parse(raw);
    details = Array.isArray(parsed?.details) ? parsed.details : [];
  } catch {
    return [];
  }
  const bySegment = new Map<string, number | null>();
  for (const detail of details) {
    const from = Number(detail?.fromHostId || 0);
    const to = Number(detail?.toHostId || 0);
    if (from <= 0 || to <= 0) continue;
    bySegment.set(`${from}>${to}`, typeof detail?.latencyMs === "number" && Number.isFinite(detail.latencyMs) ? detail.latencyMs : null);
  }
  if (bySegment.size === 0) return [];
  return path.slice(1).map((to, index) => bySegment.get(`${path[index]}>${to}`) ?? null);
}

/**
 * 纯函数：把 hosts.options / tunnels.options 变成地图要画的点和线。
 *
 * 两条规则和隧道页保持一致，否则同一条隧道在首页和隧道页会是两种颜色：
 *
 * 一、协议开关。管理员在设置里停用了某个隧道协议时，隧道页把那条隧道标成红的
 *     （isTunnelSupported → down），这里也一样，所以 supported 要一路传进去。
 *
 * 二、看不见的主机。普通用户用共享隧道时，服务端会把不在他主机范围里的那一端
 *     抹掉（linkAccessView），但 availability 还在。这种隧道**不能当不存在**：
 *     它照样计入线路数和图例，只是画不成一条线（线要两个点）。看得见的那一端的
 *     「N 条线路」注脚也照样算上它（stubs）。
 */
export function buildNetworkMapModel(input: {
  hosts: any[];
  tunnels: any[];
  now?: number;
  isTunnelSupported?: (tunnel: any) => boolean;
}): NetworkMapModel {
  const { hosts, tunnels, isTunnelSupported } = input;
  const now = input.now ?? Date.now();
  const index = buildLinkAvailabilityIndex({ hosts, tunnels, now, isTunnelSupported });
  const hostIds = new Set(hosts.map((host) => Number(host?.id)));
  const linkCountByHost = new Map<number, number>();
  const links: NetworkMapTunnelLink[] = [];
  const stubs: NetworkMapStub[] = [];
  const legend = { healthy: 0, degraded: 0, down: 0, standby: 0 };
  let hiddenLinkCount = 0;
  for (const tunnel of tunnels) {
    const path: number[] = getTunnelHopIds(tunnel).map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0);
    const state = index.tunnelAvailabilityById.get(Number(tunnel.id));
    const enabled = tunnel?.isEnabled !== false && tunnel?.isEnabled !== 0;
    const health = tunnelHealthFromAvailability(state?.status ?? tunnel?.availability?.status, {
      enabled,
      supported: isTunnelSupported ? isTunnelSupported(tunnel) !== false : undefined,
    });
    const token = describeNetworkHealth(health).token;
    if (token === "healthy") legend.healthy += 1;
    else if (token === "warn") legend.degraded += 1;
    else if (token === "down") legend.down += 1;
    else legend.standby += 1;
    for (const hostId of new Set(path)) linkCountByHost.set(hostId, (linkCountByHost.get(hostId) || 0) + 1);
    const name = String(tunnel.name || `隧道 #${tunnel.id}`);
    if (path.length < 2) {
      hiddenLinkCount += 1;
      const visibleEnd = path.find((id) => hostIds.has(id));
      if (visibleEnd) stubs.push({ tunnelId: Number(tunnel.id), hostId: visibleEnd, health });
      continue;
    }
    links.push({
      id: Number(tunnel.id),
      name,
      path,
      health,
      latencyMs: typeof tunnel?.lastLatencyMs === "number" ? tunnel.lastLatencyMs : null,
      hopLatencies: tunnelHopLatencies(tunnel, path),
      kind: lineKindOfHealth(health),
    });
  }
  const nodes: NetworkMapHostNode[] = hosts.map((host) => {
    // 名字下面那行前面带上地区（「香港 · 2 条线路」）；国旗画在圆盘里。地名都换成中文（shared/placeNameZh）
    const region = mapRegionText(host) || "";
    const linkCount = linkCountByHost.get(Number(host.id)) || 0;
    const note = hostNote(host, now, linkCount);
    const name = String(host.name || host.ip || host.ipv4 || `主机 #${host.id}`);
    return {
      id: Number(host.id),
      name,
      health: hostHealth(host),
      note: [region, note].filter(Boolean).join(" · ") || null,
      geo: hostGeoCoordinate(host),
      // 这台设备画不出的旗（iOS 国行没有 🇹🇼）退回两字母代码，见 lib/flagEmojiSupport
      emoji: countryFlagLabel(host?.geoCountryCode) || null,
      countryCode: String(host?.geoCountryCode || "").trim().toUpperCase() || null,
      city: mapCityName(host) || name,
      region: region || null,
      isOnline: host?.isOnline === true || host?.isOnline === 1,
      linkCount,
    };
  });
  return { nodes, links, stubs, linkTotal: tunnels.length, hiddenLinkCount, legend, lines: lineLegend({ links, stubs }) };
}

/** 协议开关 → 「这条隧道的协议还开着吗」：和隧道页同一条规则（停用了协议的隧道算中断） */
export function tunnelSupportCheck(forwardProtocols: unknown): (tunnel: any) => boolean {
  const protocolSettings = normalizeForwardProtocolSettings(forwardProtocols as any);
  return (tunnel: any) => {
    const key = String(tunnel?.mode || "").toLowerCase();
    return (TUNNEL_PROTOCOLS as readonly string[]).includes(key)
      && protocolSettings[key as keyof typeof protocolSettings] !== false;
  };
}

/** 已经取到的原始数据 → 地图模型（数据没变就不重算） */
export function useNetworkMapModelFromData(data: NetworkMapData) {
  const { hosts, tunnels, forwardProtocols, loading } = data;
  const isTunnelSupported = useMemo(() => tunnelSupportCheck(forwardProtocols), [forwardProtocols]);
  return useMemo(() => ({
    ...buildNetworkMapModel({ hosts, tunnels, isTunnelSupported }),
    loading,
  }), [hosts, tunnels, isTunnelSupported, loading]);
}

/** 首页卡片用的：主机和隧道两条列表，按常规的轮询间隔刷新。 */
export function useNetworkMapModel(enabled: boolean) {
  return useNetworkMapModelFromData(useNetworkMapData(enabled));
}
