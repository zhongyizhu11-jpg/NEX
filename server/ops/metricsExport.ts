/*
  指标导出的总装：设置（metricsExportSettings）→ 取数（metricsCollect）→ 指标族（metricsFamilies）
  → 文本（metricsText），挂在 GET /metrics 上（metricsRoute）。server/index.ts 只引用这里的 metricsRouter。
  默认关；关着时这条路径回 404，不取任何数。怎么用见 docs/guide/metrics.md。
*/
import { collectMetricsSnapshot } from "./metricsCollect";
import { buildMetricFamilies } from "./metricsFamilies";
import { loadMetricsExportConfig } from "./metricsExportSettings";
import { createMetricsRouter } from "./metricsRoute";
import { renderMetricFamilies } from "./metricsText";

export const metricsRouter = createMetricsRouter({
  loadConfig: loadMetricsExportConfig,
  render: async (config) => renderMetricFamilies(buildMetricFamilies(await collectMetricsSnapshot({ maxRules: config.maxRules }))),
});
