/**
 * 链路管理的「线路总览」：面板里所有「多条线路一起用」的地方，按三个词归到一处看。
 *
 * 这些东西散在五个地方：规则里的线路组、转发组（入口主备）、入口组、出口组、隧道的中转方式和多路并发。
 * 每个都只在自己那一页看得到，想知道「我的哪些线路是主备、哪些在分流量」要一页页翻。
 * 这里不新增配置，只把现有的按 shared/linkTerms.ts 的三个词排好：
 *
 *   主备         平时走一条，坏了才换
 *   负载均衡     新连接分到几条上
 *   单连接叠加   一条连接拆开同时走几条
 *
 * 每一项给一个「去改」的地址，改的地方还是原来那页。
 */

import { exitGroupWeights, normalizeExitGroupStrategy } from "./exitStrategy";
import { LINK_SPREAD_LABELS, LINK_TERM_FAILOVER, LINK_TERM_LOAD_BALANCE, LINK_TERM_SPLIT_CONNECTION } from "./linkTerms";
import { hostBandwidthHintMbps } from "./linkWeights";
import { ROUTE_MODE_INFO, routeGroupOf, type RouteGroupRule } from "./routeGroup";
import { normalizeTunnelParallelStreams, tunnelParallelStreamsUnavailableReason } from "./tunnelParallelStreams";
import { isTunnelRelayAggregate, isTunnelRelayFailover, tunnelRelayCandidates } from "./tunnelRelay";

export type LinkOverviewKind = "route_group" | "forward_group" | "entry_group" | "exit_group" | "tunnel";

export const LINK_OVERVIEW_KIND_LABELS: Record<LinkOverviewKind, string> = {
  route_group: "线路组",
  forward_group: "转发组",
  entry_group: "入口组",
  exit_group: "出口组",
  tunnel: "隧道",
};

export type LinkOverviewItem = {
  key: string;
  kind: LinkOverviewKind;
  id: number;
  name: string;
  enabled: boolean;
  /** 一句话：怎么分的（「中转主备」「按权重 5:3」「多路并发 4 条」）。 */
  how: string;
  /** 参与的主机名，按顺序。 */
  members: string[];
  /** 要用户留意的事（没填带宽、只剩一台……），没有就不给。 */
  note?: string;
  /** 去改它的地方。 */
  href: string;
};

export type LinkOverviewCategory = "failover" | "loadBalance" | "splitConnection";

export const LINK_OVERVIEW_CATEGORY_LABELS: Record<LinkOverviewCategory, string> = {
  failover: LINK_TERM_FAILOVER,
  loadBalance: LINK_TERM_LOAD_BALANCE,
  splitConnection: LINK_TERM_SPLIT_CONNECTION,
};

export type LinkOverview = Record<LinkOverviewCategory, LinkOverviewItem[]>;

type HostRow = { id: unknown; name?: unknown; lineBandwidthMbps?: unknown; rateLimitMbps?: unknown; egressMbps?: unknown };
type TunnelRow = {
  id: unknown; name?: unknown; isEnabled?: unknown; mode?: unknown; forwardxVersion?: unknown; relayMode?: unknown; parallelStreams?: unknown;
  loadBalanceEnabled?: unknown; loadBalanceStrategy?: unknown; exitGroupId?: unknown; entryHostId?: unknown; exitHostId?: unknown;
};
type HopRow = { tunnelId: unknown; seq: unknown; hostId: unknown };
type ExitNodeRow = { tunnelId: unknown; seq?: unknown; hostId: unknown; isEnabled?: unknown };
type GroupRow = {
  id: unknown; name?: unknown; isEnabled?: unknown; groupMode?: unknown; exitStrategy?: unknown;
  members?: Array<{ hostId?: unknown; isEnabled?: unknown; priority?: unknown }>;
};

export type LinkOverviewInput = {
  hosts: HostRow[];
  tunnels: TunnelRow[];
  hops: HopRow[];
  exitNodes: ExitNodeRow[];
  groups: GroupRow[];
  routeRules: Array<RouteGroupRule & { id: unknown; name?: unknown; isEnabled?: unknown }>;
};

function on(value: unknown, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return true;
}

export function buildLinkOverview(input: LinkOverviewInput): LinkOverview {
  const hostById = new Map(input.hosts.map((host) => [Number(host.id), host]));
  const hostName = (id: unknown) => String(hostById.get(Number(id))?.name || `主机 ${Number(id) || "?"}`);
  const out: LinkOverview = { failover: [], loadBalance: [], splitConnection: [] };
  const push = (category: LinkOverviewCategory, item: LinkOverviewItem) => out[category].push(item);

  // 线路组：权重负载是负载均衡，其余几种（自动切换、定时、手动、择优、混合）都是主备。
  for (const rule of input.routeRules) {
    const group = routeGroupOf(rule);
    if (!group) continue;
    const id = Number(rule.id);
    const mode = group.policy.mode;
    push(mode === "weighted" ? "loadBalance" : "failover", {
      key: `route_group:${id}`,
      kind: "route_group",
      id,
      name: String(rule.name || `规则 ${id}`),
      enabled: on(rule.isEnabled),
      how: `${ROUTE_MODE_INFO[mode].label} · ${group.paths.length} 条路径`,
      members: group.paths.map((path) => path.name),
      href: `/rules?edit=${id}`,
    });
  }

  const tunnelsByExitGroup = new Map<number, string[]>();
  for (const tunnel of input.tunnels) {
    const groupId = Number(tunnel.exitGroupId || 0);
    if (groupId > 0) tunnelsByExitGroup.set(groupId, [...(tunnelsByExitGroup.get(groupId) || []), String(tunnel.name || `隧道 ${tunnel.id}`)]);
  }

  for (const group of input.groups) {
    const id = Number(group.id);
    const mode = String(group.groupMode || "");
    const members = [...(group.members || [])]
      .filter((member) => on(member.isEnabled) && Number(member.hostId || 0) > 0)
      .sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
    const names = members.map((member) => hostName(member.hostId));
    const base = { id, name: String(group.name || `组 ${id}`), enabled: on(group.isEnabled), members: names };
    const lonely = names.length < 2 ? "只有一台，坏了没得换" : undefined;
    if (mode === "failover") {
      push("failover", { ...base, key: `forward_group:${id}`, kind: "forward_group", how: "入口主备：域名指向健康的一台", note: lonely, href: `/tunnels?tab=groups&edit=${id}` });
    } else if (mode === "entry") {
      push("loadBalance", {
        ...base, key: `entry_group:${id}`, kind: "entry_group",
        how: "域名解析出几台入口，带宽大的排前面",
        note: names.length < 2 ? "只有一台入口" : undefined,
        href: `/tunnels?tab=entries&edit=${id}`,
      });
    } else if (mode === "exit") {
      const strategy = normalizeExitGroupStrategy(group.exitStrategy);
      if (strategy === "none") continue;
      const used = tunnelsByExitGroup.get(id) || [];
      const usedNote = used.length === 0 ? "还没有隧道用它" : undefined;
      if (strategy === "fallback") {
        push("failover", { ...base, key: `exit_group:${id}`, kind: "exit_group", how: "出口主备", note: lonely || usedNote, href: `/tunnels?tab=exits&edit=${id}` });
        continue;
      }
      let how = `出口${LINK_SPREAD_LABELS[strategy].label}`;
      let note = names.length < 2 ? "只有一台出口" : usedNote;
      if (strategy === "least_load" && names.length >= 2) {
        const bandwidths = members.map((member) => hostBandwidthHintMbps(hostById.get(Number(member.hostId))));
        if (bandwidths.some((value) => value <= 0)) note = "有出口没填线路带宽，按一样大算";
        else how = `出口按负载（${bandwidths.map((value) => `${value}M`).join(" · ")}）`;
      }
      if (strategy === "weighted" && names.length >= 2) {
        const bandwidths = members.map((member) => hostBandwidthHintMbps(hostById.get(Number(member.hostId))));
        const weights = exitGroupWeights(strategy, bandwidths);
        if (bandwidths.some((value) => value <= 0)) note = "有出口没填线路带宽，现在按平均分";
        else how = weights ? `出口按权重 ${weights.join(":")}` : "出口按权重（带宽一样，等于轮流）";
      }
      push("loadBalance", { ...base, key: `exit_group:${id}`, kind: "exit_group", how, note, href: `/tunnels?tab=exits&edit=${id}` });
    }
  }

  const hopsByTunnel = new Map<number, HopRow[]>();
  for (const hop of input.hops) hopsByTunnel.set(Number(hop.tunnelId), [...(hopsByTunnel.get(Number(hop.tunnelId)) || []), hop]);
  const exitsByTunnel = new Map<number, ExitNodeRow[]>();
  for (const node of input.exitNodes) {
    if (!on(node.isEnabled)) continue;
    exitsByTunnel.set(Number(node.tunnelId), [...(exitsByTunnel.get(Number(node.tunnelId)) || []), node]);
  }

  for (const tunnel of input.tunnels) {
    const id = Number(tunnel.id);
    const name = String(tunnel.name || `隧道 ${id}`);
    const enabled = on(tunnel.isEnabled);
    const href = `/tunnels?tab=tunnels&edit=${id}`;
    const hops = [...(hopsByTunnel.get(id) || [])].sort((a, b) => Number(a.seq) - Number(b.seq));
    // 和下发用同一套判断（shared/tunnelRelay.ts）：协议不支持、中转不够两台时实际就是普通链路，不列。
    const relays = tunnelRelayCandidates(hops).map((hop) => hostName(hop.hostId));
    if (isTunnelRelayFailover(tunnel, hops)) {
      push("failover", { key: `tunnel:${id}:relay`, kind: "tunnel", id, name, enabled, how: "中转主备", members: relays, href });
    } else if (isTunnelRelayAggregate(tunnel, hops)) {
      push("splitConnection", { key: `tunnel:${id}:relay`, kind: "tunnel", id, name, enabled, how: `${relays.length} 台中转一起送`, members: relays, href });
    }
    const extraExits = exitsByTunnel.get(id) || [];
    const multiExit = on(tunnel.loadBalanceEnabled, false) && normalizeExitGroupStrategy(tunnel.loadBalanceStrategy) !== "none" && extraExits.length > 0;
    const streams = normalizeTunnelParallelStreams(tunnel.parallelStreams);
    if (streams >= 2) {
      // 开了但这条隧道拆不了（不是 NEX、多出口……）：照样列出来，写明为什么没生效。
      const blocked = tunnelParallelStreamsUnavailableReason(tunnel, hops, multiExit ? 1 + extraExits.length : 1);
      push("splitConnection", {
        key: `tunnel:${id}:streams`, kind: "tunnel", id, name, enabled,
        how: `多路并发 ${streams} 条`,
        members: [hostName(tunnel.entryHostId), hostName(tunnel.exitHostId)],
        note: blocked ? `没生效：${blocked}` : undefined,
        href,
      });
    }
    // 出口组的隧道在出口组那一项里；这里只列没挂出口组、自己带了额外出口的老隧道。
    if (Number(tunnel.exitGroupId || 0) <= 0 && on(tunnel.loadBalanceEnabled, false) && extraExits.length > 0) {
      const strategy = normalizeExitGroupStrategy(tunnel.loadBalanceStrategy);
      if (strategy === "none") continue;
      const members = [hostName(tunnel.exitHostId), ...extraExits.map((node) => hostName(node.hostId))];
      if (strategy === "fallback") push("failover", { key: `tunnel:${id}:exits`, kind: "tunnel", id, name, enabled, how: "多出口主备", members, href });
      else push("loadBalance", { key: `tunnel:${id}:exits`, kind: "tunnel", id, name, enabled, how: `多出口${LINK_SPREAD_LABELS[strategy].label}`, members, href });
    }
  }

  const byName = (a: LinkOverviewItem, b: LinkOverviewItem) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, "zh-CN");
  out.failover.sort(byName);
  out.loadBalance.sort(byName);
  out.splitConnection.sort(byName);
  return out;
}
