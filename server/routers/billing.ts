import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { refreshUserForwardEndpoints } from "./helpers";
import { adjustUserBalanceCommand, setUserBalanceCommand } from "../services/userCommandService";
import { clearForwardxAiSettingsCache } from "../ai/settings";
import { clientIp } from "../clientIp";
import { productStock } from "../../shared/productStock";
import { TRPCError } from "@trpc/server";
import { buildBillingExport } from "../billingExport";

const dateInput = z.string().trim().max(64).optional().nullable();

function parseDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getRequestIp(ctx: { req: { ip?: string; socket: { remoteAddress?: string } } }) {
  return clientIp(ctx.req, "unknown");
}

/**
 * 老的「一次返回全部」接口加的可选分页：不传时行为和原来完全一样（返回全部），
 * 传了 limit / offset 就只取这一段。新代码请用对应的 *Page 接口。
 */
const legacyListInput = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).max(10_000_000).optional(),
}).optional();

const billingPageInput = z.object({
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

/** 同一个人同一时间只跑一份导出：几万行的表连点几下就是几倍的库查询和内存。 */
const billingExportsInFlight = new Set<number>();

export const billingRouter = router({
  summary: adminProcedure.query(async () => db.getBillingAdminSummary()),

  featureStatus: protectedProcedure.query(async () => ({
    redemptionEnabled: (await db.getSetting("redemptionEnabled")) !== "false",
    discountEnabled: (await db.getSetting("discountEnabled")) !== "false",
  })),

  setFeatureStatus: adminProcedure
    .input(z.object({
      redemptionEnabled: z.boolean().optional(),
      discountEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      if (input.redemptionEnabled !== undefined) await db.setSetting("redemptionEnabled", input.redemptionEnabled ? "true" : "false");
      if (input.discountEnabled !== undefined) await db.setSetting("discountEnabled", input.discountEnabled ? "true" : "false");
      clearForwardxAiSettingsCache();
      appendPanelLog("info", `[Billing] feature status updated redemption=${input.redemptionEnabled ?? "-"} discount=${input.discountEnabled ?? "-"}`);
      return {
        redemptionEnabled: (await db.getSetting("redemptionEnabled")) !== "false",
        discountEnabled: (await db.getSetting("discountEnabled")) !== "false",
      };
    }),

  me: protectedProcedure.query(async ({ ctx }) => {
    const balanceCents = await db.getUserBalance(ctx.user.id);
    const transactions = await db.listBalanceTransactions(ctx.user.id, 50);
    return { balanceCents, transactions };
  }),

  listTransactions: adminProcedure
    .input(z.object({ userId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).default(100) }).optional())
    .query(async ({ input }) => db.listBalanceTransactions(input?.userId, input?.limit || 100)),

  /** 余额流水分页（管理员看全部或某个用户）。 */
  listTransactionsPage: adminProcedure
    .input(billingPageInput.extend({ userId: z.number().int().positive().optional() }))
    .query(async ({ input }) => db.listBalanceTransactionsPage(input)),

  /** 账单分页：普通用户只能看自己的，传别人的 userId 也只按自己算。 */
  ledgerPage: protectedProcedure
    .input(billingPageInput.extend({
      userId: z.number().int().positive().optional(),
      includeCancelledSubscriptions: z.boolean().default(false),
    }))
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.listBillingLedgerPage({
        viewerUserId: ctx.user.id,
        isAdmin,
        userId: isAdmin ? input.userId : undefined,
        includeCancelledSubscriptions: input.includeCancelledSubscriptions,
        page: input.page,
        pageSize: input.pageSize,
      });
    }),

  /**
   * 账单 Excel 导出（上游 2.3.286）。管理员可导出全部或指定用户；普通用户只导出自己的，
   * 传别人的 userId 也只按自己算（server/billingExport.ts）。是查询不是修改：只读令牌也能导。
   * 文件用 base64 带回去，前端存成 .xlsx。
   */
  exportXlsx: protectedProcedure
    .input(z.object({
      userId: z.number().int().positive().optional().nullable(),
      includeCancelledSubscriptions: z.boolean().default(true),
    }).optional())
    .query(async ({ input, ctx }) => {
      const viewerId = Number(ctx.user.id);
      if (billingExportsInFlight.has(viewerId)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "上一份账单还在导出，请稍候" });
      }
      billingExportsInFlight.add(viewerId);
      try {
        const exported = await buildBillingExport({
          viewer: { id: viewerId, role: String(ctx.user.role) },
          userId: input?.userId ?? null,
          includeCancelledSubscriptions: input?.includeCancelledSubscriptions ?? true,
        });
        appendPanelLog("info", `[Billing] export user=${viewerId} scope=${ctx.user.role === "admin" ? input?.userId ?? "all" : "self"} rows=${exported.counts.ledger}`);
        return { filename: exported.filename, dataBase64: exported.buffer.toString("base64"), counts: exported.counts };
      } finally {
        billingExportsInFlight.delete(viewerId);
      }
    }),

  ledger: protectedProcedure
    .input(z.object({
      userId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(500).default(100),
      includeCancelledSubscriptions: z.boolean().default(false),
    }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.listBillingLedger({
        viewerUserId: ctx.user.id,
        isAdmin,
        userId: isAdmin ? input?.userId : undefined,
        limit: input?.limit || 100,
        includeCancelledSubscriptions: input?.includeCancelledSubscriptions || false,
      });
    }),

  adminRecharge: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      amountCents: z.number().int().min(1).max(100_000_000),
      description: z.string().trim().max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await adjustUserBalanceCommand({
        actor: ctx.user,
        targetUserId: input.userId,
        amountCents: input.amountCents,
        description: input.description || "管理员手动充值",
        reasonPrefix: "balance-recharged",
      });
      appendPanelLog("info", `[Balance] admin recharge user=${input.userId} amount=${input.amountCents} operator=${ctx.user.id}`);
      return result;
    }),


  adminSetBalance: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      balanceCents: z.number().int().min(0).max(100_000_000),
      description: z.string().trim().max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await setUserBalanceCommand({
        actor: ctx.user,
        targetUserId: input.userId,
        balanceCents: input.balanceCents,
        description: input.description || "管理员手动修改余额",
        reasonPrefix: "balance-adjusted",
      });
      appendPanelLog("info", `[Balance] admin set user=${input.userId} balance=${input.balanceCents} delta=${result.amountCents} operator=${ctx.user.id}`);
      return result;
    }),
  purchasePlanWithBalance: protectedProcedure
    .input(z.object({
      planId: z.number().int().positive(),
      subscriptionId: z.number().int().positive().optional(),
      discountCode: z.string().trim().max(64).optional(),
      /** 买哪一档周期。不传 = 默认档，老客户端照旧能用。 */
      durationDays: z.number().int().positive().max(3650).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // 和在线支付下单同一个开关：商店关了，余额也不能买 / 续。
      if ((await db.getSetting("storeEnabled")) !== "true") throw new Error("商店功能未开启");
      const plan = await db.getSubscriptionPlanById(input.planId);
      if (!plan || !plan.isActive || !plan.isStoreVisible) throw new Error("套餐不可购买");
      // 已售罄的先拦下（续费不受库存限制）。并发下真正防超售的是开通事务里那条带条件的占额语句。
      if (!input.subscriptionId && productStock(plan).soldOut) throw new Error(db.PLAN_STOCK_SOLD_OUT_MESSAGE);
      // 折扣按**选中那一档**的价格预览，否则年付的单会按月付价算折扣。
      const { option } = await db.resolvePlanPricing(input.planId, input.durationDays ?? null);
      let discountCodeId: number | null = null;
      if (input.discountCode) {
        if ((await db.getSetting("discountEnabled")) === "false") throw new Error("折扣码功能已关闭");
        // 带上人和 IP 一起限流：否则余额 0 的人拿「折扣码不存在 / 余额不足」两种报错当
        // 判断码对不对的依据，可以无限次地猜。
        const preview = await db.previewDiscount(input.discountCode, Number(option.priceCents || 0), input.planId, {
          userId: ctx.user.id,
          attemptScope: getRequestIp(ctx),
        });
        discountCodeId = preview.discountCodeId;
      }
      const result = await db.purchasePlanWithBalance(
        ctx.user.id,
        input.planId,
        discountCodeId,
        input.subscriptionId,
        option.durationDays,
      );
      await refreshUserForwardEndpoints(ctx.user.id, "balance-plan-purchased");
      appendPanelLog("info", `[Plan] balance purchase user=${ctx.user.id} plan=${input.planId} duration=${option.durationDays}`);
      return result;
    }),

  purchaseTrafficAddonWithBalance: protectedProcedure
    .input(z.object({
      addonId: z.number().int().positive(),
      subscriptionId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // 和余额买套餐同一个开关：商店关了，流量包也不能买。
      if ((await db.getSetting("storeEnabled")) !== "true") throw new Error("商店功能未开启");
      const result = await db.purchaseTrafficAddonWithBalance(ctx.user.id, input.addonId, input.subscriptionId);
      await refreshUserForwardEndpoints(ctx.user.id, "traffic-addon-purchased");
      appendPanelLog("info", `[TrafficAddon] balance purchase user=${ctx.user.id} addon=${input.addonId} bytes=${result.trafficBytes}`);
      return result;
    }),

  adminAddTrafficAddon: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      trafficBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), // 超过安全整数就不是精确字节数了，bigint 列也会被写歪
      subscriptionId: z.number().int().positive().optional().nullable(),
      description: z.string().trim().max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await db.adminAddUserTrafficAddon({
        userId: input.userId,
        trafficBytes: input.trafficBytes,
        subscriptionId: input.subscriptionId ?? null,
        operatorUserId: ctx.user.id,
        description: input.description || null,
      });
      await refreshUserForwardEndpoints(input.userId, "traffic-addon-admin");
      appendPanelLog("info", `[TrafficAddon] admin add user=${input.userId} operator=${ctx.user.id} bytes=${input.trafficBytes}`);
      return result;
    }),

  previewDiscount: protectedProcedure
    .input(z.object({
      code: z.string().trim().min(1).max(64),
      amountCents: z.number().int().min(0).max(100_000_000),
      planId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if ((await db.getSetting("discountEnabled")) === "false") throw new Error("折扣码功能已关闭");
      // 带上人和来源 IP：这条路和兑换码一样是「拿码来问对不对」，得一起限流。
      return db.previewDiscount(input.code, input.amountCents, input.planId, {
        userId: ctx.user.id,
        attemptScope: getRequestIp(ctx),
      });
    }),

  redeem: protectedProcedure
    .input(z.object({ code: z.string().trim().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      if ((await db.getSetting("redemptionEnabled")) === "false") throw new Error("兑换码功能已关闭");
      const result = await db.redeemCode(ctx.user.id, input.code, getRequestIp(ctx));
      const recovery = await db.recoverUserForwardAccessIfEligible(ctx.user.id);
      await refreshUserForwardEndpoints(ctx.user.id, "code-redeemed");
      appendPanelLog("info", `[Redeem] user=${ctx.user.id} type=${result.type}`);
      return { ...result, forwardAccessRestored: recovery.restored };
    }),

  listRedemptionCodes: adminProcedure.input(legacyListInput).query(async ({ input }) => db.listRedemptionCodes(input)),

  listRedemptionCodesPage: adminProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(50),
      usage: z.enum(["all", "unused", "used"]).default("all"),
    }))
    .query(async ({ input }) => db.listRedemptionCodesPage(input)),
  createRedemptionCodes: adminProcedure
    .input(z.object({
      type: z.enum(["plan", "balance"]),
      code: z.string().trim().max(64).optional(),
      count: z.number().int().min(1).max(500).default(1),
      planId: z.number().int().positive().optional().nullable(),
      durationDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]).optional().nullable(),
      amountCents: z.number().int().min(0).max(100_000_000).default(0),
      startsAt: dateInput,
      expiresAt: dateInput,
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.type === "plan" && !input.planId) throw new Error("套餐兑换码必须选择套餐");
      if (input.type === "balance" && input.amountCents <= 0) throw new Error("余额兑换码金额必须大于 0");
      const codes = await db.createRedemptionCodes({
        type: input.type,
        code: input.code || undefined,
        planId: input.type === "plan" ? input.planId ?? null : null,
        durationDays: input.type === "plan" ? input.durationDays ?? 30 : null,
        amountCents: input.type === "balance" ? input.amountCents : 0,
        startsAt: parseDate(input.startsAt),
        expiresAt: parseDate(input.expiresAt),
        isActive: true,
        createdByUserId: ctx.user.id,
      } as any, input.count);
      appendPanelLog("info", `[Redeem] created count=${codes.length} type=${input.type}`);
      return { codes };
    }),

  deleteRedemptionCode: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteRedemptionCode(input.id);
      return { success: true };
    }),

  deleteRedemptionCodes: adminProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }))
    .mutation(async ({ input }) => {
      const ids = Array.from(new Set(input.ids));
      for (const id of ids) await db.deleteRedemptionCode(id);
      return { success: true, deleted: ids.length };
    }),

  listDiscountCodes: adminProcedure.input(legacyListInput).query(async ({ input }) => db.listDiscountCodes(input)),

  listDiscountCodesPage: adminProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => db.listDiscountCodesPage(input)),
  createDiscountCode: adminProcedure
    .input(z.object({
      code: z.string().trim().max(64).optional(),
      discountType: z.enum(["percent", "amount"]),
      discountValue: z.number().int().min(1).max(100_000_000),
      maxUses: z.number().int().min(0).max(1_000_000).default(0),
      planIds: z.array(z.number().int().positive()).max(1000).default([]),
      startsAt: dateInput,
      expiresAt: dateInput,
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.discountType === "percent" && input.discountValue > 100) throw new Error("百分比折扣不能超过 100");
      return db.createDiscountCode({
        code: input.code || undefined,
        discountType: input.discountType,
        discountValue: input.discountValue,
        maxUses: input.maxUses,
        startsAt: parseDate(input.startsAt),
        expiresAt: parseDate(input.expiresAt),
        isActive: true,
        createdByUserId: ctx.user.id,
      } as any, input.planIds);
    }),

  deleteDiscountCode: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteDiscountCode(input.id);
      return { success: true };
    }),
});
