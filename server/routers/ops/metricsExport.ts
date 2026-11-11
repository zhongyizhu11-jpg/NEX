import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import {
  loadMetricsExportConfig,
  maskMetricsToken,
  METRICS_EXPORT_MAX_RULES_DEFAULT,
  METRICS_EXPORT_MAX_RULES_LIMIT,
  metricsExportConfigFromSettings,
  resetMetricsToken,
  saveMetricsExportConfig,
  type MetricsExportConfig,
} from "../../ops/metricsExportSettings";
import { METRICS_CACHE_TTL_MS, METRICS_PATH } from "../../ops/metricsRoute";

/*
  trpc.ops.metricsExport.* —— 设置 › 进阶 › 指标导出（GET /metrics，见 server/ops/metricsExport.ts）。
  只给管理员，整个路由在 API 令牌禁止名单里：这里能看、能换抓取口令，泄露的 API 令牌不该顺手再拿走一个口令。
  口令平时只回打码后的样子；要看完整的走 revealToken（写操作，会进操作审计：谁、什么时候看过）。
  三个写操作都由 tRPC 的操作审计中间件记一行，参数里没有口令本身。
*/
const publicState = (config: MetricsExportConfig) => ({
  enabled: config.enabled,
  hasToken: !!config.token,
  tokenMasked: maskMetricsToken(config.token),
  maxRules: config.maxRules,
  maxRulesDefault: METRICS_EXPORT_MAX_RULES_DEFAULT,
  maxRulesLimit: METRICS_EXPORT_MAX_RULES_LIMIT,
  path: METRICS_PATH,
  cacheSeconds: METRICS_CACHE_TTL_MS / 1000,
});

export const metricsExportRouter = router({
  get: adminProcedure.query(async () => publicState((await loadMetricsExportConfig()) ?? metricsExportConfigFromSettings({}))),

  update: adminProcedure
    .input(z.object({
      enabled: z.boolean().optional(),
      maxRules: z.number().int().min(0).max(METRICS_EXPORT_MAX_RULES_LIMIT).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const config = await saveMetricsExportConfig(input);
      console.info(`[Metrics] settings updated by userId=${ctx.user.id}: enabled=${config.enabled} maxRules=${config.maxRules}`);
      return publicState(config);
    }),

  revealToken: adminProcedure.mutation(async ({ ctx }) => {
    const config = (await loadMetricsExportConfig()) ?? metricsExportConfigFromSettings({});
    console.info(`[Metrics] scrape token revealed userId=${ctx.user.id}`);
    return { token: config.token };
  }),

  resetToken: adminProcedure.mutation(async ({ ctx }) => {
    const config = await resetMetricsToken();
    console.info(`[Metrics] scrape token reset by userId=${ctx.user.id}`);
    return { ...publicState(config), token: config.token };
  }),
});
