import type { NextFunction, Request, Response } from "express";
import { executeRaw, queryRaw, quoteDbIdentifier, rawAffectedRows } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { getResolvedAgentToken } from "./agentAuth";
import { getAgentTunneledPath } from "./agentEncryptionMiddleware";
import * as db from "./db";
import {
  AGENT_SUPERSEDED_FIELD,
  decideAgentInstallation,
  normalizeAgentInstallationId,
  parseRetiredInstallationIds,
  type AgentInstallationDecision,
  type AgentInstallationState,
} from "../shared/agentInstallation";

/*
  同 Token 换机接管的服务端那一半（判定规则见 shared/agentInstallation.ts）。

  - Agent 把安装实例 ID 放在 /api/sync 的加密信封里（和 path、payload 同一层），agentEncryptionMiddleware
    解开后挂在 req.agentInstallationId 上。只看信封里的：明文请求头谁都能改，信封里的经过了 Token 的 MAC。
  - 只管 /api/sync 进来的请求（Agent 本体的全部通信）。直接 POST /api/agent/* 的是 forwardx-fxp 上报流量
    之类，它不知道安装实例，照旧放行 —— 旧机器上还在跑的 FXP 隧道流量是真实发生的流量，记账不受影响。
  - 每台主机的「当前实例 / 已接管实例」缓存在内存里（30 秒兜底过期），心跳路径上平时不多查库；
    认领用带条件的 UPDATE（WHERE 当前实例 = 读到的值）：两台机器同时来，只有一台改得动，另一台重读再判。
  - 被接管的旧实例回 409 + agentSuperseded：信封是加密的，旧机器的 Agent 验过 MAC 才认，它停止同步、
    保留本机转发。不带实例 ID 的旧版 Agent 在主机已绑定实例后也回 409（它当普通失败处理，不会动转发）。
*/

const q = quoteDbIdentifier;
const STATE_CACHE_TTL_MS = 30_000;
const STATE_CACHE_MAX = 20_000;
const stateCache = new Map<number, AgentInstallationState & { loadedAt: number }>();

/** 被接管的旧实例收到的回包（409）。字段名和 agent/installation.go 对得上。 */
export const agentSupersededResponse = {
  success: false,
  [AGENT_SUPERSEDED_FIELD]: true,
  error: "Agent installation superseded",
  message: "这个 Token 已经由另一台机器上新装的 Agent 接管；本机停止和面板同步，已有转发保留。",
};

export const agentLegacyInstallationRejectedResponse = {
  success: false,
  error: "Agent installation required",
  message: "这台主机已经由另一台机器上新装的 Agent 接管；这台旧版 Agent 的上报不再接受。需要换回这台机器时，请在主机设置里解除实例绑定后升级它的 Agent。",
};

export function invalidateAgentInstallationState(hostId?: number) {
  if (hostId === undefined) stateCache.clear();
  else stateCache.delete(Number(hostId));
}

async function loadAgentInstallationState(hostId: number): Promise<AgentInstallationState | null> {
  const rows = await queryRaw<{ agentInstallationId?: unknown; agentRetiredInstallationIds?: unknown }>(
    `SELECT ${q("agentInstallationId")}, ${q("agentRetiredInstallationIds")} FROM ${q("hosts")} WHERE ${q("id")} = ?`,
    [hostId],
  );
  if (!rows[0]) return null;
  return {
    current: normalizeAgentInstallationId(rows[0].agentInstallationId),
    retired: parseRetiredInstallationIds(rows[0].agentRetiredInstallationIds),
  };
}

export async function getAgentInstallationState(hostId: number, options: { force?: boolean } = {}) {
  const id = Number(hostId);
  const cached = stateCache.get(id);
  if (!options.force && cached && Date.now() - cached.loadedAt < STATE_CACHE_TTL_MS) return cached;
  const state = await loadAgentInstallationState(id);
  if (!state) {
    stateCache.delete(id);
    return null;
  }
  stateCache.delete(id);
  stateCache.set(id, { ...state, loadedAt: Date.now() });
  while (stateCache.size > STATE_CACHE_MAX) {
    const oldest = stateCache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    stateCache.delete(oldest);
  }
  return state;
}

/** 条件写入：只有当前实例还是 expectedCurrent 时才改得动。返回是否写成功。 */
async function writeAgentInstallationState(hostId: number, expectedCurrent: string, next: AgentInstallationState) {
  const nowSec = Math.floor(Date.now() / 1000);
  const where = expectedCurrent
    ? `${q("agentInstallationId")} = ?`
    : `(${q("agentInstallationId")} IS NULL OR ${q("agentInstallationId")} = '')`;
  const params: unknown[] = [next.current, JSON.stringify(next.retired), nowSec, hostId];
  if (expectedCurrent) params.push(expectedCurrent);
  const result = await executeRaw(
    `UPDATE ${q("hosts")} SET ${q("agentInstallationId")} = ?, ${q("agentRetiredInstallationIds")} = ?, ${q("agentInstallationChangedAt")} = ?
      WHERE ${q("id")} = ? AND ${where}`,
    params,
  );
  invalidateAgentInstallationState(hostId);
  return rawAffectedRows(result) > 0;
}

export type AgentInstallationOutcome =
  | { kind: "accept" | "bind" | "superseded" | "legacy-rejected" }
  | { kind: "takeover"; previous: string };

/**
 * 判定并落库一次。认领撞上并发（别的请求刚改过）就按最新状态再判一次；还撞上就放行这一次
 * （下一次上报再判），不在这里死循环。
 */
export async function applyAgentInstallation(hostId: number, presented: unknown): Promise<AgentInstallationOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await getAgentInstallationState(hostId, { force: attempt > 0 });
    if (!state) return { kind: "accept" };
    const decision: AgentInstallationDecision = decideAgentInstallation(state, presented);
    if (decision.kind === "accept" || decision.kind === "superseded" || decision.kind === "legacy-rejected") return { kind: decision.kind };
    const expected = state.current;
    if (await writeAgentInstallationState(hostId, expected, decision.next)) {
      return decision.kind === "takeover" ? { kind: "takeover", previous: decision.previous } : { kind: "bind" };
    }
  }
  return { kind: "accept" };
}

/** 管理员「解除实例绑定」：清掉当前和已接管的实例，之后第一个来的 Agent 重新登记。 */
export async function resetAgentInstallation(hostId: number) {
  await executeRaw(
    `UPDATE ${q("hosts")} SET ${q("agentInstallationId")} = NULL, ${q("agentRetiredInstallationIds")} = NULL, ${q("agentInstallationChangedAt")} = ? WHERE ${q("id")} = ?`,
    [Math.floor(Date.now() / 1000), hostId],
  );
  invalidateAgentInstallationState(hostId);
}

export function getRequestAgentInstallationId(req: Request) {
  return normalizeAgentInstallationId((req as Request & { agentInstallationId?: unknown }).agentInstallationId);
}

type TakeoverHandler = (hostId: number, previous: string, next: string) => Promise<void> | void;

/**
 * 挂在 agentApiRouter 上（加密中间件之后、各个接口之前）。onTakeover 由 agentRoutes.ts 传入：
 * 新机器接管后要把运行时状态标成待重新下发，否则面板以为规则都已经在新机器上了。
 */
export function createAgentInstallationGuard(options: {
  onTakeover?: TakeoverHandler;
  onBind?: (hostId: number, installationId: string) => Promise<void> | void;
} = {}) {
  const loggedRejections = new Map<string, number>();
  const logOnce = (key: string, line: string) => {
    const now = Date.now();
    if (now - (loggedRejections.get(key) || 0) < 10 * 60_000) return;
    loggedRejections.set(key, now);
    if (loggedRejections.size > 4096) loggedRejections.clear();
    appendPanelLog("warn", line);
  };
  return async function agentInstallationGuard(req: Request, res: Response, next: NextFunction) {
    if (req.method !== "POST" || !getAgentTunneledPath(req)) { next(); return; }
    try {
      const token = getResolvedAgentToken(req);
      if (!token) { next(); return; }
      // 第一次注册时主机还不存在：注册接口建完主机，下一次请求再登记实例。
      const identity = await db.getAgentAuthHostIdentity(token);
      const hostId = Number(identity?.id || 0);
      if (!hostId) { next(); return; }
      const presented = getRequestAgentInstallationId(req);
      const outcome = await applyAgentInstallation(hostId, presented);
      if (outcome.kind === "superseded") {
        logOnce(`superseded:${hostId}:${presented}`, `[AgentInstallation] host=${hostId} rejected superseded installation=${presented.slice(0, 8)} path=${getAgentTunneledPath(req)}`);
        res.status(409).json(agentSupersededResponse);
        return;
      }
      if (outcome.kind === "legacy-rejected") {
        logOnce(`legacy:${hostId}`, `[AgentInstallation] host=${hostId} rejected Agent without installation id (host already bound to a newer installation) path=${getAgentTunneledPath(req)}`);
        res.status(409).json(agentLegacyInstallationRejectedResponse);
        return;
      }
      if (outcome.kind === "takeover") {
        appendPanelLog("warn", `[AgentInstallation] host=${hostId} taken over by installation=${presented.slice(0, 8)} previous=${outcome.previous.slice(0, 8)}`);
        await options.onTakeover?.(hostId, outcome.previous, presented);
      } else if (outcome.kind === "bind") {
        appendPanelLog("info", `[AgentInstallation] host=${hostId} bound installation=${presented.slice(0, 8)}`);
        await options.onBind?.(hostId, presented);
      }
      next();
    } catch (error) {
      // 判不了（库忙）就放行：宁可两台机器短暂一起报，也不能因为这一层把正常的 Agent 全挡在外面。
      appendPanelLog("warn", `[AgentInstallation] check failed: ${error instanceof Error ? error.message : String(error)}`);
      next();
    }
  };
}

/** SSE 事件流（/api/stream）开流前用：被接管的旧实例不再给它推配置。 */
export async function isAgentInstallationRejected(hostId: number, presented: unknown) {
  const state = await getAgentInstallationState(hostId).catch(() => null);
  if (!state) return false;
  const decision = decideAgentInstallation(state, presented);
  return decision.kind === "superseded" || decision.kind === "legacy-rejected";
}
