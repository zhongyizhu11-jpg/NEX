import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure } from "../_core/trpc";
import { requireHostAccess } from "./helpers";
import { hostSupportsNodeCheck, listSpeedTestHistory, NodeCheckError, nodeCheckStatus, startNodeCheck } from "../ops/nodeCheck";
import { NODE_CHECK_MIN_AGENT_VERSION, NODE_CHECK_PANEL_FALLBACK_VERSION } from "@shared/nodeCheck";
import { isAgentVersionAtLeast } from "@shared/version";

/*
  trpc.hosts.speedTest* —— 主机详情里的「网速测试」（Agent 2.2.241 起）：这台机器对 Cloudflare 测速。

  speedTestStatus   在跑的那次（带曲线进度）+ 最近一次结果；能用这台主机的人都能看
  speedTestHistory  最近 10 次
  startSpeedTest    「开始测速」：能用这台主机的人都能点（测速要吃这台机器几百 MB 流量，所以不自动跑）
*/
const hostInput = z.object({ hostId: z.number().int().positive() });

async function accessibleHost(ctx: { user: { id: number; role: string } }, hostId: number) {
  try {
    return await requireHostAccess(ctx, hostId);
  } catch (error) {
    throw new TRPCError({ code: "NOT_FOUND", message: error instanceof Error ? error.message : "主机不存在" });
  }
}

export const hostSpeedTestProcedures = {
  speedTestStatus: protectedProcedure
    .input(hostInput)
    .query(async ({ input, ctx }) => {
      const host: any = await accessibleHost(ctx, input.hostId);
      const status = await nodeCheckStatus({ kind: "speed", hostId: input.hostId, nodeId: 0 });
      return {
        supported: hostSupportsNodeCheck(host),
        minAgentVersion: NODE_CHECK_MIN_AGENT_VERSION,
        // 连不上 Cloudflare 时改测到面板是 2.2.242 才有的：老的会直接报失败，界面要说清楚
        panelFallback: isAgentVersionAtLeast(String(host.agentVersion || "").replace(/^v/i, ""), NODE_CHECK_PANEL_FALLBACK_VERSION),
        online: !!host.isOnline,
        hostName: String(host.name || ""),
        countryCode: host.geoCountryCode ? String(host.geoCountryCode) : null,
        ...status,
      };
    }),

  speedTestHistory: protectedProcedure
    .input(hostInput)
    .query(async ({ input, ctx }) => {
      await accessibleHost(ctx, input.hostId);
      return listSpeedTestHistory({ hostId: input.hostId, nodeId: 0 });
    }),

  startSpeedTest: protectedProcedure
    .input(hostInput)
    .mutation(async ({ input, ctx }) => {
      const host: any = await accessibleHost(ctx, input.hostId);
      try {
        return startNodeCheck(host, { kind: "speed", requestedBy: Number(ctx.user.id) });
      } catch (error) {
        if (error instanceof NodeCheckError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
        throw error;
      }
    }),
};
