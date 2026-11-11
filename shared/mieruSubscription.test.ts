import assert from "node:assert/strict";
import test from "node:test";

import { proxyClientCompatibility } from "./proxyClientCompatibility";
import { detectProxyClient } from "./proxyClientUserAgent";
import { createEmptyProxyNode, type ProxyNode } from "./proxyNode";
import { PROXY_SUBSCRIPTION_FORMATS, proxyNodeUnsupportedReasonForFormat, renderProxySubscription } from "./proxySubscription";
import { buildProxySubscriptionPlan, proxyNodeFromTemplateRow } from "./proxySubscriptionPlan";

function mieruNode(patch: Partial<ProxyNode> = {}): ProxyNode {
  return {
    ...createEmptyProxyNode(),
    protocol: "mieru",
    name: "M1",
    address: "203.0.113.9",
    port: 27001,
    username: "nexaaaa0001",
    password: "pw-a",
    mieruTransport: "TCP",
    udp: true,
    ...patch,
  };
}

function doc(nodes: ProxyNode[]) {
  return { nodes, groups: [], ruleSets: [], rules: [] };
}

test("Clash / mihomo：type: mieru，只写 TCP，端口段写 port-range 不写 port", () => {
  const single = renderProxySubscription(doc([mieruNode()]), "clash");
  assert.match(single, /type: mieru/);
  assert.match(single, /port: 27001/);
  assert.match(single, /transport: TCP/);
  assert.match(single, /username: "nexaaaa0001"/);
  assert.match(single, /password: "pw-a"/);
  assert.match(single, /udp: true/);

  const ranged = renderProxySubscription(doc([mieruNode({ portRangeEnd: 27009, mieruTransport: "BOTH" })]), "clash");
  assert.match(ranged, /port-range: "27001-27009"/);
  assert.doesNotMatch(ranged, /^\s+port: /m);
  assert.match(ranged, /transport: TCP/);
});

test("只开 UDP 承载的 Mieru：mihomo 也用不了，跳过并写明原因", () => {
  const clash = renderProxySubscription(doc([mieruNode({ mieruTransport: "UDP" })]), "clash");
  assert.doesNotMatch(clash, /type: mieru/);
  assert.match(clash, /已跳过节点「M1」：mihomo 的 Mieru 只支持 TCP 承载/);
});

test("其余格式都不进订阅，原因写清楚", () => {
  for (const format of PROXY_SUBSCRIPTION_FORMATS) {
    const reason = proxyNodeUnsupportedReasonForFormat(mieruNode(), format);
    if (format === "clash") {
      assert.equal(reason, "", format);
    } else {
      assert.match(reason, /不支持 Mieru/, format);
    }
  }
  const base64 = Buffer.from(renderProxySubscription(doc([mieruNode()]), "base64"), "base64").toString("utf8");
  assert.doesNotMatch(base64, /mierus:\/\//);
  assert.doesNotMatch(renderProxySubscription(doc([mieruNode()]), "singbox"), /mieru/);
  assert.match(renderProxySubscription(doc([mieruNode()]), "surge"), /已跳过节点「M1」：Surge \/ Surfboard 不支持 Mieru/);
  assert.match(renderProxySubscription(doc([mieruNode()]), "loon"), /已跳过节点「M1」：Loon 不支持 Mieru/);
  assert.match(renderProxySubscription(doc([mieruNode()]), "quantumultx"), /已跳过节点「M1」：Quantumult X 不支持 Mieru/);
});

test("同一份 Clash 订阅：Stash、原版 Clash、太旧的 mihomo 按 User-Agent 跳过", () => {
  const nodes = doc([mieruNode()]);
  const mihomo = detectProxyClient("mihomo/v1.19.3");
  assert.match(renderProxySubscription(nodes, "clash", { client: mihomo }), /type: mieru/);
  const oldMihomo = detectProxyClient("mihomo/v1.18.10");
  assert.match(renderProxySubscription(nodes, "clash", { client: oldMihomo }), /需要 1\.19\.0 以上/);
  const stash = detectProxyClient("Stash/2.7.0 Clash/1.11");
  assert.equal(stash.family, "stash");
  const stashOut = renderProxySubscription(nodes, "clash", { client: stash });
  assert.doesNotMatch(stashOut, /type: mieru/);
  assert.match(stashOut, /Stash 不支持 Mieru/);
});

test("客户端兼容表：只有 mihomo 能用", () => {
  const results = proxyClientCompatibility({ protocol: "mieru", transport: "tcp", security: "none", mieruTransport: "TCP" });
  const byId = new Map(results.map((item) => [item.id, item]));
  assert.equal(byId.get("mihomo")?.ok, true);
  for (const id of ["clash-premium", "stash", "singbox", "shadowrocket", "quantumultx", "surge", "surfboard", "loon", "hiddify", "v2rayn", "nekobox", "karing", "happ", "v2raytun", "streisand"]) {
    assert.equal(byId.get(id)?.ok, false, id);
    assert.ok(byId.get(id)?.why, id);
  }
  const udpOnly = proxyClientCompatibility({ protocol: "mieru", mieruTransport: "UDP" });
  assert.equal(udpOnly.find((item) => item.id === "mihomo")?.ok, false);
});

test("订阅计划：库里的行还原成 Mieru 节点；经只放 TCP 的转发时 BOTH 收成 TCP、只开 UDP 的跳过", () => {
  const row = {
    id: 5,
    protocol: "mieru",
    name: "M1",
    address: "203.0.113.9",
    port: 27001,
    username: "nexaaaa0001",
    password: "pw-a",
    portRangeEnd: 27009,
    mieruTransport: "BOTH",
    isEnabled: true,
  };
  const node = proxyNodeFromTemplateRow(row);
  assert.equal(node.username, "nexaaaa0001");
  assert.equal(node.portRangeEnd, 27009);
  assert.equal(node.mieruTransport, "BOTH");

  const hosts = [{ id: 1, name: "入口", ip: "198.51.100.1", ipv4: "198.51.100.1" }];
  const rule = (id: number, templateId: number, protocol: string) => ({
    id, hostId: 1, name: `r${id}`, sourcePort: 40000 + id, protocol, proxyNodeId: templateId, proxyNodeVisible: true, isEnabled: true, pendingDelete: false,
  });
  const plan = buildProxySubscriptionPlan({
    rules: [rule(1, 5, "tcp"), rule(2, 6, "tcp"), rule(3, 5, "both")],
    templates: [row, { ...row, id: 6, mieruTransport: "UDP" }],
    hosts,
  });
  const byPort = new Map(plan.entries.map((entry) => [entry.node.port, entry.node]));
  assert.equal(byPort.get(40001)?.mieruTransport, "TCP");
  assert.equal(byPort.get(40001)?.portRangeEnd, 0);
  assert.equal(byPort.get(40001)?.username, "nexaaaa0001");
  assert.equal(byPort.has(40002), false);
  assert.ok(plan.skipped.some((item: any) => item.reason === "udp-not-forwarded"));
  assert.equal(byPort.get(40003)?.mieruTransport, "BOTH");
});
