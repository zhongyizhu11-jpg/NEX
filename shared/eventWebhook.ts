/*
  事件推送（设置 › 进阶 › 事件推送）前后端共用的定义：事件分几类、请求头叫什么、各种上限。

  和「设置 › Webhook」那个不是一回事：那边是把告警排成一条聊天消息发到 Discord / Slack 给人看；
  这边是给程序用的 —— 每件事一条固定结构的 JSON，带签名，接收方（n8n、Home Assistant、自己写的脚本）
  验签后按 type 分支处理。

  事件就是事件时间线（server/ops/panelEvents.ts）里记的那些，类别 = kind 里第一个点前面的那一段。
  新功能记了新的 kind，只要前缀在下面这张表里，订阅了那一类的地址自动就能收到，不用来这里登记。
*/

export const EVENT_WEBHOOK_CATEGORIES = [
  { key: "host", label: "主机", description: "上线、离线、重启、换 IP、资源告警" },
  { key: "route", label: "线路", description: "线路切换、异常与恢复" },
  { key: "rule", label: "规则", description: "规则出错与恢复" },
  { key: "user", label: "用户", description: "流量用完、快到期、已到期" },
  { key: "account", label: "登录与账号", description: "管理员登录、连续登录失败、新设备" },
  { key: "security", label: "安全", description: "封禁 IP、地区规则、巡检发现、接口限流" },
  { key: "ticket", label: "工单", description: "新建、回复" },
  { key: "ops", label: "面板运维", description: "维护模式、异地备份、全部重启" },
] as const;

export type EventWebhookCategory = (typeof EVENT_WEBHOOK_CATEGORIES)[number]["key"];

export const EVENT_WEBHOOK_CATEGORY_KEYS: readonly EventWebhookCategory[] = EVENT_WEBHOOK_CATEGORIES.map((category) => category.key);

/** 新建地址时默认勾上的：做自动化最常用的三类。 */
export const EVENT_WEBHOOK_DEFAULT_CATEGORIES: readonly EventWebhookCategory[] = ["host", "route", "rule"];

/** 「发一条测试事件」用的 type。不属于任何类别，只会发给点了测试的那个地址。 */
export const EVENT_WEBHOOK_TEST_TYPE = "webhook.test";

export const EVENT_WEBHOOK_TIMESTAMP_HEADER = "X-NEX-Timestamp";
export const EVENT_WEBHOOK_SIGNATURE_HEADER = "X-NEX-Signature";
export const EVENT_WEBHOOK_EVENT_HEADER = "X-NEX-Event";
export const EVENT_WEBHOOK_DELIVERY_HEADER = "X-NEX-Delivery";
/** 签名头的值是 "sha256=" 加十六进制的 HMAC。 */
export const EVENT_WEBHOOK_SIGNATURE_PREFIX = "sha256=";

export const EVENT_WEBHOOK_MAX_ENDPOINTS = 10;
export const EVENT_WEBHOOK_URL_MAX_LENGTH = 2048;
export const EVENT_WEBHOOK_SECRET_MIN_LENGTH = 16;
export const EVENT_WEBHOOK_SECRET_MAX_LENGTH = 128;

/** 这个 kind 属于哪一类；前缀不在表里返回 null（不推送）。 */
export function eventWebhookCategoryOf(kind: unknown): EventWebhookCategory | null {
  const text = String(kind || "");
  const dot = text.indexOf(".");
  if (dot <= 0) return null;
  const prefix = text.slice(0, dot);
  return (EVENT_WEBHOOK_CATEGORY_KEYS as readonly string[]).includes(prefix) ? (prefix as EventWebhookCategory) : null;
}

/** 认不出的丢掉、去重，按表里的顺序排好。 */
export function normalizeEventWebhookCategories(raw: unknown): EventWebhookCategory[] {
  const wanted = new Set((Array.isArray(raw) ? raw : []).map((item) => String(item)));
  return EVENT_WEBHOOK_CATEGORY_KEYS.filter((key) => wanted.has(key));
}

export function eventWebhookCategoriesLabel(categories: readonly EventWebhookCategory[]): string {
  if (categories.length === 0) return "没有订阅任何类别";
  if (categories.length === EVENT_WEBHOOK_CATEGORY_KEYS.length) return "全部类别";
  return EVENT_WEBHOOK_CATEGORIES.filter((category) => categories.includes(category.key)).map((category) => category.label).join("、");
}

/** 给人看的地址：去掉查询串（里面可能带令牌），太长的路径截短。 */
export function eventWebhookUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const shortPath = path.length > 28 ? `${path.slice(0, 12)}…${path.slice(-12)}` : path;
    return `${parsed.host}${shortPath}`;
  } catch {
    return url.slice(0, 48);
  }
}
