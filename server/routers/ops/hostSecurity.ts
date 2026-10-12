import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { queryRaw, quoteDbIdentifier } from "../../dbRuntime";
import {
  decideFindingStatus,
  hostSecuritySummary,
  listFindings,
  requestRebaseline,
  requestSecurityAction,
} from "../../ops/hostSecurity";

/*
  trpc.ops.hostSecurity.* —— 监控 › 安全巡检（#3），只给管理员。

  list        发现列表（状态 / 最低级别 / 主机）
  decide      知道了 / 这是我的（这台或所有主机）/ 重新打开
  act         停止进程 / 隔离文件（发给 Agent，Agent 核对后执行）
  undo        撤销隔离（把文件放回原处）
  hostSummary 主机详情里的「安全」一节
  rebaseline  重新建立基线（之后这台机器上现有的一切都当作正常）
*/
const statusSchema = z.enum(["open", "acknowledged", "expected", "all"]);
const severitySchema = z.enum(["low", "medium", "high", "critical"]);

export const hostSecurityRouter = router({
  list: adminProcedure
    .input(z.object({
      status: statusSchema.default("open"),
      minSeverity: severitySchema.optional(),
      hostId: z.number().int().positive().optional(),
    }).optional())
    .query(async ({ input }) => {
      const items = await listFindings({ status: input?.status ?? "open", minSeverity: input?.minSeverity, hostId: input?.hostId, limit: 300 });
      const hosts = await queryRaw<any>(`SELECT ${quoteDbIdentifier("id")}, ${quoteDbIdentifier("name")} FROM ${quoteDbIdentifier("hosts")}`);
      return {
        items,
        hosts: hosts.map((h) => ({ id: Number(h.id), name: String(h.name || `主机 #${h.id}`) })).sort((x, y) => x.name.localeCompare(y.name, "zh-CN")),
      };
    }),

  decide: adminProcedure
    .input(z.object({
      id: z.number().int().positive(),
      decision: z.enum(["acknowledge", "expected", "reopen"]),
      scope: z.enum(["host", "all"]).default("host"),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await decideFindingStatus(input.id, input.decision, input.scope, Number(ctx.user.id));
      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "找不到这条发现" });
      return result;
    }),

  act: adminProcedure
    .input(z.object({ id: z.number().int().positive(), action: z.enum(["kill", "quarantine"]) }))
    .mutation(async ({ input, ctx }) => {
      const result = await requestSecurityAction(input.id, input.action, Number(ctx.user.id));
      if (!result.ok) throw new TRPCError({ code: "BAD_REQUEST", message: result.message });
      return result;
    }),

  undo: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const result = await requestSecurityAction(input.id, "restore", Number(ctx.user.id));
      if (!result.ok) throw new TRPCError({ code: "BAD_REQUEST", message: result.message });
      return result;
    }),

  hostSummary: adminProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .query(({ input }) => hostSecuritySummary(input.hostId)),

  rebaseline: adminProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await requestRebaseline(input.hostId);
      return { success: true };
    }),
});
