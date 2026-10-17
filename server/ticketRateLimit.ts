/*
  工单的限制（按用户）：
  - 每人每小时最多新建 5 张，每 10 分钟最多回复 30 条；
  - 每人同时最多 10 张没关闭的工单（照上游 poouo/Forwardx 的「未完成工单最多 10 个」）。
  管理员不受限 —— 限制是防普通用户刷屏，不该拦着管理员处理工单。

  以前频率只记在进程内存里，面板一重启就清零（重启一次就能再刷一轮）。现在直接数库里的记录：
  工单表的 createdAt、消息表的 senderId + createdAt —— 不另建计数表，重启、多实例看到的都是同一份。
  「回复」不算每张工单的第一条消息（那是新建时一起写的，已经算在新建里）。
  同一个用户的「检查 + 写入」在进程内串行（withTicketUserQuota），两个并发请求不会一起钻过上限。
*/
import { getDb, queryRaw, quoteDbIdentifier } from "./dbRuntime";
import { withKeyedTaskLock } from "./keyedTaskLock";

export const TICKET_CREATE_LIMIT = 5;
export const TICKET_CREATE_WINDOW_MS = 60 * 60 * 1000;
export const TICKET_REPLY_LIMIT = 30;
export const TICKET_REPLY_WINDOW_MS = 10 * 60 * 1000;
export const TICKET_OPEN_LIMIT = 10;

const q = quoteDbIdentifier;

function retryText(retryAfterMs: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `${minutes} 分钟`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** 窗口里最早那条什么时候滑出去（毫秒）。 */
function retryAfterMs(oldestInWindow: unknown, windowMs: number) {
  const oldest = Number(oldestInWindow || 0);
  if (!Number.isFinite(oldest) || oldest <= 0) return windowMs;
  return Math.max(0, oldest * 1000 + windowMs - Date.now());
}

/** 同一个用户的工单「检查额度 + 写入」串起来做。 */
export function withTicketUserQuota<T>(userId: number, work: () => Promise<T>): Promise<T> {
  return withKeyedTaskLock(`ticket-quota:${Number(userId)}`, work);
}

/** 能新建就返回 null；超了返回给人看的原因。在 withTicketUserQuota 里、写入之前调用。 */
export async function checkTicketCreateQuota(userId: number, isAdmin: boolean): Promise<string | null> {
  if (isAdmin || !(await getDb())) return null;
  const since = nowSeconds() - Math.floor(TICKET_CREATE_WINDOW_MS / 1000);
  const [row] = await queryRaw<{ recent: number | string | null; oldest: number | string | null; open: number | string | null }>(
    `SELECT
       SUM(CASE WHEN ${q("createdAt")} >= ? THEN 1 ELSE 0 END) AS ${q("recent")},
       MIN(CASE WHEN ${q("createdAt")} >= ? THEN ${q("createdAt")} END) AS ${q("oldest")},
       SUM(CASE WHEN ${q("status")} <> 'closed' THEN 1 ELSE 0 END) AS ${q("open")}
     FROM ${q("tickets")} WHERE ${q("userId")} = ?`,
    [since, since, userId],
  );
  if (Number(row?.open || 0) >= TICKET_OPEN_LIMIT) {
    return `没关闭的工单最多 ${TICKET_OPEN_LIMIT} 张，请先在已有工单里继续沟通，或关掉已经解决的工单`;
  }
  if (Number(row?.recent || 0) >= TICKET_CREATE_LIMIT) {
    return `新建工单太频繁了（每小时最多 ${TICKET_CREATE_LIMIT} 张），请 ${retryText(retryAfterMs(row?.oldest, TICKET_CREATE_WINDOW_MS))}后再试`;
  }
  return null;
}

/** 能回复就返回 null；超了返回给人看的原因。在 withTicketUserQuota 里、写入之前调用。 */
export async function checkTicketReplyQuota(userId: number, isAdmin: boolean): Promise<string | null> {
  if (isAdmin || !(await getDb())) return null;
  const since = nowSeconds() - Math.floor(TICKET_REPLY_WINDOW_MS / 1000);
  const [row] = await queryRaw<{ recent: number | string | null; oldest: number | string | null }>(
    `SELECT COUNT(*) AS ${q("recent")}, MIN(m.${q("createdAt")}) AS ${q("oldest")}
     FROM ${q("ticket_messages")} m
     WHERE m.${q("senderId")} = ? AND m.${q("isStaff")} = ? AND m.${q("createdAt")} >= ?
       AND m.${q("id")} > (SELECT MIN(f.${q("id")}) FROM ${q("ticket_messages")} f WHERE f.${q("ticketId")} = m.${q("ticketId")})`,
    [userId, false, since],
  );
  if (Number(row?.recent || 0) >= TICKET_REPLY_LIMIT) {
    return `回复太频繁了（每 10 分钟最多 ${TICKET_REPLY_LIMIT} 条），请 ${retryText(retryAfterMs(row?.oldest, TICKET_REPLY_WINDOW_MS))}后再试`;
  }
  return null;
}
