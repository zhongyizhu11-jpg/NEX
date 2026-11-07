import assert from "node:assert/strict";
import test from "node:test";

import { proxySubVisitorCacheParts, resolveProxySubVisitorGeo } from "./proxySubVisitorGeo";
import { proxySubCacheKey } from "./proxySubCache";

/**
 * 「按访客就近」的服务端两步：访客位置只走离线库（终端用户的 IP 不发给任何第三方）；
 * 缓存键只在这一种排序下多一格访客格子，别的排序逐字不变。
 */

test("访客位置只查离线库：公网 IP 查得到，内网 / 乱写的查不到，全程不发网络请求", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requests.push(String(input));
    throw new Error("不该发网络请求");
  }) as typeof fetch;
  try {
    const us = await resolveProxySubVisitorGeo("8.8.8.8");
    assert.ok(us, "离线库应该查得到 8.8.8.8");
    assert.equal(us.countryCode, "US");
    assert.ok(Number.isFinite(us.lat) && Number.isFinite(us.lng));
    const cn = await resolveProxySubVisitorGeo("::ffff:114.114.114.114");
    assert.equal(cn?.countryCode, "CN");
    // 离线库把香港记在 CN 下面：要落到香港，不能落到北京。
    const hk = await resolveProxySubVisitorGeo("203.80.96.10");
    assert.equal(hk?.countryCode, "HK");
    assert.ok(hk && Math.abs(hk.lat - 22.3) < 0.5, JSON.stringify(hk));
    assert.equal(await resolveProxySubVisitorGeo("10.0.0.8"), null, "内网没有位置");
    assert.equal(await resolveProxySubVisitorGeo("not-an-ip"), null);
    assert.equal(await resolveProxySubVisitorGeo(""), null);
    assert.deepEqual(requests, [], `发出了网络请求：${requests.join(", ")}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("缓存键：只有按访客就近才带访客格子；同城访客同一格，别的排序的键逐字不变", () => {
  const visitor = { countryCode: "HK", lat: 22.3193, lng: 114.1694 };
  assert.deepEqual(proxySubVisitorCacheParts("region", visitor), []);
  assert.deepEqual(proxySubVisitorCacheParts("manual", visitor), []);
  assert.deepEqual(proxySubVisitorCacheParts("nearest", null), [], "查不到位置就是按地区，不多这一格");
  assert.deepEqual(proxySubVisitorCacheParts("nearest", visitor), [{ cc: "HK", lat: 22, lng: 114 }]);

  const base = ["v1", 7, "clash"];
  const regionKey = proxySubCacheKey(1, [...base, ...proxySubVisitorCacheParts("region", visitor)]);
  assert.equal(regionKey, proxySubCacheKey(1, base), "别的排序的键不该因为访客而变");
  const nearbyA = proxySubCacheKey(1, [...base, ...proxySubVisitorCacheParts("nearest", visitor)]);
  const nearbyB = proxySubCacheKey(1, [...base, ...proxySubVisitorCacheParts("nearest", { countryCode: "HK", lat: 22.28, lng: 114.16 })]);
  const farAway = proxySubCacheKey(1, [...base, ...proxySubVisitorCacheParts("nearest", { countryCode: "JP", lat: 35.68, lng: 139.65 })]);
  assert.equal(nearbyA, nearbyB, "同一座城市的访客共用一份缓存");
  assert.notEqual(nearbyA, farAway);
  assert.notEqual(nearbyA, regionKey);
});
