import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 回调这一侧「钱到了却什么都没发」的几条路：
 * - 订单被面板关掉之后才到账：转入余额，不再忽略；
 * - 发货遇到永久性错误：转入余额结单，不再永远卡在 processing；
 * - Stripe 一次扣款失败不关单，客户在同一个收银页重试成功照常入账；
 * - 支付宝通知必须是发给本应用的（app_id）。
 *
 * 回调走真的 express 路由和真的验签，数据库是真的 SQLite。
 */
function runWithCallbackServer(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-pay-callback-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import crypto from "node:crypto";
      import http from "node:http";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      import express from "express";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      const payment = await import(url("server/payment/payment.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (1, 'bob', 'h', 'user', 0)");
      const keys = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      await settings.setSetting("paymentConfig", JSON.stringify({
        enabled: true,
        easypay: { enabled: true, mode: "redirect", apiBase: "https://pay.example.com", pid: "1001", pkey: "secret" },
        stripe: { enabled: true, secretKey: "sk_test", publishableKey: "pk", webhookSecret: "whsec_test", currency: "cny" },
        alipay: { enabled: true, appId: "2021000000000001", privateKey: keys.privateKey, publicKey: keys.publicKey, gateway: "https://openapi.alipay.com/gateway.do", mode: "precreate" },
      }));

      const app = express();
      app.use(payment.paymentCallbackRouter);
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = "http://127.0.0.1:" + server.address().port;

      const nowSec = () => Math.floor(Date.now() / 1000);
      const makeOrder = async (outTradeNo, { provider = "easypay", status = "pending", amountCents = 1000, expiresAt = nowSec() + 900, orderType = "balance", planId = null, updatedAt = nowSec() } = {}) => {
        await exec(
          "INSERT INTO payment_orders (outTradeNo, userId, provider, paymentType, status, subject, amountCents, currency, orderType, planId, createdAt, updatedAt, expiresAt) VALUES (?, 1, ?, ?, ?, '充值', ?, 'CNY', ?, ?, ?, ?, ?)",
          [outTradeNo, provider, provider === "easypay" ? "alipay" : provider, status, amountCents, orderType, planId, nowSec() - 3600, updatedAt, expiresAt],
        );
      };
      const order = async (outTradeNo) => (await query("SELECT status, subject FROM payment_orders WHERE outTradeNo = ?", [outTradeNo]))[0];
      const balance = async () => Number((await query("SELECT balanceCents FROM users WHERE id = 1"))[0].balanceCents);

      const easypayNotify = async (outTradeNo, money) => {
        const params = { pid: "1001", type: "alipay", out_trade_no: outTradeNo, trade_no: "EP-" + outTradeNo, name: "x", money, trade_status: "TRADE_SUCCESS" };
        const raw = Object.keys(params).sort().map((key) => key + "=" + params[key]).join("&") + "secret";
        params.sign = crypto.createHash("md5").update(raw).digest("hex");
        params.sign_type = "MD5";
        const response = await fetch(base + "/api/payment/webhook/easypay?" + new URLSearchParams(params).toString());
        return { status: response.status, text: await response.text() };
      };
      const stripeEvent = async (event) => {
        const raw = JSON.stringify(event);
        const t = nowSec();
        const v1 = crypto.createHmac("sha256", "whsec_test").update(t + "." + raw).digest("hex");
        const response = await fetch(base + "/api/payment/webhook/stripe", {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": "t=" + t + ",v1=" + v1 },
          body: raw,
        });
        return response.status;
      };
      const alipayNotify = async (params) => {
        const content = Object.keys(params).filter((key) => params[key] !== "").sort().map((key) => key + "=" + params[key]).join("&");
        const sign = crypto.sign("RSA-SHA256", Buffer.from(content), keys.privateKey).toString("base64");
        const response = await fetch(base + "/api/payment/webhook/alipay", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...params, sign, sign_type: "RSA2" }).toString(),
        });
        return { status: response.status, text: await response.text() };
      };

      try {
        ${body}
      } finally {
        await new Promise((resolve) => server.close(() => resolve()));
      }
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "pay.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("订单关闭后才到账：实付金额转入余额，只入一次", () => {
  runWithCallbackServer(String.raw`
    await makeOrder("L-EXPIRED", { status: "expired" });
    const first = await easypayNotify("L-EXPIRED", "10.00");
    assert.equal(first.text, "success");
    assert.equal(await balance(), 1000, "网关已经扣了客户的钱，面板必须认账");
    const row = await order("L-EXPIRED");
    assert.equal(row.status, "completed");
    assert.match(row.subject, /已转入余额/);
    const [tx] = await query("SELECT description FROM balance_transactions WHERE paymentOrderNo = ?", ["L-EXPIRED"]);
    assert.match(tx.description, /已转入余额/);

    // 回调重放不能入两次。
    await easypayNotify("L-EXPIRED", "10.00");
    assert.equal(await balance(), 1000);

    // 还挂着 pending、但已经过了面板过期时刻的，同样转入余额。
    await makeOrder("L-PAST", { expiresAt: nowSec() - 60 });
    await easypayNotify("L-PAST", "10.00");
    assert.equal((await order("L-PAST")).status, "completed");
    assert.equal(await balance(), 2000);

    // 金额对不上的照旧拒绝，不入账。
    await makeOrder("L-MISMATCH", { status: "cancelled" });
    await easypayNotify("L-MISMATCH", "0.01");
    assert.equal((await order("L-MISMATCH")).status, "cancelled");
    assert.equal(await balance(), 2000);
  `);
});

test("发货遇到永久性错误：转入余额结单，不再永远卡在 processing", () => {
  runWithCallbackServer(String.raw`
    await exec("INSERT INTO hosts (id, name, ip, userId, portRangeStart, portRangeEnd) VALUES (1, 'h', '127.0.0.1', 1, 10000, 10100)");
    await exec("INSERT INTO subscription_plans (id, name, priceCents, durationDays, portCount, trafficLimit, isActive) VALUES (5, '已停用套餐', 1000, 30, 1, 0, 0)");
    await exec("INSERT INTO subscription_plan_hosts (planId, hostId) VALUES (5, 1)");
    await makeOrder("P-DISABLED", { status: "processing", orderType: "plan", planId: 5, updatedAt: nowSec() - 3600 });

    await payment.recoverStaleProcessingPaymentOrders();
    const row = await order("P-DISABLED");
    assert.equal(row.status, "completed", "套餐停用重试也不会成功，不能一直挂在 processing");
    assert.match(row.subject, /已转入余额/);
    assert.equal(await balance(), 1000);
    assert.equal((await query("SELECT COUNT(*) AS n FROM user_subscriptions"))[0].n, 0, "没有开出订阅");

    await payment.recoverStaleProcessingPaymentOrders();
    assert.equal(await balance(), 1000, "不会重复入账");
  `);
});

test("Stripe 一次扣款失败不关单，随后的成功（含延迟到账）照常入账", () => {
  runWithCallbackServer(String.raw`
    await makeOrder("S-RETRY", { provider: "stripe" });
    assert.equal(await stripeEvent({ type: "payment_intent.payment_failed", data: { object: { id: "pi_1", metadata: { outTradeNo: "S-RETRY" } } } }), 200);
    assert.equal((await order("S-RETRY")).status, "pending", "客户还能在同一个收银页换卡重试");

    assert.equal(await stripeEvent({
      type: "checkout.session.async_payment_succeeded",
      data: { object: { id: "cs_1", payment_intent: "pi_1", payment_status: "paid", amount_total: 1000, currency: "cny", metadata: { outTradeNo: "S-RETRY" } } },
    }), 200);
    assert.equal((await order("S-RETRY")).status, "completed");
    assert.equal(await balance(), 1000);

    await makeOrder("S-ASYNC-FAIL", { provider: "stripe" });
    await stripeEvent({ type: "checkout.session.async_payment_failed", data: { object: { id: "cs_2", payment_status: "unpaid", metadata: { outTradeNo: "S-ASYNC-FAIL" } } } });
    assert.equal((await order("S-ASYNC-FAIL")).status, "failed");
  `);
});

test("支付宝通知的 app_id 必须是本应用", () => {
  runWithCallbackServer(String.raw`
    await makeOrder("A-1", { provider: "alipay" });
    const params = { out_trade_no: "A-1", trade_no: "ALI-1", total_amount: "10.00", trade_status: "TRADE_SUCCESS", charset: "utf-8" };
    const foreign = await alipayNotify({ ...params, app_id: "2021999999999999" });
    assert.equal(foreign.status, 400, "验签过了也不行：别的应用的真通知不能给本面板的订单入账");
    assert.equal((await order("A-1")).status, "pending");
    assert.equal(await balance(), 0);

    const own = await alipayNotify({ ...params, app_id: "2021000000000001" });
    assert.equal(own.text, "success");
    assert.equal((await order("A-1")).status, "completed");
    assert.equal(await balance(), 1000);
  `);
});
