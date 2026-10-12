import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  base64urlEncode,
  decodeCbor,
  decodeCborItem,
  parseAuthenticatorData,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  WebAuthnError,
} from "./webauthn";
import { resolveRelyingParty } from "./passkeys";

// ---------- 测试用的最小 CBOR 编码器 ----------

function head(major: number, length: number) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(length, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(length, 1); return b;
}

function cbor(value: unknown): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") { const bytes = Buffer.from(value, "utf8"); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === false) return Buffer.from([0xf4]);
  if (value === null) return Buffer.from([0xf6]);
  throw new Error("unsupported");
}

const RP_ID = "panel.example.com";
const ORIGIN = "https://panel.example.com";

function sha256(data: Buffer | string) {
  return crypto.createHash("sha256").update(data).digest();
}

function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as crypto.JsonWebKey;
  const cose = new Map<number, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x!, "base64url")],
    [-3, Buffer.from(jwk.y!, "base64url")],
  ]);
  return { privateKey, cose };
}

function authData(opts: { rpId?: string; flags: number; signCount: number; credentialId?: Buffer; cose?: Map<number, unknown> }) {
  const parts: Buffer[] = [sha256(opts.rpId ?? RP_ID), Buffer.from([opts.flags]), Buffer.alloc(4)];
  parts[2].writeUInt32BE(opts.signCount, 0);
  if (opts.credentialId && opts.cose) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(opts.credentialId.length, 0);
    parts.push(Buffer.alloc(16), len, opts.credentialId, cbor(opts.cose));
  }
  return Buffer.concat(parts);
}

function clientData(type: string, challenge: string, origin = ORIGIN) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

function registration(challenge: string, overrides: { origin?: string; rpId?: string; type?: string; flags?: number } = {}) {
  const key = makeKey();
  const credentialId = crypto.randomBytes(32);
  const data = authData({ rpId: overrides.rpId, flags: overrides.flags ?? 0x45, signCount: 0, credentialId, cose: key.cose });
  const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", data]]));
  return {
    key,
    response: {
      id: base64urlEncode(credentialId),
      rawId: base64urlEncode(credentialId),
      type: "public-key",
      response: {
        clientDataJSON: base64urlEncode(clientData(overrides.type ?? "webauthn.create", challenge, overrides.origin)),
        attestationObject: base64urlEncode(attestationObject),
      },
    },
  };
}

function assertion(privateKey: crypto.KeyObject, credentialId: string, challenge: string, signCount: number, overrides: { origin?: string } = {}) {
  const data = authData({ flags: 0x05, signCount });
  const cdj = clientData("webauthn.get", challenge, overrides.origin);
  const signature = crypto.sign("sha256", Buffer.concat([data, sha256(cdj)]), { key: privateKey, dsaEncoding: "der" });
  return {
    id: credentialId,
    type: "public-key",
    response: {
      clientDataJSON: base64urlEncode(cdj),
      authenticatorData: base64urlEncode(data),
      signature: base64urlEncode(signature),
      userHandle: null,
    },
  };
}

// ---------- CBOR ----------

test("CBOR 解码整数、负数、文本、字节、数组、映射和简单值", () => {
  assert.equal(decodeCbor(Buffer.from([0x17])), 23);
  assert.equal(decodeCbor(Buffer.from([0x18, 0xff])), 255);
  assert.equal(decodeCbor(Buffer.from([0x19, 0x01, 0x00])), 256);
  assert.equal(decodeCbor(Buffer.from([0x20])), -1);
  assert.equal(decodeCbor(Buffer.from([0x39, 0x01, 0x00])), -257);
  assert.equal(decodeCbor(Buffer.from([0x63, 0x61, 0x62, 0x63])), "abc");
  assert.deepEqual(decodeCbor(Buffer.from([0x42, 0x01, 0x02])), Buffer.from([1, 2]));
  assert.deepEqual(decodeCbor(Buffer.from([0x83, 0x01, 0x02, 0x03])), [1, 2, 3]);
  assert.equal(decodeCbor(Buffer.from([0xf5])), true);
  assert.equal(decodeCbor(Buffer.from([0xf6])), null);
  assert.equal(decodeCbor(Buffer.from([0xf9, 0x3c, 0x00])), 1); // half float 1.0
  const map = decodeCbor(cbor(new Map<unknown, unknown>([[1, 2], [-1, "x"], ["fmt", "none"]])));
  assert.ok(map instanceof Map);
  assert.equal(map.get(1), 2);
  assert.equal(map.get(-1), "x");
  assert.equal(map.get("fmt"), "none");
});

test("CBOR 不定长数组 / 字节串，以及截断和多余字节报错", () => {
  assert.deepEqual(decodeCbor(Buffer.from([0x9f, 0x01, 0x02, 0xff])), [1, 2]);
  assert.deepEqual(decodeCbor(Buffer.from([0x5f, 0x41, 0x01, 0x41, 0x02, 0xff])), Buffer.from([1, 2]));
  assert.throws(() => decodeCbor(Buffer.from([0x63, 0x61])), WebAuthnError);
  assert.throws(() => decodeCbor(Buffer.from([0x01, 0x02])), WebAuthnError);
  const item = decodeCborItem(Buffer.from([0x01, 0x02]), 0);
  assert.deepEqual(item, { value: 1, end: 1 });
});

// ---------- authenticatorData ----------

test("authenticatorData 解析出 rpIdHash、标志、计数和凭据公钥", () => {
  const key = makeKey();
  const credentialId = Buffer.from("credential-id-bytes");
  const parsed = parseAuthenticatorData(authData({ flags: 0x45, signCount: 7, credentialId, cose: key.cose }));
  assert.deepEqual(parsed.rpIdHash, sha256(RP_ID));
  assert.equal(parsed.userPresent, true);
  assert.equal(parsed.userVerified, true);
  assert.equal(parsed.signCount, 7);
  assert.deepEqual(parsed.attestedCredential?.credentialId, credentialId);
  assert.equal(parsed.attestedCredential?.publicKey.get(3), -7);

  const bare = parseAuthenticatorData(authData({ flags: 0x01, signCount: 3 }));
  assert.equal(bare.attestedCredential, undefined);
  assert.equal(bare.userVerified, false);
  assert.throws(() => parseAuthenticatorData(Buffer.alloc(20)), WebAuthnError);
});

// ---------- 注册 + 登录（ES256） ----------

test("ES256：注册后用同一把私钥签名能登录，计数递增", () => {
  const challenge = base64urlEncode(crypto.randomBytes(32));
  const { key, response } = registration(challenge);
  const stored = verifyRegistrationResponse(response, { challenge, origin: ORIGIN, rpId: RP_ID });
  assert.equal(stored.alg, -7);
  assert.equal(stored.credentialId, response.id);
  assert.equal(stored.signCount, 0);

  const loginChallenge = base64urlEncode(crypto.randomBytes(32));
  const result = verifyAuthenticationResponse(
    assertion(key.privateKey, stored.credentialId, loginChallenge, 1),
    { challenge: loginChallenge, origin: ORIGIN, rpId: RP_ID },
    { publicKey: stored.publicKey, alg: stored.alg, signCount: 0 },
  );
  assert.equal(result.signCount, 1);

  // 计数回退（可能被克隆）拒绝；两边都是 0 放行。
  assert.throws(() => verifyAuthenticationResponse(
    assertion(key.privateKey, stored.credentialId, loginChallenge, 1),
    { challenge: loginChallenge, origin: ORIGIN, rpId: RP_ID },
    { publicKey: stored.publicKey, alg: stored.alg, signCount: 5 },
  ), /计数/);
  assert.doesNotThrow(() => verifyAuthenticationResponse(
    assertion(key.privateKey, stored.credentialId, loginChallenge, 0),
    { challenge: loginChallenge, origin: ORIGIN, rpId: RP_ID },
    { publicKey: stored.publicKey, alg: stored.alg, signCount: 0 },
  ));
});

test("别的私钥签的、挑战不对的、来源不对的都拒绝", () => {
  const challenge = base64urlEncode(crypto.randomBytes(32));
  const { response } = registration(challenge);
  const stored = verifyRegistrationResponse(response, { challenge, origin: ORIGIN, rpId: RP_ID });
  const other = makeKey();
  const loginChallenge = base64urlEncode(crypto.randomBytes(32));
  const expected = { challenge: loginChallenge, origin: ORIGIN, rpId: RP_ID };
  const credential = { publicKey: stored.publicKey, alg: stored.alg, signCount: 0 };

  assert.throws(() => verifyAuthenticationResponse(assertion(other.privateKey, stored.credentialId, loginChallenge, 1), expected, credential), /签名/);
  assert.throws(() => verifyAuthenticationResponse(assertion(other.privateKey, stored.credentialId, "wrong", 1), expected, credential), /挑战/);
  assert.throws(() => verifyAuthenticationResponse(assertion(other.privateKey, stored.credentialId, loginChallenge, 1, { origin: "https://evil.example" }), expected, credential), /来源/);
});

test("注册时挑战、来源、类型、RP ID、用户在场标志不对都拒绝", () => {
  const challenge = base64urlEncode(crypto.randomBytes(32));
  const expected = { challenge, origin: ORIGIN, rpId: RP_ID };
  assert.throws(() => verifyRegistrationResponse(registration("other-challenge").response, expected), /挑战/);
  assert.throws(() => verifyRegistrationResponse(registration(challenge, { origin: "https://evil.example" }).response, expected), /来源/);
  assert.throws(() => verifyRegistrationResponse(registration(challenge, { type: "webauthn.get" }).response, expected), /类型/);
  assert.throws(() => verifyRegistrationResponse(registration(challenge, { rpId: "evil.example" }).response, expected), /域名/);
  assert.throws(() => verifyRegistrationResponse(registration(challenge, { flags: 0x44 }).response, expected), /在场/);
  assert.throws(() => verifyRegistrationResponse(registration(challenge, { flags: 0x41 }).response, { ...expected, requireUserVerification: true }), /验证用户/);
});

test("Ed25519 注册和登录", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as crypto.JsonWebKey;
  const cose = new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x!, "base64url")]]);
  const challenge = base64urlEncode(crypto.randomBytes(32));
  const credentialId = crypto.randomBytes(16);
  const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData({ flags: 0x41, signCount: 0, credentialId, cose })]]));
  const stored = verifyRegistrationResponse({
    id: base64urlEncode(credentialId),
    response: { clientDataJSON: base64urlEncode(clientData("webauthn.create", challenge)), attestationObject: base64urlEncode(attestationObject) },
  }, { challenge, origin: ORIGIN, rpId: RP_ID });
  assert.equal(stored.alg, -8);
  const data = authData({ flags: 0x01, signCount: 0 });
  const cdj = clientData("webauthn.get", challenge);
  const signature = crypto.sign(null, Buffer.concat([data, sha256(cdj)]), privateKey);
  assert.doesNotThrow(() => verifyAuthenticationResponse({
    id: stored.credentialId,
    response: { clientDataJSON: base64urlEncode(cdj), authenticatorData: base64urlEncode(data), signature: base64urlEncode(signature) },
  }, { challenge, origin: ORIGIN, rpId: RP_ID }, stored));
});

// ---------- RP ----------

test("RP ID 取浏览器所在域名，且必须是面板自己的地址", () => {
  assert.deepEqual(resolveRelyingParty("https://panel.example.com", ["panel.example.com"]), { origin: ORIGIN, rpId: RP_ID });
  // 反代改了 Host 时，用面板公开地址兜底。
  assert.deepEqual(resolveRelyingParty("https://panel.example.com:8443", ["127.0.0.1:9810"], "https://panel.example.com:8443/"), { origin: "https://panel.example.com:8443", rpId: RP_ID });
  assert.deepEqual(resolveRelyingParty("http://localhost:5173", ["localhost:5173"]).rpId, "localhost");
  assert.throws(() => resolveRelyingParty("http://panel.example.com", ["panel.example.com"]), /HTTPS/);
  assert.throws(() => resolveRelyingParty("https://1.2.3.4", ["1.2.3.4"]), /IP/);
  assert.throws(() => resolveRelyingParty("https://evil.example", ["panel.example.com"], "https://panel.example.com"), /来源/);
  assert.throws(() => resolveRelyingParty("", ["panel.example.com"]), WebAuthnError);
});
