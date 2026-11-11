import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/**
 * 套餐与按量计费资源的库存，跑在真的 SQLite 上。
 *
 * 防超售那几条不能在一个进程里并发 —— 进程内的锁（withTrafficBillingUserLock 之类）
 * 会把并发直接排成串行，测不出数据库那一层到底有没有守住。所以竞争的买家各开一个
 * 独立的 Node 进程，彼此只共享库文件：等所有进程都连好库、热好模块，再同时放行。
 * 这和多个面板实例共用一个库是同一种情形。
 */

/** 竞争用的工作进程：连同一份库，收到任务就做一次购买 / 下单 / 建规则，回报结果后退出。 */
const WORKER = String.raw`
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  console.info = () => {}; console.warn = () => {}; console.log = () => {};
  const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(url("server/dbRuntime.ts"));
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
  const billing = await import(url("server/repositories/billingRepository.ts"));
  const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
  await runtime.queryRaw("SELECT 1");
  process.on("message", async (job) => {
    let reply;
    try {
      if (job.op === "balance") await billing.purchasePlanWithBalance(job.userId, job.planId);
      else if (job.op === "order") {
        await billing.createPaymentOrder({
          outTradeNo: "RACE-" + job.userId + "-" + job.seq, userId: job.userId, provider: "stripe", paymentType: "stripe",
          status: "pending", subject: "stock", amountCents: 100, orderType: "plan", planId: job.planId,
        });
      } else {
        await rules.createForwardRule({
          hostId: job.hostId, userId: job.userId, name: "race", forwardType: "realm", protocol: "both",
          sourcePort: 30000 + job.seq, targetIp: "127.0.0.1", targetPort: 80,
        });
      }
      reply = { ok: true, userId: job.userId };
    } catch (error) {
      reply = { ok: false, userId: job.userId, error: String(error?.message || error) };
    }
    process.send(reply, () => process.exit(0));
  });
  process.send({ ready: true });
`;

const setup = String.raw`
  const { spawn } = await import("node:child_process");
  const billing = await import(url("server/repositories/billingRepository.ts"));
  const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
  const traffic = await import(url("server/repositories/trafficBillingRepository.ts"));
  const settings = await import(url("server/repositories/settingsRepository.ts"));

  await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (1, 'admin', 'h', 'admin', 100000)");
  for (let id = 2; id <= 7; id++) {
    await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (?, ?, 'h', 'user', 100000)", [id, "buyer" + id]);
  }
  for (const id of [10, 11, 12, 13]) {
    await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (?, ?, '203.0.113.9', ?, 1)", [id, "host" + id, "tok" + id]);
  }

  /** 绑在主机 10 上的套餐，库存 stockLimit（0 = 不限）。 */
  const makePlan = async (stockLimit, priceCents = 1000) => {
    const id = Number((await billing.createSubscriptionPlan({
      name: "限量套餐", priceCents, currency: "CNY", durationDays: 30, portCount: 2, maxRules: 10,
      isActive: true, isStoreVisible: true,
    }, [10], [], [])).id);
    await exec("UPDATE subscription_plans SET stockLimit = ? WHERE id = ?", [stockLimit, id]);
    return id;
  };
  const planStock = async (planId) => {
    const row = (await query("SELECT stockLimit, stockUsed FROM subscription_plans WHERE id = ?", [planId]))[0];
    return { limit: Number(row.stockLimit), used: Number(row.stockUsed) };
  };
  const count = async (sql, params = []) => Number((await query(sql, params))[0].n);
  const balanceOf = async (userId) => Number((await query("SELECT balanceCents FROM users WHERE id = ?", [userId]))[0].balanceCents);
  const order = (outTradeNo, planId, userId = 2, extra = {}) => billing.createPaymentOrder({
    outTradeNo, userId, provider: "stripe", paymentType: "stripe", status: "pending",
    subject: "stock", amountCents: 100, orderType: "plan", planId, ...extra,
  });
  const orderRow = async (outTradeNo) => (await query("SELECT * FROM payment_orders WHERE outTradeNo = ?", [outTradeNo]))[0];

  await settings.setSetting("trafficBillingEnabled", "true");
  const meteredConfig = async (hostId, stockLimit, maxRulesPerUser = 0) => runtime.insertAndGetId("traffic_billing_configs", {
    resourceType: "host", resourceId: hostId, enabled: true, pricePerGbCents: 1, pricePerGbMilliCents: 1000,
    stockLimit, maxRulesPerUser,
  });
  let nextPort = 20000;
  const rule = (userId, hostId = 10, extra = {}) => rules.createForwardRule({
    hostId, userId, name: "r", forwardType: "realm", protocol: "both",
    sourcePort: nextPort++, targetIp: "127.0.0.1", targetPort: 80, ...extra,
  });
  const configUsage = async (viewerUserId) => new Map((await traffic.listTrafficBillingConfigs(viewerUserId))
    .map((config) => [Number(config.id), { used: config.stockUsed, mine: config.currentUserRuleCount }]));

  /** 每个任务一个独立进程；全部 ready 之后同时放行，返回各自的结果。 */
  const race = async (jobs) => {
    const workers = jobs.map((job, seq) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", ${JSON.stringify(WORKER)}], {
        cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      let ready, done;
      const readyPromise = new Promise((resolve) => { ready = resolve; });
      const result = new Promise((resolve) => { done = resolve; });
      child.on("message", (message) => message.ready ? ready() : done(message));
      const exited = new Promise((resolve, reject) => child.on("exit", (code) => (
        code === 0 ? resolve() : reject(new Error("worker exited " + code + ": " + output))
      )));
      return { child, job: { ...job, seq }, readyPromise, result, exited };
    });
    const timer = setTimeout(() => workers.forEach(({ child }) => child.kill()), 60_000);
    try {
      await Promise.race([
        Promise.all(workers.map((worker) => worker.readyPromise)),
        Promise.all(workers.map((worker) => worker.exited)).then(() => { throw new Error("workers exited before ready"); }),
      ]);
      for (const worker of workers) worker.child.send(worker.job);
      await Promise.all(workers.map((worker) => worker.exited));
      return await Promise.all(workers.map((worker) => worker.result));
    } finally {
      clearTimeout(timer);
    }
  };
`;

function runInDatabase(body: string) {
  runSharedDatabaseTest(body, { name: "product-stock", setup, quiet: true, timeoutMs: 180_000 });
}

test("并发余额购买不超售：5 个独立进程抢 2 份，只成交 2 份，没买到的不扣钱", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(2);
    const results = await race([2, 3, 4, 5, 6].map((userId) => ({ op: "balance", userId, planId })));
    const winners = results.filter((item) => item.ok);
    assert.equal(winners.length, 2, JSON.stringify(results));
    for (const loser of results.filter((item) => !item.ok)) assert.match(loser.error, /库存不足或已售罄/);
    assert.deepEqual(await planStock(planId), { limit: 2, used: 2 });
    assert.equal(await count("SELECT COUNT(*) AS n FROM user_subscriptions WHERE planId = ?", [planId]), 2);
    for (const item of results) {
      assert.equal(await balanceOf(item.userId), item.ok ? 99000 : 100000, "没买到的一分钱不扣：扣款和占额在同一个事务里回滚");
    }
  `);
});

test("并发在线下单不超售：4 个独立进程抢最后 1 份，只建出 1 笔占库存的待支付订单", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1);
    const results = await race([2, 3, 4, 5].map((userId) => ({ op: "order", userId, planId })));
    assert.equal(results.filter((item) => item.ok).length, 1, JSON.stringify(results));
    assert.deepEqual(await planStock(planId), { limit: 1, used: 1 });
    assert.equal(await count("SELECT COUNT(*) AS n FROM payment_orders"), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM payment_orders WHERE stockReserved = 1"), 1);
  `);
});

test("未付款订单关闭后退回库存，只退一次；已付款的订单不退；续费单不占库存", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1);
    for (const status of ["expired", "failed", "cancelled"]) {
      await order("O-" + status, planId);
      assert.equal((await planStock(planId)).used, 1);
      await assert.rejects(() => order("O-" + status + "-late", planId, 3), /库存不足或已售罄/, "待支付订单占着最后一份");
      // 两次关单同时到（回调 + 过期扫描），只能退一份。
      await Promise.all([
        billing.updatePaymentOrder("O-" + status, { status }),
        billing.updatePaymentOrder("O-" + status, { status }),
      ]);
      assert.equal((await planStock(planId)).used, 0, status + " 关单后退回");
      assert.equal(Number((await orderRow("O-" + status)).stockReserved), 0);
    }

    // 过期扫描走的是支付模块那条关单路径，也要退。
    const payment = await import(url("server/payment.ts"));
    await order("O-sweep", planId, 2, { expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await planStock(planId)).used, 1);
    await payment.expireStalePendingOrders();
    assert.equal((await orderRow("O-sweep")).status, "expired");
    assert.equal((await planStock(planId)).used, 0);

    // 已付款：货可能已经发了，即使之后被改成关闭状态也不退。
    await order("O-paid", planId);
    await billing.markPaymentOrderPaid("O-paid", { tradeNo: "t" });
    await billing.updatePaymentOrder("O-paid", { status: "expired" });
    assert.equal((await planStock(planId)).used, 1);

    // 发货：下单时已经占过，不再占第二份；重复回调同样不占。
    await exec("UPDATE subscription_plans SET stockLimit = 2 WHERE id = ?", [planId]);
    await order("O-deliver", planId);
    assert.equal((await planStock(planId)).used, 2);
    await billing.markPaymentOrderPaid("O-deliver", { tradeNo: "t2" });
    await payment.finalizePaidOrder("O-deliver");
    await payment.finalizePaidOrder("O-deliver");
    assert.equal((await orderRow("O-deliver")).status, "completed");
    assert.equal((await planStock(planId)).used, 2);

    // 续费：售罄也能续，不占库存（余额续费、在线续费单都是）。
    const subscriptionId = Number((await query("SELECT id FROM user_subscriptions WHERE paymentOrderNo = 'O-deliver'"))[0].id);
    await billing.purchasePlanWithBalance(2, planId, null, subscriptionId);
    const renewal = await order("O-renew", planId, 2, { subscriptionId });
    assert.equal(Number(renewal.stockReserved), 0);
    assert.equal((await planStock(planId)).used, 2);
    // 卖出去的到期不退。
    await exec("UPDATE user_subscriptions SET expiresAt = ? WHERE id = ?", [Math.floor(Date.now() / 1000) - 10, subscriptionId]);
    await billing.expireUserSubscriptions();
    assert.equal((await planStock(planId)).used, 2);
  `);
});

test("管理员分配、兑换码都占库存；售罄时兑换失败、码不作废；分不到端口时库存跟着回滚", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(2, 0);
    await billing.applySubscriptionToUser(2, planId, "admin", null);
    assert.equal((await planStock(planId)).used, 1);
    const [code] = await billing.createRedemptionCodes({ type: "plan", planId, durationDays: 30, isActive: true }, 1);
    await billing.redeemCode(3, code);
    assert.deepEqual(await planStock(planId), { limit: 2, used: 2 });

    const [spare] = await billing.createRedemptionCodes({ type: "plan", planId, durationDays: 30, isActive: true }, 1);
    await assert.rejects(() => billing.redeemCode(4, spare), /库存不足或已售罄/);
    assert.equal((await query("SELECT usedByUserId FROM redemption_codes WHERE code = ?", [spare]))[0].usedByUserId, null);
    await assert.rejects(() => billing.applySubscriptionToUser(4, planId, "admin", null), /库存不足或已售罄/);

    // 端口段分不到：占的那一份、扣的钱都不能留下。
    const hugePlan = await makePlan(1);
    await exec("UPDATE subscription_plans SET portCount = 70000 WHERE id = ?", [hugePlan]);
    await assert.rejects(() => billing.purchasePlanWithBalance(5, hugePlan), /端口不足/);
    assert.equal((await planStock(hugePlan)).used, 0);
    assert.equal(await balanceOf(5), 100000);

    // 不限库存时也累计销量，日后改限量能在这个数上设总量。
    const unlimited = await makePlan(0);
    await billing.purchasePlanWithBalance(5, unlimited);
    assert.deepEqual(await planStock(unlimited), { limit: 0, used: 1 });

    // 升级时重跑建表不会把已占用清零。
    await schema.ensureDatabaseSchema();
    assert.deepEqual(await planStock(planId), { limit: 2, used: 2 });
  `);
});

test("老订单（下单时没占库存）付款后补占；售罄时实付转入余额、不开通", () => {
  runInDatabase(String.raw`
    const payment = await import(url("server/payment.ts"));
    const planId = await makePlan(1);
    const paidOrder = (outTradeNo, userId) => exec(
      "INSERT INTO payment_orders (outTradeNo, userId, provider, paymentType, status, subject, amountCents, currency, orderType, planId, stockReserved) VALUES (?, ?, 'stripe', 'stripe', 'paid', 'legacy', 500, 'CNY', 'plan', ?, 0)",
      [outTradeNo, userId, planId],
    );
    await paidOrder("LEGACY-1", 2);
    await payment.finalizePaidOrder("LEGACY-1");
    assert.equal((await orderRow("LEGACY-1")).status, "completed");
    assert.equal(Number((await orderRow("LEGACY-1")).stockReserved), 1, "补占记到订单上，重放回调不会再占");
    assert.deepEqual(await planStock(planId), { limit: 1, used: 1 });

    await paidOrder("LEGACY-2", 3);
    await payment.finalizePaidOrder("LEGACY-2");
    const late = await orderRow("LEGACY-2");
    assert.equal(late.status, "completed");
    assert.match(late.subject, /已转入余额/);
    assert.equal(await balanceOf(3), 100500, "钱收了却没货：实付转入余额");
    assert.equal(await count("SELECT COUNT(*) AS n FROM user_subscriptions WHERE userId = 3"), 0);
    assert.deepEqual(await planStock(planId), { limit: 1, used: 1 }, "不超售");
  `);
});

test("并发建规则不超售按量资源：4 个账号抢 1 席只成 1 个；删掉他的规则后席位让出", () => {
  runInDatabase(String.raw`
    const configId = await meteredConfig(12, 1);
    const results = await race([2, 3, 4, 5].map((userId) => ({ op: "rule", userId, hostId: 12 })));
    const winners = results.filter((item) => item.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    for (const loser of results.filter((item) => !item.ok)) assert.match(loser.error, /库存不足或已售罄/);
    assert.equal((await configUsage()).get(configId).used, 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM forward_rules WHERE hostId = 12"), 1);

    const winnerRule = Number((await query("SELECT id FROM forward_rules WHERE hostId = 12"))[0].id);
    const loser = results.find((item) => !item.ok).userId;
    await rules.deleteForwardRule(winnerRule);
    assert.equal((await configUsage()).get(configId).used, 0, "最后一条逻辑规则删除后释放");
    await rule(loser, 12);
    assert.equal((await configUsage()).get(configId).used, 1);
  `);
});

test("同一账号并发建规则也守得住每账号规则上限（库存不限时一样）", () => {
  runInDatabase(String.raw`
    const configId = await meteredConfig(13, 0, 2);
    await rule(2, 13);
    const results = await race([2, 2, 2].map((userId) => ({ op: "rule", userId, hostId: 13 })));
    assert.equal(results.filter((item) => item.ok).length, 1, JSON.stringify(results));
    for (const loser of results.filter((item) => !item.ok)) assert.match(loser.error, /每账号规则上限/);
    const usage = (await configUsage(2)).get(configId);
    assert.equal(usage.used, 1, "一个账号只占一席");
    assert.equal(usage.mine, 2);
  `);
});

test("按量库存按账号占用：子规则不算、停用仍占、删光才释放，恢复 / 换主人 / 换资源都重新校验", () => {
  runInDatabase(String.raw`
    const configId = await meteredConfig(10, 1, 2);
    const otherConfig = await meteredConfig(11, 1);
    const first = await rule(2);
    // 转发组 / 线路组展开出来的子规则不占规则数，也不额外占席。
    await rule(2, 10, { forwardGroupRuleId: first, forwardGroupMemberId: 1 });
    await rule(2, 10, { routeParentRuleId: first, routePathKey: "p1", routeHopIndex: 1 });
    const second = await rule(2);
    assert.deepEqual((await configUsage(2)).get(configId), { used: 1, mine: 2 });
    await assert.rejects(() => rule(2), /每账号规则上限/);
    await assert.rejects(() => rule(3), /库存不足或已售罄/);
    // 管理员用自己的资源不计费，不是买家，不占席位。
    await rule(1);
    assert.equal((await configUsage()).get(configId).used, 1);

    // 改端口这类不动席位的修改照常能写。
    await rules.updateForwardRule(first, { targetPort: 81 });
    // 停用仍占额。
    await rules.updateForwardRule(first, { isEnabled: false });
    await rules.updateForwardRule(second, { isEnabled: false });
    await assert.rejects(() => rule(3), /库存不足或已售罄/, "停用的规则仍占着席位");

    await rules.deleteForwardRule(first);
    assert.equal((await configUsage()).get(configId).used, 1, "还剩一条逻辑规则，席位不放");
    await rules.deleteForwardRule(second);
    assert.equal((await configUsage()).get(configId).used, 0, "最后一条逻辑规则删除后释放");

    const third = await rule(3);
    await assert.rejects(() => rules.updateForwardRule(second, { pendingDelete: false }), /库存不足或已售罄/, "从待删除恢复要重新占席");
    // 换主人：席位跟着规则走到新账号，原账号的席位让出、但被新账号占着，第三个人仍进不来。
    await rules.updateForwardRule(third, { userId: 2 });
    assert.equal(Number((await rules.getForwardRuleById(third)).userId), 2);
    await assert.rejects(() => rule(3), /库存不足或已售罄/);

    // 换资源：目标资源满了就拒，规则留在原处。
    await rule(4, 11);
    await assert.rejects(() => rules.updateForwardRule(third, { hostId: 11 }), /库存不足或已售罄/);
    assert.equal(Number((await rules.getForwardRuleById(third)).hostId), 10);
    assert.equal((await configUsage()).get(otherConfig).used, 1);
    assert.equal((await configUsage()).get(configId).used, 1);

    // 只改单价的保存（主机管理里那个弹窗）不会把库存设置冲回不限。
    await traffic.upsertTrafficBillingConfig({ id: configId, resourceType: "host", resourceId: 10, enabled: true, pricePerGbMilliCents: 2000 });
    const saved = (await query("SELECT stockLimit, maxRulesPerUser FROM traffic_billing_configs WHERE id = ?", [configId]))[0];
    assert.deepEqual([Number(saved.stockLimit), Number(saved.maxRulesPerUser)], [1, 2]);

    // 关掉按量计费：库存不再限制建规则。
    await settings.setSetting("trafficBillingEnabled", "false");
    await rule(6);
  `);
});
