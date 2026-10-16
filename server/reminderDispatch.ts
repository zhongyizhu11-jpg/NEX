/**
 * 提醒的「先算清单、再一起发」。
 *
 * 面板里有六路提醒（用户到期、用户流量、主机流量、主机续费、落地节点、落地端口），
 * 两个渠道（邮件、Telegram）各走一遍。原来每一路都是边算边发，每要发一条就先
 * `getSetting(当天的日标记)` 问一次「今天发过没有」—— 单行主键查，但是一个对象一次。
 *
 * 一千个用户加一千台机器加一千个节点，一轮扫下来就是上万次往返，而这一轮每六小时
 * 跑一次、天天跑。这些键全是同一天的同一类标记，一次 IN 就能问完。
 *
 * 所以把每一路拆成两段：先纯计算出「今天该发哪些、各自的去重键是什么」，再把整批
 * 键一次问清，最后只发没发过的。消息正文留在各自的 send 闭包里 —— 邮件和 Telegram
 * 的正文本来就不一样，硬凑成一个模板只会让两边互相迁就。
 *
 * 发送失败分三种（见 classifyReminderFailure）：
 *
 * - 通道故障（SMTP 超时/登录失败/连不上、Telegram Token 失效/限流/5xx，以及认不出来的错误）：
 *   仍然向上抛、整轮停下 —— SMTP 挂了就别对着一千个地址挨个超时重试一遍。
 * - 收件人永久不可达（Telegram 403 拉黑/没和机器人说过话、chat not found；SMTP 在
 *   RCPT 阶段 5xx 拒收）：记日志、照样写标记、接着发下一条。原来这种错误也会抛出去，
 *   而且标记没写 —— 清单顺序每轮都一样，于是**这一个人后面的所有提醒永远发不出去**。
 * - 单条消息本身的问题（Telegram 其它 400）：记日志、不写标记（下轮再试）、接着发。
 *
 * Discord 私信同样三分：403（对方关了私信）算收件人问题，其它 400 算单条问题，401 / 429 / 5xx 算通道故障。
 */

import * as db from "./db";
import { isPermanentTelegramRecipientError, TelegramApiError } from "./telegramApiError";
import { DiscordApiError, isDiscordRecipientError } from "./discordBot";

export type ReminderFailureKind = "recipient" | "item" | "transport";

/**
 * 一次发送失败，是这个收件人的问题、这一条的问题，还是整个通道的问题。
 *
 * SMTP 只认 RCPT 阶段的拒收：MAIL FROM 被拒同样报 EENVELOPE，但那是发件人配置错了，
 * 对谁发都一样，按「这个人收不到」处理会把所有人的提醒一起吞掉。
 * 认不出来的错误一律按通道故障算 —— 宁可这一轮停下，也不能把提醒标成「已发」。
 */
export function classifyReminderFailure(error: unknown): ReminderFailureKind {
  if (isPermanentTelegramRecipientError(error)) return "recipient";
  // Discord 私信：对方关了私信 / 没有共同服务器（403），或者已经在冷却期里被跳过。
  if (isDiscordRecipientError(error) || (error instanceof Error && error.name === "DiscordRecipientUnavailableError")) return "recipient";
  if (error instanceof DiscordApiError) {
    return error.status === 400 ? "item" : "transport";
  }
  if (error instanceof TelegramApiError) {
    return error.errorCode === 400 ? "item" : "transport";
  }
  const smtp = (error && typeof error === "object" ? error : {}) as { code?: unknown; responseCode?: unknown; command?: unknown };
  const code = String(smtp.code || "").toUpperCase();
  const responseCode = Number(smtp.responseCode || 0);
  const command = String(smtp.command || "").trim().toUpperCase();
  if (command.startsWith("RCPT") && (code === "EENVELOPE" || responseCode >= 550)) return "recipient";
  // nodemailer 解析不出收件地址时报「No recipients defined」（command=API）：地址本身是坏的。
  if (code === "EENVELOPE" && command === "API") return "recipient";
  return "transport";
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type PendingReminder = {
  /**
   * 去重键，`<渠道>:<类别>:<...>`：按天去重的带 `:<YYYY-MM-DD>` 结尾，
   * 到期类（按「这一次到期 + 这一档」去重）不带日期。
   */
  key: string;
  send: () => Promise<void>;
};

/**
 * 发掉清单里今天还没发过的那些，返回真发出去的条数。
 *
 * 同一轮里两条算出同一个键是可能的（比如同一个人的同一类提醒被算了两遍），
 * 发过的键就地记下，免得一轮里重复发。
 */
export async function dispatchReminders(pending: PendingReminder[]): Promise<number> {
  if (pending.length === 0) return 0;
  const sent = await db.getSentSettingKeys(pending.map((item) => item.key));
  let delivered = 0;
  for (const item of pending) {
    if (sent.has(item.key)) continue;
    try {
      await item.send();
    } catch (error) {
      const kind = classifyReminderFailure(error);
      if (kind === "transport") throw error;
      if (kind === "recipient") {
        // 照样写标记：这个人今天/这一档收不到了，别每轮都拿他去撞一次。
        console.warn(`[Reminder] recipient unreachable, skipped key=${item.key}: ${errorText(error)}`);
        await db.setSetting(item.key, "undeliverable");
        sent.add(item.key);
      } else {
        console.warn(`[Reminder] send failed, will retry next round key=${item.key}: ${errorText(error)}`);
      }
      continue;
    }
    await db.setSetting(item.key, "sent");
    sent.add(item.key);
    delivered += 1;
  }
  return delivered;
}
