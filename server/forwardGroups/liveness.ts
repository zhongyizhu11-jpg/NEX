/*
  评估时成员主机「在不在线」：只认快速存活状态（agentFastLiveness.ts）和流量暂停，给出可用 / 不可用、从什么时候起、
  上一次掉线 / 回来的时刻和一个签名（签名变了说明评估期间主机状态变过，这一轮的选择作废）。
*/

import { HOST_ONLINE_TTL_MS } from "../repositories/hostRepository";
import { getTunnelExitNodes, getTunnelHops } from "../repositories/tunnelRepository";
import { dbBool } from "../repositories/repositoryUtils";
import { getLastAuthenticatedAgentActivity } from "../agentActivity";
import { hostTrafficExcluded } from "../../shared/hostTrafficPolicy";
import { getTrafficExcludedHostIds } from "../hostTrafficPolicy";
import { planTunnelTrafficParticipation } from "../hostTrafficRuntimePlan";
import { isTunnelRelayFailover } from "../../shared/tunnelRelay";
import { AGENT_FAST_LIVENESS_SILENCE_MS, getPresenceCapableHostLivenessSnapshot } from "../agentFastLiveness";
import { memberEntryHostId, toDate } from "./common";
import { evaluationHost, evaluationTunnel } from "./evaluateScope";
import { getForwardGroupById } from "../repositories/forwardGroupRepository";

export type MemberAgentLiveness = {
  hostId: number;
  available: boolean;
  /** 主机流量到了故障转移阈值（shared/hostTrafficPolicy.ts）：不等离线宽限期，直接换下一个成员。 */
  trafficExcluded: boolean;
  failureSince: Date | null;
  lastOfflineAt: number | null;
  /** 这台机器上一次从离线回到在线的时刻（面板看到的）；「刚回来」的成员不马上切回，见 evaluateMemberHealth。 */
  lastRestoredAt: number | null;
  /** 只看 Agent 到面板通不通（不含流量暂停）：外部观察「面板连不上，访客可达」用。 */
  agentOnline: boolean;
  /** 这台机器最近一次到面板的时刻（毫秒，0 = 没见过）和多久不来算离线（0 = 不参与就绪宽限）：就绪宽限用。 */
  lastSeenAt: number;
  offlineThresholdMs: number;
  signature: string;
};

/**
 * 隧道成员是否因为流量暂停而走不通：入口组全被暂停、固定出口 / 链式中转被暂停，都等于这条隧道
 * 现在用不了（和心跳里生成的运行时副本同一套判断，见 hostTrafficRuntimePlan.ts）。
 */
async function tunnelMemberTrafficExcluded(member: any) {
  if (member?.memberType !== "tunnel") return false;
  const excluded = await getTrafficExcludedHostIds();
  if (excluded.size === 0) return false;
  const tunnel = await evaluationTunnel(member.tunnelId).catch(() => null);
  if (!tunnel) return false;
  const [hops, exits] = await Promise.all([getTunnelHops(Number(tunnel.id)).catch(() => []), getTunnelExitNodes(Number(tunnel.id)).catch(() => [])]);
  const plan = planTunnelTrafficParticipation(tunnel, hops as any[], exits as any[], [Number((tunnel as any).entryHostId)], excluded);
  if (!dbBool(plan.tunnel.isEnabled) && dbBool((tunnel as any).isEnabled)) return true;
  // 固定出口的隧道成员没有别的出口可换。
  if (!Number((tunnel as any).exitGroupId) && !dbBool((tunnel as any).loadBalanceEnabled) && excluded.has(Number((tunnel as any).exitHostId))) return true;
  if (!isTunnelRelayFailover(tunnel, hops as any[])) return (hops as any[]).slice(1, -1).some((hop: any) => excluded.has(Number(hop.hostId)));
  return false;
}

export async function resolveMemberAgentLiveness(member: any, nowMs = Date.now()): Promise<MemberAgentLiveness> {
  const hostId = await memberEntryHostId(member).catch(() => 0);
  const host = hostId > 0 ? await evaluationHost(hostId).catch(() => null) : null;
  const trafficExcluded = hostTrafficExcluded(host as any) || await tunnelMemberTrafficExcluded(member).catch(() => false);
  const fastState = hostId > 0 ? getPresenceCapableHostLivenessSnapshot(hostId) : null;
  const authenticatedAt = hostId > 0 ? getLastAuthenticatedAgentActivity(hostId) || 0 : 0;
  const heartbeatAt = toDate((host as any)?.lastHeartbeat)?.getTime() || 0;
  // Once a host advertises lightweight presence, only that explicit signal is
  // allowed to move its failure window. A delayed log/traffic report is still
  // useful to the legacy 150-second UI fallback, but must not postpone DDNS
  // failover after the presence loop has stopped.
  const lastSeenAt = fastState
    ? Number(fastState.lastSeenAt || 0)
    : Math.max(authenticatedAt, heartbeatAt);
  const legacyActivityRecently = lastSeenAt > 0 && nowMs - Math.min(lastSeenAt, nowMs) <= HOST_ONLINE_TTL_MS;
  const lifecycleAt = toDate((host as any)?.createdAt)?.getTime()
    || toDate((host as any)?.updatedAt)?.getTime()
    || nowMs;
  const confirmedOffline = fastState?.confirmedOffline === true;
  // A registered presence-capable host remains indeterminate/available during
  // startup grace. Only its generation-safe timer may confirm it offline.
  // Legacy hosts have no such timer, so their last known activity keeps the
  // existing 150-second compatibility window. A lone DB status flag is not a
  // hard health signal while that activity is still fresh.
  const agentOnline = !!host && (fastState ? !confirmedOffline : legacyActivityRecently);
  const available = agentOnline && !trafficExcluded;
  const failureAt = lastSeenAt > 0 ? Math.min(lastSeenAt, nowMs) : Math.min(lifecycleAt, nowMs);
  const lastOfflineAt = Number(fastState?.lastOfflineAt || 0) || null;
  return {
    hostId,
    available,
    trafficExcluded,
    failureSince: available ? null : new Date(failureAt),
    lastOfflineAt,
    lastRestoredAt: Number(fastState?.lastRestoredAt || 0) || null,
    agentOnline,
    lastSeenAt: Math.max(0, lastSeenAt, authenticatedAt),
    // 只有带快速存活上报的主机（这一版要求的 Agent 都带）才有「内存里的存活状态重启后不作数」的问题；
    // 没有这份状态的（从没连过面板的机器）不用等，阈值是 0。
    offlineThresholdMs: fastState ? AGENT_FAST_LIVENESS_SILENCE_MS : 0,
    signature: [
      hostId,
      available ? 1 : 0,
      trafficExcluded ? 1 : 0,
      confirmedOffline ? 1 : 0,
      Number(fastState?.transitionEpoch || 0),
      lastOfflineAt || 0,
    ].join(":"),
  };
}

export function agentHealthSampleIsCurrent(liveness: MemberAgentLiveness, sampleAt: unknown) {
  if (!liveness.lastOfflineAt) return true;
  const sampleTime = toDate(sampleAt)?.getTime() || 0;
  return sampleTime > liveness.lastOfflineAt;
}

export async function memberAgentSelectionStillCurrent(member: any) {
  if (!member?.agentLivenessSignature) return true;
  const current = await resolveMemberAgentLiveness(member);
  return current.signature === String(member.agentLivenessSignature);
}

export async function failoverAgentSelectionStillCurrent(group: any, active: any, next: any) {
  const latest = await getForwardGroupById(Number(group?.id || 0)).catch(() => null) as any;
  if (!latest || Number(latest.activeMemberId || 0) !== Number(group?.activeMemberId || 0)) return false;
  const enabledMemberIds = new Set((latest.members || [])
    .filter((member: any) => dbBool(member?.isEnabled))
    .map((member: any) => Number(member.id || 0)));
  /*
    评估之后成员又被改了（停用 / 去掉）才算过期。活动成员在评估时就已经是停用的不算：那正是这次要从它
    身上换走的原因（P4）—— 以前这里一律要求活动成员启用，停用的活动成员永远换不走，评估还会不停重排。
  */
  if ((active && dbBool(active.isEnabled) && !enabledMemberIds.has(Number(active.id || 0)))
    || (next && !enabledMemberIds.has(Number(next.id || 0)))) return false;
  if (active && !(await memberAgentSelectionStillCurrent(active))) return false;
  if (next && !(await memberAgentSelectionStillCurrent(next))) return false;
  if (next && Number(next.id || 0) !== Number(active?.id || 0)) {
    const nextLiveness = await resolveMemberAgentLiveness(next);
    if (!nextLiveness.available) return false;
  }
  return true;
}
