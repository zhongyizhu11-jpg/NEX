/*
  转发组的子规则同步：照模板规则给每个成员建 / 改 / 删子规则（端口、线路、主备策略、链式组每一跳的监听），
  能热更新的不重建、在跑的不打断，删除时先结算流量再标待删。组的增删改（forwardGroupRepository.ts）和
  评估都通过 syncForwardGroupRules 进来。
*/

import { normalizeSourcePortEnd } from "../../shared/portRange";
import { ROUTE_POLICY_RULE_FIELDS } from "../../shared/routePolicyFields";
import { NO_EGRESS_COLUMNS, ruleEgressColumnsOf } from "../../shared/ssEgress";
import { forwardGroupModeOf } from "../../shared/forwardTypes";
import { and, eq, inArray } from "drizzle-orm";
import { forwardGroupMembers, forwardGroups, forwardRules } from "../../drizzle/schema";
import { pushAgentRefresh } from "../agentEvents";
import { appendPanelLog } from "../_core/panelLogger";
import {
  afterDatabaseCommit,
  afterDatabaseTransactionSettled,
  getDb,
  isDatabaseTransactionActive,
  nowDate,
  withDatabaseTransaction,
} from "../dbRuntime";
import {
  createForwardRule,
  getForwardGroupChildRules,
  getForwardGroupTemplateRules,
  getForwardRuleById,
  finalizeForwardRuleDelete,
  getForwardRulesByTunnel,
  markForwardRulePendingDelete,
  updateForwardRule,
} from "../repositories/forwardRuleRepository";
import { getHostById } from "../repositories/hostRepository";
import {
  ensureTunnelListenerPortPolicy,
  findAvailablePort,
  getTunnelById,
  isPortUsedOnHost,
  reconcileForwardRuleTunnelExits,
  reserveTunnelExitPort,
  updateTunnel,
  usesSharedTunnelPrimaryListener,
} from "../repositories/tunnelRepository";
import { findTrafficBillingResourceForRule, settleTrafficBillingRuleOnDelete, trafficBillingResourceCandidatesForRule } from "../repositories/trafficBillingRepository";
import { isPortAllowedByPolicy } from "@shared/portPolicy";
import { withKeyedTaskLock, withTrafficBillingUserLock } from "../keyedTaskLock";
import {
  isHostPortReservationHeldByCaller,
  releaseHostPortReservations,
  reserveAvailableHostPort,
  reserveSpecificHostPort,
  tryReserveHostPort,
  type HostPortReservation,
} from "../portReservations";
import { repairPortForwardRuleHostReferences } from "../portForwardRuleHosts";
import { dbBool } from "../repositories/repositoryUtils";
import { isSniGroupTemplate, planSniChild, syncSniChildNames } from "../sniGroupChildren";
import { MAX_FORWARD_GROUP_MEMBERS } from "../../shared/forwardGroup";
import { parseRoutePaths, routeGroupForwardTypeSupported, routeGroupTunnelModeSupported, serializeRoutePaths, type RoutePath } from "../../shared/routeGroup";
import { parseRouteLines, serializeRouteLines } from "../../shared/routeLines";
import { entryGroupMembersFor, isCollectionGroupMode, memberEntryHostId, memberListenHostIds, normalizeRuntimeForwardType, sortedMembers, toDate } from "./common";
import { getForwardGroupById, normalizeRuleProtocol, resolveChainConnectHost } from "../repositories/forwardGroupRepository";
import { assertEntryPortAllowed, entryPortPolicyForMember, isPortUsedOnHostForGroupChild } from "./portPolicy";
import { forwardGroupRuntimeDependenciesEnabled, handleTrafficBillingShortfallLazily, refreshControlledForwardRules, refreshForwardChainRuntime, refreshRuleEndpoints } from "./runtime";

export async function settleAndMarkForwardGroupRulePendingDelete(
  rule: any,
  resource?: { resourceType: any; resourceId: number } | null,
) {
  return withTrafficBillingUserLock(rule?.userId, async () => {
    const billed = resource
      ? await settleTrafficBillingRuleOnDelete({
        userId: Number(rule?.userId || 0),
        ruleId: Number(rule?.id || 0),
        resourceType: resource.resourceType,
        resourceId: Number(resource.resourceId || 0),
      })
      : null;
    await markForwardRulePendingDelete(Number(rule?.id || 0));
    return billed;
  });
}

type SyncForwardGroupRulesOptions = {
  validatePorts?: boolean;
  createMissing?: boolean;
  preserveRuntime?: boolean;
  deferRefresh?: boolean;
};

function nullableNumber(value: unknown) {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function nullableString(value: unknown) {
  const text = String(value || "").trim();
  return text || null;
}

/** 人工指定钉的是第几条：0 是主线路（也是钉住），空 / 负数才是没钉。 */
function pinIndexOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * 线路的调度设置跟着模板走：人工指定（钉哪条、到几点）、按时段、最短驻留、只走最快、自定义探测目标。
 *
 * 跑的是每台成员机上的子规则，Agent 只看子规则。以前子规则只抄了策略、路径、切换时间这几列，
 * 这几列没抄：在模板上「切到这条」「按时段」存进去了、界面也照着模板写「人工指定」，机器照旧按自动选
 * （2.3.522 线上「切到备用 1 还是走主线路」就是这个）。子规则不做主备时一律清掉。
 */
function childRoutePolicyColumns(templateRule: Record<string, unknown> | null | undefined, childFailoverEnabled: boolean) {
  if (!childFailoverEnabled) {
    return {
      failoverPinnedIndex: null,
      failoverPinnedUntil: null,
      failoverSchedule: null,
      failoverMinHoldSeconds: 0,
      failoverPreferFastest: false,
      failoverProbeTarget: null,
    };
  }
  return {
    failoverPinnedIndex: pinIndexOf(templateRule?.failoverPinnedIndex),
    failoverPinnedUntil: toDate(templateRule?.failoverPinnedUntil) ?? null,
    failoverSchedule: nullableString(templateRule?.failoverSchedule),
    failoverMinHoldSeconds: Math.max(0, Number(templateRule?.failoverMinHoldSeconds || 0)),
    failoverPreferFastest: dbBool(templateRule?.failoverPreferFastest),
    failoverProbeTarget: nullableString(templateRule?.failoverProbeTarget),
  };
}

function managedChildControlState(templateRule: any, existing: any) {
  return {
    disabledByUser: dbBool(templateRule?.disabledByUser),
    disabledByTunnel: dbBool(templateRule?.disabledByTunnel) || dbBool(existing?.disabledByTunnel),
    // Protocol blocks are host-specific. A routine group sync must not clear a
    // real block reported by an Agent just because the visible template is on.
    protocolBlockReason: nullableString(templateRule?.protocolBlockReason)
      ?? nullableString(existing?.protocolBlockReason),
  };
}

// GOST 隧道和 Nginx 隧道能挂线路组（调度器在出口机上），NEX 隧道还不行。
function isMainBackupGostTunnelMode(mode: unknown) {
  return routeGroupTunnelModeSupported(mode);
}

function canPreserveChildRuleRuntime(existing: any, payload: any, options: SyncForwardGroupRulesOptions) {
  if (!options.preserveRuntime
    || !dbBool(existing?.isEnabled)
    || !dbBool(existing?.isRunning)
    || dbBool(existing?.pendingDelete)) return false;
  const numberKeys = [
    "hostId",
    "sourcePort",
    "sourcePortEnd",
    "targetPort",
    "tunnelId",
    "tunnelExitPort",
    "forwardGroupId",
    "forwardGroupRuleId",
    "forwardGroupMemberId",
    "proxyProtocolVersion",
    "failoverSeconds",
    "recoverSeconds",
    "failoverMinHoldSeconds",
  ];
  const stringKeys = ["forwardType", "protocol", "gostMode", "targetIp", "failoverStrategy", "failoverTargets", "failoverProbeTarget", "failoverSchedule", "protocolBlockReason"];
  const boolKeys = [
    "proxyProtocolReceive",
    "proxyProtocolSend",
    "proxyProtocolExitReceive",
    "proxyProtocolExitSend",
    "tcpFastOpen",
    "zeroCopy",
    "udpOverTcp",
    "failoverEnabled",
    "failoverPreferFastest",
    "autoFailback",
    "isEnabled",
    "disabledByGroup",
    "disabledByTunnel",
    "disabledByUser",
  ];
  // 出口那几列按规整后的样子比（转发链 / 转发组的子规则不带这几列，缺省就是「直接连接」）。
  const existingEgress = ruleEgressColumnsOf(existing);
  const payloadEgress = ruleEgressColumnsOf(payload);
  const egressSame = existingEgress.egressType === payloadEgress.egressType
    && nullableNumber(existingEgress.egressInboundId) === nullableNumber(payloadEgress.egressInboundId)
    && nullableString(existingEgress.egressConfigJson) === nullableString(payloadEgress.egressConfigJson)
    && existingEgress.egressUdp === payloadEgress.egressUdp;
  // 线路组带中转时子规则照抄模板的路径和策略（childRouteColumns）；没抄的时候 payload 里没有这几列，不比。
  const routeSame = !("routePaths" in (payload || {}))
    || (nullableString(normalizedRoutePaths(existing?.routePaths)) === nullableString(normalizedRoutePaths(payload?.routePaths))
      && nullableString(existing?.routeMode) === nullableString(payload?.routeMode)
      && nullableString(existing?.routeDelivery || "cold") === nullableString(payload?.routeDelivery || "cold")
      && nullableString(normalizedRouteLines(existing?.routeLines)) === nullableString(normalizedRouteLines(payload?.routeLines))
      && (payload?.routeMode == null || (
        nullableString(existing?.routeSwitchMode) === nullableString(payload?.routeSwitchMode)
        && ["routeFailureThreshold", "routeScoreHoldSeconds", "routePrewarmSeconds"].every((key) => nullableNumber(existing?.[key]) === nullableNumber(payload?.[key]))
      )));
  // 人工指定：钉在第 0 条（主线路）也是钉住，不能按「0 = 没有」比；到期时间按毫秒比。
  const pinSame = pinIndexOf(existing?.failoverPinnedIndex) === pinIndexOf(payload?.failoverPinnedIndex)
    && (toDate(existing?.failoverPinnedUntil)?.getTime() ?? null) === (toDate(payload?.failoverPinnedUntil)?.getTime() ?? null);
  return egressSame
    && routeSame
    && pinSame
    && numberKeys.every((key) => nullableNumber(existing?.[key]) === nullableNumber(payload?.[key]))
    && stringKeys.every((key) => nullableString(existing?.[key]) === nullableString(payload?.[key]))
    && boolKeys.every((key) => dbBool(existing?.[key]) === dbBool(payload?.[key]));
}

/** 线路组的调度设置：Agent 能在同一个调度器上原地换（agent/failover_proxy.go startFailoverProxyLocked）。 */
const CHILD_ROUTE_POLICY_KEYS = [
  // 调度参数只有一份清单（shared/routePolicyFields）：加了新参数这里自动跟上，不用记得再抄一遍
  ...ROUTE_POLICY_RULE_FIELDS,
  // 路径：子规则各有各的拨号地址，但换路径同样是 Agent 能原地换的
  "failoverTargets",
  "failoverProbeTarget",
  "routePaths",
  "routeLines",
] as const;

/**
 * 子规则和库里那条只差调度设置（人工指定、时段表、切换灵敏度、路径…）：原地改、不停转发。
 * 和普通规则保存时的 isFailoverHotUpdate（server/routers/rules.crud.ts）是一个意思。
 *
 * 以前模板上点「切到这条 / 交回自动」、改个时段表，每台成员机上的子规则都被标成「没在跑」整条重下发：
 * 转发停一下再起来，连着的人全断，「切换不断连」也就没了。只认 gost：realm / socat / nginx 的服务签名里
 * 带着整份线路组规格（agent/managed_service.go），换规格照样要重启，那几种照旧整条重下发。
 */
function canHotUpdateChildRulePolicy(existing: Record<string, unknown>, payload: Record<string, unknown>) {
  if (!dbBool(existing?.failoverEnabled) || !dbBool(payload?.failoverEnabled)) return false;
  if (normalizeRuntimeForwardType(existing?.forwardType) !== "gost" || normalizeRuntimeForwardType(payload?.forwardType) !== "gost") return false;
  // 调度那几列先换成要写的，剩下的（端口、目标、转发工具、开关、出口…）一样都不能差。
  const policyApplied: Record<string, unknown> = { ...existing };
  for (const key of CHILD_ROUTE_POLICY_KEYS) {
    if (key in payload) policyApplied[key] = payload[key];
  }
  return canPreserveChildRuleRuntime(policyApplied, payload, { preserveRuntime: true });
}

function looselySameColumn(left: unknown, right: unknown) {
  const blank = (value: unknown) => value === null || value === undefined || value === "";
  if (blank(left) || blank(right)) return blank(left) && blank(right);
  if (left instanceof Date || right instanceof Date) return (toDate(left)?.getTime() ?? null) === (toDate(right)?.getTime() ?? null);
  if (typeof left === "boolean" || typeof right === "boolean") return dbBool(left) === dbBool(right);
  if (typeof left === "number" || typeof right === "number") return Number(left) === Number(right);
  return String(left) === String(right);
}

/**
 * 子规则已经和这次要写的一样（在跑、运行时那几列一样、调度设置每一列也一样）：什么都不用写。
 * 只看在跑的：没在跑的照旧整条写，让它重新下发。比不准（类型对不上）就当不一样，照旧写，不会漏改。
 */
function childRuleAlreadyMatches(existing: Record<string, unknown>, payload: Record<string, unknown>) {
  if (!canPreserveChildRuleRuntime(existing, payload, { preserveRuntime: true })) return false;
  return CHILD_ROUTE_POLICY_KEYS.every((key) => {
    if (!(key in payload)) return true;
    if (key === "routePaths") return nullableString(normalizedRoutePaths(existing?.routePaths)) === nullableString(normalizedRoutePaths(payload.routePaths));
    if (key === "routeLines") return nullableString(normalizedRouteLines(existing?.routeLines)) === nullableString(normalizedRouteLines(payload.routeLines));
    if (key === "failoverPinnedIndex") return pinIndexOf(existing?.failoverPinnedIndex) === pinIndexOf(payload.failoverPinnedIndex);
    return looselySameColumn(existing?.[key], payload[key]);
  });
}

function normalizedRoutePaths(raw: unknown): string | null {
  return serializeRoutePaths(parseRoutePaths(raw));
}

function normalizedRouteLines(raw: unknown): string | null {
  return serializeRouteLines(parseRouteLines(raw));
}

function routePathDefinition(path: RoutePath) {
  return JSON.stringify([path.key, path.name, path.hops, path.dest, path.destNodeId || null, path.destHostId || null, path.weight, path.probe]);
}

/**
 * 子规则照抄模板的线路组（路径和策略）：模板不跑，跑的是每台成员机上的子规则；带中转时中继由
 * 子规则各自按自己的入口机在中转机上建（routeGroups.syncRouteRelayRulesForRule）。
 *
 * 中继解析出来的 dial / issue 是子规则自己的（每台入口拨的是自己那套中继的端口），路径定义没变
 * 就保留子规则上已有的，否则每次组同步都会把它冲掉、又触发一轮重建。failoverTargets 同理：
 * 中继同步会按 dial 重写它，组同步不再拿模板的去盖。
 *
 * 没带中转的也照抄（以前只抄带中转的，没中转的子规则按 failover* 列推出路径）：推出来的路径叫
 * main / backup-1，和模板上的对不上 —— 「暂停这条」、权重、分层、落地怎么分都到不了机器上，
 * Agent 按子规则路径记的质量历史，线路详情按模板路径去找也找不到。
 * 模板没开线路组（没有路径）：子规则上还留着以前抄来的路径就清掉。返回 null = 什么都不用改。
 */
function childRouteColumns(templateRule: any, existing: any, childFailoverEnabled: boolean): Record<string, unknown> | null {
  const templatePaths = parseRoutePaths(templateRule?.routePaths);
  if (childFailoverEnabled && templatePaths.length > 0) {
    const existingPaths = parseRoutePaths(existing?.routePaths);
    const merged = templatePaths.map((path) => {
      const previous = existingPaths.find((item) => item.key === path.key && routePathDefinition(item) === routePathDefinition(path));
      if (previous) return { ...path, dial: previous.dial, issue: previous.issue };
      return path.hops.length > 0 ? { ...path, dial: null, issue: null } : path;
    });
    return {
      routePaths: serializeRoutePaths(merged),
      routeMode: templateRule.routeMode || "failover",
      routeSwitchMode: templateRule.routeSwitchMode || "smooth",
      routeFailureThreshold: Number(templateRule.routeFailureThreshold ?? 3),
      routeScoreHoldSeconds: Number(templateRule.routeScoreHoldSeconds ?? 180),
      routePrewarmSeconds: Number(templateRule.routePrewarmSeconds ?? 300),
      // 线路（2.3.496）和切换方式跟着模板走：热备 / 聚合在每台成员机上一样生效，详情里画的线路也是模板那份。
      routeDelivery: templateRule.routeDelivery || "cold",
      routeLines: templateRule.routeLines ?? null,
      ...(existing ? { failoverTargets: existing.failoverTargets ?? templateRule.failoverTargets ?? null } : {}),
    };
  }
  if (existing && (existing.routePaths || existing.routeMode || existing.routeLines)) return { routePaths: null, routeMode: null, routeLines: null, routeDelivery: "cold" };
  return null;
}

/*
  转发组同步里的外部动作（通知 Agent、中转机上的中继同步）：同步跑在数据库事务里时一律等提交之后再做。
  - 回滚了就不该通知：Agent 收到通知会马上来拉配置，拉到的要么是一份从没存在过的拓扑，要么（MySQL /
    PostgreSQL 读不到未提交的行）是改之前的旧配置，而这次通知已经用掉了，下一轮整份心跳之前都不会再来拉；
  - 中继同步要拿 route-relays:<规则> 键锁、还会自己分端口：事务里去等键锁，会和「先拿键锁再查库」的路径
    互相等死（SQLite 下事务占着全局连接锁，MySQL / PG 下卡到行锁超时）。
  不在事务里时照旧立刻做、照旧把错误抛给调用方。提交之后再失败只记日志：数据已经提交，不能因为一次通知
  失败让整个保存报错（Agent 下一轮心跳、中继的启动修复都会补上）。
*/
export async function afterForwardGroupSyncCommit(label: string, work: () => Promise<unknown> | unknown) {
  if (!isDatabaseTransactionActive()) {
    await work();
    return;
  }
  await afterDatabaseCommit(async () => {
    try {
      await work();
    } catch (error) {
      appendPanelLog("warn", `[ForwardGroup] ${label} after commit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** 子规则的路径带着中转（或者刚把中转去掉）：把中转机上的中继落实下来 / 收掉。在事务里时等提交之后再做。 */
async function syncChildRouteRelays(ruleId: number, routeColumns: Record<string, unknown> | null, reason: string) {
  if (!routeColumns) return;
  await afterForwardGroupSyncCommit(`route relay sync rule=${ruleId}`, () => syncChildRouteRelaysNow(ruleId, routeColumns, reason));
}

async function syncChildRouteRelaysNow(ruleId: number, routeColumns: Record<string, unknown>, reason: string) {
  const { retireRouteRelayRulesForRule, syncRouteRelayRulesForRule } = await import("../routeGroups");
  // 去掉了中转：只收中继，不跑完整同步（完整同步会把老式主备列推导成路径写回来）。
  const run = routeColumns.routePaths == null
    ? retireRouteRelayRulesForRule(ruleId, { reason, dropEvents: false })
    : syncRouteRelayRulesForRule(ruleId, { reason });
  await run.catch((error) => {
    console.warn(`[ForwardGroup] route relay sync for child rule ${ruleId} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function syncPreservedChildRuleMetadata(existing: any, payload: any) {
  const patch: Record<string, unknown> = {};
  if (String(existing?.name || "") !== String(payload?.name || "")) patch.name = payload.name;
  if (Number(existing?.userId || 0) !== Number(payload?.userId || 0)) patch.userId = Number(payload.userId);
  // 共享 TLS 入站：换入站 / 换名字只动分流表，规则在本机回环上的入口不用重起，原地写上、催 Agent 重算表。
  let sniChanged = false;
  if (payload?.tlsInboundId !== undefined && nullableNumber(existing?.tlsInboundId) !== nullableNumber(payload.tlsInboundId)) {
    patch.tlsInboundId = payload.tlsInboundId;
    sniChanged = true;
  }
  if (payload?.sniNames !== undefined && String(existing?.sniNames || "") !== String(payload.sniNames || "")) {
    patch.sniNames = payload.sniNames;
    sniChanged = true;
  }
  if (Object.keys(patch).length === 0) return;
  await updateForwardRule(Number(existing.id), patch as any);
  if (sniChanged) pushAgentRefresh(Number(existing.hostId), "forward-group-child-sni-updated");
}

export async function syncChainsUsingEntryGroup(entryGroupId: number, options: SyncForwardGroupRulesOptions = {}) {
  const id = Number(entryGroupId);
  if (!Number.isFinite(id) || id <= 0) return;
  const db = await getDb();
  if (!db) return;
  const rows = await db.select({ id: forwardGroups.id }).from(forwardGroups).where(and(
    inArray(forwardGroups.groupMode, ["chain", "port"]),
    eq(forwardGroups.entryGroupId, id),
  ));
  for (const row of rows as any[]) {
    const chainGroupId = Number(row.id);
    await syncForwardGroupRules(chainGroupId, options);
  }
}

export async function existingChildRule(templateRuleId: number, memberId: number, hostId?: number | null) {
  const db = await getDb();
  const conds: any[] = [
    eq(forwardRules.forwardGroupRuleId, templateRuleId),
    eq(forwardRules.forwardGroupMemberId, memberId),
  ];
  if (hostId) conds.push(eq(forwardRules.hostId, Number(hostId)));
  const rows = await db.select().from(forwardRules).where(and(...conds)).limit(1);
  return rows[0];
}

async function preferredSharedTunnelListenPortForChild(tunnel: any, ruleId: number, enabled: boolean) {
  if (!usesSharedTunnelPrimaryListener(tunnel)) return null;
  const tunnelId = Number(tunnel?.id || 0);
  const listenPort = Number(tunnel?.listenPort || 0);
  if (tunnelId <= 0 || listenPort <= 0 || !dbBool(enabled, true)) return null;
  const rules = await getForwardRulesByTunnel(tunnelId);
  const activeIds = (rules as any[])
    .filter((candidate) => (
      candidate
      && !dbBool(candidate.isForwardGroupTemplate)
      && !dbBool(candidate.pendingDelete)
      && dbBool(candidate.isEnabled)
      && String(candidate.forwardType || "").trim().toLowerCase() === "gost"
      && Number(candidate.id || 0) !== Number(ruleId || 0)
    ))
    .map((candidate) => Number(candidate.id || 0))
    .filter((id) => Number.isInteger(id) && id > 0);
  const candidateId = Number(ruleId || 0);
  if (candidateId <= 0) return activeIds.length === 0 ? listenPort : null;
  activeIds.push(candidateId);
  const primaryId = Math.min(...activeIds);
  return primaryId === candidateId ? listenPort : null;
}

/** ensureMemberRuleForTemplate 告诉调用方的：子规则原样跑着（原地换了调度设置，或者什么都没变），不用再标成没在跑。 */
type MemberRuleSyncOutcome = { keptRunning: boolean };

async function ensureMemberRuleForTemplate(
  group: any,
  templateRule: any,
  member: any,
  options: SyncForwardGroupRulesOptions = {},
  outcome: MemberRuleSyncOutcome = { keptRunning: false },
) {
  const existing = await existingChildRule(Number(templateRule.id), Number(member.id));
  const enabled = dbBool(group?.isEnabled) && dbBool(templateRule?.isEnabled) && dbBool(member?.isEnabled);
  if (!enabled) {
    if (existing) {
      await updateForwardRule(Number(existing.id), { isEnabled: false, isRunning: false } as any);
      await refreshRuleEndpoints(existing, "forward-group-child-disabled");
    }
    return null;
  }

  const hostId = await memberEntryHostId(member);
  if (!hostId) throw new Error("Forward group member has no valid entry agent");
  // SNI 规则的端口是本机回环端口，不对外，成员的对外端口策略管不到它。
  if (!isSniGroupTemplate(templateRule)) await assertEntryPortAllowed(member, Number(templateRule.sourcePort), templateRule.sourcePortEnd);
  const sourcePort = Number(templateRule.sourcePort);
  // 子规则实际监听的主机：隧道成员挂了入口组时不只入口机。
  const listenHostIds = Array.from(new Set([hostId, ...await memberListenHostIds(member)]));
  // 新建子规则时先在进程内占住这个端口，直到子规则写进库：否则同一时刻在这台机器上
  // 手动建规则（它也先预留再查库）和这里只查库的判断可能同时通过，两条规则抢一个端口。
  // 占不到时，只有这条调用链自己（建/改模板的请求）替这台机器占着，才退回只查库的判断；
  // 后台同步（自愈、成员变更）没替谁占着，占不到就是别的请求正在这台机器上分配同一个端口，
  // 当作冲突，这一轮先跳过这个成员，下一次同步再试。
  const childPortReservations: HostPortReservation[] = [];
  let reservedElsewhereHostId = 0;
  if (!existing) {
    for (const listenHostId of listenHostIds) {
      const reservation = tryReserveHostPort(listenHostId, sourcePort, templateRule.protocol);
      if (reservation) {
        childPortReservations.push(reservation);
      } else if (!isHostPortReservationHeldByCaller(listenHostId, sourcePort)) {
        reservedElsewhereHostId = listenHostId;
        break;
      }
    }
  }
  const releaseChildPortReservation = async () => {
    if (childPortReservations.length > 0) await afterDatabaseTransactionSettled(() => releaseHostPortReservations(childPortReservations));
  };
  let usedHostId = reservedElsewhereHostId;
  try {
    for (const listenHostId of usedHostId ? [] : listenHostIds) {
      const used = await isPortUsedOnHostForGroupChild(
        listenHostId,
        sourcePort,
        [Number(templateRule.id), Number(existing?.id || 0)].filter(Boolean),
        templateRule.protocol,
        templateRule.sourcePortEnd,
      );
      if (used) {
        usedHostId = listenHostId;
        break;
      }
    }
  } catch (error) {
    await releaseChildPortReservation();
    throw error;
  }
  if (usedHostId) {
    await releaseChildPortReservation();
    // 端口冲突只挡这一个成员：以前在这里抛错，整组同步（包括两分钟一次的自愈）每次都
    // 中断在这里，后面的成员和模板全都同步不到。记日志、把已有的子规则停住，
    // 端口空出来后下一次同步会自动恢复。
    appendPanelLog("warn", `[ForwardGroup] group=${Number(group?.id || 0)} template=${Number(templateRule.id)} member=${Number(member.id)} host=${usedHostId} port=${sourcePort} ${reservedElsewhereHostId ? "being allocated by another request" : "already used"}; child skipped`);
    if (existing && dbBool(existing.isEnabled)) {
      // 只关 isEnabled、保留 isRunning：心跳看到「停用但还在跑」才会让 Agent 把它撤掉。
      await updateForwardRule(Number(existing.id), { isEnabled: false } as any);
      await refreshRuleEndpoints(existing, "forward-group-child-port-conflict");
    }
    return null;
  }

  let tunnelExitPortReservation: HostPortReservation | null = null;
  try {
  let tunnelId: number | null = null;
  let tunnelExitPort: number | null = null;
  let tunnel: any = null;
  if (member.memberType === "tunnel") {
    tunnelId = Number(member.tunnelId);
    tunnel = await getTunnelById(tunnelId);
    if (!tunnel) throw new Error("Tunnel does not exist");
    if (!dbBool(tunnel.isEnabled)) {
      if (existing) {
        await updateForwardRule(Number(existing.id), { isEnabled: false, isRunning: false } as any);
        await refreshRuleEndpoints(existing, "forward-group-tunnel-disabled");
      }
      return null;
    }
    const exit = await getHostById(Number(tunnel.exitHostId));
    const excludeRuleIds = [Number(templateRule.id), Number(existing?.id || 0)].filter(Boolean);
    const listenerRepair = usesSharedTunnelPrimaryListener(tunnel)
      ? await ensureTunnelListenerPortPolicy(tunnel, {
        hostId: Number(tunnel.exitHostId),
        syncSharedPrimaryRule: true,
      })
      : null;
    if (usesSharedTunnelPrimaryListener(tunnel) && !listenerRepair) {
      throw new Error("Tunnel exit agent has no available listener port");
    }
    const sharedListenPort = await preferredSharedTunnelListenPortForChild(
      tunnel,
      Number(existing?.id || 0),
      enabled,
    );
    // Reuse the listener reservation for the shared primary child. Secondary
    // children must release it and receive their own exit port.
    if (listenerRepair?.reservation && Number(sharedListenPort || 0) === listenerRepair.port) {
      tunnelExitPortReservation = listenerRepair.reservation;
    } else {
      listenerRepair?.reservation.release();
    }
    if (!tunnelExitPortReservation) {
      tunnelExitPortReservation = await reserveTunnelExitPort({
        hostId: Number(tunnel.exitHostId),
        preferredStart: (exit as any)?.portRangeStart,
        preferredEnd: (exit as any)?.portRangeEnd,
        currentPort: sharedListenPort ?? Number(existing?.tunnelExitPort || 0),
        excludeRuleIds,
        allowSameTunnelListener: Number(sharedListenPort || 0) > 0,
        excludeTunnelId: Number(tunnel.id),
        protocol: "both",
      });
    }
    if (!tunnelExitPortReservation) throw new Error("Tunnel exit agent has no available port");
    tunnelExitPort = tunnelExitPortReservation.port;
  }
  const protocol = String(templateRule.protocol || "both");
  const protocolTcpSupported = protocol === "tcp" || protocol === "both";
  const protocolUdpSupported = protocol === "udp" || protocol === "both";
  const groupMode = forwardGroupModeOf(group);
  const isPortGroup = groupMode === "port";
  // Failover groups expose the direct runtime tool and PROXY options in the
  // group editor.  Only use those overrides when an explicit runtime that
  // supports the options was selected; otherwise preserve legacy templates.
  const groupForwardType = String((group as any)?.forwardType || "").trim().toLowerCase();
  const preferGroupRuntime = isPortGroup
    || (groupMode === "failover"
      && dbBool((group as any)?.failoverRuntimeInheritanceEnabled)
      && (groupForwardType === "gost" || groupForwardType === "realm"));
  const directRuntimeSource = preferGroupRuntime ? group : templateRule;
  const failoverRuntimeSource = templateRule;
  const directForwardType = normalizeRuntimeForwardType((directRuntimeSource as any).forwardType);
  const directProxySupported = protocolTcpSupported && (directForwardType === "gost" || directForwardType === "realm");
  // Realm 2.9.x ignores network.fast_open and network.zero_copy. Child rules
  // must therefore never inherit these legacy flags from a group/template.
  const directRealmOptimizationSupported = false;
  // 线路组不卡协议（UDP、TCP+UDP 由 Agent 2.2.199 起按会话调度），只卡转发工具：内核转发插不进调度器。
  const templateFailoverEnabled = dbBool((failoverRuntimeSource as any).failoverEnabled);
  const directFailoverEnabled = templateFailoverEnabled && routeGroupForwardTypeSupported(directForwardType);
  const tunnelMode = String(tunnel?.mode || "").toLowerCase();
  const tunnelFailoverSupported = member.memberType === "tunnel" && isMainBackupGostTunnelMode(tunnelMode);
  const childFailoverEnabled = member.memberType === "tunnel" ? templateFailoverEnabled && tunnelFailoverSupported : directFailoverEnabled;
  const tunnelProxySupported = member.memberType === "tunnel" && !!tunnel
    && (tunnelMode === "forwardx" || ["tls", "wss", "tcp", "mtls", "mwss", "mtcp"].includes(tunnelMode));
  const tunnelForwardx = member.memberType === "tunnel" && tunnelMode === "forwardx";
  const {
    disabledByUser: childDisabledByUser,
    disabledByTunnel: childDisabledByTunnel,
    protocolBlockReason: childProtocolBlockReason,
  } = managedChildControlState(templateRule, existing);

  const payload: any = {
    hostId,
    name: `[Group:${group.name}] ${templateRule.name}`,
    forwardType: member.memberType === "tunnel" ? "gost" : directForwardType,
    protocol,
    gostMode: "direct",
    gostRelayHost: null,
    gostRelayPort: null,
    tunnelId,
    tunnelExitPort,
    forwardGroupId: Number(group.id),
    forwardGroupRuleId: Number(templateRule.id),
    forwardGroupMemberId: Number(member.id),
    isForwardGroupTemplate: false,
    sourcePort: Number(templateRule.sourcePort),
    // 端口段（shared/portRange.ts）：「端口转发」资源的每台成员主机上一条同样的段规则。
    sourcePortEnd: normalizeSourcePortEnd(templateRule.sourcePort, templateRule.sourcePortEnd),
    targetIp: templateRule.targetIp,
    targetPort: Number(templateRule.targetPort),
    telegramErrorNotifyEnabled: dbBool((templateRule as any).telegramErrorNotifyEnabled),
    blockHttp: false,
    blockSocks: false,
    blockTls: false,
    proxyProtocolReceive: member.memberType === "tunnel" ? tunnelProxySupported && protocolTcpSupported && dbBool(tunnel.proxyProtocolReceive) : directProxySupported && dbBool((directRuntimeSource as any).proxyProtocolReceive),
    proxyProtocolSend: member.memberType === "tunnel" ? tunnelProxySupported && protocolTcpSupported && dbBool(tunnel.proxyProtocolSend) : directProxySupported && dbBool((directRuntimeSource as any).proxyProtocolSend),
    proxyProtocolExitReceive: member.memberType === "tunnel" ? tunnelProxySupported && protocolTcpSupported && dbBool(tunnel.proxyProtocolExitReceive) : false,
    proxyProtocolExitSend: member.memberType === "tunnel" ? tunnelProxySupported && protocolTcpSupported && dbBool(tunnel.proxyProtocolExitSend) : false,
    proxyProtocolVersion: member.memberType === "tunnel" ? (tunnelProxySupported && Number(tunnel.proxyProtocolVersion) === 2 ? 2 : 1) : (directProxySupported && Number((directRuntimeSource as any).proxyProtocolVersion) === 2 ? 2 : 1),
    tcpFastOpen: member.memberType === "tunnel" ? tunnelForwardx && protocolTcpSupported && dbBool(tunnel.tcpFastOpen) : directRealmOptimizationSupported && dbBool((directRuntimeSource as any).tcpFastOpen),
    zeroCopy: member.memberType === "tunnel" ? false : directRealmOptimizationSupported && dbBool((directRuntimeSource as any).zeroCopy),
    udpOverTcp: member.memberType === "tunnel" ? tunnelForwardx && protocolUdpSupported && dbBool(tunnel.udpOverTcp) : false,
    udpOverTcpPort: null,
    failoverEnabled: childFailoverEnabled,
    failoverStrategy: (failoverRuntimeSource as any).failoverStrategy || "fallback",
    failoverTargets: childFailoverEnabled ? (failoverRuntimeSource as any).failoverTargets || null : null,
    failoverSeconds: Number((failoverRuntimeSource as any).failoverSeconds || 60),
    recoverSeconds: Number((failoverRuntimeSource as any).recoverSeconds || 120),
    autoFailback: dbBool((failoverRuntimeSource as any).autoFailback, true),
    ...childRoutePolicyColumns(failoverRuntimeSource, childFailoverEnabled),
    isEnabled: !childDisabledByUser && !childDisabledByTunnel && !childProtocolBlockReason,
    disabledByGroup: false,
    disabledByTunnel: childDisabledByTunnel,
    disabledByUser: childDisabledByUser,
    protocolBlockReason: childProtocolBlockReason,
    isRunning: false,
    pendingDelete: false,
    userId: Number(templateRule.userId),
    // Shadowsocks 出口（server/ssEgress.ts）：只有端口转发资源的直连成员照抄模板的出口；隧道成员 / 别的组不带。
    ...(isPortGroup && member.memberType !== "tunnel" ? ruleEgressColumnsOf(templateRule) : { ...NO_EGRESS_COLUMNS }),
  };

  const routeColumns = childRouteColumns(templateRule, existing, childFailoverEnabled);
  if (routeColumns) Object.assign(payload, routeColumns);
  // 共享 TLS 入站：子规则挂这台成员机自己同端口的入站（server/sniGroupChildren.ts）。隧道成员不支持，挂锚点 = 不下发。
  const sniPlan = await planSniChild(templateRule, hostId, [Number(existing?.id || 0)]);
  if (sniPlan) {
    Object.assign(payload, sniPlan.columns);
    if (member.memberType === "tunnel") payload.tlsInboundId = Number(templateRule.tlsInboundId);
  }

  // A 2.3.278 background sync could have copied group-level runtime fields
  // into legacy failover children. Keep those fields stable while the group
  // remains in compatibility mode; an explicit group save opts into the new
  // inheritance semantics and can intentionally reconcile them.
  if (existing && groupMode === "failover" && !dbBool((group as any)?.failoverRuntimeInheritanceEnabled)) {
    const runtimeKeys = [
      "forwardType",
      "proxyProtocolReceive",
      "proxyProtocolSend",
      "proxyProtocolVersion",
    ];
    for (const key of runtimeKeys) {
      const existingValue = existing?.[key];
      const groupValue = (group as any)?.[key];
      const templateValue = templateRule?.[key];
      const equal = key === "forwardType"
        ? normalizeRuntimeForwardType(existingValue) === normalizeRuntimeForwardType(groupValue)
        : key.startsWith("proxyProtocol") && key !== "proxyProtocolVersion"
          ? dbBool(existingValue) === dbBool(groupValue)
          : nullableNumber(existingValue) === nullableNumber(groupValue);
      const groupDiffersFromTemplate = key === "forwardType"
        ? normalizeRuntimeForwardType(groupValue) !== normalizeRuntimeForwardType(templateValue)
        : key.startsWith("proxyProtocol") && key !== "proxyProtocolVersion"
          ? dbBool(groupValue) !== dbBool(templateValue)
          : nullableNumber(groupValue) !== nullableNumber(templateValue);
      if (equal && groupDiffersFromTemplate) payload[key] = existingValue;
    }
  }

  if (existing) {
    if (canPreserveChildRuleRuntime(existing, payload, options)) {
      await syncPreservedChildRuleMetadata(existing, payload);
      return Number(existing.id);
    }
    if (canHotUpdateChildRulePolicy(existing, payload) && childRuleAlreadyMatches(existing, payload)) {
      // 升级后的重同步、模板没改的再同步：子规则和要写的一模一样，不重写整条、不催 Agent；
      // 名字这类元数据照补，中继照对一遍（缺了会补）。
      outcome.keptRunning = true;
      await syncPreservedChildRuleMetadata(existing, payload);
      await syncChildRouteRelays(Number(existing.id), routeColumns, "forward-group-child-policy-unchanged");
      return Number(existing.id);
    }
    if (canHotUpdateChildRulePolicy(existing, payload)) {
      // 照样写整份（名字、调度设置都换上），只是不把它标成没在跑：心跳把新规格带过去，Agent 原地换。
      outcome.keptRunning = true;
      await updateForwardRule(Number(existing.id), { ...payload, isRunning: true });
      await refreshRuleEndpoints({ ...existing, ...payload, id: existing.id }, "forward-group-child-policy-updated");
      await syncChildRouteRelays(Number(existing.id), routeColumns, "forward-group-child-policy-updated");
      return Number(existing.id);
    }
    await updateForwardRule(Number(existing.id), payload);
    if (member.memberType === "tunnel") {
      const tunnel = await getTunnelById(Number(tunnelId || 0));
      tunnelExitPortReservation?.release();
      tunnelExitPortReservation = null;
      if (tunnel) await reconcileForwardRuleTunnelExits({ ...existing, ...payload, id: existing.id }, tunnel);
    }
    await refreshRuleEndpoints({ ...existing, ...payload, id: existing.id }, "forward-group-child-updated");
    await syncChildRouteRelays(Number(existing.id), routeColumns, "forward-group-child-updated");
    return Number(existing.id);
  }

  const ruleId = await createForwardRule(payload);
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(tunnelId || 0));
    tunnelExitPortReservation?.release();
    tunnelExitPortReservation = null;
    if (tunnel) await reconcileForwardRuleTunnelExits({ ...payload, id: ruleId }, tunnel);
  }
  await refreshRuleEndpoints({ ...payload, id: ruleId }, "forward-group-child-created");
  await syncChildRouteRelays(ruleId, routeColumns, "forward-group-child-created");
  return ruleId;
  } finally {
    tunnelExitPortReservation?.release();
    await releaseChildPortReservation();
  }
}

async function reserveChainMemberListenerPort(
  templateRule: any,
  member: any,
  hostId: number,
  options: Pick<SyncForwardGroupRulesOptions, "createMissing"> = {},
) {
  const existing = await existingChildRule(Number(templateRule.id), Number(member.id), hostId);
  if (!dbBool(templateRule?.isEnabled) || (!existing && options.createMissing === false)) return null;
  const entry = await entryPortPolicyForMember(member);
  if (entry.hostId !== hostId) throw new Error("Port forwarding chain member host changed during allocation");
  const ignoreRuleIds = [Number(templateRule.id), Number(existing?.id || 0)].filter(Boolean);
  const protocol = normalizeRuleProtocol(templateRule.protocol);
  const preferredPort = Number(existing?.sourcePort || 0);

  if (preferredPort > 0 && isPortAllowedByPolicy(preferredPort, entry.policy)) {
    const preserved = await reserveSpecificHostPort({
      hostId,
      port: preferredPort,
      protocol,
      isUsed: (port) => isPortUsedOnHost(hostId, port, ignoreRuleIds, protocol, undefined, false),
    });
    if (preserved) return preserved;
  }

  const reservation = await reserveAvailableHostPort({
    hostId,
    protocol,
    findPort: (reservedPorts) => findAvailablePort(hostId, null, null, protocol, reservedPorts),
    isUsed: (port) => isPortUsedOnHost(hostId, port, ignoreRuleIds, protocol, undefined, false),
  });
  if (!reservation) {
    throw new Error(`转发链成员主机 ${hostId} 的端口区间内已无可用监听端口`);
  }
  return reservation;
}

async function ensureChainRuleForTemplate(
  group: any,
  templateRule: any,
  member: any,
  nextMember: any | null,
  index: number,
  total: number,
  options: SyncForwardGroupRulesOptions = {},
  overrides: {
    sourceMember?: any | null;
    sourceHost?: any | null;
    sourcePort?: number | null;
    targetIp?: string | null;
    targetPort?: number | null;
    namePrefix?: string;
    /** 这一跳是对外的入口（第一跳或入口组里的一台）：SNI 规则时它只听回环、挂共享 TLS 入站。 */
    sniEdge?: boolean;
  } = {},
) {
  const sourceMember = overrides.sourceMember || member;
  const sniEdge = !!overrides.sniEdge && isSniGroupTemplate(templateRule);
  if (sourceMember.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
  const sourceHostId = Number(overrides.sourceHost?.id || sourceMember.hostId || 0);
  const existing = await existingChildRule(Number(templateRule.id), Number(member.id), sourceHostId);
  if (!existing && options.createMissing === false) return null;
  const enabled = dbBool(group?.isEnabled)
    && dbBool(templateRule?.isEnabled)
    && dbBool(member?.isEnabled)
    && dbBool(sourceMember?.isEnabled);
  if (!enabled) {
    if (existing) {
      await updateForwardRule(Number(existing.id), { isEnabled: false, isRunning: false } as any);
      if (!options.deferRefresh) await refreshRuleEndpoints(existing, "forward-chain-child-disabled");
    }
    return null;
  }

  if (member.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
  const hostId = sourceHostId || await memberEntryHostId(sourceMember);
  if (!hostId) throw new Error("Port forwarding chain member has no valid entry agent");
  const sourcePort = Number(overrides.sourcePort || templateRule.sourcePort);
  if (options.validatePorts !== false) {
    if (!sniEdge) await assertEntryPortAllowed(sourceMember, sourcePort);
    const used = await isPortUsedOnHostForGroupChild(
      hostId,
      sourcePort,
      [Number(templateRule.id), Number(existing?.id || 0)].filter(Boolean),
      templateRule.protocol,
    );
    if (used) throw new Error(`Entry agent port ${sourcePort} is already used`);
  }

  let targetIp = String(templateRule.targetIp || "").trim();
  let targetPort = Number(templateRule.targetPort);
  if (overrides.targetIp) {
    targetIp = String(overrides.targetIp || "").trim();
    targetPort = Number(overrides.targetPort || templateRule.sourcePort);
  } else if (nextMember) {
    if (nextMember.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
    const nextHost = await getHostById(Number(nextMember.hostId));
    targetIp = resolveChainConnectHost(nextMember, nextHost);
    targetPort = Number(overrides.targetPort || templateRule.sourcePort);
    if (!targetIp) throw new Error("Next chain host has no usable connect address");
  }

  const chainForwardType = normalizeRuntimeForwardType((group as any).forwardType || templateRule.forwardType);
  const protocol = String(templateRule.protocol || "both");
  const protocolTcpSupported = protocol === "tcp" || protocol === "both";
  const chainProxyProtocolSupported = protocolTcpSupported && (chainForwardType === "gost" || chainForwardType === "realm");
  // Realm 2.9.x removed the legacy transport optimization options.
  const chainRealmOptimizationSupported = false;
  const {
    disabledByUser: childDisabledByUser,
    disabledByTunnel: childDisabledByTunnel,
    protocolBlockReason: childProtocolBlockReason,
  } = managedChildControlState(templateRule, existing);

  const payload: any = {
    hostId,
    name: `[Chain:${group.name}] ${overrides.namePrefix || `${index + 1}/${total}`} ${templateRule.name}`,
    forwardType: chainForwardType,
    protocol,
    gostMode: "direct",
    gostRelayHost: null,
    gostRelayPort: null,
    tunnelId: null,
    tunnelExitPort: null,
    forwardGroupId: Number(group.id),
    forwardGroupRuleId: Number(templateRule.id),
    forwardGroupMemberId: Number(member.id),
    isForwardGroupTemplate: false,
    sourcePort,
    targetIp,
    targetPort,
    telegramErrorNotifyEnabled: dbBool((templateRule as any).telegramErrorNotifyEnabled),
    blockHttp: false,
    blockSocks: false,
    blockTls: false,
    proxyProtocolReceive: chainProxyProtocolSupported && dbBool((group as any).proxyProtocolReceive),
    proxyProtocolSend: chainProxyProtocolSupported && dbBool((group as any).proxyProtocolSend),
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: chainProxyProtocolSupported && Number((group as any).proxyProtocolVersion) === 2 ? 2 : 1,
    tcpFastOpen: chainRealmOptimizationSupported && dbBool((group as any).tcpFastOpen),
    zeroCopy: chainRealmOptimizationSupported && dbBool((group as any).zeroCopy),
    udpOverTcp: false,
    udpOverTcpPort: null,
    failoverEnabled: false,
    failoverStrategy: "fallback",
    failoverTargets: null,
    failoverSeconds: 60,
    recoverSeconds: 120,
    autoFailback: true,
    isEnabled: !childDisabledByUser && !childDisabledByTunnel && !childProtocolBlockReason,
    disabledByGroup: false,
    isRunning: false,
    disabledByTunnel: childDisabledByTunnel,
    disabledByUser: childDisabledByUser,
    protocolBlockReason: childProtocolBlockReason,
    pendingDelete: false,
    userId: Number(templateRule.userId),
  };
  if (sniEdge) {
    const sniPlan = await planSniChild(templateRule, hostId, [Number(existing?.id || 0)]);
    if (sniPlan) Object.assign(payload, sniPlan.columns);
  }

  if (existing) {
    if (canPreserveChildRuleRuntime(existing, payload, options)) {
      await syncPreservedChildRuleMetadata(existing, payload);
      return Number(existing.id);
    }
    await updateForwardRule(Number(existing.id), payload);
    if (!options.deferRefresh) {
      await refreshRuleEndpoints({ ...existing, ...payload, id: existing.id }, "forward-chain-child-updated");
    }
    return Number(existing.id);
  }

  const ruleId = await createForwardRule(payload);
  if (!options.deferRefresh) await refreshRuleEndpoints({ ...payload, id: ruleId }, "forward-chain-child-created");
  return ruleId;
}

async function removeStaleForwardGroupChildRules(
  groupId: number,
  liveMemberIds: Set<number>,
  liveTemplateIds: Set<number>,
  liveChildKeys: Set<string>,
  options: Pick<SyncForwardGroupRulesOptions, "deferRefresh"> = {},
) {
  const childRules = await getForwardGroupChildRules(groupId);
  for (const child of childRules as any[]) {
    const childKey = `${Number(child.forwardGroupRuleId)}:${Number(child.forwardGroupMemberId)}:${Number(child.hostId)}`;
    if (
      !liveMemberIds.has(Number(child.forwardGroupMemberId))
      || !liveTemplateIds.has(Number(child.forwardGroupRuleId))
      || !liveChildKeys.has(childKey)
    ) {
      await removeManagedRule(Number(child.id), options);
    }
  }
}

export async function removeManagedRule(
  ruleId: number,
  options: Pick<SyncForwardGroupRulesOptions, "deferRefresh"> = {},
) {
  const rule = await getForwardRuleById(ruleId);
  if (!rule) return;
  // 已经在删除流程里（等 Agent 确认）：不再重复结算、重复标记。以前每次同步都会对它
  // 再来一遍，既多拿一次计费锁，又会把 Agent 已确认的删除状态重新打回「待删」。
  if (dbBool((rule as any).pendingDelete)) return;
  // 子规则带着线路组中转（模板的路径有中转时）：中转机上那几条中继跟着收掉，别等面板重启才清。
  // 收中继要拿 route-relays:<规则> 键锁，在事务里时放到提交之后（见 afterForwardGroupSyncCommit）。
  if (parseRoutePaths((rule as any).routePaths).some((path) => path.hops.length > 0)) {
    await afterForwardGroupSyncCommit(`route relay retire rule=${Number(rule.id)}`, async () => {
      const { retireRouteRelayRulesForRule } = await import("../routeGroups");
      await retireRouteRelayRulesForRule(Number(rule.id), { reason: "forward-group-child-removed" }).catch(() => undefined);
    });
  }
  const billingResource = await findTrafficBillingResourceForRule(rule);
  const fallback = trafficBillingResourceCandidatesForRule(rule)[0];
  const resource = billingResource || fallback;
  /*
    在事务里（建 / 改模板、转发链同步）：事务里只标待删，结算放到提交之后。结算要拿这个用户的计费键锁，
    计费那边是「先拿键锁、再开事务」，事务里再等键锁就互相等死；结算自己在 MySQL / PG 上还会锁用户的
    计费行，跟着这个大事务一起占着，和流量上报抢锁。回滚了也就不结算 —— 子规则其实没删。
  */
  if (options.deferRefresh || isDatabaseTransactionActive()) {
    await markForwardRulePendingDelete(Number(rule.id));
    await afterDatabaseCommit(async () => {
      const billed = resource
        ? await withTrafficBillingUserLock(rule?.userId, () => settleTrafficBillingRuleOnDelete({
            userId: Number(rule?.userId || 0),
            ruleId: Number(rule?.id || 0),
            resourceType: resource.resourceType,
            resourceId: Number(resource.resourceId || 0),
          }))
        : null;
      if (billed && Number(billed.balanceAfterCents) < 0) {
        await handleTrafficBillingShortfallLazily(Number((rule as any).userId), "group-child-delete-settlement-negative");
      }
      await refreshRuleEndpoints(rule, "forward-group-child-deleted");
    });
    return;
  }
  if (!resource) {
    await settleAndMarkForwardGroupRulePendingDelete(rule);
    await refreshRuleEndpoints(rule, "forward-group-child-deleted");
    return;
  }
  const billed = await settleAndMarkForwardGroupRulePendingDelete(rule, resource);
  if (billed && Number(billed.balanceAfterCents) < 0) {
    await handleTrafficBillingShortfallLazily(Number((rule as any).userId), "group-child-delete-settlement-negative");
  }
  await refreshRuleEndpoints(rule, "forward-group-child-deleted");
}

async function syncForwardGroupRulesUnlocked(groupId: number, options: SyncForwardGroupRulesOptions = {}) {
  const group = await getForwardGroupById(groupId);
  if (!group) return;
  const db = await getDb();
  const members = sortedMembers(group) as any[];
  const groupMode = forwardGroupModeOf(group);
  const preserveRuntime = !!options.preserveRuntime;
  const activeChainMembers = groupMode === "chain" ? members.filter((member: any) => dbBool(member?.isEnabled)) : members;

  // 端口转发挂了入口组：入口就是入口组里启用的主机，自己的成员列表是空的
  const portEntryMembers = groupMode === "port" ? await entryGroupMembersFor(group) : [];
  const fanoutMembers = groupMode === "port" && Number((group as any).entryGroupId || 0) > 0 ? portEntryMembers : members;
  if (groupMode === "port") {
    if (Number((group as any).entryGroupId || 0) <= 0 && (members.length < 1 || members.length > MAX_FORWARD_GROUP_MEMBERS)) {
      throw new Error(`端口转发需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台入口主机，或者挂一个入口组`);
    }
    if (String(group.groupType || "host") !== "host") throw new Error("端口转发仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error("端口转发仅支持主机成员");
    await repairPortForwardRuleHostReferences(groupId);
  }

  const templates = await getForwardGroupTemplateRules(groupId);

  if (isCollectionGroupMode(groupMode)) {
    const childRules = await getForwardGroupChildRules(groupId);
    for (const child of childRules as any[]) await removeManagedRule(Number(child.id));
    for (const template of templates as any[]) {
      // 模板从不下发到 Agent，等不到停止确认：标成待删除后直接收掉，否则永远留在库里。
      await markForwardRulePendingDelete(Number(template.id));
      await finalizeForwardRuleDelete(Number(template.id));
    }
    for (const member of members) {
      if (member.ruleId) {
        await removeManagedRule(Number(member.ruleId));
        await db.update(forwardGroupMembers).set({ ruleId: null, updatedAt: nowDate() } as any).where(eq(forwardGroupMembers.id, member.id));
      }
    }
    return;
  }

  const runtimeDependenciesEnabled = await forwardGroupRuntimeDependenciesEnabled(group);
  const hasEnabledTemplates = (templates as any[]).some((template) => dbBool(template?.isEnabled));
  if (!runtimeDependenciesEnabled || !hasEnabledTemplates) {
    const childRules = (await getForwardGroupChildRules(groupId) as any[]).filter((rule) => !dbBool(rule?.pendingDelete));
    const childIds = childRules.map((rule) => Number(rule.id || 0)).filter((id) => id > 0);
    if (childIds.length > 0) {
      await db.update(forwardRules).set({
        isEnabled: false,
        isRunning: false,
        updatedAt: nowDate(),
      } as any).where(inArray(forwardRules.id, childIds));
      if (!options.deferRefresh) {
        await refreshControlledForwardRules(childRules, "forward-group-runtime-disabled");
      }
    }
    const templateIds = (templates as any[]).map((template) => Number(template.id || 0)).filter((id) => id > 0);
    if (templateIds.length > 0) {
      await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() } as any).where(inArray(forwardRules.id, templateIds));
    }
    return;
  }

  const activeChainEntryMembers = await entryGroupMembersFor(group);
  if (groupMode === "chain" && activeChainEntryMembers.length > 0) {
    const chainHostIds = new Set(activeChainMembers.map((member: any) => Number(member.hostId || 0)));
    for (const entryMember of activeChainEntryMembers) {
      const entryHostId = await memberEntryHostId(entryMember);
      if (entryHostId > 0 && chainHostIds.has(entryHostId)) {
        throw new Error("Entry group host cannot also be used inside the port forwarding chain");
      }
    }
  }

  /*
    这一轮同步里每条子规则都原样跑着（只原地换了调度设置，见 canHotUpdateChildRulePolicy）：隧道成员的隧道也不用
    重下发。模板上点「切到这条」以前会顺带把组里每条隧道停掉重来。有一条新建、重下发、收掉的，照旧全部重下发。
  */
  let everyChildKeptRunning = groupMode !== "chain";
  let childrenKeptRunning = 0;
  const liveMemberIds = new Set((groupMode === "chain" ? activeChainMembers : fanoutMembers).map((m: any) => Number(m.id)));
  const liveTemplateIds = new Set((templates as any[]).map((rule: any) => Number(rule.id)));

  if (groupMode === "chain") {
    const liveChildKeys = new Set<string>();
    const entryMembers = activeChainEntryMembers;
    const firstChainMember = activeChainMembers[0] || null;
    for (const template of templates as any[]) {
      if (firstChainMember && entryMembers.length > 0) {
        for (const entryMember of entryMembers) {
          const entryHostId = await memberEntryHostId(entryMember);
          if (entryHostId > 0) liveChildKeys.add(`${Number(template.id)}:${Number(firstChainMember.id)}:${entryHostId}`);
        }
      }
      for (const member of activeChainMembers) {
        const hostId = await memberEntryHostId(member);
        if (hostId > 0) liveChildKeys.add(`${Number(template.id)}:${Number(member.id)}:${hostId}`);
      }
    }
    await removeStaleForwardGroupChildRules(groupId, liveMemberIds, liveTemplateIds, liveChildKeys, options);
  } else {
    const childRules = await getForwardGroupChildRules(groupId);
    for (const child of childRules as any[]) {
      if (!liveMemberIds.has(Number(child.forwardGroupMemberId)) || !liveTemplateIds.has(Number(child.forwardGroupRuleId))) {
        await removeManagedRule(Number(child.id));
        everyChildKeptRunning = false;
      }
    }
  }

  for (const member of members) {
    if (member.ruleId) {
      everyChildKeptRunning = false;
      await removeManagedRule(Number(member.ruleId), options);
      await db.update(forwardGroupMembers).set({ ruleId: null, updatedAt: nowDate() } as any).where(eq(forwardGroupMembers.id, member.id));
    }
  }

  for (const template of templates as any[]) {
    if (groupMode === "chain") {
      const entryMembers = activeChainEntryMembers;
      const minChainMembers = entryMembers.length > 0 ? 1 : 2;
      if (activeChainMembers.length < minChainMembers || activeChainMembers.length > MAX_FORWARD_GROUP_MEMBERS) {
        throw new Error(entryMembers.length > 0
          ? `Port forwarding chain requires 1-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`
          : `Port forwarding chain requires 2-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`);
      }
      if (options.createMissing === false) {
        const existingListeners = await Promise.all(activeChainMembers.map(async (member: any) => {
          const hostId = await memberEntryHostId(member);
          return hostId > 0
            ? existingChildRule(Number(template.id), Number(member.id), hostId)
            : null;
        }));
        if (existingListeners.some((listener) => !listener)) continue;
      }
      const chainPortReservations: HostPortReservation[] = [];
      try {
        const chainSourcePorts: number[] = [];
        for (const [index, member] of activeChainMembers.entries()) {
          if (index === 0 && entryMembers.length === 0) {
            chainSourcePorts.push(Number(template.sourcePort));
            continue;
          }
          const hostId = await memberEntryHostId(member);
          if (!hostId) throw new Error("Port forwarding chain member has no valid entry agent");
          const reservation = await reserveChainMemberListenerPort(template, member, hostId, options);
          if (reservation) chainPortReservations.push(reservation);
          chainSourcePorts.push(reservation?.port || Number(template.sourcePort));
        }

        for (let index = activeChainMembers.length - 1; index >= 0; index--) {
          const member = activeChainMembers[index];
          const nextMember = activeChainMembers[index + 1] || null;
          const sniEdge = index === 0 && entryMembers.length === 0;
          const ruleId = await ensureChainRuleForTemplate(group, template, member, nextMember, index, activeChainMembers.length, options, {
            sourcePort: chainSourcePorts[index],
            targetPort: nextMember ? chainSourcePorts[index + 1] : null,
            sniEdge,
          });
          if (ruleId && sniEdge) await syncSniChildNames(ruleId, template, { groupId: Number(group.id) });
          if (ruleId && !preserveRuntime) {
            await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
          }
        }
        if (entryMembers.length > 0) {
          const firstMember = activeChainMembers[0];
          const firstHost = await getHostById(Number(firstMember.hostId));
          const targetIp = resolveChainConnectHost(firstMember, firstHost);
          if (!targetIp) throw new Error("First chain host has no usable connect address");
          for (const [entryIndex, entryMember] of entryMembers.entries()) {
            const entryHostId = await memberEntryHostId(entryMember);
            if (activeChainMembers.some((member: any) => Number(member.hostId || 0) === entryHostId)) {
              throw new Error("Entry group host cannot also be used inside the port forwarding chain");
            }
            const entryHost = await getHostById(entryHostId);
            const ruleId = await ensureChainRuleForTemplate(group, template, firstMember, null, entryIndex, entryMembers.length, options, {
              sourceMember: entryMember,
              sourceHost: entryHost,
              sourcePort: Number(template.sourcePort),
              targetIp,
              targetPort: chainSourcePorts[0],
              namePrefix: `entry ${entryIndex + 1}/${entryMembers.length}`,
              sniEdge: true,
            });
            if (ruleId) await syncSniChildNames(ruleId, template, { groupId: Number(group.id) });
            if (ruleId && !preserveRuntime) {
              await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
            }
          }
        }
      } finally {
        await afterDatabaseTransactionSettled(() => releaseHostPortReservations(chainPortReservations));
      }
    } else {
      for (const member of fanoutMembers) {
        const outcome: MemberRuleSyncOutcome = { keptRunning: false };
        const ruleId = await ensureMemberRuleForTemplate(group, template, member, options, outcome);
        if (ruleId) await syncSniChildNames(ruleId, template, { groupId: Number(group.id) });
        if (outcome.keptRunning) childrenKeptRunning += 1;
        else everyChildKeptRunning = false;
        if (ruleId && !preserveRuntime && !outcome.keptRunning) {
          await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
        }
      }
    }
    if (!preserveRuntime) {
      await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, template.id));
    }
  }

  if (!preserveRuntime && !(everyChildKeptRunning && childrenKeptRunning > 0)) {
    for (const member of members) {
      if (member.memberType === "tunnel" && member.tunnelId) {
        const tunnel = await getTunnelById(Number(member.tunnelId));
        if (tunnel) await updateTunnel(Number(member.tunnelId), { isRunning: false } as any);
      }
    }
  }
}

async function syncForwardGroupRulesWithLockHeld(groupId: number, options: SyncForwardGroupRulesOptions = {}) {
  const group = await getForwardGroupById(groupId);
  if (!group) return;
  if (forwardGroupModeOf(group) !== "chain") {
    await syncForwardGroupRulesUnlocked(groupId, options);
    return;
  }
  await withDatabaseTransaction(async () => {
    await syncForwardGroupRulesUnlocked(groupId, { ...options, deferRefresh: true });
    // Dispatch only after commit so Agents always observe the complete topology.
    await afterDatabaseCommit(() => refreshForwardChainRuntime(groupId, "forward-chain-synced"));
  });
}

export async function withForwardGroupSyncTransaction<T>(
  groupId: number,
  work: () => Promise<T>,
  options: SyncForwardGroupRulesOptions = {},
): Promise<T> {
  return withForwardGroupsSyncTransaction([groupId], work, options);
}

/*
  建 / 改转发组模板规则：模板行的写入（work）和这些组的子规则同步放在同一个事务里，中途哪一步失败
  （成员机上端口被占、出口分不到端口、写库报错）整体回滚，不会留下一条没有子规则的模板，也不会留下
  一半成员上有、一半成员上没有的子规则。

  防死锁的规矩：
  - 键锁都在开事务之前拿。同步锁 forward-group-sync:<组> 别处也是「先拿锁、再开事务」，并且
    syncForwardGroupRules 在事务里调用会直接报错，所以事务里不会有人再去等这把锁。
  - 换组时要同时拿新旧两个组的锁：按组 id 从小到大拿，两个请求互相换组也不会各拿一把互等。
  - 事务里的同步不等任何别的键锁、不等事务外发起的查询：通知 Agent、中继同步、删除子规则的流量结算
    都挂到提交之后（afterForwardGroupSyncCommit、removeManagedRule），端口预留只做「占得到就占、
    占不到就算冲突」，不排队等。
  syncGroupIds 默认等于 lockGroupIds；只想拿锁、不想在事务里同步的（比如模板改回普通规则）传 []。
*/
export async function withForwardGroupsSyncTransaction<T>(
  lockGroupIds: readonly number[],
  work: () => Promise<T>,
  options: SyncForwardGroupRulesOptions & { syncGroupIds?: readonly number[] } = {},
): Promise<T> {
  if (isDatabaseTransactionActive()) {
    throw new Error("Forward group sync transaction must start before a database transaction");
  }
  const { syncGroupIds, ...syncOptions } = options;
  const validIds = (ids: readonly number[]) => Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const locked = validIds(lockGroupIds).sort((left, right) => left - right);
  const synced = validIds(syncGroupIds ?? lockGroupIds);
  if (synced.some((id) => !locked.includes(id))) {
    throw new Error("Forward group sync transaction can only sync groups whose lock it holds");
  }
  const run = () => withDatabaseTransaction(async () => {
    const result = await work();
    for (const groupId of synced) await syncForwardGroupRulesWithLockHeld(groupId, syncOptions);
    return result;
  });
  const withLocks = locked.reduceRight<() => Promise<T>>(
    (inner, groupId) => () => withKeyedTaskLock(`forward-group-sync:${groupId}`, inner),
    run,
  );
  return withLocks();
}

export async function syncForwardGroupRules(groupId: number, options: SyncForwardGroupRulesOptions = {}) {
  if (isDatabaseTransactionActive()) {
    throw new Error("Forward group sync lock must be acquired before starting a database transaction");
  }
  return withKeyedTaskLock(
    `forward-group-sync:${groupId}`,
    () => syncForwardGroupRulesWithLockHeld(groupId, options),
  );
}
