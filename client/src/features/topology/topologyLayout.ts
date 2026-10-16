/**
 * 网络拓扑图的分层布局（从左到右）：入口 → 中转… → 出口 / 落地 → 目标。
 *
 * 图基本上是一张有向无环图（流量只往前走），分层就够了，不需要通用的力导向布局：
 *   1. 去环：按 id 顺序做一遍深度优先，回边只在分层时忽略（照样画出来，画成弯回去的弧）。
 *   2. 分层：最长路径 —— 每个节点放在它所有上游之后的那一列。外部目标和落地入站统一放到最后一列，
 *      「目标」永远在最右边。
 *   3. 列内排序：按上游（再按下游）位置的重心来回扫几遍，减少交叉；同分按 id，结果完全确定。
 *   4. 坐标：每列等宽，列内等距、竖直居中。同一列的节点之间留固定间距，不会重叠。
 *
 * 纯函数，不碰 DOM：测试直接断言列号、坐标和不重叠。
 */

export type LayoutNodeInput = { id: string; kind: string };
export type LayoutEdgeInput = { from: string; to: string };

export type LayoutOptions = {
  nodeWidth?: number;
  nodeHeight?: number;
  columnGap?: number;
  rowGap?: number;
  margin?: number;
  /** 排到最后一列的节点种类 */
  terminalKinds?: readonly string[];
  sweeps?: number;
};

export type LayoutNode = { id: string; x: number; y: number; layer: number; order: number; width: number; height: number };

export type TopologyLayout = {
  nodes: Map<string, LayoutNode>;
  layers: string[][];
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  /** 去环时被当成回边的边（from>to） */
  backEdges: Set<string>;
};

const DEFAULTS = {
  nodeWidth: 176,
  nodeHeight: 48,
  columnGap: 96,
  rowGap: 18,
  margin: 24,
  terminalKinds: ["target", "inbound"] as readonly string[],
  sweeps: 4,
};

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function edgeKey(from: string, to: string) {
  return `${from}>${to}`;
}

export function layoutTopology(nodesInput: readonly LayoutNodeInput[], edgesInput: readonly LayoutEdgeInput[], options: LayoutOptions = {}): TopologyLayout {
  const opts = { ...DEFAULTS, ...options };
  const nodeIds = Array.from(new Set(nodesInput.map((node) => node.id))).sort(compareIds);
  const kindById = new Map(nodesInput.map((node) => [node.id, node.kind]));
  const known = new Set(nodeIds);
  const terminal = new Set(nodeIds.filter((id) => opts.terminalKinds.includes(kindById.get(id) || "")));

  // 邻接表（去重、排序，保证遍历顺序确定）
  const outgoing = new Map<string, string[]>();
  const incomingAll = new Map<string, string[]>();
  for (const id of nodeIds) {
    outgoing.set(id, []);
    incomingAll.set(id, []);
  }
  const seenEdge = new Set<string>();
  for (const edge of edgesInput) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue;
    const key = edgeKey(edge.from, edge.to);
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    outgoing.get(edge.from)!.push(edge.to);
    incomingAll.get(edge.to)!.push(edge.from);
  }
  for (const list of outgoing.values()) list.sort(compareIds);
  for (const list of incomingAll.values()) list.sort(compareIds);

  // 1. 去环（迭代 DFS，免得长链把调用栈压爆）。终点节点没有出边，不会参与成环。
  const backEdges = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const sources = nodeIds.filter((id) => incomingAll.get(id)!.length === 0);
  const visitOrder = [...sources, ...nodeIds.filter((id) => !sources.includes(id))];
  for (const root of visitOrder) {
    if (state.get(root)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const children = outgoing.get(frame.id)!;
      if (frame.next >= children.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const child = children[frame.next++];
      const childState = state.get(child) || 0;
      if (childState === 1) backEdges.add(edgeKey(frame.id, child));
      else if (childState === 0) {
        state.set(child, 1);
        stack.push({ id: child, next: 0 });
      }
    }
  }
  const forwardOut = new Map<string, string[]>();
  const forwardIn = new Map<string, string[]>();
  for (const id of nodeIds) {
    forwardOut.set(id, outgoing.get(id)!.filter((to) => !backEdges.has(edgeKey(id, to))));
    forwardIn.set(id, []);
  }
  for (const [from, list] of forwardOut) for (const to of list) forwardIn.get(to)!.push(from);
  for (const list of forwardIn.values()) list.sort(compareIds);

  // 2. 分层：Kahn 拓扑序 + 最长路径。
  const layer = new Map<string, number>();
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, forwardIn.get(id)!.length);
  const queue = nodeIds.filter((id) => indegree.get(id) === 0);
  for (const id of queue) layer.set(id, 0);
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    for (const to of forwardOut.get(id)!) {
      layer.set(to, Math.max(layer.get(to) ?? 0, (layer.get(id) ?? 0) + 1));
      indegree.set(to, indegree.get(to)! - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  let lastInner = -1;
  for (const id of nodeIds) if (!terminal.has(id)) lastInner = Math.max(lastInner, layer.get(id) ?? 0);
  const terminalLayer = lastInner + 1;
  for (const id of terminal) layer.set(id, Math.max(terminalLayer, 0));
  const layerCount = nodeIds.length === 0 ? 0 : Math.max(...nodeIds.map((id) => layer.get(id) ?? 0)) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of nodeIds) layers[layer.get(id) ?? 0].push(id);

  // 3. 列内排序：重心法来回扫。
  const position = new Map<string, number>();
  const assignPositions = () => {
    for (const column of layers) column.forEach((id, index) => position.set(id, column.length > 1 ? index / (column.length - 1) : 0.5));
  };
  assignPositions();
  const barycenter = (neighbours: string[], fallback: number) => {
    const values = neighbours.map((id) => position.get(id)).filter((value): value is number => value !== undefined);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
  };
  for (let sweep = 0; sweep < opts.sweeps; sweep += 1) {
    const down = sweep % 2 === 0;
    const order = down ? layers.map((_, index) => index) : layers.map((_, index) => layers.length - 1 - index);
    for (const index of order) {
      const column = layers[index];
      const scored = column.map((id) => ({
        id,
        score: barycenter(down ? incomingAll.get(id)! : outgoing.get(id)!, position.get(id) ?? 0.5),
      }));
      scored.sort((left, right) => left.score - right.score || compareIds(left.id, right.id));
      layers[index] = scored.map((item) => item.id);
      layers[index].forEach((id, slot) => position.set(id, layers[index].length > 1 ? slot / (layers[index].length - 1) : 0.5));
    }
  }

  // 4. 坐标
  const tallest = Math.max(0, ...layers.map((column) => column.length));
  const pitch = opts.nodeHeight + opts.rowGap;
  const contentHeight = tallest > 0 ? tallest * pitch - opts.rowGap : 0;
  const nodes = new Map<string, LayoutNode>();
  layers.forEach((column, layerIndex) => {
    const columnHeight = column.length * pitch - opts.rowGap;
    const offset = (contentHeight - columnHeight) / 2;
    column.forEach((id, order) => {
      nodes.set(id, {
        id,
        layer: layerIndex,
        order,
        x: opts.margin + layerIndex * (opts.nodeWidth + opts.columnGap),
        y: opts.margin + offset + order * pitch,
        width: opts.nodeWidth,
        height: opts.nodeHeight,
      });
    });
  });
  const width = layerCount > 0 ? opts.margin * 2 + layerCount * opts.nodeWidth + (layerCount - 1) * opts.columnGap : opts.margin * 2;
  const height = opts.margin * 2 + contentHeight;
  return { nodes, layers, width, height, nodeWidth: opts.nodeWidth, nodeHeight: opts.nodeHeight, backEdges };
}

/** 每一列的标题：看这一列里大多数节点是什么角色。 */
export function topologyColumnLabels(
  layers: readonly string[][],
  describe: (id: string) => { kind: string; roles?: Partial<Record<"entry" | "relay" | "exit" | "landing", boolean>> },
): string[] {
  const relayCount = { value: 0 };
  return layers.map((column, index) => {
    const infos = column.map(describe);
    if (infos.length === 0) return "";
    if (infos.every((info) => info.kind === "target" || info.kind === "inbound")) return "目标";
    if (infos.every((info) => info.kind === "group")) return "入口组";
    const count = (role: "entry" | "relay" | "exit" | "landing") => infos.filter((info) => info.roles?.[role]).length;
    const entry = count("entry");
    const relay = count("relay");
    const exitLike = count("exit") + count("landing");
    if (index <= 1 && entry >= Math.max(relay, exitLike) && entry > 0) return "入口";
    if (exitLike > relay) return "出口 / 落地";
    relayCount.value += 1;
    return relayCount.value === 1 ? "中转" : `中转 ${relayCount.value}`;
  });
}
