import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { requireHostUseAccess } from "./helpers";
import { forwardTypeSchema } from "./schemas";
import { resolveRuleOperationOwner } from "../ruleOperationOwner";
import { createRuleBatch, describeRuleBatchResult, previewRuleBatch } from "../ruleBatchCreate";
import { appendPanelLog } from "../_core/panelLogger";

/**
 * 规则列表「批量添加」（server/ruleBatchCreate.ts）：先 batchPreview 看逐行结论，确认后 batchCreate。
 * 每条规则仍走 createDirectForwardRuleForActor，权限、配额、端口检查、审计都和单条新建一样。
 */
const batchInputSchema = z.object({
  // 管理员在规则页选了某个用户时，规则归他（见 server/ruleOperationOwner.ts）。
  userId: z.number().int().positive().optional(),
  hostId: z.number().int().positive(),
  forwardType: forwardTypeSchema,
  protocol: z.enum(["tcp", "udp", "both"]).default("both"),
  text: z.string().max(40_000),
});

export const batchRulesRouter = router({
  batchPreview: protectedProcedure
    .input(batchInputSchema)
    .mutation(async ({ input, ctx }) => {
      const actor = await resolveRuleOperationOwner(ctx.user, input.userId) as { id: number; role: string };
      await requireHostUseAccess({ user: actor }, input.hostId);
      return { rows: await previewRuleBatch(actor, input) };
    }),
  batchCreate: protectedProcedure
    .input(batchInputSchema)
    .mutation(async ({ input, ctx }) => {
      const actor = await resolveRuleOperationOwner(ctx.user, input.userId) as { id: number; role: string; allowedForwardTypes?: string | null };
      await requireHostUseAccess({ user: actor }, input.hostId);
      // 动态导入：rules.ts 同时挂着 rules.crud 和这里，静态引用会在加载顺序不同时撞上未初始化的路由。
      const { createDirectForwardRuleForActor } = await import("./rules.crud");
      const result = await createRuleBatch(actor, input, (row) => createDirectForwardRuleForActor(actor, {
        hostId: input.hostId,
        name: row.remark || "",
        forwardType: input.forwardType,
        protocol: input.protocol,
        gostMode: "direct",
        tunnelId: null,
        forwardGroupId: null,
        sourcePort: row.sourcePort,
        sourcePortEnd: row.sourcePortEnd ?? null,
        targetIp: row.targetIp,
        targetPort: row.targetPort,
        targetPortEnd: row.targetPortEnd ?? null,
        isEnabled: true,
        telegramErrorNotifyEnabled: false,
        failoverEnabled: false,
        failoverStrategy: "fallback",
        failoverTargets: [],
        failoverSeconds: 60,
        recoverSeconds: 120,
        autoFailback: true,
      }, { reasonPrefix: "forward-rule-batch" }));
      appendPanelLog("info", `[RuleBatch] user=${ctx.user.id} owner=${actor.id} host=${input.hostId} ${describeRuleBatchResult(result)}`);
      return { ...result, summary: describeRuleBatchResult(result) };
    }),
});
