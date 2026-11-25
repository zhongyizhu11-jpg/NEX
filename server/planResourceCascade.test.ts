import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 删掉一个资源，套餐里绑着它的那一行也要跟着走。
 *
 * 套餐能绑四种资源：主机、隧道、转发组、落地节点。**只有主机**在删除时会去清
 * 套餐里的绑定，另外三种都把行留在原地。
 *
 * 留下来的是一条指向不存在资源的授权，而三个地方都会照着它说话：
 *
 *   - 商店页上的「本套餐含 3 个落地节点」多算一个，客户买完只拿到 2 个。
 *   - 管理端的套餐编辑里显示成「节点 #7」这样一个只有编号的空壳。
 *   - 授权计算照样把这个 id 发出去，落到订阅里就是一条连不上的线路。
 *
 * 四种一起测，就是为了盯住「以后新增第五种资源时别再漏」。
 */
test("SQLite 删除主机/隧道/转发组/落地节点时，套餐里的绑定一起清掉", () => {
  runInDatabase(String.raw`
    const hostRepo = await import(url("server/repositories/hostRepository.ts"));
    const tunnelRepo = await import(url("server/repositories/tunnelRepository.ts"));
    const groupRepo = await import(url("server/repositories/forwardGroupRepository.ts"));
    const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec('INSERT INTO hosts (id, name, ip, "agentToken", "userId") VALUES (10, \'入口\', \'203.0.113.1\', \'t1\', 1)');
    await exec('INSERT INTO hosts (id, name, ip, "agentToken", "userId") VALUES (11, \'出口\', \'203.0.113.2\', \'t2\', 1)');
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", "listenPort", "userId") VALUES (20, \'隧道\', 10, 11, 9000, 1)');
    await exec('INSERT INTO forward_groups (id, name, "targetIp", "userId") VALUES (30, \'转发组\', \'198.51.100.9\', 1)');
    const nodeId = Number(await subs.createProxyNode({
      userId: 1, name: "落地节点", protocol: "vless", address: "198.51.100.5", port: 443,
      uuid: "11111111-2222-3333-4444-555555555555", transport: "tcp", tls: true, isEnabled: true,
    }));

    await exec("INSERT INTO subscription_plans (id, name) VALUES (1, '套餐')");
    await exec('INSERT INTO subscription_plan_hosts ("planId", "hostId") VALUES (1, 11)');
    await exec('INSERT INTO subscription_plan_tunnels ("planId", "tunnelId") VALUES (1, 20)');
    await exec('INSERT INTO subscription_plan_forward_groups ("planId", "forwardGroupId") VALUES (1, 30)');
    await exec('INSERT INTO subscription_plan_proxy_nodes ("planId", "nodeId") VALUES (1, ?)', [nodeId]);

    const bound = async () => ({
      hosts: (await query('SELECT "hostId" FROM subscription_plan_hosts')).map((row) => Number(row.hostId)),
      tunnels: (await query('SELECT "tunnelId" FROM subscription_plan_tunnels')).map((row) => Number(row.tunnelId)),
      groups: (await query('SELECT "forwardGroupId" FROM subscription_plan_forward_groups')).map((row) => Number(row.forwardGroupId)),
      nodes: (await query('SELECT "nodeId" FROM subscription_plan_proxy_nodes')).map((row) => Number(row.nodeId)),
    });

    assert.deepEqual(await bound(), { hosts: [11], tunnels: [20], groups: [30], nodes: [nodeId] });

    await tunnelRepo.deleteTunnel(20);
    await groupRepo.deleteForwardGroup(30);
    await subs.deleteProxyNode(nodeId);
    await hostRepo.deleteHost(11);

    const after = await bound();
    assert.deepEqual(after.hosts, [], "主机：套餐里还绑着一台已经删掉的机器");
    assert.deepEqual(after.tunnels, [], "隧道：套餐里还绑着一条已经删掉的隧道");
    assert.deepEqual(after.groups, [], "转发组：套餐里还绑着一个已经删掉的转发组");
    assert.deepEqual(after.nodes, [], "落地节点：套餐里还绑着一个已经删掉的节点，商店会多算一个、编辑里是个只有编号的空壳");

    /** 别的套餐绑的同类资源不能被顺手删掉。 */
    await exec("INSERT INTO subscription_plans (id, name) VALUES (2, '另一个套餐')");
    await exec('INSERT INTO subscription_plan_hosts ("planId", "hostId") VALUES (2, 10)');
    const otherNode = Number(await subs.createProxyNode({
      userId: 1, name: "另一个节点", protocol: "vless", address: "198.51.100.6", port: 443,
      uuid: "11111111-2222-3333-4444-555555555556", transport: "tcp", tls: true, isEnabled: true,
    }));
    await exec('INSERT INTO subscription_plan_proxy_nodes ("planId", "nodeId") VALUES (2, ?)', [otherNode]);
    const doomed = Number(await subs.createProxyNode({
      userId: 1, name: "要删的", protocol: "vless", address: "198.51.100.7", port: 443,
      uuid: "11111111-2222-3333-4444-555555555557", transport: "tcp", tls: true, isEnabled: true,
    }));
    await exec('INSERT INTO subscription_plan_proxy_nodes ("planId", "nodeId") VALUES (2, ?)', [doomed]);
    await subs.deleteProxyNode(doomed);
    assert.deepEqual(
      (await bound()).nodes,
      [otherNode],
      "只该删掉被删那个节点的绑定，同一个套餐里别的节点不能被带走",
    );

    /**
     * 删掉一个落地端口，它上面发出去的凭据也要删干净。
     *
     * 这张表存的是 uuid / password 本身。端口没了，凭据留着既连不上任何东西，
     * 也再没有任何一条路会清它 —— 派生节点跟着入站走，分享记录跟着节点走，
     * 唯独这一层谁都不管。管理员在弹窗里加的那些（sharedUserId = 0）尤其彻底：
     * 删完端口就成了永远不会被回收的凭据。
     */
    const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));
    const inboundId = Number(await inbounds.createProxyInbound({
      userId: 1, hostId: 10, name: "落地端口", protocol: "vless", port: 24443,
      transport: "tcp", security: "reality", isEnabled: true,
    }));
    await inbounds.replaceProxyInboundUsers(inboundId, [
      { name: "管理员加的", uuid: "aaaaaaaa-0000-0000-0000-000000000000" },
    ]);
    await exec(
      'INSERT INTO proxy_inbound_users ("inboundId", name, uuid, "sharedUserId") VALUES (?, ?, ?, ?)',
      [inboundId, "发给租户的", "bbbbbbbb-0000-0000-0000-000000000000", 1],
    );
    assert.equal(
      Number((await query('SELECT COUNT(*) AS c FROM proxy_inbound_users WHERE "inboundId" = ?', [inboundId]))[0].c),
      2,
    );

    await inbounds.deleteProxyInbound(inboundId);
    assert.equal(
      Number((await query('SELECT COUNT(*) AS c FROM proxy_inbound_users WHERE "inboundId" = ?', [inboundId]))[0].c),
      0,
      "端口删了，它上面那几份凭据还留在库里 —— 连不上任何东西，也再没有任何一条路会清它",
    );

    /**
     * 删主机时，按规则记的那份流量计数也要删。
     *
     * 整机计数、流量明细、分桶统计都清了，唯独这一张漏了 —— 而它是四张里唯一
     * 没有按时间清理的：明细和分桶有 72 小时保留期兜底，这张是累计计数，没有
     * 时间戳可扫，只能靠删。
     *
     * 留着不是多几行垃圾：重算用户总流量时直接 SUM 这张表、不 join
     * forward_rules，于是一台已经删掉的机器跑过的量永远算在这个租户头上，而
     * 管理员再也清不掉 —— 「重置这条转发的流量」要按规则 id，规则已经没了。
     */
    await exec("INSERT INTO users (id, username, password, role) VALUES (9, '租户', 'hash', 'user')");
    await exec('INSERT INTO hosts (id, name, ip, "agentToken", "userId") VALUES (90, \'要删的机器\', \'203.0.113.90\', \'t90\', 9)');
    await exec('INSERT INTO hosts (id, name, ip, "agentToken", "userId") VALUES (91, \'留着的机器\', \'203.0.113.91\', \'t91\', 9)');
    const GB = 1024 ** 3;
    await exec(
      'INSERT INTO forward_rule_traffic_counters ("ruleId", "hostId", "userId", "bytesIn", "bytesOut", connections)'
        + ' VALUES (?, ?, ?, ?, ?, ?)',
      [900, 90, 9, 50 * GB, 50 * GB, 10],
    );
    await exec(
      'INSERT INTO forward_rule_traffic_counters ("ruleId", "hostId", "userId", "bytesIn", "bytesOut", connections)'
        + ' VALUES (?, ?, ?, ?, ?, ?)',
      [901, 91, 9, 7 * GB, 3 * GB, 2],
    );

    /** 重算用户总量走的就是这条 SUM（不 join 规则表）。 */
    const summedGb = async () => {
      const row = (await query(
        'SELECT COALESCE(SUM("bytesIn"), 0) + COALESCE(SUM("bytesOut"), 0) AS total'
          + ' FROM forward_rule_traffic_counters WHERE "userId" = ?',
        [9],
      ))[0];
      return Math.round(Number(row.total) / GB);
    };
    assert.equal(await summedGb(), 110);

    await hostRepo.deleteHost(90);
    assert.equal(
      await summedGb(),
      10,
      "机器删了，它跑过的 100G 还算在这个租户头上 —— 而规则已经没了，管理员再也清不掉",
    );
    assert.equal(
      Number((await query('SELECT COUNT(*) AS c FROM forward_rule_traffic_counters WHERE "hostId" = 91'))[0].c),
      1,
      "另一台机器的计数不能被顺手删掉",
    );

    /**
     * 清套餐绑定这一下是静悄悄的：管理员删的是一个节点，被改掉的是几个在卖的
     * 套餐 —— 商店页上的数量当场就变了。删除接口要把这个数交出来，和「解绑了
     * 几条转发」一样说给人听。
     */
    const soldNode = Number(await subs.createProxyNode({
      userId: 1, name: "在卖的节点", protocol: "vless", address: "198.51.100.8", port: 443,
      uuid: "11111111-2222-3333-4444-555555555558", transport: "tcp", tls: true, isEnabled: true,
    }));
    await exec("INSERT INTO subscription_plans (id, name) VALUES (3, '套餐三')");
    await exec('INSERT INTO subscription_plan_proxy_nodes ("planId", "nodeId") VALUES (1, ?)', [soldNode]);
    await exec('INSERT INTO subscription_plan_proxy_nodes ("planId", "nodeId") VALUES (3, ?)', [soldNode]);
    assert.equal(
      await subs.countPlansUsingProxyNode(soldNode),
      2,
      "要能数出有几个套餐在卖这个节点，否则删除时没法告诉管理员改了什么",
    );
    await subs.deleteProxyNode(soldNode);
    assert.equal(await subs.countPlansUsingProxyNode(soldNode), 0);
  `, { name: "plan-cascade" });
});
