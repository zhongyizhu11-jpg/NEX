import assert from "node:assert/strict";
import test from "node:test";

import { coordinatesFromMicro, greatCircleKm, proxySubVisitorBucket, proxySubVisitorGeoFromRegion } from "./proxySubGeo";

/**
 * 「按访客就近」的几个零件：距离、离线归属地 → 坐标、缓存格子、主机微度坐标。
 */

test("大圆距离：东京到香港约 2900 公里，同一点是 0", () => {
  const km = greatCircleKm(35.6762, 139.6503, 22.3193, 114.1694);
  assert.ok(km > 2850 && km < 2950, `东京—香港 ${km}`);
  assert.equal(greatCircleKm(1, 2, 1, 2), 0);
  // 跨过 180° 经线也算得对：东京到洛杉矶约 8800 公里。
  const pacific = greatCircleKm(35.6762, 139.6503, 34.0522, -118.2437);
  assert.ok(pacific > 8700 && pacific < 8900, `东京—洛杉矶 ${pacific}`);
});

test("离线归属地 → 坐标：对得上市用市，对不上用省会 / 国家第一个城市，国家不在表里就是没有", () => {
  const shenzhen = proxySubVisitorGeoFromRegion({ countryCode: "CN", region: "广东省", city: "深圳市" });
  assert.ok(shenzhen);
  assert.equal(shenzhen.countryCode, "CN");
  assert.ok(Math.abs(shenzhen.lat - 22.5431) < 0.01 && Math.abs(shenzhen.lng - 114.0579) < 0.01, JSON.stringify(shenzhen));
  // 市对不上、省对得上（表里有广州）：用省里那个城市。
  const guangdong = proxySubVisitorGeoFromRegion({ countryCode: "CN", region: "广东省", city: "汕尾市" });
  assert.ok(guangdong && Math.abs(guangdong.lat - 23.1291) < 0.01, JSON.stringify(guangdong));
  // 只有国家：这个国家在表里的第一个城市。
  const japan = proxySubVisitorGeoFromRegion({ countryCode: "jp" });
  assert.ok(japan && japan.countryCode === "JP" && japan.lat > 30 && japan.lat < 40, JSON.stringify(japan));
  assert.equal(proxySubVisitorGeoFromRegion({ countryCode: "XX" }), null, "不在城市表里的国家");
  // 离线库把港澳台记在 CN 下面（省份写「香港特别行政区」「台湾省」）：要落到各自的城市，不能落到北京。
  assert.deepEqual(proxySubVisitorGeoFromRegion({ countryCode: "CN", region: "香港特别行政区", city: null }), { countryCode: "HK", lat: 22.3193, lng: 114.1694 });
  assert.deepEqual(proxySubVisitorGeoFromRegion({ countryCode: "CN", region: "澳门特别行政区" }), { countryCode: "MO", lat: 22.1987, lng: 113.5439 });
  const taiwan = proxySubVisitorGeoFromRegion({ countryCode: "CN", region: "台湾省", city: "高雄市" });
  assert.ok(taiwan && taiwan.countryCode === "TW" && Math.abs(taiwan.lat - 22.6273) < 0.01, JSON.stringify(taiwan));
  // 带民族名的自治区也认得出省会。
  const guangxi = proxySubVisitorGeoFromRegion({ countryCode: "CN", region: "广西壮族自治区", city: "北海市" });
  assert.ok(guangxi && Math.abs(guangxi.lat - 22.817) < 0.1, JSON.stringify(guangxi));
  assert.equal(proxySubVisitorGeoFromRegion({ countryCode: "" }), null);
  assert.equal(proxySubVisitorGeoFromRegion(null), null);
});

test("缓存格子：国家 + 取整到 1° 的经纬度；主机微度坐标换成度，缺的、0,0 的算没有", () => {
  assert.deepEqual(proxySubVisitorBucket({ countryCode: "HK", lat: 22.3193, lng: 114.1694 }), { cc: "HK", lat: 22, lng: 114 });
  assert.deepEqual(proxySubVisitorBucket({ countryCode: "US", lat: 34.5, lng: -118.2437 }), { cc: "US", lat: 35, lng: -118 });
  assert.deepEqual(coordinatesFromMicro(22543100, 114057900), { lat: 22.5431, lng: 114.0579 });
  assert.equal(coordinatesFromMicro(null, 114057900), null);
  assert.equal(coordinatesFromMicro(22543100, undefined), null);
  assert.equal(coordinatesFromMicro("", ""), null);
  assert.equal(coordinatesFromMicro(0, 0), null);
  assert.equal(coordinatesFromMicro("abc", 1), null);
});
