import * as db from "./db";
import { getRouteStatus } from "./routeGroupStats";
import { forwardGroupModeOf } from "../shared/forwardTypes";
import { routeGroupOf } from "../shared/routeGroup";
import { formatHostAddressWithPort, getHostEntryAddress } from "../shared/hostEntryAddress";

/*
  订阅内容 › 点开一条：这条线路怎么走 —— 入口 → 经过的中转 → 落地。

  订阅里一排「Po0(200M) → HK」「po0(300M) → HK」，只看名字分不清哪条走的是隧道、哪条是转发链、
  线路组现在走哪条路径。这里按规则把那条线拼出来（和转发页 / 隧道页是同一份配置，不另存）：
    · 入口：规则所在的入口机；挂在转发组上写组名和几台入口，转发链挂了入口组写入口组。
    · 经过：隧道的中转和出口（入口不重复列）、转发链的成员、线路组当前在走的那条路径的中转。
    · 落地：规则目标；绑了「我的节点」写节点名。线路组的路径另有落地时写那条路径的落地。
*/

export type RouteViewHop = { name: string; role: "entry" | "relay" | "exit"; online: boolean | null; note?: string };

export type SubscriptionRouteView = {
  ruleId: number;
  ruleName: string;
  kind: "local" | "tunnel" | "chain" | "group" | "route";
  kindLabel: string;
  entry: RouteViewHop & { address: string };
  hops: RouteViewHop[];
  landing: { name: string; address: string; nodeId: number | null };
  /** 一句补充：线路组当前走哪条、还有几条备用；转发组几台入口怎么分。 */
  note: string;
};

const KIND_LABELS: Record<SubscriptionRouteView["kind"], string> = {
  local: "端口转发",
  tunnel: "隧道",
  chain: "转发链",
  group: "转发组",
  route: "线路组",
};

function enabled(value: unknown) {
  return !(value === false || value === 0 || value === "0" || value === "false");
}

export async function buildSubscriptionRouteView(rule: any): Promise<SubscriptionRouteView> {
  const hostCache = new Map<number, any>();
  const hostOf = async (id: unknown) => {
    const hostId = Number(id || 0);
    if (hostId <= 0) return null;
    if (!hostCache.has(hostId)) hostCache.set(hostId, (await db.getHostById(hostId)) || null);
    return hostCache.get(hostId);
  };
  const hop = async (id: unknown, role: RouteViewHop["role"], note?: string): Promise<RouteViewHop> => {
    const host = await hostOf(id);
    return { name: String(host?.name || `主机 ${Number(id || 0)}`), role, online: host ? !!host.isOnline : null, ...(note ? { note } : {}) };
  };
  const sourcePort = Number(rule.sourcePort || 0);
  const addressOf = (host: any) => (host ? formatHostAddressWithPort(getHostEntryAddress(host) || String(host.ip || ""), sourcePort) : "");

  const routeGroup = routeGroupOf(rule);
  const group = Number(rule.forwardGroupId || 0) > 0 ? await (db.getForwardGroupById(Number(rule.forwardGroupId)) as Promise<any>).catch(() => null) : null;
  const groupMode = group ? forwardGroupModeOf(group) : null;
  const tunnel = !routeGroup && Number(rule.tunnelId || 0) > 0 ? await (db.getTunnelById(Number(rule.tunnelId)) as Promise<any>).catch(() => null) : null;
  const kind: SubscriptionRouteView["kind"] = routeGroup ? "route" : group ? (groupMode === "chain" ? "chain" : "group") : tunnel ? "tunnel" : "local";

  let entry: SubscriptionRouteView["entry"];
  const hops: RouteViewHop[] = [];
  let note = "";

  if (group && groupMode === "chain") {
    const members = (Array.isArray(group.members) ? group.members : []).filter((member: any) => enabled(member?.isEnabled))
      .sort((left: any, right: any) => Number(left?.priority || 0) - Number(right?.priority || 0));
    const entryGroup = Number(group.entryGroupId || 0) > 0 ? await (db.getForwardGroupById(Number(group.entryGroupId)) as Promise<any>).catch(() => null) : null;
    if (entryGroup) {
      const entryMembers = Array.isArray(entryGroup.members) ? entryGroup.members : [];
      const first = entryMembers[0] ? await hostOf(entryMembers[0].hostId) : null;
      entry = { name: String(entryGroup.name || "入口组"), role: "entry", online: null, note: `入口组 · ${entryMembers.length} 台入口`, address: addressOf(first) };
      for (const member of members) hops.push(await hop(member.hostId, "relay"));
    } else {
      const firstHost = await hostOf(members[0]?.hostId || rule.hostId);
      entry = { name: String(firstHost?.name || "入口"), role: "entry", online: firstHost ? !!firstHost.isOnline : null, address: addressOf(firstHost) };
      for (const member of members.slice(1)) hops.push(await hop(member.hostId, "relay"));
    }
    note = `转发链「${String(group.name || "")}」，${members.length} 台依次转发`;
  } else if (group) {
    const members = (Array.isArray(group.members) ? group.members : []).filter((member: any) => enabled(member?.isEnabled));
    const first = members[0] ? await hostOf(members[0].hostId) : null;
    const names: string[] = [];
    for (const member of members) names.push((await hop(member.hostId, "entry")).name);
    entry = { name: String(group.name || "转发组"), role: "entry", online: null, note: `${members.length} 台入口`, address: addressOf(first) };
    note = `${groupMode === "failover" ? "主备" : groupMode === "entry" ? "入口组" : "转发组"}：${names.join(" / ") || "没有可用成员"}`;
  } else {
    const host = await hostOf(rule.hostId);
    entry = { name: String(host?.name || "入口"), role: "entry", online: host ? !!host.isOnline : null, address: addressOf(host) };
  }

  if (tunnel) {
    const ids = Array.isArray(tunnel.hopHostIds) && tunnel.hopHostIds.length >= 2
      ? tunnel.hopHostIds.map((id: any) => Number(id)).filter((id: number) => id > 0)
      : [Number(tunnel.entryHostId || 0), Number(tunnel.exitHostId || 0)].filter((id) => id > 0);
    const rest = ids.slice(1);
    for (const [index, id] of rest.entries()) hops.push(await hop(id, index === rest.length - 1 ? "exit" : "relay"));
    note = `隧道「${String(tunnel.name || "")}」`;
  }

  let landingAddress = formatHostAddressWithPort(String(rule.targetIp || ""), Number(rule.targetPort || 0));
  let landingNodeId = Number(rule.proxyNodeId || 0) || null;
  if (routeGroup) {
    const status = getRouteStatus(Number(rule.id));
    const agent = status.agent || status.staleAgent;
    const activeIndex = agent && agent.activeIndex >= 0 ? agent.activeIndex : 0;
    const path = routeGroup.paths[activeIndex] || routeGroup.paths[0];
    if (path) {
      for (const id of path.hops) hops.push(await hop(id, "relay"));
      if (path.dest?.ip) landingAddress = formatHostAddressWithPort(path.dest.ip, Number(path.dest.port || 0));
      if (path.destNodeId) landingNodeId = Number(path.destNodeId);
      const letter = String.fromCharCode(65 + Math.max(0, routeGroup.paths.indexOf(path)));
      const others = routeGroup.paths.length - 1;
      note = `${agent ? "现在走" : "还没报在走哪条，按第一条画"}路径 ${letter}「${path.name}」${others > 0 ? `，另有 ${others} 条备用` : ""}`;
    }
  }

  const node = landingNodeId ? await db.getProxyNodeById(landingNodeId).catch(() => null) : null;
  return {
    ruleId: Number(rule.id),
    ruleName: String(rule.name || `转发 #${rule.id}`),
    kind,
    kindLabel: KIND_LABELS[kind],
    entry,
    hops,
    landing: { name: node ? String(node.name || "落地") : "落地", address: landingAddress, nodeId: node ? Number(node.id) : null },
    note,
  };
}
