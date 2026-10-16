/*
  Discord 私信通知的分发：和 Telegram 发同一批事件（主机上下线、规则异常、线路切换、工单、
  自动换 IP、安全巡检、到期 / 流量提醒），正文是同一份 Telegram HTML，在这里转成 Discord 文字。

  收件人：绑定了 Discord（就是用 Discord 登录绑定的那个账号，见 server/discordAuthRoute.ts）、
  没停用的用户；管理员类事件只发管理员。每个人的「这一类收不收」和 Telegram 共用一份
  （server/telegramNotifyPrefs.ts），在一个地方改，两边都生效。

  失败分三种：
  - 对方收不到（403：关了私信 / 没有和机器人共同的服务器）：记下时间（users.discordDmBlockedAt），
    6 小时内不再对他试，账号设置里提示他怎么打开；别人照常发。
  - Token 失效（401）：关掉 Discord 通知（discordBotEnabled=false），写面板日志和事件，等管理员换 Token。
  - 其它（网络、5xx、限流重试后仍失败）：记日志，这一条算失败。

  依赖都从 createDiscordNotifier 注入，测试里换成假的。
*/
import { appendPanelLog } from "./_core/panelLogger";
import { DiscordApiError, getDiscordRestClient, isDiscordRecipientError, isDiscordUnauthorizedError, type DiscordRestClient } from "./discordBot";
import { telegramHtmlToDiscordText } from "./discordText";
import { DISCORD_SETTING_KEYS, isDiscordBotReadyFromSettings, readDiscordBotSettings } from "./discordSettings";
import { isTelegramNotifyMuted, type TelegramNotifyCategory, type TelegramNotifyPrefs } from "./telegramNotifyPrefs";

/** 对方关了私信之后，多久再试一次（他可能已经改了隐私设置）。 */
export const DISCORD_DM_BLOCKED_RETRY_MS = 6 * 60 * 60 * 1000;

export type DiscordNotifyRecipient = {
  id: number | string;
  discordId?: string | null;
  discordDmBlockedAt?: Date | string | number | null;
  accountEnabled?: boolean | number | null;
  role?: string | null;
};

export type DiscordDeliveryStatus = "sent" | "blocked" | "skipped_blocked" | "not_linked" | "disabled" | "failed";

export type DiscordDeliveryResult = { status: DiscordDeliveryStatus; error?: unknown };

/** 发提醒时「这个人现在收不到」：提醒分发按「收件人问题」处理（写标记、接着发下一个）。 */
export class DiscordRecipientUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordRecipientUnavailableError";
  }
}

export type DiscordNotifierDeps = {
  readSettings(): Promise<Record<string, string | null | undefined>>;
  getAdminRecipients(): Promise<DiscordNotifyRecipient[]>;
  readPrefs(): Promise<TelegramNotifyPrefs>;
  setDmBlockedAt(userId: number, at: Date | null): Promise<void>;
  /** Token 失效时关掉机器人。 */
  disableBot(reason: string): Promise<void>;
  client(token: string): Pick<DiscordRestClient, "sendDirectMessage">;
  now(): number;
  log(level: "info" | "warn", message: string): void;
};

function blockedAtMs(value: DiscordNotifyRecipient["discordDmBlockedAt"]) {
  if (value === null || value === undefined || value === "") return 0;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createDiscordNotifier(deps: DiscordNotifierDeps) {
  async function botToken() {
    const settings = await deps.readSettings().catch(() => ({} as Record<string, string | null | undefined>));
    return isDiscordBotReadyFromSettings(settings) ? readDiscordBotSettings(settings).token : "";
  }

  async function isReady() {
    return !!(await botToken());
  }

  /**
   * 给一个人发一条（正文是 Telegram HTML）。不抛错，结果写在返回值里。
   * force：管理员点「发送测试消息」时不管之前有没有被拒收过，照样试一次。
   */
  async function deliver(user: DiscordNotifyRecipient, html: string, options: { force?: boolean; token?: string; label?: string } = {}): Promise<DiscordDeliveryResult> {
    const token = options.token ?? (await botToken());
    if (!token) return { status: "disabled" };
    const discordId = String(user?.discordId || "");
    const userId = Number(user?.id);
    if (!discordId) return { status: "not_linked" };
    const blockedAt = blockedAtMs(user.discordDmBlockedAt);
    if (!options.force && blockedAt && deps.now() - blockedAt < DISCORD_DM_BLOCKED_RETRY_MS) return { status: "skipped_blocked" };
    try {
      await deps.client(token).sendDirectMessage(discordId, telegramHtmlToDiscordText(html));
      if (blockedAt) await deps.setDmBlockedAt(userId, null).catch(() => undefined);
      return { status: "sent" };
    } catch (error) {
      if (isDiscordUnauthorizedError(error)) {
        await deps.disableBot("Bot Token 无效（Discord 返回 401）").catch(() => undefined);
        return { status: "disabled", error };
      }
      if (isDiscordRecipientError(error)) {
        await deps.setDmBlockedAt(userId, new Date(deps.now())).catch(() => undefined);
        deps.log("warn", `[Discord] DM refused user=${userId}${options.label ? ` ${options.label}` : ""}: ${errorText(error)}（对方关了私信或和机器人没有共同服务器，6 小时内不再试）`);
        return { status: "blocked", error };
      }
      deps.log("warn", `[Discord] DM failed user=${userId}${options.label ? ` ${options.label}` : ""}: ${errorText(error)}`);
      return { status: "failed", error };
    }
  }

  /** 发给一批人：按这一类的开关过滤，一个个发；Token 失效就停。 */
  async function deliverMany(recipients: DiscordNotifyRecipient[], html: string, options: { category?: TelegramNotifyCategory | null; label: string }) {
    const counts = { sent: 0, failed: 0, blocked: 0, skipped: 0, muted: 0 };
    const token = await botToken();
    if (!token || recipients.length === 0) return counts;
    const prefs = options.category ? await deps.readPrefs().catch(() => ({} as TelegramNotifyPrefs)) : {};
    for (const user of recipients) {
      if (!user?.discordId) continue;
      if (user.accountEnabled === false || user.accountEnabled === 0) continue;
      if (options.category && isTelegramNotifyMuted(prefs, user.id, options.category)) {
        counts.muted += 1;
        continue;
      }
      const result = await deliver(user, html, { token, label: options.label });
      if (result.status === "sent") counts.sent += 1;
      else if (result.status === "blocked") counts.blocked += 1;
      else if (result.status === "skipped_blocked") counts.skipped += 1;
      else if (result.status === "disabled") {
        counts.failed += 1;
        break; // Token 失效：后面的人也发不出去
      } else counts.failed += 1;
    }
    if (counts.sent || counts.failed || counts.blocked) {
      deps.log("info", `[Discord] notify ${options.label} sent=${counts.sent} failed=${counts.failed} blocked=${counts.blocked} skipped=${counts.skipped}`);
    }
    return counts;
  }

  /** 发给所有绑定了 Discord 的管理员（和 Telegram 的管理员通知同一批事件）。 */
  async function notifyAdmins(html: string, options: { category?: TelegramNotifyCategory | null; excludeUserId?: number | null; label: string }) {
    if (!(await isReady())) return { sent: 0, failed: 0, blocked: 0, skipped: 0, muted: 0 };
    const admins = (await deps.getAdminRecipients().catch(() => [] as DiscordNotifyRecipient[]))
      .filter((admin) => options.excludeUserId === undefined || options.excludeUserId === null || Number(admin.id) !== Number(options.excludeUserId));
    return deliverMany(admins, html, options);
  }

  /** 发给某一个用户（工单回复之类）。 */
  async function notifyUser(user: DiscordNotifyRecipient, html: string, options: { category?: TelegramNotifyCategory | null; label: string }) {
    if (!user?.discordId) return { sent: 0, failed: 0, blocked: 0, skipped: 0, muted: 0 };
    return deliverMany([user], html, options);
  }

  /**
   * 提醒（到期、流量）用：失败时抛错，让 dispatchReminders 区分「这个人收不到」和「通道坏了」。
   * 收不到 → DiscordRecipientUnavailableError（写标记、接着发）；其它照原样抛。
   */
  async function sendReminder(user: DiscordNotifyRecipient, html: string, label: string) {
    const result = await deliver(user, html, { label });
    if (result.status === "sent") return;
    if (result.status === "blocked" || result.status === "skipped_blocked" || result.status === "not_linked") {
      throw new DiscordRecipientUnavailableError(`Discord DM unavailable for user ${user.id} (${result.status})`);
    }
    throw result.error ?? new Error(`Discord reminder not sent (${result.status})`);
  }

  return { isReady, deliver, deliverMany, notifyAdmins, notifyUser, sendReminder };
}

// ---------- 默认实现（真库、真 Discord） ----------

async function disableDiscordBot(reason: string) {
  const [{ setSetting }, { recordPanelEvent }] = await Promise.all([
    import("./repositories/settingsRepository"),
    import("./ops/panelEvents"),
  ]);
  await setSetting(DISCORD_SETTING_KEYS.botEnabled, "false");
  appendPanelLog("warn", `[Discord] ${reason}：已自动关闭 Discord 通知，请到 系统设置 › Discord 换一个新的 Bot Token 再打开`);
  await recordPanelEvent({
    kind: "security.discord_bot_disabled",
    level: "warn",
    message: `Discord 通知已自动关闭：${reason}。请在 系统设置 › Discord 重新填写 Bot Token。`,
  });
}

export const discordNotifier = createDiscordNotifier({
  readSettings: async () => (await import("./repositories/settingsRepository")).getAllSettings(),
  getAdminRecipients: async () => (await import("./repositories/discordAccountRepository")).getDiscordAdminRecipients(),
  readPrefs: async () => (await import("./telegramNotifyPrefs")).readTelegramNotifyPrefs(),
  setDmBlockedAt: async (userId, at) => (await import("./repositories/discordAccountRepository")).setDiscordDmBlockedAt(userId, at),
  disableBot: disableDiscordBot,
  client: (token) => getDiscordRestClient(token),
  now: () => Date.now(),
  log: (level, message) => appendPanelLog(level, message),
});

/** 各通知点调用的入口：发给绑定了 Discord 的管理员。出错只记日志，不影响 Telegram 那一路。 */
export async function notifyDiscordAdmins(html: string, options: { category?: TelegramNotifyCategory | null; excludeUserId?: number | null; label: string }) {
  try {
    return await discordNotifier.notifyAdmins(html, options);
  } catch (error) {
    appendPanelLog("warn", `[Discord] notify ${options.label} failed: ${errorText(error)}`);
    return null;
  }
}

/** 发给某个用户（绑定了才发）。出错只记日志。 */
export async function notifyDiscordUser(user: DiscordNotifyRecipient | null | undefined, html: string, options: { category?: TelegramNotifyCategory | null; label: string }) {
  if (!user?.discordId) return null;
  try {
    return await discordNotifier.notifyUser(user, html, options);
  } catch (error) {
    appendPanelLog("warn", `[Discord] notify ${options.label} failed: ${errorText(error)}`);
    return null;
  }
}

export async function isDiscordBotReady() {
  return discordNotifier.isReady();
}

/** 主机上下线这类「量大」的通知另有一个开关（和 Telegram 的「主机状态通知」对应）。 */
export async function isDiscordHostStatusNotifyEnabled() {
  try {
    const settings = await (await import("./repositories/settingsRepository")).getAllSettings();
    return isDiscordBotReadyFromSettings(settings) && readDiscordBotSettings(settings).hostStatusNotify;
  } catch {
    return false;
  }
}

export { DiscordApiError };
