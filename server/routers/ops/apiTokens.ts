import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "../../_core/trpc";
import { createUserApiToken, listUserApiTokens, revokeUserApiToken, updateUserApiTokenModules } from "../../ops/apiTokens";
import { API_TOKEN_MODULES, apiTokenModulesLabel, normalizeApiTokenModules } from "../../../shared/apiTokenModules";
import { recordPanelEvent } from "../../ops/panelEvents";

/**
 * trpc.ops.apiTokens.* —— 设置 › 进阶 › API 令牌与 MCP（#9）。
 *
 * 入口在设置页（只有管理员进得去），所以接口也只给管理员；每人只看得到、只撤得掉自己的。
 * 用令牌本身调这里一律被拒（见 server/ops/apiTokenPolicy.ts）：令牌不能给自己续命。
 */
/** 新令牌不指定有效期时的默认值（天）。 */
export const DEFAULT_API_TOKEN_EXPIRY_DAYS = 90;

/** 模块列表：不传 / 空数组 = 不限。 */
const modulesInput = z.array(z.enum(API_TOKEN_MODULES)).max(API_TOKEN_MODULES.length).nullable().optional();

export const apiTokensRouter = router({
  list: adminProcedure.query(async ({ ctx }) => listUserApiTokens(ctx.user.id)),

  create: adminProcedure
    .input(z.object({
      name: z.string().trim().min(1, "请给令牌起个名字").max(64, "名字最多 64 个字"),
      scope: z.enum(["read", "full"]),
      modules: modulesInput,
      expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const created = await createUserApiToken({
        userId: ctx.user.id,
        name: input.name,
        scope: input.scope,
        modules: normalizeApiTokenModules(input.modules ?? null),
        // 没传有效期 = 默认 90 天；明确传 null 才是永不过期（网页上选「永不过期」）。
        expiresInDays: input.expiresInDays === undefined ? DEFAULT_API_TOKEN_EXPIRY_DAYS : input.expiresInDays,
      });
      const who = ctx.user.name || ctx.user.username;
      void recordPanelEvent({
        kind: "account.api_token_created",
        level: input.scope === "full" ? "warn" : "info",
        userId: ctx.user.id,
        message: `${who} 新建了${input.scope === "full" ? "完全权限" : "只读"} API 令牌「${input.name}」（${apiTokenModulesLabel(normalizeApiTokenModules(input.modules ?? null))}）`,
        data: { tokenId: created.id, prefix: created.prefix, scope: input.scope, modules: normalizeApiTokenModules(input.modules ?? null), expiresAt: created.expiresAt?.toISOString() ?? null },
      });
      console.info(`[ApiTokens] created id=${created.id} userId=${ctx.user.id} scope=${input.scope}`);
      // 明文只在这一次返回，库里只有哈希。
      return { id: created.id, token: created.token, prefix: created.prefix, expiresAt: created.expiresAt };
    }),

  /** 改令牌能碰的模块。令牌本身调不到这里（ops.apiTokens. 整个在禁止名单里）。 */
  updateModules: adminProcedure
    .input(z.object({ id: z.number().int().positive(), modules: modulesInput }))
    .mutation(async ({ input, ctx }) => {
      const modules = normalizeApiTokenModules(input.modules ?? null);
      const updated = await updateUserApiTokenModules(ctx.user.id, input.id, modules);
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "令牌不存在或已撤销" });
      console.info(`[ApiTokens] modules id=${input.id} userId=${ctx.user.id} modules=${modules ? modules.join(",") : "all"}`);
      return { success: true as const, modules };
    }),

  revoke: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const revoked = await revokeUserApiToken(ctx.user.id, input.id);
      if (!revoked) throw new TRPCError({ code: "NOT_FOUND", message: "令牌不存在或已撤销" });
      console.info(`[ApiTokens] revoked id=${input.id} userId=${ctx.user.id}`);
      return { success: true as const };
    }),
});
