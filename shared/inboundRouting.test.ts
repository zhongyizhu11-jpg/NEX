import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSingboxRouting,
  describeInboundRoute,
  inboundRouteDomainSuffixes,
  inboundRoutingShapeError,
  INBOUND_ROUTE_PRESETS,
  normalizeRouteDomain,
  parseInboundRouting,
  parseRouteDomains,
  serializeInboundRouting,
} from "./inboundRouting";
import { UNLOCK_SERVICES } from "./unlockCheck";
import { buildSingboxConfig, createEmptyProxyInbound } from "./proxyInbound";

test("每个解锁检测的服务都有分流预设，id 一致（自动挑出口就是按这个 id 查检测结果）", () => {
  assert.deepEqual(INBOUND_ROUTE_PRESETS.map((preset) => preset.id), UNLOCK_SERVICES.map((service) => service.id));
  for (const preset of INBOUND_ROUTE_PRESETS) {
    assert.ok(preset.domains.length > 0, preset.id);
    for (const domain of preset.domains) assert.equal(normalizeRouteDomain(domain), domain, `${preset.id}: ${domain}`);
  }
});

test("自定义域名：去协议、路径、端口、*.，不像域名的丢掉", () => {
  assert.equal(normalizeRouteDomain("https://Www.Example.com:8443/path?q=1"), "www.example.com");
  assert.equal(normalizeRouteDomain("*.example.com"), "example.com");
  assert.equal(normalizeRouteDomain(".example.com."), "example.com");
  assert.equal(normalizeRouteDomain("localhost"), "");
  assert.equal(normalizeRouteDomain("exa mple.com"), "");
  assert.equal(normalizeRouteDomain("-bad.com"), "");
  assert.deepEqual(parseRouteDomains("a.com, b.com\nA.com；c.com"), ["a.com", "b.com", "c.com"]);
});

test("解析：坏条目丢掉，空了就是不分流；存储往返不变", () => {
  assert.equal(parseInboundRouting(null), null);
  assert.equal(parseInboundRouting(""), null);
  assert.equal(parseInboundRouting("{not json"), null);
  assert.equal(parseInboundRouting({ routes: [{ presets: ["nope"], domains: [], target: "direct" }] }), null);
  const routing = parseInboundRouting({
    routes: [
      { presets: ["netflix", "netflix", "nope"], domains: ["*.Foo.com"], target: "auto_unlock", landingInboundId: 9 },
      { presets: [], domains: ["ads.example.com"], target: "block" },
      { presets: ["chatgpt"], domains: [], target: "landing", landingInboundId: 3 },
    ],
  });
  assert.deepEqual(routing, {
    routes: [
      { presets: ["netflix"], domains: ["foo.com"], target: "auto_unlock", landingInboundId: 0 },
      { presets: [], domains: ["ads.example.com"], target: "block", landingInboundId: 0 },
      { presets: ["chatgpt"], domains: [], target: "landing", landingInboundId: 3 },
    ],
  });
  assert.deepEqual(parseInboundRouting(serializeInboundRouting(routing)), routing);
  assert.equal(serializeInboundRouting(null), null);
});

test("保存前的形态检查给出能看懂的原因", () => {
  assert.equal(inboundRoutingShapeError({ routes: [] }), null);
  assert.match(inboundRoutingShapeError({ routes: [{ presets: [], domains: [], target: "direct" }] })!, /没有选服务也没有填域名/);
  assert.match(inboundRoutingShapeError({ routes: [{ presets: [], domains: ["a.com", "not a domain"], target: "direct" }] })!, /「not a domain」不是域名/);
  assert.match(inboundRoutingShapeError({ routes: [{ presets: ["netflix"], domains: [], target: "landing", landingInboundId: 0 }] })!, /要选一台落地/);
  assert.match(inboundRoutingShapeError({ routes: [{ presets: [], domains: ["a.com"], target: "auto_unlock" }] })!, /至少要选一个服务/);
  assert.match(inboundRoutingShapeError({ routes: Array.from({ length: 11 }, () => ({ presets: ["netflix"], target: "direct" })) })!, /最多 10 条/);
});

test("预设 + 自定义域名合并去重；描述给人看", () => {
  const suffixes = inboundRouteDomainSuffixes({ presets: ["grok"], domains: ["x.ai", "extra.com"] });
  assert.deepEqual(suffixes, ["grok.com", "x.ai", "extra.com"]);
  assert.equal(describeInboundRoute({ presets: ["netflix", "disney"], domains: [], target: "auto_unlock", landingInboundId: 0 }), "Netflix、Disney+ → 自动：挑解锁的落地");
  assert.equal(describeInboundRoute({ presets: [], domains: ["a.com"], target: "landing", landingInboundId: 2 }, "美西"), "a.com → 走「美西」");
});

test("sing-box 路由：先嗅探，规则只限这个入站，同一个出口共用一个出站，没命中的直连", () => {
  const egress = { server: "203.0.113.9", port: 23456, method: "aes-256-gcm", password: "pw" };
  const built = buildSingboxRouting([
    { tag: "inbound-1", routes: [
      { domainSuffix: ["netflix.com"], action: "shadowsocks", egress },
      { domainSuffix: ["ads.example.com"], action: "block" },
      { domainSuffix: ["chatgpt.com"], action: "shadowsocks", egress: { ...egress } },
    ] },
    { tag: "inbound-2", routes: [] },
  ])!;
  assert.deepEqual(built.route, {
    rules: [
      { inbound: ["inbound-1"], action: "sniff" },
      { inbound: ["inbound-1"], domain_suffix: ["netflix.com"], action: "route", outbound: "route-ss-1" },
      { inbound: ["inbound-1"], domain_suffix: ["ads.example.com"], action: "reject" },
      { inbound: ["inbound-1"], domain_suffix: ["chatgpt.com"], action: "route", outbound: "route-ss-1" },
    ],
    final: "direct",
  });
  assert.deepEqual(built.outbounds, [{ type: "shadowsocks", tag: "route-ss-1", server: "203.0.113.9", server_port: 23456, method: "aes-256-gcm", password: "pw" }]);
  assert.equal(buildSingboxRouting([{ tag: "inbound-1", routes: [] }]), null);
});

test("没有分流时生成的配置和以前逐字节一致（老落地不会因为面板升级被重启）", () => {
  const inbound = { ...createEmptyProxyInbound(), protocol: "shadowsocks" as const, port: 8388, security: "none" as const, method: "aes-256-gcm", password: "x" };
  const plain = buildSingboxConfig([{ inbound, tag: "inbound-1" }]);
  assert.equal(buildSingboxConfig([{ inbound, tag: "inbound-1", routes: [] }]), plain);
  const config = JSON.parse(plain);
  assert.deepEqual(config.outbounds, [{ type: "direct", tag: "direct" }]);
  assert.equal(config.route, undefined);
  const routed = JSON.parse(buildSingboxConfig([{ inbound, tag: "inbound-1", routes: [{ domainSuffix: ["netflix.com"], action: "block" }] }]));
  assert.equal(routed.route.final, "direct");
  assert.equal(routed.outbounds[0].tag, "direct");
});
