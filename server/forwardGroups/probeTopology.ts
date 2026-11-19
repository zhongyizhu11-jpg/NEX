/*
  给 Agent 下发的转发组探测拓扑：链式组每一跳的探测、国内健康检测、入口组成员探测、外部观察点（谁探谁，
  topology.ts 的 planPeerObservers）。按主机取用，结果放在 TopologyCache 里（改组 / 成员 / 主机地址时作废，30 秒兜底）。
*/

import { forwardGroupModeOf } from "../../shared/forwardTypes";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";
import {
  forwardGroupMembers,
  forwardGroups,
  forwardRules,
  hosts,
  tunnels,
} from "../../drizzle/schema";
import { appendPanelLog } from "../_core/panelLogger";
import { afterDatabaseTransactionSettled, getDb, isDatabaseTransactionActive } from "../dbRuntime";
import { normalizeForwardGroupHealthCheckMethod, type ForwardGroupHealthCheckMethod } from "../../shared/forwardGroupHealthCheck";
import { getForwardGroupChildRulesForTemplate } from "../repositories/forwardRuleRepository";
import { getHostById } from "../repositories/hostRepository";
import { linkProbeMethodForProtocol, type LinkProbeMethod } from "@shared/latencyProbe";
import { dbBool } from "../repositories/repositoryUtils";
import { getPresenceCapableHostLivenessSnapshot } from "../agentFastLiveness";
import { agentSupportsUnifiedBalance } from "../../shared/loadBalance";
import { PEER_REFERENCE_MEMBER_ID, forwardGroupPeerObservations } from "./peerObservations";
import {
  TopologyCache,
  parsePeerObserverHostIds,
  planPeerObservers,
  selectPeerProbePorts,
  type PeerAssignment,
  type PeerTargetMember,
} from "./topology";
import { LooseRow, chainEntryMembers, ddnsValueForHostByRecordType, entryAddressForHost, forwardChainTargetLabel, hostDisplayLabel, normalizeForwardGroupRecordType, sortedMembers, supportsChinaHealthMode } from "./common";
import { getForwardGroupById, getForwardGroupPrimaryTemplateRule, resolveChainConnectHost } from "../repositories/forwardGroupRepository";
import { normalizeChinaHealthTarget } from "./healthTarget";

export type ForwardGroupChainProbe = {
  groupId: number;
  fromHostId: number;
  targetIp: string;
  targetPort: number;
  method: LinkProbeMethod;
  hopIndex: number;
  hopCount: number;
  hopLabel: string;
  routeLabel: string;
  runtimeDependent: boolean;
};

type ForwardGroupChainProbeOptions = {
  includeFinalTarget?: boolean;
  templateRule?: any;
  method?: LinkProbeMethod;
  sourcePort?: number;
  listenerPorts?: ReadonlyMap<string, number>;
};

function forwardChainListenerKey(memberId: unknown, hostId: unknown) {
  return `${Number(memberId || 0)}:${Number(hostId || 0)}`;
}

function forwardChainListenerPort(
  listenerPorts: ReadonlyMap<string, number> | undefined,
  member: any,
  fallback: number,
) {
  const port = Number(listenerPorts?.get(forwardChainListenerKey(member?.id, member?.hostId)) || 0);
  return port > 0 ? port : fallback;
}

export type ForwardGroupChinaHealthProbe = {
  groupId: number;
  memberId: number;
  fromHostId: number;
  targetIp: string;
  targetPort: number;
  method: ForwardGroupHealthCheckMethod;
  probeType: "china";
  failoverSeconds: number;
  recoverSeconds: number;
  /** 这个探测属于主备组还是入口组（上报处理按它决定恢复时间怎么算）。 */
  groupMode?: "failover" | "entry";
};

export type ForwardGroupEntryHealthProbe = {
  groupId: number;
  memberId: number;
  fromHostId: number;
  targetIp: "";
  targetPort: 0;
  method: "self";
  probeType: "entry";
  failoverSeconds: number;
  recoverSeconds: number;
};

/** 外部观察：这台机器（观察点）去探某个成员对外的入口端口；memberId = 0 是这个组的参照目标。 */
export type ForwardGroupPeerHealthProbe = {
  groupId: number;
  memberId: number;
  fromHostId: number;
  targetIp: string;
  targetPort: number;
  method: ForwardGroupHealthCheckMethod;
  probeType: "peer";
  failoverSeconds: number;
  recoverSeconds: number;
};

export type ForwardGroupProbeTopologyForHost = {
  chainGroups: Array<{
    groupId: number;
    probes: ForwardGroupChainProbe[];
  }>;
  chinaHealthProbes: ForwardGroupChinaHealthProbe[];
  entryHealthProbes: ForwardGroupEntryHealthProbe[];
  peerHealthProbes: ForwardGroupPeerHealthProbe[];
};

/** 一个组的外部观察安排：每个成员由谁探、探哪些端口，以及观察点自检用的参照目标。 */
type ForwardGroupPeerGroupTopology = {
  groupId: number;
  failoverSeconds: number;
  recoverSeconds: number;
  reference: { targetIp: string; targetPort: number; method: ForwardGroupHealthCheckMethod } | null;
  assignments: Map<number, PeerAssignment>;
  observerHostIds: Set<number>;
};

export type ForwardGroupProbeTopologySnapshot = {
  byHost: Map<number, ForwardGroupProbeTopologyForHost>;
  peerByGroup: Map<number, ForwardGroupPeerGroupTopology>;
  /** 开了外部观察的组里，Agent 太旧当不了观察点的主机（界面上提示「需要升级 Agent」）。 */
  peerOutdatedHostIdsByGroup: Map<number, number[]>;
  hostNameById: Map<number, string>;
};

async function buildForwardGroupChainProbes(
  groupId: number,
  group: any,
  entryMembers: any[],
  hostById: Map<number, any>,
  options: ForwardGroupChainProbeOptions = {},
) {
  const template = options.templateRule as any;
  const members = sortedMembers(group, true) as any[];
  const hasExternalEntry = entryMembers.length > 0;
  if (members.length < (hasExternalEntry ? 1 : 2)) return [] as ForwardGroupChainProbe[];

  const probes: ForwardGroupChainProbe[] = [];
  const sourcePort = Number(options.sourcePort ?? template?.sourcePort ?? 0);
  const hopProbeMethod = options.method || (template ? linkProbeMethodForProtocol(template?.protocol) : "ping");
  const hasFinalTarget = !!options.includeFinalTarget
    && !!template
    && String(template.targetIp || "").trim()
    && Number(template.targetPort || 0) > 0;
  const entryHopCount = hasExternalEntry ? 1 : 0;
  const hopCount = entryHopCount + Math.max(0, members.length - 1) + (hasFinalTarget ? 1 : 0);
  let hopIndex = 0;

  if (hasExternalEntry) {
    const firstMember = members[0] as any;
    const firstHostId = Number(firstMember.hostId || 0);
    const firstHost = hostById.get(firstHostId);
    const targetIp = resolveChainConnectHost(firstMember, firstHost);
    const firstListenerPort = forwardChainListenerPort(options.listenerPorts, firstMember, sourcePort);
    const firstName = String(firstHost?.name || `主机${firstHostId}`);
    if (targetIp && (hopProbeMethod === "ping" || firstListenerPort > 0)) {
      for (const entryMember of entryMembers) {
        const entryHostId = Number(entryMember.hostId || 0);
        const entryHost = hostById.get(entryHostId);
        if (!entryHostId) continue;
        const entryName = String(entryHost?.name || `主机${entryHostId}`);
        probes.push({
          groupId,
          fromHostId: entryHostId,
          targetIp,
          targetPort: hopProbeMethod === "ping" ? 0 : firstListenerPort,
          method: hopProbeMethod,
          hopIndex,
          hopCount,
          hopLabel: `${hopIndex + 1}/${hopCount} ${entryHostId}->${firstHostId}`,
          routeLabel: `${entryName} -> ${firstName}`,
          runtimeDependent: true,
        });
      }
    }
    hopIndex += 1;
  }
  for (let index = 0; index < members.length - 1; index++) {
    const current = members[index] as any;
    const next = members[index + 1] as any;
    const currentHostId = Number(current.hostId || 0);
    const nextHostId = Number(next.hostId || 0);
    const currentHost = hostById.get(currentHostId);
    const nextHost = hostById.get(nextHostId);
    const targetIp = resolveChainConnectHost(next, nextHost);
    const nextListenerPort = forwardChainListenerPort(options.listenerPorts, next, sourcePort);
    if (!currentHostId || !targetIp) continue;
    const currentName = String(currentHost?.name || `主机${currentHostId}`);
    const nextName = String(nextHost?.name || `主机${nextHostId}`);
    probes.push({
      groupId,
      fromHostId: currentHostId,
      targetIp,
      targetPort: hopProbeMethod === "ping" ? 0 : (nextListenerPort > 0 ? nextListenerPort : 0),
      method: hopProbeMethod,
      hopIndex,
      hopCount,
      hopLabel: `${hopIndex + 1}/${hopCount} ${currentHostId}->${nextHostId}`,
      routeLabel: `${currentName} -> ${nextName}`,
      runtimeDependent: true,
    });
    hopIndex += 1;
  }
  if (hasFinalTarget) {
    const lastMember = members[members.length - 1] as any;
    const lastHostId = Number(lastMember.hostId || 0);
    const lastHost = hostById.get(lastHostId);
    const targetIp = String(template.targetIp || "").trim();
    const targetPort = Number(template.targetPort || 0);
    if (lastHostId > 0 && targetIp && targetPort > 0) {
      const targetLabel = await forwardChainTargetLabel(template);
      const finalProbeMethod = linkProbeMethodForProtocol(template?.protocol);
      probes.push({
        groupId,
        fromHostId: lastHostId,
        targetIp,
        targetPort: finalProbeMethod === "ping" ? 0 : targetPort,
        method: finalProbeMethod,
        hopIndex,
        hopCount,
        hopLabel: `${hopIndex + 1}/${hopCount} ${lastHostId}->target`,
        routeLabel: `${hostDisplayLabel(lastHost, `主机${lastHostId}`)} -> ${targetLabel}`,
        runtimeDependent: false,
      });
    }
  }
  return probes;
}

export async function getForwardGroupChainProbes(groupId: number, options: ForwardGroupChainProbeOptions = {}) {
  const group = await getForwardGroupById(groupId) as any;
  if (!group || forwardGroupModeOf(group) !== "chain") return [] as ForwardGroupChainProbe[];
  const template = options.templateRule || (options.includeFinalTarget ? await getForwardGroupPrimaryTemplateRule(groupId) : null) as any;
  const members = sortedMembers(group, true) as any[];
  const entryMembers = await chainEntryMembers(group);
  const listenerPorts = new Map<string, number>();
  const templateId = Number(template?.id || 0);
  if (templateId > 0) {
    const childRules = await getForwardGroupChildRulesForTemplate(templateId);
    for (const child of childRules as any[]) {
      if (dbBool(child?.pendingDelete)) continue;
      const key = forwardChainListenerKey(child?.forwardGroupMemberId, child?.hostId);
      const port = Number(child?.sourcePort || 0);
      if (port > 0 && !listenerPorts.has(key)) listenerPorts.set(key, port);
    }
  }

  const hostById = new Map<number, any>();
  for (const member of [...entryMembers, ...members]) {
    const hostId = Number(member.hostId || 0);
    if (hostId > 0 && !hostById.has(hostId)) hostById.set(hostId, await getHostById(hostId));
  }
  return buildForwardGroupChainProbes(groupId, group, entryMembers, hostById, {
    ...options,
    templateRule: template,
    listenerPorts,
  });
}

function emptyForwardGroupProbeTopologyForHost(): ForwardGroupProbeTopologyForHost {
  return { chainGroups: [], chinaHealthProbes: [], entryHealthProbes: [], peerHealthProbes: [] };
}

/** 外部观察的参照目标：开了国内检测就用它的目标，否则用默认的 TCPing 目标。观察点连得上它才算「自己网络没问题」。 */
function peerReferenceTarget(group: LooseRow): ForwardGroupPeerGroupTopology["reference"] {
  const method = dbBool(group?.chinaHealthCheckEnabled) ? normalizeForwardGroupHealthCheckMethod(group.chinaHealthCheckMethod) : "tcp";
  try {
    const target = normalizeChinaHealthTarget(dbBool(group?.chinaHealthCheckEnabled) ? group.chinaHealthCheckTarget : "", method);
    return { targetIp: target.host, targetPort: target.port, method };
  } catch {
    return null;
  }
}

/*
  全站的转发组探测拓扑，一次建好按主机分好（P8）。以前每台主机每次完整心跳、每次健康上报都各读一遍
  所有启用的组 / 成员 / 主机，再挑出和自己有关的。现在整份缓存在内存里（forwardGroupProbeTopology），
  组 / 成员 / 主机地址变了立刻作废，另有 30 秒 TTL 兜底（规则监听端口、Agent 版本这类不逐个挂钩的变化）。

  里面四样：转发链各跳、国内健康检测、入口组自检、外部观察（别的机器探成员对外的入口端口）。
*/
async function buildForwardGroupProbeTopologySnapshot(): Promise<ForwardGroupProbeTopologySnapshot> {
  const snapshot: ForwardGroupProbeTopologySnapshot = { byHost: new Map(), peerByGroup: new Map(), peerOutdatedHostIdsByGroup: new Map(), hostNameById: new Map() };
  const db = await getDb();
  if (!db) return snapshot;
  const forHost = (hostId: number) => {
    let entry = snapshot.byHost.get(hostId);
    if (!entry) {
      entry = emptyForwardGroupProbeTopologyForHost();
      snapshot.byHost.set(hostId, entry);
    }
    return entry;
  };

  const groupRows = await db
    .select({
      id: forwardGroups.id,
      groupMode: forwardGroups.groupMode,
      entryGroupId: forwardGroups.entryGroupId,
      recordType: forwardGroups.recordType,
      chinaHealthCheckEnabled: forwardGroups.chinaHealthCheckEnabled,
      chinaHealthCheckTarget: forwardGroups.chinaHealthCheckTarget,
      // 健康检查方法（TCPing / Ping / UDP）：漏取的话下面一律按 TCPing 下发，组里选的 Ping、UDP 都不生效。
      chinaHealthCheckMethod: forwardGroups.chinaHealthCheckMethod,
      failoverSeconds: forwardGroups.failoverSeconds,
      recoverSeconds: forwardGroups.recoverSeconds,
      peerProbeEnabled: forwardGroups.peerProbeEnabled,
      peerObserverHostIds: forwardGroups.peerObserverHostIds,
      isEnabled: forwardGroups.isEnabled,
    })
    .from(forwardGroups)
    .where(and(
      eq(forwardGroups.isEnabled, true),
      or(isNull(forwardGroups.groupMode), notInArray(forwardGroups.groupMode, ["port", "exit"])),
    ))
    .orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id));
  if (groupRows.length === 0) return snapshot;

  const groupIds = (groupRows as any[]).map((group) => Number(group.id));
  const memberRows = await db
    .select()
    .from(forwardGroupMembers)
    .where(inArray(forwardGroupMembers.groupId, groupIds))
    .orderBy(asc(forwardGroupMembers.groupId), asc(forwardGroupMembers.priority));
  const tunnelIds = Array.from(new Set((memberRows as any[])
    .filter((member) => member?.memberType === "tunnel")
    .map((member) => Number(member?.tunnelId || 0))
    .filter((id) => id > 0)));
  const tunnelRows = tunnelIds.length > 0
    ? await db.select({ id: tunnels.id, entryHostId: tunnels.entryHostId })
      .from(tunnels)
      .where(inArray(tunnels.id, tunnelIds))
    : [];
  const tunnelEntryHostById = new Map<number, number>();
  for (const tunnel of tunnelRows as any[]) {
    tunnelEntryHostById.set(Number(tunnel.id), Number(tunnel.entryHostId || 0));
  }

  const membersByGroupId = new Map<number, LooseRow[]>();
  for (const member of memberRows as LooseRow[]) {
    const id = Number(member.groupId || 0);
    const members = membersByGroupId.get(id) || [];
    members.push(member);
    membersByGroupId.set(id, members);
  }
  const groups = (groupRows as LooseRow[]).map((group) => ({
    ...group,
    groupMode: forwardGroupModeOf(group),
    members: membersByGroupId.get(Number(group.id)) || [],
  }));
  const groupById = new Map<number, LooseRow>();
  for (const group of groups) groupById.set(Number(group.id), group);

  // 外部观察只对「成员不止一台、或者指定了观察主机」的主备组 / 入口组有意义。
  const peerGroups = groups.filter((group) => {
    if (!supportsChinaHealthMode(forwardGroupModeOf(group)) || !dbBool(group.peerProbeEnabled, true)) return false;
    const enabledCount = sortedMembers(group, true).length;
    return enabledCount >= 2 || (enabledCount >= 1 && parsePeerObserverHostIds(group.peerObserverHostIds).length > 0);
  });
  const explicitObserverIds = peerGroups.flatMap((group) => parsePeerObserverHostIds(group.peerObserverHostIds));

  const hostIds = Array.from(new Set([
    ...(memberRows as any[]).map((member) => Number(member?.hostId || 0)),
    ...Array.from(tunnelEntryHostById.values()),
    ...explicitObserverIds,
  ].filter((id) => id > 0)));
  const hostRows = hostIds.length > 0
    ? await db.select({
      id: hosts.id,
      name: hosts.name,
      entryIp: hosts.entryIp,
      tunnelEntryIp: hosts.tunnelEntryIp,
      ipv4: hosts.ipv4,
      ipv6: hosts.ipv6,
      ip: hosts.ip,
      ddnsEnabled: hosts.ddnsEnabled,
      ddnsDomain: hosts.ddnsDomain,
      agentVersion: hosts.agentVersion,
    }).from(hosts).where(inArray(hosts.id, hostIds))
    : [];
  const hostById = new Map<number, any>();
  for (const host of hostRows as LooseRow[]) {
    hostById.set(Number(host.id), host);
    snapshot.hostNameById.set(Number(host.id), String(host.name || `主机${host.id}`));
  }

  for (const group of groups) {
    if (forwardGroupModeOf(group) !== "chain") continue;
    const entryGroup = groupById.get(Number(group.entryGroupId || 0));
    const entryMembers = entryGroup && forwardGroupModeOf(entryGroup) === "entry" && dbBool(entryGroup.isEnabled)
      ? sortedMembers(entryGroup, true).filter((member: any) => member.memberType === "host")
      : [];
    const probes = await buildForwardGroupChainProbes(Number(group.id), group, entryMembers, hostById);
    for (const fromHostId of new Set(probes.map((probe) => Number(probe.fromHostId)))) {
      if (fromHostId > 0) forHost(fromHostId).chainGroups.push({ groupId: Number(group.id), probes });
    }
  }

  for (const group of groups) {
    if (forwardGroupModeOf(group) === "entry" && !dbBool(group.chinaHealthCheckEnabled)) {
      for (const member of sortedMembers(group, true) as any[]) {
        const memberHostId = Number(member.hostId || 0);
        if (member.memberType !== "host" || memberHostId <= 0) continue;
        forHost(memberHostId).entryHealthProbes.push({
          groupId: Number(group.id),
          memberId: Number(member.id),
          fromHostId: memberHostId,
          targetIp: "",
          targetPort: 0,
          method: "self",
          probeType: "entry",
          failoverSeconds: Math.max(10, Number(group.failoverSeconds || 60)),
          recoverSeconds: Math.max(10, Number(group.recoverSeconds || 120)),
        });
      }
      continue;
    }
    if (!supportsChinaHealthMode(forwardGroupModeOf(group)) || !dbBool(group.chinaHealthCheckEnabled)) continue;
    const healthMethod = normalizeForwardGroupHealthCheckMethod(group.chinaHealthCheckMethod);
    let target;
    try {
      target = normalizeChinaHealthTarget(group.chinaHealthCheckTarget, healthMethod);
    } catch (error) {
      appendPanelLog("warn", `[ForwardGroup] china health target invalid group=${group.id} target=${String(group.chinaHealthCheckTarget || "-")}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const member of sortedMembers(group, true) as any[]) {
      const entryHostId = member.memberType === "host"
        ? Number(member.hostId || 0)
        : tunnelEntryHostById.get(Number(member.tunnelId || 0)) || 0;
      if (entryHostId <= 0) continue;
      forHost(entryHostId).chinaHealthProbes.push({
        groupId: Number(group.id),
        memberId: Number(member.id),
        fromHostId: entryHostId,
        groupMode: forwardGroupModeOf(group) === "entry" ? "entry" : "failover",
        targetIp: target.host,
        targetPort: target.port,
        method: healthMethod,
        probeType: "china",
        failoverSeconds: Math.max(10, Number(group.failoverSeconds || 60)),
        recoverSeconds: Math.max(10, Number(group.recoverSeconds || 120)),
      });
    }
  }

  if (peerGroups.length > 0) {
    await buildForwardGroupPeerTopology(snapshot, { peerGroups, hostById, tunnelEntryHostById, forHost });
  }
  return snapshot;
}

/*
  不再安排的观察关系，结果表里的旧结论丢掉。只在一份拓扑真的留进缓存时做（TopologyCache 的 onCommit）：
  建到一半被作废的那份读的可能是改之前的数据，拿它来删会把新安排里还要用的结论删掉。
*/
function prunePeerObservationsToTopology(snapshot: ForwardGroupProbeTopologySnapshot) {
  forwardGroupPeerObservations.prune((observerHostId, groupId, memberId) => {
    const peer = snapshot.peerByGroup.get(groupId);
    if (!peer || !peer.observerHostIds.has(observerHostId)) return false;
    return memberId === PEER_REFERENCE_MEMBER_ID || !!peer.assignments.get(memberId)?.observerHostIds.includes(observerHostId);
  });
}

/*
  外部观察的安排：每个成员由别的机器来探它对外的入口地址和访客实际连的端口。

  端口从哪来：
    · 主备转发组：这个成员的子规则的监听端口（forwardGroupMemberId = 成员）。
    · 入口组：用这个入口组的隧道上的规则（每台入口都替它监听）+ 挂了这个入口组的端口转发 / 转发链
      铺在这台入口上的子规则。
  只算启用、在跑、没在删的规则；共享 TLS 入站的规则（sourcePort 是本机回环端口）不算。
  UDP 规则探 UDP（Agent 端说不准时退回 ping）；每个成员最多探 3 个端口。没有可探端口的成员不探。
*/
async function buildForwardGroupPeerTopology(
  snapshot: ForwardGroupProbeTopologySnapshot,
  input: {
    peerGroups: LooseRow[];
    hostById: Map<number, LooseRow>;
    tunnelEntryHostById: Map<number, number>;
    forHost: (hostId: number) => ForwardGroupProbeTopologyForHost;
  },
) {
  const db = await getDb();
  const { peerGroups, hostById, tunnelEntryHostById, forHost } = input;
  const entryGroupIds = peerGroups.filter((group) => forwardGroupModeOf(group) === "entry").map((group) => Number(group.id));
  const failoverGroupIds = peerGroups.filter((group) => forwardGroupModeOf(group) === "failover").map((group) => Number(group.id));
  const dependentRows = entryGroupIds.length > 0
    ? await db.select({ id: forwardGroups.id, entryGroupId: forwardGroups.entryGroupId }).from(forwardGroups)
      .where(and(eq(forwardGroups.isEnabled, true), inArray(forwardGroups.entryGroupId, entryGroupIds)))
    : [];
  const entryTunnelRows = entryGroupIds.length > 0
    ? await db.select({ id: tunnels.id, entryGroupId: tunnels.entryGroupId }).from(tunnels)
      .where(and(eq(tunnels.isEnabled, true), inArray(tunnels.entryGroupId, entryGroupIds)))
    : [];
  const entryGroupByDependentId = new Map<number, number>();
  for (const row of dependentRows as LooseRow[]) entryGroupByDependentId.set(Number(row.id), Number(row.entryGroupId || 0));
  const entryGroupByTunnelId = new Map<number, number>();
  for (const row of entryTunnelRows as LooseRow[]) entryGroupByTunnelId.set(Number(row.id), Number(row.entryGroupId || 0));

  const ruleGroupIds = [...failoverGroupIds, ...entryGroupByDependentId.keys()];
  const ruleTunnelIds = [...entryGroupByTunnelId.keys()];
  const ruleScope = [
    ...(ruleGroupIds.length > 0 ? [inArray(forwardRules.forwardGroupId, ruleGroupIds)] : []),
    ...(ruleTunnelIds.length > 0 ? [inArray(forwardRules.tunnelId, ruleTunnelIds)] : []),
  ];
  const ruleRows = ruleScope.length > 0
    ? await db.select({
      id: forwardRules.id,
      hostId: forwardRules.hostId,
      tunnelId: forwardRules.tunnelId,
      forwardGroupId: forwardRules.forwardGroupId,
      forwardGroupMemberId: forwardRules.forwardGroupMemberId,
      sourcePort: forwardRules.sourcePort,
      protocol: forwardRules.protocol,
      tlsInboundId: forwardRules.tlsInboundId,
    }).from(forwardRules).where(and(
      eq(forwardRules.isEnabled, true),
      eq(forwardRules.isRunning, true),
      eq(forwardRules.pendingDelete, false),
      eq(forwardRules.isForwardGroupTemplate, false),
      ruleScope.length === 1 ? ruleScope[0] : or(...ruleScope),
    ))
    : [];
  type Listener = { port: number; protocol: unknown };
  const failoverListenersByMemberId = new Map<number, Listener[]>();
  const entryListenersByGroupId = new Map<number, Listener[]>();
  const entryListenersByGroupHost = new Map<string, Listener[]>();
  const push = <K>(map: Map<K, Listener[]>, key: K, listener: Listener) => {
    const list = map.get(key);
    if (list) list.push(listener);
    else map.set(key, [listener]);
  };
  const failoverGroupIdSet = new Set(failoverGroupIds);
  for (const rule of ruleRows as LooseRow[]) {
    const port = Number(rule.sourcePort || 0);
    if (port <= 0 || Number(rule.tlsInboundId || 0) > 0) continue;
    const listener = { port, protocol: rule.protocol };
    const groupId = Number(rule.forwardGroupId || 0);
    const memberId = Number(rule.forwardGroupMemberId || 0);
    if (groupId > 0 && failoverGroupIdSet.has(groupId) && memberId > 0) push(failoverListenersByMemberId, memberId, listener);
    const dependentEntryGroupId = entryGroupByDependentId.get(groupId) || 0;
    if (dependentEntryGroupId > 0) push(entryListenersByGroupHost, `${dependentEntryGroupId}:${Number(rule.hostId || 0)}`, listener);
    const tunnelEntryGroupId = entryGroupByTunnelId.get(Number(rule.tunnelId || 0)) || 0;
    if (tunnelEntryGroupId > 0) push(entryListenersByGroupId, tunnelEntryGroupId, listener);
  }

  // 观察点要跑这一轮改造要求的 Agent（探测间隔按组的时间收紧、每分钟报一次全量）；老 Agent 的主机不当观察点。
  const capable = (hostId: number) => agentSupportsUnifiedBalance(String(hostById.get(hostId)?.agentVersion || ""));
  for (const group of peerGroups) {
    const groupId = Number(group.id);
    const mode = forwardGroupModeOf(group);
    const recordType = normalizeForwardGroupRecordType(group.recordType);
    const targets: PeerTargetMember[] = [];
    for (const member of sortedMembers(group, true) as LooseRow[]) {
      if (mode === "entry" && member.memberType !== "host") continue;
      const hostId = member.memberType === "host"
        ? Number(member.hostId || 0)
        : tunnelEntryHostById.get(Number(member.tunnelId || 0)) || 0;
      if (hostId <= 0) continue;
      const host = hostById.get(hostId);
      const listeners = mode === "entry"
        ? [...(entryListenersByGroupId.get(groupId) || []), ...(entryListenersByGroupHost.get(`${groupId}:${hostId}`) || [])]
        : failoverListenersByMemberId.get(Number(member.id)) || [];
      targets.push({
        memberId: Number(member.id),
        hostId,
        enabled: true,
        // 访客实际连的就是发布到解析里的那个值；没有（比如 AAAA 组里没 IPv6 的机器）退回入口地址。
        targetIp: ddnsValueForHostByRecordType(host, recordType) || entryAddressForHost(host),
        ports: selectPeerProbePorts(listeners),
      });
    }
    const explicitObservers = parsePeerObserverHostIds(group.peerObserverHostIds)
      .filter((hostId) => hostById.has(hostId))
      .map((hostId) => ({ hostId, capable: capable(hostId) }));
    const assignments = planPeerObservers({
      members: targets,
      capableHostIds: new Set(targets.map((target) => target.hostId).filter(capable)),
      explicitObservers,
    });
    const outdatedHostIds = Array.from(new Set([...targets.map((target) => target.hostId), ...explicitObservers.map((observer) => observer.hostId)]))
      .filter((hostId) => !capable(hostId));
    if (outdatedHostIds.length > 0) snapshot.peerOutdatedHostIdsByGroup.set(groupId, outdatedHostIds);
    if (assignments.length === 0) continue;
    const failoverSeconds = Math.max(10, Number(group.failoverSeconds || 60));
    const recoverSeconds = Math.max(10, Number(group.recoverSeconds || 120));
    const peer: ForwardGroupPeerGroupTopology = {
      groupId,
      failoverSeconds,
      recoverSeconds,
      reference: peerReferenceTarget(group),
      assignments: new Map(assignments.map((assignment) => [assignment.memberId, assignment])),
      observerHostIds: new Set(assignments.flatMap((assignment) => assignment.observerHostIds)),
    };
    snapshot.peerByGroup.set(groupId, peer);
    for (const assignment of assignments) {
      for (const observerHostId of assignment.observerHostIds) {
        for (const port of assignment.ports) {
          forHost(observerHostId).peerHealthProbes.push({
            groupId,
            memberId: assignment.memberId,
            fromHostId: observerHostId,
            targetIp: assignment.targetIp,
            targetPort: port.port,
            method: port.method,
            probeType: "peer",
            failoverSeconds,
            recoverSeconds,
          });
        }
      }
    }
    if (peer.reference) {
      for (const observerHostId of peer.observerHostIds) {
        forHost(observerHostId).peerHealthProbes.push({
          groupId,
          memberId: PEER_REFERENCE_MEMBER_ID,
          fromHostId: observerHostId,
          targetIp: peer.reference.targetIp,
          targetPort: peer.reference.targetPort,
          method: peer.reference.method,
          probeType: "peer",
          failoverSeconds,
          recoverSeconds,
        });
      }
    }
  }
}

const FORWARD_GROUP_PROBE_TOPOLOGY_TTL_MS = 30_000;

export const forwardGroupProbeTopology = new TopologyCache(buildForwardGroupProbeTopologySnapshot, FORWARD_GROUP_PROBE_TOPOLOGY_TTL_MS, Date.now, prunePeerObservationsToTopology);

/** 组、成员、主机地址改了：探测拓扑立刻作废（下一次心跳 / 上报 / 评估重建）。 */
export function invalidateForwardGroupProbeTopology() {
  forwardGroupProbeTopology.invalidate();
}

/** 改组 / 改成员的函数收尾时调：现在作废一次；还在事务里的话，事务结束后再作废一次（期间重建的那份读的可能是提交前的数据）。 */
export function invalidateForwardGroupProbeTopologyAfterChange() {
  forwardGroupProbeTopology.invalidate();
  if (isDatabaseTransactionActive()) {
    void afterDatabaseTransactionSettled(() => { forwardGroupProbeTopology.invalidate(); }).catch(() => undefined);
  }
}

export async function getForwardGroupProbeTopologyForHost(hostId: number): Promise<ForwardGroupProbeTopologyForHost> {
  const currentHostId = Number(hostId || 0);
  if (!Number.isInteger(currentHostId) || currentHostId <= 0) return emptyForwardGroupProbeTopologyForHost();
  const snapshot = await forwardGroupProbeTopology.get();
  return snapshot.byHost.get(currentHostId) || emptyForwardGroupProbeTopologyForHost();
}

/** 观察点自己在不在线：支持外部观察的 Agent 都带快速存活上报，只认那个信号。 */
export function peerObserverOnline(hostId: number) {
  const state = getPresenceCapableHostLivenessSnapshot(hostId);
  return !!state && !state.confirmedOffline;
}
