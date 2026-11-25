import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 主机卡片上「几条转发 / 几条隧道」那两个数得是真的。
 *
 * 转发按 hostId 数，不看启用状态，但待删除（pendingDelete）的不算；隧道按入口 / 出口 /
 * 多级隧道的任一跳 / 负载均衡额外出口 / 入口组启用成员算 —— 和 getTunnelsByHost 同一口径。
 * 跳存在 tunnel_hops 表里（一跳一行），所以同一条隧道里一台机器既是入口又是某一跳时
 * 只能算一次，否则「在 2 条隧道里」会被报成 3。
 */
test("主机列表要带上每台机器的转发数和隧道数", () => {
  runInDatabase(String.raw`
    const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
    const tunnels = await import(url("server/repositories/tunnelRepository.ts"));
    const { hostsRouter } = await import(url("server/routers/hosts.ts"));

    const callerFor = (user) => hostsRouter.createCaller({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
    const tenant = { id: 2, username: "tenant", role: "user", accountEnabled: true };

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'hash', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (10, '入口机', '127.0.0.10', 'slave', 'tok10', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (20, '出口机', '127.0.0.20', 'slave', 'tok20', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (30, '中转机', '127.0.0.30', 'slave', 'tok30', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (40, '落地机', '127.0.0.40', 'slave', 'tok40', 2)");

    // 隧道 8：普通隧道 10 → 20。
    await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (8, '普通隧道', 10, 20, 9000, 2)");
    // 隧道 9：多级隧道 10 → 30 → 40，跳存在 tunnel_hops 里；入口 10 和出口 40 也各是一跳。
    await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (9, '多级隧道', 10, 40, 9001, 2)");
    await exec("INSERT INTO tunnel_hops (tunnelId, seq, hostId, listenPort) VALUES (9, 0, 10, 0)");
    await exec("INSERT INTO tunnel_hops (tunnelId, seq, hostId, listenPort) VALUES (9, 1, 30, 9101)");
    await exec("INSERT INTO tunnel_hops (tunnelId, seq, hostId, listenPort) VALUES (9, 2, 40, 9102)");
    // 主机 50：只作为隧道 8 的负载均衡额外出口（tunnel_exit_nodes）出现。
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (50, '备用出口', '127.0.0.50', 'slave', 'tok50', 2)");
    await exec("INSERT INTO tunnel_exit_nodes (tunnelId, seq, hostId, listenPort) VALUES (8, 1, 50, 0)");
    // 主机 60：只作为隧道 7 入口组里的成员主机出现；主机 70 在同一个组里但成员被停用，不算。
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (60, '入口组成员', '127.0.0.60', 'slave', 'tok60', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (70, '停用成员', '127.0.0.70', 'slave', 'tok70', 2)");
    await exec("INSERT INTO forward_groups (id, name, groupMode, targetIp, userId) VALUES (5, '入口组', 'entry', '127.0.0.1', 2)");
    await exec("INSERT INTO forward_group_members (groupId, memberType, hostId, isEnabled) VALUES (5, 'host', 60, 1)");
    await exec("INSERT INTO forward_group_members (groupId, memberType, hostId, isEnabled) VALUES (5, 'host', 70, 0)");
    await exec("INSERT INTO tunnels (id, name, entryHostId, entryGroupId, exitHostId, listenPort, userId) VALUES (7, '入口组隧道', 10, 5, 20, 9002, 2)");

    const rule = (id, hostId, extra = {}) => exec(
      "INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId, isEnabled, pendingDelete) VALUES (?, ?, ?, ?, '127.0.0.1', 8080, 2, ?, ?)",
      [id, hostId, "rule" + id, 10000 + id, extra.disabled ? 0 : 1, extra.pendingDelete ? 1 : 0],
    );
    await rule(101, 10);
    await rule(301, 30);
    await rule(302, 30, { disabled: true }); // 停用的也算「挂在这台上」
    await rule(303, 30, { pendingDelete: true }); // 删了、等 Agent 确认的不算

    // 仓库层：一次 GROUP BY 查整页。
    const ruleCounts = await rules.countForwardRulesByHostIds([10, 20, 30, 40]);
    assert.deepEqual([...ruleCounts].sort((a, b) => a[0] - b[0]), [[10, 1], [30, 2]], "没有转发的主机不出现，停用的照样算，待删除的不算");
    const tunnelCounts = await tunnels.countTunnelsByHostIds([10, 20, 30, 40, 50, 60, 70]);
    assert.deepEqual(
      [...tunnelCounts].sort((a, b) => a[0] - b[0]),
      [[10, 3], [20, 2], [30, 1], [40, 1], [50, 1], [60, 1]],
      "入口 / 出口 / 任一跳 / 额外出口 / 入口组启用成员都算；同一条隧道只算一次；停用的组成员不算",
    );
    assert.equal((await tunnels.countTunnelsByHostIds([])).size, 0);
    assert.equal((await rules.countForwardRulesByHostIds([])).size, 0);

    // 路由层：每一行都带 ruleCount / tunnelCount，没有的是 0 而不是 undefined。
    const pageFor = async (user) => {
      const page = await callerFor(user).listPage({ cursor: 0, limit: 50 });
      return new Map(page.items.map((item) => [Number(item.id), item]));
    };
    let rows = await pageFor(admin);
    assert.equal(rows.size, 7);
    assert.deepEqual(
      [...rows.values()].map((row) => [Number(row.id), row.ruleCount, row.tunnelCount]).sort((a, b) => a[0] - b[0]),
      [[10, 1, 3], [20, 0, 2], [30, 2, 1], [40, 0, 1], [50, 0, 1], [60, 0, 1], [70, 0, 0]],
    );
    assert.equal(rows.get(30).ruleCount, 2, "两条转发（含一条停用的）");
    assert.equal(rows.get(30).tunnelCount, 1, "只作为中转跳出现在一条隧道里");

    // 租户看自己的机器，数字一样 —— 只是个数，不透露别人的东西。
    rows = await pageFor(tenant);
    assert.equal(rows.get(30).ruleCount, 2);
    assert.equal(rows.get(30).tunnelCount, 1);
    assert.equal(rows.get(10).tunnelCount, 3);

    console.log("HOST_COUNTS_OK");
  `, { name: "host-counts", env: { NODE_ENV: "test" } });
});
