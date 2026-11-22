import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 机器人「网页登录」链接的预览。
 *
 * 登录页不再打开 /login?tg=CODE 就自动登录（登录 CSRF：别人把自己的链接发给你，
 * 你就被登进他的账户）。页面先调 previewLogin 显示要登录的账户，用户确认后才调 login。
 * 这里钉住：预览只读、不消费登录码；只回用户名；过期/不存在的码报错并按来源 IP 限流。
 */
test("telegram login link preview is read-only, minimal and rate limited", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-telegram-preview-"));
  const databasePath = path.join(directory, "telegram-preview.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const users = await import(moduleUrl("server/repositories/userRepository.ts"));
    const { telegramRouter } = await import(moduleUrl("server/routers/telegram.ts"));
    const context = (ip) => ({
      req: { headers: {}, ip, socket: { remoteAddress: ip } },
      res: { clearCookie() {}, cookie() {} },
      user: null,
      authSession: null,
      authFailureReason: null,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "role", "telegramId", "telegramUsername", "email") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [7, "attacker", "secret-hash", "user", "1234567", "attacker_tg", "attacker@example.com"],
      );
      const code = "A".repeat(32);
      await users.createTelegramLoginCode(7, code, new Date(Date.now() + 5 * 60 * 1000));

      const caller = telegramRouter.createCaller(context("203.0.113.9"));
      const preview = await caller.previewLogin({ code: code.toLowerCase() });
      assert.deepEqual(preview, { username: "attacker", telegramUsername: "attacker_tg" });

      // 预览不消费：确认后登录码仍然可用，且只能用一次。
      assert.equal((await caller.previewLogin({ code })).username, "attacker");
      assert.equal(Number((await users.consumeTelegramLoginCode(code))?.id), 7);
      assert.equal(await users.consumeTelegramLoginCode(code), null);
      await assert.rejects(() => caller.previewLogin({ code }), /Telegram 登录码无效或已过期/);

      // 过期码不可预览。
      const expired = "B".repeat(32);
      await users.createTelegramLoginCode(7, expired, new Date(Date.now() - 1000));
      await assert.rejects(() => caller.previewLogin({ code: expired }), /Telegram 登录码无效或已过期/);

      // APP 前缀的码属于移动端轮询流程，不能用来预览。
      await assert.rejects(() => caller.previewLogin({ code: "APP" + "C".repeat(28) }), /Telegram 登录码无效或已过期/);

      // 试码按来源 IP 限流；别的 IP 不受牵连。
      const prober = telegramRouter.createCaller(context("198.51.100.20"));
      let limited = false;
      for (let i = 0; i < 12; i += 1) {
        try {
          await prober.previewLogin({ code: "D".repeat(31) + String.fromCharCode(65 + i) });
        } catch (error) {
          if (/TELEGRAM_LOGIN_RATE_LIMITED:/.test(String(error?.message))) {
            limited = true;
            break;
          }
        }
      }
      assert.equal(limited, true, "repeated invalid previews from one IP are rate limited");
      const fresh = "E".repeat(32);
      await users.createTelegramLoginCode(7, fresh, new Date(Date.now() + 5 * 60 * 1000));
      assert.equal((await telegramRouter.createCaller(context("192.0.2.30")).previewLogin({ code: fresh })).username, "attacker");
    } finally {
      await runtime.closeDatabase();
    }
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
