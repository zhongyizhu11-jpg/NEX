import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/**
 * 节点分享：把我的某几个节点放进别人的订阅，所有权不变。
 *
 * 与「归属用户」的分工是这一组用例要守住的东西 —— 归属是整份转给对方，
 * 分享是同一份同时出现在两个人的订阅里。
 */
const setup = String.raw`
    const repo = await import(url("server/repositories/proxySubscriptionRepository.ts"));


    // alice 是节点主人，bob 只租节点。
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'admin', 1)");
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'bob', 'hash', 'user', 1)");

    const makeNode = async (userId, name, port, extra = {}) => Number(await repo.createProxyNode({
      userId, name, protocol: "vless", address: "1.2.3.4", port,
      uuid: "11111111-2222-3333-4444-555555555555", transport: "tcp", tls: true,
      isEnabled: true, ...extra,
    }));
`;

function runInDatabase(body: string) {
  runSharedDatabaseTest(body, { name: "node-share", setup });
}

test("分享给谁，谁的订阅里就有这个节点", () => {
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeSharesForUser(2, [nodeId]);

    const plan = await repo.buildProxySubscriptionPlanForUser(2);
    const entries = plan.entries.filter((entry) => entry.templateId === nodeId);
    assert.equal(entries.length, 1, "bob 的订阅里应当有这个节点");
    assert.equal(entries[0].kind, "direct", "bob 名下没有绑它的转发，只能是直连");
  `);
});

test("主人自己没开直连，分享给别人照样能连", () => {
  /**
   * includeDirect 默认是关的：落地 IP 进订阅，被墙就要重搭。但分享的整个意思
   * 就是让对方连这个落地 —— 不强制打开的话，界面显示已分享，对方订阅里却什么
   * 都没有，而且看不出少了哪一步。
   */
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443, { includeDirect: false });
    await repo.setProxyNodeSharesForUser(2, [nodeId]);

    const mine = await repo.buildProxySubscriptionPlanForUser(1);
    assert.equal(mine.entries.filter((e) => e.templateId === nodeId).length, 0, "主人自己没开直连，他的订阅里就不该有");

    const theirs = await repo.buildProxySubscriptionPlanForUser(2);
    assert.equal(theirs.entries.filter((e) => e.templateId === nodeId).length, 1, "分享给对方的那一份要能连");
  `);
});

test("分享不转让所有权", () => {
  // 归属用户是把整份转给对方；分享之后节点仍然记在主人名下，流量也还是主人的。
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeSharesForUser(2, [nodeId]);
    const rows = await query("SELECT userId FROM proxy_nodes WHERE id = ?", [nodeId]);
    assert.equal(Number(rows[0].userId), 1);
    const owned = await repo.getProxyNodesByUser(2);
    assert.equal(owned.length, 0, "分享来的节点不算 bob 名下的");
  `);
});

test("分享带着的前置代理引用会被断掉", () => {
  /**
   * frontProxyId 指向主人自己的另一行。id 全表自增，收方名下恰好有同号节点时，
   * 引用就落到别人的机器上了。
   */
  runInDatabase(String.raw`
    const frontId = await makeNode(1, "前置", 8443, { includeDirect: true });
    const nodeId = await makeNode(1, "HK-01", 443, { frontProxyId: frontId });
    await repo.setProxyNodeSharesForUser(2, [nodeId]);

    const plan = await repo.buildProxySubscriptionPlanForUser(2);
    const entry = plan.entries.find((e) => e.templateId === nodeId);
    assert.ok(entry, "节点本身要在");
    assert.equal(entry.frontTemplateId, 0, "分享出去的那一份不该挂前置代理");
    assert.equal(plan.entries.filter((e) => e.templateId === frontId).length, 0, "没分享的前置节点不该跟着漏过去");
  `);
});

test("自己的节点分享给自己是空操作", () => {
  // 落进来的话对方订阅里会出现两条一模一样的线路。
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443, { includeDirect: true });
    await repo.setProxyNodeSharesForUser(1, [nodeId]);
    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(1), []);

    const plan = await repo.buildProxySubscriptionPlanForUser(1);
    assert.equal(plan.entries.filter((e) => e.templateId === nodeId).length, 1, "只该有一条");
  `);
});

test("重新设置是全量替换", () => {
  runInDatabase(String.raw`
    const a = await makeNode(1, "HK-01", 443);
    const b = await makeNode(1, "HK-02", 444);
    await repo.setProxyNodeSharesForUser(2, [a, b]);
    assert.equal((await repo.getProxyNodeIdsSharedToUser(2)).length, 2);

    await repo.setProxyNodeSharesForUser(2, [b]);
    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(2), [b]);
  `);
});

test("从节点这边选人，和从用户那边选节点是同一件事", () => {
  // 两个入口写的是同一张表，从哪边设都得能从另一边读出来。
  runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (3, 'carol', 'hash', 'user', 1)");
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeShareUsers(nodeId, [2, 3]);
    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(2), [nodeId]);
    assert.deepEqual(await repo.getProxyNodeShareRecipients(nodeId), [2, 3]);

    await repo.setProxyNodeShareUsers(nodeId, [3]);
    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(2), [], "去掉的人要真的拿不到");
    assert.deepEqual(await repo.getProxyNodeShareRecipients(nodeId), [3]);
  `);
});

test("从节点这边也不会把节点分享给它自己的主人", () => {
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeShareUsers(nodeId, [1, 2]);
    assert.deepEqual(await repo.getProxyNodeShareRecipients(nodeId), [2]);
  `);
});

test("两个入口互不覆盖：一个节点分给多人，改其中一人不影响另一人", () => {
  /**
   * setProxyNodeSharesForUser 按用户全量替换，setProxyNodeShareUsers 按节点全量替换。
   * 两个「全量」的范围不一样，搞混的话从用户那边保存一次会把别人的分享清掉。
   */
  runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (3, 'carol', 'hash', 'user', 1)");
    const a = await makeNode(1, "HK-01", 443);
    const b = await makeNode(1, "HK-02", 444);
    await repo.setProxyNodeShareUsers(a, [2, 3]);

    // 在 bob 的权限页里把他的节点改成只有 b。
    await repo.setProxyNodeSharesForUser(2, [b]);

    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(2), [b]);
    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(3), [a], "carol 的分享不该被 bob 那次保存带走");
  `);
});

test("节点删掉，分享记录跟着删", () => {
  /**
   * 留着的话对方订阅指向一个不存在的节点 id，而管理端还显示「已分享给 1 人」——
   * 从界面上看不出人已经拿不到了。
   */
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeSharesForUser(2, [nodeId]);
    await repo.deleteProxyNode(nodeId);
    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(2), []);
    const plan = await repo.buildProxySubscriptionPlanForUser(2);
    assert.equal(plan.entries.length, 0);
  `);
});

test("停用的节点不会分享进别人的订阅", () => {
  // 主人停用就是「这台先别用了」，对收方也得成立。
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443, { isEnabled: false });
    await repo.setProxyNodeSharesForUser(2, [nodeId]);
    const plan = await repo.buildProxySubscriptionPlanForUser(2);
    assert.equal(plan.entries.length, 0);
  `);
});

test("订阅文档与订阅计划取的是同一批节点", () => {
  /**
   * 两处一旦用了不同的模板集合，订阅里会出现「策略组里有名字、节点列表里没有
   * 这个节点」这种坏配置 —— Clash 会拒绝整份配置，报的是「订阅导入失败」。
   */
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeSharesForUser(2, [nodeId]);
    const doc = await repo.getProxySubscriptionDocumentForUser(2);
    assert.equal(doc.nodes.length, 1, "文档里要有这个分享来的节点");
    assert.equal(doc.nodes[0].address, "1.2.3.4");
  `);
});

test("多个人可以拿到同一个节点", () => {
  // 只租一两个落地、不值得为每人单开端口时就是这么用的。
  runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (3, 'carol', 'hash', 'user', 1)");
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeSharesForUser(2, [nodeId]);
    await repo.setProxyNodeSharesForUser(3, [nodeId]);
    assert.deepEqual(await repo.getProxyNodeShareRecipients(nodeId), [2, 3]);
    for (const userId of [2, 3]) {
      const plan = await repo.buildProxySubscriptionPlanForUser(userId);
      assert.equal(plan.entries.length, 1, "两个人都该拿到");
    }
  `);
});

test("挑到他自己的节点：不写进去，但要报上来，不能笼统说「已保存」", () => {
  runInDatabase(String.raw`
    const own = await makeNode(2, "bob 自己的", 443);
    const other = await makeNode(1, "alice 的", 8443);

    const result = await repo.setProxyNodeSharesForUser(2, [own, other]);
    // 自己的节点本来就在他订阅里，再分享一遍客户端里会出现两条一模一样的线路。
    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(2), [other]);
    // 关键是这一条：原来这里是静默丢弃，管理员只能等租户来说「我这儿没有」才发现。
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].nodeId, own);
    assert.equal(result.skipped[0].reason, "self");
  `);
});

test("节点已经被删了：同样要报上来", () => {
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.deleteProxyNode(nodeId);
    const result = await repo.setProxyNodeSharesForUser(2, [nodeId]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, "missing");
  `);
});

test("全部生效时不报任何「没生效」", () => {
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    const result = await repo.setProxyNodeSharesForUser(2, [nodeId]);
    assert.deepEqual(result.skipped, []);
  `);
});
