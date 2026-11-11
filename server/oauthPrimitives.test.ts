import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  createPkcePair,
  importJwks,
  OAuthStateStore,
  parseCompactJws,
  sha256Base64Url,
  timingSafeEqualText,
  verifyJwsSignature,
} from "./oauthPrimitives";

/*
  Google 和通用 OIDC 共用的协议零件：state 一次性 + 绑浏览器 cookie + 过期、PKCE S256、
  JWS 拆段、按 alg 核对钥匙类型（防算法混淆）、JWK 只收能用的签名公钥。
*/

test("state（OIDC 模式）：一次性、要配对浏览器 cookie、过期作废，nonce / verifier 每次都不同", () => {
  let now = 5_000_000;
  const store = new OAuthStateStore<"login" | "link">({ now: () => now });
  const binding = "b".repeat(43);
  const input = { mode: "link" as const, redirectPath: "/profile", userId: 7, appFlowId: null, binding, configHash: "cfg" };
  const first = store.create(input);
  const second = store.create(input);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.entry.codeVerifier, second.entry.codeVerifier);
  assert.equal(first.codeChallenge, sha256Base64Url(first.entry.codeVerifier), "challenge = S256(verifier)");
  assert.equal(first.entry.bindingHash, sha256Base64Url(binding), "只存 cookie 的哈希");

  const consumed = store.consume(first.state, binding);
  assert.equal(consumed?.userId, 7);
  assert.equal(consumed?.configHash, "cfg");
  assert.equal(store.consume(first.state, binding), null, "第二次用同一个 state 必须失败");
  assert.equal(store.consume(second.state, "x".repeat(43)), null, "cookie 不对");
  assert.equal(store.consume(second.state, binding), null, "cookie 不对之后这个 state 也废了");

  const third = store.create(input);
  now += 10 * 60 * 1000;
  assert.equal(store.consume(third.state, binding), null, "10 分钟过期");
  assert.equal(store.consume(undefined, binding), null);
  assert.equal(store.consume("x".repeat(500), binding), null);
});

test("PKCE：verifier 43 个 base64url 字符，challenge 是它的 S256", () => {
  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pair.challenge, crypto.createHash("sha256").update(pair.verifier).digest("base64url"));
  assert.equal(timingSafeEqualText("abc", "abc"), true);
  assert.equal(timingSafeEqualText("abc", "abd"), false);
  assert.equal(timingSafeEqualText("abc", "abcd"), false);
});

test("JWS：三段都要有；alg 和钥匙类型对不上一律不过", () => {
  assert.equal(parseCompactJws("a.b"), null);
  assert.equal(parseCompactJws("a.b."), null, "空签名（alg none）在拆段时就不要");
  assert.equal(parseCompactJws("a+b.c.d"), null);
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const input = Buffer.from("header.payload");
  const rsSig = crypto.sign("RSA-SHA256", input, rsa.privateKey);
  const esSig = crypto.sign("sha256", input, { key: ec.privateKey, dsaEncoding: "ieee-p1363" });
  assert.equal(verifyJwsSignature("RS256", rsa.publicKey, input, rsSig), true);
  assert.equal(verifyJwsSignature("ES256", ec.publicKey, input, esSig), true);
  assert.equal(verifyJwsSignature("ES256", rsa.publicKey, input, rsSig), false, "ES256 不能配 RSA 钥匙");
  assert.equal(verifyJwsSignature("RS256", ec.publicKey, input, esSig), false, "RS256 不能配 EC 钥匙");
  assert.equal(verifyJwsSignature("ES256", ec.publicKey, input, crypto.sign("sha256", input, ec.privateKey)), false, "DER 编码的 ECDSA 签名不是 JWS 格式");
  assert.equal(verifyJwsSignature("HS256", rsa.publicKey, input, rsSig), false, "HS256 绝不拿公钥当密钥");
  assert.equal(verifyJwsSignature("none", rsa.publicKey, input, Buffer.alloc(0)), false);
  const mac = crypto.createHmac("sha256", "k").update(input).digest();
  assert.equal(verifyJwsSignature("HS256", { hmacSecret: "k" }, input, mac), true);
  assert.equal(verifyJwsSignature("HS256", { hmacSecret: "" }, input, crypto.createHmac("sha256", "").update(input).digest()), false, "空密钥不算");
  assert.equal(verifyJwsSignature("RS256", { hmacSecret: "k" }, input, mac), false);
  // 太短的 RSA 钥匙不要
  const weak = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  assert.equal(verifyJwsSignature("RS256", weak.publicKey, input, crypto.sign("RSA-SHA256", input, weak.privateKey)), false);
});

test("JWKS 导入：只收 RS256 / ES256 的签名公钥，按 allowedAlgs 过滤，坏钥匙跳过", () => {
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" });
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  const p384 = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({ format: "jwk" });
  const keys = [
    { ...rsa, kid: "r" },
    { ...ec, kid: "e" },
    { ...p384, kid: "p384" },
    { kty: "oct", k: "c2VjcmV0", kid: "sym" },
    { ...rsa, kid: "enc", use: "enc" },
    { ...rsa, kid: "wrongalg", alg: "ES256" },
    { kty: "RSA", n: "!!", e: "AQAB", kid: "broken" },
  ];
  assert.deepEqual(importJwks({ keys }, ["RS256", "ES256"]).map((item) => `${item.kid}:${item.alg}`), ["r:RS256", "e:ES256"]);
  assert.deepEqual(importJwks({ keys }, ["RS256"]).map((item) => item.kid), ["r"]);
  assert.deepEqual(importJwks(null, ["RS256"]), []);
});
