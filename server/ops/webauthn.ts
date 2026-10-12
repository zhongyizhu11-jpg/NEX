/*
  WebAuthn（通行密钥，#12）服务端校验 —— 只用 node:crypto，不引第三方库。

  只做面板用得到的那部分：
  · 注册：要求 attestation "none"（不验证认证器型号，只信任它这次给的公钥），
    校验 clientDataJSON 的 type / challenge / origin、authenticatorData 的 rpIdHash 和
    UP（用户在场）标志，取出凭据 ID、COSE 公钥（转成 SPKI 存库）和签名计数。
  · 登录：用存下的公钥验 authenticatorData || sha256(clientDataJSON) 上的签名，
    同样校验 challenge / origin / rpIdHash，签名计数必须递增（两边都是 0 的认证器除外 ——
    大多数平台通行密钥一直报 0）。
  · 算法：ES256(-7)、RS256(-257)、Ed25519(-8)。

  CBOR 只实现解码，且只到 WebAuthn 会出现的类型（整数、字节串、文本、数组、映射、
  简单值、浮点），映射一律解成 Map，键可以是整数（COSE 键就是负整数）。
*/
import crypto from "node:crypto";

// ---------- base64url ----------

export function base64urlEncode(data: Uint8Array | Buffer) {
  return Buffer.from(data).toString("base64url");
}

export function base64urlDecode(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new WebAuthnError("数据格式不对");
  return Buffer.from(value.replace(/=+$/, ""), "base64url");
}

export class WebAuthnError extends Error {}

// ---------- CBOR ----------

export type CborValue = number | bigint | string | boolean | null | undefined | Buffer | CborValue[] | Map<CborValue, CborValue>;

const MAX_CBOR_DEPTH = 16;

/** 从 offset 开始解一个 CBOR 项，返回值和结束位置（authenticatorData 里公钥后面可能还跟着扩展）。 */
export function decodeCborItem(buffer: Buffer, offset = 0, depth = 0): { value: CborValue; end: number } {
  if (depth > MAX_CBOR_DEPTH) throw new WebAuthnError("CBOR 嵌套太深");
  const need = (n: number) => {
    if (offset + n > buffer.length) throw new WebAuthnError("CBOR 数据被截断");
  };
  need(1);
  const initial = buffer[offset++];
  const major = initial >> 5;
  const info = initial & 0x1f;

  const readLength = (): number | bigint | null => {
    if (info < 24) return info;
    if (info === 24) { need(1); return buffer[offset++]; }
    if (info === 25) { need(2); const v = buffer.readUInt16BE(offset); offset += 2; return v; }
    if (info === 26) { need(4); const v = buffer.readUInt32BE(offset); offset += 4; return v; }
    if (info === 27) {
      need(8);
      const v = buffer.readBigUInt64BE(offset);
      offset += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    if (info === 31) return null; // 不定长
    throw new WebAuthnError("CBOR 长度编码无效");
  };

  if (major === 7) {
    if (info === 20) return { value: false, end: offset };
    if (info === 21) return { value: true, end: offset };
    if (info === 22) return { value: null, end: offset };
    if (info === 23) return { value: undefined, end: offset };
    if (info === 25) {
      need(2);
      const half = buffer.readUInt16BE(offset);
      offset += 2;
      const exp = (half >> 10) & 0x1f;
      const mant = half & 0x3ff;
      const value = exp === 0 ? mant * 2 ** -24 : exp === 31 ? (mant ? NaN : Infinity) : (mant + 1024) * 2 ** (exp - 25);
      return { value: half & 0x8000 ? -value : value, end: offset };
    }
    if (info === 26) { need(4); const v = buffer.readFloatBE(offset); return { value: v, end: offset + 4 }; }
    if (info === 27) { need(8); const v = buffer.readDoubleBE(offset); return { value: v, end: offset + 8 }; }
    if (info < 24) return { value: info, end: offset };
    if (info === 24) { need(1); return { value: buffer[offset], end: offset + 1 }; }
    throw new WebAuthnError("CBOR 简单值无效");
  }

  const length = readLength();
  switch (major) {
    case 0:
      if (length === null) throw new WebAuthnError("CBOR 整数不能不定长");
      return { value: length, end: offset };
    case 1:
      if (length === null) throw new WebAuthnError("CBOR 整数不能不定长");
      return { value: typeof length === "bigint" ? -1n - length : -1 - length, end: offset };
    case 2:
    case 3: {
      if (length === null) {
        const chunks: Buffer[] = [];
        while (true) {
          need(1);
          if (buffer[offset] === 0xff) { offset += 1; break; }
          const chunk = decodeCborItem(buffer, offset, depth + 1);
          if (major === 2 ? !Buffer.isBuffer(chunk.value) : typeof chunk.value !== "string") throw new WebAuthnError("CBOR 分段类型不一致");
          chunks.push(major === 2 ? (chunk.value as Buffer) : Buffer.from(chunk.value as string, "utf8"));
          offset = chunk.end;
        }
        const joined = Buffer.concat(chunks);
        return { value: major === 2 ? joined : joined.toString("utf8"), end: offset };
      }
      if (typeof length === "bigint") throw new WebAuthnError("CBOR 数据太长");
      need(length);
      const bytes = buffer.subarray(offset, offset + length);
      return { value: major === 2 ? Buffer.from(bytes) : bytes.toString("utf8"), end: offset + length };
    }
    case 4: {
      const items: CborValue[] = [];
      if (typeof length === "bigint") throw new WebAuthnError("CBOR 数组太长");
      for (let i = 0; length === null || i < length; i++) {
        if (length === null) { need(1); if (buffer[offset] === 0xff) { offset += 1; break; } }
        const item = decodeCborItem(buffer, offset, depth + 1);
        items.push(item.value);
        offset = item.end;
      }
      return { value: items, end: offset };
    }
    case 5: {
      const map = new Map<CborValue, CborValue>();
      if (typeof length === "bigint") throw new WebAuthnError("CBOR 映射太长");
      for (let i = 0; length === null || i < length; i++) {
        if (length === null) { need(1); if (buffer[offset] === 0xff) { offset += 1; break; } }
        const key = decodeCborItem(buffer, offset, depth + 1);
        const value = decodeCborItem(buffer, key.end, depth + 1);
        map.set(key.value, value.value);
        offset = value.end;
      }
      return { value: map, end: offset };
    }
    case 6: {
      // 标签：WebAuthn 里用不到，直接取被标记的值。
      const tagged = decodeCborItem(buffer, offset, depth + 1);
      return tagged;
    }
    default:
      throw new WebAuthnError("CBOR 类型无效");
  }
}

/** 解一整段 CBOR，后面不允许有多余字节。 */
export function decodeCbor(buffer: Buffer): CborValue {
  const { value, end } = decodeCborItem(buffer, 0);
  if (end !== buffer.length) throw new WebAuthnError("CBOR 后面有多余数据");
  return value;
}

// ---------- authenticatorData ----------

export const AUTH_FLAG_UP = 0x01;
export const AUTH_FLAG_UV = 0x04;
export const AUTH_FLAG_AT = 0x40;
export const AUTH_FLAG_ED = 0x80;

export type ParsedAuthenticatorData = {
  rpIdHash: Buffer;
  flags: number;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  attestedCredential?: {
    aaguid: Buffer;
    credentialId: Buffer;
    publicKey: Map<CborValue, CborValue>;
  };
};

export function parseAuthenticatorData(data: Buffer): ParsedAuthenticatorData {
  if (data.length < 37) throw new WebAuthnError("authenticatorData 太短");
  const rpIdHash = Buffer.from(data.subarray(0, 32));
  const flags = data[32];
  const signCount = data.readUInt32BE(33);
  const parsed: ParsedAuthenticatorData = {
    rpIdHash,
    flags,
    userPresent: !!(flags & AUTH_FLAG_UP),
    userVerified: !!(flags & AUTH_FLAG_UV),
    signCount,
  };
  let offset = 37;
  if (flags & AUTH_FLAG_AT) {
    if (data.length < offset + 18) throw new WebAuthnError("凭据数据被截断");
    const aaguid = Buffer.from(data.subarray(offset, offset + 16));
    offset += 16;
    const idLength = data.readUInt16BE(offset);
    offset += 2;
    if (idLength < 1 || idLength > 1023 || data.length < offset + idLength) throw new WebAuthnError("凭据 ID 长度无效");
    const credentialId = Buffer.from(data.subarray(offset, offset + idLength));
    offset += idLength;
    const key = decodeCborItem(data, offset);
    if (!(key.value instanceof Map)) throw new WebAuthnError("公钥格式无效");
    offset = key.end;
    parsed.attestedCredential = { aaguid, credentialId, publicKey: key.value };
  }
  if (flags & AUTH_FLAG_ED) {
    offset = decodeCborItem(data, offset).end;
  }
  if (offset !== data.length) throw new WebAuthnError("authenticatorData 后面有多余数据");
  return parsed;
}

// ---------- COSE 公钥 ----------

export const COSE_ALG_ES256 = -7;
export const COSE_ALG_EDDSA = -8;
export const COSE_ALG_RS256 = -257;
export const SUPPORTED_COSE_ALGS = [COSE_ALG_ES256, COSE_ALG_EDDSA, COSE_ALG_RS256];

function coseBytes(map: Map<CborValue, CborValue>, label: number) {
  const value = map.get(label);
  if (!Buffer.isBuffer(value)) throw new WebAuthnError("公钥缺少字段");
  return value;
}

/** COSE_Key → { alg, SPKI DER }。 */
export function coseToPublicKey(cose: Map<CborValue, CborValue>): { alg: number; spki: Buffer } {
  const kty = cose.get(1);
  const alg = Number(cose.get(3));
  let jwk: crypto.JsonWebKey;
  if (kty === 2 && alg === COSE_ALG_ES256) {
    if (cose.get(-1) !== 1) throw new WebAuthnError("只支持 P-256 曲线");
    const x = coseBytes(cose, -2);
    const y = coseBytes(cose, -3);
    if (x.length !== 32 || y.length !== 32) throw new WebAuthnError("EC 公钥长度无效");
    jwk = { kty: "EC", crv: "P-256", x: base64urlEncode(x), y: base64urlEncode(y) };
  } else if (kty === 3 && alg === COSE_ALG_RS256) {
    jwk = { kty: "RSA", n: base64urlEncode(coseBytes(cose, -1)), e: base64urlEncode(coseBytes(cose, -2)) };
  } else if (kty === 1 && alg === COSE_ALG_EDDSA) {
    if (cose.get(-1) !== 6) throw new WebAuthnError("只支持 Ed25519");
    jwk = { kty: "OKP", crv: "Ed25519", x: base64urlEncode(coseBytes(cose, -2)) };
  } else {
    throw new WebAuthnError("不支持这种通行密钥算法");
  }
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return { alg, spki: key.export({ type: "spki", format: "der" }) as Buffer };
}

export function verifyWebAuthnSignature(alg: number, spki: Buffer, data: Buffer, signature: Buffer) {
  const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  try {
    if (alg === COSE_ALG_ES256) return crypto.verify("sha256", data, { key, dsaEncoding: "der" }, signature);
    if (alg === COSE_ALG_RS256) return crypto.verify("sha256", data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
    if (alg === COSE_ALG_EDDSA) return crypto.verify(null, data, key, signature);
  } catch {
    return false;
  }
  return false;
}

// ---------- 两个流程 ----------

export type ExpectedCeremony = {
  challenge: string; // base64url
  origin: string;
  rpId: string;
  requireUserVerification?: boolean;
};

function sha256(data: Buffer | string) {
  return crypto.createHash("sha256").update(data).digest();
}

function checkClientData(clientDataJSON: Buffer, type: "webauthn.create" | "webauthn.get", expected: ExpectedCeremony) {
  let clientData: Record<string, unknown>;
  try {
    clientData = JSON.parse(clientDataJSON.toString("utf8"));
  } catch {
    throw new WebAuthnError("clientDataJSON 无法解析");
  }
  if (clientData.type !== type) throw new WebAuthnError("请求类型不对");
  const challenge = String(clientData.challenge || "");
  const expectedChallenge = Buffer.from(expected.challenge);
  if (challenge.length !== expected.challenge.length || !crypto.timingSafeEqual(Buffer.from(challenge), expectedChallenge)) {
    throw new WebAuthnError("挑战不匹配，请重试");
  }
  if (clientData.origin !== expected.origin) throw new WebAuthnError("来源地址不匹配");
  if (clientData.crossOrigin === true) throw new WebAuthnError("不接受跨域嵌入的请求");
}

function checkAuthData(auth: ParsedAuthenticatorData, expected: ExpectedCeremony) {
  if (!auth.rpIdHash.equals(sha256(expected.rpId))) throw new WebAuthnError("通行密钥不属于这个域名");
  if (!auth.userPresent) throw new WebAuthnError("认证器没有确认用户在场");
  if (expected.requireUserVerification && !auth.userVerified) throw new WebAuthnError("认证器没有验证用户身份");
}

export type RegistrationResponse = {
  id: string;
  rawId?: string;
  type?: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
};

export type VerifiedRegistration = {
  credentialId: string; // base64url
  publicKey: string; // SPKI DER base64url
  alg: number;
  signCount: number;
  userVerified: boolean;
};

export function verifyRegistrationResponse(response: RegistrationResponse, expected: ExpectedCeremony): VerifiedRegistration {
  if (response.type && response.type !== "public-key") throw new WebAuthnError("凭据类型不对");
  const clientDataJSON = base64urlDecode(response.response.clientDataJSON);
  checkClientData(clientDataJSON, "webauthn.create", expected);
  const attestation = decodeCbor(base64urlDecode(response.response.attestationObject));
  if (!(attestation instanceof Map)) throw new WebAuthnError("attestationObject 格式无效");
  const fmt = attestation.get("fmt");
  const authDataRaw = attestation.get("authData");
  if (typeof fmt !== "string" || !Buffer.isBuffer(authDataRaw)) throw new WebAuthnError("attestationObject 缺少字段");
  // 我们请求的是 attestation: "none"，浏览器会把证明换成 none；个别认证器仍带自己的证明时
  // 同样不验证它（等同于 none 的信任方式：只信这次注册拿到的公钥）。
  const auth = parseAuthenticatorData(authDataRaw);
  checkAuthData(auth, expected);
  if (!auth.attestedCredential) throw new WebAuthnError("注册结果里没有凭据");
  const credentialId = base64urlEncode(auth.attestedCredential.credentialId);
  if (response.id !== credentialId) throw new WebAuthnError("凭据 ID 不一致");
  const { alg, spki } = coseToPublicKey(auth.attestedCredential.publicKey);
  return { credentialId, publicKey: base64urlEncode(spki), alg, signCount: auth.signCount, userVerified: auth.userVerified };
}

export type AuthenticationResponse = {
  id: string;
  rawId?: string;
  type?: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
};

export type StoredCredential = { publicKey: string; alg: number; signCount: number };

export function verifyAuthenticationResponse(response: AuthenticationResponse, expected: ExpectedCeremony, credential: StoredCredential) {
  if (response.type && response.type !== "public-key") throw new WebAuthnError("凭据类型不对");
  const clientDataJSON = base64urlDecode(response.response.clientDataJSON);
  checkClientData(clientDataJSON, "webauthn.get", expected);
  const authData = base64urlDecode(response.response.authenticatorData);
  const auth = parseAuthenticatorData(authData);
  checkAuthData(auth, expected);
  const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
  if (!verifyWebAuthnSignature(credential.alg, base64urlDecode(credential.publicKey), signed, base64urlDecode(response.response.signature))) {
    throw new WebAuthnError("签名校验失败");
  }
  // 计数器：有一边非 0 就必须严格递增，否则可能是被克隆的认证器。
  if ((auth.signCount !== 0 || credential.signCount !== 0) && auth.signCount <= credential.signCount) {
    throw new WebAuthnError("通行密钥计数异常，可能被复制过，请删除后重新添加");
  }
  return { signCount: auth.signCount, userVerified: auth.userVerified };
}

export function createChallenge() {
  return base64urlEncode(crypto.randomBytes(32));
}
