import assert from "node:assert/strict";
import test from "node:test";

import { decodeBase64Utf8, formatProxyNodeLink, parseProxyNodeLink } from "./proxyNode";
import { renderProxySubscription } from "./proxySubscription";
import {
  buildSingboxInbound,
  createEmptyProxyInbound,
  proxyInboundSecurities,
  proxyInboundUserCredentialKinds,
  proxyNodeFromInbound,
  validateProxyInbound,
} from "./proxyInbound";

function parse(link: string) {
  const result = parseProxyNodeLink(link);
  assert.equal(result.ok, true, link);
  return (result as any).node;
}

test("SOCKS5 链接：base64 凭据、明文凭据、无认证都能认", () => {
  const b64 = parse(`socks://${Buffer.from("alice:p@ss:w").toString("base64")}@203.0.113.5:1080#HK%20socks`);
  assert.equal(b64.protocol, "socks5");
  assert.equal(b64.username, "alice");
  assert.equal(b64.password, "p@ss:w");
  assert.equal(b64.address, "203.0.113.5");
  assert.equal(b64.port, 1080);
  assert.equal(b64.name, "HK socks");

  const plain = parse("socks5://bob:s%40cret@[2001:db8::1]:1081#v6");
  assert.equal(plain.username, "bob");
  assert.equal(plain.password, "s@cret");
  assert.equal(plain.address, "2001:db8::1");

  const open = parse("socks5://198.51.100.1:1080");
  assert.equal(open.username, "");
  assert.equal(open.password, "");
  assert.equal(parseProxyNodeLink("socks5://bob:x@nohost").ok, false);
});

test("SOCKS5 链接能还原：socks://base64(用户:密码)@地址:端口", () => {
  const node = parse("socks5://bob:secret@198.51.100.1:1080#n");
  const link = formatProxyNodeLink(node);
  assert.match(link, /^socks:\/\/[A-Za-z0-9+/]+@198\.51\.100\.1:1080#n$/);
  const encoded = link.slice("socks://".length, link.indexOf("@"));
  assert.equal(decodeBase64Utf8(encoded), "bob:secret");
  const back = parse(link);
  assert.equal(back.username, "bob");
  assert.equal(back.password, "secret");
});

test("SOCKS5 在各家订阅里的写法", () => {
  const node = { ...parse("socks5://bob:secret@198.51.100.1:1080"), name: "S5" };
  const document = { nodes: [node], groups: [], ruleSets: [], rules: [] };
  const clash = renderProxySubscription(document, "clash");
  assert.match(clash, /type: socks5/);
  assert.match(clash, /username: "?bob"?/);
  assert.match(clash, /password: "?secret"?/);
  assert.doesNotMatch(clash, /type: ss\b/);

  const singbox = JSON.parse(renderProxySubscription(document, "singbox"));
  const outbound = singbox.outbounds.find((item: any) => item.tag === "S5");
  assert.equal(outbound.type, "socks");
  assert.equal(outbound.version, "5");
  assert.equal(outbound.username, "bob");
  assert.equal(outbound.tls, undefined);

  assert.match(renderProxySubscription(document, "surge"), /^S5 = socks5, 198\.51\.100\.1, 1080, bob, secret, udp-relay=/m);
  assert.match(renderProxySubscription(document, "loon"), /^S5 = socks5,198\.51\.100\.1,1080,bob,"secret",udp=/m);
  assert.match(renderProxySubscription(document, "quantumultx"), /^socks5=198\.51\.100\.1:1080, username=bob, password=secret, udp-relay=.*tag=S5$/m);
  const base64 = decodeBase64Utf8(renderProxySubscription(document, "base64"));
  assert.match(base64, /^socks:\/\//);
});

test("SOCKS5 落地：多用户、用户名 + 密码、不加密，sing-box 入站 type 是 socks", () => {
  assert.deepEqual(proxyInboundSecurities("socks5"), ["none"]);
  assert.deepEqual(proxyInboundUserCredentialKinds("socks5"), ["uuid", "password"]);
  const inbound = {
    ...createEmptyProxyInbound(),
    protocol: "socks5" as const,
    name: "S5 落地",
    port: 1080,
    transport: "tcp" as const,
    security: "none" as const,
    users: [{ id: 3, name: "小王", uuid: "u-abc", password: "pw-1" }],
  };
  assert.equal(validateProxyInbound(inbound), "");
  assert.notEqual(validateProxyInbound({ ...inbound, users: [] }), "");
  const singbox = buildSingboxInbound(inbound, "in-1");
  assert.equal(singbox.type, "socks");
  assert.deepEqual(singbox.users, [{ username: "u-abc", password: "pw-1" }]);
  assert.equal(singbox.tls, undefined);
  const node = proxyNodeFromInbound(inbound, { address: "203.0.113.9" });
  assert.equal(node.protocol, "socks5");
  assert.equal(node.username, "u-abc");
  assert.equal(node.password, "pw-1");
  assert.equal(node.uuid, "");
  assert.equal(node.udp, false);
});
