import crypto from "node:crypto";

/*
  Xboard / V2Board 兼容接口的纯逻辑（路由在 xboardCompatRoute.ts）。

  有的客户端（Open-Box 等）支持「Xboard 账号登录」：填面板地址 + 邮箱密码，客户端调
  /api/v1/passport/auth/login 拿 auth_data，再拿它当 Authorization 调 /api/v1/user/getSubscribe
  取 subscribe_url 和流量、到期。NEX 只实现客户端拉订阅用到的这几个，管理接口一个都不开。

  为什么不复用网页登录的会话：NEX 默认一个账号只保留一个网页会话，客户端一登录就会把人
  从浏览器里踢出去。这里另发一种令牌：
    · HMAC 签名，密钥从 cookieSecret 派生但和网页会话的 JWT 不是同一把 —— 拿它去调 tRPC
      验不过，拿网页会话的令牌来这里也验不过；
    · 里面带密码哈希的指纹：改密码后旧令牌全部失效；
    · 30 天有效，过期了客户端会重新登录。
*/

export const XBOARD_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
const TOKEN_PREFIX = "nexxb1";

function signingKey(secret: string) {
  return crypto.createHash("sha256").update(`${secret}:xboard-compat:v1`).digest();
}

export function passwordFingerprint(passwordHash: string) {
  return crypto.createHash("sha256").update(String(passwordHash || "")).digest("base64url").slice(0, 16);
}

function sign(payload: string, secret: string) {
  return crypto.createHmac("sha256", signingKey(secret)).update(payload).digest("base64url");
}

export function issueXboardToken(input: { userId: number; passwordHash: string; secret: string; nowSec?: number }) {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ u: input.userId, p: passwordFingerprint(input.passwordHash), e: nowSec + XBOARD_TOKEN_TTL_SECONDS })).toString("base64url");
  return `${TOKEN_PREFIX}.${body}.${sign(`${TOKEN_PREFIX}.${body}`, input.secret)}`;
}

/** 从 Authorization 头里取令牌：auth_data 原样（带不带 "Bearer " 都认）。 */
export function readXboardToken(header: unknown): string | null {
  const text = String(header || "").trim();
  if (!text) return null;
  const token = text.replace(/^Bearer\s+/i, "").trim();
  return token.startsWith(`${TOKEN_PREFIX}.`) ? token : null;
}

/** 验签名和有效期，返回 userId 和密码指纹；调用方再拿库里的密码哈希比指纹。 */
export function verifyXboardToken(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): { userId: number; fingerprint: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  const given = Buffer.from(parts[2]);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const userId = Number(payload?.u);
    if (!Number.isInteger(userId) || userId <= 0 || !(Number(payload?.e) > nowSec)) return null;
    return { userId, fingerprint: String(payload?.p || "") };
  } catch {
    return null;
  }
}

function toSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : new Date(String(value)).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

export type XboardUserLike = {
  id: number;
  email?: string | null;
  username?: string | null;
  role?: string | null;
  accountEnabled?: unknown;
  trafficLimit?: unknown;
  trafficUsed?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
  lastSignedIn?: unknown;
  balanceCents?: unknown;
  trafficResetDay?: unknown;
};

/**
 * getSubscribe 的 data。Xboard 的流量是 u（上行）+ d（下行）对 transfer_enable；NEX 只记一个
 * 已用总量，放在 d 里（和订阅响应头 Subscription-Userinfo 的写法一致）。transfer_enable=0 表示
 * 不限（NEX 的约定，订阅响应头里也是 total=0）。
 */
export function buildXboardSubscribe(user: XboardUserLike, input: { token: string; subscribeUrl: string; plan: { id: number; name: string } | null }) {
  const resetDay = Number(user.trafficResetDay || 0);
  return {
    plan_id: input.plan?.id ?? null,
    token: input.token,
    expired_at: toSeconds(user.expiresAt),
    u: 0,
    d: Math.max(0, Number(user.trafficUsed || 0)),
    transfer_enable: Math.max(0, Number(user.trafficLimit || 0)),
    email: user.email || user.username || "",
    uuid: input.token,
    plan: input.plan ? { id: input.plan.id, name: input.plan.name } : null,
    subscribe_url: input.subscribeUrl,
    reset_day: resetDay >= 1 && resetDay <= 31 ? resetDay : null,
  };
}

export function buildXboardInfo(user: XboardUserLike, input: { planId: number | null; uuid: string }) {
  return {
    email: user.email || user.username || "",
    transfer_enable: Math.max(0, Number(user.trafficLimit || 0)),
    last_login_at: toSeconds(user.lastSignedIn),
    created_at: toSeconds(user.createdAt),
    banned: user.accountEnabled === false || user.accountEnabled === 0 ? 1 : 0,
    remind_expire: 0,
    remind_traffic: 0,
    expired_at: toSeconds(user.expiresAt),
    balance: Math.max(0, Number(user.balanceCents || 0)),
    commission_balance: 0,
    plan_id: input.planId,
    discount: null,
    commission_rate: null,
    telegram_id: null,
    uuid: input.uuid,
    avatar_url: "",
  };
}
