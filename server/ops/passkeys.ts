/*
  通行密钥（#12）的存取和「这次请求的 RP 是谁」。WebAuthn 本身的校验在 webauthn.ts。

  RP ID 用浏览器所在的域名：从请求的 Origin 头取，但这个域名必须是面板自己的 ——
  等于请求的 Host（或反代给的 X-Forwarded-Host），或者等于设置里的「面板公开地址」。
  这样同一个面板用两个域名访问时，各自注册的通行密钥各自能用；别的网站伪造 Origin
  也拿不到一个能通过的挑战（浏览器本来就不允许跨域名用通行密钥，这里是再收一道）。

  挑战只放内存，5 分钟有效、用一次就删；面板重启就作废 —— 用户重新点一下按钮即可。
*/
import crypto from "node:crypto";
import { ENV } from "../env";
import { pruneMapEntries, setBoundedMapValue } from "../boundedCache";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";
import { createChallenge, WebAuthnError } from "./webauthn";

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 10_000;
export const MAX_PASSKEYS_PER_USER = 20;
export const MAX_CREDENTIAL_ID_LENGTH = 512;

// ---------- RP ----------

export type RelyingParty = { origin: string; rpId: string };

function isLocalHostname(hostname: string) {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function hostOf(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(text.includes("://") ? text : `http://${text}`).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 从请求推出 RP。纯函数。
 * origin：浏览器的 Origin 头；hosts：请求的 Host / X-Forwarded-Host；panelPublicUrl：设置里的公开地址。
 */
export function resolveRelyingParty(origin: string | null | undefined, hosts: Array<string | null | undefined>, panelPublicUrl?: string | null): RelyingParty {
  let url: URL;
  try {
    url = new URL(String(origin || ""));
  } catch {
    throw new WebAuthnError("无法确定面板地址，请刷新页面后重试");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHostname(url.hostname))) {
    throw new WebAuthnError("通行密钥需要 HTTPS 访问面板");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith("[")) {
    throw new WebAuthnError("通行密钥需要用域名访问面板，不能用 IP 地址");
  }
  const originHost = url.host.toLowerCase();
  const allowed = new Set<string>();
  for (const host of hosts) {
    for (const part of String(host || "").split(",")) {
      const normalized = hostOf(part.trim());
      if (normalized) allowed.add(normalized);
    }
  }
  const panelHost = hostOf(panelPublicUrl);
  if (panelHost) allowed.add(panelHost);
  if (!allowed.has(originHost)) throw new WebAuthnError("请求来源不是这个面板的地址");
  return { origin: url.origin, rpId: url.hostname.toLowerCase() };
}

// ---------- 挑战 ----------

type PendingChallenge = {
  purpose: "register" | "login";
  challenge: string;
  userId: number | null;
  origin: string;
  rpId: string;
  expiresAt: number;
};

const challenges = new Map<string, PendingChallenge>();

export function issuePasskeyChallenge(input: Omit<PendingChallenge, "challenge" | "expiresAt">) {
  const now = Date.now();
  pruneMapEntries(challenges, (entry) => entry.expiresAt <= now);
  const challengeId = crypto.randomBytes(18).toString("base64url");
  const challenge = createChallenge();
  setBoundedMapValue(challenges, challengeId, { ...input, challenge, expiresAt: now + PASSKEY_CHALLENGE_TTL_MS }, MAX_CHALLENGES);
  return { challengeId, challenge };
}

/** 取出并作废一个挑战（不管后面校验成不成功，挑战都只能用一次）。 */
export function consumePasskeyChallenge(challengeId: string, purpose: PendingChallenge["purpose"]) {
  const entry = challenges.get(challengeId);
  if (entry) challenges.delete(challengeId);
  if (!entry || entry.purpose !== purpose || entry.expiresAt <= Date.now()) {
    throw new WebAuthnError("通行密钥请求已过期，请重试");
  }
  return entry;
}

/** WebAuthn 的 user.id：不放用户名或数字 ID，用面板密钥派生的 16 字节，换不回是谁。 */
export function passkeyUserHandle(userId: number) {
  return crypto.createHash("sha256").update(`${ENV.cookieSecret || "nex"}:passkey-user:${userId}`).digest().subarray(0, 16).toString("base64url");
}

// ---------- 存取 ----------

export type PasskeyRow = {
  id: number;
  userId: number;
  name: string;
  credentialId: string;
  publicKey: string;
  alg: number;
  signCount: number;
  transports: string[];
  createdAt: Date | null;
  lastUsedAt: Date | null;
};

function rowToPasskey(row: Record<string, any>): PasskeyRow {
  return {
    id: Number(row.id),
    userId: Number(row.userId),
    name: String(row.name || ""),
    credentialId: String(row.credentialId || ""),
    publicKey: String(row.publicKey || ""),
    alg: Number(row.alg),
    signCount: Number(row.signCount || 0),
    transports: String(row.transports || "").split(",").map((item) => item.trim()).filter(Boolean),
    createdAt: rawEpochToDate(row.createdAt),
    lastUsedAt: rawEpochToDate(row.lastUsedAt),
  };
}

const q = (id: string) => quoteDbIdentifier(id);

export async function listUserPasskeys(userId: number) {
  const rows = await queryRaw(`SELECT * FROM ${q("user_passkeys")} WHERE ${q("userId")} = ? ORDER BY ${q("id")} ASC`, [userId]);
  return rows.map(rowToPasskey);
}

export async function findPasskeyByCredentialId(credentialId: string) {
  const rows = await queryRaw(`SELECT * FROM ${q("user_passkeys")} WHERE ${q("credentialId")} = ? LIMIT 1`, [credentialId]);
  return rows[0] ? rowToPasskey(rows[0]) : null;
}

export async function insertPasskey(input: { userId: number; name: string; credentialId: string; publicKey: string; alg: number; signCount: number; transports: string[] }) {
  return insertAndGetId("user_passkeys", {
    userId: input.userId,
    name: input.name,
    credentialId: input.credentialId,
    publicKey: input.publicKey,
    alg: input.alg,
    signCount: input.signCount,
    transports: input.transports.join(",").slice(0, 128) || null,
    createdAt: Math.floor(Date.now() / 1000),
  });
}

export async function renamePasskey(userId: number, id: number, name: string) {
  const result: any = await executeRaw(`UPDATE ${q("user_passkeys")} SET ${q("name")} = ? WHERE ${q("id")} = ? AND ${q("userId")} = ?`, [name, id, userId]);
  return Number(result?.affectedRows ?? result?.changes ?? result?.rowCount ?? 0) > 0;
}

export async function deletePasskey(userId: number, id: number) {
  const result: any = await executeRaw(`DELETE FROM ${q("user_passkeys")} WHERE ${q("id")} = ? AND ${q("userId")} = ?`, [id, userId]);
  return Number(result?.affectedRows ?? result?.changes ?? result?.rowCount ?? 0) > 0;
}

export async function recordPasskeyUse(id: number, signCount: number) {
  await executeRaw(`UPDATE ${q("user_passkeys")} SET ${q("signCount")} = ?, ${q("lastUsedAt")} = ? WHERE ${q("id")} = ?`, [signCount, Math.floor(Date.now() / 1000), id]);
}

/** 从 User-Agent 猜一个默认名字：「iPhone」「Mac · Chrome」……用户之后可以改。 */
export function defaultPasskeyName(userAgent: string | null | undefined) {
  const ua = String(userAgent || "");
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android 设备";
  if (/Windows/.test(ua)) return "Windows 电脑";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux 电脑";
  return "通行密钥";
}
