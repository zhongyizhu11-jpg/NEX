/*
  接口限流的设置（system_settings.apiRateLimit，一段 JSON）和「被限流了」的事件提醒。

  限流在每个 tRPC 过程前都要判断一次，不能每次都去读库：这里缓存一份，最多 30 秒刷新一次
  （后台刷，判断时永远用手里那份，第一次没读到就用默认值）。管理员保存设置时直接换掉缓存，立刻生效。
*/
import { DEFAULT_API_RATE_LIMIT, normalizeApiRateLimitConfig, type ApiRateLimitConfig, type ApiRateLimitDecision } from "./apiRateLimit";

export const API_RATE_LIMIT_SETTING_KEY = "apiRateLimit";
const REFRESH_MS = 30_000;

let cached: ApiRateLimitConfig = DEFAULT_API_RATE_LIMIT;
let loadedAt = 0;
let loading: Promise<void> | null = null;

function parse(raw: string | null | undefined): ApiRateLimitConfig {
  if (!raw) return DEFAULT_API_RATE_LIMIT;
  try {
    return normalizeApiRateLimitConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_API_RATE_LIMIT;
  }
}

function refresh() {
  if (loading) return;
  loading = (async () => {
    try {
      const { getSetting } = await import("./repositories/settingsRepository");
      cached = parse(await getSetting(API_RATE_LIMIT_SETTING_KEY));
    } catch {
      // 库不可用：保留手里那份（默认值或上次读到的）
    } finally {
      loadedAt = Date.now();
      loading = null;
    }
  })();
}

/** 现在用的限流配置（同步；过期了在后台刷新）。 */
export function currentApiRateLimitConfig(now = Date.now()): ApiRateLimitConfig {
  if (now - loadedAt > REFRESH_MS) refresh();
  return cached;
}

/** 读库拿最新的（设置页用）。 */
export async function loadApiRateLimitConfig(): Promise<ApiRateLimitConfig> {
  const { getSetting } = await import("./repositories/settingsRepository");
  cached = parse(await getSetting(API_RATE_LIMIT_SETTING_KEY));
  loadedAt = Date.now();
  return cached;
}

/** 保存设置，并立刻换掉缓存。 */
export async function saveApiRateLimitConfig(input: unknown): Promise<ApiRateLimitConfig> {
  const next = normalizeApiRateLimitConfig(input);
  const { setSetting } = await import("./repositories/settingsRepository");
  await setSetting(API_RATE_LIMIT_SETTING_KEY, JSON.stringify(next));
  cached = next;
  loadedAt = Date.now();
  return next;
}

/** 测试用：直接换配置。 */
export function setApiRateLimitConfigForTests(config: ApiRateLimitConfig | null) {
  cached = config ?? DEFAULT_API_RATE_LIMIT;
  loadedAt = config ? Number.MAX_SAFE_INTEGER : 0;
}

/*
  被限流的提醒：同一个令牌 / 用户 10 分钟最多记一条事件（事件会转发到 Telegram / Webhook，
  一个疯跑的脚本不能把通知也刷爆）；没登录的 IP 只记日志不发事件 —— 扫描器天天有，提醒了也没用。
*/
const NOTIFY_INTERVAL_MS = 10 * 60_000;
const notifiedAt = new Map<string, number>();

export function noteApiRateLimited(
  decision: ApiRateLimitDecision,
  info: { path: string; type: string; userId?: number | null; tokenName?: string | null; ip?: string | null },
  now = Date.now(),
): boolean {
  const subjectKey = decision.key.replace(/:(query|mutation)$/, "");
  const last = notifiedAt.get(subjectKey) || 0;
  if (now - last < NOTIFY_INTERVAL_MS) return false;
  notifiedAt.set(subjectKey, now);
  if (notifiedAt.size > 5_000) notifiedAt.clear();
  const kindText = info.type === "query" ? "查询" : "修改";
  console.warn(`[RateLimit] ${decision.key} limited at ${info.path} (${decision.limit}/min ${kindText}) ip=${info.ip || "-"}`);
  if (decision.subject === "anonymous") return true;
  const who = decision.subject === "token" ? `API 令牌「${info.tokenName || "?"}」` : `用户 #${info.userId} `;
  void import("./ops/panelEvents")
    .then(({ recordPanelEvent }) => recordPanelEvent({
      kind: "security.api_rate_limited",
      level: "warn",
      userId: info.userId ?? null,
      message: `${who}触发接口限流：每分钟${kindText}超过 ${decision.limit} 次（${info.path}）`,
      data: { subject: decision.subject, key: subjectKey, path: info.path, limit: decision.limit, ip: info.ip || null },
    }))
    .catch(() => {});
  return true;
}

/** 测试用。 */
export function resetApiRateLimitNotifyForTests() {
  notifiedAt.clear();
}
