import { normalizeSourcePortEnd } from "../../shared/portRange";
import { isIP } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { ROUTE_POLICY_RULE_FIELDS } from "../../shared/routePolicyFields";
import { groupModeSupportsMemberSchedule, resolveMemberScheduleState, serializeMemberSchedule } from "../../shared/memberSchedule";
import { NO_EGRESS_COLUMNS, ruleEgressColumnsOf } from "../../shared/ssEgress";
import { forwardGroupModeOf } from "../../shared/forwardTypes";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  forwardGroupEvents,
  forwardGroupMembers,
  forwardGroups,
  forwardRules,
  hosts,
  tunnels,
  subscriptionPlanForwardGroups,
  userForwardGroupPermissions,
  type ForwardRule,
  type InsertForwardGroup,
  type InsertForwardGroupMember,
} from "../../drizzle/schema";
import type { SniReadinessTemplate } from "../tlsInboundReadiness";
import { pushAgentRefresh } from "../agentEvents";
import { appendPanelLog } from "../_core/panelLogger";
import { invalidateProxySubCacheAll } from "../proxySubCache";
import { DEFAULT_DDNS_TTL, getDdnsSettings, updateDdnsRecordValues, type DdnsRecordValuesInput, type DdnsSettings } from "../ddns";
import { forwardGroupMirrorRecordType, mirrorForwardGroupDdnsValues } from "../forwardGroupDualStackDdns";
import { prepareForwardGroupDdnsLines, syncForwardGroupDdnsLines, type ForwardGroupLineContext } from "../forwardGroupDdnsLines";
import type { LineMemberStatus, LinePlannerMember } from "../ddnsLinePlanner";
import { parseDdnsLineState, serializeDdnsLines } from "../../shared/ddnsLines";
import { ddnsLineProviderLabel, ddnsLineSupport, deleteDdnsLineRecords } from "../ddnsLineRecords";
import { afterDatabaseCommit, afterDatabaseTransactionSettled, executeRaw, getDb, insertAndGetId, isDatabaseTransactionActive, nowDate, queryRaw, rawEpochToDate, withDatabaseTransaction } from "../dbRuntime";
import { flushPendingWrites } from "../dbWriteBatcher";
import { withForwardTestDates } from "./forwardTestRepository";
import { inList, quoteIdentifier } from "../dbCompat";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import {
  defaultHealthCheckPort,
  defaultHealthCheckTarget,
  healthCheckTargetNeedsPort,
  normalizeForwardGroupHealthCheckMethod,
  type ForwardGroupHealthCheckMethod,
} from "../../shared/forwardGroupHealthCheck";
import {
  createForwardRule,
  getForwardGroupChildRules,
  getForwardGroupChildRulesForMember,
  getForwardGroupChildRulesForTemplate,
  getForwardGroupTemplateRules,
  getForwardRuleById,
  finalizeForwardRuleDelete,
  getForwardRulesByTunnel,
  markForwardRulePendingDelete,
  updateForwardRule,
} from "./forwardRuleRepository";
import { getHostById, getHosts, getHostsByIds, HOST_ONLINE_TTL_MS, isFreshHostHeartbeat } from "./hostRepository";
import { getLatestHostMetricSnapshots } from "./metricsRepository";
import {
  applyAggregationToDdnsValues,
  buildEntryGroupAggregationPlan,
  hostThroughputMbpsFromSnapshots,
  isBandwidthAggregationGroup,
  resolveAggregationSettings,
  summarizeAggregationPlan,
  type AggregationMemberRow,
} from "../bandwidthAggregation";
import { normalizeMemberBandwidthMbps, normalizeMemberWeight } from "../../shared/bandwidthAggregation";
import {
  assertOutsideDatabaseTransaction,
  assertTunnelRulePortsFreeOnEntryHosts,
  disableForwardRulesByTunnel,
  ensureTunnelListenerPortPolicy,
  findAvailablePort,
  getUsedPortsOnHost,
  getTunnelById,
  getTunnelExitNodes,
  getTunnelHops,
  getTunnels,
  isPortUsedOnHost,
  findUsedPortInRangeOnHost,
  reconcileForwardRuleTunnelExits,
  reserveTunnelExitPort,
  resetForwardRulesByTunnel,
  restoreForwardRulesByTunnel,
  forwardRuleOwnerAllowsRuntime,
  pushRouteRelayHostsForParents,
  syncTunnelExitGroupEndpoints,
  tunnelRuleListenHostIds,
  updateTunnel,
  usesSharedTunnelPrimaryListener,
} from "./tunnelRepository";
import { findTrafficBillingResourceForRule, settleTrafficBillingRuleOnDelete, trafficBillingResourceCandidatesForRule } from "./trafficBillingRepository";
import { combineHostPortPolicyWithRange, combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom, type PortPolicy } from "@shared/portPolicy";
import { clearTunnelRuntimeStatus, clearTunnelRuntimeStatusForHosts } from "../tunnelRuntimeStatus";
import { linkProbeMethodForProtocol, type LinkProbeMethod } from "@shared/latencyProbe";
import {
  ForwardGroupEvaluationBatchError,
  ForwardGroupEvaluationQueue,
  FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS,
  ForwardGroupHealthRecheckScheduler,
  FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS,
  forwardGroupAgentHealthStateAt,
  forwardGroupChinaHealthStateAt,
  nextForwardGroupChinaHealthExpiryAt,
  nextForwardGroupHealthRecheckAt,
} from "../forwardGroupHealthRecheck";
import { notifyForwardGroupSwitch } from "../forwardGroupSwitchNotifier";
import { FORWARD_GROUP_AUTO_SWITCH_EVENT, FORWARD_GROUP_FLAP_WINDOW_MS, forwardGroupFlapHoldAt, forwardGroupFlapHoldLabel } from "../forwardGroupFlapHold";
import { recordForwardGroupSwitchEvent } from "../ops/eventHooks";
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
import { assertNoDirectSelfForwardLoop } from "../selfForwardLoop";
import { summarizeForwardGroupRuntime } from "../forwardGroupRuntimeStatus";
import { dbBool, sqlBool } from "./repositoryUtils";
import { isSniGroupTemplate, planSniChild, syncSniChildNames } from "../sniGroupChildren";
import { reorderWithinSortOrderScope } from "./sortOrderSlots";
import { normalizeExitGroupStrategy } from "@shared/exitStrategy";
import { MAX_FORWARD_GROUP_MEMBERS, forwardGroupRouteMembers } from "../../shared/forwardGroup";
import { parseRoutePaths, routeGroupForwardTypeSupported, routeGroupTunnelModeSupported, serializeRoutePaths, type RoutePath } from "../../shared/routeGroup";
import { parseRouteLines, serializeRouteLines } from "../../shared/routeLines";
import { getLastAuthenticatedAgentActivity } from "../agentActivity";
import { HOST_TRAFFIC_FAILOVER_EXCLUDED_MESSAGE, hostTrafficExcluded } from "../../shared/hostTrafficPolicy";
import { getTrafficExcludedHostIds } from "../hostTrafficPolicy";
import { planTunnelTrafficParticipation } from "../hostTrafficRuntimePlan";
import { isTunnelRelayFailover } from "../../shared/tunnelRelay";
import {
  AGENT_FAST_LIVENESS_SILENCE_MS,
  getPresenceCapableHostLivenessSnapshot,
  primePresenceCapableHosts,
} from "../agentFastLiveness";
import { agentSupportsUnifiedBalance } from "../../shared/loadBalance";
import {
  decideExternalHealth,
  entryMemberInclusion,
  externalHealthLabel,
  planEntryGroupRecordSet,
  readinessGrace,
  type ExternalHealthDecision,
  type PeerObserverView,
} from "../forwardGroups/evaluate";
import {
  PEER_REFERENCE_MEMBER_ID,
  forwardGroupPeerObservations,
  parseStoredExternalHealth,
  serializeStoredExternalHealth,
} from "../forwardGroups/peerObservations";
import {
  TopologyCache,
  parsePeerObserverHostIds,
  peerProbePortKey,
  planPeerObservers,
  selectPeerProbePorts,
  type PeerAssignment,
  type PeerProbePort,
  type PeerTargetMember,
} from "../forwardGroups/topology";
import {
  FORWARD_GROUP_READINESS_SAMPLE_GRACE_MS,
  forwardGroupPanelReadyAt,
  markForwardGroupPanelReady,
  staleSampleWithinReadinessGrace,
} from "../forwardGroups/readiness";
import { ForwardGroupPublishQueue, ddnsProviderAccountKey } from "../forwardGroups/publish";
import { databaseHealth } from "../databaseHealthState";
import { clearDdnsRecordWeights, ddnsWeightSupport, publishWeightedDdnsRecords } from "../ddnsWeightedRecords";
import {
  DDNS_WEIGHT_ADAPTIVE_TOLERANCE,
  ddnsWeightRecordTypeSupported,
  ddnsWeightsEqual,
  ddnsWeightsFromAggregationPlan,
  describeDdnsWeights,
  parseDdnsWeightState,
  type DdnsWeights,
} from "../../shared/ddnsWeights";
import type { BandwidthAggregationPlan } from "../../shared/bandwidthAggregation";

async function settleAndMarkForwardGroupRulePendingDelete(
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

export type ForwardGroupMemberInput = {
  memberType: "host" | "tunnel";
  hostId?: number | null;
  tunnelId?: number | null;
  connectHost?: string | null;
  priority?: number;
  isEnabled?: boolean;
  /** Declared uplink of this front VPS, in Mbps. `0` means unknown. */
  bandwidthMbps?: number | null;
  /** Manual aggregation weight. `0` derives it from the group strategy. */
  aggregationWeight?: number | null;
  /** 可用时段（shared/memberSchedule.ts）。undefined = 不改原来的；null = 不限时段。 */
  activeSchedule?: unknown;
  /** 分到的运营商线路（shared/ddnsLines.ts）。undefined = 不改原来的；null / [] = 只在默认线路。 */
  ddnsLines?: unknown;
};

/**
 * 成员写库时的启用状态：isEnabled 传进来的是用户的意思，按可用时段算出此刻实际该不该开，
 * 并记下是不是时段让它停的（scheduleSuspended）。不支持时段的组模式一律清掉时段。
 */
function memberSchedulePayload(groupMode: ForwardGroupMode, member: ForwardGroupMemberInput, existing: any, at = new Date()) {
  const supported = groupModeSupportsMemberSchedule(groupMode);
  const schedule = !supported ? null : member.activeSchedule === undefined
    ? serializeMemberSchedule(existing?.activeSchedule)
    : serializeMemberSchedule(member.activeSchedule);
  const state = resolveMemberScheduleState(dbBool(member.isEnabled, true), schedule, at);
  return { activeSchedule: schedule, isEnabled: state.isEnabled, scheduleSuspended: state.scheduleSuspended };
}

type ForwardGroupRuleConfig = {
  sourcePort: number;
  protocol?: "tcp" | "udp" | "both" | string | null;
  excludeTemplateRuleId?: number | null;
  /** 共享 TLS 入站上的规则：sourcePort 是面板分的本机回环端口，不受对外端口策略管（见 server/tlsInbounds.ts）。 */
  sniBackendPort?: boolean;
};

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

function runtimeFieldEqual(current: unknown, next: unknown) {
  if (next === null) return current === null || current === undefined || current === "";
  if (typeof next === "number") return Number(current || 0) === next;
  if (typeof next === "boolean") return dbBool(current) === next;
  if (next instanceof Date) return toDate(current)?.getTime() === next.getTime();
  return String(current ?? "") === String(next ?? "");
}

async function updateForwardGroupRuntimeIfChanged(db: any, group: any, patch: Record<string, unknown>) {
  if (Object.entries(patch).every(([key, value]) => runtimeFieldEqual(group?.[key], value))) return false;
  await db.update(forwardGroups).set({ ...patch, updatedAt: nowDate() }).where(eq(forwardGroups.id, group.id));
  Object.assign(group, patch);
  return true;
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
        && ["routeFailureThreshold", "routeScoreMargin", "routeScoreHoldSeconds", "routePrewarmSeconds"].every((key) => nullableNumber(existing?.[key]) === nullableNumber(payload?.[key]))
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
      routeScoreMargin: Number(templateRule.routeScoreMargin ?? 10),
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
async function afterForwardGroupSyncCommit(label: string, work: () => Promise<unknown> | unknown) {
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

type ForwardGroupMode = "port" | "failover" | "chain" | "entry" | "exit";
type ForwardGroupRecordType = "A" | "AAAA" | "CNAME";
type ForwardGroupFailoverOptions = {
  forcePriority?: boolean;
  forceSync?: boolean;
  manual?: boolean;
  suppressSwitchNotify?: boolean;
  skipRuleSync?: boolean;
  /**
   * 这一轮只算结论（DECIDE）：要写服务商时不在这里写，把组交给发布队列（PUBLISH，
   * server/forwardGroups/publish.ts）。后台评估队列和定时巡检用；人工操作、保存组照旧当场发布。
   */
  deferPublish?: boolean;
};

/*
  一次组评估的作用域：这一轮要用的主机 / 隧道 / 子规则状态先批量读好放在这里，评估里那些
  「按成员取主机」「按规则取最新探测」的辅助函数先看这里，没有才去查库（P7：以前每个成员各查几次）。
  不在评估里调用这些辅助函数（保存校验、别的模块）时没有作用域，照旧逐个查。
*/
type ForwardGroupEvaluationRules = {
  childRulesByMemberId: Map<number, any[]>;
  enabledTemplateIds: Set<number>;
  latestTcpingByRuleId: Map<number, any>;
};
type ForwardGroupEvaluationScope = {
  hostById: Map<number, any | null>;
  tunnelById: Map<number, any | null>;
  rules: ForwardGroupEvaluationRules | null;
  deferPublish: boolean;
  /** 这一轮碰到了要写服务商的地方但没写（deferPublish）：评估完把组交给发布队列。 */
  deferred: boolean;
};
const forwardGroupEvaluationScope = new AsyncLocalStorage<ForwardGroupEvaluationScope>();

async function evaluationHost(hostIdValue: unknown) {
  const hostId = Number(hostIdValue || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return null;
  const scope = forwardGroupEvaluationScope.getStore();
  if (scope?.hostById.has(hostId)) return scope.hostById.get(hostId) ?? null;
  const host = (await getHostById(hostId)) ?? null;
  scope?.hostById.set(hostId, host);
  return host;
}

async function evaluationTunnel(tunnelIdValue: unknown) {
  const tunnelId = Number(tunnelIdValue || 0);
  if (!Number.isInteger(tunnelId) || tunnelId <= 0) return null;
  const scope = forwardGroupEvaluationScope.getStore();
  if (scope?.tunnelById.has(tunnelId)) return scope.tunnelById.get(tunnelId) ?? null;
  const tunnel = (await getTunnelById(tunnelId)) ?? null;
  scope?.tunnelById.set(tunnelId, tunnel);
  return tunnel;
}

/** 评估走到要写服务商的地方时问一句：这一轮只算结论的话记一笔、返回 true，调用方不写、不改组状态。 */
function deferProviderWrite() {
  const scope = forwardGroupEvaluationScope.getStore();
  if (!scope?.deferPublish) return false;
  scope.deferred = true;
  return true;
}

const FORWARD_GROUP_EVALUATION_DEBOUNCE_MS = 250;
const FORWARD_GROUP_EVALUATION_RETRY_BASE_MS = 1_000;
const FORWARD_GROUP_EVALUATION_RETRY_MAX_MS = 30_000;

const forwardGroupEvaluationQueue = new ForwardGroupEvaluationQueue(
  (groupIds) => runForwardGroupFailoverByIds(groupIds, { skipRuleSync: true, deferPublish: true }),
  {
    debounceMs: FORWARD_GROUP_EVALUATION_DEBOUNCE_MS,
    retryBaseMs: FORWARD_GROUP_EVALUATION_RETRY_BASE_MS,
    retryMaxMs: FORWARD_GROUP_EVALUATION_RETRY_MAX_MS,
    onError: (error, retryDelayMs) => {
      console.warn(`[ForwardGroup] queued health evaluation failed; retrying in ${retryDelayMs}ms: ${error instanceof Error ? error.message : String(error)}`);
    },
  },
);

export function scheduleForwardGroupFailover(groupIds: number[]) {
  return forwardGroupEvaluationQueue.enqueue(groupIds);
}

/*
  发布队列：评估算出要写服务商的组在这里按服务商账号排队发布（一个账号同时最多 2 个组）。发布时重新评估一遍
  （这次允许写），所以发出去的总是那一刻的结论；失败按 1～30 秒退避重试。
*/
const forwardGroupPublishQueue = new ForwardGroupPublishQueue(
  (groupId) => runForwardGroupFailoverByIds([groupId], { skipRuleSync: true }),
  {
    concurrency: 2,
    retryBaseMs: FORWARD_GROUP_EVALUATION_RETRY_BASE_MS,
    retryMaxMs: FORWARD_GROUP_EVALUATION_RETRY_MAX_MS,
    onError: (error, context) => {
      console.warn(`[ForwardGroup] DDNS publish failed group=${context.groupId} account=${context.account}; retrying in ${context.retryDelayMs}ms: ${error instanceof Error ? error.message : String(error)}`);
    },
  },
);

/** 等发布队列清空（测试、「立即同步」之后想看结果时用）。 */
export function waitForForwardGroupPublishIdle() {
  return forwardGroupPublishQueue.whenIdle();
}

const forwardGroupHealthRechecks = new ForwardGroupHealthRecheckScheduler(
  (groupId) => { scheduleForwardGroupFailover([groupId]); },
  Date.now,
  setTimeout,
  clearTimeout,
  (error) => {
    console.warn(`[ForwardGroup] delayed health evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
  },
);

export async function primeForwardGroupHostLivenessDeadlines() {
  // 面板从这一刻起算「就绪」：之后一小段时间里不自动把解析换走，等成员主机重新上报（见 forwardGroups/readiness.ts）。
  markForwardGroupPanelReady();
  return primePresenceCapableHosts(await getHosts() as any[]);
}

/** 数据库故障恢复：故障期间 Agent 的请求全被拒了，内存里的存活状态不作数，重新给一段就绪宽限。 */
export function noteForwardGroupDatabaseRecovered(now = Date.now()) {
  markForwardGroupPanelReady(now, { force: true });
  forwardGroupProbeTopology.invalidate();
}
databaseHealth.onRecovered(() => noteForwardGroupDatabaseRecovered());

const lastDdnsEventByKey = new Map<string, string>();
const exactDdnsReconciledGroups = new Map<number, string>();

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
/** 同 dbRuntime 的 rawEpochToDate（原来这里单独抄了一份，负数会落到字符串解析）。 */
const toDate = rawEpochToDate;

function forwardGroupFailoverDelayMs(group: any) {
  const seconds = Number(group?.failoverSeconds || 60);
  return Math.max(10, Number.isFinite(seconds) ? seconds : 60) * 1000;
}

function forwardGroupRecoverDelayMs(group: any) {
  const seconds = Number(group?.recoverSeconds || 120);
  return Math.max(10, Number.isFinite(seconds) ? seconds : 120) * 1000;
}

const forwardGroupRuleProbeFreshMs = FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS;

function freshForwardGroupRuleProbe(stat: any, now: Date) {
  const recordedAt = toDate(stat?.recordedAt);
  if (!recordedAt) return null;
  const age = now.getTime() - recordedAt.getTime();
  if (age < -60_000 || age > forwardGroupRuleProbeFreshMs) return null;
  return stat;
}

type MemberAgentLiveness = {
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
  /** 这台机器最近一次到面板的时刻（毫秒，0 = 没见过）和多久不来算离线：就绪宽限用。 */
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

async function resolveMemberAgentLiveness(member: any, nowMs = Date.now()): Promise<MemberAgentLiveness> {
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
    offlineThresholdMs: fastState ? AGENT_FAST_LIVENESS_SILENCE_MS : HOST_ONLINE_TTL_MS,
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

function agentHealthSampleIsCurrent(liveness: MemberAgentLiveness, sampleAt: unknown) {
  if (!liveness.lastOfflineAt) return true;
  const sampleTime = toDate(sampleAt)?.getTime() || 0;
  return sampleTime > liveness.lastOfflineAt;
}

async function memberAgentSelectionStillCurrent(member: any) {
  if (!member?.agentLivenessSignature) return true;
  const current = await resolveMemberAgentLiveness(member);
  return current.signature === String(member.agentLivenessSignature);
}

function entryAddressForHost(host: any) {
  return String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
}

function manualEntryAddressForHost(host: any) {
  return String(host?.entryIp || "").trim();
}

function normalizeIpCandidate(value: unknown) {
  const text = String(value || "").trim();
  if (text.startsWith("[") && text.endsWith("]")) return text.slice(1, -1).trim();
  return text;
}

function normalizeHostAddressKey(value: unknown) {
  return normalizeIpCandidate(value).toLowerCase();
}

function hostAddressCandidates(host: any) {
  return [host?.entryIp, host?.ipv4, host?.ipv6, host?.ip, host?.tunnelEntryIp]
    .map((value) => normalizeHostAddressKey(value))
    .filter(Boolean);
}

function hostDisplayLabel(host: any, fallback = "") {
  const id = Number(host?.id || 0);
  return String(host?.name || fallback || (id > 0 ? `主机${id}` : "")).trim();
}

async function findHostByAddress(address: unknown) {
  const key = normalizeHostAddressKey(address);
  if (!key) return null;
  const hosts = await getHosts().catch(() => [] as any[]);
  return (hosts as any[]).find((host) => hostAddressCandidates(host).includes(key)) || null;
}

async function forwardChainTargetLabel(template: any) {
  const targetIp = String(template?.targetIp || "").trim();
  const targetPort = Number(template?.targetPort || 0);
  const targetHost = await findHostByAddress(targetIp);
  const hostLabel = hostDisplayLabel(targetHost);
  const ruleLabel = String(template?.name || "").trim();
  return hostLabel || ruleLabel || (targetIp && targetPort > 0 ? `目标 ${targetIp}:${targetPort}` : "目标");
}

function ipv4AddressForHost(host: any) {
  const manual = normalizeIpCandidate(manualEntryAddressForHost(host));
  if (isIP(manual) === 4) return manual;
  const reportedIpv4 = normalizeIpCandidate(host?.ipv4);
  if (isIP(reportedIpv4) === 4) return reportedIpv4;
  const primary = normalizeIpCandidate(host?.ip);
  return isIP(primary) === 4 ? primary : "";
}

function ipv6AddressForHost(host: any) {
  const manual = normalizeIpCandidate(manualEntryAddressForHost(host));
  if (isIP(manual) === 6) return manual;
  const reportedIpv6 = normalizeIpCandidate(host?.ipv6);
  if (isIP(reportedIpv6) === 6) return reportedIpv6;
  const primary = normalizeIpCandidate(host?.ip);
  return isIP(primary) === 6 ? primary : "";
}

function ddnsDomainForHost(host: any) {
  return host?.ddnsEnabled ? String(host?.ddnsDomain || "").trim() : "";
}

function cnameTargetForHost(host: any) {
  const manual = manualEntryAddressForHost(host);
  if (manual && isIP(normalizeIpCandidate(manual)) === 0) return manual;
  return ddnsDomainForHost(host);
}

function normalizeForwardGroupRecordType(recordType: unknown): ForwardGroupRecordType {
  const text = String(recordType || "A").trim().toUpperCase();
  if (text === "AAAA" || text === "CNAME") return text;
  return "A";
}

function recordTypeRequirementLabel(recordType: ForwardGroupRecordType) {
  if (recordType === "AAAA") return "IPv6";
  if (recordType === "CNAME") return "入口域名或 DDNS 域名";
  return "IPv4";
}

function ddnsValueForHostByRecordType(host: any, recordType: ForwardGroupRecordType) {
  if (recordType === "AAAA") return ipv6AddressForHost(host);
  if (recordType === "CNAME") return cnameTargetForHost(host);
  return ipv4AddressForHost(host);
}

function privateAddressForHost(host: any) {
  return String(host?.tunnelEntryIp || "").trim();
}

function ipv6AddressForConnectHost(host: any) {
  return String(host?.ipv6 || "").trim();
}

function isSafeHostAddress(value: string) {
  const text = value.trim();
  return !!text && text.length <= 253 && !/[\s'"<>]/.test(text);
}

// Older SQLite/MySQL rows can contain values written before the runtime
// selector normalized its enum input. Keep generated child rules compatible
// with those rows without changing the persisted data in a sync pass.
function normalizeRuntimeForwardType(value: unknown, fallback = "iptables") {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || fallback;
}

function isCollectionGroupMode(mode: ForwardGroupMode) {
  return mode === "entry" || mode === "exit";
}

function supportsChinaHealthMode(mode: ForwardGroupMode) {
  return mode === "failover" || mode === "entry";
}

function validateForwardGroupModeMembers(groupMode: ForwardGroupMode, groupType: string, members: ForwardGroupMemberInput[], options: { externalEntry?: boolean } = {}) {
  if (groupMode === "port") {
    // 挂了入口组就用组里的主机当入口，自己可以不放成员
    const minMembers = options.externalEntry ? 0 : 1;
    if (members.length < minMembers || members.length > MAX_FORWARD_GROUP_MEMBERS) throw new Error(`端口转发需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台入口主机，或者挂一个入口组`);
    if (String(groupType || "host") !== "host") throw new Error("端口转发仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error("端口转发仅支持主机成员");
  }
  if (groupMode === "chain") {
    const minMembers = options.externalEntry ? 1 : 2;
    if (members.length < minMembers || members.length > MAX_FORWARD_GROUP_MEMBERS) {
      throw new Error(options.externalEntry
        ? `Port forwarding chain requires 1-${MAX_FORWARD_GROUP_MEMBERS} hosts`
        : `Port forwarding chain requires 2-${MAX_FORWARD_GROUP_MEMBERS} hosts`);
    }
    if (groupType !== "host") throw new Error("Port forwarding chain only supports host members");
    if (members.some((member) => member.memberType !== "host")) throw new Error("Port forwarding chain only supports host members");
    return;
  }
  if (isCollectionGroupMode(groupMode)) {
    if (members.length < 1 || members.length > MAX_FORWARD_GROUP_MEMBERS) {
      throw new Error(groupMode === "entry"
        ? `入口组需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台主机`
        : `出口组需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台主机`);
    }
    if (groupType !== "host") throw new Error(groupMode === "entry" ? "入口组仅支持主机成员" : "出口组仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error(groupMode === "entry" ? "入口组仅支持主机成员" : "出口组仅支持主机成员");
  }
}

function normalizeStoredChainConnectHost(rawConnectHost: string | null | undefined, host: any) {
  const raw = String(rawConnectHost || "").trim();
  const publicAddr = entryAddressForHost(host);
  const privateAddr = privateAddressForHost(host);
  const ipv6Addr = ipv6AddressForConnectHost(host);
  if (!raw) return null;
  if (!isSafeHostAddress(raw)) throw new Error("Chain host connect address is invalid");
  if (privateAddr && raw === privateAddr) return privateAddr;
  if (ipv6Addr && raw === ipv6Addr) return ipv6Addr;
  if (publicAddr && raw === publicAddr) return null;
  if (!privateAddr && !ipv6Addr) return null;
  throw new Error("Chain host connect address must use entry address, configured private IP or IPv6");
}

function resolveChainConnectHost(member: any, host: any) {
  const stored = String(member?.connectHost || "").trim();
  const publicAddr = entryAddressForHost(host);
  const privateAddr = privateAddressForHost(host);
  const ipv6Addr = ipv6AddressForConnectHost(host);
  if (stored && privateAddr && stored === privateAddr) return privateAddr;
  if (stored && ipv6Addr && stored === ipv6Addr) return ipv6Addr;
  return publicAddr || stored;
}

async function normalizeForwardGroupMemberInput(
  groupMode: ForwardGroupMode,
  member: ForwardGroupMemberInput,
  index: number,
  options: { externalEntry?: boolean } = {},
): Promise<ForwardGroupMemberInput> {
  if (groupMode === "port") return { ...member, memberType: "host", tunnelId: null, connectHost: null, isEnabled: true };
  if (groupMode === "exit" && member.memberType === "host" && member.hostId) {
    const host = await getHostById(Number(member.hostId));
    if (!host) throw new Error("Host does not exist");
    const requested = String(member.connectHost || "").trim();
    const privateAddr = privateAddressForHost(host);
    const ipv6Addr = ipv6AddressForConnectHost(host);
    return {
      ...member,
      connectHost: requested && privateAddr && requested === privateAddr
        ? privateAddr
        : requested && ipv6Addr && requested === ipv6Addr
          ? ipv6Addr
          : null,
    };
  }
  if (groupMode !== "chain") return { ...member, connectHost: null };
  if (member.memberType !== "host" || !member.hostId) return { ...member, connectHost: null };
  const host = await getHostById(Number(member.hostId));
  if (!host) throw new Error("Host does not exist");
  const hasExternalEntry = !!options.externalEntry;
  return {
    ...member,
    connectHost: index === 0 && !hasExternalEntry ? null : normalizeStoredChainConnectHost(member.connectHost ?? null, host),
  };
}

function sortedMembers(group: any, enabledOnly = false) {
  const members = [...((group as any).members || [])].sort((a, b) => Number(a.priority) - Number(b.priority));
  return enabledOnly ? members.filter((member: any) => dbBool(member?.isEnabled)) : members;
}

/*
  挂了入口组的转发链 / 端口转发（2.3.438 起端口转发也能挂，poouo/Forwardx#15 要的「入口组复用」）：
  入口就是组里启用的主机。端口转发挂入口组时自己不放成员，子规则按入口组每台主机各一条，
  forwardGroupMemberId 记的是入口组的成员 id（forwardGroupRuleIntegrity 认这种）；入口组加减主机
  会经 refreshForwardGroupReferences → syncChainsUsingEntryGroup 重新铺。
*/
async function entryGroupMembersFor(group: any) {
  const mode = forwardGroupModeOf(group);
  return mode === "chain" || mode === "port" ? chainEntryMembers(group) : [];
}

async function chainEntryMembers(group: any) {
  const entryGroupId = Number((group as any)?.entryGroupId || 0);
  if (!entryGroupId) return [] as any[];
  const entryGroup = await getForwardGroupById(entryGroupId) as any;
  if (!entryGroup || forwardGroupModeOf(entryGroup) !== "entry" || !dbBool(entryGroup.isEnabled)) return [] as any[];
  return sortedMembers(entryGroup, true).filter((member: any) => member.memberType === "host");
}

async function syncChainsUsingEntryGroup(entryGroupId: number, options: SyncForwardGroupRulesOptions = {}) {
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

async function groupHostIds(groupId: unknown) {
  const id = Number(groupId || 0);
  if (!Number.isFinite(id) || id <= 0) return [] as number[];
  const group = await getForwardGroupById(id) as any;
  if (!group) return [] as number[];
  return sortedMembers(group)
    .filter((member: any) => member?.memberType === "host")
    .map((member: any) => Number(member.hostId || 0))
    .filter((hostId: number) => Number.isFinite(hostId) && hostId > 0);
}

async function refreshControlledTunnelRuntime(
  tunnel: any,
  reason: string,
  options: { resetRules?: boolean; extraHostIds?: number[] } = {},
) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!Number.isFinite(tunnelId) || tunnelId <= 0) return;
  clearTunnelRuntimeStatus(tunnelId);
  await updateTunnel(tunnelId, { isRunning: false } as any);
  if (options.resetRules) await resetForwardRulesByTunnel(tunnelId);

  const hostIds = new Set<number>(options.extraHostIds || []);
  for (const value of [tunnel?.entryHostId, tunnel?.exitHostId]) {
    const hostId = Number(value || 0);
    if (Number.isFinite(hostId) && hostId > 0) hostIds.add(hostId);
  }
  for (const hostId of await groupHostIds(tunnel?.entryGroupId)) hostIds.add(hostId);
  for (const hostId of await groupHostIds(tunnel?.exitGroupId)) hostIds.add(hostId);

  const hops = await getTunnelHops(tunnelId).catch(() => []);
  for (const hop of hops as any[]) {
    const hostId = Number(hop?.hostId || 0);
    if (Number.isFinite(hostId) && hostId > 0) hostIds.add(hostId);
  }
  const extraExits = await getTunnelExitNodes(tunnelId).catch(() => []);
  for (const node of extraExits as any[]) {
    const hostId = Number(node?.hostId || 0);
    if (Number.isFinite(hostId) && hostId > 0) hostIds.add(hostId);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, `${reason}-tunnel-${tunnelId}`, { urgent: true });
}

/*
  链路的配置变了、但不用重新铺（P9）：出口组只改了分配方式、检测与切换参数，或只调了后面几台出口的
  先后。入口换一份配置就行 —— GOST / Nginx 的配置是按内容比对同步的，FXP 入口（和多跳里挑出口的中转）
  看到自己「没就绪」会带着新规格再下发一次，都不停转发。所以这里不动 tunnels.isRunning、不重置规则，
  只把入口和中转的就绪状态清掉并通知各台来拉配置。出口机的就绪状态留着，免得被连带重装。
*/
async function pushControlledTunnelConfig(
  tunnel: { id?: unknown; entryHostId?: unknown; exitHostId?: unknown; entryGroupId?: unknown } | null | undefined,
  reason: string,
  extraHostIds: number[] = [],
) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!Number.isFinite(tunnelId) || tunnelId <= 0) return;
  const entryHostIds = new Set<number>();
  const entryHostId = Number(tunnel?.entryHostId || 0);
  if (entryHostId > 0) entryHostIds.add(entryHostId);
  for (const hostId of await groupHostIds(tunnel?.entryGroupId)) entryHostIds.add(hostId);
  const exitHostIds = new Set<number>();
  const primaryExitHostId = Number(tunnel?.exitHostId || 0);
  if (primaryExitHostId > 0) exitHostIds.add(primaryExitHostId);
  for (const node of await getTunnelExitNodes(tunnelId).catch(() => []) as Array<{ hostId?: unknown }>) {
    const hostId = Number(node?.hostId || 0);
    if (hostId > 0) exitHostIds.add(hostId);
  }
  // 中转（多跳里除了出口的那几跳）和入口一样要重新拿规格。
  const relayHostIds = new Set<number>();
  for (const hop of await getTunnelHops(tunnelId).catch(() => []) as Array<{ hostId?: unknown }>) {
    const hostId = Number(hop?.hostId || 0);
    if (hostId > 0 && !exitHostIds.has(hostId)) relayHostIds.add(hostId);
  }
  const dispatchHostIds = new Set<number>([...entryHostIds, ...relayHostIds]);
  clearTunnelRuntimeStatusForHosts(tunnelId, Array.from(dispatchHostIds));
  for (const hostId of dispatchHostIds) pushAgentRefresh(hostId, `${reason}-tunnel-${tunnelId}`, { urgent: true });
  for (const hostId of new Set<number>([...exitHostIds, ...extraHostIds])) {
    if (hostId > 0 && !dispatchHostIds.has(hostId)) pushAgentRefresh(hostId, `${reason}-tunnel-${tunnelId}`);
  }
}

async function refreshTunnelsUsingForwardGroup(
  groupId: number,
  groupMode: "entry" | "exit",
  reason: string,
  previousHostIds: number[] = [],
) {
  const id = Number(groupId);
  if (!Number.isFinite(id) || id <= 0) return;
  const allTunnels = await getTunnels() as any[];
  const referenceKey = groupMode === "entry" ? "entryGroupId" : "exitGroupId";
  const affectedTunnels = allTunnels.filter((tunnel: any) => Number(tunnel?.[referenceKey] || 0) === id);
  if (affectedTunnels.length === 0) return;

  const referencedHostIds = Array.from(new Set([
    ...previousHostIds,
    ...await groupHostIds(id),
  ].map(Number).filter((hostId) => Number.isFinite(hostId) && hostId > 0)));

  const group = groupMode === "exit" ? await getForwardGroupById(id) as any : null;
  const exitStrategy = groupMode === "exit" ? normalizeExitGroupStrategy(group?.exitStrategy) : null;
  const exitMembers = group ? sortedMembers(group) : [];
  const hasEnabledExitMember = exitMembers.some((member: any) => member?.memberType === "host" && dbBool(member?.isEnabled));

  for (const tunnel of affectedTunnels) {
    // 入口组的成员变化、出口组加减出口 / 换主出口：要重新铺，照旧标未运行。只是配置变了的走配置下发。
    let reprovision = true;
    if (exitStrategy && group && hasEnabledExitMember) {
      const synced = await syncTunnelExitGroupEndpoints(tunnel, exitMembers, exitStrategy, group?.balanceDetect ?? null);
      Object.assign(tunnel, synced.tunnel);
      reprovision = synced.reprovision;
    } else if (exitStrategy && dbBool(group?.isEnabled)) {
      throw new Error("Enabled exit group must contain at least one enabled host");
    }
    if (reprovision) await refreshControlledTunnelRuntime(tunnel, reason, { resetRules: true, extraHostIds: referencedHostIds });
    else await pushControlledTunnelConfig(tunnel, reason, referencedHostIds);
  }
}

export async function refreshForwardGroupReferences(
  groupId: number,
  options: {
    reason?: string;
    previousHostIds?: number[];
    syncDependentChains?: boolean;
  } = {},
) {
  const group = await getForwardGroupById(Number(groupId));
  const mode = forwardGroupModeOf(group);
  if (mode !== "entry" && mode !== "exit") return;
  if (mode === "entry" && options.syncDependentChains !== false) {
    await syncChainsUsingEntryGroup(Number(groupId));
  }
  await refreshTunnelsUsingForwardGroup(
    Number(groupId),
    mode,
    options.reason || `${mode}-group-updated`,
    options.previousHostIds || [],
  );
}

function describeDdnsTarget(group: any, value: string, provider?: string) {
  const providerLabel = provider ? `provider=${provider}` : "provider=disabled";
  return `${providerLabel} domain=${String(group.domain || "-")} type=${String(group.recordType || "A")} value=${value}`;
}

async function forwardGroupMemberLabel(member: any | null | undefined, fallbackId?: number | null) {
  if (!member) return fallbackId ? `成员 #${fallbackId}` : "";
  if (member.memberType === "host") {
    const host = await evaluationHost(member.hostId).catch(() => null);
    return hostDisplayLabel(host, `主机 #${member.hostId || member.id || fallbackId || "-"}`);
  }
  if (member.memberType === "tunnel") {
    const tunnel = await evaluationTunnel(member.tunnelId).catch(() => null);
    return String((tunnel as any)?.name || `隧道 #${member.tunnelId || member.id || fallbackId || "-"}`).trim();
  }
  return fallbackId ? `成员 #${fallbackId}` : `成员 #${member.id || "-"}`;
}

function normalizeHealthReason(message: unknown) {
  const text = String(message || "").trim();
  if (!text) return "入口不可用";
  if (text.includes("国内健康")) return "国内健康度检测失败";
  if (/timeout/i.test(text)) return "入口延迟探测超时";
  if (/not running/i.test(text)) return "入口规则未运行";
  if (/disabled/i.test(text)) return "入口规则已停用";
  if (/No forwarding rule/i.test(text)) return "入口暂未生成转发规则";
  if (/waiting/i.test(text)) return "等待健康度检测数据";
  return text;
}

function switchNotifySuppressed(options: ForwardGroupFailoverOptions) {
  return !!options.manual || !!options.forcePriority || !!options.forceSync || !!options.suppressSwitchNotify;
}

function groupSwitchNotifyEnabled(group: any) {
  return !!group?.telegramSwitchNotifyEnabled;
}

export async function getForwardGroups(userId?: number, options: { includeRuntime?: boolean; ids?: number[] } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (userId) conditions.push(eq(forwardGroups.userId, userId));
  if (options.ids !== undefined) {
    const ids = Array.from(new Set(options.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
    if (ids.length === 0) return [];
    conditions.push(inArray(forwardGroups.id, ids));
  }
  const query = db.select().from(forwardGroups);
  const groupRows = conditions.length > 0
    ? await query.where(and(...conditions)).orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id))
    : await query.orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id));
  if (groupRows.length === 0) return [];
  const ids = groupRows.map((g: any) => Number(g.id));
  const relatedGroupIds = Array.from(new Set([
    ...ids,
    ...(options.includeRuntime
      ? groupRows.map((group: any) => Number(group.entryGroupId || 0)).filter((id: number) => id > 0)
      : []),
  ]));
  const members = await db
    .select()
    .from(forwardGroupMembers)
    .where(inArray(forwardGroupMembers.groupId, relatedGroupIds))
    .orderBy(asc(forwardGroupMembers.priority));
  const templateRules = await db
    .select({
      id: forwardRules.id,
      forwardGroupId: forwardRules.forwardGroupId,
      isEnabled: forwardRules.isEnabled,
      pendingDelete: forwardRules.pendingDelete,
    })
    .from(forwardRules)
    .where(and(
      inArray(forwardRules.forwardGroupId, ids),
      eq(forwardRules.isForwardGroupTemplate, true),
      eq(forwardRules.pendingDelete, false),
    ));
  const childRules = options.includeRuntime ? await db
    .select({
      id: forwardRules.id,
      hostId: forwardRules.hostId,
      forwardGroupId: forwardRules.forwardGroupId,
      forwardGroupRuleId: forwardRules.forwardGroupRuleId,
      forwardGroupMemberId: forwardRules.forwardGroupMemberId,
      isEnabled: forwardRules.isEnabled,
      isRunning: forwardRules.isRunning,
      pendingDelete: forwardRules.pendingDelete,
    })
    .from(forwardRules)
    .where(and(
      inArray(forwardRules.forwardGroupId, ids),
      eq(forwardRules.isForwardGroupTemplate, false),
      isNotNull(forwardRules.forwardGroupRuleId),
      eq(forwardRules.pendingDelete, false),
    )) : [];
  const templateCountByGroup = new Map<number, number>();
  for (const rule of templateRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    templateCountByGroup.set(groupId, (templateCountByGroup.get(groupId) || 0) + 1);
  }
  await flushPendingWrites("forward_group_latency_stats");
  const latencyRows = await queryRaw<any>(
    `SELECT s.${quoteIdentifier("groupId")}, s.${quoteIdentifier("latencyMs")}, s.${quoteIdentifier("isTimeout")}, s.${quoteIdentifier("recordedAt")}
     FROM ${quoteIdentifier("forward_group_latency_stats")} s
     INNER JOIN (
       SELECT ${quoteIdentifier("groupId")}, MAX(${quoteIdentifier("recordedAt")}) AS ${quoteIdentifier("recordedAt")}
       FROM ${quoteIdentifier("forward_group_latency_stats")}
       WHERE ${quoteIdentifier("groupId")} IN ${inList(ids).sql}
       GROUP BY ${quoteIdentifier("groupId")}
     ) latest ON latest.${quoteIdentifier("groupId")} = s.${quoteIdentifier("groupId")} AND latest.${quoteIdentifier("recordedAt")} = s.${quoteIdentifier("recordedAt")}`,
    ids,
  ).catch(() => []);
  const latestLatencyByGroup = new Map<number, any>();
  for (const row of latencyRows as any[]) {
    latestLatencyByGroup.set(Number(row.groupId), row);
  }
  const groupById = new Map((groupRows as any[]).map((group: any) => [Number(group.id), group]));
  const membersWithHosts = await hydrateForwardGroupMemberEntryAddresses(members as any[]);
  const hydratedMembers = membersWithHosts.map((member: any) => ({
    ...member,
    ddnsValue: ddnsValueForHostByRecordType(
      member.host,
      normalizeForwardGroupRecordType(groupById.get(Number(member.groupId))?.recordType),
    ),
  }));
  const membersByGroupId = new Map<number, any[]>();
  const templatesByGroupId = new Map<number, any[]>();
  const childrenByGroupId = new Map<number, any[]>();
  for (const member of hydratedMembers) {
    const groupId = Number(member.groupId || 0);
    if (!membersByGroupId.has(groupId)) membersByGroupId.set(groupId, []);
    membersByGroupId.get(groupId)!.push(member);
  }
  for (const rule of templateRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    if (!templatesByGroupId.has(groupId)) templatesByGroupId.set(groupId, []);
    templatesByGroupId.get(groupId)!.push(rule);
  }
  for (const rule of childRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    if (!childrenByGroupId.has(groupId)) childrenByGroupId.set(groupId, []);
    childrenByGroupId.get(groupId)!.push(rule);
  }
  return groupRows.map((group: any) => {
    const groupId = Number(group.id);
    const latestLatency = latestLatencyByGroup.get(groupId);
    const groupMembers = membersByGroupId.get(groupId) || [];
    const entryMembers = Number(group.entryGroupId || 0) > 0
      ? membersByGroupId.get(Number(group.entryGroupId)) || []
      : [];
    const runtime = options.includeRuntime
      ? summarizeForwardGroupRuntime({
        group,
        members: groupMembers,
        entryMembers,
        templateRules: templatesByGroupId.get(groupId) || [],
        childRules: childrenByGroupId.get(groupId) || [],
      })
      : null;
    return {
      ...group,
      groupMode: forwardGroupModeOf(group),
      templateRuleCount: templateCountByGroup.get(groupId) || 0,
      ...(runtime ? {
        runtimeStatus: runtime.status,
        runtimeExpectedRuleCount: runtime.expectedRuleCount,
        runtimeConfiguredRuleCount: runtime.configuredRuleCount,
        runtimeRunningRuleCount: runtime.runningRuleCount,
        runtimeFailedRuleCount: runtime.failedRuleCount,
        ruleRuntimeStatuses: runtime.ruleStatuses,
      } : {}),
      latestLatencyMs: latestLatency?.latencyMs !== null && latestLatency?.latencyMs !== undefined
        ? Number(latestLatency.latencyMs)
        : null,
      latestLatencyIsTimeout: Number(latestLatency?.isTimeout || 0) === 1 || latestLatency?.isTimeout === true,
      latestLatencyAt: latestLatency?.recordedAt ?? null,
      members: groupMembers,
    };
  });
}

export type ForwardGroupListQuery = PageRequest & {
  allowedGroupIds?: number[];
  groupMode: "port" | "failover" | "chain" | "entry" | "exit";
  search?: string;
};

function normalizeForwardGroupIds(values: unknown[] | undefined) {
  return Array.from(new Set((values || [])
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function escapeForwardGroupSearchToken(value: string) {
  return value.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

function forwardGroupListCondition(input: {
  allowedGroupIds?: number[];
  groupMode?: ForwardGroupListQuery["groupMode"];
  search?: string;
}) {
  const conditions: any[] = [];
  if (input.allowedGroupIds !== undefined) {
    const allowedIds = normalizeForwardGroupIds(input.allowedGroupIds);
    conditions.push(allowedIds.length > 0 ? inArray(forwardGroups.id, allowedIds) : eq(forwardGroups.id, -1));
  }
  if (input.groupMode) conditions.push(eq(forwardGroups.groupMode, input.groupMode));
  const tokens = String(input.search || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const q = quoteIdentifier;
  for (const token of tokens) {
    const pattern = `%${escapeForwardGroupSearchToken(token)}%`;
    const numeric = /^\d+$/.test(token) ? Number(token) : 0;
    const entryAlias = "entry_group_search";
    conditions.push(or(
      ...[
        forwardGroups.name,
        forwardGroups.remark,
        forwardGroups.groupType,
        forwardGroups.groupMode,
        forwardGroups.forwardType,
        forwardGroups.domain,
        forwardGroups.recordType,
        forwardGroups.targetIp,
        forwardGroups.lastDdnsValue,
        forwardGroups.lastStatus,
        forwardGroups.lastMessage,
      ].map((column) => sql`LOWER(COALESCE(${column}, '')) LIKE ${pattern} ESCAPE '!'`),
      // PG 按列类型推断参数：端口是 INTEGER，超出 int 范围的数字直接报 out of range，整个列表 500。
      ...(Number.isSafeInteger(numeric) && numeric > 0 ? [eq(forwardGroups.id, numeric)] : []),
      ...(numeric > 0 && numeric <= 2147483647 ? [
        eq(forwardGroups.sourcePort, numeric),
        eq(forwardGroups.targetPort, numeric),
      ] : []),
      sql`EXISTS (
        SELECT 1
        FROM ${forwardGroupMembers}
        INNER JOIN ${hosts} ON ${hosts.id} = ${forwardGroupMembers.hostId}
        WHERE ${forwardGroupMembers.groupId} = ${forwardGroups.id}
          AND (
            LOWER(COALESCE(${hosts.name}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ip}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ipv4}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ipv6}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${forwardGroupMembers.connectHost}, '')) LIKE ${pattern} ESCAPE '!'
          )
      )`,
      sql`EXISTS (
        SELECT 1
        FROM ${forwardGroupMembers}
        INNER JOIN ${tunnels} ON ${tunnels.id} = ${forwardGroupMembers.tunnelId}
        WHERE ${forwardGroupMembers.groupId} = ${forwardGroups.id}
          AND (
            LOWER(COALESCE(${tunnels.name}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${tunnels.mode}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${tunnels.connectHost}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${forwardGroupMembers.connectHost}, '')) LIKE ${pattern} ESCAPE '!'
          )
      )`,
      sql`EXISTS (
        SELECT 1
        FROM ${sql.raw(q("forward_groups"))} ${sql.raw(entryAlias)}
        WHERE ${sql.raw(`${entryAlias}.${q("id")}`)} = ${forwardGroups.entryGroupId}
          AND (
            LOWER(COALESCE(${sql.raw(`${entryAlias}.${q("name")}`)}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${sql.raw(`${entryAlias}.${q("remark")}`)}, '')) LIKE ${pattern} ESCAPE '!'
          )
      )`,
    ));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function getForwardGroupsPage(input: ForwardGroupListQuery) {
  const db = await getDb();
  if (!db) return { ...pageResult([], 0, input), scopeTotalItems: 0, enabledItems: 0 };
  const condition = forwardGroupListCondition(input);
  const aggregate = db
    .select({
      totalItems: sql<number>`COUNT(*)`,
      enabledItems: sql<number>`COALESCE(SUM(CASE WHEN ${forwardGroups.isEnabled} = ${sqlBool(true)} THEN 1 ELSE 0 END), 0)`,
    })
    .from(forwardGroups);
  const [totals] = condition ? await aggregate.where(condition) : await aggregate;
  const totalItems = Number(totals?.totalItems || 0);
  const enabledItems = Number(totals?.enabledItems || 0);
  const scopeCondition = forwardGroupListCondition({
    allowedGroupIds: input.allowedGroupIds,
    groupMode: input.groupMode,
  });
  let scopeTotalItems = totalItems;
  if (String(input.search || "").trim()) {
    const scopeQuery = db.select({ count: sql<number>`COUNT(*)` }).from(forwardGroups);
    const [scopeTotals] = scopeCondition ? await scopeQuery.where(scopeCondition) : await scopeQuery;
    scopeTotalItems = Number(scopeTotals?.count || 0);
  }
  const window = pageWindowForTotal(input, totalItems);
  const idQuery = db.select({ id: forwardGroups.id }).from(forwardGroups);
  const idRows = condition
    ? await idQuery.where(condition).orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id)).limit(window.pageSize).offset(window.offset)
    : await idQuery.orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id)).limit(window.pageSize).offset(window.offset);
  const ids = idRows.map((row: any) => Number(row.id));
  const hydrated = ids.length > 0
    ? await getForwardGroups(undefined, { includeRuntime: true, ids })
    : [];
  const byId = new Map((hydrated as any[]).map((group: any) => [Number(group.id), group]));
  const items = ids.map((id: number) => byId.get(id)).filter(Boolean);
  return {
    ...pageResult(items, totalItems, window),
    scopeTotalItems,
    enabledItems,
  };
}

export async function getForwardGroupOptions(allowedGroupIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const condition = forwardGroupListCondition({ allowedGroupIds });
  const query = db.select().from(forwardGroups);
  const rows = condition
    ? await query.where(condition).orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id))
    : await query.orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id));
  if (rows.length === 0) return [];
  const ids = rows.map((group: any) => Number(group.id));
  // 转发链的入口组成员也要拿到：算「应有几个托管监听」时入口组每台主机算一个。
  const relatedGroupIds = Array.from(new Set([
    ...ids,
    ...rows.map((group: any) => Number(group.entryGroupId || 0)).filter((id: number) => id > 0),
  ]));
  const members = await db
    .select()
    .from(forwardGroupMembers)
    .where(inArray(forwardGroupMembers.groupId, relatedGroupIds))
    .orderBy(asc(forwardGroupMembers.priority), asc(forwardGroupMembers.id));
  const hydratedMembers = await hydrateForwardGroupMemberEntryAddresses(members as any[]);
  const membersByGroupId = new Map<number, any[]>();
  for (const member of hydratedMembers) {
    const groupId = Number(member.groupId);
    const list = membersByGroupId.get(groupId) || [];
    list.push(member);
    membersByGroupId.set(groupId, list);
  }
  /*
    每条模板规则「应有几个托管监听、几个已确认在跑」（ruleRuntimeStatuses）。规则页就靠这份
    给组规则画状态点和「3 / 3 个入口在运行」—— 它读的是这个接口，不是带完整运行态的 list。
    端口转发能挂多台入口主机起（2.3.437）尤其需要：一条规则在三台机器上各跑一份，少一份得看得出来。
    多两次按组查规则的开销，和 getForwardGroups({ includeRuntime: true }) 一样。
  */
  const { templatesByGroupId, childrenByGroupId } = await loadForwardGroupRuleRows(ids);
  return rows.map((group: any) => {
    const groupId = Number(group.id);
    const runtime = summarizeForwardGroupRuntime({
      group,
      members: membersByGroupId.get(groupId) || [],
      entryMembers: Number(group.entryGroupId || 0) > 0 ? membersByGroupId.get(Number(group.entryGroupId)) || [] : [],
      templateRules: templatesByGroupId.get(groupId) || [],
      childRules: childrenByGroupId.get(groupId) || [],
    });
    return {
      ...group,
      groupMode: forwardGroupModeOf(group),
      runtimeStatus: runtime.status,
      runtimeExpectedRuleCount: runtime.expectedRuleCount,
      runtimeRunningRuleCount: runtime.runningRuleCount,
      ruleRuntimeStatuses: runtime.ruleStatuses,
      members: membersByGroupId.get(groupId) || [],
    };
  });
}

/** 这些组的模板规则和托管子规则，只取算运行态要的几列，按组分好。 */
async function loadForwardGroupRuleRows(ids: number[]) {
  const db = await getDb();
  const templatesByGroupId = new Map<number, any[]>();
  const childrenByGroupId = new Map<number, any[]>();
  if (!db || ids.length === 0) return { templatesByGroupId, childrenByGroupId };
  const columns = {
    id: forwardRules.id,
    hostId: forwardRules.hostId,
    forwardGroupId: forwardRules.forwardGroupId,
    forwardGroupRuleId: forwardRules.forwardGroupRuleId,
    forwardGroupMemberId: forwardRules.forwardGroupMemberId,
    isEnabled: forwardRules.isEnabled,
    isRunning: forwardRules.isRunning,
    pendingDelete: forwardRules.pendingDelete,
  };
  const templateRules = await db.select(columns).from(forwardRules).where(and(
    inArray(forwardRules.forwardGroupId, ids),
    eq(forwardRules.isForwardGroupTemplate, true),
    eq(forwardRules.pendingDelete, false),
  ));
  const childRules = await db.select(columns).from(forwardRules).where(and(
    inArray(forwardRules.forwardGroupId, ids),
    eq(forwardRules.isForwardGroupTemplate, false),
    isNotNull(forwardRules.forwardGroupRuleId),
    eq(forwardRules.pendingDelete, false),
  ));
  for (const rule of templateRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    if (!templatesByGroupId.has(groupId)) templatesByGroupId.set(groupId, []);
    templatesByGroupId.get(groupId)!.push(rule);
  }
  for (const rule of childRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    if (!childrenByGroupId.has(groupId)) childrenByGroupId.set(groupId, []);
    childrenByGroupId.get(groupId)!.push(rule);
  }
  return { templatesByGroupId, childrenByGroupId };
}

export async function getForwardGroupById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const group = (await db.select().from(forwardGroups).where(eq(forwardGroups.id, id)).limit(1))[0];
  if (!group) return undefined;
  const members = await db
    .select()
    .from(forwardGroupMembers)
    .where(eq(forwardGroupMembers.groupId, id))
    .orderBy(asc(forwardGroupMembers.priority));
  // 批量补齐，别一个成员打两次库。这个函数被路由、校验、故障转移巡检反复调用，
  // 巡检那条尤其吃亏：每 5 分钟按组数线性打库，实测 25 个组要打 276 次，其中
  // 200 次是在这里一条条查主机。
  const hydratedMembers = await hydrateForwardGroupMemberEntryAddresses(members as any[], {
    recordType: normalizeForwardGroupRecordType(group.recordType),
    includeHost: false,
  });
  return { ...group, groupMode: forwardGroupModeOf(group), members: hydratedMembers };
}

export async function getForwardGroupModesByIds(groupIds: number[]) {
  const ids = Array.from(new Set(groupIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)));
  if (ids.length === 0) return [] as Array<{ id: number; groupMode: ForwardGroupMode }>;
  const db = await getDb();
  if (!db) return [] as Array<{ id: number; groupMode: ForwardGroupMode }>;
  const rows = await db
    .select({ id: forwardGroups.id, groupMode: forwardGroups.groupMode })
    .from(forwardGroups)
    .where(inArray(forwardGroups.id, ids));
  return (rows as any[]).map((group) => ({
    id: Number(group.id),
    groupMode: forwardGroupModeOf(group),
  }));
}

export async function getForwardGroupEvents(groupId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardGroupEvents)
    .where(eq(forwardGroupEvents.groupId, groupId))
    .orderBy(desc(forwardGroupEvents.createdAt))
    .limit(limit);
}

export async function cleanOldForwardGroupEvents(retainHours = 72) {
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("forward_group_events")} WHERE ${quoteIdentifier("createdAt")} < ?`,
    [cutoff],
  );
}

async function withForwardChainTargetLabel(test: any, template: any) {
  if (!test?.message || !template) return test;
  const targetIp = String(template?.targetIp || "").trim();
  const targetPort = Number(template?.targetPort || 0);
  if (!targetIp || targetPort <= 0) return test;
  const targetLabel = await forwardChainTargetLabel(template);
  const oldTarget = `目标 ${targetIp}:${targetPort}`;
  if (!targetLabel || targetLabel === oldTarget || !String(test.message).includes(oldTarget)) return test;
  try {
    const parsed = JSON.parse(String(test.message));
    if (Array.isArray(parsed?.details)) {
      parsed.details = parsed.details.map((detail: any) => ({
        ...detail,
        routeLabel: typeof detail?.routeLabel === "string" ? detail.routeLabel.replace(oldTarget, targetLabel) : detail?.routeLabel,
        hopLabel: typeof detail?.hopLabel === "string" ? detail.hopLabel.replace(oldTarget, targetLabel) : detail?.hopLabel,
      }));
      if (typeof parsed.message === "string") parsed.message = parsed.message.replaceAll(oldTarget, targetLabel);
      return { ...test, message: JSON.stringify(parsed) };
    }
  } catch {
    // Older records may be plain text; fall back to a direct replacement.
  }
  return { ...test, message: String(test.message).replaceAll(oldTarget, targetLabel) };
}

export async function getLatestForwardGroupTest(groupId: number, options: { includeActive?: boolean } = {}) {
  const templates = await getForwardGroupTemplateRules(groupId);
  const templateIds = (templates as any[]).map((rule: any) => Number(rule.id)).filter((id: number) => id > 0);
  const table = quoteIdentifier("forward_tests");
  const idCol = quoteIdentifier("id");
  const ruleCol = quoteIdentifier("ruleId");
  const updatedCol = quoteIdentifier("updatedAt");
  const createdCol = quoteIdentifier("createdAt");
  const messageCol = quoteIdentifier("message");
  const normalizedGroupId = Number(groupId);
  const groupNeedleWithTrailingField = `%"groupId":${normalizedGroupId},%`;
  const groupNeedleAtObjectEnd = `%"groupId":${normalizedGroupId}}%`;
  const ruleFilter = templateIds.length > 0
    ? `${ruleCol} IN ${inList(templateIds).sql} OR `
    : "";
  const filterSql = `(${ruleFilter}${messageCol} LIKE ? OR ${messageCol} LIKE ?)`;
  const filterArgs: any[] = [...templateIds, groupNeedleWithTrailingField, groupNeedleAtObjectEnd];
  const template = (templates as any[])[0] || null;
  if (options.includeActive !== false) {
    const pendingRows = await queryRaw<any>(
      `SELECT * FROM ${table} WHERE ${filterSql} AND ${quoteIdentifier("status")} IN ('pending', 'running') ORDER BY ${updatedCol} DESC, ${createdCol} DESC, ${idCol} DESC LIMIT 1`,
      filterArgs,
    );
    if (pendingRows[0]) return withForwardTestDates(await withForwardChainTargetLabel(pendingRows[0], template));
  }
  const rows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${filterSql} AND ${quoteIdentifier("status")} IN ('success', 'failed', 'timeout') ORDER BY ${updatedCol} DESC, CASE WHEN ${messageCol} LIKE '%forward-chain-hop-summary%' THEN 0 ELSE 1 END, ${createdCol} DESC, ${idCol} DESC LIMIT 1`,
    filterArgs,
  );
  return withForwardTestDates(await withForwardChainTargetLabel(rows[0], template));
}

export async function getForwardGroupPrimaryTemplateRule(groupId: number) {
  const templates = await getForwardGroupTemplateRules(groupId);
  return (templates as any[])[0] || null;
}

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

type ForwardGroupProbeTopologySnapshot = {
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
function peerReferenceTarget(group: any): ForwardGroupPeerGroupTopology["reference"] {
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

  const membersByGroupId = new Map<number, any[]>();
  for (const member of memberRows as any[]) {
    const id = Number(member.groupId || 0);
    const members = membersByGroupId.get(id) || [];
    members.push(member);
    membersByGroupId.set(id, members);
  }
  const groups = (groupRows as any[]).map((group) => ({
    ...group,
    groupMode: forwardGroupModeOf(group),
    members: membersByGroupId.get(Number(group.id)) || [],
  }));
  const groupById = new Map<number, any>();
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
  for (const host of hostRows as any[]) {
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
  // 不再安排的观察关系，结果表里的旧结论丢掉。
  forwardGroupPeerObservations.prune((observerHostId, groupId, memberId) => {
    const peer = snapshot.peerByGroup.get(groupId);
    if (!peer || !peer.observerHostIds.has(observerHostId)) return false;
    return memberId === PEER_REFERENCE_MEMBER_ID || !!peer.assignments.get(memberId)?.observerHostIds.includes(observerHostId);
  });
  return snapshot;
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
    peerGroups: any[];
    hostById: Map<number, any>;
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
  for (const row of dependentRows as any[]) entryGroupByDependentId.set(Number(row.id), Number(row.entryGroupId || 0));
  const entryGroupByTunnelId = new Map<number, number>();
  for (const row of entryTunnelRows as any[]) entryGroupByTunnelId.set(Number(row.id), Number(row.entryGroupId || 0));

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
  for (const rule of ruleRows as any[]) {
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
    for (const member of sortedMembers(group, true) as any[]) {
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
const forwardGroupProbeTopology = new TopologyCache(buildForwardGroupProbeTopologySnapshot, FORWARD_GROUP_PROBE_TOPOLOGY_TTL_MS);

/** 组、成员、主机地址改了：探测拓扑立刻作废（下一次心跳 / 上报 / 评估重建）。 */
export function invalidateForwardGroupProbeTopology() {
  forwardGroupProbeTopology.invalidate();
}

/** 改组 / 改成员的函数收尾时调：现在作废一次；还在事务里的话，事务结束后再作废一次（期间重建的那份读的可能是提交前的数据）。 */
function invalidateForwardGroupProbeTopologyAfterChange() {
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
function peerObserverOnline(hostId: number) {
  const state = getPresenceCapableHostLivenessSnapshot(hostId);
  return !!state && !state.confirmedOffline;
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
async function evaluateMemberPeerHealth(group: any, member: any, agentOnline: boolean, now: number) {
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
    await db.update(forwardGroupMembers).set({ externalHealth: nextStored } as any).where(eq(forwardGroupMembers.id, memberId));
    member.externalHealth = nextStored;
  }
  return health;
}

function sameProbeAddress(left: unknown, right: unknown) {
  return normalizeHostAddressKey(left) === normalizeHostAddressKey(right);
}

/**
 * 观察点报上来的外部观察结果（TCPing 上报里 probeType = "peer" 的那些）。只进内存；结论变了就重新评估那个组。
 * 上报必须对得上拓扑里的安排：这台机器确实被安排探这个成员的这个地址和端口，否则丢掉。返回收下的条数。
 */
export async function ingestForwardGroupPeerReports(hostIdValue: unknown, reports: ReadonlyArray<{
  groupId?: unknown;
  memberId?: unknown;
  targetIp?: unknown;
  targetPort?: unknown;
  method?: unknown;
  isTimeout?: unknown;
  latencyMs?: unknown;
}>, now = Date.now()) {
  const hostId = Number(hostIdValue || 0);
  if (!(hostId > 0) || reports.length === 0) return 0;
  const snapshot = await forwardGroupProbeTopology.get();
  const changedGroupIds = new Set<number>();
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
  if (changedGroupIds.size > 0) scheduleForwardGroupFailover(Array.from(changedGroupIds));
  return accepted;
}

/**
 * 给组列表 / 详情的成员挂上外部观察的现状（peerHealth）：自己报告的健康在 healthStatus，这里是别的机器看到的。
 * 只读内存；拓扑缓存过期时会重建一次。没安排观察点的成员是 null。
 */
export async function attachForwardGroupPeerHealth<T extends { id?: unknown; groupMode?: unknown; members?: any[] | null; failoverSeconds?: unknown }>(groups: T[]): Promise<T[]> {
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
          // 列表上没有完整的存活判定：确认离线才算离线，其余按在线（只影响「面板连不上，访客可达」那句提示）。
          agentOnline: fastState ? !fastState.confirmedOffline : member?.host?.isOnline !== false,
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

export async function getForwardGroupChinaHealthProbesForHost(hostId: number) {
  const groups = await getForwardGroups() as any[];
  const probes: ForwardGroupChinaHealthProbe[] = [];
  for (const group of groups) {
    if (!dbBool(group?.isEnabled) || !supportsChinaHealthMode(forwardGroupModeOf(group)) || !dbBool(group?.chinaHealthCheckEnabled)) continue;
    const healthMethod = normalizeForwardGroupHealthCheckMethod(group.chinaHealthCheckMethod);
    let target;
    try {
      target = normalizeChinaHealthTarget(group.chinaHealthCheckTarget, healthMethod);
    } catch (error) {
      appendPanelLog("warn", `[ForwardGroup] china health target invalid group=${group.id} target=${String(group.chinaHealthCheckTarget || "-")}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const member of sortedMembers(group, true) as any[]) {
      const entryHostId = await memberEntryHostId(member).catch(() => 0);
      if (Number(entryHostId) !== Number(hostId)) continue;
      probes.push({
        groupId: Number(group.id),
        memberId: Number(member.id),
        fromHostId: Number(entryHostId),
        targetIp: target.host,
        targetPort: target.port,
        method: healthMethod,
        probeType: "china",
        failoverSeconds: Math.max(10, Number(group.failoverSeconds || 60)),
        recoverSeconds: Math.max(10, Number(group.recoverSeconds || 120)),
      });
    }
  }
  return probes;
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
    const group = await getForwardGroupById(Number(input.groupId)) as any;
    if (!group || !dbBool(group.chinaHealthCheckEnabled) || !supportsChinaHealthMode(forwardGroupModeOf(group))) return false;
    const member = (group.members || []).find((item: any) => Number(item.id) === Number(input.memberId));
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
  } as any).where(eq(forwardGroupMembers.id, memberId));
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

/** 给组外的模块记一条组事件（例如按可用时段切换成员）。 */
export async function recordForwardGroupEvent(groupId: number, memberId: number | null, type: string, message: string) {
  return insertForwardGroupEvent(groupId, memberId, type, message);
}

async function insertForwardGroupEvent(groupId: number, memberId: number | null, type: string, message: string) {
  if (type.startsWith("ddns-")) {
    const truncated = message.slice(0, 500);
    const key = `${groupId}:${memberId ?? "-"}:${type}`;
    if (lastDdnsEventByKey.get(key) === truncated) {
      return;
    }
    lastDdnsEventByKey.set(key, truncated);
    message = truncated;
  }
  const level = type.includes("error") ? "error" : type.includes("skip") ? "warn" : "info";
  appendPanelLog(level, `[DDNS] group=${groupId} member=${memberId ?? "-"} type=${type} ${message}`);
  await insertAndGetId("forward_group_events", {
    groupId,
    memberId,
    type,
    message: message.slice(0, 500),
    createdAt: nowDate(),
  });
}

/**
 * 一次把一批成员的入口地址补齐，而不是一个成员打一次库。
 *
 * 成员要么挂主机、要么挂隧道（隧道再落到它的入口主机），所以只要两条 inArray：
 * 先把隧道的入口主机 id 查出来，再把所有涉及的主机一次查回来。
 *
 * recordType 给了就顺带算 ddnsValue —— 它和 entryAddress 读的是同一批主机字段，
 * 分两次算就等于把同一批主机再查一遍。实测：转发组详情页原来每个主机成员要打
 * **两次**主机查询（entryAddress 一次、ddnsValue 一次），隧道成员四次。
 */
async function hydrateForwardGroupMemberEntryAddresses(
  members: any[],
  options: { recordType?: ForwardGroupRecordType; includeHost?: boolean } = {},
) {
  if (members.length === 0) return [];
  const db = await getDb();
  if (!db) return members;

  const tunnelIds = Array.from(new Set(members
    .filter((member) => member?.memberType === "tunnel")
    .map((member) => Number(member?.tunnelId || 0))
    .filter((id) => id > 0)));
  const tunnelRows = tunnelIds.length > 0
    ? await db.select({ id: tunnels.id, entryHostId: tunnels.entryHostId })
      .from(tunnels)
      .where(inArray(tunnels.id, tunnelIds))
    : [];
  const tunnelEntryHostById = new Map((tunnelRows as any[])
    .map((tunnel) => [Number(tunnel.id), Number(tunnel.entryHostId || 0)]));
  const hostIds = Array.from(new Set(members
    .map((member) => member?.memberType === "host"
      ? Number(member?.hostId || 0)
      : tunnelEntryHostById.get(Number(member?.tunnelId || 0)) || 0)
    .filter((id) => id > 0)));
  const hostRows = hostIds.length > 0
    ? await db.select({
      id: hosts.id,
      name: hosts.name,
      entryIp: hosts.entryIp,
      ipv4: hosts.ipv4,
      ipv6: hosts.ipv6,
      ip: hosts.ip,
      tunnelEntryIp: hosts.tunnelEntryIp,
      ddnsEnabled: hosts.ddnsEnabled,
      ddnsDomain: hosts.ddnsDomain,
      isOnline: hosts.isOnline,
      trafficFailoverEnabled: hosts.trafficFailoverEnabled,
      trafficFailoverExcluded: hosts.trafficFailoverExcluded,
      trafficLimit: hosts.trafficLimit,
      lastHeartbeat: hosts.lastHeartbeat,
    }).from(hosts).where(inArray(hosts.id, hostIds))
    : [];
  const hostById = new Map((hostRows as any[]).map((host) => [Number(host.id), host]));

  return members.map((member) => {
    const hostId = member?.memberType === "host"
      ? Number(member?.hostId || 0)
      : tunnelEntryHostById.get(Number(member?.tunnelId || 0)) || 0;
    const host = hostById.get(hostId);
    return {
      ...member,
      entryAddress: entryAddressForHost(host),
      ...(options.recordType ? { ddnsValue: ddnsValueForHostByRecordType(host, options.recordType) } : {}),
      // host 这一层是给列表页用的。详情页不要 —— 它的返回结构是一大票调用方
      // （路由、校验、故障转移）在吃的，凭空多挂一个主机对象不值当冒这个险。
      ...(options.includeHost === false ? {} : {
        host: hostById.has(hostId) ? {
          ...host,
          isOnline: !!host?.isOnline && isFreshHostHeartbeat(host?.lastHeartbeat),
        } : null,
      }),
    };
  });
}

async function memberDdnsValue(member: any, recordType: ForwardGroupRecordType) {
  if (member.memberType === "host") {
    const host = await evaluationHost(member.hostId);
    return ddnsValueForHostByRecordType(host, recordType);
  }
  if (member.memberType === "tunnel") {
    const tunnel = await evaluationTunnel(member.tunnelId);
    if (!tunnel) return "";
    const entry = await evaluationHost(tunnel.entryHostId);
    return ddnsValueForHostByRecordType(entry, recordType);
  }
  return "";
}

async function failoverAgentSelectionStillCurrent(group: any, active: any, next: any) {
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
    const group = await getForwardGroupById(Number(input.groupId)) as any;
    if (!group || forwardGroupModeOf(group) !== "entry" || dbBool(group.chinaHealthCheckEnabled)) return false;
    const member = (group.members || []).find((item: any) => Number(item.id) === Number(input.memberId));
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

async function firstAvailableResolvableMember(members: any[], group: any, recordType: ForwardGroupRecordType) {
  const chinaHealthEnabled = dbBool(group?.chinaHealthCheckEnabled);
  const now = Date.now();
  const failoverMs = forwardGroupFailoverDelayMs(group);
  const activeMemberId = Number(group?.activeMemberId || 0);
  let pendingChinaHealth = false;
  for (const member of members) {
    if (!dbBool(member?.isEnabled, true)) continue;
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (!value) continue;
    const liveness = await resolveMemberAgentLiveness(member, now);
    // 流量到阈值的成员直接跳过，不像离线那样还给当前成员留一段宽限期。
    if (liveness.trafficExcluded) continue;
    if (!liveness.available) {
      const failoverAt = (liveness.failureSince?.getTime() || now) + failoverMs;
      if (Number(member.id || 0) === activeMemberId && now < failoverAt) {
        return {
          member: { ...member, agentLivenessSignature: liveness.signature },
          value,
          pendingChinaHealth,
          agentFailurePending: true,
          agentLivenessRecheckAt: failoverAt,
        };
      }
      continue;
    }
    if (chinaHealthEnabled) {
      if (!agentHealthSampleIsCurrent(liveness, member.chinaHealthCheckedAt)) {
        pendingChinaHealth = true;
        continue;
      }
      const state = forwardGroupChinaHealthStateAt(member, now);
      if (state === "pending") {
        pendingChinaHealth = true;
        continue;
      }
      if (state !== "healthy") continue;
    }
    return {
      member: { ...member, agentLivenessSignature: liveness.signature },
      value,
      pendingChinaHealth,
      agentFailurePending: false,
      agentLivenessRecheckAt: null,
    };
  }
  return {
    member: null,
    value: "",
    pendingChinaHealth,
    agentFailurePending: false,
    agentLivenessRecheckAt: null,
  };
}

export async function validateForwardGroupRecordMembers(group: any, members: ForwardGroupMemberInput[] | any[]) {
  const mode = forwardGroupModeOf(group);
  if (mode !== "failover" && mode !== "entry") return;
  const recordType = normalizeForwardGroupRecordType((group as any)?.recordType);
  const requirement = recordTypeRequirementLabel(recordType);
  const label = mode === "entry" ? "入口组" : "转发组";
  const missing: string[] = [];
  for (const member of members || []) {
    if (!dbBool(member?.isEnabled, true)) continue;
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (value) continue;
    let name = "";
    if (member.memberType === "host") {
      const host = await getHostById(Number(member.hostId)).catch(() => null);
      name = String((host as any)?.name || `主机 #${member.hostId}`);
    } else {
      const tunnel = await getTunnelById(Number(member.tunnelId)).catch(() => null);
      name = String((tunnel as any)?.name || `隧道 #${member.tunnelId}`);
    }
    missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`${label}使用 ${recordType} 记录时，所有启用成员都需要配置${requirement}：${missing.slice(0, 5).join("、")}`);
  }
}

async function targetHostIdForMember(member: ForwardGroupMemberInput) {
  if (member.memberType === "host") {
    if (!member.hostId) throw new Error("Forward group member host is required");
    const host = await getHostById(Number(member.hostId));
    if (!host) throw new Error("Host does not exist");
    return Number(host.id);
  }
  if (!member.tunnelId) throw new Error("Forward group member tunnel is required");
  const tunnel = await getTunnelById(Number(member.tunnelId));
  if (!tunnel) throw new Error("Tunnel does not exist");
  return Number(tunnel.entryHostId);
}

async function memberEntryHostId(member: any) {
  if (member.memberType === "host") return Number(member.hostId || 0);
  const tunnel = await evaluationTunnel(member.tunnelId);
  return Number(tunnel?.entryHostId || 0);
}

/**
 * 成员子规则实际在哪些主机上监听入口端口：主机成员就是它自己；隧道成员是隧道入口机，隧道挂了
 * 入口组时还有组里每台启用的主机（子规则带着 tunnelId，下发时这些主机都会替它监听）。
 * 查占用、预留端口都要覆盖这整组，只查入口机会和成员机上同端口的规则撞上。
 */
async function memberListenHostIds(member: any): Promise<number[]> {
  if (member.memberType === "host") {
    const hostId = Number(member.hostId || 0);
    return hostId > 0 ? [hostId] : [];
  }
  const tunnel = await getTunnelById(Number(member.tunnelId));
  return tunnel ? tunnelRuleListenHostIds(tunnel) : [];
}

/**
 * Which listener a failover-group rule's self-test must probe: the child rule
 * of the member that currently carries the traffic (activeMemberId), never the
 * template's historical host metadata. Without an active member and without a
 * DDNS domain any live member's listener is equivalent. Throws instead of
 * testing a standby while the actual active route is offline.
 */
export async function getForwardGroupRuleForSelfTest(template: any, group: any) {
  if (!group || !dbBool(group.isEnabled)) throw new Error("转发组不存在或已停用");
  if (forwardGroupModeOf(group) !== "failover") throw new Error("此转发组不支持单入口链路测试");
  const members = forwardGroupRouteMembers(group);
  const activeMemberId = Number(group.activeMemberId || 0);
  const candidates = activeMemberId > 0
    ? members.filter((member) => Number(member.id) === activeMemberId)
    : group.domain ? [] : members;
  const children = await getForwardGroupChildRulesForTemplate(Number(template.id)) as any[];
  for (const member of candidates) {
    const liveness = await resolveMemberAgentLiveness(member);
    if (!liveness.available) continue;
    const tunnelId = member.memberType === "tunnel" ? Number(member.tunnelId || 0) : 0;
    const child = children.find((rule) => !dbBool(rule.pendingDelete)
      && dbBool(rule.isEnabled)
      && Number(rule.forwardGroupId) === Number(group.id)
      && Number(rule.forwardGroupMemberId) === Number(member.id)
      && Number(rule.hostId) === liveness.hostId
      && Number(rule.tunnelId || 0) === tunnelId);
    if (child) return { rule: child, memberId: Number(member.id), groupId: Number(group.id) };
  }
  throw new Error("转发组当前没有可测试的活动入口，请等待故障切换完成后重试");
}

export async function getForwardGroupDefaultHostId(groupId: number) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  for (const member of await entryGroupMembersFor(group)) {
    const hostId = await memberEntryHostId(member);
    if (hostId) return hostId;
  }
  const members = sortedMembers(group);
  for (const member of members) {
    if (!dbBool(member?.isEnabled)) continue;
    const hostId = await memberEntryHostId(member);
    if (hostId) return hostId;
  }
  for (const member of members) {
    const hostId = await memberEntryHostId(member);
    if (hostId) return hostId;
  }
  throw new Error("Forward group has no valid entry agent");
}

/**
 * 删主机前修转发组模板上过期的主机引用（照上游 poouo/Forwardx 的
 * repairForwardGroupTemplateHostReferencesForHost 移植）。
 *
 * 故障转移 / 转发链的模板从不下发到 Agent，hostId 只是元数据；组里的成员换掉以后它还指着老机器，
 * 删那台老机器时 getHostRuleDeleteBlockers 会把这条模板算成「转发组规则引用」挡住删除，而用户
 * 在界面上根本找不到这条引用。这里只把「这台机器已经不是组里成员」的模板改指向组里现在的
 * 默认入口机：不动子规则、不重铺运行时。端口转发的模板由 repairPortForwardRuleHostReferences 修，
 * 入口组 / 出口组没有模板。组里一台可用的机器都没有时保持原样（照上游）。
 */
export async function repairForwardGroupTemplateHostReferencesForHost(hostIdValue: number) {
  const hostId = Number(hostIdValue || 0);
  const db = await getDb();
  if (!db || !Number.isInteger(hostId) || hostId <= 0) return 0;
  const rows = await db.selectDistinct({ groupId: forwardRules.forwardGroupId })
    .from(forwardRules)
    .where(and(
      eq(forwardRules.hostId, hostId),
      eq(forwardRules.isForwardGroupTemplate, true),
      eq(forwardRules.pendingDelete, false),
      isNotNull(forwardRules.forwardGroupId),
    ));
  let repaired = 0;
  for (const row of rows as any[]) {
    const groupId = Number(row.groupId || 0);
    if (groupId <= 0) continue;
    repaired += await withKeyedTaskLock(`forward-group-sync:${groupId}`, async () => {
      const group = await getForwardGroupById(groupId);
      if (!group) return 0;
      const groupMode = forwardGroupModeOf(group);
      if (isCollectionGroupMode(groupMode) || groupMode === "port") return 0;
      const memberHostIds = new Set<number>();
      for (const member of [...sortedMembers(group), ...await entryGroupMembersFor(group)]) {
        const memberHostId = await memberEntryHostId(member).catch(() => 0);
        if (memberHostId > 0) memberHostIds.add(memberHostId);
      }
      if (memberHostIds.has(hostId)) return 0;
      const nextHostId = await getForwardGroupDefaultHostId(groupId).catch(() => 0);
      if (!nextHostId || nextHostId === hostId) return 0;
      const stale = (await getForwardGroupTemplateRules(groupId) as any[])
        .filter((rule) => Number(rule.hostId) === hostId)
        .map((rule) => Number(rule.id));
      if (stale.length === 0) return 0;
      await db.update(forwardRules).set({ hostId: nextHostId, updatedAt: nowDate() } as any).where(and(
        inArray(forwardRules.id, stale),
        eq(forwardRules.forwardGroupId, groupId),
        eq(forwardRules.isForwardGroupTemplate, true),
        eq(forwardRules.pendingDelete, false),
      ));
      appendPanelLog("info", `[ForwardGroup] template host references repaired group=${groupId} from=${hostId} to=${nextHostId} count=${stale.length}`);
      return stale.length;
    });
  }
  return repaired;
}

export async function getForwardGroupRuleEntryHostIds(groupId: number) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const members = sortedMembers(group);
  const enabledMembers = members.filter((member: any) => dbBool(member?.isEnabled));
  const groupMode = forwardGroupModeOf(group);
  const chainEntries = await entryGroupMembersFor(group);
  // Only the public edge uses the user-selected source port. Downstream chain
  // listeners are allocated independently inside each member's port policy.
  const portMembers = groupMode === "chain"
    ? (chainEntries.length > 0 ? chainEntries : enabledMembers.slice(0, 1))
    : (chainEntries.length > 0 ? chainEntries : members);
  const hostIds = (await Promise.all(portMembers
    .filter((member: any) => dbBool(member?.isEnabled, true))
    .map((member: any) => memberListenHostIds(member)))).flat();
  return Array.from(new Set(hostIds.filter((hostId) => Number.isInteger(hostId) && hostId > 0)))
    .sort((left, right) => left - right);
}

async function existingChildRule(templateRuleId: number, memberId: number, hostId?: number | null) {
  const db = await getDb();
  const conds: any[] = [
    eq(forwardRules.forwardGroupRuleId, templateRuleId),
    eq(forwardRules.forwardGroupMemberId, memberId),
  ];
  if (hostId) conds.push(eq(forwardRules.hostId, Number(hostId)));
  const rows = await db.select().from(forwardRules).where(and(...conds)).limit(1);
  return rows[0];
}

async function isPortUsedOnHostForGroupChild(hostId: number, sourcePort: number, ignoreRuleIds: number[], protocol?: unknown, sourcePortEnd?: unknown) {
  // 端口段模板：段里任何一个端口被占都算（一次取齐这台机器的占用，不逐个端口查）。
  const end = normalizeSourcePortEnd(sourcePort, sourcePortEnd);
  if (end) return (await findUsedPortInRangeOnHost(hostId, sourcePort, end, ignoreRuleIds, protocol)) !== null;
  return isPortUsedOnHost(hostId, sourcePort, ignoreRuleIds, protocol, undefined, false);
}

async function entryPortPolicyForMember(member: any): Promise<{ hostId: number; policy: PortPolicy }> {
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(member.tunnelId));
    if (!tunnel) throw new Error("Tunnel does not exist");
    const entryHost = await getHostById(Number((tunnel as any).entryHostId || 0));
    if (!entryHost) throw new Error("Tunnel entry host does not exist");
    return {
      hostId: Number((tunnel as any).entryHostId || 0),
      policy: combineHostPortPolicyWithRange(
        entryHost as any,
        (tunnel as any).portRangeStart,
        (tunnel as any).portRangeEnd,
      ),
    };
  }
  const host = await getHostById(Number(member.hostId));
  if (!host) throw new Error("Host does not exist");
  return {
    hostId: Number(host.id || 0),
    policy: portPolicyFrom(host as any),
  };
}

async function assertEntryPortAllowed(member: any, sourcePort: number, sourcePortEnd?: unknown) {
  const entry = await entryPortPolicyForMember(member);
  const end = normalizeSourcePortEnd(sourcePort, sourcePortEnd) ?? sourcePort;
  for (let port = sourcePort; port <= end; port += 1) {
    if (!isPortAllowedByPolicy(port, entry.policy)) {
      throw new Error(portPolicyErrorMessage(entry.policy, "入口端口"));
    }
  }
}

function policyHasRestrictionForGroup(policy: PortPolicy) {
  return !!policy.denyAll
    || (policy.rangeStart !== null && policy.rangeEnd !== null)
    || (policy.ranges?.length || 0) > 0
    || policy.allowlist.length > 0;
}

function longestContiguousRange(ports: number[]) {
  const sorted = Array.from(new Set(ports)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  let bestStart = sorted[0];
  let bestEnd = sorted[0];
  let runStart = sorted[0];
  let previous = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    if (previous - runStart > bestEnd - bestStart) {
      bestStart = runStart;
      bestEnd = previous;
    }
    runStart = current;
    previous = current;
  }
  return { start: bestStart, end: bestEnd };
}

function policyRangeForGroup(policy: PortPolicy) {
  if (policy.denyAll) return null;
  if (!policyHasRestrictionForGroup(policy)) return { start: 10000, end: 65535 };
  const candidates = [
    ...(policy.rangeStart !== null && policy.rangeEnd !== null
      ? Array.from({ length: policy.rangeEnd - policy.rangeStart + 1 }, (_, index) => policy.rangeStart! + index)
      : []),
    ...policy.allowlist,
    ...(policy.ranges || []).flatMap((range) => {
      const ports: number[] = [];
      for (let port = range.start; port <= range.end; port += 1) ports.push(port);
      return ports;
    }),
  ];
  return longestContiguousRange(candidates);
}

function candidatePortsForGroup(policy: PortPolicy) {
  if (policy.denyAll) return [];
  const ports: number[] = [];
  const portSet = new Set<number>();
  const addPort = (port: number) => {
    if (portSet.has(port)) return;
    portSet.add(port);
    ports.push(port);
  };
  if (!policyHasRestrictionForGroup(policy)) {
    for (let port = 10000; port <= 65535; port++) addPort(port);
    return ports;
  }
  if (policy.rangeStart !== null && policy.rangeEnd !== null) {
    for (let port = policy.rangeStart; port <= policy.rangeEnd; port++) addPort(port);
  }
  for (const range of policy.ranges || []) {
    for (let port = range.start; port <= range.end; port++) {
      addPort(port);
    }
  }
  for (const port of policy.allowlist) {
    addPort(port);
  }
  return ports.filter((port) => isPortAllowedByPolicy(port, policy));
}

/**
 * 一个转发组的入口端口到底允许哪些 —— 组里每个「要占端口」的成员各有一份
 * 策略（主机自己的范围与白名单；隧道成员还要叠上隧道范围），取交集。
 *
 * 之所以抽出来：这段循环原本在仓库里存在**三份**（取范围、找可用端口、
 * 校验规则各一份），而界面上又完全没有，转发组模式的「允许端口范围」
 * 一直显示「不限制」。
 *
 * 成员的选法照抄 validateForwardGroupRuleConfig —— 判定接不接受一个端口的
 * 就是它，显示和校验必须用同一批成员，否则又是一份会漂开的答案。
 *
 * 逐个成员放行 ≡ 合并后放行：这一点不是想当然，随机造了 4000 组成员策略
 * 比了 40 万次，两边结论完全一致（见 forwardGroupPortPolicy.test.ts）。
 */
export async function forwardGroupEntryPortPolicy(group: any): Promise<PortPolicy> {
  const members = sortedMembers(group);
  const groupMode = forwardGroupModeOf(group);
  const chainEntries = await entryGroupMembersFor(group);
  const portCheckMembers = groupMode === "chain"
    ? (chainEntries.length > 0 ? chainEntries : members.filter((member: any) => dbBool(member?.isEnabled)).slice(0, 1))
    : (chainEntries.length > 0 ? chainEntries : members);
  let policy = portPolicyFrom(null);
  for (const member of portCheckMembers) {
    if (!dbBool(member?.isEnabled)) continue;
    const entry = await entryPortPolicyForMember(member);
    policy = combinePortPolicies(policy, entry.policy);
  }
  return policy;
}

export async function getForwardGroupEntryPortPolicy(groupId: number): Promise<PortPolicy> {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  return forwardGroupEntryPortPolicy(group);
}

export async function getForwardGroupEntryPortRange(groupId: number): Promise<{ start: number; end: number } | null> {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const members = sortedMembers(group, true);
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const entryMembers = await entryGroupMembersFor(group);
  if (members.length === 0 && !(groupMode === "port" && entryMembers.length > 0)) throw new Error("Forward group has no enabled members");
  if (groupMode === "chain" && (members.length < (entryMembers.length > 0 ? 1 : 2) || members.length > MAX_FORWARD_GROUP_MEMBERS)) {
    throw new Error(entryMembers.length > 0
      ? `Port forwarding chain requires 1-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`
      : "Port forwarding chain requires at least two enabled hosts");
  }

  let policy = portPolicyFrom(null);
  const policyMembers = groupMode === "chain"
    ? (entryMembers.length > 0 ? entryMembers : members.slice(0, 1))
    : (entryMembers.length > 0 ? entryMembers : members);
  for (const member of policyMembers) {
    const entry = await entryPortPolicyForMember(member);
    if (!entry.hostId) throw new Error("Forward group member has no valid entry agent");
    policy = combinePortPolicies(policy, entry.policy);
  }
  return policyRangeForGroup(policy);
}

export async function findAvailableForwardGroupPort(
  groupId: number,
  excludeTemplateRuleId?: number | null,
  allowedRange?: { start: number; end: number; ranges?: Array<{ start: number; end: number }> } | null,
  protocol?: unknown,
  unavailablePorts: Iterable<number> = [],
) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const members = sortedMembers(group, true);
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const entryMembers = await entryGroupMembersFor(group);
  if (members.length === 0 && !(groupMode === "port" && entryMembers.length > 0)) throw new Error("Forward group has no enabled members");
  if (groupMode === "chain" && (members.length < (entryMembers.length > 0 ? 1 : 2) || members.length > MAX_FORWARD_GROUP_MEMBERS)) {
    throw new Error(entryMembers.length > 0
      ? `Port forwarding chain requires 1-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`
      : "Port forwarding chain requires at least two enabled hosts");
  }

  const entries: Array<{ hostId: number; ignoreRuleIds: number[] }> = [];
  const excludedChildRuleIds = excludeTemplateRuleId
    ? (await getForwardGroupChildRulesForTemplate(Number(excludeTemplateRuleId)))
      .map((rule: any) => Number(rule.id))
      .filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  let policy = portPolicyFrom(null);

  const candidateMembers = groupMode === "chain"
    ? (entryMembers.length > 0 ? entryMembers : members.slice(0, 1))
    : (entryMembers.length > 0 ? entryMembers : members);
  for (const member of candidateMembers) {
    const entry = await entryPortPolicyForMember(member);
    if (!entry.hostId) throw new Error("Forward group member has no valid entry agent");
    const childMemberId = groupMode === "chain" && entryMembers.length > 0
      ? Number(members[0]?.id || 0)
      : Number(member.id);
    const existing = excludeTemplateRuleId
      ? await existingChildRule(Number(excludeTemplateRuleId), childMemberId, entry.hostId)
      : null;
    const ignoreRuleIds = [
      Number(excludeTemplateRuleId || 0),
      ...excludedChildRuleIds,
      Number(existing?.id || 0),
    ].filter(Boolean);
    // 隧道成员挂了入口组时，组里的主机也要在这个端口上监听，挑的端口在这些主机上也得空着。
    for (const hostId of new Set([entry.hostId, ...await memberListenHostIds(member)])) {
      entries.push({ hostId, ignoreRuleIds });
    }
    policy = combinePortPolicies(policy, entry.policy);
  }
  if (allowedRange) {
    policy = combinePortPolicies(policy, portPolicyFrom({
      ...(allowedRange.ranges?.length
        ? { portRanges: allowedRange.ranges }
        : { portRangeStart: allowedRange.start, portRangeEnd: allowedRange.end }),
    }));
  }
  const candidates = candidatePortsForGroup(policy);
  if (candidates.length === 0) return null;

  const usedPortSets = await Promise.all(
    entries.map((entry) => getUsedPortsOnHost(entry.hostId, entry.ignoreRuleIds, protocol, undefined, false)),
  );
  const unavailable = new Set(Array.from(unavailablePorts, Number).filter((port) => Number.isInteger(port) && port > 0));
  const isAvailable = (port: number) => !unavailable.has(port) && usedPortSets.every((usedPorts) => !usedPorts.has(port));

  const randomAttempts = Math.min(120, candidates.length);
  for (let i = 0; i < randomAttempts; i++) {
    const port = candidates[Math.floor(Math.random() * candidates.length)];
    if (isAvailable(port)) return port;
  }

  for (const port of candidates) {
    if (isAvailable(port)) return port;
  }
  return null;
}

export async function validateForwardGroupRuleConfig(groupId: number, config: ForwardGroupRuleConfig) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  if (!(await forwardGroupRuntimeDependenciesEnabled(group))) throw new Error("转发资源未启用或关联入口组已停用");
  const sourcePort = Number(config.sourcePort || 0);
  const protocol = normalizeRuleProtocol(config.protocol);
  if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) {
    throw new Error("Forward group entry port must be 1-65535");
  }
  const members = sortedMembers(group);
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const chainEntries = await entryGroupMembersFor(group);
  if (members.length === 0 && !(groupMode === "port" && chainEntries.length > 0)) throw new Error("Forward group has no members");
  if (groupMode === "port") {
    if (chainEntries.length === 0 && (members.length < 1 || members.length > MAX_FORWARD_GROUP_MEMBERS)) throw new Error(`端口转发需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台入口主机，或者挂一个入口组`);
    if (String(group.groupType || "host") !== "host") throw new Error("端口转发仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error("端口转发仅支持主机成员");
  }
  if (groupMode === "chain") {
    const enabledMembers = members.filter((member: any) => dbBool(member?.isEnabled));
    const entryMembers = await chainEntryMembers(group);
    const minEnabledMembers = entryMembers.length > 0 ? 1 : 2;
    if (String((group as any).groupType || "host") !== "host") {
      throw new Error("Port forwarding chain only supports host members");
    }
    if (enabledMembers.length < minEnabledMembers || enabledMembers.length > MAX_FORWARD_GROUP_MEMBERS) {
      throw new Error(entryMembers.length > 0
        ? `Port forwarding chain requires 1-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`
        : `Port forwarding chain requires 2-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`);
    }
    const hasExternalEntry = entryMembers.length > 0;
    for (const [index, member] of enabledMembers.entries()) {
      if (member.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
      const host = await getHostById(Number(member.hostId));
      if (!host) throw new Error("Host does not exist");
      if (index === 0 && !hasExternalEntry) {
        if (!entryAddressForHost(host)) throw new Error("Port forwarding chain entry host has no entry address");
      } else if (!resolveChainConnectHost(member, host)) {
        throw new Error("Port forwarding chain host has no usable connect address");
      }
    }
    for (const entryMember of entryMembers) {
      const host = await getHostById(Number(entryMember.hostId));
      if (!host || !entryAddressForHost(host)) throw new Error("Entry group host has no entry address");
    }
    const chainHostIds = new Set(enabledMembers.map((member: any) => Number(member.hostId || 0)));
    if (entryMembers.some((member: any) => chainHostIds.has(Number(member.hostId || 0)))) {
      throw new Error("Entry group host cannot also be used inside the port forwarding chain");
    }
  }

  const portCheckMembers = groupMode === "chain"
    ? (chainEntries.length > 0 ? chainEntries : members.filter((member: any) => dbBool(member?.isEnabled)).slice(0, 1))
    : (chainEntries.length > 0 ? chainEntries : members);
  const firstChainMember = groupMode === "chain"
    ? members.filter((member: any) => dbBool(member?.isEnabled))[0] || null
    : null;
  const excludedChildRuleIds = config.excludeTemplateRuleId
    ? (await getForwardGroupChildRulesForTemplate(Number(config.excludeTemplateRuleId)))
      .map((rule: any) => Number(rule.id))
      .filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  // 一次判完，而不是逐个成员判：报错时说出来的才是**真正**的允许范围，
  // 也正是界面显示的那一份；逐个判只会报到第一个不满足的成员为止。
  const entryPolicy = await forwardGroupEntryPortPolicy(group);
  if (!config.sniBackendPort && !isPortAllowedByPolicy(sourcePort, entryPolicy)) {
    throw new Error(portPolicyErrorMessage(entryPolicy, "入口端口"));
  }
  for (const member of portCheckMembers) {
    if (!dbBool(member?.isEnabled)) continue;
    const hostId = await memberEntryHostId(member);
    if (!hostId) throw new Error("Forward group member has no valid entry agent");
    const childMemberId = groupMode === "chain" && chainEntries.length > 0 && firstChainMember
      ? Number(firstChainMember.id)
      : Number(member.id);
    const existing = config.excludeTemplateRuleId
      ? await existingChildRule(Number(config.excludeTemplateRuleId), childMemberId, hostId)
      : null;
    const ignoreRuleIds = [
      Number(config.excludeTemplateRuleId || 0),
      ...excludedChildRuleIds,
      Number(existing?.id || 0),
    ].filter(Boolean);
    // 隧道成员挂了入口组：组里每台主机也替子规则监听，一起查。
    for (const listenHostId of new Set([hostId, ...await memberListenHostIds(member)])) {
      const used = await isPortUsedOnHostForGroupChild(listenHostId, sourcePort, ignoreRuleIds, protocol);
      if (used) throw new Error(`Entry agent port ${sourcePort} is already used`);
    }
  }
  return group;
}

export function filterForwardGroupFieldsForUse(
  groups: any[],
  accessScope?: {
    hostIds: ReadonlySet<number>;
    tunnelIds: ReadonlySet<number>;
    groupHostIds?: ReadonlyMap<number, ReadonlySet<number>>;
    groupTunnelIds?: ReadonlyMap<number, ReadonlySet<number>>;
  },
) {
  const memberVisible = (group: any, member: any) => {
    if (!accessScope) return true;
    const groupId = Number(group?.id || 0);
    const groupHostIds = accessScope.groupHostIds?.get(groupId);
    const groupTunnelIds = accessScope.groupTunnelIds?.get(groupId);
    if (groupHostIds || groupTunnelIds) {
      return member?.memberType === "tunnel"
        ? !!groupTunnelIds?.has(Number(member.tunnelId || 0))
        : !!groupHostIds?.has(Number(member.hostId || 0));
    }
    return member?.memberType === "tunnel"
      ? accessScope.tunnelIds.has(Number(member.tunnelId || 0))
      : accessScope.hostIds.has(Number(member.hostId || 0));
  };
  const memberHostVisible = (group: any, member: any) => {
    if (!accessScope) return true;
    const hostId = Number(member?.host?.id || member?.hostId || 0);
    if (accessScope.hostIds.has(hostId)) return true;
    const groupHostIds = accessScope.groupHostIds?.get(Number(group?.id || 0));
    return !!groupHostIds?.has(hostId);
  };
  return groups.map((group: any) => ({
    id: group.id,
    name: group.name,
    remark: group.remark || null,
    groupType: group.groupType,
    groupMode: forwardGroupModeOf(group),
    exitStrategy: normalizeExitGroupStrategy(group.exitStrategy),
    entryGroupId: group.entryGroupId ?? null,
    forwardType: group.forwardType,
    domain: group.domain,
    recordType: group.recordType,
    ddnsDualStack: dbBool(group.ddnsDualStack),
    trafficMultiplier: group.trafficMultiplier,
    failoverSeconds: group.failoverSeconds,
    recoverSeconds: group.recoverSeconds,
    chinaHealthCheckEnabled: dbBool(group.chinaHealthCheckEnabled),
    chinaHealthCheckTarget: group.chinaHealthCheckTarget || null,
    telegramSwitchNotifyEnabled: !!group.telegramSwitchNotifyEnabled,
    ddnsAutoResolveEnabled: group.ddnsAutoResolveEnabled !== false,
    autoFailback: group.autoFailback,
    isEnabled: dbBool(group.isEnabled, true),
    lastStatus: group.lastStatus,
    lastDdnsValue: group.lastDdnsValue,
    lastFailoverAt: group.lastFailoverAt,
    lastRecoverAt: group.lastRecoverAt,
    templateRuleCount: group.templateRuleCount,
    runtimeStatus: group.runtimeStatus,
    runtimeExpectedRuleCount: group.runtimeExpectedRuleCount,
    runtimeConfiguredRuleCount: group.runtimeConfiguredRuleCount,
    runtimeRunningRuleCount: group.runtimeRunningRuleCount,
    runtimeFailedRuleCount: group.runtimeFailedRuleCount,
    ruleRuntimeStatuses: group.ruleRuntimeStatuses,
    availability: group.availability ?? null,
    members: (group.members || [])
      .filter((member: any) => memberVisible(group, member))
      .map((member: any) => {
        const hostVisible = memberHostVisible(group, member);
        return {
          id: member.id,
          groupId: member.groupId,
          memberType: member.memberType,
          hostId: member.hostId ?? null,
          tunnelId: member.tunnelId ?? null,
          connectHost: hostVisible ? member.connectHost ?? null : null,
          entryAddress: hostVisible ? member.entryAddress ?? null : null,
          healthStatus: member.healthStatus,
          lastLatencyMs: member.lastLatencyMs,
          chinaHealthStatus: member.chinaHealthStatus,
          chinaHealthLatencyMs: member.chinaHealthLatencyMs,
          chinaHealthCheckedAt: member.chinaHealthCheckedAt,
          priority: member.priority,
          isEnabled: dbBool(member.isEnabled, true),
          host: member.host && hostVisible ? {
            id: member.host.id,
            name: member.host.name,
            ip: member.host.ip,
            ipv4: member.host.ipv4,
            ipv6: member.host.ipv6,
            entryIp: member.host.entryIp,
            tunnelEntryIp: member.host.tunnelEntryIp,
            ddnsEnabled: member.host.ddnsEnabled,
            ddnsDomain: member.host.ddnsDomain,
            isOnline: !!member.host.isOnline,
            lastHeartbeat: member.host.lastHeartbeat ?? null,
          } : null,
        };
      }),
  }));
}

/** 通知这条规则涉及的 Agent 重新拉配置。在事务里时等提交之后再通知（见 afterForwardGroupSyncCommit）。 */
async function refreshRuleEndpoints(rule: any, reason: string) {
  if (!rule) return;
  if (isDatabaseTransactionActive()) {
    // 提交之后回调里已经不在事务里，会走下面直接通知。
    await afterForwardGroupSyncCommit(`refresh rule=${Number(rule?.id || 0)}`, () => refreshRuleEndpoints(rule, reason));
    return;
  }
  pushAgentRefresh(Number(rule.hostId), reason, { urgent: true });
  if ((rule as any).tunnelId) {
    const tunnel = await getTunnelById(Number((rule as any).tunnelId));
    if (tunnel) {
      pushAgentRefresh(Number(tunnel.entryHostId), `${reason}-entry`, { urgent: true });
      pushAgentRefresh(Number(tunnel.exitHostId), `${reason}-exit`, { urgent: true });
    }
  }
}

async function refreshForwardChainRuntime(groupId: number, reason: string) {
  const group = await getForwardGroupById(groupId);
  if (!group || forwardGroupModeOf(group) !== "chain") return;
  const hostIds = new Set<number>();
  for (const member of await chainEntryMembers(group)) {
    const hostId = Number(member?.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  for (const member of sortedMembers(group, true) as any[]) {
    const hostId = await memberEntryHostId(member).catch(() => 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  const childRules = await getForwardGroupChildRules(groupId);
  for (const rule of childRules as any[]) {
    const hostId = Number(rule?.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, `${reason}-chain-${groupId}`, { urgent: true });
  if (hostIds.size > 0) {
    appendPanelLog("info", `[ForwardChain] refresh group=${groupId} reason=${reason} hosts=${Array.from(hostIds).join(",")}`);
  }
}

async function dependentChainGroupIds(entryGroupId: number) {
  const db = await getDb();
  if (!db) return [] as number[];
  const rows = await db.select({ id: forwardGroups.id }).from(forwardGroups).where(and(
    inArray(forwardGroups.groupMode, ["chain", "port"]),
    eq(forwardGroups.entryGroupId, entryGroupId),
  ));
  return (rows as any[]).map((row) => Number(row.id || 0)).filter((id) => id > 0);
}

async function forwardGroupRuntimeDependenciesEnabled(group: any) {
  if (!dbBool(group?.isEnabled)) return false;
  const mode = forwardGroupModeOf(group);
  if (mode !== "chain" && mode !== "port") return true;
  const entryGroupId = Number(group?.entryGroupId || 0);
  if (entryGroupId <= 0) return true;
  const entryGroup = await getForwardGroupById(entryGroupId) as any;
  return dbBool(entryGroup?.isEnabled) && forwardGroupModeOf(entryGroup) === "entry";
}

/** 通知这批规则涉及的 Agent（和隧道两端）。在事务里时等提交之后再通知（见 afterForwardGroupSyncCommit）。 */
async function refreshControlledForwardRules(rules: any[], reason: string) {
  if (isDatabaseTransactionActive()) {
    await afterForwardGroupSyncCommit(`refresh ${rules.length} rules`, () => refreshControlledForwardRules(rules, reason));
    return;
  }
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules) {
    if (rule?.isForwardGroupTemplate) continue;
    const hostId = Number(rule?.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
    const tunnelId = Number(rule?.tunnelId || 0);
    if (tunnelId > 0) tunnelIds.add(tunnelId);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, reason, { urgent: true });
  for (const tunnelId of tunnelIds) {
    const tunnel = await getTunnelById(tunnelId);
    if (tunnel) await refreshControlledTunnelRuntime(tunnel, reason);
  }
}

export async function refreshForwardGroupRuntime(groupId: number, reason = "forward-group-runtime-updated") {
  const rules = (await getForwardGroupChildRules(Number(groupId)) as any[])
    .filter((rule) => !dbBool(rule?.pendingDelete));
  await refreshControlledForwardRules(rules, reason);
  return rules.length;
}

async function disableForwardRulesByGroupIds(groupIds: number[], reason: string) {
  const ids = Array.from(new Set(groupIds.map((id) => Number(id)).filter((id) => id > 0)));
  if (ids.length === 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  const rules = await db.select().from(forwardRules).where(and(
    inArray(forwardRules.forwardGroupId, ids),
    eq(forwardRules.pendingDelete, false),
  ));
  const controlledRules = (rules as any[]).filter((rule) => (
    dbBool(rule.isEnabled) || dbBool(rule.disabledByTunnel) || dbBool(rule.disabledByGroup)
  ));
  const controlledIds = controlledRules.map((rule) => Number(rule.id || 0)).filter((id) => id > 0);
  if (controlledIds.length > 0) {
    appendPanelLog("warn", `[RuleStop] forward groups=${ids.join(",")} stopped ${controlledIds.length} rule(s) reason=${reason}; they resume automatically when the group is enabled again`);
    await db.update(forwardRules).set({
      isEnabled: false,
      isRunning: false,
      disabledByGroup: true,
      updatedAt: nowDate(),
    } as any).where(inArray(forwardRules.id, controlledIds));
    await refreshControlledForwardRules(controlledRules, reason);
    // 这些规则要是线路组规则，中转机上的中继也跟着停，通知中转机马上拉配置。
    await pushRouteRelayHostsForParents(controlledIds, reason);
  }
  return controlledIds.length;
}

/** 余额不足只停计费资源上的规则（见 server/trafficBillingRuleBlock.ts）。按需加载，避免仓储层和它互相引用。 */
async function handleTrafficBillingShortfallLazily(userId: number, reason: string) {
  const { handleTrafficBillingShortfall } = await import("../trafficBillingRuleBlock");
  await handleTrafficBillingShortfall(userId, reason);
}

export async function restoreForwardRulesByGroupId(groupId: number, reason: string) {
  const group = await getForwardGroupById(groupId) as any;
  if (!group || !(await forwardGroupRuntimeDependenciesEnabled(group))) return 0;
  const db = await getDb();
  if (!db) return 0;
  const rules = await db.select().from(forwardRules).where(and(
    eq(forwardRules.forwardGroupId, groupId),
    eq(forwardRules.disabledByGroup, true),
    eq(forwardRules.pendingDelete, false),
  ));
  for (const rule of rules as any[]) {
    const isTemplate = dbBool(rule.isForwardGroupTemplate);
    const ownerAllowed = !isTemplate || await forwardRuleOwnerAllowsRuntime(rule.userId);
    const canEnableTemplate = isTemplate
      && ownerAllowed
      && !dbBool(rule.disabledByTunnel)
      && !dbBool(rule.disabledByUser)
      && !String(rule.protocolBlockReason || "").trim();
    await db.update(forwardRules).set({
      isEnabled: canEnableTemplate,
      isRunning: false,
      disabledByGroup: false,
      ...(ownerAllowed ? {} : { disabledByUser: true }),
      updatedAt: nowDate(),
    } as any).where(eq(forwardRules.id, Number(rule.id)));
  }
  if (rules.length > 0) appendPanelLog("info", `[RuleStop] forward group=${groupId} resumed ${rules.length} rule(s) reason=${reason}`);
  await syncForwardGroupRules(groupId);
  await refreshControlledForwardRules(rules as any[], reason);
  await pushRouteRelayHostsForParents((rules as any[]).map((rule) => Number(rule.id)), reason);
  return rules.length;
}

async function tunnelGroupDependenciesEnabled(tunnel: any) {
  const refs: Array<{ id: number; mode: "entry" | "exit" }> = [
    { id: Number(tunnel?.entryGroupId || 0), mode: "entry" },
    { id: Number(tunnel?.exitGroupId || 0), mode: "exit" },
  ];
  for (const ref of refs) {
    if (ref.id <= 0) continue;
    const group = await getForwardGroupById(ref.id) as any;
    if (!dbBool(group?.isEnabled) || forwardGroupModeOf(group) !== ref.mode) return false;
  }
  return true;
}

async function setTunnelsEnabledByGroup(groupId: number, groupMode: "entry" | "exit", isEnabled: boolean) {
  assertOutsideDatabaseTransaction("setTunnelsEnabledByGroup");
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select().from(tunnels).where(
    groupMode === "entry" ? eq(tunnels.entryGroupId, groupId) : eq(tunnels.exitGroupId, groupId),
  );
  let changed = 0;
  for (const row of rows as any[]) {
    const tunnelId = Number(row.id || 0);
    if (tunnelId <= 0) continue;
    await withKeyedTaskLock(`tunnel:${tunnelId}`, async () => {
      const tunnel = await getTunnelById(tunnelId) as any;
      if (!tunnel) return;
      if (!isEnabled) {
        if (!dbBool(tunnel.isEnabled) && !dbBool(tunnel.disabledByGroup)) return;
        await updateTunnel(tunnelId, {
          isEnabled: false,
          isRunning: false,
          disabledByGroup: true,
        } as any);
        await disableForwardRulesByTunnel(tunnelId, `${groupMode}-group-${groupId}-disabled`);
        await refreshControlledTunnelRuntime({ ...tunnel, isEnabled: false, disabledByGroup: true }, `${groupMode}-group-disabled`, { resetRules: true });
        changed += 1;
        return;
      }
      if (!dbBool(tunnel.disabledByGroup) || !(await tunnelGroupDependenciesEnabled(tunnel))) return;
      await updateTunnel(tunnelId, {
        isEnabled: true,
        isRunning: false,
        disabledByGroup: false,
      } as any);
      await restoreForwardRulesByTunnel(tunnelId);
      await refreshControlledTunnelRuntime({ ...tunnel, isEnabled: true, disabledByGroup: false }, `${groupMode}-group-enabled`, { resetRules: true });
      changed += 1;
    });
  }
  return changed;
}

/**
 * 自愈：被系统（隧道停用、转发资源停用）连带停掉的规则，原因消除了就自己恢复。
 *
 * 正常情况下，开隧道 / 开资源那一步已经把规则拉回来了。这里兜的是「那一步没走完」
 * 的情况：面板在中途重启、某次恢复抛了错、并发把标记写乱了 —— 以前一旦漏掉，
 * 一整条隧道的规则就停在那里，只能一条条手动开。手动关掉的规则不带这些标记，
 * 这里不会碰。
 */
export async function healAutoStoppedForwardRules(reason = "auto-heal") {
  // 第 1、2 步按隧道拿 tunnel:<id> 键锁，理由同 setTunnelsEnabledByGroup。
  assertOutsideDatabaseTransaction("healAutoStoppedForwardRules");
  const db = await getDb();
  if (!db) return { tunnels: 0, tunnelRules: 0, groupRules: 0 };
  let healedTunnels = 0;
  let tunnelRules = 0;
  let groupRules = 0;

  // 1) 被入口/出口组连带停掉的隧道：组已经重新启用，隧道自己回来。
  const groupStoppedTunnels = await db.select().from(tunnels).where(and(
    eq(tunnels.disabledByGroup, true),
    eq(tunnels.isEnabled, false),
  ));
  for (const row of groupStoppedTunnels as any[]) {
    const tunnelId = Number(row.id || 0);
    if (tunnelId <= 0) continue;
    await withKeyedTaskLock(`tunnel:${tunnelId}`, async () => {
      const tunnel = await getTunnelById(tunnelId) as any;
      if (!tunnel || dbBool(tunnel.isEnabled) || !dbBool(tunnel.disabledByGroup)) return;
      if (!(await tunnelGroupDependenciesEnabled(tunnel))) return;
      await updateTunnel(tunnelId, { isEnabled: true, isRunning: false, disabledByGroup: false } as any);
      tunnelRules += await restoreForwardRulesByTunnel(tunnelId) || 0;
      await refreshControlledTunnelRuntime({ ...tunnel, isEnabled: true, disabledByGroup: false }, `${reason}-tunnel-group-restored`, { resetRules: true });
      healedTunnels += 1;
    });
  }

  // 2) 标着「因隧道停用而停」、隧道其实已经开着的规则。
  const tunnelStopped = await db.select({ tunnelId: forwardRules.tunnelId }).from(forwardRules).where(and(
    eq(forwardRules.disabledByTunnel, true),
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.tunnelId} IS NOT NULL`,
  ));
  const tunnelIds = Array.from(new Set((tunnelStopped as any[]).map((row) => Number(row.tunnelId || 0)).filter((id) => id > 0)));
  for (const tunnelId of tunnelIds) {
    await withKeyedTaskLock(`tunnel:${tunnelId}`, async () => {
      const tunnel = await getTunnelById(tunnelId) as any;
      if (!tunnel || !dbBool(tunnel.isEnabled) || dbBool(tunnel.disabledByGroup)) return;
      if (!(await tunnelGroupDependenciesEnabled(tunnel))) return;
      const restored = await restoreForwardRulesByTunnel(tunnelId) || 0;
      tunnelRules += restored;
      await refreshControlledTunnelRuntime(tunnel, `${reason}-tunnel-rules-restored`, { resetRules: true });
    });
  }

  // 3) 标着「因转发资源停用而停」、资源其实已经启用的规则。
  const groupStopped = await db.select({ groupId: forwardRules.forwardGroupId }).from(forwardRules).where(and(
    eq(forwardRules.disabledByGroup, true),
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupId} IS NOT NULL`,
  ));
  const groupIds = Array.from(new Set((groupStopped as any[]).map((row) => Number(row.groupId || 0)).filter((id) => id > 0)));
  for (const groupId of groupIds) {
    const group = await getForwardGroupById(groupId) as any;
    if (!group || !dbBool(group.isEnabled)) continue;
    groupRules += await restoreForwardRulesByGroupId(groupId, `${reason}-group-rules-restored`);
  }

  if (healedTunnels + tunnelRules + groupRules > 0) {
    appendPanelLog("info", `[RuleRecovery] ${reason}: tunnels=${healedTunnels} tunnelRules=${tunnelRules} groupRules=${groupRules} resumed after their cause cleared`);
  }
  return { tunnels: healedTunnels, tunnelRules, groupRules };
}

export async function setForwardGroupEnabled(groupId: number, isEnabled: boolean) {
  try {
    return await setForwardGroupEnabledUnwatched(groupId, isEnabled);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function setForwardGroupEnabledUnwatched(groupId: number, isEnabled: boolean) {
  const group = await getForwardGroupById(groupId) as any;
  if (!group) throw new Error("转发资源不存在");
  const mode = forwardGroupModeOf(group);
  const wasEnabled = dbBool(group.isEnabled);
  if (isEnabled && mode === "exit" && !sortedMembers(group, true).some((member: any) => member?.memberType === "host")) {
    throw new Error("Enabled exit group must contain at least one enabled host");
  }
  if (isEnabled && (mode === "chain" || mode === "port") && Number(group.entryGroupId || 0) > 0) {
    const entryGroup = await getForwardGroupById(Number(group.entryGroupId)) as any;
    if (!dbBool(entryGroup?.isEnabled) || forwardGroupModeOf(entryGroup) !== "entry") {
      throw new Error("关联入口组未启用，请先开启入口组");
    }
  }

  const ruleGroupIds = mode === "entry"
    ? await dependentChainGroupIds(groupId)
    : isCollectionGroupMode(mode)
      ? []
      : [groupId];
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(forwardGroups).set({
    isEnabled,
    updatedAt: nowDate(),
  } as any).where(eq(forwardGroups.id, groupId));

  let affectedRules = 0;
  let affectedTunnels = 0;
  try {
    if (!isEnabled) {
      affectedRules = await disableForwardRulesByGroupIds(ruleGroupIds, `${mode}-group-disabled`);
      for (const id of ruleGroupIds) await syncForwardGroupRules(id);
      if (mode === "entry" || mode === "exit") {
        affectedTunnels = await setTunnelsEnabledByGroup(groupId, mode, false);
      }
    } else {
      for (const id of ruleGroupIds) {
        affectedRules += await restoreForwardRulesByGroupId(id, `${mode}-group-enabled`);
      }
      if (mode === "entry" || mode === "exit") {
        affectedTunnels = await setTunnelsEnabledByGroup(groupId, mode, true);
      }
    }
  } catch (error) {
    if (isEnabled && !wasEnabled) {
      try {
        await db.update(forwardGroups).set({ isEnabled: false, updatedAt: nowDate() } as any).where(eq(forwardGroups.id, groupId));
        await disableForwardRulesByGroupIds(ruleGroupIds, `${mode}-group-enable-rollback`);
        for (const id of ruleGroupIds) await syncForwardGroupRules(id);
        if (mode === "entry" || mode === "exit") await setTunnelsEnabledByGroup(groupId, mode, false);
      } catch (rollbackError) {
        appendPanelLog("warn", `[ForwardGroup] enable rollback failed group=${groupId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    throw error;
  }
  if (isEnabled && (mode === "failover" || mode === "entry" || mode === "exit")) {
    // 选活动成员 / 推 DDNS 放到启用之后、尽力而为：DNS 服务商一时报错不该把已经恢复好的
    // 规则和隧道整个回滚成停用。失败记日志，交给评估队列按退避重试（DDNS 值没更新成功，
    // 下一轮会再推）。
    try {
      await runForwardGroupFailover(groupId, { manual: true, forceSync: true });
    } catch (error) {
      appendPanelLog("warn", `[ForwardGroup] failover/DDNS sync after enable failed group=${groupId}; retry scheduled: ${error instanceof Error ? error.message : String(error)}`);
      scheduleForwardGroupFailover([groupId]);
    }
  }
  await insertForwardGroupEvent(groupId, null, isEnabled ? "enabled" : "disabled", isEnabled ? "链路资源已启用。" : "链路资源已停用，关联规则已受控关闭。");
  return { success: true, affectedRules, affectedTunnels };
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

async function removeManagedRule(
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

export async function createForwardGroup(data: InsertForwardGroup, members: ForwardGroupMemberInput[]) {
  try {
    return await createForwardGroupUnwatched(data, members);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function createForwardGroupUnwatched(data: InsertForwardGroup, members: ForwardGroupMemberInput[]) {
  const groupMode = forwardGroupModeOf(data);
  const externalEntry = (groupMode === "chain" || groupMode === "port") && Number((data as any).entryGroupId || 0) > 0;
  if (members.length === 0 && !(groupMode === "port" && externalEntry)) throw new Error("转发组至少需要一个成员");
  validateForwardGroupModeMembers(groupMode, String((data as any).groupType || "host"), members, { externalEntry });
  if (groupMode === "entry" && !String((data as any).domain || "").trim()) throw new Error("入口组需要指定入口域名");
  for (const member of members) await targetHostIdForMember(member);
  const normalizedMembers = await Promise.all(members.map((member, index) => normalizeForwardGroupMemberInput(groupMode, member, index, { externalEntry })));
  await validateForwardGroupRecordMembers({ ...data, groupMode }, normalizedMembers as any);
  /*
    组、成员、「已创建」事件三样一起写：以前中途失败（比如某个成员行写不进去）会留下一个缺成员的组，
    界面上看着建成了，同步时又报「至少需要一个成员」。校验都在上面做完了，这里只剩写库，没有键锁、
    没有对外通知，放进一个事务里没有死锁的余地。
    排序号在事务外先算好：它的查询失败时按 0 兜底（.catch），PostgreSQL 下事务里的语句一旦报错，
    整个事务就只能回滚了，兜底兜不住。
  */
  const sortOrder = (data as any).sortOrder === undefined
    ? await nextForwardGroupSortOrder(Number((data as any).userId || 0), groupMode)
    : Math.max(0, Math.floor(Number((data as any).sortOrder) || 0));
  return withDatabaseTransaction(async () => {
  const id = await insertAndGetId("forward_groups", {
    ...data,
    failoverRuntimeInheritanceEnabled: (data as any).failoverRuntimeInheritanceEnabled ?? true,
    groupMode,
    sortOrder,
    forwardType: (data as any).forwardType || "iptables",
    sourcePort: Number((data as any).sourcePort || 1),
    protocol: (data as any).protocol || "both",
    targetIp: (data as any).targetIp || "0.0.0.0",
    targetPort: Number((data as any).targetPort || 1),
    createdAt: nowDate(),
    updatedAt: nowDate(),
  } as any);
  for (const [index, member] of normalizedMembers.entries()) {
    await insertAndGetId("forward_group_members", {
      groupId: id,
      memberType: member.memberType,
      hostId: member.memberType === "host" ? member.hostId : null,
      tunnelId: member.memberType === "tunnel" ? member.tunnelId : null,
      connectHost: member.connectHost ?? null,
      priority: member.priority ?? index,
      ...memberSchedulePayload(groupMode, member, null),
      ddnsLines: serializeDdnsLines(member.ddnsLines),
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });
  }
  await insertForwardGroupEvent(id, null, "created", groupMode === "chain"
    ? "Port forwarding chain created; rules will generate hop routes when this chain is selected."
    : groupMode === "entry"
      ? "入口组已创建；开启自动解析后会把入口主机同步到同一个入口域名。"
      : groupMode === "exit"
        ? "出口组已创建；可在隧道中作为出口组选择。"
        : "Forward group created; use it from forwarding rules to generate member routes.");
  return id;
  });
}

type RuleProtocol = "tcp" | "udp" | "both";

function normalizeRuleProtocol(protocol: unknown): RuleProtocol {
  const text = String(protocol || "both").toLowerCase();
  return text === "tcp" || text === "udp" ? text : "both";
}

async function nextForwardGroupSortOrder(userId: number, groupMode: ForwardGroupMode) {
  const q = quoteIdentifier;
  const params: any[] = [groupMode];
  let where = ` WHERE ${q("groupMode")} = ?`;
  if (userId > 0) {
    where += ` AND ${q("userId")} = ?`;
    params.push(userId);
  }
  const rows = await queryRaw<{ nextSortOrder: number }>(
    `SELECT COALESCE(MAX(${q("sortOrder")}), -1) + 1 AS ${q("nextSortOrder")} FROM ${q("forward_groups")}${where}`,
    params,
  ).catch(() => []);
  const value = Number(rows[0]?.nextSortOrder || 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export async function reorderForwardGroups(groupMode: ForwardGroupMode, ids: number[], _startIndex = 0) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const mode = forwardGroupModeOf({ groupMode });
  const orderedIds = ids.map((id) => Math.floor(Number(id))).filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const rows = await db.select({
    id: forwardGroups.id,
    groupMode: forwardGroups.groupMode,
  }).from(forwardGroups).where(inArray(forwardGroups.id, orderedIds));
  if (rows.length !== orderedIds.length) throw new Error("排序中包含不存在的转发项目");
  if ((rows as any[]).some((row) => forwardGroupModeOf(row) !== mode)) throw new Error("排序项目类型不一致");
  // 按被拖行原有的 sortOrder 位置重排（见 sortOrderSlots）；范围是管理员看到的同类型全部项目，startIndex 不再需要。
  await reorderWithinSortOrderScope({
    table: "forward_groups",
    orderedIds,
    loadScope: async () => ((await (await getDb()).select({ id: forwardGroups.id, groupMode: forwardGroups.groupMode, sortOrder: forwardGroups.sortOrder })
      .from(forwardGroups).orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id))) as any[])
      .filter((row) => forwardGroupModeOf(row) === mode),
  });
}

export async function updateForwardGroup(id: number, data: Partial<InsertForwardGroup>, options: { skipSync?: boolean } = {}) {
  try {
    return await updateForwardGroupUnwatched(id, data, options);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function updateForwardGroupUnwatched(id: number, data: Partial<InsertForwardGroup>, options: { skipSync?: boolean } = {}) {
  const db = await getDb();
  await db.update(forwardGroups).set({ ...data, updatedAt: nowDate() }).where(eq(forwardGroups.id, id));
  if (!options.skipSync) {
    await syncForwardGroupRules(id);
    const group = await getForwardGroupById(id);
    if (forwardGroupModeOf(group) === "entry" || forwardGroupModeOf(group) === "exit") {
      await refreshForwardGroupReferences(id);
    }
  }
}

/**
 * 换成员前查死循环（和 rules.crud.ts 新建 / 编辑规则时同一个检查，见 server/selfForwardLoop.ts）：
 * 新加入（或重新启用）的主机会按模板端口铺子规则 —— 主机地址正好是规则目标、端口又相同，就是转回自己。
 * - 端口转发 / 故障转移（主机型）组自己加成员：查这个组的模板；
 * - 入口组加主机：查挂这个入口组的端口转发的模板（转发链的入口只转给下一跳，不查，和 rules.crud 一致）。
 * 停用状态加进来的成员不铺子规则，等它被启用时再查。
 */
async function assertMemberChangeHasNoSelfForwardLoop(group: any, groupMode: ForwardGroupMode, existing: any[], nextMembers: any[]) {
  const previousEnabledHostIds = new Set(existing
    .filter((member) => member.memberType === "host" && dbBool(member.isEnabled, true))
    .map((member) => Number(member.hostId || 0)));
  const addedHostIds = Array.from(new Set(nextMembers
    .filter((member) => member.memberType === "host" && dbBool(member.isEnabled, true))
    .map((member) => Number(member.hostId || 0))
    .filter((hostId) => hostId > 0 && !previousEnabledHostIds.has(hostId))));
  if (addedHostIds.length === 0) return;
  const groupIds: number[] = [];
  if (groupMode === "entry") {
    const db = await getDb();
    const dependents = await db.select({ id: forwardGroups.id, groupMode: forwardGroups.groupMode, groupType: forwardGroups.groupType })
      .from(forwardGroups)
      .where(eq(forwardGroups.entryGroupId, Number(group.id)));
    for (const dependent of dependents as any[]) {
      if (forwardGroupModeOf(dependent) === "port" && String(dependent.groupType || "host") !== "tunnel") groupIds.push(Number(dependent.id));
    }
  } else if (groupMode !== "chain" && !isCollectionGroupMode(groupMode) && String(group?.groupType || "host") !== "tunnel") {
    groupIds.push(Number(group.id));
  }
  for (const groupId of groupIds) {
    const templates = await getForwardGroupTemplateRules(groupId) as any[];
    if (templates.length === 0) continue;
    for (const hostId of addedHostIds) {
      const host = await getHostById(hostId);
      for (const template of templates) {
        try {
          assertNoDirectSelfForwardLoop({
            host,
            sourcePort: Number(template.sourcePort),
            targetIp: template.targetIp,
            targetPort: Number(template.targetPort),
            tunnelId: null,
          });
        } catch {
          throw new Error(`成员主机「${(host as any)?.name || hostId}」加入后，规则「${template.name || template.id}」会在它上面把 ${template.sourcePort} 端口转发回自己的同一端口，造成转发死循环。请先修改规则目标或端口`);
        }
      }
    }
  }
}

export async function replaceForwardGroupMembers(
  groupId: number,
  members: ForwardGroupMemberInput[],
  options: { skipSync?: boolean; deferRefresh?: boolean; scheduleAt?: Date } = {},
) {
  try {
    return await replaceForwardGroupMembersUnwatched(groupId, members, options);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function replaceForwardGroupMembersUnwatched(
  groupId: number,
  members: ForwardGroupMemberInput[],
  options: { skipSync?: boolean; deferRefresh?: boolean; scheduleAt?: Date } = {},
) {
  const group = await getForwardGroupById(groupId);
  const groupMode = forwardGroupModeOf(group);
  const externalEntry = (groupMode === "chain" || groupMode === "port") && Number((group as any)?.entryGroupId || 0) > 0;
  if (members.length === 0 && !(groupMode === "port" && externalEntry)) throw new Error("转发组至少需要一个成员");
  validateForwardGroupModeMembers(groupMode, String((group as any)?.groupType || "host"), members, { externalEntry });
  const normalizedMembers = await Promise.all(members.map((member, index) => normalizeForwardGroupMemberInput(groupMode, member, index, { externalEntry })));
  await validateForwardGroupRecordMembers(group, normalizedMembers as any);
  const db = await getDb();
  const existing = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
  const previousHostIds = (existing as any[])
    .filter((member) => member.memberType === "host")
    .map((member) => Number(member.hostId || 0))
    .filter((hostId) => Number.isFinite(hostId) && hostId > 0);
  const keepKeys = new Set(normalizedMembers.map((m) => `${m.memberType}:${m.memberType === "host" ? m.hostId : m.tunnelId}`));
  await assertMemberChangeHasNoSelfForwardLoop(group, groupMode, existing as any[], normalizedMembers as any[]);
  if (groupMode === "entry" && dbBool((group as any)?.isEnabled)) {
    // 新加入（或重新启用）的入口组主机会替组里所有隧道的规则监听 sourcePort，
    // 写成员之前先查端口，冲突就整体拒绝，别写一半。
    const previousEnabledHostIds = new Set((existing as any[])
      .filter((member) => member.memberType === "host" && dbBool(member.isEnabled, true))
      .map((member) => Number(member.hostId || 0)));
    const addedHostIds = normalizedMembers
      .filter((member) => member.memberType === "host" && dbBool(member.isEnabled, true))
      .map((member) => Number(member.hostId || 0))
      .filter((hostId) => hostId > 0 && !previousEnabledHostIds.has(hostId));
    if (addedHostIds.length > 0) {
      const tunnelRows = await db.select({ id: tunnels.id }).from(tunnels).where(eq(tunnels.entryGroupId, groupId));
      await assertTunnelRulePortsFreeOnEntryHosts((tunnelRows as any[]).map((row) => Number(row.id)), addedHostIds);
    }
  }

  if (groupMode !== "chain" && !isCollectionGroupMode(groupMode) && dbBool((group as any)?.isEnabled)) {
    // 成员写进库之后，同步会给每个启用的成员按模板端口建子规则；端口被占就会在同步里
    // 抛错 —— 那时成员已经写了一半，之后每次同步（含自愈）都会卡在同一个冲突上。
    // 所以写之前先按新的成员集合把每个模板的端口查一遍，冲突就整体拒绝。
    const templates = (await getForwardGroupTemplateRules(groupId) as any[]).filter((template) => dbBool(template?.isEnabled));
    if (templates.length > 0) {
      const memberKey = (member: any) => `${member.memberType}:${member.memberType === "host" ? member.hostId : member.tunnelId}`;
      const removedChildIds: number[] = [];
      for (const old of existing as any[]) {
        if (keepKeys.has(memberKey(old))) continue;
        for (const child of await getForwardGroupChildRulesForMember(Number(old.id)) as any[]) removedChildIds.push(Number(child.id));
      }
      for (const member of normalizedMembers) {
        if (!dbBool(member.isEnabled, true)) continue;
        if (member.memberType === "tunnel") {
          const tunnel = await getTunnelById(Number(member.tunnelId));
          if (!tunnel || !dbBool((tunnel as any).isEnabled)) continue;
        }
        const hostId = await targetHostIdForMember(member);
        const found = (existing as any[]).find((row) => memberKey(row) === memberKey(member));
        for (const template of templates) {
          const child = found ? await existingChildRule(Number(template.id), Number(found.id)) : undefined;
          const ignoreRuleIds = [Number(template.id), Number(child?.id || 0), ...removedChildIds].filter((id) => id > 0);
          if (await isPortUsedOnHostForGroupChild(hostId, Number(template.sourcePort), ignoreRuleIds, template.protocol, template.sourcePortEnd)) {
            const host = await getHostById(hostId) as any;
            throw new Error(`成员主机「${host?.name || hostId}」上端口 ${template.sourcePort} 已被占用，无法为规则「${template.name || template.id}」建立转发，请先更换端口或移除占用`);
          }
        }
      }
    }
  }

  /*
    删掉去掉的成员、写入留下 / 新加的成员放在一个事务里（P5）：以前是一条条直接写，中途哪一步失败
    （写库报错、主机刚好被删）就留下「旧成员删了一半、新成员没写上」的组 —— 主备组可能一个成员都不剩。
    现在要么整份换成新的，要么原样不动。已经在别人的事务里（转发链保存）时直接并进去。
    事务里收子规则只标待删，结算、通知 Agent、收中继都在提交之后（removeManagedRule、afterForwardGroupSyncCommit）；
    事务里要用事务自己的连接（getDb 在事务里返回它），所以这里重新取一次。
  */
  await withDatabaseTransaction(async () => {
  const db = await getDb();
  for (const old of existing as any[]) {
    const key = `${old.memberType}:${old.memberType === "host" ? old.hostId : old.tunnelId}`;
    if (!keepKeys.has(key)) {
      const childRules = await getForwardGroupChildRulesForMember(Number(old.id));
      for (const rule of childRules as any[]) await removeManagedRule(Number(rule.id), options);
      if (old.ruleId) await removeManagedRule(Number(old.ruleId), options);
      await db.delete(forwardGroupMembers).where(eq(forwardGroupMembers.id, old.id));
    }
  }

  const current = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
  for (const [index, member] of normalizedMembers.entries()) {
    await targetHostIdForMember(member);
    const found = (current as any[]).find((row) => row.memberType === member.memberType
      && Number(row.memberType === "host" ? row.hostId : row.tunnelId) === Number(member.memberType === "host" ? member.hostId : member.tunnelId));
    const payload: Partial<InsertForwardGroupMember> = {
      priority: member.priority ?? index,
      ...memberSchedulePayload(groupMode, member, found, options.scheduleAt),
      connectHost: member.connectHost ?? null,
      bandwidthMbps: normalizeMemberBandwidthMbps(member.bandwidthMbps),
      aggregationWeight: normalizeMemberWeight(member.aggregationWeight),
      // 线路没传（节点池同步、时段切换这些只改别的字段的写入方）= 不动原来的分线路配置。
      ...(member.ddnsLines !== undefined ? { ddnsLines: serializeDdnsLines(member.ddnsLines) } : {}),
      updatedAt: nowDate(),
    } as any;
    if (found) {
      await db.update(forwardGroupMembers).set(payload).where(eq(forwardGroupMembers.id, found.id));
    } else {
      await insertAndGetId("forward_group_members", {
        groupId,
        memberType: member.memberType,
        hostId: member.memberType === "host" ? member.hostId : null,
        tunnelId: member.memberType === "tunnel" ? member.tunnelId : null,
        connectHost: member.connectHost ?? null,
        priority: member.priority ?? index,
        // dbBool 来自上游：MySQL 会把布尔返回成字符串 "0"，用 ?? 的话会当成真值。
        ...memberSchedulePayload(groupMode, member, null, options.scheduleAt),
        bandwidthMbps: normalizeMemberBandwidthMbps(member.bandwidthMbps),
        aggregationWeight: normalizeMemberWeight(member.aggregationWeight),
        ddnsLines: serializeDdnsLines(member.ddnsLines),
        createdAt: nowDate(),
        updatedAt: nowDate(),
      });
    }
  }
  });
  // 组的第一个成员就是订阅里的入口机器，成员一变订阅缓存就得作废。
  invalidateProxySubCacheAll();
  if (options.skipSync) return;
  if (isCollectionGroupMode(groupMode)) {
    await runForwardGroupFailover(groupId, { forceSync: true, manual: true });
    await refreshForwardGroupReferences(groupId, {
      reason: `${groupMode}-group-members-updated`,
      previousHostIds,
    });
  } else {
    await syncForwardGroupRules(groupId);
    /*
      主备组改了成员马上评估一次（P4）：定时启停、节点池同步改成员走的也是这里，以前只同步子规则、
      不重选活动成员 —— 活动成员被停用 / 去掉之后，解析还指着它，要等下一次健康上报或巡检才换。
      走健康上报用的那条防抖队列（不在这里内联跑：调用方可能拿着编辑锁，DNS 写入不该卡在里面）。
    */
    if (groupMode === "failover") scheduleForwardGroupFailover([groupId]);
  }
}

/** 把这个组当入口组 / 出口组用的隧道，以及把它当入口组的转发链、端口转发（chains 里按 groupMode 分）。 */
export async function getForwardGroupEndpointReferences(groupId: number) {
  const db = await getDb();
  if (!db) return { tunnels: [] as any[], chains: [] as any[] };
  const [tunnelRows, chainRows] = await Promise.all([
    db.select({ id: tunnels.id, name: tunnels.name }).from(tunnels)
      .where(or(eq(tunnels.entryGroupId, groupId), eq(tunnels.exitGroupId, groupId))),
    db.select({ id: forwardGroups.id, name: forwardGroups.name, groupMode: forwardGroups.groupMode }).from(forwardGroups)
      .where(and(eq(forwardGroups.entryGroupId, groupId), sql`${forwardGroups.id} <> ${groupId}`)),
  ]);
  return { tunnels: tunnelRows as any[], chains: chainRows as any[] };
}

export async function deleteForwardGroup(id: number) {
  try {
    return await deleteForwardGroupUnwatched(id);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function deleteForwardGroupUnwatched(id: number) {
  const db = await getDb();
  // 删之前留一份（带成员）：删完要按它发布过的值把解析记录清掉（clearForwardGroupPublishedDdns）。
  const groupBeforeDelete = await getForwardGroupById(id).catch(() => null);
  const childRules = await getForwardGroupChildRules(id);
  for (const rule of childRules as any[]) await removeManagedRule(Number(rule.id));
  const templates = await getForwardGroupTemplateRules(id);
  for (const template of templates as any[]) {
    const billingResource = await findTrafficBillingResourceForRule(template);
    const fallback = trafficBillingResourceCandidatesForRule(template)[0];
    const resource = billingResource || fallback;
    const billed = await settleAndMarkForwardGroupRulePendingDelete(template, resource);
    if (billed && Number(billed.balanceAfterCents) < 0) {
      await handleTrafficBillingShortfallLazily(Number((template as any).userId), "group-delete-settlement-negative");
    }
    // 模板从不在 Agent 上运行，等不到停止确认；结算完直接收掉（同 deleteForwardRuleForActor）。
    await finalizeForwardRuleDelete(Number(template.id));
  }
  const members = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, id));
  for (const member of members as any[]) {
    if (member.ruleId) await removeManagedRule(Number(member.ruleId));
  }
  await db.delete(forwardGroupEvents).where(eq(forwardGroupEvents.groupId, id));
  await db.delete(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, id));
  await db.delete(userForwardGroupPermissions).where(eq(userForwardGroupPermissions.forwardGroupId, id));
  /**
   * 套餐里绑着它的那一行也要删。
   *
   * 留着的话套餐会继续宣称带着一个已经不存在的转发组：商店上的数量多一个，
   * 管理端的套餐编辑里显示成一个只有编号的空壳，而买了这个套餐的人拿到的是
   * 一条指向不存在资源的授权。主机那一路一直是这么删的，这几路当初漏了。
   */
  await db.delete(subscriptionPlanForwardGroups).where(eq(subscriptionPlanForwardGroups.forwardGroupId, id));
  await db.delete(forwardGroups).where(eq(forwardGroups.id, id));
  forwardGroupHealthRechecks.replace(id, null);
  exactDdnsReconciledGroups.delete(id);
  /*
    组行删掉之后再清解析，并且拿评估用的那把锁：正在跑的一轮评估（可能还要写一次服务商）先跑完，
    之后的评估读不到组就直接返回，不会在清完之后又把记录写回去。清理失败不影响删除（里面自己记日志）。
  */
  if (groupBeforeDelete) {
    await withKeyedTaskLock(`forward-group-failover:${id}`, () => clearForwardGroupPublishedDdns(groupBeforeDelete))
      .catch((error) => appendPanelLog("warn", `[DDNS] 转发组 ${id} 已删除，清理解析记录时出错：${error instanceof Error ? error.message : String(error)}`));
  }
}

/**
 * Read the bandwidth aggregation status of one entry group.
 *
 * Unlike the DDNS sync path this never mutates member health; it reports the
 * health already stored on each member so the panel can show which front VPS
 * hosts are carrying the aggregate and how much headroom is left.
 */
export async function getForwardGroupBandwidthAggregation(groupId: number) {
  const group = await getForwardGroupById(Number(groupId)) as any;
  if (!group) throw new Error("入口组不存在");
  if (forwardGroupModeOf(group) !== "entry") throw new Error("仅入口组支持带宽聚合");

  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const chinaHealthEnabled = dbBool(group.chinaHealthCheckEnabled);
  const now = Date.now();
  const members: AggregationMemberRow[] = [];
  for (const member of sortedMembers(group) as any[]) {
    if (member.memberType !== "host") continue;
    const value = String(member.ddnsValue || "").trim()
      || await memberDdnsValue(member, recordType).catch(() => "");
    if (!value) continue;
    const liveness = await resolveMemberAgentLiveness(member, now).catch(() => ({ available: false } as any));
    const healthy = !!dbBool(member.isEnabled)
      && !!liveness.available
      && (chinaHealthEnabled
        ? forwardGroupChinaHealthStateAt(member, now) === "healthy"
        : forwardGroupAgentHealthStateAt(member, now) === "healthy");
    const host = await getHostById(Number(member.hostId)).catch(() => null) as any;
    members.push({
      memberId: Number(member.id || 0),
      hostId: Number(member.hostId || 0),
      value,
      healthy,
      // 成员上没填就用主机的「线路带宽」。
      bandwidthMbps: Number(member.bandwidthMbps || 0) || Math.max(0, Number(host?.lineBandwidthMbps) || 0),
      aggregationWeight: Number(member.aggregationWeight || 0),
      label: String(host?.name || "").trim() || value,
    });
  }

  const plan = buildEntryGroupAggregationPlan({
    group,
    members,
    throughputByHostId: await memberThroughputMbps(members),
    singleValuePerMember: recordType === "CNAME",
  });
  return {
    groupId: Number(group.id),
    groupName: String(group.name || ""),
    domain: String(group.domain || ""),
    recordType,
    rateLimitMbps: Number(group.rateLimitMbps || 0),
    ...summarizeAggregationPlan(group, plan),
  };
}

/**
 * 成员优先级按给的次序写成 0..n-1，所以必须拿到**这个组的完整成员集合**：
 * 少带了的成员保留旧 priority，会和新写的撞号（主备挑成员就看 priority，撞号等于次序随机）；
 * 夹带别的组的 id 以前会被 where 静悄悄吞掉，前端却以为排好了。整体校验通过后在一个事务里写，
 * 不会留下一半新一半旧的顺序。
 */
export async function reorderForwardGroupMembers(groupId: number, memberIds: number[]) {
  try {
    return await reorderForwardGroupMembersUnwatched(groupId, memberIds);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function reorderForwardGroupMembersUnwatched(groupId: number, memberIds: number[]) {
  const orderedIds = memberIds.map((id) => Math.floor(Number(id)));
  if (orderedIds.length === 0 || orderedIds.some((id) => !Number.isInteger(id) || id <= 0) || new Set(orderedIds).size !== orderedIds.length) {
    throw new Error("成员排序数据无效：成员不能为空或重复");
  }
  await withDatabaseTransaction(async () => {
    const db = await getDb();
    const rows = await db.select({ id: forwardGroupMembers.id }).from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
    const current = new Set((rows as any[]).map((row) => Number(row.id)));
    if (current.size !== orderedIds.length || orderedIds.some((id) => !current.has(id))) {
      throw new Error("成员列表和当前转发组不一致（可能刚被改过），请刷新后按完整的成员顺序重新提交");
    }
    for (const [index, memberId] of orderedIds.entries()) {
      await db.update(forwardGroupMembers).set({ priority: index, updatedAt: nowDate() }).where(and(
        eq(forwardGroupMembers.groupId, groupId),
        eq(forwardGroupMembers.id, memberId),
      ));
    }
    await insertForwardGroupEvent(groupId, null, "reorder", "Member priority updated.");
  });
  invalidateProxySubCacheAll();
}

export async function syncForwardChainsForHost(hostId: number, previousHost?: any) {
  const db = await getDb();
  if (!db) return;
  const currentHost = await getHostById(hostId);
  const rows = await db
    .select({
      groupId: forwardGroupMembers.groupId,
    })
    .from(forwardGroupMembers)
    .where(and(
      eq(forwardGroupMembers.memberType, "host"),
      eq(forwardGroupMembers.hostId, hostId),
    ));
  const groupIds = Array.from(new Set((rows as any[]).map((row) => Number(row.groupId)).filter((id) => id > 0)));
  for (const groupId of groupIds) {
    const group = await getForwardGroupById(groupId);
    const mode = forwardGroupModeOf(group);
    if (mode === "entry") await runForwardGroupFailover(groupId);
    if (mode === "chain") {
      const members = sortedMembers(group) as any[];
      const entryMembers = await chainEntryMembers(group);
      const hasExternalEntry = entryMembers.length > 0;
      const currentPrivate = privateAddressForHost(currentHost);
      const currentIpv6 = ipv6AddressForConnectHost(currentHost);
      const previousPublic = entryAddressForHost(previousHost);
      const previousPrivate = privateAddressForHost(previousHost);
      const previousIpv6 = ipv6AddressForConnectHost(previousHost);
      for (const [index, member] of members.entries()) {
        if (Number(member.hostId || 0) !== Number(hostId)) continue;
        const stored = String(member.connectHost || "").trim();
        let nextConnectHost: string | null | undefined;
        if (index === 0 && !hasExternalEntry) {
          nextConnectHost = null;
        } else if (previousPrivate && stored === previousPrivate) {
          nextConnectHost = currentPrivate || null;
        } else if (previousIpv6 && stored === previousIpv6) {
          nextConnectHost = currentIpv6 || null;
        } else if (previousPublic && stored === previousPublic) {
          nextConnectHost = null;
        }
        if (nextConnectHost !== undefined && (stored || null) !== nextConnectHost) {
          await db.update(forwardGroupMembers).set({
            connectHost: nextConnectHost,
            updatedAt: nowDate(),
          } as any).where(eq(forwardGroupMembers.id, member.id));
        }
      }
      await syncForwardGroupRules(groupId, { validatePorts: false, createMissing: false });
    }
  }
}

async function activeForwardGroupIdsForHost(hostId: number) {
  const db = await getDb();
  if (!db) return [];
  const id = Number(hostId || 0);
  if (!Number.isInteger(id) || id <= 0) return [];

  const directRows = await db
    .select({ groupId: forwardGroupMembers.groupId })
    .from(forwardGroupMembers)
    .where(and(
      eq(forwardGroupMembers.memberType, "host"),
      eq(forwardGroupMembers.hostId, id),
      eq(forwardGroupMembers.isEnabled, true),
    ));
  const tunnelRows = await db
    .select({ groupId: forwardGroupMembers.groupId })
    .from(forwardGroupMembers)
    .innerJoin(tunnels, eq(forwardGroupMembers.tunnelId, tunnels.id))
    .where(and(
      eq(forwardGroupMembers.memberType, "tunnel"),
      eq(tunnels.entryHostId, id),
      eq(forwardGroupMembers.isEnabled, true),
    ));
  const groupIds = Array.from(new Set([
    ...directRows.map((row: any) => Number(row.groupId || 0)),
    ...tunnelRows.map((row: any) => Number(row.groupId || 0)),
  ].filter((value) => Number.isInteger(value) && value > 0)));
  if (groupIds.length === 0) return [];

  const groupRows = await db
    .select({
      id: forwardGroups.id,
      groupMode: forwardGroups.groupMode,
      isEnabled: forwardGroups.isEnabled,
      failoverSeconds: forwardGroups.failoverSeconds,
    })
    .from(forwardGroups)
    .where(inArray(forwardGroups.id, groupIds));
  return (groupRows as any[]).filter((group: any) => {
    const mode = forwardGroupModeOf(group);
    return dbBool(group?.isEnabled) && (mode === "failover" || mode === "entry");
  }).map((group: any) => Number(group.id || 0));
}

export async function runForwardGroupsForHostAddressChange(hostId: number, reason = "host-address-changed") {
  const id = Number(hostId || 0);
  // 探测拓扑里有主机地址（转发链各跳、外部观察的目标）：地址变了立刻作废。
  invalidateForwardGroupProbeTopology();
  const activeGroupIds = await activeForwardGroupIdsForHost(id);
  if (activeGroupIds.length === 0) return 0;

  appendPanelLog("info", `[HostAddress] host=${id} refreshing ${activeGroupIds.length} DDNS group(s) reason=${reason}`);
  await runForwardGroupFailoverByIds(activeGroupIds, {
    forceSync: true,
    suppressSwitchNotify: true,
  });
  return activeGroupIds.length;
}

export async function scheduleForwardGroupsForHostHealthChange(hostId: number) {
  const activeGroupIds = await activeForwardGroupIdsForHost(hostId);
  scheduleForwardGroupFailover(activeGroupIds);
  return activeGroupIds.length;
}

/**
 * 一批规则各自最新的一条探测结果，一次查完（P7：以前每条子规则先刷一次写缓冲再查一次）。
 * 同一秒有几条时取 id 最大的那条。
 */
async function latestTcpingByRuleIds(ruleIds: number[]) {
  const ids = Array.from(new Set(ruleIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const latest = new Map<number, any>();
  if (ids.length === 0) return latest;
  await flushPendingWrites("tcping_stats");
  const table = quoteIdentifier("tcping_stats");
  const ruleId = quoteIdentifier("ruleId");
  const recordedAt = quoteIdentifier("recordedAt");
  const rows = await queryRaw<any>(
    `SELECT t.* FROM ${table} t JOIN (SELECT ${ruleId} AS ${quoteIdentifier("latestRuleId")}, MAX(${recordedAt}) AS ${quoteIdentifier("latestAt")} FROM ${table} WHERE ${ruleId} IN (${ids.map(() => "?").join(", ")}) GROUP BY ${ruleId}) m ON m.${quoteIdentifier("latestRuleId")} = t.${ruleId} AND m.${quoteIdentifier("latestAt")} = t.${recordedAt}`,
    ids,
  );
  for (const row of rows) {
    const id = Number(row.ruleId || 0);
    const previous = latest.get(id);
    if (!previous || Number(row.id || 0) > Number(previous.id || 0)) latest.set(id, row);
  }
  return latest;
}

/** 主备组这一轮评估要用的子规则状态：成员的子规则、哪些模板启用着、每条在跑的子规则最新的探测，三次查询读完。 */
async function loadForwardGroupEvaluationRules(members: any[]): Promise<ForwardGroupEvaluationRules> {
  const db = await getDb();
  const memberIds = members.map((member) => Number(member?.id || 0)).filter((id) => id > 0);
  const childRows = memberIds.length > 0
    ? await db.select().from(forwardRules).where(and(
      inArray(forwardRules.forwardGroupMemberId, memberIds),
      sql`COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    )).orderBy(desc(forwardRules.createdAt))
    : [];
  const childRulesByMemberId = new Map<number, any[]>(memberIds.map((id) => [id, []]));
  for (const rule of childRows as any[]) childRulesByMemberId.get(Number(rule.forwardGroupMemberId || 0))?.push(rule);
  const templateRuleIds = Array.from(new Set((childRows as any[])
    .map((rule) => Number(rule.forwardGroupRuleId || 0))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const templateRows = templateRuleIds.length > 0
    ? await db
      .select({ id: forwardRules.id, isEnabled: forwardRules.isEnabled, pendingDelete: forwardRules.pendingDelete })
      .from(forwardRules)
      .where(inArray(forwardRules.id, templateRuleIds))
    : [];
  const enabledTemplateIds = new Set((templateRows as any[])
    .filter((rule) => dbBool(rule.isEnabled) && !dbBool(rule.pendingDelete))
    .map((rule) => Number(rule.id || 0))
    .filter((id) => id > 0));
  const probedRuleIds = (childRows as any[])
    .filter((rule) => enabledTemplateIds.has(Number(rule.forwardGroupRuleId || 0)) && dbBool(rule.isEnabled) && dbBool(rule.isRunning))
    .map((rule) => Number(rule.id));
  return { childRulesByMemberId, enabledTemplateIds, latestTcpingByRuleId: await latestTcpingByRuleIds(probedRuleIds) };
}

async function latestTcping(ruleId: number) {
  const scoped = forwardGroupEvaluationScope.getStore()?.rules;
  if (scoped) return scoped.latestTcpingByRuleId.get(Number(ruleId));
  await flushPendingWrites("tcping_stats");
  const table = quoteIdentifier("tcping_stats");
  const result = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${quoteIdentifier("ruleId")} = ? ORDER BY ${quoteIdentifier("recordedAt")} DESC LIMIT 1`,
    [ruleId],
  );
  return result[0];
}

async function evaluateMemberHealth(member: any, group: any) {
  const db = await getDb();
  const now = nowDate();
  const agentLiveness = await resolveMemberAgentLiveness(member, now.getTime());
  const scopedRules = forwardGroupEvaluationScope.getStore()?.rules || null;
  const childRules = scopedRules
    ? scopedRules.childRulesByMemberId.get(Number(member.id)) || []
    : await getForwardGroupChildRulesForMember(Number(member.id));
  // 外部观察：别的机器看这个成员的入口端口通不通（没安排观察点是 null，只看成员自己）。停用的成员不看。
  const peerHealth = dbBool(member?.isEnabled)
    ? await evaluateMemberPeerHealth(group, member, agentLiveness.agentOnline, now.getTime())
    : null;
  const external = peerHealth?.decision || null;
  /** 成员自己的 Agent 面板连不上，只靠观察点连得上才算健康：留着不切走，但不主动切过去。 */
  let externalOnly = false;
  let healthy = false;
  let chinaHealthPending = false;
  let latencyMs: number | null = null;
  let message = "";
  let observedFailureSince: Date | null = null;
  let agentHealthPending = false;
  let agentFailureFinal = false;
  let nextProbeExpiryAt: number | null = null;

  if (agentLiveness.trafficExcluded) {
    message = HOST_TRAFFIC_FAILOVER_EXCLUDED_MESSAGE;
    agentFailureFinal = true;
    observedFailureSince = now;
  } else if (!dbBool(member?.isEnabled)) {
    /*
      成员被停用（手动关、可用时段外、节点池里去掉）是管理动作，不是健康事件：它正好是活动成员时
      马上换走，不等「异常多久切」那段观察时间 —— 那段时间里解析还指着一台已经不铺规则的机器。
    */
    message = "Member disabled";
    agentFailureFinal = true;
    observedFailureSince = now;
  } else if (childRules.length === 0) {
    message = "No forwarding rule is using this group yet";
  } else {
    let enabledTemplateIds: Set<number>;
    if (scopedRules) {
      enabledTemplateIds = scopedRules.enabledTemplateIds;
    } else {
      const templateRuleIds = Array.from(new Set((childRules as any[])
        .map((rule: any) => Number(rule.forwardGroupRuleId || 0))
        .filter((id: number) => Number.isInteger(id) && id > 0)));
      const templateRows = templateRuleIds.length > 0
        ? await db
          .select({
            id: forwardRules.id,
            isEnabled: forwardRules.isEnabled,
            pendingDelete: forwardRules.pendingDelete,
          })
          .from(forwardRules)
          .where(inArray(forwardRules.id, templateRuleIds))
        : [];
      enabledTemplateIds = new Set((templateRows as any[])
        .filter((rule: any) => dbBool(rule.isEnabled) && !dbBool(rule.pendingDelete))
        .map((rule: any) => Number(rule.id || 0))
        .filter((id: number) => id > 0));
    }
    const activeChildRules = (childRules as any[])
      .filter((rule: any) => enabledTemplateIds.has(Number(rule.forwardGroupRuleId || 0)));

    if (activeChildRules.length === 0) {
      message = "No enabled forwarding rule is using this group member";
    } else if (!agentLiveness.available && external?.reachableWhileAgentOffline) {
      // 面板连不上这台的 Agent，但观察点连得上它的入口：访客还能用，不因为面板这条路断了就把它拿掉。
      healthy = true;
      externalOnly = true;
      message = `面板连不上，访客可达（${peerHealth!.label}）`;
    } else if (!agentLiveness.available) {
      observedFailureSince = agentLiveness.failureSince || now;
      message = "Member Agent offline";
    } else {
      healthy = true;
      const latencies: number[] = [];
      for (const rule of activeChildRules as any[]) {
        if (!dbBool(rule.isEnabled) || dbBool(rule.pendingDelete)) {
          healthy = false;
          message = "Member rule disabled";
          break;
        }
        if (!dbBool(rule.isRunning)) {
          healthy = false;
          message = "Member rule not running yet";
          break;
        }
        const latestStat = await latestTcping(Number(rule.id));
        if (!agentHealthSampleIsCurrent(agentLiveness, latestStat?.recordedAt)) {
          healthy = false;
          agentHealthPending = true;
          message = "Waiting for Agent health result after reconnect";
          break;
        }
        const stat = freshForwardGroupRuleProbe(latestStat, now);
        if (!stat) {
          healthy = false;
          const recordedAt = toDate(latestStat?.recordedAt);
          if (recordedAt && staleSampleWithinReadinessGrace(recordedAt.getTime(), now.getTime())) {
            // 面板刚启动 / 数据库刚恢复：停机期间没人收样本，旧样本过期不算故障，等新样本。
            agentHealthPending = true;
            nextProbeExpiryAt = forwardGroupPanelReadyAt() + FORWARD_GROUP_READINESS_SAMPLE_GRACE_MS;
            message = "Waiting for Agent health result after panel restart";
          } else if (recordedAt) {
            agentFailureFinal = true;
            observedFailureSince = new Date(recordedAt.getTime() + forwardGroupRuleProbeFreshMs);
            message = "Agent health result expired";
          } else {
            const waitingSince = toDate(member.lastCheckedAt) || toDate(group.updatedAt) || toDate(group.createdAt) || now;
            const expiresAt = waitingSince.getTime() + forwardGroupRuleProbeFreshMs;
            if (now.getTime() >= expiresAt) {
              agentFailureFinal = true;
              observedFailureSince = new Date(expiresAt);
              message = "Agent health result missing for 5 minutes";
            } else {
              agentHealthPending = true;
              nextProbeExpiryAt = expiresAt;
              message = "Waiting for Agent health result";
            }
          }
          break;
        }
        const recordedAt = toDate(stat.recordedAt);
        if (recordedAt) {
          const expiresAt = recordedAt.getTime() + forwardGroupRuleProbeFreshMs;
          nextProbeExpiryAt = nextProbeExpiryAt === null ? expiresAt : Math.min(nextProbeExpiryAt, expiresAt);
        }
        const agentHealthStatus = String(stat.healthStatus || "").trim().toLowerCase();
        if (agentHealthStatus === "unknown") {
          healthy = false;
          agentHealthPending = true;
          message = "Waiting for Agent health decision";
          break;
        }
        if (agentHealthStatus === "unhealthy") {
          healthy = false;
          agentFailureFinal = true;
          message = "Agent health check failed";
          break;
        }
        if (agentHealthStatus !== "healthy" && dbBool(stat.isTimeout)) {
          healthy = false;
          message = "Latency probe timeout";
          break;
        }
        if (stat && typeof stat.latencyMs !== "undefined" && stat.latencyMs !== null) {
          latencies.push(Number(stat.latencyMs));
        }
      }
      if (healthy && dbBool(group.chinaHealthCheckEnabled)) {
        const chinaStatus = agentHealthSampleIsCurrent(agentLiveness, member.chinaHealthCheckedAt)
          ? forwardGroupChinaHealthStateAt(member, now.getTime())
          : "pending";
        if (chinaStatus === "unhealthy") {
          healthy = false;
          message = "国内健康度检测超时";
        } else if (chinaStatus === "stale" && staleSampleWithinReadinessGrace(toDate(member.chinaHealthCheckedAt)?.getTime(), now.getTime())) {
          healthy = false;
          chinaHealthPending = true;
          nextProbeExpiryAt = forwardGroupPanelReadyAt() + FORWARD_GROUP_READINESS_SAMPLE_GRACE_MS;
          message = "等待国内健康度检测数据（面板刚恢复）";
        } else if (chinaStatus === "stale") {
          healthy = false;
          message = "国内健康度检测数据已过期";
          const checkedAt = toDate(member.chinaHealthCheckedAt);
          if (checkedAt) observedFailureSince = new Date(checkedAt.getTime() + FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS);
        } else if (chinaStatus !== "healthy") {
          healthy = false;
          chinaHealthPending = true;
          message = "等待国内健康度检测数据";
        } else if (typeof member.chinaHealthLatencyMs === "number") {
          latencies.push(Number(member.chinaHealthLatencyMs));
        }
      }
      if (healthy && external && (external.state === "failing" || external.state === "down")) {
        // 成员自己报告正常，但别的机器连不上它的入口端口（转发进程挂了、端口被拦）：访客也连不上。
        healthy = false;
        message = `外部观察连不上入口端口（${peerHealth!.label}）`;
        if (external.failingSince) observedFailureSince = new Date(external.failingSince);
        if (external.down) agentFailureFinal = true;
      }
      if (healthy) {
        latencyMs = latencies.length > 0 ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length) : null;
        message = latencies.length > 0 ? "Latency probe normal" : "Rule is running, waiting for latency probe data";
        if (peerHealth?.label) message = `${message}；${peerHealth.label}`;
      }
    }
  }

  const healthPending = agentHealthPending || chinaHealthPending;
  const prevFailure = toDate(member.failureSince);
  const prevHealthy = toDate(member.healthySince);
  let failureSince = healthy || healthPending ? null : (prevFailure || observedFailureSince || now);
  if (failureSince && observedFailureSince && observedFailureSince.getTime() < failureSince.getTime()) {
    failureSince = observedFailureSince;
  }
  const healthySince = healthy ? (prevHealthy || now) : null;
  const nextHealthStatus = healthy ? "healthy" : healthPending ? "unknown" : "unhealthy";
  const sameTime = (left: unknown, right: Date | null) => {
    const leftTime = toDate(left)?.getTime() ?? null;
    const rightTime = right?.getTime() ?? null;
    return leftTime === rightTime;
  };
  const lastCheckedAt = toDate(member.lastCheckedAt);
  const healthStateChanged = String(member.healthStatus || "unknown") !== nextHealthStatus
    || !sameTime(member.failureSince, failureSince)
    || !sameTime(member.healthySince, healthySince);
  const healthSnapshotDue = agentLiveness.available
    && (!lastCheckedAt || now.getTime() - lastCheckedAt.getTime() >= 5 * 60 * 1000);
  if (healthStateChanged || healthSnapshotDue) {
    await db.update(forwardGroupMembers).set({
      healthStatus: nextHealthStatus,
      lastLatencyMs: latencyMs,
      failureSince,
      healthySince,
      ...(agentLiveness.available ? { lastCheckedAt: now } : {}),
      updatedAt: now,
    } as any).where(eq(forwardGroupMembers.id, member.id));
  }

  const failedLongEnough = agentFailureFinal
    || (!!failureSince && Date.now() - failureSince.getTime() >= forwardGroupFailoverDelayMs(group));
  /*
    「恢复够久」只按面板自己看到的算（P3）：成员连续健康满 recoverSeconds 才有资格被切回。

    以前 Agent 报「健康」就立刻算数（healthy && allRuleHealthAgentFinal）。成员 Agent 重启后它本地的
    恢复观察是从零开始的，第一个正常样本就报 healthy，面板马上把解析切回去 —— 那台机器可能还在
    反复重启。Agent 的结论照样决定「健不健康」，但「稳没稳住」由面板计时：
      · healthySince：面板第一次看到它健康的时刻，中间只要有一次不健康 / 等结果就清掉重计；
      · 机器刚从离线回来（lastRestoredAt）：从回来那一刻起算，哪怕成员表里的 healthySince 更早
        （面板没来得及在它离线期间评估一轮）。
    逃生（当前成员不可用）不看这个，照旧立刻换。
  */
  const recoverySinceMs = healthy && healthySince
    ? Math.max(healthySince.getTime(), Number(agentLiveness.lastRestoredAt || 0))
    : 0;
  const recoverySince = recoverySinceMs > 0 ? new Date(Math.min(recoverySinceMs, Date.now())) : null;
  const recoveredLongEnough = !!recoverySince
    && Date.now() - recoverySince.getTime() >= forwardGroupRecoverDelayMs(group);
  return {
    ...member,
    healthy,
    healthPending,
    chinaHealthPending,
    latencyMs,
    message,
    failureSince,
    healthySince,
    failedLongEnough,
    recoveredLongEnough,
    recoverySince,
    nextProbeExpiryAt,
    agentLivenessSignature: agentLiveness.signature,
    externalOnly,
    peerHealthLabel: peerHealth?.label || "",
  };
}

/**
 * 组 DDNS 写服务商都走这里：先写主记录，开了双栈（forwardGroupDualStackDdns）再按同一批成员写另一族。
 * 副记录失败也算这次同步失败 —— 两族不一致比都没更新更糟（双栈客户端会连到已经切走的那台）。
 */
type ForwardGroupDdnsTarget = { id?: unknown; domain?: unknown; recordType?: unknown; ddnsDualStack?: unknown; ddnsAutoResolveEnabled?: unknown };

/** 主记录发了 primaryValues 时，双栈副记录上该是哪些值（按成员一一对应）。 */
async function forwardGroupMirrorPairs(group: ForwardGroupDdnsTarget, primaryType: ForwardGroupRecordType, mirrorType: "A" | "AAAA") {
  const pairs: Array<{ primary: string; mirror: string }> = [];
  const members: unknown[] = sortedMembers(group);
  for (const member of members) {
    const primary = await memberDdnsValue(member, primaryType).catch(() => "");
    const mirror = primary ? await memberDdnsValue(member, mirrorType).catch(() => "") : "";
    if (primary && mirror) pairs.push({ primary, mirror });
  }
  return pairs;
}

async function forwardGroupMirrorValues(group: ForwardGroupDdnsTarget, primaryType: ForwardGroupRecordType, mirrorType: "A" | "AAAA", primaryValues: string[]) {
  return mirrorForwardGroupDdnsValues(primaryValues, await forwardGroupMirrorPairs(group, primaryType, mirrorType));
}

/*
  入口组「按权重解析」（shared/ddnsWeights.ts）：weights 给了就按服务商的记录权重发布；clearWeights 是
  「之前按权重发过、这次不按了」，先把服务商那边的权重设置收掉再照常发布。两样都没给 —— 绝大多数组 ——
  走的还是原来那两行，一个请求都不多。
*/
type ForwardGroupDdnsWeighting = { weights?: DdnsWeights | null; clearWeights?: boolean };

async function publishForwardGroupDdnsValues(group: ForwardGroupDdnsTarget, input: DdnsRecordValuesInput, weighting: ForwardGroupDdnsWeighting = {}) {
  const mirrorType = forwardGroupMirrorRecordType(group);
  if (!weighting.weights && !weighting.clearWeights) {
    await updateDdnsRecordValues(input);
    if (!mirrorType) return;
    const primaryType = normalizeForwardGroupRecordType(input.recordType);
    await updateDdnsRecordValues({ ...input, recordType: mirrorType, values: await forwardGroupMirrorValues(group, primaryType, mirrorType, input.values) });
    return;
  }
  const settings = await getDdnsSettings();
  const write = async (recordInput: DdnsRecordValuesInput, weights: DdnsWeights | null) => {
    if (weights && recordInput.values.length >= 2) {
      await publishWeightedDdnsRecords(settings, {
        domain: recordInput.domain,
        recordType: recordInput.recordType,
        values: recordInput.values,
        weights,
        ttl: recordInput.ttl,
      });
      return;
    }
    await clearDdnsRecordWeights(settings, { domain: recordInput.domain, recordType: recordInput.recordType, values: recordInput.values, ttl: recordInput.ttl });
    await updateDdnsRecordValues(recordInput);
  };
  await write(input, weighting.weights || null);
  if (!mirrorType) return;
  // 双栈副记录跟着同一批成员走：权重也按成员带过去（副记录上凑不齐的就不带权重）。
  const primaryType = normalizeForwardGroupRecordType(input.recordType);
  const pairs = await forwardGroupMirrorPairs(group, primaryType, mirrorType);
  const mirrorValues = mirrorForwardGroupDdnsValues(input.values, pairs);
  let mirrorWeights: DdnsWeights | null = null;
  if (weighting.weights) {
    mirrorWeights = {};
    for (const pair of pairs) {
      const weight = weighting.weights[pair.primary];
      if (weight && mirrorValues.includes(pair.mirror)) mirrorWeights[pair.mirror] = Math.max(mirrorWeights[pair.mirror] || 0, weight);
    }
    if (mirrorValues.some((value) => !(value in mirrorWeights!))) mirrorWeights = null;
  }
  await write({ ...input, recordType: mirrorType, values: mirrorValues }, mirrorWeights);
}

/** 这个组这一轮的记录权重：发不发、发什么、要不要因为权重变了重写一次记录。 */
function resolveEntryGroupDdnsWeighting(
  group: LineGroupRow,
  ddnsSettings: DdnsSettings,
  plan: BandwidthAggregationPlan | null,
  values: string[],
  recordType: ForwardGroupRecordType,
) {
  const previous = parseDdnsWeightState(group.ddnsWeightState);
  const domain = String(group.domain || "").trim().toLowerCase();
  // 上一次的权重是不是写在现在这家服务商、这个名字、这个类型上：不是的话那边的设置面板收不了，只丢掉记的状态。
  const previousHere = previous && previous.provider === ddnsSettings.provider && previous.domain === domain && previous.recordType === recordType ? previous : null;
  const wanted = dbBool(group.ddnsWeightEnabled)
    && isBandwidthAggregationGroup(group)
    && ddnsWeightRecordTypeSupported(recordType)
    && ddnsWeightSupport(ddnsSettings).supported;
  let weights = wanted ? ddnsWeightsFromAggregationPlan(plan, values) : null;
  if (weights && previousHere) {
    // 「按剩余带宽」的份额跟着实时流量动：变化在死区里就沿用上一次发出去的权重，不为这点变化改记录。
    const tolerance = resolveAggregationSettings(group).strategy === "adaptive" ? DDNS_WEIGHT_ADAPTIVE_TOLERANCE : 0;
    if (ddnsWeightsEqual(previousHere.weights, weights, tolerance)) weights = previousHere.weights;
  }
  const clearWeights = !weights && !!previousHere;
  return {
    weights,
    clearWeights,
    /** 值的集合没变也要写一次服务商（权重变了、或者要把权重收掉）。 */
    writeNeeded: weights ? !previousHere || !ddnsWeightsEqual(previousHere.weights, weights) : clearWeights,
    nextState: weights ? JSON.stringify({ provider: ddnsSettings.provider, domain, recordType, weights }) : null,
    note: weights ? `；按权重解析 ${describeDdnsWeights(weights, values)}` : "",
  };
}

/*
  删主备组 / 入口组时把面板发过的解析记录清掉（P6）。以前组删了记录还留在服务商那边：域名继续解析到
  那几台机器，而面板里已经没有任何东西管它，机器换了 IP、下线了也不会再跟着改。

  只删面板自己写的，用的就是发布时记的那几样：
    · 主记录：组的 lastDdnsValue（真的写过服务商才算，看 lastDdnsAt）里的那几个值，按值删；
    · 双栈副记录：同一批成员对应的另一族地址；
    · 分线路记录：ddnsLineState 里记的记录 ID（deleteDdnsLineRecords 只删这些 ID）。
  这个名字上别人手动加的记录、别的服务商上的记录一律不动；自动解析关着的组面板从没替它写过，也不动。
  清不掉不拦删除：记面板日志，让人去服务商那边手动清。停用组不清（恢复时还要用）。
*/
export async function clearForwardGroupPublishedDdns(group: ForwardGroupDdnsTarget & {
  groupMode?: unknown;
  lastDdnsAt?: unknown;
  lastDdnsValue?: unknown;
  ddnsLineState?: unknown;
} | null | undefined) {
  if (!group) return;
  const groupId = Number(group?.id || 0);
  const mode = forwardGroupModeOf(group);
  const domain = String(group?.domain || "").trim();
  if ((mode !== "failover" && mode !== "entry") || !domain || group?.ddnsAutoResolveEnabled === false) return;
  const publishedValues = toDate(group?.lastDdnsAt)
    ? String(group?.lastDdnsValue || "").split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const lineState = parseDdnsLineState(group?.ddnsLineState);
  const lineEntries = lineState ? Object.values(lineState.lines).filter((entry) => entry.recordIds.length > 0) : [];
  if (publishedValues.length === 0 && lineEntries.length === 0) return;
  const label = `group=${groupId} domain=${domain}`;
  const failed = (what: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ForwardGroup] delete: clearing ${what} failed ${label}: ${message}`);
    appendPanelLog("warn", `[DDNS] 转发组已删除，但${what}没清掉，请到 DNS 服务商手动删除；${label} ${message}`);
  };
  const ddnsSettings = await getDdnsSettings();
  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    appendPanelLog("warn", `[DDNS] 转发组已删除，系统 DDNS 未启用，之前发布的解析记录没有清理，请到 DNS 服务商手动删除；${label} values=${publishedValues.join(",")}`);
    return;
  }
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const ttl = Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL);
  if (publishedValues.length > 0) {
    try {
      // 按权重发布过的组：先把服务商那边的权重设置收掉（华为云是合回一个记录集），再按值删。
      const weightState = parseDdnsWeightState((group as { ddnsWeightState?: unknown }).ddnsWeightState);
      if (weightState && weightState.provider === ddnsSettings.provider && weightState.domain === domain.toLowerCase() && ddnsWeightSupport(ddnsSettings).supported) {
        await clearDdnsRecordWeights(ddnsSettings, { domain, recordType: weightState.recordType, values: publishedValues, ttl }).catch((error) => {
          failed("记录权重设置", error);
        });
      }
      await updateDdnsRecordValues({ groupId, domain, recordType, values: [], removeOnlyValues: publishedValues, ttl });
      appendPanelLog("info", `[DDNS] 转发组已删除，面板发布的解析记录已清理；${label} type=${recordType} values=${publishedValues.join(",")}`);
    } catch (error) {
      failed(`${recordType} 记录（${publishedValues.join(",")}）`, error);
    }
    const mirrorType = forwardGroupMirrorRecordType(group);
    if (mirrorType) {
      try {
        const mirrorValues = await forwardGroupMirrorValues(group, recordType, mirrorType, publishedValues);
        if (mirrorValues.length > 0) await updateDdnsRecordValues({ groupId, domain, recordType: mirrorType, values: [], removeOnlyValues: mirrorValues, ttl });
      } catch (error) {
        failed(`双栈 ${mirrorType} 记录`, error);
      }
    }
  }
  if (lineState && lineEntries.length > 0) {
    const support = ddnsLineSupport(ddnsSettings);
    if (!support.supported || support.provider !== lineState.provider) {
      // 记录 ID 是原来那家服务商的，绝不拿去现在这家删。
      appendPanelLog("warn", `[DDNS] 转发组已删除，分线路记录写在另一家服务商（${ddnsLineProviderLabel(lineState.provider)}），面板没有清理，请手动删除；${label}`);
      return;
    }
    for (const entry of lineEntries) {
      try {
        await deleteDdnsLineRecords(ddnsSettings, { domain: lineState.domain || domain, recordType: lineState.recordType || recordType, line: entry, recordIds: entry.recordIds });
      } catch (error) {
        failed(`线路 ${entry.name} 的记录`, error);
      }
    }
  }
}

/** 关掉双栈时把面板发过的副记录清掉：留着它，双栈客户端会一直连那条不再跟着切换的记录。 */
export async function clearForwardGroupMirrorDdns(group: ForwardGroupDdnsTarget) {
  const mirrorType = forwardGroupMirrorRecordType(group);
  const domain = String(group?.domain || "").trim();
  if (!mirrorType || !domain || group?.ddnsAutoResolveEnabled === false) return;
  const ddnsSettings = await getDdnsSettings();
  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") return;
  await updateDdnsRecordValues({ groupId: Number(group.id), domain, recordType: mirrorType, values: [], ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL) });
}

function exactDdnsSignature(group: any, value: string) {
  return [
    String(group?.domain || "").trim().toLowerCase(),
    normalizeForwardGroupRecordType(group?.recordType),
    forwardGroupMirrorRecordType(group) || "",
    value,
  ].join("|");
}

function exactDdnsReconciliationDue(group: any, value: string) {
  const groupId = Number(group?.id || 0);
  return exactDdnsReconciledGroups.get(groupId) !== exactDdnsSignature(group, value);
}

function rememberExactDdnsReconciliation(group: any, value: string) {
  exactDdnsReconciledGroups.set(Number(group?.id || 0), exactDdnsSignature(group, value));
}

async function forwardGroupDdnsFallbackValue(group: any, recordType: ForwardGroupRecordType) {
  const previous = String(group?.lastDdnsValue || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);
  if (previous) return previous;
  for (const member of sortedMembers(group, true) as any[]) {
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (value) return value;
  }
  return "";
}

async function preserveForwardGroupDdns(
  group: any,
  ddnsSettings: any,
  options: ForwardGroupFailoverOptions,
  reason: string,
) {
  const db = await getDb();
  const groupId = Number(group.id);
  const domain = String(group.domain || "").trim();
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  /*
    普通的健康故障可以保留最后一条解析等成员恢复；但流量到阈值、被暂停的主机不行 ——
    保留它就等于继续往一台快被机房停掉的机器上导流。有成员被暂停时只保留没被暂停的那些地址。
  */
  if ((await getTrafficExcludedHostIds()).size > 0) {
    const enabledMembers = sortedMembers(group, true) as any[];
    const quotaBlocked: boolean[] = [];
    for (const member of enabledMembers) quotaBlocked.push((await resolveMemberAgentLiveness(member)).trafficExcluded);
    if (quotaBlocked.some(Boolean)) {
      const allowedValues = new Set<string>();
      for (const [index, member] of enabledMembers.entries()) {
        if (!quotaBlocked[index]) allowedValues.add(await memberDdnsValue(member, recordType).catch(() => ""));
      }
      const retainedValues = String(group.lastDdnsValue || "").split(",").map((value) => value.trim()).filter((value) => value && allowedValues.has(value));
      const changed = retainedValues.join(",") !== String(group.lastDdnsValue || "").trim();
      if ((changed || options.forceSync) && ddnsSettings.enabled && ddnsSettings.provider !== "disabled" && group.ddnsAutoResolveEnabled !== false && domain) {
        if (deferProviderWrite()) return "deferred" as const;
        await publishForwardGroupDdnsValues(group, { groupId, domain, recordType, values: retainedValues, ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL) }).catch((error) => {
          console.warn(`[ForwardGroup] removing traffic-excluded DDNS values failed group=${groupId}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      await updateForwardGroupRuntimeIfChanged(db, group, {
        activeMemberId: null,
        lastDdnsValue: retainedValues.join(",") || null,
        lastStatus: "down",
        lastMessage: retainedValues.length
          ? `${reason}；保留未超量的入口，等待恢复`
          : "没有可用成员：流量到阈值的主机已暂停参与，等流量重置或关闭流量故障转移后恢复",
      });
      return;
    }
  }
  const retainedValue = await forwardGroupDdnsFallbackValue(group, recordType);
  const shouldReconcile = !!options.forceSync
    || (!!retainedValue && exactDdnsReconciliationDue(group, retainedValue));

  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastDdnsValue: retainedValue || group.lastDdnsValue || null,
      lastStatus: "down",
      lastMessage: retainedValue
        ? `${reason}；保留最后一条解析 ${retainedValue}，系统 DDNS 未启用`
        : `${reason}；无法确定保底地址，未修改解析`,
    });
    return;
  }

  if (!retainedValue) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "down",
      lastMessage: `${reason}；无法确定保底地址，未修改服务商解析`,
    });
    return;
  }

  if (!shouldReconcile) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastDdnsValue: retainedValue,
      lastStatus: "down",
      lastMessage: `${reason}；继续保留解析 ${retainedValue}，等待成员恢复`,
    });
    return;
  }

  if (deferProviderWrite()) return "deferred" as const;
  try {
    await publishForwardGroupDdnsValues(group, {
      groupId,
      domain,
      recordType,
      values: [retainedValue],
      ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL),
    });
    rememberExactDdnsReconciliation(group, retainedValue);
    await db.update(forwardGroups).set({
      lastDdnsValue: retainedValue,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "down",
      lastMessage: `${reason}；已保留一条解析 ${retainedValue}，等待成员恢复`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, groupId));
    await insertForwardGroupEvent(groupId, Number(group.activeMemberId || 0) || null, "ddns-hold", `没有健康成员，保留一条 DDNS 解析；domain=${domain} type=${recordType} value=${retainedValue}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(forwardGroups).set({
      activeMemberId: null,
      lastStatus: "error",
      lastMessage: `${reason}；保留服务商解析失败：${message}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, groupId));
    await insertForwardGroupEvent(groupId, null, "ddns-error", `保留 DDNS 解析失败：${message}；domain=${domain} type=${recordType} value=${retainedValue}`);
    throw error;
  }
}

/**
 * Order-insensitive signature of a DDNS value list, used to decide whether the
 * provider record set actually changed.
 */
function ddnsValueSetSignature(value: string) {
  return Array.from(new Set(String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean)))
    .sort()
    .join(",");
}

/** Live uplink throughput, in Mbps, for the hosts behind a set of members. */
async function memberThroughputMbps(members: AggregationMemberRow[]) {
  const hostIds = Array.from(new Set(members
    .map((member) => Number(member.hostId || 0))
    .filter((hostId) => Number.isInteger(hostId) && hostId > 0)));
  if (hostIds.length === 0) return new Map<number, number>();
  const snapshots = await getLatestHostMetricSnapshots(hostIds).catch(() => []);
  return hostThroughputMbpsFromSnapshots(snapshots as any[]);
}

/**
 * Build the bandwidth aggregation plan for an entry group and apply it to the
 * DDNS values about to be published.
 *
 * Returns `null` for groups that did not opt into aggregation so the caller
 * keeps its existing behaviour untouched.
 */
/** 成员上没填「上行 Mbps」时，用主机上的「线路带宽」（一台机器只填一处）。 */
async function withHostLineBandwidth<T extends { hostId: number; bandwidthMbps?: number | null }>(members: T[]): Promise<T[]> {
  const missing = Array.from(new Set(members.filter((member) => !(Number(member.bandwidthMbps) > 0) && member.hostId > 0).map((member) => member.hostId)));
  if (missing.length === 0) return members;
  const rows = await getHostsByIds(missing).catch(() => []) as any[];
  const lineById = new Map(rows.map((row) => [Number(row.id), Math.max(0, Number(row.lineBandwidthMbps) || 0)]));
  return members.map((member) => (Number(member.bandwidthMbps) > 0 || !lineById.get(member.hostId)
    ? member
    : { ...member, bandwidthMbps: lineById.get(member.hostId)! }));
}

async function resolveEntryGroupAggregation(
  group: any,
  members: AggregationMemberRow[],
  values: string[],
  recordType: ForwardGroupRecordType,
) {
  if (!isBandwidthAggregationGroup(group) || members.length === 0 || values.length === 0) return null;
  members = await withHostLineBandwidth(members);
  // The adaptive strategy is the only one that needs live throughput, so the
  // extra metric read is skipped for the static strategies.
  const strategy = resolveAggregationSettings(group).strategy;
  const throughputByHostId = strategy === "adaptive"
    ? await memberThroughputMbps(members)
    : new Map<number, number>();
  const plan = buildEntryGroupAggregationPlan({
    group,
    members,
    throughputByHostId,
    singleValuePerMember: recordType === "CNAME",
  });
  const applied = applyAggregationToDdnsValues(plan, values);
  return { ...applied, plan };
}

/*
  分线路解析（server/forwardGroupDdnsLines.ts）挂在组原来那次 DDNS 发布上的钩子：默认线路那套逻辑
  在评估每个成员时顺手把结论记下来（note），评估完只发布默认线路上的成员，走到「默认线路已经定了」
  的几个出口（发布成功 / 已是最新 / 保留最后一条 / 等健康结果）时标 settled，之后再按线路发布。
  没分线路的组钩子是 null，原来的每一步都不变。
*/
// 组 / 成员行在这个文件里都是宽松的查询结果；分线路这几处沿用 sortedMembers 的同一个形状，不另起类型。
type LineGroupRow = Parameters<typeof sortedMembers>[0];
type LineMemberRow = ReturnType<typeof sortedMembers>[number];

type ForwardGroupLineHook = {
  ctx: ForwardGroupLineContext;
  defaultMemberIds: Set<number>;
  /** 上一轮各条线路发布过的值：成员在别的线路里也算「已经在解析里」，故障观察时间照样给。 */
  previouslyPublished: Set<string>;
  members: LinePlannerMember[];
  settled: boolean;
  note(member: LineMemberRow, value: string, status: LineMemberStatus, recovered?: boolean): void;
};

function createForwardGroupLineHook(group: LineGroupRow, ctx: ForwardGroupLineContext): ForwardGroupLineHook {
  const domain = String(group.domain || "").trim().toLowerCase();
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const previouslyPublished = new Set<string>();
  if (ctx.state && ctx.state.provider === ctx.provider && ctx.state.domain === domain && ctx.state.recordType === recordType) {
    for (const entry of Object.values(ctx.state.lines)) for (const value of entry.values) previouslyPublished.add(value);
  }
  const members: LinePlannerMember[] = [];
  return {
    ctx,
    defaultMemberIds: new Set(ctx.defaultOnly(sortedMembers(group, true)).map((member) => Number(member.id))),
    previouslyPublished,
    members,
    settled: false,
    note(member, value, status, recovered) {
      const memberId = Number(member?.id || 0);
      if (!memberId || members.some((entry) => entry.memberId === memberId)) return;
      members.push({
        memberId,
        hostId: Number(member.hostId || 0),
        priority: Number(member.priority || 0),
        value,
        lines: ctx.linesOf(member),
        status,
        recovered,
        bandwidthMbps: Number(member.bandwidthMbps || 0),
        aggregationWeight: Number(member.aggregationWeight || 0),
      });
    },
  };
}

/** 入口组按线路排序时用的带宽排序：和默认线路同一套（server/bandwidthAggregation.ts），只是成员换成这条线路的。 */
async function entryGroupLineRanker(group: LineGroupRow, members: LinePlannerMember[], recordType: ForwardGroupRecordType) {
  if (!isBandwidthAggregationGroup(group) || members.length === 0) return undefined;
  const rows = await withHostLineBandwidth(members.map((member): AggregationMemberRow => ({
    memberId: member.memberId,
    hostId: member.hostId,
    value: member.value,
    healthy: true,
    bandwidthMbps: member.bandwidthMbps,
    aggregationWeight: member.aggregationWeight,
  })));
  const throughputByHostId = resolveAggregationSettings(group).strategy === "adaptive"
    ? await memberThroughputMbps(rows)
    : new Map<number, number>();
  const rowById = new Map<number, AggregationMemberRow>(rows.map((row) => [row.memberId, row]));
  return (lineMembers: LinePlannerMember[], values: string[]) => {
    const plan = buildEntryGroupAggregationPlan({
      group,
      members: lineMembers.map((member) => rowById.get(member.memberId)).filter((row): row is AggregationMemberRow => !!row),
      throughputByHostId,
      singleValuePerMember: recordType === "CNAME",
    });
    return applyAggregationToDdnsValues(plan, values).values;
  };
}

async function syncForwardGroupLinesAfterDefault(group: LineGroupRow, ddnsSettings: DdnsSettings, hook: ForwardGroupLineHook, mode: "multi" | "single", options: ForwardGroupFailoverOptions) {
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  await syncForwardGroupDdnsLines({
    group,
    ctx: hook.ctx,
    settings: ddnsSettings,
    mode,
    members: hook.members,
    forceSync: !!options.forceSync,
    rank: mode === "multi" ? await entryGroupLineRanker(group, hook.members, recordType).catch(() => undefined) : undefined,
    deferNetwork: deferProviderWrite,
    recordEvent: (type, message, memberId) => insertForwardGroupEvent(Number(group.id), memberId ?? null, type, message),
  });
}

/*
  共享 TLS 入站（SNI 分流）：组里有 SNI 规则时，DDNS 只切到 SNI 配置已确认的成员（判断见
  server/tlsInboundReadiness.ts）。当前在用的成员不在这里被撤掉：面板刚重启时谁都还没确认，
  不能因此把正在用的入口切走。没确认的成员记一条事件（同样的原因不重复记）。
*/
const sniBlockedEventByMember = new Map<number, string>();

async function sniReadyGroupCandidates<M extends { id: unknown }>(
  group: { id: unknown; activeMemberId?: unknown },
  templates: readonly SniReadinessTemplate[],
  candidates: M[],
): Promise<M[]> {
  const { activeSniTemplates, filterSniReadyCandidates } = await import("../tlsInboundReadiness");
  if (activeSniTemplates(templates).length === 0) return candidates;
  const { ready, blocked } = await filterSniReadyCandidates({
    candidates,
    keepMemberId: group?.activeMemberId,
    templates,
    hostIdOf: (member) => memberEntryHostId(member),
  });
  for (const { member, reason } of blocked) {
    const memberId = Number(member.id);
    if (sniBlockedEventByMember.get(memberId) === reason) continue;
    if (sniBlockedEventByMember.size >= 4096) sniBlockedEventByMember.clear();
    sniBlockedEventByMember.set(memberId, reason);
    await insertForwardGroupEvent(Number(group.id), memberId, "sni-not-ready", `共享 TLS 入站未就绪，暂不切到这个成员：${reason}`).catch(() => undefined);
  }
  for (const member of ready) sniBlockedEventByMember.delete(Number(member.id));
  return ready;
}

/** 入口组本身没有模板：看挂着它的端口转发 / 转发链里的 SNI 模板。 */
async function sniTemplatesUsingEntryGroup(entryGroupId: number) {
  const db = await getDb();
  if (!db) return [] as ForwardRule[];
  const dependents = await db.select({ id: forwardGroups.id }).from(forwardGroups)
    .where(and(eq(forwardGroups.entryGroupId, Number(entryGroupId)), sql`${forwardGroups.id} <> ${Number(entryGroupId)}`));
  const templates: ForwardRule[] = [];
  for (const dependent of dependents) {
    for (const template of await getForwardGroupTemplateRules(Number(dependent.id))) {
      if (Number(template?.tlsInboundId || 0) > 0) templates.push(template);
    }
  }
  return templates;
}

async function syncEntryGroupDdns(group: any, ddnsSettings: any, options: ForwardGroupFailoverOptions = {}) {
  const lineCtx = prepareForwardGroupDdnsLines(group, ddnsSettings);
  if (!lineCtx) return syncEntryGroupDefaultDdns(group, ddnsSettings, options, null);
  const hook = createForwardGroupLineHook(group, lineCtx);
  await syncEntryGroupDefaultDdns(group, ddnsSettings, options, hook);
  if (hook.settled) await syncForwardGroupLinesAfterDefault(group, ddnsSettings, hook, "multi", options);
}

/** 这个组最近一小时每个成员的自动进出（auto-switch 事件，按成员分）：入口组的抖动抑制按成员算。 */
async function forwardGroupAutoSwitchTimesByMember(groupId: number, nowMs: number) {
  const sinceSeconds = Math.floor((nowMs - FORWARD_GROUP_FLAP_WINDOW_MS) / 1000);
  const rows = await queryRaw<{ memberId: unknown; createdAt: unknown }>(
    `SELECT ${quoteIdentifier("memberId")}, ${quoteIdentifier("createdAt")} FROM ${quoteIdentifier("forward_group_events")}
      WHERE ${quoteIdentifier("groupId")} = ? AND ${quoteIdentifier("type")} = ? AND ${quoteIdentifier("createdAt")} >= ?`,
    [groupId, FORWARD_GROUP_AUTO_SWITCH_EVENT, sinceSeconds],
  ).catch(() => []);
  const byMember = new Map<number, number[]>();
  for (const row of rows) {
    const memberId = Number(row.memberId || 0);
    const at = toDate(row.createdAt)?.getTime() || 0;
    if (!(memberId > 0) || !(at > 0)) continue;
    const list = byMember.get(memberId);
    if (list) list.push(at);
    else byMember.set(memberId, [at]);
  }
  return byMember;
}

/*
  入口组一个健康成员都没有时怎么办（plan 来自 evaluate.ts 的 planEntryGroupRecordSet）：

    · hold-all：保留上一轮发布的整组，不动服务商（只有保留下来的集合和上一轮不一样、或者这个进程还没和
      服务商对过账时才写一次）。以前缩成 lastDdnsValue 的第一条。
    · empty：成员全部被管理动作排除（流量到阈值）—— 清掉记录，记一条事件。
    · none：没有上一轮可保留，什么都不改。
*/
async function holdEntryGroupDdns(
  group: LineGroupRow,
  ddnsSettings: DdnsSettings,
  options: ForwardGroupFailoverOptions,
  plan: ReturnType<typeof planEntryGroupRecordSet>,
  reason: string,
) {
  const db = await getDb();
  const groupId = Number(group.id);
  const domain = String(group.domain || "").trim();
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const previousValue = String(group.lastDdnsValue || "").trim();
  const ddnsReady = ddnsSettings.enabled && ddnsSettings.provider !== "disabled";
  const ttl = Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL);
  const previousWeights = parseDdnsWeightState(group.ddnsWeightState);
  const weightsHere = previousWeights && previousWeights.provider === ddnsSettings.provider
    && previousWeights.domain === domain.toLowerCase() && previousWeights.recordType === recordType ? previousWeights.weights : null;

  if (plan.mode === "empty") {
    if ((previousValue || options.forceSync) && ddnsReady && domain) {
      if (deferProviderWrite()) return "deferred" as const;
      await publishForwardGroupDdnsValues(group, { groupId, domain, recordType, values: [], ttl }, { clearWeights: !!weightsHere }).catch((error) => {
        console.warn(`[ForwardGroup] removing traffic-excluded DDNS values failed group=${groupId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await updateForwardGroupRuntimeIfChanged(db, group, {
      activeMemberId: null,
      lastDdnsValue: null,
      ddnsWeightState: null,
      lastStatus: "down",
      lastMessage: "没有可用成员：流量到阈值的主机已暂停参与，等流量重置或关闭流量故障转移后恢复",
    });
    if (previousValue) {
      await insertForwardGroupEvent(groupId, null, "ddns-empty", `入口组的成员全部因流量到阈值被暂停，解析记录已清空；domain=${domain || "-"} type=${recordType} 原记录=${previousValue}`);
    }
    return;
  }
  if (plan.mode === "none") {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "down",
      lastMessage: ddnsReady ? `${reason}；无法确定保底地址，未修改服务商解析` : `${reason}；无法确定保底地址，未修改解析`,
    });
    return;
  }

  const retained = plan.values;
  const joined = retained.join(",");
  const partial = ddnsValueSetSignature(joined) !== ddnsValueSetSignature(previousValue);
  const holdMessage = `${reason}；${partial ? "保留未超量的入口" : "全部入口都不健康，保留上一轮发布的"} ${retained.length} 条解析，等待成员恢复`;
  if (!ddnsReady) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastDdnsValue: joined,
      lastStatus: "down",
      lastMessage: `${holdMessage}（系统 DDNS 未启用）`,
    });
    return;
  }
  if (!partial && !options.forceSync && !exactDdnsReconciliationDue(group, joined)) {
    await updateForwardGroupRuntimeIfChanged(db, group, { lastStatus: "down", lastMessage: holdMessage });
    return;
  }
  // 保留下来的值之前带着权重就原样带着（集合里每个值都有、而且不止一条）；凑不齐就把权重收掉。
  const heldWeights = weightsHere && retained.length >= 2 && retained.every((value) => value in weightsHere)
    ? Object.fromEntries(retained.map((value) => [value, weightsHere[value]]))
    : null;
  if (deferProviderWrite()) return "deferred" as const;
  try {
    await publishForwardGroupDdnsValues(group, { groupId, domain, recordType, values: retained, ttl }, { weights: heldWeights, clearWeights: !heldWeights && !!weightsHere });
    rememberExactDdnsReconciliation(group, joined);
    await db.update(forwardGroups).set({
      lastDdnsValue: joined,
      ddnsWeightState: heldWeights ? JSON.stringify({ provider: ddnsSettings.provider, domain: domain.toLowerCase(), recordType, weights: heldWeights }) : null,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "down",
      lastMessage: holdMessage,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, groupId));
    await insertForwardGroupEvent(groupId, null, "ddns-hold", `没有健康入口，保留 ${retained.length} 条 DDNS 解析；domain=${domain} type=${recordType} values=${joined}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(forwardGroups).set({
      lastStatus: "error",
      lastMessage: `${reason}；保留服务商解析失败：${message}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, groupId));
    await insertForwardGroupEvent(groupId, null, "ddns-error", `保留 DDNS 解析失败：${message}；domain=${domain} type=${recordType} values=${joined}`);
    throw error;
  }
}

/*
  国内检测「原始结果连得上」是从什么时候开始的（面板看到的，进程内存）。成员 Agent 自己要连续正常满
  recoverSeconds 才报 healthy，但它重启后状态是空的，第一个正常样本就报 healthy —— 入口组把成员加回来
  之前要「连续健康满 recoverSeconds」，这段时间只认面板自己看到的：Agent 稳了一阵才报的 healthy，
  面板这边早就在数了，不用再等一遍；Agent 刚重启就报的，从现在数起。
*/
const chinaReachableSinceByMember = new Map<number, number>();

async function syncEntryGroupDefaultDdns(group: LineGroupRow, ddnsSettings: DdnsSettings, options: ForwardGroupFailoverOptions = {}, lines: ForwardGroupLineHook | null = null) {
  const db = await getDb();
  const members = sortedMembers(group, true) as any[];
  const sniTemplates = await sniTemplatesUsingEntryGroup(Number(group.id));
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const forceSync = !!options.forceSync;
  const previousValue = String(group.lastDdnsValue || "").trim();
  const previousValues = new Set(previousValue.split(",").map((value) => value.trim()).filter(Boolean));
  const values: string[] = [];
  const excluded: string[] = [];
  const quotaExcludedValues: string[] = [];
  const healthWindows: any[] = [];
  const initialHealthSnapshot = new Map<number, string>();
  const initialAgentLivenessSnapshot = new Map<number, string>();
  const agentLivenessByMemberId = new Map<number, MemberAgentLiveness>();
  const pendingHealthExpiryCandidates: number[] = [];
  let activeMemberId: number | null = null;
  const chinaHealthEnabled = dbBool(group.chinaHealthCheckEnabled);
  const chinaHealthNow = Date.now();
  const healthNow = new Date(chinaHealthNow);
  const failoverMs = forwardGroupFailoverDelayMs(group);
  const recoverMs = forwardGroupRecoverDelayMs(group);
  let pendingAgentHealth = false;
  let trafficExcludedMemberCount = 0;
  let valuedMemberCount = 0;
  // 状态消息里要说清楚的几种「健康却没在解析里 / 不健康却还在」：
  let recoveringCount = 0;
  let flapHeldCount = 0;
  let externalKeptCount = 0;
  let externalDownCount = 0;
  let peerObservedCount = 0;
  // 这一轮因为健康变化自动拿掉 / 加回的成员：发布成功后各记一条 auto-switch（抖动抑制按它计数）。
  const autoChanges: Array<{ memberId: number; kind: "removed" | "added" }> = [];
  let autoSwitchTimesByMember: Map<number, number[]> | null = null;
  const flapHoldUntilFor = async (memberId: number) => {
    // 人工操作不受抖动抑制限制（和主备组一样）。
    if (options.manual || options.forcePriority) return 0;
    if (!autoSwitchTimesByMember) autoSwitchTimesByMember = await forwardGroupAutoSwitchTimesByMember(Number(group.id), chinaHealthNow);
    return forwardGroupFlapHoldAt(autoSwitchTimesByMember.get(memberId) || [], chinaHealthNow).untilMs;
  };
  // Bandwidth aggregation needs the member behind every published value so it
  // can weight the records by each front VPS's declared uplink.
  const aggregationMembers: AggregationMemberRow[] = [];
  const includeMember = (member: any, value: string) => {
    if (!values.includes(value)) {
      values.push(value);
      if (!activeMemberId) activeMemberId = Number(member.id || 0) || null;
    }
    if (!aggregationMembers.some((entry) => entry.memberId === Number(member.id || 0))) {
      aggregationMembers.push({
        memberId: Number(member.id || 0),
        hostId: Number(member.hostId || 0),
        value,
        healthy: true,
        bandwidthMbps: Number(member.bandwidthMbps || 0),
        aggregationWeight: Number(member.aggregationWeight || 0),
      });
    }
  };
  for (const member of members) {
    if (member.memberType !== "host") continue;
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (!value) {
      lines?.note(member, "", "down");
      continue;
    }
    valuedMemberCount += 1;
    const previouslyIncluded = previousValues.has(value) || !!lines?.previouslyPublished.has(value);
    // SNI：还没解析到它的成员，SNI 配置没确认就先不加进来（已经在解析里的照旧按健康度判断）。
    if (!previouslyIncluded && sniTemplates.length > 0
      && (await sniReadyGroupCandidates({ id: group.id, activeMemberId: null }, sniTemplates, [member])).length === 0) {
      if (!excluded.includes(value)) excluded.push(value);
      // 分线路那边也只当「还在等」：不在任何线路的解析里，就不会被加进去
      lines?.note(member, value, "pending");
      continue;
    }
    const liveness = await resolveMemberAgentLiveness(member, chinaHealthNow);
    const memberId = Number(member.id);
    initialAgentLivenessSnapshot.set(memberId, liveness.signature);
    agentLivenessByMemberId.set(memberId, liveness);
    if (liveness.trafficExcluded) {
      // 流量到阈值：立刻移出解析，不走离线宽限期。
      trafficExcludedMemberCount += 1;
      if (!excluded.includes(value)) excluded.push(value);
      if (!quotaExcludedValues.includes(value)) quotaExcludedValues.push(value);
      lines?.note(member, value, "quota");
      continue;
    }
    const checkedAt = chinaHealthEnabled ? member.chinaHealthCheckedAt : member.lastCheckedAt;
    const storedStatus = chinaHealthEnabled ? member.chinaHealthStatus : member.healthStatus;
    initialHealthSnapshot.set(
      memberId,
      `${String(storedStatus || "unknown")}:${toDate(checkedAt)?.getTime() || 0}`,
    );
    // 外部观察：别的机器看这台入口的端口通不通（没安排观察点是 null，只看成员自己的报告）。
    const peerHealth = await evaluateMemberPeerHealth(group, member, liveness.agentOnline, chinaHealthNow);
    const external = peerHealth?.decision || null;
    if (peerHealth) peerObservedCount += 1;
    if (!liveness.available && external?.reachableWhileAgentOffline) {
      // 面板连不上这台的 Agent，但观察点连得上它的入口：已经在解析里的继续留着（它的健康记录不动）；不在的不加。
      if (previouslyIncluded) {
        includeMember(member, value);
        externalKeptCount += 1;
      } else if (!excluded.includes(value)) {
        excluded.push(value);
      }
      lines?.note(member, value, "pending");
      if (recordType === "CNAME" && previouslyIncluded && !lines) break;
      continue;
    }
    let observedFailureSince: Date | null = null;
    let healthStatus = !liveness.available
      ? "offline"
      : !agentHealthSampleIsCurrent(liveness, checkedAt)
        ? "pending"
        : chinaHealthEnabled
          ? forwardGroupChinaHealthStateAt(member, chinaHealthNow)
          : forwardGroupAgentHealthStateAt(member, chinaHealthNow);
    if (!liveness.available) observedFailureSince = liveness.failureSince || healthNow;
    if (healthStatus === "stale" && staleSampleWithinReadinessGrace(toDate(checkedAt)?.getTime(), chinaHealthNow)) {
      // 面板刚启动 / 数据库刚恢复：停机期间没人收样本，样本过期不算故障，等新样本。
      healthStatus = "pending";
      pendingHealthExpiryCandidates.push(forwardGroupPanelReadyAt() + FORWARD_GROUP_READINESS_SAMPLE_GRACE_MS);
    }
    if (healthStatus === "pending" && (!toDate(checkedAt) || !agentHealthSampleIsCurrent(liveness, checkedAt))) {
      const waitingSince = liveness.lastOfflineAt
        ? new Date(liveness.lastOfflineAt)
        : toDate(member.updatedAt) || toDate(member.createdAt) || toDate(group.updatedAt) || toDate(group.createdAt) || new Date(chinaHealthNow);
      const expiresAt = waitingSince.getTime() + FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS;
      if (chinaHealthNow >= expiresAt) {
        healthStatus = "stale";
        observedFailureSince = new Date(expiresAt);
      }
      else pendingHealthExpiryCandidates.push(expiresAt);
    }
    if (healthStatus === "pending") {
      // 分线路时只有默认线路上的成员在等结果才让默认线路等；线路成员的等待由线路规划自己处理。
      if (!lines || lines.defaultMemberIds.has(memberId)) pendingAgentHealth = true;
      if (previouslyIncluded) includeMember(member, value);
      lines?.note(member, value, "pending");
      if (recordType === "CNAME" && previouslyIncluded && !lines) break;
      continue;
    }

    let healthy = healthStatus === "healthy";
    let failureFinal = false;
    if (healthy && external && (external.state === "failing" || external.state === "down")) {
      // 成员自己报告正常，但别的机器连不上它的入口端口：访客也连不上。持续满观察时间（failingSince 起算）就拿掉。
      healthy = false;
      observedFailureSince = external.failingSince ? new Date(external.failingSince) : healthNow;
      failureFinal = external.down;
      if (external.down) externalDownCount += 1;
    }
    if (!healthy && !observedFailureSince) {
      const observedAt = toDate(checkedAt);
      if (observedAt) {
        const failureAt = healthStatus === "stale"
          ? observedAt.getTime() + FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS
          : observedAt.getTime();
        observedFailureSince = new Date(Math.min(chinaHealthNow, failureAt));
      }
    }
    const previousFailureSince = toDate(member.failureSince);
    const previousHealthySince = toDate(member.healthySince);
    // 从没出过问题的新成员（新建的组、刚加进来的机器）不用等恢复观察时间。
    const neverFailed = !previousFailureSince && !previousHealthySince && String(member.healthStatus || "unknown") !== "unhealthy";
    const inclusionInput = {
      health: healthy ? "healthy" as const : "unhealthy" as const,
      previouslyIncluded,
      neverFailed,
      previousFailureSince: previousFailureSince?.getTime() ?? null,
      previousHealthySince: previousHealthySince?.getTime()
        ?? (!neverFailed && chinaHealthEnabled ? chinaReachableSinceByMember.get(memberId) ?? null : null),
      observedFailureSince: observedFailureSince?.getTime() ?? null,
      restoredAt: liveness.lastRestoredAt,
      failureFinal,
      failoverMs,
      recoverMs,
      now: chinaHealthNow,
    };
    let decision = entryMemberInclusion(inclusionInput);
    // 恢复够久、正要加回来的成员才去查抖动抑制（一小时内自动进出三次以上要多等）。
    if (decision.include && healthy && !previouslyIncluded && !neverFailed) {
      const flapHoldUntil = await flapHoldUntilFor(memberId);
      if (flapHoldUntil > chinaHealthNow) decision = entryMemberInclusion({ ...inclusionInput, flapHoldUntil });
    }
    const failureSince = decision.failureSince !== null ? new Date(decision.failureSince) : null;
    const healthySince = decision.healthySince !== null ? new Date(decision.healthySince) : null;
    const include = decision.include;

    const sameTime = (left: unknown, right: Date | null) => (toDate(left)?.getTime() ?? null) === (right?.getTime() ?? null);
    const nextHealthStatus = healthy ? "healthy" : "unhealthy";
    if (
      String(member.healthStatus || "unknown") !== nextHealthStatus
      || !sameTime(member.failureSince, failureSince)
      || !sameTime(member.healthySince, healthySince)
    ) {
      await db.update(forwardGroupMembers).set({
        healthStatus: nextHealthStatus,
        failureSince,
        healthySince,
        updatedAt: healthNow,
      } as any).where(eq(forwardGroupMembers.id, member.id));
    }

    if (decision.holdReason === "recovering") recoveringCount += 1;
    if (decision.holdReason === "flap") flapHeldCount += 1;
    if (decision.recheckAt) pendingHealthExpiryCandidates.push(decision.recheckAt);
    if (include) includeMember(member, value);
    else if (!excluded.includes(value)) excluded.push(value);
    if (previouslyIncluded && !include) autoChanges.push({ memberId, kind: "removed" });
    if (!previouslyIncluded && include && !neverFailed) autoChanges.push({ memberId, kind: "added" });
    // 健康但还在观察 / 被抖动抑制压着的成员，分线路那边只当「还在等」（不新加进线路）。
    lines?.note(member, value, include ? "up" : healthy ? "pending" : "down");
    healthWindows.push({
      healthy,
      failureSince,
      healthySince,
      failedLongEnough: decision.failedLongEnough,
      // 等恢复观察 / 抖动抑制的到点时间已经单独排了（decision.recheckAt），这里不再按 healthySince 重复排。
      recoveredLongEnough: true,
    });
    // 分线路时每条线路各取一个 CNAME，得把所有成员都评估完。
    if (recordType === "CNAME" && include && !lines) break;
  }
  const healthWindowRecheckAt = nextForwardGroupHealthRecheckAt({
    members: healthWindows,
    failoverMs,
    recoverMs,
    now: chinaHealthNow,
  });
  const expiryEligibleMembers = members.filter((member: any) => {
    const liveness = agentLivenessByMemberId.get(Number(member.id));
    const checkedAt = chinaHealthEnabled ? member.chinaHealthCheckedAt : member.lastCheckedAt;
    return !!liveness?.available && agentHealthSampleIsCurrent(liveness, checkedAt);
  });
  const healthExpiryAt = chinaHealthEnabled
    ? nextForwardGroupChinaHealthExpiryAt({ enabled: true, members: expiryEligibleMembers, now: chinaHealthNow })
    : expiryEligibleMembers
      .filter((member: any) => forwardGroupAgentHealthStateAt(member, chinaHealthNow) === "healthy")
      .map((member: any) => (toDate(member.lastCheckedAt)?.getTime() || 0) + FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS)
      .filter((value: number) => value > chinaHealthNow)
      .sort((left: number, right: number) => left - right)[0] ?? null;
  const pendingHealthExpiryAt = pendingHealthExpiryCandidates
    .filter((value) => value > chinaHealthNow)
    .sort((left, right) => left - right)[0] ?? null;
  const nextHealthRecheckAt = [healthWindowRecheckAt, healthExpiryAt, pendingHealthExpiryAt]
    .filter((value): value is number => typeof value === "number" && value > chinaHealthNow)
    .sort((left, right) => left - right)[0] ?? null;
  forwardGroupHealthRechecks.replace(Number(group.id), nextHealthRecheckAt);
  const agentSelectionStillCurrent = async () => {
    for (const member of members) {
      const initial = initialAgentLivenessSnapshot.get(Number(member.id));
      if (initial === undefined) continue;
      const current = await resolveMemberAgentLiveness(member);
      if (current.signature !== initial) return false;
    }
    if (initialHealthSnapshot.size > 0) {
      const currentRows = await db.select({
        id: forwardGroupMembers.id,
        healthStatus: forwardGroupMembers.healthStatus,
        lastCheckedAt: forwardGroupMembers.lastCheckedAt,
        chinaHealthStatus: forwardGroupMembers.chinaHealthStatus,
        chinaHealthCheckedAt: forwardGroupMembers.chinaHealthCheckedAt,
      }).from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, Number(group.id)));
      const seen = new Set<number>();
      for (const member of currentRows as any[]) {
        const memberId = Number(member.id);
        const initial = initialHealthSnapshot.get(memberId);
        if (initial === undefined) continue;
        seen.add(memberId);
        const currentStatus = chinaHealthEnabled ? member.chinaHealthStatus : member.healthStatus;
        const currentCheckedAt = chinaHealthEnabled ? member.chinaHealthCheckedAt : member.lastCheckedAt;
        const current = `${String(currentStatus || "unknown")}:${toDate(currentCheckedAt)?.getTime() || 0}`;
        if (current !== initial) return false;
      }
      if (seen.size !== initialHealthSnapshot.size) return false;
    }
    return true;
  };
  const retryChangedAgentSelection = () => {
    scheduleForwardGroupFailover([Number(group.id)]);
  };
  if (lines) {
    // 分线路：默认线路只发布默认线路上的成员（server/ddnsLinePlanner.ts 规则 1），其余交给线路发布。
    const kept = aggregationMembers.filter((entry) => lines.defaultMemberIds.has(entry.memberId));
    aggregationMembers.splice(0, aggregationMembers.length, ...kept);
    const keptValues = Array.from(new Set(kept.map((entry) => entry.value)));
    values.splice(0, values.length, ...(recordType === "CNAME" ? keptValues.slice(0, 1) : keptValues));
    activeMemberId = kept[0]?.memberId || null;
  }
  // Bandwidth aggregation reorders the healthy entries so the front VPS hosts
  // with the most spare uplink are offered to clients first. It never adds or
  // removes an entry, so the health decisions above still stand.
  const aggregation = await resolveEntryGroupAggregation(group, aggregationMembers, values, recordType)
    .catch(() => null);
  const publishedValues = aggregation?.values ?? values;
  const aggregationSuffix = aggregation?.applied ? `；${aggregation.note}` : "";

  const joined = publishedValues.join(",");
  const excludedSuffix = excluded.length > 0 ? `；已临时剔除 ${excluded.length} 个不健康入口` : "";
  // 健康却没在解析里、面板连不上却还在的，各说一句原因。没有这些情况时是空串，状态消息和以前一样。
  const holdSuffix = [
    recoveringCount > 0 ? `；${recoveringCount} 个入口已恢复，持续正常 ${Math.round(recoverMs / 1000)} 秒后加回` : "",
    flapHeldCount > 0 ? `；${flapHeldCount} 个入口一小时内频繁进出，暂缓加回（抖动抑制）` : "",
    externalKeptCount > 0 ? `；${externalKeptCount} 个入口面板连不上但访客可达，继续发布` : "",
    externalDownCount > 0 ? `；${externalDownCount} 个入口外部观察连不上，已按不可用处理` : "",
  ].join("");
  const addedValues = publishedValues.filter((value) => !previousValues.has(value));
  const nextValues = new Set(publishedValues);
  const removedValues = Array.from(previousValues).filter((value) => !nextValues.has(value));

  // A newly enabled health check starts with unknown member states.  Keep the
  // current provider record intact until at least one probe result arrives;
  // once results exist, only healthy members are emitted above.
  if (trafficExcludedMemberCount === 0 && pendingAgentHealth && (publishedValues.length === 0 || joined === previousValue)) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "unknown",
      lastMessage: "等待 Agent 健康度检测结果；暂不变更现有 DDNS 解析",
    });
    if (lines) lines.settled = true;
    return;
  }

  if (!String(group.domain || "").trim()) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "error",
      lastMessage: "入口组需要指定入口域名。",
    });
    return;
  }
  if (!(await agentSelectionStillCurrent())) {
    retryChangedAgentSelection();
    return;
  }
  if (publishedValues.length === 0) {
    const requirement = recordTypeRequirementLabel(recordType);
    const reason = excluded.length > 0 ? `入口组没有健康的${requirement}` : `入口组没有可用${requirement}`;
    if (group.ddnsAutoResolveEnabled === false) {
      await updateForwardGroupRuntimeIfChanged(db, group, {
        activeMemberId: null,
        lastStatus: "down",
        lastMessage: `${reason}；自动解析已关闭，请手动清理解析`,
      });
    } else {
      const held = await holdEntryGroupDdns(group, ddnsSettings, options, planEntryGroupRecordSet({
        healthyValues: [],
        previousValues: Array.from(previousValues),
        administrativelyExcludedValues: quotaExcludedValues,
        allAdministrativelyExcluded: valuedMemberCount > 0 && trafficExcludedMemberCount >= valuedMemberCount,
      }), reason);
      if (held !== "deferred" && lines) lines.settled = true;
    }
    return;
  }

  if (group.ddnsAutoResolveEnabled === false) {
    const changed = await updateForwardGroupRuntimeIfChanged(db, group, {
      activeMemberId,
      lastDdnsValue: joined,
      lastStatus: "healthy",
      lastMessage: `自动解析已关闭；请手动将 ${String(group.domain || "-")} 解析到 ${publishedValues.join(", ")}${excludedSuffix}${aggregationSuffix}${holdSuffix}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, null, "ddns-skip", `入口组自动解析已关闭；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}`);
    return;
  }
  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    const changed = await updateForwardGroupRuntimeIfChanged(db, group, {
      activeMemberId,
      lastDdnsValue: joined,
      lastStatus: "healthy",
      lastMessage: `系统 DDNS 未启用；建议入口 ${publishedValues.join(", ")}${excludedSuffix}${aggregationSuffix}${holdSuffix}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, null, "ddns-skip", `入口组 DDNS 未启用；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}`);
    return;
  }

  // 按权重解析（开了、服务商支持、聚合生效时才有权重；否则 weights 是 null，下面和以前一样）。
  const weighting = resolveEntryGroupDdnsWeighting(group, ddnsSettings, aggregation?.plan || null, publishedValues, recordType);
  const peerSuffix = peerObservedCount > 0 && externalDownCount === 0 && externalKeptCount === 0 ? `；外部观察 ${peerObservedCount} 个入口` : "";

  // A DNS record set is unordered at the provider, so only a change in the set
  // itself is worth a write. Comparing the sorted values keeps an aggregation
  // reorder from re-pushing the same records on every sync.
  if (!forceSync && ddnsValueSetSignature(previousValue) === ddnsValueSetSignature(joined) && !exactDdnsReconciliationDue(group, joined) && !weighting.writeNeeded) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "healthy",
      lastMessage: `入口组 DDNS 已是最新；${publishedValues.length} 个入口${excludedSuffix}${aggregationSuffix}${weighting.note}${holdSuffix}${peerSuffix}`,
      // 记着的权重状态对不上现在的服务商 / 域名了（没法去那边收）：只把状态丢掉。
      ...(String(group.ddnsWeightState ?? "") !== String(weighting.nextState ?? "") ? { ddnsWeightState: weighting.nextState } : {}),
    });
    if (lines) lines.settled = true;
    return;
  }

  if (!(await agentSelectionStillCurrent())) {
    retryChangedAgentSelection();
    return;
  }
  if (deferProviderWrite()) return;
  try {
    await publishForwardGroupDdnsValues(group, {
      groupId: Number(group.id),
      domain: String(group.domain || ""),
      recordType,
      values: publishedValues,
      ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL),
    }, { weights: weighting.weights, clearWeights: weighting.clearWeights });
    if (!(await agentSelectionStillCurrent())) {
      retryChangedAgentSelection();
      return;
    }
    rememberExactDdnsReconciliation(group, joined);
    await db.update(forwardGroups).set({
      activeMemberId,
      lastDdnsValue: joined,
      ddnsWeightState: weighting.nextState,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "healthy",
      lastMessage: `入口组 DDNS 已同步 ${publishedValues.length} 个入口${excludedSuffix}${aggregationSuffix}${weighting.note}${holdSuffix}${peerSuffix}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, null, "ddns-update", `入口组 DDNS 已同步；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}${weighting.note}${forceSync ? " force=true" : ""}`);
    if (lines) lines.settled = true;
    if (!forceSync && !options.manual && !options.forcePriority) {
      // 自动进出各记一笔（抖动抑制按成员计数）。写事件失败不影响已经发布的解析。
      for (const change of autoChanges) {
        await insertForwardGroupEvent(Number(group.id), change.memberId, FORWARD_GROUP_AUTO_SWITCH_EVENT, change.kind === "removed" ? "自动剔除：入口异常达到故障观察时间" : "自动加回：入口恢复达到稳定观察时间")
          .catch((error) => console.warn(`[ForwardGroup] auto-switch event failed group=${group.id}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    if (previousValue && previousValue !== joined) recordForwardGroupSwitchEvent({ group, mode: "entry", toLabel: `${values.length} 个健康入口`, reason: `新增 ${addedValues.length} 个、剔除 ${removedValues.length} 个` }); // 事件时间线
    if (groupSwitchNotifyEnabled(group) && !switchNotifySuppressed(options) && previousValue && previousValue !== joined) {
      void notifyForwardGroupSwitch({
        groupId: Number(group.id),
        groupName: String(group.name || "入口组"),
        groupMode: "entry",
        domain: String(group.domain || ""),
        recordType,
        fromLabel: "原入口集合",
        fromValue: previousValue,
        toLabel: `${values.length} 个健康入口`,
        toValue: joined,
        reason: removedValues.length > 0 && addedValues.length === 0
          ? "入口异常达到故障观察时间，已自动剔除"
          : addedValues.length > 0 && removedValues.length === 0
            ? "入口恢复达到稳定观察时间，已自动恢复"
            : "入口可用列表变化，已自动同步解析",
        detail: `新增 ${addedValues.length} 个；剔除 ${removedValues.length} 个；当前健康入口 ${values.length} 个`,
      }).catch((error) => {
        console.warn(`[ForwardGroup] switch notify failed group=${group.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(forwardGroups).set({
      lastStatus: "error",
      lastMessage: message,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, null, "ddns-error", `入口组 DDNS 更新失败；${message}；domain=${String(group.domain || "-")} values=${joined}`);
    throw error;
  }
}

async function markExitGroupReady(group: any) {
  const db = await getDb();
  const enabledMembers = sortedMembers(group, true) as any[];
  const excludedHosts = await getTrafficExcludedHostIds();
  const members = enabledMembers.filter((member) => !excludedHosts.has(Number(member.hostId)));
  await updateForwardGroupRuntimeIfChanged(db, group, {
    activeMemberId: Number(members[0]?.id || 0) || null,
    lastStatus: members.length > 0 ? "healthy" : "down",
    lastMessage: members.length > 0
      ? "出口组已保存，可在隧道中作为出口组选择。"
      : enabledMembers.length > 0 ? "出口组没有可用主机：流量到阈值的成员已暂停参与。" : "出口组没有已启用主机。",
  });
}

async function syncSingleForwardGroupDdns(
  group: any,
  member: any,
  value: string,
  ddnsSettings: any,
  options: {
    forceSync?: boolean;
    eventType?: string;
    successMessage?: string;
    currentMessage?: string;
    suppressSwitchNotify?: boolean;
    switchReason?: string;
    switchDetail?: string;
    previousMember?: any | null;
    /** 活动成员没变时附在「当前入口 x」后面的说明（为什么这会儿不切回）。 */
    currentNote?: string;
    beforeCommit?: () => boolean | Promise<boolean>;
  } = {},
) {
  const db = await getDb();
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
  const memberId = Number(member?.id || 0) || null;
  const forceSync = !!options.forceSync;
  const eventType = options.eventType || "failover";
  const successMessage = options.successMessage || "DDNS 已切换";
  const currentMessage = options.currentMessage || "DDNS 已是最新，解析记录已指向选中入口";
  const previousMemberId = Number(group.activeMemberId || 0);
  const previousValue = String(group.lastDdnsValue || "").trim();

  if (options.beforeCommit && !(await options.beforeCommit())) return false;

  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    const changed = await updateForwardGroupRuntimeIfChanged(db, group, {
      activeMemberId: memberId,
      lastDdnsValue: value,
      lastStatus: "healthy",
      lastMessage: `系统 DDNS 未启用；建议入口 ${value}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, memberId, "ddns-skip", `系统 DDNS 未启用，解析记录未更新；${detail}`);
    return;
  }

  if (
    !forceSync
    && Number(group.activeMemberId) === Number(memberId)
    && String(group.lastDdnsValue || "") === value
    && !exactDdnsReconciliationDue(group, value)
  ) {
    const changed = await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "healthy",
      lastMessage: options.currentNote ? `当前入口 ${value}；${options.currentNote}` : `当前入口 ${value}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, memberId, "ddns-current", `${currentMessage}；${detail}`);
    return;
  }

  if (deferProviderWrite()) return "deferred" as const;
  try {
    await insertForwardGroupEvent(group.id, memberId, "ddns-update", `Starting DDNS update; ${detail}${forceSync ? " force=true" : ""}`);
    await publishForwardGroupDdnsValues(group, {
      groupId: Number(group.id),
      domain: String(group.domain || ""),
      recordType,
      values: [value],
      ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL),
    });
    if (options.beforeCommit && !(await options.beforeCommit())) return false;
    rememberExactDdnsReconciliation(group, value);
    await db.update(forwardGroups).set({
      activeMemberId: memberId,
      lastDdnsValue: value,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "healthy",
      lastMessage: `${successMessage}到 ${value}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, memberId, eventType, `${successMessage}；${detail}`);
    if (previousMemberId > 0 && Number(previousMemberId) !== Number(memberId)) recordForwardGroupSwitchEvent({ group, mode: "failover", fromLabel: previousValue, toLabel: value, reason: options.switchReason || "入口不可用，自动切到健康成员" }); // 事件时间线
    if (groupSwitchNotifyEnabled(group) && !options.suppressSwitchNotify && previousMemberId > 0 && Number(previousMemberId) !== Number(memberId)) {
      const [fromLabel, toLabel] = await Promise.all([
        forwardGroupMemberLabel(options.previousMember, previousMemberId),
        forwardGroupMemberLabel(member, memberId),
      ]);
      void notifyForwardGroupSwitch({
        groupId: Number(group.id),
        groupName: String(group.name || "转发组"),
        groupMode: "failover",
        domain: String(group.domain || ""),
        recordType,
        fromLabel,
        fromValue: previousValue,
        toLabel,
        toValue: value,
        reason: options.switchReason || "入口不可用，已自动切换到健康成员",
        detail: options.switchDetail || "",
      }).catch((error) => {
        console.warn(`[ForwardGroup] switch notify failed group=${group.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(forwardGroups).set({
      lastStatus: "error",
      lastMessage: message,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, memberId, "ddns-error", `DDNS 更新失败；${message}；${detail}`);
    throw error;
  }
}

/** 这个组最近一小时的自动切换（forward_group_events 里的 auto-switch）算出来的抖动抑制。 */
async function forwardGroupFlapHold(groupId: number, nowMs = Date.now()) {
  const sinceSeconds = Math.floor((nowMs - FORWARD_GROUP_FLAP_WINDOW_MS) / 1000);
  const rows = await queryRaw<{ createdAt: unknown }>(
    `SELECT ${quoteIdentifier("createdAt")} FROM ${quoteIdentifier("forward_group_events")}
      WHERE ${quoteIdentifier("groupId")} = ? AND ${quoteIdentifier("type")} = ? AND ${quoteIdentifier("createdAt")} >= ?`,
    [groupId, FORWARD_GROUP_AUTO_SWITCH_EVENT, sinceSeconds],
  ).catch(() => []);
  return forwardGroupFlapHoldAt(rows.map((row) => toDate(row.createdAt)?.getTime() || 0), nowMs);
}

type ForwardGroupFailoverContext = {
  ddnsSettings: any;
};

/*
  就绪宽限（4a）：面板刚启动、或者数据库故障刚恢复时，内存里的主机存活状态不作数 —— 谁先重新上报谁就「在线」，
  这时评估会让第一个回来的成员把解析抢走。组里还有成员主机「就绪之后没来过、从就绪算起也还没沉默满离线阈值」
  时，这一轮什么都不改（判定见 forwardGroups/evaluate.ts 的 readinessGrace），到点再评估。

  只管「已经发布过解析」的组（没发布过就没有可抢的）；人工操作（保存组、调顺序、立即同步）不受限制。
  返回 true = 这一轮已经处理完（挂起）。
*/
async function holdForwardGroupForReadiness(group: any, options: ForwardGroupFailoverOptions) {
  const readyAt = forwardGroupPanelReadyAt();
  if (!(readyAt > 0) || options.manual || options.forcePriority) return false;
  const now = Date.now();
  if (now >= readyAt + Math.max(HOST_ONLINE_TTL_MS, AGENT_FAST_LIVENESS_SILENCE_MS)) return false;
  if (!String(group?.lastDdnsValue || "").trim()) return false;
  const hostsToWait: Array<{ hostId: number; lastSeenAt: number; offlineThresholdMs: number }> = [];
  for (const member of sortedMembers(group, true) as any[]) {
    const liveness = await resolveMemberAgentLiveness(member, now);
    if (liveness.hostId > 0) hostsToWait.push({ hostId: liveness.hostId, lastSeenAt: liveness.lastSeenAt, offlineThresholdMs: liveness.offlineThresholdMs });
  }
  const grace = readinessGrace({ readyAt, now, hosts: hostsToWait });
  if (!grace.active) return false;
  const db = await getDb();
  await updateForwardGroupRuntimeIfChanged(db, group, {
    lastStatus: "unknown",
    lastMessage: `面板刚启动或数据库刚恢复：还有 ${grace.waitingHostIds.length} 台成员主机没重新上报，暂不变更现有 DDNS 解析`,
  });
  forwardGroupHealthRechecks.replace(Number(group.id), grace.until);
  return true;
}

async function runForwardGroupFailoverForGroups(
  groups: any[],
  options: ForwardGroupFailoverOptions = {},
  context?: ForwardGroupFailoverContext,
) {
  const db = await getDb();
  const ddnsSettings = context?.ddnsSettings ?? await getDdnsSettings();
  for (const group of groups as any[]) {
    if (!dbBool(group?.isEnabled)) continue;
    const mode = forwardGroupModeOf(group);
    if (mode === "chain" || mode === "port") continue;
    if (mode === "exit") {
      await markExitGroupReady(group);
      continue;
    }
    // 面板刚启动 / 数据库刚恢复：还有成员主机没重新上报时，不自动把解析从现在的成员 / 集合上换走。
    if (await holdForwardGroupForReadiness(group, options)) continue;
    if (mode === "entry") {
      await syncEntryGroupDdns(group, ddnsSettings, options);
      continue;
    }
    const recordType = normalizeForwardGroupRecordType(group.recordType);
    const members = [...(group.members || [])].sort((a, b) => Number(a.priority) - Number(b.priority));
    if (members.length === 0) continue;
    // 分线路解析：默认线路只在默认线路上的成员里挑，其余线路在默认线路定下来之后按线路发布。没分线路的组是 null。
    const lineCtx = prepareForwardGroupDdnsLines(group, ddnsSettings);
    const chinaHealthExpiryAt = nextForwardGroupChinaHealthExpiryAt({
      enabled: dbBool(group.chinaHealthCheckEnabled),
      members,
    });
    const templates = await getForwardGroupTemplateRules(Number(group.id));
    if (templates.length === 0) {
      const {
        member: firstMember,
        value: firstValue,
        pendingChinaHealth,
        agentFailurePending,
        agentLivenessRecheckAt,
      } = await firstAvailableResolvableMember(lineCtx ? lineCtx.defaultOnly(members) : members, group, recordType);
      const nextNoTemplateRecheckAt = [chinaHealthExpiryAt, agentLivenessRecheckAt]
        .filter((value): value is number => typeof value === "number" && value > Date.now())
        .sort((left, right) => left - right)[0] ?? null;
      forwardGroupHealthRechecks.replace(Number(group.id), nextNoTemplateRecheckAt);
      if (group.domain) {
        if (firstMember && firstValue && !agentFailurePending) {
          const committed = await syncSingleForwardGroupDdns(group, firstMember, firstValue, ddnsSettings, {
            forceSync: !!options.forceSync,
            eventType: options.forcePriority ? "failover" : "ddns-update",
            successMessage: "DDNS 已切换",
            currentMessage: "DDNS 已是最新，解析记录已指向选中入口",
            suppressSwitchNotify: true,
            beforeCommit: () => memberAgentSelectionStillCurrent(firstMember),
          });
          if (committed === "deferred") continue;
          if (committed === false) scheduleForwardGroupFailover([Number(group.id)]);
        } else if (agentFailurePending) {
          await updateForwardGroupRuntimeIfChanged(db, group, {
            lastStatus: "unknown",
            lastMessage: "活动 Agent 已离线，等待故障转移观察时间",
          });
        } else if (pendingChinaHealth) {
          await updateForwardGroupRuntimeIfChanged(db, group, {
            lastStatus: "unknown",
            lastMessage: "等待国内健康度检测结果；暂不变更现有 DDNS 解析",
          });
        } else if (await preserveForwardGroupDdns(group, ddnsSettings, options, `没有在线且具备${recordTypeRequirementLabel(recordType)}的成员`) === "deferred") {
          continue;
        }
        if (lineCtx) await syncFailoverGroupLinesWithoutRules(group, lineCtx, ddnsSettings, members, recordType, options);
        continue;
      }
      await updateForwardGroupRuntimeIfChanged(db, group, {
        activeMemberId: Number(firstMember?.id || 0) || null,
        lastDdnsValue: firstValue || null,
        lastStatus: agentFailurePending ? "unknown" : firstValue ? "healthy" : "unknown",
        lastMessage: group.domain
          ? `当前还没有转发规则使用这个组；${firstValue ? `建议入口 ${firstValue}` : `没有可用${recordTypeRequirementLabel(recordType)}。`}`
          : "当前还没有转发规则使用这个组。",
      });
      continue;
    }

    if (!options.skipRuleSync) await syncForwardGroupRules(Number(group.id), { preserveRuntime: true });
    // 这个组所有成员的子规则、模板状态、最新探测一次读好（评估每个成员时不再各查各的）。
    const evaluationScope = forwardGroupEvaluationScope.getStore();
    if (evaluationScope) evaluationScope.rules = await loadForwardGroupEvaluationRules(members);
    const evaluated: Array<Awaited<ReturnType<typeof evaluateMemberHealth>>> = [];
    for (const member of members) evaluated.push(await evaluateMemberHealth(member, group));

    const healthWindowRecheckAt = nextForwardGroupHealthRecheckAt({
      // 「恢复够久」从 recoverySince 起算（机器刚回来时比 healthySince 晚），到点要再评估一次才切得回去。
      members: evaluated.map((member) => ({ ...member, healthySince: member.recoverySince ?? member.healthySince })),
      failoverMs: forwardGroupFailoverDelayMs(group),
      recoverMs: forwardGroupRecoverDelayMs(group),
    });
    const healthRecheckAt = healthWindowRecheckAt && chinaHealthExpiryAt
      ? Math.min(healthWindowRecheckAt, chinaHealthExpiryAt)
      : healthWindowRecheckAt ?? chinaHealthExpiryAt;
    const probeExpiryAt = evaluated
      .map((member: any) => Number(member.nextProbeExpiryAt || 0))
      .filter((value: number) => value > Date.now())
      .sort((left: number, right: number) => left - right)[0] ?? null;
    const baseRecheckAt = healthRecheckAt && probeExpiryAt
      ? Math.min(healthRecheckAt, probeExpiryAt)
      : healthRecheckAt ?? probeExpiryAt;
    forwardGroupHealthRechecks.replace(Number(group.id), baseRecheckAt);

    if (!group.domain) {
      const anyHealthy = evaluated.some((member) => member.healthy);
      const anyPending = evaluated.some((member) => member.healthPending);
      await updateForwardGroupRuntimeIfChanged(db, group, {
        lastStatus: anyHealthy ? "healthy" : anyPending ? "unknown" : "down",
        lastMessage: anyPending
          ? "等待国内健康度检测结果；未配置 DDNS 域名，仅更新成员健康状态。"
          : "未配置 DDNS 域名，仅更新成员健康状态。",
      });
      continue;
    }

    // 分线路时默认线路只看默认线路上的成员；线路成员的健康结论照样评估过，留给线路发布用。
    const defaultEvaluated = lineCtx ? lineCtx.defaultOnly(evaluated) : evaluated;
    const syncLines = () => (lineCtx ? syncFailoverGroupLines(group, lineCtx, ddnsSettings, evaluated, recordType, options, templates) : Promise.resolve());
    const active = defaultEvaluated.find((m) => Number(m.id) === Number(group.activeMemberId));
    // `members` is normally loaded in priority order, but keep the selection
    // explicit here. A failover may pass through several members; when a
    // higher-priority member recovers, it must win over the currently active
    // lower-priority member regardless of how the evaluation array was built.
    const healthyMembers = (await sniReadyGroupCandidates(group, templates, defaultEvaluated
      .filter((member) => member.healthy)
      .sort((left, right) => {
        // 「面板连不上、只靠外部观察算健康」的成员排在后面：它是活动成员时留着不切走，但不主动切过去、也不切回它
        //（面板推不了配置给它，规则是不是最新的说不准）。
        const externalDelta = Number(!!left.externalOnly) - Number(!!right.externalOnly);
        const priorityDelta = Number(left.priority) - Number(right.priority);
        return externalDelta || priorityDelta || Number(left.id) - Number(right.id);
      })));
    const firstHealthy = healthyMembers[0];
    const anyPending = defaultEvaluated.some((member) => member.healthPending);
    if ((active?.healthPending && String(group.lastDdnsValue || "").trim()) || (!active && !firstHealthy && anyPending)) {
      await updateForwardGroupRuntimeIfChanged(db, group, {
        lastStatus: "unknown",
        lastMessage: "等待国内健康度检测结果；暂不变更现有 DDNS 解析",
      });
      await syncLines();
      continue;
    }
    const failbackCandidate = healthyMembers.find((member) => member.recoveredLongEnough && !member.externalOnly);
    const shouldFailback = dbBool(group.autoFailback)
      && !!active
      && !!failbackCandidate
      && Number(failbackCandidate.priority) < Number(active.priority);
    const shouldFailover = !active || (!!active && !active.healthy && active.failedLongEnough);
    /*
      暂不切回的两种情况，都写进组状态让用户看得到原因（P3）：
        · 高优先级成员已经恢复，但面板看到它连续正常还不满 recoverSeconds —— 观察中；
        · 抖动抑制：一小时内自动切了三次以上，切回要多等（server/forwardGroupFlapHold.ts）。
      只在当前成员还健康时才压着：当前成员不可用是逃生，照旧立刻换。人工操作（forcePriority）不受限制。
    */
    let holdNote = "";
    let failbackHeld = false;
    if (!options.forcePriority && dbBool(group.autoFailback) && active?.healthy) {
      if (shouldFailback && failbackCandidate) {
        const flap = await forwardGroupFlapHold(Number(group.id));
        if (flap.untilMs > 0) {
          failbackHeld = true;
          holdNote = `1 小时内已自动切换 ${flap.switches} 次，暂缓切回「${await forwardGroupMemberLabel(failbackCandidate)}」（抖动抑制 ${forwardGroupFlapHoldLabel(flap.holdMs)}）`;
          // 到点再评估一次，不然要等下一次健康上报或巡检才切得回去。
          forwardGroupHealthRechecks.replace(Number(group.id), baseRecheckAt ? Math.min(baseRecheckAt, flap.untilMs) : flap.untilMs);
        }
      } else if (!shouldFailback) {
        const recovering = healthyMembers.find((member) => Number(member.priority) < Number(active.priority) && !member.recoveredLongEnough);
        if (recovering) {
          holdNote = `高优先级入口「${await forwardGroupMemberLabel(recovering)}」已恢复，需持续正常 ${Math.round(forwardGroupRecoverDelayMs(group) / 1000)} 秒后切回`;
        }
      }
    }
    if (active?.healthy && active.externalOnly) {
      const note = `面板连不上当前入口的 Agent，但${active.peerHealthLabel || "外部观察可达"}，继续发布`;
      holdNote = holdNote ? `${note}；${holdNote}` : note;
    } else if (active?.healthy && active.peerHealthLabel && !holdNote) {
      holdNote = active.peerHealthLabel;
    }
    let next = active;
    let switchReason = "";
    let switchDetail = "";
    if (options.forcePriority) next = firstHealthy;
    else if (shouldFailback && !failbackHeld) {
      next = failbackCandidate;
      switchReason = "高优先级入口恢复，已自动回切";
      switchDetail = `恢复稳定时间已达到 ${Number(group.recoverSeconds || 120)} 秒`;
    } else if (shouldFailover) {
      next = firstHealthy;
      switchReason = active
        ? `${normalizeHealthReason(active.message)}导致切换`
        : "当前没有可用活动入口，已自动选择健康成员";
      switchDetail = active
        ? `原入口异常持续已达到 ${Number(group.failoverSeconds || 60)} 秒；检测结果：${normalizeHealthReason(active.message)}`
        : "未记录活动成员或活动成员已不存在";
    }

    if (!next) {
      if (!(await failoverAgentSelectionStillCurrent(group, active, next))) {
        scheduleForwardGroupFailover([Number(group.id)]);
        continue;
      }
      if (await preserveForwardGroupDdns(group, ddnsSettings, options, "没有可用于 DDNS 故障转移的健康成员") === "deferred") continue;
      await syncLines();
      continue;
    }

    const value = await memberDdnsValue(next, recordType);
    if (!value) {
      const requirement = recordTypeRequirementLabel(recordType);
      await insertForwardGroupEvent(group.id, next.id, "ddns-error", `健康成员没有可用${requirement}。`);
      continue;
    }

    const committed = await syncSingleForwardGroupDdns(group, next, value, ddnsSettings, {
      forceSync: !!options.forceSync,
      eventType: "failover",
      successMessage: "DDNS 已切换",
      currentMessage: "DDNS 已是最新，解析记录已指向选中入口",
      suppressSwitchNotify: switchNotifySuppressed(options) || Number(group.activeMemberId || 0) === Number(next.id || 0),
      switchReason,
      switchDetail,
      previousMember: active || null,
      currentNote: holdNote,
      beforeCommit: () => failoverAgentSelectionStillCurrent(group, active, next),
    });
    // 这一轮只算结论：要写服务商，组交给发布队列，后面的事件 / 分线路等那一轮做。
    if (committed === "deferred") continue;
    if (committed === false) scheduleForwardGroupFailover([Number(group.id)]);
    /*
      自动切换记一笔（抖动抑制按它计数）：有原来的活动成员、换了人、不是人工操作。逃生也算 ——
      「坏了切走、好了切回」来回几次正是要压的那种；但压只压切回。写事件失败不影响切换本身。
    */
    if (committed !== false && active && Number(active.id) !== Number(next.id) && !options.forcePriority && !options.forceSync) {
      await insertForwardGroupEvent(Number(group.id), Number(next.id), FORWARD_GROUP_AUTO_SWITCH_EVENT, `自动切换：${switchReason || "入口不可用，切到健康成员"}`)
        .catch((error) => console.warn(`[ForwardGroup] auto-switch event failed group=${group.id}: ${error instanceof Error ? error.message : String(error)}`));
    }
    await syncLines();
  }
}

/** 主备组（有规则在用）的分线路发布：每个成员的健康结论来自上面的 evaluateMemberHealth。 */
async function syncFailoverGroupLines(group: LineGroupRow, ctx: ForwardGroupLineContext, ddnsSettings: DdnsSettings, evaluated: LineMemberRow[], recordType: ForwardGroupRecordType, options: ForwardGroupFailoverOptions, sniTemplates: readonly SniReadinessTemplate[] = []) {
  const hook = createForwardGroupLineHook(group, ctx);
  // 共享 TLS 入站：SNI 配置没确认的健康成员在线路上只算「还在等」—— 已经在这条线路上的照旧留着，
  // 不会被新切过去（和默认线路的 sniReadyGroupCandidates 同一个口径）
  const healthy = evaluated.filter((member) => dbBool(member?.isEnabled) && member.healthy && !member.healthPending);
  const sniReadyIds = new Set((await sniReadyGroupCandidates({ id: group.id, activeMemberId: null }, sniTemplates, healthy)).map((member) => Number(member.id)));
  for (const member of evaluated) {
    if (!dbBool(member?.isEnabled)) continue;
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    const status: LineMemberStatus = !value
      ? "down"
      : member.message === HOST_TRAFFIC_FAILOVER_EXCLUDED_MESSAGE
        ? "quota"
        : member.healthPending
          ? "pending"
          : member.healthy
            ? (sniReadyIds.has(Number(member.id)) ? "up" : "pending")
            : member.failedLongEnough ? "down" : "grace";
    hook.note(member, value, status, !!member.recoveredLongEnough);
  }
  await syncForwardGroupLinesAfterDefault(group, ddnsSettings, hook, "single", options);
}

/**
 * 主备组（还没有规则在用）的分线路发布。判定和 firstAvailableResolvableMember 一致：流量到阈值直接跳过，
 * Agent 离线在故障观察时间内算观察期，开了国内检测就看检测结果。
 */
async function syncFailoverGroupLinesWithoutRules(group: LineGroupRow, ctx: ForwardGroupLineContext, ddnsSettings: DdnsSettings, members: LineMemberRow[], recordType: ForwardGroupRecordType, options: ForwardGroupFailoverOptions) {
  const hook = createForwardGroupLineHook(group, ctx);
  const chinaHealthEnabled = dbBool(group?.chinaHealthCheckEnabled);
  const now = Date.now();
  const failoverMs = forwardGroupFailoverDelayMs(group);
  for (const member of members) {
    if (!dbBool(member?.isEnabled, true)) continue;
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (!value) {
      hook.note(member, "", "down");
      continue;
    }
    const liveness = await resolveMemberAgentLiveness(member, now);
    if (liveness.trafficExcluded) {
      hook.note(member, value, "quota");
      continue;
    }
    if (!liveness.available) {
      const failoverAt = (liveness.failureSince?.getTime() || now) + failoverMs;
      hook.note(member, value, now < failoverAt ? "grace" : "down");
      continue;
    }
    if (chinaHealthEnabled) {
      const state = agentHealthSampleIsCurrent(liveness, member.chinaHealthCheckedAt) ? forwardGroupChinaHealthStateAt(member, now) : "pending";
      if (state !== "healthy") {
        hook.note(member, value, state === "pending" ? "pending" : "down");
        continue;
      }
    }
    // 没有规则时总是挑顺序最前面能用的（和默认线路一样），所以都算「恢复够久」，可以回切。
    hook.note(member, value, "up", true);
  }
  await syncForwardGroupLinesAfterDefault(group, ddnsSettings, hook, "single", options);
}

/*
  评估用的组加载：组、成员、成员涉及的隧道和主机，一共 3～4 次查询读完（和成员数无关），顺手把这一轮要用的
  主机 / 隧道放进评估作用域。成员的 entryAddress / ddnsValue 和 getForwardGroupById 给的一样。
*/
async function loadForwardGroupForEvaluation(groupId: number, options: ForwardGroupFailoverOptions) {
  const db = await getDb();
  if (!db) return null;
  const group = (await db.select().from(forwardGroups).where(eq(forwardGroups.id, groupId)).limit(1))[0];
  if (!group) return null;
  const memberRows = await db
    .select()
    .from(forwardGroupMembers)
    .where(eq(forwardGroupMembers.groupId, groupId))
    .orderBy(asc(forwardGroupMembers.priority)) as any[];
  const scope: ForwardGroupEvaluationScope = {
    hostById: new Map(),
    tunnelById: new Map(),
    rules: null,
    deferPublish: !!options.deferPublish,
    deferred: false,
  };
  const tunnelIds = Array.from(new Set(memberRows
    .filter((member) => member?.memberType === "tunnel")
    .map((member) => Number(member?.tunnelId || 0))
    .filter((id) => id > 0)));
  for (const id of tunnelIds) scope.tunnelById.set(id, null);
  if (tunnelIds.length > 0) {
    for (const tunnel of await db.select().from(tunnels).where(inArray(tunnels.id, tunnelIds)) as any[]) scope.tunnelById.set(Number(tunnel.id), tunnel);
  }
  const hostIdOf = (member: any) => (member?.memberType === "host"
    ? Number(member?.hostId || 0)
    : Number(scope.tunnelById.get(Number(member?.tunnelId || 0))?.entryHostId || 0));
  const hostIds = Array.from(new Set(memberRows.map(hostIdOf).filter((id) => id > 0)));
  for (const id of hostIds) scope.hostById.set(id, null);
  for (const host of await getHostsByIds(hostIds) as any[]) scope.hostById.set(Number(host.id), host);
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const members = memberRows.map((member) => {
    const host = scope.hostById.get(hostIdOf(member));
    return { ...member, entryAddress: entryAddressForHost(host), ddnsValue: ddnsValueForHostByRecordType(host, recordType) };
  });
  return { group: { ...group, groupMode: forwardGroupModeOf(group), members }, scope };
}

async function runForwardGroupFailoverByIds(groupIds: number[], options: ForwardGroupFailoverOptions = {}) {
  const ids = Array.from(new Set(groupIds
    .map((value) => Number(value || 0))
    .filter((value) => Number.isInteger(value) && value > 0)));
  if (ids.length === 0) return;

  const ddnsSettings = await getDdnsSettings();
  const failures: Array<{ groupId: number; error: unknown }> = [];
  for (const groupId of ids) {
    try {
      await withKeyedTaskLock(`forward-group-failover:${groupId}`, async () => {
        const loaded = await loadForwardGroupForEvaluation(groupId, options);
        if (!loaded) return;
        await forwardGroupEvaluationScope.run(loaded.scope, () => runForwardGroupFailoverForGroups([loaded.group], options, { ddnsSettings }));
        // 这一轮只算了结论、发现要写服务商：交给这个服务商账号的发布队列（那边重新评估一遍再写）。
        if (loaded.scope.deferred) forwardGroupPublishQueue.enqueue(ddnsProviderAccountKey(ddnsSettings), groupId);
      });
    } catch (error) {
      failures.push({ groupId, error });
    }
  }
  if (failures.length > 0) throw new ForwardGroupEvaluationBatchError(failures);
}

export async function runForwardGroupFailover(groupId: number, options: ForwardGroupFailoverOptions = {}) {
  await runForwardGroupFailoverByIds([groupId], options);
}

export async function runForwardGroupFailoverSweep(options: ForwardGroupFailoverOptions = {}) {
  const db = await getDb();
  if (!db) return;
  const groups = await db
    .select({ id: forwardGroups.id })
    .from(forwardGroups)
    .where(and(
      eq(forwardGroups.isEnabled, true),
      or(
        isNull(forwardGroups.groupMode),
        notInArray(forwardGroups.groupMode, ["port", "chain", "exit"]),
      ),
    ))
    .orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id));
  await runForwardGroupFailoverByIds((groups as any[]).map((group: any) => Number(group.id || 0)), options);
}
