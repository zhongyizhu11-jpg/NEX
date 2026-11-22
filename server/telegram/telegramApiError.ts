/**
 * Telegram Bot API 返回 ok=false 时抛的错误。
 *
 * 原来只抛一个 `new Error(description)`，调用方拿到的只剩一句英文描述：
 * 「这个人把机器人拉黑了」和「Telegram 限流了」「Token 失效了」长得一样，
 * 提醒分发没法区分「跳过这一个人」还是「整轮停下」，只能一律停下 ——
 * 于是一个拉黑了机器人的用户，就能让他后面所有人的提醒永远发不出去。
 *
 * 所以把 HTTP 状态码 / error_code 和 429 的 retry_after 一起带上。
 */
export class TelegramApiError extends Error {
  readonly method: string;
  /** Telegram 的 error_code（没有时退回 HTTP 状态码）。 */
  readonly errorCode: number;
  /** 429 时 Telegram 要求等待的秒数。 */
  readonly retryAfterSeconds: number | null;

  constructor(method: string, description: string, errorCode: number, retryAfterSeconds: number | null = null) {
    super(description);
    this.name = "TelegramApiError";
    this.method = method;
    this.errorCode = errorCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 从 Bot API 的响应里拼出错误对象。 */
export function telegramApiErrorFromResponse(method: string, status: number, json: any) {
  const errorCode = Number(json?.error_code) || Number(status) || 0;
  const retryAfter = Number(json?.parameters?.retry_after);
  return new TelegramApiError(
    method,
    String(json?.description || `Telegram API ${method} failed: ${status}`),
    errorCode,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  );
}

/**
 * 是不是「这个收件人永远收不到」的错误。
 *
 * 403：机器人被拉黑 / 对方从没和机器人说过话（bot can't initiate conversation）/
 *      账号已注销 / 机器人被踢出群。
 * 400：chat not found / user not found / PEER_ID_INVALID —— 绑定的 chat id 已经无效。
 *
 * 其它 400（比如消息格式错）不算：那是这条消息的问题，不是这个人的问题。
 */
export function isPermanentTelegramRecipientError(error: unknown) {
  if (!(error instanceof TelegramApiError)) return false;
  if (error.errorCode === 403) return true;
  if (error.errorCode !== 400) return false;
  return /chat not found|user not found|peer_id_invalid|bot can't initiate|bot was blocked|user is deactivated/i.test(error.message);
}

/** 429 时最多等多久再重试一次。再长就不等了：后台任务不该为一条消息卡住半天。 */
export const TELEGRAM_RETRY_AFTER_MAX_MS = 30_000;

/**
 * 429 该等多久再重试；不是 429 返回 null。
 *
 * Telegram 限流时会在 parameters.retry_after 里告诉你等几秒，照做一次就好；
 * 原来直接当失败扔掉，批量通知时后面的消息全部白发。
 */
export function telegramRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof TelegramApiError) || error.errorCode !== 429) return null;
  const seconds = error.retryAfterSeconds ?? 1;
  return Math.min(TELEGRAM_RETRY_AFTER_MAX_MS, Math.max(1_000, Math.ceil(seconds * 1000)));
}

/** Token 失效（401 Unauthorized）：重试没有意义，要等管理员改设置。 */
export function isTelegramUnauthorizedError(error: unknown) {
  return error instanceof TelegramApiError && error.errorCode === 401;
}

export const TELEGRAM_POLL_BACKOFF_MIN_MS = 5_000;
export const TELEGRAM_POLL_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * 轮询连续失败第 n 次之后等多久。
 *
 * 原来固定 5 秒：Telegram 那边限流或者长时间不通时，一天要白打一万多次，还会因为
 * 不理 retry_after 被限得更久。改成 5 秒起步、逐次翻倍、最多 5 分钟；429 时至少等
 * Telegram 要求的 retry_after。
 */
export function telegramPollingRetryDelayMs(consecutiveFailures: number, error: unknown) {
  const exponent = Math.max(0, Math.floor(consecutiveFailures) - 1);
  const backoff = Math.min(TELEGRAM_POLL_BACKOFF_MAX_MS, TELEGRAM_POLL_BACKOFF_MIN_MS * 2 ** Math.min(exponent, 16));
  const retryAfterSeconds = error instanceof TelegramApiError && error.errorCode === 429
    ? error.retryAfterSeconds ?? 0
    : 0;
  return Math.min(TELEGRAM_POLL_BACKOFF_MAX_MS, Math.max(backoff, Math.ceil(retryAfterSeconds * 1000)));
}
