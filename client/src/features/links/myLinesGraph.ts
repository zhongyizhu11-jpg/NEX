import type { TopologyEdge, TopologyEdgeKind, TopologyNode, TopologyNodeKind, TopologyRole, TopologyStatus } from "@shared/networkTopology";
import type { LineHop, LineModel } from "./myLines";

/*
  网络拓扑 › 我的线路：所有线路画在一张图上（和拓扑图同一张画布、同一套分列布局，TopologyCanvas）。

  每条线路是一串 入口 → 中转… → 落地 →（出口）。同一台主机、同一个组、同一个落地在几条线路里只画一个节点
  （LineHop.nodeId），几条线路走的同一段（同一对节点、同一种转发）合成一条连线，经过它的线路都记在连线上，
  点开看是哪几条。纯函数，不碰 DOM。

  一段的状态先按每条线路自己算：
    · 线路停用 → 停了（画虚线、变淡）；
    · 这一段有单独探测：不通 → 不通；测到了 → 通，延迟骑在线上；
    · 只有一段（入口直连落地）：端到端探测就是这一段；
    · 两头有主机离线 → 不通；
    · 整条线不通、又不知道断在哪一段 → 这一段降级（黄），点开看是哪条线；
    · 其余 → 通。
  几条线路合在一条连线上时取最差的那个（停了的不算，全停了才是停了）：图上有颜色就说明经过这里的线路里
  至少有一条有问题。延迟取几条里测到的最小值，此刻速率相加。
*/

export type MyLinesNodeLayoutKind = "host" | "group" | "landing" | "exit";

export type MyLinesGraph = {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** 布局用的种类：落地一列、出口再一列，都排在最右边（MY_LINES_TERMINAL_TIERS）。 */
  layoutKind: Map<string, MyLinesNodeLayoutKind>;
  /** 节点第二行写什么：角色（入口 · 中转…）、落地地址。 */
  captions: Map<string, string>;
  /** 每条线路经过的节点和连线：点一条线路时把它高亮出来。 */
  pathByLine: Map<number, { nodeIds: Set<string>; edgeIds: Set<string> }>;
};

export const MY_LINES_TERMINAL_TIERS: readonly (readonly MyLinesNodeLayoutKind[])[] = [["landing"], ["exit"]];

/** 「我的线路」那张图的格子尺寸（电脑上）：比拓扑图窄一点。 */
export const MY_LINES_LAYOUT = { nodeWidth: 140, nodeHeight: 46, columnGap: 56, rowGap: 12, margin: 12 } as const;
/**
 * 手机上（画布窄于 640）用的紧凑格子，字也小一号（TopologyCanvas 的 compact）：
 * 入口 / 中转 / 落地 / 出口四列宽 552，手机上 0.63 倍就整张放下，一眼看完。
 */
export const MY_LINES_LAYOUT_COMPACT = { nodeWidth: 104, nodeHeight: 40, columnGap: 40, rowGap: 8, margin: 8 } as const;
/** 画布顶上留给列标题（入口 / 中转 / 落地）的高度。 */
export const MY_LINES_LABEL_BAND = 22;
/** 整张图放下不小于这个倍数就整张放下；再小（线路特别多）就按这个倍数放，上下拖着看。 */
export const MY_LINES_MIN_SCALE = 0.45;

export function myLinesLayoutFor(containerWidth: number) {
  return containerWidth > 0 && containerWidth < 640 ? MY_LINES_LAYOUT_COMPACT : MY_LINES_LAYOUT;
}

/**
 * 画布多高：按宽度整张放下（太宽就按 MY_LINES_MIN_SCALE）时图有多高就多高，上下不空一大块，
 * 夹在 180 和 maxHeight 之间。手机上 maxHeight 给得很大：画布和图一样高，整张图都在页面里，划页面就看完。
 */
export function myLinesCanvasHeight(layout: { width: number; height: number }, containerWidth: number, maxHeight: number) {
  if (containerWidth <= 0 || layout.width <= 0) return Math.round(Math.min(maxHeight, Math.max(180, layout.height * 0.72 + 48)));
  const scale = Math.min(1.25, Math.max(MY_LINES_MIN_SCALE, (containerWidth - 16) / layout.width));
  return Math.round(Math.min(maxHeight, Math.max(180, layout.height * scale + 16 + MY_LINES_LABEL_BAND)));
}

const EDGE_KIND: Record<LineModel["kind"], TopologyEdgeKind> = {
  local: "rule",
  tunnel: "tunnel",
  chain: "chain",
  group: "group",
  route: "routePath",
};

const STATUS_RANK: Record<TopologyStatus, number> = { stopped: 0, running: 1, degraded: 2, failed: 3 };
const ROLE_LABELS: Record<TopologyRole, string> = { entry: "入口", relay: "中转", exit: "出口", landing: "落地" };
const ROLE_ORDER: TopologyRole[] = ["entry", "relay", "exit", "landing"];

type Step = { hop: LineHop; role: TopologyRole; layoutKind: MyLinesNodeLayoutKind };

/** 一条线路从头到尾的几站，每站带上它在这条线里的角色。 */
function lineSteps(line: LineModel): Step[] {
  const steps: Step[] = [{ hop: line.entry, role: "entry", layoutKind: line.entry.nodeId.startsWith("group:") ? "group" : "host" }];
  for (const hop of line.hops) {
    // 隧道的最后一跳是隧道出口（buildLineModel 写成「出口 · …」），别的经过的都是中转
    steps.push({ hop, role: hop.caption.startsWith("出口") ? "exit" : "relay", layoutKind: "host" });
  }
  steps.push({ hop: line.landing, role: "landing", layoutKind: "landing" });
  if (line.exit) steps.push({ hop: line.exit, role: "exit", layoutKind: "exit" });
  return steps;
}

function nodeKindOf(step: Step): TopologyNodeKind {
  if (step.layoutKind === "group") return "group";
  if (step.layoutKind === "landing") return step.hop.nodeId.startsWith("node:") ? "inbound" : "target";
  if (step.layoutKind === "exit") return "inbound";
  return "host";
}

/** 这一站此刻在不在（图上那颗点）：主机看在线；落地、出口看这条线探得通不通。 */
function onlineOf(step: Step): boolean | null {
  if (step.hop.online !== undefined && step.hop.online !== null) return step.hop.online;
  if (step.hop.health === "down") return false;
  if (step.hop.health === "healthy") return true;
  if (step.layoutKind === "exit" && step.hop.health === "degraded") return false;
  return null;
}

/** 一条线路自己这一段（steps[index] → steps[index + 1]）的状态和延迟。 */
function segmentOf(line: LineModel, steps: Step[], index: number): { status: TopologyStatus; latencyMs: number | null } {
  if (!line.enabled || line.health === "standby") return { status: "stopped", latencyMs: null };
  const to = steps[index + 1].hop;
  // 落地 → 出口：看出口自己的状态（Shadowsocks 出口在不在跑），不单独探
  if (steps[index + 1].layoutKind === "exit") {
    if (to.health === "standby") return { status: "stopped", latencyMs: null };
    if (to.health === "degraded" || to.health === "down") return { status: "degraded", latencyMs: null };
    return { status: "running", latencyMs: null };
  }
  const own = line.segments[index];
  if (own?.state === "failed") return { status: "failed", latencyMs: null };
  if (own?.state === "measured" && own.latencyMs !== null) return { status: "running", latencyMs: own.latencyMs };
  const toLanding = steps.length - (line.exit ? 2 : 1);
  if (toLanding === 1 && line.probe) {
    // 入口直连落地：端到端探测就是这一段
    if (line.probe.isTimeout && line.health === "down") return { status: "failed", latencyMs: null };
    if (line.probe.latencyMs !== null && line.health === "healthy") return { status: "running", latencyMs: line.probe.latencyMs };
  }
  const hostDown = (step: Step) => step.layoutKind !== "landing" && step.layoutKind !== "exit" && (step.hop.online === false || step.hop.health === "down");
  if (hostDown(steps[index]) || hostDown(steps[index + 1])) return { status: "failed", latencyMs: null };
  // 整条线不通，但哪台主机都没离线：不知道断在哪一段，这条线的每段都标黄（知道是哪台离线时只标挨着它的两段）
  if (line.health === "down" && !steps.some(hostDown)) return { status: "degraded", latencyMs: null };
  return { status: "running", latencyMs: null };
}

function lineRateBps(line: LineModel) {
  return line.rate ? Math.max(0, (line.rate.inBps || 0) + (line.rate.outBps || 0)) : 0;
}

/** 合并后节点第二行：角色（入口 · 中转…），落地写地址，主机离线了补一句。 */
function captionOf(node: { roles: Set<TopologyRole>; steps: Step[] }): string {
  const first = node.steps[0];
  if (first.layoutKind === "landing") {
    const address = first.hop.caption.replace(/^我的节点 · /, "");
    return first.hop.nodeId.startsWith("node:") ? `落地 · ${address}` : "落地";
  }
  if (first.layoutKind === "exit" || first.layoutKind === "group") return first.hop.caption;
  const roles = ROLE_ORDER.filter((role) => node.roles.has(role)).map((role) => ROLE_LABELS[role]).join(" · ");
  return first.hop.online === false ? `${roles} · 离线` : roles;
}

export function buildMyLinesGraph(lines: readonly LineModel[]): MyLinesGraph {
  type NodeAcc = { id: string; steps: Step[]; roles: Set<TopologyRole>; ruleIds: Set<number>; online: boolean | null };
  type EdgeAcc = { id: string; from: string; to: string; kind: TopologyEdgeKind; ruleIds: Set<number>; status: TopologyStatus | null; latencyMs: number | null; rateBps: number };
  const nodes = new Map<string, NodeAcc>();
  const edges = new Map<string, EdgeAcc>();
  const pathByLine = new Map<number, { nodeIds: Set<string>; edgeIds: Set<string> }>();

  for (const line of lines) {
    const steps = lineSteps(line);
    const path = { nodeIds: new Set<string>(), edgeIds: new Set<string>() };
    pathByLine.set(line.id, path);
    for (const step of steps) {
      const id = step.hop.nodeId;
      let node = nodes.get(id);
      if (!node) {
        node = { id, steps: [], roles: new Set(), ruleIds: new Set(), online: null };
        nodes.set(id, node);
      }
      node.steps.push(step);
      node.roles.add(step.role);
      node.ruleIds.add(line.id);
      // 落地这类几条线一起看的：有一条探得通就算在；都不通才算不在
      const online = onlineOf(step);
      if (online === true) node.online = true;
      else if (online === false && node.online === null) node.online = false;
      path.nodeIds.add(id);
    }
    for (let index = 0; index < steps.length - 1; index += 1) {
      const from = steps[index].hop.nodeId;
      const to = steps[index + 1].hop.nodeId;
      if (from === to) continue;
      const kind = EDGE_KIND[line.kind];
      const id = `${from}>${to}>${kind}`;
      let edge = edges.get(id);
      if (!edge) {
        edge = { id, from, to, kind, ruleIds: new Set(), status: null, latencyMs: null, rateBps: 0 };
        edges.set(id, edge);
      }
      const segment = segmentOf(line, steps, index);
      edge.ruleIds.add(line.id);
      if (segment.status !== "stopped" && (edge.status === null || edge.status === "stopped" || STATUS_RANK[segment.status] > STATUS_RANK[edge.status])) {
        edge.status = segment.status;
      } else if (edge.status === null) {
        edge.status = segment.status;
      }
      if (segment.latencyMs !== null) edge.latencyMs = edge.latencyMs === null ? segment.latencyMs : Math.min(edge.latencyMs, segment.latencyMs);
      edge.rateBps += lineRateBps(line);
      path.edgeIds.add(id);
    }
  }

  const layoutKind = new Map<string, MyLinesNodeLayoutKind>();
  const captions = new Map<string, string>();
  const nodeList: TopologyNode[] = Array.from(nodes.values()).map((node) => {
    const first = node.steps[0];
    layoutKind.set(node.id, first.layoutKind);
    captions.set(node.id, captionOf(node));
    const hostMatch = /^host:(\d+)$/.exec(node.id);
    const groupMatch = /^group:(\d+)$/.exec(node.id);
    const landingName = first.layoutKind === "landing" && !first.hop.nodeId.startsWith("node:")
      ? first.hop.caption || first.hop.name
      : first.hop.name;
    return {
      id: node.id,
      kind: nodeKindOf(first),
      label: landingName,
      sublabel: captions.get(node.id) || null,
      hostId: hostMatch ? Number(hostMatch[1]) : null,
      groupId: groupMatch ? Number(groupMatch[1]) : null,
      inboundId: null,
      online: node.online,
      country: first.hop.country || null,
      roles: { entry: node.roles.has("entry"), relay: node.roles.has("relay"), exit: node.roles.has("exit"), landing: node.roles.has("landing") },
      masked: false,
      ruleIds: Array.from(node.ruleIds).sort((left, right) => left - right),
      tunnelIds: [],
      groupIds: groupMatch ? [Number(groupMatch[1])] : [],
    };
  });
  const edgeList: TopologyEdge[] = Array.from(edges.values()).map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    ruleIds: Array.from(edge.ruleIds).sort((left, right) => left - right),
    tunnelId: null,
    groupId: null,
    pathKeys: [],
    protocol: null,
    port: null,
    status: edge.status ?? "running",
    latencyMs: edge.latencyMs,
    label: null,
    activePath: null,
    rateBps: edge.rateBps > 0 ? edge.rateBps : null,
  }));
  return { nodes: nodeList, edges: edgeList, layoutKind, captions, pathByLine };
}

/** 列标题：第一列入口，落地、出口各自那列，中间的是中转（不止一列时写「中转 2」…）。 */
export function myLinesColumnLabels(layers: readonly string[][], layoutKind: ReadonlyMap<string, MyLinesNodeLayoutKind>): string[] {
  let relays = 0;
  return layers.map((column, index) => {
    if (column.length === 0) return "";
    const kinds = column.map((id) => layoutKind.get(id) || "host");
    if (kinds.every((kind) => kind === "landing")) return "落地";
    if (kinds.every((kind) => kind === "exit")) return "出口";
    if (index === 0) return "入口";
    relays += 1;
    return relays === 1 ? "中转" : `中转 ${relays}`;
  });
}

/** 线路按要紧程度排：不通的最前，再是有问题 / 没测过的，正常的，停用的最后；同一档按名字。 */
export function sortLinesForList(lines: readonly LineModel[]): LineModel[] {
  const rank = (line: LineModel) => (line.health === "down" ? 0 : line.health === "degraded" ? 1 : line.health === "unknown" ? 2 : line.health === "healthy" ? 3 : 4);
  return [...lines].sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name, "zh-CN") || left.id - right.id);
}
