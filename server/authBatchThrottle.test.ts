import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// tRPC batch 里的调用是并发执行的；这里用同一来源并发发起一批登录，模拟一次 batch 请求，
// 确认验证码门槛和登录封禁在同一批里就能生效，而不是整批都先通过检查。
test("concurrent (batched) login attempts still hit the captcha gate and the rate limit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-auth-batch-"));
  const databasePath = path.join(directory, "auth-batch.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { hashPassword } = await import(moduleUrl("server/password.ts"));
    const { authRouter } = await import(moduleUrl("server/routers/auth.ts"));
    const { LOGIN_CAPTCHA_FAILURE_THRESHOLD } = await import(moduleUrl("server/authCaptcha.ts"));
    const { LOGIN_BLOCK_THRESHOLD_PER_ACCOUNT } = await import(moduleUrl("server/authRateLimit.ts"));

    const caller = authRouter.createCaller({
      req: { ip: "203.0.113.77", headers: {}, socket: { remoteAddress: "203.0.113.77" } },
      res: { cookie() {}, clearCookie() {} },
      user: null,
      authSession: null,
      authFailureReason: null,
    });
    const messageOf = (result) => result.status === "fulfilled" ? "ok" : String(result.reason?.message || result.reason);
    const count = (messages, pattern) => messages.filter((message) => pattern.test(message)).length;

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)',
        [1, "victim@example.com", await hashPassword("correct-horse"), "user"],
      );

      const BATCH = 20;
      const first = (await Promise.allSettled(Array.from({ length: BATCH }, () => caller.login({
        username: "victim@example.com",
        password: "wrong-password",
      })))).map(messageOf);
      // 只有达到验证码门槛之前的那几次真正校验了密码，其余都要求验证码。
      const passwordChecked = count(first, /用户名或密码错误|CAPTCHA_REQUIRED_AFTER_FAIL/);
      assert.equal(passwordChecked, LOGIN_CAPTCHA_FAILURE_THRESHOLD, first.join(" | "));
      assert.equal(count(first, /^CAPTCHA_REQUIRED$/), BATCH - LOGIN_CAPTCHA_FAILURE_THRESHOLD, first.join(" | "));

      // 带着错误验证码继续并发：失败次数累计到封禁门槛之后，剩下的请求必须直接被限流。
      const second = (await Promise.allSettled(Array.from({ length: BATCH }, () => caller.login({
        username: "victim@example.com",
        password: "wrong-password",
        captchaId: "bogus-challenge",
        captchaAnswer: "AAAAA",
      })))).map(messageOf);
      const invalid = count(second, /CAPTCHA_INVALID/);
      assert.equal(invalid, LOGIN_BLOCK_THRESHOLD_PER_ACCOUNT - LOGIN_CAPTCHA_FAILURE_THRESHOLD, second.join(" | "));
      assert.equal(count(second, /LOGIN_RATE_LIMITED/), BATCH - invalid, second.join(" | "));

      // 被封禁期间即使密码正确也进不去。
      await assert.rejects(
        () => caller.login({ username: "victim@example.com", password: "correct-horse" }),
        /LOGIN_RATE_LIMITED/,
      );
    } finally {
      await runtime.closeDatabase();
    }
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
