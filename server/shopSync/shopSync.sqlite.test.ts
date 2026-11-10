import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 商城对接：商城那边买了 / 续了 / 换了 / 退了，NEX 这边跟着开通、续期、换套餐、停用。
 *
 * 这一组守的是「对账不出错」：
 * - 同一个订单号来几次都只开一次；
 * - 续期叠在原到期时间上，不从今天重新算；
 * - 先到的停用挡住后到的、更早的开通（回调乱序）；
 * - 没映射的套餐不乱开，补了映射重发能成；
 * - 只动商城开出来的那条订阅，用户自己的不碰；同邮箱的老账号默认不接管，管理员永远不接管。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-shop-sync-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const billing = await import(url("server/repositories/billingRepository.ts"));
      const shop = await import(url("server/shopSync/service.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role, email) VALUES (1, 'root', 'h', 'admin', 'root@example.com')");
      await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (10, 'hk', '203.0.113.9', 'tok', 1)");

      const makePlan = async (name, extra = {}) => Number((await billing.createSubscriptionPlan({
        name, priceCents: 0, currency: "CNY", durationDays: 30,
        portCount: 5, maxRules: 10, rateLimitMbps: 100, allowProxySubscription: false,
        isActive: true, isStoreVisible: true, ...extra,
      }, [10], [], [], [], [])).id);
      const planA = await makePlan("月付 A");
      const planB = await makePlan("月付 B", { rateLimitMbps: 300 });

      const configure = (extra = {}) => shop.saveShopSyncConfig({
        enabled: true, shop: "xboard", linkExistingByEmail: false,
        plans: [{ shopPlanId: "1", planId: planA }, { shopPlanId: "2", planId: planB }],
        ...extra,
      });
      await configure();

      const nowSec = Math.floor(Date.now() / 1000);
      const DAY = 86400;
      const apply = (event) => shop.applyShopSyncEvent(event);
      const subsOf = async (userId) => query("SELECT id, planId, status, source, expiresAt, portRangeStart, portRangeEnd FROM user_subscriptions WHERE userId = ? ORDER BY id", [userId]);
      const bindingOf = async (externalId) => (await query("SELECT * FROM shop_sync_users WHERE externalUserId = ?", [externalId]))[0];
      const orderOf = async (orderId) => (await query("SELECT * FROM shop_sync_orders WHERE orderId = ?", [orderId]))[0];
      const near = (actual, expected, label) => assert.ok(Math.abs(Number(actual) - expected) <= 120, label + ": " + actual + " vs " + expected);

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "shop.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("商城新用户买了套餐：NEX 建一个普通用户，按套餐开出订阅和端口段，只在这一次回初始密码", () => {
  runInDatabase(String.raw`
    const result = await apply({ action: "open", orderId: "T1001", user: { externalId: "42", email: "Alice@Example.com" }, shopPlanId: 1, occurredAt: nowSec });
    assert.equal(result.status, "applied", result.message);
    assert.equal(result.kind, "opened");
    assert.equal(result.user.created, true);
    assert.equal(result.user.username, "alice@example.com");
    assert.ok(result.user.initialPassword && result.user.initialPassword.length >= 16);

    const user = (await query("SELECT id, role, email FROM users WHERE id = ?", [result.user.id]))[0];
    assert.equal(user.role, "user");
    assert.equal(user.email, "alice@example.com");
    const subs = await subsOf(result.user.id);
    assert.equal(subs.length, 1);
    assert.equal(Number(subs[0].planId), planA);
    assert.equal(subs[0].source, "admin", "钱是在商城收的，NEX 账本里记 0 元的 admin 来源，用户也不能在 NEX 自己续");
    assert.equal(Number(subs[0].portRangeEnd) - Number(subs[0].portRangeStart) + 1, 5, "端口段按套餐的端口数分");
    near(subs[0].expiresAt, nowSec + 30 * DAY, "没给到期时间就按套餐时长");

    const binding = await bindingOf("42");
    assert.equal(Number(binding.localUserId), result.user.id);
    assert.equal(Number(binding.createdByShop), 1);
    assert.equal(Number(binding.subscriptionId), Number(subs[0].id));
  `);
});

test("同一个订单号重复回调：原样回上次结果，不再开一次、不再叠时长，也不再回密码", () => {
  runInDatabase(String.raw`
    const first = await apply({ action: "open", orderId: "T2001", user: { externalId: "7", email: "bob@example.com" }, shopPlanId: "1", occurredAt: nowSec });
    const before = await subsOf(first.user.id);
    const again = await apply({ action: "open", orderId: "T2001", user: { externalId: "7", email: "bob@example.com" }, shopPlanId: "1", occurredAt: nowSec });
    assert.equal(again.duplicate, true);
    assert.equal(again.status, "applied");
    assert.equal(again.user.initialPassword, undefined);
    const renew = { action: "renew", orderId: "T2002", user: { externalId: "7" }, shopPlanId: "1", durationDays: 30, occurredAt: nowSec + 10 };
    await apply(renew);
    await apply(renew);
    await apply(renew);
    const after = await subsOf(first.user.id);
    assert.equal(after.length, 1, "只有一条订阅");
    near(after[0].expiresAt, Number(before[0].expiresAt) + 30 * DAY, "续费订单重发三次也只叠一次");
    assert.equal(Number((await orderOf("T2002")).attempts), 1, "重复的回调不算重试");
    assert.equal(Number((await query("SELECT COUNT(*) AS n FROM users WHERE email = 'bob@example.com'"))[0].n), 1);
  `);
});

test("续期：按天数叠在原到期时间上；商城给了到期时间就照它对齐", () => {
  runInDatabase(String.raw`
    const opened = await apply({ action: "open", orderId: "R1", user: { externalId: "9" }, shopPlanId: "1", occurredAt: nowSec });
    const base = Number((await subsOf(opened.user.id))[0].expiresAt);
    const renewed = await apply({ action: "renew", orderId: "R2", user: { externalId: "9" }, shopPlanId: "1", durationDays: 90, occurredAt: nowSec + 1 });
    assert.equal(renewed.kind, "renewed");
    near((await subsOf(opened.user.id))[0].expiresAt, base + 90 * DAY, "叠在原到期时间上，不是从今天算");

    const target = nowSec + 200 * DAY;
    const aligned = await apply({ action: "renew", orderId: "R3", user: { externalId: "9" }, shopPlanId: "1", expiresAt: target, occurredAt: nowSec + 2 });
    assert.equal(aligned.kind, "renewed");
    assert.equal(Number((await subsOf(opened.user.id))[0].expiresAt), target);

    const same = await apply({ action: "renew", orderId: "state-9-a", user: { externalId: "9" }, shopPlanId: "1", expiresAt: target * 1000, occurredAt: nowSec + 3 });
    assert.equal(same.kind, "noop", "毫秒的同一个到期时间：不用动");
    assert.equal((await subsOf(opened.user.id)).length, 1);
  `);
});

test("变更套餐：先开新的再停旧的，新订阅按新套餐的限速和到期时间", () => {
  runInDatabase(String.raw`
    const opened = await apply({ action: "open", orderId: "C1", user: { externalId: "11" }, shopPlanId: "1", occurredAt: nowSec });
    const expiresAt = nowSec + 365 * DAY;
    const changed = await apply({ action: "change", orderId: "C2", user: { externalId: "11" }, shopPlanId: "2", expiresAt, occurredAt: nowSec + 5 });
    assert.equal(changed.status, "applied", changed.message);
    assert.equal(changed.kind, "changed");
    const subs = await subsOf(opened.user.id);
    assert.equal(subs.length, 2);
    assert.equal(subs[0].status, "cancelled", "旧套餐停掉");
    assert.equal(Number(subs[1].planId), planB);
    assert.equal(subs[1].status, "active");
    assert.equal(Number(subs[1].expiresAt), expiresAt);
    assert.equal(Number((await bindingOf("11")).subscriptionId), Number(subs[1].id), "绑定改指向新订阅");
    const user = (await query("SELECT gostRateLimitIn, gostRateLimitOut FROM users WHERE id = ?", [opened.user.id]))[0];
    assert.equal(Number(user.gostRateLimitIn), 300, "限速跟着新套餐走");
    assert.equal(Number(user.gostRateLimitOut), 300);
  `);
});

test("停用：停掉商城开的那条；用户自己的订阅不碰", () => {
  runInDatabase(String.raw`
    const opened = await apply({ action: "open", orderId: "S1", user: { externalId: "12" }, shopPlanId: "1", occurredAt: nowSec });
    await billing.applySubscriptionToUser(opened.user.id, planB, "balance");
    const stopped = await apply({ action: "stop", orderId: "S2", user: { externalId: "12" }, occurredAt: nowSec + 60 });
    assert.equal(stopped.status, "applied");
    assert.equal(stopped.kind, "stopped");
    const subs = await subsOf(opened.user.id);
    assert.equal(subs.find((sub) => Number(sub.planId) === planA).status, "cancelled");
    assert.equal(subs.find((sub) => Number(sub.planId) === planB).status, "active", "用户在 NEX 自己买的那条照旧");
    assert.equal((await bindingOf("12")).status, "stopped");

    const again = await apply({ action: "stop", orderId: "S3", user: { externalId: "12" }, occurredAt: nowSec + 120 });
    assert.equal(again.kind, "noop", "再停一次没有东西可停");
    const reopened = await apply({ action: "open", orderId: "S4", user: { externalId: "12" }, shopPlanId: "1", occurredAt: nowSec + 180 });
    assert.equal(reopened.kind, "opened", "停用之后的新订单照常开");
  `);
});

test("商城套餐没有映射：不建用户、不开通，记一条提示；补上映射后同一个订单号重发就能成", () => {
  runInDatabase(String.raw`
    const missing = await apply({ action: "open", orderId: "M1", user: { externalId: "13", email: "carol@example.com" }, shopPlanId: "99", occurredAt: nowSec });
    assert.equal(missing.status, "unmapped");
    assert.equal(missing.ok, false);
    assert.match(missing.message, /99/);
    assert.equal((await query("SELECT COUNT(*) AS n FROM users WHERE email = 'carol@example.com'"))[0].n, 0);
    assert.equal((await orderOf("M1")).status, "unmapped");

    await configure({ plans: [{ shopPlanId: "99", planId: planB }] });
    const retried = await apply({ action: "open", orderId: "M1", user: { externalId: "13", email: "carol@example.com" }, shopPlanId: "99", occurredAt: nowSec });
    assert.equal(retried.status, "applied", retried.message);
    assert.equal(retried.duplicate, false);
    assert.equal(Number((await orderOf("M1")).attempts), 2);
  `);
});

test("乱序：停用先到、更早的开通后到 —— 开通被忽略；之后真的新订单照常开", () => {
  runInDatabase(String.raw`
    const stopFirst = await apply({ action: "stop", orderId: "refund-T5", user: { externalId: "14", email: "dave@example.com" }, occurredAt: nowSec + 100 });
    assert.equal(stopFirst.status, "applied");
    const late = await apply({ action: "open", orderId: "T5", user: { externalId: "14", email: "dave@example.com" }, shopPlanId: "1", occurredAt: nowSec + 50 });
    assert.equal(late.status, "ignored", late.message);
    assert.equal(late.ok, true, "忽略也算处理完了，商城不用重发");
    assert.equal((await query("SELECT COUNT(*) AS n FROM users WHERE email = 'dave@example.com'"))[0].n, 0, "迟到的开通不建用户");
    const replay = await apply({ action: "open", orderId: "T5", user: { externalId: "14" }, shopPlanId: "1", occurredAt: nowSec + 50 });
    assert.equal(replay.status, "ignored");
    assert.equal(replay.duplicate, true);

    const fresh = await apply({ action: "open", orderId: "T6", user: { externalId: "14", email: "dave@example.com" }, shopPlanId: "1", occurredAt: nowSec + 200 });
    assert.equal(fresh.kind, "opened", fresh.message);
  `);
});

test("乱序：更早的停用晚到 —— 不停掉之后才开的订阅", () => {
  runInDatabase(String.raw`
    const opened = await apply({ action: "open", orderId: "L1", user: { externalId: "15" }, shopPlanId: "1", occurredAt: nowSec + 100 });
    const lateStop = await apply({ action: "stop", orderId: "L0-stop", user: { externalId: "15" }, occurredAt: nowSec + 10 });
    assert.equal(lateStop.status, "ignored", lateStop.message);
    assert.equal((await subsOf(opened.user.id))[0].status, "active");
  `);
});

test("同邮箱的本地老账号：默认不接管；打开认领后才接管，管理员账号永远不接管", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role, email) VALUES (5, 'erin', 'h', 'user', 'erin@example.com')");
    const refused = await apply({ action: "open", orderId: "E1", user: { externalId: "16", email: "erin@example.com" }, shopPlanId: "1", occurredAt: nowSec });
    assert.equal(refused.status, "failed");
    assert.match(refused.message, /认领/);
    assert.equal((await subsOf(5)).length, 0);

    const admin = await apply({ action: "open", orderId: "E2", user: { externalId: "17", email: "root@example.com" }, shopPlanId: "1", occurredAt: nowSec });
    assert.equal(admin.status, "failed");

    await configure({ linkExistingByEmail: true });
    const linked = await apply({ action: "open", orderId: "E1", user: { externalId: "16", email: "erin@example.com" }, shopPlanId: "1", occurredAt: nowSec });
    assert.equal(linked.status, "applied", linked.message);
    assert.equal(linked.user.id, 5);
    assert.equal(linked.user.created, false);
    assert.equal(Number((await bindingOf("16")).createdByShop), 0);
    const adminAgain = await apply({ action: "open", orderId: "E3", user: { externalId: "17", email: "root@example.com" }, shopPlanId: "1", occurredAt: nowSec });
    assert.equal(adminAgain.status, "failed", "打开认领也不接管管理员");
    assert.match(adminAgain.message, /管理员/);
    assert.equal((await subsOf(1)).length, 0);

    // 绑定只认商城用户 id：换个商城 id 拿同一个邮箱来，抢不走已经绑好的账号
    const hijack = await apply({ action: "open", orderId: "E4", user: { externalId: "18", email: "erin@example.com" }, shopPlanId: "1", occurredAt: nowSec });
    assert.equal(hijack.status, "failed");
    assert.match(hijack.message, /已经绑给商城用户 16/);
  `);
});

test("对接关着：一律拒绝；订单号不能挪给另一个商城用户", () => {
  runInDatabase(String.raw`
    await apply({ action: "open", orderId: "X1", user: { externalId: "20" }, shopPlanId: "1", occurredAt: nowSec });
    await assert.rejects(
      () => apply({ action: "open", orderId: "X1", user: { externalId: "21" }, shopPlanId: "1", occurredAt: nowSec }),
      /已经用在商城用户 20 上/,
    );
    await configure({ enabled: false });
    await assert.rejects(() => apply({ action: "stop", orderId: "X2", user: { externalId: "20" } }), shop.ShopSyncDisabledError);
    assert.equal(await orderOf("X2"), undefined, "关着时什么都不记");
  `);
});

test("最近同步记录按时间倒序，带上状态和说明", () => {
  runInDatabase(String.raw`
    await apply({ action: "open", orderId: "H1", user: { externalId: "30", email: "f@example.com" }, shopPlanId: "1", occurredAt: nowSec });
    await apply({ action: "open", orderId: "H2", user: { externalId: "31" }, shopPlanId: "77", occurredAt: nowSec });
    const records = await shop.listShopSyncRecords(10);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((row) => row.status).sort(), ["applied", "unmapped"]);
    const stats = await shop.shopSyncStats();
    assert.equal(stats.boundUsers, 1);
    assert.equal(stats.activeUsers, 1);
  `);
});

test("新账号建好了、开通却失败（端口不够）：初始密码照样回；补好之后同一个订单号重发能成，不再建第二个账号", () => {
  runInDatabase(String.raw`
    const huge = await makePlan("超大", { portCount: 70000 });
    await configure({ plans: [{ shopPlanId: "1", planId: huge }] });
    const failed = await apply({ action: "open", orderId: "P1", user: { externalId: "40", email: "gus@example.com" }, shopPlanId: "1", occurredAt: nowSec });
    assert.equal(failed.status, "failed");
    assert.match(failed.message, /端口不足/);
    assert.equal(failed.user.created, true);
    assert.ok(failed.user.initialPassword);
    assert.equal((await orderOf("P1")).status, "failed");

    await configure({ plans: [{ shopPlanId: "1", planId: planA }] });
    const retried = await apply({ action: "open", orderId: "P1", user: { externalId: "40", email: "gus@example.com" }, shopPlanId: "1", occurredAt: nowSec });
    assert.equal(retried.status, "applied", retried.message);
    assert.equal(retried.user.id, failed.user.id);
    assert.equal(Number((await query("SELECT COUNT(*) AS n FROM users WHERE email = 'gus@example.com'"))[0].n), 1);
  `);
});
