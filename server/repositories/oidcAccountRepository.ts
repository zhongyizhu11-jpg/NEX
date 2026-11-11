import { and, eq } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { executeRaw, getDb, quoteDbIdentifier, rawAffectedRows } from "../dbRuntime";

/*
  users 表上通用 OIDC 绑定的几列（oidcIssuer / oidcSub / oidcEmail / oidcLinkedAt）的读写。
  认人只看 (oidcIssuer, oidcSub)，两列有联合唯一索引；邮箱只用来显示。
  「这个邮箱已经有账号」「用户名占没占」和 Google 用同一份查询（googleAccountRepository）。
*/

const q = (id: string) => quoteDbIdentifier(id);
const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function getUserByOidcIdentity(issuer: string, sub: string) {
  const db = await getDb();
  if (!db || !issuer || !sub) return undefined;
  const rows = await db.select().from(users).where(and(eq(users.oidcIssuer, issuer), eq(users.oidcSub, sub))).limit(1);
  return rows[0];
}

/**
 * 绑定：只在这个账号还没绑过、或者绑的是别的（旧）Issuer 时写。
 * 同一个 (issuer, sub) 已经在别的账号上时，唯一索引会让这条 UPDATE 报错 —— 调用方当作「已被绑定」处理。
 * 返回是否真的写进去了。
 */
export async function linkOidcAccount(userId: number, issuer: string, sub: string, email: string) {
  const result = await executeRaw(
    `UPDATE ${q("users")} SET ${q("oidcIssuer")} = ?, ${q("oidcSub")} = ?, ${q("oidcEmail")} = ?, ${q("oidcLinkedAt")} = ?, ${q("updatedAt")} = ? `
      + `WHERE ${q("id")} = ? AND (${q("oidcSub")} IS NULL OR ${q("oidcIssuer")} IS NULL OR ${q("oidcIssuer")} <> ?)`,
    [issuer, sub, email, nowSeconds(), nowSeconds(), userId, issuer],
  );
  return rawAffectedRows(result) > 0;
}

export async function unlinkOidcAccount(userId: number) {
  const result = await executeRaw(
    `UPDATE ${q("users")} SET ${q("oidcIssuer")} = NULL, ${q("oidcSub")} = NULL, ${q("oidcEmail")} = NULL, ${q("oidcLinkedAt")} = NULL, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("oidcSub")} IS NOT NULL`,
    [nowSeconds(), userId],
  );
  return rawAffectedRows(result) > 0;
}

/** OIDC 登录成功：记一下登录时间，顺手把显示用的邮箱更新成 IdP 这次给的。 */
export async function recordOidcSignIn(userId: number, email: string) {
  await executeRaw(
    `UPDATE ${q("users")} SET ${q("oidcEmail")} = ?, ${q("lastSignedIn")} = ? WHERE ${q("id")} = ?`,
    [email, nowSeconds(), userId],
  );
}
