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
