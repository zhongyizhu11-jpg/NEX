import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  支付回调的验签和金额核对（server/payment.ts）：走真的 express 路由、真的签名算法、真的 SQLite。
  只看行为（回调返回什么、订单和余额变没变），不依赖验签的具体比较写法。
*/
const setup = String.raw`
  const crypto = await import("node:crypto");
  const http = await import("node:http");
  const express = (await import("express")).default;
  const settings = await import(url("server/repositories/settingsRepository.ts"));
  const payment = await import(url("server/payment.ts"));
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
  const makeOrder = async (outTradeNo, { provider = "easypay", amountCents = 1000, currency = "CNY" } = {}) => {
    await exec(
      "INSERT INTO payment_orders (outTradeNo, userId, provider, paymentType, status, subject, amountCents, currency, orderType, createdAt, updatedAt, expiresAt) VALUES (?, 1, ?, ?, 'pending', '充值', ?, ?, 'balance', ?, ?, ?)",
      [outTradeNo, provider, provider === "easypay" ? "alipay" : provider, amountCents, currency, nowSec() - 60, nowSec() - 60, nowSec() + 900],
    );
  };
  const status = async (outTradeNo) => (await query("SELECT status FROM payment_orders WHERE outTradeNo = ?", [outTradeNo]))[0].status;
  const balance = async () => Number((await query("SELECT balanceCents FROM users WHERE id = 1"))[0].balanceCents);
  const easypaySign = (params, key = "secret") => crypto.createHash("md5")
    .update(Object.keys(params).filter((k) => params[k] !== "").sort().map((k) => k + "=" + params[k]).join("&") + key)
    .digest("hex");
  const easypayNotify = async (fields, { key = "secret", tamper } = {}) => {
    const params = { pid: "1001", type: "alipay", trade_no: "EP-1", name: "x", trade_status: "TRADE_SUCCESS", ...fields };
    params.sign = easypaySign(params, key);
    params.sign_type = "MD5";
    if (tamper) Object.assign(params, tamper);
    const response = await fetch(base + "/api/payment/webhook/easypay?" + new URLSearchParams(params).toString());
    return { status: response.status, text: await response.text() };
  };
  const stripeEvent = async (event, { secret = "whsec_test", t = nowSec() } = {}) => {
    const raw = JSON.stringify(event);
    const v1 = crypto.createHmac("sha256", secret).update(t + "." + raw).digest("hex");
    const response = await fetch(base + "/api/payment/webhook/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=" + t + ",v1=" + v1 },
      body: raw,
    });
    return response.status;
  };
  const stripePaid = (outTradeNo, amount, currency = "cny") => ({
    type: "checkout.session.completed",
    data: { object: { id: "cs_" + outTradeNo, payment_intent: "pi_" + outTradeNo, payment_status: "paid", amount_total: amount, currency, metadata: { outTradeNo } } },
  });
  const alipayNotify = async (params, { signer = keys.privateKey, tamper } = {}) => {
    const content = Object.keys(params).filter((k) => params[k] !== "").sort().map((k) => k + "=" + params[k]).join("&");
    const sign = crypto.sign("RSA-SHA256", Buffer.from(content), signer).toString("base64");
    const body = { ...params, sign, sign_type: "RSA2", ...(tamper || {}) };
    const response = await fetch(base + "/api/payment/webhook/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    return { status: response.status, text: await response.text() };
  };
`;

const run = (name: string, body: string) => runInDatabase(String.raw`
  try {
    ${body}
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
`, { name, setup, quiet: true });

test("EasyPay: bad signature, wrong key or foreign merchant never pay the order", () => {
  run("pay-easypay-sign", String.raw`
    await makeOrder("E-1");
    // 签名对，但把金额改了（签名没跟着改）
    assert.equal((await easypayNotify({ out_trade_no: "E-1", money: "10.00" }, { tamper: { money: "99.00" } })).status, 400);
    // 用别的密钥签的
    assert.equal((await easypayNotify({ out_trade_no: "E-1", money: "10.00" }, { key: "other" })).status, 400);
    // 没有签名
    assert.equal((await easypayNotify({ out_trade_no: "E-1", money: "10.00" }, { tamper: { sign: "" } })).status, 400);
    // 签名对，但商户号不是本商户
    assert.equal((await easypayNotify({ out_trade_no: "E-1", money: "10.00", pid: "2002" })).status, 400);
    assert.equal(await status("E-1"), "pending");
    assert.equal(await balance(), 0);

    // 交易还没成功：回 success 让网关别重发，但不入账
    const waiting = await easypayNotify({ out_trade_no: "E-1", money: "10.00", trade_status: "WAIT_BUYER_PAY" });
    assert.equal(waiting.text, "success");
    assert.equal(await status("E-1"), "pending");
  `);
});

test("EasyPay: a correctly signed notify with the wrong amount fails the order; the right amount pays once", () => {
  run("pay-easypay-amount", String.raw`
    // 验签过了但金额少了一分：订单记失败，不发货、不入账
    await makeOrder("E-SHORT", { amountCents: 1000 });
    assert.equal((await easypayNotify({ out_trade_no: "E-SHORT", money: "9.99" })).text, "success");
    assert.equal(await status("E-SHORT"), "failed");
    assert.equal(await balance(), 0);

    await makeOrder("E-2", { amountCents: 1000 });

    const paid = await easypayNotify({ out_trade_no: "E-2", money: "10.00" });
    assert.equal(paid.text, "success");
    assert.equal(await status("E-2"), "completed");
    assert.equal(await balance(), 1000);
    // 重放不重复入账
    assert.equal((await easypayNotify({ out_trade_no: "E-2", money: "10.00" })).text, "success");
    assert.equal(await balance(), 1000);

    // 未知订单号：验签过了也只是忽略
    assert.equal((await easypayNotify({ out_trade_no: "NOPE", money: "10.00" })).text, "success");
    assert.equal(await balance(), 1000);
  `);
});

test("Stripe: wrong secret, stale timestamp, wrong amount or currency never pay", () => {
  run("pay-stripe", String.raw`
    await makeOrder("S-1", { provider: "stripe", amountCents: 1000 });
    assert.equal(await stripeEvent(stripePaid("S-1", 1000), { secret: "whsec_other" }), 400);
    assert.equal(await stripeEvent(stripePaid("S-1", 1000), { t: nowSec() - 3600 }), 400, "超过 5 分钟的签名不认");
    assert.equal(await status("S-1"), "pending");
    // 签名对、金额或币种不对：订单记失败，不入账
    await makeOrder("S-SHORT", { provider: "stripe", amountCents: 1000 });
    assert.equal(await stripeEvent(stripePaid("S-SHORT", 999)), 200);
    assert.equal(await status("S-SHORT"), "failed");
    await makeOrder("S-USD", { provider: "stripe", amountCents: 1000 });
    assert.equal(await stripeEvent(stripePaid("S-USD", 1000, "usd")), 200);
    assert.equal(await status("S-USD"), "failed");
    assert.equal(await balance(), 0);
    assert.equal(await stripeEvent(stripePaid("S-1", 1000)), 200);
    assert.equal(await status("S-1"), "completed");
    assert.equal(await balance(), 1000);
  `);
});

test("Alipay: a notify signed by another key or with a changed amount is rejected", () => {
  run("pay-alipay", String.raw`
    await makeOrder("A-1", { provider: "alipay", amountCents: 1000 });
    const params = { app_id: "2021000000000001", out_trade_no: "A-1", trade_no: "ALI-1", total_amount: "10.00", trade_status: "TRADE_SUCCESS", charset: "utf-8" };
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    assert.equal((await alipayNotify(params, { signer: other.privateKey })).status, 400);
    assert.equal((await alipayNotify(params, { tamper: { total_amount: "0.01" } })).status, 400);
    assert.equal((await alipayNotify(params, { tamper: { sign_type: "RSA" } })).status, 400);
    assert.equal(await status("A-1"), "pending");
    // 签名对、金额不对：订单记失败
    await makeOrder("A-SHORT", { provider: "alipay", amountCents: 1000 });
    assert.equal((await alipayNotify({ ...params, out_trade_no: "A-SHORT", total_amount: "1.00" })).text, "success");
    assert.equal(await status("A-SHORT"), "failed");
    assert.equal(await balance(), 0);
    assert.equal((await alipayNotify(params)).text, "success");
    assert.equal(await status("A-1"), "completed");
    assert.equal(await balance(), 1000);
  `);
});
