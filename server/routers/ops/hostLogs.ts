import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { isHostConsideredOnline } from "../../hostHeartbeatPolicy";
import { HOST_LOGS_MIN_AGENT_VERSION, hostLogSources, hostSupportsLogs, isValidHostLogSource, pollHostLogs } from "../../ops/hostLogsAgent";

/*
  trpc.ops.hostLogs.* —— 主机详情 › 实时日志。只给管理员。

  poll 既是「我在看」的心跳，也是取新行：浏览器开着窗口时每 2 秒调一次，带上已经拿到的最后一个序号。
*/
export const hostLogsRouter = router({
  status: adminProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const host = await db.getHostById(input.hostId);
      if (!host) throw new Error("主机不存在");
      return {
        supported: hostSupportsLogs(host as any),
        minAgentVersion: HOST_LOGS_MIN_AGENT_VERSION,
        online: isHostConsideredOnline(host),
        sources: hostLogSources(input.hostId),
      };
    }),

  poll: adminProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      source: z.string().max(140),
      afterSeq: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      if (!isValidHostLogSource(input.source)) throw new Error("不认识的日志来源");
      const host = await db.getHostById(input.hostId);
      if (!host) throw new Error("主机不存在");
      if (!hostSupportsLogs(host as any)) throw new Error(`需要把 Agent 升级到 ${HOST_LOGS_MIN_AGENT_VERSION}`);
      return pollHostLogs(input.hostId, input.source, input.afterSeq);
    }),
});
