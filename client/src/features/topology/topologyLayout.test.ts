import assert from "node:assert/strict";
import test from "node:test";
import { layoutTopology, topologyColumnLabels } from "./topologyLayout";

/*
  分层布局：列号按「流量先后」，目标永远在最后一列；同一列里不重叠；结果完全确定（输入顺序打乱也一样）。
*/

const nodes = [
  { id: "host:1", kind: "host" },
  { id: "host:2", kind: "host" },
  { id: "host:3", kind: "host" },
  { id: "host:4", kind: "host" },
  { id: "target:a:443", kind: "target" },
  { id: "target:b:80", kind: "target" },
  { id: "inbound:9", kind: "inbound" },
  { id: "group:7", kind: "group" },
];
const edges = [
  { from: "group:7", to: "host:1" },
  { from: "host:1", to: "host:3" },
  { from: "host:3", to: "host:2" },
  { from: "host:2", to: "target:a:443" },
  { from: "host:1", to: "target:b:80" },
  { from: "host:4", to: "host:2" },
  { from: "host:2", to: "inbound:9" },
];

test("列号：上游在前，目标和入站统一在最后一列", () => {
  const layout = layoutTopology(nodes, edges);
  const layer = (id: string) => layout.nodes.get(id)!.layer;
  assert.equal(layer("group:7"), 0);
  assert.equal(layer("host:4"), 0, "没有上游的入口在第一列");
  assert.equal(layer("host:1"), 1);
  assert.equal(layer("host:3"), 2);
  assert.equal(layer("host:2"), 3);
  assert.equal(layer("target:a:443"), 4);
  assert.equal(layer("target:b:80"), 4, "直连的目标也推到最后一列");
  assert.equal(layer("inbound:9"), 4);
  assert.equal(layout.layers.length, 5);
});

test("同一列不重叠，所有节点都在画布里", () => {
  const layout = layoutTopology(nodes, edges);
  const boxes = Array.from(layout.nodes.values());
  for (const a of boxes) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.width <= layout.width && a.y + a.height <= layout.height, `${a.id} 越界`);
    for (const b of boxes) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      assert.equal(overlap, false, `${a.id} 和 ${b.id} 重叠`);
    }
  }
});

test("结果确定：输入顺序打乱，布局不变", () => {
  const first = layoutTopology(nodes, edges);
  const second = layoutTopology([...nodes].reverse(), [...edges].reverse());
  assert.deepEqual(Array.from(second.nodes.entries()).sort(), Array.from(first.nodes.entries()).sort());
  assert.deepEqual(second.layers, first.layers);
});

test("有环也能排：回边记下来，不会死循环", () => {
  const layout = layoutTopology(
    [{ id: "a", kind: "host" }, { id: "b", kind: "host" }, { id: "c", kind: "target" }],
    [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "b", to: "c" }],
  );
  assert.equal(layout.nodes.get("a")!.layer, 0);
  assert.equal(layout.nodes.get("b")!.layer, 1);
  assert.equal(layout.nodes.get("c")!.layer, 2);
  assert.ok(layout.backEdges.has("b>a"));
});

test("重心排序：连向同一下游的节点挨在一起，少交叉", () => {
  const layout = layoutTopology(
    [
      { id: "e1", kind: "host" }, { id: "e2", kind: "host" }, { id: "e3", kind: "host" },
      { id: "x", kind: "host" }, { id: "y", kind: "host" },
      { id: "t", kind: "target" },
    ],
    [{ from: "e1", to: "y" }, { from: "e2", to: "x" }, { from: "e3", to: "y" }, { from: "x", to: "t" }, { from: "y", to: "t" }],
  );
  const order = (id: string) => layout.nodes.get(id)!.order;
  // e2 只连 x，e1/e3 连 y：x 应在 e2 那一侧
  assert.equal(Math.abs(order("e1") - order("e3")) <= 2, true);
  assert.notEqual(order("x"), order("y"));
});

test("列标题：入口、中转、出口 / 落地、目标", () => {
  const roles: Record<string, any> = {
    "group:7": { kind: "group" },
    "host:1": { kind: "host", roles: { entry: true } },
    "host:4": { kind: "host", roles: { entry: true } },
    "host:3": { kind: "host", roles: { relay: true } },
    "host:2": { kind: "host", roles: { exit: true, landing: true } },
  };
  const layout = layoutTopology(nodes, edges);
  const labels = topologyColumnLabels(layout.layers, (id) => roles[id] || { kind: id.startsWith("target") ? "target" : "inbound" });
  assert.deepEqual(labels, ["入口", "入口", "中转", "出口 / 落地", "目标"]);
});

test("空图", () => {
  const layout = layoutTopology([], []);
  assert.equal(layout.nodes.size, 0);
  assert.equal(layout.layers.length, 0);
});
