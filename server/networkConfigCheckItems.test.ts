import assert from "node:assert/strict";
import test from "node:test";

import {
  annotateRuleCheckItems,
  evaluateHostCheckItems,
  evaluatePortItems,
  evaluateResourceItem,
  evaluateRuleRuntimeItems,
  evaluateUpgradeItem,
  MAX_RULE_ITEMS,
  overlappingRulePairs,
  type ConfigCheckRuleFacts,
} from "./networkConfigCheckItems";
import type { DiagnosticItem } from "../shared/linkDiagnostics";
import type { RulePortWarning } from "./rulePortOccupancy";

const LATEST = "2.2.256";
const FXP_OK = "2.2.140";

const onlineHost = {
  id: 7,
  name: "hk-01",
  isOnline: 1,
  lastHeartbeat: new Date(),
  hasAgent: true,
  agentVersion: LATEST,
  fxpVersion: FXP_OK,
};

function byKey(items: DiagnosticItem[], key: string) {
  const found = items.find((entry) => entry.key === key);
  assert.ok(found, `没有 ${key}：${items.map((entry) => entry.key).join(", ")}`);
  return found;
}

function rule(overrides: Partial<ConfigCheckRuleFacts> = {}): ConfigCheckRuleFacts {
  return {
    id: 1,
    name: "web",
    sourcePort: 30001,
    protocol: "tcp",
    isEnabled: true,
    isRunning: true,
    warnings: [],
    ...overrides,
  };
}

test("没绑 Agent：只出一项失败，告诉人去执行安装命令", () => {
  const items = evaluateHostCheckItems({ ...onlineHost, hasAgent: false }, { latestAgentVersion: LATEST, showHostState: true });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "fail");
  assert.match(items[0].hint || "", /安装命令/);
});

test("主机离线：复用一键诊断的主机项（带最后心跳）", () => {
  const items = evaluateHostCheckItems({ ...onlineHost, isOnline: 0 }, { latestAgentVersion: LATEST, showHostState: true });
  const host = byKey(items, "host:7");
  assert.equal(host.status, "fail");
  assert.match(host.summary, /离线/);
});

test("Agent 过旧：警告，说明是 Agent 不是 FXP，建议在主机页升级", () => {
  const items = evaluateHostCheckItems({ ...onlineHost, agentVersion: "2.2.200" }, { latestAgentVersion: LATEST, showHostState: false });
  const upgrade = byKey(items, "host.upgrade:7");
  assert.equal(upgrade.status, "warn");
  assert.match(upgrade.summary, /Agent 版本过旧：Agent 2\.2\.200 → 2\.2\.256/);
  assert.match(upgrade.hint || "", /升级 Agent/);
});

test("Agent 最新但没装 FXP：警告并说明用不到隧道可以不管；agentOnly 时不出", () => {
  // Agent 报的是 "missing"（没报版本是另一回事：未上报，wireCompatible 说不准，算通过）。
  const host = { id: 3, name: "jp", agentVersion: LATEST, fxpVersion: "missing" as string | null };
  const fxp = evaluateUpgradeItem(host, LATEST)!;
  assert.equal(fxp.status, "warn");
  assert.match(fxp.title, /FXP/);
  assert.match(fxp.hint || "", /用不到 NEX 隧道可以不管/);
  assert.equal(evaluateUpgradeItem(host, LATEST, { agentOnly: true }), null);
  assert.equal(evaluateUpgradeItem({ ...host, agentVersion: null }, LATEST), null, "没报版本不出这一项");
  assert.equal(evaluateUpgradeItem({ ...host, fxpVersion: FXP_OK }, LATEST)?.status, "pass");
  assert.equal(evaluateUpgradeItem({ ...host, fxpVersion: null }, LATEST)?.status, "pass");
});

test("IPv6 监听不可用、维护、流量暂停；维护和流量只给能看主机状态的人", () => {
  const facts = { ...onlineHost, ipv6ListenAvailable: false, maintenanceMode: true };
  const shown = evaluateHostCheckItems(facts, { latestAgentVersion: LATEST, showHostState: true });
  assert.equal(byKey(shown, "host.ipv6Listen").status, "warn");
  assert.equal(byKey(shown, "config.maintenance").group, "config");
  const hidden = evaluateHostCheckItems(facts, { latestAgentVersion: LATEST, showHostState: false });
  assert.ok(!hidden.some((entry) => entry.key === "config.maintenance"));
  const traffic = evaluateHostCheckItems({ ...onlineHost, trafficExcluded: true }, { latestAgentVersion: LATEST, showHostState: true });
  assert.equal(byKey(traffic, "config.trafficFailover").status, "warn");
});

test("资源：旧采样不下结论；任一项 ≥ 90% 警告，磁盘满给磁盘的建议", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  const host = { id: 7, name: "hk-01", isOnline: 1 };
  assert.equal(evaluateResourceItem(host, null, now).status, "skip");
  assert.equal(evaluateResourceItem(host, { cpuUsage: 10, recordedAt: new Date(now - 10 * 60_000) }, now).status, "skip");
  const ok = evaluateResourceItem(host, { cpuUsage: 12.4, memoryUsage: 40, diskUsage: 50, recordedAt: new Date(now - 30_000) }, now);
  assert.equal(ok.status, "pass");
  assert.equal(ok.summary, "CPU 12% · 内存 40% · 磁盘 50%");
  const disk = evaluateResourceItem(host, { cpuUsage: 12, memoryUsage: 40, diskUsage: 95, recordedAt: new Date(now - 30_000) }, now);
  assert.equal(disk.status, "warn");
  assert.match(disk.hint || "", /磁盘/);
});

test("规则运行：都在跑是一项通过；没跑的逐条列出并接上 Agent 报的原因", () => {
  const host = { id: 7, name: "hk-01", isOnline: 1 };
  const pass = evaluateRuleRuntimeItems(host, [rule(), rule({ id: 2, sourcePort: 30002 })]);
  assert.deepEqual(pass.map((entry) => entry.status), ["pass"]);
  assert.match(pass[0].summary, /2 条启用的规则都在运行/);

  const bind: RulePortWarning = { level: "error", kind: "bind", label: "端口绑定失败", message: "端口绑定失败：30001/TCP 被 nginx（pid 812）占用", hostId: 7, port: 30001 };
  const missing: RulePortWarning = { level: "error", kind: "runtime", label: "运行时没装", message: "运行时没装（重新执行安装命令或升级 Agent）", hostId: 7, port: 30002 };
  const items = evaluateRuleRuntimeItems(host, [
    rule({ isRunning: false, warnings: [bind] }),
    rule({ id: 2, name: "game", sourcePort: 30002, isRunning: false, warnings: [missing] }),
    rule({ id: 3, name: "off", sourcePort: 30003, isEnabled: false, isRunning: false }),
  ]);
  assert.equal(items.length, 2, "停用的规则不算");
  assert.equal(items[0].status, "fail");
  assert.equal(items[0].summary, bind.message);
  assert.match(items[0].hint || "", /ss -ltnup/);
  assert.match(items[1].hint || "", /升级 Agent/);
  assert.match(items[1].title, /规则「game」（端口 30002）/);
});

test("规则运行：主机离线时不下结论；没启用的规则是跳过；超过上限合成一句", () => {
  assert.equal(evaluateRuleRuntimeItems({ id: 7, name: "hk", isOnline: 0 }, [rule({ isRunning: false })])[0].status, "skip");
  assert.equal(evaluateRuleRuntimeItems({ id: 7, name: "hk", isOnline: 1 }, [])[0].status, "skip");
  const many = Array.from({ length: MAX_RULE_ITEMS + 3 }, (_, index) => rule({ id: index + 1, sourcePort: 31000 + index, isRunning: false }));
  const items = evaluateRuleRuntimeItems({ id: 7, name: "hk", isOnline: 1 }, many);
  assert.equal(items.length, MAX_RULE_ITEMS + 1);
  assert.match(items[items.length - 1].summary, /另外还有 3 条/);
});

test("端口重叠：端口段和协议都重叠才算；tcp 和 udp 同端口不算", () => {
  const pairs = overlappingRulePairs([
    rule({ id: 1, name: "a", sourcePort: 30000, sourcePortEnd: 30010 }),
    rule({ id: 2, name: "b", sourcePort: 30005, protocol: "both" }),
    rule({ id: 3, name: "c", sourcePort: 30005, protocol: "udp" }),
    rule({ id: 4, name: "d", sourcePort: 40000, protocol: "udp" }),
    rule({ id: 5, name: "e", sourcePort: 40000, protocol: "tcp" }),
    rule({ id: 6, name: "f", sourcePort: 30005, isEnabled: false }),
  ]);
  assert.deepEqual(pairs.map((pair) => [pair.a.id, pair.b.id, pair.port]), [[1, 2, 30005], [2, 3, 30005]]);
});

test("端口：重叠、面板占用、外来程序占用各出一项；都没有时一项通过并注明老 Agent 查不了外来占用", () => {
  const host = { id: 7, name: "hk-01", agentVersion: LATEST };
  const occupied: RulePortWarning = { level: "warn", kind: "occupied", label: "端口被占用", message: "入口端口 30003/TCP 有其他程序在监听", hostId: 7, port: 30003 };
  const items = evaluatePortItems(host, [
    rule({ id: 1, name: "a", sourcePort: 30001 }),
    rule({ id: 2, name: "b", sourcePort: 30001 }),
    rule({ id: 3, name: "c", sourcePort: 30003, warnings: [occupied] }),
    rule({ id: 4, name: "d", sourcePort: 30004, isRunning: false, portConflict: { used: true, reason: null } }),
  ]);
  assert.deepEqual(items.map((entry) => [entry.key, entry.status]), [
    ["ports.overlap:1:2", "fail"],
    ["ports.occupied:3:30003", "warn"],
    ["ports.used:4", "fail"],
  ]);
  const clean = evaluatePortItems({ ...host, agentVersion: "2.2.200" }, [rule()]);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].status, "pass");
  assert.match(clean[0].summary, /查不了外来程序占用/);
  assert.deepEqual(evaluatePortItems(host, []), [], "没有启用的规则就不出端口项");
});

test("规则体检：没运行的那项接上原因；外来程序占端口补一项警告；其余项原样", () => {
  const items: DiagnosticItem[] = [
    { key: "config.enabled", group: "config", title: "规则已启用", status: "pass", summary: "已启用", source: "panel" },
    { key: "runtime.rule:9", group: "entry", title: "规则在「hk」上运行", status: "fail", summary: "Agent 报告没在运行", hint: "旧建议", hostId: 7, hostName: "hk", source: "panel" },
  ];
  const warnings: RulePortWarning[] = [
    { level: "error", kind: "runtime", label: "监听没起来", message: "监听没起来：IPv6 在这台机器上不可用", hostId: 7, port: 443 },
    { level: "warn", kind: "occupied", label: "端口被占用", message: "入口端口 443/TCP 有其他程序在监听", hostId: 8, port: 443 },
  ];
  const out = annotateRuleCheckItems(items, warnings);
  assert.equal(out[0], items[0]);
  assert.equal(out[1].summary, "Agent 报告没在运行：监听没起来：IPv6 在这台机器上不可用");
  assert.match(out[1].hint || "", /journalctl/);
  assert.equal(out[2].key, "entry.occupied:8:443");
  assert.equal(out[2].status, "warn");
  assert.equal(annotateRuleCheckItems(items, []).length, 2);
});
