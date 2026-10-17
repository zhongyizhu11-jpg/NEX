import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 邀请返利跑在真数据库上（SQLite）。
 *
 * 这一组守的是钱：
 * - 该返的返、按套餐比例向下取整到分，不该返的（没开、没邀请人、比例 0、充值单、非人民币单、
 *   邀请人停用）一分不返；
 * - 首单模式只返一次，每单模式续费也返；
 * - 首单 = 这个人之前没有付过钱的套餐单（返利关着时买的、绑定邀请人之前买的都算）；
 * - 绑定邀请人之前下的单不返（管理员后补的邀请人不能拿到之前的单）；
 * - 同一笔订单结算两次只返一次；
 * - 返利出错只撤销返利本身，被邀请人的购买照常完成；
 * - 返利流水不带被邀请人的订单号（那一列是「这单是否已入账」的判断依据）。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-referral-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      // 支付模块顶层可能取 fetch，先换成不联网的。
      globalThis.fetch = async () => { throw new Error("network disabled in test"); };

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const billing = await import(url("server/repositories/billingRepository.ts"));
      const referral = await import(url("server/repositories/referralRepository.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      const payment = await import(url("server/payment.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      // 1 管理员，2 邀请人，3 被邀请人（余额 1 万分），4 没有邀请人的普通用户
      await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (1, 'admin@example.com', 'h', 'admin', 0)");
      await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (2, 'inviter@example.com', 'h', 'user', 0)");
      await exec("INSERT INTO users (id, username, password, role, balanceCents, inviterId) VALUES (3, 'bob@example.com', 'h', 'user', 10000, 2)");
      await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (4, 'carol@example.com', 'h', 'user', 10000)");
      await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (10, 'hk', '203.0.113.9', 'tok', 1)");
      await settings.setSetting("referralEnabled", "true");
      await settings.setSetting("referralMode", "first");

      const makePlan = async (priceCents, referralRateBps) => Number((await billing.createSubscriptionPlan({
        name: "月付", priceCents, currency: "CNY", durationDays: 30,
        portCount: 5, maxRules: 10, isActive: true, isStoreVisible: true, referralRateBps,
      }, [10], [], [], [], [])).id);
      const balanceOf = async (userId) => Number((await query("SELECT balanceCents FROM users WHERE id = ?", [userId]))[0].balanceCents);
      const commissions = async () => query("SELECT * FROM referral_commissions ORDER BY id");
      const referralLedger = async () => query("SELECT * FROM balance_transactions WHERE type = 'referral_commission' ORDER BY id");
      const subscriptionsOf = async (userId) => query("SELECT * FROM user_subscriptions WHERE userId = ?", [userId]);
      const makePaidOrder = async (outTradeNo, { userId = 3, planId, amountCents, currency = "CNY", orderType = "plan" }) => {
        const nowSec = Math.floor(Date.now() / 1000);
        await exec(
          "INSERT INTO payment_orders (outTradeNo, userId, provider, paymentType, status, subject, amountCents, currency, orderType, planId, createdAt, updatedAt, paidAt) VALUES (?, ?, 'easypay', 'alipay', 'paid', '测试', ?, ?, ?, ?, ?, ?, ?)",
          [outTradeNo, userId, amountCents, currency, orderType, planId ?? null, nowSec, nowSec, nowSec],
        );
      };

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "referral.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("余额买套餐：按套餐比例返给邀请人，向下取整到分，流水不带订单号", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(999, 1050); // 9.99 元 × 10.5% = 104.895 分 → 104 分
    await billing.purchasePlanWithBalance(3, planId);
    assert.equal(await balanceOf(3), 10000 - 999, "被邀请人照常扣款");
    assert.equal(await balanceOf(2), 104, "向下取整到分");
    const rows = await commissions();
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].inviterId), 2);
    assert.equal(Number(rows[0].inviteeId), 3);
    assert.equal(rows[0].sourceType, "balance_purchase");
    assert.equal(Number(rows[0].baseAmountCents), 999);
    assert.equal(Number(rows[0].rateBps), 1050);
    assert.equal(Number(rows[0].commissionCents), 104);
    const ledger = await referralLedger();
    assert.equal(ledger.length, 1);
    assert.equal(Number(ledger[0].userId), 2);
    assert.equal(ledger[0].paymentOrderNo, null, "返利流水不能带订单号");
    assert.match(String(ledger[0].description), /b\*\*\*b/, "被邀请人要打码");
    assert.doesNotMatch(String(ledger[0].description), /bob@example\.com/);
  `);
});

test("不该返的一分不返：没开、没有邀请人、比例 0、邀请人停用、0 元套餐", () => {
  runInDatabase(String.raw`
    const paid = await makePlan(1000, 2000);
    const noRate = await makePlan(1000, 0);
    const free = await makePlan(0, 5000);

    await settings.setSetting("referralEnabled", "false");
    await billing.purchasePlanWithBalance(3, paid);
    assert.equal((await commissions()).length, 0, "返利没开");
    await settings.setSetting("referralEnabled", "true");

    await billing.purchasePlanWithBalance(4, paid);
    assert.equal((await commissions()).length, 0, "没有邀请人");

    await billing.purchasePlanWithBalance(3, noRate);
    assert.equal((await commissions()).length, 0, "比例 0 的套餐不返");

    await billing.purchasePlanWithBalance(3, free);
    assert.equal((await commissions()).length, 0, "0 元套餐不返");

    await exec("UPDATE users SET accountEnabled = 0 WHERE id = 2");
    await billing.purchasePlanWithBalance(3, paid);
    assert.equal((await commissions()).length, 0, "邀请人停用了不返");
    assert.equal(await balanceOf(2), 0);
    assert.equal((await referralLedger()).length, 0);
  `);
});

test("首单模式只返第一单；每单模式续费也返（含余额自动续费）", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 1000);
    await billing.purchasePlanWithBalance(3, planId);
    const subscriptionId = Number((await subscriptionsOf(3))[0].id);
    await billing.purchasePlanWithBalance(3, planId, null, subscriptionId);
    assert.equal((await commissions()).length, 1, "首单模式：续费不再返");
    assert.equal(await balanceOf(2), 100);

    await settings.setSetting("referralMode", "recurring");
    await billing.purchasePlanWithBalance(3, planId, null, subscriptionId);
    assert.equal((await commissions()).length, 2, "每单模式：续费也返");
    assert.equal(await balanceOf(2), 200);

    // 自动续费走的也是余额购买，同样要返。
    await exec("UPDATE user_subscriptions SET autoRenew = 1, expiresAt = ? WHERE id = ?", [Math.floor(Date.now() / 1000) + 3600, subscriptionId]);
    const renew = await billing.runSubscriptionAutoRenew();
    assert.equal(renew.renewed, 1);
    assert.equal((await commissions()).length, 3);
    assert.equal(await balanceOf(2), 300);
  `);
});

test("在线支付的套餐单：结算时返利；同一笔订单结算两次只返一次", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(5000, 1234);
    await makePaidOrder("REF-1", { planId, amountCents: 4321 }); // 折扣后实付 43.21 元
    await payment.finalizePaidOrder("REF-1");
    const order = (await query("SELECT status FROM payment_orders WHERE outTradeNo = 'REF-1'"))[0];
    assert.equal(order.status, "completed");
    assert.equal((await subscriptionsOf(3)).length, 1, "被邀请人照常开通");
    // 4321 × 12.34% = 533.2114 → 533
    assert.equal(await balanceOf(2), 533);
    const rows = await commissions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sourceType, "payment_order");
    assert.equal(rows[0].sourceRef, "REF-1");
    assert.equal(Number(rows[0].baseAmountCents), 4321, "按实付算，不按标价");

    // 已经完成的单再来一次：认领不到，什么都不发生。
    await payment.finalizePaidOrder("REF-1");
    // 订单被打回 paid 再结算一次（比如维护任务重试）：走「已经发过货」那条路，也不能再返。
    await exec("UPDATE payment_orders SET status = 'paid' WHERE outTradeNo = 'REF-1'");
    await payment.finalizePaidOrder("REF-1");
    // 直接拿同一个来源再记一次：唯一约束挡住。
    await settings.setSetting("referralMode", "recurring");
    const again = await billing.creditReferralCommissionInTransaction({
      inviteeId: 3, planId, baseAmountCents: 4321, currency: "CNY", sourceType: "payment_order", sourceRef: "REF-1",
    });
    assert.equal(again.credited, false);
    assert.equal(again.reason, "duplicate");
    assert.equal((await commissions()).length, 1);
    assert.equal(await balanceOf(2), 533, "只返一次");
    assert.equal((await subscriptionsOf(3)).length, 1);
  `);
});

test("充值单、非人民币单不返；被邀请人自己的入账不受返利流水影响", () => {
  runInDatabase(String.raw`
    // 美元单本身也是一笔已付的套餐单，首单模式下后面的人民币单就不算首单了；这里看的是币种，用每单模式。
    await settings.setSetting("referralMode", "recurring");
    const planId = await makePlan(1000, 5000);
    // 充值单：钱进了被邀请人余额，之后拿去买套餐时才返；这里返就重复了。
    await makePaidOrder("TOPUP-1", { orderType: "balance", amountCents: 2000 });
    await payment.finalizePaidOrder("TOPUP-1");
    assert.equal(await balanceOf(3), 12000);
    assert.equal((await commissions()).length, 0, "充值不返");

    // Stripe 的美元单：照常开通，但不返（余额是人民币，没有汇率可换）。
    await makePaidOrder("USD-1", { planId, amountCents: 1000, currency: "USD" });
    await payment.finalizePaidOrder("USD-1");
    assert.equal((await query("SELECT status FROM payment_orders WHERE outTradeNo = 'USD-1'"))[0].status, "completed");
    assert.equal((await subscriptionsOf(3)).length, 1);
    assert.equal((await commissions()).length, 0, "非人民币单不返");

    // 人民币套餐单：返了。返利流水不能带这个订单号 ——
    await makePaidOrder("CNY-1", { planId, amountCents: 1000 });
    await payment.finalizePaidOrder("CNY-1");
    assert.equal(await balanceOf(2), 500);
    assert.equal(await billing.getBalanceTransactionByPaymentOrderNo("CNY-1"), undefined, "被邀请人的订单号不能出现在返利流水上");

    // —— 否则被邀请人的充值单会被误判成「已入账」。这里模拟同号的情形：返利之后再结算被邀请人的充值单，钱必须到账。
    await makePaidOrder("TOPUP-2", { orderType: "balance", amountCents: 700 });
    await settings.setSetting("referralMode", "recurring");
    await billing.creditReferralCommissionInTransaction({
      inviteeId: 3, planId, baseAmountCents: 1000, currency: "CNY", sourceType: "payment_order", sourceRef: "TOPUP-2",
    });
    const before = await balanceOf(3);
    await payment.finalizePaidOrder("TOPUP-2");
    assert.equal(await balanceOf(3), before + 700, "被邀请人自己的充值照常入账");
    assert.equal((await query("SELECT status FROM payment_orders WHERE outTradeNo = 'TOPUP-2'"))[0].status, "completed");
  `);
});

test("返利出错不影响购买：撤销的是返利那一段（记录、余额、流水一起回滚）", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 1000);
    // 返利记录已经插进去、邀请人余额也改了，最后写流水时炸掉：保存点要把前两步一起撤掉。
    await exec("CREATE TRIGGER fail_referral BEFORE INSERT ON balance_transactions WHEN NEW.type = 'referral_commission' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    await billing.purchasePlanWithBalance(3, planId);
    assert.equal((await subscriptionsOf(3)).length, 1, "购买照常完成");
    assert.equal(await balanceOf(3), 9000, "照常扣款");
    assert.equal(await balanceOf(2), 0, "邀请人余额回滚");
    assert.equal((await commissions()).length, 0, "返利记录回滚");

    // 在线支付那条路也一样：订单照常完成。
    await makePaidOrder("FAIL-1", { planId, amountCents: 1000 });
    await payment.finalizePaidOrder("FAIL-1");
    assert.equal((await query("SELECT status FROM payment_orders WHERE outTradeNo = 'FAIL-1'"))[0].status, "completed");
    assert.equal((await subscriptionsOf(3)).length >= 1, true);
    assert.equal(await balanceOf(2), 0);

    // 返利表整张没了（比如半升级的库）：同样只是不返。
    await exec("DROP TRIGGER fail_referral");
    await exec("DROP TABLE referral_commissions");
    await billing.purchasePlanWithBalance(3, planId, null, Number((await subscriptionsOf(3))[0].id));
    assert.equal(await balanceOf(3), 8000);
    assert.equal(await balanceOf(2), 0);
  `);
});

test("注册绑定：对不上的码默认忽略；开了必须邀请注册就拒绝", () => {
  runInDatabase(String.raw`
    const code = await referral.getOrCreateInviteCode(2);
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    assert.equal(await referral.getOrCreateInviteCode(2), code, "生成一次就固定");
    assert.equal(await referral.resolveRegistrationInviter(code.toLowerCase()), 2, "大小写不敏感");
    assert.equal(await referral.resolveRegistrationInviter("ZZZZZZZZ"), null, "对不上就忽略");
    assert.equal(await referral.resolveRegistrationInviter(undefined), null);

    await settings.setSetting("referralForceInvite", "true");
    await assert.rejects(() => referral.resolveRegistrationInviter("ZZZZZZZZ"), /邀请码/);
    await assert.rejects(() => referral.resolveRegistrationInviter(""), /邀请码/);
    assert.equal(await referral.resolveRegistrationInviter(code), 2);

    // 邀请人停用了，他的码不算有效。
    await exec("UPDATE users SET accountEnabled = 0 WHERE id = 2");
    await assert.rejects(() => referral.resolveRegistrationInviter(code), /邀请码/);

    // 返利整体没开时，「必须邀请注册」不生效。
    await settings.setSetting("referralEnabled", "false");
    assert.equal(await referral.resolveRegistrationInviter("ZZZZZZZZ"), null);
  `);
});

test("邀请人：不能是自己，不能互相邀请；管理员可以清掉", () => {
  runInDatabase(String.raw`
    await assert.rejects(() => referral.setUserInviter(4, 4), /自己/);
    // 2 邀请了 3，再让 3 邀请 2 就成环了。
    await assert.rejects(() => referral.setUserInviter(2, 3), /循环/);
    // 绕一圈也不行：3 邀请 4 之后，4 不能再邀请 2。
    await referral.setUserInviter(4, 3);
    await assert.rejects(() => referral.setUserInviter(2, 4), /循环/);
    // 注册路径只写空的：已有邀请人不会被覆盖。
    assert.equal(await referral.setUserInviter(3, 1, { onlyIfUnset: true }), false);
    assert.equal(Number((await query("SELECT inviterId FROM users WHERE id = 3"))[0].inviterId), 2);
    await referral.setUserInviter(3, null);
    assert.equal((await query("SELECT inviterId FROM users WHERE id = 3"))[0].inviterId, null);
    const info = await referral.getAdminUserReferralInfo(3);
    assert.equal(info.inviterId, null);
    assert.equal(info.invitedCount, 1, "3 邀请了 4");
  `);
});

test("首单看的是之前有没有付过钱的套餐单：返利关着时买过的，之后不再算首单", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 1000);
    await settings.setSetting("referralEnabled", "false");
    await billing.purchasePlanWithBalance(3, planId);
    await settings.setSetting("referralEnabled", "true");

    const subscriptionId = Number((await subscriptionsOf(3))[0].id);
    const result = await billing.purchasePlanWithBalance(3, planId, null, subscriptionId);
    assert.ok(result);
    assert.equal((await commissions()).length, 0, "第二单不是首单，不返");
    assert.equal(await balanceOf(2), 0);

    // 在线支付的单同样看之前有没有付过钱的套餐单。
    await makePaidOrder("FIRST-ONLINE-2", { planId, amountCents: 1000 });
    await payment.finalizePaidOrder("FIRST-ONLINE-2");
    assert.equal((await commissions()).length, 0);
    const direct = await billing.creditReferralCommissionInTransaction({
      inviteeId: 3, planId, baseAmountCents: 1000, currency: "CNY", sourceType: "payment_order", sourceRef: "FIRST-ONLINE-3",
    });
    assert.equal(direct.reason, "first_only");
  `);
});

test("首单模式：在线支付的第一单照常返（不把自己这一单算成「之前的单」）", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 1000);
    // 没付成功的单、测试单、充值单都不算付过钱的套餐单。
    await makePaidOrder("UNPAID-1", { planId, amountCents: 1000 });
    await exec("UPDATE payment_orders SET status = 'expired' WHERE outTradeNo = 'UNPAID-1'");
    await makePaidOrder("TOPUP-FIRST", { orderType: "balance", amountCents: 500 });
    await payment.finalizePaidOrder("TOPUP-FIRST");
    await makePaidOrder("FIRST-1", { planId, amountCents: 1000 });
    await payment.finalizePaidOrder("FIRST-1");
    assert.equal((await commissions()).length, 1);
    assert.equal(await balanceOf(2), 100);
  `);
});

test("绑定邀请人之前下的单不返：管理员后补的邀请人拿不到之前的单", () => {
  runInDatabase(String.raw`
    await settings.setSetting("referralMode", "recurring");
    const planId = await makePlan(1000, 1000);
    // 4 号没有邀请人，先下了一张在线支付的单，还没付。
    const orderedAt = Math.floor(Date.now() / 1000) - 600;
    await makePaidOrder("LATE-BIND-1", { userId: 4, planId, amountCents: 1000 });
    await exec("UPDATE payment_orders SET createdAt = ? WHERE outTradeNo = 'LATE-BIND-1'", [orderedAt]);

    // 管理员把 2 号设成他的邀请人，之后那张单才付成功。
    await referral.setUserInviter(4, 2);
    const [bound] = await query("SELECT inviterBoundAt FROM users WHERE id = 4");
    assert.ok(Number(bound.inviterBoundAt) >= orderedAt + 600 - 5, "绑定时刻记下来");
    await payment.finalizePaidOrder("LATE-BIND-1");
    assert.equal((await query("SELECT status FROM payment_orders WHERE outTradeNo = 'LATE-BIND-1'"))[0].status, "completed");
    assert.equal((await commissions()).length, 0, "绑定之前下的单不返");
    const direct = await billing.creditReferralCommissionInTransaction({
      inviteeId: 4, planId, baseAmountCents: 1000, currency: "CNY", sourceType: "payment_order", sourceRef: "LATE-BIND-2",
      orderCreatedAt: orderedAt,
    });
    assert.equal(direct.reason, "before_binding");

    // 绑定之后的单照常返（每单模式）。
    await billing.purchasePlanWithBalance(4, planId);
    assert.equal((await commissions()).length, 1);
    assert.equal(await balanceOf(2), 100);

    // 换邀请人会重新记时刻；清掉邀请人时刻也清掉。
    await referral.setUserInviter(4, 1);
    assert.ok(Number((await query("SELECT inviterBoundAt FROM users WHERE id = 4"))[0].inviterBoundAt) > 0);
    await referral.setUserInviter(4, null);
    assert.equal((await query("SELECT inviterBoundAt FROM users WHERE id = 4"))[0].inviterBoundAt, null);
  `);
});

test("首单模式：管理员后补邀请人，用户之前买过的话后面那单也不算首单", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 1000);
    await billing.purchasePlanWithBalance(4, planId);
    await referral.setUserInviter(4, 2);
    await billing.purchasePlanWithBalance(4, planId, null, Number((await subscriptionsOf(4))[0].id));
    assert.equal((await commissions()).length, 0);
    assert.equal(await balanceOf(2), 0);
  `);
});

test("注册时带邀请人的，绑定时刻就是注册时刻", () => {
  runInDatabase(String.raw`
    const users = await import(url("server/repositories/userRepository.ts"));
    const before = Math.floor(Date.now() / 1000) - 1;
    const id = Number(await users.registerUser({ username: "dave@example.com", password: "pw-123456", inviterId: 2 }));
    const [row] = await query("SELECT inviterId, inviterBoundAt FROM users WHERE id = ?", [id]);
    assert.equal(Number(row.inviterId), 2);
    assert.ok(Number(row.inviterBoundAt) >= before);
    const plain = Number(await users.registerUser({ username: "erin@example.com", password: "pw-123456" }));
    assert.equal((await query("SELECT inviterBoundAt FROM users WHERE id = ?", [plain]))[0].inviterBoundAt, null);
  `);
});
