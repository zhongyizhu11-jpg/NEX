import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SHOP_SYNC_CONFIG,
  decideShopEventOrdering,
  isSettledShopRecord,
  laterClock,
  mappedPlanId,
  normalizeShopSyncConfig,
  parseShopSyncConfig,
  shopTimeToSeconds,
} from "./shopSync";

test("设置默认关；认不出来的设置回默认，映射表去空行、去重、套餐 id 按字符串比", () => {
  assert.equal(DEFAULT_SHOP_SYNC_CONFIG.enabled, false);
  assert.equal(DEFAULT_SHOP_SYNC_CONFIG.linkExistingByEmail, false);
  assert.deepEqual(parseShopSyncConfig("{bad json"), DEFAULT_SHOP_SYNC_CONFIG);
  assert.deepEqual(parseShopSyncConfig(null), DEFAULT_SHOP_SYNC_CONFIG);
  const config = normalizeShopSyncConfig({
    enabled: "true",
    shop: "nope",
    plans: [{ shopPlanId: " 1 ", planId: 3 }, { shopPlanId: 1, planId: 4 }, { shopPlanId: "", planId: 5 }, { shopPlanId: "2", planId: 0 }],
  });
  assert.equal(config.enabled, false, "只认真正的 true");
  assert.equal(config.shop, "xboard");
  assert.deepEqual(config.plans, [{ shopPlanId: "1", planId: 3 }]);
  assert.equal(mappedPlanId(config, 1), 3);
  assert.equal(mappedPlanId(config, "1 "), 3);
  assert.equal(mappedPlanId(config, "2"), null);
});

test("商城时间：秒、毫秒、ISO 都认；0 和空当没设（V2Board 的 expired_at 默认就是 0）", () => {
  assert.equal(shopTimeToSeconds(1_700_000_000), 1_700_000_000);
  assert.equal(shopTimeToSeconds(1_700_000_000_123), 1_700_000_000);
  assert.equal(shopTimeToSeconds("1700000000"), 1_700_000_000);
  assert.equal(shopTimeToSeconds("2023-11-14T22:13:20Z"), 1_700_000_000);
  assert.equal(shopTimeToSeconds(0), null);
  assert.equal(shopTimeToSeconds("0"), null);
  assert.equal(shopTimeToSeconds(""), null);
  assert.equal(shopTimeToSeconds("昨天"), null);
});

test("乱序：开通不晚于停用就忽略，停用早于开通就忽略；时间相同时停用说了算", () => {
  const clock = { activatedAt: 100, stoppedAt: 200 };
  assert.equal(decideShopEventOrdering("open", 150, clock).apply, false);
  assert.equal(decideShopEventOrdering("renew", 200, clock).apply, false, "同一时刻：停用说了算");
  assert.equal(decideShopEventOrdering("activate", 201, clock).apply, true);
  assert.equal(decideShopEventOrdering("stop", 99, clock).apply, false);
  assert.equal(decideShopEventOrdering("stop", 100, { activatedAt: 100, stoppedAt: null }).apply, true);
  assert.equal(decideShopEventOrdering("open", 1, null).apply, true, "第一次来的用户没有可比的");
  const ignored = decideShopEventOrdering("change", 150, clock);
  assert.ok(!ignored.apply && /已停用/.test(ignored.reason));
});

test("时钟只往后走；只有已生效 / 已忽略算有结论，没映射和失败的允许同一个订单号重试", () => {
  assert.equal(laterClock(300, 200), 300);
  assert.equal(laterClock(null, 200), 200);
  assert.equal(isSettledShopRecord("applied"), true);
  assert.equal(isSettledShopRecord("ignored"), true);
  assert.equal(isSettledShopRecord("unmapped"), false);
  assert.equal(isSettledShopRecord("failed"), false);
  assert.equal(isSettledShopRecord("processing"), false);
});
