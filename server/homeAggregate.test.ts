import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 「家庭叠加」一步建好：家里那台的入口 IP 填成内网 IP、NEX 隧道（单连接叠加）、规则，
 * 规则自动认出落地节点（订阅里就有「家里 → 落地」）。起一个真的 sqlite，走真的建隧道、建规则接口。
 */
test("家庭叠加：一步建好主机入口 IP、叠加隧道和规则", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-home-aggregate-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (const [id, name, ip, token, line] of [
      [1, "家里", "203.0.113.10", "tok1", 0],
      [2, "前置 A", "198.51.100.2", "tok2", 500],
      [3, "前置 B", "198.51.100.3", "tok3", 300],
      [4, "落地", "203.0.113.40", "tok4", 2000],
    ]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat", "lineBandwidthMbps") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
        [id, name, ip, ip, "slave", token, "2.2.233", now, line],
      );
    }
    await exec('INSERT INTO proxy_inbounds (id, "userId", "hostId", name, protocol, port) VALUES (5, 1, 4, ?, ?, 8388)', ["落地入站", "shadowsocks"]);
    await exec('INSERT INTO proxy_nodes (id, "userId", name, protocol, address, port, "inboundId", password, method) VALUES (9, 1, ?, ?, ?, 8388, 5, ?, ?)', ["东京落地", "shadowsocks", "203.0.113.40", "pw", "aes-128-gcm"]);
    // 导入的节点，地址不是面板里任何一台主机：不能当落地。
    await exec('INSERT INTO proxy_nodes (id, "userId", name, protocol, address, port, password, method) VALUES (10, 1, ?, ?, ?, 443, ?, ?)', ["外部节点", "shadowsocks", "192.0.2.77", "pw", "aes-128-gcm"]);

    const { noteAgentPrivateIpv4 } = await import(url("server/agentPrivateAddress.ts"));
    noteAgentPrivateIpv4(1, "192.168.1.2");
    const { homeAggregateRouter } = await import(url("server/routers/homeAggregate.ts"));
    const caller = homeAggregateRouter.createCaller({
      req: { headers: {}, ip: "127.0.0.1", socket: {} },
      res: { cookie() {}, clearCookie() {} },
      user: { id: 1, role: "admin", username: "admin" },
      authSession: null,
      authFailureReason: null,
    });

    const options = await caller.options();
    assert.equal(options.hosts.find((host) => host.id === 1).detectedPrivateIpv4, "192.168.1.2");
    assert.equal(options.nodes.find((node) => node.id === 9).hostId, 4);
    assert.equal(options.nodes.find((node) => node.id === 10).hostId, 0);

    await assert.rejects(() => caller.create({ homeHostId: 1, relayHostIds: [2, 4], proxyNodeId: 9 }), /落地所在的主机不能同时当前置/);
    await assert.rejects(() => caller.create({ homeHostId: 1, relayHostIds: [2, 3], proxyNodeId: 10 }), /不在面板管理的主机上/);
    assert.equal((await query("SELECT COUNT(*) AS n FROM tunnels"))[0].n, 0, "校验没过不能留下隧道");

    const created = await caller.create({ homeHostId: 1, relayHostIds: [2, 3], proxyNodeId: 9 });
    assert.equal(created.subscriptionAddress, "192.168.1.2");
    assert.equal(created.entryIpFilled, "192.168.1.2");
    assert.ok(created.sourcePort > 0, "入口端口要自动分配");

    const [home] = await query('SELECT "entryIp" FROM hosts WHERE id = 1');
    assert.equal(home.entryIp, "192.168.1.2");
    const [tunnel] = await query('SELECT * FROM tunnels WHERE id = ?', [created.tunnelId]);
    assert.equal(tunnel.mode, "forwardx");
    assert.equal(tunnel.relayMode, "aggregate");
    assert.equal(Number(tunnel.entryHostId), 1);
    assert.equal(Number(tunnel.exitHostId), 4);
    assert.equal(tunnel.name, "家里 叠加 → 东京落地");
    const hops = await query('SELECT "hostId" FROM tunnel_hops WHERE "tunnelId" = ? ORDER BY seq', [created.tunnelId]);
    assert.deepEqual(hops.map((hop) => Number(hop.hostId)), [1, 2, 3, 4]);
    const [rule] = await query('SELECT * FROM forward_rules WHERE id = ?', [created.ruleId]);
    assert.equal(Number(rule.hostId), 1);
    assert.equal(Number(rule.tunnelId), created.tunnelId);
    assert.equal(rule.targetIp, "203.0.113.40");
    assert.equal(Number(rule.targetPort), 8388);
    assert.equal(Number(rule.proxyNodeId), 9, "规则要自动认出落地节点，订阅里才有这条");
    assert.equal(Number(rule.entryDomainEnabled), 0);

    // 已经填了入口 IP 的不动它。
    await exec('UPDATE hosts SET "entryIp" = ? WHERE id = 1', ["home.example.net"]);
    const second = await caller.create({ homeHostId: 1, relayHostIds: [3, 2], proxyNodeId: 9, name: "家里第二条" });
    assert.equal(second.entryIpFilled, null);
    assert.equal(second.subscriptionAddress, "home.example.net");
    console.log("OK");
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_TYPE: "sqlite",
      FORWARDX_TEST_DB: path.join(directory, "home.db"),
      FORWARDX_LOG_DIR: path.join(directory, "logs"),
    },
    timeout: 120_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
});
