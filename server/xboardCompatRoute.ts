import express, { type Request, type Response } from "express";

import * as db from "./db";
import { ENV } from "./env";
import { authCaptcha } from "./authCaptcha";
import { authRateLimitState, clearAuthAccountFailures, clearTwoFactorChallengeIssueHistory, recordPasswordFailure } from "./authRateLimit";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { resolvePanelUrl } from "./agentPanelUrl";
import { loadProxySubSettings } from "./proxySubSettings";
import { proxyCredentialRecipientActive } from "./repositories/proxyInboundRepository";
import { recordLoginFailureEvent, recordLoginSuccessEvent } from "./ops/eventHooks";
import { assertMaintenanceAllows } from "./ops/maintenance";
import { buildProxySubscriptionUrl } from "../shared/proxyClientImport";
import {
  buildXboardInfo,
  buildXboardSubscribe,
  issueXboardToken,
  passwordFingerprint,
  readXboardToken,
  verifyXboardToken,
} from "./xboardCompat";

/*
  Xboard / V2Board 兼容接口（设置 › 订阅 ›「兼容 Xboard / V2Board 账号登录」，默认关）。
  令牌和响应形状见 xboardCompat.ts。

  登录和网页登录守同一套规矩：同一个限流（按 IP + 账号）、同样记失败、停用的账号不让进、
  维护模式照样拦。两件网页上能做、这里做不了的事直接拒绝并说清楚，而不是绕过去：
    · 需要验证码（失败次数多了）：客户端没法弹验证码 —— 请先在网页上登录一次；
    · 开了两步验证：客户端没地方填验证码 —— 请在面板里复制订阅地址。
*/

export const xboardCompatRouter = express.Router();

function ipOf(req: Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function fail(res: Response, status: number, message: string) {
  res.status(status).json({ message });
}

async function enabled(res: Response) {
  const settings = await loadProxySubSettings();
  if (settings.xboardCompatEnabled) return true;
  fail(res, 404, "此面板没有开启 Xboard 兼容登录");
  return false;
}

async function captchaRequired(ip: string, account: string) {
  return (await db.getSetting("authCaptchaEnabled")) !== "false" && authCaptcha.requiresLoginCaptcha(ip, account);
}

/** 用户能用的订阅令牌：启用、没过期的第一条；一条都没有时建一条默认的。 */
async function subscriptionTokenFor(userId: number): Promise<string | null> {
  const usable = (rows: any[]) => rows.find((row) => row.isEnabled !== false && row.isEnabled !== 0
    && (!row.expiresAt || new Date(row.expiresAt).getTime() > Date.now()));
  let rows = (await db.getProxySubTokensByUser(userId)) as any[];
  if (rows.length === 0) {
    await db.ensureDefaultProxySubToken(userId);
    rows = (await db.getProxySubTokensByUser(userId)) as any[];
  }
  const row = usable(rows);
  return row ? String(row.token) : null;
}

async function activePlan(userId: number): Promise<{ id: number; name: string } | null> {
  const subscriptions = (await db.getActiveUserSubscriptions(userId)) as any[];
  const planId = Number(subscriptions[0]?.planId || 0);
  if (!planId) return null;
  const plan = (await db.getSubscriptionPlanById(planId)) as any;
  return plan ? { id: planId, name: String(plan.name || "") } : { id: planId, name: "" };
}

/** Authorization 里的令牌 → 用户；签名、有效期、密码指纹、账号状态都要过。 */
async function authenticate(req: Request, res: Response): Promise<any | null> {
  const token = readXboardToken(req.headers.authorization);
  const verified = token && ENV.cookieSecret ? verifyXboardToken(token, ENV.cookieSecret) : null;
  if (!verified) {
    fail(res, 403, "未登录或登陆已过期");
    return null;
  }
  const user = (await db.getUserById(verified.userId)) as any;
  if (!user || passwordFingerprint(user.password) !== verified.fingerprint) {
    fail(res, 403, "未登录或登陆已过期");
    return null;
  }
  if (user.accountEnabled === false || user.accountEnabled === 0) {
    fail(res, 403, "账号已停用");
    return null;
  }
  return user;
}

xboardCompatRouter.post("/api/v1/passport/auth/login", async (req, res) => {
  try {
    if (!(await enabled(res))) return;
    const account = String(req.body?.email ?? req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!account || !password) return fail(res, 422, "请输入邮箱和密码");
    if (!ENV.cookieSecret) return fail(res, 500, "面板没有配置会话密钥");
    const ip = ipOf(req);
    await withKeyedTaskLock(`xboard-login:${ip}:${account.toLowerCase()}`, async () => {
      const limited = authRateLimitState(ip, account);
      if (limited.limited) return fail(res, 429, `登录失败次数过多，请 ${Math.ceil(limited.retryAfterSeconds / 60)} 分钟后再试`);
      if (await captchaRequired(ip, account)) return fail(res, 403, "需要验证码：请先在网页上登录一次，再回到客户端");
      const user = (await db.authenticateUser(account, password)) as any;
      if (!user) {
        recordPasswordFailure(ip, account);
        authCaptcha.recordLoginFailure(ip, account);
        recordLoginFailureEvent(ip, account);
        console.warn(`[Xboard] Login failed ip=${ip}`);
        return fail(res, 422, "邮箱或密码错误");
      }
      if (user.accountEnabled === false || user.accountEnabled === 0) return fail(res, 403, "账号已停用");
      const canonical = authRateLimitState(ip, user.username);
      if (canonical.limited) return fail(res, 429, `登录失败次数过多，请 ${Math.ceil(canonical.retryAfterSeconds / 60)} 分钟后再试`);
      if ((await db.getSetting("twoFactorEnabled")) === "true" && user.twoFactorEnabled && user.twoFactorSecret) {
        return fail(res, 403, "这个账号开了两步验证，客户端没法填验证码：请在面板「订阅」里复制订阅地址导入");
      }
      try {
        await assertMaintenanceAllows(user);
      } catch (error) {
        return fail(res, 503, error instanceof Error ? error.message : "面板维护中");
      }
      clearAuthAccountFailures(ip, account);
      clearTwoFactorChallengeIssueHistory(ip, account);
      authCaptcha.clearLoginCaptchaRequirement(ip, account);
      recordLoginSuccessEvent(user, ip);
      const authToken = issueXboardToken({ userId: Number(user.id), passwordHash: String(user.password || ""), secret: ENV.cookieSecret });
      const subToken = proxyCredentialRecipientActive(user) ? await subscriptionTokenFor(Number(user.id)) : null;
      console.info(`[Xboard] Login userId=${user.id} ip=${ip}`);
      res.json({ data: { token: subToken || "", is_admin: user.role === "admin", auth_data: `Bearer ${authToken}` } });
    });
  } catch (error) {
    console.error("[Xboard] login error:", error);
    fail(res, 500, "服务器错误");
  }
});

xboardCompatRouter.get("/api/v1/user/getSubscribe", async (req, res) => {
  try {
    if (!(await enabled(res))) return;
    const user = await authenticate(req, res);
    if (!user) return;
    if (!proxyCredentialRecipientActive(user)) return fail(res, 403, "这个账号没有订阅资格（未开通、已到期或已停用）");
    const token = await subscriptionTokenFor(Number(user.id));
    if (!token) return fail(res, 403, "你的订阅地址都已停用或过期，请在面板「订阅」里重新生成");
    const subscribeUrl = buildProxySubscriptionUrl({ origin: await resolvePanelUrl(req), token, format: "base64", kind: "nodes" });
    res.json({ data: buildXboardSubscribe(user, { token, subscribeUrl, plan: await activePlan(Number(user.id)) }) });
  } catch (error) {
    console.error("[Xboard] getSubscribe error:", error);
    fail(res, 500, "服务器错误");
  }
});

xboardCompatRouter.get("/api/v1/user/info", async (req, res) => {
  try {
    if (!(await enabled(res))) return;
    const user = await authenticate(req, res);
    if (!user) return;
    const plan = await activePlan(Number(user.id));
    res.json({ data: buildXboardInfo(user, { planId: plan?.id ?? null, uuid: String(user.id) }) });
  } catch (error) {
    console.error("[Xboard] info error:", error);
    fail(res, 500, "服务器错误");
  }
});

xboardCompatRouter.get("/api/v1/user/checkLogin", async (req, res) => {
  if (!(await enabled(res))) return;
  const token = readXboardToken(req.headers.authorization);
  const verified = token && ENV.cookieSecret ? verifyXboardToken(token, ENV.cookieSecret) : null;
  const user = verified ? (await db.getUserById(verified.userId)) as any : null;
  const ok = !!user && passwordFingerprint(user.password) === verified?.fingerprint && user.accountEnabled !== false && user.accountEnabled !== 0;
  res.json({ data: { is_login: ok, is_admin: ok && user.role === "admin" } });
});

/** 客户端登录前常先拉一下站点配置；只给不涉及注册的几项。 */
xboardCompatRouter.get("/api/v1/guest/comm/config", async (req, res) => {
  if (!(await enabled(res))) return;
  res.json({
    data: {
      tos_url: null,
      is_email_verify: 0,
      is_invite_force: 0,
      email_whitelist_suffix: 0,
      is_recaptcha: 0,
      recaptcha_site_key: null,
      app_description: "NEX",
      app_url: await resolvePanelUrl(req),
      logo: null,
    },
  });
});

/** V2Board 的老式订阅地址 /api/v1/client/subscribe?token=… → NEX 的 /api/sub/<token>（格式按客户端 UA 自动认）。 */
xboardCompatRouter.get("/api/v1/client/subscribe", async (req, res) => {
  if (!(await enabled(res))) return;
  const token = String(req.query.token || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return fail(res, 404, "订阅不存在");
  res.redirect(302, `/api/sub/${encodeURIComponent(token)}`);
});
