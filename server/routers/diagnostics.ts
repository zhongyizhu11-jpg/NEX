import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getLinkDiagnosticsReport, startLinkDiagnostics } from "../linkDiagnostics";

/**
 * 一键链路诊断。start 当场给出面板侧的结论、给涉及的主机排 diagnostics 任务；
 * 浏览器每 2 秒拿 sessionId 来问 status，主机回报一项清单就更新一项。
 * 管理员什么都能诊断，普通用户只能诊断自己的规则 / 隧道 / 转发链（权限在 linkDiagnostics 里查）。
 */
export const diagnosticsRouter = router({
  start: protectedProcedure
    .input(z.object({
      kind: z.enum(["rule", "tunnel", "forwardGroup"]),
      id: z.number().int().positive(),
    }))
    .mutation(({ input, ctx }) => startLinkDiagnostics(ctx, input)),

  status: protectedProcedure
    .input(z.object({ sessionId: z.string().min(8).max(64) }))
    .query(({ input, ctx }) => getLinkDiagnosticsReport(ctx, input.sessionId)),
});
