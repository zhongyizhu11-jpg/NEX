import assert from "node:assert/strict";
import test from "node:test";

import { buildProxySubscriptionPlan } from "./proxySubscriptionPlan";
import { buildProxySubPipelineDocument, renderProxySubPipeline } from "./proxySubscriptionPipeline";
import { PROXY_SUBSCRIPTION_FORMATS, type ProxySubscriptionFormat } from "./proxySubscription";
import { PROXY_SUB_DEFAULT_SETTINGS } from "./proxySubSettings";
import { PROXY_SUB_DEFAULT_TOKEN_OPTIONS, PROXY_SUB_EMPTY_SCOPE } from "./proxySubTokenScope";
import {
  addressLiteralOfFamily,
  countProxySubAddressFamilySkips,
  hostFamilyEntryAddresses,
  landingPoolFamilyEntryAddresses,
  parseProxySubIpVersion,
  selectProxySubPlanAddressFamily,
  type ProxySubIpVersion,
} from "./proxySubIpVersion";
import { buildProxySubscriptionUrl } from "./proxyClientImport";

/*
  三台入口：v4 + v6 都有、只有 v4（还配了入口域名）、只有 v6。
  两个落地：一个自建在有 v6 的机器上（开直连），一个粘来的、地址是域名（开直连）；
  第三个落地挂前置（前置是那个域名落地的直连），用来验「前置没有 v6 时挂它的也跳过」。
*/
const hosts = [
  { id: 1, name: "双栈入口", ip: "198.51.100.1", ipv4: "198.51.100.1", ipv6: "2001:db8::1", lastHeartbeat: 1 },
  { id: 2, name: "只有 v4", ip: "198.51.100.2", ipv4: "198.51.100.2", entryIp: "relay2.example.net", ddnsEnabled: true, ddnsDomain: "r2.ddns.example", lastHeartbeat: 1 },
  { id: 3, name: "只有 v6", ip: "2001:db8::3", ipv6: "2001:db8::3", lastHeartbeat: 1 },
  { id: 4, name: "香港落地机", ip: "203.0.113.4", ipv4: "203.0.113.4", ipv6: "[2001:db8:4::10]", geoCountryCode: "HK", lastHeartbeat: 1 },
];
const templates = [
  { id: 1, name: "香港自建", protocol: "trojan", address: "203.0.113.4", port: 443, password: "p", tls: true, sni: "hk.example.com", includeDirect: true, hostId: 4 },
  { id: 2, name: "粘来的日本", protocol: "shadowsocks", address: "jp.example.org", port: 8388, method: "aes-128-gcm", password: "x", includeDirect: true },
  { id: 3, name: "挂前置的美国", protocol: "vmess", address: "198.51.100.9", port: 443, uuid: "11111111-1111-4111-a111-111111111111", transport: "ws", path: "/v", frontProxyId: 2 },
];
const rules = [
  { id: 11, hostId: 1, name: "双栈中转", sourcePort: 31001, protocol: "both", proxyNodeId: 1, isEnabled: true, targetIp: "203.0.113.4", targetPort: 443 },
  { id: 12, hostId: 2, name: "v4 中转", sourcePort: 31002, protocol: "both", proxyNodeId: 1, isEnabled: true, targetIp: "203.0.113.4", targetPort: 443 },
  { id: 13, hostId: 3, name: "v6 中转", sourcePort: 31003, protocol: "both", proxyNodeId: 2, isEnabled: true, targetIp: "jp.example.org", targetPort: 8388 },
  { id: 14, hostId: 1, name: "美国中转", sourcePort: 31004, protocol: "both", proxyNodeId: 3, isEnabled: true, targetIp: "198.51.100.9", targetPort: 443 },
];

function plan() {
  return buildProxySubscriptionPlan({ rules: rules as never, templates: templates as never, hosts: hosts as never });
}

function built(ipVersion: ProxySubIpVersion | null, rulePreset: "off" | "minimal" = "off") {
  return buildProxySubPipelineDocument({
    plan: plan(),
    templates: templates as never,
    rulePreset,
    scope: PROXY_SUB_EMPTY_SCOPE,
    options: PROXY_SUB_DEFAULT_TOKEN_OPTIONS,
    settings: PROXY_SUB_DEFAULT_SETTINGS,
    vars: { appName: "NEX", panelUrl: "", subUrl: "", username: "u" },
    ipVersion,
  });
}

function render(ipVersion: ProxySubIpVersion | null, format: ProxySubscriptionFormat, profile = false) {
  const document = built(ipVersion, profile ? "minimal" : "off");
  return renderProxySubPipeline({
    built: document,
    format,
    profile,
    profileUrl: "",
    client: null,
    settings: PROXY_SUB_DEFAULT_SETTINGS,
    vars: { appName: "NEX", panelUrl: "", subUrl: "", username: "u", expireDate: "长期", dataLeft: "不限" },
    weightedLoadBalance: false,
    shadowrocketClient: false,
  });
}

test("ipVersion 参数：空 = 照旧，4 / 6 / v6 / ipv6 认得，别的报错", () => {
  assert.deepEqual(parseProxySubIpVersion(undefined), { ok: true, version: null });
  assert.deepEqual(parseProxySubIpVersion(""), { ok: true, version: null });
  assert.deepEqual(parseProxySubIpVersion("6"), { ok: true, version: "6" });
  assert.deepEqual(parseProxySubIpVersion("IPv4"), { ok: true, version: "4" });
  assert.deepEqual(parseProxySubIpVersion("v6"), { ok: true, version: "6" });
  assert.deepEqual(parseProxySubIpVersion(["6", "4"]), { ok: true, version: "6" });
  assert.equal(parseProxySubIpVersion("5").ok, false);
  assert.equal(parseProxySubIpVersion("64").ok, false);
});

test("入口机器的两种地址：手填 IP 字面量优先，域名不算，方括号去掉", () => {
  assert.deepEqual(hostFamilyEntryAddresses(hosts[0]), { ipv4: "198.51.100.1", ipv6: "2001:db8::1" });
  // 入口域名 / DDNS 域名不是「真实地址」，v4 用面板记下的 IPv4。
  assert.deepEqual(hostFamilyEntryAddresses(hosts[1]), { ipv4: "198.51.100.2", ipv6: "" });
  assert.deepEqual(hostFamilyEntryAddresses(hosts[2]), { ipv4: "", ipv6: "2001:db8::3" });
  assert.deepEqual(hostFamilyEntryAddresses({ ip: "198.51.100.5", entryIp: "[2001:db8::55]", ipv6: "2001:db8::5" }), { ipv4: "198.51.100.5", ipv6: "2001:db8::55" });
  assert.equal(addressLiteralOfFamily("jp.example.org", "ipv4"), "");
  assert.equal(addressLiteralOfFamily("[2001:db8::1]", "ipv6"), "2001:db8::1");
});

test("落地池：地址是哪台成员的就用哪台（没有就是没有，不换别台）；直连域名取第一台有的", () => {
  const members = [
    { ip: "203.0.113.1", ipv4: "203.0.113.1" },
    { ip: "203.0.113.2", ipv4: "203.0.113.2", ipv6: "2001:db8::2" },
    { ip: "203.0.113.3", ipv4: "203.0.113.3", ipv6: "2001:db8::3", entryIp: "m3.example.net" },
  ];
  assert.deepEqual(landingPoolFamilyEntryAddresses("203.0.113.1", members), { ipv4: "203.0.113.1", ipv6: "" });
  assert.deepEqual(landingPoolFamilyEntryAddresses("m3.example.net", members), { ipv4: "203.0.113.3", ipv6: "2001:db8::3" });
  assert.deepEqual(landingPoolFamilyEntryAddresses("pool.example.com", members), { ipv4: "203.0.113.1", ipv6: "2001:db8::2" });
  assert.deepEqual(landingPoolFamilyEntryAddresses("pool.example.com", []), { ipv4: "", ipv6: "" });
  // 模板行上填好的落地池地址，直连条目照着用。
  const poolPlan = buildProxySubscriptionPlan({
    rules: [],
    templates: [{ id: 9, name: "池", protocol: "trojan", address: "pool.example.com", port: 443, password: "p", includeDirect: true, nodePoolId: 1, entryIpv6: "2001:db8::2" }] as never,
    hosts: [],
  });
  assert.equal(selectProxySubPlanAddressFamily(poolPlan, "6").entries[0]?.node.address, "2001:db8::2");
  assert.equal(selectProxySubPlanAddressFamily(poolPlan, "4").entries.length, 0);
});

test("不带 ipVersion：plan 原样（同一个对象），输出和原来一样", () => {
  const original = plan();
  assert.equal(selectProxySubPlanAddressFamily(original, null), original);
  const document = built(null).document;
  assert.deepEqual(document.nodes.map((node) => node.address).sort(), ["198.51.100.1", "198.51.100.1", "203.0.113.4", "2001:db8::3", "jp.example.org", "relay2.example.net"].sort());
});

test("ipVersion=6：每条用真实 IPv6，没有的跳过（不退回 IPv4），挂着没 v6 前置的也跳过", () => {
  const document = built("6");
  const byName = new Map(document.document.nodes.map((node) => [node.name, node.address]));
  assert.equal(byName.get("双栈中转"), "2001:db8::1");
  assert.equal(byName.get("v6 中转"), "2001:db8::3");
  // 自建落地的直连：节点地址是 v4，用它所在机器的 IPv6（存的时候带了方括号，也要去掉）。
  assert.equal(byName.get("香港自建"), "2001:db8:4::10");
  assert.equal(byName.has("v4 中转"), false);
  assert.equal(byName.has("粘来的日本"), false);
  // 美国中转的入口有 v6，但它的前置（粘来的日本直连）没有：只摘前置会变成不经前置直连，所以整条跳过。
  assert.equal(byName.has("美国中转"), false);
  const skipped = document.plan.skipped.filter((item) => item.reason === "no-ipv6-address").map((item) => item.nodeName).sort();
  assert.deepEqual(skipped, ["v4 中转", "粘来的日本", "美国中转"].sort());
  assert.equal(countProxySubAddressFamilySkips(document.plan), 3);
});

test("ipVersion=4：入口域名、DDNS 域名换成真实 IPv4，只有 v6 的入口跳过", () => {
  const document = built("4");
  const byName = new Map(document.document.nodes.map((node) => [node.name, node.address]));
  assert.equal(byName.get("v4 中转"), "198.51.100.2");
  assert.equal(byName.get("双栈中转"), "198.51.100.1");
  assert.equal(byName.get("香港自建"), "203.0.113.4");
  assert.equal(byName.has("v6 中转"), false);
  assert.equal(byName.has("粘来的日本"), false);
  assert.equal(countProxySubAddressFamilySkips(document.plan), 3);
});

test("ipVersion=6 在每种格式里都写得对：URI 带方括号，其余的 server 字段是裸地址", () => {
  for (const format of PROXY_SUBSCRIPTION_FORMATS) {
    const body = render("6", format);
    assert.ok(!body.includes("198.51.100."), `${format} 里漏了 IPv4`);
  }
  const base64 = Buffer.from(render("6", "base64"), "base64").toString("utf8");
  assert.match(base64, /@\[2001:db8::1\]:31001/);
  const clash = render("6", "clash");
  assert.match(clash, /server: "2001:db8::1"/);
  assert.match(clash, /# 已跳过节点「v4 中转」：这条地址要求 IPv6/);
  const singbox = JSON.parse(render("6", "singbox"));
  assert.ok(singbox.outbounds.some((item: any) => item.server === "2001:db8::3"));
  const surge = render("6", "surge");
  assert.match(surge, /, 2001:db8::1, 31001/);
  const loon = render("6", "loon");
  assert.match(loon, /,2001:db8::1,31001|, ?2001:db8::1, ?31001/);
  const qx = render("6", "quantumultx");
  assert.match(qx, /=\[2001:db8::1\]:31001/);
  const xray = JSON.parse(render("6", "v2rayjson"));
  assert.ok(JSON.stringify(xray).includes("2001:db8::1"));
  // 规则订阅（完整配置）同样只出 v6。
  assert.ok(!render("6", "clash", true).includes("198.51.100."));
});

test("订阅地址可以钉死 ipVersion；不给时地址和原来一样", () => {
  const base = { origin: "https://panel.example", token: "t", format: "clash" as const, kind: "rules" as const };
  assert.equal(buildProxySubscriptionUrl(base), "https://panel.example/api/sub/t?format=clash&rules=1");
  assert.equal(buildProxySubscriptionUrl({ ...base, ipVersion: "6" }), "https://panel.example/api/sub/t?format=clash&rules=1&ipVersion=6");
  assert.equal(buildProxySubscriptionUrl({ ...base, ipVersion: null }), "https://panel.example/api/sub/t?format=clash&rules=1");
});
