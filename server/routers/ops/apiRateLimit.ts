import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { API_RATE_LIMIT_MAX, DEFAULT_API_RATE_LIMIT } from "../../apiRateLimit";
import { loadApiRateLimitConfig, saveApiRateLimitConfig } from "../../apiRateLimitConfig";

/**
 * trpc.ops.apiRateLimit.* —— 设置 › 进阶 › 接口限流（批次 1 · 第 2 项）。
 * 只给管理员；API 令牌改不了（ops.apiRateLimit.update 在令牌禁止名单里：令牌不能给自己解除限流）。
 */
const limit = z.number().int().min(0).max(API_RATE_LIMIT_MAX);

export const apiRateLimitRouter = router({
  get: adminProcedure.query(async () => ({ config: await loadApiRateLimitConfig(), defaults: DEFAULT_API_RATE_LIMIT })),

  update: adminProcedure
    .input(z.object({
      enabled: z.boolean(),
      userQueryPerMinute: limit,
      userMutationPerMinute: limit,
      tokenQueryPerMinute: limit,
      tokenMutationPerMinute: limit,
      anonymousQueryPerMinute: limit,
      anonymousMutationPerMinute: limit,
    }))
    .mutation(async ({ input, ctx }) => {
      const config = await saveApiRateLimitConfig(input);
      console.info(`[RateLimit] settings updated by userId=${ctx.user.id}: ${JSON.stringify(config)}`);
      return { config };
    }),
});
