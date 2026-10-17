import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { pushTunnelEndpointRefresh } from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";
import { createHopTestBatch, registerHopTest } from "../hopTestState";
import { linkProbeMethodForRule } from "@shared/latencyProbe";
import { ruleLatencySeriesQueryCache as selfTestQueryCache } from "../ruleLatencyQueryCache";
import * as hopRepo from "../repositories/tunnelRepository";
import { dbBool } from "../repositories/repositoryUtils";
import { isForwardXTunnel, tunnelFxpMemberHostIds, tunnelFxpRuntimeIssues, tunnelFxpRuntimeIssueSummary } from "../tunnelFxpRuntime";

/*
  走 NEX 隧道的规则：隧道上任何一台的 FXP 握不上当前协议，自检里的 tcping 照样会通（端口是
  Agent 在听），可真实流量全超时。先查成员主机报上来的 FXP 版本，有问题就直接给一条失败的
  自检结果，把哪台、什么版本、怎么修写清楚。
*/
async function forwardXTunnelFxpIssueMessage(tunnel: any) {
  if (!isForwardXTunnel(tunnel)) return "";
  const [hops, extraExits] = await Promise.all([
    hopRepo.getTunnelHops(Number(tunnel.id)),
    hopRepo.getTunnelExitNodes(Number(tunnel.id)),
  ]);
  const groupHostIds: number[] = [];
  for (const groupId of [Number(tunnel.entryGroupId || 0), Number(tunnel.exitGroupId || 0)]) {
    if (groupId <= 0) continue;
    const group = await db.getForwardGroupById(groupId) as any;
    for (const member of group?.members || []) {
      if (member?.memberType === "host" && dbBool(member.isEnabled, true)) groupHostIds.push(Number(member.hostId || 0));
    }
  }
  const memberHostIds = tunnelFxpMemberHostIds(tunnel, {
    hopHostIds: (hops as any[] || []).map((hop) => hop.hostId),
    extraExitHostIds: (extraExits as any[] || []).filter((node) => dbBool(node.isEnabled, true)).map((node) => node.hostId),
    groupHostIds,
  });
  const hosts = new Map(((await db.getHostsByIds(memberHostIds)) as any[]).map((host) => [Number(host.id), host]));
  return tunnelFxpRuntimeIssueSummary(tunnelFxpRuntimeIssues(tunnel, memberHostIds, hosts));
}

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

  startSelfTest: protectedProcedure
    .input(z.object({ ruleId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权操作此规则");
      }
      await requireRuleProtocolEnabled(rule);
      let hostId = rule.hostId;
      let message: string | null = null;
      if ((rule as any).isForwardGroupTemplate && (rule as any).forwardGroupId) {
        const group = await db.getForwardGroupById(Number((rule as any).forwardGroupId)) as any;
        if (String(group?.groupMode || "failover") === "chain") {
          await db.syncForwardGroupRules(Number(group.id));
          const probes = await db.getForwardGroupChainProbes(Number(group.id), { includeFinalTarget: true, templateRule: rule });
          const chainLatencyMode = probes.some((probe) => probe.method === "tcp")
            && ["iptables", "nftables"].includes(String(group.forwardType || "").trim().toLowerCase())
            ? Number(group.entryGroupId || 0) > 0
              ? "multi-source-remaining-path"
              : "remaining-path"
            : "sum";
          if (probes.length === 0) throw new Error("转发链没有可测试的有效链路");
          const batchId = createHopTestBatch("fgr", Number(group.id));
          const testHostIds = new Set<number>();
          let firstTestId = 0;
          let queued = 0;
          for (const probe of probes) {
            const probeMessage = JSON.stringify({
              kind: "forward-chain",
              groupId: group.id,
              ruleId: rule.id,
              entryIp: probe.targetIp,
              entrySourcePort: probe.targetPort,
              targetIp: probe.targetIp,
              targetPort: probe.targetPort,
              method: probe.method,
              hopLabel: probe.hopLabel,
              routeLabel: probe.routeLabel,
              batchId,
              latencyMode: chainLatencyMode,
              runtimeDependent: probe.runtimeDependent,
            });
            const testId = await db.createForwardTest({
              ruleId: rule.id,
              hostId: probe.fromHostId,
              userId: rule.userId,
              status: "pending",
              listenOk: false,
              targetReachable: false,
              forwardOk: false,
              message: probeMessage,
            });
            if (!firstTestId) firstTestId = Number(testId);
            registerHopTest(batchId, Number(testId));
            testHostIds.add(probe.fromHostId);
            queued += 1;
            appendPanelLog("info", `[SelfTest] rule=${rule.id} forward-chain=${group.id} queued hop=${probe.hopLabel} method=${probe.method} target=${probe.targetIp}:${probe.targetPort}`);
          }
          for (const hostId of testHostIds) {
            pushAgentRefresh(hostId, "forward-chain-rule-selftest", { urgent: true });
          }
          return { id: firstTestId, queued };
        }
      }
      if ((rule as any).tunnelId) {
        const tunnel = await db.getTunnelById((rule as any).tunnelId);
        if (!tunnel) throw new Error("隧道不存在");
        const fxpIssueMessage = await forwardXTunnelFxpIssueMessage(tunnel);
        if (fxpIssueMessage) {
          const id = await db.createForwardTest({
            ruleId: rule.id,
            hostId: Number(tunnel.entryHostId || rule.hostId),
            userId: rule.userId,
            status: "failed",
            listenOk: false,
            targetReachable: false,
            forwardOk: false,
            message: fxpIssueMessage,
          });
          appendPanelLog("warn", `[SelfTest] rule=${rule.id} tunnel=${tunnel.id} FXP runtime incompatible: ${fxpIssueMessage}`);
          return { id };
        }
        hostId = tunnel.exitHostId;
        const targetIp = rule.targetIp;
        if (!targetIp) throw new Error("目标地址不可用，请检查规则目标地址");
        const tunnelLatencyBaseline = await db.getLatestTunnelLatency(Number(tunnel.id));
        const pushed = await pushTunnelEndpointRefresh(tunnel, "forward-selftest-via-tunnel", {
          urgent: true,
          forceTcping: true,
        });
        message = JSON.stringify({
          kind: "forward-via-tunnel",
          tunnelId: tunnel.id,
          entryHostId: tunnel.entryHostId,
          exitHostId: tunnel.exitHostId,
          targetIp,
          targetPort: rule.targetPort,
          method: linkProbeMethodForRule(rule),
          tunnelLatencyBaselineId: Number((tunnelLatencyBaseline as any)?.id || 0),
          refreshPushed: pushed,
        });
        appendPanelLog("info", `[SelfTest] rule=${rule.id} tunnel=${tunnel.id} queued tunnel+target test from exitHost=${tunnel.exitHostId} to target=${targetIp}:${rule.targetPort}`);
      }
      const id = await db.createForwardTest({
        ruleId: rule.id,
        hostId,
        userId: rule.userId,
        status: "pending",
        listenOk: false,
        targetReachable: false,
        forwardOk: false,
        message,
      });
      pushAgentRefresh(hostId, "forward-selftest", { urgent: true });
      if (!(rule as any).tunnelId) {
        appendPanelLog("info", `[SelfTest] rule=${rule.id} queued direct test=${id} from host=${hostId} to target=${rule.targetIp}:${rule.targetPort}`);
      }
      return { id };
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
      return t || null;
    })
});
