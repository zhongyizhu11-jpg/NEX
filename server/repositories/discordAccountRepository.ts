import { and, eq, sql } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { executeRaw, getDb, quoteDbIdentifier, rawAffectedRows } from "../dbRuntime";

/*
  users 表上 Discord 绑定的几列（discordId / discordUsername / discordEmail / discordLinkedAt /
  discordDmBlockedAt）的读写。认人只看 discordId；用户名和邮箱只用来显示。
  「这个邮箱已经有账号了」「用户名占没占」和 Google 登录共用 googleAccountRepository 里那两个。
*/

const q = (id: string) => quoteDbIdentifier(id);
const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function getUserByDiscordId(discordId: string) {
  const db = await getDb();
  if (!db || !discordId) return undefined;
  const rows = await db.select().from(users).where(eq(users.discordId, discordId)).limit(1);
  return rows[0];
}

/**
 * 绑定：只在这个账号还没绑过 Discord 时写（WHERE discordId IS NULL）。
 * 同一个 Discord ID 已经在别的账号上时，唯一约束会让这条 UPDATE 报错 —— 调用方当作「已被绑定」处理。
 * 返回是否真的写进去了。
 */
export async function linkDiscordAccount(userId: number, discordId: string, username: string | null, email: string | null) {
  const result = await executeRaw(
    `UPDATE ${q("users")} SET ${q("discordId")} = ?, ${q("discordUsername")} = ?, ${q("discordEmail")} = ?, ${q("discordLinkedAt")} = ?, ${q("discordDmBlockedAt")} = NULL, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("discordId")} IS NULL`,
    [discordId, username, email, nowSeconds(), nowSeconds(), userId],
  );
  return rawAffectedRows(result) > 0;
}

export async function unlinkDiscordAccount(userId: number) {
  const result = await executeRaw(
    `UPDATE ${q("users")} SET ${q("discordId")} = NULL, ${q("discordUsername")} = NULL, ${q("discordEmail")} = NULL, ${q("discordLinkedAt")} = NULL, ${q("discordDmBlockedAt")} = NULL, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("discordId")} IS NOT NULL`,
    [nowSeconds(), userId],
  );
  return rawAffectedRows(result) > 0;
}

/** Discord 登录成功：记一下登录时间，顺手把显示用的用户名 / 邮箱更新成这次 Discord 给的。 */
export async function recordDiscordSignIn(userId: number, username: string, email: string) {
  await executeRaw(
    `UPDATE ${q("users")} SET ${q("discordUsername")} = ?, ${q("discordEmail")} = ?, ${q("lastSignedIn")} = ? WHERE ${q("id")} = ?`,
    [username, email, nowSeconds(), userId],
  );
}

/** 私信被拒收（对方关了私信 / 和机器人没有共同服务器）：记下时间，一段时间内不再试。传 null 清掉。 */
export async function setDiscordDmBlockedAt(userId: number, at: Date | null) {
  await executeRaw(
    `UPDATE ${q("users")} SET ${q("discordDmBlockedAt")} = ? WHERE ${q("id")} = ?`,
    [at ? Math.floor(at.getTime() / 1000) : null, userId],
  );
}

export type DiscordRecipient = {
  id: number;
  username: string;
  name: string | null;
  role: string;
  discordId: string;
  discordDmBlockedAt: Date | null;
};

const recipientColumns = {
  id: users.id,
  username: users.username,
  name: users.name,
  role: users.role,
  discordId: users.discordId,
  discordDmBlockedAt: users.discordDmBlockedAt,
};

/** 绑定了 Discord、没停用的管理员（通知收件人；和 getTelegramAdminRecipients 对应）。 */
export async function getDiscordAdminRecipients(): Promise<DiscordRecipient[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select(recipientColumns)
    .from(users)
    .where(and(eq(users.accountEnabled, true), eq(users.role, "admin"), sql`${users.discordId} IS NOT NULL`));
  return rows as DiscordRecipient[];
}

/** 绑定了 Discord、没停用的所有用户（提醒用）。 */
export async function getDiscordLinkedUsers(): Promise<DiscordRecipient[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select(recipientColumns)
    .from(users)
    .where(and(eq(users.accountEnabled, true), sql`${users.discordId} IS NOT NULL`));
  return rows as DiscordRecipient[];
}
