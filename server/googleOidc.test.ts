import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildGoogleAuthorizationUrl,
  createPkcePair,
  exchangeGoogleAuthorizationCode,
  GoogleAuthStateStore,
  GoogleJwksCache,
  GoogleOidcError,
  jwksMaxAgeMs,
  sha256Base64Url,
  verifyGoogleIdToken,
} from "./googleOidc";

const CLIENT_ID = "1234567890-test.apps.googleusercontent.com";
const NOW = 1_800_000_000;

const signingKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwkOf(publicKey: crypto.KeyObject, kid: string) {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

function b64(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signToken(payload: Record<string, unknown>, options: { kid?: string; alg?: string; key?: crypto.KeyObject } = {}) {
  const header = b64({ alg: options.alg ?? "RS256", kid: options.kid ?? "k1", typ: "JWT" });
  const body = b64(payload);
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), options.key ?? signingKey.privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

function goodClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: "110169484474386276334",
    email: "Alice@Example.com",
    email_verified: true,
    name: "Alice",
    nonce: "nonce-abc",
    iat: NOW - 10,
    exp: NOW + 3600,
    ...overrides,
  };
}

function jwksFetch(keys: unknown[], calls: { count: number }, cacheControl = "public, max-age=19800") {
  return (async (url: string) => {
    calls.count += 1;
    assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
    return new Response(JSON.stringify({ keys }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": cacheControl } });
  }) as any;
}

function makeJwks(now = () => NOW * 1000) {
  const calls = { count: 0 };
  const jwks = new GoogleJwksCache({ fetchImpl: jwksFetch([jwkOf(signingKey.publicKey, "k1")], calls), now });
  return { jwks, calls };
}

async function rejectsWith(promise: Promise<unknown>, code: string, why?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GoogleOidcError, String(error));
    assert.equal(error.code, code);
    if (why) assert.match(error.message, why);
    return true;
  });
}

test("PKCE：verifier 43 个 base64url 字符，challenge 是它的 S256", () => {
  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pair.method, "S256");
  assert.equal(pair.challenge, crypto.createHash("sha256").update(pair.verifier).digest("base64url"));
  assert.notEqual(createPkcePair().verifier, pair.verifier);
});

test("state 只能用一次，要配对浏览器 cookie，10 分钟后过期", () => {
  let now = 1_000_000;
  const store = new GoogleAuthStateStore({ now: () => now });
  const binding = "b".repeat(43);
  const input = { mode: "login" as const, redirectPath: "/rules", userId: null, appFlowId: null, binding };

  const first = store.create(input);
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.entry.bindingHash, sha256Base64Url(binding));
  assert.equal(first.codeChallenge, sha256Base64Url(first.entry.codeVerifier));
  const consumed = store.consume(first.state, binding);
  assert.equal(consumed?.redirectPath, "/rules");
  assert.equal(store.consume(first.state, binding), null, "第二次用同一个 state 必须失败");

  // cookie 不对：拒绝，而且这个 state 也废了
  const second = store.create(input);
  assert.equal(store.consume(second.state, "x".repeat(43)), null);
  assert.equal(store.consume(second.state, binding), null);
  // 没有 cookie
  const third = store.create(input);
  assert.equal(store.consume(third.state, ""), null);

  // 过期
  const fourth = store.create(input);
  now += 10 * 60 * 1000;
  assert.equal(store.consume(fourth.state, binding), null);

  // 乱给的 state
  assert.equal(store.consume("short", binding), null);
  assert.equal(store.consume(undefined, binding), null);
  assert.equal(store.consume(["a"], binding), null);
});

test("state 表有上限，过期的会被清掉", () => {
  let now = 0;
  const store = new GoogleAuthStateStore({ now: () => now, maxEntries: 3 });
  const input = { mode: "login" as const, redirectPath: "/", userId: null, appFlowId: null, binding: "c".repeat(43) };
  const states = [store.create(input), store.create(input), store.create(input), store.create(input)].map((item) => item.state);
  assert.equal(store.size, 3);
  assert.equal(store.consume(states[0], "c".repeat(43)), null, "最早的被挤掉");
  now += 11 * 60 * 1000;
  store.create(input);
  assert.equal(store.size, 1);
});

test("授权地址带齐 openid 参数：PKCE S256、nonce、state、select_account", () => {
  const url = new URL(buildGoogleAuthorizationUrl({
    clientId: CLIENT_ID,
    redirectUri: "https://panel.example.com/api/auth/google/callback",
    state: "state-1",
    codeChallenge: "challenge-1",
    nonce: "nonce-1",
  }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), "https://panel.example.com/api/auth/google/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("nonce"), "nonce-1");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("prompt"), "select_account");
});

test("换票：带上 code_verifier 和 client_secret，只取回 id_token", async () => {
  let seen: { url: string; body: URLSearchParams } | null = null;
  const result = await exchangeGoogleAuthorizationCode({
    code: "auth-code",
    codeVerifier: "verifier-1",
    clientId: CLIENT_ID,
    clientSecret: "secret-1",
    redirectUri: "https://panel.example.com/api/auth/google/callback",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      seen = { url, body: new URLSearchParams(String(init?.body)) };
      return new Response(JSON.stringify({ id_token: "a.b.c", access_token: "ya29.secret", token_type: "Bearer" }), { status: 200 });
    }) as any,
  });
  assert.deepEqual(result, { idToken: "a.b.c" });
  assert.equal(seen!.url, "https://oauth2.googleapis.com/token");
  assert.equal(seen!.body.get("grant_type"), "authorization_code");
  assert.equal(seen!.body.get("code"), "auth-code");
  assert.equal(seen!.body.get("code_verifier"), "verifier-1");
  assert.equal(seen!.body.get("client_secret"), "secret-1");
  assert.equal(seen!.body.get("redirect_uri"), "https://panel.example.com/api/auth/google/callback");

  await rejectsWith(exchangeGoogleAuthorizationCode({
    code: "bad", codeVerifier: "v", clientId: CLIENT_ID, clientSecret: "s", redirectUri: "https://x/cb",
    fetchImpl: (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as any,
  }), "exchange_failed", /invalid_grant/);
  await rejectsWith(exchangeGoogleAuthorizationCode({
    code: "c", codeVerifier: "v", clientId: CLIENT_ID, clientSecret: "s", redirectUri: "https://x/cb",
    fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as any,
  }), "exchange_failed");
  await rejectsWith(exchangeGoogleAuthorizationCode({
    code: "c", codeVerifier: "v", clientId: CLIENT_ID, clientSecret: "s", redirectUri: "https://x/cb",
    fetchImpl: (async () => new Response(JSON.stringify({ access_token: "only" }), { status: 200 })) as any,
  }), "exchange_failed", /no id_token/);
});

test("ID Token：签名、iss、aud、时间、nonce 都对才放行", async () => {
  const { jwks, calls } = makeJwks();
  const claims = await verifyGoogleIdToken(signToken(goodClaims()), { clientId: CLIENT_ID, nonce: "nonce-abc", jwks, nowSeconds: NOW });
  assert.equal(claims.sub, "110169484474386276334");
  assert.equal(claims.email, "alice@example.com", "邮箱统一小写");
  assert.equal(claims.emailVerified, true);
  assert.equal(claims.name, "Alice");

  // 不带 https:// 的 iss 也是 Google 合法的写法；email_verified 是字符串 "true" 也认
  await verifyGoogleIdToken(signToken(goodClaims({ iss: "accounts.google.com", email_verified: "true" })), { clientId: CLIENT_ID, nonce: "nonce-abc", jwks, nowSeconds: NOW });
  // aud 是数组时要包含我们、且 azp 是我们
  await verifyGoogleIdToken(signToken(goodClaims({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID })), { clientId: CLIENT_ID, nonce: "nonce-abc", jwks, nowSeconds: NOW });
  // 时钟误差一分钟以内放过
  await verifyGoogleIdToken(signToken(goodClaims({ exp: NOW - 30, iat: NOW - 3000 })), { clientId: CLIENT_ID, nonce: "nonce-abc", jwks, nowSeconds: NOW });
  await verifyGoogleIdToken(signToken(goodClaims({ iat: NOW + 30 })), { clientId: CLIENT_ID, nonce: "nonce-abc", jwks, nowSeconds: NOW });
  assert.equal(calls.count, 1, "JWKS 只拉一次，之后走缓存");
});

test("ID Token：各种不对的情况都拒绝", async () => {
  const { jwks } = makeJwks();
  const verify = (token: string, nonce = "nonce-abc") => verifyGoogleIdToken(token, { clientId: CLIENT_ID, nonce, jwks, nowSeconds: NOW });

  await rejectsWith(verify(signToken(goodClaims({ aud: "someone-else.apps.googleusercontent.com" }))), "token_invalid", /aud/);
  await rejectsWith(verify(signToken(goodClaims({ aud: [CLIENT_ID, "x"], azp: "x" }))), "token_invalid", /aud/);
  await rejectsWith(verify(signToken(goodClaims({ azp: "another-client" }))), "token_invalid", /azp/);
  await rejectsWith(verify(signToken(goodClaims({ iss: "https://evil.example.com" }))), "token_invalid", /iss/);
  await rejectsWith(verify(signToken(goodClaims({ iss: "https://accounts.google.com.evil.com" }))), "token_invalid", /iss/);
  await rejectsWith(verify(signToken(goodClaims({ exp: NOW - 120 }))), "token_invalid", /expired/);
  await rejectsWith(verify(signToken(goodClaims({ exp: undefined }))), "token_invalid", /expired/);
  await rejectsWith(verify(signToken(goodClaims({ iat: NOW + 600 }))), "token_invalid", /iat/);
  await rejectsWith(verify(signToken(goodClaims()), "another-nonce"), "token_invalid", /nonce/);
  await rejectsWith(verify(signToken(goodClaims({ nonce: undefined }))), "token_invalid", /nonce/);
  await rejectsWith(verify(signToken(goodClaims({ email_verified: false }))), "email_unverified");
  await rejectsWith(verify(signToken(goodClaims({ email_verified: undefined }))), "email_unverified");
  await rejectsWith(verify(signToken(goodClaims({ sub: "" }))), "token_invalid", /sub/);
  await rejectsWith(verify(signToken(goodClaims({ email: undefined }))), "token_invalid", /email/);

  // 签名：别的钥匙签的、被改过内容的、算法不是 RS256 的
  await rejectsWith(verify(signToken(goodClaims(), { key: otherKey.privateKey })), "token_invalid", /signature/);
  const token = signToken(goodClaims());
  const [h, , s] = token.split(".");
  await rejectsWith(verify(`${h}.${b64(goodClaims({ sub: "attacker" }))}.${s}`), "token_invalid", /signature/);
  await rejectsWith(verify(`${b64({ alg: "none", kid: "k1" })}.${b64(goodClaims())}.`), "token_invalid", /malformed/);
  const hs = `${b64({ alg: "HS256", kid: "k1" })}.${b64(goodClaims())}`;
  await rejectsWith(verify(`${hs}.${crypto.createHmac("sha256", "x").update(hs).digest("base64url")}`), "token_invalid", /alg/);
  await rejectsWith(verify("not-a-jwt"), "token_invalid", /malformed/);
});

test("JWKS：不认识的 kid 强刷一次（一分钟最多一次），按 Cache-Control 过期", async () => {
  let now = NOW * 1000;
  const calls = { count: 0 };
  let keys = [jwkOf(signingKey.publicKey, "k1")];
  const jwks = new GoogleJwksCache({
    now: () => now,
    fetchImpl: (async () => {
      calls.count += 1;
      return new Response(JSON.stringify({ keys }), { status: 200, headers: { "Cache-Control": "public, max-age=600" } });
    }) as any,
  });
  await jwks.getKey("k1");
  assert.equal(calls.count, 1);

  // Google 换钥：新 kid 第一次出现时去拉一遍
  keys = [jwkOf(signingKey.publicKey, "k1"), jwkOf(otherKey.publicKey, "k2")];
  now += 61_000;
  await jwks.getKey("k2");
  assert.equal(calls.count, 2);

  // 乱给 kid 不能把 Google 刷爆：一分钟内不再拉
  await assert.rejects(jwks.getKey("nope"), /unknown signing key/);
  assert.equal(calls.count, 2);

  // 缓存过期后重拉
  now += 11 * 60 * 1000;
  await jwks.getKey("k1");
  assert.equal(calls.count, 3);

  assert.equal(jwksMaxAgeMs("public, max-age=19800, must-revalidate"), 19_800_000);
  assert.equal(jwksMaxAgeMs("max-age=1"), 5 * 60 * 1000, "太短的按 5 分钟");
  assert.equal(jwksMaxAgeMs("max-age=999999"), 24 * 60 * 60 * 1000, "太长的按 1 天");
  assert.equal(jwksMaxAgeMs(null), 60 * 60 * 1000);
});

test("JWKS 拉不到或没有能用的钥匙：当作令牌无效", async () => {
  const down = new GoogleJwksCache({ fetchImpl: (async () => new Response("oops", { status: 503 })) as any });
  await rejectsWith(down.getKey("k1"), "token_invalid", /jwks/);
  const empty = new GoogleJwksCache({ fetchImpl: (async () => new Response(JSON.stringify({ keys: [{ kid: "k", kty: "EC" }] }), { status: 200 })) as any });
  await rejectsWith(empty.getKey("k"), "token_invalid", /no usable keys/);
});
