import test from "node:test";
import { runInDatabase } from "../testing/runInDatabase";

test("payment callbacks cannot reactivate closed orders", () => {
  runInDatabase(String.raw`
    const billing = await import(url("server/repositories/billingRepository.ts"));
    await exec(
      'INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)',
      [1, "payment-test", "x", "Payment Test", "user"],
    );
    const statuses = ["failed", "expired", "cancelled"];
    for (const [index, status] of statuses.entries()) {
      await exec(
        'INSERT INTO "payment_orders" ("id", "outTradeNo", "userId", "provider", "paymentType", "status", "subject", "amountCents", "currency") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [index + 1, "FWX-CLOSED-" + status, 1, "stripe", "stripe", status, "test", 100, "CNY"],
      );
      const result = await billing.markPaymentOrderPaid("FWX-CLOSED-" + status, {
        tradeNo: "late-trade-" + status,
        rawNotify: "late-notify",
        amountCents: 100,
        currency: "CNY",
      });
      assert.equal(result?.status, status);
      const [row] = await query('SELECT "status", "paidAt", "tradeNo" FROM "payment_orders" WHERE "outTradeNo" = ?', ["FWX-CLOSED-" + status]);
      assert.equal(row.status, status);
      assert.equal(row.paidAt, null);
      assert.equal(row.tradeNo, null);
    }

    await exec(
      'INSERT INTO "payment_orders" ("id", "outTradeNo", "userId", "provider", "paymentType", "status", "subject", "amountCents", "currency") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [10, "FWX-PENDING", 1, "stripe", "stripe", "pending", "test", 100, "CNY"],
    );
    const claimed = await billing.markPaymentOrderPaid("FWX-PENDING", {
      tradeNo: "paid-trade",
      rawNotify: "paid-notify",
      amountCents: 100,
      currency: "CNY",
    });
    assert.equal(claimed?.status, "paid");
    const [pendingRow] = await query('SELECT "status", "paidAt", "tradeNo" FROM "payment_orders" WHERE "outTradeNo" = ?', ["FWX-PENDING"]);
    assert.equal(pendingRow.status, "paid");
    assert.ok(pendingRow.paidAt);
    assert.equal(pendingRow.tradeNo, "paid-trade");

    await exec(
      'INSERT INTO "subscription_plans" ("id", "name", "durationDays", "portCount", "trafficLimit") VALUES (?, ?, ?, ?, ?)',
      [100, "Pending payment plan", 30, 1, 1000],
    );
    await exec(
      'INSERT INTO "payment_orders" ("id", "outTradeNo", "userId", "provider", "paymentType", "status", "subject", "amountCents", "currency", "planId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [20, "FWX-PLAN-PENDING", 1, "stripe", "stripe", "pending", "plan", 100, "CNY", 100],
    );
    await assert.rejects(
      () => billing.deleteSubscriptionPlan(100),
      /待支付或待发放订单/,
    );
    let [plan] = await query('SELECT "id" FROM "subscription_plans" WHERE "id" = ?', [100]);
    assert.equal(Number(plan.id), 100);

    await exec('UPDATE "payment_orders" SET "status" = ? WHERE "outTradeNo" = ?', ["cancelled", "FWX-PLAN-PENDING"]);
    await billing.deleteSubscriptionPlan(100);
    [plan] = await query('SELECT "id" FROM "subscription_plans" WHERE "id" = ?', [100]);
    assert.equal(plan, undefined);
    await assert.rejects(
      () => billing.createPaymentOrder({
        outTradeNo: "FWX-DELETED-PLAN",
        userId: 1,
        provider: "stripe",
        paymentType: "stripe",
        status: "pending",
        subject: "deleted plan",
        amountCents: 100,
        currency: "CNY",
        planId: 100,
      }),
      /套餐已删除/,
    );
  `, { name: "payment-state" });
});
