import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, router } from "../../_core/trpc";
import {
  deletePanelProfilingCapture,
  getPanelProfilingStatus,
  PANEL_PROFILING_CPU_MAX_SECONDS,
  PANEL_PROFILING_CPU_MIN_SECONDS,
  PanelProfilingError,
  setPanelProfilingEnabled,
  startPanelCpuProfile,
  takePanelHeapSnapshot,
} from "../../panelProfiling";

/*
  trpc.ops.profiling.* —— 设置 › 面板日志 › 性能剖析（server/panelProfiling.ts）。
  只有管理员；整个路由在 API 令牌禁止名单里（堆快照就是进程内存的原样拷贝）。
  文件本身走 GET /api/ops/profiling/:id/download（server/panelProfilingRoute.ts），不经 tRPC。
*/

const asTrpcError = (error: unknown): never => {
  if (error instanceof PanelProfilingError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
  throw error;
};

const captureId = z.string().regex(/^[0-9a-f]{24}$/);

export const profilingRouter = router({
  status: adminProcedure.query(() => getPanelProfilingStatus()),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => ({ enabledUntil: await setPanelProfilingEnabled(input.enabled) })),

  captureCpu: adminProcedure
    .input(z.object({ seconds: z.number().int().min(PANEL_PROFILING_CPU_MIN_SECONDS).max(PANEL_PROFILING_CPU_MAX_SECONDS) }))
    .mutation(({ input }) => startPanelCpuProfile(input.seconds).catch(asTrpcError)),

  captureHeap: adminProcedure.mutation(() => takePanelHeapSnapshot().catch(asTrpcError)),

  remove: adminProcedure
    .input(z.object({ id: captureId }))
    .mutation(({ input }) => ({ removed: deletePanelProfilingCapture(input.id) })),
});
