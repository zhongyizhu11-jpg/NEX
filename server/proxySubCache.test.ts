import assert from "node:assert/strict";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import {
  clearProxySubCacheForTests,
  compressedProxySubBody,
  getProxySubCached,
  invalidateProxySubCacheAll,
  invalidateProxySubCacheForUser,
  proxySubCacheKey,
  prepareProxySubBody,
  proxySubCacheSizeForTests,
  proxySubCacheStats,
  setProxySubCached,
} from "./proxySubCache";

const body = (text: string) => prepareProxySubBody(text);
const text = (prepared: ReturnType<typeof prepareProxySubBody> | null) => (prepared ? prepared.buffer.toString("utf8") : null);

test("同一份原料拿同一个键；TTL 到了就没有", () => {
  clearProxySubCacheForTests();
  const now = 10_000;
  const key = proxySubCacheKey(1, ["clash", "balanced", { a: 1 }]);
  assert.equal(key, proxySubCacheKey(1, ["clash", "balanced", { a: 1 }]));
  assert.notEqual(key, proxySubCacheKey(1, ["clash", "minimal", { a: 1 }]));
  setProxySubCached(key, body("body"), 60, now);
  assert.equal(text(getProxySubCached(key, now + 59_000)), "body");
  assert.equal(getProxySubCached(key, now + 61_000), null);
  // TTL 0 = 不缓存。
  setProxySubCached(key, body("body"), 0, now);
  assert.equal(getProxySubCached(key, now), null);
});

test("按用户作废：这个用户的键换掉，别人的不动；全站作废谁都换", () => {
  clearProxySubCacheForTests();
  const parts = ["clash"];
  const before = proxySubCacheKey(7, parts);
  const other = proxySubCacheKey(8, parts);
  setProxySubCached(before, body("x"), 60);
  setProxySubCached(other, body("y"), 60);
  invalidateProxySubCacheForUser(7);
  assert.notEqual(proxySubCacheKey(7, parts), before);
  assert.equal(proxySubCacheKey(8, parts), other);
  assert.equal(text(getProxySubCached(other)), "y");
  invalidateProxySubCacheAll();
  assert.notEqual(proxySubCacheKey(8, parts), other);
  assert.equal(proxySubCacheSizeForTests(), 0);
});

test("条目数有上限，先进先出", () => {
  clearProxySubCacheForTests();
  for (let index = 0; index < 2_100; index += 1) setProxySubCached(`k${index}`, body("v"), 600);
  assert.ok(proxySubCacheSizeForTests() <= 2_000);
  assert.equal(getProxySubCached("k0"), null);
  assert.equal(text(getProxySubCached("k2099")), "v");
});

test("缓存的是发出去的样子：ETag 和 express 算的一样，gzip / br 各压一次、解开和原文一样", async () => {
  // express 4 的弱 ETag：W/"<utf8 字节数的十六进制>-<sha1 base64 前 27 位>"。空串和多字节字符都要对。
  assert.equal(prepareProxySubBody("").etag, 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"');
  const prepared = prepareProxySubBody("proxies:\n  - name: \"香港 01\"\n".repeat(200));
  assert.match(prepared.etag, /^W\/"[0-9a-f]+-[A-Za-z0-9+/]{27}"$/);
  assert.ok(prepared.etag.startsWith(`W/"${prepared.buffer.length.toString(16)}-`));
  const [gz, again, br] = await Promise.all([
    compressedProxySubBody(prepared, "gzip"),
    compressedProxySubBody(prepared, "gzip"),
    compressedProxySubBody(prepared, "br"),
  ]);
  assert.equal(gz, again, "同一个条目只压一次");
  assert.deepEqual(gunzipSync(gz), prepared.buffer);
  assert.deepEqual(brotliDecompressSync(br), prepared.buffer);
});

test("字节上限：正文加压好的几份一起算，超了先进先出；一份就超过上限的不缓存", async () => {
  // 上限刚好放得下三份 3 KB 的正文，再多 16 字节就超。
  const cap = 9 * 1024 + 16;
  clearProxySubCacheForTests({ maxBytes: cap });
  const chunk = "x".repeat(3 * 1024);
  for (let index = 0; index < 3; index += 1) setProxySubCached(`${index + 1}:k`, body(chunk), 600);
  assert.equal(proxySubCacheStats().bytes, 9 * 1024);
  assert.equal(proxySubCacheStats().entries, 3);
  // 第四份放不下：最老的（1）出去。
  setProxySubCached("4:k", body(chunk), 600);
  assert.equal(getProxySubCached("1:k"), null);
  assert.equal(text(getProxySubCached("2:k")), chunk);
  assert.equal(proxySubCacheStats().bytes, 9 * 1024);
  // 压好的 gzip 也算进去：条目 4 压完后总字节数超了，最老的（2）出去。
  const gz = await compressedProxySubBody(getProxySubCached("4:k")!, "gzip");
  assert.ok(gz.length > 16);
  assert.equal(getProxySubCached("2:k"), null, "加上 gzip 后超了，最老的出去");
  assert.equal(proxySubCacheStats().bytes, 6 * 1024 + gz.length);
  // 一份就比上限大：不进缓存，别的也不动。
  setProxySubCached("5:k", body("y".repeat(10 * 1024)), 600);
  assert.equal(getProxySubCached("5:k"), null);
  assert.equal(proxySubCacheStats().entries, 2);
  // 清掉的字节数归零。
  invalidateProxySubCacheAll();
  assert.equal(proxySubCacheStats().bytes, 0);
  assert.equal(proxySubCacheStats().maxBytes, cap);
});

test("按用户作废真的把这个用户的条目删掉（内存当场还回来），别人的留着", () => {
  clearProxySubCacheForTests();
  const k7a = proxySubCacheKey(7, ["clash"]);
  const k7b = proxySubCacheKey(7, ["surge"]);
  const k8 = proxySubCacheKey(8, ["clash"]);
  setProxySubCached(k7a, body("a"), 600);
  setProxySubCached(k7b, body("b"), 600);
  setProxySubCached(k8, body("c"), 600);
  assert.equal(proxySubCacheStats().bytes, 3);
  invalidateProxySubCacheForUser(7);
  assert.equal(proxySubCacheSizeForTests(), 1);
  assert.equal(proxySubCacheStats().bytes, 1);
  assert.equal(getProxySubCached(k7a), null);
  assert.equal(getProxySubCached(k7b), null);
  assert.equal(text(getProxySubCached(k8)), "c");
  // 没有条目的用户作废不出错；版本号照样换。
  const before = proxySubCacheKey(9, ["clash"]);
  invalidateProxySubCacheForUser(9);
  assert.notEqual(proxySubCacheKey(9, ["clash"]), before);
});

test("同一个键重复写：字节数不累加；过期条目被取时把字节数还回去", () => {
  clearProxySubCacheForTests();
  const now = 1_000;
  setProxySubCached("1:k", body("aaaa"), 60, now);
  setProxySubCached("1:k", body("bb"), 60, now);
  assert.equal(proxySubCacheStats().bytes, 2);
  assert.equal(proxySubCacheStats().entries, 1);
  assert.equal(getProxySubCached("1:k", now + 61_000), null);
  assert.equal(proxySubCacheStats().bytes, 0);
});
