import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 一键链路诊断从库到清单走一遍：直连规则、隧道规则、隧道本身。看面板侧的项判得对、
 * 新 Agent 排了任务、旧 Agent 那几项是「需要升级 Agent」、Agent 回报后清单跟着变。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-diagnostics-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const db = await import(url("server/db.ts"));
      const diagnostics = await import(url("server/linkDiagnostics.ts"));
      const tasks = await import(url("server/diagnosticsAgentTasks.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
      await exec("INSERT INTO users (id, username, password, role, canAddRules, trafficLimit, trafficUsed) VALUES (2, 'bob', 'hash', 'user', 1, 1000, 1000)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId, agentVersion) VALUES (10, 'hk', '203.0.113.10', '203.0.113.10', 'tok10', 1, '2.2.226')");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId, agentVersion) VALUES (11, 'jp', '203.0.113.11', '203.0.113.11', 'tok11', 1, '2.2.224')");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId, agentVersion) VALUES (12, 'us', '203.0.113.12', '203.0.113.12', 'tok12', 1, '2.2.226')");
      await db.updateHostHeartbeat(10);
      await db.updateHostHeartbeat(11);
      const admin = { user: { id: 1, role: "admin" } };
      const bob = { user: { id: 2, role: "user" } };
      const byKey = (report) => Object.fromEntries(report.items.map((item) => [item.key, item]));

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "diag.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("直连规则：面板侧当场出结论，Agent 项先等待，回报后更新；端口冲突、流量用完都能判出来", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, forwardType, protocol, sourcePort, targetIp, targetPort, isEnabled, isRunning, pendingDelete, isForwardGroupTemplate) VALUES (1, 2, 'game', 10, 'realm', 'tcp', 10443, '1.1.1.1', 443, 1, 1, 0, 0)");
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, forwardType, protocol, sourcePort, targetIp, targetPort, isEnabled, isRunning, pendingDelete, isForwardGroupTemplate) VALUES (2, 1, 'clash', 10, 'realm', 'tcp', 10443, '8.8.8.8', 443, 1, 0, 0, 0)");

    const report = await diagnostics.startLinkDiagnostics(bob, { kind: "rule", id: 1 });
    const items = byKey(report);
    assert.equal(report.subject.name, "game");
    assert.equal(items["config.enabled"].status, "pass");
    assert.equal(items["config.traffic"].status, "fail", "1000/1000 字节：流量用完");
    assert.equal(items["host:10"].status, "pass");
    assert.equal(items["runtime.rule:1"].status, "pass");
    assert.equal(items["entry.portConflict:10"].status, "fail", "规则 2 也占着 10443");
    assert.equal(items["target.address"].status, "pass");
    const agentItems = report.items.filter((item) => item.source === "agent");
    assert.deepEqual(agentItems.map((item) => item.title), [
      "端口 10443/tcp 在监听", "防火墙放行端口 10443", "本机连得上端口 10443", "转发进程在运行", "「hk」连得上 1.1.1.1:443",
    ]);
    assert.ok(agentItems.every((item) => item.status === "pending"));
    assert.equal(report.verdict, "fail");
    assert.equal(report.cause.key, "config.traffic", "配置排在最前面，流量用完是最可能的原因");

    assert.equal(tasks.hasQueuedDiagnosticsAgentTasks(10), true);
    const [task] = tasks.takeDiagnosticsAgentTasks(10);
    assert.equal(task.checks.length, 5);
    assert.deepEqual(task.checks.map((check) => check.kind), ["listen", "firewall", "loopback", "process", "dial"]);
    assert.equal(task.checks[2].publicIp, "203.0.113.10");
    tasks.completeDiagnosticsAgentTask(10, { taskId: task.taskId, results: task.checks.map((check) => ({ id: check.id, status: check.kind === "dial" ? "fail" : "pass", summary: check.kind })) });

    const after = diagnostics.getLinkDiagnosticsReport(bob, report.sessionId);
    assert.equal(after.running, false);
    assert.equal(after.items.filter((item) => item.source === "agent" && item.status === "pending").length, 0);
    assert.equal(byKey(after)["agent:10:c5"].status, "fail");
    assert.equal(byKey(after)["agent:10:c1"].detail, undefined);
    assert.throws(() => diagnostics.getLinkDiagnosticsReport({ user: { id: 3, role: "user" } }, report.sessionId), /过期/, "别人看不到这次诊断");
    await assert.rejects(diagnostics.startLinkDiagnostics({ user: { id: 3, role: "user" } }, { kind: "rule", id: 1 }), /无权/);
  `);
});

test("隧道规则：入口 / 出口都在清单里，旧 Agent 的出口项是「需要升级 Agent」，离线的跳过", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, mode, listenPort, userId, isEnabled, isRunning) VALUES (5, '港日', 10, 11, 'tls', 30000, 1, 1, 1)");
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, forwardType, protocol, sourcePort, targetIp, targetPort, tunnelId, isEnabled, isRunning, pendingDelete, isForwardGroupTemplate) VALUES (3, 1, 'via', 10, 'gost', 'tcp', 20443, 'example.invalid', 443, 5, 1, 1, 0, 0)");

    const report = await diagnostics.startLinkDiagnostics(admin, { kind: "rule", id: 3 });
    const items = byKey(report);
    assert.equal(items["host:10"].title, "入口「hk」");
    assert.equal(items["host:11"].title, "出口「jp」");
    assert.equal(items["host:11"].status, "warn", "2.2.224 低于诊断要求");
    assert.equal(items["runtime.tunnel:11"].status, "pass");
    assert.equal(items["target.address"].status, "warn", ".invalid 面板解析不了");
    const exitAgent = report.items.filter((item) => item.source === "agent" && item.hostId === 11);
    assert.ok(exitAgent.length >= 3);
    assert.ok(exitAgent.every((item) => item.status === "skip" && item.needsUpgrade), "出口机没排任务，显示需要升级");
    assert.equal(tasks.hasQueuedDiagnosticsAgentTasks(11), false);
    const [task] = tasks.takeDiagnosticsAgentTasks(10);
    assert.ok(task.checks.some((check) => check.kind === "dial" && check.host === "203.0.113.11" && check.port === 30000), "入口拨出口的隧道端口");
    assert.ok(task.checks.some((check) => check.kind === "process" && check.forwardType === "gost"));

    const tunnelReport = await diagnostics.startLinkDiagnostics(admin, { kind: "tunnel", id: 5 });
    const tunnelItems = byKey(tunnelReport);
    assert.equal(tunnelItems["config.enabled"].title, "隧道已启用");
    assert.equal(tunnelItems["config.target"], undefined);
    assert.ok(tunnelReport.items.some((item) => item.title.includes("隧道端口 30000 在监听")));

    await exec("UPDATE tunnels SET exitHostId = 12 WHERE id = 5");
    const offline = await diagnostics.startLinkDiagnostics(admin, { kind: "tunnel", id: 5 });
    assert.equal(byKey(offline)["host:12"].status, "fail");
    assert.equal(offline.cause.key, "host:12");
    assert.ok(offline.items.filter((item) => item.source === "agent" && item.hostId === 12).every((item) => item.status === "skip" && !item.needsUpgrade));
  `);
});

test("走 Shadowsocks 出口的规则：入口拨 SS 端口，落地主机拨目标；入口不再直拨目标", () => {
  runInDatabase(String.raw`
    await db.updateHostHeartbeat(12);
    const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));
    const inboundId = Number(await inbounds.createProxyInbound({ userId: 1, hostId: 12, name: "us SS", protocol: "shadowsocks", port: 28388, transport: "tcp", security: "none", method: "aes-256-gcm", password: "pw", isEnabled: true, landingEgress: true }));
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, forwardType, protocol, sourcePort, targetIp, targetPort, isEnabled, isRunning, pendingDelete, isForwardGroupTemplate, egressType, egressInboundId) VALUES (7, 1, 'via-us', 10, 'gost', 'tcp', 10777, '192.168.5.5', 22, 1, 1, 0, 0, 'ss_host', ?)", [inboundId]);

    const report = await diagnostics.startLinkDiagnostics(admin, { kind: "rule", id: 7 });
    const items = byKey(report);
    assert.equal(items["egress:7"].status, "pass", items["egress:7"].summary);
    assert.match(items["egress:7"].summary, /落地「us」/);
    assert.ok(items["host:12"], "落地主机也在主机清单里");

    const [entryTask] = tasks.takeDiagnosticsAgentTasks(10);
    const entryDials = entryTask.checks.filter((check) => check.kind === "dial");
    assert.ok(entryDials.some((check) => check.host === "203.0.113.12" && check.port === 28388), JSON.stringify(entryDials));
    assert.ok(!entryDials.some((check) => check.host === "192.168.5.5"), "入口不该直拨目标");
    const [landingTask] = tasks.takeDiagnosticsAgentTasks(12);
    assert.ok(landingTask.checks.some((check) => check.kind === "dial" && check.host === "192.168.5.5" && check.port === 22), "目标由落地主机去连");
  `);
});
