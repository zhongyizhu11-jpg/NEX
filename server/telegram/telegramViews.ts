/*
  Telegram 机器人：取数与视图 —— 用户能看到哪些规则 / 主机 / 隧道，列表与详情的文本和键盘。
  2026-11-23 从 telegramBot.ts（6483 行）拆出；外部调用方仍从 telegramBot.ts 导入，那里原样转发。
*/
import { describeFailoverActiveLine } from "../../shared/failoverActiveLine";
import { formatBytes } from "../../shared/formatBytes";
import { formatForwardRuleProtocol } from "../../shared/forwardTypes";
import { fxpRuntimeStatus } from "../../shared/fxpRuntime";
import { escapeHtmlText as escapeHtml } from "../../shared/htmlEscape";
import { isLinkProbeFresh } from "../../shared/linkProbePolicy";
import { PROBE_FAILURE_LABELS, normalizeProbeFailure } from "../../shared/probeFailure";
import { ROUTE_MODE_INFO, routeGroupOf, routePathLabel, routePathLetter } from "../../shared/routeGroup";
import { PIN_DURATION_OPTIONS, pinUntilSeconds } from "../../shared/routePolicy";
import { AGENT_VERSION } from "../../shared/versions";
import { isAgentVersionAtLeast, isHostAgentUpgradeUnnecessary } from "../agentRouteUtils";
import * as db from "../db";
import { gateForwardRulesForUserSurface } from "../forwardRuleVisibility";
import { isHostConsideredOnline } from "../hostHeartbeatPolicy";
import { canUseForwardRuleResource, getLinkAccessScope } from "../linkAccessView";
import { RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON } from "../ruleResourceAuthorization";
import { telegramHostExtraRows, telegramHostsExtraRows, telegramMenuExtraRow, telegramRuleExtraRows, telegramUserExtraRows } from "./telegramBotMore";
import { HOST_PAGE_SIZE, ROUTE_PAGE_SIZE, RULE_PAGE_SIZE, UPDATE_ACTION_CONFIRM_TTL_MS, clampPage, formatAgo, formatDate, formatPercent, formatPinUntil, formatRuleButtonLabel, formatSpeed, formatUptime, normalizeKeyword, randomCode, shortText } from "./telegramText";
import { telegramRulesCaller } from "./telegramTransport";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./telegramTransport";

export type AiRuleStatusFilter = "running" | "pending" | "disabled" | "abnormal";

export type UpdateCommandKind = "panel" | "agent";

export type PendingUpdateAction = {
  key: string;
  actorUserId: number;
  kind: UpdateCommandKind;
  targetVersion?: string;
  hostIds?: number[];
  createdAt: number;
  expiresAt: number;
};

export const pendingUpdateActions = new Map<string, PendingUpdateAction>();

export function cleanupExpiredPendingUpdateActions() {
  const now = Date.now();
  for (const [key, item] of pendingUpdateActions.entries()) {
    if (!item.expiresAt || item.expiresAt <= now) pendingUpdateActions.delete(key);
  }
}

export function createPendingUpdateAction(action: Omit<PendingUpdateAction, "key" | "createdAt" | "expiresAt">) {
  cleanupExpiredPendingUpdateActions();
  const now = Date.now();
  const key = randomCode(18).toLowerCase();
  const pending: PendingUpdateAction = {
    ...action,
    key,
    createdAt: now,
    expiresAt: now + UPDATE_ACTION_CONFIRM_TTL_MS,
  };
  pendingUpdateActions.set(key, pending);
  return pending;
}

export function buildTelegramWebAppUrl(panelPublicUrl: string, challenge?: string) {
  const base = String(panelPublicUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const params = new URLSearchParams({ tgWebApp: "1" });
  const normalizedChallenge = String(challenge || "").trim().toLowerCase();
  if (normalizedChallenge) params.set("wa", normalizedChallenge);
  return `${base}/login?${params.toString()}`;
}

/**
 * Telegram 的 Web App 按钮只接受 https 地址。面板地址是 http（比如 http://IP:端口）时，
 * 带 web_app 的键盘整条被拒（Bad Request: ... Only HTTPS links are allowed），连菜单都发不出来
 * —— 2026-10-09 用户点「返回菜单」就是这样失败的。http 面板退成普通链接按钮（在浏览器打开）。
 */
function isTelegramWebAppUrl(url: string) {
  return /^https:\/\//i.test(String(url || "").trim());
}

export function panelButton(text: string, url: string): InlineKeyboardButton {
  return isTelegramWebAppUrl(url) ? { text, web_app: { url } } : { text, url };
}

export function webAppOpenKeyboard(url: string): InlineKeyboardMarkup {
  if (!isTelegramWebAppUrl(url)) {
    return { inline_keyboard: [[{ text: "🔗 在浏览器打开面板", url }]] };
  }
  return {
    inline_keyboard: [
      [
        { text: "🌐 打开面板", web_app: { url } },
        { text: "🔗 浏览器", url },
      ],
    ],
  };
}

export function mainMenuKeyboard(user: any, webAppUrl?: string): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [
      { text: "👤 账户", callback_data: "fx:user" },
      { text: "📊 流量", callback_data: "fx:usage" },
      { text: "⚙️ 规则", callback_data: "fx:rules" },
    ],
    [
      { text: "🖥 主机", callback_data: "fx:hosts:0" },
      { text: "🔀 线路组", callback_data: "fx:routes:0" },
      { text: "🔔 通知", callback_data: "fx:notify" },
    ],
  ];
  // 2.3.538：链路（所有人）+ 系统（管理员）/ 续费（普通用户），见 telegramBotMore.ts
  rows.push(telegramMenuExtraRow(user));
  const secondaryRow: InlineKeyboardButton[] = [];
  if (user?.role === "admin") {
    secondaryRow.push({ text: "👥 用户", callback_data: "fx:users:0" });
  } else {
    secondaryRow.push({ text: "🎟 兑换", callback_data: "fx:redeem" });
  }
  if (webAppUrl) {
    secondaryRow.push(panelButton("🌐 面板", webAppUrl));
  }
  rows.push(secondaryRow);
  return { inline_keyboard: rows };
}

export function backMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

export function updateActionConfirmKeyboard(kind: UpdateCommandKind, actionKey: string): InlineKeyboardMarkup {
  const confirmText = kind === "panel" ? "✅ 确认更新面板" : "✅ 确认更新 Agent";
  return {
    inline_keyboard: [
      [
        { text: confirmText, callback_data: `fx:update:${kind}:confirm:${actionKey}` },
        { text: "❌ 取消", callback_data: `fx:update:${kind}:cancel:${actionKey}` },
      ],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

export function ruleListBackKeyboard(page = 0): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "⚙️ 返回规则列表", callback_data: `fx:rules:${page}` }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

export async function rulesView(user: any, page = 0) {
  const rules = await visibleRulesForTelegramUser(user);
  const { page: safePage, totalPages } = clampPage(page, rules.length, RULE_PAGE_SIZE);
  const visible = rules.slice(safePage * RULE_PAGE_SIZE, safePage * RULE_PAGE_SIZE + RULE_PAGE_SIZE);
  const trafficByRuleId = visible.length > 0
    ? await aiRuleTrafficSummaryMap(user, visible.map((rule: any) => Number(rule.id)), { includeLatency: true })
    : new Map<number, AiRuleTrafficSummary>();
  const text = visible.length === 0
    ? "<b>转发规则</b>\n\n暂无转发规则。"
    : [
        "<b>转发规则</b>",
        `第 ${safePage + 1}/${totalPages} 页，共 ${rules.length} 条`,
        "",
        ...visible.map((rule: any) => {
          const status = effectiveRuleStatusText(rule, trafficByRuleId.get(Number(rule.id)));
          return `#${rule.id} <b>${escapeHtml(shortText(rule.name, 24))}</b>\n${status} · ${escapeHtml(rule.forwardType)} ${escapeHtml(formatForwardRuleProtocol(rule.protocol))} · :${rule.sourcePort}`;
        }),
      ].join("\n\n");
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const rule of visible) {
    const label = formatRuleButtonLabel(rule);
    rows.push([
      { text: `${rule.isEnabled ? "⛔ 停用" : "✅ 启用"} ${label}`, callback_data: `fx:rule:toggle:${rule.id}:${safePage}` },
      { text: `📄 详情 ${label}`, callback_data: `fx:rule:view:${rule.id}:${safePage}` },
    ]);
  }
  if (totalPages > 1) {
    rows.push([
      { text: "⬅️ 上一页", callback_data: `fx:rules:${Math.max(0, safePage - 1)}` },
      { text: "➡️ 下一页", callback_data: `fx:rules:${Math.min(totalPages - 1, safePage + 1)}` },
    ]);
  }
  rows.push([{ text: "🏠 返回菜单", callback_data: "fx:menu" }]);
  return { text, keyboard: { inline_keyboard: rows } };
}

export async function ruleDetailText(ruleId: number, user: any) {
  const rule = (await visibleRulesForTelegramUser(user)).find((item: any) => Number(item.id) === Number(ruleId));
  if (!rule || (user.role !== "admin" && rule.userId !== user.id)) return "规则不存在或无权查看。";
  const traffic = (await aiRuleTrafficSummaryMap(user, [Number(rule.id)], { includeLatency: true })).get(Number(rule.id));
  const offlineNames = (await offlineHostNamesByRule([rule])).get(Number(rule.id));
  const statusInfo = effectiveRuleStatusInfo(rule, traffic, offlineNames);
  const status = effectiveRuleStatusText(rule, traffic, offlineNames);
  return [
    `<b>规则 #${rule.id}</b>`,
    "",
    `名称：${escapeHtml(rule.name)}`,
    `状态：${status}`,
    statusInfo.detail ? `说明：${escapeHtml(statusInfo.detail)}` : "",
    `类型：${escapeHtml(rule.forwardType)} / ${escapeHtml(formatForwardRuleProtocol(rule.protocol))}`,
    `入口端口：${rule.sourcePort}`,
    `目标：${escapeHtml(rule.targetIp)}:${rule.targetPort}`,
    `主机 ID：${rule.hostId}`,
    rule.tunnelId ? `隧道 ID：${rule.tunnelId}` : "",
  ].filter(Boolean).join("\n");
}

export async function adminUserText(userId: number) {
  const target = await db.getUserById(userId);
  if (!target) return { target: null, text: "用户不存在。" };
  const [ruleCount, portCount] = await Promise.all([
    db.getUserRuleCount(target.id),
    db.getUserPortCount(target.id),
  ]);
  const limit = Number(target.trafficLimit) || 0;
  const used = Number(target.trafficUsed) || 0;
  const remaining = limit > 0 ? Math.max(0, limit - used) : null;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const text = [
    `<b>管理用户 #${target.id}</b>`,
    "",
    `账户：${escapeHtml(target.name || target.username)}`,
    `用户名：${escapeHtml(target.username)}`,
    `角色：${target.role === "admin" ? "管理员" : "用户"}`,
    `转发权限：${target.role === "admin" || target.canAddRules ? "已启用" : "已停用"}`,
    `已用流量：${escapeHtml(formatBytes(used))}`,
    `流量额度：${limit > 0 ? escapeHtml(formatBytes(limit)) : "不限"}`,
    `剩余流量：${remaining === null ? "不限" : escapeHtml(formatBytes(remaining))}`,
    limit > 0 ? `使用率：${percent}%` : "",
    `到期时间：${escapeHtml(formatDate(target.expiresAt))}`,
    `规则/端口：${ruleCount}${target.maxRules ? `/${target.maxRules}` : ""} 条，${portCount}${target.maxPorts ? `/${target.maxPorts}` : ""} 个端口`,
    `TG：${target.telegramId ? (target.telegramUsername ? `@${escapeHtml(target.telegramUsername)}` : target.telegramId) : "未绑定"}`,
  ].filter(Boolean).join("\n");
  return { target, text };
}

export async function adminUserKeyboard(userId: number, page = 0): Promise<InlineKeyboardMarkup> {
  const target = await db.getUserById(userId);
  const accessEnabled = !!target && (target.role === "admin" || target.canAddRules);
  return {
    inline_keyboard: [
      [
        { text: "🔄 重置流量", callback_data: `fx:admin:reset:${userId}:${page}` },
        { text: accessEnabled ? "⛔ 停用转发" : "✅ 启用转发", callback_data: `fx:admin:access:${userId}:${accessEnabled ? "0" : "1"}:${page}` },
      ],
      [{ text: "📆 续期 1 个月", callback_data: `fx:admin:renew:${userId}:${page}` }],
      ...telegramUserExtraRows(target, page),
      [{ text: "🔄 刷新详情", callback_data: `fx:admin:user:${userId}:${page}` }],
      [{ text: "👥 返回用户列表", callback_data: `fx:users:${page}` }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

/** 文字进度条：十格，满格按 100%。 */
function telegramMeter(percent: unknown) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return "";
  const filled = Math.max(0, Math.min(10, Math.round(value / 10)));
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)}`;
}

type TelegramHostState = "online" | "offline" | "unknown";

export function telegramHostState(host: any): TelegramHostState {
  if (!host?.lastHeartbeat) return "unknown";
  return isHostConsideredOnline(host) ? "online" : "offline";
}

function hostStateMark(state: TelegramHostState) {
  return state === "online" ? "🟢" : state === "offline" ? "🔴" : "⚪";
}

export function hostNeedsAgentUpgrade(host: any) {
  const current = String(host?.agentVersion || "").trim();
  if (!current) return false;
  const target = String(AGENT_VERSION || "").trim();
  if (!target) return false;
  return !isHostAgentUpgradeUnnecessary(host, target, AGENT_VERSION);
}

/** 「可升级」后面那半句：版本落后说目标版本；版本已是最新、只是 FXP 旧了，说 FXP。 */
function agentUpgradeNote(host: any) {
  const current = String(host?.agentVersion || "").trim();
  const target = String(AGENT_VERSION || "").trim();
  if (current && target && isAgentVersionAtLeast(current, target)) {
    return `FXP ${fxpRuntimeStatus(host).label}，重装 Agent 可修复`;
  }
  return `可升级到 v${target}`;
}

/** 掉线的排最前：打开这一页通常是为了找出问题机器。 */
export function sortHostsForTelegram(hosts: any[]) {
  const rank = (host: any) => (telegramHostState(host) === "offline" ? 0 : telegramHostState(host) === "unknown" ? 2 : 1);
  return [...hosts].sort((a, b) => rank(a) - rank(b)
    || Number(a?.sortOrder || 0) - Number(b?.sortOrder || 0)
    || Number(a?.id || 0) - Number(b?.id || 0));
}

/** 普通用户只看得到自己名下机器的负载；被授权使用的别人的机器只给在线状态。 */
function canSeeHostMetrics(user: any, host: any) {
  return user?.role === "admin" || Number(host?.userId) === Number(user?.id);
}

export async function hostsView(user: any, page = 0) {
  const hosts = sortHostsForTelegram(await visibleHostsForTelegramUser(user));
  const { page: safePage, totalPages } = clampPage(page, hosts.length, HOST_PAGE_SIZE);
  const visible = hosts.slice(safePage * HOST_PAGE_SIZE, safePage * HOST_PAGE_SIZE + HOST_PAGE_SIZE);
  const metricRows = await db.getLatestHostMetricRows(
    visible.filter((host) => canSeeHostMetrics(user, host)).map((host) => Number(host.id)),
  ).catch(() => [] as any[]);
  const metricsByHost = new Map((metricRows as any[]).map((row) => [Number(row.hostId), row]));
  const online = hosts.filter((host) => telegramHostState(host) === "online").length;
  const offline = hosts.filter((host) => telegramHostState(host) === "offline").length;
  const lines = visible.map((host: any) => {
    const state = telegramHostState(host);
    const name = `#${host.id} <b>${escapeHtml(shortText(host.name || host.ip, 20))}</b>`;
    if (state !== "online") {
      return `${hostStateMark(state)} ${name}\n${state === "offline" ? `离线 · 最后心跳 ${escapeHtml(formatAgo(host.lastHeartbeat))}` : "还没有上报过"}`;
    }
    const metric = metricsByHost.get(Number(host.id));
    const load = metric
      ? `CPU ${formatPercent(metric.cpuUsage)} · 内存 ${formatPercent(metric.memoryUsage)} · 磁盘 ${formatPercent(metric.diskUsage)}`
      : "在线";
    const upgrade = user.role === "admin" && hostNeedsAgentUpgrade(host) ? " · 可升级" : "";
    return `${hostStateMark(state)} ${name}\n${load}${upgrade}`;
  });
  const text = hosts.length === 0
    ? "<b>主机</b>\n\n暂无可查看的主机。"
    : [
        `<b>主机</b> · 在线 ${online} / ${hosts.length}${offline > 0 ? ` · 离线 ${offline}` : ""}`,
        totalPages > 1 ? `第 ${safePage + 1}/${totalPages} 页` : "",
        "",
        lines.join("\n\n"),
      ].filter((line, index) => index !== 1 || line).join("\n");
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  let row: InlineKeyboardButton[] = [];
  for (const host of visible) {
    row.push({ text: `${hostStateMark(telegramHostState(host))} ${shortText(host.name || host.ip, 12)}`, callback_data: `fx:host:${host.id}:${safePage}` });
    if (row.length >= 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  if (totalPages > 1) {
    rows.push([
      { text: "⬅️ 上一页", callback_data: `fx:hosts:${Math.max(0, safePage - 1)}` },
      { text: "➡️ 下一页", callback_data: `fx:hosts:${Math.min(totalPages - 1, safePage + 1)}` },
    ]);
  }
  rows.push(...telegramHostsExtraRows(user));
  rows.push([{ text: "🔄 刷新", callback_data: `fx:hosts:${safePage}` }, { text: "🏠 返回菜单", callback_data: "fx:menu" }]);
  return { text, keyboard: { inline_keyboard: rows } as InlineKeyboardMarkup };
}

export async function hostDetailView(user: any, hostId: number, page = 0) {
  const host = (await visibleHostsForTelegramUser(user)).find((item: any) => Number(item.id) === Number(hostId));
  const back: InlineKeyboardMarkup = {
    inline_keyboard: [
      [{ text: "🖥 返回主机列表", callback_data: `fx:hosts:${page}` }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
  if (!host) return { text: "主机不存在或无权查看。", keyboard: back };
  const state = telegramHostState(host);
  const showMetrics = canSeeHostMetrics(user, host);
  const metric = showMetrics
    ? ((await db.getLatestHostMetricRows([Number(host.id)]).catch(() => [] as any[])) as any[])[0]
    : null;
  const region = [host.geoEmoji, host.geoRegion || host.geoCountryName].filter(Boolean).join(" ");
  const meterLine = (label: string, value: unknown, extra = "") => (Number.isFinite(Number(value))
    ? `${label} ${telegramMeter(value)} ${formatPercent(value)}${extra}`
    : `${label} -`);
  const upgradable = user.role === "admin" && hostNeedsAgentUpgrade(host);
  const lines = [
    `<b>${hostStateMark(state)} ${escapeHtml(host.name || host.ip)}</b> #${host.id}`,
    "",
    `状态：${state === "online" ? "在线" : state === "offline" ? "离线" : "未上报"}${state !== "online" && host.lastHeartbeat ? ` · 最后心跳 ${escapeHtml(formatAgo(host.lastHeartbeat))}` : ""}`,
    region ? `地区：${escapeHtml(region)}` : "",
    `地址：<code>${escapeHtml(host.ip || host.ipv4 || host.ipv6 || "-")}</code>`,
    host.osInfo ? `系统：${escapeHtml(shortText(host.osInfo, 40))}` : "",
  ];
  if (metric && state === "online") {
    const memoryExtra = Number(metric.memoryUsed) > 0 && Number(host.memoryTotal) > 0
      ? `（${escapeHtml(formatBytes(metric.memoryUsed))} / ${escapeHtml(formatBytes(host.memoryTotal))}）`
      : "";
    const diskExtra = Number(metric.diskUsed) > 0 && Number(metric.diskTotal) > 0
      ? `（${escapeHtml(formatBytes(metric.diskUsed))} / ${escapeHtml(formatBytes(metric.diskTotal))}）`
      : "";
    lines.push(
      "",
      `<code>${meterLine("CPU ", metric.cpuUsage)}</code>`,
      `<code>${meterLine("内存", metric.memoryUsage)}</code>${memoryExtra}`,
      `<code>${meterLine("磁盘", metric.diskUsage)}</code>${diskExtra}`,
      `网速：↓ ${escapeHtml(formatSpeed(metric.networkSpeedIn))} · ↑ ${escapeHtml(formatSpeed(metric.networkSpeedOut))}`,
      formatUptime(metric.uptime) ? `已运行：${escapeHtml(formatUptime(metric.uptime))}` : "",
    );
  }
  if (user.role === "admin") {
    lines.push(
      "",
      `Agent：${host.agentVersion ? `v${escapeHtml(host.agentVersion)}` : "未知"}${upgradable ? ` · ${escapeHtml(agentUpgradeNote(host))}` : ""}`,
    );
  }
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (upgradable) rows.push([{ text: "⬆️ 升级这台的 Agent", callback_data: `fx:host:upgrade:${host.id}:${page}` }]);
  rows.push(...telegramHostExtraRows(user, host, page));
  rows.push([{ text: "🔄 刷新", callback_data: `fx:host:${host.id}:${page}` }, { text: "🖥 返回列表", callback_data: `fx:hosts:${page}` }]);
  rows.push([{ text: "🏠 返回菜单", callback_data: "fx:menu" }]);
  return { text: lines.filter((line) => line !== "").join("\n").replace(/\n(?=<code>CPU)/, "\n\n").replace(/\n(?=Agent：)/, "\n\n"), keyboard: { inline_keyboard: rows } };
}

/** 单台升级：走 /updateagent 同一个确认流程，只是名单里只有这一台。 */
export async function hostUpgradeConfirm(user: any, hostId: number) {
  const host = await db.getHostById(hostId) as any;
  if (!host) return { text: "主机不存在。", keyboard: backMenuKeyboard() };
  if (!hostNeedsAgentUpgrade(host)) {
    return { text: `#${host.id} ${escapeHtml(host.name || host.ip)} 的 Agent 已是最新。`, keyboard: backMenuKeyboard() };
  }
  const targetVersion = String(AGENT_VERSION || "").trim();
  const pending = createPendingUpdateAction({ actorUserId: Number(user.id), kind: "agent", targetVersion, hostIds: [Number(host.id)] });
  return {
    text: [
      "<b>升级 Agent</b>",
      "",
      `主机：#${host.id} ${escapeHtml(host.name || host.ip)}`,
      `版本：v${escapeHtml(host.agentVersion || "未知")} → <b>v${escapeHtml(targetVersion)}</b>`,
      isAgentVersionAtLeast(String(host.agentVersion || ""), targetVersion) ? escapeHtml(agentUpgradeNote(host)) : "",
      "",
      "升级时这台机器上的转发会短暂中断几秒。",
      `请在 ${Math.round(UPDATE_ACTION_CONFIRM_TTL_MS / 60000)} 分钟内确认。`,
    ].filter(Boolean).join("\n"),
    keyboard: updateActionConfirmKeyboard("agent", pending.key),
  };
}

export function ruleDetailKeyboard(rule: any, page = 0): InlineKeyboardMarkup {
  const first: InlineKeyboardButton[] = [{ text: "⚡ 测延迟", callback_data: `fx:rule:test:${rule.id}:${page}` }];
  if (rule && routeGroupOf(rule)) first.push({ text: "🔀 线路组", callback_data: `fx:route:${rule.id}:0` });
  return {
    inline_keyboard: [
      first,
      ...telegramRuleExtraRows(rule, page),
      [{ text: "⚙️ 返回规则列表", callback_data: `fx:rules:${page}` }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

export function ruleTestKeyboard(ruleId: number, page = 0, pending = false): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [pending
        ? { text: "🔄 查看结果", callback_data: `fx:rule:testres:${ruleId}:${page}` }
        : { text: "🔁 再测一次", callback_data: `fx:rule:test:${ruleId}:${page}` }],
      [{ text: "📄 返回规则详情", callback_data: `fx:rule:view:${ruleId}:${page}` }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

export async function visibleRuleForTelegram(user: any, ruleId: number) {
  return (await visibleRulesForTelegramUser(user)).find((item: any) => Number(item.id) === Number(ruleId)) || null;
}

async function routeRulesForTelegram(user: any) {
  return (await visibleRulesForTelegramUser(user)).filter((rule: any) => !rule.routeParentRuleId && !!routeGroupOf(rule));
}

export async function routesView(user: any, page = 0) {
  const rules = await routeRulesForTelegram(user);
  const { page: safePage, totalPages } = clampPage(page, rules.length, ROUTE_PAGE_SIZE);
  const visible = rules.slice(safePage * ROUTE_PAGE_SIZE, safePage * ROUTE_PAGE_SIZE + ROUTE_PAGE_SIZE);
  const lines = visible.map((rule: any) => {
    const group = routeGroupOf(rule)!;
    const active = describeFailoverActiveLine(rule);
    const activeIndex = active ? active.index : 0;
    const path = group.paths[activeIndex];
    const pinned = group.policy.pin && group.policy.mode !== "manual" ? " · 人工指定" : "";
    return `#${rule.id} <b>${escapeHtml(shortText(rule.name, 22))}</b>\n${escapeHtml(ROUTE_MODE_INFO[group.policy.mode].label)} · 当前 ${routePathLetter(activeIndex)} ${escapeHtml(shortText(routePathLabel(path, activeIndex), 14))}${pinned}`;
  });
  const text = rules.length === 0
    ? "<b>线路组</b>\n\n还没有开了线路组（主备）的规则。可以在面板的规则里添加备用线路。"
    : [`<b>线路组</b> · 共 ${rules.length} 组${totalPages > 1 ? ` · 第 ${safePage + 1}/${totalPages} 页` : ""}`, "", lines.join("\n\n")].join("\n");
  const rows: InlineKeyboardMarkup["inline_keyboard"] = visible.map((rule: any) => [
    { text: `🔀 #${rule.id} ${shortText(rule.name, 18)}`, callback_data: `fx:route:${rule.id}:${safePage}` },
  ]);
  if (totalPages > 1) {
    rows.push([
      { text: "⬅️ 上一页", callback_data: `fx:routes:${Math.max(0, safePage - 1)}` },
      { text: "➡️ 下一页", callback_data: `fx:routes:${Math.min(totalPages - 1, safePage + 1)}` },
    ]);
  }
  rows.push([{ text: "🏠 返回菜单", callback_data: "fx:menu" }]);
  return { text, keyboard: { inline_keyboard: rows } as InlineKeyboardMarkup };
}

export async function routeView(user: any, ruleId: number, page = 0, notice = "") {
  const back: InlineKeyboardMarkup = {
    inline_keyboard: [
      [{ text: "🔀 返回线路组列表", callback_data: `fx:routes:${page}` }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
  let status: any = null;
  try {
    status = await (await telegramRulesCaller(user)).routeStatus({ ruleId });
  } catch (error) {
    return { text: escapeHtml(error instanceof Error ? error.message : String(error)), keyboard: back };
  }
  const rule = await visibleRuleForTelegram(user, ruleId);
  if (!status || !rule) return { text: "这条规则没有开线路组。", keyboard: back };
  const policy = status.policy;
  const mode = String(policy?.mode || "failover") as keyof typeof ROUTE_MODE_INFO;
  const pin = policy?.pin && mode !== "manual" ? policy.pin : null;
  const lines = [
    `<b>🔀 线路组 · #${rule.id}</b> ${escapeHtml(shortText(rule.name, 24))}`,
    notice ? `\n${notice}` : "",
    "",
    `策略：${escapeHtml(ROUTE_MODE_INFO[mode]?.label || mode)}`,
    pin ? `人工指定：${routePathLetter(Number(pin.index))}，${escapeHtml(formatPinUntil(pin.untilMs))}` : "",
    status.agentStale ? "⚠️ 调度机最近没有上报，下面的评分可能是旧的。" : "",
    "",
    ...(status.paths as any[]).map((path: any) => {
      const metrics = [
        typeof path.score === "number" ? `评分 ${path.score}` : "",
        typeof path.latencyMs === "number" ? `${Math.round(path.latencyMs)} ms` : "",
        typeof path.lossPct === "number" ? `丢包 ${Math.round(path.lossPct * 10) / 10}%` : "",
      ].filter(Boolean).join(" · ");
      const mark = path.active ? "▶" : path.down ? "✖" : "·";
      return [
        `${mark} <b>${path.letter} ${escapeHtml(shortText(path.name, 16))}</b>${path.active ? "（当前）" : ""}`,
        metrics ? `  ${escapeHtml(metrics)}` : "",
        path.down ? `  ❌ ${escapeHtml(shortText(path.downReason || "不可用", 50))}` : "",
      ].filter(Boolean).join("\n");
    }),
  ];
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (mode !== "weighted") {
    let row: InlineKeyboardButton[] = [];
    for (const path of status.paths as any[]) {
      if (path.active && !pin && mode !== "manual") continue;
      if (pin && Number(pin.index) === Number(path.index)) continue;
      if (mode === "manual" && path.active) continue;
      row.push({ text: `改走 ${path.letter} ${shortText(path.name, 8)}`, callback_data: `fx:route:pick:${rule.id}:${path.index}:${page}` });
      if (row.length >= 2) {
        rows.push(row);
        row = [];
      }
    }
    if (row.length > 0) rows.push(row);
    if (pin) rows.push([{ text: "🤖 交回自动", callback_data: `fx:route:auto:${rule.id}:${page}` }]);
  }
  rows.push([{ text: "🔄 刷新", callback_data: `fx:route:${rule.id}:${page}` }, { text: "🔀 返回列表", callback_data: `fx:routes:${page}` }]);
  rows.push([{ text: "🏠 返回菜单", callback_data: "fx:menu" }]);
  const text = lines.filter((line, index) => line !== "" || index === 2 || index === 6).join("\n").replace(/\n{3,}/g, "\n\n");
  return { text, keyboard: { inline_keyboard: rows } as InlineKeyboardMarkup };
}

function routePinDurationKeyboard(ruleId: number, index: number, page: number): InlineKeyboardMarkup {
  const options = PIN_DURATION_OPTIONS.map((option, optionIndex) => ({
    text: option.seconds === null ? "一直走它" : option.label,
    callback_data: `fx:route:pin:${ruleId}:${index}:${optionIndex}:${page}`,
  }));
  return {
    inline_keyboard: [
      options.slice(0, 2),
      options.slice(2, 4),
      options.slice(4),
      [{ text: "❌ 取消", callback_data: `fx:route:${ruleId}:${page}` }],
    ].filter((row) => row.length > 0),
  };
}

export async function routePickView(user: any, ruleId: number, index: number, page: number) {
  const rule = await visibleRuleForTelegram(user, ruleId);
  const group = rule ? routeGroupOf(rule) : null;
  if (!rule || !group || !group.paths[index]) return routeView(user, ruleId, page, "那条路径已经不存在了。");
  const label = `${routePathLetter(index)} ${escapeHtml(routePathLabel(group.paths[index], index))}`;
  if (group.policy.mode === "manual") {
    // 手动主备本来就是「一直走指定的那条」，不问期限，直接换。
    return routePinApply(user, ruleId, index, null, page);
  }
  return {
    text: [
      `<b>改走 ${label}</b>`,
      "",
      "压过时段表和评分，到点自动交回。它要是挂了，仍然会往下切，不会守着一条断掉的路。",
      "",
      "改走多久？",
    ].join("\n"),
    keyboard: routePinDurationKeyboard(ruleId, index, page),
  };
}

export async function routePinApply(user: any, ruleId: number, index: number | null, durationSeconds: number | null, page: number) {
  const caller = await telegramRulesCaller(user);
  try {
    await caller.update({
      id: ruleId,
      failoverPinnedIndex: index,
      failoverPinnedUntil: index === null ? null : pinUntilSeconds(durationSeconds),
    });
  } catch (error) {
    return routeView(user, ruleId, page, `⚠️ 没改成：${escapeHtml(error instanceof Error ? error.message : String(error))}`);
  }
  const notice = index === null ? "✅ 已交回自动。" : `✅ 已改走 ${routePathLetter(index)}，几秒内生效。`;
  return routeView(user, ruleId, page, notice);
}

async function attachForwardGroupModes(rules: any[]) {
  const groupIds = Array.from(new Set(
    rules
      .map((rule: any) => Number(rule?.forwardGroupId || 0))
      .filter((id: number) => Number.isFinite(id) && id > 0),
  ));
  if (groupIds.length === 0) return rules;
  const modeRows = await db.getForwardGroupModesByIds(groupIds);
  const modeById = new Map((modeRows as any[]).map((row: any) => [Number(row.id), String(row.groupMode || "failover")]));
  return rules.map((rule: any) => {
    const groupId = Number(rule?.forwardGroupId || 0);
    return groupId > 0 ? { ...rule, forwardGroupMode: modeById.get(groupId) || null } : rule;
  });
}

export async function visibleRulesForTelegramUser(user: any) {
  const isAdmin = user.role === "admin";
  const rules = await attachForwardGroupModes(await db.getForwardRules(isAdmin ? undefined : user.id));
  if (isAdmin) return rules as any[];
  const scope = await getLinkAccessScope(user);
  return gateForwardRulesForUserSurface(rules as any[], (rule) => canUseForwardRuleResource(rule, scope));
}

export async function visibleHostsForTelegramUser(user: any) {
  if (user.role === "admin") return db.getHosts() as Promise<any[]>;
  const [allowedHostIds, billingResourceIds, allHosts] = await Promise.all([
    db.getUserEffectiveAllowedHostIds(user.id),
    db.getUserUsableTrafficBillingResourceIds(user.id),
    db.getHosts(),
  ]);
  const allowedSet = new Set([...(allowedHostIds || []), ...((billingResourceIds as any)?.hostIds || [])].map(Number));
  return (allHosts as any[]).filter((host: any) => allowedSet.has(Number(host.id)) || Number(host.userId) === Number(user.id));
}

export async function visibleTunnelsForTelegramUser(user: any) {
  return (user.role === "admin" ? db.getTunnels() : db.getTunnelsForUser(user.id)) as Promise<any[]>;
}

export async function visibleForwardGroupsForTelegramUser(user: any) {
  if (user.role === "admin") return db.getForwardGroups() as Promise<any[]>;
  const [scope, groups] = await Promise.all([
    getLinkAccessScope(user),
    db.getForwardGroups() as Promise<any[]>,
  ]);
  if (!scope) return groups;
  return db.filterForwardGroupFieldsForUse(
    groups.filter((group: any) => scope.groupIds.has(Number(group.id))),
    scope,
  ) as any[];
}

export function searchMatches(keyword: string | undefined, values: unknown[]) {
  const needle = normalizeKeyword(keyword).toLowerCase();
  if (!needle) return true;
  return values.some((value) => String(value ?? "").toLowerCase().includes(needle));
}

export function ruleSearchValues(rule: any, summary?: AiRuleTrafficSummary) {
  const status = effectiveRuleStatusInfo(rule, summary);
  return [
    rule.id,
    rule.name,
    rule.sourcePort,
    rule.targetIp,
    rule.targetPort,
    rule.forwardType,
    rule.protocol,
    rule.hostId,
    rule.tunnelId,
    rule.remark,
    rule.remarks,
    rule.description,
    status.label,
    status.detail,
    rule.entryIp,
    rule.entryDomain,
  ];
}

export function hostSearchValues(host: any) {
  return [
    host.id,
    host.name,
    host.ip,
    host.ipv4,
    host.ipv6,
    host.entryIp,
    host.tunnelEntryIp,
    host.networkInterface,
    host.agentVersion,
    host.remark,
    host.remarks,
    host.description,
    onlineStatusText(host.isOnline),
  ];
}

export function tunnelSearchValues(tunnel: any, entryHost?: any, exitHost?: any) {
  return [
    tunnel.id,
    tunnel.name,
    tunnel.mode,
    tunnel.listenPort,
    tunnel.networkType,
    tunnel.connectHost,
    tunnel.entryHostId,
    tunnel.exitHostId,
    entryHost?.name,
    entryHost?.ip,
    entryHost?.entryIp,
    exitHost?.name,
    exitHost?.ip,
    exitHost?.entryIp,
    tunnel.remark,
    tunnel.remarks,
    tunnel.description,
    runningStatusText(tunnel.isRunning),
  ];
}

type AiEffectiveRuleStatusKind = "running" | "pending" | "disabled" | "abnormal";

function isForwardGroupSurfaceRule(rule: any) {
  return !!rule?.forwardGroupId && !rule?.forwardGroupRuleId && !rule?.forwardGroupMemberId;
}

function forwardGroupSurfaceLabel(rule: any) {
  const groupMode = String(rule?.forwardGroupMode || "");
  if (groupMode === "port") return "端口转发";
  if (groupMode === "chain") return "转发链";
  return "转发组";
}

function hasRuleTraffic(summary?: AiRuleTrafficSummary) {
  return Math.max(0, Number(summary?.bytesIn || 0)) + Math.max(0, Number(summary?.bytesOut || 0)) > 0;
}

export function effectiveRuleStatusInfo(rule: any, summary?: AiRuleTrafficSummary, offlineHostNames?: readonly string[]): { kind: AiEffectiveRuleStatusKind; label: string; detail?: string } {
  /**
   * 探测结果过了新鲜期就当作没探测过 —— 和面板同一把尺子（isLinkProbeFresh）。
   *
   * 不设这道门的话，一次陈年的超时会让这条规则在机器人里永远是「目标探测超时」，
   * 而面板上它是绿的。延迟数字同理：三天前那个 30ms 现在说明不了任何事。
   */
  const probeIsFresh = isLinkProbeFresh(summary?.latestLatencyAt);
  const latencyMs = !probeIsFresh || summary?.latestLatencyMs == null ? null : Number(summary.latestLatencyMs);
  const hasLatency = Number.isFinite(latencyMs) && latencyMs !== null && latencyMs >= 0;
  if (rule?.resourceAccessDenied || String(rule?.protocolBlockReason || "") === RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON) {
    return {
      kind: "disabled",
      label: "资源授权已失效",
      detail: RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON,
    };
  }
  if (rule?.protocolBlockReason) {
    return {
      kind: "abnormal",
      label: "协议屏蔽已拦截",
      detail: shortText(String(rule.protocolBlockReason || ""), 80),
    };
  }
  if (!rule?.isEnabled) {
    if (rule?.disabledByUser) return { kind: "disabled", label: "已手动停用" };
    if (rule?.disabledByTunnel) return { kind: "disabled", label: "隧道/链路停用" };
    if (rule?.disabledByGroup) return { kind: "disabled", label: "转发资源停用" };
    return { kind: "disabled", label: "已停用" };
  }
  /*
    路径上有机器掉线（入口、隧道的出口和中继）：和面板 resolveForwardRuleVisualStatus 同一个口径 ——
    机器掉线是实时通道确认过的，比几分钟前那次探测成功、比入口机「我的监听还在」都硬。
  */
  const offline = (offlineHostNames || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (offline.length > 0) {
    return { kind: "abnormal", label: "主机离线", detail: offline.join(" / ") };
  }
  if (probeIsFresh && summary?.latestLatencyIsTimeout) {
    const failure = normalizeProbeFailure((summary as any)?.latestProbeFailure);
    return failure && failure !== "timeout"
      ? { kind: "abnormal", label: "目标探测失败", detail: PROBE_FAILURE_LABELS[failure] }
      : {
        kind: "abnormal",
        label: "目标探测超时",
        detail: "最近一次探测失败，可能是目标不可达、端口未监听或链路不可用。",
      };
  }
  if (rule?.isRunning) {
    return hasLatency
      ? { kind: "running", label: `运行中（${Math.round(latencyMs!)}ms）` }
      : { kind: "running", label: "运行中" };
  }
  if (isForwardGroupSurfaceRule(rule) && (hasLatency || hasRuleTraffic(summary))) {
    const resourceLabel = forwardGroupSurfaceLabel(rule);
    return hasLatency
      ? { kind: "running", label: `${resourceLabel}入口可用（${Math.round(latencyMs!)}ms）` }
      : { kind: "running", label: `${resourceLabel}入口可用` };
  }
  return {
    kind: "pending",
    label: isForwardGroupSurfaceRule(rule) ? `等待${forwardGroupSurfaceLabel(rule)}应用` : "等待 Agent 应用",
    detail: "面板已保存规则，正在等待 Agent 拉取配置并回报运行状态。",
  };
}

export function effectiveRuleStatusText(rule: any, summary?: AiRuleTrafficSummary, offlineHostNames?: readonly string[]) {
  return effectiveRuleStatusInfo(rule, summary, offlineHostNames).label;
}

/**
 * 每条规则经过的机器里掉线了的（名字）：入口机，隧道的话再加上从入口到出口的每一跳。
 * 主机在不在线按 getHostsByIds 的口径算（和主机列表、状态通知同一套）。
 */
export async function offlineHostNamesByRule(rules: readonly any[]): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  const list = (rules || []).filter((rule) => rule && Number(rule.id) > 0);
  if (list.length === 0) return result;
  const tunnelIds = Array.from(new Set(list.map((rule) => Number(rule.tunnelId || 0)).filter((id) => id > 0)));
  const [tunnels, hops] = tunnelIds.length > 0
    ? await Promise.all([
      db.getTunnelsByIds(tunnelIds).catch(() => [] as any[]),
      db.getTunnelHopsByTunnelIds(tunnelIds).catch(() => [] as any[]),
    ])
    : [[], []];
  const hostIdsByTunnel = new Map<number, number[]>();
  for (const tunnel of tunnels as any[]) {
    hostIdsByTunnel.set(Number(tunnel.id), [Number(tunnel.entryHostId || 0), Number(tunnel.exitHostId || 0)]);
  }
  for (const hop of hops as any[]) {
    const ids = hostIdsByTunnel.get(Number(hop.tunnelId)) || [];
    ids.push(Number(hop.hostId || 0));
    hostIdsByTunnel.set(Number(hop.tunnelId), ids);
  }
  const hostIdsByRule = new Map<number, number[]>();
  const allHostIds = new Set<number>();
  for (const rule of list) {
    const ids = [Number(rule.hostId || 0), ...(hostIdsByTunnel.get(Number(rule.tunnelId || 0)) || [])].filter((id) => id > 0);
    hostIdsByRule.set(Number(rule.id), Array.from(new Set(ids)));
    ids.forEach((id) => allHostIds.add(id));
  }
  const hosts = allHostIds.size > 0 ? await db.getHostsByIds(Array.from(allHostIds)).catch(() => [] as any[]) : [];
  const hostById = new Map<number, any>((hosts as any[]).map((host) => [Number(host.id), host]));
  for (const [ruleId, ids] of hostIdsByRule) {
    const names = ids
      .map((id) => hostById.get(id))
      .filter((host) => host && !host.isOnline)
      .map((host) => String(host.name || `主机 #${host.id}`));
    if (names.length > 0) result.set(ruleId, names);
  }
  return result;
}

export function ruleMatchesEffectiveStatusFilter(rule: any, status: AiRuleStatusFilter, summary?: AiRuleTrafficSummary) {
  return effectiveRuleStatusInfo(rule, summary).kind === status;
}

export function runningStatusText(value: unknown) {
  return value ? "运行中" : "未运行";
}

export function onlineStatusText(value: unknown) {
  return value ? "在线" : "离线";
}

export async function hostNameByIdMap(hostIds: number[]) {
  const uniqueIds = Array.from(new Set(hostIds.filter((id) => Number.isFinite(id) && id > 0)));
  const entries = await Promise.all(uniqueIds.map(async (id) => [id, await db.getHostById(id).catch(() => null)] as const));
  return new Map(entries.filter((entry) => entry[1]).map(([id, host]) => [id, host]));
}

export type AiRuleTrafficSummary = {
  bytesIn: number;
  bytesOut: number;
  connections: number;
  latestLatencyMs?: number | null;
  latestLatencyIsTimeout?: boolean;
  /**
   * 这次探测是什么时候的。
   *
   * 原来这一列在这里被丢掉，于是机器人只看「上一次探测超没超时」，不问那是三分钟前
   * 还是三天前的事 —— 同一条规则，面板按新鲜期判成「运行中」，机器人拿陈年那次超时
   * 判成「目标探测超时」。两个地方对同一件事给两个答案。
   */
  latestLatencyAt?: Date | string | number | null;
};

export function emptyAiRuleTrafficSummary(): AiRuleTrafficSummary {
  return { bytesIn: 0, bytesOut: 0, connections: 0 };
}

/** @public 测试经 import(url(...)) 动态引用，knip 看不见 */
export async function aiRuleTrafficSummaryMap(user: any, ruleIds: number[], options: { includeLatency?: boolean } = {}) {
  const ids = Array.from(new Set(ruleIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  const map = new Map<number, AiRuleTrafficSummary>();
  if (ids.length === 0) return map;
  const rows = await db.getTrafficCounterSummaryByRule({
    userId: user.role === "admin" ? undefined : user.id,
    ruleIds: ids,
    includeLatency: !!options.includeLatency,
  }).catch(() => [] as any[]);
  for (const row of rows as any[]) {
    const ruleId = Number(row?.ruleId || 0);
    if (!ruleId) continue;
    const prev = map.get(ruleId) || emptyAiRuleTrafficSummary();
    prev.bytesIn += Math.max(0, Number(row?.bytesIn || 0));
    prev.bytesOut += Math.max(0, Number(row?.bytesOut || 0));
    prev.connections += Math.max(0, Number(row?.connections || 0));
    if (options.includeLatency) {
      prev.latestLatencyIsTimeout = !!row?.latestLatencyIsTimeout;
      prev.latestLatencyMs = row?.latestLatencyMs == null ? null : Number(row.latestLatencyMs);
      prev.latestLatencyAt = row?.latestLatencyAt ?? null;
    }
    map.set(ruleId, prev);
  }
  for (const id of ids) if (!map.has(id)) map.set(id, emptyAiRuleTrafficSummary());
  return map;
}

export function userSearchValues(user: any) {
  return [user.id, user.name, user.username, user.email, user.telegramUsername, user.displayRemark, user.remark, user.remarks, user.role];
}
