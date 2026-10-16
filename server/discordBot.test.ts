import assert from "node:assert/strict";
import test from "node:test";
import { DiscordApiError, DiscordRestClient, discordRetryAfterMs, isDiscordRecipientError, isDiscordUnauthorizedError } from "./discordBot";
import { createDiscordNotifier, DISCORD_DM_BLOCKED_RETRY_MS, DiscordRecipientUnavailableError, type DiscordNotifyRecipient } from "./discordNotify";
import { classifyReminderFailure } from "./reminderDispatch";
import type { TelegramNotifyPrefs } from "./telegramNotifyPrefs";

// 明显是假的 Token（拆开拼，不会被推送保护当成真的）
const BOT_TOKEN = ["fakebottoken" + "a".repeat(12), "fake00", "z".repeat(27)].join(".");

type Call = { method: string; url: string; headers: Record<string, string>; body: any };

function fakeDiscord(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: String(init?.method || "GET"), url, headers: (init?.headers || {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as any;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function okDiscord() {
  return fakeDiscord((call) => {
    if (call.url.endsWith("/users/@me/channels")) return json(200, { id: `9${call.body.recipient_id}`, type: 1 });
    if (/\/channels\/\d+\/messages$/.test(call.url)) return json(200, { id: "1111111111" });
    return json(404, { message: "Unknown", code: 0 });
  });
}

test("私信：先建私信频道（缓存），再发消息；不提醒任何人、不展开链接", async () => {
  const discord = okDiscord();
  const client = new DiscordRestClient({ token: BOT_TOKEN, fetchImpl: discord.fetchImpl });
  await client.sendDirectMessage("80351110224678912", "**hello** @everyone");
  await client.sendDirectMessage("80351110224678912", "second");
  await client.sendDirectMessage("175928847299117063", "other");
  const opens = discord.calls.filter((call) => call.url.endsWith("/users/@me/channels"));
  assert.equal(opens.length, 2, "同一个人的私信频道只建一次");
  assert.deepEqual(opens[0].body, { recipient_id: "80351110224678912" });
  assert.equal(opens[0].url, "https://discord.com/api/v10/users/@me/channels");
  const messages = discord.calls.filter((call) => call.url.endsWith("/messages"));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].url, "https://discord.com/api/v10/channels/980351110224678912/messages");
  assert.deepEqual(messages[0].body, { content: "**hello** @everyone", allowed_mentions: { parse: [] }, flags: 4 });
  assert.equal(messages[0].headers.Authorization, `Bot ${BOT_TOKEN}`);
  assert.match(messages[0].headers["User-Agent"], /^DiscordBot \(/);
  assert.equal(client.cachedChannelCount, 2);
});

test("429：按 retry_after 等一会儿再发；一直限流就放弃", async () => {
  const waits: number[] = [];
  let limited = 1;
  const discord = fakeDiscord((call) => {
    if (call.url.endsWith("/users/@me/channels")) return json(200, { id: "123456789" });
    if (limited-- > 0) return json(429, { message: "You are being rate limited.", retry_after: 0.75, global: false });
    return json(200, { id: "1" });
  });
  const client = new DiscordRestClient({ token: BOT_TOKEN, fetchImpl: discord.fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  await client.sendDirectMessage("80351110224678912", "hi");
  assert.deepEqual(waits, [750]);
  assert.equal(discord.calls.filter((call) => call.url.endsWith("/messages")).length, 2);

  const always = fakeDiscord((call) => (call.url.endsWith("/channels") ? json(200, { id: "123456789" }) : json(429, { message: "slow down", retry_after: 120 }, { "Retry-After": "120" })));
  const waits2: number[] = [];
  const stubborn = new DiscordRestClient({ token: BOT_TOKEN, fetchImpl: always.fetchImpl, sleep: async (ms) => { waits2.push(ms); } });
  await assert.rejects(stubborn.sendDirectMessage("80351110224678912", "hi"), (error: any) => error instanceof DiscordApiError && error.status === 429);
  assert.deepEqual(waits2, [30_000, 30_000], "最多等 30 秒、重试两次");
  assert.equal(discordRetryAfterMs(new Response(null, { headers: { "Retry-After": "2" } }), null), 2000);
});

test("403（对方关了私信）、401（Token 失效）按类型抛；缓存的频道失效会重建", async () => {
  const blocked = fakeDiscord((call) => (call.url.endsWith("/channels") ? json(200, { id: "123456789" }) : json(403, { message: "Cannot send messages to this user", code: 50007 })));
  const client = new DiscordRestClient({ token: BOT_TOKEN, fetchImpl: blocked.fetchImpl });
  await assert.rejects(client.sendDirectMessage("80351110224678912", "hi"), (error: unknown) => {
    assert.ok(isDiscordRecipientError(error));
    assert.ok(!isDiscordUnauthorizedError(error));
    assert.ok(!String((error as Error).message).includes(BOT_TOKEN), "错误信息里不带 Token");
    return true;
  });

  const unauthorized = fakeDiscord(() => json(401, { message: "401: Unauthorized", code: 0 }));
  await assert.rejects(new DiscordRestClient({ token: BOT_TOKEN, fetchImpl: unauthorized.fetchImpl }).sendDirectMessage("80351110224678912", "hi"), (error: unknown) => isDiscordUnauthorizedError(error));

  let opened = 0;
  const stale = fakeDiscord((call) => {
    if (call.url.endsWith("/channels")) return json(200, { id: opened++ === 0 ? "111111111" : "222222222" });
    if (call.url.includes("/111111111/")) return json(404, { message: "Unknown Channel", code: 10003 });
    return json(200, { id: "1" });
  });
  const reopening = new DiscordRestClient({ token: BOT_TOKEN, fetchImpl: stale.fetchImpl });
  await reopening.sendDirectMessage("80351110224678912", "hi");
  assert.equal(opened, 2, "频道没了就重新建一次");
});

function fakeNotifier(options: {
  admins?: DiscordNotifyRecipient[];
  prefs?: TelegramNotifyPrefs;
  settings?: Record<string, string>;
  send?: (discordId: string, content: string) => Promise<unknown>;
}) {
  let now = 1_800_000_000_000;
  const sent: Array<{ discordId: string; content: string }> = [];
  const blockedUpdates: Array<{ userId: number; at: Date | null }> = [];
  const disabled: string[] = [];
  const logs: string[] = [];
  const settings = { discordBotEnabled: "true", discordBotToken: BOT_TOKEN, ...(options.settings || {}) };
  const notifier = createDiscordNotifier({
    readSettings: async () => settings,
    getAdminRecipients: async () => options.admins || [],
    readPrefs: async () => options.prefs || {},
    setDmBlockedAt: async (userId, at) => {
      blockedUpdates.push({ userId, at });
      const admin = (options.admins || []).find((item) => Number(item.id) === userId);
      if (admin) admin.discordDmBlockedAt = at;
    },
    disableBot: async (reason) => {
      disabled.push(reason);
      settings.discordBotEnabled = "false";
    },
    client: () => ({
      sendDirectMessage: async (discordId: string, content: string) => {
        if (options.send) await options.send(discordId, content);
        sent.push({ discordId, content });
        return { id: "1" };
      },
    }),
    now: () => now,
    log: (_level, message) => logs.push(message),
  });
  return { notifier, sent, blockedUpdates, disabled, logs, advance: (ms: number) => { now += ms; }, settings };
}

test("管理员通知：发给绑定了 Discord 的管理员，按各人的类别开关过滤，可以排除自己", async () => {
  const admins: DiscordNotifyRecipient[] = [
    { id: 1, discordId: "100000000000000001" },
    { id: 2, discordId: "100000000000000002" },
    { id: 3, discordId: null },
    { id: 4, discordId: "100000000000000004" },
    { id: 5, discordId: "100000000000000005", accountEnabled: false },
  ];
  const fake = fakeNotifier({ admins, prefs: { "4": { muted: ["route"] } } });
  const counts = await fake.notifier.notifyAdmins("<b>线路切换</b>：A → B", { category: "route", label: "test" });
  assert.deepEqual(fake.sent.map((item) => item.discordId), ["100000000000000001", "100000000000000002"]);
  assert.equal(fake.sent[0].content, "**线路切换**：A → B", "Telegram HTML 转成 Discord 文字");
  assert.equal(counts.sent, 2);
  assert.equal(counts.muted, 1, "关了「线路切换」的管理员不收");

  // 同一个管理员关的是 route，主机类照收
  fake.sent.length = 0;
  await fake.notifier.notifyAdmins("主机离线", { category: "host", label: "test" });
  assert.deepEqual(fake.sent.map((item) => item.discordId), ["100000000000000001", "100000000000000002", "100000000000000004"]);

  // 工单：提交工单的管理员自己不收
  fake.sent.length = 0;
  await fake.notifier.notifyAdmins("新工单", { category: "ticket", excludeUserId: 2, label: "ticket" });
  assert.deepEqual(fake.sent.map((item) => item.discordId), ["100000000000000001", "100000000000000004"]);

  // 机器人没开：什么也不发
  const off = fakeNotifier({ admins, settings: { discordBotEnabled: "false" } });
  await off.notifier.notifyAdmins("x", { category: "host", label: "off" });
  assert.equal(off.sent.length, 0);
  assert.equal(await off.notifier.isReady(), false);
});

test("403：记下拒收时间、跳过这个人（别人照发），6 小时后再试，发通了清掉标记", async () => {
  const admins: DiscordNotifyRecipient[] = [
    { id: 1, discordId: "100000000000000001" },
    { id: 2, discordId: "100000000000000002" },
  ];
  let closed = true;
  const fake = fakeNotifier({
    admins,
    send: async (discordId) => {
      if (discordId === "100000000000000001" && closed) throw new DiscordApiError("channels/{id}/messages", 403, 50007, "Cannot send messages to this user");
    },
  });
  let counts = await fake.notifier.notifyAdmins("a", { category: "host", label: "t" });
  assert.equal(counts.blocked, 1);
  assert.equal(counts.sent, 1);
  assert.deepEqual(fake.sent.map((item) => item.discordId), ["100000000000000002"]);
  assert.equal(fake.blockedUpdates[0].userId, 1);
  assert.ok(fake.blockedUpdates[0].at instanceof Date);
  assert.match(fake.logs.join("\n"), /关了私信/);

  // 冷却期内：不再对他试
  counts = await fake.notifier.notifyAdmins("b", { category: "host", label: "t" });
  assert.equal(counts.skipped, 1);
  assert.equal(fake.sent.filter((item) => item.discordId === "100000000000000001").length, 0);

  // 6 小时后他改好了隐私设置：发通，标记清掉
  closed = false;
  fake.advance(DISCORD_DM_BLOCKED_RETRY_MS + 1);
  counts = await fake.notifier.notifyAdmins("c", { category: "host", label: "t" });
  assert.equal(counts.sent, 2);
  assert.deepEqual(fake.blockedUpdates.at(-1), { userId: 1, at: null });

  // 管理员测试按钮：force 不管冷却期
  const forced = fakeNotifier({ admins: [] });
  const result = await forced.notifier.deliver({ id: 9, discordId: "100000000000000009", discordDmBlockedAt: new Date(1_800_000_000_000) }, "test", { force: true });
  assert.equal(result.status, "sent");
});

test("401：自动关掉 Discord 通知，后面的人不再试", async () => {
  const admins: DiscordNotifyRecipient[] = [
    { id: 1, discordId: "100000000000000001" },
    { id: 2, discordId: "100000000000000002" },
  ];
  let attempts = 0;
  const fake = fakeNotifier({
    admins,
    send: async () => {
      attempts += 1;
      throw new DiscordApiError("channels/{id}/messages", 401, 0, "401: Unauthorized");
    },
  });
  await fake.notifier.notifyAdmins("x", { category: "host", label: "t" });
  assert.equal(attempts, 1);
  assert.equal(fake.disabled.length, 1);
  assert.match(fake.disabled[0], /401/);
  assert.equal(await fake.notifier.isReady(), false, "已经关掉");
  await fake.notifier.notifyAdmins("y", { category: "host", label: "t" });
  assert.equal(attempts, 1);
});

test("发给单个用户（工单回复）也看「工单消息」开关", async () => {
  const fake = fakeNotifier({ prefs: { "7": { muted: ["ticket"] } } });
  await fake.notifier.notifyUser({ id: 7, discordId: "100000000000000007" }, "回复", { category: "ticket", label: "t" });
  assert.equal(fake.sent.length, 0);
  await fake.notifier.notifyUser({ id: 8, discordId: "100000000000000008" }, "回复", { category: "ticket", label: "t" });
  assert.equal(fake.sent.length, 1);
  await fake.notifier.notifyUser({ id: 9, discordId: null }, "回复", { category: "ticket", label: "t" });
  assert.equal(fake.sent.length, 1);
});

test("提醒：收不到的人按「收件人问题」处理（写标记接着发），通道故障整轮停", async () => {
  const fake = fakeNotifier({
    send: async (discordId) => {
      if (discordId.endsWith("1")) throw new DiscordApiError("channels/{id}/messages", 403, 50007, "Cannot send messages to this user");
      if (discordId.endsWith("2")) throw new DiscordApiError("channels/{id}/messages", 503, null, "upstream");
    },
  });
  await assert.rejects(fake.notifier.sendReminder({ id: 1, discordId: "100000000000000001" }, "x", "expiry"), (error: unknown) => {
    assert.ok(error instanceof DiscordRecipientUnavailableError);
    assert.equal(classifyReminderFailure(error), "recipient");
    return true;
  });
  await assert.rejects(fake.notifier.sendReminder({ id: 2, discordId: "100000000000000002" }, "x", "expiry"), (error: unknown) => {
    assert.equal(classifyReminderFailure(error), "transport");
    return true;
  });
  await fake.notifier.sendReminder({ id: 3, discordId: "100000000000000003" }, "<b>NEX 到期提醒</b>", "expiry");
  assert.equal(fake.sent.at(-1)?.content, "**NEX 到期提醒**");
  assert.equal(classifyReminderFailure(new DiscordApiError("r", 403, 50007, "x")), "recipient");
  assert.equal(classifyReminderFailure(new DiscordApiError("r", 400, 50035, "Invalid Form Body")), "item");
});
