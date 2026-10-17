import assert from "node:assert/strict";
import test from "node:test";
import { beijingDayStart, opsBoardDays, opsBoardSince, orderStatusBucket, shortProvinceName, sourceAreaLabel } from "./opsBoard";

test("按北京时间切天：UTC 16:00 已经是北京的第二天", () => {
  const utc1600 = Date.parse("2026-10-17T16:00:00Z") / 1000;
  assert.equal(beijingDayStart(utc1600), Date.parse("2026-10-18T00:00:00+08:00") / 1000);
  assert.equal(opsBoardSince(1, utc1600), Date.parse("2026-10-18T00:00:00+08:00") / 1000);
  assert.deepEqual(opsBoardDays(7, utc1600), ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
});

test("订单状态：收了钱还在开通的单单独一类", () => {
  assert.equal(orderStatusBucket("completed"), "completed");
  assert.equal(orderStatusBucket("paid"), "delivering");
  assert.equal(orderStatusBucket("processing"), "delivering");
  assert.equal(orderStatusBucket("pending"), "pending");
  for (const status of ["failed", "expired", "cancelled", "", null]) assert.equal(orderStatusBucket(status), "closed");
});

test("来源地区：国内按省份短名，港澳台单列，境外按国家", () => {
  assert.equal(shortProvinceName("广东省"), "广东");
  assert.equal(shortProvinceName("广西壮族自治区"), "广西");
  assert.equal(shortProvinceName("上海市"), "上海");
  assert.equal(sourceAreaLabel({ countryCode: "CN", region: "新疆维吾尔自治区" }), "新疆");
  assert.equal(sourceAreaLabel({ countryCode: "HK", region: "香港" }), "香港");
  assert.equal(sourceAreaLabel({ countryCode: "US", countryName: "美国" }), "美国");
  assert.equal(sourceAreaLabel({ countryCode: "CN", region: null }), "中国（未知省份）");
  assert.equal(sourceAreaLabel(null), "未知");
});
