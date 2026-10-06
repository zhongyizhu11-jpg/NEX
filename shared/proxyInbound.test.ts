import assert from "node:assert/strict";
import test from "node:test";

import { parseProxyNodeLink } from "./proxyNode";
import { renderProxySubscription } from "./proxySubscription";
import {
  buildSingboxConfig,
  buildSingboxInbound,
  PROXY_INBOUND_SNELL_VERSIONS,
  createEmptyProxyInbound,
  isValidRealityShortId,
  proxyInboundRealityDest,
  proxyInboundNeedsCertificate,
  proxyInboundSecurities,
  proxyInboundSupportsMultiUser,
  proxyInboundUserCredentialKinds,
  proxyNodesFromInbound,
  proxyInboundTransports,
  proxyNodeFromInbound,
  proxyInboundEnumFieldError,
  validateProxyInbound,
  type ProxyInbound,
} from "./proxyInbound";

function inbound(overrides: Partial<ProxyInbound>): ProxyInbound {
  return { ...createEmptyProxyInbound(), ...overrides };
}

const VLESS_REALITY = inbound({
  protocol: "vless",
  name: "HK 落地",
  port: 443,
  security: "reality",
  // VLESS 是多用户协议，凭据在 users 上而不在入站行上。
  users: [{ id: 1, name: "默认", uuid: "8f1c-uuid", password: "" }],
  flow: "xtls-rprx-vision",
  serverName: "dl.google.com",
  realityPrivateKey: "PRIV",
  realityPublicKey: "PUB",
  realityShortId: "ab12",
});

// ==================== 组合校验 ====================

test("REALITY 只对 TCP 系协议开放", () => {
  // REALITY 是架在 TCP 的 TLS 之上的，QUIC 那一层没有它的位置。
  assert.deepEqual(proxyInboundSecurities("vless"), ["reality", "acme", "tls", "none"]);
  assert.deepEqual(proxyInboundSecurities("trojan"), ["reality", "acme", "tls"]);
  assert.deepEqual(proxyInboundSecurities("hysteria2"), ["acme", "tls"]);
  assert.deepEqual(proxyInboundSecurities("tuic"), ["acme", "tls"]);
  // AnyTLS 的服务端能开 REALITY，但主流客户端都明说不支持，开出来没人连得上。
  assert.deepEqual(proxyInboundSecurities("anytls"), ["acme", "tls"]);
  // 这两个压根没有 TLS 层。
  assert.deepEqual(proxyInboundSecurities("shadowsocks"), ["none"]);
  assert.deepEqual(proxyInboundSecurities("snell"), ["none"]);
});

test("不成立的协议与安全层组合会被挡住，并说清为什么", () => {
  const quic = validateProxyInbound(inbound({
    protocol: "hysteria2", port: 8443, security: "reality",
    users: [{ id: 1, name: "默认", uuid: "", password: "pw" }],
    realityPrivateKey: "PRIV", realityPublicKey: "PUB", serverName: "a.com",
  }));
  assert.match(quic, /REALITY 只能架在 TCP/);

  const ss = validateProxyInbound(inbound({
    protocol: "shadowsocks", port: 8388, security: "tls", method: "aes-256-gcm", password: "pw",
  }));
  assert.match(ss, /没有 TLS 层/);

  const trojan = validateProxyInbound(inbound({
    protocol: "trojan", port: 443, security: "none",
    users: [{ id: 1, name: "默认", uuid: "", password: "pw" }],
  }));
  assert.match(trojan, /自带 TLS/);
});

test("XHTTP 开不出来，但要说清「能中转」和「能自建」是两回事", () => {
  // sing-box 不实现 XHTTP，硬存下去只会得到一个没有传输块的入站。
  assert.ok(!proxyInboundTransports("vless").includes("xhttp"));
  const reason = validateProxyInbound({ ...VLESS_REALITY, transport: "xhttp" });
  assert.match(reason, /XHTTP 是 Xray 的传输/);
  assert.match(reason, /仍然可以粘进来中转/);
});

test("缺凭据、缺密钥、缺证书路径都当场报错", () => {
  assert.match(
    validateProxyInbound({ ...VLESS_REALITY, users: [{ id: 1, name: "小王", uuid: "", password: "" }] }),
    /小王.*缺少 UUID/,
  );
  assert.match(validateProxyInbound({ ...VLESS_REALITY, realityPrivateKey: "" }), /缺少 REALITY 私钥/);
  assert.match(validateProxyInbound({ ...VLESS_REALITY, serverName: "" }), /握手域名/);
  assert.match(
    validateProxyInbound(inbound({
      protocol: "trojan", port: 443, security: "tls",
      users: [{ id: 1, name: "默认", uuid: "", password: "pw" }],
    })),
    /证书和私钥的路径/,
  );
  assert.match(
    validateProxyInbound(inbound({ protocol: "snell", port: 8000, security: "none", password: "psk" })),
    /Snell 入站只支持/,
  );
});

test("REALITY 的 short-id 必须是 0 到 8 字节的十六进制", () => {
  assert.equal(isValidRealityShortId(""), true);
  assert.equal(isValidRealityShortId("ab12"), true);
  assert.equal(isValidRealityShortId("0123456789abcdef"), true);
  // 奇数长度不是完整字节
  assert.equal(isValidRealityShortId("abc"), false);
  // 超过 8 字节
  assert.equal(isValidRealityShortId("0123456789abcdef00"), false);
  // 非十六进制
  assert.equal(isValidRealityShortId("zzzz"), false);
  assert.match(validateProxyInbound({ ...VLESS_REALITY, realityShortId: "abc" }), /short-id/);
});

test("完整的配置校验通过", () => {
  assert.equal(validateProxyInbound(VLESS_REALITY), "");
});

test("原样写进 sing-box 的枚举字段只收已知取值", () => {
  // 一个租户存进一个 sing-box 不认识的值，同机整份配置都会 check 失败。
  assert.match(validateProxyInbound({ ...VLESS_REALITY, flow: "xtls-rprx-direct" }), /不支持的流控/);
  assert.equal(validateProxyInbound({ ...VLESS_REALITY, flow: "" }), "");
  const hy2 = inbound({
    protocol: "hysteria2", port: 8443, security: "tls", certPath: "/c.pem", keyPath: "/k.pem",
    users: [{ id: 1, name: "默认", uuid: "", password: "pw" }],
  });
  assert.equal(validateProxyInbound({ ...hy2, obfs: "salamander" }), "");
  assert.match(validateProxyInbound({ ...hy2, obfs: "gecko\"}" }), /不支持的混淆方式/);
  const tuic = inbound({
    protocol: "tuic", port: 8443, security: "tls", certPath: "/c.pem", keyPath: "/k.pem",
    users: [{ id: 1, name: "默认", uuid: "u", password: "pw" }],
  });
  assert.equal(validateProxyInbound({ ...tuic, congestionControl: "bbr" }), "");
  assert.match(validateProxyInbound({ ...tuic, congestionControl: "reno" }), /不支持的拥塞控制/);
  const snell = inbound({ protocol: "snell", port: 8000, security: "none", password: "psk" });
  assert.equal(validateProxyInbound({ ...snell, snellVersion: 5, obfs: "http" }), "");
  assert.match(validateProxyInbound({ ...snell, snellVersion: 5, obfs: "quic" }), /Snell 混淆方式/);
  assert.equal(validateProxyInbound({ ...snell, snellVersion: 6, snellMode: "unshaped" }), "");
  assert.match(validateProxyInbound({ ...snell, snellVersion: 6, snellMode: "turbo" }), /Snell v6 整形模式/);
  // 协议用不到的字段不影响：从 VLESS 切到 Trojan 残留的 flow 不会写进配置。
  assert.equal(proxyInboundEnumFieldError({ ...snell, snellVersion: 6, flow: "junk" }), "");
});

// ==================== sing-box 入站生成 ====================

test("VLESS + REALITY 的入站按官方字段名生成", () => {
  const json = buildSingboxInbound(VLESS_REALITY, "in-1");

  assert.equal(json.type, "vless");
  assert.equal(json.listen_port, 443);
  assert.deepEqual(json.users, [{ name: "u1", uuid: "8f1c-uuid", flow: "xtls-rprx-vision" }]);
  assert.deepEqual(json.tls, {
    enabled: true,
    server_name: "dl.google.com",
    reality: {
      enabled: true,
      handshake: { server: "dl.google.com", server_port: 443 },
      private_key: "PRIV",
      // short_id 是数组，不是字符串。
      short_id: ["ab12"],
    },
  });
});

test("REALITY 的握手目标不填时按握手域名的 443 推导", () => {
  assert.deepEqual(proxyInboundRealityDest(VLESS_REALITY), { server: "dl.google.com", port: 443 });
  assert.deepEqual(
    proxyInboundRealityDest({ ...VLESS_REALITY, realityDest: "www.microsoft.com:8443" }),
    { server: "www.microsoft.com", port: 8443 },
  );
});

test("Shadowsocks 的 method 与 password 在顶层，不在 users 里", () => {
  const json = buildSingboxInbound(
    inbound({ protocol: "shadowsocks", port: 8388, security: "none", method: "aes-256-gcm", password: "pw" }),
    "ss",
  );
  assert.equal(json.method, "aes-256-gcm");
  assert.equal(json.password, "pw");
  assert.equal(json.users, undefined);
  // 没有 TLS 层，不该凭空多出一个 tls 块。
  assert.equal(json.tls, undefined);
});

test("Snell 入站只收 v5 与 v6，v4 要挡住", () => {
  /**
   * 这个区间是拿 sing-box 1.14.0 的二进制逐个版本试出来的，不是从文档抄的：
   *   入站 v1/v2/v3/v4 → unsupported version
   *   出站 v5          → unsupported version
   * 两边不一样，看着像笔误，所以单独留一条测试钉住。
   *
   * 放行 v4 的后果不是「这一个节点连不上」，而是 sing-box 拒绝加载整份配置 ——
   * 同一台落地机上其他入站跟着一起停。
   */
  assert.deepEqual([...PROXY_INBOUND_SNELL_VERSIONS], [5, 6]);
  for (const version of [1, 2, 3, 4]) {
    const reason = validateProxyInbound(
      inbound({ protocol: "snell", port: 8000, security: "none", password: "psk", snellVersion: version }),
    );
    assert.match(reason, /只支持 v5 和 v6/, `v${version}`);
  }
  for (const version of [5, 6]) {
    assert.equal(
      validateProxyInbound(inbound({ protocol: "snell", port: 8000, security: "none", password: "psk", snellVersion: version })),
      "",
      `v${version}`,
    );
  }
});

test("Snell 的 psk 在顶层，版本决定是 obfs_mode 还是 mode", () => {
  const v5 = buildSingboxInbound(
    inbound({ protocol: "snell", port: 8000, security: "none", password: "psk", snellVersion: 5, obfs: "http" }),
    "s5",
  );
  assert.equal(v5.psk, "psk");
  assert.equal(v5.version, 5);
  assert.equal(v5.obfs_mode, "http");
  assert.equal(v5.mode, undefined);

  const v6 = buildSingboxInbound(
    inbound({ protocol: "snell", port: 8000, security: "none", password: "psk", snellVersion: 6, snellMode: "unshaped" }),
    "s6",
  );
  assert.equal(v6.version, 6);
  assert.equal(v6.mode, "unshaped");
  // v6 换成了流量整形，没有 obfs。
  assert.equal(v6.obfs_mode, undefined);
});

test("Hysteria2 的混淆是对象，TUIC 的用户带 uuid + password", () => {
  const hy2 = buildSingboxInbound(
    inbound({
      protocol: "hysteria2", port: 8443, security: "tls",
      users: [{ id: 1, name: "默认", uuid: "", password: "pw" }],
      obfs: "salamander", obfsPassword: "ob", upMbps: 100, downMbps: 200,
      serverName: "a.com", certPath: "/c.pem", keyPath: "/k.pem",
    }),
    "hy2",
  );
  assert.deepEqual(hy2.obfs, { type: "salamander", password: "ob" });
  assert.equal(hy2.up_mbps, 100);
  assert.equal(hy2.down_mbps, 200);
  assert.deepEqual(hy2.tls, {
    enabled: true, server_name: "a.com", certificate_path: "/c.pem", key_path: "/k.pem",
  });

  const tuic = buildSingboxInbound(
    inbound({
      protocol: "tuic", port: 443, security: "tls",
      users: [{ id: 1, name: "默认", uuid: "u", password: "pw" }],
      congestionControl: "bbr", serverName: "a.com", certPath: "/c.pem", keyPath: "/k.pem",
    }),
    "tuic",
  );
  assert.deepEqual(tuic.users, [{ name: "u1", uuid: "u", password: "pw" }]);
  assert.equal(tuic.congestion_control, "bbr");
});

test("ws 传输生成 transport 块", () => {
  const json = buildSingboxInbound(
    { ...VLESS_REALITY, transport: "ws", path: "/ray", host: "cdn.example.com" },
    "ws",
  );
  assert.deepEqual(json.transport, { type: "ws", path: "/ray", headers: { Host: "cdn.example.com" } });
});

test("整份配置是合法 JSON，出站固定直连", () => {
  const text = buildSingboxConfig([{ inbound: VLESS_REALITY, tag: "in-1" }]);
  const config = JSON.parse(text);
  assert.equal(config.inbounds.length, 1);
  assert.equal(config.inbounds[0].tag, "in-1");
  // 落地机只管把流量放出去，不做分流。
  assert.deepEqual(config.outbounds, [{ type: "direct", tag: "direct" }]);
});

// ==================== 派生客户端节点 ====================

test("派生的客户端节点拿到公钥，拿不到私钥", () => {
  const node = proxyNodeFromInbound(VLESS_REALITY, { address: "1.2.3.4" });

  assert.equal(node.protocol, "vless");
  assert.equal(node.name, "HK 落地");
  assert.equal(node.address, "1.2.3.4");
  assert.equal(node.port, 443);
  assert.equal(node.uuid, "8f1c-uuid");
  assert.equal(node.flow, "xtls-rprx-vision");
  assert.equal(node.tls, true);
  assert.equal(node.sni, "dl.google.com");
  assert.equal(node.realityPublicKey, "PUB");
  assert.equal(node.realityShortId, "ab12");
  // REALITY 靠 uTLS 伪装浏览器握手，指纹不填客户端行为不一致。
  assert.equal(node.fingerprint, "chrome");
  // 私钥不该出现在任何一个客户端字段里。
  assert.ok(!JSON.stringify(node).includes("PRIV"));
});

test("派生的节点直接喂给订阅渲染器就能用", () => {
  // 这是整条链路的接缝：入站派生出节点，订阅那一套原样接上，不必再改。
  const node = proxyNodeFromInbound(VLESS_REALITY, { address: "1.2.3.4", name: "广州1 → HK" });
  const document = { nodes: [node], groups: [], ruleSets: [], rules: [] };

  const clash = renderProxySubscription(document, "clash");
  assert.match(clash, /type: vless/);
  assert.match(clash, /public-key: "PUB"/);

  const loon = renderProxySubscription(document, "loon");
  assert.match(loon, /public-key="PUB"/);
});

test("派生的节点转成链接后能再解析回来", () => {
  const node = proxyNodeFromInbound(
    inbound({
      protocol: "hysteria2", name: "HY2", port: 8443, security: "tls", password: "pw",
      obfs: "salamander", obfsPassword: "ob", serverName: "a.com", certPath: "/c", keyPath: "/k",
    }),
    { address: "1.2.3.4" },
  );
  assert.equal(node.tls, true);

  const document = { nodes: [node], groups: [], ruleSets: [], rules: [] };
  const base64 = renderProxySubscription(document, "base64");
  const link = Buffer.from(base64, "base64").toString("utf-8").trim();
  const parsed = parseProxyNodeLink(link);

  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.node.protocol, "hysteria2");
  assert.equal(parsed.node.password, "pw");
  assert.equal(parsed.node.obfs, "salamander");
  assert.equal(parsed.node.sni, "a.com");
});

// ==================== 自动签证书（ACME） ====================

const ACME_TROJAN = inbound({
  protocol: "trojan",
  name: "HK TLS",
  port: 443,
  security: "acme",
  users: [{ id: 1, name: "默认", uuid: "", password: "pw" }],
  serverName: "a.example.com",
  acmeEmail: "me@example.com",
});

test("需要真证书的安全层里有 acme，REALITY 不在其列", () => {
  assert.equal(proxyInboundNeedsCertificate("acme"), true);
  assert.equal(proxyInboundNeedsCertificate("tls"), true);
  // REALITY 正是拿来绕开证书的。
  assert.equal(proxyInboundNeedsCertificate("reality"), false);
  assert.equal(proxyInboundNeedsCertificate("none"), false);
  // 有 TLS 层的协议都能选自动签。
  assert.ok(proxyInboundSecurities("trojan").includes("acme"));
  assert.ok(proxyInboundSecurities("hysteria2").includes("acme"));
  assert.ok(!proxyInboundSecurities("shadowsocks").includes("acme"));
});

test("自动签证书缺域名或邮箱都当场报错，且不许填 IP", () => {
  assert.equal(validateProxyInbound(ACME_TROJAN), "");
  assert.match(validateProxyInbound({ ...ACME_TROJAN, serverName: "" }), /域名/);
  assert.match(validateProxyInbound({ ...ACME_TROJAN, acmeEmail: "" }), /邮箱/);
  // IP 签不出证书，而失败在客户端只表现为握手失败 —— 必须在保存时就挡住。
  for (const bad of ["1.2.3.4", "192.168.0.1", "10.0.0.1"]) {
    assert.match(validateProxyInbound({ ...ACME_TROJAN, serverName: bad }), /不是一个合法域名/, bad);
  }
  // 正常域名不能被误伤，含数字的和多级的都要放行。
  for (const good of ["a.example.com", "n1.cdn-2.example.co.uk", "xn--fiqs8s.example.com"]) {
    assert.equal(validateProxyInbound({ ...ACME_TROJAN, serverName: good }), "", good);
  }
});

test("入站的引用与 provider 同源生成，不可能悬空", () => {
  /**
   * sing-box 的 check 查不出 certificate_provider 指向一个不存在的 tag：配置照样
   * 通过、服务照样起来，只在客户端握手时失败。所以引用和被引用方必须一起生成。
   */
  const config = JSON.parse(buildSingboxConfig([{ inbound: ACME_TROJAN, tag: "in-1" }]));
  const tags = new Set((config.certificate.providers as any[]).map((item) => item.tag));
  for (const item of config.inbounds as any[]) {
    const ref = item.tls?.certificate_provider;
    if (ref) assert.ok(tags.has(ref), `悬空引用: ${ref}`);
  }
  assert.equal((config.certificate.providers as any[])[0].type, "acme");
  assert.deepEqual((config.certificate.providers as any[])[0].domain, ["a.example.com"]);
  assert.equal((config.certificate.providers as any[])[0].email, "me@example.com");
});

test("同一个域名上的多个入站共用一张证书", () => {
  // 每个入站各签一次很容易撞上 Let's Encrypt 按域名算的签发频率限制。
  const config = JSON.parse(buildSingboxConfig([
    { inbound: ACME_TROJAN, tag: "in-1" },
    { inbound: { ...ACME_TROJAN, protocol: "anytls", port: 8443 }, tag: "in-2" },
    { inbound: { ...ACME_TROJAN, serverName: "b.example.com", port: 9443 }, tag: "in-3" },
  ]));

  const providers = config.certificate.providers as any[];
  assert.equal(providers.length, 2);
  assert.deepEqual(providers.map((item) => item.tag), ["acme-a.example.com", "acme-b.example.com"]);
  assert.equal(config.inbounds[0].tls.certificate_provider, config.inbounds[1].tls.certificate_provider);
  assert.notEqual(config.inbounds[0].tls.certificate_provider, config.inbounds[2].tls.certificate_provider);
});

test("没有自动签的入站时不生成 certificate 块", () => {
  const config = JSON.parse(buildSingboxConfig([{ inbound: VLESS_REALITY, tag: "in-1" }]));
  assert.equal(config.certificate, undefined);
});

test("自动签的证书是公信的，派生节点不跳过证书校验", () => {
  const node = proxyNodeFromInbound(ACME_TROJAN, { address: "1.2.3.4" });
  assert.equal(node.tls, true);
  assert.equal(node.sni, "a.example.com");
  assert.equal(node.allowInsecure, false);
});

// ==================== 多用户入站 ====================

function users(...names: string[]) {
  return names.map((name, index) => ({
    id: index + 1,
    name,
    uuid: `7c1b5f2a-0000-4000-8000-00000000000${index + 1}`,
    password: `pw${index + 1}`,
  }));
}

test("只有六个协议支持多用户，另两个刻意不做", () => {
  /**
   * 这两个不做的理由是拿真二进制验出来的，不是偷懒：
   *   Shadowsocks  SS2022 多用户的客户端密码是「服务端PSK:用户PSK」组合，而
   *                sing-box 的 check 对「只填用户 PSK」和「填组合」都放行 ——
   *                写错了配置层看不出来，只在连接时失败。
   *   Snell        sing-box 用「共享 psk + 每用户 userkey」，而 Surge 与 mihomo
   *                的节点配置里没有 userkey 这个位置，开了多用户全连不上。
   */
  for (const protocol of ["vless", "vmess", "trojan", "hysteria2", "tuic", "anytls"] as const) {
    assert.equal(proxyInboundSupportsMultiUser(protocol), true, protocol);
  }
  assert.equal(proxyInboundSupportsMultiUser("shadowsocks"), false);
  assert.equal(proxyInboundSupportsMultiUser("snell"), false);
});

test("每用户凭据的种类按协议区分", () => {
  assert.deepEqual(proxyInboundUserCredentialKinds("vless"), ["uuid"]);
  assert.deepEqual(proxyInboundUserCredentialKinds("vmess"), ["uuid"]);
  // TUIC 两样都要。
  assert.deepEqual(proxyInboundUserCredentialKinds("tuic"), ["uuid", "password"]);
  assert.deepEqual(proxyInboundUserCredentialKinds("trojan"), ["password"]);
  // 单用户协议没有「每用户凭据」这回事。
  assert.deepEqual(proxyInboundUserCredentialKinds("shadowsocks"), []);
});

test("多用户协议没有用户、或用户缺凭据都当场报错", () => {
  const base = inbound({ protocol: "trojan", port: 443, security: "reality", serverName: "dl.google.com", realityPrivateKey: "P", realityPublicKey: "U", realityShortId: "ab12" });
  assert.match(validateProxyInbound({ ...base, users: [] }), /至少要有一个用户/);
  assert.match(
    validateProxyInbound({ ...base, users: [{ id: 1, name: "小王", uuid: "", password: "" }] }),
    /小王.*缺少密码/,
  );
  assert.equal(validateProxyInbound({ ...base, users: users("小王", "小李") }), "");
});

test("同一个入站里凭据重复要挡住", () => {
  /**
   * 重了的后果不是报错，而是两个人共用一条身份 —— 吊销其中一个会把另一个也踢
   * 下线，而界面上两行看着是独立的。
   */
  const dup = [
    { id: 1, name: "小王", uuid: "", password: "same" },
    { id: 2, name: "小李", uuid: "", password: "same" },
  ];
  const reason = validateProxyInbound(inbound({
    protocol: "trojan", port: 443, security: "tls", certPath: "/c", keyPath: "/k", serverName: "a.com", users: dup,
  }));
  assert.match(reason, /小李.*凭据和另一个用户重复/);
});

test("所有用户都写进 sing-box 的 users 数组", () => {
  const json = buildSingboxInbound(
    { ...VLESS_REALITY, uuid: "", users: users("小王", "小李", "小张"), flow: "xtls-rprx-vision" },
    "in-1",
  );
  const list = json.users as any[];
  assert.equal(list.length, 3);
  // name 用行 id，改名不该让 sing-box 认为换了一个人。
  assert.deepEqual(list.map((item) => item.name), ["u1", "u2", "u3"]);
  assert.deepEqual(list.map((item) => item.uuid), users("小王", "小李", "小张").map((u) => u.uuid));
  // flow 是入站级的，所有人一样。
  assert.ok(list.every((item) => item.flow === "xtls-rprx-vision"));
});

test("TUIC 的每个用户都带 uuid 与 password", () => {
  const json = buildSingboxInbound(
    inbound({
      protocol: "tuic", port: 443, security: "tls", serverName: "a.com", certPath: "/c", keyPath: "/k",
      users: users("甲", "乙"),
    }),
    "in-1",
  );
  const list = json.users as any[];
  assert.equal(list.length, 2);
  assert.ok(list.every((item) => item.uuid && item.password));
});

test("一个用户派生一条客户端节点，名字带用户标签", () => {
  const derived = proxyNodesFromInbound(
    { ...VLESS_REALITY, name: "HK 落地", uuid: "", users: users("小王", "小李") },
    { address: "1.2.3.4" },
  );

  assert.equal(derived.length, 2);
  assert.deepEqual(derived.map((item) => item.node.name), ["HK 落地 · 小王", "HK 落地 · 小李"]);
  // 每个人拿到的是自己的凭据，不是别人的。
  assert.notEqual(derived[0].node.uuid, derived[1].node.uuid);
  assert.equal(derived[0].user?.id, 1);
  assert.equal(derived[1].user?.id, 2);
});

test("只有一个用户时节点名不加后缀", () => {
  // 「HK 落地 · 默认」这种后缀没有信息量，只是噪音。
  const derived = proxyNodesFromInbound(
    { ...VLESS_REALITY, name: "HK 落地", uuid: "", users: users("默认") },
    { address: "1.2.3.4" },
  );
  assert.equal(derived.length, 1);
  assert.equal(derived[0].node.name, "HK 落地");
});

test("单用户协议仍然派生一条节点，凭据来自入站本身", () => {
  const derived = proxyNodesFromInbound(
    inbound({ protocol: "shadowsocks", name: "SS", port: 8388, security: "none", method: "aes-256-gcm", password: "pw" }),
    { address: "1.2.3.4" },
  );
  assert.equal(derived.length, 1);
  assert.equal(derived[0].user, null);
  assert.equal(derived[0].node.password, "pw");
});

test("Hysteria2 入站声明的带宽跟着派生到客户端节点，其他协议不带", () => {
  const hy2 = proxyNodeFromInbound(
    inbound({
      protocol: "hysteria2", name: "HY2", port: 8443, security: "tls", password: "pw",
      certPath: "/c", keyPath: "/k", upMbps: 50, downMbps: 300,
    }),
    { address: "1.2.3.4" },
  );
  assert.equal(hy2.upMbps, 50);
  assert.equal(hy2.downMbps, 300);

  const vless = proxyNodeFromInbound({ ...VLESS_REALITY, upMbps: 50, downMbps: 300 }, { address: "1.2.3.4" });
  assert.equal(vless.upMbps, 0);
  assert.equal(vless.downMbps, 0);
});
