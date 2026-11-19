import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  P9：出口组只改「检测与切换」参数、分配方式，或者只调后面几台出口的先后，是入口换一份配置的事 ——
  不能把用这个出口组的链路和链路上的规则标成「未运行」（界面上整条链路全红，入口对出口的探测也跟着停）。
  真的要重新铺的（加减出口、换主出口）照旧标未运行。

  P14：多出口链路里掉线一台，别的出口还在线，链路照常在跑 —— 不能把整条链路的规则标成未运行。
  入口掉线、唯一的出口掉线、出口全掉线才清。
*/
test("出口组改检测参数 / 分配方式 / 后几台的顺序不把链路标成未运行；加减出口、换主出口才标", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-exit-group-config-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    console.info = () => {};
    console.warn = () => {};
    const groups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
    const service = await import(moduleUrl("server/services/forwardGroupService.ts"));
    const tunnelStatus = await import(moduleUrl("server/tunnelRuntimeStatus.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    for (const id of [1, 2, 3, 4, 5]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "entryIp", "tunnelEntryIp", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, "host-" + id, "198.51.100." + id, "198.51.100." + id, "198.51.100." + id, "10.0.0." + id, now],
      );
    }
    const member = (hostId, priority) => ({ memberType: "host", hostId, connectHost: "10.0.0." + hostId, priority, isEnabled: true });
    const input = (overrides = {}) => ({
      name: "exits", remark: null, groupMode: "exit", groupType: "host", protocol: "tcp", forwardType: "iptables",
      proxyProtocolReceive: false, proxyProtocolSend: false, proxyProtocolExitReceive: false, proxyProtocolExitSend: false, proxyProtocolVersion: 1,
      tcpFastOpen: false, zeroCopy: false, udpOverTcp: false, udpOverTcpPort: null,
      failoverEnabled: false, failoverStrategy: "fallback", failoverTargets: [], domain: null, recordType: "A",
      failoverSeconds: 60, recoverSeconds: 120, trafficMultiplier: 100,
      chinaHealthCheckEnabled: false, chinaHealthCheckTarget: null, telegramSwitchNotifyEnabled: false, ddnsAutoResolveEnabled: false,
      autoFailback: true, isEnabled: true, exitStrategy: "round_robin",
      members: [member(2, 0), member(3, 1), member(4, 2)],
      ...overrides,
    });
    const groupId = await service.createForwardGroupFromInput(input(), 1);
    await exec(
      'INSERT INTO tunnels (id, name, "exitGroupId", "entryHostId", "exitHostId", mode, "listenPort", "connectHost", "loadBalanceEnabled", "loadBalanceStrategy", "userId", "isEnabled", "isRunning") VALUES (300, ?, ?, 1, 2, ?, 25000, ?, 1, ?, 1, 1, 1)',
      ["controlled", groupId, "forwardx", "10.0.0.2", "round_robin"],
    );
    for (const [id, seq, hostId, port] of [[301, 1, 3, 25010], [302, 2, 4, 25020]]) {
      await exec('INSERT INTO tunnel_exit_nodes (id, "tunnelId", seq, "hostId", "listenPort", "connectHost", "isEnabled") VALUES (?, 300, ?, ?, ?, ?, 1)', [id, seq, hostId, port, "10.0.0." + hostId]);
    }
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (310, 1, ?, ?, ?, 300, 17000, ?, 443, 1, 1, 1)',
      ["tunnel-rule", "gost", "tcp", "203.0.113.20"],
    );
    // 各台都报过「在跑」。
    const markReady = () => { for (const hostId of [1, 2, 3, 4]) tunnelStatus.recordTunnelRuntimeHostStatus(300, hostId, true); };
    markReady();
    const state = async () => {
      const tunnel = (await query('SELECT "isRunning", "exitHostId", "loadBalanceStrategy", "balanceDetect" FROM tunnels WHERE id = 300'))[0];
      const rule = (await query('SELECT "isRunning" FROM forward_rules WHERE id = 310'))[0];
      const nodes = (await query('SELECT "hostId" FROM tunnel_exit_nodes WHERE "tunnelId" = 300 ORDER BY seq')).map((row) => Number(row.hostId));
      return { tunnel: Number(tunnel.isRunning), rule: Number(rule.isRunning), primary: Number(tunnel.exitHostId), nodes, strategy: tunnel.loadBalanceStrategy, detect: tunnel.balanceDetect };
    };
    const ready = (hostId) => tunnelStatus.isTunnelRuntimeHostReady(300, hostId);

    // 1. 只改检测与切换参数
    await service.updateForwardGroupFromInput(groupId, input({ balanceDetect: { intervalSeconds: 1, failThreshold: 3 } }));
    let s = await state();
    assert.equal(s.tunnel, 1, "改检测参数不把链路标成未运行");
    assert.equal(s.rule, 1, "改检测参数不重置链路上的规则");
    assert.match(String(s.detect), /"intervalSeconds":1/, "新参数带到了链路上");
    assert.equal(ready(1), false, "入口的就绪状态清掉：它要带着新配置重新下发一次");
    assert.equal(ready(2) && ready(3) && ready(4), true, "出口机不动");

    // 2. 只改分配方式
    markReady();
    await service.updateForwardGroupFromInput(groupId, input({ balanceDetect: { intervalSeconds: 1, failThreshold: 3 }, exitStrategy: "latency" }));
    s = await state();
    assert.deepEqual([s.tunnel, s.rule, s.strategy], [1, 1, "latency"], "改分配方式也只是配置下发");

    // 3. 调后面两台的先后（主出口不变）：和界面上拖动顺序走的是同一串调用
    markReady();
    const members = await query('SELECT id, "hostId" FROM forward_group_members WHERE "groupId" = ? ORDER BY priority', [groupId]);
    const idOf = (hostId) => Number(members.find((row) => Number(row.hostId) === hostId).id);
    const reorder = async (hostIds) => {
      await groups.reorderForwardGroupMembers(groupId, hostIds.map(idOf));
      await groups.runForwardGroupFailover(groupId, { forcePriority: true, forceSync: true });
      await groups.refreshForwardGroupReferences(groupId, { reason: "exit-group-reordered" });
    };
    await reorder([2, 4, 3]);
    s = await state();
    assert.deepEqual(s.nodes, [4, 3], "后两台的顺序换过来了");
    assert.deepEqual([s.tunnel, s.rule, s.primary], [1, 1, 2], "主出口没变：不标未运行");

    // 4. 换主出口：出口机要按新角色重装，照旧标未运行
    await reorder([4, 2, 3]);
    s = await state();
    assert.equal(s.primary, 4);
    assert.deepEqual([s.tunnel, s.rule], [0, 0], "换主出口要重新铺");

    // 5. 去掉一台出口：照旧标未运行
    await exec('UPDATE tunnels SET "isRunning" = 1 WHERE id = 300');
    await exec('UPDATE forward_rules SET "isRunning" = 1 WHERE id = 310');
    await service.updateForwardGroupFromInput(groupId, input({ balanceDetect: { intervalSeconds: 1, failThreshold: 3 }, exitStrategy: "latency", members: [member(4, 0), member(2, 1)] }));
    s = await state();
    assert.deepEqual(s.nodes, [2]);
    assert.deepEqual([s.tunnel, s.rule], [0, 0], "出口少了一台要重新铺");
    console.log("OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "config.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("多出口链路掉线一台：别的出口还在线时不清整条链路的运行状态；入口掉线、出口全掉线才清", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-exit-offline-runtime-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    console.info = () => {};
    console.warn = () => {};
    const db = await import(moduleUrl("server/db.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    for (const id of [1, 2, 3, 4]) {
      await exec('INSERT INTO hosts (id, name, ip, "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, 1, 1, ?)', [id, "host-" + id, "198.51.100." + id, "tok" + id, now]);
    }
    // 链路 1：入口 1，出口 2（主）+ 3、4，负载均衡。链路 2：入口 1，唯一的出口 3。
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "loadBalanceEnabled", "loadBalanceStrategy", "userId", "isEnabled", "isRunning") VALUES (1, ?, 1, 2, ?, 9000, 1, ?, 1, 1, 1)', ["多出口", "forwardx", "round_robin"]);
    await exec('INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (1, 1, 3, 9010, 1), (1, 2, 4, 9020, 1)');
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "isRunning") VALUES (2, ?, 1, 3, ?, 9100, 1, 1, 1)', ["单出口", "forwardx"]);
    for (const [id, tunnelId] of [[11, 1], [12, 1], [21, 2]]) {
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (?, 1, ?, ?, ?, ?, ?, ?, 443, 1, 1, 1)',
        [id, "rule" + id, "gost", "tcp", tunnelId, 17000 + id, "203.0.113.20"],
      );
    }
    // 出口 3 自己机器上的一条普通规则：它掉线了这条当然不在跑。
    await exec('INSERT INTO forward_rules (id, "hostId", name, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (31, 3, ?, 18000, ?, 80, 1, 1, 1)', ["local", "203.0.113.30"]);
    const running = async () => {
      const tunnels = await query('SELECT id, "isRunning" FROM tunnels ORDER BY id');
      const rules = await query('SELECT id, "isRunning" FROM forward_rules ORDER BY id');
      return { tunnels: Object.fromEntries(tunnels.map((row) => [row.id, Number(row.isRunning)])), rules: Object.fromEntries(rules.map((row) => [row.id, Number(row.isRunning)])) };
    };
    const restore = async () => {
      await exec('UPDATE tunnels SET "isRunning" = 1');
      await exec('UPDATE forward_rules SET "isRunning" = 1');
    };
    const offline = async (hostId) => {
      await exec('UPDATE hosts SET "isOnline" = 0, "lastHeartbeat" = ? WHERE id = ?', [now - 6 * 3600, hostId]);
      await db.resetAgentRuntimeStateForHost(hostId, { offline: true });
    };

    // 额外出口 3 掉线：链路 1 还有 2、4，照常；链路 2 的唯一出口没了；它本机的规则没了。
    await offline(3);
    let s = await running();
    assert.deepEqual(s.tunnels, { 1: 1, 2: 0 }, "多出口链路不受影响，单出口链路清掉");
    assert.deepEqual(s.rules, { 11: 1, 12: 1, 21: 0, 31: 0 });

    // 主出口 2 也掉线：还有 4 在线，链路 1 照常。
    await restore();
    await offline(2);
    s = await running();
    assert.equal(s.tunnels[1], 1, "主出口掉线但还有别的出口在线：不清");
    assert.deepEqual([s.rules[11], s.rules[12]], [1, 1]);

    // 最后一台出口 4 也掉线：出口全没了，清。
    await offline(4);
    s = await running();
    assert.equal(s.tunnels[1], 0, "出口全掉线：清");
    assert.deepEqual([s.rules[11], s.rules[12]], [0, 0]);

    // 入口掉线：不管出口在不在都清。
    await exec('UPDATE hosts SET "isOnline" = 1, "lastHeartbeat" = ? WHERE id IN (2, 3, 4)', [now]);
    await restore();
    await offline(1);
    s = await running();
    assert.deepEqual(s.tunnels, { 1: 0, 2: 0 }, "入口掉线：它的链路都清");
    assert.deepEqual([s.rules[11], s.rules[12], s.rules[21], s.rules[31]], [0, 0, 0, 1]);

    // 不是掉线（地址变了、Agent 重连）：主出口要重装，照旧整条清；额外出口不用。
    await exec('UPDATE hosts SET "isOnline" = 1, "lastHeartbeat" = ?', [now]);
    await restore();
    await db.resetAgentRuntimeStateForHost(4);
    s = await running();
    assert.equal(s.tunnels[1], 1, "额外出口重连：不清整条链路");
    await db.resetAgentRuntimeStateForHost(2);
    s = await running();
    assert.equal(s.tunnels[1], 0, "主出口重连 / 换地址：照旧清，出口要重新下发");
    console.log("OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "offline.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
