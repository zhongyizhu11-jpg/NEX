import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 主动查单跑在真数据库上：钱付了但回调没到的单，要能自己捞回来。
 *
 * 这一组盯着两件最要命的事：
 * 1. 捞回来之后**真的入账**（余额加上、订单变 completed）；
 * 2. 回调随后又到了、或者下一轮又查了一次，**不能发两次货**。
 *
 * 网关那一半用假的 fetch 顶掉 —— 要测的是面板这边的判断和落库，不是网络。
 */
function runInDatabase(body: string, fetchImpl: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-reconcile-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import crypto from "node:crypto";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      // 先把 fetch 换掉，再导入 payment —— 它在模块顶层就可能取到引用。
      globalThis.fetch = ${fetchImpl};

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const billing = await import(url("server/repositories/billingRepository.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      const payment = await import(url("server/payment.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (1, 'bob', 'h', 'user', 0)");
      // 支付配置是整块 JSON 存在一个键里的，不是一项一个键。
      await settings.setSetting("paymentConfig", JSON.stringify({
        easypay: {
          enabled: true,
          mode: "redirect",
          apiBase: "https://pay.example.com",
          pid: "1001",
          pkey: "secret",
        },
      }));

      /** 一张两分钟前下的、还没过期的待支付订单。 */
      const makePendingOrder = async (outTradeNo, amountCents = 1000) => {
        const nowSec = Math.floor(Date.now() / 1000);
        await exec(
          "INSERT INTO payment_orders (outTradeNo, userId, provider, paymentType, status, subject, amountCents, currency, orderType, createdAt, updatedAt, expiresAt) VALUES (?, 1, 'easypay', 'alipay', 'pending', '充值', ?, 'CNY', 'balance', ?, ?, ?)",
          [outTradeNo, amountCents, nowSec - 300, nowSec - 300, nowSec + 900],
        );
      };
      const orderStatus = async (outTradeNo) =>
        String((await query("SELECT status FROM payment_orders WHERE outTradeNo = ?", [outTradeNo]))[0].status);
      const balance = async () => Number((await query("SELECT balanceCents FROM users WHERE id = 1"))[0].balanceCents);

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "pay.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** 网关说「这单付了」。 */
const PAID_GATEWAY = `async () => new Response(JSON.stringify({ code: 1, status: 1, trade_no: "GW-1" }))`;
/** 网关说「查询成功，但还没付」。 */
const UNPAID_GATEWAY = `async () => new Response(JSON.stringify({ code: 1, status: 0 }))`;
/** 网关说「查无此单」。 */
const MISSING_GATEWAY = `async () => new Response(JSON.stringify({ code: -1, msg: "订单不存在" }))`;
/** 网关挂了。 */
const DOWN_GATEWAY = `async () => { throw new Error("connect ETIMEDOUT"); }`;

test("回调没到的订单，查一次就捞回来并入账", () => {
  runInDatabase(String.raw`
    await makePendingOrder("R-1", 1500);
    const result = await payment.reconcilePendingPaymentOrders();
    assert.equal(result.checked, 1);
    assert.equal(result.paid, 1);
    assert.equal(await orderStatus("R-1"), "completed");
    assert.equal(await balance(), 1500, "钱要真的加到账上");
  `, PAID_GATEWAY);
});

test("再查一次不会重复入账", () => {
  runInDatabase(String.raw`
    await makePendingOrder("R-2", 1500);
    await payment.reconcilePendingPaymentOrders();
    const after = await balance();

    // 回调随后又到了、或者下一轮又查了一次 —— 都不能发两次货。
    const second = await payment.reconcilePendingPaymentOrders();
    assert.equal(second.paid, 0, "已经完成的单不该再被算作一次回收");
    assert.equal(await balance(), after, "余额不能加两次");
  `, PAID_GATEWAY);
});

test("网关说还没付，订单原样留着", () => {
  runInDatabase(String.raw`
    await makePendingOrder("R-3");
    const result = await payment.reconcilePendingPaymentOrders();
    assert.equal(result.checked, 1);
    assert.equal(result.paid, 0);
    assert.equal(await orderStatus("R-3"), "pending");
    assert.equal(await balance(), 0);
  `, UNPAID_GATEWAY);
});

test("网关说查无此单：不关单（用户可能还没打开收银页，随后照样能付），交给过期清理", () => {
  runInDatabase(String.raw`
    await makePendingOrder("R-4");
    await payment.reconcilePendingPaymentOrders();
    assert.equal(await orderStatus("R-4"), "pending");
    assert.equal(await balance(), 0);
  `, MISSING_GATEWAY);
});

test("官方支付宝 / 微信的单不去易支付查，更不能因为「查无此单」被关掉", () => {
  runInDatabase(String.raw`
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [outTradeNo, provider] of [["R-OA", "alipay"], ["R-OW", "wxpay"]]) {
      await exec(
        "INSERT INTO payment_orders (outTradeNo, userId, provider, paymentType, status, subject, amountCents, currency, orderType, createdAt, updatedAt, expiresAt) VALUES (?, 1, ?, ?, 'pending', '充值', 1000, 'CNY', 'balance', ?, ?, ?)",
        [outTradeNo, provider, provider, nowSec - 300, nowSec - 300, nowSec + 900],
      );
    }
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => { calls += 1; return original(...args); };
    await payment.reconcilePendingPaymentOrders();
    globalThis.fetch = original;
    assert.equal(calls, 0, "官方网关的单不能拿去问易支付");
    assert.equal(await orderStatus("R-OA"), "pending");
    assert.equal(await orderStatus("R-OW"), "pending");
  `, MISSING_GATEWAY);
});

test("网关挂了：安静跳过，订单不动，也不能崩掉整轮维护", () => {
  runInDatabase(String.raw`
    await makePendingOrder("R-5");
    const result = await payment.reconcilePendingPaymentOrders();
    assert.equal(result.paid, 0);
    assert.equal(await orderStatus("R-5"), "pending", "一次网络抖动不该动订单状态");
  `, DOWN_GATEWAY);
});

test("刚下单的不问 —— 用户可能还停在收银台", () => {
  runInDatabase(String.raw`
    const nowSec = Math.floor(Date.now() / 1000);
    await exec(
      "INSERT INTO payment_orders (outTradeNo, userId, provider, paymentType, status, subject, amountCents, currency, orderType, createdAt, updatedAt, expiresAt) VALUES ('R-6', 1, 'easypay', 'alipay', 'pending', '充值', 1000, 'CNY', 'balance', ?, ?, ?)",
      [nowSec - 10, nowSec - 10, nowSec + 900],
    );
    const result = await payment.reconcilePendingPaymentOrders();
    assert.equal(result.checked, 0);
    assert.equal(await orderStatus("R-6"), "pending");
  `, PAID_GATEWAY);
});

/** 支付宝 / 微信官方单的查单（上游 2.3.285）：响应要验签，金额按网关回来的数比对。 */
const OFFICIAL_GATEWAY = String.raw`async (input, init = {}) => {
  const url = String(input);
  const keys = globalThis.__payKeys;
  if (url.startsWith("https://openapi.alipay.com/")) {
    const content = JSON.stringify(globalThis.__alipayQuery);
    const signer = globalThis.__forgeAlipay ? globalThis.__otherKeys.privateKey : keys.privateKey;
    const sign = crypto.sign("RSA-SHA256", Buffer.from(content), signer).toString("base64");
    return new Response('{"alipay_trade_query_response":' + content + ',"sign":"' + sign + '"}');
  }
  if (url.startsWith("https://api.mch.weixin.qq.com/")) {
    const text = JSON.stringify(globalThis.__wxpayQuery);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.sign("RSA-SHA256", Buffer.from(timestamp + "\n" + "nonce" + "\n" + text + "\n"), keys.privateKey).toString("base64");
    return new Response(text, { headers: { "wechatpay-serial": "PUB_KEY_ID", "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-signature": signature } });
  }
  throw new Error("unexpected fetch " + url);
}`;

const OFFICIAL_SETUP = String.raw`
  const gen = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  globalThis.__payKeys = gen();
  globalThis.__otherKeys = gen();
  const keys = globalThis.__payKeys;
  await settings.setSetting("paymentConfig", JSON.stringify({
    enabled: true,
    routes: { alipay: "alipay", wxpay: "wxpay" },
    alipay: { enabled: true, appId: "2021000000000001", privateKey: keys.privateKey, publicKey: keys.publicKey, gateway: "https://openapi.alipay.com/gateway.do", mode: "precreate" },
    wxpay: { enabled: true, appId: "wxapp", mchId: "1900000001", privateKey: keys.privateKey, apiV3Key: "0123456789abcdef0123456789abcdef", certSerial: "SERIAL", publicKey: keys.publicKey, publicKeyId: "PUB_KEY_ID", mode: "native" },
  }));
  const nowSec = Math.floor(Date.now() / 1000);
  const makeOfficialOrder = async (outTradeNo, provider) => exec(
    "INSERT INTO payment_orders (outTradeNo, userId, provider, paymentType, status, subject, amountCents, currency, orderType, createdAt, updatedAt, expiresAt) VALUES (?, 1, ?, ?, 'pending', '充值', 1000, 'CNY', 'balance', ?, ?, ?)",
    [outTradeNo, provider, provider, nowSec - 300, nowSec - 300, nowSec + 900],
  );
`;

test("支付宝 / 微信官方单：查单验签通过、金额对得上才入账", () => {
  runInDatabase(String.raw`
    ${OFFICIAL_SETUP}
    await makeOfficialOrder("R-A1", "alipay");
    await makeOfficialOrder("R-W1", "wxpay");
    globalThis.__alipayQuery = { code: "10000", out_trade_no: "R-A1", trade_status: "TRADE_SUCCESS", trade_no: "ALI-1", total_amount: "10.00" };
    globalThis.__wxpayQuery = { out_trade_no: "R-W1", appid: "wxapp", mchid: "1900000001", trade_state: "SUCCESS", transaction_id: "WX-1", amount: { total: 1000, currency: "CNY" } };
    const result = await payment.reconcilePendingPaymentOrders();
    assert.equal(result.paid, 2);
    assert.equal(await orderStatus("R-A1"), "completed");
    assert.equal(await orderStatus("R-W1"), "completed");
    assert.equal(await balance(), 2000);
  `, OFFICIAL_GATEWAY);
});

test("支付宝官方单：响应签名不对、或者网关报的金额对不上，都不能入账", () => {
  runInDatabase(String.raw`
    ${OFFICIAL_SETUP}
    await makeOfficialOrder("R-A2", "alipay");
    globalThis.__alipayQuery = { code: "10000", out_trade_no: "R-A2", trade_status: "TRADE_SUCCESS", trade_no: "ALI-2", total_amount: "10.00" };
    globalThis.__forgeAlipay = true;
    await payment.reconcilePendingPaymentOrders();
    assert.equal(await orderStatus("R-A2"), "pending", "伪造签名的「已付」不算");
    assert.equal(await balance(), 0);

    globalThis.__forgeAlipay = false;
    await makeOfficialOrder("R-A3", "alipay");
    globalThis.__alipayQuery = { code: "10000", out_trade_no: "R-A3", trade_status: "TRADE_SUCCESS", trade_no: "ALI-3", total_amount: "0.01" };
    await payment.reconcilePendingPaymentOrders();
    assert.notEqual(await orderStatus("R-A3"), "completed", "实付 1 分钱不能当 10 元入账");
    assert.equal(await balance(), 0);
  `, OFFICIAL_GATEWAY);
});

test("易支付网关不是 HTTPS：不查单（密钥在查询串里）", () => {
  runInDatabase(String.raw`
    await settings.setSetting("paymentConfig", JSON.stringify({
      easypay: { enabled: true, mode: "redirect", apiBase: "http://pay.example.com", pid: "1001", pkey: "secret" },
    }));
    await makePendingOrder("R-H1");
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => { calls += 1; return original(...args); };
    await payment.reconcilePendingPaymentOrders();
    globalThis.fetch = original;
    assert.equal(calls, 0);
    assert.equal(await orderStatus("R-H1"), "pending");
  `, PAID_GATEWAY);
});
