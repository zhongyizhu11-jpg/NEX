import assert from "node:assert/strict";
import test from "node:test";

import { PROXY_SUBSCRIPTION_GROUP_NAME, renderProxySubscription } from "./proxySubscription";
import {
  buildProxySubscriptionDocument,
  buildProxySubscriptionPlan,
  type ProxyNodeTemplateRow,
  type ProxySubscriptionDocument,
} from "./proxySubscriptionPlan";
import { buildProxyRulePlan, proxyRuleCategoryGroupName, PROXY_RULE_CATEGORIES, PROXY_RULE_TARGET_DIRECT } from "./proxyRuleset";
import {
  buildProxySubUnlockGroups,
  proxySubUnlockExitHostIds,
  proxySubUnlockQualifies,
  PROXY_SUB_UNLOCK_CATEGORY_RULES,
  type ProxySubUnlockServiceStatus,
  type ProxySubUnlockStatusMap,
} from "./proxySubUnlock";
import { buildProxySubPipelineDocument } from "./proxySubscriptionPipeline";
import { normalizeProxySubTokenOptions, normalizeProxySubTokenScope } from "./proxySubTokenScope";
import { normalizeProxySubSettings } from "./proxySubSettings";

function template(id: number, name: string, hostId?: number): ProxyNodeTemplateRow {
  return {
    id,
    ...(hostId ? { hostId } : {}),
    name,
    // trojan：七种格式都写得出，组不会因为节点被某个格式过滤掉而变空。
    protocol: "trojan",
    address: `${name.toLowerCase()}.example.com`,
    port: 443,
    password: `pw-${id}`,
    transport: "tcp",
    tls: true,
    isEnabled: true,
    includeDirect: true,
    autoGroup: "off",
  };
}

const TEMPLATES: ProxyNodeTemplateRow[] = [
  template(1, "US", 10),
  template(2, "JP", 20),
  template(3, "HK", 30),
  // 粘来的节点：没有机器，面板没测过。
  template(4, "Shared"),
];

const HOSTS = [
  { id: 1, name: "广州1", ip: "1.2.3.4", ipv4: "1.2.3.4" },
  { id: 10, name: "us-host", ip: "10.0.0.10" },
  { id: 20, name: "jp-host", ip: "10.0.0.20" },
  { id: 30, name: "hk-host", ip: "10.0.0.30" },
];

/** 一条中转：入口在广州1（host 1），落地是 JP（host 20）。 */
const RULES = [{ id: 7, hostId: 1, name: "jp-relay", sourcePort: 20001, proxyNodeId: 2, proxyNodeVisible: true, isEnabled: true, pendingDelete: false }];

function statuses(entries: Record<number, Record<string, [ProxySubUnlockServiceStatus["status"], number]>>): ProxySubUnlockStatusMap {
  const map = new Map<number, Map<string, ProxySubUnlockServiceStatus>>();
  for (const [hostId, services] of Object.entries(entries)) {
    map.set(Number(hostId), new Map(Object.entries(services).map(([id, [status, checkedAt]]) => [id, { status, checkedAt }])));
  }
  return map;
}

const STATUSES = statuses({
  10: { netflix: ["ok", 100], chatgpt: ["ok", 100], claude: ["blocked", 100] },
  20: { netflix: ["ok", 200], chatgpt: ["ok", 50], disney: ["partial", 200] },
  30: { netflix: ["blocked", 300] },
  // 入口机测出来能看 Disney+ 也没用：出口不是它。
  1: { disney: ["ok", 999] },
});

function plan() {
  return buildProxySubscriptionPlan({ rules: RULES, templates: TEMPLATES, hosts: HOSTS as any });
}

function doc(options: { unlock?: ProxySubUnlockStatusMap | null; categoryTargets?: Record<string, string> } = {}): ProxySubscriptionDocument {
  return buildProxySubscriptionDocument(plan(), TEMPLATES, {
    mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME,
    rulePreset: "comprehensive",
    categoryTargets: options.categoryTargets,
    unlockStatuses: options.unlock,
  });
}

function categoryGroup(document: ProxySubscriptionDocument, key: string) {
  const category = PROXY_RULE_CATEGORIES.find((item) => item.key === key)!;
  return document.groups.find((group) => group.name === proxyRuleCategoryGroupName(category));
}

test("条目带出口主机：直连是节点所在机器，中转是落地所在机器（不是入口机）", () => {
  const entries = plan().entries;
  const byName = new Map(entries.map((entry) => [entry.node.name, entry.meta?.exitHostId]));
  assert.equal(byName.get("US"), 10);
  assert.equal(byName.get("JP"), 20);
  assert.equal(byName.get("广州1 → JP"), 20);
  assert.equal(byName.get("Shared"), null);
  assert.deepEqual(proxySubUnlockExitHostIds(entries).sort((a, b) => a - b), [10, 20, 30]);
});

test("合格规则：必需服务全部 ok；AI 还要求 Claude / Gemini 没被测为不可用", () => {
  const ai = PROXY_SUB_UNLOCK_CATEGORY_RULES.find((rule) => rule.categoryKey === "ai")!;
  assert.equal(proxySubUnlockQualifies(STATUSES.get(20), ai), 50);
  assert.equal(proxySubUnlockQualifies(STATUSES.get(10), ai), null, "Claude 不可用");
  assert.equal(proxySubUnlockQualifies(STATUSES.get(30), ai), null, "没测 ChatGPT = 不算");
  assert.equal(proxySubUnlockQualifies(undefined, ai), null);
  const disney = PROXY_SUB_UNLOCK_CATEGORY_RULES.find((rule) => rule.categoryKey === "disney")!;
  assert.equal(proxySubUnlockQualifies(STATUSES.get(20), disney), null, "partial 不算");
  assert.equal(proxySubUnlockQualifies(statuses({ 1: { netflix: ["ok", 5], youtube_premium: ["ok", 3] } }).get(1), { required: ["netflix", "youtube_premium"] }), 3, "按最旧那次");
});

test("合格节点进解锁组（最近检测的在前），分类组首选它、原成员在后兜底", () => {
  const document = doc({ unlock: STATUSES });
  const netflix = document.groups.find((group) => group.name === "Netflix 解锁");
  assert.ok(netflix);
  assert.equal(netflix.type, "fallback");
  assert.deepEqual(netflix.members, ["JP", "广州1 → JP", "US"]);
  const ai = document.groups.find((group) => group.name === "AI 解锁");
  assert.deepEqual(ai?.members, ["JP", "广州1 → JP"]);

  const baseline = doc();
  for (const key of ["netflix", "ai"]) {
    const before = categoryGroup(baseline, key)!;
    const after = categoryGroup(document, key)!;
    assert.equal(after.members[0], key === "ai" ? "AI 解锁" : "Netflix 解锁");
    assert.deepEqual(after.members.slice(1), before.members, "原来的成员照旧，顺序不变");
  }
  // 解锁组不进主选择器。
  assert.ok(!document.groups[0].members.includes("Netflix 解锁"));
  // 规则本身不变：仍然指向分类组。
  assert.deepEqual(document.rules, baseline.rules);
});

test("没有合格节点的分类不出解锁组，分类组保持原样", () => {
  const document = doc({ unlock: STATUSES });
  assert.equal(document.groups.some((group) => group.name === "Disney+ 解锁"), false);
  assert.deepEqual(categoryGroup(document, "disney"), categoryGroup(doc(), "disney"));

  // 一台都不合格 / 没传结论：整份文档和原来一模一样。
  const none = statuses({ 10: { netflix: ["blocked", 1] }, 20: { chatgpt: ["unknown", 1] } });
  assert.deepEqual(doc({ unlock: none }), doc());
  assert.deepEqual(doc({ unlock: new Map() }), doc());
  assert.deepEqual(doc({ unlock: null }), doc());
});

test("令牌上的分类去向覆盖优先：不首选解锁组，也不出这个组", () => {
  for (const target of ["DIRECT", "PROXY", "US"]) {
    const document = doc({ unlock: STATUSES, categoryTargets: { netflix: target } });
    const baseline = doc({ categoryTargets: { netflix: target } });
    assert.deepEqual(categoryGroup(document, "netflix"), categoryGroup(baseline, "netflix"), target);
    assert.equal(document.groups.some((group) => group.name === "Netflix 解锁"), false, target);
    // 别的分类不受影响。
    assert.equal(categoryGroup(document, "ai")!.members[0], "AI 解锁");
  }
  const rejected = doc({ unlock: STATUSES, categoryTargets: { ai: "REJECT" } });
  assert.equal(rejected.groups.some((group) => group.name === "AI 解锁"), false);
});

test("没带规则 / 预设里没有这个分类时不出解锁组", () => {
  const document = buildProxySubscriptionDocument(plan(), TEMPLATES, {
    mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME,
    rulePreset: "off",
    unlockStatuses: STATUSES,
  });
  assert.equal(document.groups.some((group) => group.name.endsWith(" 解锁")), false);
  const groups = buildProxySubUnlockGroups([{ name: "a", exitHostId: 1 }], statuses({ 1: { disney: ["ok", 1], tiktok: ["ok", 1] } }), {
    categoryKeys: ["ai", "netflix"],
  });
  assert.deepEqual(groups.groups, []);
});

test("名字撞了已有节点 / 组就不出", () => {
  const result = buildProxySubUnlockGroups([{ name: "Netflix 解锁", exitHostId: 10 }, { name: "US", exitHostId: 10 }], STATUSES, {
    reservedNames: ["Netflix 解锁"],
  });
  assert.equal(result.groups.some((group) => group.name === "Netflix 解锁"), false);
  assert.equal(result.preferredByCategory.netflix, undefined);
});

test("buildProxyRulePlan：preferredGroups 只对默认走代理、未覆盖的分类生效", () => {
  const plan = buildProxyRulePlan({
    preset: "comprehensive",
    mainGroupName: "PROXY",
    selectableMembers: ["a"],
    preferredGroups: { netflix: "N", bilibili: "B" },
    categoryTargets: {},
  });
  const nf = plan.categoryGroups.find((group) => group.name.includes("奈飞"))!;
  assert.deepEqual(nf.members, ["N", "PROXY", PROXY_RULE_TARGET_DIRECT, "a"]);
  const bili = plan.categoryGroups.find((group) => group.name.includes("哔哩"))!;
  assert.deepEqual(bili.members, [PROXY_RULE_TARGET_DIRECT, "PROXY", "a"]);
});

test("流水线：结论透传进去，按令牌覆盖照样优先", () => {
  const base = {
    plan: plan(),
    templates: TEMPLATES,
    rulePreset: "comprehensive" as const,
    scope: normalizeProxySubTokenScope({}),
    settings: normalizeProxySubSettings({}),
    vars: { appName: "NEX", panelUrl: "", subUrl: "", username: "u" },
  };
  const built = buildProxySubPipelineDocument({ ...base, options: normalizeProxySubTokenOptions({}), unlockStatuses: STATUSES });
  assert.ok(built.document.groups.some((group) => group.name === "Netflix 解锁"));
  assert.equal(categoryGroup(built.document, "netflix")!.members[0], "Netflix 解锁");

  const overridden = buildProxySubPipelineDocument({ ...base, options: normalizeProxySubTokenOptions({ categoryTargets: { netflix: "DIRECT" } }), unlockStatuses: STATUSES });
  assert.equal(overridden.document.groups.some((group) => group.name === "Netflix 解锁"), false);
  assert.equal(categoryGroup(overridden.document, "netflix")!.members[0], PROXY_RULE_TARGET_DIRECT);
});

test("各格式都按已有的组写法输出解锁组", () => {
  const document = doc({ unlock: STATUSES });
  const netflixCategory = categoryGroup(document, "netflix")!.name;

  // Clash / mihomo：fallback 组 + 分类组的 proxies 第一个是它。
  const clash = renderProxySubscription(document, "clash");
  const clashLines = clash.split("\n");
  const at = clashLines.indexOf('  - name: "Netflix 解锁"');
  assert.ok(at > 0, "clash 里有解锁组");
  assert.equal(clashLines[at + 1], "    type: fallback");
  assert.equal(clashLines[at + 2], '    proxies: ["JP", "广州1 → JP", "US"]');
  const catAt = clashLines.indexOf(`  - name: "${netflixCategory}"`);
  assert.ok(clashLines[catAt + 2].startsWith('    proxies: ["Netflix 解锁", '));

  // sing-box：urltest 出站（fallback 没有单独类型），selector 的第一个成员即默认。
  const singbox = JSON.parse(renderProxySubscription(document, "singbox"));
  const unlock = singbox.outbounds.find((item: any) => item.tag === "Netflix 解锁");
  assert.equal(unlock.type, "urltest");
  assert.deepEqual(unlock.outbounds, ["JP", "广州1 → JP", "US"]);
  const selector = singbox.outbounds.find((item: any) => item.tag === netflixCategory);
  assert.equal(selector.outbounds[0], "Netflix 解锁");
  const tags = new Set(singbox.outbounds.map((item: any) => item.tag));
  for (const outbound of singbox.outbounds) {
    for (const member of outbound.outbounds || []) assert.ok(tags.has(member), `${outbound.tag} 引用了不存在的 ${member}`);
  }

  // Surge / Loon / QX / Shadowrocket 的完整配置。
  for (const format of ["surge", "loon", "quantumultx", "shadowrocket"] as const) {
    const text = renderProxySubscription(document, format, { profile: true });
    assert.ok(text.includes("Netflix 解锁"), `${format} 带解锁组`);
  }
  const surge = renderProxySubscription(document, "surge", { profile: true });
  assert.ok(surge.split("\n").some((line) => line.startsWith("Netflix 解锁 = fallback, JP, ")));
});

test("某个格式写不出组里的节点时，解锁组连同对它的引用一起去掉", () => {
  const document = doc({ unlock: STATUSES });
  // Surge 不支持 VLESS：把解锁组里的节点（JP / US 两台出口）换成 VLESS，HK / Shared 保持 trojan。
  const vless = new Set(["JP", "广州1 → JP", "US"]);
  const mixed: ProxySubscriptionDocument = {
    ...document,
    nodes: document.nodes.map((node) => (vless.has(node.name) ? { ...node, protocol: "vless" as const, uuid: "u" } : node)),
  };
  const surge = renderProxySubscription(mixed, "surge", { profile: true });
  assert.ok(!surge.includes("Netflix 解锁"));
  assert.ok(!surge.includes("AI 解锁"));
  assert.ok(surge.includes("HK"));
});
