import * as db from "./db";
import { ENV } from "./env";
import { sendTelegramMessage } from "./telegramBot";
import { clearTunnelRuntimeStatusForHost } from "./tunnelRuntimeStatus";
import { isHostConsideredOnline } from "./hostHeartbeatPolicy";
import { partitionHostsByRecentAgentActivity } from "./agentActivity";
import {
  getPresenceCapableHostLivenessSnapshot,
  subscribeAgentFastLiveness,
  type AgentFastLivenessTransition,
} from "./agentFastLiveness";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { filterTelegramRecipients } from "./telegramNotifyPrefs";
import { HostOfflineNotificationDebouncer } from "./hostOfflineNotificationDebouncer";

type HostStatus = "online" | "offline";

const lastKnownStatus = new Map<number, HostStatus>();
const FAST_LIVENESS_RETRY_DELAYS_MS = [0, 1_000, 3_000, 7_000, 15_000] as const;
let hostStatusNotifierPrimed = false;
const fastOfflineNotificationDebouncer = new HostOfflineNotificationDebouncer({
  onError: (error, hostId) => {
    console.warn(`[HostStatus] Delayed offline notify failed host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
  },
});

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTime(value = new Date()) {
  return value.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function hostName(host: any) {
  return String(host?.name || `主机 ${host?.id || ""}`).trim();
}

function hostAddress(host: any) {
  const seen = new Set<string>();
  const values = [host?.ip, host?.ipv4, host?.ipv6]
    .map((value) => String(value || "").trim())
    .filter((value) => value && value.toLowerCase() !== "unknown")
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return values.join(" / ") || "-";
}

function hostStatusMessage(host: any, status: HostStatus) {
  const online = status === "online";
  const marker = online ? "🟢" : "🔴";
  const title = online ? "NEX 主机上线通知" : "NEX 主机离线告警";
  const statusLabel = online ? "在线" : "离线";
  const statusText = online ? "Agent 已重新连接面板" : "心跳超时，主机已被标记离线";
  return [
    `<b>${marker} ${escapeHtml(title)}</b>`,
    "",
    `<b>状态</b>：${marker} ${escapeHtml(statusLabel)}`,
    `<b>主机</b>：${escapeHtml(hostName(host))} (#${escapeHtml(host?.id || "-")})`,
    `<b>地址</b>：<code>${escapeHtml(hostAddress(host))}</code>`,
    `<b>说明</b>：${escapeHtml(statusText)}`,
    `<b>时间</b>：${escapeHtml(formatTime())}`,
  ].join("\n");
}

export function isHostStatusOnline(host: any) {
  return isHostConsideredOnline(host);
}

async function telegramHostStatusEnabled() {
  const settings = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
  return settings.telegramHostStatusNotify === "true" && botEnabled && botConfigured;
}

/** 一轮巡检里超过这么多台主机同时掉线，就改发一条汇总，而不是每台一条。 */
export const HOST_STATUS_SUMMARY_THRESHOLD = 5;
/** 汇总消息里最多列出多少台主机的名字，其余只报数量。 */
const HOST_STATUS_SUMMARY_MAX_NAMES = 30;

function hostStatusSummaryMessage(hosts: any[], status: HostStatus) {
  const online = status === "online";
  const marker = online ? "🟢" : "🔴";
  const title = online ? "NEX 主机批量上线通知" : "NEX 主机批量离线告警";
  const listed = hosts.slice(0, HOST_STATUS_SUMMARY_MAX_NAMES);
  const rest = hosts.length - listed.length;
  return [
    `<b>${marker} ${escapeHtml(title)}</b>`,
    "",
    online
      ? `本轮共有 <b>${hosts.length}</b> 台主机重新连接面板：`
      : `本轮巡检共有 <b>${hosts.length}</b> 台主机心跳超时，已被标记离线：`,
    ...listed.map((host) => `• ${escapeHtml(hostName(host))} (#${escapeHtml(host?.id || "-")})`),
    ...(rest > 0 ? [`…以及另外 ${rest} 台`] : []),
    "",
    `<b>时间</b>：${escapeHtml(formatTime())}`,
  ].join("\n");
}

async function sendTelegramToAdmins(text: string, logLabel: string) {
  if (!(await telegramHostStatusEnabled())) return;
  const recipients = await filterTelegramRecipients(await db.getTelegramAdminRecipients() as any[], "host");
  if (recipients.length === 0) return;
  let sent = 0;
  let failed = 0;
  for (const user of recipients as any[]) {
    if (!user.telegramId) continue;
    try {
      await sendTelegramMessage(user.telegramId, text);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[Telegram] Host status notify failed user=${user.id} ${logLabel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sent > 0 || failed > 0) {
    console.info(`[Telegram] Host status notify ${logLabel} sent=${sent} failed=${failed}`);
  }
}

async function sendHostStatusTelegram(host: any, status: HostStatus) {
  await sendTelegramToAdmins(hostStatusMessage(host, status), `status=${status} host=${host?.id}`);
}

/**
 * 记下一次状态变化，返回这次要不要通知。
 *
 * 首次见到的主机只记不报（除非是上线且已完成预热），状态没变不报。
 */
function recordHostStatusTransition(host: any, status: HostStatus) {
  const hostId = Number(host?.id || 0);
  if (!Number.isFinite(hostId) || hostId <= 0) return false;
  if (status === "online") fastOfflineNotificationDebouncer.cancel(hostId);
  const previous = lastKnownStatus.get(hostId);
  if (previous === status) return false;
  lastKnownStatus.set(hostId, status);
  if (previous === undefined) return hostStatusNotifierPrimed && status === "online";
  return true;
}

async function notifyHostStatusChange(host: any, status: HostStatus) {
  if (recordHostStatusTransition(host, status)) await sendHostStatusTelegram(host, status);
}

/**
 * 一批状态变化一起通知。
 *
 * 机房断电、上游网络抖一下，一轮巡检能扫出几十上百台同时掉线。原来是每台主机给每个
 * 管理员各发一条：一百台就是每人一百条，Telegram 很快开始 429，后面的消息（包括
 * 真正要紧的）全被丢掉，管理员手机也被刷屏。超过阈值就合成一条汇总。
 */
async function notifyHostStatusChanges(hosts: any[], status: HostStatus) {
  const due = hosts.filter((host) => recordHostStatusTransition(host, status));
  if (due.length === 0) return;
  if (due.length > HOST_STATUS_SUMMARY_THRESHOLD) {
    await sendTelegramToAdmins(hostStatusSummaryMessage(due, status), `status=${status} summary hosts=${due.length}`);
    return;
  }
  for (const host of due) await sendHostStatusTelegram(host, status);
}

/**
 * 机器掉线了，库里那些「正在跑」的行也要跟着改。
 *
 * 心跳超时只改了 hosts.isOnline，而 forward_rules.isRunning / tunnels.isRunning
 * 是 Agent 上一次上报时写下的结论 —— 机器没了没人再来改它。于是一台已经掉线
 * 几个小时的机器，它的转发在面板上仍然是绿的，鼠标移上去写着**「Agent 已确认
 * 规则运行」**：不是含糊的「状态未知」，是一句言之凿凿的假话，而这一页正是人
 * 出事时第一个打开的地方。
 *
 * 用的是地址变更那条路同一个函数（resetAgentRuntimeStateForHost），它连带把
 * 这台机器参与的隧道（入口、出口、中间跳、入口组成员）一起清掉 —— 机器没了，
 * 经过它的那条链路当然也没在跑。
 *
 * 清成「等待 Agent 上报」而不是「错误」：机器回来时下一次心跳就会重新写上
 * isRunning，中间这段确实只是「不知道」。掉线本身另有状态点和 Telegram 通知在说。
 */
async function clearRuntimeStateForOfflineHost(hostId: number) {
  clearTunnelRuntimeStatusForHost(hostId);
  try {
    await db.resetAgentRuntimeStateForHost(hostId);
  } catch (error) {
    console.warn(`[HostStatus] 掉线后清理运行状态失败 host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function primeHostStatusNotifier() {
  fastOfflineNotificationDebouncer.clear();
  try {
    const [hosts, staleOnlineHosts] = await Promise.all([
      db.getHosts(),
      db.getStaleOnlineHosts(),
    ]);
    for (const host of hosts as any[]) {
      lastKnownStatus.set(Number(host.id), host.isOnline ? "online" : "offline");
    }
    const staleIds = (staleOnlineHosts as any[]).map((host) => Number(host.id)).filter((id) => Number.isFinite(id) && id > 0);
    if (staleIds.length > 0) {
      const transitionedIds = await db.markStaleHostsOffline(staleIds);
      for (const hostId of transitionedIds) {
        lastKnownStatus.set(hostId, "offline");
        await clearRuntimeStateForOfflineHost(hostId);
      }
      if (transitionedIds.length > 0) {
        console.info(`[HostStatus] Primed ${transitionedIds.length} stale online host(s) silently`);
      }
    }
    hostStatusNotifierPrimed = true;
  } catch (error) {
    hostStatusNotifierPrimed = false;
    console.warn(`[HostStatus] Prime failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function notifyHostOnlineIfNeeded(host: any) {
  fastOfflineNotificationDebouncer.cancel(Number(host?.id || 0));
  await notifyHostStatusChange(host, "online");
  void db.scheduleForwardGroupsForHostHealthChange(Number(host?.id || 0)).catch((error) => {
    console.warn(`[HostStatus] Online forward-group evaluation failed host=${host?.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function restoreHostOnlineAfterStaleOfflineTransition(hostId: number) {
  const before = getPresenceCapableHostLivenessSnapshot(hostId);
  if (!before || before.confirmedOffline) return;
  await db.touchHostHeartbeat(hostId);
  // A second silence transition may have completed while the compensating DB
  // write was in flight. In that case the newest transition must win.
  const after = getPresenceCapableHostLivenessSnapshot(hostId);
  if (after?.confirmedOffline) await db.markHostOffline(hostId);
}

async function handlePresenceCapableHostOnline(event: AgentFastLivenessTransition) {
  if (event.kind !== "activity-restored" || event.confirmedOffline !== false) return;
  if (!event.isCurrent()) return;
  const hostId = Number(event.hostId || 0);
  if (!Number.isFinite(hostId) || hostId <= 0) return;
  fastOfflineNotificationDebouncer.cancel(hostId);

  // The regular presence route deliberately throttles database writes. A
  // recovery transition must still repair a host that was marked offline by a
  // just-completed silence deadline, then immediately re-evaluate its groups.
  await db.touchHostHeartbeat(hostId);
  if (!event.isCurrent()) return;
  const host = await db.getHostById(hostId);
  if (!host || !event.isCurrent()) return;
  await db.scheduleForwardGroupsForHostHealthChange(hostId);
  if (!event.isCurrent()) return;
  await notifyHostStatusChange({ ...host, isOnline: true, lastHeartbeat: new Date() }, "online");
}

export async function handlePresenceCapableHostOffline(event: AgentFastLivenessTransition) {
  if (event.kind !== "confirmed-offline" || event.confirmedOffline !== true || !event.offlineAt) return;
  const hostId = Number(event.hostId || 0);
  const host = await db.getHostById(hostId);
  if (!host || !event.isCurrent()) return;

  await db.markHostOffline(hostId);
  if (!event.isCurrent()) {
    await restoreHostOnlineAfterStaleOfflineTransition(hostId);
    return;
  }

  await clearRuntimeStateForOfflineHost(hostId);
  await db.scheduleForwardGroupsForHostHealthChange(hostId);
  if (!event.isCurrent()) {
    await restoreHostOnlineAfterStaleOfflineTransition(hostId);
    return;
  }
  fastOfflineNotificationDebouncer.schedule(
    hostId,
    event.isCurrent,
    () => withKeyedTaskLock(`agent-liveness:${hostId}`, async () => {
      if (!event.isCurrent()) return;
      await notifyHostStatusChange(host, "offline");
    }),
  );
  console.info(`[HostStatus] Fast offline confirmed host=${hostId} silenceMs=${Math.max(0, event.offlineAt! - (event.lastSeenAt || event.offlineAt!))}`);
}

subscribeAgentFastLiveness((event) => {
  const hostId = Number(event.hostId || 0);
  if (!Number.isFinite(hostId) || hostId <= 0) return;
  // Cancel before entering the per-host transition queue. An online event can
  // otherwise wait behind offline persistence while its notification timer fires.
  if (event.kind === "activity-restored") fastOfflineNotificationDebouncer.cancel(hostId);
  // A host can recover while the previous offline transition is still doing
  // database or DDNS work. Keep all transitions for that host in event order;
  // the generation checks below then make stale work a no-op.
  void withKeyedTaskLock(`agent-liveness:${hostId}`, async () => {
    if (event.kind === "activity-restored") {
      for (let attempt = 0; attempt < FAST_LIVENESS_RETRY_DELAYS_MS.length; attempt += 1) {
        if (!event.isCurrent()) return;
        const delayMs = FAST_LIVENESS_RETRY_DELAYS_MS[attempt];
        if (delayMs > 0) await waitForRetry(delayMs);
        if (!event.isCurrent()) return;
        try {
          await handlePresenceCapableHostOnline(event);
          return;
        } catch (error) {
          const finalAttempt = attempt === FAST_LIVENESS_RETRY_DELAYS_MS.length - 1;
          console.warn(
            `[HostStatus] Fast online transition failed host=${hostId} attempt=${attempt + 1}/${FAST_LIVENESS_RETRY_DELAYS_MS.length}${finalAttempt ? " giving-up=true" : ""}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return;
    }

    for (let attempt = 0; attempt < FAST_LIVENESS_RETRY_DELAYS_MS.length; attempt += 1) {
      if (!event.isCurrent()) return;
      const delayMs = FAST_LIVENESS_RETRY_DELAYS_MS[attempt];
      if (delayMs > 0) await waitForRetry(delayMs);
      if (!event.isCurrent()) return;
      try {
        await handlePresenceCapableHostOffline(event);
        return;
      } catch (error) {
        const finalAttempt = attempt === FAST_LIVENESS_RETRY_DELAYS_MS.length - 1;
        console.warn(
          `[HostStatus] Fast offline transition failed host=${hostId} attempt=${attempt + 1}/${FAST_LIVENESS_RETRY_DELAYS_MS.length}${finalAttempt ? " giving-up=true" : ""}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }).catch((error) => {
    console.warn(`[HostStatus] Fast liveness transition queue failed host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
  });
});

export async function sweepOfflineHostsAndNotify() {
  if (!hostStatusNotifierPrimed) {
    await primeHostStatusNotifier();
    if (!hostStatusNotifierPrimed) return 0;
  }
  const candidates = await db.getStaleOnlineHosts();
  const { active, stale: staleHosts } = partitionHostsByRecentAgentActivity(candidates as any[]);
  if (active.length > 0) {
    await Promise.all(active.map(async (host: any) => {
      try {
        await db.touchHostHeartbeat(Number(host.id));
      } catch (error) {
        console.warn(`[HostStatus] Recent Agent activity heartbeat refresh failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
  if (staleHosts.length === 0) return 0;
  const transitionedIds = await db.markStaleHostsOffline((staleHosts as any[]).map((host) => Number(host.id)));
  if (transitionedIds.length === 0) return 0;
  const transitionedIdSet = new Set(transitionedIds);
  const transitionedHosts = (staleHosts as any[]).filter((host) => transitionedIdSet.has(Number(host.id)));
  for (const host of transitionedHosts) {
    await clearRuntimeStateForOfflineHost(Number(host.id));
    void db.scheduleForwardGroupsForHostHealthChange(Number(host.id)).catch((error) => {
      console.warn(`[HostStatus] Offline forward-group evaluation failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  await notifyHostStatusChanges(transitionedHosts, "offline");
  return transitionedHosts.length;
}
