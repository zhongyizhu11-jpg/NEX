import test from "node:test";

import { runInDatabase } from "./testing/runInDatabase";

/*
  到期处理按 200 个用户一批、游标向前（billingRepository.expireUserSubscriptions）：
  205 个到期订阅的用户跨过一批的边界，加油包到期的用户只走加油包那条路，没到期的一个不碰。
*/
test("到期处理跨批次：205 个到期订阅全部处理，加油包到期的也到，没到期的不碰", () => {
  runInDatabase(String.raw`
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const now = Math.floor(Date.now() / 1000);
    await exec("INSERT INTO subscription_plans (id, name, durationDays, portCount, trafficLimit, maxRules, maxConnections, maxIPs) VALUES (1, 'p', 30, 1, 0, 20, 2000, 10)");
    const users = [];
    const subs = [];
    // 1..205：到期；206..210：没到期；211：订阅没到期但加油包到期
    for (let id = 1; id <= 211; id += 1) users.push("(" + id + ", 'u" + id + "', 'x', 'user')");
    await exec("INSERT INTO users (id, username, password, role) VALUES " + users.join(", "));
    for (let id = 1; id <= 211; id += 1) {
      const expiresAt = id <= 205 ? now - 60 : now + 86400;
      subs.push("(" + id + ", " + id + ", 1, 'active', 'admin', " + (now - 86400) + ", " + expiresAt + ")");
    }
    await exec("INSERT INTO user_subscriptions (id, userId, planId, status, source, startedAt, expiresAt) VALUES " + subs.join(", "));
    await exec("INSERT INTO user_traffic_addons (id, userId, subscriptionId, planId, trafficBytes, status, expiresAt) VALUES (1, 211, 211, 1, 1024, 'active', ?), (2, 210, 210, 1, 1024, 'active', ?)", [now - 60, now + 86400]);
    await syncSequences();

    const expired = await billing.expireUserSubscriptions();
    assert.equal(expired, 205);
    const count = async (sql, params = []) => Number(Object.values((await query(sql, params))[0])[0]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM user_subscriptions WHERE status = 'expired'"), 205);
    assert.equal(await count("SELECT COUNT(*) AS n FROM user_subscriptions WHERE status = 'active'"), 6);
    assert.equal(await count("SELECT COUNT(*) AS n FROM user_subscriptions WHERE status = 'active' AND userId IN (206, 207, 208, 209, 210, 211)"), 6);
    assert.equal(await count("SELECT COUNT(*) AS n FROM user_traffic_addons WHERE id = 1 AND status = 'active'"), 0, "加油包到期的处理到了");
    assert.equal(await count("SELECT COUNT(*) AS n FROM user_traffic_addons WHERE id = 2 AND status = 'active'"), 1, "没到期的加油包不碰");
    // 再跑一遍：没有可处理的了
    assert.equal(await billing.expireUserSubscriptions(), 0);
  `, { name: "subscription-expiry-batch", quiet: true, timeoutMs: 300_000 });
});
