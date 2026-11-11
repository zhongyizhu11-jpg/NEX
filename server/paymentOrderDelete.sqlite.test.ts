import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/*
  删除未支付订单（上游 2.3.298），跑在真的 SQLite 上：
  能删哪些、不能删哪些；删单退库存、退折扣码在同一个事务里；删掉以后迟到的付款回调转入余额且只转一次。
*/

const setup = String.raw`
  const billing = await import(url("server/repositories/billingRepository.ts"));
  const payment = await import(url("server/payment.ts"));
  const { paymentRouter } = payment;
  await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (1, 'admin', 'h', 'admin', 0)");
  await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (2, 'buyer', 'h', 'user', 0)");
  await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (10, 'h', '203.0.113.9', 'tok', 1)");
  const context = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
  const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
  const buyer = { id: 2, username: "buyer", role: "user", accountEnabled: true };
  const planId = Number((await billing.createSubscriptionPlan({
    name: "限量", priceCents: 100, currency: "CNY", durationDays: 30, portCount: 2, maxRules: 10, isActive: true, isStoreVisible: true,
  }, [10], [], [])).id);
  await exec("UPDATE subscription_plans SET stockLimit = 5 WHERE id = ?", [planId]);
  const stockUsed = async () => Number((await query("SELECT stockUsed FROM subscription_plans WHERE id = ?", [planId]))[0].stockUsed);
  const order = (outTradeNo, extra = {}) => billing.createPaymentOrder({
    outTradeNo, userId: 2, provider: "stripe", paymentType: "stripe", status: "pending",
    subject: "订单", amountCents: 100, orderType: "plan", planId, ...extra,
  });
  const idOf = async (outTradeNo) => Number((await query("SELECT id FROM payment_orders WHERE outTradeNo = ?", [outTradeNo]))[0]?.id || 0);
  const balanceOf = async (userId) => Number((await query("SELECT balanceCents FROM users WHERE id = ?", [userId]))[0].balanceCents);
  const notify = (outTradeNo, amountCents = 100, provider = "stripe") => payment.processPaidNotification(outTradeNo, {
    provider, tradeNo: "pi_" + outTradeNo, amountCents, currency: "CNY", rawNotify: "{}",
  });
`;

function runInDatabase(body: string) {
  runSharedDatabaseTest(body, { name: "payment-order-delete", setup, quiet: true });
}

test("待支付订单删除时退回占用的库存和折扣码，已支付 / 已完成的不能删", () => {
  runInDatabase(String.raw`
    const discount = await billing.createDiscountCode({ code: "TENOFF", discountType: "amount", discountValue: 10, maxUses: 0, isActive: true }, []);
    await billing.consumeDiscountCode(Number(discount.id));
    await order("PENDING-1", { discountCodeId: Number(discount.id), discountConsumed: true });
    await order("PENDING-2");
    assert.equal(await stockUsed(), 2);
    await order("EXPIRED-1");
    await billing.updatePaymentOrder("EXPIRED-1", { status: "expired" });
    assert.equal(await stockUsed(), 2, "关单时已经退过一份");
    await order("PAID-1");
    await billing.markPaymentOrderPaid("PAID-1", { tradeNo: "t" });
    await order("DONE-1", { subscriptionId: 99 });
    await billing.updatePaymentOrder("DONE-1", { status: "completed", paidAt: new Date() });
    await order("FAILED-NOTIFY", { subscriptionId: 99 });
    await billing.updatePaymentOrder("FAILED-NOTIFY", { status: "failed", rawNotify: "{\"amount\":1}" });
    assert.equal(await stockUsed(), 3);

    const ids = await Promise.all(["PENDING-1", "PENDING-2", "EXPIRED-1", "PAID-1", "DONE-1", "FAILED-NOTIFY"].map(idOf));
    // 普通用户不能删
    await assert.rejects(() => paymentRouter.createCaller(context(buyer)).deleteOrders({ ids }), (error) => error.code === "FORBIDDEN");
    const result = await paymentRouter.createCaller(context(admin)).deleteOrders({ ids: [...ids, 424242] });
    assert.deepEqual(result.deleted.map((item) => item.outTradeNo).sort(), ["EXPIRED-1", "PENDING-1", "PENDING-2"]);
    assert.deepEqual(result.deleted.find((item) => item.outTradeNo === "PENDING-1"), { id: ids[0], outTradeNo: "PENDING-1", stockReleased: true, discountReleased: true });
    assert.equal(result.deleted.find((item) => item.outTradeNo === "EXPIRED-1").stockReleased, false);
    const skipped = new Map(result.skipped.map((item) => [item.outTradeNo ?? item.id, item.reason]));
    assert.match(skipped.get("PAID-1"), /已支付或已完成/);
    assert.match(skipped.get("DONE-1"), /已支付或已完成/);
    assert.match(skipped.get("FAILED-NOTIFY"), /付款通知/);
    assert.match(skipped.get(424242), /不存在/);
    // 只退了两笔待支付的那两份：已付款那一份还占着
    assert.equal(await stockUsed(), 1);
    assert.equal(Number((await query("SELECT usedCount FROM discount_codes WHERE id = ?", [Number(discount.id)]))[0].usedCount), 0);
    assert.equal(await idOf("PENDING-1"), 0);
    assert.ok(await idOf("PAID-1"));
    assert.equal(Number((await query("SELECT COUNT(*) AS n FROM payment_order_tombstones"))[0].n), 3);
    // 再删一次同样的 id：已经没了，不会重复退库存
    const again = await paymentRouter.createCaller(context(admin)).deleteOrders({ ids: [ids[0]] });
    assert.equal(again.deleted.length, 0);
    assert.equal(await stockUsed(), 1);
  `);
});

test("删除后迟到的付款回调：对得上就转入余额且只转一次，对不上拒绝，测试单不入账", () => {
  runInDatabase(String.raw`
    await order("LATE-1");
    await order("LATE-TEST", { orderType: "test", planId: null });
    const admin1 = paymentRouter.createCaller(context(admin));
    await admin1.deleteOrders({ ids: [await idOf("LATE-1"), await idOf("LATE-TEST")] });
    assert.equal(await stockUsed(), 0);

    // 金额不符：拒绝，不加钱
    const mismatch = await notify("LATE-1", 999);
    assert.equal(mismatch.ignored, true);
    assert.equal(await balanceOf(2), 0);
    // 渠道不符：拒绝
    await notify("LATE-1", 100, "alipay");
    assert.equal(await balanceOf(2), 0);

    const first = await notify("LATE-1");
    assert.deepEqual(first, { ignored: false, reason: "deleted_order" });
    assert.equal(await balanceOf(2), 100);
    const [tx] = await query("SELECT type, paymentOrderNo, description FROM balance_transactions WHERE userId = 2");
    assert.equal(tx.type, "payment");
    assert.equal(tx.paymentOrderNo, "LATE-1");
    assert.match(tx.description, /已被管理员删除/);
    // 回调重放：不再加钱，订单也不会被重新建出来，库存不动
    const replay = await notify("LATE-1");
    assert.equal(replay.ignored, true);
    assert.equal(await balanceOf(2), 100);
    assert.equal(await idOf("LATE-1"), 0);
    assert.equal(await stockUsed(), 0);
    assert.ok(Number((await query("SELECT creditedAt FROM payment_order_tombstones WHERE outTradeNo = 'LATE-1'"))[0].creditedAt) > 0);

    // 测试单：不入余额
    await notify("LATE-TEST");
    assert.equal(await balanceOf(2), 100);
    // 从来没有过的单号：照旧只记日志
    assert.deepEqual(await notify("NEVER-EXISTED"), { ignored: true, reason: "unknown_order" });
  `);
});
