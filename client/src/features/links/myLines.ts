import { isLinkProbeFresh } from "@shared/linkProbePolicy";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { formatHostAddressWithPort, getHostEntryAddress } from "@shared/hostEntryAddress";
import { routeGroupOf } from "@shared/routeGroup";
import { summarizeRouteChain, type RouteBoardRate, type RouteBoardStatus, type RouteChainSummary, type RouteSegment } from "@/features/rules/RouteBoard";
import type { RouteSwitchSummary } from "@shared/routeSwitchSummary";
import { getTunnelHopIds, tunnelHopHostName } from "@/lib/tunnelDisplay";
import type { NetworkHealth } from "@shared/networkHealth";

/*
  「我的线路」：把一条转发按用户看它的样子摆成一条线 —— 入口 → 经过什么 → 落地 → （出口）。

  数据都是现成的，只是原来散在四个页签里：入口在转发页、中转在隧道 / 转发链页、落地是规则目标
  或订阅里的节点、出口在规则出口设置。这里按规则一条条拼起来，纯函数，好测。

  口径：
    · 入口：规则所在的入口机（挂了转发组的写组名和几台入口；转发链挂了入口组的写入口组）。
    · 经过：隧道的中转和出口（入口自己不重复列）、转发链的成员、线路组当前在走的那条路径的中转。
    · 落地：规则目标；绑了「我的节点」就写节点名，地址写在下面。
    · 出口：规则配了 Shadowsocks 出口才有这一节，写落地主机 / 入站名。
    · 段上的延迟只写真有单独探测的那一段（线路组各段）；别的段画「—」，端到端延迟写在卡头。
*/

export type LineProbe = {
  latencyMs: number | null;
  isTimeout: boolean;
  at: Date | string | number | null;
  failure?: string | null;
};

export type LineTraffic = { bytesIn: number; bytesOut: number };

/** 此刻的速率（字节/秒），来自 Agent 几秒一报的增量；90 秒没报就没有。 */
export type LineRate = NonNullable<RouteBoardRate>;

export type LineHop = {
  key: string;
  name: string;
  caption: string;
  health: NetworkHealth;
  title?: string;
  /** 这一跳此刻的速率：线路组的中转各报各的；别的线路只有整条的，写在入口。 */
  rate?: LineRate | null;
};

export type LineModel = {
  id: number;
  name: string;
  owner: string | null;
  enabled: boolean;
  /** 线路是什么：端口转发 / 隧道 / 转发链 / 转发组 / 线路组。 */
  kind: "local" | "tunnel" | "chain" | "group" | "route";
  kindLabel: string;
  entry: LineHop & { address: string };
  hops: LineHop[];
  landing: LineHop;
  exit: LineHop | null;
  /** 节点之间那几段，和 [entry, ...hops, landing, exit?] 的间隙一一对应（缺的画「—」）。 */
  segments: RouteSegment[];
  /** 整条线的健康：主机掉线 / 探测不通 → down；探测通 → healthy；没探过 → unknown；停用 → standby。 */
  health: NetworkHealth;
  statusText: string;
  probe: LineProbe | null;
  traffic: LineTraffic | null;
  /** 整条线此刻的速率（入口上量的）。 */
  rate: LineRate | null;
  /** 线路组有几条路径可选（别的线路就是 1）。 */
  pathCount: number;
  /** 线路组最近 24 小时切换情况；别的线路没有。 */
  switches: RouteSwitchSummary | null;
  subscription: { nodeName: string; visible: boolean } | null;
  /** 搜索用。 */
  haystack: string;
};

export type LineModelContext = {
  hostById: Map<number, any>;
  tunnelById: Map<number, any>;
  groupById: Map<number, any>;
  nodeNameById: Map<number, string>;
  routeStatusByRule: Map<number, RouteBoardStatus | null | undefined>;
  probeByRule: Map<number, LineProbe | undefined>;
  trafficByRule: Map<number, LineTraffic | undefined>;
  /** rules.trafficSummary 每行带的 liveRate（线路组的速率在线路板状态里，不走这个）。 */
  rateByRule?: Map<number, LineRate | null | undefined>;
  nowMs?: number;
};

const KIND_LABELS: Record<LineModel["kind"], string> = {
  local: "端口转发",
  tunnel: "隧道转发",
  chain: "转发链",
  group: "转发组",
  route: "线路组",
};

function on(value: unknown, fallback = true) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === "1" || value === "true";
}

function hostHealth(host: any | undefined, fallback: NetworkHealth = "unknown"): NetworkHealth {
  if (!host) return fallback;
  if (host.isOnline === false || host.isOnline === 0) return "down";
  return fallback;
}

function hostName(context: LineModelContext, hostId: unknown) {
  const id = Number(hostId || 0);
  return String(context.hostById.get(id)?.name || (id > 0 ? `主机 ${id}` : "主机"));
}

function hostCaption(host: any | undefined, role: string) {
  const parts = [role];
  const region = String(host?.region || host?.country || "").trim();
  if (region) parts.push(region);
  if (host && (host.isOnline === false || host.isOnline === 0)) parts.push("离线");
  return parts.join(" · ");
}

function describeProbeAge(at: LineProbe["at"], nowMs: number) {
  const time = at instanceof Date ? at.getTime() : typeof at === "number" ? (at < 1e12 ? at * 1000 : at) : at ? new Date(at).getTime() : 0;
  if (!time) return "";
  const seconds = Math.max(0, Math.round((nowMs - time) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

export function buildLineModel(rule: any, context: LineModelContext): LineModel {
  const nowMs = context.nowMs ?? Date.now();
  const id = Number(rule?.id || 0);
  const enabled = on(rule?.isEnabled);
  const entryHost = context.hostById.get(Number(rule?.hostId || 0));
  const group = Number(rule?.forwardGroupId || 0) > 0 ? context.groupById.get(Number(rule.forwardGroupId)) : null;
  const groupMode = group ? forwardGroupModeOf(group) : null;
  const tunnel = Number(rule?.tunnelId || 0) > 0 ? context.tunnelById.get(Number(rule.tunnelId)) : null;
  const routeGroup = rule?.failoverEnabled ? routeGroupOf(rule) : null;
  const routeStatus = routeGroup ? context.routeStatusByRule.get(id) || null : null;

  const kind: LineModel["kind"] = routeGroup
    ? "route"
    : group
      ? (groupMode === "chain" ? "chain" : "group")
      : tunnel
        ? "tunnel"
        : "local";

  const hops: LineHop[] = [];
  const segments: RouteSegment[] = [];
  let entry: LineModel["entry"];
  const sourcePort = Number(rule?.sourcePort || 0);
  const entryAddressOf = (host: any) => formatHostAddressWithPort(getHostEntryAddress(host) || String(host?.ip || ""), sourcePort);

  if (group && groupMode === "chain") {
    const members = (Array.isArray(group.members) ? group.members : [])
      .filter((member: any) => on(member?.isEnabled))
      .sort((a: any, b: any) => Number(a?.priority || 0) - Number(b?.priority || 0));
    const entryGroup = Number(group.entryGroupId || 0) > 0 ? context.groupById.get(Number(group.entryGroupId)) : null;
    if (entryGroup) {
      const entryHosts = (Array.isArray(entryGroup.members) ? entryGroup.members : []).map((member: any) => context.hostById.get(Number(member?.hostId || 0))).filter(Boolean);
      entry = {
        key: "entry",
        name: String(entryGroup.name || "入口组"),
        caption: `入口组 · ${entryHosts.length} 台入口`,
        address: entryHosts[0] ? entryAddressOf(entryHosts[0]) : "",
        health: entryHosts.length > 0 && entryHosts.every((host: any) => host.isOnline === false || host.isOnline === 0) ? "down" : "unknown",
      };
      for (const member of members) {
        const host = context.hostById.get(Number(member?.hostId || 0));
        hops.push({ key: `member-${member.id}`, name: hostName(context, member?.hostId), caption: hostCaption(host, "中转"), health: hostHealth(host) });
      }
    } else {
      const first = members[0];
      const firstHost = first ? context.hostById.get(Number(first.hostId || 0)) : entryHost;
      entry = {
        key: "entry",
        name: hostName(context, first?.hostId || rule?.hostId),
        caption: hostCaption(firstHost, "入口"),
        address: entryAddressOf(firstHost),
        health: hostHealth(firstHost),
      };
      for (const member of members.slice(1)) {
        const host = context.hostById.get(Number(member?.hostId || 0));
        hops.push({ key: `member-${member.id}`, name: hostName(context, member?.hostId), caption: hostCaption(host, "中转"), health: hostHealth(host) });
      }
    }
  } else if (group) {
    const members = (Array.isArray(group.members) ? group.members : []).filter((member: any) => on(member?.isEnabled));
    const memberHosts = members.map((member: any) => context.hostById.get(Number(member?.hostId || 0))).filter(Boolean);
    const modeLabel = groupMode === "port" ? "端口转发" : groupMode === "entry" ? "入口组" : "转发组";
    entry = {
      key: "entry",
      name: String(group.name || modeLabel),
      caption: `${modeLabel} · ${members.length} 台入口${groupMode === "failover" ? "主备" : ""}`,
      address: memberHosts[0] ? entryAddressOf(memberHosts[0]) : "",
      health: memberHosts.length > 0 && memberHosts.every((host: any) => host.isOnline === false || host.isOnline === 0) ? "down" : "unknown",
    };
  } else {
    entry = {
      key: "entry",
      name: hostName(context, rule?.hostId),
      caption: hostCaption(entryHost, "入口"),
      address: entryAddressOf(entryHost),
      health: hostHealth(entryHost),
    };
  }

  if (tunnel && !routeGroup) {
    const hopIds = getTunnelHopIds(tunnel).slice(1);
    hopIds.forEach((hostId: number, index: number) => {
      const host = context.hostById.get(Number(hostId));
      const last = index === hopIds.length - 1;
      hops.push({
        key: `tunnel-hop-${index}`,
        name: String(tunnelHopHostName(tunnel, hostId, Array.from(context.hostById.values())) || hostName(context, hostId)),
        caption: hostCaption(host, last ? "出口" : "中转"),
        health: hostHealth(host),
        title: `隧道「${String(tunnel.name || "")}」`,
      });
    });
  }

  let chain: RouteChainSummary | null = null;
  if (routeGroup) {
    const active = routeStatus?.paths?.find((path) => path.active) || routeStatus?.paths?.[0] || null;
    if (active) {
      chain = summarizeRouteChain(active);
      active.hops.forEach((hop, index) => {
        const host = context.hostById.get(Number(hop.hostId || 0));
        hops.push({
          key: `route-hop-${index}`,
          name: hop.name,
          caption: hostCaption(host, "中转"),
          health: hop.ok === false ? (hop.consecutiveFailures >= 3 ? "down" : "degraded") : hop.ok === true ? "healthy" : hostHealth(host),
          title: active.active ? `线路组当前走的路径 ${active.letter}「${active.name}」` : `线路组路径 ${active.letter}「${active.name}」（还没报在走哪条）`,
          rate: hop.rate ?? null,
        });
      });
      // 线路板的段：第一段是入口探拨号地址，后面每段是那台中转探下一跳。节点数和它一致。
      segments.push(...chain.segments);
    } else {
      const first = routeGroup.paths[0];
      for (const [index, hostId] of (first?.hops || []).entries()) {
        const host = context.hostById.get(Number(hostId));
        hops.push({ key: `route-plan-${index}`, name: hostName(context, hostId), caption: hostCaption(host, "中转"), health: hostHealth(host), title: "线路组路径（还没有运行状态）" });
      }
    }
  }

  const nodeId = Number(rule?.proxyNodeId || 0);
  const nodeName = nodeId > 0 ? context.nodeNameById.get(nodeId) || null : null;
  const targetAddress = formatHostAddressWithPort(String(rule?.targetIp || ""), Number(rule?.targetPort || 0));
  const activeDest = routeStatus?.paths?.find((path) => path.active)?.dest;
  const landingAddress = activeDest && activeDest.ip ? formatHostAddressWithPort(activeDest.ip, activeDest.port) : targetAddress;
  const landing: LineHop = {
    key: "landing",
    name: nodeName ? nodeName : "落地",
    caption: nodeName ? `我的节点 · ${landingAddress}` : landingAddress,
    health: "unknown",
    title: nodeName ? "目标是我的节点，节点地址变了会自动跟上" : "规则目标",
  };

  const egress = rule?.egress && String(rule.egress.type || "none") !== "none" ? rule.egress : null;
  const exit: LineHop | null = egress ? {
    key: "exit",
    name: String(egress.landingHostName || egress.inboundName || "外部 SS 出口"),
    caption: `出口 · Shadowsocks${egress.udp ? " · 含 UDP" : ""}${egress.state && egress.state !== "running" ? ` · ${String(egress.message || egress.state)}` : ""}`,
    health: egress.state === "running" ? "healthy" : egress.state === "paused" ? "standby" : egress.state ? "degraded" : "unknown",
    title: egress.masked ? `流量从 ${egress.masked} 出去` : undefined,
  } : null;

  const probe = context.probeByRule.get(id) || null;
  const fresh = !!probe?.at && isLinkProbeFresh(probe.at, nowMs);
  const offline = [entry, ...hops].filter((hop) => hop.health === "down");
  let health: NetworkHealth;
  let statusText: string;
  if (!enabled) {
    health = "standby";
    statusText = "已停用";
  } else if (offline.length > 0) {
    health = "down";
    statusText = `主机离线：${offline.map((hop) => hop.name).join(" / ")}`;
  } else if (chain?.broken) {
    health = "down";
    statusText = "当前路径有一段不通";
  } else if (fresh && probe?.isTimeout) {
    health = "down";
    statusText = `最近一次端到端探测不通（${describeProbeAge(probe.at, nowMs)}）`;
  } else if (fresh && probe && probe.latencyMs !== null) {
    health = "healthy";
    statusText = `端到端 ${Math.round(probe.latencyMs)} ms（${describeProbeAge(probe.at, nowMs)}）`;
  } else if (probe?.at) {
    health = "unknown";
    statusText = `上次探测是 ${describeProbeAge(probe.at, nowMs)}，已过期`;
  } else {
    health = "unknown";
    statusText = "还没探测过";
  }
  if (health === "healthy") landing.health = "healthy";
  if (health === "down" && fresh && probe?.isTimeout) landing.health = "down";

  const traffic = context.trafficByRule.get(id) || null;
  const rate: LineRate | null = routeGroup ? routeStatus?.rate ?? null : context.rateByRule?.get(id) ?? null;
  if (rate) entry.rate = rate;
  const pathCount = routeGroup ? Math.max(1, routeStatus?.paths?.length || routeGroup.paths.length || 1) : 1;
  const switches = routeGroup ? routeStatus?.switches ?? null : null;
  const subscription = nodeId > 0 ? { nodeName: nodeName || "落地节点", visible: rule?.proxyNodeVisible !== false } : null;
  const haystack = [rule?.name, entry.name, entry.address, ...hops.map((hop) => hop.name), landing.name, landing.caption, exit?.name, KIND_LABELS[kind], rule?.userName]
    .filter(Boolean).join(" ").toLowerCase();
  return {
    id,
    name: String(rule?.name || `转发 #${id}`),
    owner: rule?.userName ? String(rule.userName) : null,
    enabled,
    kind,
    kindLabel: KIND_LABELS[kind],
    entry,
    hops,
    landing,
    exit,
    segments,
    health,
    statusText,
    probe,
    traffic,
    rate,
    pathCount,
    switches,
    subscription,
    haystack,
  };
}
