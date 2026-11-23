import { checkPanelUpdateTask } from "../_core/systemRouter";
import { ACCOUNT_DISABLED_ERR_MSG } from "../../shared/const";
import { formatBytes } from "../../shared/formatBytes";
import { fxpRuntimeStatus } from "../../shared/fxpRuntime";
import { escapeHtmlText as escapeHtml } from "../../shared/htmlEscape";
import { formatDigestHour } from "../../shared/opsDigest";
import { PIN_DURATION_OPTIONS } from "../../shared/routePolicy";
import { AGENT_VERSION, APP_VERSION } from "../../shared/versions";
import { isAgentVersionAtLeast, isHostAgentUpgradeUnnecessary } from "../agentRouteUtils";
import { appendAiAudit } from "../ai/audit";
import type { ManagePresetField } from "../ai/managePresets";
import { parseManagePresetSelection } from "../ai/managePresets";
import * as db from "../db";
import { ENV } from "../env";
import { KeyedTaskDispatcher } from "../keyedTaskDispatcher";
import { getDigestHour } from "../ops/digestContent";
import { isPanelBackgroundLeaseHolder } from "../panelLease";
import { refreshUserForwardEndpoints } from "../routers/helpers";
import { toggleForwardRuleForActor } from "../routers/rules.crud";
import { renewUserCommand, resetUserTrafficCommand, setUserForwardAccessCommand } from "../services/userCommandService";
import { isTelegramUnauthorizedError, telegramPollingRetryDelayMs } from "./telegramApiError";
import type { TelegramMoreIO } from "./telegramBotMore";
import { handleTelegramMoreCallback, handleTelegramMoreCommand, handleTelegramMoreReply, telegramKeywordCommand } from "./telegramBotMore";
import { TELEGRAM_LOGIN_SWITCHED_OFF_MESSAGE, isTelegramLoginEnabled } from "./telegramLoginSwitch";
import { clearMobileTelegramLoginChallenge, hasMobileTelegramLoginChallenge } from "./telegramMobileLogin";
import { TELEGRAM_NOTIFY_CATEGORIES, isTelegramDigestEnabled, isTelegramNotifyMuted, readTelegramNotifyPrefs, updateTelegramNotifyPref } from "./telegramNotifyPrefs";
import type { TelegramNotifyCategory } from "./telegramNotifyPrefs";
import { createTelegramWebAppLoginChallenge } from "./telegramWebAppLogin";
import { aiInteractionRateLimiter, aiQueryText, ruleLatestTestView, startRuleLatencyTest, usageText, userInfoText } from "./telegramAi";
import type { ManageActionIntent, ManageForwardMode } from "./telegramAi";
import { buildTelegramDigestText } from "./telegramDigest";
import { clearPendingManageClarifySession, createPendingManageAction, createPendingManageClarifySession, executePendingManageAction, executePendingUpdateAction, getPendingManageAction, getPendingManageClarifySession, getPendingUpdateAction, getRenewalDates, manageActionConfirmKeyboard, manageActionConfirmText, manageClarifyCancelKeyboard, manageClarifyModeKeyboard, managePresetClarifyUi, pendingManageActions, prepareManageAction, scheduleAiMessageAutoRecall, toggleRuleForUser, tryHandleManageAction } from "./telegramManage";
import type { TelegramMessage, TelegramUser } from "./telegramManage";
import { AI_PROCESSING_MESSAGE_DELAY_MS, AI_PROCESSING_MESSAGE_TEXT, BIND_SESSION_TTL_MS, LOGIN_CODE_TTL_MS, LOGIN_SUCCESS_MESSAGE_DELETE_MS, MANAGE_CLARIFY_TTL_MS, REDEEM_SESSION_TTL_MS, TELEGRAM_UPDATE_CONCURRENCY, UPDATE_ACTION_CONFIRM_TTL_MS, UPDATE_AGENT_PREVIEW_LIMIT, UPDATE_COMMAND_COOLDOWN_MS, USER_PAGE_SIZE, clampPage, formatDateTime, formatMoneyCny, parseCommand, randomCode, shortText } from "./telegramText";
import { deleteMessage, deleteMessageLater, editMessage, getTelegramSettings, sendChatAction, sendMessage, telegramApi } from "./telegramTransport";
import type { InlineKeyboardMarkup, TelegramSentMessage } from "./telegramTransport";
import { adminUserKeyboard, adminUserText, backMenuKeyboard, buildTelegramWebAppUrl, createPendingUpdateAction, hostDetailView, hostUpgradeConfirm, hostsView, mainMenuKeyboard, pendingUpdateActions, routePickView, routePinApply, routeView, routesView, ruleDetailKeyboard, ruleDetailText, ruleListBackKeyboard, rulesView, updateActionConfirmKeyboard, visibleRuleForTelegram, webAppOpenKeyboard } from "./telegramViews";
import type { UpdateCommandKind } from "./telegramViews";

// 拆出去的部分照旧从这里导出（调用方不用改）：
export { buildTelegramDigestText, runDiscordDigests, runTelegramDigests } from "./telegramDigest";
export { formatRuleTestResult } from "./telegramText";
export { sendTelegramMessage } from "./telegramTransport";
export { effectiveRuleStatusInfo, mainMenuKeyboard, panelButton, webAppOpenKeyboard } from "./telegramViews";
/** @public telegramRuleStatusProbeAge.test.ts 经 import(url(...)) 动态引用 */
export { aiRuleTrafficSummaryMap } from "./telegramViews";

type TelegramCallbackQuery = {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

type TelegramBotCommand = {
  command: string;
  description: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

let pollingStarted = false;

let pollingAbort = false;

let updateOffset = 0;

let activeTokenKey = "";

const pendingBindChats = new Map<string, number>();

const pendingRedeemChats = new Map<string, number>();

const updateCommandRateLimit = new Map<string, number>();

const telegramUpdateDispatcher = new KeyedTaskDispatcher(TELEGRAM_UPDATE_CONCURRENCY);

const TELEGRAM_BOT_COMMANDS: TelegramBotCommand[] = [
  { command: "start", description: "打开菜单或完成账号绑定" },
  { command: "menu", description: "打开功能菜单" },
  { command: "usage", description: "查询流量和额度" },
  { command: "rules", description: "查看和管理转发规则" },
  { command: "hosts", description: "主机状态和负载" },
  { command: "routes", description: "线路组状态和切换" },
  { command: "links", description: "链路：出口在用 / 备用、手动切换" },
  { command: "buy", description: "用余额续费 / 买套餐" },
  { command: "notify", description: "通知开关" },
  { command: "digest", description: "查看今日简报" },
  { command: "ask", description: "自然语言查询面板信息" },
  { command: "redeem", description: "兑换余额或套餐兑换码" },
  { command: "bind", description: "使用绑定码绑定后台账号" },
  { command: "login", description: "生成网页登录链接" },
  { command: "webapp", description: "在 Telegram 内打开面板" },
  { command: "unbind", description: "解除 Telegram 绑定" },
  { command: "users", description: "管理员用户管理" },
  { command: "reset", description: "管理员重置用户流量" },
  { command: "renew", description: "管理员续期用户套餐" },
  { command: "system", description: "管理员系统开关（注册、商店、维护）" },
  { command: "updatepanel", description: "管理员更新面板（需确认）" },
  { command: "updateagent", description: "管理员更新 Agent（需确认）" },
  { command: "help", description: "查看帮助" },
];

function isMobileLoginCode(value: string | undefined) {
  return /^APP[A-Z0-9]{20,64}$/i.test((value || "").trim());
}

function consumePendingManageAction(actionKey: string) {
  const pending = getPendingManageAction(actionKey);
  if (!pending) return null;
  pendingManageActions.delete(pending.key);
  return pending;
}

function getUpdateRateLimitKey(actorUserId: number | string, kind: UpdateCommandKind) {
  return `${Number(actorUserId) || 0}:${kind}`;
}

function cleanupExpiredUpdateRateLimits() {
  const now = Date.now();
  for (const [key, ts] of updateCommandRateLimit.entries()) {
    if (!Number.isFinite(ts) || now - ts > UPDATE_COMMAND_COOLDOWN_MS * 3) updateCommandRateLimit.delete(key);
  }
}

function takeUpdateCommandCooldown(actorUserId: number | string, kind: UpdateCommandKind) {
  cleanupExpiredUpdateRateLimits();
  const key = getUpdateRateLimitKey(actorUserId, kind);
  const now = Date.now();
  const lastAt = updateCommandRateLimit.get(key) || 0;
  const waitMs = UPDATE_COMMAND_COOLDOWN_MS - (now - lastAt);
  if (waitMs > 0) return waitMs;
  updateCommandRateLimit.set(key, now);
  return 0;
}

function consumePendingUpdateAction(actionKey: string) {
  const pending = getPendingUpdateAction(actionKey);
  if (!pending) return null;
  pendingUpdateActions.delete(pending.key);
  return pending;
}

function getBindSessionKey(chatId: number | string, telegramId: string | number) {
  return `${chatId}:${telegramId}`;
}

function startBindSession(chatId: number | string, telegramId: string | number) {
  pendingBindChats.set(getBindSessionKey(chatId, telegramId), Date.now() + BIND_SESSION_TTL_MS);
}

function hasValidBindSession(chatId: number | string, telegramId: string | number) {
  const key = getBindSessionKey(chatId, telegramId);
  const expiresAt = pendingBindChats.get(key) || 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    pendingBindChats.delete(key);
    return false;
  }
  return true;
}

function clearBindSession(chatId: number | string, telegramId: string | number) {
  pendingBindChats.delete(getBindSessionKey(chatId, telegramId));
}

function getRedeemSessionKey(chatId: number | string, telegramId: string | number) {
  return `${chatId}:${telegramId}`;
}

function startRedeemSession(chatId: number | string, telegramId: string | number) {
  pendingRedeemChats.set(getRedeemSessionKey(chatId, telegramId), Date.now() + REDEEM_SESSION_TTL_MS);
}

function hasValidRedeemSession(chatId: number | string, telegramId: string | number) {
  const key = getRedeemSessionKey(chatId, telegramId);
  const expiresAt = pendingRedeemChats.get(key) || 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    pendingRedeemChats.delete(key);
    return false;
  }
  return true;
}

function clearRedeemSession(chatId: number | string, telegramId: string | number) {
  pendingRedeemChats.delete(getRedeemSessionKey(chatId, telegramId));
}

function getTokenKey(token: string) {
  if (!token) return "";
  return `${token.length}:${token.slice(0, 8)}:${token.slice(-8)}`;
}

async function syncTelegramBotCommands() {
  const settings = await getTelegramSettings();
  if (!settings.token) return false;
  await telegramApi("setMyCommands", {
    commands: TELEGRAM_BOT_COMMANDS,
    scope: { type: "default" },
  });
  return true;
}

async function withTemporaryProcessingMessage<T>(
  chatId: number | string,
  task: () => Promise<T>,
  options: { delayMs?: number; text?: string } = {},
) {
  const delayMs = Math.max(0, Number(options.delayMs ?? AI_PROCESSING_MESSAGE_DELAY_MS));
  const text = options.text || AI_PROCESSING_MESSAGE_TEXT;
  let completed = false;
  let processingMessage: TelegramSentMessage | null = null;
  let sendPending: Promise<void> | null = null;
  const timer = setTimeout(() => {
    if (completed) return;
    sendPending = sendMessage(chatId, text)
      .then((message) => {
        if (completed) {
          deleteMessage(chatId, message.message_id).catch(() => undefined);
          return;
        }
        processingMessage = message;
      })
      .catch(() => undefined);
  }, delayMs);
  (timer as any).unref?.();
  sendChatAction(chatId).catch(() => undefined);
  try {
    return await task();
  } finally {
    completed = true;
    clearTimeout(timer);
    const pendingSend = sendPending as Promise<void> | null;
    if (pendingSend) await pendingSend.catch(() => undefined);
    const sentMessage = processingMessage as TelegramSentMessage | null;
    if (sentMessage?.message_id) {
      await deleteMessage(chatId, sentMessage.message_id).catch(() => undefined);
    }
  }
}

async function answerCallback(callbackId: string, text?: string) {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  });
}

async function ensureTelegramUser(from?: TelegramUser) {
  if (!from?.id || from.is_bot) return null;
  const telegramId = String(from.id);
  const user = await db.getUserByTelegramId(telegramId);
  if (user) {
    await db.updateTelegramLastSeen(telegramId, {
      username: from.username || null,
      firstName: from.first_name || null,
      lastName: from.last_name || null,
    });
  }
  return { telegramId, user, from };
}

async function ensureTelegramIdentity(message: TelegramMessage) {
  return ensureTelegramUser(message.from);
}

function helpText(bound: boolean, isAdmin = false) {
  const base = [
    "NEX Telegram Bot",
    "",
    bound
      ? "可用命令："
      : "请先在面板个人菜单点击 Telegram 绑定按钮生成绑定码，然后在这里完成绑定。",
    "/usage - 查询我的用量",
    "/rules - 查看我的转发规则（详情里可测延迟、改目标、改名、重启、删除）",
    "/links - 链路：出口在用 / 备用，手动切换（自己的链路）",
    "/buy - 用余额续费 / 买套餐",
    "/hosts - 主机状态和负载（加主机、拿安装命令、维护模式）",
    "/routes - 线路组状态，临时改走别的路径",
    "/notify - 通知开关、每日简报",
    "/digest - 现在看一份简报",
    "/ask 问题 - 用自然语言查询面板信息",
    "/redeem 兑换码 - 兑换余额或套餐",
    "/login - 生成网页一次性登录链接",
    "/webapp - 在 Telegram 内打开面板",
    "/enable 规则ID - 启用规则",
    "/disable 规则ID - 停用规则",
    "/unbind - 解除当前 Telegram 绑定（需要确认）",
    "",
    "也可以直接打「菜单」「流量」「规则」「链路」「续费」这些词。",
  ];
  if (isAdmin) {
    base.push(
      "",
      "管理员命令：",
      "/users - 用户管理（加流量、调余额、换套餐、封禁）",
      "/system - 系统：开放注册、商店、维护模式、今天收入；生成兑换码 / 折扣码、发公告、重启全部 Agent",
      "/reset 用户ID - 重置用户流量",
      "/renew 用户ID - 续期用户一个月",
      "/updatepanel - 检查并更新面板（60 秒限流）",
      "/updateagent - 检查并更新 Agent（60 秒限流）",
    );
  }
  return base.map(escapeHtml).join("\n");
}

function bindPromptKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🔗 绑定 Telegram", callback_data: "fx:bind:start" }],
    ],
  };
}

function bindCancelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "❌ 取消绑定", callback_data: "fx:bind:cancel" }],
    ],
  };
}

function redeemCancelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "❌ 取消兑换", callback_data: "fx:redeem:cancel" }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function unbindConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "⚠️ 确认解除绑定", callback_data: "fx:unbind:confirm" },
        { text: "❌ 取消", callback_data: "fx:menu" },
      ],
    ],
  };
}

function mobileLoginConfirmKeyboard(code: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ 确认登录", callback_data: `fx:app-login:${code}` },
        { text: "❌ 取消", callback_data: `fx:app-login-cancel:${code}` },
      ],
    ],
  };
}

async function sendBindPrompt(chatId: number | string) {
  await sendMessage(
    chatId,
    [
      "<b>绑定 Telegram</b>",
      "",
      "当前 Telegram 尚未绑定 NEX 账户。",
      "请先在网页面板的个人菜单里点击 Telegram 绑定生成绑定码，然后点击下面按钮并发送绑定码。",
    ].join("\n"),
    bindPromptKeyboard(),
  );
}

async function sendBindCodePrompt(chatId: number | string, telegramId: string | number) {
  startBindSession(chatId, telegramId);
  await sendMessage(
    chatId,
    [
      "<b>请输入绑定码</b>",
      "",
      `请在 ${Math.round(BIND_SESSION_TTL_MS / 60000)} 分钟内直接发送网页面板生成的 Telegram 绑定码。`,
      "绑定码通常是一串大写字母和数字。",
    ].join("\n"),
    bindCancelKeyboard(),
  );
}

async function editBindCodePrompt(chatId: number | string, messageId: number, telegramId: string | number) {
  startBindSession(chatId, telegramId);
  await editMessage(
    chatId,
    messageId,
    [
      "<b>请输入绑定码</b>",
      "",
      `请在 ${Math.round(BIND_SESSION_TTL_MS / 60000)} 分钟内直接发送网页面板生成的 Telegram 绑定码。`,
      "绑定码通常是一串大写字母和数字。",
    ].join("\n"),
    bindCancelKeyboard(),
  );
}

async function sendRedeemCodePrompt(chatId: number | string, telegramId: string | number) {
  startRedeemSession(chatId, telegramId);
  await sendMessage(
    chatId,
    [
      "<b>兑换码</b>",
      "",
      `请在 ${Math.round(REDEEM_SESSION_TTL_MS / 60000)} 分钟内直接发送余额或套餐兑换码。`,
      "也可以使用命令：/redeem 兑换码",
    ].join("\n"),
    redeemCancelKeyboard(),
  );
}

async function editRedeemCodePrompt(chatId: number | string, messageId: number, telegramId: string | number) {
  startRedeemSession(chatId, telegramId);
  await editMessage(
    chatId,
    messageId,
    [
      "<b>兑换码</b>",
      "",
      `请在 ${Math.round(REDEEM_SESSION_TTL_MS / 60000)} 分钟内直接发送余额或套餐兑换码。`,
      "也可以使用命令：/redeem 兑换码",
    ].join("\n"),
    redeemCancelKeyboard(),
  );
}

function userManageBackKeyboard(page = 0): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "👥 返回用户列表", callback_data: `fx:users:${page}` }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function renewalConfirmKeyboard(userId: number, page = 0): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ 确认续期 1 个月", callback_data: `fx:admin:renew:confirm:${userId}:${page}` },
        { text: "❌ 取消", callback_data: `fx:admin:user:${userId}:${page}` },
      ],
      [{ text: "👤 返回用户详情", callback_data: `fx:admin:user:${userId}:${page}` }],
    ],
  };
}

function menuText(user: any) {
  const title = user?.role === "admin" ? "NEX 管理菜单" : "NEX 用户菜单";
  return [
    `<b>${escapeHtml(title)}</b>`,
    "",
    `当前账户：<b>${escapeHtml(user?.name || user?.username || "-")}</b>`,
    `角色：${user?.role === "admin" ? "管理员" : "用户"}`,
    "",
    "请选择下面的功能按钮。",
  ].join("\n");
}

async function usersView(page = 0) {
  const users = await db.getUserTrafficSummaries();
  const { page: safePage, totalPages } = clampPage(page, users.length, USER_PAGE_SIZE);
  const visible = users.slice(safePage * USER_PAGE_SIZE, safePage * USER_PAGE_SIZE + USER_PAGE_SIZE);
  const text = visible.length === 0
    ? "<b>用户管理</b>\n\n暂无用户。"
    : [
        "<b>用户管理</b>",
        `第 ${safePage + 1}/${totalPages} 页，共 ${users.length} 个用户`,
        "",
        ...visible.map((user: any) => {
          const limit = Number(user.trafficLimit) || 0;
          const access = user.role === "admin" || user.canAddRules ? "转发启用" : "转发停用";
          return `#${user.id} <b>${escapeHtml(shortText(user.name || user.username, 18))}</b> · ${user.role === "admin" ? "管理员" : "用户"}\n${access} · ${escapeHtml(formatBytes(user.trafficUsed))}/${limit > 0 ? escapeHtml(formatBytes(limit)) : "不限"}`;
        }),
      ].join("\n\n");
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const user of visible) {
    rows.push([{ text: `🛠 管理 #${user.id} ${shortText(user.name || user.username, 14)}`, callback_data: `fx:admin:user:${user.id}:${safePage}` }]);
  }
  if (totalPages > 1) {
    rows.push([
      { text: "⬅️ 上一页", callback_data: `fx:users:${Math.max(0, safePage - 1)}` },
      { text: "➡️ 下一页", callback_data: `fx:users:${Math.min(totalPages - 1, safePage + 1)}` },
    ]);
  }
  rows.push([{ text: "🏠 返回菜单", callback_data: "fx:menu" }]);
  return { text, keyboard: { inline_keyboard: rows } };
}

async function renewalConfirmText(userId: number) {
  const target = await db.getUserById(userId);
  if (!target) return { target: null, text: "用户不存在。" };
  const { base, nextExpiresAt } = getRenewalDates(target, 1);
  const text = [
    "<b>确认套餐续期</b>",
    "",
    `用户：#${target.id} ${escapeHtml(target.name || target.username)}`,
    `当前到期：${escapeHtml(formatDateTime(target.expiresAt))}`,
    `续期方式：从${base.getTime() > Date.now() ? "当前到期时间" : "当前时间"}起延长 1 个月`,
    `续期后到期：<b>${escapeHtml(formatDateTime(nextExpiresAt))}</b>`,
    "",
    "请确认后再执行续期。",
  ].join("\n");
  return { target, text, nextExpiresAt };
}

async function renewUserOneMonth(actor: any, userId: number) {
  const target = await db.getUserById(userId);
  if (!target) throw new Error("用户不存在");
  const { nextExpiresAt } = getRenewalDates(target, 1);
  await renewUserCommand({ actor, targetUserId: userId, expiresAt: nextExpiresAt, reasonPrefix: "telegram-command-user-renewed" });
  return { target, nextExpiresAt };
}

async function loginText(user: any) {
  // 管理员关了 Telegram 登录：不再发一次性网页登录链接（发了面板那头也不认，见 server/telegramLoginSwitch.ts）。
  if (!(await isTelegramLoginEnabled())) return TELEGRAM_LOGIN_SWITCHED_OFF_MESSAGE;
  const settings = await getTelegramSettings();
  const code = randomCode(32);
  const expiresAt = new Date(Date.now() + LOGIN_CODE_TTL_MS);
  await db.createTelegramLoginCode(user.id, code, expiresAt);
  const path = `/login?tg=${encodeURIComponent(code)}`;
  const url = settings.panelPublicUrl ? `${settings.panelPublicUrl}${path}` : path;
  return [
    "<b>网页登录</b>",
    "",
    "一次性登录链接 5 分钟内有效：",
    escapeHtml(url),
    "",
    settings.panelPublicUrl ? "" : `如果未配置面板公开访问地址，请在浏览器打开面板后访问：${escapeHtml(path)}`,
  ].filter(Boolean).join("\n");
}

async function sendMainMenu(chatId: number | string, user: any) {
  const settings = await getTelegramSettings();
  const webAppUrl = settings.panelPublicUrl
    ? buildTelegramWebAppUrl(
      settings.panelPublicUrl,
      createTelegramWebAppLoginChallenge({ telegramId: user?.telegramId || null }),
    )
    : "";
  try {
    await sendMessage(chatId, menuText(user), mainMenuKeyboard(user, webAppUrl || undefined));
  } catch (error) {
    if (!webAppUrl || !isPanelButtonRejection(error)) throw error;
    await sendMessage(chatId, menuText(user), mainMenuKeyboard(user));
  }
}

async function editMainMenu(chatId: number | string, messageId: number, user: any) {
  const settings = await getTelegramSettings();
  const webAppUrl = settings.panelPublicUrl
    ? buildTelegramWebAppUrl(
      settings.panelPublicUrl,
      createTelegramWebAppLoginChallenge({ telegramId: user?.telegramId || null }),
    )
    : "";
  try {
    await editMessage(chatId, messageId, menuText(user), mainMenuKeyboard(user, webAppUrl || undefined));
  } catch (error) {
    if (!webAppUrl || !isPanelButtonRejection(error)) throw error;
    await editMessage(chatId, messageId, menuText(user), mainMenuKeyboard(user));
  }
}

/** Telegram 不收面板按钮的地址（非 https、内网、域名不合规）时，菜单退成不带面板按钮的版本，菜单本身照常能用。 */
function isPanelButtonRejection(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /button|URL|HTTPS/i.test(message);
}

async function telegramHostStatusGlobalEnabled() {
  const settings = await db.getAllSettings();
  return settings.telegramHostStatusNotify === "true";
}

async function notifyView(user: any, notice = "") {
  const prefs = await readTelegramNotifyPrefs();
  const isAdmin = user.role === "admin";
  const digestOn = isTelegramDigestEnabled(prefs, user);
  const hostGlobal = isAdmin ? await telegramHostStatusGlobalEnabled() : true;
  const lines = [
    "<b>🔔 通知设置</b>",
    notice ? `\n${notice}` : "",
    "",
    isAdmin ? "这里只改发给你的那一份，不影响其他管理员。" : "",
  ];
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  // 主机 / 规则 / 线路只发给管理员；工单两边都有，普通用户也列出来。
  for (const category of TELEGRAM_NOTIFY_CATEGORIES) {
    if (category.adminOnly && !isAdmin) continue;
    const on = !isTelegramNotifyMuted(prefs, user.id, category.key);
    lines.push(`${on ? "✅" : "🔕"} ${category.label}${category.key === "host" && !hostGlobal ? "（面板总开关是关的）" : ""}`);
    rows.push([{ text: `${on ? "🔕 关闭" : "✅ 打开"}${category.label}`, callback_data: `fx:notify:t:${category.key}` }]);
  }
  lines.push(`${digestOn ? "✅" : "🔕"} 每日简报（每天 ${formatDigestHour(await getDigestHour())}）`);
  rows.push([{ text: `${digestOn ? "🔕 关闭" : "✅ 打开"}每日简报`, callback_data: `fx:notify:digest:${digestOn ? "0" : "1"}` }]);
  if (isAdmin && !hostGlobal) {
    rows.push([{ text: "🖥 打开主机上下线总开关", callback_data: "fx:notify:hostglobal" }]);
  }
  rows.push([{ text: "📰 现在看一份简报", callback_data: "fx:digest" }]);
  rows.push([{ text: "🏠 返回菜单", callback_data: "fx:menu" }]);
  if (isAdmin) lines.push("", "规则异常和线路切换只对面板里开了 Telegram 通知的规则发。");
  return { text: lines.filter((line, index) => line !== "" || index === 2).join("\n").replace(/\n{3,}/g, "\n\n"), keyboard: { inline_keyboard: rows } as InlineKeyboardMarkup };
}

async function handleBind(message: TelegramMessage, code: string) {
  const from = message.from;
  if (!from?.id || from.is_bot) return;
  const normalized = code.trim().toUpperCase();
  const user = await db.getUserByTelegramBindCode(normalized);
  if (!user) {
    if (from?.id) startBindSession(message.chat.id, from.id);
    await sendMessage(message.chat.id, "绑定码无效。请在面板中重新生成或检查后再次发送。", bindCancelKeyboard());
    return;
  }
  const expiresAt = user.telegramBindCodeExpiresAt ? new Date(user.telegramBindCodeExpiresAt).getTime() : 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    await db.clearTelegramBindCode(user.id);
    if (from?.id) startBindSession(message.chat.id, from.id);
    await sendMessage(message.chat.id, "绑定码已过期。请在面板中重新生成绑定码后再次发送。", bindCancelKeyboard());
    return;
  }
  await db.bindTelegramAccount(user.id, {
    id: String(from.id),
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null,
  });
  await sendMessage(
    message.chat.id,
    `已绑定到 NEX 账户：<b>${escapeHtml(user.name || user.username)}</b>\n之后可以使用 /usage、/rules 和功能菜单。`,
  );
  const boundUser = await db.getUserById(user.id);
  if (boundUser) await sendMainMenu(message.chat.id, boundUser);
}

async function handleMobileLoginStart(message: TelegramMessage, code: string, user: any | null | undefined) {
  const normalized = code.trim().toUpperCase();
  if (!hasMobileTelegramLoginChallenge(normalized)) {
    await sendMessage(message.chat.id, "登录请求已过期，请回到 NEX 重新发起。");
    return;
  }
  if (!user) {
    await sendMessage(message.chat.id, "当前 Telegram 未绑定任何 NEX 账户，请先使用账号密码登录后绑定 Telegram。", bindPromptKeyboard());
    return;
  }
  if ((user as any).accountEnabled === false) {
    await sendMessage(message.chat.id, ACCOUNT_DISABLED_ERR_MSG);
    return;
  }
  await sendMessage(
    message.chat.id,
    [
      "<b>NEX 登录确认</b>",
      "",
      `将登录账户：<b>${escapeHtml(user.name || user.username)}</b>`,
      "如果这是你本人操作，请点击下方按钮确认。登录请求 5 分钟内有效。",
    ].join("\n"),
    mobileLoginConfirmKeyboard(normalized),
  );
}

async function confirmMobileLogin(chatId: number | string, messageId: number, code: string, user: any) {
  const normalized = code.trim().toUpperCase();
  if (!hasMobileTelegramLoginChallenge(normalized)) {
    await editMessage(chatId, messageId, "登录请求已过期，请回到 NEX 重新发起。");
    return;
  }
  if ((user as any).accountEnabled === false) {
    await editMessage(chatId, messageId, ACCOUNT_DISABLED_ERR_MSG);
    return;
  }
  await db.createTelegramLoginCode(user.id, normalized, new Date(Date.now() + LOGIN_CODE_TTL_MS));
  await editMessage(chatId, messageId, "登录已确认，请返回 NEX。");
  deleteMessageLater(chatId, messageId, LOGIN_SUCCESS_MESSAGE_DELETE_MS);
}

async function handleAiInteraction(message: TelegramMessage, user: any, rawText: string) {
  const rateLimit = aiInteractionRateLimiter.consume(`user:${Number(user?.id || 0) || message.chat.id}`);
  if (!rateLimit.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000));
    appendAiAudit({
      phase: "rate_limit",
      result: "denied",
      actorUserId: Number(user?.id || 0) || null,
      actorRole: String(user?.role || ""),
      detail: `retryAfterSeconds=${retryAfterSeconds}`,
    });
    const sent = await sendMessage(message.chat.id, `AI 请求过于频繁，请 ${retryAfterSeconds} 秒后再试。`);
    await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
    return;
  }

  const startedAt = Date.now();
  let text: string;
  let manageHandled = false;
  try {
    await withTemporaryProcessingMessage(message.chat.id, async () => {
      manageHandled = await tryHandleManageAction(message, user, rawText);
      if (manageHandled) return;
      text = await aiQueryText(user, rawText);
      const sent = await sendMessage(message.chat.id, text);
      await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
    });
    if (!manageHandled) {
      appendAiAudit({
        phase: "query",
        result: "success",
        actorUserId: Number(user?.id || 0) || null,
        actorRole: String(user?.role || ""),
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (error: any) {
    console.warn("[TelegramBot] AI query failed:", error);
    appendAiAudit({
      phase: manageHandled ? "preview" : "query",
      result: "failed",
      actorUserId: Number(user?.id || 0) || null,
      actorRole: String(user?.role || ""),
      durationMs: Date.now() - startedAt,
      detail: error?.message || String(error),
    });
    text = `查询失败：${escapeHtml(error?.message || "请稍后重试")}`;
    const sent = await sendMessage(message.chat.id, text);
    await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
  }
}

async function handleUsage(message: TelegramMessage, user: any) {
  await sendMessage(message.chat.id, await usageText(user));
}

async function handleRules(message: TelegramMessage, user: any) {
  const view = await rulesView(user, 0);
  await sendMessage(message.chat.id, view.text, view.keyboard);
}

function redeemSuccessText(result: any) {
  if (result.type === "balance") {
    return [
      "<b>兑换成功</b>",
      "",
      `类型：余额`,
      `入账金额：${formatMoneyCny(result.amountCents)}`,
      `当前余额：${formatMoneyCny(result.balanceCents)}`,
    ].join("\n");
  }
  if (result.type === "plan") {
    return [
      "<b>兑换成功</b>",
      "",
      `类型：套餐`,
      `套餐：${escapeHtml(result.planName || `套餐 #${result.planId}`)}`,
      result.durationDays ? `有效期：${result.durationDays} 天` : "",
      `到期时间：${escapeHtml(formatDateTime(result.expiresAt))}`,
      result.portRangeStart && result.portRangeEnd ? `端口段：${result.portRangeStart}-${result.portRangeEnd}` : "",
    ].filter(Boolean).join("\n");
  }
  return "<b>兑换成功</b>";
}

async function redeemForTelegramUser(user: any, code: string, attemptScope?: string | null) {
  const normalized = code.trim();
  if (!normalized) throw new Error("请输入兑换码");
  if (user.role === "admin") throw new Error("管理员账户无需兑换码");
  const result = await db.redeemCode(user.id, normalized, attemptScope || `tg:${user.telegramId || user.id}`);
  const recovery = await db.recoverUserForwardAccessIfEligible(user.id);
  if (recovery.restored) {
    await refreshUserForwardEndpoints(user.id, "telegram-code-redeemed-forward-restored");
  }
  return result;
}

async function handleRedeem(message: TelegramMessage, user: any, code?: string) {
  if (!code?.trim()) {
    if (message.from?.id) await sendRedeemCodePrompt(message.chat.id, message.from.id);
    return;
  }
  try {
    const result = await redeemForTelegramUser(user, code, `tg:${message.chat.id}:${message.from?.id || user.telegramId || user.id}`);
    await sendMessage(message.chat.id, redeemSuccessText(result), backMenuKeyboard());
  } catch (error: any) {
    await sendMessage(message.chat.id, `兑换失败：${escapeHtml(error?.message || "兑换码无效")}`, redeemCancelKeyboard());
  }
}

async function handleRuleToggle(message: TelegramMessage, user: any, ruleIdRaw: string | undefined, enabled: boolean) {
  const ruleId = Number(ruleIdRaw);
  if (!Number.isFinite(ruleId) || ruleId <= 0) {
    await sendMessage(message.chat.id, `请发送 ${enabled ? "/enable" : "/disable"} 规则ID，例如：${enabled ? "/enable" : "/disable"} 12`);
    return;
  }
  try {
    const result = await toggleForwardRuleForActor(user, ruleId, enabled, { reasonPrefix: "telegram-rule" });
    await sendMessage(message.chat.id, `规则 #${result.rule.id} ${enabled ? "已启用，等待 Agent 应用配置" : "已停用"}。`);
  } catch (error: any) {
    await sendMessage(message.chat.id, error?.message || `无法${enabled ? "启用" : "停用"}规则。`);
  }
}

async function handleLogin(message: TelegramMessage, user: any) {
  await sendMessage(message.chat.id, await loginText(user));
}

async function handleWebApp(message: TelegramMessage, user?: any | null) {
  if (user && (user as any).accountEnabled === false) {
    await sendMessage(message.chat.id, ACCOUNT_DISABLED_ERR_MSG);
    return;
  }
  const settings = await getTelegramSettings();
  const webAppUrl = settings.panelPublicUrl
    ? buildTelegramWebAppUrl(
      settings.panelPublicUrl,
      createTelegramWebAppLoginChallenge({ telegramId: user?.telegramId || message.from?.id || null }),
    )
    : "";
  if (!webAppUrl) {
    await sendMessage(message.chat.id, "管理员尚未配置可公开访问的面板地址，暂时无法在 Telegram 内打开面板。");
    return;
  }
  await sendMessage(
    message.chat.id,
    [
      "<b>NEX WebApp</b>",
      "",
      user
        ? "点击下方按钮可在 Telegram 内打开面板，已绑定账号会自动登录。"
        : "点击下方按钮打开面板后，请先用账号密码登录并在个人设置完成 Telegram 绑定。",
      "为保障安全，请勿将入口链接分享给他人。",
    ].join("\n"),
    webAppOpenKeyboard(webAppUrl),
  );
}

async function handleUsers(message: TelegramMessage) {
  const view = await usersView(0);
  await sendMessage(message.chat.id, view.text, view.keyboard);
}

async function handleReset(message: TelegramMessage, actor: any, userIdRaw: string | undefined) {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) {
    await sendMessage(message.chat.id, "请发送 /reset 用户ID，例如：/reset 8");
    return;
  }
  try {
    const result = await resetUserTrafficCommand({ actor, targetUserId: userId, reasonPrefix: "telegram-command-traffic-reset" });
    await sendMessage(message.chat.id, `用户 #${userId} ${escapeHtml(result.target.name || result.target.username)} 的流量已重置。`);
  } catch (error: any) {
    await sendMessage(message.chat.id, error?.message || "重置用户流量失败。");
  }
}

async function handleRenew(message: TelegramMessage, userIdRaw: string | undefined) {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) {
    await sendMessage(message.chat.id, "请发送 /renew 用户ID，例如：/renew 8。该操作需要二次确认。");
    return;
  }
  const detail = await renewalConfirmText(userId);
  await sendMessage(message.chat.id, detail.text, detail.target ? renewalConfirmKeyboard(userId, 0) : undefined);
}

async function handleUpdatePanel(message: TelegramMessage, user: any) {
  const waitMs = takeUpdateCommandCooldown(user.id, "panel");
  if (waitMs > 0) {
    await sendMessage(message.chat.id, `操作太频繁，请 ${Math.max(1, Math.ceil(waitMs / 1000))} 秒后再试。`);
    return;
  }
  const info = await checkPanelUpdateTask(true);
  if (info.error) {
    await sendMessage(message.chat.id, `检查面板更新失败：${escapeHtml(info.error)}`);
    return;
  }
  const currentVersion = String(info.currentVersion || APP_VERSION).trim() || APP_VERSION;
  const latestVersion = String(info.latestVersion || "").trim();
  if (!latestVersion) {
    await sendMessage(message.chat.id, "暂时未获取到最新面板版本，请稍后重试。");
    return;
  }
  if (!info.hasUpdate) {
    if (info.pendingReason) {
      await sendMessage(
        message.chat.id,
        [
          "<b>面板更新检查</b>",
          `当前版本：<b>v${escapeHtml(currentVersion)}</b>`,
          `最新版本：<b>v${escapeHtml(latestVersion)}</b>`,
          "",
          escapeHtml(info.pendingReason),
        ].join("\n"),
      );
      return;
    }
    await sendMessage(
      message.chat.id,
      [
        "<b>面板更新检查</b>",
        `当前版本：<b>v${escapeHtml(currentVersion)}</b>`,
        `最新版本：<b>v${escapeHtml(latestVersion)}</b>`,
        "",
        "当前已经是最新版本。",
      ].join("\n"),
    );
    return;
  }
  const pending = createPendingUpdateAction({
    actorUserId: Number(user.id),
    kind: "panel",
    targetVersion: latestVersion,
  });
  await sendMessage(
    message.chat.id,
    [
      "<b>检测到面板新版本</b>",
      `当前版本：<b>v${escapeHtml(currentVersion)}</b>`,
      `目标版本：<b>v${escapeHtml(latestVersion)}</b>`,
      "",
      "确认后将开始后台升级任务，期间面板可能短暂重启。",
      `请在 ${Math.round(UPDATE_ACTION_CONFIRM_TTL_MS / 60000)} 分钟内确认。`,
    ].join("\n"),
    updateActionConfirmKeyboard("panel", pending.key),
  );
}

async function handleUpdateAgent(message: TelegramMessage, user: any) {
  const waitMs = takeUpdateCommandCooldown(user.id, "agent");
  if (waitMs > 0) {
    await sendMessage(message.chat.id, `操作太频繁，请 ${Math.max(1, Math.ceil(waitMs / 1000))} 秒后再试。`);
    return;
  }
  const hosts = await db.getHosts() as any[];
  if (hosts.length === 0) {
    await sendMessage(message.chat.id, "当前没有可升级的 Agent 主机。");
    return;
  }
  const targetVersion = String(AGENT_VERSION || "").trim() || "latest";
  const outdated = hosts.filter((host) => {
    const current = String(host?.agentVersion || "").trim();
    if (!current) return true;
    if (!isAgentVersionAtLeast(current, targetVersion)) return true;
    // Agent 已是最新、FXP 却旧了（或没装）：重跑安装脚本才能修好。
    return !isHostAgentUpgradeUnnecessary(host, targetVersion, AGENT_VERSION);
  });
  if (outdated.length === 0) {
    await sendMessage(
      message.chat.id,
      [
        "<b>Agent 更新检查</b>",
        `目标版本：<b>v${escapeHtml(targetVersion)}</b>`,
        `主机数量：${hosts.length}`,
        "",
        "所有主机的 Agent 已是最新版本。",
      ].join("\n"),
    );
    return;
  }
  const hostIds = outdated
    .map((host) => Number(host?.id || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  const preview = outdated.slice(0, UPDATE_AGENT_PREVIEW_LIMIT).map((host) => {
    const hostId = Number(host?.id || 0);
    const hostName = shortText(host?.name || host?.ip || host?.entryIp || `主机${hostId}`, 20);
    const current = String(host?.agentVersion || "").trim() || "未知";
    const fxp = fxpRuntimeStatus(host);
    const fxpNote = fxp.needsUpgrade ? ` · FXP ${escapeHtml(fxp.label)}` : "";
    return `- #${hostId} ${escapeHtml(hostName)} · v${escapeHtml(current)}${fxpNote} -> v${escapeHtml(targetVersion)}`;
  });
  if (outdated.length > UPDATE_AGENT_PREVIEW_LIMIT) {
    preview.push(`- 其余 ${outdated.length - UPDATE_AGENT_PREVIEW_LIMIT} 台主机将一并下发升级`);
  }
  const pending = createPendingUpdateAction({
    actorUserId: Number(user.id),
    kind: "agent",
    targetVersion,
    hostIds,
  });
  await sendMessage(
    message.chat.id,
    [
      "<b>检测到可升级 Agent</b>",
      `目标版本：<b>v${escapeHtml(targetVersion)}</b>`,
      `可升级主机：<b>${outdated.length}</b> / ${hosts.length}`,
      "",
      ...preview,
      "",
      `请在 ${Math.round(UPDATE_ACTION_CONFIRM_TTL_MS / 60000)} 分钟内确认执行。`,
    ].join("\n"),
    updateActionConfirmKeyboard("agent", pending.key),
  );
}

async function handleMessage(message: TelegramMessage) {
  const text = message.text?.trim();
  if (!text) return;
  const parsedCommand = parseCommand(text);
  let command = parsedCommand.command;
  const args = parsedCommand.args;
  const identity = await ensureTelegramIdentity(message);
  if (!identity) return;
  const waitingForBindCode = hasValidBindSession(message.chat.id, identity.telegramId);
  const waitingForRedeemCode = hasValidRedeemSession(message.chat.id, identity.telegramId);

  if (command === "/start" && args[0]) {
    if (isMobileLoginCode(args[0])) {
      await handleMobileLoginStart(message, args[0], identity.user);
      return;
    }
    await handleBind(message, args[0]);
    return;
  }
  if (command === "/start" || command === "/help") {
    if (identity.user) {
      if ((identity.user as any).accountEnabled === false) {
        await sendMessage(message.chat.id, ACCOUNT_DISABLED_ERR_MSG);
        return;
      }
      await sendMainMenu(message.chat.id, identity.user);
    } else {
      await sendBindPrompt(message.chat.id);
    }
    return;
  }
  if (command === "/bind") {
    if (identity.user) {
      if ((identity.user as any).accountEnabled === false) {
        await sendMessage(message.chat.id, ACCOUNT_DISABLED_ERR_MSG);
        return;
      }
      await sendMainMenu(message.chat.id, identity.user);
      return;
    }
    if (args[0]) await handleBind(message, args[0]);
    else await sendBindCodePrompt(message.chat.id, identity.telegramId);
    return;
  }
  if (command === "/webapp") {
    await handleWebApp(message, identity.user);
    return;
  }

  const user = identity.user;
  if (!user) {
    if (waitingForBindCode && !text.startsWith("/")) {
      await handleBind(message, text);
      clearBindSession(message.chat.id, identity.telegramId);
      return;
    }
    await sendBindPrompt(message.chat.id);
    return;
  }
  if ((user as any).accountEnabled === false) {
    await sendMessage(message.chat.id, ACCOUNT_DISABLED_ERR_MSG);
    return;
  }

  if (waitingForRedeemCode && !text.startsWith("/")) {
    clearRedeemSession(message.chat.id, identity.telegramId);
    await handleRedeem(message, user, text);
    return;
  }

  // 2.3.538（telegramBotMore.ts）：在等回复的（改目标 / 改名 / 调余额）、直接打「菜单」「链路」这类词、/links /buy /system
  const moreIO: TelegramMoreIO = {
    edit: (body, keyboard) => sendMessage(message.chat.id, body, keyboard),
    send: (body, keyboard) => sendMessage(message.chat.id, body, keyboard),
  };
  if (!text.startsWith("/") && await handleTelegramMoreReply({ chatId: message.chat.id, telegramId: identity.telegramId, user, text, io: moreIO })) return;
  if (!text.startsWith("/")) command = telegramKeywordCommand(text) || command;
  if (command === "/help") {
    await sendMessage(message.chat.id, helpText(true, user.role === "admin"));
    return;
  }
  if (await handleTelegramMoreCommand(command, user, moreIO)) return;

  if (command === "/menu") return sendMainMenu(message.chat.id, user);
  if (command === "/usage") return handleUsage(message, user);
  if (command === "/hosts") {
    const view = await hostsView(user, 0);
    await sendMessage(message.chat.id, view.text, view.keyboard);
    return;
  }
  if (command === "/routes") {
    const view = await routesView(user, 0);
    await sendMessage(message.chat.id, view.text, view.keyboard);
    return;
  }
  if (command === "/notify") {
    const view = await notifyView(user);
    await sendMessage(message.chat.id, view.text, view.keyboard);
    return;
  }
  if (command === "/digest") {
    await sendMessage(message.chat.id, await buildTelegramDigestText(user), backMenuKeyboard());
    return;
  }
  if (command === "/rules") return handleRules(message, user);
  if (command === "/ask") {
    return handleAiInteraction(message, user, text);
  }
  if (command === "/redeem") return handleRedeem(message, user, args.join(" "));
  if (command === "/login") return handleLogin(message, user);
  if (command === "/webapp") return handleWebApp(message, user);
  if (command === "/enable") return handleRuleToggle(message, user, args[0], true);
  if (command === "/disable") return handleRuleToggle(message, user, args[0], false);
  if (command === "/unbind") {
    await sendMessage(message.chat.id, "确认解除当前 Telegram 绑定吗？解除后需要重新绑定才能使用机器人。", unbindConfirmKeyboard());
    return;
  }

  if (user.role === "admin" && command === "/users") return handleUsers(message);
  if (user.role === "admin" && command === "/reset") return handleReset(message, user, args[0]);
  if (user.role === "admin" && command === "/renew") return handleRenew(message, args[0]);
  if (user.role === "admin" && command === "/updatepanel") return handleUpdatePanel(message, user);
  if (user.role === "admin" && command === "/updateagent") return handleUpdateAgent(message, user);

  if (!text.startsWith("/")) {
    return handleAiInteraction(message, user, text);
  }

  await sendMessage(message.chat.id, helpText(true, user.role === "admin"));
}

async function handleCallback(query: TelegramCallbackQuery) {
  if (!query.message?.chat?.id || !query.message.message_id) return;
  await answerCallback(query.id).catch(() => undefined);
  const identity = await ensureTelegramUser(query.from);
  if (!identity) return;
  const user = identity.user;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data || "";
  if (data === "fx:bind:start") {
    if (user) {
      if ((user as any).accountEnabled === false) {
        await editMessage(chatId, messageId, ACCOUNT_DISABLED_ERR_MSG);
        return;
      }
      await editMainMenu(chatId, messageId, user);
    } else {
      await editBindCodePrompt(chatId, messageId, identity.telegramId);
    }
    return;
  }
  if (data === "fx:bind:cancel") {
    clearBindSession(chatId, identity.telegramId);
    await editMessage(chatId, messageId, "已取消本次绑定。需要绑定时可再次点击下方按钮。", bindPromptKeyboard());
    return;
  }
  if (!user) {
    await editMessage(chatId, messageId, "当前 Telegram 尚未绑定 NEX 账户。请先完成绑定。", bindPromptKeyboard());
    return;
  }
  if ((user as any).accountEnabled === false) {
    await editMessage(chatId, messageId, ACCOUNT_DISABLED_ERR_MSG);
    return;
  }

  if (data.startsWith("fx:x:")) {
    const handled = await handleTelegramMoreCallback({
      data,
      chatId,
      telegramId: identity.telegramId,
      user,
      io: {
        edit: (body, keyboard) => editMessage(chatId, messageId, body, keyboard),
        send: (body, keyboard) => sendMessage(chatId, body, keyboard),
      },
    });
    if (handled) return;
  }

  if (data.startsWith("fx:app-login:")) {
    await confirmMobileLogin(chatId, messageId, data.slice("fx:app-login:".length), user);
    return;
  }
  if (data.startsWith("fx:app-login-cancel:")) {
    clearMobileTelegramLoginChallenge(data.slice("fx:app-login-cancel:".length));
    await editMessage(chatId, messageId, "已取消本次登录。");
    return;
  }

  if (data.startsWith("fx:update:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , kindRaw, opRaw, actionKeyRaw] = data.split(":");
    const kind: UpdateCommandKind | null = kindRaw === "panel" || kindRaw === "agent" ? kindRaw : null;
    const op = opRaw === "confirm" || opRaw === "cancel" ? opRaw : null;
    const actionKey = String(actionKeyRaw || "").trim().toLowerCase();
    if (!kind || !op || !actionKey) {
      await editMessage(chatId, messageId, "无法识别该更新操作，请重新执行命令。", backMenuKeyboard());
      return;
    }
    const pending = getPendingUpdateAction(actionKey);
    if (!pending || pending.kind !== kind) {
      await editMessage(chatId, messageId, "更新操作已超时或已被处理，请重新执行命令。", backMenuKeyboard());
      return;
    }
    if (Number(pending.actorUserId) !== Number(user.id)) {
      await editMessage(chatId, messageId, "只有原发起人才可以确认或取消该更新操作。", updateActionConfirmKeyboard(kind, pending.key));
      return;
    }
    if (op === "cancel") {
      consumePendingUpdateAction(actionKey);
      await editMessage(chatId, messageId, "已取消本次更新操作。", backMenuKeyboard());
      return;
    }
    const consumed = consumePendingUpdateAction(actionKey);
    if (!consumed || consumed.kind !== kind) {
      await editMessage(chatId, messageId, "更新操作已超时或已被处理，请重新执行命令。", backMenuKeyboard());
      return;
    }
    const result = await executePendingUpdateAction(consumed)
      .catch((error) => `执行更新失败：${escapeHtml(error instanceof Error ? error.message : String(error))}`);
    await editMessage(chatId, messageId, result, backMenuKeyboard());
    return;
  }

  if (data === "fx:redeem") {
    if (user.role === "admin") {
      await editMessage(chatId, messageId, "管理员账户无需兑换码。", backMenuKeyboard());
      return;
    }
    await editRedeemCodePrompt(chatId, messageId, identity.telegramId);
    return;
  }
  if (data === "fx:redeem:cancel") {
    clearRedeemSession(chatId, identity.telegramId);
    await editMessage(chatId, messageId, "已取消本次兑换。", backMenuKeyboard());
    return;
  }

  if (data.startsWith("fx:rules:")) {
    const page = Number(data.split(":")[2] || 0);
    const view = await rulesView(user, page);
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:rule:view:")) {
    const [, , , ruleIdRaw, pageRaw] = data.split(":");
    const ruleId = Number(ruleIdRaw);
    const page = Number(pageRaw || 0);
    const rule = await visibleRuleForTelegram(user, ruleId);
    await editMessage(chatId, messageId, await ruleDetailText(ruleId, user), rule ? ruleDetailKeyboard(rule, page) : ruleListBackKeyboard(page));
    return;
  }
  if (data.startsWith("fx:rule:test:")) {
    const [, , , ruleIdRaw, pageRaw] = data.split(":");
    await startRuleLatencyTest(chatId, messageId, user, Number(ruleIdRaw), Number(pageRaw || 0));
    return;
  }
  if (data.startsWith("fx:rule:testres:")) {
    const [, , , ruleIdRaw, pageRaw] = data.split(":");
    const view = await ruleLatestTestView(user, Number(ruleIdRaw), Number(pageRaw || 0));
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:hosts:")) {
    const view = await hostsView(user, Number(data.split(":")[2] || 0));
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:host:upgrade:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , hostIdRaw] = data.split(":");
    const view = await hostUpgradeConfirm(user, Number(hostIdRaw));
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:host:")) {
    const [, , hostIdRaw, pageRaw] = data.split(":");
    const view = await hostDetailView(user, Number(hostIdRaw), Number(pageRaw || 0));
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:routes:")) {
    const view = await routesView(user, Number(data.split(":")[2] || 0));
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:route:")) {
    const parts = data.split(":");
    let view: { text: string; keyboard: InlineKeyboardMarkup };
    if (parts[2] === "pick") {
      view = await routePickView(user, Number(parts[3]), Number(parts[4]), Number(parts[5] || 0));
    } else if (parts[2] === "pin") {
      const option = PIN_DURATION_OPTIONS[Number(parts[5])];
      view = option
        ? await routePinApply(user, Number(parts[3]), Number(parts[4]), option.seconds, Number(parts[6] || 0))
        : await routeView(user, Number(parts[3]), Number(parts[6] || 0));
    } else if (parts[2] === "auto") {
      view = await routePinApply(user, Number(parts[3]), null, null, Number(parts[4] || 0));
    } else {
      view = await routeView(user, Number(parts[2]), Number(parts[3] || 0));
    }
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:notify:")) {
    const parts = data.split(":");
    let notice = "";
    if (parts[2] === "t" && TELEGRAM_NOTIFY_CATEGORIES.some((item) => item.key === parts[3] && (!item.adminOnly || user.role === "admin"))) {
      await updateTelegramNotifyPref(Number(user.id), { toggleCategory: parts[3] as TelegramNotifyCategory });
      notice = "已更新。";
    } else if (parts[2] === "digest") {
      await updateTelegramNotifyPref(Number(user.id), { digest: parts[3] === "1" });
      notice = parts[3] === "1" ? `已打开，每天 ${formatDigestHour(await getDigestHour())} 发给你。` : "已关闭每日简报。";
    } else if (parts[2] === "hostglobal" && user.role === "admin") {
      await db.setSetting("telegramHostStatusNotify", "true");
      notice = "已打开主机上下线总开关（面板设置里同一个开关）。";
    }
    const view = await notifyView(user, notice);
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:rule:toggle:")) {
    const [, , , ruleIdRaw, pageRaw] = data.split(":");
    const ruleId = Number(ruleIdRaw);
    const page = Number(pageRaw || 0);
    const rule = await db.getForwardRuleById(ruleId);
    if (!rule) {
      await editMessage(chatId, messageId, "规则不存在。", ruleListBackKeyboard(page));
      return;
    }
    await toggleRuleForUser(user, ruleId, !rule.isEnabled);
    const view = await rulesView(user, page);
    await editMessage(chatId, messageId, `规则 #${ruleId} 已${rule.isEnabled ? "停用" : "启用"}。\n\n${view.text}`, view.keyboard);
    return;
  }
  if (data.startsWith("fx:users:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const page = Number(data.split(":")[2] || 0);
    const view = await usersView(page);
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:admin:user:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , userIdRaw, pageRaw] = data.split(":");
    const userId = Number(userIdRaw);
    const page = Number(pageRaw || 0);
    const detail = await adminUserText(userId);
    await editMessage(chatId, messageId, detail.text, detail.target ? await adminUserKeyboard(userId, page) : userManageBackKeyboard(page));
    return;
  }
  if (data.startsWith("fx:admin:reset:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , userIdRaw, pageRaw] = data.split(":");
    const userId = Number(userIdRaw);
    const page = Number(pageRaw || 0);
    const target = await db.getUserById(userId);
    if (!target) {
      await editMessage(chatId, messageId, "用户不存在。", userManageBackKeyboard(page));
      return;
    }
    await resetUserTrafficCommand({ actor: user, targetUserId: userId, reasonPrefix: "telegram-menu-traffic-reset" });
    const detail = await adminUserText(userId);
    await editMessage(chatId, messageId, `已重置用户 #${userId} 的流量。\n\n${detail.text}`, await adminUserKeyboard(userId, page));
    return;
  }
  if (data.startsWith("fx:admin:access:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , userIdRaw, enabledRaw, pageRaw] = data.split(":");
    const userId = Number(userIdRaw);
    const page = Number(pageRaw || 0);
    const target = await db.getUserById(userId);
    if (!target) {
      await editMessage(chatId, messageId, "用户不存在。", userManageBackKeyboard(page));
      return;
    }
    if (target.role === "admin") {
      await editMessage(chatId, messageId, "管理员账户不能在机器人内停用转发权限。", await adminUserKeyboard(userId, page));
      return;
    }
    const enabled = enabledRaw === "1";
    await setUserForwardAccessCommand({ actor: user, targetUserId: userId, enabled, reasonPrefix: "telegram-menu-user-forward" });
    const detail = await adminUserText(userId);
    await editMessage(chatId, messageId, `已${enabled ? "启用" : "停用"}用户 #${userId} 的转发权限。\n\n${detail.text}`, await adminUserKeyboard(userId, page));
    return;
  }
  if (data.startsWith("fx:admin:renew:confirm:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , , userIdRaw, pageRaw] = data.split(":");
    const userId = Number(userIdRaw);
    const page = Number(pageRaw || 0);
    const result = await renewUserOneMonth(user, userId);
    const detail = await adminUserText(userId);
    await editMessage(
      chatId,
      messageId,
      `已为用户 #${userId} 续期 1 个月。\n新到期时间：<b>${escapeHtml(formatDateTime(result.nextExpiresAt))}</b>\n\n${detail.text}`,
      await adminUserKeyboard(userId, page),
    );
    return;
  }
  if (data.startsWith("fx:admin:renew:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , userIdRaw, pageRaw] = data.split(":");
    const userId = Number(userIdRaw);
    const page = Number(pageRaw || 0);
    const detail = await renewalConfirmText(userId);
    await editMessage(chatId, messageId, detail.text, detail.target ? renewalConfirmKeyboard(userId, page) : userManageBackKeyboard(page));
    return;
  }

  if (data.startsWith("fx:op:clarify:")) {
    const session = getPendingManageClarifySession(chatId, user.id);
    if (!session) {
      await editMessage(chatId, messageId, "补充信息会话已超时，请重新发送操作指令。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    const action = data.slice("fx:op:clarify:".length);
    if (action === "cancel") {
      clearPendingManageClarifySession(chatId, user.id);
      await editMessage(chatId, messageId, "已取消本次操作。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }

    if (action.startsWith("custom:")) {
      const field = action.slice("custom:".length) as ManagePresetField;
      const presetUi = managePresetClarifyUi(session.action, session.sourceText, session.missingFields);
      if (!presetUi || presetUi.field !== field) {
        await editMessage(chatId, messageId, "该输入项已经变化，请根据当前提示重新选择。", manageClarifyCancelKeyboard());
        await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
        return;
      }
      createPendingManageClarifySession(
        chatId,
        user,
        session.sourceText,
        session.intent,
        session.missingFields,
      );
      await editMessage(
        chatId,
        messageId,
        `${presetUi.customPrompt}\n\n发送“取消”可结束本次操作，${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效。`,
        manageClarifyCancelKeyboard(),
      );
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }

    const nextIntent: ManageActionIntent = { ...session.intent };
    const presetMatch = action.match(/^preset:([^:]+):([^:]+)$/);
    if (presetMatch) {
      const field = presetMatch[1] as ManagePresetField;
      const value = presetMatch[2];
      const presetUi = managePresetClarifyUi(session.action, session.sourceText, session.missingFields);
      const isCurrentChoice = presetUi?.field === field
        && presetUi.choices.some((choice) => choice.value === value);
      const patch = isCurrentChoice ? parseManagePresetSelection(field, value) : null;
      if (!patch) {
        await editMessage(chatId, messageId, "预设选项无效或已经过期，请根据当前提示重新选择。", manageClarifyCancelKeyboard());
        await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
        return;
      }
      Object.assign(nextIntent, patch);
    } else if (action.startsWith("mode:")) {
      const modeRaw = action.slice("mode:".length);
      if (modeRaw !== "host" && modeRaw !== "tunnel") {
        await editMessage(chatId, messageId, "转发模式选项无效，请重新选择。", manageClarifyModeKeyboard());
        await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
        return;
      }
      nextIntent.forwardMode = modeRaw as ManageForwardMode;
      if (modeRaw === "host") delete nextIntent.tunnel;
      if (modeRaw === "tunnel") delete nextIntent.host;
    } else if (action.startsWith("tunnel:")) {
      const tunnelId = Number(action.slice("tunnel:".length));
      if (!Number.isFinite(tunnelId) || tunnelId <= 0) {
        await editMessage(chatId, messageId, "隧道选项无效，请重新选择。", manageClarifyCancelKeyboard());
        await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
        return;
      }
      nextIntent.forwardMode = "tunnel";
      nextIntent.tunnel = String(tunnelId);
      delete nextIntent.host;
    } else if (action.startsWith("host:")) {
      const hostId = Number(action.slice("host:".length));
      if (!Number.isFinite(hostId) || hostId <= 0) {
        await editMessage(chatId, messageId, "主机选项无效，请重新选择。", manageClarifyCancelKeyboard());
        await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
        return;
      }
      nextIntent.forwardMode = "host";
      nextIntent.host = String(hostId);
      delete nextIntent.tunnel;
    } else if (action.startsWith("rule:")) {
      const ruleId = Number(action.slice("rule:".length));
      if (!Number.isFinite(ruleId) || ruleId <= 0) {
        await editMessage(chatId, messageId, "规则选项无效，请重新选择。", manageClarifyCancelKeyboard());
        await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
        return;
      }
      nextIntent.ruleId = ruleId;
    } else {
      await editMessage(chatId, messageId, "无法识别该补充操作，请重新发送指令。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }

    const prepared = await prepareManageAction(user, session.sourceText, nextIntent);
    if (prepared.clarify) {
      createPendingManageClarifySession(
        chatId,
        prepared.clarify.actor || user,
        session.sourceText,
        prepared.clarify.intent,
        prepared.clarify.missingFields,
      );
      await editMessage(chatId, messageId, prepared.clarify.text, prepared.clarify.keyboard || manageClarifyCancelKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }

    clearPendingManageClarifySession(chatId, user.id);
    if (!prepared.prepared) {
      await editMessage(chatId, messageId, prepared.error || "未识别到可执行的管理操作。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    const actionPending = createPendingManageAction(prepared.prepared.pending);
    await editMessage(
      chatId,
      messageId,
      manageActionConfirmText(actionPending, prepared.prepared.actor, prepared.prepared.target),
      manageActionConfirmKeyboard(actionPending.key),
    );
    await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
    return;
  }

  if (data.startsWith("fx:op:confirm:")) {
    const actionKey = data.slice("fx:op:confirm:".length).trim().toLowerCase();
    const pending = getPendingManageAction(actionKey);
    if (!pending) {
      await editMessage(chatId, messageId, "操作已超时或已被处理，请重新发送指令。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    if (Number(pending.actorUserId) !== Number(user.id)) {
      await editMessage(chatId, messageId, "只有原发起人才可以确认执行该操作。", manageActionConfirmKeyboard(pending.key));
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    const consumed = consumePendingManageAction(actionKey);
    if (!consumed) {
      await editMessage(chatId, messageId, "操作已超时或已被处理，请重新发送指令。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    const result = await executePendingManageAction(consumed, user);
    await editMessage(chatId, messageId, result, backMenuKeyboard());
    await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
    return;
  }
  if (data.startsWith("fx:op:cancel:")) {
    const actionKey = data.slice("fx:op:cancel:".length).trim().toLowerCase();
    const pending = getPendingManageAction(actionKey);
    if (!pending) {
      await editMessage(chatId, messageId, "操作已超时或已被处理，请重新发送指令。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    if (Number(pending.actorUserId) !== Number(user.id)) {
      await editMessage(chatId, messageId, "只有原发起人才可以取消该操作。", manageActionConfirmKeyboard(pending.key));
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    consumePendingManageAction(actionKey);
    await editMessage(chatId, messageId, "已取消本次操作。", backMenuKeyboard());
    await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
    return;
  }
  switch (data) {
    case "fx:menu":
      clearPendingManageClarifySession(chatId, user.id);
      await editMainMenu(chatId, messageId, user);
      return;
    case "fx:user":
      await editMessage(chatId, messageId, userInfoText(user), backMenuKeyboard());
      return;
    case "fx:usage":
      await editMessage(chatId, messageId, await usageText(user), backMenuKeyboard());
      return;
    case "fx:notify":
      {
        const view = await notifyView(user);
        await editMessage(chatId, messageId, view.text, view.keyboard);
      }
      return;
    case "fx:digest":
      await editMessage(chatId, messageId, await buildTelegramDigestText(user), {
        inline_keyboard: [
          [{ text: "🔔 通知设置", callback_data: "fx:notify" }],
          [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
        ],
      });
      return;
    case "fx:rules":
      {
        const view = await rulesView(user, 0);
        await editMessage(chatId, messageId, view.text, view.keyboard);
      }
      return;
    case "fx:redeem":
      if (user.role === "admin") {
        await editMessage(chatId, messageId, "管理员账户无需兑换码。", backMenuKeyboard());
        return;
      }
      await editRedeemCodePrompt(chatId, messageId, identity.telegramId);
      return;
    case "fx:users":
      if (user.role !== "admin") {
        await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
        return;
      }
      {
        const view = await usersView(0);
        await editMessage(chatId, messageId, view.text, view.keyboard);
      }
      return;
    case "fx:unbind":
      await editMessage(chatId, messageId, "确认解除当前 Telegram 绑定吗？解除后需要重新绑定才能使用机器人。", unbindConfirmKeyboard());
      return;
    case "fx:unbind:confirm":
      await db.unbindTelegramAccount(user.id);
      await editMessage(chatId, messageId, "已解除当前 Telegram 绑定。", bindPromptKeyboard());
      return;
    default:
      await editMainMenu(chatId, messageId, user);
  }
}

function telegramUpdateQueueKey(update: TelegramUpdate) {
  const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
  return chatId ? `telegram-chat:${chatId}` : `telegram-update:${update.update_id}`;
}

/** @public 测试经 import(url(...)) 动态引用，knip 看不见 */
export async function processTelegramUpdate(update: TelegramUpdate) {
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (error) {
    console.error("[Telegram] Failed to handle message:", error);
    const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
    if (chatId) await sendMessage(chatId, `操作失败：${escapeHtml(error instanceof Error ? error.message : String(error))}`).catch(() => undefined);
  }
}

async function pollOnce() {
  // 多实例部署：只由跑后台任务的实例轮询（server/panelLease.ts）—— 同一个 Token 两边一起 getUpdates，Telegram 回 409。
  if (!isPanelBackgroundLeaseHolder()) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return;
  }
  const settings = await getTelegramSettings();
  if (!settings.enabled || !settings.token) {
    await new Promise((resolve) => setTimeout(resolve, 30000));
    return;
  }
  const tokenKey = getTokenKey(settings.token);
  if (tokenKey !== activeTokenKey) {
    updateOffset = 0;
    activeTokenKey = tokenKey;
  }
  const updates = await telegramApi<TelegramUpdate[]>("getUpdates", {
    offset: updateOffset || undefined,
    timeout: 25,
    allowed_updates: ["message", "callback_query"],
  });
  for (const update of updates) {
    updateOffset = Math.max(updateOffset, update.update_id + 1);
    void telegramUpdateDispatcher
      .enqueue(telegramUpdateQueueKey(update), () => processTelegramUpdate(update))
      .catch((error) => console.error("[Telegram] Update dispatcher failed:", error));
  }
}

export async function refreshTelegramBotProfile() {
  const settings = await getTelegramSettings();
  if (!settings.token) return null;
  const me = await telegramApi<{ username?: string; first_name?: string; id?: number }>("getMe");
  if (me.username) await db.setSetting("telegramBotUsername", me.username);
  await syncTelegramBotCommands().catch((error) => {
    console.warn(`[Telegram] setMyCommands failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return me;
}

export async function startTelegramBot() {
  // 先占位再 await：启动时和保存设置时几乎同时调进来，原来两边都能在 await 期间
  // 通过这道检查，于是跑起两个轮询循环，互相抢 getUpdates（Telegram 回 409），
  // 同一条消息还可能被处理两次。
  if (pollingStarted) return;
  pollingStarted = true;
  let settings: Awaited<ReturnType<typeof getTelegramSettings>>;
  try {
    settings = await getTelegramSettings();
  } catch (error) {
    pollingStarted = false;
    throw error;
  }
  if (!settings.enabled || !settings.token) {
    pollingStarted = false;
    console.info("[Telegram] Bot is disabled or token is not configured");
    return;
  }
  if (!ENV.telegramBotPolling) {
    pollingStarted = false;
    console.info("[Telegram] Bot polling is disabled");
    return;
  }
  pollingAbort = false;
  console.info("[Telegram] Starting bot polling");
  refreshTelegramBotProfile().catch((error) => console.warn(`[Telegram] getMe failed: ${error instanceof Error ? error.message : String(error)}`));

  void (async () => {
    let consecutiveFailures = 0;
    while (!pollingAbort) {
      try {
        await pollOnce();
        consecutiveFailures = 0;
      } catch (error) {
        if (isTelegramUnauthorizedError(error)) {
          // Token 失效再怎么重试也是 401：停下来，等管理员在设置里改了 Token 或重新
          // 启用机器人（systemRouter 保存设置后会再调 startTelegramBot）。
          console.warn("[Telegram] Bot token rejected (401 Unauthorized); polling paused until Telegram settings are saved again");
          pollingStarted = false;
          return;
        }
        consecutiveFailures += 1;
        const delayMs = telegramPollingRetryDelayMs(consecutiveFailures, error);
        console.warn(`[Telegram] Polling failed (retry in ${Math.round(delayMs / 1000)}s): ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  })();
}

export function resetTelegramBotPolling() {
  updateOffset = 0;
  activeTokenKey = "";
}
