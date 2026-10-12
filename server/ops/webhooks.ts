/*
  Webhook 通知：把事件时间线（panelEvents）里的事推到 Discord / Slack / Mattermost / 任意 HTTPS 地址。

  - 设置存在 system_settings 的 ops.webhook.* 里；地址本身就是密钥，只在保存和发送时用，
    读设置的接口只给打码后的样子（maskWebhookUrl）。
  - 出站前过 SSRF 检查（只许 https、不许内网 / 本机地址），每次发送都重新检查一遍：
    域名解析结果会变。不跟随重定向，免得被 302 引到内网去。
  - 攒批：事件进来先排队，3 秒内的合成一条发（一条最多 20 件，多出来的 3 秒后接着发）。
    机房断电一下掉一百台机器，收到的是五条汇总，而不是一百条把频道刷满、再被平台限流。
  - 5 秒超时，失败（网络错误、429、5xx）隔 2 秒重试一次；还失败就写面板日志，丢掉这一批。
    队列最多积 200 件，地址一直不通时不让内存涨上去。
*/
import { appendPanelLog } from "../_core/panelLogger";
import { assertSafeOutboundUrl } from "../ssrf";
import { getAllSettings, setSettings } from "../repositories/settingsRepository";
import { getHostNamesByIds } from "../repositories/hostRepository";
import { getUserDisplayNamesByIds } from "../repositories/userRepository";
import {
  normalizeWebhookLevel,
  parseWebhookCategories,
  shouldDeliverWebhookEvent,
  type WebhookCategoryKey,
} from "../../shared/opsWebhook";
import type { OpsEventLevel } from "../../shared/opsEvents";
import { onPanelEvent, type PanelEvent } from "./panelEvents";
import {
  buildWebhookPayload,
  detectWebhookFormat,
  maskWebhookUrl,
  WEBHOOK_FORMAT_LABELS,
  type WebhookEventItem,
  type WebhookFormat,
} from "./webhookFormat";

const KEY_ENABLED = "ops.webhook.enabled";
const KEY_URL = "ops.webhook.url";
const KEY_CATEGORIES = "ops.webhook.categories";
const KEY_MIN_LEVEL = "ops.webhook.minLevel";

const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 2_000;
const BATCH_WINDOW_MS = 3_000;
const MAX_EVENTS_PER_POST = 20;
const MAX_QUEUE = 200;
export const WEBHOOK_URL_MAX_LENGTH = 2048;

export type WebhookConfig = {
  enabled: boolean;
  url: string;
  categories: WebhookCategoryKey[];
  minLevel: OpsEventLevel;
};

export async function readWebhookConfig(): Promise<WebhookConfig> {
  const settings = await getAllSettings().catch(() => ({} as Record<string, string | null>));
  return {
    enabled: settings[KEY_ENABLED] === "true",
    url: String(settings[KEY_URL] || "").trim(),
    categories: parseWebhookCategories(settings[KEY_CATEGORIES] ?? null),
    minLevel: normalizeWebhookLevel(settings[KEY_MIN_LEVEL], "info"),
  };
}

/** 给前端看的那一份：地址打码，另外告诉它认出来是什么平台。 */
export async function getWebhookSettingsView() {
  const config = await readWebhookConfig();
  const format = config.url ? detectWebhookFormat(config.url) : null;
  return {
    enabled: config.enabled,
    configured: !!config.url,
    urlMasked: maskWebhookUrl(config.url),
    format,
    formatLabel: format ? WEBHOOK_FORMAT_LABELS[format] : null,
    categories: config.categories,
    minLevel: config.minLevel,
  };
}

/** 只许 https，过 SSRF 检查。返回规整后的地址；不合格抛出一句给人看的错。 */
export async function validateWebhookUrl(raw: string): Promise<string> {
  const text = String(raw || "").trim();
  if (!text) throw new Error("请填写 Webhook 地址");
  if (text.length > WEBHOOK_URL_MAX_LENGTH) throw new Error("Webhook 地址太长");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Webhook 地址格式不对");
  }
  if (url.protocol !== "https:") throw new Error("Webhook 地址必须以 https:// 开头");
  await assertSafeOutboundUrl(url.toString(), { purpose: "Webhook" });
  return url.toString();
}

export type SaveWebhookInput = {
  enabled: boolean;
  /** undefined：不改地址；空串：清掉地址；其它：换成新地址。 */
  url?: string | null;
  categories: WebhookCategoryKey[];
  minLevel: OpsEventLevel;
};

export async function saveWebhookSettings(input: SaveWebhookInput) {
  const current = await readWebhookConfig();
  let url = current.url;
  if (input.url !== undefined && input.url !== null) {
    url = input.url.trim() ? await validateWebhookUrl(input.url) : "";
  }
  if (input.enabled && !url) throw new Error("请先填写 Webhook 地址再打开");
  await setSettings({
    [KEY_ENABLED]: input.enabled ? "true" : "false",
    [KEY_URL]: url || null,
    [KEY_CATEGORIES]: parseWebhookCategories(input.categories).join(","),
    [KEY_MIN_LEVEL]: normalizeWebhookLevel(input.minLevel),
  });
  return getWebhookSettingsView();
}

export type WebhookSendResult = {
  ok: boolean;
  status: number | null;
  error: string | null;
  format: WebhookFormat;
};

function retriable(result: WebhookSendResult) {
  return !result.ok && (result.status === null || result.status === 429 || result.status >= 500);
}

async function postOnce(url: string, payload: Record<string, unknown>, format: WebhookFormat): Promise<WebhookSendResult> {
  try {
    await assertSafeOutboundUrl(url, { purpose: "Webhook" });
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error), format };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "NEX-Panel-Webhook" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: true, status: response.status, error: null, format };
    }
    const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
    const redirected = response.status >= 300 && response.status < 400 ? "对方要求跳转到别的地址（不跟随）" : "";
    return { ok: false, status: response.status, error: redirected || body || `HTTP ${response.status}`, format };
  } catch (error) {
    const name = (error as any)?.name;
    const message = name === "TimeoutError" || name === "AbortError"
      ? `${REQUEST_TIMEOUT_MS / 1000} 秒内没有响应`
      : error instanceof Error ? error.message : String(error);
    return { ok: false, status: null, error: message, format };
  }
}

async function postWithRetry(url: string, payload: Record<string, unknown>, format: WebhookFormat) {
  const first = await postOnce(url, payload, format);
  if (!retriable(first)) return first;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, RETRY_DELAY_MS);
    timer.unref?.();
  });
  return postOnce(url, payload, format);
}

async function toItems(events: readonly PanelEvent[]): Promise<WebhookEventItem[]> {
  const hostIds = events.map((event) => event.hostId).filter((id): id is number => !!id);
  const userIds = events.map((event) => event.userId).filter((id): id is number => !!id);
  const [hostNames, userNames] = await Promise.all([
    hostIds.length ? getHostNamesByIds(hostIds).catch(() => new Map<number, string>()) : new Map<number, string>(),
    userIds.length ? getUserDisplayNamesByIds(userIds).catch(() => new Map<number, string>()) : new Map<number, string>(),
  ]);
  return events.map((event) => ({
    time: event.createdAt,
    level: event.level,
    kind: event.kind,
    message: event.message,
    host: event.hostId ? hostNames.get(event.hostId) || `#${event.hostId}` : null,
    user: event.userId ? userNames.get(event.userId) || `#${event.userId}` : null,
  }));
}

/** 「发送测试」：可以先测还没保存的新地址（url 不给就用已保存的）。 */
export async function sendWebhookTest(urlOverride?: string | null): Promise<WebhookSendResult> {
  const config = await readWebhookConfig();
  const url = urlOverride && urlOverride.trim() ? await validateWebhookUrl(urlOverride) : config.url;
  if (!url) throw new Error("请先填写 Webhook 地址");
  const format = detectWebhookFormat(url);
  const payload = buildWebhookPayload(format, [{
    time: new Date(),
    level: "info",
    kind: "ops.webhook_test",
    message: "这是一条测试消息，Webhook 已接通",
    host: null,
    user: null,
  }]);
  const result = await postOnce(url, payload, format);
  if (!result.ok) appendPanelLog("warn", `[Webhook] 测试发送失败 status=${result.status ?? "-"} ${result.error || ""}`);
  return result;
}

// ---------------- 投递队列 ----------------

const queue: PanelEvent[] = [];
let droppedSinceLastLog = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function scheduleFlush(delayMs = BATCH_WINDOW_MS) {
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, delayMs);
  flushTimer.unref?.();
}

async function flushQueue() {
  flushing = true;
  try {
    if (droppedSinceLastLog > 0) {
      appendPanelLog("warn", `[Webhook] 推送积压，丢弃了 ${droppedSinceLastLog} 条较早的事件`);
      droppedSinceLastLog = 0;
    }
    const batch = queue.splice(0, MAX_EVENTS_PER_POST);
    if (batch.length === 0) return;
    const config = await readWebhookConfig();
    if (!config.enabled || !config.url) {
      queue.length = 0;
      return;
    }
    const format = detectWebhookFormat(config.url);
    const payload = buildWebhookPayload(format, await toItems(batch));
    const result = await postWithRetry(config.url, payload, format);
    if (!result.ok) {
      appendPanelLog("warn", `[Webhook] 推送失败（${batch.length} 条事件）status=${result.status ?? "-"} ${result.error || ""}`);
    }
  } catch (error) {
    appendPanelLog("warn", `[Webhook] 推送出错：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    flushing = false;
    if (queue.length > 0) scheduleFlush();
  }
}

async function handlePanelEvent(event: PanelEvent) {
  const config = await readWebhookConfig();
  if (!config.enabled || !config.url) return;
  if (!shouldDeliverWebhookEvent(event, config)) return;
  queue.push(event);
  while (queue.length > MAX_QUEUE) {
    queue.shift();
    droppedSinceLastLog += 1;
  }
  scheduleFlush();
}

let installed = false;

/** 挂到事件时间线上。重复调用无副作用。 */
export function installWebhookDelivery() {
  if (installed) return;
  installed = true;
  onPanelEvent(handlePanelEvent);
}
