import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createMockContext, rejectsWith } from "./testing";
import { parseHeaderLines, webhookProvider, webhookSignature } from "./webhook";

const CREDS = { url: "https://hooks.example.com/ip", secret: "s3cr3t-signing-key", headers: "Authorization: Bearer tok_abcdefghijklmnop\n# 注释\nX-Env: prod" };

test("Webhook：change_ip 带签名和自定义头，解析响应", async () => {
  const mock = createMockContext([
    {
      method: "POST",
      url: "https://hooks.example.com/ip",
      check: (req) => {
        assert.deepEqual(req.json, { action: "change_ip", target: { instanceId: "web-1" }, releaseOldIp: true, requestedAt: "2026-10-15T08:00:00.000Z" });
        assert.equal(req.headers["x-forwardx-signature"], `sha256=${createHmac("sha256", CREDS.secret).update(req.body).digest("hex")}`);
        assert.equal(req.headers.authorization, "Bearer tok_abcdefghijklmnop");
        assert.equal(req.headers["x-env"], "prod");
        assert.equal(req.headers["content-type"], "application/json");
      },
      json: { newIp: "203.0.113.9", oldIp: "203.0.113.1", ipRole: "entry", notes: ["ok"] },
    },
  ]);
  const result = await webhookProvider.changeIp(CREDS, { instanceId: "web-1" }, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.deepEqual(result, { oldIp: "203.0.113.1", newIp: "203.0.113.9", ipRole: "entry", releasedOldIp: false, notes: ["ok"] });
});

test("Webhook：get_ip / 无密钥不签名 / 非法 IP / 5xx 是 ambiguous", async () => {
  const mock = createMockContext([
    {
      method: "POST",
      url: "https://hooks.example.com/ip",
      check: (req) => {
        assert.deepEqual(req.json, { action: "get_ip", target: {} });
        assert.equal(req.headers["x-forwardx-signature"], undefined);
      },
      json: { ip: "2001:db8::1" },
    },
    { method: "POST", url: "https://hooks.example.com/ip", json: { ip: null } },
    { method: "POST", url: "https://hooks.example.com/ip", json: { newIp: "not-an-ip" } },
    { method: "POST", url: "https://hooks.example.com/ip", status: 502, text: "Bad Gateway" },
    { method: "POST", url: "https://hooks.example.com/ip", error: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) },
  ]);
  const plain = { url: CREDS.url };
  assert.equal(await webhookProvider.getCurrentIp(plain, {}, mock.ctx), "2001:db8::1");
  assert.equal(await webhookProvider.getCurrentIp(plain, {}, mock.ctx), null);
  await rejectsWith(webhookProvider.changeIp(plain, {}, mock.ctx, { releaseOldIp: false }), /IP 地址无效/);
  const bad = await rejectsWith(webhookProvider.changeIp(plain, {}, mock.ctx, { releaseOldIp: false }), /HTTP 502/);
  assert.deepEqual(bad.options, { retryable: true, ambiguous: true });
  const timeout = await rejectsWith(webhookProvider.changeIp(plain, {}, mock.ctx, { releaseOldIp: false }), /请求超时（120 秒/);
  assert.equal(timeout.options.ambiguous, true);
  mock.assertDone();
});

test("Webhook：请求头解析与校验，错误里不带密钥", async () => {
  assert.deepEqual(parseHeaderLines("A: 1\n\nB-C:  two words "), { A: "1", "B-C": "two words" });
  assert.throws(() => parseHeaderLines("no colon here"), /第 1 行格式不对/);
  assert.throws(() => parseHeaderLines("Host: evil"), /不能设置 Host/);
  assert.equal(webhookSignature("k", "{}"), `sha256=${createHmac("sha256", "k").update("{}").digest("hex")}`);
  const mock = createMockContext([
    { method: "POST", url: "https://hooks.example.com/ip", status: 401, json: { error: "bad token tok_abcdefghijklmnop" } },
  ]);
  const error = await rejectsWith(webhookProvider.getCurrentIp(CREDS, {}, mock.ctx), /HTTP 401/);
  assert.ok(!error.message.includes("tok_abcdefghijklmnop"));
  await rejectsWith(webhookProvider.getCurrentIp({ url: "ftp://x" }, {}, mock.ctx), /只支持 http/);
});
