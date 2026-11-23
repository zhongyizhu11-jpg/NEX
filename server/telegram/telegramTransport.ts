/*
  Telegram 机器人：传输层 —— Bot API 调用（发 / 改 / 删消息）和以机器人身份调用面板 tRPC 的上下文。
  2026-11-23 从 telegramBot.ts（6483 行）拆出；外部调用方仍从 telegramBot.ts 导入，那里原样转发。
*/
import * as db from "../db";
import { ENV } from "../env";
import { telegramApiErrorFromResponse, telegramRetryAfterMs } from "./telegramApiError";
import { withTelegramApiTimeout } from "./telegramApiTimeout";

export async function getTelegramSettings() {
  const settings = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const dbToken = String(settings.telegramBotToken || "").trim();
  const token = envToken || dbToken;
  const enabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  return {
    token,
    enabled,
    botUsername: String(settings.telegramBotUsername || "").trim(),
    panelPublicUrl: String(settings.panelPublicUrl || "").trim().replace(/\/+$/, ""),
  };
}

export async function telegramApi<T = any>(method: string, body?: Record<string, unknown>): Promise<T> {
  const settings = await getTelegramSettings();
  if (!settings.token) throw new Error("Telegram Bot Token is not configured");
  return withTelegramApiTimeout(method, async (signal) => {
    const resp = await fetch(`https://api.telegram.org/bot${settings.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal,
    });
    const json = await resp.json().catch(() => null) as any;
    if (!resp.ok || !json?.ok) {
      // 带上 error_code / retry_after：提醒分发要靠它区分「这个人收不到」和「整个通道出问题」。
      throw telegramApiErrorFromResponse(method, resp.status, json);
    }
    return json.result as T;
  });
}

export type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
};

export type InlineKeyboardMarkup = {
  inline_keyboard: Array<Array<InlineKeyboardButton>>;
};

export type TelegramSentMessage = {
  message_id: number;
};

export async function sendMessage(chatId: number | string, text: string, replyMarkup?: InlineKeyboardMarkup) {
  return telegramApi<TelegramSentMessage>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/**
 * 后台通知（提醒、主机上下线、规则异常）用的发送入口。
 *
 * 遇到 429 按 Telegram 给的 retry_after 等一次再发（最多等 30 秒），还不行才抛：
 * 批量通知时一碰到限流就放弃，后面的消息会全部丢掉。交互式回复不走这里，
 * 不让用户点个按钮等半分钟。
 */
export async function sendTelegramMessage(chatId: number | string, text: string) {
  try {
    await sendMessage(chatId, text);
  } catch (error) {
    const waitMs = telegramRetryAfterMs(error);
    if (waitMs === null) throw error;
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    await sendMessage(chatId, text);
  }
}

export async function editMessage(chatId: number | string, messageId: number, text: string, replyMarkup?: InlineKeyboardMarkup) {
  await telegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function deleteMessage(chatId: number | string, messageId: number) {
  await telegramApi("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

export async function sendChatAction(chatId: number | string, action: "typing" = "typing") {
  await telegramApi("sendChatAction", {
    chat_id: chatId,
    action,
  });
}

export function deleteMessageLater(chatId: number | string, messageId: number, delayMs: number) {
  const timer = setTimeout(() => {
    deleteMessage(chatId, messageId).catch(() => undefined);
  }, delayMs);
  (timer as any).unref?.();
}

/** 面板 tRPC 过程要的上下文。机器人没有 HTTP 请求，给一个够用的壳：没有 cookie 可写，审计里记成 telegram。 */
function telegramTrpcContext(user: any) {
  return {
    req: { headers: { "x-request-id": "telegram-bot" }, ip: "telegram", socket: {} } as any,
    res: { cookie() {}, clearCookie() {} } as any,
    user,
    authSession: null,
    authFailureReason: null,
  } as any;
}

export async function telegramRulesCaller(user: any) {
  const { rulesRouter } = await import("../routers/rules");
  return rulesRouter.createCaller(telegramTrpcContext(user)) as any;
}
