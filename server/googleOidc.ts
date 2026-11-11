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
import type { GoogleLoginMode } from "../shared/googleLogin";
import {
  JwksKeyStore,
  OAUTH_RESPONSE_MAX_BYTES,
  OAuthStateStore,
  parseCompactJws,
  parseJsonObject,
  readCappedResponseText,
  timingSafeEqualText,
  verifyJwsSignature,
  type FetchLike,
  type OAuthStateEntry,
  type OAuthStateInput,
} from "./oauthPrimitives";

// 这几样原来就定义在这里，后来抽到 server/oauthPrimitives.ts 和通用 OIDC 共用；原名照旧导出，旧的 import 不用改。
export {
  createPkcePair,
  jwksMaxAgeMs,
  randomUrlToken,
  readCappedResponseText,
  sha256Base64Url,
  timingSafeEqualText,
  type FetchLike,
} from "./oauthPrimitives";

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
export const GOOGLE_RESPONSE_MAX_BYTES = OAUTH_RESPONSE_MAX_BYTES;
/** 同时在换票的回调数上限：到了就直接拒绝，不排队（排队只会攒一堆挂着的登录请求）。 */
export const GOOGLE_MAX_CONCURRENT_EXCHANGES = 32;

/** 失败原因只是一个短码，调用方据此跳回登录页；message 只给日志看（不含令牌）。 */
export class GoogleOidcError extends Error {
  constructor(public readonly code: "state_invalid" | "exchange_failed" | "token_invalid" | "email_unverified" | "rate_limited", message: string) {
    super(message);
    this.name = "GoogleOidcError";
  }
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

async function readCappedJson(response: Response) {
  return parseJsonObject(await readCappedResponseText(response, GOOGLE_RESPONSE_MAX_BYTES));
}

// ---------- state 存储 ----------

// 规则见 server/oauthPrimitives.ts 的 OAuthStateStore（和通用 OIDC 登录共用）。
export type GoogleAuthStateEntry = OAuthStateEntry<GoogleLoginMode>;
export type GoogleAuthStateInput = OAuthStateInput<GoogleLoginMode>;

export class GoogleAuthStateStore extends OAuthStateStore<GoogleLoginMode> {}

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

export class GoogleJwksCache {
  private readonly store: JwksKeyStore;

  constructor(private readonly options: { url?: string; fetchImpl?: FetchLike; now?: () => number } = {}) {
    // 缓存、强刷节奏、JWK 导入都在 server/oauthPrimitives.ts 的 JwksKeyStore；Google 只用 RS256。
    this.store = new JwksKeyStore({
      allowedAlgs: ["RS256"],
      now: options.now,
      error: (message) => new GoogleOidcError("token_invalid", message),
      load: async () => {
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
        try {
          return { data: await readCappedJson(response), cacheControl: response.headers.get("cache-control") };
        } catch {
          throw new GoogleOidcError("token_invalid", "jwks response too large");
        }
      },
    });
  }

  /** 按 kid 取公钥。缓存过期就刷新；遇到不认识的 kid（Google 换钥了）最多一分钟强刷一次。 */
  async getKey(kid: string) {
    return this.store.getKey(kid, "RS256");
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
  const jws = parseCompactJws(idToken);
  if (!jws) throw invalid("malformed");
  const { header, payload } = jws;
  // 只认 RS256：不接受 none / HS256 之类（防「拿公钥当 HMAC 密钥」那一类混淆）。
  if (header.alg !== "RS256") throw invalid("alg");
  if (typeof header.kid !== "string" || !header.kid) throw invalid("kid");

  const key = await options.jwks.getKey(header.kid);
  if (!verifyJwsSignature("RS256", key, jws.signingInput, jws.signature)) throw invalid("signature");

  if (!(GOOGLE_ISSUERS as readonly unknown[]).includes(payload.iss)) throw invalid("iss");
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
