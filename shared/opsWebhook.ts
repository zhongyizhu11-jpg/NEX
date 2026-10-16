/*
  Webhook 通知（设置 › Webhook）前后端共用的定义：分几类、每类对应哪些事件、级别怎么比。

  事件按 kind 前缀归类（见 server/ops/panelEvents.ts 的 PanelEventKind）。不属于任何一类的
  事件（ops.* 这类面板自己的运维记录）不推送。
*/
import type { OpsEventLevel } from "./opsEvents";

export type WebhookCategoryKey = "host" | "user" | "rule" | "account" | "security" | "ticket";

export const WEBHOOK_CATEGORIES: ReadonlyArray<{
  key: WebhookCategoryKey;
  label: string;
  description: string;
  prefixes: readonly string[];
}> = [
  { key: "host", label: "主机上下线与重启", description: "主机断线、恢复、机器重启、Agent 重启、自动换 IP。", prefixes: ["host."] },
  { key: "user", label: "用户流量与到期", description: "用户流量用完、快到期、已到期。", prefixes: ["user."] },
  { key: "rule", label: "规则与线路异常", description: "规则出错和恢复、线路组与转发组切换。", prefixes: ["rule.", "route."] },
  { key: "account", label: "登录与安全", description: "管理员登录、同一 IP 连续登录失败。", prefixes: ["account."] },
  { key: "security", label: "安全巡检", description: "主机安全巡检发现的问题。", prefixes: ["security."] },
  { key: "ticket", label: "工单", description: "用户新建工单、回复工单。", prefixes: ["ticket."] },
];

export const WEBHOOK_CATEGORY_KEYS: readonly WebhookCategoryKey[] = WEBHOOK_CATEGORIES.map((category) => category.key);

/** 默认全开：填了地址、打开开关就能收到，不用再去勾。 */
export const DEFAULT_WEBHOOK_CATEGORIES: readonly WebhookCategoryKey[] = WEBHOOK_CATEGORY_KEYS;

export const WEBHOOK_LEVEL_OPTIONS: ReadonlyArray<{ value: OpsEventLevel; label: string; description: string }> = [
  { value: "info", label: "全部", description: "恢复、登录这类普通消息也推送" },
  { value: "warn", label: "警告及以上", description: "只推断线、出错、流量用完这类" },
  { value: "crit", label: "只推严重", description: "只推最要紧的" },
];

const LEVEL_RANK: Record<OpsEventLevel, number> = { info: 0, warn: 1, crit: 2 };

export function normalizeWebhookLevel(value: unknown, fallback: OpsEventLevel = "info"): OpsEventLevel {
  return value === "info" || value === "warn" || value === "crit" ? value : fallback;
}

export function webhookLevelAtLeast(level: unknown, minimum: unknown): boolean {
  return LEVEL_RANK[normalizeWebhookLevel(level)] >= LEVEL_RANK[normalizeWebhookLevel(minimum)];
}

/** 这个 kind 属于哪一类；哪类都不属于返回 null。 */
export function webhookCategoryOf(kind: unknown): WebhookCategoryKey | null {
  const text = String(kind || "");
  for (const category of WEBHOOK_CATEGORIES) {
    if (category.prefixes.some((prefix) => text.startsWith(prefix))) return category.key;
  }
  return null;
}

/** 存成逗号分隔；认不出的项丢掉、去重，保持固定顺序。 */
export function parseWebhookCategories(raw: unknown): WebhookCategoryKey[] {
  if (raw === null || raw === undefined) return [...DEFAULT_WEBHOOK_CATEGORIES];
  const values = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
  const wanted = new Set(values.map((value) => value.trim()));
  return WEBHOOK_CATEGORY_KEYS.filter((key) => wanted.has(key));
}

/** 一条事件要不要推：分类开着，并且级别够。 */
export function shouldDeliverWebhookEvent(
  event: { kind: string; level: unknown },
  filter: { categories: readonly WebhookCategoryKey[]; minLevel: unknown },
): boolean {
  const category = webhookCategoryOf(event.kind);
  if (!category || !filter.categories.includes(category)) return false;
  return webhookLevelAtLeast(event.level, filter.minLevel);
}
