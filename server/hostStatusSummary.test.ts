import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 一轮巡检扫出一大批主机同时掉线（机房断电、上游抖动），原来是每台主机给每个管理员
 * 各发一条 Telegram：一百台就是每人一百条，很快被 Telegram 429，后面要紧的消息全丢。
 * 超过阈值就合成一条汇总；少量掉线还是一台一条，信息更完整。
 */
function runSweep(staleHosts: number) {
  const result = runInDatabase(String.raw`
      const messages = [];
      globalThis.fetch = async (_target, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        messages.push({ chatId: String(body.chat_id), text: String(body.text || "") });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: messages.length } }) };
      };
      console.info = () => {};
      console.warn = () => {};

      const settings = await import(url("server/repositories/settingsRepository.ts"));
      for (const [key, value] of Object.entries({ telegramBotEnabled: "true", telegramBotToken: "1:token", telegramHostStatusNotify: "true" })) {
        await settings.setSetting(key, value);
      }
      await exec('INSERT INTO users (id, username, password, role, "telegramId") VALUES (1, ?, ?, ?, ?)', ["admin1", "h", "admin", "tg-admin-1"]);
      await exec('INSERT INTO users (id, username, password, role, "telegramId") VALUES (2, ?, ?, ?, ?)', ["admin2", "h", "admin", "tg-admin-2"]);
      const now = Math.floor(Date.now() / 1000);
      const total = 40;
      for (let id = 1; id <= total; id += 1) {
        await exec(
          'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)',
          [id, "机器" + id, "10.8.0." + id, "10.8.0." + id, "slave", "tk" + id, now],
        );
      }

      const notifier = await import(url("server/hostStatusNotifier.ts"));
      await notifier.primeHostStatusNotifier();
      const stale = Number(process.env.STALE_HOSTS);
      await exec('UPDATE hosts SET "lastHeartbeat" = ? WHERE id <= ?', [now - 3600, stale]);
      const transitioned = await notifier.sweepOfflineHostsAndNotify();
      assert.equal(transitioned, stale);
      console.log("SWEEP " + JSON.stringify({ messages, threshold: notifier.HOST_STATUS_SUMMARY_THRESHOLD }));
  `, { name: "host-summary", env: { TELEGRAM_BOT_TOKEN: "", STALE_HOSTS: String(staleHosts) } });
  const line = result.stdout.split("\n").find((row) => row.startsWith("SWEEP "));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice("SWEEP ".length)) as { messages: Array<{ chatId: string; text: string }>; threshold: number };
}

test("大批主机同时掉线：每个管理员只收一条汇总，列出主机名并报总数", () => {
  const { messages } = runSweep(35);
  assert.equal(messages.length, 2, `两个管理员各一条，实际 ${messages.length} 条`);
  assert.deepEqual(messages.map((message) => message.chatId).sort(), ["tg-admin-1", "tg-admin-2"]);
  const text = messages[0].text;
  assert.match(text, /<b>35<\/b> 台主机/);
  assert.match(text, /机器1 \(#1\)/);
  assert.match(text, /另外 5 台/, "最多列 30 台，其余报数量");
});

test("少量主机掉线：仍然一台一条", () => {
  const { messages, threshold } = runSweep(3);
  assert.ok(3 <= threshold);
  assert.equal(messages.length, 6, "3 台 × 2 个管理员");
  assert.ok(messages.every((message) => /主机离线告警/.test(message.text)));
});
