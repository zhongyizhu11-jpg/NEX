import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import {
  listActiveAnomalyThrottles,
  readTrafficAnomalyConfig,
  releaseAnomalyThrottle,
  saveTrafficAnomalyConfig,
} from "../../ops/trafficAnomaly";

/*
  trpc.ops.trafficAnomaly.* —— 设置 › Webhook 下方的「流量异常」。判定在 server/ops/trafficAnomaly.ts 的定时任务里，
  这里只读写设置、列出正在生效的临时限速、手动撤掉某一条（误报时用）。写操作由 trpc 中间件统一进操作审计。
*/
export const trafficAnomalyRouter = router({
  get: adminProcedure.query(() => readTrafficAnomalyConfig()),

  save: adminProcedure
    .input(z.object({
      enabled: z.boolean(),
      sensitivity: z.enum(["high", "normal", "low", "custom"]),
      multiplier: z.number().int().min(2).max(100),
      minMbps: z.number().int().min(1).max(100_000),
      sustainMinutes: z.number().int().min(1).max(120),
      ipConnThreshold: z.number().int().min(0).max(1_000_000),
      autoThrottle: z.boolean(),
      throttleMinutes: z.number().int().min(5).max(24 * 60),
    }))
    .mutation(({ input }) => saveTrafficAnomalyConfig(input)),

  throttles: adminProcedure.query(() => listActiveAnomalyThrottles()),

  /** 手动撤掉一条临时限速：这一轮异常直到恢复都不会再自动加回来。 */
  release: adminProcedure
    .input(z.object({ ruleId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await releaseAnomalyThrottle(input.ruleId);
      return { ok: true };
    }),
});
