/**
 * 订阅系统的全局设置：从 system_settings 的 `proxySub.*` 键里读，带 15 秒缓存。
 *
 * 每次拉订阅都要看它（限流、缓存、设备限制、测速地址……），不能每次整表读；
 * 管理员保存后立刻作废缓存，所以改完就生效。
 */

import {
  parseProxySubSettings,
  PROXY_SUB_SETTING_PREFIX,
  serializeProxySubSettings,
  type ProxySubSettings,
} from "../shared/proxySubSettings";
import { getSettingsByPrefix, setSettings } from "./repositories/settingsRepository";
import { invalidateProxySubCacheAll } from "./proxySubCache";

const CACHE_TTL_MS = 15_000;

let cached: { value: ProxySubSettings; expiresAt: number } | null = null;
let pending: Promise<ProxySubSettings> | null = null;

export async function loadProxySubSettings(): Promise<ProxySubSettings> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    try {
      const record = await getSettingsByPrefix(PROXY_SUB_SETTING_PREFIX);
      const value = parseProxySubSettings(record);
      cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      return value;
    } catch (error) {
      // 读不到设置（库刚切换、连接抖动）就用上一次的，再不行用默认 —— 订阅不该因为设置表而 500。
      if (cached) return cached.value;
      console.warn("[proxy-subscription] 读取订阅设置失败，按默认值:", error instanceof Error ? error.message : error);
      return parseProxySubSettings({});
    } finally {
      pending = null;
    }
  })();
  return pending;
}

export async function saveProxySubSettings(partial: Partial<ProxySubSettings>): Promise<ProxySubSettings> {
  await setSettings(serializeProxySubSettings(partial));
  invalidateProxySubSettingsCache();
  // 测速地址、镜像这些会改渲染结果，缓存的正文一律作废。
  invalidateProxySubCacheAll();
  return loadProxySubSettings();
}

export function invalidateProxySubSettingsCache() {
  cached = null;
}
