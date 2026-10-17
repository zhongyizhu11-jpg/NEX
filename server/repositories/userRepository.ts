import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { InsertUser, users, forwardRules, forwardGroups, hosts, tunnels, trafficBillingUsage, userSubscriptions } from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, insertAndGetId, nowDate, queryRaw, quoteDbIdentifier, rawAffectedRows, withDatabaseTransaction } from "../dbRuntime";
import { createUnusablePasswordHash, hashPassword, verifyPassword, verifyPasswordAgainstDummy } from "../password";
import { getSessionKindField, type SessionKind } from "../session";
import { revokeUserAuthSessions } from "./sessionRepository";
import { appendPanelLog } from "../_core/panelLogger";
import {
  AVATAR_DAILY_CHANGE_LIMIT,
  AVATAR_RANDOM_WINDOW_LIMIT,
  AVATAR_RANDOM_WINDOW_MS,
  migrateLegacyAvatarValue,
  normalizeAvatarValue,
  randomAvataaarsValue,
} from "../../shared/avatar";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import { billingCalendarParts, billingDaysInMonth, billingMonthStart } from "../../shared/billingTime";
import { recordUserAccessPausedEvent } from "../ops/eventHooks";

export type ForwardAccessPauseReason = "manual" | "traffic_billing_balance" | "traffic_limit" | "expired" | null;

// ==================== User Queries ====================

export async function getUserByUsername(username: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (r[0]) return r[0];

  const normalized = username.trim().toLowerCase();
  if (!normalized.includes("@")) return undefined;
  const matches = await db
    .select()
    .from(users)
    .where(sql`LOWER(${users.username}) = ${normalized} OR LOWER(${users.email}) = ${normalized}`)
    .limit(2);
  return matches.length === 1 ? matches[0] : undefined;
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return r[0];
}

export async function setUserSessionToken(
  userId: number,
  sessionKind: SessionKind,
  sessionToken: string | null,
  options: { touchUserUpdatedAt?: boolean } = {},
) {
  const db = await getDb();
  if (!db) return;
  const field = getSessionKindField(sessionKind);
  const patch: Record<string, unknown> = {};
  if (options.touchUserUpdatedAt !== false) {
    patch.updatedAt = nowDate();
  }
  patch[field] = sessionToken || null;
  await db.update(users).set(patch as any).where(eq(users.id, userId));
}

export async function clearUserSessionToken(userId: number, sessionKind: SessionKind) {
  await setUserSessionToken(userId, sessionKind, null);
}

export async function getUserByTelegramId(telegramId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(users).where(eq(users.telegramId, telegramId)).limit(1);
  return r[0];
}

export async function getUserByTelegramBindCode(code: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(users).where(eq(users.telegramBindCode, code)).limit(1);
  return r[0];
}

export async function getUserByTelegramLoginCode(code: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(users).where(eq(users.telegramLoginCode, code)).limit(1);
  return r[0];
}

export async function authenticateUser(username: string, password: string) {
  const user = await getUserByUsername(username);
  if (!user) {
    verifyPasswordAgainstDummy(password);
    return null;
  }
  if (!verifyPassword(password, user.password)) return null;
  const db = await getDb();
  if (db && (user as any).accountEnabled !== false) {
    await db.update(users).set({ lastSignedIn: nowDate(), updatedAt: nowDate() }).where(eq(users.id, user.id));
  }
  return user;
}

export async function changeUserPassword(userId: number, oldPassword: string, newPassword: string): Promise<boolean> {
  const user = await getUserById(userId);
  if (!user) return false;
  if (!verifyPassword(oldPassword, user.password)) return false;
  const db = await getDb();
  if (!db) return false;
  await revokeUserAuthSessions(userId, { reason: "password_changed" });
  await db.update(users).set({ password: hashPassword(newPassword), updatedAt: nowDate() }).where(eq(users.id, userId));
  return true;
}

export async function verifyUserPassword(userId: number, password: string) {
  const user = await getUserById(userId);
  if (!user) return false;
  return verifyPassword(password, user.password);
}

export async function updateUserProfile(userId: number, data: { name?: string; email?: string; displayRemark?: string | null; avatar?: string | null; telegramAnnouncementSubscribed?: boolean }) {
  const db = await getDb();
  if (!db) return;
  const patch: Record<string, unknown> = { ...data, updatedAt: nowDate() };
  if (data.email !== undefined) {
    const email = data.email.trim();
    const current = await getUserById(userId);
    if (email.toLowerCase() !== String((current as any)?.email || "").trim().toLowerCase()) {
      /*
        改邮箱：不能和别人的用户名 / 邮箱撞上（登录按「用户名或邮箱」匹配，撞了两个都
        匹配上就谁也登不进去；注册也会把对方挡掉），改完「已验证」清掉 —— 新地址没验过。
      */
      const taken = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`(LOWER(${users.username}) = ${email.toLowerCase()} OR LOWER(${users.email}) = ${email.toLowerCase()}) AND ${users.id} <> ${userId}`)
        .limit(1);
      if (taken[0]) throw new Error("该邮箱已被其他账户使用");
      patch.email = email;
      patch.emailVerified = false;
      patch.emailVerifiedAt = null;
    }
  }
  await db.update(users).set(patch as any).where(eq(users.id, userId));
}

export async function getTelegramAnnouncementSubscribers() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      telegramId: users.telegramId,
      telegramUsername: users.telegramUsername,
    })
    .from(users)
    .where(and(
      eq(users.accountEnabled, true),
      eq(users.telegramAnnouncementSubscribed, true),
      sql`${users.telegramId} IS NOT NULL`,
    ));
}

export async function getTelegramAdminRecipients() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      telegramId: users.telegramId,
      telegramUsername: users.telegramUsername,
    })
    .from(users)
    .where(and(
      eq(users.accountEnabled, true),
      eq(users.role, "admin"),
      sql`${users.telegramId} IS NOT NULL`,
    ));
}

export async function enableUserTwoFactor(userId: number, secret: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({
    twoFactorEnabled: true,
    twoFactorSecret: secret,
    twoFactorEnabledAt: nowDate(),
    updatedAt: nowDate(),
  }).where(eq(users.id, userId));
}

export async function disableUserTwoFactor(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactorEnabledAt: null,
    updatedAt: nowDate(),
  }).where(eq(users.id, userId));
}

export async function createTelegramBindCode(userId: number, code: string, expiresAt: Date) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({
    telegramBindCode: code,
    telegramBindCodeExpiresAt: expiresAt,
    updatedAt: nowDate(),
  }).where(eq(users.id, userId));
}

export async function clearTelegramBindCode(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({
    telegramBindCode: null,
    telegramBindCodeExpiresAt: null,
    updatedAt: nowDate(),
  }).where(eq(users.id, userId));
}

export async function bindTelegramAccount(userId: number, telegram: {
  id: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  const now = nowDate();
  const existing = await getUserByTelegramId(telegram.id);
  if (existing && existing.id !== userId) {
    await db.update(users).set({
      telegramId: null,
      telegramUsername: null,
      telegramFirstName: null,
      telegramLastName: null,
      telegramLinkedAt: null,
      telegramLastSeenAt: null,
      telegramLoginCode: null,
      telegramLoginCodeExpiresAt: null,
      updatedAt: now,
    }).where(eq(users.id, existing.id));
  }
  await db.update(users).set({
    telegramId: telegram.id,
    telegramUsername: telegram.username || null,
    telegramFirstName: telegram.firstName || null,
    telegramLastName: telegram.lastName || null,
    telegramLinkedAt: now,
    telegramLastSeenAt: now,
    telegramBindCode: null,
    telegramBindCodeExpiresAt: null,
    updatedAt: now,
  }).where(eq(users.id, userId));
}

export async function updateTelegramLastSeen(telegramId: string, telegram?: {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  const patch: Record<string, unknown> = {
    telegramLastSeenAt: nowDate(),
    updatedAt: nowDate(),
  };
  if (telegram) {
    patch.telegramUsername = telegram.username || null;
    patch.telegramFirstName = telegram.firstName || null;
    patch.telegramLastName = telegram.lastName || null;
  }
  await db.update(users).set(patch).where(eq(users.telegramId, telegramId));
}

export async function unbindTelegramAccount(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({
    telegramId: null,
    telegramUsername: null,
    telegramFirstName: null,
    telegramLastName: null,
    telegramLinkedAt: null,
    telegramLastSeenAt: null,
    telegramBindCode: null,
    telegramBindCodeExpiresAt: null,
    telegramLoginCode: null,
    telegramLoginCodeExpiresAt: null,
    updatedAt: nowDate(),
  }).where(eq(users.id, userId));
}

export async function createTelegramLoginCode(userId: number, code: string, expiresAt: Date) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({
    telegramLoginCode: code,
    telegramLoginCodeExpiresAt: expiresAt,
    telegramLastSeenAt: nowDate(),
    updatedAt: nowDate(),
  }).where(eq(users.id, userId));
}

/**
 * 只读地查看一次性登录码指向的账户，不消费、不改库。
 * 登录页据此先让用户确认「要登录的是哪个账户」，防止别人把自己的登录链接发过来实现登录 CSRF。
 */
export async function peekTelegramLoginCode(code: string) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return null;
  const user = await getUserByTelegramLoginCode(normalized);
  if (!user) return null;
  const expiresAt = user.telegramLoginCodeExpiresAt ? new Date(user.telegramLoginCodeExpiresAt).getTime() : 0;
  if (!expiresAt || expiresAt <= Date.now()) return null;
  return user;
}

export async function consumeTelegramLoginCode(code: string) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return null;
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) return null;

    // Keep the read and clear in one transaction. SQLite serializes this
    // section through BEGIN IMMEDIATE; server databases need an explicit row
    // lock so concurrent panel instances cannot consume the same code.
    const q = quoteDbIdentifier;
    const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
    const locked = await queryRaw<{ id: number }>(
      `SELECT ${q("id")} AS ${q("id")} FROM ${q("users")} WHERE ${q("telegramLoginCode")} = ?${lock}`,
      [normalized],
    );
    const userId = Number(locked[0]?.id || 0);
    if (!userId) return null;

    // Fetch through Drizzle so epoch/date and dialect mappings stay identical
    // to getUserByTelegramLoginCode.
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user) return null;
    const expiresAt = user.telegramLoginCodeExpiresAt ? new Date(user.telegramLoginCodeExpiresAt).getTime() : 0;
    const clear = {
      telegramLoginCode: null,
      telegramLoginCodeExpiresAt: null,
      updatedAt: nowDate(),
    };
    if (!expiresAt || expiresAt <= Date.now()) {
      await db.update(users).set(clear).where(and(eq(users.id, user.id), eq(users.telegramLoginCode, normalized)));
      return null;
    }
    await db.update(users).set({ ...clear, lastSignedIn: nowDate() }).where(and(eq(users.id, user.id), eq(users.telegramLoginCode, normalized)));
    return user;
  });
}

export async function createUser(data: { username: string; password: string; name?: string; email?: string; emailVerified?: boolean; emailVerifiedAt?: Date | null; role?: "user" | "admin"; canAddRules?: boolean; allowProxySubscription?: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("users", {
    username: data.username,
    password: hashPassword(data.password),
    name: data.name ?? data.username,
    email: data.email ?? null,
    emailVerified: data.emailVerified ?? false,
    emailVerifiedAt: data.emailVerifiedAt ?? null,
    avatar: randomAvataaarsValue(String(`user-${data.username}-${Date.now()}`)),
    role: data.role ?? "user",
    accountEnabled: true,
    canAddRules: data.canAddRules ?? false,
    // 有效值与手动授权两列都写：有效值由「手动 OR 套餐」合并得出，只写手动的话
    // 要等下一次同步才生效，中间这段时间订阅地址是 404 的。
    allowProxySubscription: data.allowProxySubscription ?? false,
    manualAllowProxySubscription: data.allowProxySubscription ?? false,
  });
}

/** 用户自行注册（默认 role=user, canAddRules=false） */
export async function registerUser(data: {
  username: string;
  password: string;
  name?: string;
  email?: string;
  emailVerified?: boolean;
  emailVerifiedAt?: Date | null;
  /** 邀请返利：注册时绑定的邀请人（只在这里写一次）。 */
  inviterId?: number | null;
  /** Google 注册的账号没有密码：存一个永远对不上的标记（见 password.ts），password 字段不用。 */
  unusablePassword?: boolean;
  /** Google 注册时绑定和建号在同一条 INSERT 里（googleSub 有唯一约束，并发注册只会成功一个）。 */
  googleSub?: string | null;
  googleEmail?: string | null;
  /** Discord 注册同理：绑定和建号在同一条 INSERT 里（discordId 有唯一约束）。 */
  discordId?: string | null;
  discordUsername?: string | null;
  discordEmail?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("users", {
    username: data.username,
    password: data.unusablePassword ? createUnusablePasswordHash() : hashPassword(data.password),
    ...(data.googleSub ? { googleSub: data.googleSub, googleEmail: data.googleEmail ?? null, googleLinkedAt: nowDate() } : {}),
    ...(data.discordId ? { discordId: data.discordId, discordUsername: data.discordUsername ?? null, discordEmail: data.discordEmail ?? null, discordLinkedAt: nowDate() } : {}),
    name: data.name ?? data.username,
    email: data.email ?? null,
    emailVerified: data.emailVerified ?? false,
    emailVerifiedAt: data.emailVerifiedAt ?? null,
    avatar: randomAvataaarsValue(String(`user-${data.username}-${Date.now()}`)),
    role: "user",
    accountEnabled: true,
    canAddRules: false,
    // 邀请人：注册时凭邀请码定下来（见 server/repositories/referralRepository.ts 的 resolveRegistrationInviter）。
    inviterId: data.inviterId && data.inviterId > 0 ? data.inviterId : null,
    // 绑定时刻：这之前下的单不返利。注册时绑定就是注册这一刻。
    inviterBoundAt: data.inviterId && data.inviterId > 0 ? nowDate() : null,
  });
}

export async function updateUserAccount(userId: number, data: { username?: string; name?: string | null; password?: string; avatar?: string | null }) {
  const db = await getDb();
  if (!db) return;
  const current = await getUserById(userId);
  if (!current) throw new Error("用户不存在");
  const patch: Record<string, unknown> = { updatedAt: nowDate() };
  const username = data.username?.trim();
  if (username && username !== current.username) {
    patch.username = username;
    if (!current.email || current.email === current.username) patch.email = username;
  }
  if (data.name !== undefined) {
    const name = String(data.name || "").trim();
    patch.name = name || username || current.username;
  }
  const password = data.password?.trim();
  if (password) {
    await revokeUserAuthSessions(userId, { reason: "password_reset" });
    patch.password = hashPassword(password);
  }
  if (data.avatar !== undefined) {
    patch.avatar = normalizeAvatarValue(data.avatar) || randomAvataaarsValue(String(`user-${userId}`));
  }
  if (Object.keys(patch).length > 1) {
    await db.update(users).set(patch).where(eq(users.id, userId));
  }
}

function avatarChangeDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export async function getUserAvatarQuota(userId: number) {
  const user = await getUserById(userId);
  const today = avatarChangeDayKey();
  const isAdmin = user?.role === "admin";
  const used = !isAdmin && user?.avatarChangeDay === today ? Number(user?.avatarChangeCount || 0) : 0;
  return {
    limit: AVATAR_DAILY_CHANGE_LIMIT,
    used,
    remaining: isAdmin ? AVATAR_DAILY_CHANGE_LIMIT : Math.max(0, AVATAR_DAILY_CHANGE_LIMIT - used),
    day: today,
    unlimited: isAdmin,
  };
}

export async function updateUserAvatarWithQuota(userId: number, avatar: string, options: { actorRole?: string; countQuota?: boolean } = {}) {
  const db = await getDb();
  if (!db) return getUserAvatarQuota(userId);
  const normalized = normalizeAvatarValue(avatar) || randomAvataaarsValue(String(`user-${userId}`));
  const current = await getUserById(userId);
  if (!current) throw new Error("用户不存在");
  const isSelfServiceLimited = options.countQuota && options.actorRole !== "admin" && current.role !== "admin";

  const patch: Record<string, unknown> = {
    avatar: normalized,
    updatedAt: nowDate(),
  };

  if (isSelfServiceLimited && normalized !== current.avatar) {
    const today = avatarChangeDayKey();
    const used = current.avatarChangeDay === today ? Number(current.avatarChangeCount || 0) : 0;
    if (used >= AVATAR_DAILY_CHANGE_LIMIT) {
      throw new Error(`头像每天最多修改 ${AVATAR_DAILY_CHANGE_LIMIT} 次`);
    }
    patch.avatarChangeDay = today;
    patch.avatarChangeCount = used + 1;
  }

  await db.update(users).set(patch).where(eq(users.id, userId));
  return getUserAvatarQuota(userId);
}

const randomAvatarWindows = new Map<number, { windowStart: number; count: number }>();

export function checkAvatarRandomRateLimit(userId: number) {
  const now = Date.now();
  const current = randomAvatarWindows.get(userId);
  if (!current || now - current.windowStart >= AVATAR_RANDOM_WINDOW_MS) {
    randomAvatarWindows.set(userId, { windowStart: now, count: 1 });
    return {
      limit: AVATAR_RANDOM_WINDOW_LIMIT,
      remaining: AVATAR_RANDOM_WINDOW_LIMIT - 1,
      resetAt: new Date(now + AVATAR_RANDOM_WINDOW_MS),
    };
  }
  if (current.count >= AVATAR_RANDOM_WINDOW_LIMIT) {
    const retryAfterSeconds = Math.max(1, Math.ceil((AVATAR_RANDOM_WINDOW_MS - (now - current.windowStart)) / 1000));
    throw new Error(`随机头像生成过于频繁，请 ${retryAfterSeconds} 秒后再试`);
  }
  current.count += 1;
  return {
    limit: AVATAR_RANDOM_WINDOW_LIMIT,
    remaining: Math.max(0, AVATAR_RANDOM_WINDOW_LIMIT - current.count),
    resetAt: new Date(current.windowStart + AVATAR_RANDOM_WINDOW_MS),
  };
}

export async function updateUserAvatarRandomWithQuota(userId: number, options: { actorRole?: string; countQuota?: boolean } = {}) {
  const rateLimit = checkAvatarRandomRateLimit(userId);
  const avatar = randomAvataaarsValue(String(`user-${userId}-${Date.now()}-${rateLimit.remaining}`));
  const quota = await updateUserAvatarWithQuota(userId, avatar, options);
  return { avatar, quota, rateLimit };
}

export async function migrateLegacyUserAvatars() {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ id: users.id, avatar: users.avatar }).from(users);
  let migrated = 0;
  for (const row of rows) {
    if (!String(row.avatar || "").startsWith("preset:")) continue;
    await db.update(users).set({ avatar: migrateLegacyAvatarValue(row.avatar, `user-${row.id}`), updatedAt: nowDate() }).where(eq(users.id, row.id));
    migrated += 1;
  }
  return migrated;
}

function usersForListQuery(db: any) {
  // Aggregate billing usage totals once for the whole list query.
  // The reset column is only a presentation baseline; billing thresholds and
  // historical charge rows remain untouched when an administrator resets stats.
  const billingUsageByUser = db
    .select({
      userId: trafficBillingUsage.userId,
      totalBytes: sql<number>`COALESCE(SUM(${trafficBillingUsage.totalBytes}), 0)`.as("totalBytes"),
    })
    .from(trafficBillingUsage)
    .groupBy(trafficBillingUsage.userId)
    .as("traffic_billing_usage_by_user");

  return db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      emailVerifiedAt: users.emailVerifiedAt,
      displayRemark: users.displayRemark,
      avatar: users.avatar,
      avatarChangeDay: users.avatarChangeDay,
      avatarChangeCount: users.avatarChangeCount,
      role: users.role,
      accountEnabled: users.accountEnabled,
      canAddRules: users.canAddRules,
      forwardAccessPauseReason: users.forwardAccessPauseReason,
      maxRules: users.maxRules,
      maxProxyInbounds: users.maxProxyInbounds,
      maxProxySubTokens: users.maxProxySubTokens,
      maxPorts: users.maxPorts,
      maxConnections: users.maxConnections,
      maxIPs: users.maxIPs,
      manualCanAddRules: users.manualCanAddRules,
      manualMaxRules: users.manualMaxRules,
      manualMaxProxyInbounds: users.manualMaxProxyInbounds,
      manualMaxProxySubTokens: users.manualMaxProxySubTokens,
      manualMaxPorts: users.manualMaxPorts,
      manualMaxConnections: users.manualMaxConnections,
      manualMaxIPs: users.manualMaxIPs,
      manualAllowForwardXTunnel: users.manualAllowForwardXTunnel,
      manualGostRateLimitIn: users.manualGostRateLimitIn,
      manualGostRateLimitOut: users.manualGostRateLimitOut,
      manualTrafficLimit: users.manualTrafficLimit,
      manualExpiresAt: users.manualExpiresAt,
      balanceCents: users.balanceCents,
      allowedForwardTypes: users.allowedForwardTypes,
      allowForwardXTunnel: users.allowForwardXTunnel,
      allowProxySubscription: users.allowProxySubscription,
      trafficLimit: users.trafficLimit,
      trafficUsed: users.trafficUsed,
      trafficBillingUsed: sql<number>`CASE
        WHEN COALESCE(${billingUsageByUser.totalBytes}, 0) > ${users.trafficBillingResetBytes}
          THEN COALESCE(${billingUsageByUser.totalBytes}, 0) - ${users.trafficBillingResetBytes}
        ELSE 0
      END`.as("trafficBillingUsed"),
      gostRateLimitIn: users.gostRateLimitIn,
      gostRateLimitOut: users.gostRateLimitOut,
      expiresAt: users.expiresAt,
      trafficAutoReset: users.trafficAutoReset,
      trafficResetDay: users.trafficResetDay,
      lastTrafficReset: users.lastTrafficReset,
      telegramId: users.telegramId,
      telegramUsername: users.telegramUsername,
      telegramFirstName: users.telegramFirstName,
      telegramLastName: users.telegramLastName,
      telegramLinkedAt: users.telegramLinkedAt,
      telegramLastSeenAt: users.telegramLastSeenAt,
      telegramAnnouncementSubscribed: users.telegramAnnouncementSubscribed,
      twoFactorEnabled: users.twoFactorEnabled,
      twoFactorEnabledAt: users.twoFactorEnabledAt,
      createdAt: users.createdAt,
      lastSignedIn: users.lastSignedIn,
    })
    .from(users)
    .leftJoin(billingUsageByUser, eq(users.id, billingUsageByUser.userId));
}

/**
 * 对账扫描要的是「有哪些非管理员用户」，只需要 id。
 *
 * 原来走 getAllUsers()：那条查询为了列表展示会 leftJoin 一份按用户聚合的计费
 * 用量，再把每个用户的每一列（密码哈希、Telegram 绑定、一整套配额）读回来 ——
 * 而调用方只是拿 id 去逐个对账。管理员在这一步本来就要跳过，所以顺手在 SQL 里
 * 滤掉，不用先全读回来再在内存里 filter。
 */
export async function getNonAdminUserIds() {
  const db = await getDb();
  if (!db) return [] as number[];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(ne(users.role, "admin"));
  return Array.from(new Set((rows as any[])
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0)));
}

export async function getAllUsers() {
  const db = await getDb();
  if (!db) return [];
  return usersForListQuery(db)
    .orderBy(desc(users.createdAt));
}

/**
 * 按 id 取一批用户的显示名。
 *
 * 只查用到的那几个，不整表读 —— 调用方手里已经有 id 了，而 getUserOptions 那种
 * 全量读是给下拉框用的，一个上千用户的部署里不该为了在列表上标几个名字读一遍。
 *
 * 返回 id → 显示名：优先 name，没有就退回 username。查不到的 id 不出现在结果里，
 * 调用方自己决定「这个人已经没了」怎么显示。
 */
export async function getUserDisplayNamesByIds(ids: readonly number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const wanted = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return result;
  const db = await getDb();
  if (!db) return result;
  const rows = await db
    .select({ id: users.id, username: users.username, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted));
  for (const row of rows as any[]) {
    const label = String(row.name || "").trim() || String(row.username || "").trim();
    if (label) result.set(Number(row.id), label);
  }
  return result;
}

/**
 * 按 id 取一批用户的角色（id → role）。
 *
 * 给公开监控页判断「机器主人是不是管理员」用：原来是每个主人一次 getUserById，
 * 而那一页不登录、每个观看者每 3 秒轮询一次。只取 role 一列，查不到的 id 不出现在结果里。
 */
export async function getUserRolesByIds(ids: readonly number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const wanted = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return result;
  const db = await getDb();
  if (!db) return result;
  const rows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(inArray(users.id, wanted));
  for (const row of rows as any[]) {
    result.set(Number(row.id), String(row.role || ""));
  }
  return result;
}

export async function getUserOptions() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      avatar: users.avatar,
      role: users.role,
      accountEnabled: users.accountEnabled,
      // 落地节点分租要用：没有订阅权限的人开给他也拿不到节点，下拉里要标出来。
      allowProxySubscription: users.allowProxySubscription,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
}


export async function getUserManagementCounts() {
  const db = await getDb();
  if (!db) return { totalUsers: 0, adminUsers: 0, activeSubscriptions: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  const [userRows, subscriptionRows] = await Promise.all([
    db.select({
      totalUsers: sql<number>`COUNT(*)`,
      adminUsers: sql<number>`COALESCE(SUM(CASE WHEN ${users.role} = 'admin' THEN 1 ELSE 0 END), 0)`,
    }).from(users),
    db.select({
      activeSubscriptions: sql<number>`COALESCE(SUM(CASE
        WHEN ${userSubscriptions.status} = 'active'
          AND (${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})
        THEN 1 ELSE 0 END), 0)`,
    }).from(userSubscriptions),
  ]);
  return {
    totalUsers: Number(userRows[0]?.totalUsers || 0),
    adminUsers: Number(userRows[0]?.adminUsers || 0),
    activeSubscriptions: Number(subscriptionRows[0]?.activeSubscriptions || 0),
  };
}

export async function getUsersPage(input: PageRequest) {
  const db = await getDb();
  if (!db) return { ...pageResult([], 0, input), adminItems: 0 };
  const [totalRows, adminRows] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)` }).from(users),
    db.select({
      count: sql<number>`COALESCE(SUM(CASE WHEN ${users.role} = 'admin' THEN 1 ELSE 0 END), 0)`,
    }).from(users),
  ]);
  const totalItems = Number(totalRows[0]?.count || 0);
  const adminItems = Number(adminRows[0]?.count || 0);
  const window = pageWindowForTotal(input, totalItems);
  const items = await usersForListQuery(db)
    .orderBy(desc(users.createdAt))
    .limit(window.pageSize)
    .offset(window.offset);
  return {
    ...pageResult(items, totalItems, window),
    adminItems,
  };
}

export async function updateUserRole(userId: number, role: "user" | "admin") {
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) return;
    const current = await getUserById(userId);
    // 角色变了就是权限边界变了：旧会话是按旧身份签发的，一律作废让对方重新登录。
    // 角色没变（重复提交同一个值）不踢人。锁顺序与禁用账号一致：先会话表、再用户行。
    if (current && current.role !== role) {
      await revokeUserAuthSessions(userId, { reason: "role_changed" });
    }
    await db.update(users).set({ role, updatedAt: nowDate() }).where(eq(users.id, userId));
  });
}

/**
 * 删账号前要先处理掉的资源：他名下的隧道、转发组、主机。
 *
 * 这些是别人的规则也可能在用的基础设施，不能跟着人一起悄悄删掉，也不能留成没有主人的
 * 行（没人能再管它们），所以要求管理员先转移或删除。
 */
export async function getUserOwnedInfrastructureCounts(userId: number) {
  const db = await getDb();
  if (!db) return { tunnels: 0, forwardGroups: 0, hosts: 0 };
  const count = (rows: any[]) => Number(rows[0]?.count || 0);
  const [tunnelRows, groupRows, hostRows] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)` }).from(tunnels).where(eq(tunnels.userId, userId)),
    db.select({ count: sql<number>`COUNT(*)` }).from(forwardGroups).where(eq(forwardGroups.userId, userId)),
    db.select({ count: sql<number>`COUNT(*)` }).from(hosts).where(eq(hosts.userId, userId)),
  ]);
  return { tunnels: count(tunnelRows), forwardGroups: count(groupRows), hosts: count(hostRows) };
}

/**
 * 删账号时要按正常删除流程收掉的规则：他自己建的顶层规则（含转发组模板）。
 * 转发组子规则跟着模板走，线路组中继跟着父规则走，这里不单独列。
 */
export async function getUserTopLevelForwardRuleIds(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: forwardRules.id }).from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
    sql`${forwardRules.routeParentRuleId} IS NULL`,
  ));
  return (rows as any[]).map((row) => Number(row.id)).filter((id) => id > 0);
}

/**
 * 删账号。
 *
 * 收凭据这一步放在这里，而不是只放在删人那条路由上：凭据是按 sharedUserId 找的，
 * 人删了就再也找不着 —— 那些凭据会永远留在各个端口上，界面上没有任何入口能收回，
 * 而它照样能连。任何一条别的删人路径（自助注销、批量清理）漏掉这一步，都会留下
 * 一个谁也管不着的活凭据，所以把它焊在这个函数里。
 *
 * 返回受影响的主机 id，调用方据此重下发配置。重复调用是安全的：释放函数本身
 * 找不到就什么也不做。
 */
export async function deleteUser(userId: number): Promise<{ hostIds: number[] }> {
  const db = await getDb();
  if (!db) return { hostIds: [] };
  const { releaseAllSharedCredentialsForUser, releaseAllDedicatedInboundsForUser } =
    await import("./proxyInboundRepository");
  const hostIds = [
    ...await releaseAllSharedCredentialsForUser(userId),
    // 专属端口是面板替他开的，人没了端口也要收 —— 留着就是一台机器上一个
    // 谁也管不着、却还在监听的端口。
    ...await releaseAllDedicatedInboundsForUser(userId),
  ];
  await db.delete(users).where(eq(users.id, userId));
  // 被他邀请来的人不再有邀请人：留着悬空的 id，哪天 id 被复用就错绑到别人头上。
  // 已经返过的返利记录保留，账要对得上。
  await db.update(users).set({ inviterId: null } as any).where(eq(users.inviterId, userId));
  return { hostIds: Array.from(new Set(hostIds.filter((id) => Number(id) > 0))) };
}

/** 更新用户流量管理设置（管理员操作） */
export async function updateUserTrafficSettings(userId: number, data: {
  trafficLimit?: number;
  gostRateLimitIn?: number;
  gostRateLimitOut?: number;
  expiresAt?: Date | null;
  trafficAutoReset?: boolean;
  trafficResetDay?: number;
  canAddRules?: boolean;
  forwardAccessPauseReason?: ForwardAccessPauseReason;
  maxRules?: number;
  maxProxyInbounds?: number;
  maxProxySubTokens?: number;
  maxPorts?: number;
  maxConnections?: number;
  maxIPs?: number;
  manualCanAddRules?: boolean;
  manualMaxRules?: number;
  manualMaxProxyInbounds?: number;
  manualMaxProxySubTokens?: number;
  manualMaxPorts?: number;
  manualMaxConnections?: number;
  manualMaxIPs?: number;
  manualAllowForwardXTunnel?: boolean;
  manualAllowProxySubscription?: boolean;
  manualGostRateLimitIn?: number;
  manualGostRateLimitOut?: number;
  manualTrafficLimit?: number;
  manualExpiresAt?: Date | null;
  allowedForwardTypes?: string | null;
  allowForwardXTunnel?: boolean;
  allowProxySubscription?: boolean;
  displayRemark?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ ...data, updatedAt: nowDate() } as any).where(eq(users.id, userId));
}

/** 账户级暂停会一次停掉这个人名下所有规则，写一行面板日志，事后能查到是哪一步停的。 */
async function logUserRuleStop(userId: number, reason: string) {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ));
  const count = Number((row as any)?.count || 0);
  if (count > 0) appendPanelLog("warn", `[RuleStop] user=${userId} stopped ${count} rule(s) reason=${reason}; they resume automatically when the account's forwarding access is restored`);
  return count;
}

/**
 * 管理员不会被系统自动暂停转发。
 *
 * 到期、超流量、流量计费余额不足这些都是「租户用资源要付费」的规则，套到管理员头上
 * 只会把整个面板的规则一起停掉：管理员余额是 0，一条走计费资源的规则一有流量，
 * 他名下所有规则就全停了，而且之后每次有流量都会再停一次。
 */
async function isAdminUser(userId: number) {
  const db = await getDb();
  if (!db) return false;
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  return String((row as any)?.role || "") === "admin";
}

/** 转发权限因这个原因暂停着的用户（自愈扫描用）。 */
export async function getUserIdsWithForwardAccessPause(reason: Exclude<ForwardAccessPauseReason, null>) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: users.id }).from(users).where(and(
    eq(users.forwardAccessPauseReason, reason),
    ne(users.role, "admin"),
  ));
  return (rows as any[]).map((row) => Number(row.id || 0)).filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * 旧版本会把管理员也自动暂停（流量计费余额为 0 时最常见），暂停标记一直留着。
 * 这里把这类自动暂停撤掉；管理员手动设置的暂停（manual）不动。返回解除了几个。
 */
export async function releaseAutomaticAdminForwardPauses() {
  const db = await getDb();
  if (!db) return 0;
  const paused = await db.select({ id: users.id, reason: users.forwardAccessPauseReason }).from(users).where(and(
    eq(users.role, "admin"),
    sql`${users.forwardAccessPauseReason} IS NOT NULL`,
    ne(users.forwardAccessPauseReason, "manual"),
  ));
  for (const row of paused as any[]) {
    await db.update(users).set({
      canAddRules: true,
      allowForwardXTunnel: true,
      allowProxySubscription: true,
      forwardAccessPauseReason: null,
      updatedAt: nowDate(),
    }).where(eq(users.id, Number(row.id)));
    appendPanelLog("info", `[RuleRecovery] released automatic pause of admin user=${row.id} reason=${row.reason}`);
  }
  return paused.length;
}

/**
 * 打开/暂停某用户的转发权限。返回这一次有没有真的改动什么（权限字段变了，或者停掉了
 * 至少一条规则）—— 调用方靠它决定要不要去推 Agent 刷新：什么都没变还推一遍，就是
 * 每小时一次白白的全量刷新（到期扫描里曾经就是这样，见 scheduler.runExpirationCheck）。
 */
export async function setUserForwardAccess(userId: number, enabled: boolean, reason?: ForwardAccessPauseReason): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [current] = await db.select({
    role: users.role,
    canAddRules: users.canAddRules,
    allowForwardXTunnel: users.allowForwardXTunnel,
    allowProxySubscription: users.allowProxySubscription,
    forwardAccessPauseReason: users.forwardAccessPauseReason,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!enabled && (reason ?? "manual") !== "manual" && String((current as any)?.role || "") === "admin") {
    appendPanelLog("warn", `[RuleStop] skipped automatic pause of admin user=${userId} reason=${reason}; admins are never paused automatically`);
    return false;
  }
  const nextPauseReason = enabled ? null : (reason ?? "manual");
  const accessChanged = !current
    || !!(current as any).canAddRules !== enabled
    || !!(current as any).allowForwardXTunnel !== enabled
    || !!(current as any).allowProxySubscription !== enabled
    || ((current as any).forwardAccessPauseReason ?? null) !== nextPauseReason;
  const now = nowDate();
  await db.update(users).set({
    canAddRules: enabled,
    allowForwardXTunnel: enabled,
    allowProxySubscription: enabled,
    forwardAccessPauseReason: nextPauseReason,
    updatedAt: now,
  }).where(eq(users.id, userId));
  if (!enabled) {
    const stoppedRules = await logUserRuleStop(userId, `access-paused:${reason ?? "manual"}`);
    await db.update(forwardRules).set({
      isEnabled: false,
      disabledByUser: true,
      updatedAt: now,
    }).where(and(
      eq(forwardRules.userId, userId),
      eq(forwardRules.isEnabled, true),
      eq(forwardRules.pendingDelete, false),
    ));
    if (accessChanged) recordUserAccessPausedEvent(userId, reason); // 事件时间线：流量用完 / 到期（只记这两种自动暂停）
    return accessChanged || stoppedRules > 0;
  }
  return accessChanged;
}

export async function setUserAccountEnabled(userId: number, enabled: boolean) {
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) return;
    const now = nowDate();
    if (!enabled) {
      // Disable is an authentication boundary as well as an access-control
      // change: revoke browser/mobile/Telegram sessions before publishing the
      // disabled state. Keep the session-table -> user-row lock order shared
      // with password/session revocation paths to reduce deadlock risk.
      await revokeUserAuthSessions(userId, { reason: "account_disabled" });
    }
    await db.update(users).set({
      accountEnabled: enabled,
      updatedAt: now,
    }).where(eq(users.id, userId));
    if (!enabled) {
      await logUserRuleStop(userId, "account-disabled");
      await db.update(forwardRules).set({
        isEnabled: false,
        disabledByUser: true,
        updatedAt: now,
      }).where(and(
        eq(forwardRules.userId, userId),
        eq(forwardRules.isEnabled, true),
        eq(forwardRules.pendingDelete, false),
      ));
    }
  });
}

/** 手动重置用户流量 */
export async function resetUserTraffic(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({
    trafficUsed: 0,
    lastTrafficReset: nowDate(),
    updatedAt: nowDate(),
  }).where(eq(users.id, userId));
}

/** Reset once for a concrete traffic-cycle boundary, including across panel instances. */
export async function resetUserTrafficForCycle(userId: number, boundary: Date, resetAt = nowDate()) {
  const boundarySec = Math.floor(boundary.getTime() / 1000);
  const resetSec = Math.floor(resetAt.getTime() / 1000);
  if (!Number.isFinite(boundarySec) || !Number.isFinite(resetSec)) return false;
  const q = quoteDbIdentifier;
  const result = await executeRaw(
    `UPDATE ${q("users")}
     SET ${q("trafficUsed")} = 0,
         ${q("lastTrafficReset")} = ?,
         ${q("lastAutoTrafficReset")} = ?,
         ${q("updatedAt")} = ?
     WHERE ${q("id")} = ?
       AND (${q("lastAutoTrafficReset")} IS NULL OR ${q("lastAutoTrafficReset")} < ?)`,
    [resetSec, resetSec, resetSec, userId, boundarySec],
  );
  return rawAffectedRows(result) > 0;
}

/**
 * Reset the package quota and the account's displayed pay-as-you-go usage.
 *
 * `traffic_billing_usage` is also the billing threshold ledger, so it must not
 * be cleared here. We snapshot its current total into a per-user baseline and
 * subtract that baseline in list queries instead.
 */
export async function resetUserTrafficAndBillingUsage(userId: number) {
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) return;
    // The billing reporter updates the same usage ledger in a separate
    // transaction. Lock the owning user row before taking the snapshot so a
    // manual reset cannot race a report from another panel instance and
    // publish a stale baseline.
    if (getDatabaseKind() !== "sqlite") {
      const q = quoteDbIdentifier;
      const locked = await queryRaw<{ id: number }>(
        `SELECT ${q("id")} AS ${q("id")} FROM ${q("users")} WHERE ${q("id")} = ? FOR UPDATE`,
        [userId],
      );
      if (!locked[0]) throw new Error("用户不存在");
    } else {
      const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
      if (!rows[0]) throw new Error("用户不存在");
    }
    const rows = await db.select({
      totalBytes: sql<number>`COALESCE(SUM(${trafficBillingUsage.totalBytes}), 0)`,
    }).from(trafficBillingUsage).where(eq(trafficBillingUsage.userId, userId));
    const totalBytes = Math.max(0, Number(rows[0]?.totalBytes || 0));
    const now = nowDate();
    await db.update(users).set({
      trafficUsed: 0,
      trafficBillingResetBytes: totalBytes,
      lastTrafficReset: now,
      updatedAt: now,
    } as any).where(eq(users.id, userId));
  });
}

/** 累加用户已用流量 */
export async function addUserTraffic(userId: number, bytes: number) {
  const db = await getDb();
  if (!db) return undefined;
  const update = db.update(users).set({
    trafficUsed: sql`${users.trafficUsed} + ${bytes}`,
    updatedAt: nowDate(),
  }).where(eq(users.id, userId));
  if (getDatabaseKind() === "mysql") {
    await update;
    return getUserById(userId);
  }
  const rows = await update.returning();
  return rows[0];
}

/** 获取所有需要月度自动重置的用户 */
export async function getUsersForAutoReset(reference = nowDate()) {
  const db = await getDb();
  if (!db) return [];
  const { year, month, day } = billingCalendarParts(reference);
  const monthStart = billingMonthStart(reference);
  const monthStartSec = Math.floor(monthStart.getTime() / 1000);
  // 重置日按当月天数截断：设成 29-31 号的用户，在没有这一天的月份（2 月、小月）里按月末重置，
  // 否则这个月整月都不会重置。本月是否已经重置过仍由 lastAutoTrafficReset 把关。
  const isLastDayOfMonth = day >= billingDaysInMonth(year, month);
  return db.select().from(users).where(and(
    eq(users.trafficAutoReset, true),
    ...(isLastDayOfMonth ? [] : [sql`${users.trafficResetDay} <= ${day}`]),
    sql`(${users.lastAutoTrafficReset} IS NULL OR ${users.lastAutoTrafficReset} < ${monthStartSec})`,
  ));
}

/** 获取所有已到期的用户 */
export async function getExpiredUsers() {
  const db = await getDb();
  if (!db) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  // 管理员不参与：setUserForwardAccess 本来就不会自动暂停管理员，他的 canAddRules 一直是
  // true，于是一个设了到期时间的管理员每小时都会被扫出来、再触发一次全量 Agent 刷新。
  return db.select().from(users).where(
    and(
      sql`${users.expiresAt} IS NOT NULL`,
      sql`${users.expiresAt} <= ${nowSec}`,
      eq(users.canAddRules, true),
      ne(users.role, "admin"),
    )
  );
}

/** 禁用某用户的所有转发规则（到期/超额时调用） */
export async function disableAllUserRules(userId: number, options: { manual?: boolean } = {}) {
  const db = await getDb();
  if (!db) return;
  if (!options.manual && await isAdminUser(userId)) {
    appendPanelLog("warn", `[RuleStop] skipped automatic stop of admin user=${userId} rules; admins are never paused automatically`);
    return;
  }
  await logUserRuleStop(userId, "entitlement-lost (plan expired, traffic used up or access removed)");
  await db.update(forwardRules).set({
    isEnabled: false,
    disabledByUser: true,
    updatedAt: nowDate(),
  }).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ));
}

/** 获取用户流量汇总信息（用于仪表盘展示） */
export async function getUserTrafficSummaries() {
  const db = await getDb();
  if (!db) return [];
  return db.select({
    id: users.id,
    username: users.username,
    name: users.name,
    email: users.email,
    displayRemark: users.displayRemark,
    avatar: users.avatar,
    role: users.role,
    accountEnabled: users.accountEnabled,
    trafficLimit: users.trafficLimit,
    trafficUsed: users.trafficUsed,
    canAddRules: users.canAddRules,
    forwardAccessPauseReason: users.forwardAccessPauseReason,
    manualCanAddRules: users.manualCanAddRules,
    manualMaxRules: users.manualMaxRules,
    manualMaxPorts: users.manualMaxPorts,
    manualMaxConnections: users.manualMaxConnections,
    manualMaxIPs: users.manualMaxIPs,
    manualAllowForwardXTunnel: users.manualAllowForwardXTunnel,
    manualGostRateLimitIn: users.manualGostRateLimitIn,
    manualGostRateLimitOut: users.manualGostRateLimitOut,
    manualTrafficLimit: users.manualTrafficLimit,
    manualExpiresAt: users.manualExpiresAt,
    gostRateLimitIn: users.gostRateLimitIn,
    gostRateLimitOut: users.gostRateLimitOut,
    allowForwardXTunnel: users.allowForwardXTunnel,
    allowProxySubscription: users.allowProxySubscription,
    expiresAt: users.expiresAt,
    trafficAutoReset: users.trafficAutoReset,
    trafficResetDay: users.trafficResetDay,
    maxConnections: users.maxConnections,
    maxIPs: users.maxIPs,
    balanceCents: users.balanceCents,
    telegramId: users.telegramId,
    telegramUsername: users.telegramUsername,
    telegramFirstName: users.telegramFirstName,
    telegramLastName: users.telegramLastName,
    // Discord 私信提醒用（server/scheduler.ts 的 runDiscordReminders）
    discordId: users.discordId,
    discordDmBlockedAt: users.discordDmBlockedAt,
  }).from(users).orderBy(desc(users.trafficUsed));
}
