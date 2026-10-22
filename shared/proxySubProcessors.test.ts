import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyProxyNode } from "./proxyNode";
import type { ProxySubscriptionEntry, ProxySubscriptionPlan } from "./proxySubscriptionPlan";
import {
  applyProxySubNaming,
  applyProxySubScope,
  buildProxySubInfoNodes,
  dedupeProxySubEntries,
  proxySubInfoNodeNames,
  renderProxySubNodeName,
  runProxySubEntryProcessors,
  sortProxySubEntries,
} from "./proxySubProcessors";
import { PROXY_SUB_DEFAULT_SETTINGS } from "./proxySubSettings";
import { PROXY_SUB_DEFAULT_TOKEN_OPTIONS, PROXY_SUB_EMPTY_SCOPE } from "./proxySubTokenScope";
import { guessProxySubRegionCode } from "./proxySubRegion";

function entry(input: {
  id: number;
  name: string;
  host?: string;
  template?: string;
  protocol?: any;
  address?: string;
  port?: number;
  kind?: "relay" | "direct";
  region?: string;
  custom?: boolean;
  latency?: number | null;
  front?: number;
}): ProxySubscriptionEntry {
  const node = createEmptyProxyNode();
  node.name = input.name;
  node.protocol = input.protocol || "vless";
  node.address = input.address || "1.2.3.4";
  node.port = input.port || 443;
  node.uuid = "u";
  return {
    ruleId: input.kind === "direct" ? 0 : input.id,
    templateId: input.id,
    kind: input.kind || "relay",
    frontTemplateId: input.front || 0,
    meta: {
      hostName: input.host ?? "广州",
      templateName: input.template ?? input.name,
      ruleName: `规则${input.id}`,
      customName: !!input.custom,
      regionCode: input.region || "",
      ...(input.latency !== undefined ? { latencyMs: input.latency } : {}),
    },
    node,
  };
}

const plan = (entries: ProxySubscriptionEntry[]): ProxySubscriptionPlan => ({ entries, skipped: [], warnings: [] });
const settings = { ...PROXY_SUB_DEFAULT_SETTINGS };
const options = { ...PROXY_SUB_DEFAULT_TOKEN_OPTIONS };

test("命名模板：默认模板保留现状，自定义模板按变量展开并清掉多余分隔符", () => {
  const a = entry({ id: 1, name: "广州 → HKT", template: "HKT", region: "HK" });
  const direct = entry({ id: 2, name: "HKT", template: "HKT", host: "", kind: "direct", region: "HK" });
  const unchanged = applyProxySubNaming(plan([a, direct]), { options, settings });
  assert.deepEqual(unchanged.entries.map((item) => item.node.name), ["广州 → HKT", "HKT"]);

  const named = applyProxySubNaming(plan([a, direct]), { options: { ...options, nameTemplate: "{flag}{country} {host} → {node} #{index}" }, settings });
  assert.deepEqual(named.entries.map((item) => item.node.name), ["🇭🇰香港 广州 → HKT #1", "🇭🇰香港 HKT #2"]);
  assert.equal(renderProxySubNodeName("{host} → {node}", { host: "", node: "HKT" }), "HKT");
});

test("旗帜、协议前缀、前后缀、正则改名按顺序叠加；地区从名字里猜", () => {
  const jp = entry({ id: 1, name: "东京 BGP", template: "东京 BGP", host: "上海" });
  assert.equal(guessProxySubRegionCode("东京 BGP"), "JP");
  const renamed = applyProxySubNaming(plan([jp]), {
    options: { ...options, flagEmoji: "on", protocolPrefix: "on", prefix: "[NEX] ", suffix: " ★", renames: [{ from: "BGP", to: "IEPL" }] },
    settings,
  });
  assert.equal(renamed.entries[0].node.name, "[NEX] [VLESS] 🇯🇵 上海 → 东京 IEPL ★");
  assert.equal(renamed.entries[0].node.regionCode, "JP");
  // 全局默认开旗帜，令牌不设 → 跟随；令牌设 off → 关。
  const withGlobal = applyProxySubNaming(plan([jp]), { options, settings: { ...settings, flagEmojiDefault: true } });
  assert.ok(withGlobal.entries[0].node.name.startsWith("🇯🇵"));
  const forcedOff = applyProxySubNaming(plan([jp]), { options: { ...options, flagEmoji: "off" }, settings: { ...settings, flagEmojiDefault: true } });
  assert.ok(!forcedOff.entries[0].node.name.startsWith("🇯🇵"));
});

test("作用域：白名单、黑名单、协议、地区、正则、直连 / 中转开关，并清掉指向被挡前置的引用", () => {
  const entries = [
    entry({ id: 1, name: "A", protocol: "vless", region: "HK" }),
    entry({ id: 2, name: "B", protocol: "trojan", region: "JP" }),
    entry({ id: 3, name: "C-direct", kind: "direct", region: "JP" }),
    entry({ id: 4, name: "D", protocol: "vless", region: "US", front: 3 }),
  ];
  assert.deepEqual(applyProxySubScope(plan(entries), { ...PROXY_SUB_EMPTY_SCOPE, templateIds: [1, 2] }).entries.map((item) => item.node.name), ["A", "B"]);
  assert.deepEqual(applyProxySubScope(plan(entries), { ...PROXY_SUB_EMPTY_SCOPE, excludeTemplateIds: [1] }).entries.map((item) => item.node.name), ["B", "C-direct", "D"]);
  assert.deepEqual(applyProxySubScope(plan(entries), { ...PROXY_SUB_EMPTY_SCOPE, protocols: ["trojan"] }).entries.map((item) => item.node.name), ["B"]);
  assert.deepEqual(applyProxySubScope(plan(entries), { ...PROXY_SUB_EMPTY_SCOPE, regions: ["JP"] }).entries.map((item) => item.node.name), ["B", "C-direct"]);
  assert.deepEqual(applyProxySubScope(plan(entries), { ...PROXY_SUB_EMPTY_SCOPE, include: "^[AB]$" }).entries.map((item) => item.node.name), ["A", "B"]);
  assert.deepEqual(applyProxySubScope(plan(entries), { ...PROXY_SUB_EMPTY_SCOPE, exclude: "direct" }).entries.map((item) => item.node.name), ["A", "B", "D"]);
  assert.deepEqual(applyProxySubScope(plan(entries), { ...PROXY_SUB_EMPTY_SCOPE, excludeRelay: true }).entries.map((item) => item.node.name), ["C-direct"]);
  // 非法正则退化成子串匹配，不抛。
  assert.deepEqual(applyProxySubScope(plan(entries), { ...PROXY_SUB_EMPTY_SCOPE, include: "[" }).entries, []);
  // 前置被挡掉：D 的 frontTemplateId 清零，不留悬空引用。
  const scoped = applyProxySubScope(plan(entries), { ...PROXY_SUB_EMPTY_SCOPE, excludeDirect: true });
  assert.equal(scoped.entries.find((item) => item.node.name === "D")?.frontTemplateId, 0);
});

test("去重与排序", () => {
  const dup = [entry({ id: 1, name: "A", address: "x", port: 1 }), entry({ id: 2, name: "A2", address: "x", port: 1 }), entry({ id: 3, name: "B", address: "y", port: 1 })];
  assert.deepEqual(dedupeProxySubEntries(plan(dup)).entries.map((item) => item.node.name), ["A", "B"]);

  const list = [
    entry({ id: 1, name: "b", region: "US", protocol: "trojan", latency: 80 }),
    entry({ id: 2, name: "a", region: "HK", protocol: "vless", latency: null }),
    entry({ id: 3, name: "c", region: "HK", protocol: "shadowsocks", latency: 20 }),
  ];
  assert.deepEqual(sortProxySubEntries(plan(list), "manual").entries.map((item) => item.node.name), ["b", "a", "c"]);
  assert.deepEqual(sortProxySubEntries(plan(list), "name").entries.map((item) => item.node.name), ["a", "b", "c"]);
  assert.deepEqual(sortProxySubEntries(plan(list), "region").entries.map((item) => item.node.name), ["a", "c", "b"]);
  assert.deepEqual(sortProxySubEntries(plan(list), "protocol").entries.map((item) => item.node.name), ["a", "b", "c"]);
  // 不通的（null）排最后。
  assert.deepEqual(sortProxySubEntries(plan(list), "latency").entries.map((item) => item.node.name), ["c", "b", "a"]);
});

test("udp / skip-cert-verify 覆盖只在令牌明确设了时生效", () => {
  const node = entry({ id: 1, name: "A" });
  node.node.udp = true;
  const same = runProxySubEntryProcessors(plan([node]), { scope: PROXY_SUB_EMPTY_SCOPE, options, settings });
  assert.equal(same.entries[0].node.udp, true);
  const off = runProxySubEntryProcessors(plan([node]), { scope: PROXY_SUB_EMPTY_SCOPE, options: { ...options, udp: "off", skipCertVerify: "on" }, settings });
  assert.equal(off.entries[0].node.udp, false);
  assert.equal(off.entries[0].node.allowInsecure, true);
});

test("信息节点：剩余流量、到期、重置日、公告，各是一条指向本机的 SS", () => {
  const names = proxySubInfoNodeNames({
    trafficUsed: 10 * 1024 ** 3,
    trafficLimit: 100 * 1024 ** 3,
    expiresAt: Date.now() + 10 * 86_400_000,
    announce: "  今晚 维护  两小时  ",
    nextResetAt: new Date(2026, 10, 1).getTime(),
  });
  assert.equal(names.length, 4);
  assert.match(names[0], /^📊 剩余 90(\.0+)? ?GB \/ 100(\.0+)? ?GB$/);
  assert.match(names[1], /到期（剩 10 天）/);
  assert.match(names[2], /11月1日 重置流量/);
  assert.equal(names[3], "📢 今晚 维护 两小时");
  const nodes = buildProxySubInfoNodes({ trafficUsed: 0, trafficLimit: 0, expiresAt: 0 });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].protocol, "shadowsocks");
  assert.equal(nodes[0].address, "127.0.0.1");
  assert.equal(nodes[0].name, "📊 已用 0 B（不限量）");
  assert.equal(nodes[1].name, "📅 长期有效");
});
