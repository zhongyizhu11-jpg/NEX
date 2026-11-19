/*
  转发组评估的驱动：评估队列和发布队列（forwardGroups/publish.ts）怎么接、谁来触发（健康上报、主机上下线、地址变化、
  定时巡检、人工操作）、一轮评估按组模式走哪条路（入口组 / 主备组 / 出口组），成员健康怎么判（evaluateMemberHealth），
  就绪宽限和抖动抑制在这一层挡。多实例部署时只有拿着后台任务租约的实例在这里评估，别的实例转给它（panelLease.ts）。
  纯判断函数在 evaluate.ts，记录怎么写在 ddnsPublish.ts / ddnsEntryGroup.ts。
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
import { forwardGroupMembers, forwardGroups, forwardRules, tunnels } from "../../drizzle/schema";
import type { SniReadinessTemplate } from "../tlsInboundReadiness";
import { appendPanelLog } from "../_core/panelLogger";
import { getDdnsSettings, type DdnsSettings } from "../ddns";
import { prepareForwardGroupDdnsLines, type ForwardGroupLineContext } from "../forwardGroupDdnsLines";
import type { LineMemberStatus } from "../ddnsLinePlanner";
import { getDb, nowDate, queryRaw } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";
import { getForwardGroupChildRulesForMember, getForwardGroupTemplateRules } from "../repositories/forwardRuleRepository";
import { getHosts, getHostsByIds } from "../repositories/hostRepository";
import {
  ForwardGroupEvaluationBatchError,
  ForwardGroupEvaluationQueue,
  FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS,
  ForwardGroupHealthRecheckScheduler,
  FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS,
  forwardGroupChinaHealthStateAt,
  nextForwardGroupChinaHealthExpiryAt,
  nextForwardGroupHealthRecheckAt,
} from "../forwardGroupHealthRecheck";
import { FORWARD_GROUP_AUTO_SWITCH_EVENT, FORWARD_GROUP_FLAP_WINDOW_MS, forwardGroupFlapHoldAt, forwardGroupFlapHoldLabel } from "../forwardGroupFlapHold";
import { dbBool } from "../repositories/repositoryUtils";
import { HOST_TRAFFIC_FAILOVER_EXCLUDED_MESSAGE } from "../../shared/hostTrafficPolicy";
import { getTrafficExcludedHostIds } from "../hostTrafficPolicy";
import { AGENT_FAST_LIVENESS_SILENCE_MS, primePresenceCapableHosts } from "../agentFastLiveness";
import { readinessGrace } from "./evaluate";
import {
  FORWARD_GROUP_READINESS_SAMPLE_GRACE_MS,
  forwardGroupPanelReadyAt,
  markForwardGroupPanelReady,
  staleSampleWithinReadinessGrace,
} from "./readiness";
import { ForwardGroupPublishQueue, ddnsProviderAccountKey } from "./publish";
import { databaseHealth } from "../databaseHealthState";
import { isPanelBackgroundLeaseHolder } from "../panelLease";
import { registerPanelWorkHandler, requestPanelWork } from "../panelWorkRequests";
import { ForwardGroupFailoverOptions, ForwardGroupRecordType, LineGroupRow, LineMemberRow, LooseRow, ddnsValueForHostByRecordType, entryAddressForHost, forwardGroupFailoverDelayMs, forwardGroupMemberLabel, forwardGroupRecoverDelayMs, insertForwardGroupEvent, normalizeForwardGroupRecordType, normalizeHealthReason, recordTypeRequirementLabel, sortedMembers, switchNotifySuppressed, toDate, updateForwardGroupRuntimeIfChanged } from "./common";
import { sniReadyGroupCandidates, syncEntryGroupDdns } from "./ddnsEntryGroup";
import { createForwardGroupLineHook, memberDdnsValue, preserveForwardGroupDdns, syncForwardGroupLinesAfterDefault, syncSingleForwardGroupDdns } from "./ddnsPublish";
import { ForwardGroupEvaluationScope, forwardGroupEvaluationScope, latestTcping, loadForwardGroupEvaluationRules } from "./evaluateScope";
import { evaluateMemberPeerHealth } from "./health";
import { agentHealthSampleIsCurrent, failoverAgentSelectionStillCurrent, memberAgentSelectionStillCurrent, resolveMemberAgentLiveness } from "./liveness";
import { forwardGroupProbeTopology, invalidateForwardGroupProbeTopology } from "./probeTopology";
import { syncForwardGroupRules } from "./ruleSync";
import { withForwardGroupEvaluationLock } from "../panelKeyedLock";

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
  // 发布之前租约丢了（多实例部署，server/panelLease.ts）：runForwardGroupFailoverByIds 会把它转给现在的持有者。
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

export const forwardGroupHealthRechecks = new ForwardGroupHealthRecheckScheduler(
  (groupId) => { scheduleForwardGroupFailover([groupId]); },
  Date.now,
  setTimeout,
  clearTimeout,
  (error) => {
    console.warn(`[ForwardGroup] delayed health evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
  },
);

/*
  主机的快速存活状态预热完了没有（按库里的主机和版本号登记，见 agentFastLiveness.ts 的 primeHosts）。没有快速存活状态的
  主机在评估里算离线（liveness.ts），所以预热完成之前、就绪宽限之内不自动换解析（holdForwardGroupForReadiness）——
  不然面板刚起来那几秒（或者预热查库失败、还在重试时）所有成员都会被当成离线。
*/
let hostLivenessPrimed = false;

export async function primeForwardGroupHostLivenessDeadlines() {
  // 面板从这一刻起算「就绪」：之后一小段时间里不自动把解析换走，等成员主机重新上报（见 forwardGroups/readiness.ts）。
  markForwardGroupPanelReady();
  const primed = primePresenceCapableHosts(await getHosts() as any[]);
  hostLivenessPrimed = true;
  return primed;
}

/** 数据库故障恢复：故障期间 Agent 的请求全被拒了，内存里的存活状态不作数，重新给一段就绪宽限。 */
export function noteForwardGroupDatabaseRecovered(now = Date.now()) {
  markForwardGroupPanelReady(now, { force: true });
  forwardGroupProbeTopology.invalidate();
}

databaseHealth.onRecovered(() => noteForwardGroupDatabaseRecovered());

const forwardGroupRuleProbeFreshMs = FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS;

function freshForwardGroupRuleProbe(stat: any, now: Date) {
  const recordedAt = toDate(stat?.recordedAt);
  if (!recordedAt) return null;
  const age = now.getTime() - recordedAt.getTime();
  if (age < -60_000 || age > forwardGroupRuleProbeFreshMs) return null;
  return stat;
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
      const templateRuleIds = Array.from(new Set((childRules as LooseRow[])
        .map((rule: LooseRow) => Number(rule.forwardGroupRuleId || 0))
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
      enabledTemplateIds = new Set((templateRows as LooseRow[])
        .filter((rule: LooseRow) => dbBool(rule.isEnabled) && !dbBool(rule.pendingDelete))
        .map((rule: LooseRow) => Number(rule.id || 0))
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
async function holdForwardGroupForReadiness(group: LooseRow, options: ForwardGroupFailoverOptions) {
  const readyAt = forwardGroupPanelReadyAt();
  if (!(readyAt > 0) || options.manual || options.forcePriority) return false;
  const now = Date.now();
  if (now >= readyAt + AGENT_FAST_LIVENESS_SILENCE_MS) return false;
  if (!String(group?.lastDdnsValue || "").trim()) return false;
  if (!hostLivenessPrimed) {
    const db = await getDb();
    await updateForwardGroupRuntimeIfChanged(db, group, {
      lastStatus: "unknown",
      lastMessage: "面板刚启动：主机在线状态还没加载完，暂不变更现有 DDNS 解析",
    });
    forwardGroupHealthRechecks.replace(Number(group.id), Math.min(now + 3_000, readyAt + AGENT_FAST_LIVENESS_SILENCE_MS));
    return true;
  }
  const hostsToWait: Array<{ hostId: number; lastSeenAt: number; offlineThresholdMs: number }> = [];
  for (const member of sortedMembers(group, true) as LooseRow[]) {
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
    .orderBy(asc(forwardGroupMembers.priority)) as LooseRow[];
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
    for (const tunnel of await db.select().from(tunnels).where(inArray(tunnels.id, tunnelIds)) as LooseRow[]) scope.tunnelById.set(Number(tunnel.id), tunnel);
  }
  const hostIdOf = (member: LooseRow) => (member?.memberType === "host"
    ? Number(member?.hostId || 0)
    : Number(scope.tunnelById.get(Number(member?.tunnelId || 0))?.entryHostId || 0));
  const hostIds = Array.from(new Set(memberRows.map(hostIdOf).filter((id) => id > 0)));
  for (const id of hostIds) scope.hostById.set(id, null);
  for (const host of await getHostsByIds(hostIds) as LooseRow[]) scope.hostById.set(Number(host.id), host);
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const members = memberRows.map((member) => {
    const host = scope.hostById.get(hostIdOf(member));
    return { ...member, entryAddress: entryAddressForHost(host), ddnsValue: ddnsValueForHostByRecordType(host, recordType) };
  });
  return { group: { ...group, groupMode: forwardGroupModeOf(group), members }, scope };
}

/** 评估选项里能交给持有实例的那几项（都是布尔）。 */
const FORWARDABLE_FAILOVER_OPTIONS = ["forcePriority", "forceSync", "manual", "suppressSwitchNotify", "skipRuleSync", "deferPublish"] as const;

function forwardableFailoverOptions(options: ForwardGroupFailoverOptions) {
  const payload: Record<string, boolean> = {};
  for (const key of FORWARDABLE_FAILOVER_OPTIONS) if (options[key]) payload[key] = true;
  return payload;
}

/*
  多实例部署（server/panelLease.ts）：评估和写 DNS 只在跑后台任务的实例上做。别的实例上来的评估（Agent 健康上报、
  主机上下线、人工「立即同步」）写进 panel_work_requests，由持有者几秒内接着跑；这里直接返回（人工操作的结果
  稍后在界面上刷新出来）。
*/
registerPanelWorkHandler("forward-group", async (key, payload) => {
  const groupId = Number(key);
  if (!Number.isInteger(groupId) || groupId <= 0) return;
  const options: ForwardGroupFailoverOptions = {};
  for (const name of FORWARDABLE_FAILOVER_OPTIONS) if ((payload as Record<string, unknown> | null)?.[name] === true) options[name] = true;
  await runForwardGroupFailoverByIds([groupId], options);
});

async function runForwardGroupFailoverByIds(groupIds: number[], options: ForwardGroupFailoverOptions = {}) {
  const ids = Array.from(new Set(groupIds
    .map((value) => Number(value || 0))
    .filter((value) => Number.isInteger(value) && value > 0)));
  if (ids.length === 0) return;
  if (!isPanelBackgroundLeaseHolder()) {
    const payload = forwardableFailoverOptions(options);
    for (const groupId of ids) await requestPanelWork("forward-group", groupId, payload);
    return;
  }

  const ddnsSettings = await getDdnsSettings();
  const failures: Array<{ groupId: number; error: unknown }> = [];
  for (const groupId of ids) {
    try {
      await withForwardGroupEvaluationLock(groupId, async () => {
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
