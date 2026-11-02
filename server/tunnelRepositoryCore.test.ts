import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  server/repositories/tunnelRepository.ts 的几块核心行为：增删改、端口占用判断、自动选端口、
  多跳 / 多出口的读写、删隧道时规则的处理。接真的 SQLite。
*/
const setup = String.raw`
  const tunnels = await import(url("server/repositories/tunnelRepository.ts"));
  await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
  for (const [id, start, end] of [[1, 20000, 20009], [2, 30000, 30004], [3, 0, 0]]) {
    await exec('INSERT INTO hosts (id, name, ip, "agentToken", "userId", "portRangeStart", "portRangeEnd") VALUES (?, ?, ?, ?, 1, ?, ?)', [id, "h" + id, "198.51.100." + id, "tok" + id, start || null, end || null]);
  }
  const rule = (id, hostId, sourcePort, extra = {}) => exec(
    'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "tunnelId", "tunnelExitPort", "pendingDelete") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)',
    [id, hostId, "r" + id, extra.forwardType || "iptables", extra.protocol || "tcp", sourcePort, "203.0.113.9", 80, extra.tunnelId ?? null, extra.tunnelExitPort ?? null, extra.pendingDelete ? 1 : 0],
  );
`;

test("tunnel create, read, update and audit", () => {
  runInDatabase(String.raw`
    const id = Number(await tunnels.createTunnel({ name: "t1", entryHostId: 1, exitHostId: 2, mode: "tls", listenPort: 30001, userId: 1 }));
    assert.ok(id > 0);
    const created = await tunnels.getTunnelById(id);
    assert.equal(created.name, "t1");
    assert.equal(Number(created.exitHostId), 2);
    await tunnels.updateTunnel(id, { name: "t1-renamed" });
    assert.equal((await tunnels.getTunnelById(id)).name, "t1-renamed");
    assert.deepEqual((await tunnels.getTunnelsByIds([id, 999])).map((row) => Number(row.id)), [id]);
    assert.deepEqual((await tunnels.getTunnelsByHost(2)).map((row) => Number(row.id)), [id]);
    assert.deepEqual((await tunnels.getTunnelsByHost(3)), []);
    const audits = await query('SELECT action FROM config_audit_events WHERE "resourceType" = ? AND "resourceId" = ? ORDER BY id', ["tunnel", id]);
    assert.deepEqual(audits.map((row) => row.action), ["create", "update"]);
  `, { name: "tunnel-repo-crud", setup, quiet: true });
});

test("port usage counts rules, tunnel listeners and exit mappings on the right host", () => {
  runInDatabase(String.raw`
    const tunnelId = Number(await tunnels.createTunnel({ name: "t", entryHostId: 1, exitHostId: 2, mode: "tls", listenPort: 30001, userId: 1 }));
    await rule(10, 1, 20001, { protocol: "tcp" });
    await rule(11, 1, 20002, { protocol: "udp" });
    await rule(12, 1, 20003, { forwardType: "gost", tunnelId, tunnelExitPort: 30002 });

    assert.equal(await tunnels.isPortUsedOnHost(1, 20001, undefined, "tcp"), true);
    // Agent 按端口记规则，同一个端口号 TCP / UDP 也只能有一条
    assert.equal(await tunnels.isPortUsedOnHost(1, 20001, undefined, "udp"), true);
    assert.equal(await tunnels.isPortUsedOnHost(1, 20002, undefined, "both"), true);
    assert.equal(await tunnels.isPortUsedOnHost(1, 20001, 10, "tcp"), false, "排除自己");
    assert.equal(await tunnels.isPortUsedOnHost(2, 20001, undefined, "tcp"), false, "端口只在同一台机器上冲突");
    assert.equal(await tunnels.isPortUsedOnHost(2, 30001), true, "出口机上的隧道监听端口");
    assert.equal(await tunnels.isPortUsedOnHost(2, 30002), true, "隧道规则在出口机上的端口");
    assert.equal(await tunnels.isTunnelListenPortUsed(2, 30001), true);
    assert.equal(await tunnels.isTunnelListenPortUsed(2, 30001, tunnelId), false);
    assert.equal(await tunnels.isTunnelListenPortUsed(2, 30003), false);
  `, { name: "tunnel-repo-ports", setup, quiet: true });
});

test("automatic port selection stays inside the host range and skips used and reserved ports", () => {
  runInDatabase(String.raw`
    for (let port = 20000; port <= 20006; port += 1) await rule(100 + port, 1, port, { protocol: "both" });
    // 区间里随机挑一个空着的
    for (let i = 0; i < 20; i += 1) {
      assert.ok([20007, 20008, 20009].includes(await tunnels.findAvailablePort(1, null, null, "tcp")));
      assert.equal(await tunnels.findAvailablePort(1, null, null, "tcp", [20007, 20008]), 20009, "跳过本请求预留的端口");
      // 套餐端口段进一步收窄
      assert.ok([20008, 20009].includes(await tunnels.findAvailablePort(1, null, null, "tcp", [], [], [{ start: 20008, end: 20009 }])));
    }
    assert.equal(await tunnels.findAvailablePort(1, null, null, "tcp", [20007, 20008, 20009]), null, "区间用完了");
    assert.equal(await tunnels.findAvailablePort(1, null, null, "tcp", [20009], [], [{ start: 20008, end: 20009 }]), 20008);
    // 排除自己的规则后它的端口又能选
    assert.equal(await tunnels.findAvailablePort(1, null, null, "tcp", [20007, 20008, 20009], [100 + 20003]), 20003);
  `, { name: "tunnel-repo-pick", setup, quiet: true });
});

test("hops and extra exits are replaced as a whole; endpoints list only enabled ones", () => {
  runInDatabase(String.raw`
    const tunnelId = Number(await tunnels.createTunnel({ name: "multi", entryHostId: 1, exitHostId: 2, mode: "tls", listenPort: 30001, userId: 1 }));
    await tunnels.createTunnelHops(tunnelId, [{ hostId: 1, listenPort: 20001 }, { hostId: 3, listenPort: 40000 }, { hostId: 2, listenPort: 30001 }]);
    await tunnels.createTunnelHops(tunnelId, [{ hostId: 1, listenPort: 20001 }, { hostId: 2, listenPort: 30001 }]);
    const hops = await tunnels.getTunnelHops(tunnelId);
    assert.deepEqual(hops.map((hop) => [Number(hop.seq), Number(hop.hostId)]), [[0, 1], [1, 2]]);

    await tunnels.replaceTunnelExitNodes(tunnelId, [
      { seq: 1, hostId: 3, listenPort: 40001, isEnabled: true },
      { seq: 2, hostId: 3, listenPort: 40002, isEnabled: false },
    ]);
    const tunnel = await tunnels.getTunnelById(tunnelId);
    const endpoints = await tunnels.getTunnelExitEndpoints(tunnel);
    assert.deepEqual(endpoints.map((endpoint) => [endpoint.hostId, endpoint.listenPort, endpoint.primary]), [[2, 30001, true], [3, 40001, false]]);
    assert.equal(await tunnels.isTunnelListenPortUsed(3, 40001), true, "额外出口的监听端口也算占用");
  `, { name: "tunnel-repo-multi", setup, quiet: true });
});

test("deleting a tunnel detaches and disables its rules and removes its rows", () => {
  runInDatabase(String.raw`
    const tunnelId = Number(await tunnels.createTunnel({ name: "gone", entryHostId: 1, exitHostId: 2, mode: "tls", listenPort: 30001, userId: 1 }));
    await tunnels.createTunnelHops(tunnelId, [{ hostId: 1, listenPort: 20001 }, { hostId: 2, listenPort: 30001 }]);
    await tunnels.replaceTunnelExitNodes(tunnelId, [{ seq: 1, hostId: 3, listenPort: 40001, isEnabled: true }]);
    await rule(30, 1, 20005, { forwardType: "gost", tunnelId, tunnelExitPort: 30003 });
    await exec('INSERT INTO forward_rule_tunnel_exits ("ruleId", "tunnelId", "exitNodeId", "exitSeq", "exitHostId", "tunnelExitPort") VALUES (30, ?, 1, 1, 3, 40005)', [tunnelId]);
    await tunnels.deleteTunnel(tunnelId);
    assert.equal(await tunnels.getTunnelById(tunnelId), undefined);
    const [row] = await query('SELECT "tunnelId", "isEnabled", "protocolBlockReason" FROM forward_rules WHERE id = 30');
    assert.equal(row.tunnelId, null);
    assert.equal(Number(row.isEnabled), 0, "隧道没了不能变成直连规则偷偷跑");
    assert.ok(String(row.protocolBlockReason || "").length > 0);
    for (const table of ["tunnel_hops", "tunnel_exit_nodes", "forward_rule_tunnel_exits"]) {
      assert.equal(Number((await query("SELECT COUNT(*) AS n FROM " + table))[0].n), 0, table);
    }
  `, { name: "tunnel-repo-delete", setup, quiet: true });
});
