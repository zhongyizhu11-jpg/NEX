import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { revokeAuthSession } from "../../repositories/sessionRepository";
import { getSessionKindField, normalizeSessionKind, parseSessionLease, type SessionKind } from "../../session";
import { listActiveUserSessions } from "../../ops/sessionDevices";
import { recordPanelEvent } from "../../ops/panelEvents";

/*
  trpc.ops.sessions.* —— 个人资料 › 已登录设备（#13）。只管本人的会话。

  退出某台设备 = 把那一行会话标成撤销：那台设备下一个请求就会被当成「已在其他地方登录」
  踢回登录页。单设备登录模式下如果它正占着「当前设备」的租约，顺手清掉，别的设备
  不用等租约过期就能登录。
*/

async function releaseLeaseIfHeld(userId: number, sid: string, kind: SessionKind) {
  const user = await db.getUserById(userId);
  if (!user) return;
  const lease = parseSessionLease(String((user as any)[getSessionKindField(kind)] || ""));
  if (lease?.sid === sid) await db.clearUserSessionToken(userId, kind);
}

async function revokeOne(userId: number, sid: string, kind: string) {
  const sessionKind = normalizeSessionKind(kind);
  await revokeAuthSession(userId, sid, sessionKind, "revoked_by_user");
  await releaseLeaseIfHeld(userId, sid, sessionKind).catch(() => undefined);
}

export const sessionsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return listActiveUserSessions(ctx.user.id, ctx.authSession?.sid ?? null);
  }),

  revoke: protectedProcedure
    .input(z.object({ sid: z.string().trim().min(1).max(80) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.authSession?.sid && input.sid === ctx.authSession.sid) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "这是当前设备，要退出请用「退出登录」" });
      }
      const sessions = await listActiveUserSessions(ctx.user.id, ctx.authSession?.sid ?? null);
      const target = sessions.find((item) => item.sid === input.sid);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "这台设备已经退出了" });
      await revokeOne(ctx.user.id, target.sid, target.kind);
      console.info(`[Sessions] revoked userId=${ctx.user.id} kind=${target.kind}`);
      return { success: true as const };
    }),

  revokeOthers: protectedProcedure.mutation(async ({ ctx }) => {
    const currentSid = ctx.authSession?.sid ?? null;
    const sessions = await listActiveUserSessions(ctx.user.id, currentSid);
    const others = sessions.filter((item) => !item.current);
    for (const item of others) await revokeOne(ctx.user.id, item.sid, item.kind);
    if (others.length > 0) {
      void recordPanelEvent({
        kind: "account.sessions_revoked",
        level: "info",
        userId: ctx.user.id,
        message: `${ctx.user.name || ctx.user.username} 退出了其他 ${others.length} 台设备`,
      });
    }
    console.info(`[Sessions] revoked others userId=${ctx.user.id} count=${others.length}`);
    return { revoked: others.length };
  }),
});
