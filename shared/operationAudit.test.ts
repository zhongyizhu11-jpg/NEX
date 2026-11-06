import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIT_REDACTED,
  isSecretAuditKey,
  normalizeOperationAuditRetentionDays,
  operationAuditModule,
  redactAuditInput,
  serializeAuditInput,
  OPERATION_AUDIT_INPUT_MAX_CHARS,
} from "./operationAudit";

test("密钥类键名整项隐藏，普通键照常显示", () => {
  for (const key of [
    "password", "newPassword", "oldPasswd", "passphrase", "secret", "clientSecret", "aliyunAccessKeySecret",
    "token", "telegramBotToken", "cloudflareApiToken", "apiKey", "deepseekApiKeyCustom", "accessKeyId",
    "privateKey", "keyPem", "panelSslKeyPem", "certKeyPem", "credentials", "otp", "totpCode", "code", "emailCode",
    "bindCode", "redemptionCode", "cookie", "authorization", "webhook_secret", "tencentcloudSecretId", "huaweicloudSecretKey",
    "captchaAnswer", "sid",
  ]) {
    assert.equal(isSecretAuditKey(key), true, key);
  }
  for (const key of [
    "name", "username", "email", "hostId", "countryCode", "discountCode", "inviteCode", "statusCode", "pathKey",
    "routeKey", "sortKey", "keyword", "monkey", "enabled", "trafficLimit", "panelPublicUrl", "role", "id", "ids",
    "tokenId", "apiTokenIds", "maxTokens", "maxProxySubTokens",
  ]) {
    assert.equal(isSecretAuditKey(key), false, key);
  }
});

test("密钥键上的开关照常显示；同一个对象出现两次不算循环引用", () => {
  const shared = { port: 443 };
  const out = redactAuditInput({ clearBotToken: true, botToken: "123456:abcdef", a: shared, b: [shared, shared] }) as any;
  assert.equal(out.clearBotToken, true);
  assert.equal(out.botToken, AUDIT_REDACTED);
  assert.deepEqual(out.a, { port: 443 });
  assert.deepEqual(out.b, [{ port: 443 }, { port: 443 }]);
});

test("嵌套对象、数组里的密钥也隐藏；空值保持原样", () => {
  const out = redactAuditInput({
    id: 3,
    settings: { emailPassword: "hunter2", smtpHost: "smtp.example.com", oauth: { googleClientSecret: "g-s", googleClientId: "g-id" } },
    accounts: [{ name: "a", credentials: { secretKey: "x" } }, { name: "b", password: "" }],
    password: null,
  }) as any;
  assert.equal(out.id, 3);
  assert.equal(out.settings.emailPassword, AUDIT_REDACTED);
  assert.equal(out.settings.smtpHost, "smtp.example.com");
  assert.equal(out.settings.oauth.googleClientSecret, AUDIT_REDACTED);
  assert.equal(out.settings.oauth.googleClientId, "g-id");
  assert.equal(out.accounts[0].credentials, AUDIT_REDACTED);
  assert.equal(out.accounts[1].password, "");
  assert.equal(out.password, null);
  assert.equal(JSON.stringify(out).includes("hunter2"), false);
  assert.equal(JSON.stringify(out).includes("g-s"), false);
});

test("键名不像密钥、值像密钥（PEM、面板令牌、Bearer、JWT）也隐藏", () => {
  const out = redactAuditInput({
    note: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----",
    value: "nex_FAKEtokenFAKEtokenFAKEtoken00",
    header: "Bearer abcdefghijklmnop",
    blob: "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjF9.c2lnbmF0dXJlLXZhbHVl",
    text: "普通的备注",
  }) as any;
  assert.equal(out.note, AUDIT_REDACTED);
  assert.equal(out.value, AUDIT_REDACTED);
  assert.equal(out.header, AUDIT_REDACTED);
  assert.equal(out.blob, AUDIT_REDACTED);
  assert.equal(out.text, "普通的备注");
});

test("长串截断、数组和层级封顶、循环引用不炸", () => {
  const cyclic: any = { name: "x" };
  cyclic.self = cyclic;
  const out = redactAuditInput({
    long: "a".repeat(500),
    list: Array.from({ length: 30 }, (_, index) => index),
    deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
    cyclic,
  }) as any;
  assert.ok(out.long.length < 260 && out.long.includes("共 500 字"));
  assert.equal(out.list.length, 21);
  assert.equal(out.list[20], "…另 10 项");
  assert.equal(out.deep.a.b.c.d.e, "[…]");
  assert.equal(out.cyclic.self, "[循环引用]");
});

test("存库的 JSON 不超过上限，超了仍是合法 JSON", () => {
  assert.equal(serializeAuditInput(undefined), null);
  assert.equal(serializeAuditInput({ a: 1 }), '{"a":1}');
  const big = serializeAuditInput(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, "x".repeat(150)])))!;
  assert.ok(big.length <= OPERATION_AUDIT_INPUT_MAX_CHARS);
  const parsed = JSON.parse(big);
  assert.equal(parsed._truncated, true);
});

test("模块取路径去掉最后一段；保留天数夹在 7～3650", () => {
  assert.equal(operationAuditModule("rules.update"), "rules");
  assert.equal(operationAuditModule("ops.firewall.blockIp"), "ops.firewall");
  assert.equal(operationAuditModule("ping"), "ping");
  assert.equal(normalizeOperationAuditRetentionDays(undefined), 90);
  assert.equal(normalizeOperationAuditRetentionDays("3"), 7);
  assert.equal(normalizeOperationAuditRetentionDays(99999), 3650);
  assert.equal(normalizeOperationAuditRetentionDays("180"), 180);
});
