import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/**
 * 多周期定价跑在真库上。
 *
 * 这一组盯的全是钱和天数对不对得上：买年付要扣年付的钱、开年付的天数；认不出的
 * 档位必须当场拒掉而不是拿默认档顶上（那是「买的年付开出月付」）；自动续费要续
 * 上次那一档（按月付的人不该某天醒来被扣一年的钱）。
 *
 * 还有一条同样重要：**存量套餐一行没配也要照常能买**，否则这次改动会把所有老套餐
 * 变成买不了的卡片。
 */
const setup = String.raw`
    const billing = await import(url("server/repositories/billingRepository.ts"));


    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription, balanceCents) VALUES (1, 'alice', 'h', 'admin', 1, 0)");
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription, balanceCents) VALUES (2, 'bob', 'h', 'user', 1, 100000)");
    await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (10, 'hk', '203.0.113.9', 'tok', 1)");

    /** 建一个套餐；tiers 为空就是「只有默认那一档」的老形态。 */
    const makePlan = async (priceCents, durationDays, tiers = []) => Number((await billing.createSubscriptionPlan({
      name: "月付", priceCents, currency: "CNY", durationDays,
      portCount: 10, maxRules: 10, allowProxySubscription: true,
      isActive: true, isStoreVisible: true,
    }, [10], [], [], [], [], tiers)).id);

    const balanceOf = async (userId = 2) => Number((await query("SELECT balanceCents FROM users WHERE id = ?", [userId]))[0].balanceCents);
    const subscriptionRow = async () => (await query("SELECT * FROM user_subscriptions WHERE userId = 2 ORDER BY id DESC LIMIT 1"))[0];
    /** 到期时间距今多少天（四舍五入）—— 直接比时间戳会被跑测试花掉的那几毫秒干扰。 */
    const daysLeft = async () => {
      const row = await subscriptionRow();
      return Math.round((Number(row.expiresAt) - Math.floor(Date.now() / 1000)) / 86400);
    };
`;

function runInDatabase(body: string) {
  runSharedDatabaseTest(body, { name: "plan-pricing", setup });
}

test("没配多周期的老套餐照常能买 —— 这次改动不能把存量套餐变成买不了的卡片", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30);
    const plan = await billing.getSubscriptionPlanById(planId);
    assert.deepEqual(plan.priceTiers, [], "没配就是空的，不该凭空造出档位");

    await billing.purchasePlanWithBalance(2, planId);
    assert.equal(await balanceOf(), 99000);
    assert.equal(await daysLeft(), 30);
  `);
});

test("买哪一档就扣哪一档的钱、开哪一档的天数", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);

    await billing.purchasePlanWithBalance(2, planId, null, null, 365);
    // 拿主表默认价（1000）去扣年付的单，等于按月付的钱卖了一年。
    assert.equal(await balanceOf(), 100000 - 9600);
    assert.equal(await daysLeft(), 365);
    assert.equal(Number((await subscriptionRow()).durationDays), 365, "买的档要记在订阅上");
  `);
});

test("认不出的周期当场拒掉，不能拿默认档顶上", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);

    await assert.rejects(
      () => billing.purchasePlanWithBalance(2, planId, null, null, 180),
      /购买周期/,
      "顶上默认档就成了「我买的是年付，开出来是月付」",
    );
    assert.equal(await balanceOf(), 100000, "拒掉的单不能扣钱");
  `);
});

test("默认档同步回套餐主表 —— 兑换码和后台分配读的是那两列", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(9999, 30, [
      { durationDays: 90, priceCents: 2700 },
      { durationDays: 365, priceCents: 9600 },
    ]);
    const plan = await billing.getSubscriptionPlanById(planId);
    // 总价最低那一档（季付 2700）成为默认档；原来填的 9999/30 被顶掉。
    assert.equal(Number(plan.priceCents), 2700);
    assert.equal(Number(plan.durationDays), 90);
    assert.equal(plan.priceTiers.length, 2);

    // 不传周期 = 默认档。
    await billing.purchasePlanWithBalance(2, planId);
    assert.equal(await balanceOf(), 100000 - 2700);
    assert.equal(await daysLeft(), 90);
  `);
});

test("改套餐时清空档位，退回只有默认那一档的老形态", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);
    await billing.updateSubscriptionPlan(planId, {}, undefined, undefined, undefined, undefined, undefined, []);
    const plan = await billing.getSubscriptionPlanById(planId);
    assert.deepEqual(plan.priceTiers, []);
    // 年付没了，就该买不到了。
    await assert.rejects(() => billing.purchasePlanWithBalance(2, planId, null, null, 365), /购买周期/);
    await billing.purchasePlanWithBalance(2, planId);
    assert.equal(await daysLeft(), 30);
  `);
});

test("自动续费续上次买的那一档，不是默认档", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);
    await billing.purchasePlanWithBalance(2, planId, null, null, 365);
    await exec("UPDATE user_subscriptions SET autoRenew = 1 WHERE userId = 2");
    await exec("UPDATE user_subscriptions SET expiresAt = ? WHERE userId = 2", [Math.floor(Date.now() / 1000) + 6 * 3600]);
    const before = await balanceOf();

    const result = await billing.runSubscriptionAutoRenew();
    assert.equal(result.renewed, 1);
    // 按默认档续就是「说好按年付的，结果只给了一个月」。
    assert.equal(before - (await balanceOf()), 9600);
    assert.ok(await daysLeft() > 300, "要按年续，不是按月续");
  `);
});

test("按月付的人不会被扣成年付", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);
    await billing.purchasePlanWithBalance(2, planId, null, null, 30);
    await exec("UPDATE user_subscriptions SET autoRenew = 1 WHERE userId = 2");
    await exec("UPDATE user_subscriptions SET expiresAt = ? WHERE userId = 2", [Math.floor(Date.now() / 1000) + 6 * 3600]);
    const before = await balanceOf();

    await billing.runSubscriptionAutoRenew();
    assert.equal(before - (await balanceOf()), 1000, "月付续月付");
  `);
});

test("上次那一档被下掉了：退回默认档续，而不是不续", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);
    await billing.purchasePlanWithBalance(2, planId, null, null, 365);
    await exec("UPDATE user_subscriptions SET autoRenew = 1 WHERE userId = 2");
    await exec("UPDATE user_subscriptions SET expiresAt = ? WHERE userId = 2", [Math.floor(Date.now() / 1000) + 6 * 3600]);
    // 管理员把年付下掉了。
    await billing.updateSubscriptionPlan(planId, {}, undefined, undefined, undefined, undefined, undefined, [
      { durationDays: 30, priceCents: 1000 },
    ]);
    const before = await balanceOf();

    const result = await billing.runSubscriptionAutoRenew();
    assert.equal(result.renewed, 1, "断服比降档更糟，所以退回默认档继续续");
    assert.equal(before - (await balanceOf()), 1000);
  `);
});

test("余额只够月付时，年付的续费安静跳过，不能扣成负数", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);
    await billing.purchasePlanWithBalance(2, planId, null, null, 365);
    await exec("UPDATE users SET balanceCents = 2000 WHERE id = 2");
    await exec("UPDATE user_subscriptions SET autoRenew = 1 WHERE userId = 2");
    await exec("UPDATE user_subscriptions SET expiresAt = ? WHERE userId = 2", [Math.floor(Date.now() / 1000) + 6 * 3600]);

    const result = await billing.runSubscriptionAutoRenew();
    assert.equal(result.renewed, 0);
    assert.equal(result.failed, 1);
    // 余额够月付，但他买的是年付 —— 不能擅自降档扣掉那 1000。
    assert.equal(await balanceOf(), 2000);
  `);
});

test("换档续期：从月付改买年付之后，下次自动续费跟着变成年付", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);
    await billing.purchasePlanWithBalance(2, planId, null, null, 30);
    const subscriptionId = Number((await subscriptionRow()).id);
    await billing.purchasePlanWithBalance(2, planId, null, subscriptionId, 365);
    assert.equal(Number((await subscriptionRow()).durationDays), 365, "续期也要更新记着的档位");
  `);
});

test("删套餐时把它的档位一起删掉，不留孤儿行", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);
    await billing.deleteSubscriptionPlan(planId);
    const left = await query("SELECT COUNT(*) AS n FROM subscription_plan_prices WHERE planId = ?", [planId]);
    assert.equal(Number(left[0].n), 0);
  `);
});

test("后台手动分配也能按档给：卖月付/年付的套餐，管理员给得了年付", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);

    // 分配走的是 applySubscriptionToUser 的 override 参数（路由层校验档位是否存在）。
    await billing.applySubscriptionToUser(2, planId, "admin", null, undefined, 365);
    assert.equal(await daysLeft(), 365);
    // 手动分配不扣钱。
    assert.equal(await balanceOf(), 100000);
  `);
});

test("多档套餐：兑换码按自己写的天数发，不受档位限制", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000, 30, [
      { durationDays: 30, priceCents: 1000 },
      { durationDays: 365, priceCents: 9600 },
    ]);
    const codes = await billing.createRedemptionCodes({
      type: "plan", planId, durationDays: 90, amountCents: 0, isActive: true, createdByUserId: 1,
    }, 1);
    await billing.redeemCode(2, codes[0]);
    // 兑换码是另一套：它自带天数，不该被套餐档位改写。
    assert.equal(await daysLeft(), 90);
  `);
});
