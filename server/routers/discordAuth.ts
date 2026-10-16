import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { maskIdentifier } from "./helpers";
import { recordPanelEvent } from "../ops/panelEvents";
import { listUserPasskeys } from "../ops/passkeys";
import { hasUsablePassword } from "../password";
import { DISCORD_START_PATH, discordLoginErrorMessage, sanitizeDiscordInviteCode } from "../../shared/discordLogin";
import {
  DISCORD_SETTING_KEYS,
  discordAdminView,
  isDiscordLoginUsable,
  planDiscordSettingsUpdate,
  readDiscordBotSettings,
  readDiscordLoginSettings,
} from "../discordSettings";
import { setDiscordDmBlockedAt, unlinkDiscordAccount } from "../repositories/discordAccountRepository";
import { setInitialPasswordForPasswordlessUser } from "../repositories/googleAccountRepository";
import { consumeDiscordStartQuota, discordAppFlows, discordSessionErrorCode, issueDiscordSessionOrChallenge } from "../discordAuthRoute";
import { DiscordApiError, DiscordRestClient } from "../discordBot";
import { DISCORD_DM_BLOCKED_RETRY_MS, discordNotifier } from "../discordNotify";
import {
  readTelegramNotifyPrefs,
  setNotifyCategoryMuted,
  isTelegramDigestEnabled,
  isTelegramNotifyMuted,
  TELEGRAM_NOTIFY_CATEGORIES,
  updateTelegramNotifyPref,
  type TelegramNotifyCategory,
} from "../telegramNotifyPrefs";

/*
  trpc.discordAuth.* —— Discord 登录的设置、个人资料里的绑定 / 解绑、App 里的轮询登录，
  以及 Discord 通知机器人的设置、测试消息和每个人的通知类别开关。
  浏览器里的跳转（start / callback）在 server/discordAuthRoute.ts。
*/

function requestIp(ctx: any) {
  return String(ctx.req?.ip || ctx.req?.socket?.remoteAddress || "unknown");
}

function displayName(user: any) {
  return String(user?.name || user?.username || `#${user?.id}`).slice(0, 60);
}

/** 解绑 Discord 之后还能不能登录：有能用的密码，或者有通行密钥（和 Google 解绑同一条规则）。 */
async function otherSignInMethods(user: any) {
  const password = hasUsablePassword(user?.password);
  const passkeys = await listUserPasskeys(user.id).then((items) => items.length).catch(() => 0);
  return { password, passkeys };
}

function blockedAtMs(value: unknown) {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

/** 测试消息 / Token 校验失败时给管理员看的话。 */
function discordBotErrorMessage(error: unknown) {
  if (error instanceof DiscordApiError) {
    if (error.status === 401) return "Bot Token 无效：请在 Developer Portal › Bot 页面点 Reset Token，复制新的填进来";
    if (error.status === 403) return "Discord 拒绝了这条私信：请确认你和机器人在同一个服务器里，并且在该服务器的隐私设置里允许「服务器成员私信」";
    if (error.status === 429) return "Discord 限流了，请稍后再试";
    if (error.status === 0) return "连不上 discord.com：面板服务器需要能访问 Discord";
    return `Discord 返回错误：${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const categorySchema = z.enum(TELEGRAM_NOTIFY_CATEGORIES.map((item) => item.key) as [TelegramNotifyCategory, ...TelegramNotifyCategory[]]);

export const discordAuthRouter = router({
  adminSettings: adminProcedure.query(async () => discordAdminView(await db.getAllSettings())),

  updateAdminSettings: adminProcedure
    .input(z.object({
      enabled: z.boolean().optional(),
      clientId: z.string().max(64).optional(),
      clientSecret: z.string().max(512).optional(),
      clearClientSecret: z.boolean().optional(),
      allowRegistration: z.boolean().optional(),
      allowedDomains: z.string().max(2000).optional(),
      botEnabled: z.boolean().optional(),
      botToken: z.string().max(512).optional(),
      clearBotToken: z.boolean().optional(),
      hostStatusNotify: z.boolean().optional(),
      expiryReminder: z.boolean().optional(),
      trafficReminder: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const all = await db.getAllSettings();
      const plan = planDiscordSettingsUpdate(all, input);
      if (plan.error) throw new TRPCError({ code: "BAD_REQUEST", message: plan.error });
      const patch = { ...plan.patch };
      // 新 Token：问一下 Discord 这是不是一个真的机器人（顺便拿名字显示）。明确被拒（401）就不存。
      const newToken = plan.botTokenChanged ? patch[DISCORD_SETTING_KEYS.botToken] : null;
      if (newToken) {
        try {
          const bot = await new DiscordRestClient({ token: newToken, maxRateLimitRetries: 0 }).getCurrentBot();
          if (!bot.bot) throw new TRPCError({ code: "BAD_REQUEST", message: "这个 Token 不是机器人（Bot）的 Token：请在 Developer Portal › Bot 页面复制" });
          patch[DISCORD_SETTING_KEYS.botUsername] = bot.username || null;
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          if (error instanceof DiscordApiError && error.status === 401) {
            throw new TRPCError({ code: "BAD_REQUEST", message: discordBotErrorMessage(error) });
          }
          // 连不上 Discord 之类：先存下，发消息时再报错
          console.warn(`[Discord] bot token check skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await db.setSettings(patch);
      const next = await db.getAllSettings();
      const view = discordAdminView(next);
      // 只记改了哪些键，不记值（密钥、Token 不能进日志）。
      console.info(`[Settings] discord updated keys=${Object.keys(patch).join(",") || "-"} login=${view.login.usable} bot=${view.bot.ready} by userId=${ctx.user.id}`);
      if (input.enabled !== undefined && input.enabled !== readDiscordLoginSettings(all).enabled) {
        void recordPanelEvent({
          kind: "security.discord_login_toggled",
          level: "info",
          userId: ctx.user.id,
          message: `${displayName(ctx.user)} ${input.enabled ? "开启" : "关闭"}了 Discord 登录`,
        });
      }
      return view;
    }),

  /** 管理员：给自己发一条测试私信（不管之前有没有被拒收过，照样试一次）。 */
  testBot: adminProcedure.mutation(async ({ ctx }) => {
    const settings = await db.getAllSettings();
    const bot = readDiscordBotSettings(settings);
    if (!bot.enabled || !bot.token) throw new TRPCError({ code: "BAD_REQUEST", message: "Discord 通知还没有开启，或者没填 Bot Token" });
    const user: any = await db.getUserById(ctx.user.id);
    if (!user?.discordId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "你还没有绑定 Discord：先在 个人资料 › Discord 里绑定，机器人才知道发给谁" });
    }
    const text = [
      "<b>NEX Discord 测试消息</b>",
      "",
      `接收用户：${displayName(user)}`,
      `机器人：${bot.botUsername || "当前机器人"}`,
      `时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    ].join("\n");
    const result = await discordNotifier.deliver(user, text, { force: true, label: "test" });
    if (result.status !== "sent") {
      throw new TRPCError({ code: "BAD_REQUEST", message: result.error ? discordBotErrorMessage(result.error) : "Discord 通知没有开启" });
    }
    return { success: true as const };
  }),

  status: protectedProcedure.query(async ({ ctx }) => {
    const all = await db.getAllSettings();
    const settings = readDiscordLoginSettings(all);
    const bot = readDiscordBotSettings(all);
    const user: any = ctx.user;
    const others = await otherSignInMethods(user);
    const linked = !!user.discordId;
    const blockedAt = blockedAtMs(user.discordDmBlockedAt);
    return {
      enabled: isDiscordLoginUsable(settings),
      linked,
      username: linked ? (user.discordUsername || null) : null,
      email: linked ? (user.discordEmail || null) : null,
      linkedAt: linked ? (user.discordLinkedAt || null) : null,
      hasPassword: others.password,
      passkeyCount: others.passkeys,
      canUnlink: linked && (others.password || others.passkeys > 0),
      panelPublicUrl: settings.panelBaseUrl,
      linkStartUrl: settings.panelBaseUrl ? `${settings.panelBaseUrl}${DISCORD_START_PATH}?mode=link&redirect=%2Fprofile` : "",
      notifications: {
        botReady: bot.enabled && !!bot.token,
        botUsername: bot.botUsername,
        // 最近一次私信被拒收的时间（6 小时内不再试；绑定的人改了隐私设置后可以点「重新尝试」）
        dmBlockedAt: linked && blockedAt ? new Date(blockedAt) : null,
        dmBlockedRetryAt: linked && blockedAt ? new Date(blockedAt + DISCORD_DM_BLOCKED_RETRY_MS) : null,
      },
    };
  }),

  unlink: protectedProcedure.mutation(async ({ ctx }) => {
    const user: any = ctx.user;
    if (!user.discordId) throw new TRPCError({ code: "BAD_REQUEST", message: "当前账号没有绑定 Discord" });
    const others = await otherSignInMethods(user);
    if (!others.password && others.passkeys === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "解除绑定前请先设置登录密码：不然这个账号就没有别的办法登录了" });
    }
    await unlinkDiscordAccount(user.id);
    console.info(`[DiscordAuth] unlinked userId=${user.id} ip=${requestIp(ctx)}`);
    void recordPanelEvent({
      kind: "account.discord_unlinked",
      level: "info",
      userId: user.id,
      message: `${displayName(user)} 解除了 Discord 账号 ${maskIdentifier(user.discordUsername || "")} 的绑定`,
      data: { ip: requestIp(ctx) },
    });
    return { success: true as const };
  }),

  /** Discord 注册的账号第一次设密码（不用旧密码 —— 本来就没有）。已经有密码的走「修改密码」。 */
  setInitialPassword: protectedProcedure
    .input(z.object({ newPassword: z.string().min(6, "密码至少 6 个字符").max(128) }))
    .mutation(async ({ input, ctx }) => {
      const user: any = ctx.user;
      if (hasUsablePassword(user.password) || !(await setInitialPasswordForPasswordlessUser(user.id, input.newPassword))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "这个账号已经有登录密码了，请用「修改密码」" });
      }
      console.info(`[DiscordAuth] initial password set userId=${user.id}`);
      void recordPanelEvent({
        kind: "account.password_set",
        level: "info",
        userId: user.id,
        message: `${displayName(user)} 给 Discord 注册的账号设置了登录密码`,
        data: { ip: requestIp(ctx) },
      });
      return { success: true as const };
    }),

  /** 私信被拒收之后改好了隐私设置：清掉标记，立刻发一条确认私信。 */
  retryDm: protectedProcedure.mutation(async ({ ctx }) => {
    const user: any = await db.getUserById(ctx.user.id);
    if (!user?.discordId) throw new TRPCError({ code: "BAD_REQUEST", message: "当前账号没有绑定 Discord" });
    if (!(await discordNotifier.isReady())) throw new TRPCError({ code: "BAD_REQUEST", message: "管理员还没有开启 Discord 通知" });
    const result = await discordNotifier.deliver(user, "<b>NEX</b>：私信已打通，之后的通知会发到这里。", { force: true, label: "retry" });
    if (result.status !== "sent") throw new TRPCError({ code: "BAD_REQUEST", message: result.error ? discordBotErrorMessage(result.error) : "发送失败" });
    await setDiscordDmBlockedAt(user.id, null).catch(() => undefined);
    return { success: true as const };
  }),

  /** 我的通知类别（和 Telegram 共用一份：在这里关掉「线路切换」，Telegram 那边也不再发）。 */
  notifyPrefs: protectedProcedure.query(async ({ ctx }) => {
    const prefs = await readTelegramNotifyPrefs();
    const isAdmin = ctx.user.role === "admin";
    return {
      categories: TELEGRAM_NOTIFY_CATEGORIES
        .filter((item) => !item.adminOnly || isAdmin)
        .map((item) => ({ key: item.key, label: item.label, enabled: !isTelegramNotifyMuted(prefs, ctx.user.id, item.key) })),
      digest: isTelegramDigestEnabled(prefs, ctx.user),
    };
  }),

  setNotifyCategory: protectedProcedure
    .input(z.object({ category: categorySchema, enabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const item = TELEGRAM_NOTIFY_CATEGORIES.find((entry) => entry.key === input.category);
      if (!item || (item.adminOnly && ctx.user.role !== "admin")) throw new TRPCError({ code: "BAD_REQUEST", message: "没有这一类通知" });
      await setNotifyCategoryMuted(ctx.user.id, input.category, !input.enabled);
      return { success: true as const };
    }),

  setDigest: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      await updateTelegramNotifyPref(ctx.user.id, { digest: input.enabled });
      return { success: true as const };
    }),

  /** App：发起一次 Discord 登录，拿到用系统浏览器打开的地址和轮询凭据。 */
  appStart: publicProcedure
    .input(z.object({ inviteCode: z.string().max(64).optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const settings = readDiscordLoginSettings(await db.getAllSettings());
      if (!isDiscordLoginUsable(settings)) throw new TRPCError({ code: "BAD_REQUEST", message: discordLoginErrorMessage("disabled") });
      const ip = requestIp(ctx);
      if (!consumeDiscordStartQuota(ip)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: discordLoginErrorMessage("rate_limited") });
      const flow = discordAppFlows.create(ip);
      const startUrl = new URL(`${settings.panelBaseUrl}${DISCORD_START_PATH}`);
      startUrl.searchParams.set("mode", "app");
      startUrl.searchParams.set("flow", flow.flowId);
      // 从邀请链接进来、在 App 里用 Discord 注册：邀请码跟着带到浏览器那边的起始地址
      const inviteCode = sanitizeDiscordInviteCode(input?.inviteCode);
      if (inviteCode) startUrl.searchParams.set("invite", inviteCode);
      console.info(`[DiscordAuth] app flow started ip=${ip}`);
      return { ...flow, startUrl: startUrl.toString() };
    }),

  appStatus: publicProcedure
    .input(z.object({ flowId: z.string().min(16).max(64), pollToken: z.string().min(16).max(128) }))
    .mutation(async ({ input, ctx }) => {
      const result = discordAppFlows.poll(input.flowId, input.pollToken);
      if (result.status === "pending" || result.status === "expired") return { status: result.status };
      if (result.status === "failed") return { status: "failed" as const, code: result.code, message: discordLoginErrorMessage(result.code) };
      const user = await db.getUserById(result.userId);
      if (!user) return { status: "failed" as const, code: "server_error" as const, message: discordLoginErrorMessage("server_error") };
      const ip = requestIp(ctx);
      try {
        const session: any = await issueDiscordSessionOrChallenge(ctx, user, { mobile: true, ip });
        if (session?.twoFactorRequired) return { status: "two_factor" as const, ...session };
        console.info(`[Auth] Discord app login success userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
        void recordPanelEvent({
          kind: "account.login",
          level: "info",
          userId: user.id,
          message: `${displayName(user)} 在 App 里用 Discord 账号登录`,
          data: { method: "discord", ip },
        });
        return { status: "success" as const, ...session };
      } catch (error) {
        const code = discordSessionErrorCode(error);
        return { status: "failed" as const, code, message: discordLoginErrorMessage(code) };
      }
    }),

  appCancel: publicProcedure
    .input(z.object({ flowId: z.string().min(16).max(64), pollToken: z.string().min(16).max(128) }))
    .mutation(({ input }) => ({ success: discordAppFlows.cancel(input.flowId, input.pollToken) })),
});
