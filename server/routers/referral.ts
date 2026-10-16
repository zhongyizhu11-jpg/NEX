import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { REFERRAL_MODES } from "../../shared/referral";

/**
 * 邀请返利。
 *
 * 用户侧：看自己的邀请码、邀请了几个人、拿了多少返利、哪些套餐能返。邀请关系一旦绑定，
 * 用户侧接口一律改不了（这里根本不提供改的口子）。
 * 管理员侧：三个全局开关、全部返利记录、在用户详情里看 / 改 / 清某个人的邀请人。
 */
export const referralRouter = router({
  /** 我的邀请页。返利没开时只回「没开」，不生成邀请码。 */
  me: protectedProcedure.query(async ({ ctx }) => {
    const settings = await db.getReferralSettings();
    if (!settings.enabled) {
      return { enabled: false as const, mode: settings.mode, inviteCode: null, invitedCount: 0, totalCommissionCents: 0, commissionCount: 0 };
    }
    const inviteCode = await db.getOrCreateInviteCode(ctx.user.id);
    const stats = await db.getReferralStats(ctx.user.id);
    return { enabled: true as const, mode: settings.mode, inviteCode, ...stats };
  }),

  myCommissions: protectedProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(20),
    }))
    .query(async ({ input, ctx }) => db.listMyReferralCommissionsPage(ctx.user.id, input)),

  /** 商店可见、返利比例大于 0 的套餐。返利没开就是空的。 */
  plans: protectedProcedure.query(async () => {
    const settings = await db.getReferralSettings();
    if (!settings.enabled) return [];
    return db.listReferralPlans();
  }),

  settings: adminProcedure.query(async () => db.getReferralSettings()),

  setSettings: adminProcedure
    .input(z.object({
      enabled: z.boolean().optional(),
      mode: z.enum(REFERRAL_MODES).optional(),
      forceInvite: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await db.setReferralSettings(input);
      appendPanelLog("info", `[Referral] settings updated enabled=${result.enabled} mode=${result.mode} forceInvite=${result.forceInvite} operator=${ctx.user.id}`);
      return result;
    }),

  adminCommissions: adminProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(20),
      inviterUsername: z.string().trim().max(128).optional(),
    }))
    .query(async ({ input }) => db.listReferralCommissionsAdminPage(input)),

  adminUserInfo: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => db.getAdminUserReferralInfo(input.userId)),

  /** 管理员改 / 清某个人的邀请人。inviterUsername 为空串表示清掉。 */
  adminSetInviter: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      inviterUsername: z.string().trim().max(128),
    }))
    .mutation(async ({ input, ctx }) => {
      let inviterId: number | null = null;
      if (input.inviterUsername) {
        inviterId = await db.findUserIdByUsername(input.inviterUsername);
        if (!inviterId) throw new Error("找不到这个用户名");
      }
      await db.setUserInviter(input.userId, inviterId);
      appendPanelLog("info", `[Referral] inviter ${inviterId ? `set to ${inviterId}` : "cleared"} user=${input.userId} operator=${ctx.user.id}`);
      return db.getAdminUserReferralInfo(input.userId);
    }),
});
