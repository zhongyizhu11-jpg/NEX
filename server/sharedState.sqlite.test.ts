import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  多实例共享状态的库那一层（server/sharedStateStore.ts、sharedStateCounter.ts）和接上它的三个模块，
  在真库上跑一遍：FORWARDX_SHARED_STATE=db 强制走库（默认 SQLite；设 FORWARDX_TEST_DB_KIND=postgresql +
  FORWARDX_TEST_POSTGRES_URL 时在 PostgreSQL 上跑，方言差异 —— RETURNING、CTE、ON CONFLICT —— 在这里暴露）。
  内存路径的行为由各模块原来的单元测试盯着，这里只管库路径。
  两个进程真的各起一份模块、共享一个库的场景见 sharedState.cluster.test.ts。
*/

const setup = String.raw`
  const stores = await import(url("server/sharedStateStore.ts"));
  const counters = await import(url("server/sharedStateCounter.ts"));
  const shared = await import(url("server/sharedState.ts"));
  const count = async (table) => Number((await runtime.queryRaw('SELECT COUNT(*) AS n FROM ' + runtime.quoteDbIdentifier(table)))[0].n);
  assert.equal(shared.sharedStateMode(), "db", "FORWARDX_SHARED_STATE=db 要强制走库");
`;

function run(body: string, name: string) {
  runInDatabase(body, { name, setup, quiet: true, env: { FORWARDX_SHARED_STATE: "db" }, timeoutMs: 180_000 });
}

test("固定窗口计数：并发 upsert 一个不丢，顺带带回上一个窗口；两个窗口之前的清掉", () => {
  run(String.raw`
    const store = new stores.SqlWindowCounterStore();
    const WINDOW = 60_000;
    const w1 = 1_800_000_000_000;
    const results = await Promise.all(Array.from({ length: 25 }, () => store.hit("u:1:query", w1, WINDOW, false)));
    const currents = results.map((r) => r.current).sort((a, b) => a - b);
    assert.deepEqual(currents, Array.from({ length: 25 }, (_, i) => i + 1), "每次加一都拿到各不相同的总数");
    // 下一个窗口第一次：要上一个窗口的数
    const next = await store.hit("u:1:query", w1 + WINDOW, WINDOW, true);
    assert.equal(next.current, 1);
    assert.equal(next.previous, 25);
    // 别的键、没有上一个窗口：previous 是 0（要了的话）或 null（没要）
    const other = await store.hit("u:2:query", w1 + WINDOW, WINDOW, true);
    assert.equal(other.current, 1);
    assert.equal(other.previous, 0);
    const silent = await store.hit("u:2:query", w1 + WINDOW, WINDOW, false);
    assert.equal(silent.current, 2);
    if (runtime.getDatabaseKind() !== "postgresql") assert.equal(silent.previous, null);
    assert.equal(await count("api_rate_limit_windows"), 3);
    // 清理：窗口在「现在 − 2 个窗口」之前的行（这里的 windowStart 都是 2027 年的，不会被清）
    assert.equal(await store.prune(WINDOW), 0);
    const old = Math.floor(Date.now() / WINDOW) * WINDOW - 5 * WINDOW;
    await store.hit("u:3:query", old, WINDOW, false);
    assert.equal(await store.prune(WINDOW), 1);
  `, "shared-window");
});

test("计数行：并发加一不丢，窗口按库的时钟过期后从 1 重数（anchor last / first 两种），读 / 清 / 清理", () => {
  run(String.raw`
    let offset = 0;
    const store = new stores.SqlAttemptCounterStore({ clockOffsetMs: () => offset });
    const WINDOW = 30 * 60_000;
    const rows = await Promise.all(Array.from({ length: 12 }, () => store.bump("login-ip", "203.0.113.5", WINDOW, "last")));
    assert.deepEqual(rows.map((r) => r.hits).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
    const last = rows.find((r) => r.hits === 12);
    assert.ok(Math.abs(last.now - Date.now()) < 5_000, "库的时钟不是毫秒？");
    assert.ok(last.lastAt <= last.now && last.firstAt <= last.lastAt);
    // 不到窗口：继续累加，firstAt 不变
    offset += WINDOW - 1_000;
    const more = await store.bump("login-ip", "203.0.113.5", WINDOW, "last");
    assert.equal(more.hits, 13);
    assert.equal(more.firstAt, last.firstAt);
    // anchor last：从最近一次算，再过一个窗口就重数
    offset += WINDOW;
    const reset = await store.bump("login-ip", "203.0.113.5", WINDOW, "last");
    assert.equal(reset.hits, 1);
    assert.ok(reset.firstAt > more.firstAt);

    // anchor first：从第一次算，期间一直有动静也到点清零
    const ISSUE = 60_000;
    for (let i = 0; i < 5; i++) {
      offset += 10_000;
      const row = await store.bump("2fa-issue-ip", "203.0.113.5", ISSUE, "first");
      assert.equal(row.hits, i + 1, "第 " + (i + 1) + " 次");
    }
    offset += 5_000;
    assert.equal((await store.bump("2fa-issue-ip", "203.0.113.5", ISSUE, "first")).hits, 6, "距第一次 55 秒：还在这一轮");
    offset += 20_000;
    const sixth = await store.bump("2fa-issue-ip", "203.0.113.5", ISSUE, "first");
    assert.equal(sixth.hits, 1, "距第一次已过 60 秒：新一轮");

    // 一次读几个；没有的不在结果里
    const read = await store.read([
      { scope: "login-ip", key: "203.0.113.5" }, { scope: "2fa-issue-ip", key: "203.0.113.5" }, { scope: "login-ip", key: "nobody" },
    ]);
    assert.equal(read.size, 2);
    assert.equal(read.get(stores.attemptCounterKey("login-ip", "203.0.113.5")).hits, 1);
    assert.equal(read.get(stores.attemptCounterKey("2fa-issue-ip", "203.0.113.5")).hits, 1);
    await store.clear("login-ip", "203.0.113.5");
    assert.equal((await store.read([{ scope: "login-ip", key: "203.0.113.5" }])).size, 0);
    // 清理：最近一次在一小时之前的
    assert.equal(await store.prune(60 * 60_000), 0);
    offset += 2 * 60 * 60_000;
    assert.equal(await store.prune(60 * 60_000), 1);
    assert.equal(await count("auth_attempt_counters"), 0);
  `, "shared-counter-rows");
});

test("验证码行：放 / 取 / 用一次就删（并发只有一个拿到）/ 过期清理", () => {
  run(String.raw`
    const store = new stores.SqlCaptchaChallengeStore();
    const now = Date.now();
    await store.put({ kind: "cap-bind", id: "abc", ip: "203.0.113.1", purpose: "login", data: null, expiresAt: now + 60_000 });
    await store.put({ kind: "image", id: "abc", ip: "203.0.113.2", purpose: "register", data: "hash", expiresAt: now - 120_000 });
    assert.deepEqual(await store.get("cap-bind", "abc"), { kind: "cap-bind", id: "abc", ip: "203.0.113.1", purpose: "login", data: null, expiresAt: now + 60_000 });
    assert.equal(await store.get("cap-token", "abc"), null, "kind 不同就是另一行");
    const consumers = await Promise.all(Array.from({ length: 6 }, () => store.consume("cap-bind", "abc")));
    assert.equal(consumers.filter(Boolean).length, 1, "同一枚只能用一次");
    assert.equal(await store.get("cap-bind", "abc"), null);
    assert.equal(await store.prune(60_000), 1, "过期超过一分钟的删掉");
    assert.equal(await count("auth_captcha_challenges"), 0);
  `, "shared-captcha-rows");
});

test("SharedCounter：两份实例共享一个计数；清掉传到另一份；代数挡住迟到的加一", () => {
  run(String.raw`
    const make = () => new counters.SharedCounter({ scope: "login-pair", windowMs: 30 * 60_000, anchor: "last", maxKeys: 100 });
    const a = make();
    const b = make();
    for (let i = 0; i < 5; i++) a.bump("k");
    await a.flush();
    assert.equal(a.state("k").count, 5);
    // B 第一次看：本地没有（顺手去库里刷），刷回来之后看到 5
    assert.equal(b.state("k"), null);
    await b.flush();
    assert.equal(b.state("k").count, 5);
    // B 再记 3 次：库里 8，A 下一次刷新后也是 8
    for (let i = 0; i < 3; i++) b.bump("k");
    await b.flush();
    assert.equal(b.state("k").count, 8);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // 同一个键的刷新至少隔 1 秒
    a.state("k");
    await a.flush();
    assert.equal(a.state("k").count, 8);
    // A 清掉（登录成功）：库里没了；B 刷新后缓存也没了
    a.clear("k");
    await a.flush();
    assert.equal(a.state("k"), null);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(b.state("k").count, 8, "刷新回来之前还是旧的");
    await b.flush();
    assert.equal(b.state("k"), null, "库里没这一行了，缓存跟着清");
    // 代数：加一还在路上就被清掉，回来的结果不能把计数写回去
    const slow = new counters.SharedCounter({ scope: "login-pair", windowMs: 30 * 60_000, anchor: "last", maxKeys: 100, store: {
      bump: async (...args) => { await new Promise((resolve) => setTimeout(resolve, 200)); return new stores.SqlAttemptCounterStore().bump(...args); },
      read: (...args) => new stores.SqlAttemptCounterStore().read(...args),
      clear: (...args) => new stores.SqlAttemptCounterStore().clear(...args),
      prune: (...args) => new stores.SqlAttemptCounterStore().prune(...args),
    } });
    slow.bump("g");
    slow.clear("g");
    await slow.flush();
    assert.equal(slow.state("g"), null);
  `, "shared-counter");
});

test("接口限流 db 模式：库里的总数覆盖本地估算；明显超额的键不再碰库；写库失败按本地计数", () => {
  run(String.raw`
    const api = await import(url("server/apiRateLimit.ts"));
    const config = { ...api.DEFAULT_API_RATE_LIMIT, userQueryPerMinute: 10 };
    let calls = 0;
    let failing = false;
    const real = new stores.SqlWindowCounterStore();
    api.setApiRateLimitSharedStoreForTests({
      hit: async (...args) => { calls += 1; if (failing) throw new Error("db down"); return real.hit(...args); },
      prune: (...args) => real.prune(...args),
    });
    const T0 = Math.floor(Date.now() / 60_000) * 60_000 + 1_000;
    // 另一个实例已经在这个窗口里用掉了 7 次
    for (let i = 0; i < 7; i++) await real.hit("u:1:query", T0 - 1_000, 60_000, false);
    // 本实例第 1 次：本地没数，放行；写库回来知道已经 8 了
    assert.equal(api.checkApiRateLimit({ userId: 1 }, "query", config, T0).limited, false);
    await api.waitForApiRateLimitSharedWrites();
    assert.equal(api.checkApiRateLimit({ userId: 1 }, "query", config, T0 + 1).limited, false);
    await api.waitForApiRateLimitSharedWrites();
    assert.equal(api.checkApiRateLimit({ userId: 1 }, "query", config, T0 + 2).limited, false);
    await api.waitForApiRateLimitSharedWrites();
    assert.equal(calls, 3);
    const blocked = api.checkApiRateLimit({ userId: 1 }, "query", config, T0 + 3);
    assert.equal(blocked.limited, true, "库里已经 10 次");
    assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);
    for (let i = 0; i < 50; i++) assert.equal(api.checkApiRateLimit({ userId: 1 }, "query", config, T0 + 4).limited, true);
    assert.equal(calls, 3, "超额之后的请求不再碰库");
    assert.equal((await runtime.queryRaw('SELECT ' + runtime.quoteDbIdentifier("hits") + ' FROM ' + runtime.quoteDbIdentifier("api_rate_limit_windows")))[0].hits, 10);
    // 在途的也算：同一瞬间来 10 个，只放 10 − 已知的
    api.resetApiRateLimitForTests();
    const burst = Array.from({ length: 10 }, (_, i) => api.checkApiRateLimit({ userId: 2 }, "query", config, T0 + i).limited);
    assert.deepEqual(burst, Array(10).fill(false));
    assert.equal(api.checkApiRateLimit({ userId: 2 }, "query", config, T0 + 10).limited, true, "在途的 10 个算进估算");
    await api.waitForApiRateLimitSharedWrites();
    // 写库失败：按本地计数继续，接口不受影响
    api.resetApiRateLimitForTests();
    failing = true;
    for (let i = 0; i < 10; i++) {
      assert.equal(api.checkApiRateLimit({ userId: 3 }, "query", config, T0 + i).limited, false);
      await api.waitForApiRateLimitSharedWrites();
    }
    assert.equal(api.checkApiRateLimit({ userId: 3 }, "query", config, T0 + 10).limited, true);
    failing = false;
    // 跨窗口：上一分钟的量从库里补回来（本地只知道自己那份）
    api.resetApiRateLimitForTests();
    for (let i = 0; i < 10; i++) await real.hit("u:4:query", T0 - 1_000, 60_000, false);
    assert.equal(api.checkApiRateLimit({ userId: 4 }, "query", config, T0 + 60_000 + 6_000).limited, false, "新窗口第一次放行");
    await api.waitForApiRateLimitSharedWrites();
    assert.equal(api.checkApiRateLimit({ userId: 4 }, "query", config, T0 + 60_000 + 6_500).limited, true, "上一分钟 10 次按 90% 折算 + 这一次 = 超");
    // 清理登记进了共享清理
    api.setApiRateLimitSharedStoreForTests(null);
    const deleted = await shared.runSharedStateCleanup({ force: true });
    assert.ok("api_rate_limit_windows" in deleted, JSON.stringify(deleted));
    assert.ok("api_rate_limit_windows" in await shared.runSharedStateCleanup(), "没启动租约时按单实例算（本进程就是持有者），强制 db 模式下照样清");
  `, "shared-api-rate-limit");
});

test("登录锁定 / 2FA 签发 / 找回密码额度 db 模式：写进库、读回来；验证码挑战跨实例兑换，用一次就作废", () => {
  run(String.raw`
    const auth = await import(url("server/authRateLimit.ts"));
    for (let i = 0; i < 8; i++) auth.recordPasswordFailure("203.0.113.9", "Admin@Example.com", Date.now());
    await auth.flushAuthRateLimitSharedState();
    const rows = await runtime.queryRaw('SELECT ' + runtime.quoteDbIdentifier("scope") + ', ' + runtime.quoteDbIdentifier("hits") + ' FROM ' + runtime.quoteDbIdentifier("auth_attempt_counters") + ' ORDER BY ' + runtime.quoteDbIdentifier("scope"));
    assert.deepEqual(rows.map((r) => [r.scope, Number(r.hits)]), [["login-ip", 8], ["login-pair", 8]], "密码失败只记 IP 和 IP+账户，不记账户维度");
    assert.equal(auth.authRateLimitState("203.0.113.9", "admin@example.com").limited, true);
    // 别的实例（清掉本地缓存模拟）：第一次看不到，刷新后锁住
    auth.clearAuthRateLimitStateForTests();
    assert.equal(auth.authRateLimitState("203.0.113.9", "admin@example.com").limited, false);
    await auth.flushAuthRateLimitSharedState();
    const locked = auth.authRateLimitState("203.0.113.9", "admin@example.com");
    assert.equal(locked.limited, true);
    assert.ok(locked.retryAfterSeconds > 14 * 60 && locked.retryAfterSeconds <= 15 * 60, String(locked.retryAfterSeconds));
    auth.clearAuthAccountFailures("203.0.113.9", "admin@example.com");
    await auth.flushAuthRateLimitSharedState();
    assert.equal((await runtime.queryRaw('SELECT ' + runtime.quoteDbIdentifier("scope") + ' FROM ' + runtime.quoteDbIdentifier("auth_attempt_counters"))).map((r) => r.scope).join(), "login-ip", "按 IP 的那份不清");

    // 2FA 挑战签发：5 次 / 分钟，固定窗口从第一次算
    for (let i = 0; i < 5; i++) {
      assert.equal(auth.twoFactorChallengeIssueState("203.0.113.9", "user").limited, false);
      auth.recordTwoFactorChallengeIssue("203.0.113.9", "user");
      await auth.flushAuthRateLimitSharedState();
    }
    const issue = auth.twoFactorChallengeIssueState("203.0.113.9", "user");
    assert.equal(issue.limited, true);
    assert.ok(issue.retryAfterSeconds >= 1 && issue.retryAfterSeconds <= 60);
    // 找回密码额度：窗口按调用传
    assert.equal(auth.consumeAttemptBudget("pwreset-account-cooldown:1", 1, 5 * 60_000).limited, false);
    await auth.flushAuthRateLimitSharedState();
    assert.equal(auth.consumeAttemptBudget("pwreset-account-cooldown:1", 1, 5 * 60_000).limited, true);
    assert.equal(auth.attemptBudgetState("pwreset-account-cooldown:1", 1, 5 * 60_000).limited, true);
    assert.equal((await runtime.queryRaw('SELECT ' + runtime.quoteDbIdentifier("hits") + ' FROM ' + runtime.quoteDbIdentifier("auth_attempt_counters") + ' WHERE ' + runtime.quoteDbIdentifier("scope") + " = 'budget'"))[0].hits, 1, "被挡的那次不记");

    // 验证码：失败计数进库；Cap 挑战在 A 签发、B 兑换、A 验令牌、再验作废
    const captchaModule = await import(url("server/authCaptcha.ts"));
    const solver = await import(url("server/authCaptchaTestSolver.ts"));
    const a = new captchaModule.AuthCaptchaService({ svgGenerator: () => ({ text: "A7K9P", data: "<svg></svg>" }) });
    const b = new captchaModule.AuthCaptchaService({ svgGenerator: () => ({ text: "A7K9P", data: "<svg></svg>" }) });
    for (let i = 0; i < 3; i++) a.recordLoginFailure("203.0.113.9", "user@example.com");
    await a.flushSharedWrites();
    assert.equal(a.requiresLoginCaptcha("203.0.113.9", "user@example.com"), true);
    assert.equal(b.requiresLoginCaptcha("203.0.113.9", "user@example.com"), false, "B 第一次看本地没有");
    await b.flushSharedWrites();
    assert.equal(b.requiresLoginCaptcha("203.0.113.9", "user@example.com"), true, "刷新后 B 也要验证码");
    const issued = await a.createCapChallenge("192.0.2.40", "login");
    assert.equal(await count("auth_captcha_challenges"), 2, "Cap 的挑战 + 本层的绑定");
    const redeemed = await b.redeemCapChallenge("192.0.2.40", "login", issued.token, solver.capSolutions(issued.token, issued.challenge));
    assert.equal(redeemed.success, true);
    assert.equal((await b.redeemCapChallenge("192.0.2.40", "login", issued.token, solver.capSolutions(issued.token, issued.challenge))).success, false, "挑战用过就没了");
    assert.equal(await a.verifyCapToken("192.0.2.41", "login", redeemed.token), false, "换 IP 不认（而且这一下就把令牌用掉了）");
    const again = await a.createCapChallenge("192.0.2.40", "login");
    const token = (await b.redeemCapChallenge("192.0.2.40", "login", again.token, solver.capSolutions(again.token, again.challenge))).token;
    assert.equal(await a.verifyCapToken("192.0.2.40", "login", token), true);
    assert.equal(await b.verifyCapToken("192.0.2.40", "login", token), false, "用过一次就作废，别的实例也不认");
    // 图片挑战：同步版只认本进程的；异步版去库里取
    const image = a.createImageChallenge("192.0.2.50", "login");
    await a.flushSharedWrites();
    assert.equal(b.verifyChallenge(image.captchaId, "A7K9P", "192.0.2.50", "login"), false, "同步接口看不到别的实例签的");
    assert.equal(await b.verifyChallengeShared(image.captchaId, "a7k9p", "192.0.2.51", "login"), false, "IP 不对，而且这一下用掉了");
    const image2 = a.createImageChallenge("192.0.2.50", "login");
    await a.flushSharedWrites();
    assert.equal(await b.verifyChallengeShared(image2.captchaId, "a7k9p", "192.0.2.50", "login"), true);
    assert.equal(await b.verifyChallengeShared(image2.captchaId, "a7k9p", "192.0.2.50", "login"), false);
    assert.equal(await a.verifyChallengeShared(image2.captchaId, "A7K9P", "192.0.2.50", "login"), false, "签发方本地那份也不能再用");
    await a.flushSharedWrites();
    // 只剩第一枚令牌在 Cap 自己那边的行（换 IP 验的那次没走到 Cap 的 validateToken）：到期后由清理删
    const left = await runtime.queryRaw('SELECT ' + runtime.quoteDbIdentifier("kind") + ' FROM ' + runtime.quoteDbIdentifier("auth_captcha_challenges"));
    assert.deepEqual(left.map((r) => r.kind), ["cap-token"]);
  `, "shared-auth");
});
