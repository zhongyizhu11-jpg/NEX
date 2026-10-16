/*
  工单路由。

  用户这边（protectedProcedure）只能碰自己的工单：别人的工单一律回 NOT_FOUND（不回 FORBIDDEN，
  免得能拿编号去探哪些工单存在）。管理员这边（admin*）能看、回、开关所有工单。
  用户在 /tickets 提单；管理员在 /admin/tickets 处理，同一个页面组件。
*/
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { consumeTicketCreateQuota, consumeTicketReplyQuota } from "../ticketRateLimit";
import {
  dispatchTicketNotification,
  notifyTicketCreated,
  notifyTicketStaffReply,
  notifyTicketUserReply,
} from "../ticketNotifier";
import {
  DELETED_USER_LABEL,
  normalizeTicketContent,
  normalizeTicketTitle,
  TICKET_CONTENT_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUS_FILTERS,
  TICKET_TITLE_MAX_LENGTH,
} from "../../shared/tickets";
import type { TicketMessageRow, TicketRow } from "../repositories/ticketRepository";

const ticketIdSchema = z.number().int().positive();
// 长度在这里只做个宽松的上限挡住超大请求，准确的校验（去首尾空白、单行、NUL）在 normalize* 里，报中文。
const titleSchema = z.string().max(TICKET_TITLE_MAX_LENGTH * 4);
const contentSchema = z.string().max(TICKET_CONTENT_MAX_LENGTH * 4);
const pageSchema = z.number().int().min(1).max(100_000).default(1);

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function notFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "工单不存在" });
}

function cleanTitle(raw: string) {
  const result = normalizeTicketTitle(raw);
  if (!result.ok) badRequest(result.error);
  return result.value;
}

function cleanContent(raw: string) {
  const result = normalizeTicketContent(raw);
  if (!result.ok) badRequest(result.error);
  return result.value;
}

function rethrowTicketError(error: unknown): never {
  if (error instanceof db.TicketNotFoundError) notFound();
  if (error instanceof db.TicketClosedError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
  throw error;
}

function isAdmin(user: { role?: string | null }) {
  return user.role === "admin";
}

/** 用户看到的工单：不带用户名（就是他自己）。 */
function userTicketView(ticket: TicketRow) {
  return {
    id: ticket.id,
    title: ticket.title,
    priority: ticket.priority,
    status: ticket.status,
    lastMessageAt: ticket.lastMessageAt,
    lastMessageByStaff: ticket.lastMessageByStaff,
    closedAt: ticket.closedAt,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

function adminTicketView(ticket: TicketRow) {
  const userDeleted = !ticket.username;
  return {
    ...userTicketView(ticket),
    userId: ticket.userId,
    username: ticket.username || DELETED_USER_LABEL,
    userDisplayName: ticket.userDisplayName || null,
    userDeleted,
  };
}

/** 用户看到的消息：管理员一律显示「客服」，不暴露是哪个管理员。 */
function userMessageView(message: TicketMessageRow) {
  return {
    id: message.id,
    isStaff: message.isStaff,
    mine: !message.isStaff,
    senderName: message.isStaff ? "客服" : "我",
    content: message.content,
    createdAt: message.createdAt,
  };
}

function adminMessageView(message: TicketMessageRow, viewerId: number) {
  return {
    id: message.id,
    isStaff: message.isStaff,
    mine: message.senderId === viewerId,
    senderId: message.senderId,
    senderName: message.senderUsername || (message.senderDisplayName ? message.senderDisplayName : DELETED_USER_LABEL),
    content: message.content,
    createdAt: message.createdAt,
  };
}

/** 用户自己的工单；不是他的当作不存在。 */
async function requireOwnTicket(ticketId: number, userId: number) {
  const ticket = await db.getTicketById(ticketId);
  if (!ticket || ticket.userId !== userId) notFound();
  return ticket;
}

async function requireTicket(ticketId: number) {
  const ticket = await db.getTicketById(ticketId);
  if (!ticket) notFound();
  return ticket;
}

const messagesInput = z.object({
  ticketId: ticketIdSchema,
  beforeId: z.number().int().positive().optional(),
});

export const ticketsRouter = router({
  list: protectedProcedure
    .input(z.object({
      status: z.enum(TICKET_STATUS_FILTERS).optional(),
      page: pageSchema,
    }).optional())
    .query(async ({ input, ctx }) => {
      const result = await db.listTicketsForUser(ctx.user.id, { status: input?.status, page: input?.page });
      return { ...result, items: result.items.map(userTicketView) };
    }),

  get: protectedProcedure
    .input(messagesInput)
    .query(async ({ input, ctx }) => {
      const ticket = await requireOwnTicket(input.ticketId, ctx.user.id);
      const { messages, hasMore } = await db.listTicketMessages(ticket.id, { beforeId: input.beforeId });
      return { ticket: userTicketView(ticket), messages: messages.map(userMessageView), hasMore };
    }),

  create: protectedProcedure
    .input(z.object({
      title: titleSchema,
      priority: z.enum(TICKET_PRIORITIES).default("medium"),
      content: contentSchema,
    }))
    .mutation(async ({ input, ctx }) => {
      const title = cleanTitle(input.title);
      const content = cleanContent(input.content);
      const limited = consumeTicketCreateQuota(ctx.user.id, isAdmin(ctx.user));
      if (limited) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: limited });
      const ticket = await db.createTicket({ userId: ctx.user.id, title, priority: input.priority, content });
      appendPanelLog("info", `[Ticket] created id=${ticket.id} user=${ctx.user.id} priority=${ticket.priority}`);
      dispatchTicketNotification("create", () => notifyTicketCreated(ticket, ctx.user, content));
      return userTicketView(ticket);
    }),

  reply: protectedProcedure
    .input(z.object({ ticketId: ticketIdSchema, content: contentSchema }))
    .mutation(async ({ input, ctx }) => {
      const content = cleanContent(input.content);
      const existing = await requireOwnTicket(input.ticketId, ctx.user.id);
      if (existing.status === "closed") rethrowTicketError(new db.TicketClosedError());
      const limited = consumeTicketReplyQuota(ctx.user.id, isAdmin(ctx.user));
      if (limited) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: limited });
      const { ticket } = await db.addTicketMessage({ ticketId: existing.id, senderId: ctx.user.id, isStaff: false, content })
        .catch(rethrowTicketError);
      dispatchTicketNotification("reply", () => notifyTicketUserReply(ticket, ctx.user, content));
      return userTicketView(ticket);
    }),

  setStatus: protectedProcedure
    .input(z.object({ ticketId: ticketIdSchema, status: z.enum(["open", "closed"]) }))
    .mutation(async ({ input, ctx }) => {
      const existing = await requireOwnTicket(input.ticketId, ctx.user.id);
      const { ticket, changed } = await db.setTicketOpenState(existing.id, input.status === "open").catch(rethrowTicketError);
      if (changed) appendPanelLog("info", `[Ticket] ${input.status === "open" ? "reopened" : "closed"} id=${ticket.id} by user=${ctx.user.id}`);
      return userTicketView(ticket);
    }),

  adminList: adminProcedure
    .input(z.object({
      status: z.enum(TICKET_STATUS_FILTERS).optional(),
      priority: z.enum(TICKET_PRIORITIES).optional(),
      keyword: z.string().trim().max(128).optional(),
      page: pageSchema,
    }).optional())
    .query(async ({ input }) => {
      const result = await db.listTicketsForAdmin({
        status: input?.status,
        priority: input?.priority,
        keyword: input?.keyword,
        page: input?.page,
      });
      return { ...result, items: result.items.map(adminTicketView) };
    }),

  adminGet: adminProcedure
    .input(messagesInput)
    .query(async ({ input, ctx }) => {
      const ticket = await requireTicket(input.ticketId);
      const { messages, hasMore } = await db.listTicketMessages(ticket.id, { beforeId: input.beforeId });
      return {
        ticket: adminTicketView(ticket),
        messages: messages.map((message) => adminMessageView(message, ctx.user.id)),
        hasMore,
      };
    }),

  adminReply: adminProcedure
    .input(z.object({ ticketId: ticketIdSchema, content: contentSchema }))
    .mutation(async ({ input, ctx }) => {
      const content = cleanContent(input.content);
      const { ticket } = await db.addTicketMessage({ ticketId: input.ticketId, senderId: ctx.user.id, isStaff: true, content })
        .catch(rethrowTicketError);
      dispatchTicketNotification("staff-reply", () => notifyTicketStaffReply(ticket, ctx.user, content));
      return adminTicketView(ticket);
    }),

  adminSetStatus: adminProcedure
    .input(z.object({ ticketId: ticketIdSchema, status: z.enum(["open", "closed"]) }))
    .mutation(async ({ input, ctx }) => {
      const { ticket, changed } = await db.setTicketOpenState(input.ticketId, input.status === "open").catch(rethrowTicketError);
      if (changed) appendPanelLog("info", `[Ticket] ${input.status === "open" ? "reopened" : "closed"} id=${ticket.id} by admin=${ctx.user.id}`);
      return adminTicketView(ticket);
    }),

  /** 侧栏角标：只数一下等管理员回复的工单。 */
  adminCounts: adminProcedure.query(async () => ({
    waitingStaff: await db.countTicketsWaitingStaff(),
  })),
});
