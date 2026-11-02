/**
 * 订阅地址的限流：每条令牌每分钟 N 次、每个 IP 每分钟 M 次（都在订阅设置里，0 = 不限）。
 *
 * 不是为了防暴力猜令牌（40 位 nanoid 猜不动），是为了防「客户端把更新间隔设成 10 秒」
 * 和「一条地址被贴到公开群里几百个人同时拉」—— 每次拉取都要组装一遍，不限的话
 * 面板会被一条地址拖死。
 *
 * 滑动窗口，内存里记时间戳，键数有上限。IPv6 按 /64 归并（见 ipRateLimitScope）。
 */

import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";
import { ipRateLimitScope } from "./ipRateLimitScope";

const WINDOW_MS = 60_000;
const MAX_KEYS = 50_000;

const tokenHits = new Map<string, number[]>();
const ipHits = new Map<string, number[]>();

function recordHit(store: Map<string, number[]>, key: string, limit: number, now: number): { limited: boolean; retryAfterSeconds: number } {
  if (limit <= 0) return { limited: false, retryAfterSeconds: 0 };
  const since = now - WINDOW_MS;
  const list = (store.get(key) || []).filter((at) => at > since);
  if (list.length >= limit) {
    setBoundedMapValue(store, key, list, MAX_KEYS);
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((list[0] + WINDOW_MS - now) / 1000)) };
  }
  list.push(now);
  setBoundedMapValue(store, key, list, MAX_KEYS);
  return { limited: false, retryAfterSeconds: 0 };
}

export function checkProxySubRateLimit(input: {
  tokenId: number;
  ip: string;
  tokenLimit: number;
  ipLimit: number;
  now?: number;
}): { limited: boolean; retryAfterSeconds: number; scope: "token" | "ip" | null } {
  const now = input.now ?? Date.now();
  // 先看 IP：一个 IP 刷很多条令牌时，令牌各自没超、IP 超了，也该挡。
  const byIp = recordHit(ipHits, ipRateLimitScope(String(input.ip || "")) || "-", input.ipLimit, now);
  if (byIp.limited) return { ...byIp, scope: "ip" };
  const byToken = recordHit(tokenHits, String(input.tokenId), input.tokenLimit, now);
  if (byToken.limited) return { ...byToken, scope: "token" };
  return { limited: false, retryAfterSeconds: 0, scope: null };
}

/*
  查不到的请求按 IP 计数：令牌是 40 位随机串猜不动，但短链别名是用户自己取的，
  /s/vip1、/s/home 这类用字典几秒就能撞中。一分钟里查空超过 MISS_LIMIT 次，
  这个 IP 的订阅请求（查得到的也算）全部挡 MISS_BLOCK_MS —— 只挡查空的话，
  撞中的那一次照样回 200，计数就没有意义了。
  不管设置里的限流开关：正常客户端几小时才拉一次，一分钟查空 20 次只会是在猜。
*/
export const PROXY_SUB_MISS_LIMIT = 20;
export const PROXY_SUB_MISS_WINDOW_MS = 60_000;
export const PROXY_SUB_MISS_BLOCK_MS = 15 * 60_000;

const missHits = new Map<string, number[]>();
const missBlockedUntil = new Map<string, number>();

function missKey(ip: string) {
  return ipRateLimitScope(String(ip || "")) || "-";
}

/** 这个 IP 是不是因为查空太多被挡着。 */
export function proxySubMissBlockState(ip: string, now = Date.now()): { blocked: boolean; retryAfterSeconds: number } {
  const key = missKey(ip);
  const until = missBlockedUntil.get(key) || 0;
  if (until > now) return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000)) };
  if (until) missBlockedUntil.delete(key);
  return { blocked: false, retryAfterSeconds: 0 };
}

/** 记一次查空（令牌 / 别名不存在）。到了上限就开始挡。 */
export function recordProxySubMiss(ip: string, now = Date.now()): void {
  const key = missKey(ip);
  const since = now - PROXY_SUB_MISS_WINDOW_MS;
  const list = (missHits.get(key) || []).filter((at) => at > since);
  list.push(now);
  if (list.length >= PROXY_SUB_MISS_LIMIT) {
    missHits.delete(key);
    setBoundedMapValue(missBlockedUntil, key, now + PROXY_SUB_MISS_BLOCK_MS, MAX_KEYS);
    return;
  }
  setBoundedMapValue(missHits, key, list, MAX_KEYS);
}

/** 定时清掉窗口外的键，免得长期占着。 */
export function pruneProxySubRateLimit(now = Date.now()) {
  const since = now - WINDOW_MS;
  pruneMapEntries(tokenHits, (list) => !list.some((at) => at > since));
  pruneMapEntries(ipHits, (list) => !list.some((at) => at > since));
  const missSince = now - PROXY_SUB_MISS_WINDOW_MS;
  pruneMapEntries(missHits, (list) => !list.some((at) => at > missSince));
  pruneMapEntries(missBlockedUntil, (until) => until <= now);
}

/** 重置订阅地址时清掉这条令牌的计数：计数按令牌 id 记，不清的话新地址一导入就被限流。 */
export function clearProxySubRateLimitForToken(tokenId: number) {
  tokenHits.delete(String(tokenId));
}

export function clearProxySubRateLimitForTests() {
  tokenHits.clear();
  ipHits.clear();
  missHits.clear();
  missBlockedUntil.clear();
}
