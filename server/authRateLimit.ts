/**
 * In-process authentication attempt limits shared by password and 2FA flows.
 *
 * The panel already keeps these counters in memory for password login. Keeping
 * the 2FA paths on the same counters prevents an attacker from moving between
 * login, challenge verification, and 2FA-management endpoints to reset the
 * failure budget.
 *
 * 多实例（server/sharedState.ts 判断为 db 模式）时这些计数经 SharedCounter 写进 auth_attempt_counters，
 * 各实例共享：攻击者的请求轮着落到几个实例上，锁定阈值仍然是 8 次，不是 8 × 实例数。接口保持同步
 * （登录流程里是同步判断）：判断看本进程的缓存，失败同步记进缓存、异步写库，库回来的总数覆盖缓存，
 * 判断时顺手异步刷新 —— 每个实例对同一个键最多多放一次，见 sharedStateCounter.ts。SQLite 部署永远是内存。
 */

import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { registerSharedStateCleanup, sharedStateMode } from "./sharedState";
import { SharedCounter } from "./sharedStateCounter";
import { SqlAttemptCounterStore } from "./sharedStateStore";

export type AuthRateLimitState = {
  limited: boolean;
  retryAfterSeconds: number;
};

export const LOGIN_FAIL_WINDOW_MS = 30 * 60 * 1000;
export const LOGIN_BLOCK_MS = 15 * 60 * 1000;
export const LOGIN_BLOCK_THRESHOLD_PER_ACCOUNT = 8;
export const LOGIN_BLOCK_THRESHOLD_PER_IP = 40;

export const TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS = 60 * 1000;
export const TWO_FACTOR_CHALLENGE_ISSUE_MAX = 5;

const AUTH_RATE_LIMIT_MAX_KEYS = 50_000;

/*
  失败计数：IP + 账户、账户、IP 三个维度各一份。「最近一次失败后 30 分钟内再失败就累加，隔了 30 分钟
  没动静就从头数」—— SharedCounter 的 anchor = last。内存模式下和以前的 Map 一模一样。
*/
const loginFailStore = new SharedCounter({ scope: "login-pair", windowMs: LOGIN_FAIL_WINDOW_MS, anchor: "last", maxKeys: AUTH_RATE_LIMIT_MAX_KEYS });
const loginAccountFailStore = new SharedCounter({ scope: "login-account", windowMs: LOGIN_FAIL_WINDOW_MS, anchor: "last", maxKeys: AUTH_RATE_LIMIT_MAX_KEYS });
const loginIpFailStore = new SharedCounter({ scope: "login-ip", windowMs: LOGIN_FAIL_WINDOW_MS, anchor: "last", maxKeys: AUTH_RATE_LIMIT_MAX_KEYS });

/*
  2FA 挑战签发次数：内存模式是时间戳列表（滑动窗口，老的一个个滑出去）；db 模式是 SharedCounter（anchor = first，
  一分钟内最多 5 次、到点清零）—— 一行能原子更新，列表不能。两套各自独立，切换模式那一刻不互通。
*/
const challengeIssueStore = new Map<string, number[]>();
const challengeIssueAccountStore = new Map<string, number[]>();
const challengeIssueIpStore = new Map<string, number[]>();
const sharedChallengeIssueStore = new SharedCounter({ scope: "2fa-issue-pair", windowMs: TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS, anchor: "first", maxKeys: AUTH_RATE_LIMIT_MAX_KEYS });
const sharedChallengeIssueAccountStore = new SharedCounter({ scope: "2fa-issue-account", windowMs: TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS, anchor: "first", maxKeys: AUTH_RATE_LIMIT_MAX_KEYS });
const sharedChallengeIssueIpStore = new SharedCounter({ scope: "2fa-issue-ip", windowMs: TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS, anchor: "first", maxKeys: AUTH_RATE_LIMIT_MAX_KEYS });

function normalizeIp(ip: string) {
  // IPv6 按 /64 归并，见 ipRateLimitScope。
  return ipRateLimitScope(ip);
}

function normalizeUsername(username: string) {
  return String(username || "").trim().toLowerCase();
}

export function getAuthAttemptKey(ip: string, username: string) {
  return `${normalizeIp(ip)}:${normalizeUsername(username)}`;
}

/** Record a 2FA failure for pair, account, and IP scopes. */
export function recordAuthFailure(ip: string, username: string, now = Date.now()) {
  loginFailStore.bump(getAuthAttemptKey(ip, username), now);
  loginAccountFailStore.bump(normalizeUsername(username), now);
  loginIpFailStore.bump(normalizeIp(ip), now);
}

/** Password failures remain scoped to the source IP to avoid account lockout DoS. */
export function recordPasswordFailure(ip: string, username: string, now = Date.now()) {
  loginFailStore.bump(getAuthAttemptKey(ip, username), now);
  loginIpFailStore.bump(normalizeIp(ip), now);
}

/** Explicit name for callers handling a known account's 2FA proof. */
export const recordTwoFactorFailure = recordAuthFailure;

/** Return the same block state used by the password login endpoint. */
export function authRateLimitState(ip: string, username: string, now = Date.now()): AuthRateLimitState {
  const checks = [
    { entry: loginFailStore.state(getAuthAttemptKey(ip, username), now), threshold: LOGIN_BLOCK_THRESHOLD_PER_ACCOUNT },
    { entry: loginAccountFailStore.state(normalizeUsername(username), now), threshold: LOGIN_BLOCK_THRESHOLD_PER_ACCOUNT },
    { entry: loginIpFailStore.state(normalizeIp(ip), now), threshold: LOGIN_BLOCK_THRESHOLD_PER_IP },
  ];
  for (const check of checks) {
    const entry = check.entry;
    if (!entry || entry.count < check.threshold) continue;
    const retryAt = entry.lastAt + LOGIN_BLOCK_MS;
    if (retryAt > now) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
      };
    }
  }
  return { limited: false, retryAfterSeconds: 0 };
}

/** Clear the target account's failures after a successful authentication. */
export function clearAuthAccountFailures(ip: string, username: string) {
  loginFailStore.clear(getAuthAttemptKey(ip, username));
  loginAccountFailStore.clear(normalizeUsername(username));
}

function challengeIssueKey(ip: string, username: string) {
  return getAuthAttemptKey(ip, username);
}

function challengeIssueScopes(ip: string, username: string) {
  return [
    { store: challengeIssueStore, shared: sharedChallengeIssueStore, key: challengeIssueKey(ip, username) },
    { store: challengeIssueAccountStore, shared: sharedChallengeIssueAccountStore, key: normalizeUsername(username) },
    { store: challengeIssueIpStore, shared: sharedChallengeIssueIpStore, key: normalizeIp(ip) },
  ];
}

/**
 * Limit successful-password 2FA challenge issuance as well as failed guesses.
 * Without this separate window, an attacker with the password could mint an
 * unlimited number of fresh five-attempt challenges.
 */
export function twoFactorChallengeIssueState(ip: string, username: string, now = Date.now()): AuthRateLimitState {
  const cutoff = now - TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS;
  const shared = sharedStateMode() === "db";
  let retryAfterSeconds = 0;
  for (const scope of challengeIssueScopes(ip, username)) {
    if (shared) {
      const entry = scope.shared.state(scope.key, now);
      if (entry && entry.count >= TWO_FACTOR_CHALLENGE_ISSUE_MAX) {
        retryAfterSeconds = Math.max(retryAfterSeconds, Math.ceil((entry.firstAt + TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS - now) / 1000));
      }
      continue;
    }
    const timestamps = scope.store.get(scope.key);
    if (!timestamps) continue;
    const active = timestamps.filter((timestamp) => timestamp > cutoff);
    if (active.length > 0) setBoundedMapValue(scope.store, scope.key, active, AUTH_RATE_LIMIT_MAX_KEYS);
    else scope.store.delete(scope.key);
    if (active.length >= TWO_FACTOR_CHALLENGE_ISSUE_MAX) {
      retryAfterSeconds = Math.max(retryAfterSeconds, Math.ceil((active[0] + TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS - now) / 1000));
    }
  }
  return retryAfterSeconds > 0
    ? { limited: true, retryAfterSeconds: Math.max(1, retryAfterSeconds) }
    : { limited: false, retryAfterSeconds: 0 };
}

export function recordTwoFactorChallengeIssue(ip: string, username: string, now = Date.now()) {
  const cutoff = now - TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS;
  const shared = sharedStateMode() === "db";
  for (const scope of challengeIssueScopes(ip, username)) {
    if (shared) {
      scope.shared.bump(scope.key, now);
      continue;
    }
    const active = (scope.store.get(scope.key) || []).filter((timestamp) => timestamp > cutoff);
    active.push(now);
    setBoundedMapValue(scope.store, scope.key, active, AUTH_RATE_LIMIT_MAX_KEYS);
  }
}

/*
  「一段时间内最多几次」的通用额度（找回密码用）。上面那套是失败计数 —— 输错才记、成功就清；
  发重置链接这种事每申请一次都要算，不管成没成，所以另开一份，但和上面共用同一个文件、同一个清理定时器。
  键由调用方拼好（IP 先过 ipRateLimitScope，账号用 user id），这里只管数数。
  db 模式同样换成 SharedCounter（anchor = first）；窗口每个键不一样，按调用传进去。
*/
const attemptBudgetStore = new Map<string, number[]>();
/** 额度窗口最长一小时（找回密码按 IP 的那一档）；清理时按它算过期。 */
const ATTEMPT_BUDGET_MAX_WINDOW_MS = 60 * 60 * 1000;
const sharedAttemptBudgetStore = new SharedCounter({ scope: "budget", windowMs: ATTEMPT_BUDGET_MAX_WINDOW_MS, anchor: "first", maxKeys: AUTH_RATE_LIMIT_MAX_KEYS });

function activeAttempts(key: string, windowMs: number, now: number) {
  const cutoff = now - windowMs;
  return (attemptBudgetStore.get(key) || []).filter((timestamp) => timestamp > cutoff);
}

function sharedBudgetState(entry: { count: number; firstAt: number } | null, max: number, windowMs: number, now: number): AuthRateLimitState {
  if (!entry || entry.count < max) return { limited: false, retryAfterSeconds: 0 };
  return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.firstAt + windowMs - now) / 1000)) };
}

/** 只看不记：这个键现在是不是已经用完了额度。 */
export function attemptBudgetState(key: string, max: number, windowMs: number, now = Date.now()): AuthRateLimitState {
  if (sharedStateMode() === "db") return sharedBudgetState(sharedAttemptBudgetStore.state(key, now, windowMs), max, windowMs, now);
  const active = activeAttempts(key, windowMs, now);
  if (active.length < max) return { limited: false, retryAfterSeconds: 0 };
  return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((active[0] + windowMs - now) / 1000)) };
}

/** 占用一次额度。额度已满返回 limited（这一次不记，一直重试也不会把窗口越推越远）。 */
export function consumeAttemptBudget(key: string, max: number, windowMs: number, now = Date.now()): AuthRateLimitState {
  if (sharedStateMode() === "db") {
    const state = sharedBudgetState(sharedAttemptBudgetStore.state(key, now, windowMs), max, windowMs, now);
    if (!state.limited) sharedAttemptBudgetStore.bump(key, now, windowMs);
    return state;
  }
  const active = activeAttempts(key, windowMs, now);
  if (active.length >= max) {
    setBoundedMapValue(attemptBudgetStore, key, active, AUTH_RATE_LIMIT_MAX_KEYS);
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((active[0] + windowMs - now) / 1000)) };
  }
  active.push(now);
  setBoundedMapValue(attemptBudgetStore, key, active, AUTH_RATE_LIMIT_MAX_KEYS);
  return { limited: false, retryAfterSeconds: 0 };
}

const sharedCounters = [
  loginFailStore, loginAccountFailStore, loginIpFailStore,
  sharedChallengeIssueStore, sharedChallengeIssueAccountStore, sharedChallengeIssueIpStore,
  sharedAttemptBudgetStore,
];

export function pruneAuthRateLimitState(now = Date.now()) {
  pruneMapEntries(attemptBudgetStore, (timestamps) => !timestamps.some((timestamp) => now - timestamp < ATTEMPT_BUDGET_MAX_WINDOW_MS));
  for (const counter of sharedCounters) counter.prune(now);
  const cutoff = now - TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS;
  for (const store of [challengeIssueStore, challengeIssueAccountStore, challengeIssueIpStore]) {
    for (const [key, timestamps] of store) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      // Cleanup neither adds keys nor refreshes eviction order. Do not delete
      // and reinsert an active key while iterating the same live Map.
      if (active.length > 0) store.set(key, active);
      else store.delete(key);
    }
  }
}

export function clearTwoFactorChallengeIssueHistory(ip: string, username: string) {
  challengeIssueStore.delete(challengeIssueKey(ip, username));
  challengeIssueAccountStore.delete(normalizeUsername(username));
  sharedChallengeIssueStore.clear(challengeIssueKey(ip, username));
  sharedChallengeIssueAccountStore.clear(normalizeUsername(username));
}

/** Test-only reset hook; no production code calls this. */
export function clearAuthRateLimitStateForTests() {
  for (const counter of sharedCounters) counter.clearAll();
  challengeIssueStore.clear();
  challengeIssueAccountStore.clear();
  challengeIssueIpStore.clear();
  attemptBudgetStore.clear();
}

/** 测试用：等 db 模式下在途的写库 / 刷新都回来。 */
export async function flushAuthRateLimitSharedState() {
  await Promise.all(sharedCounters.map((counter) => counter.flush()));
}

export function authRateLimitStoreSizesForTests() {
  return {
    failures: loginFailStore.size + loginAccountFailStore.size + loginIpFailStore.size,
    challengeIssues: challengeIssueStore.size + challengeIssueAccountStore.size + challengeIssueIpStore.size
      + sharedChallengeIssueStore.size + sharedChallengeIssueAccountStore.size + sharedChallengeIssueIpStore.size,
  };
}

const authRateLimitCleanupTimer = setInterval(() => pruneAuthRateLimitState(), 5 * 60 * 1000);
authRateLimitCleanupTimer.unref?.();

// 库里的行：最长的窗口是一小时（找回密码按 IP），最近一次在一小时之前的都已经没用了。
registerSharedStateCleanup("auth_attempt_counters", () => new SqlAttemptCounterStore().prune(ATTEMPT_BUDGET_MAX_WINDOW_MS));
