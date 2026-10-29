import assert from "node:assert/strict";
import test from "node:test";
import { buildNetworkTopology } from "@shared/networkTopology";
import { filterTopology, parseTopologyFocus, topologyEdgeWidth, topologyFocusHref, topologyFocusSets, topologySearchMatches, TOPOLOGY_EDGE_KINDS } from "./topologyView";

const graph = buildNetworkTopology({
  hosts: [
    { id: 1, name: "HK", ip: "10.0.0.1", isOnline: true },
    { id: 2, name: "JP", ip: "10.0.0.2", isOnline: true },
  ],
  tunnels: [{ id: 5, name: "HK-JP", userId: 1, entryHostId: 1, exitHostId: 2, isEnabled: true, isRunning: true, hops: [], exitNodes: [] }],
  groups: [],
  rules: [
    { id: 1, name: "游戏", userId: 1, hostId: 1, sourcePort: 9000, targetIp: "game.example.com", targetPort: 25565, isEnabled: true, isRunning: true },
    { id: 2, name: "网站", userId: 1, hostId: 1, sourcePort: 8443, targetIp: "198.51.100.1", targetPort: 443, tunnelId: 5, isEnabled: true, isRunning: true },
  ] as any,
});

test("深链接 ?rule= / ?tunnel= / ?group=", () => {
  assert.deepEqual(parseTopologyFocus("?rule=12"), { type: "rule", id: 12 });
  assert.deepEqual(parseTopologyFocus("/topology?tunnel=3"), { type: "tunnel", id: 3 });
  assert.deepEqual(parseTopologyFocus("group=5&x=1"), { type: "group", id: 5 });
  assert.equal(parseTopologyFocus("?rule=abc"), null);
  assert.equal(parseTopologyFocus(""), null);
  assert.equal(topologyFocusHref({ type: "rule", id: 7 }), "/topology?rule=7");
  assert.equal(topologyFocusHref(null), "/topology");
});

test("隐藏外部目标：连向外部目标的边和孤立的目标节点一起去掉", () => {
  const all = filterTopology(graph, { kinds: new Set(TOPOLOGY_EDGE_KINDS), showTargets: true });
  const hidden = filterTopology(graph, { kinds: new Set(TOPOLOGY_EDGE_KINDS), showTargets: false });
  assert.ok(all.nodes.some((node) => node.kind === "target"));
  assert.equal(hidden.nodes.some((node) => node.kind === "target"), false);
  assert.ok(hidden.edges.every((edge) => edge.kind === "tunnel"));
});

test("按种类筛：只看隧道", () => {
  const only = filterTopology(graph, { kinds: new Set(["tunnel"] as const), showTargets: true });
  assert.ok(only.edges.length > 0);
  assert.ok(only.edges.every((edge) => edge.kind === "tunnel"));
  assert.deepEqual(only.nodes.map((node) => node.id).sort(), ["host:1", "host:2"]);
});

test("聚焦隧道：隧道那几段加上走它的规则的出口 → 目标", () => {
  const sets = topologyFocusSets(graph, { type: "tunnel", id: 5 })!;
  assert.ok(sets.nodeIds.has("target:198.51.100.1:443"));
  assert.equal(sets.nodeIds.has("target:game.example.com:25565"), false);
  const rule = topologyFocusSets(graph, { type: "rule", id: 1 })!;
  assert.deepEqual(Array.from(rule.nodeIds).sort(), ["host:1", "target:game.example.com:25565"]);
  assert.equal(topologyFocusSets(graph, { type: "rule", id: 999 }), null);
});

test("搜索：节点名、规则名、端口都能搜到", () => {
  assert.equal(topologySearchMatches(graph, ""), null);
  assert.ok(topologySearchMatches(graph, "jp")!.has("host:2"));
  assert.ok(topologySearchMatches(graph, "游戏")!.has("host:1"));
  assert.ok(topologySearchMatches(graph, "25565")!.has("target:game.example.com:25565"));
});

test("连线粗细随规则数变粗、有上限", () => {
  assert.equal(topologyEdgeWidth(0), 1.6);
  assert.ok(topologyEdgeWidth(3) > topologyEdgeWidth(1));
  assert.ok(topologyEdgeWidth(10_000) <= 6);
});

test("边上的药丸：有延迟写延迟，没延迟有流量写速率，停用不画", async () => {
  const { topologyEdgeBadge, formatEdgeRate } = await import("./TopologyCanvas");
  assert.equal(topologyEdgeBadge({ latencyMs: 23.4, rateBps: 5000, status: "running" }), "23 ms");
  assert.equal(topologyEdgeBadge({ latencyMs: null, rateBps: 15_000, status: "running" }), "15 KB/s");
  assert.equal(topologyEdgeBadge({ latencyMs: null, rateBps: 0, status: "running" }), null);
  assert.equal(topologyEdgeBadge({ latencyMs: 10, rateBps: null, status: "stopped" }), null);
  assert.equal(formatEdgeRate(1.5 * 1024 * 1024), "1.5 MB/s");
  assert.equal(formatEdgeRate(900), "900 B/s");
});
