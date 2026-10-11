import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 首页顶上那一行的依据。
 *
 * 那里原来挂着一个写死的绿色「系统在线」—— 后面没有任何数据，掉多少台机器它都
 * 是绿的。整个首页唯一该回答「现在系统是否正常」的地方，是个装饰。
 *
 * 这一组盯三件事：三类异常各自数得准、两类「看着像异常但不是」的不能误报、
 * 管理员和租户各自看到的范围对得上主机页。
 */
test("SQLite 系统健康摘要：三类异常数得准，两类似是而非的不误报", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-health-"));
  const databasePath = path.join(directory, "health.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const dash = await import(url("server/repositories/dashboardRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'hash', 'user')");

    const fresh = Math.floor(Date.now() / 1000);
    const stale = fresh - 6 * 3600;
    const addHost = (id, owner, isOnline, heartbeat) => exec(
      'INSERT INTO hosts (id, name, ip, "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, "主机" + id, "203.0.113." + id, "tok" + id, owner, isOnline, heartbeat],
    );
    await addHost(10, 1, 1, fresh);   // 在线
    await addHost(11, 1, 1, stale);   // 心跳过期 = 掉线
    await addHost(12, 1, 1, null);    // 从没连过 = 还没装 Agent，不算异常
    await addHost(13, 2, 1, fresh);   // 租户的，在线

    // 连接数：每台取最新一条，只加在线的。11 号掉线了、12 号没连过，它们的数不该进总数；
    // 10 号有两条上报，取新的那条；13 号是旧 Agent，没报连接数。
    const addMetric = (host, tcp, udp, at) => exec(
      'INSERT INTO host_metrics ("hostId", "tcpConnections", "udpConnections", "recordedAt") VALUES (?, ?, ?, ?)',
      [host, tcp, udp, at],
    );
    await addMetric(10, 900, 50, fresh - 60);
    await addMetric(10, 120, 8, fresh);
    await addMetric(11, 5000, 700, stale);
    await addMetric(13, null, null, fresh);

    const addRule = (id, host, owner, enabled, running, parent = null) => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "forwardGroupRuleId")'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, host, "转发" + id, 8000 + id, "198.51.100.1", 80, owner, enabled, running, parent],
    );
    await addRule(1, 10, 1, 1, 1);        // 正常跑着
    await addRule(2, 10, 1, 1, 0);        // 该跑没跑 = 异常
    await addRule(3, 10, 1, 0, 0);        // 停用的，不算异常
    await addRule(4, 10, 1, 1, 0, 1);     // 转发组的子规则，不该计入

    const addTunnel = (id, name, port, enabled, running) => exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", "listenPort", "userId", "isEnabled", "isRunning")'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, 10, 11, port, 1, enabled, running],
    );
    await addTunnel(20, "好隧道", 9001, 1, 1);
    await addTunnel(21, "坏隧道", 9002, 1, 0);
    await addTunnel(22, "停用隧道", 9003, 0, 0);

    const addGroup = (id, status) => exec(
      'INSERT INTO forward_groups (id, name, "targetIp", "userId", "isEnabled", "lastStatus") VALUES (?, ?, ?, ?, ?, ?)',
      [id, "组" + id, "198.51.100.9", 1, 1, status],
    );
    await addGroup(30, "healthy");
    await addGroup(31, "down");
    await addGroup(32, "unknown");   // 还没测过，不是异常

    const admin = await dash.getSystemHealthSummary(undefined);

    assert.equal(admin.hosts.total, 4);
    assert.equal(admin.hosts.online, 2, "只有心跳新鲜的才算在线");
    assert.equal(
      admin.hosts.offline,
      1,
      "掉线只该算「连过但现在不在线」那一台；从没连过的是还没装 Agent，混进来会让新加的机器天天报异常",
    );
    assert.equal(admin.hosts.neverConnected, 1);

    assert.equal(admin.forwards.total, 3, "转发组的子规则不该计入 —— 界面上从来只显示一条");
    assert.equal(admin.forwards.running, 1);
    assert.equal(admin.forwards.stalled, 1, "该跑没跑的才算异常");
    assert.equal(admin.forwards.disabled, 1, "停用是人主动关的，不是异常");

    assert.equal(admin.links.total, 6, "线路 = 隧道 + 转发组");
    assert.equal(
      admin.links.unhealthy,
      2,
      "只有「启用但没跑的隧道」和「明确报坏的转发组」算异常：停用的隧道和 unknown 的组都不算",
    );

    assert.equal(admin.issues, 1 + 2 + 1, "异常总数 = 掉线主机 + 不健康线路 + 该跑没跑的转发");

    assert.deepEqual(
      admin.connections,
      { tcp: 120, udp: 8, reported: 1 },
      "总连接数 = 在线主机各自最新一条上报相加：掉线的 11 号不算，10 号取新的那条，旧 Agent 的 13 号没报不计台数",
    );

    /** 租户只看自己的。 */
    const tenant = await dash.getSystemHealthSummary(2);
    assert.equal(tenant.hosts.total, 1);
    assert.equal(tenant.forwards.total, 0);
    assert.equal(tenant.issues, 0, "别人的异常不该出现在租户的首页上");
    assert.deepEqual(tenant.connections, { tcp: 0, udp: 0, reported: 0 }, "租户那台是旧 Agent，没报连接数就一台都不算");

    /** 全部正常时 issues 归零。 */
    await exec('UPDATE hosts SET "lastHeartbeat" = ? WHERE id = 11', [fresh]);
    await exec('UPDATE forward_rules SET "isRunning" = 1 WHERE id = 2');
    await exec('UPDATE tunnels SET "isRunning" = 1 WHERE id = 21');
    await exec('UPDATE forward_groups SET "lastStatus" = ? WHERE id = 31', ["healthy"]);
    const healthy = await dash.getSystemHealthSummary(undefined);
    assert.equal(healthy.issues, 0, "都修好之后应当归零，否则首页永远显示异常");

    console.log("OK");
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
});
