/*
  第三方登录（Google、Discord、通用 OIDC）共用的协议零件，只用 node:crypto：

  - 随机值、PKCE（S256）、定长时间比较；
  - 读响应正文时按实际字节数封顶（不信 Content-Length）；
  - 发起登录时的 state 表（只放服务端内存、一次性、绑浏览器 cookie，见 OAuthStateStore）；
  - JWS / JWT：拆三段、按 alg 验签（RS256 / ES256，HS* 只有调用方明确给了密钥才认）、
    JWK 导入、带 TTL 的 JWKS 公钥缓存（遇到不认识的 kid 最多一分钟强刷一次）。

  这些原来都写在 server/googleOidc.ts 里；通用 OIDC 登录（server/oidcClient.ts）要用同一套，
  抽到这里两边共用，免得一份规则改了另一份没改。googleOidc.ts 仍然原名导出它们，旧的 import 不用动。
*/
import crypto from "node:crypto";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 身份提供方的 token / JWKS / discovery 响应只有几 KB；多出来的不读，免得被一个异常的大响应拖住。 */
export const OAUTH_RESPONSE_MAX_BYTES = 128 * 1024;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_STATE_MAX_ENTRIES = 10_000;

export function randomUrlToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256Base64Url(value: string) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

/** RFC 7636：verifier 是 43~128 个 unreserved 字符；32 字节随机数 base64url 后正好 43 个。 */
export function createPkcePair() {
  const verifier = randomUrlToken(32);
  return { verifier, challenge: sha256Base64Url(verifier), method: "S256" as const };
}

export function timingSafeEqualText(a: string, b: string) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** 读响应正文，最多 maxBytes 字节（按实际读到的算，不信 Content-Length）；超了抛错并丢掉剩下的。 */
export async function readCappedResponseText(response: Response, maxBytes = OAUTH_RESPONSE_MAX_BYTES) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("response too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/** 从网络上读回来的 JSON 对象：字段一律当 unknown，用之前各自判类型。 */
export type JsonObject = Record<string, unknown>;

/** 只要「一个 JSON 对象」：解析失败、是数组或原始值都算 null（调用方当作坏响应处理）。 */
export function parseJsonObject(text: string): JsonObject | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
  } catch {
    return null;
  }
}

// ---------- state 存储 ----------

export type OAuthStateEntry<M extends string = string> = {
  mode: M;
  /** 登录成功后跳回的相对路径（已经过 sanitizeRedirectPath）。 */
  redirectPath: string;
  codeVerifier: string;
  nonce: string;
  /** 浏览器绑定 cookie 的 sha256。 */
  bindingHash: string;
  /** 绑定模式：发起时登录着的用户；回调时必须还是这个人。 */
  userId: number | null;
  /** App 模式：对应的 App 登录流程。 */
  appFlowId: string | null;
  /** 从邀请链接进来时的邀请码（已清洗），只在注册新账号时用。 */
  inviteCode?: string | null;
  /** 发起时的配置指纹；回调时配置变了就不认。 */
  configHash?: string | null;
  createdAt: number;
  expiresAt: number;
};

export type OAuthStateInput<M extends string = string> = Omit<OAuthStateEntry<M>, "createdAt" | "expiresAt" | "codeVerifier" | "nonce" | "bindingHash"> & {
  binding: string;
};

/*
  每次发起登录生成 state / PKCE verifier / nonce，**只放在服务端内存**里，以 state 为键，过期、取一次就删。
  浏览器手里只有一个「浏览器绑定」cookie，服务端存它的哈希：回调时 state 对得上、cookie 也对得上才算数
  （别人把自己那次授权的回调链接发给你，你的浏览器没有那个 cookie，换不了票 —— 防登录 CSRF）。
  用内存表而不是签名 cookie：面板单进程，内存表天然「只能用一次」；签名 cookie 过期前可以被重放。
*/
export class OAuthStateStore<M extends string = string> {
  private readonly entries = new Map<string, OAuthStateEntry<M>>();

  constructor(
    private readonly options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {}

  private now() {
    return (this.options.now || Date.now)();
  }

  get size() {
    return this.entries.size;
  }

  prune() {
    const now = this.now();
    return pruneMapEntries(this.entries, (entry) => entry.expiresAt <= now);
  }

  /** 发起一次登录：返回 state、给授权端点的 code_challenge 和 nonce。 */
  create(input: OAuthStateInput<M>) {
    this.prune();
    const now = this.now();
    const state = randomUrlToken(32);
    const pkce = createPkcePair();
    const nonce = randomUrlToken(32);
    const entry: OAuthStateEntry<M> = {
      mode: input.mode,
      redirectPath: input.redirectPath,
      userId: input.userId,
      appFlowId: input.appFlowId,
      inviteCode: input.inviteCode ?? null,
      configHash: input.configHash ?? null,
      codeVerifier: pkce.verifier,
      nonce,
      bindingHash: sha256Base64Url(input.binding),
      createdAt: now,
      expiresAt: now + (this.options.ttlMs ?? OAUTH_STATE_TTL_MS),
    };
    setBoundedMapValue(this.entries, state, entry, this.options.maxEntries ?? OAUTH_STATE_MAX_ENTRIES);
    return { state, codeChallenge: pkce.challenge, nonce, entry };
  }

  /**
   * 取出并作废。不管后面成不成功，一个 state 只能用一次；过期、cookie 对不上一律 null。
   * 先删后判：哪怕 cookie 不对，这个 state 也废了（拿着它反复试 cookie 没有意义）。
   */
  consume(state: unknown, binding: unknown): OAuthStateEntry<M> | null {
    if (typeof state !== "string" || state.length < 16 || state.length > 128) return null;
    const entry = this.entries.get(state);
    if (!entry) return null;
    this.entries.delete(state);
    if (entry.expiresAt <= this.now()) return null;
    if (typeof binding !== "string" || !binding) return null;
    if (!timingSafeEqualText(sha256Base64Url(binding), entry.bindingHash)) return null;
    return entry;
  }
}

// ---------- JWS / JWT ----------

export type CompactJws = {
  header: JsonObject;
  payload: JsonObject;
  /** 「header.payload」原文：签名就是对它算的。 */
  signingInput: Buffer;
  signature: Buffer;
};

function decodeJsonSegment(segment: string) {
  try {
    return parseJsonObject(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** 拆一个紧凑序列化的 JWS。三段都必须非空、只含 base64url 字符（alg: none 的空签名在这里就过不去）。 */
export function parseCompactJws(token: string): CompactJws | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const header = decodeJsonSegment(parts[0]);
  const payload = decodeJsonSegment(parts[1]);
  if (!header || !payload) return null;
  return { header, payload, signingInput: Buffer.from(`${parts[0]}.${parts[1]}`), signature: Buffer.from(parts[2], "base64url") };
}

/** 用公钥验的算法。只有这两种：PS* / RS384 之类用的人很少，多认一种就多一处要想清楚的地方。 */
export type AsymmetricJwsAlg = "RS256" | "ES256";
export const ASYMMETRIC_JWS_ALGS: readonly AsymmetricJwsAlg[] = ["RS256", "ES256"];
/** 用共享密钥（OIDC 里就是客户端密钥）验的算法：默认不认，见 verifyJwsSignature。 */
export type HmacJwsAlg = "HS256" | "HS384" | "HS512";
export const HMAC_JWS_ALGS: readonly HmacJwsAlg[] = ["HS256", "HS384", "HS512"];

const RSA_MIN_MODULUS_BITS = 2048;

function keyMatchesAlg(key: crypto.KeyObject, alg: AsymmetricJwsAlg) {
  if (key.type !== "public") return false;
  if (alg === "RS256") {
    return key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= RSA_MIN_MODULUS_BITS;
  }
  return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
}

/**
 * 验一段 JWS 签名。alg 由调用方先判过是允许的；这里再按 alg 核对钥匙的类型，
 * 防「拿 RSA 公钥当 HMAC 密钥」那一类算法混淆：HS* 只接受调用方明确给的共享密钥（Buffer / string），
 * 绝不接受 KeyObject 公钥。
 */
export function verifyJwsSignature(
  alg: string,
  key: crypto.KeyObject | { hmacSecret: string },
  signingInput: Buffer,
  signature: Buffer,
): boolean {
  if ((HMAC_JWS_ALGS as readonly string[]).includes(alg)) {
    if (!("hmacSecret" in key) || !key.hmacSecret) return false;
    const digest = alg === "HS256" ? "sha256" : alg === "HS384" ? "sha384" : "sha512";
    const expected = crypto.createHmac(digest, key.hmacSecret).update(signingInput).digest();
    return expected.length === signature.length && crypto.timingSafeEqual(expected, signature);
  }
  if ("hmacSecret" in key) return false;
  if (alg === "RS256") {
    if (!keyMatchesAlg(key, "RS256")) return false;
    return crypto.verify("RSA-SHA256", signingInput, key, signature);
  }
  if (alg === "ES256") {
    // JWS 的 ECDSA 签名是 r||s 定长 64 字节（IEEE P1363），不是 DER。
    if (!keyMatchesAlg(key, "ES256") || signature.length !== 64) return false;
    return crypto.verify("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" }, signature);
  }
  return false;
}

// ---------- JWKS ----------

export type Jwk = { kid?: string; kty?: string; alg?: string; use?: string; n?: string; e?: string; crv?: string; x?: string; y?: string };

type ImportedJwk = { kid: string | null; alg: AsymmetricJwsAlg; key: crypto.KeyObject };

/** 一把 JWK 能给哪个算法用：RSA → RS256，EC P-256 → ES256；别的（含对称 oct 钥匙）不要。 */
function algOfJwk(jwk: Jwk): AsymmetricJwsAlg | null {
  if (jwk.kty === "RSA" && jwk.n && jwk.e) return "RS256";
  if (jwk.kty === "EC" && jwk.crv === "P-256" && jwk.x && jwk.y) return "ES256";
  return null;
}

/** 从 JWKS 文档里挑出能用的签名公钥。allowedAlgs 之外的、用途不是 sig 的、坏的都跳过。 */
export function importJwks(data: unknown, allowedAlgs: readonly AsymmetricJwsAlg[]): ImportedJwk[] {
  const list = data && typeof data === "object" ? (data as { keys?: unknown }).keys : undefined;
  const keys = Array.isArray(list) ? (list as Jwk[]) : [];
  const result: ImportedJwk[] = [];
  for (const jwk of keys) {
    if (!jwk || typeof jwk !== "object") continue;
    const alg = algOfJwk(jwk);
    if (!alg || !allowedAlgs.includes(alg)) continue;
    if (jwk.alg && jwk.alg !== alg) continue;
    if (jwk.use && jwk.use !== "sig") continue;
    try {
      const key = alg === "RS256"
        ? crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n!, e: jwk.e! }, format: "jwk" })
        : crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! }, format: "jwk" });
      if (!keyMatchesAlg(key, alg)) continue;
      result.push({ kid: typeof jwk.kid === "string" && jwk.kid ? jwk.kid : null, alg, key });
    } catch {
      // 坏的一把钥匙跳过，别的照用
    }
  }
  return result;
}

const JWKS_DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
const JWKS_MIN_MAX_AGE_MS = 5 * 60 * 1000;
const JWKS_MAX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const JWKS_FORCED_REFRESH_INTERVAL_MS = 60 * 1000;

export function jwksMaxAgeMs(cacheControl: string | null | undefined) {
  const match = String(cacheControl || "").match(/max-age=(\d+)/i);
  if (!match) return JWKS_DEFAULT_MAX_AGE_MS;
  const ms = Number(match[1]) * 1000;
  return Math.min(JWKS_MAX_MAX_AGE_MS, Math.max(JWKS_MIN_MAX_AGE_MS, ms));
}

/**
 * 带 TTL 的 JWKS 公钥缓存。怎么拉（fetch 还是走 SSRF 防护的出站请求）、出错抛什么由调用方给。
 * 缓存过期就刷新；遇到不认识的 kid（对方换钥了）最多一分钟强刷一次 —— 乱给 kid 刷不爆对方。
 */
export class JwksKeyStore {
  private keys: ImportedJwk[] = [];
  private expiresAt = 0;
  private lastFetchAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly options: {
    /** 拉一次 JWKS：返回解析好的 JSON 和 Cache-Control。网络 / HTTP 错误由它自己抛。 */
    load: () => Promise<{ data: unknown; cacheControl?: string | null }>;
    allowedAlgs: readonly AsymmetricJwsAlg[];
    /** 「没有能用的钥匙」「不认识的钥匙」时抛的错（各家的错误类型不一样）。 */
    error: (message: string) => Error;
    now?: () => number;
  }) {}

  private now() {
    return (this.options.now || Date.now)();
  }

  private async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      this.lastFetchAt = this.now();
      const { data, cacheControl } = await this.options.load();
      const next = importJwks(data, this.options.allowedAlgs);
      if (!next.length) throw this.options.error("jwks has no usable keys");
      this.keys = next;
      this.expiresAt = this.now() + jwksMaxAgeMs(cacheControl);
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private pick(kid: string | null, alg: AsymmetricJwsAlg) {
    const sameAlg = this.keys.filter((item) => item.alg === alg);
    if (kid) return sameAlg.find((item) => item.kid === kid)?.key;
    // 令牌没带 kid：只有这个算法的钥匙恰好一把时才用它（有好几把就不猜）。
    return sameAlg.length === 1 ? sameAlg[0].key : undefined;
  }

  /** 按 kid + alg 取公钥。 */
  async getKey(kid: string | null, alg: AsymmetricJwsAlg = "RS256") {
    if (!this.keys.length || this.now() >= this.expiresAt) await this.refresh();
    let key = this.pick(kid, alg);
    if (!key && this.now() - this.lastFetchAt >= JWKS_FORCED_REFRESH_INTERVAL_MS) {
      await this.refresh();
      key = this.pick(kid, alg);
    }
    if (!key) throw this.options.error("unknown signing key");
    return key;
  }
}
