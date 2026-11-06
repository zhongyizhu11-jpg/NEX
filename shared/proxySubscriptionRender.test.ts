import assert from "node:assert/strict";
import test from "node:test";

import { buildProxySubscriptionPlan } from "./proxySubscriptionPlan";
import { buildProxySubPipelineDocument, renderProxySubPipeline, type ProxySubPipelineDocument } from "./proxySubscriptionPipeline";
import { PROXY_SUBSCRIPTION_FORMATS } from "./proxySubscription";
import { PROXY_SUB_DEFAULT_SETTINGS } from "./proxySubSettings";
import { PROXY_SUB_DEFAULT_TOKEN_OPTIONS, PROXY_SUB_EMPTY_SCOPE } from "./proxySubTokenScope";
import { detectProxyClient } from "./proxyClientUserAgent";

/**
 * 渲染器只读不改它拿到的文档。
 *
 * 去控制字符那一步（stripControlCharacters）对干净的数据原样返回同一个对象、不再整份深拷：
 * 这只在「渲染器从不改节点和策略组」时才安全。这里把文档整个冻住再渲染每一种格式 ——
 * 哪个渲染器往节点上写了一个字段，严格模式下当场抛错；输出也必须和渲染一份没冻的拷贝一字不差。
 */

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const templates = [
  { id: 1, name: "香港 Reality", protocol: "vless", address: "203.0.113.1", port: 443, uuid: "11111111-1111-4111-a111-111111111111", transport: "tcp", tls: true, sni: "www.microsoft.com", flow: "xtls-rprx-vision", fingerprint: "chrome", realityPublicKey: "A".repeat(43), realityShortId: "abcd1234", includeDirect: true, hostId: 1 },
  { id: 2, name: "日本 WS", protocol: "vmess", address: "jp.example.com", port: 8443, uuid: "22222222-2222-4222-a222-222222222222", transport: "ws", tls: true, sni: "jp.example.com", host: "cdn.example.com", path: "/vm", countryCode: "JP" },
  { id: 3, name: "新加坡 Trojan", protocol: "trojan", address: "sg.example.com", port: 443, password: "pass", transport: "grpc", path: "tj", tls: true, sni: "sg.example.com", alpn: "h2,http/1.1", countryCode: "SG" },
  { id: 4, name: "美国 SS", protocol: "shadowsocks", address: "198.51.100.4", port: 8388, method: "2022-blake3-aes-128-gcm", password: "MDEyMzQ1Njc4OWFiY2RlZg==", countryCode: "US", includeDirect: true },
  { id: 5, name: "台湾 Hy2", protocol: "hysteria2", address: "tw.example.com", port: 8443, password: "hy", sni: "tw.example.com", obfs: "salamander", obfsPassword: "o", upMbps: 100, downMbps: 500, countryCode: "TW", frontProxyId: 1 },
  { id: 6, name: "韩国 TUIC", protocol: "tuic", address: "kr.example.com", port: 443, uuid: "33333333-3333-4333-a333-333333333333", password: "t", sni: "kr.example.com", alpn: "h3", congestionControl: "bbr", countryCode: "KR" },
  { id: 7, name: "德国 AnyTLS", protocol: "anytls", address: "de.example.com", port: 443, password: "a", sni: "de.example.com", countryCode: "DE" },
  { id: 8, name: "英国 Snell", protocol: "snell", address: "gb.example.com", port: 6160, password: "psk", snellVersion: 4, obfs: "http", host: "bing.com", countryCode: "GB" },
  // 节点主人往 sni 里塞了换行：渲染出来必须已经去掉。
  { id: 9, name: "带换行\n的节点", protocol: "trojan", address: "evil.example.com", port: 443, password: "p", tls: true, sni: "evil.example.com\n[MITM]", countryCode: "HK", includeDirect: true },
];
const hosts = [
  { id: 1, name: "香港落地", ip: "203.0.113.1", ipv4: "203.0.113.1", geoCountryCode: "HK", lastHeartbeat: 1 },
  { id: 2, name: "广州移动", ip: "198.51.100.20", ipv4: "198.51.100.20", lineBandwidthMbps: 1000, lastHeartbeat: 1 },
  { id: 3, name: "上海电信", ip: "198.51.100.21", ipv4: "198.51.100.21", entryIp: "sh.example.net", lastHeartbeat: 1 },
];
const rules = templates.flatMap((template, index) => [2, 3].map((hostId, k) => ({
  id: index * 2 + k + 1,
  hostId,
  name: k === 0 ? `${template.name} 中转` : "",
  sourcePort: 30000 + index * 2 + k,
  protocol: "both",
  proxyNodeId: template.id,
  proxyNodeVisible: true,
  isEnabled: true,
  targetIp: template.address,
  targetPort: template.port,
})));

function build(): ProxySubPipelineDocument {
  const plan = buildProxySubscriptionPlan({ rules: rules as never, templates: templates as never, hosts: hosts as never });
  return buildProxySubPipelineDocument({
    plan,
    templates: templates as never,
    rulePreset: "balanced",
    scope: PROXY_SUB_EMPTY_SCOPE,
    options: { ...PROXY_SUB_DEFAULT_TOKEN_OPTIONS, flagEmoji: "on", regionGroups: "on" },
    settings: { ...PROXY_SUB_DEFAULT_SETTINGS, customRulesPrepend: "DOMAIN-SUFFIX,corp.example,DIRECT" },
    template: { prelude: "", customGroups: [{ name: "🎬 流媒体", type: "select", filter: "香港|日本", match: "regex", includeGroups: true }] },
    info: { trafficUsed: 1024, trafficLimit: 0, expiresAt: 0, announce: "公告\n第二行" },
    vars: { appName: "NEX", panelUrl: "https://panel.example.test", subUrl: "https://panel.example.test/api/sub/t", username: "u" },
  });
}

const CLIENTS = ["mihomo/1.18.10", "Stash/2.4.6 Clash/1.9.0", "SFA/1.9.3 (sing-box 1.9.3)", "v2rayN/7.4.2", "Shadowrocket/2.2.48", "Surge iOS/3048", "Loon/3.2.4", "Quantumult%20X/1.5.0", ""];

test("渲染器不改它拿到的文档：冻住的文档渲染出来和没冻的一字不差，控制字符照样去掉", () => {
  const frozen = build();
  deepFreeze(frozen.document);
  deepFreeze(frozen.infoNodes);
  let rendered = 0;
  for (const format of PROXY_SUBSCRIPTION_FORMATS) {
    for (const profile of [false, true]) {
      for (const userAgent of CLIENTS) {
        const input = (built: ProxySubPipelineDocument) => ({
          built,
          format,
          profile,
          profileUrl: "https://panel.example.test/api/sub/t?rules=1",
          client: userAgent ? detectProxyClient(userAgent) : null,
          settings: PROXY_SUB_DEFAULT_SETTINGS,
          template: null,
          vars: { appName: "NEX", panelUrl: "https://panel.example.test", subUrl: "https://panel.example.test/api/sub/t", username: "u", expireDate: "长期", dataLeft: "不限" },
          weightedLoadBalance: userAgent.startsWith("mihomo"),
          shadowrocketClient: userAgent.startsWith("Shadowrocket"),
        });
        const fromFrozen = renderProxySubPipeline(input(frozen));
        const fromFresh = renderProxySubPipeline(input(build()));
        assert.equal(fromFrozen, fromFresh, `${format} ${profile ? "规则" : "节点"} ${userAgent || "(无 UA)"}`);
        assert.ok(!fromFrozen.includes("[MITM]\n") && !fromFrozen.includes("\n[MITM]"), `${format}：sni 里的换行没去掉`);
        rendered += 1;
      }
    }
  }
  assert.equal(rendered, PROXY_SUBSCRIPTION_FORMATS.length * 2 * CLIENTS.length);
});
