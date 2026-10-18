import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 下单这一侧的两条约束：
 * 1. 订单的过期时刻要带给网关（支付宝 / 微信 / Stripe），网关和面板一起到期，
 *    不再出现「面板关了单、收银台还能付」；
 * 2. 同一个人、同一张折扣码同时只能有一笔待支付订单，限量码不能被挂单占光。
 *
 * 网关用假的 fetch 顶掉，只看面板发出去的请求。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-pay-create-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import crypto from "node:crypto";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const requests = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        const body = init.body === undefined ? "" : String(init.body);
        requests.push({ url, body });
        if (url.startsWith("https://api.stripe.com/")) {
          return new Response(JSON.stringify({ id: "cs_test_" + requests.length, url: "https://checkout.stripe.com/pay" }), { status: 200 });
        }
        // 网关响应要带签名（面板会验）：用下面配置进去的同一对密钥签。
        if (url.startsWith("https://openapi.alipay.com/")) {
          const content = JSON.stringify({ code: "10000", qr_code: "https://qr.alipay.com/x" });
          const sign = crypto.sign("RSA-SHA256", Buffer.from(content), globalThis.__payKeys.privateKey).toString("base64");
          return new Response('{"alipay_trade_precreate_response":' + content + ',"sign":"' + sign + '"}', { status: 200 });
        }
        if (url.startsWith("https://api.mch.weixin.qq.com/")) {
          const text = JSON.stringify({ code_url: "weixin://wxpay/x" });
          const timestamp = String(Math.floor(Date.now() / 1000));
          const nonce = "n" + requests.length;
          const signature = crypto.sign("RSA-SHA256", Buffer.from(timestamp + "\n" + nonce + "\n" + text + "\n"), globalThis.__payKeys.privateKey).toString("base64");
          return new Response(text, { status: 200, headers: {
            "wechatpay-serial": "PUB_KEY_ID", "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-signature": signature,
          } });
        }
        throw new Error("unexpected fetch " + url);
      };

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      const payment = await import(url("server/payment.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'alice', 'h', 'user')");
      await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'bob', 'h', 'user')");
      await settings.setSetting("panelPublicUrl", "https://panel.example.com");
      await settings.setSetting("storeEnabled", "true");
      const keys = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      globalThis.__payKeys = keys;
      await settings.setSetting("paymentConfig", JSON.stringify({
        enabled: true,
        minAmount: 0,
        maxAmount: 0,
        orderTimeoutMinutes: 30,
        maxPendingOrders: 0,
        routes: { alipay: "alipay", wxpay: "wxpay" },
        stripe: { enabled: true, secretKey: "sk_test", publishableKey: "pk", webhookSecret: "whsec", currency: "cny" },
        alipay: { enabled: true, appId: "2021000000000001", privateKey: keys.privateKey, publicKey: keys.publicKey, gateway: "https://openapi.alipay.com/gateway.do", mode: "precreate" },
        wxpay: {
          enabled: true, appId: "wxapp", mchId: "1900000001", privateKey: keys.privateKey,
          apiV3Key: "0123456789abcdef0123456789abcdef", certSerial: "SERIAL", publicKey: keys.publicKey,
          publicKeyId: "PUB_KEY_ID", mode: "native", h5AppName: "", h5AppUrl: "",
        },
      }));
      const callerFor = (user) => payment.paymentRouter.createCaller({
        req: { headers: {}, ip: "127.0.0.1", socket: {} },
        res: { clearCookie() {} },
        user,
        authSession: null,
        authFailureReason: null,
      });
      const alice = callerFor({ id: 1, username: "alice", role: "user", accountEnabled: true });
      const bob = callerFor({ id: 2, username: "bob", role: "user", accountEnabled: true });

      ${body}

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

test("下单时把订单过期时刻带给支付宝、微信和 Stripe", () => {
  runInDatabase(String.raw`
    const nowSec = () => Math.floor(Date.now() / 1000);

    const stripeOrder = await alice.createOrder({ amount: 10, paymentType: "stripe" });
    const stripeBody = new URLSearchParams(requests.at(-1).body);
    const expiresAt = Number(stripeBody.get("expires_at"));
    assert.ok(expiresAt >= nowSec() + 30 * 60, "Stripe 至少 30 分钟，面板 30 分钟的单要夹到下限");
    assert.ok(expiresAt <= nowSec() + 24 * 3600, "也不能超过 24 小时");
    assert.ok(stripeOrder.outTradeNo);

    await alice.createOrder({ amount: 10, paymentType: "alipay" });
    const alipayParams = new URLSearchParams(requests.at(-1).body);
    const bizContent = JSON.parse(alipayParams.get("biz_content"));
    assert.match(bizContent.timeout_express, /^(29|30)m$/, "支付宝按面板剩余分钟数关单");

    const wxOrder = await alice.createOrder({ amount: 10, paymentType: "wxpay" });
    const wxPayload = JSON.parse(requests.at(-1).body);
    assert.match(wxPayload.time_expire, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+08:00$/, "微信 time_expire 是 RFC3339");
    const wxExpire = new Date(wxPayload.time_expire).getTime();
    const [row] = await query('SELECT "expiresAt" FROM "payment_orders" WHERE "outTradeNo" = ?', [wxOrder.outTradeNo]);
    assert.ok(Math.abs(wxExpire - Number(row.expiresAt) * 1000) <= 1000, "微信的过期时刻就是面板订单的过期时刻");
  `);
});

test("同一个人同一张折扣码同时只能有一笔待支付订单", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO subscription_plans (id, name, priceCents, durationDays, portCount, trafficLimit, isActive, isStoreVisible) VALUES (7, 'P', 1000, 30, 1, 0, 1, 1)");
    await exec("INSERT INTO discount_codes (id, code, discountType, discountValue, maxUses, usedCount, isActive) VALUES (3, 'SALE', 'percent', 10, 5, 0, 1)");
    const usedCount = async () => Number((await query('SELECT "usedCount" FROM "discount_codes" WHERE "id" = 3'))[0].usedCount);

    const first = await alice.createOrder({ amount: 10, paymentType: "stripe", planId: 7, discountCode: "sale" });
    assert.equal(Number(first.amountCents), 900);
    assert.equal(await usedCount(), 1);

    await assert.rejects(
      () => alice.createOrder({ amount: 10, paymentType: "stripe", planId: 7, discountCode: "SALE" }),
      /已有一笔待支付订单/,
    );
    assert.equal(await usedCount(), 1, "被拒的那笔不能再占名额");

    // 别人照常能用。
    await bob.createOrder({ amount: 10, paymentType: "stripe", planId: 7, discountCode: "SALE" });
    assert.equal(await usedCount(), 2);

    // 自己那笔关掉之后可以重新下。
    await exec('UPDATE "payment_orders" SET "status" = ? WHERE "outTradeNo" = ?', ["cancelled", first.outTradeNo]);
    await alice.createOrder({ amount: 10, paymentType: "stripe", planId: 7, discountCode: "SALE" });
  `);
});
