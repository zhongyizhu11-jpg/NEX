import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createUnusablePasswordHash, hashPassword, hasUsablePassword, verifyPassword, verifyPasswordAgainstDummy } from "./password";

test("哈希格式不变（salt:hash，64 字节），老的同步哈希照样能验", async () => {
  const stored = await hashPassword("correct-horse");
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(await verifyPassword("correct-horse", stored), true);
  assert.equal(await verifyPassword("wrong-horse", stored), false);
  // 升级前用 scryptSync 存下的哈希。
  const salt = "0123456789abcdef0123456789abcdef";
  const legacy = `${salt}:${crypto.scryptSync("legacy-password", salt, 64).toString("hex")}`;
  assert.equal(await verifyPassword("legacy-password", legacy), true);
  assert.equal(await verifyPassword("legacy-passwordx", legacy), false);
});

test("格式不对、不能用的密码标记一律验不过；假哈希路径也照样跑", async () => {
  assert.equal(await verifyPassword("", ""), false);
  assert.equal(await verifyPassword("x", "no-colon"), false);
  assert.equal(await verifyPassword("x", "abcd:zz"), false);
  const unusable = createUnusablePasswordHash();
  assert.equal(hasUsablePassword(unusable), false);
  assert.equal(await verifyPassword("", unusable), false);
  assert.equal(await verifyPassword("anything", unusable), false);
  assert.equal(await verifyPasswordAgainstDummy("anything"), false);
});

test("算哈希不卡事件循环", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 0);
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => hashPassword(`password-${index}`)));
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, "scrypt 期间定时器一次都没跑：还在同步计算");
});
