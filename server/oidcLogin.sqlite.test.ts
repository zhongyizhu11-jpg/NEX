import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  在真的 SQLite + 真的 Express 路由上把通用 OIDC 登录走一遍。IdP（discovery / JWKS / token / userinfo）用
  假的出站请求顶替（真 IdP 起在回环地址上会被 SSRF 防护拦下，本来就不该连），ID Token 用测试钥匙现场签：
  发起 → 回调 → 未绑定被拒（不按邮箱合并）→ 绑定 → 登录拿到会话 → 别人抢绑被拒 → (issuer, sub) 联合唯一 →
  停用账号 → 2FA 先发挑战 → 允许注册时建新账号 → ES256 令牌 + userinfo 补邮箱 → 未验证邮箱 →
  回调 iss 参数不对 → state 重放 / 缺 cookie → 配置中途变了 → 解绑规则。
*/
test("通用 OIDC 登录在 SQLite 上端到端跑通", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-oidc-login-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import crypto from "node:crypto";
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
      const repo = await import(url("server/repositories/oidcAccountRepository.ts"));
      const loginSessions = await import(url("server/loginSessionService.ts"));
      const { oidcAuthRouter, oidcProviders, oidcStartLimiter } = await import(url("server/oidcAuthRoute.ts"));
      const { oidcAuthRouter: oidcTrpc } = await import(url("server/routers/oidcAuth.ts"));

      const ISSUER = "https://id.example.com";
      const OTHER_ISSUER = "https://other-idp.example.com";

      // ---- 仓库层：(issuer, sub) 联合唯一，同 sub 不同 issuer 可以共存 ----
      const aliceId = await db.registerUser({ username: "alice", password: "alice-pass", email: "alice@example.com" });
      const bobId = await db.registerUser({ username: "bob", password: "bob-pass", email: "bob@example.com" });
      const tmpId = await db.registerUser({ username: "tmp", password: "", unusablePassword: true, oidcIssuer: ISSUER, oidcSub: "sub-tmp", oidcEmail: "tmp@x.io" });
      assert.equal((await repo.getUserByOidcIdentity(ISSUER, "sub-tmp")).id, tmpId);
      assert.equal(await repo.getUserByOidcIdentity(OTHER_ISSUER, "sub-tmp"), undefined);
      await assert.rejects(repo.linkOidcAccount(bobId, ISSUER, "sub-tmp", "x@x.io"), /UNIQUE/i, "同一个 (issuer, sub) 不能绑两个账号");
      assert.equal(await repo.linkOidcAccount(bobId, OTHER_ISSUER, "sub-tmp", "x@x.io"), true, "别的 IdP 里同样的 sub 是另一个人");
      assert.equal(await repo.linkOidcAccount(bobId, OTHER_ISSUER, "sub-x", "x@x.io"), false, "同一个 Issuer 已经绑了就不覆盖");
      assert.equal(await repo.unlinkOidcAccount(bobId), true);
      assert.equal(await repo.unlinkOidcAccount(tmpId), true);
      assert.equal(password.hasUsablePassword((await db.getUserById(tmpId)).password), false);

      // ---- 起一个只挂 OIDC 路由的面板 ----
      const app = express();
      app.set("trust proxy", "loopback");
      app.use(cookieParser());
      app.use(oidcAuthRouter);
      server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      const base = "http://127.0.0.1:" + server.address().port;
      const CLIENT_ID = "nex-panel";
      await db.setSettings({
        panelPublicUrl: base,
        oidcLoginEnabled: "true",
        oidcProviderName: "Pocket ID",
        oidcIssuer: ISSUER,
        oidcClientId: CLIENT_ID,
        oidcClientSecret: "e2e-secret",
        oidcAllowRegistration: "false",
      });
      const stored = await runtime.queryRaw('SELECT "value" FROM "system_settings" WHERE "key" = ?', ["oidcClientSecret"]);
      assert.ok(!String(stored[0]?.value).includes("e2e-secret"), "客户端密钥落库是加密的");
      assert.equal((await db.getAllSettings()).oidcClientSecret, "e2e-secret");

      // ---- 假的 IdP ----
      const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const jwks = { keys: [
        { ...rsa.publicKey.export({ format: "jwk" }), kid: "r1", alg: "RS256", use: "sig" },
        { ...ec.publicKey.export({ format: "jwk" }), kid: "e1", alg: "ES256", use: "sig" },
      ] };
      const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const sign = (payload, alg = "RS256") => {
        const head = b64({ alg, kid: alg === "ES256" ? "e1" : "r1", typ: "JWT" }) + "." + b64(payload);
        const sig = alg === "ES256"
          ? crypto.sign("sha256", Buffer.from(head), { key: ec.privateKey, dsaEncoding: "ieee-p1363" })
          : crypto.sign("RSA-SHA256", Buffer.from(head), rsa.privateKey);
        return head + "." + sig.toString("base64url");
      };
      let identity = null;
      const tokenRequests = [];
      const userinfoRequests = [];
      const json = (status, body, headers = {}) => ({ status, headers, body: Buffer.from(JSON.stringify(body)) });
      oidcProviders.replaceHttpForTests(() => async (target, init) => {
        if (target === ISSUER + "/.well-known/openid-configuration") {
          return json(200, {
            issuer: ISSUER,
            authorization_endpoint: ISSUER + "/authorize",
            token_endpoint: ISSUER + "/api/oidc/token",
            jwks_uri: ISSUER + "/.well-known/jwks.json",
            userinfo_endpoint: ISSUER + "/api/oidc/userinfo",
            response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          });
        }
        if (target === ISSUER + "/.well-known/jwks.json") return json(200, jwks);
        if (target === ISSUER + "/api/oidc/token") {
          assert.equal(init.method, "POST");
          tokenRequests.push({ body: new URLSearchParams(init.body), authorization: init.headers.Authorization });
          const now = Math.floor(Date.now() / 1000);
          const claims = { iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 300, email_verified: true, nonce: identity.nonce, ...identity.claims };
          for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
          return json(200, { id_token: sign(claims, identity.alg), access_token: "at-secret-value", token_type: "Bearer" });
        }
        if (target === ISSUER + "/api/oidc/userinfo") {
          userinfoRequests.push(init.headers.Authorization);
          return json(200, identity.userinfo || {});
        }
        return json(404, {});
      });

      const cookieOf = (response, name) => {
        for (const line of response.headers.getSetCookie()) {
          if (line.startsWith(name + "=")) return line.split(";")[0].slice(name.length + 1);
        }
        return null;
      };
      const get = (pathname, cookies = {}) => fetch(base + pathname, {
        redirect: "manual",
        headers: { cookie: Object.entries(cookies).filter(([, v]) => v).map(([k, v]) => k + "=" + v).join("; ") },
      });
      const locationOf = (response) => response.headers.get("location");

      async function signIn({ mode = "login", redirect = "/rules", claims, alg = "RS256", userinfo = null, session = null, tamper = null, iss = undefined, invite = null }) {
        const query = new URLSearchParams({ mode, redirect });
        if (invite) query.set("invite", invite);
        const start = await get("/api/auth/oidc/start?" + query, { app_session_id: session });
        assert.equal(start.status, 302, "start 应该跳去 IdP");
        const idp = new URL(start.headers.get("location"));
        assert.equal(idp.origin + idp.pathname, ISSUER + "/authorize");
        assert.equal(idp.searchParams.get("redirect_uri"), base + "/api/auth/oidc/callback");
        assert.equal(idp.searchParams.get("scope"), "openid email profile");
        assert.equal(idp.searchParams.get("code_challenge_method"), "S256");
        const binding = cookieOf(start, "nex_oidc_oauth");
        assert.ok(binding, "种了浏览器绑定 cookie");
        assert.match(start.headers.getSetCookie().join("\n"), /nex_oidc_oauth=[^;]+;.*HttpOnly/i);
        identity = { nonce: idp.searchParams.get("nonce"), claims, alg, userinfo };
        const state = idp.searchParams.get("state");
        const callbackQuery = new URLSearchParams({ code: "code-" + Math.random(), state: tamper?.state ?? state });
        if (iss !== undefined) callbackQuery.set("iss", iss);
        const requestsBefore = tokenRequests.length;
        const response = await get("/api/auth/oidc/callback?" + callbackQuery, {
          nex_oidc_oauth: tamper && "binding" in tamper ? tamper.binding : binding,
          app_session_id: session,
        });
        const last = tokenRequests.length > requestsBefore ? tokenRequests.at(-1) : null;
        if (last) {
          assert.equal(crypto.createHash("sha256").update(last.body.get("code_verifier")).digest("base64url"), idp.searchParams.get("code_challenge"), "PKCE 对得上");
          assert.equal(last.authorization, "Basic " + Buffer.from(CLIENT_ID + ":e2e-secret").toString("base64"), "client_secret_basic");
        }
        return { response, state, binding };
      }

      const ALICE = { sub: "pid-alice", email: "alice@example.com", name: "Alice P", preferred_username: "alice" };

      // 1. 没绑定：邮箱和 alice 一模一样也不登录、不合并
      let result = await signIn({ claims: ALICE });
      assert.equal(locationOf(result.response), "/login?oidcError=not_linked");
      assert.equal(cookieOf(result.response, "app_session_id"), null);
      assert.equal((await db.getUserById(aliceId)).oidcSub, null);

      // 2. state 重放 / 缺 cookie / cookie 不对
      const replay = await get("/api/auth/oidc/callback?code=x&state=" + result.state, { nex_oidc_oauth: result.binding });
      assert.equal(locationOf(replay), "/login?oidcError=state_invalid");
      result = await signIn({ claims: ALICE, tamper: { binding: null } });
      assert.equal(locationOf(result.response), "/login?oidcError=state_invalid");

      // 3. 绑定
      const sessionFor = async (userId) => {
        const sid = crypto.randomBytes(12).toString("hex");
        await loginSessions.createLoginAuthSession({ userId, sid, kind: "browser", expiresAt: new Date(Date.now() + 3600_000) });
        return jwt.sign({ userId, sid, kind: "browser" }, process.env.JWT_SECRET, { expiresIn: 3600 });
      };
      const aliceSession = await sessionFor(aliceId);
      assert.equal(locationOf(await get("/api/auth/oidc/start?mode=link")), "/login?oidcError=link_requires_login", "没登录不能发起绑定");
      result = await signIn({ mode: "link", redirect: "/profile", claims: ALICE, session: aliceSession });
      assert.equal(locationOf(result.response), "/profile?oidcLinked=1");
      const linkedAlice = await db.getUserById(aliceId);
      assert.deepEqual([linkedAlice.oidcIssuer, linkedAlice.oidcSub, linkedAlice.oidcEmail], [ISSUER, "pid-alice", "alice@example.com"]);
      assert.ok(linkedAlice.oidcLinkedAt);

      // 4. 用 OIDC 登录：拿到会话 cookie，跳回要去的页面；跳转目标被清洗
      result = await signIn({ claims: ALICE, redirect: "/rules?tab=mine" });
      assert.equal(locationOf(result.response), "/rules?tab=mine");
      assert.equal(jwt.verify(cookieOf(result.response, "app_session_id"), process.env.JWT_SECRET).userId, aliceId);
      result = await signIn({ claims: ALICE, redirect: "//evil.example.com/x" });
      assert.equal(locationOf(result.response), "/");

      // 5. bob 想把 alice 的身份绑到自己身上：拒绝
      const bobSession = await sessionFor(bobId);
      result = await signIn({ mode: "link", claims: ALICE, session: bobSession });
      assert.equal(locationOf(result.response), "/profile?oidcError=linked_elsewhere");
      assert.equal((await db.getUserById(bobId)).oidcSub, null);

      // 6. 停用的账号
      await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 0 WHERE "id" = ?', [aliceId]);
      result = await signIn({ claims: ALICE });
      assert.equal(locationOf(result.response), "/login?oidcError=account_disabled");
      await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 1 WHERE "id" = ?', [aliceId]);

      // 7. 开了 2FA：先发挑战，不发会话
      await db.setSetting("twoFactorEnabled", "true");
      await runtime.executeRaw('UPDATE "users" SET "twoFactorEnabled" = 1, "twoFactorSecret" = ? WHERE "id" = ?', ["JBSWY3DPEHPK3PXP", aliceId]);
      result = await signIn({ claims: ALICE, redirect: "/hosts" });
      assert.match(locationOf(result.response), /^\/login#oidcTwoFactor=[a-f0-9]{48}&u=alice&exp=300&next=%2Fhosts$/);
      assert.equal(cookieOf(result.response, "app_session_id"), null, "2FA 之前没有会话");
      await runtime.executeRaw('UPDATE "users" SET "twoFactorEnabled" = 0, "twoFactorSecret" = NULL WHERE "id" = ?', [aliceId]);
      await db.setSetting("twoFactorEnabled", "false");

      // 8. 回调 iss 参数不对（IdP 混淆）、aud 不对、邮箱未验证
      result = await signIn({ claims: ALICE, iss: "https://evil.example.com" });
      assert.equal(locationOf(result.response), "/login?oidcError=token_invalid");
      result = await signIn({ claims: ALICE, iss: ISSUER });
      assert.equal(locationOf(result.response), "/rules");
      result = await signIn({ claims: { ...ALICE, aud: "someone-else" } });
      assert.equal(locationOf(result.response), "/login?oidcError=token_invalid");
      result = await signIn({ claims: { ...ALICE, email_verified: false } });
      assert.equal(locationOf(result.response), "/login?oidcError=email_unverified");

      // 9. 允许注册：ES256 令牌、ID Token 里没有邮箱 —— 用 userinfo 补；用户名取 IdP 的 preferred_username
      await db.setSetting("oidcAllowRegistration", "true");
      result = await signIn({
        claims: { sub: "pid-carol", email: undefined, email_verified: undefined, preferred_username: "carol" },
        alg: "ES256",
        userinfo: { sub: "pid-carol", email: "Carol@Fresh.io", email_verified: true, name: "Carol" },
        redirect: "/",
      });
      assert.equal(locationOf(result.response), "/");
      assert.equal(userinfoRequests.at(-1), "Bearer at-secret-value");
      const carol = await repo.getUserByOidcIdentity(ISSUER, "pid-carol");
      assert.equal(carol.username, "carol");
      assert.equal(carol.email, "carol@fresh.io");
      assert.equal(!!carol.emailVerified, true);
      assert.equal(password.hasUsablePassword(carol.password), false);
      // userinfo 的 sub 和 ID Token 对不上：不认
      result = await signIn({ claims: { sub: "pid-dave", email: undefined, email_verified: undefined }, userinfo: { sub: "pid-alice", email: "dave@fresh.io", email_verified: true } });
      assert.equal(locationOf(result.response), "/login?oidcError=token_invalid");
      // 已有账号的邮箱：不建、不合并
      result = await signIn({ claims: { sub: "pid-other", email: "BOB@example.com" } });
      assert.equal(locationOf(result.response), "/login?oidcError=email_in_use");
      // 关了「只接受已验证邮箱」：未验证的邮箱能注册，但不记成已验证
      await db.setSetting("oidcRequireVerifiedEmail", "false");
      result = await signIn({ claims: { sub: "pid-erin", email: "erin@fresh.io", email_verified: false } });
      assert.equal(result.response.status, 302);
      assert.equal(!!(await repo.getUserByOidcIdentity(ISSUER, "pid-erin")).emailVerified, false);
      await db.setSetting("oidcRequireVerifiedEmail", null);
      // 域名限制
      await db.setSetting("oidcAllowedDomains", "corp.io");
      result = await signIn({ claims: { sub: "pid-frank", email: "frank@fresh.io" } });
      assert.equal(locationOf(result.response), "/login?oidcError=domain_not_allowed");
      await db.setSetting("oidcAllowedDomains", null);
      await db.setSetting("oidcAllowRegistration", "false");

      // 10. 用户在 IdP 那边点了取消 / IdP 报错
      const startCancel = await get("/api/auth/oidc/start?mode=login");
      const cancelState = new URL(startCancel.headers.get("location")).searchParams.get("state");
      const cancelled = await get("/api/auth/oidc/callback?error=access_denied&state=" + cancelState, { nex_oidc_oauth: cookieOf(startCancel, "nex_oidc_oauth") });
      assert.equal(locationOf(cancelled), "/login?oidcError=cancelled");

      // 11. 发起之后管理员换了 Issuer：回调不认，也不去换票
      oidcStartLimiter.clear();
      {
        const start = await get("/api/auth/oidc/start?mode=login&redirect=%2F");
        const idp = new URL(start.headers.get("location"));
        identity = { nonce: idp.searchParams.get("nonce"), claims: ALICE };
        await db.setSetting("oidcClientSecret", "rotated-secret");
        const before = tokenRequests.length;
        const callback = await get("/api/auth/oidc/callback?code=c1&state=" + idp.searchParams.get("state"), { nex_oidc_oauth: cookieOf(start, "nex_oidc_oauth") });
        assert.equal(locationOf(callback), "/login?oidcError=state_invalid");
        assert.equal(tokenRequests.length, before, "配置变了就不去换票");
        await db.setSetting("oidcClientSecret", "e2e-secret");
      }

      // 12. 关掉后 start 直接回登录页；discovery 拉不到时提示 discovery_failed
      await db.setSetting("oidcLoginEnabled", "false");
      assert.equal(locationOf(await get("/api/auth/oidc/start")), "/login?oidcError=disabled");
      await db.setSetting("oidcLoginEnabled", "true");
      await db.setSetting("oidcIssuer", "https://down.example.com");
      oidcProviders.clear();
      assert.equal(locationOf(await get("/api/auth/oidc/start")), "/login?oidcError=discovery_failed");
      await db.setSetting("oidcIssuer", ISSUER);

      // 13. tRPC：状态、测试发现、解绑规则（只剩 OIDC 一种登录方式时不让解绑）
      const ctxFor = async (userId) => ({
        req: { headers: {}, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } },
        res: { cookie() {}, clearCookie() {} },
        user: await db.getUserById(userId),
        authSession: null,
        authFailureReason: null,
      });
      const carolCaller = oidcTrpc.createCaller(await ctxFor(carol.id));
      const carolStatus = await carolCaller.status();
      assert.equal(carolStatus.linked, true);
      assert.equal(carolStatus.providerName, "Pocket ID");
      assert.equal(carolStatus.canUnlink, false, "OIDC 注册的账号没有密码：不能解绑");
      await assert.rejects(carolCaller.unlink(), /先设置登录密码/);
      await carolCaller.setInitialPassword({ newPassword: "carol-pass-1" });
      const carolAfter = oidcTrpc.createCaller(await ctxFor(carol.id));
      assert.equal((await carolAfter.status()).canUnlink, true);
      assert.deepEqual(await carolAfter.unlink(), { success: true });
      assert.equal(await repo.getUserByOidcIdentity(ISSUER, "pid-carol"), undefined);

      const adminId = await db.registerUser({ username: "root", password: "root-pass" });
      await runtime.executeRaw('UPDATE "users" SET "role" = ? WHERE "id" = ?', ["admin", adminId]);
      const admin = oidcTrpc.createCaller(await ctxFor(adminId));
      const tested = await admin.testDiscovery({ issuer: ISSUER });
      assert.equal(tested.ok, true);
      assert.equal(tested.discovery.tokenEndpoint, ISSUER + "/api/oidc/token");
      assert.equal(tested.keyCount, 2);
      const badIssuer = await admin.testDiscovery({ issuer: "http://10.0.0.5" });
      assert.equal(badIssuer.ok, false);
      assert.match(badIssuer.message, /IdP 在内网/);
      const view = await admin.adminSettings();
      assert.ok(!JSON.stringify(view).includes("e2e-secret"), "设置页只拿到打码的密钥");
      await assert.rejects(oidcTrpc.createCaller(await ctxFor(bobId)).adminSettings(), (error) => error?.code === "FORBIDDEN");

      // 14. 换了 Issuer：alice 的旧绑定不再能登录，个人资料显示「旧绑定」
      await admin.updateAdminSettings({ issuer: OTHER_ISSUER });
      const aliceStatus = await oidcTrpc.createCaller(await ctxFor(aliceId)).status();
      assert.equal(aliceStatus.linked, false);
      assert.equal(aliceStatus.staleBinding, true);
      await admin.updateAdminSettings({ issuer: ISSUER });

      // 事件时间线：有绑定 / 注册 / 登录 / 解绑；令牌不落库
      const events = await runtime.queryRaw('SELECT "kind", "message", "dataJson" FROM "panel_events"');
      const kinds = events.map((row) => row.kind);
      for (const kind of ["account.oidc_linked", "account.oidc_registered", "account.oidc_unlinked", "account.login", "security.oidc_login_changed"]) {
        assert.ok(kinds.includes(kind), kind);
      }
      assert.ok(events.some((row) => row.kind === "account.login" && String(row.dataJson).includes('"method":"oidc"')));
      assert.ok(!JSON.stringify(events).includes("at-secret-value"), "access_token 不落库");
      oidcProviders.replaceHttpForTests(null);
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
      JWT_SECRET: "e2e-oidc-login-secret-0123456789abcdef0123456789abcdef",
    },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
