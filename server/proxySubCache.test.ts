import assert from "node:assert/strict";
import test from "node:test";

import {
  clearProxySubCacheForTests,
  getProxySubCached,
  invalidateProxySubCacheAll,
  invalidateProxySubCacheForUser,
  proxySubCacheKey,
  proxySubCacheSizeForTests,
  setProxySubCached,
} from "./proxySubCache";

test("同一份原料拿同一个键；TTL 到了就没有", () => {
  clearProxySubCacheForTests();
  const now = 10_000;
  const key = proxySubCacheKey(1, ["clash", "balanced", { a: 1 }]);
  assert.equal(key, proxySubCacheKey(1, ["clash", "balanced", { a: 1 }]));
  assert.notEqual(key, proxySubCacheKey(1, ["clash", "minimal", { a: 1 }]));
  setProxySubCached(key, "body", 60, now);
  assert.equal(getProxySubCached(key, now + 59_000), "body");
  assert.equal(getProxySubCached(key, now + 61_000), null);
  // TTL 0 = 不缓存。
  setProxySubCached(key, "body", 0, now);
  assert.equal(getProxySubCached(key, now), null);
});

test("按用户作废：这个用户的键换掉，别人的不动；全站作废谁都换", () => {
  clearProxySubCacheForTests();
  const parts = ["clash"];
  const before = proxySubCacheKey(7, parts);
  const other = proxySubCacheKey(8, parts);
  setProxySubCached(before, "x", 60);
  setProxySubCached(other, "y", 60);
  invalidateProxySubCacheForUser(7);
  assert.notEqual(proxySubCacheKey(7, parts), before);
  assert.equal(proxySubCacheKey(8, parts), other);
  assert.equal(getProxySubCached(other), "y");
  invalidateProxySubCacheAll();
  assert.notEqual(proxySubCacheKey(8, parts), other);
  assert.equal(proxySubCacheSizeForTests(), 0);
});

test("条目数有上限，先进先出", () => {
  clearProxySubCacheForTests();
  for (let index = 0; index < 2_100; index += 1) setProxySubCached(`k${index}`, "v", 600);
  assert.ok(proxySubCacheSizeForTests() <= 2_000);
  assert.equal(getProxySubCached("k0"), null);
  assert.equal(getProxySubCached("k2099"), "v");
});
