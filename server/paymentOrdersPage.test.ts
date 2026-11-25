import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 支付订单分页（listPaymentOrdersPage）：支付设置页「订单记录」改成服务端分页之后的仓库函数。
 *
 * 在真的库上跑：翻页不重不漏、按创建时间倒序、状态 / 关键字筛选影响总数、越界页码收回到最后一页，
 * 以及分页接口回的行和 listPaymentOrders 同一种（带用户名）。
 */
test("支付订单按页取：倒序、不重不漏、筛选、越界页码", () => {
  runInDatabase(String.raw`
    const billing = await import(url("server/repositories/billingRepository.ts"));
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'alice', 'h', 'user')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (3, 'bob', 'h', 'user')");
    for (let i = 1; i <= 25; i++) {
      await billing.createPaymentOrder({
        outTradeNo: "ORD-" + String(i).padStart(3, "0"),
        userId: i % 2 ? 2 : 3,
        provider: "stripe",
        paymentType: "stripe",
        status: i % 5 === 0 ? "paid" : "pending",
        subject: "test",
        amountCents: 100 * i,
        orderType: "balance",
        tradeNo: i === 7 ? "GW-SEVEN" : null,
      });
    }
    // 同一秒建的 25 笔时间全一样，翻页只能靠 id 定序；把时间错开，顺便验证「按创建时间倒序」。
    const rows = await query("SELECT id FROM payment_orders ORDER BY id");
    for (const row of rows) {
      await exec("UPDATE payment_orders SET createdAt = ? WHERE id = ?", [1700000000 + Number(row.id), row.id]);
    }

    const first = await billing.listPaymentOrdersPage({ page: 1, pageSize: 10 });
    assert.equal(first.totalItems, 25);
    assert.equal(first.totalPages, 3);
    assert.equal(first.page, 1);
    assert.equal(first.items.length, 10);
    assert.equal(first.items[0].outTradeNo, "ORD-025", "最新的在前");
    assert.equal(first.items[0].username, "alice", "分页接口的行和 listPaymentOrders 一样带用户名");

    const second = await billing.listPaymentOrdersPage({ page: 2, pageSize: 10 });
    const third = await billing.listPaymentOrdersPage({ page: 3, pageSize: 10 });
    assert.equal(third.items.length, 5);
    const all = [...first.items, ...second.items, ...third.items].map((item) => item.outTradeNo);
    assert.equal(new Set(all).size, 25, "三页合起来不重");
    assert.deepEqual(all, [...all].sort().reverse(), "整体严格倒序");

    const paid = await billing.listPaymentOrdersPage({ page: 1, pageSize: 10, status: "paid" });
    assert.equal(paid.totalItems, 5);
    assert.ok(paid.items.every((item) => item.status === "paid"));

    const byTradeNo = await billing.listPaymentOrdersPage({ page: 1, pageSize: 10, keyword: "GW-SEVEN" });
    assert.deepEqual(byTradeNo.items.map((item) => item.outTradeNo), ["ORD-007"], "按网关流水号搜");
    const byUser = await billing.listPaymentOrdersPage({ page: 1, pageSize: 100, keyword: "bob" });
    assert.equal(byUser.totalItems, 12, "按用户名搜：偶数号订单都是 bob 的");
    const byOrderNo = await billing.listPaymentOrdersPage({ page: 1, pageSize: 10, keyword: "ORD-01" });
    assert.equal(byOrderNo.totalItems, 10, "ORD-010 … ORD-019");

    // 删掉最后一页之后还停在第 3 页的客户端：页码收回到最后一页，而不是回一页空的。
    const stale = await billing.listPaymentOrdersPage({ page: 9, pageSize: 10 });
    assert.equal(stale.page, 3);
    assert.equal(stale.items.length, 5);

    const none = await billing.listPaymentOrdersPage({ page: 1, pageSize: 10, keyword: "nothing-matches" });
    assert.equal(none.totalItems, 0);
    assert.deepEqual(none.items, []);
    assert.equal(none.totalPages, 1);
  `, { name: "payment-orders-page", quiet: true });
});
