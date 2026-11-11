import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyProxyNode, type ProxyNode } from "./proxyNode";
import { parseMiniYaml, type YamlValue } from "./miniYaml";
import { renderProxySubscription, normalizeProxySubscriptionFormat, proxyNodeUnsupportedReasonForFormat, PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES } from "./proxySubscription";
import type { ProxySubscriptionDocument } from "./proxySubscriptionPlan";
import { egernUnsupportedReason, EGERN_SCHEMA } from "./proxySubEgern";
import { parseEgernModuleArguments, proxySubModuleProblem, loonPluginLine } from "./proxySubModules";
import { PROXY_SUB_BUILTIN_PRELUDES, validateProxySubTemplate } from "./proxySubTemplates";
import { detectProxyClient } from "./proxyClientUserAgent";
import { PROXY_CLIENT_TARGETS, proxyClientImportFor, proxySubscriptionKindSupported } from "./proxyClientImport";
import { proxyClientCompatibility } from "./proxyClientCompatibility";
import { renderProxySubTemplatePreview } from "./proxySubTemplatePreview";

function make(partial: Partial<ProxyNode>): ProxyNode {
  return { ...createEmptyProxyNode(), address: "198.51.100.1", port: 443, ...partial };
}

type Obj = { [key: string]: YamlValue };

/** proxies / policy_groups / rules 里每一项都是「类型名: {字段}」的单键映射，拆成 [类型, 字段]。 */
function entries(list: YamlValue | undefined): Array<[string, Obj]> {
  assert.ok(Array.isArray(list), "应该是一个列表");
  return list.map((item) => {
    assert.ok(item && typeof item === "object" && !Array.isArray(item));
    const keys = Object.keys(item);
    assert.equal(keys.length, 1, `每一项只能有一个键（类型名）：${JSON.stringify(item)}`);
    return [keys[0], (item as Obj)[keys[0]] as Obj];
  });
}

function profile(document: ProxySubscriptionDocument, options: Parameters<typeof renderProxySubscription>[2] = {}): Obj {
  return parseMiniYaml(renderProxySubscription(document, "egern", { profile: true, ...options })) as Obj;
}

function proxyOf(node: ProxyNode): [string, Obj] {
  const parsed = parseMiniYaml(renderProxySubscription({ nodes: [node], groups: [], ruleSets: [], rules: [] }, "egern")) as Obj;
  const list = entries(parsed.proxies);
  assert.equal(list.length, 1, `节点被跳过了：${egernUnsupportedReason(node)}`);
  return list[0];
}

test("格式名、Content-Type：egern 是独立的格式，YAML", () => {
  assert.equal(normalizeProxySubscriptionFormat("egern"), "egern");
  assert.equal(normalizeProxySubscriptionFormat("EGERN"), "egern");
  assert.match(PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES.egern, /^text\/yaml/);
});

test("Shadowsocks（含 2022）、SOCKS5 / SOCKS5 over TLS：字段名照 Egern 文档", () => {
  const [type, ss] = proxyOf(make({ protocol: "shadowsocks", name: "SS", method: "2022-blake3-aes-128-gcm", password: "a2V5", udp: true }));
  assert.equal(type, "shadowsocks");
  assert.deepEqual(ss, { name: "SS", server: "198.51.100.1", port: 443, method: "2022-blake3-aes-128-gcm", password: "a2V5", udp_relay: true });

  const [socksType, socks] = proxyOf(make({ protocol: "socks5", name: "S5", username: "u", password: "p", udp: false }));
  assert.equal(socksType, "socks5");
  assert.deepEqual(socks, { name: "S5", server: "198.51.100.1", port: 443, username: "u", password: "p", udp_relay: false });

  const [tlsType, tls] = proxyOf(make({ protocol: "socks5", name: "S5T", tls: true, sni: "s.example", allowInsecure: true }));
  assert.equal(tlsType, "socks5_tls");
  assert.equal(tls.sni, "s.example");
  assert.equal(tls.skip_tls_verify, true);
});

test("VMess / VLESS：user_id、transport 子块（ws / wss / tls+REALITY / grpc / http2），老式 VMess 标 legacy", () => {
  const [, ws] = proxyOf(make({ protocol: "vmess", name: "VM", uuid: "u-1", method: "auto", alterId: 0, transport: "ws", path: "/ws", host: "cdn.example", udp: true }));
  assert.deepEqual(ws, { name: "VM", server: "198.51.100.1", port: 443, user_id: "u-1", security: "auto", udp_relay: true, transport: { ws: { path: "/ws", headers: { Host: "cdn.example" } } } });

  const [, legacy] = proxyOf(make({ protocol: "vmess", name: "VM0", uuid: "u", alterId: 64 }));
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.transport, undefined, "裸 TCP 不写 transport");

  const [, wss] = proxyOf(make({ protocol: "vless", name: "VL", uuid: "u-2", transport: "ws", tls: true, sni: "a.example", path: "", allowInsecure: true }));
  assert.deepEqual((wss.transport as Obj).wss, { path: "/", sni: "a.example", skip_tls_verify: true });

  const [, reality] = proxyOf(make({ protocol: "vless", name: "VR", uuid: "u-3", flow: "xtls-rprx-vision", tls: true, sni: "www.microsoft.com", realityPublicKey: "PUB", realityShortId: "ab12", fingerprint: "chrome" }));
  assert.equal(reality.flow, "xtls-rprx-vision");
  assert.deepEqual(reality.transport, { tls: { sni: "www.microsoft.com", reality: { public_key: "PUB", short_id: "ab12" } } });

  const [, grpc] = proxyOf(make({ protocol: "vless", name: "VG", uuid: "u", transport: "grpc", tls: true, path: "svc", sni: "g.example", certSha256: "aa:bb" }));
  assert.deepEqual(grpc.transport, { grpc: { service_name: "svc", sni: "g.example", fingerprint_sha256: "aa:bb" } });

  const [, h2] = proxyOf(make({ protocol: "vmess", name: "VH", uuid: "u", transport: "http", tls: true, path: "/h", host: "h.example", sni: "h.example" }));
  assert.deepEqual(h2.transport, { http2: { path: "/h", headers: { Host: "h.example" }, sni: "h.example" } });
  const [, h1] = proxyOf(make({ protocol: "vmess", name: "VH1", uuid: "u", transport: "http", path: "/h" }));
  assert.deepEqual(h1.transport, { http1: { path: "/h" } });
});

test("Trojan / AnyTLS：TLS 字段在代理上，Trojan 的 WebSocket 是 websocket 子块；AnyTLS 显式写校验", () => {
  const [, trojan] = proxyOf(make({ protocol: "trojan", name: "TJ", password: "pw", sni: "t.example", transport: "ws", path: "/tj", host: "cdn.example", udp: true }));
  assert.deepEqual(trojan, { name: "TJ", server: "198.51.100.1", port: 443, password: "pw", udp_relay: true, sni: "t.example", websocket: { path: "/tj", host: "cdn.example" } });

  const [, anytls] = proxyOf(make({ protocol: "anytls", name: "AT", password: "pw", sni: "a.example", udp: true }));
  // Egern 的 AnyTLS 不写这个键就默认跳过校验；NEX 没勾「跳过」就该校验。
  assert.equal(anytls.skip_tls_verify, false);
  const [, anytlsInsecure] = proxyOf(make({ protocol: "anytls", name: "AT2", password: "pw", allowInsecure: true }));
  assert.equal(anytlsInsecure.skip_tls_verify, true);
});

test("Hysteria2 / TUIC / Snell：各自的键名（auth、bandwidth、udp_relay_mode、psk）", () => {
  const [, hy2] = proxyOf(make({ protocol: "hysteria2", name: "HY", password: "pw", sni: "h.example", obfs: "salamander", obfsPassword: "ob", upMbps: 100, downMbps: 500, alpn: ["h3"] }));
  assert.deepEqual(hy2, { name: "HY", server: "198.51.100.1", port: 443, auth: "pw", obfs: "salamander", obfs_password: "ob", bandwidth: 100, sni: "h.example" });

  const [, tuic] = proxyOf(make({ protocol: "tuic", name: "TU", uuid: "u", password: "pw", udpRelayMode: "quic", congestionControl: "bbr", alpn: ["h3"], sni: "t.example" }));
  assert.deepEqual(tuic, { name: "TU", server: "198.51.100.1", port: 443, uuid: "u", password: "pw", udp_relay_mode: "quic", alpn: ["h3"], sni: "t.example" });

  const [, snell] = proxyOf(make({ protocol: "snell", name: "SN", password: "psk", snellVersion: 4, udp: true, obfs: "http", host: "bing.com" }));
  assert.deepEqual(snell, { name: "SN", server: "198.51.100.1", port: 443, psk: "psk", version: 4, udp_relay: true, obfs: "http", obfs_host: "bing.com" });
  const [, snellV2] = proxyOf(make({ protocol: "snell", name: "SN2", password: "psk", snellVersion: 2, udp: true }));
  assert.equal(snellV2.udp_relay, undefined, "v1 / v2 没有 UDP，不写");
});

test("前置代理写成 prev_hop，名字不带「需手动接」", () => {
  const [, chained] = proxyOf(make({ protocol: "shadowsocks", name: "落地", method: "aes-128-gcm", password: "p", frontProxyName: "前置" }));
  assert.equal(chained.prev_hop, "前置");
  assert.equal(chained.name, "落地");
});

test("写不出来的跳过，文件头写原因，策略组里的引用一起清掉", () => {
  const bad: ProxyNode[] = [
    make({ protocol: "vless", name: "XH", uuid: "u", transport: "xhttp", tls: true }),
    make({ protocol: "vless", name: "HU", uuid: "u", transport: "httpupgrade" }),
    make({ protocol: "snell", name: "S6", password: "p", snellVersion: 6 }),
    make({ protocol: "hysteria2", name: "GK", password: "p", obfs: "gecko", obfsPassword: "x" }),
    make({ protocol: "trojan", name: "TG", password: "p", transport: "grpc" }),
    make({ protocol: "vmess", name: "GN", uuid: "u", transport: "grpc" }),
    make({ protocol: "vless", name: "RW", uuid: "u", transport: "ws", tls: true, realityPublicKey: "k" }),
    make({ protocol: "shadowsocks", name: "XC", method: "xchacha20-ietf-poly1305", password: "p" }),
  ];
  const good = make({ protocol: "shadowsocks", name: "OK", method: "aes-128-gcm", password: "p" });
  for (const node of bad) assert.notEqual(proxyNodeUnsupportedReasonForFormat(node, "egern"), "", node.name);
  const text = renderProxySubscription({
    nodes: [...bad, good],
    groups: [{ name: "NEX", type: "select", members: [...bad.map((node) => node.name), "OK"] }],
    ruleSets: [],
    rules: [{ type: "match", target: "NEX" }],
  }, "egern", { profile: true });
  for (const node of bad) assert.match(text, new RegExp(`# 已跳过节点「${node.name}」：`), node.name);
  assert.match(text, /Egern 不支持 XHTTP 传输/);
  assert.match(text, /Egern 的 Snell 只支持 v1–v5/);
  assert.match(text, /Egern 的 Trojan 只能走 TCP 或 WebSocket/);
  const parsed = parseMiniYaml(text) as Obj;
  assert.deepEqual(entries(parsed.proxies).map(([, item]) => item.name), ["OK"]);
  assert.deepEqual(entries(parsed.policy_groups)[0][1].policies, ["OK"]);
});

test("节点订阅只有 proxies；规则订阅才有策略组、规则、开头部分和 auto_update", () => {
  const document: ProxySubscriptionDocument = {
    nodes: [make({ protocol: "trojan", name: "A", password: "p" })],
    groups: [{ name: "NEX", type: "select", members: ["A"] }],
    ruleSets: [],
    rules: [{ type: "match", target: "NEX" }],
  };
  const nodes = parseMiniYaml(renderProxySubscription(document, "egern")) as Obj;
  assert.deepEqual(Object.keys(nodes), ["proxies"]);
  assert.equal(renderProxySubscription({ nodes: [], groups: [], ruleSets: [], rules: [] }, "egern"), "proxies: []\n");

  const full = profile(document, { profileUrl: "https://panel.example/api/sub/t?rules=1", prelude: "ipv6: true", settings: { updateIntervalHours: 6 } });
  assert.deepEqual(Object.keys(full), ["ipv6", "auto_update", "proxies", "policy_groups", "rules"]);
  assert.deepEqual(full.auto_update, { url: "https://panel.example/api/sub/t?rules=1", interval: 21600 });
  // 模板自己写了 auto_update：不再写第二份（重复键）。
  const own = renderProxySubscription(document, "egern", { profile: true, profileUrl: "https://x", prelude: "auto_update:\n  url: https://y\n  interval: 60" });
  assert.equal(own.match(/^auto_update:/gm)?.length, 1);
});

test("策略组：select / auto_test / fallback / load_balance（轮询），测速参数写在组上，外部订阅挂成 urls", () => {
  const parsed = profile({
    nodes: [make({ protocol: "trojan", name: "A", password: "p" }), make({ protocol: "trojan", name: "B", password: "p" })],
    groups: [
      { name: "NEX", type: "select", members: ["自动", "主备", "均衡", "外部", "DIRECT"] },
      { name: "自动", type: "url-test", members: ["A", "B"] },
      { name: "主备", type: "fallback", members: ["A", "B"] },
      { name: "均衡", type: "load-balance", members: ["A", "B"], weights: [5, 3] },
      { name: "外部", type: "select", members: [], use: ["机场"] },
    ],
    ruleSets: [],
    rules: [{ type: "match", target: "NEX" }],
    providers: [{ name: "机场", url: "https://airport.example/sub", intervalSec: 3600 }],
  }, { settings: { testUrl: "http://t.example/204", testIntervalSec: 120, toleranceMs: 80 } });
  const groups = entries(parsed.policy_groups);
  assert.deepEqual(groups.map(([type]) => type), ["select", "auto_test", "fallback", "load_balance", "select"]);
  assert.deepEqual(groups[0][1], { name: "NEX", policies: ["自动", "主备", "均衡", "外部", "DIRECT"] });
  assert.deepEqual(groups[1][1], { name: "自动", policies: ["A", "B"], latency_test_url: "http://t.example/204", interval: 120, tolerance: 80 });
  assert.deepEqual(groups[2][1], { name: "主备", policies: ["A", "B"], latency_test_url: "http://t.example/204", interval: 120 });
  // 加权只给 mihomo 展开；Egern 平均分，成员不重复。
  assert.deepEqual(groups[3][1], { name: "均衡", policies: ["A", "B"], latency_test_url: "http://t.example/204", algorithm: "round_robin" });
  assert.deepEqual(groups[4][1], { name: "外部", urls: ["https://airport.example/sub"], update_interval: 3600 });
  assert.equal(EGERN_SCHEMA.groupType["url-test"], "auto_test");
});

test("规则：域名 / 关键字 / 网段（no_resolve）/ GEOIP / 规则集（Surge 列表，走镜像）/ default；GEOSITE 跳过", () => {
  const parsed = profile({
    nodes: [make({ protocol: "trojan", name: "A", password: "p" })],
    groups: [{ name: "NEX", type: "select", members: ["A"] }],
    ruleSets: [{ name: "ads", behavior: "domain", geoKey: "category-ads-all" }, { name: "cn-ip", behavior: "ipcidr", geoKey: "cn" }],
    rules: [
      { type: "domain", match: "exact", value: "a.example", target: "DIRECT" },
      { type: "domain", match: "suffix", value: "b.example", target: "NEX" },
      { type: "domain", match: "keyword", value: "google", target: "NEX" },
      { type: "ip-cidr", value: "10.0.0.0/8", v6: false, target: "DIRECT" },
      { type: "ip-cidr", value: "2001:db8::/32", v6: true, target: "REJECT" },
      { type: "geoip", code: "JP", target: "NEX" },
      { type: "geosite", key: "netflix", target: "NEX" },
      { type: "rule-set", ruleSet: "ads", target: "REJECT" },
      { type: "rule-set", ruleSet: "cn-ip", target: "DIRECT" },
      { type: "match", target: "NEX" },
    ],
  }, { settings: { rulesetMirror: "https://ghproxy.example", rulesetIntervalSec: 3600 } });
  const rules = entries(parsed.rules);
  assert.deepEqual(rules, [
    ["domain", { match: "a.example", policy: "DIRECT" }],
    ["domain_suffix", { match: "b.example", policy: "NEX" }],
    ["domain_keyword", { match: "google", policy: "NEX" }],
    ["ip_cidr", { match: "10.0.0.0/8", policy: "DIRECT", no_resolve: true }],
    ["ip_cidr6", { match: "2001:db8::/32", policy: "REJECT", no_resolve: true }],
    ["geoip", { match: "JP", policy: "NEX" }],
    ["rule_set", { match: "https://ghproxy.example/https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/AdvertisingLite/AdvertisingLite.list", policy: "REJECT", update_interval: 3600 }],
    // 国内 IP 用 Egern 自带的 GEOIP,CN，不下列表。
    ["geoip", { match: "CN", policy: "DIRECT" }],
    ["default", { policy: "NEX" }],
  ]);
});

test("模块：写成 modules（url / name / enabled / compat_arguments），只进规则订阅，写坏的跳过", () => {
  const document: ProxySubscriptionDocument = { nodes: [make({ protocol: "trojan", name: "A", password: "p" })], groups: [{ name: "NEX", type: "select", members: ["A"] }], ruleSets: [], rules: [{ type: "match", target: "NEX" }] };
  const modules = [
    { url: "https://m.example/ad.yaml", enabled: true, tag: "去广告", argument: "BLOCK_MODE=reject&REGION=cn" },
    { url: "https://m.example/off.sgmodule", enabled: false, tag: "", argument: "" },
    { url: "ftp://m.example/bad", enabled: true, tag: "", argument: "" },
  ];
  const parsed = profile(document, { modules });
  assert.deepEqual(parsed.modules, [
    { url: "https://m.example/ad.yaml", name: "去广告", enabled: true, compat_arguments: { BLOCK_MODE: "reject", REGION: "cn" } },
    { url: "https://m.example/off.sgmodule", enabled: false },
  ]);
  // 节点订阅里没有模块；没有能写的模块时也不留空的 modules:。
  assert.doesNotMatch(renderProxySubscription(document, "egern", { modules }), /modules:/);
  assert.doesNotMatch(renderProxySubscription(document, "egern", { profile: true, modules: [modules[2]] }), /modules:/);
});

test("Egern 模块参数：KEY=值&KEY2=值；不收 Loon 的 [ ] 写法、引号、重复键", () => {
  assert.deepEqual(parseEgernModuleArguments("A=1& B = x,y:z &"), { ok: true, pairs: [["A", "1"], ["B", "x,y:z"]] });
  assert.deepEqual(parseEgernModuleArguments(""), { ok: true, pairs: [] });
  const base = { url: "https://m.example/a.yaml", enabled: true, tag: "" };
  assert.match(proxySubModuleProblem({ ...base, argument: "[{a},{b}]" }, 0, "egern") || "", /第 1 个模块.*KEY=值/);
  assert.match(proxySubModuleProblem({ ...base, argument: "A=\"x\"" }, 1, "egern") || "", /第 2 个模块.*双引号/);
  assert.match(proxySubModuleProblem({ ...base, argument: "A=1&A=2" }, 0, "egern") || "", /写了两次/);
  assert.equal(proxySubModuleProblem({ ...base, argument: "A=1&B=" }, 0, "egern"), null);
  // Loon 那边照旧：方括号整段原样写，不按 KEY=值 拆。
  assert.equal(proxySubModuleProblem({ ...base, argument: "[{a},{b}]" }, 0), null);
  assert.equal(loonPluginLine({ ...base, argument: "[{a},{b}]" }), "https://m.example/a.yaml, argument=[{a},{b}], enabled=true");
});

test("Egern 模板：能挂模块，开头部分不能含面板生成的那几段，内置开头部分合法", () => {
  const module = { url: "https://m.example/a.yaml", enabled: true, tag: "名字", argument: "K=v" };
  assert.deepEqual(validateProxySubTemplate({ target: "egern", prelude: "ipv6: true", customGroups: [], modules: [module] }), { ok: true });
  const loonStyle = validateProxySubTemplate({ target: "egern", prelude: "", customGroups: [], modules: [{ ...module, argument: "[{a}]" }] });
  assert.equal(loonStyle.ok, false);
  for (const key of ["proxies", "policy_groups", "rules", "modules"]) {
    const verdict = validateProxySubTemplate({ target: "egern", prelude: `ipv6: true\n${key}: []`, customGroups: [] });
    assert.equal(verdict.ok, false, key);
  }
  assert.equal(validateProxySubTemplate({ target: "surge", prelude: "", customGroups: [], modules: [module] }).ok, false);
  assert.deepEqual(validateProxySubTemplate({ target: "egern", prelude: PROXY_SUB_BUILTIN_PRELUDES.egern, customGroups: [] }), { ok: true });
});

test("模板预览：Egern 模板切到 Egern 格式能看到开头部分和模块", () => {
  const preview = renderProxySubTemplatePreview({
    target: "egern",
    prelude: "# 预览\nipv6: true",
    customGroups: [],
    modules: [{ url: "https://m.example/a.yaml", enabled: true, tag: "", argument: "" }],
  }, "egern");
  assert.equal(preview.format, "egern");
  const parsed = parseMiniYaml(preview.text) as Obj;
  assert.equal(parsed.ipv6, true);
  assert.deepEqual(parsed.modules, [{ url: "https://m.example/a.yaml", enabled: true }]);
  assert.ok(entries(parsed.proxies).length > 0);
});

test("UA：Egern 默认拿原生格式；导入链接、兼容表都有 Egern", () => {
  const client = detectProxyClient("Egern/1.20 CFNetwork/1568.200.51 Darwin/24.1.0");
  assert.equal(client.family, "egern");
  assert.equal(client.target, "egern");
  assert.equal(detectProxyClient("curl/8", "egern").target, "egern");

  assert.equal(proxySubscriptionKindSupported("egern", "rules"), true);
  const target = PROXY_CLIENT_TARGETS.find((item) => item.id === "egern")!;
  assert.equal(target.format, "egern");
  assert.equal(proxyClientImportFor(target, "nodes").buildImportUrl!("https://p.example/api/sub/t?format=egern", "x"), "egern:/subscriptions/new?url=https%3A%2F%2Fp.example%2Fapi%2Fsub%2Ft%3Fformat%3Degern");
  assert.ok(proxyClientImportFor(target, "rules").manualHint);

  const row = (inbound: Parameters<typeof proxyClientCompatibility>[0]) => proxyClientCompatibility(inbound).find((item) => item.id === "egern")!;
  assert.equal(row({ protocol: "vless", transport: "tcp", security: "reality", flow: "xtls-rprx-vision" }).ok, true);
  assert.equal(row({ protocol: "tuic", security: "acme" }).ok, true);
  assert.equal(row({ protocol: "snell", snellVersion: 6 }).ok, false);
  assert.equal(row({ protocol: "trojan", transport: "grpc", security: "tls" }).ok, false);
});
