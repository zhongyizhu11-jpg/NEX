import * as db from "./db";
import { replaceHostWireGuardPlanes } from "./tunnelRuntimeStatus";
import { getAgentPluginInventory } from "./agentPluginInventory";
import { setBoundedMapValue } from "./boundedCache";
import { cleanEndpointHost } from "./forwardRuntimeConfigs";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import {
  AGENT_STATE_SECTION_NAMES,
  type AgentLocalRuntimeState,
  type AgentStateSectionName,
  type AgentStateSignatures,
  stableStateSignature,
} from "./agentHeartbeatReport";
import { setRuntimeRuleRunning } from "./ruleEntryBridges";
import { AGENT_HOST_CACHE_MAX, agentLocalRuntimeStateCache, agentOrphanPortStreakCache } from "./agentHeartbeatState";
import { runtimeBool } from "./agentHeartbeatRuntime";

/*
  Agent 报上来的本地运行态（localState）：按签名缓存、回包里只带变了的分段、孤儿端口的迟滞计数，
  以及拿本地记录和期望规则比对时用的几个比较函数。
  从 server/agentHeartbeatRoute.ts 里原样搬出来，行为不变（心跳处理函数里那几个不依赖本次请求的小函数提到了模块顶层）。
*/

export function agentPluginInventorySignature(inventory: ReturnType<typeof getAgentPluginInventory>) {
  if (!inventory) return "";
  return stableStateSignature({
    versions: Object.fromEntries(Array.from(inventory.versions.entries()).sort(([left], [right]) => left.localeCompare(right))),
    syncSignatures: Object.fromEntries(Array.from(inventory.syncSignatures.entries()).sort(([left], [right]) => left.localeCompare(right))),
  });
}


export function resolveAgentLocalRuntimeState(hostId: number, signature: string, reported: AgentLocalRuntimeState | null) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return { state: null as AgentLocalRuntimeState | null, requestLocalState: false };
  if (reported) {
    const nextSignature = signature || stableStateSignature(reported);
    setBoundedMapValue(agentLocalRuntimeStateCache, id, { signature: nextSignature, state: reported, updatedAt: Date.now() }, AGENT_HOST_CACHE_MAX);
    replaceHostWireGuardPlanes(id, [
      ...(reported.wireGuardPlanes || []),
      ...reported.tunnels
        .filter((tunnel) => tunnel.transportVersion === "v2" && tunnel.wireGuardPlane)
        .map((tunnel) => ({ tunnelId: tunnel.tunnelId, plane: tunnel.wireGuardPlane! })),
    ]);
    return { state: reported, requestLocalState: false };
  }
  if (!signature) return { state: null as AgentLocalRuntimeState | null, requestLocalState: false };
  const cached = agentLocalRuntimeStateCache.get(id);
  if (cached && cached.signature === signature) {
    return { state: cached.state, requestLocalState: false };
  }
  return { state: null as AgentLocalRuntimeState | null, requestLocalState: true };
}

export function buildAgentStateResponseSections(sections: Record<AgentStateSectionName, any[]>, clientSignatures: AgentStateSignatures) {
  const signatures: Record<AgentStateSectionName, string> = {} as Record<AgentStateSectionName, string>;
  const payload: Partial<Record<AgentStateSectionName, any[]>> = {};
  for (const name of AGENT_STATE_SECTION_NAMES) {
    const signature = stableStateSignature(sections[name] || []);
    signatures[name] = signature;
    if (clientSignatures[name] !== signature) {
      payload[name] = sections[name] || [];
    }
  }
  return { payload, signatures };
}

/**
 * 取得某主机的"孤儿端口迟滞计数"Map（port -> 连续判定为孤儿的心跳次数），不存在则创建。
 * 迟滞语义：一个上报端口的 ruleId 若属于面板已知的本机启用规则（稳定身份），
 * 即便本轮运行态推导没把它算进 expectedRulePorts，也很可能只是瞬时缺口，
 * 必须连续 AGENT_ORPHAN_REMOVE_MIN_STREAK 轮都判孤儿才真正拆除；一旦重新匹配上规则即清零。
 */
export function getOrphanPortStreaks(hostId: number): Map<string, number> {
  const id = Number(hostId);
  let streaks = agentOrphanPortStreakCache.get(id);
  if (!streaks) {
    streaks = new Map<string, number>();
    setBoundedMapValue(agentOrphanPortStreakCache, id, streaks, AGENT_HOST_CACHE_MAX);
  }
  return streaks;
}

export const isKernelForwardRule = (rule: any) => {
  const forwardType = String(rule?.forwardType || "").trim();
  return forwardType === "iptables" || forwardType === "nftables";
};

export const forwardTypeCompatible = (local: unknown, expected: unknown) => {
  const localValue = String(local || "").trim();
  const expectedValue = String(expected || "").trim();
  if (!localValue || !expectedValue) return true;
  if (localValue === expectedValue) return true;
  return localValue === "gost" && (expectedValue === "forwardx" || expectedValue === "nginx-tunnel");
};
export const localTextCompatible = (local: unknown, expected: unknown) => {
  const localValue = cleanEndpointHost(local).toLowerCase();
  const expectedValue = cleanEndpointHost(expected).toLowerCase();
  if (!localValue || !expectedValue) return true;
  return localValue === expectedValue;
};
export const localNumberCompatible = (local: unknown, expected: unknown) => {
  const localValue = Number(local || 0);
  const expectedValue = Number(expected || 0);
  if (localValue <= 0 || expectedValue <= 0) return true;
  return localValue === expectedValue;
};
export const localProtocolCompatible = (local: unknown, expected: unknown) => {
  const localValue = String(local || "").trim();
  const expectedValue = String(expected || "").trim();
  if (!localValue || !expectedValue) return true;
  return normalizeForwardRuleProtocol(localValue) === normalizeForwardRuleProtocol(expectedValue);
};

export const localForwardXTransportCompatible = (local: { transportVersion?: "v1" | "v2" }, expected: "v1" | "v2" | undefined) => {
  if (!expected) return true;
  // V2 must never adopt a V1 runtime. For V1, tolerate an omitted field
  // from older Agents while still rejecting a clearly stale V2 process.
  return expected === "v2"
    ? local.transportVersion === "v2"
    : local.transportVersion !== "v2";
};

export const settleStoppedRule = async (rule: any) => {
  const id = Number(rule?.id || 0);
  if (id <= 0) return;
  if (runtimeBool((rule as any).pendingDelete)) {
    await db.finalizeForwardRuleDelete(id);
  } else {
    await setRuntimeRuleRunning(id, false);
  }
  rule.isRunning = false;
};
