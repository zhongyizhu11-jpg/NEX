import assert from "node:assert/strict";
import test from "node:test";

import { parseProxyNodeLink } from "./proxyNode";
import { looksLikeProxyNodeJson, parseProxyNodeJson } from "./proxyNodeJson";

const ok = (input: unknown) => {
  const result = parseProxyNodeJson(input);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result;
};

test("sing-box 出站：地址端口在 server / server_port", () => {
  const { node, source } = ok(JSON.stringify({
    type: "vless",
    tag: "HKT 落地",
    server: "154.36.174.85",
    server_port: 63284,
    uuid: "8f1c-uuid",
    flow: "xtls-rprx-vision",
    tls: { enabled: true, server_name: "a.example.com", utls: { fingerprint: "chrome" } },
  }));

  assert.equal(source, "singbox-outbound");
  assert.equal(node.protocol, "vless");
  assert.equal(node.name, "HKT 落地");
  assert.equal(node.address, "154.36.174.85");
  assert.equal(node.port, 63284);
  assert.equal(node.uuid, "8f1c-uuid");
  assert.equal(node.flow, "xtls-rprx-vision");
  assert.equal(node.tls, true);
  assert.equal(node.sni, "a.example.com");
  assert.equal(node.fingerprint, "chrome");
});

test("sing-box 出站的 Reality 参数", () => {
  const { node } = ok(JSON.stringify({
    type: "vless", server: "1.2.3.4", server_port: 443, uuid: "u",
    tls: { enabled: true, server_name: "www.microsoft.com", reality: { enabled: true, public_key: "pk-1", short_id: "sid" } },
  }));

  assert.equal(node.realityPublicKey, "pk-1");
  assert.equal(node.realityShortId, "sid");
});

test("sing-box 的 grpc 用 service_name，ws 用 path", () => {
  const grpc = ok(JSON.stringify({
    type: "vless", server: "1.2.3.4", server_port: 443, uuid: "u",
    transport: { type: "grpc", service_name: "mygrpc" },
  })).node;
  assert.equal(grpc.transport, "grpc");
  assert.equal(grpc.path, "mygrpc");

  const ws = ok(JSON.stringify({
    type: "vmess", server: "1.2.3.4", server_port: 443, uuid: "u",
    transport: { type: "ws", path: "/ray", headers: { Host: "cdn.example.com" } },
  })).node;
  assert.equal(ws.transport, "ws");
  assert.equal(ws.path, "/ray");
  assert.equal(ws.host, "cdn.example.com");
});

test("Clash 节点条目：端口在 port，servername 是 SNI", () => {
  const { node, source } = ok(JSON.stringify({
    name: "广州中转",
    type: "vless",
    server: "42.194.198.67",
    port: 44760,
    uuid: "clash-uuid",
    tls: true,
    servername: "b.example.com",
    network: "ws",
    "ws-opts": { path: "/p", headers: { Host: "h.example.com" } },
    "skip-cert-verify": true,
  }));

  assert.equal(source, "clash-proxy");
  assert.equal(node.name, "广州中转");
  assert.equal(node.address, "42.194.198.67");
  assert.equal(node.port, 44760);
  assert.equal(node.sni, "b.example.com");
  assert.equal(node.transport, "ws");
  assert.equal(node.path, "/p");
  assert.equal(node.host, "h.example.com");
  assert.equal(node.allowInsecure, true);
});

test("Clash 的 trojan 用 sni 而不是 servername，且默认走 TLS", () => {
  const { node } = ok(JSON.stringify({
    name: "T", type: "trojan", server: "1.2.3.4", port: 443, password: "pw", sni: "t.example.com",
  }));

  assert.equal(node.protocol, "trojan");
  assert.equal(node.password, "pw");
  assert.equal(node.sni, "t.example.com");
  assert.equal(node.tls, true, "trojan 本来就是 TLS 上跑的");
});

test("Clash 的 Shadowsocks：cipher 对应加密方式", () => {
  const { node } = ok(JSON.stringify({
    name: "SS", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "pw",
  }));

  assert.equal(node.protocol, "shadowsocks");
  assert.equal(node.method, "aes-128-gcm");
  assert.equal(node.password, "pw");
});

test("v2rayN 的 VMess JSON", () => {
  const { node, source } = ok(JSON.stringify({
    v: "2", ps: "东京", add: "1.2.3.4", port: "443", id: "vmess-uuid",
    aid: "0", net: "ws", path: "/vm", host: "cdn.example.com", tls: "tls", scy: "auto",
  }));

  assert.equal(source, "vmess-v2rayn");
  assert.equal(node.protocol, "vmess");
  assert.equal(node.name, "东京");
  assert.equal(node.port, 443, "端口是字符串也要认");
  assert.equal(node.uuid, "vmess-uuid");
  assert.equal(node.transport, "ws");
  assert.equal(node.tls, true);
  assert.equal(node.sni, "cdn.example.com", "没给 sni 时回落到 host");
});

test("完整客户端配置：跳过 direct / block，取第一个真代理", () => {
  const { node } = ok(JSON.stringify({
    outbounds: [
      { type: "direct", tag: "direct" },
      { type: "block", tag: "block" },
      { type: "trojan", tag: "真节点", server: "9.9.9.9", server_port: 443, password: "pw" },
    ],
  }));

  assert.equal(node.protocol, "trojan");
  assert.equal(node.name, "真节点");
  assert.equal(node.address, "9.9.9.9");
});

test("只有 direct / block 时说清楚，而不是报「格式错误」", () => {
  const result = parseProxyNodeJson(JSON.stringify({ outbounds: [{ type: "direct" }, { type: "block" }] }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /没有代理节点/);
});

// ==================== 服务端配置 ====================

test("Xray 服务端配置：从 settings.clients 取 UUID，但地址是空的", () => {
  // 服务端配置的 listen 是 0.0.0.0，它不知道自己的公网地址。这不能猜 ——
  // 猜错会生成一个连不上的节点，而用户在客户端侧看不出原因。
  const result = ok(JSON.stringify({
    inbounds: [{
      listen: "0.0.0.0",
      port: 63284,
      protocol: "vless",
      settings: { clients: [{ id: "server-uuid", flow: "xtls-rprx-vision" }] },
      streamSettings: {
        network: "tcp",
        security: "reality",
        realitySettings: { serverNames: ["www.microsoft.com"], shortIds: ["ab"] },
      },
    }],
  }));

  assert.equal(result.source, "server-inbound");
  assert.equal(result.node.uuid, "server-uuid");
  assert.equal(result.node.port, 63284);
  assert.equal(result.node.flow, "xtls-rprx-vision");
  assert.equal(result.node.sni, "www.microsoft.com");
  assert.equal(result.node.address, "", "0.0.0.0 不是公网地址");
  assert.equal(result.needsAddress, true, "必须提示用户补地址");
});

test("sing-box 服务端配置：用户在 users 数组里", () => {
  const result = ok(JSON.stringify({
    inbounds: [{
      type: "vless",
      listen: "::",
      listen_port: 443,
      users: [{ uuid: "sb-uuid", flow: "xtls-rprx-vision" }],
      tls: { enabled: true, server_name: "s.example.com" },
    }],
  }));

  assert.equal(result.node.uuid, "sb-uuid");
  assert.equal(result.node.port, 443);
  assert.equal(result.node.tls, true);
  assert.equal(result.needsAddress, true, ":: 同样不是公网地址");
});

test("服务端配置写了真实地址时不再要求补", () => {
  const result = ok(JSON.stringify({
    inbounds: [{ type: "trojan", listen: "203.0.113.9", listen_port: 443, users: [{ password: "pw" }] }],
  }));

  assert.equal(result.node.address, "203.0.113.9");
  assert.equal(result.needsAddress, false);
});

// ==================== 入口与错误 ====================

test("parseProxyNodeLink 同一个入口既吃链接也吃 JSON", () => {
  // 用户不该关心自己粘的是哪一种。
  const link = parseProxyNodeLink("vless://u@1.2.3.4:443?security=tls#L");
  const json = parseProxyNodeLink('{"type":"vless","server":"1.2.3.4","server_port":443,"uuid":"u","tls":{"enabled":true}}');

  assert.ok(link.ok && json.ok);
  assert.equal(link.node.protocol, json.node.protocol);
  assert.equal(link.node.address, json.node.address);
  assert.equal(link.node.port, json.node.port);
});

test("缺公网地址的服务端配置，从统一入口进来时给出可操作的提示", () => {
  const result = parseProxyNodeLink(JSON.stringify({
    inbounds: [{ type: "vless", listen: "0.0.0.0", listen_port: 443, users: [{ uuid: "u" }] }],
  }));

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /地址/);
});

test("JSON 形状判断只看开头，不做解析", () => {
  assert.equal(looksLikeProxyNodeJson('  {"a":1}'), true);
  assert.equal(looksLikeProxyNodeJson("[{}]"), true);
  assert.equal(looksLikeProxyNodeJson("vless://x"), false);
  assert.equal(looksLikeProxyNodeJson(""), false);
});

test("坏 JSON 的报错要说人话", () => {
  const result = parseProxyNodeJson('{"type":"vless"');
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /花括号/);
});

test("认得结构但协议不支持时，说明支持哪些", () => {
  // 换成一个真的不支持的协议；hysteria2 已经支持了。
  const result = parseProxyNodeJson(JSON.stringify({ type: "ssr", server: "1.2.3.4", port: 443, password: "p" }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /VLESS/);
});

test("缺凭据的配置不放过", () => {
  // 没有 UUID 也没有密码的节点导进去必然连不上，不如当场报错。
  const result = parseProxyNodeJson(JSON.stringify({ type: "vless", server: "1.2.3.4", server_port: 443 }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /UUID|密码/);
});

// ==================== Hysteria2 / TUIC / AnyTLS 的 JSON ====================

test("sing-box 的 hysteria2 出站：混淆是对象", () => {
  const { node } = ok(JSON.stringify({
    type: "hysteria2",
    tag: "HY2",
    server: "hk.example.com",
    server_port: 8443,
    password: "pw",
    obfs: { type: "salamander", password: "ob" },
    tls: { enabled: true, server_name: "hk.example.com", alpn: ["h3"] },
  }));

  assert.equal(node.protocol, "hysteria2");
  assert.equal(node.password, "pw");
  assert.equal(node.obfs, "salamander");
  assert.equal(node.obfsPassword, "ob");
  assert.deepEqual(node.alpn, ["h3"]);
  assert.equal(node.tls, true);
});

test("sing-box 的 tuic 出站：下划线键名，disable_sni 在 tls 里", () => {
  const { node } = ok(JSON.stringify({
    type: "tuic",
    server: "hk.example.com",
    server_port: 443,
    uuid: "uuid-1",
    password: "pw",
    congestion_control: "bbr",
    udp_relay_mode: "native",
    tls: { enabled: true, disable_sni: true },
  }));

  assert.equal(node.protocol, "tuic");
  assert.equal(node.congestionControl, "bbr");
  assert.equal(node.udpRelayMode, "native");
  assert.equal(node.disableSni, true);
});

test("mihomo 的 tuic 条目：连字符键名", () => {
  const { node } = ok(JSON.stringify({
    name: "TUIC",
    type: "tuic",
    server: "hk.example.com",
    port: 443,
    uuid: "uuid-1",
    password: "pw",
    "congestion-controller": "bbr",
    "udp-relay-mode": "native",
    "disable-sni": true,
  }));

  assert.equal(node.protocol, "tuic");
  assert.equal(node.congestionControl, "bbr");
  assert.equal(node.udpRelayMode, "native");
  assert.equal(node.disableSni, true);
  // 条目里没有 tls 字段，但 TUIC 的 TLS 是协议自带的。
  assert.equal(node.tls, true);
});

test("mihomo 的 anytls 与 hysteria2 条目", () => {
  const anytls = ok(JSON.stringify({
    name: "AT", type: "anytls", server: "hk.example.com", port: 443, password: "pw", sni: "hk.example.com",
  })).node;
  assert.equal(anytls.protocol, "anytls");
  assert.equal(anytls.password, "pw");
  assert.equal(anytls.tls, true);

  const hy2 = ok(JSON.stringify({
    name: "HY2", type: "hysteria2", server: "hk.example.com", port: 8443,
    password: "pw", obfs: "salamander", "obfs-password": "ob",
  })).node;
  assert.equal(hy2.protocol, "hysteria2");
  assert.equal(hy2.obfs, "salamander");
  assert.equal(hy2.obfsPassword, "ob");
});

test("hysteria v1 与 hysteria2 是两个协议，v1 仍然不支持", () => {
  const result = parseProxyNodeJson(JSON.stringify({
    type: "hysteria", server: "hk.example.com", server_port: 443, auth_str: "pw",
  }));
  assert.equal(result.ok, false);
});

// ==================== Snell 与 XHTTP 的 JSON ====================

test("mihomo 的 snell 条目：psk 与 obfs-opts", () => {
  const { node } = ok(JSON.stringify({
    name: "S4", type: "snell", server: "hk.example.com", port: 8000,
    psk: "my-psk", version: 4, udp: true,
    "obfs-opts": { mode: "http", host: "bing.com" },
  }));

  assert.equal(node.protocol, "snell");
  // Snell 的鉴权字段是 psk，不是 password。
  assert.equal(node.password, "my-psk");
  assert.equal(node.snellVersion, 4);
  assert.equal(node.obfs, "http");
  assert.equal(node.host, "bing.com");
  // 走裸 TCP，不该被当成 TLS 节点。
  assert.equal(node.tls, false);
});

test("sing-box 的 snell 出站：v6 用 mode", () => {
  const { node } = ok(JSON.stringify({
    type: "snell", server: "hk.example.com", server_port: 8000,
    psk: "my-psk", version: 6, mode: "unshaped",
  }));

  assert.equal(node.protocol, "snell");
  assert.equal(node.snellVersion, 6);
  assert.equal(node.snellMode, "unshaped");
});

test("mihomo 的 xhttp-opts 读得出 mode", () => {
  const { node } = ok(JSON.stringify({
    name: "XH", type: "vless", server: "hk.example.com", port: 443, uuid: "u",
    network: "xhttp", tls: true, servername: "a.com",
    "xhttp-opts": { path: "/x", host: "a.com", mode: "stream-one" },
  }));

  assert.equal(node.transport, "xhttp");
  assert.equal(node.path, "/x");
  // mode 两端不一致就连不上，不是可选项。
  assert.equal(node.xhttpMode, "stream-one");
});

test("妙妙屋X 那种 Snell 服务端入站：psk 在 users 里", () => {
  const result = parseProxyNodeJson(JSON.stringify({
    tag: "snell-in", listen: "0.0.0.0", port: 8443, protocol: "snell",
    settings: { users: [{ psk: "your-psk", version: 4, obfsMode: "http", email: "u@e.com" }] },
  }));

  assert.ok(result.ok, result.ok ? "" : result.error);
  // 服务端配置的 listen 是 0.0.0.0，公网地址得由调用方补。
  assert.equal(result.needsAddress, true);
  assert.equal(result.node.protocol, "snell");
  assert.equal(result.node.password, "your-psk");
  assert.equal(result.node.snellVersion, 4);
  assert.equal(result.node.obfs, "http");
});

test("妙妙屋X 那种 AnyTLS 服务端入站：password 也在 settings.users 里", () => {
  const result = parseProxyNodeJson(JSON.stringify({
    tag: "anytls-in", listen: "0.0.0.0", port: 443, protocol: "anytls",
    settings: { users: [{ password: "your-password", email: "u@e.com" }], paddingScheme: ["stop=8"] },
    streamSettings: { network: "tcp", security: "tls", tlsSettings: { serverName: "your.domain.com" } },
  }));

  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.node.protocol, "anytls");
  assert.equal(result.node.password, "your-password");
  assert.equal(result.node.sni, "your.domain.com");
  assert.equal(result.node.tls, true);
});

test("hysteria2 的带宽：mihomo 的 up/down 带单位、Stash 的 up-speed/down-speed 与 auth、sing-box 的 up_mbps/down_mbps", () => {
  const mihomo = ok(JSON.stringify({
    name: "HY2", type: "hysteria2", server: "1.2.3.4", port: 443, password: "pw", up: "30 Mbps", down: "1 Gbps",
  }));
  assert.equal(mihomo.node.upMbps, 30);
  assert.equal(mihomo.node.downMbps, 1000);

  const stash = ok(JSON.stringify({
    name: "HY2", type: "hysteria2", server: "1.2.3.4", port: 443, auth: "pw", "up-speed": 20, "down-speed": 200,
  }));
  assert.equal(stash.node.password, "pw");
  assert.equal(stash.node.upMbps, 20);
  assert.equal(stash.node.downMbps, 200);

  const singbox = ok(JSON.stringify({
    type: "hysteria2", tag: "HY2", server: "1.2.3.4", server_port: 443, password: "pw", up_mbps: 10, down_mbps: 100,
  }));
  assert.equal(singbox.node.upMbps, 10);
  assert.equal(singbox.node.downMbps, 100);

  // 不填、填错都当成没声明。
  const none = ok(JSON.stringify({ name: "HY2", type: "hysteria2", server: "1.2.3.4", port: 443, password: "pw", up: "fast" }));
  assert.equal(none.node.upMbps, 0);
  assert.equal(none.node.downMbps, 0);
});
