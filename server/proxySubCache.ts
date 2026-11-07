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
import { promisify } from "node:util";
import zlib from "node:zlib";

import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

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
};

export type ProxySubBodyEncoding = "gzip" | "br";

type CachedEntry = { prepared: ProxySubPreparedBody; expiresAt: number };

export function prepareProxySubBody(body: string): ProxySubPreparedBody {
  const buffer = Buffer.from(body, "utf8");
  const hash = createHash("sha1").update(buffer).digest("base64").substring(0, 27);
  return { buffer, etag: `W/"${buffer.length.toString(16)}-${hash}"`, compressed: {} };
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
    pending.catch(() => {
      if (prepared.compressed[encoding] === pending) delete prepared.compressed[encoding];
    });
    prepared.compressed[encoding] = pending;
  }
  return pending;
}

const MAX_ENTRIES = 2_000;
const entries = new Map<string, CachedEntry>();
const versions = new Map<number, number>();
let globalVersion = 0;

function versionOf(userId: number): number {
  return versions.get(userId) || 0;
}

export function proxySubCacheKey(userId: number, parts: readonly unknown[]): string {
  const digest = createHash("sha1").update(JSON.stringify(parts)).digest("hex");
  return `${userId}:${globalVersion}:${versionOf(userId)}:${digest}`;
}

export function getProxySubCached(key: string, now = Date.now()): ProxySubPreparedBody | null {
  const hit = entries.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    entries.delete(key);
    return null;
  }
  return hit.prepared;
}

export function setProxySubCached(key: string, prepared: ProxySubPreparedBody, ttlSec: number, now = Date.now()) {
  if (ttlSec <= 0) return;
  // 过期的顺手清掉，不等满了再清。
  if (entries.size >= MAX_ENTRIES) pruneMapEntries(entries, (value) => value.expiresAt <= now);
  setBoundedMapValue(entries, key, { prepared, expiresAt: now + ttlSec * 1000 }, MAX_ENTRIES);
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
