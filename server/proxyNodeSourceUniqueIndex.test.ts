import test from "node:test";

import { runInDatabase } from "./testing/runInDatabase";

/*
  proxy_nodes (sourceId, sourceKey) 唯一索引与去重回填（server/dbSchema.ts）。

  模拟老库：先建好表，把索引删掉，塞进串行化之前并发同步留下的重复行（有的还挂着转发规则、分享、
  套餐绑定），再跑一次 ensureDatabaseSchema —— 每个身份只剩 id 最小的一行、绑定都改指到它、索引建起来，
  手工节点（sourceKey 为 NULL）一个不少。
*/

const SEED = String.raw`
  const kind = runtime.getDatabaseKind();
  const INDEX = schema.PROXY_NODE_SOURCE_UNIQUE_INDEX;
  await exec('DROP INDEX "' + INDEX + '"');
  await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'owner', 'x', 'admin'), (2, 'u2', 'x', 'user'), (3, 'u3', 'x', 'user'), (4, 'u4', 'x', 'user')");
  const node = (id, sourceId, sourceKey) => exec(
    "INSERT INTO proxy_nodes (id, userId, name, address, port, sourceId, sourceKey) VALUES (?, 1, ?, 'example.com', 443, ?, ?)",
    [id, "node-" + id, sourceId, sourceKey],
  );
  // 来源 5 的身份 A 有三行（10 留下，11 / 12 多出来的），身份 B 两行（20 留下，21 多出来的）
  await node(10, 5, "A"); await node(11, 5, "A"); await node(12, 5, "A");
  await node(20, 5, "B"); await node(21, 5, "B");
  // 手工节点：sourceId 0、sourceKey NULL，两行都得留着
  await node(30, 0, null); await node(31, 0, null);
  // 另一个来源同样的身份键：不是重复
  await node(40, 6, "A");
  await exec("INSERT INTO hosts (id, name, ip, userId) VALUES (1, 'h', '198.51.100.1', 1)");
  await exec(
    "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, proxyNodeId) VALUES (101, 1, 'r1', 'iptables', 'tcp', 10001, '203.0.113.1', 80, 1, 11), (102, 1, 'r2', 'iptables', 'tcp', 10002, '203.0.113.1', 80, 1, 12), (103, 1, 'r3', 'iptables', 'tcp', 10003, '203.0.113.1', 80, 1, 21)",
  );
  // 分享：10 已经分享给 4；11 分享给 2 和 4（4 撞上，删）；12 分享给 2（和刚改过去的 11→2 撞上，删）和 3（改指向）
  await exec("INSERT INTO proxy_node_shares (nodeId, userId) VALUES (10, 4), (11, 2), (11, 4), (12, 2), (12, 3)");
  // 套餐绑定：套餐 1 绑 11 和 12（一条改指向、一条删），套餐 2 绑 12（改指向）
  await exec("INSERT INTO subscription_plans (id, name) VALUES (1, 'p1'), (2, 'p2')");
  await exec("INSERT INTO subscription_plan_proxy_nodes (planId, nodeId) VALUES (1, 11), (1, 12), (2, 12)");
  const ids = async (sql, params = []) => (await query(sql, params)).map((row) => Number(Object.values(row)[0])).sort((a, b) => a - b);
  const indexPresent = async () => {
    if (kind === "postgresql") {
      const rows = await runtime.queryRaw("SELECT indexdef FROM pg_indexes WHERE tablename = 'proxy_nodes' AND indexname = $1", [INDEX]);
      return rows.length === 1 && /CREATE UNIQUE INDEX/i.test(String(rows[0].indexdef));
    }
    const rows = await runtime.queryRaw("PRAGMA index_list('proxy_nodes')");
    return rows.some((row) => String(row.name) === INDEX && Number(row.unique) === 1);
  };
  assert.equal(await indexPresent(), false, "测试前提：索引已经删掉");
`;

test("老库里的重复节点：建索引前去重、绑定改指到保留行、手工节点不动", () => {
  runInDatabase(String.raw`
    ${SEED}
    await schema.ensureDatabaseSchema();

    assert.deepEqual(await ids("SELECT id FROM proxy_nodes"), [10, 20, 30, 31, 40]);
    assert.deepEqual(await ids("SELECT proxyNodeId FROM forward_rules WHERE id = 101"), [10]);
    assert.deepEqual(await ids("SELECT proxyNodeId FROM forward_rules WHERE id = 102"), [10]);
    assert.deepEqual(await ids("SELECT proxyNodeId FROM forward_rules WHERE id = 103"), [20]);
    assert.deepEqual(await ids("SELECT userId FROM proxy_node_shares WHERE nodeId = 10"), [2, 3, 4], "分享都到保留行上，撞键的只留一条");
    assert.deepEqual(await ids("SELECT id FROM proxy_node_shares WHERE nodeId IN (11, 12, 21)"), []);
    assert.deepEqual(await ids("SELECT planId FROM subscription_plan_proxy_nodes WHERE nodeId = 10"), [1, 2]);
    assert.deepEqual(await ids("SELECT id FROM subscription_plan_proxy_nodes WHERE nodeId IN (11, 12)"), []);
    assert.equal(await indexPresent(), true, "索引建起来了");

    // 有了索引：同一来源同一身份插不进去；手工节点（NULL）随便加；不同来源同样的键照常
    await assert.rejects(node(50, 5, "A"));
    await node(51, 0, null);
    await node(52, 7, "A");
    assert.deepEqual(await ids("SELECT id FROM proxy_nodes"), [10, 20, 30, 31, 40, 51, 52]);

    // 再跑一遍建表：没有重复行，什么都不动
    await schema.ensureDatabaseSchema();
    assert.deepEqual(await ids("SELECT id FROM proxy_nodes"), [10, 20, 30, 31, 40, 51, 52]);
    assert.equal(await indexPresent(), true);
  `, { name: "proxy-node-source-unique", quiet: true });
});

test("新库一开始就带着唯一索引", () => {
  runInDatabase(String.raw`
    const kind = runtime.getDatabaseKind();
    const INDEX = schema.PROXY_NODE_SOURCE_UNIQUE_INDEX;
    if (kind === "postgresql") {
      const rows = await runtime.queryRaw("SELECT indexdef FROM pg_indexes WHERE tablename = 'proxy_nodes' AND indexname = $1", [INDEX]);
      assert.equal(rows.length, 1);
      assert.match(String(rows[0].indexdef), /CREATE UNIQUE INDEX/i);
    } else {
      const rows = await runtime.queryRaw("PRAGMA index_list('proxy_nodes')");
      assert.ok(rows.some((row) => String(row.name) === INDEX && Number(row.unique) === 1), JSON.stringify(rows));
    }
  `, { name: "proxy-node-source-unique-fresh", quiet: true });
});
