import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/*
  两个真正独立的面板进程（各自一份 apiRateLimit / authRateLimit / authCaptcha 模块状态）连同一个库，
  FORWARDX_SHARED_STATE=db：A 上的登录失败在 B 上算数、A 用掉的接口额度 B 看得到、A 签发的验证码 B 能兑换。
  默认在 SQLite 上跑；设 FORWARDX_TEST_DB_KIND=postgresql + FORWARDX_TEST_POSTGRES_URL 时在 PostgreSQL 上跑 ——
  多实例部署只支持 MySQL / PostgreSQL，这个测试主要是给 PostgreSQL 的。
  模式和 productStock.sqlite.test.ts 一样：子进程由 FORWARDX_TEST_DB_CONFIG 连同一个库，收到任务做一件事回报结果。
*/

const WORKER = String.raw`
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  console.info = () => {}; console.warn = () => {}; console.log = () => {};
  const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(url("server/dbRuntime.ts"));
  await runtime.connectDatabase(JSON.parse(process.env.FORWARDX_TEST_DB_CONFIG));
  const shared = await import(url("server/sharedState.ts"));
  if (shared.sharedStateMode() !== "db") throw new Error("worker is not in db mode");
  const auth = await import(url("server/authRateLimit.ts"));
  const api = await import(url("server/apiRateLimit.ts"));
  const captchaModule = await import(url("server/authCaptcha.ts"));
  const solver = await import(url("server/authCaptchaTestSolver.ts"));
  const captcha = captchaModule.authCaptcha;
  const config = { ...api.DEFAULT_API_RATE_LIMIT, userQueryPerMinute: 10 };
  const ops = {
    /** 记 times 次密码失败，返回本进程随后看到的锁定状态。 */
    fail: async ({ ip, user, times }) => {
      for (let i = 0; i < times; i++) auth.recordPasswordFailure(ip, user);
      await auth.flushAuthRateLimitSharedState();
      return auth.authRateLimitState(ip, user);
    },
    /** 看一次（顺手刷库），等刷回来再看一次。 */
    state: async ({ ip, user }) => {
      const first = auth.authRateLimitState(ip, user);
      await auth.flushAuthRateLimitSharedState();
      return { first, second: auth.authRateLimitState(ip, user) };
    },
    clear: async ({ ip, user }) => {
      auth.clearAuthAccountFailures(ip, user);
      await auth.flushAuthRateLimitSharedState();
      return true;
    },
    /** 连续调接口直到被挡（每次等写库回来，好让结果可预期），返回放行了几次。 */
    hits: async ({ userId, times }) => {
      let allowed = 0;
      for (let i = 0; i < times; i++) {
        const decision = api.checkApiRateLimit({ userId }, "query", config);
        await api.waitForApiRateLimitSharedWrites();
        if (decision.limited) break;
        allowed += 1;
      }
      return allowed;
    },
    captchaFail: async ({ ip, user, times }) => {
      for (let i = 0; i < times; i++) captcha.recordLoginFailure(ip, user);
      await captcha.flushSharedWrites();
      return captcha.requiresLoginCaptcha(ip, user);
    },
    captchaNeeds: async ({ ip, user }) => {
      const first = captcha.requiresLoginCaptcha(ip, user);
      await captcha.flushSharedWrites();
      return { first, second: captcha.requiresLoginCaptcha(ip, user) };
    },
    capCreate: async ({ ip }) => {
      const issued = await captcha.createCapChallenge(ip, "login");
      return { token: issued.token, challenge: issued.challenge };
    },
    capRedeem: async ({ ip, token, challenge }) => {
      const result = await captcha.redeemCapChallenge(ip, "login", token, solver.capSolutions(token, challenge));
      return { success: result.success, token: result.token || null };
    },
    capVerify: ({ ip, token }) => captcha.verifyCapToken(ip, "login", token),
  };
  process.on("message", async (job) => {
    if (job.op === "exit") process.exit(0);
    try {
      process.send({ id: job.id, result: await ops[job.op](job) });
    } catch (error) {
      process.send({ id: job.id, error: String(error?.stack || error) });
    }
  });
  process.send({ ready: true });
`;

const setup = String.raw`
  const { spawn } = await import("node:child_process");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** 起一个工作进程；ask(op, 参数) 发任务等结果。 */
  const startWorker = async (name) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", ${JSON.stringify(WORKER)}], {
      cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const waiters = new Map();
    let ready;
    const readyPromise = new Promise((resolve) => { ready = resolve; });
    child.on("message", (message) => {
      if (message.ready) { ready(); return; }
      const waiter = waiters.get(message.id);
      waiters.delete(message.id);
      if (!waiter) return;
      if (message.error) waiter.reject(new Error(name + ": " + message.error));
      else waiter.resolve(message.result);
    });
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    child.on("exit", (code) => {
      for (const waiter of waiters.values()) waiter.reject(new Error(name + " exited " + code + ": " + output));
      waiters.clear();
    });
    await Promise.race([readyPromise, exited.then((code) => { throw new Error(name + " exited before ready (" + code + "): " + output); })]);
    let seq = 0;
    return {
      ask: (op, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        waiters.set(id, { resolve, reject });
        child.send({ ...params, op, id });
      }),
      stop: async () => { child.send({ op: "exit" }); await exited; },
      output: () => output,
    };
  };
  const [A, B] = await Promise.all([startWorker("A"), startWorker("B")]);
  const stopWorkers = () => Promise.all([A.stop(), B.stop()]);
  const hits = async () => Number((await runtime.queryRaw('SELECT COALESCE(SUM(' + runtime.quoteDbIdentifier("hits") + '), 0) AS n FROM ' + runtime.quoteDbIdentifier("api_rate_limit_windows")))[0].n);
`;

function run(body: string, name: string) {
  runSharedDatabaseTest(body, { name, setup, quiet: true, env: { FORWARDX_SHARED_STATE: "db" }, timeoutMs: 240_000 });
}

test("两个面板进程共享登录锁定：A 上失败 8 次，B 上第二次看就锁住；A 登录成功清掉，B 跟着解锁", () => {
  run(String.raw`
    try {
      const ip = "203.0.113.77";
      const user = "Admin@Example.com";
      assert.equal((await A.ask("fail", { ip, user, times: 8 })).limited, true, "A 自己先锁住");
      const onB = await B.ask("state", { ip, user: "admin@example.com" });
      assert.equal(onB.first.limited, false, "B 第一次看：本地还没有（顺手去库里刷）");
      assert.equal(onB.second.limited, true, "刷回来之后 B 也锁住");
      assert.ok(onB.second.retryAfterSeconds > 14 * 60, String(onB.second.retryAfterSeconds));
      // 攀上去的那几次失败在 B 上记也一样：阈值是全体的 8 次，不是每个实例 8 次
      const ip2 = "203.0.113.78";
      assert.equal((await A.ask("fail", { ip: ip2, user, times: 4 })).limited, false);
      await sleep(1_100); // 同一个键的刷新至少隔 1 秒
      assert.equal((await B.ask("fail", { ip: ip2, user, times: 4 })).limited, true, "A 4 次 + B 4 次 = 8 次");
      // A 上登录成功：清掉这个 IP + 账户的计数，B 刷新后也解锁
      await A.ask("clear", { ip, user });
      await sleep(1_100);
      const cleared = await B.ask("state", { ip, user });
      assert.equal(cleared.first.limited, true, "刷回来之前 B 还是旧的");
      assert.equal(cleared.second.limited, false, "库里没这一行了，B 的缓存跟着清");
      // 验证码要求同样共享
      assert.equal(await A.ask("captchaFail", { ip, user, times: 3 }), true);
      const needs = await B.ask("captchaNeeds", { ip, user });
      assert.equal(needs.first, false);
      assert.equal(needs.second, true);
    } finally {
      await stopWorkers();
    }
  `, "cluster-lockout");
});

test("两个面板进程共享接口限流窗口：A 用掉 6 次后 B 只剩 4 次；A 最多再多放一次（在途那一次）", () => {
  run(String.raw`
    try {
      assert.equal(await A.ask("hits", { userId: 1, times: 6 }), 6);
      assert.equal(await hits(), 6);
      assert.equal(await B.ask("hits", { userId: 1, times: 20 }), 4, "B 第一次不知道 A 用了 6 次，放行后就知道了：10 − 6 = 4");
      assert.equal(await hits(), 10);
      assert.ok((await A.ask("hits", { userId: 1, times: 20 })) <= 1, "A 本地只知道 6，多放一次就学到 11，之后全挡");
      assert.ok((await hits()) <= 11);
      assert.equal(await A.ask("hits", { userId: 1, times: 20 }), 0);
      assert.equal(await B.ask("hits", { userId: 1, times: 20 }), 0);
      // 别的用户不受影响
      assert.equal(await B.ask("hits", { userId: 2, times: 3 }), 3);
    } finally {
      await stopWorkers();
    }
  `, "cluster-rate-limit");
});

test("两个面板进程共享验证码：A 签发的 Cap 挑战 B 兑换，令牌 A 验过一次 B 就不认", () => {
  run(String.raw`
    try {
      const ip = "198.51.100.9";
      const issued = await A.ask("capCreate", { ip });
      assert.ok(issued.token);
      const redeemed = await B.ask("capRedeem", { ip, token: issued.token, challenge: issued.challenge });
      assert.equal(redeemed.success, true, "B 能兑换 A 签发的挑战");
      assert.equal((await A.ask("capRedeem", { ip, token: issued.token, challenge: issued.challenge })).success, false, "挑战用过就没了");
      assert.equal(await B.ask("capVerify", { ip: "198.51.100.10", token: redeemed.token }), false, "IP 不对不认");
      const second = await A.ask("capCreate", { ip });
      const token = (await B.ask("capRedeem", { ip, token: second.token, challenge: second.challenge })).token;
      assert.equal(await A.ask("capVerify", { ip, token }), true, "A 认 B 兑换出的令牌");
      assert.equal(await B.ask("capVerify", { ip, token }), false, "用过一次就作废");
      assert.equal(await A.ask("capVerify", { ip, token }), false);
    } finally {
      await stopWorkers();
    }
  `, "cluster-captcha");
});
