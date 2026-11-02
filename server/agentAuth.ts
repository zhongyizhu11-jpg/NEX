import type { Request } from "express";
import * as db from "./db";
import { agentTokenFingerprint, parseAgentAuthProof, verifyAgentAuthProofDetails } from "./agentCrypto";
import { recordAuthenticatedAgentActivity } from "./agentActivity";

export const AGENT_AUTH_RESULT_HEADER = "X-ForwardX-Agent-Auth-Result";
export const AGENT_AUTH_RESULT_ACCEPTED = "accepted";
export const AGENT_AUTH_RESULT_REJECTED = "rejected";

let indexedTokens: string[] | null = null;
let tokenByFingerprint = new Map<string, string>();

/*
  旧式 Agent 认证：Authorization 里直接放明文 token（很老的 Agent 才这么发；现在的 Agent
  都发 v1. / v2. 签名）。默认照旧接受，管理员确认没有旧 Agent 之后可以在设置里打开
  「拒绝旧式 Agent 认证」。设置值缓存 15 秒：未认证的请求也会走到这里，不能每次都查库。

  每台主机最近一次用的是哪种认证记在内存里（重启后由下一次上报重新记上），
  设置页据此列出还在用旧式认证的主机，方便判断能不能打开开关。
*/
export const AGENT_LEGACY_AUTH_REJECT_SETTING = "agentLegacyAuthRejected";
const LEGACY_AUTH_SETTING_TTL_MS = 15_000;
let legacyAuthRejectCache: { value: boolean; loadedAt: number } | null = null;
let legacyAuthRejectLoading: Promise<boolean> | null = null;
const legacyAuthHosts = new Map<number, number>();

/** 设置保存后立即生效，不用等缓存过期。 */
export function setLegacyAgentAuthRejectedCache(value: boolean) {
  legacyAuthRejectCache = { value, loadedAt: Date.now() };
}

async function isLegacyAgentAuthRejected() {
  const now = Date.now();
  if (legacyAuthRejectCache && now - legacyAuthRejectCache.loadedAt < LEGACY_AUTH_SETTING_TTL_MS) return legacyAuthRejectCache.value;
  if (!legacyAuthRejectLoading) {
    legacyAuthRejectLoading = db.getSetting(AGENT_LEGACY_AUTH_REJECT_SETTING)
      .then((value) => value === "true")
      // 读不到设置时按上一次的值（没有就是默认的「接受」），别因为一次查库失败把旧 Agent 全挡掉。
      .catch(() => legacyAuthRejectCache?.value ?? false)
      .then((value) => {
        legacyAuthRejectCache = { value, loadedAt: Date.now() };
        return value;
      })
      .finally(() => { legacyAuthRejectLoading = null; });
  }
  return legacyAuthRejectLoading;
}

export function usedLegacyAgentAuth(req: Request) {
  return (req as any).agentLegacyAuth === true;
}

export function noteAgentAuthScheme(req: Request, hostIdValue: unknown) {
  const hostId = Number(hostIdValue);
  if (!Number.isInteger(hostId) || hostId <= 0) return;
  if (usedLegacyAgentAuth(req)) legacyAuthHosts.set(hostId, Date.now());
  else if (hasVerifiedAgentAuthProof(req)) legacyAuthHosts.delete(hostId);
}

/** 最近一次用旧式认证连上来的主机（主机 id → 时间）。 */
export function legacyAgentAuthHosts(): Array<{ hostId: number; lastLegacyAuthAt: Date }> {
  return [...legacyAuthHosts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hostId, at]) => ({ hostId, lastLegacyAuthAt: new Date(at) }));
}

export function isHostUsingLegacyAgentAuth(hostId: number) {
  return legacyAuthHosts.has(Number(hostId));
}

function tokenCandidateForProof(raw: string, tokens: string[]) {
  const proof = parseAgentAuthProof(raw);
  if (!proof) return null;
  if (indexedTokens !== tokens) {
    indexedTokens = tokens;
    tokenByFingerprint = new Map(tokens.map((token) => [agentTokenFingerprint(token), token]));
  }
  return tokenByFingerprint.get(proof.fingerprint) || null;
}

export function getResolvedAgentToken(req: Request): string | undefined {
  return (req as any).agentToken || undefined;
}

export function hasClocklessAgentAuth(req: Request) {
  return (req as any).agentAuthVersion === "v2";
}

export function hasVerifiedAgentAuthProof(req: Request) {
  return (req as any).agentAuthVersion === "v1" || (req as any).agentAuthVersion === "v2";
}

export function hasSignedAgentAuthAttempt(req: Request) {
  return (req as any).agentSignedAuthAttempted === true;
}

export function getAgentAuthRequestPath(req: Request) {
  const baseUrl = String(req.baseUrl || "").replace(/\/+$/, "");
  const path = String(req.path || "");
  if (!baseUrl) return path || "/";
  if (!path) return baseUrl || "/";
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function getAgentHostFromRequest(
  req: Request,
  options: { recordActivity?: boolean } = {},
) {
  const token = getResolvedAgentToken(req);
  if (!token) return null;
  const host = await db.getHostByAgentToken(token);
  if (host) noteAgentAuthScheme(req, (host as any).id);
  if (host && options.recordActivity !== false) recordAuthenticatedAgentActivity((host as any).id);
  return host;
}

export async function getAgentHostIdentityFromRequest(req: Request) {
  const token = getResolvedAgentToken(req);
  if (!token) return null;
  const host = await db.getAgentAuthHostIdentity(token);
  if (host) {
    noteAgentAuthScheme(req, (host as any).id);
    recordAuthenticatedAgentActivity((host as any).id);
  }
  return host;
}

export async function getAgentPresenceHostFromRequest(req: Request) {
  const token = getResolvedAgentToken(req);
  if (!token) return null;
  // The presence route must inspect the pre-request liveness state before this
  // request records activity, otherwise it can miss an offline -> online
  // recovery transition and skip runtime reconciliation.
  const identity = await db.getAgentAuthHostIdentity(token);
  if (!identity) return null;
  noteAgentAuthScheme(req, identity.id);
  return db.getHostAgentPresenceById(identity.id);
}

export async function getCandidateAgentTokens() {
  return db.getAgentAuthTokenCandidates();
}

export async function resolveAgentTokenFromAuthorization(
  req: Request,
  bodyText = "",
  nowMs?: number,
  challengeBodyText = bodyText,
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const credential = authHeader.substring(7).trim();
  if (!credential) return null;
  if (!credential.startsWith("v1.") && !credential.startsWith("v2.")) {
    // 旧式认证（明文 token）：设置里打开了「拒绝旧式 Agent 认证」就当作没带凭据。
    if (await isLegacyAgentAuthRejected()) {
      (req as any).agentLegacyAuthRejected = true;
      return null;
    }
    (req as any).agentLegacyAuth = true;
    return credential;
  }
  (req as any).agentSignedAuthAttempted = true;
  const verify = (tokens: string[]) => {
    const candidate = tokenCandidateForProof(credential, tokens);
    if (!candidate) return null;
    const verified = verifyAgentAuthProofDetails({
      raw: credential,
      candidateTokens: [candidate],
      method: req.method,
      path: getAgentAuthRequestPath(req),
      bodyText: credential.startsWith("v2.") ? challengeBodyText : bodyText,
      nowMs,
    });
    if (verified) (req as any).agentAuthVersion = verified.version;
    return verified?.token || null;
  };
  const token = verify(await getCandidateAgentTokens());
  if (token) return token;
  // 缓存里没有：可能是刚建的 token，重载一次数据库再验。未认证请求能反复触发这里，
  // 所以全局限频，别让它每次都去查库。
  if (!shouldForceReloadAgentTokenCandidates()) return null;
  return verify(await db.getAgentAuthTokenCandidates({ force: true }));
}

const AGENT_TOKEN_FORCED_RELOAD_INTERVAL_MS = 2_000;
let lastForcedAgentTokenReloadAt = 0;

function shouldForceReloadAgentTokenCandidates(now = Date.now()) {
  if (now - lastForcedAgentTokenReloadAt < AGENT_TOKEN_FORCED_RELOAD_INTERVAL_MS) return false;
  lastForcedAgentTokenReloadAt = now;
  return true;
}
