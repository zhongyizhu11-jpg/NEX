/**
 * 订阅正文的内存缓存。
 *
 * 一次订阅拉取要查转发、模板、主机、分享、探测，再渲染；客户端默认十二小时刷一次
 * 看不出来，可有人把间隔调到几分钟、一个商家几百个租户时，面板就在反复算同一份东西。
 *
 * 键里带一个按用户的版本号：转发、节点、分享、令牌一改就把这个用户的版本号加一，
 * 旧键再也匹配不上；同时按「用户 → 键」的索引把这个用户的条目直接删掉，内存马上还回来
 * （原来只换版本号，旧条目要等 TTL 到或被挤出去）。资格判定（停用 / 到期 / 超流量）不在
 * 缓存里 —— 每次都查，所以不会出现「停用后一分钟内还能拉」。
 *
 * 容量两道上限：条数（2000）和字节数（默认 128 MB，环境变量 FORWARDX_PROXY_SUB_CACHE_MAX_BYTES 可调）。
 * 字节数按正文 utf8 加上压好的 gzip / br 一起算 —— 一份 Clash 配置几百 KB、三份字节一起存，只按条数
 * 限的话最坏能吃掉 1 GB 多。超了先进先出淘汰。
 */

import { createHash } from "node:crypto";
import { promisify } from "node:util";
import zlib from "node:zlib";


/**
 * 缓存里存的是「发出去的样子」：utf8 字节、ETag，和第一次有人要时压好的 gzip / br。
 *
 * 原来存的是字符串，每次命中都要重新编码成字节、对整份正文算一遍 sha1 当 ETag、再交给压缩中间件
 * 现压一遍（一份五百 KB 的 Clash 配置，命中一次还要吃十毫秒上下的 CPU）。现在这几样每个条目只做一次。
 * 存字节也比存字符串省内存：中文多的正文在 V8 里是双字节字符串，utf8 字节大约只占一半。
 */
export type ProxySubPreparedBody = {
  buffer: Buffer;
  /** 和 express 自己算的一模一样的弱 ETag（etag 包：utf8 长度的十六进制 + sha1 的 base64 前 27 位）。 */
  etag: string;
  compressed: Partial<Record<ProxySubBodyEncoding, Promise<Buffer>>>;
  /** 压好的那几份各占多少字节（压完才知道；缓存按它算总字节数）。 */
  compressedBytes: Partial<Record<ProxySubBodyEncoding, number>>;
  /** 按 IPv4 / IPv6 输出时跳过的条数（命中缓存时照样要发 X-ForwardX-Skipped-Entries）。 */
  skippedEntries?: number;
};

export type ProxySubBodyEncoding = "gzip" | "br";

type CachedEntry = { prepared: ProxySubPreparedBody; expiresAt: number; userId: number; bytes: number };

export function prepareProxySubBody(body: string): ProxySubPreparedBody {
  const buffer = Buffer.from(body, "utf8");
  const hash = createHash("sha1").update(buffer).digest("base64").substring(0, 27);
  return { buffer, etag: `W/"${buffer.length.toString(16)}-${hash}"`, compressed: {}, compressedBytes: {} };
}

function preparedBytes(prepared: ProxySubPreparedBody): number {
  let total = prepared.buffer.length;
  for (const size of Object.values(prepared.compressedBytes)) total += size || 0;
  return total;
}

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

/**
 * 压好的正文，同一个条目只压一次（并发来的几个请求等同一个 Promise）。
 * 参数和 server/index.ts 的 compression 中间件一致：gzip 默认级别，br 质量 4（compression 1.8 的默认）。
 */
export function compressedProxySubBody(prepared: ProxySubPreparedBody, encoding: ProxySubBodyEncoding): Promise<Buffer> {
  let pending = prepared.compressed[encoding];
  if (!pending) {
    pending = encoding === "gzip"
      ? gzip(prepared.buffer)
      : brotli(prepared.buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    // 压失败了别把坏的 Promise 留在条目上：下一次重新压。
    pending.then(
      (compressed) => {
        prepared.compressedBytes[encoding] = compressed.length;
        // 条目已经在缓存里时，压好的这份也算进总字节数（可能因此挤掉最老的）。
        noteCachedBytesGrew(prepared, compressed.length);
      },
      () => {
        if (prepared.compressed[encoding] === pending) delete prepared.compressed[encoding];
      },
    );
    prepared.compressed[encoding] = pending;
  }
  return pending;
}

const MAX_ENTRIES = 2_000;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

function maxBytesFromEnv(): number {
  const raw = Number(process.env.FORWARDX_PROXY_SUB_CACHE_MAX_BYTES);
  // 太小的值等于关掉缓存，当成没设；至少 1 MB。
  return Number.isFinite(raw) && raw >= 1024 * 1024 ? Math.floor(raw) : DEFAULT_MAX_BYTES;
}

let maxBytes = maxBytesFromEnv();
let totalBytes = 0;
const entries = new Map<string, CachedEntry>();
/** 用户 → 这个用户在 entries / contextEntries 里的键，按用户作废时直接删条目。 */
const keysByUser = new Map<number, Set<string>>();
const contextKeysByUser = new Map<number, Set<string>>();
const keyOfPrepared = new WeakMap<ProxySubPreparedBody, string>();
const versions = new Map<number, number>();
let globalVersion = 0;

function versionOf(userId: number): number {
  return versions.get(userId) || 0;
}

export function proxySubCacheKey(userId: number, parts: readonly unknown[]): string {
  const digest = createHash("sha1").update(JSON.stringify(parts)).digest("hex");
  return `${userId}:${globalVersion}:${versionOf(userId)}:${digest}`;
}

/** 键的前缀就是用户 id（proxySubCacheKey 生成的）；别的键算到 0 上，不进按用户的索引。 */
function userIdOfKey(key: string): number {
  const id = Number(key.slice(0, key.indexOf(":")));
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function indexKey(index: Map<number, Set<string>>, userId: number, key: string) {
  if (userId <= 0) return;
  let keys = index.get(userId);
  if (!keys) {
    keys = new Set();
    index.set(userId, keys);
  }
  keys.add(key);
}

function unindexKey(index: Map<number, Set<string>>, userId: number, key: string) {
  if (userId <= 0) return;
  const keys = index.get(userId);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) index.delete(userId);
}

function deleteEntry(key: string, entry: CachedEntry) {
  entries.delete(key);
  totalBytes -= entry.bytes;
  unindexKey(keysByUser, entry.userId, key);
}

/** 先进先出淘汰到两道上限之内（Map 的迭代顺序就是插入顺序）。 */
function evictToLimits(limitEntries = MAX_ENTRIES) {
  for (const [key, entry] of entries) {
    if (entries.size <= limitEntries && totalBytes <= maxBytes) break;
    deleteEntry(key, entry);
  }
}

function noteCachedBytesGrew(prepared: ProxySubPreparedBody, delta: number) {
  const key = keyOfPrepared.get(prepared);
  if (!key) return;
  const entry = entries.get(key);
  if (!entry || entry.prepared !== prepared) return;
  entry.bytes += delta;
  totalBytes += delta;
  evictToLimits();
}

export function getProxySubCached(key: string, now = Date.now()): ProxySubPreparedBody | null {
  const hit = entries.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    deleteEntry(key, hit);
    return null;
  }
  return hit.prepared;
}

export function setProxySubCached(key: string, prepared: ProxySubPreparedBody, ttlSec: number, now = Date.now()) {
  if (ttlSec <= 0) return;
  const bytes = preparedBytes(prepared);
  // 一份就超过整个上限的不缓存（存进去也只会立刻把别人全挤掉）。
  if (bytes > maxBytes) return;
  // 过期的顺手清掉，不等满了再清。
  if (entries.size >= MAX_ENTRIES || totalBytes + bytes > maxBytes) {
    for (const [existingKey, entry] of entries) if (entry.expiresAt <= now) deleteEntry(existingKey, entry);
  }
  const previous = entries.get(key);
  if (previous) deleteEntry(key, previous);
  // 腾出位置后再放：放进去之后它自己是最新的，不会被这一轮淘汰掉。
  evictToLimits(MAX_ENTRIES - 1);
  while (entries.size > 0 && totalBytes + bytes > maxBytes) {
    const oldest = entries.entries().next().value as [string, CachedEntry];
    deleteEntry(oldest[0], oldest[1]);
  }
  const userId = userIdOfKey(key);
  entries.set(key, { prepared, expiresAt: now + ttlSec * 1000, userId, bytes });
  totalBytes += bytes;
  indexKey(keysByUser, userId, key);
  keyOfPrepared.set(prepared, key);
}

/*
  正文缓存底下再垫一层：按用户缓存组装好的上下文（plan、模板、透传来源）。

  正文缓存按「令牌 × 格式 × 规则 × 客户端 × 选项……」分键，同一个用户的手机、电脑、路由器各拉各的，
  每一种组合第一次来都要把这个用户的转发、模板、主机、分享、探测再查一遍（8～10 条），而这些只跟
  用户有关、跟令牌和格式无关。这一层的键只有用户 + 版本号 + 几个影响组装的开关，几个客户端共用一份；
  TTL 跟正文缓存一样（设置里的 cacheTtlSec），所以陈旧程度不会比正文缓存更差。
  键里同样带全局版本和这个用户的版本号：每一条让正文作废的路（invalidateProxySubCacheForUser / All）
  同时让它作废，不用另记一套失效。
*/
const MAX_CONTEXT_ENTRIES = 1_000;
const contextEntries = new Map<string, { value: unknown; expiresAt: number; userId: number }>();

function deleteContextEntry(key: string) {
  const entry = contextEntries.get(key);
  if (!entry) return;
  contextEntries.delete(key);
  unindexKey(contextKeysByUser, entry.userId, key);
}

export function getProxySubContextCached<T>(key: string, now = Date.now()): T | null {
  const hit = contextEntries.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    deleteContextEntry(key);
    return null;
  }
  return hit.value as T;
}

export function setProxySubContextCached(key: string, value: unknown, ttlSec: number, now = Date.now()) {
  if (ttlSec <= 0) return;
  if (contextEntries.size >= MAX_CONTEXT_ENTRIES) {
    for (const [existingKey, entry] of contextEntries) if (entry.expiresAt <= now) deleteContextEntry(existingKey);
  }
  deleteContextEntry(key);
  while (contextEntries.size >= MAX_CONTEXT_ENTRIES) {
    const oldestKey = contextEntries.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    deleteContextEntry(oldestKey);
  }
  const userId = userIdOfKey(key);
  contextEntries.set(key, { value, expiresAt: now + ttlSec * 1000, userId });
  indexKey(contextKeysByUser, userId, key);
}

/**
 * 全站作废时顺带要清的别的内存缓存（比如模板清单）在这里登记：改模板、改设置、改规则域名这些路
 * 本来就都走 invalidateProxySubCacheAll，不用每条路再多记一个调用。
 */
const invalidateAllListeners = new Set<() => void>();

export function onProxySubCacheInvalidateAll(listener: () => void) {
  invalidateAllListeners.add(listener);
}

/** 这个用户的订阅内容变了（转发、节点、分享、令牌、作用域……）：条目当场删掉，版本号也加一（正在构建中的别写回来）。 */
export function invalidateProxySubCacheForUser(userId: unknown) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return;
  for (const key of keysByUser.get(id) || []) {
    const entry = entries.get(key);
    if (entry) deleteEntry(key, entry);
  }
  for (const key of Array.from(contextKeysByUser.get(id) || [])) deleteContextEntry(key);
  versions.set(id, versionOf(id) + 1);
  // 版本表本身也别无限长：一千个用户一千行很小，但要防着被随机 id 刷。
  if (versions.size > 20_000) {
    versions.clear();
    // 清表等于把每个用户的版本号归零，刚作废的老键就又能匹配上了；全局版本加一，让它们一起失效。
    globalVersion += 1;
  }
}

/** 全站都变了（设置、模板、规则集镜像……）。 */
export function invalidateProxySubCacheAll() {
  globalVersion += 1;
  clearEntries();
  for (const listener of invalidateAllListeners) listener();
}

function clearEntries() {
  entries.clear();
  contextEntries.clear();
  keysByUser.clear();
  contextKeysByUser.clear();
  totalBytes = 0;
}

/** 条数、字节数和两道上限（运维 / 指标看）。 */
export function proxySubCacheStats() {
  return { entries: entries.size, bytes: totalBytes, maxEntries: MAX_ENTRIES, maxBytes, contextEntries: contextEntries.size };
}

export function proxySubCacheSizeForTests() {
  return entries.size;
}

export function clearProxySubCacheForTests(options: { maxBytes?: number } = {}) {
  clearEntries();
  versions.clear();
  globalVersion = 0;
  maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : maxBytesFromEnv();
}
