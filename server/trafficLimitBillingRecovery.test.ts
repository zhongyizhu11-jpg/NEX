import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 套餐流量用完之后，用户去计费资源上建 / 开规则。
 *
 * 以前：有一点余额 + 有计费资源，就会撤掉「超额」暂停，并恢复所有因超额停下的规则 ——
 * 包括不计费、吃套餐额度的规则。等于有一分钱余额就能把用完的套餐额度继续白跑。
 *
 * 现在：只放行这一次计费操作；超额暂停留着，套餐规则继续停到额度重置。
 */
test("套餐超额时计费操作只放行计费那一次，不恢复套餐规则", () => {
  runInDatabase(String.raw`
    const trafficBilling = await import(url("server/repositories/trafficBillingRepository.ts"));
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const GB = 1024 ** 3;
    await trafficBilling.setTrafficBillingEnabled(true);

    // 手动开的转发权限 + 100GB 额度，已经用满，账户因超额被停；余额 5 元。
    await exec(
      "INSERT INTO users (id, username, password, role, canAddRules, manualCanAddRules, manualTrafficLimit, trafficLimit, trafficUsed, balanceCents, accountEnabled, forwardAccessPauseReason) VALUES (2, 'u', 'h', 'user', 0, 1, ?, ?, ?, 500, 1, 'traffic_limit')",
      [100 * GB, 100 * GB, 100 * GB],
    );
    await exec("INSERT INTO hosts (id, name, ip, userId, portRangeStart, portRangeEnd) VALUES (1, 'plan-host', '198.51.100.1', 1, 10000, 30000)");
    await exec("INSERT INTO hosts (id, name, ip, userId, portRangeStart, portRangeEnd) VALUES (3, 'billed-host', '198.51.100.3', 1, 10000, 30000)");
    await exec("INSERT INTO traffic_billing_configs (id, resourceType, resourceId, enabled, requiresPermission, pricePerGbCents, multiplier) VALUES (30, 'host', 3, 1, 0, 1, 100)");
    const cols = "(id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, disabledByUser)";
    // 两条规则都在超额暂停时被停下（disabledByUser）。
    await exec("INSERT INTO forward_rules " + cols + " VALUES (100, 1, 'plan-rule', 'iptables', 'tcp', 11000, '203.0.113.1', 80, 2, 0, 0, 1)");
    await exec("INSERT INTO forward_rules " + cols + " VALUES (101, 3, 'billed-rule', 'iptables', 'tcp', 11001, '203.0.113.2', 80, 2, 0, 0, 1)");

    const result = await billing.ensureUserForwardAccessReady(2, { allowTrafficBillingRecovery: true });
    assert.equal(result.allowed, true, "计费操作本身要放行");
    assert.equal(result.restored, false);

    const user = (await query('SELECT "canAddRules", "forwardAccessPauseReason" FROM "users" WHERE "id" = 2'))[0];
    assert.equal(user.forwardAccessPauseReason, "traffic_limit", "超额暂停不能被计费操作撤掉");
    assert.equal(Number(user.canAddRules), 0);
    const rule = async (id) => (await query('SELECT "isEnabled", "disabledByUser" FROM "forward_rules" WHERE "id" = ?', [id]))[0];
    assert.equal(Number((await rule(100)).isEnabled), 0, "吃套餐额度的规则必须继续停着");
    assert.equal(Number((await rule(100)).disabledByUser), 1, "额度重置后由账户恢复那条路拉起");

    // 不走计费的操作照旧被拦。
    const blocked = await billing.ensureUserForwardAccessReady(2);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "traffic_limit");

    // 还没被暂停时（上报还没到）走计费操作：补上超额暂停，套餐规则停下。
    await exec('UPDATE "users" SET "canAddRules" = 1, "forwardAccessPauseReason" = NULL WHERE "id" = 2');
    await exec('UPDATE "forward_rules" SET "isEnabled" = 1, "disabledByUser" = 0 WHERE "id" = 100');
    const again = await billing.ensureUserForwardAccessReady(2, { allowTrafficBillingRecovery: true });
    assert.equal(again.allowed, true);
    assert.equal((await query('SELECT "forwardAccessPauseReason" FROM "users" WHERE "id" = 2'))[0].forwardAccessPauseReason, "traffic_limit");
    assert.equal(Number((await rule(100)).isEnabled), 0, "额度用完的套餐规则要停");

    // 额度重置后，账户恢复那条路把套餐规则拉回来。
    await exec('UPDATE "users" SET "trafficUsed" = 0 WHERE "id" = 2');
    const recovered = await billing.recoverUserForwardAccessIfEligible(2);
    assert.equal(recovered.allowed, true);
    assert.equal(Number((await rule(100)).isEnabled), 1, "额度重置后套餐规则恢复");
    console.log("LIMIT_OK");
  `, { name: "limit-billing", env: { NODE_ENV: "test" } });
});
