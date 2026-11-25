/**
 * 订阅系统的全局设置：从 system_settings 的 `proxySub.*` 键里读，带 15 秒缓存。
 *
 * 每次拉订阅都要看它（限流、缓存、设备限制、测速地址……），不能每次整表读；
 * 管理员保存后立刻作废缓存，所以改完就生效。
 */

import { createHash } from "node:crypto";

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
      // 指纹在这里算一次：这份对象接下来 15 秒里每次拉订阅都要拿它进缓存键。
      proxySubSettingsFingerprint(value);
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

/**
 * 一份设置的指纹，订阅缓存键里放它而不放整份设置。
 *
 * 原来键里直接塞 renderSettings：每次拉取都把整份设置（含两段最多 20 KB 的自定义规则）
 * JSON.stringify 一遍再 sha1。按对象记（WeakMap）：loadProxySubSettings 给的是同一个缓存对象，
 * 算一次用 15 秒；别处自己拼的设置对象第一次问时算、之后也记着。
 */
const fingerprints = new WeakMap<ProxySubSettings, string>();

export function proxySubSettingsFingerprint(settings: ProxySubSettings): string {
  let fingerprint = fingerprints.get(settings);
  if (!fingerprint) {
    fingerprint = createHash("sha1").update(JSON.stringify(settings)).digest("hex");
    fingerprints.set(settings, fingerprint);
  }
  return fingerprint;
}

export async function saveProxySubSettings(partial: Partial<ProxySubSettings>): Promise<ProxySubSettings> {
  await setSettings(serializeProxySubSettings(partial));
  invalidateProxySubSettingsCache();
  // 测速地址、镜像这些会改渲染结果，缓存的正文一律作废。
  invalidateProxySubCacheAll();
  return loadProxySubSettings();
}

/** @public 测试经 import(url(...)) 动态引用，knip 看不见 */
export function invalidateProxySubSettingsCache() {
  cached = null;
}
