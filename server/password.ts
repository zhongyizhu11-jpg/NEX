import crypto from "crypto";

// Keep the same scrypt work for unknown accounts as for existing accounts.
// This prevents login timing from revealing whether a username is registered.
const DUMMY_PASSWORD_HASH = "00000000000000000000000000000000:9d861075585ee1229b2ddb8ca08518bafea87a1bd9325f2ae25a4238d89a0b347a57f4a1363c6b6c14534c90e7b5a2840f77a842fc850dbd1e2ad583dbdc1aa7";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, "hex");
    const testHash = crypto.scryptSync(password, salt, 64);
    return expected.length === testHash.length && crypto.timingSafeEqual(expected, testHash);
  } catch {
    return false;
  }
}

export function verifyPasswordAgainstDummy(password: string): boolean {
  return verifyPassword(password, DUMMY_PASSWORD_HASH);
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
