/*
  工单前后端共用的定义：状态、优先级、文案和输入限制。

  状态只有三种：
  - waiting_staff：等管理员回复（新建、用户回复、重新打开之后都是它）
  - waiting_user：管理员回复过了，等用户
  - closed：任意一方关掉了；关掉的工单不能直接回复，得先重新打开
*/

export const TICKET_STATUSES = ["waiting_staff", "waiting_user", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "medium", "high"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** 列表筛选多一个 open：没关的（waiting_staff + waiting_user）。 */
export const TICKET_STATUS_FILTERS = ["open", ...TICKET_STATUSES] as const;
export type TicketStatusFilter = (typeof TICKET_STATUS_FILTERS)[number];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  waiting_staff: "待处理",
  waiting_user: "已回复",
  closed: "已关闭",
};

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

export const TICKET_TITLE_MAX_LENGTH = 128;
export const TICKET_CONTENT_MAX_LENGTH = 5000;
export const TICKET_LIST_PAGE_SIZE = 20;
export const TICKET_MESSAGE_PAGE_SIZE = 100;

/** 用户被删之后，工单和消息还在，名字统一显示成这个。 */
export const DELETED_USER_LABEL = "已删除用户";

export function isTicketStatus(value: unknown): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(String(value));
}

export function isTicketPriority(value: unknown): value is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(String(value));
}

export function normalizeTicketStatus(value: unknown): TicketStatus {
  return isTicketStatus(value) ? value : "waiting_staff";
}

export function normalizeTicketPriority(value: unknown): TicketPriority {
  return isTicketPriority(value) ? value : "medium";
}

export type TicketTextResult = { ok: true; value: string } | { ok: false; error: string };

/** 标题：去掉首尾空白后 1~128 个字，只能一行，不能带 NUL。 */
export function normalizeTicketTitle(raw: unknown): TicketTextResult {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, error: "请填写工单标题" };
  if (value.includes("\0")) return { ok: false, error: "标题包含无效字符" };
  if (/[\r\n\u2028\u2029]/.test(value)) return { ok: false, error: "标题只能写一行" };
  if (value.length > TICKET_TITLE_MAX_LENGTH) return { ok: false, error: `标题最多 ${TICKET_TITLE_MAX_LENGTH} 个字` };
  return { ok: true, value };
}

/** 正文 / 回复：去掉首尾空白后 1~5000 个字，可以换行，不能带 NUL。 */
export function normalizeTicketContent(raw: unknown): TicketTextResult {
  const value = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!value) return { ok: false, error: "请填写内容" };
  if (value.includes("\0")) return { ok: false, error: "内容包含无效字符" };
  if (value.length > TICKET_CONTENT_MAX_LENGTH) return { ok: false, error: `内容最多 ${TICKET_CONTENT_MAX_LENGTH} 个字` };
  return { ok: true, value };
}
