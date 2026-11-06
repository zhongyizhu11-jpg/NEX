import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import {
  AGENT_PPROF_DEFAULT_MINUTES,
  AGENT_PPROF_MAX_MINUTES,
  agentPprofRequestedUntil,
  getAgentPprofReport,
  getAgentRuntimeStats,
  setAgentPprof,
} from "../ops/agentRuntime";
import { requireHostAccess } from "./helpers";

/*
  trpc.agentRuntime.* —— 主机详情里的「Agent 运行状态」（server/ops/agentRuntime.ts）。

  get       心跳里报的运行状况 + 性能剖析的状态（能看这台主机的人都能看；剖析地址只给管理员）
  setPprof  打开 / 关掉这台主机 Agent 的性能剖析（管理员）：只在那台机器的 127.0.0.1 上开，到点自动关
*/
const hostIdInput = z.object({ hostId: z.number().int().positive() });

export const agentRuntimeRouter = router({
  get: protectedProcedure.input(hostIdInput).query(async ({ ctx, input }) => {
    await requireHostAccess(ctx, input.hostId);
    const stats = getAgentRuntimeStats(input.hostId);
    const isAdmin = ctx.user.role === "admin";
    const report = getAgentPprofReport(input.hostId);
    return {
      stats: stats ? { ...stats, pprof: isAdmin ? stats.pprof : null } : null,
      pprof: isAdmin
        ? {
            requestedUntil: agentPprofRequestedUntil(input.hostId),
            report,
            defaultMinutes: AGENT_PPROF_DEFAULT_MINUTES,
            maxMinutes: AGENT_PPROF_MAX_MINUTES,
          }
        : null,
    };
  }),

  setPprof: adminProcedure
    .input(hostIdInput.extend({ minutes: z.number().int().min(0).max(AGENT_PPROF_MAX_MINUTES) }))
    .mutation(async ({ ctx, input }) => {
      await requireHostAccess(ctx, input.hostId);
      return { until: setAgentPprof(input.hostId, input.minutes) };
    }),
});
