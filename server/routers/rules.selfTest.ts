import { startRuleSelfTest } from "../ruleSelfTestStart";
import { diagnosisRouteOutdated } from "@shared/diagnosisRoute";
import * as hopRepo from "../repositories/tunnelRepository";
import { protectedProcedure, router } from "../_core/trpc";
import { ruleSourcePortEnd } from "@shared/portRange";
import { z } from "zod";
import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import { enqueueRuleConnectionsTask, getRuleConnectionsTaskStatus } from "../ruleConnectionsAgentTasks";
import { isUserspaceForwardType, normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import { ruleLatencySeriesQueryCache as selfTestQueryCache } from "../ruleLatencyQueryCache";
import { getLatencyDailyHistory } from "../repositories/latencyDailyRepository";

/*
  走 NEX 隧道的规则：隧道上任何一台的 FXP 握不上当前协议，自检里的 tcping 照样会通（端口是
  Agent 在听），可真实流量全超时。先查成员主机报上来的 FXP 版本，有问题就直接给一条失败的
  自检结果，把哪台、什么版本、怎么修写清楚。
*/
export const selfTestRulesRouter = router({
  /** 累计真实探测次数（Agent 2.2.229+）；available=false 时前端退回按状态样本统计。 */
  probeStatistics: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive(), hours: z.number().min(0.5).max(24 * 3).default(24) }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权查看此规则");
      return selfTestQueryCache.get(
        `probeStatistics:${ctx.user.id}:${input.ruleId}:${input.hours}`,
        { ttlMs: 5_000, staleMs: 0 },
        () => db.getTcpingProbeStatisticsByRule(input.ruleId, new Date(Date.now() - input.hours * 3600_000)),
      );
    }),
  tcpingSeries: protectedProcedure
      .input(z.object({
        ruleId: z.number(),
        hours: z.number().min(0.5).max(24 * 3).default(24),
      }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权查看此规则");
      }
      const since = new Date(Date.now() - input.hours * 3600 * 1000);
      return selfTestQueryCache.get(
        `tcpingSeries:${ctx.user.id}:${input.ruleId}:${input.hours}`,
        { ttlMs: 5_000, staleMs: 0 },
        () => db.getTcpingSeriesByRule(input.ruleId, { since }),
      );
    }),

  /** 近 30 天按天的延迟汇总（详情弹窗里那条色块），见 shared/latencyHistory.ts。 */
  latencyHistory: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权查看此规则");
      }
      return selfTestQueryCache.get(
        `latencyHistory:${input.ruleId}`,
        { ttlMs: 60_000, staleMs: 0 },
        async () => (await getLatencyDailyHistory("rule", [input.ruleId])).get(input.ruleId) || [],
      );
    }),

  startSelfTest: protectedProcedure
    .input(z.object({ ruleId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权操作此规则");
      }
      return startRuleSelfTest(rule);
    }),

  /**
   * 「连接」页签：排一个任务让入口机的 Agent 现场读一遍这条规则此刻的连接（shared/ruleConnections）。
   * 走隧道的规则看的是入口那一段（客户端连进来的那头）。
   */
  connectionsStart: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId) as any;
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权查看此规则");
      const hostId = Number(rule.hostId);
      const host = await db.getHostById(hostId) as any;
      if (!host) throw new Error("规则所在的机器不存在");
      if (!host.isOnline) throw new Error("机器离线，取不到连接清单");
      const task = enqueueRuleConnectionsTask(hostId, {
        ruleId: Number(rule.id),
        port: Number(rule.sourcePort),
        portEnd: ruleSourcePortEnd(rule),
        protocol: normalizeForwardRuleProtocol(rule.protocol),
        dnat: !isUserspaceForwardType(rule.forwardType),
      });
      pushAgentRefresh(hostId, "rule-connections", { urgent: true });
      return { taskId: task.taskId };
    }),
  connectionsStatus: protectedProcedure
    .input(z.object({ taskId: z.string().min(8).max(64) }))
    .query(async ({ input, ctx }) => {
      const status = getRuleConnectionsTaskStatus(input.taskId);
      if (!status) return null;
      const rule = await db.getForwardRuleById(status.ruleId) as any;
      if (!rule || (ctx.user.role !== "admin" && rule.userId !== ctx.user.id)) return null;
      return status;
    }),
  latestTest: protectedProcedure
    .input(z.object({ ruleId: z.number(), includeActive: z.boolean().optional().default(true) }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) return null;
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        return null;
      }
      const t = await db.getLatestForwardTest(input.ruleId, { includeActive: input.includeActive });
      if (!t) return null;
      /*
        这份诊断是不是旧路线测的（shared/diagnosisRoute.ts）：规则换了隧道 / 目标，隧道换了入口 / 出口 / 中转 / 出口组，
        或者诊断早于链路最近一次换拓扑的时间。弹窗据此按现在的配置画、自动重测，不再停在旧路线上。
      */
      const tunnel = Number(rule.tunnelId || 0) > 0 ? await db.getTunnelById(Number(rule.tunnelId)).catch(() => null) as Record<string, unknown> | null : null;
      let tunnelExitHostIds: number[] = [];
      if (tunnel) {
        const [exitNodes, group] = await Promise.all([
          hopRepo.getTunnelExitNodes(Number(tunnel.id)).catch(() => [] as Array<{ hostId?: unknown }>),
          Number(tunnel.exitGroupId || 0) > 0 ? db.getForwardGroupById(Number(tunnel.exitGroupId)).catch(() => null) as Promise<{ members?: Array<{ hostId?: unknown }> } | null> : Promise.resolve(null),
        ]);
        tunnelExitHostIds = [
          Number(tunnel.exitHostId || 0),
          ...(exitNodes as Array<{ hostId?: unknown }>).map((node) => Number(node.hostId || 0)),
          ...((group?.members || []).map((member) => Number(member.hostId || 0))),
        ].filter((id) => id > 0);
      }
      const routeChangedAt = (tunnel?.topologyChangedAt as Date | null | undefined) ?? null;
      const routeOutdated = diagnosisRouteOutdated(
        { hostId: Number(t.hostId || 0), requestMessage: (t as { requestMessage?: string | null }).requestMessage ?? null, updatedAt: t.updatedAt },
        {
          tunnelId: Number(rule.tunnelId || 0) || null,
          hostId: Number(rule.hostId || 0) || null,
          targetIp: rule.targetIp ?? null,
          targetPort: Number(rule.targetPort || 0) || null,
          tunnelEntryHostId: Number(tunnel?.entryHostId || 0) || null,
          tunnelExitHostIds,
          topologyChangedAt: routeChangedAt,
        },
      );
      return { ...t, routeChangedAt, routeOutdated };
    })
});
