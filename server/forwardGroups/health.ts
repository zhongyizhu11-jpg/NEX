/*
  健康上报的接收：Agent 报上来的成员健康（规则探测）、国内健康检测、外部观察点的结果怎么落到成员行上，
  外部观察的判断结果怎么附到组列表里给界面看，健康检测目标怎么规整。收到变化后交给评估队列（evaluateDriver.ts）。
*/

import { isIP } from "node:net";
import { forwardGroupModeOf } from "../../shared/forwardTypes";
import { eq, inArray } from "drizzle-orm";
import { forwardGroupMembers, forwardGroups } from "../../drizzle/schema";
import { getDb, nowDate } from "../dbRuntime";
import { defaultHealthCheckPort, defaultHealthCheckTarget, healthCheckTargetNeedsPort, normalizeForwardGroupHealthCheckMethod } from "../../shared/forwardGroupHealthCheck";
import { dbBool } from "../repositories/repositoryUtils";
import { getPresenceCapableHostLivenessSnapshot } from "../agentFastLiveness";
import { decideExternalHealth, externalHealthLabel, type ExternalHealthDecision, type PeerObserverView } from "./evaluate";
import { isPanelBackgroundLeaseHolder } from "../panelLease";
import { registerPanelWorkHandler, requestPanelWork } from "../panelWorkRequests";
import {
  PEER_OBSERVATION_TTL_MS,
  PEER_REFERENCE_MEMBER_ID,
  forwardGroupPeerObservations,
  parseStoredExternalHealth,
  serializeStoredExternalHealth,
} from "./peerObservations";
import { peerProbePortKey, type PeerProbePort } from "./topology";
import { ForwardGroupMode, LooseRow, forwardGroupFailoverDelayMs, forwardGroupRecoverDelayMs, memberEntryHostId, normalizeHostAddressKey, normalizeIpCandidate, supportsChinaHealthMode } from "./common";
import { chinaReachableSinceByMember } from "./ddnsEntryGroup";
import { scheduleForwardGroupFailover } from "./evaluateDriver";
import { getForwardGroupById } from "../repositories/forwardGroupRepository";
import { ForwardGroupProbeTopologySnapshot, forwardGroupProbeTopology, peerObserverOnline } from "./probeTopology";

export function normalizeChinaHealthTarget(raw: unknown, method?: unknown) {
  const probeMethod = normalizeForwardGroupHealthCheckMethod(method);
  const needsPort = healthCheckTargetNeedsPort(probeMethod);
  const source = String(raw || "").trim() || defaultHealthCheckTarget(probeMethod);
  const withoutScheme = source.replace(/^(?:tcp|udp|icmp|ping):\/\//i, "").replace(/：/g, ":").trim();
  let host = withoutScheme;
  let port = defaultHealthCheckPort(probeMethod);

  const bracketMatch = withoutScheme.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    host = bracketMatch[1];
    port = bracketMatch[2] ? Number(bracketMatch[2]) : defaultHealthCheckPort(probeMethod);
  } else {
    const lastColon = withoutScheme.lastIndexOf(":");
    if (lastColon > 0) {
      const maybeHost = withoutScheme.slice(0, lastColon).trim();
      const maybePortText = withoutScheme.slice(lastColon + 1);
      const maybePort = Number(maybePortText);
      const singleColonHostPort = withoutScheme.indexOf(":") === lastColon;
      const nakedIpv6HostPort = !singleColonHostPort && isIP(maybeHost) === 6;
      if ((singleColonHostPort || nakedIpv6HostPort) && /^\d+$/.test(maybePortText) && Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
        host = maybeHost;
        port = maybePort;
      }
    }
  }

  host = normalizeIpCandidate(host).trim();
  // Ping ignores ports entirely, so a port left over from TCPing is stripped
  // rather than reported as a malformed IPv6 address.
  if (!needsPort && host.includes(":") && isIP(host) !== 6) {
    const trailingPort = host.match(/^(.*?):(\d+)$/);
    if (trailingPort && isIP(trailingPort[1]) !== 6) host = trailingPort[1].trim();
  }
  if (host.includes(":") && isIP(host) !== 6) {
    throw new Error("China health IPv6 target format is invalid");
  }
  if (!host || host.length > 253 || /[\s'"<>/]/.test(host)) {
    throw new Error("China health target format is invalid");
  }
  if (needsPort && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("China health target port must be 1-65535");
  }
  const textHost = isIP(host) === 6 ? `[${host}]` : host;
  // Ping carries no port, so the stored text is the bare host and the probe is
  // emitted with port 0.
  if (!needsPort) return { host, port: 0, text: textHost, method: probeMethod };
  return { host, port, text: `${textHost}:${port}`, method: probeMethod };
}

export type ForwardGroupMemberPeerObserver = PeerObserverView & {
  name: string;
  checkedAt: number | null;
  latencyMs: number | null;
};

export type ForwardGroupMemberPeerHealth = {
  decision: ExternalHealthDecision;
  label: string;
  observers: ForwardGroupMemberPeerObserver[];
  ports: PeerProbePort[];
  targetIp: string;
};

/**
 * 一个成员此刻的外部观察：拓扑里安排了谁探它、各自看到什么、合起来的结论。没安排观察点返回 null。
 * 只读内存（拓扑快照 + 观察结果表 + 存活状态）。
 */
function memberPeerHealth(
  snapshot: ForwardGroupProbeTopologySnapshot,
  input: { groupId: number; memberId: number; agentOnline: boolean; failoverMs: number; previouslyDown: boolean; now: number },
): ForwardGroupMemberPeerHealth | null {
  const peer = snapshot.peerByGroup.get(Number(input.groupId));
  const assignment = peer?.assignments.get(Number(input.memberId));
  if (!peer || !assignment) return null;
  const { now } = input;
  const expectedPorts = new Set(assignment.ports.map(peerProbePortKey));
  const referencePorts = peer.reference ? new Set([peerProbePortKey({ port: peer.reference.targetPort, method: peer.reference.method })]) : null;
  const observers: ForwardGroupMemberPeerObserver[] = assignment.observerHostIds.map((observerHostId) => {
    const view = forwardGroupPeerObservations.view(observerHostId, peer.groupId, assignment.memberId, now, expectedPorts);
    // 自检：连得上参照目标，或者连得上同组里它负责探的另一个成员。
    let crossCheckOk = !!referencePorts
      && forwardGroupPeerObservations.view(observerHostId, peer.groupId, PEER_REFERENCE_MEMBER_ID, now, referencePorts).reachable === true;
    if (!crossCheckOk) {
      for (const other of peer.assignments.values()) {
        if (other.memberId === assignment.memberId || !other.observerHostIds.includes(observerHostId)) continue;
        if (forwardGroupPeerObservations.view(observerHostId, peer.groupId, other.memberId, now, new Set(other.ports.map(peerProbePortKey))).reachable === true) {
          crossCheckOk = true;
          break;
        }
      }
    }
    return {
      hostId: observerHostId,
      name: snapshot.hostNameById.get(observerHostId) || `主机${observerHostId}`,
      online: peerObserverOnline(observerHostId),
      reachable: view.reachable,
      since: view.since,
      everReached: view.everReached,
      crossCheckOk,
      checkedAt: view.checkedAt,
      latencyMs: view.latencyMs,
    };
  });
  const decision = decideExternalHealth({
    agentOnline: input.agentOnline,
    observers,
    failoverMs: input.failoverMs,
    previouslyDown: input.previouslyDown,
    now,
  });
  return { decision, label: externalHealthLabel(decision), observers, ports: assignment.ports, targetIp: assignment.targetIp };
}

/**
 * 评估里用：算出成员的外部观察结论，并把要跨重启保留的那点状态（是否判了不可用、谁连通过它）写回成员行
 * （只在变了的时候写）。没安排观察点返回 null，成员行里的旧状态清掉。
 */
export async function evaluateMemberPeerHealth(group: LooseRow, member: LooseRow, agentOnline: boolean, now: number) {
  const snapshot = await forwardGroupProbeTopology.get();
  const groupId = Number(group.id);
  const memberId = Number(member.id);
  const stored = parseStoredExternalHealth(member.externalHealth);
  const assignment = snapshot.peerByGroup.get(groupId)?.assignments.get(memberId);
  if (assignment && stored.reachedBy.length > 0) {
    forwardGroupPeerObservations.seedEverReached(groupId, memberId, stored.reachedBy.filter((hostId) => assignment.observerHostIds.includes(hostId)), now);
  }
  const health = memberPeerHealth(snapshot, {
    groupId,
    memberId,
    agentOnline,
    failoverMs: forwardGroupFailoverDelayMs(group),
    previouslyDown: stored.down,
    now,
  });
  const nextStored = serializeStoredExternalHealth(health
    ? { down: health.decision.down, reachedBy: health.observers.filter((observer) => observer.everReached).map((observer) => observer.hostId) }
    : { down: false, reachedBy: [] });
  if (nextStored !== serializeStoredExternalHealth(stored) || (!nextStored && member.externalHealth)) {
    const db = await getDb();
    await db.update(forwardGroupMembers).set({ externalHealth: nextStored } as LooseRow).where(eq(forwardGroupMembers.id, memberId));
    member.externalHealth = nextStored;
  }
  return health;
}

function sameProbeAddress(left: unknown, right: unknown) {
  return normalizeHostAddressKey(left) === normalizeHostAddressKey(right);
}

type PeerReport = {
  groupId?: unknown;
  memberId?: unknown;
  targetIp?: unknown;
  targetPort?: unknown;
  method?: unknown;
  isTimeout?: unknown;
  latencyMs?: unknown;
};

const PEER_REPORT_WORK = "forward-group-peer-report";

/*
  多实例部署（server/panelLease.ts）：观察点的 Agent 只连一个实例，结果只进那个实例的内存。评估只在持有实例上做 ——
  别的实例收到的结果不交过去，持有者那边这个观察点就一直「没有结果」，票数门槛也跟着掉成 1（评审 F3）。
  所以非持有实例收下的结果按「观察点 + 组 + 成员」写进 panel_work_requests 交给持有者（同一个成员只留最新一批），
  带着「这批是多久以前观察到的」；持有者按库的时钟算出的请求年龄还原观察时刻，太旧（超过结果有效期）的不收。
  非持有实例自己也照样记一份（它那边的界面要显示），但不排评估（持有者收下后会排）。
*/
registerPanelWorkHandler(PEER_REPORT_WORK, async (key, payload, context) => {
  const observerHostId = Number(String(key).split(":")[0] || 0);
  const body = (payload || {}) as { observedAgoMs?: unknown; reports?: unknown };
  if (!(observerHostId > 0) || !Array.isArray(body.reports)) return;
  const ageMs = Math.max(0, context.ageMs) + Math.max(0, Number(body.observedAgoMs) || 0);
  if (ageMs > PEER_OBSERVATION_TTL_MS) return;
  await ingestForwardGroupPeerReports(observerHostId, body.reports as PeerReport[], Date.now() - ageMs);
});

/**
 * 观察点报上来的外部观察结果（TCPing 上报里 probeType = "peer" 的那些）。只进内存；结论变了就重新评估那个组。
 * 上报必须对得上拓扑里的安排：这台机器确实被安排探这个成员的这个地址和端口，否则丢掉。返回收下的条数。
 * 不是持有实例时另外交给持有者（见上面）。
 */
export async function ingestForwardGroupPeerReports(hostIdValue: unknown, reports: ReadonlyArray<PeerReport>, now = Date.now()) {
  const hostId = Number(hostIdValue || 0);
  if (!(hostId > 0) || reports.length === 0) return 0;
  const snapshot = await forwardGroupProbeTopology.get();
  const changedGroupIds = new Set<number>();
  const holder = isPanelBackgroundLeaseHolder();
  const forwardByTarget = new Map<string, PeerReport[]>();
  let accepted = 0;
  for (const report of reports) {
    const groupId = Number(report.groupId || 0);
    const peer = snapshot.peerByGroup.get(groupId);
    if (!peer || !peer.observerHostIds.has(hostId)) continue;
    const memberId = Number(report.memberId || 0);
    const port = Number(report.targetPort || 0);
    const method = normalizeForwardGroupHealthCheckMethod(report.method);
    let expectedPorts: Set<string>;
    if (memberId === PEER_REFERENCE_MEMBER_ID) {
      const reference = peer.reference;
      if (!reference || !sameProbeAddress(report.targetIp, reference.targetIp) || port !== Number(reference.targetPort) || method !== reference.method) continue;
      expectedPorts = new Set([peerProbePortKey({ port: reference.targetPort, method: reference.method })]);
    } else {
      const assignment = peer.assignments.get(memberId);
      if (!assignment || !assignment.observerHostIds.includes(hostId) || !sameProbeAddress(report.targetIp, assignment.targetIp)) continue;
      if (!assignment.ports.some((entry) => entry.port === port && entry.method === method)) continue;
      expectedPorts = new Set(assignment.ports.map(peerProbePortKey));
    }
    accepted += 1;
    if (!holder) {
      const key = `${hostId}:${groupId}:${memberId}`;
      const list = forwardByTarget.get(key) || [];
      list.push({ groupId, memberId, targetIp: report.targetIp, targetPort: port, method, isTimeout: report.isTimeout === true, latencyMs: report.latencyMs });
      forwardByTarget.set(key, list);
    }
    const latency = Number(report.latencyMs);
    const changed = forwardGroupPeerObservations.record({
      observerHostId: hostId,
      groupId,
      memberId,
      portKey: peerProbePortKey({ port, method }),
      ok: report.isTimeout !== true,
      latencyMs: Number.isFinite(latency) && latency > 0 ? latency : null,
      expectedPorts,
      now,
    });
    if (changed) changedGroupIds.add(groupId);
  }
  if (!holder) {
    const observedAgoMs = Math.max(0, Date.now() - now);
    for (const [key, list] of forwardByTarget) await requestPanelWork(PEER_REPORT_WORK, key, { observedAgoMs, reports: list });
    return accepted;
  }
  if (changedGroupIds.size > 0) scheduleForwardGroupFailover(Array.from(changedGroupIds));
  return accepted;
}

/**
 * 给组列表 / 详情的成员挂上外部观察的现状（peerHealth）：自己报告的健康在 healthStatus，这里是别的机器看到的。
 * 只读内存；拓扑缓存过期时会重建一次。没安排观察点的成员是 null。
 */
export async function attachForwardGroupPeerHealth<T extends { id?: unknown; groupMode?: unknown; members?: LooseRow[] | null; failoverSeconds?: unknown }>(groups: T[]): Promise<T[]> {
  if (!groups.some((group) => supportsChinaHealthMode(forwardGroupModeOf(group)))) return groups;
  const snapshot = await forwardGroupProbeTopology.get().catch(() => null);
  if (!snapshot) return groups;
  const now = Date.now();
  return groups.map((group) => {
    if (!supportsChinaHealthMode(forwardGroupModeOf(group))) return group;
    const groupId = Number(group.id);
    const peerProbe = {
      /** 这个组现在有没有成员被别的机器观察着。false = 只看成员自己的报告。 */
      active: snapshot.peerByGroup.has(groupId),
      /** Agent 太旧、当不了观察点的主机：需要升级 Agent。 */
      outdatedHosts: (snapshot.peerOutdatedHostIdsByGroup.get(groupId) || [])
        .map((hostId) => ({ id: hostId, name: snapshot.hostNameById.get(hostId) || `主机${hostId}` })),
    };
    if (!peerProbe.active) return { ...group, peerProbe };
    return {
      ...group,
      peerProbe,
      members: (group.members || []).map((member) => {
        const hostId = Number(member?.host?.id || member?.hostId || 0);
        const fastState = hostId > 0 ? getPresenceCapableHostLivenessSnapshot(hostId) : null;
        const health = memberPeerHealth(snapshot, {
          groupId: Number(group.id),
          memberId: Number(member.id),
          // 和评估同一条规矩（liveness.ts）：没有快速存活状态的主机算离线，确认离线的也是（只影响「面板连不上，访客可达」那句提示）。
          agentOnline: !!fastState && !fastState.confirmedOffline,
          failoverMs: forwardGroupFailoverDelayMs(group),
          previouslyDown: parseStoredExternalHealth(member.externalHealth).down,
          now,
        });
        return {
          ...member,
          peerHealth: health ? {
            state: health.decision.state,
            down: health.decision.down,
            reachableWhileAgentOffline: health.decision.reachableWhileAgentOffline,
            reachableCount: health.decision.reachableCount,
            usableCount: health.decision.usableCount,
            assignedCount: health.decision.assignedCount,
            label: health.label,
            targetIp: health.targetIp,
            ports: health.ports,
            observers: health.observers.map((observer) => ({
              hostId: observer.hostId,
              name: observer.name,
              // offline 观察点离线 / stale 没有新鲜结果 / reachable 连得上 / unreachable 连不上（作数）/ ignored 连不上但不作数
              status: !observer.online ? "offline" : observer.reachable === null ? "stale" : observer.reachable ? "reachable"
                : observer.everReached && observer.crossCheckOk ? "unreachable" : "ignored",
              ignoredReason: observer.online && observer.reachable === false
                ? (!observer.everReached ? "never-reached" : !observer.crossCheckOk ? "cross-check" : null)
                : null,
              since: observer.since,
              checkedAt: observer.checkedAt,
              latencyMs: observer.latencyMs,
            })),
          } : null,
        };
      }),
    };
  });
}

export async function getForwardGroupHealthConfigs(groupIds: number[]) {
  const ids = Array.from(new Set(groupIds
    .map((value) => Number(value || 0))
    .filter((value) => Number.isInteger(value) && value > 0)));
  if (ids.length === 0) return [];
  const db = await getDb();
  return db.select({
    id: forwardGroups.id,
    groupMode: forwardGroups.groupMode,
    isEnabled: forwardGroups.isEnabled,
    rateLimitMbps: forwardGroups.rateLimitMbps,
    failoverSeconds: forwardGroups.failoverSeconds,
    recoverSeconds: forwardGroups.recoverSeconds,
  }).from(forwardGroups).where(inArray(forwardGroups.id, ids));
}

/** 上报已经按探测拓扑核对过（组启用、模式对、成员属于这台主机）时带上：不用再把组和成员读一遍来核对。 */
type VerifiedHealthProbe = { groupMode?: unknown; failoverSeconds?: unknown; recoverSeconds?: unknown };

export async function updateForwardGroupMemberChinaHealth(input: {
  groupId: number;
  memberId: number;
  hostId: number;
  latencyMs: number | null;
  isTimeout: boolean;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
}, verified?: VerifiedHealthProbe) {
  let window: { failoverSeconds?: unknown; recoverSeconds?: unknown };
  let mode: ForwardGroupMode;
  if (verified) {
    window = verified;
    mode = forwardGroupModeOf({ groupMode: verified.groupMode });
  } else {
    const group = await getForwardGroupById(Number(input.groupId)) as LooseRow;
    if (!group || !dbBool(group.chinaHealthCheckEnabled) || !supportsChinaHealthMode(forwardGroupModeOf(group))) return false;
    const member = (group.members || []).find((item: LooseRow) => Number(item.id) === Number(input.memberId));
    if (!member) return false;
    const entryHostId = await memberEntryHostId(member);
    if (Number(entryHostId) !== Number(input.hostId)) return false;
    window = group;
    mode = forwardGroupModeOf(group);
  }
  const agentDecision = input.healthStatus === "healthy" || input.healthStatus === "unhealthy"
    ? input.healthStatus
    : input.healthStatus === "unknown"
      ? "unknown"
      : null;
  const nextStatus = agentDecision || (input.isTimeout ? "unhealthy" : "healthy");
  const decisionNow = nowDate();
  // 原始结果从什么时候开始连得上（入口组算「连续健康多久」用，见 chinaReachableSinceByMember）。
  const memberId = Number(input.memberId);
  if (input.isTimeout) chinaReachableSinceByMember.delete(memberId);
  else if (!chinaReachableSinceByMember.has(memberId)) {
    if (chinaReachableSinceByMember.size >= 8192) chinaReachableSinceByMember.clear();
    chinaReachableSinceByMember.set(memberId, decisionNow.getTime());
  }
  const decisionWindowPatch = agentDecision === "unhealthy"
    ? {
        failureSince: new Date(decisionNow.getTime() - forwardGroupFailoverDelayMs(window)),
        healthySince: null,
      }
    : agentDecision === "healthy" && mode !== "entry"
      ? {
          failureSince: null,
          healthySince: new Date(decisionNow.getTime() - forwardGroupRecoverDelayMs(window)),
        }
      // 入口组：成员恢复后「连续健康多久」由面板的评估自己数（syncEntryGroupDefaultDdns），这里不替它把时间倒填回去。
      : {};
  const db = await getDb();
  await db.update(forwardGroupMembers).set({
    chinaHealthStatus: nextStatus,
    chinaHealthLatencyMs: nextStatus === "healthy" ? input.latencyMs : null,
    chinaHealthCheckedAt: decisionNow,
    ...decisionWindowPatch,
    updatedAt: decisionNow,
  } as LooseRow).where(eq(forwardGroupMembers.id, memberId));
  scheduleForwardGroupFailover([Number(input.groupId)]);
  return true;
}

export async function resetForwardGroupChinaHealth(groupId: number) {
  const db = await getDb();
  await db.update(forwardGroupMembers).set({
    healthStatus: "unknown",
    chinaHealthStatus: "unknown",
    chinaHealthLatencyMs: null,
    chinaHealthCheckedAt: null,
    failureSince: null,
    healthySince: null,
    lastCheckedAt: null,
    updatedAt: nowDate(),
  } as any).where(eq(forwardGroupMembers.groupId, Number(groupId)));
}

export async function updateForwardGroupMemberAgentHealth(input: {
  groupId: number;
  memberId: number;
  hostId: number;
  healthStatus: "unknown" | "healthy" | "unhealthy";
}, verified?: VerifiedHealthProbe) {
  let window: { failoverSeconds?: unknown; recoverSeconds?: unknown };
  if (verified) {
    window = verified;
  } else {
    const group = await getForwardGroupById(Number(input.groupId)) as LooseRow;
    if (!group || forwardGroupModeOf(group) !== "entry" || dbBool(group.chinaHealthCheckEnabled)) return false;
    const member = (group.members || []).find((item: LooseRow) => Number(item.id) === Number(input.memberId));
    if (!member || member.memberType !== "host" || Number(member.hostId || 0) !== Number(input.hostId)) return false;
    window = group;
  }
  const checkedAt = nowDate();
  /*
    报「不健康」照旧把故障开始时间倒填（Agent 那边已经观察满了，面板立刻拿掉）。报「健康」不再倒填恢复时间：
    入口组把成员加回解析之前要连续健康满 recoverSeconds，这段时间由面板的评估从它第一次看到健康起数
    （以前这里直接填成「已经健康够久」，成员 Agent 一上线、第一份上报就被加回去，机器还在反复重启也一样）。
  */
  const decisionWindowPatch = input.healthStatus === "unhealthy"
    ? {
        failureSince: new Date(checkedAt.getTime() - forwardGroupFailoverDelayMs(window)),
        healthySince: null,
      }
    : {};
  const db = await getDb();
  await db.update(forwardGroupMembers).set({
    healthStatus: input.healthStatus,
    lastCheckedAt: checkedAt,
    ...decisionWindowPatch,
    updatedAt: checkedAt,
  } as any).where(eq(forwardGroupMembers.id, Number(input.memberId)));
  scheduleForwardGroupFailover([Number(input.groupId)]);
  return true;
}
