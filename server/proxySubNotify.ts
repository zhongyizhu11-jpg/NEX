/**
 * 订阅拉取事件的通知：首次被拉取、新设备、超设备数、被拒。
 *
 * 发给令牌主人（邮件 + Telegram，哪个绑了发哪个）。每种事件每条令牌每天最多一封 ——
 * 一条地址被贴到群里之后，「新设备」会一分钟来几十次，逐条发等于把主人的邮箱刷爆。
 * 去重键走 system_settings 的日标记（前缀 proxySubNotify:，定时清理）。
 *
 * 全部尽力而为：通知发不出去不影响订阅本身，错误只记日志。
 */

import * as db from "./db";
import { sendMail } from "./email";
import { sendTelegramMessage } from "./telegramBot";
import { loadProxySubSettings } from "./proxySubSettings";
import { ENV } from "./env";

export type ProxySubNotifyKind = "first-access" | "new-device" | "device-limit" | "failure";

export type ProxySubNotifyEvent = {
  kind: ProxySubNotifyKind;
  tokenId: number;
  tokenName: string;
  userId: number;
  /** 一句人话：客户端、IP、原因。 */
  detail: string;
};

const TITLES: Record<ProxySubNotifyKind, string> = {
  "first-access": "订阅地址第一次被拉取",
  "new-device": "订阅地址出现新设备",
  "device-limit": "订阅地址设备数已满",
  failure: "订阅拉取被拒",
};

function dayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function enabledFor(kind: ProxySubNotifyKind, settings: Awaited<ReturnType<typeof loadProxySubSettings>>): boolean {
  if (kind === "first-access") return settings.notifyFirstAccess;
  if (kind === "new-device") return settings.notifyNewDevice;
  if (kind === "device-limit") return settings.notifyDeviceLimit;
  return settings.notifyFailures;
}

async function telegramReady(): Promise<boolean> {
  const all = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = all.telegramBotEnabled === "true" || (!!envToken && all.telegramBotEnabled !== "false");
  const botConfigured = !!String(all.telegramBotToken || envToken).trim();
  return botEnabled && botConfigured;
}

export async function notifyProxySubEvent(event: ProxySubNotifyEvent): Promise<void> {
  try {
    const settings = await loadProxySubSettings();
    if (!enabledFor(event.kind, settings)) return;
    const key = `proxySubNotify:${event.kind}:${event.tokenId}:${dayKey()}`;
    if (await db.getSetting(key)) return;
    await db.setSetting(key, "1");

    const user = await db.getUserById(event.userId) as any;
    if (!user) return;
    const title = `${TITLES[event.kind]}：${event.tokenName}`;
    const body = `${title}\n${event.detail}\n\n登录面板的「订阅管理」可以查看拉取记录、设备列表，必要时重置这条地址。`;

    const email = String(user.email || "").trim();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await sendMail({ to: email, subject: title, text: body }).catch((error) => {
        console.warn("[proxy-subscription] 通知邮件发送失败:", error instanceof Error ? error.message : error);
      });
    }
    if (user.telegramId && await telegramReady()) {
      await sendTelegramMessage(user.telegramId, body).catch((error) => {
        console.warn("[proxy-subscription] Telegram 通知发送失败:", error instanceof Error ? error.message : error);
      });
    }
  } catch (error) {
    console.warn("[proxy-subscription] 通知处理失败:", error instanceof Error ? error.message : error);
  }
}
