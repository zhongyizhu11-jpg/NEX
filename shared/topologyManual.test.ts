import assert from "node:assert/strict";
import test from "node:test";

import type { TopologyGraph, TopologyNode } from "./networkTopology";
import { manualIdOf, mergeTopologyManual, parseTopologyManualRef, remapTopologyManualRef } from "./topologyManual";

function node(id: string, kind: TopologyNode["kind"], label: string): TopologyNode {
  return {
    id, kind, label, sublabel: null, hostId: kind === "host" ? Number(id.split(":")[1]) : null, groupId: null, inboundId: null, online: null, country: null,
    roles: { entry: kind === "host", relay: false, exit: false, landing: false }, masked: false, ruleIds: [], tunnelIds: [], groupIds: [],
  };
}

const graph: TopologyGraph = {
  nodes: [node("host:1", "host", "沪入口"), node("target:1.2.3.4:443", "target", "1.2.3.4:443")],
  edges: [],
  rules: [],
  tunnels: [],
  groups: [],
};

test("引用：manual / host / target 三种，别的都不认", () => {
  assert.deepEqual(parseTopologyManualRef("manual:3"), { type: "manual", id: 3 });
  assert.deepEqual(parseTopologyManualRef("host:12"), { type: "host", id: 12 });
  assert.deepEqual(parseTopologyManualRef("target:1.2.3.4:443"), { type: "target", key: "target:1.2.3.4:443" });
  assert.equal(parseTopologyManualRef("host:0"), null);
  assert.equal(parseTopologyManualRef("group:1"), null);
  assert.equal(parseTopologyManualRef("target:has space"), null);
  assert.equal(manualIdOf("manual:5", "manual:"), 5);
  assert.equal(manualIdOf("manual-link:5", "manual:"), null);
});

test("迁移重映射：主机、标注节点换成新 ID；那一头没导进来就丢掉这条线；目标原样", () => {
  const maps: Record<string, Map<number, number>> = { hosts: new Map([[5, 105]]), topology_manual_nodes: new Map([[3, 33]]) };
  const mapId = (table: "hosts" | "topology_manual_nodes", id: number) => maps[table].get(id) ?? null;
  assert.equal(remapTopologyManualRef("host:5", mapId), "host:105");
  assert.equal(remapTopologyManualRef("manual:3", mapId), "manual:33");
  assert.equal(remapTopologyManualRef("host:6", mapId), null);
  assert.equal(remapTopologyManualRef("target:example.com:443", mapId), "target:example.com:443");
  assert.equal(remapTopologyManualRef("garbage", mapId), null);
});

test("并进拓扑：外部节点 + 手动连线；图上没有的主机按可见列表补；引用不到的线不画", () => {
  const merged = mergeTopologyManual(graph, {
    nodes: [{ id: 3, label: "IPLC 日本端", note: "100M", country: "JP" }],
    links: [
      { id: 1, fromRef: "host:1", toRef: "manual:3", label: "IPLC", note: null },
      { id: 2, fromRef: "manual:3", toRef: "target:1.2.3.4:443", label: null, note: null },
      { id: 3, fromRef: "manual:3", toRef: "host:9", label: null, note: null },
      { id: 4, fromRef: "manual:3", toRef: "host:404", label: null, note: null },
      { id: 5, fromRef: "manual:99", toRef: "host:1", label: null, note: null },
    ],
  }, new Map([[9, { name: "东京落地", address: "203.0.113.9", online: true, country: "JP" }]]));
  const external = merged.nodes.find((item) => item.id === "manual:3");
  assert.equal(external?.kind, "external");
  assert.equal(external?.sublabel, "100M");
  assert.equal(external?.country, "JP");
  assert.ok(merged.nodes.some((item) => item.id === "host:9" && item.label === "东京落地"), "看得见的主机补上节点");
  assert.deepEqual(merged.edges.map((edge) => edge.id), ["manual-link:1", "manual-link:2", "manual-link:3"]);
  assert.ok(merged.edges.every((edge) => edge.kind === "manual" && edge.ruleIds.length === 0 && edge.latencyMs === null));
  assert.equal(merged.edges[0].label, "IPLC");
  // 原图不动
  assert.equal(graph.nodes.length, 2);
  assert.equal(mergeTopologyManual(graph, { nodes: [], links: [] }, new Map()), graph);
});
