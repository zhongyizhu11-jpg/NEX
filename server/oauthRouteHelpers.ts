/*
  第三方登录（Google、Discord）浏览器入口共用的小工具：
  公开地址判断、禁止缓存、拼查询串、App 流程在系统浏览器里显示的那几页、
  认出人之后「要 2FA 就发挑战，否则发会话」、以及注册策略的读取。

  各家的 start / callback 路由（server/googleAuthRoute.ts、server/discordAuthRoute.ts）只管自己的协议。
*/
import type { Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { getEmailConfig } from "./email";
import { createLoginSession } from "./routers/auth";
import { createTwoFactorChallenge } from "./twoFactorChallenges";
import { recordTwoFactorChallengeIssue, twoFactorChallengeIssueState } from "./authRateLimit";
import { ACCOUNT_DISABLED_ERR_MSG } from "../shared/const";
import { parseEmailDomainList } from "../shared/googleLogin";

export function oauthRequestIp(req: Pick<Request, "ip" | "socket">) {
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

export function noStore(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

export function withQuery(path: string, params: Record<string, string>) {
  const url = new URL(path, "http://panel.invalid");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]!));
}

export type OAuthAppPage = {
  title: string;
  message: string;
  tone: "ok" | "error" | "warn";
  form?: { flowId: string; confirmId: string };
};

/** App 流程在系统浏览器里显示的那几页。没有脚本，样式内联（CSP 允许 inline style）。 */
export function renderOAuthAppPage(input: OAuthAppPage & { confirmAction: string }) {
  const color = input.tone === "ok" ? "#16a34a" : input.tone === "warn" ? "#d97706" : "#dc2626";
  const form = input.form
    ? `<form method="post" action="${escapeHtml(input.confirmAction)}">
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

export type OAuthTwoFactorRequired = {
  twoFactorRequired: true;
  username: string;
  challengeId: string;
  expiresInSeconds: number;
};

/**
 * 第三方认出人之后：要 2FA 就发挑战，否则发会话（和密码登录同一个 createLoginSession）。
 * 2FA 挑战的发放频率按账号限流，和密码 / Telegram 登录共用一份额度。
 * 第三方账号被盗不应该绕过面板自己的 2FA。
 */
export async function issueOAuthSessionOrChallenge(ctx: { req: Request; res: Response }, user: any, options: { mobile: boolean; ip: string }) {
  if (user?.accountEnabled === false) throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
  if ((await db.getSetting("twoFactorEnabled")) === "true" && user?.twoFactorEnabled && user?.twoFactorSecret) {
    const limit = twoFactorChallengeIssueState(options.ip, user.username);
    if (limit.limited) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `TWO_FACTOR_CHALLENGE_RATE_LIMITED:${Math.ceil(limit.retryAfterSeconds / 60)}` });
    }
    const challenge = createTwoFactorChallenge({ userId: user.id, username: user.username, mobile: options.mobile, ip: options.ip });
    recordTwoFactorChallengeIssue(options.ip, user.username);
    return { twoFactorRequired: true, username: user.username, ...challenge } satisfies OAuthTwoFactorRequired;
  }
  return createLoginSession(ctx, user, options.mobile);
}

/** 会话发放里抛出来的错误 → 失败码（各家的失败码表都有这几个）。 */
export function oauthSessionErrorCode(error: unknown): "maintenance" | "rate_limited" | "account_disabled" | "server_error" {
  if (error instanceof TRPCError) {
    if (error.code === "SERVICE_UNAVAILABLE") return "maintenance";
    if (error.code === "TOO_MANY_REQUESTS") return "rate_limited";
    if (error.message === ACCOUNT_DISABLED_ERR_MSG) return "account_disabled";
  }
  return "server_error";
}

/** 注册开没开、邮件设置里的邮箱白名单（白名单没开就是空数组）。 */
export async function getOAuthRegistrationPolicy() {
  const registrationEnabled = (await db.getSetting("registrationEnabled")) !== "false";
  const emailConfig = await getEmailConfig();
  return {
    registrationEnabled,
    emailWhitelist: emailConfig.whitelistEnabled ? parseEmailDomainList(emailConfig.whitelist) : [],
  };
}
