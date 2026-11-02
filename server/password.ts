import crypto from "crypto";
import { promisify } from "util";

// Keep the same scrypt work for unknown accounts as for existing accounts.
// This prevents login timing from revealing whether a username is registered.
const DUMMY_PASSWORD_HASH = "00000000000000000000000000000000:9d861075585ee1229b2ddb8ca08518bafea87a1bd9325f2ae25a4238d89a0b347a57f4a1363c6b6c14534c90e7b5a2840f77a842fc850dbd1e2ad583dbdc1aa7";

/*
  scrypt 走异步版本（libuv 线程池）：同步的 scryptSync 每次要卡住事件循环几十毫秒，
  换着 IP 刷登录就能拖慢整个面板，连 Agent 心跳一起卡。哈希格式（salt:hash，64 字节）不变。
*/
const scryptAsync = promisify(crypto.scrypt) as (password: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)).toString("hex");
  return `${salt}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) {
    // 不是 salt:hash 的格式（比如「不能用的密码」标记）：照样跑一次 scrypt，时间和真密码差不多。
    await verifyPasswordAgainstDummy(password);
    return false;
  }
  try {
    const expected = Buffer.from(hash, "hex");
    const testHash = await scryptAsync(password, salt, 64);
    return expected.length === testHash.length && crypto.timingSafeEqual(expected, testHash);
  } catch {
    return false;
  }
}

export async function verifyPasswordAgainstDummy(password: string): Promise<boolean> {
  const [salt, hash] = DUMMY_PASSWORD_HASH.split(":");
  try {
    const expected = Buffer.from(hash, "hex");
    const testHash = await scryptAsync(password, salt, 64);
    return expected.length === testHash.length && crypto.timingSafeEqual(expected, testHash);
  } catch {
    return false;
  }
}

/*
  「不能用的密码」：Google 注册的新账号没有密码，但 users.password 不能为空。存一个
  "!unusable:<随机数>" —— 它不是 salt:hash 的格式，verifyPassword 永远返回 false（仍然跑一次
  scrypt，时间和真密码差不多），谁也不知道它对应什么。之后用户自己设了密码、或管理员重置了密码，
  整个字段被新哈希覆盖，标记自然消失。hasUsablePassword 用来判断「解绑 Google 之后还能不能登录」。
*/
const UNUSABLE_PASSWORD_PREFIX = "!unusable:";

export function createUnusablePasswordHash() {
  return `${UNUSABLE_PASSWORD_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
}

export function hasUsablePassword(stored: string | null | undefined) {
  const text = String(stored || "");
  return !!text && !text.startsWith(UNUSABLE_PASSWORD_PREFIX);
}
