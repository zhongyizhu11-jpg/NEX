import assert from "node:assert/strict";
import test from "node:test";

import {
  formatProxySubRuleRows,
  moveProxySubRow,
  newProxySubRuleRow,
  parseProxySubRuleRows,
  patchProxySubRuleRow,
  proxySubRuleRowProblem,
  type ProxySubRuleRow,
} from "./proxySubTemplateEditor";
import { parseProxyCustomRules } from "./proxySubCustomRules";
import { customGroupsFor } from "./proxySubscriptionPlan";
import {
  findProxySubCustomGroupCycle,
  normalizeProxySubCustomGroups,
  parseProxySubCustomGroupsJson,
  validateProxySubTemplate,
} from "./proxySubTemplates";
import { loonPluginLine, loonPluginSection, normalizeProxySubTemplateModules, proxySubModuleProblem } from "./proxySubModules";
import { renderProxySubTemplatePreview } from "./proxySubTemplatePreview";

type RuleRow = Extract<ProxySubRuleRow, { kind: "rule" }>;

// ==================== 规则：文本 ⇄ 卡片 原样往返 ====================

const RULES_TEXT = [
  "# 公司内网走直连",
  "DOMAIN-SUFFIX,Corp.Example.,DIRECT",
  "  IP-CIDR,10.0.0.0/8,DIRECT,no-resolve  ",
  "",
  "# GEOSITE,netflix,🎬 流媒体",
  "PROCESS-NAME,Telegram,PROXY",
  "DOMAIN,bad domain,DIRECT",
  "GEOIP,jp,⚡ 专线\r",
  "; DOMAIN-KEYWORD,ads,REJECT",
].join("\n");

test("规则文本拆成卡片再拼回去：没改过的一个字都不变（注释、空行、认不出的、写坏的都在）", () => {
  const rows = parseProxySubRuleRows(RULES_TEXT);
  assert.equal(formatProxySubRuleRows(rows), RULES_TEXT);
  const kinds = rows.map((row) => (row.kind === "rule" ? `${row.enabled ? "on" : "off"}:${row.type}` : "raw"));
  assert.deepEqual(kinds, ["raw", "on:DOMAIN-SUFFIX", "on:IP-CIDR", "raw", "off:GEOSITE", "raw", "raw", "on:GEOIP", "off:DOMAIN-KEYWORD"]);
  assert.equal(formatProxySubRuleRows(parseProxySubRuleRows("")), "");
  assert.equal(formatProxySubRuleRows(parseProxySubRuleRows("DOMAIN,a.com,DIRECT\n")), "DOMAIN,a.com,DIRECT\n");
});

test("改过的行按字段重新拼；停用 = 注释行，渲染时跳过，开回来又是一条规则", () => {
  const rows = parseProxySubRuleRows(RULES_TEXT);
  const suffix = rows[1] as RuleRow;
  assert.equal(suffix.value, "corp.example");
  const edited = rows.map((row, index) => (index === 1 ? patchProxySubRuleRow(suffix, { enabled: false }) : row));
  const text = formatProxySubRuleRows(edited);
  assert.match(text, /^# 公司内网走直连\n# DOMAIN-SUFFIX,corp\.example,DIRECT\n {2}IP-CIDR/);
  // 别的行原样；服务端解析时停用那条不算。
  const parsed = parseProxyCustomRules(text);
  assert.ok(!parsed.rules.some((rule) => rule.value === "corp.example"));
  // 再拆一次：那一行是「停用的规则」，不是普通注释。
  const again = parseProxySubRuleRows(text)[1] as RuleRow;
  assert.equal(again.kind, "rule");
  assert.equal(again.enabled, false);
  const back = formatProxySubRuleRows(parseProxySubRuleRows(text).map((row, index) => (index === 1 ? patchProxySubRuleRow(row as RuleRow, { enabled: true }) : row)));
  assert.match(back, /\nDOMAIN-SUFFIX,corp\.example,DIRECT\n/);
});

test("不解析只给 IP 类规则写；新卡片默认去主选择器；上下挪；写坏的能报出来", () => {
  const row = patchProxySubRuleRow(newProxySubRuleRow() as RuleRow, { type: "DOMAIN", value: "a.com", noResolve: true }) as RuleRow;
  assert.equal(formatProxySubRuleRows([row]), "DOMAIN,a.com,PROXY");
  const ip = patchProxySubRuleRow(row, { type: "IP-CIDR", value: "1.2.3.0/24" }) as RuleRow;
  assert.equal(formatProxySubRuleRows([ip]), "IP-CIDR,1.2.3.0/24,PROXY,no-resolve");
  assert.equal(proxySubRuleRowProblem(ip), null);
  assert.match(String(proxySubRuleRowProblem(patchProxySubRuleRow(ip, { value: "999.1.1.1" }) as RuleRow)), /IPv4/);
  assert.deepEqual(moveProxySubRow(["a", "b", "c"], 2, -1), ["a", "c", "b"]);
  assert.deepEqual(moveProxySubRow(["a", "b"], 0, -1), ["a", "b"]);
});

// ==================== 策略组：点名成员、引用别的组、认不出的字段 ====================

test("组可以点名成员（别的组、自动 / 地区组、节点、DIRECT），不挑节点；不存在的名字丢掉", () => {
  const nodes = ["香港 01", "香港 02", "日本 01"];
  const built = ["🇭🇰 香港"];
  const groups = customGroupsFor([
    { name: "🚀 节点选择", type: "select", filter: "", includeNodes: false, members: ["⚡ 专线", "🇭🇰 香港", "DIRECT", "不存在的组", "日本 01"] },
    { name: "⚡ 专线", type: "url-test", filter: "香港", match: "any" },
    { name: "空组", type: "select", filter: "美国" },
    { name: "引用空组", type: "select", filter: "", includeNodes: false, members: ["空组"] },
  ], nodes, built);
  assert.deepEqual(groups, [
    { name: "🚀 节点选择", type: "select", members: ["⚡ 专线", "🇭🇰 香港", "DIRECT", "日本 01"] },
    { name: "⚡ 专线", type: "url-test", members: ["香港 01", "香港 02"] },
  ]);
  // 老模板（不点名成员）还是原来的算法。
  assert.deepEqual(customGroupsFor([{ name: "全部", type: "select", filter: "", includeGroups: true }], nodes, built), [
    { name: "全部", type: "select", members: ["🇭🇰 香港", ...nodes] },
  ]);
});

test("组互相引用成环：保存时报错，渲染时（老数据）丢掉成环的那条边", () => {
  const cyclic = [
    { name: "A", type: "select" as const, filter: "", members: ["B"] },
    { name: "B", type: "select" as const, filter: "", members: ["A"] },
  ];
  assert.deepEqual(findProxySubCustomGroupCycle(cyclic), ["A", "B", "A"]);
  const verdict = validateProxySubTemplate({ target: "clash", prelude: "", customGroups: cyclic });
  assert.equal(verdict.ok, false);
  const rendered = customGroupsFor(cyclic, ["n1"], []);
  assert.deepEqual(rendered.map((group) => group.members), [["B", "n1"], ["n1"]]);
});

test("组的校验：不能放 REJECT / 主选择器 / 自己，不能是空组", () => {
  const check = (group: Record<string, unknown>) => validateProxySubTemplate({ target: "clash", prelude: "", customGroups: [{ name: "g", type: "select", filter: "", ...group } as any] }).ok;
  assert.equal(check({ members: ["REJECT"] }), false);
  assert.equal(check({ members: ["NEX"] }), false);
  assert.equal(check({ members: ["PROXY"] }), false);
  assert.equal(check({ members: ["g"] }), false);
  assert.equal(check({ members: ["a,b"] }), false);
  assert.equal(check({ includeNodes: false }), false);
  assert.equal(check({ includeNodes: false, members: ["DIRECT"] }), true);
});

test("组的归一化：新字段只在用到时写（老模板存回去不变），认不出的字段原样留下", () => {
  const old = [{ name: "香港", type: "url-test", filter: "港", match: "any", includeGroups: false }];
  assert.equal(JSON.stringify(normalizeProxySubCustomGroups(old)), JSON.stringify(old));
  const withExtras = normalizeProxySubCustomGroups([{
    name: "A", type: "select", filter: "", members: [" B ", "B", "", "DIRECT"], includeNodes: false,
    icon: "https://example.com/a.png", hidden: true, "x-sort": 3, __proto__: { polluted: true }, constructor: "no",
  }]);
  assert.deepEqual(withExtras[0], {
    icon: "https://example.com/a.png", hidden: true, "x-sort": 3,
    name: "A", type: "select", filter: "", match: "regex", includeGroups: false, members: ["B", "DIRECT"], includeNodes: false,
  });
  // 存成 JSON 再读回来还是同一份（可视化编辑器 → 保存 → 再打开）。
  assert.deepEqual(parseProxySubCustomGroupsJson(JSON.stringify(withExtras)), withExtras);
  // 附加字段太大就不留，不让它变成存储桶。
  const huge = normalizeProxySubCustomGroups([{ name: "A", type: "select", blob: "x".repeat(5000) }]);
  assert.equal("blob" in huge[0], false);
});

// ==================== 模板规则 / 插件 ====================

test("模板分流规则：写坏的行保存时报出来；停用（注释）的不算错", () => {
  assert.equal(validateProxySubTemplate({ target: "clash", prelude: "", customGroups: [], customRules: "DOMAIN,a.com,DIRECT\n# DOMAIN,b.com,DIRECT" }).ok, true);
  const bad = validateProxySubTemplate({ target: "clash", prelude: "", customGroups: [], customRules: "DOMAIN,a.com,DIRECT\nNOPE,x,DIRECT" });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /第 2 行/);
});

test("Loon 插件：只收 http(s)、不含逗号空白；有上限；只有 Loon 模板能挂", () => {
  assert.equal(proxySubModuleProblem({ url: "https://example.com/a.plugin", enabled: true, tag: "", argument: "" }, 0), null);
  assert.match(String(proxySubModuleProblem({ url: "ftp://example.com/a", enabled: true, tag: "", argument: "" }, 0)), /http/);
  assert.match(String(proxySubModuleProblem({ url: "https://example.com/a,b", enabled: true, tag: "", argument: "" }, 0)), /逗号/);
  assert.match(String(proxySubModuleProblem({ url: "javascript:alert(1)", enabled: true, tag: "", argument: "" }, 0)), /http/);
  assert.match(String(proxySubModuleProblem({ url: "https://e.com/a", enabled: true, tag: "a\nb", argument: "" }, 0)), /控制字符/);
  assert.match(String(proxySubModuleProblem({ url: "https://e.com/a", enabled: true, tag: "", argument: "x".repeat(1001) }, 0)), /太长/);
  const many = Array.from({ length: 31 }, (_, index) => ({ url: `https://e.com/${index}`, enabled: true, tag: "", argument: "" }));
  assert.equal(normalizeProxySubTemplateModules(many).length, 30);
  assert.equal(validateProxySubTemplate({ target: "loon", prelude: "", customGroups: [], modules: many }).ok, false);
  assert.equal(validateProxySubTemplate({ target: "clash", prelude: "", customGroups: [], modules: [many[0]] }).ok, false);
  assert.equal(validateProxySubTemplate({ target: "loon", prelude: "", customGroups: [], modules: [many[0]] }).ok, true);
});

test("Loon [Plugin] 行：地址、tag、argument（有逗号加引号，方括号原样）、enabled", () => {
  assert.equal(loonPluginLine({ url: "https://e.com/a.plugin", enabled: true, tag: "", argument: "" }), "https://e.com/a.plugin, enabled=true");
  assert.equal(loonPluginLine({ url: "https://e.com/a.plugin", enabled: false, tag: "去广告", argument: "a, b" }), "https://e.com/a.plugin, tag=去广告, argument=\"a, b\", enabled=false");
  assert.equal(loonPluginLine({ url: "https://e.com/a.plugin", enabled: true, tag: "", argument: "[{\"k\":1},2]" }), "https://e.com/a.plugin, argument=[{\"k\":1},2], enabled=true");
  assert.deepEqual(loonPluginSection([]), []);
  // 存进来之后规则收紧了、不合格的那条不写。
  assert.deepEqual(loonPluginSection([{ url: "http://e.com/x y", enabled: true, tag: "", argument: "" }]), []);
});

// ==================== 实时预览 ====================

test("预览：按模板的组 / 规则 / 插件走真流水线；Loon 才有 [Plugin]，Clash 预览里没有", () => {
  const template = {
    target: "loon" as const,
    prelude: "[General]\nskip-proxy = 127.0.0.1",
    customGroups: normalizeProxySubCustomGroups([
      { name: "🚀 节点选择", type: "select", filter: "", includeNodes: false, members: ["⚡ 专线", "DIRECT"] },
      { name: "⚡ 专线", type: "url-test", filter: "IPLC, IEPL", match: "any" },
    ]),
    customRules: "DOMAIN-SUFFIX,openai.com,⚡ 专线\n# DOMAIN,off.example,DIRECT\nDOMAIN,x.com,不存在的组\nBROKEN",
    modules: [{ url: "https://e.com/ad.plugin", enabled: true, tag: "去广告", argument: "" }],
  };
  const clash = renderProxySubTemplatePreview(template, "clash");
  assert.equal(clash.format, "clash");
  assert.match(clash.text, /- name: "🚀 节点选择"\n {4}type: select\n {4}proxies: \["⚡ 专线", "DIRECT"\]/);
  assert.match(clash.text, /- name: "⚡ 专线"\n {4}type: url-test\n {4}proxies: \["香港 IPLC 01", "日本 IEPL 01"\]/);
  assert.match(clash.text, /- DOMAIN-SUFFIX,openai\.com,⚡ 专线/);
  // 指向不存在的组 → 回落到主选择器，和真订阅一样；停用的不出现。
  assert.match(clash.text, /- DOMAIN,x\.com,NEX/);
  assert.ok(!clash.text.includes("off.example"));
  assert.ok(!clash.text.includes("[Plugin]"));
  assert.ok(!clash.text.includes("skip-proxy = 127.0.0.1"), "别的格式的开头部分不套进 Clash 预览");
  assert.deepEqual(clash.ruleErrors.map((item) => item.line), [4]);
  const loon = renderProxySubTemplatePreview(template, "loon");
  assert.match(loon.text, /^\[General\]\nskip-proxy = 127\.0\.0\.1/m);
  assert.match(loon.text, /\n\[Plugin\]\nhttps:\/\/e\.com\/ad\.plugin, tag=去广告, enabled=true\n$/);
});
