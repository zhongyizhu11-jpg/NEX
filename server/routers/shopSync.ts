import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { adminProcedure, router } from "../_core/trpc";
import { resolvePanelUrl } from "../agentPanelUrl";
import { createUserApiToken, listUserApiTokens, type ApiTokenContext } from "../ops/apiTokens";
import { recordPanelEvent } from "../ops/panelEvents";
import { listSubscriptionPlanOptions } from "../repositories/billingRepository";
import { getProxySubTokensByUser } from "../repositories/proxySubscriptionRepository";
import { buildProxySubscriptionUrl } from "../../shared/proxyClientImport";
import { SHOP_KINDS, SHOP_PLAN_MAPPING_MAX, SHOP_SYNC_ACTIONS } from "../../shared/shopSync";
import {
  ShopSyncDisabledError,
  ShopSyncInputError,
  applyShopSyncEvent,
  listShopSyncRecords,
  loadShopSyncConfig,
  saveShopSyncConfig,
  shopCreatedUserId,
  shopSyncStats,
} from "../shopSync/service";

/*
  trpc.shopSync.* —— 商城对接（设置 › 进阶 › 商城对接，逻辑在 server/shopSync/service.ts）。

  shopSync.inbound.push 是给商城调的：Xboard 插件、V2Board / SSPanel 的计划任务脚本拿一枚只勾了
  「商城对接」模块的 API 令牌，POST /api/trpc/shopSync.inbound.push。它要求：
    · 必须是 API 令牌，而且令牌勾了 shop 模块 —— 网页会话、不限模块的万能令牌都不收：对接令牌泄露了
      最多能改套餐，不能顺手翻用户列表；反过来，管理员手里的万能令牌也不会被误当成商城；
    · 令牌主人得是管理员（adminProcedure），完全权限（只读令牌在策略层就被拒了）；
    · 每次调用照样进操作审计（server/operationAudit.ts，路径 shopSync.inbound.push），结果另记一行
      shop_sync_orders，设置页「最近同步」读它。
  其余几个是设置页用的：只给管理员，令牌按「系统设置」模块管；生成对接令牌只能在网页上点（策略层禁止令牌调）。
*/

const keyText = z.string().trim().min(1).max(128);
const timeInput = z.union([z.number(), z.string().max(64)]);

const applyInput = z.object({
  action: z.enum(SHOP_SYNC_ACTIONS),
  orderId: keyText,
  user: z.object({
    externalId: z.union([keyText, z.number().int().nonnegative()]).transform((value) => String(value)),
    email: z.string().trim().max(255).nullable().optional(),
  }),
  shopPlanId: z.union([z.string().max(64), z.number()]).nullable().optional(),
  durationDays: z.number().int().min(1).max(36_500).nullable().optional(),
  expiresAt: timeInput.nullable().optional(),
  occurredAt: timeInput.nullable().optional(),
});

export function assertShopToken(apiToken: ApiTokenContext | null | undefined) {
  if (!apiToken) {
    throw new TRPCError({ code: "FORBIDDEN", message: "这个接口只给商城用：请用只勾了「商城对接」模块的 API 令牌调用" });
  }
  if (!apiToken.modules || !apiToken.modules.includes("shop")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "这枚令牌没勾「商城对接」模块。请在 设置 › 进阶 › 商城对接 里生成专用令牌" });
  }
}

/** 对接新建的账号回一条订阅地址，商城可以直接展示给用户；认领来的老账号、没开订阅的不回。 */
async function subscribeUrlFor(externalId: string, origin: string): Promise<string | null> {
  const userId = await shopCreatedUserId(externalId);
  if (!userId) return null;
  const rows = (await getProxySubTokensByUser(userId)) as Array<{ token?: unknown; isEnabled?: unknown; expiresAt?: unknown }>;
  const usable = rows.find((row) => row.isEnabled !== false && row.isEnabled !== 0
    && (!row.expiresAt || new Date(String(row.expiresAt)).getTime() > Date.now()));
  return usable?.token ? buildProxySubscriptionUrl({ origin, token: String(usable.token), format: "base64", kind: "nodes" }) : null;
}

export const shopSyncRouter = router({
  inbound: router({
    push: adminProcedure.input(applyInput).mutation(async ({ input, ctx }) => {
      assertShopToken(ctx.apiToken);
      try {
        const result = await applyShopSyncEvent(input);
        const subscribeUrl = result.ok && result.user ? await subscribeUrlFor(input.user.externalId, await resolvePanelUrl(ctx.req)).catch(() => null) : null;
        return { ...result, subscribeUrl };
      } catch (error) {
        if (error instanceof ShopSyncDisabledError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
        if (error instanceof ShopSyncInputError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        throw error;
      }
    }),
  }),

  get: adminProcedure.query(async ({ ctx }) => {
    const [config, plans, records, stats, tokens] = await Promise.all([
      loadShopSyncConfig(),
      listSubscriptionPlanOptions(true),
      listShopSyncRecords(20),
      shopSyncStats(),
      listUserApiTokens(ctx.user.id),
    ]);
    const origin = await resolvePanelUrl(ctx.req).catch(() => "");
    return {
      config,
      plans: (plans as Array<{ id: unknown; name: unknown; isActive: unknown }>).map((plan) => ({ id: Number(plan.id), name: String(plan.name || ""), isActive: plan.isActive !== false && plan.isActive !== 0 })),
      records,
      stats,
      endpoint: `${origin.replace(/\/+$/, "")}/api/trpc/shopSync.inbound.push`,
      shopTokens: tokens
        .filter((token) => !token.expired && token.modules?.includes("shop"))
        .map((token) => ({ id: token.id, name: token.name, prefix: token.prefix, lastUsedAt: token.lastUsedAt, expiresAt: token.expiresAt })),
    };
  }),

  save: adminProcedure
    .input(z.object({
      enabled: z.boolean(),
      shop: z.enum(SHOP_KINDS),
      linkExistingByEmail: z.boolean(),
      plans: z.array(z.object({ shopPlanId: z.string().trim().min(1, "商城套餐 ID 不能空").max(64), planId: z.number().int().positive() })).max(SHOP_PLAN_MAPPING_MAX),
    }))
    .mutation(async ({ input, ctx }) => {
      const before = await loadShopSyncConfig();
      let config;
      try {
        config = await saveShopSyncConfig(input);
      } catch (error) {
        if (error instanceof ShopSyncInputError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        throw error;
      }
      if (before.enabled !== config.enabled) {
        void recordPanelEvent({
          kind: "ops.shop_sync",
          level: config.enabled ? "warn" : "info",
          userId: ctx.user.id,
          message: `${ctx.user.name || ctx.user.username} ${config.enabled ? "打开" : "关闭"}了商城对接`,
          data: { shop: config.shop, plans: config.plans.length, linkExistingByEmail: config.linkExistingByEmail },
        });
      }
      console.info(`[ShopSync] settings saved by userId=${ctx.user.id} enabled=${config.enabled} shop=${config.shop} plans=${config.plans.length} linkExisting=${config.linkExistingByEmail}`);
      return { config };
    }),

  /** 一枚只勾了「商城对接」、完全权限、一年有效的令牌。明文只在这一次返回。 */
  createToken: adminProcedure.mutation(async ({ ctx }) => {
    // 策略层已经挡了令牌调这里（TOKEN_FORBIDDEN_PATHS），这里再兜一层：令牌不能给自己签新令牌。
    if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "请在网页上生成对接令牌" });
    const created = await createUserApiToken({ userId: ctx.user.id, name: "商城对接", scope: "full", modules: ["shop"], expiresInDays: 365 });
    void recordPanelEvent({
      kind: "account.api_token_created",
      level: "warn",
      userId: ctx.user.id,
      message: `${ctx.user.name || ctx.user.username} 生成了商城对接令牌（只能调商城对接）`,
      data: { tokenId: created.id, prefix: created.prefix, scope: "full", modules: ["shop"], expiresAt: created.expiresAt?.toISOString() ?? null },
    });
    console.info(`[ShopSync] token created id=${created.id} userId=${ctx.user.id}`);
    return { id: created.id, token: created.token, prefix: created.prefix, expiresAt: created.expiresAt };
  }),
});
