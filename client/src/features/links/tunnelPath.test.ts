import assert from "node:assert/strict";
import test from "node:test";

import { buildTunnelPath, formatTunnelExitLatency, tunnelExitLatency } from "./tunnelPath";
import { tunnelHealthFromAvailability } from "./tunnelHealth";

const hosts = [
  { id: 1, name: "Po0" },
  { id: 2, name: "Relay-HK" },
  { id: 3, name: "Jinx" },
  { id: 4, name: "HK02" },
];

const tunnel = (over: Record<string, unknown> = {}) => ({
  id: 10,
  entryHostId: 1,
  exitHostId: 3,
  ...over,
});

test("节点顺序就是路径顺序，不再给每个节点贴「入口主机/出口主机」标签", () => {
  /*
    位置本身已经说明了谁是入口谁是出口。上一版每个节点都带一个说明它是什么的
    标签，既没增加信息，又让三个节点读起来像三条并列的属性而不是一条链。
  */
  const path = buildTunnelPath(tunnel({ hopHostIds: [1, 2, 3] }), { hosts, health: "healthy" });
  assert.deepEqual(path.nodes.map((n) => n.name), ["Po0", "Relay-HK", "Jinx"]);
  const labels = path.nodes.map((n) => n.sublabel || "").join("|");
  assert.doesNotMatch(labels, /入口主机|出口主机|中继/);
});

test("延迟和转发实现只标在中间那一段", () => {
  // 每段都标一遍的话，三跳路径上会出现三个 8ms —— 看的人会以为那是分段延迟，
  // 而实际测的是端到端。
  const path = buildTunnelPath(tunnel({ hopHostIds: [1, 2, 3] }), {
    hosts,
    health: "healthy",
    latencyMs: 8,
    via: "NEX V2",
  });
  const labelled = path.edges.filter((e) => e.latencyMs != null || e.via);
  assert.equal(labelled.length, 1);
  assert.equal(labelled[0].latencyMs, 8);
  assert.equal(labelled[0].via, "NEX V2");
});

test("边比节点少一条", () => {
  const path = buildTunnelPath(tunnel({ hopHostIds: [1, 2, 3] }), { hosts });
  assert.equal(path.edges.length, path.nodes.length - 1);
});

test("入口组代表它的成员，成员不再重复出现", () => {
  // 上一版把组画成第一行、成员再各画一行，同一台机器在一条路径上出现两次。
  const path = buildTunnelPath(tunnel({ hopHostIds: [1, 2, 3] }), {
    hosts,
    entryGroup: { id: 7, name: "聚合入口", domain: "entry.example.com" },
    entryGroupMemberHostIds: [1],
  });
  assert.deepEqual(path.nodes.map((n) => n.name), ["聚合入口", "Relay-HK", "Jinx"]);
  assert.equal(path.nodes[0].sublabel, "entry.example.com");
});

test("入口组没有域名时注脚写「入口组」，不留空", () => {
  // 空注脚会让它看起来和单台主机一模一样 —— 而它是一组机器合起来当一个用。
  const path = buildTunnelPath(tunnel({ hopHostIds: [1, 2] }), {
    hosts,
    entryGroup: { id: 7, name: "聚合入口" },
    entryGroupMemberHostIds: [1],
  });
  assert.equal(path.nodes[0].sublabel, "入口组");
});

test("负载均衡的额外出口接在最后，不画成主备那种分支", () => {
  // 分支的语义是「一条在走、其余待命」，那是主备不是负载均衡。
  const path = buildTunnelPath(
    tunnel({
      hopHostIds: [1, 3],
      loadBalanceStrategy: "round_robin",
      loadBalanceExits: [{ hostId: 4 }],
    }),
    { hosts },
  );
  const last = path.nodes[path.nodes.length - 1];
  assert.equal(last.name, "负载均衡出口");
  assert.match(String(last.sublabel), /Jinx|HK02/);
});

test("title 带上完整路径，窄屏截断时还读得到", () => {
  const path = buildTunnelPath(tunnel({ hopHostIds: [1, 2, 3] }), {
    hosts,
    latencyMs: 8,
    entryGroup: { id: 7, name: "聚合入口" },
    entryGroupMemberHostIds: [1],
  });
  assert.match(path.title, /入口组：聚合入口/);
  assert.match(path.title, /→/);
  assert.match(path.title, /8 ms/);
});

test("hopHostIds 为空时退回入口/出口两跳，而不是画成空路径", () => {
  /*
    这是 getTunnelHopIds 的既有行为：多跳字段没填的老数据仍然有 entryHostId
    和 exitHostId，那就是一条两跳链路。第一版测试断言这里应该是 0 个节点 ——
    那是我凭空设想的契约，不是代码的契约，改测试而不是改代码。
  */
  const path = buildTunnelPath(tunnel({ hopHostIds: [] }), { hosts });
  assert.deepEqual(path.nodes.map((n) => n.name), ["Po0", "Jinx"]);
  assert.equal(path.edges.length, 1);
});

test("连入口出口都没有时才是空路径", () => {
  const path = buildTunnelPath({ id: 1 }, { hosts });
  assert.equal(path.nodes.length, 0);
  assert.equal(path.edges.length, 0);
});

test("整条路径同色 —— 逐跳状态拿不到就不假装有", () => {
  const path = buildTunnelPath(tunnel({ hopHostIds: [1, 2, 3] }), { hosts, health: "degraded" });
  assert.ok(path.nodes.every((n) => n.health === "degraded"));
  assert.ok(path.edges.every((e) => e.health === "degraded"));
});

test("没传 health 时是 unknown，不是 healthy", () => {
  const path = buildTunnelPath(tunnel({ hopHostIds: [1, 2] }), { hosts });
  assert.ok(path.nodes.every((n) => n.health === "unknown"));
});

test("pending 是 unknown，不和 degraded 并成同一个黄", () => {
  // 「还在测」不是「测出来不太好」。把没有结论的显示成有结论的，正是这套
  // 词汇表要避免的。
  assert.equal(tunnelHealthFromAvailability("pending"), "unknown");
  assert.equal(tunnelHealthFromAvailability("degraded"), "degraded");
});

test("可用性各档映射正确", () => {
  assert.equal(tunnelHealthFromAvailability("available"), "healthy");
  assert.equal(tunnelHealthFromAvailability("unavailable"), "down");
  assert.equal(tunnelHealthFromAvailability("disabled"), "standby");
  assert.equal(tunnelHealthFromAvailability(""), "unknown");
  assert.equal(tunnelHealthFromAvailability(null), "unknown");
});

test("手动停用是 standby，协议没启用是 down —— 两者不能混", () => {
  // 停用是按设计没在跑；协议没启用是这条链路根本跑不起来。
  assert.equal(tunnelHealthFromAvailability("available", { enabled: false }), "standby");
  assert.equal(tunnelHealthFromAvailability("available", { supported: false }), "down");
});

/*
  延迟口径（2026-11 用户：「转发延迟显示都不统一」）：链路卡上的数是「到出口」（入口→出口机），规则卡上的是「整链」（再到目标）。
  线下写明「到出口」，悬停写清是哪台、谁测的。
*/
test("线下的延迟写成「到出口 X ms」，悬停写入口到主出口（链路探测）", () => {
  const path = buildTunnelPath(tunnel(), { hosts, latencyMs: 7 });
  const labelled = path.edges.find((edge) => edge.latencyMs != null);
  assert.equal(labelled?.latencyPrefix, "到出口");
  assert.equal(labelled?.latencyMs, 7);
  assert.equal(labelled?.latencyHighMs, undefined);
  assert.match(path.title, /入口到主出口 7 ms（链路探测）/);
});

test("负载均衡：用在用出口各自的探测；一台写一个数，几台写区间；没有就退回链路探测的总数", () => {
  const balanced = tunnel({ loadBalanceEnabled: true, loadBalanceExits: [{ hostId: 4, isEnabled: true }] });
  const one = buildTunnelPath(balanced, {
    hosts,
    latencyMs: 7,
    liveExitLatency: { exitHostId: 4, exitName: "HK02", exitMs: 5, lowMs: 5, highMs: 5, inUse: 1 },
  });
  const oneEdge = one.edges.find((edge) => edge.latencyMs != null);
  assert.deepEqual([oneEdge?.latencyPrefix, oneEdge?.latencyMs, oneEdge?.latencyHighMs], ["到出口", 5, undefined]);
  assert.match(one.title, /入口到在用出口 HK02 5 ms（链路探测）/);

  const several = buildTunnelPath(balanced, {
    hosts,
    latencyMs: 7,
    liveExitLatency: { exitHostId: 4, exitName: "HK02", exitMs: 6, lowMs: 5, highMs: 7, inUse: 2 },
  });
  const severalEdge = several.edges.find((edge) => edge.latencyMs != null);
  assert.deepEqual([severalEdge?.latencyMs, severalEdge?.latencyHighMs], [5, 7]);
  assert.match(several.title, /入口到在用出口 5–7 ms（2 台，扛流量最多的 HK02 6 ms；链路探测）/);

  const fallback = tunnelExitLatency(balanced, 7, null);
  assert.equal(fallback?.source, "probe");
  assert.match(String(fallback?.title), /几台出口里最慢的那台/);
  assert.equal(formatTunnelExitLatency({ lowMs: 5, highMs: 7, source: "live", title: "" }), "5–7 ms");
  assert.equal(formatTunnelExitLatency({ lowMs: 5, highMs: 5, source: "probe", title: "" }), "5 ms");
  // 不是负载均衡的链路：只有一台出口，总数就是到它
  assert.equal(tunnelExitLatency(tunnel(), 7, { exitMs: 5, lowMs: 5, highMs: 5, inUse: 1 })?.source, "probe");
});
