import assert from "node:assert/strict";
import test from "node:test";

import { PROXY_SUBSCRIPTION_GROUP_NAME } from "./proxySubscription";
import {
  buildProxySubscriptionPlan,
  dedupeProxyNodeNames,
  defaultProxySubscriptionNodeName,
  proxyNodeFromTemplateRow,
  type ProxyNodeTemplateRow,
  type ProxySubscriptionHostRow,
  type ProxySubscriptionRuleRow,
} from "./proxySubscriptionPlan";

const HKT_TEMPLATE: ProxyNodeTemplateRow = {
  id: 1,
  name: "HKT",
  protocol: "vless",
  address: "hkt.example.com",
  port: 443,
  uuid: "abc-uuid",
  transport: "ws",
  path: "/ray",
  tls: true,
  sni: "hkt.example.com",
  isEnabled: true,
};

const HOSTS: ProxySubscriptionHostRow[] = [
  { id: 1, name: "广州1", ip: "1.2.3.4", ipv4: "1.2.3.4" },
  { id: 2, name: "广州2", ip: "5.6.7.8", ipv4: "5.6.7.8" },
];

function rule(overrides: Partial<ProxySubscriptionRuleRow> & { id: number }): ProxySubscriptionRuleRow {
  return {
    hostId: 1,
    name: "转发",
    sourcePort: 20001,
    proxyNodeId: 1,
    proxyNodeVisible: true,
    isEnabled: true,
    pendingDelete: false,
    ...overrides,
  };
}

test("两台前置指向同一落地节点会生成两个节点", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [
      rule({ id: 1, hostId: 1, sourcePort: 20001 }),
      rule({ id: 2, hostId: 2, sourcePort: 20002 }),
    ],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });

  assert.equal(plan.entries.length, 2);
  assert.equal(plan.skipped.length, 0);

  const [first, second] = plan.entries;
  assert.equal(first.node.name, "广州1 → HKT");
  assert.equal(first.node.address, "1.2.3.4");
  assert.equal(first.node.port, 20001);
  assert.equal(second.node.name, "广州2 → HKT");
  assert.equal(second.node.address, "5.6.7.8");
  assert.equal(second.node.port, 20002);

  // 凭据与握手参数来自模板，两个节点完全一致。
  for (const entry of plan.entries) {
    assert.equal(entry.node.uuid, "abc-uuid");
    assert.equal(entry.node.sni, "hkt.example.com");
    assert.equal(entry.node.path, "/ray");
  }
});

test("单个节点可以在订阅里隐藏，且能说明原因", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [
      rule({ id: 1, hostId: 1 }),
      rule({ id: 2, hostId: 2, sourcePort: 20002, proxyNodeVisible: false, name: "备用转发" }),
    ],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });

  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].ruleId, 1);
  assert.deepEqual(plan.skipped, [{ ruleId: 2, ruleName: "备用转发", reason: "hidden" }]);
});

test("未绑定模板的转发不进订阅", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, proxyNodeId: null, name: "普通转发" })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });

  assert.equal(plan.entries.length, 0);
  assert.equal(plan.skipped[0].reason, "unbound");
});

test("停用的转发和停用的模板都会被排除", () => {
  const disabledRule = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, isEnabled: false })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });
  assert.equal(disabledRule.entries.length, 0);
  assert.equal(disabledRule.skipped[0].reason, "rule-disabled");

  const disabledTemplate = buildProxySubscriptionPlan({
    rules: [rule({ id: 1 })],
    templates: [{ ...HKT_TEMPLATE, isEnabled: false }],
    hosts: HOSTS,
  });
  assert.equal(disabledTemplate.entries.length, 0);
  assert.equal(disabledTemplate.skipped[0].reason, "template-disabled");
});

test("端到端一直不通的转发暂时不进订阅，写明原因", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, sourcePort: 20001 }), rule({ id: 2, sourcePort: 20002 })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
    unreachableRuleIds: new Set([2]),
  });
  assert.deepEqual(plan.entries.map((entry) => entry.ruleId), [1]);
  assert.deepEqual(plan.skipped.map((item) => [item.ruleId, item.reason]), [[2, "unreachable"]]);
  // 没传（开关关着）就照旧全部发出去
  const off = buildProxySubscriptionPlan({ rules: [rule({ id: 2 })], templates: [HKT_TEMPLATE], hosts: HOSTS });
  assert.equal(off.entries.length, 1);
});

test("链 / 线路组拆出来的内部规则：主规则已绑节点时不再单独出节点", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [
      // 用户建的链主规则，入口在 1 号机
      rule({ id: 10, hostId: 1, sourcePort: 52582, isForwardGroupTemplate: true }),
      // 链的两段（第二段在 2 号机，目标正好是落地节点，以前会被绑上）
      rule({ id: 11, hostId: 1, sourcePort: 52582, forwardGroupRuleId: 10, isForwardGroupTemplate: false }),
      rule({ id: 12, hostId: 2, sourcePort: 30001, forwardGroupRuleId: 10, isForwardGroupTemplate: false, proxyNodeVisible: false }),
      // 线路组的中转
      rule({ id: 13, hostId: 2, sourcePort: 30002, routeParentRuleId: 10 }),
    ],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });
  assert.deepEqual(plan.entries.map((entry) => entry.ruleId), [10], "同一个入口只出一个节点");
  assert.equal(plan.skipped.length, 0, "内部规则不出现在「被你关掉的」「没绑节点」里");

  // 主规则没绑节点时，内部规则照旧（不改变原来的行为）
  const unboundParent = buildProxySubscriptionPlan({
    rules: [
      rule({ id: 10, proxyNodeId: 0, isForwardGroupTemplate: true }),
      rule({ id: 11, hostId: 2, sourcePort: 30001, forwardGroupRuleId: 10, isForwardGroupTemplate: false }),
    ],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });
  assert.deepEqual(unboundParent.entries.map((entry) => entry.ruleId), [11]);
});

test("因为不通被暂时隐藏的节点，不报「没有转发指向它」", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1 })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
    unreachableRuleIds: new Set([1]),
  });
  assert.equal(plan.entries.length, 0);
  assert.deepEqual(plan.skipped.map((item) => item.reason), ["unreachable"]);
  assert.equal(plan.warnings.filter((item) => item.reason === "node-unused").length, 0);
});

test("待删除的转发既不出节点也不报原因", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, pendingDelete: true })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });

  assert.equal(plan.entries.length, 0);
  // 已经在删除流程里的规则不是用户需要处理的问题，不该出现在提示列表。
  assert.equal(plan.skipped.length, 0);
});

test("入口主机没有可用地址时报明确原因而不是生成坏节点", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, hostId: 9 })],
    templates: [HKT_TEMPLATE],
    hosts: [{ id: 9, name: "空主机" }],
  });

  assert.equal(plan.entries.length, 0);
  assert.equal(plan.skipped[0].reason, "no-entry-address");
});

test("主机配了入口域名时订阅用域名而不是 IP", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, hostId: 3 })],
    templates: [HKT_TEMPLATE],
    hosts: [{ id: 3, name: "广州1", ip: "1.2.3.4", ipv4: "1.2.3.4", entryIp: "gz1.example.com" }],
  });

  assert.equal(plan.entries[0].node.address, "gz1.example.com");
});

test("自定义节点名覆盖自动生成的名称", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, proxyNodeName: "主力线路" })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });

  assert.equal(plan.entries[0].node.name, "主力线路");
});

test("同名节点自动加序号", () => {
  // Clash 的 proxy-groups 按名称引用节点，重名会让客户端随机少几个节点。
  const nodes = dedupeProxyNodeNames([
    { ...proxyNodeFromTemplateRow(HKT_TEMPLATE), name: "香港" },
    { ...proxyNodeFromTemplateRow(HKT_TEMPLATE), name: "香港" },
    { ...proxyNodeFromTemplateRow(HKT_TEMPLATE), name: "香港" },
    { ...proxyNodeFromTemplateRow(HKT_TEMPLATE), name: "日本" },
  ]);

  assert.deepEqual(nodes.map((node) => node.name), ["香港", "香港 #2", "香港 #3", "日本"]);
});

test("模板行的宽松字段被收敛成合法模型", () => {
  const node = proxyNodeFromTemplateRow({
    id: 1,
    name: "SS",
    protocol: "SHADOWSOCKS",
    address: "hk.example.com",
    port: "8388",
    method: "aes-128-gcm",
    password: "pass",
    transport: "不认识的值",
    tls: 0,
    alpn: "h2, http/1.1",
    udp: 1,
  });

  assert.equal(node.protocol, "shadowsocks");
  assert.equal(node.port, 8388);
  assert.equal(node.transport, "tcp");
  assert.equal(node.tls, false);
  assert.deepEqual(node.alpn, ["h2", "http/1.1"]);
  assert.equal(node.udp, true);
});

test("节点名在主机名或模板名缺失时仍有可用回退", () => {
  assert.equal(
    defaultProxySubscriptionNodeName({ hostName: "广州1", templateName: "HKT", ruleName: "转发" }),
    "广州1 → HKT",
  );
  assert.equal(defaultProxySubscriptionNodeName({ hostName: "", templateName: "HKT", ruleName: "转发" }), "HKT");
  assert.equal(defaultProxySubscriptionNodeName({ hostName: "广州1", templateName: "", ruleName: "转发" }), "广州1");
  assert.equal(defaultProxySubscriptionNodeName({ hostName: "", templateName: "", ruleName: "转发" }), "转发");
  assert.equal(defaultProxySubscriptionNodeName({ hostName: "", templateName: "", ruleName: "" }), "节点");
});

// ==================== 中转自动选路分组 ====================

import {
  autoGroupNameForTemplate,
  buildProxySubscriptionDocument,
  normalizeProxyNodeAutoGroup,
} from "./proxySubscriptionPlan";

function planFor(rules: ProxySubscriptionRuleRow[], templates: ProxyNodeTemplateRow[]) {
  return buildProxySubscriptionPlan({ rules, templates, hosts: HOSTS });
}

test("同一落地节点被两台中转指向时生成自动选路组", () => {
  const templates = [HKT_TEMPLATE];
  const plan = planFor(
    [rule({ id: 1, hostId: 1, sourcePort: 20001 }), rule({ id: 2, hostId: 2, sourcePort: 20002 })],
    templates,
  );

  const doc = buildProxySubscriptionDocument(plan, templates, { mainGroupName: "ForwardX" });

  assert.equal(doc.groups.length, 2);
  const [main, auto] = doc.groups;

  assert.equal(main.name, "ForwardX");
  assert.equal(main.type, "select");
  // 自动选路组排在裸节点前面，用户第一眼就是「自动」。
  assert.deepEqual(main.members, ["HKT 自动选路", "广州1 → HKT", "广州2 → HKT"]);

  assert.equal(auto.name, "HKT 自动选路");
  assert.equal(auto.type, "url-test");
  assert.deepEqual(auto.members, ["广州1 → HKT", "广州2 → HKT"]);
});

test("只有一台中转时不生成自动选路组", () => {
  const templates = [HKT_TEMPLATE];
  const plan = planFor([rule({ id: 1, hostId: 1 })], templates);

  const doc = buildProxySubscriptionDocument(plan, templates, { mainGroupName: "ForwardX" });

  // 一条线路无从选路，多一个组只会让客户端界面变乱。
  assert.equal(doc.groups.length, 1);
  assert.equal(doc.groups[0].type, "select");
  assert.deepEqual(doc.groups[0].members, ["广州1 → HKT"]);
});

test("模板可以关闭自动选路，或改成主备切换", () => {
  const off = [{ ...HKT_TEMPLATE, autoGroup: "off" }];
  const offDoc = buildProxySubscriptionDocument(
    planFor([rule({ id: 1, hostId: 1 }), rule({ id: 2, hostId: 2, sourcePort: 20002 })], off),
    off,
    { mainGroupName: "ForwardX" },
  );
  assert.equal(offDoc.groups.length, 1);
  assert.deepEqual(offDoc.groups[0].members, ["广州1 → HKT", "广州2 → HKT"]);

  const fallback = [{ ...HKT_TEMPLATE, autoGroup: "fallback" }];
  const fallbackDoc = buildProxySubscriptionDocument(
    planFor([rule({ id: 1, hostId: 1 }), rule({ id: 2, hostId: 2, sourcePort: 20002 })], fallback),
    fallback,
    { mainGroupName: "ForwardX" },
  );
  assert.equal(fallbackDoc.groups[1].type, "fallback");
});

test("多个落地节点各自成组，互不混淆", () => {
  const second: ProxyNodeTemplateRow = { ...HKT_TEMPLATE, id: 2, name: "日本" };
  const templates = [HKT_TEMPLATE, second];
  const plan = planFor(
    [
      rule({ id: 1, hostId: 1, sourcePort: 20001, proxyNodeId: 1 }),
      rule({ id: 2, hostId: 2, sourcePort: 20002, proxyNodeId: 1 }),
      rule({ id: 3, hostId: 1, sourcePort: 20003, proxyNodeId: 2 }),
      rule({ id: 4, hostId: 2, sourcePort: 20004, proxyNodeId: 2 }),
    ],
    templates,
  );

  const doc = buildProxySubscriptionDocument(plan, templates, { mainGroupName: "ForwardX" });
  const autoGroups = doc.groups.filter((group) => group.type !== "select");

  assert.equal(autoGroups.length, 2);
  assert.deepEqual(autoGroups[0].members, ["广州1 → HKT", "广州2 → HKT"]);
  assert.deepEqual(autoGroups[1].members, ["广州1 → 日本", "广州2 → 日本"]);
});

test("分组引用的是去重后的节点名", () => {
  // 组按名称引用成员，若用去重前的名字，客户端会找不到节点。
  const templates = [HKT_TEMPLATE];
  const plan = planFor(
    [
      rule({ id: 1, hostId: 1, sourcePort: 20001, proxyNodeName: "香港" }),
      rule({ id: 2, hostId: 2, sourcePort: 20002, proxyNodeName: "香港" }),
    ],
    templates,
  );

  const doc = buildProxySubscriptionDocument(plan, templates, { mainGroupName: "ForwardX" });

  assert.deepEqual(doc.nodes.map((node) => node.name), ["香港", "香港 #2"]);
  assert.deepEqual(doc.groups[1].members, ["香港", "香港 #2"]);
});

test("没有节点时不产出任何策略组", () => {
  const doc = buildProxySubscriptionDocument({ entries: [], skipped: [], warnings: [] }, [HKT_TEMPLATE], {
    mainGroupName: "ForwardX",
  });

  assert.deepEqual(doc.nodes, []);
  assert.deepEqual(doc.groups, []);
});

test("自动选路模式的取值收敛", () => {
  assert.equal(normalizeProxyNodeAutoGroup("off"), "off");
  assert.equal(normalizeProxyNodeAutoGroup("fallback"), "fallback");
  assert.equal(normalizeProxyNodeAutoGroup("load-balance"), "load-balance");
  assert.equal(normalizeProxyNodeAutoGroup("URL-TEST"), "url-test");
  // 未设置时默认开启自动选路，这是多中转场景下最有用的行为。
  assert.equal(normalizeProxyNodeAutoGroup(undefined), "url-test");
  assert.equal(normalizeProxyNodeAutoGroup("乱填"), "url-test");
});

test("组名带后缀，避免和落地节点本身重名", () => {
  assert.equal(autoGroupNameForTemplate("HKT"), "HKT 自动选路");
  assert.equal(autoGroupNameForTemplate(""), "节点 自动选路");
  assert.equal(autoGroupNameForTemplate("HKT", "load-balance"), "HKT 带宽叠加");
});

test("带宽叠加：同一落地的多条中转进一个 load-balance 组", () => {
  const template = { ...DIRECT_TEMPLATE, includeDirect: false, autoGroup: "load-balance" };
  const plan = buildProxySubscriptionPlan({
    rules: [
      { id: 1, hostId: 1, name: "前置A", sourcePort: 10001, proxyNodeId: 7, isEnabled: true },
      { id: 2, hostId: 2, name: "前置B", sourcePort: 10002, proxyNodeId: 7, isEnabled: true },
    ],
    templates: [template],
    hosts: [
      { id: 1, name: "前置A", ipv4: "1.2.3.4" },
      { id: 2, name: "前置B", ipv4: "5.6.7.8" },
    ],
  });

  const document = buildProxySubscriptionDocument(plan, [template], {
    mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME,
  });

  const group = document.groups.find((item) => item.type === "load-balance");
  assert.ok(group, "应该生成带宽叠加组");
  assert.equal(group.name, "CST/hk 带宽叠加");
  assert.equal(group.members.length, 2);
  // 主选择器第一项就是叠加组，导入后默认就在叠加。
  assert.equal(document.groups[0].members[0], group.name);
});

// ==================== 落地直连 ====================

const DIRECT_TEMPLATE = {
  id: 7,
  name: "CST/hk",
  protocol: "vless",
  address: "154.36.174.85",
  port: 63284,
  uuid: "u-1",
  tls: true,
  isEnabled: true,
  autoGroup: "url-test",
};

test("不开开关时，订阅里没有落地直连", () => {
  // 默认必须是关的：开了之后落地 IP 会进到每一条订阅地址里。
  const plan = buildProxySubscriptionPlan({
    rules: [],
    templates: [{ ...DIRECT_TEMPLATE, includeDirect: false }],
    hosts: [],
  });

  assert.equal(plan.entries.length, 0);
});

test("开了开关，落地机自己的地址原样进订阅", () => {
  // 模板本来就是一个完整节点，直连就是不做地址改写的那一条。
  const plan = buildProxySubscriptionPlan({
    rules: [],
    templates: [{ ...DIRECT_TEMPLATE, includeDirect: true }],
    hosts: [],
  });

  assert.equal(plan.entries.length, 1);
  const [entry] = plan.entries;
  assert.equal(entry.kind, "direct");
  assert.equal(entry.ruleId, 0);
  assert.equal(entry.templateId, 7);
  assert.equal(entry.node.address, "154.36.174.85");
  assert.equal(entry.node.port, 63284);
  assert.equal(entry.node.uuid, "u-1", "凭据来自模板本身，没有第二份");
});

test("模板停用时，直连也不出现", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [],
    templates: [{ ...DIRECT_TEMPLATE, includeDirect: true, isEnabled: false }],
    hosts: [],
  });

  assert.equal(plan.entries.length, 0);
});

test("直连排在该落地的各条中转前面", () => {
  // 它是这个落地的本体，其余都是它的中转变体。
  const plan = buildProxySubscriptionPlan({
    rules: [
      { id: 1, hostId: 1, name: "广州1", sourcePort: 10001, proxyNodeId: 7, isEnabled: true },
    ],
    templates: [{ ...DIRECT_TEMPLATE, includeDirect: true }],
    hosts: [{ id: 1, name: "广州1", ipv4: "1.2.3.4" }],
  });

  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries[0].kind, "direct");
  assert.equal(plan.entries[1].kind, "relay");
});

test("直连与中转进同一个选路组，客户端能自己挑快的", () => {
  // 这是这个功能的意义所在：直连和走中转并列，由客户端测速决定。
  // templateId 一致是它能进同一组的原因。
  const template = { ...DIRECT_TEMPLATE, includeDirect: true };
  const plan = buildProxySubscriptionPlan({
    rules: [
      { id: 1, hostId: 1, name: "广州1", sourcePort: 10001, proxyNodeId: 7, isEnabled: true },
      { id: 2, hostId: 2, name: "广州2", sourcePort: 10002, proxyNodeId: 7, isEnabled: true },
    ],
    templates: [template],
    hosts: [
      { id: 1, name: "广州1", ipv4: "1.2.3.4" },
      { id: 2, name: "广州2", ipv4: "5.6.7.8" },
    ],
  });

  const document = buildProxySubscriptionDocument(plan, [template], {
    mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME,
  });

  const auto = document.groups.find((group) => group.type === "url-test");
  assert.ok(auto, "应该生成自动选路组");
  assert.equal(auto.members.length, 3, "直连 + 两条中转都在组里");
  assert.equal(auto.members[0], plan.entries[0].node.name, "直连也是组员");
});

test("带宽叠加组不带落地直连，只叠中转", () => {
  // 用户实测：开了直连的落地，叠加组里多出一个「HKT」，三条连接里有一条绕开前置。
  const template = { ...DIRECT_TEMPLATE, includeDirect: true, autoGroup: "load-balance" };
  const plan = buildProxySubscriptionPlan({
    rules: [
      { id: 1, hostId: 1, name: "前置A", sourcePort: 10001, proxyNodeId: 7, isEnabled: true },
      { id: 2, hostId: 2, name: "前置B", sourcePort: 10002, proxyNodeId: 7, isEnabled: true },
    ],
    templates: [template],
    hosts: [
      { id: 1, name: "前置A", ipv4: "1.2.3.4" },
      { id: 2, name: "前置B", ipv4: "5.6.7.8" },
    ],
  });
  const document = buildProxySubscriptionDocument(plan, [template], { mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME });

  const group = document.groups.find((item) => item.type === "load-balance");
  assert.ok(group);
  assert.equal(group.members.length, 2);
  assert.ok(!group.members.includes(plan.entries[0].node.name), "直连不在叠加组里");
  // 直连仍在主选择器里，想单独用还能选。
  assert.ok(document.groups[0].members.includes(plan.entries[0].node.name));
});

test("只有一条中转时不生成叠加组（直连不算）", () => {
  const template = { ...DIRECT_TEMPLATE, includeDirect: true, autoGroup: "load-balance" };
  const plan = buildProxySubscriptionPlan({
    rules: [{ id: 1, hostId: 1, name: "前置A", sourcePort: 10001, proxyNodeId: 7, isEnabled: true }],
    templates: [template],
    hosts: [{ id: 1, name: "前置A", ipv4: "1.2.3.4" }],
  });
  const document = buildProxySubscriptionDocument(plan, [template], { mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME });
  assert.equal(document.groups.some((item) => item.type === "load-balance"), false);
});

// ==================== 前置代理 ====================

const LINE_MACHINE = {
  id: 20,
  name: "HK线路机",
  protocol: "trojan",
  address: "203.0.113.7",
  port: 443,
  password: "pw",
  tls: true,
  isEnabled: true,
};

const LANDING_VIA_LINE = {
  id: 21,
  name: "HKT落地",
  protocol: "vless",
  address: "154.36.174.85",
  port: 63284,
  uuid: "u",
  tls: true,
  isEnabled: true,
  includeDirect: true,
  frontProxyId: 20,
};

test("被引用为前置的节点，即使没开直连开关也必须进订阅", () => {
  // 否则 dialer-proxy 会指向一个不存在的节点，Clash 直接拒绝整份配置，
  // 用户看到的是「订阅导入失败」，跟前置代理毫无字面关联。
  const plan = buildProxySubscriptionPlan({
    rules: [],
    // 线路机没开 includeDirect —— 它只是被当作前置引用。
    templates: [{ ...LINE_MACHINE, includeDirect: false }, LANDING_VIA_LINE],
    hosts: [],
  });

  const names = plan.entries.map((entry) => entry.node.name);
  assert.ok(names.includes("HK线路机"), `线路机必须在订阅里，实际：${names.join("、")}`);
  assert.ok(names.includes("HKT落地"));
});

test("前置节点被停用时不挂引用，宁可少一层也不要坏配置", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [],
    templates: [{ ...LINE_MACHINE, isEnabled: false }, LANDING_VIA_LINE],
    hosts: [],
  });

  const landing = plan.entries.find((entry) => entry.node.name === "HKT落地");
  assert.ok(landing);
  assert.equal(landing.frontTemplateId, 0, "引用不到就不该挂");
});

test("前置引用指向去重之后的名字", () => {
  // 名字去重发生在渲染前。提前写死名字的话，一旦去重给前置加了序号，
  // 引用就指向一个不存在的节点 —— 这条锁住的就是这个顺序。
  const collide = { ...LINE_MACHINE, id: 22, name: "同名", includeDirect: true };
  const other = { ...LINE_MACHINE, id: 23, name: "同名", includeDirect: true };
  const landing = { ...LANDING_VIA_LINE, frontProxyId: 23 };

  const plan = buildProxySubscriptionPlan({ rules: [], templates: [collide, other, landing], hosts: [] });
  const document = buildProxySubscriptionDocument(plan, [collide, other, landing], {
    mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME,
  });

  const names = document.nodes.map((node) => node.name);
  assert.equal(new Set(names).size, names.length, "名字必须互不重复");

  const chained = document.nodes.find((node) => node.frontProxyName);
  assert.ok(chained, "落地节点应该挂着前置引用");
  assert.ok(
    names.includes(chained.frontProxyName!),
    `引用的名字必须真实存在：${chained.frontProxyName} 不在 ${names.join("、")} 里`,
  );
});

test("转发派生的节点也能带前置", () => {
  // 客户端 → 广州入口 → …，而这条连接本身再经由线路机建立。
  const plan = buildProxySubscriptionPlan({
    rules: [{ id: 1, hostId: 1, name: "广州", sourcePort: 10001, proxyNodeId: 21, isEnabled: true }],
    templates: [LINE_MACHINE, { ...LANDING_VIA_LINE, includeDirect: false }],
    hosts: [{ id: 1, name: "广州", ipv4: "1.2.3.4" }],
  });

  const relay = plan.entries.find((entry) => entry.kind === "relay");
  assert.ok(relay);
  assert.equal(relay.frontTemplateId, 20);
});

test("没有前置时不产生任何链式字段", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [],
    templates: [{ ...LINE_MACHINE, includeDirect: true }],
    hosts: [],
  });
  const document = buildProxySubscriptionDocument(plan, [LINE_MACHINE], {
    mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME,
  });

  assert.equal(document.nodes[0].frontProxyName, undefined);
});

test("规则上的自定义名优先，留空则回落到自动生成的名字", () => {
  // 订阅内容里改名就是写这一列；清空要能恢复默认，否则用户改坏了没法退回。
  const template = { ...DIRECT_TEMPLATE, id: 30, includeDirect: false };
  const base = { id: 1, hostId: 1, sourcePort: 10001, proxyNodeId: 30, isEnabled: true, name: "香港转发" };
  const hosts = [{ id: 1, name: "广州1", ipv4: "1.2.3.4" }];

  const custom = buildProxySubscriptionPlan({
    rules: [{ ...base, proxyNodeName: "我改的名字" }],
    templates: [template],
    hosts,
  });
  assert.equal(custom.entries[0].node.name, "我改的名字");

  const cleared = buildProxySubscriptionPlan({
    rules: [{ ...base, proxyNodeName: "" }],
    templates: [template],
    hosts,
  });
  assert.notEqual(cleared.entries[0].node.name, "");
  assert.equal(
    cleared.entries[0].node.name,
    defaultProxySubscriptionNodeName({ hostName: "广州1", templateName: "CST/hk", ruleName: "香港转发" }),
  );
});

// ==================== QUIC 系节点与转发协议 ====================

const HY2_TEMPLATE: ProxyNodeTemplateRow = {
  id: 2,
  name: "HY2",
  protocol: "hysteria2",
  address: "hk.example.com",
  port: 8443,
  password: "pw",
  obfs: "salamander",
  obfsPassword: "ob",
  sni: "hk.example.com",
  isEnabled: true,
};

test("Hysteria2 绑到只放行 TCP 的转发会被排除并说明原因", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, proxyNodeId: 2, protocol: "tcp" })],
    templates: [HY2_TEMPLATE],
    hosts: HOSTS,
  });

  // QUIC 全程只走 UDP，这条链路从第一个包起就不通；发出去只会得到一句超时。
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "udp-not-forwarded");
});

test("转发放行了 UDP 或 TCP+UDP 时 QUIC 节点照常进订阅", () => {
  for (const protocol of ["udp", "both"]) {
    const plan = buildProxySubscriptionPlan({
      rules: [rule({ id: 1, proxyNodeId: 2, protocol })],
      templates: [HY2_TEMPLATE],
      hosts: HOSTS,
    });
    assert.equal(plan.entries.length, 1, `protocol=${protocol}`);
    assert.equal(plan.entries[0].node.protocol, "hysteria2");
  }
});

test("调用方没查 protocol 列时不凭猜测吞掉节点", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, proxyNodeId: 2 })],
    templates: [HY2_TEMPLATE],
    hosts: HOSTS,
  });
  assert.equal(plan.entries.length, 1);
});

test("TCP 系协议不受转发协议限制", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, proxyNodeId: 1, protocol: "tcp" })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });
  assert.equal(plan.entries.length, 1);
});

test("数据库行还原出新协议的字段，TLS 不看那一列", () => {
  const node = proxyNodeFromTemplateRow({
    id: 3,
    name: "TUIC",
    protocol: "tuic",
    address: "hk.example.com",
    port: 443,
    uuid: "uuid-1",
    password: "pw",
    congestionControl: "bbr",
    udpRelayMode: "native",
    disableSni: true,
    // 老行里这一列可能是 0：TUIC 的 TLS 是协议自带的，不该据此当成明文节点。
    tls: false,
  });

  assert.equal(node.protocol, "tuic");
  assert.equal(node.congestionControl, "bbr");
  assert.equal(node.udpRelayMode, "native");
  assert.equal(node.disableSni, true);
  assert.equal(node.tls, true);
});

test("数据库行还原出 Snell 与 XHTTP 的字段", () => {
  const snell = proxyNodeFromTemplateRow({
    id: 4, name: "S4", protocol: "snell", address: "hk.example.com", port: 8000,
    password: "psk", snellVersion: 4, obfs: "http", host: "bing.com",
  });
  assert.equal(snell.protocol, "snell");
  assert.equal(snell.snellVersion, 4);
  assert.equal(snell.obfs, "http");
  // Snell 走裸 TCP，不在「协议自带 TLS」那一档里。
  assert.equal(snell.tls, false);

  const xhttp = proxyNodeFromTemplateRow({
    id: 5, name: "XH", protocol: "vless", address: "hk.example.com", port: 443,
    uuid: "u", transport: "xhttp", xhttpMode: "stream-one", tls: true,
  });
  assert.equal(xhttp.transport, "xhttp");
  assert.equal(xhttp.xhttpMode, "stream-one");
});
