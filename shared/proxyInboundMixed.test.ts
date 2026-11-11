import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSingboxConfig,
  buildSingboxInbound,
  createEmptyProxyInbound,
  PROXY_INBOUND_PROTOCOLS,
  proxyInboundProtocolLabel,
  proxyInboundSecurities,
  proxyInboundSupportsMultiUser,
  proxyInboundTransports,
  proxyInboundUserCredentialKinds,
  proxyNodesFromInbound,
  validateProxyInbound,
  type ProxyInbound,
} from "./proxyInbound";
import { proxyClientCompatibility, PROXY_CLIENT_FAMILIES } from "./proxyClientCompatibility";
import { formatProxyNodeLink } from "./proxyNode";
import { PROXY_SUBSCRIPTION_FORMATS, proxyNodeUnsupportedReasonForFormat } from "./proxySubscription";

/**
 * Mixed 落地入站（sing-box 的 mixed：同一个端口 HTTP + SOCKS5）。sing-box 那一侧写成 mixed 入站；
 * 订阅里只发它的 SOCKS5 那一面 —— 各家客户端都能导入 SOCKS5，HTTP 代理节点不进订阅。
 */

function mixed(overrides: Partial<ProxyInbound> = {}): ProxyInbound {
  return {
    ...createEmptyProxyInbound(),
    protocol: "mixed",
    name: "家宽 Mixed",
    port: 7890,
    security: "none",
    transport: "tcp",
    users: [
      { id: 3, name: "小王", uuid: "user-a", password: "pass-a" },
      { id: 4, name: "小李", uuid: "user-b", password: "pass-b" },
    ],
    ...overrides,
  };
}

test("Mixed 是能开的入站协议：没有 TLS、只有 TCP、多用户（用户名 + 密码）", () => {
  assert.ok((PROXY_INBOUND_PROTOCOLS as readonly string[]).includes("mixed"));
  assert.deepEqual(proxyInboundSecurities("mixed"), ["none"]);
  assert.deepEqual(proxyInboundTransports("mixed"), ["tcp"]);
  assert.equal(proxyInboundSupportsMultiUser("mixed"), true);
  assert.deepEqual(proxyInboundUserCredentialKinds("mixed"), ["uuid", "password"]);
  assert.equal(proxyInboundProtocolLabel("mixed"), "Mixed（HTTP + SOCKS5）");
  assert.equal(proxyInboundProtocolLabel("socks5"), "SOCKS5");
  assert.equal(validateProxyInbound(mixed()), "");
  assert.match(validateProxyInbound(mixed({ users: [] })), /至少要有一个用户/);
  assert.match(validateProxyInbound(mixed({ security: "tls" })), /没有 TLS 层/);
});

test("sing-box 里是 mixed 入站，users 是 username / password", () => {
  assert.deepEqual(buildSingboxInbound(mixed(), "inbound-9"), {
    type: "mixed",
    tag: "inbound-9",
    listen: "::",
    listen_port: 7890,
    users: [
      { username: "user-a", password: "pass-a" },
      { username: "user-b", password: "pass-b" },
    ],
  });
  const config = JSON.parse(buildSingboxConfig([{ inbound: mixed(), tag: "inbound-9" }]));
  assert.equal(config.inbounds[0].type, "mixed");
});

test("派生给客户端的是 SOCKS5 节点（一个用户一条，不开 UDP）：HTTP 那一面不进订阅", () => {
  const nodes = proxyNodesFromInbound(mixed(), { address: "203.0.113.5" });
  assert.equal(nodes.length, 2);
  for (const { node } of nodes) {
    assert.equal(node.protocol, "socks5");
    assert.equal(node.udp, false);
    assert.equal(node.uuid, "");
    assert.match(formatProxyNodeLink(node), /^socks5?:\/\//);
  }
  assert.deepEqual(nodes.map(({ node }) => node.username), ["user-a", "user-b"]);
  // 每一种订阅格式都写得下这个 SOCKS5 节点。
  for (const format of PROXY_SUBSCRIPTION_FORMATS) {
    assert.equal(proxyNodeUnsupportedReasonForFormat(nodes[0].node, format), "", format);
  }
});

test("客户端兼容表：Mixed 和 SOCKS5 的结论逐家一样（进订阅的就是 SOCKS5 那一面）", () => {
  const asMixed = proxyClientCompatibility({ protocol: "mixed", transport: "tcp", security: "none" });
  const asSocks = proxyClientCompatibility({ protocol: "socks5", transport: "tcp", security: "none" });
  assert.equal(asMixed.length, PROXY_CLIENT_FAMILIES.length);
  assert.deepEqual(asMixed.map((row) => [row.id, row.ok]), asSocks.map((row) => [row.id, row.ok]));
});
