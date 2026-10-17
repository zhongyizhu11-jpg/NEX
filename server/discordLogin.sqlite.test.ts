import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  在真的 SQLite + 真的 Express 路由上把 Discord 登录走一遍（Discord 的 token / @me / revoke 端点和
  机器人 REST 接口用假的 fetch 顶替）：发起 → 回调 → 未绑定被拒（不按邮箱合并）→ 绑定 → 登录拿到会话 →
  别人抢绑被拒 → 停用账号被拒 → 2FA 账号先发挑战 → 允许注册时建新账号 → 域名限制 → 邮箱未验证 →
  state 重放 / 缺 cookie → 从别的域名进来先换到公开地址 → App 轮询 → 邀请注册 → 解绑规则 →
  机器人私信：管理员群发、类别开关、403 记拒收、401 自动关掉。
*/
test("Discord 登录和通知在 SQLite 上端到端跑通", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-discord-login-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import crypto from "node:crypto";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";
    import cookieParser from "cookie-parser";
    import jwt from "jsonwebtoken";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    let server;
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const db = await import(url("server/db.ts"));
      const password = await import(url("server/password.ts"));
      const repo = await import(url("server/repositories/discordAccountRepository.ts"));
      const loginSessions = await import(url("server/loginSessionService.ts"));
      const { discordAuthRouter, discordAppFlows, discordStartLimiter } = await import(url("server/discordAuthRoute.ts"));

      // ---- 仓库层：唯一约束、Discord 注册的账号没有可用密码 ----
      const aliceId = await db.registerUser({ username: "alice@example.com", password: "alice-pass", email: "alice@example.com" });
      const bobId = await db.registerUser({ username: "bob", password: "bob-pass", email: "bob@example.com" });
      const tmpId = await db.registerUser({ username: "tmp", password: "", unusablePassword: true, discordId: "900000000000000001", discordUsername: "tmp", discordEmail: "tmp@x.io" });
      const tmp = await db.getUserById(tmpId);
      assert.equal(password.hasUsablePassword(tmp.password), false);
      assert.equal(tmp.discordUsername, "tmp");
      assert.ok(tmp.discordLinkedAt);
      assert.equal((await repo.getUserByDiscordId("900000000000000001")).id, tmpId);
      await assert.rejects(repo.linkDiscordAccount(bobId, "900000000000000001", "x", "x@x.io"), /UNIQUE/i, "同一个 Discord ID 不能绑两个账号");
      assert.equal(await repo.unlinkDiscordAccount(tmpId), true);
      assert.equal(await repo.getUserByDiscordId("900000000000000001"), undefined);
      assert.equal(await repo.unlinkDiscordAccount(tmpId), false);

      // ---- 起一个只挂 Discord 路由的面板 ----
      const app = express();
      app.set("trust proxy", "loopback");
      app.use(express.urlencoded({ extended: true }));
      app.use(cookieParser());
      app.use(discordAuthRouter);
      server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      const base = "http://127.0.0.1:" + server.address().port;
      const CLIENT_ID = "123456789012345678";
      const CLIENT_SECRET = ["fake", "e2e", "secret"].join("_");
      await db.setSettings({
        panelPublicUrl: base,
        discordLoginEnabled: "true",
        discordClientId: CLIENT_ID,
        discordClientSecret: CLIENT_SECRET,
        discordAllowRegistration: "false",
        discordAllowedDomains: null,
      });

      // ---- 假的 Discord ----
      let identity = null;
      const tokenRequests = [];
      const revoked = [];
      const dms = [];
      let dmMode = "ok";
      const realFetch = globalThis.fetch;
      const accessTokenOf = (n) => ["fake", "access", String(n)].join("-");
      let issued = 0;
      globalThis.fetch = async (input, init) => {
        const target = String(input);
        if (target === "https://discord.com/api/oauth2/token") {
          const body = new URLSearchParams(String(init.body));
          tokenRequests.push(body);
          issued += 1;
          return new Response(JSON.stringify({ access_token: accessTokenOf(issued), token_type: "Bearer", scope: "identify email", expires_in: 604800 }), { status: 200 });
        }
        if (target === "https://discord.com/api/users/@me") {
          assert.equal(init.headers.Authorization, "Bearer " + accessTokenOf(issued));
          return new Response(JSON.stringify({ verified: true, global_name: null, ...identity }), { status: 200 });
        }
        if (target === "https://discord.com/api/oauth2/token/revoke") {
          revoked.push(new URLSearchParams(String(init.body)).get("token"));
          return new Response(null, { status: 200 });
        }
        if (target === "https://discord.com/api/v10/users/@me/channels") {
          const recipient = JSON.parse(String(init.body)).recipient_id;
          return new Response(JSON.stringify({ id: "7" + recipient }), { status: 200 });
        }
        if (/^https:\/\/discord\.com\/api\/v10\/channels\/\d+\/messages$/.test(target)) {
          if (dmMode === "closed") return new Response(JSON.stringify({ message: "Cannot send messages to this user", code: 50007 }), { status: 403 });
          if (dmMode === "unauthorized") return new Response(JSON.stringify({ message: "401: Unauthorized", code: 0 }), { status: 401 });
          dms.push({ channel: target.split("/").at(-2), body: JSON.parse(String(init.body)), auth: init.headers.Authorization });
          return new Response(JSON.stringify({ id: "1" }), { status: 200 });
        }
        return realFetch(input, init);
      };

      const cookieOf = (response, name) => {
        for (const line of response.headers.getSetCookie()) {
          if (line.startsWith(name + "=")) return line.split(";")[0].slice(name.length + 1);
        }
        return null;
      };
      const get = (pathname, cookies = {}) => realFetch(base + pathname, {
        redirect: "manual",
        headers: { cookie: Object.entries(cookies).filter(([, v]) => v).map(([k, v]) => k + "=" + v).join("; ") },
      });

      async function signIn({ mode = "login", redirect = "/rules", profile, session = null, flow = null, tamper = null, invite = null }) {
        const query = new URLSearchParams({ mode, redirect });
        if (flow) query.set("flow", flow);
        if (invite) query.set("invite", invite);
        const start = await get("/api/auth/discord/start?" + query, { app_session_id: session });
        assert.equal(start.status, 302, "start 应该跳去 Discord");
        const discord = new URL(start.headers.get("location"));
        assert.equal(discord.origin + discord.pathname, "https://discord.com/oauth2/authorize");
        assert.equal(discord.searchParams.get("redirect_uri"), base + "/api/auth/discord/callback");
        assert.equal(discord.searchParams.get("scope"), "identify email");
        assert.equal(discord.searchParams.get("prompt"), "consent");
        const binding = cookieOf(start, "nex_discord_oauth");
        assert.ok(binding, "种了浏览器绑定 cookie");
        assert.match(start.headers.getSetCookie().join("\n"), /nex_discord_oauth=[^;]+;.*Path=\/api\/auth\/discord.*HttpOnly/i);
        assert.match(start.headers.getSetCookie().join("\n"), /SameSite=Lax/i);
        identity = profile;
        const state = discord.searchParams.get("state");
        const before = tokenRequests.length;
        const callbackQuery = new URLSearchParams({ code: "code-" + Math.random(), state: tamper?.state ?? state });
        const response = await get("/api/auth/discord/callback?" + callbackQuery, {
          nex_discord_oauth: tamper && "binding" in tamper ? tamper.binding : binding,
          app_session_id: session,
        });
        if (tokenRequests.length > before) {
          const last = tokenRequests.at(-1);
          assert.equal(crypto.createHash("sha256").update(last.get("code_verifier")).digest("base64url"), discord.searchParams.get("code_challenge"), "PKCE verifier 对得上 challenge");
          assert.equal(last.get("client_secret"), CLIENT_SECRET, "client_secret_post");
          assert.equal(last.get("redirect_uri"), base + "/api/auth/discord/callback");
        }
        return { response, state, binding };
      }
      const locationOf = (response) => response.headers.get("location");

      const ALICE_DISCORD = { id: "80351110224678912", username: "alice_d", email: "alice@example.com" };

      // 1. 没绑定：即使邮箱和 alice 一模一样也不登录、不合并
      let result = await signIn({ profile: ALICE_DISCORD });
      assert.equal(locationOf(result.response), "/login?discordError=not_linked");
      assert.equal(cookieOf(result.response, "app_session_id"), null);
      assert.equal((await db.getUserById(aliceId)).discordId, null);
      assert.ok(revoked.includes(accessTokenOf(issued)), "拿到身份后吊销了 access_token");

      // 2. 同一个 state 再用一次 / 没有 cookie / cookie 不对
      const replay = await get("/api/auth/discord/callback?code=x&state=" + result.state, { nex_discord_oauth: result.binding });
      assert.equal(locationOf(replay), "/login?discordError=state_invalid");
      result = await signIn({ profile: ALICE_DISCORD, tamper: { binding: null } });
      assert.equal(locationOf(result.response), "/login?discordError=state_invalid");
      result = await signIn({ profile: ALICE_DISCORD, tamper: { binding: "z".repeat(43) } });
      assert.equal(locationOf(result.response), "/login?discordError=state_invalid");

      // 3. 绑定
      const sessionFor = async (userId) => {
        const sid = crypto.randomBytes(12).toString("hex");
        await loginSessions.createLoginAuthSession({ userId, sid, kind: "browser", expiresAt: new Date(Date.now() + 3600_000) });
        return jwt.sign({ userId, sid, kind: "browser" }, process.env.JWT_SECRET, { expiresIn: 3600 });
      };
      const aliceSession = await sessionFor(aliceId);
      assert.equal(locationOf(await get("/api/auth/discord/start?mode=link")), "/login?discordError=link_requires_login", "没登录不能发起绑定");
      result = await signIn({ mode: "link", redirect: "/profile", profile: ALICE_DISCORD, session: aliceSession });
      assert.equal(locationOf(result.response), "/profile?discordLinked=1");
      const linkedAlice = await db.getUserById(aliceId);
      assert.equal(linkedAlice.discordId, ALICE_DISCORD.id);
      assert.equal(linkedAlice.discordUsername, "alice_d");
      assert.equal(linkedAlice.discordEmail, "alice@example.com");

      // 4. 用 Discord 登录：拿到和密码登录一样的会话 cookie，跳回要去的页面
      result = await signIn({ profile: ALICE_DISCORD, redirect: "/rules?tab=mine" });
      assert.equal(locationOf(result.response), "/rules?tab=mine");
      const token = cookieOf(result.response, "app_session_id");
      assert.ok(token, "发了会话 cookie");
      assert.equal(jwt.verify(token, process.env.JWT_SECRET).userId, aliceId);
      result = await signIn({ profile: ALICE_DISCORD, redirect: "//evil.example.com/x" });
      assert.equal(locationOf(result.response), "/", "跳转目标被清洗");
      // 改了 Discord 用户名：认 ID 不认名字，显示用的名字跟着更新
      result = await signIn({ profile: { ...ALICE_DISCORD, username: "alice_renamed" } });
      assert.equal(locationOf(result.response), "/rules");
      assert.equal((await db.getUserById(aliceId)).discordUsername, "alice_renamed");

      // 5. bob 想把 alice 的 Discord 绑到自己身上：拒绝
      const bobSession = await sessionFor(bobId);
      result = await signIn({ mode: "link", profile: ALICE_DISCORD, session: bobSession });
      assert.equal(locationOf(result.response), "/profile?discordError=linked_elsewhere");
      assert.equal((await db.getUserById(bobId)).discordId, null);

      // 6. 停用的账号
      await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 0 WHERE "id" = ?', [aliceId]);
      result = await signIn({ profile: ALICE_DISCORD });
      assert.equal(locationOf(result.response), "/login?discordError=account_disabled");
      assert.equal(cookieOf(result.response, "app_session_id"), null);
      await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 1 WHERE "id" = ?', [aliceId]);

      // 7. 开了 2FA：不直接发会话，带着挑战回登录页（挑战放在 # 后面）
      await db.setSetting("twoFactorEnabled", "true");
      await runtime.executeRaw('UPDATE "users" SET "twoFactorEnabled" = 1, "twoFactorSecret" = ? WHERE "id" = ?', ["JBSWY3DPEHPK3PXP", aliceId]);
      result = await signIn({ profile: ALICE_DISCORD, redirect: "/hosts" });
      assert.match(locationOf(result.response), /^\/login#discordTwoFactor=[a-f0-9]{48}&u=alice%40example.com&exp=300&next=%2Fhosts$/);
      assert.equal(cookieOf(result.response, "app_session_id"), null, "2FA 之前没有会话");
      await runtime.executeRaw('UPDATE "users" SET "twoFactorEnabled" = 0, "twoFactorSecret" = NULL WHERE "id" = ?', [aliceId]);
      await db.setSetting("twoFactorEnabled", "false");

      // 8. 允许 Discord 注册：建新账号（用户名取 Discord 用户名，没有可用密码、邮箱已验证）
      await db.setSetting("discordAllowRegistration", "true");
      result = await signIn({ profile: { id: "175928847299117063", username: "bob", email: "bob@fresh.io" }, redirect: "/" });
      assert.equal(locationOf(result.response), "/");
      const created = await repo.getUserByDiscordId("175928847299117063");
      assert.equal(created.username, "bob2", "bob 被占了，取 bob2");
      assert.equal(created.email, "bob@fresh.io");
      assert.equal(!!created.emailVerified, true);
      assert.equal(password.hasUsablePassword(created.password), false);
      assert.equal(jwt.verify(cookieOf(result.response, "app_session_id"), process.env.JWT_SECRET).userId, created.id);
      result = await signIn({ profile: { id: "175928847299117064", username: "other", email: "BOB@example.com" } });
      assert.equal(locationOf(result.response), "/login?discordError=email_in_use", "已有账号的邮箱：不建、不合并");
      await db.setSetting("registrationEnabled", "false");
      result = await signIn({ profile: { id: "175928847299117065", username: "closed", email: "c@fresh.io" } });
      assert.equal(locationOf(result.response), "/login?discordError=registration_closed");
      await db.setSetting("registrationEnabled", "true");
      await db.setSetting("discordAllowedDomains", "corp.io");
      result = await signIn({ profile: { id: "175928847299117066", username: "dom", email: "d@fresh.io" } });
      assert.equal(locationOf(result.response), "/login?discordError=domain_not_allowed");
      await db.setSetting("discordAllowedDomains", null);
      await db.setSetting("discordAllowRegistration", "false");

      // 9. 邮箱没验证 / 没给邮箱权限 / ID 不对
      result = await signIn({ profile: { ...ALICE_DISCORD, verified: false } });
      assert.equal(locationOf(result.response), "/login?discordError=email_unverified");
      result = await signIn({ profile: { ...ALICE_DISCORD, email: null } });
      assert.equal(locationOf(result.response), "/login?discordError=email_unverified");
      result = await signIn({ profile: { ...ALICE_DISCORD, id: 80351110224678912 } });
      assert.equal(locationOf(result.response), "/login?discordError=profile_invalid");

      // 10. 用户在 Discord 那边点了取消
      const startCancel = await get("/api/auth/discord/start?mode=login");
      const cancelState = new URL(startCancel.headers.get("location")).searchParams.get("state");
      const cancelled = await get("/api/auth/discord/callback?error=access_denied&state=" + cancelState, { nex_discord_oauth: cookieOf(startCancel, "nex_discord_oauth") });
      assert.equal(locationOf(cancelled), "/login?discordError=cancelled");

      // 11. 从别的域名进来：先换到面板公开地址
      const viaOtherHost = await new Promise((resolve, reject) => {
        http.get(base + "/api/auth/discord/start?mode=login&redirect=%2Frules&invite=ABCD2345", { headers: { host: "10.0.0.5:9810" } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode, location: res.headers.location });
        }).on("error", reject);
      });
      assert.equal(viaOtherHost.status, 302);
      assert.equal(viaOtherHost.location, base + "/api/auth/discord/start?mode=login&redirect=%2Frules&invite=ABCD2345&canon=1");

      // 12. 关掉 / 面板地址改成 http 后，start 直接回登录页
      await db.setSetting("discordLoginEnabled", "false");
      assert.equal(locationOf(await get("/api/auth/discord/start")), "/login?discordError=disabled");
      await db.setSetting("discordLoginEnabled", "true");
      await db.setSetting("panelPublicUrl", "http://panel.example.com");
      assert.equal(locationOf(await get("/api/auth/discord/start")), "/login?discordError=not_configured", "http 面板地址按没配好处理");
      await db.setSetting("panelPublicUrl", base);

      // 13. 发起次数限流
      discordStartLimiter.clear();
      for (let i = 0; i < 20; i += 1) assert.equal((await get("/api/auth/discord/start")).status, 302);
      assert.equal(locationOf(await get("/api/auth/discord/start")), "/login?discordError=rate_limited");
      discordStartLimiter.clear();

      // 14. App：系统浏览器里完成，App 轮询拿结果；同一个 start 链接不能开第二次；IP 不同先确认
      const flow = discordAppFlows.create("127.0.0.1");
      result = await signIn({ mode: "app", profile: ALICE_DISCORD, flow: flow.flowId });
      assert.equal(result.response.status, 200);
      assert.match(await result.response.text(), /请回到 NEX App/);
      assert.equal(cookieOf(result.response, "app_session_id"), null, "浏览器里不发会话");
      assert.deepEqual(discordAppFlows.poll(flow.flowId, flow.pollToken), { status: "done", userId: aliceId });
      assert.equal((await get("/api/auth/discord/start?mode=app&flow=" + flow.flowId)).status, 400);
      const far = discordAppFlows.create("198.51.100.20");
      result = await signIn({ mode: "app", profile: ALICE_DISCORD, flow: far.flowId });
      const page = await result.response.text();
      assert.match(page, /确认登录到 NEX App/);
      assert.match(page, /198\.51\.100\.20/);
      assert.match(page, /action="\/api\/auth\/discord\/app-confirm"/);
      assert.deepEqual(discordAppFlows.poll(far.flowId, far.pollToken), { status: "pending" });
      const confirmId = page.match(/name="confirm" value="([^"]+)"/)[1];
      const confirmed = await realFetch(base + "/api/auth/discord/app-confirm", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ flow: far.flowId, confirm: confirmId }).toString(),
      });
      assert.equal(confirmed.status, 200);
      assert.deepEqual(discordAppFlows.poll(far.flowId, far.pollToken), { status: "done", userId: aliceId });
      const unlinkedFlow = discordAppFlows.create("127.0.0.1");
      result = await signIn({ mode: "app", profile: { id: "175928847299117070", username: "nobody", email: "n@x.io" }, flow: unlinkedFlow.flowId });
      assert.equal(result.response.status, 400);
      assert.deepEqual(discordAppFlows.poll(unlinkedFlow.flowId, unlinkedFlow.pollToken), { status: "failed", code: "not_linked" });

      // 15. 邀请注册：网页和 App 两条路都带邀请码；开了「必须邀请注册」时没码不建号
      await db.setSetting("discordAllowRegistration", "true");
      await db.setSetting("referralEnabled", "true");
      await db.setSetting("referralForceInvite", "true");
      await runtime.executeRaw('UPDATE "users" SET "inviteCode" = ? WHERE "id" = ?', ["ABCD2345", aliceId]);
      const inviterOf = async (id) => (await runtime.queryRaw('SELECT "inviterId" FROM "users" WHERE "discordId" = ?', [id]))[0]?.inviterId ?? null;
      result = await signIn({ profile: { id: "175928847299117080", username: "noinvite", email: "noinvite@example.com" } });
      assert.equal(locationOf(result.response), "/login?discordError=invite_required");
      const noInviteFlow = discordAppFlows.create("127.0.0.1");
      await signIn({ mode: "app", profile: { id: "175928847299117081", username: "appnoinvite", email: "appnoinvite@example.com" }, flow: noInviteFlow.flowId });
      assert.deepEqual(discordAppFlows.poll(noInviteFlow.flowId, noInviteFlow.pollToken), { status: "failed", code: "invite_required" });
      const inviteFlow = discordAppFlows.create("127.0.0.1");
      await signIn({ mode: "app", profile: { id: "175928847299117082", username: "appinvited", email: "appinvited@example.com" }, flow: inviteFlow.flowId, invite: "ABCD2345" });
      assert.equal(discordAppFlows.poll(inviteFlow.flowId, inviteFlow.pollToken).status, "done");
      assert.equal(Number(await inviterOf("175928847299117082")), aliceId);
      result = await signIn({ profile: { id: "175928847299117083", username: "webinvited", email: "webinvited@example.com" }, invite: "ABCD2345" });
      assert.equal(result.response.status, 302);
      assert.equal(Number(await inviterOf("175928847299117083")), aliceId);
      const { discordAuthRouter: discordTrpc } = await import(url("server/routers/discordAuth.ts"));
      const callerFor = (user) => discordTrpc.createCaller({ req: { headers: {}, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } }, res: { cookie() {}, clearCookie() {} }, user, authSession: null, authFailureReason: null });
      discordStartLimiter.clear();
      const appStarted = await callerFor(null).appStart({ inviteCode: "ABCD2345" });
      assert.equal(new URL(appStarted.startUrl).searchParams.get("invite"), "ABCD2345");
      assert.equal(new URL((await callerFor(null).appStart({ inviteCode: "bad code!" })).startUrl).searchParams.get("invite"), null);
      await db.setSetting("referralForceInvite", "false");
      await db.setSetting("referralEnabled", "false");
      await db.setSetting("discordAllowRegistration", "false");

      // 16. 解绑：Discord 注册、没有密码的账号不能解绑；有密码的可以
      const createdCaller = callerFor(await db.getUserById(created.id));
      await assert.rejects(createdCaller.unlink(), /先设置登录密码/);
      const status = await createdCaller.status();
      assert.equal(status.linked, true);
      assert.equal(status.canUnlink, false);
      assert.equal(status.username, "bob");
      await createdCaller.setInitialPassword({ newPassword: "brand-new-pass" });
      await callerFor(await db.getUserById(created.id)).unlink();
      assert.equal((await db.getUserById(created.id)).discordId, null);

      // 17. 机器人私信：管理员群发、类别开关（和 Telegram 共用）、403 记拒收、401 自动关掉
      const notify = await import(url("server/discordNotify.ts"));
      const BOT_TOKEN = ["fakebottoken" + "a".repeat(12), "fake00", "z".repeat(27)].join(".");
      await runtime.executeRaw('UPDATE "users" SET "role" = ? WHERE "id" = ?', ["admin", aliceId]);
      assert.equal(await notify.isDiscordBotReady(), false, "没开机器人");
      assert.equal(await notify.notifyDiscordAdmins("<b>x</b>", { category: "host", label: "off" }).then((r) => r.sent), 0);
      await db.setSettings({ discordBotEnabled: "true", discordBotToken: BOT_TOKEN });
      await notify.notifyDiscordAdmins("<b>🔴 主机离线</b>：东京", { category: "host", label: "e2e" });
      assert.equal(dms.length, 1);
      assert.equal(dms[0].channel, "7" + ALICE_DISCORD.id);
      assert.equal(dms[0].body.content, "**🔴 主机离线**：东京");
      assert.deepEqual(dms[0].body.allowed_mentions, { parse: [] });
      assert.equal(dms[0].auth, "Bot " + BOT_TOKEN);
      // alice 在个人资料里关掉「主机上下线」：Discord 不再发（Telegram 读的是同一份）
      const aliceCaller = callerFor(await db.getUserById(aliceId));
      const prefsBefore = await aliceCaller.notifyPrefs();
      assert.deepEqual(prefsBefore.categories.map((c) => c.key), ["host", "resource", "rule", "route", "ticket"]);
      await aliceCaller.setNotifyCategory({ category: "host", enabled: false });
      const tgPrefs = await import(url("server/telegramNotifyPrefs.ts"));
      assert.equal(tgPrefs.isTelegramNotifyMuted(await tgPrefs.readTelegramNotifyPrefs(), aliceId, "host"), true, "Telegram 那边也关了");
      await notify.notifyDiscordAdmins("主机离线", { category: "host", label: "e2e" });
      assert.equal(dms.length, 1);
      await notify.notifyDiscordAdmins("规则异常", { category: "rule", label: "e2e" });
      assert.equal(dms.length, 2);
      await aliceCaller.setNotifyCategory({ category: "host", enabled: true });
      // 普通用户不能开关管理员类别
      await assert.rejects(callerFor({ ...(await db.getUserById(bobId)), role: "user" }).setNotifyCategory({ category: "host", enabled: false }), /没有这一类通知/);
      // 管理员测试按钮
      assert.deepEqual(await aliceCaller.testBot(), { success: true });
      assert.equal(dms.length, 3);
      assert.match(dms[2].body.content, /NEX Discord 测试消息/);
      // 403：记下拒收时间，状态里给出提示
      dmMode = "closed";
      await notify.notifyDiscordAdmins("规则异常", { category: "rule", label: "e2e" });
      assert.ok((await db.getUserById(aliceId)).discordDmBlockedAt, "记下了拒收时间");
      const blockedStatus = await callerFor(await db.getUserById(aliceId)).status();
      assert.ok(blockedStatus.notifications.dmBlockedAt);
      await assert.rejects(callerFor(await db.getUserById(aliceId)).testBot(), /拒绝了这条私信/);
      dmMode = "ok";
      await callerFor(await db.getUserById(aliceId)).retryDm();
      assert.equal((await db.getUserById(aliceId)).discordDmBlockedAt, null, "发通后清掉标记");
      // 401：自动关掉 Discord 通知，写事件
      dmMode = "unauthorized";
      await notify.notifyDiscordAdmins("规则异常", { category: "rule", label: "e2e" });
      assert.equal(await db.getSetting("discordBotEnabled"), "false");
      dmMode = "ok";

      // 管理员设置：密钥打码；Token 校验失败（401）不存
      const adminCaller = callerFor({ ...(await db.getUserById(aliceId)), role: "admin" });
      const view = await adminCaller.adminSettings();
      assert.ok(!JSON.stringify(view).includes(CLIENT_SECRET));
      assert.ok(!JSON.stringify(view).includes(BOT_TOKEN));
      assert.equal(view.login.redirectUri, base + "/api/auth/discord/callback");

      // 日志 / 事件里不出现令牌
      const events = await runtime.queryRaw('SELECT "kind", "message", "dataJson" FROM "panel_events"');
      const kinds = events.map((row) => row.kind);
      assert.ok(kinds.includes("account.discord_linked"));
      assert.ok(kinds.includes("account.discord_registered"));
      assert.ok(kinds.includes("account.discord_unlinked"));
      assert.ok(kinds.includes("account.login"));
      assert.ok(kinds.includes("security.discord_bot_disabled"));
      const dump = JSON.stringify(events);
      assert.ok(!dump.includes("fake-access-"), "access_token 不落库");
      assert.ok(!dump.includes(BOT_TOKEN) && !dump.includes(CLIENT_SECRET));
      const settingsDump = JSON.stringify(await runtime.queryRaw('SELECT * FROM "users"'));
      assert.ok(!settingsDump.includes("fake-access-"), "用户表里没有 Discord 令牌");
      globalThis.fetch = realFetch;
    } finally {
      server?.close();
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_TYPE: "sqlite",
      SQLITE_PATH: databasePath,
      FORWARDX_TEST_DB: databasePath,
      JWT_SECRET: "e2e-discord-login-secret-0123456789abcdef0123456789abcdef",
    },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
