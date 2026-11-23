/*
  Telegram 机器人：管理动作 —— 续费、加码、改规则这类要二次确认的操作：意图归一、待确认会话、执行。
  2026-11-23 从 telegramBot.ts（6483 行）拆出；外部调用方仍从 telegramBot.ts 导入，那里原样转发。
*/
import { startPanelUpgradeTask } from "../_core/systemRouter";
import { escapeHtmlText as escapeHtml } from "../../shared/htmlEscape";
import { AGENT_VERSION } from "../../shared/versions";
import { pushAgentUpgrade } from "../agentEvents";
import { isHostAgentUpgradeUnnecessary } from "../agentRouteUtils";
import { appendAiAudit } from "../ai/audit";
import { forwardxAiClient } from "../ai/client";
import { getManagePresetGroup, normalizeManagePresetCustomPatch } from "../ai/managePresets";
import { getForwardxAiSettings as getDeepSeekSettings } from "../ai/settings";
import { buildForwardxManageIntentPrompt, forwardxManageIntentResponseSchema } from "../ai/skills/forwardxCore";
import * as db from "../db";
import { addMonthsClamped } from "../repositories/repositoryUtils";
import { createDirectForwardRuleForActor, deleteForwardRuleForActor, toggleForwardRuleForActor } from "../routers/rules.crud";
import { adjustUserBalanceCommand, renewUserCommand, resetUserTrafficCommand, setUserAccountEnabledCommand, setUserBalanceCommand, setUserForwardAccessCommand } from "../services/userCommandService";
import { aiCode, extractManageDuration, extractManageForwardMode, extractManageIntentPatchFromText, normalizeManageForwardMode } from "./telegramAi";
import type { ManageActionIntent, ManageActionKind, ManageClarifyField, ManageDurationUnit, ManageForwardMode } from "./telegramAi";
import { MANAGE_ACTION_CONFIRM_TTL_MS, MANAGE_BALANCE_MAX_CENTS, MANAGE_CLARIFY_TTL_MS, MANAGE_CODE_DISPLAY_LIMIT, MANAGE_CODE_MAX_COUNT, MANAGE_RULE_TARGET_HOST_RE, extractManageAmountYuan, extractManageCodeCount, extractManageDiscountPercent, extractManageHostKeyword, extractManageRedeemAmountYuan, extractManageRuleId, extractManageSourcePort, extractManageTargetEndpoint, extractManageTargetKeyword, extractManageTunnelKeyword, formatDateTime, formatDiscountPercentLabel, formatManageRulePreview, formatMoneyCny, formatUserLabel, normalizeManageDiscountPercent, normalizeManageHostKeyword, normalizeManageTargetIp, normalizeManageTargetKeyword, normalizeManageTunnelKeyword, parseManageCodeCount, parseManagePort, parseNumericToken, randomCode, shortText } from "./telegramText";
import { deleteMessageLater, sendMessage } from "./telegramTransport";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./telegramTransport";
import { backMenuKeyboard, cleanupExpiredPendingUpdateActions, hostSearchValues, pendingUpdateActions, searchMatches, tunnelSearchValues, userSearchValues, visibleHostsForTelegramUser, visibleRulesForTelegramUser, visibleTunnelsForTelegramUser } from "./telegramViews";
import type { PendingUpdateAction } from "./telegramViews";

export type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

export type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: { id: number; type?: string };
  from?: TelegramUser;
};

type PendingManageAction = {
  key: string;
  actorUserId: number;
  actorRole: "admin" | "user";
  action: Exclude<ManageActionKind, "none">;
  targetUserId?: number;
  amountCents?: number;
  durationValue?: number;
  durationUnit?: ManageDurationUnit;
  ruleId?: number;
  ruleIds?: number[];
  rulePreview?: string[];
  tunnelId?: number;
  tunnelName?: string;
  hostId?: number;
  hostName?: string;
  forwardMode?: ManageForwardMode;
  sourcePort?: number;
  targetIp?: string;
  targetPort?: number;
  codeCount?: number;
  discountPercent?: number;
  sourceText: string;
  createdAt: number;
  expiresAt: number;
};

type PreparedManageAction = {
  pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt">;
  target?: any;
  actor: any;
};

type ManageClarifyPrompt = {
  actor: any;
  intent: ManageActionIntent;
  missingFields: ManageClarifyField[];
  text: string;
  keyboard?: InlineKeyboardMarkup;
};

type ManageActionPrepareResult = {
  prepared?: PreparedManageAction;
  clarify?: ManageClarifyPrompt;
  error?: string;
};

type PendingManageClarifySession = {
  actorUserId: number;
  actorRole: "admin" | "user";
  action: Exclude<ManageActionKind, "none">;
  intent: ManageActionIntent;
  sourceText: string;
  missingFields: ManageClarifyField[];
  createdAt: number;
  expiresAt: number;
};

export const pendingManageActions = new Map<string, PendingManageAction>();

const pendingManageClarifySessions = new Map<string, PendingManageClarifySession>();

export function getRenewalDates(user: any, months = 1) {
  const currentExpiresAt = user?.expiresAt ? new Date(user.expiresAt) : null;
  const now = new Date();
  const base = currentExpiresAt && currentExpiresAt.getTime() > now.getTime() ? currentExpiresAt : now;
  return { base, nextExpiresAt: addMonthsClamped(base, months) };
}

function getRenewalDatesByDuration(user: any, value: number, unit: ManageDurationUnit) {
  const safeValue = Math.max(1, Math.floor(value || 1));
  const currentExpiresAt = user?.expiresAt ? new Date(user.expiresAt) : null;
  const now = new Date();
  const base = currentExpiresAt && currentExpiresAt.getTime() > now.getTime() ? currentExpiresAt : now;
  if (unit === "month") return { base, nextExpiresAt: addMonthsClamped(base, safeValue) };
  if (unit === "year") return { base, nextExpiresAt: addMonthsClamped(base, safeValue * 12) };
  return { base, nextExpiresAt: new Date(base.getTime() + safeValue * 24 * 3600 * 1000) };
}

function formatManageDuration(value: number, unit: ManageDurationUnit) {
  const safeValue = Math.max(1, Math.floor(value || 1));
  if (unit === "day") return `${safeValue} 天`;
  if (unit === "year") return `${safeValue} 年`;
  return `${safeValue} 个月`;
}

function manageForwardModeLabel(mode?: ManageForwardMode | null) {
  return mode === "tunnel" ? "隧道转发" : "端口转发";
}

function isValidManageRuleTargetHost(value: unknown) {
  const host = String(value || "").trim();
  return !!host && MANAGE_RULE_TARGET_HOST_RE.test(host);
}

function pickManageRuleForwardType(actor: any, mode: ManageForwardMode) {
  const preferred = mode === "tunnel"
    ? ["gost"]
    : ["iptables", "realm", "socat", "gost"];
  if (String(actor?.role) === "admin") return preferred[0];
  const allowedRaw = (actor as any)?.allowedForwardTypes as string | null | undefined;
  if (allowedRaw === null || allowedRaw === undefined) return preferred[0];
  const allowedSet = new Set(String(allowedRaw).split(",").map((item) => item.trim()).filter(Boolean));
  if (allowedSet.size === 0) return preferred[0];
  const selected = preferred.find((type) => allowedSet.has(type));
  if (!selected) {
    throw new Error(mode === "tunnel"
      ? "当前账户没有使用隧道转发（gost）的权限，请联系管理员授权。"
      : "当前账户没有可用的端口转发类型权限，请联系管理员授权。");
  }
  return selected;
}

function cleanupExpiredPendingManageActions() {
  const now = Date.now();
  for (const [key, item] of pendingManageActions.entries()) {
    if (!item.expiresAt || item.expiresAt <= now) pendingManageActions.delete(key);
  }
}

export function createPendingManageAction(action: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt">) {
  cleanupExpiredPendingManageActions();
  const now = Date.now();
  const key = randomCode(18).toLowerCase();
  const pending: PendingManageAction = {
    ...action,
    key,
    createdAt: now,
    expiresAt: now + MANAGE_ACTION_CONFIRM_TTL_MS,
  };
  pendingManageActions.set(key, pending);
  return pending;
}

export function getPendingManageAction(actionKey: string) {
  cleanupExpiredPendingManageActions();
  const key = String(actionKey || "").trim().toLowerCase();
  if (!key) return null;
  const pending = pendingManageActions.get(key);
  if (!pending) return null;
  if (!pending.expiresAt || pending.expiresAt <= Date.now()) {
    pendingManageActions.delete(key);
    return null;
  }
  return pending;
}

function getManageClarifySessionKey(chatId: number | string, actorUserId: number | string) {
  return `${chatId}:${actorUserId}`;
}

function cleanupExpiredPendingManageClarifySessions() {
  const now = Date.now();
  for (const [key, item] of pendingManageClarifySessions.entries()) {
    if (!item.expiresAt || item.expiresAt <= now) pendingManageClarifySessions.delete(key);
  }
}

export function createPendingManageClarifySession(
  chatId: number | string,
  actor: any,
  sourceText: string,
  intent: ManageActionIntent,
  missingFields: ManageClarifyField[],
) {
  cleanupExpiredPendingManageClarifySessions();
  const now = Date.now();
  const key = getManageClarifySessionKey(chatId, Number(actor?.id || 0));
  const session: PendingManageClarifySession = {
    actorUserId: Number(actor?.id || 0),
    actorRole: String(actor?.role) === "admin" ? "admin" : "user",
    action: intent.action as Exclude<ManageActionKind, "none">,
    intent,
    sourceText: sourceText.slice(0, 500),
    missingFields,
    createdAt: now,
    expiresAt: now + MANAGE_CLARIFY_TTL_MS,
  };
  pendingManageClarifySessions.set(key, session);
  return session;
}

export function getPendingManageClarifySession(chatId: number | string, actorUserId: number | string) {
  cleanupExpiredPendingManageClarifySessions();
  const key = getManageClarifySessionKey(chatId, actorUserId);
  const session = pendingManageClarifySessions.get(key);
  if (!session) return null;
  if (!session.expiresAt || session.expiresAt <= Date.now()) {
    pendingManageClarifySessions.delete(key);
    return null;
  }
  return session;
}

export function clearPendingManageClarifySession(chatId: number | string, actorUserId: number | string) {
  pendingManageClarifySessions.delete(getManageClarifySessionKey(chatId, actorUserId));
}

export function getPendingUpdateAction(actionKey: string) {
  cleanupExpiredPendingUpdateActions();
  const key = String(actionKey || "").trim().toLowerCase();
  if (!key) return null;
  const pending = pendingUpdateActions.get(key);
  if (!pending) return null;
  if (!pending.expiresAt || pending.expiresAt <= Date.now()) {
    pendingUpdateActions.delete(key);
    return null;
  }
  return pending;
}

export function manageActionConfirmKeyboard(actionKey: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ 确认执行", callback_data: `fx:op:confirm:${actionKey}` },
        { text: "❌ 取消", callback_data: `fx:op:cancel:${actionKey}` },
      ],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

export function manageClarifyCancelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "❌ 取消本次操作", callback_data: "fx:op:clarify:cancel" }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

export function manageClarifyModeKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🖥 端口转发", callback_data: "fx:op:clarify:mode:host" },
        { text: "🔗 隧道转发", callback_data: "fx:op:clarify:mode:tunnel" },
      ],
      [{ text: "❌ 取消", callback_data: "fx:op:clarify:cancel" }],
    ],
  };
}

function manageClarifyTunnelKeyboard(tunnels: any[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  const max = 12;
  let row: InlineKeyboardButton[] = [];
  for (const tunnel of tunnels.slice(0, max)) {
    const id = Number(tunnel?.id || 0);
    if (!id) continue;
    const label = `#${id} ${shortText(tunnel?.name || "-", 10)}`;
    row.push({ text: label, callback_data: `fx:op:clarify:tunnel:${id}` });
    if (row.length >= 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  rows.push([{ text: "❌ 取消", callback_data: "fx:op:clarify:cancel" }]);
  return { inline_keyboard: rows };
}

function manageClarifyHostKeyboard(hosts: any[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  const max = 12;
  let row: InlineKeyboardButton[] = [];
  for (const host of hosts.slice(0, max)) {
    const id = Number(host?.id || 0);
    if (!id) continue;
    const label = `#${id} ${shortText(host?.name || host?.ip || "-", 10)}`;
    row.push({ text: label, callback_data: `fx:op:clarify:host:${id}` });
    if (row.length >= 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  rows.push([{ text: "❌ 取消", callback_data: "fx:op:clarify:cancel" }]);
  return { inline_keyboard: rows };
}

function manageClarifyRuleKeyboard(rules: any[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const rule of rules.slice(0, 10)) {
    const id = Number(rule?.id || 0);
    if (!id) continue;
    const target = `${shortText(rule?.targetIp || "-", 10)}:${rule?.targetPort ?? "-"}`;
    rows.push([{ text: `#${id} ${target}`, callback_data: `fx:op:clarify:rule:${id}` }]);
  }
  rows.push([{ text: "❌ 取消", callback_data: "fx:op:clarify:cancel" }]);
  return { inline_keyboard: rows };
}

async function getTelegramAiAutoRecallConfig() {
  const deepseek = await getDeepSeekSettings();
  const seconds = deepseek.telegramAutoRecallSeconds;
  return {
    enabled: !!deepseek.telegramAutoRecallEnabled,
    delayMs: seconds * 1000,
  };
}

export async function scheduleAiMessageAutoRecall(chatId: number | string, sourceMessageId?: number, botMessage?: { message_id?: number } | number | null) {
  const config = await getTelegramAiAutoRecallConfig().catch(() => ({ enabled: false, delayMs: 60_000 }));
  if (!config.enabled) return;
  const sourceId = Number(sourceMessageId);
  if (Number.isFinite(sourceId) && sourceId > 0) {
    deleteMessageLater(chatId, sourceId, config.delayMs);
  }
  const botMessageId = typeof botMessage === "number"
    ? Number(botMessage)
    : Number(botMessage?.message_id || 0);
  if (Number.isFinite(botMessageId) && botMessageId > 0) {
    deleteMessageLater(chatId, botMessageId, config.delayMs);
  }
}

export function managePresetClarifyUi(
  action: ManageActionKind,
  sourceText: string,
  missingFields: readonly ManageClarifyField[],
) {
  const group = getManagePresetGroup({ action, sourceText, missingFields });
  if (!group) return null;
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (let index = 0; index < group.choices.length; index += 2) {
    rows.push(group.choices.slice(index, index + 2).map((choice) => ({
      text: choice.label,
      callback_data: `fx:op:clarify:preset:${group.field}:${choice.value}`,
    })));
  }
  rows.push([{ text: "✏️ 自定义输入", callback_data: `fx:op:clarify:custom:${group.field}` }]);
  rows.push([{ text: "❌ 取消本次操作", callback_data: "fx:op:clarify:cancel" }]);
  const remainingCount = missingFields.filter((field) => field !== group.field).length;
  const nextHint = remainingCount > 0
    ? "选择后会继续补充下一项；也可以直接发送完整信息。"
    : "也可以不点击按钮，直接发送自定义内容。";
  return {
    field: group.field,
    customPrompt: group.customPrompt,
    text: `${group.prompt}\n${nextHint}\n\n${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效。`,
    keyboard: { inline_keyboard: rows } as InlineKeyboardMarkup,
    choices: group.choices,
  };
}

function normalizeManageActionIntent(value: any, fallback: ManageActionIntent): ManageActionIntent {
  const allowed = new Set<ManageActionKind>([
    "none",
    "balance_set",
    "balance_adjust",
    "renew",
    "account_enable",
    "account_disable",
    "forward_enable",
    "forward_disable",
    "rule_enable",
    "rule_disable",
    "rule_create",
    "rule_delete",
    "tunnel_rules_enable",
    "tunnel_rules_disable",
    "traffic_reset",
    "redeem_code_generate_balance",
    "discount_code_generate_percent",
    "registration_enable",
    "registration_disable",
  ]);
  const action = allowed.has(value?.action as ManageActionKind)
    ? (value.action as ManageActionKind)
    : fallback.action;
  const target = normalizeManageTargetKeyword(value?.target || fallback.target);
  const amountModel = Number(value?.amountYuan);
  const amountFallback = Number(fallback.amountYuan);
  const amountYuan = Number.isFinite(amountModel)
    ? amountModel
    : (Number.isFinite(amountFallback) ? amountFallback : undefined);
  const durationModel = Math.floor(Number(value?.durationValue));
  const durationFallback = Math.floor(Number(fallback.durationValue));
  const durationValue = Number.isFinite(durationModel) && durationModel > 0
    ? durationModel
    : (Number.isFinite(durationFallback) && durationFallback > 0 ? durationFallback : undefined);
  const durationUnitRaw = String(value?.durationUnit || fallback.durationUnit || "").toLowerCase();
  const durationUnit: ManageDurationUnit | undefined =
    durationUnitRaw === "day" || durationUnitRaw === "month" || durationUnitRaw === "year"
      ? (durationUnitRaw as ManageDurationUnit)
      : undefined;
  const modelRuleId = parseNumericToken(value?.ruleId);
  const fallbackRuleId = parseNumericToken(fallback.ruleId);
  const ruleId = modelRuleId || fallbackRuleId;
  const tunnel = normalizeManageTunnelKeyword(value?.tunnel || fallback.tunnel);
  const host = normalizeManageHostKeyword(value?.host || fallback.host);
  const forwardMode = normalizeManageForwardMode(value?.forwardMode || fallback.forwardMode);
  const modelTargetIp = normalizeManageTargetIp(value?.targetIp);
  const fallbackTargetIp = normalizeManageTargetIp(fallback.targetIp);
  const targetIp = modelTargetIp || fallbackTargetIp;
  const modelTargetPort = parseManagePort(value?.targetPort);
  const fallbackTargetPort = parseManagePort(fallback.targetPort);
  const targetPort = modelTargetPort || fallbackTargetPort;
  const sourceModelRaw = value?.sourcePort;
  const sourceFallbackRaw = fallback.sourcePort;
  const sourcePortModel = sourceModelRaw === 0 || String(sourceModelRaw || "").trim() === "0"
    ? 0
    : parseManagePort(sourceModelRaw);
  const sourcePortFallback = sourceFallbackRaw === 0 || String(sourceFallbackRaw || "").trim() === "0"
    ? 0
    : parseManagePort(sourceFallbackRaw);
  const sourcePort = sourcePortModel ?? sourcePortFallback;
  const codeCountModel = parseManageCodeCount(value?.codeCount);
  const codeCountFallback = parseManageCodeCount(fallback.codeCount);
  const codeCount = codeCountModel || codeCountFallback;
  const discountPercentModel = normalizeManageDiscountPercent(value?.discountPercent);
  const discountPercentFallback = normalizeManageDiscountPercent(fallback.discountPercent);
  const discountPercent = discountPercentModel || discountPercentFallback;
  return {
    action,
    ...(target ? { target } : {}),
    ...(Number.isFinite(amountYuan as number) ? { amountYuan } : {}),
    ...(durationValue ? { durationValue } : {}),
    ...(durationUnit ? { durationUnit } : {}),
    ...(ruleId ? { ruleId } : {}),
    ...(tunnel ? { tunnel } : {}),
    ...(host ? { host } : {}),
    ...(forwardMode ? { forwardMode } : {}),
    ...(targetIp ? { targetIp } : {}),
    ...(targetPort ? { targetPort } : {}),
    ...(sourcePort !== undefined ? { sourcePort } : {}),
    ...(codeCount ? { codeCount } : {}),
    ...(discountPercent ? { discountPercent } : {}),
  };
}

function mergeManageActionIntent(base: ManageActionIntent, patch: Partial<ManageActionIntent>) {
  return normalizeManageActionIntent({ ...base, ...patch, action: base.action }, base);
}

function localManageActionIntent(text: string): { intent: ManageActionIntent; writeLike: boolean } {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return { intent: { action: "none" }, writeLike: false };
  const writeLike = /(充值|充钱|设置余额|调整余额|续费|续期|延期|停用|禁用|启用|恢复|关闭|开启|关掉|打开|重置|清零|扣除|扣减|减少|增加|新增|添加|创建|删除|移除|去掉|开放注册|自助注册|折扣码|优惠码|兑换码|代金码|enable|disable|delete|remove|reset|renew|create|add|update|edit)/i.test(raw);
  const enableVerb = /(开启|启用|恢复|打开)/i.test(raw);
  const disableVerb = /(关闭|停用|禁用|暂停)/i.test(raw);
  const createVerb = /(新增|添加|增加|创建|加一个|开一个|新建)/i.test(raw);
  const generateVerb = /(?:生成|给我生成|来|发我|发我点|做|弄)/i.test(raw);
  const deleteVerb = /(删除|移除|去掉|取消|删掉)/i.test(raw);
  const hasForwardWord = /(转发|规则|rule|port|端口)/i.test(raw);
  const hasRuleWord = /(规则|rule)/i.test(raw);
  const hasTunnelWord = /(隧道|链路|tunnel|link)/i.test(raw);
  const hasDiscountCodeWord = /(折扣码|优惠码|优惠券|折扣券|discount\s*code)/i.test(raw);
  const hasRedeemCodeWord = /(兑换码|余额码|代金码|redeem\s*code)/i.test(raw);
  const hasRegistrationWord = /(开放注册|自助注册|用户注册|注册入口|注册开关|注册功能|新用户注册|注册)/i.test(raw);
  const codeCount = extractManageCodeCount(raw);
  const discountPercent = extractManageDiscountPercent(raw);
  const ruleId = extractManageRuleId(raw);
  const endpoint = extractManageTargetEndpoint(raw);
  const sourcePort = extractManageSourcePort(raw);
  const forwardMode = extractManageForwardMode(raw);
  const tunnelKeyword = normalizeManageTunnelKeyword(extractManageTunnelKeyword(raw));
  const hostKeyword = normalizeManageHostKeyword(extractManageHostKeyword(raw));
  let action: ManageActionKind = "none";
  if (hasRegistrationWord && disableVerb) {
    action = "registration_disable";
  } else if (hasRegistrationWord && enableVerb) {
    action = "registration_enable";
  } else if ((createVerb || generateVerb) && hasDiscountCodeWord) {
    action = "discount_code_generate_percent";
  } else if ((createVerb || generateVerb) && hasRedeemCodeWord) {
    action = "redeem_code_generate_balance";
  } else if (
    (/(?:折扣|优惠).*(?:码|code)|(?:码|code).*(?:折扣|优惠)/i.test(raw))
    && /(?:生成|创建|新增|来|发|做|弄)/i.test(raw)
  ) {
    action = "discount_code_generate_percent";
  } else if (
    (/(?:余额|充值|兑换|代金).*(?:码|code)|(?:码|code).*(?:余额|充值|兑换|代金)/i.test(raw))
    && /(?:生成|创建|新增|来|发|做|弄)/i.test(raw)
  ) {
    action = "redeem_code_generate_balance";
  } else if (deleteVerb && (hasForwardWord || ruleId || endpoint.targetPort)) {
    action = "rule_delete";
  } else if (createVerb && (hasForwardWord || endpoint.targetPort)) {
    action = "rule_create";
  } else if (hasRuleWord && hasTunnelWord && disableVerb) {
    action = "tunnel_rules_disable";
  } else if (hasRuleWord && hasTunnelWord && enableVerb) {
    action = "tunnel_rules_enable";
  } else if (hasRuleWord && ruleId && disableVerb) {
    action = "rule_disable";
  } else if (hasRuleWord && ruleId && enableVerb) {
    action = "rule_enable";
  } else if (/(重置|清零).*(流量|用量|traffic)|(?:流量|用量).*(重置|清零)/i.test(raw)) {
    action = "traffic_reset";
  } else if (/(停用|禁用|关闭|封禁).*(账号|账户|用户)|(?:账号|账户|用户).*(停用|禁用|关闭|封禁)/i.test(raw)) {
    action = "account_disable";
  } else if (/(启用|恢复|解封).*(账号|账户|用户)|(?:账号|账户|用户).*(启用|恢复|解封)/i.test(raw)) {
    action = "account_enable";
  } else if (/(关闭|停用|禁用).*(转发|转发权限|规则权限)|(?:转发|转发权限|规则权限).*(关闭|停用|禁用)/i.test(raw)) {
    action = "forward_disable";
  } else if (/(开启|启用|恢复).*(转发|转发权限|规则权限)|(?:转发|转发权限|规则权限).*(开启|启用|恢复)/i.test(raw)) {
    action = "forward_enable";
  } else if (/(续费|续期|延期|延长)/i.test(raw)) {
    action = "renew";
  } else if (/(余额|余款).*(设置|设为|改为|改成|变成)|(?:设置|设为|改为|改成|变成).*(余额|余款)/i.test(raw)) {
    action = "balance_set";
  } else if (/(充值|充钱|加钱|加余额|扣除|扣减|扣|减少|减去|增减|调整(?:余额|金额)?|补款|退款)/i.test(raw)) {
    action = "balance_adjust";
  } else if (/^(给|把|将|帮(?:我)?|为).*(\d+(?:\.\d+)?)(?:元|块|¥|￥)?/.test(raw)) {
    action = "balance_adjust";
  }

  const target = normalizeManageTargetKeyword(extractManageTargetKeyword(raw));
  const amountRaw = extractManageAmountYuan(raw);
  const redeemAmountRaw = extractManageRedeemAmountYuan(raw);
  let amountYuan = Number.isFinite(amountRaw as number) ? Number(amountRaw) : undefined;
  if (!Number.isFinite(amountYuan as number) && Number.isFinite(redeemAmountRaw as number)) {
    amountYuan = Number(redeemAmountRaw);
  }
  if (Number.isFinite(amountYuan as number) && action === "balance_adjust") {
    if (/(扣除|扣减|减少|减去|下调)/.test(raw) && (amountYuan as number) > 0) amountYuan = -Math.abs(amountYuan as number);
    if (/(充值|充钱|加钱|增加|补款|上调)/.test(raw) && (amountYuan as number) < 0) amountYuan = Math.abs(amountYuan as number);
  }

  const duration = extractManageDuration(raw);
  return {
    writeLike: writeLike || action !== "none",
    intent: {
      action,
      ...(target ? { target } : {}),
      ...(Number.isFinite(amountYuan as number) ? { amountYuan } : {}),
      ...(duration ? { durationValue: duration.value, durationUnit: duration.unit } : {}),
      ...(ruleId ? { ruleId } : {}),
      ...(tunnelKeyword ? { tunnel: tunnelKeyword } : {}),
      ...(hostKeyword ? { host: hostKeyword } : {}),
      ...(forwardMode ? { forwardMode } : {}),
      ...(sourcePort !== undefined ? { sourcePort } : {}),
      ...(endpoint.targetIp ? { targetIp: endpoint.targetIp } : {}),
      ...(endpoint.targetPort ? { targetPort: endpoint.targetPort } : {}),
      ...(Number.isFinite(codeCount as number) ? { codeCount: Number(codeCount) } : {}),
      ...(Number.isFinite(discountPercent as number) ? { discountPercent: Number(discountPercent) } : {}),
    },
  };
}

async function parseManageActionIntent(text: string): Promise<{ intent: ManageActionIntent; writeLike: boolean }> {
  const fallback = localManageActionIntent(text);
  if (!fallback.writeLike) return fallback;
  const settings = await getDeepSeekSettings().catch(() => null);
  if (!settings?.enabled || !settings.apiKey) return fallback;
  try {
    const parsed = await forwardxAiClient.requestStructuredJson({
      operation: "telegram.manage-intent",
      settings,
      systemPrompt: buildForwardxManageIntentPrompt(),
      userText: text,
      schema: forwardxManageIntentResponseSchema,
    });
    const intent = normalizeManageActionIntent(parsed, fallback.intent);
    const modelWriteLike = parsed.writeLike === true || parsed.writeLike === "true";
    return {
      intent,
      writeLike: modelWriteLike || fallback.writeLike || intent.action !== "none",
    };
  } catch (error) {
    console.warn("[TelegramBot] AI manage intent fallback:", error);
    appendAiAudit({ phase: "intent", result: "fallback", action: fallback.intent.action, detail: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

function isManageActionAllowedForRole(role: unknown, action: ManageActionKind) {
  if (action === "none") return false;
  if (String(role) === "admin") return true;
  return action === "forward_enable"
    || action === "forward_disable"
    || action === "rule_create"
    || action === "rule_delete"
    || action === "rule_enable"
    || action === "rule_disable"
    || action === "tunnel_rules_enable"
    || action === "tunnel_rules_disable";
}

function manageRoleLabel(role: unknown) {
  return String(role) === "admin" ? "管理员" : "用户";
}

function manageActionLabel(action: Exclude<ManageActionKind, "none">) {
  const mapping: Record<Exclude<ManageActionKind, "none">, string> = {
    balance_set: "设置余额",
    balance_adjust: "调整余额",
    renew: "续费",
    account_enable: "启用账号",
    account_disable: "停用账号",
    forward_enable: "启用转发",
    forward_disable: "关闭转发",
    rule_enable: "启用规则",
    rule_disable: "关闭规则",
    rule_create: "新增转发规则",
    rule_delete: "删除转发规则",
    tunnel_rules_enable: "启用隧道规则",
    tunnel_rules_disable: "关闭隧道规则",
    traffic_reset: "重置流量",
    redeem_code_generate_balance: "生成余额兑换码",
    discount_code_generate_percent: "生成折扣码",
    registration_enable: "开启开放注册",
    registration_disable: "关闭开放注册",
  };
  return mapping[action];
}

function manageActionPermissionHint(isAdmin: boolean) {
  if (isAdmin) {
    return "管理员可执行：余额设置/调整、续费、启停账号、启停转发、规则新增/删除/启停、按隧道批量启停规则、重置流量、生成兑换码与折扣码、开启/关闭开放注册。";
  }
  return "普通用户仅可操作自己的转发开关与可见规则（新增/删除/单条启停/按隧道批量启停），例如“新增转发到 10.10.0.1:5151”、“删除第12条规则”。";
}

function isSelfTargetForUser(actor: any, keyword: string) {
  const raw = normalizeManageTargetKeyword(keyword).toLowerCase();
  if (!raw) return true;
  if (["我", "我的", "我自己", "本人", "self", "me"].includes(raw)) return true;
  const actorId = String(actor?.id || "");
  if (raw === actorId || raw === `#${actorId}`) return true;
  const userTokens = [actor?.username, actor?.email, actor?.name]
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean);
  if (userTokens.includes(raw)) return true;
  const numeric = parseNumericToken(raw.replace(/^#/, "").replace(/^(用户|账号|账户|user)/i, ""));
  return Number.isFinite(numeric as number) && Number(numeric) === Number(actor?.id || 0);
}

async function resolveManageTargetUser(actor: any, rawKeyword: string) {
  const keyword = normalizeManageTargetKeyword(rawKeyword);
  const isAdmin = String(actor?.role) === "admin";
  if (!isAdmin) {
    if (isSelfTargetForUser(actor, keyword)) return { target: actor };
    return { error: "普通用户仅可操作自己的账号。可使用“关闭我的转发”或“启用我的转发”。" };
  }
  if (!keyword) return { error: "请指定目标用户（ID、用户名、邮箱或备注名）。" };
  if (["我", "我的", "我自己", "本人", "self", "me"].includes(keyword.toLowerCase())) return { target: actor };

  const users = await db.getUserTrafficSummaries();
  const normalizedIdKeyword = keyword
    .replace(/^#/, "")
    .replace(/^(用户|账号|账户|user)\s*/i, "");
  const numericId = parseNumericToken(normalizedIdKeyword);
  const matchedById = numericId ? (users as any[]).filter((item) => Number(item.id) === Number(numericId)) : [];
  const matched = matchedById.length > 0
    ? matchedById
    : (users as any[]).filter((item) => {
      const variants = [keyword, normalizedIdKeyword].filter(Boolean);
      return variants.some((needle) => searchMatches(needle, userSearchValues(item)));
    });
  if (matched.length === 0) {
    return { error: `没有找到匹配用户：${escapeHtml(keyword)}` };
  }
  if (matched.length > 1) {
    const preview = matched
      .slice(0, 5)
      .map((item: any) => `#${item.id} ${item.name || item.username}`)
      .join("、");
    return { error: `匹配到多个用户：${escapeHtml(preview)}。请补充更精确的用户ID或邮箱。` };
  }
  return { target: matched[0] };
}

function isRuleManageAction(action: ManageActionKind) {
  return action === "rule_enable"
    || action === "rule_disable"
    || action === "rule_create"
    || action === "rule_delete"
    || action === "tunnel_rules_enable"
    || action === "tunnel_rules_disable";
}

async function resolveManageTunnel(actor: any, rawKeyword: string) {
  const keyword = normalizeManageTunnelKeyword(rawKeyword);
  if (!keyword) return { error: "请指定隧道（ID 或名称），例如：关闭 2 号隧道的规则。" };
  const tunnels = await visibleTunnelsForTelegramUser(actor);
  const numericId = parseNumericToken(keyword.replace(/^#/, ""));
  const matchedById = numericId ? (tunnels as any[]).filter((item) => Number(item.id) === Number(numericId)) : [];
  const matched = matchedById.length > 0
    ? matchedById
    : (tunnels as any[]).filter((item: any) => searchMatches(keyword, tunnelSearchValues(item)));
  if (matched.length === 0) {
    return { error: `没有找到匹配隧道：${escapeHtml(keyword)}` };
  }
  if (matched.length > 1) {
    const preview = matched
      .slice(0, 5)
      .map((item: any) => `#${item.id} ${item.name || "-"}`)
      .join("、");
    return { error: `匹配到多个隧道：${escapeHtml(preview)}。请补充更精确的隧道 ID。` };
  }
  return { tunnel: matched[0] };
}

async function resolveManageHost(actor: any, rawKeyword: string) {
  const keyword = normalizeManageHostKeyword(rawKeyword);
  if (!keyword) return { error: "请指定主机（ID 或名称），例如：添加到上海主机。" };
  const hosts = await visibleHostsForTelegramUser(actor);
  const numericId = parseNumericToken(keyword.replace(/^#/, ""));
  const matchedById = numericId ? (hosts as any[]).filter((item) => Number(item.id) === Number(numericId)) : [];
  const matched = matchedById.length > 0
    ? matchedById
    : (hosts as any[]).filter((item: any) => searchMatches(keyword, hostSearchValues(item)));
  if (matched.length === 0) {
    return { error: `没有找到匹配主机：${escapeHtml(keyword)}` };
  }
  if (matched.length > 1) {
    const preview = matched
      .slice(0, 5)
      .map((item: any) => `#${item.id} ${item.name || item.ip || "-"}`)
      .join("、");
    return { error: `匹配到多个主机：${escapeHtml(preview)}。请补充更精确的主机 ID。` };
  }
  return { host: matched[0] };
}

export async function prepareManageAction(user: any, sourceText: string, intent: ManageActionIntent): Promise<ManageActionPrepareResult> {
  if (!intent || intent.action === "none") return { error: "未识别到可执行的管理操作。" };
  const action = intent.action as Exclude<ManageActionKind, "none">;
  const actor = (await db.getUserById(Number(user?.id || 0)).catch(() => null)) || user;
  const isAdmin = String(actor?.role) === "admin";
  if (!isManageActionAllowedForRole(actor?.role, action)) {
    return { error: `你没有执行「${manageActionLabel(action)}」的权限。\n${manageActionPermissionHint(isAdmin)}` };
  }

  if (action === "registration_enable" || action === "registration_disable") {
    if (!isAdmin) {
      return { error: "只有管理员可以调整开放注册。" };
    }
    const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
      actorUserId: Number(actor.id),
      actorRole: "admin",
      action,
      sourceText: sourceText.slice(0, 500),
    };
    return { prepared: { pending, actor } as PreparedManageAction };
  }

  if (action === "redeem_code_generate_balance" || action === "discount_code_generate_percent") {
    const deepseekSettings = await getDeepSeekSettings().catch(() => null);
    if (!isAdmin) {
      return { error: "只有管理员可以生成兑换码或折扣码。" };
    }

    const askCountHint = /(几[个张份组]?|多少[个张份组]?|一批|批量|若干|一些)/i.test(sourceText);
    let codeCount = parseManageCodeCount(intent.codeCount ?? extractManageCodeCount(sourceText));
    if (!codeCount && !askCountHint) codeCount = 1;

    if (action === "redeem_code_generate_balance") {
      if (deepseekSettings?.redemptionEnabled === false) {
        return { error: "兑换码功能当前已关闭，请在设置中启用后再试。" };
      }
      const parsedAmount = Number.isFinite(Number(intent.amountYuan))
        ? Number(intent.amountYuan)
        : Number(extractManageRedeemAmountYuan(sourceText));
      const amountYuan = Number.isFinite(parsedAmount) ? parsedAmount : undefined;

      const missingFields: ManageClarifyField[] = [];
      if (!Number.isFinite(amountYuan as number)) missingFields.push("amountYuan");
      if (!codeCount) missingFields.push("codeCount");
      if (missingFields.length > 0) {
        const nextIntent: ManageActionIntent = {
          ...intent,
          action,
          ...(Number.isFinite(amountYuan as number) ? { amountYuan } : {}),
          ...(codeCount ? { codeCount } : {}),
        };
        const presetUi = managePresetClarifyUi(action, sourceText, missingFields);
        let text = `请补充余额兑换码信息（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
        if (missingFields.includes("amountYuan") && missingFields.includes("codeCount")) {
          text = `请补充兑换码面额和数量，例如“50 元 20 个”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
        } else if (missingFields.includes("amountYuan")) {
          text = `请补充每个兑换码金额（单位：元），例如“50”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
        } else if (missingFields.includes("codeCount")) {
          text = `请补充要生成的兑换码数量，例如“20 个”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
        }
        return {
          clarify: {
            actor,
            intent: nextIntent,
            missingFields,
            text: presetUi?.text || text,
            keyboard: presetUi?.keyboard || manageClarifyCancelKeyboard(),
          },
        };
      }
      const amountCents = Math.round(Number(amountYuan) * 100);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return { error: "兑换码金额必须大于 0。" };
      }
      if (amountCents > MANAGE_BALANCE_MAX_CENTS) {
        return { error: "兑换码金额超出允许范围，请控制在 1,000,000 元以内。" };
      }
      if (!codeCount || codeCount <= 0 || codeCount > MANAGE_CODE_MAX_COUNT) {
        return { error: `兑换码数量必须在 1-${MANAGE_CODE_MAX_COUNT} 之间。` };
      }
      const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
        actorUserId: Number(actor.id),
        actorRole: "admin",
        action,
        amountCents,
        codeCount,
        sourceText: sourceText.slice(0, 500),
      };
      return { prepared: { pending, actor } as PreparedManageAction };
    }

    if (deepseekSettings?.discountEnabled === false) {
      return { error: "折扣码功能当前已关闭，请在设置中启用后再试。" };
    }
    const discountPercent = normalizeManageDiscountPercent(
      intent.discountPercent ?? extractManageDiscountPercent(sourceText),
    );
    const missingFields: ManageClarifyField[] = [];
    if (!discountPercent) missingFields.push("discountPercent");
    if (!codeCount) missingFields.push("codeCount");
    if (missingFields.length > 0) {
      const nextIntent: ManageActionIntent = {
        ...intent,
        action,
        ...(discountPercent ? { discountPercent } : {}),
        ...(codeCount ? { codeCount } : {}),
      };
      const presetUi = managePresetClarifyUi(action, sourceText, missingFields);
      let text = `请补充折扣码信息（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
      if (missingFields.includes("discountPercent") && missingFields.includes("codeCount")) {
        text = `请补充折扣力度和数量，例如“8 折 10 个”或“减 20% 10 个”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
      } else if (missingFields.includes("discountPercent")) {
        text = `请补充折扣力度，例如“8 折”或“减 20%”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
      } else if (missingFields.includes("codeCount")) {
        text = `请补充要生成的折扣码数量，例如“10 个”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
      }
      return {
        clarify: {
          actor,
          intent: nextIntent,
          missingFields,
          text: presetUi?.text || text,
          keyboard: presetUi?.keyboard || manageClarifyCancelKeyboard(),
        },
      };
    }
    if (!codeCount || codeCount <= 0 || codeCount > MANAGE_CODE_MAX_COUNT) {
      return { error: `折扣码数量必须在 1-${MANAGE_CODE_MAX_COUNT} 之间。` };
    }
    const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
      actorUserId: Number(actor.id),
      actorRole: "admin",
      action,
      codeCount,
      discountPercent,
      sourceText: sourceText.slice(0, 500),
    };
    return { prepared: { pending, actor } as PreparedManageAction };
  }

  if (isRuleManageAction(action)) {
    const rules = await visibleRulesForTelegramUser(actor);
    if (action === "rule_enable" || action === "rule_disable" || action === "rule_delete") {
      const ruleId = parseNumericToken(intent.ruleId) || extractManageRuleId(sourceText);
      if (ruleId) {
        const targetRule = (rules as any[]).find((item: any) => Number(item.id) === Number(ruleId));
        if (!targetRule) return { error: `规则 #${ruleId} 不存在或无权操作。` };
        const targetUserId = Number((targetRule as any).userId || 0);
        const targetUser = targetUserId > 0 ? await db.getUserById(targetUserId).catch(() => null) : null;
        const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
          actorUserId: Number(actor.id),
          actorRole: isAdmin ? "admin" : "user",
          action,
          ...(targetUserId > 0 ? { targetUserId } : {}),
          ruleId: Number((targetRule as any).id),
          rulePreview: [formatManageRulePreview(targetRule)],
          ...(Number((targetRule as any).hostId || 0) > 0 ? { hostId: Number((targetRule as any).hostId) } : {}),
          ...(Number((targetRule as any).tunnelId || 0) > 0 ? { tunnelId: Number((targetRule as any).tunnelId) } : {}),
          sourceText: sourceText.slice(0, 500),
        };
        return { prepared: { pending, target: targetUser || undefined, actor } as PreparedManageAction };
      }

      if (action !== "rule_delete") {
        return {
          error: action === "rule_enable"
            ? "请提供规则 ID，例如：开启第 12 条规则。"
            : "请提供规则 ID，例如：关闭 #12 号规则。",
        };
      }

      const endpoint = extractManageTargetEndpoint(sourceText);
      const targetIp = normalizeManageTargetIp(intent.targetIp || endpoint.targetIp || "");
      const targetPort = parseManagePort(intent.targetPort ?? endpoint.targetPort);
      const sourcePortRaw = intent.sourcePort === 0 || String(intent.sourcePort || "").trim() === "0"
        ? 0
        : parseManagePort(intent.sourcePort);
      const sourcePort = sourcePortRaw === 0 ? undefined : sourcePortRaw;
      const forwardMode = normalizeManageForwardMode(intent.forwardMode || extractManageForwardMode(sourceText));
      const tunnelKeyword = normalizeManageTunnelKeyword(intent.tunnel || extractManageTunnelKeyword(sourceText));
      const hostKeyword = normalizeManageHostKeyword(intent.host || extractManageHostKeyword(sourceText));

      let tunnel: any = null;
      if (tunnelKeyword) {
        const resolvedTunnel = await resolveManageTunnel(actor, tunnelKeyword);
        if (!resolvedTunnel.tunnel) return { error: resolvedTunnel.error || "隧道不存在或无权操作。" };
        tunnel = resolvedTunnel.tunnel;
      }
      let host: any = null;
      if (hostKeyword) {
        const resolvedHost = await resolveManageHost(actor, hostKeyword);
        if (!resolvedHost.host) return { error: resolvedHost.error || "主机不存在或无权操作。" };
        host = resolvedHost.host;
      }

      const hasFilter = !!targetIp
        || Number.isFinite(targetPort as number)
        || Number.isFinite(sourcePort as number)
        || !!forwardMode
        || !!tunnel
        || !!host;
      if (!hasFilter) {
        return { error: "请提供要删除的规则信息，例如：删除第12条规则，或删除转发到 10.10.0.1:5151 的规则。" };
      }

      let matchedRules = [...(rules as any[])];
      if (forwardMode === "host") matchedRules = matchedRules.filter((item: any) => Number(item.tunnelId || 0) <= 0);
      if (forwardMode === "tunnel") matchedRules = matchedRules.filter((item: any) => Number(item.tunnelId || 0) > 0);
      if (tunnel) matchedRules = matchedRules.filter((item: any) => Number(item.tunnelId || 0) === Number((tunnel as any).id || 0));
      if (host) matchedRules = matchedRules.filter((item: any) => Number(item.hostId || 0) === Number((host as any).id || 0));
      if (targetIp) {
        const needle = targetIp.toLowerCase();
        matchedRules = matchedRules.filter((item: any) => String(item.targetIp || "").trim().toLowerCase() === needle);
      }
      if (Number.isFinite(targetPort as number)) {
        matchedRules = matchedRules.filter((item: any) => Number(item.targetPort || 0) === Number(targetPort));
      }
      if (Number.isFinite(sourcePort as number)) {
        matchedRules = matchedRules.filter((item: any) => Number(item.sourcePort || 0) === Number(sourcePort));
      }
      matchedRules = matchedRules.sort((a: any, b: any) => Number(a.id) - Number(b.id));
      if (matchedRules.length === 0) {
        return { error: "没有找到可删除的匹配规则，请补充规则 ID、隧道/主机、目标地址端口等信息。" };
      }
      if (matchedRules.length > 1) {
        const nextIntent: ManageActionIntent = {
          ...intent,
          action,
          ...(targetIp ? { targetIp } : {}),
          ...(Number.isFinite(targetPort as number) ? { targetPort } : {}),
          ...(Number.isFinite(sourcePort as number) ? { sourcePort } : {}),
          ...(forwardMode ? { forwardMode } : {}),
          ...(tunnel ? { tunnel: String((tunnel as any).id || "") } : {}),
          ...(host ? { host: String((host as any).id || "") } : {}),
        };
        return {
          clarify: {
            actor,
            intent: nextIntent,
            missingFields: ["ruleId"],
            text: `匹配到 ${matchedRules.length} 条规则，请选择要删除的规则（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`,
            keyboard: manageClarifyRuleKeyboard(matchedRules),
          },
        };
      }
      const targetRule = matchedRules[0];
      const targetUserId = Number((targetRule as any).userId || 0);
      const targetUser = targetUserId > 0 ? await db.getUserById(targetUserId).catch(() => null) : null;
      const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
        actorUserId: Number(actor.id),
        actorRole: isAdmin ? "admin" : "user",
        action,
        ...(targetUserId > 0 ? { targetUserId } : {}),
        ruleId: Number((targetRule as any).id),
        rulePreview: [formatManageRulePreview(targetRule)],
        ...(Number((targetRule as any).hostId || 0) > 0 ? { hostId: Number((targetRule as any).hostId) } : {}),
        ...(Number((targetRule as any).tunnelId || 0) > 0 ? { tunnelId: Number((targetRule as any).tunnelId) } : {}),
        sourceText: sourceText.slice(0, 500),
      };
      return { prepared: { pending, target: targetUser || undefined, actor } as PreparedManageAction };
    }

    if (action === "rule_create") {
      const endpoint = extractManageTargetEndpoint(sourceText);
      const targetIp = normalizeManageTargetIp(intent.targetIp || endpoint.targetIp || "");
      const targetPort = parseManagePort(intent.targetPort ?? endpoint.targetPort);
      if (!targetIp || !targetPort) {
        return { error: "请提供目标地址和端口，例如：增加一个转发到 10.10.0.1 的 5151 端口。" };
      }

      let sourcePort: number | undefined;
      if (intent.sourcePort === 0 || String(intent.sourcePort || "").trim() === "0") {
        sourcePort = 0;
      } else if (intent.sourcePort !== undefined && intent.sourcePort !== null && String(intent.sourcePort).trim() !== "") {
        const parsed = parseManagePort(intent.sourcePort);
        if (!parsed) return { error: "源端口无效，请输入 1-65535，或省略源端口使用随机端口。" };
        sourcePort = parsed;
      } else {
        const extracted = extractManageSourcePort(sourceText);
        if (extracted === 0) sourcePort = 0;
        else if (Number.isFinite(extracted as number)) sourcePort = extracted;
      }
      if (!Number.isFinite(sourcePort as number)) sourcePort = 0;

      const forwardMode = normalizeManageForwardMode(intent.forwardMode || extractManageForwardMode(sourceText));
      if (!forwardMode) {
        const nextIntent: ManageActionIntent = {
          ...intent,
          action,
          targetIp,
          targetPort,
          sourcePort,
        };
        return {
          clarify: {
            actor,
            intent: nextIntent,
            missingFields: ["forwardMode"],
            text: `请先选择要新增为哪种转发方式（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`,
            keyboard: manageClarifyModeKeyboard(),
          },
        };
      }

      let host: any = null;
      let tunnel: any = null;
      if (forwardMode === "tunnel") {
        const tunnelKeyword = normalizeManageTunnelKeyword(intent.tunnel || extractManageTunnelKeyword(sourceText));
        if (tunnelKeyword) {
          const resolvedTunnel = await resolveManageTunnel(actor, tunnelKeyword);
          if (!resolvedTunnel.tunnel) return { error: resolvedTunnel.error || "隧道不存在或无权操作。" };
          tunnel = resolvedTunnel.tunnel;
        } else {
          const tunnels = await visibleTunnelsForTelegramUser(actor);
          if ((tunnels as any[]).length === 0) return { error: "当前没有可用隧道，无法新增隧道转发规则。" };
          if ((tunnels as any[]).length === 1) {
            tunnel = (tunnels as any[])[0];
          } else {
            const nextIntent: ManageActionIntent = {
              ...intent,
              action,
              forwardMode: "tunnel",
              targetIp,
              targetPort,
              sourcePort,
            };
            return {
              clarify: {
                actor,
                intent: nextIntent,
                missingFields: ["tunnel"],
                text: `请选择要添加到哪个隧道（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`,
                keyboard: manageClarifyTunnelKeyboard(tunnels as any[]),
              },
            };
          }
        }
        const hostIdFromTunnel = Number((tunnel as any)?.entryHostId || 0);
        if (!hostIdFromTunnel) return { error: "所选隧道入口主机无效，无法创建规则。" };
        host = await db.getHostById(hostIdFromTunnel).catch(() => null);
      } else {
        const hostKeyword = normalizeManageHostKeyword(intent.host || extractManageHostKeyword(sourceText));
        if (hostKeyword) {
          const resolvedHost = await resolveManageHost(actor, hostKeyword);
          if (!resolvedHost.host) return { error: resolvedHost.error || "主机不存在或无权操作。" };
          host = resolvedHost.host;
        } else {
          const hosts = await visibleHostsForTelegramUser(actor);
          if ((hosts as any[]).length === 0) return { error: "当前没有可用主机，无法新增端口转发规则。" };
          if ((hosts as any[]).length === 1) {
            host = (hosts as any[])[0];
          } else {
            const nextIntent: ManageActionIntent = {
              ...intent,
              action,
              forwardMode: "host",
              targetIp,
              targetPort,
              sourcePort,
            };
            return {
              clarify: {
                actor,
                intent: nextIntent,
                missingFields: ["host"],
                text: `请选择要添加到哪个主机（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`,
                keyboard: manageClarifyHostKeyboard(hosts as any[]),
              },
            };
          }
        }
      }
      if (!host) return { error: "没有可用的入口主机，无法新增规则。" };
      const hostId = Number((host as any).id || 0);
      const tunnelId = forwardMode === "tunnel" ? Number((tunnel as any)?.id || 0) : 0;
      if (!hostId) return { error: "入口主机无效，无法新增规则。" };
      const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
        actorUserId: Number(actor.id),
        actorRole: isAdmin ? "admin" : "user",
        action,
        forwardMode,
        hostId,
        hostName: String((host as any).name || (host as any).ip || `主机 #${hostId}`).slice(0, 80),
        ...(tunnelId > 0 ? { tunnelId, tunnelName: String((tunnel as any).name || `隧道 #${tunnelId}`).slice(0, 80) } : {}),
        sourcePort,
        targetIp,
        targetPort,
        sourceText: sourceText.slice(0, 500),
      };
      return { prepared: { pending, actor } as PreparedManageAction };
    }

    const tunnelKeyword = normalizeManageTunnelKeyword(intent.tunnel || extractManageTunnelKeyword(sourceText));
    const resolvedTunnel = await resolveManageTunnel(actor, tunnelKeyword);
    if (!resolvedTunnel.tunnel) return { error: resolvedTunnel.error || "隧道不存在或无权操作。" };
    const tunnel = resolvedTunnel.tunnel as any;
    const tunnelId = Number(tunnel.id || 0);
    if (!tunnelId) return { error: "隧道 ID 无效，无法执行批量规则操作。" };
    const tunnelRules = (rules as any[])
      .filter((item: any) => Number(item.tunnelId || 0) === tunnelId)
      .sort((a: any, b: any) => Number(a.id) - Number(b.id));
    if (tunnelRules.length === 0) {
      return { error: `隧道 #${tunnelId} ${escapeHtml(tunnel.name || "-")} 下没有可操作的规则。` };
    }
    const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
      actorUserId: Number(actor.id),
      actorRole: isAdmin ? "admin" : "user",
      action,
      tunnelId,
      tunnelName: String(tunnel.name || `隧道 #${tunnelId}`).slice(0, 80),
      ruleIds: tunnelRules.map((item: any) => Number(item.id)).filter((id: number) => Number.isFinite(id) && id > 0),
      rulePreview: tunnelRules.map((item: any) => formatManageRulePreview(item)),
      sourceText: sourceText.slice(0, 500),
    };
    return { prepared: { pending, actor } as PreparedManageAction };
  }

  const targetKeyword = normalizeManageTargetKeyword(intent.target || extractManageTargetKeyword(sourceText));
  if (isAdmin && !targetKeyword) {
    return {
      clarify: {
        actor,
        intent: { ...intent, action },
        missingFields: ["target"],
        text: `请补充要操作的目标用户（用户ID/用户名/邮箱），${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效。`,
        keyboard: manageClarifyCancelKeyboard(),
      },
    };
  }
  const resolved = await resolveManageTargetUser(actor, targetKeyword);
  if (!resolved.target) {
    return { error: `${resolved.error || "目标用户不存在。"}\n${manageActionPermissionHint(isAdmin)}` };
  }
  const target = resolved.target as any;
  if (!isAdmin && Number(target.id) !== Number(actor.id)) {
    return { error: "普通用户只允许操作自己的账号。" };
  }
  if (action === "forward_disable" && String(target.role) === "admin") {
    return { error: "管理员账号不能在机器人中关闭转发权限。" };
  }
  if (action === "forward_enable" && String(target.role) === "admin") {
    return { error: "管理员账号默认拥有转发权限，无需启用。" };
  }
  if (action === "account_disable" && Number(target.id) === Number(actor.id)) {
    return { error: "不能停用当前登录账号。" };
  }
  if (action === "account_disable" && String(target.role) === "admin") {
    return { error: "管理员账号不能通过机器人停用。" };
  }

  let amountCents: number | undefined;
  if (action === "balance_set" || action === "balance_adjust") {
    const amountYuan = Number(intent.amountYuan);
    if (!Number.isFinite(amountYuan)) {
      const missingFields: ManageClarifyField[] = ["amountYuan"];
      const presetUi = managePresetClarifyUi(action, sourceText, missingFields);
      return {
        clarify: {
          actor,
          intent: { ...intent, action, target: targetKeyword || intent.target },
          missingFields,
          text: presetUi?.text || (action === "balance_set"
            ? `请补充要设置的余额金额（单位：元），${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效。`
            : `请补充要调整的金额（单位：元，可正可负），${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效。`),
          keyboard: presetUi?.keyboard || manageClarifyCancelKeyboard(),
        },
      };
    }
    amountCents = Math.round(amountYuan * 100);
    if (action === "balance_set" && amountCents < 0) return { error: "余额不能小于 0。" };
    if (action === "balance_adjust" && amountCents === 0) return { error: "调整金额不能为 0。" };
    if (Math.abs(amountCents) > MANAGE_BALANCE_MAX_CENTS) {
      return { error: "金额超出允许范围，请控制在 1,000,000 元以内。" };
    }
    if (action === "balance_adjust" && Number(target.balanceCents || 0) + amountCents < 0) {
      return { error: "扣减后余额不能小于 0。" };
    }
  }

  let durationValue: number | undefined;
  let durationUnit: ManageDurationUnit | undefined;
  if (action === "renew") {
    const parsedDurationValue = Math.floor(Number(intent.durationValue));
    const rawUnit = String(intent.durationUnit || "");
    const parsedDurationUnit = rawUnit === "day" || rawUnit === "year" || rawUnit === "month"
      ? (rawUnit as ManageDurationUnit)
      : undefined;
    if (!Number.isFinite(parsedDurationValue) || parsedDurationValue <= 0 || !parsedDurationUnit) {
      const missingFields: ManageClarifyField[] = ["duration"];
      const presetUi = managePresetClarifyUi(action, sourceText, missingFields);
      return {
        clarify: {
          actor,
          intent: { ...intent, action, target: targetKeyword || intent.target },
          missingFields,
          text: presetUi?.text || `请补充续期时长，例如“1个月”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`,
          keyboard: presetUi?.keyboard || manageClarifyCancelKeyboard(),
        },
      };
    }
    durationValue = parsedDurationValue;
    durationUnit = parsedDurationUnit;
  }

  const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
    actorUserId: Number(actor.id),
    actorRole: isAdmin ? "admin" : "user",
    action,
    targetUserId: Number(target.id),
    ...(Number.isFinite(amountCents as number) ? { amountCents } : {}),
    ...(durationValue ? { durationValue } : {}),
    ...(durationUnit ? { durationUnit } : {}),
    sourceText: sourceText.slice(0, 500),
  };
  return { prepared: { pending, target, actor } as PreparedManageAction };
}

export function manageActionConfirmText(pending: PendingManageAction, actor: any, target?: any) {
  const action = pending.action as Exclude<ManageActionKind, "none">;
  const lines: string[] = [
    "<b>操作确认</b>",
    "",
    `发起人：${formatUserLabel(actor)}（${manageRoleLabel(actor?.role)}）`,
    ...(target ? [`目标用户：${formatUserLabel(target)}`] : []),
    `操作类型：<b>${escapeHtml(manageActionLabel(action))}</b>`,
  ];
  if (action === "balance_set") {
    lines.push(`当前余额：${formatMoneyCny(target?.balanceCents)}`);
    lines.push(`设置为：<b>${formatMoneyCny(pending.amountCents)}</b>`);
  } else if (action === "balance_adjust") {
    const delta = Number(pending.amountCents || 0);
    lines.push(`当前余额：${formatMoneyCny(target?.balanceCents)}`);
    lines.push(`变更金额：<b>${delta >= 0 ? "+" : ""}${formatMoneyCny(delta)}</b>`);
    lines.push(`预计余额：<b>${formatMoneyCny(Number(target?.balanceCents || 0) + delta)}</b>`);
  } else if (action === "renew") {
    const durationValue = Math.max(1, Math.floor(Number(pending.durationValue || 1)));
    const durationUnit = pending.durationUnit || "month";
    const { nextExpiresAt } = getRenewalDatesByDuration(target, durationValue, durationUnit);
    lines.push(`续费时长：<b>${escapeHtml(formatManageDuration(durationValue, durationUnit))}</b>`);
    lines.push(`当前到期：${escapeHtml(formatDateTime(target?.expiresAt))}`);
    lines.push(`续费后到期：<b>${escapeHtml(formatDateTime(nextExpiresAt))}</b>`);
  } else if (action === "account_disable") {
    lines.push("将停用该用户账号，用户将无法登录和使用机器人。");
  } else if (action === "account_enable") {
    lines.push("将启用该用户账号。");
  } else if (action === "forward_disable") {
    lines.push("将关闭该用户转发权限，并暂停其转发规则。");
  } else if (action === "forward_enable") {
    lines.push("将启用该用户转发权限。");
  } else if (action === "rule_disable" || action === "rule_enable") {
    const ruleText = pending.rulePreview?.[0] || (pending.ruleId ? `#${pending.ruleId}` : "未指定");
    lines.push(`目标规则：${aiCode(ruleText)}`);
    lines.push(action === "rule_disable" ? "将停用该规则。" : "将启用该规则。");
  } else if (action === "rule_create") {
    const hostLabel = pending.hostId
      ? `#${pending.hostId} ${pending.hostName || ""}`.trim()
      : (pending.hostName || "-");
    const tunnelLabel = pending.tunnelId
      ? `#${pending.tunnelId} ${pending.tunnelName || ""}`.trim()
      : "";
    lines.push(`转发方式：<b>${escapeHtml(manageForwardModeLabel(pending.forwardMode))}</b>`);
    lines.push(`入口主机：${aiCode(hostLabel)}`);
    if (tunnelLabel) lines.push(`所属隧道：${aiCode(tunnelLabel)}`);
    lines.push(`入口端口：${pending.sourcePort === 0 ? "<b>随机分配</b>" : aiCode(`:${pending.sourcePort ?? "-"}`)}`);
    lines.push(`目标地址：${aiCode(`${pending.targetIp || "-"}:${pending.targetPort ?? "-"}`)}`);
    lines.push("确认后将创建新规则并下发到对应节点。");
  } else if (action === "rule_delete") {
    const ruleText = pending.rulePreview?.[0] || (pending.ruleId ? `#${pending.ruleId}` : "未指定");
    lines.push(`目标规则：${aiCode(ruleText)}`);
    lines.push("确认后将删除该规则，并同步刷新对应节点。");
  } else if (action === "tunnel_rules_disable" || action === "tunnel_rules_enable") {
    const tunnelLabel = pending.tunnelId
      ? `#${pending.tunnelId} ${pending.tunnelName || ""}`.trim()
      : (pending.tunnelName || "-");
    const previews = pending.rulePreview || [];
    lines.push(`目标隧道：${aiCode(tunnelLabel)}`);
    lines.push(`包含规则：<b>${previews.length}</b> 条`);
    if (previews.length > 0) {
      lines.push("规则清单：");
      const limit = 20;
      for (const item of previews.slice(0, limit)) {
        lines.push(`- ${aiCode(item)}`);
      }
      if (previews.length > limit) {
        lines.push(`- 其余 ${previews.length - limit} 条将一并执行`);
      }
    }
    lines.push(action === "tunnel_rules_disable" ? "确认后将批量停用以上规则。" : "确认后将批量启用以上规则。");
  } else if (action === "traffic_reset") {
    lines.push("将清零该用户当前统计流量。");
  } else if (action === "registration_disable") {
    lines.push("确认后将关闭新用户自助注册，现有用户不受影响。");
  } else if (action === "registration_enable") {
    lines.push("确认后将开放新用户自助注册。");
  } else if (action === "redeem_code_generate_balance") {
    const count = Math.max(1, Math.floor(Number(pending.codeCount || 1)));
    const amountCents = Math.round(Number(pending.amountCents || 0));
    lines.push(`生成数量：<b>${count}</b>`);
    lines.push(`面额：<b>${formatMoneyCny(amountCents)}</b>/个`);
    lines.push(`总面额：<b>${formatMoneyCny(amountCents * count)}</b>`);
    lines.push("确认后将立即生成余额兑换码。");
  } else if (action === "discount_code_generate_percent") {
    const count = Math.max(1, Math.floor(Number(pending.codeCount || 1)));
    const discountPercent = normalizeManageDiscountPercent(pending.discountPercent);
    lines.push(`生成数量：<b>${count}</b>`);
    lines.push(`折扣力度：<b>${escapeHtml(discountPercent ? formatDiscountPercentLabel(discountPercent) : "-")}</b>`);
    lines.push("确认后将立即生成折扣码（默认不限次数，可在后台调整限制）。");
  }
  lines.push("", `原始指令：${aiCode(shortText(pending.sourceText, 120))}`);
  lines.push(`请在 ${Math.round(MANAGE_ACTION_CONFIRM_TTL_MS / 60000)} 分钟内点击「确认执行」。`);
  return lines.join("\n");
}

async function executePendingManageActionUnchecked(pending: PendingManageAction, callbackUser: any) {
  const actor = (await db.getUserById(Number(callbackUser?.id || 0)).catch(() => null)) || callbackUser;
  if (Number(actor?.id || 0) !== Number(pending.actorUserId || 0)) {
    throw new Error("只有原发起人可以确认该操作。");
  }
  const deepseekSettings = await getDeepSeekSettings().catch(() => null);
  if (String(actor?.role) !== "admin" && deepseekSettings?.telegramUserManageEnabled === false) {
    throw new Error("当前仅管理员可使用 AI 对话管理功能。");
  }
  if (!isManageActionAllowedForRole(actor?.role, pending.action)) {
    throw new Error("当前账户已无该操作权限。");
  }
  const sourceText = shortText(pending.sourceText || "", 180);

  if (pending.action === "registration_enable" || pending.action === "registration_disable") {
    if (String(actor?.role) !== "admin") throw new Error("只有管理员可以调整开放注册。");
    const enabled = pending.action === "registration_enable";
    await db.setSetting("registrationEnabled", enabled ? "true" : "false");
    console.info(`[TelegramBot] public registration ${enabled ? "enabled" : "disabled"} by user ${Number(actor.id || 0)}`);
    return [
      "<b>执行成功</b>",
      `操作：${enabled ? "开启开放注册" : "关闭开放注册"}`,
      `当前状态：<b>${enabled ? "已开放" : "已关闭"}</b>`,
    ].join("\n");
  }

  if (isRuleManageAction(pending.action)) {
    if (pending.action === "rule_enable" || pending.action === "rule_disable") {
      const enabled = pending.action === "rule_enable";
      const ruleId = Number(pending.ruleId || 0);
      if (!Number.isFinite(ruleId) || ruleId <= 0) throw new Error("规则 ID 无效。");
      const rule = await toggleRuleForUser(actor, ruleId, enabled);
      const targetUser = Number((rule as any)?.userId || 0) > 0
        ? await db.getUserById(Number((rule as any).userId)).catch(() => null)
        : null;
      return [
        "<b>执行成功</b>",
        targetUser ? `用户：${formatUserLabel(targetUser)}` : "",
        `规则：${aiCode(formatManageRulePreview(rule))}`,
        `操作：${enabled ? "启用规则" : "关闭规则"}`,
      ].filter(Boolean).join("\n");
    }

    if (pending.action === "rule_create") {
      const mode: ManageForwardMode = pending.forwardMode === "tunnel" ? "tunnel" : "host";
      if (mode === "host") {
        throw new Error("普通端口转发请先创建转发组或转发链后再新增规则。");
      }
      const hostId = Number(pending.hostId || 0);
      const tunnelId = mode === "tunnel" ? Number(pending.tunnelId || 0) : 0;
      const targetIp = normalizeManageTargetIp(pending.targetIp || "");
      const targetPort = parseManagePort(pending.targetPort);
      const sourcePort = Number(pending.sourcePort ?? 0);
      if (!Number.isFinite(hostId) || hostId <= 0) throw new Error("入口主机无效。");
      if (!targetIp || !isValidManageRuleTargetHost(targetIp)) throw new Error("目标地址格式无效，请输入 IP 或域名。");
      if (!targetPort) throw new Error("目标端口无效，请输入 1-65535。");
      if (!(sourcePort === 0 || parseManagePort(sourcePort))) {
        throw new Error("源端口无效，请输入 1-65535，或省略源端口使用随机端口。");
      }
      const forwardType = pickManageRuleForwardType(actor, mode);
      const ruleName = `TG-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${sourcePort}`;
      const created = await createDirectForwardRuleForActor(actor, {
        hostId,
        name: shortText(ruleName, 64),
        forwardType,
        protocol: "both",
        gostMode: "direct",
        tunnelId: tunnelId || null,
        forwardGroupId: null,
        sourcePort,
        targetIp,
        targetPort,
        telegramErrorNotifyEnabled: false,
        failoverEnabled: false,
        failoverStrategy: "fallback",
        failoverTargets: [],
        failoverSeconds: 60,
        recoverSeconds: 120,
        autoFailback: true,
      }, { reasonPrefix: "telegram-rule" });
      const tunnel = tunnelId > 0 ? await db.getTunnelById(tunnelId).catch(() => null) : null;
      const createdRule = await db.getForwardRuleById(Number(created.id)).catch(() => null);
      return [
        "<b>执行成功</b>",
        `操作：新增转发规则`,
        `规则：${aiCode(createdRule ? formatManageRulePreview(createdRule) : `#${created.id} :${created.sourcePort} -> ${targetIp}:${targetPort}`)}`,
        `转发方式：${escapeHtml(manageForwardModeLabel(mode))}`,
        `入口端口：${aiCode(`:${created.sourcePort}`)}`,
        tunnelId > 0 ? `隧道：${aiCode(`#${tunnelId} ${(tunnel as any)?.name || ""}`.trim())}` : "",
      ].filter(Boolean).join("\n");
    }

    if (pending.action === "rule_delete") {
      const ruleId = Number(pending.ruleId || 0);
      if (!Number.isFinite(ruleId) || ruleId <= 0) throw new Error("规则 ID 无效。");
      const result = await deleteForwardRuleForActor(actor, ruleId, { reasonPrefix: "telegram-rule" });
      const rule = result.rule;
      const targetUser = Number((rule as any).userId || 0) > 0
        ? await db.getUserById(Number((rule as any).userId)).catch(() => null)
        : null;
      return [
        "<b>执行成功</b>",
        `操作：删除转发规则`,
        targetUser ? `用户：${formatUserLabel(targetUser)}` : "",
        `规则：${aiCode(formatManageRulePreview(rule))}`,
        result.childRules.length > 0 ? `已联动删除子规则：<b>${result.childRules.length}</b> 条` : "",
        result.chargedCents > 0 ? `删除结算扣费：<b>${formatMoneyCny(result.chargedCents)}</b>` : "",
        result.balanceAfterCents !== null ? `当前余额：<b>${formatMoneyCny(result.balanceAfterCents)}</b>` : "",
      ].filter(Boolean).join("\n");
    }

    const enabled = pending.action === "tunnel_rules_enable";
    const ruleIds = Array.from(new Set((pending.ruleIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)));
    if (ruleIds.length === 0) throw new Error("未找到可操作的规则。");

    const successRules: any[] = [];
    const failedRules: Array<{ id: number; reason: string }> = [];
    for (const ruleId of ruleIds) {
      try {
        const rule = await toggleRuleForUser(actor, ruleId, enabled);
        successRules.push(rule);
      } catch (error: any) {
        failedRules.push({ id: ruleId, reason: String(error?.message || "执行失败") });
      }
    }
    if (successRules.length === 0) {
      throw new Error(`批量操作失败：${failedRules[0]?.reason || "没有可操作规则"}`);
    }
    const lines = [
      "<b>批量执行完成</b>",
      `隧道：${aiCode(pending.tunnelId ? `#${pending.tunnelId} ${pending.tunnelName || ""}`.trim() : (pending.tunnelName || "-"))}`,
      `操作：${enabled ? "启用隧道规则" : "关闭隧道规则"}`,
      `成功：<b>${successRules.length}</b> / ${ruleIds.length}`,
      failedRules.length > 0 ? `失败：<b>${failedRules.length}</b>` : "",
    ].filter(Boolean);
    if (successRules.length > 0) {
      lines.push("成功规则：");
      for (const rule of successRules.slice(0, 15)) {
        lines.push(`- ${aiCode(formatManageRulePreview(rule))}`);
      }
      if (successRules.length > 15) lines.push(`- 其余 ${successRules.length - 15} 条已执行`);
    }
    if (failedRules.length > 0) {
      lines.push("失败详情：");
      for (const item of failedRules.slice(0, 8)) {
        lines.push(`- #${item.id} ${escapeHtml(shortText(item.reason, 36))}`);
      }
      if (failedRules.length > 8) lines.push(`- 其余 ${failedRules.length - 8} 条请在面板查看`);
    }
    return lines.join("\n");
  }

  if (pending.action === "redeem_code_generate_balance") {
    if (String(actor?.role) !== "admin") throw new Error("只有管理员可以生成兑换码。");
    if (deepseekSettings?.redemptionEnabled === false) throw new Error("兑换码功能当前已关闭。");
    const codeCount = parseManageCodeCount(pending.codeCount) || 1;
    if (codeCount <= 0 || codeCount > MANAGE_CODE_MAX_COUNT) {
      throw new Error(`兑换码数量必须在 1-${MANAGE_CODE_MAX_COUNT} 之间。`);
    }
    const amountCents = Math.round(Number(pending.amountCents || 0));
    if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error("兑换码金额无效。");
    if (amountCents > MANAGE_BALANCE_MAX_CENTS) {
      throw new Error("兑换码金额超出允许范围，请控制在 1,000,000 元以内。");
    }
    const codes = await db.createRedemptionCodes({
      type: "balance",
      planId: null,
      durationDays: null,
      amountCents,
      startsAt: null,
      expiresAt: null,
      isActive: true,
      createdByUserId: Number(actor.id),
    } as any, codeCount);
    const createdCodes = (codes || []).map((item: any) => String(item || "").trim()).filter(Boolean);
    if (createdCodes.length === 0) throw new Error("兑换码生成失败，请稍后重试。");
    const preview = createdCodes.slice(0, MANAGE_CODE_DISPLAY_LIMIT);
    const lines: string[] = [
      "<b>执行成功</b>",
      "操作：生成余额兑换码",
      `数量：<b>${createdCodes.length}</b>`,
      `面额：<b>${formatMoneyCny(amountCents)}</b>/个`,
      `总面额：<b>${formatMoneyCny(amountCents * createdCodes.length)}</b>`,
      "兑换码：",
      ...preview.map((code) => `- ${aiCode(code)}`),
    ];
    if (createdCodes.length > preview.length) {
      lines.push(`- 其余 ${createdCodes.length - preview.length} 个请到后台账单页面查看`);
    }
    return lines.join("\n");
  }

  if (pending.action === "discount_code_generate_percent") {
    if (String(actor?.role) !== "admin") throw new Error("只有管理员可以生成折扣码。");
    if (deepseekSettings?.discountEnabled === false) throw new Error("折扣码功能当前已关闭。");
    const codeCount = parseManageCodeCount(pending.codeCount) || 1;
    if (codeCount <= 0 || codeCount > MANAGE_CODE_MAX_COUNT) {
      throw new Error(`折扣码数量必须在 1-${MANAGE_CODE_MAX_COUNT} 之间。`);
    }
    const discountPercent = normalizeManageDiscountPercent(pending.discountPercent);
    if (!discountPercent) throw new Error("折扣力度无效，请输入 1-100% 或 1-10 折。");
    const createdCodes: string[] = [];
    for (let i = 0; i < codeCount; i++) {
      const code = await db.createDiscountCode({
        discountType: "percent",
        discountValue: discountPercent,
        maxUses: 0,
        startsAt: null,
        expiresAt: null,
        isActive: true,
        createdByUserId: Number(actor.id),
      } as any, []);
      const codeText = String((code as any)?.code || "").trim();
      if (codeText) createdCodes.push(codeText);
    }
    if (createdCodes.length === 0) throw new Error("折扣码生成失败，请稍后重试。");
    const preview = createdCodes.slice(0, MANAGE_CODE_DISPLAY_LIMIT);
    const lines: string[] = [
      "<b>执行成功</b>",
      "操作：生成折扣码",
      `数量：<b>${createdCodes.length}</b>`,
      `折扣力度：<b>${escapeHtml(formatDiscountPercentLabel(discountPercent))}</b>`,
      "折扣码：",
      ...preview.map((code) => `- ${aiCode(code)}`),
    ];
    if (createdCodes.length > preview.length) {
      lines.push(`- 其余 ${createdCodes.length - preview.length} 个请到后台账单页面查看`);
    }
    return lines.join("\n");
  }

  const targetUserId = Number(pending.targetUserId || 0);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    throw new Error("目标用户无效。");
  }
  const target = await db.getUserById(targetUserId);
  if (!target) throw new Error("目标用户不存在或已被删除。");
  if (String(actor?.role) !== "admin" && Number(target.id) !== Number(actor.id)) {
    throw new Error("普通用户仅可操作自己的账号。");
  }

  switch (pending.action) {
    case "balance_set": {
      const amountCents = Math.round(Number(pending.amountCents || 0));
      if (!Number.isFinite(amountCents) || amountCents < 0) throw new Error("余额金额无效。");
      const result = await setUserBalanceCommand({
        actor,
        targetUserId: Number(target.id),
        balanceCents: amountCents,
        description: `Telegram 余额设置：${sourceText}`,
        reasonPrefix: "telegram-balance-set",
      });
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：设置余额",
        `当前余额：<b>${formatMoneyCny(result.balanceCents)}</b>`,
      ].join("\n");
    }
    case "balance_adjust": {
      const amountCents = Math.round(Number(pending.amountCents || 0));
      if (!Number.isFinite(amountCents) || amountCents === 0) throw new Error("调整金额无效。");
      const result = await adjustUserBalanceCommand({
        actor,
        targetUserId: Number(target.id),
        amountCents,
        description: `Telegram 余额调整：${sourceText}`,
        reasonPrefix: "telegram-balance-adjust",
      });
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：调整余额",
        `变更金额：<b>${amountCents >= 0 ? "+" : ""}${formatMoneyCny(amountCents)}</b>`,
        `当前余额：<b>${formatMoneyCny(result.balanceCents)}</b>`,
      ].join("\n");
    }
    case "renew": {
      const durationValue = Math.max(1, Math.floor(Number(pending.durationValue || 1)));
      const durationUnit: ManageDurationUnit = pending.durationUnit || "month";
      const { nextExpiresAt } = getRenewalDatesByDuration(target, durationValue, durationUnit);
      await renewUserCommand({ actor, targetUserId: Number(target.id), expiresAt: nextExpiresAt, reasonPrefix: "telegram-user-renewed" });
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        `操作：续费 ${escapeHtml(formatManageDuration(durationValue, durationUnit))}`,
        `新到期时间：<b>${escapeHtml(formatDateTime(nextExpiresAt))}</b>`,
      ].join("\n");
    }
    case "account_disable": {
      await setUserAccountEnabledCommand({ actor, targetUserId: Number(target.id), enabled: false, reasonPrefix: "telegram-user-account" });
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：停用账号",
      ].join("\n");
    }
    case "account_enable": {
      await setUserAccountEnabledCommand({ actor, targetUserId: Number(target.id), enabled: true, reasonPrefix: "telegram-user-account" });
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：启用账号",
      ].join("\n");
    }
    case "forward_disable": {
      await setUserForwardAccessCommand({ actor, targetUserId: Number(target.id), enabled: false, reasonPrefix: "telegram-user-forward" });
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：关闭转发",
      ].join("\n");
    }
    case "forward_enable": {
      await setUserForwardAccessCommand({ actor, targetUserId: Number(target.id), enabled: true, reasonPrefix: "telegram-user-forward" });
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：启用转发",
      ].join("\n");
    }
    case "traffic_reset": {
      await resetUserTrafficCommand({ actor, targetUserId: Number(target.id), reasonPrefix: "telegram-user-traffic-reset" });
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：重置流量",
      ].join("\n");
    }
    default:
      throw new Error("暂不支持的管理操作。");
  }
}

export async function executePendingManageAction(pending: PendingManageAction, callbackUser: any) {
  const startedAt = Date.now();
  try {
    const result = await executePendingManageActionUnchecked(pending, callbackUser);
    appendAiAudit({
      phase: "execute",
      result: "success",
      actorUserId: Number(callbackUser?.id || pending.actorUserId || 0) || null,
      actorRole: String(callbackUser?.role || pending.actorRole || ""),
      action: pending.action,
      ruleId: pending.ruleId,
      tunnelId: pending.tunnelId,
      hostId: pending.hostId,
      targetUserId: pending.targetUserId,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendAiAudit({
      phase: "execute",
      result: /(权限|无权|只有|禁止|不允许)/.test(detail) ? "denied" : "failed",
      actorUserId: Number(callbackUser?.id || pending.actorUserId || 0) || null,
      actorRole: String(callbackUser?.role || pending.actorRole || ""),
      action: pending.action,
      ruleId: pending.ruleId,
      tunnelId: pending.tunnelId,
      hostId: pending.hostId,
      targetUserId: pending.targetUserId,
      durationMs: Date.now() - startedAt,
      detail,
    });
    throw error;
  }
}

export async function tryHandleManageAction(message: TelegramMessage, user: any, rawText: string) {
  const query = rawText.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!query) return false;
  const deepseekSettings = await getDeepSeekSettings().catch(() => null);
  const userManageDisabled = String(user?.role) !== "admin" && deepseekSettings?.telegramUserManageEnabled === false;
  const activeClarify = getPendingManageClarifySession(message.chat.id, user.id);
  if (activeClarify) {
    if (/^(取消|放弃|算了|退出|cancel)$/i.test(query)) {
      clearPendingManageClarifySession(message.chat.id, user.id);
      const sent = await sendMessage(message.chat.id, "已取消本次操作。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
      return true;
    }
    if (userManageDisabled) {
      const sent = await sendMessage(message.chat.id, "当前仅管理员可使用 AI 对话管理功能。");
      await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
      return true;
    }
    const extractedPatch = extractManageIntentPatchFromText(query, activeClarify.missingFields || []);
    const contextualPatch = normalizeManagePresetCustomPatch({
      action: activeClarify.action,
      sourceText: activeClarify.sourceText,
      missingFields: activeClarify.missingFields,
    }, extractedPatch);
    const mergedIntent = mergeManageActionIntent(activeClarify.intent, contextualPatch);
    const mergedSourceText = `${activeClarify.sourceText}\n补充：${query}`.slice(0, 500);
    const prepared = await prepareManageAction(user, mergedSourceText, mergedIntent);
    if (prepared.clarify) {
      createPendingManageClarifySession(
        message.chat.id,
        prepared.clarify.actor || user,
        mergedSourceText,
        prepared.clarify.intent,
        prepared.clarify.missingFields,
      );
      const sent = await sendMessage(
        message.chat.id,
        prepared.clarify.text,
        prepared.clarify.keyboard || manageClarifyCancelKeyboard(),
      );
      await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
      return true;
    }
    if (!prepared.prepared) {
      const sent = await sendMessage(
        message.chat.id,
        `${prepared.error || "信息仍不完整，请继续补充。"}\n\n可继续补充信息，或发送“取消”结束本次操作。`,
        manageClarifyCancelKeyboard(),
      );
      await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
      return true;
    }
    clearPendingManageClarifySession(message.chat.id, user.id);
    const pending = createPendingManageAction(prepared.prepared.pending);
    appendAiAudit({
      phase: "preview",
      result: "success",
      actorUserId: Number(user.id),
      actorRole: String(user.role || ""),
      action: pending.action,
      ruleId: pending.ruleId,
      tunnelId: pending.tunnelId,
      hostId: pending.hostId,
      targetUserId: pending.targetUserId,
    });
    const sent = await sendMessage(
      message.chat.id,
      manageActionConfirmText(pending, prepared.prepared.actor, prepared.prepared.target),
      manageActionConfirmKeyboard(pending.key),
    );
    await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
    return true;
  }

  const { intent, writeLike } = await parseManageActionIntent(query);
  if (!writeLike || intent.action === "none") return false;
  if (userManageDisabled) {
    const sent = await sendMessage(message.chat.id, "当前仅管理员可使用 AI 对话管理功能。");
    await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
    return true;
  }
  const prepared = await prepareManageAction(user, query, intent);
  if (prepared.clarify) {
    createPendingManageClarifySession(
      message.chat.id,
      prepared.clarify.actor || user,
      query,
      prepared.clarify.intent,
      prepared.clarify.missingFields,
    );
    const sent = await sendMessage(
      message.chat.id,
      prepared.clarify.text,
      prepared.clarify.keyboard || manageClarifyCancelKeyboard(),
    );
    await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
    return true;
  }
  if (!prepared.prepared) {
    const sent = await sendMessage(message.chat.id, prepared.error || "未识别到可执行的管理操作。");
    await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
    return true;
  }
  const pending = createPendingManageAction(prepared.prepared.pending);
  appendAiAudit({
    phase: "preview",
    result: "success",
    actorUserId: Number(user.id),
    actorRole: String(user.role || ""),
    action: pending.action,
    ruleId: pending.ruleId,
    tunnelId: pending.tunnelId,
    hostId: pending.hostId,
    targetUserId: pending.targetUserId,
  });
  const sent = await sendMessage(
    message.chat.id,
    manageActionConfirmText(pending, prepared.prepared.actor, prepared.prepared.target),
    manageActionConfirmKeyboard(pending.key),
  );
  await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
  return true;
}

export async function toggleRuleForUser(user: any, ruleId: number, enabled: boolean) {
  if (!Number.isFinite(ruleId) || ruleId <= 0) {
    throw new Error("规则 ID 无效");
  }
  const result = await toggleForwardRuleForActor(user, ruleId, enabled, { reasonPrefix: "telegram-rule" });
  return result.rule;
}

export async function executePendingUpdateAction(pending: PendingUpdateAction) {
  if (pending.kind === "panel") {
    const targetVersion = String(pending.targetVersion || "").trim() || undefined;
    const result = await startPanelUpgradeTask(targetVersion || null);
    if (!result?.success) {
      return [
        "<b>面板升级暂未开始</b>",
        targetVersion ? `目标版本：<b>v${escapeHtml(targetVersion)}</b>` : "",
        "",
        escapeHtml(result?.pendingReason || "发布资产仍在构建中，请稍后重新检查更新。"),
      ].filter(Boolean).join("\n");
    }
    return [
      "<b>面板升级任务已启动</b>",
      `目标版本：<b>v${escapeHtml(result?.targetVersion || targetVersion || "latest")}</b>`,
      "",
      "可在网页后台的系统设置中查看升级状态和日志。",
    ].join("\n");
  }

  const targetVersion = String(pending.targetVersion || AGENT_VERSION || "").trim() || String(AGENT_VERSION || "latest");
  const hostIds = Array.from(new Set((pending.hostIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)));
  if (hostIds.length === 0) {
    return "没有可执行更新的 Agent 主机，请重新检查。";
  }
  const configuredPanelUrl = String((await db.getSetting("panelPublicUrl")) || "").trim();
  const panelUrl = /^https?:\/\//i.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
  let requested = 0;
  let pushed = 0;
  let skippedLatest = 0;
  let missing = 0;
  let failed = 0;
  const failedHostIds: number[] = [];
  for (const hostId of hostIds) {
    const host = await db.getHostById(hostId);
    if (!host) {
      missing += 1;
      continue;
    }
    const currentVersion = String((host as any)?.agentVersion || "").trim();
    if (currentVersion && isHostAgentUpgradeUnnecessary({ agentVersion: currentVersion, fxpVersion: (host as any)?.fxpVersion }, targetVersion, AGENT_VERSION)) {
      skippedLatest += 1;
      continue;
    }
    try {
      await db.requestHostAgentUpgrade(hostId, targetVersion);
      requested += 1;
      if (pushAgentUpgrade(hostId, targetVersion, panelUrl)) pushed += 1;
    } catch {
      failed += 1;
      failedHostIds.push(hostId);
    }
  }
  const failedText = failedHostIds.length
    ? `失败主机：${failedHostIds.slice(0, 10).map((id) => `#${id}`).join(" ")}${failedHostIds.length > 10 ? " ..." : ""}`
    : "";
  return [
    "<b>Agent 升级任务已处理</b>",
    `目标版本：<b>v${escapeHtml(targetVersion)}</b>`,
    `待升级目标：${hostIds.length}`,
    `已下发升级：${requested}`,
    `已在线推送：${pushed}`,
    skippedLatest > 0 ? `已是最新：${skippedLatest}` : "",
    missing > 0 ? `主机不存在：${missing}` : "",
    failed > 0 ? `下发失败：${failed}` : "",
    failedText ? escapeHtml(failedText) : "",
  ].filter(Boolean).join("\n");
}
