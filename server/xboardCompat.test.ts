import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";

import { buildXboardInfo, buildXboardSubscribe, issueXboardToken, passwordFingerprint, readXboardToken, verifyXboardToken, XBOARD_TOKEN_TTL_SECONDS } from "./xboardCompat";

const SECRET = "test-cookie-secret";
const NOW = 1_800_000_000;

test("令牌：能验、过期不认、改签名不认、换了密钥不认", () => {
  const token = issueXboardToken({ userId: 7, passwordHash: "hash-a", secret: SECRET, nowSec: NOW });
  assert.deepEqual(verifyXboardToken(token, SECRET, NOW + 10), { userId: 7, fingerprint: passwordFingerprint("hash-a") });
  assert.equal(verifyXboardToken(token, SECRET, NOW + XBOARD_TOKEN_TTL_SECONDS + 1), null, "30 天后过期");
  assert.equal(verifyXboardToken(token, "other-secret", NOW + 10), null);
  const [prefix, body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ u: 1, p: passwordFingerprint("hash-a"), e: NOW + 999 })).toString("base64url");
  assert.equal(verifyXboardToken(`${prefix}.${forged}.${sig}`, SECRET, NOW + 10), null, "改了内容签名就对不上");
  assert.equal(verifyXboardToken(`${prefix}.${body}`, SECRET, NOW), null);
  assert.notEqual(passwordFingerprint("hash-a"), passwordFingerprint("hash-b"), "改密码后指纹不同，旧令牌失效");
});

test("令牌和网页会话互不通用：网页 JWT 验不过它，它也不是合法 JWT", () => {
  const token = issueXboardToken({ userId: 7, passwordHash: "h", secret: SECRET, nowSec: Math.floor(Date.now() / 1000) });
  assert.throws(() => jwt.verify(token, SECRET), "拿去调 tRPC 必须验不过");
  const webJwt = jwt.sign({ userId: 7, sid: "x", kind: "browser" }, SECRET);
  assert.equal(readXboardToken(`Bearer ${webJwt}`), null, "网页会话令牌在这里不认");
});

test("Authorization 头：带不带 Bearer 都认，别的前缀不认", () => {
  const token = issueXboardToken({ userId: 1, passwordHash: "h", secret: SECRET, nowSec: NOW });
  assert.equal(readXboardToken(`Bearer ${token}`), token);
  assert.equal(readXboardToken(token), token);
  assert.equal(readXboardToken("Bearer nex_abc"), null);
  assert.equal(readXboardToken(undefined), null);
});

test("getSubscribe / info 的形状：已用放 d，0 表示不限，时间是秒", () => {
  const user = { id: 3, email: "a@b.c", username: "alice", trafficLimit: 100 * 2 ** 30, trafficUsed: 12345, expiresAt: new Date(NOW * 1000), createdAt: NOW - 100, balanceCents: 990, trafficResetDay: 5, accountEnabled: true };
  const subscribe = buildXboardSubscribe(user, { token: "tok", subscribeUrl: "https://p/api/sub/tok", plan: { id: 2, name: "月付" } });
  assert.deepEqual(
    [subscribe.u, subscribe.d, subscribe.transfer_enable, subscribe.expired_at, subscribe.plan_id, subscribe.subscribe_url, subscribe.reset_day, subscribe.email],
    [0, 12345, 100 * 2 ** 30, NOW, 2, "https://p/api/sub/tok", 5, "a@b.c"],
  );
  assert.equal(buildXboardSubscribe({ id: 1, username: "bob" }, { token: "t", subscribeUrl: "u", plan: null }).expired_at, null, "不过期是 null");
  const info = buildXboardInfo({ ...user, accountEnabled: false }, { planId: null, uuid: "3" });
  assert.equal(info.banned, 1);
  assert.equal(info.created_at, NOW - 100);
  assert.equal(info.balance, 990);
});
