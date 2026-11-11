import assert from "node:assert/strict";
import test from "node:test";
import { domainToASCII } from "node:url";

import {
  formatSniRuleEntry,
  isTlsInboundAgentSupported,
  normalizeSniAllowlist,
  normalizeSniName,
  normalizeSniNameList,
  sniAllowedByAllowlist,
  sniNamesOutsideAllowlist,
  sniRuleFormBlocker,
  tlsInboundAgentUpgradeMessage,
  tlsInboundRuleState,
  TLS_INBOUND_MAX_SNI_PER_RULE,
  urlHostnameToAscii,
  isRoutedSniRule,
  isSniRouteAgentSupported,
  isTlsInboundRoutedAgentSupported,
  pickMemberTlsInbound,
  sniInboundChoices,
  sniRuleRouteKind,
  TLS_INBOUND_ROUTED_AGENT_VERSION,
  tlsInboundRoutedAgentUpgradeMessage,
} from "./tlsInbound";

const toAscii = (value: string) => domainToASCII(value);

test("SNI 名字：小写、去末尾的点、IDNA 转 ASCII", () => {
  assert.deepEqual(normalizeSniName("  WWW.Example.COM. ", toAscii), { ok: true, name: "www.example.com" });
  assert.deepEqual(normalizeSniName("中文.example.com", toAscii), { ok: true, name: "xn--fiq228c.example.com" });
  // 浏览器那份（URL 解析）和服务端那份结论一致。
  assert.deepEqual(normalizeSniName("中文.example.com", urlHostnameToAscii), { ok: true, name: "xn--fiq228c.example.com" });
});

test("SNI 名字：IP、通配符、端口、协议、路径、坏的段一律拒绝", () => {
  const rejected = [
    "", "1.2.3.4", "::1", "[::1]", "2001:db8::1", "*.example.com", "example.com:443",
    "https://example.com", "example.com/path", "localhost", "-bad.example.com", "bad-.example.com",
    "a..example.com", `${"a".repeat(64)}.example.com`, "exa mple.com", "under_score.example.com", "example.123",
  ];
  for (const value of rejected) {
    const result = normalizeSniName(value, toAscii);
    assert.equal(result.ok, false, `应当拒绝：${value}`);
  }
  assert.equal(normalizeSniName(`${"a".repeat(63)}.example.com`, toAscii).ok, true);
});

test("SNI 列表：一行一个，去重排序，1-32 个", () => {
  assert.deepEqual(normalizeSniNameList("b.example.com\nA.example.com\nb.example.com.\n", toAscii), {
    ok: true,
    names: ["a.example.com", "b.example.com"],
  });
  assert.equal(normalizeSniNameList("  \n ", toAscii).ok, false);
  const many = Array.from({ length: TLS_INBOUND_MAX_SNI_PER_RULE + 1 }, (_, i) => `s${i}.example.com`).join("\n");
  assert.equal(normalizeSniNameList(many, toAscii).ok, false);
  const bad = normalizeSniNameList("ok.example.com\n*.example.com", toAscii);
  assert.equal(bad.ok, false);
  assert.match((bad as any).error, /通配符/);
});

test("白名单：example.com 含子域名，.example.com 只放子域名，空表示不限", () => {
  const allowlist = normalizeSniAllowlist("Example.com\n.tenant.net\n*.wild.org", toAscii);
  assert.deepEqual(allowlist, { ok: true, names: [".tenant.net", ".wild.org", "example.com"] });
  const list = (allowlist as any).names as string[];
  assert.equal(sniAllowedByAllowlist("example.com", list), true);
  assert.equal(sniAllowedByAllowlist("a.b.example.com", list), true);
  assert.equal(sniAllowedByAllowlist("badexample.com", list), false);
  assert.equal(sniAllowedByAllowlist("tenant.net", list), false);
  assert.equal(sniAllowedByAllowlist("app.tenant.net", list), true);
  assert.equal(sniAllowedByAllowlist("x.wild.org", list), true);
  assert.equal(sniAllowedByAllowlist("anything.io", []), true);
  assert.deepEqual(sniNamesOutsideAllowlist(["a.example.com", "evil.com"], list), ["evil.com"]);
});

test("Agent 版本门槛：2.2.224 起", () => {
  assert.equal(isTlsInboundAgentSupported("2.2.224"), true);
  assert.equal(isTlsInboundAgentSupported("v2.2.230"), true);
  assert.equal(isTlsInboundAgentSupported("2.2.223"), false);
  assert.equal(isTlsInboundAgentSupported(""), false);
  assert.equal(isTlsInboundAgentSupported(null), false);
  assert.match(tlsInboundAgentUpgradeMessage("HK"), /主机「HK」.*2\.2\.224.*需要升级 Agent/);
  assert.equal(tlsInboundRuleState({ inbound: { isEnabled: true }, agentVersion: "2.2.200" }), "agent_upgrade");
  assert.equal(tlsInboundRuleState({ inbound: { isEnabled: false }, agentVersion: "2.2.224" }), "inbound_disabled");
  assert.equal(tlsInboundRuleState({ inbound: null, agentVersion: "2.2.224" }), "inbound_missing");
  assert.equal(tlsInboundRuleState({ inbound: { isEnabled: 1 }, agentVersion: "2.2.224" }), "ok");
});

test("规则卡片那一行", () => {
  assert.equal(formatSniRuleEntry({ names: ["a.com", "b.com"], hostName: "HK", port: 443 }), "SNI：a.com、b.com @ HK:443");
  assert.equal(formatSniRuleEntry({ names: ["a.com", "b.com", "c.com", "d.com"], hostName: "HK", port: 443 }), "SNI：a.com、b.com、c.com 等 4 个 @ HK:443");
});

test("编辑框的提交拦截和服务端说同样的话", () => {
  const inbound = { allowedSni: ["example.com"], isEnabled: true, agentSupported: true, hostName: "HK" };
  const form = { tlsInboundId: 1, sniNamesText: "a.example.com", targetIp: "1.1.1.1", targetPort: 443 };
  assert.equal(sniRuleFormBlocker(form, inbound), null);
  assert.equal(sniRuleFormBlocker({ ...form, tlsInboundId: null }, inbound), "还没选共享 TLS 入站");
  assert.match(String(sniRuleFormBlocker({ ...form, sniNamesText: "evil.com" }, inbound)), /不在这个入站的白名单内/);
  assert.match(String(sniRuleFormBlocker(form, { ...inbound, agentSupported: false })), /需要升级 Agent/);
  assert.equal(sniRuleFormBlocker(form, { ...inbound, isEnabled: false }), "这个共享 TLS 入站已停用");
  assert.equal(sniRuleFormBlocker({ ...form, targetIp: "" }, inbound), "还缺目标地址");
});

test("转送规则（经隧道 / 转发链 / 转发组）的 Agent 门槛是一个具名常量，老规则不受影响", () => {
  assert.equal(TLS_INBOUND_ROUTED_AGENT_VERSION, "2.2.255");
  assert.equal(isTlsInboundRoutedAgentSupported("2.2.255"), true);
  assert.equal(isTlsInboundRoutedAgentSupported("2.2.252"), false);
  assert.equal(sniRuleRouteKind({}), "direct");
  assert.equal(sniRuleRouteKind({ tunnelId: 3 }), "tunnel");
  // 转发组的子规则可能也带着 tunnelId（隧道型组），按组算。
  assert.equal(sniRuleRouteKind({ tunnelId: 3, forwardGroupId: 9 }), "group");
  assert.equal(isRoutedSniRule({ tunnelId: null, forwardGroupId: null }), false);
  // 直连规则还是 2.2.224 就够；转送规则要 2.2.255。
  assert.equal(isSniRouteAgentSupported("direct", "2.2.230"), true);
  assert.equal(isSniRouteAgentSupported("tunnel", "2.2.230"), false);
  assert.equal(tlsInboundRuleState({ inbound: { isEnabled: true }, agentVersion: "2.2.230", routeKind: "group" }), "agent_upgrade");
  assert.equal(tlsInboundRuleState({ inbound: { isEnabled: true }, agentVersion: "2.2.230" }), "ok");
  assert.match(tlsInboundRoutedAgentUpgradeMessage("HK"), /主机「HK」.*2\.2\.255.*需要升级 Agent/);
  const inbound = { allowedSni: [], isEnabled: true, agentSupported: true, routedAgentSupported: false, hostName: "HK" };
  const form = { tlsInboundId: 1, sniNamesText: "a.example.com", targetIp: "1.1.1.1", targetPort: 443 };
  assert.equal(sniRuleFormBlocker(form, inbound), null);
  assert.match(String(sniRuleFormBlocker(form, inbound, undefined, "tunnel")), /2\.2\.255/);
});

test("转发组的每台入口机用自己身上和锚点同端口的入站；没有就是 null", () => {
  const inbounds = [
    { id: 1, hostId: 10, port: 443 },
    { id: 2, hostId: 11, port: 443 },
    { id: 3, hostId: 11, port: 8443 },
    { id: 5, hostId: 12, port: 8443 },
  ];
  const anchor = inbounds[0];
  assert.equal(pickMemberTlsInbound(anchor, 10, inbounds)?.id, 1);
  assert.equal(pickMemberTlsInbound(anchor, 11, inbounds)?.id, 2);
  assert.equal(pickMemberTlsInbound(anchor, 12, inbounds), null);
  assert.equal(pickMemberTlsInbound(null, 10, inbounds), null);
});

test("规则编辑框里能选的入站：按页签和所选资源列", () => {
  const inbounds = [
    { id: 1, hostId: 10, usable: true, isEnabled: true, tunnelIds: [7], forwardGroupIds: [20] },
    { id: 2, hostId: 11, usable: false, isEnabled: true, tunnelIds: [], forwardGroupIds: [20, 21] },
    { id: 3, hostId: 12, usable: true, isEnabled: false, tunnelIds: [8], forwardGroupIds: [] },
  ];
  // 端口转发页签：直连能用的 + 经端口转发资源 20 能用的（同一个入站经资源算另一项）。
  assert.deepEqual(sniInboundChoices(inbounds, { kind: "direct", portGroupIds: [20] }).map((choice) => choice.key), ["1:0", "1:20", "2:20"]);
  assert.deepEqual(sniInboundChoices(inbounds, { kind: "tunnel", tunnelId: 7 }).map((choice) => choice.key), ["1:0"]);
  // 停用的入站不列；编辑时规则挂着的那个留着。
  assert.deepEqual(sniInboundChoices(inbounds, { kind: "tunnel", tunnelId: 8 }).map((choice) => choice.key), []);
  assert.deepEqual(sniInboundChoices(inbounds, { kind: "tunnel", tunnelId: 8 }, { inboundId: 3 }).map((choice) => choice.key), ["3:0"]);
  assert.deepEqual(sniInboundChoices(inbounds, { kind: "group", forwardGroupId: 21 }).map((choice) => [choice.key, choice.forwardGroupId]), [["2:21", 21]]);
  assert.deepEqual(sniInboundChoices(inbounds, { kind: "group", forwardGroupId: null }), []);
});
