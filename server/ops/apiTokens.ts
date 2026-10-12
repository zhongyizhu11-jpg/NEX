/*
  个人 API 令牌（#9）：给脚本、自动化和 MCP 客户端（Claude Code 等）用的长期凭据。

  形状是 `nex_` + 40 位 base62 随机字符（约 238 位熵），库里只存 sha256。请求带
  `Authorization: Bearer nex_…` 时，createContext 走这里把令牌换成它的主人，之后的
  权限检查和网页上本人登录完全一样 —— 只多两条限制（见 apiTokenPolicyError）：

  · read 令牌只能跑 tRPC 查询，任何 mutation 都被拒；
  · 不管哪种令牌，都碰不到「账号本身」：令牌、密码、2FA、通行密钥、登录设备。
    令牌一旦泄露，最坏也只是「能以你的身份操作面板」，而不能把你锁在门外或给自己续命。

  令牌请求不写 cookie（见 neutralizeCookies）：脚本拿着令牌调接口，不该顺手在响应里
  种下一个浏览器会话。
*/
import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";
import { normalizeApiTokenScope, type ApiTokenContext, type ApiTokenScope } from "./apiTokenPolicy";

export * from "./apiTokenPolicy";

export const API_TOKEN_PREFIX = "nex_";
export const API_TOKEN_RANDOM_LENGTH = 40;
/** 列表里给人看的那一截：令牌开头 8 个字符。 */
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = 8;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TOKEN_PATTERN = new RegExp(`^${API_TOKEN_PREFIX}[0-9A-Za-z]{${API_TOKEN_RANDOM_LENGTH}}$`);
/** lastUsedAt 最多一分钟写一次：脚本一秒十个请求，不能每个都去改一行。 */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** 生成一枚新令牌。拒绝采样，保证 62 个字符等概率（直接 % 62 会偏向前面几个）。 */
export function generateApiToken(): { token: string; prefix: string; hash: string } {
  let random = "";
  while (random.length < API_TOKEN_RANDOM_LENGTH) {
    for (const byte of crypto.randomBytes(64)) {
      if (byte >= 248) continue; // 248 = 62 * 4
      random += BASE62[byte % 62];
      if (random.length >= API_TOKEN_RANDOM_LENGTH) break;
    }
  }
  const token = `${API_TOKEN_PREFIX}${random}`;
  return { token, prefix: token.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH), hash: hashApiToken(token) };
}

export function hashApiToken(token: string) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function isApiTokenFormat(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** 从 Authorization 头里取出 nex_ 令牌；不是这种令牌（比如 App 的会话 JWT）返回 null。 */
export function readApiTokenFromHeader(header: unknown): string | null {
  const text = String(Array.isArray(header) ? header[0] : header || "");
  if (!text.startsWith("Bearer ")) return null;
  const token = text.slice(7).trim();
  return token.startsWith(API_TOKEN_PREFIX) ? token : null;
}

type TokenRow = {
  id: number;
  userId: number;
  name: string;
  scope: ApiTokenScope;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

function rowToToken(row: Record<string, any>): TokenRow {
  return {
    id: Number(row.id),
    userId: Number(row.userId),
    name: String(row.name || ""),
    scope: normalizeApiTokenScope(row.scope),
    expiresAt: rawEpochToDate(row.expiresAt),
    revokedAt: rawEpochToDate(row.revokedAt),
    lastUsedAt: rawEpochToDate(row.lastUsedAt),
  };
}

const lastUsedWrites = new Map<number, number>();

async function touchApiToken(id: number, ip: string, loadedLastUsedAt: Date | null) {
  const now = Date.now();
  const lastWrite = Math.max(lastUsedWrites.get(id) || 0, loadedLastUsedAt?.getTime() || 0);
  if (now - lastWrite < LAST_USED_WRITE_INTERVAL_MS) return;
  lastUsedWrites.set(id, now);
  if (lastUsedWrites.size > 10_000) lastUsedWrites.clear();
  const q = quoteDbIdentifier;
  await executeRaw(
    `UPDATE ${q("api_tokens")} SET ${q("lastUsedAt")} = ?, ${q("lastUsedIp")} = ? WHERE ${q("id")} = ?`,
    [Math.floor(now / 1000), ip.slice(0, 64), id],
  );
}

export type ResolvedApiToken = { user: User; apiToken: ApiTokenContext };

/** 令牌 → 主人。无效、过期、撤销、账户停用都返回 null（调用方当作未登录）。 */
export async function resolveApiToken(token: string, ip: string): Promise<ResolvedApiToken | null> {
  if (!isApiTokenFormat(token)) return null;
  const q = quoteDbIdentifier;
  const rows = await queryRaw(`SELECT * FROM ${q("api_tokens")} WHERE ${q("tokenHash")} = ? LIMIT 1`, [hashApiToken(token)]);
  const row = rows[0];
  if (!row) return null;
  const record = rowToToken(row);
  if (record.revokedAt) return null;
  if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) return null;
  const user = await db.getUserById(record.userId);
  if (!user || (user as any).accountEnabled === false) return null;
  await touchApiToken(record.id, ip, record.lastUsedAt).catch((error) => {
    console.warn(`[ApiTokens] touch failed id=${record.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { user, apiToken: { id: record.id, scope: record.scope, name: record.name } };
}

/** 令牌请求的响应不写也不清 cookie。 */
export function neutralizeCookies(res: Response) {
  const anyRes = res as any;
  anyRes.cookie = () => res;
  anyRes.clearCookie = () => res;
}

export function requestIp(req: Request) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

/**
 * createContext 的钩子：请求带 nex_ 令牌时返回解析结果（user 可能为 null = 令牌无效），
 * 不带返回 undefined，调用方照原来的 cookie / App 会话流程走。
 */
export async function resolveApiTokenRequest(req: Request, res: Response): Promise<{ user: User | null; apiToken: ApiTokenContext | null } | undefined> {
  const token = readApiTokenFromHeader(req.headers.authorization);
  if (!token) return undefined;
  neutralizeCookies(res);
  const resolved = await resolveApiToken(token, requestIp(req)).catch((error) => {
    console.warn(`[ApiTokens] resolve failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  return resolved ? { user: resolved.user, apiToken: resolved.apiToken } : { user: null, apiToken: null };
}

// ---------- 管理（只给 trpc.ops.apiTokens 用） ----------

export type ApiTokenListItem = {
  id: number;
  name: string;
  prefix: string;
  scope: ApiTokenScope;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  expiresAt: Date | null;
  createdAt: Date | null;
  expired: boolean;
};

export async function listUserApiTokens(userId: number): Promise<ApiTokenListItem[]> {
  const q = quoteDbIdentifier;
  const rows = await queryRaw(
    `SELECT * FROM ${q("api_tokens")} WHERE ${q("userId")} = ? AND ${q("revokedAt")} IS NULL ORDER BY ${q("id")} DESC`,
    [userId],
  );
  const now = Date.now();
  return rows.map((row) => {
    const expiresAt = rawEpochToDate(row.expiresAt);
    return {
      id: Number(row.id),
      name: String(row.name || ""),
      prefix: String(row.prefix || ""),
      scope: normalizeApiTokenScope(row.scope),
      lastUsedAt: rawEpochToDate(row.lastUsedAt),
      lastUsedIp: row.lastUsedIp ? String(row.lastUsedIp) : null,
      expiresAt,
      createdAt: rawEpochToDate(row.createdAt),
      expired: !!expiresAt && expiresAt.getTime() <= now,
    };
  });
}

export const MAX_API_TOKENS_PER_USER = 50;

export async function createUserApiToken(input: { userId: number; name: string; scope: ApiTokenScope; expiresInDays?: number | null }) {
  const q = quoteDbIdentifier;
  const countRows = await queryRaw<{ n: number }>(
    `SELECT COUNT(*) AS ${q("n")} FROM ${q("api_tokens")} WHERE ${q("userId")} = ? AND ${q("revokedAt")} IS NULL`,
    [input.userId],
  );
  if (Number(countRows[0]?.n || 0) >= MAX_API_TOKENS_PER_USER) {
    throw new Error(`令牌最多 ${MAX_API_TOKENS_PER_USER} 个，请先撤销不用的`);
  }
  const generated = generateApiToken();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = input.expiresInDays && input.expiresInDays > 0 ? nowSeconds + Math.floor(input.expiresInDays) * 86400 : null;
  const id = await insertAndGetId("api_tokens", {
    userId: input.userId,
    name: input.name,
    prefix: generated.prefix,
    tokenHash: generated.hash,
    scope: input.scope,
    expiresAt,
    createdAt: nowSeconds,
  });
  return { id, token: generated.token, prefix: generated.prefix, expiresAt: expiresAt ? new Date(expiresAt * 1000) : null };
}

export async function revokeUserApiToken(userId: number, id: number) {
  const q = quoteDbIdentifier;
  const result: any = await executeRaw(
    `UPDATE ${q("api_tokens")} SET ${q("revokedAt")} = ? WHERE ${q("id")} = ? AND ${q("userId")} = ? AND ${q("revokedAt")} IS NULL`,
    [Math.floor(Date.now() / 1000), id, userId],
  );
  return Number(result?.affectedRows ?? result?.changes ?? result?.rowCount ?? 0) > 0;
}
