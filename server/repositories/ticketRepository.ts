/*
  工单的数据层。权限（谁能看哪张工单）在路由里判断，这里只管读写。

  状态流转：
  - 新建 → waiting_staff
  - 用户回复 → waiting_staff；管理员回复 → waiting_user
  - 关闭 → closed；重新打开 → waiting_staff
  - 已关闭的工单不能回复（TicketClosedError），要先重新打开

  回复用一条带条件的 UPDATE（status <> 'closed'）先占住工单再写消息，和「关闭」并发时
  不会出现一条回复挂在已关闭工单上的情况。
*/
import { and, desc, eq, lt, ne, sql, type SQL } from "drizzle-orm";
import { ticketMessages, tickets, users } from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, quoteDbIdentifier, rawAffectedRows, withDatabaseTransaction } from "../dbRuntime";
import { sqlCountAll } from "../dbCompat";
import {
  normalizeTicketPriority,
  normalizeTicketStatus,
  TICKET_LIST_PAGE_SIZE,
  TICKET_MESSAGE_PAGE_SIZE,
  type TicketPriority,
  type TicketStatus,
  type TicketStatusFilter,
} from "../../shared/tickets";

export class TicketNotFoundError extends Error {
  constructor() {
    super("工单不存在");
    this.name = "TicketNotFoundError";
  }
}

export class TicketClosedError extends Error {
  constructor() {
    super("工单已关闭，请先重新打开再回复");
    this.name = "TicketClosedError";
  }
}

export type TicketRow = {
  id: number;
  userId: number;
  username: string | null;
  userDisplayName: string | null;
  title: string;
  priority: TicketPriority;
  status: TicketStatus;
  lastMessageAt: Date | null;
  lastMessageByStaff: boolean;
  closedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type TicketMessageRow = {
  id: number;
  ticketId: number;
  senderId: number | null;
  senderUsername: string | null;
  senderDisplayName: string | null;
  isStaff: boolean;
  content: string;
  createdAt: Date | null;
};

const ticketColumns = {
  id: tickets.id,
  userId: tickets.userId,
  username: users.username,
  userDisplayName: users.name,
  title: tickets.title,
  priority: tickets.priority,
  status: tickets.status,
  lastMessageAt: tickets.lastMessageAt,
  lastMessageByStaff: tickets.lastMessageByStaff,
  closedAt: tickets.closedAt,
  createdAt: tickets.createdAt,
  updatedAt: tickets.updatedAt,
};

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapTicketRow(row: any): TicketRow {
  return {
    id: Number(row.id),
    userId: Number(row.userId),
    username: row.username ?? null,
    userDisplayName: row.userDisplayName ?? null,
    title: String(row.title || ""),
    priority: normalizeTicketPriority(row.priority),
    status: normalizeTicketStatus(row.status),
    lastMessageAt: toDate(row.lastMessageAt),
    lastMessageByStaff: row.lastMessageByStaff === true || Number(row.lastMessageByStaff) === 1,
    closedAt: toDate(row.closedAt),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

function mapMessageRow(row: any): TicketMessageRow {
  return {
    id: Number(row.id),
    ticketId: Number(row.ticketId),
    senderId: row.senderId === null || row.senderId === undefined ? null : Number(row.senderId),
    senderUsername: row.senderUsername ?? null,
    senderDisplayName: row.senderDisplayName ?? null,
    isStaff: row.isStaff === true || Number(row.isStaff) === 1,
    content: String(row.content || ""),
    createdAt: toDate(row.createdAt),
  };
}

function normalizePage(page: unknown) {
  return Math.max(1, Math.floor(Number(page) || 1));
}

function statusCondition(status: TicketStatusFilter | undefined): SQL | undefined {
  if (!status) return undefined;
  if (status === "open") return ne(tickets.status, "closed");
  return eq(tickets.status, status);
}

/** LIKE 的通配符转义，三种库都认显式的 ESCAPE '!'。 */
function likePattern(keyword: string) {
  return `%${keyword.toLowerCase().replace(/[!%_]/g, (char) => `!${char}`)}%`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** 新建工单：工单和第一条消息一起写，返回新工单。 */
export async function createTicket(input: {
  userId: number;
  title: string;
  priority: TicketPriority;
  content: string;
}): Promise<TicketRow> {
  const id = await withDatabaseTransaction(async () => {
    const now = nowSeconds();
    const ticketId = await insertAndGetId("tickets", {
      userId: input.userId,
      title: input.title,
      priority: input.priority,
      status: "waiting_staff",
      lastMessageAt: now,
      lastMessageByStaff: false,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    if (!ticketId) throw new Error("创建工单失败");
    await insertAndGetId("ticket_messages", {
      ticketId,
      senderId: input.userId,
      isStaff: false,
      content: input.content,
      createdAt: now,
    });
    return ticketId;
  });
  const ticket = await getTicketById(id);
  if (!ticket) throw new Error("创建工单失败");
  return ticket;
}

export async function getTicketById(id: number): Promise<TicketRow | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select(ticketColumns)
    .from(tickets)
    .leftJoin(users, eq(tickets.userId, users.id))
    .where(eq(tickets.id, id))
    .limit(1);
  return rows[0] ? mapTicketRow(rows[0]) : null;
}

export type TicketListResult = { items: TicketRow[]; total: number; page: number; pageSize: number };

/** 某个用户自己的工单，最近有动静的排前面。 */
export async function listTicketsForUser(userId: number, options: { status?: TicketStatusFilter; page?: number } = {}): Promise<TicketListResult> {
  const page = normalizePage(options.page);
  const pageSize = TICKET_LIST_PAGE_SIZE;
  const db = await getDb();
  if (!db) return { items: [], total: 0, page, pageSize };
  const where = and(eq(tickets.userId, userId), statusCondition(options.status));
  const [countRow] = await db.select({ total: sqlCountAll() }).from(tickets).where(where);
  const rows = await db
    .select(ticketColumns)
    .from(tickets)
    .leftJoin(users, eq(tickets.userId, users.id))
    .where(where)
    .orderBy(desc(tickets.lastMessageAt), desc(tickets.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items: (rows as any[]).map(mapTicketRow), total: Number((countRow as any)?.total || 0), page, pageSize };
}

/**
 * 管理员看全部工单。排序：待处理的在最前，其次已回复、已关闭；同一状态里优先级高的在前，
 * 再按最后一条消息的时间倒序。keyword 匹配标题或用户名（不分大小写），纯数字 / #数字 也匹配工单编号。
 */
export async function listTicketsForAdmin(options: {
  status?: TicketStatusFilter;
  priority?: TicketPriority;
  keyword?: string;
  page?: number;
} = {}): Promise<TicketListResult> {
  const page = normalizePage(options.page);
  const pageSize = TICKET_LIST_PAGE_SIZE;
  const db = await getDb();
  if (!db) return { items: [], total: 0, page, pageSize };
  const conditions: Array<SQL | undefined> = [statusCondition(options.status)];
  if (options.priority) conditions.push(eq(tickets.priority, options.priority));
  const keyword = String(options.keyword || "").trim();
  if (keyword) {
    const pattern = likePattern(keyword);
    const idMatch = /^#?(\d{1,9})$/.exec(keyword);
    conditions.push(sql`(LOWER(${tickets.title}) LIKE ${pattern} ESCAPE '!' OR LOWER(${users.username}) LIKE ${pattern} ESCAPE '!'${idMatch ? sql` OR ${tickets.id} = ${Number(idMatch[1])}` : sql``})`);
  }
  const where = and(...conditions.filter(Boolean) as SQL[]);
  const [countRow] = await db
    .select({ total: sqlCountAll() })
    .from(tickets)
    .leftJoin(users, eq(tickets.userId, users.id))
    .where(where);
  const rows = await db
    .select(ticketColumns)
    .from(tickets)
    .leftJoin(users, eq(tickets.userId, users.id))
    .where(where)
    .orderBy(
      sql`CASE ${tickets.status} WHEN 'waiting_staff' THEN 0 WHEN 'waiting_user' THEN 1 ELSE 2 END`,
      sql`CASE ${tickets.priority} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`,
      desc(tickets.lastMessageAt),
      desc(tickets.id),
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items: (rows as any[]).map(mapTicketRow), total: Number((countRow as any)?.total || 0), page, pageSize };
}

/**
 * 一张工单的消息，从旧到新。不给 beforeId 时取最新的一页；给了就取比它更早的一页
 * （「加载更早的消息」）。hasMore 表示前面还有。
 */
export async function listTicketMessages(
  ticketId: number,
  options: { beforeId?: number; limit?: number } = {},
): Promise<{ messages: TicketMessageRow[]; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(TICKET_MESSAGE_PAGE_SIZE, Math.floor(Number(options.limit) || TICKET_MESSAGE_PAGE_SIZE)));
  const db = await getDb();
  if (!db) return { messages: [], hasMore: false };
  const where = options.beforeId
    ? and(eq(ticketMessages.ticketId, ticketId), lt(ticketMessages.id, options.beforeId))
    : eq(ticketMessages.ticketId, ticketId);
  const rows = await db
    .select({
      id: ticketMessages.id,
      ticketId: ticketMessages.ticketId,
      senderId: ticketMessages.senderId,
      senderUsername: users.username,
      senderDisplayName: users.name,
      isStaff: ticketMessages.isStaff,
      content: ticketMessages.content,
      createdAt: ticketMessages.createdAt,
    })
    .from(ticketMessages)
    .leftJoin(users, eq(ticketMessages.senderId, users.id))
    .where(where)
    .orderBy(desc(ticketMessages.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const messages: TicketMessageRow[] = (rows as any[]).slice(0, limit).map(mapMessageRow).reverse();
  return { messages, hasMore };
}

/** 回复工单。工单不存在抛 TicketNotFoundError，已关闭抛 TicketClosedError。 */
export async function addTicketMessage(input: {
  ticketId: number;
  senderId: number;
  isStaff: boolean;
  content: string;
}): Promise<{ ticket: TicketRow; messageId: number }> {
  const messageId = await withDatabaseTransaction(async () => {
    const now = nowSeconds();
    const q = quoteDbIdentifier;
    const result = await executeRaw(
      `UPDATE ${q("tickets")} SET ${q("status")} = ?, ${q("lastMessageAt")} = ?, ${q("lastMessageByStaff")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("status")} <> 'closed'`,
      [input.isStaff ? "waiting_user" : "waiting_staff", now, input.isStaff, now, input.ticketId],
    );
    if (rawAffectedRows(result) === 0) {
      const existing = await getTicketById(input.ticketId);
      if (!existing) throw new TicketNotFoundError();
      throw new TicketClosedError();
    }
    return insertAndGetId("ticket_messages", {
      ticketId: input.ticketId,
      senderId: input.senderId,
      isStaff: input.isStaff,
      content: input.content,
      createdAt: now,
    });
  });
  const ticket = await getTicketById(input.ticketId);
  if (!ticket) throw new TicketNotFoundError();
  return { ticket, messageId };
}

/**
 * 关闭 / 重新打开。重新打开一律回到 waiting_staff；对没关的工单「打开」、对已关的「关闭」
 * 什么都不改，原样返回。
 */
export async function setTicketOpenState(ticketId: number, open: boolean): Promise<{ ticket: TicketRow; changed: boolean }> {
  const now = nowSeconds();
  const q = quoteDbIdentifier;
  const result = open
    ? await executeRaw(
      `UPDATE ${q("tickets")} SET ${q("status")} = 'waiting_staff', ${q("closedAt")} = NULL, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("status")} = 'closed'`,
      [now, ticketId],
    )
    : await executeRaw(
      `UPDATE ${q("tickets")} SET ${q("status")} = 'closed', ${q("closedAt")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("status")} <> 'closed'`,
      [now, now, ticketId],
    );
  const ticket = await getTicketById(ticketId);
  if (!ticket) throw new TicketNotFoundError();
  return { ticket, changed: rawAffectedRows(result) > 0 };
}

/** 侧栏角标用：等管理员回复的工单数。 */
export async function countTicketsWaitingStaff(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db.select({ total: sqlCountAll() }).from(tickets).where(eq(tickets.status, "waiting_staff"));
  return Number((row as any)?.total || 0);
}

