import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PAYMENT_ERRORS, isPaymentCryptoError } from "../shared/paymentErrors";
import { paymentOrderFailureMessage } from "./paymentFailureMessage";
import { importPaymentPrivateKey, importPaymentPublicKey } from "./paymentCrypto";

/**
 * 下单失败时顾客能看到什么：只能是归好类的说明（密钥 / 配置 / 超时 / 网络 / 暂不可用），
 * 网关返回的 HTML、Stripe 的「Invalid API Key provided: sk_live_…」、OpenSSL 的解码错误、
 * 「fetch failed」都不能出现在顾客拿到的 tRPC 报错里；原文照样写进面板日志给管理员排查。
 *
 * 网关用假的 fetch 顶掉，每个场景换一种坏法。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-pay-errors-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import crypto from "node:crypto";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      let gateway = async () => { throw new Error("gateway not stubbed"); };
      globalThis.fetch = async (input, init = {}) => gateway(String(input), init);

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      const payment = await import(url("server/payment.ts"));
      const logger = await import(url("server/_core/panelLogger.ts"));
      const { PAYMENT_ERRORS } = await import(url("shared/paymentErrors.ts"));
      const safeMessages = new Set(Object.values(PAYMENT_ERRORS));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'alice', 'h', 'user')");
      await settings.setSetting("panelPublicUrl", "https://panel.example.com");
      const keys = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const baseConfig = {
        enabled: true,
        minAmount: 0,
        maxAmount: 0,
        orderTimeoutMinutes: 30,
        maxPendingOrders: 0,
        routes: { alipay: "alipay", wxpay: "wxpay" },
        easypay: { enabled: true, apiBase: "https://pay.example.com", pid: "1001", pkey: "k", mode: "api", cidAlipay: "", cidWxpay: "" },
        stripe: { enabled: true, secretKey: "sk_live_51Hsecretsecretsecret", publishableKey: "pk", webhookSecret: "whsec", currency: "cny" },
        alipay: { enabled: true, appId: "2021000000000001", privateKey: keys.privateKey, publicKey: keys.publicKey, gateway: "https://openapi.alipay.com/gateway.do", mode: "precreate" },
        wxpay: {
          enabled: true, appId: "wxapp", mchId: "1900000001", privateKey: keys.privateKey,
          apiV3Key: "0123456789abcdef0123456789abcdef", certSerial: "SERIAL", publicKey: keys.publicKey,
          publicKeyId: "PUB_KEY_ID", mode: "native", h5AppName: "", h5AppUrl: "",
        },
      };
      const setConfig = async (patch = {}) => {
        const next = { ...baseConfig, ...patch };
        for (const key of ["easypay", "stripe", "alipay", "wxpay", "routes"]) {
          if (patch[key]) next[key] = { ...baseConfig[key], ...patch[key] };
        }
        await settings.setSetting("paymentConfig", JSON.stringify(next));
      };
      const alice = payment.paymentRouter.createCaller({
        req: { headers: {}, ip: "127.0.0.1", socket: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "alice", role: "user", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });

      /** 下单必须失败；顾客看到的只能是归类后的说明，返回它和那条面板日志。 */
      async function customerFailure(input, forbidden, expected) {
        let caught = null;
        try { await alice.createOrder(input); } catch (error) { caught = error; }
        assert.ok(caught, "下单应该失败");
        const visible = JSON.stringify({ message: caught.message, code: caught.code, shape: caught.shape ?? null });
        for (const raw of forbidden) {
          assert.ok(!visible.includes(raw), "顾客看到了原始报错 " + JSON.stringify(raw) + "：" + caught.message);
        }
        assert.ok(safeMessages.has(caught.message), "不是归类后的说明：" + caught.message);
        if (expected) assert.equal(caught.message, expected);
        const [order] = await query('SELECT "status" FROM "payment_orders" ORDER BY "id" DESC LIMIT 1');
        assert.equal(order.status, "failed", "失败的单照样关掉");
        const logs = await logger.getPanelLogs();
        const line = logs.find((entry) => entry.level === "error" && entry.message.includes("order create failed") && forbidden.some((raw) => entry.message.includes(raw)));
        assert.ok(line, "原始报错要留在面板日志里：" + JSON.stringify(logs.map((entry) => entry.message)));
        return caught;
      }

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

test("网关返回 HTML 页面时，顾客看不到 HTML 片段", () => {
  runInDatabase(String.raw`
    const html = "<html><head><title>502 Bad Gateway</title></head><body>nginx/1.18.0 internal-host-7</body></html>";
    gateway = async () => new Response(html, { status: 502, headers: { "content-type": "text/html" } });

    await setConfig({ routes: { alipay: "easypay", wxpay: "wxpay" } });
    await customerFailure({ amount: 10, paymentType: "alipay" }, ["<html", "nginx", "502 Bad Gateway"], PAYMENT_ERRORS.unavailable);

    await setConfig();
    await customerFailure({ amount: 10, paymentType: "alipay" }, ["<html", "nginx"], PAYMENT_ERRORS.unavailable);
    await customerFailure({ amount: 10, paymentType: "wxpay" }, ["<html", "nginx"], PAYMENT_ERRORS.unavailable);
    await customerFailure({ amount: 10, paymentType: "stripe" }, ["<html", "Unexpected token", "is not valid JSON"], PAYMENT_ERRORS.unavailable);
  `);
});

test("Stripe 的 API Key 报错不会带着密钥片段给顾客", () => {
  runInDatabase(String.raw`
    gateway = async () => new Response(JSON.stringify({
      error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_live_****cret" },
    }), { status: 401, headers: { "content-type": "application/json" } });
    await setConfig();
    await customerFailure({ amount: 10, paymentType: "stripe" }, ["sk_live", "Invalid API Key"], PAYMENT_ERRORS.unavailable);
  `);
});

test("签名私钥解析失败时顾客看到的是密钥配置说明，不是 OpenSSL 错误码", () => {
  runInDatabase(String.raw`
    gateway = async () => { throw new Error("签名失败前不该发请求"); };
    await setConfig({ alipay: { privateKey: "MIIBroken" + "A".repeat(40) } });
    const error = await customerFailure({ amount: 10, paymentType: "alipay" }, ["routines", "DECODER", "ERR_OSSL", "asn1"]);
    assert.ok(
      error.message === PAYMENT_ERRORS.keyConfiguration || /私钥/.test(error.message),
      "应该说是密钥的问题：" + error.message,
    );
  `);
});

test("连不上、超时的网关给顾客「网络」/「超时」，不给「fetch failed」", () => {
  runInDatabase(String.raw`
    await setConfig();
    gateway = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:443"), { code: "ECONNREFUSED" }) }); };
    await customerFailure({ amount: 10, paymentType: "stripe" }, ["fetch failed", "ECONNREFUSED", "10.0.0.7"], PAYMENT_ERRORS.network);

    gateway = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error (attempted address: openapi.alipay.com:443)"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }); };
    await customerFailure({ amount: 10, paymentType: "alipay" }, ["fetch failed", "UND_ERR", "attempted address"], PAYMENT_ERRORS.timeout);

    gateway = async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
    await customerFailure({ amount: 10, paymentType: "wxpay" }, ["aborted due to timeout"], PAYMENT_ERRORS.timeout);
  `);
});

test("下单前的业务校验（金额上下限之类）照旧原样告诉顾客", () => {
  runInDatabase(String.raw`
    await setConfig({ minAmount: 5 });
    await assert.rejects(() => alice.createOrder({ amount: 1, paymentType: "stripe" }), /最低支付金额为 5/);
  `);
});

test("paymentOrderFailureMessage 按类别归类，认不出的一律「暂不可用」", () => {
  const keyError = Object.assign(new Error("支付宝应用私钥无效，请填写 RSA 私钥（PKCS#1 或 PKCS#8），不要填写公钥或证书。"), { name: "PaymentKeyConfigurationError" });
  assert.equal(paymentOrderFailureMessage(keyError), keyError.message);
  assert.equal(paymentOrderFailureMessage(new Error("error:1E08010C:DECODER routines::unsupported")), PAYMENT_ERRORS.keyConfiguration);
  assert.equal(paymentOrderFailureMessage(Object.assign(new Error("x"), { code: "ERR_OSSL_UNSUPPORTED" })), PAYMENT_ERRORS.keyConfiguration);
  assert.equal(paymentOrderFailureMessage(new Error("支付宝官方配置不完整")), PAYMENT_ERRORS.configuration);
  assert.equal(paymentOrderFailureMessage(new Error("微信 APIv3 密钥必须为 32 个字符")), PAYMENT_ERRORS.configuration);
  assert.equal(paymentOrderFailureMessage(Object.assign(new Error("timeout"), { name: "TimeoutError" })), PAYMENT_ERRORS.timeout);
  assert.equal(paymentOrderFailureMessage(new Error("GM Pay 请求超时")), PAYMENT_ERRORS.timeout);
  assert.equal(paymentOrderFailureMessage(new Error("fetch failed", { cause: { code: "ETIMEDOUT" } })), PAYMENT_ERRORS.timeout);
  assert.equal(paymentOrderFailureMessage(new Error("fetch failed", { cause: { code: "ECONNREFUSED" } })), PAYMENT_ERRORS.network);
  assert.equal(paymentOrderFailureMessage(new Error("fetch failed")), PAYMENT_ERRORS.network);
  assert.equal(paymentOrderFailureMessage(new Error("易支付返回格式异常：<html>")), PAYMENT_ERRORS.unavailable);
  assert.equal(paymentOrderFailureMessage("boom"), PAYMENT_ERRORS.unavailable);
  assert.equal(paymentOrderFailureMessage(null), PAYMENT_ERRORS.unavailable);
  // 有人把原始报错塞进 PaymentKeyConfigurationError 的 message 也不放行。
  assert.equal(paymentOrderFailureMessage(Object.assign(new Error("<html>oops</html>"), { name: "PaymentKeyConfigurationError" })), PAYMENT_ERRORS.keyConfiguration);
});

test("paymentCrypto.ts 真实抛出的密钥错误能被归类放行成对应说明", () => {
  const thrown = (fn: () => unknown) => {
    try { fn(); } catch (error) { return error; }
    assert.fail("expected the key import to throw");
  };
  const cases: Array<[unknown, string]> = [
    [thrown(() => importPaymentPrivateKey("not-a-key", "alipay")), PAYMENT_ERRORS.alipayPrivateKey],
    [thrown(() => importPaymentPublicKey("not-a-key", "alipay")), PAYMENT_ERRORS.alipayPublicKey],
    [thrown(() => importPaymentPrivateKey("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", "wxpay")), PAYMENT_ERRORS.wxpayPrivateKey],
    [thrown(() => importPaymentPublicKey("QUJD", "wxpay")), PAYMENT_ERRORS.wxpayPublicKey],
  ];
  for (const [error, expected] of cases) {
    assert.equal((error as Error).name, "PaymentKeyConfigurationError");
    assert.equal(paymentOrderFailureMessage(error), expected);
  }
});

test("isPaymentCryptoError 只认 OpenSSL 的解码类错误", () => {
  assert.ok(isPaymentCryptoError("error:1E08010C:DECODER routines::unsupported"));
  assert.ok(isPaymentCryptoError("error:0909006C:PEM routines:get_name:no start line"));
  assert.ok(isPaymentCryptoError("ERR_OSSL_UNSUPPORTED"));
  assert.ok(!isPaymentCryptoError("余额不足"));
  assert.ok(!isPaymentCryptoError("fetch failed"));
});
