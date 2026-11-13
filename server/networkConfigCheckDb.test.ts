import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/**
 * 网络测试页的配置体检从库到清单走一遍：主机体检（Agent 版本、资源、规则运行、端口冲突）、
 * 规则体检（一键诊断面板那一半 + 没运行的原因），以及「只读」—— 不给主机排诊断任务。
 */
const setup = String.raw`
    const db = await import(url("server/db.ts"));
    const check = await import(url("server/networkConfigCheck.ts"));
    const occupancy = await import(url("server/rulePortOccupancy.ts"));
    const tasks = await import(url("server/diagnosticsAgentTasks.ts"));

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec("INSERT INTO users (id, username, password, role, canAddRules) VALUES (2, 'bob', 'hash', 'user', 1)");
    await exec("INSERT INTO users (id, username, password, role, canAddRules) VALUES (3, 'eve', 'hash', 'user', 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId, agentVersion, fxpVersion) VALUES (10, 'hk', '203.0.113.10', '203.0.113.10', 'tok10', 1, '2.2.200', '2.2.140')");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (11, 'bare', '203.0.113.11', '203.0.113.11', 1)");
    await db.updateHostHeartbeat(10);
    await exec("INSERT INTO user_host_permissions (userId, hostId) VALUES (2, 10)");
    const admin = { user: { id: 1, role: "admin" } };
    const bob = { user: { id: 2, role: "user" } };
    const eve = { user: { id: 3, role: "user" } };
    const byKey = (report) => Object.fromEntries(report.items.map((item) => [item.key, item]));
`;

function runInDatabase(body: string) {
  runSharedDatabaseTest(body, { name: "network-config-check", setup, quiet: true });
}

test("主机体检：Agent 过旧、资源打满、没运行的规则带原因、端口重叠；不给主机排任务", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, forwardType, protocol, sourcePort, targetIp, targetPort, isEnabled, isRunning, pendingDelete, isForwardGroupTemplate) VALUES (1, 2, 'game', 10, 'realm', 'tcp', 10443, '1.1.1.1', 443, 1, 0, 0, 0)");
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, forwardType, protocol, sourcePort, targetIp, targetPort, isEnabled, isRunning, pendingDelete, isForwardGroupTemplate) VALUES (2, 1, 'web', 10, 'realm', 'tcp', 10443, '8.8.8.8', 443, 1, 1, 0, 0)");
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, forwardType, protocol, sourcePort, targetIp, targetPort, isEnabled, isRunning, pendingDelete, isForwardGroupTemplate) VALUES (3, 1, 'off', 10, 'realm', 'tcp', 20000, '8.8.8.8', 443, 0, 0, 0, 0)");
    await db.insertHostMetric({ hostId: 10, cpuUsage: 20, memoryUsage: 30, diskUsage: 96 });
    const [rule1] = await query("SELECT * FROM forward_rules WHERE id = 1");
    occupancy.recordRuleRuntimeStatus({ rule: rule1, hostId: 10, isRunning: false, message: "listen tcp :10443: bind: address already in use" });

    const result = await check.checkHostConfig(admin, 10);
    assert.equal(result.scope, "host");
    assert.equal(result.report.subject.kind, "host");
    const items = byKey(result.report);
    assert.equal(items["host:10"].status, "pass");
    assert.equal(items["host.upgrade:10"].status, "warn");
    assert.match(items["host.upgrade:10"].summary, /Agent 版本过旧/);
    assert.equal(items["host.resource"].status, "warn");
    assert.match(items["host.resource"].summary, /磁盘 96%/);
    assert.equal(items["rules.runtime:1"].status, "fail");
    assert.match(items["rules.runtime:1"].summary, /端口绑定失败/);
    assert.equal(items["ports.overlap:1:2"].status, "fail", "规则 1、2 都用 10443/tcp");
    assert.equal(items["ports.used:1"].status, "fail", "没运行的规则 1 在面板端口表里撞上规则 2");
    assert.ok(!result.report.items.some((item) => item.key.includes(":3")), "停用的规则不检查");
    assert.equal(result.report.verdict, "fail");
    assert.equal(tasks.hasQueuedDiagnosticsAgentTasks(10), false, "体检是只读的，不派主机任务");

    // 普通用户只看到自己的规则；不是主机主人，不看资源。
    const mine = byKey((await check.checkHostConfig(bob, 10)).report);
    assert.ok(mine["rules.runtime:1"]);
    assert.ok(!mine["ports.overlap:1:2"], "看不到别人的规则，就不拿它做重叠比较");
    assert.equal(mine["host.resource"], undefined);
    assert.deepEqual((await check.listConfigCheckRules(bob, 10)).map((rule) => rule.id), [1]);
    assert.deepEqual((await check.listConfigCheckRules(admin, 10)).map((rule) => rule.id).sort(), [1, 2, 3]);

    await assert.rejects(check.checkHostConfig(eve, 10), /无权/);
  `);
});

test("主机体检：没绑 Agent 只出一项", () => {
  runInDatabase(String.raw`
    const result = await check.checkHostConfig(admin, 11);
    assert.deepEqual(result.report.items.map((item) => [item.key, item.status]), [["host.agent", "fail"]]);
  `);
});

test("规则体检：一键诊断的面板项 + 没运行的原因 + 经过主机的 Agent 过旧；报出还要主机实测的项数", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, forwardType, protocol, sourcePort, targetIp, targetPort, isEnabled, isRunning, pendingDelete, isForwardGroupTemplate) VALUES (1, 2, 'game', 10, 'realm', 'tcp', 10443, '1.1.1.1', 443, 1, 0, 0, 0)");
    const [rule1] = await query("SELECT * FROM forward_rules WHERE id = 1");
    occupancy.recordRuleRuntimeStatus({ rule: rule1, hostId: 10, isRunning: false, message: "managed runtime listener not ready after apply port=10443; cause=runtime-missing binary=/usr/local/bin/realm" });

    const result = await check.checkRuleConfig(bob, 1);
    assert.equal(result.scope, "rule");
    const items = byKey(result.report);
    assert.equal(items["config.enabled"].status, "pass");
    assert.equal(items["runtime.rule:1"].status, "fail");
    assert.match(items["runtime.rule:1"].summary, /Agent 报告没在运行：运行时没安装/);
    assert.match(items["runtime.rule:1"].hint, /升级 Agent/);
    assert.equal(items["host.upgrade:10"].status, "warn");
    assert.ok(result.pendingAgentChecks > 0, "端口监听、目标连通这些要主机实测的项只报个数");
    assert.ok(!result.report.items.some((item) => item.source === "agent"));
    assert.equal(tasks.hasQueuedDiagnosticsAgentTasks(10), false, "体检是只读的，不派主机任务");
    await assert.rejects(check.checkRuleConfig(eve, 1), /无权/);
  `);
});
