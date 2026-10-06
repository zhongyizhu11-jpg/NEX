import { normalizeForwardRuleProtocol, type ForwardRuleProtocol } from "../shared/forwardTypes";
import { getHostEntryAddress } from "../shared/hostEntryAddress";
import {
  legacyFailoverFields,
  routeGroupOf,
  routePathDestination,
  routePathLabel,
  routePathsOf,
  serializeRoutePaths,
  type RouteEndpoint,
  type RouteGroup,
  type RouteGroupRule,
  type RoutePath,
} from "../shared/routeGroup";
import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh } from "./agentEvents";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { reserveAvailableHostPort, reserveSpecificHostPort, type HostPortReservation } from "./portReservations";
import {
  createForwardRule,
  deleteForwardRuleRouteEvents,
  getAllRouteRelayRules,
  getForwardRuleById,
  getForwardRulesByIds,
  getRouteRelayRules,
  markForwardRulePendingDelete,
  updateForwardRule,
} from "./repositories/forwardRuleRepository";
import { getUserPlanPortRange } from "./repositories/billingRepository";
import { getHostNamesByIds, getHostsByIds } from "./repositories/hostRepository";
import { getUserById } from "./repositories/userRepository";
import { dbBool } from "./repositories/repositoryUtils";
import { findAvailablePort, getTunnelById, getTunnelExitNodes, isPortUsedOnHost } from "./repositories/tunnelRepository";
import { forgetRouteStats, recordRouteHopProbe } from "./routeGroupStats";

/*
  线路组的中转：面板替用户在中转机上建规则。

  一条路径「HK01 → JP01 → SG01 → 落地」对入口 Agent 来说只是「拨 JP01 的某个端口」。
  JP01 上得有一条规则把这个端口转到 SG01，SG01 上再有一条转到落地 —— 这两条就是这里
  生成的中继规则（forward_rules.routeParentRuleId 指回线路组那条规则）。它们是普通的
  GOST 直连 TCP 规则：中转机的 Agent 像跑别的规则一样跑它、像探别的规则一样探它的
  目标，探测结果回来就是「这一跳通不通」（见 routeGroupStats）。

  几条定死的规矩：

  · 中继规则**不进用户的列表、不算规则数、不计流量**（流量在入口那条上已经算过了）。
    见 getForwardRules / getUserRuleCount / shouldAccountForwardRuleTraffic 里的过滤。
    但**算端口配额**（getUserPortCount）：它们是在中转机上真实开出来的监听。
  · 端口在中转机上按它自己的端口策略挑（普通用户再收窄到他在那台机器上的套餐端口区间）；
    挑好之后尽量不换 —— 换端口等于上一跳也要改，两台机器一起重启转发。
  · 从落地往回解析：最后一跳先定（它的目标就是落地），前一跳的目标才是它的入口地址加
    端口。哪一跳解析不出来（中转不存在、没有入口地址、没有端口可用）整条路径就标成
    不可用（path.issue），不建半截：半截的路径入口 Agent 拨得通第一跳，却永远到不了落地，
    健康检查会把它当成好线路。
  · 路径不要了、规则删了、主备关了，对应的中继规则走 pendingDelete，等中转机的 Agent
    确认停掉再真正删行 —— 和转发链的子规则一样。

  改完会把每条路径的 dial（入口 Agent 该拨的地址）和 issue 写回 routePaths，并同步派生的
  failoverTargets：老 Agent 只认那一列。
*/

const RELAY_NAME_LIMIT = 128;

type RelayRuleRow = any;

type ResolvedHop = {
  hostId: number;
  host: any;
  hopIndex: number;
  /** 这一跳的中继规则监听的端口（在这台中转机上） */
  port: number;
  /** 这一跳把流量转到哪里：下一跳中转的入口地址，或者落地 */
  target: RouteEndpoint;
  existing: RelayRuleRow | null;
  reservation: HostPortReservation | null;
};

type PathPlan = {
  path: RoutePath;
  index: number;
  hops: ResolvedHop[];
  dial: RouteEndpoint | null;
  issue: string | null;
};

export type SyncRouteRelayOptions = {
  reason?: string;
  /** 只落库不推 Agent（批量、启动修复时由调用方统一推）。 */
  deferRefresh?: boolean;
};

export type SyncRouteRelayResult = {
  ruleId: number;
  paths: RoutePath[] | null;
  created: number;
  updated: number;
  retired: number;
  /** 这次动到的中转机 + 入口机 */
  touchedHostIds: number[];
};

function relayKey(pathKey: unknown, hopIndex: unknown) {
  return `${String(pathKey || "")}:${Math.max(0, Math.floor(Number(hopIndex) || 0))}`;
}

function hostLabel(host: any, hostId: number) {
  return String(host?.name || "").trim() || `主机 ${hostId}`;
}

function relayRuleName(rule: any, path: RoutePath, index: number, hopIndex: number, total: number) {
  const name = `[线路组:${String(rule?.name || "").trim() || `规则 ${rule?.id}`}] ${routePathLabel(path, index)} ${hopIndex + 1}/${total}`;
  return name.length > RELAY_NAME_LIMIT ? name.slice(0, RELAY_NAME_LIMIT) : name;
}

/**
 * 中继规则转哪种协议：跟着父规则走。UDP 线路组的路径要一路 UDP 过去，TCP+UDP 的两样都转。
 * 中继永远是 gost（它 TCP、UDP 都转，也不需要调度器 —— 中转机上没有「挑路径」这一步）。
 */
function relayProtocol(rule: any): ForwardRuleProtocol {
  return normalizeForwardRuleProtocol(rule?.protocol);
}

/**
 * 中继规则的主人（线路组那条规则的主人）在这台中转机上的套餐端口区间。管理员、没有套餐区间的
 * 返回空数组（不限）。
 *
 * 中继是替用户在中转机上开的监听，和他自己在那台机器上建规则占的是同一类端口：以前按中转机的
 * 整段端口策略随便挑，一个租户能在套餐给他的区间之外开出监听，挤占别人的端口。
 */
async function relayPlanPortRanges(rule: any, hostId: number): Promise<Array<{ start: number; end: number }>> {
  const userId = Number(rule?.userId || 0);
  if (userId <= 0) return [];
  const owner = await getUserById(userId) as any;
  if (!owner || String(owner.role || "") === "admin") return [];
  const planRange = await getUserPlanPortRange(userId, hostId);
  return planRange?.ranges || [];
}

async function pickRelayPort(
  hostId: number,
  existing: RelayRuleRow | null,
  protocol: ForwardRuleProtocol,
  allowedRanges: Array<{ start: number; end: number }> = [],
): Promise<HostPortReservation | null> {
  const excludeIds = existing ? [Number(existing.id)] : [];
  const inPlanRange = (port: number) => allowedRanges.length === 0
    || allowedRanges.some((range) => port >= range.start && port <= range.end);
  if (existing && Number(existing.sourcePort) > 0 && Number(existing.hostId) === hostId && inPlanRange(Number(existing.sourcePort))) {
    const preserved = await reserveSpecificHostPort({
      hostId,
      port: Number(existing.sourcePort),
      protocol,
      isUsed: (port) => isPortUsedOnHost(hostId, port, excludeIds, protocol, undefined, false),
    });
    if (preserved) return preserved;
  }
  return reserveAvailableHostPort({
    hostId,
    protocol,
    findPort: (reservedPorts) => findAvailablePort(hostId, null, null, protocol, reservedPorts, excludeIds, allowedRanges),
    isUsed: (port) => isPortUsedOnHost(hostId, port, excludeIds, protocol, undefined, false),
  });
}

function relayPayload(rule: any, plan: PathPlan, hop: ResolvedHop, parentEnabled: boolean) {
  return {
    hostId: hop.hostId,
    name: relayRuleName(rule, plan.path, plan.index, hop.hopIndex, plan.hops.length),
    forwardType: "gost",
    protocol: relayProtocol(rule),
    gostMode: "direct",
    gostRelayHost: null,
    gostRelayPort: null,
    tunnelId: null,
    tunnelExitPort: null,
    forwardGroupId: null,
    forwardGroupRuleId: null,
    forwardGroupMemberId: null,
    isForwardGroupTemplate: false,
    sourcePort: hop.port,
    targetIp: hop.target.ip,
    targetPort: hop.target.port,
    telegramErrorNotifyEnabled: dbBool(rule?.telegramErrorNotifyEnabled),
    blockHttp: false,
    blockSocks: false,
    blockTls: false,
    proxyProtocolReceive: false,
    proxyProtocolSend: false,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: 1,
    tcpFastOpen: false,
    zeroCopy: false,
    udpOverTcp: false,
    udpOverTcpPort: null,
    failoverEnabled: false,
    failoverStrategy: "fallback",
    failoverTargets: null,
    failoverProbeTarget: null,
    failoverSchedule: null,
    failoverMinHoldSeconds: 0,
    failoverPinnedIndex: null,
    failoverPinnedUntil: null,
    failoverPreferFastest: false,
    failoverSeconds: 60,
    recoverSeconds: 120,
    autoFailback: true,
    routeMode: null,
    routePaths: null,
    routeParentRuleId: Number(rule.id),
    routePathKey: plan.path.key,
    routeHopIndex: hop.hopIndex,
    isEnabled: parentEnabled,
    disabledByUser: false,
    disabledByTunnel: false,
    disabledByGroup: false,
    protocolBlockReason: null,
    pendingDelete: false,
    userId: Number(rule.userId),
  };
}

/** 这几样一变，中转机上的转发得重启；别的（名字、TG 提醒）改了只是元数据。 */
const RELAY_RUNTIME_FIELDS = ["hostId", "sourcePort", "targetIp", "targetPort", "protocol", "isEnabled", "routePathKey", "routeHopIndex"] as const;
const RELAY_META_FIELDS = ["name", "telegramErrorNotifyEnabled", "userId", "routeParentRuleId"] as const;

function sameValue(left: unknown, right: unknown) {
  if (typeof left === "boolean" || typeof right === "boolean") return dbBool(left) === dbBool(right);
  if (left === null || left === undefined) return right === null || right === undefined || right === "";
  return String(left) === String(right);
}

async function resolvePath(rule: any, path: RoutePath, index: number, hostById: Map<number, any>, liveByKey: Map<string, RelayRuleRow>): Promise<PathPlan> {
  const plan: PathPlan = { path, index, hops: [], dial: null, issue: null };
  if (path.hops.length === 0) {
    // 没有中转：入口直接拨落地，routePathDial 读的时候自己算，这里不存 dial。
    return plan;
  }
  const dest = routePathDestination(path, rule as RouteGroupRule);
  if (!dest.ip || !(dest.port > 0)) {
    plan.issue = "落地地址还没填";
    return plan;
  }
  // 从最后一跳往回：每一跳的目标是它后面那一跳的入口地址 + 监听端口。
  let next: RouteEndpoint = dest;
  const resolved: ResolvedHop[] = [];
  for (let hopIndex = path.hops.length - 1; hopIndex >= 0; hopIndex -= 1) {
    const hostId = Number(path.hops[hopIndex]);
    const host = hostById.get(hostId);
    if (!host) {
      plan.issue = `第 ${hopIndex + 1} 跳的中转主机已经不在了`;
      break;
    }
    const entry = getHostEntryAddress(host);
    if (!entry) {
      plan.issue = `中转「${hostLabel(host, hostId)}」没有入口地址`;
      break;
    }
    const existing = liveByKey.get(relayKey(path.key, hopIndex)) || null;
    const planRanges = await relayPlanPortRanges(rule, hostId);
    const reservation = await pickRelayPort(hostId, existing, relayProtocol(rule), planRanges);
    if (!reservation) {
      plan.issue = planRanges.length > 0
        ? `中转「${hostLabel(host, hostId)}」在套餐端口区间内没有可用端口`
        : `中转「${hostLabel(host, hostId)}」的端口区间内没有可用端口`;
      break;
    }
    resolved.push({ hostId, host, hopIndex, port: reservation.port, target: next, existing, reservation });
    next = { ip: entry, port: reservation.port };
  }
  if (plan.issue) {
    for (const hop of resolved) hop.reservation?.release();
    return plan;
  }
  resolved.reverse();
  plan.hops = resolved;
  plan.dial = next;
  return plan;
}

async function retireRelayRows(rows: RelayRuleRow[], touched: Set<number>) {
  let retired = 0;
  for (const row of rows) {
    if (dbBool(row?.pendingDelete)) continue;
    await markForwardRulePendingDelete(Number(row.id));
    touched.add(Number(row.hostId));
    retired += 1;
  }
  return retired;
}

async function refreshTouchedHosts(rule: any, touched: Set<number>, reason: string) {
  const hostIds = new Set<number>(touched);
  if (rule) {
    hostIds.add(Number(rule.hostId));
    const tunnelId = Number(rule.tunnelId || 0);
    if (tunnelId > 0) {
      const tunnel = await getTunnelById(tunnelId).catch(() => null) as any;
      if (tunnel) {
        hostIds.add(Number(tunnel.entryHostId));
        hostIds.add(Number(tunnel.exitHostId));
        // 负载均衡的出口节点上也各跑一个调度器（GOST、NEX 隧道），路径的拨号地址变了它们也要刷新。
        for (const node of await getTunnelExitNodes(tunnelId).catch(() => [])) hostIds.add(Number((node as any)?.hostId || 0));
      }
    }
  }
  for (const hostId of hostIds) {
    if (hostId > 0) pushAgentRefresh(hostId, reason, { urgent: true });
  }
}

/**
 * 把一条规则的路径清单落实到中转机上：缺的建、变的改、多的收，再把 dial / issue 写回。
 *
 * 规则保存之后、主机入口地址变了之后、面板启动修复时都走这里。幂等：路径没变就什么都
 * 不写（连 updatedAt 都不碰）。
 */
export async function syncRouteRelayRulesForRule(ruleId: number, options: SyncRouteRelayOptions = {}): Promise<SyncRouteRelayResult> {
  const id = Math.floor(Number(ruleId) || 0);
  const reason = String(options.reason || "route-group-sync").trim() || "route-group-sync";
  return withKeyedTaskLock(`route-relays:${id}`, async () => {
    const rule = await getForwardRuleById(id) as any;
    const relays = await getRouteRelayRules(id) as RelayRuleRow[];
    const live = relays.filter((row) => !dbBool(row.pendingDelete));
    const touched = new Set<number>();
    const result: SyncRouteRelayResult = { ruleId: id, paths: null, created: 0, updated: 0, retired: 0, touchedHostIds: [] };

    const group = rule && !dbBool(rule.pendingDelete) ? routeGroupOf(rule as RouteGroupRule) : null;
    if (!group) {
      result.retired = await retireRelayRows(live, touched);
      if (result.retired > 0 && !options.deferRefresh) await refreshTouchedHosts(rule, touched, `${reason}-retired`);
      result.touchedHostIds = Array.from(touched);
      return result;
    }

    const paths = group.paths.map((path) => ({ ...path, hops: [...path.hops] }));
    const hopIds = Array.from(new Set(paths.flatMap((path) => path.hops)));
    const hosts = hopIds.length > 0 ? await getHostsByIds(hopIds) : [];
    const hostById = new Map((hosts as any[]).map((host) => [Number(host.id), host]));
    const liveByKey = new Map(live.map((row) => [relayKey(row.routePathKey, row.routeHopIndex), row]));
    const parentEnabled = dbBool(rule.isEnabled);
    const keep = new Set<string>();
    const plans: PathPlan[] = [];
    try {
      for (const [index, path] of paths.entries()) {
        const plan = await resolvePath(rule, path, index, hostById, liveByKey);
        plans.push(plan);
        path.dial = plan.dial;
        path.issue = plan.issue;
        if (plan.issue) {
          appendPanelLog("warn", `[RouteGroup] rule=${id} path=${path.key} 路径不可用: ${plan.issue}`);
        }
        for (const hop of plan.hops) {
          const key = relayKey(path.key, hop.hopIndex);
          keep.add(key);
          const payload = relayPayload(rule, plan, hop, parentEnabled);
          if (hop.existing) {
            const runtimeChanged = RELAY_RUNTIME_FIELDS.some((field) => !sameValue((payload as any)[field], hop.existing[field]));
            const metaChanged = RELAY_META_FIELDS.some((field) => !sameValue((payload as any)[field], hop.existing[field]));
            if (runtimeChanged) {
              await updateForwardRule(Number(hop.existing.id), { ...payload, isRunning: false } as any);
              touched.add(Number(hop.existing.hostId));
              touched.add(hop.hostId);
              result.updated += 1;
            } else if (metaChanged) {
              await updateForwardRule(Number(hop.existing.id), payload as any);
              result.updated += 1;
            }
          } else {
            await createForwardRule({ ...payload, isRunning: false } as any);
            touched.add(hop.hostId);
            result.created += 1;
          }
        }
      }
    } finally {
      for (const plan of plans) for (const hop of plan.hops) hop.reservation?.release();
    }

    // 路径删了、跳数少了、解析不出来的：对应的中继规则收回。
    const stale = live.filter((row) => !keep.has(relayKey(row.routePathKey, row.routeHopIndex)));
    result.retired = await retireRelayRows(stale, touched);

    // dial / issue 写回；派生的 failoverTargets 跟着 dial 走（老 Agent 只认它）。
    const nextGroup: RouteGroup = { paths, policy: group.policy };
    const legacy = legacyFailoverFields(nextGroup, rule as RouteGroupRule);
    const patch: Record<string, unknown> = {
      routePaths: serializeRoutePaths(paths),
      failoverTargets: legacy.failoverTargets,
      failoverProbeTarget: legacy.failoverProbeTarget,
    };
    const changed = Object.entries(patch).some(([field, value]) => !sameValue(value, rule[field]));
    if (changed) {
      await updateForwardRule(id, patch as any);
      touched.add(Number(rule.hostId));
    }
    result.paths = paths;
    result.touchedHostIds = Array.from(touched);
    if (!options.deferRefresh && (changed || result.created > 0 || result.updated > 0 || result.retired > 0)) {
      await refreshTouchedHosts(rule, touched, reason);
    }
    return result;
  });
}

/** 规则删了：中转上的中继规则跟着走，切换记录一并清掉。 */
export async function retireRouteRelayRulesForRule(ruleId: number, options: SyncRouteRelayOptions & { dropEvents?: boolean } = {}) {
  const id = Math.floor(Number(ruleId) || 0);
  const reason = String(options.reason || "route-group-deleted").trim() || "route-group-deleted";
  return withKeyedTaskLock(`route-relays:${id}`, async () => {
    const relays = await getRouteRelayRules(id) as RelayRuleRow[];
    const touched = new Set<number>();
    const retired = await retireRelayRows(relays, touched);
    if (options.dropEvents !== false) await deleteForwardRuleRouteEvents(id);
    forgetRouteStats(id);
    if (retired > 0 && !options.deferRefresh) {
      for (const hostId of touched) pushAgentRefresh(hostId, reason, { urgent: true });
    }
    return { retired, touchedHostIds: Array.from(touched) };
  });
}

/** 这台机器上有没有中继规则；有的话它的入口地址一变，上一跳的目标要跟着改。 */
export async function syncRouteRelayRulesForHost(hostId: number, options: SyncRouteRelayOptions = {}) {
  const id = Math.floor(Number(hostId) || 0);
  if (id <= 0) return { parents: [] as number[] };
  const relays = await getAllRouteRelayRules() as RelayRuleRow[];
  const parents = Array.from(new Set(relays
    .filter((row) => Number(row.hostId) === id && !dbBool(row.pendingDelete))
    .map((row) => Number(row.routeParentRuleId))
    .filter((parent) => parent > 0)));
  for (const parent of parents) {
    await syncRouteRelayRulesForRule(parent, { ...options, reason: options.reason || "route-relay-host-address" }).catch((error) => {
      appendPanelLog("warn", `[RouteGroup] host=${id} rule=${parent} 中转地址同步失败: ${String((error as any)?.message || error)}`);
    });
  }
  return { parents };
}

/**
 * 启动修复：父规则没了的中继规则收回；还在的父规则重新对一遍（面板上次关掉时可能正好
 * 保存到一半）。
 */
export async function repairRouteRelayRuleIntegrity() {
  const relays = await getAllRouteRelayRules() as RelayRuleRow[];
  const byParent = new Map<number, RelayRuleRow[]>();
  for (const row of relays) {
    const parent = Number(row.routeParentRuleId || 0);
    if (parent <= 0) continue;
    const rows = byParent.get(parent) || [];
    rows.push(row);
    byParent.set(parent, rows);
  }
  let orphans = 0;
  let synced = 0;
  for (const [parent, rows] of byParent) {
    const rule = await getForwardRuleById(parent).catch(() => null) as any;
    if (!rule || dbBool(rule.pendingDelete)) {
      const touched = new Set<number>();
      orphans += await retireRelayRows(rows, touched);
      for (const hostId of touched) pushAgentRefresh(hostId, "route-relay-orphan", { urgent: true });
      continue;
    }
    await syncRouteRelayRulesForRule(parent, { reason: "route-relay-startup" });
    synced += 1;
  }
  return { orphans, synced };
}

/**
 * 线路组 → 老 failover* 列，按库里的类型：failoverPinnedUntil 是时间列，shared 那份给的是毫秒。
 * 保存规则和写回 dial 都用它，别再各自换算一遍。
 */
export function legacyFailoverColumns(group: RouteGroup, rule: Pick<RouteGroupRule, "targetIp" | "targetPort">) {
  const legacy = legacyFailoverFields(group, rule);
  return {
    ...legacy,
    failoverPinnedUntil: legacy.failoverPinnedUntil ? new Date(legacy.failoverPinnedUntil) : null,
  };
}

/** 一条规则的中继规则按 `${pathKey}:${hopIndex}` 索引，给状态接口和探测入库用。 */
export async function routeRelayRulesByKey(ruleId: number) {
  const relays = await getRouteRelayRules(ruleId) as RelayRuleRow[];
  return new Map(relays.filter((row) => !dbBool(row.pendingDelete)).map((row) => [relayKey(row.routePathKey, row.routeHopIndex), row]));
}

/**
 * 中转机报上来的规则探测里，属于中继规则的那些就是「这一跳通不通」。
 *
 * 中继规则是普通规则，中转机的 Agent 一分钟探一次它的目标（下一跳，或者落地），结果走
 * /api/agent/tcping 的 results 回来 —— 不用给 Agent 加协议。这里只认这台机器自己的中继
 * 规则（rule.hostId 就是报告的机器），别的机器报的不收。
 *
 * 某条路径「断了 / 通了」翻转的那一刻，立刻推一次入口 Agent：它拿到 down 提示会马上
 * 把这条路径标成不可用（或恢复），不等下一轮整份心跳。
 */
export async function ingestRouteHopProbeReports(input: {
  hostId: number;
  hostName: string;
  results: Array<{ ruleId: number; latencyMs?: number | null; isTimeout?: boolean; probeSuccesses?: number }>;
  rulesById: Map<number, any>;
  nowMs?: number;
}) {
  const hostId = Number(input.hostId);
  const nowMs = input.nowMs ?? Date.now();
  const relayReports = input.results.filter((report) => {
    const rule = input.rulesById.get(Number(report.ruleId));
    return rule
      && Number(rule.routeParentRuleId || 0) > 0
      && Number(rule.hostId) === hostId
      && !dbBool(rule.pendingDelete);
  });
  if (relayReports.length === 0) return { recorded: 0, flipped: [] as number[] };

  const parentIds = Array.from(new Set(relayReports.map((report) => Number(input.rulesById.get(Number(report.ruleId)).routeParentRuleId))));
  const parents = await getForwardRulesByIds(parentIds) as any[];
  const parentById = new Map(parents.map((rule) => [Number(rule.id), rule]));
  const pathsByParent = new Map<number, RoutePath[]>();
  const nextHostIds = new Set<number>();
  for (const report of relayReports) {
    const relay = input.rulesById.get(Number(report.ruleId));
    const parent = parentById.get(Number(relay.routeParentRuleId));
    if (!parent) continue;
    const paths = pathsByParent.get(Number(parent.id)) || routePathsOf(parent as RouteGroupRule);
    pathsByParent.set(Number(parent.id), paths);
    const path = paths.find((item) => item.key === String(relay.routePathKey || ""));
    const next = path?.hops[Number(relay.routeHopIndex) + 1];
    if (next) nextHostIds.add(Number(next));
  }
  const names = nextHostIds.size > 0 ? await getHostNamesByIds(Array.from(nextHostIds)) : new Map<number, string>();

  let recorded = 0;
  const flipped = new Map<number, boolean>();
  for (const report of relayReports) {
    const relay = input.rulesById.get(Number(report.ruleId));
    const parentId = Number(relay.routeParentRuleId);
    const parent = parentById.get(parentId);
    if (!parent) continue;
    const paths = pathsByParent.get(parentId) || [];
    const path = paths.find((item) => item.key === String(relay.routePathKey || ""));
    const hopIndex = Math.max(0, Math.floor(Number(relay.routeHopIndex) || 0));
    const nextId = path?.hops[hopIndex + 1];
    const nextLabel = nextId ? (names.get(Number(nextId)) || `主机 ${nextId}`) : "落地";
    const ok = !report.isTimeout && Number(report.probeSuccesses ?? 1) > 0;
    const latency = typeof report.latencyMs === "number" && Number.isFinite(report.latencyMs) && report.latencyMs >= 0 ? report.latencyMs : null;
    const result = recordRouteHopProbe({
      parentRuleId: parentId,
      pathKey: String(relay.routePathKey || ""),
      hopIndex,
      hostId,
      hostName: input.hostName,
      nextLabel,
      ok,
      latencyMs: ok ? latency : null,
      nowMs,
    });
    recorded += 1;
    if (result.downChanged) flipped.set(parentId, result.down);
  }
  for (const [parentId, down] of flipped) {
    const parent = parentById.get(parentId);
    appendPanelLog(down ? "warn" : "info", `[RouteGroup] rule=${parentId} 中转跳${down ? "断了" : "恢复"}: host=${hostId} ${input.hostName}`);
    await refreshTouchedHosts(parent, new Set<number>(), down ? "route-hop-down" : "route-hop-recovered");
  }
  return { recorded, flipped: Array.from(flipped.keys()) };
}
