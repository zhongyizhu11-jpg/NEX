import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("subscription traffic cycles follow the user's configured monthly reset day", () => {
  runInDatabase(String.raw`
    const RealDate = Date;
    const fixedNow = new RealDate(2026, 7, 3, 10, 0, 0, 0).getTime();
    class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length > 0 ? args : [fixedNow]));
      }
      static now() {
        return fixedNow;
      }
    }
    globalThis.Date = FixedDate;

    const localDate = (year, month, day, hour = 0, minute = 0) => new RealDate(year, month - 1, day, hour, minute, 0, 0);
    const epoch = (date) => Math.floor(date.getTime() / 1000);
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));

    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "trafficUsed", "trafficAutoReset", "trafficResetDay") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [1, "cycle-user", "hash", "user", 900, 0, 1],
    );
    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "userId", "portRangeStart", "portRangeEnd") VALUES (?, ?, ?, ?, ?, ?)',
      [1, "cycle-host", "127.0.0.1", 1, 10000, 10100],
    );
    for (const planId of [1, 2, 3, 4]) {
      await exec(
        'INSERT INTO "subscription_plans" ("id", "name", "durationDays", "portCount", "trafficLimit") VALUES (?, ?, ?, ?, ?)',
        [planId, "Plan " + planId, 30, 1, planId * 1000],
      );
      await exec(
        'INSERT INTO "subscription_plan_hosts" ("planId", "hostId") VALUES (?, ?)',
        [planId, 1],
      );
    }

    const snapshot = (planId) => JSON.stringify({
      name: "Plan " + planId,
      portCount: 1,
      trafficLimit: planId * 1000,
      rateLimitMbps: 0,
      maxRules: 20,
      maxConnections: 2000,
      maxIPs: 10,
      hostIds: [1],
      tunnelIds: [],
      forwardGroupIds: [],
    });
    const subscriptions = [
      [11, 1, snapshot(1), 10000, epoch(localDate(2026, 7, 3, 10)), epoch(localDate(2026, 10, 1)), epoch(localDate(2026, 9, 3, 10))],
      [12, 2, snapshot(2), 10001, epoch(localDate(2026, 7, 15, 10)), epoch(localDate(2026, 10, 1)), epoch(localDate(2026, 9, 15, 10))],
      [13, 3, snapshot(3), 10002, epoch(localDate(2026, 6, 20, 10)), epoch(localDate(2026, 8, 23)), epoch(localDate(2026, 9, 20, 10))],
    ];
    for (const [id, planId, planSnapshot, port, startedAt, expiresAt, nextTrafficResetAt] of subscriptions) {
      await exec(
        'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "planSnapshot", "portRangeStart", "portRangeEnd", "startedAt", "expiresAt", "nextTrafficResetAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, 1, planId, planSnapshot, port, port, startedAt, expiresAt, nextTrafficResetAt],
      );
    }

    await billing.updateUserManualEntitlements(1, { trafficAutoReset: true, trafficResetDay: 23 });
    let listed = await billing.listUserSubscriptions(1);
    let byId = new Map(listed.map((subscription) => [Number(subscription.id), subscription]));
    const august23 = localDate(2026, 8, 23);
    assert.equal(new RealDate(byId.get(11).nextTrafficResetAt).getTime(), august23.getTime());
    assert.equal(new RealDate(byId.get(12).nextTrafficResetAt).getTime(), august23.getTime());
    assert.equal(byId.get(13).nextTrafficResetAt, null, "a reset at the exact expiration boundary must not be scheduled");

    await billing.setUserSubscriptionExpiresAt(13, localDate(2026, 8, 24));
    listed = await billing.listUserSubscriptions(1);
    byId = new Map(listed.map((subscription) => [Number(subscription.id), subscription]));
    assert.equal(
      new RealDate(byId.get(13).nextTrafficResetAt).getTime(),
      august23.getTime(),
      "extending beyond the boundary must restore that reset cycle",
    );

    const created = await billing.applySubscriptionToUser(1, 4, "admin", null, new FixedDate());
    listed = await billing.listUserSubscriptions(1);
    byId = new Map(listed.map((subscription) => [Number(subscription.id), subscription]));
    assert.equal(new RealDate(byId.get(Number(created.subscriptionId)).nextTrafficResetAt).getTime(), august23.getTime());

    await exec(
      'INSERT INTO "user_traffic_addons" ("userId", "subscriptionId", "planId", "trafficBytes", "status", "expiresAt") VALUES (?, ?, ?, ?, ?, ?)',
      [1, 11, 1, 500, "active", epoch(august23)],
    );
    await billing.updateUserManualEntitlements(1, { trafficResetDay: 25 });
    let [addon] = await query('SELECT "cycleResetAt", "expiresAt" FROM "user_traffic_addons" WHERE "subscriptionId" = ?', [11]);
    assert.equal(Number(addon.expiresAt), epoch(localDate(2026, 8, 25)), "active add-ons must follow the changed cycle end");
    assert.equal(Number(addon.cycleResetAt), epoch(localDate(2026, 8, 25)), "the displayed add-on cycle must follow the changed reset day");

    await exec('UPDATE "users" SET "trafficUsed" = ? WHERE "id" = ?', [999, 1]);
    await billing.updateUserManualEntitlements(1, { trafficResetDay: 3 });

    // The scheduler runs the user-level monthly cycle reset first. The
    // subscription phase must still advance its cycle and expire add-ons,
    // while avoiding a second reset of the shared user counter.
    await users.resetUserTrafficForCycle(1, localDate(2026, 8, 3), new FixedDate());
    assert.equal(await billing.rechargeSubscriptionTrafficCycles(), 0, "an already reset user is not reset twice at the same boundary");
    let [user] = await query('SELECT "trafficUsed", "lastTrafficReset" FROM "users" WHERE "id" = ?', [1]);
    assert.equal(Number(user.trafficUsed), 0);
    assert.ok(user.lastTrafficReset);
    [addon] = await query('SELECT "status" FROM "user_traffic_addons" WHERE "subscriptionId" = ?', [11]);
    assert.equal(addon.status, "expired");
    listed = await billing.listUserSubscriptions(1);
    byId = new Map(listed.map((subscription) => [Number(subscription.id), subscription]));
    assert.equal(new RealDate(byId.get(11).nextTrafficResetAt).getTime(), localDate(2026, 9, 3).getTime());
    assert.equal(new RealDate(byId.get(12).nextTrafficResetAt).getTime(), localDate(2026, 9, 3).getTime());
    assert.equal(byId.get(13).nextTrafficResetAt, null);
    const renewed = await billing.applySubscriptionToUser(1, 1, "admin", null, new FixedDate());
    assert.notEqual(Number(renewed.subscriptionId), 11, "a new administrative assignment must create its own subscription");
    listed = await billing.listUserSubscriptions(1);
    byId = new Map(listed.map((subscription) => [Number(subscription.id), subscription]));
    assert.ok(byId.get(Number(renewed.subscriptionId)), "the new administrative subscription is visible");
    assert.equal(
      new RealDate(byId.get(11).nextTrafficResetAt).getTime(),
      localDate(2026, 9, 3).getTime(),
      "adding another subscription must not reopen the existing cycle boundary",
    );

    await exec('UPDATE "users" SET "trafficUsed" = ? WHERE "id" = ?', [777, 1]);
    assert.equal(await billing.rechargeSubscriptionTrafficCycles(), 0, "the same monthly boundary must not reset twice");
    [user] = await query('SELECT "trafficUsed" FROM "users" WHERE "id" = ?', [1]);
    assert.equal(Number(user.trafficUsed), 777);

    await billing.updateUserManualEntitlements(1, { trafficAutoReset: false });
    listed = await billing.listUserSubscriptions(1);
    byId = new Map(listed.map((subscription) => [Number(subscription.id), subscription]));
    assert.equal(new RealDate(byId.get(11).nextTrafficResetAt).getTime(), localDate(2026, 9, 3).getTime());
    assert.equal(new RealDate(byId.get(12).nextTrafficResetAt).getTime(), localDate(2026, 8, 15).getTime());

    await billing.updateUserManualEntitlements(1, { trafficAutoReset: true, trafficResetDay: 23 });
    listed = await billing.listUserSubscriptions(1);
    byId = new Map(listed.map((subscription) => [Number(subscription.id), subscription]));
    assert.equal(new RealDate(byId.get(11).nextTrafficResetAt).getTime(), august23.getTime());
    assert.equal(new RealDate(byId.get(12).nextTrafficResetAt).getTime(), august23.getTime());
    assert.equal(new RealDate(byId.get(Number(created.subscriptionId)).nextTrafficResetAt).getTime(), august23.getTime());

    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "trafficUsed", "trafficAutoReset", "trafficResetDay") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [2, "anchored-cycle-user", "hash", "user", 321, 0, 1],
    );
    await exec(
      'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "planSnapshot", "portRangeStart", "portRangeEnd", "startedAt", "expiresAt", "nextTrafficResetAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [21, 2, 1, snapshot(1), 10010, 10010, epoch(localDate(2026, 7, 3)), epoch(localDate(2026, 10, 1)), epoch(localDate(2026, 8, 3))],
    );
    assert.equal(await billing.rechargeSubscriptionTrafficCycles(), 1, "an anchored subscription cycle resets a user without account auto-reset");
    let [anchoredUser] = await query('SELECT "trafficUsed" FROM "users" WHERE "id" = ?', [2]);
    assert.equal(Number(anchoredUser.trafficUsed), 0);
    await exec('UPDATE "users" SET "trafficUsed" = ? WHERE "id" = ?', [88, 2]);
    assert.equal(await billing.rechargeSubscriptionTrafficCycles(), 0);
    [anchoredUser] = await query('SELECT "trafficUsed" FROM "users" WHERE "id" = ?', [2]);
    assert.equal(Number(anchoredUser.trafficUsed), 88);

    // If the panel was offline across a month boundary, an already-due
    // configured cycle must be settled before aligning to this month's day.
    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "trafficUsed", "trafficAutoReset", "trafficResetDay", "canAddRules", "allowForwardXTunnel", "forwardAccessPauseReason") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [3, "offline-cycle-user", "hash", "user", 654, 1, 23, 0, 0, "traffic_limit"],
    );
    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "userId", "portRangeStart", "portRangeEnd") VALUES (?, ?, ?, ?, ?, ?)',
      [3, "offline-cycle-host", "127.0.0.3", 3, 11000, 11100],
    );
    await exec(
      'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "planSnapshot", "portRangeStart", "portRangeEnd", "startedAt", "expiresAt", "nextTrafficResetAt", "lastTrafficResetAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [31, 3, 1, snapshot(1), 10020, 10020, epoch(localDate(2026, 5, 1)), epoch(localDate(2026, 10, 1)), epoch(localDate(2026, 7, 23)), epoch(localDate(2026, 6, 23))],
    );
    await exec(
      'INSERT INTO "user_traffic_addons" ("userId", "subscriptionId", "planId", "trafficBytes", "status", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [3, 31, 1, 500, "active", epoch(localDate(2026, 7, 23)), epoch(localDate(2026, 7, 1)), epoch(localDate(2026, 7, 1))],
    );

    await exec(
      'INSERT INTO "forward_groups" ("id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [30, "offline-cycle-group", "host", "port", "203.0.113.30", 3, 1],
    );
    await exec(
      'INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "isEnabled") VALUES (?, ?, ?, ?, ?)',
      [300, 30, "host", 3, 1],
    );
    const insertRule = async ({
      id,
      name,
      sourcePort,
      isEnabled = 0,
      disabledByUser = 1,
      disabledByTunnel = 0,
      disabledByGroup = 0,
      protocolBlockReason = null,
      pendingDelete = 0,
      forwardGroupId = null,
      forwardGroupRuleId = null,
      forwardGroupMemberId = null,
      isForwardGroupTemplate = 0,
    }) => exec(
      'INSERT INTO "forward_rules" ("id", "hostId", "name", "sourcePort", "targetIp", "targetPort", "isEnabled", "disabledByUser", "disabledByTunnel", "disabledByGroup", "protocolBlockReason", "pendingDelete", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, 3, name, sourcePort, "203.0.113.3", sourcePort, isEnabled, disabledByUser, disabledByTunnel, disabledByGroup, protocolBlockReason, pendingDelete, forwardGroupId, forwardGroupRuleId, forwardGroupMemberId, isForwardGroupTemplate, 3],
    );
    await insertRule({ id: 301, name: "user-paused", sourcePort: 11001 });
    await insertRule({ id: 302, name: "manually-disabled", sourcePort: 11002, disabledByUser: 0 });
    await insertRule({ id: 303, name: "tunnel-blocked", sourcePort: 11003, disabledByTunnel: 1 });
    await insertRule({ id: 304, name: "group-blocked", sourcePort: 11004, disabledByGroup: 1 });
    await insertRule({ id: 305, name: "protocol-blocked", sourcePort: 11005, protocolBlockReason: "agent protocol conflict" });
    await insertRule({ id: 306, name: "pending-delete", sourcePort: 11006, pendingDelete: 1 });
    await insertRule({ id: 307, name: "group-template", sourcePort: 11007, forwardGroupId: 30, isForwardGroupTemplate: 1 });
    await insertRule({ id: 308, name: "group-child", sourcePort: 11007, forwardGroupId: 30, forwardGroupRuleId: 307, forwardGroupMemberId: 300 });

    assert.equal(await billing.rechargeSubscriptionTrafficCycles(), 1, "an overdue configured cycle survives cross-month alignment");
    const [offlineUser] = await query(
      'SELECT "trafficUsed", "canAddRules", "allowForwardXTunnel", "forwardAccessPauseReason" FROM "users" WHERE "id" = ?',
      [3],
    );
    assert.equal(Number(offlineUser.trafficUsed), 0);
    assert.equal(Number(offlineUser.canAddRules), 1);
    assert.equal(Number(offlineUser.allowForwardXTunnel), 1);
    assert.equal(offlineUser.forwardAccessPauseReason, null);
    const [offlineSubscription] = await query(
      'SELECT "nextTrafficResetAt", "lastTrafficResetAt" FROM "user_subscriptions" WHERE "id" = ?',
      [31],
    );
    assert.equal(Number(offlineSubscription.nextTrafficResetAt), epoch(localDate(2026, 8, 23)));
    assert.equal(Number(offlineSubscription.lastTrafficResetAt), epoch(new FixedDate()));
    const [offlineAddon] = await query('SELECT "status" FROM "user_traffic_addons" WHERE "subscriptionId" = ?', [31]);
    assert.equal(offlineAddon.status, "expired");
    const recoveredRules = await query(
      'SELECT "id", "isEnabled", "disabledByUser" FROM "forward_rules" WHERE "userId" = ? ORDER BY "id"',
      [3],
    );
    const recoveredRuleById = new Map(recoveredRules.map((rule) => [Number(rule.id), rule]));
    for (const id of [301, 307, 308]) {
      assert.equal(Number(recoveredRuleById.get(id).isEnabled), 1, "rule " + id + " disabled only by the user must recover");
      assert.equal(Number(recoveredRuleById.get(id).disabledByUser), 0);
    }
    assert.equal(Number(recoveredRuleById.get(302).isEnabled), 0, "a rule manually disabled before the traffic pause must stay disabled");
    assert.equal(Number(recoveredRuleById.get(302).disabledByUser), 0);
    for (const id of [303, 304, 305]) {
      assert.equal(Number(recoveredRuleById.get(id).isEnabled), 0, "rule " + id + " with another blocker must stay disabled");
      assert.equal(Number(recoveredRuleById.get(id).disabledByUser), 0, "rule " + id + " must clear only its user-level blocker");
    }
    assert.equal(Number(recoveredRuleById.get(306).isEnabled), 0);
    assert.equal(Number(recoveredRuleById.get(306).disabledByUser), 1, "pending deletion must never be recovered");
    const userSyncRuleIds = (await (await import(url("server/repositories/forwardRuleRepository.ts"))).getForwardRulesForUserSync(3))
      .map((rule) => Number(rule.id));
    assert.ok(userSyncRuleIds.includes(308), "generated group children must participate in Agent refresh");
    assert.ok(!userSyncRuleIds.includes(307), "group templates are not Agent runtime rules");
    assert.ok(!userSyncRuleIds.includes(306), "pending-deletion rules are not Agent runtime rules");
    await exec('UPDATE "users" SET "trafficUsed" = ? WHERE "id" = ?', [77, 3]);
    assert.equal(await billing.rechargeSubscriptionTrafficCycles(), 0);
    const [offlineUserAfterRetry] = await query('SELECT "trafficUsed" FROM "users" WHERE "id" = ?', [3]);
    assert.equal(Number(offlineUserAfterRetry.trafficUsed), 77);

    // Buying at a due boundary and the scheduler settling that boundary may
    // overlap. Both paths share the per-user billing lock, so the old add-on
    // expires while the boundary/new-cycle add-ons remain active.
    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "trafficUsed", "trafficAutoReset", "trafficResetDay", "balanceCents") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [4, "addon-boundary-user", "hash", "user", 432, 1, 3, 1000],
    );
    await exec(
      'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "planSnapshot", "portRangeStart", "portRangeEnd", "startedAt", "expiresAt", "nextTrafficResetAt", "lastTrafficResetAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [41, 4, 1, snapshot(1), 10030, 10030, epoch(localDate(2026, 7, 3)), epoch(localDate(2026, 10, 1)), epoch(localDate(2026, 8, 3)), epoch(localDate(2026, 7, 3))],
    );
    await exec(
      'INSERT INTO "subscription_plan_traffic_addons" ("id", "planId", "trafficBytes", "priceCents", "isActive") VALUES (?, ?, ?, ?, ?)',
      [1, 1, 500, 100, 1],
    );
    await exec(
      'INSERT INTO "user_traffic_addons" ("id", "userId", "subscriptionId", "planId", "trafficBytes", "status", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [401, 4, 41, 1, 250, "active", epoch(localDate(2026, 8, 3)), epoch(localDate(2026, 8, 2, 23, 59)), epoch(localDate(2026, 8, 2, 23, 59))],
    );
    await exec(
      'INSERT INTO "user_traffic_addons" ("id", "userId", "subscriptionId", "planId", "trafficBytes", "status", "cycleResetAt", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [402, 4, 41, 1, 300, "active", epoch(localDate(2026, 9, 3)), epoch(localDate(2026, 9, 3)), epoch(localDate(2026, 8, 3)), epoch(localDate(2026, 8, 3))],
    );
    // 边界（8/3 00:00）之后、巡检跑到之前加上的加油包，周期末尾还停在刚过去的边界上
    // （比如管理员照着没来得及推进的订阅发的）。它属于新周期，不能被当成「已到期」收走。
    await exec(
      'INSERT INTO "user_traffic_addons" ("id", "userId", "subscriptionId", "planId", "trafficBytes", "status", "cycleResetAt", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [403, 4, 41, 1, 200, "active", epoch(localDate(2026, 8, 3)), epoch(localDate(2026, 8, 3)), epoch(localDate(2026, 8, 3, 0, 30)), epoch(localDate(2026, 8, 3, 0, 30))],
    );
    const [, purchase] = await Promise.all([
      billing.rechargeSubscriptionTrafficCycles(),
      billing.purchaseTrafficAddonWithBalance(4, 1, 41),
    ]);
    assert.equal(Number(purchase.priceCents), 100);
    assert.equal(new RealDate(purchase.expiresAt).getTime(), localDate(2026, 9, 3).getTime());
    const [addonBoundaryUser] = await query(
      'SELECT "trafficUsed", "balanceCents" FROM "users" WHERE "id" = ?',
      [4],
    );
    assert.equal(Number(addonBoundaryUser.trafficUsed), 0);
    assert.equal(Number(addonBoundaryUser.balanceCents), 900);
    const addonRows = await query(
      'SELECT "id", "status", "expiresAt" FROM "user_traffic_addons" WHERE "userId" = ? ORDER BY "id"',
      [4],
    );
    const addonById = new Map(addonRows.map((addon) => [Number(addon.id), addon]));
    assert.equal(addonById.get(401).status, "expired", "the previous-cycle add-on must expire");
    assert.equal(addonById.get(402).status, "active", "an add-on created exactly at the boundary belongs to the new cycle");
    assert.equal(Number(addonById.get(402).expiresAt), epoch(localDate(2026, 9, 3)));
    assert.equal(addonById.get(403).status, "active", "an add-on created after the boundary with a stale cycle end must move to the new cycle, not expire");
    assert.equal(Number(addonById.get(403).expiresAt), epoch(localDate(2026, 9, 3)));
    assert.equal(addonById.get(Number(purchase.id)).status, "active", "the newly purchased add-on must survive settlement");
    assert.equal(Number(addonById.get(Number(purchase.id)).expiresAt), epoch(localDate(2026, 9, 3)));
    const [purchaseCount] = await query(
      'SELECT COUNT(*) AS "count" FROM "balance_transactions" WHERE "userId" = ? AND "type" = ?',
      [4, "traffic_addon_purchase"],
    );
    assert.equal(Number(purchaseCount.count), 1);
    const [addonSubscription] = await query(
      'SELECT "nextTrafficResetAt", "lastTrafficResetAt" FROM "user_subscriptions" WHERE "id" = ?',
      [41],
    );
    assert.equal(Number(addonSubscription.nextTrafficResetAt), epoch(localDate(2026, 9, 3)));
    assert.equal(Number(addonSubscription.lastTrafficResetAt), epoch(new FixedDate()));
    await exec('UPDATE "users" SET "trafficUsed" = ? WHERE "id" = ?', [55, 4]);
    assert.equal(await billing.rechargeSubscriptionTrafficCycles(), 0, "the settled boundary is idempotent after purchase");
    const [addonBoundaryUserAfterRetry] = await query('SELECT "trafficUsed" FROM "users" WHERE "id" = ?', [4]);
    assert.equal(Number(addonBoundaryUserAfterRetry.trafficUsed), 55);
    const activeAddonRows = await query(
      'SELECT "id" FROM "user_traffic_addons" WHERE "userId" = ? AND "status" = ? ORDER BY "id"',
      [4, "active"],
    );
    assert.deepEqual(activeAddonRows.map((addon) => Number(addon.id)), [402, 403, Number(purchase.id)].sort((a, b) => a - b));

    // A failed purchase must not strand access after its pre-purchase cycle
    // settlement has already reset traffic and advanced the subscription.
    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "trafficUsed", "trafficAutoReset", "trafficResetDay", "balanceCents", "canAddRules", "allowForwardXTunnel", "forwardAccessPauseReason") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [5, "failed-addon-user", "hash", "user", 1000, 1, 3, 0, 0, 0, "traffic_limit"],
    );
    await exec(
      'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "planSnapshot", "portRangeStart", "portRangeEnd", "startedAt", "expiresAt", "nextTrafficResetAt", "lastTrafficResetAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [51, 5, 1, snapshot(1), 10040, 10040, epoch(localDate(2026, 7, 3)), epoch(localDate(2026, 10, 1)), epoch(localDate(2026, 8, 3)), epoch(localDate(2026, 7, 3))],
    );
    await exec(
      'INSERT INTO "forward_rules" ("id", "hostId", "name", "sourcePort", "targetIp", "targetPort", "isEnabled", "disabledByUser", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [501, 3, "failed-purchase-recovery", 11050, "203.0.113.5", 11050, 0, 1, 5],
    );
    await assert.rejects(
      () => billing.purchaseTrafficAddonWithBalance(5, 1, 51),
      /./,
    );
    const [failedPurchaseUser] = await query(
      'SELECT "trafficUsed", "canAddRules", "forwardAccessPauseReason" FROM "users" WHERE "id" = ?',
      [5],
    );
    assert.equal(Number(failedPurchaseUser.trafficUsed), 0);
    assert.equal(Number(failedPurchaseUser.canAddRules), 1);
    assert.equal(failedPurchaseUser.forwardAccessPauseReason, null);
    const [failedPurchaseSubscription] = await query(
      'SELECT "nextTrafficResetAt" FROM "user_subscriptions" WHERE "id" = ?',
      [51],
    );
    assert.equal(Number(failedPurchaseSubscription.nextTrafficResetAt), epoch(localDate(2026, 9, 3)));
    const [failedPurchaseRule] = await query(
      'SELECT "isEnabled", "disabledByUser" FROM "forward_rules" WHERE "id" = ?',
      [501],
    );
    assert.equal(Number(failedPurchaseRule.isEnabled), 1);
    assert.equal(Number(failedPurchaseRule.disabledByUser), 0);

    // Expiring one of several subscriptions must not reset the runtime state
    // of rules still covered by another active subscription.
    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "trafficUsed", "canAddRules", "allowForwardXTunnel") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [6, "overlapping-subscription-user", "hash", "user", 0, 1, 1],
    );
    await exec(
      'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "planSnapshot", "portRangeStart", "portRangeEnd", "startedAt", "expiresAt", "nextTrafficResetAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [61, 6, 1, snapshot(1), 10060, 10060, epoch(localDate(2026, 7, 1)), epoch(localDate(2026, 8, 3, 9)), null],
    );
    await exec(
      'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "planSnapshot", "portRangeStart", "portRangeEnd", "startedAt", "expiresAt", "nextTrafficResetAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [62, 6, 2, snapshot(2), 10061, 10061, epoch(localDate(2026, 7, 1)), epoch(localDate(2026, 10, 1)), epoch(localDate(2026, 9, 1))],
    );
    await exec(
      'INSERT INTO "forward_rules" ("id", "hostId", "name", "sourcePort", "targetIp", "targetPort", "isEnabled", "isRunning", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [601, 3, "covered-by-active-subscription", 11060, "203.0.113.6", 11060, 1, 1, 6],
    );
    assert.ok(await billing.expireUserSubscriptions());
    const [coveredRule] = await query(
      'SELECT "isEnabled", "isRunning" FROM "forward_rules" WHERE "id" = ?',
      [601],
    );
    assert.equal(Number(coveredRule.isEnabled), 1);
    assert.equal(Number(coveredRule.isRunning), 1, "an unrelated active rule must not flash back to waiting");
  `, { name: "subscription-cycle", env: { TZ: "Asia/Shanghai" } });
});
