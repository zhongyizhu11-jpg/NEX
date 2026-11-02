import assert from "node:assert/strict";
import test from "node:test";

import { checkProxySubRateLimit, clearProxySubRateLimitForTests, pruneProxySubRateLimit } from "./proxySubRateLimit";

test("每条令牌每分钟 N 次，超了给 Retry-After", () => {
  clearProxySubRateLimitForTests();
  const now = 1_000_000;
  for (let index = 0; index < 3; index += 1) {
    assert.equal(checkProxySubRateLimit({ tokenId: 1, ip: "1.1.1.1", tokenLimit: 3, ipLimit: 0, now: now + index }).limited, false);
  }
  const blocked = checkProxySubRateLimit({ tokenId: 1, ip: "1.1.1.1", tokenLimit: 3, ipLimit: 0, now: now + 10 });
  assert.equal(blocked.limited, true);
  assert.equal(blocked.scope, "token");
  assert.ok(blocked.retryAfterSeconds >= 59 && blocked.retryAfterSeconds <= 60, String(blocked.retryAfterSeconds));
  // 别的令牌不受影响。
  assert.equal(checkProxySubRateLimit({ tokenId: 2, ip: "1.1.1.1", tokenLimit: 3, ipLimit: 0, now: now + 10 }).limited, false);
  // 窗口过了就放。
  assert.equal(checkProxySubRateLimit({ tokenId: 1, ip: "1.1.1.1", tokenLimit: 3, ipLimit: 0, now: now + 61_000 }).limited, false);
});

test("每个 IP 每分钟 M 次：同一个 IP 刷很多条令牌也挡；IPv6 按 /64 归并；0 = 不限", () => {
  clearProxySubRateLimitForTests();
  const now = 2_000_000;
  for (let index = 0; index < 2; index += 1) {
    assert.equal(checkProxySubRateLimit({ tokenId: 100 + index, ip: "2001:db8:1:2::1", tokenLimit: 0, ipLimit: 2, now }).limited, false);
  }
  const blocked = checkProxySubRateLimit({ tokenId: 300, ip: "2001:db8:1:2:ffff::9", tokenLimit: 0, ipLimit: 2, now });
  assert.equal(blocked.limited, true);
  assert.equal(blocked.scope, "ip");
  for (let index = 0; index < 50; index += 1) {
    assert.equal(checkProxySubRateLimit({ tokenId: 9, ip: "3.3.3.3", tokenLimit: 0, ipLimit: 0, now }).limited, false);
  }
  pruneProxySubRateLimit(now + 120_000);
  assert.equal(checkProxySubRateLimit({ tokenId: 300, ip: "2001:db8:1:2::1", tokenLimit: 0, ipLimit: 2, now: now + 120_000 }).limited, false);
});

test("查空按 IP 计数：一分钟到上限就挡 15 分钟，查得到的也挡；IPv6 按 /64；别的 IP 不受影响", async () => {
  const { PROXY_SUB_MISS_BLOCK_MS, PROXY_SUB_MISS_LIMIT, PROXY_SUB_MISS_WINDOW_MS, proxySubMissBlockState, recordProxySubMiss } = await import("./proxySubRateLimit");
  clearProxySubRateLimitForTests();
  const now = 3_000_000;
  for (let index = 0; index < PROXY_SUB_MISS_LIMIT - 1; index += 1) recordProxySubMiss("2001:db8:9:9::" + (index + 1).toString(16), now + index);
  assert.equal(proxySubMissBlockState("2001:db8:9:9::1", now + 100).blocked, false);
  recordProxySubMiss("2001:db8:9:9:ffff::1", now + 100);
  const blocked = proxySubMissBlockState("2001:db8:9:9::abcd", now + 200);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterSeconds > 14 * 60 && blocked.retryAfterSeconds <= 15 * 60, String(blocked.retryAfterSeconds));
  assert.equal(proxySubMissBlockState("2001:db8:9:a::1", now + 200).blocked, false);
  assert.equal(proxySubMissBlockState("2001:db8:9:9::1", now + 100 + PROXY_SUB_MISS_BLOCK_MS + 1).blocked, false);
  // 慢慢查空（每分钟只有十次，没到上限）不会累积。
  clearProxySubRateLimitForTests();
  for (let index = 0; index < PROXY_SUB_MISS_LIMIT * 2; index += 1) recordProxySubMiss("5.5.5.5", now + index * (PROXY_SUB_MISS_WINDOW_MS / 10));
  assert.equal(proxySubMissBlockState("5.5.5.5", now + PROXY_SUB_MISS_LIMIT * 2 * (PROXY_SUB_MISS_WINDOW_MS / 10)).blocked, false);
  // ::ffff: 映射写法和 IPv4 算同一个。
  clearProxySubRateLimitForTests();
  for (let index = 0; index < PROXY_SUB_MISS_LIMIT; index += 1) recordProxySubMiss("::ffff:6.6.6.6", now);
  assert.equal(proxySubMissBlockState("6.6.6.6", now).blocked, true);
  pruneProxySubRateLimit(now + PROXY_SUB_MISS_BLOCK_MS + 1);
  assert.equal(proxySubMissBlockState("6.6.6.6", now + PROXY_SUB_MISS_BLOCK_MS + 1).blocked, false);
});
