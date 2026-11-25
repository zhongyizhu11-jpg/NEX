import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("manual user traffic reset rebases billing display without changing billing ledgers", () => {
  runInDatabase(String.raw`
    const users = await import(url("server/repositories/userRepository.ts"));
    const commands = await import(url("server/services/userCommandService.ts"));

    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "trafficLimit", "trafficUsed", "balanceCents") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [7, "billing-admin", "hash", "admin", 1000, 800, 1234],
    );
    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "trafficBillingResetBytes") VALUES (?, ?, ?, ?, ?)',
      [8, "clamped-user", "hash", "user", 999],
    );
    await exec(
      'INSERT INTO "traffic_billing_usage" ("userId", "resourceType", "resourceId", "totalBytes", "billedGb") VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
      [7, "host", 11, 150, 1, 7, "tunnel", 22, 350, 2, 8, "host", 33, 10, 0],
    );
    await exec(
      'INSERT INTO "traffic_billing_rule_usage" ("userId", "ruleId", "resourceType", "resourceId", "totalBytes", "billedGb") VALUES (?, ?, ?, ?, ?, ?)',
      [7, 70, "host", 11, 150, 1],
    );
    await exec(
      'INSERT INTO "traffic_billing_records" ("userId", "ruleId", "resourceType", "resourceId", "bytes", "billedGb", "amountCents", "balanceAfterCents") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [7, 70, "host", 11, 150, 1, 25, 1234],
    );

    const initialPage = await users.getUsersPage({ page: 1, pageSize: 20 });
    const initialById = new Map(initialPage.items.map((user) => [Number(user.id), user]));
    assert.equal(Number(initialById.get(7)?.trafficBillingUsed), 500);
    assert.equal(Number(initialById.get(8)?.trafficBillingUsed), 0, "display usage must not go negative");
    assert.equal(Number((await users.getAllUsers()).find((user) => Number(user.id) === 7)?.trafficBillingUsed), 500);

    const ledgersBefore = {
      usage: await query('SELECT "userId", "resourceType", "resourceId", "totalBytes", "billedGb" FROM "traffic_billing_usage" WHERE "userId" = ? ORDER BY "resourceType", "resourceId"', [7]),
      ruleUsage: await query('SELECT "userId", "ruleId", "resourceType", "resourceId", "totalBytes", "billedGb" FROM "traffic_billing_rule_usage" WHERE "userId" = ?', [7]),
      records: await query('SELECT "userId", "ruleId", "resourceType", "resourceId", "bytes", "billedGb", "amountCents", "balanceAfterCents" FROM "traffic_billing_records" WHERE "userId" = ?', [7]),
    };

    await commands.resetUserTrafficCommand({ actor: { id: 7, role: "admin" }, targetUserId: 7 });

    let user = await users.getUserById(7);
    assert.equal(Number(user?.trafficUsed), 0);
    assert.equal(Number(user?.trafficBillingResetBytes), 500);
    assert.equal(Number(user?.balanceCents), 1234);
    assert.equal(Number((await users.getUsersPage({ page: 1, pageSize: 20 })).items.find((item) => Number(item.id) === 7)?.trafficBillingUsed), 0);
    assert.deepEqual(
      await query('SELECT "userId", "resourceType", "resourceId", "totalBytes", "billedGb" FROM "traffic_billing_usage" WHERE "userId" = ? ORDER BY "resourceType", "resourceId"', [7]),
      ledgersBefore.usage,
    );
    assert.deepEqual(
      await query('SELECT "userId", "ruleId", "resourceType", "resourceId", "totalBytes", "billedGb" FROM "traffic_billing_rule_usage" WHERE "userId" = ?', [7]),
      ledgersBefore.ruleUsage,
    );
    assert.deepEqual(
      await query('SELECT "userId", "ruleId", "resourceType", "resourceId", "bytes", "billedGb", "amountCents", "balanceAfterCents" FROM "traffic_billing_records" WHERE "userId" = ?', [7]),
      ledgersBefore.records,
    );

    await exec(
      'UPDATE "traffic_billing_usage" SET "totalBytes" = "totalBytes" + ? WHERE "userId" = ? AND "resourceType" = ? AND "resourceId" = ?',
      [125, 7, "host", 11],
    );
    await exec('UPDATE "users" SET "trafficUsed" = ? WHERE "id" = ?', [99, 7]);
    assert.equal(Number((await users.getUsersPage({ page: 1, pageSize: 20 })).items.find((item) => Number(item.id) === 7)?.trafficBillingUsed), 125);

    await users.resetUserTraffic(7);
    user = await users.getUserById(7);
    assert.equal(Number(user?.trafficUsed), 0);
    assert.equal(Number(user?.trafficBillingResetBytes), 500, "scheduled package reset must retain the billing display baseline");
    assert.equal(Number((await users.getUsersPage({ page: 1, pageSize: 20 })).items.find((item) => Number(item.id) === 7)?.trafficBillingUsed), 125);
  `, { name: "user-traffic-reset" });
});
