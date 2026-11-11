/*
  事件推送的投递部分：签名、发一次、失败重试的内存队列、最近投递记录。
  不碰数据库、不读设置 —— 地址和密钥由调用方（eventWebhooks.ts）在真正要发的那一刻给，
  所以这里能脱离面板单测（起一个本地 HTTP 服务器收一条就行）。

  ── 一次投递长什么样 ──
  POST <地址>，body 是 {"id","type","occurredAt","data"} 的 JSON，请求头：
    X-NEX-Timestamp: 发出时的 Unix 秒
    X-NEX-Signature: sha256=<HMAC-SHA256(密钥, 时间戳 + "." + body) 的十六进制>
    X-NEX-Event / X-NEX-Delivery: 事件类型和事件 id（不用解析 body 就能分流、去重）
  签名把时间戳一起签进去：接收方拒掉时间戳太旧的请求，抓到一条旧请求重放就没用了。
  重试时时间戳和签名都重新算（不然十分钟后的重试会被接收方当成重放），id 不变，接收方按 id 去重。

  ── 不跟重定向 ──
  redirect: "manual"。地址是管理员填的、允许内网；跟着 302 走等于让对方服务器决定面板往哪发请求。
  3xx 记成失败，不重试（重试一百次也还是 3xx）。

  ── 重试 ──
  网络错误、超时、408 / 425 / 429 / 5xx 才重试：这些过一会儿可能就好了。别的 4xx（签名不对、
  地址写错）重试没有意义。间隔 5 秒、30 秒、2 分钟、10 分钟，一共最多发 5 次。
  队列在内存里（面板重启就没了，这是推送不是账本），最多 500 条，满了丢最旧的并计数 ——
  接收方挂了一整天，不能让面板的内存跟着涨。同一个地址同一时刻只发一条，一个慢地址不会被并发打爆，
  也不拖住别的地址。
*/
import crypto from "node:crypto";
import {
  EVENT_WEBHOOK_DELIVERY_HEADER,
  EVENT_WEBHOOK_EVENT_HEADER,
  EVENT_WEBHOOK_SIGNATURE_HEADER,
  EVENT_WEBHOOK_SIGNATURE_PREFIX,
  EVENT_WEBHOOK_TIMESTAMP_HEADER,
  EVENT_WEBHOOK_URL_MAX_LENGTH,
} from "../../shared/eventWebhook";

export const EVENT_WEBHOOK_TIMEOUT_MS = 5_000;
/** 第 n 次失败后隔多久再发；用完就放弃。 */
export const EVENT_WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000];
export const EVENT_WEBHOOK_QUEUE_MAX = 500;
/** 每个地址留最近多少次投递结果给界面看。 */
export const EVENT_WEBHOOK_RECENT_MAX = 20;
const DEFAULT_CONCURRENCY = 4;
const ERROR_SNIPPET_BYTES = 2048;
const ERROR_SNIPPET_CHARS = 200;

export type EventWebhookPayload = {
  id: string;
  type: string;
  /** ISO 8601（UTC）。 */
  occurredAt: string;
  data: Record<string, unknown>;
};

export type EventWebhookTarget = { url: string; secret: string };

export type EventWebhookAttemptResult = {
  ok: boolean;
  /** 没拿到响应（连不上、超时、地址不合法）是 null。 */
  status: number | null;
  durationMs: number;
  error: string | null;
  /** 值不值得过一会儿再试。 */
  retriable: boolean;
};

export type EventWebhookDeliveryRecord = {
  eventId: string;
  type: string;
  /** 这次尝试结束的时间（毫秒）。 */
  at: number;
  /** 第几次尝试，从 1 开始。 */
  attempt: number;
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
  /** 失败了，稍后还会再试。 */
  willRetry: boolean;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 只许 http / https，不许在地址里带账号密码（fetch 也不收这种地址）。不合格抛一句给人看的话。 */
export function parseEventWebhookUrl(raw: unknown): URL {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("请填写接收地址");
  if (text.length > EVENT_WEBHOOK_URL_MAX_LENGTH) throw new Error("接收地址太长");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("接收地址格式不对，要以 http:// 或 https:// 开头");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("接收地址只支持 http:// 和 https://");
  if (!url.hostname) throw new Error("接收地址缺少主机名");
  if (url.username || url.password) throw new Error("接收地址里不能带账号密码，鉴权请用签名密钥");
  url.hash = "";
  return url;
}

/** HMAC-SHA256(密钥, 时间戳 + "." + body)，十六进制。 */
export function signEventWebhook(secret: string, timestamp: string | number, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

/**
 * 接收方该怎么验（文档里 Node / Python 的例子和这个函数是一回事，测试拿它当「按文档实现的接收方」）：
 * 时间戳离现在不超过 toleranceSeconds，签名用恒定时间比较。body 必须是收到的原始字节，不能是解析后再序列化的。
 */
export function verifyEventWebhookSignature(input: {
  secret: string;
  timestamp: unknown;
  signature: unknown;
  body: string;
  toleranceSeconds?: number;
  nowMs?: number;
}): boolean {
  const timestamp = String(Array.isArray(input.timestamp) ? input.timestamp[0] : input.timestamp ?? "");
  const signature = String(Array.isArray(input.signature) ? input.signature[0] : input.signature ?? "");
  if (!/^\d{1,12}$/.test(timestamp) || !signature.startsWith(EVENT_WEBHOOK_SIGNATURE_PREFIX)) return false;
  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs((input.nowMs ?? Date.now()) / 1000 - Number(timestamp)) > tolerance) return false;
  const expected = Buffer.from(signEventWebhook(input.secret, timestamp, input.body), "utf8");
  const given = Buffer.from(signature.slice(EVENT_WEBHOOK_SIGNATURE_PREFIX.length).toLowerCase(), "utf8");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function shouldRetryStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** 失败响应的前一小段正文，给界面当错误提示。只读前 2 KB：对面回一个几百 MB 的页面也不会被整个读进来。 */
async function readSnippet(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size < ERROR_SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } catch {
    // 读到一半断了：有多少算多少
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\s+/g, " ").trim().slice(0, ERROR_SNIPPET_CHARS);
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return `${timeoutMs / 1000} 秒内没有响应`;
  // undici 的错误是一句「fetch failed」，真正的原因（ECONNREFUSED、证书不对）在 cause 里
  const cause = (error as { cause?: unknown } | null)?.cause as { code?: unknown; message?: unknown } | undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const detail = typeof cause?.message === "string" ? cause.message : error instanceof Error ? error.message : String(error);
  return `连不上${code ? `（${code}）` : ""}${detail && detail !== code ? `：${detail.slice(0, 160)}` : ""}`;
}

/** 发一次。永远不抛，结果都在返回值里。 */
export async function postEventWebhook(
  target: EventWebhookTarget,
  payload: EventWebhookPayload,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; now?: () => number } = {},
): Promise<EventWebhookAttemptResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? EVENT_WEBHOOK_TIMEOUT_MS;
  const startedAt = now();
  const finish = (result: Omit<EventWebhookAttemptResult, "durationMs">): EventWebhookAttemptResult => ({
    ...result,
    durationMs: Math.max(0, Math.round(now() - startedAt)),
  });
  let url: URL;
  try {
    // 保存时查过一遍，发之前再查一遍：库里的值可能是导入的备份、手改的
    url = parseEventWebhookUrl(target.url);
  } catch (error) {
    return finish({ ok: false, status: null, error: error instanceof Error ? error.message : String(error), retriable: false });
  }
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(startedAt / 1000));
  try {
    const response = await (options.fetchImpl ?? fetch)(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "NEX-Event-Webhook",
        [EVENT_WEBHOOK_EVENT_HEADER]: payload.type,
        [EVENT_WEBHOOK_DELIVERY_HEADER]: payload.id,
        [EVENT_WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [EVENT_WEBHOOK_SIGNATURE_HEADER]: `${EVENT_WEBHOOK_SIGNATURE_PREFIX}${signEventWebhook(target.secret, timestamp, body)}`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return finish({ ok: true, status: response.status, error: null, retriable: false });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return finish({ ok: false, status: response.status, error: "对方要求跳转到别的地址（不跟随），请直接填最终地址", retriable: false });
    }
    const snippet = await readSnippet(response);
    return finish({ ok: false, status: response.status, error: snippet || `HTTP ${response.status}`, retriable: shouldRetryStatus(response.status) });
  } catch (error) {
    return finish({ ok: false, status: null, error: describeFetchError(error, timeoutMs), retriable: true });
  }
}

type Job = {
  seq: number;
  endpointId: string;
  payload: EventWebhookPayload;
  /** 已经失败过几次。 */
  attempt: number;
  nextAt: number;
};

export type EventWebhookQueueOptions = {
  /**
   * 真正要发的那一刻问一次「这个地址现在发到哪、用什么密钥」。返回 null = 不发了
   * （地址被删、被停用、总开关关了）：排着队等重试的也就此作废。
   */
  resolveTarget: (endpointId: string) => EventWebhookTarget | null | Promise<EventWebhookTarget | null>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  maxQueue?: number;
  concurrency?: number;
  now?: () => number;
  /** 每次尝试出结果后（调用方拿去写日志）。 */
  onResult?: (endpointId: string, record: EventWebhookDeliveryRecord) => void;
  /** 队列满了丢掉一条最旧的之后。 */
  onDropped?: (endpointId: string, droppedTotal: number) => void;
};

export class EventWebhookQueue {
  private jobs: Job[] = [];
  private readonly busy = new Set<string>();
  private running = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private droppedTotal = 0;
  private readonly dropped = new Map<string, number>();
  private readonly records = new Map<string, EventWebhookDeliveryRecord[]>();
  private readonly retryDelays: readonly number[];
  private readonly maxQueue: number;
  private readonly concurrency: number;
  private readonly now: () => number;

  constructor(private readonly options: EventWebhookQueueOptions) {
    this.retryDelays = options.retryDelaysMs ?? EVENT_WEBHOOK_RETRY_DELAYS_MS;
    this.maxQueue = Math.max(1, options.maxQueue ?? EVENT_WEBHOOK_QUEUE_MAX);
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.now = options.now ?? Date.now;
  }

  /** 排一条。队列满了丢最旧的。 */
  enqueue(endpointId: string, payload: EventWebhookPayload) {
    this.jobs.push({ seq: ++this.seq, endpointId, payload, attempt: 0, nextAt: this.now() });
    this.trim();
    this.pump();
  }

  /** 这个地址排着的全部作废（删除、停用时调用），返回作废了几条。 */
  discard(endpointId: string): number {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.endpointId !== endpointId);
    return before - this.jobs.length;
  }

  /** 地址删掉后把它的记录和计数也清掉。 */
  forget(endpointId: string) {
    this.discard(endpointId);
    this.records.delete(endpointId);
    this.dropped.delete(endpointId);
  }

  /** 记一次投递结果（队列自己发的会记；「测试」那种不走队列的由调用方来记）。 */
  record(endpointId: string, record: EventWebhookDeliveryRecord) {
    const list = this.records.get(endpointId) ?? [];
    list.unshift(record);
    if (list.length > EVENT_WEBHOOK_RECENT_MAX) list.length = EVENT_WEBHOOK_RECENT_MAX;
    this.records.set(endpointId, list);
  }

  /** 最近的投递结果，新的在前。 */
  recent(endpointId: string): EventWebhookDeliveryRecord[] {
    return [...(this.records.get(endpointId) ?? [])];
  }

  pendingOf(endpointId: string): number {
    return this.jobs.reduce((count, job) => count + (job.endpointId === endpointId ? 1 : 0), 0) + (this.busy.has(endpointId) ? 1 : 0);
  }

  droppedOf(endpointId: string): number {
    return this.dropped.get(endpointId) ?? 0;
  }

  stats() {
    return { queued: this.jobs.length, sending: this.running, dropped: this.droppedTotal, max: this.maxQueue };
  }

  /** 没有在排的、没有在发的。测试等它。 */
  idle(): boolean {
    return this.jobs.length === 0 && this.running === 0;
  }

  private trim() {
    while (this.jobs.length > this.maxQueue) {
      // 重试的会排回队尾，所以最旧的不一定在最前面：按入队序号找
      let oldest = 0;
      for (let index = 1; index < this.jobs.length; index += 1) {
        if (this.jobs[index].seq < this.jobs[oldest].seq) oldest = index;
      }
      const [job] = this.jobs.splice(oldest, 1);
      this.droppedTotal += 1;
      this.dropped.set(job.endpointId, (this.dropped.get(job.endpointId) ?? 0) + 1);
      this.options.onDropped?.(job.endpointId, this.droppedTotal);
    }
  }

  private pump() {
    const now = this.now();
    let nextDue = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.jobs.length;) {
      const job = this.jobs[index];
      if (job.nextAt > now) {
        nextDue = Math.min(nextDue, job.nextAt);
        index += 1;
        continue;
      }
      // 到点了但轮不上（并发满了，或者这个地址正在发上一条）：在发的那条结束时会再 pump 一次
      if (this.running >= this.concurrency || this.busy.has(job.endpointId)) {
        index += 1;
        continue;
      }
      this.jobs.splice(index, 1);
      this.start(job);
    }
    this.arm(nextDue);
  }

  /** 只在有「还没到点的重试」时留一个定时器；队列空着的时候什么都不挂。 */
  private arm(dueAt: number) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!Number.isFinite(dueAt)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, dueAt - this.now()));
    this.timer.unref?.();
  }

  private start(job: Job) {
    this.running += 1;
    this.busy.add(job.endpointId);
    void this.run(job)
      .catch((error) => console.warn(`[EventWebhook] 投递出错：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.running -= 1;
        this.busy.delete(job.endpointId);
        this.pump();
      });
  }

  private async run(job: Job) {
    const target = await this.options.resolveTarget(job.endpointId);
    if (!target) return;
    const result = await postEventWebhook(target, job.payload, {
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.options.timeoutMs,
      now: this.now,
    });
    const retryDelay = !result.ok && result.retriable ? this.retryDelays[job.attempt] : undefined;
    const record: EventWebhookDeliveryRecord = {
      eventId: job.payload.id,
      type: job.payload.type,
      at: this.now(),
      attempt: job.attempt + 1,
      ok: result.ok,
      status: result.status,
      durationMs: result.durationMs,
      error: result.error,
      willRetry: retryDelay !== undefined,
    };
    this.record(job.endpointId, record);
    this.options.onResult?.(job.endpointId, record);
    if (retryDelay === undefined) return;
    job.attempt += 1;
    job.nextAt = this.now() + retryDelay;
    this.jobs.push(job);
    this.trim();
  }
}
