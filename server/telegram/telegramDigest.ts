/*
  Telegram / Discord 日报摘要。
  2026-11-23 从 telegramBot.ts（6483 行）拆出；外部调用方仍从 telegramBot.ts 导入，那里原样转发。
*/
import { billingCalendarParts } from "../../shared/billingTime";
import { formatBytes } from "../../shared/formatBytes";
import { escapeHtmlText as escapeHtml } from "../../shared/htmlEscape";
import { isDigestDue } from "../../shared/opsDigest";
import * as db from "../db";
import { buildOpsDigestExtraLines, getDigestHour } from "../ops/digestContent";
import type { PendingReminder } from "../reminderDispatch";
import { dispatchReminders } from "../reminderDispatch";
import { isTelegramDigestEnabled, readTelegramNotifyPrefs } from "./telegramNotifyPrefs";
import { formatAgo, formatDate, shortText } from "./telegramText";
import { getTelegramSettings, sendTelegramMessage } from "./telegramTransport";
import { aiRuleTrafficSummaryMap, effectiveRuleStatusInfo, hostNeedsAgentUpgrade, offlineHostNamesByRule, sortHostsForTelegram, telegramHostState, visibleRulesForTelegramUser } from "./telegramViews";

function billingDateLabel(value: Date | number) {
  const parts = billingCalendarParts(value);
  return `${parts.month}月${parts.day}日`;
}

function billingDateKey(value: Date | number) {
  const parts = billingCalendarParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

async function last24hTrafficBytes(userId?: number) {
  const series = await db.getGlobalTrafficSeries({ bucketMinutes: 60, since: new Date(Date.now() - 24 * 3600_000), userId }).catch(() => [] as any[]);
  return (series as any[]).reduce((sum, point) => sum + Math.max(0, Number(point.bytesIn || 0)) + Math.max(0, Number(point.bytesOut || 0)), 0);
}

async function abnormalRulesForDigest(user: any) {
  const rules = (await visibleRulesForTelegramUser(user)).filter((rule: any) => !rule.routeParentRuleId);
  const summaries = await aiRuleTrafficSummaryMap(user, rules.map((rule: any) => Number(rule.id)), { includeLatency: true });
  const offlineNames = await offlineHostNamesByRule(rules);
  const abnormal = rules.filter((rule: any) => effectiveRuleStatusInfo(rule, summaries.get(Number(rule.id)), offlineNames.get(Number(rule.id))).kind === "abnormal");
  return { total: rules.length, abnormal, summaries, offlineNames };
}

function daysUntil(value: unknown, now = Date.now()) {
  if (!value) return null;
  const time = new Date(value as any).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.ceil((time - now) / 86400_000);
}

export async function buildTelegramDigestText(user: any, now = Date.now()) {
  const lines: string[] = [`<b>📰 NEX 每日简报</b> · ${billingDateLabel(now)}`, ""];
  const { total, abnormal, summaries, offlineNames } = await abnormalRulesForDigest(user);
  const abnormalLines = abnormal.slice(0, 5).map((rule: any) => `  · #${rule.id} ${escapeHtml(shortText(rule.name, 18))}：${escapeHtml(effectiveRuleStatusInfo(rule, summaries.get(Number(rule.id)), offlineNames.get(Number(rule.id))).label)}`);
  if (user.role === "admin") {
    const hosts = await db.getHosts() as any[];
    const online = hosts.filter((host) => telegramHostState(host) === "online").length;
    const offline = sortHostsForTelegram(hosts).filter((host) => telegramHostState(host) === "offline");
    lines.push(`🖥 主机：在线 <b>${online}</b> / ${hosts.length}`);
    if (offline.length > 0) {
      lines.push(`  离线：${offline.slice(0, 5).map((host) => `${escapeHtml(shortText(host.name || host.ip, 12))}（${escapeHtml(formatAgo(host.lastHeartbeat))}）`).join("、")}${offline.length > 5 ? ` 等 ${offline.length} 台` : ""}`);
    }
    const upgradable = hosts.filter(hostNeedsAgentUpgrade).length;
    if (upgradable > 0) lines.push(`  可升级 Agent：${upgradable} 台`);
    lines.push(`⚙️ 规则：共 ${total} 条${abnormal.length > 0 ? `，<b>异常 ${abnormal.length}</b> 条` : "，全部正常"}`, ...abnormalLines);
    if (abnormal.length > 5) lines.push(`  …其余 ${abnormal.length - 5} 条在面板里看`);
    lines.push(`📊 近 24 小时转发流量：<b>${escapeHtml(formatBytes(await last24hTrafficBytes()))}</b>`);
    const users = await db.getUserTrafficSummaries() as any[];
    const expiringUsers = users
      .filter((item) => item.role !== "admin" && item.accountEnabled !== false)
      .map((item) => ({ item, days: daysUntil(item.expiresAt, now) }))
      .filter((entry) => entry.days !== null && entry.days >= 0 && entry.days <= 7)
      .sort((a, b) => Number(a.days) - Number(b.days));
    const expiringHosts = hosts
      .map((host) => ({ host, days: daysUntil(host.stoppedAt, now) }))
      .filter((entry) => entry.days !== null && entry.days >= 0 && entry.days <= 7)
      .sort((a, b) => Number(a.days) - Number(b.days));
    if (expiringUsers.length + expiringHosts.length > 0) {
      lines.push("⏰ 7 天内到期：");
      for (const { item, days } of expiringUsers.slice(0, 5)) lines.push(`  · 用户 #${item.id} ${escapeHtml(shortText(item.name || item.username, 14))}：${days === 0 ? "今天" : `${days} 天后`}`);
      if (expiringUsers.length > 5) lines.push(`  · 其余 ${expiringUsers.length - 5} 个用户`);
      for (const { host, days } of expiringHosts.slice(0, 5)) lines.push(`  · 主机 #${host.id} ${escapeHtml(shortText(host.name || host.ip, 14))}：${days === 0 ? "今天" : `${days} 天后`}`);
      if (expiringHosts.length > 5) lines.push(`  · 其余 ${expiringHosts.length - 5} 台主机`);
    } else {
      lines.push("⏰ 7 天内没有到期的用户和主机");
    }
    lines.push(...await buildOpsDigestExtraLines(now)); // 设置里勾选的可选内容块（默认一块都没有）
    return lines.join("\n");
  }
  const fresh = await db.getUserById(Number(user.id)) as any || user;
  const limit = Number(fresh.trafficLimit) || 0;
  const used = Number(fresh.trafficUsed) || 0;
  lines.push(`📊 流量：已用 <b>${escapeHtml(formatBytes(used))}</b>${limit > 0 ? ` / ${escapeHtml(formatBytes(limit))}（${Math.min(100, Math.round((used / limit) * 100))}%）` : "（不限）"}`);
  lines.push(`  近 24 小时：${escapeHtml(formatBytes(await last24hTrafficBytes(Number(user.id))))}`);
  lines.push(`⚙️ 规则：共 ${total} 条${abnormal.length > 0 ? `，<b>异常 ${abnormal.length}</b> 条` : "，全部正常"}`, ...abnormalLines);
  const days = daysUntil(fresh.expiresAt, now);
  lines.push(days === null ? "⏰ 套餐：长期有效" : days < 0 ? "⏰ 套餐：<b>已到期</b>" : `⏰ 套餐：${escapeHtml(formatDate(fresh.expiresAt))} 到期（还有 ${days} 天）`);
  return lines.join("\n");
}

/**
 * 每天设定的钟点（北京时间，默认 9 点，设置 › Telegram 里可改）发一次。调度每十分钟看一眼，过了钟点就把今天还没发的发掉；
 * 去重键带北京日期、走提醒同一套 dispatchReminders，面板重启也不会重发。
 */
export async function runTelegramDigests(now = Date.now()) {
  const settings = await getTelegramSettings();
  if (!settings.enabled || !settings.token) return 0;
  if (!isDigestDue(billingCalendarParts(now).hour, await getDigestHour())) return 0;
  const prefs = await readTelegramNotifyPrefs();
  const users = (await db.getUserTrafficSummaries() as any[])
    .filter((user) => !!user.telegramId && user.accountEnabled !== false && isTelegramDigestEnabled(prefs, user));
  if (users.length === 0) return 0;
  const dateKey = billingDateKey(now);
  const pending: PendingReminder[] = users.map((summary) => ({
    key: `telegramReminder:digest:${summary.id}:${dateKey}`,
    send: async () => {
      const user = await db.getUserById(Number(summary.id)) as any;
      if (!user?.telegramId || user.accountEnabled === false) return;
      await sendTelegramMessage(user.telegramId, await buildTelegramDigestText(user, now));
    },
  }));
  return dispatchReminders(pending);
}

/**
 * 每日简报的 Discord 那一份：同一个钟点、同一份内容、同一个「每日简报」开关（Telegram 和 Discord 共用），
 * 发给绑定了 Discord 的人。去重键前缀不同，两边各发一次。
 */
export async function runDiscordDigests(now = Date.now()) {
  const { discordNotifier } = await import("../discord/discordNotify");
  if (!(await discordNotifier.isReady())) return 0;
  if (!isDigestDue(billingCalendarParts(now).hour, await getDigestHour())) return 0;
  const prefs = await readTelegramNotifyPrefs();
  const users = (await db.getUserTrafficSummaries() as any[])
    .filter((user) => !!user.discordId && user.accountEnabled !== false && isTelegramDigestEnabled(prefs, user));
  if (users.length === 0) return 0;
  const dateKey = billingDateKey(now);
  const pending: PendingReminder[] = users.map((summary) => ({
    key: `discordReminder:digest:${summary.id}:${dateKey}`,
    send: async () => {
      const user = await db.getUserById(Number(summary.id)) as any;
      if (!user?.discordId || user.accountEnabled === false) return;
      await discordNotifier.sendReminder(user, await buildTelegramDigestText(user, now), "digest");
    },
  }));
  return dispatchReminders(pending);
}
