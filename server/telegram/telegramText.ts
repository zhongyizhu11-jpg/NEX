/*
  Telegram 机器人：纯文本层 —— 解析用户输入（关键词、数字、中文数词、动作意图的词法）、格式化输出、常量。不碰数据库、不发消息，也不引用别的 telegram 文件。
  2026-11-23 从 telegramBot.ts（6483 行）拆出；外部调用方仍从 telegramBot.ts 导入，那里原样转发。
*/
import { billingCalendarParts } from "../../shared/billingTime";
import { formatBytes } from "../../shared/formatBytes";
import { escapeHtmlText as escapeHtml } from "../../shared/htmlEscape";

export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;

export const LOGIN_SUCCESS_MESSAGE_DELETE_MS = 60 * 1000;

export const BIND_SESSION_TTL_MS = 10 * 60 * 1000;

export const REDEEM_SESSION_TTL_MS = 10 * 60 * 1000;

export const USER_PAGE_SIZE = 10;

export const RULE_PAGE_SIZE = 10;

export const AI_QUERY_RESULT_LIMIT = 10;

export const AI_PROCESSING_MESSAGE_DELAY_MS = 800;

export const AI_PROCESSING_MESSAGE_TEXT = "正在处理，请稍候…";

export const AI_INTERACTION_RATE_LIMIT = 20;

export const AI_INTERACTION_RATE_WINDOW_MS = 60 * 1000;

export const TELEGRAM_UPDATE_CONCURRENCY = 8;

export const MANAGE_ACTION_CONFIRM_TTL_MS = 10 * 60 * 1000;

export const MANAGE_CLARIFY_TTL_MS = 60 * 1000;

export const MANAGE_BALANCE_MAX_CENTS = 100_000_000;

export const MANAGE_CODE_MAX_COUNT = 500;

export const MANAGE_CODE_DISPLAY_LIMIT = 60;

export const UPDATE_ACTION_CONFIRM_TTL_MS = 5 * 60 * 1000;

export const UPDATE_COMMAND_COOLDOWN_MS = 60 * 1000;

export const UPDATE_AGENT_PREVIEW_LIMIT = 15;

const GENERIC_AI_QUERY_KEYWORD_RE = /^(帮我|请|给我|查|查下|查一下|查询|查看|看看|看下|看一下|显示|列出|搜索|我的|我|全部|所有|当前|现在|目前|已有|有的|有|哪些|哪个|哪一个|哪条|哪一条|谁|列表|信息|状态|详情|是多少|多少|用了|使用|消耗|占用|用量|流量|连接|连接数|延迟|速度|额度|余额|套餐|转发规则|规则|端口|转发|主机|机器|节点|隧道|链路|转发链|转发组|入口组|用户|账户|账号|排行|排名|最多|最少|最高|最低|最大|最小|最快|最慢|最卡|第一|top|前|的|吗)+$/;

export function randomCode(length = 32) {
  let out = "";
  while (out.length < length) out += crypto.randomUUID().replace(/-/g, "");
  return out.slice(0, length).toUpperCase();
}

export function formatMoneyCny(cents: number | string | null | undefined) {
  return `¥${((Number(cents) || 0) / 100).toFixed(2)}`;
}

export function formatDate(value: unknown) {
  if (!value) return "永久有效";
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? "永久有效" : date.toLocaleDateString("zh-CN");
}

export function formatDateTime(value: unknown) {
  if (!value) return "永久有效";
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? "永久有效" : date.toLocaleString("zh-CN");
}

export function clampPage(page: number, total: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
  return { page: safePage, totalPages };
}

export function shortText(value: unknown, length = 18) {
  const text = String(value || "-");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function formatUserLabel(user: any) {
  return `#${Number(user?.id || 0)} ${escapeHtml(user?.name || user?.username || "-")}`;
}

export function formatDiscountPercentLabel(discountPercent: number | string | null | undefined) {
  const offPercent = Math.max(1, Math.min(100, Math.round(Number(discountPercent || 0))));
  const payPercent = Math.max(0, 100 - offPercent);
  const zheText = payPercent % 10 === 0
    ? String(payPercent / 10)
    : (payPercent / 10).toFixed(1).replace(/\.0$/, "");
  return `${zheText} 折（减 ${offPercent}%）`;
}

export function formatManageRulePreview(rule: any) {
  const name = shortText(rule?.name || "-", 24);
  const sourcePort = rule?.sourcePort ?? "-";
  const targetIp = rule?.targetIp || "-";
  const targetPort = rule?.targetPort ?? "-";
  return `#${Number(rule?.id || 0)} ${name} :${sourcePort} -> ${targetIp}:${targetPort}`;
}

export function formatRuleButtonLabel(rule: any) {
  const label = String(rule?.remark || rule?.remarks || rule?.description || rule?.name || "").trim();
  return shortText(label || `规则 #${Number(rule?.id || 0)}`, 16);
}

export const MANAGE_RULE_TARGET_HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/;

export function parseCommand(text: string) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const command = (parts.shift() || "").split("@")[0].toLowerCase();
  return { command, args: parts };
}

export const HOST_PAGE_SIZE = 8;

export const ROUTE_PAGE_SIZE = 8;

export const RULE_TEST_WAIT_MS = 40_000;

export const RULE_TEST_POLL_MS = 2_000;

export function formatPercent(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)}%` : "-";
}

export function formatAgo(value: unknown) {
  if (!value) return "从未上报";
  const ms = Date.now() - new Date(value as any).getTime();
  if (!Number.isFinite(ms)) return "从未上报";
  if (ms < 60_000) return "刚刚";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)} 小时前`;
  return `${Math.floor(ms / 86400_000)} 天前`;
}

export function formatUptime(seconds: unknown) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${Math.floor((value % 3600) / 60)} 分`;
}

export function formatSpeed(bytesPerSecond: unknown) {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value < 0) return "-";
  return `${formatBytes(value)}/s`;
}

function parseRuleTestMessage(raw: unknown) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { message: "", details: [] as any[], totalLatencyMs: null as number | null, tunnelLatencyMs: null as number | null };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return {
        message: typeof parsed.message === "string" ? parsed.message : "",
        details: Array.isArray(parsed.details) ? parsed.details : [],
        totalLatencyMs: typeof parsed.totalLatencyMs === "number" ? parsed.totalLatencyMs : null,
        tunnelLatencyMs: typeof parsed.tunnelLatencyMs === "number" && parsed.tunnelLatencyMs > 0 ? parsed.tunnelLatencyMs : null,
      };
    }
  } catch {
    // 老结果是纯文本。
  }
  return { message: text, details: [] as any[], totalLatencyMs: null as number | null, tunnelLatencyMs: null as number | null };
}

export function formatRuleTestResult(rule: any, test: any, recent = "") {
  const parsed = parseRuleTestMessage(test?.message);
  const status = String(test?.status || "");
  const latency = parsed.totalLatencyMs ?? (typeof test?.latencyMs === "number" && test.latencyMs > 0 ? test.latencyMs : null);
  const head = status === "success"
    ? `✅ 通过${latency !== null ? ` · 延迟 <b>${Math.round(latency)} ms</b>` : ""}`
    : status === "timeout"
      ? "⏱ 超时"
      : "❌ 没通过";
  const hops = parsed.details
    .filter((item: any) => item && !item.pending)
    .slice(0, 8)
    .map((item: any) => {
      const label = String(item.routeLabel || item.hopLabel || "链路").replace(/^第\s*\d+\s*跳\s*/, "");
      const value = item.success
        ? (typeof item.latencyMs === "number" ? `${Math.round(item.latencyMs)} ms` : "通")
        : `不通${item.message ? `（${shortText(item.message, 40)}）` : ""}`;
      return `· ${escapeHtml(shortText(label, 30))}：${escapeHtml(value)}`;
    });
  // 单跳隧道没有逐跳明细，隧道段延迟单独带回来；落地不通时靠这一行看出隧道本身是好的。
  const tunnelLine = parsed.tunnelLatencyMs !== null && !parsed.details.some((item: any) => item?.toHostId)
    ? `· 隧道段：${Math.round(parsed.tunnelLatencyMs)} ms`
    : "";
  return `<b>测延迟 · 规则 #${rule.id}</b> ${escapeHtml(shortText(rule.name, 24))}\n\n` + [
    head,
    tunnelLine,
    ...hops,
    status !== "success" && parsed.message ? `原因：${escapeHtml(shortText(parsed.message, 160))}` : "",
    recent ? `\n${escapeHtml(recent)}` : "",
    test?.updatedAt ? `测试时间：${escapeHtml(formatAgo(test.updatedAt))}` : "",
  ].filter(Boolean).join("\n");
}

export function formatPinUntil(untilMs: unknown) {
  const value = Number(untilMs);
  if (!Number.isFinite(value) || value <= 0) return "一直";
  const parts = billingCalendarParts(value);
  return `到 ${parts.month}月${parts.day}日 ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function normalizeKeyword(value: unknown) {
  return String(value || "").trim().slice(0, 80);
}

function isGenericAiQueryKeyword(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .replace(/^\/ask(?:@\w+)?\s*/i, "")
    .replace(/[\s，,。？?！!：:、的]+/g, "");
  if (!normalized) return true;
  if (/^\d+$/.test(normalized)) return false;
  return GENERIC_AI_QUERY_KEYWORD_RE.test(normalized);
}

function parseChineseNumeralToken(raw: string) {
  const normalized = String(raw || "").trim();
  if (!normalized) return undefined;
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(normalized)) return undefined;
  const digitMap: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const unitMap: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let section = 0;
  let current = 0;
  for (const ch of normalized) {
    if (Object.prototype.hasOwnProperty.call(digitMap, ch)) {
      current = digitMap[ch];
      continue;
    }
    const unit = unitMap[ch];
    if (!unit) return undefined;
    if (current === 0) current = 1;
    section += current * unit;
    current = 0;
  }
  const result = section + current;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

export function parseNumericToken(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^第/, "")
    .replace(/[号条个]$/, "");
  if (!normalized) return undefined;
  if (/^\d+$/.test(normalized)) {
    const id = Number(normalized);
    return Number.isFinite(id) && id > 0 ? id : undefined;
  }
  return parseChineseNumeralToken(normalized);
}

function normalizeNumericKeyword(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = parseNumericToken(raw);
  return parsed ? String(parsed) : raw;
}

export function normalizeAiQueryKeyword(value: unknown) {
  const keyword = normalizeNumericKeyword(normalizeKeyword(value));
  return isGenericAiQueryKeyword(keyword) ? "" : keyword;
}

export function normalizeAiRuleRankLimit(value: unknown) {
  const parsed = parseNumericToken(value);
  const numeric = Number.isFinite(parsed as number) ? Number(parsed) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.min(AI_QUERY_RESULT_LIMIT, Math.max(1, Math.floor(numeric)));
}

export function extractAiRuleRankLimit(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  const match = raw.match(/(?:top|前)\s*([0-9零〇一二两三四五六七八九十百千]+)/i)
    || raw.match(/([0-9零〇一二两三四五六七八九十百千]+)\s*(?:条|个)?\s*(?:规则)?(?:流量|连接数?|延迟)?(?:排行|排名)/i);
  return normalizeAiRuleRankLimit(match?.[1]);
}

export function extractRuleRankKeyword(text: string) {
  const cleaned = stripAiEntityClauses(text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim())
    .replace(/(?:top|前)\s*[0-9零〇一二两三四五六七八九十百千]*/gi, " ")
    .replace(/(帮我|请|给我|一下|查下|查一下|查询|查看|看看|看下|看一下|显示|列出|搜索|我的|我|全部|所有|当前|现在|目前|已有|有的|有哪些|有|哪个|哪一个|哪条|哪一条|谁|转发规则|规则详情|规则|rule|端口|port|转发|信息|状态|详情|列表|哪些|是多少|多少|用了|使用|消耗|占用|用量|流量|连接数|连接|会话|延迟|耗时|响应|速度|排行|排名|最多|最少|最高|最低|最大|最小|最快|最慢|最卡|第一|额度|余额|套餐|的|条|个|项|名)/gi, " ")
    .replace(/[，,。？?！!：:、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeAiQueryKeyword(cleaned);
}

export function extractRuleId(text: string) {
  const match = text.match(/(?:规则|rule)\s*#?\s*([0-9零〇一二两三四五六七八九十百千]+)/i)
    || text.match(/第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*条?\s*(?:规则|rule)/i)
    || text.match(/([0-9零〇一二两三四五六七八九十百千]+)\s*(?:号|条|#)?\s*(?:规则|rule)/i)
    || text.match(/#\s*([0-9]+)/);
  return parseNumericToken(match?.[1]);
}

function extractExplicitSearchKeyword(text: string) {
  const trimmed = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  const explicit = trimmed.match(/(?:关键字|关键词|搜索|端口|名称|备注|IP|ip|域名)[:：]?\s*([^\s，,。]+)/);
  return normalizeAiQueryKeyword(explicit?.[1]);
}

function cleanAiEntityKeyword(value: unknown) {
  const cleaned = String(value || "")
    .replace(/^(帮我|请|给我|把|将|列出|显示|查看|查询|看看|看下|看一下|现在|当前|目前|已有|有的|所有|全部)+/g, "")
    .replace(/(的|下|一下)$/g, "");
  return normalizeAiQueryKeyword(cleaned);
}

export function normalizeUserLookupKeyword(value: unknown) {
  const cleaned = String(value || "")
    .replace(/^(?:用户|账户|账号|user)\s*/i, "")
    .trim();
  return cleanAiEntityKeyword(cleaned);
}

export function extractUserFilterKeyword(text: string) {
  const before = text.match(/([^\s，,。？?！!：:、的]+?)\s*(?:用户|账户|账号|user)(?=主机|机器|节点|规则|转发|端口|$|[\s，,。？?！!：:、的])/i);
  const beforeKeyword = cleanAiEntityKeyword(before?.[1]);
  if (beforeKeyword) return beforeKeyword;
  const after = text.match(/(?:用户|账户|账号|user)\s*[:：]?\s*([^\s，,。？?！!：:、的]+?)(?=主机|机器|节点|规则|转发|端口|$|[\s，,。？?！!：:、的])/i);
  return cleanAiEntityKeyword(after?.[1]);
}

export function extractHostFilterKeyword(text: string) {
  const cleanHostKeyword = (value: unknown) => cleanAiEntityKeyword(String(value || "").replace(/^.*(?:用户|账户|账号|user)/i, ""));
  const before = text.match(/([^\s，,。？?！!：:、的]+?)\s*(?:主机|机器|节点|agent|host|server)(?=规则|转发|端口|$|[\s，,。？?！!：:、的])/i);
  const beforeKeyword = cleanHostKeyword(before?.[1]);
  if (beforeKeyword) return beforeKeyword;
  const after = text.match(/(?:主机|机器|节点|agent|host|server)\s*[:：]?\s*([^\s，,。？?！!：:、的]+?)(?=规则|转发|端口|$|[\s，,。？?！!：:、的])/i);
  return cleanHostKeyword(after?.[1]);
}

function stripAiEntityClauses(text: string) {
  return text
    .replace(/(?:用户|账户|账号|user)\s*[:：]?\s*[^\s，,。？?！!：:、的]+/gi, " ")
    .replace(/[^\s，,。？?！!：:、]+\s*(?:用户|账户|账号|user)/gi, " ")
    .replace(/(?:主机|机器|节点|agent|host|server)\s*[:：]?\s*[^\s，,。？?！!：:、的]+/gi, " ")
    .replace(/[^\s，,。？?！!：:、]+\s*(?:主机|机器|节点|agent|host|server)/gi, " ");
}

export function extractSearchKeyword(text: string) {
  const explicit = extractExplicitSearchKeyword(text);
  if (explicit) return explicit;
  const cleaned = stripAiEntityClauses(text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim())
    .replace(/(帮我|请|给我|一下|查下|查一下|查询|查看|看看|看下|看一下|显示|列出|搜索|我的|我|全部|所有|当前|现在|目前|已有|有的|有哪些|有|转发规则|规则详情|规则|主机|机器|节点|隧道|链路|转发链|转发组|入口组|用户|账户|账号|信息|状态|详情|列表|哪些|哪条|是多少|多少|用了|使用|消耗|占用|用量|流量|额度|余额|套餐)/g, " ")
    .replace(/[，,。？?！!：:、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeAiQueryKeyword(cleaned);
}

export function normalizeManageTargetKeyword(value: unknown) {
  let keyword = String(value || "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^目标[:：]?\s*/i, "")
    .replace(/^用户[:：]?\s*/i, "")
    .replace(/^账号[:：]?\s*/i, "")
    .replace(/^账户[:：]?\s*/i, "")
    .trim();
  if (!keyword) return "";
  const parsed = parseNumericToken(keyword.replace(/^#/, ""));
  if (parsed) return String(parsed);
  return keyword.slice(0, 80);
}

export function extractManageTargetKeyword(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return "";
  if (/(我的|我自己|本人|self|me)/i.test(raw)) return "self";

  const explicit = raw.match(/(?:用户|账号|账户|user)\s*[:：#]?\s*([^\s，,。；;！？!?]+)/i);
  if (explicit?.[1]) return normalizeManageTargetKeyword(explicit[1]);

  const email = raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (email?.[0]) return normalizeManageTargetKeyword(email[0]);

  const hashId = raw.match(/#\s*([0-9]+)/);
  if (hashId?.[1]) return normalizeManageTargetKeyword(hashId[1]);

  const viaVerb = raw.match(/(?:给|把|将|帮(?:我)?|为)\s*([^\s，,。；;！？!?]+)\s*(?:充值|续费|停用|启用|关闭|开启|重置|设置|调整|转发|流量|账号|账户|用户)/i);
  if (viaVerb?.[1]) return normalizeManageTargetKeyword(viaVerb[1]);

  return "";
}

export function extractManageAmountYuan(text: string) {
  const cleaned = text
    .replace(/(?:用户|账号|账户|user)\s*#?\s*[0-9零〇一二两三四五六七八九十百千]+/gi, " ")
    .replace(/#\s*[0-9]+/g, " ");
  const withCurrency = cleaned.match(/([+-]?\d+(?:\.\d+)?)\s*(?:元|块|rmb|RMB|¥|￥)/);
  if (withCurrency?.[1]) {
    const amount = Number(withCurrency[1]);
    return Number.isFinite(amount) ? amount : undefined;
  }
  const nearVerb = cleaned.match(/(?:充值|充|加钱|加|增加|补款|退款|扣除|扣减|扣|减少|减去|调整(?:余额|金额)?|设置(?:余额)?(?:为|成)?|设为|改为|改成|变成)\s*([+-]?\d+(?:\.\d+)?)/);
  if (nearVerb?.[1]) {
    const amount = Number(nearVerb[1]);
    return Number.isFinite(amount) ? amount : undefined;
  }
  return undefined;
}

export function parseManageCodeCount(value: unknown) {
  const parsed = parseNumericToken(value);
  if (!Number.isFinite(parsed as number)) return undefined;
  const count = Math.floor(Number(parsed));
  if (!Number.isFinite(count) || count <= 0) return undefined;
  return count;
}

export function normalizeManageDiscountPercent(value: unknown) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 100) return undefined;
  return numeric;
}

export function extractManageCodeCount(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return undefined;

  const byCountAndCode = raw.match(
    /([0-9零〇一二两三四五六七八九十百千]+)\s*(?:个|张|份|组)\s*(?:[0-9]+(?:\.\d+)?\s*(?:元|块|¥|￥)?\s*)?(?:余额|充值|折扣|优惠)?(?:兑换码|折扣码|优惠码|代金码)/i,
  );
  if (byCountAndCode?.[1]) {
    return parseManageCodeCount(byCountAndCode[1]);
  }

  const byGenerateCount = raw.match(
    /(?:生成|创建|新增|来|发|做|弄)\s*([0-9零〇一二两三四五六七八九十百千]+)\s*(?:个|张|份|组)/i,
  );
  if (byGenerateCount?.[1]) {
    return parseManageCodeCount(byGenerateCount[1]);
  }

  const byDirectCount = raw.match(
    /(?:生成|创建|新增|来|发|做|弄|给我)\s*([0-9零〇一二两三四五六七八九十百千]+)\s*(?:个|张|份|组)?\s*(?:余额|充值|折扣|优惠)?(?:兑换码|折扣码|优惠码|代金码)/i,
  );
  if (byDirectCount?.[1]) {
    return parseManageCodeCount(byDirectCount[1]);
  }
  return undefined;
}

export function extractManageRedeemAmountYuan(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return undefined;

  const byCountThenAmount = raw.match(
    /(?:[0-9零〇一二两三四五六七八九十百千]+)\s*(?:个|张|份|组)\s*([+-]?\d+(?:\.\d+)?)\s*(?:元|块|¥|￥)?\s*(?:余额|充值)?(?:兑换码|代金码)/i,
  );
  if (byCountThenAmount?.[1]) {
    const amount = Number(byCountThenAmount[1]);
    if (Number.isFinite(amount)) return amount;
  }

  const byPer = raw.match(/(?:每个|每张|单个|面额|金额|额度)\s*[:：]?\s*([+-]?\d+(?:\.\d+)?)\s*(?:元|块|¥|￥)?/i);
  if (byPer?.[1]) {
    const amount = Number(byPer[1]);
    if (Number.isFinite(amount)) return amount;
  }

  const byCodeAmount = raw.match(/([+-]?\d+(?:\.\d+)?)\s*(?:元|块|¥|￥)?\s*(?:的)?\s*(?:余额|充值)?(?:兑换码|代金码)/i);
  if (byCodeAmount?.[1]) {
    const amount = Number(byCodeAmount[1]);
    if (Number.isFinite(amount)) return amount;
  }
  return undefined;
}

export function extractManageDiscountPercent(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return undefined;

  const byZhe = raw.match(/([0-9]+(?:\.\d+)?)\s*折/);
  if (byZhe?.[1]) {
    const zhe = Number(byZhe[1]);
    if (Number.isFinite(zhe) && zhe > 0 && zhe <= 10) {
      return normalizeManageDiscountPercent(Math.round((10 - zhe) * 10));
    }
  }

  const byPercent = raw.match(/([1-9]\d{0,2})\s*%\s*(?:off|折扣|优惠|折)?/i)
    || raw.match(/(?:减|优惠|折扣)\s*([1-9]\d{0,2})\s*%/i)
    || raw.match(/(?:减|优惠|折扣)\s*([1-9]\d{0,2})\s*(?:个点|百分点)/i)
    || raw.match(/^([1-9]\d{0,2})\s*%?$/i);
  if (byPercent?.[1]) {
    return normalizeManageDiscountPercent(byPercent[1]);
  }
  return undefined;
}

export function extractManageRuleId(text: string) {
  return extractRuleId(text);
}

export function normalizeManageTunnelKeyword(value: unknown) {
  let keyword = String(value || "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^目标[:：]?\s*/i, "")
    .replace(/^(?:隧道|链路|tunnel|link)\s*/i, "")
    .replace(/\s*(?:隧道|链路|tunnel|link)\s*$/i, "")
    .replace(/\s*(?:的)?\s*(?:规则|rule)\s*$/i, "")
    .trim();
  if (!keyword) return "";
  const parsed = parseNumericToken(keyword.replace(/^#/, ""));
  if (parsed) return String(parsed);
  return keyword.slice(0, 80);
}

export function extractManageTunnelKeyword(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return "";

  const byEntity = raw.match(/(?:隧道|链路|tunnel|link)\s*[:：#]?\s*([^\s，,。；;！？!?]+)/i);
  if (byEntity?.[1]) return normalizeManageTunnelKeyword(byEntity[1]);

  const byVerbBefore = raw.match(/(?:关闭|停用|禁用|开启|启用|恢复)\s*([^\s，,。；;！？!?]+)\s*(?:隧道|链路|tunnel|link)(?:的)?规则/i);
  if (byVerbBefore?.[1]) return normalizeManageTunnelKeyword(byVerbBefore[1]);

  const byVerbAfter = raw.match(/(?:关闭|停用|禁用|开启|启用|恢复)\s*(?:隧道|链路|tunnel|link)\s*([^\s，,。；;！？!?]+)(?:的)?规则/i);
  if (byVerbAfter?.[1]) return normalizeManageTunnelKeyword(byVerbAfter[1]);

  const byHashId = raw.match(/#\s*([0-9]+)\s*(?:隧道|链路|tunnel|link)/i);
  if (byHashId?.[1]) return normalizeManageTunnelKeyword(byHashId[1]);

  return "";
}

export function normalizeManageHostKeyword(value: unknown) {
  let keyword = String(value || "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^目标[:：]?\s*/i, "")
    .replace(/^(?:主机|机器|节点|agent|host|server)\s*/i, "")
    .replace(/\s*(?:主机|机器|节点|agent|host|server)\s*$/i, "")
    .trim();
  if (!keyword) return "";
  const parsed = parseNumericToken(keyword.replace(/^#/, ""));
  if (parsed) return String(parsed);
  return keyword.slice(0, 80);
}

export function extractManageHostKeyword(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return "";

  const byEntity = raw.match(/(?:主机|机器|节点|agent|host|server)\s*[:：#]?\s*([^\s，,。；;！？!?]+)/i);
  if (byEntity?.[1]) return normalizeManageHostKeyword(byEntity[1]);

  const byVerb = raw.match(/(?:添加|新增|增加|创建|删除|移除)\s*([^\s，,。；;！？!?]+)\s*(?:主机|机器|节点|agent|host|server)/i);
  if (byVerb?.[1]) return normalizeManageHostKeyword(byVerb[1]);

  const byHashId = raw.match(/#\s*([0-9]+)\s*(?:主机|机器|节点|agent|host|server)/i);
  if (byHashId?.[1]) return normalizeManageHostKeyword(byHashId[1]);

  return "";
}

export function normalizeManageTargetIp(value: unknown) {
  let host = String(value || "")
    .trim()
    .replace(/^目标[:：]?\s*/i, "")
    .replace(/^到\s*/i, "")
    .replace(/^转发到\s*/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  if (!host) return "";
  if (/^https?:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname || host;
    } catch {
      // ignore invalid URL parsing
    }
  }
  host = host.replace(/^\[+|\]+$/g, "").trim();
  return host.slice(0, 253);
}

export function parseManagePort(value: unknown) {
  const port = Math.floor(Number(value));
  if (!Number.isFinite(port) || port < 1 || port > 65535) return undefined;
  return port;
}

export function extractManageTargetEndpoint(text: string): { targetIp?: string; targetPort?: number } {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return {};

  const bracketHost = raw.match(/\[\s*([0-9a-fA-F:]+)\s*]\s*[:：]\s*(\d{1,5})/);
  if (bracketHost?.[1] && bracketHost?.[2]) {
    const targetPort = parseManagePort(bracketHost[2]);
    const targetIp = normalizeManageTargetIp(bracketHost[1]);
    if (targetIp && targetPort) return { targetIp, targetPort };
  }

  const toPort = raw.match(/(?:目标|转发到|到)\s*([A-Za-z0-9._:\-\[\]]+)\s*(?:的)?\s*(\d{1,5})\s*端口/i);
  if (toPort?.[1] && toPort?.[2]) {
    const targetPort = parseManagePort(toPort[2]);
    const targetIp = normalizeManageTargetIp(toPort[1]);
    if (targetIp && targetPort) return { targetIp, targetPort };
  }

  const hostPort = raw.match(/([A-Za-z0-9][A-Za-z0-9._:-]{1,252})\s*[:：]\s*(\d{1,5})/);
  if (hostPort?.[1] && hostPort?.[2]) {
    const targetPort = parseManagePort(hostPort[2]);
    const targetIp = normalizeManageTargetIp(hostPort[1]);
    if (targetIp && targetPort) return { targetIp, targetPort };
  }

  return {};
}

export function extractManageSourcePort(text: string): number | undefined {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return undefined;
  if (/(随机(?:源)?端口|自动(?:分配)?端口|auto\s*port)/i.test(raw)) return 0;

  const byName = raw.match(/(?:源端口|入口端口|监听端口|本地端口|source\s*port|listen\s*port)\s*[:：]?\s*(\d{1,5})/i);
  if (byName?.[1]) return parseManagePort(byName[1]);

  const byFrom = raw.match(/从\s*(\d{1,5})\s*端口/i);
  if (byFrom?.[1]) return parseManagePort(byFrom[1]);

  const byEntry = raw.match(/入口\s*[:：]?\s*(\d{1,5})/i);
  if (byEntry?.[1]) return parseManagePort(byEntry[1]);

  return undefined;
}
