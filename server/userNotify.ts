/*
  发给某个用户本人的通知：邮件 + Telegram，哪个绑了发哪个。

  订阅拉取事件（proxySubNotify）和新设备登录（ops/loginDevices）都用这一份 ——
  原来 proxySubNotify 里自己写了一遍「Telegram 机器人开没开、邮箱像不像邮箱」，
  第二个功能再抄一遍，两处的判断迟早对不上。

  全部尽力而为：发不出去只记日志，不往上抛。
*/
import * as db from "./db";
import { sendMail } from "./email";
import { sendTelegramMessage } from "./telegramBot";
import { ENV } from "./env";

export async function telegramBotReady(): Promise<boolean> {
  const all = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = all.telegramBotEnabled === "true" || (!!envToken && all.telegramBotEnabled !== "false");
  const botConfigured = !!String(all.telegramBotToken || envToken).trim();
  return botEnabled && botConfigured;
}

/** 发通知只用到用户行上的这两列。 */
export type NotifyRecipient = { email?: unknown; telegramId?: unknown } | null | undefined;

/** 发给 user（已读出来的用户行）。tag 只用来区分日志。返回实际发出去的渠道。 */
export async function notifyUserDirect(user: NotifyRecipient, title: string, body: string, tag: string): Promise<Array<"email" | "telegram">> {
  const sent: Array<"email" | "telegram"> = [];
  if (!user) return sent;
  const email = String(user.email || "").trim();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    await sendMail({ to: email, subject: title, text: body })
      .then(() => { sent.push("email"); })
      .catch((error) => {
        console.warn(`[${tag}] 通知邮件发送失败:`, error instanceof Error ? error.message : error);
      });
  }
  if (user.telegramId && await telegramBotReady()) {
    await sendTelegramMessage(user.telegramId as Parameters<typeof sendTelegramMessage>[0], body)
      .then(() => { sent.push("telegram"); })
      .catch((error) => {
        console.warn(`[${tag}] Telegram 通知发送失败:`, error instanceof Error ? error.message : error);
      });
  }
  return sent;
}
