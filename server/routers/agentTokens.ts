import { z } from "zod";
import { assertCanAddSelfServiceHost } from "../selfServiceHostLimit";
import { nanoid } from "nanoid";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { maskToken } from "./helpers";
import { ruleOwnerSummary } from "../hostDeletion";

export const agentTokensRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.user.role === "admin";
    const tokens = await db.getAgentTokens(isAdmin ? undefined : ctx.user.id);
    return tokens.map((token: any) => ({
      ...token,
      token: maskToken(token.token),
    }));
  }),
  create: protectedProcedure
    .input(z.object({ description: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      // 每个 token 注册一台新机器：建 token 这一步就按自助上限卡住（注册时还会再查一次）。
      await assertCanAddSelfServiceHost({ ...(await db.getUserById(ctx.user.id)), ...ctx.user } as any, {
        getGlobalLimitRaw: () => db.getSetting("selfServiceHostLimit"),
        countOwnedHosts: (userId) => db.countHostsByUserId(userId),
      });
      const token = nanoid(32);
      const id = await db.createAgentToken({
        token,
        description: input.description ?? null,
        userId: ctx.user.id,
      });
      return { id, token };
    }),
  update: protectedProcedure
    .input(z.object({ id: z.number(), description: z.string().max(200).nullable().optional() }))
    .mutation(async ({ input, ctx }) => {
      const token = await db.getAgentTokenById(input.id);
      if (!token) throw new Error("Token 不存在");
      if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) {
        throw new Error("无权修改该 Token");
      }
      const description = input.description?.trim() || null;
      await db.updateAgentTokenDescription(input.id, description);
      return { success: true };
    }),
  reorder: protectedProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(2000) }))
    .mutation(async ({ input, ctx }) => {
      await db.reorderAgentTokens(input.ids, ctx.user.role === "admin" ? undefined : ctx.user.id);
      return { success: true };
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const token = await db.getAgentTokenById(input.id);
      if (!token) throw new Error("Token 不存在");
      if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) {
        throw new Error("无权删除该 Token");
      }
      let releasedPendingCleanup = 0;
      const hostIds = new Set<number>();
      if (token.hostId) hostIds.add(Number(token.hostId));
      if (token.token) {
        const boundHost = await db.getHostByAgentToken(token.token);
        if (boundHost?.id) hostIds.add(Number(boundHost.id));
      }
      for (const hostId of hostIds) {
        const blockers = await db.getHostRuleDeleteBlockers(hostId);
        if (blockers.ruleCount > 0) {
          const ownerSummary = ctx.user.role === "admin" ? ruleOwnerSummary(blockers.ruleOwners) : "";
          const ownerHint = ownerSummary ? `：${ownerSummary}` : "";
          throw new Error(`该 Token 关联主机下还有 ${blockers.ruleCount} 条未删除的转发规则${ownerHint}。请先删除这些规则后再删除 Token`);
        }
        if (blockers.managedRuleCount > 0) {
          const ownerSummary = ctx.user.role === "admin" ? ruleOwnerSummary(blockers.managedRuleOwners) : "";
          const ownerHint = ownerSummary ? `：${ownerSummary}` : "";
          throw new Error(`该 Token 关联主机仍被 ${blockers.managedRuleCount} 条未删除的转发组/转发链规则引用${ownerHint}。请先移除引用后再删除 Token`);
        }
        releasedPendingCleanup += await db.releaseHostPendingRuleCleanup(hostId);
      }
      await db.deleteAgentToken(input.id);
      let removedHosts = 0;
      for (const hostId of hostIds) {
        if (await db.deleteHostIfUnreferenced(hostId)) removedHosts += 1;
      }
      return { success: true, releasedPendingCleanup, removedHosts };
    }),
  getInstallToken: protectedProcedure
    .input(z.object({ id: z.number().optional(), token: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      if (!input.id && !input.token) throw new Error("缺少 Token 参数");
      const token = input.id
        ? await db.getAgentTokenById(input.id)
        : await db.getAgentTokenByToken(input.token!);
      if (!token) throw new Error("Token 不存在");
      if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) {
        throw new Error("无权使用该 Token");
      }
      return { token: token.token };
    }),
});
