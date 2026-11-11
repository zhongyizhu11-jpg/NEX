/*
  通用 OpenID Connect 登录的协议层（授权码 + PKCE，ID Token 自己验），给 Pocket ID、Authentik、Keycloak、
  Authelia、Zitadel 这类自建身份提供方（IdP）用。只用 node:crypto，零件和 Google 登录共用（server/oauthPrimitives.ts）。

  和 Google 不一样、要多想一步的地方：

  - **IdP 的地址是管理员填的**，面板要按它去拉 discovery、JWKS、换票、userinfo —— 这就是一个出站请求入口。
    全部走 server/ssrf.ts 的 safeHttpRequest：连接钉在检查过的地址上、不跟随跳转、正文最多 128KB、10 秒超时。
    默认只能连公网；自建 IdP 常在局域网里，管理员勾了「IdP 在内网」才放行内网地址（回环、链路本地、
    云元数据地址照样拦）。discovery 里给的每个端点也走同一套检查，IdP 没法借 discovery 把面板指到别处。
  - **discovery 返回的 issuer 必须和管理员填的一字不差**（OIDC Discovery 4.3）：防「A 的 discovery 冒充 B」。
    ID Token 的 iss 也必须是它；回调里带了 iss 参数（RFC 9207）时同样要对得上 —— 防 IdP 混淆攻击。
  - 验签只认 RS256 / ES256（公钥来自 IdP 的 JWKS，带缓存，按 Cache-Control 刷新，遇到不认识的 kid 最多
    一分钟强刷一次）。alg: none 一律拒绝；HS256/384/512 是拿客户端密钥当 HMAC 钥匙，只有管理员明确勾了
    「接受 HS256」并且填了密钥才认 —— 默认不认（公开的 client_id 配一个弱密钥就能伪造）。
  - 有的 IdP（Authelia 4.39+、Zitadel 默认）ID Token 里不放邮箱，放在 userinfo 里：ID Token 缺邮箱时用
    access_token 调一次 userinfo，并且要求 userinfo 的 sub 和 ID Token 的 sub 相同（OIDC Core 5.3.2）。
  - 令牌（code、id_token、access_token）只在内存里过一下：不进日志、不进 URL、不落库。
*/
import { SafeOutboundError, safeHttpRequest } from "./ssrf";
import {
  ASYMMETRIC_JWS_ALGS,
  HMAC_JWS_ALGS,
  JwksKeyStore,
  OAUTH_RESPONSE_MAX_BYTES,
  parseCompactJws,
  parseJsonObject,
  timingSafeEqualText,
  type JsonObject,
  verifyJwsSignature,
  type AsymmetricJwsAlg,
} from "./oauthPrimitives";

export const OIDC_HTTP_TIMEOUT_MS = 10_000;
export const OIDC_CLOCK_SKEW_SECONDS = 60;
export const OIDC_DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** 同时在换票的回调数上限：到了就直接拒绝，不排队。 */
export const OIDC_MAX_CONCURRENT_EXCHANGES = 32;

export type OidcProtocolErrorCode =
  | "discovery_failed"
  | "exchange_failed"
  | "token_invalid"
  | "email_missing"
  | "email_unverified"
  | "rate_limited";

/** 失败原因是一个短码（跳回登录页用）；message 给日志和管理员的「测试发现」看，不含令牌。 */
export class OidcError extends Error {
  constructor(public readonly code: OidcProtocolErrorCode, message: string) {
    super(message);
    this.name = "OidcError";
  }
}

// ---------- 出站请求 ----------

export type OidcHttpResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
export type OidcHttp = (url: string, init: {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** 出错时日志里的「谁在请求」。 */
  purpose: string;
}) => Promise<OidcHttpResponse>;

/** 默认的出站请求：SSRF 防护 + 不跟随跳转 + 正文封顶 + 超时。allowPrivate 只来自管理员的「IdP 在内网」。 */
export function createOidcHttp(options: { allowPrivate: boolean; isBlockedAddress?: (address: string) => boolean }): OidcHttp {
  return (url, init) => safeHttpRequest(url, {
    method: init.method,
    headers: { "User-Agent": "NEX-Panel-OIDC", Accept: "application/json", ...(init.headers || {}) },
    body: init.body,
    timeoutMs: OIDC_HTTP_TIMEOUT_MS,
    maxBytes: OAUTH_RESPONSE_MAX_BYTES,
    allowPrivate: options.allowPrivate,
    allowLanHostNames: options.allowPrivate,
    isBlockedAddress: options.isBlockedAddress,
    purpose: init.purpose,
  });
}

function headerText(headers: OidcHttpResponse["headers"], name: string) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

function describeHttpFailure(error: unknown) {
  if (error instanceof SafeOutboundError) {
    if (error.code === "blocked") return "目标是内网或受限地址（IdP 在内网时请勾选「IdP 在内网」）";
    if (error.code === "timeout") return "连接超时";
    if (error.code === "too-large") return "响应太大";
    if (error.code === "resolve") return "域名解析失败";
    if (error.code === "invalid-url") return "地址无效";
    return "网络错误";
  }
  return "网络错误";
}

// ---------- discovery ----------

export type OidcDiscovery = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string | null;
  idTokenSigningAlgs: string[];
  tokenEndpointAuthMethods: string[];
  codeChallengeMethods: string[];
  scopesSupported: string[];
  /** RFC 9207：IdP 声明回调里一定带 iss 参数。 */
  authorizationResponseIssParameterSupported: boolean;
};

/** issuer + /.well-known/openid-configuration（issuer 末尾有斜杠时不重复）。 */
export function oidcDiscoveryUrl(issuer: string) {
  return `${String(issuer || "").trim().replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length <= 128).slice(0, 64) : [];
}

function endpointUrl(doc: JsonObject, field: string, options: { allowHttp: boolean; required: boolean }) {
  const raw = doc[field];
  if (raw === undefined || raw === null || raw === "") {
    if (options.required) throw new OidcError("discovery_failed", `discovery 缺少 ${field}`);
    return null;
  }
  if (typeof raw !== "string" || raw.length > 2048) throw new OidcError("discovery_failed", `discovery 的 ${field} 不是合法地址`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcError("discovery_failed", `discovery 的 ${field} 不是合法地址`);
  }
  const httpOk = url.protocol === "http:" && options.allowHttp;
  if (url.protocol !== "https:" && !httpOk) {
    throw new OidcError("discovery_failed", `discovery 的 ${field} 必须是 https 地址${options.allowHttp ? "" : "（IdP 在内网时可勾选「IdP 在内网」）"}`);
  }
  if (url.username || url.password || url.hash) throw new OidcError("discovery_failed", `discovery 的 ${field} 不能带账号密码或 # 片段`);
  return url.toString();
}

/**
 * 校验并整理 discovery 文档。expectedIssuer 是管理员填的原文：返回的 issuer 必须和它完全相同。
 * 只差一个末尾斜杠时也拒绝，但在提示里写明该怎么改（这是最常见的配置错误）。
 */
export function parseOidcDiscovery(text: string, expectedIssuer: string, options: { allowHttp: boolean }): OidcDiscovery {
  const doc = parseJsonObject(text);
  if (!doc) throw new OidcError("discovery_failed", "discovery 返回的不是 JSON 对象");
  const issuer = typeof doc.issuer === "string" ? doc.issuer : "";
  if (!issuer) throw new OidcError("discovery_failed", "discovery 缺少 issuer");
  if (issuer !== expectedIssuer) {
    const sameButSlash = issuer.replace(/\/+$/, "") === expectedIssuer.replace(/\/+$/, "");
    throw new OidcError(
      "discovery_failed",
      sameButSlash
        ? `issuer 不一致：IdP 返回的是 ${issuer.slice(0, 200)}，只差末尾的斜杠 —— 请把 Issuer 改成和它一模一样`
        : `issuer 不一致：IdP 返回的是 ${issuer.slice(0, 200)}，和填写的 Issuer 不同`,
    );
  }
  const responseTypes = stringList(doc.response_types_supported);
  if (responseTypes.length && !responseTypes.some((item) => item.split(" ").includes("code"))) {
    throw new OidcError("discovery_failed", "IdP 不支持授权码模式（response_types_supported 里没有 code）");
  }
  return {
    issuer,
    authorizationEndpoint: endpointUrl(doc, "authorization_endpoint", { ...options, required: true })!,
    tokenEndpoint: endpointUrl(doc, "token_endpoint", { ...options, required: true })!,
    jwksUri: endpointUrl(doc, "jwks_uri", { ...options, required: true })!,
    userinfoEndpoint: endpointUrl(doc, "userinfo_endpoint", { ...options, required: false }),
    idTokenSigningAlgs: stringList(doc.id_token_signing_alg_values_supported),
    tokenEndpointAuthMethods: stringList(doc.token_endpoint_auth_methods_supported),
    codeChallengeMethods: stringList(doc.code_challenge_methods_supported),
    scopesSupported: stringList(doc.scopes_supported),
    authorizationResponseIssParameterSupported: doc.authorization_response_iss_parameter_supported === true,
  };
}

export async function fetchOidcDiscovery(issuer: string, options: { http: OidcHttp; allowHttp: boolean }) {
  let response: OidcHttpResponse;
  try {
    response = await options.http(oidcDiscoveryUrl(issuer), { method: "GET", purpose: "OIDC discovery" });
  } catch (error) {
    throw new OidcError("discovery_failed", `拉取 discovery 失败：${describeHttpFailure(error)}`);
  }
  if (response.status >= 300 && response.status < 400) throw new OidcError("discovery_failed", `discovery 返回了跳转（HTTP ${response.status}），面板不跟随跳转：请检查 Issuer 地址`);
  if (response.status !== 200) throw new OidcError("discovery_failed", `discovery 返回 HTTP ${response.status}`);
  return parseOidcDiscovery(response.body.toString("utf8"), issuer, { allowHttp: options.allowHttp });
}

// ---------- discovery + JWKS 缓存 ----------

type ProviderEntry = { discovery: OidcDiscovery; fetchedAt: number; jwks: JwksKeyStore };

export type OidcProviderConfig = { issuer: string; allowPrivateNetwork: boolean };

/**
 * discovery 文档和 JWKS 的缓存（discovery 一小时，JWKS 按 Cache-Control）。键是 Issuer + 是否放行内网：
 * 管理员改了其中任何一项就是另一份缓存，旧的自然用不上。面板只配一个 IdP，最多留几份。
 */
export class OidcProviderCache {
  private readonly entries = new Map<string, ProviderEntry>();
  private httpFor: ((allowPrivate: boolean) => OidcHttp) | null;

  constructor(private readonly options: {
    httpFor?: (allowPrivate: boolean) => OidcHttp;
    now?: () => number;
    ttlMs?: number;
  } = {}) {
    this.httpFor = options.httpFor ?? null;
  }

  private now() {
    return (this.options.now || Date.now)();
  }

  http(config: OidcProviderConfig) {
    return (this.httpFor || ((allowPrivate) => createOidcHttp({ allowPrivate })))(config.allowPrivateNetwork);
  }

  /** 只给端到端测试用：换成假的 IdP（真 IdP 在回环地址上，SSRF 防护本来就不让连）。null = 恢复默认。 */
  replaceHttpForTests(httpFor: ((allowPrivate: boolean) => OidcHttp) | null) {
    this.httpFor = httpFor;
    this.clear();
  }

  clear() {
    this.entries.clear();
  }

  private key(config: OidcProviderConfig) {
    return JSON.stringify([config.issuer, config.allowPrivateNetwork]);
  }

  async get(config: OidcProviderConfig, options: { forceRefresh?: boolean } = {}): Promise<ProviderEntry> {
    const key = this.key(config);
    const cached = this.entries.get(key);
    if (cached && !options.forceRefresh && this.now() - cached.fetchedAt < (this.options.ttlMs ?? OIDC_DISCOVERY_TTL_MS)) return cached;
    const http = this.http(config);
    const discovery = await fetchOidcDiscovery(config.issuer, { http, allowHttp: config.allowPrivateNetwork });
    // jwks_uri 没变就沿用原来的公钥缓存（不因为 discovery 过期就把公钥也重拉一遍）。
    const jwks = cached && cached.discovery.jwksUri === discovery.jwksUri ? cached.jwks : createOidcJwksStore(discovery.jwksUri, http, this.options.now);
    const entry = { discovery, fetchedAt: this.now(), jwks };
    if (this.entries.size >= 4 && !this.entries.has(key)) this.entries.clear();
    this.entries.set(key, entry);
    return entry;
  }
}

export function createOidcJwksStore(jwksUri: string, http: OidcHttp, now?: () => number) {
  return new JwksKeyStore({
    allowedAlgs: ASYMMETRIC_JWS_ALGS,
    now,
    error: (message) => new OidcError("token_invalid", message),
    load: async () => {
      let response: OidcHttpResponse;
      try {
        response = await http(jwksUri, { method: "GET", purpose: "OIDC JWKS" });
      } catch (error) {
        throw new OidcError("token_invalid", `jwks unreachable: ${describeHttpFailure(error)}`);
      }
      if (response.status !== 200) throw new OidcError("token_invalid", `jwks http_${response.status}`);
      return { data: parseJsonObject(response.body.toString("utf8")), cacheControl: headerText(response.headers, "cache-control") || null };
    },
  });
}

// ---------- 授权地址 ----------

export function buildOidcAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  nonce: string;
}) {
  // 授权端点本身可能带查询参数（OIDC 允许），用 URL 追加而不是拼字符串。
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * 回调里的 iss 参数（RFC 9207）：带了就必须是我们的 issuer；IdP 在 discovery 里声明了会带、却没带，也不认。
 * 返回 true 表示没问题。
 */
export function authorizationResponseIssuerOk(queryIss: unknown, discovery: Pick<OidcDiscovery, "issuer" | "authorizationResponseIssParameterSupported">) {
  if (queryIss === undefined || queryIss === null || queryIss === "") return !discovery.authorizationResponseIssParameterSupported;
  return typeof queryIss === "string" && timingSafeEqualText(queryIss, discovery.issuer);
}

// ---------- 换票 ----------

/** application/x-www-form-urlencoded 的编码（RFC 6749 2.3.1：Basic 认证里的 ID 和密钥要先这样编码）。 */
function formEncode(value: string) {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/**
 * 客户端怎么在 token 端点认证自己：没有密钥 = 公开客户端（none，只靠 PKCE）；
 * 有密钥时 IdP 支持 client_secret_basic（也是没声明时的默认值）就用它，只支持 client_secret_post 才放表单里。
 */
export function chooseTokenEndpointAuthMethod(supported: readonly string[], hasSecret: boolean): "none" | "client_secret_basic" | "client_secret_post" {
  if (!hasSecret) return "none";
  if (!supported.length || supported.includes("client_secret_basic")) return "client_secret_basic";
  if (supported.includes("client_secret_post")) return "client_secret_post";
  return "client_secret_basic";
}

let activeExchanges = 0;

/** 用授权码 + code_verifier 换令牌。返回 id_token，和调 userinfo 要用的 access_token（可能没有）。 */
export async function exchangeOidcAuthorizationCode(input: {
  http: OidcHttp;
  tokenEndpoint: string;
  authMethods: readonly string[];
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ idToken: string; accessToken: string | null }> {
  if (activeExchanges >= OIDC_MAX_CONCURRENT_EXCHANGES) throw new OidcError("rate_limited", "too many concurrent token exchanges");
  activeExchanges += 1;
  try {
    const method = chooseTokenEndpointAuthMethod(input.authMethods, !!input.clientSecret);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (method === "client_secret_basic") {
      headers.Authorization = `Basic ${Buffer.from(`${formEncode(input.clientId)}:${formEncode(input.clientSecret)}`).toString("base64")}`;
    } else {
      body.set("client_id", input.clientId);
      if (method === "client_secret_post") body.set("client_secret", input.clientSecret);
    }
    let response: OidcHttpResponse;
    try {
      response = await input.http(input.tokenEndpoint, { method: "POST", headers, body: body.toString(), purpose: "OIDC token" });
    } catch (error) {
      throw new OidcError("exchange_failed", `token endpoint unreachable: ${describeHttpFailure(error)}`);
    }
    const data = parseJsonObject(response.body.toString("utf8"));
    if (response.status !== 200) {
      // 错误体是 { error, error_description }，不含令牌；只记 error 码，而且只留安全字符。
      const reason = typeof data?.error === "string" ? data.error.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) : `http_${response.status}`;
      throw new OidcError("exchange_failed", `token endpoint rejected: ${reason || `http_${response.status}`}`);
    }
    const idToken = typeof data?.id_token === "string" ? data.id_token : "";
    if (!idToken) throw new OidcError("exchange_failed", "token endpoint returned no id_token (scope 里有 openid 吗？)");
    const accessToken = typeof data?.access_token === "string" && data.access_token ? data.access_token : null;
    return { idToken, accessToken };
  } finally {
    activeExchanges -= 1;
  }
}

// ---------- ID Token ----------

export type OidcIdTokenClaims = {
  sub: string;
  /** 小写；没给或格式不对是 null。 */
  email: string | null;
  /** true / false；IdP 没说是 null。 */
  emailVerified: boolean | null;
  name: string | null;
  preferredUsername: string | null;
  iat: number;
  exp: number;
};

function textClaim(value: unknown, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function emailClaim(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email && email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

function emailVerifiedClaim(value: unknown) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/**
 * 校验 ID Token，通过才返回要用的几项声明。任何一项不对都抛 OidcError("token_invalid")。
 * 邮箱是否存在 / 已验证不在这里判（可能要先用 userinfo 补），见 evaluateOidcEmail。now 是秒，测试里可以拨钟。
 */
export async function verifyOidcIdToken(idToken: string, options: {
  issuer: string;
  clientId: string;
  nonce: string;
  keys: Pick<JwksKeyStore, "getKey">;
  /** 管理员勾了「接受 HS256」才是 true；同时必须有客户端密钥。 */
  allowHmac: boolean;
  clientSecret: string;
  nowSeconds?: number;
  clockSkewSeconds?: number;
}): Promise<OidcIdTokenClaims> {
  const invalid = (why: string) => new OidcError("token_invalid", `id_token ${why}`);
  const jws = parseCompactJws(idToken);
  if (!jws) throw invalid("malformed");
  const { header, payload } = jws;
  const alg = typeof header.alg === "string" ? header.alg : "";
  // 带 crit 的扩展头我们不认识，按 RFC 7515 必须拒绝；typ 是 at+jwt 的是访问令牌，不能当身份凭据用。
  if (header.crit !== undefined) throw invalid("crit");
  if (typeof header.typ === "string" && /^(application\/)?at\+jwt$/i.test(header.typ)) throw invalid("typ");

  if ((ASYMMETRIC_JWS_ALGS as readonly string[]).includes(alg)) {
    const kid = typeof header.kid === "string" && header.kid ? header.kid : null;
    const key = await options.keys.getKey(kid, alg as AsymmetricJwsAlg);
    if (!verifyJwsSignature(alg, key, jws.signingInput, jws.signature)) throw invalid("signature");
  } else if ((HMAC_JWS_ALGS as readonly string[]).includes(alg) && options.allowHmac && options.clientSecret) {
    if (!verifyJwsSignature(alg, { hmacSecret: options.clientSecret }, jws.signingInput, jws.signature)) throw invalid("signature");
  } else {
    // none、没勾选时的 HS*、以及别的一切
    throw invalid("alg");
  }

  if (typeof payload.iss !== "string" || payload.iss !== options.issuer) throw invalid("iss");
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
  const skew = options.clockSkewSeconds ?? OIDC_CLOCK_SKEW_SECONDS;
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);
  if (!Number.isFinite(exp) || exp + skew <= now) throw invalid("expired");
  if (!Number.isFinite(iat) || iat - skew > now) throw invalid("iat");
  if (payload.nbf !== undefined && (!Number.isFinite(Number(payload.nbf)) || Number(payload.nbf) - skew > now)) throw invalid("nbf");

  if (typeof payload.nonce !== "string" || !timingSafeEqualText(payload.nonce, options.nonce)) throw invalid("nonce");

  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub || sub.length > 191 || sub !== payload.sub) throw invalid("sub"); // 库里 oidcSub 是 varchar(191)

  return {
    sub,
    email: emailClaim(payload.email),
    emailVerified: emailVerifiedClaim(payload.email_verified),
    name: textClaim(payload.name, 64),
    preferredUsername: textClaim(payload.preferred_username, 64),
    iat,
    exp,
  };
}

// ---------- userinfo ----------

export async function fetchOidcUserInfo(input: { http: OidcHttp; endpoint: string; accessToken: string }) {
  let response: OidcHttpResponse;
  try {
    response = await input.http(input.endpoint, { method: "GET", headers: { Authorization: `Bearer ${input.accessToken}` }, purpose: "OIDC userinfo" });
  } catch (error) {
    throw new OidcError("exchange_failed", `userinfo unreachable: ${describeHttpFailure(error)}`);
  }
  if (response.status !== 200) throw new OidcError("exchange_failed", `userinfo http_${response.status}`);
  // 签名 / 加密过的 userinfo（application/jwt）没接：这种 IdP 一般 ID Token 里本来就有邮箱。
  if (/application\/jwt/i.test(headerText(response.headers, "content-type"))) throw new OidcError("exchange_failed", "userinfo is a JWT (unsupported)");
  const data = parseJsonObject(response.body.toString("utf8"));
  if (!data) throw new OidcError("exchange_failed", "userinfo is not a JSON object");
  return data;
}

/** ID Token 缺邮箱 / 缺 email_verified 时要不要去问 userinfo。 */
export function needsUserInfo(claims: OidcIdTokenClaims) {
  return !claims.email || claims.emailVerified === null;
}

/**
 * 把 userinfo 补进 ID Token 的声明里。userinfo 的 sub 必须和 ID Token 一样（不然可能是别人的令牌）。
 * ID Token 自己有的邮箱优先；只有邮箱一致时才拿 userinfo 的 email_verified 补空。
 */
export function mergeOidcUserInfo(claims: OidcIdTokenClaims, userinfo: JsonObject): OidcIdTokenClaims {
  if (typeof userinfo.sub !== "string" || userinfo.sub !== claims.sub) throw new OidcError("token_invalid", "userinfo sub mismatch");
  const infoEmail = emailClaim(userinfo.email);
  const infoVerified = emailVerifiedClaim(userinfo.email_verified);
  const merged = { ...claims };
  if (!claims.email && infoEmail) {
    merged.email = infoEmail;
    merged.emailVerified = infoVerified;
  } else if (claims.email && claims.emailVerified === null && infoEmail === claims.email) {
    merged.emailVerified = infoVerified;
  }
  merged.name = claims.name ?? textClaim(userinfo.name, 64);
  merged.preferredUsername = claims.preferredUsername ?? textClaim(userinfo.preferred_username, 64);
  return merged;
}

/**
 * 邮箱这一关：必须有邮箱（面板按邮箱挡重复注册、做域名限制）；管理员要求「只接受已验证邮箱」时
 * email_verified 必须明确是 true —— IdP 没说（null）也不算验证过。
 */
export function evaluateOidcEmail(claims: Pick<OidcIdTokenClaims, "email" | "emailVerified">, options: { requireVerifiedEmail: boolean }) {
  if (!claims.email) throw new OidcError("email_missing", "no email in id_token / userinfo");
  if (options.requireVerifiedEmail && claims.emailVerified !== true) throw new OidcError("email_unverified", "email not verified");
  return { email: claims.email, emailVerified: claims.emailVerified === true };
}
