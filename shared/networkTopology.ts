import { buildHostAddressIndex, type ForwardMapHost } from "./forwardMapLinks";
import { formatFailoverEndpoint } from "./failoverTargets";
import { routeGroupOf, routePathDestination, routePathLabel, type RouteGroupRule } from "./routeGroup";

/**
 * 「网络拓扑」页的图：整个面板（或一个用户）的流量从哪进、经过谁、落到哪。
 *
 * 首页地图（forwardMapLinks）只画「主机 → 主机」，外部目标故意不画；这张图是按链路看的，
 * 所以每一种转发都要拆到底：
 *
 *   普通规则         入口主机 → 目标（目标地址对得上某台受管主机就落在那台主机上，否则是外部目标）
 *   隧道规则         入口 → 隧道中转… → 出口（多出口按这条规则实际分到的出口）→ 目标
 *   转发链           入口（或入口组的每台）→ 成员 1 → … → 成员 N → 目标；用的是面板拆出来的子规则，
 *                   但图上记的是用户看得见的那条模板规则的 id
 *   端口转发 / 转发组 每台成员主机上的子规则各自一条「主机 → 目标」，同样记模板规则的 id
 *   线路组           每条路径：入口（隧道规则是隧道出口）→ 中转… → 这条路径的落地；中转上的中继规则
 *                   不再单算，它们只用来说明那一跳是不是在跑
 *   落地入站         主机 → 入站（订阅里的那个节点）；落在这个入站端口上的规则也记在这条边上
 *   入口组 / 转发组   组（客户端连的域名）→ 每台成员主机
 *
 * 去重：同一台主机只出现一次；外部目标按「地址:端口」合并（域名原样保留，不解析）；同一对节点之间
 * 同一种连线合成一条，边上记经过它的规则 id，粗细按条数。
 *
 * 用户视角（scope）：只看他自己的规则、隧道、转发组、入站和这些东西经过的主机。经过的主机不是他看得
 * 见的（别人共享给他的隧道的中转机）时只画一个「隐藏节点」，不给名字、地址和 id；他自己填的目标地址
 * 对上了一台他看不见的主机时，按外部目标画，不暴露那是一台受管主机。
 *
 * 纯函数：数据由 server/networkTopology.ts 取好传进来，测试直接喂样例。
 */

export type TopologyNodeKind = "host" | "target" | "inbound" | "group";
export type TopologyEdgeKind = "rule" | "tunnel" | "chain" | "routePath" | "subscription" | "group";
export type TopologyStatus = "running" | "stopped" | "degraded" | "failed";
export type TopologyRole = "entry" | "relay" | "exit" | "landing";

export type TopologyRoles = Record<TopologyRole, boolean>;

export type TopologyNode = {
  id: string;
  kind: TopologyNodeKind;
  label: string;
  sublabel: string | null;
  hostId: number | null;
  groupId: number | null;
  inboundId: number | null;
  online: boolean | null;
  country: string | null;
  roles: TopologyRoles;
  /** 用户视角里看不见的主机：只知道「这里有一台」。 */
  masked: boolean;
  ruleIds: number[];
  tunnelIds: number[];
  groupIds: number[];
};

export type TopologyEdge = {
  id: string;
  from: string;
  to: string;
  kind: TopologyEdgeKind;
  /** 经过这条边的规则（模板规则 id，和转发规则页上看到的一致） */
  ruleIds: number[];
  tunnelId: number | null;
  groupId: number | null;
  /** 线路组的路径 key（同一条边可能被几条路径共用） */
  pathKeys: string[];
  /** tcp / udp / both；几条规则协议不同时为 mixed */
  protocol: string | null;
  /** 这一段到达的端口（几条规则端口不同时为 null） */
  port: number | null;
  status: TopologyStatus;
  latencyMs: number | null;
  label: string | null;
};

export type TopologyRuleKind = "direct" | "tunnel" | "chain" | "group" | "route";

export type TopologyRuleRef = {
  id: number;
  name: string;
  userId: number;
  kind: TopologyRuleKind;
  status: TopologyStatus;
  tunnelId: number | null;
  groupId: number | null;
  sourcePort: number | null;
  protocol: string | null;
  target: string;
  pathCount: number;
};

export type TopologyTunnelRef = { id: number; name: string; userId: number; mode: string; status: TopologyStatus; latencyMs: number | null };
export type TopologyGroupRef = { id: number; name: string; userId: number; groupMode: string; status: TopologyStatus; domain: string | null };

export type TopologyGraph = {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  rules: TopologyRuleRef[];
  tunnels: TopologyTunnelRef[];
  groups: TopologyGroupRef[];
};

export type TopologyHostRow = ForwardMapHost & {
  name?: unknown;
  userId?: unknown;
  isOnline?: unknown;
  geoCountryCode?: unknown;
};

export type TopologyRuleRow = {
  id: number;
  name?: unknown;
  userId?: unknown;
  hostId: number;
  protocol?: unknown;
  sourcePort?: unknown;
  targetIp?: unknown;
  targetPort?: unknown;
  tunnelId?: unknown;
  isEnabled?: unknown;
  isRunning?: unknown;
  isForwardGroupTemplate?: unknown;
  forwardGroupId?: unknown;
  forwardGroupRuleId?: unknown;
  forwardGroupMemberId?: unknown;
  routeParentRuleId?: unknown;
  routePathKey?: unknown;
  routeHopIndex?: unknown;
  proxyNodeId?: unknown;
  /** Shadowsocks 出口（2.3.445）：none | ss_host | ss_link；ss_host 时 egressInboundId 指向落地入站 */
  egressType?: unknown;
  egressInboundId?: unknown;
} & RouteGroupRule;

export type TopologyTunnelRow = {
  id: number;
  name?: unknown;
  userId?: unknown;
  entryHostId?: unknown;
  exitHostId?: unknown;
  entryGroupId?: unknown;
  mode?: unknown;
  listenPort?: unknown;
  isEnabled?: unknown;
  isRunning?: unknown;
  lastLatencyMs?: unknown;
  lastTestStatus?: unknown;
  hops?: Array<{ seq?: unknown; hostId?: unknown }>;
  exitNodes?: Array<{ seq?: unknown; hostId?: unknown; isEnabled?: unknown }>;
};

export type TopologyGroupMemberRow = {
  id: number;
  hostId?: unknown;
  tunnelId?: unknown;
  priority?: unknown;
  isEnabled?: unknown;
  healthStatus?: unknown;
};

export type TopologyGroupRow = {
  id: number;
  name?: unknown;
  userId?: unknown;
  groupMode?: unknown;
  entryGroupId?: unknown;
  domain?: unknown;
  isEnabled?: unknown;
  lastStatus?: unknown;
  activeMemberId?: unknown;
  members?: TopologyGroupMemberRow[];
};

export type TopologyInboundRow = {
  id: number;
  name?: unknown;
  userId?: unknown;
  hostId?: unknown;
  protocol?: unknown;
  port?: unknown;
  isEnabled?: unknown;
};

export type TopologyRouteStats = {
  targets: Array<{ index: number; latencyMs: number | null; healthy: boolean }>;
  hops: Array<{ pathKey: string; hopIndex: number; ok: boolean; latencyMs: number | null; consecutiveFailures: number }>;
};

export type TopologyScope = {
  userId: number;
  /** true：看不见的主机打码（普通用户）。管理员按用户筛选时为 false。 */
  mask: boolean;
  visibleHostIds: ReadonlySet<number>;
};

export type TopologyInput = {
  hosts: readonly TopologyHostRow[];
  rules: readonly TopologyRuleRow[];
  tunnels: readonly TopologyTunnelRow[];
  groups: readonly TopologyGroupRow[];
  inbounds?: readonly TopologyInboundRow[];
  /** forward_rule_tunnel_exits：多出口隧道上这条规则分到了哪几个出口 */
  ruleTunnelExits?: ReadonlyArray<{ ruleId: number; exitHostId: number }>;
  /** proxy_nodes.inboundId：规则绑的节点是哪个落地入站派生的 */
  proxyNodeInbounds?: ReadonlyArray<{ nodeId: number; inboundId: number }>;
  /** 每条规则最近一次探测的延迟（毫秒），没有就不给 */
  ruleLatencyMs?: ReadonlyMap<number, number | null>;
  routeStats?: (ruleId: number) => TopologyRouteStats | null;
  scope?: TopologyScope | null;
};

export const TOPOLOGY_ROLE_LABELS: Record<TopologyRole, string> = {
  entry: "入口",
  relay: "中转",
  exit: "出口",
  landing: "落地",
};

export const TOPOLOGY_EDGE_KIND_LABELS: Record<TopologyEdgeKind, string> = {
  rule: "转发规则",
  tunnel: "隧道",
  chain: "转发链",
  routePath: "线路组路径",
  subscription: "落地入站",
  group: "入口组 / 转发组",
};

export const TOPOLOGY_STATUS_LABELS: Record<TopologyStatus, string> = {
  running: "运行中",
  stopped: "已停用",
  degraded: "部分异常",
  failed: "异常",
};

const STATUS_RANK: Record<TopologyStatus, number> = { running: 0, degraded: 1, failed: 2, stopped: 3 };

function truthy(value: unknown, fallback = false) {
  if (value === null || value === undefined) return fallback;
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function positiveInt(value: unknown) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function addressToken(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

function normalizeProtocol(value: unknown) {
  const raw = text(value).toLowerCase();
  return raw === "tcp" || raw === "udp" ? raw : raw ? "both" : null;
}

/** 依次经过的两段，整段算差的那个：隧道停了，走它的规则也就停了。 */
export function worseTopologyStatus(left: TopologyStatus, right: TopologyStatus): TopologyStatus {
  return STATUS_RANK[left] >= STATUS_RANK[right] ? left : right;
}

/** 几条并列的规则合成一条边时的状态：全停 = 停用；开着的全坏 = 异常；有好有坏 = 部分异常。 */
export function mergeTopologyStatuses(statuses: readonly TopologyStatus[]): TopologyStatus {
  const active = statuses.filter((status) => status !== "stopped");
  if (statuses.length === 0) return "running";
  if (active.length === 0) return "stopped";
  if (active.every((status) => status === "failed")) return "failed";
  if (active.some((status) => status === "failed" || status === "degraded")) return "degraded";
  return "running";
}

export function topologyRuleStatus(rule: { isEnabled?: unknown; isRunning?: unknown }): TopologyStatus {
  if (!truthy(rule.isEnabled, true)) return "stopped";
  return truthy(rule.isRunning) ? "running" : "failed";
}

const FAILED_TEST_STATUSES = new Set(["failed", "fail", "timeout", "error", "unreachable"]);

export function topologyTunnelStatus(tunnel: { isEnabled?: unknown; isRunning?: unknown; lastTestStatus?: unknown }): TopologyStatus {
  if (!truthy(tunnel.isEnabled, true)) return "stopped";
  if (!truthy(tunnel.isRunning)) return "failed";
  return FAILED_TEST_STATUSES.has(text(tunnel.lastTestStatus).toLowerCase()) ? "degraded" : "running";
}

export function topologyGroupStatus(group: { isEnabled?: unknown; lastStatus?: unknown }): TopologyStatus {
  if (!truthy(group.isEnabled, true)) return "stopped";
  const status = text(group.lastStatus).toLowerCase();
  if (status === "down" || status === "failed" || status === "unhealthy" || status === "error") return "failed";
  if (status === "degraded" || status === "warning") return "degraded";
  return "running";
}

function memberStatus(member: TopologyGroupMemberRow, groupStatus: TopologyStatus): TopologyStatus {
  if (groupStatus === "stopped" || !truthy(member.isEnabled, true)) return "stopped";
  const health = text(member.healthStatus).toLowerCase();
  if (health === "failed" || health === "down" || health === "unhealthy") return "failed";
  if (health === "degraded") return "degraded";
  return "running";
}

type Contribution = {
  status?: TopologyStatus;
  ruleId?: number;
  latencyMs?: number | null;
  protocol?: string | null;
  port?: number | null;
  pathKey?: string;
  label?: string | null;
};

type EdgeDraft = {
  id: string;
  from: string;
  to: string;
  kind: TopologyEdgeKind;
  tunnelId: number | null;
  groupId: number | null;
  ruleIds: Set<number>;
  pathKeys: Set<string>;
  statuses: TopologyStatus[];
  latencies: number[];
  protocols: Set<string>;
  ports: Set<number>;
  labels: Set<string>;
};

function emptyRoles(): TopologyRoles {
  return { entry: false, relay: false, exit: false, landing: false };
}

function sortedMembers(group: TopologyGroupRow | undefined) {
  return [...(group?.members || [])]
    .filter((member) => truthy(member.isEnabled, true))
    .sort((left, right) => (Number(left.priority) || 0) - (Number(right.priority) || 0) || Number(left.id) - Number(right.id));
}

export function buildNetworkTopology(input: TopologyInput): TopologyGraph {
  const scope = input.scope || null;
  const hosts = new Map<number, TopologyHostRow>();
  for (const host of input.hosts) {
    const id = positiveInt(host.id);
    if (id) hosts.set(id, host);
  }
  const addressIndex = buildHostAddressIndex(input.hosts);
  const tunnelById = new Map<number, TopologyTunnelRow>();
  for (const tunnel of input.tunnels) if (positiveInt(tunnel.id)) tunnelById.set(Number(tunnel.id), tunnel);
  const groupById = new Map<number, TopologyGroupRow>();
  for (const group of input.groups) if (positiveInt(group.id)) groupById.set(Number(group.id), group);
  const ruleById = new Map<number, TopologyRuleRow>();
  for (const rule of input.rules) if (positiveInt(rule.id)) ruleById.set(Number(rule.id), rule);

  const ownedBy = (userId: unknown) => !scope || Number(userId) === Number(scope.userId);
  const hostVisible = (hostId: number) => !scope || !scope.mask || scope.visibleHostIds.has(hostId);

  // ── 节点 ──
  const nodes = new Map<string, TopologyNode & { ruleSet: Set<number>; tunnelSet: Set<number>; groupSet: Set<number> }>();
  const maskedIds = new Map<number, string>();
  const ensureNode = (node: Omit<TopologyNode, "roles" | "ruleIds" | "tunnelIds" | "groupIds">) => {
    let existing = nodes.get(node.id);
    if (!existing) {
      existing = { ...node, roles: emptyRoles(), ruleIds: [], tunnelIds: [], groupIds: [], ruleSet: new Set(), tunnelSet: new Set(), groupSet: new Set() };
      nodes.set(node.id, existing);
    }
    return existing.id;
  };
  const hostNode = (hostId: number): string | null => {
    if (!hostId) return null;
    const host = hosts.get(hostId);
    if (!hostVisible(hostId)) {
      let id = maskedIds.get(hostId);
      if (!id) {
        id = `masked:${maskedIds.size + 1}`;
        maskedIds.set(hostId, id);
      }
      return ensureNode({ id, kind: "host", label: "隐藏节点", sublabel: "不在你的可见范围", hostId: null, groupId: null, inboundId: null, online: null, country: null, masked: true });
    }
    if (!host) return null;
    return ensureNode({
      id: `host:${hostId}`,
      kind: "host",
      label: text(host.name) || `主机 ${hostId}`,
      sublabel: text(host.entryIp) || text(host.ip) || null,
      hostId,
      groupId: null,
      inboundId: null,
      online: truthy(host.isOnline),
      country: text(host.geoCountryCode).toUpperCase() || null,
      masked: false,
    });
  };
  const targetNode = (ip: unknown, port: unknown, fromNodeId?: string | null): { id: string; hostId: number | null } | null => {
    const token = addressToken(ip);
    const portNumber = positiveInt(port);
    if (!token) return null;
    const hostId = addressIndex.get(token);
    if (hostId && hostVisible(hostId)) {
      const id = hostNode(hostId);
      if (id && id !== fromNodeId) return { id, hostId };
    }
    const label = formatFailoverEndpoint(text(ip).replace(/^\[(.*)\]$/, "$1"), portNumber) || token;
    const id = ensureNode({ id: `target:${token}:${portNumber}`, kind: "target", label, sublabel: "外部目标", hostId: null, groupId: null, inboundId: null, online: null, country: null, masked: false });
    return { id, hostId: null };
  };
  const groupNode = (group: TopologyGroupRow) => ensureNode({
    id: `group:${group.id}`,
    kind: "group",
    label: text(group.name) || `组 ${group.id}`,
    sublabel: text(group.domain) || (text(group.groupMode) === "entry" ? "入口组" : "转发组"),
    hostId: null,
    groupId: Number(group.id),
    inboundId: null,
    online: null,
    country: null,
    masked: false,
  });
  const markRole = (nodeId: string | null | undefined, role: TopologyRole) => {
    const node = nodeId ? nodes.get(nodeId) : undefined;
    if (node && node.kind === "host") node.roles[role] = true;
  };

  // ── 边 ──
  const edges = new Map<string, EdgeDraft>();
  const addEdge = (
    kind: TopologyEdgeKind,
    from: string | null | undefined,
    to: string | null | undefined,
    resource: { tunnelId?: number | null; groupId?: number | null },
    contribution: Contribution,
  ) => {
    if (!from || !to || from === to) return;
    const tunnelId = resource.tunnelId || null;
    const groupId = resource.groupId || null;
    const id = `${kind}|${from}|${to}|${tunnelId ?? ""}|${groupId ?? ""}`;
    let edge = edges.get(id);
    if (!edge) {
      edge = { id, from, to, kind, tunnelId, groupId, ruleIds: new Set(), pathKeys: new Set(), statuses: [], latencies: [], protocols: new Set(), ports: new Set(), labels: new Set() };
      edges.set(id, edge);
    }
    if (contribution.status) edge.statuses.push(contribution.status);
    if (contribution.ruleId) edge.ruleIds.add(contribution.ruleId);
    if (contribution.pathKey) edge.pathKeys.add(contribution.pathKey);
    if (typeof contribution.latencyMs === "number" && Number.isFinite(contribution.latencyMs) && contribution.latencyMs >= 0) edge.latencies.push(contribution.latencyMs);
    if (contribution.protocol) edge.protocols.add(contribution.protocol);
    if (contribution.port) edge.ports.add(contribution.port);
    if (contribution.label) edge.labels.add(contribution.label);
  };

  // ── 资源清单（用户视角下只留他的） ──
  const ruleRefs = new Map<number, TopologyRuleRef & { statuses: TopologyStatus[] }>();
  const includedTunnelIds = new Set<number>();
  const includedGroupIds = new Set<number>();
  const tunnelContributed = new Set<number>();
  const groupContributed = new Set<number>();

  for (const tunnel of input.tunnels) if (ownedBy(tunnel.userId)) includedTunnelIds.add(Number(tunnel.id));
  for (const group of input.groups) if (ownedBy(group.userId)) includedGroupIds.add(Number(group.id));

  // 中转跳上的中继规则：只用来说明那一跳在不在跑。
  const relayByParent = new Map<number, Map<string, TopologyRuleRow>>();
  for (const rule of input.rules) {
    const parent = positiveInt(rule.routeParentRuleId);
    if (!parent) continue;
    const map = relayByParent.get(parent) || new Map<string, TopologyRuleRow>();
    map.set(`${text(rule.routePathKey)}:${Math.floor(Number(rule.routeHopIndex) || 0)}`, rule);
    relayByParent.set(parent, map);
  }

  const ruleExitHosts = new Map<number, number[]>();
  for (const row of input.ruleTunnelExits || []) {
    const list = ruleExitHosts.get(Number(row.ruleId)) || [];
    if (positiveInt(row.exitHostId) && !list.includes(Number(row.exitHostId))) list.push(Number(row.exitHostId));
    ruleExitHosts.set(Number(row.ruleId), list);
  }
  const inboundByNode = new Map<number, number>();
  for (const row of input.proxyNodeInbounds || []) if (positiveInt(row.inboundId)) inboundByNode.set(Number(row.nodeId), Number(row.inboundId));
  const inboundIdByHostPort = new Map<string, number>();
  const inboundById = new Map<number, TopologyInboundRow>();
  for (const inbound of input.inbounds || []) inboundById.set(Number(inbound.id), inbound);
  for (const inbound of input.inbounds || []) {
    inboundIdByHostPort.set(`${positiveInt(inbound.hostId)}:${positiveInt(inbound.port)}`, Number(inbound.id));
  }
  const landingRulesByInbound = new Map<number, Set<number>>();

  const entryGroupFanout = (entryGroupId: number) => {
    const group = groupById.get(entryGroupId);
    if (!group) return [] as string[];
    // 被看得见的隧道 / 链 / 端口转发引用的入口组：它就是客户端连的那个域名，一起画出来。
    includedGroupIds.add(entryGroupId);
    const node = groupNode(group);
    const status = topologyGroupStatus(group);
    const hostIds: string[] = [];
    for (const member of sortedMembers(group)) {
      const memberHost = positiveInt(member.hostId);
      const id = hostNode(memberHost);
      if (!id) continue;
      markRole(id, "entry");
      addEdge("group", node, id, { groupId: entryGroupId }, { status: memberStatus(member, status), label: "入口组成员" });
      hostIds.push(id);
    }
    return hostIds;
  };

  /** 隧道：起点们 → 中转… → 出口们，返回出口节点。 */
  const tunnelPath = (tunnel: TopologyTunnelRow, starts: string[], exitHostIds: number[], contribution: Contribution) => {
    const tunnelId = Number(tunnel.id);
    tunnelContributed.add(tunnelId);
    includedTunnelIds.add(tunnelId);
    const hops = [...(tunnel.hops || [])]
      .sort((left, right) => (Number(left.seq) || 0) - (Number(right.seq) || 0))
      .map((hop) => positiveInt(hop.hostId))
      .filter((id) => id > 0);
    const exits = exitHostIds.length > 0 ? exitHostIds : Array.from(new Set([
      positiveInt(tunnel.exitHostId),
      ...[...(tunnel.exitNodes || [])]
        .filter((node) => truthy(node.isEnabled, true))
        .sort((left, right) => (Number(left.seq) || 0) - (Number(right.seq) || 0))
        .map((node) => positiveInt(node.hostId)),
    ].filter((id) => id > 0)));
    const label = text(tunnel.name) || `隧道 ${tunnelId}`;
    const rawLatency = tunnel.lastLatencyMs;
    const latency = rawLatency === null || rawLatency === undefined || rawLatency === "" ? null : Number(rawLatency);
    let previous = starts;
    for (const start of starts) markRole(start, "entry");
    for (const hop of hops) {
      const id = hostNode(hop);
      if (!id) continue;
      markRole(id, "relay");
      for (const from of previous) addEdge("tunnel", from, id, { tunnelId }, { ...contribution, label });
      previous = [id];
    }
    const exitNodes: string[] = [];
    for (const exit of exits) {
      const id = hostNode(exit);
      if (!id) continue;
      markRole(id, "exit");
      for (const from of previous) addEdge("tunnel", from, id, { tunnelId }, { ...contribution, label, latencyMs: Number.isFinite(latency as number) ? latency : null, port: positiveInt(tunnel.listenPort) || null });
      exitNodes.push(id);
    }
    return exitNodes;
  };

  const tunnelEntries = (tunnel: TopologyTunnelRow, ruleHostId: number) => {
    const entryGroupId = positiveInt(tunnel.entryGroupId);
    const starts = new Set<string>();
    if (entryGroupId) for (const id of entryGroupFanout(entryGroupId)) starts.add(id);
    const own = hostNode(ruleHostId || positiveInt(tunnel.entryHostId));
    if (own) starts.add(own);
    return Array.from(starts);
  };

  const touchRuleRef = (logicalId: number, carrier: TopologyRuleRow, kind: TopologyRuleKind, status: TopologyStatus, extra: Partial<TopologyRuleRef> = {}) => {
    const template = ruleById.get(logicalId) || carrier;
    let ref = ruleRefs.get(logicalId);
    if (!ref) {
      ref = {
        id: logicalId,
        name: text(template.name) || `规则 ${logicalId}`,
        userId: Number(template.userId) || 0,
        kind,
        status,
        tunnelId: positiveInt(template.tunnelId) || null,
        groupId: positiveInt(template.forwardGroupId) || null,
        sourcePort: positiveInt(template.sourcePort) || null,
        protocol: normalizeProtocol(template.protocol),
        target: formatFailoverEndpoint(text(template.targetIp), template.targetPort),
        pathCount: 0,
        statuses: [],
        ...extra,
      };
      ruleRefs.set(logicalId, ref);
    }
    ref.statuses.push(status);
    return ref;
  };

  for (const rule of input.rules) {
    const ruleId = positiveInt(rule.id);
    if (!ruleId || truthy(rule.isForwardGroupTemplate) || positiveInt(rule.routeParentRuleId)) continue;
    const logicalId = positiveInt(rule.forwardGroupRuleId) || ruleId;
    const owner = ruleById.get(logicalId) || rule;
    if (!ownedBy(owner.userId)) continue;
    const status = topologyRuleStatus(rule);
    const protocol = normalizeProtocol(rule.protocol);
    const hostId = positiveInt(rule.hostId);
    const groupId = positiveInt(rule.forwardGroupId);
    const group = groupId ? groupById.get(groupId) : undefined;
    if (group) {
      includedGroupIds.add(groupId);
      groupContributed.add(groupId);
    }
    const groupMode = text(group?.groupMode);

    // 转发链的子规则：这一跳 → 下一跳（或最后一跳 → 目标）。
    if (group && groupMode === "chain" && positiveInt(rule.forwardGroupRuleId)) {
      touchRuleRef(logicalId, rule, "chain", status, { groupId });
      const members = sortedMembers(group);
      const index = members.findIndex((member) => Number(member.id) === positiveInt(rule.forwardGroupMemberId));
      const from = hostNode(hostId);
      const chainContribution = { ruleId: logicalId, status, protocol, label: text(group.name) || null };
      if (index < 0 || !from) continue;
      const memberHostId = positiveInt(members[index].hostId);
      const hasEntryGroup = positiveInt(group.entryGroupId) > 0;
      if (hostId !== memberHostId) {
        // 入口组的一台 → 链的第一台
        if (hasEntryGroup) entryGroupFanout(positiveInt(group.entryGroupId));
        markRole(from, "entry");
        addEdge("chain", from, hostNode(memberHostId), { groupId }, { ...chainContribution, port: null });
        continue;
      }
      markRole(from, index === 0 && !hasEntryGroup ? "entry" : "relay");
      if (index === members.length - 1) {
        markRole(from, "exit");
        if (index === 0 && !hasEntryGroup) markRole(from, "entry");
        const target = targetNode(rule.targetIp, rule.targetPort, from);
        if (target?.hostId) markRole(target.id, "landing");
        addEdge("chain", from, target?.id, { groupId }, { ...chainContribution, port: positiveInt(rule.targetPort) || null, latencyMs: input.ruleLatencyMs?.get(ruleId) ?? null });
      } else {
        addEdge("chain", from, hostNode(positiveInt(members[index + 1].hostId)), { groupId }, chainContribution);
      }
      continue;
    }

    const tunnelId = positiveInt(rule.tunnelId);
    const tunnel = tunnelId ? tunnelById.get(tunnelId) : undefined;
    const routeGroup = routeGroupOf(rule);
    const kind: TopologyRuleKind = routeGroup ? "route" : tunnel ? "tunnel" : group ? "group" : "direct";
    touchRuleRef(logicalId, rule, kind, tunnel ? worseTopologyStatus(status, topologyTunnelStatus(tunnel)) : status, {
      pathCount: routeGroup ? routeGroup.paths.length : 0,
    });

    let starts: string[];
    let lastStatus = status;
    if (tunnel) {
      const tunnelStatus = worseTopologyStatus(status, topologyTunnelStatus(tunnel));
      lastStatus = tunnelStatus;
      starts = tunnelPath(tunnel, tunnelEntries(tunnel, hostId), ruleExitHosts.get(ruleId) || [], { ruleId: logicalId, status: tunnelStatus, protocol });
    } else {
      const own = hostNode(hostId);
      starts = own ? [own] : [];
      for (const start of starts) markRole(start, "entry");
    }

    if (routeGroup) {
      const stats = input.routeStats?.(logicalId) || null;
      const relays = relayByParent.get(ruleId) || new Map<string, TopologyRuleRow>();
      routeGroup.paths.forEach((path, index) => {
        const label = routePathLabel(path, index);
        const agentTarget = stats?.targets.find((target) => target.index === index) || null;
        const base: TopologyStatus = lastStatus === "stopped" ? "stopped" : path.issue ? "failed" : lastStatus;
        let previous = starts;
        const nodesInPath = path.hops.map((hop) => hostNode(hop));
        nodesInPath.forEach((nodeId, hopIndex) => {
          if (!nodeId) return;
          markRole(nodeId, "relay");
          const relay = relays.get(`${path.key}:${hopIndex}`);
          let segment = base;
          if (hopIndex === 0) {
            if (agentTarget && !agentTarget.healthy && segment === "running") segment = "degraded";
          } else {
            const probe = stats?.hops.find((item) => item.pathKey === path.key && item.hopIndex === hopIndex - 1) || null;
            if (probe && !probe.ok && segment !== "stopped") segment = worseTopologyStatus(segment, probe.consecutiveFailures >= 3 ? "failed" : "degraded");
          }
          if (relay && segment !== "stopped" && !truthy(relay.isRunning)) segment = "failed";
          const latency = hopIndex === 0
            ? agentTarget?.latencyMs ?? null
            : stats?.hops.find((item) => item.pathKey === path.key && item.hopIndex === hopIndex - 1)?.latencyMs ?? null;
          for (const from of previous) {
            addEdge("routePath", from, nodeId, {}, { ruleId: logicalId, status: segment, pathKey: path.key, protocol, port: relay ? positiveInt(relay.sourcePort) || null : null, latencyMs: latency, label });
          }
          previous = [nodeId];
        });
        const dest = routePathDestination(path, rule);
        const lastHopIndex = path.hops.length - 1;
        let finalStatus = base;
        if (lastHopIndex >= 0) {
          const probe = stats?.hops.find((item) => item.pathKey === path.key && item.hopIndex === lastHopIndex) || null;
          if (probe && !probe.ok && finalStatus !== "stopped") finalStatus = worseTopologyStatus(finalStatus, probe.consecutiveFailures >= 3 ? "failed" : "degraded");
          const relay = relays.get(`${path.key}:${lastHopIndex}`);
          if (relay && finalStatus !== "stopped" && !truthy(relay.isRunning)) finalStatus = "failed";
        } else if (agentTarget && !agentTarget.healthy && finalStatus === "running") {
          finalStatus = "degraded";
        }
        const finalLatency = lastHopIndex >= 0
          ? stats?.hops.find((item) => item.pathKey === path.key && item.hopIndex === lastHopIndex)?.latencyMs ?? null
          : agentTarget?.latencyMs ?? null;
        for (const from of previous) {
          const target = targetNode(dest.ip, dest.port, from);
          if (!target) continue;
          if (target.hostId) {
            markRole(target.id, "landing");
            const inboundId = inboundIdByHostPort.get(`${target.hostId}:${dest.port}`);
            if (inboundId) landingRulesByInbound.set(inboundId, (landingRulesByInbound.get(inboundId) || new Set()).add(logicalId));
          }
          addEdge("routePath", from, target.id, {}, { ruleId: logicalId, status: finalStatus, pathKey: path.key, protocol, port: dest.port || null, latencyMs: finalLatency, label });
        }
      });
    } else {
      /*
        Shadowsocks 出口：真实路径是 入口 → 落地主机（SS 入站）→ 目标，目标是落地主机去连的。
        外部 SS 链接的服务器地址是加密存的，画不出那一跳，只在入口 → 目标这条边上标出来。
      */
      const egressType = text(rule.egressType);
      const egressInbound = egressType === "ss_host" ? inboundById.get(positiveInt(rule.egressInboundId)) : undefined;
      const landing = egressInbound ? hostNode(positiveInt(egressInbound.hostId)) : null;
      for (const from of starts) {
        if (landing && landing !== from) {
          markRole(landing, "exit");
          addEdge("rule", from, landing, { groupId: groupId || null }, {
            ruleId: logicalId,
            status: lastStatus,
            protocol: "tcp",
            port: positiveInt(egressInbound?.port) || null,
            label: "SS 出口",
          });
          const egressTarget = targetNode(rule.targetIp, rule.targetPort, landing);
          if (egressTarget) {
            addEdge("rule", landing, egressTarget.id, { groupId: groupId || null }, {
              ruleId: logicalId,
              status: lastStatus,
              protocol: "tcp",
              port: positiveInt(rule.targetPort) || null,
              latencyMs: input.ruleLatencyMs?.get(ruleId) ?? null,
            });
          }
          continue;
        }
        const target = targetNode(rule.targetIp, rule.targetPort, from);
        if (!target) continue;
        if (target.hostId) {
          markRole(target.id, "landing");
          const inboundId = inboundIdByHostPort.get(`${target.hostId}:${positiveInt(rule.targetPort)}`);
          if (inboundId) landingRulesByInbound.set(inboundId, (landingRulesByInbound.get(inboundId) || new Set()).add(logicalId));
        }
        addEdge("rule", from, target.id, { groupId: groupId || null }, {
          ruleId: logicalId,
          status: lastStatus,
          protocol,
          port: positiveInt(rule.targetPort) || null,
          latencyMs: input.ruleLatencyMs?.get(ruleId) ?? null,
          ...(egressType === "ss_link" ? { label: "经外部 SS 出口" } : {}),
        });
      }
    }
    const boundInbound = inboundByNode.get(positiveInt(rule.proxyNodeId));
    if (boundInbound) landingRulesByInbound.set(boundInbound, (landingRulesByInbound.get(boundInbound) || new Set()).add(logicalId));
  }

  // 没有规则走的隧道也画出来：链路本身在那里。
  for (const tunnelId of Array.from(includedTunnelIds).sort((a, b) => a - b)) {
    const tunnel = tunnelById.get(tunnelId);
    if (!tunnel || tunnelContributed.has(tunnelId)) continue;
    if (!ownedBy(tunnel.userId)) continue;
    tunnelPath(tunnel, tunnelEntries(tunnel, 0), [], { status: topologyTunnelStatus(tunnel) });
  }

  // 转发组（主备）和链：组节点 → 成员；没有子规则的链按成员顺序画结构。
  for (const groupId of Array.from(includedGroupIds).sort((a, b) => a - b)) {
    const group = groupById.get(groupId);
    if (!group) continue;
    const mode = text(group.groupMode);
    const status = topologyGroupStatus(group);
    if (mode === "failover") {
      const node = groupNode(group);
      for (const member of sortedMembers(group)) {
        const memberTunnel = positiveInt(member.tunnelId) ? tunnelById.get(positiveInt(member.tunnelId)) : undefined;
        const memberHost = positiveInt(member.hostId) || positiveInt(memberTunnel?.entryHostId);
        const id = hostNode(memberHost);
        if (!id) continue;
        markRole(id, "entry");
        addEdge("group", node, id, { groupId }, {
          status: memberStatus(member, status),
          label: Number(group.activeMemberId) === Number(member.id) ? "当前成员" : "备用成员",
        });
      }
    } else if (mode === "chain" && !groupContributed.has(groupId) && ownedBy(group.userId)) {
      const members = sortedMembers(group);
      const entryGroupId = positiveInt(group.entryGroupId);
      let previous: string[] = entryGroupId ? entryGroupFanout(entryGroupId) : [];
      members.forEach((member, index) => {
        const id = hostNode(positiveInt(member.hostId));
        if (!id) return;
        if (previous.length === 0 && index === 0) {
          markRole(id, "entry");
        } else {
          markRole(id, index === members.length - 1 ? "exit" : "relay");
          for (const from of previous) addEdge("chain", from, id, { groupId }, { status, label: text(group.name) || null });
        }
        previous = [id];
      });
    } else if (mode === "port" && positiveInt(group.entryGroupId)) {
      entryGroupFanout(positiveInt(group.entryGroupId));
    }
  }

  // 落地入站：主机 → 入站。
  for (const inbound of input.inbounds || []) {
    if (!ownedBy(inbound.userId)) continue;
    const hostId = positiveInt(inbound.hostId);
    const from = hostNode(hostId);
    if (!from) continue;
    markRole(from, "landing");
    const port = positiveInt(inbound.port);
    const protocol = text(inbound.protocol) || null;
    const to = ensureNode({
      id: `inbound:${inbound.id}`,
      kind: "inbound",
      label: text(inbound.name) || `入站 ${inbound.id}`,
      sublabel: `${protocol || "入站"}${port ? ` :${port}` : ""}`,
      hostId: null,
      groupId: null,
      inboundId: Number(inbound.id),
      online: null,
      country: null,
      masked: false,
    });
    const host = hosts.get(hostId);
    const status: TopologyStatus = !truthy(inbound.isEnabled, true) ? "stopped" : host && !truthy(host.isOnline) ? "failed" : "running";
    addEdge("subscription", from, to, {}, { status, port: port || null, protocol });
    for (const ruleId of landingRulesByInbound.get(Number(inbound.id)) || []) {
      addEdge("subscription", from, to, {}, { ruleId });
    }
  }

  // ── 收尾：边算状态，节点记谁用了它 ──
  const edgeList: TopologyEdge[] = Array.from(edges.values())
    .map((edge) => {
      const latency = edge.latencies.length > 0
        ? Math.round(edge.latencies.reduce((sum, value) => sum + value, 0) / edge.latencies.length)
        : null;
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        ruleIds: Array.from(edge.ruleIds).sort((a, b) => a - b),
        tunnelId: edge.tunnelId,
        groupId: edge.groupId,
        pathKeys: Array.from(edge.pathKeys).sort(),
        protocol: edge.protocols.size === 0 ? null : edge.protocols.size === 1 ? Array.from(edge.protocols)[0] : "mixed",
        port: edge.ports.size === 1 ? Array.from(edge.ports)[0] : null,
        status: mergeTopologyStatuses(edge.statuses),
        latencyMs: latency,
        label: edge.labels.size > 0 ? Array.from(edge.labels).sort().join(" / ") : null,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const edge of edgeList) {
    for (const nodeId of [edge.from, edge.to]) {
      const node = nodes.get(nodeId);
      if (!node) continue;
      for (const ruleId of edge.ruleIds) node.ruleSet.add(ruleId);
      if (edge.tunnelId) node.tunnelSet.add(edge.tunnelId);
      if (edge.groupId) node.groupSet.add(edge.groupId);
    }
  }
  const usedNodeIds = new Set(edgeList.flatMap((edge) => [edge.from, edge.to]));
  const nodeList: TopologyNode[] = Array.from(nodes.values())
    .filter((node) => usedNodeIds.has(node.id))
    .map(({ ruleSet, tunnelSet, groupSet, ...node }) => ({
      ...node,
      ruleIds: Array.from(ruleSet).sort((a, b) => a - b),
      tunnelIds: Array.from(tunnelSet).sort((a, b) => a - b),
      groupIds: Array.from(groupSet).sort((a, b) => a - b),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const rules: TopologyRuleRef[] = Array.from(ruleRefs.values())
    .map(({ statuses, ...ref }) => ({ ...ref, status: mergeTopologyStatuses(statuses) }))
    .sort((left, right) => left.id - right.id);
  const tunnels: TopologyTunnelRef[] = Array.from(includedTunnelIds)
    .map((id) => tunnelById.get(id))
    .filter((tunnel): tunnel is TopologyTunnelRow => !!tunnel)
    .map((tunnel) => ({
      id: Number(tunnel.id),
      name: text(tunnel.name) || `隧道 ${tunnel.id}`,
      userId: Number(tunnel.userId) || 0,
      mode: text(tunnel.mode) || "tls",
      status: topologyTunnelStatus(tunnel),
      latencyMs: tunnel.lastLatencyMs === null || tunnel.lastLatencyMs === undefined || tunnel.lastLatencyMs === "" ? null : Number(tunnel.lastLatencyMs),
    }))
    .sort((left, right) => left.id - right.id);
  const groups: TopologyGroupRef[] = Array.from(includedGroupIds)
    .map((id) => groupById.get(id))
    .filter((group): group is TopologyGroupRow => !!group)
    .map((group) => ({
      id: Number(group.id),
      name: text(group.name) || `组 ${group.id}`,
      userId: Number(group.userId) || 0,
      groupMode: text(group.groupMode) || "failover",
      status: topologyGroupStatus(group),
      domain: text(group.domain) || null,
    }))
    .sort((left, right) => left.id - right.id);

  return { nodes: nodeList, edges: edgeList, rules, tunnels, groups };
}
