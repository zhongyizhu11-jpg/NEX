/*
  Discord 登录的浏览器入口（不是 tRPC：要做整页跳转），和 Google 登录一一对应：

    GET  /api/auth/discord/start?mode=login|link|app&redirect=/相对路径[&flow=App流程][&invite=邀请码]
         → 生成 state / PKCE，种「浏览器绑定」cookie，302 去 Discord
    GET  /api/auth/discord/callback?code=…&state=…
         → 校验 state（一次性）+ cookie，换票，读 /users/@me，按规则登录 / 绑定 / 注册
    POST /api/auth/discord/app-confirm
         → App 流程里 IP 对不上时，浏览器那页「确认登录到 App」的按钮

  所有失败都跳回 /login?discordError=<码>（绑定时 /profile?discordError=<码>，App 流程显示一页说明），
  URL 和日志里都不出现 code、令牌或完整邮箱。
  会话和密码登录走同一个 createLoginSession；账户开了双重验证时，先发 2FA 挑战。
*/
import express, { type Request, type Response } from "express";
import * as db from "./db";
import { createContext } from "./_core/context";
import { maskIdentifier } from "./routers/helpers";
import { recordPanelEvent } from "./ops/panelEvents";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { SlidingWindowRateLimiter } from "./ai/rateLimiter";
import { sanitizeRedirectPath } from "../shared/googleLogin";
import {
  DISCORD_APP_CONFIRM_PATH,
  DISCORD_CALLBACK_PATH,
  DISCORD_START_PATH,
  discordLoginErrorMessage,
  sanitizeDiscordInviteCode,
  type DiscordLoginErrorCode,
  type DiscordLoginMode,
} from "../shared/discordLogin";
import { randomUrlToken } from "./googleOidc";
import {
  buildDiscordAuthorizationUrl,
  DiscordAuthStateStore,
  DiscordOAuthError,
  DISCORD_STATE_TTL_MS,
  exchangeDiscordAuthorizationCode,
  fetchDiscordProfile,
  revokeDiscordToken,
} from "./discordOAuth";
import { isDiscordLoginConfigured, isDiscordLoginUsable, readDiscordLoginSettings } from "./discordSettings";
import { DiscordAppFlowStore, resolveDiscordSignIn } from "./discordLoginService";
import { isEmailTakenByAnyUser, isUsernameTaken } from "./repositories/googleAccountRepository";
import { getUserByDiscordId, linkDiscordAccount, recordDiscordSignIn } from "./repositories/discordAccountRepository";
import {
  getOAuthRegistrationPolicy,
  issueOAuthSessionOrChallenge,
  noStore,
  oauthRequestIp,
  oauthSessionErrorCode,
  renderOAuthAppPage,
  requestMatchesPanelHost,
  withQuery,
  type OAuthAppPage,
} from "./oauthRouteHelpers";

export const DISCORD_BINDING_COOKIE = "nex_discord_oauth";
const DISCORD_COOKIE_PATH = "/api/auth/discord";

export const discordAuthStates = new DiscordAuthStateStore();
export const discordAppFlows = new DiscordAppFlowStore();

/** 每个来源一分钟最多发起 20 次（网页 + App 一起算）。 */
export const discordStartLimiter = new SlidingWindowRateLimiter({ limit: 20, windowMs: 60_000, maxKeys: 50_000 });

export function consumeDiscordStartQuota(ip: string) {
  return discordStartLimiter.consume(`discord-start:${ipRateLimitScope(ip)}`).allowed;
}

const requestIp = (req: Request) => oauthRequestIp(req);

function bindingCookieOptions(req: Request) {
  return {
    httpOnly: true,
    secure: req.secure === true || req.protocol === "https",
    sameSite: "lax" as const,
    path: DISCORD_COOKIE_PATH,
    maxAge: DISCORD_STATE_TTL_MS,
  };
}

function readBindingCookie(req: Request) {
  const value = req.cookies?.[DISCORD_BINDING_COOKIE];
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value) ? value : "";
}

function failureRedirect(res: Response, mode: DiscordLoginMode | null, code: DiscordLoginErrorCode) {
  noStore(res);
  res.redirect(302, withQuery(mode === "link" ? "/profile" : "/login", { discordError: code }));
}

export function renderDiscordAppPage(input: OAuthAppPage) {
  return renderOAuthAppPage({ ...input, confirmAction: DISCORD_APP_CONFIRM_PATH });
}

function sendAppPage(res: Response, status: number, page: OAuthAppPage) {
  noStore(res);
  res.status(status).type("html").send(renderDiscordAppPage(page));
}

function appFailurePage(res: Response, flowId: string | null, code: DiscordLoginErrorCode) {
  if (flowId) discordAppFlows.fail(flowId, code);
  sendAppPage(res, 400, { title: "Discord 登录没有完成", message: `${discordLoginErrorMessage(code)}\n请回到 NEX App 重试。`, tone: "error" });
}

/** 会话发放里抛出来的错误 → 失败码。 */
export function discordSessionErrorCode(error: unknown): DiscordLoginErrorCode {
  return oauthSessionErrorCode(error);
}

export const issueDiscordSessionOrChallenge = issueOAuthSessionOrChallenge;

const signInDeps = {
  getUserByDiscordId,
  getUserById: (id: number) => db.getUserById(id),
  linkDiscordAccount,
  isEmailTakenByAnyUser,
  isUsernameTaken,
  // 和密码注册同一个入口（邀请码、以后加的注册门槛都在这条路上判断）。
  registerUser: (data: Parameters<typeof db.registerUser>[0]) => db.registerUser(data),
  resolveInviter: (inviteCode: string | null) => db.resolveRegistrationInviter(inviteCode),
  getRegistrationPolicy: getOAuthRegistrationPolicy,
};

function displayName(user: any) {
  return String(user?.name || user?.username || `#${user?.id}`).slice(0, 60);
}

async function handleStart(req: Request, res: Response) {
  noStore(res);
  const ip = requestIp(req);
  const settings = readDiscordLoginSettings(await db.getAllSettings());
  const rawMode = String(req.query.mode || "login");
  const mode: DiscordLoginMode = rawMode === "link" || rawMode === "app" ? rawMode : "login";
  const flowId = mode === "app" ? String(req.query.flow || "") : null;
  const fail = (code: DiscordLoginErrorCode) => (mode === "app" ? appFailurePage(res, flowId, code) : failureRedirect(res, mode, code));

  if (!isDiscordLoginUsable(settings)) return fail(settings.enabled && !isDiscordLoginConfigured(settings) ? "not_configured" : "disabled");

  // 回调地址固定在面板公开地址上：从别的域名进来的，先换到公开地址再开始（cookie 才落在同一个域名下）。
  if (!requestMatchesPanelHost(req, settings.panelBaseUrl) && req.query.canon !== "1") {
    const target = new URL(`${settings.panelBaseUrl}${DISCORD_START_PATH}`);
    for (const key of ["mode", "redirect", "flow", "invite"]) {
      const value = req.query[key];
      if (typeof value === "string" && value) target.searchParams.set(key, value);
    }
    target.searchParams.set("canon", "1");
    return res.redirect(302, target.toString());
  }

  if (!consumeDiscordStartQuota(ip)) return fail("rate_limited");

  let userId: number | null = null;
  if (mode === "link") {
    const ctx = await createContext({ req, res, info: undefined as any } as any);
    if (!ctx.user || ctx.apiToken) return failureRedirect(res, "login", "link_requires_login");
    userId = ctx.user.id;
  }
  if (mode === "app" && !discordAppFlows.markStarted(flowId)) return appFailurePage(res, null, "app_flow_invalid");

  const binding = readBindingCookie(req) || randomUrlToken(32);
  res.cookie(DISCORD_BINDING_COOKIE, binding, bindingCookieOptions(req));
  const redirectPath = sanitizeRedirectPath(req.query.redirect, mode === "link" ? "/profile" : "/");
  const inviteCode = mode === "login" || mode === "app" ? sanitizeDiscordInviteCode(req.query.invite) : null;
  const created = discordAuthStates.create({ mode, redirectPath, userId, appFlowId: flowId, binding, inviteCode });
  const authorizationUrl = buildDiscordAuthorizationUrl({
    clientId: settings.clientId,
    redirectUri: settings.redirectUri,
    state: created.state,
    codeChallenge: created.codeChallenge,
  });
  console.info(`[DiscordAuth] start mode=${mode} ip=${ip}`);
  return res.redirect(302, authorizationUrl);
}

async function handleCallback(req: Request, res: Response) {
  noStore(res);
  const ip = requestIp(req);
  const entry = discordAuthStates.consume(req.query.state, readBindingCookie(req));
  if (!entry) {
    console.warn(`[DiscordAuth] callback rejected: state missing/expired/mismatched ip=${ip}`);
    return failureRedirect(res, null, "state_invalid");
  }
  const mode = entry.mode;
  const fail = (code: DiscordLoginErrorCode) => (mode === "app" ? appFailurePage(res, entry.appFlowId, code) : failureRedirect(res, mode, code));

  if (typeof req.query.error === "string") {
    const cancelled = req.query.error === "access_denied";
    console.info(`[DiscordAuth] callback error from Discord mode=${mode} error=${req.query.error.slice(0, 40)} ip=${ip}`);
    return fail(cancelled ? "cancelled" : "server_error");
  }
  const settings = readDiscordLoginSettings(await db.getAllSettings());
  if (!isDiscordLoginUsable(settings)) return fail("disabled");
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code || code.length > 2048) return fail("state_invalid");

  let profile;
  try {
    const { accessToken } = await exchangeDiscordAuthorizationCode({
      code,
      codeVerifier: entry.codeVerifier,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      redirectUri: settings.redirectUri,
    });
    try {
      profile = await fetchDiscordProfile({ accessToken });
    } finally {
      // 拿到身份就不再需要这个令牌：吊销掉（不等结果）。
      void revokeDiscordToken({ token: accessToken, clientId: settings.clientId, clientSecret: settings.clientSecret });
    }
  } catch (error) {
    const reason = error instanceof DiscordOAuthError ? error.code : "server_error";
    console.warn(`[DiscordAuth] callback ${reason} mode=${mode} ip=${ip}: ${error instanceof Error ? error.message : String(error)}`);
    return fail(reason);
  }

  let sessionUserId: number | null = null;
  if (mode === "link") {
    const ctx = await createContext({ req, res, info: undefined as any } as any);
    sessionUserId = ctx.user && !ctx.apiToken ? ctx.user.id : null;
  }

  const outcome = await withKeyedTaskLock(`discord-id:${profile.id}`, () => resolveDiscordSignIn({
    mode,
    profile,
    allowRegistration: settings.allowRegistration,
    allowedDomains: settings.allowedDomains,
    linkUserId: entry.userId,
    sessionUserId,
    inviteCode: entry.inviteCode,
  }, signInDeps)).catch((error) => {
    console.error(`[DiscordAuth] resolve failed mode=${mode} ip=${ip}: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: "error" as const, code: "server_error" as const };
  });

  if (outcome.kind === "error") {
    console.warn(`[DiscordAuth] rejected mode=${mode} code=${outcome.code} email=${maskIdentifier(profile.email)} ip=${ip}`);
    return fail(outcome.code);
  }

  if (outcome.kind === "linked") {
    if (!outcome.alreadyLinked) {
      console.info(`[DiscordAuth] linked userId=${outcome.user.id} discord=${maskIdentifier(profile.username)} ip=${ip}`);
      void recordPanelEvent({
        kind: "account.discord_linked",
        level: "info",
        userId: outcome.user.id,
        message: `${displayName(outcome.user)} 绑定了 Discord 账号 ${maskIdentifier(profile.username)}`,
        data: { ip },
      });
    }
    return res.redirect(302, withQuery(entry.redirectPath, { discordLinked: "1" }));
  }

  const user = outcome.user as any;
  await recordDiscordSignIn(user.id, profile.username, profile.email).catch(() => undefined);
  if (outcome.created) {
    console.info(`[DiscordAuth] registered userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
    void recordPanelEvent({
      kind: "account.discord_registered",
      level: "info",
      userId: user.id,
      message: `${displayName(user)} 用 Discord 账号 ${maskIdentifier(profile.username)} 注册了新账号`,
      data: { ip },
    });
  }

  if (mode === "app") {
    const flowId = entry.appFlowId;
    if (!flowId || !discordAppFlows.get(flowId)) return appFailurePage(res, null, "app_flow_invalid");
    if (discordAppFlows.sameOrigin(flowId, ip)) {
      discordAppFlows.complete(flowId, user.id);
      return sendAppPage(res, 200, { title: "Discord 验证完成", message: "请回到 NEX App，几秒内会自动登录。\n这个页面可以关掉了。", tone: "ok" });
    }
    const confirmId = discordAppFlows.requireConfirm(flowId, user.id);
    if (!confirmId) return appFailurePage(res, flowId, "app_flow_invalid");
    const origin = discordAppFlows.get(flowId);
    console.warn(`[DiscordAuth] app flow ip mismatch userId=${user.id} appIp=${origin?.ip} browserIp=${ip}`);
    return sendAppPage(res, 200, {
      title: "确认登录到 NEX App",
      message: `发起这次登录的设备 IP 是 ${origin?.ip || "未知"}，和当前浏览器（${ip}）不一样。\n如果不是你本人刚刚在 NEX App 里点了「使用 Discord 登录」，请直接关掉这个页面 —— 别人可能在骗你帮他登录你的账号。`,
      tone: "warn",
      form: { flowId, confirmId },
    });
  }

  try {
    const result: any = await issueDiscordSessionOrChallenge({ req, res }, user, { mobile: false, ip });
    if (result?.twoFactorRequired) {
      // 挑战 ID 放在 # 后面：不会发给服务器，也不会出现在 Referer 里；登录页读到后立刻从地址栏抹掉。
      const fragment = new URLSearchParams({
        discordTwoFactor: result.challengeId,
        u: result.username,
        exp: String(result.expiresInSeconds),
        next: entry.redirectPath,
      });
      console.info(`[DiscordAuth] login needs 2FA userId=${user.id} ip=${ip}`);
      return res.redirect(302, `/login#${fragment.toString()}`);
    }
  } catch (error) {
    const reason = discordSessionErrorCode(error);
    console.warn(`[DiscordAuth] session rejected userId=${user.id} code=${reason} ip=${ip}`);
    return fail(reason);
  }
  console.info(`[Auth] Discord login success userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
  void recordPanelEvent({
    kind: "account.login",
    level: "info",
    userId: user.id,
    message: `${displayName(user)} 用 Discord 账号登录`,
    data: { method: "discord", ip },
  });
  return res.redirect(302, entry.redirectPath);
}

async function handleAppConfirm(req: Request, res: Response) {
  const flowId = typeof req.body?.flow === "string" ? req.body.flow : "";
  const confirmId = typeof req.body?.confirm === "string" ? req.body.confirm : "";
  if (!discordAppFlows.confirm(flowId, confirmId)) return appFailurePage(res, null, "app_flow_invalid");
  console.info(`[DiscordAuth] app flow confirmed in browser ip=${requestIp(req)}`);
  return sendAppPage(res, 200, { title: "已确认", message: "请回到 NEX App，几秒内会自动登录。\n这个页面可以关掉了。", tone: "ok" });
}

function safe(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error) => {
      console.error(`[DiscordAuth] ${req.path} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) failureRedirect(res, null, "server_error");
    });
  };
}

export const discordAuthRouter = express.Router();
discordAuthRouter.get(DISCORD_START_PATH, safe(handleStart));
discordAuthRouter.get(DISCORD_CALLBACK_PATH, safe(handleCallback));
discordAuthRouter.post(DISCORD_APP_CONFIRM_PATH, safe(handleAppConfirm));

const cleanupTimer = setInterval(() => {
  discordAuthStates.prune();
}, 5 * 60 * 1000);
cleanupTimer.unref?.();
