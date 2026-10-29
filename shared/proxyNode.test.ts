import assert from "node:assert/strict";
import test from "node:test";

import {
  formatProxyNodeLink,
  normalizeCertSha256,
  parseProxyNodeLink,
  relayProxyNode,
  encodeBase64Utf8,
  type ProxyNode,
} from "./proxyNode";

function parseOrThrow(link: string): ProxyNode {
  const result = parseProxyNodeLink(link);
  if (!result.ok) throw new Error(`${link} 解析失败: ${result.error}`);
  return result.node;
}

test("VLESS link keeps every credential and transport option", () => {
  const node = parseOrThrow(
    "vless://abc-uuid@hkt.example.com:443?encryption=none&security=tls&sni=hkt.example.com&type=ws&path=%2Fray&host=cdn.example.com&fp=chrome#HKT%20落地",
  );

  assert.equal(node.protocol, "vless");
  assert.equal(node.address, "hkt.example.com");
  assert.equal(node.port, 443);
  assert.equal(node.uuid, "abc-uuid");
  assert.equal(node.transport, "ws");
  assert.equal(node.path, "/ray");
  assert.equal(node.host, "cdn.example.com");
  assert.equal(node.tls, true);
  assert.equal(node.sni, "hkt.example.com");
  assert.equal(node.fingerprint, "chrome");
  assert.equal(node.name, "HKT 落地");
});

test("relay rewrite swaps only the address and port", () => {
  const node = parseOrThrow(
    "vless://abc-uuid@hkt.example.com:443?security=tls&sni=hkt.example.com&type=ws&path=%2Fray#HKT",
  );
  const relayed = relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" });

  assert.equal(relayed.address, "1.2.3.4");
  assert.equal(relayed.port, 20001);
  assert.equal(relayed.name, "广州1 → HKT");
  // 凭据与握手参数必须原样保留，否则中转后连不上落地机。
  assert.equal(relayed.uuid, node.uuid);
  assert.equal(relayed.sni, "hkt.example.com");
  assert.equal(relayed.path, "/ray");
  assert.equal(relayed.transport, "ws");
  // 原节点不能被就地改动。
  assert.equal(node.address, "hkt.example.com");
});

test("relay rewrite pins the original address as SNI when the link omitted it", () => {
  // 链接没写 sni 时客户端会拿连接地址当 SNI。中转后连接地址是入口 IP，
  // 直接改写会让握手带着 IP 去找落地机而失败，所以必须先固化原地址。
  const node = parseOrThrow("vless://abc-uuid@hkt.example.com:443?security=tls&type=tcp#HKT");
  assert.equal(node.sni, "");

  const relayed = relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1" });

  assert.equal(relayed.sni, "hkt.example.com");
});

test("relay rewrite pins the original address as the websocket Host header", () => {
  const node = parseOrThrow("vless://abc-uuid@hkt.example.com:443?security=tls&type=ws&path=%2Fray#HKT");
  assert.equal(node.host, "");

  const relayed = relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1" });

  assert.equal(relayed.host, "hkt.example.com");
});

test("plain TCP without TLS gains no SNI from the rewrite", () => {
  const node = parseOrThrow("vless://abc-uuid@hkt.example.com:8080?security=none&type=tcp#HKT");
  const relayed = relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1" });

  assert.equal(relayed.tls, false);
  assert.equal(relayed.sni, "");
});

test("VMess base64 JSON links parse into the shared model", () => {
  const payload = {
    v: "2",
    ps: "香港节点",
    add: "hk.example.com",
    port: "443",
    id: "vmess-uuid",
    aid: "0",
    scy: "auto",
    net: "ws",
    host: "cdn.example.com",
    path: "/vm",
    tls: "tls",
    sni: "hk.example.com",
  };
  const node = parseOrThrow(`vmess://${encodeBase64Utf8(JSON.stringify(payload))}`);

  assert.equal(node.protocol, "vmess");
  assert.equal(node.name, "香港节点");
  assert.equal(node.uuid, "vmess-uuid");
  assert.equal(node.transport, "ws");
  assert.equal(node.path, "/vm");
  assert.equal(node.tls, true);
});

test("Trojan defaults to TLS even when the link omits security", () => {
  const node = parseOrThrow("trojan://secret-pass@hk.example.com:443?sni=hk.example.com#Trojan");

  assert.equal(node.protocol, "trojan");
  assert.equal(node.password, "secret-pass");
  assert.equal(node.tls, true);
});

test("Shadowsocks parses both SIP002 and the legacy fully-encoded form", () => {
  const sip002 = parseOrThrow(
    `ss://${encodeBase64Utf8("aes-128-gcm:ss-password").replace(/=+$/, "")}@hk.example.com:8388#SS`,
  );
  assert.equal(sip002.method, "aes-128-gcm");
  assert.equal(sip002.password, "ss-password");
  assert.equal(sip002.address, "hk.example.com");
  assert.equal(sip002.port, 8388);

  const legacy = parseOrThrow(`ss://${encodeBase64Utf8("aes-256-gcm:legacy-pass@hk.example.com:8389")}#SS旧`);
  assert.equal(legacy.method, "aes-256-gcm");
  assert.equal(legacy.password, "legacy-pass");
  assert.equal(legacy.port, 8389);
});

test("IPv6 entry addresses survive the round trip", () => {
  const node = parseOrThrow("vless://abc-uuid@hkt.example.com:443?security=tls&sni=hkt.example.com#HKT");
  const relayed = relayProxyNode(node, { address: "2001:db8::1", port: 20001, name: "IPv6 入口" });
  const link = formatProxyNodeLink(relayed);

  assert.match(link, /@\[2001:db8::1\]:20001/);
  const reparsed = parseOrThrow(link);
  assert.equal(reparsed.address, "2001:db8::1");
  assert.equal(reparsed.port, 20001);
});

test("每种协议都能 解析 → 中转改写 → 还原 → 再解析 而不丢凭据", () => {
  const links = [
    "vless://abc-uuid@hkt.example.com:443?security=tls&sni=hkt.example.com&type=ws&path=%2Fray&flow=xtls-rprx-vision#VLESS",
    `vmess://${encodeBase64Utf8(JSON.stringify({ v: "2", ps: "VM", add: "hk.example.com", port: "443", id: "vmess-uuid", aid: "0", net: "ws", path: "/vm", tls: "tls", sni: "hk.example.com" }))}`,
    "trojan://secret-pass@hk.example.com:443?sni=hk.example.com&type=tcp#TJ",
    `ss://${encodeBase64Utf8("aes-128-gcm:ss-password").replace(/=+$/, "")}@hk.example.com:8388#SS`,
  ];

  for (const link of links) {
    const original = parseOrThrow(link);
    const relayed = relayProxyNode(original, { address: "1.2.3.4", port: 20001, name: "广州1" });
    const reparsed = parseOrThrow(formatProxyNodeLink(relayed));

    assert.equal(reparsed.protocol, original.protocol, link);
    assert.equal(reparsed.uuid, original.uuid, link);
    assert.equal(reparsed.password, original.password, link);
    assert.equal(reparsed.method || "auto", original.method || "auto", link);
    assert.equal(reparsed.address, "1.2.3.4", link);
    assert.equal(reparsed.port, 20001, link);
    assert.equal(reparsed.transport, original.transport, link);
    assert.equal(reparsed.tls, original.tls, link);
  }
});

test("Reality parameters are preserved through the rewrite", () => {
  const node = parseOrThrow(
    "vless://abc-uuid@hkt.example.com:443?security=reality&sni=www.microsoft.com&pbk=publickey123&sid=ab12&fp=chrome&type=tcp#Reality",
  );
  assert.equal(node.realityPublicKey, "publickey123");
  assert.equal(node.realityShortId, "ab12");

  const link = formatProxyNodeLink(relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1" }));
  const reparsed = parseOrThrow(link);

  assert.equal(reparsed.realityPublicKey, "publickey123");
  assert.equal(reparsed.realityShortId, "ab12");
  assert.equal(reparsed.sni, "www.microsoft.com");
});

test("unsupported and malformed links report a usable reason", () => {
  // SSR 已经没人在用，也不打算支持；换协议时记得这里要挑一个真的不支持的。
  const unsupported = parseProxyNodeLink("ssr://cGFzc0BleGFtcGxlLmNvbTo0NDM");
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.match(unsupported.error, /暂不支持该协议/);

  const malformed = parseProxyNodeLink("vless://not-a-real-link");
  assert.equal(malformed.ok, false);

  const empty = parseProxyNodeLink("   ");
  assert.equal(empty.ok, false);
});

// ==================== Reality 与 Shadowrocket 写法 ====================

test("Shadowrocket 的 vless 链接：整段 base64，参数名也不同", () => {
  // 标准写法是 vless://uuid@host:port?security=reality&pbk=...
  // Shadowrocket 写成 vless://base64(method:uuid@host:port)?tls=1&peer=...&pbk=...
  // 不认这种的后果是整条链接解析失败，用户只看到「格式无法识别」。
  const link =
    "vless://YXV0bzpiOGRjOGIxMi1iMmY4LTQ0MTAtYjk3NS1kMDgwNWJlYWRkZDNAMTU0LjM2LjE3NC44NTo2MzI4NA" +
    "?remarks=Cst%20hk&tls=1&peer=aws.amazon.com&xtls=2&pbk=PUBKEY123";
  const result = parseProxyNodeLink(link);

  assert.ok(result.ok, result.ok ? "" : result.error);
  const node = result.node;
  assert.equal(node.address, "154.36.174.85");
  assert.equal(node.port, 63284);
  assert.equal(node.uuid, "b8dc8b12-b2f8-4410-b975-d0805beaddd3", "base64 里的 method: 前缀要丢掉");
  assert.equal(node.name, "Cst hk", "名字在 remarks 参数里，不是 # 后面");
  assert.equal(node.tls, true, "tls=1 也算开启 TLS");
  assert.equal(node.sni, "aws.amazon.com", "peer 就是 SNI");
  assert.equal(node.realityPublicKey, "PUBKEY123", "没写 security=reality，靠 pbk 存在判断");
  assert.equal(node.flow, "xtls-rprx-vision", "xtls=2 是数字不是布尔");
});

test("xtls=0 不算启用流控", () => {
  const link = "vless://u@1.2.3.4:443?tls=1&xtls=0";
  const result = parseProxyNodeLink(link);
  assert.ok(result.ok);
  assert.equal(result.node.flow, "");
});

test("显式给了 flow 时以 flow 为准", () => {
  const link = "vless://u@1.2.3.4:443?security=reality&pbk=K&flow=xtls-rprx-vision&xtls=1";
  const result = parseProxyNodeLink(link);
  assert.ok(result.ok);
  assert.equal(result.node.flow, "xtls-rprx-vision");
});

test("标准写法不受影响", () => {
  // 改解析器最容易伤到的就是原本能用的那条路。
  const link =
    "vless://b8dc8b12@1.2.3.4:443?security=reality&sni=a.com&pbk=PK&sid=ab12&fp=chrome&flow=xtls-rprx-vision#名字";
  const result = parseProxyNodeLink(link);

  assert.ok(result.ok);
  assert.equal(result.node.uuid, "b8dc8b12");
  assert.equal(result.node.name, "名字");
  assert.equal(result.node.realityPublicKey, "PK");
  assert.equal(result.node.realityShortId, "ab12");
});

// ==================== Hysteria2 / TUIC / AnyTLS ====================

test("Hysteria2 链接解析出密码、SNI 与混淆", () => {
  const node = parseOrThrow(
    "hysteria2://my%40pass@hk.example.com:8443/?obfs=salamander&obfs-password=ob&sni=real.example.com&insecure=1#HY2",
  );

  assert.equal(node.protocol, "hysteria2");
  assert.equal(node.address, "hk.example.com");
  assert.equal(node.port, 8443);
  // 密码里带 @ 是常见的，必须按最后一个 @ 切分并解码。
  assert.equal(node.password, "my@pass");
  assert.equal(node.sni, "real.example.com");
  assert.equal(node.obfs, "salamander");
  assert.equal(node.obfsPassword, "ob");
  assert.equal(node.allowInsecure, true);
  // 协议自带 TLS，链接里不会写 security=tls。
  assert.equal(node.tls, true);
  assert.equal(node.name, "HY2");
});

test("hy2:// 是 Hysteria2 的官方简写，省略端口时按 443 算", () => {
  const node = parseOrThrow("hy2://pw@hk.example.com/?sni=a.com#简写");
  assert.equal(node.protocol, "hysteria2");
  assert.equal(node.port, 443);
  assert.equal(node.password, "pw");
});

test("TUIC 链接拆出 uuid 与密码，缺省 ALPN 补 h3", () => {
  const node = parseOrThrow(
    "tuic://2DD61D93-75D8-4DA4-AC0E-6AECE7EAC365:pass@hk.example.com:443?congestion_control=bbr&udp_relay_mode=native&sni=a.com&disable_sni=1#TUIC",
  );

  assert.equal(node.protocol, "tuic");
  assert.equal(node.uuid, "2DD61D93-75D8-4DA4-AC0E-6AECE7EAC365");
  assert.equal(node.password, "pass");
  assert.equal(node.congestionControl, "bbr");
  assert.equal(node.udpRelayMode, "native");
  assert.equal(node.disableSni, true);
  assert.deepEqual(node.alpn, ["h3"]);
  assert.equal(node.tls, true);
});

test("TUIC 少了 uuid:password 那个冒号就不该蒙混过关", () => {
  // v4 是单一 token，握手与 v5 不兼容；猜成 v5 会生成一个连不上的节点。
  const result = parseProxyNodeLink("tuic://just-a-token@hk.example.com:443#v4");
  assert.equal(result.ok, false);
});

test("AnyTLS 链接解析，端口可省", () => {
  const node = parseOrThrow("anytls://letmein@example.com/?sni=real.example.com&insecure=1#AT");
  assert.equal(node.protocol, "anytls");
  assert.equal(node.port, 443);
  assert.equal(node.password, "letmein");
  assert.equal(node.sni, "real.example.com");
  assert.equal(node.allowInsecure, true);
  assert.equal(node.tls, true);
});

test("新协议来回一趟不丢参数", () => {
  for (const link of [
    "hysteria2://pw@hk.example.com:8443/?obfs=salamander&obfs-password=ob&sni=a.com&insecure=1#名字",
    "tuic://uuid-1:pw@hk.example.com:443?congestion_control=bbr&udp_relay_mode=native&sni=a.com#名字",
    "anytls://pw@hk.example.com:443/?sni=a.com#名字",
  ]) {
    const first = parseOrThrow(link);
    const second = parseOrThrow(formatProxyNodeLink(first));
    assert.equal(second.protocol, first.protocol);
    assert.equal(second.address, first.address);
    assert.equal(second.port, first.port);
    assert.equal(second.uuid, first.uuid);
    assert.equal(second.password, first.password);
    assert.equal(second.sni, first.sni);
    assert.equal(second.obfs, first.obfs);
    assert.equal(second.obfsPassword, first.obfsPassword);
    assert.equal(second.congestionControl, first.congestionControl);
    assert.equal(second.udpRelayMode, first.udpRelayMode);
    assert.equal(second.name, first.name);
  }
});

test("中转改写把落地地址固化进 SNI —— QUIC 系同样适用", () => {
  const node = parseOrThrow("hysteria2://pw@hk.example.com:8443/#HY2");
  const relayed = relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1 → HY2" });
  assert.equal(relayed.address, "1.2.3.4");
  assert.equal(relayed.port, 20001);
  // 不固化的话客户端会拿入口 IP 当 SNI，证书对不上。
  assert.equal(relayed.sni, "hk.example.com");
});

// ==================== Snell 与 XHTTP ====================

test("Snell 从 Surge 节点行读出来", () => {
  // Snell 没有分享链接，用户手上最可能有的就是一行 Surge 配置。
  const node = parseOrThrow('HK 落地 = snell, 1.2.3.4, 8000, psk="my-psk", version=4, obfs=http, obfs-host=bing.com');

  assert.equal(node.protocol, "snell");
  assert.equal(node.name, "HK 落地");
  assert.equal(node.address, "1.2.3.4");
  assert.equal(node.port, 8000);
  // psk 惯例带引号，要去掉。
  assert.equal(node.password, "my-psk");
  assert.equal(node.snellVersion, 4);
  assert.equal(node.obfs, "http");
  assert.equal(node.host, "bing.com");
  // Snell 走裸 TCP，没有 TLS。
  assert.equal(node.tls, false);
});

test("Snell v6 用 mode 而不是 obfs", () => {
  const node = parseOrThrow("S6 = snell, 1.2.3.4, 8000, psk=k, version=6, mode=unshaped");
  assert.equal(node.snellVersion, 6);
  assert.equal(node.snellMode, "unshaped");
  assert.equal(node.obfs, "");
});

test("Snell 不写 version 时按 Surge 手册的默认 v1 算", () => {
  // 不猜成 v4：版本猜错是握手完全不兼容，不是少一个参数。
  const node = parseOrThrow("S = snell, 1.2.3.4, 8000, psk=k");
  assert.equal(node.snellVersion, 1);
});

test("Snell 少了 psk 就报错，而不是收下一个连不上的节点", () => {
  const result = parseProxyNodeLink("S = snell, 1.2.3.4, 8000, version=4");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /psk/);
});

test("Snell 没有分享链接，不该凭空编一个出来", () => {
  const node = parseOrThrow("S = snell, 1.2.3.4, 8000, psk=k, version=4");
  assert.equal(formatProxyNodeLink(node), "");
});

test("VLESS + XHTTP + REALITY 的链接带 mode", () => {
  const node = parseOrThrow(
    "vless://u@1.2.3.4:443?type=xhttp&mode=stream-one&path=%2Fx&host=a.com&security=reality&pbk=PK&sid=ab#XH",
  );
  assert.equal(node.transport, "xhttp");
  assert.equal(node.xhttpMode, "stream-one");
  assert.equal(node.path, "/x");
  assert.equal(node.host, "a.com");
  assert.equal(node.realityPublicKey, "PK");

  // mode 两端不一致就连不上，来回一趟不能丢。
  const again = parseOrThrow(formatProxyNodeLink(node));
  assert.equal(again.transport, "xhttp");
  assert.equal(again.xhttpMode, "stream-one");
});

test("HTTPUpgrade 传输能来回读写，且不与 http 混淆", () => {
  /**
   * 两者名字像但不是一回事：http 是 H2，httpupgrade 是在普通 HTTP 上升级连接，
   * 比 ws 少一次握手往返。收敛错了会得到一个协议对、传输错的节点 ——
   * 能导入、握手必失败。
   */
  const link = "vless://11111111-2222-3333-4444-555555555555@1.2.3.4:8443"
    + "?encryption=none&security=tls&sni=a.example.com&type=httpupgrade&path=%2Fray&host=a.example.com#hu";
  const parsed = parseProxyNodeLink(link);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.node.transport, "httpupgrade");
  assert.equal(parsed.node.path, "/ray");
  assert.equal(parsed.node.host, "a.example.com");

  // h2 仍然收敛成 http，没有被新分支抢走。
  assert.equal(parseProxyNodeLink(link.replace("type=httpupgrade", "type=h2")).ok, true);
  const h2 = parseProxyNodeLink(link.replace("type=httpupgrade", "type=h2"));
  assert.equal(h2.ok && h2.node.transport, "http");

  // 写回去还是 httpupgrade。
  assert.match(formatProxyNodeLink(parsed.node), /type=httpupgrade/);
});

test("中转改写地址时，HTTPUpgrade 的 Host 头留着原落地域名", () => {
  // 不留的话发出去的 Host 是中转 IP，对端按 Host 路由就找不到人 —— 与 ws 同理。
  const parsed = parseProxyNodeLink(
    "vless://11111111-2222-3333-4444-555555555555@land.example.com:8443"
    + "?encryption=none&security=tls&type=httpupgrade&path=%2Fray#hu",
  );
  assert.ok(parsed.ok);
  const relayed = relayProxyNode(parsed.node, { address: "1.2.3.4", port: 20001, name: "中转" });
  assert.equal(relayed.address, "1.2.3.4");
  assert.equal(relayed.host, "land.example.com");
});

test("Hysteria2 的证书指纹（pinSHA256）导入导出不丢，冒号写法也认", () => {
  const pin = "ab".repeat(32);
  const node = parseOrThrow(`hysteria2://pw@hk.example.com:8443/?sni=a.com&insecure=1&pinSHA256=${pin}#HY2`);
  assert.equal(node.certSha256, pin.toUpperCase().match(/.{2}/g)!.join(":"));
  const link = formatProxyNodeLink(node);
  assert.match(link, /pinSHA256=AB%3AAB/);
  assert.equal(parseOrThrow(link).certSha256, node.certSha256);
  assert.equal(normalizeCertSha256("not a hash"), "", "认不出来当没有");
  assert.equal(normalizeCertSha256("AB:CD"), "");
});
