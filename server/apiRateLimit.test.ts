import assert from "node:assert/strict";
import test from "node:test";
import {
  apiRateLimitMessage,
  apiRateLimitSubject,
  checkApiRateLimit,
  DEFAULT_API_RATE_LIMIT,
  normalizeApiRateLimitConfig,
  resetApiRateLimitForTests,
  type ApiRateLimitConfig,
} from "./apiRateLimit";

const small: ApiRateLimitConfig = {
  enabled: true,
  userQueryPerMinute: 10,
  userMutationPerMinute: 3,
  tokenQueryPerMinute: 5,
  tokenMutationPerMinute: 2,
  anonymousQueryPerMinute: 4,
  anonymousMutationPerMinute: 1,
};

// 一个整分钟的开头，方便算窗口
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % 60_000);

test("额度以内放行，第 N+1 次挡下，给出至少 1 秒的 Retry-After", () => {
  resetApiRateLimitForTests();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(checkApiRateLimit({ userId: 7 }, "mutation", small, T0 + i).limited, false);
  }
  const blocked = checkApiRateLimit({ userId: 7 }, "mutation", small, T0 + 10);
  assert.equal(blocked.limited, true);
  assert.equal(blocked.subject, "user");
  assert.equal(blocked.limit, 3);
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);
});

test("查询和修改各一份额度；令牌、用户、匿名 IP 各算各的", () => {
  resetApiRateLimitForTests();
  for (let i = 0; i < 3; i += 1) checkApiRateLimit({ userId: 7 }, "mutation", small, T0);
  assert.equal(checkApiRateLimit({ userId: 7 }, "mutation", small, T0).limited, true);
  // 同一个人的查询不受修改额度影响
  assert.equal(checkApiRateLimit({ userId: 7 }, "query", small, T0).limited, false);
  // 另一个用户、这个人的令牌、匿名 IP 都是新的额度
  assert.equal(checkApiRateLimit({ userId: 8 }, "mutation", small, T0).limited, false);
  assert.equal(checkApiRateLimit({ userId: 7, apiTokenId: 3 }, "mutation", small, T0).limited, false);
  assert.equal(checkApiRateLimit({ ip: "203.0.113.9" }, "mutation", small, T0).limited, false);
  assert.equal(checkApiRateLimit({ ip: "203.0.113.9" }, "mutation", small, T0).limited, true);
  // 带令牌时按令牌算，不按用户
  assert.equal(apiRateLimitSubject({ userId: 7, apiTokenId: 3 }, "query", small).subject, "token");
  assert.equal(apiRateLimitSubject({ userId: 7, apiTokenId: 3 }, "query", small).limit, 5);
  // subscription 之类非 query 的都算修改
  assert.equal(checkApiRateLimit({ ip: "198.51.100.1" }, "subscription", small, T0).limited, false);
  assert.equal(checkApiRateLimit({ ip: "198.51.100.1" }, "mutation", small, T0).limited, true);
});

test("IPv6 按 /64 归并：同一段里换地址不换额度", () => {
  resetApiRateLimitForTests();
  assert.equal(checkApiRateLimit({ ip: "2001:db8:1:2::1" }, "mutation", small, T0).limited, false);
  assert.equal(checkApiRateLimit({ ip: "2001:db8:1:2::ffff" }, "mutation", small, T0).limited, true);
  assert.equal(checkApiRateLimit({ ip: "2001:db8:1:3::1" }, "mutation", small, T0).limited, false);
});

test("滑动窗口：上一分钟的量按剩余比例折算，不会在整分钟一过就全部清零", () => {
  resetApiRateLimitForTests();
  // 上一分钟最后时刻用满 10 次
  for (let i = 0; i < 10; i += 1) assert.equal(checkApiRateLimit({ userId: 1 }, "query", small, T0 + 59_000).limited, false);
  // 新的一分钟刚开始（过了 6 秒）：上一分钟还算 9 次，只剩 1 次
  assert.equal(checkApiRateLimit({ userId: 1 }, "query", small, T0 + 66_000).limited, false);
  const blocked = checkApiRateLimit({ userId: 1 }, "query", small, T0 + 66_500);
  assert.equal(blocked.limited, true);
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60, String(blocked.retryAfterSeconds));
  // 等到窗口过半，额度慢慢回来
  assert.equal(checkApiRateLimit({ userId: 1 }, "query", small, T0 + 90_000).limited, false);
  // 隔了两分钟以上，什么都不剩
  for (let i = 0; i < 10; i += 1) assert.equal(checkApiRateLimit({ userId: 1 }, "query", small, T0 + 200_000).limited, false);
});

test("被挡的那次不计数：一直重试也不会把等待时间越推越远", () => {
  resetApiRateLimitForTests();
  checkApiRateLimit({ ip: "192.0.2.1" }, "mutation", small, T0);
  const first = checkApiRateLimit({ ip: "192.0.2.1" }, "mutation", small, T0 + 1_000);
  for (let i = 0; i < 50; i += 1) checkApiRateLimit({ ip: "192.0.2.1" }, "mutation", small, T0 + 1_000);
  const later = checkApiRateLimit({ ip: "192.0.2.1" }, "mutation", small, T0 + 1_000);
  assert.equal(first.limited, true);
  assert.equal(first.retryAfterSeconds, later.retryAfterSeconds);
  // 隔开一整个窗口后能再调（额度只有 1 次时，上一分钟那 1 次要折算到几乎为 0 才放）
  assert.equal(checkApiRateLimit({ ip: "192.0.2.1" }, "mutation", small, T0 + 125_000).limited, false);
});

test("关掉限流、某一项填 0 = 不限", () => {
  resetApiRateLimitForTests();
  const off = { ...small, enabled: false };
  for (let i = 0; i < 100; i += 1) assert.equal(checkApiRateLimit({ userId: 1 }, "mutation", off, T0).limited, false);
  const zero = { ...small, userMutationPerMinute: 0 };
  for (let i = 0; i < 100; i += 1) assert.equal(checkApiRateLimit({ userId: 2 }, "mutation", zero, T0).limited, false);
});

test("设置 JSON 规范化：缺的项用默认值，太小的夹到下限，负数 / 0 是不限，enabled 默认开", () => {
  assert.deepEqual(normalizeApiRateLimitConfig(null), DEFAULT_API_RATE_LIMIT);
  const c = normalizeApiRateLimitConfig({ enabled: false, userQueryPerMinute: 3, tokenQueryPerMinute: "abc", anonymousMutationPerMinute: 0, userMutationPerMinute: -5 });
  assert.equal(c.enabled, false);
  assert.equal(c.userQueryPerMinute, 10);
  assert.equal(c.tokenQueryPerMinute, DEFAULT_API_RATE_LIMIT.tokenQueryPerMinute);
  assert.equal(c.anonymousMutationPerMinute, 0);
  assert.equal(c.userMutationPerMinute, 0);
  assert.equal(normalizeApiRateLimitConfig({ userQueryPerMinute: 10_000_000 }).userQueryPerMinute, 100_000);
});

test("默认额度留足余量：用户查询 ≥ 1000 / 分，修改 ≥ 200 / 分", () => {
  assert.ok(DEFAULT_API_RATE_LIMIT.userQueryPerMinute >= 1000);
  assert.ok(DEFAULT_API_RATE_LIMIT.userMutationPerMinute >= 200);
  assert.equal(DEFAULT_API_RATE_LIMIT.enabled, true);
});

test("拒绝说明是中文，写清是谁、哪一档、等几秒", () => {
  assert.equal(
    apiRateLimitMessage({ subject: "token", limit: 600, retryAfterSeconds: 12 }, "query"),
    "请求太频繁：这个 API 令牌每分钟最多 600 次查询，请 12 秒后再试",
  );
  assert.equal(
    apiRateLimitMessage({ subject: "anonymous", limit: 60, retryAfterSeconds: 1 }, "mutation"),
    "请求太频繁：这个 IP 每分钟最多 60 次修改，请 1 秒后再试",
  );
  assert.match(apiRateLimitMessage({ subject: "user", limit: 240, retryAfterSeconds: 3 }, "mutation"), /^请求太频繁：你的账号每分钟最多 240 次修改/);
});
