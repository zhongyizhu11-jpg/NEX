import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildDiscordAuthorizationUrl,
  DiscordAuthStateStore,
  DiscordOAuthError,
  exchangeDiscordAuthorizationCode,
  fetchDiscordProfile,
  parseDiscordProfile,
  revokeDiscordToken,
} from "./discordOAuth";
import { sha256Base64Url } from "./googleOidc";

const CLIENT_ID = "123456789012345678";
// 假凭据：拆开拼，明显是假的，也不会被推送保护当成真密钥
const CLIENT_SECRET = ["fake", "client", "secret"].join("-");
const ACCESS_TOKEN = ["fake", "access", "token"].join("-");
const REDIRECT_URI = "https://panel.example.com/api/auth/discord/callback";

async function rejectsWith(promise: Promise<unknown>, code: string, why?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DiscordOAuthError, String(error));
    assert.equal(error.code, code);
    if (why) assert.match(error.message, why);
    return true;
  });
}

test("state 只能用一次，要配对浏览器 cookie，10 分钟后过期", () => {
  let now = 1_000_000;
  const store = new DiscordAuthStateStore({ now: () => now });
  const binding = "b".repeat(43);
  const input = { mode: "login" as const, redirectPath: "/rules", userId: null, appFlowId: null, binding, inviteCode: "ABCD2345" };

  const first = store.create(input);
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.entry.bindingHash, sha256Base64Url(binding));
  assert.equal(first.codeChallenge, sha256Base64Url(first.entry.codeVerifier), "PKCE S256");
  assert.match(first.entry.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  const consumed = store.consume(first.state, binding);
  assert.equal(consumed?.redirectPath, "/rules");
  assert.equal(consumed?.inviteCode, "ABCD2345");
  assert.equal(store.consume(first.state, binding), null, "第二次用同一个 state 必须失败");

  // cookie 不对：拒绝，而且这个 state 也废了
  const second = store.create(input);
  assert.equal(store.consume(second.state, "x".repeat(43)), null);
  assert.equal(store.consume(second.state, binding), null);
  const third = store.create(input);
  assert.equal(store.consume(third.state, ""), null, "没有 cookie");

  const fourth = store.create(input);
  now += 10 * 60 * 1000;
  assert.equal(store.consume(fourth.state, binding), null, "过期");

  assert.equal(store.consume("short", binding), null);
  assert.equal(store.consume(undefined, binding), null);
  assert.equal(store.consume(["a"], binding), null);
});

test("state 表有上限，过期的会被清掉", () => {
  let now = 0;
  const store = new DiscordAuthStateStore({ now: () => now, maxEntries: 3 });
  const input = { mode: "login" as const, redirectPath: "/", userId: null, appFlowId: null, binding: "c".repeat(43) };
  const states = [store.create(input), store.create(input), store.create(input), store.create(input)].map((item) => item.state);
  assert.equal(store.size, 3);
  assert.equal(store.consume(states[0], "c".repeat(43)), null, "最早的被挤掉");
  now += 11 * 60 * 1000;
  store.create(input);
  assert.equal(store.size, 1);
});

test("授权地址：identify email、state、PKCE S256、prompt=consent", () => {
  const url = new URL(buildDiscordAuthorizationUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state: "state-1", codeChallenge: "challenge-1" }));
  assert.equal(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "identify email");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("prompt"), "consent");
});

test("换票：client_secret_post 带上 code_verifier，只取回 access_token", async () => {
  let seen: { url: string; init?: RequestInit; body: URLSearchParams } | null = null;
  const result = await exchangeDiscordAuthorizationCode({
    code: "auth-code",
    codeVerifier: "verifier-1",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      seen = { url, init, body: new URLSearchParams(String(init?.body)) };
      return new Response(JSON.stringify({ access_token: ACCESS_TOKEN, token_type: "Bearer", scope: "identify email", expires_in: 604800, refresh_token: "r" }), { status: 200 });
    }) as any,
  });
  assert.equal(result.accessToken, ACCESS_TOKEN);
  assert.deepEqual(result.scopes, ["identify", "email"]);
  assert.equal(seen!.url, "https://discord.com/api/oauth2/token");
  assert.equal(seen!.init?.method, "POST");
  assert.equal((seen!.init?.headers as any)["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(seen!.body.get("grant_type"), "authorization_code");
  assert.equal(seen!.body.get("code"), "auth-code");
  assert.equal(seen!.body.get("code_verifier"), "verifier-1");
  assert.equal(seen!.body.get("client_id"), CLIENT_ID);
  assert.equal(seen!.body.get("client_secret"), CLIENT_SECRET);
  assert.equal(seen!.body.get("redirect_uri"), REDIRECT_URI);

  const base = { code: "c", codeVerifier: "v", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI };
  await rejectsWith(exchangeDiscordAuthorizationCode({ ...base, fetchImpl: (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as any }), "exchange_failed", /invalid_grant/);
  await rejectsWith(exchangeDiscordAuthorizationCode({ ...base, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as any }), "exchange_failed", /unreachable/);
  await rejectsWith(exchangeDiscordAuthorizationCode({ ...base, fetchImpl: (async () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 })) as any }), "exchange_failed", /no access_token/);
  await rejectsWith(exchangeDiscordAuthorizationCode({ ...base, fetchImpl: (async () => new Response(JSON.stringify({ access_token: "x", token_type: "mac" }), { status: 200 })) as any }), "exchange_failed", /non-bearer/);
  await rejectsWith(exchangeDiscordAuthorizationCode({ ...base, fetchImpl: (async () => new Response(JSON.stringify({ access_token: "x", token_type: "Bearer", scope: "email" }), { status: 200 })) as any }), "profile_invalid", /identify/);
  // 错误信息里不带任何令牌
  await assert.rejects(
    exchangeDiscordAuthorizationCode({ ...base, fetchImpl: (async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })) as any }),
    (error: any) => !String(error.message).includes(CLIENT_SECRET),
  );
});

test("/users/@me：带 Bearer，邮箱必须已验证；只认字符串形式的雪花 ID", async () => {
  let auth = "";
  const profile = await fetchDiscordProfile({
    accessToken: ACCESS_TOKEN,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      assert.equal(url, "https://discord.com/api/users/@me");
      auth = String((init?.headers as any)?.Authorization);
      return new Response(JSON.stringify({ id: "80351110224678912", username: "nelly", global_name: "Nelly", email: "Nelly@Example.com", verified: true, avatar: null }), { status: 200 });
    }) as any,
  });
  assert.equal(auth, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(profile, { id: "80351110224678912", username: "nelly", globalName: "Nelly", email: "nelly@example.com" });

  const good = { id: "80351110224678912", username: "nelly", global_name: null, email: "n@example.com", verified: true };
  assert.equal(parseDiscordProfile(good).globalName, null);
  assert.throws(() => parseDiscordProfile({ ...good, verified: false }), (e: any) => e.code === "email_unverified");
  assert.throws(() => parseDiscordProfile({ ...good, verified: "true" }), (e: any) => e.code === "email_unverified", "verified 必须是布尔 true");
  assert.throws(() => parseDiscordProfile({ ...good, email: null }), (e: any) => e.code === "email_unverified", "没给 email 权限");
  assert.throws(() => parseDiscordProfile({ id: good.id, username: "x" }), (e: any) => e.code === "email_unverified");
  assert.throws(() => parseDiscordProfile({ ...good, id: 80351110224678912 }), (e: any) => e.code === "profile_invalid", "数字形式的 ID（丢精度）不认");
  assert.throws(() => parseDiscordProfile({ ...good, id: "abc" }), (e: any) => e.code === "profile_invalid");
  assert.throws(() => parseDiscordProfile({ ...good, id: "1".repeat(40) }), (e: any) => e.code === "profile_invalid");
  assert.throws(() => parseDiscordProfile({ ...good, username: "" }), (e: any) => e.code === "profile_invalid");
  assert.throws(() => parseDiscordProfile({ ...good, bot: true }), (e: any) => e.code === "profile_invalid");
  assert.throws(() => parseDiscordProfile({ ...good, email: "not an email" }), (e: any) => e.code === "profile_invalid");
  assert.throws(() => parseDiscordProfile(null), (e: any) => e.code === "profile_invalid");

  await rejectsWith(fetchDiscordProfile({ accessToken: "x", fetchImpl: (async () => new Response("{}", { status: 401 })) as any }), "exchange_failed", /http_401/);
});

test("吊销令牌：尽力而为，失败不抛", async () => {
  let body: URLSearchParams | null = null;
  assert.equal(await revokeDiscordToken({
    token: ACCESS_TOKEN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      assert.equal(url, "https://discord.com/api/oauth2/token/revoke");
      body = new URLSearchParams(String(init?.body));
      return new Response(null, { status: 200 });
    }) as any,
  }), true);
  assert.equal(body!.get("token"), ACCESS_TOKEN);
  assert.equal(body!.get("token_type_hint"), "access_token");
  assert.equal(await revokeDiscordToken({ token: "t", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: (async () => { throw new Error("down"); }) as any }), false);
});

test("PKCE challenge 与 verifier 对得上（S256）", () => {
  const store = new DiscordAuthStateStore();
  const created = store.create({ mode: "app", redirectPath: "/", userId: null, appFlowId: "f".repeat(24), binding: "d".repeat(43) });
  assert.equal(created.codeChallenge, crypto.createHash("sha256").update(created.entry.codeVerifier).digest("base64url"));
});
