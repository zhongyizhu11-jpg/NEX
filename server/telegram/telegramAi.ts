/*
  Telegram 机器人：AI 问答 —— 自然语言查询的意图识别、规则流量 / 状态汇总、延迟测试。
  2026-11-23 从 telegramBot.ts（6483 行）拆出；外部调用方仍从 telegramBot.ts 导入，那里原样转发。
*/
import { formatBytes } from "../../shared/formatBytes";
import { formatForwardRuleProtocol } from "../../shared/forwardTypes";
import { escapeHtmlText as escapeHtml } from "../../shared/htmlEscape";
import { appendAiAudit } from "../ai/audit";
import { forwardxAiClient } from "../ai/client";
import type { ManagePresetField } from "../ai/managePresets";
import { SlidingWindowRateLimiter } from "../ai/rateLimiter";
import { getForwardxAiSettings as getDeepSeekSettings } from "../ai/settings";
import { buildForwardxQueryIntentPrompt, forwardxQueryIntentResponseSchema } from "../ai/skills/forwardxCore";
import * as db from "../db";
import { AI_INTERACTION_RATE_LIMIT, AI_INTERACTION_RATE_WINDOW_MS, AI_QUERY_RESULT_LIMIT, RULE_TEST_POLL_MS, RULE_TEST_WAIT_MS, extractAiRuleRankLimit, extractHostFilterKeyword, extractManageAmountYuan, extractManageCodeCount, extractManageDiscountPercent, extractManageHostKeyword, extractManageRedeemAmountYuan, extractManageRuleId, extractManageSourcePort, extractManageTargetEndpoint, extractManageTargetKeyword, extractManageTunnelKeyword, extractRuleId, extractRuleRankKeyword, extractSearchKeyword, extractUserFilterKeyword, formatDate, formatDateTime, formatMoneyCny, formatRuleTestResult, normalizeAiQueryKeyword, normalizeAiRuleRankLimit, normalizeManageDiscountPercent, normalizeManageHostKeyword, normalizeManageTargetIp, normalizeManageTargetKeyword, normalizeManageTunnelKeyword, normalizeUserLookupKeyword, parseManageCodeCount, parseManagePort, parseNumericToken, shortText } from "./telegramText";
import { editMessage, telegramRulesCaller } from "./telegramTransport";
import { aiRuleTrafficSummaryMap, effectiveRuleStatusInfo, effectiveRuleStatusText, emptyAiRuleTrafficSummary, hostNameByIdMap, hostSearchValues, onlineStatusText, ruleDetailKeyboard, ruleListBackKeyboard, ruleMatchesEffectiveStatusFilter, ruleSearchValues, ruleTestKeyboard, runningStatusText, searchMatches, tunnelSearchValues, userSearchValues, visibleForwardGroupsForTelegramUser, visibleHostsForTelegramUser, visibleRuleForTelegram, visibleRulesForTelegramUser, visibleTunnelsForTelegramUser } from "./telegramViews";
import type { AiRuleStatusFilter, AiRuleTrafficSummary } from "./telegramViews";

type AiQueryIntent = {
  intent: "usage" | "rules" | "rule_detail" | "rule_usage" | "rule_rank" | "hosts" | "tunnels" | "forward_groups" | "users" | "account" | "help" | "unsupported";
  id?: number;
  keyword?: string;
  ruleStatus?: AiRuleStatusFilter;
  rankMetric?: AiRuleRankMetric;
  rankOrder?: AiRuleRankOrder;
  limit?: number;
};

type AiRuleRankMetric = "traffic" | "connections" | "latency";

type AiRuleRankOrder = "desc" | "asc";

export type ManageActionKind =
  | "none"
  | "balance_set"
  | "balance_adjust"
  | "renew"
  | "account_enable"
  | "account_disable"
  | "forward_enable"
  | "forward_disable"
  | "rule_enable"
  | "rule_disable"
  | "rule_create"
  | "rule_delete"
  | "tunnel_rules_enable"
  | "tunnel_rules_disable"
  | "traffic_reset"
  | "redeem_code_generate_balance"
  | "discount_code_generate_percent"
  | "registration_enable"
  | "registration_disable";

export type ManageDurationUnit = "day" | "month" | "year";

export type ManageForwardMode = "host" | "tunnel";

export type ManageActionIntent = {
  action: ManageActionKind;
  target?: string;
  amountYuan?: number;
  durationValue?: number;
  durationUnit?: ManageDurationUnit;
  ruleId?: number;
  tunnel?: string;
  host?: string;
  forwardMode?: ManageForwardMode;
  sourcePort?: number;
  targetIp?: string;
  targetPort?: number;
  codeCount?: number;
  discountPercent?: number;
};

export type ManageClarifyField = "target" | "forwardMode" | "tunnel" | "host" | "ruleId" | ManagePresetField;

export const aiInteractionRateLimiter = new SlidingWindowRateLimiter({
  limit: AI_INTERACTION_RATE_LIMIT,
  windowMs: AI_INTERACTION_RATE_WINDOW_MS,
});

export function userInfoText(user: any) {
  return [
    "<b>用户信息</b>",
    "",
    `账户：<b>${escapeHtml(user.name || user.username)}</b>`,
    `用户名：${escapeHtml(user.username)}`,
    `角色：${user.role === "admin" ? "管理员" : "用户"}`,
    `余额：${formatMoneyCny(user.balanceCents)}`,
    `到期时间：${escapeHtml(formatDate(user.expiresAt))}`,
    `转发权限：${user.role === "admin" || user.canAddRules ? "已启用" : "已停用"}`,
    `绑定时间：${escapeHtml(formatDate(user.telegramLinkedAt))}`,
    `最近使用：${escapeHtml(formatDate(user.telegramLastSeenAt))}`,
  ].join("\n");
}

export async function usageText(user: any) {
  const [ruleCount, portCount] = await Promise.all([
    db.getUserRuleCount(user.id),
    db.getUserPortCount(user.id),
  ]);
  const limit = Number(user.trafficLimit) || 0;
  const used = Number(user.trafficUsed) || 0;
  const remaining = limit > 0 ? Math.max(0, limit - used) : null;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return [
    "<b>流量用量</b>",
    "",
    `已用流量：${escapeHtml(formatBytes(used))}`,
    `流量额度：${limit > 0 ? escapeHtml(formatBytes(limit)) : "不限"}`,
    `剩余流量：${remaining === null ? "不限" : escapeHtml(formatBytes(remaining))}`,
    limit > 0 ? `使用率：${percent}%` : "",
    `规则/端口：${ruleCount}${user.maxRules ? `/${user.maxRules}` : ""} 条，${portCount}${user.maxPorts ? `/${user.maxPorts}` : ""} 个端口`,
    user.trafficAutoReset ? `自动重置：每月 ${user.trafficResetDay || 1} 日` : "",
  ].filter(Boolean).join("\n");
}

/** 最近一小时的探测：平均延迟和丢包。面板「延迟」图用的是同一份数据。 */
async function ruleRecentProbeSummary(ruleId: number) {
  const rows = await db.getTcpingSeriesByRule(ruleId, { since: new Date(Date.now() - 3600_000) }).catch(() => [] as any[]);
  if (!rows || rows.length === 0) return "";
  let probes = 0;
  let successes = 0;
  const latencies: number[] = [];
  for (const row of rows as any[]) {
    const count = Math.max(0, Number(row.probeCount || 0));
    if (count > 0) {
      probes += count;
      successes += Math.max(0, Math.min(count, Number(row.probeSuccesses || 0)));
    } else {
      probes += 1;
      successes += row.isTimeout ? 0 : 1;
    }
    if (!row.isTimeout && typeof row.latencyMs === "number" && row.latencyMs >= 0) latencies.push(row.latencyMs);
  }
  const loss = probes > 0 ? Math.round(((probes - successes) / probes) * 1000) / 10 : null;
  const avg = latencies.length > 0 ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null;
  return `近 1 小时：${avg === null ? "无延迟数据" : `平均 ${avg} ms`}${loss === null ? "" : ` · 丢包 ${loss}%`}`;
}

/**
 * 发起一次诊断，然后在后台等结果、回来改同一条消息。
 *
 * 不在当前更新里等：同一个聊天的更新是排队处理的，干等四十秒，这期间点别的按钮都没反应。
 */
export async function startRuleLatencyTest(chatId: number | string, messageId: number, user: any, ruleId: number, page: number) {
  const rule = await visibleRuleForTelegram(user, ruleId);
  if (!rule) {
    await editMessage(chatId, messageId, "规则不存在或无权查看。", ruleListBackKeyboard(page));
    return;
  }
  const caller = await telegramRulesCaller(user);
  let started: { id?: number } | null = null;
  try {
    started = await caller.startSelfTest({ ruleId: Number(rule.id) });
  } catch (error) {
    await editMessage(chatId, messageId, `测延迟没发出去：${escapeHtml(error instanceof Error ? error.message : String(error))}`, ruleDetailKeyboard(rule, page));
    return;
  }
  const startedId = Number(started?.id || 0);
  await editMessage(chatId, messageId, `<b>测延迟 · 规则 #${rule.id}</b> ${escapeHtml(shortText(rule.name, 24))}\n\n⏳ 正在从入口一段段测到目标，通常十几秒…`, ruleTestKeyboard(Number(rule.id), page, true));
  void (async () => {
    const deadline = Date.now() + RULE_TEST_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RULE_TEST_POLL_MS));
      const latest = await db.getLatestForwardTest(Number(rule.id), { includeActive: true }).catch(() => null) as any;
      if (!latest) continue;
      const status = String(latest.status || "");
      if (status === "pending" || status === "running") continue;
      if (startedId > 0 && Number(latest.id || 0) < startedId) continue;
      const recent = await ruleRecentProbeSummary(Number(rule.id));
      await editMessage(chatId, messageId, formatRuleTestResult(rule, latest, recent), ruleTestKeyboard(Number(rule.id), page));
      return;
    }
    await editMessage(
      chatId,
      messageId,
      `<b>测延迟 · 规则 #${rule.id}</b> ${escapeHtml(shortText(rule.name, 24))}\n\n测试已发出，结果还没回来（Agent 可能离线或较忙）。稍后点「查看结果」。`,
      ruleTestKeyboard(Number(rule.id), page, true),
    );
  })().catch((error) => console.warn(`[Telegram] rule latency test follow-up failed rule=${rule.id}: ${error instanceof Error ? error.message : String(error)}`));
}

export async function ruleLatestTestView(user: any, ruleId: number, page: number) {
  const rule = await visibleRuleForTelegram(user, ruleId);
  if (!rule) return { text: "规则不存在或无权查看。", keyboard: ruleListBackKeyboard(page) };
  const latest = await db.getLatestForwardTest(Number(rule.id), { includeActive: true }).catch(() => null) as any;
  const status = String(latest?.status || "");
  if (!latest) return { text: "这条规则还没有测过。", keyboard: ruleTestKeyboard(Number(rule.id), page) };
  if (status === "pending" || status === "running") {
    return { text: `<b>测延迟 · 规则 #${rule.id}</b>\n\n⏳ 还在测，稍后再看。`, keyboard: ruleTestKeyboard(Number(rule.id), page, true) };
  }
  return { text: formatRuleTestResult(rule, latest, await ruleRecentProbeSummary(Number(rule.id))), keyboard: ruleTestKeyboard(Number(rule.id), page) };
}

function textAsksRuleUsage(text: string) {
  return /(规则|rule|#)/i.test(text) && /(流量|用量|用了|使用|消耗|traffic|usage)/i.test(text);
}

function textAsksRuleDetail(text: string) {
  return /(详情|状态|detail|status)/i.test(text)
    || /#\s*\d+/.test(text)
    || /\d+\s*(?:号|#)\s*(?:规则|rule)/i.test(text);
}

function normalizeAiRuleStatusFilter(value: unknown): AiRuleStatusFilter | undefined {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (/(abnormal|problem|error|failed|fail|invalid|timeout|unreachable|异常|不正常|有问题|出问题|故障|失效|不通|不可达|超时|探测失败|探测超时|目标不可达|目标不通|端口不通|端口未监听|链路不可用)/i.test(raw)) return "abnormal";
  if (/(pending|waiting|sync|not\s*running|stopped|等待同步|待同步|未同步|没同步|等待\s*agent|等待应用|等待生效|等待下发|未运行|没运行|不运行|已停止|停止)/i.test(raw)) return "pending";
  if (/(disabled|disable|off|closed|已停用|停用|禁用|关闭|未启用)/i.test(raw)) return "disabled";
  if (/(running|enabled|online|normal|ok|运行中|正在运行|已运行|正常|可用|启用中)/i.test(raw)) return "running";
  return undefined;
}

function extractAiRuleStatusFilter(text: string) {
  return normalizeAiRuleStatusFilter(text);
}

function stripAiRuleStatusKeyword(value: unknown, status?: AiRuleStatusFilter) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!status) return normalizeAiQueryKeyword(raw);
  const cleaned = raw
    .replace(/(abnormal|problem|error|failed|fail|invalid|timeout|unreachable|pending|waiting|sync|not\s*running|stopped|disabled|disable|off|closed|running|enabled|online|normal|ok|异常|不正常|有问题|出问题|故障|失效|不通|不可达|超时|探测失败|探测超时|目标不可达|目标不通|端口不通|端口未监听|链路不可用|等待同步|待同步|未同步|没同步|等待\s*agent|等待应用|等待生效|等待下发|未运行|没运行|不运行|已停止|停止|已停用|停用|禁用|关闭|未启用|运行中|正在运行|已运行|正常|可用|启用中)/gi, " ")
    .replace(/(有没有|没有|有无|是否|是不是|有|没|哪些|哪条|哪个|转发规则|规则|端口|转发|状态|查询|查看|看下|看看|帮我|请|给我|的|吗)/gi, " ")
    .replace(/[，,。？?！!：:、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeAiQueryKeyword(cleaned);
}

function normalizeAiRuleRankMetric(value: unknown): AiRuleRankMetric | undefined {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (/(traffic|usage|bytes|流量|用量|消耗|占用|使用)/i.test(raw)) return "traffic";
  if (/(connection|connections|conn|连接|连接数|会话)/i.test(raw)) return "connections";
  if (/(latency|delay|ping|tcping|延迟|耗时|响应|速度|快|慢|卡)/i.test(raw)) return "latency";
  return undefined;
}

function normalizeAiRuleRankOrder(value: unknown, metric?: AiRuleRankMetric): AiRuleRankOrder | undefined {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (/(asc|lowest|least|min|bottom|最少|最低|最小|少|低|小|最快|快)/i.test(raw)) return "asc";
  if (/(desc|highest|most|max|top|最多|最高|最大|多|高|大|最慢|最卡|慢|卡|排行|排名|第一)/i.test(raw)) return "desc";
  return metric ? "desc" : undefined;
}

function parseAiRuleRankIntent(text: string): AiQueryIntent | null {
  const raw = text.trim();
  if (!raw) return null;
  const mentionsRule = /(规则|转发|端口|rule|port)/i.test(raw);
  if (!mentionsRule) return null;
  const metric = normalizeAiRuleRankMetric(raw);
  if (!metric) return null;
  const compact = raw.replace(/\s+/g, "");
  const rankHint = /(排行|排名|top|前\s*[0-9零〇一二两三四五六七八九十百千]*|最多|最少|最高|最低|最大|最小|最快|最慢|最卡|第一|哪(?:个|一个|条|一条)?.*(?:多|少|高|低|快|慢|卡)|谁.*最)/i.test(compact);
  if (!rankHint) return null;
  const rankOrder = normalizeAiRuleRankOrder(raw, metric) || "desc";
  const keyword = extractRuleRankKeyword(raw);
  const limit = extractAiRuleRankLimit(raw);
  return {
    intent: "rule_rank",
    rankMetric: metric,
    rankOrder,
    ...(limit ? { limit } : {}),
    ...(keyword ? { keyword } : {}),
  };
}

function normalizeAiQueryIntent(value: any, fallback: AiQueryIntent): AiQueryIntent {
  const allowed = new Set<AiQueryIntent["intent"]>([
    "usage",
    "rules",
    "rule_detail",
    "rule_usage",
    "rule_rank",
    "hosts",
    "tunnels",
    "forward_groups",
    "users",
    "account",
    "help",
    "unsupported",
  ]);
  const modelIntent = allowed.has(value?.intent) ? value.intent : undefined;
  let intent = modelIntent || fallback.intent;
  if (["rule_usage", "rule_detail", "rules", "rule_rank"].includes(fallback.intent)) intent = fallback.intent;
  const modelId = Number(value?.id);
  const fallbackId = Number(fallback.id);
  const id = Number.isFinite(modelId) && modelId > 0
    ? modelId
    : (Number.isFinite(fallbackId) && fallbackId > 0 ? fallbackId : undefined);
  const modelKeyword = intent === "users"
    ? normalizeUserLookupKeyword(value?.keyword)
    : normalizeAiQueryKeyword(value?.keyword);
  const fallbackKeyword = intent === "users"
    ? normalizeUserLookupKeyword(fallback.keyword)
    : normalizeAiQueryKeyword(fallback.keyword);
  const ruleStatus = normalizeAiRuleStatusFilter(value?.ruleStatus || value?.status || value?.state) || fallback.ruleStatus;
  const keyword = ruleStatus ? stripAiRuleStatusKeyword(modelKeyword || fallbackKeyword, ruleStatus) : (modelKeyword || fallbackKeyword);
  const rankMetric = normalizeAiRuleRankMetric(value?.rankMetric || value?.metric) || fallback.rankMetric;
  const rankOrder = normalizeAiRuleRankOrder(value?.rankOrder || value?.order, rankMetric) || fallback.rankOrder;
  const limit = normalizeAiRuleRankLimit(value?.limit) || normalizeAiRuleRankLimit(fallback.limit);
  return {
    intent,
    ...(id ? { id } : {}),
    ...(keyword ? { keyword } : {}),
    ...(ruleStatus ? { ruleStatus } : {}),
    ...(intent === "rule_rank" && rankMetric ? { rankMetric } : {}),
    ...(intent === "rule_rank" && rankOrder ? { rankOrder } : {}),
    ...(intent === "rule_rank" && limit ? { limit } : {}),
  };
}

function localAiQueryIntent(text: string): AiQueryIntent {
  const raw = text.trim();
  const compact = raw.replace(/\s+/g, "");
  const lower = raw.toLowerCase();
  const readHint = /(查询|查看|看看|看下|看一下|显示|列出|搜索|多少|哪些|哪条|状态|详情|流量|用量|规则|主机|机器|节点|隧道|链路|转发组|入口组|用户|账户|账号|端口|ip|域名)/i.test(raw);
  const questionHint = /(查询|查看|看看|看下|看一下|显示|列出|搜索|多少|哪些|哪条|状态|详情|列表|有哪些|有的|吗|？|\?)/i.test(raw);
  const writeHint = /(开启|启用|关闭|停用|禁用|删除|移除|重置|续期|兑换|创建|新增|修改|更新|编辑|enable|disable|delete|remove|reset|renew|create|add|update|edit)/i.test(lower);
  if (writeHint && !readHint) return { intent: "unsupported" };
  if (!questionHint && /^(帮我|请|给我|把|将)?(开启|启用|关闭|停用|禁用|删除|移除|重置|续期|兑换|创建|新增|修改|更新|编辑)/.test(compact)) {
    return { intent: "unsupported" };
  }
  const id = extractRuleId(raw);
  const rankIntent = parseAiRuleRankIntent(raw);
  const ruleStatus = extractAiRuleStatusFilter(raw);
  const keyword = stripAiRuleStatusKeyword(extractSearchKeyword(raw), ruleStatus);
  const userKeyword = normalizeUserLookupKeyword(extractUserFilterKeyword(raw) || keyword);
  if (/(帮助|怎么用|help)/i.test(raw)) return { intent: "help" };
  if (rankIntent) return rankIntent;
  if (textAsksRuleUsage(raw)) return id ? { intent: "rule_usage", id } : { intent: "rules", keyword, ...(ruleStatus ? { ruleStatus } : {}) };
  if (id && textAsksRuleDetail(raw)) return { intent: "rule_detail", id };
  if (/(用户|user)/i.test(raw) && /(详情|明细|使用|用了|流量|用量|到期|角色|usage|traffic)/i.test(raw)) {
    return { intent: "users", ...(userKeyword ? { keyword: userKeyword } : {}) };
  }
  if (/(用量|流量|额度|余额|套餐|usage|traffic)/i.test(raw)) return { intent: "usage", keyword };
  if (/(我是谁|账户|账号|个人|信息|资料|account|profile)/i.test(raw)) return { intent: "account", keyword };
  if (/(转发组|入口组|多入口|forward\s*group|group)/i.test(raw)) return { intent: "forward_groups", keyword };
  if (/(隧道|链路|转发链|tunnel|link)/i.test(raw)) return { intent: "tunnels", keyword };
  if (/(规则|端口|转发|rule|port)/i.test(raw)) return { intent: "rules", keyword, ...(ruleStatus ? { ruleStatus } : {}) };
  if (/(用户|user)/i.test(raw)) return { intent: "users", ...(userKeyword ? { keyword: userKeyword } : {}) };
  if (/(主机|机器|节点|agent|host|server)/i.test(raw)) return { intent: "hosts", keyword };
  if (keyword) return { intent: "rules", keyword };
  return { intent: "help" };
}

async function parseAiQueryIntent(text: string): Promise<AiQueryIntent> {
  const fallback = localAiQueryIntent(text);
  if (fallback.intent === "unsupported") return fallback;
  const settings = await getDeepSeekSettings().catch(() => null);
  if (!settings?.enabled || !settings.apiKey) return fallback;
  try {
    const parsed = await forwardxAiClient.requestStructuredJson({
      operation: "telegram.query-intent",
      settings,
      systemPrompt: buildForwardxQueryIntentPrompt(),
      userText: text,
      schema: forwardxQueryIntentResponseSchema,
    });
    return normalizeAiQueryIntent(parsed, fallback);
  } catch (error) {
    console.warn("[TelegramBot] AI query intent fallback:", error);
    appendAiAudit({ phase: "intent", result: "fallback", intent: fallback.intent, detail: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

export function extractManageDuration(text: string): { value: number; unit: ManageDurationUnit } | null {
  const hit = text.match(/([0-9零〇一二两三四五六七八九十百千]+)\s*(天|日|个月|月|年)/);
  if (!hit) return null;
  const value = parseNumericToken(hit[1]) || Number(hit[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const rawUnit = hit[2];
  const unit: ManageDurationUnit = rawUnit === "年"
    ? "year"
    : (rawUnit === "天" || rawUnit === "日" ? "day" : "month");
  return { value: Math.max(1, Math.floor(Number(value))), unit };
}

export function normalizeManageForwardMode(value: unknown): ManageForwardMode | undefined {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (/(隧道|链路|tunnel|link)/i.test(raw)) return "tunnel";
  if (/(端口|主机|host|server|machine|节点|直连|普通转发)/i.test(raw)) return "host";
  return undefined;
}

export function extractManageForwardMode(text: string): ManageForwardMode | undefined {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return undefined;
  const hasTunnel = /(隧道转发|隧道规则|隧道|链路|tunnel|link)/i.test(raw);
  const hasHost = /(端口转发|主机转发|主机|机器|节点|host|server|普通转发|直连)/i.test(raw);
  if (hasTunnel && !hasHost) return "tunnel";
  if (hasHost && !hasTunnel) return "host";
  if (/(加入|添加到|走)\s*(?:隧道|链路)/i.test(raw)) return "tunnel";
  if (/(端口转发|普通转发|直连)/i.test(raw)) return "host";
  return undefined;
}

export function extractManageIntentPatchFromText(text: string, missingFields: ManageClarifyField[] = []): Partial<ManageActionIntent> {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return {};
  const expectAmount = missingFields.includes("amountYuan");
  const expectCodeCount = missingFields.includes("codeCount");
  const expectDiscountPercent = missingFields.includes("discountPercent");
  const plainNumberMatch = raw.match(/^([+-]?\d+(?:\.\d+)?)$/);
  const hasCountUnit = /(?:个|张|份|组)/i.test(raw);
  const target = normalizeManageTargetKeyword(extractManageTargetKeyword(raw));
  const amountRaw = extractManageAmountYuan(raw);
  const redeemAmountRaw = extractManageRedeemAmountYuan(raw);
  let amountYuan = Number.isFinite(Number(amountRaw)) ? Number(amountRaw) : undefined;
  if (!Number.isFinite(amountYuan as number) && Number.isFinite(Number(redeemAmountRaw))) {
    amountYuan = Number(redeemAmountRaw);
  }
  if (!Number.isFinite(amountYuan as number) && expectAmount) {
    if (plainNumberMatch?.[1]) {
      const parsed = Number(plainNumberMatch[1]);
      if (Number.isFinite(parsed)) amountYuan = parsed;
    }
  }
  let codeCount = extractManageCodeCount(raw);
  if (!Number.isFinite(codeCount as number) && expectCodeCount) {
    const shouldDeferCodeCountForSingleNumber = !!plainNumberMatch?.[1] && !hasCountUnit && (expectAmount || expectDiscountPercent);
    if (!shouldDeferCodeCountForSingleNumber) {
      codeCount = parseManageCodeCount(raw);
    }
  }
  let discountPercent = extractManageDiscountPercent(raw);
  if (!Number.isFinite(discountPercent as number) && expectDiscountPercent) {
    const unsignedNumber = plainNumberMatch?.[1]?.startsWith("+")
      ? plainNumberMatch[1].slice(1)
      : plainNumberMatch?.[1];
    if (unsignedNumber && /^[0-9]+(?:\.\d+)?$/.test(unsignedNumber)) {
      const numeric = Number(unsignedNumber);
      if (Number.isFinite(numeric)) {
        discountPercent = numeric > 0 && numeric <= 10
          ? normalizeManageDiscountPercent(Math.round((10 - numeric) * 10))
          : normalizeManageDiscountPercent(Math.round(numeric));
      }
    }
  }
  const duration = extractManageDuration(raw);
  const ruleId = extractManageRuleId(raw);
  const tunnel = normalizeManageTunnelKeyword(extractManageTunnelKeyword(raw));
  const host = normalizeManageHostKeyword(extractManageHostKeyword(raw));
  const forwardMode = normalizeManageForwardMode(extractManageForwardMode(raw));
  const endpoint = extractManageTargetEndpoint(raw);
  const targetIp = normalizeManageTargetIp(endpoint.targetIp || "");
  const targetPort = parseManagePort(endpoint.targetPort);
  const sourceRaw = extractManageSourcePort(raw);
  const sourcePort = sourceRaw === 0 ? 0 : parseManagePort(sourceRaw);
  const patch: Partial<ManageActionIntent> = {};
  if (target) patch.target = target;
  if (Number.isFinite(amountYuan as number)) patch.amountYuan = Number(amountYuan);
  if (duration) {
    patch.durationValue = duration.value;
    patch.durationUnit = duration.unit;
  }
  if (ruleId) patch.ruleId = ruleId;
  if (tunnel) patch.tunnel = tunnel;
  if (host) patch.host = host;
  if (forwardMode) patch.forwardMode = forwardMode;
  if (sourcePort !== undefined) patch.sourcePort = sourcePort;
  if (targetIp) patch.targetIp = targetIp;
  if (targetPort) patch.targetPort = targetPort;
  if (Number.isFinite(codeCount as number)) patch.codeCount = Number(codeCount);
  if (Number.isFinite(discountPercent as number)) patch.discountPercent = Number(discountPercent);
  return patch;
}

function forwardGroupSearchValues(group: any) {
  return [
    group.id,
    group.name,
    group.groupType,
    group.groupMode,
    group.remark,
    group.remarks,
    group.description,
    group.isEnabled === false ? "已停用" : "已启用",
  ];
}

function effectiveRuleStatusFilterLabel(status: AiRuleStatusFilter) {
  if (status === "running") return "运行正常";
  if (status === "pending") return "等待 Agent 应用";
  if (status === "disabled") return "已停用";
  return "异常/不可用";
}

function moreText(total: number, shown: number) {
  return total > shown ? `\n\n<i>还有 ${total - shown} 条未展示，可加关键字缩小范围。</i>` : "";
}

export function aiCode(value: unknown) {
  return `<code>${escapeHtml(value ?? "-")}</code>`;
}

function aiBlockquote(lines: string[]) {
  const body = lines.filter(Boolean).join("\n");
  return body ? `<blockquote>${body}</blockquote>` : "";
}

function aiFilterPart(label: string, value: unknown) {
  return `${escapeHtml(label)} ${aiCode(value)}`;
}

function aiResultHeader(title: string, matched: number, total: number, unit: string, filterText = "") {
  return [
    `<b>${escapeHtml(title)}</b>`,
    `结果：<b>${matched}</b> / ${total} ${escapeHtml(unit)}`,
    filterText ? `筛选：${filterText}` : "",
  ].filter(Boolean).join("\n");
}

type AiRuleFilters = {
  keyword?: string;
  userKeyword?: string;
  hostKeyword?: string;
  ruleStatus?: AiRuleStatusFilter;
};

function formatRuleTrafficSummary(summary: AiRuleTrafficSummary | undefined, compact = false) {
  const bytesIn = Math.max(0, Number(summary?.bytesIn || 0));
  const bytesOut = Math.max(0, Number(summary?.bytesOut || 0));
  const connections = Math.max(0, Number(summary?.connections || 0));
  const total = bytesIn + bytesOut;
  const line = compact
    ? `流量：<b>${escapeHtml(formatBytes(total))}</b>（入 ${escapeHtml(formatBytes(bytesIn))} / 出 ${escapeHtml(formatBytes(bytesOut))}）`
    : `已用流量：<b>${escapeHtml(formatBytes(total))}</b>\n入站：${escapeHtml(formatBytes(bytesIn))}\n出站：${escapeHtml(formatBytes(bytesOut))}`;
  return connections > 0 ? `${line}\n连接：${connections}` : line;
}

function formatRuleTrafficSummaryLines(summary: AiRuleTrafficSummary | undefined) {
  const bytesIn = Math.max(0, Number(summary?.bytesIn || 0));
  const bytesOut = Math.max(0, Number(summary?.bytesOut || 0));
  const connections = Math.max(0, Number(summary?.connections || 0));
  return [
    `流量：<b>${escapeHtml(formatBytes(bytesIn + bytesOut))}</b>`,
    `入 / 出：${aiCode(formatBytes(bytesIn))} / ${aiCode(formatBytes(bytesOut))}`,
    connections > 0 ? `连接：<b>${connections}</b>` : "",
  ].filter(Boolean);
}

async function aiMatchingUserIds(keyword: string) {
  const userIds = new Set<number>();
  if (!keyword) return userIds;
  const users = await db.getUserTrafficSummaries().catch(() => [] as any[]);
  for (const item of users as any[]) {
    if (searchMatches(keyword, userSearchValues(item))) userIds.add(Number(item.id));
  }
  return userIds;
}

async function aiRulesWithFilters(user: any, filters: AiRuleFilters = {}) {
  const rules = await visibleRulesForTelegramUser(user);
  const ruleStatus = normalizeAiRuleStatusFilter(filters.ruleStatus);
  let keyword = stripAiRuleStatusKeyword(filters.keyword, ruleStatus);
  const requestedUserKeyword = normalizeAiQueryKeyword(filters.userKeyword);
  let userKeyword = user.role === "admin" ? requestedUserKeyword : "";
  const hostKeyword = normalizeAiQueryKeyword(filters.hostKeyword);
  let userIds = new Set<number>();
  if (userKeyword) {
    userIds = await aiMatchingUserIds(userKeyword);
  } else if (user.role === "admin" && keyword && !hostKeyword) {
    const inferredUserIds = await aiMatchingUserIds(keyword);
    if (inferredUserIds.size > 0) {
      userKeyword = keyword;
      userIds = inferredUserIds;
      keyword = "";
    }
  }
  const hosts = await visibleHostsForTelegramUser(user).catch(() => [] as any[]);
  const hostById = new Map((hosts as any[]).map((host: any) => [Number(host.id), host]));
  const hostIds = new Set<number>();
  if (hostKeyword) {
    for (const host of hosts as any[]) {
      if (searchMatches(hostKeyword, hostSearchValues(host))) hostIds.add(Number(host.id));
    }
  }
  const statusByRuleId = (ruleStatus || keyword)
    ? await aiRuleTrafficSummaryMap(user, (rules as any[]).map((rule: any) => Number(rule.id)), { includeLatency: true })
    : new Map<number, AiRuleTrafficSummary>();
  const matched = (rules as any[]).filter((rule: any) => {
    const statusSummary = statusByRuleId.get(Number(rule.id));
    if (ruleStatus && !ruleMatchesEffectiveStatusFilter(rule, ruleStatus, statusSummary)) return false;
    if (keyword && !searchMatches(keyword, ruleSearchValues(rule, statusSummary))) return false;
    if (userKeyword && !userIds.has(Number(rule.userId))) return false;
    if (hostKeyword && !hostIds.has(Number(rule.hostId))) return false;
    return true;
  });
  return { rules, matched, hostById, keyword, userKeyword, hostKeyword, ruleStatus };
}

function aiRuleFilterSuffix(filters: { keyword?: string; userKeyword?: string; hostKeyword?: string; ruleStatus?: AiRuleStatusFilter }) {
  return [
    filters.userKeyword ? aiFilterPart("用户", filters.userKeyword) : "",
    filters.hostKeyword ? aiFilterPart("主机", filters.hostKeyword) : "",
    filters.ruleStatus ? aiFilterPart("状态", effectiveRuleStatusFilterLabel(filters.ruleStatus)) : "",
    filters.keyword ? aiFilterPart("关键字", filters.keyword) : "",
  ].filter(Boolean).join("，");
}

async function aiRulesText(user: any, keywordOrFilters?: string | AiRuleFilters) {
  const filters: AiRuleFilters = typeof keywordOrFilters === "string" ? { keyword: keywordOrFilters } : (keywordOrFilters || {});
  const { rules, matched, hostById, keyword, userKeyword, hostKeyword, ruleStatus } = await aiRulesWithFilters(user, filters);
  const filterText = aiRuleFilterSuffix({ keyword, userKeyword, hostKeyword, ruleStatus });
  const header = aiResultHeader("转发规则查询", matched.length, rules.length, "条", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到匹配的规则。`;
  const visible = matched.slice(0, AI_QUERY_RESULT_LIMIT);
  const trafficByRuleId = await aiRuleTrafficSummaryMap(user, visible.map((rule: any) => Number(rule.id)), { includeLatency: true });
  const lines = visible.map((rule: any) => {
    const host = hostById.get(Number(rule.hostId));
    const trafficSummary = trafficByRuleId.get(Number(rule.id));
    const statusInfo = effectiveRuleStatusInfo(rule, trafficSummary);
    const note = String(rule.remark || rule.remarks || rule.description || "").trim();
    const title = shortText(note || rule.name || `规则 #${rule.id}`, 30);
    const location = rule.tunnelId
      ? `归属：隧道 ${aiCode(`#${rule.tunnelId}`)}`
      : `归属：主机 ${aiCode(`#${rule.hostId}`)}${host?.name ? `（${escapeHtml(shortText(host.name, 18))}）` : ""}`;
    const details = [
      `状态：<b>${escapeHtml(effectiveRuleStatusText(rule, trafficSummary))}</b>`,
      statusInfo.detail ? `说明：${escapeHtml(statusInfo.detail)}` : "",
      `类型：${aiCode(`${rule.forwardType || "-"} / ${formatForwardRuleProtocol(rule.protocol)}`)}`,
      `入口：${aiCode(`:${rule.sourcePort ?? "-"}`)}`,
      `目标：${aiCode(`${rule.targetIp || "-"}:${rule.targetPort ?? "-"}`)}`,
      location,
      ...formatRuleTrafficSummaryLines(trafficByRuleId.get(Number(rule.id))),
      note && note !== rule.name ? `备注：${escapeHtml(shortText(note, 32))}` : "",
    ];
    return [`<b>#${rule.id} ${escapeHtml(title)}</b>`, aiBlockquote(details)].filter(Boolean).join("\n");
  });
  return `${header}\n\n${lines.join("\n\n")}${moreText(matched.length, visible.length)}`;
}

function aiRuleRankTitle(metric: AiRuleRankMetric, order: AiRuleRankOrder) {
  if (metric === "traffic") return order === "asc" ? "转发规则流量最少排行" : "转发规则流量最多排行";
  if (metric === "connections") return order === "asc" ? "转发规则连接最少排行" : "转发规则连接最多排行";
  return order === "asc" ? "转发规则延迟最低排行" : "转发规则延迟最高排行";
}

function aiRuleRankMetricLabel(metric: AiRuleRankMetric, order: AiRuleRankOrder) {
  if (metric === "traffic") return order === "asc" ? "总流量从少到多" : "总流量从多到少";
  if (metric === "connections") return order === "asc" ? "连接数从少到多" : "连接数从多到少";
  return order === "asc" ? "最近延迟从低到高" : "最近延迟从高到低";
}

function aiRuleRankValueText(metric: AiRuleRankMetric, summary: AiRuleTrafficSummary & { latestLatencyMs?: number | null; latestLatencyIsTimeout?: boolean }) {
  if (metric === "traffic") return `<b>${escapeHtml(formatBytes(summary.bytesIn + summary.bytesOut))}</b>`;
  if (metric === "connections") return `<b>${Math.max(0, Number(summary.connections || 0))}</b> 次`;
  if (summary.latestLatencyIsTimeout) return "<b>超时</b>";
  return summary.latestLatencyMs == null ? "暂无延迟" : `<b>${escapeHtml(`${summary.latestLatencyMs} ms`)}</b>`;
}

function aiRuleRankSortValue(metric: AiRuleRankMetric, summary: AiRuleTrafficSummary & { latestLatencyMs?: number | null; latestLatencyIsTimeout?: boolean }, order: AiRuleRankOrder) {
  if (metric === "traffic") return Math.max(0, Number(summary.bytesIn || 0)) + Math.max(0, Number(summary.bytesOut || 0));
  if (metric === "connections") return Math.max(0, Number(summary.connections || 0));
  if (summary.latestLatencyIsTimeout) return Number.POSITIVE_INFINITY;
  if (summary.latestLatencyMs == null) return order === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return Math.max(0, Number(summary.latestLatencyMs || 0));
}

async function aiRuleRankText(user: any, options: { metric?: AiRuleRankMetric; order?: AiRuleRankOrder; keyword?: string; userKeyword?: string; hostKeyword?: string; ruleStatus?: AiRuleStatusFilter; limit?: number }) {
  const metric = options.metric || "traffic";
  const order = options.order || "desc";
  const limit = normalizeAiRuleRankLimit(options.limit) || 5;
  const { rules, matched, hostById, keyword, userKeyword, hostKeyword, ruleStatus } = await aiRulesWithFilters(user, {
    keyword: options.keyword,
    userKeyword: options.userKeyword,
    hostKeyword: options.hostKeyword,
    ruleStatus: options.ruleStatus,
  });
  const filterText = aiRuleFilterSuffix({ keyword, userKeyword, hostKeyword, ruleStatus });
  const header = aiResultHeader(aiRuleRankTitle(metric, order), matched.length, rules.length, "条", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到可排行的规则。`;

  const ids = matched.map((rule: any) => Number(rule.id)).filter((id: number) => Number.isFinite(id) && id > 0);
  const summaryByRuleId = new Map<number, AiRuleTrafficSummary & { latestLatencyMs?: number | null; latestLatencyIsTimeout?: boolean }>();
  for (const id of ids) summaryByRuleId.set(id, emptyAiRuleTrafficSummary());
  const rows = await db.getTrafficCounterSummaryByRule({
    userId: user.role === "admin" ? undefined : user.id,
    ruleIds: ids,
    includeLatency: true,
  }).catch(() => [] as any[]);
  for (const row of rows as any[]) {
    const ruleId = Number(row?.ruleId || 0);
    if (!ruleId) continue;
    const prev = summaryByRuleId.get(ruleId) || emptyAiRuleTrafficSummary();
    prev.bytesIn += Math.max(0, Number(row?.bytesIn || 0));
    prev.bytesOut += Math.max(0, Number(row?.bytesOut || 0));
    prev.connections += Math.max(0, Number(row?.connections || 0));
    prev.latestLatencyIsTimeout = !!row?.latestLatencyIsTimeout;
    prev.latestLatencyMs = row?.latestLatencyMs == null ? null : Number(row.latestLatencyMs);
    summaryByRuleId.set(ruleId, prev);
  }

  const ranked = (matched as any[])
    .map((rule: any) => ({ rule, summary: summaryByRuleId.get(Number(rule.id)) || emptyAiRuleTrafficSummary() }))
    .sort((a, b) => {
      const av = aiRuleRankSortValue(metric, a.summary, order);
      const bv = aiRuleRankSortValue(metric, b.summary, order);
      if (av === bv) return Number(a.rule.id || 0) - Number(b.rule.id || 0);
      return order === "asc" ? av - bv : bv - av;
    });
  const visible = ranked.slice(0, limit);
  const lines = visible.map((item, index) => {
    const rule = item.rule;
    const summary = item.summary;
    const statusInfo = effectiveRuleStatusInfo(rule, summary);
    const host = hostById.get(Number(rule.hostId));
    const note = String(rule.remark || rule.remarks || rule.description || "").trim();
    const title = shortText(note || rule.name || `规则 #${rule.id}`, 30);
    const location = rule.tunnelId
      ? `归属：隧道 ${aiCode(`#${rule.tunnelId}`)}`
      : `归属：主机 ${aiCode(`#${rule.hostId}`)}${host?.name ? `（${escapeHtml(shortText(host.name, 18))}）` : ""}`;
    const details = [
      `排名值：${aiRuleRankValueText(metric, summary)}`,
      metric !== "traffic" ? `流量：${aiCode(formatBytes(summary.bytesIn + summary.bytesOut))}` : `入 / 出：${aiCode(formatBytes(summary.bytesIn))} / ${aiCode(formatBytes(summary.bytesOut))}`,
      metric !== "connections" && summary.connections > 0 ? `连接：<b>${summary.connections}</b>` : "",
      `状态：<b>${escapeHtml(effectiveRuleStatusText(rule, summary))}</b>`,
      statusInfo.detail ? `说明：${escapeHtml(statusInfo.detail)}` : "",
      `入口：${aiCode(`:${rule.sourcePort ?? "-"}`)} → 目标：${aiCode(`${rule.targetIp || "-"}:${rule.targetPort ?? "-"}`)}`,
      location,
      note && note !== rule.name ? `备注：${escapeHtml(shortText(note, 32))}` : "",
    ];
    return [`<b>${index + 1}. #${rule.id} ${escapeHtml(title)}</b>`, aiBlockquote(details)].join("\n");
  });
  const shownText = ranked.length > visible.length ? `\n\n<i>已按${escapeHtml(aiRuleRankMetricLabel(metric, order))}展示前 ${visible.length} 条，还有 ${ranked.length - visible.length} 条未展示。</i>` : `\n\n<i>已按${escapeHtml(aiRuleRankMetricLabel(metric, order))}排序。</i>`;
  return `${header}\n\n${lines.join("\n\n")}${shownText}`;
}

async function aiRuleDetailText(user: any, ruleId: number) {
  const rules = await visibleRulesForTelegramUser(user);
  const rule = rules.find((item: any) => Number(item.id) === Number(ruleId));
  if (!rule) return "规则不存在或无权查看。";
  const traffic = (await aiRuleTrafficSummaryMap(user, [Number(rule.id)], { includeLatency: true })).get(Number(rule.id));
  const statusInfo = effectiveRuleStatusInfo(rule, traffic);
  return [
    `<b>规则 #${rule.id}</b>`,
    "",
    `名称：${escapeHtml(rule.name)}`,
    `状态：<b>${escapeHtml(effectiveRuleStatusText(rule, traffic))}</b>`,
    statusInfo.detail ? `说明：${escapeHtml(statusInfo.detail)}` : "",
    `类型：${aiCode(`${rule.forwardType || "-"} / ${formatForwardRuleProtocol(rule.protocol)}`)}`,
    `入口端口：${aiCode(`:${rule.sourcePort ?? "-"}`)}`,
    `目标：${aiCode(`${rule.targetIp || "-"}:${rule.targetPort ?? "-"}`)}`,
    rule.tunnelId ? `隧道：${aiCode(`#${rule.tunnelId}`)}` : `主机：${aiCode(`#${rule.hostId}`)}`,
    formatRuleTrafficSummary(traffic),
    rule.remark || rule.remarks || rule.description ? `备注：${escapeHtml(rule.remark || rule.remarks || rule.description)}` : "",
  ].filter(Boolean).join("\n");
}

async function aiRuleUsageText(user: any, ruleId: number) {
  const rules = await visibleRulesForTelegramUser(user);
  const rule = rules.find((item: any) => Number(item.id) === Number(ruleId));
  if (!rule) return "规则不存在或无权查看。";
  const traffic = (await aiRuleTrafficSummaryMap(user, [Number(rule.id)])).get(Number(rule.id));
  return [
    `<b>规则 #${rule.id} 流量</b>`,
    "",
    `名称：${escapeHtml(rule.name)}`,
    `入口：${aiCode(`:${rule.sourcePort ?? "-"}`)} → 目标：${aiCode(`${rule.targetIp || "-"}:${rule.targetPort ?? "-"}`)}`,
    formatRuleTrafficSummary(traffic),
  ].filter(Boolean).join("\n");
}

async function aiHostsText(user: any, keyword?: string) {
  const safeKeyword = normalizeAiQueryKeyword(keyword);
  const hosts = await visibleHostsForTelegramUser(user);
  const matched = hosts.filter((host) => searchMatches(safeKeyword, hostSearchValues(host)));
  const filterText = safeKeyword ? aiFilterPart("关键字", safeKeyword) : "";
  const header = aiResultHeader("主机查询", matched.length, hosts.length, "台", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到匹配的主机。`;
  const visible = matched.slice(0, AI_QUERY_RESULT_LIMIT);
  const lines = visible.map((host: any) => {
    const address = host.ip || host.ipv4 || host.ipv6 || "-";
    return [
      `<b>#${host.id} ${escapeHtml(shortText(host.name, 28))}</b>`,
      `状态：<b>${escapeHtml(onlineStatusText(host.isOnline))}</b>`,
      `地址：${aiCode(address)}`,
      host.ipv4 && host.ipv4 !== address ? `IPv4：${aiCode(host.ipv4)}` : "",
      host.ipv6 && host.ipv6 !== address ? `IPv6：${aiCode(host.ipv6)}` : "",
      host.entryIp ? `入口：${aiCode(host.entryIp)}` : "",
      host.tunnelEntryIp ? `内网入口：${aiCode(host.tunnelEntryIp)}` : "",
      host.agentVersion ? `Agent：${aiCode(host.agentVersion)}` : "",
      host.lastHeartbeat ? `心跳：${escapeHtml(formatDateTime(host.lastHeartbeat))}` : "",
    ].filter(Boolean).join("\n");
  });
  return `${header}\n\n${lines.join("\n\n")}${moreText(matched.length, visible.length)}`;
}

async function aiTunnelsText(user: any, keyword?: string) {
  const safeKeyword = normalizeAiQueryKeyword(keyword);
  const tunnels = await visibleTunnelsForTelegramUser(user);
  const hostIds = tunnels.flatMap((tunnel: any) => [Number(tunnel.entryHostId || 0), Number(tunnel.exitHostId || 0)]);
  const hostsById = await hostNameByIdMap(hostIds);
  const matched = tunnels.filter((tunnel: any) => {
    const entryHost = hostsById.get(Number(tunnel.entryHostId || 0));
    const exitHost = hostsById.get(Number(tunnel.exitHostId || 0));
    return searchMatches(safeKeyword, tunnelSearchValues(tunnel, entryHost, exitHost));
  });
  const filterText = safeKeyword ? aiFilterPart("关键字", safeKeyword) : "";
  const header = aiResultHeader("链路查询", matched.length, tunnels.length, "条", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到匹配的链路。`;
  const visible = matched.slice(0, AI_QUERY_RESULT_LIMIT);
  const lines = visible.map((tunnel: any) => {
    const entryHost = hostsById.get(Number(tunnel.entryHostId || 0));
    const exitHost = hostsById.get(Number(tunnel.exitHostId || 0));
    const latency = tunnel.latestLatencyMs ?? tunnel.lastLatencyMs;
    return [
      `<b>#${tunnel.id} ${escapeHtml(shortText(tunnel.name, 28))}</b>`,
      `状态：<b>${escapeHtml(runningStatusText(tunnel.isRunning))}</b>`,
      `路径：${aiCode(entryHost?.name || tunnel.entryHostId || "-")} → ${aiCode(exitHost?.name || tunnel.exitHostId || "-")}`,
      `模式：${aiCode(tunnel.mode || "-")}${tunnel.networkType ? ` · 网络：${aiCode(tunnel.networkType)}` : ""}`,
      tunnel.listenPort ? `出口端口：${aiCode(tunnel.listenPort)}` : "",
      tunnel.connectHost ? `连接地址：${aiCode(tunnel.connectHost)}` : "",
      latency != null ? `延迟：<b>${escapeHtml(`${latency} ms`)}</b>` : "",
      tunnel.remark || tunnel.remarks || tunnel.description ? `备注：${escapeHtml(shortText(tunnel.remark || tunnel.remarks || tunnel.description, 32))}` : "",
    ].filter(Boolean).join("\n");
  });
  return `${header}\n\n${lines.join("\n\n")}${moreText(matched.length, visible.length)}`;
}

async function aiForwardGroupsText(user: any, keyword?: string) {
  const safeKeyword = normalizeAiQueryKeyword(keyword);
  const groups = await visibleForwardGroupsForTelegramUser(user);
  const matched = groups.filter((group) => searchMatches(safeKeyword, forwardGroupSearchValues(group)));
  const filterText = safeKeyword ? aiFilterPart("关键字", safeKeyword) : "";
  const header = aiResultHeader("转发组查询", matched.length, groups.length, "个", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到匹配的转发组。`;
  const visible = matched.slice(0, AI_QUERY_RESULT_LIMIT);
  const lines = visible.map((group: any) => [
    `<b>#${group.id} ${escapeHtml(shortText(group.name, 28))}</b>`,
    `状态：<b>${group.isEnabled === false ? "已停用" : "已启用"}</b>`,
    `类型：${aiCode(`${group.groupType || "-"} / ${group.groupMode || "-"}`)}`,
    group.remark || group.remarks || group.description ? `备注：${escapeHtml(shortText(group.remark || group.remarks || group.description, 32))}` : "",
  ].filter(Boolean).join("\n"));
  return `${header}\n\n${lines.join("\n\n")}${moreText(matched.length, visible.length)}`;
}

async function aiUsersText(user: any, keyword?: string) {
  const safeKeyword = normalizeAiQueryKeyword(keyword);
  if (user.role !== "admin") {
    return [userInfoText(user), "", await usageText(user)].join("\n");
  }
  const users = await db.getUserTrafficSummaries();
  const exactUserId = /^\d+$/.test(safeKeyword) ? Number(safeKeyword) : undefined;
  const matchedById = exactUserId ? (users as any[]).filter((item) => Number(item.id) === exactUserId) : [];
  const matched = matchedById.length > 0
    ? matchedById
    : (users as any[]).filter((item) => searchMatches(safeKeyword, [item.id, item.name, item.username, item.role, item.email, item.telegramUsername]));
  const filterText = safeKeyword ? aiFilterPart("关键字", safeKeyword) : "";
  const header = aiResultHeader("用户查询", matched.length, users.length, "个", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到匹配的用户。`;
  const visible = matched.slice(0, AI_QUERY_RESULT_LIMIT);
  const lines = visible.map((item: any) => {
    const limit = Number(item.trafficLimit) || 0;
    const trafficUsed = escapeHtml(formatBytes(item.trafficUsed));
    const trafficLimit = limit > 0 ? escapeHtml(formatBytes(limit)) : "不限";
    return [
      `<b>#${item.id} ${escapeHtml(shortText(item.name || item.username, 22))}</b>`,
      `角色：<b>${item.role === "admin" ? "管理员" : "用户"}</b> · 用户名：${aiCode(item.username || "-")}`,
      item.telegramUsername ? `TG：${aiCode(item.telegramUsername)}` : "",
      `流量：<b>${trafficUsed}</b> / ${trafficLimit}`,
      `到期：${escapeHtml(formatDate(item.expiresAt))}`,
    ].filter(Boolean).join("\n");
  });
  return `${header}\n\n${lines.join("\n\n")}${moreText(matched.length, visible.length)}`;
}

function aiQueryHelpText() {
  return [
    "<b>自然语言查询</b>",
    "",
    "可以直接发送：",
    `${aiCode("我的流量")}`,
    `${aiCode("查规则 443")}`,
    `${aiCode("异常规则有没有")}`,
    `${aiCode("规则 #12 详情")}`,
    `${aiCode("第9条规则用了多少流量")}`,
    `${aiCode("哪个规则流量最多")}`,
    `${aiCode("规则延迟最高的前 5 条")}`,
    `${aiCode("9号规则用了多少流量")}`,
    `${aiCode("用户1的使用详情")}`,
    `${aiCode("列出张三用户上海主机的规则")}`,
    `${aiCode("现在有哪些用户")}`,
    `${aiCode("主机 上海")}`,
    `${aiCode("链路 东京")}`,
    "",
    "<b>管理操作（需要点击确认后才会执行）</b>",
    `${aiCode("给用户 1 充值 50")}`,
    `${aiCode("给我充点钱（会继续追问金额）")}`,
    `${aiCode("把用户 test111 余额设置为 88")}`,
    `${aiCode("给用户1续费 3 个月")}`,
    `${aiCode("停用用户 3937064828@qq.com")}`,
    `${aiCode("启用用户 #5")}`,
    `${aiCode("关闭用户1转发")}`,
    `${aiCode("启用 test111 转发")}`,
    `${aiCode("关闭第 12 条规则")}`,
    `${aiCode("开启 #9 号规则")}`,
    `${aiCode("关闭 东京 隧道 的规则")}`,
    `${aiCode("开启 2 号隧道的规则")}`,
    `${aiCode("给我增加一个转发到 10.10.0.1 的 5151 端口")}`,
    `${aiCode("给我加一个端口转发到 1.1.1.1:443，源端口随机")}`,
    `${aiCode("给我增加一个隧道转发到 10.10.0.1:5151，隧道 东京01")}`,
    `${aiCode("删除转发到 10.10.0.1:5151 的规则")}`,
    `${aiCode("删除第 12 条规则")}`,
    `${aiCode("重置用户 1 流量")}`,
    "",
    "<b>普通用户可用操作（仅限自己）</b>",
    `${aiCode("关闭我的转发")}`,
    `${aiCode("启用我的转发")}`,
    "",
    "<i>新增转发时，若未说明“端口转发/隧道转发”会先弹出选择；未提供源端口时默认随机分配。</i>",
    "",
    "<i>所有写操作都会先生成确认卡片，点击“确认执行”后才会生效。</i>",
  ].join("\n");
}

export async function aiQueryText(user: any, rawText: string) {
  const query = rawText.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!query) return aiQueryHelpText();
  const parsed = await parseAiQueryIntent(query);
  switch (parsed.intent) {
    case "usage":
      return usageText(user);
    case "account":
      return userInfoText(user);
    case "rules": {
      return aiRulesText(user, {
        keyword: parsed.keyword,
        userKeyword: extractUserFilterKeyword(query),
        hostKeyword: extractHostFilterKeyword(query),
        ruleStatus: parsed.ruleStatus || extractAiRuleStatusFilter(query),
      });
    }
    case "rule_detail": {
      const ruleId = parsed.id || extractRuleId(query);
      return ruleId ? aiRuleDetailText(user, ruleId) : aiRulesText(user, {
        keyword: parsed.keyword,
        ruleStatus: parsed.ruleStatus || extractAiRuleStatusFilter(query),
      });
    }
    case "rule_usage": {
      const ruleId = parsed.id || extractRuleId(query);
      return ruleId ? aiRuleUsageText(user, ruleId) : aiRulesText(user, {
        keyword: parsed.keyword,
        userKeyword: extractUserFilterKeyword(query),
        hostKeyword: extractHostFilterKeyword(query),
        ruleStatus: parsed.ruleStatus || extractAiRuleStatusFilter(query),
      });
    }
    case "rule_rank":
      return aiRuleRankText(user, {
        metric: parsed.rankMetric,
        order: parsed.rankOrder,
        keyword: parsed.keyword,
        userKeyword: extractUserFilterKeyword(query),
        hostKeyword: extractHostFilterKeyword(query),
        ruleStatus: parsed.ruleStatus || extractAiRuleStatusFilter(query),
        limit: parsed.limit,
      });
    case "hosts":
      return aiHostsText(user, parsed.keyword);
    case "tunnels":
      return aiTunnelsText(user, parsed.keyword);
    case "forward_groups":
      return aiForwardGroupsText(user, parsed.keyword);
    case "users": {
      const userKeyword = parsed.keyword || normalizeUserLookupKeyword(extractUserFilterKeyword(query));
      return aiUsersText(user, userKeyword);
    }
    case "unsupported":
      return "未识别到可执行的指令。可以先发查询，或直接说明要调整什么（例如：给用户1充值50、关闭我的转发），系统会先要求二次确认。";
    case "help":
    default:
      return aiQueryHelpText();
  }
}
