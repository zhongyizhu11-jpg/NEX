import assert from "node:assert/strict";
import crypto from "node:crypto";
import dns from "node:dns";
import test from "node:test";
import {
  authorizationResponseIssuerOk,
  buildOidcAuthorizationUrl,
  chooseTokenEndpointAuthMethod,
  createOidcHttp,
  evaluateOidcEmail,
  exchangeOidcAuthorizationCode,
  fetchOidcDiscovery,
  fetchOidcUserInfo,
  mergeOidcUserInfo,
  needsUserInfo,
  OidcError,
  OidcProviderCache,
  oidcDiscoveryUrl,
  parseOidcDiscovery,
  verifyOidcIdToken,
  type OidcHttp,
  type OidcHttpResponse,
} from "./oidcClient";
import { createSafeLookup, SafeOutboundError } from "./ssrf";

/*
  通用 OIDC 协议层：discovery 校验（issuer 必须一字不差、坏 JSON、端点必须 https、内网地址要勾选才放行）、
  ID Token 验签（RS256 / ES256 都行；aud / iss / nonce / 过期 / alg none / 默认不认 HS256 / 不认识的 kid 强刷一次）、
  换票时客户端怎么认证、userinfo 补邮箱、邮箱必须存在且（默认）已验证。
  JWKS 和令牌都在测试里用 node:crypto 现场生成、现场签。
*/

const ISSUER = "https://id.example.com";
const CLIENT_ID = "nex-panel";
const NOW = 1_800_000_000;

const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaOther = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

function jwkOf(publicKey: crypto.KeyObject, kid: string, alg: string) {
  return { ...(publicKey.export({ format: "jwk" }) as Record<string, string>), kid, alg, use: "sig" };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function sign(payload: Record<string, unknown>, options: { alg?: string; kid?: string | null; key?: crypto.KeyObject; hmac?: string; header?: Record<string, unknown> } = {}) {
  const alg = options.alg ?? "RS256";
  const header: Record<string, unknown> = { alg, typ: "JWT", ...(options.header || {}) };
  if (options.kid !== null) header.kid = options.kid ?? (alg === "ES256" ? "ec1" : "rsa1");
  const input = `${b64(header)}.${b64(payload)}`;
  let signature: Buffer;
  if (alg.startsWith("HS")) signature = crypto.createHmac(`sha${alg.slice(2)}`, options.hmac ?? "secret").update(input).digest();
  else if (alg === "ES256") signature = crypto.sign("sha256", Buffer.from(input), { key: options.key ?? ec.privateKey, dsaEncoding: "ieee-p1363" });
  else signature = crypto.sign("RSA-SHA256", Buffer.from(input), options.key ?? rsa.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "2c1f6e0a-1111-4f5e-9c7b-abcdef012345",
    email: "Alice@Example.com",
    email_verified: true,
    name: "Alice",
    preferred_username: "alice",
    nonce: "nonce-abc",
    iat: NOW - 10,
    exp: NOW + 300,
    ...overrides,
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): OidcHttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body: Buffer.from(text) };
}

function discoveryDoc(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/api/oidc/token`,
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    userinfo_endpoint: `${ISSUER}/api/oidc/userinfo`,
    response_types_supported: ["code"],
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
    ...overrides,
  };
}

/** 一个假的 IdP：按 URL 回应，记下每次请求。 */
function fakeIdp(options: { keys?: unknown[]; discovery?: Record<string, unknown> } = {}) {
  const state = { keys: options.keys ?? [jwkOf(rsa.publicKey, "rsa1", "RS256"), jwkOf(ec.publicKey, "ec1", "ES256")], calls: [] as string[] };
  const http: OidcHttp = async (url) => {
    state.calls.push(url);
    if (url === oidcDiscoveryUrl(ISSUER)) return response(200, discoveryDoc(options.discovery));
    if (url === `${ISSUER}/.well-known/jwks.json`) return response(200, { keys: state.keys }, { "Cache-Control": "max-age=600" });
    return response(404, { error: "not_found" });
  };
  return { http, state };
}

async function rejectsWith(promise: Promise<unknown>, code: string, why?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof OidcError, String(error));
    assert.equal(error.code, code);
    if (why) assert.match(error.message, why);
    return true;
  });
}

function throwsWith(fn: () => unknown, code: string, why?: RegExp) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof OidcError, String(error));
    assert.equal(error.code, code);
    if (why) assert.match(error.message, why);
    return true;
  });
}

// ---------- discovery ----------

test("discovery：地址是 issuer + /.well-known/openid-configuration，端点照单收下", async () => {
  assert.equal(oidcDiscoveryUrl("https://id.example.com/"), "https://id.example.com/.well-known/openid-configuration");
  assert.equal(oidcDiscoveryUrl("https://sso.example.com/realms/main"), "https://sso.example.com/realms/main/.well-known/openid-configuration");
  const { http } = fakeIdp();
  const discovery = await fetchOidcDiscovery(ISSUER, { http, allowHttp: false });
  assert.equal(discovery.issuer, ISSUER);
  assert.equal(discovery.tokenEndpoint, `${ISSUER}/api/oidc/token`);
  assert.equal(discovery.userinfoEndpoint, `${ISSUER}/api/oidc/userinfo`);
  assert.deepEqual(discovery.codeChallengeMethods, ["S256"]);
});

test("discovery：issuer 必须和填的一字不差（差一个斜杠也不行，但提示怎么改）", () => {
  const text = JSON.stringify(discoveryDoc({ issuer: "https://evil.example.com" }));
  throwsWith(() => parseOidcDiscovery(text, ISSUER, { allowHttp: false }), "discovery_failed", /issuer 不一致/);
  const slash = JSON.stringify(discoveryDoc({ issuer: `${ISSUER}/` }));
  throwsWith(() => parseOidcDiscovery(slash, ISSUER, { allowHttp: false }), "discovery_failed", /末尾的斜杠/);
  throwsWith(() => parseOidcDiscovery(JSON.stringify(discoveryDoc({ issuer: undefined })), ISSUER, { allowHttp: false }), "discovery_failed", /缺少 issuer/);
});

test("discovery：坏 JSON、缺端点、端点不是 https、不支持授权码 都拒绝", () => {
  const parse = (text: string, allowHttp = false) => () => parseOidcDiscovery(text, ISSUER, { allowHttp });
  throwsWith(parse("<html>oops</html>"), "discovery_failed", /不是 JSON/);
  throwsWith(parse("[1,2,3]"), "discovery_failed", /不是 JSON/);
  throwsWith(parse(JSON.stringify(discoveryDoc({ token_endpoint: undefined }))), "discovery_failed", /token_endpoint/);
  throwsWith(parse(JSON.stringify(discoveryDoc({ jwks_uri: "not a url" }))), "discovery_failed", /jwks_uri/);
  throwsWith(parse(JSON.stringify(discoveryDoc({ token_endpoint: "http://id.example.com/token" }))), "discovery_failed", /https/);
  throwsWith(parse(JSON.stringify(discoveryDoc({ authorization_endpoint: "javascript:alert(1)" }))), "discovery_failed", /https/);
  throwsWith(parse(JSON.stringify(discoveryDoc({ token_endpoint: "https://u:p@id.example.com/token" }))), "discovery_failed", /账号密码/);
  throwsWith(parse(JSON.stringify(discoveryDoc({ response_types_supported: ["id_token"] }))), "discovery_failed", /授权码/);
  // 勾了「IdP 在内网」时 http 端点放行
  const lan = parseOidcDiscovery(JSON.stringify(discoveryDoc({ token_endpoint: "http://10.0.0.8:8080/token" })), ISSUER, { allowHttp: true });
  assert.equal(lan.tokenEndpoint, "http://10.0.0.8:8080/token");
});

test("discovery：拉取失败 / 跳转 / 非 200 都当作 discovery_failed", async () => {
  await rejectsWith(fetchOidcDiscovery(ISSUER, { http: async () => { throw new SafeOutboundError("x", "blocked"); }, allowHttp: false }), "discovery_failed", /内网/);
  await rejectsWith(fetchOidcDiscovery(ISSUER, { http: async () => response(302, ""), allowHttp: false }), "discovery_failed", /跳转/);
  await rejectsWith(fetchOidcDiscovery(ISSUER, { http: async () => response(500, ""), allowHttp: false }), "discovery_failed", /500/);
});

test("出站请求：默认不让连内网；勾了「IdP 在内网」才放行局域网地址，回环和元数据地址照样拦", async () => {
  // IP 字面量在连接前就挡下（不发任何网络请求）
  const strict = createOidcHttp({ allowPrivate: false });
  await assert.rejects(strict("https://192.168.1.10/.well-known/openid-configuration", { method: "GET", purpose: "测试" }), (error: any) => error?.code === "blocked");
  await rejectsWith(fetchOidcDiscovery("https://10.0.0.5", { http: strict, allowHttp: false }), "discovery_failed", /内网/);
  const lan = createOidcHttp({ allowPrivate: true });
  await assert.rejects(lan("https://127.0.0.1/x", { method: "GET", purpose: "测试" }), (error: any) => error?.code === "blocked", "回环永远不行");
  await assert.rejects(lan("http://169.254.169.254/latest/meta-data", { method: "GET", purpose: "测试" }), (error: any) => error?.code === "blocked", "云元数据地址永远不行");

  // 域名解析到内网：连接用的 lookup 当场检查
  const original = dns.lookup;
  (dns as any).lookup = (_host: string, _options: any, callback: any) => callback(null, [{ address: "192.168.1.10", family: 4 }]);
  try {
    const run = (options: Parameters<typeof createSafeLookup>[0], host: string) => new Promise<any>((resolve) => {
      createSafeLookup(options)(host, {}, (error, address) => resolve({ error, address }));
    });
    assert.equal((await run({}, "auth.example.com")).error?.code, "blocked", "默认：解析到内网就不连");
    assert.equal((await run({ allowPrivate: true, allowLanHostNames: true }, "auth.example.com")).address, "192.168.1.10");
    assert.equal((await run({ allowPrivate: true }, "pocket-id.home.local")).error?.code, "blocked", ".local 默认不放");
    assert.equal((await run({ allowPrivate: true, allowLanHostNames: true }, "pocket-id.home.local")).address, "192.168.1.10", "勾选后 .local 也放行");
    assert.equal((await run({ allowPrivate: true, allowLanHostNames: true }, "localhost")).error?.code, "blocked", "localhost 永远不放");
    assert.equal((await run({ allowPrivate: false, allowLanHostNames: true }, "x.internal")).error?.code, "blocked", "没勾内网时 allowLanHostNames 不起作用");
  } finally {
    (dns as any).lookup = original;
  }
});

test("discovery + JWKS 缓存：一小时内只拉一次 discovery；不认识的 kid 强刷 JWKS（一分钟最多一次）", async () => {
  let now = NOW * 1000;
  const { http, state } = fakeIdp({ keys: [jwkOf(rsa.publicKey, "rsa1", "RS256")] });
  const cache = new OidcProviderCache({ httpFor: () => http, now: () => now });
  const config = { issuer: ISSUER, allowPrivateNetwork: false };
  const first = await cache.get(config);
  await cache.get(config);
  assert.equal(state.calls.filter((url) => url.endsWith("openid-configuration")).length, 1);

  await first.jwks.getKey("rsa1", "RS256");
  const jwksCalls = () => state.calls.filter((url) => url.endsWith("jwks.json")).length;
  assert.equal(jwksCalls(), 1);
  // IdP 换钥：新 kid 第一次出现时去拉一遍
  state.keys = [jwkOf(rsa.publicKey, "rsa1", "RS256"), jwkOf(rsaOther.publicKey, "rsa2", "RS256")];
  now += 61_000;
  await first.jwks.getKey("rsa2", "RS256");
  assert.equal(jwksCalls(), 2);
  // 乱给 kid 刷不爆 IdP
  await rejectsWith(first.jwks.getKey("nope", "RS256"), "token_invalid", /unknown signing key/);
  assert.equal(jwksCalls(), 2);

  // discovery 过期后重拉；jwks_uri 没变就沿用公钥缓存
  now += 61 * 60 * 1000;
  const second = await cache.get(config);
  assert.equal(state.calls.filter((url) => url.endsWith("openid-configuration")).length, 2);
  assert.equal(second.jwks, first.jwks);
  cache.clear();
  await cache.get(config);
  assert.equal(state.calls.filter((url) => url.endsWith("openid-configuration")).length, 3);
});

// ---------- 授权地址 / 回调 iss ----------

test("授权地址带齐参数（PKCE S256、nonce、state、scope），保留授权端点自带的查询参数", () => {
  const url = new URL(buildOidcAuthorizationUrl({
    authorizationEndpoint: `${ISSUER}/authorize?tenant=main`,
    clientId: CLIENT_ID,
    redirectUri: "https://panel.example.com/api/auth/oidc/callback",
    scopes: ["openid", "email", "profile", "groups"],
    state: "state-1",
    codeChallenge: "challenge-1",
    nonce: "nonce-1",
  }));
  assert.equal(url.searchParams.get("tenant"), "main");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile groups");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(url.searchParams.get("nonce"), "nonce-1");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("redirect_uri"), "https://panel.example.com/api/auth/oidc/callback");
});

test("回调的 iss 参数（RFC 9207）：带了必须是我们的；声明了会带却没带也不认", () => {
  const plain = { issuer: ISSUER, authorizationResponseIssParameterSupported: false };
  const strict = { issuer: ISSUER, authorizationResponseIssParameterSupported: true };
  assert.equal(authorizationResponseIssuerOk(undefined, plain), true);
  assert.equal(authorizationResponseIssuerOk(ISSUER, plain), true);
  assert.equal(authorizationResponseIssuerOk("https://evil.example.com", plain), false);
  assert.equal(authorizationResponseIssuerOk(["a"], plain), false);
  assert.equal(authorizationResponseIssuerOk(undefined, strict), false);
  assert.equal(authorizationResponseIssuerOk(ISSUER, strict), true);
});

// ---------- 换票 ----------

test("换票：有密钥默认用 client_secret_basic，只支持 post 时放表单；没有密钥是公开客户端", async () => {
  assert.equal(chooseTokenEndpointAuthMethod([], true), "client_secret_basic");
  assert.equal(chooseTokenEndpointAuthMethod(["client_secret_post"], true), "client_secret_post");
  assert.equal(chooseTokenEndpointAuthMethod(["client_secret_post", "client_secret_basic"], true), "client_secret_basic");
  assert.equal(chooseTokenEndpointAuthMethod(["client_secret_basic"], false), "none");

  const seen: Array<{ headers: Record<string, string>; body: URLSearchParams }> = [];
  const http: OidcHttp = async (_url, init) => {
    seen.push({ headers: init.headers || {}, body: new URLSearchParams(init.body) });
    return response(200, { id_token: "a.b.c", access_token: "at-1", token_type: "Bearer" });
  };
  const base = { http, tokenEndpoint: `${ISSUER}/token`, code: "code-1", codeVerifier: "verifier-1", clientId: "my client", redirectUri: "https://p/cb" };
  assert.deepEqual(await exchangeOidcAuthorizationCode({ ...base, authMethods: [], clientSecret: "s3cr:t+" }), { idToken: "a.b.c", accessToken: "at-1" });
  assert.equal(seen[0].headers.Authorization, `Basic ${Buffer.from("my+client:s3cr%3At%2B").toString("base64")}`, "Basic 认证前先做表单编码");
  assert.equal(seen[0].body.get("client_secret"), null);
  assert.equal(seen[0].body.get("code_verifier"), "verifier-1");
  assert.equal(seen[0].body.get("grant_type"), "authorization_code");
  await exchangeOidcAuthorizationCode({ ...base, authMethods: ["client_secret_post"], clientSecret: "s" });
  assert.equal(seen[1].body.get("client_secret"), "s");
  assert.equal(seen[1].headers.Authorization, undefined);
  await exchangeOidcAuthorizationCode({ ...base, authMethods: [], clientSecret: "" });
  assert.equal(seen[2].body.get("client_id"), "my client");
  assert.equal(seen[2].body.get("client_secret"), null);

  await rejectsWith(exchangeOidcAuthorizationCode({ ...base, authMethods: [], clientSecret: "s", http: async () => response(400, { error: "invalid_grant<script>" }) }), "exchange_failed", /invalid_grantscript/);
  await rejectsWith(exchangeOidcAuthorizationCode({ ...base, authMethods: [], clientSecret: "s", http: async () => response(200, { access_token: "x" }) }), "exchange_failed", /no id_token/);
  await rejectsWith(exchangeOidcAuthorizationCode({ ...base, authMethods: [], clientSecret: "s", http: async () => { throw new Error("boom"); } }), "exchange_failed");
});

// ---------- ID Token ----------

function verifier(overrides: Partial<Parameters<typeof verifyOidcIdToken>[1]> = {}) {
  const cache = new OidcProviderCache({ httpFor: () => fakeIdp().http, now: () => NOW * 1000 });
  return async (token: string, extra: Partial<Parameters<typeof verifyOidcIdToken>[1]> = {}) => {
    const { jwks } = await cache.get({ issuer: ISSUER, allowPrivateNetwork: false });
    return verifyOidcIdToken(token, {
      issuer: ISSUER, clientId: CLIENT_ID, nonce: "nonce-abc", keys: jwks, allowHmac: false, clientSecret: "", nowSeconds: NOW,
      ...overrides, ...extra,
    });
  };
}

test("ID Token：RS256 和 ES256 签的都认，邮箱统一小写", async () => {
  const verify = verifier();
  const rs = await verify(sign(claims()));
  assert.equal(rs.sub, "2c1f6e0a-1111-4f5e-9c7b-abcdef012345");
  assert.equal(rs.email, "alice@example.com");
  assert.equal(rs.emailVerified, true);
  assert.equal(rs.preferredUsername, "alice");
  const es = await verify(sign(claims(), { alg: "ES256" }));
  assert.equal(es.sub, rs.sub);
  // aud 是数组时要包含我们、且 azp 是我们；时钟误差一分钟以内放过
  await verify(sign(claims({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID })));
  await verify(sign(claims({ exp: NOW - 30 })));
  // 没有 kid 时，同算法的钥匙恰好一把就用它
  await verify(sign(claims(), { alg: "ES256", kid: null }));
  await verify(sign(claims(), { kid: null }));
});

test("ID Token：aud / iss / nonce / 过期 / nbf / sub 不对都拒绝", async () => {
  const verify = verifier();
  await rejectsWith(verify(sign(claims({ aud: "someone-else" }))), "token_invalid", /aud/);
  await rejectsWith(verify(sign(claims({ aud: [CLIENT_ID, "x"], azp: "x" }))), "token_invalid", /aud/);
  await rejectsWith(verify(sign(claims({ azp: "another" }))), "token_invalid", /azp/);
  await rejectsWith(verify(sign(claims({ iss: "https://evil.example.com" }))), "token_invalid", /iss/);
  await rejectsWith(verify(sign(claims({ iss: `${ISSUER}/` }))), "token_invalid", /iss/);
  await rejectsWith(verify(sign(claims(), { alg: "ES256" }), { issuer: "https://other.example.com" }), "token_invalid", /iss/);
  await rejectsWith(verify(sign(claims({ exp: NOW - 120 }))), "token_invalid", /expired/);
  await rejectsWith(verify(sign(claims({ exp: undefined }))), "token_invalid", /expired/);
  await rejectsWith(verify(sign(claims({ iat: NOW + 600 }))), "token_invalid", /iat/);
  await rejectsWith(verify(sign(claims({ nbf: NOW + 600 }))), "token_invalid", /nbf/);
  await rejectsWith(verify(sign(claims()), { nonce: "another-nonce" }), "token_invalid", /nonce/);
  await rejectsWith(verify(sign(claims({ nonce: undefined }))), "token_invalid", /nonce/);
  await rejectsWith(verify(sign(claims({ sub: "" }))), "token_invalid", /sub/);
  await rejectsWith(verify(sign(claims({ sub: "x".repeat(192) }))), "token_invalid", /sub/);
  await rejectsWith(verify(sign(claims(), { header: { crit: ["exp"] } })), "token_invalid", /crit/);
  await rejectsWith(verify(sign(claims(), { header: { typ: "at+jwt" } })), "token_invalid", /typ/);
  // 邮箱缺 / 格式不对不在这里拒：可能还要用 userinfo 补
  const noEmail = await verify(sign(claims({ email: undefined, email_verified: undefined })));
  assert.equal(noEmail.email, null);
  assert.equal(noEmail.emailVerified, null);
});

test("ID Token：签名不对、alg none、默认不认 HS256；勾选后才用客户端密钥验 HS256", async () => {
  const verify = verifier();
  await rejectsWith(verify(sign(claims(), { key: rsaOther.privateKey })), "token_invalid", /signature/);
  const token = sign(claims());
  const [h, , s] = token.split(".");
  await rejectsWith(verify(`${h}.${b64(claims({ sub: "attacker" }))}.${s}`), "token_invalid", /signature/);
  // ES256 的头配 RSA 签名 / RS256 的头配 EC 的 kid
  await rejectsWith(verify(sign(claims(), { alg: "ES256", kid: "rsa1" })), "token_invalid", /unknown signing key/);
  await rejectsWith(verify(`${b64({ alg: "none", typ: "JWT" })}.${b64(claims())}.`), "token_invalid", /malformed/);
  await rejectsWith(verify(`${b64({ alg: "none", typ: "JWT" })}.${b64(claims())}.AAAA`), "token_invalid", /alg/);
  await rejectsWith(verify(`${b64({ alg: "RS512", kid: "rsa1" })}.${b64(claims())}.AAAA`), "token_invalid", /alg/);

  const hs = sign(claims(), { alg: "HS256", hmac: "client-secret", kid: null });
  // 没勾选：有密钥也不认；勾选了但没有密钥：也不认
  await rejectsWith(verify(hs, { clientSecret: "client-secret" }), "token_invalid", /alg/);
  await rejectsWith(verify(hs, { allowHmac: true, clientSecret: "" }), "token_invalid", /alg/);
  assert.equal((await verify(hs, { allowHmac: true, clientSecret: "client-secret" })).sub, claims().sub);
  await rejectsWith(verify(hs, { allowHmac: true, clientSecret: "wrong" }), "token_invalid", /signature/);
  // 算法混淆：拿 RSA 公钥（PEM）当 HMAC 钥匙签的令牌，哪怕勾选了 HS256 也不过（钥匙只能是客户端密钥）
  const pem = rsa.publicKey.export({ format: "pem", type: "spki" }).toString();
  await rejectsWith(verify(sign(claims(), { alg: "HS256", hmac: pem, kid: "rsa1" }), { allowHmac: true, clientSecret: "client-secret" }), "token_invalid", /signature/);
});

test("ID Token：不认识的 kid 先强刷一次 JWKS，刷完还没有才拒绝", async () => {
  let now = NOW * 1000;
  const idp = fakeIdp({ keys: [jwkOf(rsa.publicKey, "rsa1", "RS256")] });
  const cache = new OidcProviderCache({ httpFor: () => idp.http, now: () => now });
  const { jwks } = await cache.get({ issuer: ISSUER, allowPrivateNetwork: false });
  const verify = (token: string) => verifyOidcIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, nonce: "nonce-abc", keys: jwks, allowHmac: false, clientSecret: "", nowSeconds: NOW });
  await verify(sign(claims()));
  // IdP 轮换到新钥匙 rsa2
  idp.state.keys = [jwkOf(rsaOther.publicKey, "rsa2", "RS256")];
  now += 2 * 60 * 1000;
  const rotated = await verify(sign(claims(), { kid: "rsa2", key: rsaOther.privateKey }));
  assert.equal(rotated.sub, claims().sub);
  assert.equal(idp.state.calls.filter((url) => url.endsWith("jwks.json")).length, 2, "强刷了一次");
  await rejectsWith(verify(sign(claims(), { kid: "rsa3", key: rsaOther.privateKey })), "token_invalid", /unknown signing key/);
  assert.equal(idp.state.calls.filter((url) => url.endsWith("jwks.json")).length, 2, "一分钟内不再刷");
});

// ---------- userinfo / 邮箱 ----------

test("userinfo：sub 必须一致；ID Token 缺邮箱时用 userinfo 的，ID Token 有的优先", async () => {
  const base = { sub: "u1", email: null, emailVerified: null, name: null, preferredUsername: null, iat: NOW, exp: NOW + 60 };
  assert.equal(needsUserInfo(base), true);
  assert.equal(needsUserInfo({ ...base, email: "a@x.io", emailVerified: true }), false);
  throwsWith(() => mergeOidcUserInfo(base, { sub: "someone-else", email: "a@x.io" }), "token_invalid", /sub/);
  const merged = mergeOidcUserInfo(base, { sub: "u1", email: "A@X.io", email_verified: true, name: "A", preferred_username: "a" });
  assert.deepEqual([merged.email, merged.emailVerified, merged.name, merged.preferredUsername], ["a@x.io", true, "A", "a"]);
  // ID Token 已经有邮箱：userinfo 换不掉它；邮箱一样时才补 email_verified
  const kept = mergeOidcUserInfo({ ...base, email: "a@x.io" }, { sub: "u1", email: "b@x.io", email_verified: true });
  assert.deepEqual([kept.email, kept.emailVerified], ["a@x.io", null]);
  const filled = mergeOidcUserInfo({ ...base, email: "a@x.io" }, { sub: "u1", email: "a@x.io", email_verified: "true" });
  assert.equal(filled.emailVerified, true);

  let seenAuth = "";
  const info = await fetchOidcUserInfo({
    http: async (_url, init) => { seenAuth = init.headers?.Authorization || ""; return response(200, { sub: "u1" }); },
    endpoint: `${ISSUER}/userinfo`, accessToken: "at-1",
  });
  assert.equal(info.sub, "u1");
  assert.equal(seenAuth, "Bearer at-1");
  await rejectsWith(fetchOidcUserInfo({ http: async () => response(200, "a.b.c", { "Content-Type": "application/jwt" }), endpoint: "https://x/u", accessToken: "t" }), "exchange_failed", /JWT/);
  await rejectsWith(fetchOidcUserInfo({ http: async () => response(401, {}), endpoint: "https://x/u", accessToken: "t" }), "exchange_failed", /401/);
});

test("邮箱：必须有；默认只认 email_verified 明确为 true（没说也不算），关掉后未验证也放行", () => {
  throwsWith(() => evaluateOidcEmail({ email: null, emailVerified: true }, { requireVerifiedEmail: true }), "email_missing");
  throwsWith(() => evaluateOidcEmail({ email: null, emailVerified: null }, { requireVerifiedEmail: false }), "email_missing");
  throwsWith(() => evaluateOidcEmail({ email: "a@x.io", emailVerified: false }, { requireVerifiedEmail: true }), "email_unverified");
  throwsWith(() => evaluateOidcEmail({ email: "a@x.io", emailVerified: null }, { requireVerifiedEmail: true }), "email_unverified");
  assert.deepEqual(evaluateOidcEmail({ email: "a@x.io", emailVerified: true }, { requireVerifiedEmail: true }), { email: "a@x.io", emailVerified: true });
  assert.deepEqual(evaluateOidcEmail({ email: "a@x.io", emailVerified: null }, { requireVerifiedEmail: false }), { email: "a@x.io", emailVerified: false });
});
