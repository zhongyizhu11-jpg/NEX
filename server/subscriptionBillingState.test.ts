import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("subscription quota, cancellation, reassignment, and cancelled-record dismissal stay consistent", () => {
  runInDatabase(String.raw`
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const locks = await import(url("server/keyedTaskLock.ts"));
    const now = Date.now();
    const epoch = (milliseconds) => Math.floor(milliseconds / 1000);
    const snapshot = JSON.stringify({
      name: "100 GB plan",
      portCount: 1,
      trafficLimit: 1000,
      rateLimitMbps: 0,
      maxRules: 20,
      maxConnections: 2000,
      maxIPs: 10,
      hostIds: [1],
      tunnelIds: [],
      forwardGroupIds: [],
    });

    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "manualCanAddRules", "manualTrafficLimit", "trafficLimit") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [1, "quota-user", "hash", "user", 1, 1000, 2000],
    );
    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "userId", "portRangeStart", "portRangeEnd") VALUES (?, ?, ?, ?, ?, ?)',
      [1, "quota-host", "127.0.0.1", 1, 10000, 10100],
    );
    await exec(
      'INSERT INTO "subscription_plans" ("id", "name", "durationDays", "portCount", "trafficLimit", "maxRules", "maxConnections", "maxIPs") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [1, "100 GB plan", 30, 1, 1000, 20, 2000, 10],
    );
    await exec(
      'INSERT INTO "subscription_plan_hosts" ("planId", "hostId") VALUES (?, ?)',
      [1, 1],
    );
    await exec(
      'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "status", "source", "planSnapshot", "portRangeStart", "portRangeEnd", "startedAt", "expiresAt", "nextTrafficResetAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [11, 1, 1, "active", "admin", snapshot, 10000, 10000, epoch(now - 86400000), epoch(now + 30 * 86400000), epoch(now + 20 * 86400000)],
    );

    await billing.syncUserSubscriptionEntitlements(1);
    let [user] = await query('SELECT "trafficLimit" FROM "users" WHERE "id" = ?', [1]);
    assert.equal(Number(user.trafficLimit), 1000, "manual and plan limits are alternatives, not additive grants");

    await exec(
      'INSERT INTO "user_traffic_addons" ("id", "userId", "subscriptionId", "planId", "trafficBytes", "status", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [101, 1, 11, 1, 500, "active", epoch(now + 20 * 86400000)],
    );
    await exec(
      'INSERT INTO "user_traffic_addons" ("id", "userId", "subscriptionId", "planId", "trafficBytes", "source", "status", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [102, 1, 11, 1, 200, "admin", "active", epoch(now + 20 * 86400000)],
    );
    await billing.syncUserSubscriptionEntitlements(1);
    [user] = await query('SELECT "trafficLimit" FROM "users" WHERE "id" = ?', [1]);
    assert.equal(Number(user.trafficLimit), 1700, "real traffic add-ons remain additive");
    const [subscriptionWithAddons] = await billing.listUserSubscriptions(1);
    assert.equal(Number(subscriptionWithAddons.activeTrafficAddonBytes), 700);
    assert.equal(Number(subscriptionWithAddons.purchasedTrafficAddonBytes), 500);
    assert.equal(Number(subscriptionWithAddons.grantedTrafficAddonBytes), 200);

    await failWrite("fail_subscription_entitlement_sync", { table: "users", event: 'UPDATE OF "trafficLimit"', message: "forced entitlement sync failure" });
    await assert.rejects(() => billing.cancelUserSubscription(11), /forced entitlement sync failure/);
    let [subscriptionAfterRollback] = await query('SELECT "status" FROM "user_subscriptions" WHERE "id" = ?', [11]);
    let [addonAfterRollback] = await query('SELECT "status" FROM "user_traffic_addons" WHERE "id" = ?', [101]);
    assert.equal(subscriptionAfterRollback.status, "active", "failed entitlement sync rolls cancellation back");
    assert.equal(addonAfterRollback.status, "active", "failed entitlement sync keeps the add-on active");
    await dropFailWrite("fail_subscription_entitlement_sync", "users");

    await billing.cancelUserSubscription(11);
    const [cancelledAddon] = await query('SELECT "status" FROM "user_traffic_addons" WHERE "id" = ?', [101]);
    assert.equal(cancelledAddon.status, "expired");
    [user] = await query('SELECT "trafficLimit" FROM "users" WHERE "id" = ?', [1]);
    assert.equal(Number(user.trafficLimit), 1000, "cancellation commits the entitlement update atomically");

    const reassigned = await billing.applySubscriptionToUser(1, 1, "admin");
    assert.notEqual(Number(reassigned.subscriptionId), 11);
    [user] = await query('SELECT "trafficLimit" FROM "users" WHERE "id" = ?', [1]);
    assert.equal(Number(user.trafficLimit), 1000, "cancel and reassign must not double the quota");

    const storeSubscription = await billing.applySubscriptionToUser(1, 1, "balance");
    const [storeBeforeRenewal] = await query(
      'SELECT "expiresAt" FROM "user_subscriptions" WHERE "id" = ?',
      [storeSubscription.subscriptionId],
    );
    const storeRenewal = await billing.applySubscriptionToUser(
      1,
      1,
      "balance",
      "BALANCE-RENEWAL-1",
      undefined,
      null,
      Number(storeSubscription.subscriptionId),
    );
    assert.equal(Number(storeRenewal.subscriptionId), Number(storeSubscription.subscriptionId), "store renewal keeps the selected subscription");
    const [storeAfterRenewal] = await query(
      'SELECT "expiresAt" FROM "user_subscriptions" WHERE "id" = ?',
      [storeSubscription.subscriptionId],
    );
    assert.ok(Number(storeAfterRenewal.expiresAt) > Number(storeBeforeRenewal.expiresAt), "store renewal extends the existing subscription");
    await assert.rejects(
      () => billing.applySubscriptionToUser(
        1,
        1,
        "admin",
        null,
        undefined,
        null,
        Number(storeSubscription.subscriptionId),
      ),
      /不支持用户续费|管理员分配/,
    );
    await billing.cancelUserSubscription(Number(storeSubscription.subscriptionId));

    await assert.rejects(
      () => billing.dismissCancelledUserSubscription({
        id: Number(reassigned.subscriptionId),
        viewerUserId: 1,
        isAdmin: false,
      }),
      /只能删除已取消的订阅记录/,
    );

    await exec(
      'INSERT INTO "payment_orders" ("outTradeNo", "userId", "provider", "paymentType", "status", "subject", "amountCents", "orderType", "planId", "subscriptionId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ["ORDER-CANCELLED-11", 1, "alipay", "alipay", "completed", "cancelled plan", 0, "plan", 1, 11],
    );
    await billing.dismissCancelledUserSubscription({ id: 11, viewerUserId: 1, isAdmin: false });
    assert.equal((await query('SELECT "id" FROM "user_subscriptions" WHERE "id" = ?', [11])).length, 1);
    assert.equal((await query('SELECT "id" FROM "user_traffic_addons" WHERE "subscriptionId" = ?', [11])).length, 2);
    const [preservedOrder] = await query('SELECT "subscriptionId" FROM "payment_orders" WHERE "outTradeNo" = ?', ["ORDER-CANCELLED-11"]);
    assert.equal(Number(preservedOrder.subscriptionId), 11, "financial history keeps its subscription audit link");
    assert.equal((await billing.listUserSubscriptions(1, { visibility: "user" })).some((sub) => Number(sub.id) === 11), false);
    assert.equal((await billing.listUserSubscriptions(1, { visibility: "admin" })).some((sub) => Number(sub.id) === 11), true);
    await assert.rejects(
      () => billing.dismissCancelledUserSubscription({ id: 11, viewerUserId: 2, isAdmin: false }),
      /无权删除该订阅记录/,
    );
    await billing.dismissCancelledUserSubscription({ id: 11, viewerUserId: 999, isAdmin: true });
    assert.equal((await billing.listUserSubscriptions(1, { visibility: "admin" })).some((sub) => Number(sub.id) === 11), false);

    await exec(
      'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "status", "source", "planSnapshot", "startedAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [130, 1, 1, "cancelled", "admin", snapshot, epoch(now - 86400000), epoch(now + 30 * 86400000)],
    );
    await exec(
      'INSERT INTO "user_traffic_addons" ("id", "userId", "subscriptionId", "planId", "trafficBytes", "status", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [103, 1, 130, 1, 700, "active", epoch(now + 20 * 86400000)],
    );
    assert.equal(await billing.getActiveUserTrafficAddonBytes(1), 0, "an orphaned add-on on a cancelled parent is ignored");

    await billing.cancelUserSubscription(Number(reassigned.subscriptionId));
    await exec('UPDATE "users" SET "trafficLimit" = ? WHERE "id" = ?', [2000, 1]);
    const repaired = await billing.repairSubscriptionBillingStateOnce();
    assert.equal(repaired.users, 1);
    [user] = await query('SELECT "trafficLimit" FROM "users" WHERE "id" = ?', [1]);
    assert.equal(Number(user.trafficLimit), 1000, "startup reconciliation repairs stale quota after the last subscription was cancelled");

    const concurrentSubscription = await billing.applySubscriptionToUser(1, 1, "admin");
    await exec('UPDATE "users" SET "balanceCents" = ? WHERE "id" = ?', [100, 1]);
    await exec(
      'INSERT INTO "subscription_plan_traffic_addons" ("id", "planId", "trafficBytes", "priceCents", "isActive") VALUES (?, ?, ?, ?, ?)',
      [201, 1, 250, 25, 1],
    );
    let releaseBillingLock;
    let billingLockStarted;
    const billingLockGate = new Promise((resolve) => { releaseBillingLock = resolve; });
    const billingLockReady = new Promise((resolve) => { billingLockStarted = resolve; });
    const blocker = locks.withTrafficBillingUserLock(1, async () => {
      billingLockStarted();
      await billingLockGate;
    });
    await billingLockReady;
    const cancelPromise = billing.cancelUserSubscription(Number(concurrentSubscription.subscriptionId));
    const waitForDepth = async (depth) => {
      for (let attempt = 0; attempt < 200 && locks.keyedTaskDepth(locks.trafficBillingUserLockKey(1)) < depth; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(locks.keyedTaskDepth(locks.trafficBillingUserLockKey(1)), depth);
    };
    await waitForDepth(2);
    const purchasePromise = billing.purchaseTrafficAddonWithBalance(1, 201, Number(concurrentSubscription.subscriptionId));
    await waitForDepth(3);
    releaseBillingLock();
    await blocker;
    await cancelPromise;
    await assert.rejects(purchasePromise, /当前没有可购买流量包的生效套餐/);
    const [balanceAfterRace] = await query('SELECT "balanceCents" FROM "users" WHERE "id" = ?', [1]);
    assert.equal(Number(balanceAfterRace.balanceCents), 100, "a purchase queued behind cancellation must not charge the user");
    assert.equal((await query('SELECT "id" FROM "user_traffic_addons" WHERE "addonId" = ?', [201])).length, 0);

    await exec(
      'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "status", "source", "planSnapshot", "startedAt", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [900, 1, 1, "expired", "admin", snapshot, epoch(now - 90 * 86400000), epoch(now - 90 * 86400000)],
    );
    for (let index = 0; index < 205; index += 1) {
      await exec(
        'INSERT INTO "user_subscriptions" ("id", "userId", "planId", "status", "source", "planSnapshot", "startedAt", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [1000 + index, 1, 1, "cancelled", "admin", snapshot, epoch(now - 86400000), epoch(now + index * 1000)],
      );
    }
    const compactLedger = await billing.listBillingLedger({
      viewerUserId: 1,
      isAdmin: false,
      limit: 10,
      includeCancelledSubscriptions: false,
    });
    assert.equal(compactLedger.some((item) => item.kind === "subscription" && Number(item.sourceId) === 900), true);
    assert.equal(compactLedger.some((item) => item.kind === "subscription" && item.status === "cancelled"), false);
  `, { name: "subscription-state", env: { TZ: "UTC" } });
});
