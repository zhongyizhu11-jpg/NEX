import assert from "node:assert/strict";
import test from "node:test";

import { parseMiniYaml } from "./miniYaml";
import { encodeBase64Utf8 } from "./proxyNode";
import { normalizeProxySubSourceInterval, normalizeProxySubSourceUrl, parseProxySubSourceContent, parseSubscriptionUserinfoHeader } from "./proxySubSource";

const VLESS = "vless://11111111-1111-1111-1111-111111111111@hk.example.com:443?encryption=none&security=tls&sni=hk.example.com&type=ws&path=%2Fray#%E9%A6%99%E6%B8%AF";
const SS = "ss://YWVzLTEyOC1nY206cGFzcw@jp.example.com:8388#%E6%97%A5%E6%9C%AC";

test("裸链接列表", () => {
  const parsed = parseProxySubSourceContent(`${VLESS}\n\n# 注释\n${SS}\nREMARKS=xx\n`);
  assert.equal(parsed.format, "links");
  assert.deepEqual(parsed.nodes.map((node) => node.name), ["香港", "日本"]);
  assert.deepEqual(parsed.errors, []);
});

test("整体 base64 的链接列表", () => {
  const parsed = parseProxySubSourceContent(encodeBase64Utf8(`${VLESS}\n${SS}`));
  assert.equal(parsed.format, "base64");
  assert.equal(parsed.nodes.length, 2);
});

test("Clash YAML 的 proxies（块写法和行内写法都认，组和注释跳过）", () => {
  const yaml = `
# 机场配置
port: 7890
proxies:
  - name: "🇭🇰 香港 01"
    type: vless
    server: hk.example.com
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    tls: true
    servername: hk.example.com
    network: ws
    ws-opts:
      path: /ray
      headers:
        Host: hk.example.com
  - { name: 日本 SS, type: ss, server: jp.example.com, port: 8388, cipher: aes-128-gcm, password: pass, udp: true }
  - name: hy2
    type: hysteria2
    server: us.example.com
    port: 443
    password: pw
    sni: us.example.com
    alpn: [h3]
proxy-groups:
  - name: 自动
    type: url-test
    proxies: ["🇭🇰 香港 01", 日本 SS]
rules:
  - MATCH,自动
`;
  const doc = parseMiniYaml(yaml) as any;
  assert.equal(doc.port, 7890);
  assert.equal(doc.proxies.length, 3);
  assert.equal(doc.proxies[0]["ws-opts"].headers.Host, "hk.example.com");
  assert.deepEqual(doc.proxies[2].alpn, ["h3"]);
  assert.deepEqual(doc["proxy-groups"][0].proxies, ["🇭🇰 香港 01", "日本 SS"]);

  const parsed = parseProxySubSourceContent(yaml);
  assert.equal(parsed.format, "clash");
  assert.deepEqual(parsed.nodes.map((node) => `${node.protocol}:${node.name}`), ["vless:🇭🇰 香港 01", "shadowsocks:日本 SS", "hysteria2:hy2"]);
  assert.equal(parsed.nodes[0].transport, "ws");
  assert.equal(parsed.nodes[0].host, "hk.example.com");
});

test("sing-box JSON 的 outbounds（selector / direct 跳过）", () => {
  const json = JSON.stringify({
    outbounds: [
      { type: "selector", tag: "proxy", outbounds: ["hk"] },
      { type: "vless", tag: "hk", server: "hk.example.com", server_port: 443, uuid: "11111111-1111-1111-1111-111111111111", tls: { enabled: true, server_name: "hk.example.com" } },
      { type: "direct", tag: "direct" },
    ],
  });
  const parsed = parseProxySubSourceContent(json);
  assert.equal(parsed.format, "singbox");
  assert.deepEqual(parsed.nodes.map((node) => node.name), ["hk"]);
});

test("认不出的内容报一条错误而不是抛异常；重复节点只留一个", () => {
  const nothing = parseProxySubSourceContent("hello world");
  assert.equal(nothing.nodes.length, 0);
  assert.equal(nothing.errors.length, 1);
  const dup = parseProxySubSourceContent(`${VLESS}\n${VLESS}`);
  assert.equal(dup.nodes.length, 1);
});

test("上游 subscription-userinfo 头解析；地址与间隔归一", () => {
  assert.deepEqual(parseSubscriptionUserinfoHeader("upload=1; download=2; total=3; expire=4"), { upload: 1, download: 2, total: 3, expire: 4 });
  assert.equal(parseSubscriptionUserinfoHeader(""), null);
  assert.equal(normalizeProxySubSourceUrl("https://a.example.com/sub?token=x"), "https://a.example.com/sub?token=x");
  assert.equal(normalizeProxySubSourceUrl("ftp://a.example.com/sub"), "");
  assert.equal(normalizeProxySubSourceUrl("not a url"), "");
  assert.equal(normalizeProxySubSourceInterval(0), 21600);
  assert.equal(normalizeProxySubSourceInterval(10), 600);
  assert.equal(normalizeProxySubSourceInterval(10 ** 9), 7 * 86400);
});
