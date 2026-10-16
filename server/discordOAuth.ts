/*
  Discord 登录的协议层（OAuth 2.0 授权码 + PKCE），只用 fetch 和 node:crypto。

  和 Google 不一样的地方：Discord 不是 OpenID Connect，没有 ID Token、没有 nonce。
  身份来自「用 access_token 调 GET /users/@me」：令牌是我们自己经 TLS 从 Discord 的 token
  端点换来的（带 client_secret），所以 @me 的返回就是可信的。认人只认返回里的 id（雪花），
  邮箱只有在 verified === true 时才用。

  - 每次发起登录生成 state（32 字节）和 PKCE code_verifier（32 字节，challenge 用 S256）。
    它们**只放在服务端内存**里，以 state 为键，10 分钟过期，取一次就删。浏览器手里只有一个
    「浏览器绑定」cookie（HttpOnly、SameSite=Lax），服务端存它的哈希：回调时 state 对得上、
    cookie 也对得上才算数（防登录 CSRF，绑定模式下也不会把别人的 Discord 绑到你头上）。
    PKCE 对机密客户端不是必须的，照样带上：多一道不贵。
  - 换票用 client_secret_post（表单里带 client_id / client_secret）。
  - 拿到 @me 之后立刻把 access_token 吊销掉（尽力而为，失败不影响登录）：面板以后不再需要它。
  - 令牌（code、access_token、refresh_token）只在内存里过一下：不进日志、不进 URL、不落库。
*/
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";
import { createPkcePair, randomUrlToken, sha256Base64Url, timingSafeEqualText, type FetchLike } from "./googleOidc";
import { isDiscordSnowflake, type DiscordLoginMode } from "../shared/discordLogin";

export const DISCORD_AUTHORIZATION_ENDPOINT = "https://discord.com/oauth2/authorize";
export const DISCORD_TOKEN_ENDPOINT = "https://discord.com/api/oauth2/token";
export const DISCORD_REVOKE_ENDPOINT = "https://discord.com/api/oauth2/token/revoke";
export const DISCORD_USER_ENDPOINT = "https://discord.com/api/users/@me";
export const DISCORD_SCOPE = "identify email";

export const DISCORD_STATE_TTL_MS = 10 * 60 * 1000;
export const DISCORD_STATE_MAX_ENTRIES = 10_000;
const DISCORD_HTTP_TIMEOUT_MS = 10_000;

export type DiscordOAuthErrorCode = "state_invalid" | "exchange_failed" | "profile_invalid" | "email_unverified";

/** 失败原因只是一个短码，调用方据此跳回登录页；message 只给日志看（不含令牌）。 */
export class DiscordOAuthError extends Error {
  constructor(public readonly code: DiscordOAuthErrorCode, message: string) {
    super(message);
    this.name = "DiscordOAuthError";
  }
}

// ---------- state 存储 ----------

export type DiscordAuthStateEntry = {
  mode: DiscordLoginMode;
  /** 登录成功后跳回的相对路径（已经过 sanitizeRedirectPath）。 */
  redirectPath: string;
  codeVerifier: string;
  /** 浏览器绑定 cookie 的 sha256。 */
  bindingHash: string;
  /** 绑定模式：发起时登录着的用户；回调时必须还是这个人。 */
  userId: number | null;
  /** App 模式：对应的 App 登录流程。 */
  appFlowId: string | null;
  /** 从邀请链接进来时的邀请码（已过 sanitizeDiscordInviteCode），只在 Discord 注册新账号时用。 */
  inviteCode: string | null;
  createdAt: number;
  expiresAt: number;
};

export type DiscordAuthStateInput = {
  mode: DiscordLoginMode;
  redirectPath: string;
  userId: number | null;
  appFlowId: string | null;
  inviteCode?: string | null;
  binding: string;
};

export class DiscordAuthStateStore {
  private readonly entries = new Map<string, DiscordAuthStateEntry>();

  constructor(private readonly options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {}

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

  /** 发起一次登录：返回 state 和给 Discord 的 code_challenge。 */
  create(input: DiscordAuthStateInput) {
    this.prune();
    const now = this.now();
    const state = randomUrlToken(32);
    const pkce = createPkcePair();
    const entry: DiscordAuthStateEntry = {
      mode: input.mode,
      redirectPath: input.redirectPath,
      userId: input.userId,
      appFlowId: input.appFlowId,
      inviteCode: input.inviteCode ?? null,
      codeVerifier: pkce.verifier,
      bindingHash: sha256Base64Url(input.binding),
      createdAt: now,
      expiresAt: now + (this.options.ttlMs ?? DISCORD_STATE_TTL_MS),
    };
    setBoundedMapValue(this.entries, state, entry, this.options.maxEntries ?? DISCORD_STATE_MAX_ENTRIES);
    return { state, codeChallenge: pkce.challenge, entry };
  }

  /**
   * 取出并作废。不管后面成不成功，一个 state 只能用一次；过期、cookie 对不上一律 null。
   * 先删后判：哪怕 cookie 不对，这个 state 也废了（拿着它反复试 cookie 没有意义）。
   */
  consume(state: unknown, binding: unknown): DiscordAuthStateEntry | null {
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

export function buildDiscordAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }) {
  const url = new URL(DISCORD_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DISCORD_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // 每次都让用户在 Discord 页面上看一眼要授权给谁（不静默跳过），换账号也方便。
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

// ---------- 换票 ----------

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 用授权码 + code_verifier 换 access_token（client_secret_post）。 */
export async function exchangeDiscordAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  let response: Response;
  try {
    response = await (input.fetchImpl || fetch)(DISCORD_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(DISCORD_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DiscordOAuthError("exchange_failed", `token endpoint unreachable: ${error instanceof Error ? error.name : "error"}`);
  }
  const data: any = await readJson(response);
  if (!response.ok) {
    // 错误体是 { error, error_description }，不含令牌，可以记下 error 码。
    const reason = typeof data?.error === "string" ? data.error.slice(0, 64) : `http_${response.status}`;
    throw new DiscordOAuthError("exchange_failed", `token endpoint rejected: ${reason}`);
  }
  const accessToken = typeof data?.access_token === "string" ? data.access_token : "";
  if (!accessToken || accessToken.length > 4096) throw new DiscordOAuthError("exchange_failed", "token endpoint returned no access_token");
  if (typeof data?.token_type === "string" && data.token_type.toLowerCase() !== "bearer") {
    throw new DiscordOAuthError("exchange_failed", "token endpoint returned a non-bearer token");
  }
  // 用户在授权页上可以取消勾选 email：没给 email 权限就拿不到邮箱，按「邮箱未验证」处理。
  const scopes = typeof data?.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : [];
  if (scopes.length && !scopes.includes("identify")) throw new DiscordOAuthError("profile_invalid", "token lacks identify scope");
  return { accessToken, scopes };
}

export type DiscordProfile = {
  /** Discord 用户 ID（雪花，永不变）。 */
  id: string;
  /** 新用户名（全小写，可以改）。 */
  username: string;
  /** 显示名（可以没有）。 */
  globalName: string | null;
  /** 已验证的邮箱（小写）。 */
  email: string;
};

/** 用 access_token 读 /users/@me。邮箱必须存在且 verified === true。 */
export async function fetchDiscordProfile(input: { accessToken: string; fetchImpl?: FetchLike }): Promise<DiscordProfile> {
  let response: Response;
  try {
    response = await (input.fetchImpl || fetch)(DISCORD_USER_ENDPOINT, {
      headers: { Authorization: `Bearer ${input.accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(DISCORD_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DiscordOAuthError("exchange_failed", `users/@me unreachable: ${error instanceof Error ? error.name : "error"}`);
  }
  const data: any = await readJson(response);
  if (!response.ok) throw new DiscordOAuthError("exchange_failed", `users/@me http_${response.status}`);
  return parseDiscordProfile(data);
}

/** 校验 /users/@me 的返回，通过才给出我们要用的几项。任何一项不对都抛 DiscordOAuthError。 */
export function parseDiscordProfile(data: any): DiscordProfile {
  const invalid = (why: string) => new DiscordOAuthError("profile_invalid", `users/@me ${why}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid("malformed");
  // id 是字符串形式的雪花；数字形式（会丢精度）不认。
  if (!isDiscordSnowflake(data.id)) throw invalid("id");
  if (data.bot === true || data.system === true) throw invalid("bot account");
  const username = typeof data.username === "string" ? data.username.trim().slice(0, 64) : "";
  if (!username) throw invalid("username");
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  // verified 必须严格等于 true：没给 email 权限时这两项都不出现。
  if (!email || data.verified !== true) throw new DiscordOAuthError("email_unverified", "users/@me email missing or unverified");
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw invalid("email");
  const globalName = typeof data.global_name === "string" && data.global_name.trim() ? data.global_name.trim().slice(0, 64) : null;
  return { id: data.id, username, globalName, email };
}

/** 吊销 access_token（尽力而为）：面板拿到身份之后就不再需要它。 */
export async function revokeDiscordToken(input: { token: string; clientId: string; clientSecret: string; fetchImpl?: FetchLike }) {
  try {
    const response = await (input.fetchImpl || fetch)(DISCORD_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: input.token,
        token_type_hint: "access_token",
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(DISCORD_HTTP_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
