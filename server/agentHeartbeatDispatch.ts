import { setBoundedMapValue } from "./boundedCache";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import { stableActionSignatureHash } from "./agentDesiredStateHash";
import {
  AGENT_DYNAMIC_CACHE_MAX,
  AGENT_HOST_CACHE_MAX,
  agentActionBatchCache,
  agentDesiredStateSendCache,
  agentPluginSyncActionCache,
  agentRuntimeSyncActionCache,
} from "./agentHeartbeatState";

/*
  下发这一步的去重和节流：同一批动作复用 issuedAt、期望状态 / 运行时同步 / 插件同步什么时候重发、
  动作按端口去重（同端口有 apply 时丢掉陈旧的 remove）。缓存本身在 agentHeartbeatState.ts。
  从 server/agentHeartbeatRoute.ts 里原样搬出来，行为不变。
*/

const AGENT_ACTION_BATCH_REUSE_MS = 45 * 1000;
const AGENT_DESIRED_STATE_ACTIVE_RESEND_MS = 60 * 1000;

export const AGENT_PLUGIN_SYNC_RESEND_MS = 5 * 60 * 1000;

export function resolveActionBatchIssuedAt(hostId: number, actions: any[], fallbackIssuedAt: number) {
  if (actions.length === 0) {
    agentActionBatchCache.delete(hostId);
    return fallbackIssuedAt;
  }
  const now = Date.now();
  const signature = stableActionSignatureHash(actions);
  const cached = agentActionBatchCache.get(hostId);
  if (cached && cached.signature === signature && now - cached.seenAt < AGENT_ACTION_BATCH_REUSE_MS) {
    setBoundedMapValue(agentActionBatchCache, hostId, { ...cached, seenAt: now }, AGENT_HOST_CACHE_MAX);
    return cached.issuedAt;
  }
  setBoundedMapValue(agentActionBatchCache, hostId, { signature, issuedAt: fallbackIssuedAt, seenAt: now }, AGENT_HOST_CACHE_MAX);
  return fallbackIssuedAt;
}

/**
 * 这条动作在不在「隧道正在下发」—— 是的话，这次心跳先不叫 Agent 立即重测（forceTcping），
 * 免得测到一半搭好的隧道报超时。
 *
 * V2 隧道的 WireGuard 运行时动作（statusType = runtime）不算：它没有可核对的本地监听，
 * knownRunning 永远是 false，每次心跳都会留在待办里。原来把它也算进来，带 V2 隧道的主机
 * 就再也收不到立即重测：规则「诊断」等不到新的隧道段样本，18 秒后记成「端到端探测超时」，
 * 卡片挂红，可隧道诊断明明是通的。运行时没起来时 Agent 的 WireGuard 探测本来就是「未就绪」
 * 不上报，不会报假超时，所以不用在这里拦。
 */
export function isTunnelApplyBlockingProbe(action: any) {
  if (!action || action.op !== "apply" || Number(action.ruleId || 0) > 0) return false;
  if (action.statusType === "runtime") return false;
  return action.statusType === "tunnel" || Number(action.tunnelId) > 0;
}

export function shouldSendDesiredState(hostId: number, actions: any[], activeWorkActions: any[], now: number, configRevision = 0) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return actions.length > 0;
  const signature = stableActionSignatureHash(actions, `${Math.max(0, Math.floor(Number(configRevision) || 0))}\n`);
  const cached = agentDesiredStateSendCache.get(id);
  const hasActiveWork = activeWorkActions.length > 0;
  const changed = !cached || cached.signature !== signature;
  const activeResync = hasActiveWork && !!cached && now - cached.sentAt >= AGENT_DESIRED_STATE_ACTIVE_RESEND_MS;
  const shouldSend = changed || activeResync;
  if (shouldSend) {
    setBoundedMapValue(agentDesiredStateSendCache, id, { signature, sentAt: now }, AGENT_HOST_CACHE_MAX);
  }
  return shouldSend;
}

export function shouldSendRuntimeSyncAction(hostId: number, action: any, force: boolean, now: number, resendAfterMs = 0) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return true;
  const actionType = String(action?.forwardType || "runtime").trim() || "runtime";
  const cacheKey = `${id}:${actionType}`;
  const signature = stableActionSignatureHash([action]);
  const cached = agentRuntimeSyncActionCache.get(cacheKey);
  const changed = !cached || cached.signature !== signature;
  const shouldResend = !!cached && resendAfterMs > 0 && now - cached.sentAt >= resendAfterMs;
  if (force || changed || shouldResend) {
    setBoundedMapValue(agentRuntimeSyncActionCache, cacheKey, { signature, sentAt: now }, AGENT_DYNAMIC_CACHE_MAX);
    return true;
  }
  return false;
}

export function shouldSendPluginSyncAction(hostId: number, action: any, now: number, resendAfterMs = AGENT_PLUGIN_SYNC_RESEND_MS) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return true;
  const cacheKey = `${id}:${String(action?.forwardType || "plugin-sync")}`;
  const signature = stableActionSignatureHash([action]);
  const cached = agentPluginSyncActionCache.get(cacheKey);
  if (!cached || cached.signature !== signature || now - cached.sentAt >= resendAfterMs) {
    setBoundedMapValue(agentPluginSyncActionCache, cacheKey, { signature, sentAt: now }, AGENT_DYNAMIC_CACHE_MAX);
    return true;
  }
  return false;
}

export function runtimeSyncReconcileDue(hostId: number, actionType: string, now: number, intervalMs: number) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return true;
  const cached = agentRuntimeSyncActionCache.get(`${id}:${String(actionType || "runtime").trim() || "runtime"}`);
  return !cached || now - cached.sentAt >= intervalMs;
}

export function runtimePortProtocolKey(portValue: unknown, protocol: unknown) {
  const port = Number(portValue || 0);
  if (port <= 0) return "";
  return `${port}:${normalizeForwardRuleProtocol(protocol, "both")}`;
}

export function ruleRuntimeIdentityKey(ruleIdValue: unknown, portValue: unknown, protocol: unknown) {
  const ruleId = Number(ruleIdValue || 0);
  const portKey = runtimePortProtocolKey(portValue, protocol);
  if (ruleId <= 0 || !portKey) return "";
  return `${ruleId}:${portKey}`;
}

export function ruleRuntimePortIdentityKey(ruleIdValue: unknown, portValue: unknown) {
  const ruleId = Number(ruleIdValue || 0);
  const port = Number(portValue || 0);
  if (ruleId <= 0 || port <= 0) return "";
  return `${ruleId}:${port}`;
}

function actionRuleRuntimePortIdentityKey(action: any) {
  return ruleRuntimePortIdentityKey(action?.ruleId, action?.sourcePort);
}

export function actionPortKey(action: any) {
  const port = Number(action?.sourcePort || 0);
  if (port <= 0) return "";
  const statusType = String(action?.statusType || "").trim();
  const ruleId = Number(action?.ruleId || 0);
  const tunnelId = Number(action?.tunnelId || 0);
  if (ruleId > 0 || statusType === "rule") {
    return `rule-port:${runtimePortProtocolKey(port, action?.protocol)}`;
  }
  if (tunnelId > 0 || statusType === "tunnel") {
    return `tunnel:${tunnelId}:${port}`;
  }
  return "";
}

export function dropStalePortRemoveActions(actions: any[], protectedRulePorts = new Set<string>()) {
  const applyPorts = new Set<string>();
  for (const action of actions) {
    if (action?.op !== "apply") continue;
    const key = actionPortKey(action);
    if (key) applyPorts.add(key);
    const rulePortKey = actionRuleRuntimePortIdentityKey(action);
    if (rulePortKey) applyPorts.add(rulePortKey);
  }
  return actions.filter((action: any) => {
    if (action?.op !== "remove") return true;
    const key = actionPortKey(action);
    const rulePortKey = actionRuleRuntimePortIdentityKey(action);
    return !((key && (applyPorts.has(key) || protectedRulePorts.has(key))) || (rulePortKey && (applyPorts.has(rulePortKey) || protectedRulePorts.has(rulePortKey))));
  });
}

export function actionMayAffectRuntimeFamily(action: any, forwardTypes: Set<string>) {
  if (!action || action.statusType === "runtime") return false;
  const op = String(action.op || "").trim();
  if (op !== "apply" && op !== "remove") return false;
  if (action.fxp) return false;
  const runtimeForwardType = String(action.runtimeBackendForwardType || action.forwardType || "").trim();
  return forwardTypes.has(runtimeForwardType);
}
