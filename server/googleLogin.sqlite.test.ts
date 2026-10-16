import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  在真的 SQLite + 真的 Express 路由上把 Google 登录走一遍（Google 的 token 端点和 JWKS 用假的 fetch 顶替，
  ID Token 用测试 RSA 钥匙签）：发起 → 回调 → 未绑定被拒（不按邮箱合并）→ 绑定 → 登录拿到会话 →
  别人抢绑被拒 → 停用账号被拒 → 2FA 账号先发挑战 → 允许注册时建新账号（没有可用密码）→ 域名限制 →
  state 重放 / 缺 cookie → 令牌 aud 不对、邮箱未验证 → 从别的域名进来先换到公开地址 → App 轮询流程。
*/
test("Google 登录在 SQLite 上端到端跑通", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-google-login-"));
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
      const repo = await import(url("server/repositories/googleAccountRepository.ts"));
      const loginSessions = await import(url("server/loginSessionService.ts"));
      const { googleAuthRouter, googleAppFlows, googleStartLimiter } = await import(url("server/googleAuthRoute.ts"));

      // ---- 仓库层：唯一约束、不能用的密码、第一次设密码 ----
      const aliceId = await db.registerUser({ username: "alice@example.com", password: "alice-pass", email: "alice@example.com" });
      const bobId = await db.registerUser({ username: "bob", password: "bob-pass", email: "bob@example.com" });
      assert.equal(await repo.isEmailTakenByAnyUser("ALICE@example.com"), true);
      assert.equal(await repo.isEmailTakenByAnyUser("nobody@example.com"), false);
      assert.equal(await repo.isUsernameTaken("BOB"), true);
      const tmpId = await db.registerUser({ username: "tmp", password: "", unusablePassword: true, googleSub: "sub-tmp", googleEmail: "tmp@x.io" });
      const tmp = await db.getUserById(tmpId);
      assert.equal(password.hasUsablePassword(tmp.password), false);
      assert.equal(password.verifyPassword("", tmp.password), false);
      assert.equal(await db.authenticateUser("tmp", ""), null);
      assert.equal((await repo.getUserByGoogleSub("sub-tmp")).id, tmpId);
      await assert.rejects(repo.linkGoogleAccount(bobId, "sub-tmp", "x@x.io"), /UNIQUE/i, "同一个 sub 不能绑两个账号");
      assert.equal(await repo.setInitialPasswordForPasswordlessUser(tmpId, "new-pass-1"), true);
      assert.equal(await repo.setInitialPasswordForPasswordlessUser(tmpId, "again"), false, "有了密码就不能再走这条路");
      assert.equal((await db.authenticateUser("tmp", "new-pass-1"))?.id, tmpId);
      assert.equal(await repo.setInitialPasswordForPasswordlessUser(aliceId, "hijack"), false, "有密码的账号不能被改");
      assert.equal(await repo.unlinkGoogleAccount(tmpId), true);
      assert.equal(await repo.getUserByGoogleSub("sub-tmp"), undefined);

      // ---- 起一个只挂 Google 路由的面板 ----
      const app = express();
      app.set("trust proxy", "loopback");
      app.use(express.urlencoded({ extended: true }));
      app.use(cookieParser());
      app.use(googleAuthRouter);
      server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      const base = "http://127.0.0.1:" + server.address().port;
      const CLIENT_ID = "1234567890-e2e.apps.googleusercontent.com";
      await db.setSettings({
        panelPublicUrl: base,
        googleLoginEnabled: "true",
        googleClientId: CLIENT_ID,
        googleClientSecret: "e2e-secret",
        googleAllowRegistration: "false",
        googleAllowedDomains: null,
      });

      // ---- 假的 Google ----
      const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
      const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const sign = (payload) => {
        const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" }) + "." + b64(payload);
        return head + "." + crypto.sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url");
      };
      let identity = null;
      const tokenRequests = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const target = String(input);
        if (target === "https://www.googleapis.com/oauth2/v3/certs") return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
        if (target === "https://oauth2.googleapis.com/token") {
          const body = new URLSearchParams(String(init.body));
          tokenRequests.push(body);
          const now = Math.floor(Date.now() / 1000);
          const claims = { iss: "https://accounts.google.com", aud: CLIENT_ID, azp: CLIENT_ID, iat: now, exp: now + 3600, email_verified: true, nonce: identity.nonce, ...identity.claims };
          return new Response(JSON.stringify({ id_token: sign(claims), access_token: "ya29.not-used" }), { status: 200 });
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

      /** 走一遍：start → （假装在 Google 选了账号）→ callback。返回回调的响应。 */
      async function signIn({ mode = "login", redirect = "/rules", claims, session = null, flow = null, tamper = null }) {
        const query = new URLSearchParams({ mode, redirect });
        if (flow) query.set("flow", flow);
        const start = await get("/api/auth/google/start?" + query, { app_session_id: session });
        assert.equal(start.status, 302, "start 应该跳去 Google");
        const google = new URL(start.headers.get("location"));
        assert.equal(google.origin, "https://accounts.google.com");
        assert.equal(google.searchParams.get("redirect_uri"), base + "/api/auth/google/callback");
        const binding = cookieOf(start, "nex_google_oauth");
        assert.ok(binding, "种了浏览器绑定 cookie");
        assert.match(start.headers.getSetCookie().join("\n"), /nex_google_oauth=[^;]+;.*HttpOnly/i);
        assert.match(start.headers.getSetCookie().join("\n"), /SameSite=Lax/i);
        identity = { nonce: google.searchParams.get("nonce"), claims };
        const state = google.searchParams.get("state");
        const callbackQuery = new URLSearchParams({ code: "code-" + Math.random(), state: tamper?.state ?? state });
        const response = await get("/api/auth/google/callback?" + callbackQuery, {
          nex_google_oauth: tamper && "binding" in tamper ? tamper.binding : binding,
          app_session_id: session,
        });
        const last = tokenRequests.at(-1);
        if (last && !tamper) {
          const verifier = last.get("code_verifier");
          assert.equal(crypto.createHash("sha256").update(verifier).digest("base64url"), google.searchParams.get("code_challenge"), "PKCE verifier 对得上 challenge");
        }
        return { response, state, binding };
      }
      const locationOf = (response) => response.headers.get("location");

      const ALICE_GOOGLE = { sub: "sub-alice", email: "alice@example.com", name: "Alice G" };

      // 1. 没绑定：即使邮箱和 alice 一模一样也不登录、不合并
      let result = await signIn({ claims: ALICE_GOOGLE });
      assert.equal(locationOf(result.response), "/login?googleError=not_linked");
      assert.equal(cookieOf(result.response, "app_session_id"), null);
      assert.equal((await db.getUserById(aliceId)).googleSub, null);

      // 2. 同一个 state 再用一次 / 没有绑定 cookie
      const replay = await get("/api/auth/google/callback?code=x&state=" + result.state, { nex_google_oauth: result.binding });
      assert.equal(locationOf(replay), "/login?googleError=state_invalid");
      result = await signIn({ claims: ALICE_GOOGLE, tamper: { binding: null } });
      assert.equal(locationOf(result.response), "/login?googleError=state_invalid");
      result = await signIn({ claims: ALICE_GOOGLE, tamper: { binding: "z".repeat(43) } });
      assert.equal(locationOf(result.response), "/login?googleError=state_invalid");

      // 3. 绑定：alice 先用密码登录（这里直接发一个会话），在个人资料里点绑定
      const sessionFor = async (userId) => {
        const sid = crypto.randomBytes(12).toString("hex");
        await loginSessions.createLoginAuthSession({ userId, sid, kind: "browser", expiresAt: new Date(Date.now() + 3600_000) });
        return jwt.sign({ userId, sid, kind: "browser" }, process.env.JWT_SECRET, { expiresIn: 3600 });
      };
      const aliceSession = await sessionFor(aliceId);
      const noSessionLink = await get("/api/auth/google/start?mode=link");
      assert.equal(locationOf(noSessionLink), "/login?googleError=link_requires_login", "没登录不能发起绑定");
      result = await signIn({ mode: "link", redirect: "/profile", claims: ALICE_GOOGLE, session: aliceSession });
      assert.equal(locationOf(result.response), "/profile?googleLinked=1");
      const linkedAlice = await db.getUserById(aliceId);
      assert.equal(linkedAlice.googleSub, "sub-alice");
      assert.equal(linkedAlice.googleEmail, "alice@example.com");

      // 4. 用 Google 登录：拿到和密码登录一样的会话 cookie，跳回要去的页面
      result = await signIn({ claims: ALICE_GOOGLE, redirect: "/rules?tab=mine" });
      assert.equal(locationOf(result.response), "/rules?tab=mine");
      const token = cookieOf(result.response, "app_session_id");
      assert.ok(token, "发了会话 cookie");
      assert.equal(jwt.verify(token, process.env.JWT_SECRET).userId, aliceId);
      assert.match(result.response.headers.getSetCookie().join("\n"), /app_session_id=[^;]+;.*HttpOnly/i);
      // 跳转目标被清洗
      result = await signIn({ claims: ALICE_GOOGLE, redirect: "//evil.example.com/x" });
      assert.equal(locationOf(result.response), "/");

      // 5. bob 想把 alice 的 Google 绑到自己身上：拒绝
      const bobSession = await sessionFor(bobId);
      result = await signIn({ mode: "link", claims: ALICE_GOOGLE, session: bobSession });
      assert.equal(locationOf(result.response), "/profile?googleError=linked_elsewhere");
      assert.equal((await db.getUserById(bobId)).googleSub, null);

      // 6. 停用的账号
      await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 0 WHERE "id" = ?', [aliceId]);
      result = await signIn({ claims: ALICE_GOOGLE });
      assert.equal(locationOf(result.response), "/login?googleError=account_disabled");
      assert.equal(cookieOf(result.response, "app_session_id"), null);
      await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 1 WHERE "id" = ?', [aliceId]);

      // 7. 开了 2FA 的账号：不直接发会话，带着挑战回登录页（挑战放在 # 后面）
      await db.setSetting("twoFactorEnabled", "true");
      await runtime.executeRaw('UPDATE "users" SET "twoFactorEnabled" = 1, "twoFactorSecret" = ? WHERE "id" = ?', ["JBSWY3DPEHPK3PXP", aliceId]);
      result = await signIn({ claims: ALICE_GOOGLE, redirect: "/hosts" });
      const twoFactorLocation = locationOf(result.response);
      assert.match(twoFactorLocation, /^\/login#googleTwoFactor=[a-f0-9]{48}&u=alice%40example.com&exp=300&next=%2Fhosts$/);
      assert.equal(cookieOf(result.response, "app_session_id"), null, "2FA 之前没有会话");
      await runtime.executeRaw('UPDATE "users" SET "twoFactorEnabled" = 0, "twoFactorSecret" = NULL WHERE "id" = ?', [aliceId]);
      await db.setSetting("twoFactorEnabled", "false");

      // 8. 允许 Google 注册：新邮箱建新账号（没有可用密码、邮箱已验证）
      await db.setSetting("googleAllowRegistration", "true");
      result = await signIn({ claims: { sub: "sub-new", email: "bob@fresh.io", name: "New Bob" }, redirect: "/" });
      assert.equal(locationOf(result.response), "/");
      const created = await repo.getUserByGoogleSub("sub-new");
      assert.equal(created.username, "bob2", "bob 被占了，取 bob2");
      assert.equal(created.email, "bob@fresh.io");
      assert.equal(!!created.emailVerified, true);
      assert.equal(password.hasUsablePassword(created.password), false);
      assert.equal(jwt.verify(cookieOf(result.response, "app_session_id"), process.env.JWT_SECRET).userId, created.id);
      // 已有账号的邮箱：仍然不建、不合并
      result = await signIn({ claims: { sub: "sub-other", email: "BOB@example.com" } });
      assert.equal(locationOf(result.response), "/login?googleError=email_in_use");
      // 面板关了注册
      await db.setSetting("registrationEnabled", "false");
      result = await signIn({ claims: { sub: "sub-closed", email: "c@fresh.io" } });
      assert.equal(locationOf(result.response), "/login?googleError=registration_closed");
      await db.setSetting("registrationEnabled", "true");
      // 域名限制
      await db.setSetting("googleAllowedDomains", "corp.io");
      result = await signIn({ claims: { sub: "sub-dom", email: "d@fresh.io" } });
      assert.equal(locationOf(result.response), "/login?googleError=domain_not_allowed");
      await db.setSetting("googleAllowedDomains", null);
      await db.setSetting("googleAllowRegistration", "false");

      // 9. 令牌不对：aud 不是我们、邮箱没验证
      result = await signIn({ claims: { ...ALICE_GOOGLE, aud: "someone-else" } });
      assert.equal(locationOf(result.response), "/login?googleError=token_invalid");
      result = await signIn({ claims: { ...ALICE_GOOGLE, email_verified: false } });
      assert.equal(locationOf(result.response), "/login?googleError=email_unverified");

      // 10. 用户在 Google 那边点了取消
      const startCancel = await get("/api/auth/google/start?mode=login");
      const cancelState = new URL(startCancel.headers.get("location")).searchParams.get("state");
      const cancelled = await get("/api/auth/google/callback?error=access_denied&state=" + cancelState, { nex_google_oauth: cookieOf(startCancel, "nex_google_oauth") });
      assert.equal(locationOf(cancelled), "/login?googleError=cancelled");

      // 11. 从别的域名进来：先换到面板公开地址
      const viaOtherHost = await new Promise((resolve, reject) => {
        http.get(base + "/api/auth/google/start?mode=login&redirect=%2Frules", { headers: { host: "10.0.0.5:9810" } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode, location: res.headers.location });
        }).on("error", reject);
      });
      assert.equal(viaOtherHost.status, 302);
      assert.equal(viaOtherHost.location, base + "/api/auth/google/start?mode=login&redirect=%2Frules&canon=1");

      // 12. 关掉 Google 登录后，start 直接回登录页
      await db.setSetting("googleLoginEnabled", "false");
      assert.equal(locationOf(await get("/api/auth/google/start")), "/login?googleError=disabled");
      await db.setSetting("googleLoginEnabled", "true");

      // 13. 发起次数限流：同一来源一分钟 20 次
      googleStartLimiter.clear();
      for (let i = 0; i < 20; i += 1) assert.equal((await get("/api/auth/google/start")).status, 302);
      assert.equal(locationOf(await get("/api/auth/google/start")), "/login?googleError=rate_limited");
      googleStartLimiter.clear();

      // 14. App：系统浏览器里完成，App 轮询拿结果；同一个 start 链接不能开第二次
      const flow = googleAppFlows.create("127.0.0.1");
      result = await signIn({ mode: "app", claims: ALICE_GOOGLE, flow: flow.flowId });
      assert.equal(result.response.status, 200);
      assert.match(await result.response.text(), /请回到 NEX App/);
      assert.equal(cookieOf(result.response, "app_session_id"), null, "浏览器里不发会话");
      assert.deepEqual(googleAppFlows.poll(flow.flowId, flow.pollToken), { status: "done", userId: aliceId });
      const reopened = await get("/api/auth/google/start?mode=app&flow=" + flow.flowId);
      assert.equal(reopened.status, 400);
      // App 发起时的 IP 和浏览器不一样：先要确认
      const far = googleAppFlows.create("198.51.100.20");
      result = await signIn({ mode: "app", claims: ALICE_GOOGLE, flow: far.flowId });
      const page = await result.response.text();
      assert.match(page, /确认登录到 NEX App/);
      assert.match(page, /198\.51\.100\.20/);
      assert.deepEqual(googleAppFlows.poll(far.flowId, far.pollToken), { status: "pending" });
      const confirmId = page.match(/name="confirm" value="([^"]+)"/)[1];
      const confirmed = await realFetch(base + "/api/auth/google/app-confirm", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ flow: far.flowId, confirm: confirmId }).toString(),
      });
      assert.equal(confirmed.status, 200);
      assert.deepEqual(googleAppFlows.poll(far.flowId, far.pollToken), { status: "done", userId: aliceId });
      // App 流程里没绑定的账号：结果是失败码
      const unlinkedFlow = googleAppFlows.create("127.0.0.1");
      result = await signIn({ mode: "app", claims: { sub: "sub-nobody", email: "n@x.io" }, flow: unlinkedFlow.flowId });
      assert.equal(result.response.status, 400);
      assert.deepEqual(googleAppFlows.poll(unlinkedFlow.flowId, unlinkedFlow.pollToken), { status: "failed", code: "not_linked" });

      // 日志 / 事件里不出现令牌
      const events = await runtime.queryRaw('SELECT "kind", "message", "dataJson" FROM "panel_events"');
      const kinds = events.map((row) => row.kind);
      assert.ok(kinds.includes("account.google_linked"));
      assert.ok(kinds.includes("account.google_registered"));
      assert.ok(kinds.includes("account.login"));
      assert.ok(!JSON.stringify(events).includes("ya29"), "access_token 不落库");
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
      JWT_SECRET: "e2e-google-login-secret-0123456789abcdef0123456789abcdef",
    },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
