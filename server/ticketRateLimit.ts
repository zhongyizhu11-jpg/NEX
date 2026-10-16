/*
  工单的频率限制（进程内存，按用户）：每人每小时最多新建 5 张，每 10 分钟最多回复 30 条。
  管理员不受限 —— 限制是防普通用户刷屏，不该拦着管理员处理工单。

  只在内存里记：面板重启就清零，多实例部署时各算各的。对「别刷屏」这个目的够用，
  不值得为它落库。
*/
import { SlidingWindowRateLimiter } from "./ai/rateLimiter";

export const TICKET_CREATE_LIMIT = 5;
export const TICKET_CREATE_WINDOW_MS = 60 * 60 * 1000;
export const TICKET_REPLY_LIMIT = 30;
export const TICKET_REPLY_WINDOW_MS = 10 * 60 * 1000;

const createLimiter = new SlidingWindowRateLimiter({ limit: TICKET_CREATE_LIMIT, windowMs: TICKET_CREATE_WINDOW_MS, maxKeys: 20_000 });
const replyLimiter = new SlidingWindowRateLimiter({ limit: TICKET_REPLY_LIMIT, windowMs: TICKET_REPLY_WINDOW_MS, maxKeys: 20_000 });

function retryText(retryAfterMs: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `${minutes} 分钟`;
}

/** 能新建就记一次并返回 null；超了返回给人看的原因。 */
export function consumeTicketCreateQuota(userId: number, isAdmin: boolean): string | null {
  if (isAdmin) return null;
  const result = createLimiter.consume(`user:${userId}`);
  if (result.allowed) return null;
  return `新建工单太频繁了（每小时最多 ${TICKET_CREATE_LIMIT} 张），请 ${retryText(result.retryAfterMs)}后再试`;
}

/** 能回复就记一次并返回 null；超了返回给人看的原因。 */
export function consumeTicketReplyQuota(userId: number, isAdmin: boolean): string | null {
  if (isAdmin) return null;
  const result = replyLimiter.consume(`user:${userId}`);
  if (result.allowed) return null;
  return `回复太频繁了（每 10 分钟最多 ${TICKET_REPLY_LIMIT} 条），请 ${retryText(result.retryAfterMs)}后再试`;
}

/** 测试用：清掉计数。 */
export function resetTicketRateLimits() {
  createLimiter.clear();
  replyLimiter.clear();
}
