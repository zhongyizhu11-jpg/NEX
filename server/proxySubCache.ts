/**
 * 订阅正文的内存缓存。
 *
 * 一次订阅拉取要查转发、模板、主机、分享、探测，再渲染；客户端默认十二小时刷一次
 * 看不出来，可有人把间隔调到几分钟、一个商家几百个租户时，面板就在反复算同一份东西。
 *
 * 键里带一个按用户的版本号：转发、节点、分享、令牌一改就把这个用户的版本号加一，
 * 旧键再也匹配不上，自然过期；不用去遍历删。资格判定（停用 / 到期 / 超流量）不在
 * 缓存里 —— 每次都查，所以不会出现「停用后一分钟内还能拉」。
 */

import { createHash } from "node:crypto";

import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

export type ProxySubCachedBody = {
  body: string;
  expiresAt: number;
};

const MAX_ENTRIES = 2_000;
const entries = new Map<string, ProxySubCachedBody>();
const versions = new Map<number, number>();
let globalVersion = 0;

function versionOf(userId: number): number {
  return versions.get(userId) || 0;
}

export function proxySubCacheKey(userId: number, parts: readonly unknown[]): string {
  const digest = createHash("sha1").update(JSON.stringify(parts)).digest("hex");
  return `${userId}:${globalVersion}:${versionOf(userId)}:${digest}`;
}

export function getProxySubCached(key: string, now = Date.now()): string | null {
  const hit = entries.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    entries.delete(key);
    return null;
  }
  return hit.body;
}

export function setProxySubCached(key: string, body: string, ttlSec: number, now = Date.now()) {
  if (ttlSec <= 0) return;
  // 过期的顺手清掉，不等满了再清。
  if (entries.size >= MAX_ENTRIES) pruneMapEntries(entries, (value) => value.expiresAt <= now);
  setBoundedMapValue(entries, key, { body, expiresAt: now + ttlSec * 1000 }, MAX_ENTRIES);
}

/** 这个用户的订阅内容变了（转发、节点、分享、令牌、作用域……）。 */
export function invalidateProxySubCacheForUser(userId: unknown) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return;
  versions.set(id, versionOf(id) + 1);
  // 版本表本身也别无限长：一千个用户一千行很小，但要防着被随机 id 刷。
  if (versions.size > 20_000) versions.clear();
}

/** 全站都变了（设置、模板、规则集镜像……）。 */
export function invalidateProxySubCacheAll() {
  globalVersion += 1;
  entries.clear();
}

export function proxySubCacheSizeForTests() {
  return entries.size;
}

export function clearProxySubCacheForTests() {
  entries.clear();
  versions.clear();
  globalVersion = 0;
}
