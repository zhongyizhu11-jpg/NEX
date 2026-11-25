import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 「不同步已有订阅者」必须把节点也算在内。
 *
 * 管理员改套餐时可以勾掉那个开关，面板会把套餐当时的内容冻进订阅行的快照。
 * 主机、隧道、转发组一直认这份快照 —— **只有落地节点不在里面**，它跟着套餐
 * 当前内容走。
 *
 * 后果最难发现：老客户身上随便发生一件小事（充值、流量重置、权益重算）就会
 * 触发一次同步，把他买的时候送的那个节点悄悄收走，落地机上那份凭据一并删掉。
 * 管理员明明说了「不要动老客户」，而面板上没有任何一处提到这件事。
 *
 * 三件事一起盯：冻过的照老套餐留着、没冻过的仍按当前套餐算（不能因为这个改动
 * 就再也收不回节点了）、老快照里没有这一列时退回改动前的行为。
 */
test("SQLite 冻结快照的订阅者保住套餐当时带的节点，没冻的照常跟着套餐走", () => {
  runInDatabase(String.raw`
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));

    await exec("INSERT INTO users (id, username, password, role, accountEnabled, allowProxySubscription) VALUES (1, 'owner', 'h', 'admin', 1, 1)");
    for (const [id, name] of [[2, "老客户"], [3, "新客户"]]) {
      await exec(
        "INSERT INTO users (id, username, password, role, accountEnabled, allowProxySubscription) VALUES (?, ?, 'h', 'user', 1, 1)",
        [id, name],
      );
    }

    const makeNode = async (name, address) => Number(await subs.createProxyNode({
      userId: 1, name, protocol: "vless", address, port: 443,
      uuid: "11111111-2222-3333-4444-555555555555", transport: "tcp", tls: true, isEnabled: true,
    }));
    const nodeA = await makeNode("节点A", "198.51.100.1");
    const nodeB = await makeNode("节点B", "198.51.100.2");

    const plan = await billing.createSubscriptionPlan(
      { name: "套餐", priceCents: 100, durationDays: 30, isActive: true, allowProxySubscription: true },
      [], [], [], [], [nodeA, nodeB], [],
    );
    const planId = Number(plan.id);
    const nowSec = Math.floor(Date.now() / 1000);
    const subscribe = async (id, userId) => {
      await exec(
        'INSERT INTO user_subscriptions (id, "userId", "planId", status, "startedAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?)',
        [id, userId, planId, "active", nowSec, nowSec + 30 * 86400],
      );
      await billing.syncUserSubscriptionEntitlements(userId);
    };
    await subscribe(1, 2);
    await subscribe(2, 3);

    const nodesOf = async (userId) => (await query(
      'SELECT "nodeId" FROM proxy_node_shares WHERE "userId" = ? ORDER BY "nodeId"',
      [userId],
    )).map((row) => Number(row.nodeId));

    assert.deepEqual(await nodesOf(2), [nodeA, nodeB]);
    assert.deepEqual(await nodesOf(3), [nodeA, nodeB]);

    /** 管理员勾掉「同步已有订阅者」：只冻老客户那一条。 */
    await exec('UPDATE user_subscriptions SET "planSnapshot" = NULL WHERE id = 2');
    await billing.freezePlanSubscriberSnapshots(planId);
    const frozen = JSON.parse((await query('SELECT "planSnapshot" FROM user_subscriptions WHERE id = 1'))[0].planSnapshot);
    assert.deepEqual(
      frozen.proxyNodeIds,
      [nodeA, nodeB],
      "快照里没记节点 —— 冻结就只兑现了一半，节点仍会跟着套餐当前内容被收走",
    );

    /** 然后把节点 A 从套餐里去掉：新客户不再送 A。 */
    await exec('DELETE FROM subscription_plan_proxy_nodes WHERE "planId" = ? AND "nodeId" = ?', [planId, nodeA]);

    /** 老客户身上发生任何一件小事都会走一次权益重算。 */
    await billing.syncUserSubscriptionEntitlements(2);
    assert.deepEqual(
      await nodesOf(2),
      [nodeA, nodeB],
      "管理员说了不要动老客户，面板还是把他买时送的节点收走了",
    );

    /**
     * 没冻过的那一条必须照常跟着套餐走 —— 否则这个改动等于让节点再也收不回来，
     * 「到期/降级自动收回」会连带失效。
     */
    await exec('UPDATE user_subscriptions SET "planSnapshot" = NULL WHERE id = 2');
    await billing.syncUserSubscriptionEntitlements(3);
    assert.deepEqual(await nodesOf(3), [nodeB], "没冻快照的订阅者该跟着套餐当前内容走");

    /**
     * 老快照里没有 proxyNodeIds 这一列（这一列是后加的）：必须退回改动前的行为，
     * 也就是按套餐当前内容算。默认成空数组会把所有老订阅者的节点一次性收光。
     */
    const legacy = { ...frozen };
    delete legacy.proxyNodeIds;
    await exec('UPDATE user_subscriptions SET "planSnapshot" = ? WHERE id = 1', [JSON.stringify(legacy)]);
    await billing.syncUserSubscriptionEntitlements(2);
    assert.deepEqual(
      await nodesOf(2),
      [nodeB],
      "老快照没有这一列时要退回按套餐当前内容算，不能当成「一个节点都没有」",
    );
  `, { name: "plan-snapshot-nodes" });
});
