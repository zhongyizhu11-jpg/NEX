import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isTelegramDigestEnabled, isTelegramNotifyMuted, parseTelegramNotifyPrefs } from "./telegramNotifyPrefs";

test("通知偏好：坏数据当没写过；没写过的人全收，简报管理员默认收、用户默认不收", () => {
  assert.deepEqual(parseTelegramNotifyPrefs("not json"), {});
  const prefs = parseTelegramNotifyPrefs(JSON.stringify({ 1: { muted: ["route", "bogus"] }, x: { muted: ["host"] }, 2: { digest: true } }));
  assert.deepEqual(prefs["1"].muted, ["route"]);
  assert.equal(prefs.x, undefined);
  assert.equal(isTelegramNotifyMuted(prefs, 1, "route"), true);
  assert.equal(isTelegramNotifyMuted(prefs, 1, "host"), false);
  assert.equal(isTelegramNotifyMuted(prefs, 3, "route"), false);
  assert.equal(isTelegramDigestEnabled(prefs, { id: 1, role: "admin" }), true);
  assert.equal(isTelegramDigestEnabled(prefs, { id: 3, role: "user" }), false);
  assert.equal(isTelegramDigestEnabled(prefs, { id: 2, role: "user" }), true);
});

/**
 * 菜单里的主机、线路组、通知、每日简报，在开发面板的种子数据上点一遍。
 * Telegram API 用假 fetch 接住，只看机器人发出去的文字和按钮。
 */
test("TG 菜单：主机、线路组改走路径、通知开关、每日简报", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-telegram-menu-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const out = [];
      globalThis.fetch = async (target, init) => {
        const method = String(target).split("/").pop();
        const body = JSON.parse(String(init?.body || "{}"));
        if (method === "sendMessage" || method === "editMessageText") out.push({ chatId: body.chat_id, text: body.text, kb: body.reply_markup });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      };
      console.info = () => {};
      console.log = () => {};
      console.warn = () => {};

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const dev = await import(url("server/devPanel.ts"));
      await dev.seedDevPanelData();
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      await settings.setSetting("telegramBotEnabled", "true");
      await settings.setSetting("telegramBotToken", "1:token");
      const db = await import(url("server/db.ts"));
      const admin = await db.getUserByUsername(dev.DEV_ADMIN_USERNAME);
      await runtime.executeRaw("UPDATE users SET telegramId = ? WHERE id = ?", ["100", admin.id]);
      const bot = await import(url("server/telegramBot.ts"));
      const prefs = await import(url("server/telegramNotifyPrefs.ts"));

      let updateId = 1;
      const tap = async (data) => {
        out.length = 0;
        await bot.processTelegramUpdate({ update_id: updateId++, callback_query: { id: "q", from: { id: 100 }, message: { message_id: 5, chat: { id: 100 } }, data } });
        const last = out[out.length - 1];
        assert.ok(last, "no reply for " + data);
        assert.doesNotMatch(last.text, /操作失败/, data);
        return { text: last.text, buttons: (last.kb?.inline_keyboard || []).flat() };
      };
      const button = (view, pattern) => view.buttons.find((item) => pattern.test(item.text));

      const menu = await tap("fx:menu");
      for (const label of [/主机/, /线路组/, /通知/]) assert.ok(button(menu, label), "menu lacks " + label);

      // 主机：掉线的排最前；详情里管理员能看到负载和升级按钮。
      const hosts = await tap("fx:hosts:0");
      assert.match(hosts.text, /在线 3 \/ 4 · 离线 1/);
      assert.ok(hosts.text.indexOf("🔴") < hosts.text.indexOf("🟢"));
      const detail = await tap("fx:host:2:0");
      assert.match(detail.text, /CPU\s+▰+▱* 72%/);
      assert.ok(button(detail, /升级这台/));
      const upgrade = await tap("fx:host:upgrade:2:0");
      assert.ok(upgrade.buttons.some((item) => /^fx:update:agent:confirm:/.test(item.callback_data || "")));

      // 规则详情多了测延迟和线路组。
      const rule = await tap("fx:rule:view:10:0");
      assert.ok(button(rule, /测延迟/));
      assert.ok(button(rule, /线路组/));

      // 线路组：改走 A 两小时，库里钉住；交回自动后清掉。
      const routes = await tap("fx:routes:0");
      assert.match(routes.text, /线路组<\/b> · 共 3 组/);
      const pick = await tap("fx:route:pick:10:0:0");
      assert.match(pick.text, /改走多久/);
      const pinned = await tap("fx:route:pin:10:0:1:0");
      assert.match(pinned.text, /已改走 A/);
      let stored = await db.getForwardRuleById(10);
      assert.equal(Number(stored.failoverPinnedIndex), 0);
      const pinnedUntil = new Date(stored.failoverPinnedUntil).getTime();
      assert.ok(Math.abs(pinnedUntil - (Date.now() + 7200_000)) < 120_000);
      assert.ok(button(pinned, /交回自动/));
      await tap("fx:route:auto:10:0");
      stored = await db.getForwardRuleById(10);
      assert.equal(stored.failoverPinnedIndex, null);

      // 通知：关掉线路切换只影响自己这一类。
      await tap("fx:notify:t:route");
      const recipients = [{ id: admin.id, telegramId: "100" }];
      assert.equal((await prefs.filterTelegramRecipients(recipients, "route")).length, 0);
      assert.equal((await prefs.filterTelegramRecipients(recipients, "host")).length, 1);
      const notify = await tap("fx:notify");
      assert.match(notify.text, /🔕 线路切换/);

      // 简报：北京时间 9 点后发一次，同一天不再发，9 点前不发。
      const digest = await tap("fx:digest");
      assert.match(digest.text, /每日简报/);
      assert.match(digest.text, /主机：在线 <b>3<\/b> \/ 4/);
      out.length = 0;
      assert.equal(await bot.runTelegramDigests(Date.parse("2026-10-10T02:00:00Z")), 1);
      assert.equal(out[0].chatId, "100");
      assert.equal(await bot.runTelegramDigests(Date.parse("2026-10-10T05:00:00Z")), 0);
      assert.equal(await bot.runTelegramDigests(Date.parse("2026-10-10T23:30:00Z")), 0);
      await tap("fx:notify:digest:0");
      assert.equal(await bot.runTelegramDigests(Date.parse("2026-10-11T02:00:00Z")), 0);
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_DEV_PANEL: "1",
        FORWARDX_TEST_DB: path.join(directory, "telegram-menu.db"),
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
