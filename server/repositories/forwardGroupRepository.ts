import { isIP } from "node:net";
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
  type InsertForwardGroup,
  type InsertForwardGroupMember,
} from "../../drizzle/schema";
import { pushAgentRefresh } from "../agentEvents";
import { appendPanelLog } from "../_core/panelLogger";
import { DEFAULT_DDNS_TTL, getDdnsSettings, updateDdnsRecordValues } from "../ddns";
import { afterDatabaseCommit, afterDatabaseTransactionSettled, executeRaw, getDb, insertAndGetId, isDatabaseTransactionActive, nowDate, queryRaw, rawEpochToDate, withDatabaseTransaction } from "../dbRuntime";
import { withForwardTestDates } from "./forwardTestRepository";
import { boolValue, countAll, inList, quoteIdentifier } from "../dbCompat";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import {
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
import { getHostById, getHosts, HOST_ONLINE_TTL_MS, isFreshHostHeartbeat } from "./hostRepository";
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
  findAvailableTunnelExitPort,
  getUsedPortsOnHost,
  getTunnelById,
  getTunnelExitNodes,
  getTunnelHops,
  getTunnels,
  isPortUsedOnHost,
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
import { clearTunnelRuntimeStatus } from "../tunnelRuntimeStatus";
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
import { trafficBillingUserLockKey, withKeyedTaskLock, withTrafficBillingUserLock } from "../keyedTaskLock";
import {
  isHostPortReservationHeldByCaller,
  releaseHostPortReservations,
  reserveAvailableHostPort,
  reserveSpecificHostPort,
  tryReserveHostPort,
  type HostPortReservation,
} from "../portReservations";
import { repairPortForwardRuleHostReferences } from "../portForwardRuleHosts";
import { summarizeForwardGroupRuntime } from "../forwardGroupRuntimeStatus";
import { dbBool, sqlBool } from "./repositoryUtils";
import { reorderWithinSortOrderScope } from "./sortOrderSlots";
import { normalizeExitGroupStrategy } from "@shared/exitStrategy";
import { MAX_FORWARD_GROUP_MEMBERS } from "../../shared/forwardGroup";
import { routeGroupForwardTypeSupported, routeGroupTunnelModeSupported } from "../../shared/routeGroup";
import { getLastAuthenticatedAgentActivity } from "../agentActivity";
import {
  getPresenceCapableHostLivenessSnapshot,
  primePresenceCapableHosts,
} from "../agentFastLiveness";

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
};

type ForwardGroupRuleConfig = {
  sourcePort: number;
  protocol?: "tcp" | "udp" | "both" | string | null;
  excludeTemplateRuleId?: number | null;
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
    "failoverPinnedIndex",
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
  return numberKeys.every((key) => nullableNumber(existing?.[key]) === nullableNumber(payload?.[key]))
    && stringKeys.every((key) => nullableString(existing?.[key]) === nullableString(payload?.[key]))
    && boolKeys.every((key) => dbBool(existing?.[key]) === dbBool(payload?.[key]));
}

async function syncPreservedChildRuleMetadata(existing: any, payload: any) {
  const patch: Record<string, unknown> = {};
  if (String(existing?.name || "") !== String(payload?.name || "")) patch.name = payload.name;
  if (Number(existing?.userId || 0) !== Number(payload?.userId || 0)) patch.userId = Number(payload.userId);
  if (Object.keys(patch).length === 0) return;
  await updateForwardRule(Number(existing.id), patch as any);
}

type ForwardGroupMode = "port" | "failover" | "chain" | "entry" | "exit";
type ForwardGroupRecordType = "A" | "AAAA" | "CNAME";
type ForwardGroupFailoverOptions = {
  forcePriority?: boolean;
  forceSync?: boolean;
  manual?: boolean;
  suppressSwitchNotify?: boolean;
  skipRuleSync?: boolean;
};

const FORWARD_GROUP_EVALUATION_DEBOUNCE_MS = 250;
const FORWARD_GROUP_EVALUATION_RETRY_BASE_MS = 1_000;
const FORWARD_GROUP_EVALUATION_RETRY_MAX_MS = 30_000;

const forwardGroupEvaluationQueue = new ForwardGroupEvaluationQueue(
  (groupIds) => runForwardGroupFailoverByIds(groupIds, { skipRuleSync: true }),
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
  return primePresenceCapableHosts(await getHosts() as any[]);
}

const DEFAULT_CHINA_HEALTH_TARGET = "www.189.cn:80";
const lastDdnsEventByKey = new Map<string, string>();
const exactDdnsReconciledGroups = new Map<number, string>();

export function normalizeChinaHealthTarget(raw: unknown, method?: unknown) {
  const probeMethod = normalizeForwardGroupHealthCheckMethod(method);
  const needsPort = healthCheckTargetNeedsPort(probeMethod);
  const source = String(raw || "").trim() || defaultHealthCheckTarget(probeMethod);
  const withoutScheme = source.replace(/^(?:tcp|icmp|ping):\/\//i, "").replace(/：/g, ":").trim();
  let host = withoutScheme;
  let port = 80;

  const bracketMatch = withoutScheme.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    host = bracketMatch[1];
    port = bracketMatch[2] ? Number(bracketMatch[2]) : 80;
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
  failureSince: Date | null;
  lastOfflineAt: number | null;
  signature: string;
};

async function resolveMemberAgentLiveness(member: any, nowMs = Date.now()): Promise<MemberAgentLiveness> {
  const hostId = await memberEntryHostId(member).catch(() => 0);
  const host = hostId > 0 ? await getHostById(hostId).catch(() => null) : null;
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
  const available = !!host && (fastState
    ? !confirmedOffline
    : legacyActivityRecently);
  const failureAt = lastSeenAt > 0 ? Math.min(lastSeenAt, nowMs) : Math.min(lifecycleAt, nowMs);
  const lastOfflineAt = Number(fastState?.lastOfflineAt || 0) || null;
  return {
    hostId,
    available,
    failureSince: available ? null : new Date(failureAt),
    lastOfflineAt,
    signature: [
      hostId,
      available ? 1 : 0,
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
    if (members.length !== 1) throw new Error("端口转发需要配置 1 台所属主机");
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
    eq(forwardGroups.groupMode, "chain"),
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
    if (exitStrategy && group && hasEnabledExitMember) {
      const synced = await syncTunnelExitGroupEndpoints(tunnel, exitMembers, exitStrategy);
      Object.assign(tunnel, synced.tunnel);
    } else if (exitStrategy && dbBool(group?.isEnabled)) {
      throw new Error("Enabled exit group must contain at least one enabled host");
    }
    await refreshControlledTunnelRuntime(tunnel, reason, { resetRules: true, extraHostIds: referencedHostIds });
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
    const host = await getHostById(Number(member.hostId)).catch(() => null);
    return hostDisplayLabel(host, `主机 #${member.hostId || member.id || fallbackId || "-"}`);
  }
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(member.tunnelId)).catch(() => null);
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
  const members = await db
    .select()
    .from(forwardGroupMembers)
    .where(inArray(forwardGroupMembers.groupId, ids))
    .orderBy(asc(forwardGroupMembers.priority), asc(forwardGroupMembers.id));
  const hydratedMembers = await hydrateForwardGroupMemberEntryAddresses(members as any[]);
  const membersByGroupId = new Map<number, any[]>();
  for (const member of hydratedMembers) {
    const groupId = Number(member.groupId);
    const list = membersByGroupId.get(groupId) || [];
    list.push(member);
    membersByGroupId.set(groupId, list);
  }
  return rows.map((group: any) => ({
    ...group,
    groupMode: forwardGroupModeOf(group),
    members: membersByGroupId.get(Number(group.id)) || [],
  }));
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

export type ForwardGroupProbeTopologyForHost = {
  chainGroups: Array<{
    groupId: number;
    probes: ForwardGroupChainProbe[];
  }>;
  chinaHealthProbes: ForwardGroupChinaHealthProbe[];
  entryHealthProbes: ForwardGroupEntryHealthProbe[];
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

export async function getForwardGroupProbeTopologyForHost(hostId: number): Promise<ForwardGroupProbeTopologyForHost> {
  const empty: ForwardGroupProbeTopologyForHost = { chainGroups: [], chinaHealthProbes: [], entryHealthProbes: [] };
  const currentHostId = Number(hostId || 0);
  if (!Number.isInteger(currentHostId) || currentHostId <= 0) return empty;
  const db = await getDb();
  if (!db) return empty;

  const groupRows = await db
    .select({
      id: forwardGroups.id,
      groupMode: forwardGroups.groupMode,
      entryGroupId: forwardGroups.entryGroupId,
      chinaHealthCheckEnabled: forwardGroups.chinaHealthCheckEnabled,
      chinaHealthCheckTarget: forwardGroups.chinaHealthCheckTarget,
      failoverSeconds: forwardGroups.failoverSeconds,
      recoverSeconds: forwardGroups.recoverSeconds,
      isEnabled: forwardGroups.isEnabled,
    })
    .from(forwardGroups)
    .where(and(
      eq(forwardGroups.isEnabled, true),
      or(
        eq(forwardGroups.groupMode, "chain"),
        eq(forwardGroups.groupMode, "entry"),
        and(
          eq(forwardGroups.chinaHealthCheckEnabled, true),
          or(isNull(forwardGroups.groupMode), notInArray(forwardGroups.groupMode, ["port", "chain", "exit"])),
        ),
      ),
    ))
    .orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id));
  if (groupRows.length === 0) return empty;

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

  const hostIds = Array.from(new Set([
    ...(memberRows as any[]).map((member) => Number(member?.hostId || 0)),
    ...Array.from(tunnelEntryHostById.values()),
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
    }).from(hosts).where(inArray(hosts.id, hostIds))
    : [];
  const hostById = new Map<number, any>();
  for (const host of hostRows as any[]) hostById.set(Number(host.id), host);

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

  const chainGroups: ForwardGroupProbeTopologyForHost["chainGroups"] = [];
  for (const group of groups) {
    if (forwardGroupModeOf(group) !== "chain") continue;
    const entryGroup = groupById.get(Number(group.entryGroupId || 0));
    const entryMembers = entryGroup && forwardGroupModeOf(entryGroup) === "entry" && dbBool(entryGroup.isEnabled)
      ? sortedMembers(entryGroup, true).filter((member: any) => member.memberType === "host")
      : [];
    const probes = await buildForwardGroupChainProbes(Number(group.id), group, entryMembers, hostById);
    if (probes.some((probe) => Number(probe.fromHostId) === currentHostId)) {
      chainGroups.push({ groupId: Number(group.id), probes });
    }
  }

  const chinaHealthProbes: ForwardGroupChinaHealthProbe[] = [];
  const entryHealthProbes: ForwardGroupEntryHealthProbe[] = [];
  for (const group of groups) {
    if (forwardGroupModeOf(group) === "entry" && !dbBool(group.chinaHealthCheckEnabled)) {
      for (const member of sortedMembers(group, true) as any[]) {
        if (member.memberType !== "host" || Number(member.hostId || 0) !== currentHostId) continue;
        entryHealthProbes.push({
          groupId: Number(group.id),
          memberId: Number(member.id),
          fromHostId: currentHostId,
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
      if (entryHostId !== currentHostId) continue;
      chinaHealthProbes.push({
        groupId: Number(group.id),
        memberId: Number(member.id),
        fromHostId: entryHostId,
        targetIp: target.host,
        targetPort: target.port,
        method: healthMethod,
        probeType: "china",
        failoverSeconds: Math.max(10, Number(group.failoverSeconds || 60)),
        recoverSeconds: Math.max(10, Number(group.recoverSeconds || 120)),
      });
    }
  }
  return { chainGroups, chinaHealthProbes, entryHealthProbes };
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

export async function updateForwardGroupMemberChinaHealth(input: {
  groupId: number;
  memberId: number;
  hostId: number;
  latencyMs: number | null;
  isTimeout: boolean;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
}) {
  const group = await getForwardGroupById(Number(input.groupId)) as any;
  if (!group || !dbBool(group.chinaHealthCheckEnabled) || !supportsChinaHealthMode(forwardGroupModeOf(group))) return false;
  const member = (group.members || []).find((item: any) => Number(item.id) === Number(input.memberId));
  if (!member) return false;
  const entryHostId = await memberEntryHostId(member);
  if (Number(entryHostId) !== Number(input.hostId)) return false;
  const agentDecision = input.healthStatus === "healthy" || input.healthStatus === "unhealthy"
    ? input.healthStatus
    : input.healthStatus === "unknown"
      ? "unknown"
      : null;
  const nextStatus = agentDecision || (input.isTimeout ? "unhealthy" : "healthy");
  const decisionNow = nowDate();
  const decisionWindowPatch = agentDecision === "unhealthy"
    ? {
        failureSince: new Date(decisionNow.getTime() - forwardGroupFailoverDelayMs(group)),
        healthySince: null,
      }
    : agentDecision === "healthy"
      ? {
          failureSince: null,
          healthySince: new Date(decisionNow.getTime() - forwardGroupRecoverDelayMs(group)),
        }
      : {};
  const db = await getDb();
  await db.update(forwardGroupMembers).set({
    chinaHealthStatus: nextStatus,
    chinaHealthLatencyMs: nextStatus === "healthy" ? input.latencyMs : null,
    chinaHealthCheckedAt: decisionNow,
    ...decisionWindowPatch,
    updatedAt: decisionNow,
  } as any).where(eq(forwardGroupMembers.id, Number(input.memberId)));
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

async function memberEntryAddress(member: any) {
  if (member.memberType === "host") {
    const host = await getHostById(Number(member.hostId));
    return entryAddressForHost(host);
  }
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(member.tunnelId));
    if (!tunnel) return "";
    const entry = await getHostById(Number(tunnel.entryHostId));
    return entryAddressForHost(entry);
  }
  return "";
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
    const host = await getHostById(Number(member.hostId));
    return ddnsValueForHostByRecordType(host, recordType);
  }
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(member.tunnelId));
    if (!tunnel) return "";
    const entry = await getHostById(Number(tunnel.entryHostId));
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
  if ((active && !enabledMemberIds.has(Number(active.id || 0)))
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
}) {
  const group = await getForwardGroupById(Number(input.groupId)) as any;
  if (!group || forwardGroupModeOf(group) !== "entry" || dbBool(group.chinaHealthCheckEnabled)) return false;
  const member = (group.members || []).find((item: any) => Number(item.id) === Number(input.memberId));
  if (!member || member.memberType !== "host" || Number(member.hostId || 0) !== Number(input.hostId)) return false;
  const checkedAt = nowDate();
  const decisionWindowPatch = input.healthStatus === "unhealthy"
    ? {
        failureSince: new Date(checkedAt.getTime() - forwardGroupFailoverDelayMs(group)),
        healthySince: null,
      }
    : input.healthStatus === "healthy"
      ? {
          failureSince: null,
          healthySince: new Date(checkedAt.getTime() - forwardGroupRecoverDelayMs(group)),
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
  const tunnel = await getTunnelById(Number(member.tunnelId));
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

export async function getForwardGroupDefaultHostId(groupId: number) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  if (groupMode === "chain") {
    const entryMembers = await chainEntryMembers(group);
    for (const member of entryMembers) {
      const hostId = await memberEntryHostId(member);
      if (hostId) return hostId;
    }
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

export async function getForwardGroupRuleEntryHostIds(groupId: number) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const members = sortedMembers(group);
  const enabledMembers = members.filter((member: any) => dbBool(member?.isEnabled));
  const groupMode = forwardGroupModeOf(group);
  const chainEntries = groupMode === "chain" ? await chainEntryMembers(group) : [];
  // Only the public edge uses the user-selected source port. Downstream chain
  // listeners are allocated independently inside each member's port policy.
  const portMembers = groupMode === "chain"
    ? (chainEntries.length > 0 ? chainEntries : enabledMembers.slice(0, 1))
    : members;
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

async function isPortUsedOnHostForGroupChild(hostId: number, sourcePort: number, ignoreRuleIds: number[], protocol?: unknown) {
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

async function assertEntryPortAllowed(member: any, sourcePort: number) {
  const entry = await entryPortPolicyForMember(member);
  if (!isPortAllowedByPolicy(sourcePort, entry.policy)) {
    throw new Error(portPolicyErrorMessage(entry.policy, "入口端口"));
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
  const chainEntries = groupMode === "chain" ? await chainEntryMembers(group) : [];
  const portCheckMembers = groupMode === "chain"
    ? (chainEntries.length > 0 ? chainEntries : members.filter((member: any) => dbBool(member?.isEnabled)).slice(0, 1))
    : members;
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
  if (members.length === 0) throw new Error("Forward group has no enabled members");
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const entryMembers = groupMode === "chain" ? await chainEntryMembers(group) : [];
  if (groupMode === "chain" && (members.length < (entryMembers.length > 0 ? 1 : 2) || members.length > MAX_FORWARD_GROUP_MEMBERS)) {
    throw new Error(entryMembers.length > 0
      ? `Port forwarding chain requires 1-${MAX_FORWARD_GROUP_MEMBERS} enabled hosts`
      : "Port forwarding chain requires at least two enabled hosts");
  }

  let policy = portPolicyFrom(null);
  const policyMembers = groupMode === "chain"
    ? (entryMembers.length > 0 ? entryMembers : members.slice(0, 1))
    : members;
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
  if (members.length === 0) throw new Error("Forward group has no enabled members");
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const entryMembers = groupMode === "chain" ? await chainEntryMembers(group) : [];
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
    : members;
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
  if (members.length === 0) throw new Error("Forward group has no members");
  const groupMode = forwardGroupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  if (groupMode === "port") {
    if (members.length !== 1) throw new Error("端口转发需要配置 1 台所属主机");
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

  const chainEntries = groupMode === "chain" ? await chainEntryMembers(group) : [];
  const portCheckMembers = groupMode === "chain"
    ? (chainEntries.length > 0 ? chainEntries : members.filter((member: any) => dbBool(member?.isEnabled)).slice(0, 1))
    : members;
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
  if (!isPortAllowedByPolicy(sourcePort, entryPolicy)) {
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

async function refreshRuleEndpoints(rule: any, reason: string) {
  if (!rule) return;
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
    eq(forwardGroups.groupMode, "chain"),
    eq(forwardGroups.entryGroupId, entryGroupId),
  ));
  return (rows as any[]).map((row) => Number(row.id || 0)).filter((id) => id > 0);
}

async function forwardGroupRuntimeDependenciesEnabled(group: any) {
  if (!dbBool(group?.isEnabled)) return false;
  if (forwardGroupModeOf(group) !== "chain") return true;
  const entryGroupId = Number(group?.entryGroupId || 0);
  if (entryGroupId <= 0) return true;
  const entryGroup = await getForwardGroupById(entryGroupId) as any;
  return dbBool(entryGroup?.isEnabled) && forwardGroupModeOf(entryGroup) === "entry";
}

async function refreshControlledForwardRules(rules: any[], reason: string) {
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
  const group = await getForwardGroupById(groupId) as any;
  if (!group) throw new Error("转发资源不存在");
  const mode = forwardGroupModeOf(group);
  const wasEnabled = dbBool(group.isEnabled);
  if (isEnabled && mode === "exit" && !sortedMembers(group, true).some((member: any) => member?.memberType === "host")) {
    throw new Error("Enabled exit group must contain at least one enabled host");
  }
  if (isEnabled && mode === "chain" && Number(group.entryGroupId || 0) > 0) {
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

async function ensureMemberRuleForTemplate(group: any, templateRule: any, member: any, options: SyncForwardGroupRulesOptions = {}) {
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
  await assertEntryPortAllowed(member, Number(templateRule.sourcePort));
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
    isEnabled: !childDisabledByUser && !childDisabledByTunnel && !childProtocolBlockReason,
    disabledByGroup: false,
    disabledByTunnel: childDisabledByTunnel,
    disabledByUser: childDisabledByUser,
    protocolBlockReason: childProtocolBlockReason,
    isRunning: false,
    pendingDelete: false,
    userId: Number(templateRule.userId),
  };

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
    await updateForwardRule(Number(existing.id), payload);
    if (member.memberType === "tunnel") {
      const tunnel = await getTunnelById(Number(tunnelId || 0));
      tunnelExitPortReservation?.release();
      tunnelExitPortReservation = null;
      if (tunnel) await reconcileForwardRuleTunnelExits({ ...existing, ...payload, id: existing.id }, tunnel);
    }
    await refreshRuleEndpoints({ ...existing, ...payload, id: existing.id }, "forward-group-child-updated");
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
  } = {},
) {
  const sourceMember = overrides.sourceMember || member;
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
    await assertEntryPortAllowed(sourceMember, sourcePort);
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
  const billingResource = await findTrafficBillingResourceForRule(rule);
  const fallback = trafficBillingResourceCandidatesForRule(rule)[0];
  const resource = billingResource || fallback;
  if (options.deferRefresh) {
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

  if (groupMode === "port") {
    if (members.length !== 1) throw new Error("端口转发需要配置 1 台所属主机");
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

  const activeChainEntryMembers = groupMode === "chain" ? await chainEntryMembers(group) : [];
  if (groupMode === "chain" && activeChainEntryMembers.length > 0) {
    const chainHostIds = new Set(activeChainMembers.map((member: any) => Number(member.hostId || 0)));
    for (const entryMember of activeChainEntryMembers) {
      const entryHostId = await memberEntryHostId(entryMember);
      if (entryHostId > 0 && chainHostIds.has(entryHostId)) {
        throw new Error("Entry group host cannot also be used inside the port forwarding chain");
      }
    }
  }

  const liveMemberIds = new Set((groupMode === "chain" ? activeChainMembers : members).map((m: any) => Number(m.id)));
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
      }
    }
  }

  for (const member of members) {
    if (member.ruleId) {
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
          const ruleId = await ensureChainRuleForTemplate(group, template, member, nextMember, index, activeChainMembers.length, options, {
            sourcePort: chainSourcePorts[index],
            targetPort: nextMember ? chainSourcePorts[index + 1] : null,
          });
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
            });
            if (ruleId && !preserveRuntime) {
              await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
            }
          }
        }
      } finally {
        await afterDatabaseTransactionSettled(() => releaseHostPortReservations(chainPortReservations));
      }
    } else {
      for (const member of members) {
        const ruleId = await ensureMemberRuleForTemplate(group, template, member, options);
        if (ruleId && !preserveRuntime) {
          await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
        }
      }
    }
    if (!preserveRuntime) {
      await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, template.id));
    }
  }

  if (!preserveRuntime) {
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
  if (isDatabaseTransactionActive()) {
    throw new Error("Forward group sync transaction must start before a database transaction");
  }
  return withKeyedTaskLock(`forward-group-sync:${groupId}`, () => withDatabaseTransaction(async () => {
    const result = await work();
    await syncForwardGroupRulesWithLockHeld(groupId, options);
    return result;
  }));
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
  if (members.length === 0) throw new Error("转发组至少需要一个成员");
  const groupMode = forwardGroupModeOf(data);
  validateForwardGroupModeMembers(groupMode, String((data as any).groupType || "host"), members, {
    externalEntry: groupMode === "chain" && Number((data as any).entryGroupId || 0) > 0,
  });
  if (groupMode === "entry" && !String((data as any).domain || "").trim()) throw new Error("入口组需要指定入口域名");
  for (const member of members) await targetHostIdForMember(member);
  const normalizedMembers = await Promise.all(members.map((member, index) => normalizeForwardGroupMemberInput(groupMode, member, index, {
    externalEntry: groupMode === "chain" && Number((data as any).entryGroupId || 0) > 0,
  })));
  await validateForwardGroupRecordMembers({ ...data, groupMode }, normalizedMembers as any);
  const sortOrder = (data as any).sortOrder === undefined
    ? await nextForwardGroupSortOrder(Number((data as any).userId || 0), groupMode)
    : Math.max(0, Math.floor(Number((data as any).sortOrder) || 0));
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
      isEnabled: dbBool(member.isEnabled, true),
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

export async function replaceForwardGroupMembers(
  groupId: number,
  members: ForwardGroupMemberInput[],
  options: { skipSync?: boolean; deferRefresh?: boolean } = {},
) {
  if (members.length === 0) throw new Error("转发组至少需要一个成员");
  const group = await getForwardGroupById(groupId);
  const groupMode = forwardGroupModeOf(group);
  validateForwardGroupModeMembers(groupMode, String((group as any)?.groupType || "host"), members, {
    externalEntry: groupMode === "chain" && Number((group as any)?.entryGroupId || 0) > 0,
  });
  const normalizedMembers = await Promise.all(members.map((member, index) => normalizeForwardGroupMemberInput(groupMode, member, index, {
    externalEntry: groupMode === "chain" && Number((group as any)?.entryGroupId || 0) > 0,
  })));
  await validateForwardGroupRecordMembers(group, normalizedMembers as any);
  const db = await getDb();
  const existing = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
  const previousHostIds = (existing as any[])
    .filter((member) => member.memberType === "host")
    .map((member) => Number(member.hostId || 0))
    .filter((hostId) => Number.isFinite(hostId) && hostId > 0);
  const keepKeys = new Set(normalizedMembers.map((m) => `${m.memberType}:${m.memberType === "host" ? m.hostId : m.tunnelId}`));
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
          if (await isPortUsedOnHostForGroupChild(hostId, Number(template.sourcePort), ignoreRuleIds, template.protocol)) {
            const host = await getHostById(hostId) as any;
            throw new Error(`成员主机「${host?.name || hostId}」上端口 ${template.sourcePort} 已被占用，无法为规则「${template.name || template.id}」建立转发，请先更换端口或移除占用`);
          }
        }
      }
    }
  }

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
      isEnabled: dbBool(member.isEnabled, true),
      connectHost: member.connectHost ?? null,
      bandwidthMbps: normalizeMemberBandwidthMbps(member.bandwidthMbps),
      aggregationWeight: normalizeMemberWeight(member.aggregationWeight),
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
        isEnabled: dbBool(member.isEnabled, true),
        bandwidthMbps: normalizeMemberBandwidthMbps(member.bandwidthMbps),
        aggregationWeight: normalizeMemberWeight(member.aggregationWeight),
        createdAt: nowDate(),
        updatedAt: nowDate(),
      });
    }
  }
  if (options.skipSync) return;
  if (isCollectionGroupMode(groupMode)) {
    await runForwardGroupFailover(groupId, { forceSync: true, manual: true });
    await refreshForwardGroupReferences(groupId, {
      reason: `${groupMode}-group-members-updated`,
      previousHostIds,
    });
  } else {
    await syncForwardGroupRules(groupId);
  }
}

/** 把这个组当入口组 / 出口组用的隧道，以及把它当入口组的转发链。 */
export async function getForwardGroupEndpointReferences(groupId: number) {
  const db = await getDb();
  if (!db) return { tunnels: [] as any[], chains: [] as any[] };
  const [tunnelRows, chainRows] = await Promise.all([
    db.select({ id: tunnels.id, name: tunnels.name }).from(tunnels)
      .where(or(eq(tunnels.entryGroupId, groupId), eq(tunnels.exitGroupId, groupId))),
    db.select({ id: forwardGroups.id, name: forwardGroups.name }).from(forwardGroups)
      .where(and(eq(forwardGroups.entryGroupId, groupId), sql`${forwardGroups.id} <> ${groupId}`)),
  ]);
  return { tunnels: tunnelRows as any[], chains: chainRows as any[] };
}

export async function deleteForwardGroup(id: number) {
  const db = await getDb();
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
      bandwidthMbps: Number(member.bandwidthMbps || 0),
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
      const currentPublic = entryAddressForHost(currentHost);
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

async function latestTcping(ruleId: number) {
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
  const childRules = await getForwardGroupChildRulesForMember(Number(member.id));
  let healthy = false;
  let chinaHealthPending = false;
  let latencyMs: number | null = null;
  let message = "";
  let observedFailureSince: Date | null = null;
  let agentHealthPending = false;
  let agentFailureFinal = false;
  let allRuleHealthAgentFinal = false;
  let nextProbeExpiryAt: number | null = null;

  if (!dbBool(member?.isEnabled)) {
    message = "Member disabled";
  } else if (childRules.length === 0) {
    message = "No forwarding rule is using this group yet";
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
    const enabledTemplateIds = new Set((templateRows as any[])
      .filter((rule: any) => dbBool(rule.isEnabled) && !dbBool(rule.pendingDelete))
      .map((rule: any) => Number(rule.id || 0))
      .filter((id: number) => id > 0));
    const activeChildRules = (childRules as any[])
      .filter((rule: any) => enabledTemplateIds.has(Number(rule.forwardGroupRuleId || 0)));

    if (activeChildRules.length === 0) {
      message = "No enabled forwarding rule is using this group member";
    } else if (!agentLiveness.available) {
      observedFailureSince = agentLiveness.failureSince || now;
      message = "Member Agent offline";
    } else {
      healthy = true;
      allRuleHealthAgentFinal = true;
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
          allRuleHealthAgentFinal = false;
          agentHealthPending = true;
          message = "Waiting for Agent health result after reconnect";
          break;
        }
        const stat = freshForwardGroupRuleProbe(latestStat, now);
        if (!stat) {
          healthy = false;
          allRuleHealthAgentFinal = false;
          const recordedAt = toDate(latestStat?.recordedAt);
          if (recordedAt) {
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
          allRuleHealthAgentFinal = false;
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
        if (agentHealthStatus !== "healthy") allRuleHealthAgentFinal = false;
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
      if (healthy) {
        latencyMs = latencies.length > 0 ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length) : null;
        message = latencies.length > 0 ? "Latency probe normal" : "Rule is running, waiting for latency probe data";
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
  const recoveredLongEnough = (healthy && allRuleHealthAgentFinal)
    || (!!healthySince && Date.now() - healthySince.getTime() >= forwardGroupRecoverDelayMs(group));
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
    nextProbeExpiryAt,
    agentLivenessSignature: agentLiveness.signature,
  };
}

function exactDdnsSignature(group: any, value: string) {
  return [
    String(group?.domain || "").trim().toLowerCase(),
    normalizeForwardGroupRecordType(group?.recordType),
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

  try {
    await updateDdnsRecordValues({
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
async function resolveEntryGroupAggregation(
  group: any,
  members: AggregationMemberRow[],
  values: string[],
  recordType: ForwardGroupRecordType,
) {
  if (!isBandwidthAggregationGroup(group) || members.length === 0 || values.length === 0) return null;
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

async function syncEntryGroupDdns(group: any, ddnsSettings: any, options: ForwardGroupFailoverOptions = {}) {
  const db = await getDb();
  const members = sortedMembers(group, true) as any[];
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const forceSync = !!options.forceSync;
  const previousValue = String(group.lastDdnsValue || "").trim();
  const previousValues = new Set(previousValue.split(",").map((value) => value.trim()).filter(Boolean));
  const values: string[] = [];
  const excluded: string[] = [];
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
    if (!value) continue;
    const previouslyIncluded = previousValues.has(value);
    const liveness = await resolveMemberAgentLiveness(member, chinaHealthNow);
    const memberId = Number(member.id);
    initialAgentLivenessSnapshot.set(memberId, liveness.signature);
    agentLivenessByMemberId.set(memberId, liveness);
    const checkedAt = chinaHealthEnabled ? member.chinaHealthCheckedAt : member.lastCheckedAt;
    const storedStatus = chinaHealthEnabled ? member.chinaHealthStatus : member.healthStatus;
    initialHealthSnapshot.set(
      memberId,
      `${String(storedStatus || "unknown")}:${toDate(checkedAt)?.getTime() || 0}`,
    );
    let observedFailureSince: Date | null = null;
    let healthStatus = !liveness.available
      ? "offline"
      : !agentHealthSampleIsCurrent(liveness, checkedAt)
        ? "pending"
        : chinaHealthEnabled
          ? forwardGroupChinaHealthStateAt(member, chinaHealthNow)
          : forwardGroupAgentHealthStateAt(member, chinaHealthNow);
    if (!liveness.available) observedFailureSince = liveness.failureSince || healthNow;
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
      pendingAgentHealth = true;
      if (previouslyIncluded) includeMember(member, value);
      if (recordType === "CNAME" && previouslyIncluded) break;
      continue;
    }

    const healthy = healthStatus === "healthy";
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
    const wasUnhealthy = String(member.healthStatus || "unknown") === "unhealthy" || !!previousFailureSince;
    let failureSince: Date | null = null;
    let healthySince: Date | null = null;
    let failedLongEnough = false;
    let recoveredLongEnough = false;
    let include = false;
    if (healthy) {
      healthySince = previousHealthySince || healthNow;
      recoveredLongEnough = chinaHealthNow - healthySince.getTime() >= recoverMs;
      const recoveryRequired = !previouslyIncluded && wasUnhealthy;
      include = previouslyIncluded || !recoveryRequired || recoveredLongEnough;
    } else {
      failureSince = previousFailureSince || observedFailureSince || healthNow;
      if (observedFailureSince && observedFailureSince.getTime() < failureSince.getTime()) {
        failureSince = observedFailureSince;
      }
      failedLongEnough = chinaHealthNow - failureSince.getTime() >= failoverMs;
      include = previouslyIncluded && !failedLongEnough;
    }

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

    if (include) includeMember(member, value);
    else if (!excluded.includes(value)) excluded.push(value);
    healthWindows.push({
      healthy,
      failureSince,
      healthySince,
      failedLongEnough,
      recoveredLongEnough,
    });
    if (recordType === "CNAME" && include) break;
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
  // Bandwidth aggregation reorders the healthy entries so the front VPS hosts
  // with the most spare uplink are offered to clients first. It never adds or
  // removes an entry, so the health decisions above still stand.
  const aggregation = await resolveEntryGroupAggregation(group, aggregationMembers, values, recordType)
    .catch(() => null);
  const publishedValues = aggregation?.values ?? values;
  const aggregationSuffix = aggregation?.applied ? `；${aggregation.note}` : "";

  const joined = publishedValues.join(",");
  const excludedSuffix = excluded.length > 0 ? `；已临时剔除 ${excluded.length} 个不健康入口` : "";
  const addedValues = publishedValues.filter((value) => !previousValues.has(value));
  const nextValues = new Set(publishedValues);
  const removedValues = Array.from(previousValues).filter((value) => !nextValues.has(value));

  // A newly enabled health check starts with unknown member states.  Keep the
  // current provider record intact until at least one probe result arrives;
  // once results exist, only healthy members are emitted above.
  if (pendingAgentHealth && (publishedValues.length === 0 || joined === previousValue)) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "unknown",
      lastMessage: "等待 Agent 健康度检测结果；暂不变更现有 DDNS 解析",
    });
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
      await preserveForwardGroupDdns(group, ddnsSettings, options, reason);
    }
    return;
  }

  if (group.ddnsAutoResolveEnabled === false) {
    const changed = await updateForwardGroupRuntimeIfChanged(db, group, {
      activeMemberId,
      lastDdnsValue: joined,
      lastStatus: "healthy",
      lastMessage: `自动解析已关闭；请手动将 ${String(group.domain || "-")} 解析到 ${publishedValues.join(", ")}${excludedSuffix}${aggregationSuffix}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, null, "ddns-skip", `入口组自动解析已关闭；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}`);
    return;
  }
  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    const changed = await updateForwardGroupRuntimeIfChanged(db, group, {
      activeMemberId,
      lastDdnsValue: joined,
      lastStatus: "healthy",
      lastMessage: `系统 DDNS 未启用；建议入口 ${publishedValues.join(", ")}${excludedSuffix}${aggregationSuffix}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, null, "ddns-skip", `入口组 DDNS 未启用；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}`);
    return;
  }

  // A DNS record set is unordered at the provider, so only a change in the set
  // itself is worth a write. Comparing the sorted values keeps an aggregation
  // reorder from re-pushing the same records on every sync.
  if (!forceSync && ddnsValueSetSignature(previousValue) === ddnsValueSetSignature(joined) && !exactDdnsReconciliationDue(group, joined)) {
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "healthy",
      lastMessage: `入口组 DDNS 已是最新；${publishedValues.length} 个入口${excludedSuffix}${aggregationSuffix}`,
    });
    return;
  }

  if (!(await agentSelectionStillCurrent())) {
    retryChangedAgentSelection();
    return;
  }
  try {
    await updateDdnsRecordValues({
      groupId: Number(group.id),
      domain: String(group.domain || ""),
      recordType,
      values: publishedValues,
      ttl: Number(ddnsSettings.ttl || DEFAULT_DDNS_TTL),
    });
    if (!(await agentSelectionStillCurrent())) {
      retryChangedAgentSelection();
      return;
    }
    rememberExactDdnsReconciliation(group, joined);
    await db.update(forwardGroups).set({
      activeMemberId,
      lastDdnsValue: joined,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "healthy",
      lastMessage: `入口组 DDNS 已同步 ${publishedValues.length} 个入口${excludedSuffix}${aggregationSuffix}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, null, "ddns-update", `入口组 DDNS 已同步；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}${forceSync ? " force=true" : ""}`);
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
  const members = sortedMembers(group, true) as any[];
  await updateForwardGroupRuntimeIfChanged(db, group, {
    activeMemberId: Number(members[0]?.id || 0) || null,
    lastStatus: members.length > 0 ? "healthy" : "down",
    lastMessage: members.length > 0 ? "出口组已保存，可在隧道中作为出口组选择。" : "出口组没有已启用主机。",
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
      lastMessage: `当前入口 ${value}`,
    });
    if (changed) await insertForwardGroupEvent(group.id, memberId, "ddns-current", `${currentMessage}；${detail}`);
    return;
  }

  try {
    await insertForwardGroupEvent(group.id, memberId, "ddns-update", `Starting DDNS update; ${detail}${forceSync ? " force=true" : ""}`);
    await updateDdnsRecordValues({
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

type ForwardGroupFailoverContext = {
  ddnsSettings: any;
  hostById: Map<number, any>;
};

async function runForwardGroupFailoverForGroups(
  groups: any[],
  options: ForwardGroupFailoverOptions = {},
  context?: ForwardGroupFailoverContext,
) {
  const db = await getDb();
  const ddnsSettings = context?.ddnsSettings ?? await getDdnsSettings();
  const hostById = context?.hostById ?? new Map((await getHosts() as any[]).map((host: any) => [Number(host.id), host]));
  for (const group of groups as any[]) {
    if (!dbBool(group?.isEnabled)) continue;
    const mode = forwardGroupModeOf(group);
    if (mode === "chain" || mode === "port") continue;
    if (mode === "entry") {
      await syncEntryGroupDdns(group, ddnsSettings, options);
      continue;
    }
    if (mode === "exit") {
      await markExitGroupReady(group);
      continue;
    }
    const recordType = normalizeForwardGroupRecordType(group.recordType);
    const members = [...(group.members || [])].sort((a, b) => Number(a.priority) - Number(b.priority));
    if (members.length === 0) continue;
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
      } = await firstAvailableResolvableMember(members, group, recordType);
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
        } else {
          await preserveForwardGroupDdns(group, ddnsSettings, options, `没有在线且具备${recordTypeRequirementLabel(recordType)}的成员`);
        }
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
    const evaluated = [];
    for (const member of members) evaluated.push(await evaluateMemberHealth(member, group));

    const healthWindowRecheckAt = nextForwardGroupHealthRecheckAt({
      members: evaluated,
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
    forwardGroupHealthRechecks.replace(Number(group.id), healthRecheckAt && probeExpiryAt
      ? Math.min(healthRecheckAt, probeExpiryAt)
      : healthRecheckAt ?? probeExpiryAt);

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

    const active = evaluated.find((m) => Number(m.id) === Number(group.activeMemberId));
    // `members` is normally loaded in priority order, but keep the selection
    // explicit here. A failover may pass through several members; when a
    // higher-priority member recovers, it must win over the currently active
    // lower-priority member regardless of how the evaluation array was built.
    const healthyMembers = evaluated
      .filter((member) => member.healthy)
      .sort((left, right) => {
        const priorityDelta = Number(left.priority) - Number(right.priority);
        return priorityDelta || Number(left.id) - Number(right.id);
      });
    const firstHealthy = healthyMembers[0];
    const anyPending = evaluated.some((member) => member.healthPending);
    if ((active?.healthPending && String(group.lastDdnsValue || "").trim()) || (!active && !firstHealthy && anyPending)) {
      await updateForwardGroupRuntimeIfChanged(db, group, {
        lastStatus: "unknown",
        lastMessage: "等待国内健康度检测结果；暂不变更现有 DDNS 解析",
      });
      continue;
    }
    const failbackCandidate = healthyMembers.find((member) => member.recoveredLongEnough);
    const shouldFailback = dbBool(group.autoFailback)
      && !!active
      && !!failbackCandidate
      && Number(failbackCandidate.priority) < Number(active.priority);
    const shouldFailover = !active || (!!active && !active.healthy && active.failedLongEnough);
    let next = active;
    let switchReason = "";
    let switchDetail = "";
    if (options.forcePriority) next = firstHealthy;
    else if (shouldFailback) {
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
      await preserveForwardGroupDdns(group, ddnsSettings, options, "没有可用于 DDNS 故障转移的健康成员");
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
      beforeCommit: () => failoverAgentSelectionStillCurrent(group, active, next),
    });
    if (committed === false) scheduleForwardGroupFailover([Number(group.id)]);
  }
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
        const group = await getForwardGroupById(groupId);
        if (!group) return;
        const context: ForwardGroupFailoverContext = {
          ddnsSettings,
          hostById: new Map(),
        };
        await runForwardGroupFailoverForGroups([group], options, context);
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
