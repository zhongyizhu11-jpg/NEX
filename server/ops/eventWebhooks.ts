/*
  事件推送：把事件时间线（panelEvents）里记的事，一件一条 JSON 推给管理员配的接收地址。
  给程序用（n8n、Home Assistant、自己的脚本），不是聊天通知 —— 那个在 webhooks.ts。
  签名、重试、队列在 eventWebhookDelivery.ts；这个文件管配置和「哪件事发给谁」。

  ── 挂在哪 ──
  recordPanelEvent 是所有事件落库的唯一入口，落库后会叫 onPanelEvent 注册的监听器。
  这里只挂一个监听器，业务代码一行不用动；以后谁记了新事件，订阅了那一类的地址自动收到。

  ── 关着时零开销 ──
  默认关。总开关没开、或者没有一个启用的地址时，监听器看一眼内存里的快照就返回：
  不查库、不排队、不挂定时器。快照在保存设置时当场刷新；另外每分钟最多重读一次
  （走设置的内存缓存），照顾「恢复了一份备份」这种绕过保存接口的改动。

  ── 存哪 ──
  system_settings 里两个键：总开关，和全部地址的 JSON（地址、密钥、订阅类别）。后者登记在
  settingsSecretKeys.ts 里，落库是整段密文 —— 签名密钥是密钥，接收地址本身也常常带着令牌
  （Home Assistant 的 webhook id 就在路径里）。读出来给界面时密钥只留末四位。
  不单开一张表：最多十个地址，读多写少，跟着设置一起备份、迁移。
  投递记录只在内存里留最近二十次，面板重启就清空：它是排障用的，不是流水。

  ── 内网地址 ──
  这里故意不做 SSRF 拦截（和 webhooks.ts 相反）：自建用户就是要推到内网的 n8n / Home Assistant。
  代价是「能配这个的人能让面板往内网任意地址发 POST」，所以：只有管理员能配、只能在网页上配
  （API 令牌整个碰不到 ops.eventWebhooks.*，见 apiTokenPolicy.ts）、不跟重定向、每次改动进操作审计。
*/
import crypto from "node:crypto";
import { appendPanelLog } from "../_core/panelLogger";
import { getAllSettings, setSetting } from "../repositories/settingsRepository";
import { getHostNamesByIds } from "../repositories/hostRepository";
import { getUserDisplayNamesByIds } from "../repositories/userRepository";
import {
  EVENT_WEBHOOK_MAX_ENDPOINTS,
  EVENT_WEBHOOK_SECRET_MAX_LENGTH,
  EVENT_WEBHOOK_SECRET_MIN_LENGTH,
  EVENT_WEBHOOK_TEST_TYPE,
  eventWebhookCategoryOf,
  eventWebhookUrlLabel,
  normalizeEventWebhookCategories,
  type EventWebhookCategory,
} from "../../shared/eventWebhook";
import {
  EVENT_WEBHOOK_QUEUE_MAX,
  EventWebhookQueue,
  parseEventWebhookUrl,
  postEventWebhook,
  type EventWebhookAttemptResult,
  type EventWebhookDeliveryRecord,
  type EventWebhookPayload,
} from "./eventWebhookDelivery";
import { onPanelEvent, type PanelEvent } from "./panelEvents";

export const EVENT_WEBHOOKS_ENABLED_SETTING_KEY = "ops.eventWebhooks.enabled";
export const EVENT_WEBHOOKS_ENDPOINTS_SETTING_KEY = "ops.eventWebhooks.endpoints";

const SNAPSHOT_TTL_MS = 60_000;
const LOG_THROTTLE_MS = 60_000;

type StoredEndpoint = {
  id: string;
  url: string;
  secret: string;
  categories: EventWebhookCategory[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

type Snapshot = {
  loadedAt: number;
  enabled: boolean;
  endpoints: StoredEndpoint[];
  /** 总开关开着，并且至少有一个启用的地址。false 时监听器什么都不做。 */
  active: boolean;
};

/** 用户填错时抛这个，路由层转成 400；别的错误照常是 500。 */
export class EventWebhookInputError extends Error {}

function parseEndpoints(raw: string | null | undefined): StoredEndpoint[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const endpoints: StoredEndpoint[] = [];
  for (const item of parsed as Array<Record<string, unknown> | null>) {
    const id = String(item?.id || "");
    const url = String(item?.url || "");
    const secret = String(item?.secret || "");
    if (!/^[0-9a-f]{8,32}$/.test(id) || !url || !secret) continue;
    endpoints.push({
      id,
      url,
      secret,
      categories: normalizeEventWebhookCategories(item?.categories),
      enabled: item?.enabled === true,
      createdAt: Number(item?.createdAt) || 0,
      updatedAt: Number(item?.updatedAt) || 0,
    });
    if (endpoints.length >= EVENT_WEBHOOK_MAX_ENDPOINTS) break;
  }
  return endpoints;
}

let snapshot: Snapshot | null = null;
let snapshotLoad: Promise<Snapshot> | null = null;

async function loadSnapshot(force = false): Promise<Snapshot> {
  if (!force && snapshot && Date.now() - snapshot.loadedAt < SNAPSHOT_TTL_MS) return snapshot;
  if (!force && snapshotLoad) return snapshotLoad;
  const load = (async () => {
    const settings = await getAllSettings();
    const enabled = settings[EVENT_WEBHOOKS_ENABLED_SETTING_KEY] === "true";
    const endpoints = parseEndpoints(settings[EVENT_WEBHOOKS_ENDPOINTS_SETTING_KEY]);
    const next: Snapshot = { loadedAt: Date.now(), enabled, endpoints, active: enabled && endpoints.some((endpoint) => endpoint.enabled) };
    snapshot = next;
    return next;
  })();
  snapshotLoad = load;
  try {
    return await load;
  } finally {
    if (snapshotLoad === load) snapshotLoad = null;
  }
}

// ---------- 投递 ----------

const lastLogAt = new Map<string, number>();

/** 同一类日志一分钟一条：接收方挂了一天，面板日志不该被同一句话刷满。 */
function logThrottled(key: string, message: string) {
  const now = Date.now();
  if (now - (lastLogAt.get(key) ?? 0) < LOG_THROTTLE_MS) return;
  lastLogAt.set(key, now);
  appendPanelLog("warn", message);
}

const queue = new EventWebhookQueue({
  resolveTarget: async (endpointId) => {
    const config = await loadSnapshot();
    if (!config.enabled) return null;
    const endpoint = config.endpoints.find((item) => item.id === endpointId);
    return endpoint && endpoint.enabled ? { url: endpoint.url, secret: endpoint.secret } : null;
  },
  onResult: (endpointId, record) => {
    if (record.ok || record.willRetry) return;
    logThrottled(`fail:${endpointId}`, `[EventWebhook] 推送失败（已放弃）type=${record.type} status=${record.status ?? "-"} 第 ${record.attempt} 次 ${record.error || ""}`);
  },
  onDropped: (_endpointId, droppedTotal) => {
    logThrottled("dropped", `[EventWebhook] 推送队列满了（上限 ${EVENT_WEBHOOK_QUEUE_MAX} 条），已丢弃较早的事件，累计 ${droppedTotal} 条`);
  },
});

async function buildPayload(event: PanelEvent): Promise<EventWebhookPayload> {
  const [hostNames, userNames] = await Promise.all([
    event.hostId ? getHostNamesByIds([event.hostId]).catch(() => new Map<number, string>()) : new Map<number, string>(),
    event.userId ? getUserDisplayNamesByIds([event.userId]).catch(() => new Map<number, string>()) : new Map<number, string>(),
  ]);
  return {
    id: `evt_${event.id}`,
    type: event.kind,
    occurredAt: event.createdAt.toISOString(),
    data: {
      level: event.level,
      message: event.message,
      hostId: event.hostId,
      hostName: event.hostId ? hostNames.get(event.hostId) ?? null : null,
      userId: event.userId,
      userName: event.userId ? userNames.get(event.userId) ?? null : null,
      ruleId: event.ruleId,
      // 每种事件自己的字段（见文档的事件清单）；没有就是空对象，接收方不用判空
      detail: event.data ?? {},
    },
  };
}

async function dispatch(event: PanelEvent, config: Snapshot) {
  const category = eventWebhookCategoryOf(event.kind);
  if (!category) return;
  const targets = config.endpoints.filter((endpoint) => endpoint.enabled && endpoint.categories.includes(category));
  if (targets.length === 0) return;
  // 名字只查一次，所有地址收到的是同一份
  const payload = await buildPayload(event);
  for (const endpoint of targets) queue.enqueue(endpoint.id, payload);
}

function handlePanelEvent(event: PanelEvent): void | Promise<void> {
  const current = snapshot;
  if (current && Date.now() - current.loadedAt < SNAPSHOT_TTL_MS) {
    // 关着 / 没配地址的面板，每条事件到这里就结束了
    if (!current.active) return;
    return dispatch(event, current);
  }
  return loadSnapshot().then((fresh) => (fresh.active ? dispatch(event, fresh) : undefined));
}

let installed = false;

/** 挂到事件时间线上。重复调用无副作用。 */
export function installEventWebhookDispatch() {
  if (installed) return;
  installed = true;
  onPanelEvent(handlePanelEvent);
}

// ---------- 配置 ----------

/** 给界面看的密钥：只留末四位（密钥至少 16 位，露四位不够猜）。 */
export function maskEventWebhookSecret(secret: string): string {
  return `••••${secret.slice(-4)}`;
}

export type EventWebhookEndpointView = {
  id: string;
  url: string;
  urlLabel: string;
  secretHint: string;
  categories: EventWebhookCategory[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** 正在排队 / 等重试的条数。 */
  pending: number;
  /** 队列满时被丢掉的条数（面板启动以来）。 */
  dropped: number;
  /** 最近的投递结果，新的在前。 */
  recent: EventWebhookDeliveryRecord[];
};

function endpointView(endpoint: StoredEndpoint): EventWebhookEndpointView {
  return {
    id: endpoint.id,
    url: endpoint.url,
    urlLabel: eventWebhookUrlLabel(endpoint.url),
    secretHint: maskEventWebhookSecret(endpoint.secret),
    categories: endpoint.categories,
    enabled: endpoint.enabled,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
    pending: queue.pendingOf(endpoint.id),
    dropped: queue.droppedOf(endpoint.id),
    recent: queue.recent(endpoint.id),
  };
}

export async function getEventWebhooksView() {
  const config = await loadSnapshot();
  return {
    enabled: config.enabled,
    endpoints: config.endpoints.map(endpointView),
    queue: queue.stats(),
    maxEndpoints: EVENT_WEBHOOK_MAX_ENDPOINTS,
  };
}

/* 改配置是「读出来、改、整段写回」：两次保存交错会互相盖掉，排成一队做。 */
let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = writeChain.then(work, work);
  writeChain = next.catch(() => undefined);
  return next;
}

async function writeEndpoints(endpoints: StoredEndpoint[]) {
  await setSetting(EVENT_WEBHOOKS_ENDPOINTS_SETTING_KEY, endpoints.length > 0 ? JSON.stringify(endpoints) : null);
  await loadSnapshot(true);
}

function normalizeSecret(raw: unknown): string {
  const secret = String(raw ?? "").trim();
  if (secret.length < EVENT_WEBHOOK_SECRET_MIN_LENGTH) throw new EventWebhookInputError(`签名密钥至少 ${EVENT_WEBHOOK_SECRET_MIN_LENGTH} 个字符`);
  if (secret.length > EVENT_WEBHOOK_SECRET_MAX_LENGTH) throw new EventWebhookInputError(`签名密钥最多 ${EVENT_WEBHOOK_SECRET_MAX_LENGTH} 个字符`);
  return secret;
}

function normalizeUrl(raw: unknown): string {
  try {
    return parseEventWebhookUrl(raw).toString();
  } catch (error) {
    throw new EventWebhookInputError(error instanceof Error ? error.message : String(error));
  }
}

export type SaveEventWebhookInput = {
  /** 不给 = 新建。 */
  id?: string | null;
  url: string;
  /** 新建时必填；修改时不给或留空 = 不换密钥（界面拿不到明文，没法原样传回来）。 */
  secret?: string | null;
  categories: readonly string[];
  enabled: boolean;
};

export function saveEventWebhookEndpoint(input: SaveEventWebhookInput) {
  return serialized(async () => {
    const url = normalizeUrl(input.url);
    const categories = normalizeEventWebhookCategories(input.categories);
    if (categories.length === 0) throw new EventWebhookInputError("至少订阅一类事件");
    const endpoints = [...(await loadSnapshot(true)).endpoints];
    const now = Date.now();
    let id = String(input.id || "");
    if (id) {
      const index = endpoints.findIndex((endpoint) => endpoint.id === id);
      if (index < 0) throw new EventWebhookInputError("这个接收地址已经不存在了，请刷新");
      const secret = String(input.secret ?? "").trim() ? normalizeSecret(input.secret) : endpoints[index].secret;
      endpoints[index] = { ...endpoints[index], url, secret, categories, enabled: input.enabled, updatedAt: now };
    } else {
      if (endpoints.length >= EVENT_WEBHOOK_MAX_ENDPOINTS) throw new EventWebhookInputError(`接收地址最多 ${EVENT_WEBHOOK_MAX_ENDPOINTS} 个`);
      id = crypto.randomBytes(6).toString("hex");
      endpoints.push({ id, url, secret: normalizeSecret(input.secret), categories, enabled: input.enabled, createdAt: now, updatedAt: now });
    }
    await writeEndpoints(endpoints);
    // 停用了：排着队等重试的那些也不发了
    if (!input.enabled) queue.discard(id);
    return getEventWebhooksView();
  });
}

export function removeEventWebhookEndpoint(id: string) {
  return serialized(async () => {
    const endpoints = (await loadSnapshot(true)).endpoints;
    const next = endpoints.filter((endpoint) => endpoint.id !== id);
    if (next.length !== endpoints.length) await writeEndpoints(next);
    queue.forget(id);
    return getEventWebhooksView();
  });
}

export function setEventWebhooksEnabled(enabled: boolean) {
  return serialized(async () => {
    await setSetting(EVENT_WEBHOOKS_ENABLED_SETTING_KEY, enabled ? "true" : "false");
    const config = await loadSnapshot(true);
    if (!enabled) for (const endpoint of config.endpoints) queue.discard(endpoint.id);
    return getEventWebhooksView();
  });
}

/**
 * 「发一条测试事件」：只发给这一个地址，只发一次不重试，结果直接返回（也记进最近投递）。
 * 不看总开关和这个地址的启用状态 —— 就是为了在打开之前先确认接收方验签能过。
 */
export async function sendEventWebhookTest(id: string): Promise<EventWebhookAttemptResult> {
  const endpoint = (await loadSnapshot()).endpoints.find((item) => item.id === id);
  if (!endpoint) throw new EventWebhookInputError("这个接收地址已经不存在了，请刷新");
  const payload: EventWebhookPayload = {
    id: `evt_test_${crypto.randomBytes(8).toString("hex")}`,
    type: EVENT_WEBHOOK_TEST_TYPE,
    occurredAt: new Date().toISOString(),
    data: {
      level: "info",
      message: "这是一条测试事件：收到并且验签通过，就说明地址和密钥都对",
      hostId: null,
      hostName: null,
      userId: null,
      userName: null,
      ruleId: null,
      detail: {},
    },
  };
  const result = await postEventWebhook({ url: endpoint.url, secret: endpoint.secret }, payload);
  queue.record(endpoint.id, {
    eventId: payload.id,
    type: payload.type,
    at: Date.now(),
    attempt: 1,
    ok: result.ok,
    status: result.status,
    durationMs: result.durationMs,
    error: result.error,
    willRetry: false,
  });
  return result;
}

/** 测试用：队列里没有在排、在发的了。 */
export function eventWebhookQueueIdleForTests() {
  return queue.idle();
}
