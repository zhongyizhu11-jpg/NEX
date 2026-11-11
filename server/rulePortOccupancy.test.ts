import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  AGENT_PORT_OCCUPANCY_VERSION,
  PORT_OCCUPANCY_FRESH_MS,
  agentSupportsPortOccupancy,
  classifyRuleRuntimeFailure,
  ruleRuntimeFailureLabel,
  getRulePortWarnings,
  knownOccupiedPortsOnHost,
  parsePortOccupancyReport,
  recordHostPortOccupancy,
  recordRuleRuntimeStatus,
  resetPortOccupancyForTests,
  withRulePortWarnings,
} from "./rulePortOccupancy";

const now = 1_800_000_000_000;
const rule = (overrides: Record<string, unknown> = {}) => ({ id: 11, hostId: 3, sourcePort: 443, protocol: "tcp", forwardType: "nftables", isEnabled: true, pendingDelete: false, ...overrides });
const report = (conflicts: unknown[], extra: Record<string, unknown> = {}) => ({ schema: 1, usable: true, collectedAt: now - 1000, checkedPorts: 3, conflicts, ...extra });
const nginx = { ruleId: 11, port: 443, protocol: "tcp", forwardType: "nftables", listeners: [{ address: "0.0.0.0", process: "nginx", pid: 812 }] };

test("下一个 Agent 版本起才发指令；版本号常量和 Agent 那头对得上", () => {
  assert.equal(AGENT_PORT_OCCUPANCY_VERSION, "2.2.255");
  assert.equal(agentSupportsPortOccupancy("2.2.252"), false);
  assert.equal(agentSupportsPortOccupancy("2.2.255"), true);
  assert.equal(agentSupportsPortOccupancy(null), false);
  const goSource = fs.readFileSync(path.join(process.cwd(), "agent/ext_ports.go"), "utf8");
  assert.match(goSource, /func \(m \*portOccupancyModule\) Name\(\) string \{ return "ports" \}/);
  assert.match(goSource, /只发给 2\.2\.255 起的 Agent/);
});

test("上报格式不对整份丢掉", () => {
  assert.equal(parsePortOccupancyReport(null, now), null);
  assert.equal(parsePortOccupancyReport(report([nginx], { schema: 2 }), now), null);
  assert.equal(parsePortOccupancyReport(report([{ ...nginx, protocol: "sctp" }]), now), null);
  assert.equal(parsePortOccupancyReport(report([{ ...nginx, listeners: [] }]), now), null);
  assert.equal(parsePortOccupancyReport(report([nginx], { collectedAt: now + 10 * 60_000 }), now), null);
  const parsed = parsePortOccupancyReport(report([nginx]), now);
  assert.equal(parsed?.conflicts[0].listeners[0].process, "nginx");
});

test("黄色：外来监听显示在规则上，管理员看到进程，普通用户只看到端口；冲突消失就清掉", () => {
  resetPortOccupancyForTests();
  recordHostPortOccupancy(3, parsePortOccupancyReport(report([nginx]), now)!, (id) => id, now);
  const admin = getRulePortWarnings(rule(), true, now);
  assert.equal(admin.length, 1);
  assert.equal(admin[0].level, "warn");
  assert.equal(admin[0].label, "端口被占用");
  assert.match(admin[0].message, /TCP 0\.0\.0\.0:443 ← nginx（pid 812）/);
  const user = getRulePortWarnings(rule(), false, now);
  assert.doesNotMatch(user[0].message, /nginx|812/);
  assert.match(user[0].message, /443\/TCP/);

  // 停用的规则不显示。
  assert.deepEqual(getRulePortWarnings(rule({ isEnabled: false }), true, now), []);
  // 列表装饰：没告警的行原样返回。
  const rows = withRulePortWarnings([rule(), rule({ id: 12 })], true, now) as any[];
  assert.equal(rows[0].portWarnings.length, 1);
  assert.equal("portWarnings" in rows[1], false);

  // 拿不到监听表的一轮不清也不续期；十分钟没新上报就不显示。
  recordHostPortOccupancy(3, parsePortOccupancyReport(report([], { usable: false }), now)!, (id) => id, now + 60_000);
  assert.equal(getRulePortWarnings(rule(), true, now + 60_000).length, 1);
  assert.equal(getRulePortWarnings(rule(), true, now + PORT_OCCUPANCY_FRESH_MS + 1).length, 0);

  // 下一轮没有冲突：清掉。
  recordHostPortOccupancy(3, parsePortOccupancyReport(report([]), now)!, (id) => id, now + 120_000);
  assert.deepEqual(getRulePortWarnings(rule(), true, now + 120_000), []);
});

test("转发组成员规则的告警挂到模板上；已删的规则丢掉", () => {
  resetPortOccupancyForTests();
  recordHostPortOccupancy(3, parsePortOccupancyReport(report([nginx, { ...nginx, ruleId: 99 }]), now)!, (id) => (id === 11 ? 5 : 0), now);
  assert.equal(getRulePortWarnings(rule({ id: 5 }), true, now).length, 1);
  assert.equal(getRulePortWarnings(rule({ id: 11 }), true, now).length, 0);
  assert.equal(getRulePortWarnings(rule({ id: 99 }), true, now).length, 0);
});

test("红色：绑定失败带上占用进程；报运行就清掉；认不出的失败原因不冲掉已有的", () => {
  resetPortOccupancyForTests();
  const failing = rule({ forwardType: "gost" });
  recordRuleRuntimeStatus({ rule: failing, hostId: 3, isRunning: false, message: "managed runtime listener not ready after apply port=443 protocol=tcp forwardType=gost; port 443/tcp occupied by nginx (pid 812)" }, now);
  let warnings = getRulePortWarnings(failing, true, now);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, "error");
  assert.equal(warnings[0].label, "端口绑定失败");
  assert.match(warnings[0].message, /443\/TCP 被 nginx（pid 812）占用/);
  assert.doesNotMatch(getRulePortWarnings(failing, false, now)[0].message, /nginx/);

  recordRuleRuntimeStatus({ rule: failing, hostId: 3, isRunning: false, message: "runtime action failed" }, now + 1000);
  assert.equal(getRulePortWarnings(failing, true, now + 1000).length, 1);

  // 同一台主机上同时有黄色的上报：只留红的那条。
  recordHostPortOccupancy(3, parsePortOccupancyReport(report([nginx]), now)!, (id) => id, now);
  assert.equal(getRulePortWarnings(failing, true, now).length, 1);

  recordRuleRuntimeStatus({ rule: failing, hostId: 3, isRunning: true, message: "" }, now + 2000);
  warnings = getRulePortWarnings(failing, true, now + 2000);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, "warn", "绑定失败清掉后，黄色的监听核对结论照常显示");
});

test("内核转发装不上 DOCKER-USER 放行：原因显示出来", () => {
  const failure = classifyRuleRuntimeFailure("kernel forward apply failed: [docker-compat] iptables-nft: cannot install DOCKER-USER allowance for rule 42 port 22022/tcp (in)", 22022);
  assert.equal(failure?.kind, "kernel");
  assert.match(failure!.admin, /内核转发未就绪：.*DOCKER-USER/);
  assert.doesNotMatch(failure!.user, /iptables/);
  assert.equal(classifyRuleRuntimeFailure("kernel firewall state mismatch after apply: net.ipv4.ip_forward is not enabled", 1)?.kind, "kernel");
  assert.equal(classifyRuleRuntimeFailure("listen tcp :443: bind: address already in use", 443)?.kind, "bind");
  assert.equal(classifyRuleRuntimeFailure("fxp listen port still busy role=entry", 443)?.kind, "bind");
  assert.equal(classifyRuleRuntimeFailure("dial tcp: i/o timeout", 443), null);
});

test("随机分配避开最近见过被占的端口（按协议）", () => {
  resetPortOccupancyForTests();
  recordHostPortOccupancy(3, parsePortOccupancyReport(report([nginx, { ...nginx, port: 5353, protocol: "udp" }]), now)!, (id) => id, now);
  assert.deepEqual(knownOccupiedPortsOnHost(3, "tcp", now), [443]);
  assert.deepEqual(knownOccupiedPortsOnHost(3, "udp", now), [5353]);
  assert.deepEqual(knownOccupiedPortsOnHost(3, "both", now).sort((a, b) => a - b), [443, 5353]);
  assert.deepEqual(knownOccupiedPortsOnHost(4, "tcp", now), []);
  // 规则删了、冲突也不再上报，端口仍记一阵子。
  recordHostPortOccupancy(3, parsePortOccupancyReport(report([]), now)!, (id) => id, now + 60_000);
  assert.deepEqual(knownOccupiedPortsOnHost(3, "tcp", now + 60_000), [443]);
  assert.deepEqual(knownOccupiedPortsOnHost(3, "tcp", now + 7 * 60 * 60 * 1000), []);
  // 绑定失败也算。
  recordRuleRuntimeStatus({ rule: rule({ sourcePort: 8443, protocol: "tcp", forwardType: "realm" }), hostId: 3, isRunning: false, message: "address already in use" }, now);
  assert.deepEqual(knownOccupiedPortsOnHost(3, "tcp", now), [8443]);
});

test("扩展模块 ports：只给新 Agent 发指令，老 Agent 的上报不收", async () => {
  resetPortOccupancyForTests();
  const { handleAgentExtRound } = await import("./ops/agentExt");
  await import("./ops/portOccupancyAgent");
  const oldRound = await handleAgentExtRound({ id: 3, agentVersion: "2.2.252" }, { modules: { ports: report([]) } });
  assert.equal("ports" in oldRound.modules, false);
  const newRound = await handleAgentExtRound({ id: 3, agentVersion: AGENT_PORT_OCCUPANCY_VERSION }, { modules: { ports: report([]) } });
  assert.deepEqual(newRound.modules.ports, { enabled: true });
});

test("别的失败原因也显示出来：短标签按原文归类，管理员看原文，租户看短标签", () => {
  resetPortOccupancyForTests();
  const failing = rule({ forwardType: "gost" });
  recordRuleRuntimeStatus({ rule: failing, hostId: 3, isRunning: false, message: "managed runtime listener not ready after apply port=443 protocol=tcp forwardType=gost" }, now);
  let warnings = getRulePortWarnings(failing, true, now);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "runtime");
  assert.equal(warnings[0].level, "error");
  assert.equal(warnings[0].label, "监听没起来");
  assert.match(warnings[0].message, /managed runtime listener not ready after apply port=443/);
  assert.doesNotMatch(getRulePortWarnings(failing, false, now)[0].message, /managed runtime/);

  // 换成更新的笼统原因：照样更新（都是 runtime）
  recordRuleRuntimeStatus({ rule: failing, hostId: 3, isRunning: false, message: "fxp runtime missing: install /usr/local/bin/forwardx-fxp to use custom encrypted tunnels" }, now + 1000);
  warnings = getRulePortWarnings(failing, true, now + 1000);
  assert.equal(warnings[0].label, "运行时没装");

  // 认得出的（端口被占）盖掉笼统的；之后再来笼统的不冲掉具体的
  recordRuleRuntimeStatus({ rule: failing, hostId: 3, isRunning: false, message: "listen tcp :443: bind: address already in use" }, now + 2000);
  recordRuleRuntimeStatus({ rule: failing, hostId: 3, isRunning: false, message: "runtime action failed: gost" }, now + 3000);
  assert.equal(getRulePortWarnings(failing, true, now + 3000)[0].kind, "bind");

  // 报运行：清掉
  recordRuleRuntimeStatus({ rule: failing, hostId: 3, isRunning: true, message: "" }, now + 4000);
  assert.deepEqual(getRulePortWarnings(failing, true, now + 4000), []);
  // 没运行但没说原因（正常移除的回执）：什么都不记
  recordRuleRuntimeStatus({ rule: failing, hostId: 3, isRunning: false, message: "" }, now + 5000);
  assert.deepEqual(getRulePortWarnings(failing, true, now + 5000), []);

  assert.equal(ruleRuntimeFailureLabel("managed runtime listeners not ready after sync: realm"), "监听没起来");
  assert.equal(ruleRuntimeFailureLabel("exec: \"gost\": executable file not found in $PATH"), "运行时没装");
  assert.equal(ruleRuntimeFailureLabel("fxp runtime exited immediately"), "启动失败");
});
