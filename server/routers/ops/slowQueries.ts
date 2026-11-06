import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { getDatabaseKind } from "../../dbRuntime";
import { clearSlowQueries, listSlowQueries, SLOW_QUERY_THRESHOLD_MAX_MS } from "../../slowQueryLog";
import { saveSlowQueryThresholdSetting } from "../../slowQueryThresholdSetting";

/**
 * trpc.ops.slowQueries.* —— 设置 › 进阶 › 慢查询（见 server/slowQueryLog.ts）。只给管理员。
 * 只有语句指纹（参数抹掉了），没有参数值。
 */
export const slowQueriesRouter = router({
  list: adminProcedure.query(() => ({ dbKind: getDatabaseKind(), ...listSlowQueries() })),

  clear: adminProcedure.mutation(() => {
    clearSlowQueries();
    return { success: true };
  }),

  setThreshold: adminProcedure
    .input(z.object({ thresholdMs: z.number().int().min(0).max(SLOW_QUERY_THRESHOLD_MAX_MS) }))
    .mutation(async ({ input }) => ({ thresholdMs: await saveSlowQueryThresholdSetting(input.thresholdMs) })),
});
