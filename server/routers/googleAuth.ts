import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { maskIdentifier } from "./helpers";
import { recordPanelEvent } from "../ops/panelEvents";
import { listUserPasskeys } from "../ops/passkeys";
import { hasUsablePassword } from "../password";
import { GOOGLE_START_PATH, googleLoginErrorMessage, sanitizeGoogleInviteCode } from "../../shared/googleLogin";
import { googleLoginAdminView, isGoogleLoginUsable, planGoogleSettingsUpdate, readGoogleLoginSettings } from "../googleLoginSettings";
import { setInitialPasswordForPasswordlessUser, unlinkGoogleAccount } from "../repositories/googleAccountRepository";
import { consumeGoogleStartQuota, googleAppFlows, issueGoogleSessionOrChallenge, sessionErrorCode } from "../googleAuthRoute";

/*
  trpc.googleAuth.* —— Google 登录的设置、个人资料里的绑定 / 解绑，和 App 里的轮询登录。
  浏览器里的跳转（start / callback）在 server/googleAuthRoute.ts。
*/

function requestIp(ctx: any) {
  return String(ctx.req?.ip || ctx.req?.socket?.remoteAddress || "unknown");
}

function displayName(user: any) {
  return String(user?.name || user?.username || `#${user?.id}`).slice(0, 60);
}

/** 解绑 Google 之后还能不能登录：有能用的密码，或者有通行密钥。 */
async function otherSignInMethods(user: any) {
  const password = hasUsablePassword(user?.password);
  const passkeys = await listUserPasskeys(user.id).then((items) => items.length).catch(() => 0);
  return { password, passkeys };
}

export const googleAuthRouter = router({
  adminSettings: adminProcedure.query(async () => googleLoginAdminView(await db.getAllSettings())),

  updateAdminSettings: adminProcedure
    .input(z.object({
      enabled: z.boolean().optional(),
      clientId: z.string().max(256).optional(),
      clientSecret: z.string().max(512).optional(),
      clearClientSecret: z.boolean().optional(),
      allowRegistration: z.boolean().optional(),
      allowedDomains: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const all = await db.getAllSettings();
      const plan = planGoogleSettingsUpdate(all, input);
      if (plan.error) throw new TRPCError({ code: "BAD_REQUEST", message: plan.error });
      await db.setSettings(plan.patch);
      const next = await db.getAllSettings();
      const view = googleLoginAdminView(next);
      // 只记改了哪些键，不记值（密钥不能进日志）。
      console.info(`[Settings] google login updated keys=${Object.keys(plan.patch).join(",") || "-"} enabled=${view.enabled} usable=${view.usable} by userId=${ctx.user.id}`);
      if (input.enabled !== undefined && input.enabled !== readGoogleLoginSettings(all).enabled) {
        void recordPanelEvent({
          kind: "security.google_login_toggled",
          level: "info",
          userId: ctx.user.id,
          message: `${displayName(ctx.user)} ${input.enabled ? "开启" : "关闭"}了 Google 登录`,
        });
      }
      return view;
    }),

  status: protectedProcedure.query(async ({ ctx }) => {
    const settings = readGoogleLoginSettings(await db.getAllSettings());
    const user: any = ctx.user;
    const others = await otherSignInMethods(user);
    const linked = !!user.googleSub;
    return {
      enabled: isGoogleLoginUsable(settings),
      linked,
      email: linked ? (user.googleEmail || null) : null,
      linkedAt: linked ? (user.googleLinkedAt || null) : null,
      hasPassword: others.password,
      passkeyCount: others.passkeys,
      canUnlink: linked && (others.password || others.passkeys > 0),
      panelPublicUrl: settings.panelBaseUrl,
      linkStartUrl: settings.panelBaseUrl ? `${settings.panelBaseUrl}${GOOGLE_START_PATH}?mode=link&redirect=%2Fprofile` : "",
    };
  }),

  unlink: protectedProcedure.mutation(async ({ ctx }) => {
    const user: any = ctx.user;
    if (!user.googleSub) throw new TRPCError({ code: "BAD_REQUEST", message: "当前账号没有绑定 Google" });
    const others = await otherSignInMethods(user);
    if (!others.password && others.passkeys === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "解除绑定前请先设置登录密码：不然这个账号就没有别的办法登录了" });
    }
    await unlinkGoogleAccount(user.id);
    console.info(`[GoogleAuth] unlinked userId=${user.id} ip=${requestIp(ctx)}`);
    void recordPanelEvent({
      kind: "account.google_unlinked",
      level: "info",
      userId: user.id,
      message: `${displayName(user)} 解除了 Google 账号 ${maskIdentifier(user.googleEmail || "")} 的绑定`,
      data: { ip: requestIp(ctx) },
    });
    return { success: true as const };
  }),

  /** Google 注册的账号第一次设密码（不用旧密码 —— 本来就没有）。已经有密码的走「修改密码」。 */
  setInitialPassword: protectedProcedure
    .input(z.object({ newPassword: z.string().min(6, "密码至少 6 个字符").max(128) }))
    .mutation(async ({ input, ctx }) => {
      const user: any = ctx.user;
      if (hasUsablePassword(user.password) || !(await setInitialPasswordForPasswordlessUser(user.id, input.newPassword))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "这个账号已经有登录密码了，请用「修改密码」" });
      }
      console.info(`[GoogleAuth] initial password set userId=${user.id}`);
      void recordPanelEvent({
        kind: "account.password_set",
        level: "info",
        userId: user.id,
        message: `${displayName(user)} 给 Google 注册的账号设置了登录密码`,
        data: { ip: requestIp(ctx) },
      });
      return { success: true as const };
    }),

  /** App：发起一次 Google 登录，拿到用系统浏览器打开的地址和轮询凭据。 */
  appStart: publicProcedure
    .input(z.object({ inviteCode: z.string().max(64).optional() }).optional())
    .mutation(async ({ ctx, input }) => {
    const settings = readGoogleLoginSettings(await db.getAllSettings());
    if (!isGoogleLoginUsable(settings)) throw new TRPCError({ code: "BAD_REQUEST", message: googleLoginErrorMessage("disabled") });
    const ip = requestIp(ctx);
    if (!consumeGoogleStartQuota(ip)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: googleLoginErrorMessage("rate_limited") });
    const flow = googleAppFlows.create(ip);
    const startUrl = new URL(`${settings.panelBaseUrl}${GOOGLE_START_PATH}`);
    startUrl.searchParams.set("mode", "app");
    startUrl.searchParams.set("flow", flow.flowId);
    // 从邀请链接进来、在 App 里用 Google 注册：邀请码跟着带到浏览器那边的起始地址
    const inviteCode = sanitizeGoogleInviteCode(input?.inviteCode);
    if (inviteCode) startUrl.searchParams.set("invite", inviteCode);
    console.info(`[GoogleAuth] app flow started ip=${ip}`);
    return { ...flow, startUrl: startUrl.toString() };
  }),

  appStatus: publicProcedure
    .input(z.object({ flowId: z.string().min(16).max(64), pollToken: z.string().min(16).max(128) }))
    .mutation(async ({ input, ctx }) => {
      const result = googleAppFlows.poll(input.flowId, input.pollToken);
      if (result.status === "pending" || result.status === "expired") return { status: result.status };
      if (result.status === "failed") return { status: "failed" as const, code: result.code, message: googleLoginErrorMessage(result.code) };
      const user = await db.getUserById(result.userId);
      if (!user) return { status: "failed" as const, code: "server_error" as const, message: googleLoginErrorMessage("server_error") };
      const ip = requestIp(ctx);
      try {
        const session: any = await issueGoogleSessionOrChallenge(ctx, user, { mobile: true, ip });
        if (session?.twoFactorRequired) return { status: "two_factor" as const, ...session };
        console.info(`[Auth] Google app login success userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
        void recordPanelEvent({
          kind: "account.login",
          level: "info",
          userId: user.id,
          message: `${displayName(user)} 在 App 里用 Google 账号登录`,
          data: { method: "google", ip },
        });
        return { status: "success" as const, ...session };
      } catch (error) {
        const code = sessionErrorCode(error);
        return { status: "failed" as const, code, message: googleLoginErrorMessage(code) };
      }
    }),

  appCancel: publicProcedure
    .input(z.object({ flowId: z.string().min(16).max(64), pollToken: z.string().min(16).max(128) }))
    .mutation(({ input }) => ({ success: googleAppFlows.cancel(input.flowId, input.pollToken) })),
});
