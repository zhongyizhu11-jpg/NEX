import type { TopologyEdge, TopologyGraph, TopologyNode } from "./networkTopology";

/*
  网络拓扑的手动标注：用户自己在图上画上没装 Agent 的外部节点（比如一条 IPLC / IEPL 专线的两端、
  上游机房），以及它们和已有主机 / 外部目标之间的连线。

  只是给人看的：不进任何配置、不下发给 Agent、不参与探测和调度。每个账号各画各的
  （topology_manual_nodes / topology_manual_links，见 server/ops/topologyManualTables.ts），
  跟着面板备份 / 迁移走，导入时用户、主机、标注节点的 ID 重新映射（server/migration.ts）。

  连线两头用一个字符串引用：
    manual:<id>   自己画的外部节点
    host:<id>     一台主机（要是这个用户看得见的）
    target:<…>    图上已有的外部目标（就是拓扑图里那个节点的 id，按「地址:端口」）
*/

export const TOPOLOGY_MANUAL_LIMITS = { nodes: 100, links: 300, label: 64, note: 300 } as const;

export type TopologyManualNodeRow = { id: number; label: string; note: string | null; country: string | null };
export type TopologyManualLinkRow = { id: number; fromRef: string; toRef: string; label: string | null; note: string | null };

export type TopologyManualRef =
  | { type: "manual"; id: number }
  | { type: "host"; id: number }
  | { type: "target"; key: string };

export function manualNodeId(id: number) {
  return `manual:${id}`;
}

export function manualLinkEdgeId(id: number) {
  return `manual-link:${id}`;
}

/** 认得出的引用才返回；target 只认拓扑图那种 target:地址:端口 的写法，长度有上限。 */
export function parseTopologyManualRef(value: unknown): TopologyManualRef | null {
  const text = String(value ?? "").trim();
  const numeric = text.match(/^(manual|host):(\d{1,10})$/);
  if (numeric) {
    const id = Number(numeric[2]);
    return Number.isSafeInteger(id) && id > 0 ? { type: numeric[1] as "manual" | "host", id } : null;
  }
  if (/^target:[^\s]{1,160}$/.test(text)) return { type: "target", key: text };
  return null;
}

export function formatTopologyManualRef(ref: TopologyManualRef) {
  return ref.type === "target" ? ref.key : `${ref.type}:${ref.id}`;
}

/** 迁移导入时把引用里的 ID 换成新库的；对应的那一行没导进来就是 null（这条线丢掉）。 */
export function remapTopologyManualRef(value: unknown, mapId: (table: "hosts" | "topology_manual_nodes", id: number) => number | null): string | null {
  const ref = parseTopologyManualRef(value);
  if (!ref) return null;
  if (ref.type === "target") return ref.key;
  const mapped = mapId(ref.type === "host" ? "hosts" : "topology_manual_nodes", ref.id);
  return mapped ? `${ref.type}:${mapped}` : null;
}

export type TopologyManualHost = { name: string; address: string | null; online: boolean | null; country: string | null };

function emptyNode(id: string, kind: TopologyNode["kind"], label: string): TopologyNode {
  return {
    id, kind, label, sublabel: null, hostId: null, groupId: null, inboundId: null, online: null, country: null,
    roles: { entry: false, relay: false, exit: false, landing: false }, masked: false, ruleIds: [], tunnelIds: [], groupIds: [],
  };
}

/**
 * 把手动标注并进拓扑图：外部节点 kind = "external"，连线 kind = "manual"（虚线、不带状态和延迟）。
 * 主机那一头不在图上（它没跑任何转发）但用户看得见时，从 visibleHosts 补一个主机节点；
 * 引用的节点不存在（主机删了、目标规则改了）这条线就不画，不报错。
 */
export function mergeTopologyManual(
  graph: TopologyGraph,
  manual: { nodes: readonly TopologyManualNodeRow[]; links: readonly TopologyManualLinkRow[] },
  visibleHosts: ReadonlyMap<number, TopologyManualHost>,
): TopologyGraph {
  if (manual.nodes.length === 0 && manual.links.length === 0) return graph;
  const nodes = [...graph.nodes];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const add = (node: TopologyNode) => {
    if (byId.has(node.id)) return;
    byId.set(node.id, node);
    nodes.push(node);
  };
  for (const row of manual.nodes) {
    add({
      ...emptyNode(manualNodeId(row.id), "external", row.label || `外部节点 ${row.id}`),
      sublabel: row.note || "手动标注",
      country: row.country || null,
    });
  }
  const resolve = (value: string): string | null => {
    const ref = parseTopologyManualRef(value);
    if (!ref) return null;
    if (ref.type === "manual") return byId.has(manualNodeId(ref.id)) ? manualNodeId(ref.id) : null;
    if (ref.type === "target") return byId.has(ref.key) ? ref.key : null;
    const id = `host:${ref.id}`;
    if (byId.has(id)) return id;
    const host = visibleHosts.get(ref.id);
    if (!host) return null;
    add({ ...emptyNode(id, "host", host.name || `主机 ${ref.id}`), hostId: ref.id, sublabel: host.address, online: host.online, country: host.country });
    return id;
  };
  const edges: TopologyEdge[] = [...graph.edges];
  for (const link of manual.links) {
    const from = resolve(link.fromRef);
    const to = resolve(link.toRef);
    if (!from || !to || from === to) continue;
    edges.push({
      id: manualLinkEdgeId(link.id),
      from,
      to,
      kind: "manual",
      ruleIds: [],
      tunnelId: null,
      groupId: null,
      pathKeys: [],
      protocol: null,
      port: null,
      status: "running",
      latencyMs: null,
      label: link.label || null,
      activePath: null,
      rateBps: null,
    });
  }
  return { ...graph, nodes, edges };
}

export function isManualTopologyNode(node: Pick<TopologyNode, "id" | "kind">) {
  return node.kind === "external" || node.id.startsWith("manual:");
}

export function manualIdOf(value: string, prefix: "manual:" | "manual-link:"): number | null {
  if (!value.startsWith(prefix)) return null;
  const id = Number(value.slice(prefix.length));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
