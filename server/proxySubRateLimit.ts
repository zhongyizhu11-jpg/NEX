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

/** 定时清掉窗口外的键，免得长期占着。 */
export function pruneProxySubRateLimit(now = Date.now()) {
  const since = now - WINDOW_MS;
  pruneMapEntries(tokenHits, (list) => !list.some((at) => at > since));
  pruneMapEntries(ipHits, (list) => !list.some((at) => at > since));
}

export function clearProxySubRateLimitForTests() {
  tokenHits.clear();
  ipHits.clear();
}
