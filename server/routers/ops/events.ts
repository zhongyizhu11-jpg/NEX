import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { listPanelEvents, type PanelEvent } from "../../ops/panelEvents";
import { getHostNamesByIds } from "../../repositories/hostRepository";
import { getUserDisplayNamesByIds } from "../../repositories/userRepository";

/*
  trpc.ops.events.* —— 事件时间线（监控 › 事件、首页「最近动态」、主机详情「最近动态」）。

  主机名、用户名不在 SQL 里 JOIN：事件表三种库通用、只按自己的索引查，查完把这一页里
  出现的 id 收拢起来各用一条 IN 取名字（一页最多一百条，id 不会多）。主机删掉了就只剩 id，
  界面上写「#12」。
*/

export type PanelEventView = {
  id: number;
  kind: string;
  level: PanelEvent["level"];
  message: string;
  hostId: number | null;
  hostName: string | null;
  userId: number | null;
  userName: string | null;
  ruleId: number | null;
  createdAt: Date;
};

async function withNames(events: PanelEvent[]): Promise<PanelEventView[]> {
  const hostIds = events.map((event) => event.hostId).filter((id): id is number => !!id);
  const userIds = events.map((event) => event.userId).filter((id): id is number => !!id);
  const [hostNames, userNames] = await Promise.all([
    hostIds.length > 0 ? getHostNamesByIds(hostIds).catch(() => new Map<number, string>()) : new Map<number, string>(),
    userIds.length > 0 ? getUserDisplayNamesByIds(userIds).catch(() => new Map<number, string>()) : new Map<number, string>(),
  ]);
  return events.map((event) => ({
    id: event.id,
    kind: event.kind,
    level: event.level,
    message: event.message,
    hostId: event.hostId,
    hostName: event.hostId ? hostNames.get(event.hostId) || null : null,
    userId: event.userId,
    userName: event.userId ? userNames.get(event.userId) || null : null,
    ruleId: event.ruleId,
    createdAt: event.createdAt,
  }));
}

const idSchema = z.number().int().positive().max(2_147_483_647);

export const eventsRouter = router({
  /** 时间线：按 id 倒序一页一页往下翻（beforeId = 上一页最后一条的 id）。 */
  list: adminProcedure
    .input(z.object({
      minLevel: z.enum(["all", "warn"]).default("all"),
      hostId: idSchema.nullish(),
      userId: idSchema.nullish(),
      kindPrefix: z.string().trim().max(32).regex(/^[a-z_.]*$/).nullish(),
      beforeId: idSchema.nullish(),
      /** 同 beforeId；useInfiniteQuery 只认 cursor 这个名字。 */
      cursor: idSchema.nullish(),
      limit: z.number().int().min(1).max(100).default(50),
    }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit ?? 50;
      // 多取一条，用来判断还有没有下一页
      const events = await listPanelEvents({
        limit: limit + 1,
        beforeId: input?.cursor ?? input?.beforeId ?? null,
        hostId: input?.hostId ?? null,
        userId: input?.userId ?? null,
        minLevel: input?.minLevel === "warn" ? "warn" : null,
        kindPrefix: input?.kindPrefix || null,
      });
      const page = events.slice(0, limit);
      return {
        items: await withNames(page),
        nextCursor: events.length > limit && page.length > 0 ? page[page.length - 1].id : null,
      };
    }),

  /** 最近 N 条（首页卡片、主机详情）。 */
  recent: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(50).default(8),
      hostId: idSchema.nullish(),
    }).optional())
    .query(async ({ input }) => {
      const events = await listPanelEvents({ limit: input?.limit ?? 8, hostId: input?.hostId ?? null });
      return withNames(events);
    }),
});
