import * as db from "./db";
import { formatBytes } from "../shared/formatBytes";
import { pushAgentRefresh } from "./agentEvents";
import { appendPanelLog } from "./_core/panelLogger";
import { parseSelfTestMeta } from "./agentRouteUtils";
import { getEmailConfig, sendMail } from "./email";
import { parseExpiryReminderDays, shouldSendExpiryReminder } from "../shared/expiryReminder";
import { planHostRenewalReminder, planHostTrafficReminder } from "../shared/hostReminder";
import {
  collectDueProxyTrafficReminders,
  proxyTrafficReminderTail,
  proxyTrafficReminderTitle,
} from "./proxyTrafficReminders";
import { dispatchReminders, type PendingReminder } from "./reminderDispatch";
import { runTelegramDigests, sendTelegramMessage } from "./telegramBot";
import { recordTunnelHopTestResult } from "./tunnelHopTestState";
import { recordHopTestResult } from "./hopTestState";
import { primeHostStatusNotifier, sweepOfflineHostsAndNotify } from "./hostStatusNotifier";
import { normalizeLinkProbeMethod } from "@shared/latencyProbe";
import { clearRuleLatencyQueryCache } from "./ruleLatencyQueryCache";
import { structuredLinkTestMessage, tunnelHopLatencyMode, tunnelHopModeText } from "./linkTestMessages";
import { cleanOldAddressGeoCache, runHostGeoSweep } from "./hostGeo";
import { pruneStaleAuthSessions } from "./repositories/sessionRepository";
import { pruneDispatchConfigAuditEvents } from "./configAudit";
import { reconcileHostDdnsRecords } from "./hostDdns";
import { reconcileRuleEntryDomains } from "./ruleEntryDomain";
import { checkPanelUpdateTask } from "./_core/systemRouter";
import { createNonOverlappingScheduledTask } from "./scheduledTask";
import { optimizeSqliteDatabase } from "./dbRuntime";
import { healAutoStoppedRules } from "./forwardRuleAutoRecovery";
import { sweepExpiredRuleEntryBridges } from "./ruleEntryBridges";
import {
  SELF_TEST_TIMEOUT_SECONDS,
  selfTestTimeoutSeconds,
  selfTestSweepActivity,
  startSelfTestSweepTimer,
} from "./selfTestTiming";
import { billingMonthlyBoundary, billingStartOfCalendarDay, MONTHLY_RESET_MAX_DAY } from "@shared/billingTime";
import { normalizeProxyNodeResetDay } from "@shared/proxyNodeQuota";
import { expireStalePendingOrders, recoverStaleProcessingPaymentOrders, reconcilePendingPaymentOrders } from "./payment";

type TimedOutForwardTest = {
  id: number;
  ruleId: number;
  hostId: number;
  message: string | null;
  timeoutSeconds?: number;
};

function timeoutSecondsForForwardTest(test: TimedOutForwardTest) {
  return selfTestTimeoutSeconds(parseSelfTestMeta(test.message));
}

const UPDATE_AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let hostStatusPrimePromise: Promise<void> | null = null;

async function refreshUserRuleAgents(userId: number, reason: string) {
  const rules = await db.getForwardRulesForUserSync(userId);
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules as any[]) {
    if (rule.hostId) hostIds.add(Number(rule.hostId));
    if (rule.tunnelId) tunnelIds.add(Number(rule.tunnelId));
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await db.getTunnelById(tunnelId);
    if (!tunnel) continue;
    await db.updateTunnel(tunnelId, { isRunning: false } as any);
    let entryHostIds = [Number(tunnel.entryHostId)].filter((hostId) => Number.isFinite(hostId) && hostId > 0);
    const entryGroupId = Number((tunnel as any).entryGroupId || 0);
    if (entryGroupId > 0) {
      const entryGroup = await db.getForwardGroupById(entryGroupId) as any;
      const entryMembers = entryGroup && entryGroup.isEnabled && String(entryGroup.groupMode || "") === "entry"
        ? (entryGroup.members || [])
        : [];
      const groupHostIds = entryMembers
        .filter((member: any) => member && member.isEnabled !== false && member.memberType === "host")
        .map((member: any) => Number(member.hostId))
        .filter((hostId: number) => Number.isFinite(hostId) && hostId > 0);
      if (groupHostIds.length > 0) entryHostIds = groupHostIds;
    }
    for (const entryHostId of entryHostIds) hostIds.add(entryHostId);
    hostIds.add(Number(tunnel.exitHostId));
  }
  for (const hostId of hostIds) {
    if (hostId > 0) pushAgentRefresh(hostId, reason);
  }
}

/*
  下面这些定时任务原本是模块私有的，导出只为一件事：**能量它们打多少次库**。

  它们都随面板规模增长（用户、主机、订阅、套餐），每几分钟到几小时跑一次，
  而且从来没被量过 —— 这种东西退化了界面上完全看不出来，只会表现为「面板越用
  越卡」。同一轮测量里，转发组详情那条就是这么揪出来的：每 5 分钟按组数放大。

  导出之后 schedulerQueryCost.test.ts 会按两个数据规模各跑一遍，条数随规模涨
  就红。生产代码不要直接调它们，调度器自己会安排。
*/

/**
 * 每月流量重置：用户、主机、落地节点、落地端口四路。
 *
 * 导出是为了能被用例直接跑一遍真库。这一段每一路都是「界面上有个开关，到了日子
 * 该有事情发生」—— 而落地端口那一路上个版本就是漏接了调度，开关存得下设置却
 * 永远不触发。只测「算不算到期」测不出这种漏接，必须真的把这个函数跑起来。
 */
export async function runMonthlyTrafficReset() {
  try {
    const now = new Date();
    const usersToReset = await db.getUsersForAutoReset(now);
    for (const user of usersToReset) {
      const resetDay = Math.min(MONTHLY_RESET_MAX_DAY, Math.max(1, Math.floor(Number(user.trafficResetDay) || 1)));
      const boundary = billingMonthlyBoundary(now, resetDay);
      if (!await db.resetUserTrafficForCycle(user.id, boundary, now)) continue;
      const recovery = await db.recoverUserForwardAccessIfEligible(user.id);
      if (recovery.restored) {
        await refreshUserRuleAgents(user.id, "traffic-reset-forward-restored");
      }
      console.log(`[Scheduler] Auto-reset traffic for user ${user.id} (${user.username})`);
    }
    if (usersToReset.length > 0) {
      console.log(`[Scheduler] Monthly traffic reset: ${usersToReset.length} user(s) reset`);
    }

    const hostsToReset = await db.getHostsForTrafficAutoReset(new Date());
    for (const host of hostsToReset as any[]) {
      await db.resetHostTraffic(Number(host.id));
      await db.markHostTrafficReset(Number(host.id));
      console.log(`[Scheduler] Auto-reset host traffic for host ${host.id} (${host.name})`);
    }
    if (hostsToReset.length > 0) {
      console.log(`[Scheduler] Monthly host traffic reset: ${hostsToReset.length} host(s) reset`);
    }

    /**
     * 落地机的套餐流量也按月重置。lastTrafficReset 挡住重复触发 ——
     * 这个任务每小时跑一次，不挡的话重置日当天会清零二十几次。
     */
    /*
      到没到重置日，交给 billingMonthlyBoundary 按当月天数算：设成每月 31 号的，
      二月就是 28 号（闰年 29 号）。今天还没到那个边界日时，边界会落在今天之后，
      于是这一行自然不动。
    */
    const dueForReset = (row: any) => {
      const boundary = billingMonthlyBoundary(now, normalizeProxyNodeResetDay(row?.trafficResetDay));
      if (now.getTime() < boundary.getTime()) return false;
      const last = row?.lastTrafficReset ? new Date(row.lastTrafficReset) : null;
      return !last || last.getTime() < boundary.getTime();
    };

    const nodesToReset = await db.getProxyNodesForTrafficAutoReset(now);
    for (const node of nodesToReset as any[]) {
      if (!dueForReset(node)) continue;
      await db.resetProxyNodeTraffic(Number(node.id));
      console.log(`[Scheduler] Auto-reset proxy node traffic for node ${node.id} (${node.name})`);
    }

    /*
      自建落地端口的额度也按月重置。

      这一步原来漏了：界面上那个「每月自动清零」开关存得下设置，却没有任何东西
      去读它 —— 开关拨了、日子到了、数字纹丝不动。设置存了却不生效，比没有这个
      开关更糟：人会以为已经安排好了，然后在某个月底被机房停机。
    */
    const inboundsToReset = await db.getProxyInboundsForTrafficAutoReset();
    for (const inbound of inboundsToReset as any[]) {
      if (!dueForReset(inbound)) continue;
      await db.resetProxyInboundTraffic(Number(inbound.id));
      console.log(`[Scheduler] Auto-reset proxy inbound traffic for inbound ${inbound.id} (${inbound.name})`);
    }

    const recharged = await db.rechargeSubscriptionTrafficCycles();
    if (recharged > 0) {
      console.log(`[Scheduler] Subscription traffic recharge: ${recharged} user(s) reset`);
    }

  } catch (error) {
    console.error("[Scheduler] Monthly traffic reset error:", error);
  }
}

export async function runSubscriptionExpirationCheck() {
  try {
    /**
     * 先试自动续费，再做到期清扫。
     *
     * 顺序反了的话，开了自动续费、余额也够的人会先被断一下服再续回来 ——
     * 中间那几分钟他的客户端全是红的，而他什么也没做错。
     */
    const autoRenew = await db.runSubscriptionAutoRenew();
    if (autoRenew.renewed > 0 || autoRenew.failed > 0) {
      console.log(`[Scheduler] Subscription auto-renew: ${autoRenew.renewed} renewed, ${autoRenew.failed} skipped`);
    }
    const expired = await db.expireUserSubscriptions();
    if (expired > 0) {
      console.log(`[Scheduler] Subscription expiration check: ${expired} subscription(s) expired`);
    }
  } catch (error) {
    console.error("[Scheduler] Subscription expiration check error:", error);
  }
}

export async function runExpirationCheck() {
  try {
    const expiredUsers = await db.getExpiredUsers();
    for (const user of expiredUsers) {
      // 真有东西变了（权限被收、规则被停）才去推 Agent：什么都没变还推一遍，
      // 就是每小时一次白白的全量刷新。
      if (!await db.setUserForwardAccess(user.id, false, "expired")) continue;
      await refreshUserRuleAgents(user.id, "user-expired");
      console.log(`[Scheduler] User ${user.id} (${user.username}) expired, disabled all rules`);
    }
    if (expiredUsers.length > 0) {
      console.log(`[Scheduler] Expiration check: ${expiredUsers.length} user(s) expired`);
    }
  } catch (error) {
    console.error("[Scheduler] Expiration check error:", error);
  }
}

async function settleTimedOutTunnelTests(timedOutTests: TimedOutForwardTest[], defaultTimeoutSeconds: number) {
  const settledTunnelIds = new Set<number>();

  const settleTunnel = async (tunnelId: number, message: string, logSuffix: string, timeoutSeconds: number) => {
    if (!Number.isFinite(tunnelId) || tunnelId <= 0 || settledTunnelIds.has(tunnelId)) return;
    settledTunnelIds.add(tunnelId);
    await db.updateTunnelTestResult(tunnelId, { status: "failed", latencyMs: null, message });
    await db.insertTunnelLatencyStat({ tunnelId, latencyMs: null, isTimeout: true }, { message });
    appendPanelLog("warn", `[TunnelTest] tunnel=${tunnelId} timeout after ${timeoutSeconds}s ${logSuffix}`);
  };

  const settleTunnelAggregate = async (
    aggregate: NonNullable<ReturnType<typeof recordTunnelHopTestResult>>,
    message: string,
    logSuffix: string,
  ) => {
    const tunnelId = Number(aggregate.tunnelId);
    if (!Number.isFinite(tunnelId) || tunnelId <= 0 || settledTunnelIds.has(tunnelId)) return;
    settledTunnelIds.add(tunnelId);
    if (aggregate.success) await db.updateTunnelRunningStatus(tunnelId, true);
    await db.updateTunnelTestResult(tunnelId, {
      status: aggregate.success ? "success" : "failed",
      latencyMs: aggregate.success ? aggregate.latencyMs : null,
      message,
    });
    await db.insertTunnelLatencyStat({
      tunnelId,
      latencyMs: aggregate.success ? aggregate.latencyMs : null,
      isTimeout: !aggregate.success,
    }, { message });
    appendPanelLog(
      aggregate.success ? "info" : "warn",
      `[TunnelTest] tunnel=${tunnelId} timeout aggregation success=${aggregate.success} ${logSuffix}`,
    );
  };

  for (const test of timedOutTests) {
    const timeoutSeconds = Number(test.timeoutSeconds) > 0
      ? Number(test.timeoutSeconds)
      : defaultTimeoutSeconds;
    const meta = parseSelfTestMeta(test.message);
    if (!meta) continue;

    if (meta.kind === "tunnel") {
      await settleTunnel(
        meta.tunnelId,
        `隧道链路自测超时：Agent 未在 ${timeoutSeconds} 秒内上报结果`,
        `test=${test.id} host=${test.hostId}`,
        timeoutSeconds,
      );
      continue;
    }

    if (meta.kind === "tunnel-hop") {
      const hopLabel = String((meta as any).hopLabel || "hop");
      const routeLabel = typeof (meta as any).routeLabel === "string" ? (meta as any).routeLabel : null;
      const groupKey = typeof (meta as any).groupKey === "string" ? (meta as any).groupKey : null;
      const groupLabel = typeof (meta as any).groupLabel === "string" ? (meta as any).groupLabel : null;
      const latencyMode = tunnelHopLatencyMode(meta as any);
      const modeText = tunnelHopModeText(latencyMode);
      const message = `${modeText.label}超时：${hopLabel} 未在 ${timeoutSeconds} 秒内上报结果`;
      const aggregate = recordTunnelHopTestResult(Number(test.id), {
        success: false,
        latencyMs: null,
        message,
        hopLabel,
        routeLabel,
        groupKey,
        groupLabel,
      }, {
        latencyMode,
        successPrefix: modeText.successPrefix,
        failurePrefix: modeText.failurePrefix,
        totalLabel: modeText.totalLabel,
      });
      if (aggregate) {
        const aggregateMessage = structuredLinkTestMessage({
          kind: modeText.kind,
          tunnelId: aggregate.tunnelId,
          message: aggregate.message,
          details: aggregate.details,
          totalLatencyMs: aggregate.latencyMs,
        });
        await settleTunnelAggregate(aggregate, aggregateMessage, `test=${test.id} aggregate=true`);
      } else {
        appendPanelLog("warn", `[TunnelTest] tunnel=${meta.tunnelId} branch timeout test=${test.id} host=${test.hostId} hop=${hopLabel}`);
      }
    }

    if (meta.kind === "forward-chain") {
      const hopLabel = String((meta as any).hopLabel || "hop");
      const routeLabel = typeof (meta as any).routeLabel === "string" ? (meta as any).routeLabel : null;
      const latencyMode = (meta as any).latencyMode === "multi-source-remaining-path"
        ? "multi-source-remaining-path"
        : (meta as any).latencyMode === "remaining-path" ? "remaining-path" : "sum";
      const message = `转发链逐跳测试超时：${hopLabel} 未在 ${timeoutSeconds} 秒内上报结果`;
      const aggregate = recordHopTestResult(Number(test.id), {
        success: false,
        latencyMs: null,
        message,
        hopLabel,
        routeLabel,
        method: normalizeLinkProbeMethod((meta as any).method),
      }, {
        successPrefix: "转发链逐跳测试成功",
        failurePrefix: "转发链逐跳测试失败",
        latencyMode,
      });
      if (aggregate) {
        const aggregateMessage = structuredLinkTestMessage({
          kind: "forward-chain-hop-summary",
          groupId: aggregate.ownerId,
          message: aggregate.message,
          details: aggregate.details,
          totalLatencyMs: aggregate.latencyMs,
        });
        await db.updateForwardTestResult(Number(test.id), {
          status: "failed",
          listenOk: false,
          targetReachable: false,
          forwardOk: false,
          latencyMs: null,
          message: aggregateMessage,
        });
        await db.insertForwardGroupLatencyStat({
          groupId: aggregate.ownerId,
          latencyMs: null,
          isTimeout: true,
        });
        appendPanelLog("warn", `[SelfTest] forward-chain group=${aggregate.ownerId} timeout aggregate=true test=${test.id}`);
      } else {
        appendPanelLog("warn", `[SelfTest] forward-chain group=${meta.groupId} timeout test=${test.id} host=${test.hostId} hop=${hopLabel}`);
      }
    }
  }
}

export async function runSelfTestTimeoutSweep() {
  if (!selfTestSweepActivity.shouldSweep()) return;
  try {
    const timedOutTests = await db.timeoutStaleForwardTests(
      SELF_TEST_TIMEOUT_SECONDS,
      timeoutSecondsForForwardTest,
    );
    if (timedOutTests.length > 0) {
      await settleTimedOutTunnelTests(timedOutTests, SELF_TEST_TIMEOUT_SECONDS);
      for (const test of timedOutTests) {
        const meta = parseSelfTestMeta(test.message);
        if (meta?.kind === "tunnel" || meta?.kind === "tunnel-hop") continue;
        if (!meta || meta.kind === "forward-via-tunnel") {
          await db.insertTcpingStat({
            ruleId: Number(test.ruleId),
            hostId: Number(test.hostId),
            latencyMs: null,
            isTimeout: true,
          });
          clearRuleLatencyQueryCache();
        }
        const targetPart = meta?.kind === "forward-chain"
          ? ` group=${meta.groupId}`
          : meta && "tunnelId" in meta && typeof meta.tunnelId === "number"
            ? ` tunnel=${meta.tunnelId}`
            : "";
        const timeoutSeconds = Number(test.timeoutSeconds) > 0
          ? Number(test.timeoutSeconds)
          : SELF_TEST_TIMEOUT_SECONDS;
        appendPanelLog("warn", `[SelfTest] rule=${test.ruleId}${targetPart} host=${test.hostId} timeout after ${timeoutSeconds}s test=${test.id}`);
      }
      console.log(`[Scheduler] Self-test timeout sweep: ${timedOutTests.length} test(s) marked as timeout`);
    }
  } catch (error) {
    console.error("[Scheduler] Self-test timeout sweep error:", error);
  }
}

async function recoverPendingSelfTestSweep() {
  try {
    if (await db.hasActiveForwardTests()) selfTestSweepActivity.markActive();
  } catch (error) {
    console.error("[Scheduler] Self-test recovery check error:", error);
    selfTestSweepActivity.markActive();
  }
}

/**
 * 每小时一次的历史清理。
 *
 * 逐张表顺序执行，不再 Promise.all 一起开跑：十几张表同时大批量 DELETE，
 * MySQL/PostgreSQL 上会同时占住十几条连接和一大片行锁，正在上报的 Agent 全被堵住；
 * SQLite 本来就只有一条写连接，并发也只是排队。某一张表失败只记日志，不影响后面的表
 * （原来 Promise.all 里一张失败，其余的也照样在后台跑完）。
 */
export async function runTcpingCleanup() {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["host_metrics", () => db.cleanOldHostMetrics(72)],
    ["traffic_stats", () => db.cleanOldTrafficStats(72)],
    ["traffic_stat_buckets", () => db.cleanOldTrafficStatBuckets(72)],
    ["tcping_stats", () => db.cleanOldTcpingStats(72)],
    ["tunnel_latency_stats", () => db.cleanOldTunnelLatencyStats(72)],
    ["forward_tests", () => db.cleanOldForwardTests(72)],
    ["forward_group_events", () => db.cleanOldForwardGroupEvents(72)],
    ["forward_rule_route_events", () => db.cleanOldForwardRuleRouteEvents(72)],
    ["host_probe_service_stats", () => db.cleanOldHostProbeServiceStats(72)],
    ["address_geo_cache", () => cleanOldAddressGeoCache()],
    // 失效超过 7 天的登录会话（过期或已撤销），只有「未撤销且未过期」的行会被读取。
    ["auth_sessions", () => pruneStaleAuthSessions(7)],
    // 只删 30 天前的 dispatch 审计行，配置改动（create/update/delete）一条不动。
    ["config_audit_events:dispatch", () => pruneDispatchConfigAuditEvents(30)],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (error) {
      console.error(`[Scheduler] TCPing cleanup error (${name}):`, error);
    }
  }
}

function dayKey(prefix: string, userId: number) {
  return `${prefix}:${userId}:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * 到期类提醒（套餐到期、主机续费）的去重键：按「这一次到期 + 这一档天数」记，不带日期。
 *
 * daysLeft 是从到期时刻往回按整天向上取整的，「还剩 7 天」这一档是到期前 7 天到 6 天
 * 之间的那 24 小时 —— 只要到期时间不是正好 UTC 零点，这 24 小时就横跨两个日历日，
 * 带日期的日标记会让同一档在两天里各发一次。键里带到期时间戳，续了一期之后新周期
 * 的每一档还能再发。没有日期的键由 pruneEphemeralSettings 按写入时间清理。
 */
function expiryThresholdKey(prefix: string, userId: number, expiresAtMs: number, daysLeft: number) {
  return `${prefix}:${userId}:${Math.floor(expiresAtMs / 1000)}:${daysLeft}`;
}

/**
 * 用户自己的两条提醒：套餐快到期、流量快用完。
 *
 * 只算「该发什么」，不发 —— 发不发由 dispatchReminders 按当天的去重键统一决定。
 */
function planUserEmailReminders(
  config: Awaited<ReturnType<typeof getEmailConfig>>,
  users: any[],
  now: number,
  reminderDays: number[],
): PendingReminder[] {
  const pending: PendingReminder[] = [];
  for (const user of users) {
    if (!user.email) continue;

    if (config.expiryReminder && user.expiresAt) {
      const expiresAt = new Date(user.expiresAt).getTime();
      const daysLeft = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
      if (shouldSendExpiryReminder(daysLeft, reminderDays)) {
        pending.push({
          key: expiryThresholdKey("emailReminder:expiry", user.id, expiresAt, daysLeft),
          send: async () => {
            await sendMail({
              to: user.email,
              subject: "NEX 套餐到期提醒",
              text: daysLeft === 0
                ? "你的 NEX 套餐今天到期，到期后订阅与转发都会停止，请及时续费或联系管理员。"
                : `你的 NEX 套餐将在 ${daysLeft} 天后到期，请及时续费或联系管理员。`,
            });
          },
        });
      }
    }

    if (config.trafficReminder && Number(user.trafficLimit || 0) > 0) {
      const used = Number(user.trafficUsed || 0);
      const limit = Number(user.trafficLimit || 0);
      const leftPercent = Math.max(0, Math.round(((limit - used) / limit) * 100));
      if (leftPercent <= config.trafficReminderThreshold) {
        pending.push({
          key: dayKey("emailReminder:traffic", user.id),
          send: async () => {
            await sendMail({
              to: user.email,
              subject: "NEX 流量余量提醒",
              text: `你的 NEX 流量剩余约 ${leftPercent}%，请及时续费或联系管理员。`,
            });
          },
        });
      }
    }
  }
  return pending;
}

export async function runEmailReminders() {
  try {
    const config = await getEmailConfig();
    if (!config.enabled) return;
    const users = await db.getUserTrafficSummaries();
    const now = Date.now();
    const reminderDays = parseExpiryReminderDays(await db.getSetting("expiryReminderDays"));

    await dispatchReminders([
      ...planUserEmailReminders(config, users as any[], now, reminderDays),
      ...await planHostEmailReminders(users as any[], now),
      ...await planProxyTrafficEmailReminders(users as any[]),
    ]);
  } catch (error) {
    console.error("[Scheduler] Email reminder error:", error);
  }
}

/**
 * 主机的流量告警与续费提醒 —— 邮件这一路。
 *
 * 这两件事原来只走 Telegram，而界面上那两个开关又被绑死在「Telegram 机器人已配置」
 * 上：没用 Telegram 的商家根本打不开，等于主机告警对他们不存在。机房流量跑超、
 * 机器到期停机，他名下所有转发和落地节点会一起断，却没有任何人告诉他。
 *
 * 「该不该提醒」和 Telegram 那一路共用 shared/hostReminder，两个渠道不会算出不同的
 * 结论；日标记前缀分开，所以两边各发一次，不会互相顶掉。
 */
async function planHostEmailReminders(users: any[], now: number): Promise<PendingReminder[]> {
  const usersById = new Map(users.map((user) => [Number(user.id), user]));
  const hostRows = await db.getHosts();
  const trafficHosts = (hostRows as any[]).filter((host) =>
    !!host.telegramTrafficAlertEnabled && Number(host.trafficLimit || 0) > 0);
  const renewalHosts = (hostRows as any[]).filter((host) => !!host.telegramRenewalReminderEnabled && !!host.stoppedAt);
  if (trafficHosts.length === 0 && renewalHosts.length === 0) return [];

  const pending: PendingReminder[] = [];

  if (trafficHosts.length > 0) {
    const rows = await db.getHostTrafficSummary(trafficHosts.map((host) => Number(host.id)));
    const trafficByHostId = new Map((rows as any[]).map((traffic) => [Number(traffic.hostId), traffic]));
    for (const host of trafficHosts) {
      const owner = usersById.get(Number(host.userId));
      if (!owner?.email) continue;
      const plan = planHostTrafficReminder(
        host,
        hostTrafficUsageBytes(trafficByHostId.get(Number(host.id)), host.trafficMeasureMode),
      );
      if (!plan.due) continue;
      pending.push({
        key: dayKey(`emailReminder:hostTraffic:${host.id}`, owner.id),
        send: async () => {
          await sendMail({
            to: owner.email,
            subject: "NEX 主机流量提醒",
            text: [
              `主机：${host.name || `#${host.id}`}`,
              `剩余约 ${plan.leftPercent}%`,
              `已用：${formatBytes(plan.usedBytes)} / ${formatBytes(plan.limitBytes)}`,
              `计算方式：${hostTrafficMeasureModeLabel(host.trafficMeasureMode)}`,
              "",
              "流量跑超之后这台机器上的转发和落地节点会一起受影响，请及时处理。",
            ].join("\n"),
          });
        },
      });
    }
  }

  for (const host of renewalHosts) {
    const owner = usersById.get(Number(host.userId));
    if (!owner?.email) continue;
    const renewal = planHostRenewalReminder(host, now);
    if (!renewal.due) continue;
    pending.push({
      // 带上到期时间戳：续了一期之后同样的提醒要能对新周期再发一次；不带日期，
      // 同一档不会因为横跨两个日历日发两次（见 expiryThresholdKey）。
      key: expiryThresholdKey(`emailReminder:hostRenewal:${host.id}`, owner.id, renewal.stoppedAtMs, renewal.daysLeft),
      send: async () => {
        await sendMail({
          to: owner.email,
          subject: "NEX 主机续费提醒",
          text: [
            `主机：${host.name || `#${host.id}`}`,
            renewal.daysLeft === 0
              ? "今天到期停机。"
              : `还有 ${renewal.daysLeft} 天到期停机。`,
            `到期时间：${new Date(renewal.stoppedAtMs).toLocaleDateString("zh-CN")}`,
            "",
            "机器停了之后，它上面的转发和落地节点会一起断。",
          ].join("\n"),
        });
      },
    });
  }

  return pending;
}

/**
 * 落地节点与落地端口的流量提醒 —— 邮件这一路。
 *
 * 「该提醒谁、提醒什么」全部在 server/proxyTrafficReminders 里算好，这里只管发。
 * Telegram 那一路遍历的是同一个清单，只是日标记前缀不同，所以两个渠道各发一次，
 * 不会互相顶掉。
 */
async function planProxyTrafficEmailReminders(users: any[]): Promise<PendingReminder[]> {
  const usersById = new Map(users.map((user) => [Number(user.id), user]));
  const pending: PendingReminder[] = [];
  for (const subject of await collectDueProxyTrafficReminders()) {
    const owner = usersById.get(subject.userId);
    if (!owner?.email) continue;
    const { plan } = subject;
    pending.push({
      // 键里带状态：先发过「快满」，当天真跑满时那一封更要紧，不能被顶掉。
      key: dayKey(`emailReminder:${subject.dedupeKey}`, owner.id),
      send: async () => {
        await sendMail({
          to: owner.email,
          subject: proxyTrafficReminderTitle(subject),
          text: [
            `${subject.kindText}：${subject.label}`,
            `已用：${formatBytes(plan.usedBytes)} / ${formatBytes(plan.limitBytes)}（${plan.usedPercent}%）`,
            "",
            proxyTrafficReminderTail(subject),
          ].join("\n"),
        });
      },
    });
  }
  return pending;
}

export async function runTelegramReminders() {
  try {
    const settings = await db.getAllSettings();
    const envToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
    const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
    const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
    if (!botEnabled || !botConfigured) return;

    const expiryReminder = settings.telegramExpiryReminder === "true";
    const trafficReminder = settings.telegramTrafficReminder === "true";
    const trafficReminderThreshold = Math.min(99, Math.max(1, Number(settings.telegramTrafficReminderThreshold || 20)));
    const hostRows = await db.getHosts();
    const hostTrafficAlertHosts = (hostRows as any[]).filter((host) => !!host.telegramTrafficAlertEnabled && Number(host.trafficLimit || 0) > 0);
    const hostRenewalReminderHosts = (hostRows as any[]).filter((host) => !!host.telegramRenewalReminderEnabled && !!host.stoppedAt);
    // 落地节点/落地端口的流量提醒不看上面几个开关（邮件那一路也一样），所以要先把
    // 它们算出来再决定能不能提前收工 —— 原来在这之前就 return 了，没开用户到期/流量
    // 提醒、也没有主机开告警的面板，落地流量提醒在 Telegram 这一路永远不发。
    const proxyTrafficSubjects = await collectDueProxyTrafficReminders();
    if (
      !expiryReminder
      && !trafficReminder
      && hostTrafficAlertHosts.length === 0
      && hostRenewalReminderHosts.length === 0
      && proxyTrafficSubjects.length === 0
    ) return;

    const users = await db.getUserTrafficSummaries();
    const usersById = new Map((users as any[]).map((user) => [Number(user.id), user]));
    const now = Date.now();
    const reminderDays = parseExpiryReminderDays(settings.expiryReminderDays);
    const pending: PendingReminder[] = [];

    for (const user of users as any[]) {
      if (!user.telegramId) continue;

      if (expiryReminder && user.expiresAt) {
        const expiresAt = new Date(user.expiresAt).getTime();
        const daysLeft = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
        if (shouldSendExpiryReminder(daysLeft, reminderDays)) {
          pending.push({
            key: expiryThresholdKey("telegramReminder:expiry", user.id, expiresAt, daysLeft),
            send: async () => {
              await sendTelegramMessage(
                user.telegramId,
                [
                  "NEX 到期提醒",
                  "",
                  daysLeft === 0 ? "你的套餐今天到期。" : `你的套餐将在 ${daysLeft} 天后到期。`,
                  `到期时间：${new Date(user.expiresAt).toLocaleDateString("zh-CN")}`,
                  "请及时续费或联系管理员。",
                ].join("\n"),
              );
            },
          });
        }
      }

      if (trafficReminder && Number(user.trafficLimit || 0) > 0) {
        const used = Number(user.trafficUsed || 0);
        const limit = Number(user.trafficLimit || 0);
        const leftPercent = Math.max(0, Math.round(((limit - used) / limit) * 100));
        if (leftPercent <= trafficReminderThreshold) {
          pending.push({
            key: dayKey("telegramReminder:traffic", user.id),
            send: async () => {
              await sendTelegramMessage(
                user.telegramId,
                [
                  "NEX 流量提醒",
                  "",
                  `你的流量剩余约 ${leftPercent}%。`,
                  `已用：${formatBytes(used)}`,
                  `总量：${formatBytes(limit)}`,
                  "请及时续费或联系管理员。",
                ].join("\n"),
              );
            },
          });
        }
      }
    }

    if (hostTrafficAlertHosts.length > 0) {
      const hostIds = hostTrafficAlertHosts.map((host) => Number(host.id)).filter((id) => Number.isInteger(id) && id > 0);
      const hostTrafficRows = await db.getHostTrafficSummary(hostIds);
      const trafficByHostId = new Map((hostTrafficRows as any[]).map((traffic) => [Number(traffic.hostId), traffic]));

      for (const host of hostTrafficAlertHosts as any[]) {
        const owner = usersById.get(Number(host.userId));
        if (!owner?.telegramId) continue;

        const traffic = trafficByHostId.get(Number(host.id));
        // 「该不该提醒」统一由 shared/hostReminder 判定，邮件那一路用的是同一份。
        const plan = planHostTrafficReminder(host, hostTrafficUsageBytes(traffic, host.trafficMeasureMode));
        if (!plan.due) continue;
        const { leftPercent, usedBytes: used, limitBytes: limit } = plan;
        pending.push({
          key: dayKey(`telegramReminder:hostTraffic:${host.id}`, owner.id),
          send: async () => {
            await sendTelegramMessage(
              owner.telegramId,
              [
                "NEX 主机流量提醒",
                "",
                `主机：${escapeHtmlLocal(host.name || `#${host.id}`)}`,
                `剩余约 ${leftPercent}%`,
                `已用：${formatBytes(used)}`,
                `总量：${formatBytes(limit)}`,
                `计算方式：${hostTrafficMeasureModeLabel(host.trafficMeasureMode)}`,
              ].join("\n"),
            );
          },
        });
      }
    }

    /**
     * 落地节点与落地端口的流量提醒。清单与邮件那一路共用
     * server/proxyTrafficReminders，日标记前缀不同，所以两个渠道各发一次。
     */
    for (const subject of proxyTrafficSubjects) {
      const owner = usersById.get(subject.userId);
      if (!owner?.telegramId) continue;
      const { plan } = subject;
      pending.push({
        key: dayKey(`telegramReminder:${subject.dedupeKey}`, owner.id),
        send: async () => {
          await sendTelegramMessage(
            owner.telegramId,
            [
              proxyTrafficReminderTitle(subject),
              "",
              `${subject.kindText}：${escapeHtmlLocal(subject.label)}`,
              `已用：${formatBytes(plan.usedBytes)} / ${formatBytes(plan.limitBytes)}（${plan.usedPercent}%）`,
              "",
              proxyTrafficReminderTail(subject),
            ].join("\n"),
          );
        },
      });
    }

    for (const host of hostRenewalReminderHosts as any[]) {
      const owner = usersById.get(Number(host.userId));
      if (!owner?.telegramId) continue;
      const renewal = planHostRenewalReminder(host, now);
      if (!renewal.due) continue;
      const stoppedAt = renewal.stoppedAtMs;
      const daysLeft = renewal.daysLeft;
      // 键里带到期时间戳、不带日期：续期后新周期能再发，同一档不会跨日重发。
      pending.push({
        key: expiryThresholdKey(`telegramReminder:hostRenewal:${host.id}`, owner.id, stoppedAt, daysLeft),
        send: async () => {
          await sendTelegramMessage(
            owner.telegramId,
            [
              "NEX 主机续费提醒",
              "",
              `主机：${escapeHtmlLocal(host.name || `#${host.id}`)}`,
              `剩余：${daysLeft} 天`,
              `到期时间：${new Date(host.stoppedAt).toLocaleDateString("zh-CN")}`,
              "请及时续费或联系管理员。",
            ].join("\n"),
          );
        },
      });
    }

    await dispatchReminders(pending);
  } catch (error) {
    console.error("[Scheduler] Telegram reminder error:", error);
  }
}

async function runForwardGroupFailover() {
  try {
    await db.runForwardGroupFailoverSweep();
  } catch (error) {
    console.error("[Scheduler] Forward group failover error:", error);
  }
}

/**
 * 主机定位补漏。
 *
 * 自动定位原来只在有人翻主机列表时触发一次；ipapi.co 限流那阵子没定到的机器
 * 就一直「地区获取中」，直到下次有人翻列表还得碰巧不限流。这里定时把没定到位
 * 的再试一遍，退避和三家服务的兜底都在 hostGeo 里。
 */
export async function runHostGeoRetrySweep() {
  try {
    await runHostGeoSweep();
  } catch (error) {
    console.error("[Scheduler] Host geo sweep error:", error);
  }
}

export async function runHostDdnsReconcile() {
  try {
    const queued = await reconcileHostDdnsRecords();
    if (queued > 0) console.log(`[Scheduler] Host DDNS reconcile queued ${queued} update(s)`);
  } catch (error) {
    console.error("[Scheduler] Host DDNS reconcile error:", error);
  }
}

export async function runRuleEntryDomainReconcile() {
  try {
    const result = await reconcileRuleEntryDomains();
    if (result.synced > 0 || result.deleted > 0 || result.failed > 0) {
      console.log(`[Scheduler] Rule entry domain reconcile: synced ${result.synced}, deleted ${result.deleted}, failed ${result.failed}`);
    }
  } catch (error) {
    console.error("[Scheduler] Rule entry domain reconcile error:", error);
  }
}

async function runHostStatusSweep() {
  try {
    if (hostStatusPrimePromise) await hostStatusPrimePromise;
    await sweepOfflineHostsAndNotify();
  } catch (error) {
    console.error("[Scheduler] Host status sweep error:", error);
  }
}

export async function runHostBillingCycleExtension() {
  try {
    const extendedHosts = await db.extendDueHostBillingPeriods();
    if (extendedHosts > 0) {
      console.log(`[Scheduler] Host billing cycle extension: ${extendedHosts} host(s) advanced`);
    }
  } catch (error) {
    console.error("[Scheduler] Host billing cycle extension error:", error);
  }
}

const FORWARD_GROUP_LIVENESS_PRIME_RETRY_MS = [0, 1_000, 3_000, 7_000, 15_000] as const;

async function primeForwardGroupLivenessWithRetry() {
  for (let attempt = 0; attempt < FORWARD_GROUP_LIVENESS_PRIME_RETRY_MS.length; attempt += 1) {
    const delayMs = FORWARD_GROUP_LIVENESS_PRIME_RETRY_MS[attempt];
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      });
    }
    try {
      await db.primeForwardGroupHostLivenessDeadlines();
      return;
    } catch (error) {
      const finalAttempt = attempt === FORWARD_GROUP_LIVENESS_PRIME_RETRY_MS.length - 1;
      console.warn(
        `[ForwardGroup] Liveness deadline prime failed attempt=${attempt + 1}/${FORWARD_GROUP_LIVENESS_PRIME_RETRY_MS.length}${finalAttempt ? " giving-up=true" : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function runUpdateAutoCheck() {
  try {
    await checkPanelUpdateTask(false);
  } catch (error: any) {
    console.warn("[Scheduler] Update auto-check error:", error?.message || error);
  }
}

function hostTrafficUsageBytes(traffic: any, mode: unknown) {
  const bytesIn = Number(traffic?.bytesIn || 0);
  const bytesOut = Number(traffic?.bytesOut || 0);
  if (mode === "outbound") return bytesOut;
  if (mode === "max") return Math.max(bytesIn, bytesOut);
  return bytesIn + bytesOut;
}

function hostTrafficMeasureModeLabel(mode: unknown) {
  if (mode === "outbound") return "仅出向";
  if (mode === "max") return "取最大值";
  return "双向";
}

function escapeHtmlLocal(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function startScheduler() {
  hostStatusPrimePromise = primeHostStatusNotifier().finally(() => {
    hostStatusPrimePromise = null;
  });
  void primeForwardGroupLivenessWithRetry();

  const monthlyTrafficReset = createNonOverlappingScheduledTask("monthly traffic reset", async () => {
    await runMonthlyTrafficReset();
  });
  const expirationCheck = createNonOverlappingScheduledTask("subscription and account expiration", async () => {
    await runSubscriptionExpirationCheck();
    await runExpirationCheck();
  });
  const hostBillingCycleCheck = createNonOverlappingScheduledTask("host billing cycle extension", async () => {
    await runHostBillingCycleExtension();
  });
  const selfTestTimeoutSweep = createNonOverlappingScheduledTask("self-test timeout sweep", async () => {
    await runSelfTestTimeoutSweep();
  });
  const historyCleanup = createNonOverlappingScheduledTask("history cleanup", async () => {
    await runTcpingCleanup();
    /**
     * 顺手清掉过期的「一天只做一次」标记。
     *
     * 到期提醒、流量提醒、主机续费提醒、余额自动续费都会往 system_settings 里写
     * 一行日标记防重复，写完从来没人删 —— 五百人的面板跑一年能攒十万行，而
     * getAllSettings() 是整表读，于是这些垃圾每次缓存过期都要重新加载一遍：
     * 面板越用越慢，还找不到原因。去重窗口只有一天，留 7 天纯属保险。
     */
    const pruned = await db.pruneEphemeralSettings(7).catch((error) => {
      console.warn("[Scheduler] Ephemeral settings prune failed:", error instanceof Error ? error.message : error);
      return 0;
    });
    if (pruned > 0) console.log(`[Scheduler] Pruned ${pruned} stale reminder marker(s)`);
  }, { slowTaskMs: 15_000 });
  const forwardingMaintenance = createNonOverlappingScheduledTask("forward-group and DDNS maintenance", async () => {
    await runForwardGroupFailover();
    await runHostDdnsReconcile();
  });
  const ruleEntryDomainMaintenance = createNonOverlappingScheduledTask("rule entry domain reconcile", async () => {
    await runRuleEntryDomainReconcile();
  }, { slowTaskMs: 30_000 });
  const autoStoppedRuleRecovery = createNonOverlappingScheduledTask("auto-stopped rule recovery", async () => {
    try {
      await healAutoStoppedRules("scheduled-auto-heal");
    } catch (error) {
      console.error("[Scheduler] Auto-stopped rule recovery error:", error);
    }
  });
  /*
    换隧道后旧入口的临时桥接到期：删行并推一次刷新，Agent 才会马上撤掉监听。只靠心跳里
    「读的时候过滤掉」不够 —— 没有别的改动时 Agent 一直拿稳定心跳计划，要等到整轮对账才撤。
    默认只留 1 小时，所以一分钟扫一次；没有到期的行时就是一条带索引的查询。
  */
  const entryBridgeExpiry = createNonOverlappingScheduledTask("rule entry bridge expiry", async () => {
    try {
      await sweepExpiredRuleEntryBridges();
    } catch (error) {
      console.error("[Scheduler] Rule entry bridge expiry error:", error);
    }
  });
  const hostStatusSweep = createNonOverlappingScheduledTask("host status sweep", async () => {
    await runHostStatusSweep();
  });
  const hostGeoSweep = createNonOverlappingScheduledTask("host geo retry sweep", async () => {
    await runHostGeoRetrySweep();
  }, { slowTaskMs: 60_000 });
  const reminderSweep = createNonOverlappingScheduledTask("email and Telegram reminders", async () => {
    await runEmailReminders();
    await runTelegramReminders();
  }, { slowTaskMs: 15_000 });
  // 每日简报：北京时间 9 点以后发当天那一份，十分钟看一次；去重键带日期，一天只发一次。
  const telegramDigest = createNonOverlappingScheduledTask("Telegram daily digest", async () => {
    try {
      await runTelegramDigests();
    } catch (error) {
      console.error("[Scheduler] Telegram digest error:", error);
    }
  }, { slowTaskMs: 30_000 });
  const updateCheck = createNonOverlappingScheduledTask("panel update check", async () => {
    await runUpdateAutoCheck();
  }, { slowTaskMs: 15_000 });
  const databasePoolSizing = createNonOverlappingScheduledTask("database pool sizing", async () => {
    await db.refreshDatabasePoolSettings();
  });
  const sqliteOptimize = createNonOverlappingScheduledTask("SQLite optimize", async () => {
    await optimizeSqliteDatabase();
  });
  const paymentMaintenance = createNonOverlappingScheduledTask("payment order maintenance", async () => {
    /**
     * 先主动查单，再关过期的。
     *
     * 顺序反了的话，一笔「付了但回调没到」的订单会先被判过期关掉 —— 钱收了，
     * 服务没发，而系统里看起来一切正常。
     */
    const reconciled = await reconcilePendingPaymentOrders();
    if (reconciled.paid > 0) {
      console.log(`[Scheduler] Payment reconcile: ${reconciled.paid} paid order(s) recovered out of ${reconciled.checked} checked`);
    }
    await expireStalePendingOrders();
    await recoverStaleProcessingPaymentOrders();
  });

  const repeatAfter = (task: () => Promise<boolean>, intervalMs: number, delayMs: number) => {
    const startTimer = setTimeout(() => {
      void task();
      const intervalTimer = setInterval(() => { void task(); }, intervalMs);
      intervalTimer.unref?.();
    }, delayMs);
    startTimer.unref?.();
  };

  const runAtBillingMidnight = (task: () => Promise<boolean>) => {
    const scheduleNext = () => {
      const now = Date.now();
      const nextMidnight = billingStartOfCalendarDay(now).getTime() + 24 * 60 * 60 * 1000 + 1_000;
      const timer = setTimeout(async () => {
        await task();
        scheduleNext();
      }, Math.max(1_000, nextMidnight - now));
      timer.unref?.();
    };
    scheduleNext();
  };

  repeatAfter(hostStatusSweep, 30 * 1000, 5_000);
  startSelfTestSweepTimer(async () => { await selfTestTimeoutSweep(); });
  void recoverPendingSelfTestSweep();
  // Agent probe reports and host state transitions trigger failover work.
  // This sweep is only a recovery path for missed events or a panel restart.
  // Let the liveness prime's startup grace accept a live Agent presence before
  // the broad recovery sweep evaluates persisted heartbeat timestamps.
  repeatAfter(forwardingMaintenance, 5 * 60 * 1000, 20_000);
  // 规则专属域名：保存时已经立刻同步，这里三分钟一轮补漏（批量改库、面板重启前没做完的）并删待删记录。
  repeatAfter(ruleEntryDomainMaintenance, 3 * 60 * 1000, 50_000);
  repeatAfter(expirationCheck, 60 * 60 * 1000, 16_000);
  // 被隧道/转发资源/账户暂停/授权失效连带停掉的规则：原因消除后最迟两分钟自己恢复。
  repeatAfter(autoStoppedRuleRecovery, 2 * 60 * 1000, 40_000);
  // Keep host expiry dates responsive without changing the account-expiration
  // scan cadence or creating a timer per host.
  repeatAfter(hostBillingCycleCheck, 5 * 60 * 1000, 18_000);
  repeatAfter(monthlyTrafficReset, 60 * 60 * 1000, 20_000);
  runAtBillingMidnight(monthlyTrafficReset);
  repeatAfter(databasePoolSizing, 5 * 60 * 1000, 25_000);
  // SQLite 查询规划的统计信息：启动时 initDatabase 已经跑过一次，之后每 6 小时按需刷新（其它库不做事）
  repeatAfter(sqliteOptimize, 6 * 60 * 60 * 1000, 6 * 60 * 60 * 1000);
  repeatAfter(paymentMaintenance, 60 * 1000, 35_000);
  repeatAfter(entryBridgeExpiry, 60 * 1000, 50_000);
  repeatAfter(reminderSweep, 6 * 60 * 60 * 1000, 30_000);
  repeatAfter(telegramDigest, 10 * 60 * 1000, 70_000);
  repeatAfter(updateCheck, UPDATE_AUTO_CHECK_INTERVAL_MS, 45_000);
  repeatAfter(historyCleanup, 60 * 60 * 1000, 2 * 60_000);
  // 没定到位的主机五分钟看一次；真正的重试间隔由 hostGeo 里的退避（10 分钟起、封顶 6 小时）决定。
  repeatAfter(hostGeoSweep, 5 * 60 * 1000, 90_000);

  console.log("[Scheduler] Scheduled tasks started with overlap guards and staggered startup");
}
