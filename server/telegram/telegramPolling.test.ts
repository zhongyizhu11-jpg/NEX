import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TELEGRAM_POLL_BACKOFF_MAX_MS,
  TELEGRAM_POLL_BACKOFF_MIN_MS,
  TELEGRAM_RETRY_AFTER_MAX_MS,
  TelegramApiError,
  isPermanentTelegramRecipientError,
  isTelegramUnauthorizedError,
  telegramPollingRetryDelayMs,
  telegramRetryAfterMs,
} from "./telegramApiError";

test("轮询失败退避：5 秒起步逐次翻倍、最多 5 分钟；429 至少等 retry_after", () => {
  const plain = new Error("fetch failed");
  assert.equal(telegramPollingRetryDelayMs(1, plain), TELEGRAM_POLL_BACKOFF_MIN_MS);
  assert.equal(telegramPollingRetryDelayMs(2, plain), TELEGRAM_POLL_BACKOFF_MIN_MS * 2);
  assert.equal(telegramPollingRetryDelayMs(3, plain), TELEGRAM_POLL_BACKOFF_MIN_MS * 4);
  assert.equal(telegramPollingRetryDelayMs(50, plain), TELEGRAM_POLL_BACKOFF_MAX_MS);
  const limited = new TelegramApiError("getUpdates", "Too Many Requests: retry after 60", 429, 60);
  assert.equal(telegramPollingRetryDelayMs(1, limited), 60_000);
  const hugeRetry = new TelegramApiError("getUpdates", "Too Many Requests", 429, 3600);
  assert.equal(telegramPollingRetryDelayMs(1, hugeRetry), TELEGRAM_POLL_BACKOFF_MAX_MS);
});

test("错误分类：401 是 Token 问题，403/chat not found 是收件人问题，429 给出等待时间", () => {
  assert.equal(isTelegramUnauthorizedError(new TelegramApiError("getUpdates", "Unauthorized", 401)), true);
  assert.equal(isTelegramUnauthorizedError(new Error("Unauthorized")), false);
  assert.equal(isPermanentTelegramRecipientError(new TelegramApiError("sendMessage", "Forbidden: bot can't initiate conversation with a user", 403)), true);
  assert.equal(isPermanentTelegramRecipientError(new TelegramApiError("sendMessage", "Bad Request: chat not found", 400)), true);
  assert.equal(isPermanentTelegramRecipientError(new TelegramApiError("sendMessage", "Bad Request: can't parse entities", 400)), false);
  assert.equal(telegramRetryAfterMs(new TelegramApiError("sendMessage", "Too Many Requests", 429, 3)), 3_000);
  assert.equal(telegramRetryAfterMs(new TelegramApiError("sendMessage", "Too Many Requests", 429, 600)), TELEGRAM_RETRY_AFTER_MAX_MS);
  assert.equal(telegramRetryAfterMs(new TelegramApiError("sendMessage", "Bad Request", 400)), null);
});

test("轮询只起一个循环；401 时停下，保存设置后能重新启动；后台发送遇到 429 等一次再发", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-telegram-polling-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const calls = [];
      let limitedOnce = true;
      globalThis.fetch = async (target, init) => {
        const method = String(target).split("/").pop();
        const body = JSON.parse(String(init?.body || "{}"));
        calls.push({ method, chatId: body.chat_id });
        const reply = (status, json) => ({ ok: status === 200, status, json: async () => json });
        if (method === "getUpdates") return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
        if (method === "sendMessage" && body.chat_id === "limited" && limitedOnce) {
          limitedOnce = false;
          return reply(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } });
        }
        return reply(200, { ok: true, result: method === "getMe" ? { username: "bot" } : { message_id: 1 } });
      };
      console.warn = () => {};
      console.info = () => {};

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      await settings.setSetting("telegramBotEnabled", "true");
      await settings.setSetting("telegramBotToken", "1:token");
      const bot = await import(url("server/telegram/telegramBot.ts"));
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const getUpdates = () => calls.filter((call) => call.method === "getUpdates").length;

      // 启动时和保存设置时几乎同时调进来：只能起一个循环。
      await Promise.all([bot.startTelegramBot(), bot.startTelegramBot()]);
      await wait(500);
      assert.equal(getUpdates(), 1, "两个轮询循环会互相抢 getUpdates；401 之后也不该再重试");

      // 保存设置（systemRouter 会再调 startTelegramBot）后重新启动。
      await bot.startTelegramBot();
      await wait(500);
      assert.equal(getUpdates(), 2, "401 停下之后，保存设置要能把轮询重新拉起来");

      const startedAt = Date.now();
      await bot.sendTelegramMessage("limited", "hello");
      assert.equal(calls.filter((call) => call.method === "sendMessage" && call.chatId === "limited").length, 2);
      assert.ok(Date.now() - startedAt >= 900, "要按 retry_after 等一下再重试");
      console.log("OK");
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "telegram.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_BOT_POLLING: "true",
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
