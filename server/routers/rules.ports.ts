import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import {
  requireHostUseAccess,
  requireRuleAccess,
  requireTrafficBillingAccessIfConfigured,
  requireTunnelUseOrTrafficBillingAccess,
} from "./helpers";
import { assertTenantListenPortAllowedOnHosts } from "../tenantListenPortGuard";
import { resolveRuleOperationOwner } from "../ruleOperationOwner";
import { combineHostPortPolicyWithRange, combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom, type PortPolicy } from "@shared/portPolicy";

const randomPortInputSchema = z.object({
  // 管理员替所选用户建规则时，按那个用户的权限和套餐端口段来挑（server/ruleOperationOwner.ts）。
  userId: z.number().int().positive().optional(),
  hostId: z.number().optional(),
  tunnelId: z.number().nullable().optional(),
  forwardGroupId: z.number().optional(),
  excludeRuleId: z.number().optional(),
  protocol: z.enum(["tcp", "udp", "both"]).optional().default("both"),
});

async function requireForwardGroupPortAccess(ctx: { user: { id: number; role: string } }, forwardGroupId: number) {
  if (ctx.user.role === "admin") return;
  const isTrafficBillingResource = await requireTrafficBillingAccessIfConfigured(
    ctx,
    "forward_group",
    forwardGroupId,
  );
  if (isTrafficBillingResource) return;
  const hasPermission = await db.checkUserForwardGroupPermission(ctx.user.id, forwardGroupId);
  if (!hasPermission) throw new Error("无权使用该转发组");
}

/**
 * 一条规则的入口端口到底允许哪些 —— 只有这里说了算。
 *
 * 三样东西叠在一起：主机自己的范围与白名单、隧道配的范围、以及非管理员的
 * 套餐端口段。之所以要单独抽出来，是因为界面上也要**显示**同一套答案：
 * 界面以前自己照着算了一份，用的是直接求交而不是这里的
 * combineHostPortPolicyWithRange —— 两者在「隧道范围恰好等于主机范围」时
 * 结论不一样，主机白名单里那些额外端口会被界面吃掉。结果就是用户被拦在一个
 * 服务端明明放行的端口上，连请求都发不出去。
 *
 * base 和 plan 分开返回，是因为 checkPort 要对这两类给不同的话术
 * （「端口不在允许范围」和「套餐端口必须在…」）。
 */
async function resolveEntryPortPolicy(
  ctx: { user: { id: number; role: string } },
  input: { hostId: number; tunnelId?: number | null },
): Promise<{ base: PortPolicy; plan: PortPolicy | null; effective: PortPolicy }> {
  const hostId = Number(input.hostId);
  let base = portPolicyFrom(null);
  if (input.tunnelId) {
    const { tunnel } = await requireTunnelUseOrTrafficBillingAccess(ctx, input.tunnelId);
    if (tunnel.entryHostId !== hostId) throw new Error("隧道入口主机与规则主机不一致");
    const host = await db.getHostById(hostId);
    base = combineHostPortPolicyWithRange(
      host as any,
      (tunnel as any).portRangeStart,
      (tunnel as any).portRangeEnd,
    );
  } else {
    const { host } = await requireHostUseAccess(ctx, hostId);
    base = portPolicyFrom(host as any);
  }
  let plan: PortPolicy | null = null;
  if (ctx.user.role !== "admin") {
    const planRange = await db.getUserPlanPortRange(ctx.user.id, hostId, input.tunnelId ?? undefined);
    if (planRange) plan = portPolicyFrom({ portRanges: planRange.ranges });
  }
  return { base, plan, effective: plan ? combinePortPolicies(base, plan) : base };
}

/**
 * 转发组的入口端口允许哪些 —— 组里每个占端口的成员取交集，再叠上套餐端口段。
 *
 * 校验走的是 validateForwardGroupRuleConfig，它内部用的是同一个
 * forwardGroupEntryPortPolicy，所以显示和判定同源。
 */
async function resolveForwardGroupPortPolicy(
  ctx: { user: { id: number; role: string } },
  forwardGroupId: number,
): Promise<{ base: PortPolicy; plan: PortPolicy | null; effective: PortPolicy }> {
  await requireForwardGroupPortAccess(ctx, forwardGroupId);
  const base = await db.getForwardGroupEntryPortPolicy(forwardGroupId);
  let plan: PortPolicy | null = null;
  if (ctx.user.role !== "admin") {
    const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, forwardGroupId);
    if (planRange) plan = portPolicyFrom({ portRanges: planRange.ranges });
  }
  return { base, plan, effective: plan ? combinePortPolicies(base, plan) : base };
}

export const portsRulesRouter = router({
  /**
   * The effective entry port policy, for the dialog's hint.
   *
   * 界面拿它来显示「允许端口范围」，并且**不再**自己算一遍。主机/隧道和
   * 转发组两条路都走这里，各自和对应的校验同源。
   */
  entryPortPolicy: protectedProcedure
    .input(z.object({
      userId: z.number().int().positive().optional(),
      hostId: z.number().int().positive().optional(),
      forwardGroupId: z.number().int().positive().optional(),
      tunnelId: z.number().nullable().optional(),
    }).refine(
      (input) => !!input.hostId !== !!input.forwardGroupId,
      { message: "请选择一个主机、隧道或转发组" },
    ))
    .query(async ({ input, ctx }) => {
      ctx = { ...ctx, user: await resolveRuleOperationOwner(ctx.user, input.userId) as any };
      if (input.forwardGroupId) {
        const { effective } = await resolveForwardGroupPortPolicy(ctx, input.forwardGroupId);
        return { policy: effective };
      }
      const { effective } = await resolveEntryPortPolicy(ctx, {
        hostId: Number(input.hostId),
        tunnelId: input.tunnelId,
      });
      return { policy: effective };
    }),
  checkPort: protectedProcedure
    .input(z.object({
      userId: z.number().int().positive().optional(),
      hostId: z.number().int().positive().optional(),
      forwardGroupId: z.number().int().positive().optional(),
      tunnelId: z.number().nullable().optional(),
      sourcePort: z.number().int().min(1).max(65535),
      excludeRuleId: z.number().optional(),
      protocol: z.enum(["tcp", "udp", "both"]).optional().default("both"),
    }).refine(
      (input) => !!input.hostId !== !!input.forwardGroupId,
      { message: "请选择一个主机、隧道或转发组" },
    ))
    .query(async ({ input, ctx }) => {
      ctx = { ...ctx, user: await resolveRuleOperationOwner(ctx.user, input.userId) as any };
      if (input.excludeRuleId) {
        await requireRuleAccess(ctx, input.excludeRuleId);
      }
      if (input.forwardGroupId) {
        if (ctx.user.role !== "admin") {
          await requireForwardGroupPortAccess(ctx, input.forwardGroupId);
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, input.forwardGroupId);
          if (planRange && !db.isPortAllowedByUserPlanRange(input.sourcePort, planRange)) {
            const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
            return { used: true, reason: `套餐端口必须在 ${ranges} 范围内` };
          }
        }
        try {
          // 和保存时同一道闸：共享入口上的系统端口、面板端口不能让租户误以为「可用」。
          await assertTenantListenPortAllowedOnHosts({ actor: ctx.user, hostIds: await db.getForwardGroupRuleEntryHostIds(input.forwardGroupId), port: input.sourcePort, label: "入口端口" });
        } catch (error) {
          return { used: true, reason: error instanceof Error ? error.message : "端口不可用" };
        }
        try {
          await db.validateForwardGroupRuleConfig(input.forwardGroupId, {
            sourcePort: input.sourcePort,
            protocol: input.protocol,
            excludeTemplateRuleId: input.excludeRuleId,
          });
          return { used: false };
        } catch (error) {
          const reason = error instanceof Error ? error.message : "";
          const isRangeError = /必须在.*(?:范围|区间)|must be.*range/i.test(reason);
          return {
            used: true,
            ...(isRangeError ? { reason } : {}),
          };
        }
      }

      const hostId = Number(input.hostId);
      const { base, plan, effective } = await resolveEntryPortPolicy(ctx, {
        hostId,
        tunnelId: input.tunnelId,
      });
      if (!isPortAllowedByPolicy(input.sourcePort, base)) {
        return { used: true, reason: portPolicyErrorMessage(base) };
      }
      if (plan && !isPortAllowedByPolicy(input.sourcePort, effective)) {
        return { used: true, reason: portPolicyErrorMessage(effective, "套餐端口") };
      }
      try {
        await assertTenantListenPortAllowedOnHosts({ actor: ctx.user, hostIds: [hostId], port: input.sourcePort, label: "源端口" });
      } catch (error) {
        return { used: true, reason: error instanceof Error ? error.message : "端口不可用" };
      }
      const excludeRuleIds = input.excludeRuleId
        ? [
            input.excludeRuleId,
            ...((await db.getForwardGroupChildRulesForTemplate(input.excludeRuleId)) as any[]).map((rule: any) => Number(rule.id)),
          ]
        : [];
      // 隧道挂了入口组时，组里每台主机也要在这个端口上监听，任一台被占就算占用。
      let used = false;
      const listenHostIds = await db.forwardRuleListenHostIds(hostId, input.tunnelId);
      for (const listenHostId of listenHostIds) {
        if (await db.isPortUsedOnHost(listenHostId, input.sourcePort, excludeRuleIds, input.protocol, undefined, false)) {
          used = true;
          break;
        }
      }
      // 被换隧道后的临时桥接占着：告诉用户这是暂时的、多久后放开（server/ruleEntryBridges）。
      const bridgeReason = used
        ? await db.entryBridgePortConflictMessageForHosts(listenHostIds, input.sourcePort, excludeRuleIds)
        : null;
      return bridgeReason ? { used, reason: bridgeReason } : { used };
    }),
  randomPort: protectedProcedure
    .input(randomPortInputSchema)
    .query(async ({ input, ctx }) => {
      ctx = { ...ctx, user: await resolveRuleOperationOwner(ctx.user, input.userId) as any };
      if (input.excludeRuleId) {
        await requireRuleAccess(ctx, input.excludeRuleId);
      }
      if (input.forwardGroupId) {
        let planRange: Awaited<ReturnType<typeof db.getUserForwardGroupPlanPortRange>> = null;
        if (ctx.user.role !== "admin") {
          await requireForwardGroupPortAccess(ctx, input.forwardGroupId);
          planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, input.forwardGroupId);
        }
        const port = await db.findAvailableForwardGroupPort(input.forwardGroupId, input.excludeRuleId, planRange, input.protocol);
        if (!port) throw new Error("转发组入口端口区间内已无可用端口");
        return { port };
      }
      if (!input.hostId) throw new Error("请选择主机");
      let rangeStart: number | null | undefined;
      let rangeEnd: number | null | undefined;
      let planRange: Awaited<ReturnType<typeof db.getUserPlanPortRange>> = null;
      if (input.tunnelId) {
        const { tunnel } = await requireTunnelUseOrTrafficBillingAccess(ctx, input.tunnelId);
        if (tunnel.entryHostId !== input.hostId) throw new Error("隧道入口主机与规则主机不一致");
        rangeStart = (tunnel as any).portRangeStart;
        rangeEnd = (tunnel as any).portRangeEnd;
      } else {
        await requireHostUseAccess(ctx, input.hostId);
      }
      if (ctx.user.role !== "admin") {
        planRange = await db.getUserPlanPortRange(ctx.user.id, input.hostId, input.tunnelId ?? undefined);
        // Keep the subscription's disjoint ranges intact. The repository
        // intersects them with the host/tunnel policy when selecting a port.
      }
      const excludeRuleIds = input.excludeRuleId
        ? [
            input.excludeRuleId,
            ...((await db.getForwardGroupChildRulesForTemplate(input.excludeRuleId)) as any[]).map((rule: any) => Number(rule.id)),
          ]
        : [];
      const listenHostIds = await db.forwardRuleListenHostIds(input.hostId, input.tunnelId);
      const port = await db.findAvailablePort(
        input.hostId,
        rangeStart,
        rangeEnd,
        input.protocol,
        // 入口组里其他主机上已占用的端口也不能挑。
        await db.usedPortsOnOtherListenHosts(input.hostId, listenHostIds, excludeRuleIds, input.protocol),
        excludeRuleIds,
        planRange?.ranges || [],
      );
      if (!port) throw new Error("该主机端口区间内已无可用端口");
      return { port };
    }),
});
