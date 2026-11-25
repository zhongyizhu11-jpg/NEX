import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 兑换码 / 折扣码的老列表接口（P2-10）：不传参数时和原来完全一样，返回全部；
 * 传了 limit / offset 只取那一段，顺序不变。
 */
test("老列表接口的可选分页：不传时返回全部", () => {
  runInDatabase(String.raw`
    const { billingRouter } = await import(url("server/routers/billing.ts"));
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    const now = Math.floor(Date.now() / 1000);
    for (let id = 1; id <= 7; id++) {
      await exec("INSERT INTO redemption_codes (id, code, type, amountCents, isActive, createdByUserId, createdAt) VALUES (?, ?, 'balance', 100, 1, 1, ?)", [id, "CODE-" + id, now - id]);
      await exec("INSERT INTO discount_codes (id, code, discountType, discountValue, maxUses, isActive, createdByUserId, createdAt) VALUES (?, ?, 'amount', 1, 0, 1, 1, ?)", [id, "OFF-" + id, now - id]);
    }
    const caller = billingRouter.createCaller({ user: { id: 1, role: "admin", username: "admin" }, req: { headers: {}, socket: {} }, res: {} });
    const allCodes = await caller.listRedemptionCodes();
    assert.deepEqual(allCodes.map((row) => row.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual((await caller.listRedemptionCodes({ limit: 2, offset: 1 })).map((row) => row.id), [2, 3]);
    assert.deepEqual((await caller.listRedemptionCodes({ offset: 5 })).map((row) => row.id), [6, 7]);
    const allDiscounts = await caller.listDiscountCodes();
    assert.deepEqual(allDiscounts.map((row) => row.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(Array.isArray(allDiscounts[0].planIds));
    assert.deepEqual((await caller.listDiscountCodes({ limit: 3 })).map((row) => row.id), [1, 2, 3]);
    console.log("ok");
  `, { name: "billing-legacy-list" });
});
