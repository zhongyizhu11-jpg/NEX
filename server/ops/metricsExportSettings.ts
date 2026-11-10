/*
  指标导出（GET /metrics）的三项设置：开没开、抓取口令、规则明细上限。

  · 默认关。关着时 /metrics 回 404，和面板上任何一个不存在的接口一样。
  · 口令是 Bearer 令牌（Prometheus 的 scrape 配置原生支持 authorization.credentials）。键在
    server/settingsSecretKeys.ts 的名单里，落库是密文；第一次打开时自动生成，之后只能重置、不能自己填 ——
    自己填的口令十有八九是弱口令，而 /metrics 一旦被猜中，全站的主机名、规则名和流量都看得到。
  · 设置每次从 getAllSettings 读（那边自带 5 秒缓存）。读不出来（数据库正好不可用）就用上一次读到的：
    数据库挂了正是最需要 nex_database_up 掉成 0 的时候，不能因为读不了设置就一起 404。
    面板启动后一次都没读成功过，就按关着处理。
*/
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { databaseHealth } from "../databaseHealthState";
import { getAllSettings, setSetting } from "../repositories/settingsRepository";

export const METRICS_EXPORT_ENABLED_KEY = "ops.metrics.enabled";
export const METRICS_EXPORT_TOKEN_KEY = "ops.metrics.token";
export const METRICS_EXPORT_MAX_RULES_KEY = "ops.metrics.maxRules";

/** 规则超过这么多条就不再逐条导出，只给汇总。0 = 永远只给汇总。 */
export const METRICS_EXPORT_MAX_RULES_DEFAULT = 500;
export const METRICS_EXPORT_MAX_RULES_LIMIT = 2000;

export type MetricsExportConfig = {
  enabled: boolean;
  token: string;
  maxRules: number;
};

export function normalizeMetricsMaxRules(value: unknown): number {
  if (value === null || value === undefined || value === "") return METRICS_EXPORT_MAX_RULES_DEFAULT;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) return METRICS_EXPORT_MAX_RULES_DEFAULT;
  return Math.min(METRICS_EXPORT_MAX_RULES_LIMIT, number);
}

export function metricsExportConfigFromSettings(settings: Record<string, string | null | undefined>): MetricsExportConfig {
  return {
    enabled: settings[METRICS_EXPORT_ENABLED_KEY] === "true",
    token: String(settings[METRICS_EXPORT_TOKEN_KEY] || ""),
    maxRules: normalizeMetricsMaxRules(settings[METRICS_EXPORT_MAX_RULES_KEY]),
  };
}

/** nex_metrics_ 加 32 字节随机数：前缀让它在日志、审计里一眼认得出是什么，也会被操作审计按令牌打码。 */
export function generateMetricsToken(): string {
  return `nex_metrics_${randomBytes(32).toString("base64url")}`;
}

/** 给界面看的打码样子：只留前缀和最后 4 位。 */
export function maskMetricsToken(token: string): string {
  const text = String(token || "");
  if (!text) return "";
  return `nex_metrics_${"•".repeat(8)}${text.slice(-4)}`;
}

/**
 * 请求头里的口令对不对。先各自取摘要再比：timingSafeEqual 要求两边一样长，
 * 而长度本身不该靠「比得快不快」漏出去。没配口令时谁也对不上。
 */
export function metricsTokenMatches(authorization: unknown, token: string): boolean {
  if (!token) return false;
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header ?? ""));
  if (!match) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(token));
}

let lastKnown: MetricsExportConfig | null = null;

export async function loadMetricsExportConfig(): Promise<MetricsExportConfig | null> {
  // 已经知道数据库不可用就不去试了：每试一次都要等连接超时，抓取会跟着超时。
  if (databaseHealth.isUnavailable()) return lastKnown;
  try {
    lastKnown = metricsExportConfigFromSettings(await getAllSettings());
  } catch {
    // 数据库读不了：沿用上一次读到的（见文件头）。
  }
  return lastKnown;
}

/**
 * 保存开关 / 上限。打开而还没有口令时顺手生成一个；关掉不清口令 —— 临时关一下再打开，
 * Prometheus 那边的配置不用跟着改。
 */
export async function saveMetricsExportConfig(patch: { enabled?: boolean; maxRules?: number }): Promise<MetricsExportConfig> {
  const current = metricsExportConfigFromSettings(await getAllSettings());
  const next: MetricsExportConfig = { ...current };
  if (patch.maxRules !== undefined) {
    next.maxRules = normalizeMetricsMaxRules(patch.maxRules);
    await setSetting(METRICS_EXPORT_MAX_RULES_KEY, String(next.maxRules));
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled && !next.token) {
      next.token = generateMetricsToken();
      await setSetting(METRICS_EXPORT_TOKEN_KEY, next.token);
    }
    next.enabled = patch.enabled;
    await setSetting(METRICS_EXPORT_ENABLED_KEY, next.enabled ? "true" : "false");
  }
  lastKnown = next;
  return next;
}

/** 换一个新口令，旧的立刻失效。返回新口令（只在这一次回给界面）。 */
export async function resetMetricsToken(): Promise<MetricsExportConfig> {
  const current = metricsExportConfigFromSettings(await getAllSettings());
  const next = { ...current, token: generateMetricsToken() };
  await setSetting(METRICS_EXPORT_TOKEN_KEY, next.token);
  lastKnown = next;
  return next;
}

export function resetMetricsExportConfigForTest() {
  lastKnown = null;
}
