/*
  工单通知。

  - 用户新建工单 / 用户回复：Telegram 发给管理员（各自可以在机器人「通知设置」里关掉「工单消息」），
    同时记一条面板事件（ticket.created / ticket.replied），Webhook 在「工单」分类下转发。
  - 管理员回复：Telegram 发给工单主人（绑了 Telegram、没关「工单消息」），
    邮件也发一份（面板开了邮件通知、他的邮箱验证过）。

  通知永远不能让请求失败：路由里用 dispatchTicketNotification 丢到后台跑，出错只记面板日志。
*/
import { appendPanelLog } from "./_core/panelLogger";
import * as db from "./db";
import { sendMail } from "./email";
import { recordPanelEvent } from "./ops/panelEvents";
import { buildPanelUrl } from "./paymentUrls";
import { sendTelegramMessage } from "./telegramBot";
import { filterTelegramRecipients } from "./telegramNotifyPrefs";
import { notifyDiscordAdmins, notifyDiscordUser } from "./discordNotify";
import { isTelegramBotReady } from "./telegramReady";
import { DELETED_USER_LABEL, TICKET_PRIORITY_LABELS, type TicketPriority } from "../shared/tickets";

type NotifyTicket = { id: number; userId: number; title: string; priority: TicketPriority };
type NotifyActor = { id: number; username?: string | null; name?: string | null };

const TELEGRAM_EXCERPT_LENGTH = 800;
const EVENT_EXCERPT_LENGTH = 200;

const pending = new Set<Promise<void>>();

/** 后台跑一个通知任务：不等它、不让它抛出来。 */
export function dispatchTicketNotification(label: string, task: () => Promise<void>) {
  const run = (async () => {
    try {
      await task();
    } catch (error) {
      appendPanelLog("warn", `[Ticket] ${label} notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  pending.add(run);
  void run.finally(() => pending.delete(run));
}

/** 测试用：等后台的通知都跑完。 */
export async function flushTicketNotifications() {
  while (pending.size > 0) await Promise.all([...pending]);
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function excerpt(content: string, length: number) {
  const text = String(content || "").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function actorName(actor: NotifyActor | null | undefined) {
  return String(actor?.username || actor?.name || "").trim() || DELETED_USER_LABEL;
}

async function ticketPanelUrl(path: string) {
  try {
    const settings = await db.getAllSettings();
    const base = String(settings.panelPublicUrl || "").trim();
    return base ? buildPanelUrl(base, path) : "";
  } catch {
    return "";
  }
}

/** 工单通知管理员：Telegram 和 Discord 两路（Discord 没开时什么也不做）。 */
async function sendTelegramToAdmins(text: string, excludeUserId: number, ticketId: number) {
  await sendTelegramOnlyToAdmins(text, excludeUserId, ticketId);
  await notifyDiscordAdmins(text, { category: "ticket", excludeUserId, label: `ticket=${ticketId}` });
}

async function sendTelegramOnlyToAdmins(text: string, excludeUserId: number, ticketId: number) {
  if (!(await isTelegramBotReady())) return;
  const admins = (await db.getTelegramAdminRecipients() as any[]).filter((admin) => Number(admin.id) !== excludeUserId);
  const recipients = await filterTelegramRecipients(admins, "ticket");
  let sent = 0;
  let failed = 0;
  for (const admin of recipients) {
    if (!admin.telegramId) continue;
    try {
      await sendTelegramMessage(admin.telegramId, text);
      sent += 1;
    } catch (error) {
      failed += 1;
      appendPanelLog("warn", `[Ticket] telegram notify failed admin=${admin.id} ticket=${ticketId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sent > 0 || failed > 0) appendPanelLog("info", `[Ticket] telegram notify ticket=${ticketId} sent=${sent} failed=${failed}`);
}

function adminTelegramText(kind: "created" | "replied", ticket: NotifyTicket, actor: NotifyActor, content: string, url: string) {
  return [
    kind === "created" ? "<b>📮 NEX 新工单</b>" : "<b>💬 NEX 工单有新回复</b>",
    "",
    `<b>工单</b>：#${ticket.id} ${escapeHtml(ticket.title)}`,
    `<b>用户</b>：${escapeHtml(actorName(actor))}`,
    `<b>优先级</b>：${escapeHtml(TICKET_PRIORITY_LABELS[ticket.priority] || ticket.priority)}`,
    "",
    escapeHtml(excerpt(content, TELEGRAM_EXCERPT_LENGTH)),
    "",
    url ? `<a href="${escapeHtml(url)}">在面板中查看</a>` : "请登录面板在「工单管理」里查看。",
  ].join("\n");
}

/** 用户新建了工单。 */
export async function notifyTicketCreated(ticket: NotifyTicket, actor: NotifyActor, content: string) {
  await recordPanelEvent({
    kind: "ticket.created",
    level: "info",
    userId: ticket.userId,
    message: `${actorName(actor)} 新建工单 #${ticket.id}「${ticket.title}」（优先级${TICKET_PRIORITY_LABELS[ticket.priority]}）`,
    data: { ticketId: ticket.id, title: ticket.title, priority: ticket.priority, excerpt: excerpt(content, EVENT_EXCERPT_LENGTH) },
  });
  const url = await ticketPanelUrl(`/admin/tickets?id=${ticket.id}`);
  await sendTelegramToAdmins(adminTelegramText("created", ticket, actor, content, url), actor.id, ticket.id);
}

/** 用户回复了工单。 */
export async function notifyTicketUserReply(ticket: NotifyTicket, actor: NotifyActor, content: string) {
  await recordPanelEvent({
    kind: "ticket.replied",
    level: "info",
    userId: ticket.userId,
    message: `${actorName(actor)} 回复了工单 #${ticket.id}「${ticket.title}」`,
    data: { ticketId: ticket.id, title: ticket.title, priority: ticket.priority, excerpt: excerpt(content, EVENT_EXCERPT_LENGTH) },
  });
  const url = await ticketPanelUrl(`/admin/tickets?id=${ticket.id}`);
  await sendTelegramToAdmins(adminTelegramText("replied", ticket, actor, content, url), actor.id, ticket.id);
}

/** 工单主人要不要收邮件：面板开了邮件、他有邮箱且验证过。 */
export function shouldEmailTicketOwner(owner: { email?: string | null; emailVerified?: unknown } | null | undefined, emailEnabled: boolean) {
  if (!emailEnabled || !owner) return false;
  const verified = owner.emailVerified === true || Number(owner.emailVerified) === 1;
  return verified && !!String(owner.email || "").trim();
}

/** 管理员回复了工单：通知工单主人。 */
export async function notifyTicketStaffReply(ticket: NotifyTicket, staff: NotifyActor, content: string) {
  if (ticket.userId === staff.id) return;
  const owner: any = await db.getUserById(ticket.userId);
  // 用户已被删除或停用：没人可通知。
  if (!owner || owner.accountEnabled === false || Number(owner.accountEnabled) === 0) return;
  const url = await ticketPanelUrl(`/tickets?id=${ticket.id}`);

  const ownerText = [
    "<b>💬 你的工单有新回复</b>",
    "",
    `<b>工单</b>：#${ticket.id} ${escapeHtml(ticket.title)}`,
    "",
    escapeHtml(excerpt(content, TELEGRAM_EXCERPT_LENGTH)),
    "",
    url ? `<a href="${escapeHtml(url)}">在面板中查看</a>` : "请登录面板在「工单」里查看。",
  ].join("\n");

  if (owner.telegramId && (await isTelegramBotReady())) {
    const [recipient] = await filterTelegramRecipients([owner], "ticket");
    if (recipient) {
      const text = ownerText;
      try {
        await sendTelegramMessage(owner.telegramId, text);
      } catch (error) {
        appendPanelLog("warn", `[Ticket] telegram notify failed user=${owner.id} ticket=${ticket.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Discord 私信（绑定了、没关掉「工单消息」才发）
  await notifyDiscordUser(owner, ownerText, { category: "ticket", label: `ticket=${ticket.id}` });

  const settings = await db.getAllSettings().catch(() => ({} as Record<string, string | null>));
  if (shouldEmailTicketOwner(owner, settings.emailEnabled === "true")) {
    try {
      await sendMail({
        to: String(owner.email).trim(),
        subject: `NEX 工单 #${ticket.id} 有新回复`,
        text: [
          `你的工单 #${ticket.id}「${ticket.title}」有新的回复：`,
          "",
          excerpt(content, 5000),
          "",
          url ? `查看和回复：${url}` : "请登录面板在「工单」里查看和回复。",
        ].join("\n"),
      });
    } catch (error) {
      appendPanelLog("warn", `[Ticket] email notify failed user=${owner.id} ticket=${ticket.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
