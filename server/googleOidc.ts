/*
  Google 登录的协议层（OAuth 2.0 授权码 + PKCE，OpenID Connect ID Token），只用 fetch 和 node:crypto。

  - 每次发起登录生成三样随机值：state（32 字节）、PKCE code_verifier（32 字节，challenge 用 S256）、
    nonce（32 字节）。它们**只放在服务端内存**里，以 state 为键，10 分钟过期，取一次就删。
    浏览器手里只有一个「浏览器绑定」cookie（HttpOnly、SameSite=Lax），服务端存的是它的哈希：
    回调时 state 对得上、cookie 也对得上才算数 —— 别人把自己那次授权的回调链接发给你，
    你的浏览器没有那个 cookie，换不了票（防登录 CSRF，绑定模式下也就不会把别人的 Google 绑到你头上）。

    为什么不用签名 cookie 装下全部数据：面板是单进程，内存表天然能做到「只能用一次」；
    签名 cookie 在过期前可以被重放，要真正一次性还得另外记账。code_verifier 也不必离开服务端。
    代价是面板重启后正在进行的登录作废，用户重新点一下按钮即可。

  - ID Token 自己验：RS256 签名对 Google 的 JWKS（带缓存，按 Cache-Control 刷新，遇到不认识的
    kid 最多一分钟强刷一次），iss、aud、exp / iat（允许一分钟时钟误差）、nonce、email_verified。
    虽然令牌是我们自己经 TLS 从 Google 的 token 端点拿的，签名还是要验 —— 多一道不贵。

  - 令牌（code、id_token、access_token）只在内存里过一下：不进日志、不进 URL、不落库。

  - 对 Google 的出站请求（照上游 poouo/Forwardx server/googleOAuth.ts 收紧）：不跟随重定向
    （redirect: "error"）、响应最多读 128KB、同时最多 32 个换票请求（多出来的直接拒绝，不排队）。
    发起时记下当时的配置指纹（客户端 ID / 密钥 / 回调地址的哈希），回调时配置已经变了就不认这次登录。
*/
import crypto from "node:crypto";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";
import type { GoogleLoginMode } from "../shared/googleLogin";

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
export const GOOGLE_SCOPE = "openid email profile";

export const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;
export const GOOGLE_STATE_MAX_ENTRIES = 10_000;
export const GOOGLE_CLOCK_SKEW_SECONDS = 60;
const GOOGLE_HTTP_TIMEOUT_MS = 10_000;
/** Google 的 token / JWKS 响应只有几 KB；多出来的不读，免得被一个异常的大响应拖住。 */
export const GOOGLE_RESPONSE_MAX_BYTES = 128 * 1024;
/** 同时在换票的回调数上限：到了就直接拒绝，不排队（排队只会攒一堆挂着的登录请求）。 */
export const GOOGLE_MAX_CONCURRENT_EXCHANGES = 32;

/** 失败原因只是一个短码，调用方据此跳回登录页；message 只给日志看（不含令牌）。 */
export class GoogleOidcError extends Error {
  constructor(public readonly code: "state_invalid" | "exchange_failed" | "token_invalid" | "email_unverified" | "rate_limited", message: string) {
    super(message);
    this.name = "GoogleOidcError";
  }
}

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

/**
 * 发起登录时的 Google 配置指纹。回调时重新算一遍：管理员中途换了客户端 / 密钥 / 面板地址，
 * 这次登录就作废（不拿旧配置下拿到的授权码去换票）。只存哈希，看不出密钥。
 */
export function googleConfigFingerprint(config: { clientId: string; clientSecret: string; redirectUri: string }) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([config.clientId, config.clientSecret, config.redirectUri]))
    .digest("base64url");
}

/** 读响应正文，最多 maxBytes 字节（按实际读到的算，不信 Content-Length）；超了抛错并丢掉剩下的。 */
export async function readCappedResponseText(response: Response, maxBytes = GOOGLE_RESPONSE_MAX_BYTES) {
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

async function readCappedJson(response: Response) {
  const text = await readCappedResponseText(response);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function timingSafeEqualText(a: string, b: string) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// ---------- state 存储 ----------

export type GoogleAuthStateEntry = {
  mode: GoogleLoginMode;
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
  /** 从邀请链接进来时的邀请码（已过 sanitizeGoogleInviteCode），只在 Google 注册新账号时用。 */
  inviteCode?: string | null;
  /** 发起时的配置指纹（googleConfigFingerprint）；回调时配置变了就不认。 */
  configHash?: string | null;
  createdAt: number;
  expiresAt: number;
};

export type GoogleAuthStateInput = Omit<GoogleAuthStateEntry, "createdAt" | "expiresAt" | "codeVerifier" | "nonce" | "bindingHash"> & {
  binding: string;
};

export class GoogleAuthStateStore {
  private readonly entries = new Map<string, GoogleAuthStateEntry>();

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

  /** 发起一次登录：返回 state、给 Google 的 code_challenge 和 nonce。 */
  create(input: GoogleAuthStateInput) {
    this.prune();
    const now = this.now();
    const state = randomUrlToken(32);
    const pkce = createPkcePair();
    const nonce = randomUrlToken(32);
    const entry: GoogleAuthStateEntry = {
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
      expiresAt: now + (this.options.ttlMs ?? GOOGLE_STATE_TTL_MS),
    };
    setBoundedMapValue(this.entries, state, entry, this.options.maxEntries ?? GOOGLE_STATE_MAX_ENTRIES);
    return { state, codeChallenge: pkce.challenge, nonce, entry };
  }

  /**
   * 取出并作废。不管后面成不成功，一个 state 只能用一次；过期、cookie 对不上一律 null。
   * 先删后判：哪怕 cookie 不对，这个 state 也废了（拿着它反复试 cookie 没有意义）。
   */
  consume(state: unknown, binding: unknown): GoogleAuthStateEntry | null {
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

export function buildGoogleAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  nonce: string;
  loginHint?: string | null;
}) {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("include_granted_scopes", "false");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

// ---------- 换票 ----------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let activeExchanges = 0;

/** 用授权码 + code_verifier 换 ID Token。只返回 id_token；access_token 用不上，直接丢掉。 */
export async function exchangeGoogleAuthorizationCode(input: Parameters<typeof exchangeGoogleAuthorizationCodeUnbounded>[0]) {
  if (activeExchanges >= GOOGLE_MAX_CONCURRENT_EXCHANGES) {
    throw new GoogleOidcError("rate_limited", "too many concurrent token exchanges");
  }
  activeExchanges += 1;
  try {
    return await exchangeGoogleAuthorizationCodeUnbounded(input);
  } finally {
    activeExchanges -= 1;
  }
}

async function exchangeGoogleAuthorizationCodeUnbounded(input: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}) {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.codeVerifier,
  });
  let response: Response;
  try {
    response = await (input.fetchImpl || fetch)(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GoogleOidcError("exchange_failed", `token endpoint unreachable: ${error instanceof Error ? error.name : "error"}`);
  }
  let data: any = null;
  try {
    data = await readCappedJson(response);
  } catch {
    throw new GoogleOidcError("exchange_failed", "token endpoint response too large");
  }
  if (!response.ok) {
    // Google 的错误体是 { error, error_description }，不含令牌，可以记下 error 码。
    const reason = typeof data?.error === "string" ? data.error.slice(0, 64) : `http_${response.status}`;
    throw new GoogleOidcError("exchange_failed", `token endpoint rejected: ${reason}`);
  }
  const idToken = typeof data?.id_token === "string" ? data.id_token : "";
  if (!idToken) throw new GoogleOidcError("exchange_failed", "token endpoint returned no id_token");
  return { idToken };
}

// ---------- JWKS ----------

type Jwk = { kid?: string; kty?: string; alg?: string; use?: string; n?: string; e?: string };

const JWKS_DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
const JWKS_MIN_MAX_AGE_MS = 5 * 60 * 1000;
const JWKS_MAX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const JWKS_FORCED_REFRESH_INTERVAL_MS = 60 * 1000;

export function jwksMaxAgeMs(cacheControl: string | null | undefined) {
  const match = String(cacheControl || "").match(/max-age=(\d+)/i);
  if (!match) return JWKS_DEFAULT_MAX_AGE_MS;
  const ms = Number(match[1]) * 1000;
  return Math.min(JWKS_MAX_MAX_AGE_MS, Math.max(JWKS_MIN_MAX_AGE_MS, ms));
}

export class GoogleJwksCache {
  private keys = new Map<string, crypto.KeyObject>();
  private expiresAt = 0;
  private lastFetchAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly options: { url?: string; fetchImpl?: FetchLike; now?: () => number } = {}) {}

  private now() {
    return (this.options.now || Date.now)();
  }

  private async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      this.lastFetchAt = this.now();
      let response: Response;
      try {
        response = await (this.options.fetchImpl || fetch)(this.options.url || GOOGLE_JWKS_URL, {
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS),
        });
      } catch (error) {
        throw new GoogleOidcError("token_invalid", `jwks unreachable: ${error instanceof Error ? error.name : "error"}`);
      }
      if (!response.ok) throw new GoogleOidcError("token_invalid", `jwks http_${response.status}`);
      let data: any = null;
      try {
        data = await readCappedJson(response);
      } catch {
        throw new GoogleOidcError("token_invalid", "jwks response too large");
      }
      const next = new Map<string, crypto.KeyObject>();
      for (const jwk of Array.isArray(data?.keys) ? (data.keys as Jwk[]) : []) {
        if (!jwk?.kid || jwk.kty !== "RSA" || !jwk.n || !jwk.e) continue;
        if (jwk.alg && jwk.alg !== "RS256") continue;
        if (jwk.use && jwk.use !== "sig") continue;
        try {
          next.set(jwk.kid, crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }));
        } catch {
          // 坏的一把钥匙跳过，别的照用
        }
      }
      if (!next.size) throw new GoogleOidcError("token_invalid", "jwks has no usable keys");
      this.keys = next;
      this.expiresAt = this.now() + jwksMaxAgeMs(response.headers.get("cache-control"));
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** 按 kid 取公钥。缓存过期就刷新；遇到不认识的 kid（Google 换钥了）最多一分钟强刷一次。 */
  async getKey(kid: string) {
    if (!this.keys.size || this.now() >= this.expiresAt) await this.refresh();
    let key = this.keys.get(kid);
    if (!key && this.now() - this.lastFetchAt >= JWKS_FORCED_REFRESH_INTERVAL_MS) {
      await this.refresh();
      key = this.keys.get(kid);
    }
    if (!key) throw new GoogleOidcError("token_invalid", "unknown signing key");
    return key;
  }
}

// ---------- ID Token ----------

export type GoogleIdTokenClaims = {
  sub: string;
  email: string;
  emailVerified: true;
  name: string | null;
  picture: string | null;
  hostedDomain: string | null;
  iat: number;
  exp: number;
};

function decodeJsonSegment(segment: string) {
  try {
    const text = Buffer.from(segment, "base64url").toString("utf8");
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
  } catch {
    return null;
  }
}

/**
 * 校验 Google 的 ID Token，通过才返回我们要用的几项声明。任何一项不对都抛 GoogleOidcError。
 * now 是秒；测试里可以拨钟。
 */
export async function verifyGoogleIdToken(idToken: string, options: {
  clientId: string;
  nonce: string;
  jwks: Pick<GoogleJwksCache, "getKey">;
  nowSeconds?: number;
  clockSkewSeconds?: number;
}): Promise<GoogleIdTokenClaims> {
  const invalid = (why: string) => new GoogleOidcError("token_invalid", `id_token ${why}`);
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid("malformed");
  const header = decodeJsonSegment(parts[0]);
  const payload = decodeJsonSegment(parts[1]);
  if (!header || !payload) throw invalid("malformed");
  // 只认 RS256：不接受 none / HS256 之类（防「拿公钥当 HMAC 密钥」那一类混淆）。
  if (header.alg !== "RS256") throw invalid("alg");
  if (typeof header.kid !== "string" || !header.kid) throw invalid("kid");

  const key = await options.jwks.getKey(header.kid);
  const signature = Buffer.from(parts[2], "base64url");
  const signedOk = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, signature);
  if (!signedOk) throw invalid("signature");

  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw invalid("iss");
  const aud = payload.aud;
  if (typeof aud === "string") {
    if (aud !== options.clientId) throw invalid("aud");
  } else if (Array.isArray(aud)) {
    // 多个受众时必须包含我们，而且 azp（发给谁的）就是我们。
    if (!aud.includes(options.clientId) || payload.azp !== options.clientId) throw invalid("aud");
  } else {
    throw invalid("aud");
  }
  if (payload.azp !== undefined && payload.azp !== options.clientId) throw invalid("azp");

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? GOOGLE_CLOCK_SKEW_SECONDS;
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);
  if (!Number.isFinite(exp) || exp + skew <= now) throw invalid("expired");
  if (!Number.isFinite(iat) || iat - skew > now) throw invalid("iat");

  if (typeof payload.nonce !== "string" || !timingSafeEqualText(payload.nonce, options.nonce)) throw invalid("nonce");

  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub || sub.length > 191) throw invalid("sub"); // 库里 googleSub 是 varchar(191)；Google 实际是二十来位数字
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || email.length > 320 || !email.includes("@")) throw invalid("email");
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new GoogleOidcError("email_unverified", "id_token email not verified");
  }

  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  return {
    sub,
    email,
    emailVerified: true,
    name: text(payload.name, 64),
    picture: text(payload.picture, 512),
    hostedDomain: text(payload.hd, 253),
    iat,
    exp,
  };
}
