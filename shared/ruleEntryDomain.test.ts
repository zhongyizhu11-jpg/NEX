import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRuleEntryDomainSuffix,
  normalizeRuleEntryDomainValue,
  publishedRuleEntryDomain,
  ruleEntryDomainName,
  ruleEntryDomainRecordType,
  ruleQualifiesForEntryDomain,
} from "./ruleEntryDomain";
import { buildProxySubscriptionPlan } from "./proxySubscriptionPlan";

test("域名是 r<规则ID>.<后缀>，后缀规整成小写、去掉首尾的点和 *.", () => {
  assert.equal(ruleEntryDomainName(42, "node.example.com"), "r42.node.example.com");
  assert.equal(ruleEntryDomainName(42, "  *.Node.Example.COM. "), "r42.node.example.com");
  assert.equal(ruleEntryDomainName(42, ".node.example.com"), "r42.node.example.com");
  assert.equal(normalizeRuleEntryDomainSuffix("xn--fiqs8s.example.com"), "xn--fiqs8s.example.com");
});

test("后缀无效、规则 ID 无效时不给域名", () => {
  for (const bad of ["", "com", "bad_label.example.com", "a..b.com", "-a.example.com", "中文.example.com", "a b.example.com", `${"a".repeat(64)}.com`]) {
    assert.equal(normalizeRuleEntryDomainSuffix(bad), "", bad);
    assert.equal(ruleEntryDomainName(1, bad), "", bad);
  }
  assert.equal(ruleEntryDomainName(0, "node.example.com"), "");
  assert.equal(ruleEntryDomainName(-3, "node.example.com"), "");
  assert.equal(ruleEntryDomainName("abc", "node.example.com"), "");
  // 整名不能超过 253：给 r<ID>. 留出位置。
  const long = Array.from({ length: 5 }, () => "a".repeat(60)).join(".");
  assert.equal(normalizeRuleEntryDomainSuffix(long), "");
});

test("记录类型按入口地址选：IPv4 → A、IPv6 → AAAA、主机名 → CNAME", () => {
  assert.equal(ruleEntryDomainRecordType("203.0.113.1"), "A");
  assert.equal(ruleEntryDomainRecordType("2001:db8::1"), "AAAA");
  assert.equal(ruleEntryDomainRecordType("[2001:db8::1]"), "AAAA");
  assert.equal(ruleEntryDomainRecordType("hk.ddns.example.com"), "CNAME");
  assert.equal(ruleEntryDomainRecordType(""), null);
  assert.equal(ruleEntryDomainRecordType("not an address"), null);
  assert.equal(normalizeRuleEntryDomainValue("[2001:db8::1]"), "2001:db8::1");
  assert.equal(normalizeRuleEntryDomainValue("HK.DDNS.Example.com."), "hk.ddns.example.com");
  assert.equal(normalizeRuleEntryDomainValue("not an address"), "");
});

test("只有会进订阅的规则才有资格", () => {
  const base = { id: 7, isEnabled: true, pendingDelete: false, isForwardGroupTemplate: false, proxyNodeId: 3, proxyNodeVisible: true };
  assert.equal(ruleQualifiesForEntryDomain(base), true);
  // SQLite 读回来是 0/1。
  assert.equal(ruleQualifiesForEntryDomain({ ...base, isEnabled: 1, pendingDelete: 0, isForwardGroupTemplate: 0, proxyNodeVisible: 1 }), true);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, isEnabled: false }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, isEnabled: 0 }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, pendingDelete: true }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, isForwardGroupTemplate: 1 }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, proxyNodeId: null }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, proxyNodeVisible: false }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, proxyNodeVisible: 0 }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, routeParentRuleId: 9 }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, id: 0 }), false);
  assert.equal(ruleQualifiesForEntryDomain(null), false);
});

test("规则上的「专属域名」开关：关了没资格，没查这一列 / 列为空按开着算", () => {
  const base = { id: 7, isEnabled: true, pendingDelete: false, isForwardGroupTemplate: false, proxyNodeId: 3, proxyNodeVisible: true };
  assert.equal(ruleQualifiesForEntryDomain({ ...base, entryDomainEnabled: false }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, entryDomainEnabled: 0 }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, entryDomainEnabled: "0" }), false);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, entryDomainEnabled: true }), true);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, entryDomainEnabled: 1 }), true);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, entryDomainEnabled: null }), true);
  assert.equal(ruleQualifiesForEntryDomain({ ...base, entryDomainEnabled: undefined }), true);
});

test("发布成功过、而且就是当前后缀算出来的那个，才算可用的域名", () => {
  const rule = { id: 5, entryDomain: "r5.node.example.com", entryDomainValue: "203.0.113.1" };
  assert.equal(publishedRuleEntryDomain(rule, "node.example.com"), "r5.node.example.com");
  // 从没发布成功（值为空）。
  assert.equal(publishedRuleEntryDomain({ ...rule, entryDomainValue: null }, "node.example.com"), "");
  // 功能关了 / DNS 不可用。
  assert.equal(publishedRuleEntryDomain(rule, ""), "");
  // 后缀改了，旧域名还没删完。
  assert.equal(publishedRuleEntryDomain(rule, "edge.example.net"), "");
  // 面板迁移后 ID 重排：列里是别的规则的名字。
  assert.equal(publishedRuleEntryDomain({ ...rule, id: 6 }, "node.example.com"), "");
  // 规则上关了开关：DNS 那边还没删完也立刻不用，订阅马上退回入口地址。
  assert.equal(publishedRuleEntryDomain({ ...rule, entryDomainEnabled: false }, "node.example.com"), "");
  assert.equal(publishedRuleEntryDomain({ ...rule, entryDomainEnabled: 0 }, "node.example.com"), "");
  assert.equal(publishedRuleEntryDomain({ ...rule, entryDomainEnabled: 1 }, "node.example.com"), "r5.node.example.com");
  assert.equal(publishedRuleEntryDomain({ ...rule, entryDomainEnabled: null }, "node.example.com"), "r5.node.example.com");
});

test("订阅节点地址：域名发布过就用域名，否则用入口地址；串两跳的识别照旧", () => {
  const templates = [{ id: 1, name: "Land", protocol: "vless", address: "203.0.113.9", port: 443, uuid: "u", isEnabled: true }];
  const hosts = [
    { id: 1, name: "HK", ip: "203.0.113.1", ipv4: "203.0.113.1" },
    { id: 2, name: "JP", ip: "203.0.113.2", ipv4: "203.0.113.2" },
  ];
  const rules = [
    // 第一跳，目标写的是第二跳的专属域名。
    { id: 10, hostId: 1, name: "a", sourcePort: 1000, proxyNodeId: 1, proxyNodeVisible: true, isEnabled: true, targetIp: "r11.node.example.com", targetPort: 2000, entryDomain: "r10.node.example.com", entryDomainValue: "203.0.113.1" },
    { id: 11, hostId: 2, name: "b", sourcePort: 2000, proxyNodeId: 1, proxyNodeVisible: true, isEnabled: true, targetIp: "203.0.113.9", targetPort: 443, entryDomain: "r11.node.example.com", entryDomainValue: "203.0.113.2" },
    // 没发布成功过。
    { id: 12, hostId: 2, name: "c", sourcePort: 3000, proxyNodeId: 1, proxyNodeVisible: true, isEnabled: true, targetIp: "203.0.113.9", targetPort: 443, entryDomain: "r12.node.example.com", entryDomainValue: null },
    // 规则上关了开关，域名还没来得及删：照样用入口地址。
    { id: 13, hostId: 2, name: "d", sourcePort: 4000, proxyNodeId: 1, proxyNodeVisible: true, isEnabled: true, targetIp: "203.0.113.9", targetPort: 443, entryDomain: "r13.node.example.com", entryDomainValue: "203.0.113.2", entryDomainEnabled: false },
  ];
  const on = buildProxySubscriptionPlan({ rules, templates, hosts, ruleEntryDomainSuffix: "node.example.com" });
  const address = (plan: typeof on, ruleId: number) => plan.entries.find((entry) => entry.ruleId === ruleId)?.node;
  assert.equal(address(on, 10)?.address, "r10.node.example.com");
  assert.equal(address(on, 10)?.port, 1000);
  assert.equal(address(on, 11)?.address, "r11.node.example.com");
  assert.equal(address(on, 12)?.address, "203.0.113.2");
  assert.equal(address(on, 13)?.address, "203.0.113.2");
  assert.equal(on.warnings.filter((warning) => warning.reason === "target-mismatch").length, 0, JSON.stringify(on.warnings));
  // 节点名跟域名无关：还是规则名。
  assert.equal(address(on, 10)?.name, "a");

  const off = buildProxySubscriptionPlan({ rules, templates, hosts, ruleEntryDomainSuffix: "" });
  assert.equal(address(off, 10)?.address, "203.0.113.1");
  assert.equal(address(off, 11)?.address, "203.0.113.2");
});
