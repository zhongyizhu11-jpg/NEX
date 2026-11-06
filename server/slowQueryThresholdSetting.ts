import { getSetting, setSetting } from "./repositories/settingsRepository";
import { applySlowQueryThresholdMs, normalizeSlowQueryThresholdMs, SLOW_QUERY_THRESHOLD_SETTING } from "./slowQueryLog";

/** 启动时读一次慢查询阈值（没设过 → 默认）。 */
export async function loadSlowQueryThresholdSetting() {
  const raw = await getSetting(SLOW_QUERY_THRESHOLD_SETTING);
  return applySlowQueryThresholdMs(raw === null || raw === "" ? undefined : raw);
}

/** 保存并立即生效；返回生效的阈值（环境变量 FORWARDX_SLOW_QUERY_MS 优先）。 */
export async function saveSlowQueryThresholdSetting(value: unknown) {
  const normalized = normalizeSlowQueryThresholdMs(value);
  await setSetting(SLOW_QUERY_THRESHOLD_SETTING, String(normalized));
  return applySlowQueryThresholdMs(normalized);
}
