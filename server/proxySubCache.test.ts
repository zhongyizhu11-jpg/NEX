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
