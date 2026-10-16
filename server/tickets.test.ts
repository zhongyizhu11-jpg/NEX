import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeTicketContent,
  normalizeTicketTitle,
  TICKET_CONTENT_MAX_LENGTH,
  TICKET_TITLE_MAX_LENGTH,
} from "../shared/tickets";
import { webhookCategoryOf } from "../shared/opsWebhook";
import { MIGRATION_TABLES } from "./dbSchema";

function runScript(prefix: string, script: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    const scriptPath = path.join(directory, "probe.mjs");
    fs.writeFileSync(scriptPath, script, "utf8");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "t.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/*
  公共前奏：建库、三个用户（管理员 1、用户 A=2、用户 B=3）、假的 Telegram API（记下发出去的消息）。
  sent 里是 { chatId, text }。
*/
const prelude = String.raw`
  import assert from "node:assert/strict";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  const sent = [];
  globalThis.fetch = async (target, init) => {
    const method = String(target).split("/").pop();
    const body = JSON.parse(String(init?.body || "{}"));
    if (method === "sendMessage") sent.push({ chatId: String(body.chat_id), text: body.text });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  console.info = () => {};
  console.log = () => {};
  const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(moduleUrl("server/dbRuntime.ts"));
  const schema = await import(moduleUrl("server/dbSchema.ts"));
  const q = (name) => '"' + name + '"';
  const insert = (table, columns, values) => runtime.executeRaw(
    "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
    values,
  );
  const context = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
  await schema.ensureDatabaseSchema();
  await insert("users", ["id", "username", "password", "role", "accountEnabled", "telegramId"], [1, "admin", "x", "admin", 1, "9001"]);
  await insert("users", ["id", "username", "password", "role", "accountEnabled", "telegramId"], [2, "alice", "x", "user", 1, "9002"]);
  await insert("users", ["id", "username", "password", "role", "accountEnabled"], [3, "bob", "x", "user", 1]);
  const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
  const alice = { id: 2, username: "alice", role: "user", accountEnabled: true };
  const bob = { id: 3, username: "bob", role: "user", accountEnabled: true };
  const { ticketsRouter } = await import(moduleUrl("server/routers/tickets.ts"));
  const notifier = await import(moduleUrl("server/ticketNotifier.ts"));
  const rateLimit = await import(moduleUrl("server/ticketRateLimit.ts"));
  const asAdmin = ticketsRouter.createCaller(context(admin));
  const asAlice = ticketsRouter.createCaller(context(alice));
  const asBob = ticketsRouter.createCaller(context(bob));
  const statusOf = async (id) => (await runtime.queryRaw('SELECT "status" FROM "tickets" WHERE "id" = ?', [id]))[0].status;
`;

test("标题、正文的校验：去首尾空白、单行、长度、NUL", () => {
  assert.deepEqual(normalizeTicketTitle("  连不上  "), { ok: true, value: "连不上" });
  assert.equal(normalizeTicketTitle("   ").ok, false);
  assert.equal(normalizeTicketTitle("第一行\n第二行").ok, false);
  assert.equal(normalizeTicketTitle("a\rb").ok, false);
  assert.equal(normalizeTicketTitle("a\u2028b").ok, false);
  assert.equal(normalizeTicketTitle("a\0b").ok, false);
  assert.equal(normalizeTicketTitle("x".repeat(TICKET_TITLE_MAX_LENGTH)).ok, true);
  assert.equal(normalizeTicketTitle("x".repeat(TICKET_TITLE_MAX_LENGTH + 1)).ok, false);

  assert.deepEqual(normalizeTicketContent("\n 第一行\r\n第二行 \n"), { ok: true, value: "第一行\n第二行" });
  assert.equal(normalizeTicketContent(" \n ").ok, false);
  assert.equal(normalizeTicketContent("a\0b").ok, false);
  assert.equal(normalizeTicketContent("x".repeat(TICKET_CONTENT_MAX_LENGTH)).ok, true);
  assert.equal(normalizeTicketContent("x".repeat(TICKET_CONTENT_MAX_LENGTH + 1)).ok, false);
});

test("工单事件归到 Webhook 的「工单」分类；工单表跟着面板迁移 / 备份走", () => {
  assert.equal(webhookCategoryOf("ticket.created"), "ticket");
  assert.equal(webhookCategoryOf("ticket.replied"), "ticket");
  const tables = MIGRATION_TABLES as readonly string[];
  assert.ok(tables.includes("tickets"));
  assert.ok(tables.includes("ticket_messages"));
  assert.ok(tables.indexOf("users") < tables.indexOf("tickets") && tables.indexOf("tickets") < tables.indexOf("ticket_messages"));
});

test("状态流转、关闭后不能回复、通知和面板事件", () => {
  runScript("forwardx-tickets-flow-", prelude + String.raw`
    const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
    await settings.setSetting("telegramBotEnabled", "true");
    await settings.setSetting("telegramBotToken", "1:token");
    try {
      // 新建 → 待处理；管理员收到 Telegram，标题里的 HTML 被转义
      const created = await asAlice.create({ title: "  <b>连不上</b> 香港入口  ", priority: "high", content: "从昨晚开始 & 一直超时" });
      assert.equal(created.status, "waiting_staff");
      assert.equal(created.title, "<b>连不上</b> 香港入口");
      assert.equal(created.priority, "high");
      await notifier.flushTicketNotifications();
      const adminMessages = sent.filter((item) => item.chatId === "9001");
      assert.equal(adminMessages.length, 1);
      assert.match(adminMessages[0].text, /新工单/);
      assert.match(adminMessages[0].text, /&lt;b&gt;连不上&lt;\/b&gt;/);
      assert.match(adminMessages[0].text, /从昨晚开始 &amp; 一直超时/);
      assert.equal(sent.some((item) => item.chatId === "9002"), false, "提单的人自己不收");

      // 管理员回复 → 已回复；工单主人收到 Telegram
      sent.length = 0;
      const afterStaff = await asAdmin.adminReply({ ticketId: created.id, content: "已经在查了" });
      assert.equal(afterStaff.status, "waiting_user");
      assert.equal(await statusOf(created.id), "waiting_user");
      await notifier.flushTicketNotifications();
      assert.equal(sent.filter((item) => item.chatId === "9002").length, 1);
      assert.match(sent.find((item) => item.chatId === "9002").text, /你的工单有新回复/);
      assert.equal(sent.some((item) => item.chatId === "9001"), false, "管理员自己的回复不发给管理员");

      // 用户回复 → 待处理
      sent.length = 0;
      const afterUser = await asAlice.reply({ ticketId: created.id, content: "好的，谢谢" });
      assert.equal(afterUser.status, "waiting_staff");
      await notifier.flushTicketNotifications();
      assert.equal(sent.filter((item) => item.chatId === "9001").length, 1);

      // 用户看到的线程：从旧到新，管理员显示成「客服」
      const thread = await asAlice.get({ ticketId: created.id });
      assert.deepEqual(thread.messages.map((m) => [m.senderName, m.content]), [
        ["我", "从昨晚开始 & 一直超时"],
        ["客服", "已经在查了"],
        ["我", "好的，谢谢"],
      ]);
      assert.equal(thread.messages[1].senderId, undefined, "用户看不到是哪个管理员回的");
      assert.equal(thread.hasMore, false);
      const adminThread = await asAdmin.adminGet({ ticketId: created.id });
      assert.equal(adminThread.messages[1].senderName, "admin");
      assert.equal(adminThread.ticket.username, "alice");

      // 关闭：两边都不能再回复，报中文原因；重新打开回到待处理
      const closed = await asAlice.setStatus({ ticketId: created.id, status: "closed" });
      assert.equal(closed.status, "closed");
      assert.ok(closed.closedAt);
      await assert.rejects(() => asAlice.reply({ ticketId: created.id, content: "还在吗" }), /工单已关闭，请先重新打开/);
      await assert.rejects(() => asAdmin.adminReply({ ticketId: created.id, content: "在" }), /工单已关闭，请先重新打开/);
      const reopened = await asAlice.setStatus({ ticketId: created.id, status: "open" });
      assert.equal(reopened.status, "waiting_staff");
      assert.equal(reopened.closedAt, null);

      // 管理员关闭、重新打开
      await asAdmin.adminReply({ ticketId: created.id, content: "修好了" });
      assert.equal(await statusOf(created.id), "waiting_user");
      assert.equal((await asAdmin.adminSetStatus({ ticketId: created.id, status: "closed" })).status, "closed");
      assert.equal((await asAdmin.adminSetStatus({ ticketId: created.id, status: "open" })).status, "waiting_staff");
      // 对没关的工单「打开」不改状态
      await asAdmin.adminReply({ ticketId: created.id, content: "再确认一下" });
      assert.equal((await asAlice.setStatus({ ticketId: created.id, status: "open" })).status, "waiting_user");

      // 用户在 Telegram 里关掉「工单消息」后，管理员回复不再推给他
      const prefs = await import(moduleUrl("server/telegramNotifyPrefs.ts"));
      await prefs.updateTelegramNotifyPref(2, { toggleCategory: "ticket" });
      sent.length = 0;
      await asAdmin.adminReply({ ticketId: created.id, content: "还有一件事" });
      await notifier.flushTicketNotifications();
      assert.equal(sent.some((item) => item.chatId === "9002"), false);

      // 邮件只发给验证过邮箱的人，面板没开邮件就不发
      const shouldEmail = notifier.shouldEmailTicketOwner;
      assert.equal(shouldEmail({ email: "a@example.com", emailVerified: true }, true), true);
      assert.equal(shouldEmail({ email: "a@example.com", emailVerified: 1 }, true), true);
      assert.equal(shouldEmail({ email: "a@example.com", emailVerified: false }, true), false);
      assert.equal(shouldEmail({ email: "", emailVerified: true }, true), false);
      assert.equal(shouldEmail({ email: "a@example.com", emailVerified: true }, false), false);
      assert.equal(shouldEmail(null, true), false);

      // 面板事件：新建一条、用户回复一条（管理员回复不记）
      const events = await runtime.queryRaw('SELECT "kind", "level", "userId", "message" FROM "panel_events" WHERE "kind" LIKE ? ORDER BY "id"', ["ticket.%"]);
      assert.deepEqual(events.map((e) => e.kind), ["ticket.created", "ticket.replied"]);
      assert.equal(events[0].level, "info");
      assert.equal(Number(events[0].userId), 2);
      assert.match(events[0].message, /alice 新建工单/);

      // 角标：只数待处理
      assert.equal((await asAdmin.adminCounts()).waitingStaff, 0);
      await asBob.create({ title: "问个问题", priority: "low", content: "怎么加规则" });
      assert.equal((await asAdmin.adminCounts()).waitingStaff, 1);
      await assert.rejects(() => asAlice.adminCounts(), (error) => error.code === "FORBIDDEN");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `);
});

test("用户只能看到自己的工单：别人的一律当作不存在", () => {
  runScript("forwardx-tickets-owner-", prelude + String.raw`
    try {
      const ticket = await asAlice.create({ title: "Alice 的工单", priority: "medium", content: "内容" });
      const expectNotFound = async (fn) => {
        await assert.rejects(fn, (error) => {
          assert.equal(error.code, "NOT_FOUND");
          assert.match(error.message, /工单不存在/);
          return true;
        });
      };
      await expectNotFound(() => asBob.get({ ticketId: ticket.id }));
      await expectNotFound(() => asBob.reply({ ticketId: ticket.id, content: "插一句" }));
      await expectNotFound(() => asBob.setStatus({ ticketId: ticket.id, status: "closed" }));
      await expectNotFound(() => asBob.get({ ticketId: 99999 }));
      assert.equal(await statusOf(ticket.id), "waiting_staff", "Bob 关不掉 Alice 的工单");
      const messages = await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "ticket_messages" WHERE "ticketId" = ?', [ticket.id]);
      assert.equal(Number(messages[0].count), 1, "Bob 的回复没有写进去");

      const bobList = await asBob.list();
      assert.equal(bobList.total, 0);
      assert.deepEqual(bobList.items, []);
      const aliceList = await asAlice.list();
      assert.equal(aliceList.total, 1);
      assert.equal(aliceList.items[0].id, ticket.id);
      assert.equal(aliceList.items[0].username, undefined, "用户列表不带用户名");

      // 管理员的接口普通用户调不了
      await assert.rejects(() => asBob.adminList(), (error) => error.code === "FORBIDDEN");
      await assert.rejects(() => asBob.adminGet({ ticketId: ticket.id }), (error) => error.code === "FORBIDDEN");
      await assert.rejects(() => asBob.adminReply({ ticketId: ticket.id, content: "x" }), (error) => error.code === "FORBIDDEN");

      // 状态筛选
      await asAlice.create({ title: "第二张", priority: "low", content: "内容" });
      await asAlice.setStatus({ ticketId: ticket.id, status: "closed" });
      assert.deepEqual((await asAlice.list({ status: "closed" })).items.map((t) => t.id), [ticket.id]);
      assert.equal((await asAlice.list({ status: "open" })).total, 1);
      assert.equal((await asAlice.list({ status: "waiting_user" })).total, 0);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `);
});

test("接口上的校验和频率限制", () => {
  runScript("forwardx-tickets-limits-", prelude + String.raw`
    try {
      await assert.rejects(() => asAlice.create({ title: "  ", priority: "low", content: "x" }), /请填写工单标题/);
      await assert.rejects(() => asAlice.create({ title: "一行\n两行", priority: "low", content: "x" }), /标题只能写一行/);
      await assert.rejects(() => asAlice.create({ title: "t".repeat(129), priority: "low", content: "x" }), /标题最多 128 个字/);
      await assert.rejects(() => asAlice.create({ title: "ok", priority: "low", content: "x".repeat(5001) }), /内容最多 5000 个字/);
      await assert.rejects(() => asAlice.create({ title: "ok", priority: "low", content: "a\0b" }), /无效字符/);
      await assert.rejects(() => asAlice.create({ title: "ok", priority: "urgent", content: "x" }));
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "tickets"'))[0].count, 0, "校验失败不建工单");

      // 每小时 5 张；校验失败的不算
      const ids = [];
      for (let i = 0; i < 5; i += 1) ids.push((await asAlice.create({ title: "工单 " + i, priority: "low", content: "x" })).id);
      await assert.rejects(() => asAlice.create({ title: "第六张", priority: "low", content: "x" }), (error) => {
        assert.equal(error.code, "TOO_MANY_REQUESTS");
        assert.match(error.message, /新建工单太频繁/);
        return true;
      });
      // 别人不受影响，管理员不受限
      await asBob.create({ title: "Bob", priority: "low", content: "x" });
      for (let i = 0; i < 7; i += 1) await asAdmin.create({ title: "管理员 " + i, priority: "low", content: "x" });

      // 每 10 分钟 30 条回复（所有工单合计）
      for (let i = 0; i < 30; i += 1) await asAlice.reply({ ticketId: ids[i % ids.length], content: "回复 " + i });
      await assert.rejects(() => asAlice.reply({ ticketId: ids[0], content: "第 31 条" }), /回复太频繁/);
      for (let i = 0; i < 35; i += 1) await asAdmin.adminReply({ ticketId: ids[0], content: "管理员 " + i });

      rateLimit.resetTicketRateLimits();
      await asAlice.reply({ ticketId: ids[0], content: "计数清零后可以了" });
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `);
});

test("管理员列表：待处理在前、优先级高在前、最近的在前；关键词、筛选和已删除用户", () => {
  runScript("forwardx-tickets-admin-list-", prelude + String.raw`
    try {
      const now = Math.floor(Date.now() / 1000);
      const columns = ["id", "userId", "title", "priority", "status", "lastMessageAt", "lastMessageByStaff", "createdAt", "updatedAt"];
      const row = (id, userId, title, priority, status, age) => insert("tickets", columns, [id, userId, title, priority, status, now - age, status === "waiting_user" ? 1 : 0, now - 1000, now - age]);
      await row(1, 2, "低优先级 新", "low", "waiting_staff", 10);
      await row(2, 2, "高优先级 旧", "high", "waiting_staff", 500);
      await row(3, 3, "高优先级 新", "high", "waiting_staff", 20);
      await row(4, 3, "中优先级", "medium", "waiting_staff", 30);
      await row(5, 2, "已回复 高", "high", "waiting_user", 1);
      await row(6, 3, "已回复 低", "low", "waiting_user", 2);
      await row(7, 2, "已关闭 高", "high", "closed", 0);
      await row(8, 42, "被删用户的工单", "medium", "closed", 50);
      await insert("ticket_messages", ["ticketId", "senderId", "isStaff", "content"], [8, 42, 0, "我的账号要被删了"]);
      await insert("ticket_messages", ["ticketId", "senderId", "isStaff", "content"], [8, 77, 1, "已删除的管理员回的"]);

      const list = await asAdmin.adminList();
      assert.deepEqual(list.items.map((t) => t.id), [3, 2, 4, 1, 5, 6, 7, 8]);
      assert.equal(list.total, 8);
      assert.equal(list.pageSize, 20);
      assert.equal(list.items[0].username, "bob");

      const deleted = list.items.find((t) => t.id === 8);
      assert.equal(deleted.username, "已删除用户");
      assert.equal(deleted.userDeleted, true);
      const thread = await asAdmin.adminGet({ ticketId: 8 });
      assert.deepEqual(thread.messages.map((m) => m.senderName), ["已删除用户", "已删除用户"]);

      assert.deepEqual((await asAdmin.adminList({ status: "waiting_user" })).items.map((t) => t.id), [5, 6]);
      assert.deepEqual((await asAdmin.adminList({ status: "open", priority: "high" })).items.map((t) => t.id), [3, 2, 5]);
      assert.deepEqual((await asAdmin.adminList({ keyword: "BOB" })).items.map((t) => t.id), [3, 4, 6], "按用户名，不分大小写");
      assert.deepEqual((await asAdmin.adminList({ keyword: "已回复" })).items.map((t) => t.id), [5, 6], "按标题");
      assert.deepEqual((await asAdmin.adminList({ keyword: "#7" })).items.map((t) => t.id), [7], "按编号");
      assert.equal((await asAdmin.adminList({ keyword: "%" })).total, 0, "通配符按字面匹配");

      // 分页：每页 20
      for (let i = 0; i < 25; i += 1) await row(100 + i, 2, "批量 " + i, "low", "closed", 1000 + i);
      const page1 = await asAdmin.adminList({ page: 1 });
      const page2 = await asAdmin.adminList({ page: 2 });
      assert.equal(page1.items.length, 20);
      assert.equal(page2.items.length, 13);
      assert.equal(page1.total, 33);

      // 消息分页：最新的一页从旧到新，beforeId 往前翻
      for (let i = 0; i < 130; i += 1) await insert("ticket_messages", ["ticketId", "senderId", "isStaff", "content"], [1, 2, 0, "m" + i]);
      const latest = await asAlice.get({ ticketId: 1 });
      assert.equal(latest.messages.length, 100);
      assert.equal(latest.hasMore, true);
      assert.equal(latest.messages[0].content, "m30");
      assert.equal(latest.messages[99].content, "m129");
      const older = await asAlice.get({ ticketId: 1, beforeId: latest.messages[0].id });
      assert.equal(older.messages.length, 30);
      assert.equal(older.hasMore, false);
      assert.equal(older.messages[0].content, "m0");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `);
});

test("面板备份导入：工单和消息跟着用户走，发消息的人已被删时留空", () => {
  runScript("forwardx-tickets-migration-", String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    console.info = () => {};
    console.warn = () => {};
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      const result = await migration.importMigrationSnapshot({
        version: 1,
        exportedAt: Date.now(),
        tables: {
          users: [{ id: 5, username: "carol", password: "x", role: "user" }],
          tickets: [{ id: 30, userId: 5, title: "迁移过来的工单", priority: "high", status: "waiting_user", lastMessageAt: now, lastMessageByStaff: 1, createdAt: now, updatedAt: now }],
          ticket_messages: [
            { id: 300, ticketId: 30, senderId: 5, isStaff: 0, content: "问题", createdAt: now },
            { id: 301, ticketId: 30, senderId: 88, isStaff: 1, content: "已经不在的管理员回的", createdAt: now },
          ],
        },
      });
      assert.equal(result.success, true, JSON.stringify(result));
      const tickets = await runtime.queryRaw('SELECT "id", "userId", "title", "status" FROM "tickets"');
      assert.equal(tickets.length, 1);
      const carol = (await runtime.queryRaw('SELECT "id" FROM "users" WHERE "username" = ?', ["carol"]))[0];
      assert.equal(Number(tickets[0].userId), Number(carol.id));
      assert.equal(tickets[0].status, "waiting_user");
      const messages = await runtime.queryRaw('SELECT "ticketId", "senderId", "content" FROM "ticket_messages" ORDER BY "id"');
      assert.deepEqual(messages.map((m) => [Number(m.ticketId), m.senderId === null ? null : Number(m.senderId), m.content]), [
        [Number(tickets[0].id), Number(carol.id), "问题"],
        [Number(tickets[0].id), null, "已经不在的管理员回的"],
      ]);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `);
});
