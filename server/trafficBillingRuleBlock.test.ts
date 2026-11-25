import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("a balance shortfall stops only traffic-billed rules for users with other forwarding access", () => {
  runInDatabase(String.raw`
    const trafficBilling = await import(url("server/repositories/trafficBillingRepository.ts"));
    const block = await import(url("server/trafficBillingRuleBlock.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => exec(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const rule = async (id) => (await query(
      'SELECT "isEnabled", "disabledByUser", "protocolBlockReason" FROM "forward_rules" WHERE "id" = ?',
      [id],
    ))[0];
    const user = async (id) => (await query(
      'SELECT "canAddRules", "forwardAccessPauseReason" FROM "users" WHERE "id" = ?',
      [id],
    ))[0];
    const bool = (value) => value === true || value === 1 || value === "1";
    const REASON = block.TRAFFIC_BILLING_BALANCE_BLOCK_REASON;

    await trafficBilling.setTrafficBillingEnabled(true);
    const userColumns = ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "allowForwardXTunnel", "accountEnabled", "balanceCents"];
    await insert("users", userColumns, [1, "admin", "x", "admin", 1, 1, 1, 1, 0]);
    // 有手动转发权限、同时用了按流量计费的主机。
    await insert("users", userColumns, [2, "planned", "x", "user", 1, 1, 1, 1, 0]);
    // 转发权限完全来自流量计费。
    await insert("users", userColumns, [3, "billing-only", "x", "user", 1, 0, 1, 1, 0]);
    for (const [id, name, ownerId] of [[1, "own-host", 2], [3, "billed-host", 1]]) {
      await insert("hosts", ["id", "name", "ip", "userId", "portRangeStart", "portRangeEnd"], [id, name, "198.51.100." + id, ownerId, 10000, 30000]);
    }
    await insert("traffic_billing_configs", ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"], [30, "host", 3, 1, 0, 1, 100]);

    const columns = ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"];
    await insert("forward_rules", columns, [100, 3, "billed-rule", "iptables", "tcp", 11000, "203.0.113.1", 80, 2, 1, 1]);
    await insert("forward_rules", columns, [101, 1, "own-host-rule", "iptables", "tcp", 11001, "203.0.113.2", 80, 2, 1, 1]);
    await insert("forward_rules", columns, [102, 1, "manually-off-own-rule", "iptables", "tcp", 11002, "203.0.113.3", 80, 2, 0, 0]);
    await insert("forward_rules", columns, [200, 3, "billing-only-rule", "iptables", "tcp", 12000, "203.0.113.4", 80, 3, 1, 1]);

    // 1) 有别的转发权限：只停计费主机上的规则，账户不暂停。
    const shortfall = await block.handleTrafficBillingShortfall(2, "test");
    assert.equal(shortfall.accountPaused, false);
    assert.deepEqual(shortfall.stoppedRuleIds, [100]);
    assert.equal(bool((await rule(100)).isEnabled), false);
    assert.equal((await rule(100)).protocolBlockReason, REASON);
    assert.equal(bool((await rule(101)).isEnabled), true, "a rule on the user's own host must keep running");
    assert.equal(bool((await rule(102)).isEnabled), false, "a manually stopped rule stays as it was");
    assert.equal((await rule(102)).protocolBlockReason, null, "a manually stopped non-billed rule gets no billing marker");
    assert.equal(bool((await user(2)).canAddRules), true);
    assert.equal((await user(2)).forwardAccessPauseReason, null);

    // 再来一次是空操作。
    assert.deepEqual((await block.handleTrafficBillingShortfall(2, "test")).stoppedRuleIds, []);

    // 2) 没余额时恢复不动它；充值后自动恢复。
    assert.deepEqual(await block.resumeTrafficBillingRulesForUser(2), []);
    assert.equal(bool((await rule(100)).isEnabled), false);
    await exec('UPDATE "users" SET "balanceCents" = 500 WHERE "id" = 2');
    assert.deepEqual(await block.reconcileTrafficBillingRuleBlocksForAllUsers(), 1);
    assert.equal(bool((await rule(100)).isEnabled), true, "a billed rule must resume after a top-up");
    assert.equal((await rule(100)).protocolBlockReason, null);

    // 3) 纯计费用户：没余额就没有转发权限，和以前一样整户暂停。
    const billingOnly = await block.handleTrafficBillingShortfall(3, "test");
    assert.equal(billingOnly.accountPaused, true);
    assert.equal((await user(3)).forwardAccessPauseReason, "traffic_billing_balance");
    assert.equal(bool((await rule(200)).isEnabled), false);

    // 4) 管理员不受影响。
    await insert("forward_rules", columns, [300, 3, "admin-billed-rule", "iptables", "tcp", 13000, "203.0.113.5", 80, 1, 1, 1]);
    assert.equal((await block.handleTrafficBillingShortfall(1, "test")).accountPaused, false);
    assert.equal(bool((await rule(300)).isEnabled), true);

    // 5) 旧版本把有权限的人整户暂停了：自愈扫描撤掉暂停，自有机器上的规则回来，计费规则继续停着。
    await exec('UPDATE "users" SET "balanceCents" = 0, "canAddRules" = 0, "forwardAccessPauseReason" = ? WHERE "id" = 2', ["traffic_billing_balance"]);
    await exec('UPDATE "forward_rules" SET "isEnabled" = 0, "disabledByUser" = 1 WHERE "id" IN (100, 101)');
    await block.reconcileTrafficBillingRuleBlocksForAllUsers();
    assert.equal((await user(2)).forwardAccessPauseReason, null, "a legacy whole-account balance pause must be lifted");
    assert.equal(bool((await user(2)).canAddRules), true);
    assert.equal(bool((await rule(101)).isEnabled), true, "the own-host rule must come back");
    assert.equal(bool((await rule(100)).isEnabled), false, "the billed rule must stay stopped without balance");
    assert.equal((await rule(100)).protocolBlockReason, REASON);
  `, { name: "billing-rule-block" });
});
