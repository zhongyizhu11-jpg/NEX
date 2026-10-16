/*
  Discord 通知机器人：只用 REST 发私信，不连 Gateway（面板不需要收消息，也就不用常驻 WebSocket、
  不用申请任何 Privileged Intent）。

  发一条私信要两步：
    POST /users/@me/channels { recipient_id }    → 拿到（或建出）和这个人的私信频道 ID
    POST /channels/{id}/messages { content, … }  → 发消息
  私信频道是固定的，ID 按「机器人 + 用户」缓存在内存里，第二条起只要一步。

  出错怎么办：
  - 429：按 Discord 给的 retry_after（JSON 里，或 Retry-After 头）等一会儿再发，最多等 30 秒、重试两次。
  - 403（50007 Cannot send messages to this user 之类）：对方关了私信，或者和机器人没有共同服务器。
    这是「这个人收不到」，不是通道坏了 —— 调用方记下来、跳过这个人，并在他的账号设置里提示。
  - 401：Token 失效（被重置了）。重试没用，调用方关掉 Discord 通知并写面板日志，等管理员换 Token。
  - 404 Unknown Channel：缓存的频道没了，扔掉缓存重新建一次。
  Token 只放在请求头里，不进日志、不进错误信息。
*/
import crypto from "node:crypto";
import { setBoundedMapValue } from "./boundedCache";
import type { FetchLike } from "./googleOidc";
import { DISCORD_MESSAGE_MAX_LENGTH, truncateDiscordText } from "./discordText";

export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const DISCORD_RETRY_AFTER_MAX_MS = 30_000;
const DISCORD_HTTP_TIMEOUT_MS = 15_000;
const DISCORD_DM_CHANNEL_CACHE_MAX = 10_000;
/** 消息 flags：SUPPRESS_EMBEDS（1 << 2），通知里的链接不展开预览卡片。 */
const SUPPRESS_EMBEDS = 1 << 2;

/** Discord REST 返回非 2xx 时抛的错误：带上 HTTP 状态、Discord 的错误码和 429 的等待时间。 */
export class DiscordApiError extends Error {
  constructor(
    public readonly route: string,
    public readonly status: number,
    public readonly code: number | null,
    message: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

/** Token 失效：要等管理员换 Token。 */
export function isDiscordUnauthorizedError(error: unknown) {
  return error instanceof DiscordApiError && error.status === 401;
}

/**
 * 是不是「这个收件人收不到」：403（对方关了私信 / 没有共同服务器 / 把机器人屏蔽了），
 * 或者 Discord 说这个用户不存在、不能当收件人（10013 Unknown User、50033 Invalid Recipient）。
 */
export function isDiscordRecipientError(error: unknown) {
  if (!(error instanceof DiscordApiError)) return false;
  if (error.status === 403) return true;
  return error.code === 10013 || error.code === 50033 || error.code === 50007;
}

/** 429 该等多久（毫秒）。retry_after 是秒（可以带小数）；Retry-After 头也是秒。 */
export function discordRetryAfterMs(response: Pick<Response, "headers">, body: any) {
  const fromBody = Number(body?.retry_after);
  const fromHeader = Number(response.headers.get("retry-after"));
  const seconds = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 1;
  return Math.min(DISCORD_RETRY_AFTER_MAX_MS, Math.max(250, Math.ceil(seconds * 1000)));
}

export type DiscordRestClientOptions = {
  token: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** 429 最多重试几次。 */
  maxRateLimitRetries?: number;
  baseUrl?: string;
};

export class DiscordRestClient {
  private readonly dmChannels = new Map<string, string>();
  readonly tokenFingerprint: string;

  constructor(private readonly options: DiscordRestClientOptions) {
    this.tokenFingerprint = crypto.createHash("sha256").update(options.token).digest("hex").slice(0, 16);
  }

  private sleep(ms: number) {
    return (this.options.sleep || ((wait) => new Promise<void>((resolve) => setTimeout(resolve, wait))))(ms);
  }

  get cachedChannelCount() {
    return this.dmChannels.size;
  }

  async request<T = any>(method: "GET" | "POST", path: string, body?: unknown, route = path): Promise<T> {
    const maxRetries = this.options.maxRateLimitRetries ?? 2;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await (this.options.fetchImpl || fetch)(`${this.options.baseUrl || DISCORD_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bot ${this.options.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            // Discord 要求的 User-Agent 格式：DiscordBot ($url, $version)
            "User-Agent": "DiscordBot (https://github.com/zhongyizhu11-jpg/NEX, 1.0)",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(DISCORD_HTTP_TIMEOUT_MS),
        });
      } catch (error) {
        throw new DiscordApiError(route, 0, null, `Discord ${route} unreachable: ${error instanceof Error ? error.name : "error"}`);
      }
      const data: any = response.status === 204 ? null : await response.json().catch(() => null);
      if (response.ok) return data as T;
      const code = Number.isFinite(Number(data?.code)) ? Number(data.code) : null;
      // Discord 的错误体是 { message, code }，不含 Token
      const reason = typeof data?.message === "string" ? data.message.slice(0, 120) : `http_${response.status}`;
      if (response.status === 429) {
        const waitMs = discordRetryAfterMs(response, data);
        if (attempt < maxRetries) {
          await this.sleep(waitMs);
          continue;
        }
        throw new DiscordApiError(route, 429, code, `Discord ${route} rate limited: ${reason}`, waitMs);
      }
      throw new DiscordApiError(route, response.status, code, `Discord ${route} ${response.status}${code ? `/${code}` : ""}: ${reason}`);
    }
  }

  /** 机器人自己是谁（保存 Token 时验一下真假，顺便拿名字显示）。 */
  async getCurrentBot() {
    const me = await this.request<{ id?: string; username?: string; bot?: boolean }>("GET", "/users/@me", undefined, "users/@me");
    return { id: String(me?.id || ""), username: String(me?.username || "").slice(0, 64), bot: me?.bot === true };
  }

  /** 和这个人的私信频道 ID（缓存）。 */
  async openDmChannel(recipientId: string) {
    const cached = this.dmChannels.get(recipientId);
    if (cached) return cached;
    const channel = await this.request<{ id?: string }>("POST", "/users/@me/channels", { recipient_id: recipientId }, "users/@me/channels");
    const id = String(channel?.id || "");
    if (!/^[0-9]{5,32}$/.test(id)) throw new DiscordApiError("users/@me/channels", 500, null, "Discord returned no DM channel id");
    setBoundedMapValue(this.dmChannels, recipientId, id, DISCORD_DM_CHANNEL_CACHE_MAX);
    return id;
  }

  forgetDmChannel(recipientId: string) {
    this.dmChannels.delete(recipientId);
  }

  /** 给这个 Discord 用户发一条私信（纯文字 / Markdown，不提醒任何人，不展开链接预览）。 */
  async sendDirectMessage(recipientId: string, content: string) {
    const text = truncateDiscordText(String(content || "").trim() || "（空消息）", DISCORD_MESSAGE_MAX_LENGTH);
    const payload = { content: text, allowed_mentions: { parse: [] as string[] }, flags: SUPPRESS_EMBEDS };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const channelId = await this.openDmChannel(recipientId);
      try {
        return await this.request<{ id?: string }>("POST", `/channels/${channelId}/messages`, payload, "channels/{id}/messages");
      } catch (error) {
        // 缓存的频道失效了（10003 Unknown Channel）：扔掉重新建一次
        if (attempt === 0 && error instanceof DiscordApiError && (error.code === 10003 || error.status === 404)) {
          this.forgetDmChannel(recipientId);
          continue;
        }
        throw error;
      }
    }
    throw new DiscordApiError("channels/{id}/messages", 404, 10003, "Discord DM channel unavailable");
  }
}

let sharedClient: DiscordRestClient | null = null;

/** 按 Token 复用一个客户端（私信频道缓存跟着 Token 走：换了机器人，缓存自然作废）。 */
export function getDiscordRestClient(token: string, fetchImpl?: FetchLike) {
  const fingerprint = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  if (!sharedClient || sharedClient.tokenFingerprint !== fingerprint || fetchImpl) {
    sharedClient = new DiscordRestClient({ token, fetchImpl });
  }
  return sharedClient;
}
