import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { createQueryCache } from "../queryCache";
import {
  createForwardGroupFromInput,
  deleteForwardGroupWithImpact,
  getForwardGroupDeleteImpact,
  runForwardGroupChainSelfTest,
  updateForwardGroupFromInput,
} from "../services/forwardGroupService";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { EXIT_GROUP_STRATEGIES } from "../../shared/exitStrategy";
import { FORWARD_GROUP_HEALTH_CHECK_METHODS } from "../../shared/forwardGroupHealthCheck";
import {
  BANDWIDTH_AGGREGATION_STRATEGIES,
  MAX_AGGREGATION_RECORD_SLOTS,
  MAX_MEMBER_BANDWIDTH_MBPS,
  MAX_MEMBER_WEIGHT,
} from "../../shared/bandwidthAggregation";
import { getLinkAccessScope, visibleForwardGroupMemberIds, type LinkAccessScope } from "../linkAccessView";
import {
  anyForwardGroupHasTunnelMember,
  buildForwardGroupAvailabilitySummaryIndex,
  publicLinkAvailabilitySummary,
  type LinkAvailabilitySummaryIndex,
} from "../linkAvailabilitySummary";

const failoverStrategySchema = z.enum(["fallback", "round_robin", "random", "ip_hash"]);
const exitGroupStrategySchema = z.enum(EXIT_GROUP_STRATEGIES);
const failoverTargetSchema = z.object({
  targetIp: z.string().min(1).max(253),
  targetPort: z.number().int().min(1).max(65535),
});

const memberSchema = z.object({
  memberType: z.enum(["host", "tunnel"]),
  hostId: z.number().nullable().optional(),
  tunnelId: z.number().nullable().optional(),
  connectHost: z.string().max(253).nullable().optional(),
  priority: z.number().int().min(0).optional(),
  isEnabled: z.boolean().optional(),
  bandwidthMbps: z.number().int().min(0).max(MAX_MEMBER_BANDWIDTH_MBPS).nullable().optional(),
  aggregationWeight: z.number().int().min(0).max(MAX_MEMBER_WEIGHT).nullable().optional(),
});

const forwardGroupQueryCache = createQueryCache(300);

const baseSchema = z.object({
  name: z.string().min(1).max(128),
  remark: z.string().max(255).nullable().optional(),
  groupMode: z.enum(["port", "failover", "chain", "entry", "exit"]).default("failover"),
  exitStrategy: exitGroupStrategySchema.optional().default("round_robin"),
  entryGroupId: z.number().nullable().optional(),
  groupType: z.enum(["host", "tunnel"]),
  protocol: z.enum(["tcp", "udp", "both"]).optional().default("both"),
  forwardType: z.enum(["iptables", "nftables", "realm", "socat", "gost", "nginx"]).optional(),
  proxyProtocolReceive: z.boolean().optional(),
  proxyProtocolSend: z.boolean().optional(),
  proxyProtocolExitReceive: z.boolean().optional(),
  proxyProtocolExitSend: z.boolean().optional(),
  proxyProtocolVersion: z.number().int().min(1).max(2).optional(),
  tcpFastOpen: z.boolean().optional(),
  zeroCopy: z.boolean().optional(),
  udpOverTcp: z.boolean().optional(),
  udpOverTcpPort: z.number().int().min(0).max(65535).nullable().optional(),
  failoverEnabled: z.boolean().optional(),
  failoverStrategy: failoverStrategySchema.optional(),
  failoverTargets: z.array(failoverTargetSchema).max(10).optional(),
  domain: z.string().max(255).nullable().optional(),
  recordType: z.enum(["A", "AAAA", "CNAME"]).default("A"),
  failoverSeconds: z.number().int().min(10).max(3600).default(60),
  recoverSeconds: z.number().int().min(10).max(3600).default(120),
  rateLimitMbps: z.number().int().min(0).max(1_000_000).optional().default(0),
  trafficMultiplier: z.number().int().min(1).max(5000).optional().default(100),
  chinaHealthCheckEnabled: z.boolean().default(false),
  chinaHealthCheckTarget: z.string().max(253).nullable().optional(),
  chinaHealthCheckMethod: z.enum(FORWARD_GROUP_HEALTH_CHECK_METHODS).optional().default("tcp"),
  telegramSwitchNotifyEnabled: z.boolean().default(false),
  ddnsAutoResolveEnabled: z.boolean().default(true),
  bandwidthAggregationEnabled: z.boolean().optional().default(false),
  bandwidthAggregationStrategy: z.enum(BANDWIDTH_AGGREGATION_STRATEGIES).optional().default("capacity"),
  bandwidthAggregationSlots: z.number().int().min(1).max(MAX_AGGREGATION_RECORD_SLOTS).optional().default(8),
  bandwidthAggregationMinMembers: z.number().int().min(1).max(5).optional().default(1),
  autoFailback: z.boolean().default(true),
  isEnabled: z.boolean().default(true),
  // 端口转发挂了入口组时可以没有自己的成员，下限由 service 按形态判
  members: z.array(memberSchema),
});

async function assertForwardGroupAccess(
  groupId: number,
  user: { id: number; role: string },
  options: { allowNull?: boolean; silentUnauthorized?: boolean } = {},
) {
  const group = await db.getForwardGroupById(groupId) as any;
  if (!group) {
    if (options.allowNull) return null;
    throw new Error("转发组不存在");
  }
  if (user.role !== "admin" && Number(group.userId) !== Number(user.id)) {
    const allowed = await db.checkUserForwardGroupPermission(user.id, groupId);
    if (!allowed && options.silentUnauthorized) return null;
    if (!allowed) throw new Error("无权访问此转发组");
  }
  return group;
}

function attachForwardGroupAvailability(
  groups: any[],
  availabilityIndex: LinkAvailabilitySummaryIndex,
  accessScope: LinkAccessScope | null,
) {
  return groups.map((group) => ({
    ...group,
    availability: publicLinkAvailabilitySummary(
      availabilityIndex.groupAvailabilityById.get(Number(group.id)),
      visibleForwardGroupMemberIds(group, accessScope),
    ),
  }));
}

function availabilityIndexForGroups(groups: any[], supportingGroups: any[] = [], options: { loadHostStatus?: boolean } = {}) {
  return buildForwardGroupAvailabilitySummaryIndex(groups, supportingGroups, options);
}

export const forwardGroupsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const accessScope = await getLinkAccessScope(ctx.user);
    if (!accessScope) {
      const groups = await db.getForwardGroups(undefined, { includeRuntime: true }) as any[];
      const availabilityIndex = await availabilityIndexForGroups(groups);
      return attachForwardGroupAvailability(groups, availabilityIndex, null);
    }
    /*
      租户以前也是先把全站的组连同成员、模板、子规则、延迟整表读出来，再丢掉看不见的。
      现在只读看得见的组；可用性要用到的另外几类组照样补齐，结果和整表算时一致：
      - 转发链的入口组（entryGroupId）：可见范围本来就会把它带上，不在的话这里单独补；
      - 隧道成员的入口 / 出口组：可用性计算里自己按需去取；
      - 主机在线的来源：全站有隧道成员时整表那条路按主机状态行取，这里照着同一个判据走。
    */
    const visibleIds = Array.from(accessScope.groupIds).filter((id) => Number(id) > 0);
    const [visible, hasTunnelMembers] = await Promise.all([
      visibleIds.length > 0
        ? db.getForwardGroups(undefined, { includeRuntime: true, ids: visibleIds }) as Promise<any[]>
        : Promise.resolve([] as any[]),
      anyForwardGroupHasTunnelMember(),
    ]);
    const entryGroupIds = Array.from(new Set(visible
      .map((group: any) => Number(group.entryGroupId || 0))
      .filter((id) => id > 0 && !accessScope.groupIds.has(id))));
    const supportingGroups = entryGroupIds.length > 0
      ? await db.getForwardGroups(undefined, { includeRuntime: false, ids: entryGroupIds }) as any[]
      : [];
    const availabilityIndex = await availabilityIndexForGroups(visible, supportingGroups, { loadHostStatus: hasTunnelMembers });
    return db.filterForwardGroupFieldsForUse(
      attachForwardGroupAvailability(visible, availabilityIndex, accessScope),
      accessScope,
    );
  }),

  options: protectedProcedure.query(async ({ ctx }) => {
    const accessScope = await getLinkAccessScope(ctx.user);
    const allowedGroupIds = accessScope
      ? Array.from(accessScope.useGroupIds || accessScope.groupIds)
      : undefined;
    const groups = await db.getForwardGroupOptions(allowedGroupIds);
    const itemIds = new Set((groups as any[]).map((group) => Number(group.id)));
    const relatedIds = Array.from(new Set((groups as any[])
      .map((group) => Number(group.entryGroupId || 0))
      .filter((id) => id > 0 && !itemIds.has(id))));
    const supportingGroups = relatedIds.length > 0
      ? await db.getForwardGroups(undefined, { includeRuntime: false, ids: relatedIds }) as any[]
      : [];
    const availabilityIndex = await availabilityIndexForGroups(groups as any[], supportingGroups);
    const withAvailability = attachForwardGroupAvailability(groups as any[], availabilityIndex, accessScope);
    if (!accessScope) return withAvailability;
    const visibleGroups = db.filterForwardGroupFieldsForUse(withAvailability, accessScope);
    if (supportingGroups.length === 0) return visibleGroups;

    // A chain's entry group is loaded above for availability, but it is not
    // itself a selectable root resource and therefore is intentionally not
    // included in `groups`. Keep a sanitized copy nested on the chain so
    // users can still see the configured entry domain in rule displays.
    const allowedSupportingGroups = supportingGroups
      .filter((group: any) => accessScope.groupIds.has(Number(group?.id || 0)));
    const visibleSupportingGroups = db.filterForwardGroupFieldsForUse(
      attachForwardGroupAvailability(allowedSupportingGroups, availabilityIndex, accessScope),
      accessScope,
    );
    const supportingById = new Map(visibleSupportingGroups.map((group: any) => [Number(group.id), group]));
    return visibleGroups.map((group: any) => {
      const entryGroupId = Number(group?.entryGroupId || 0);
      const entryGroup = entryGroupId > 0 ? supportingById.get(entryGroupId) : null;
      return entryGroup ? { ...group, entryGroup } : group;
    });
  }),

  listPage: protectedProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(12),
      groupMode: z.enum(["port", "failover", "chain", "entry", "exit"]),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const accessScope = await getLinkAccessScope(ctx.user);
      const allowedGroupIds = accessScope ? Array.from(accessScope.groupIds) : undefined;
      const result = await db.getForwardGroupsPage({
        ...input,
        allowedGroupIds,
      });
      const itemIds = new Set((result.items as any[]).map((group: any) => Number(group.id)));
      const relatedGroupIds = Array.from(new Set((result.items as any[])
        .map((group: any) => Number(group.entryGroupId || 0))
        .filter((id: number) => id > 0
          && !itemIds.has(id))));
      const relatedRows = relatedGroupIds.length > 0
        ? await db.getForwardGroups(undefined, {
          includeRuntime: false,
          ids: relatedGroupIds,
        })
        : [];
      const availabilityIndex = await availabilityIndexForGroups(result.items as any[], relatedRows as any[]);
      const hydratedItems = attachForwardGroupAvailability(result.items as any[], availabilityIndex, accessScope);
      const items = accessScope
        ? db.filterForwardGroupFieldsForUse(hydratedItems, accessScope)
        : hydratedItems;
      const visibleRelatedRows = accessScope
        ? (relatedRows as any[]).filter((group) => accessScope.groupIds.has(Number(group.id)))
        : relatedRows as any[];
      const hydratedRelated = attachForwardGroupAvailability(visibleRelatedRows, availabilityIndex, accessScope);
      const relatedGroups = accessScope
        ? db.filterForwardGroupFieldsForUse(hydratedRelated, accessScope)
        : hydratedRelated;
      return {
        ...result,
        items,
        relatedGroups,
      };
    }),

  reorderGroups: adminProcedure
    .input(z.object({
      groupMode: z.enum(["port", "failover", "chain", "entry", "exit"]),
      ids: z.array(z.number().int().positive()).min(1),
      startIndex: z.number().int().min(0).max(1_000_000).optional().default(0),
    }))
    .mutation(async ({ input }) => {
      await db.reorderForwardGroups(input.groupMode, input.ids, input.startIndex);
      return { success: true };
    }),

  latencySeries: protectedProcedure
    .input(z.object({
      groupId: z.number(),
      hours: z.number().min(0.5).max(24 * 3).default(24),
    }))
    .query(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user);
      if (String(group.groupMode || "failover") !== "chain") throw new Error("仅转发链支持链路延迟图表");
      const since = new Date(Date.now() - input.hours * 3600 * 1000);
      return forwardGroupQueryCache.get(
        `latencySeries:${ctx.user.id}:${input.groupId}:${input.hours}`,
        { ttlMs: 5_000, staleMs: 0 },
        () => db.getForwardGroupLatencySeries(input.groupId, { since }),
      );
    }),

  // Live status of an entry group's multi-front-VPS bandwidth aggregation:
  // aggregate capacity, current throughput and the share each front VPS carries.
  bandwidthAggregation: protectedProcedure
    .input(z.object({ groupId: z.number() }))
    .query(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user, { allowNull: true, silentUnauthorized: true });
      if (!group || String(group.groupMode || "") !== "entry") return null;
      return forwardGroupQueryCache.get(
        `bandwidthAggregation:${ctx.user.id}:${input.groupId}`,
        { ttlMs: 10_000, staleMs: 0 },
        () => db.getForwardGroupBandwidthAggregation(input.groupId),
      );
    }),

  latestTest: protectedProcedure
    .input(z.object({ groupId: z.number(), includeActive: z.boolean().optional().default(true) }))
    .query(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user, { allowNull: true, silentUnauthorized: true });
      if (!group) return null;
      return await db.getLatestForwardGroupTest(input.groupId, { includeActive: input.includeActive }) || null;
    }),

  test: protectedProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user);
      if (String(group.groupMode || "failover") !== "chain") throw new Error("仅转发链支持链路自测");
      return runForwardGroupChainSelfTest(input.groupId);
    }),

  events: adminProcedure
    .input(z.object({ groupId: z.number(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      return db.getForwardGroupEvents(input.groupId, input.limit);
    }),

  create: adminProcedure
    .input(baseSchema)
    .mutation(async ({ input, ctx }) => {
      const id = await createForwardGroupFromInput(input, ctx.user.id);
      return { id };
    }),

  update: adminProcedure
    .input(baseSchema.extend({ id: z.number() }))
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.id}`, async () => {
      const group = await updateForwardGroupFromInput(input.id, input);
      return { success: true, group };
    })),

  toggle: adminProcedure
    .input(z.object({ id: z.number().int().positive(), isEnabled: z.boolean() }))
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.id}`, async () => {
      return db.setForwardGroupEnabled(input.id, input.isEnabled);
    })),

  deleteImpact: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const group = await db.getForwardGroupById(input.id);
      if (!group) throw new Error("转发组不存在");
      return getForwardGroupDeleteImpact(input.id);
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number(), confirmRules: z.boolean().optional() }))
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.id}`, async () => {
      return deleteForwardGroupWithImpact(input.id, input.confirmRules);
    })),

  reorder: adminProcedure
    .input(z.object({ groupId: z.number(), memberIds: z.array(z.number().int().positive()).min(1) }))
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.groupId}`, async () => {
      await db.reorderForwardGroupMembers(input.groupId, input.memberIds);
      await db.runForwardGroupFailover(input.groupId, { forcePriority: true, forceSync: true });
      return { success: true };
    })),

  sync: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.id}`, async () => {
      await db.syncForwardGroupRules(input.id);
      await db.runForwardGroupFailover(input.id, { forcePriority: true, forceSync: true });
      return { success: true };
    })),

  runFailover: adminProcedure.mutation(async () => {
    await db.runForwardGroupFailoverSweep({ manual: true });
    return { success: true };
  }),
});
