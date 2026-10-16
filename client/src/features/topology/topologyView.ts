import type {
  TopologyEdge,
  TopologyEdgeKind,
  TopologyGraph,
  TopologyNode,
  TopologyRole,
  TopologyStatus,
} from "@shared/networkTopology";

/*
  拓扑页的「看什么」：筛选（连线种类、要不要外部目标、搜索）和聚焦（一条规则 / 隧道 / 组的路径）。
  都是纯函数，页面只负责把结果画出来。
*/

export const TOPOLOGY_EDGE_KINDS: readonly TopologyEdgeKind[] = ["rule", "tunnel", "chain", "routePath", "subscription", "group"];

export type TopologyFilters = {
  kinds: ReadonlySet<TopologyEdgeKind>;
  showTargets: boolean;
};

export type TopologyFocusType = "rule" | "tunnel" | "group";
export type TopologyFocus = { type: TopologyFocusType; id: number } | null;

/** 地址栏 ?rule=12 / ?tunnel=3 / ?group=5 → 聚焦。同时给了几个时按 rule、tunnel、group 的顺序取第一个。 */
export function parseTopologyFocus(search: string): TopologyFocus {
  const raw = String(search || "");
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return null;
  }
  for (const type of ["rule", "tunnel", "group"] as const) {
    const id = Math.floor(Number(params.get(type)));
    if (Number.isInteger(id) && id > 0) return { type, id };
  }
  return null;
}

export function topologyFocusHref(focus: TopologyFocus) {
  return focus ? `/topology?${focus.type}=${focus.id}` : "/topology";
}

/** 按连线种类和「显示外部目标」筛：被筛掉连线的节点、孤立下来的节点一起去掉。 */
export function filterTopology(graph: Pick<TopologyGraph, "nodes" | "edges">, filters: TopologyFilters): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges.filter((edge) => {
    if (!filters.kinds.has(edge.kind)) return false;
    if (!filters.showTargets && nodeById.get(edge.to)?.kind === "target") return false;
    return nodeById.has(edge.from) && nodeById.has(edge.to);
  });
  const used = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  return { nodes: graph.nodes.filter((node) => used.has(node.id)), edges };
}

/** 聚焦一条规则 / 隧道 / 组：它经过的边和节点。认不出时返回 null（不聚焦）。 */
export function topologyFocusSets(graph: Pick<TopologyGraph, "edges" | "rules">, focus: TopologyFocus): { edgeIds: Set<string>; nodeIds: Set<string> } | null {
  if (!focus) return null;
  let relatedRules = new Set<number>();
  if (focus.type === "rule") relatedRules = new Set([focus.id]);
  if (focus.type === "tunnel") relatedRules = new Set(graph.rules.filter((rule) => rule.tunnelId === focus.id).map((rule) => rule.id));
  if (focus.type === "group") relatedRules = new Set(graph.rules.filter((rule) => rule.groupId === focus.id).map((rule) => rule.id));
  const edgeIds = new Set<string>();
  const nodeIds = new Set<string>();
  for (const edge of graph.edges) {
    const direct = (focus.type === "tunnel" && edge.tunnelId === focus.id) || (focus.type === "group" && edge.groupId === focus.id);
    const viaRule = edge.ruleIds.some((id) => relatedRules.has(id));
    if (!direct && !viaRule) continue;
    edgeIds.add(edge.id);
    nodeIds.add(edge.from);
    nodeIds.add(edge.to);
  }
  return edgeIds.size > 0 ? { edgeIds, nodeIds } : null;
}

/** 搜索：节点名、地址，或者经过它的规则名 / 端口。空串返回 null（不过滤）。 */
export function topologySearchMatches(graph: Pick<TopologyGraph, "nodes" | "rules">, query: string): Set<string> | null {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const ruleText = new Map(graph.rules.map((rule) => [rule.id, `${rule.name} ${rule.sourcePort ?? ""} ${rule.target}`.toLowerCase()]));
  const matches = new Set<string>();
  for (const node of graph.nodes) {
    const haystack = [node.label, node.sublabel || "", node.country || "", ...node.ruleIds.map((id) => ruleText.get(id) || "")].join(" ").toLowerCase();
    if (tokens.every((token) => haystack.includes(token))) matches.add(node.id);
  }
  return matches;
}

/** 连线粗细：一条规则 1.6px，条数越多越粗，封顶 6px（按对数长，几百条也不会糊成一片）。 */
export function topologyEdgeWidth(ruleCount: number) {
  const count = Math.max(0, Math.floor(ruleCount));
  return Math.round((1.6 + Math.min(4.4, Math.log2(1 + count) * 1.1)) * 10) / 10;
}

/** 节点主色按哪个角色：入口 > 中转 > 出口 > 落地；不是主机的按种类。 */
export function topologyNodeTone(node: Pick<TopologyNode, "kind" | "roles" | "masked">): "entry" | "relay" | "exit" | "landing" | "target" | "inbound" | "group" | "masked" | "idle" {
  if (node.kind === "target") return "target";
  if (node.kind === "inbound") return "inbound";
  if (node.kind === "group") return "group";
  if (node.masked) return "masked";
  const order: TopologyRole[] = ["entry", "relay", "exit", "landing"];
  return order.find((role) => node.roles[role]) || "idle";
}

export function topologyRoleText(node: Pick<TopologyNode, "kind" | "roles">) {
  if (node.kind === "target") return "外部目标";
  if (node.kind === "inbound") return "落地入站";
  if (node.kind === "group") return "入口组 / 转发组";
  const labels: Record<TopologyRole, string> = { entry: "入口", relay: "中转", exit: "出口", landing: "落地" };
  const roles = (Object.keys(labels) as TopologyRole[]).filter((role) => node.roles[role]).map((role) => labels[role]);
  return roles.length > 0 ? roles.join(" · ") : "主机";
}

export function topologyStatusCounts(edges: readonly Pick<TopologyEdge, "status">[]) {
  const counts: Record<TopologyStatus, number> = { running: 0, stopped: 0, degraded: 0, failed: 0 };
  for (const edge of edges) counts[edge.status] += 1;
  return counts;
}
