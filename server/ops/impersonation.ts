/*
  管理员「进入用户后台」（上游 v2.3.299 的「用户管理支持在新窗口进入普通用户后台，不影响原有登录」）。

  做法：给新标签页签一枚只属于这次代入的令牌（`nxu_` + 32 字节随机数），库里只存 sha256
  （user_impersonations，见 impersonationTables.ts）。新标签页的每个接口请求带
  `Authorization: Bearer nxu_…`、不带 cookie；createContext 认出这个前缀就走这里，把请求换成
  「目标用户 + 代入标记」。管理员的登录 cookie 从头到尾没被碰过，原来的标签页照常是管理员。

  为什么不直接给目标用户建一个登录会话、把 cookie 换掉：
  · cookie 是整个浏览器共用的，一换，管理员所有标签页都变成了那个用户；
  · 那样建出来的会话和用户本人的登录分不开 —— 单设备登录模式下还会把用户自己顶下线，
    「已登录设备」里多一台他不认识的设备，新设备提醒也会发到他邮箱里。

  每个请求都重新确认一遍（不缓存）：
  · 这一行没结束、没到期；
  · 管理员还在、没停用、还是管理员；签发时他所在的那个登录会话还活着
    （退出登录、改密码、被别的设备顶掉 → 代入一起失效）；
  · 目标还在、没停用、还是普通用户（代入期间被提成管理员也立刻失效，代入永远拿不到管理员权限）。

  代入会话能做什么见 impersonationPolicy.ts；谁在什么时候进了谁的后台记在操作审计和事件时间线里。
*/
import crypto from "node:crypto";
import type { User } from "../../drizzle/schema";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawAffectedRows, rawEpochToDate } from "../dbRuntime";
import { getUserById } from "../repositories/userRepository";
import { getActiveAuthSession } from "../repositories/sessionRepository";
import { deleteExpiredHistoryRows } from "../repositories/historyRetention";
import { getSessionKindField, isSessionLeaseOwnedByAnother, normalizeSessionKind, parseSessionLease, type SessionKind } from "../session";
import { IMPERSONATION_TOKEN_PREFIX, IMPERSONATION_TTL_SECONDS } from "../../shared/userImpersonation";
import type { ImpersonationContext } from "./impersonationPolicy";

export * from "./impersonationPolicy";

/** 本机开发面板（FORWARDX_DEV_PANEL）里管理员没有真的登录会话，sid 固定是这个。 */
export const DEV_PANEL_SESSION_SID = "dev-panel";

const TOKEN_PATTERN = new RegExp(`^${IMPERSONATION_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

export function generateImpersonationToken(): { token: string; hash: string } {
  const token = `${IMPERSONATION_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  return { token, hash: hashImpersonationToken(token) };
}

export function hashImpersonationToken(token: string) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

/**
 * 从 Authorization 头里取出代入令牌；不是这种令牌（API 令牌、App 的会话 JWT）返回 null。
 * 只看前缀：前缀对了但格式不对的也要交给 resolveImpersonation 判成「无效」，
 * 不能当成「没带令牌」落回 cookie —— 那样坏掉的代入窗口会悄悄变回管理员。
 */
export function readImpersonationTokenFromHeader(header: unknown): string | null {
  const text = String(Array.isArray(header) ? header[0] : header || "");
  if (!text.startsWith("Bearer ")) return null;
  const token = text.slice(7).trim();
  return token.startsWith(IMPERSONATION_TOKEN_PREFIX) ? token : null;
}

export class ImpersonationStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImpersonationStartError";
  }
}

type AccountLike = { id: number; role?: string | null; accountEnabled?: unknown } | null | undefined;

function isEnabledAdmin(user: AccountLike) {
  return !!user && user.role === "admin" && user.accountEnabled !== false;
}

/** 只能进「启用着的普通用户」：管理员账号（包括自己）一律不行。 */
function isImpersonableTarget(user: AccountLike) {
  return !!user && user.role === "user" && user.accountEnabled !== false;
}

function displayName(user: { username?: string | null; name?: string | null } | null | undefined) {
  return String(user?.username || user?.name || "").trim();
}

export type StartImpersonationInput = {
  admin: User;
  /** 管理员发起时所在的登录会话。API 令牌、机器人这些没有会话的入口发起不了。 */
  parent: { sid: string | null | undefined; kind: SessionKind | string };
  targetUserId: number;
  ip?: string | null;
  userAgent?: string | null;
  now?: number;
};

export type StartedImpersonation = {
  id: number;
  token: string;
  /** 到期时刻（毫秒时间戳） */
  expiresAt: number;
  target: User;
};

export async function startImpersonation(input: StartImpersonationInput): Promise<StartedImpersonation> {
  const now = input.now ?? Date.now();
  const parentSid = String(input.parent.sid || "").trim();
  if (!isEnabledAdmin(input.admin) || !parentSid) {
    throw new ImpersonationStartError("只有在网页上登录的管理员可以进入用户后台");
  }
  const target = await getUserById(input.targetUserId);
  if (!target || target.id === input.admin.id || !isImpersonableTarget(target)) {
    throw new ImpersonationStartError("只能进入已启用的普通用户的后台");
  }
  const { token, hash } = generateImpersonationToken();
  const expiresAtSeconds = Math.floor(now / 1000) + IMPERSONATION_TTL_SECONDS;
  const id = await insertAndGetId("user_impersonations", {
    tokenHash: hash,
    adminUserId: input.admin.id,
    targetUserId: target.id,
    parentSid: parentSid.slice(0, 128),
    parentKind: normalizeSessionKind(input.parent.kind, "browser"),
    ip: String(input.ip || "").slice(0, 64) || null,
    userAgent: String(input.userAgent || "").slice(0, 256) || null,
    createdAt: Math.floor(now / 1000),
    expiresAt: expiresAtSeconds,
  });
  return { id, token, expiresAt: expiresAtSeconds * 1000, target };
}

export type ResolveImpersonationOptions = {
  /** 「允许多设备同时登录」开没开。没开时，管理员那次登录被别的设备顶掉，代入也跟着失效。 */
  allowMultiDevice: () => Promise<boolean>;
  /** 本机开发面板：管理员没有真的会话行，跳过「签发时的登录还在不在」这一条。 */
  devPanel?: boolean;
  now?: number;
};

export type ResolvedImpersonation = { user: User; impersonation: ImpersonationContext };

/**
 * 令牌 → 目标用户 + 代入标记。任何一条对不上都返回 null（调用方回「代入已结束」）。
 * 数据库出错原样抛出去：库挂了不等于令牌无效，由 createContext 判成 503。
 */
export async function resolveImpersonation(token: string, options: ResolveImpersonationOptions): Promise<ResolvedImpersonation | null> {
  if (!TOKEN_PATTERN.test(String(token || ""))) return null;
  const now = options.now ?? Date.now();
  const q = quoteDbIdentifier;
  const rows = await queryRaw(`SELECT * FROM ${q("user_impersonations")} WHERE ${q("tokenHash")} = ? LIMIT 1`, [hashImpersonationToken(token)]);
  const row = rows[0];
  if (!row || rawEpochToDate(row.endedAt)) return null;
  const expiresAt = rawEpochToDate(row.expiresAt)?.getTime() || 0;
  if (expiresAt <= now) return null;

  const id = Number(row.id);
  const adminUserId = Number(row.adminUserId);
  const parentSid = String(row.parentSid || "");
  const parentKind = normalizeSessionKind(row.parentKind, "browser");
  const [admin, target] = await Promise.all([getUserById(adminUserId), getUserById(Number(row.targetUserId))]);
  if (!isEnabledAdmin(admin) || !admin) return endAndReject(id, "admin_invalid");
  if (!isImpersonableTarget(target) || !target || target.id === admin.id) return endAndReject(id, "target_invalid");

  if (!(options.devPanel && parentSid === DEV_PANEL_SESSION_SID)) {
    const parentSession = await getActiveAuthSession(admin.id, parentSid, parentKind);
    if (!parentSession) return endAndReject(id, "admin_session_ended");
    const lease = parseSessionLease(String((admin as Record<string, unknown>)[getSessionKindField(parentKind)] || ""));
    if (isSessionLeaseOwnedByAnother(lease, parentSid) && !(await options.allowMultiDevice())) {
      return endAndReject(id, "admin_session_replaced");
    }
  }

  return {
    user: target,
    impersonation: { id, adminUserId: admin.id, adminName: displayName(admin) || `#${admin.id}`, expiresAt },
  };
}

async function endAndReject(id: number, reason: string): Promise<null> {
  // 顺手把这一行标成结束：之后同一枚令牌再来不用重查一遍，审计时也看得出是怎么没的。写不进去不影响拒绝。
  await endImpersonation(id, reason).catch(() => undefined);
  return null;
}

/** 结束一次代入（退出、或上面任何一条校验没过）。已经结束的不改。返回这次有没有真的结束它。 */
export async function endImpersonation(id: number, reason: string, now = Date.now()): Promise<boolean> {
  const q = quoteDbIdentifier;
  const result = await executeRaw(
    `UPDATE ${q("user_impersonations")} SET ${q("endedAt")} = ?, ${q("endReason")} = ? WHERE ${q("id")} = ? AND ${q("endedAt")} IS NULL`,
    [Math.floor(now / 1000), String(reason || "ended").slice(0, 32), id],
  );
  return rawAffectedRows(result) > 0;
}

/** 到期超过 retainDays 天的代入记录每天清一次（调度器的历史清理里跑）。谁进过谁的后台另有操作审计留着。 */
export async function pruneImpersonations(retainDays = 30) {
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, retainDays) * 86400;
  return deleteExpiredHistoryRows("user_impersonations", "expiresAt", cutoff);
}
