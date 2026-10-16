/*
  Google 登录的两个浏览器入口（不是 tRPC：要做整页跳转）：

    GET  /api/auth/google/start?mode=login|link|app&redirect=/相对路径[&flow=App流程]
         → 生成 state / PKCE / nonce，种「浏览器绑定」cookie，302 去 Google
    GET  /api/auth/google/callback?code=…&state=…
         → 校验 state（一次性）+ cookie，换票，验 ID Token，按规则登录 / 绑定 / 注册
    POST /api/auth/google/app-confirm
         → App 流程里 IP 对不上时，浏览器那页「确认登录到 App」的按钮

  所有失败都跳回 /login?googleError=<码>（绑定时 /profile?googleError=<码>，App 流程显示一页说明），
  URL 和日志里都不出现 code、令牌或完整邮箱。
  会话和密码登录走同一个 createLoginSession：cookie、单设备策略、维护模式、停用账户检查都一样；
  账户开了双重验证时，先发 2FA 挑战（Google 账号被盗不应该直接绕过面板的 2FA）。
*/
import express, { type Request, type Response } from "express";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { getEmailConfig } from "./email";
import { createContext } from "./_core/context";
import { createLoginSession } from "./routers/auth";
import { maskIdentifier } from "./routers/helpers";
import { recordPanelEvent } from "./ops/panelEvents";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { SlidingWindowRateLimiter } from "./ai/rateLimiter";
import { createTwoFactorChallenge } from "./twoFactorChallenges";
import { recordTwoFactorChallengeIssue, twoFactorChallengeIssueState } from "./authRateLimit";
import { ACCOUNT_DISABLED_ERR_MSG } from "../shared/const";
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_START_PATH,
  googleLoginErrorMessage,
  parseEmailDomainList,
  sanitizeGoogleInviteCode,
  sanitizeRedirectPath,
  type GoogleLoginErrorCode,
  type GoogleLoginMode,
} from "../shared/googleLogin";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  GoogleAuthStateStore,
  GoogleJwksCache,
  GoogleOidcError,
  GOOGLE_STATE_TTL_MS,
  randomUrlToken,
  verifyGoogleIdToken,
} from "./googleOidc";
import { isGoogleLoginConfigured, isGoogleLoginUsable, readGoogleLoginSettings } from "./googleLoginSettings";
import { GoogleAppFlowStore, resolveGoogleSignIn } from "./googleLoginService";
import {
  getUserByGoogleSub,
  isEmailTakenByAnyUser,
  isUsernameTaken,
  linkGoogleAccount,
  recordGoogleSignIn,
} from "./repositories/googleAccountRepository";

export const GOOGLE_BINDING_COOKIE = "nex_google_oauth";
const GOOGLE_COOKIE_PATH = "/api/auth/google";

export const googleAuthStates = new GoogleAuthStateStore();
export const googleJwks = new GoogleJwksCache();
export const googleAppFlows = new GoogleAppFlowStore();

/** 每个来源一分钟最多发起 20 次（网页 + App 一起算）。 */
export const googleStartLimiter = new SlidingWindowRateLimiter({ limit: 20, windowMs: 60_000, maxKeys: 50_000 });

export function consumeGoogleStartQuota(ip: string) {
  return googleStartLimiter.consume(`google-start:${ipRateLimitScope(ip)}`).allowed;
}

function requestIp(req: Request) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function hostOf(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(text.includes("://") ? text : `http://${text}`).host.toLowerCase();
  } catch {
    return "";
  }
}

/** 这次请求是不是打在面板公开地址的域名上（直接访问或反代转来的都算）。 */
export function requestMatchesPanelHost(req: Pick<Request, "headers">, panelBaseUrl: string) {
  const panelHost = hostOf(panelBaseUrl);
  if (!panelHost) return false;
  const candidates = [req.headers.host, ...String(req.headers["x-forwarded-host"] || "").split(",")];
  return candidates.some((value) => hostOf(String(value || "").trim()) === panelHost);
}

function bindingCookieOptions(req: Request) {
  return {
    httpOnly: true,
    secure: req.secure === true || req.protocol === "https",
    sameSite: "lax" as const,
    path: GOOGLE_COOKIE_PATH,
    maxAge: GOOGLE_STATE_TTL_MS,
  };
}

function readBindingCookie(req: Request) {
  const value = req.cookies?.[GOOGLE_BINDING_COOKIE];
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value) ? value : "";
}

function noStore(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function withQuery(path: string, params: Record<string, string>) {
  const url = new URL(path, "http://panel.invalid");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

function failureRedirect(res: Response, mode: GoogleLoginMode | null, code: GoogleLoginErrorCode) {
  noStore(res);
  res.redirect(302, withQuery(mode === "link" ? "/profile" : "/login", { googleError: code }));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]!));
}

/** App 流程在系统浏览器里显示的那几页。没有脚本，样式内联（CSP 允许 inline style）。 */
export function renderGoogleAppPage(input: { title: string; message: string; tone: "ok" | "error" | "warn"; form?: { flowId: string; confirmId: string } }) {
  const color = input.tone === "ok" ? "#16a34a" : input.tone === "warn" ? "#d97706" : "#dc2626";
  const form = input.form
    ? `<form method="post" action="/api/auth/google/app-confirm">
        <input type="hidden" name="flow" value="${escapeHtml(input.form.flowId)}">
        <input type="hidden" name="confirm" value="${escapeHtml(input.form.confirmId)}">
        <button type="submit">是我本人，确认登录到 App</button>
      </form>`
    : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(input.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f9fc;--card:#fff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--text:#e5e7eb;--muted:#94a3b8;--line:#1f2937}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:16px;box-sizing:border-box}
main{max-width:420px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:18px;margin:0 0 8px;color:${color}}p{margin:0 0 12px;color:var(--muted);white-space:pre-line}
button{width:100%;padding:10px 14px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:15px;cursor:pointer}
</style></head>
<body><main><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>${form}</main></body></html>`;
}

function sendAppPage(res: Response, status: number, page: Parameters<typeof renderGoogleAppPage>[0]) {
  noStore(res);
  res.status(status).type("html").send(renderGoogleAppPage(page));
}

function appFailurePage(res: Response, flowId: string | null, code: GoogleLoginErrorCode) {
  if (flowId) googleAppFlows.fail(flowId, code);
  sendAppPage(res, 400, { title: "Google 登录没有完成", message: `${googleLoginErrorMessage(code)}\n请回到 NEX App 重试。`, tone: "error" });
}

export type GoogleTwoFactorRequired = {
  twoFactorRequired: true;
  username: string;
  challengeId: string;
  expiresInSeconds: number;
};

/**
 * Google 认出人之后：要 2FA 就发挑战，否则发会话（和密码登录同一个 createLoginSession）。
 * 2FA 挑战的发放频率按账号限流，和密码 / Telegram 登录共用一份额度。
 */
export async function issueGoogleSessionOrChallenge(ctx: { req: Request; res: Response }, user: any, options: { mobile: boolean; ip: string }) {
  if (user?.accountEnabled === false) throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
  if ((await db.getSetting("twoFactorEnabled")) === "true" && user?.twoFactorEnabled && user?.twoFactorSecret) {
    const limit = twoFactorChallengeIssueState(options.ip, user.username);
    if (limit.limited) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `TWO_FACTOR_CHALLENGE_RATE_LIMITED:${Math.ceil(limit.retryAfterSeconds / 60)}` });
    }
    const challenge = createTwoFactorChallenge({ userId: user.id, username: user.username, mobile: options.mobile, ip: options.ip });
    recordTwoFactorChallengeIssue(options.ip, user.username);
    return { twoFactorRequired: true, username: user.username, ...challenge } satisfies GoogleTwoFactorRequired;
  }
  return createLoginSession(ctx, user, options.mobile);
}

/** 会话发放里抛出来的错误 → 失败码。 */
export function sessionErrorCode(error: unknown): GoogleLoginErrorCode {
  if (error instanceof TRPCError) {
    if (error.code === "SERVICE_UNAVAILABLE") return "maintenance";
    if (error.code === "TOO_MANY_REQUESTS") return "rate_limited";
    if (error.message === ACCOUNT_DISABLED_ERR_MSG) return "account_disabled";
  }
  return "server_error";
}

async function getRegistrationPolicy() {
  const registrationEnabled = (await db.getSetting("registrationEnabled")) !== "false";
  const emailConfig = await getEmailConfig();
  return {
    registrationEnabled,
    emailWhitelist: emailConfig.whitelistEnabled ? parseEmailDomainList(emailConfig.whitelist) : [],
  };
}

const signInDeps = {
  getUserByGoogleSub,
  getUserById: (id: number) => db.getUserById(id),
  linkGoogleAccount,
  isEmailTakenByAnyUser,
  isUsernameTaken,
  // 和密码注册同一个入口。以后注册加的门槛（比如邀请码）也要在这条路上判断。
  registerUser: (data: Parameters<typeof db.registerUser>[0]) => db.registerUser(data),
  resolveInviter: (inviteCode: string | null) => db.resolveRegistrationInviter(inviteCode),
  getRegistrationPolicy,
};

function displayName(user: any) {
  return String(user?.name || user?.username || `#${user?.id}`).slice(0, 60);
}

async function handleStart(req: Request, res: Response) {
  noStore(res);
  const ip = requestIp(req);
  const settings = readGoogleLoginSettings(await db.getAllSettings());
  const rawMode = String(req.query.mode || "login");
  const mode: GoogleLoginMode = rawMode === "link" || rawMode === "app" ? rawMode : "login";
  const flowId = mode === "app" ? String(req.query.flow || "") : null;
  const fail = (code: GoogleLoginErrorCode) => (mode === "app" ? appFailurePage(res, flowId, code) : failureRedirect(res, mode, code));

  if (!isGoogleLoginUsable(settings)) return fail(settings.enabled && !isGoogleLoginConfigured(settings) ? "not_configured" : "disabled");

  // 回调地址固定在面板公开地址上：从别的域名（IP:端口、内网地址）点进来的，先换到公开地址再开始，
  // 浏览器绑定 cookie 和最后的会话 cookie 才会落在同一个域名下。canon=1 防反代不传 Host 时绕圈。
  if (!requestMatchesPanelHost(req, settings.panelBaseUrl) && req.query.canon !== "1") {
    const target = new URL(`${settings.panelBaseUrl}${GOOGLE_START_PATH}`);
    for (const key of ["mode", "redirect", "flow", "invite"]) {
      const value = req.query[key];
      if (typeof value === "string" && value) target.searchParams.set(key, value);
    }
    target.searchParams.set("canon", "1");
    return res.redirect(302, target.toString());
  }

  if (!consumeGoogleStartQuota(ip)) return fail("rate_limited");

  let userId: number | null = null;
  if (mode === "link") {
    const ctx = await createContext({ req, res, info: undefined as any } as any);
    if (!ctx.user || ctx.apiToken) return failureRedirect(res, "login", "link_requires_login");
    userId = ctx.user.id;
  }
  if (mode === "app" && !googleAppFlows.markStarted(flowId)) return appFailurePage(res, null, "app_flow_invalid");

  const binding = readBindingCookie(req) || randomUrlToken(32);
  res.cookie(GOOGLE_BINDING_COOKIE, binding, bindingCookieOptions(req));
  const redirectPath = sanitizeRedirectPath(req.query.redirect, mode === "link" ? "/profile" : "/");
  const inviteCode = mode === "login" ? sanitizeGoogleInviteCode(req.query.invite) : null;
  const created = googleAuthStates.create({ mode, redirectPath, userId, appFlowId: flowId, binding, inviteCode });
  const authorizationUrl = buildGoogleAuthorizationUrl({
    clientId: settings.clientId,
    redirectUri: settings.redirectUri,
    state: created.state,
    codeChallenge: created.codeChallenge,
    nonce: created.nonce,
  });
  console.info(`[GoogleAuth] start mode=${mode} ip=${ip}`);
  return res.redirect(302, authorizationUrl);
}

async function handleCallback(req: Request, res: Response) {
  noStore(res);
  const ip = requestIp(req);
  const entry = googleAuthStates.consume(req.query.state, readBindingCookie(req));
  if (!entry) {
    console.warn(`[GoogleAuth] callback rejected: state missing/expired/mismatched ip=${ip}`);
    return failureRedirect(res, null, "state_invalid");
  }
  const mode = entry.mode;
  const fail = (code: GoogleLoginErrorCode) => (mode === "app" ? appFailurePage(res, entry.appFlowId, code) : failureRedirect(res, mode, code));

  if (typeof req.query.error === "string") {
    const cancelled = req.query.error === "access_denied";
    console.info(`[GoogleAuth] callback error from Google mode=${mode} error=${req.query.error.slice(0, 40)} ip=${ip}`);
    return fail(cancelled ? "cancelled" : "server_error");
  }
  const settings = readGoogleLoginSettings(await db.getAllSettings());
  if (!isGoogleLoginUsable(settings)) return fail("disabled");
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code || code.length > 2048) return fail("state_invalid");

  let claims;
  try {
    const { idToken } = await exchangeGoogleAuthorizationCode({
      code,
      codeVerifier: entry.codeVerifier,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      redirectUri: settings.redirectUri,
    });
    claims = await verifyGoogleIdToken(idToken, { clientId: settings.clientId, nonce: entry.nonce, jwks: googleJwks });
  } catch (error) {
    const reason = error instanceof GoogleOidcError ? error.code : "server_error";
    console.warn(`[GoogleAuth] callback ${reason} mode=${mode} ip=${ip}: ${error instanceof Error ? error.message : String(error)}`);
    return fail(reason);
  }

  let sessionUserId: number | null = null;
  if (mode === "link") {
    const ctx = await createContext({ req, res, info: undefined as any } as any);
    sessionUserId = ctx.user && !ctx.apiToken ? ctx.user.id : null;
  }

  const outcome = await withKeyedTaskLock(`google-sub:${claims.sub}`, () => resolveGoogleSignIn({
    mode,
    claims,
    allowRegistration: settings.allowRegistration,
    allowedDomains: settings.allowedDomains,
    linkUserId: entry.userId,
    sessionUserId,
    inviteCode: entry.inviteCode ?? null,
  }, signInDeps)).catch((error) => {
    console.error(`[GoogleAuth] resolve failed mode=${mode} ip=${ip}: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: "error" as const, code: "server_error" as const };
  });

  if (outcome.kind === "error") {
    console.warn(`[GoogleAuth] rejected mode=${mode} code=${outcome.code} email=${maskIdentifier(claims.email)} ip=${ip}`);
    return fail(outcome.code);
  }

  if (outcome.kind === "linked") {
    if (!outcome.alreadyLinked) {
      console.info(`[GoogleAuth] linked userId=${outcome.user.id} email=${maskIdentifier(claims.email)} ip=${ip}`);
      void recordPanelEvent({
        kind: "account.google_linked",
        level: "info",
        userId: outcome.user.id,
        message: `${displayName(outcome.user)} 绑定了 Google 账号 ${maskIdentifier(claims.email)}`,
        data: { ip },
      });
    }
    return res.redirect(302, withQuery(entry.redirectPath, { googleLinked: "1" }));
  }

  const user = outcome.user as any;
  await recordGoogleSignIn(user.id, claims.email).catch(() => undefined);
  if (outcome.created) {
    console.info(`[GoogleAuth] registered userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
    void recordPanelEvent({
      kind: "account.google_registered",
      level: "info",
      userId: user.id,
      message: `${displayName(user)} 用 Google 账号 ${maskIdentifier(claims.email)} 注册了新账号`,
      data: { ip },
    });
  }

  if (mode === "app") {
    const flowId = entry.appFlowId;
    if (!flowId || !googleAppFlows.get(flowId)) return appFailurePage(res, null, "app_flow_invalid");
    if (googleAppFlows.sameOrigin(flowId, ip)) {
      googleAppFlows.complete(flowId, user.id);
      return sendAppPage(res, 200, { title: "Google 验证完成", message: "请回到 NEX App，几秒内会自动登录。\n这个页面可以关掉了。", tone: "ok" });
    }
    const confirmId = googleAppFlows.requireConfirm(flowId, user.id);
    if (!confirmId) return appFailurePage(res, flowId, "app_flow_invalid");
    const origin = googleAppFlows.get(flowId);
    console.warn(`[GoogleAuth] app flow ip mismatch userId=${user.id} appIp=${origin?.ip} browserIp=${ip}`);
    return sendAppPage(res, 200, {
      title: "确认登录到 NEX App",
      message: `发起这次登录的设备 IP 是 ${origin?.ip || "未知"}，和当前浏览器（${ip}）不一样。\n如果不是你本人刚刚在 NEX App 里点了「使用 Google 登录」，请直接关掉这个页面 —— 别人可能在骗你帮他登录你的账号。`,
      tone: "warn",
      form: { flowId, confirmId },
    });
  }

  try {
    const result: any = await issueGoogleSessionOrChallenge({ req, res }, user, { mobile: false, ip });
    if (result?.twoFactorRequired) {
      // 挑战 ID 放在 # 后面：不会发给服务器，也不会出现在 Referer 里；登录页读到后立刻从地址栏抹掉。
      const fragment = new URLSearchParams({
        googleTwoFactor: result.challengeId,
        u: result.username,
        exp: String(result.expiresInSeconds),
        next: entry.redirectPath,
      });
      console.info(`[GoogleAuth] login needs 2FA userId=${user.id} ip=${ip}`);
      return res.redirect(302, `/login#${fragment.toString()}`);
    }
  } catch (error) {
    const reason = sessionErrorCode(error);
    console.warn(`[GoogleAuth] session rejected userId=${user.id} code=${reason} ip=${ip}`);
    return fail(reason);
  }
  console.info(`[Auth] Google login success userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
  void recordPanelEvent({
    kind: "account.login",
    level: "info",
    userId: user.id,
    message: `${displayName(user)} 用 Google 账号登录`,
    data: { method: "google", ip },
  });
  return res.redirect(302, entry.redirectPath);
}

async function handleAppConfirm(req: Request, res: Response) {
  const flowId = typeof req.body?.flow === "string" ? req.body.flow : "";
  const confirmId = typeof req.body?.confirm === "string" ? req.body.confirm : "";
  if (!googleAppFlows.confirm(flowId, confirmId)) return appFailurePage(res, null, "app_flow_invalid");
  console.info(`[GoogleAuth] app flow confirmed in browser ip=${requestIp(req)}`);
  return sendAppPage(res, 200, { title: "已确认", message: "请回到 NEX App，几秒内会自动登录。\n这个页面可以关掉了。", tone: "ok" });
}

function safe(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error) => {
      console.error(`[GoogleAuth] ${req.path} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) failureRedirect(res, null, "server_error");
    });
  };
}

export const googleAuthRouter = express.Router();
googleAuthRouter.get(GOOGLE_START_PATH, safe(handleStart));
googleAuthRouter.get(GOOGLE_CALLBACK_PATH, safe(handleCallback));
googleAuthRouter.post("/api/auth/google/app-confirm", safe(handleAppConfirm));

const cleanupTimer = setInterval(() => {
  googleAuthStates.prune();
}, 5 * 60 * 1000);
cleanupTimer.unref?.();
