import { eq, sql } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { executeRaw, getDb, quoteDbIdentifier, rawAffectedRows } from "../dbRuntime";
import { hashPassword } from "../password";

/*
  users 表上 Google 绑定的几列（googleSub / googleEmail / googleLinkedAt）的读写。
  认人只看 googleSub；邮箱只用来显示，也用来挡「这个邮箱已经有账号了」的注册。
*/

const q = (id: string) => quoteDbIdentifier(id);
const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function getUserByGoogleSub(sub: string) {
  const db = await getDb();
  if (!db || !sub) return undefined;
  const rows = await db.select().from(users).where(eq(users.googleSub, sub)).limit(1);
  return rows[0];
}

/**
 * 绑定：只在这个账号还没绑过 Google 时写（WHERE googleSub IS NULL）。
 * 同一个 sub 已经在别的账号上时，唯一约束会让这条 UPDATE 报错 —— 调用方当作「已被绑定」处理。
 * 返回是否真的写进去了。
 */
export async function linkGoogleAccount(userId: number, sub: string, email: string) {
  const result = await executeRaw(
    `UPDATE ${q("users")} SET ${q("googleSub")} = ?, ${q("googleEmail")} = ?, ${q("googleLinkedAt")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("googleSub")} IS NULL`,
    [sub, email, nowSeconds(), nowSeconds(), userId],
  );
  return rawAffectedRows(result) > 0;
}

export async function unlinkGoogleAccount(userId: number) {
  const result = await executeRaw(
    `UPDATE ${q("users")} SET ${q("googleSub")} = NULL, ${q("googleEmail")} = NULL, ${q("googleLinkedAt")} = NULL, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("googleSub")} IS NOT NULL`,
    [nowSeconds(), userId],
  );
  return rawAffectedRows(result) > 0;
}

/** Google 登录成功：记一下登录时间，顺手把显示用的邮箱更新成 Google 这次给的。 */
export async function recordGoogleSignIn(userId: number, email: string) {
  await executeRaw(
    `UPDATE ${q("users")} SET ${q("googleEmail")} = ?, ${q("lastSignedIn")} = ? WHERE ${q("id")} = ?`,
    [email, nowSeconds(), userId],
  );
}

/** 这个邮箱是不是已经是某个账号的用户名或邮箱（大小写不敏感）。 */
export async function isEmailTakenByAnyUser(email: string) {
  const db = await getDb();
  if (!db) return true;
  const normalized = email.trim().toLowerCase();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`LOWER(${users.username}) = ${normalized} OR LOWER(${users.email}) = ${normalized}`)
    .limit(1);
  return rows.length > 0;
}

export async function isUsernameTaken(username: string) {
  const db = await getDb();
  if (!db) return true;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`LOWER(${users.username}) = ${username.trim().toLowerCase()}`)
    .limit(1);
  return rows.length > 0;
}

/**
 * Google 注册的账号第一次设密码。只在现在的密码还是「不能用」标记时才写（原子地判断），
 * 已经有密码的人要走「修改密码」，得先输对旧密码。
 */
export async function setInitialPasswordForPasswordlessUser(userId: number, newPassword: string) {
  const result = await executeRaw(
    `UPDATE ${q("users")} SET ${q("password")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("password")} LIKE ?`,
    [hashPassword(newPassword), nowSeconds(), userId, "!unusable:%"],
  );
  return rawAffectedRows(result) > 0;
}
