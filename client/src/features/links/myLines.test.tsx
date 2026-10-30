import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LineCard } from "./MyLinesSection";
import { buildLineModel, type LineModelContext } from "./myLines";

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
  const html = renderToStaticMarkup(<LineCard line={line} />);
  assert.match(html, /端到端 42 ms/);
  assert.match(html, />整链 42 ms</);
  assert.equal((html.match(/class="fx-lane-node"/g) || []).length, 2, "泳道里入口、落地两张卡");
  assert.match(html, />42 ms</, "只有一段时端到端延迟就写在那一段上");
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
  const html = renderToStaticMarkup(<LineCard line={line} />);
  assert.match(html, /订阅「美国 01」/);
  assert.match(html, /data-state="planned"/, "隧道没有分段探测，段上画「—」");
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
  const html = renderToStaticMarkup(<LineCard line={line} />);
  assert.match(html, />23 ms</);
  assert.match(html, />50 ms</);
});
