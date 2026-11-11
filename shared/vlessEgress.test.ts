import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalRealityPublicKey,
  isVlessEgressAgentSupported,
  maskVlessEgressEndpoint,
  parseVlessEgressLink,
  vlessEgressEndpointError,
  vlessEgressInboundError,
  VLESS_EGRESS_AGENT_VERSION,
  VLESS_EGRESS_TUNNEL_MESSAGE,
  VLESS_EGRESS_UDP_PACKET_ENCODING,
  VLESS_EGRESS_UDP_SUPPORTED,
} from "./vlessEgress";
import {
  NO_EGRESS_COLUMNS,
  RULE_EGRESS_TYPES,
  ruleEgressColumnsOf,
  ruleEgressProtocolOf,
  ruleEgressShapeError,
  ruleEgressSummaryText,
  ruleEgressUsesInbound,
  ruleEgressUsesLink,
} from "./ssEgress";

/**
 * VLESS Reality 出口的纯规则：外部链接只收 RAW/TCP + REALITY + Vision（别的组合拒绝并说清楚是哪一项）、
 * 落地入站能不能做出口、规则形态（UDP 和协议要对得上、不接隧道）、Agent 门槛。
 */

const PBK = "TiSmUw53M68pgep1_Cc7AXzh1QpUzeBM74jRZbWHj3Q";
const UUID = "0b9c2f7e-8a36-4a6e-9a51-3c2b1f2d4e5f";
const base = `vless://${UUID}@203.0.113.9:443?type=tcp&security=reality&encryption=none&flow=xtls-rprx-vision&sni=www.example.com&fp=chrome&pbk=${PBK}&sid=a1b2`;

test("标准的 RAW/TCP + REALITY + Vision 链接：原样解析出端点", () => {
  const parsed = parseVlessEgressLink(`${base}#东京%20落地`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.endpoint, {
    server: "203.0.113.9",
    port: 443,
    uuid: UUID,
    serverName: "www.example.com",
    publicKey: PBK,
    shortId: "a1b2",
    fingerprint: "chrome",
    name: "东京 落地",
  });
});

test("能原样表示的几种写法都收：type=raw、不带 fp（按 chrome）、spx=/、IPv6、标准 base64 的公钥", () => {
  for (const link of [
    base.replace("type=tcp", "type=raw"),
    base.replace("&fp=chrome", ""),
    `${base}&spx=%2F`,
    `${base}&headerType=none&host=&path=`,
    base.replace("203.0.113.9", "[2001:db8::9]"),
    base.replace(PBK, PBK.replace(/_/g, "/").replace(/-/g, "+")),
  ]) {
    const parsed = parseVlessEgressLink(link);
    assert.equal(parsed.ok, true, `${link}: ${parsed.ok ? "" : parsed.error}`);
  }
  const ipv6 = parseVlessEgressLink(base.replace("203.0.113.9", "[2001:db8::9]"));
  assert.equal(ipv6.ok && ipv6.endpoint.server, "2001:db8::9");
  const noFp = parseVlessEgressLink(base.replace("&fp=chrome", ""));
  assert.equal(noFp.ok && noFp.endpoint.fingerprint, "chrome");
});

test("表示不了的组合一律拒绝，并说清楚是哪一项", () => {
  const cases: Array<[string, RegExp]> = [
    [base.replace("type=tcp", "type=ws"), /RAW\/TCP/],
    [base.replace("type=tcp", "type=xhttp"), /RAW\/TCP/],
    [base.replace("security=reality", "security=tls"), /只支持 REALITY/],
    [base.replace("&flow=xtls-rprx-vision", ""), /Vision/],
    [base.replace("flow=xtls-rprx-vision", "flow=xtls-rprx-direct"), /xtls-rprx-vision/],
    [base.replace("encryption=none", "encryption=mlkem768x25519plus"), /encryption/],
    [`${base}&spx=%2Fsearch`, /spiderX/],
    [`${base}&pqv=abc`, /pqv/],
    [`${base}&extra=%7B%7D`, /extra/],
    [`${base}&mux=1`, /不认识的参数/],
    [`${base}&headerType=http`, /伪装头/],
    [`${base}&serviceName=grpc`, /servicename/],
    [`${base}&alpn=h2`, /alpn/],
    [`${base}&sni=a.com`, /两次/],
    [base.replace(`&pbk=${PBK}`, ""), /公钥/],
    [base.replace(PBK, "short"), /公钥/],
    [base.replace("sid=a1b2", "sid=xyz"), /short-id/],
    [base.replace("sni=www.example.com", "sni=1.2.3.4"), /不能是 IP/],
    [base.replace(UUID, "my-custom-id"), /UUID/],
    [base.replace("fp=chrome", "fp=unknown-browser"), /指纹/],
    [base.replace("203.0.113.9", "127.0.0.1"), /本机/],
    ["vless://YWVzOnV1aWRAMS4yLjMuNDo0NDM?tls=1", /Shadowrocket|UUID@/],
    ["ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:8388", /vless:\/\//],
    ["", /粘贴/],
  ];
  for (const [link, pattern] of cases) {
    const parsed = parseVlessEgressLink(link);
    assert.equal(parsed.ok, false, link);
    if (!parsed.ok) assert.match(parsed.error, pattern, `${link} → ${parsed.error}`);
  }
});

test("公钥规整：+/ 换成 -_，补齐去掉；长度、末位多余的比特不对就不认", () => {
  assert.equal(canonicalRealityPublicKey(PBK), PBK);
  assert.equal(canonicalRealityPublicKey(`${PBK}=`), PBK);
  assert.equal(canonicalRealityPublicKey(PBK.slice(0, 42)), "");
  // 最后一个字符的低 2 位不是 0：不是一份规范编码的 32 字节。
  assert.equal(canonicalRealityPublicKey(`${PBK.slice(0, 42)}R`), "");
});

test("打码：UUID 和公钥都不出现", () => {
  const parsed = parseVlessEgressLink(base);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const masked = maskVlessEgressEndpoint(parsed.endpoint);
  assert.equal(masked, "vless://******@203.0.113.9:443?security=reality&sni=www.example.com");
  assert.equal(masked.includes(UUID), false);
  assert.equal(masked.includes(PBK), false);
  assert.equal(vlessEgressEndpointError(parsed.endpoint), null);
});

test("落地入站能不能做 VLESS 出口：只收 VLESS + RAW/TCP + REALITY + Vision", () => {
  const good = { protocol: "vless", transport: "tcp", security: "reality", flow: "xtls-rprx-vision", realityPublicKey: PBK, serverName: "dl.google.com" };
  assert.equal(vlessEgressInboundError(good), null);
  assert.match(String(vlessEgressInboundError({ ...good, protocol: "vmess" })), /不是 VLESS/);
  assert.match(String(vlessEgressInboundError({ ...good, transport: "ws" })), /RAW\/TCP/);
  assert.match(String(vlessEgressInboundError({ ...good, security: "tls" })), /REALITY/);
  assert.match(String(vlessEgressInboundError({ ...good, flow: "" })), /Vision/);
  assert.match(String(vlessEgressInboundError({ ...good, realityPublicKey: "" })), /公钥/);
});

test("出口类型：VLESS 两种和 SS 两种共用 egressInboundId / egressConfigJson / egressUdp", () => {
  assert.deepEqual([...RULE_EGRESS_TYPES], ["none", "ss_host", "ss_link", "vless_host", "vless_link"]);
  assert.equal(ruleEgressProtocolOf("vless_host"), "vless");
  assert.equal(ruleEgressProtocolOf("ss_link"), "shadowsocks");
  assert.equal(ruleEgressProtocolOf("none"), null);
  assert.equal(ruleEgressUsesInbound("vless_host") && ruleEgressUsesLink("vless_link"), true);
  assert.deepEqual(ruleEgressColumnsOf({ egressType: "vless_host", egressInboundId: 9, egressConfigJson: "x", egressUdp: true }), {
    egressType: "vless_host", egressInboundId: 9, egressConfigJson: null, egressUdp: true,
  });
  assert.deepEqual(ruleEgressColumnsOf({ egressType: "vless_link", egressInboundId: 9, egressConfigJson: "enc", egressUdp: false }), {
    egressType: "vless_link", egressInboundId: null, egressConfigJson: "enc", egressUdp: false,
  });
  assert.deepEqual(ruleEgressColumnsOf({ egressType: "bogus" }), NO_EGRESS_COLUMNS);
  assert.equal(ruleEgressSummaryText({ type: "vless_host", landingHostName: "东京" }), "经 落地主机 东京 VLESS 出口");
  assert.equal(ruleEgressSummaryText({ type: "vless_link" }), "经 外部 VLESS 出口");
  // 「含 UDP」只看真的下发了 UDP（udp === true），不看勾没勾。
  assert.equal(ruleEgressSummaryText({ type: "vless_host", landingHostName: "东京", udp: true }), "经 落地主机 东京 VLESS 出口（含 UDP）");
  assert.equal(ruleEgressSummaryText({ type: "vless_link", udp: true }), "经 外部 VLESS 出口（含 UDP，需对端支持 UDP）");
  assert.equal(ruleEgressSummaryText({ type: "vless_link", udp: 1 }), "经 外部 VLESS 出口");
});

test("规则形态：VLESS 出口的 UDP 和协议要对得上、不接隧道、不接转发链 / 线路组", () => {
  const shape = { egressType: "vless_link", forwardType: "gost", protocol: "tcp", egressUdp: false };
  assert.equal(VLESS_EGRESS_UDP_SUPPORTED, true);
  assert.equal(VLESS_EGRESS_UDP_PACKET_ENCODING, "xudp");
  assert.equal(ruleEgressShapeError(shape), null);
  // 端口转发资源（realm 之类）照样能开：下发时这一条换成 gost。
  assert.equal(ruleEgressShapeError({ ...shape, forwardType: "realm", forwardGroupMode: "port" }), null);
  // UDP / TCP+UDP：UDP 跟着走出口；和 Shadowsocks 一样，UDP 不能绕过出口直连。
  assert.equal(ruleEgressShapeError({ ...shape, protocol: "both", egressUdp: true }), null);
  assert.equal(ruleEgressShapeError({ ...shape, egressType: "vless_host", protocol: "udp", egressUdp: true }), null);
  assert.match(String(ruleEgressShapeError({ ...shape, protocol: "both" })), /UDP 也要走出口/);
  assert.match(String(ruleEgressShapeError({ ...shape, protocol: "udp" })), /UDP 必须走出口/);
  assert.match(String(ruleEgressShapeError({ ...shape, egressUdp: true })), /不需要 UDP 走出口/);
  // 不看入口机的 ssEgressUdp 能力（形态检查本来也不拿主机），UDP 出口不依赖 NEX 运行时补丁。
  assert.equal(ruleEgressShapeError({ ...shape, tunnelId: 3, tunnelMode: "forwardx" }), VLESS_EGRESS_TUNNEL_MESSAGE);
  assert.match(String(ruleEgressShapeError({ ...shape, forwardGroupMode: "chain" })), /转发链/);
  assert.match(String(ruleEgressShapeError({ ...shape, failoverEnabled: true })), /线路组/);
  assert.match(String(ruleEgressShapeError({ ...shape, tlsInboundId: 2 })), /VLESS Reality/);
});

test("Agent 门槛：2.2.255 起；比它旧的不支持", () => {
  assert.equal(VLESS_EGRESS_AGENT_VERSION, "2.2.255");
  assert.equal(isVlessEgressAgentSupported("2.2.255"), true);
  assert.equal(isVlessEgressAgentSupported("2.3.0"), true);
  assert.equal(isVlessEgressAgentSupported("2.2.252"), false);
  assert.equal(isVlessEgressAgentSupported(""), false);
});
