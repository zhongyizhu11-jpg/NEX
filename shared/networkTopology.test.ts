import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNetworkTopology,
  mergeTopologyStatuses,
  topologyRuleStatus,
  worseTopologyStatus,
  type TopologyGraph,
  type TopologyInput,
} from "./networkTopology";

/*
  拓扑图聚合：五种转发（普通、隧道、转发链、线路组、落地入站）各拆成什么样的边，
  同一台主机 / 同一个外部目标只出现一次，用户视角只看自己的、看不见的主机打码。
*/

const ADMIN = 1;
const ALICE = 2;
const hosts = [
  { id: 1, name: "HK 入口", userId: ADMIN, ip: "10.0.0.1", isOnline: true, geoCountryCode: "hk" },
  { id: 2, name: "JP 出口", userId: ADMIN, ip: "10.0.0.2", entryIp: "jp.example.com", isOnline: true, geoCountryCode: "jp" },
  { id: 3, name: "SG 中转", userId: ADMIN, ip: "10.0.0.3", isOnline: true },
  { id: 4, name: "US 落地", userId: ADMIN, ip: "10.0.0.4", isOnline: false },
  { id: 5, name: "Alice 的机器", userId: ALICE, ip: "10.0.0.5", isOnline: true },
];

const tunnels = [
  {
    id: 10, name: "HK→SG→JP", userId: ADMIN, entryHostId: 1, exitHostId: 2, mode: "tls", listenPort: 24001,
    isEnabled: true, isRunning: true, lastLatencyMs: 46, lastTestStatus: "success",
    hops: [{ seq: 1, hostId: 3 }], exitNodes: [],
  },
  {
    id: 11, name: "空隧道", userId: ADMIN, entryHostId: 3, exitHostId: 4, mode: "wss", listenPort: 25001,
    isEnabled: false, isRunning: false, hops: [], exitNodes: [],
  },
];

const groups = [
  {
    id: 20, name: "三跳链", userId: ADMIN, groupMode: "chain", isEnabled: true, lastStatus: "healthy",
    members: [
      { id: 201, hostId: 1, priority: 1, isEnabled: true },
      { id: 202, hostId: 3, priority: 2, isEnabled: true },
      { id: 203, hostId: 2, priority: 3, isEnabled: true },
    ],
  },
];

const rules = [
  // 普通规则：两条指向同一个外部目标（大小写不同的域名），合成一个目标节点、一条边
  { id: 100, name: "网站", userId: ADMIN, hostId: 1, protocol: "tcp", sourcePort: 8080, targetIp: "Web.Example.com", targetPort: 443, isEnabled: true, isRunning: true },
  { id: 101, name: "网站备份", userId: ADMIN, hostId: 1, protocol: "tcp", sourcePort: 8081, targetIp: "web.example.com.", targetPort: 443, isEnabled: false, isRunning: false },
  // 目标地址正好是 JP 的入口域名：落在 JP 上，不是外部目标
  { id: 102, name: "到 JP", userId: ADMIN, hostId: 3, protocol: "both", sourcePort: 9000, targetIp: "jp.example.com", targetPort: 24610, isEnabled: true, isRunning: true },
  // 隧道规则
  { id: 110, name: "隧道业务", userId: ADMIN, hostId: 1, protocol: "tcp", sourcePort: 24080, targetIp: "192.0.2.80", targetPort: 80, tunnelId: 10, isEnabled: true, isRunning: true },
  // 转发链：模板 + 三条子规则
  { id: 120, name: "链模板", userId: ADMIN, hostId: 1, protocol: "tcp", sourcePort: 18080, targetIp: "198.51.100.8", targetPort: 8080, forwardGroupId: 20, isForwardGroupTemplate: true, isEnabled: true, isRunning: false },
  { id: 121, name: "链 1", userId: ADMIN, hostId: 1, protocol: "tcp", sourcePort: 18080, targetIp: "10.0.0.3", targetPort: 30001, forwardGroupId: 20, forwardGroupRuleId: 120, forwardGroupMemberId: 201, isEnabled: true, isRunning: true },
  { id: 122, name: "链 2", userId: ADMIN, hostId: 3, protocol: "tcp", sourcePort: 30001, targetIp: "10.0.0.2", targetPort: 30002, forwardGroupId: 20, forwardGroupRuleId: 120, forwardGroupMemberId: 202, isEnabled: true, isRunning: true },
  { id: 123, name: "链 3", userId: ADMIN, hostId: 2, protocol: "tcp", sourcePort: 30002, targetIp: "198.51.100.8", targetPort: 8080, forwardGroupId: 20, forwardGroupRuleId: 120, forwardGroupMemberId: 203, isEnabled: true, isRunning: false },
  // 线路组：A 经 JP 中转到规则目标；B 经 SG → US 到另一个落地
  {
    id: 130, name: "线路组", userId: ADMIN, hostId: 1, protocol: "tcp", sourcePort: 25300, targetIp: "203.0.113.10", targetPort: 443,
    isEnabled: true, isRunning: true, failoverEnabled: true, failoverTargets: "[]",
    routePaths: JSON.stringify([
      { key: "main", name: "主线路", hops: [2], dest: null, weight: 60 },
      { key: "backup", name: "备用", hops: [3, 4], dest: { ip: "203.0.113.11", port: 443 }, weight: 40 },
    ]),
  },
  // 线路组的中继规则：不单算，只说明那一跳的状态（US 上的没在跑）
  { id: 131, name: "中继", userId: ADMIN, hostId: 3, sourcePort: 31000, targetIp: "10.0.0.4", targetPort: 31001, routeParentRuleId: 130, routePathKey: "backup", routeHopIndex: 0, isEnabled: true, isRunning: true },
  { id: 132, name: "中继", userId: ADMIN, hostId: 4, sourcePort: 31001, targetIp: "203.0.113.11", targetPort: 443, routeParentRuleId: 130, routePathKey: "backup", routeHopIndex: 1, isEnabled: true, isRunning: false },
  // Alice：自己机器上一条规则，外加一条走管理员隧道的规则
  { id: 140, name: "Alice 直连", userId: ALICE, hostId: 5, protocol: "udp", sourcePort: 7000, targetIp: "10.0.0.1", targetPort: 53, isEnabled: true, isRunning: true },
  { id: 141, name: "Alice 走隧道", userId: ALICE, hostId: 1, protocol: "tcp", sourcePort: 26001, targetIp: "203.0.113.50", targetPort: 443, tunnelId: 10, isEnabled: true, isRunning: true },
];

const inbounds = [
  { id: 300, name: "JP VLESS", userId: ADMIN, hostId: 2, protocol: "vless", port: 24610, isEnabled: true },
];

function fixture(overrides: Partial<TopologyInput> = {}): TopologyInput {
  return {
    hosts,
    rules: rules as any,
    tunnels,
    groups,
    inbounds,
    ruleLatencyMs: new Map([[100, 12], [110, 50]]),
    routeStats: (ruleId) => ruleId === 130 ? {
      activeIndex: 0,
      targets: [{ index: 0, latencyMs: 38, healthy: true }, { index: 1, latencyMs: 74, healthy: true }],
      hops: [{ pathKey: "backup", hopIndex: 0, ok: true, latencyMs: 41, consecutiveFailures: 0 }],
    } : null,
    ...overrides,
  };
}

function edge(graph: TopologyGraph, kind: string, from: string, to: string) {
  return graph.edges.find((item) => item.kind === kind && item.from === from && item.to === to);
}

test("同一台主机只出现一次，外部目标按地址:端口合并、域名原样保留", () => {
  const graph = buildNetworkTopology(fixture());
  const ids = graph.nodes.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, "节点 id 不重复");
  assert.equal(graph.nodes.filter((node) => node.hostId === 1).length, 1);
  const web = graph.nodes.filter((node) => node.kind === "target" && node.label.toLowerCase().startsWith("web.example.com"));
  assert.equal(web.length, 1, "Web.Example.com 和 web.example.com. 是同一个目标");
  assert.equal(web[0].id, "target:web.example.com:443");
  const direct = edge(graph, "rule", "host:1", "target:web.example.com:443");
  assert.ok(direct);
  assert.deepEqual(direct!.ruleIds, [100, 101], "两条规则合成一条边");
  assert.equal(direct!.status, "running", "一条停用一条在跑：停用的不拉低状态");
  assert.equal(direct!.latencyMs, 12);
  assert.equal(direct!.port, 443);
});

test("目标地址对上受管主机就落在那台主机上，并且算进它的落地入站", () => {
  const graph = buildNetworkTopology(fixture());
  const toJp = edge(graph, "rule", "host:3", "host:2");
  assert.ok(toJp, "SG → JP（按入口域名认出来）");
  const jp = graph.nodes.find((node) => node.id === "host:2")!;
  assert.equal(jp.roles.landing, true);
  const subscription = edge(graph, "subscription", "host:2", "inbound:300");
  assert.ok(subscription);
  assert.ok(subscription!.ruleIds.includes(102), "落在入站端口上的规则记在入站那条边上");
  assert.equal(subscription!.status, "running");
});

test("隧道规则：入口 → 中转 → 出口 → 目标；没有规则的隧道也画出结构", () => {
  const graph = buildNetworkTopology(fixture());
  const first = edge(graph, "tunnel", "host:1", "host:3");
  const second = edge(graph, "tunnel", "host:3", "host:2");
  assert.ok(first && second);
  assert.equal(first!.tunnelId, 10);
  assert.deepEqual(second!.ruleIds, [110, 141]);
  assert.equal(second!.latencyMs, 46, "隧道延迟记在到出口那一段");
  assert.ok(edge(graph, "rule", "host:2", "target:192.0.2.80:80"), "出口 → 目标");
  const sg = graph.nodes.find((node) => node.id === "host:3")!;
  assert.equal(sg.roles.relay, true);
  const idle = edge(graph, "tunnel", "host:3", "host:4");
  assert.ok(idle, "没有规则的隧道 11");
  assert.equal(idle!.status, "stopped");
  assert.deepEqual(idle!.ruleIds, []);
});

test("转发链：按成员顺序一跳一跳，边上记模板规则 id，最后一跳没在跑就是异常", () => {
  const graph = buildNetworkTopology(fixture());
  const hop1 = edge(graph, "chain", "host:1", "host:3");
  const hop2 = edge(graph, "chain", "host:3", "host:2");
  const last = edge(graph, "chain", "host:2", "target:198.51.100.8:8080");
  assert.ok(hop1 && hop2 && last);
  assert.deepEqual(hop1!.ruleIds, [120]);
  assert.equal(hop1!.groupId, 20);
  assert.equal(last!.status, "failed");
  const ref = graph.rules.find((rule) => rule.id === 120)!;
  assert.equal(ref.kind, "chain");
  assert.equal(ref.name, "链模板", "规则清单里是用户看得见的模板，不是子规则");
  assert.equal(ref.status, "degraded");
  assert.equal(graph.rules.some((rule) => rule.id === 121), false);
  const jp = graph.nodes.find((node) => node.id === "host:2")!;
  assert.equal(jp.roles.exit, true);
});

test("线路组：每条路径各自经过中转到各自的落地，中继规则不单算", () => {
  const graph = buildNetworkTopology(fixture());
  const mainFirst = edge(graph, "routePath", "host:1", "host:2");
  const mainLast = edge(graph, "routePath", "host:2", "target:203.0.113.10:443");
  assert.ok(mainFirst && mainLast);
  assert.deepEqual(mainFirst!.pathKeys, ["main"]);
  assert.equal(mainFirst!.latencyMs, 38, "入口探到第一跳的延迟");
  const backup1 = edge(graph, "routePath", "host:1", "host:3");
  const backup2 = edge(graph, "routePath", "host:3", "host:4");
  const backupLast = edge(graph, "routePath", "host:4", "target:203.0.113.11:443");
  assert.ok(backup1 && backup2 && backupLast);
  assert.equal(backup2!.latencyMs, 41, "SG 探 US 的那一跳");
  assert.equal(backupLast!.status, "failed", "US 上的中继没在跑");
  assert.equal(graph.rules.find((rule) => rule.id === 130)!.pathCount, 2);
  // Agent 说此刻走主线路：主线路的段是「在走」，备用的段是「备用」；规则上记着当前路径 key。
  assert.equal(mainFirst!.activePath, true);
  assert.equal(backup1!.activePath, false);
  assert.equal(graph.rules.find((rule) => rule.id === 130)!.activePathKey, "main");
  assert.equal(edge(graph, "rule", "host:1", "host:2")?.activePath ?? null, null, "不是线路组的边不说在走不在走");
  const unknown = buildNetworkTopology(fixture({ routeStats: () => null }));
  assert.equal(edge(unknown, "routePath", "host:1", "host:3")!.activePath, null, "不知道走哪条时谁都不算备用");
  assert.equal(graph.rules.some((rule) => rule.id === 131 || rule.id === 132), false);
  assert.equal(graph.edges.some((item) => item.ruleIds.includes(131)), false);
});

test("用户视角：只看自己的规则；共享隧道经过的、看不见的主机打码", () => {
  const graph = buildNetworkTopology(fixture({ scope: { userId: ALICE, mask: true, visibleHostIds: new Set([1, 5]) } }));
  const ruleIds = graph.rules.map((rule) => rule.id).sort((a, b) => a - b);
  assert.deepEqual(ruleIds, [140, 141]);
  assert.equal(graph.nodes.some((node) => node.id === "host:2" || node.id === "host:3"), false, "看不见的主机不带 id");
  const masked = graph.nodes.filter((node) => node.masked);
  assert.equal(masked.length, 2);
  assert.ok(masked.every((node) => node.label === "隐藏节点" && node.hostId === null));
  assert.equal(graph.nodes.some((node) => node.kind === "inbound"), false, "别人的入站不给");
  assert.ok(edge(graph, "rule", "host:5", "host:1"), "目标是看得见的主机：照常落在主机上");
  assert.deepEqual(graph.tunnels.map((tunnel) => tunnel.id), [10], "只有他用到的隧道");
  for (const item of graph.edges) {
    for (const id of item.ruleIds) assert.ok([140, 141].includes(id), `边上不能出现别人的规则 ${id}`);
  }
});

test("用户视角：自己填的目标对上一台看不见的主机时按外部目标画", () => {
  const graph = buildNetworkTopology(fixture({ scope: { userId: ALICE, mask: true, visibleHostIds: new Set([5]) } }));
  assert.ok(edge(graph, "rule", "host:5", "target:10.0.0.1:53"));
});

test("管理员按用户筛：不打码", () => {
  const graph = buildNetworkTopology(fixture({ scope: { userId: ALICE, mask: false, visibleHostIds: new Set() } }));
  assert.equal(graph.nodes.some((node) => node.masked), false);
  assert.ok(graph.nodes.some((node) => node.id === "host:3"));
  assert.deepEqual(graph.rules.map((rule) => rule.id).sort((a, b) => a - b), [140, 141]);
});

test("结果确定：同样的输入两次得到一样的图", () => {
  assert.deepEqual(buildNetworkTopology(fixture()), buildNetworkTopology(fixture()));
});

test("状态合并", () => {
  assert.equal(topologyRuleStatus({ isEnabled: false, isRunning: true }), "stopped");
  assert.equal(topologyRuleStatus({ isEnabled: true, isRunning: false }), "failed");
  assert.equal(mergeTopologyStatuses(["stopped", "stopped"]), "stopped");
  assert.equal(mergeTopologyStatuses(["failed", "stopped"]), "failed");
  assert.equal(mergeTopologyStatuses(["failed", "running"]), "degraded");
  assert.equal(mergeTopologyStatuses(["running", "stopped"]), "running");
  assert.equal(worseTopologyStatus("running", "stopped"), "stopped");
  assert.equal(worseTopologyStatus("degraded", "failed"), "failed");
});

test("入口组和主备转发组画成组节点 → 成员", () => {
  const graph = buildNetworkTopology(fixture({
    groups: [
      ...groups,
      { id: 30, name: "亚洲入口", userId: ADMIN, groupMode: "entry", domain: "entry.example.com", isEnabled: true, members: [{ id: 301, hostId: 1, priority: 1, isEnabled: true }, { id: 302, hostId: 3, priority: 2, isEnabled: true, healthStatus: "failed" }] },
      { id: 31, name: "主备组", userId: ADMIN, groupMode: "failover", isEnabled: true, activeMemberId: 311, members: [{ id: 311, hostId: 1, priority: 1, isEnabled: true }, { id: 312, hostId: 2, priority: 2, isEnabled: true }] },
    ],
    tunnels: [{ ...tunnels[0], entryGroupId: 30 }, tunnels[1]],
  }));
  const entry = graph.nodes.find((node) => node.id === "group:30")!;
  assert.equal(entry.kind, "group");
  assert.equal(entry.sublabel, "entry.example.com");
  assert.equal(edge(graph, "group", "group:30", "host:3")!.status, "failed");
  assert.ok(edge(graph, "tunnel", "host:3", "host:3") === undefined, "不画自环");
  assert.equal(edge(graph, "group", "group:31", "host:1")!.label, "当前成员");
  assert.equal(edge(graph, "group", "group:31", "host:2")!.label, "备用成员");
});

test("Shadowsocks 出口：入口 → 落地主机（SS 出口）→ 目标；外部链接只在入口 → 目标上标出来", () => {
  const extra = [
    { id: 150, name: "经 JP 出口", userId: ADMIN, hostId: 1, protocol: "tcp", sourcePort: 27001, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true, isRunning: true, egressType: "ss_host", egressInboundId: 301 },
    { id: 151, name: "经外部 SS", userId: ADMIN, hostId: 3, protocol: "tcp", sourcePort: 27002, targetIp: "198.51.100.10", targetPort: 443, isEnabled: true, isRunning: true, egressType: "ss_link" },
  ];
  const graph = buildNetworkTopology(fixture({
    rules: [...rules, ...extra] as any,
    inbounds: [...inbounds, { id: 301, name: "JP SS 出口", userId: ADMIN, hostId: 2, protocol: "shadowsocks", port: 28388, isEnabled: true }],
  }));
  const toLanding = edge(graph, "rule", "host:1", "host:2");
  assert.ok(toLanding, "入口 → 落地");
  assert.ok(toLanding!.ruleIds.includes(150));
  assert.equal(toLanding!.port, 28388);
  const fromLanding = edge(graph, "rule", "host:2", "target:198.51.100.9:443");
  assert.ok(fromLanding, "目标由落地主机去连");
  assert.ok(fromLanding!.ruleIds.includes(150));
  assert.equal(edge(graph, "rule", "host:1", "target:198.51.100.9:443"), undefined, "不再画成入口直连目标");
  assert.equal(graph.nodes.find((node) => node.id === "host:2")!.roles.exit, true);
  const viaLink = edge(graph, "rule", "host:3", "target:198.51.100.10:443");
  assert.ok(viaLink);
  assert.ok(viaLink!.ruleIds.includes(151));
});
