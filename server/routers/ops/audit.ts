import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, router } from "../../_core/trpc";
import {
  getLinkedConfigChanges,
  getOperationAuditEvent,
  getOperationAuditFacets,
  getOperationAuditRetentionDays,
  listOperationAuditEvents,
  setOperationAuditRetentionDays,
} from "../../operationAudit";
import {
  OPERATION_AUDIT_RETENTION_MAX_DAYS,
  OPERATION_AUDIT_RETENTION_MIN_DAYS,
} from "../../../shared/operationAudit";

/*
  trpc.ops.audit.* —— 监控 › 操作审计。只有管理员能看：里面有所有人的操作、IP 和（打过码的）参数。
  列表按 id 倒序翻页（cursor = 上一页最后一条的 id），和事件时间线一样。
*/

const idSchema = z.number().int().positive().max(2_147_483_647);

export const auditRouter = router({
  list: adminProcedure
    .input(z.object({
      actorUserId: idSchema.nullish(),
      module: z.string().trim().max(96).regex(/^[A-Za-z0-9_.]*$/).nullish(),
      result: z.enum(["ok", "denied", "error"]).nullish(),
      sinceSeconds: z.number().int().min(0).nullish(),
      untilSeconds: z.number().int().min(0).nullish(),
      search: z.string().trim().max(64).nullish(),
      cursor: idSchema.nullish(),
      limit: z.number().int().min(1).max(100).default(50),
    }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit ?? 50;
      const events = await listOperationAuditEvents({
        limit: limit + 1,
        beforeId: input?.cursor ?? null,
        actorUserId: input?.actorUserId ?? null,
        module: input?.module || null,
        result: input?.result ?? null,
        sinceSeconds: input?.sinceSeconds ?? null,
        untilSeconds: input?.untilSeconds ?? null,
        search: input?.search || null,
      });
      const page = events.slice(0, limit);
      return {
        items: page,
        nextCursor: events.length > limit && page.length > 0 ? page[page.length - 1].id : null,
      };
    }),

  /** 一条的全部内容，加上同一次请求在配置审计里的字段差异。 */
  detail: adminProcedure
    .input(z.object({ id: idSchema }))
    .query(async ({ input }) => {
      const event = await getOperationAuditEvent(input.id);
      if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "这条审计记录不存在（可能已过保留期被清理）" });
      return { event, configChanges: await getLinkedConfigChanges(event) };
    }),

  facets: adminProcedure.query(() => getOperationAuditFacets()),

  settings: adminProcedure.query(async () => ({ retentionDays: await getOperationAuditRetentionDays() })),

  setRetention: adminProcedure
    .input(z.object({ days: z.number().int().min(OPERATION_AUDIT_RETENTION_MIN_DAYS).max(OPERATION_AUDIT_RETENTION_MAX_DAYS) }))
    .mutation(async ({ input }) => ({ retentionDays: await setOperationAuditRetentionDays(input.days) })),
});
