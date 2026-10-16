import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCheckHints,
  agentCheckItems,
  evaluateConfigItems,
  evaluateDomainItem,
  evaluateHostItem,
  evaluatePortConflictItem,
  evaluateRuntimeItem,
  evaluateTargetAddressItem,
  type DiagnosticConfigFacts,
  type DiagnosticOwnerFacts,
  type PlannedAgentCheck,
} from "./linkDiagnosticsChecks";
import { tunnelHopEdges } from "./linkDiagnostics";
import type { DiagnosticsTaskStatus } from "./diagnosticsAgentTasks";
import { AGENT_VERSION, FXP_RUNTIME_VERSION } from "../shared/versions";

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

const owner: DiagnosticOwnerFacts = {
  exists: true, role: "user", accountEnabled: true, canAddRules: true, pauseReason: null,
  expiresAt: new Date(NOW + 30 * 86_400_000), trafficLimit: 100 * 1024 ** 3, trafficUsed: 10 * 1024 ** 3, maxRules: 10, ruleCount: 3,
};

function facts(overrides: Partial<DiagnosticConfigFacts> = {}): DiagnosticConfigFacts {
  return {
    subjectKind: "rule",
    rule: { isEnabled: true, targetIp: "1.1.1.1", targetPort: 443, sourcePort: 10443, forwardType: "realm" },
    protocolEnabled: true,
    protocolLabel: "Realm",
    forwardTypeAllowed: null,
    portPolicy: { allowed: true },
    owner,
    now: NOW,
    ...overrides,
  };
}

function byKey(items: ReturnType<typeof evaluateConfigItems>) {
  return Object.fromEntries(items.map((entry) => [entry.key, entry]));
}

test("配置：全部正常时每项都通过", () => {
  const items = byKey(evaluateConfigItems(facts()));
  for (const key of ["config.enabled", "config.target", "config.port", "config.forwardType", "config.account", "config.traffic", "config.quota"]) {
    assert.equal(items[key]?.status, "pass", key);
  }
  assert.match(items["config.traffic"].summary, /10\.0 GB \/ 100 GB（10%）/);
});

test("配置：规则停用 / 被隧道连带停用 / 系统停用各说各的", () => {
  const off = byKey(evaluateConfigItems(facts({ rule: { isEnabled: false } })))["config.enabled"];
  assert.equal(off.status, "fail");
  assert.equal(off.summary, "规则已停用");
  assert.match(byKey(evaluateConfigItems(facts({ rule: { isEnabled: false, disabledByTunnel: true } })))["config.enabled"].summary, /隧道被停用/);
  assert.match(byKey(evaluateConfigItems(facts({ rule: { isEnabled: 0, protocolBlockReason: "端口 443 冲突" } })))["config.enabled"].summary, /端口 443 冲突/);
  const tunnelOff = byKey(evaluateConfigItems(facts({ tunnel: { name: "港口", isEnabled: false } })))["config.enabled"];
  assert.match(tunnelOff.summary, /隧道「港口」已停用/);
});

test("配置：目标、端口范围、转发方式", () => {
  assert.equal(byKey(evaluateConfigItems(facts({ rule: { isEnabled: true, targetIp: "", targetPort: 443 } })))["config.target"].status, "fail");
  assert.equal(byKey(evaluateConfigItems(facts({ rule: { isEnabled: true, targetIp: "a.com", targetPort: 70000 } })))["config.target"].status, "fail");
  assert.equal(byKey(evaluateConfigItems(facts({ rule: { isEnabled: true, targetIp: "2001:db8::1", targetPort: 80 } })))["config.target"].summary, "[2001:db8::1]:80");
  const port = byKey(evaluateConfigItems(facts({ portPolicy: { allowed: false, reason: "套餐端口必须在 20000-30000 范围内" } })))["config.port"];
  assert.equal(port.status, "fail");
  assert.match(port.summary, /20000-30000/);
  assert.equal(byKey(evaluateConfigItems(facts({ protocolEnabled: false })))["config.forwardType"].status, "fail");
  assert.match(byKey(evaluateConfigItems(facts({ forwardTypeAllowed: false })))["config.forwardType"].summary, /不允许使用 Realm/);
  assert.equal(byKey(evaluateConfigItems(facts({ subjectKind: "tunnel", rule: null })))["config.target"], undefined, "隧道没有目标一项");
});

test("配置：账户停用 / 到期 / 暂停 / 快到期；流量用完 / 快用完；规则超配额", () => {
  const disabled = byKey(evaluateConfigItems(facts({ owner: { ...owner, accountEnabled: false } })))["config.account"];
  assert.equal(disabled.status, "fail");
  const expired = byKey(evaluateConfigItems(facts({ owner: { ...owner, expiresAt: new Date(NOW - 1000) } })))["config.account"];
  assert.equal(expired.status, "fail");
  assert.match(expired.hint || "", /续期/);
  const paused = byKey(evaluateConfigItems(facts({ owner: { ...owner, canAddRules: false, pauseReason: "traffic_billing_balance" } })))["config.account"];
  assert.equal(paused.status, "fail");
  assert.match(paused.hint || "", /充值/);
  assert.equal(byKey(evaluateConfigItems(facts({ owner: { ...owner, expiresAt: new Date(NOW + 2 * 86_400_000) } })))["config.account"].status, "warn");
  const exhausted = byKey(evaluateConfigItems(facts({ owner: { ...owner, trafficUsed: owner.trafficLimit } })))["config.traffic"];
  assert.equal(exhausted.status, "fail");
  assert.equal(byKey(evaluateConfigItems(facts({ owner: { ...owner, trafficUsed: owner.trafficLimit * 0.95 } })))["config.traffic"].status, "warn");
  assert.equal(byKey(evaluateConfigItems(facts({ owner: { ...owner, ruleCount: 11 } })))["config.quota"].status, "warn");
  assert.equal(byKey(evaluateConfigItems(facts({ owner: { ...owner, exists: false } })))["config.account"].status, "fail");
  const admin = evaluateConfigItems(facts({ owner: { ...owner, role: "admin", trafficUsed: owner.trafficLimit * 2 } }));
  assert.equal(byKey(admin)["config.account"].status, "pass");
  assert.equal(byKey(admin)["config.traffic"], undefined, "管理员不看流量额度");
});

test("主机：离线失败、FXP 握不上失败、Agent 旧警告、最新通过", () => {
  const host = { id: 1, name: "hk-1", role: "入口", isOnline: true, agentVersion: AGENT_VERSION, fxpVersion: FXP_RUNTIME_VERSION };
  assert.equal(evaluateHostItem(host).status, "pass");
  const offline = evaluateHostItem({ ...host, isOnline: false, lastHeartbeat: new Date(NOW) });
  assert.equal(offline.status, "fail");
  assert.match(offline.summary, /离线（最后心跳/);
  assert.equal(evaluateHostItem({ ...host, fxpVersion: "2.2.100" }, { requireFxp: true }).status, "fail");
  assert.equal(evaluateHostItem({ ...host, fxpVersion: "2.2.100" }).status, "pass", "不走 NEX 隧道就不看 FXP");
  const old = evaluateHostItem({ ...host, agentVersion: "2.2.224" });
  assert.equal(old.status, "warn");
  assert.match(old.summary, /需要 2\.2\.226/);
  assert.equal(evaluateHostItem({ ...host, agentVersion: "" }).status, "warn");
  assert.equal(evaluateHostItem(host).title, "入口「hk-1」");
});

test("运行状态：没跑失败、没报过警告、主机离线跳过", () => {
  const base = { key: "runtime.rule:1", group: "entry" as const, hostId: 1, hostName: "hk-1", what: "规则", hostOnline: true };
  assert.equal(evaluateRuntimeItem({ ...base, running: true }).status, "pass");
  assert.equal(evaluateRuntimeItem({ ...base, running: false }).status, "fail");
  assert.equal(evaluateRuntimeItem({ ...base, running: undefined }).status, "warn");
  assert.equal(evaluateRuntimeItem({ ...base, running: false, hostOnline: false }).status, "skip");
});

test("端口冲突：被占失败（带原因）、没占通过、查失败跳过", () => {
  const base = { hostId: 1, hostName: "hk-1", port: 443 };
  assert.equal(evaluatePortConflictItem({ ...base, used: false }).status, "pass");
  const used = evaluatePortConflictItem({ ...base, used: true, reason: "换隧道后的临时桥接占着，10 分钟后放开" });
  assert.equal(used.status, "fail");
  assert.match(used.summary, /临时桥接/);
  assert.equal(evaluatePortConflictItem({ ...base, used: false, error: "db down" }).status, "skip");
});

test("入口域名：解析到入口 IP 通过；解析到别处警告；解析失败失败；不知道入口 IP 跳过", () => {
  const base = { key: "entry.domain", label: "入口域名", domain: "a.example.com", hostId: 1, hostName: "hk-1", expected: ["203.0.113.5"] };
  assert.equal(evaluateDomainItem({ ...base, resolved: ["203.0.113.5"] }).status, "pass");
  const elsewhere = evaluateDomainItem({ ...base, resolved: ["198.51.100.1"] });
  assert.equal(elsewhere.status, "warn");
  assert.match(elsewhere.detail || "", /入口主机地址：203\.0\.113\.5/);
  const nx = evaluateDomainItem({ ...base, resolved: null, error: "域名不存在（NXDOMAIN）", publishError: "Cloudflare token 无效" });
  assert.equal(nx.status, "fail");
  assert.match(nx.hint || "", /Cloudflare token 无效/);
  assert.equal(evaluateDomainItem({ ...base, expected: [], resolved: ["1.2.3.4"] }).status, "skip");
  assert.equal(evaluateDomainItem({ ...base, resolved: ["203.0.113.5"], publishError: "rate limited" }).status, "warn");
});

test("目标地址：公网通过、内网警告、内网但是面板主机通过、域名解析不了警告", () => {
  assert.equal(evaluateTargetAddressItem({ target: "1.1.1.1" }).status, "pass");
  assert.equal(evaluateTargetAddressItem({ target: "10.0.0.8" }).status, "warn");
  assert.match(evaluateTargetAddressItem({ target: "127.0.0.1" }).summary, /回环/);
  assert.equal(evaluateTargetAddressItem({ target: "10.0.0.8", managedHostName: "jp-2" }).status, "pass");
  assert.equal(evaluateTargetAddressItem({ target: "game.example.com", resolved: null, resolveError: "域名不存在（NXDOMAIN）" }).status, "warn");
  assert.equal(evaluateTargetAddressItem({ target: "game.example.com", resolved: ["192.168.1.2"] }).status, "warn");
  assert.equal(evaluateTargetAddressItem({ target: "game.example.com", resolved: ["93.184.216.34"] }).status, "pass");
});

const planned: PlannedAgentCheck[] = [
  { check: { id: "c1", kind: "listen", port: 443, protocol: "tcp" }, group: "entry", title: "端口 443 在监听", hostId: 1, hostName: "hk-1", ...agentCheckHints({ id: "c1", kind: "listen", port: 443 }) },
  { check: { id: "c2", kind: "firewall", port: 443, protocol: "tcp" }, group: "entry", title: "防火墙放行端口 443", hostId: 1, hostName: "hk-1", ...agentCheckHints({ id: "c2", kind: "firewall", port: 443, protocol: "tcp" }) },
  { check: { id: "c3", kind: "dial", host: "1.1.1.1", port: 443 }, group: "target", title: "连得上 1.1.1.1:443", hostId: 1, hostName: "hk-1", ...agentCheckHints({ id: "c3", kind: "dial", host: "1.1.1.1", port: 443 }, { role: "target" }) },
];

function task(status: DiagnosticsTaskStatus["status"], results: DiagnosticsTaskStatus["results"] = [], error?: string): DiagnosticsTaskStatus {
  return { taskId: "t", hostId: 1, status, results, error, createdAt: "", startedAt: "", finishedAt: "", durationMs: 0 };
}

test("Agent 项：离线跳过；旧 Agent 显示「需要升级 Agent」而不是失败", () => {
  const offline = agentCheckItems(planned, { online: false, agentVersion: AGENT_VERSION, detailVisible: true }, null);
  assert.ok(offline.every((entry) => entry.status === "skip" && !entry.needsUpgrade));
  const old = agentCheckItems(planned, { online: true, agentVersion: "2.2.224", detailVisible: true }, null);
  assert.ok(old.every((entry) => entry.status === "skip" && entry.needsUpgrade === true));
  assert.equal(old[0].summary, "需要升级 Agent 到 2.2.226");
  assert.ok(old.every((entry) => entry.source === "agent"));
});

test("Agent 项：排队 / 运行中是等待；超时是警告；回报后按结果给状态和修复建议", () => {
  const gate = { online: true, agentVersion: "2.2.226", taskId: "t", detailVisible: true };
  assert.ok(agentCheckItems(planned, gate, task("queued")).every((entry) => entry.status === "pending"));
  assert.ok(agentCheckItems(planned, gate, task("running")).every((entry) => entry.status === "pending"));
  const timedOut = agentCheckItems(planned, gate, task("timeout", [], "Agent 取走了诊断任务，但没在时限内回报"));
  assert.ok(timedOut.every((entry) => entry.status === "warn"));
  const done = agentCheckItems(planned, gate, task("done", [
    { id: "c1", kind: "listen", status: "fail", summary: "没有程序在听 tcp 端口 443", detail: "ss output" },
    { id: "c2", kind: "firewall", status: "warn", summary: "ufw 已启用，但没有放行端口 443 的规则" },
  ]));
  assert.equal(done[0].status, "fail");
  assert.match(done[0].hint || "", /没有程序在听/);
  assert.equal(done[0].detail, "ss output");
  assert.equal(done[1].status, "warn");
  assert.match(done[1].hint || "", /ufw allow 443\/tcp/);
  assert.equal(done[2].status, "skip", "Agent 没回的那项");
  const partial = agentCheckItems(planned, gate, task("running", [{ id: "c3", kind: "dial", status: "pass", summary: "TCP 连得上", latencyMs: 31 }]));
  assert.equal(partial[2].status, "pass");
  assert.equal(partial[2].latencyMs, 31);
  assert.equal(partial[2].hint, undefined, "通过的项不给建议");
  assert.equal(partial[0].status, "pending");
});

test("Agent 项：非管理员看别人的主机，不给原始输出", () => {
  const items = agentCheckItems(planned, { online: true, agentVersion: "2.2.226", taskId: "t", detailVisible: false }, task("done", [
    { id: "c2", kind: "firewall", status: "pass", summary: "没发现", detail: "-P INPUT ACCEPT" },
  ]));
  assert.equal(items[1].detail, "（原始输出只有管理员能看）");
});

test("隧道每一段：多跳按 seq 一段段，单跳入口直接拨出口", () => {
  const hosts = new Map<number, any>([
    [1, { id: 1, ipv4: "203.0.113.1" }],
    [2, { id: 2, ipv4: "203.0.113.2", tunnelEntryIp: "10.0.0.2" }],
    [3, { id: 3, ipv4: "203.0.113.3" }],
  ]);
  const tunnel = { id: 9, entryHostId: 1, exitHostId: 3, listenPort: 30000, networkType: "public" };
  assert.deepEqual(tunnelHopEdges(tunnel, [], hosts), [{ fromHostId: 1, toHostId: 3, address: "203.0.113.3", port: 30000 }]);
  const hops = [
    { seq: 2, hostId: 3, listenPort: 30000 },
    { seq: 0, hostId: 1, listenPort: 0 },
    { seq: 1, hostId: 2, listenPort: 31000, connectHost: "relay.example.com" },
  ];
  assert.deepEqual(tunnelHopEdges(tunnel, hops, hosts), [
    { fromHostId: 1, toHostId: 2, address: "relay.example.com", port: 31000 },
    { fromHostId: 2, toHostId: 3, address: "203.0.113.3", port: 30000 },
  ]);
  assert.equal(tunnelHopEdges({ ...tunnel, networkType: "private" }, [hops[1], { seq: 1, hostId: 2, listenPort: 31000 }, hops[0]], hosts)[0].address, "10.0.0.2");
});
