import crypto from "crypto";
import { and, asc, desc, eq, gt, inArray, like, sql } from "drizzle-orm";
import { referralCommissions, subscriptionPlans, users } from "../../drizzle/schema";
import { executeRaw, getDb, queryRaw, quoteDbIdentifier, rawAffectedRows } from "../dbRuntime";
import { getSetting, setSetting } from "./settingsRepository";
import { dbBool } from "./repositoryUtils";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import {
  generateInviteCode,
  maskUsername,
  normalizeInviteCode,
  normalizeRateBps,
  normalizeReferralMode,
  type ReferralMode,
} from "../../shared/referral";

/**
 * 邀请返利：设置、邀请码、注册绑定、查询。
 *
 * 真正「给邀请人加钱」的那一步在 billingRepository 的 creditReferralCommissionInTransaction ——
 * 它要跟套餐购买在同一个事务里走、要用余额流水的内部函数，放在那边避免两个仓库互相 import。
 */

export type ReferralSettings = {
  enabled: boolean;
  mode: ReferralMode;
  /** 只在 enabled 时有意义：注册必须带有效邀请码。 */
  forceInvite: boolean;
};

export async function getReferralSettings(): Promise<ReferralSettings> {
  const [enabled, mode, forceInvite] = await Promise.all([
    getSetting("referralEnabled"),
    getSetting("referralMode"),
    getSetting("referralForceInvite"),
  ]);
  return {
    enabled: enabled === "true",
    mode: normalizeReferralMode(mode),
    forceInvite: forceInvite === "true",
  };
}

export async function setReferralSettings(input: Partial<ReferralSettings>) {
  if (input.enabled !== undefined) await setSetting("referralEnabled", input.enabled ? "true" : "false");
  if (input.mode !== undefined) await setSetting("referralMode", normalizeReferralMode(input.mode));
  if (input.forceInvite !== undefined) await setSetting("referralForceInvite", input.forceInvite ? "true" : "false");
  return getReferralSettings();
}

/** 注册页要知道的那两件事：开没开、是不是必须填邀请码。 */
export function publicReferralFlags(all: Record<string, string | null | undefined>) {
  const enabled = all.referralEnabled === "true";
  return {
    referralEnabled: enabled,
    referralForceInvite: enabled && all.referralForceInvite === "true",
  };
}

function isUniqueViolation(error: unknown) {
  const code = String((error as any)?.code || "");
  const message = String((error as any)?.message || "");
  return code === "ER_DUP_ENTRY"
    || code === "23505"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || /unique|duplicate/i.test(message);
}

/**
 * 拿到这个人的邀请码，没有就现生成一个。
 *
 * 懒生成：绝大多数用户一辈子不会打开邀请页，没必要人人先占一个码。
 * 并发打开两次时，UPDATE 带着 inviteCode IS NULL 条件，只有一次能写进去，另一次读回来那一个。
 * 撞上别人的码（唯一约束）就换一个再来；31^8 ≈ 8500 亿，重试几次足够。
 */
export async function getOrCreateInviteCode(userId: number): Promise<string> {
  const q = quoteDbIdentifier;
  const readCode = async () => {
    const rows = await queryRaw<{ inviteCode: string | null }>(
      `SELECT ${q("inviteCode")} AS ${q("inviteCode")} FROM ${q("users")} WHERE ${q("id")} = ?`,
      [userId],
    );
    if (!rows[0]) throw new Error("用户不存在");
    return normalizeInviteCode(rows[0].inviteCode);
  };
  const existing = await readCode();
  if (existing) return existing;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateInviteCode((size) => crypto.randomBytes(size));
    try {
      const result = await executeRaw(
        `UPDATE ${q("users")} SET ${q("inviteCode")} = ? WHERE ${q("id")} = ? AND ${q("inviteCode")} IS NULL`,
        [code, userId],
      );
      if (rawAffectedRows(result) > 0) return code;
      const raced = await readCode();
      if (raced) return raced;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error("邀请码生成失败，请稍后再试");
}

export async function findUserByInviteCode(code: unknown) {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return null;
  const q = quoteDbIdentifier;
  const rows = await queryRaw<{ id: number; username: string; accountEnabled: unknown }>(
    `SELECT ${q("id")} AS ${q("id")}, ${q("username")} AS ${q("username")}, ${q("accountEnabled")} AS ${q("accountEnabled")} FROM ${q("users")} WHERE ${q("inviteCode")} = ? LIMIT 1`,
    [normalized],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: Number(row.id), username: String(row.username || ""), accountEnabled: dbBool(row.accountEnabled, true) };
}

export const REFERRAL_FORCE_INVITE_ERROR = "当前仅支持邀请注册，请填写有效的邀请码";

/**
 * 注册时：这个邀请码绑给谁。
 *
 * - 码对得上、账号没停用 → 返回邀请人 id；
 * - 对不上 / 停用了 → 安静忽略（返回 null），不让注册失败 —— 链接里带了个过期的码，
 *   人还是想注册的；
 * - 但如果开了返利且开了「必须邀请注册」，对不上就直接拒绝。
 *
 * 注册的人这时还没有 id，所以「不能邀请自己」在这里天然成立；绑定时 setUserInviter 再兜一次。
 */
export async function resolveRegistrationInviter(rawCode: unknown): Promise<number | null> {
  const settings = await getReferralSettings();
  const mustInvite = settings.enabled && settings.forceInvite;
  const inviter = await findUserByInviteCode(rawCode);
  if (inviter && inviter.accountEnabled) return inviter.id;
  if (mustInvite) throw new Error(REFERRAL_FORCE_INVITE_ERROR);
  return null;
}

/**
 * 写邀请人。注册路径（只在 inviterId 为空时写，写一次就定了）和管理员路径共用。
 *
 * 管理员可以改、可以清，但不能：
 * - 邀请人是自己；
 * - 形成环：A 邀请 B 时，B 不能出现在 A 的邀请链上（直接互邀、或者绕一圈）。
 *   环本身不会让钱多返，但会让「谁邀请了谁」失去意义，余额加锁的顺序也会打结。
 */
export async function setUserInviter(userId: number, inviterId: number | null, options: { onlyIfUnset?: boolean } = {}) {
  const q = quoteDbIdentifier;
  if (inviterId !== null) {
    if (!Number.isSafeInteger(inviterId) || inviterId <= 0) throw new Error("邀请人无效");
    if (inviterId === userId) throw new Error("不能把自己设为邀请人");
    const inviterRows = await queryRaw<{ id: number }>(`SELECT ${q("id")} AS ${q("id")} FROM ${q("users")} WHERE ${q("id")} = ?`, [inviterId]);
    if (!inviterRows[0]) throw new Error("邀请人不存在");
    // 沿着邀请人往上走，碰到自己就是环。层数给个上限，脏数据里真有环也不会死循环。
    let cursor: number | null = inviterId;
    for (let depth = 0; cursor && depth < 64; depth += 1) {
      const rows: Array<{ inviterId: number | null }> = await queryRaw<{ inviterId: number | null }>(
        `SELECT ${q("inviterId")} AS ${q("inviterId")} FROM ${q("users")} WHERE ${q("id")} = ?`,
        [cursor],
      );
      const next: number = Number(rows[0]?.inviterId || 0);
      if (next === userId) throw new Error("不能形成循环邀请：对方已经在该用户的邀请链下面");
      cursor = next > 0 ? next : null;
    }
  }
  const guard = options.onlyIfUnset ? ` AND ${q("inviterId")} IS NULL` : "";
  // 绑定时刻跟着邀请人一起写：这之前下的单不返利（管理员后补邀请人，不能把之前的单也算进去）。
  // 邀请人没变就不动时刻，免得管理员重复保存一次就把之前的单「挪」到绑定之前。
  const boundAt = inviterId === null ? null : Math.floor(Date.now() / 1000);
  const result = await executeRaw(
    `UPDATE ${q("users")} SET ${q("inviterBoundAt")} = CASE WHEN ${q("inviterId")} = ? THEN ${q("inviterBoundAt")} ELSE ? END, ${q("inviterId")} = ? WHERE ${q("id")} = ?${guard}`,
    [inviterId, boundAt, inviterId, userId],
  );
  return rawAffectedRows(result) > 0;
}


export async function getReferralStats(inviterId: number) {
  const db = await getDb();
  if (!db) return { invitedCount: 0, totalCommissionCents: 0, commissionCount: 0 };
  const [invited] = await db.select({ count: sql<number>`COUNT(*)` }).from(users).where(eq(users.inviterId, inviterId));
  const [earned] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${referralCommissions.commissionCents}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(referralCommissions)
    .where(eq(referralCommissions.inviterId, inviterId));
  return {
    invitedCount: Number(invited?.count || 0),
    totalCommissionCents: Number(earned?.total || 0),
    commissionCount: Number(earned?.count || 0),
  };
}

function commissionRow(row: any, options: { maskInvitee: boolean }) {
  return {
    id: Number(row.id),
    inviterId: Number(row.inviterId),
    inviterUsername: row.inviterUsername ?? null,
    inviteeId: Number(row.inviteeId),
    inviteeUsername: options.maskInvitee ? maskUsername(row.inviteeUsername) : (row.inviteeUsername ?? null),
    sourceType: String(row.sourceType || ""),
    sourceRef: options.maskInvitee ? null : String(row.sourceRef || ""),
    planId: row.planId === null || row.planId === undefined ? null : Number(row.planId),
    planName: row.planName || (row.planId ? `套餐 #${row.planId}` : "-"),
    baseAmountCents: Number(row.baseAmountCents || 0),
    rateBps: normalizeRateBps(row.rateBps),
    commissionCents: Number(row.commissionCents || 0),
    mode: normalizeReferralMode(row.mode),
    createdAt: row.createdAt,
  };
}

/** 邀请人自己看的返利明细：被邀请人打码，订单号不给。 */
export async function listMyReferralCommissionsPage(inviterId: number, input: PageRequest) {
  const db = await getDb();
  if (!db) return pageResult([], 0, input, 20);
  const [totals] = await db.select({ count: sql<number>`COUNT(*)` }).from(referralCommissions).where(eq(referralCommissions.inviterId, inviterId));
  const totalItems = Number(totals?.count || 0);
  const window = pageWindowForTotal(input, totalItems, 20);
  const rows = await db
    .select({
      id: referralCommissions.id,
      inviterId: referralCommissions.inviterId,
      inviteeId: referralCommissions.inviteeId,
      inviteeUsername: users.username,
      sourceType: referralCommissions.sourceType,
      sourceRef: referralCommissions.sourceRef,
      planId: referralCommissions.planId,
      planName: referralCommissions.planName,
      baseAmountCents: referralCommissions.baseAmountCents,
      rateBps: referralCommissions.rateBps,
      commissionCents: referralCommissions.commissionCents,
      mode: referralCommissions.mode,
      createdAt: referralCommissions.createdAt,
    })
    .from(referralCommissions)
    .leftJoin(users, eq(users.id, referralCommissions.inviteeId))
    .where(eq(referralCommissions.inviterId, inviterId))
    .orderBy(desc(referralCommissions.createdAt), desc(referralCommissions.id))
    .limit(window.pageSize)
    .offset(window.offset);
  return pageResult((rows as any[]).map((row) => commissionRow(row, { maskInvitee: true })), totalItems, window, 20);
}

/** 管理员看的全部返利记录，可按邀请人用户名筛。 */
export async function listReferralCommissionsAdminPage(input: PageRequest & { inviterUsername?: string | null }) {
  const db = await getDb();
  if (!db) return { ...pageResult([], 0, input, 20), totalCommissionCents: 0 };
  const inviterKeyword = String(input.inviterUsername || "").trim();
  // 先按用户名找出邀请人 id，再查记录：返利表里没有用户名列。
  let inviterIds: number[] | null = null;
  if (inviterKeyword) {
    const matches = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.username, `%${inviterKeyword}%`))
      .orderBy(asc(users.id))
      .limit(200);
    inviterIds = (matches as any[]).map((row) => Number(row.id)).filter((id) => id > 0);
    if (inviterIds.length === 0) return { ...pageResult([], 0, input, 20), totalCommissionCents: 0 };
  }
  const where = inviterIds ? inArray(referralCommissions.inviterId, inviterIds) : undefined;
  const totalsQuery = db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${referralCommissions.commissionCents}), 0)`,
    })
    .from(referralCommissions);
  const [totals] = where ? await totalsQuery.where(where) : await totalsQuery;
  const totalItems = Number(totals?.count || 0);
  const window = pageWindowForTotal(input, totalItems, 20);
  const base = db.select().from(referralCommissions);
  const rows = await (where ? base.where(where) : base)
    .orderBy(desc(referralCommissions.createdAt), desc(referralCommissions.id))
    .limit(window.pageSize)
    .offset(window.offset) as any[];
  // 这一页涉及的人一次查完用户名。
  const userIds = Array.from(new Set(rows.flatMap((row) => [Number(row.inviterId), Number(row.inviteeId)]).filter((id) => id > 0)));
  const names = new Map<number, string>();
  if (userIds.length > 0) {
    const nameRows = await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds));
    for (const row of nameRows as any[]) names.set(Number(row.id), String(row.username || ""));
  }
  return {
    ...pageResult(rows.map((row) => commissionRow({
      ...row,
      inviterUsername: names.get(Number(row.inviterId)) ?? null,
      inviteeUsername: names.get(Number(row.inviteeId)) ?? null,
    }, { maskInvitee: false })), totalItems, window, 20),
    totalCommissionCents: Number(totals?.total || 0),
  };
}

/** 商店里能看到、且返利比例大于 0 的套餐 —— 让邀请人知道推哪个能拿多少。 */
export async function listReferralPlans() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: subscriptionPlans.id,
      name: subscriptionPlans.name,
      priceCents: subscriptionPlans.priceCents,
      currency: subscriptionPlans.currency,
      durationDays: subscriptionPlans.durationDays,
      referralRateBps: subscriptionPlans.referralRateBps,
    })
    .from(subscriptionPlans)
    .where(and(
      eq(subscriptionPlans.isActive, true),
      eq(subscriptionPlans.isStoreVisible, true),
      gt(subscriptionPlans.referralRateBps, 0),
    ))
    .orderBy(asc(subscriptionPlans.sortOrder), desc(subscriptionPlans.createdAt));
  return (rows as any[]).map((row) => ({
    id: Number(row.id),
    name: String(row.name || ""),
    priceCents: Number(row.priceCents || 0),
    currency: String(row.currency || "CNY"),
    durationDays: Number(row.durationDays || 0),
    referralRateBps: normalizeRateBps(row.referralRateBps),
  }));
}

/** 用户管理详情里那一块：谁邀请了他、他邀请了几个人。 */
export async function getAdminUserReferralInfo(userId: number) {
  const q = quoteDbIdentifier;
  const rows = await queryRaw<{ inviterId: number | null; inviteCode: string | null }>(
    `SELECT ${q("inviterId")} AS ${q("inviterId")}, ${q("inviteCode")} AS ${q("inviteCode")} FROM ${q("users")} WHERE ${q("id")} = ?`,
    [userId],
  );
  if (!rows[0]) throw new Error("用户不存在");
  const inviterId = Number(rows[0].inviterId || 0) || null;
  let inviter: { id: number; username: string; name: string | null } | null = null;
  if (inviterId) {
    const inviterRows = await queryRaw<{ id: number; username: string; name: string | null }>(
      `SELECT ${q("id")} AS ${q("id")}, ${q("username")} AS ${q("username")}, ${q("name")} AS ${q("name")} FROM ${q("users")} WHERE ${q("id")} = ?`,
      [inviterId],
    );
    inviter = inviterRows[0]
      ? { id: Number(inviterRows[0].id), username: String(inviterRows[0].username || ""), name: inviterRows[0].name ?? null }
      : null;
  }
  const stats = await getReferralStats(userId);
  return {
    inviterId,
    inviter,
    inviteCode: normalizeInviteCode(rows[0].inviteCode),
    ...stats,
  };
}

/** 管理员按用户名指定邀请人。 */
export async function findUserIdByUsername(username: string) {
  const q = quoteDbIdentifier;
  const rows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")} AS ${q("id")} FROM ${q("users")} WHERE ${q("username")} = ? LIMIT 1`,
    [username.trim()],
  );
  return rows[0] ? Number(rows[0].id) : null;
}
