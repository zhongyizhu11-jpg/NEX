import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  在真的 SQLite 上走一遍登录页「忘记密码」和管理员「进入用户后台」（server/ops/passwordReset.ts、
  server/ops/impersonation.ts）。每个用例一个子进程、一个新库：两边都有模块级的限流计数和缓存，不互相串。
*/
function runScript(name: string, body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nex-${name}-`));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    try {
      ${body}
      console.log("OK");
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    encoding: "utf8",
    timeout: 180_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("找回密码：不暴露账号、链接只发到已验证的渠道、一次性、新的作废旧的、重置后踢掉所有登录但不动 2FA", () => {
  runScript("password-reset", String.raw`
    const users = await import(url("server/repositories/userRepository.ts"));
    const sessions = await import(url("server/repositories/sessionRepository.ts"));
    const settings = await import(url("server/repositories/settingsRepository.ts"));
    const password = await import(url("server/password.ts"));
    const pr = await import(url("server/ops/passwordReset.ts"));
    const { PASSWORD_RESET_REQUESTED_MESSAGE, PASSWORD_RESET_INVALID_MESSAGE } = await import(url("shared/passwordReset.ts"));

    const aliceId = await users.createUser({ username: "alice", password: "alice-old-pass", email: "alice@example.com", emailVerified: true });
    await runtime.executeRaw('UPDATE "users" SET "twoFactorEnabled" = 1, "twoFactorSecret" = ? WHERE "id" = ?', ["JBSWY3DPEHPK3PXP", aliceId]);
    const bobId = await users.createUser({ username: "bob", password: "bob-old-pass", email: "bob@example.com", emailVerified: false });
    const carolId = await users.createUser({ username: "carol", password: "carol-old-pass" });
    await runtime.executeRaw('UPDATE "users" SET "telegramId" = ? WHERE "id" = ?', ["123456789", carolId]);
    const daveId = await users.createUser({ username: "dave", password: "dave-old-pass", email: "dave@example.com", emailVerified: true });
    await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 0 WHERE "id" = ?', [daveId]);

    let clock = Date.now();
    const sent = [];
    const pending = [];
    const audits = [];
    const service = pr.createPasswordResetService({
      enabled: pr.isPasswordResetEnabled,
      findUser: users.getUserByUsername,
      getUser: users.getUserById,
      // 面板地址只来自设置（这里直接给）；请求里的 Host 根本没有机会参与。
      availability: async () => ({ email: true, telegram: true, discord: false, panelUrl: "https://panel.example.com/" }),
      send: async (user, channel, link) => { sent.push({ userId: user.id, channel, link }); return true; },
      hashPassword: password.hashPassword,
      afterReset: async () => {},
      audit: async (event) => { audits.push(event.kind + ":" + event.user.id + ":" + event.channels.join(",")); },
      schedule: (work) => { pending.push(work()); },
      now: () => clock,
      log: () => {},
    });
    const flush = async () => { await Promise.all(pending.splice(0)); };
    const from = (ip) => ({ ip, userAgent: "reset-test" });
    const tokenOf = (link) => decodeURIComponent(link.split("#password-reset=")[1]);

    // 1. 不存在 / 邮箱没验证 / 停用 / 正常：回的都是同一句话
    const responses = [
      await service.request("nobody@example.com", from("192.0.2.1")),
      await service.request("bob", from("192.0.2.2")),
      await service.request("dave", from("192.0.2.3")),
      await service.request("alice", from("192.0.2.4")),
      await service.request("carol", from("192.0.2.5")),
    ];
    for (const response of responses) assert.deepEqual(response, { success: true, message: PASSWORD_RESET_REQUESTED_MESSAGE });
    await flush();
    assert.deepEqual(sent.map((item) => item.userId + ":" + item.channel).sort(), [aliceId + ":email", carolId + ":telegram"].sort());
    assert.deepEqual(audits.sort(), ["requested:" + aliceId + ":email", "requested:" + carolId + ":telegram"].sort());
    const firstLink = sent.find((item) => item.userId === aliceId).link;
    assert.match(firstLink, /^https:\/\/panel\.example\.com\/login#password-reset=nxr_[A-Za-z0-9_-]{43}$/);
    const firstToken = tokenOf(firstLink);

    // 2. 库里只有哈希
    const rows = await runtime.queryRaw('SELECT * FROM "password_reset_tokens" WHERE "userId" = ?', [aliceId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokenHash, pr.hashPasswordResetToken(firstToken));
    assert.equal(JSON.stringify(rows).includes(firstToken), false);

    // 3. 一分钟内同一个账号再申请：照样回同一句话，但不再发
    await service.request("alice", from("192.0.2.6"));
    await flush();
    assert.equal(sent.filter((item) => item.userId === aliceId).length, 1);

    // 4. 过了冷却再申请：发新链接，旧链接作废
    clock += 61_000;
    await service.request("ALICE@example.com", from("192.0.2.7"));
    await flush();
    const aliceLinks = sent.filter((item) => item.userId === aliceId);
    assert.equal(aliceLinks.length, 2);
    const secondToken = tokenOf(aliceLinks[1].link);
    await assert.rejects(service.reset(firstToken, "brand-new-pass", from("192.0.2.8")), { message: PASSWORD_RESET_INVALID_MESSAGE });

    // 5. 新密码规则和别处一样
    await assert.rejects(service.reset(secondToken, "short", from("192.0.2.8")), (error) => error.code === "BAD_REQUEST" && /至少6个字符/.test(error.message));

    // 6. 重置：会话全撤、2FA 不动、新密码能登录、链接只能用一次
    await sessions.createAuthSession({ userId: aliceId, sid: "alice-browser", kind: "browser", expiresAt: new Date(Date.now() + 3_600_000) });
    await sessions.createAuthSession({ userId: aliceId, sid: "alice-mobile", kind: "mobile", expiresAt: new Date(Date.now() + 3_600_000) });
    assert.deepEqual(await service.reset(secondToken, "brand-new-pass", from("192.0.2.8")), { success: true });
    assert.equal(await sessions.getActiveAuthSession(aliceId, "alice-browser", "browser"), undefined);
    assert.equal(await sessions.getActiveAuthSession(aliceId, "alice-mobile", "mobile"), undefined);
    const alice = await users.getUserById(aliceId);
    assert.equal(alice.twoFactorEnabled, true);
    assert.equal(alice.twoFactorSecret, "JBSWY3DPEHPK3PXP");
    assert.ok(await users.authenticateUser("alice", "brand-new-pass"));
    assert.equal(await users.authenticateUser("alice", "alice-old-pass"), null);
    await assert.rejects(service.reset(secondToken, "another-new-pass", from("192.0.2.8")), { message: PASSWORD_RESET_INVALID_MESSAGE });
    assert.ok(audits.includes("completed:" + aliceId + ":email"));

    // 7. 过期
    clock += 61_000;
    await service.request("carol", from("192.0.2.9"));
    await flush();
    const carolToken = tokenOf(sent.filter((item) => item.userId === carolId).at(-1).link);
    clock += 31 * 60_000;
    await assert.rejects(service.reset(carolToken, "carol-new-pass", from("192.0.2.9")), { message: PASSWORD_RESET_INVALID_MESSAGE });

    // 8. 签发之后密码被别人改过（管理员重置）：旧链接作废
    clock = Date.now();
    const carolBefore = await users.getUserById(carolId);
    const staleToken = await pr.issuePasswordResetToken(carolBefore, { now: clock });
    await users.updateUserAccount(carolId, { password: "admin-set-pass" });
    await assert.rejects(service.reset(staleToken, "carol-new-pass", from("192.0.2.10")), { message: PASSWORD_RESET_INVALID_MESSAGE });

    // 9. 停用的账号拿着链接也重置不了
    const daveToken = await pr.issuePasswordResetToken(await users.getUserById(daveId), { now: clock });
    await assert.rejects(service.reset(daveToken, "dave-new-pass", from("192.0.2.11")), { message: PASSWORD_RESET_INVALID_MESSAGE });

    // 10. 同一条链接并发提交两次：只有一次成功
    const raceToken = await pr.issuePasswordResetToken(await users.getUserById(carolId), { now: clock });
    const raced = await Promise.allSettled([
      service.reset(raceToken, "race-pass-one", from("192.0.2.12")),
      service.reset(raceToken, "race-pass-two", from("192.0.2.13")),
    ]);
    assert.equal(raced.filter((item) => item.status === "fulfilled").length, 1);

    // 11. 按来源 IP 限流（明着拒，和账号无关）
    for (let index = 0; index < pr.PASSWORD_RESET_REQUEST_IP_MAX; index += 1) await service.request("nobody-" + index, from("198.51.100.77"));
    await assert.rejects(service.request("alice", from("198.51.100.77")), (error) => error.code === "TOO_MANY_REQUESTS");
    await flush();

    // 12. 管理员关掉功能
    await settings.setSetting("passwordResetEnabled", "false");
    assert.deepEqual(await service.options(), { enabled: false, available: false });
    await assert.rejects(service.request("alice", from("192.0.2.14")), (error) => error.code === "FORBIDDEN");
    await settings.setSetting("passwordResetEnabled", "true");
    assert.deepEqual(await service.options(), { enabled: true, available: true });

    // 13. 走真的 tRPC 路由：存在与否响应一样；重置后 API 令牌作废、cookie 清掉、审计和事件都有记录
    await settings.setSetting("authCaptchaEnabled", "false");
    const { authRouter } = await import(url("server/routers/auth.ts"));
    const cleared = [];
    const ctx = (ip) => ({
      req: { ip, socket: { remoteAddress: ip }, headers: { "user-agent": "reset-router" }, secure: false },
      res: { cookie() {}, clearCookie(name) { cleared.push(name); }, setHeader() {} },
      user: null, authSession: null, authFailureReason: null,
    });
    const unknown = await authRouter.createCaller(ctx("203.0.113.30")).requestPasswordReset({ identifier: "ghost" });
    const known = await authRouter.createCaller(ctx("203.0.113.31")).requestPasswordReset({ identifier: "bob" });
    assert.deepEqual(unknown, known);
    const tokens = await import(url("server/ops/apiTokens.ts"));
    await tokens.createUserApiToken({ userId: aliceId, name: "ci", scope: "read", expiresInDays: 30 });
    const routerToken = await pr.issuePasswordResetToken(await users.getUserById(aliceId));
    assert.deepEqual(await authRouter.createCaller(ctx("203.0.113.32")).resetPasswordWithToken({ token: routerToken, newPassword: "router-new-pass" }), { success: true });
    assert.deepEqual(cleared, ["app_session_id"]);
    assert.equal((await tokens.listUserApiTokens(aliceId)).length, 0);
    const auditRows = await runtime.queryRaw('SELECT * FROM "operation_audit_events" WHERE "path" = ?', ["auth.resetPasswordWithToken"]);
    assert.equal(auditRows.length, 1);
    assert.equal(Number(auditRows[0].actorUserId), aliceId);
    assert.equal(auditRows[0].ip, "203.0.113.32");
    assert.equal(JSON.stringify(auditRows).includes("router-new-pass"), false);
    const events = await runtime.queryRaw('SELECT * FROM "panel_events" WHERE "kind" = ?', ["account.password_reset"]);
    assert.equal(events.length, 1);
    assert.equal(Number(events[0].userId), aliceId);
  `);
});

test("进入用户后台：只给网页上的管理员、只能进普通用户、不碰 cookie、碰不到账号安全和管理员接口、随管理员登录一起失效", () => {
  runScript("impersonation", String.raw`
    const users = await import(url("server/repositories/userRepository.ts"));
    const sessions = await import(url("server/repositories/sessionRepository.ts"));
    const imp = await import(url("server/ops/impersonation.ts"));
    const audit = await import(url("server/operationAudit.ts"));
    const { appRouter } = await import(url("server/routers.ts"));
    const { createContext } = await import(url("server/_core/context.ts"));
    const { IMPERSONATION_BLOCKED_MESSAGE, IMPERSONATION_ENDED_MESSAGE } = await import(url("shared/userImpersonation.ts"));

    const adminId = await users.createUser({ username: "root", password: "root-pass-123", role: "admin" });
    const otherAdminId = await users.createUser({ username: "root2", password: "root-pass-456", role: "admin" });
    const aliceId = await users.createUser({ username: "alice", password: "alice-pass-123" });
    const disabledId = await users.createUser({ username: "gone", password: "gone-pass-123" });
    await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 0 WHERE "id" = ?', [disabledId]);
    await sessions.createAuthSession({ userId: adminId, sid: "admin-sid", kind: "browser", expiresAt: new Date(Date.now() + 3_600_000) });
    await sessions.createAuthSession({ userId: aliceId, sid: "alice-sid", kind: "browser", expiresAt: new Date(Date.now() + 3_600_000) });

    const admin = await users.getUserById(adminId);
    const req = (extra = {}) => ({ ip: "203.0.113.20", socket: { remoteAddress: "203.0.113.20" }, headers: { "user-agent": "imp-test" }, cookies: {}, originalUrl: "/api/trpc/x", ...extra });
    const res = () => { const out = { cookies: [], cleared: [], headers: {} }; out.cookie = (n) => { out.cookies.push(n); }; out.clearCookie = (n) => { out.cleared.push(n); }; out.setHeader = (k, v) => { out.headers[k] = v; }; return out; };
    const adminCtx = (extra = {}) => ({ req: req(), res: res(), user: admin, authSession: { kind: "browser", sid: "admin-sid", token: "x", legacy: false, source: "cookie" }, authFailureReason: null, ...extra });
    const asAdmin = appRouter.createCaller(adminCtx());

    // 1. 谁能进、能进谁
    await assert.rejects(asAdmin.users.enterUserBackend({ userId: otherAdminId }), (e) => e.code === "FORBIDDEN");
    await assert.rejects(asAdmin.users.enterUserBackend({ userId: adminId }), (e) => e.code === "FORBIDDEN");
    await assert.rejects(asAdmin.users.enterUserBackend({ userId: disabledId }), (e) => e.code === "FORBIDDEN");
    await assert.rejects(asAdmin.users.enterUserBackend({ userId: 99999 }), (e) => e.code === "FORBIDDEN");
    // API 令牌调不到（TOKEN_FORBIDDEN_PATHS），机器人这类没有会话的入口也发起不了
    await assert.rejects(appRouter.createCaller(adminCtx({ apiToken: { id: 1, scope: "full", name: "ci" } })).users.enterUserBackend({ userId: aliceId }), (e) => e.code === "FORBIDDEN");
    await assert.rejects(appRouter.createCaller(adminCtx({ authSession: null })).users.enterUserBackend({ userId: aliceId }), (e) => e.code === "FORBIDDEN");
    await assert.rejects(appRouter.createCaller(adminCtx({ user: await users.getUserById(aliceId) })).users.enterUserBackend({ userId: aliceId }), (e) => e.code === "FORBIDDEN");

    const started = await asAdmin.users.enterUserBackend({ userId: aliceId });
    assert.match(started.token, /^nxu_[A-Za-z0-9_-]{43}$/);
    assert.ok(started.expiresAt > Date.now() + 59 * 60_000 && started.expiresAt <= Date.now() + 3_600_000 + 1000);
    const stored = await runtime.queryRaw('SELECT * FROM "user_impersonations"', []);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].tokenHash, imp.hashImpersonationToken(started.token));
    assert.equal(JSON.stringify(stored).includes(started.token), false);

    // 2. 代入窗口的请求：认成 alice + 代入标记；就算浏览器带着管理员的 cookie 也不看它、不写不清
    const impRes = res();
    const ctx = await createContext({ req: req({ headers: { authorization: "Bearer " + started.token, "user-agent": "imp-test" }, cookies: { app_session_id: "admin-cookie" } }), res: impRes });
    assert.equal(ctx.user.id, aliceId);
    assert.equal(ctx.impersonation.adminUserId, adminId);
    assert.equal(ctx.authSession, null);
    const asAlice = appRouter.createCaller(ctx);
    const me = await asAlice.auth.me();
    assert.equal(me.username, "alice");
    assert.equal(me.impersonation.adminName, "root");

    // 3. 账号安全、付款、管理员接口、再代入别人：一律拒
    await assert.rejects(asAlice.auth.changePassword({ oldPassword: "alice-pass-123", newPassword: "hijacked-pass" }), { message: IMPERSONATION_BLOCKED_MESSAGE });
    await assert.rejects(asAlice.auth.updateProfile({ email: "evil@example.com" }), { message: IMPERSONATION_BLOCKED_MESSAGE });
    await assert.rejects(asAlice.auth.beginTwoFactorSetup(), { message: IMPERSONATION_BLOCKED_MESSAGE });
    await assert.rejects(asAlice.ops.sessions.revokeOthers(), { message: IMPERSONATION_BLOCKED_MESSAGE });
    await assert.rejects(asAlice.billing.redeem({ code: "FREE-MONEY" }), { message: IMPERSONATION_BLOCKED_MESSAGE });
    await assert.rejects(asAlice.users.list(), (e) => e.code === "FORBIDDEN");
    await assert.rejects(asAlice.users.enterUserBackend({ userId: aliceId }), (e) => e.code === "FORBIDDEN");
    assert.deepEqual(impRes.cookies, []);
    assert.deepEqual(impRes.cleared, []);
    // 密码确实没变
    assert.ok(await users.authenticateUser("alice", "alice-pass-123"));

    // 4. 审计：发起记在管理员名下（目标、IP）；代入里被拒的写操作也记管理员，另记以谁的身份
    await audit.drainOperationAuditWrites();
    const startRows = await runtime.queryRaw('SELECT * FROM "operation_audit_events" WHERE "path" = ? AND "result" = ?', ["users.enterUserBackend", "ok"]);
    assert.equal(startRows.length, 1);
    assert.equal(Number(startRows[0].actorUserId), adminId);
    assert.equal(JSON.parse(startRows[0].inputJson).userId, aliceId);
    assert.equal(startRows[0].ip, "203.0.113.20");
    const deniedRows = await runtime.queryRaw('SELECT * FROM "operation_audit_events" WHERE "path" = ?', ["auth.changePassword"]);
    assert.equal(deniedRows.length, 1);
    assert.equal(deniedRows[0].result, "denied");
    assert.equal(deniedRows[0].channel, "impersonation");
    assert.equal(Number(deniedRows[0].actorUserId), adminId);
    assert.equal(Number(deniedRows[0].onBehalfOfUserId), aliceId);
    assert.equal(JSON.stringify(deniedRows).includes("hijacked-pass"), false);
    const events = await runtime.queryRaw('SELECT * FROM "panel_events" WHERE "kind" = ?', ["account.impersonation_started"]);
    assert.equal(events.length, 1);

    const ended = (promise) => assert.rejects(promise, (e) => e.code === "UNAUTHORIZED" && e.message === IMPERSONATION_ENDED_MESSAGE);
    const ctxFor = (token) => createContext({ req: req({ headers: { authorization: "Bearer " + token } }), res: res() });

    // 5. 代入窗口里退出：只结束这一次代入，管理员和 alice 自己的登录都还在
    await asAlice.auth.logout();
    await ended(ctxFor(started.token));
    assert.ok(await sessions.getActiveAuthSession(adminId, "admin-sid", "browser"));
    assert.ok(await sessions.getActiveAuthSession(aliceId, "alice-sid", "browser"));

    // 6. 前缀对、内容不对的令牌：不会落回 cookie
    await ended(createContext({ req: req({ headers: { authorization: "Bearer nxu_forged" }, cookies: { app_session_id: "admin-cookie" } }), res: res() }));

    // 7. 目标被停用 / 被提成管理员、到期：立刻失效
    const second = await asAdmin.users.enterUserBackend({ userId: aliceId });
    assert.equal((await ctxFor(second.token)).user.id, aliceId);
    await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 0 WHERE "id" = ?', [aliceId]);
    await ended(ctxFor(second.token));
    await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 1 WHERE "id" = ?', [aliceId]);
    const third = await asAdmin.users.enterUserBackend({ userId: aliceId });
    await runtime.executeRaw('UPDATE "users" SET "role" = ? WHERE "id" = ?', ["admin", aliceId]);
    await ended(ctxFor(third.token));
    await runtime.executeRaw('UPDATE "users" SET "role" = ? WHERE "id" = ?', ["user", aliceId]);
    const fourth = await asAdmin.users.enterUserBackend({ userId: aliceId });
    assert.equal(await imp.resolveImpersonation(fourth.token, { allowMultiDevice: async () => true, now: Date.now() + 3_601_000 }), null);

    // 8. 管理员那次登录没了（退出、改密码），代入跟着失效
    assert.equal((await ctxFor(fourth.token)).user.id, aliceId);
    await sessions.revokeAuthSession(adminId, "admin-sid", "browser", "logout");
    await ended(ctxFor(fourth.token));
  `);
});
