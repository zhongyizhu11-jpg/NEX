import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 提醒发送的三个老问题：
 *
 * 1. 一条发失败就整轮停下、而且没写标记 —— 清单顺序每轮都一样，于是一个拉黑了
 *    机器人的用户，能让排在他后面的所有提醒永远发不出去。
 * 2. 到期类提醒的去重键带日期：「还剩 2 天」这一档横跨两个 UTC 日历日，同一档发两次。
 * 3. Telegram 那一路在收集落地流量提醒之前就 return 了：没开用户到期/流量提醒、也没有
 *    主机开告警时，落地节点/端口的流量提醒在 Telegram 上永远不发。
 *
 * 真库（SQLite）+ 假 SMTP + 截住 fetch 的假 Telegram，时钟用假的 Date 控制。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-reminder-delivery-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import net from "node:net";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      // 可控时钟：无参 new Date() 和 Date.now() 都走 fakeNow。
      const RealDate = Date;
      let fakeNow = RealDate.parse("2030-01-01T20:00:00Z");
      class FakeDate extends RealDate {
        constructor(...args) { super(...(args.length ? args : [fakeNow])); }
        static now() { return fakeNow; }
      }
      globalThis.Date = FakeDate;
      const setNow = (iso) => { fakeNow = RealDate.parse(iso); };

      // 假 Telegram：按 chat_id 决定怎么回。
      const telegrams = [];
      globalThis.fetch = async (_target, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        const chatId = String(body.chat_id || "");
        const reply = (status, json) => ({ ok: status === 200, status, json: async () => json });
        if (chatId === "blocked") return reply(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
        if (chatId === "nochat") return reply(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
        if (chatId === "badmsg") return reply(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" });
        if (chatId === "down") return reply(502, { ok: false, error_code: 502, description: "Bad Gateway" });
        telegrams.push({ chatId, head: String(body.text || "").split("\n")[0] });
        return reply(200, { ok: true, result: { message_id: telegrams.length } });
      };

      // 假 SMTP：收件人带 reject 的在 RCPT 阶段 550；发件人带 badsender 的在 MAIL FROM 阶段 553。
      const mails = [];
      const smtp = net.createServer((socket) => {
        let buffer = "";
        let inData = false;
        let recipient = "";
        socket.write("220 localhost ESMTP\r\n");
        socket.on("error", () => {});
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let index;
          while ((index = buffer.indexOf("\r\n")) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (inData) {
              if (line === ".") { inData = false; mails.push(recipient); socket.write("250 OK\r\n"); }
              continue;
            }
            const command = line.toUpperCase();
            if (command.startsWith("EHLO") || command.startsWith("HELO")) socket.write("250-localhost\r\n250 8BITMIME\r\n");
            else if (command.startsWith("MAIL")) socket.write(/badsender/i.test(line) ? "553 5.7.1 Sender address rejected\r\n" : "250 OK\r\n");
            else if (command.startsWith("RCPT")) {
              recipient = line.slice(line.indexOf("<") + 1, line.lastIndexOf(">"));
              socket.write(/reject/i.test(recipient) ? "550 5.1.1 User unknown\r\n" : "250 OK\r\n");
            } else if (command.startsWith("DATA")) { inData = true; socket.write("354 go ahead\r\n"); }
            else if (command.startsWith("QUIT")) { socket.write("221 Bye\r\n"); socket.end(); }
            else socket.write("250 OK\r\n");
          }
        });
      });
      await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
      const smtpPort = smtp.address().port;

      const warnings = [];
      console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      const setAll = async (map) => { for (const [k, v] of Object.entries(map)) await settings.setSetting(k, v); };
      await setAll({
        emailEnabled: "true", emailHost: "127.0.0.1", emailFrom: "panel@example.com",
        emailPort: String(smtpPort), emailSecurity: "none",
        telegramBotEnabled: "true", telegramBotToken: "1:token",
      });
      const marker = async (key) => (await query("SELECT value FROM system_settings WHERE key = ?", [key]))[0]?.value ?? null;
      const markerKeys = async (like) => (await query("SELECT key FROM system_settings WHERE key LIKE ? ORDER BY key", [like])).map((row) => String(row.key));

      ${body}

      smtp.close();
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "reminders.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        TELEGRAM_BOT_TOKEN: "",
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("收件人永久不可达：记标记、接着发后面的；单条坏消息：不记标记、接着发", () => {
  runInDatabase(String.raw`
    const { dispatchReminders } = await import(url("server/reminderDispatch.ts"));
    const { sendTelegramMessage } = await import(url("server/telegram/telegramBot.ts"));
    const delivered = await dispatchReminders([
      { key: "telegramReminder:t:1:blocked", send: () => sendTelegramMessage("blocked", "x") },
      { key: "telegramReminder:t:2:nochat", send: () => sendTelegramMessage("nochat", "x") },
      { key: "telegramReminder:t:3:badmsg", send: () => sendTelegramMessage("badmsg", "x") },
      { key: "telegramReminder:t:4:ok", send: () => sendTelegramMessage("ok", "x") },
    ]);
    assert.equal(delivered, 1, "排在不可达收件人后面的那一条必须照样发出去");
    assert.deepEqual(telegrams.map((item) => item.chatId), ["ok"]);
    assert.equal(await marker("telegramReminder:t:1:blocked"), "undeliverable", "拉黑了机器人的人：写标记，别每轮都拿他去撞");
    assert.equal(await marker("telegramReminder:t:2:nochat"), "undeliverable");
    assert.equal(await marker("telegramReminder:t:3:badmsg"), null, "消息本身的问题不写标记，下轮再试");
    assert.equal(await marker("telegramReminder:t:4:ok"), "sent");
  `);
});

test("通道故障（Telegram 5xx）仍然整轮停下，后面的不再挨个去撞", () => {
  runInDatabase(String.raw`
    const { dispatchReminders } = await import(url("server/reminderDispatch.ts"));
    const { sendTelegramMessage } = await import(url("server/telegram/telegramBot.ts"));
    await assert.rejects(dispatchReminders([
      { key: "telegramReminder:t:1:down", send: () => sendTelegramMessage("down", "x") },
      { key: "telegramReminder:t:2:ok", send: () => sendTelegramMessage("ok", "x") },
    ]), /Bad Gateway/);
    assert.equal(telegrams.length, 0);
    assert.equal(await marker("telegramReminder:t:1:down"), null);
  `);
});

test("SMTP：RCPT 被拒是收件人问题；MAIL FROM 被拒是整个通道的问题 —— 错误码要带出来", () => {
  runInDatabase(String.raw`
    const { dispatchReminders, classifyReminderFailure } = await import(url("server/reminderDispatch.ts"));
    const { sendMail } = await import(url("server/email.ts"));

    const rcptError = await sendMail({ to: "reject@example.com", subject: "s", text: "t" }).then(() => null, (error) => error);
    assert.ok(rcptError, "收件人被拒应当抛错");
    assert.equal(rcptError.responseCode, 550, "responseCode 要保留在抛出的错误上");
    assert.match(String(rcptError.command), /^RCPT/);
    assert.equal(classifyReminderFailure(rcptError), "recipient");

    const delivered = await dispatchReminders([
      { key: "emailReminder:t:1:reject", send: () => sendMail({ to: "reject@example.com", subject: "s", text: "t" }).then(() => undefined) },
      { key: "emailReminder:t:2:ok", send: () => sendMail({ to: "ok@example.com", subject: "s", text: "t" }).then(() => undefined) },
    ]);
    assert.equal(delivered, 1);
    assert.deepEqual(mails, ["ok@example.com"]);
    assert.equal(await marker("emailReminder:t:1:reject"), "undeliverable");

    await settings.setSetting("emailFrom", "badsender@example.com");
    const senderError = await sendMail({ to: "ok@example.com", subject: "s", text: "t" }).then(() => null, (error) => error);
    assert.ok(senderError);
    assert.equal(classifyReminderFailure(senderError), "transport", "发件人被拒对谁都一样，不能当成「这个人收不到」把提醒吞掉");
    await assert.rejects(dispatchReminders([
      { key: "emailReminder:t:3:any", send: () => sendMail({ to: "ok@example.com", subject: "s", text: "t" }).then(() => undefined) },
    ]));
    assert.equal(await marker("emailReminder:t:3:any"), null);
  `);
});

test("到期提醒同一档横跨两个 UTC 日历日也只发一次", () => {
  runInDatabase(String.raw`
    await setAll({ emailExpiryReminder: "true", telegramExpiryReminder: "true", expiryReminderDays: "2" });
    // 现在 2030-01-01 20:00Z，到期 2030-01-03 08:00Z：还剩 1.5 天 → daysLeft = 2。
    const expiresAt = Math.floor(RealDate.parse("2030-01-03T08:00:00Z") / 1000);
    await exec("INSERT INTO users (id, username, password, role, email, \"telegramId\", \"expiresAt\") VALUES (2, 'u2', 'h', 'user', 'u2@example.com', 'tg2', ?)", [expiresAt]);

    const sched = await import(url("server/scheduler.ts"));
    await sched.runEmailReminders();
    await sched.runTelegramReminders();
    assert.deepEqual(mails, ["u2@example.com"]);
    assert.equal(telegrams.length, 1);

    // 6 小时后：UTC 日期已经翻到 01-02，但还剩 1.25 天，仍是「2 天」这一档。
    setNow("2030-01-02T02:00:00Z");
    await sched.runEmailReminders();
    await sched.runTelegramReminders();
    assert.deepEqual(mails, ["u2@example.com"], "同一档不该因为跨了日历日再发一封");
    assert.equal(telegrams.length, 1, "Telegram 同理");
    assert.deepEqual(await markerKeys("%Reminder:expiry:%"), [
      "emailReminder:expiry:2:" + expiresAt + ":2",
      "telegramReminder:expiry:2:" + expiresAt + ":2",
    ]);

    // 续了一期（到期时间变了）：新周期的同一档要能再发。
    const renewed = Math.floor(RealDate.parse("2030-01-03T20:00:00Z") / 1000);
    await exec("UPDATE users SET \"expiresAt\" = ? WHERE id = 2", [renewed]);
    await sched.runEmailReminders();
    await sched.runTelegramReminders();
    assert.equal(mails.length, 2);
    assert.equal(telegrams.length, 2);

    // 不带日期的标记按写入时间清：7 天内的留着，过了就清。
    setNow("2030-01-05T12:00:00Z");
    assert.equal(await settings.pruneEphemeralSettings(7), 0);
    setNow("2030-01-10T12:00:00Z");
    assert.equal(await settings.pruneEphemeralSettings(7), 4);
    assert.deepEqual(await markerKeys("%Reminder:expiry:%"), []);
  `);
});

test("没开用户到期/流量提醒、也没有主机告警时，Telegram 照样发落地流量提醒", () => {
  runInDatabase(String.raw`
    await setAll({ telegramExpiryReminder: "false", telegramTrafficReminder: "false" });
    const GB = 1024 ** 3;
    const now = Math.floor(Date.now() / 1000);
    await exec("INSERT INTO users (id, username, password, role, \"telegramId\") VALUES (2, 'u2', 'h', 'user', 'tg2')");
    await exec(
      'INSERT INTO proxy_nodes (id, "userId", name, protocol, address, port, "trafficLimit", "trafficUsed", "createdAt", "updatedAt") VALUES (1, 2, ?, ?, ?, ?, ?, ?, ?, ?)',
      ["节点1", "vless", "10.9.1.1", 443, 100 * GB, 99 * GB, now, now],
    );
    const sched = await import(url("server/scheduler.ts"));
    await sched.runTelegramReminders();
    assert.equal(telegrams.length, 1, "落地节点跑到 99% 了，Telegram 必须提醒");
    assert.equal(telegrams[0].chatId, "tg2");
  `);
});
