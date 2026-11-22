import { SlidingWindowRateLimiter } from "../ai/rateLimiter";
import { ipRateLimitScope } from "../ipRateLimitScope";

type MobileTelegramLoginChallenge = {
  expiresAt: number;
};

/**
 * 最多同时挂着多少个未完成的登录挑战。
 *
 * startMobileLogin 是公开接口，不登录就能调：原来每调一次就往这张表里塞一条、
 * 5 分钟后才过期，一个脚本循环调就能把面板内存撑爆。和 telegramWebAppLogin 一样
 * 封顶 1 万条，满了先踢最早的（Map 按插入顺序迭代）。
 */
export const MAX_MOBILE_LOGIN_CHALLENGES = 10_000;

/**
 * 每个来源（IPv4 单个地址 / IPv6 的 /64）一分钟最多发起多少次手机 Telegram 登录。
 * 正常人点一次等着就行，10 次足够手滑重试。
 */
export const MOBILE_LOGIN_ISSUE_LIMIT_PER_MINUTE = 10;
const mobileLoginIssueLimiter = new SlidingWindowRateLimiter({
  limit: MOBILE_LOGIN_ISSUE_LIMIT_PER_MINUTE,
  windowMs: 60_000,
  maxKeys: 50_000,
});

/** 记一次发起；超限返回还要等多少秒，没超返回 0。 */
export function consumeMobileTelegramLoginIssue(ip: string) {
  const result = mobileLoginIssueLimiter.consume(`mobile-telegram-login:${ipRateLimitScope(ip)}`);
  return result.allowed ? 0 : Math.max(1, Math.ceil(result.retryAfterMs / 1000));
}

const challenges = new Map<string, MobileTelegramLoginChallenge>();

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

function pruneExpired(now = Date.now()) {
  for (const [code, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(code);
  }
  // 留一个空位给马上要插入的这一条。
  while (challenges.size >= MAX_MOBILE_LOGIN_CHALLENGES) {
    const oldest = challenges.keys().next().value;
    if (oldest === undefined) break;
    challenges.delete(oldest);
  }
}

export function mobileTelegramLoginChallengeCount() {
  return challenges.size;
}

export function createMobileTelegramLoginChallenge(code: string, ttlMs: number) {
  pruneExpired();
  challenges.set(normalizeCode(code), { expiresAt: Date.now() + ttlMs });
}

export function hasMobileTelegramLoginChallenge(code: string) {
  const normalized = normalizeCode(code);
  const challenge = challenges.get(normalized);
  if (!challenge) return false;
  if (challenge.expiresAt <= Date.now()) {
    challenges.delete(normalized);
    return false;
  }
  return true;
}

export function takeMobileTelegramLoginChallenge(code: string) {
  const normalized = normalizeCode(code);
  if (!hasMobileTelegramLoginChallenge(normalized)) return false;
  challenges.delete(normalized);
  return true;
}

export function clearMobileTelegramLoginChallenge(code: string) {
  challenges.delete(normalizeCode(code));
}
