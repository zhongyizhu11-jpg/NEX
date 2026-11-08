import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MyLineRow, lineLatencyChip } from "./MyLinesSection";
import { buildLineModel, type LineModelContext } from "./myLines";
import {
  MY_LINES_LAYOUT,
  MY_LINES_LAYOUT_COMPACT,
  MY_LINES_MIN_SCALE,
  buildMyLinesGraph,
  myLinesCanvasHeight,
  myLinesColumnLabels,
  myLinesLayoutFor,
  sortLinesForList,
} from "./myLinesGraph";
import { layoutTopology } from "@/features/topology/topologyLayout";

const NOW = Date.parse("2026-10-29T08:00:00Z");

function context(patch: Partial<LineModelContext> = {}): LineModelContext {
  return {
    hostById: new Map<number, any>([
      [1, { id: 1, name: "HK entry", ip: "203.0.113.1", entryIp: "203.0.113.1", isOnline: true }],
      [2, { id: 2, name: "JP relay", ip: "203.0.113.2", isOnline: true }],
      [3, { id: 3, name: "US exit", ip: "203.0.113.3", isOnline: false }],
    ]),
    tunnelById: new Map<number, any>([[10, { id: 10, name: "hk-jp-us", hopHostIds: [1, 2, 3], entryHostId: 1, exitHostId: 3 }]]),
    groupById: new Map<number, any>([
      [20, { id: 20, name: "家宽链", groupMode: "chain", members: [{ id: 201, hostId: 1, priority: 0, isEnabled: true }, { id: 202, hostId: 2, priority: 1, isEnabled: true }] }],
    ]),
    nodeNameById: new Map<number, string>([[7, "美国 01"]]),
    routeStatusByRule: new Map(),
    probeByRule: new Map(),
    trafficByRule: new Map(),
    nowMs: NOW,
    ...patch,
  };
}

test("端口转发：入口 → 落地，端到端延迟写在卡头，24h 流量在旁边", () => {
  const line = buildLineModel(
    { id: 1, name: "直连", hostId: 1, sourcePort: 10001, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true },
    context({
      probeByRule: new Map([[1, { latencyMs: 42, isTimeout: false, at: NOW - 30_000 }]]),
      trafficByRule: new Map([[1, { bytesIn: 1024, bytesOut: 2048 }]]),
    }),
  );
  assert.equal(line.kind, "local");
  assert.equal(line.entry.name, "HK entry");
  assert.equal(line.entry.address, "203.0.113.1:10001");
  assert.deepEqual(line.hops, []);
  assert.equal(line.landing.caption, "198.51.100.9:443");
  assert.equal(line.health, "healthy");
  assert.match(line.statusText, /端到端 42 ms/);
  assert.deepEqual(lineLatencyChip(line), { text: "整链 42 ms", tone: "ok" });
  const html = renderToStaticMarkup(<MyLineRow line={line} selected onSelect={() => {}} onEdit={() => {}} onDiagnose={() => {}} />);
  assert.match(html, />整链 42 ms</);
  assert.match(html, /HK entry → 落地/, "展开后写整条链");
  assert.match(html, /端到端 42 ms/);
  // 整张图：入口、落地两个节点，一条连线，只有一段时端到端延迟就骑在这一段上
  const graph = buildMyLinesGraph([line]);
  assert.deepEqual(graph.nodes.map((node) => node.id), ["host:1", "addr:198.51.100.9:443"]);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual([graph.edges[0].status, graph.edges[0].latencyMs], ["running", 42]);
});

test("隧道转发：经过的只列入口后面的中转和出口，出口掉线整条线算断", () => {
  const line = buildLineModel(
    { id: 2, name: "走隧道", hostId: 1, tunnelId: 10, sourcePort: 10002, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true, proxyNodeId: 7, proxyNodeVisible: true },
    context({ probeByRule: new Map([[2, { latencyMs: 180, isTimeout: false, at: NOW - 30_000 }]]) }),
  );
  assert.equal(line.kind, "tunnel");
  assert.deepEqual(line.hops.map((hop) => [hop.name, hop.caption]), [["JP relay", "中转"], ["US exit", "出口 · 离线"]]);
  assert.equal(line.landing.name, "美国 01", "绑了我的节点就写节点名");
  assert.match(line.landing.caption, /我的节点 · 198\.51\.100\.9:443/);
  assert.equal(line.health, "down");
  assert.match(line.statusText, /主机离线：US exit/);
  assert.deepEqual(line.subscription, { nodeName: "美国 01", visible: true });
  const html = renderToStaticMarkup(<MyLineRow line={line} selected onSelect={() => {}} />);
  assert.match(html, /订阅「美国 01」/);
  // 图上：出口掉线那台连着的两段不通，落地按「我的节点」成一个节点
  const graph = buildMyLinesGraph([line]);
  assert.deepEqual(graph.nodes.map((node) => node.id), ["host:1", "host:2", "host:3", "node:7"]);
  assert.deepEqual(graph.edges.map((edge) => [edge.from, edge.to, edge.kind, edge.status]), [
    ["host:1", "host:2", "tunnel", "running"],
    ["host:2", "host:3", "tunnel", "failed"],
    ["host:3", "node:7", "tunnel", "failed"],
  ]);
  assert.equal(graph.captions.get("node:7"), "落地 · 198.51.100.9:443");
  assert.equal(graph.nodes.find((node) => node.id === "host:3")?.online, false);
});

test("转发链：第一个成员是入口，其余是中转；配了 SS 出口就多一节", () => {
  const line = buildLineModel(
    {
      id: 3, name: "家宽", hostId: 1, forwardGroupId: 20, isForwardGroupTemplate: true, sourcePort: 10003, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true,
      egress: { type: "ss_host", landingHostName: "新加坡落地", state: "running", udp: true, masked: "ss://***@sg" },
    },
    context(),
  );
  assert.equal(line.kind, "chain");
  assert.equal(line.entry.name, "HK entry");
  assert.deepEqual(line.hops.map((hop) => hop.name), ["JP relay"]);
  assert.equal(line.exit?.name, "新加坡落地");
  assert.match(line.exit?.caption || "", /出口 · Shadowsocks · 含 UDP/);
  assert.equal(line.health, "unknown");
  assert.equal(line.statusText, "还没探测过");
});

test("线路组：画当前在走的路径，段上是线路板各段的延迟", () => {
  const status = {
    paths: [
      { key: "a", letter: "A", name: "主线路", active: true, healthy: true, down: false, prewarming: false, latencyMs: 23, probedAt: NOW - 5000, probe: null,
        hops: [{ hostId: 2, name: "JP relay", port: 25310, running: true, enabled: true, ok: true, latencyMs: 50, consecutiveFailures: 0, probedAt: NOW - 5000, nextLabel: null }],
        dest: { ip: "198.51.100.9", port: 443 }, score: null, lossPct: null, availabilityPct: null, connections: null, dials: null },
    ],
    entry: { hostId: 1, name: "HK entry", online: true, sourcePort: 10004 },
  } as any;
  const line = buildLineModel(
    { id: 4, name: "线路组", hostId: 1, sourcePort: 10004, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true, failoverEnabled: true, failoverStrategy: "failover", routeMode: "failover", routePaths: JSON.stringify([{ key: "a", name: "主线路", hops: [2], dest: null, weight: 1, probe: null, dial: null }]), failoverTargets: "[]" },
    context({ routeStatusByRule: new Map([[4, status]]) }),
  );
  assert.equal(line.kind, "route");
  assert.deepEqual(line.hops.map((hop) => [hop.name, hop.health]), [["JP relay", "healthy"]]);
  assert.deepEqual(line.segments.map((segment) => [segment.state, segment.latencyMs]), [["measured", 23], ["measured", 50]]);
  const graph = buildMyLinesGraph([line]);
  assert.deepEqual(graph.edges.map((edge) => [edge.kind, edge.latencyMs]), [["routePath", 23], ["routePath", 50]], "段上是线路板各段的延迟");
});

test("整张图：几条线路共用的主机只画一个、共用的一段合成一条；落地对齐在同一列，出口在最后", () => {
  const ctx = context({
    probeByRule: new Map([
      [11, { latencyMs: 40, isTimeout: false, at: NOW - 30_000 }],
      [12, { latencyMs: null, isTimeout: true, at: NOW - 30_000 }],
    ]),
  });
  const direct = buildLineModel({ id: 11, name: "直连 A", hostId: 1, sourcePort: 10011, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true }, ctx);
  // 同一个入口、同一个落地、另一条端口：直连的一段合进同一条连线
  const directDown = buildLineModel({ id: 12, name: "直连 B", hostId: 1, sourcePort: 10012, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true }, ctx);
  const chain = buildLineModel(
    {
      id: 13, name: "家宽", hostId: 1, forwardGroupId: 20, isForwardGroupTemplate: true, sourcePort: 10013, targetIp: "198.51.100.20", targetPort: 8443, isEnabled: true,
      egress: { type: "ss_host", landingHostId: 9, landingHostName: "新加坡落地", state: "running", udp: true },
    },
    ctx,
  );
  const stopped = buildLineModel({ id: 14, name: "停用的", hostId: 2, sourcePort: 10014, targetIp: "198.51.100.30", targetPort: 443, isEnabled: false }, ctx);
  const graph = buildMyLinesGraph([direct, directDown, chain, stopped]);

  assert.equal(graph.nodes.filter((node) => node.id === "host:1").length, 1, "HK entry 是三条线的入口，只画一个");
  assert.deepEqual(graph.nodes.find((node) => node.id === "host:1")?.ruleIds, [11, 12, 13]);
  const shared = graph.edges.find((edge) => edge.id === "host:1>addr:198.51.100.9:443>rule");
  assert.deepEqual(shared?.ruleIds, [11, 12], "两条直连走的同一段合成一条连线");
  assert.equal(shared?.status, "failed", "合并取最差：有一条不通就标出来");
  assert.equal(shared?.latencyMs, null, "标红的线不挂另一条线的 40 ms，免得看着像通的");
  assert.equal(graph.edges.find((edge) => edge.from === "host:2" && edge.to === "addr:198.51.100.30:443")?.status, "stopped");
  assert.equal(graph.captions.get("host:2"), "入口 · 中转", "JP relay 在一条线里是入口、在另一条里是中转");

  const layout = layoutTopology(graph.nodes.map((node) => ({ id: node.id, kind: graph.layoutKind.get(node.id) || "host" })), graph.edges, { terminalTiers: [["landing"], ["exit"]] });
  const layerOf = (id: string) => layout.nodes.get(id)!.layer;
  assert.equal(layerOf("addr:198.51.100.9:443"), layerOf("addr:198.51.100.20:8443"), "直连的落地和经中转的落地在同一列");
  assert.equal(layerOf("exit:host:9"), layerOf("addr:198.51.100.20:8443") + 1, "出口在落地后面一列");
  assert.deepEqual(myLinesColumnLabels(layout.layers, graph.layoutKind), ["入口", "中转", "落地", "出口"]);

  // 高亮：每条线路经过哪些节点和连线
  assert.deepEqual(Array.from(graph.pathByLine.get(13)!.nodeIds), ["host:1", "host:2", "addr:198.51.100.20:8443", "exit:host:9"]);
  // 下面的清单：不通的排最前，停用的最后
  assert.deepEqual(sortLinesForList([direct, directDown, chain, stopped]).map((line) => line.id), [12, 13, 11, 14]);
});

test("手机上一眼看完：窄画布换紧凑格子，入口 / 中转 / 落地 / 出口四列整张放下；画布高度跟着图", () => {
  assert.equal(myLinesLayoutFor(364), MY_LINES_LAYOUT_COMPACT);
  assert.equal(myLinesLayoutFor(1000), MY_LINES_LAYOUT);
  assert.equal(myLinesLayoutFor(0), MY_LINES_LAYOUT, "还没量到宽度先按电脑算");

  const ctx = context();
  const lines = [
    buildLineModel({ id: 21, name: "直连", hostId: 1, sourcePort: 10021, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true }, ctx),
    buildLineModel(
      {
        id: 22, name: "家宽", hostId: 1, forwardGroupId: 20, isForwardGroupTemplate: true, sourcePort: 10022, targetIp: "198.51.100.20", targetPort: 8443, isEnabled: true,
        egress: { type: "ss_host", landingHostName: "新加坡落地", state: "running", udp: true },
      },
      ctx,
    ),
  ];
  const graph = buildMyLinesGraph(lines);
  const layout = layoutTopology(graph.nodes.map((node) => ({ id: node.id, kind: graph.layoutKind.get(node.id) || "host" })), graph.edges, { ...MY_LINES_LAYOUT_COMPACT, terminalTiers: [["landing"], ["exit"]] });
  assert.equal(layout.layers.length, 4);
  assert.equal(layout.width, 552);
  // 手机上图那张卡大约 364 宽：整张放下的倍数不小于下限，自动适应时就是整张放下
  assert.ok((364 - 16) / layout.width >= MY_LINES_MIN_SCALE);
  const scale = (364 - 16) / layout.width;
  assert.equal(myLinesCanvasHeight(layout, 364, 2400), Math.round(Math.max(180, layout.height * scale + 16 + 22)), "画布和图一样高，不留一大块空白");
  assert.equal(myLinesCanvasHeight({ width: 552, height: 40 }, 364, 2400), 180, "再矮也留 180");
  assert.equal(myLinesCanvasHeight({ width: 552, height: 1400 }, 364, 2400), Math.round(1400 * (348 / 552) + 16 + 22), "手机上不封顶：整张图都在页面里，划页面看完");
  assert.equal(myLinesCanvasHeight({ width: 552, height: 1400 }, 1000, 680), 680, "电脑上封顶，太高的在图里上下拖");
  assert.equal(myLinesCanvasHeight({ width: 1200, height: 400 }, 364, 2400), Math.round(400 * MY_LINES_MIN_SCALE + 16 + 22), "太宽就按最小倍数算高度（左右拖着看）");
});

test("出口按机器认：同名的两台落地机不合成一个，同一台的合成一个、写状态最差那条的说法", () => {
  const base = context();
  const ctx = context({
    hostById: new Map<number, any>([...base.hostById, [10, { id: 10, name: "HK", isOnline: true }], [11, { id: 11, name: "HK", isOnline: true }]]),
  });
  const line = (id: number, landingHostId: number, state: string) => buildLineModel(
    { id, name: `线 ${id}`, hostId: 1, sourcePort: 10000 + id, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true, egress: { type: "ss_host", landingHostId, landingHostName: "HK", state, udp: false } },
    ctx,
  );
  const graph = buildMyLinesGraph([line(31, 10, "running"), line(32, 11, "running"), line(33, 10, "paused")]);
  const exits = graph.nodes.filter((node) => graph.layoutKind.get(node.id) === "exit");
  assert.deepEqual(exits.map((node) => [node.id, node.ruleIds]), [["exit:host:10", [31, 33]], ["exit:host:11", [32]]], "两台都叫 HK，但不是同一台");
  assert.equal(graph.captions.get("exit:host:10"), "出口 · Shadowsocks · paused", "停了的那条不被正常的那条盖掉");
  // 没有主机 id 的成员：只算自己这条线的，不和别的线路里同样认不出的合成一个
  const unknownA = buildLineModel({ id: 41, name: "缺主机 A", hostId: 0, sourcePort: 10041, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true }, ctx);
  const unknownB = buildLineModel({ id: 42, name: "缺主机 B", hostId: 0, sourcePort: 10042, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true }, ctx);
  assert.notEqual(unknownA.entry.nodeId, unknownB.entry.nodeId);
});

test("线路组知道断在哪一段：只标那一段，别的段不跟着标黄", () => {
  const status = {
    paths: [
      { key: "a", letter: "A", name: "主线路", active: true, healthy: true, down: false, prewarming: false, latencyMs: null, probedAt: null, probe: null,
        hops: [{ hostId: 2, name: "JP relay", port: 25310, running: true, enabled: true, ok: false, latencyMs: null, consecutiveFailures: 3, probedAt: NOW - 5000, nextLabel: null }],
        dest: { ip: "198.51.100.9", port: 443 }, score: null, lossPct: null, availabilityPct: null, connections: null, dials: null },
    ],
    entry: { hostId: 1, name: "HK entry", online: true, sourcePort: 10005 },
  } as any;
  const line = buildLineModel(
    { id: 5, name: "断在后半段", hostId: 1, sourcePort: 10005, targetIp: "198.51.100.9", targetPort: 443, isEnabled: true, failoverEnabled: true, failoverStrategy: "failover", routeMode: "failover", routePaths: JSON.stringify([{ key: "a", name: "主线路", hops: [2], dest: null, weight: 1, probe: null, dial: null }]), failoverTargets: "[]" },
    context({ routeStatusByRule: new Map([[5, status]]) }),
  );
  assert.equal(line.health, "down");
  assert.equal(line.statusText, "当前路径有一段不通", "JP relay 在线，只是往下一跳探不通：不说「主机离线」");
  assert.deepEqual(line.segments.map((segment) => segment.state), ["unknown", "failed"]);
  const graph = buildMyLinesGraph([line]);
  assert.deepEqual(graph.edges.map((edge) => edge.status), ["running", "failed"], "入口 → 中转那段没报不通，不标黄");
});
