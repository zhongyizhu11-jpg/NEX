/*
  通用 OIDC 登录的两个浏览器入口（不是 tRPC：要做整页跳转）：

    GET  /api/auth/oidc/start?mode=login|link&redirect=/相对路径[&invite=邀请码]
         → 读 discovery，生成 state / PKCE / nonce，种「浏览器绑定」cookie，302 去 IdP 的授权页
    GET  /api/auth/oidc/callback?code=…&state=…[&iss=…]
         → 校验 state（一次性）+ cookie + iss，换票，验 ID Token（必要时补 userinfo），按规则登录 / 绑定 / 注册

  所有失败都跳回 /login?oidcError=<码>（绑定时 /profile?oidcError=<码>），URL 和日志里都不出现 code、令牌或完整邮箱。
  会话和密码登录走同一个 createLoginSession（server/oauthRouteHelpers.ts）：cookie、单设备策略、维护模式、
  停用账户检查都一样；账户开了双重验证时先发 2FA 挑战 —— IdP 账号被盗不应该绕过面板自己的 2FA。
  API 令牌发起不了绑定（createContext 认出是令牌就当没登录），登录本身不认任何令牌。

  和 Google 登录（server/googleAuthRoute.ts）的区别只在协议细节（discovery、iss、userinfo），见 server/oidcClient.ts。
  App 里的「系统浏览器 + 轮询」流程没有接：App 登录页不显示这个按钮。
*/
import express, { type Request, type Response } from "express";
import * as db from "./db";
import { createContext } from "./_core/context";
import { maskIdentifier } from "./routers/helpers";
import { recordPanelEvent } from "./ops/panelEvents";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { SlidingWindowRateLimiter } from "./ai/rateLimiter";
import { sanitizeGoogleInviteCode, sanitizeRedirectPath } from "../shared/googleLogin";
import { OIDC_CALLBACK_PATH, OIDC_START_PATH, type OidcLoginErrorCode, type OidcLoginMode } from "../shared/oidcLogin";
import { OAuthStateStore, OAUTH_STATE_TTL_MS, randomUrlToken, timingSafeEqualText } from "./oauthPrimitives";
import {
  authorizationResponseIssuerOk,
  buildOidcAuthorizationUrl,
  evaluateOidcEmail,
  exchangeOidcAuthorizationCode,
  fetchOidcUserInfo,
  mergeOidcUserInfo,
  needsUserInfo,
  OidcError,
  OidcProviderCache,
  verifyOidcIdToken,
} from "./oidcClient";
import { isOidcLoginConfigured, isOidcLoginUsable, oidcConfigFingerprint, readOidcLoginSettings } from "./oidcLoginSettings";
import { resolveOidcSignIn } from "./oidcLoginService";
import { isEmailTakenByAnyUser, isUsernameTaken } from "./repositories/googleAccountRepository";
import { getUserByOidcIdentity, linkOidcAccount, recordOidcSignIn } from "./repositories/oidcAccountRepository";
import {
  getOAuthRegistrationPolicy,
  issueOAuthSessionOrChallenge,
  noStore,
  oauthRequestIp,
  oauthSessionErrorCode,
  requestMatchesPanelHost,
  withQuery,
} from "./oauthRouteHelpers";

export const OIDC_BINDING_COOKIE = "nex_oidc_oauth";
const OIDC_COOKIE_PATH = "/api/auth/oidc";

export const oidcAuthStates = new OAuthStateStore<OidcLoginMode>();
/** discovery + JWKS 缓存。设置页「测试发现」和保存设置时会清空它。 */
export const oidcProviders = new OidcProviderCache();

/** 每个来源一分钟最多发起 20 次。 */
export const oidcStartLimiter = new SlidingWindowRateLimiter({ limit: 20, windowMs: 60_000, maxKeys: 50_000 });

const requestIp = (req: Request) => oauthRequestIp(req);

function bindingCookieOptions(req: Request) {
  return {
    httpOnly: true,
    secure: req.secure === true || req.protocol === "https",
    sameSite: "lax" as const,
    path: OIDC_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_MS,
  };
}

function readBindingCookie(req: Request) {
  const value = req.cookies?.[OIDC_BINDING_COOKIE];
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value) ? value : "";
}

function failureRedirect(res: Response, mode: OidcLoginMode | null, code: OidcLoginErrorCode) {
  noStore(res);
  res.redirect(302, withQuery(mode === "link" ? "/profile" : "/login", { oidcError: code }));
}

function displayName(user: { id?: number; name?: string | null; username?: string | null } | null | undefined) {
  return String(user?.name || user?.username || `#${user?.id}`).slice(0, 60);
}

const signInDeps = {
  getUserByOidcIdentity,
  getUserById: (id: number) => db.getUserById(id),
  linkOidcAccount,
  isEmailTakenByAnyUser,
  isUsernameTaken,
  // 和密码注册同一个入口：注册加的门槛（邀请码、返利）在这条路上也一样。
  registerUser: (data: Parameters<typeof db.registerUser>[0]) => db.registerUser(data),
  resolveInviter: (inviteCode: string | null) => db.resolveRegistrationInviter(inviteCode),
  getRegistrationPolicy: getOAuthRegistrationPolicy,
};

async function handleStart(req: Request, res: Response) {
  noStore(res);
  const ip = requestIp(req);
  const settings = readOidcLoginSettings(await db.getAllSettings());
  const mode: OidcLoginMode = req.query.mode === "link" ? "link" : "login";
  const fail = (code: OidcLoginErrorCode) => failureRedirect(res, mode, code);

  if (!isOidcLoginUsable(settings)) return fail(settings.enabled && !isOidcLoginConfigured(settings) ? "not_configured" : "disabled");

  // 回调地址固定在面板公开地址上：从别的域名点进来的，先换到公开地址再开始，
  // 浏览器绑定 cookie 和最后的会话 cookie 才会落在同一个域名下。canon=1 防反代不传 Host 时绕圈。
  if (!requestMatchesPanelHost(req, settings.panelBaseUrl) && req.query.canon !== "1") {
    const target = new URL(`${settings.panelBaseUrl}${OIDC_START_PATH}`);
    for (const key of ["mode", "redirect", "invite"]) {
      const value = req.query[key];
      if (typeof value === "string" && value) target.searchParams.set(key, value);
    }
    target.searchParams.set("canon", "1");
    return res.redirect(302, target.toString());
  }

  if (!oidcStartLimiter.consume(`oidc-start:${ipRateLimitScope(ip)}`).allowed) return fail("rate_limited");

  let userId: number | null = null;
  if (mode === "link") {
    const ctx = await createContext({ req, res } as Parameters<typeof createContext>[0]);
    if (!ctx.user || ctx.apiToken) return failureRedirect(res, "login", "link_requires_login");
    userId = ctx.user.id;
  }

  let authorizationEndpoint: string;
  try {
    authorizationEndpoint = (await oidcProviders.get(settings)).discovery.authorizationEndpoint;
  } catch (error) {
    console.warn(`[OidcAuth] start discovery failed mode=${mode} ip=${ip}: ${error instanceof Error ? error.message : String(error)}`);
    return fail("discovery_failed");
  }

  const binding = readBindingCookie(req) || randomUrlToken(32);
  res.cookie(OIDC_BINDING_COOKIE, binding, bindingCookieOptions(req));
  const redirectPath = sanitizeRedirectPath(req.query.redirect, mode === "link" ? "/profile" : "/");
  const inviteCode = mode === "login" ? sanitizeGoogleInviteCode(req.query.invite) : null;
  const created = oidcAuthStates.create({
    mode, redirectPath, userId, appFlowId: null, binding, inviteCode,
    configHash: oidcConfigFingerprint(settings),
  });
  console.info(`[OidcAuth] start mode=${mode} ip=${ip}`);
  return res.redirect(302, buildOidcAuthorizationUrl({
    authorizationEndpoint,
    clientId: settings.clientId,
    redirectUri: settings.redirectUri,
    scopes: settings.scopes,
    state: created.state,
    codeChallenge: created.codeChallenge,
    nonce: created.nonce,
  }));
}

async function handleCallback(req: Request, res: Response) {
  noStore(res);
  const ip = requestIp(req);
  const entry = oidcAuthStates.consume(req.query.state, readBindingCookie(req));
  if (!entry) {
    console.warn(`[OidcAuth] callback rejected: state missing/expired/mismatched ip=${ip}`);
    return failureRedirect(res, null, "state_invalid");
  }
  const mode = entry.mode;
  const fail = (code: OidcLoginErrorCode) => failureRedirect(res, mode, code);

  if (typeof req.query.error === "string") {
    const cancelled = req.query.error === "access_denied";
    console.info(`[OidcAuth] callback error from IdP mode=${mode} error=${req.query.error.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)} ip=${ip}`);
    return fail(cancelled ? "cancelled" : "idp_error");
  }
  const settings = readOidcLoginSettings(await db.getAllSettings());
  if (!isOidcLoginUsable(settings)) return fail("disabled");
  // 发起之后管理员改了 Issuer / 客户端 / 密钥 / 面板地址：这次登录作废，不拿旧配置下的授权码去换票。
  if (!entry.configHash || !timingSafeEqualText(entry.configHash, oidcConfigFingerprint(settings))) {
    console.warn(`[OidcAuth] callback rejected: OIDC config changed since start mode=${mode} ip=${ip}`);
    return fail("state_invalid");
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code || code.length > 4096) return fail("state_invalid");

  let provider;
  try {
    provider = await oidcProviders.get(settings);
  } catch (error) {
    console.warn(`[OidcAuth] callback discovery failed mode=${mode} ip=${ip}: ${error instanceof Error ? error.message : String(error)}`);
    return fail("discovery_failed");
  }
  const { discovery } = provider;
  // RFC 9207：回调里的 iss 必须是我们的 IdP（防「另一个 IdP 的授权码被送到这里」的混淆攻击）。
  if (!authorizationResponseIssuerOk(req.query.iss, discovery)) {
    console.warn(`[OidcAuth] callback rejected: iss parameter mismatch mode=${mode} ip=${ip}`);
    return fail("token_invalid");
  }

  let claims;
  let email: { email: string; emailVerified: boolean };
  try {
    const http = oidcProviders.http(settings);
    const tokens = await exchangeOidcAuthorizationCode({
      http,
      tokenEndpoint: discovery.tokenEndpoint,
      authMethods: discovery.tokenEndpointAuthMethods,
      code,
      codeVerifier: entry.codeVerifier,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      redirectUri: settings.redirectUri,
    });
    claims = await verifyOidcIdToken(tokens.idToken, {
      issuer: discovery.issuer,
      clientId: settings.clientId,
      nonce: entry.nonce,
      keys: provider.jwks,
      allowHmac: settings.allowHmacTokens,
      clientSecret: settings.clientSecret,
    });
    if (needsUserInfo(claims) && discovery.userinfoEndpoint && tokens.accessToken) {
      claims = mergeOidcUserInfo(claims, await fetchOidcUserInfo({ http, endpoint: discovery.userinfoEndpoint, accessToken: tokens.accessToken }));
    }
    email = evaluateOidcEmail(claims, { requireVerifiedEmail: settings.requireVerifiedEmail });
  } catch (error) {
    const reason: OidcLoginErrorCode = error instanceof OidcError ? error.code : "server_error";
    console.warn(`[OidcAuth] callback ${reason} mode=${mode} ip=${ip}: ${error instanceof Error ? error.message : String(error)}`);
    return fail(reason);
  }

  let sessionUserId: number | null = null;
  if (mode === "link") {
    const ctx = await createContext({ req, res } as Parameters<typeof createContext>[0]);
    sessionUserId = ctx.user && !ctx.apiToken ? ctx.user.id : null;
  }

  const issuer = discovery.issuer;
  const outcome = await withKeyedTaskLock(`oidc-sub:${issuer}\n${claims.sub}`, () => resolveOidcSignIn({
    mode,
    issuer,
    claims,
    email: email.email,
    emailVerified: email.emailVerified,
    allowRegistration: settings.allowRegistration,
    allowedDomains: settings.allowedDomains,
    linkUserId: entry.userId,
    sessionUserId,
    inviteCode: entry.inviteCode ?? null,
  }, signInDeps)).catch((error) => {
    console.error(`[OidcAuth] resolve failed mode=${mode} ip=${ip}: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: "error" as const, code: "server_error" as const };
  });

  if (outcome.kind === "error") {
    console.warn(`[OidcAuth] rejected mode=${mode} code=${outcome.code} email=${maskIdentifier(email.email)} ip=${ip}`);
    return fail(outcome.code);
  }

  if (outcome.kind === "linked") {
    if (!outcome.alreadyLinked) {
      console.info(`[OidcAuth] linked userId=${outcome.user.id} email=${maskIdentifier(email.email)} ip=${ip}`);
      void recordPanelEvent({
        kind: "account.oidc_linked",
        level: "info",
        userId: outcome.user.id,
        message: `${displayName(outcome.user)} 绑定了 ${settings.providerName} 账号 ${maskIdentifier(email.email)}`,
        data: { ip },
      });
    }
    return res.redirect(302, withQuery(entry.redirectPath, { oidcLinked: "1" }));
  }

  const user = outcome.user;
  await recordOidcSignIn(user.id, email.email).catch(() => undefined);
  if (outcome.created) {
    console.info(`[OidcAuth] registered userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
    void recordPanelEvent({
      kind: "account.oidc_registered",
      level: "info",
      userId: user.id,
      message: `${displayName(user)} 用 ${settings.providerName} 账号 ${maskIdentifier(email.email)} 注册了新账号`,
      data: { ip },
    });
  }

  try {
    const result = await issueOAuthSessionOrChallenge({ req, res }, user, { mobile: false, ip });
    if (result && typeof result === "object" && "twoFactorRequired" in result && result.twoFactorRequired === true) {
      // 挑战 ID 放在 # 后面：不会发给服务器，也不会出现在 Referer 里；登录页读到后立刻从地址栏抹掉。
      const fragment = new URLSearchParams({
        oidcTwoFactor: result.challengeId,
        u: result.username,
        exp: String(result.expiresInSeconds),
        next: entry.redirectPath,
      });
      console.info(`[OidcAuth] login needs 2FA userId=${user.id} ip=${ip}`);
      return res.redirect(302, `/login#${fragment.toString()}`);
    }
  } catch (error) {
    const reason = oauthSessionErrorCode(error);
    console.warn(`[OidcAuth] session rejected userId=${user.id} code=${reason} ip=${ip}`);
    return fail(reason);
  }
  console.info(`[Auth] OIDC login success userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
  void recordPanelEvent({
    kind: "account.login",
    level: "info",
    userId: user.id,
    message: `${displayName(user)} 用 ${settings.providerName} 账号登录`,
    data: { method: "oidc", ip },
  });
  return res.redirect(302, entry.redirectPath);
}

function safe(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error) => {
      console.error(`[OidcAuth] ${req.path} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) failureRedirect(res, null, "server_error");
    });
  };
}

export const oidcAuthRouter = express.Router();
oidcAuthRouter.get(OIDC_START_PATH, safe(handleStart));
oidcAuthRouter.get(OIDC_CALLBACK_PATH, safe(handleCallback));

const cleanupTimer = setInterval(() => {
  oidcAuthStates.prune();
}, 5 * 60 * 1000);
cleanupTimer.unref?.();
